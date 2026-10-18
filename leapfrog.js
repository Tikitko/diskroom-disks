/**
 * @disk     leapfrog
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Everybody hops one busy road and one river at once, racing for five lily pads that hold a frog each. Ride the logs, dodge the trucks, and land on a rival to shove them into trouble. Every wave runs faster, and whoever trails starts from the middle bank.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/leapfrog.png
 */
// leapfrog.js — a crowd of frogs crossing one road and one river, where the
// room's order is the referee.
//
// Every copy holds every lane of traffic and every log on the river, where each
// of them stands and how fast it goes, and every frog, and changes them only on
// what comes back round the room, so every copy applies the same hands in the
// same order and holds the same crossing. Nobody sends where their frog is,
// whether it was run over or which pad it took: a hand is the way a player holds
// their frog and a counter of hops asked for, with the way the last one was
// asked. Everything else is the same arithmetic on the same whole numbers on
// every machine. A page with a console open can hop its own frog however it
// likes, no oftener than any frog hops, and nothing else.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own frog does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole units and whole steps only, and use nothing but
// `+ - * /`, comparisons, `Math.floor`, `Math.min`, `Math.max`, `Math.abs` and
// `Math.imul`, whose results the language fixes to the last bit.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const mod = (a, m) => ((a % m) + m) % m;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pick = (w, lo, hi) => lo + Math.floor(draw01(w) * (hi - lo + 1));

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own frog a trip ahead, with your hand in it

// The crossing: a grid of cells, counted in units so that traffic can move by
// less than a cell a step. The top row is the far bank with its lily pads, then
// five lanes of river, a middle bank, five lanes of road and the near bank
// every frog starts from. A lane runs on past both edges, so whatever is in it
// drives out of sight and comes back round.
const U = 240;                 // units of length in a cell
const COLS = 15, ROWS = 13;
const FIELD = COLS * U;
const MARGIN = 3 * U;
const LOOP = FIELD + 2 * MARGIN;
const PAD_ROW = 0, MID_ROW = 6, START_ROW = 12;
const PADS = [1, 4, 7, 10, 13];
const isRiver = (r) => r >= 1 && r <= 5;
const isRoad = (r) => r >= 7 && r <= 11;
const isLane = (r) => isRiver(r) || isRoad(r);
const LOG = 0, TURTLE = 1, CAR = 2, TRUCK = 3;
const LANE_KIND = [-1, LOG, TURTLE, LOG, TURTLE, LOG, -1, TRUCK, CAR, CAR, TRUCK, CAR, -1];
// Per kind: the length of one thing in cells (least, most), the gap after it
// in hundredths of a cell (least, most), and its speed in units a step.
const LANE_SHAPE = [
  [2, 4, 140, 270, 6, 11],     // logs
  [2, 3, 100, 210, 7, 11],     // turtles
  [1, 1, 240, 430, 10, 17],    // cars
  [2, 2, 300, 480, 7, 11],     // trucks
];
const MAX_P = 8;

const HOP_STEPS = 5;           // steps a hop is in the air
const REPEAT = 4;              // steps a frog sits before a held way hops it again
const FROG_R = 84;             // half a frog's width, in units, as traffic sees it
const PAD_CATCH = 144;         // how far off a pad's middle a hop up still finds it
const KNOCK_R = 168;           // how near a frog landed on must stand to be shoved
const STUN = 12;               // steps a shoved frog cannot hop
const BONK = 8;                // and one that hopped into the reeds
const KNOCK_KEEP = 2 * HZ;     // a shoved frog that comes to grief this soon pays the shover
const DEAD_STEPS = 27;
const HOME_STEPS = 24;         // steps a frog sits on its pad before it starts again
const WAVE_STEPS = 54;         // the pause once all five pads are taken
const WAVE_UP = 15, WAVE_MAX = 6;   // per cent faster every wave, up to this many waves
const DIVE_EVERY = 180, DIVE_WARN = 110, DIVE_FROM = 130, DIVE_TO = 170;
const PAD_POINTS = 3, FLY_POINTS = 2, SHOVE_POINTS = 1;
const FLY_GAP = 7 * HZ, FLY_STAY = 6 * HZ;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 120 * HZ;
const END_STEPS = 6 * HZ;
const LAST_CALL = 20 * HZ;     // the last of a round, when a pad pays double

const OUT = 0, IN = 1;         // watching, in the crossing
const SQUASH = 1, SPLASH = 2, WASH = 3;
const DIRS = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]];   // none, up, down, left, right

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   wv: the wave this round; wc: steps of the pause between waves; pads: who
//   sits on each pad, as a colour, -1 for nobody, 8 for somebody gone; fy, ft:
//   the pad the fly sits on, -1 for none, and steps until it moves; lr: how
//   often the lanes were laid; lo, lv, ls: per row, how far its traffic has
//   run, its speed, and each thing in it as [start, length, kind, dive]; res:
//   the last round's [id, points, pads, rounds won] rows; win: who took it,
//   -1 for a tie
function freshTable(seed) {
  const t = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, wv: 0, wc: 0, pads: [-1, -1, -1, -1, -1], fy: -1, ft: FLY_GAP,
    lr: 0, lo: new Array(ROWS).fill(0), lv: new Array(ROWS).fill(0), ls: [], p: {}, res: null, win: -1,
  };
  for (let r = 0; r < ROWS; r++) t.ls.push([]);
  layLanes(t);
  return t;
}

const FIELDS = ['c', 's', 'st', 'hd', 'q', 'qd', 'qh', 'x', 'r', 'ax', 'ar', 'tx', 'tr', 'ht', 'gt', 'cd', 'dd', 'dk',
  'hm', 'f', 'kb', 'kt', 'gn', 'pd', 'wn', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; st: watching or in the crossing; hd: the way held; q,
//   qd: the hop counter as last heard and the way of the last hop asked for;
//   qh: a hop asked for and not yet made; x, r: where the frog sits, x in
//   units; ax, ar, tx, tr: where a hop took off and where it lands; ht: steps
//   of the hop left, 0 sitting; gt: steps sat since the last landing; cd:
//   steps it cannot hop; dd, dk: steps it stays gone and what got it; hm:
//   steps it sits on a pad; f: the way it faces; kb, kt: who shoved it last
//   and for how much longer that counts; gn: points this round; pd: pads
//   taken; wn: rounds won; bw: the bot's pause; hs, hc: hands this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);
const inPlay = (w) => bySeat(w).filter((id) => w.p[id].st === IN);

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// Where a seat starts on the near bank: spread along it, so a crowd does not
// sit on one cell.
const spawnX = (s) => Math.floor(((2 * s + 1) * COLS) / (2 * MAX_P)) * U + U / 2;
const snap = (x) => clamp(Math.floor(x / U), 0, COLS - 1) * U + U / 2;
const padX = (i) => PADS[i] * U + U / 2;
function padAt(x) {
  for (let i = 0; i < PADS.length; i++) if (Math.abs(x - padX(i)) <= PAD_CATCH) return i;
  return -1;
}

function newPlayer(w, input) {
  const s = freeOf(w, 's');
  return player({
    c: freeOf(w, 'c'), s, st: OUT, hd: input[0], q: input[1], qd: input[2], qh: 0, x: spawnX(s), r: START_ROW,
    ax: spawnX(s), ar: START_ROW, tx: spawnX(s), tr: START_ROW, ht: 0, gt: 0, cd: 0, dd: 0, dk: 0, hm: 0, f: 1,
    kb: 0, kt: 0, gn: 0, pd: 0, wn: 0, bw: 0, hs: w.n, hc: 0,
  });
}

// ── the lanes ──────────────────────────────────────────────────────────────
// Every lane is laid afresh for each wave: its things, the gaps between them,
// which way it runs and how fast. A lane is never laid without a gap a frog
// fits in, and a river never without something to stand on.
function layLanes(w) {
  w.lr = (w.lr + 1) % 1000000;
  const flip = draw01(w) < 0.5 ? 1 : 0;
  const fast = 100 + WAVE_UP * Math.min(WAVE_MAX, w.wv);
  for (let r = 0; r < ROWS; r++) {
    const kind = LANE_KIND[r];
    w.ls[r] = [];
    w.lo[r] = 0;
    w.lv[r] = 0;
    if (kind < 0) continue;
    const [lo, hi, g0, g1, v0, v1] = LANE_SHAPE[kind];
    const dir = (r + flip) % 2 ? 1 : -1;
    w.lv[r] = dir * Math.floor((pick(w, v0, v1) * fast) / 100);
    w.lo[r] = pick(w, 0, LOOP - 1);
    let s = 0;
    for (;;) {
      const len = pick(w, lo, hi) * U - (kind >= CAR ? 30 : 16);
      const gap = Math.floor((pick(w, g0, g1) * U) / 100);
      if (w.ls[r].length && s + len + Math.floor((g0 * U) / 100) > LOOP) break;
      // Some turtles dive now and then, each group on its own beat.
      const dive = kind === TURTLE && draw01(w) < 0.5 ? pick(w, 0, DIVE_EVERY - 1) : -1;
      w.ls[r].push([s, len, kind, dive]);
      s += len + gap;
      if (s >= LOOP) break;
    }
  }
}

// Where a thing of a lane stands `dt` steps from now, along the lane's loop.
const thingAt = (w, r, sg, dt) => mod(sg[0] + w.lo[r] + w.lv[r] * dt, LOOP);
const dived = (sg, n) => sg[2] === TURTLE && sg[3] >= 0 && mod(n + sg[3], DIVE_EVERY) >= DIVE_FROM && mod(n + sg[3], DIVE_EVERY) < DIVE_TO;

// Whether a frog at x on a river row has something under it, `dt` steps from now.
function onFloat(w, r, x, dt) {
  const xl = x + MARGIN;
  for (const sg of w.ls[r]) {
    if (dived(sg, w.n + dt)) continue;
    if (mod(xl - thingAt(w, r, sg, dt), LOOP) < sg[1]) return true;
  }
  return false;
}

// Whether anything on a road row touches a frog at x, `dt` steps from now.
function runOver(w, r, x, dt) {
  const xl = x + MARGIN;
  for (const sg of w.ls[r]) if (mod(xl - thingAt(w, r, sg, dt) + FROG_R, LOOP) < sg[1] + 2 * FROG_R) return true;
  return false;
}

// ── the frogs ──────────────────────────────────────────────────────────────
// Whoever has the fewest points this round, while somebody has more, starts
// again from the middle bank, with the road behind them.
function trailing(w, id) {
  if (w.ph !== PLAY) return false;
  const ids = inPlay(w);
  let lo = BIG, hi = -1;
  for (const o of ids) { lo = Math.min(lo, w.p[o].gn); hi = Math.max(hi, w.p[o].gn); }
  return hi > lo && w.p[id].gn === lo;
}

function respawn(w, id, d) {
  d.r = trailing(w, id) ? MID_ROW : START_ROW;
  d.x = d.ax = d.tx = spawnX(d.s);
  d.ar = d.tr = d.r;
  d.ht = d.dd = d.dk = d.hm = d.qh = d.gt = d.kt = 0;
  d.cd = 4;
  d.f = 1;
}

function die(w, id, d, kind) {
  d.dd = DEAD_STEPS;
  d.dk = kind;
  d.ht = d.qh = 0;
  const by = d.kt > 0 && d.kb !== id ? w.p[d.kb] : null;
  if (by && (w.ph === PLAY || w.ph === WAIT)) {
    by.gn += SHOVE_POINTS;
    fx(w, 'shove', d.x, d.r, d.kb, SHOVE_POINTS);
  }
  d.kt = 0;
  fx(w, 'die', d.x, d.r, id, kind);
}

// A hop, if there is somewhere to land: the far bank only on a free pad, the
// edges of the crossing never, and never back off the near bank.
function hopTo(w, d, dir) {
  const [dx, dy] = DIRS[dir];
  const tr = d.r + dy;
  let tx = d.x + dx * U;
  if (tr < 0 || tr >= ROWS) return null;
  if (dx) {
    tx = clamp(tx, U / 2, FIELD - U / 2);
    if ((tx - d.x) * dx <= 0) return null;
  }
  if (tr === PAD_ROW) {
    const i = padAt(d.x);
    if (i < 0 || w.pads[i] !== -1) return -1;
    tx = padX(i);
  }
  return [tx, tr];
}

function hop(w, id, d, dir) {
  d.f = dir;
  const to = hopTo(w, d, dir);
  if (to === null) return;
  if (to === -1) {
    d.cd = BONK;
    fx(w, 'bonk', d.x, d.r, id);
    return;
  }
  d.ax = d.x;
  d.ar = d.r;
  d.tx = to[0];
  d.tr = to[1];
  d.ht = HOP_STEPS;
  d.gt = 0;
}

// A frog comes down. On the far bank it takes its pad, or bounces off one
// somebody took while it was in the air; anywhere else it shoves whoever sits
// where it lands, and then meets whatever is there.
function land(w, id, d) {
  d.r = d.tr;
  d.x = isRiver(d.r) ? d.tx : snap(d.tx);
  d.ht = 0;
  d.gt = 0;
  if (d.r === PAD_ROW) {
    const i = padAt(d.x);
    if (i >= 0 && w.pads[i] === -1) { takePad(w, id, d, i); return; }
    d.ax = d.tx = d.x;
    d.ar = PAD_ROW;
    d.tr = 1;
    d.ht = HOP_STEPS;
    d.cd = BONK;
    fx(w, 'bonk', d.x, d.r, id);
    return;
  }
  shove(w, id, d);
  meet(w, id, d);
}

function takePad(w, id, d, i) {
  w.pads[i] = d.c;
  let pts = 0;
  const fly = w.fy === i;
  if (w.ph === PLAY || w.ph === WAIT) {
    pts = PAD_POINTS * (w.ph === PLAY && w.pt <= LAST_CALL ? 2 : 1) + (fly ? FLY_POINTS : 0);
    d.gn += pts;
    d.pd += 1;
  }
  if (fly) { w.fy = -1; w.ft = FLY_GAP; }
  d.hm = HOME_STEPS;
  d.qh = d.kt = 0;
  fx(w, 'pad', padX(i), PAD_ROW, id, pts, [fly ? 1 : 0]);
  if (w.pads.every((v) => v !== -1)) {
    w.wc = WAVE_STEPS;
    fx(w, 'wave', 0, 0, 0, Math.min(WAVE_MAX, w.wv + 1) + 1);
  }
}

// Landing on a frog knocks it a cell the way the hop went, and it sits
// stunned a moment wherever that puts it — under a truck, in the water.
function shove(w, id, d) {
  if (d.r === START_ROW) return;
  const [dx, dy] = DIRS[d.f];
  for (const o of bySeat(w)) {
    const e = w.p[o];
    if (o === id || e.st !== IN || e.dd || e.hm || e.ht || e.r !== d.r || Math.abs(e.x - d.x) >= KNOCK_R) continue;
    let tr = e.r + dy;
    if (tr <= PAD_ROW || tr >= ROWS) tr = e.r;
    const tx = clamp(e.x + dx * U, U / 2, FIELD - U / 2);
    e.cd = STUN;
    e.qh = 0;
    e.kb = id;
    e.kt = KNOCK_KEEP;
    if (tr !== e.r || tx !== e.x) {
      e.ax = e.x;
      e.ar = e.r;
      e.tx = tx;
      e.tr = tr;
      e.ht = HOP_STEPS;
      e.gt = 0;
    }
    fx(w, 'bump', e.x, e.r, id, o);
  }
}

// What a sitting frog meets: the water, if nothing floats under it, and
// traffic on the road.
function meet(w, id, d) {
  if (isRiver(d.r)) {
    if (d.x < 0 || d.x >= FIELD) die(w, id, d, WASH);
    else if (!onFloat(w, d.r, d.x, 0)) die(w, id, d, SPLASH);
  } else if (isRoad(d.r) && runOver(w, d.r, d.x, 0)) die(w, id, d, SQUASH);
}

// One frog through one step: gone, home, in the air, or sitting — carried by
// whatever floats under it, and hopping if it is asked to.
function frogStep(w, id, d, moving) {
  if (d.kt > 0) d.kt -= 1;
  if (d.dd > 0) { d.qh = 0; if (--d.dd === 0) respawn(w, id, d); return; }
  if (d.hm > 0) { d.qh = 0; if (--d.hm === 0) respawn(w, id, d); return; }
  if (d.cd > 0) d.cd -= 1;
  if (d.ht > 0) { if (--d.ht === 0) land(w, id, d); return; }
  if (d.gt < 99) d.gt += 1;
  if (isRiver(d.r)) d.x += w.lv[d.r];
  meet(w, id, d);
  if (d.dd) return;
  if (!moving) { d.qh = 0; return; }
  if (d.cd > 0) return;
  let dir = 0;
  if (d.qh) { dir = d.qh; d.qh = 0; } else if (d.hd && d.gt >= REPEAT) dir = d.hd;
  if (dir) hop(w, id, d, dir);
}

// A hand, at its place in the room's order: [the way held, the hop counter,
// the way of the last hop asked for]. A hop is asked for by moving the counter;
// the same hand said again to keep a player at the table hops nothing. Being
// heard is how a player arrives: in the crossing while the table waits for a
// round, and watching while one is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input);
    if (w.ph === WAIT) d.st = IN;
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; how often a frog hops is the table's to say, not the
  // hand's — one asked for waits for the frog to sit.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.hd = input[0];
  if (input[1] !== d.q) { d.q = input[1]; d.qh = input[2]; }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [hd, q, qd] = raw;
  if (![hd, q, qd].every(Number.isInteger)) return null;
  if (hd < 0 || hd > 4 || q < 0 || q > 999 || qd < 1 || qd > 4) return null;
  return [hd, q, qd];
}

// Somebody gone from the room. A pad they sat on stays taken, in nobody's
// colour — a colour handed to whoever comes next must not inherit it.
function leave(w, id) {
  const d = w.p[id];
  if (!d) return;
  for (let i = 0; i < w.pads.length; i++) if (w.pads[i] === d.c) w.pads[i] = 8;
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.05;         // how often it stops to think a moment
const BOT_SLIP = 0.012;        // how often it hops on without looking
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    const d = (w.p[BOT_ID] = newPlayer(w, [0, 0, 1]));
    d.st = IN;
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Whether a frog at x on row r is still standing a while from `dt` steps on:
// carried along on the river, with nothing coming along the road.
function safeFrom(w, r, x, dt) {
  if (isRiver(r)) {
    const v = w.lv[r];
    for (const k of [0, 5, 10]) {
      const cx = x + v * k;
      if (cx < U / 3 || cx >= FIELD - U / 3 || !onFloat(w, r, cx, dt + k)) return false;
    }
    return true;
  }
  if (isRoad(r)) {
    for (let k = Math.max(0, dt - 1); k <= dt + 9; k++) if (runOver(w, r, x, k)) return false;
  }
  return true;
}

function canHop(w, d, dir) {
  const to = hopTo(w, d, dir);
  if (to === null || to === -1) return false;
  if (to[1] === PAD_ROW) return true;
  return safeFrom(w, to[1], isRiver(to[1]) ? to[0] : snap(to[0]), HOP_STEPS);
}

// Decided before the frog is carried this step, so it is decided for where
// the frog will be when it hops.
function botPick(w, sat) {
  const d = Object.assign({}, sat, { x: isRiver(sat.r) ? sat.x + w.lv[sat.r] : sat.x });
  // The nearest free pad, and on the river one the current is taking it
  // toward before one it would have to fight its way back to.
  const v = isRiver(d.r) ? w.lv[d.r] : 0;
  let goal = FIELD / 2, best = BIG;
  for (let i = 0; i < PADS.length; i++) {
    if (w.pads[i] !== -1) continue;
    const far = Math.abs(padX(i) - d.x) + ((padX(i) - d.x) * v < -PAD_CATCH * Math.abs(v) ? FIELD : 0);
    if (far < best) { best = far; goal = padX(i); }
  }
  if (draw01(w) < BOT_SLIP && hopTo(w, d, 1)) return 1;
  // A lane whose current runs toward the pad is ridden rather than left for
  // one running away from it; one running away is left, down if need be.
  const toward = (r) => w.lv[r] * (goal - d.x) > 0;
  const far = Math.abs(goal - d.x) > 2 * U;
  const way = goal < d.x - U / 2 ? 3 : goal > d.x + U / 2 ? 4 : 0;
  const safe = safeFrom(w, d.r, d.x, 0);
  if (canHop(w, d, 1) && !(far && safe && isRiver(d.r) && isRiver(d.r - 1) && toward(d.r) && !toward(d.r - 1))) return 1;
  if (isRiver(d.r) && !toward(d.r) && Math.abs(goal - d.x) > PAD_CATCH) {
    if (way && canHop(w, d, way)) return way;
    if ((!isRiver(d.r + 1) || toward(d.r + 1)) && canHop(w, d, 2)) return 2;
  }
  if (safe) {
    if (way && (d.r <= 1 || d.r === MID_ROW || draw01(w) < 0.3) && canHop(w, d, way)) return way;
    return 0;
  }
  for (const dir of [way || 3, way === 3 ? 4 : 3, 2]) if (canHop(w, d, dir)) return dir;
  return 0;
}

function botThink(w, id) {
  const d = w.p[id];
  if (!d || d.st !== IN || d.dd || d.hm || d.ht || d.cd) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 3 + Math.floor(draw01(w) * 10); return; }
  const dir = botPick(w, d);
  if (dir) d.qh = dir;
}

// ── a step ─────────────────────────────────────────────────────────────────
function freshWave(w) {
  w.pads = [-1, -1, -1, -1, -1];
  w.fy = -1;
  w.ft = FLY_GAP;
  w.wc = 0;
  layLanes(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d.st === IN) respawn(w, id, d);
  }
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  w.wv = 0;
  for (const id of bySeat(w)) {
    const d = w.p[id];
    d.st = IN;
    d.gn = d.pd = 0;
  }
  freshWave(w);
}

// A round: the seats closed up in order, a fresh crossing, everybody on the
// near bank.
function begin(w) {
  const ids = bySeat(w);
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.wv = 0;
  ids.forEach((id, i) => {
    const d = w.p[id];
    d.s = i;
    d.st = IN;
    d.gn = d.pd = 0;
  });
  freshWave(w);
  fx(w, 'round', 0, 0, 0);
}

// The round is over: most points takes it, and nobody does on a tie.
function finish(w) {
  const ids = inPlay(w);
  let top = -1;
  for (const id of ids) top = Math.max(top, w.p[id].gn);
  const best = ids.filter((id) => w.p[id].gn === top);
  w.win = best.length === 1 ? best[0] : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, w.p[id].gn, w.p[id].pd, w.p[id].wn]);
  res.sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, w.win);
}

// The fly sits on a free pad for a while and pays extra to whoever takes it.
function moveFly(w) {
  if (w.fy >= 0 && w.pads[w.fy] !== -1) { w.fy = -1; w.ft = FLY_GAP; }
  if (--w.ft > 0) return;
  if (w.fy >= 0) { w.fy = -1; w.ft = FLY_GAP; return; }
  const free = [];
  for (let i = 0; i < PADS.length; i++) if (w.pads[i] === -1) free.push(i);
  if (!free.length) { w.ft = HZ; return; }
  w.fy = free[Math.floor(draw01(w) * free.length)];
  w.ft = FLY_STAY;
  fx(w, 'fly', padX(w.fy), PAD_ROW, 0);
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
      if (w.pt === LAST_CALL) fx(w, 'last', 0, 0, 0);
    } else if (w.pt <= 0) { begin(w); return; }
  }
  // All five pads taken: everything holds still a moment, and the next wave
  // is laid, faster.
  if (w.wc > 0) {
    if (--w.wc === 0) {
      w.wv = Math.min(WAVE_MAX, w.wv + 1);
      freshWave(w);
    }
    return;
  }
  for (let r = 0; r < ROWS; r++) if (w.lv[r]) w.lo[r] = mod(w.lo[r] + w.lv[r], LOOP);
  const moving = w.ph === WAIT || w.ph === PLAY;
  if (moving) {
    moveFly(w);
    botThink(w, BOT_ID);
  }
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d && d.st === IN) frogStep(w, id, d, moving);
    if (w.wc > 0) break;
  }
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function lanesOf(raw) {
  for (const k of ['lo', 'lv', 'ls']) if (!Array.isArray(raw[k]) || raw[k].length !== ROWS) return null;
  const ls = [];
  for (let r = 0; r < ROWS; r++) {
    const row = raw.ls[r], kind = LANE_KIND[r];
    if (!int(raw.lo[r], 0, LOOP - 1) || !int(raw.lv[r], -60, 60) || !Array.isArray(row) || row.length > 24) return null;
    if (kind < 0 && (row.length || raw.lv[r] !== 0)) return null;
    const out = [];
    for (const sg of row) {
      if (!Array.isArray(sg) || sg.length !== 4 || !int(sg[0], 0, LOOP) || !int(sg[1], 1, 4 * U) || sg[2] !== kind) return null;
      if (!int(sg[3], -1, DIVE_EVERY - 1)) return null;
      out.push(sg.slice());
    }
    ls.push(out);
  }
  return ls;
}

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.wv, 0, WAVE_MAX) || !int(raw.wc, 0, WAVE_STEPS) || !int(raw.lr, 0, 999999)) return null;
  if (!Array.isArray(raw.pads) || raw.pads.length !== PADS.length || !raw.pads.every((v) => int(v, -1, MAX_P))) return null;
  if (!int(raw.fy, -1, PADS.length - 1) || !int(raw.ft, 0, Math.max(FLY_GAP, FLY_STAY))) return null;
  const ls = lanesOf(raw);
  if (!ls) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, OUT, IN) || inputOf([d.hd, d.q, d.qd]) === null || !int(d.qh, 0, 4)) return null;
    for (const k of ['x', 'ax', 'tx']) if (!int(d[k], -U, FIELD + U)) return null;
    for (const k of ['r', 'ar', 'tr']) if (!int(d[k], 0, ROWS - 1)) return null;
    if (!int(d.ht, 0, HOP_STEPS) || !int(d.gt, 0, 99) || !int(d.cd, 0, STUN) || !int(d.dd, 0, DEAD_STEPS)) return null;
    if (!int(d.dk, 0, WASH) || !int(d.hm, 0, HOME_STEPS) || !int(d.f, 0, 4)) return null;
    if (!int(d.kb, -BIG, BIG) || !int(d.kt, 0, KNOCK_KEEP)) return null;
    if (!int(d.gn, 0, 999999) || !int(d.pd, 0, 999999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bw, 0, 20) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
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
  if (!int(raw.win, -BIG, BIG)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, wv: raw.wv, wc: raw.wc, pads: raw.pads.slice(), fy: raw.fy, ft: raw.ft,
    lr: raw.lr, lo: raw.lo.slice(), lv: raw.lv.slice(), ls, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, list) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, list: list || null });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a crossing at dusk. Grass banks, a teal river with brown logs
// and green turtles, a slate road with pale traffic, and every frog in its
// seat's own bright colour — the only bright things on the board but the pads.
const INK = {
  page: '#0d1a21', glow: '#163039', text: '#ffffff', muted: '#cfe3df', dim: '#86a7a2', gold: '#ffd166',
  danger: '#ff5a6e', panel: 'rgba(10,22,28,0.93)', rim: '#3d6b64',
  grass: '#2e6a3e', grassHi: '#3a7e4b', tuft: '#4f9a5c', reed: '#1c4630', reedHi: '#26593b',
  water: '#0f4d5e', waterHi: '#17697b', ripple: 'rgba(170,235,240,0.18)',
  road: '#2a2e38', roadHi: '#333845', paint: 'rgba(255,238,190,0.45)', kerb: '#5f6676',
  pad: '#5cbf5a', padDark: '#2f7d3a', bloom: '#ff9ec7',
  log: '#8a5a33', logHi: '#a8703f', logDark: '#5a3920', shell: '#3f8f55', shellHi: '#5fb373', shellDark: '#28603a',
};
const SEAT = ['#ff4f7b', '#3fd3ff', '#ffd23f', '#9bff5a', '#c77dff', '#ff8a3d', '#f4f4ff', '#2effc8'];
const CAR_INK = ['#e8e1cf', '#9fb4c7', '#d9a066', '#c9c3b5', '#a9c7b8'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #2f5952;' +
  `background:#163039;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, TOP = 58, BOT = 26, dpx = 1;
let CP = 16, FX0 = 0, FY0 = 0, FWP = 240, FHP = 208, fieldBot = 400;
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

// The crossing keeps its own shape, as large as the frame lets it be. While
// the table waits for a round a strip under it holds the practice note, which
// would otherwise sit on the near bank, where every frog starts.
function fit(t) {
  const room = t.ph === WAIT ? NOTE_ROOM : 20;
  const ah = Math.max(60, VH - TOP - BOT - 4 - room);
  CP = Math.max(3, Math.min((VW - 16) / COLS, ah / ROWS));
  FWP = COLS * CP;
  FHP = ROWS * CP;
  FX0 = (VW - FWP) / 2;
  FY0 = TOP + (ah - FHP) / 2;
  fieldBot = FY0 + FHP;
}

// Cells to the screen: the left or top edge of a column or a row.
const SX = (x) => FX0 + x * CP + shakeX;
const SY = (y) => FY0 + y * CP + shakeY;
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
function oval(x, y, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
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
  hop() { if (ready('hop', 60)) { tone(420, 0.07, 'triangle', 0.06, 1.9); tone(900, 0.04, 'sine', 0.025, 1.2, 0.03); } },
  splash(me) {
    if (!ready('splash', 70)) return;
    puff(me ? 0.45 : 0.28, me ? 0.14 : 0.05, 900, 0, 0.7);
    tone(me ? 330 : 400, 0.25, 'sine', me ? 0.06 : 0.025, 0.4);
  },
  splat(me) {
    if (!ready('splat', 70)) return;
    puff(me ? 0.3 : 0.18, me ? 0.16 : 0.06, 240, 0, 0.8);
    tone(me ? 120 : 150, 0.22, 'square', me ? 0.06 : 0.02, 0.5);
  },
  pad(me, fly) {
    if (!ready('pad', 90)) return;
    const base = me ? 659 : 523;
    [1, 1.26, 1.5, fly ? 2 : 0].forEach((m, i) => { if (m) tone(base * m, 0.14, 'triangle', me ? 0.08 : 0.035, 0, i * 0.06); });
  },
  bump(me) { if (ready('bump', 60)) { tone(me ? 180 : 240, 0.18, 'sine', me ? 0.12 : 0.05, 2.4); puff(0.08, 0.04, 1500, 0, 1.5); } },
  bonk() { if (ready('bonk', 120)) { tone(140, 0.12, 'sine', 0.09, 0.6); puff(0.06, 0.04, 700, 0, 1.2); } },
  shove() { if (ready('shove', 120)) tone(1320, 0.1, 'triangle', 0.06, 1.15); },
  fly() { if (ready('fly', 400)) { tone(1800, 0.18, 'sawtooth', 0.012, 1.08); tone(1900, 0.18, 'sawtooth', 0.01, 0.95, 0.09); } },
  wave() { if (ready('wave', 500)) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.035, 0, i * 0.07)); },
  last() { if (ready('last', 500)) [784, 988, 784, 988].forEach((f, i) => tone(f, 0.12, 'triangle', 0.06, 0, i * 0.12)); },
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
// fast screen and a slow one see the same sparks. Positions are in cells.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, fall }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, life, max, colour, size }: a splash spreading
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, up, fall) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.25 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (up || 0), life: 0, max: 18 + Math.random() * 24, size, colour, fall: fall === undefined ? 0.35 : fall });
  }
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 15 }); }
function ring(x, y, colour, size, max) { rings.push({ x, y, colour, size, life: 0, max: max || 34 }); }
function moveBits(n) {
  for (let j = 0; j < n; j++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.93; b.vy = b.vy * 0.93 + b.fall;
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
const scoreBump = new Map();   // id -> a chip swelling for points just won
let banner = null;             // { s, sub, at }: a word across the crossing for a moment

function play(e, t) {
  const me = myId();
  const x = e.x / U, y = e.y + 0.5;
  if (e.kind === 'die') {
    const c = colourOf(t, e.a), mine = e.a === me;
    if (e.b === SQUASH) {
      spray(x, y, 18, c, 16, 2.2, 2);
      spray(x, y, 6, '#ffffff', 12, 1.6, 2);
      pop(x, y - 0.2, 'splat!', c, mine ? 18 : 14);
      sound.splat(mine);
    } else {
      spray(x, y, 16, '#bdf3f7', 13, 1.8, 7, 0.55);
      ring(x, y, '#d8fbff', 0.9);
      ring(x, y, '#d8fbff', 0.5, 44);
      pop(x, y - 0.2, e.b === WASH ? 'washed away' : 'splash!', '#bdf3f7', mine ? 18 : 14);
      sound.splash(mine);
    }
    if (mine) shake = Math.max(shake, 9);
  } else if (e.kind === 'pad') {
    const c = colourOf(t, e.a), fly = e.list && e.list[0];
    spray(x, y, 22, INK.gold, 15, 2, 5);
    spray(x, y, 10, c, 12, 2.2, 4);
    ring(x, y, INK.gold, 0.8);
    if (e.b) pop(x, y + 0.4, (fly ? 'fly! ' : '') + '+' + e.b, c, e.a === me ? 20 : 16);
    scoreBump.set(e.a, 1);
    if (e.a === me) shake = Math.max(shake, 3);
    sound.pad(e.a === me, fly);
  } else if (e.kind === 'bump') {
    spray(x, y, 10, '#ffffff', 14, 1.8, 3);
    ring(x, y, '#ffffff', 0.55, 20);
    pop(x, y - 0.3, 'shove!', colourOf(t, e.a), e.a === me || e.b === me ? 16 : 13);
    if (e.b === me) shake = Math.max(shake, 7);
    sound.bump(e.a === me || e.b === me);
  } else if (e.kind === 'shove') {
    pop(x, y - 0.9, '+' + e.b, colourOf(t, e.a), e.a === me ? 18 : 14);
    scoreBump.set(e.a, 1);
    if (e.a === me) sound.shove();
  } else if (e.kind === 'bonk') {
    spray(x, y - 0.4, 5, INK.reedHi, 8, 1.6, 2);
    if (e.a === me) { pop(x, y - 0.4, 'bonk', INK.muted, 13); sound.bonk(); }
  } else if (e.kind === 'fly') {
    spray(x, y, 6, INK.gold, 6, 1.4, 1, 0.05);
    sound.fly();
  } else if (e.kind === 'wave') {
    banner = { s: 'wave ' + e.b + '!', sub: 'every pad taken · the next wave runs faster', at: performance.now() };
    shake = Math.max(shake, 5);
    sound.wave();
  } else if (e.kind === 'last') {
    banner = { s: 'last call', sub: 'a pad pays double now', at: performance.now() };
    sound.last();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
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

// The rows of the crossing, from the far bank down: reeds round the pads, the
// river with its ripples, the middle bank, the road with its markings, and the
// near bank. Only the ripples move by the clock, and they are drawing alone.
function drawRows(t, now) {
  const x0 = FX0 + shakeX, y0 = FY0 + shakeY;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(x0 - 7, y0 - 5, FWP + 14, FHP + 16, 10);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, FWP, FHP, 6);
  ctx.clip();
  for (let r = 0; r < ROWS; r++) {
    const y = y0 + r * CP;
    if (r === PAD_ROW) {
      ctx.fillStyle = INK.reed;
      ctx.fillRect(x0, y, FWP, CP);
      ctx.fillStyle = INK.reedHi;
      for (let c = 0; c < COLS; c++) {
        if (PADS.includes(c)) continue;
        for (let k = 0; k < 3; k++) {
          const bx = x0 + (c + 0.2 + k * 0.3) * CP;
          ctx.fillRect(bx, y + CP * (0.15 + 0.1 * ((c + k) % 3)), Math.max(1, CP * 0.08), CP * 0.8);
        }
      }
      for (const c of PADS) {
        ctx.fillStyle = INK.water;
        roundRect(x0 + (c - 0.1) * CP, y + CP * 0.05, CP * 1.2, CP * 1.1, CP * 0.3);
        ctx.fill();
      }
    } else if (isRiver(r)) {
      const g = ctx.createLinearGradient(0, y, 0, y + CP);
      g.addColorStop(0, INK.waterHi);
      g.addColorStop(1, INK.water);
      ctx.fillStyle = g;
      ctx.fillRect(x0, y, FWP, CP + 1);
      ctx.strokeStyle = INK.ripple;
      ctx.lineWidth = Math.max(1, CP * 0.05);
      const drift = ((now / 1000) * (t.lv[r] >= 0 ? 0.3 : -0.3)) % 3;
      ctx.beginPath();
      for (let c = -3; c < COLS + 3; c += 3) {
        const rx = x0 + (c + drift + (r % 2) * 1.5) * CP, ry = y + CP * (0.3 + 0.4 * ((c + r) % 2 ? 1 : 0));
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx + CP * 0.8, ry);
      }
      ctx.stroke();
    } else if (isRoad(r)) {
      ctx.fillStyle = r % 2 ? INK.road : INK.roadHi;
      ctx.fillRect(x0, y, FWP, CP + 1);
      if (r > 7) {
        ctx.strokeStyle = INK.paint;
        ctx.lineWidth = Math.max(1, CP * 0.06);
        ctx.setLineDash([CP * 0.5, CP * 0.5]);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + FWP, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      ctx.fillStyle = r === MID_ROW ? INK.grassHi : INK.grass;
      ctx.fillRect(x0, y, FWP, CP + 1);
      ctx.fillStyle = INK.tuft;
      for (let c = 0; c < COLS; c++) {
        const k = (c * 7 + r * 3) % 5;
        if (k > 1) continue;
        const tx = x0 + (c + 0.3 + k * 0.3) * CP, ty = y + CP * (0.35 + k * 0.25);
        ctx.fillRect(tx, ty, Math.max(1, CP * 0.07), CP * 0.18);
        ctx.fillRect(tx + CP * 0.12, ty - CP * 0.05, Math.max(1, CP * 0.07), CP * 0.22);
      }
    }
  }
  // The kerbs where the road meets the banks.
  ctx.fillStyle = INK.kerb;
  ctx.fillRect(x0, y0 + 7 * CP - Math.max(1, CP * 0.06), FWP, Math.max(1.5, CP * 0.1));
  ctx.fillRect(x0, y0 + 12 * CP - Math.max(1, CP * 0.04), FWP, Math.max(1.5, CP * 0.1));
  ctx.restore();
  ctx.strokeStyle = INK.rim;
  ctx.lineWidth = 2;
  roundRect(x0 - 2, y0 - 2, FWP + 4, FHP + 4, 7);
  ctx.stroke();
}

// The lily pads: a leaf with a notch and a bloom, a sitting frog in its
// colour once taken, and the fly when it is there.
function drawPads(t, now) {
  for (let i = 0; i < PADS.length; i++) {
    const cx = SX(PADS[i] + 0.5), cy = SY(0.55), r = CP * 0.44;
    ctx.fillStyle = INK.padDark;
    disc(cx, cy + CP * 0.04, r);
    ctx.fill();
    ctx.fillStyle = INK.pad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2 + 0.35, -Math.PI / 2 - 0.35 + Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    const v = t.pads[i];
    if (v >= 0) {
      frogShape(cx, cy, CP * 0.78, v < MAX_P ? SEAT[v] : '#8a9a98', 1, 0, false, 1, now);
    } else {
      ctx.fillStyle = INK.bloom;
      disc(cx + r * 0.45, cy + r * 0.3, Math.max(1, CP * 0.08));
      ctx.fill();
    }
    if (t.fy === i && v < 0) {
      const bob = Math.sin(now / 120) * CP * 0.06;
      ctx.fillStyle = alpha(INK.gold, 0.25 + 0.15 * Math.sin(now / 200));
      disc(cx, cy - CP * 0.05 + bob, CP * 0.32);
      ctx.fill();
      ctx.fillStyle = 'rgba(230,250,255,0.75)';
      const flap = 0.5 + 0.5 * Math.sin(now / 25);
      oval(cx - CP * 0.1, cy - CP * 0.14 + bob, CP * 0.1, CP * (0.04 + 0.05 * flap));
      ctx.fill();
      oval(cx + CP * 0.1, cy - CP * 0.14 + bob, CP * 0.1, CP * (0.04 + 0.05 * flap));
      ctx.fill();
      ctx.fillStyle = '#141414';
      oval(cx, cy - CP * 0.05 + bob, CP * 0.08, CP * 0.06);
      ctx.fill();
    }
  }
}

// How far a lane's traffic has run as drawn, between two tables, the short
// way round its loop.
function laneRun(from, to, k, r) {
  if (!from || from.lr !== to.lr) return to.lo[r];
  let dlt = to.lo[r] - from.lo[r];
  if (dlt > LOOP / 2) dlt -= LOOP;
  else if (dlt < -LOOP / 2) dlt += LOOP;
  return from.lo[r] + dlt * k;
}
const shortWay = (d) => (d > LOOP / 2 ? d - LOOP : d < -LOOP / 2 ? d + LOOP : d);

function drawLanes(b, now) {
  const t = b.to;
  ctx.save();
  roundRect(FX0 + shakeX, FY0 + shakeY, FWP, FHP, 6);
  ctx.clip();
  for (let r = 0; r < ROWS; r++) {
    if (!isLane(r)) continue;
    const run = laneRun(b.from, t, b.k, r), dir = t.lv[r] >= 0 ? 1 : -1;
    for (const sg of t.ls[r]) {
      const p = mod(sg[0] + run, LOOP) - MARGIN;
      for (const q of [p, p - LOOP]) {
        if (q >= FIELD || q + sg[1] <= 0) continue;
        thing(sg, q / U, r, sg[1] / U, dir, t.n, now);
      }
    }
  }
  ctx.restore();
}

// One thing in a lane, `x` and `len` in cells.
function thing(sg, x, r, len, dir, n, now) {
  const px = SX(x), py = SY(r), w = len * CP;
  const kind = sg[2];
  if (kind === LOG) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    roundRect(px + 1, py + CP * 0.2, w, CP * 0.7, CP * 0.3);
    ctx.fill();
    ctx.fillStyle = INK.log;
    roundRect(px, py + CP * 0.12, w, CP * 0.72, CP * 0.32);
    ctx.fill();
    ctx.fillStyle = INK.logHi;
    roundRect(px + CP * 0.2, py + CP * 0.18, w - CP * 0.4, CP * 0.14, CP * 0.07);
    ctx.fill();
    ctx.strokeStyle = INK.logDark;
    ctx.lineWidth = Math.max(1, CP * 0.05);
    ctx.beginPath();
    for (let k = 1; k < len; k++) {
      const lx = px + k * CP + ((k * 37) % 7 - 3) * CP * 0.04;
      ctx.moveTo(lx, py + CP * 0.42);
      ctx.lineTo(lx + CP * 0.35, py + CP * 0.42);
    }
    ctx.stroke();
    ctx.fillStyle = INK.logDark;
    oval(dir > 0 ? px + w - CP * 0.18 : px + CP * 0.18, py + CP * 0.48, CP * 0.12, CP * 0.28);
    ctx.fill();
  } else if (kind === TURTLE) {
    const ph = sg[3] >= 0 ? mod(n + sg[3], DIVE_EVERY) : 0;
    const under = sg[3] >= 0 && ph >= DIVE_FROM && ph < DIVE_TO;
    const warn = sg[3] >= 0 && ph >= DIVE_WARN && ph < DIVE_FROM;
    const a = under ? 0.22 : warn && Math.floor(now / 110) % 2 ? 0.55 : 1;
    const cells = Math.round(len);
    for (let k = 0; k < cells; k++) {
      const cx = px + (k + 0.5) * (w / cells), cy = py + CP * 0.5;
      ctx.globalAlpha = a;
      if (under) {
        ctx.strokeStyle = '#bdf3f7';
        ctx.lineWidth = 1;
        oval(cx, cy, CP * 0.34, CP * 0.2);
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = INK.shellDark;
      oval(cx + dir * CP * 0.36, cy, CP * 0.1, CP * 0.09);
      ctx.fill();
      for (const [lx, ly] of [[-0.22, -0.28], [0.22, -0.28], [-0.22, 0.28], [0.22, 0.28]]) {
        oval(cx + lx * CP, cy + ly * CP, CP * 0.08, CP * 0.06);
        ctx.fill();
      }
      ctx.fillStyle = INK.shell;
      oval(cx, cy, CP * 0.33, CP * 0.29);
      ctx.fill();
      ctx.fillStyle = INK.shellHi;
      oval(cx - CP * 0.05, cy - CP * 0.06, CP * 0.16, CP * 0.12);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    const hue = CAR_INK[(sg[0] >> 4) % CAR_INK.length];
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    roundRect(px + 2, py + CP * 0.2, w, CP * 0.7, CP * 0.18);
    ctx.fill();
    if (kind === TRUCK) {
      const cab = CP * 0.62, front = dir > 0 ? px + w - cab : px;
      ctx.fillStyle = '#5d6878';
      roundRect(dir > 0 ? px : px + cab + CP * 0.06, py + CP * 0.12, w - cab - CP * 0.06, CP * 0.74, CP * 0.1);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(dir > 0 ? px + CP * 0.1 : px + cab + CP * 0.16, py + CP * 0.2, w - cab - CP * 0.26, CP * 0.1);
      ctx.fillStyle = hue;
      roundRect(front, py + CP * 0.16, cab, CP * 0.66, CP * 0.16);
      ctx.fill();
      ctx.fillStyle = '#20252e';
      ctx.fillRect(dir > 0 ? front + cab * 0.55 : front + cab * 0.15, py + CP * 0.24, cab * 0.3, CP * 0.5);
    } else {
      ctx.fillStyle = hue;
      roundRect(px, py + CP * 0.16, w, CP * 0.66, CP * 0.24);
      ctx.fill();
      ctx.fillStyle = '#20252e';
      roundRect(px + w * 0.3, py + CP * 0.26, w * 0.4, CP * 0.46, CP * 0.1);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(px + w * 0.15, py + CP * 0.22, w * 0.7, Math.max(1, CP * 0.06));
    }
    const hx = dir > 0 ? px + w - CP * 0.06 : px + CP * 0.06;
    ctx.fillStyle = '#fff3b0';
    disc(hx, py + CP * 0.3, Math.max(1, CP * 0.07));
    ctx.fill();
    disc(hx, py + CP * 0.68, Math.max(1, CP * 0.07));
    ctx.fill();
    const beam = ctx.createLinearGradient(hx, 0, hx + dir * CP * 0.9, 0);
    beam.addColorStop(0, 'rgba(255,243,176,0.28)');
    beam.addColorStop(1, 'rgba(255,243,176,0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(hx, py + CP * 0.22);
    ctx.lineTo(hx + dir * CP * 0.9, py + CP * 0.02);
    ctx.lineTo(hx + dir * CP * 0.9, py + CP * 0.98);
    ctx.lineTo(hx, py + CP * 0.76);
    ctx.closePath();
    ctx.fill();
  }
}

// A frog: a round body in its colour, four legs, two big eyes on top, turned
// the way it faces. `air` is how far through a hop it is, 0 to 1: it rises,
// stretches, and its shadow stays on the ground.
const FACE = [0, 0, Math.PI, -Math.PI / 2, Math.PI / 2];
function frogShape(cx, cy, s, colour, facing, air, me, a, now) {
  const lift = Math.sin(Math.PI * air) * s * 0.35;
  const stretch = air > 0 ? 1 + 0.18 * Math.sin(Math.PI * air) : 1;
  ctx.globalAlpha = a === undefined ? 1 : a;
  if (air > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    oval(cx, cy + s * 0.12, s * 0.3 * (1 - air * 0.2 * Math.sin(Math.PI * air)), s * 0.14);
    ctx.fill();
  }
  ctx.save();
  ctx.translate(cx, cy - lift);
  ctx.rotate(FACE[facing] || 0);
  ctx.scale(1 / Math.sqrt(stretch), stretch);
  const dark = darker(colour, 0.42);
  ctx.fillStyle = dark;
  const leg = air > 0 ? 0.42 : 0.32;
  for (const [lx, ly, rx, ry] of [[-0.3, -0.18, 0.1, 0.08], [0.3, -0.18, 0.1, 0.08], [-0.3, leg, 0.13, 0.1], [0.3, leg, 0.13, 0.1]]) {
    oval(lx * s, ly * s, rx * s, ry * s);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(8,16,20,0.75)';
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.fillStyle = colour;
  oval(0, s * 0.04, s * 0.27, s * 0.31);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  oval(-s * 0.07, -s * 0.04, s * 0.09, s * 0.12);
  ctx.fill();
  for (const ex of [-0.14, 0.14]) {
    ctx.fillStyle = colour;
    disc(ex * s, -s * 0.22, s * 0.11);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    disc(ex * s, -s * 0.23, s * 0.075);
    ctx.fill();
    ctx.fillStyle = '#111';
    disc(ex * s, -s * 0.26, s * 0.038);
    ctx.fill();
  }
  ctx.restore();
  if (me) {
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 + 0.3 * Math.sin(now / 160)) + ')';
    ctx.lineWidth = 1.5;
    disc(cx, cy - lift + s * 0.02, s * 0.46);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Where a frog stands in one table, in cells: sitting, in the air between its
// take-off and its landing, gone, or home on a pad.
function posOf(d) {
  if (d.dd > 0) return { x: d.x / U, y: d.r, air: 0, gone: d.dd, home: false };
  if (d.hm > 0) return { x: d.x / U, y: d.r, air: 0, gone: 0, home: true };
  if (d.ht > 0) {
    const k = (HOP_STEPS - d.ht) / HOP_STEPS;
    return { x: lerp(d.ax, d.tx, k) / U, y: lerp(d.ar, d.tr, k), air: k, gone: 0, home: false };
  }
  return { x: d.x / U, y: d.r, air: 0, gone: 0, home: false };
}

// A frog as drawn: between two tables, and never slid across a jump — gone,
// home, or put somewhere new.
function frogAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z || z.st !== IN) return null;
  const pz = posOf(z);
  const pa = a && a.st === IN ? posOf(a) : null;
  if (!pa || !pa.gone !== !pz.gone || pa.home !== pz.home || Math.abs(pa.x - pz.x) + Math.abs(pa.y - pz.y) > 2.5) {
    return Object.assign(pz, { d: z });
  }
  const za = pz.air === 0 && pa.air > 0 ? 1 : pz.air;
  return { x: lerp(pa.x, pz.x, b.k), y: lerp(pa.y, pz.y, b.k), air: lerp(pa.air, za, b.k) % 1, gone: pz.gone, home: pz.home, d: z };
}

// What is left of a frog for a moment: a flat splat on the road, rings in
// the water.
function drawGone(f, colour, now) {
  const k = f.gone / DEAD_STEPS;
  const cx = SX(f.x), cy = SY(f.y + 0.5);
  if (f.d.dk === SQUASH) {
    ctx.globalAlpha = Math.min(1, k * 1.5);
    ctx.fillStyle = darker(colour, 0.25);
    oval(cx, cy, CP * 0.42, CP * 0.2);
    ctx.fill();
    for (const [lx, ly] of [[-0.42, -0.2], [0.42, -0.2], [-0.4, 0.22], [0.4, 0.22]]) {
      oval(cx + lx * CP, cy + ly * CP, CP * 0.1, CP * 0.06);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = 'rgba(216,251,255,' + 0.6 * k + ')';
    ctx.lineWidth = 1.5;
    oval(cx, cy, CP * (0.5 - 0.3 * k), CP * (0.25 - 0.15 * k));
    ctx.stroke();
  }
}

function drawFrogs(list, now) {
  list.sort((a, b) => a.f.y - b.f.y);
  for (const { id, f, me, colour } of list) {
    if (f.home) continue;
    if (f.gone) { drawGone(f, colour, now); continue; }
    const stunned = f.d.cd > 0 && f.d.ht === 0 && f.d.cd > 4;
    const cx = SX(f.x), cy = SY(f.y + 0.5) + (stunned ? Math.sin(now / 40) * CP * 0.03 : 0);
    frogShape(cx, cy, CP * 0.9, colour, f.d.f || 1, f.air, me, 1, now);
    if (stunned) {
      ctx.fillStyle = INK.gold;
      for (let k = 0; k < 3; k++) {
        const a = now / 180 + (k * Math.PI * 2) / 3;
        disc(cx + Math.cos(a) * CP * 0.3, cy - CP * 0.42 + Math.sin(a) * CP * 0.08, Math.max(1, CP * 0.05));
        ctx.fill();
      }
    }
    if (!me && CP >= 12) {
      const px = Math.max(10, Math.min(12, CP * 0.5));
      ctx.font = font(px);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(8,16,20,0.85)';
      const lx = cx, ly = cy - CP * 0.55 - Math.sin(Math.PI * f.air) * CP * 0.3;
      ctx.strokeText(nickOf(id), lx, ly);
      ctx.fillStyle = colour;
      ctx.fillText(nickOf(id), lx, ly);
    }
  }
}

function drawBits() {
  flat();
  for (const g of rings) {
    const f = g.life / g.max;
    ctx.globalAlpha = (1 - f) * 0.8;
    ctx.strokeStyle = g.colour;
    ctx.lineWidth = 2;
    oval(SX(g.x), SY(g.y), CP * g.size * (0.3 + ease(f)), CP * g.size * 0.5 * (0.3 + ease(f)));
    ctx.stroke();
  }
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    const s = b.size * (1 - f * 0.5) * Math.max(0.7, CP / 22);
    ctx.fillRect(SX(b.x) - s, SY(b.y) - s, 2 * s, 2 * s);
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const f = p.life / p.max;
    const rise = 10 + ease(f) * 26;
    const scale = f < 0.15 ? 0.6 + (f / 0.15) * 0.5 : 1.1 - Math.min(0.1, f - 0.15);
    ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
    ctx.font = font(p.px * scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(8,16,20,0.85)';
    const X = Math.max(50, Math.min(VW - 50, SX(p.x))), Y = Math.max(TOP + 10, SY(p.y) - rise);
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
  // The status line: the phase, the wave, and the time left.
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice · wave ' + (t.wv + 1);
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · wave ' + (t.wv + 1) + ' · ' + clock(t.pt) + ' left';
    if (t.pt <= LAST_CALL) {
      status += ' · pads x2';
      colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
    }
  } else status = 'round ' + t.rd + ' · over';
  text('leapfrog', 12, 22, titlePx, SEAT[3], 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('leapfrog').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points; whoever
  // trails and starts from the middle bank has an arrow by their name.
  const ids = inPlay(t);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(140, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      const bump = scoreBump.get(id) || 0;
      if (bump) scoreBump.set(id, bump < 0.03 ? 0 : bump * (1 - per60(0.08)));
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13 - bump * 2, cw, 22 + bump * 4, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = c;
      disc(x + 11, y - 2, 5);
      ctx.fill();
      if (trailing(t, id)) {
        ctx.fillStyle = INK.gold;
        ctx.beginPath();
        ctx.moveTo(x + 11, y - 6);
        ctx.lineTo(x + 15, y);
        ctx.lineTo(x + 7, y);
        ctx.closePath();
        ctx.fill();
      }
      const score = String(d.gn);
      ctx.font = font(12 + bump * 3);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 8, y + 3, 12 + bump * 3, INK.gold, 'right');
      if (cw > 46) fitText(mine ? 'you' : nickOf(id), x + 22, y + 3, 12, mine ? INK.text : INK.muted, cw - 32 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'swipe to hop · tap hops forward · land on a rival to shove them'
    : 'arrows/WASD hop · click hops toward the pointer · land on a rival to shove them · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// Under the crossing while a round is on: what you are doing in it.
function drawMine(t) {
  if (t.ph !== PLAY) return;
  flat();
  const d = t.p[myId()];
  const y = fieldBot + 15;
  let line, c = INK.dim;
  if (!d || d.st !== IN) line = 'watching · you play from the next round';
  else if (trailing(t, myId())) { line = 'you trail · you start again from the middle bank'; c = INK.gold; }
  else line = 'a pad pays +' + PAD_POINTS + ' · the fly +' + FLY_POINTS + ' · a shove into trouble +' + SHOVE_POINTS;
  fitText(line, VW / 2, y, 11, c, VW - 24);
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
  if (banner && now - banner.at < 1800 && t.ph !== END) {
    const k = (now - banner.at) / 1800;
    ctx.globalAlpha = k < 0.1 ? k / 0.1 : k > 0.8 ? (1 - k) / 0.2 : 1;
    const w = Math.min(VW - 32, 340);
    panel(cx, mid, w, 62);
    fitText(banner.s, cx, mid + 2, 24, INK.gold, w - 24);
    fitText(banner.sub, cx, mid + 21, 12, INK.muted, w - 24);
    ctx.globalAlpha = 1;
  }
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'ride the logs to a lily pad · land on a rival to shove them';
    practiceNote(now, VW, head, tip, [[fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(8,16,20,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big * 0.3);
    text(String(n), cx, mid + big * 0.3, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    const w = Math.min(VW - 32, 360);
    panel(cx, mid + big * 1.7, w, 46);
    fitText('cross to a lily pad · each one holds a single frog', cx, mid + big * 1.7 - 4, 13, INK.text, w - 20);
    fitText('land on a rival to shove them · trailing starts mid-way', cx, mid + big * 1.7 + 14, 12, INK.gold, w - 20);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(8,16,20,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('hop!', cx, mid + big * 0.5);
    text('hop!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head, hc = INK.text;
    if (t.win !== -1) {
      head = t.win === me ? 'you take the round!' : nickOf(t.win) + ' takes the round';
      hc = colourOf(t, t.win);
    } else head = 'a tie at the top';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, hc, w - 24);
    text('pads', cx + w / 2 - 70, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, gn, pd, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 170, 'left');
      text(String(pd), cx + w / 2 - 70, y, 14, INK.text, 'right');
      text(String(gn), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Your own frog is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a hop a step away from where
// the guess had it. So the frog drawn is pulled toward the guess a little every
// frame rather than put on it, and one put somewhere new is put there at once.
// On the river it is drawn where it sits on its log as the log is drawn: the
// guess runs the river a trip further on than the agreed table does, and a
// frog drawn from one on a log drawn from the other would hover off its end.
const PULL = 0.55;
let shown = null;        // [x, y] in cells: where your frog is drawn
let myScreen = null;     // where your frog is on the screen, for the mouse to aim from

function settle(f) {
  if (!shown || f.gone || f.home || Math.abs(f.x - shown[0]) + Math.abs(f.y - shown[1]) > 1.6) {
    shown = [f.x, f.y];
    return f;
  }
  const k = per60(PULL);
  shown[0] += (f.x - shown[0]) * k;
  shown[1] += (f.y - shown[1]) * k;
  return Object.assign({}, f, { x: shown[0], y: shown[1] });
}

function draw(now) {
  const b = agreedAt(now);
  drawGround();
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the crossing…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  fit(t);
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a table this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  flat();
  drawRows(t, now);
  drawPads(t, now);
  drawLanes(b, now);
  const me = myId();
  const list = [];
  for (const id of inPlay(t)) {
    if (id === me) continue;
    const f = frogAt(b, id);
    if (f) list.push({ id, f, me: false, colour: colourOf(t, id) });
  }
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : b;
  let f = t.p[me] && t.p[me].st === IN ? frogAt(own, me) : null;
  if (f) {
    const r = Math.round(f.y);
    if (own !== b && f.air === 0 && !f.gone && isRiver(r) && own.to.lr === t.lr) {
      const ahead = shortWay(laneRun(own.from, own.to, own.k, r) - laneRun(b.from, t, b.k, r));
      f.x -= ahead / U;
    }
    f = settle(f);
    myScreen = [SX(f.x), SY(f.y + 0.5)];
    list.push({ id: me, f, me: true, colour: colourOf(t, me) });
  } else {
    shown = null;
    myScreen = null;
  }
  drawFrogs(list, now);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way a key holds the frog, a counter of hops asked
// for, and the way of the last one. A hop asked for is made the moment the
// frog sits, once; a way held hops it again every time it has sat a moment.
let hops = 0, lastWay = 1;
const held = [];         // the ways of the keys down, the newest last
const KEY_WAY = { ArrowUp: 1, KeyW: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3, ArrowRight: 4, KeyD: 4 };

function sayHand() {
  setHand([held.length ? held[held.length - 1] : 0, hops, lastWay]);
}

const sitting = () => {
  const d = world && world.p[myId()];
  return !!d && d.st === IN && !d.dd && !d.hm && (world.ph === WAIT || world.ph === PLAY);
};

function hopWay(way) {
  wake();
  hops = (hops + 1) % 1000;
  lastWay = way;
  sayHand();
  if (sitting()) sound.hop();
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  const way = KEY_WAY[e.code];
  if (!way) return;
  e.preventDefault();
  coarse = false;
  if (e.repeat) return;
  const i = held.indexOf(way);
  if (i >= 0) held.splice(i, 1);
  held.push(way);
  hopWay(way);
});
addEventListener('keyup', (e) => {
  const way = KEY_WAY[e.code];
  if (!way) return;
  // Another key for the same way may still be down.
  const still = Object.keys(KEY_WAY).some((k) => k !== e.code && KEY_WAY[k] === way && keysDown.has(k));
  if (!still) {
    const i = held.indexOf(way);
    if (i >= 0) held.splice(i, 1);
  }
  sayHand();
});
const keysDown = new Set();
addEventListener('keydown', (e) => { keysDown.add(e.code); }, true);
addEventListener('keyup', (e) => { keysDown.delete(e.code); }, true);
addEventListener('blur', () => {
  held.length = 0;
  keysDown.clear();
  drag = null;
  sayHand();
});

// A thumb: a swipe hops the way it goes, a hop for every so many pixels it
// travels, and a tap hops forward — drags and taps, because iOS keeps a long
// press inside a frame for itself. A mouse: a click hops toward the pointer,
// the way it is furthest from the frog.
let drag = null;         // { id, ox, oy, at, moved }
const swipePx = () => Math.max(18, Math.min(40, CP * 0.7));

function wayTo(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 4 : 3;
  return dy > 0 ? 2 : 1;
}

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  if (e.pointerType === 'touch' || e.pointerType === 'pen') {
    coarse = true;
    drag = { id: e.pointerId, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
    return;
  }
  coarse = false;
  const r = cv.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  if (!myScreen || Math.abs(px - myScreen[0]) + Math.abs(py - myScreen[1]) < CP * 0.35) hopWay(1);
  else hopWay(wayTo(px - myScreen[0], py - myScreen[1]));
});
cv.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.ox, dy = e.clientY - drag.oy;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < swipePx()) return;
  drag.moved = true;
  drag.ox = e.clientX;
  drag.oy = e.clientY;
  hopWay(wayTo(dx, dy));
});
function liftPointer(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const tap = !drag.moved && performance.now() - drag.at < 300;
  drag = null;
  if (tap) hopWay(1);
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) drag = null; });
addEventListener('pointerup', liftPointer);

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

// Called by the kernel once it stands. Sitting still is a hand too: it is how
// a player arrives on the near bank.
function start() {
  sayHand();
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
