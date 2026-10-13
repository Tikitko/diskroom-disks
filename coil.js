/**
 * @disk     coil
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Everyone steers a line that never stops growing behind them. Touch any line or the wall and you crash, so cut rivals off and hop a line when you are boxed in; sparks give hops. Every crash before yours is a point, and the walls close in.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/coil.png
 */
// coil.js — lines that never stop, on one floor, where the room's order is the
// referee.
//
// Every copy holds every cell of the floor and whose line runs through it,
// every head, the way it points and how long a hop has left, and changes it
// only on what comes back round the room, so every copy applies the same hands
// in the same order and holds the same floor. Nobody sends where they are,
// which cell they took or who crashed: a hand is which way a player turns, or
// the way they want to point, and a counter that moves on by one for every hop.
// Everything else is the same arithmetic on the same whole numbers on every
// machine. A page with a console open can steer its own line however it likes,
// no faster than every line turns, and hop no more often than it has hops.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own head does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — a cell is 64 units across, a speed
// is units a step, a heading is a 256th of a turn — and use nothing but
// `+ - * /`, comparisons, `Math.floor`, `Math.trunc`, `Math.min`, `Math.max`,
// `Math.abs` and `Math.imul`, whose results the language fixes to the last
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

// A quarter turn of headings, 1024 long. The other three quarters are the same
// numbers turned round. They are written out rather than worked out, because
// `Math.cos` may round its own way in another browser, and a line that bends a
// unit differently on one screen is a crash on that screen alone.
const QUARTER = [1024, 1023, 1019, 1013, 1004, 993, 980, 964, 946, 926, 903, 878, 851, 822, 792, 759, 724, 688, 650,
  610, 569, 526, 483, 438, 392, 345, 297, 249, 200, 150, 100, 50, 0];
const DIRS = 128;
function cosOf(i) {
  i &= DIRS - 1;
  return i <= 32 ? QUARTER[i] : i <= 64 ? -QUARTER[64 - i] : i <= 96 ? -QUARTER[i - 64] : QUARTER[128 - i];
}
const DX = [], DY = [];
for (let i = 0; i < DIRS; i++) { DX.push(cosOf(i)); DY.push(cosOf(i - 32)); }

// The heading, in 256ths of a turn, that points most nearly along (dx, dy).
function headingTo(dx, dy) {
  let best = 0, most = -Infinity;
  for (let i = 0; i < DIRS; i++) {
    const s = dx * DX[i] + dy * DY[i];
    if (s > most) { most = s; best = i; }
  }
  return best * 2;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own head a trip ahead, with your hand in it

// The floor: a grid of cells, four by three, each empty or holding the colour
// of the line through it, plus one. A line is one cell wide.
const GW = 128, GH = 96;
const CELL = 64;               // units across a cell
const FW_U = GW * CELL, FH_U = GH * CELL;

const SPEED0 = 20;             // units a step a line starts a round at
const SPEED_MAX = 30;          // and the fastest it gets
const SPEED_UP_EVERY = 6 * HZ; // a unit faster this often through a round
const TURN = 3;                // 256ths of a turn a head bends a step
const HOP_STEPS = 13;          // steps a hop lasts: no line is drawn, no line is hit
const HOPS0 = 1;               // hops a round starts with
const HOPS_MAX = 3;
const RECENT = 6;              // a head never hits the cells it has just drawn
const ORB_FIRST = 3 * HZ;      // steps into a round before the first spark
const ORB_EVERY = 4 * HZ;      // steps between sparks
const ORB_MAX = 3;             // sparks on the floor at once
const SQUEEZE_AT = 30 * HZ;    // steps into a round when the walls start in
const SQUEEZE_EVERY = 12;      // steps between two cells of it
const SQ_MAX = 56;             // the walls stop this many cells in
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const TARGET_MIN = 5;          // points a match is played to at the least
const FRESH_FILL = 0.38;       // past this share of the floor drawn on, practice wipes it
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 80 * HZ;
const END_STEPS = 5 * HZ;
const CHAMP_STEPS = 7 * HZ;    // the result stands longer when it ends a match
const BACK_STEPS = Math.round(1.5 * HZ);  // a practising player who crashed is back this soon

const OUT = 0, ALIVE = 1, CRASHED = 2;   // watching, on the floor, crashed this round

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   tg: the points a match is played to; sq: how far in the walls are; ob:
//   steps to the next spark; o: the sparks, [cell x, cell y]; g: every cell of
//   the floor, the colour of the line in it plus one, 0 empty; res: the last
//   round's [id, points it took, points, matches won] rows; win: who outlasted
//   everybody; champ: who took the match with it
function freshTable(seed) {
  return {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, tg: TARGET_MIN, sq: 0, ob: ORB_FIRST, o: [],
    g: new Array(GW * GH).fill(0), p: {}, res: null, win: -1, champ: -1,
  };
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'a', 'm', 'v', 'q', 'hq', 'air', 'hops', 'rc', 'rt', 'gn', 'pts', 'wn',
  'bt', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; st: watching, on the floor or crashed; x, y: the
//   head, in units; a: its heading; m, v: the hand, a turn (m 0, v -1 to 1)
//   or a heading to bend toward (m 1, v 0 to 255); q: the hop counter as last
//   heard; hq: a hop to take this step; air: steps of a hop left; hops: hops
//   left; rc: the cells the head drew last; rt: steps until a practising
//   player who crashed is back; gn: points this round, -1 for a watcher; pts:
//   points this match; wn: matches won; bt, bw: the bot's turn and its pause;
//   hs, hc: hands this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = f === 'rc' ? v[f].slice() : v[f];
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
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: OUT, x: FW_U >> 1, y: FH_U >> 1, a: 0, m: 0, v: 0, q, hq: 0, air: 0,
    hops: HOPS0, rc: [], rt: 0, gn: -1, pts: 0, wn: 0, bt: 0, bw: 0, hs: w.n, hc: 0,
  });
}

const cellOf = (u) => Math.floor(u / CELL);
const cellAt = (x, y) => cellOf(y) * GW + cellOf(x);
// Whether a cell is inside the walls as they stand: they close in on all four
// sides, three cells down for every four across, so the floor keeps its shape.
function inside(w, cx, cy) {
  const ix = w.sq, iy = (w.sq * 3) >> 2;
  return cx >= ix && cx < GW - ix && cy >= iy && cy < GH - iy;
}

function wipe(w, c) {
  for (let k = 0; k < w.g.length; k++) if (w.g[k] === c + 1) w.g[k] = 0;
}
function wipeAll(w) {
  w.g.fill(0);
}
function drawnShare(w) {
  let n = 0;
  for (let k = 0; k < w.g.length; k++) if (w.g[k]) n += 1;
  return n / w.g.length;
}

// A head put down on the floor, on its feet, with the cell under it drawn.
function place(w, d, x, y, a) {
  d.st = ALIVE;
  d.x = x;
  d.y = y;
  d.a = a & 255;
  d.air = d.hq = d.rt = 0;
  const k = cellAt(x, y);
  if (w.g[k] === 0) w.g[k] = d.c + 1;
  d.rc = [k];
}

// How far a head gets from (x, y) pointing at `a` and bending `turn` a step,
// in samples two steps apart, before a wall or a line stops it: `most` when
// nothing does. The cells in `skip` are the head's own neck.
const RUN_STEP = 2 * SPEED0;
function runLen(w, x, y, a, turn, most, skip) {
  let last = cellAt(x, y);
  for (let s = 1; s <= most; s++) {
    a = (a + turn * TURN * 2 + 256) & 255;
    x += Math.trunc((DX[a >> 1] * RUN_STEP) / 1024);
    y += Math.trunc((DY[a >> 1] * RUN_STEP) / 1024);
    if (x < 0 || y < 0 || x >= FW_U || y >= FH_U) return s - 1;
    const cx = cellOf(x), cy = cellOf(y);
    if (!inside(w, cx, cy)) return s - 1;
    const k = cy * GW + cx;
    if (k === last) continue;
    last = k;
    if (w.g[k] !== 0 && !(skip && skip.includes(k))) return s - 1;
  }
  return most;
}

function freeAround(w, cx, cy, r) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= GW || y >= GH || !inside(w, x, y) || w.g[y * GW + x] !== 0) return false;
    }
  }
  return true;
}

// Practice: an empty spot, away from everybody else, pointing the way with the
// most room ahead; null when the floor has none.
function freeSpot(w, id) {
  let best = null, score = -1;
  for (let tries = 0; tries < 40; tries++) {
    const cx = 8 + Math.floor(draw01(w) * (GW - 16)), cy = 8 + Math.floor(draw01(w) * (GH - 16));
    if (!freeAround(w, cx, cy, 2)) continue;
    let near = 40;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o === id || e.st !== ALIVE) continue;
      near = Math.min(near, Math.abs(cellOf(e.x) - cx) + Math.abs(cellOf(e.y) - cy));
    }
    const x = cx * CELL + (CELL >> 1), y = cy * CELL + (CELL >> 1);
    for (let k = 0; k < 16; k++) {
      const s = runLen(w, x, y, k * 16, 0, 40, null) * 2 + near;
      if (s > score) { score = s; best = [x, y, k * 16]; }
    }
  }
  return best;
}

// A fresh floor for practice: every line wiped and everybody put down again.
function freshFloor(w) {
  wipeAll(w);
  w.o = [];
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d.st === OUT) continue;
    const at = freeSpot(w, id);
    if (at) place(w, d, at[0], at[1], at[2]);
    d.hops = Math.max(d.hops, HOPS0);
  }
  fx(w, 'fresh', FW_U >> 1, FH_U >> 1, 0);
}

function respawn(w, id) {
  const d = w.p[id];
  wipe(w, d.c);
  if (drawnShare(w) > FRESH_FILL) { d.st = ALIVE; freshFloor(w); return; }
  const at = freeSpot(w, id);
  if (!at) { d.st = ALIVE; freshFloor(w); return; }
  place(w, d, at[0], at[1], at[2]);
  d.hops = Math.max(d.hops, HOPS0);
  fx(w, 'back', d.x, d.y, id);
}

// A hand, at its place in the room's order: [what kind of steer, how much,
// the hop counter]. A hop is asked for once, when the counter changes; the
// same hand said again to keep a player at the table hops nobody. Being heard
// is how a player arrives: on the floor while the table waits for a round or
// counts one in, and watching while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[2]);
    d.m = input[0];
    d.v = input[1];
    if (w.ph === WAIT || w.ph === COUNT) {
      const at = freeSpot(w, id);
      if (at) {
        place(w, d, at[0], at[1], at[2]);
        if (w.ph === COUNT) d.gn = 0;
      }
    }
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; how fast a line bends is the table's to say, not the
  // hand's.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.m = input[0];
  d.v = input[1];
  if (input[2] !== d.q) { d.q = input[2]; d.hq = 1; }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [m, v, q] = raw;
  if (!Number.isInteger(m) || !Number.isInteger(v) || !Number.isInteger(q)) return null;
  if (m === 0 ? v < -1 || v > 1 : m === 1 ? v < 0 || v > 255 : true) return null;
  if (q < 0 || q > 999) return null;
  return [m, v, q];
}

// Somebody gone from the room. Their line stays on the floor through a round,
// where it is somebody's wall; in practice it goes with them.
function leave(w, id) {
  const d = w.p[id];
  if (!d) return;
  if (w.ph === WAIT) wipe(w, d.c);
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_LOOK = 26;           // samples it looks ahead along each way
const BOT_IDLE = 0.08;         // how often it keeps on a moment rather than decide
const BOT_HOP = 0.55;          // how often it hops when it sees itself boxed in
const BOT_GREED = 0.5;         // how often it goes for a spark it has room to reach
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    const d = (w.p[BOT_ID] = newPlayer(w, 0));
    const at = freeSpot(w, BOT_ID);
    if (at) place(w, d, at[0], at[1], at[2]);
    else { d.st = CRASHED; d.rt = BACK_STEPS; }
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Three ways to bend — left, on, right — each looked along as far as it goes;
// the longest wins, going straight and going on as before a little ahead.
// Boxed in, it hops if it has one; a spark with room to reach it pulls it in.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== ALIVE || d.air > 0) return;
  if (w.n % BOT_EVERY !== 0) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (draw01(w) < BOT_IDLE) { d.bw = 1 + Math.floor(draw01(w) * 3); return; }
  let best = 0, score = -Infinity, far = 0;
  for (let t = -1; t <= 1; t++) {
    const run = runLen(w, d.x, d.y, d.a, t, BOT_LOOK, d.rc);
    far = Math.max(far, run);
    const s = run * 4 + (t === 0 ? 4 : 0) + (t === d.bt ? 2 : 0) + Math.floor(draw01(w) * 4);
    if (s > score) { score = s; best = t; }
  }
  d.m = 0;
  d.v = best;
  d.bt = best;
  if (far >= BOT_LOOK) {
    for (const [ox, oy] of w.o) {
      const tx = ox * CELL + (CELL >> 1), ty = oy * CELL + (CELL >> 1);
      const dist = Math.max(Math.abs(tx - d.x), Math.abs(ty - d.y));
      if (dist > 24 * CELL) continue;
      const h = headingTo(tx - d.x, ty - d.y);
      const need = Math.min(BOT_LOOK, Math.trunc(dist / RUN_STEP) + 1);
      if (runLen(w, d.x, d.y, h, 0, need, d.rc) >= need && draw01(w) < BOT_GREED) {
        d.m = 1;
        d.v = h;
        break;
      }
    }
  }
  if (far <= 4 && d.hops > 0 && draw01(w) < BOT_HOP) d.hq = 1;
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = w.champ = -1;
  w.sq = 0;
  w.o = [];
  w.ob = ORB_FIRST;
  wipeAll(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    d.pts = 0;
    d.gn = -1;
    d.hops = HOPS0;
    const at = freeSpot(w, id);
    if (at) place(w, d, at[0], at[1], at[2]);
    else { d.st = CRASHED; d.rt = BACK_STEPS; }
  }
}

// Where the heads start a round: as far from each other as a few tries find,
// each pointed roughly at the middle, so nobody starts facing a wall.
function roundSpots(w, n) {
  const spots = [];
  for (let i = 0; i < n; i++) {
    let best = null, score = -1;
    for (let tries = 0; tries < 30; tries++) {
      const cx = 18 + Math.floor(draw01(w) * (GW - 36)), cy = 14 + Math.floor(draw01(w) * (GH - 28));
      let near = BIG;
      for (const s of spots) near = Math.min(near, Math.abs(s[0] - cx) + Math.abs(s[1] - cy));
      if (near > score) { score = near; best = [cx, cy]; }
    }
    spots.push(best);
  }
  return spots;
}

// A round: an empty floor, the seats closed up in order, every head put down
// still. A match that ended starts over from nothing. Whoever has the fewest
// points, when somebody has more, starts with a hop to spare.
function begin(w) {
  const ids = bySeat(w);
  if (w.champ !== -1) for (const id of ids) w.p[id].pts = 0;
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = w.champ = -1;
  w.sq = 0;
  w.o = [];
  w.ob = ORB_FIRST;
  wipeAll(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  w.tg = Math.max(TARGET_MIN, 5 * (ids.length - 1));
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) { lo = Math.min(lo, w.p[id].pts); hi = Math.max(hi, w.p[id].pts); }
  const spots = roundSpots(w, ids.length);
  ids.forEach((id, i) => {
    const d = w.p[id];
    const x = spots[i][0] * CELL + (CELL >> 1), y = spots[i][1] * CELL + (CELL >> 1);
    const a = headingTo((FW_U >> 1) - x, (FH_U >> 1) - y) + Math.floor(draw01(w) * 48) - 24;
    place(w, d, x, y, a);
    d.hops = HOPS0 + (hi > lo && d.pts === lo ? 1 : 0);
    d.gn = 0;
  });
  fx(w, 'round', FW_U >> 1, FH_U >> 1, 0);
}

// The round is over: whoever is still on the floor outlasted everybody, and
// a match is won by the first to its points with nobody level.
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
  fx(w, 'end', FW_U >> 1, FH_U >> 1, w.win, w.champ);
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
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
      return;
    }
  }
  if (w.ph === END) return;
  // While a round is counted in, a head turns where it stands, so everybody
  // can pick the way they set off.
  if (w.ph === COUNT) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      d.hq = 0;
      if (d.st === ALIVE) bend(d);
    }
    return;
  }
  move(w);
}

// A hand becomes a bend: a turn bends at the full rate, a heading is bent
// toward along the shorter way and no faster. Nobody bends in the air.
function bend(d) {
  let t;
  if (d.m === 0) t = d.v * TURN;
  else {
    const diff = ((d.v - d.a + 384) & 255) - 128;
    t = diff > 0 ? Math.min(TURN, diff) : -Math.min(TURN, -diff);
  }
  d.a = (d.a + t + 256) & 255;
}

function move(w) {
  const practice = w.ph === WAIT;
  const into = PLAY_STEPS - w.pt;
  const speed = practice ? SPEED0 : Math.min(SPEED_MAX, SPEED0 + Math.floor(into / SPEED_UP_EVERY));
  if (!practice) squeeze(w, into);
  botThink(w);
  const ids = bySeat(w);
  // Every head moves on the floor as it stood before the step: what each one
  // runs into is decided before any of them draws, so the order of the seats
  // decides nothing. Two heads into one cell at once both crash.
  const crashed = new Map();   // id -> the colour of the line it hit, plus one; 0 for a wall
  const draws = new Map();     // id -> the cells it draws this step
  const claims = new Map();    // cell -> heads drawing it this step
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== ALIVE) { d.hq = 0; continue; }
    if (d.hq) {
      d.hq = 0;
      if (d.air === 0 && d.hops > 0) {
        d.hops -= 1;
        d.air = HOP_STEPS + 1;
        fx(w, 'hop', d.x, d.y, id);
      }
    }
    if (d.air === 0) bend(d);
    const wasAir = d.air > 0;
    if (wasAir) d.air -= 1;
    const flying = d.air > 0;
    const ox = cellOf(d.x), oy = cellOf(d.y);
    const x = d.x + Math.trunc((DX[d.a >> 1] * speed) / 1024), y = d.y + Math.trunc((DY[d.a >> 1] * speed) / 1024);
    if (x < 0 || y < 0 || x >= FW_U || y >= FH_U) { crashed.set(id, 0); continue; }
    d.x = x;
    d.y = y;
    const nx = cellOf(x), ny = cellOf(y);
    const cells = [];
    if (nx !== ox || ny !== oy) {
      // Across a corner, through the cell beside it: a line is a chain of
      // cells side to side, so another line can never slip through its joints.
      if (nx !== ox && ny !== oy) cells.push(oy * GW + nx);
      cells.push(ny * GW + nx);
    } else if (wasAir && !flying) cells.push(ny * GW + nx);
    const mine = [];
    let hit = -1;
    for (const k of cells) {
      if (!inside(w, k % GW, Math.floor(k / GW))) { hit = 0; break; }
      if (flying || d.rc.includes(k)) continue;
      if (w.g[k] !== 0) { hit = w.g[k]; break; }
      mine.push(k);
    }
    if (wasAir && !flying && hit < 0) fx(w, 'land', d.x, d.y, id);
    if (hit >= 0) { crashed.set(id, hit); continue; }
    draws.set(id, mine);
    for (const k of mine) claims.set(k, (claims.get(k) || 0) + 1);
  }
  for (const [id, mine] of draws) {
    const d = w.p[id];
    for (const k of mine) if (claims.get(k) > 1) { crashed.set(id, 9); break; }
    if (crashed.has(id)) continue;
    for (const k of mine) {
      w.g[k] = d.c + 1;
      d.rc.push(k);
    }
    if (d.rc.length > RECENT) d.rc.splice(0, d.rc.length - RECENT);
    // The walls closing in take whoever they reach.
    if (!inside(w, cellOf(d.x), cellOf(d.y))) crashed.set(id, 0);
  }
  sparks(w);
  if (crashed.size) {
    for (const [id, by] of crashed) {
      const d = w.p[id];
      d.st = CRASHED;
      d.air = 0;
      d.x = Math.max(0, Math.min(FW_U - 1, d.x));
      d.y = Math.max(0, Math.min(FH_U - 1, d.y));
      if (practice) d.rt = BACK_STEPS;
      fx(w, 'crash', d.x, d.y, id, by);
    }
    if (!practice) {
      // A point for every line that crashed while yours was still going.
      for (const id of ids) {
        const d = w.p[id];
        if (d.st !== ALIVE) continue;
        d.pts += crashed.size;
        d.gn += crashed.size;
        fx(w, 'point', d.x, d.y, id, crashed.size);
      }
    }
  }
  if (practice) {
    for (const id of ids) {
      const d = w.p[id];
      if (d && d.st === CRASHED && d.rt > 0 && --d.rt === 0) respawn(w, id);
    }
    return;
  }
  let still = 0;
  for (const id of ids) if (w.p[id].st === ALIVE) still += 1;
  if (still <= 1) finish(w);
}

// Sparks: one now and then on an empty patch of floor, a hop to whoever runs
// through it — in the air or not.
function sparks(w) {
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d.st !== ALIVE) continue;
    const cx = cellOf(d.x), cy = cellOf(d.y);
    for (let i = 0; i < w.o.length; i++) {
      const [ox, oy] = w.o[i];
      if (Math.abs(ox - cx) > 1 || Math.abs(oy - cy) > 1) continue;
      w.o.splice(i, 1);
      d.hops = Math.min(HOPS_MAX, d.hops + 1);
      fx(w, 'orb', ox * CELL + (CELL >> 1), oy * CELL + (CELL >> 1), id);
      break;
    }
  }
  if (w.ob > 0) w.ob -= 1;
  if (w.ob > 0 || w.o.length >= ORB_MAX) return;
  w.ob = ORB_EVERY;
  for (let tries = 0; tries < 20; tries++) {
    const cx = 4 + Math.floor(draw01(w) * (GW - 8)), cy = 4 + Math.floor(draw01(w) * (GH - 8));
    if (!freeAround(w, cx, cy, 2)) continue;
    w.o.push([cx, cy]);
    fx(w, 'spark', cx * CELL + (CELL >> 1), cy * CELL + (CELL >> 1), 0);
    return;
  }
}

// The walls close in, a cell at a time, half a minute into a round; a spark
// they reach is gone.
function squeeze(w, into) {
  if (into === SQUEEZE_AT - 2 * HZ) fx(w, 'warn', FW_U >> 1, FH_U >> 1, 0);
  if (into < SQUEEZE_AT || (into - SQUEEZE_AT) % SQUEEZE_EVERY !== 0 || w.sq >= SQ_MAX) return;
  w.sq += 1;
  w.o = w.o.filter(([x, y]) => inside(w, x, y));
  if (w.sq % 4 === 1) fx(w, 'squeeze', 0, 0, w.sq);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.tg, TARGET_MIN, 5 * MAX_P) || !int(raw.sq, 0, SQ_MAX) || !int(raw.ob, 0, ORB_EVERY)) return null;
  if (!Array.isArray(raw.o) || raw.o.length > ORB_MAX) return null;
  for (const s of raw.o) if (!Array.isArray(s) || s.length !== 2 || !int(s[0], 0, GW - 1) || !int(s[1], 0, GH - 1)) return null;
  if (!Array.isArray(raw.g) || raw.g.length !== GW * GH || !raw.g.every((v) => int(v, 0, MAX_P))) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, OUT, CRASHED) || !int(d.x, 0, FW_U - 1) || !int(d.y, 0, FH_U - 1) || !int(d.a, 0, 255)) return null;
    if (inputOf([d.m, d.v, d.q]) === null || !int(d.hq, 0, 1) || !int(d.air, 0, HOP_STEPS + 1)) return null;
    if (!int(d.hops, 0, HOPS_MAX) || !Array.isArray(d.rc) || d.rc.length > RECENT) return null;
    if (!d.rc.every((k) => int(k, 0, GW * GH - 1))) return null;
    if (!int(d.rt, 0, BACK_STEPS) || !int(d.gn, -1, 999999) || !int(d.pts, 0, 999999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bt, -1, 1) || !int(d.bw, 0, 9) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
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
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, tg: raw.tg, sq: raw.sq, ob: raw.ob, o: raw.o.map((s) => s.slice()),
    g: raw.g.slice(), p, res, win: raw.win, champ: raw.champ,
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
// One palette: neon lines on a deep ink floor. Each seat has a bright colour
// of its own, its line and its head alike, with a soft glow round the head so
// it reads on any line.
const INK = {
  page: '#0d1024', glow: '#1d2150', floor: '#141834', floorHi: '#1a1f42', dot: 'rgba(160,170,255,0.09)',
  rim: '#4b55a8', text: '#ffffff', muted: '#c4c7ea', dim: '#7f84b2', gold: '#ffd166', danger: '#ff5a6e',
  wall: '#2a1530', hazard: '#ff5a6e', outline: '#0b0d1e', panel: 'rgba(14,16,36,0.93)', spark: '#fff3a0',
};
const SEAT = ['#ff4f7b', '#3fd3ff', '#ffd23f', '#7dff6a', '#c77dff', '#ff8a3d', '#f4f4ff', '#2effc8'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #3f4785;' +
  `background:#1d2150;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, TOP = 58, BOT = 26, dpx = 1;
let CP = 4, FX0 = 0, FY0 = 0, FWP = 512, FHP = 384, fieldBot = 400;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
  // The floor keeps its own shape, as large as the frame lets it be, with a
  // strip under it: NOTE_ROOM keeps the practice note off the bottom row, and
  // in a round the same strip says how many hops you have.
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  CP = Math.max(0.5, Math.min((VW - 16) / GW, ah / GH));
  FWP = GW * CP;
  FHP = GH * CP;
  FX0 = (VW - FWP) / 2;
  FY0 = TOP + (ah - FHP) / 2;
  fieldBot = FY0 + FHP;
}
layout();
window.addEventListener('resize', layout);

// Floor units to the screen.
const SX = (u) => FX0 + (u / CELL) * CP + shakeX;
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
  hop() { if (ready('hop', 60)) { tone(300, 0.18, 'triangle', 0.1, 2.4); puff(0.1, 0.03, 2400, 0, 2); } },
  land(near) { if (ready('land', 60)) { tone(160, 0.12, 'sine', 0.05 + 0.08 * near, 0.6); puff(0.08, 0.03 + 0.04 * near, 700, 0, 1); } },
  crash(me, near) {
    if (!ready('crash', 50)) return;
    puff(me ? 0.5 : 0.3, me ? 0.16 : 0.05 + 0.08 * near, 380, 0, 0.6);
    tone(me ? 240 : 320, me ? 0.55 : 0.25, 'sawtooth', me ? 0.07 : 0.03 + 0.03 * near, 0.25);
  },
  point(n) { if (ready('point', 90)) for (let i = 0; i < Math.min(3, n); i++) tone(880 + 220 * i, 0.09, 'sine', 0.07, 1.1, i * 0.06); },
  orb() { if (ready('orb', 80)) [988, 1319, 1760].forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, i * 0.045)); },
  spark() { if (ready('spark', 300)) tone(1568, 0.12, 'sine', 0.025, 1.2); },
  back() { if (ready('back', 200)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.05)); },
  fresh() { if (ready('fresh', 300)) [392, 523, 659, 784].forEach((f, i) => tone(f, 0.14, 'triangle', 0.08, 0, i * 0.06)); },
  warn() { if (ready('warn', 400)) [392, 370, 349].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.04, 1, i * 0.18)); },
  squeeze() { if (ready('squeeze', 300)) { puff(0.3, 0.05, 160, 0, 0.7); tone(70, 0.3, 'sine', 0.07, 0.8); } },
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
// fast screen and a slow one see the same sparks. Positions are floor units.
const bits = [];      // { x, y, vx, vy, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.25 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 16 + Math.random() * 24, size, colour });
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
const nearOf = (md, x, y) => (md && md.st === ALIVE ? Math.max(0, 1 - (Math.abs(md.x - x) + Math.abs(md.y - y)) / (40 * CELL)) : 0.3);
const crashes = new Map();    // id -> [x, y, when]: where a line ended this round

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = nearOf(md, e.x, e.y);
  if (e.kind === 'hop') {
    spray(e.x, e.y, 8, '#ffffff', 12 * CELL, 2.5);
    if (e.a !== me) sound.hop();
  } else if (e.kind === 'land') {
    ring(e.x, e.y, colourOf(t, e.a), 3 * CELL);
    spray(e.x, e.y, 6, colourOf(t, e.a), 10 * CELL, 2);
    sound.land(e.a === me ? 1 : near);
  } else if (e.kind === 'crash') {
    const colour = colourOf(t, e.a);
    crashes.set(e.a, [e.x, e.y, performance.now()]);
    spray(e.x, e.y, 26, colour, 30 * CELL, 3);
    spray(e.x, e.y, 10, '#ffffff', 18 * CELL, 2);
    ring(e.x, e.y, colour, 7 * CELL);
    pop(e.x, e.y, 'crash!', colour, e.a === me ? 18 : 14);
    shake = Math.max(shake, e.a === me ? 14 : 2 + 6 * near);
    sound.crash(e.a === me, near);
  } else if (e.kind === 'point') {
    if (e.a === me) { pop(e.x, e.y - 2 * CELL, '+' + e.b, INK.gold, 17); sound.point(e.b); }
  } else if (e.kind === 'orb') {
    spray(e.x, e.y, 14, INK.spark, 16 * CELL, 2.5);
    ring(e.x, e.y, INK.spark, 4 * CELL);
    if (e.a === me) { pop(e.x, e.y, '+hop', INK.spark, 16); sound.orb(); }
  } else if (e.kind === 'spark') {
    ring(e.x, e.y, INK.spark, 3 * CELL);
    sound.spark();
  } else if (e.kind === 'back') {
    ring(e.x, e.y, colourOf(t, e.a), 5 * CELL);
    crashes.delete(e.a);
    if (e.a === me) sound.back();
  } else if (e.kind === 'fresh') {
    crashes.clear();
    pop(e.x, e.y, 'fresh floor', INK.gold, 22);
    sound.fresh();
  } else if (e.kind === 'warn') {
    pop(e.x, e.y, 'the walls close in!', INK.hazard, 22);
    sound.warn();
  } else if (e.kind === 'squeeze') {
    shake = Math.max(shake, 3);
    sound.squeeze();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'round') {
    crashes.clear();
  } else if (e.kind === 'end') {
    sound.end(e.a === me || e.b === me);
  }
}

function drawGround(now) {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
}

// The floor: a slab a little lighter than the page, a faint dotted grid every
// eight cells, and a rim that glows.
function drawFloor(t, now, sqShown) {
  const x0 = FX0 + shakeX, y0 = FY0 + shakeY;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(x0 - 6, y0 - 4, FWP + 12, FHP + 14, 10);
  ctx.fill();
  const f = ctx.createLinearGradient(0, y0, 0, y0 + FHP);
  f.addColorStop(0, INK.floorHi);
  f.addColorStop(1, INK.floor);
  ctx.fillStyle = f;
  roundRect(x0 - 3, y0 - 3, FWP + 6, FHP + 6, 7);
  ctx.fill();
  ctx.fillStyle = INK.dot;
  const r = Math.max(0.8, CP * 0.18);
  for (let cy = 8; cy < GH; cy += 8) {
    for (let cx = 8; cx < GW; cx += 8) {
      ctx.fillRect(x0 + cx * CP - r, y0 + cy * CP - r, 2 * r, 2 * r);
    }
  }
  ctx.strokeStyle = INK.rim;
  ctx.lineWidth = 2;
  roundRect(x0 - 3, y0 - 3, FWP + 6, FHP + 6, 7);
  ctx.stroke();
  // The walls as they close in: a dark band from the rim to where they stand,
  // striped, with a hot edge.
  if (sqShown > 0.01) {
    const ix = sqShown * CP, iy = sqShown * 0.75 * CP;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, FWP, FHP);
    ctx.rect(x0 + ix, y0 + iy, FWP - 2 * ix, FHP - 2 * iy);
    ctx.clip('evenodd');
    ctx.fillStyle = INK.wall;
    ctx.fillRect(x0, y0, FWP, FHP);
    ctx.strokeStyle = 'rgba(255,90,110,0.18)';
    ctx.lineWidth = Math.max(2, CP * 1.2);
    ctx.beginPath();
    const step = Math.max(8, CP * 5), off = (now / 40) % step;
    for (let s = -FHP; s < FWP + FHP; s += step) {
      ctx.moveTo(x0 + s + off, y0);
      ctx.lineTo(x0 + s + off - FHP, y0 + FHP);
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = alpha(INK.hazard, 0.65 + 0.3 * Math.sin(now / 120));
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + ix, y0 + iy, FWP - 2 * ix, FHP - 2 * iy);
  }
}

// The lines are drawn into a picture of their own, a cell at a time as they
// grow, and the picture is laid over the floor each frame: redrawing every
// cell of every line every frame would cost a phone its frame rate. A cell
// that empties — a line wiped, a fresh floor, a table taken afresh — redraws
// the whole picture.
const trail = document.createElement('canvas');
const tctx = trail.getContext('2d');
let trailK = 0;
const drawnG = new Uint8Array(GW * GH);
function syncTrail(g) {
  const k = Math.max(2, Math.min(24, Math.round(CP * dpx)));
  let full = k !== trailK;
  if (!full) for (let i = 0; i < g.length; i++) if (drawnG[i] && g[i] !== drawnG[i]) { full = true; break; }
  if (full) {
    trailK = k;
    trail.width = GW * k;
    trail.height = GH * k;
    tctx.clearRect(0, 0, trail.width, trail.height);
    drawnG.fill(0);
  }
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    if (!v || drawnG[i] === v) continue;
    drawnG[i] = v;
    const cx = i % GW, cy = (i - cx) / GW;
    tctx.fillStyle = SEAT[v - 1];
    tctx.beginPath();
    tctx.arc((cx + 0.5) * k, (cy + 0.5) * k, k * 0.64, 0, Math.PI * 2);
    tctx.fill();
  }
}
function drawTrail() {
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(trail, FX0 + shakeX, FY0 + shakeY, FWP, FHP);
}

// Sparks: a little star that breathes.
function drawSparks(t, now) {
  for (const [cx, cy] of t.o) {
    const x = SX(cx * CELL + CELL / 2), y = SY(cy * CELL + CELL / 2);
    const r = Math.max(4, CP * 1.6) * (1 + 0.12 * Math.sin(now / 160 + cx));
    ctx.fillStyle = alpha(INK.spark, 0.16);
    disc(x, y, r * 2);
    ctx.fill();
    ctx.fillStyle = INK.spark;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 + now / 900, rr = i % 2 ? r * 0.42 : r;
      if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }
}

// A head as drawn: a bright bead in the line's colour on a soft glow, ringed
// in ink, with an eye the way it points. In a hop it lifts off its shadow and
// swells. `aim` draws the way it will set off, while a round is counted in.
function drawHead(id, x, y, a, d, colour, me, now, air, aim) {
  const sx = SX(x), sy = SY(y);
  const r = Math.max(3.2, CP * 1.05);
  const lift = air > 0 ? Math.sin(Math.PI * air) * r * 2.2 : 0;
  const k = 1 + (air > 0 ? 0.45 * Math.sin(Math.PI * air) : 0);
  const ux = Math.cos((a / 256) * Math.PI * 2), uy = Math.sin((a / 256) * Math.PI * 2);
  if (aim) {
    ctx.strokeStyle = alpha(colour, 0.6);
    ctx.lineWidth = Math.max(1.5, CP * 0.5);
    ctx.setLineDash([Math.max(3, CP * 1.2), Math.max(3, CP * 1.2)]);
    ctx.beginPath();
    ctx.moveTo(sx + ux * r * 1.6, sy + uy * r * 1.6);
    ctx.lineTo(sx + ux * r * 7, sy + uy * r * 7);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(sx + ux * r * 8.4, sy + uy * r * 8.4);
    ctx.lineTo(sx + ux * r * 6.6 - uy * r * 1.1, sy + uy * r * 6.6 + ux * r * 1.1);
    ctx.lineTo(sx + ux * r * 6.6 + uy * r * 1.1, sy + uy * r * 6.6 - ux * r * 1.1);
    ctx.closePath();
    ctx.fill();
  }
  if (lift > 0) {
    ctx.fillStyle = 'rgba(5,6,18,0.45)';
    ctx.beginPath(); ctx.ellipse(sx, sy + r * 0.3, r * 1.1, r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
  }
  const by = sy - lift;
  ctx.fillStyle = alpha(colour, 0.22 + 0.08 * Math.sin(now / 200));
  disc(sx, by, r * k * 2.3);
  ctx.fill();
  ctx.fillStyle = INK.outline;
  disc(sx, by, r * k + 1.5);
  ctx.fill();
  ctx.fillStyle = colour;
  disc(sx, by, r * k);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  disc(sx - r * k * 0.3, by - r * k * 0.35, r * k * 0.3);
  ctx.fill();
  ctx.fillStyle = INK.outline;
  disc(sx + ux * r * k * 0.45, by + uy * r * k * 0.45, r * k * 0.28);
  ctx.fill();
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    disc(sx, by, r * k + 4);
    ctx.stroke();
  }
  const px = Math.max(9, Math.min(13, CP * 2.6));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(10,12,30,0.8)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  const ly = by - r * k - 6;
  ctx.strokeText(label, sx, ly);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, sx, ly);
  // Hops left, as pips over the name.
  if (d.hops > 0) {
    for (let h = 0; h < d.hops; h++) {
      ctx.fillStyle = INK.spark;
      disc(sx + (h - (d.hops - 1) / 2) * 6, ly - px - 1, 2);
      ctx.fill();
    }
  }
}

// Where a line ended: a cross in its colour, fading over the round.
function drawCrashes(t, now) {
  for (const [id, [x, y, at]] of crashes) {
    const d = t.p[id];
    if (!d || d.st !== CRASHED) continue;
    const sx = SX(x), sy = SY(y), r = Math.max(4, CP * 1.6);
    const k = Math.min(1, (now - at) / 250);
    ctx.globalAlpha = 0.95 - 0.35 * k;
    ctx.strokeStyle = INK.outline;
    ctx.lineWidth = Math.max(3, CP * 0.9) + 2;
    ctx.beginPath();
    ctx.moveTo(sx - r, sy - r); ctx.lineTo(sx + r, sy + r);
    ctx.moveTo(sx + r, sy - r); ctx.lineTo(sx - r, sy + r);
    ctx.stroke();
    ctx.strokeStyle = SEAT[d.c];
    ctx.lineWidth = Math.max(3, CP * 0.9);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawBits() {
  flat();
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    disc(SX(b.x), SY(b.y), b.size * (1 - f * 0.5) * Math.max(0.7, CP / 5));
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
    ctx.strokeStyle = 'rgba(10,12,30,0.85)';
    const X = Math.max(60, Math.min(VW - 60, SX(p.x))), Y = SY(p.y) - rise;
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
  // The status line: the phase, and the time and lines left in it.
  let status = '', colour = INK.text;
  const into = PLAY_STEPS - t.pt;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(into) + ' · ' + going(t) + ' going';
    if (t.sq > 0) {
      status += ' · the walls close in';
      colour = Math.floor(now / 400) % 2 ? INK.hazard : INK.text;
    }
  } else status = 'round ' + t.rd + ' · over';
  text('coil', 12, 22, titlePx, SEAT[1], 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('coil').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points; the chip
  // of somebody whose line has crashed this round is hollow.
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
    ? 'drag the way to go · tap to hop · never touch a line'
    : 'arrows/AD or mouse steer · space or click hops · never touch a line · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// Your hops, and what the match is played to, in the strip under the floor
// while a round is on.
function drawMine(t) {
  if (t.ph === WAIT) return;
  flat();
  const d = t.p[myId()];
  const y = Math.min(fieldBot + NOTE_ROOM / 2, VH - BOT - 18);
  const goal = 'first to ' + t.tg;
  if (!d || d.st !== ALIVE) {
    const line = !d || d.st === OUT ? 'watching · you play from the next round · ' + goal
      : t.ph === PLAY ? 'your line crashed · watch the rest · ' + goal : goal;
    fitText(line, VW / 2, y + 5, 13, INK.muted, VW - 24);
    return;
  }
  ctx.font = font(13);
  const label = 'hops', lw = ctx.measureText(label).width, gw = ctx.measureText(goal).width;
  const total = lw + 10 + Math.max(1, d.hops) * 18 + 30 + gw;
  let x = VW / 2 - total / 2;
  text(label, x, y + 5, 13, INK.muted, 'left');
  x += lw + 10;
  if (!d.hops) { text('none', x, y + 5, 13, INK.dim, 'left'); x += 40; }
  for (let h = 0; h < d.hops; h++) {
    ctx.fillStyle = INK.spark;
    disc(x + 7, y, 6);
    ctx.fill();
    ctx.strokeStyle = SEAT[d.c];
    ctx.lineWidth = 1.5;
    ctx.stroke();
    x += 18;
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
    const tip = two ? null : 'never touch a line · hop over one when boxed in · sparks give hops';
    practiceNote(now, VW, head, tip, [[TOP, FY0 - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(10,12,30,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 330), 30);
    fitText('turn to aim · a point for every crash before yours', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 310));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(10,12,30,0.6)';
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
      head = t.win === me ? 'your line outlasted them all!' : nickOf(t.win) + ' outlasted them all';
      hc = colourOf(t, t.win);
    } else head = 'every line crashed at once';
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

// Where a head stands as drawn: between two steps, and never slid across a
// jump — a head put down somewhere new.
function headAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 3 * CELL) return [z.x, z.y, z, a];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z, a];
}
// How far through a hop (0 to 1) a head is, as drawn.
function airOf(a, z, k) {
  if (!z.air && !(a && a.air)) return 0;
  const left = a && a.air > 0 ? lerp(a.air, z.air, k) : z.air;
  return Math.max(0, Math.min(1, 1 - left / (HOP_STEPS + 1)));
}
// A heading as drawn, turned the shorter way between two steps.
function angleAt(a, z, k) {
  if (!a) return z.a;
  const diff = ((z.a - a.a + 384) & 255) - 128;
  return a.a + diff * k;
}

// Your own head is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a turn a step away from where
// the guess had it. So the head drawn is pulled toward the guess a little
// every frame rather than put on it, and a guess far off — a table taken
// afresh, a head put down again — puts it there at once. The line it draws
// on the agreed floor is a trip behind it, so the stretch between is drawn
// from where the head has been on this screen. Only the drawing is smoothed:
// the floor, and every rule on it, are untouched.
const PULL = 0.5;
let shown = null;        // [x, y] in units: where your head is drawn
let myPos = null;        // the same, while your head is on the floor
const tail = [];         // [x, y, when, in the air] for the stretch the agreed floor has not drawn yet
const TAIL_MS = 450;

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 4 * CELL) {
    tail.length = 0;
    return (shown = [x, y]);
  }
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function drawTail(colour, now) {
  while (tail.length && now - tail[0][2] > TAIL_MS) tail.shift();
  if (tail.length < 2) return;
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.5, CP * 1.28);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let on = false;
  for (const [x, y, , air] of tail) {
    if (air) { on = false; continue; }
    if (on) ctx.lineTo(SX(x), SY(y));
    else { ctx.moveTo(SX(x), SY(y)); on = true; }
  }
  ctx.stroke();
  ctx.lineCap = 'butt';
}

let sqShown = 0;
function draw(now) {
  const b = agreedAt(now);
  drawGround(now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the floor…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  sqShown = t.sq < sqShown - 1 ? t.sq : lerp(sqShown, t.sq, per60(0.25));
  flat();
  drawFloor(t, now, sqShown);
  syncTrail(t.g);
  drawTrail();
  drawSparks(t, now);
  drawCrashes(t, now);
  const me = myId();
  const aiming = t.ph === COUNT;
  for (const id of bySeat(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st !== ALIVE) continue;
    const p = headAt(b, id);
    drawHead(id, p[0], p[1], angleAt(p[3], d, b.k), d, SEAT[d.c], false, now, airOf(p[3], d, b.k), aiming);
  }
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own && t.p[me] && t.p[me].st === ALIVE && own.to.p[me].st !== OUT) {
    const p = headAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    const d = t.p[me];
    const air = airOf(p[3], p[2], own.k);
    myPos = [x, y];
    if (t.ph === PLAY || t.ph === WAIT) tail.push([x, y, now, air > 0]);
    drawTail(SEAT[d.c], now);
    drawHead(me, x, y, angleAt(p[3], p[2], own.k), d, SEAT[d.c], true, now, air, aiming);
  } else {
    myPos = shown = null;
    tail.length = 0;
  }
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: a turn (left, on, right) from the keys, or a heading to
// bend toward from a thumb or a mouse, and how many hops so far. A change of
// heading goes out no oftener than STEER_EVERY, because a thumb or a mouse
// changes it on every move the screen reports and the clock's ticks share the
// same seat's ceiling on messages; a turn from the keys and a hop go at once.
const STEER_EVERY = 80;
let mode = '';           // what steers: 'keys', 'mouse', 'touch', or nothing yet
let hopsAsked = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_TURN = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
const HOP_KEYS = new Set(['Space', 'ArrowUp', 'KeyW', 'Enter']);

// A thumb: a stick from wherever it lands, and the line bends toward the way
// it is pushed; a tap hops — a drag rather than a press, because iOS keeps a
// long press inside a frame for itself. A second finger down while the first
// steers hops too. A mouse: the line bends toward the pointer; a click hops.
const DEAD = 12;
const REACHOUT = 46;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }
const mouse = { x: 0, y: 0, on: false };
const headingOf = (dx, dy) => Math.round((Math.atan2(dy, dx) / (Math.PI * 2)) * 256) & 255;

function steerNow() {
  if (mode === 'keys') {
    let t = 0;
    for (const c of keys) t += KEY_TURN[c];
    return [0, Math.max(-1, Math.min(1, t))];
  }
  if (mode === 'touch') {
    if (!stick || Math.hypot(stick.dx, stick.dy) < DEAD) return [0, 0];
    return [1, headingOf(stick.dx, stick.dy)];
  }
  if (mode === 'mouse' && mouse.on && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]);
    if (Math.hypot(dx, dy) < CP * 3) return [0, 0];
    return [1, headingOf(dx, dy)];
  }
  return [0, 0];
}

function sayHand(now, force) {
  const [m, v] = steerNow();
  const h = [m, v, hopsAsked], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1] && h[2] === s[2]) return;
  if (!force && s && h[2] === s[2] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A hop: heard at once, and taken a trip later on every copy alike, if the
// table says there is one left.
function hop() {
  wake();
  if (!world) return;
  hopsAsked = (hopsAsked + 1) % 1000;
  sayHand(performance.now(), true);
  const d = world.p[myId()];
  if (d && d.st === ALIVE && d.air === 0 && d.hops > 0 && world.ph !== COUNT && world.ph !== END) sound.hop();
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (HOP_KEYS.has(e.code)) {
    e.preventDefault();
    if (!e.repeat) hop();
    return;
  }
  if (!(e.code in KEY_TURN)) return;
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
  mouse.on = false;
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    mode = 'touch';
    if (stick) { hop(); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0, at: performance.now(), moved: false };
    paintStick();
    return;
  }
  coarse = false;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mode = 'mouse';
  mouse.on = true;
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  hop();
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    stick.dx = e.clientX - stick.ox;
    stick.dy = e.clientY - stick.oy;
    if (Math.hypot(stick.dx, stick.dy) >= DEAD) stick.moved = true;
    paintStick();
    sayHand(performance.now(), false);
  } else if (e.pointerType === 'mouse') {
    const moved = Math.abs(e.clientX - mouse.x) + Math.abs(e.clientY - mouse.y);
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    // A mouse resting on the frame while the keys steer leaves them to it.
    if (mode === 'keys' && keys.size) return;
    if (mode !== 'mouse' && moved < 4) return;
    mode = 'mouse';
    mouse.on = true;
    coarse = false;
  }
});
cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') mouse.on = false; });
function liftPointer(e) {
  if (!stick || e.pointerId !== stick.id) return;
  const tap = !stick.moved && performance.now() - stick.at < 260;
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
  if (tap) hop();
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

// Called by the kernel once it stands. Going straight is a hand too: it is how
// a player arrives on the floor.
function start() {
  setHand([0, 0, hopsAsked]);
  lastSaid = [0, 0, hopsAsked];
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
