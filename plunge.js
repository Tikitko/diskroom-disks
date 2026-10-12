/**
 * @disk     plunge
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Race down one shared well of coloured blocks. Drill a block and its whole colour goes at once, and whatever it held up shakes, then falls on whoever is below. Grab air on the way, mind the stone, and be first to the bottom.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/plunge.png
 */
// plunge.js — a race down one well of coloured blocks, where the room's order
// is the referee.
//
// Every copy holds every block of the well, which of them shake or fall, and
// every driller with their air, and changes it only on what comes back round
// the room, so every copy applies the same hands in the same order and holds
// the same well. Nobody sends what they drilled, where they stand or who was
// squashed: a hand is the way a player pushes, one of nine, and everything
// else is the same arithmetic on the same whole numbers on every machine. A
// page with a console open can steer its own driller however it likes, at the
// driller's own pace, and drill no faster than the drill cools.
//
// While a player is alone, a bot digs with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own driller, and the blocks round it, do not wait for the trip: they
// are drawn from the agreed table played forward by the trip, with your hand
// already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole cells and whole steps and use nothing but
// `+ - * /`, comparisons, `Math.floor`, `Math.min`, `Math.max` and
// `Math.imul`, whose results the language fixes to the last bit. Trigonometry
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
const HZ = 20;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own driller a trip ahead, with your hand in it

// The well: a grid of cells, `cols` wide and H deep, row 0 at the top. The
// first TOPAIR rows are open air to start in; bedrock lies under the last row,
// and a driller standing on it has reached the bottom.
const TOPAIR = 3;
const DEPTH = 90;
const H = TOPAIR + DEPTH;
const COLS = [9, 11, 13];
const colsFor = (n) => (n <= 2 ? 9 : n <= 4 ? 11 : 13);

// What a cell holds: nothing, one of four colours, an air capsule, or stone
// with one to three hits left in it.
const EMPTY = 0, CAPSULE = 5, HARD1 = 6, HARD0 = 8;
const isColour = (v) => v >= 1 && v <= 4;
const isHard = (v) => v >= HARD1;

const WALK_T = 3;              // steps to walk one cell
const FALL_T = 2;              // steps to drop one cell
const CLIMB_T = 5;             // steps to climb onto a block beside you
const DRILL_T = 4;             // steps the drill cools between two bites
const BLOCK_FALL = 2;          // a loose block drops a cell every this many steps
const WOB = 20;                // steps a block shakes before it falls
const POP_AT = 4;              // a landing that makes a colour this many strong clears it
const AIR_MAX = 30 * HZ;       // a full tank, in steps of breath
const CAPSULE_AIR = 12 * HZ;
const HARD_AIR = HZ;           // what a bite of stone costs
const CRUSH_AIR = 4 * HZ;      // and a block on the head
const CRUSH_STUN = Math.round(1.2 * HZ);
const FAINT_STUN = 3 * HZ;     // out of air: a long sit, then half a tank
const FAINT_AIR = 15 * HZ;
const BEHIND = 8;              // this many rows behind the deepest driller turns the drill up
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 150 * HZ;
const END_STEPS = 7 * HZ;

const IN = 0, WATCH = 1, DONE = 2;

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   cols: how wide the well is; fin: drillers at the bottom this round; g:
//   every cell, row by row; f: every cell's state, 0 at rest, a count of
//   steps while it shakes, -2 while it falls and dropped at the last drop,
//   -1 while it falls and has not; res: the last round's [id,
//   points it gave, points, rounds won, depth] rows; win: its winner
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, cols: colsFor(2), fin: 0, g: [], f: [], p: {}, res: null, win: -1 };
  lay(w);
  return w;
}

// A new well: colours that clump, a little stone that grows commoner the
// deeper it lies, and an air capsule somewhere in every six rows.
function lay(w) {
  const C = w.cols;
  w.g = new Array(C * H).fill(EMPTY);
  w.f = new Array(C * H).fill(0);
  for (let y = TOPAIR; y < H; y++) {
    const deep = (y - TOPAIR) / DEPTH;
    for (let x = 0; x < C; x++) {
      const i = y * C + x;
      if (y > TOPAIR + 1 && draw01(w) < 0.03 + 0.08 * deep) { w.g[i] = HARD1 + Math.floor(draw01(w) * 3); continue; }
      const left = x > 0 ? w.g[i - 1] : 0, up = w.g[i - C];
      // Clumps stay well short of joining up across the well, or one bite
      // would clear half of it.
      if (isColour(left) && draw01(w) < 0.25) w.g[i] = left;
      else if (isColour(up) && draw01(w) < 0.18) w.g[i] = up;
      else w.g[i] = 1 + Math.floor(draw01(w) * 4);
    }
  }
  for (let y = TOPAIR + 3; y + 6 <= H; y += 6) {
    const cy = y + Math.floor(draw01(w) * 6), cx = Math.floor(draw01(w) * C);
    w.g[cy * C + cx] = CAPSULE;
  }
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'm', 'mt', 'ux', 'uy', 'fc', 'hx', 'hy', 'dc', 'air', 'sn', 'ko', 'fo',
  'pts', 'wn', 'bw', 'bt', 'hs', 'hc'];
//   c: colour; s: seat; st: in the well, watching, or at the bottom; x, y: the
//   cell, or the one being moved into; m, mt: steps of that move left and its
//   length; ux, uy: the way it goes; fc: the way faced; hx, hy: the way the
//   hand pushes; dc: steps until the drill bites again; air: steps of breath
//   left; sn: steps of a daze left; ko: what dazed them, a block or no air;
//   fo: place at the bottom this round, -1 not there; pts: points; wn: rounds
//   won; bw, bt: the bot's pause and its way round stone; hs, hc: hands this
//   step.
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

function newPlayer(w) {
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: WATCH, x: 0, y: TOPAIR - 1, m: 0, mt: 1, ux: 0, uy: 0, fc: 1, hx: 0, hy: 0,
    dc: 0, air: AIR_MAX, sn: 0, ko: 0, fo: -1, pts: 0, wn: 0, bw: 0, bt: 1, hs: w.n, hc: 0,
  });
}

// Where a seat starts: spread across the top of the well.
const startX = (w, seat, n) => Math.floor(((2 * (seat % n) + 1) * w.cols) / (2 * n));

// A driller at the top of the well, still, with a full tank.
function placeAt(w, d, x) {
  d.st = IN;
  d.x = Math.max(0, Math.min(w.cols - 1, x));
  d.y = TOPAIR - 1;
  d.m = 0; d.mt = 1; d.ux = 0; d.uy = 0; d.fc = 1;
  d.dc = 0; d.air = AIR_MAX; d.sn = 0; d.ko = 0; d.fo = -1;
  d.bw = 0; d.bt = d.s % 2 ? -1 : 1;
}

// A hand, at its place in the room's order: [across, up or down], each -1, 0
// or 1. Being heard is how a player arrives: at the top of the well while the
// table waits for a round or counts one in, and watching while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w);
    if (w.ph === WAIT) placeAt(w, d, (d.s * 4 + 1) % w.cols);
    else if (w.ph === COUNT) placeAt(w, d, startX(w, d.s, playersIn(w).length));
    d.hx = input[0];
    d.hy = input[1];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; how fast anybody digs is the drill's to say.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.hx = input[0];
  d.hy = input[1];
}

// A hand off the wire, made safe: two whole numbers from -1 to 1, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [a, b] = raw;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < -1 || a > 1 || b < -1 || b > 1) return null;
  return [a, b];
}

function leave(w, id) {
  delete w.p[id];
}

// ── the cells ──────────────────────────────────────────────────────────────
const cellOf = (w, x, y) => (x < 0 || x >= w.cols || y < 0 || y >= H ? -1 : w.g[y * w.cols + x]);
// A cell a driller may move into: inside the well and empty.
const open = (w, x, y) => cellOf(w, x, y) === EMPTY;
// A cell that holds a driller up: a block, or the bedrock under the last row.
const solidUnder = (w, x, y) => y + 1 >= H || cellOf(w, x, y + 1) > EMPTY;

// The cells joined to one: a colour joins its own colour up, down and to the
// sides; stone and capsules stand alone. Walked in one order on every copy.
function groupOf(w, i) {
  const C = w.cols, v = w.g[i];
  if (!isColour(v)) return [i];
  const out = [i], seen = new Set([i]);
  for (let k = 0; k < out.length; k++) {
    const j = out[k], x = j % C;
    const near = [j - C, j + C, x > 0 ? j - 1 : -1, x < C - 1 ? j + 1 : -1];
    for (const n of near) {
      if (n < 0 || n >= w.g.length || seen.has(n) || w.g[n] !== v) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 5;           // steps between the bot's decisions
const BOT_IDLE = 0.08;         // how often it stands a moment rather than decide
const BOT_WANDER = 0.12;       // how often it digs sideways for no good reason
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot digs while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    const d = (w.p[BOT_ID] = newPlayer(w));
    placeAt(w, d, (d.s * 4 + 1) % w.cols);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Whether a column is about to rain on a cell: the first block above it, in
// reach, shakes or falls.
function underThreat(w, x, y) {
  for (let yy = y - 1; yy >= Math.max(0, y - 6); yy--) {
    const v = cellOf(w, x, yy);
    if (v > EMPTY) return w.f[yy * w.cols + x] !== 0;
  }
  return false;
}

function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== IN) return;
  if (d.bw > 0) { d.bw -= 1; d.hx = d.hy = 0; return; }
  if (w.n % BOT_EVERY !== 0 || d.m > 0 || d.sn > 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 3 + Math.floor(draw01(w) * 10); d.hx = d.hy = 0; return; }
  const { x, y } = d;
  // Something coming down: step aside to a column that is not.
  if (underThreat(w, x, y) && draw01(w) < 0.8) {
    for (const s of [d.bt, -d.bt]) {
      if (open(w, x + s, y) && !underThreat(w, x + s, y)) { d.hx = s; d.hy = 0; return; }
    }
  }
  // Short of air: a capsule close by is worth a detour.
  if (d.air < AIR_MAX * 0.35) {
    for (let dy = 0; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (cellOf(w, x + dx, y + dy) !== CAPSULE) continue;
        if (dx === 0) { d.hx = 0; d.hy = 1; } else { d.hx = dx > 0 ? 1 : -1; d.hy = 0; }
        return;
      }
    }
  }
  const below = cellOf(w, x, y + 1);
  // Stone underfoot is slow: round it, now and then, the way it last went.
  if (isHard(below) && below > HARD1 && draw01(w) < 0.7) {
    if (x + d.bt < 0 || x + d.bt >= w.cols) d.bt = -d.bt;
    d.hx = d.bt; d.hy = 0;
    return;
  }
  if (draw01(w) < BOT_WANDER) {
    d.bt = draw01(w) < 0.5 ? -1 : 1;
    if (x + d.bt >= 0 && x + d.bt < w.cols) { d.hx = d.bt; d.hy = 0; return; }
  }
  d.hx = 0;
  d.hy = 1;
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  w.fin = 0;
  w.cols = colsFor(2);
  lay(w);
  for (const id of bySeat(w)) { const d = w.p[id]; placeAt(w, d, (d.s * 4 + 1) % w.cols); }
}

// Practice, from the top: a new well, and everybody back at its mouth.
function freshWell(w) {
  lay(w);
  for (const id of bySeat(w)) { const d = w.p[id]; placeAt(w, d, (d.s * 4 + 1) % w.cols); }
  fx(w, 'fresh', 0, 0, 0);
}

// A round: a new well as wide as the players need, the seats closed up in
// order, everybody at the top with a full tank.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.fin = 0;
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  w.cols = colsFor(ids.length);
  lay(w);
  for (const id of ids) placeAt(w, w.p[id], startX(w, w.p[id].s, ids.length));
  fx(w, 'round', 0, 0, 0);
}

// How deep somebody got: the bottom counts deepest of all; a watcher, nothing.
const depthOf = (d) => (d.st === DONE ? H : d.st === IN ? d.y : -1);

// The round is over: a point for every driller you finished deeper than.
function finish(w) {
  const ids = bySeat(w).filter((id) => w.p[id].st !== WATCH);
  const gain = new Map();
  for (const id of ids) {
    let g = 0;
    for (const o of ids) if (o !== id && depthOf(w.p[o]) < depthOf(w.p[id])) g += 1;
    gain.set(id, g);
  }
  let top = -1;
  for (const id of ids) top = Math.max(top, depthOf(w.p[id]));
  const best = ids.filter((id) => depthOf(w.p[id]) === top);
  w.win = best.length === 1 ? best[0] : -1;
  for (const id of ids) w.p[id].pts += gain.get(id);
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, gain.get(id), w.p[id].pts, w.p[id].wn, Math.max(0, depthOf(w.p[id]) - TOPAIR + 1)]);
  res.sort((a, b) => b[4] - a[4] || b[2] - a[2] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, 0, w.win);
}

function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting table otherwise leaves at zero. The bot goes first, so
    // the round's seats close up without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go', 0, 0, 0); }
    } else if (w.ph === PLAY) {
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody digs while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) return;
  dig(w);
}

function dig(w) {
  botThink(w);
  const ids = bySeat(w);
  let deepest = -1;
  for (const id of ids) if (w.p[id].st === IN) deepest = Math.max(deepest, w.p[id].y);
  for (const id of ids) act(w, id, deepest);
  blocks(w);
  for (const id of ids) breathe(w, id, deepest);
  // The bottom: in practice a new well, in a round the end of it.
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== IN || d.m > 0 || d.y !== H - 1) continue;
    if (w.ph === WAIT) { fx(w, 'finish', d.x, d.y, 0, id); freshWell(w); return; }
    d.st = DONE;
    d.fo = w.fin++;
    fx(w, 'finish', d.x, d.y, 0, id);
  }
  if (w.ph === PLAY && w.fin > 0) finish(w);
}

// Turned up: a driller far enough behind the deepest one bites stone through
// in one go and breathes half as fast. Only in a round, where it is a race.
const boosted = (w, d, deepest) => w.ph === PLAY && d.st === IN && d.y + BEHIND <= deepest;

// One driller's step: a move under way runs on; with none, they drop if
// nothing holds them up, and otherwise do what the hand says — down drills
// down, a side walks or drills that way, up and a side climbs onto the block
// there when there is headroom and drills it when there is not, and up alone
// drills overhead.
function act(w, id, deepest) {
  const d = w.p[id];
  if (d.st !== IN) return;
  if (d.dc > 0) d.dc -= 1;
  if (d.m > 0 && --d.m > 0) return;
  if (d.sn > 0) d.sn -= 1;
  if (!solidUnder(w, d.x, d.y)) { move(d, 0, 1, FALL_T); return; }
  if (d.sn > 0) return;
  const { hx, hy } = d;
  if (hx) d.fc = hx;
  if (hy === 1 && cellOf(w, d.x, d.y + 1) > EMPTY) { bite(w, id, d.x, d.y + 1, deepest); return; }
  if (hy === -1 && hx) {
    if (cellOf(w, d.x + hx, d.y) > EMPTY && open(w, d.x, d.y - 1) && open(w, d.x + hx, d.y - 1)) { move(d, hx, -1, CLIMB_T); return; }
  }
  if (hx) {
    const v = cellOf(w, d.x + hx, d.y);
    if (v === EMPTY) move(d, hx, 0, WALK_T);
    else if (v > EMPTY) bite(w, id, d.x + hx, d.y, deepest);
    return;
  }
  if (hy === -1 && cellOf(w, d.x, d.y - 1) > EMPTY) bite(w, id, d.x, d.y - 1, deepest);
}

function move(d, dx, dy, t) {
  d.x += dx;
  d.y += dy;
  d.ux = dx;
  d.uy = dy;
  d.m = d.mt = t;
}

// The drill: a colour goes with every block of it that touches, a capsule
// fills the tank, and stone takes three bites and some breath — one, for a
// driller who is turned up.
function bite(w, id, x, y, deepest) {
  const d = w.p[id];
  if (d.dc > 0) return;
  d.dc = DRILL_T;
  const i = y * w.cols + x, v = w.g[i];
  if (v === CAPSULE) {
    w.g[i] = EMPTY; w.f[i] = 0;
    d.air = Math.min(AIR_MAX, d.air + CAPSULE_AIR);
    fx(w, 'air', x, y, 0, id);
  } else if (isHard(v)) {
    if (v === HARD1 || boosted(w, d, deepest)) { w.g[i] = EMPTY; w.f[i] = 0; fx(w, 'stone', x, y, 1, id); }
    else { w.g[i] = v - 1; fx(w, 'stone', x, y, 0, id); }
    d.air = Math.max(1, d.air - HARD_AIR);
  } else if (isColour(v)) {
    const cells = groupOf(w, i);
    for (const j of cells) { w.g[j] = EMPTY; w.f[j] = 0; }
    fx(w, 'drill', x, y, v, id, cells.length);
    for (let k = 0; k < Math.min(cells.length, 24); k++) {
      const j = cells[k];
      if (j !== i) fx(w, 'chunk', j % w.cols, Math.floor(j / w.cols), v);
    }
  }
}

function breathe(w, id, deepest) {
  const d = w.p[id];
  if (d.st !== IN || d.sn > 0) return;
  if (boosted(w, d, deepest) && w.n % 2) return;
  if (--d.air > 0) return;
  d.air = FAINT_AIR;
  d.sn = FAINT_STUN;
  d.ko = 2;
  fx(w, 'faint', d.x, d.y, 0, id);
}

// ── the blocks ─────────────────────────────────────────────────────────────
// Every step: the well's groups are found from the bottom up, and a group
// holds if it sits on the bedrock or on another group that holds. One that
// does not hold shakes for a second and then falls a cell at a time, all of
// it together; one that lands where its colour comes to POP_AT strong
// clears. A falling block that comes down on a driller shatters on them, and
// they sit dazed and short of breath.
function blocks(w) {
  const C = w.cols, N = C * H;
  const lab = new Int32Array(N).fill(-1);
  const groups = [];
  for (let y = H - 1; y >= 0; y--) {
    for (let x = 0; x < C; x++) {
      const i = y * C + x;
      if (w.g[i] === EMPTY || lab[i] >= 0) continue;
      const cells = groupOf(w, i);
      for (const j of cells) lab[j] = groups.length;
      groups.push(cells);
    }
  }
  const holds = new Uint8Array(groups.length);
  for (let more = true; more;) {
    more = false;
    for (let k = 0; k < groups.length; k++) {
      if (holds[k]) continue;
      for (const j of groups[k]) {
        const under = j + C;
        if (under >= N || (lab[under] >= 0 && lab[under] !== k && holds[lab[under]])) { holds[k] = 1; more = true; break; }
      }
    }
  }
  const falling = [];
  for (let k = 0; k < groups.length; k++) {
    const cells = groups[k];
    let fell = false, shook = 0;
    for (const j of cells) {
      if (w.f[j] < 0) fell = true;
      else if (w.f[j] > 0) shook = shook ? Math.min(shook, w.f[j]) : w.f[j];
    }
    if (holds[k]) {
      if (!fell && !shook) continue;
      for (const j of cells) w.f[j] = 0;
      if (!fell) continue;
      const low = Math.max(...cells);
      const v = w.g[cells[0]];
      if (isColour(v) && cells.length >= POP_AT) {
        for (const j of cells) w.g[j] = EMPTY;
        fx(w, 'pop', low % C, Math.floor(low / C), v, cells.length);
        for (let q = 0; q < Math.min(cells.length, 24); q++) fx(w, 'chunk', cells[q] % C, Math.floor(cells[q] / C), v);
      } else fx(w, 'thud', low % C, Math.floor(low / C), v, cells.length);
      continue;
    }
    // A group already falling keeps its cells' marks, which say whether it
    // moved at the last drop; one only shaking counts down, then falls.
    if (fell) {
      for (const j of cells) if (w.f[j] >= 0) w.f[j] = -1;
      falling.push(cells);
      continue;
    }
    let to;
    if (!shook) { to = WOB; fx(w, 'shake', cells[0] % C, Math.floor(cells[0] / C), w.g[cells[0]], cells.length); }
    else to = shook - 1 > 0 ? shook - 1 : -1;
    for (const j of cells) w.f[j] = to;
    if (to < 0) falling.push(cells);
  }
  if (w.n % BLOCK_FALL !== 0) return;
  // The lowest group first, so one falling on another's heels follows it down.
  falling.sort((a, b) => Math.max(...b) - Math.max(...a) || Math.min(...b) - Math.min(...a));
  for (const cells of falling) {
    const mine = new Set(cells);
    if (!cells.every((j) => j + C < N && (w.g[j + C] === EMPTY || mine.has(j + C)))) {
      for (const j of cells) w.f[j] = -1;
      continue;
    }
    const sorted = cells.slice().sort((a, b) => b - a);
    const vs = sorted.map((j) => w.g[j]);
    for (const j of sorted) { w.g[j] = EMPTY; w.f[j] = 0; }
    sorted.forEach((j, k) => {
      const n = j + C, x = n % C, y = Math.floor(n / C);
      for (const id of bySeat(w)) {
        const e = w.p[id];
        if (e.st !== IN || e.x !== x || e.y !== y) continue;
        // Once dazed, the rest of a column shatters on the helmet for
        // nothing, or a tall one would keep a driller down till it ran out.
        if (e.sn > 0) fx(w, 'chunk', x, y, vs[k]);
        else {
          e.sn = CRUSH_STUN;
          e.ko = 1;
          e.air = Math.max(1, e.air - CRUSH_AIR);
          fx(w, 'crush', x, y, vs[k], id);
        }
        return;
      }
      w.g[n] = vs[k];
      w.f[n] = -2;
    });
  }
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!COLS.includes(raw.cols) || !int(raw.fin, 0, MAX_P)) return null;
  const N = raw.cols * H;
  if (!Array.isArray(raw.g) || raw.g.length !== N || !Array.isArray(raw.f) || raw.f.length !== N) return null;
  for (let i = 0; i < N; i++) {
    if (!int(raw.g[i], EMPTY, HARD0) || !int(raw.f[i], -2, WOB)) return null;
    if (raw.g[i] === EMPTY && raw.f[i] !== 0) return null;
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
    if (!int(d.st, IN, DONE) || !int(d.x, 0, raw.cols - 1) || !int(d.y, 0, H - 1)) return null;
    if (!int(d.mt, 1, CLIMB_T) || !int(d.m, 0, d.mt) || !int(d.ux, -1, 1) || !int(d.uy, -1, 1) || !int(d.fc, -1, 1)) return null;
    if (inputOf([d.hx, d.hy]) === null || !int(d.dc, 0, DRILL_T) || !int(d.air, 0, AIR_MAX)) return null;
    if (!int(d.sn, 0, FAINT_STUN) || !int(d.ko, 0, 2) || !int(d.fo, -1, MAX_P)) return null;
    if (!int(d.pts, 0, 999999) || !int(d.wn, 0, 99999) || !int(d.bw, 0, 99) || !int(d.bt, -1, 1)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    if (d.st === IN && raw.g[d.y * raw.cols + d.x] !== EMPTY) return null;
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
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, cols: raw.cols, fin: raw.fin, g: raw.g.slice(), f: raw.f.slice(),
    p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, z, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, z, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 600) fxq.splice(0, fxq.length - 600);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a well cut through violet rock that darkens as it goes down,
// four candy colours of block, grey stone, cyan air, and a bright colour for
// each driller under a yellow helmet, ringed in ink so it reads on any block.
const INK = {
  page: '#1a1233', glow: '#33245e', text: '#ffffff', muted: '#d2c8f0', dim: '#9488bd', gold: '#ffd166',
  danger: '#ff5a6e', air: '#7cf0ff', outline: '#1a1430', panel: 'rgba(22,15,44,0.93)', rock: '#2a1d48',
  shallow: '#4a3878', deep: '#150d2b', sky: '#2e2b78', stone: '#8f8173', helmet: '#ffd166',
};
const BLOCK = ['', '#ff5d7a', '#ffc847', '#3fd9a4', '#4aa3ff'];
const SEAT = ['#ff4fd8', '#3fe0ff', '#f4f4ff', '#ff8a2e', '#a4ff3a', '#b07bff', '#ff3b3b', '#2effa8'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #54468c;' +
  `background:#2a1f52;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
const GAUGE = 38;
let VW = 640, VH = 400, TOP = 58, BOT = 26, dpx = 1;
let cs = 30, fx0 = 0, fieldTop = 58, fieldBot = 340, visRows = 10, camTop = null;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
}
layout();
window.addEventListener('resize', layout);

// The well is as wide as the frame allows with a gauge on either side, and at
// least ten rows tall; NOTE_ROOM under it keeps the practice note off the
// rows below your driller, and in a round the same strip says how you stand.
function fit(cols) {
  const ah = Math.max(80, VH - TOP - BOT - NOTE_ROOM - 4);
  const aw = Math.max(80, VW - 16 - 2 * GAUGE);
  cs = Math.max(6, Math.min(aw / cols, ah / 10));
  fieldTop = TOP + 2;
  fieldBot = fieldTop + ah;
  visRows = ah / cs;
  fx0 = Math.round((VW - cols * cs) / 2);
}

// Cells to the screen: a cell's top left corner, under the camera.
const SX = (x) => fx0 + x * cs + shakeX;
const SY = (y) => fieldTop + (y - camTop) * cs + shakeY;
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
function alpha(hex, a) {
  const c = rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function mix(a, b, k) {
  const p = rgb(a), q = rgb(b);
  return `rgb(${Math.round(p[0] + (q[0] - p[0]) * k)},${Math.round(p[1] + (q[1] - p[1]) * k)},${Math.round(p[2] + (q[2] - p[2]) * k)})`;
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
const PITCH = [0, 392, 494, 587, 698];
const sound = {
  drill(v, near, many) {
    if (!ready('drill', 50)) return;
    puff(0.09, 0.03 + 0.06 * near, 2400, 0, 1.6);
    tone(PITCH[v] || 440, 0.08, 'square', 0.025 + 0.04 * near, 0.7);
    if (many > 3) tone((PITCH[v] || 440) * 1.5, 0.14, 'triangle', 0.03 + 0.04 * near, 1.2, 0.05);
  },
  stone(broke, near) {
    if (!ready('stone', 60)) return;
    tone(broke ? 260 : 1300, broke ? 0.16 : 0.05, broke ? 'sine' : 'square', 0.03 + 0.05 * near, broke ? 0.5 : 0.9);
    puff(0.07, 0.03 + 0.05 * near, broke ? 500 : 3200, 0, 3);
  },
  air() { if (ready('air', 120)) [523, 784, 1047].forEach((f, i) => tone(f, 0.12, 'sine', 0.07, 1.3, i * 0.05)); },
  rattle(near) { if (ready('rattle', 160)) { puff(0.35, 0.02 + 0.05 * near, 220, 0, 3); puff(0.3, 0.015 + 0.03 * near, 700, 0.05, 4); } },
  thud(near) { if (ready('thud', 70)) { tone(85, 0.2, 'sine', 0.05 + 0.13 * near, 0.6); puff(0.16, 0.03 + 0.06 * near, 260, 0, 0.8); } },
  pop(n) { if (ready('pop', 90)) [659, 880, 1175].slice(0, n > 6 ? 3 : 2).forEach((f, i) => tone(f, 0.12, 'triangle', 0.07, 1.1, i * 0.05)); },
  crush(me) {
    if (!ready('crush', 90)) return;
    tone(me ? 330 : 260, me ? 0.4 : 0.25, 'sawtooth', me ? 0.07 : 0.04, 0.35);
    puff(0.18, me ? 0.12 : 0.06, 400, 0, 0.9);
  },
  faint(me) { if (ready('faint', 200)) [494, 415, 349, 294].forEach((f, i) => tone(f, 0.18, 'triangle', me ? 0.08 : 0.04, 0.9, i * 0.12)); },
  finish() { if (ready('finish', 400)) [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.09, 0, i * 0.07)); },
  fresh() { if (ready('fresh', 300)) [392, 523, 659, 784].forEach((f, i) => tone(f, 0.14, 'triangle', 0.08, 0, i * 0.06)); },
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
// fast screen and a slow one see the same dust. Positions are in cells, so a
// spray stays where it was made while the camera follows you down.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, g }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, g) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.4, life: 0, max: 18 + Math.random() * 22, size, colour, g: g === undefined ? 1 : g });
  }
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 15 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let j = 0; j < n; j++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.95;
      b.vy += (14 * b.g) / BIT_HZ;
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
const looks = new Map();      // id -> { squash, seen, spin }
let drawFailed = false;
let viewY = TOPAIR - 1;       // the row the camera follows, as drawn

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');

function play(e, t) {
  const me = myId();
  const near = Math.max(0, 1 - Math.abs(e.y - viewY) / 9);
  const X = e.x + 0.5, Y = e.y + 0.5;
  if (e.kind === 'drill') {
    spray(X, Y, 10, BLOCK[e.z], 5, 0.09);
    if (e.b >= 6) pop(X, Y, e.b + ' blocks!', BLOCK[e.z], 14);
    sound.drill(e.z, e.a === me ? 1 : near * 0.6, e.b);
  } else if (e.kind === 'chunk') {
    spray(X, Y, 3, BLOCK[e.z] || INK.stone, 4, 0.08);
  } else if (e.kind === 'stone') {
    spray(X, Y, e.z ? 12 : 5, INK.stone, e.z ? 6 : 3, 0.08);
    sound.stone(e.z === 1, e.a === me ? 1 : near * 0.5);
  } else if (e.kind === 'air') {
    ring(X, Y, INK.air, 1.4);
    spray(X, Y, 10, INK.air, 4, 0.07, -0.6);
    pop(X, Y, e.a === me ? '+air' : nickOf(e.a) + ' +air', INK.air, e.a === me ? 16 : 12);
    if (e.a === me || near > 0.5) sound.air();
  } else if (e.kind === 'shake') {
    if (near > 0.3) sound.rattle(near);
  } else if (e.kind === 'thud') {
    spray(X, Y + 0.4, 6, '#d9c9ff', 3, 0.07, 0.4);
    shake = Math.max(shake, Math.min(8, 1 + e.b * 0.6) * near);
    sound.thud(near);
  } else if (e.kind === 'pop') {
    ring(X, Y, BLOCK[e.z], 1.8);
    pop(X, Y, 'pop!', BLOCK[e.z], 16);
    sound.pop(e.b);
  } else if (e.kind === 'crush') {
    spray(X, Y, 14, BLOCK[e.z] || INK.stone, 6, 0.1);
    pop(X, Y, e.a === me ? 'ouch!' : nickOf(e.a) + ' squashed', colourOf(t, e.a), e.a === me ? 18 : 13);
    const look = looks.get(e.a);
    if (look) look.squash = 1;
    if (e.a === me) shake = Math.max(shake, 12);
    sound.crush(e.a === me);
  } else if (e.kind === 'faint') {
    pop(X, Y, e.a === me ? 'out of air!' : nickOf(e.a) + ' ran out of air', INK.danger, e.a === me ? 18 : 13);
    sound.faint(e.a === me);
  } else if (e.kind === 'finish') {
    for (let i = 1; i <= 4; i++) spray(X, Y, 10, BLOCK[i], 7, 0.09);
    pop(X, Y - 1, e.a === me ? 'you hit the bottom!' : nickOf(e.a) + ' hit the bottom!', colourOf(t, e.a), 18);
    sound.finish();
  } else if (e.kind === 'fresh') {
    pop(t.cols / 2, TOPAIR - 1, 'a fresh well', INK.gold, 20);
    sound.fresh();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

// The rock round the well and the well's own back wall, which darkens the
// deeper it goes; the open sky over its mouth; the bedrock with the finish
// line under it.
function drawGround(t, now) {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.4, 10, VW / 2, VH * 0.4, Math.max(VW, VH) * 0.8);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  const w = t.cols * cs;
  ctx.save();
  roundRect(fx0 - 4, fieldTop - 4, w + 8, fieldBot - fieldTop + 8, 12);
  ctx.fillStyle = INK.rock;
  ctx.fill();
  ctx.beginPath();
  ctx.rect(fx0, fieldTop, w, fieldBot - fieldTop);
  ctx.clip();
  const d0 = Math.max(0, Math.min(1, (camTop - TOPAIR) / DEPTH)), d1 = Math.max(0, Math.min(1, (camTop + visRows - TOPAIR) / DEPTH));
  const back = ctx.createLinearGradient(0, fieldTop, 0, fieldBot);
  back.addColorStop(0, mix(INK.shallow, INK.deep, d0));
  back.addColorStop(1, mix(INK.shallow, INK.deep, d1));
  ctx.fillStyle = back;
  ctx.fillRect(fx0, fieldTop, w, fieldBot - fieldTop);
  // Strata: faint bands across the back wall, every few rows.
  for (let y = Math.floor(camTop) - 1; y < camTop + visRows + 1; y++) {
    if (y < TOPAIR || y % 3) continue;
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(fx0, SY(y), w, cs * 0.5);
  }
  if (camTop < TOPAIR) {
    const sky = ctx.createLinearGradient(0, SY(0), 0, SY(TOPAIR));
    sky.addColorStop(0, '#191654');
    sky.addColorStop(1, INK.sky);
    ctx.fillStyle = sky;
    ctx.fillRect(fx0, SY(-2), w, (TOPAIR + 2) * cs);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < 14; i++) {
      const sx = fx0 + ((i * 97) % 100) / 100 * w, sy = SY(-1 + ((i * 53) % 100) / 100 * (TOPAIR + 0.5));
      disc(sx, sy, 0.6 + (i % 3) * 0.4 + 0.3 * Math.sin(now / 400 + i));
      ctx.fill();
    }
  }
  if (camTop + visRows > H) {
    const y = SY(H);
    ctx.fillStyle = '#0d0820';
    ctx.fillRect(fx0, y, w, cs * 2);
    const n = t.cols * 2;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i % 2 ? INK.gold : '#20183c';
      ctx.fillRect(fx0 + (i * w) / n, y, w / n + 0.5, cs * 0.16);
      ctx.fillStyle = i % 2 ? '#20183c' : INK.gold;
      ctx.fillRect(fx0 + (i * w) / n, y + cs * 0.16, w / n + 0.5, cs * 0.16);
    }
    text('the bottom', fx0 + w / 2, y + cs * 0.95, Math.max(10, cs * 0.4), INK.gold, 'center');
  }
  ctx.restore();
}

// One block. Colours sit as rounded tiles, bridged to the same colour beside
// and under them, so a group reads as one shape and you can see what one bite
// takes. Stone is grey and cracks as it is bitten; a capsule is a pill of air.
function drawBlocks(t, nShown, now) {
  const C = t.cols, w = C * cs;
  ctx.save();
  ctx.beginPath();
  ctx.rect(fx0, fieldTop, w, fieldBot - fieldTop);
  ctx.clip();
  const mv = t.n - (t.n % BLOCK_FALL);
  const drop = Math.max(0, Math.min(1, (nShown - mv) / BLOCK_FALL));
  const y0 = Math.max(0, Math.floor(camTop) - 1), y1 = Math.min(H - 1, Math.ceil(camTop + visRows) + 1);
  const pad = Math.max(1, cs * 0.07), r = cs * 0.24;
  const at = (x, y) => {
    const i = y * C + x, f = t.f[i];
    let ox = 0, oy = 0;
    if (f > 0) ox = Math.sin(now / 28 + x * 1.7 + y * 2.3) * cs * 0.07 * (1 - f / WOB + 0.3);
    else if (f === -2) oy = (drop - 1) * cs;
    return [SX(x) + ox, SY(y) + oy];
  };
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < C; x++) {
      const i = y * C + x, v = t.g[i];
      if (v === EMPTY) continue;
      const [px, py] = at(x, y);
      if (isColour(v)) {
        const base = BLOCK[v];
        ctx.fillStyle = darker(base, 0.28);
        roundRect(px + pad, py + pad, cs - 2 * pad, cs - 2 * pad, r);
        ctx.fill();
        // Bridges to the same colour right and below, in the same state.
        if (x + 1 < C && t.g[i + 1] === v && t.f[i + 1] === t.f[i]) ctx.fillRect(px + cs - pad - r, py + pad, 2 * (pad + r), cs - 2 * pad);
        if (y + 1 < H && t.g[i + C] === v && t.f[i + C] === t.f[i]) ctx.fillRect(px + pad, py + cs - pad - r, cs - 2 * pad, 2 * (pad + r));
      } else if (isHard(v)) {
        ctx.fillStyle = darker(INK.stone, 0.35);
        roundRect(px + pad * 0.5, py + pad * 0.5, cs - pad, cs - pad, r * 0.5);
        ctx.fill();
      }
    }
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < C; x++) {
      const i = y * C + x, v = t.g[i];
      if (v === EMPTY) continue;
      const [px, py] = at(x, y);
      if (isColour(v)) {
        const base = BLOCK[v];
        ctx.fillStyle = base;
        const right = x + 1 < C && t.g[i + 1] === v && t.f[i + 1] === t.f[i];
        const below = y + 1 < H && t.g[i + C] === v && t.f[i + C] === t.f[i];
        roundRect(px + pad, py + pad, cs - 2 * pad, cs - 2 * pad - cs * 0.1, r);
        ctx.fill();
        if (right) ctx.fillRect(px + cs - pad - r, py + pad, 2 * (pad + r), cs - 2 * pad - cs * 0.1);
        if (below) ctx.fillRect(px + pad, py + cs - pad - r - cs * 0.1, cs - 2 * pad, 2 * (pad + r) + cs * 0.1);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        roundRect(px + cs * 0.2, py + cs * 0.17, cs * 0.26, cs * 0.12, cs * 0.06);
        ctx.fill();
        if (t.f[i] > 0) {
          ctx.strokeStyle = `rgba(255,255,255,${(0.35 + 0.3 * Math.sin(now / 60)).toFixed(3)})`;
          ctx.lineWidth = Math.max(1, cs * 0.05);
          roundRect(px + pad * 1.5, py + pad * 1.5, cs - 3 * pad, cs - 3 * pad, r);
          ctx.stroke();
        }
      } else if (isHard(v)) {
        ctx.fillStyle = INK.stone;
        roundRect(px + pad * 0.5, py + pad * 0.5, cs - pad, cs - pad - cs * 0.1, r * 0.5);
        ctx.fill();
        ctx.strokeStyle = 'rgba(40,30,30,0.55)';
        ctx.lineWidth = Math.max(1, cs * 0.06);
        ctx.beginPath();
        ctx.moveTo(px + cs * 0.28, py + cs * 0.25); ctx.lineTo(px + cs * 0.72, py + cs * 0.65);
        ctx.moveTo(px + cs * 0.72, py + cs * 0.25); ctx.lineTo(px + cs * 0.28, py + cs * 0.65);
        // A crack for every bite it has taken.
        const bitten = HARD0 - v;
        if (bitten >= 1) { ctx.moveTo(px + cs * 0.1, py + cs * 0.5); ctx.lineTo(px + cs * 0.3, py + cs * 0.42); ctx.lineTo(px + cs * 0.38, py + cs * 0.8); }
        if (bitten >= 2) { ctx.moveTo(px + cs * 0.9, py + cs * 0.3); ctx.lineTo(px + cs * 0.66, py + cs * 0.46); ctx.lineTo(px + cs * 0.8, py + cs * 0.82); }
        ctx.stroke();
        if (t.f[i] > 0) { ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1; roundRect(px + pad, py + pad, cs - 2 * pad, cs - 2 * pad, r * 0.5); ctx.stroke(); }
      } else if (v === CAPSULE) {
        const bob = Math.sin(now / 300 + x + y) * cs * 0.05;
        const cxp = px + cs / 2, cyp = py + cs / 2 + bob;
        ctx.fillStyle = alpha(INK.air, 0.18);
        disc(cxp, cyp, cs * 0.46);
        ctx.fill();
        ctx.fillStyle = INK.outline;
        roundRect(cxp - cs * 0.36, cyp - cs * 0.2, cs * 0.72, cs * 0.4, cs * 0.2);
        ctx.fill();
        ctx.fillStyle = INK.air;
        roundRect(cxp - cs * 0.32, cyp - cs * 0.16, cs * 0.64, cs * 0.32, cs * 0.16);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        roundRect(cxp - cs * 0.32, cyp - cs * 0.16, cs * 0.32, cs * 0.32, cs * 0.16);
        ctx.fill();
        if (cs >= 22) text('air', cxp + cs * 0.15, cyp + cs * 0.08, cs * 0.22, INK.outline, 'center');
      }
    }
  }
  ctx.restore();
}

// A driller: a round body in its seat's colour under a yellow helmet with a
// lamp, a drill out the way it pushes, spinning when it bites; stars over it
// while dazed. Positions are in cells, the middle of the cell it stands in.
function drawDriller(id, x, y, d, colour, me, now) {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { squash: 0, seen: now, spin: 0 }));
  look.seen = now;
  look.squash *= Math.pow(0.88, frameDt * 60);
  const r = cs * 0.34;
  const sx = SX(x + 0.5), sy = SY(y + 0.5) + cs * 0.06;
  const sq = look.squash;
  let dx = d.hx, dy = d.hy;
  if (dy === 1 || (dy === -1 && !dx)) dx = 0;
  else { dy = 0; if (!dx) dx = d.fc || 1; }
  const biting = d.hx || d.hy;
  if (biting && d.sn === 0) look.spin += frameDt * 30;
  // The drill first, so the body sits on its base.
  const ang = Math.atan2(dy, dx);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(ang);
  ctx.fillStyle = INK.outline;
  ctx.beginPath();
  ctx.moveTo(r * 0.5, -r * 0.48); ctx.lineTo(r * 1.62, 0); ctx.lineTo(r * 0.5, r * 0.48);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#d7dbe8';
  ctx.beginPath();
  ctx.moveTo(r * 0.55, -r * 0.38); ctx.lineTo(r * 1.5, 0); ctx.lineTo(r * 0.55, r * 0.38);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#7d8296';
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const u = ((look.spin * 0.12 + k / 3) % 1);
    const px = r * (0.6 + u * 0.85), half = r * 0.38 * (1 - u * 0.95);
    ctx.moveTo(px, -half); ctx.lineTo(px + r * 0.12, half);
  }
  ctx.stroke();
  ctx.restore();
  // The body.
  const rx = r * (1 + sq * 0.35), ry = r * (1 - sq * 0.3);
  ctx.fillStyle = INK.outline;
  ctx.beginPath(); ctx.ellipse(sx, sy, rx + 2, ry + 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = darker(colour, 0.25);
  ctx.beginPath(); ctx.ellipse(sx, sy + 1, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.ellipse(sx, sy - 1, rx * 0.96, ry * 0.92, 0, 0, Math.PI * 2); ctx.fill();
  // The helmet and its lamp.
  ctx.fillStyle = INK.outline;
  ctx.beginPath(); ctx.ellipse(sx, sy - ry * 0.25, rx * 1.06, ry * 0.9, 0, Math.PI, 0); ctx.fill();
  ctx.fillStyle = INK.helmet;
  ctx.beginPath(); ctx.ellipse(sx, sy - ry * 0.3, rx * 0.98, ry * 0.8, 0, Math.PI, 0); ctx.fill();
  ctx.fillRect(sx - rx * 1.08, sy - ry * 0.32, rx * 2.16, Math.max(1.5, ry * 0.14));
  ctx.fillStyle = '#fffbe0';
  disc(sx + (d.fc || 1) * rx * 0.3, sy - ry * 0.72, r * 0.16);
  ctx.fill();
  // Eyes, the way it faces; crosses while dazed.
  const ex = (d.fc || 1) * r * 0.18;
  for (const side of [-1, 1]) {
    const px = sx + ex + side * r * 0.3, py = sy + ry * 0.12;
    if (d.sn > 0) {
      ctx.strokeStyle = INK.outline;
      ctx.lineWidth = Math.max(1.2, r * 0.1);
      ctx.beginPath();
      ctx.moveTo(px - r * 0.11, py - r * 0.11); ctx.lineTo(px + r * 0.11, py + r * 0.11);
      ctx.moveTo(px + r * 0.11, py - r * 0.11); ctx.lineTo(px - r * 0.11, py + r * 0.11);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#ffffff';
      disc(px, py, r * 0.17);
      ctx.fill();
      ctx.fillStyle = INK.outline;
      disc(px + (d.fc || 1) * r * 0.05 + dx * r * 0.03, py + dy * r * 0.05, r * 0.09);
      ctx.fill();
    }
  }
  if (d.sn > 0) {
    if (d.ko === 2) text('z z', sx + r, sy - r * 1.6 - Math.sin(now / 300) * 3, Math.max(9, r * 0.8), INK.air, 'center');
    else {
      for (let k = 0; k < 3; k++) {
        const a = now / 180 + (k * Math.PI * 2) / 3;
        ctx.fillStyle = INK.gold;
        disc(sx + Math.cos(a) * r * 0.9, sy - r * 1.25 + Math.sin(a) * r * 0.25, Math.max(1.5, r * 0.13));
        ctx.fill();
      }
    }
  }
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(sx, sy, rx + 5, ry + 5, 0, 0, Math.PI * 2); ctx.stroke();
  }
  const px = Math.max(9, Math.min(13, r * 0.75));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(20,14,40,0.8)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  ctx.strokeText(label, sx, sy - ry - r * 0.55);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, sx, sy - ry - r * 0.55);
}

// A driller out of sight: an arrow on the edge of the well, in its column.
function drawAway(id, x, y, colour) {
  const above = y < camTop + 0.3;
  const sx = Math.max(fx0 + 8, Math.min(fx0 + cs * (x + 0.5), VW - 8));
  const sy = above ? fieldTop + 9 : fieldBot - 9;
  ctx.fillStyle = INK.outline;
  ctx.beginPath();
  ctx.moveTo(sx, sy + (above ? -8 : 8)); ctx.lineTo(sx - 8, sy + (above ? 4 : -4)); ctx.lineTo(sx + 8, sy + (above ? 4 : -4));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(sx, sy + (above ? -5 : 5)); ctx.lineTo(sx - 5, sy + (above ? 2 : -2)); ctx.lineTo(sx + 5, sy + (above ? 2 : -2));
  ctx.closePath();
  ctx.fill();
}

function drawBits() {
  flat();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, fieldTop - 4, VW, fieldBot - fieldTop + 8);
  ctx.clip();
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    const s = b.size * cs * (1 - f * 0.5);
    ctx.fillRect(SX(b.x) - s / 2, SY(b.y) - s / 2, s, s);
  }
  for (const r of rings) {
    const f = r.life / r.max;
    ctx.globalAlpha = (1 - f) * 0.75;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - f) + 1;
    disc(SX(r.x), SY(r.y), r.r * cs * ease(f));
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const f = p.life / p.max;
    const rise = 14 + ease(f) * 26;
    const scale = f < 0.15 ? 0.6 + (f / 0.15) * 0.5 : 1.1 - Math.min(0.1, f - 0.15);
    ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
    ctx.font = font(p.px * scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(20,14,40,0.85)';
    const X = Math.max(70, Math.min(VW - 70, SX(p.x))), Y = Math.max(fieldTop + 18, Math.min(fieldBot - 4, SY(p.y) - rise));
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
const metres = (d) => Math.max(0, d - TOPAIR + 1);

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
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left · first to the bottom wins';
    if (t.pt <= 20 * HZ) colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('plunge', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('plunge').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points, and how
  // deep they are under it while a round is on.
  const ids = bySeat(t);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(140, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      disc(x + 11, y - 2, 5);
      if (d.st !== WATCH) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      let score = t.ph === WAIT ? metres(d.y) + 'm' : String(d.pts);
      if (d.st === WATCH) score = t.ph === WAIT ? '' : score;
      ctx.font = font(12);
      const sw = score ? ctx.measureText(score).width : 0;
      if (score) text(score, x + cw - 8, y + 3, 12, t.ph === WAIT ? INK.muted : INK.gold, 'right');
      if (cw > 46) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st !== WATCH ? (mine ? INK.text : INK.muted) : INK.dim, cw - 30 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to dig that way · drag up and aside to climb · a colour goes all at once'
    : 'arrows/WASD or hold the mouse: dig the way you push · up+side climbs · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// The gauges either side of the well: your air on the left, and on the right
// how deep every driller is, from the mouth to the bottom.
function drawGauges(t, now) {
  flat();
  const me = myId();
  const d = t.p[me];
  const gy0 = fieldTop + 22, gy1 = fieldBot - 8, gh = Math.max(20, gy1 - gy0);
  const lx = fx0 - 4 - GAUGE / 2, rx = fx0 + t.cols * cs + 4 + GAUGE / 2;
  if (d && d.st === IN) {
    const k = Math.max(0, Math.min(1, d.air / AIR_MAX));
    const low = k < 0.25;
    text('air', lx, fieldTop + 12, 11, low ? INK.danger : INK.air, 'center');
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(lx - 7, gy0, 14, gh, 7);
    ctx.fill();
    ctx.fillStyle = low && Math.floor(now / 250) % 2 ? INK.danger : mix(INK.danger, INK.air, Math.min(1, k * 2.5));
    roundRect(lx - 5, gy0 + 2 + (gh - 4) * (1 - k), 10, (gh - 4) * k, 5);
    ctx.fill();
    if (boosted(t, d, deepestOf(t))) {
      ctx.fillStyle = INK.gold;
      disc(lx, gy1 + 2, 4);
      ctx.fill();
    }
  }
  text('depth', rx, fieldTop + 12, 11, INK.muted, 'center');
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(rx, gy0); ctx.lineTo(rx, gy1); ctx.stroke();
  for (let m = 0; m <= DEPTH; m += 15) {
    const y = gy0 + (gh * m) / DEPTH;
    ctx.beginPath(); ctx.moveTo(rx - 4, y); ctx.lineTo(rx + 4, y); ctx.stroke();
  }
  ctx.fillStyle = INK.gold;
  ctx.fillRect(rx - 8, gy1 - 1, 16, 3);
  // What the screen shows, as a band on the gauge.
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  const vb0 = gy0 + (gh * Math.max(0, camTop - TOPAIR + 1)) / DEPTH, vb1 = gy0 + (gh * Math.max(0, camTop + visRows - TOPAIR + 1)) / DEPTH;
  ctx.fillRect(rx - 9, Math.max(gy0, vb0), 18, Math.max(2, Math.min(gy1, vb1) - Math.max(gy0, vb0)));
  const ids = bySeat(t).filter((id) => t.p[id].st !== WATCH);
  ids.sort((a, b) => (a === me) - (b === me));
  ids.forEach((id, k) => {
    const e = t.p[id];
    const y = gy0 + (gh * Math.min(DEPTH, metres(e.st === DONE ? H - 1 : e.y))) / DEPTH;
    const off = id === me ? 0 : ((k % 3) - 1) * 5;
    ctx.fillStyle = INK.outline;
    disc(rx + off, y, id === me ? 7 : 5.5);
    ctx.fill();
    ctx.fillStyle = SEAT[e.c];
    disc(rx + off, y, id === me ? 5 : 4);
    ctx.fill();
    if (id === me) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; disc(rx, y, 8); ctx.stroke(); }
  });
}

function deepestOf(t) {
  let deepest = -1;
  for (const id of playersIn(t)) if (t.p[id].st === IN) deepest = Math.max(deepest, t.p[id].y);
  return deepest;
}

// How you stand, in the strip under the well while a round is on.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = Math.min(fieldBot + NOTE_ROOM / 2 + 5, VH - BOT - 12);
  let line = '', colour = INK.text;
  if (d.st === WATCH) line = t.ph === END ? '' : 'watching · you dig from the next round';
  else if (d.st === DONE) line = 'you reached the bottom!';
  else if (t.ph === COUNT) line = 'get ready · ' + (t.cols) + ' wide, ' + DEPTH + ' m down';
  else {
    line = metres(d.y) + ' m down · ' + Math.ceil(d.air / HZ) + ' s of air';
    if (d.sn > 0) { line += d.ko === 2 ? ' · catching your breath' : ' · dazed'; colour = INK.danger; }
    else if (boosted(t, d, deepestOf(t))) { line += ' · turbo drill: stone in one bite, slow breath'; colour = INK.gold; }
  }
  if (line) fitText(line, VW / 2, y, 13, colour, VW - 24);
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


function panel(px, py, w, h) {
  ctx.fillStyle = INK.panel;
  roundRect(px - w / 2, py - h / 2, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawOverlay(t, now) {
  flat();
  const cx = VW / 2;
  const mid = (fieldTop + fieldBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'push into a block to drill it · its whole colour goes · what it held up falls';
    practiceNote(now, VW, head, tip, [[fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,14,40,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 300), 30);
    fitText('first to the bottom takes the round', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 280));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,14,40,0.6)';
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
    const bottom = t.win !== -1 && t.p[t.win] && t.p[t.win].st === DONE;
    if (t.win === -1) head = 'a tie · nobody got deeper';
    else if (t.win === me) head = bottom ? 'you hit the bottom first!' : 'you dug the deepest!';
    else head = nickOf(t.win) + (bottom ? ' hit the bottom first' : ' dug the deepest');
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('depth', cx + w / 2 - 118, y0 + 52, 10, INK.dim, 'right');
    text('this round', cx + w / 2 - 64, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 16, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, gain, pts, wins, depth], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 200, 'left');
      text(depth >= DEPTH ? 'bottom' : depth + ' m', cx + w / 2 - 118, y, 13, INK.muted, 'right');
      text('+' + gain, cx + w / 2 - 64, y, 14, INK.text, 'right');
      text(String(pts), cx + w / 2 - 16, y, 14, INK.gold, 'right');
    });
    fitText('a point for every driller you end deeper than · next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where somebody is as drawn, in cells: part way through the move they are
// making, between two steps, and never slid across a jump — a driller put
// back at the top of a fresh well.
const posOf = (d) => [d.x - (d.ux * d.m) / d.mt, d.y - (d.uy * d.m) / d.mt];
function posAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  const q = posOf(z);
  if (!a || a.st !== z.st) return q;
  const p = posOf(a);
  if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > 2.5) return q;
  return [lerp(p[0], q[0], b.k), lerp(p[1], q[1], b.k)];
}

// Your own driller is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a push a step away from
// where the guess had it. So the driller drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a driller put back — puts it there at once. Only the drawing
// is smoothed: the well, and every rule in it, are untouched.
const PULL = 0.5;
let shown = null;        // [x, y] in cells: where your driller is drawn
let myPos = null;

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 2) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  const b = agreedAt(now);
  fit(b ? b.to.cols : 9);
  if (camTop === null) camTop = -0.5;
  if (!b) {
    drawGround({ cols: 9 }, now);
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the well…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a table this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const me = myId();
  const m = mineAt(now);
  // The blocks are drawn from the same table as your own driller, so a bite
  // of yours opens the cell as you move into it, not a trip later.
  const own = m && m.to.p[me] && m.to.cols === t.cols ? m : null;
  const grid = own ? own.to : t;
  const nGrid = own ? own.from.n + (own.to.n - own.from.n) * own.k : nShown;
  let mineD = null;
  if (own && own.to.p[me].st !== WATCH) {
    const p = posAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    myPos = [x, y];
    mineD = own.to.p[me];
    viewY = y;
  } else {
    myPos = shown = null;
    let deepest = -1;
    for (const id of playersIn(t)) if (t.p[id].st !== WATCH) deepest = Math.max(deepest, t.p[id].y);
    viewY = deepest >= 0 ? deepest : TOPAIR - 1;
  }
  // The camera keeps you a little above the middle, where you see most of
  // what lies below; a jump of more than a screen it makes at once.
  const want = Math.max(-0.6, Math.min(H + 1.2 - visRows, viewY + 0.5 - visRows * 0.42));
  camTop = Math.abs(want - camTop) > visRows ? want : camTop + (want - camTop) * per60(0.18);
  drawGround(t, now);
  drawBlocks(grid, nGrid, now);
  flat();
  ctx.save();
  ctx.beginPath();
  ctx.rect(fx0 - 2, fieldTop, t.cols * cs + 4, fieldBot - fieldTop);
  ctx.clip();
  const away = [];
  for (const id of bySeat(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st === WATCH) continue;
    const p = posAt(b, id);
    if (p[1] + 1 < camTop || p[1] > camTop + visRows) { away.push([id, p, d]); continue; }
    drawDriller(id, p[0], p[1], d, SEAT[d.c], false, now);
  }
  if (myPos && mineD) drawDriller(me, myPos[0], myPos[1], mineD, SEAT[mineD.c], true, now);
  for (const [id, p, d] of away) drawAway(id, p[0], p[1], SEAT[d.c]);
  ctx.restore();
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawGauges(t, now);
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way pushed, one of eight or none, as [across, up or
// down]. It changes only when the way does, and goes out no oftener than
// STEER_EVERY, because a thumb wandering across a sector's edge would
// otherwise say it on every move the screen reports.
const STEER_EVERY = 80;
let mode = '';           // what steers: 'keys', 'mouse', 'touch', or nothing yet
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_DIR = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

// One of eight ways, from a drag or a pointer: straight within a little over
// twenty degrees of an axis, otherwise diagonal.
function quant(dx, dy) {
  if (Math.abs(dx) > 2.414 * Math.abs(dy)) return [sgn(dx), 0];
  if (Math.abs(dy) > 2.414 * Math.abs(dx)) return [0, sgn(dy)];
  return [sgn(dx), sgn(dy)];
}

// A thumb: a stick from wherever it lands, read once it is pushed past a
// little dead zone — a drag rather than a press, because iOS keeps a long
// press inside a frame for itself. A mouse: held down, your driller pushes
// toward the pointer.
const DEAD = 14;
const REACHOUT = 46;
let stick = null;        // { id, ox, oy, dx, dy }
const mouse = { x: 0, y: 0, down: false };

function steerNow() {
  if (mode === 'keys') {
    let x = 0, y = 0;
    for (const c of keys) { x += KEY_DIR[c][0]; y += KEY_DIR[c][1]; }
    return [sgn(x), sgn(y)];
  }
  if (mode === 'touch') {
    if (!stick || Math.hypot(stick.dx, stick.dy) < DEAD) return [0, 0];
    return quant(stick.dx, stick.dy);
  }
  if (mode === 'mouse' && mouse.down && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0] + 0.5), dy = mouse.y - r.top - SY(myPos[1] + 0.5);
    if (Math.hypot(dx, dy) < cs * 0.45) return [0, 0];
    return quant(dx, dy);
  }
  return [0, 0];
}

function sayHand(now, force) {
  const h = steerNow(), s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1]) return;
  if (!force && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (!(e.code in KEY_DIR)) return;
  e.preventDefault();
  coarse = false;
  mode = 'keys';
  keys.add(e.code);
  sayHand(performance.now(), true);
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  sayHand(performance.now(), true);
});
addEventListener('blur', () => {
  keys.clear();
  stick = null;
  paintStick();
  mouse.down = false;
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    mode = 'touch';
    if (stick) return;
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
    paintStick();
    return;
  }
  coarse = false;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mode = 'mouse';
  mouse.down = true;
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  sayHand(performance.now(), true);
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    stick.dx = e.clientX - stick.ox;
    stick.dy = e.clientY - stick.oy;
    paintStick();
    sayHand(performance.now(), false);
  } else if (e.pointerType === 'mouse') {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
});
function liftPointer(e) {
  if (stick && e.pointerId === stick.id) {
    stick = null;
    paintStick();
  } else if (e.pointerType === 'mouse') mouse.down = false;
  sayHand(performance.now(), true);
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', liftPointer);
addEventListener('pointerup', liftPointer);
addEventListener('pointercancel', liftPointer);

const stickRing = document.createElement('div');
stickRing.style.cssText =
  `position:fixed;display:none;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
  `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;pointer-events:none;` +
  'border:1px solid rgba(255,255,255,0.35);background:rgba(255,255,255,0.06)';
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  'border-radius:50%;pointer-events:none;background:#ffffff;opacity:.55';
document.body.append(stickRing, knob);

function paintStick() {
  if (!stick) { stickRing.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(stick.dx, stick.dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
  stickRing.style.display = knob.style.display = 'block';
  stickRing.style.left = stick.ox + 'px';
  stickRing.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + stick.dx * k + 'px';
  knob.style.top = stick.oy + stick.dy * k + 'px';
}

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  sayHand(now, false);
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a player arrives at the well.
function start() {
  setHand([0, 0]);
  lastSaid = [0, 0];
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
