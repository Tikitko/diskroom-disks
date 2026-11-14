/**
 * @disk     dockyard
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    One warehouse, everyone shoving crates onto their own dock. Crates only push, never pull, so get behind one first, and a crate wedged in a corner is lost for good. A crate on a dock takes a moment to load, long enough for a rival to shove it off.
 * @tags     game, party, realtime, puzzle, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/dockyard.png
 */
// dockyard.js — a warehouse of crates where everyone pushes and nobody pulls,
// and the room's order is the referee.
//
// Every copy holds the whole warehouse — every wall, every crate and how far
// along its loading is, every worker and where they are walking — and changes
// it only on what comes back round the room, so every copy applies the same
// hands in the same order and holds the same warehouse. Nobody sends where they
// are, which crate they moved or what they shipped: a hand is the way a player
// wants to walk, and everything else is the same arithmetic on the same whole
// numbers on every machine. A page with a console open can walk its own worker
// however it likes, one cell at a time at that worker's own pace.
//
// While a player is alone in the warehouse, a bot plays with them. It is part
// of the warehouse like any player, and its moves are a function of the
// warehouse alone, so it plays the same on every copy and says nothing over
// the wire. When a second player arrives, practice runs on for three seconds
// under a note that says so, and the bot leaves before the round is laid out:
// it never takes part in one.
//
// Your own worker does not wait for the trip: it is drawn from the agreed
// warehouse played forward by the trip, with your hand already in it, and so
// is a crate it is pushing.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole cells and whole steps only, and use nothing but
// `+ - *`, comparisons, `Math.floor`, `Math.min`, `Math.max`, `Math.abs` and
// `Math.imul`, which the language fixes to the last bit. Anything rounder
// appears only in the drawing, which is nobody's business but the screen's.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the warehouse a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own worker a trip ahead, with your hand in it

const GW = 16, GH = 12, NC = GW * GH;   // the warehouse, in cells, its rim a wall
const MOVE = 4;                // steps a worker takes to walk one cell
const PUSH = 5;                // and to walk one pushing a crate in front of it
const MOVE_FAST = 3;           // the same for whoever trails the leader far enough
const PUSH_FAST = 4;
const BEHIND = 3;              // points behind the leader at which a worker is quicker
const DAZE = 10;               // steps a shoved worker stands dazed
const GUARD = 24;              // steps a shoved worker cannot be shoved again
const LOAD = 60;               // steps a crate stands on a dock before it ships
const LOAD_LEAD = 80;          // on the dock of whoever leads alone
const LOAD_TRAIL = 44;         // on the dock of whoever trails far enough
const STUCK = 50;              // steps a crate nobody can push stands before it sinks
const SPAWN_EVERY = 40;        // steps between new crates, while there are too few
const SPAWN_RUSH = 24;         // and in the rush
const GOLD_ODDS = 0.15;        // how often a new crate is gold
const GOLD = 3;                // what a gold crate is worth; a plain one is worth 1
const CRATES_MAX = 12;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;
const SCORE_MAX = 99999;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 6 * HZ;
const RUSH_AT = 25 * HZ;       // steps left in a round when every crate ships for double

// A direction: none, up, right, down, left.
const DIRS = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];

const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const at = (x, y) => y * GW + x;
const inside = (x, y) => x > 0 && y > 0 && x < GW - 1 && y < GH - 1;

// The docks, one a seat, in the order seats are handed out: two players stand
// on opposite sides, and every dock has its twin turned half round the middle.
// A dock is two by two against the rim, never in a corner of it, so a crate
// pushed along the wall slides onto it.
const DOCKS = [
  [1, 5], [13, 5], [3, 1], [11, 9], [11, 1], [3, 9], [7, 1], [7, 9],
].map(([x, y]) => [at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)]);
const SLOT_OF = new Array(NC).fill(-1);
DOCKS.forEach((cells, s) => cells.forEach((c) => { SLOT_OF[c] = s; }));
// Where a seat's worker starts: the cell of its dock nearest the middle.
const START = DOCKS.map((cells) => {
  let best = cells[0], low = Infinity;
  for (const c of cells) {
    const x = c % GW, y = (c - x) / GW;
    const v = Math.abs(2 * x - (GW - 1)) + Math.abs(2 * y - (GH - 1));
    if (v < low) { low = v; best = c; }
  }
  return best;
});

// The warehouse. Plain data only: it is fingerprinted and handed over as JSON,
// and the copy a newcomer reads back must print exactly like the one it came
// from, so every crate and every player is made by one function with its
// fields in one order.
//   m:  each cell: 1 a wall, 0 floor
//   k:  the crates; ki: the id the next one gets; sp: steps until the next
//   res: the last round's [id, won, rounds won, points, shipped] rows; win: its winner
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, m: [], k: [], ki: 1, sp: SPAWN_EVERY, p: {}, res: null, win: -1 };
  lay(w);
  return w;
}

// A new floor: the rim, and a few pillars of one or two cells, each with its
// twin turned half round the middle so no dock is better placed than its own.
// Pillars stand well apart from each other and from the docks, so the only
// corners a crate can be wedged in are the rim's own and those it is pushed
// into against other crates.
function lay(w) {
  const m = new Array(NC).fill(0);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (!inside(x, y)) m[at(x, y)] = 1;
  const placed = [];
  const nearDock = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = x + dx, b = y + dy;
      if (a >= 0 && b >= 0 && a < GW && b < GH && SLOT_OF[at(a, b)] >= 0) return true;
    }
    return false;
  };
  const clear = (cells) => cells.every(([x, y]) => x >= 4 && x <= GW - 5 && y >= 3 && y <= GH - 4 && !nearDock(x, y) &&
    placed.every(([a, b]) => Math.max(Math.abs(a - x), Math.abs(b - y)) >= 3));
  const pairs = 2 + Math.floor(draw01(w) * 2);
  for (let tries = 0, made = 0; tries < 60 && made < pairs; tries++) {
    const x = 4 + Math.floor(draw01(w) * (GW - 8)), y = 3 + Math.floor(draw01(w) * (GH - 6));
    const long = draw01(w) < 0.6, across = draw01(w) < 0.5;
    const one = [[x, y]];
    if (long) one.push(across ? [x + 1, y] : [x, y + 1]);
    const two = one.map(([a, b]) => [GW - 1 - a, GH - 1 - b]);
    if (!clear(one)) continue;
    placed.push(...one);
    if (!clear(two)) { placed.length -= one.length; continue; }
    placed.push(...two);
    made += 1;
  }
  for (const [x, y] of placed) m[at(x, y)] = 1;
  w.m = m;
  w.k = [];
  w.sp = Math.floor(SPAWN_EVERY / 2);
}

const FIELDS = ['c', 's', 'x', 'y', 'fx', 'fy', 'mc', 'mt', 'fc', 'wd', 'q', 'dz', 'gd', 'sc', 'sh', 'wn', 'bw', 'hs', 'hc'];
//   c: colour; s: seat, which is also the dock; x, y: the cell it stands in;
//   fx, fy: the cell it is walking from, mc of mt steps still to go; fc: the
//   way it faces; wd: the way its hand wants to walk; q: one step asked for by
//   a tap, taken even if the key is up by then; dz: steps of daze left; gd:
//   steps nobody may shove it; sc: points this round; sh: crates shipped this
//   round; wn: rounds won; bw: the bot's pause; hs, hc: hands this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const CRATE = ['i', 'x', 'y', 'fx', 'fy', 'mc', 'mt', 'v', 'ld', 'by', 'jm', 'bl'];
//   i: its id; x, y, fx, fy, mc, mt: as a worker's; v: what it is worth; ld:
//   steps it has stood loading on a dock; by: who pushed it last, 0 nobody; jm:
//   steps it has stood where nobody can push it; bl: 1 when its last push is
//   what wedged it, which costs that pusher a point when it sinks.
function crate(v) {
  const k = {};
  for (const f of CRATE) k[f] = v[f];
  return k;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

function newPlayer(w, wd) {
  const s = freeOf(w, 's');
  const c = START[s], x = c % GW, y = (c - x) / GW;
  return player({
    c: freeOf(w, 'c'), s, x, y, fx: x, fy: y, mc: 0, mt: MOVE, fc: 3, wd, q: 0, dz: 0, gd: 0, sc: 0, sh: 0, wn: 0, bw: 0,
    hs: w.n, hc: 0,
  });
}

const wallAt = (w, x, y) => x < 0 || y < 0 || x >= GW || y >= GH || w.m[at(x, y)] === 1;
const crateAt = (w, x, y) => w.k.find((k) => k.x === x && k.y === y) || null;
function workerAt(w, x, y) {
  for (const id of playersIn(w)) if (w.p[id].x === x && w.p[id].y === y) return id;
  return null;
}
const freeAt = (w, x, y) => !wallAt(w, x, y) && !crateAt(w, x, y) && workerAt(w, x, y) === null;

// The player whose dock a cell is part of, or null: a dock belongs to the seat
// of the same number, and a seat nobody holds has no dock.
function ownerAt(w, c) {
  const s = SLOT_OF[c];
  if (s < 0) return null;
  for (const id of playersIn(w)) if (w.p[id].s === s) return id;
  return null;
}

// Whether anybody could ever push this crate from where it stands, reckoning
// with walls and crates but not with workers, who walk away: a push wants the
// cell behind the crate to stand in and the cell ahead to slide into.
function pushable(w, k) {
  for (let d = 1; d <= 4; d++) {
    const [dx, dy] = DIRS[d];
    const ax = k.x + dx, ay = k.y + dy, bx = k.x - dx, by = k.y - dy;
    if (wallAt(w, ax, ay) || wallAt(w, bx, by)) continue;
    if (w.k.some((o) => o !== k && ((o.x === ax && o.y === ay) || (o.x === bx && o.y === by)))) continue;
    return true;
  }
  return false;
}

// Somebody is placed on their own start, or the nearest free cell to it.
function placeAt(w, id) {
  const d = w.p[id];
  const c = START[d.s];
  let sx = c % GW, sy = (c - sx) / GW;
  const taken = (x, y) => wallAt(w, x, y) || crateAt(w, x, y) || playersIn(w).some((o) => o !== id && w.p[o].x === x && w.p[o].y === y);
  if (taken(sx, sy)) {
    let best = null, low = Infinity;
    for (let y = 1; y < GH - 1; y++) for (let x = 1; x < GW - 1; x++) {
      if (taken(x, y)) continue;
      const v = Math.abs(x - sx) + Math.abs(y - sy);
      if (v < low) { low = v; best = [x, y]; }
    }
    if (best) [sx, sy] = best;
  }
  d.x = d.fx = sx;
  d.y = d.fy = sy;
  d.mc = 0;
  d.mt = MOVE;
  d.fc = 3;
  d.dz = d.gd = 0;
}

// A hand, at its place in the room's order: the way the player wants to walk,
// held until it changes. A new way asked for is also kept as one step, so a
// tap shorter than a step still moves a cell. Being heard is how a player
// arrives: on their own dock, or the nearest free cell to it.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input);
    placeAt(w, id);
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  if (input && input !== d.wd) d.q = input;
  d.wd = input;
}

// A hand off the wire, made safe: a direction, or nothing.
function inputOf(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw <= 4 ? raw : null;
}

function leave(w, id) {
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 2;           // steps between the bot's decisions
const BOT_IDLE = 0.05;         // how often it lets a decision go by and dawdles
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the warehouse waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    placeAt(w, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Steps of floor between `from` and every other cell, walking round walls and
// crates; -1 where no way leads.
function walksFrom(w, from) {
  const dist = new Array(NC).fill(-1);
  const busy = new Array(NC).fill(0);
  for (const k of w.k) busy[at(k.x, k.y)] = 1;
  dist[from] = 0;
  let edge = [from];
  while (edge.length) {
    const next = [];
    for (const c of edge) {
      const x = c % GW, y = (c - x) / GW;
      for (let d = 1; d <= 4; d++) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        const n = at(nx, ny);
        if (wallAt(w, nx, ny) || busy[n] || dist[n] >= 0) continue;
        dist[n] = dist[c] + 1;
        next.push(n);
      }
    }
    edge = next;
  }
  return dist;
}

// The bot picks the crate it can get behind soonest and nearest its own dock,
// and pushes it along whichever way brings it closer, never into a wedge. It
// leaves its own loading crates alone and is happy to take the player's.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.bw > 0) { d.bw -= 1; d.wd = 0; return; }
  if (w.n % BOT_EVERY !== 0 || d.mc > 1 || d.dz > 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 6 + Math.floor(draw01(w) * 14); d.wd = 0; return; }
  const mine = walksFrom(w, at(d.x, d.y));
  const dock = DOCKS[d.s];
  let best = null, low = Infinity;
  for (const k of w.k) {
    const c = at(k.x, k.y);
    if (SLOT_OF[c] === d.s) continue;
    let tx = 0, ty = 0, near = Infinity;
    for (const t of dock) {
      const x = t % GW, y = (t - x) / GW, v = Math.abs(x - k.x) + Math.abs(y - k.y);
      if (v < near) { near = v; tx = x; ty = y; }
    }
    const ways = [];
    if (tx !== k.x) ways.push(tx > k.x ? 2 : 4);
    if (ty !== k.y) ways.push(ty > k.y ? 3 : 1);
    if (Math.abs(ty - k.y) > Math.abs(tx - k.x)) ways.reverse();
    for (const dir of ways) {
      const [dx, dy] = DIRS[dir];
      const sx = k.x - dx, sy = k.y - dy;
      if (wallAt(w, k.x + dx, k.y + dy) || crateAt(w, k.x + dx, k.y + dy) || wallAt(w, sx, sy)) continue;
      const reach = mine[at(sx, sy)];
      if (reach < 0) continue;
      // Never a push that leaves the crate wedged off a dock.
      const ox = k.x, oy = k.y;
      k.x += dx; k.y += dy;
      const ok = pushable(w, k) || SLOT_OF[at(k.x, k.y)] === d.s;
      k.x = ox; k.y = oy;
      if (!ok) continue;
      const v = reach + 2 * near + (ownerAt(w, c) !== null ? -4 : 0) + (k.v > 1 ? -3 : 0);
      if (v < low) { low = v; best = { sx, sy, dir }; }
      break;
    }
  }
  if (!best) { d.wd = 0; return; }
  if (d.x === best.sx && d.y === best.sy) { d.wd = best.dir; return; }
  const there = walksFrom(w, at(best.sx, best.sy));
  let way = 0, near = Infinity;
  for (let dir = 1; dir <= 4; dir++) {
    const nx = d.x + DIRS[dir][0], ny = d.y + DIRS[dir][1];
    if (wallAt(w, nx, ny)) continue;
    const v = there[at(nx, ny)];
    if (v >= 0 && v < near) { near = v; way = dir; }
  }
  d.wd = way;
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  lay(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    placeAt(w, id);
    d.sc = d.sh = 0;
  }
}

// A round: a new floor, the seats closed up in order so the docks in use are
// the first ones, everybody on their own dock with nothing shipped.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  lay(w);
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; w.p[id].x = w.p[id].y = 0; });
  ids.forEach((id) => {
    const d = w.p[id];
    placeAt(w, id);
    d.sc = d.sh = d.bw = d.q = 0;
  });
  fx(w, 'round');
}

function finish(w) {
  const ids = bySeat(w);
  let top = -1, win = -1;
  for (const id of ids) {
    const sc = w.p[id].sc;
    if (sc > top) { top = sc; win = id; } else if (sc === top) win = -1;
  }
  w.win = top > 0 ? win : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, id === w.win ? 1 : 0, w.p[id].wn, w.p[id].sc, w.p[id].sh]);
  res.sort((a, b) => b[3] - a[3] || b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, w.win);
}

function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting warehouse otherwise leaves at zero. The bot goes first,
    // so the round's seats close up without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === RUSH_AT) fx(w, 'rush');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) return;
  yard(w);
}

const rushOn = (w) => w.ph === PLAY && w.pt <= RUSH_AT;

// Whoever has the most points, alone, and any at all: the one with the crown.
function leaderOf(w) {
  let top = 0, who = -1;
  for (const id of bySeat(w)) {
    const sc = w.p[id].sc;
    if (sc > top) { top = sc; who = id; } else if (sc === top) who = -1;
  }
  return who;
}
function topOf(w) {
  let top = 0;
  for (const id of playersIn(w)) top = Math.max(top, w.p[id].sc);
  return top;
}
const trails = (w, d, top) => top - d.sc >= BEHIND;

// Steps a crate stands on this player's dock before it ships.
function loadOf(w, id, top, lead) {
  if (id === lead) return LOAD_LEAD;
  return trails(w, w.p[id], top) ? LOAD_TRAIL : LOAD;
}

function yard(w) {
  botThink(w);
  const ids = bySeat(w);
  const top = topOf(w), lead = leaderOf(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.dz > 0) d.dz -= 1;
    if (d.gd > 0) d.gd -= 1;
    if (d.mc > 0) d.mc -= 1;
    if (d.mc > 0 || d.dz > 0) continue;
    const dir = d.wd || d.q;
    d.q = 0;
    if (dir) walk(w, id, d, dir, trails(w, d, top));
  }
  for (const k of w.k) if (k.mc > 0) k.mc -= 1;
  // Loading, shipping, and crates that nobody can push any more.
  const gone = [];
  for (const k of w.k) {
    const c = at(k.x, k.y);
    const owner = ownerAt(w, c);
    if (owner !== null) {
      if (k.mc === 0) {
        k.ld += 1;
        if (k.ld === 1) fx(w, 'load', k.x, k.y, owner);
        if (k.ld >= loadOf(w, owner, top, lead)) { gone.push(k); ship(w, k, owner); }
      }
      k.jm = 0;
      continue;
    }
    if (pushable(w, k)) { k.jm = 0; k.bl = 0; continue; }
    k.jm += 1;
    if (k.jm === 1) fx(w, 'stuck', k.x, k.y, k.by);
    if (k.jm >= STUCK) { gone.push(k); sink(w, k); }
  }
  if (gone.length) w.k = w.k.filter((k) => !gone.includes(k));
  if (w.sp > 0) w.sp -= 1;
  const want = Math.min(CRATES_MAX, 3 + ids.length);
  if (w.sp <= 0 && w.k.length < want) {
    spawn(w);
    w.sp = rushOn(w) ? SPAWN_RUSH : SPAWN_EVERY;
  }
}

// One step of a worker's walk: into an empty cell, or into a crate, which
// slides one cell ahead if that cell is empty, or into another worker, who is
// shoved a cell back and stands dazed a moment if the cell behind them is
// empty. A wall, or anything that cannot give way, stops the walk where it is.
function walk(w, id, d, dir, quick) {
  d.fc = dir;
  const [dx, dy] = DIRS[dir];
  const nx = d.x + dx, ny = d.y + dy;
  if (wallAt(w, nx, ny)) return;
  const o = workerAt(w, nx, ny);
  if (o !== null) {
    const e = w.p[o];
    if (e.gd > 0 || !freeAt(w, nx + dx, ny + dy)) return;
    e.fx = e.x; e.fy = e.y;
    e.x += dx; e.y += dy;
    e.mc = e.mt = PUSH;
    e.dz = DAZE;
    e.gd = GUARD;
    e.q = 0;
    d.fx = d.x; d.fy = d.y;
    d.mc = d.mt = quick ? PUSH_FAST : PUSH;
    fx(w, 'shove', nx, ny, id, o);
    return;
  }
  const k = crateAt(w, nx, ny);
  if (k) {
    if (!freeAt(w, nx + dx, ny + dy)) return;
    const pace = quick ? PUSH_FAST : PUSH;
    const was = ownerAt(w, at(k.x, k.y));
    if (was !== null && k.ld >= 10 && was !== id) fx(w, 'stolen', k.x, k.y, id, was);
    k.fx = k.x; k.fy = k.y;
    k.x += dx; k.y += dy;
    k.mc = k.mt = pace;
    k.ld = 0;
    k.jm = 0;
    k.by = id;
    k.bl = !pushable(w, k) && ownerAt(w, at(k.x, k.y)) === null ? 1 : 0;
    d.fx = d.x; d.fy = d.y;
    d.x = nx; d.y = ny;
    d.mc = d.mt = pace;
    fx(w, 'push', k.x, k.y, id, k.i);
    return;
  }
  d.fx = d.x; d.fy = d.y;
  d.x = nx; d.y = ny;
  d.mc = d.mt = quick ? MOVE_FAST : MOVE;
}

function ship(w, k, owner) {
  const d = w.p[owner];
  const v = k.v * (rushOn(w) ? 2 : 1);
  d.sc = Math.min(SCORE_MAX, d.sc + v);
  d.sh = Math.min(SCORE_MAX, d.sh + 1);
  fx(w, 'ship', k.x, k.y, owner, v);
}

// A crate that has stood wedged long enough sinks through the floor, and a
// point goes with it from whoever wedged it, if it was their push that did.
function sink(w, k) {
  const d = k.bl && k.by ? w.p[k.by] : null;
  if (d) d.sc = Math.max(0, d.sc - 1);
  fx(w, 'sink', k.x, k.y, d ? k.by : 0, k.v);
}

// A new crate on an empty cell in the middle of the floor, clear of every wall
// so it can be pushed any way, of every dock and of every worker.
function spawn(w) {
  const open = [];
  for (let y = 3; y <= GH - 4; y++) {
    for (let x = 3; x <= GW - 4; x++) {
      if (!freeAt(w, x, y) || SLOT_OF[at(x, y)] >= 0) continue;
      let ok = true;
      for (let d = 1; d <= 4 && ok; d++) {
        const ax = x + DIRS[d][0], ay = y + DIRS[d][1];
        if (wallAt(w, ax, ay) || crateAt(w, ax, ay) || workerAt(w, ax, ay) !== null) ok = false;
      }
      if (ok) open.push([x, y]);
    }
  }
  if (!open.length) return;
  const [x, y] = open[Math.floor(draw01(w) * open.length)];
  const v = draw01(w) < GOLD_ODDS ? GOLD : 1;
  w.k.push(crate({ i: w.ki, x, y, fx: x, fy: y, mc: 0, mt: 1, v, ld: 0, by: 0, jm: 0, bl: 0 }));
  w.ki = w.ki >= BIG - 1 ? 1 : w.ki + 1;
  fx(w, 'spawn', x, y, v);
}

// A warehouse handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!Array.isArray(raw.m) || raw.m.length !== NC) return null;
  for (let c = 0; c < NC; c++) {
    const x = c % GW, y = (c - x) / GW;
    if (inside(x, y) ? !(raw.m[c] === 0 || (raw.m[c] === 1 && SLOT_OF[c] < 0)) : raw.m[c] !== 1) return null;
  }
  if (!int(raw.ki, 1, BIG) || !int(raw.sp, 0, SPAWN_EVERY)) return null;
  if (!Array.isArray(raw.k) || raw.k.length > CRATES_MAX) return null;
  const k = [], ks = new Set(), cells = new Set();
  const cell = (x, y) => int(x, 1, GW - 2) && int(y, 1, GH - 2) && raw.m[at(x, y)] === 0;
  const near = (a, b, x, y) => Math.abs(a - x) + Math.abs(b - y) <= 1;
  for (const e of raw.k) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    if (!int(e.i, 1, BIG) || ks.has(e.i) || !cell(e.x, e.y) || cells.has(at(e.x, e.y))) return null;
    if (!cell(e.fx, e.fy) || !near(e.fx, e.fy, e.x, e.y) || !int(e.mt, 1, PUSH) || !int(e.mc, 0, e.mt)) return null;
    if (!(e.v === 1 || e.v === GOLD) || !int(e.ld, 0, LOAD_LEAD) || !int(e.jm, 0, STUCK) || !int(e.bl, 0, 1)) return null;
    if (!int(e.by, -BIG, BIG)) return null;
    ks.add(e.i);
    cells.add(at(e.x, e.y));
    k.push(crate(e));
  }
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!cell(d.x, d.y) || cells.has(at(d.x, d.y)) || !cell(d.fx, d.fy) || !near(d.fx, d.fy, d.x, d.y)) return null;
    if (!int(d.mt, 1, PUSH) || !int(d.mc, 0, d.mt) || !int(d.fc, 1, 4) || !int(d.wd, 0, 4) || !int(d.q, 0, 4)) return null;
    if (!int(d.dz, 0, DAZE) || !int(d.gd, 0, GUARD) || !int(d.sc, 0, SCORE_MAX) || !int(d.sh, 0, SCORE_MAX)) return null;
    if (!int(d.wn, 0, 99999) || !int(d.bw, 0, 99) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    cells.add(at(d.x, d.y));
    p[id] = player(d);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 5 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, m: raw.m.slice(), k, ki: raw.ki, sp: raw.sp, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed warehouse steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a harbour warehouse at night. A slate-blue concrete floor under
// the lamps, steel-grey pillars, a rim striped in hazard yellow, warm wooden
// crates and gold ones, and a bright colour for each player that is their
// worker's, their dock's and their chip's.
const INK = {
  page: '#121c27', glow: '#1f3142', floor: '#22384a', floorB: '#1e3344', seam: '#2b4558',
  rim: '#33475a', rimTop: '#4a6276', hazard: '#f2c14e', hazardDark: '#1a2430',
  pillar: '#566b7d', pillarTop: '#7890a4', pillarSide: '#3a4b5b',
  wood: '#c98a4b', woodDark: '#8a5a2b', woodHi: '#e9b47a', gold: '#ffcf4a', goldHi: '#fff0a8', goldDark: '#b8860b',
  text: '#ffffff', muted: '#c3d2df', dim: '#7f95a8', danger: '#ff5a5a', warn: '#ffb03b',
  panel: 'rgba(12,20,30,0.93)',
};
const SEAT = ['#ff6b6b', '#4dc3ff', '#ffd23f', '#7be35a', '#c58bff', '#ff9a3c', '#2de0c0', '#ff7ac8'];
const FONT = "700 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.page};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #3e566b;' +
  `background:#1c2c3b;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
// The bottom row of the floor holds docks, so a narrow frame keeps NOTE_ROOM
// free under it for the practice note and, in a round, for your own dock.
const NOTE_ROOM = 60;
const SIDE = 160;              // the least a column beside the floor needs for the scoreboard
let VW = 640, VH = 400, cs = 24, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1;
let wide = false, colW = 0, fieldTop = 0, fieldBot = 0;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
  fit();
}

// The whole floor is always on screen, as large as the frame lets it be. A
// frame wider than the floor puts the status, the scoreboard, your dock and
// the line of controls in the columns either side of it, so the floor takes
// the whole height. A narrower one stacks them in strips above and below it.
// Whichever of the two draws the floor bigger is the one used.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  const tall = Math.min((VW - 12) / GW, ah / GH), side = Math.min((VH - 12) / GH, (VW - 2 * SIDE) / GW);
  wide = side > tall;
  cs = Math.max(4, wide ? side : tall);
  ox = (VW - cs * GW) / 2;
  oy = wide ? (VH - cs * GH) / 2 : TOP + (ah - cs * GH) / 2;
  colW = wide ? ox : 0;
  fieldTop = oy;
  fieldBot = oy + cs * GH;
}
layout();
window.addEventListener('resize', layout);

// Screen pixels of a point on the floor, in cells, from its top left corner.
const PX = (u) => ox + u * cs + shakeX;
const PY = (v) => oy + v * cs + shakeY;
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

// Words broken into lines no wider than `most`, at the dots between phrases
// first and at spaces only when a phrase alone is too long.
function wrap(s, px, most) {
  ctx.font = font(px);
  const out = [];
  let line = '';
  const put = (piece, sep) => {
    const next = line ? line + sep + piece : piece;
    if (!line || ctx.measureText(next).width <= most) { line = next; return; }
    out.push(line);
    line = piece;
  };
  for (const phrase of s.split(' · ')) {
    if (ctx.measureText(phrase).width <= most) { put(phrase, ' · '); continue; }
    phrase.split(' ').forEach((word, i) => put(word, i ? ' ' : ' · '));
  }
  if (line) out.push(line);
  return out;
}

function nickOf(id) {
  if (id === BOT_ID) return 'bot';
  if (room.me && id === room.me.id) return room.me.nick;
  const p = room.players.find((x) => x.id === id);
  const nick = p ? String(p.nick) : 'p' + id;
  return nick.length > 12 ? nick.slice(0, 11) + '…' : nick;
}

function text(s, x, y, px, colour, align, base) {
  ctx.font = font(px);
  ctx.fillStyle = colour;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = base || 'alphabetic';
  ctx.fillText(s, x, y);
}
function fitText(s, x, y, px, colour, most, align) {
  ctx.font = font(px);
  const wd = ctx.measureText(s).width;
  text(s, x, y, wd > most ? Math.max(7, (px * most) / wd) : px, colour, align);
}
function roundRect(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function disc(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function darker(hex, k) {
  const c = rgb(hex).map((v) => Math.round(v * (1 - k)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function lighter(hex, k) {
  const c = rgb(hex).map((v) => Math.round(v + (255 - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function alpha(hex, a) {
  const c = rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

// Easing per frame, scaled to the frame's length so a fast screen and a slow
// one settle at the same pace.
let frameDt = 1 / 60, lastFrame = 0;
const per60 = (k) => 1 - Math.pow(1 - k, frameDt * 60);
const ease = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
const smooth = (k) => k * k * (3 - 2 * k);
const lerp = (a, b, k) => a + (b - a) * k;

// ── sound ──────────────────────────────────────────────────────────────────
// Made in the page from a few oscillators and a little noise. It starts on the
// first key or touch, because a browser keeps a page silent until then.
let actx = null, muted = false, noise = null;
const lastSound = new Map();
function wake() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { actx = null; }
  }
  if (actx && actx.state === 'suspended') actx.resume();
}
function ready(kind, gap) {
  if (!actx || muted || actx.state !== 'running') return false;
  const now = performance.now();
  if (now - (lastSound.get(kind) || -1e9) < (gap || 40)) return false;
  lastSound.set(kind, now);
  return true;
}
function tone(freq, dur, type, vol, slide, delay) {
  const t = actx.currentTime + (delay || 0);
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}
function puff(dur, vol, freq, delay, q) {
  if (!noise) {
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.6), actx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = actx.currentTime + (delay || 0);
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  src.buffer = noise;
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q || 1.2;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(actx.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}
const sound = {
  // Wood dragged over concrete: a short scrape, a little lower for gold.
  push(gold) { if (ready('push', 90)) { puff(0.13, 0.07, gold ? 520 : 380, 0, 2.5); tone(gold ? 150 : 110, 0.08, 'triangle', 0.05, 0.8); } },
  shove(mine) {
    if (!ready('shove', 90)) return;
    puff(0.1, 0.12, 260, 0, 1);
    tone(mine ? 220 : 160, 0.14, 'square', 0.05, 0.5);
  },
  dazed() { if (ready('dazed', 300)) [1200, 1500, 1200].forEach((f, i) => tone(f, 0.07, 'sine', 0.05, 0, i * 0.07)); },
  load(mine) { if (ready('load', 120)) tone(mine ? 660 : 440, 0.09, 'sine', mine ? 0.07 : 0.035, 1.2); },
  ship(mine, v) {
    if (!ready('ship', 80)) return;
    if (mine) {
      [523, 659, 784].concat(v > 2 ? [1047, 1319] : []).forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.06));
      puff(0.25, 0.04, 2200, 0.05, 0.8);
    } else tone(392, 0.15, 'triangle', 0.04, 1.3);
  },
  stolen() { if (ready('stolen', 250)) [660, 520, 392].forEach((f, i) => tone(f, 0.12, 'square', 0.045, 0, i * 0.08)); },
  steal() { if (ready('steal', 250)) [392, 523, 659].forEach((f, i) => tone(f, 0.08, 'square', 0.04, 0, i * 0.05)); },
  stuck() { if (ready('stuck', 300)) { tone(140, 0.25, 'sawtooth', 0.035, 0.7); puff(0.2, 0.04, 300, 0, 4); } },
  sink(mine) { if (ready('sink', 200)) { tone(mine ? 200 : 160, 0.5, 'triangle', mine ? 0.09 : 0.05, 0.3); puff(0.3, 0.06, 180, 0, 1); } },
  spawn() { if (ready('spawn', 200)) { puff(0.08, 0.05, 700, 0, 1.5); tone(300, 0.08, 'sine', 0.04, 1.6); } },
  rush() { if (ready('rush', 600)) [784, 988, 784, 988, 1175].forEach((f, i) => tone(f, 0.14, 'square', 0.04, 1, i * 0.12)); },
  beep(hi) { if (ready('beep', 200)) tone(hi ? 880 : 620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(700, 0.12, 'sine', 0.12, 2.0); tone(1400, 0.25, 'sine', 0.08, 1.0, 0.12); } },
  end(won) {
    if (!ready('end', 500)) return;
    if (won) [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.2, 'triangle', 0.09, 0, i * 0.08));
    else [392, 330, 262].forEach((f, i) => tone(f, 0.25, 'triangle', 0.08, 0, i * 0.12));
  },
};
function setMuted(m) {
  muted = m;
  muteBtn.textContent = muted ? '×' : '♪';
  muteBtn.style.opacity = muted ? '0.6' : '1';
}
muteBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
muteBtn.addEventListener('click', (e) => { e.stopPropagation(); wake(); setMuted(!muted); });

// ── bits: particles, pops, rings, shake ────────────────────────────────────
// Stepped on a clock of their own at a fixed rate, never once per frame, so a
// fast screen and a slow one see the same sparks. Positions are in cells.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, kind }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
const lifts = [];     // { x, y, v, colour, life, max }: a crate hoisted off a dock
const sinks = [];     // { x, y, v, life, max }: a crate going down through the floor
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, kind) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 18 + Math.random() * 22, size, colour, kind: kind || 0 });
  }
  if (bits.length > 600) bits.splice(0, bits.length - 600);
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 55, px: px || 15 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.9; b.vy *= 0.9;
      if (b.kind === 1) b.vy += 0.06;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    for (let i = lifts.length - 1; i >= 0; i--) if (++lifts[i].life >= lifts[i].max) lifts.splice(i, 1);
    for (let i = sinks.length - 1; i >= 0; i--) if (++sinks[i].life >= sinks[i].max) sinks.splice(i, 1);
    for (const l of looks.values()) { l.squash *= 0.86; l.daze *= 0.97; }
    shake *= 0.85;
    if (shake < 0.2) shake = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();      // id -> { squash, daze, seen }
let drawFailed = false;
let floorArt = null;          // the floor, the rim and the pillars, drawn once a floor and size
let floorKey = '';

function colourOf(t, id) {
  const d = t.p[id];
  return d ? SEAT[d.c] : '#dddddd';
}
function lookOf(id) {
  let l = looks.get(id);
  if (!l) { l = { squash: 0, daze: 0, seen: 0 }; looks.set(id, l); }
  l.seen = performance.now();
  return l;
}

// Where a worker or a crate stands in one table, in cells, part way along the
// cell it is walking.
function posIn(e) {
  const k = e.mt > 0 ? 1 - e.mc / e.mt : 1;
  const s = smooth(Math.max(0, Math.min(1, k)));
  return [lerp(e.fx, e.x, s), lerp(e.fy, e.y, s)];
}
// And as drawn between two tables, never slid across a jump: a new round, a
// return to the dock.
function posBetween(a, z, k) {
  const q = posIn(z);
  if (!a) return q;
  const p = posIn(a);
  if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > 1.5) return q;
  return [lerp(p[0], q[0], k), lerp(p[1], q[1], k)];
}

function play(e, t) {
  const me = myId();
  const x = e.x + 0.5, y = e.y + 0.5;
  if (e.kind === 'push') {
    const k = t.k.find((c) => c.i === e.b);
    if (e.a === me) sound.push(k && k.v > 1);
    lookOf(e.a).squash = 1;
    spray(x, y, 4, '#a8b9c8', 2.2, 0.05, 0);
  } else if (e.kind === 'shove') {
    const c = colourOf(t, e.a);
    ring(x, y, c, 0.9);
    spray(x, y, 10, '#ffffff', 4, 0.06);
    pop(x, y, 'shove!', e.b === me ? INK.danger : c, e.a === me || e.b === me ? 17 : 13);
    lookOf(e.a).squash = 1;
    lookOf(e.b).daze = 1;
    if (e.b === me) { shake = Math.max(shake, 9); sound.dazed(); }
    sound.shove(e.a === me);
  } else if (e.kind === 'load') {
    ring(x, y, colourOf(t, e.a), 0.8);
    sound.load(e.a === me);
  } else if (e.kind === 'stolen') {
    const c = colourOf(t, e.a);
    pop(x, y, e.b === me ? 'stolen!' : 'snatched!', e.b === me ? INK.danger : c, e.a === me || e.b === me ? 17 : 13);
    if (e.b === me) sound.stolen(); else if (e.a === me) sound.steal();
  } else if (e.kind === 'ship') {
    const c = colourOf(t, e.a);
    lifts.push({ x: e.x, y: e.y, v: e.b, colour: c, life: 0, max: 40 });
    ring(x, y, c, 1.6);
    spray(x, y, e.b > 2 ? 22 : 12, e.b > 2 ? INK.gold : c, 4.5, 0.08);
    pop(x, y, '+' + e.b, e.a === me ? '#ffffff' : c, e.a === me ? 20 : 14);
    if (e.a === me) shake = Math.max(shake, 4);
    sound.ship(e.a === me, e.b);
  } else if (e.kind === 'stuck') {
    pop(x, y, 'stuck!', INK.warn, e.a === me ? 15 : 12);
    if (e.a === me) sound.stuck();
  } else if (e.kind === 'sink') {
    sinks.push({ x: e.x, y: e.y, v: e.b, life: 0, max: 30 });
    spray(x, y, 14, '#8a9bab', 3, 0.07, 1);
    if (e.a) pop(x, y, '-1', e.a === me ? INK.danger : colourOf(t, e.a), e.a === me ? 18 : 13);
    sound.sink(e.a === me);
  } else if (e.kind === 'spawn') {
    ring(x, y, e.a > 1 ? INK.gold : INK.woodHi, 0.9);
    spray(x, y, 8, e.a > 1 ? INK.goldHi : '#d8c3a5', 2.5, 0.05);
    sound.spawn();
  } else if (e.kind === 'rush') {
    pop(GW / 2, GH / 2, 'rush! every crate ships double', INK.gold, 22);
    sound.rush();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'round') {
    looks.clear();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

function drawGround() {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
}

// The floor, drawn into a picture of its own whenever the floor or the size
// changes: concrete slabs, the rim with its hazard stripes, and the pillars
// standing up off the floor.
function floorArtOf(t) {
  const key = t.m.join('') + '|' + cs.toFixed(2) + '|' + dpx;
  if (floorArt && key === floorKey) return floorArt;
  floorKey = key;
  const wd = Math.ceil(cs * GW), ht = Math.ceil(cs * GH);
  if (!floorArt) floorArt = document.createElement('canvas');
  floorArt.width = Math.ceil(wd * dpx);
  floorArt.height = Math.ceil(ht * dpx);
  const g = floorArt.getContext('2d');
  g.setTransform(dpx, 0, 0, dpx, 0, 0);
  g.clearRect(0, 0, wd, ht);
  for (let y = 1; y < GH - 1; y++) {
    for (let x = 1; x < GW - 1; x++) {
      g.fillStyle = (x + y) % 2 ? INK.floor : INK.floorB;
      g.fillRect(x * cs, y * cs, cs + 0.5, cs + 0.5);
    }
  }
  g.strokeStyle = INK.seam;
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 1; x < GW; x += 2) { g.moveTo(x * cs, cs); g.lineTo(x * cs, (GH - 1) * cs); }
  for (let y = 1; y < GH; y += 2) { g.moveTo(cs, y * cs); g.lineTo((GW - 1) * cs, y * cs); }
  g.stroke();
  // The rim: a thick wall all round, with a band of hazard stripes along its
  // inner edge.
  g.fillStyle = INK.rim;
  g.fillRect(0, 0, wd, cs);
  g.fillRect(0, (GH - 1) * cs, wd, cs);
  g.fillRect(0, 0, cs, ht);
  g.fillRect((GW - 1) * cs, 0, cs, ht);
  g.fillStyle = INK.rimTop;
  g.fillRect(cs * 0.1, cs * 0.1, wd - cs * 0.2, cs * 0.18);
  const band = cs * 0.22;
  g.save();
  g.beginPath();
  g.rect(cs - band, cs - band, wd - 2 * cs + 2 * band, band);
  g.rect(cs - band, (GH - 1) * cs, wd - 2 * cs + 2 * band, band);
  g.rect(cs - band, cs, band, ht - 2 * cs);
  g.rect((GW - 1) * cs, cs, band, ht - 2 * cs);
  g.clip();
  g.fillStyle = INK.hazardDark;
  g.fillRect(0, 0, wd, ht);
  g.fillStyle = INK.hazard;
  const st = cs * 0.5;
  for (let s = -ht; s < wd + ht; s += st) {
    g.beginPath();
    g.moveTo(s, 0);
    g.lineTo(s + st / 2, 0);
    g.lineTo(s + st / 2 + ht, ht);
    g.lineTo(s + ht, ht);
    g.closePath();
    g.fill();
  }
  g.restore();
  // Pillars: a block with a lit top and a shadow on the floor.
  for (let y = 1; y < GH - 1; y++) {
    for (let x = 1; x < GW - 1; x++) {
      if (t.m[at(x, y)] !== 1) continue;
      const sx = x * cs, sy = y * cs, p = cs * 0.06;
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(sx + p + cs * 0.12, sy + p + cs * 0.14, cs - 2 * p, cs - 2 * p);
      g.fillStyle = INK.pillarSide;
      g.fillRect(sx + p, sy + p, cs - 2 * p, cs - 2 * p);
      g.fillStyle = INK.pillar;
      g.fillRect(sx + p, sy + p, cs - 2 * p, cs * 0.7 - p);
      g.fillStyle = INK.pillarTop;
      g.fillRect(sx + p, sy + p, cs - 2 * p, cs * 0.12);
      g.fillStyle = INK.hazard;
      g.fillRect(sx + p, sy + cs * 0.72, cs - 2 * p, cs * 0.08);
    }
  }
  return floorArt;
}

function drawFloor(t) {
  flat();
  const art = floorArtOf(t);
  ctx.drawImage(art, PX(0), PY(0), cs * GW, cs * GH);
}

// Every dock in use: a pad in its owner's colour with chevrons that point in
// off the floor, brighter for your own.
function drawDocks(t, now) {
  flat();
  const me = myId();
  for (const id of playersIn(t)) {
    const d = t.p[id], c = SEAT[d.c];
    const cells = DOCKS[d.s];
    const x0 = cells[0] % GW, y0 = (cells[0] - x0) / GW;
    const X = PX(x0), Y = PY(y0), S = cs * 2;
    const mine = id === me;
    ctx.fillStyle = alpha(c, mine ? 0.3 : 0.18);
    roundRect(X + 2, Y + 2, S - 4, S - 4, cs * 0.25);
    ctx.fill();
    ctx.setLineDash([cs * 0.22, cs * 0.14]);
    ctx.lineDashOffset = -now / 60;
    ctx.strokeStyle = alpha(c, mine ? 0.95 : 0.6);
    ctx.lineWidth = Math.max(1.5, cs * 0.07);
    ctx.stroke();
    ctx.setLineDash([]);
    // Chevrons pointing toward the rim the dock stands against.
    const mx = x0 + 1, my = y0 + 1;
    const vx = mx <= 2 ? -1 : mx >= GW - 2 ? 1 : 0, vy = vx ? 0 : my <= 2 ? -1 : 1;
    ctx.strokeStyle = alpha(c, 0.35 + 0.25 * Math.sin(now / 300));
    ctx.lineWidth = Math.max(1.5, cs * 0.09);
    for (let i = -1; i <= 1; i += 2) {
      const cx = PX(mx) + vx * i * cs * 0.4, cy = PY(my) + vy * i * cs * 0.4, s = cs * 0.22;
      ctx.beginPath();
      ctx.moveTo(cx - vx * s - vy * s * 1.4, cy - vy * s - vx * s * 1.4);
      ctx.lineTo(cx + vx * s * 0.6, cy + vy * s * 0.6);
      ctx.lineTo(cx - vx * s + vy * s * 1.4, cy - vy * s + vx * s * 1.4);
      ctx.stroke();
    }
  }
}

// A crate: planks, a cross brace and a rim of darker wood; gold ones shine.
// A loading crate carries its owner's ring round it, filling; a wedged one
// shakes and reddens as it goes.
function drawCrate(t, k, x, y, now, need) {
  flat();
  const gold = k.v > 1;
  let s = cs * 0.86;
  let jx = 0;
  if (k.jm > 0) {
    const f = k.jm / STUCK;
    jx = Math.sin(now / 25) * cs * 0.04 * (0.4 + f);
  }
  const X = PX(x + 0.5) + jx, Y = PY(y + 0.5);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  roundRect(X - s / 2 + cs * 0.07, Y - s / 2 + cs * 0.1, s, s, cs * 0.12);
  ctx.fill();
  const body = gold ? INK.gold : INK.wood, dark = gold ? INK.goldDark : INK.woodDark, hi = gold ? INK.goldHi : INK.woodHi;
  ctx.fillStyle = dark;
  roundRect(X - s / 2, Y - s / 2, s, s, cs * 0.12);
  ctx.fill();
  const b = s * 0.14;
  ctx.fillStyle = body;
  ctx.fillRect(X - s / 2 + b, Y - s / 2 + b, s - 2 * b, s - 2 * b);
  ctx.strokeStyle = dark;
  ctx.lineWidth = Math.max(1, s * 0.1);
  ctx.beginPath();
  ctx.moveTo(X - s / 2 + b, Y - s / 2 + b);
  ctx.lineTo(X + s / 2 - b, Y + s / 2 - b);
  ctx.moveTo(X + s / 2 - b, Y - s / 2 + b);
  ctx.lineTo(X - s / 2 + b, Y + s / 2 - b);
  ctx.stroke();
  ctx.fillStyle = hi;
  ctx.fillRect(X - s / 2 + b * 0.5, Y - s / 2 + b * 0.3, s - b, b * 0.4);
  if (gold) {
    const k2 = 0.5 + 0.5 * Math.sin(now / 200 + k.i);
    ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.5 * k2).toFixed(3)})`;
    disc(X + s * 0.22, Y - s * 0.22, s * 0.07);
    ctx.fill();
  }
  if (k.jm > 0) {
    ctx.fillStyle = `rgba(255,70,60,${(0.15 + 0.45 * (k.jm / STUCK)).toFixed(3)})`;
    roundRect(X - s / 2, Y - s / 2, s, s, cs * 0.12);
    ctx.fill();
  }
  if (k.ld > 0 && need > 0) {
    const owner = ownerAt(t, at(k.x, k.y));
    const c = owner !== null ? colourOf(t, owner) : '#ffffff';
    const f = Math.min(1, k.ld / need);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = Math.max(2, cs * 0.12);
    disc(X, Y, s * 0.68);
    ctx.stroke();
    ctx.strokeStyle = c;
    ctx.beginPath();
    ctx.arc(X, Y, s * 0.68, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
    ctx.stroke();
  }
}

// A worker: a round body in its colour, a hard hat, eyes looking the way it
// faces, a little squash when it pushes and stars round its head when dazed.
function drawWorker(t, id, x, y, d, me, now, crowned, quick) {
  flat();
  const c = SEAT[d.c];
  const l = lookOf(id);
  const sq = l.squash;
  const [fx, fy] = DIRS[d.fc];
  const X = PX(x + 0.5) + fx * sq * cs * 0.06, Y = PY(y + 0.5) + fy * sq * cs * 0.06;
  const r = cs * 0.36;
  const sx = 1 + sq * 0.14 * (fx ? 1 : -0.6), sy = 1 + sq * 0.14 * (fy ? 1 : -0.6);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(X + cs * 0.05, Y + r * 0.85, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  if (me) {
    ctx.strokeStyle = alpha(c, 0.55 + 0.3 * Math.sin(now / 220));
    ctx.lineWidth = 2;
    disc(X, Y, r * 1.45);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(X, Y);
  ctx.scale(sx, sy);
  ctx.fillStyle = darker(c, 0.35);
  disc(0, 0, r);
  ctx.fill();
  ctx.fillStyle = c;
  disc(0, -r * 0.08, r * 0.9);
  ctx.fill();
  // The hat: a dome with a brim, lighter than the body.
  ctx.fillStyle = lighter(c, 0.55);
  ctx.beginPath();
  ctx.arc(0, -r * 0.3, r * 0.62, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(-r * 0.8, -r * 0.34, r * 1.6, r * 0.14);
  ctx.fillStyle = darker(c, 0.2);
  ctx.fillRect(-r * 0.08, -r * 0.9, r * 0.16, r * 0.5);
  // Eyes, looking the way it faces.
  const ex = fx * r * 0.28, ey = fy * r * 0.18 + r * 0.12;
  for (const side of [-1, 1]) {
    ctx.fillStyle = '#ffffff';
    disc(ex + side * r * 0.28, ey, r * 0.17);
    ctx.fill();
    ctx.fillStyle = '#18222c';
    disc(ex + side * r * 0.28 + fx * r * 0.06, ey + fy * r * 0.06, r * 0.09);
    ctx.fill();
  }
  ctx.restore();
  if (d.dz > 0 || l.daze > 0.3) {
    for (let i = 0; i < 3; i++) {
      const a = now / 180 + (i * Math.PI * 2) / 3;
      ctx.fillStyle = '#fff3a0';
      disc(X + Math.cos(a) * r * 0.9, Y - r * 1.05 + Math.sin(a) * r * 0.3, Math.max(1.5, cs * 0.05));
      ctx.fill();
    }
  }
  if (crowned) drawCrown(X, Y - r * 1.35, r * 0.5, now);
  if (quick) {
    ctx.strokeStyle = alpha(c, 0.7);
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const o = ((now / 90 + i * 4) % 12) / 12;
      ctx.globalAlpha = 1 - o;
      ctx.beginPath();
      ctx.moveTo(X - fx * r * (1.2 + o) - fy * r * (i - 1) * 0.4, Y - fy * r * (1.2 + o) - fx * r * (i - 1) * 0.4);
      ctx.lineTo(X - fx * r * (1.6 + o) - fy * r * (i - 1) * 0.4, Y - fy * r * (1.6 + o) - fx * r * (i - 1) * 0.4);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (!me && cs > 14) {
    ctx.font = font(Math.max(9, Math.min(12, cs * 0.38)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(12,20,30,0.8)';
    const s = nickOf(id);
    ctx.strokeText(s, X, Y + r * 1.75);
    ctx.fillStyle = alpha(c, 0.95);
    ctx.fillText(s, X, Y + r * 1.75);
  }
}

function drawCrown(x, y, s, now) {
  const b = Math.sin(now / 260) * s * 0.12;
  ctx.fillStyle = INK.gold;
  ctx.beginPath();
  ctx.moveTo(x - s, y + b);
  ctx.lineTo(x - s, y - s * 0.7 + b);
  ctx.lineTo(x - s * 0.5, y - s * 0.25 + b);
  ctx.lineTo(x, y - s * 0.9 + b);
  ctx.lineTo(x + s * 0.5, y - s * 0.25 + b);
  ctx.lineTo(x + s, y - s * 0.7 + b);
  ctx.lineTo(x + s, y + b);
  ctx.closePath();
  ctx.fill();
}

// Where your hand points, a step ahead of your worker.
function drawWish(x, y, d, now) {
  if (!d.wd) return;
  flat();
  const [dx, dy] = DIRS[d.wd];
  const sx = PX(x + 0.5) + dx * cs * 0.72, sy = PY(y + 0.5) + dy * cs * 0.72, s = cs * 0.14;
  ctx.globalAlpha = 0.5 + 0.25 * Math.sin(now / 120);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(sx + dx * s * 1.2, sy + dy * s * 1.2);
  ctx.lineTo(sx - dy * s - dx * s * 0.4, sy + dx * s - dy * s * 0.4);
  ctx.lineTo(sx + dy * s - dx * s * 0.4, sy - dx * s - dy * s * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawBits() {
  flat();
  for (const s of sinks) {
    const k = s.life / s.max, sz = cs * 0.86 * (1 - ease(k));
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = s.v > 1 ? INK.goldDark : INK.woodDark;
    roundRect(PX(s.x + 0.5) - sz / 2, PY(s.y + 0.5) - sz / 2, sz, sz, cs * 0.1);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const l of lifts) {
    const k = l.life / l.max, sz = cs * 0.86 * (1 + 0.5 * ease(k));
    const X = PX(l.x + 0.5), Y = PY(l.y + 0.5) - ease(k) * cs * 1.2;
    ctx.globalAlpha = 1 - k * k;
    ctx.strokeStyle = '#d0dbe5';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(X, Y - sz / 2);
    ctx.lineTo(X, Y - sz / 2 - cs * 1.5);
    ctx.stroke();
    ctx.fillStyle = l.v > 2 ? INK.gold : INK.wood;
    roundRect(X - sz / 2, Y - sz / 2, sz, sz, cs * 0.12);
    ctx.fill();
    ctx.strokeStyle = l.colour;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const b of bits) {
    const k = b.life / b.max;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = b.colour;
    disc(PX(b.x), PY(b.y), b.size * cs * (1 - k * 0.5));
    ctx.fill();
  }
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = (1 - k) * 0.7;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - k) + 1;
    disc(PX(r.x), PY(r.y), r.r * cs * ease(k));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const k = p.life / p.max;
    const rise = 10 + ease(k) * 26;
    const scale = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, k - 0.15);
    ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    ctx.font = font(p.px * scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(12,20,30,0.85)';
    const X = PX(p.x), Y = PY(p.y) - rise;
    ctx.strokeText(p.s, X, Y);
    ctx.fillStyle = p.colour;
    ctx.fillText(p.s, X, Y);
  }
  ctx.globalAlpha = 1;
}

const clock = (steps) => {
  const s = Math.ceil(steps / HZ);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, and the time left in it.
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left' + (rushOn(t) ? ' · rush!' : '');
    if (rushOn(t)) colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('dockyard', 12, 22, titlePx, INK.hazard, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('dockyard').width;
  if (wide) fitText(status, 12, 44, 14, colour, colW - 24, 'left');
  else fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points this round
  // and rounds won. A row across the top of a narrow frame, a column down the
  // left of a wide one.
  const ids = bySeat(t);
  const crown = t.ph === WAIT || t.ph === PLAY ? leaderOf(t) : -1;
  const top = topOf(t);
  if (ids.length) {
    const gap = 6;
    const cw = wide ? Math.min(200, colW - 24) : Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = wide ? 12 : (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    let y = wide ? 78 : narrow ? 46 : 44;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = c;
      roundRect(x + 6, y - 7, 10, 10, 2);
      ctx.fill();
      const fast = t.ph === PLAY && trails(t, d, top);
      const score = String(d.sc) + (fast && cw > 70 ? ' »' : '') + (d.wn && cw > 60 ? ' ★' + d.wn : '');
      ctx.font = font(12);
      const sw = Math.min(cw - 24, ctx.measureText(score).width);
      fitText(score, x + cw - 8, y + 3, 12, id === crown ? INK.gold : INK.text, cw - 24, 'right');
      if (cw > 56) fitText(mine ? 'you' : nickOf(id), x + 22, y + 3, 12, mine ? INK.text : INK.muted, cw - 36 - sw, 'left');
      if (wide) y += 22 + gap; else x += cw + gap;
    }
  }

  // The one line that says how to play: across the foot of a narrow frame, and
  // broken into lines at the foot of the right-hand column of a wide one.
  const how = coarse
    ? 'drag to walk · walk into a crate to push it onto your dock · walk into a rival to shove them'
    : 'arrows/WASD or drag to walk · walk into a crate to push it onto your dock · walk into a rival to shove them · M mutes';
  if (!wide) { fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20); return; }
  const lines = wrap(how, 12, colW - 24);
  lines.forEach((s, i) => text(s, VW - 12, VH - 12 - (lines.length - 1 - i) * 17, 12, INK.muted, 'right'));
}

// Your dock, while a round is on: how long a crate stands on it, and why, in
// the strip under the floor or halfway down the right-hand column.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph !== PLAY) return;
  flat();
  const y = wide ? VH / 2 : Math.min(fieldBot + NOTE_ROOM / 2 - 2, VH - BOT - 14);
  const mid = wide ? VW - colW / 2 : VW / 2, most = wide ? colW - 24 : VW - 24;
  const top = topOf(t), lead = leaderOf(t);
  const need = loadOf(t, myId(), top, lead);
  const secs = (need / HZ).toFixed(1) + 's';
  let line, colour = INK.muted;
  if (d.dz > 0) { line = 'dazed!'; colour = INK.danger; }
  else if (myId() === lead) { line = 'you lead · your dock loads slower: ' + secs; colour = INK.gold; }
  else if (trails(t, d, top)) { line = 'catching up · you run faster · your dock loads in ' + secs; colour = SEAT[d.c]; }
  else line = 'your dock loads a crate in ' + secs;
  if (wide) {
    const lines = wrap(line, 13, most);
    lines.forEach((s, i) => text(s, mid, y + i * 18, 13, colour, 'center'));
  } else fitText(line, mid, y, 13, colour, most);
}

// ═══════════════════ the practice note ═══════════════════
// What a player sees while nobody else is here, alike in every game on this
// shelf: one short note at the foot of the screen, over the line of controls,
// saying who they practise with and what starts the real thing — or, once
// somebody has joined, that practice ends in a moment. It takes an empty strip
// beside the field instead when one is tall enough, so it covers nothing, and
// folds to its first line a few seconds in or at the first key or touch.
const NOTE_FOLD_MS = 6000;
const NOTE_FONT = "{w} {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const noteFont = (px, wt) => NOTE_FONT.replace('{w}', String(wt)).replace('{px}', String(Math.round(px * 10) / 10));
let noteSince = 0, noteSeen = -1e9, noteTouched = false;
addEventListener('keydown', () => { noteTouched = true; }, true);
addEventListener('pointerdown', () => { noteTouched = true; }, true);

// `bands` are the free strips beside the field, as [top, bottom] in screen
// pixels; `foot` is where the note's lower edge stands when none of them fits.
// The note is centred on a span `vw` wide from `left`: the screen, by default.
function practiceNote(now, vw, head, tip, bands, foot, left = 0) {
  if (now - noteSeen > 500) { noteSince = now; noteTouched = false; }
  noteSeen = now;
  const two = !!tip && !noteTouched && now - noteSince < NOTE_FOLD_MS;
  const h = two ? 50 : 30;
  ctx.font = noteFont(13, 700);
  const hw = ctx.measureText(head).width;
  ctx.font = noteFont(12, 600);
  const tw = two ? ctx.measureText(tip).width : 0;
  const w = Math.min(vw - 16, Math.max(hw + 14, tw) + 28);
  let y = foot - h, room = 0;
  for (const [a, b] of bands) if (b - a >= h + 4 && b - a > room) { room = b - a; y = (a + b - h) / 2; }
  const x = left + (vw - w) / 2, r = h / 2 > 15 ? 15 : h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(12,16,30,0.84)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textBaseline = 'middle';
  const hk = Math.min(1, (w - 42) / Math.max(1, hw));
  const hx = left + vw / 2 - (hw * hk + 14) / 2, hy = y + (two ? 17 : 15);
  ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now / 260);
  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.arc(hx + 4, hy, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.font = noteFont(13 * hk, 700);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(head, hx + 14, hy);
  if (two) {
    ctx.font = noteFont(12 * Math.min(1, (w - 28) / Math.max(1, tw)), 600);
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.textAlign = 'center';
    ctx.fillText(tip, left + vw / 2, y + 35);
  }
  ctx.restore();
}

// Practice ends a moment after a second player arrives: who it was, as this
// page sees it — the room lists its players in the order they came.
function joinHead(t, left) {
  const me = myId();
  const order = (id) => { const i = room.players.findIndex((p) => p.id === id); return i < 0 ? 1e9 : i; };
  const hs = humans(t).sort((a, b) => order(a) - order(b));
  const last = hs[hs.length - 1];
  return (last === me ? 'you joined ' + nickOf(hs[0]) : nickOf(last) + ' joined') + ' · practice ends in ' + left;
}

function panel(cx, cy, w, h) {
  ctx.fillStyle = INK.panel;
  roundRect(cx - w / 2, cy - h / 2, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawOverlay(t, now) {
  flat();
  const cx = VW / 2, mid = (fieldTop + fieldBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'get behind a crate before you push · slide crates along the wall onto your dock';
    // A wide frame has no strip above or below the floor: the note sits at
    // the foot of it for as long as practice lasts.
    if (wide) practiceNote(now, VW, head, tip, [], VH - 8);
    else practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,20,30,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid - big * 0.6);
    text(String(n), cx, mid - big * 0.6, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 1.4, Math.min(VW - 32, 360), 30);
    fitText('most crates shipped from your dock when time runs out wins', cx, mid + big * 1.4 + 5, 14, INK.text, Math.min(VW - 48, 340));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,20,30,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('go!', cx, mid + big * 0.5);
    text('go!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 340), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody shipped the most';
    else head = t.win === me ? 'you win the round!' : nickOf(t.win) + ' wins the round';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('points', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('crates', cx + w / 2 - 64, y0 + 52, 10, INK.dim, 'right');
    text('rounds', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, won, wins, points, crates], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      roundRect(cx - w / 2 + 19, y - 9, 10, 10, 2);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (won ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(points), cx + w / 2 - 110, y, 14, INK.text, 'right');
      text(String(crates), cx + w / 2 - 64, y, 14, INK.text, 'right');
      text(String(wins), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Your own worker is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a step a step away from
// where the guess had it. So the worker drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a new round — puts it there at once. Only the drawing is
// smoothed: the warehouse, and every rule in it, are untouched.
const PULL = 0.4;
let shown = null;        // [x, y] in cells: where your worker is drawn

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 1.6) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  const b = agreedAt(now);
  drawGround();
  if (!b) {
    flat();
    const cx = VW / 2, cy = VH / 2;
    panel(cx, cy, Math.min(VW - 32, 300), 60);
    text('catching up with the warehouse…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a warehouse this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const me = myId();
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  drawFloor(t);
  drawDocks(t, now);
  // Crates: from the agreed table, but one your own worker is pushing in the
  // guess is drawn from the guess, so it moves when your worker leans on it
  // rather than a trip later.
  const top = topOf(t), lead = leaderOf(t);
  const fromK = new Map(b.from.k.map((k) => [k.i, k]));
  const guessK = own && own !== b ? new Map(own.to.k.map((k) => [k.i, k])) : null;
  const guessFrom = own && own !== b ? new Map(own.from.k.map((k) => [k.i, k])) : null;
  for (const k of t.k) {
    let p = posBetween(fromK.get(k.i), k, b.k), shownK = k;
    const g = guessK && guessK.get(k.i);
    if (g && g.by === me && (g.x !== k.x || g.y !== k.y || g.mc > 0)) {
      p = posBetween(guessFrom.get(k.i), g, own.k);
      shownK = g;
    }
    const owner = ownerAt(t, at(k.x, k.y));
    drawCrate(t, shownK === k ? k : Object.assign({}, k, { jm: 0 }), p[0], p[1], now, owner !== null ? loadOf(t, owner, top, lead) : 0);
  }
  const crown = t.ph === WAIT || t.ph === PLAY ? leaderOf(t) : -1;
  const quick = (d) => t.ph === PLAY && trails(t, d, top);
  // Workers drawn top to bottom, so the one nearer the foot of the screen
  // stands in front.
  const later = [];
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    const p = posBetween(b.from.p[id], d, b.k);
    later.push([p[1], () => drawWorker(t, id, p[0], p[1], d, false, now, id === crown, quick(d))]);
  }
  if (own) {
    const d = own.to.p[me];
    const p = posBetween(own.from.p[me], d, own.k);
    const [x, y] = settle(p[0], p[1]);
    later.push([y, () => { drawWish(x, y, d, now); drawWorker(t, me, x, y, d, true, now, me === crown, quick(t.p[me] || d)); }]);
  } else shown = null;
  later.sort((a, z) => a[0] - z[0]);
  for (const [, f] of later) f();
  for (const [id, look] of looks) if (now - look.seen > 4000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way to walk, held until it changes. A change goes
// out at once, but no oftener than TURN_EVERY while it keeps changing, because
// a thumb sweeping about changes it on every move the screen reports and the
// clock's ticks share the same seat's ceiling on messages.
const TURN_EVERY = 50;
let wanted = 0;
let lastSaid = 0;
let saidAt = -1e9;

function push(dir) {
  wanted = dir;
  sayHand(performance.now());
}
function sayHand(now) {
  if (wanted === lastSaid) return;
  if (now - saidAt < TURN_EVERY) return;
  lastSaid = wanted;
  saidAt = now;
  setHand(wanted);
}

// Keys are read by where they sit, not what they type, so every layout runs.
// The last key still held is the way to walk.
const KEY_DIR = { ArrowUp: 1, KeyW: 1, ArrowRight: 2, KeyD: 2, ArrowDown: 3, KeyS: 3, ArrowLeft: 4, KeyA: 4 };
const held = [];
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { if (!e.repeat) setMuted(!muted); return; }
  if (!(e.code in KEY_DIR)) return;
  e.preventDefault();
  coarse = false;
  if (e.repeat && held.includes(e.code)) return;
  const i = held.indexOf(e.code);
  if (i >= 0) held.splice(i, 1);
  held.push(e.code);
  push(KEY_DIR[e.code]);
});
addEventListener('keyup', (e) => {
  const i = held.indexOf(e.code);
  if (i < 0) return;
  held.splice(i, 1);
  push(held.length ? KEY_DIR[held[held.length - 1]] : 0);
});

// A thumb or a mouse: a drag walks the way it points from where it started,
// for as long as it is held, and the start follows a thumb that wanders far
// so turning back is never a long way. Bound to the canvas and captured there,
// because iOS keeps a long press inside a frame for itself.
const SWIPE = 14;
const REACH = 56;
let drag = null;
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY };
});
cv.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  let dx = drag.x - drag.ox, dy = drag.y - drag.oy;
  const len = Math.hypot(dx, dy);
  if (len > REACH) {
    drag.ox = drag.x - (dx / len) * REACH;
    drag.oy = drag.y - (dy / len) * REACH;
    dx = drag.x - drag.ox;
    dy = drag.y - drag.oy;
  }
  if (len < SWIPE) { push(0); return; }
  push(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 4) : dy > 0 ? 3 : 1);
});
function lift(e) {
  if (drag && e.pointerId === drag.id) { drag = null; push(0); }
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);
addEventListener('blur', () => { drag = null; held.length = 0; push(0); });

// Where the drag started, and the way it walks, under the thumb.
function drawDrag() {
  if (!drag) return;
  flat();
  const r = cv.getBoundingClientRect();
  const x = drag.ox - r.left, y = drag.oy - r.top;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1.5;
  disc(x, y, 24);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  disc(x + Math.max(-18, Math.min(18, drag.x - drag.ox)), y + Math.max(-18, Math.min(18, drag.y - drag.oy)), 9);
  ctx.fill();
}

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  sayHand(now);
  try { draw(now); drawDrag(); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a player arrives in the warehouse.
function start() {
  setHand(0);
  lastSaid = 0;
  requestAnimationFrame(frame);
}

// ═══════════════════ the lockstep kernel ═══════════════════
// The kernel every lockstep disk carries at its end, word for word. A disk is
// one file with no imports, so it cannot share this; `splice.py` writes it into
// each of them between the kernel's two marker lines, and `--check` fails when
// one has drifted.
//
// A table is the whole state of a game: plain data, fingerprinted and handed
// over as JSON. Every copy changes it only on what comes back round the room —
// hands and ticks alike are sent with `{ echo: true }` — so every copy applies
// the same things in the same order and holds the same table. One copy sends
// the ticks, which is keeping a clock and nothing more: a hand joins whichever
// tick reaches the server after it, so how far that copy is from the server
// decides how evenly the table moves and not how late anybody's hand lands. The
// host keeps the clock while its page is on screen, and the next in the room's
// line stands in for it when its ticks stop — see the clock, below.
//
// Every copy runs these same bytes, but a page with a console open does not
// have to, and anything it sends is read as a claim. Nobody can be taken off the
// table by a tick unless every copy can see for itself that they are gone or
// silent; a tick's word that the tables have parted is taken from the host, or
// from a stand-in while the host is quiet, and from nobody else; a handover is
// one sender's table, the host's before anybody's. What stays open, and is not
// claimed otherwise: a tick moves the table forward whoever sends it, so such a
// page can run the game faster for everybody, and it can play its own hand any
// way it likes — the table is agreed, not refereed.
//
// What the game above provides:
//
//   HZ, STEPS_PER_TICK, PREDICT, and KEEP_SILENT if a silent player should stay
//   freshTable(seed)     a new table, without `n` and `seen` — those are the kernel's
//   step(w)              one step; `w.n` is already the step being taken
//   hand(w, id, input)   a hand, at its place in the room's order
//   inputOf(raw)         a hand off the wire made safe, or null
//   leave(w, id)         somebody is gone from the room
//   playersIn(w)         the ids the table has a place for
//   tableOf(raw)         a table off the wire made safe, or null
//   start()              called once, when the kernel stands
//
// What the kernel gives the game:
//
//   world                the table the room agrees on, or null while catching up
//   agreedAt(now)        { from, to, k } — the agreed table as drawn, on a steady
//                        clock a little behind the last tick: everybody else's pieces
//   mineAt(now)          { from, to, k } — the same a trip ahead, with this copy's
//                        hands in it: this copy's own piece. The agreed table
//                        when PREDICT is off
//   setHand(input)       this copy's hand has changed
//   live                 true only while the agreed table steps: effects — a
//                        sound, a spray of blood — are made then, so a guess
//                        replayed ten times makes none of them
//   wireNote()           a line saying what the wire costs, for a corner

const STEP_MS = 1000 / HZ;
const TICK_MS = STEP_MS * STEPS_PER_TICK;
const TICK_BATCH = 4;                    // ticks' worth of steps one tick may carry after a stall
const HAND_EVERY = 1000;                 // a hand held still is said again this often
const RESEND_AFTER = 500;                // a hand the room never handed back is said again
const HANDOVER_WAIT = 3000;              // how long to wait for somebody to hand the table over
const HANDOVER_GRACE = 500;              // how long a handover from anybody but the host waits for the host's
// A hand not heard from in this long has left the table — unless the game says
// otherwise with `KEEP_SILENT`, where leaving the table costs more than a
// silent player standing at it does.
const SILENT_STEPS = typeof KEEP_SILENT !== 'undefined' && KEEP_SILENT ? Infinity : 3 * HZ;
const PRINTS_KEPT = 10 * HZ;             // steps of fingerprints kept to compare with the clock's
const HANDOVER_PIECE = 3000;             // characters of a table in one piece of a handover
const GUESS_REACH = Math.ceil(400 / STEP_MS); // a guess never reaches further ahead than this

const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const isHost = (id) => room.host !== null && room.host.id === id;

let world = null;
let helloNonce = null;                   // which of my requests for the table is the live one
let helloHeard = false;                  // whether the room has handed that request back
let helloAt = 0;
const streamBacklog = [];                // what the room said after my request, until the table arrives
const handovers = new Map();             // sender -> a handover of theirs being put together
let offered = null;                      // { from, table, at }: a whole handover from somebody not the host
const prints = new Map();                // step -> fingerprint of the table right after it
let lastPrint = null;
let catchUpFrom = 0;                     // the first step whose fingerprint this copy vouches for
let live = false;

let myHand = null;
let inSeq = 0;
const unheard = [];                      // my hands the room has not handed back yet
const unticked = [];                     // my hands handed back, waiting for the tick that moves them
const lags = [];                         // hand to agreed table, ms — kept for a check to read
let lagMs = null;
let tripMs = null;                       // hand to its own echo, ms
// Steps the guess is moved by, learned from where my hands actually land. The
// steady clock settles on the earliest ticks, so on a wire whose delay jumps it
// runs ahead of the table most ticks arrive at, and the trip on top of it puts
// every hand a step or three later than the room does — my piece snapping back
// each time the truth arrives. Each hand that comes back says by how much.
let guessOff = 0;
const GUESS_LEARN = 0.2;                 // how much of one hand's miss moves the guess
const GUESS_MISS = 3;                    // the most steps one hand's miss counts for
let echoAt = null;                       // when something this copy sent last came back to it
const ECHO_LOST = 3000;                  // ms without an echo that mean echoes are not coming back

// Whether what this copy sends comes back to it. A page opened before the
// server learned the echo sends everything as a plain broadcast, so nothing it
// says ever comes back: its table never moves on its own ticks or its own
// hands, and it is wrong about everything from then on. Such a copy must not
// keep the clock or hand anybody its table — one that did would hand a stale
// table to every copy that asked, and tick a clock nobody's table agrees with,
// round and round.
const hearsItself = (now) => solo() || (echoAt !== null && now - echoAt < ECHO_LOST);

// The fingerprint of a table. The text of a number is fixed by the language,
// so equal tables print equally.
function fingerprint(w) {
  const text = JSON.stringify(w);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function startTable(seed) {
  const t = freshTable(seed);
  t.n = 0;
  t.seen = {};
  return t;
}

// The kernel's own part of a table off the wire, then the game's.
function readTable(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.n) || raw.n < 0) return null;
  const t = tableOf(raw);
  if (!t) return null;
  t.n = raw.n;
  t.seen = {};
  for (const [id, at] of Object.entries(raw.seen || {})) {
    if (Number.isInteger(Number(id)) && Number.isInteger(at)) t.seen[id] = at;
  }
  return t;
}

const copyTable = (w) => JSON.parse(JSON.stringify(w));

// Everything that changes the table goes round the room, the sender's copy
// included. Without a room there is nobody to go round, and it is applied here.
function emitRoom(msg) {
  if (solo()) fromStream(myId(), msg);
  else room.send(msg, { echo: true });
}

function adoptTable(table) {
  world = table;
  tableAt = movedAt = performance.now();
  prints.clear();
  lastPrint = null;
  catchUpFrom = table.n;
  keepAgreed(true);
  guessPrev = guessLast = null;
  reshow();
}

function askForTable() {
  world = null;
  helloHeard = false;
  streamBacklog.length = 0;
  handovers.clear();
  offered = null;
  // Not part of the table: it only tells this request from an older one.
  helloNonce = Math.floor(Math.random() * 1e9);
  helloAt = performance.now();
  room.send({ t: 'hello', nonce: helloNonce }, { echo: true });
}

// A copy that has parted from the others does not argue: it drops its table
// and asks for the room's.
function parted(why) {
  console.log('this table parted from the room (' + why + ') — asking for it again');
  askForTable();
}

function fromStream(from, msg) {
  // Anything of this copy's that comes back round is an echo, whatever the
  // table goes on to make of it; and a tick is a clock somebody is keeping,
  // whether or not this copy holds a table to step yet.
  const now = performance.now();
  if (from === myId()) echoAt = now;
  if (msg.t === 'tick') clockHeard.set(from, now);
  if (!world) {
    if (msg.t === 'hello' && from === myId() && msg.nonce === helloNonce) {
      // From here on is what the table handed over has not seen.
      helloHeard = true;
      streamBacklog.length = 0;
    } else if (helloHeard) {
      streamBacklog.push([from, msg]);
    }
    return;
  }
  applyStream(from, msg);
}

function applyStream(from, msg) {
  if (msg.t === 'in') {
    const input = inputOf(msg.i);
    if (input === null || !Number.isInteger(from)) return;
    hand(world, from, input);
    world.seen[from] = world.n;
    lateAgreed = null;
    if (from === myId()) heardMine(msg.s);
  } else if (msg.t === 'tick') {
    onTick(from, msg);
  } else if (msg.t === 'hello' && from !== myId() && hearsItself(performance.now()) &&
             (isHost(myId()) || isHost(from) || keepsClock(performance.now()))) {
    // Every copy holding the table holds this one at this point in the order,
    // which is exactly where the newcomer will replay from. The host answers,
    // and whoever is standing in for its clock — a host whose tab is out of
    // sight answers nobody — or, when the host is the one asking, everybody who
    // can. Two answers are the same table twice.
    handOver(from, msg.nonce, JSON.stringify(world));
  }
}

function heardMine(seq) {
  const now = performance.now();
  while (unheard.length && unheard[0].seq <= seq) {
    const h = unheard.shift();
    if (h.seq !== seq) continue;
    const trip = now - h.at;
    tripMs = tripMs === null ? trip : tripMs * 0.8 + trip * 0.2;
    if (h.measured) unticked.push(h);
    if (h.clocked && world) {
      // It lands at the table as it stands now, and steps on from there.
      const miss = Math.max(-GUESS_MISS, Math.min(GUESS_MISS, world.n - h.step));
      guessOff = Math.max(-GUESS_REACH, Math.min(GUESS_REACH, guessOff + miss * GUESS_LEARN));
    }
  }
}

// A handover, cut into pieces a payload holds and sent a few milliseconds
// apart rather than in one loop, so that it never meets the burst ceiling.
function handOver(to, nonce, text) {
  const of = Math.max(1, Math.ceil(text.length / HANDOVER_PIECE));
  for (let i = 0; i < of; i++) {
    const part = text.slice(i * HANDOVER_PIECE, (i + 1) * HANDOVER_PIECE);
    setTimeout(() => room.send({ t: 'snap', nonce, i, of, part }, { to }), i * 15);
  }
}

// A tick names the step it brings the table to rather than how many steps to
// take. Two clocks ticking at once — a stand-in taking over while the one it
// stands in for comes back — then bring the table to the same step twice, and
// the second does nothing; a tick the room lost is made up by the next one.
//
// Whether this copy has parted is its own business, so what a tick says about
// that is believed only from a sender entitled to say it; whether the table
// steps is everybody's, so that turns on nothing but the tick and the table.
function onTick(from, msg) {
  const to = msg.to;
  if (!Number.isInteger(to)) return;
  if (to <= world.n) return;
  const k = to - world.n;
  const vouched = isHost(from) || hostQuiet(performance.now());
  if (k > STEPS_PER_TICK * TICK_BATCH * 2) return vouched ? parted('the clock is somewhere else') : undefined;

  // The clock says what the table looked like when it last saw it. That step
  // is behind this one in the room's order, so this copy has been there too —
  // and if it saw something else, or cannot have been there at all, it has
  // parted.
  if (vouched && Number.isInteger(msg.hn)) {
    if (msg.hn > world.n || msg.hn < world.n - PRINTS_KEPT) return parted('the clock is somewhere else');
    if (msg.hn >= catchUpFrom && prints.has(msg.hn) && prints.get(msg.hn) !== msg.h) {
      return parted('different tables at step ' + msg.hn);
    }
  }

  // Somebody leaves the table only if every copy can see for itself that they
  // should: they are gone from the room, or the table has not heard them in a
  // while. The room's roster is the same on every copy at this point in the
  // order, and so is the table; a name on the list alone is nobody's word.
  if (Array.isArray(msg.drop)) {
    const here = new Set(room.players.map((p) => p.id));
    for (const id of msg.drop) {
      if (!Number.isInteger(id)) continue;
      const heard = world.seen[id];
      if (here.has(id) && heard !== undefined && world.n - heard <= SILENT_STEPS) continue;
      leave(world, id);
      delete world.seen[id];
    }
  }
  live = true;
  try {
    for (let i = 0; i < k; i++) {
      world.n += 1;
      step(world);
    }
  } finally {
    live = false;
  }

  movedAt = performance.now();
  lastPrint = world.n;
  prints.set(world.n, fingerprint(world));
  for (const n of prints.keys()) {
    if (n < world.n - PRINTS_KEPT) prints.delete(n);
    else break;
  }

  const now = performance.now();
  for (const h of unticked.splice(0)) {
    const lag = now - h.at;
    lags.push(Math.round(lag));
    if (lags.length > 200) lags.shift();
    lagMs = lagMs === null ? lag : lagMs * 0.7 + lag * 0.3;
  }
  keepAgreed(false);
  reshow();
}

// A handover is put together from one sender's pieces alone. The request's
// nonce comes back round the room to everybody, so anybody can answer it; pieces
// from two senders mixed are a table nobody sent, and one sender answering with
// a table of its own making must not be able to finish somebody else's.
//
// Whose table is taken is decided by who sent it rather than by who was
// quickest. The host's is taken the moment it is whole. Anybody else's — a
// stand-in answering for a host out of sight, or everybody answering a host
// that asked — waits a moment for the host's, and then the one from whoever
// stands earliest in the room's line is taken. A player with a console open can
// still answer first; they can no longer be taken first for it.
room.on('message', (from, msg) => {
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t !== 'snap') return fromStream(from, msg);
  if (world || !helloHeard || msg.nonce !== helloNonce) return;
  if (!Number.isInteger(msg.of) || msg.of < 1 || msg.of > 64 || !Number.isInteger(msg.i)) return;
  if (msg.i < 0 || msg.i >= msg.of || typeof msg.part !== 'string') return;
  let parts = handovers.get(from);
  if (!parts || parts.of !== msg.of) handovers.set(from, (parts = { of: msg.of, got: [] }));
  parts.got[msg.i] = msg.part;
  for (let i = 0; i < parts.of; i++) if (typeof parts.got[i] !== 'string') return;
  handovers.delete(from);
  let table = null;
  try { table = readTable(JSON.parse(parts.got.join(''))); } catch (_) { table = null; }
  if (!table) return;
  if (isHost(from)) return takeHandover(table);
  if (!offered || placeOf(from) < placeOf(offered.from)) {
    offered = { from, table, at: offered ? offered.at : performance.now() };
  }
});

function takeHandover(table) {
  adoptTable(table);
  // Everything the room said since my request, on top of the table as it
  // stood at my request.
  for (const [f, m] of streamBacklog.splice(0)) {
    if (!world) break;
    applyStream(f, m);
  }
}

// ── the hand ────────────────────────────────────────────────────────────────
function setHand(input) {
  if (myHand !== null && JSON.stringify(input) === JSON.stringify(myHand)) return;
  myHand = input;
  sendHand(true);
  reshow();
}

function sendHand(measured) {
  if (myHand === null) return;
  inSeq += 1;
  // The step the room will apply this hand at: the agreed table it will have
  // stepped to by the time the hand comes back, read off the steady clock and
  // the measured trip rather than off the last table and a rounded reach. A
  // guess that puts a turn one step early or late is a piece that snaps a step
  // when the truth arrives, and on a board of coarse steps that is a whole cell.
  // Only a hand placed off the clock, after a tick has set it, teaches the
  // guess anything: one placed without it was never the guess's to miss.
  const clocked = !!world && stepClock !== null && !stepClockGuessed && tripMs !== null;
  const at = world
    ? stepClock !== null && tripMs !== null
      ? Math.max(world.n, Math.floor(stepNow(performance.now()) + tripMs / STEP_MS + guessOff))
      : world.n + aheadSteps()
    : 0;
  unheard.push({ seq: inSeq, at: performance.now(), step: at, input: myHand, measured, clocked });
  if (unheard.length > 64) unheard.shift();
  emitRoom({ t: 'in', s: inSeq, i: myHand });
}

// ── what is drawn ───────────────────────────────────────────────────────────
// Two things are drawn, on one steady clock.
//
// The agreed table, a little in the past. Every table a tick produces is kept
// with the step it stands at, and the drawing walks between two of them at a
// pace set by the step numbers rather than by when each happened to arrive. A
// tick that lands a few milliseconds early or late then moves nothing on
// screen; walking from whatever arrived last, every one of them is a jolt.
//
// And this copy's own piece, a trip ahead: the agreed table played forward by
// the trip it takes, with this copy's hands in it, remade whenever the agreed
// table moves or a hand changes. The guess is kept at two steps a tick apart,
// both played from the same agreed table in one pass, and the piece walks
// between them on the same clock — two guesses from two different tables
// disagree about a turn made in between, and the piece covers both of their
// ideas of it in one tick. A game
// draws its own piece from the guess and everybody else's from the agreed
// table, because a guess about somebody else's hand is wrong every time they
// change it, and a piece that jumps back a whole trip each time is worse to
// watch than one that is a trip late.
const SHOWN_BEHIND = 1.5 * STEPS_PER_TICK;   // steps the agreed drawing trails the last tick
const SHOWN_KEPT = 8;
const agreed = [];                           // [{ n, t }], oldest first
let stepClock = null;                        // when step 0 would have arrived, ms
let stepClockGuessed = false;                // set from a table taken, not yet from a tick
let guessPrev = null, guessLast = null;     // { n, t }
let guessTable = null;
let reach = 0;                               // steps the guess runs ahead of the agreed table

function aheadSteps() {
  if (!PREDICT || solo() || tripMs === null) return 0;
  // Moved only when the trip has moved a whole step: a guess that flips
  // between two reaches jumps everything it draws back and forth by a step.
  // The piece is drawn as far ahead as its hands land: drawn any further, a
  // hand lands in what is already on screen and the piece jumps as it is made.
  const want = Math.max(0, Math.min(GUESS_REACH, tripMs / STEP_MS + guessOff));
  if (Math.abs(want - reach) >= 1) reach = Math.round(want);
  return reach;
}

function keepAgreed(fresh) {
  if (fresh) { agreed.length = 0; stepClock = null; }
  agreed.push({ n: world.n, t: copyTable(world) });
  while (agreed.length > SHOWN_KEPT) agreed.shift();
  // Early arrivals pull the clock in quickly, late ones push it out slowly:
  // it settles on the steady pace the host's ticks are sent at, not on the
  // wire's jitter.
  //
  // A table taken is no arrival: it stands a whole trip ahead of the first tick
  // that comes back round, and a clock set by it is one that late ones would
  // take seconds to push out — every frame of those seconds drawn on the newest
  // table, the game moving in jolts. So it holds the clock only until that
  // tick, and the tick sets it outright.
  const o = performance.now() - world.n * STEP_MS;
  if (stepClock === null || stepClockGuessed) stepClock = o;
  else stepClock += (o - stepClock) * (o < stepClock ? 0.3 : 0.02);
  stepClockGuessed = fresh;
}

// The step the clock says it is, as a fraction.
const stepNow = (now) => (now - stepClock) / STEP_MS;

// The agreed table played forward with this copy's unheard hands, each at the
// step it was made at; `keep` is a step to take a copy at on the way.
function played(steps, keep) {
  const w = copyTable(world);
  let kept = steps - keep <= 0 ? copyTable(w) : null;
  let i = 0;
  for (let s = 0; s < steps; s++) {
    while (i < unheard.length && unheard[i].step <= w.n) hand(w, myId(), unheard[i++].input);
    w.n += 1;
    step(w);
    if (s + 1 === steps - keep) kept = copyTable(w);
  }
  while (i < unheard.length) hand(w, myId(), unheard[i++].input);
  return [kept, w];
}

function reshow() {
  lateAgreed = lateMine = null;
  if (!world) return;
  if (!PREDICT || solo()) { guessPrev = guessLast = guessTable = null; return; }
  const reachNow = Math.max(aheadSteps(), STEPS_PER_TICK);
  const [before, t] = played(reachNow, STEPS_PER_TICK);
  guessPrev = { n: before.n, t: before };
  guessLast = { n: t.n, t };
  guessTable = t;
}

// A table among `list` — [{ n, t }], in step order — as drawn at step `at`.
function walkAt(list, at) {
  let i = list.length - 1;
  while (i > 0 && list[i].n > at) i--;
  const a = list[i], b = list[i + 1] || a;
  const k = b === a ? 0 : Math.max(0, Math.min(1, (at - a.n) / (b.n - a.n)));
  return { from: a.t, to: b.t, k };
}

// The agreed table as drawn: { from, to, k }.
function agreedAt(now) {
  if (!agreed.length) return null;
  const at = stepNow(now) - SHOWN_BEHIND;
  const last = agreed[agreed.length - 1];
  if (at > last.n && world && world.n === last.n) {
    if (!lateAgreed) lateAgreed = lateFrom(last, world, PREDICT && !solo());
    const to = Math.min(at, last.n + LATE_STEPS);
    return walkAt(playOn(lateAgreed, Math.ceil(to)), to);
  }
  return walkAt(agreed, at);
}

// This copy's own piece as drawn: { from, to, k } — the agreed table where
// there is no guess to draw it from.
function mineAt(now) {
  if (!guessLast) return agreedAt(now);
  const a = guessPrev || guessLast, b = guessLast;
  const at = stepNow(now) + Math.max(reach, STEPS_PER_TICK) - STEPS_PER_TICK;
  if (at > b.n && world) {
    // The guess's last table has every hand of this copy in it already.
    if (!lateMine) lateMine = lateFrom(b, b.t, false);
    const to = Math.min(at, b.n + LATE_STEPS);
    return walkAt(playOn(lateMine, Math.ceil(to)), to);
  }
  const k = b.n === a.n ? 1 : Math.max(0, Math.min(1, (at - a.n) / (b.n - a.n)));
  return { from: a.t, to: b.t, k };
}

// ── when a tick is late ─────────────────────────────────────────────────────
// A tick that is late leaves the drawing nothing newer to walk to, and a
// drawing that stands on the newest table until the tick lands is a game that
// stops dead and then jumps — on a wire that stalls for a tenth of a second
// now and then, which is any wifi, that is several times a minute. So the
// drawing walks on into tables played forward from the newest one, every hand
// held as it stands, and this copy's own where it guesses, at the steps they
// will land at.
//
// Only the drawing walks on. The table, its fingerprints and everything that
// is decided wait for the tick as before, and `live` is off, so no effect
// comes of a table played this way: the effect comes with the tick. When the
// tick lands the walk is dropped for the truth, and the two differ only if a
// hand changed in between. That is why the walk is short: a point or a hit the
// room never agreed on is on screen for a few frames at most, and a clock that
// has stopped altogether — a host gone, a tab hidden — leaves the drawing
// standing a little ahead rather than running away from the table.
const LATE_REACH_MS = 120;
const LATE_STEPS = Math.max(1, Math.round(LATE_REACH_MS / STEP_MS));
let lateAgreed = null;                       // the walk on from the newest agreed table
let lateMine = null;                         // the walk on from the guess's last table

function lateFrom(start, tip, hands) {
  return { list: [start], tip, hands, seq: 0 };
}

// The walk taken as far as step `to`, a step at a time, each kept: a frame
// asks for the step it is at, and the walk is played once and not per frame.
function playOn(late, to) {
  const wasLive = live;
  live = false;
  try {
    while (late.list[late.list.length - 1].n < to) {
      const t = copyTable(late.tip);
      if (late.hands) {
        for (const h of unheard) {
          if (h.seq <= late.seq) continue;
          if (h.step > t.n) break;
          hand(t, myId(), h.input);
          late.seq = h.seq;
        }
      }
      t.n += 1;
      step(t);
      late.tip = t;
      late.list.push({ n: t.n, t });
    }
  } finally {
    live = wasLive;
  }
  return late.list;
}

function wireNote() {
  if (solo()) return 'solo';
  if (world && !hearsItself(performance.now()) && performance.now() - tableAt > ECHO_LOST) {
    return 'this page does not hear itself — reload it';
  }
  if (!world) return 'catching up';
  const trip = tripMs === null ? '—' : Math.round(tripMs) + ' ms';
  return (keepsClock(performance.now()) ? 'you keep the clock · ' : '') + 'trip ' + trip;
}

// ── the clock ───────────────────────────────────────────────────────────────
// Whoever keeps the clock sends the ticks; every copy, the keeper's included,
// steps the table only when a tick comes back round.
//
// The host keeps it while its page is on screen. Everybody else stands in line
// behind it in the room's order, and takes the clock over when nobody ahead of
// them has ticked for a while — the longer the further back they stand, so that
// one stand-in starts at a time — and hands it back the moment somebody ahead
// ticks again. A page out of sight keeps no clock: a browser slows the timers of
// a tab in the background to a crawl, and a clock kept there stops the game for
// everybody. The line is read off `room.players`, which is the room's own order
// and the same on every copy.
const CLOCK_SILENCE = 250;               // ms without a tick from ahead before stepping in, per place
const CLOCK_STALL = 100;                 // ms between this copy's own timers that count as a stall
const clockHeard = new Map();            // player id -> when a tick of theirs last came round
let clockBase = null;
let clockSent = 0;
let clockTo = 0;                         // the step the next tick of this copy starts from
let clockLast = 0;                       // when this copy's timer last ran
let tableAt = 0;                         // when this copy last took a table
let movedAt = 0;                         // when this copy's table last moved, or was taken

const placeOf = (id) => {
  const i = room.players.findIndex((p) => p.id === id);
  return i < 0 ? Infinity : i;
};
const onScreen = () => !(typeof document !== 'undefined' && document.visibilityState === 'hidden');

// Whether the host has ticked lately, as this copy heard it — a host out of
// sight, or gone, leaves a stand-in keeping the clock.
function hostQuiet(now) {
  if (!room.host) return true;
  const at = clockHeard.get(room.host.id);
  return at === undefined || now - at > CLOCK_SILENCE * 2;
}

function keepsClock(now) {
  if (solo()) return true;
  if (!world || !onScreen() || !hearsItself(now)) return false;
  const mine = placeOf(myId());
  if (mine === 0) return true;
  let heard = tableAt;
  for (const [id, at] of clockHeard) if (placeOf(id) < mine && at > heard) heard = at;
  return now - heard > CLOCK_SILENCE * mine;
}

setInterval(() => {
  const now = performance.now();
  const stalled = now - clockLast > CLOCK_STALL;
  clockLast = now;

  if (!world && offered && now - offered.at > HANDOVER_GRACE) takeHandover(offered.table);

  // Ticks that keep coming while the table never moves mean a table that
  // stands ahead of the room's clock — one handed over with a step number it
  // never reached — and every tick is ignored as one it has passed. Nothing
  // else would ever end that, so it is a parting like any other.
  if (world && !solo() && now - movedAt > HANDOVER_WAIT) {
    let lastTick = -Infinity;
    for (const at of clockHeard.values()) lastTick = Math.max(lastTick, at);
    if (lastTick > movedAt + HANDOVER_GRACE) parted('ticks come and the table does not move');
  }

  if (!world && !solo() && now - helloAt > HANDOVER_WAIT) {
    // Nobody handed the table over. The host starts one, and so does anybody
    // when no clock has ticked in all that time — then there is no table in
    // play to wait for, only a host that cannot hand one over. Anybody else
    // asks again.
    let lastTick = -Infinity;
    for (const at of clockHeard.values()) lastTick = Math.max(lastTick, at);
    if (isHost(myId()) || now - lastTick > HANDOVER_WAIT) adoptTable(startTable(Math.floor(Math.random() * 4294967296)));
    else askForTable();
  }

  if (world && unheard.length && now - unheard[unheard.length - 1].at > RESEND_AFTER) {
    // Never handed back means nobody got it. A repeat is not a measurement.
    sendHand(false);
  }

  // A clock that stops ticking, or stalled long enough to have been stood in
  // for, starts over from the table as it stands rather than playing back the
  // time it was away.
  if (!keepsClock(now) || stalled) {
    clockBase = null;
    if (!keepsClock(now)) return;
  }
  if (clockBase === null) {
    clockBase = now;
    clockSent = 0;
    // From where this clock already brought the table, not from where the
    // agreed table stands: the ticks it sent before a stall are still on their
    // way, and starting behind them sends ticks the table has already passed —
    // a table standing still for a trip.
    clockTo = Math.max(clockTo, world.n);
  }
  let due = Math.floor((now - clockBase) / STEP_MS) - clockSent;
  if (due < STEPS_PER_TICK) return;
  const most = STEPS_PER_TICK * TICK_BATCH;
  if (due > most) {
    clockSent += due - most;
    due = most;
  }
  clockSent += due;
  clockTo = Math.max(clockTo, world.n) + due;
  // Who leaves the table is decided here, where the clock is, and said in the
  // tick, so every copy lets them go at the same step: gone from the room, or
  // not heard from in a while.
  const here = new Set(room.players.map((p) => p.id));
  const drop = solo() ? [] : playersIn(world).filter((id) => {
    if (id < 0) return false;
    const heard = world.seen[id];
    return !here.has(id) || heard === undefined || world.n - heard > SILENT_STEPS;
  });
  emitRoom({ t: 'tick', to: clockTo, drop, hn: lastPrint, h: lastPrint === null ? null : prints.get(lastPrint) });
}, 8);

setInterval(() => {
  if (world && !unheard.length) sendHand(false);
}, HAND_EVERY);

room.on('hostchange', () => {
  clockBase = null;
});

// The host starts a table; everybody else asks for the one in play. A host
// whose disk was restarted starts a new game this way, and the others find out
// from the next tick that the clock is somewhere they are not, and ask.
if (solo() || isHost(myId())) adoptTable(startTable(Math.floor(Math.random() * 4294967296)));
else askForTable();
start();
// ═══════════════════ end of the kernel ═══════════════════
