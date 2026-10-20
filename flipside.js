/**
 * @disk     flipside
 * @author   claude
 * @version  2
 * @players  2-8
 * @about    A one-button race through a tunnel where gravity is yours to flip. Tap to fall to the ceiling and back, ride whichever side has ground, and land on a rival to flip them into a gap. The screen never waits: fall behind it and you are out.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/flipside.png
 */
// flipside.js — a race through one tunnel, where the room's order is the
// referee.
//
// Every copy holds the stretch of tunnel on screen and a little either side of
// it, every runner, which way gravity pulls them and how fast they fall, and
// changes it only on what comes back round the room, so every copy applies the
// same hands in the same order and holds the same tunnel. Nobody sends where
// they are, that they landed or who fell: a hand is a counter that moves on by
// one for every flip asked for. Everything else is the same arithmetic on the
// same whole numbers on every machine. A page with a console open can flip its
// own gravity whenever it likes, but no oftener than standing on ground or a
// wing in hand lets anybody, and it runs no faster than everybody runs.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own runner does not wait for the trip: it is drawn from the agreed
// table played forward by the trip, with your flips already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — a cell of the tunnel is 64 units
// across, a speed is units a step — and use nothing but `+ - * /`,
// comparisons, `Math.floor`, `Math.min`, `Math.max`, `Math.abs` and
// `Math.imul`, whose results the language fixes to the last bit. Nothing in a
// step needs a curve, so no trigonometry appears outside the drawing.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (w, n) => Math.floor(draw01(w) * n);

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own runner a trip ahead, with your flips in it

// The tunnel: columns of ten cells, each cell solid or open, kept as a bit
// mask a column. Row 0 is the ceiling and row 9 the floor; a runner lives in
// the eight rows between, and leaving them through a gap is falling out.
const CELL = 64;               // units across a cell
const ROWS = 10;
const FLOOR = 1 << (ROWS - 1), CEIL = 1, BOTH = FLOOR | CEIL;
const VIEWC = 16;              // columns the screen shows
const LEAD = 6 * CELL;         // the front runner pulls the screen along this far from its left edge
const AHEAD = VIEWC + 10;      // columns the tunnel is laid ahead of the left edge
const BEHIND = 2;              // and kept behind it
const COLS_MAX = 72;           // the most columns a table holds at once
const PW = 46, PH = 46;        // a runner's box, in units
const GRAV = 4;                // units a step a runner's fall speeds up by
const VMAX = 40;               // and the fastest it falls
const KICK = 6;                // the push a flip starts with
const SPEED0 = 10;             // units a step the screen moves at the start of a round
const SPEED_MAX = 18;          // and the fastest it gets
const SPEED_UP_EVERY = 6 * HZ; // a unit faster this often through a round
const RUN_EXTRA = 3;           // a runner runs this much faster than the screen, so it can catch up
const FLIP_BUFFER = 6;         // steps a flip asked for in the air waits for ground
const WINGS_MAX = 2;           // wings a runner can carry: each is a flip in the air
const WINGS_ON = 6;            // wings lying in the tunnel at once
const STOMP_COOL = 10;         // steps before the same runners can flip each other again
const KNOCK_STEPS = 2 * HZ;    // a fall this soon after being flipped is the flipper's doing
const BOUNCE = 10;             // the bounce off a rival's head
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const TARGET_MIN = 5;          // points a match is played to at the least
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 75 * HZ;
const END_STEPS = 5 * HZ;
const CHAMP_STEPS = 7 * HZ;    // the result stands longer when it ends a match
const BACK_STEPS = Math.round(1.5 * HZ);  // a practising runner who fell is back this soon

const OUT = 0, ALIVE = 1, CRASHED = 2;   // watching, running, out this round

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   tg: the points a match is played to; cx: the screen's left edge, in units;
//   sp: how fast it moves; c0: the column the first of `cols` is; cols: the
//   tunnel, a mask a column; wl: the wings lying in it, [column, row]; res: the
//   last round's [id, points it took, points, matches won] rows; win: who
//   outran everybody; champ: who took the match with it
function freshTable(seed) {
  const t = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, tg: TARGET_MIN, cx: 0, sp: SPEED0, c0: 0, cols: [], wl: [],
    p: {}, res: null, win: -1, champ: -1,
  };
  lay(t);
  return t;
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'vy', 'dir', 'gr', 'bl', 'q', 'fq', 'wi', 'rt', 'gn', 'pts', 'wn', 'kb',
  'kt', 'sc', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; st: watching, running or out; x, y: the box's top
//   left corner, in units; vy: how fast it falls, down positive; dir: which
//   way gravity pulls it, 1 down and -1 up; gr: standing on something; bl:
//   held up by a wall this step; q: the flip counter as last heard; fq: steps
//   a flip asked for in the air still waits; wi: wings in hand; rt: steps
//   until a practising runner who fell is back; gn: points this round, -1 for
//   a watcher; pts: points this match; wn: matches won; kb, kt: who flipped
//   this runner last and how long that still counts; sc: steps before it can
//   be flipped again; bw: the bot's pause; hs, hc: hands this step.
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

function newPlayer(w, q) {
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: OUT, x: w.cx + 3 * CELL, y: (ROWS - 1) * CELL - PH, vy: 0, dir: 1,
    gr: 1, bl: 0, q, fq: 0, wi: 0, rt: 0, gn: -1, pts: 0, wn: 0, kb: 0, kt: 0, sc: 0, bw: 0, hs: w.n, hc: 0,
  });
}

// ── the tunnel ─────────────────────────────────────────────────────────────
// A column the table does not hold is a plain stretch with a floor and a
// ceiling: behind the screen nobody is alive to stand on it, and ahead of it
// the tunnel is always laid further than anybody can look.
function colAt(w, c) {
  const i = c - w.c0;
  return i >= 0 && i < w.cols.length ? w.cols[i] : BOTH;
}
const solid = (w, c, r) => r >= 0 && r < ROWS && ((colAt(w, c) >> r) & 1) === 1;
const mod = (v, m) => ((v % m) + m) % m;

// How hard the tunnel is where it is being laid: practice stays easy, and a
// round gets harder the further it runs.
function hardness(w, at) {
  if (w.ph === WAIT) return 1;
  return Math.min(4, 1 + Math.floor(at / 45));
}

// One piece of tunnel, laid on the end of what the table holds: a straight
// stretch, then one thing to get past. Every piece can be got past by a
// runner who flips in time — a gap on one side has ground on the other, a
// pillar leaves the far side open, a chasm is shorter than one flip carries a
// runner, and a bar is ground on both of its faces.
function segment(w) {
  const at = w.c0 + w.cols.length;
  const push = (m, n) => { for (let k = 0; k < n; k++) w.cols.push(m); };
  if (at < 12) { push(BOTH, 12 - at); return; }
  const df = hardness(w, at);
  const run = 5 - (df >> 1) + pick(w, 3);
  push(BOTH, run);
  if (draw01(w) < 0.24 && w.wl.length < WINGS_ON) w.wl.push([at + 1 + pick(w, run - 1), 3 + pick(w, 4)]);
  const pillar = (up, h, n) => {
    let m = up ? FLOOR : CEIL;
    for (let r = 0; r < h; r++) m |= 1 << (up ? r : ROWS - 1 - r);
    push(m, n);
  };
  switch (pick(w, df >= 2 ? 7 : 5)) {
    case 0: push(CEIL, 2 + pick(w, 1 + df)); break;
    case 1: push(FLOOR, 2 + pick(w, 1 + df)); break;
    case 2: {
      const first = draw01(w) < 0.5 ? CEIL : FLOOR;
      push(first, 2 + pick(w, df));
      push(BOTH, 1 + pick(w, 2));
      push(first === CEIL ? FLOOR : CEIL, 2 + pick(w, df));
      break;
    }
    case 3: pillar(draw01(w) < 0.5, 4 + pick(w, Math.min(2, df)), 1 + pick(w, 2)); break;
    case 4: {
      const r = 4 + pick(w, 2), n = 4 + pick(w, 3);
      push(BOTH | (1 << r), 1);
      push(1 << r, n);
      push(BOTH | (1 << r), 1);
      if (draw01(w) < 0.5 && w.wl.length < WINGS_ON) w.wl.push([at + run + 1 + pick(w, n), draw01(w) < 0.5 ? r - 1 : r + 1]);
      break;
    }
    case 5: push(0, 1 + (df >= 3 ? pick(w, 2) : 0)); break;
    default: {
      const up = draw01(w) < 0.5;
      pillar(up, 4, 1);
      push(BOTH, 3 + pick(w, 2));
      pillar(!up, 4, 1);
    }
  }
}

// The tunnel laid ahead of the screen as far as anybody can look, and dropped
// behind it, with the wings that lay there.
function lay(w) {
  const left = Math.floor(w.cx / CELL);
  while (w.c0 + w.cols.length < left + AHEAD) segment(w);
  const drop = left - BEHIND - w.c0;
  if (drop > 0) {
    w.cols.splice(0, drop);
    w.c0 += drop;
    w.wl = w.wl.filter((g) => g[0] >= w.c0);
  }
}

function freshTunnel(w) {
  w.cx = 0;
  w.c0 = 0;
  w.cols = [];
  w.wl = [];
  lay(w);
}

// ── a runner's body ────────────────────────────────────────────────────────
// A body is { x, y, vy, dir, gr, bl }: a box that runs forward, falls the way
// its gravity pulls, and stops against whatever solid cell it meets. Every
// move is less than a cell, so a box only ever has the next row or column to
// look at.
function onGround(w, b) {
  const c0 = Math.floor(b.x / CELL), c1 = Math.floor((b.x + PW - 1) / CELL);
  let r;
  if (b.dir > 0) {
    if (mod(b.y + PH, CELL) !== 0) return false;
    r = (b.y + PH) / CELL;
  } else {
    if (mod(b.y, CELL) !== 0) return false;
    r = b.y / CELL - 1;
  }
  for (let c = c0; c <= c1; c++) if (solid(w, c, r)) return true;
  return false;
}

function moveBody(w, b, run) {
  let x = b.x + run;
  const r0 = Math.floor(b.y / CELL), r1 = Math.floor((b.y + PH - 1) / CELL);
  const cr = Math.floor((x + PW - 1) / CELL);
  b.bl = 0;
  for (let r = r0; r <= r1; r++) {
    if (solid(w, cr, r)) { x = cr * CELL - PW; b.bl = 1; break; }
  }
  b.x = Math.max(b.x, x);
  let vy = Math.max(-VMAX, Math.min(VMAX, b.vy + GRAV * b.dir));
  let y = b.y + vy;
  const c0 = Math.floor(b.x / CELL), c1 = Math.floor((b.x + PW - 1) / CELL);
  if (vy > 0) {
    const rb = Math.floor((y + PH - 1) / CELL);
    for (let c = c0; c <= c1; c++) if (solid(w, c, rb)) { y = rb * CELL - PH; vy = 0; break; }
  } else if (vy < 0) {
    const rt = Math.floor(y / CELL);
    for (let c = c0; c <= c1; c++) if (solid(w, c, rt)) { y = (rt + 1) * CELL; vy = 0; break; }
  }
  b.y = y;
  b.vy = vy;
  b.gr = onGround(w, b) ? 1 : 0;
}

function flipBody(b) {
  b.dir = -b.dir;
  b.vy = b.dir * KICK;
  b.gr = 0;
}

// Out of the tunnel through a gap, all the way.
const fellOut = (b) => b.y > ROWS * CELL || b.y < -PH;

// Where a runner can be put down at or after `x`: on the floor where there is
// one, on the ceiling where there is not, with nothing solid in the box.
function spotAt(w, x) {
  for (let k = 0; k < 12; k++) {
    const sx = x + k * CELL;
    const c0 = Math.floor(sx / CELL), c1 = Math.floor((sx + PW - 1) / CELL);
    const all = (r) => solid(w, c0, r) && solid(w, c1, r);
    const free = (r) => !solid(w, c0, r) && !solid(w, c1, r);
    if (all(ROWS - 1) && free(ROWS - 2)) return [sx, (ROWS - 1) * CELL - PH, 1];
    if (all(0) && free(1)) return [sx, CELL, -1];
  }
  return [x, (ROWS - 1) * CELL - PH, 1];
}

function place(d, at) {
  d.st = ALIVE;
  d.x = at[0];
  d.y = at[1];
  d.dir = at[2];
  d.vy = 0;
  d.gr = 1;
  d.bl = d.fq = d.rt = d.kt = d.sc = 0;
  d.kb = 0;
}

// A hand, at its place in the room's order: [the flip counter]. A flip is
// asked for once, when the counter changes; the same hand said again to keep a
// player at the table flips nobody. Being heard is how a player arrives:
// running while the table waits for a round or counts one in, and watching
// while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[0]);
    if (w.ph === WAIT || w.ph === COUNT) {
      place(d, spotAt(w, w.cx + 3 * CELL + (d.s >> 1) * 52));
      if (w.ph === COUNT) d.gn = 0;
    }
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; whether a flip happens is the table's to say, not the
  // hand's.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  if (input[0] !== d.q) {
    d.q = input[0];
    if (d.st === ALIVE && (w.ph === WAIT || w.ph === PLAY)) d.fq = FLIP_BUFFER;
  }
}

// A hand off the wire, made safe: one integer in its range, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 1) return null;
  const q = raw[0];
  if (!Number.isInteger(q) || q < 0 || q > 999) return null;
  return [q];
}

function leave(w, id) {
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_LOOK = 34;           // steps it plays its own runner forward to see what happens
const BOT_IDLE = 0.1;          // how often it keeps on a moment rather than decide
const BOT_SLIP = 0.25;         // how often it lets a flip it ought to make wait for its next look
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    const d = (w.p[BOT_ID] = newPlayer(w, 0));
    place(d, spotAt(w, w.cx + 4 * CELL));
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// How well a runner does if it flips now or not: its own body played forward
// on the tunnel as it stands, worth the steps it stays in and how far it gets.
function fate(w, d, flipNow, run) {
  const b = { x: d.x, y: d.y, vy: d.vy, dir: d.dir, gr: d.gr, bl: 0 };
  if (flipNow) flipBody(b);
  let cam = w.cx;
  for (let s = 1; s <= BOT_LOOK; s++) {
    moveBody(w, b, run);
    cam += w.sp;
    if (fellOut(b) || b.x + PW < cam) return s * 1000;
  }
  return (BOT_LOOK + 1) * 1000 + (b.x - d.x);
}

// It looks at both ways each time it decides — staying as it is and flipping —
// and flips when that does better, in the air too when it holds a wing and
// staying means falling out.
function botThink(w, run) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== ALIVE || d.fq > 0) return;
  if (w.n % BOT_EVERY !== 0) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (draw01(w) < BOT_IDLE) { d.bw = 1 + pick(w, 3); return; }
  if (!d.gr && d.wi === 0) return;
  const stay = fate(w, d, false, run);
  if (!d.gr && stay > BOT_LOOK * 1000) return;
  const go = fate(w, d, true, run);
  if (go > stay + CELL && draw01(w) >= BOT_SLIP) d.fq = FLIP_BUFFER;
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = w.champ = -1;
  w.sp = SPEED0;
  freshTunnel(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    d.pts = 0;
    d.gn = -1;
    d.wi = 0;
    place(d, spotAt(w, 3 * CELL + (d.s >> 1) * 52));
  }
}

// A round: a fresh tunnel, the seats closed up in order, every runner put
// down at the start, half on the floor and half on the ceiling. A match that
// ended starts over from nothing. Whoever has the fewest points, when
// somebody has more, starts with a wing in hand.
function begin(w) {
  const ids = bySeat(w);
  if (w.champ !== -1) for (const id of ids) w.p[id].pts = 0;
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = w.champ = -1;
  w.sp = SPEED0;
  freshTunnel(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  w.tg = Math.max(TARGET_MIN, 3 * (ids.length - 1));
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) { lo = Math.min(lo, w.p[id].pts); hi = Math.max(hi, w.p[id].pts); }
  ids.forEach((id, i) => {
    const d = w.p[id];
    const up = i % 2 === 1;
    place(d, [2 * CELL + (i >> 1) * 52, up ? CELL : (ROWS - 1) * CELL - PH, up ? -1 : 1]);
    d.wi = hi > lo && d.pts === lo ? 1 : 0;
    d.gn = 0;
  });
  fx(w, 'round', 0, 0, 0);
}

// The round is over: whoever is still running outran everybody, and a match
// is won by the first to its points with nobody level.
function finish(w) {
  const ids = bySeat(w);
  const alive = ids.filter((id) => w.p[id].st === ALIVE);
  w.win = alive.length === 1 ? alive[0] : -1;
  let top = -1;
  for (const id of ids) top = Math.max(top, w.p[id].pts);
  const best = ids.filter((id) => w.p[id].pts === top);
  w.champ = top >= w.tg && best.length === 1 ? best[0] : -1;
  if (w.champ !== -1) w.p[w.champ].wn += 1;
  const res = ids.map((id) => [id, w.p[id].gn, w.p[id].pts, w.p[id].wn]);
  res.sort((a, b) => b[2] - a[2] || b[1] - a[1] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = w.champ !== -1 ? CHAMP_STEPS : END_STEPS;
  fx(w, 'end', 0, 0, w.win, w.champ);
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
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); return; }
  } else if (many < 2) {
    toWait(w);
    return;
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go', 0, 0, 0); }
    } else if (w.ph === PLAY) {
      if (w.pt <= 0) { timeUp(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
      return;
    }
  }
  if (w.ph === END || w.ph === COUNT) return;
  run(w);
}

// The clock ran out with more than one runner going: each of them takes a
// point for lasting.
function timeUp(w) {
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d.st !== ALIVE) continue;
    d.pts += 1;
    d.gn += 1;
    fx(w, 'point', d.x, d.y, id, 1);
  }
  finish(w);
}

function run(w) {
  const practice = w.ph === WAIT;
  const into = PLAY_STEPS - w.pt;
  w.sp = practice ? SPEED0 : Math.min(SPEED_MAX, SPEED0 + Math.floor(into / SPEED_UP_EVERY));
  if (!practice && into > 0 && into % SPEED_UP_EVERY === 0 && w.sp < SPEED_MAX) fx(w, 'faster', 0, 0, 0);
  const speed = w.sp + RUN_EXTRA;
  botThink(w, speed);
  const ids = bySeat(w);
  // Every runner moves on the tunnel alone first, a flip asked for taken where
  // the runner stands on something or holds a wing.
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== ALIVE) continue;
    if (d.sc > 0) d.sc -= 1;
    if (d.kt > 0) d.kt -= 1;
    if (d.fq > 0) {
      if (d.gr) { flipBody(d); d.fq = 0; fx(w, 'flip', d.x, d.y, id, d.dir); }
      else if (d.wi > 0) { d.wi -= 1; flipBody(d); d.fq = 0; fx(w, 'wingflip', d.x, d.y, id, d.dir); }
      else d.fq -= 1;
    }
    const was = d.gr;
    moveBody(w, d, speed);
    if (!was && d.gr) fx(w, 'land', d.x, d.y, id, d.dir);
  }
  stomps(w, ids);
  wings(w, ids);
  // The screen goes on at its own pace, or faster when the front runner
  // pulls it; whoever it leaves behind is out.
  let front = -BIG;
  for (const id of ids) if (w.p[id].st === ALIVE) front = Math.max(front, w.p[id].x);
  w.cx = Math.max(w.cx + w.sp, front - LEAD);
  lay(w);
  const gone = [];
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== ALIVE) continue;
    if (fellOut(d)) gone.push([id, 0]);
    else if (d.x + PW < w.cx) gone.push([id, 1]);
  }
  for (const [id, how] of gone) {
    const d = w.p[id];
    d.st = CRASHED;
    if (practice) d.rt = BACK_STEPS;
    fx(w, 'out', Math.max(w.cx, d.x), Math.max(0, Math.min(ROWS * CELL - PH, d.y)), id, how);
    // A fall soon after being flipped is a point to whoever flipped them.
    const by = d.kt > 0 ? w.p[d.kb] : null;
    if (by && d.kb !== id) {
      fx(w, 'knock', by.x, by.y, d.kb, id);
      if (!practice) { by.pts += 1; by.gn += 1; }
    }
  }
  if (gone.length && !practice) {
    // A point for every runner out while yours was still going.
    for (const id of ids) {
      const d = w.p[id];
      if (d.st !== ALIVE) continue;
      d.pts += gone.length;
      d.gn += gone.length;
      fx(w, 'point', d.x, d.y, id, gone.length);
    }
  }
  if (practice) {
    for (const id of ids) {
      const d = w.p[id];
      if (d && d.st === CRASHED && d.rt > 0 && --d.rt === 0) {
        place(d, spotAt(w, w.cx + 4 * CELL));
        d.wi = 0;
        fx(w, 'back', d.x, d.y, id);
      }
    }
    return;
  }
  let still = 0;
  for (const id of ids) if (w.p[id].st === ALIVE) still += 1;
  if (still <= 1) finish(w);
}

// Landing on a rival: a runner falling onto one who stands flips the one
// below — their gravity turns over and off they go to the other side — and
// bounces back the way it came. Pairs are looked at in seat order, so every
// copy flips the same runners.
function stomps(w, ids) {
  for (const a of ids) {
    const A = w.p[a];
    if (A.st !== ALIVE || A.gr || A.vy * A.dir <= 0 || A.sc > 0) continue;
    for (const b of ids) {
      const B = w.p[b];
      if (b === a || B.st !== ALIVE || !B.gr || B.sc > 0) continue;
      if (Math.abs(A.x - B.x) >= PW || Math.abs(A.y - B.y) >= PH) continue;
      if (A.dir > 0 ? A.y >= B.y : A.y <= B.y) continue;
      flipBody(B);
      B.vy = B.dir * (KICK + 4);
      B.kb = a;
      B.kt = KNOCK_STEPS;
      A.vy = -A.dir * BOUNCE;
      A.sc = B.sc = STOMP_COOL;
      fx(w, 'stomp', B.x, B.y, b, a);
      break;
    }
  }
}

// Wings: whoever's box reaches one takes it, while they have a hand free.
function wings(w, ids) {
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== ALIVE || d.wi >= WINGS_MAX) continue;
    for (let i = 0; i < w.wl.length; i++) {
      const gx = w.wl[i][0] * CELL + (CELL >> 1), gy = w.wl[i][1] * CELL + (CELL >> 1);
      if (Math.abs(d.x + (PW >> 1) - gx) >= (PW >> 1) + 14 || Math.abs(d.y + (PH >> 1) - gy) >= (PH >> 1) + 14) continue;
      w.wl.splice(i, 1);
      d.wi += 1;
      fx(w, 'wing', gx, gy, id);
      break;
    }
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
  if (!int(raw.tg, TARGET_MIN, 3 * MAX_P) || !int(raw.cx, 0, BIG) || !int(raw.sp, SPEED0, SPEED_MAX)) return null;
  if (!int(raw.c0, 0, BIG) || !Array.isArray(raw.cols) || raw.cols.length > COLS_MAX) return null;
  if (!raw.cols.every((m) => int(m, 0, (1 << ROWS) - 1))) return null;
  if (!Array.isArray(raw.wl) || raw.wl.length > WINGS_ON) return null;
  for (const g of raw.wl) if (!Array.isArray(g) || g.length !== 2 || !int(g[0], 0, BIG) || !int(g[1], 1, ROWS - 2)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, OUT, CRASHED) || !int(d.x, -BIG, BIG) || !int(d.y, -4 * CELL, (ROWS + 4) * CELL)) return null;
    if (!int(d.vy, -VMAX, VMAX) || (d.dir !== 1 && d.dir !== -1) || !int(d.gr, 0, 1) || !int(d.bl, 0, 1)) return null;
    if (inputOf([d.q]) === null || !int(d.fq, 0, FLIP_BUFFER) || !int(d.wi, 0, WINGS_MAX)) return null;
    if (!int(d.rt, 0, BACK_STEPS) || !int(d.gn, -1, 999999) || !int(d.pts, 0, 999999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.kb, -BIG, BIG) || !int(d.kt, 0, KNOCK_STEPS) || !int(d.sc, 0, STOMP_COOL) || !int(d.bw, 0, 9)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -BIG, BIG) || !int(raw.champ, -BIG, BIG)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, tg: raw.tg, cx: raw.cx, sp: raw.sp, c0: raw.c0,
    cols: raw.cols.slice(), wl: raw.wl.map((g) => g.slice()), p, res, win: raw.win, champ: raw.champ,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a neon tunnel at night. The page is deep violet with a city
// far behind, the tunnel's walls are slate with a glowing cyan lip on every
// face a runner can stand on, and each seat has a bright colour of its own.
const INK = {
  page: '#120b2e', glow: '#2a1856', far: '#1f1446', farLit: '#3a2a78', inside: 'rgba(24,18,58,0.72)',
  rock: '#2b2f5e', rockHi: '#3a4078', lip: '#5ef0ff', text: '#ffffff', muted: '#c9c3ef', dim: '#8a83b8',
  gold: '#ffd166', danger: '#ff4f6d', outline: '#0b0820', panel: 'rgba(16,11,40,0.93)', wing: '#fff0a8',
  grid: 'rgba(140,120,255,0.07)',
};
const SEAT = ['#ff5c8a', '#4fd8ff', '#ffd23f', '#7dff6a', '#c77dff', '#ff8a3d', '#f4f4ff', '#2effc8'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a3a8a;' +
  `background:#241a52;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, TOP = 58, BOT = 26, dpx = 1;
let CP = 30, FX0 = 0, FY0 = 0, FWP = 480, FHP = 300, fieldBot = 400;
// Columns drawn: the screen's own VIEWC, and as many of the columns laid
// beyond it as the frame has width for. The table lays the tunnel AHEAD
// columns past the screen's left edge, so these are there to be seen.
const EXTRA_MAX = AHEAD - VIEWC - 2;
let VIEW = VIEWC;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
  // The tunnel is as tall as the frame lets it be, with a strip under it:
  // NOTE_ROOM keeps the practice note off the floor, and in a round the same
  // strip says how many wings you hold. A frame wider than the screen's own
  // columns at that height shows the tunnel further ahead, so it runs from
  // one side of the frame to the other rather than sit between empty bands.
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  CP = Math.max(4, Math.min((VW - 8) / VIEWC, ah / ROWS));
  VIEW = VIEWC + Math.max(0, Math.min(EXTRA_MAX, Math.floor((VW - 8) / CP) - VIEWC));
  FWP = VIEW * CP;
  FHP = ROWS * CP;
  FX0 = (VW - FWP) / 2;
  FY0 = TOP + (ah - FHP) / 2;
  fieldBot = FY0 + FHP;
}
layout();
window.addEventListener('resize', layout);

// Tunnel units to the screen, against the left edge as drawn.
let camShown = 0;
const SX = (u) => FX0 + ((u - camShown) / CELL) * CP + shakeX;
const SY = (u) => FY0 + (u / CELL) * CP + shakeY;
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
  flip(up, me) {
    if (!ready(me ? 'flipMe' : 'flip', 50)) return;
    tone(up ? 330 : 520, 0.16, 'triangle', me ? 0.1 : 0.035, up ? 2.0 : 0.5);
    puff(0.12, me ? 0.04 : 0.015, 2600, 0, 2);
  },
  wing() { if (ready('wing', 60)) { tone(660, 0.18, 'sine', 0.09, 1.8); tone(990, 0.14, 'triangle', 0.05, 1.5, 0.05); } },
  land(near) { if (ready('land', 50)) { tone(140, 0.09, 'sine', 0.03 + 0.07 * near, 0.6); puff(0.06, 0.02 + 0.04 * near, 900, 0, 1); } },
  stomp() { if (ready('stomp', 80)) { tone(200, 0.2, 'square', 0.06, 2.6); puff(0.15, 0.06, 1200, 0, 1.4); } },
  out(me, near) {
    if (!ready('out', 50)) return;
    puff(me ? 0.5 : 0.3, me ? 0.15 : 0.04 + 0.07 * near, 420, 0, 0.6);
    tone(me ? 300 : 360, me ? 0.6 : 0.3, 'sawtooth', me ? 0.07 : 0.025 + 0.03 * near, 0.25);
  },
  point(n) { if (ready('point', 90)) for (let i = 0; i < Math.min(3, n); i++) tone(880 + 220 * i, 0.09, 'sine', 0.07, 1.1, i * 0.06); },
  pickup() { if (ready('pickup', 80)) [988, 1319, 1760].forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, i * 0.045)); },
  back() { if (ready('back', 200)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.05)); },
  faster() { if (ready('faster', 400)) [440, 554, 659].forEach((f, i) => tone(f, 0.12, 'square', 0.035, 1.05, i * 0.07)); },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
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
// fast screen and a slow one see the same sparks. Positions are tunnel units.
const bits = [];      // { x, y, vx, vy, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, vx0, vy0) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.25 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v + (vx0 || 0), vy: Math.sin(a) * v + (vy0 || 0), life: 0,
      max: 16 + Math.random() * 24, size, colour });
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
      b.vx *= 0.92; b.vy *= 0.92;
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
let drawFailed = false;
const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const nearOf = (md, x, y) => (md && md.st === ALIVE ? Math.max(0, 1 - (Math.abs(md.x - x) + Math.abs(md.y - y)) / (12 * CELL)) : 0.3);
const squash = new Map();     // id -> [how much, when]: a runner's squash as it lands or is landed on
const turned = new Map();     // id -> the way up a runner is drawn, 0 on the floor to 1 on the ceiling

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = nearOf(md, e.x, e.y);
  const cxu = e.x + PW / 2, cyu = e.y + PH / 2;
  if (e.kind === 'flip' || e.kind === 'wingflip') {
    const c = colourOf(t, e.a);
    spray(cxu, e.b > 0 ? e.y : e.y + PH, 8, c, 5 * CELL, 2.2, 0, -e.b * 3 * CELL);
    if (e.kind === 'wingflip') { ring(cxu, cyu, INK.wing, 1.6 * CELL); spray(cxu, cyu, 10, INK.wing, 4 * CELL, 2); }
    if (e.a !== me) sound.flip(e.b < 0, false);
    else if (e.kind === 'wingflip') sound.wing();
  } else if (e.kind === 'land') {
    squash.set(e.a, [1, performance.now()]);
    spray(cxu, e.b > 0 ? e.y + PH : e.y, 6, '#d8d2ff', 3 * CELL, 1.8, -2 * CELL, 0);
    sound.land(e.a === me ? 1 : near);
  } else if (e.kind === 'stomp') {
    squash.set(e.a, [1.6, performance.now()]);
    ring(cxu, cyu, colourOf(t, e.b), 1.8 * CELL);
    spray(cxu, cyu, 14, colourOf(t, e.b), 6 * CELL, 2.5);
    pop(cxu, e.y, 'flip!', colourOf(t, e.b), e.a === me || e.b === me ? 18 : 14);
    shake = Math.max(shake, e.a === me ? 9 : 2 + 4 * near);
    sound.stomp();
  } else if (e.kind === 'out') {
    const colour = colourOf(t, e.a);
    spray(cxu, cyu, 26, colour, 9 * CELL, 3);
    spray(cxu, cyu, 10, '#ffffff', 6 * CELL, 2);
    ring(cxu, cyu, colour, 2.5 * CELL);
    pop(cxu, Math.max(CELL, Math.min((ROWS - 1) * CELL, e.y)), e.b ? 'left behind!' : 'out!', colour, e.a === me ? 18 : 14);
    shake = Math.max(shake, e.a === me ? 14 : 2 + 6 * near);
    sound.out(e.a === me, near);
  } else if (e.kind === 'knock') {
    if (e.a === me) { pop(cxu, e.y - CELL / 2, '+1 knock', INK.gold, 16); sound.point(1); }
  } else if (e.kind === 'point') {
    if (e.a === me) { pop(cxu, e.y - CELL, '+' + e.b, INK.gold, 17); sound.point(e.b); }
  } else if (e.kind === 'wing') {
    spray(e.x, e.y, 14, INK.wing, 5 * CELL, 2.5);
    ring(e.x, e.y, INK.wing, 1.4 * CELL);
    if (e.a === me) { pop(e.x, e.y, '+wing', INK.wing, 16); sound.pickup(); }
  } else if (e.kind === 'back') {
    ring(cxu, cyu, colourOf(t, e.a), 2 * CELL);
    turned.delete(e.a);
    if (e.a === me) sound.back();
  } else if (e.kind === 'faster') {
    pop(camShown + VIEW * CELL / 2, 2 * CELL, 'faster!', INK.danger, 20);
    sound.faster();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'round') {
    turned.clear();
    trails.clear();
  } else if (e.kind === 'end') {
    sound.end(e.a === me || e.b === me);
  }
}

// Far behind the tunnel: a skyline that slides by at a third of its pace,
// its windows lit by a hash of where they stand, so the same street comes
// back every time the screen passes it.
function hash(n) {
  let h = Math.imul(n | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
function drawGround(now) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.page);
  g.addColorStop(0.55, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  for (let i = 0; i < 40; i++) {
    const x = hash(i * 7 + 1) * VW, y = hash(i * 13 + 5) * VH * 0.6;
    ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.25 * hash(i) * (0.6 + 0.4 * Math.sin(now / 700 + i))})`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  const bw = Math.max(18, CP * 1.4);
  const off = ((camShown / CELL) * CP) / 3;
  const first = Math.floor(off / bw) - 1;
  const base = fieldBot + (VH - fieldBot) * 0.4;
  for (let k = first; k * bw - off < VW + bw; k++) {
    const h = (0.25 + 0.6 * hash(k)) * (base - TOP);
    const x = k * bw - off;
    ctx.fillStyle = INK.far;
    ctx.fillRect(x, base - h, bw - 3, h + VH);
    ctx.fillStyle = INK.farLit;
    for (let wy = base - h + 6; wy < base - 4; wy += 9) {
      for (let wx = 4; wx < bw - 7; wx += 7) {
        if (hash(k * 131 + Math.floor(wy) * 7 + wx) < 0.22) ctx.fillRect(x + wx, wy, 3, 4);
      }
    }
  }
}

// The tunnel: a dark inside with a faint grid that moves with it, the solid
// cells in slate, and a glowing lip along every face that can be stood on. A
// danger band at the left edge: the screen leaves whoever it reaches.
function drawTunnel(t, now) {
  const x0 = FX0 + shakeX, y0 = FY0 + shakeY;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(x0 - 6, y0 - 4, FWP + 12, FHP + 14, 10);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, FWP, FHP, 8);
  ctx.clip();
  ctx.fillStyle = INK.inside;
  ctx.fillRect(x0, y0, FWP, FHP);
  ctx.strokeStyle = INK.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const c0 = Math.floor(camShown / CELL);
  for (let c = c0; c <= c0 + VIEW + 1; c++) {
    const x = SX(c * CELL);
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + FHP);
  }
  for (let r = 1; r < ROWS; r++) {
    ctx.moveTo(x0, SY(r * CELL));
    ctx.lineTo(x0 + FWP, SY(r * CELL));
  }
  ctx.stroke();
  const pad = Math.max(1, CP * 0.06);
  for (let c = c0; c <= c0 + VIEW + 1; c++) {
    const x = SX(c * CELL);
    for (let r = 0; r < ROWS; r++) {
      if (!solid(t, c, r)) continue;
      const y = SY(r * CELL);
      const gr = ctx.createLinearGradient(0, y, 0, y + CP);
      gr.addColorStop(0, INK.rockHi);
      gr.addColorStop(1, INK.rock);
      ctx.fillStyle = gr;
      roundRect(x + pad, y + pad, CP - 2 * pad, CP - 2 * pad, Math.max(2, CP * 0.16));
      ctx.fill();
    }
  }
  // The lips: a bright line on each solid face that looks into open tunnel.
  ctx.strokeStyle = INK.lip;
  ctx.shadowColor = INK.lip;
  ctx.shadowBlur = Math.max(4, CP * 0.3);
  ctx.lineWidth = Math.max(1.5, CP * 0.08);
  ctx.beginPath();
  for (let c = c0; c <= c0 + VIEW + 1; c++) {
    const x = SX(c * CELL);
    for (let r = 0; r < ROWS; r++) {
      if (!solid(t, c, r)) continue;
      const y = SY(r * CELL);
      if (r > 0 && !solid(t, c, r - 1)) { ctx.moveTo(x + 1, y); ctx.lineTo(x + CP - 1, y); }
      if (r < ROWS - 1 && !solid(t, c, r + 1)) { ctx.moveTo(x + 1, y + CP); ctx.lineTo(x + CP - 1, y + CP); }
      if (!solid(t, c - 1, r)) { ctx.moveTo(x, y + 1); ctx.lineTo(x, y + CP - 1); }
    }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  // Gaps open onto the night: a soft glow where the tunnel lets out.
  for (let c = c0; c <= c0 + VIEW + 1; c++) {
    const x = SX(c * CELL);
    if (!solid(t, c, 0)) {
      const g = ctx.createLinearGradient(0, y0, 0, y0 + CP);
      g.addColorStop(0, 'rgba(255,79,109,0.4)');
      g.addColorStop(1, 'rgba(255,79,109,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y0, CP, CP);
    }
    if (!solid(t, c, ROWS - 1)) {
      const g = ctx.createLinearGradient(0, y0 + FHP, 0, y0 + FHP - CP);
      g.addColorStop(0, 'rgba(255,79,109,0.4)');
      g.addColorStop(1, 'rgba(255,79,109,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y0 + FHP - CP, CP, CP);
    }
  }
  const band = CP * 1.1;
  const dg = ctx.createLinearGradient(x0, 0, x0 + band, 0);
  dg.addColorStop(0, alpha(INK.danger, 0.55 + 0.15 * Math.sin(now / 160)));
  dg.addColorStop(1, alpha(INK.danger, 0));
  ctx.fillStyle = dg;
  ctx.fillRect(x0, y0, band, FHP);
  ctx.fillStyle = alpha(INK.danger, 0.7);
  const gap = Math.max(12, CP * 0.8), shift = (now / 30) % gap;
  for (let y = y0 - gap + shift; y < y0 + FHP; y += gap) {
    ctx.beginPath();
    ctx.moveTo(x0 + 3, y);
    ctx.lineTo(x0 + 3 + CP * 0.25, y + gap * 0.3);
    ctx.lineTo(x0 + 3, y + gap * 0.6);
    ctx.closePath();
    ctx.fill();
  }
  // Past the screen's own columns the tunnel is seen further off: a haze that
  // thickens toward the frame's edge.
  if (VIEW > VIEWC) {
    const hx = x0 + VIEWC * CP;
    const hz = ctx.createLinearGradient(hx, 0, x0 + FWP, 0);
    hz.addColorStop(0, alpha(INK.page, 0));
    hz.addColorStop(1, alpha(INK.page, 0.55));
    ctx.fillStyle = hz;
    ctx.fillRect(hx, y0, x0 + FWP - hx, FHP);
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(160,140,255,0.4)';
  ctx.lineWidth = 2;
  roundRect(x0, y0, FWP, FHP, 8);
  ctx.stroke();
}

// Wings: a little pair of feathers that bob in place.
function drawWings(t, now) {
  for (const [c, r] of t.wl) {
    const x = SX(c * CELL + CELL / 2), y = SY(r * CELL + CELL / 2) + Math.sin(now / 220 + c) * CP * 0.08;
    if (x < FX0 - CP || x > FX0 + FWP + CP) continue;
    const s = CP * 0.32;
    ctx.fillStyle = alpha(INK.wing, 0.16);
    disc(x, y, s * 2.2);
    ctx.fill();
    wingShape(x, y, s, INK.wing, Math.sin(now / 140 + c) * 0.25);
  }
}
function wingShape(x, y, s, colour, flap) {
  ctx.fillStyle = colour;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.3);
    ctx.quadraticCurveTo(x + side * s * 0.3, y - s * (1.4 + flap), x + side * s * 1.9, y - s * (1.1 + flap));
    ctx.quadraticCurveTo(x + side * s * 1.5, y + s * 0.1, x, y + s * 0.5);
    ctx.closePath();
    ctx.fill();
  }
}

// Where each runner has been on this screen, for the streak behind it in the
// air: screen-free tunnel units and when.
const trails = new Map();     // id -> [[x, y, when]]
const TRAIL_MS = 220;
function trailOf(id, x, y, air, now) {
  let tr = trails.get(id);
  if (!tr) trails.set(id, (tr = []));
  if (air) tr.push([x, y, now]);
  while (tr.length && now - tr[0][2] > TRAIL_MS) tr.shift();
  return tr;
}

// A runner as drawn: a rounded block in its seat's colour, eyes forward, its
// feet on whichever side gravity pulls it to. It turns over as it crosses the
// tunnel, stretches as it falls and squashes as it lands; the streak behind
// it is where it has been on this screen.
function drawRunner(id, x, y, d, colour, me, now, air) {
  const target = d.dir > 0 ? 0 : 1;
  let u = turned.has(id) ? turned.get(id) : target;
  u = Math.abs(target - u) < 0.01 ? target : lerp(u, target, per60(0.22));
  turned.set(id, u);
  const tr = trailOf(id, x, y, air, now);
  const sx = SX(x + PW / 2), sy = SY(y + PH / 2);
  const s = (PW / CELL) * CP;
  for (const [tx, ty, at] of tr) {
    const k = 1 - (now - at) / TRAIL_MS;
    ctx.fillStyle = alpha(colour, 0.25 * k);
    roundRect(SX(tx) + s * 0.15, SY(ty) + s * 0.15, s * 0.7, s * 0.7, s * 0.2);
    ctx.fill();
  }
  let sq = 0;
  const q = squash.get(id);
  if (q) {
    const k = (now - q[1]) / 220;
    if (k >= 1) squash.delete(id);
    else sq = q[0] * Math.sin(Math.PI * k) * 0.22;
  }
  const stretch = air ? Math.min(0.18, Math.abs(d.vy) / VMAX * 0.18) : 0;
  const ww = s * (1 + sq - stretch * 0.6), hh = s * (1 - sq + stretch);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.fillStyle = alpha(colour, 0.2 + 0.08 * Math.sin(now / 200));
  disc(0, 0, s * 1.05);
  ctx.fill();
  ctx.rotate(Math.PI * u);
  // Feet against whatever it stands on.
  const foot = hh / 2;
  ctx.fillStyle = darker(colour, 0.45);
  const stepK = air ? 0 : Math.sin(now / 55 + id) * s * 0.08;
  roundRect(-ww * 0.38 + stepK, foot - s * 0.08, ww * 0.28, s * 0.16, s * 0.06);
  ctx.fill();
  roundRect(ww * 0.1 - stepK, foot - s * 0.08, ww * 0.28, s * 0.16, s * 0.06);
  ctx.fill();
  ctx.fillStyle = INK.outline;
  roundRect(-ww / 2 - 1.5, -hh / 2 - 1.5, ww + 3, hh + 3, s * 0.3);
  ctx.fill();
  ctx.fillStyle = colour;
  roundRect(-ww / 2, -hh / 2, ww, hh, s * 0.26);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  roundRect(-ww / 2 + s * 0.12, -hh / 2 + s * 0.1, ww * 0.42, hh * 0.16, s * 0.08);
  ctx.fill();
  // Eyes look the way it runs, which on the ceiling is still forward.
  const ex = (u > 0.5 ? -1 : 1) * s * 0.14;
  ctx.fillStyle = '#ffffff';
  disc(ex - s * 0.12, -s * 0.06, s * 0.13);
  ctx.fill();
  disc(ex + s * 0.18, -s * 0.06, s * 0.13);
  ctx.fill();
  ctx.fillStyle = INK.outline;
  const look = (u > 0.5 ? -1 : 1) * s * 0.05;
  disc(ex - s * 0.12 + look, -s * 0.05, s * 0.065);
  ctx.fill();
  disc(ex + s * 0.18 + look, -s * 0.05, s * 0.065);
  ctx.fill();
  ctx.restore();
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    roundRect(sx - s / 2 - 4, sy - s / 2 - 4, s + 8, s + 8, s * 0.35);
    ctx.stroke();
  }
  // Its name on the open side, and the wings it holds beside it.
  const px = Math.max(9, Math.min(13, CP * 0.36));
  const label = me ? 'you' : nickOf(id);
  const below = d.dir < 0;
  const ly = below ? sy + s / 2 + px + 4 : sy - s / 2 - 6;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(10,8,30,0.8)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.strokeText(label, sx, ly);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, sx, ly);
  for (let k = 0; k < d.wi; k++) wingShape(sx - s * 0.75 - k * s * 0.5, sy, s * 0.18, INK.wing, 0);
}

function drawBits() {
  flat();
  ctx.save();
  roundRect(FX0 - 2, FY0 - 2, FWP + 4, FHP + 4, 8);
  ctx.clip();
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    disc(SX(b.x), SY(b.y), b.size * (1 - f * 0.5) * Math.max(0.7, CP / 30));
    ctx.fill();
  }
  for (const r of rings) {
    const f = r.life / r.max;
    ctx.globalAlpha = (1 - f) * 0.75;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - f) + 1;
    disc(SX(r.x), SY(r.y), (r.r / CELL) * CP * ease(f));
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
    ctx.strokeStyle = 'rgba(10,8,30,0.85)';
    const X = Math.max(FX0 + 50, Math.min(FX0 + FWP - 50, SX(p.x))), Y = Math.max(TOP + 16, SY(p.y) - rise);
    ctx.strokeText(p.s, X, Y);
    ctx.fillStyle = p.colour;
    ctx.fillText(p.s, X, Y);
  }
  ctx.globalAlpha = 1;
}

const clock = (steps) => {
  const s = Math.floor(steps / HZ);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const going = (t) => playersIn(t).filter((id) => t.p[id].st === ALIVE).length;

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, and the time and runners left in it.
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left · ' + going(t) + ' running';
    if (t.pt < 10 * HZ) colour = Math.floor(now / 400) % 2 ? INK.danger : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('flipside', 12, 22, titlePx, SEAT[1], 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('flipside').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points; the chip
  // of somebody who is out this round is hollow.
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
      if (d.st === ALIVE) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      const score = t.ph === WAIT ? '' : String(d.pts);
      ctx.font = font(12);
      const sw = score ? ctx.measureText(score).width : 0;
      if (score) text(score, x + cw - 8, y + 3, 12, INK.gold, 'right');
      if (cw > 46) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st === ALIVE ? (mine ? INK.text : INK.muted) : INK.dim, cw - 30 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'tap to flip gravity · land on a rival to flip them · keep up'
    : 'space, click or W/S flips gravity · land on a rival to flip them · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// Your wings, and what the match is played to, in the strip under the tunnel
// while a round is on.
function drawMine(t) {
  if (t.ph === WAIT) return;
  flat();
  const d = t.p[myId()];
  const y = Math.min(fieldBot + NOTE_ROOM / 2, VH - BOT - 18);
  const goal = 'first to ' + t.tg;
  if (!d || d.st !== ALIVE) {
    const line = !d || d.st === OUT ? 'watching · you run from the next round · ' + goal
      : t.ph === PLAY ? 'you are out · watch the rest · ' + goal : goal;
    fitText(line, VW / 2, y + 5, 13, INK.muted, VW - 24);
    return;
  }
  ctx.font = font(13);
  const label = 'wings', lw = ctx.measureText(label).width, gw = ctx.measureText(goal).width;
  const total = lw + 10 + Math.max(1, d.wi) * 26 + 30 + gw;
  let x = VW / 2 - total / 2;
  text(label, x, y + 5, 13, INK.muted, 'left');
  x += lw + 10;
  if (!d.wi) { text('none', x, y + 5, 13, INK.dim, 'left'); x += 40; }
  for (let k = 0; k < d.wi; k++) {
    wingShape(x + 11, y + 2, 6, INK.wing, 0);
    x += 26;
  }
  text(goal, x + 22, y + 5, 13, INK.gold, 'left');
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
  const cx = VW / 2, mid = (FY0 + fieldBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'flip to whichever side has ground · grab wings for a flip in the air';
    practiceNote(now, VW, head, tip, [[TOP, FY0 - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(10,8,30,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 350), 30);
    fitText('one button flips gravity · a point for every runner out before you', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 330));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(10,8,30,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('go!', cx, mid + big * 0.5);
    text('go!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const total = t.champ !== -1 ? CHAMP_STEPS : END_STEPS;
    const k = ease(Math.min(1, (total - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head, hc = INK.text;
    if (t.champ !== -1) {
      head = t.champ === me ? 'you win the match!' : nickOf(t.champ) + ' wins the match';
      hc = colourOf(t, t.champ);
    } else if (t.win !== -1) {
      head = t.win === me ? 'you outran them all!' : nickOf(t.win) + ' outran them all';
      hc = colourOf(t, t.win);
    } else head = going(t) ? 'time! everybody still running scores' : 'nobody made it';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, hc, w - 24);
    text('this round', cx + w / 2 - 74, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, gn, pts, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 160, 'left');
      text(gn < 0 ? '—' : '+' + gn, cx + w / 2 - 74, y, 14, INK.text, 'right');
      text(String(pts), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    const foot = t.champ !== -1 ? 'a new match in ' + Math.ceil(t.pt / HZ)
      : 'first to ' + t.tg + ' takes the match · next round in ' + Math.ceil(t.pt / HZ);
    fitText(foot, cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a runner stands as drawn: between two steps, and never slid across a
// jump — a runner put down somewhere new.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 3 * CELL) return [z.x, z.y, z, a];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z, a];
}

// Your own runner is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a flip a step away from
// where the guess had it. So the runner drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a runner put down again — puts it there at once. Only the
// drawing is smoothed: the tunnel, and every rule in it, are untouched.
const PULL = 0.5;
let shown = null;        // [x, y] in units: where your runner is drawn

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 3 * CELL) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  const b = agreedAt(now);
  if (b) {
    const c = lerp(b.from.cx, b.to.cx, b.k);
    camShown = Math.abs(c - camShown) > 4 * CELL ? c : lerp(camShown, c, per60(0.6));
  }
  drawGround(now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the tunnel…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  flat();
  drawTunnel(t, now);
  ctx.save();
  roundRect(FX0 - 2, FY0 - 2, FWP + 4, FHP + 4, 8);
  ctx.clip();
  drawWings(t, now);
  const me = myId();
  for (const id of bySeat(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st !== ALIVE) continue;
    const p = bodyAt(b, id);
    drawRunner(id, p[0], p[1], d, SEAT[d.c], false, now, !d.gr);
  }
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own && t.p[me] && t.p[me].st === ALIVE && own.to.p[me].st === ALIVE) {
    const p = bodyAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    drawRunner(me, x, y, p[2], SEAT[p[2].c], true, now, !p[2].gr);
  } else shown = null;
  ctx.restore();
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: how many flips so far. One button, any of them: a key,
// a click, a touch. A flip goes out at once, and is taken a trip later on
// every copy alike, if the table says the runner stands on something or holds
// a wing — and if not, it waits a moment for ground.
const FLIP_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Enter']);
let flips = 0;

function flip() {
  wake();
  if (!world) return;
  flips = (flips + 1) % 1000;
  setHand([flips]);
  const d = world.p[myId()];
  if (d && d.st === ALIVE && (d.gr || d.wi > 0) && (world.ph === WAIT || world.ph === PLAY)) sound.flip(d.dir > 0, true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (!FLIP_KEYS.has(e.code)) return;
  e.preventDefault();
  coarse = false;
  if (!e.repeat) flip();
});

// A touch flips the moment it lands; the pointer is held by the canvas until
// it lifts, because iOS keeps a long press inside a frame for itself.
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  coarse = e.pointerType === 'touch';
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  flip();
});

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. The first hand is how a player arrives
// in the tunnel.
function start() {
  setHand([flips]);
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
