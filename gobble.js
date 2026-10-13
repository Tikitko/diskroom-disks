/**
 * @disk     gobble
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Everyone is the chomper in one maze of dots. Eat to score, grab a berry and for a few seconds every rival is prey: bite one and half their dots spill out for anybody to grab. The further behind you are, the longer a berry lasts.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/gobble.png
 */
// gobble.js — a maze of dots where everyone is the chomper, and the room's
// order is the referee.
//
// Every copy holds the whole maze — every wall, dot, berry and spilled coin,
// how long each eaten cell has before it grows back, and every chomper — and
// changes it only on what comes back round the room, so every copy applies the
// same hands in the same order and holds the same maze. Nobody sends where
// they are, what they ate or whom they bit: a hand is the way a player wants to
// turn next, and everything else is the same arithmetic on the same whole
// numbers on every machine. A page with a console open can steer its own
// chomper however it likes, at that chomper's own speed, along the lanes the
// maze has.
//
// While a player is alone in the maze, a bot plays with them. It is part of
// the maze like any player, and its moves are a function of the maze alone, so
// it plays the same on every copy and says nothing over the wire. When a second
// player arrives, practice runs on for three seconds under a note that says
// so, and the bot leaves before the round is laid out: it never takes part in
// one.
//
// Your own chomper does not wait for the trip: it is drawn from the agreed
// maze played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — a cell is 120 units, a speed is units
// a step — and use nothing but `+ - *`, comparisons, `Math.floor`, `Math.min`,
// `Math.max`, `Math.abs` and `Math.imul`, which the language fixes to the last
// bit. Trigonometry appears only in the drawing, which is nobody's business
// but the screen's.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the maze a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own chomper a trip ahead, with your hand in it

const GW = 19, GH = 13, NC = GW * GH;   // the maze, in cells
const U = 120;                 // units a cell
const HALF = U / 2;
const W = GW * U, H = GH * U;
// The row whose two ends are one tunnel: leave it on one side and you come in
// on the other.
const TUN = 6, TROW = TUN * U + HALF;
// Speeds stay under half a cell a step, so no step carries a chomper past more
// than one middle of a cell, where it may turn.
const SPEED = 22;
const HUNT_SPEED = 27;         // a chomper full of berry is a little quicker
const CATCH = 84;              // units apart, across and along, at which a hunter bites
const POWER0 = 5 * HZ;         // steps a berry lasts for whoever leads
const POWER_RANK = HZ;         // and this much more for every player ahead of you
const POWER_MAX = 9 * HZ;
const SHIELD = Math.round(1.5 * HZ);   // steps nobody can bite a chomper just back in the maze
const OUT = Math.round(2.5 * HZ);      // steps a bitten chomper's eyes take to float home
const REGROW = 14 * HZ;        // steps until an eaten cell grows its dot back
const BERRY_BACK = 12 * HZ;    // and its berry, on a berry's cell
const BOUNTY = 5;              // what a bite is worth to the hunter
const CROWN_BOUNTY = 10;       // and a bite of whoever leads
const SPILL = 10;              // the most pieces a bitten chomper's dots spill into
const GOLD_MAX = 50;           // the most one spilled coin can hold
const LOOPS = 0.16;            // how often a wall between two rooms opens, beyond the tree
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;
const SCORE_MAX = 99999;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 80 * HZ;
const END_STEPS = 6 * HZ;
const FEAST_AT = 20 * HZ;      // steps left in a round when every dot starts counting double

// What a cell holds: nothing, a dot, a berry, or a spilled coin worth f - 2.
const EMPTY = 0, DOT = 1, BERRY = 2, GOLD = 3;
// A direction: none, up, right, down, left.
const DIRS = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];
const OPP = [0, 3, 4, 1, 2];

const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Rooms stand on the even cells; the cells between two rooms are walls the maze
// may open, and the cells between four rooms are always walls. The maze is
// laid out for the left half and mirrored onto the right, so no start is
// better placed than its twin.
const RW = 10, RH = 7, LW = 5;          // rooms across, down, and across the left half
const MID = 9;                          // the middle column, its own mirror
const isRoom = (x, y) => x % 2 === 0 && y % 2 === 0;

// Where chomper start, in the order seats are handed out: two players stand in
// opposite corners.
const SPAWNS = [[0, 0], [18, 12], [18, 0], [0, 12], [8, 12], [10, 0], [2, 6], [16, 6]];
const BERRIES = [[4, 4], [14, 4], [4, 8], [14, 8]].map(([x, y]) => y * GW + x);
const BERRY_SET = new Set(BERRIES);

// The cell next to c the way k goes, -1 off the maze; the tunnel row wraps.
function nb(c, k) {
  const x = c % GW, y = (c - x) / GW;
  let nx = x + DIRS[k][0];
  const ny = y + DIRS[k][1];
  if (ny < 0 || ny >= GH) return -1;
  if (nx < 0 || nx >= GW) {
    if (y !== TUN) return -1;
    nx = (nx + GW) % GW;
  }
  return ny * GW + nx;
}
const openTo = (w, c, k) => { const n = nb(c, k); return n >= 0 && w.m[n] === 1; };

// The maze. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   m:  each cell: 1 a lane, 0 a wall
//   f:  each cell's dot, berry or coin, as above
//   rg: steps until each eaten cell grows back, 0 when nothing is counting
//   res: the last round's [id, won, rounds won, dots, bites] rows; win: its winner
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, m: [], f: [], rg: [], p: {}, res: null, win: -1 };
  lay(w);
  return w;
}

// A new maze: a tree through the rooms of the left half, a few walls more
// knocked through so the lanes loop, no dead end anywhere, three ways across
// the middle, all of it mirrored; and a dot in every lane.
function lay(w) {
  const m = new Array(NC).fill(0);
  for (let y = 0; y < GH; y += 2) for (let x = 0; x < GW; x += 2) m[y * GW + x] = 1;
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const r = stack[stack.length - 1];
    const i = r % LW, j = (r - i) / LW;
    const opts = [];
    for (let k = 1; k <= 4; k++) {
      const a = i + DIRS[k][0], b = j + DIRS[k][1];
      if (a < 0 || b < 0 || a >= LW || b >= RH || seen.has(b * LW + a)) continue;
      opts.push([a, b]);
    }
    if (!opts.length) { stack.pop(); continue; }
    const [a, b] = opts[Math.floor(draw01(w) * opts.length)];
    m[(2 * j + (b - j)) * GW + 2 * i + (a - i)] = 1;
    seen.add(b * LW + a);
    stack.push(b * LW + a);
  }
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < MID; x++) if ((x + y) % 2 === 1 && !m[y * GW + x] && draw01(w) < LOOPS) m[y * GW + x] = 1;
  }
  const across = [];
  for (let j = 0; j < RH; j++) across.push(j);
  for (let k = 0; k < 3; k++) {
    const j = across.splice(Math.floor(draw01(w) * across.length), 1)[0];
    m[2 * j * GW + MID] = 1;
  }
  mirror(m);
  // No dead ends: a room with one way out gets a second, toward whichever
  // closed wall the draw picks.
  const t = { m };
  for (let j = 0; j < RH; j++) {
    for (let i = 0; i < LW; i++) {
      const c = 2 * j * GW + 2 * i;
      let ways = 0;
      for (let k = 1; k <= 4; k++) if (openTo(t, c, k)) ways += 1;
      if (ways > 1) continue;
      const shut = [];
      for (let k = 1; k <= 4; k++) {
        const n = nb(c, k);
        if (n >= 0 && !m[n] && nb(n, k) >= 0) shut.push(n);
      }
      if (shut.length) m[shut[Math.floor(draw01(w) * shut.length)]] = 1;
    }
  }
  mirror(m);
  w.m = m;
  w.f = m.map((v, c) => (v ? (BERRY_SET.has(c) ? BERRY : DOT) : EMPTY));
  w.rg = new Array(NC).fill(0);
}

function mirror(m) {
  for (let y = 0; y < GH; y++) for (let x = 0; x < MID; x++) m[y * GW + (GW - 1 - x)] = m[y * GW + x];
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'dr', 'wd', 'fc', 'pw', 'pm', 'sh', 'ot', 'hm', 'sc', 'bt', 'wn', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; st: 0 in the maze, 1 bitten and floating home; x, y:
//   where, in units, always on the middle line of a lane; dr: the way it is
//   going, 0 when it stands against a wall; wd: the way its hand wants to turn
//   next; fc: the way it faces; pw, pm: steps of berry left, and how many it
//   began with; sh: shield steps left; ot: steps until it is home again; hm:
//   the start it floats home to; sc: dots this round; bt: bites this round;
//   wn: rounds won; bw: the bot's pause; hs, hc: hands this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);
const cellOf = (d) => Math.floor(d.y / U) * GW + Math.floor(d.x / U);
const midX = (c) => (c % GW) * U + HALF;
const midY = (c) => Math.floor(c / GW) * U + HALF;
const spawnCell = (k) => SPAWNS[k][1] * GW + SPAWNS[k][0];

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

function newPlayer(w, wd) {
  const s = freeOf(w, 's');
  return player({
    c: freeOf(w, 'c'), s, st: 0, x: midX(spawnCell(s)), y: midY(spawnCell(s)), dr: 0, wd, fc: 3, pw: 0, pm: 0, sh: 0,
    ot: 0, hm: s, sc: 0, bt: 0, wn: 0, bw: 0, hs: w.n, hc: 0,
  });
}

// Units between two chompers, across and along; across the tunnel the short
// way round.
function apart(a, b) {
  let dx = Math.abs(a.x - b.x);
  if (a.y === TROW && b.y === TROW && dx > W / 2) dx = W - dx;
  return dx + Math.abs(a.y - b.y);
}

const hunting = (d) => d.st === 0 && d.pw > 0;

// The start a chomper comes home to: its own seat's, unless a hunter is near
// it, and then the first one no hunter is near.
function homeFor(w, id) {
  const d = w.p[id];
  const ok = (k) => {
    const c = spawnCell(k), x = midX(c), y = midY(c);
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o !== id && hunting(e) && Math.abs(e.x - x) + Math.abs(e.y - y) < 4 * U) return false;
    }
    return true;
  };
  if (ok(d.s)) return d.s;
  for (let k = 0; k < SPAWNS.length; k++) if (ok(k)) return k;
  return d.s;
}

function placeAt(d, k) {
  const c = spawnCell(k);
  d.st = 0;
  d.x = midX(c);
  d.y = midY(c);
  d.dr = 0;
  d.fc = 3;
  d.ot = 0;
}

// A hand, at its place in the room's order: the way the player wants to turn
// next, which holds until the maze lets them. Being heard is how a player
// arrives: on a start of their own, shielded a moment if a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input);
    placeAt(d, homeFor(w, id));
    if (w.ph === PLAY) d.sh = SHIELD;
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
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
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.08;         // how often it lets a decision go by
const BOT_FEAR = 6;            // cells from a hunter at which it runs
const BOT_CHASE = 12;          // cells to prey it will chase
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the maze waits for a round, and goes the moment a round
// is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    placeAt(w.p[BOT_ID], homeFor(w, BOT_ID));
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Cells of lane between `from` and every other cell, -1 where no lane leads.
function lanesFrom(w, from) {
  const dist = new Array(NC).fill(-1);
  dist[from] = 0;
  let edge = [from];
  while (edge.length) {
    const next = [];
    for (const c of edge) {
      for (let k = 1; k <= 4; k++) {
        const n = nb(c, k);
        if (n < 0 || w.m[n] !== 1 || dist[n] >= 0) continue;
        dist[n] = dist[c] + 1;
        next.push(n);
      }
    }
    edge = next;
  }
  return dist;
}

// The middle of a cell the chomper will reach next: where it can turn.
function nextTurn(d) {
  const c = cellOf(d);
  if (!d.dr) return c;
  const off = DIRS[d.dr][0] ? d.x - midX(c) : d.y - midY(c);
  const s = DIRS[d.dr][0] || DIRS[d.dr][1];
  if (off * s <= 0) return c;
  const n = nb(c, d.dr);
  return n < 0 ? c : n;
}

// Of the ways out of `at`, the one `score` likes least; the way it already
// goes when that ties, so the bot does not dither at every crossing.
function bestWay(w, d, at, score) {
  let best = 0, low = Infinity;
  for (let k = 1; k <= 4; k++) {
    if (!openTo(w, at, k)) continue;
    const v = score(nb(at, k)) + (k === d.dr ? -0.5 : 0) + (k === OPP[d.dr] ? 0.25 : 0);
    if (v < low) { low = v; best = k; }
  }
  return best;
}

function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== 0) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 4 + Math.floor(draw01(w) * 10); return; }
  const at = nextTurn(d);
  // A hunter near comes first: away from it, by lanes.
  if (d.pw === 0 && d.sh === 0) {
    const fear = [];
    for (const id of playersIn(w)) {
      const e = w.p[id];
      if (id === BOT_ID || !hunting(e)) continue;
      const dist = lanesFrom(w, cellOf(e));
      if (dist[at] >= 0 && dist[at] <= BOT_FEAR) fear.push(dist);
    }
    if (fear.length) {
      d.wd = bestWay(w, d, at, (n) => -Math.min(...fear.map((dist) => (dist[n] < 0 ? 99 : dist[n]))));
      return;
    }
  }
  const mine = lanesFrom(w, at);
  let goal = -1;
  // Full of berry: the nearest chomper it may bite, if one is near enough.
  if (d.pw > HZ) {
    let near = BOT_CHASE + 1;
    for (const id of playersIn(w)) {
      const e = w.p[id];
      if (id === BOT_ID || e.st !== 0 || e.pw > 0 || e.sh > 0) continue;
      const k = mine[cellOf(e)];
      if (k >= 0 && k < near) { near = k; goal = cellOf(e); }
    }
  }
  // Otherwise whatever is nearest, a berry or a coin counting for a few cells
  // more than a dot.
  if (goal < 0) {
    let low = Infinity;
    for (let c = 0; c < NC; c++) {
      if (!w.f[c] || mine[c] < 0) continue;
      const v = mine[c] - (w.f[c] === BERRY ? (d.pw > 0 ? -8 : 7) : w.f[c] >= GOLD ? 3 + Math.min(6, w.f[c] - 2) : 0);
      if (v < low) { low = v; goal = c; }
    }
  }
  if (goal < 0 || goal === at) return;
  const there = lanesFrom(w, goal);
  d.wd = bestWay(w, d, at, (n) => (there[n] < 0 ? 999 : there[n]));
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
    placeAt(d, homeFor(w, id));
    d.pw = d.pm = d.sh = d.sc = d.bt = 0;
  }
}

// A round: a new maze, the seats closed up in order so the starts in use are
// the first ones, everybody on their own start with nothing eaten.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  lay(w);
  const ids = bySeat(w);
  ids.forEach((id, i) => {
    const d = w.p[id];
    d.s = i;
    d.hm = i;
    placeAt(d, i);
    d.pw = d.pm = d.sh = d.sc = d.bt = d.bw = 0;
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
  const res = ids.map((id) => [id, id === w.win ? 1 : 0, w.p[id].wn, w.p[id].sc, w.p[id].bt]);
  res.sort((a, b) => b[3] - a[3] || b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, w.win);
}

function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting maze otherwise leaves at zero. The bot goes first, so
    // the round's seats close up without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === FEAST_AT) fx(w, 'feast');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) return;
  maze(w);
}

// Whoever has the most dots, alone, and any at all: the one with the crown.
function leaderOf(w) {
  let top = 0, who = -1;
  for (const id of bySeat(w)) {
    const sc = w.p[id].sc;
    if (sc > top) { top = sc; who = id; } else if (sc === top) who = -1;
  }
  return who;
}

function maze(w) {
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.sh > 0) d.sh -= 1;
    if (d.pw > 0 && --d.pw === 0) { d.pm = 0; fx(w, 'spent', cellOf(d), id); }
    if (d.st === 1) {
      if (--d.ot <= 0) {
        placeAt(d, d.hm);
        d.sh = SHIELD;
        fx(w, 'home', cellOf(d), id);
      }
      continue;
    }
    walk(w, d);
  }
  const feast = w.ph === PLAY && w.pt <= FEAST_AT;
  for (const id of ids) {
    const d = w.p[id];
    if (d.st === 0) eat(w, id, d, feast);
  }
  // Bites, in seat order: a hunter bites anybody near it who is neither full
  // of berry nor just back in the maze.
  const crown = leaderOf(w);
  for (const id of ids) {
    const h = w.p[id];
    if (!hunting(h)) continue;
    for (const o of ids) {
      const e = w.p[o];
      if (o === id || e.st !== 0 || e.pw > 0 || e.sh > 0 || apart(h, e) >= CATCH) continue;
      bite(w, id, o, o === crown);
    }
  }
  for (let c = 0; c < NC; c++) {
    if (w.rg[c] > 0 && --w.rg[c] === 0 && w.f[c] === EMPTY && w.m[c]) {
      w.f[c] = BERRY_SET.has(c) ? BERRY : DOT;
      if (w.f[c] === BERRY) fx(w, 'ripe', c);
    }
  }
}

// One step along the lanes. A chomper turns only on the middle of a cell, and
// only into a lane; it may turn right round anywhere; a wall ahead with no
// turn it wants stops it on the middle of its cell.
function walk(w, d) {
  if (d.wd && d.dr && d.wd === OPP[d.dr]) d.dr = d.wd;
  let left = d.pw > 0 ? HUNT_SPEED : SPEED;
  for (let guard = 0; guard < 4 && left > 0; guard++) {
    const c = cellOf(d), mx = midX(c), my = midY(c);
    if (d.x === mx && d.y === my) {
      if (d.wd && openTo(w, c, d.wd)) d.dr = d.wd;
      else if (d.dr && !openTo(w, c, d.dr)) d.dr = 0;
      if (!d.dr) return;
      d.fc = d.dr;
      move(d, DIRS[d.dr][0] * left, DIRS[d.dr][1] * left);
      return;
    }
    const dx = DIRS[d.dr][0], dy = DIRS[d.dr][1];
    // Off a lane's middle line, or standing between two middles: only a table
    // that came in broken does that, and it is put back on its cell.
    if (!d.dr || (dx && d.y !== my) || (dy && d.x !== mx)) { d.x = mx; d.y = my; return; }
    const off = dx ? d.x - mx : d.y - my, s = dx || dy;
    const to = off * s < 0 ? -off * s : U - off * s;
    const m = Math.min(left, to);
    move(d, dx * m, dy * m);
    left -= m;
  }
}

function move(d, ax, ay) {
  d.x += ax;
  d.y += ay;
  if (d.y === TROW) d.x = ((d.x % W) + W) % W;
  else d.x = clampi(d.x, 0, W - 1);
  d.y = clampi(d.y, 0, H - 1);
}

// Whatever lies on the cell a chomper is in. A berry is worth longer the
// further behind its eater is.
function eat(w, id, d, feast) {
  const c = cellOf(d), f = w.f[c];
  if (f === EMPTY) return;
  w.f[c] = EMPTY;
  if (f === DOT) {
    d.sc = Math.min(SCORE_MAX, d.sc + (feast ? 2 : 1));
    w.rg[c] = REGROW;
    fx(w, 'eat', c, id);
  } else if (f === BERRY) {
    let ahead = 0;
    for (const o of playersIn(w)) if (w.p[o].sc > d.sc) ahead += 1;
    d.pw = d.pm = Math.min(POWER_MAX, POWER0 + ahead * POWER_RANK);
    d.sh = 0;
    w.rg[c] = BERRY_BACK;
    fx(w, 'berry', c, id, ahead);
  } else {
    d.sc = Math.min(SCORE_MAX, d.sc + (f - 2));
    if (!w.rg[c]) w.rg[c] = REGROW;
    fx(w, 'coin', c, id, f - 2);
  }
}

// A bite: the bitten chomper's eyes float home, and half its dots spill as
// coins into the lanes round where it was, for anybody to grab.
function bite(w, id, o, crowned) {
  const h = w.p[id], e = w.p[o];
  const c = cellOf(e);
  const loss = Math.floor(e.sc / 2);
  e.sc -= loss;
  h.sc = Math.min(SCORE_MAX, h.sc + (crowned ? CROWN_BOUNTY : BOUNTY));
  h.bt += 1;
  e.st = 1;
  e.ot = OUT;
  e.pw = e.pm = 0;
  e.dr = 0;
  e.hm = homeFor(w, o);
  fx(w, 'bite', c, id, o);
  if (loss > 0) spill(w, c, loss);
}

function spill(w, from, loss) {
  const pieces = Math.min(SPILL, loss);
  const cells = [];
  const seen = new Set([from]);
  let edge = [from];
  while (edge.length && cells.length < pieces) {
    const next = [];
    for (const c of edge) {
      if (w.f[c] !== BERRY && cells.length < pieces) cells.push(c);
      for (let k = 1; k <= 4; k++) {
        const n = nb(c, k);
        if (n < 0 || w.m[n] !== 1 || seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    edge = next;
  }
  const each = Math.floor(loss / cells.length), more = loss % cells.length;
  cells.forEach((c, i) => {
    const v = each + (i < more ? 1 : 0);
    const had = w.f[c] >= GOLD ? w.f[c] - 2 : 0;
    w.f[c] = 2 + Math.min(GOLD_MAX, had + v);
  });
  fx(w, 'spill', from, cells.length);
}

// A maze handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  const cells = (a, ok) => Array.isArray(a) && a.length === NC && a.every(ok);
  if (!cells(raw.m, (v, c) => (isRoom(c % GW, Math.floor(c / GW)) ? v === 1 : v === 0 || v === 1))) return null;
  if (!cells(raw.f, (v, c) => int(v, 0, GOLD_MAX + 2) && (v === 0 || raw.m[c] === 1))) return null;
  if (!cells(raw.rg, (v) => int(v, 0, REGROW))) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, 0, 1) || !int(d.x, 0, W - 1) || !int(d.y, 0, H - 1)) return null;
    if (!int(d.dr, 0, 4) || !int(d.wd, 0, 4) || !int(d.fc, 0, 4)) return null;
    if (!int(d.pw, 0, POWER_MAX) || !int(d.pm, 0, POWER_MAX) || !int(d.sh, 0, SHIELD) || !int(d.ot, 0, OUT)) return null;
    if (!int(d.hm, 0, SPAWNS.length - 1) || !int(d.sc, 0, SCORE_MAX) || !int(d.bt, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bw, 0, 99) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
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
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, m: raw.m.slice(), f: raw.f.slice(), rg: raw.rg.slice(), p, res,
    win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed maze steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, c, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, c: c || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: an arcade after dark. Deep indigo lanes between glowing violet
// walls, warm cream dots, red berries, gold coins, and a bright colour for each
// player that is their chomper's and their chip's.
const INK = {
  page: '#17123a', glow: '#2c2272', bed: '#0e0b2a', bedEdge: '#3a2f80',
  wallOut: '#8f7bff', wall: '#3d2f9a', wallTop: '#5a48c9',
  dot: '#ffe4bd', feast: '#ffd166', berry: '#ff4a6b', berryHi: '#ffb3c1', leaf: '#5fd38a',
  coin: '#ffc93d', coinHi: '#fff1b0', coinDark: '#c98a12',
  text: '#ffffff', muted: '#cdc7f0', dim: '#8e88c0', gold: '#ffd166', danger: '#ff5a6e', prey: '#9fe6ff',
  panel: 'rgba(16,12,40,0.93)',
};
const SEAT = ['#ffd23f', '#ff5d8f', '#3fc8ff', '#7be35a', '#ff9a3c', '#c58bff', '#f2f2ff', '#25e0c0'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a3f8a;' +
  `background:#251d55;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, cs = 24, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
  // NOTE_ROOM under the maze keeps the practice note off its bottom row, where
  // two of the starts are; in a round the same strip carries your berry.
  const aw = VW - 16, ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  cs = Math.max(6, Math.min(aw / GW, ah / GH));
  ox = (VW - cs * GW) / 2;
  oy = TOP + (ah - cs * GH) / 2;
}
layout();
window.addEventListener('resize', layout);

const PX = (u) => ox + (u / U) * cs + shakeX;
const PY = (v) => oy + (v / U) * cs + shakeY;
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

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
function alpha(hex, a) {
  const c = rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

// Easing per frame, scaled to the frame's length so a fast screen and a slow
// one settle at the same pace.
let frameDt = 1 / 60, lastFrame = 0;
const per60 = (k) => 1 - Math.pow(1 - k, frameDt * 60);
const ease = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
const lerp = (a, b, k) => a + (b - a) * k;

// ── sound ──────────────────────────────────────────────────────────────────
// Made in the page from a few oscillators and a little noise. It starts on the
// first key or touch, because a browser keeps a page silent until then.
let actx = null, muted = false, noise = null, waka = 0;
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
  // The chomp: two notes, one a bite, so a run of dots sings.
  eat(feast) {
    if (!ready('eat', 70)) return;
    waka ^= 1;
    tone((waka ? 520 : 390) * (feast ? 1.25 : 1), 0.07, 'triangle', 0.07, waka ? 0.7 : 1.4);
  },
  coin() { if (ready('coin', 50)) { tone(988, 0.06, 'square', 0.04); tone(1319, 0.14, 'square', 0.04, 0, 0.05); } },
  berry() {
    if (!ready('berry', 150)) return;
    [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.1, 'square', 0.04, 0, i * 0.04));
    tone(180, 0.5, 'sawtooth', 0.04, 3);
  },
  others() { if (ready('others', 200)) tone(260, 0.35, 'sawtooth', 0.035, 2.2); },
  bite(mine) {
    if (!ready('bite', 60)) return;
    puff(0.12, 0.12, 900, 0, 1.5);
    tone(mine ? 880 : 600, 0.12, 'square', 0.06, 0.5);
    if (mine) [660, 880, 1175].forEach((f, i) => tone(f, 0.09, 'triangle', 0.07, 0, 0.08 + i * 0.05));
  },
  bitten() {
    if (!ready('bitten', 300)) return;
    tone(700, 0.6, 'triangle', 0.09, 0.2);
    puff(0.2, 0.08, 400, 0, 1);
  },
  spill() { if (ready('spill', 100)) for (let i = 0; i < 5; i++) tone(1200 + i * 140, 0.05, 'square', 0.025, 0, i * 0.03); },
  spent() { if (ready('spent', 200)) tone(620, 0.3, 'triangle', 0.06, 0.45); },
  home() { if (ready('home', 200)) [523, 784].forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, i * 0.07)); },
  warn() { if (ready('warn', 400)) [523, 659, 523, 784].forEach((f, i) => tone(f, 0.16, 'square', 0.04, 1, i * 0.13)); },
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
// fast screen and a slow one see the same sparks. Positions are maze units.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, kind }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
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
      if (b.kind === 1) b.vy += 6;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    shake *= 0.85;
    if (shake < 0.2) shake = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();      // id -> { chew, x, y, seen, gulp }
let drawFailed = false;
let mazeArt = null;           // the walls, drawn once a maze and size
let mazeKey = '';

function colourOf(t, id) {
  const d = t.p[id];
  return d ? SEAT[d.c] : '#dddddd';
}

// Where somebody stands as drawn: between two steps, and never slid across a
// jump — through the tunnel, or home again after a bite.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > U) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

function play(e, t) {
  const me = myId();
  const x = midX(e.c), y = midY(e.c);
  const feast = t.ph === PLAY && t.pt <= FEAST_AT;
  if (e.kind === 'eat') {
    if (e.a === me) {
      sound.eat(feast);
      const l = looks.get(me);
      if (l) l.gulp = 1;
    }
    if (feast) spray(x, y, 3, INK.feast, 2 * U, 0.05 * U);
  } else if (e.kind === 'coin') {
    const colour = colourOf(t, e.a);
    spray(x, y, 6, INK.coin, 3 * U, 0.06 * U);
    pop(x, y, '+' + e.b, e.a === me ? INK.coinHi : colour, e.a === me ? 16 : 12);
    if (e.a === me) sound.coin();
  } else if (e.kind === 'berry') {
    const colour = colourOf(t, e.a);
    ring(x, y, colour, 2.2 * U);
    ring(x, y, INK.berry, 1.2 * U);
    spray(x, y, 18, INK.berryHi, 6 * U, 0.08 * U);
    const secs = t.p[e.a] ? Math.round(t.p[e.a].pm / HZ) : 5;
    pop(x, y, (e.a === me ? 'hunt! ' : 'hunter! ') + secs + 's', colour, e.a === me ? 19 : 15);
    if (e.a === me) { sound.berry(); shake = Math.max(shake, 5); } else sound.others();
  } else if (e.kind === 'bite') {
    const ch = colourOf(t, e.a), cb = colourOf(t, e.b);
    spray(x, y, 26, cb, 7 * U, 0.1 * U);
    spray(x, y, 10, '#ffffff', 5 * U, 0.06 * U);
    ring(x, y, ch, 1.6 * U);
    pop(x, y, e.a === me ? 'chomp!' : e.b === me ? 'bitten!' : 'chomp!', e.b === me ? INK.danger : ch, e.a === me || e.b === me ? 20 : 15);
    if (e.b === me) { shake = Math.max(shake, 14); sound.bitten(); } else { shake = Math.max(shake, e.a === me ? 7 : 3); sound.bite(e.a === me); }
  } else if (e.kind === 'spill') {
    spray(x, y, 14, INK.coin, 6 * U, 0.07 * U, 1);
    sound.spill();
  } else if (e.kind === 'spent') {
    if (e.a === me) { pop(x, y, 'berry gone', INK.muted, 13); sound.spent(); }
  } else if (e.kind === 'home') {
    ring(x, y, colourOf(t, e.a), 1.3 * U);
    if (e.a === me) sound.home();
  } else if (e.kind === 'ripe') {
    ring(x, y, INK.berry, 0.9 * U);
  } else if (e.kind === 'feast') {
    pop(W / 2, H / 2, 'feast! dots count double', INK.feast, 22);
    sound.warn();
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

// The walls, drawn into a picture of their own whenever the maze or the size
// changes: a glowing rim, then the wall itself over it, each wall cell joined
// to the walls beside it so a run of them reads as one block.
function wallArt(t) {
  const key = t.m.join('') + '|' + cs.toFixed(2) + '|' + dpx;
  if (mazeArt && key === mazeKey) return mazeArt;
  mazeKey = key;
  const wd = Math.ceil(cs * GW + 8), ht = Math.ceil(cs * GH + 8);
  if (!mazeArt) mazeArt = document.createElement('canvas');
  mazeArt.width = Math.ceil(wd * dpx);
  mazeArt.height = Math.ceil(ht * dpx);
  const g = mazeArt.getContext('2d');
  g.setTransform(dpx, 0, 0, dpx, 0, 0);
  g.clearRect(0, 0, wd, ht);
  const wall = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH && t.m[y * GW + x] === 0;
  const layers = [[INK.wallOut, cs * 0.14], [INK.wall, cs * 0.2]];
  for (const [colour, p] of layers) {
    g.fillStyle = colour;
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        if (!wall(x, y)) continue;
        const sx = 4 + x * cs, sy = 4 + y * cs;
        g.beginPath();
        const r = Math.max(1, cs / 2 - p);
        g.arc(sx + cs / 2, sy + cs / 2, r, 0, Math.PI * 2);
        g.fill();
        if (wall(x + 1, y)) g.fillRect(sx + cs / 2, sy + p, cs, cs - 2 * p);
        if (wall(x, y + 1)) g.fillRect(sx + p, sy + cs / 2, cs - 2 * p, cs);
        if (wall(x + 1, y) && wall(x, y + 1) && wall(x + 1, y + 1)) g.fillRect(sx + cs / 2, sy + cs / 2, cs, cs);
      }
    }
  }
  // A highlight along the top edge of every wall, so they stand up off the floor.
  g.fillStyle = INK.wallTop;
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      if (!wall(x, y) || wall(x, y - 1)) continue;
      const sx = 4 + x * cs, sy = 4 + y * cs, p = cs * 0.32;
      g.fillRect(sx + (wall(x - 1, y) ? 0 : p), sy + p, cs - (wall(x - 1, y) ? 0 : p) - (wall(x + 1, y) ? 0 : p), cs * 0.1);
    }
  }
  return mazeArt;
}

function drawMaze(t, now) {
  flat();
  const x0 = PX(0), y0 = PY(0), w = cs * GW, h = cs * GH;
  ctx.fillStyle = INK.bed;
  roundRect(x0 - 6, y0 - 6, w + 12, h + 12, cs * 0.5);
  ctx.fill();
  ctx.strokeStyle = INK.bedEdge;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // The tunnel's two mouths: an opening in the frame, and an arrow through it.
  for (const side of [0, 1]) {
    const tx = side ? x0 + w + 2 : x0 - 8, ty = PY(TUN * U);
    ctx.fillStyle = INK.page;
    ctx.fillRect(tx, ty + cs * 0.12, 6, cs * 0.76);
    const k = 0.5 + 0.5 * Math.sin(now / 300);
    ctx.fillStyle = `rgba(143,123,255,${(0.25 + 0.35 * k).toFixed(3)})`;
    const ax = side ? x0 + w + 6 : x0 - 6, dir = side ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(ax + dir * cs * 0.28, ty + cs / 2);
    ctx.lineTo(ax, ty + cs * 0.3);
    ctx.lineTo(ax, ty + cs * 0.7);
    ctx.closePath();
    ctx.fill();
  }
  const art = wallArt(t);
  ctx.drawImage(art, x0 - 4, y0 - 4, art.width / dpx, art.height / dpx);
  const feast = t.ph === PLAY && t.pt <= FEAST_AT;
  const beat = feast ? 1 + 0.25 * Math.sin(now / 110) : 1;
  ctx.fillStyle = feast ? INK.feast : INK.dot;
  for (let c = 0; c < NC; c++) {
    if (t.f[c] !== DOT) continue;
    disc(PX(midX(c)), PY(midY(c)), Math.max(1.2, cs * 0.09 * beat));
    ctx.fill();
  }
  for (let c = 0; c < NC; c++) {
    const f = t.f[c];
    if (f === BERRY) drawBerry(PX(midX(c)), PY(midY(c)), c, now);
    else if (f >= GOLD) drawCoin(PX(midX(c)), PY(midY(c)), f - 2, c, now);
  }
}

function drawBerry(x, y, c, now) {
  const r = cs * 0.27 * (1 + 0.08 * Math.sin(now / 180 + c));
  ctx.fillStyle = alpha(INK.berry, 0.18 + 0.1 * Math.sin(now / 200 + c));
  disc(x, y, r * 2);
  ctx.fill();
  ctx.fillStyle = INK.berry;
  disc(x - r * 0.42, y + r * 0.2, r * 0.72);
  ctx.fill();
  disc(x + r * 0.42, y + r * 0.2, r * 0.72);
  ctx.fill();
  ctx.fillStyle = INK.berryHi;
  disc(x - r * 0.62, y - r * 0.05, r * 0.2);
  ctx.fill();
  ctx.strokeStyle = INK.leaf;
  ctx.lineWidth = Math.max(1, cs * 0.06);
  ctx.beginPath();
  ctx.moveTo(x - r * 0.42, y - r * 0.4);
  ctx.quadraticCurveTo(x, y - r * 1.3, x + r * 0.5, y - r * 1.05);
  ctx.moveTo(x + r * 0.42, y - r * 0.4);
  ctx.lineTo(x + r * 0.2, y - r * 1.1);
  ctx.stroke();
}

function drawCoin(x, y, v, c, now) {
  const r = cs * (0.17 + Math.min(0.1, v * 0.012));
  const spin = Math.abs(Math.cos(now / 260 + c));
  ctx.fillStyle = INK.coinDark;
  ctx.beginPath(); ctx.ellipse(x, y + r * 0.12, r * (0.35 + 0.65 * spin), r, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = INK.coin;
  ctx.beginPath(); ctx.ellipse(x, y, r * (0.35 + 0.65 * spin), r, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = INK.coinHi;
  ctx.beginPath(); ctx.ellipse(x - r * 0.25 * spin, y - r * 0.3, r * 0.25 * spin, r * 0.25, 0, 0, Math.PI * 2); ctx.fill();
}

// A chomper: a ball in its seat's colour with a mouth that opens and shuts
// as it moves, and an eye on the side it faces. Full of berry it glows and
// grows a little; anybody who could be bitten trembles while a hunter is out.
function drawChomper(t, id, x, y, d, me, now, scared, crowned) {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { chew: 0, x, y, seen: now, gulp: 0 }));
  const moved = Math.abs(x - look.x) + Math.abs(y - look.y);
  look.chew += moved < U ? moved / U * 9 : 0;
  look.x = x; look.y = y; look.seen = now;
  look.gulp *= 1 - per60(0.18);
  const colour = SEAT[d.c];
  const hunt = d.pw > 0;
  let sx = PX(x), sy = PY(y);
  if (scared) { sx += Math.sin(now / 23 + id) * cs * 0.03; sy += Math.cos(now / 29 + id) * cs * 0.03; }
  const r = cs * (hunt ? 0.46 : 0.38) * (1 + look.gulp * 0.08);
  if (d.sh > 0 && Math.floor(now / 80) % 2) ctx.globalAlpha = 0.45;
  if (hunt) {
    const ending = d.pw < 1.5 * HZ && Math.floor(now / 110) % 2;
    ctx.fillStyle = alpha(ending ? '#ffffff' : colour, 0.22 + 0.1 * Math.sin(now / 90));
    disc(sx, sy, r * 1.7);
    ctx.fill();
  }
  const [fx_, fy_] = DIRS[d.fc] || [1, 0];
  const face = Math.atan2(fy_, fx_ || (fy_ ? 0 : 1));
  const open = (d.dr ? 0.5 + 0.5 * Math.sin(look.chew) : 0.25) * (hunt ? 0.75 : 0.55);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(sx, sy + r * 0.9, r * 0.85, r * 0.25, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = darker(colour, 0.3);
  ctx.beginPath();
  ctx.moveTo(sx, sy + r * 0.08);
  ctx.arc(sx, sy + r * 0.08, r, face + open, face + Math.PI * 2 - open);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = hunt && d.pw < 1.5 * HZ && Math.floor(now / 110) % 2 ? '#ffffff' : colour;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.arc(sx, sy, r, face + open, face + Math.PI * 2 - open);
  ctx.closePath();
  ctx.fill();
  // Eyes sit away from the mouth: one on top facing sideways, two facing up
  // or down, set to the sides.
  const eyes = fy_
    ? [[sx - r * 0.42, sy + (fy_ < 0 ? r * 0.12 : -r * 0.4)], [sx + r * 0.42, sy + (fy_ < 0 ? r * 0.12 : -r * 0.4)]]
    : [[sx + fx_ * r * 0.1, sy - r * 0.5]];
  for (const [ex, ey] of eyes) {
    ctx.fillStyle = '#ffffff';
    disc(ex, ey, r * 0.2);
    ctx.fill();
    ctx.fillStyle = '#17123a';
    disc(ex + fx_ * r * 0.07, ey + fy_ * r * 0.07, r * 0.1);
    ctx.fill();
  }
  if (hunt) {
    // Angry brows: a hunter means it.
    ctx.strokeStyle = '#17123a';
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath();
    for (const [ex, ey] of eyes) {
      const tilt = ex < sx ? 1 : -1;
      ctx.moveTo(ex - r * 0.22, ey - r * 0.25 - tilt * r * 0.08);
      ctx.lineTo(ex + r * 0.22, ey - r * 0.25 + tilt * r * 0.08);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (scared) {
    ctx.strokeStyle = alpha(INK.prey, 0.5 + 0.3 * Math.sin(now / 60));
    ctx.lineWidth = 1.5;
    disc(sx, sy, r + 3);
    ctx.stroke();
  }
  if (d.sh > 0) {
    ctx.strokeStyle = alpha('#ffffff', 0.5 + 0.3 * Math.sin(now / 70));
    ctx.lineWidth = 2;
    disc(sx, sy, r * 1.4);
    ctx.stroke();
  }
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, r + 1.5, face + open, face + Math.PI * 2 - open);
    ctx.stroke();
  }
  let top = sy - r - 4;
  if (crowned) {
    drawCrown(sx, top - 2, Math.max(5, cs * 0.22), now);
    top -= Math.max(5, cs * 0.22) * 1.2 + 2;
  }
  const px = Math.max(9, Math.min(13, cs * 0.42));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(16,12,40,0.75)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  ctx.strokeText(label, sx, top);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, sx, top);
}

function drawCrown(x, y, s, now) {
  const bob = Math.sin(now / 240) * s * 0.1;
  ctx.fillStyle = INK.gold;
  ctx.beginPath();
  ctx.moveTo(x - s, y + bob);
  ctx.lineTo(x - s, y - s * 0.7 + bob);
  ctx.lineTo(x - s * 0.5, y - s * 0.25 + bob);
  ctx.lineTo(x, y - s * 0.95 + bob);
  ctx.lineTo(x + s * 0.5, y - s * 0.25 + bob);
  ctx.lineTo(x + s, y - s * 0.7 + bob);
  ctx.lineTo(x + s, y + bob);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = INK.berry;
  disc(x, y - s * 0.3 + bob, s * 0.16);
  ctx.fill();
}

// A bitten chomper's eyes, floating from where it was bitten to its start.
function drawEyes(t, id, d, now) {
  const look = looks.get(id);
  const c = spawnCell(d.hm), hx = midX(c), hy = midY(c);
  const from = look ? [look.x, look.y] : [hx, hy];
  const k = ease(1 - d.ot / OUT);
  const x = lerp(from[0], hx, k), y = lerp(from[1], hy, k);
  const sx = PX(x), sy = PY(y) + Math.sin(now / 120 + id) * cs * 0.05, r = cs * 0.13;
  ctx.globalAlpha = 0.85;
  for (const side of [-1, 1]) {
    ctx.fillStyle = '#ffffff';
    disc(sx + side * r * 1.3, sy, r);
    ctx.fill();
    ctx.fillStyle = SEAT[d.c];
    disc(sx + side * r * 1.3 + r * 0.3, sy, r * 0.5);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// The way your hand wants to turn next, while the maze has not let you yet: a
// small arrow ahead of your chomper, so a turn asked for early is seen waiting.
function drawWish(x, y, d, now) {
  if (!d.wd || d.wd === d.dr) return;
  const [dx, dy] = DIRS[d.wd];
  const sx = PX(x) + dx * cs * 0.75, sy = PY(y) + dy * cs * 0.75, s = cs * 0.16;
  ctx.globalAlpha = 0.55 + 0.25 * Math.sin(now / 120);
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
  for (const b of bits) {
    const k = b.life / b.max;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = b.colour;
    disc(PX(b.x), PY(b.y), (b.size / U) * cs * (1 - k * 0.5));
    ctx.fill();
  }
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = (1 - k) * 0.7;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - k) + 1;
    disc(PX(r.x), PY(r.y), (r.r / U) * cs * ease(k));
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
    ctx.strokeStyle = 'rgba(16,12,40,0.85)';
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
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + (t.pt <= FEAST_AT ? ' · feast!' : '');
    if (t.pt <= FEAST_AT) colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('gobble', 12, 22, titlePx, SEAT[0], 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('gobble').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with dots this round
  // and rounds won; a hunter's chip glows, a bitten one's dot is hollow.
  const ids = bySeat(t);
  const crown = t.ph === WAIT || t.ph === PLAY ? leaderOf(t) : -1;
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = d.pw > 0 ? alpha(c, 0.3 + 0.12 * Math.sin(now / 90)) : mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      disc(x + 11, y - 2, 5);
      if (d.st === 0) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      const score = String(d.sc) + (d.wn && cw > 60 ? ' ★' + d.wn : '');
      ctx.font = font(12);
      const sw = Math.min(cw - 24, ctx.measureText(score).width);
      fitText(score, x + cw - 8, y + 3, 12, id === crown ? INK.gold : INK.text, cw - 24, 'right');
      if (cw > 56) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'swipe to turn · eat dots · a berry makes rivals prey · bite to spill their dots'
    : 'arrows/WASD or drag to turn · a berry makes rivals prey · bite to spill their dots · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// Your berry, while a round is on, in the strip under the maze: a bar that
// runs down, or a word on what to do.
function drawMine(t, now) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT || t.ph === END) return;
  flat();
  const y = PY(H) + 6 + NOTE_ROOM / 2 - 6 - shakeY;
  if (d.st === 1) { fitText('bitten · your eyes float home', VW / 2, y + 5, 13, INK.muted, VW - 24); return; }
  if (d.pw > 0) {
    const w = Math.min(260, VW - 60), k = d.pw / Math.max(1, d.pm);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(VW / 2 - w / 2, y - 7, w, 14, 7);
    ctx.fill();
    ctx.fillStyle = d.pw < 1.5 * HZ && Math.floor(now / 110) % 2 ? '#ffffff' : SEAT[d.c];
    roundRect(VW / 2 - w / 2, y - 7, Math.max(14, w * k), 14, 7);
    ctx.fill();
    fitText('hunt! ' + (d.pw / HZ).toFixed(1) + 's', VW / 2, y + 4, 11, '#17123a', w - 10);
    return;
  }
  let hunters = 0;
  for (const id of playersIn(t)) if (id !== myId() && hunting(t.p[id])) hunters += 1;
  if (hunters) fitText('a hunter is out · run, or grab a berry yourself', VW / 2, y + 5, 13, INK.prey, VW - 24);
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
  const top = PY(0) - 6 - shakeY, bottom = PY(H) + 6 - shakeY;
  const cx = VW / 2, cy = (top + bottom) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'grab a berry and chase the bot · bite it and its dots spill out';
    practiceNote(now, VW, head, tip, [[TOP, top - 4], [bottom + 4, VH - BOT]], Math.min(bottom, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(16,12,40,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, cy + big);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, cy + big * 2.1, Math.min(VW - 32, 320), 30);
    fitText('most dots when the time is up takes the round', cx, cy + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 300));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(16,12,40,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('go!', cx, cy + big * 0.5);
    text('go!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 340), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, cy + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody ate the most';
    else head = t.win === me ? 'you win the round!' : nickOf(t.win) + ' wins the round';
    const y0 = cy + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('dots', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('bites', cx + w / 2 - 64, y0 + 52, 10, INK.dim, 'right');
    text('rounds', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, won, wins, dots, bites], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (won ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(dots), cx + w / 2 - 110, y, 14, INK.text, 'right');
      text(String(bites), cx + w / 2 - 64, y, 14, INK.text, 'right');
      text(String(wins), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Your own chomper is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a turn a step away from
// where the guess had it. So the chomper drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a trip through the tunnel, a return home — puts it there at
// once. Only the drawing is smoothed: the maze, and every rule in it, are
// untouched.
const PULL = 0.45;
let shown = null;        // [x, y] in units: where your chomper is drawn

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > U * 0.9) return (shown = [x, y]);
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
    text('catching up with the maze…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a maze this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const me = myId();
  const m = mineAt(now);
  // The dots your own chomper has eaten in the guess are gone at once, rather
  // than a trip after your mouth passed them.
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own && own !== b) {
    const f = t.f.slice();
    for (let c = 0; c < NC; c++) if (own.to.f[c] === EMPTY && f[c] === DOT) f[c] = EMPTY;
    drawMaze(Object.assign({}, t, { f }), now);
  } else drawMaze(t, now);
  const hunters = playersIn(t).filter((id) => hunting(t.p[id])).length;
  const crown = t.ph === WAIT || t.ph === PLAY ? leaderOf(t) : -1;
  const scared = (d) => hunters > (d.pw > 0 ? 1 : 0) && d.pw === 0 && d.sh === 0;
  const later = [];
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st === 1) { later.push(() => drawEyes(t, id, d, now)); continue; }
    const p = bodyAt(b, id);
    later.push(() => drawChomper(t, id, p[0], p[1], p[2], false, now, scared(d), id === crown));
  }
  if (own) {
    const d = own.to.p[me];
    if (d.st === 0) {
      const p = bodyAt(own, me);
      const [x, y] = settle(p[0], p[1]);
      later.push(() => { drawWish(x, y, d, now); drawChomper(t, me, x, y, d, true, now, scared(d), me === crown); });
    } else {
      shown = null;
      later.push(() => drawEyes(t, me, d, now));
    }
  } else shown = null;
  for (const f of later) f();
  for (const [id, look] of looks) if (now - look.seen > 4000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way to turn next. It holds in the maze until a lane
// lets the chomper take it, so a turn asked for a little early is not lost. A
// change goes out at once, but no oftener than TURN_EVERY while it keeps
// changing, because a thumb sweeping about changes it on every move the screen
// reports and the clock's ticks share the same seat's ceiling on messages.
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
const KEY_DIR = { ArrowUp: 1, KeyW: 1, ArrowRight: 2, KeyD: 2, ArrowDown: 3, KeyS: 3, ArrowLeft: 4, KeyA: 4 };
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (!(e.code in KEY_DIR)) return;
  e.preventDefault();
  coarse = false;
  push(KEY_DIR[e.code]);
});

// A thumb or a mouse: a drag turns the chomper the way it goes, measured from
// where the last turn was read, so one long drag can steer round several
// corners. Bound to the canvas and captured there, because iOS keeps a long
// press inside a frame for itself.
const SWIPE = 14;
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
  const dx = drag.x - drag.ox, dy = drag.y - drag.oy;
  if (Math.hypot(dx, dy) < SWIPE) return;
  push(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 4) : dy > 0 ? 3 : 1);
  drag.ox = drag.x;
  drag.oy = drag.y;
});
function lift(e) {
  if (drag && e.pointerId === drag.id) drag = null;
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);
addEventListener('blur', () => { drag = null; });

// Where the drag started, and the way it last turned, under the thumb.
function drawDrag() {
  if (!drag) return;
  flat();
  const r = cv.getBoundingClientRect();
  const x = drag.ox - r.left, y = drag.oy - r.top;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1.5;
  disc(x, y, 22);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  disc(x + Math.max(-16, Math.min(16, drag.x - drag.ox)), y + Math.max(-16, Math.min(16, drag.y - drag.oy)), 9);
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
// a player arrives in the maze.
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
