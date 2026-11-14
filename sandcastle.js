/**
 * @disk     sandcastle
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Sandcastles against the tide. Dig sand from the dunes, stand still to pour a wall, walk into your castle to raise a tower. Every wave that leaves your castle dry pays a point a tower, and rivals dig through your walls to steal sand and towers.
 * @tags     game, party, realtime, building, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/sandcastle.png
 */
// sandcastle.js — a beach where everybody builds against the same sea, and the
// room's order is the referee.
//
// Every copy holds the whole beach — the dunes, every heap of sand and whose it
// is, every castle and its towers, the wave on its way and how far it has run
// up the sand — and changes it only on what comes back round the room, so every
// copy applies the same hands in the same order and holds the same beach.
// Nobody sends where they are, what they dug or what a wave did: a hand is the
// way a player wants to walk, and everything else is the same arithmetic on the
// same whole numbers on every machine. A page with a console open can walk its
// own builder however it likes, one cell at a time at that builder's own pace.
//
// While a player is alone on the beach, a bot builds with them. It is part of
// the beach like any player, and its moves are a function of the beach alone,
// so it plays the same on every copy and says nothing over the wire. When a
// second player arrives, practice runs on for three seconds under a note that
// says so, and the bot leaves before the round is laid out: it never takes part
// in one.
//
// Your own builder does not wait for the trip: it is drawn from the agreed
// beach played forward by the trip, with your hand already in it, and so is the
// sand right round it.
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
const HZ = 20;                 // steps of the beach a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own builder a trip ahead, with your hand in it

// The beach, in cells: dunes along the top, the sea along the bottom, and the
// castles in one row between, all the same distance from the water.
const GW = 20, GH = 15, NC = GW * GH;
const DUNE_ROWS = 2;           // rows 0 and 1 are dunes
const SEA_Y = 13;              // rows 13 and 14 are the sea
const CASTLE_Y = 7;            // the row every castle stands in

const MOVE = 4;                // steps a builder takes to walk one cell
const MOVE_FAST = 3;           // the same for whoever trails the leader far enough
const DIG = 5;                 // steps of leaning on sand to dig one scoop of it
const DIG_FAST = 4;
const RAID = 10;               // steps of leaning on a rival's castle to knock a tower off it
const STILL = 3;               // steps a builder stands before the first pour
const POUR = 4;                // steps between one pour and the next
const BUCKET = 3;              // scoops a bucket holds
const BUCKET_FAST = 5;         // for whoever trails the leader far enough
const BEHIND = 8;              // points behind the leader at which a builder is quicker
const WALL_MAX = 3;            // the tallest a heap of sand stands
const DUNE_MAX = 3;
const TOWER_MAX = 8;
const REGROW = 4;              // steps between one scoop of sand blown back onto the dunes and the next
const SWEPT = 24;              // steps a builder the sea knocks over lies there
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;
const SCORE_MAX = 99999;

// The sea. A swell shows on the water WARN steps before it runs up the beach,
// strongest at one column; it runs a cell every FLOW steps, paying for every
// cell it crosses, and once it has run as far as it can it stands HOLD steps
// before it goes back and every castle it left dry is paid.
const FIRST_WAVE = 8 * HZ;
const WAVE_EVERY = 10 * HZ;    // steps from one wave going back to the next running up
const STORM_EVERY = 6 * HZ;    // and in the storm
const WARN = 3 * HZ;
const FLOW = 2;
const WAVE_MAX = 40;           // steps the most a wave runs for
const HOLD = 12;
const WATER_MAX = 40;          // the most strength the sea can hold in a cell

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 120 * HZ;
const END_STEPS = 6 * HZ;
const STORM_AT = 32 * HZ;      // steps left in a round when the storm comes and every wave pays double

// A direction: none, up, right, down, left.
const DIRS = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];

const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const at = (x, y) => y * GW + x;
const onBeach = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH;
const isDune = (y) => y < DUNE_ROWS;
const isSea = (y) => y >= SEA_Y;
const NEUTRAL = 9;             // the owner of a heap whose builder has left

// Where a castle is put when nobody else has one nearer, in order: two players
// stand well apart, and the rest fill in between.
// A castle never stands in a corner column, where a wall could not ring it.
const PREFER = [6, 13, 2, 17, 9, 15, 4, 11, 1, 18, 7, 12, 3, 16, 5, 14, 8, 10];

// The beach. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   h:  each cell: how high its sand stands, dunes and heaps alike
//   o:  each cell of open sand: whose heap it is — a seat and one, NEUTRAL for
//       one whose builder has left, 0 for none
//   fl: each cell while a wave runs: the strength the water has left there, 0
//       dry, -1 dry where the water has already worn the sand down
//   wt: steps until the next wave runs up; wp: its strength at each column
//       once it shows on the water, otherwise all 0; wf: steps it has run, -1
//       when it is not running; wh: steps it stands before going back, -1
//       when it is not standing; wv: waves this round
//   res: the last round's [id, won, rounds won, points, waves kept] rows; win: its winner
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, h: [], o: [], fl: [], wt: FIRST_WAVE, wp: [], wf: -1, wh: -1, wv: 0,
    p: {}, res: null, win: -1,
  };
  lay(w);
  return w;
}

// A fresh beach: full dunes, open sand, a calm sea.
function lay(w) {
  w.h = new Array(NC).fill(0);
  w.o = new Array(NC).fill(0);
  w.fl = new Array(NC).fill(0);
  for (let y = 0; y < DUNE_ROWS; y++) for (let x = 0; x < GW; x++) w.h[at(x, y)] = DUNE_MAX;
  w.wt = FIRST_WAVE;
  w.wp = new Array(GW).fill(0);
  w.wf = -1;
  w.wh = -1;
  w.wv = 0;
}

const FIELDS = ['c', 's', 'kx', 'tw', 'kf', 'x', 'y', 'fx', 'fy', 'mc', 'mt', 'fc', 'wd', 'q', 'dz', 'sd', 'dg', 'st',
  'sc', 'sv', 'wn', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; kx: the column of its castle; tw: the castle's towers;
//   kf: 1 when this wave has reached the castle; x, y: the cell it stands in;
//   fx, fy: the cell it is walking from, mc of mt steps still to go; fc: the
//   way it faces; wd: the way its hand wants to walk; q: one step asked for by
//   a tap, taken even if the key is up by then; dz: steps it lies knocked
//   over; sd: scoops in its bucket; dg: steps it has leant on what it digs;
//   st: steps it has stood still; sc: points this round; sv: waves its castle
//   kept dry this round; wn: rounds won; bw: the bot's pause; hs, hc: hands
//   this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// The player whose castle stands in a cell, or null.
function castleAt(w, c) {
  const x = c % GW;
  if (c - x !== CASTLE_Y * GW) return null;
  for (const id of playersIn(w)) if (w.p[id].kx === x) return id;
  return null;
}

// Whether a builder may stand in a cell: open sand, a dug-out dune, or a heap
// of its own — a builder walks over what it built and nobody else does.
function walkable(w, d, x, y) {
  if (!onBeach(x, y) || isSea(y)) return false;
  const c = at(x, y);
  if (castleAt(w, c) !== null) return false;
  if (w.h[c] === 0) return true;
  return !isDune(y) && w.o[c] === d.s + 1;
}

// The column for a new castle: as far from every other castle as the row
// allows, the earlier in PREFER on a tie.
function castleSpot(w) {
  const taken = playersIn(w).map((id) => w.p[id].kx);
  let best = PREFER[0], far = -1;
  for (const x of PREFER) {
    if (taken.includes(x)) continue;
    let near = BIG;
    for (const k of taken) near = Math.min(near, Math.abs(k - x));
    if (near > far) { far = near; best = x; }
  }
  return best;
}

// A castle's cell is cleared of whatever sand stood there.
function raise(w, d) {
  const c = at(d.kx, CASTLE_Y);
  w.h[c] = 0;
  w.o[c] = 0;
}

function newPlayer(w, wd) {
  const s = freeOf(w, 's');
  const kx = castleSpot(w);
  return player({
    c: freeOf(w, 'c'), s, kx, tw: 0, kf: 0, x: kx, y: CASTLE_Y - 1, fx: kx, fy: CASTLE_Y - 1, mc: 0, mt: MOVE, fc: 3,
    wd, q: 0, dz: 0, sd: 0, dg: 0, st: 0, sc: 0, sv: 0, wn: 0, bw: 0, hs: w.n, hc: 0,
  });
}

// Somebody is placed just behind their own castle, on the land side, or on
// the nearest cell to it they may stand in.
function placeAt(w, id) {
  const d = w.p[id];
  raise(w, d);
  let sx = d.kx, sy = CASTLE_Y - 1;
  if (!walkable(w, d, sx, sy)) {
    let best = null, low = BIG;
    for (let y = 0; y < SEA_Y; y++) for (let x = 0; x < GW; x++) {
      if (!walkable(w, d, x, y)) continue;
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
  d.dz = d.dg = d.st = 0;
}

// A hand, at its place in the room's order: the way the player wants to walk,
// held until it changes. A new way asked for is also kept as one step, so a
// tap shorter than a step still moves a cell. Being heard is how a player
// arrives: with a castle of their own, standing behind it.
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

// Somebody gone leaves their heaps on the beach, nobody's now: anybody may dig
// them and nobody walks over them. Their castle goes with them.
function leave(w, id) {
  const d = w.p[id];
  if (d) for (let c = 0; c < NC; c++) if (w.o[c] === d.s + 1) w.o[c] = NEUTRAL;
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.05;         // how often it lets a decision go by and dawdles
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the beach waits for a round, and goes the moment a round
// is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    placeAt(w, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Steps of sand between `from` and every other cell this builder may stand
// in; -1 where no way leads.
function walksFrom(w, d, from) {
  const dist = new Array(NC).fill(-1);
  dist[from] = 0;
  let edge = [from];
  while (edge.length) {
    const next = [];
    for (const c of edge) {
      const x = c % GW, y = (c - x) / GW;
      for (let k = 1; k <= 4; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
        if (!walkable(w, d, nx, ny)) continue;
        const n = at(nx, ny);
        if (dist[n] >= 0) continue;
        dist[n] = dist[c] + 1;
        next.push(n);
      }
    }
    edge = next;
  }
  return dist;
}

// The way to walk from where the bot stands toward a cell, by the walk from
// that cell back; 0 when it is there or no way leads.
function wayTo(w, d, goal) {
  if (at(d.x, d.y) === goal) return 0;
  const there = walksFrom(w, d, goal);
  let way = 0, near = BIG;
  for (let k = 1; k <= 4; k++) {
    const nx = d.x + DIRS[k][0], ny = d.y + DIRS[k][1];
    if (!walkable(w, d, nx, ny)) continue;
    const v = there[at(nx, ny)];
    if (v >= 0 && v < near) { near = v; way = k; }
  }
  return way;
}

// The bot fills its bucket at the nearest dune, now and then from a rival's
// castle, and rings its own castle with walls before it builds towers: the
// three cells the sea comes at first, then the one behind against raiders,
// higher when a wave shows or the storm is on.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.bw > 0) { d.bw -= 1; d.wd = 0; return; }
  // It thinks once a cell, as it arrives, so it never walks past where it
  // meant to turn; standing, every few steps.
  if (d.dz > 0 || d.mc > 1 || (d.mc === 0 && w.n % BOT_EVERY !== 0)) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 6 + Math.floor(draw01(w) * 14); d.wd = 0; return; }
  const here = at(d.x, d.y);
  const mine = walksFrom(w, d, here);
  const cap = bucketOf(w, d);
  // Somewhere to dig: a cell to stand in, and the way to lean from it.
  const digAt = () => {
    let best = null, low = BIG;
    for (let c = 0; c < NC; c++) {
      const x = c % GW, y = (c - x) / GW;
      let worth = 0;
      if (isDune(y) && w.h[c] > 0) worth = 1;
      else {
        const k = castleAt(w, c);
        if (k !== null && k !== BOT_ID && w.p[k].tw >= 3) worth = 2;
      }
      if (!worth) continue;
      for (let k = 1; k <= 4; k++) {
        const sx = x - DIRS[k][0], sy = y - DIRS[k][1];
        if (!walkable(w, d, sx, sy)) continue;
        const reach = mine[at(sx, sy)];
        if (reach < 0) continue;
        const v = reach - (worth === 2 ? 3 : 0);
        if (v < low) { low = v; best = { stand: at(sx, sy), dir: k }; }
      }
    }
    return best;
  };
  const lean = (spot) => {
    if (!spot) { d.wd = 0; return; }
    d.wd = here === spot.stand ? spot.dir : wayTo(w, d, spot.stand);
  };
  // Leaning on a dune or a rival's castle already, it stays until the bucket
  // is full.
  let leaning = false;
  if (d.wd) {
    const ax = d.x + DIRS[d.wd][0], ay = d.y + DIRS[d.wd][1];
    if (onBeach(ax, ay) && !isSea(ay)) {
      const k = castleAt(w, at(ax, ay));
      leaning = (isDune(ay) && w.h[at(ax, ay)] > 0) || (k !== null && k !== BOT_ID && w.p[k].tw > 0);
    }
  }
  if (leaning && d.sd < cap) return;
  if (d.sd === 0) { lean(digAt()); return; }
  // A bucket with sand in it: the lowest wall round the castle that wants to
  // be higher, or the castle itself.
  const want = w.wp.some((v) => v > 0) || rushOn(w) ? 3 : 2;
  const ring = [[d.kx, CASTLE_Y + 1, 0], [d.kx - 1, CASTLE_Y, 0], [d.kx + 1, CASTLE_Y, 0], [d.kx, CASTLE_Y - 1, 1]];
  let goal = -1, low = BIG;
  for (const [x, y, back] of ring) {
    if (!walkable(w, d, x, y)) continue;
    const c = at(x, y);
    if (w.fl[c] > 0 || w.h[c] >= want - back) continue;
    const v = w.h[c] * 4 + back * 3 + Math.max(0, mine[c]);
    if (mine[c] >= 0 && v < low) { low = v; goal = c; }
  }
  if (goal >= 0) { d.wd = wayTo(w, d, goal); return; }
  // Towers: lean on the castle from whichever side is nearest.
  let spot = null, near = BIG;
  for (let k = 1; k <= 4; k++) {
    const sx = d.kx - DIRS[k][0], sy = CASTLE_Y - DIRS[k][1];
    if (!walkable(w, d, sx, sy)) continue;
    const reach = mine[at(sx, sy)];
    if (reach >= 0 && reach < near) { near = reach; spot = { stand: at(sx, sy), dir: k }; }
  }
  if (d.tw >= TOWER_MAX) spot = null;
  lean(spot);
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
    d.tw = d.kf = d.sd = d.sc = d.sv = 0;
    placeAt(w, id);
  }
}

// A round: a fresh beach, the seats closed up in order and the castles spread
// evenly along their row, everybody behind their own with nothing built.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  lay(w);
  const ids = bySeat(w);
  const n = ids.length;
  ids.forEach((id, i) => {
    const d = w.p[id];
    d.s = i;
    d.kx = Math.floor(((2 * i + 1) * GW) / (2 * n));
  });
  ids.forEach((id) => {
    const d = w.p[id];
    d.tw = d.kf = d.sd = d.sc = d.sv = d.bw = d.q = 0;
    placeAt(w, id);
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
  const res = ids.map((id) => [id, id === w.win ? 1 : 0, w.p[id].wn, w.p[id].sc, w.p[id].sv]);
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
    // which a waiting beach otherwise leaves at zero. The bot goes first, so
    // the round's seats close up without it.
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
      if (w.pt === STORM_AT) fx(w, 'storm');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody moves and the sea waits while a round is counted in or its result
  // is up.
  if (w.ph === COUNT || w.ph === END) return;
  beach(w);
}

const rushOn = (w) => w.ph === PLAY && w.pt <= STORM_AT;

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
const trails = (w, d) => topOf(w) - d.sc >= BEHIND;
const bucketOf = (w, d) => (trails(w, d) ? BUCKET_FAST : BUCKET);

function beach(w) {
  botThink(w);
  const ids = bySeat(w);
  const top = topOf(w);
  for (const id of ids) {
    const d = w.p[id];
    const quick = top - d.sc >= BEHIND;
    if (d.dz > 0) d.dz -= 1;
    if (d.mc > 0) d.mc -= 1;
    if (d.mc > 0 || d.dz > 0) { d.dg = 0; d.st = 0; continue; }
    const dir = d.wd || d.q;
    d.q = 0;
    if (dir) { d.st = 0; walk(w, id, d, dir, quick); continue; }
    d.dg = 0;
    d.st = Math.min(d.st + 1, 999);
    if (d.st >= STILL && (d.st - STILL) % POUR === 0) pour(w, id, d);
  }
  if (w.n % REGROW === 0) {
    const c = Math.floor(draw01(w) * GW * DUNE_ROWS);
    if (w.h[c] < DUNE_MAX) w.h[c] += 1;
  }
  sea(w);
}

// A builder standing still pours a scoop under its own feet, onto open sand or
// a heap of its own, until the heap stands as high as sand stands. The bot
// dawdling is not standing still to build.
function pour(w, id, d) {
  if (d.sd <= 0 || isDune(d.y) || d.bw > 0) return;
  const c = at(d.x, d.y);
  if (w.fl[c] > 0 || w.h[c] >= WALL_MAX) return;
  if (w.h[c] > 0 && w.o[c] !== d.s + 1) return;
  w.h[c] += 1;
  w.o[c] = d.s + 1;
  d.sd -= 1;
  fx(w, 'pour', d.x, d.y, id, w.h[c]);
}

// One step of a builder's walk: into a cell it may stand in, or else leaning on
// what is there. Leaning on a dune or a rival's heap digs it a scoop at a time
// into the bucket; leaning on its own castle with sand in the bucket raises a
// tower; leaning on a rival's castle knocks a tower off it into the bucket.
function walk(w, id, d, dir, quick) {
  if (d.fc !== dir) d.dg = 0;
  d.fc = dir;
  const [dx, dy] = DIRS[dir];
  const nx = d.x + dx, ny = d.y + dy;
  if (!onBeach(nx, ny) || isSea(ny)) { d.dg = 0; return; }
  const c = at(nx, ny);
  const cap = quick ? BUCKET_FAST : BUCKET;
  const k = castleAt(w, c);
  if (k !== null) {
    const e = w.p[k];
    d.dg += 1;
    if (k === id) {
      if (d.dg < POUR) return;
      d.dg = 0;
      if (d.sd <= 0 || e.tw >= TOWER_MAX) return;
      e.tw += 1;
      d.sd -= 1;
      fx(w, 'tower', nx, ny, id, e.tw);
      return;
    }
    if (d.dg < RAID) return;
    d.dg = 0;
    if (e.tw <= 0 || d.sd >= cap) return;
    e.tw -= 1;
    d.sd += 1;
    fx(w, 'raid', nx, ny, id, k);
    return;
  }
  if (!walkable(w, d, nx, ny)) {
    // Sand somebody else may own, or a dune: dug a scoop at a time. A full
    // bucket still knocks a rival's heap down, but a dune is left alone.
    if (isDune(ny) && d.sd >= cap) { d.dg = 0; return; }
    d.dg += 1;
    if (d.dg < (quick ? DIG_FAST : DIG)) return;
    d.dg = 0;
    const was = w.o[c];
    w.h[c] -= 1;
    if (w.h[c] === 0) w.o[c] = 0;
    if (d.sd < cap) d.sd += 1;
    fx(w, isDune(ny) ? 'scoop' : 'dig', nx, ny, id, was);
    return;
  }
  d.dg = 0;
  d.fx = d.x; d.fy = d.y;
  d.x = nx; d.y = ny;
  d.mc = d.mt = quick ? MOVE_FAST : MOVE;
}

// The sea: a swell counted in, shown on the water, run up the beach, stood and
// paid for.
function sea(w) {
  if (w.wf >= 0) {
    w.wf += 1;
    if (w.wf % FLOW === 0) {
      const moved = flow(w);
      if (!moved || w.wf >= WAVE_MAX) { w.wf = -1; w.wh = HOLD; }
    }
    return;
  }
  if (w.wh >= 0) {
    w.wh -= 1;
    if (w.wh < 0) ebb(w);
    return;
  }
  // No swell starts that could not run and be paid before the round is over.
  if (w.wt === WARN + 1 && w.ph === PLAY && w.pt < WARN + WAVE_MAX + HOLD + 4) return;
  if (w.wt > 0) w.wt -= 1;
  if (w.wt === WARN) swell(w);
  if (w.wt === 0) {
    w.wf = 0;
    for (let x = 0; x < GW; x++) for (let y = SEA_Y; y < GH; y++) w.fl[at(x, y)] = w.wp[x];
    fx(w, 'wave');
  }
}

// The next wave, on the water: strongest at one column and weaker a step a
// column either side of it. Half the time it heads for whoever leads, give or
// take a couple of columns; the storm's are stronger and wider.
function swell(w) {
  const storm = rushOn(w);
  const lead = leaderOf(w);
  let mid;
  if (lead !== -1 && draw01(w) < 0.5) mid = clampi(w.p[lead].kx + Math.floor(draw01(w) * 5) - 2, 0, GW - 1);
  else mid = Math.floor(draw01(w) * GW);
  const base = storm ? 5 : 3 + Math.floor(draw01(w) * 2);
  const amp = storm ? 8 + Math.floor(draw01(w) * 3) : 6 + Math.floor(draw01(w) * 3);
  for (let x = 0; x < GW; x++) w.wp[x] = base + Math.max(0, amp - Math.abs(x - mid));
  fx(w, 'swell', mid, SEA_Y, base + amp);
}

// One cell further up the beach. Water steps from a wet cell into a dry one
// beside it and pays for it: one for open sand, three more for every scoop of
// a heap standing there. A heap the water touches is worn down by a scoop once
// a wave; one it gets over is washed away. A castle it reaches loses half its
// towers, and a builder it reaches is knocked over and spills its bucket.
// Every cell is decided from the water as it stood before this step, so the
// order the cells are visited in changes nothing.
function flow(w) {
  const fl = w.fl, next = fl.slice();
  let moved = false;
  for (let y = 0; y < SEA_Y; y++) {
    for (let x = 0; x < GW; x++) {
      const c = at(x, y);
      if (fl[c] > 0) continue;
      let m = 0;
      for (let k = 1; k <= 4; k++) {
        const ax = x + DIRS[k][0], ay = y + DIRS[k][1];
        if (onBeach(ax, ay)) m = Math.max(m, fl[at(ax, ay)]);
      }
      if (m < 2) continue;
      const k = castleAt(w, c);
      const hh = k === null ? w.h[c] : 0;
      const cost = 1 + 3 * hh;
      if (fl[c] === 0 && hh > 0) {
        w.h[c] = hh - 1;
        if (w.h[c] === 0) w.o[c] = 0;
        next[c] = -1;
        moved = true;
        fx(w, 'wear', x, y, hh - 1);
      }
      if (m - cost > 0) {
        next[c] = Math.min(WATER_MAX, m - cost);
        moved = true;
        if (hh > 0) { w.h[c] = 0; w.o[c] = 0; fx(w, 'wash', x, y); }
        if (k !== null && !w.p[k].kf) {
          const d = w.p[k];
          d.kf = 1;
          const lost = d.tw - (d.tw >> 1);
          d.tw >>= 1;
          fx(w, 'flood', x, y, k, lost);
        }
      }
    }
  }
  w.fl = next;
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d.dz > 0 || next[at(d.x, d.y)] <= 0) continue;
    d.dz = SWEPT;
    const spilt = d.sd;
    d.sd = 0;
    d.dg = d.st = 0;
    fx(w, 'swept', d.x, d.y, id, spilt);
  }
  return moved;
}

// The wave goes back, and every castle it left dry is paid a point a tower,
// two in the storm.
function ebb(w) {
  const twice = rushOn(w) ? 2 : 1;
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d.kf) { d.kf = 0; continue; }
    d.sv = Math.min(SCORE_MAX, d.sv + 1);
    if (d.tw <= 0) continue;
    const v = d.tw * twice;
    d.sc = Math.min(SCORE_MAX, d.sc + v);
    fx(w, 'safe', d.kx, CASTLE_Y, id, v);
  }
  w.fl = new Array(NC).fill(0);
  w.wp = new Array(GW).fill(0);
  w.wv = Math.min(BIG, w.wv + 1);
  w.wt = rushOn(w) ? STORM_EVERY : WAVE_EVERY;
  fx(w, 'ebb');
}

// A beach handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ints = (a, n, lo, hi) => Array.isArray(a) && a.length === n && a.every((v) => int(v, lo, hi));

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!ints(raw.h, NC, 0, DUNE_MAX) || !ints(raw.o, NC, 0, NEUTRAL) || !ints(raw.fl, NC, -1, WATER_MAX)) return null;
  for (let c = 0; c < NC; c++) {
    const x = c % GW, y = (c - x) / GW;
    if (isSea(y) && raw.h[c] !== 0) return null;
    if ((isDune(y) || isSea(y)) && raw.o[c] !== 0) return null;
    if (!isDune(y) && !isSea(y) && (raw.o[c] > 0) !== (raw.h[c] > 0)) return null;
  }
  if (!int(raw.wt, 0, Math.max(FIRST_WAVE, WAVE_EVERY)) || !ints(raw.wp, GW, 0, WATER_MAX)) return null;
  if (!int(raw.wf, -1, WAVE_MAX) || !int(raw.wh, -1, HOLD) || !int(raw.wv, 0, BIG)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set(), castles = new Set();
  const near = (a, b, x, y) => Math.abs(a - x) + Math.abs(b - y) <= 1;
  const cell = (x, y) => int(x, 0, GW - 1) && int(y, 0, SEA_Y - 1);
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.kx, 1, GW - 2) || castles.has(d.kx) || raw.h[at(d.kx, CASTLE_Y)] !== 0) return null;
    if (!int(d.tw, 0, TOWER_MAX) || !int(d.kf, 0, 1)) return null;
    if (!cell(d.x, d.y) || !cell(d.fx, d.fy) || !near(d.fx, d.fy, d.x, d.y)) return null;
    if (!int(d.mt, 1, MOVE) || !int(d.mc, 0, d.mt) || !int(d.fc, 1, 4) || !int(d.wd, 0, 4) || !int(d.q, 0, 4)) return null;
    if (!int(d.dz, 0, SWEPT) || !int(d.sd, 0, BUCKET_FAST) || !int(d.dg, 0, RAID) || !int(d.st, 0, 999)) return null;
    if (!int(d.sc, 0, SCORE_MAX) || !int(d.sv, 0, SCORE_MAX)) return null;
    if (!int(d.wn, 0, 99999) || !int(d.bw, 0, 99) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    castles.add(d.kx);
    p[id] = player(d);
  }
  for (const id of ids) {
    const d = p[id];
    if (castles.has(d.x) && d.y === CASTLE_Y) return null;
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
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, h: raw.h.slice(), o: raw.o.slice(), fl: raw.fl.slice(),
    wt: raw.wt, wp: raw.wp.slice(), wf: raw.wf, wh: raw.wh, wv: raw.wv, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed beach steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a beach late in the afternoon. Warm sand, darker where the sea
// has been, dunes with grass on them, a turquoise sea with white foam, and a
// bright colour for each player that is their builder's, their flag's and
// their chip's.
const INK = {
  page: '#16324a', glow: '#24597a',
  sand: '#e9cf98', sandB: '#e3c78e', speck: '#d6b77a', wet: '#bfa06a', dune: '#d9b874', duneTop: '#f1dca6',
  duneSide: '#b8955a', grass: '#7aa35a', grassDark: '#557a3e',
  heap: '#dcb878', heapTop: '#f3dfac', heapSide: '#b18c52', heapLine: '#a07c45',
  sea: '#2bb3c6', seaDeep: '#1a8aa8', foam: '#f4fbff', water: 'rgba(80,200,225,0.62)',
  castle: '#e8c98a', castleTop: '#fbe9bd', castleSide: '#b8925a',
  text: '#ffffff', muted: '#d3e6ef', dim: '#8fb2c4', danger: '#ff5a5a', warn: '#ffb03b', gold: '#ffd34d',
  panel: 'rgba(12,30,44,0.93)',
};
const SEAT = ['#ff5f6d', '#3d8bff', '#ffcc1f', '#43c95a', '#b46cff', '#ff8a2a', '#16c6b0', '#ff6fc0'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #3f6f8c;' +
  `background:#1b3b52;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
// The bottom rows of the beach are the sea, where the next wave shows, so a
// narrow frame keeps NOTE_ROOM free under it for the practice note and, in a
// round, for your own bucket and castle.
const NOTE_ROOM = 60;
const SIDE = 160;              // the least a column beside the beach needs for the scoreboard
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

// The whole beach is always on screen, as large as the frame lets it be. A
// frame wider than the beach puts the status, the scoreboard, your bucket and
// the line of controls in the columns either side of it, so the beach takes
// the whole height; the sand and the sea run on into those columns, dimmed. A
// narrower one stacks them in strips above and below it. Whichever of the two
// draws the beach bigger is the one used.
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

// Screen pixels of a point on the beach, in cells, from its top left corner.
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
  // Sand off a spade: a soft hiss, higher for a dune than for a rival's heap.
  scoop() { if (ready('scoop', 90)) { puff(0.09, 0.06, 1400, 0, 1.5); tone(240, 0.05, 'sine', 0.025, 1.4); } },
  dig() { if (ready('dig', 90)) { puff(0.1, 0.08, 700, 0, 1.2); tone(150, 0.07, 'triangle', 0.04, 0.8); } },
  pour(h) { if (ready('pour', 90)) { puff(0.14, 0.05, 900 - h * 120, 0, 0.9); tone(180 + h * 40, 0.08, 'sine', 0.035, 0.9); } },
  tower(n) { if (ready('tower', 80)) { const f = 392 * Math.pow(1.122, n); tone(f, 0.1, 'triangle', 0.07, 1.05); tone(f * 1.5, 0.08, 'sine', 0.03, 1, 0.05); } },
  raid(mine) {
    if (!ready('raid', 200)) return;
    if (mine) [392, 523, 659].forEach((f, i) => tone(f, 0.08, 'square', 0.04, 0, i * 0.05));
    else [660, 520, 392].forEach((f, i) => tone(f, 0.12, 'square', 0.045, 0, i * 0.08));
  },
  swell() { if (ready('swell', 600)) { tone(70, 0.9, 'sine', 0.07, 1.4); puff(0.9, 0.035, 300, 0, 0.6); } },
  wave() { if (ready('wave', 600)) { puff(1.2, 0.12, 500, 0, 0.5); puff(0.8, 0.06, 1800, 0.15, 0.7); } },
  wear() { if (ready('wear', 140)) puff(0.12, 0.03, 600, 0, 2); },
  wash() { if (ready('wash', 160)) { puff(0.25, 0.06, 420, 0, 1); tone(120, 0.18, 'triangle', 0.03, 0.6); } },
  flood(mine) {
    if (!ready('flood', 300)) return;
    puff(0.5, mine ? 0.12 : 0.06, 350, 0, 0.8);
    if (mine) [440, 349, 262, 196].forEach((f, i) => tone(f, 0.22, 'triangle', 0.08, 0.9, i * 0.1));
  },
  swept() { if (ready('swept', 300)) { puff(0.35, 0.1, 800, 0, 0.8); [900, 700, 500].forEach((f, i) => tone(f, 0.08, 'sine', 0.05, 0, i * 0.06)); } },
  safe(mine, v) {
    if (!ready('safe' + (mine ? 1 : 0), 80)) return;
    if (mine) {
      [523, 659, 784].concat(v > 6 ? [1047, 1319] : []).forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.06));
      puff(0.25, 0.04, 2200, 0.05, 0.8);
    } else tone(392, 0.15, 'triangle', 0.035, 1.3);
  },
  storm() { if (ready('storm', 600)) { [784, 988, 784, 988, 1175].forEach((f, i) => tone(f, 0.14, 'square', 0.04, 1, i * 0.12)); puff(1.4, 0.06, 250, 0, 0.5); } },
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
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
const wetLook = new Float32Array(NC);   // how dark each cell is from the sea having been on it
function spray(x, y, count, colour, speed, size, kind) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (kind === 1 ? speed * 0.5 : 0), life: 0, max: 18 + Math.random() * 22, size, colour, kind: kind || 0 });
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
      if (b.kind === 1) b.vy += 0.12;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    for (const l of looks.values()) { l.squash *= 0.86; l.daze *= 0.97; }
    for (let c = 0; c < NC; c++) if (wetLook[c] > 0) wetLook[c] = Math.max(0, wetLook[c] - 0.006);
    shake *= 0.85;
    if (shake < 0.2) shake = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();      // id -> { squash, daze, seen }
let drawFailed = false;
let sandArt = null;           // the open sand, drawn once a size
let sandKey = '';

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
// The player whose seat a heap's owner number names, or null.
function seatOwner(t, o) {
  if (o < 1 || o > MAX_P) return null;
  for (const id of playersIn(t)) if (t.p[id].s === o - 1) return id;
  return null;
}

// Where a builder stands in one table, in cells, part way along the cell it is
// walking.
function posIn(e) {
  const k = e.mt > 0 ? 1 - e.mc / e.mt : 1;
  const s = smooth(Math.max(0, Math.min(1, k)));
  return [lerp(e.fx, e.x, s), lerp(e.fy, e.y, s)];
}
// And as drawn between two tables, never slid across a jump: a new round, a
// return behind the castle.
function posBetween(a, z, k) {
  const q = posIn(z);
  if (!a) return q;
  const p = posIn(a);
  if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > 1.5) return q;
  return [lerp(p[0], q[0], k), lerp(p[1], q[1], k)];
}

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const x = e.x + 0.5, y = e.y + 0.5;
  if (e.kind === 'scoop') {
    spray(x, y + 0.2, 6, INK.duneTop, 3, 0.06, 1);
    lookOf(e.a).squash = 1;
    if (e.a === me) sound.scoop();
  } else if (e.kind === 'dig') {
    spray(x, y, 8, INK.heap, 3.2, 0.06, 1);
    lookOf(e.a).squash = 1;
    const victim = md && e.b === md.s + 1;
    if (victim) pop(x, y, 'dug!', INK.danger, 13);
    if (e.a === me || victim) sound.dig();
  } else if (e.kind === 'pour') {
    spray(x, y, 5, INK.heapTop, 2, 0.05, 1);
    lookOf(e.a).squash = 0.6;
    if (e.a === me) sound.pour(e.b);
  } else if (e.kind === 'tower') {
    const c = colourOf(t, e.a);
    ring(x, y, c, 0.9);
    spray(x, y - 0.3, 8, INK.castleTop, 2.6, 0.06, 1);
    pop(x, y - 0.4, 'tower ' + e.b, e.a === me ? '#ffffff' : c, e.a === me ? 15 : 12);
    lookOf(e.a).squash = 1;
    if (e.a === me) sound.tower(e.b);
  } else if (e.kind === 'raid') {
    const c = colourOf(t, e.a);
    spray(x, y, 12, INK.castleTop, 4, 0.07, 1);
    pop(x, y - 0.4, e.b === me ? 'raided!' : 'raid!', e.b === me ? INK.danger : c, e.a === me || e.b === me ? 17 : 13);
    if (e.b === me) shake = Math.max(shake, 6);
    if (e.a === me || e.b === me) sound.raid(e.a === me);
  } else if (e.kind === 'swell') {
    pop(x, e.y - 0.2, 'wave!', INK.foam, 16);
    sound.swell();
  } else if (e.kind === 'wave') {
    shake = Math.max(shake, 3);
    sound.wave();
  } else if (e.kind === 'wear') {
    spray(x, y, 4, INK.heap, 1.6, 0.05, 1);
    sound.wear();
  } else if (e.kind === 'wash') {
    spray(x, y, 10, INK.foam, 3, 0.06, 1);
    spray(x, y, 6, INK.heap, 2.5, 0.05, 1);
    sound.wash();
  } else if (e.kind === 'flood') {
    const mine = e.a === me;
    spray(x, y, 22, INK.foam, 5, 0.08, 1);
    ring(x, y, INK.foam, 1.6);
    pop(x, y - 0.5, e.b > 0 ? 'splash! -' + e.b : 'splash!', mine ? INK.danger : INK.foam, mine ? 19 : 14);
    if (mine) shake = Math.max(shake, 10);
    sound.flood(mine);
  } else if (e.kind === 'swept') {
    const mine = e.a === me;
    spray(x, y, 12, INK.foam, 4, 0.07, 1);
    lookOf(e.a).daze = 1;
    pop(x, y - 0.3, e.b > 0 ? 'spilt!' : 'swept!', mine ? INK.danger : INK.foam, mine ? 16 : 12);
    if (mine) { shake = Math.max(shake, 7); sound.swept(); }
  } else if (e.kind === 'safe') {
    const c = colourOf(t, e.a);
    ring(x, y, c, 1.5);
    spray(x, y - 0.3, e.b > 8 ? 20 : 10, e.b > 8 ? INK.gold : c, 4, 0.07);
    pop(x, y - 0.6, '+' + e.b, e.a === me ? '#ffffff' : c, e.a === me ? 20 : 14);
    if (e.a === me) shake = Math.max(shake, 3);
    sound.safe(e.a === me, e.b);
  } else if (e.kind === 'storm') {
    pop(GW / 2, GH / 2, 'storm! every wave pays double', INK.gold, 22);
    sound.storm();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'round') {
    looks.clear();
    wetLook.fill(0);
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

// The page behind the beach, and the sand and the sea run on past its edges,
// dimmed, so a wide frame has no bands of plain background beside it.
function drawGround() {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  if (!wide) return;
  const top = PY(0), sea = PY(SEA_Y), bot = PY(GH);
  ctx.fillStyle = INK.sand;
  ctx.fillRect(0, top, VW, sea - top);
  ctx.fillStyle = INK.duneSide;
  ctx.fillRect(0, top, VW, cs * DUNE_ROWS);
  const sg = ctx.createLinearGradient(0, sea, 0, bot);
  sg.addColorStop(0, INK.sea);
  sg.addColorStop(1, INK.seaDeep);
  ctx.fillStyle = sg;
  ctx.fillRect(0, sea, VW, bot - sea);
  ctx.fillStyle = 'rgba(14,34,50,0.68)';
  ctx.fillRect(0, top, PX(0), bot - top);
  ctx.fillRect(PX(GW), top, VW - PX(GW), bot - top);
}

// The open sand, drawn into a picture of its own whenever the size changes:
// two shades in a check, specks, and the band the sea keeps wet.
function sandArtOf() {
  const key = cs.toFixed(2) + '|' + dpx;
  if (sandArt && key === sandKey) return sandArt;
  sandKey = key;
  const wd = Math.ceil(cs * GW), ht = Math.ceil(cs * SEA_Y);
  if (!sandArt) sandArt = document.createElement('canvas');
  sandArt.width = Math.ceil(wd * dpx);
  sandArt.height = Math.ceil(ht * dpx);
  const g = sandArt.getContext('2d');
  g.setTransform(dpx, 0, 0, dpx, 0, 0);
  g.clearRect(0, 0, wd, ht);
  for (let y = 0; y < SEA_Y; y++) {
    for (let x = 0; x < GW; x++) {
      g.fillStyle = (x + y) % 2 ? INK.sand : INK.sandB;
      g.fillRect(x * cs, y * cs, cs + 0.5, cs + 0.5);
    }
  }
  // Specks laid by a fixed sequence, so a resize draws the same beach.
  let s = 12345;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  g.fillStyle = INK.speck;
  for (let i = 0; i < GW * SEA_Y * 3; i++) {
    g.beginPath();
    g.arc(r() * wd, r() * ht, Math.max(0.6, cs * (0.02 + r() * 0.025)), 0, Math.PI * 2);
    g.fill();
  }
  const wg = g.createLinearGradient(0, (SEA_Y - 3) * cs, 0, SEA_Y * cs);
  wg.addColorStop(0, 'rgba(160,125,70,0)');
  wg.addColorStop(1, 'rgba(160,125,70,0.45)');
  g.fillStyle = wg;
  g.fillRect(0, (SEA_Y - 3) * cs, wd, 3 * cs);
  return sandArt;
}

function drawSand() {
  flat();
  ctx.drawImage(sandArtOf(), PX(0), PY(0), cs * GW, cs * SEA_Y);
}

// The sea along the foot of the beach: deep water, a line of foam where it
// laps the sand, and the next wave as a crest rising on the water, tallest
// where it is strongest, rolling in as its moment comes.
function drawSea(t, now) {
  flat();
  const x0 = PX(0), x1 = PX(GW);
  const top = PY(SEA_Y), bot = PY(GH);
  const sg = ctx.createLinearGradient(0, top, 0, bot);
  sg.addColorStop(0, INK.sea);
  sg.addColorStop(1, INK.seaDeep);
  ctx.fillStyle = sg;
  ctx.fillRect(x0, top, x1 - x0, bot - top);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, top - cs * 0.3, x1 - x0, bot - top + cs * 0.3);
  ctx.clip();
  // Ripples on the water.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = Math.max(1, cs * 0.05);
  for (let row = 0; row < 3; row++) {
    const yy = top + cs * (0.6 + row * 0.55);
    ctx.beginPath();
    for (let x = x0; x <= x1; x += cs * 0.25) {
      const v = Math.sin(x / (cs * 0.9) + now / (700 + row * 200) + row * 2) * cs * 0.07;
      if (x === x0) ctx.moveTo(x, yy + v); else ctx.lineTo(x, yy + v);
    }
    ctx.stroke();
  }
  // Foam lapping the sand.
  ctx.fillStyle = 'rgba(244,251,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(x0, top - cs * 0.05);
  for (let x = x0; x <= x1 + cs * 0.25; x += cs * 0.25) {
    const v = Math.sin(x / (cs * 0.6) + now / 500) * cs * 0.06 + Math.sin(x / (cs * 1.7) - now / 900) * cs * 0.05;
    ctx.lineTo(x, top + cs * 0.08 + v);
  }
  ctx.lineTo(x1, top - cs * 0.12);
  ctx.lineTo(x0, top - cs * 0.12);
  ctx.closePath();
  ctx.fill();
  // The swell.
  let peak = 0, mid = 0;
  for (let x = 0; x < GW; x++) if (t.wp[x] > peak) { peak = t.wp[x]; mid = x; }
  if (peak > 0 && t.wf < 0 && t.wh < 0) {
    const k = 1 - Math.max(0, Math.min(1, t.wt / WARN));
    const base = bot - (bot - top) * ease(k) * 0.85;
    ctx.fillStyle = 'rgba(20,110,140,0.75)';
    ctx.beginPath();
    ctx.moveTo(PX(0), bot);
    for (let x = 0; x <= GW; x++) {
      const v = (t.wp[Math.min(GW - 1, x)] + t.wp[Math.max(0, x - 1)]) / 2;
      ctx.lineTo(PX(x), base - v * cs * 0.05 * (0.6 + 0.4 * k));
    }
    ctx.lineTo(PX(GW), bot);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(244,251,255,0.95)';
    ctx.lineWidth = Math.max(1.5, cs * 0.1);
    ctx.beginPath();
    for (let x = 0; x <= GW; x++) {
      const v = (t.wp[Math.min(GW - 1, x)] + t.wp[Math.max(0, x - 1)]) / 2;
      const yy = base - v * cs * 0.05 * (0.6 + 0.4 * k) + Math.sin(now / 120 + x) * cs * 0.03;
      if (x === 0) ctx.moveTo(PX(x), yy); else ctx.lineTo(PX(x), yy);
    }
    ctx.stroke();
    ctx.restore();
    // Where it is strongest: an arrow up the beach, and how long it has.
    flat();
    const ax = PX(mid + 0.5), ay = top - cs * 0.35 - Math.sin(now / 200) * cs * 0.08;
    ctx.fillStyle = INK.foam;
    ctx.beginPath();
    ctx.moveTo(ax, ay - cs * 0.3);
    ctx.lineTo(ax - cs * 0.22, ay);
    ctx.lineTo(ax + cs * 0.22, ay);
    ctx.closePath();
    ctx.fill();
    ctx.font = font(Math.max(10, Math.min(15, cs * 0.5)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10,50,70,0.8)';
    const label = 'wave ' + Math.max(1, Math.ceil(t.wt / HZ));
    ctx.strokeText(label, ax, (top + bot) / 2 + cs * 0.2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, ax, (top + bot) / 2 + cs * 0.2);
    return;
  }
  ctx.restore();
}

// A mound of sand: lower and rounder for a scoop, a squared block for two, a
// tall one with a crenellated top for three.
function mound(X, Y, h, body, top, side) {
  const w = cs * (0.62 + h * 0.1), ht = cs * (0.14 + h * 0.16);
  const bx = X - w / 2, by = Y + cs * 0.36;
  ctx.fillStyle = 'rgba(80,55,20,0.22)';
  ctx.beginPath();
  ctx.ellipse(X + cs * 0.06, by + cs * 0.02, w * 0.56, cs * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = side;
  roundRect(bx, by - ht, w, ht, h === 1 ? ht / 2 : cs * 0.08);
  ctx.fill();
  ctx.fillStyle = body;
  roundRect(bx, by - ht - cs * 0.16, w, ht * 0.7, h === 1 ? ht / 2 : cs * 0.08);
  ctx.fill();
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.ellipse(X, by - ht - cs * 0.1, w / 2, cs * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  if (h >= 3) {
    ctx.fillStyle = body;
    const n = 3, cw = w / (2 * n - 1);
    for (let i = 0; i < n; i++) ctx.fillRect(bx + i * 2 * cw, by - ht - cs * 0.3, cw, cs * 0.16);
  }
  return by - ht - cs * 0.2;
}

// The dunes along the top: heaps of sand with grass on the full ones, and a
// pit where somebody has dug one out.
function drawDunes(t, now) {
  flat();
  for (let y = 0; y < DUNE_ROWS; y++) {
    for (let x = 0; x < GW; x++) {
      const h = t.h[at(x, y)];
      const X = PX(x + 0.5), Y = PY(y + 0.5);
      if (h === 0) {
        ctx.fillStyle = 'rgba(150,115,60,0.35)';
        ctx.beginPath();
        ctx.ellipse(X, Y + cs * 0.1, cs * 0.36, cs * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const top = mound(X, Y, h, INK.dune, INK.duneTop, INK.duneSide);
      if (h >= 2) {
        ctx.strokeStyle = (x + y) % 2 ? INK.grass : INK.grassDark;
        ctx.lineWidth = Math.max(1, cs * 0.05);
        const sway = Math.sin(now / 700 + x * 1.3) * cs * 0.04;
        ctx.beginPath();
        for (let i = -1; i <= 1; i++) {
          const gx = X + i * cs * 0.12;
          ctx.moveTo(gx, top + cs * 0.06);
          ctx.lineTo(gx + i * cs * 0.06 + sway, top - cs * (0.16 + (i === 0 ? 0.08 : 0)));
        }
        ctx.stroke();
      }
    }
  }
}

// The heaps players have built, each with a stripe of its owner's colour and,
// at its full height, a pennant.
function drawHeaps(t, cellsOf, now) {
  flat();
  for (let y = DUNE_ROWS; y < SEA_Y; y++) {
    for (let x = 0; x < GW; x++) {
      const c = at(x, y);
      const src = cellsOf(c);
      const h = src.h[c];
      if (h === 0) continue;
      const X = PX(x + 0.5), Y = PY(y + 0.5);
      const top = mound(X, Y, h, INK.heap, INK.heapTop, INK.heapSide);
      const id = seatOwner(src, src.o[c]);
      const colour = id !== null ? colourOf(src, id) : null;
      if (!colour) continue;
      ctx.fillStyle = colour;
      const w = cs * (0.62 + h * 0.1);
      ctx.fillRect(X - w / 2, Y + cs * 0.28, w, Math.max(1.5, cs * 0.07));
      if (h >= WALL_MAX) {
        ctx.strokeStyle = '#5a4630';
        ctx.lineWidth = Math.max(1, cs * 0.04);
        ctx.beginPath();
        ctx.moveTo(X, top + cs * 0.05);
        ctx.lineTo(X, top - cs * 0.3);
        ctx.stroke();
        const f = Math.sin(now / 250 + x + y) * cs * 0.03;
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(X, top - cs * 0.3);
        ctx.lineTo(X + cs * 0.22, top - cs * 0.23 + f);
        ctx.lineTo(X, top - cs * 0.15);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

// A castle: a keep with a door, its towers round it — up to eight, four along
// the back and four along the front — and its owner's flag on top. A castle
// the sea has just reached stands dark and wet.
const TOWER_AT = [[-0.3, -0.18], [0.3, -0.18], [-0.1, -0.24], [0.1, -0.24], [-0.36, 0.08], [0.36, 0.08], [-0.2, 0.14], [0.2, 0.14]];
function drawCastle(t, id, tw, now, mine) {
  flat();
  const d = t.p[id];
  const c = SEAT[d.c];
  const X = PX(d.kx + 0.5), Y = PY(CASTLE_Y + 0.5);
  const wet = d.kf ? 0.35 : 0;
  ctx.fillStyle = alpha(c, mine ? 0.32 : 0.18);
  roundRect(X - cs * 0.5, Y - cs * 0.5, cs, cs, cs * 0.18);
  ctx.fill();
  if (mine) {
    ctx.strokeStyle = alpha(c, 0.7 + 0.25 * Math.sin(now / 260));
    ctx.lineWidth = Math.max(1.5, cs * 0.06);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(80,55,20,0.25)';
  ctx.beginPath();
  ctx.ellipse(X + cs * 0.05, Y + cs * 0.34, cs * 0.44, cs * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  const tower = (tx, ty, s) => {
    ctx.fillStyle = INK.castleSide;
    ctx.fillRect(tx - s / 2, ty - s * 1.6, s, s * 1.6);
    ctx.fillStyle = INK.castle;
    ctx.fillRect(tx - s / 2, ty - s * 1.6, s * 0.7, s * 1.6);
    ctx.fillStyle = INK.castleTop;
    ctx.fillRect(tx - s * 0.6, ty - s * 1.8, s * 1.2, s * 0.28);
    ctx.fillRect(tx - s * 0.6, ty - s * 2.0, s * 0.3, s * 0.2);
    ctx.fillRect(tx + s * 0.3, ty - s * 2.0, s * 0.3, s * 0.2);
  };
  for (let i = 0; i < Math.min(4, tw); i++) tower(X + TOWER_AT[i][0] * cs, Y + TOWER_AT[i][1] * cs, cs * 0.17);
  // The keep.
  const kw = cs * 0.46, kh = cs * 0.46;
  ctx.fillStyle = INK.castleSide;
  ctx.fillRect(X - kw / 2, Y - kh / 2 + cs * 0.12, kw, kh);
  ctx.fillStyle = INK.castle;
  ctx.fillRect(X - kw / 2, Y - kh / 2 + cs * 0.12, kw * 0.75, kh);
  ctx.fillStyle = INK.castleTop;
  for (let i = 0; i < 3; i++) ctx.fillRect(X - kw / 2 + i * kw * 0.4, Y - kh / 2 + cs * 0.04, kw * 0.2, cs * 0.09);
  ctx.fillStyle = '#7a5a30';
  ctx.beginPath();
  ctx.arc(X, Y + kh / 2 + cs * 0.12, kw * 0.2, Math.PI, 0);
  ctx.lineTo(X + kw * 0.2, Y + kh / 2 + cs * 0.12);
  ctx.closePath();
  ctx.fill();
  for (let i = 4; i < Math.min(8, tw); i++) tower(X + TOWER_AT[i][0] * cs, Y + TOWER_AT[i][1] * cs + cs * 0.2, cs * 0.15);
  // The flag.
  const fy = Y - kh / 2 - cs * 0.02;
  ctx.strokeStyle = '#5a4630';
  ctx.lineWidth = Math.max(1, cs * 0.04);
  ctx.beginPath();
  ctx.moveTo(X, fy + cs * 0.06);
  ctx.lineTo(X, fy - cs * 0.42);
  ctx.stroke();
  const f = Math.sin(now / 200 + d.kx) * cs * 0.04;
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(X, fy - cs * 0.42);
  ctx.lineTo(X + cs * 0.3, fy - cs * 0.33 + f);
  ctx.lineTo(X, fy - cs * 0.22);
  ctx.closePath();
  ctx.fill();
  if (wet) {
    ctx.fillStyle = `rgba(40,90,110,${wet})`;
    roundRect(X - cs * 0.45, Y - cs * 0.55, cs * 0.9, cs * 0.95, cs * 0.12);
    ctx.fill();
  }
  // How many towers, in a tag under it.
  if (cs > 12) {
    const s = String(tw);
    ctx.font = font(Math.max(9, Math.min(13, cs * 0.4)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw2 = ctx.measureText(s).width + cs * 0.3;
    ctx.fillStyle = alpha(c, 0.92);
    roundRect(X + cs * 0.22, Y + cs * 0.12, tw2, cs * 0.36, cs * 0.18);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(s, X + cs * 0.22 + tw2 / 2, Y + cs * 0.31);
  }
}

// The sea where it has run up the sand: water over every wet cell, fading in
// as it arrives, foam along its edge, and the sand it leaves dark a while.
function drawWater(b, now) {
  flat();
  const t = b.to, was = b.from.fl;
  for (let c = 0; c < NC; c++) if (t.fl[c] > 0) wetLook[c] = 1;
  ctx.fillStyle = 'rgba(120,90,45,1)';
  for (let c = 0; c < NC; c++) {
    if (wetLook[c] <= 0 || t.fl[c] > 0) continue;
    const x = c % GW, y = (c - x) / GW;
    ctx.globalAlpha = wetLook[c] * 0.3;
    ctx.fillRect(PX(x), PY(y), cs + 0.5, cs + 0.5);
  }
  ctx.globalAlpha = 1;
  for (let c = 0; c < NC; c++) {
    if (t.fl[c] <= 0) continue;
    const x = c % GW, y = (c - x) / GW;
    if (isSea(y)) continue;
    const k = was[c] > 0 ? 1 : b.k;
    ctx.globalAlpha = 0.25 + 0.6 * k;
    ctx.fillStyle = INK.water;
    ctx.fillRect(PX(x), PY(y), cs + 0.5, cs + 0.5);
    ctx.globalAlpha = 0.8 * k;
    ctx.fillStyle = INK.foam;
    const edge = (ax, ay) => !onBeach(ax, ay) || (!isSea(ay) && t.fl[at(ax, ay)] <= 0);
    const fw = Math.max(1.5, cs * 0.1) * (1 + 0.3 * Math.sin(now / 150 + c));
    if (edge(x, y - 1) && y > 0) ctx.fillRect(PX(x), PY(y), cs, fw);
    if (edge(x - 1, y) && x > 0) ctx.fillRect(PX(x), PY(y), fw, cs);
    if (edge(x + 1, y) && x < GW - 1) ctx.fillRect(PX(x + 1) - fw, PY(y), fw, cs);
  }
  ctx.globalAlpha = 1;
}

// A builder: a round body in its colour under a straw hat with a band of the
// same colour, eyes looking the way it faces, a pail in hand that fills as it
// digs, a little squash when it digs or pours, and stars when the sea has
// knocked it over.
function drawBuilder(t, id, x, y, d, me, now, crowned, quick) {
  flat();
  const c = SEAT[d.c];
  const l = lookOf(id);
  const sq = l.squash;
  const [fx, fy] = DIRS[d.fc];
  const X = PX(x + 0.5) + fx * sq * cs * 0.06, Y = PY(y + 0.5) + fy * sq * cs * 0.06;
  const r = cs * 0.34;
  const sx = 1 + sq * 0.14 * (fx ? 1 : -0.6), sy = 1 + sq * 0.14 * (fy ? 1 : -0.6);
  ctx.fillStyle = 'rgba(80,55,20,0.3)';
  ctx.beginPath();
  ctx.ellipse(X + cs * 0.05, Y + r * 0.85, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  if (me) {
    ctx.strokeStyle = alpha(c, 0.55 + 0.3 * Math.sin(now / 220));
    ctx.lineWidth = 2;
    disc(X, Y, r * 1.5);
    ctx.stroke();
  }
  // The pail, on the side away from the way it faces when walking up or down.
  const cap = Math.max(1, bucketOf(t, d));
  const side = fx ? -fx : 1;
  const bx = X + side * r * 1.05, by = Y + r * 0.25, bw = r * 0.62, bh = r * 0.62;
  ctx.fillStyle = darker(c, 0.15);
  ctx.beginPath();
  ctx.moveTo(bx - bw / 2, by - bh / 2);
  ctx.lineTo(bx + bw / 2, by - bh / 2);
  ctx.lineTo(bx + bw * 0.38, by + bh / 2);
  ctx.lineTo(bx - bw * 0.38, by + bh / 2);
  ctx.closePath();
  ctx.fill();
  if (d.sd > 0) {
    const f = Math.min(1, d.sd / cap);
    ctx.fillStyle = INK.heapTop;
    ctx.beginPath();
    ctx.ellipse(bx, by - bh / 2 + bh * (1 - f) * 0.8, bw * 0.46, bh * (0.12 + 0.15 * f), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(40,30,20,0.6)';
  ctx.lineWidth = Math.max(1, cs * 0.03);
  ctx.beginPath();
  ctx.arc(bx, by - bh / 2, bw * 0.45, Math.PI, 0);
  ctx.stroke();
  ctx.save();
  ctx.translate(X, Y);
  ctx.scale(sx, sy);
  ctx.fillStyle = darker(c, 0.35);
  disc(0, 0, r);
  ctx.fill();
  ctx.fillStyle = c;
  disc(0, -r * 0.08, r * 0.9);
  ctx.fill();
  // Eyes, looking the way it faces.
  const ex = fx * r * 0.28, ey = fy * r * 0.18 + r * 0.12;
  for (const s of [-1, 1]) {
    ctx.fillStyle = '#ffffff';
    disc(ex + s * r * 0.28, ey, r * 0.17);
    ctx.fill();
    ctx.fillStyle = '#18222c';
    disc(ex + s * r * 0.28 + fx * r * 0.06, ey + fy * r * 0.06, r * 0.09);
    ctx.fill();
  }
  // The hat: a wide straw brim, a crown and a band.
  ctx.fillStyle = '#f2d78f';
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.55, r * 1.05, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e6c46e';
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.72, r * 0.55, r * 0.34, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = darker(c, 0.1);
  ctx.fillRect(-r * 0.55, -r * 0.74, r * 1.1, r * 0.14);
  ctx.restore();
  if (d.dz > 0 || l.daze > 0.3) {
    for (let i = 0; i < 3; i++) {
      const a = now / 180 + (i * Math.PI * 2) / 3;
      ctx.fillStyle = '#ffffff';
      disc(X + Math.cos(a) * r * 0.9, Y - r * 1.2 + Math.sin(a) * r * 0.3, Math.max(1.5, cs * 0.05));
      ctx.fill();
    }
  }
  if (crowned) drawCrown(X, Y - r * 1.45, r * 0.5, now);
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
    ctx.strokeStyle = 'rgba(20,30,40,0.8)';
    const s = nickOf(id);
    ctx.strokeText(s, X, Y + r * 1.85);
    ctx.fillStyle = alpha(c, 0.95);
    ctx.fillText(s, X, Y + r * 1.85);
  }
}

// What a builder leans on, and how far the leaning has got: a ring filling
// round the cell it digs, raids or builds a tower on.
function drawLean(t, id, d) {
  if (!d.dg || !d.wd) return;
  const [dx, dy] = DIRS[d.fc];
  const tx = d.x + dx, ty = d.y + dy;
  if (!onBeach(tx, ty)) return;
  const k = castleAt(t, at(tx, ty));
  const need = k === null ? (trails(t, d) ? DIG_FAST : DIG) : k === id ? POUR : RAID;
  const f = Math.min(1, d.dg / need);
  flat();
  const X = PX(tx + 0.5), Y = PY(ty + 0.5);
  ctx.strokeStyle = 'rgba(40,30,20,0.4)';
  ctx.lineWidth = Math.max(2, cs * 0.1);
  disc(X, Y, cs * 0.45);
  ctx.stroke();
  ctx.strokeStyle = SEAT[d.c];
  ctx.beginPath();
  ctx.arc(X, Y, cs * 0.45, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
  ctx.stroke();
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

// Where your hand points, a step ahead of your builder.
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
    ctx.strokeStyle = 'rgba(20,30,40,0.85)';
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

// What the sea is doing, in words: the next wave's count, or that it is in.
function seaLine(t) {
  if (t.wf >= 0 || t.wh >= 0) return 'the wave is in!';
  if (t.wp.some((v) => v > 0)) return 'wave in ' + Math.max(1, Math.ceil(t.wt / HZ));
  if (t.ph === PLAY && t.wt === WARN + 1 && t.pt < WARN + WAVE_MAX + HOLD + 4) return 'last wave done';
  return 'next wave in ' + Math.max(1, Math.ceil(t.wt / HZ));
}

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, the time left in it, and the sea.
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice · ' + seaLine(t);
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left' + (rushOn(t) ? ' · storm!' : '') + ' · ' + seaLine(t);
    if (rushOn(t)) colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('sandcastle', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('sandcastle').width;
  if (wide) {
    const lines = wrap(status, 14, colW - 24);
    lines.forEach((s, i) => text(s, 12, 44 + i * 18, 14, colour, 'left'));
  } else fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points this round,
  // the towers on their castle and rounds won. A row across the top of a
  // narrow frame, a column down the left of a wide one.
  const ids = bySeat(t);
  const crown = t.ph === WAIT || t.ph === PLAY ? leaderOf(t) : -1;
  if (ids.length) {
    const gap = 6;
    const cw = wide ? Math.min(200, colW - 24) : Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = wide ? 12 : (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    let y = wide ? 96 : narrow ? 46 : 44;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = c;
      roundRect(x + 6, y - 7, 10, 10, 2);
      ctx.fill();
      const fast = t.ph === PLAY && trails(t, d);
      const score = String(d.sc) + (cw > 90 ? ' ▲' + d.tw : '') + (fast && cw > 70 ? ' »' : '') + (d.wn && cw > 60 ? ' ★' + d.wn : '');
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
    ? 'drag to walk · let go to pour sand · walk into dunes or rival walls to dig · into your castle for a tower'
    : 'arrows/WASD or drag to walk · stand still to pour sand · walk into dunes or rival walls to dig · into your castle for a tower · M mutes';
  if (!wide) { fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20); return; }
  const lines = wrap(how, 12, colW - 24);
  lines.forEach((s, i) => text(s, VW - 12, VH - 12 - (lines.length - 1 - i) * 17, 12, INK.muted, 'right'));
}

// Your bucket and your castle, while you are on the beach: in the strip under
// it or halfway down the right-hand column.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === COUNT || t.ph === END) return;
  if (t.ph === WAIT && !wide) return;
  flat();
  const y = wide ? VH / 2 - 20 : Math.min(fieldBot + NOTE_ROOM / 2 - 2, VH - BOT - 14);
  const mid = wide ? VW - colW / 2 : VW / 2, most = wide ? colW - 24 : VW - 24;
  const cap = bucketOf(t, d);
  let line, colour = INK.muted;
  if (d.dz > 0) { line = 'swept off your feet!'; colour = INK.danger; }
  else if (d.kf) { line = 'the sea got into your castle!'; colour = INK.danger; }
  else {
    line = 'bucket ' + d.sd + '/' + cap + ' · castle ' + d.tw + (d.tw === 1 ? ' tower' : ' towers');
    if (t.ph === PLAY && trails(t, d)) { line += ' · catching up: bigger bucket, quicker feet'; colour = SEAT[d.c]; }
    else if (d.sd === 0) line += ' · dig at the dunes';
  }
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
    const tip = two ? null : 'stand still to pour a wall · ring your castle before the wave comes in';
    // A wide frame has no strip above or below the beach: the note sits at
    // the foot of it for as long as practice lasts.
    if (wide) practiceNote(now, VW, head, tip, [], VH - 8);
    else practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,30,44,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid - big * 0.6);
    text(String(n), cx, mid - big * 0.6, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 1.4, Math.min(VW - 32, 380), 30);
    fitText('every wave that leaves your castle dry pays a point a tower', cx, mid + big * 1.4 + 5, 14, INK.text, Math.min(VW - 48, 360));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,30,44,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('dig!', cx, mid + big * 0.5);
    text('dig!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 340), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody kept the most';
    else head = t.win === me ? 'you win the round!' : nickOf(t.win) + ' wins the round';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('points', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('dry', cx + w / 2 - 64, y0 + 52, 10, INK.dim, 'right');
    text('rounds', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, won, wins, points, dry], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      roundRect(cx - w / 2 + 19, y - 9, 10, 10, 2);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (won ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(points), cx + w / 2 - 110, y, 14, INK.text, 'right');
      text(String(dry), cx + w / 2 - 64, y, 14, INK.text, 'right');
      text(String(wins), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Your own builder is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a step a step away from
// where the guess had it. So the builder drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a new round — puts it there at once. Only the drawing is
// smoothed: the beach, and every rule on it, are untouched.
const PULL = 0.4;
let shown = null;        // [x, y] in cells: where your builder is drawn

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
    text('catching up with the beach…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a beach this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const me = myId();
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  // The sand right round your own builder is drawn from the guess, so a scoop
  // you pour or dig shows when you do it rather than a trip later.
  const g = own && own !== b ? own.to : null;
  const gd = g ? g.p[me] : null;
  const cellsOf = (c) => {
    if (!gd) return t;
    const x = c % GW, y = (c - x) / GW;
    return Math.abs(x - gd.x) + Math.abs(y - gd.y) <= 1 ? g : t;
  };
  drawSand();
  drawWater(b, now);
  drawSea(t, now);
  drawDunes(gd ? { h: t.h.map((v, c) => cellsOf(c).h[c]) } : t, now);
  drawHeaps(t, cellsOf, now);
  for (const id of bySeat(t)) {
    const towers = id === me && g && g.p[me] ? g.p[me].tw : t.p[id].tw;
    drawCastle(t, id, towers, now, id === me);
  }
  const crown = t.ph === WAIT || t.ph === PLAY ? leaderOf(t) : -1;
  const quick = (d) => t.ph === PLAY && trails(t, d);
  // Builders drawn top to bottom, so the one nearer the foot of the screen
  // stands in front.
  const later = [];
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    const p = posBetween(b.from.p[id], d, b.k);
    later.push([p[1], () => { drawLean(t, id, d); drawBuilder(t, id, p[0], p[1], d, false, now, id === crown, quick(d)); }]);
  }
  if (own) {
    const d = own.to.p[me];
    const p = posBetween(own.from.p[me], d, own.k);
    const [x, y] = settle(p[0], p[1]);
    later.push([y, () => {
      drawLean(own.to, me, d);
      drawWish(x, y, d, now);
      drawBuilder(t, me, x, y, d, true, now, me === crown, quick(t.p[me] || d));
    }]);
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
// a player arrives on the beach.
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
