/**
 * @disk     jetcab
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Flying taxis in a canyon at night. Thrust against gravity, set down softly beside a fare and fly them to the pad they ask for. Ram a rival to knock their fare out on a parachute and catch it yourself. Land too hard and you wreck.
 * @tags     game, party, realtime, physics, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/jetcab.png
 */
// jetcab.js — a canyon of flying cabs where the room's order is the referee.
//
// Every copy holds every cab, where it flies, how fast, how much fuel it has
// and whom it carries, every fare waiting on a ledge or drifting down under a
// parachute, and the rock itself, and changes it only on what comes back round
// the room, so every copy applies the same hands in the same order and holds
// the same canyon. Nobody sends where they are, whom they picked up, whom they
// rammed or what they were paid: a hand is which jets burn, the one under the
// cab and the two at its sides, and everything else is the same arithmetic on
// the same whole numbers on every machine. A page with a console open can fly
// its own cab however it likes, with the jets every cab has and no harder.
//
// While a player is alone, a bot flies with them. It is part of the table like
// any player, and its flying is a function of the table alone, so it flies the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own cab does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — the canyon is 12800 units across, a
// speed is units a step — and use nothing but `+ - * /`, comparisons,
// `Math.floor`, `Math.trunc`, `Math.min`, `Math.max`, `Math.abs`, `Math.sqrt`
// and `Math.imul`, whose results the language fixes to the last bit. Every
// product of two numbers stays far below 2^53, where a double still holds a
// whole number exactly. Trigonometry appears only in the drawing, which is
// nobody's business but the screen's.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (w, n) => Math.floor(draw01(w) * n);

// The whole part of a square root. `Math.sqrt` is rounded correctly by the
// language's own definition, so this is the same number on every machine.
const isqrt = (n) => (n <= 0 ? 0 : Math.floor(Math.sqrt(n)));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the canyon a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own cab a trip ahead, with your hand in it

// The canyon, seen side on: five columns, each with one ledge carrying a
// lettered pad (or the pad on the floor), and a rock spire between every two
// columns. Nothing ever stands above a pad, so a pad can always be reached
// straight down from the open sky at the top.
const W = 12800, H = 8800;
const COLS = 5, COL_W = W / COLS;
const FLOOR = 8400;            // the floor's top
const PAD_HALF = 800;          // half a ledge's width
const SLAB = 400;              // a ledge's thickness
const SPIRE_HALF = 200;        // half a spire's width
const LEDGE_LO = 3200, LEDGE_HI = 7400;   // where a ledge's top may stand
const SPIRE_LO = 4600, SPIRE_HI = 7600;   // and a spire's

const LW = 240, LH = 170;      // half a cab's width and height
const LR = 230;                // how close two cabs come before they meet
const G = 4;                   // gravity, units a step a step
const UP = 7, UP_BEHIND = 8;   // the jet underneath, and for whoever trails the leader
const SIDE_JET = 4, SIDE_BEHIND = 5;
const DRAG_X = 32, DRAG_Y = 64; // a speed loses this fraction of itself a step
const VMAX = 220;
const LAND_V = 70;             // the fastest a cab may come down and stay down
const LAND_VX = 70;            // and the fastest it may be drifting sideways
const CRASH_V = 130;           // coming down faster than this onto rock wrecks a cab
const CRASH_SIDE = 105;        // and flying into rock side on faster than this
const FUEL = 900;              // a full tank: thirty seconds of the jet underneath
const REFUEL = 12;             // fuel a step while standing on a pad
const RAM_V = 70;              // the least closing speed that knocks a cab spinning
const SPIN = 24;               // steps a rammed cab spins with no jets
const SAFE = 45;               // steps a fresh cab blinks, and nothing rams it
const HANG = 75;               // steps before that it hangs still, until its pilot first burns a jet
const WRECK = 2 * HZ;          // steps from a wreck to the next cab
const BOARD = 14;              // steps a fare takes to climb in, or out and pay
const PICK = LW + 320;         // how far from a waiting fare a cab may stand to take it
const CATCH = LR + 170;        // how close a cab flies to a parachute to catch it
const CHUTE_V = 36;            // how fast a parachute comes down
const FARE_LIFE = 24 * HZ;     // steps a fare waits on a pad before giving up
const STRAND_LIFE = 9 * HZ;    // and somewhere that is not a pad
const PAR0 = 5 * HZ, PAR_COL = 2 * HZ;   // a ride's fair time: so much, and so much a column
const LATE_STEP = 2 * HZ;      // a coin off the fare for every this much over it
const SPAWN_GAP = 45;          // steps between two fares turning up, at the least
const SPAWN_GAP_RUSH = 24;     // the same, in the rush hour
const RAM_PTS = 1;             // coins for knocking a rival spinning
const LEAD_BONUS = 1;          // more, when the rival was the leader
const VIP = 0.12;              // how often a fare is in gold and pays double
const MAX_F = 12;              // fares in the canyon at once
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;
const NOBODY = -9999;
const SPAWN_Y = 1200;          // the height a fresh cab comes in at
const HOVER_Y = 1500;          // where cabs hang through a countdown

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 120 * HZ;
const END_STEPS = 7 * HZ;
const RUSH_AT = 95 * HZ;       // steps into a round when rush hour comes and every fare pays double

const LETTER = ['A', 'B', 'C', 'D', 'E'];

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every cab is made by one function with its fields in one order.
//   r: the rock, each [x0, y0, x1, y1]; pd: the pads A to E, each [x0, x1,
//   top]; fn: the next fare's number; f: the fares, each [number, state (0
//   waiting, 1 under a parachute), x, y, drift, pad wanted, coins, steps left,
//   gold]; nf: steps until the next fare may turn up; res: the last round's
//   [id, coins, fares, rams, rounds won] rows; win: its winner
function freshTable(seed) {
  const t = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, r: [], pd: [], fn: 0, f: [], nf: SPAWN_GAP, p: {}, res: null, win: -1 };
  carve(t);
  return t;
}

const FIELDS = ['c', 's', 'x', 'y', 'vx', 'vy', 'jx', 'ju', 'st', 't', 'fu', 'sp', 'sf', 'fd', 'fv', 'fg', 'fa',
  'bf', 'bd', 'rp', 'fares', 'rams', 'wn', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; x, y: the cab's middle, in units; vx, vy: speed; jx:
//   the side jets, -1, 0 or 1; ju: the jet underneath, 0 or 1; st: 0 flying,
//   1 standing on rock, 2 wrecked; t: steps in that state; fu: fuel; sp: steps
//   it still spins; sf: steps it is still safe, the first of them hanging; fd: the pad its fare wants, or
//   -1 with nobody aboard; fv: what that fare pays; fg: whether it is in gold;
//   fa: steps it has been aboard; bf: the fare climbing in, -2 while one
//   climbs out, -1 for neither; bd: steps of that so far; rp: coins this
//   round; fares: fares delivered; rams: rivals rammed; wn: rounds won; bw:
//   the bot's pause; hs, hc: hands this step.
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
    c: freeOf(w, 'c'), s: freeOf(w, 's'), x: W / 2, y: SPAWN_Y, vx: 0, vy: 0, jx: 0, ju: 0, st: 0, t: 0, fu: FUEL,
    sp: 0, sf: SAFE, fd: -1, fv: 0, fg: 0, fa: 0, bf: -1, bd: 0, rp: 0, fares: 0, rams: 0, wn: 0, bw: 0, hs: w.n, hc: 0,
  });
}

// A new canyon: a ledge in every column at a height of its own, now and then
// the pad down on the floor instead, and a spire between every two columns.
function carve(w) {
  w.r = [[0, FLOOR, W, H]];
  w.pd = [];
  for (let i = 0; i < COLS; i++) {
    const cx = COL_W * i + COL_W / 2;
    if (draw01(w) < 0.22) {
      w.pd.push([cx - PAD_HALF, cx + PAD_HALF, FLOOR]);
      continue;
    }
    const top = LEDGE_LO + pick(w, (LEDGE_HI - LEDGE_LO) / 100 + 1) * 100;
    w.r.push([cx - PAD_HALF, top, cx + PAD_HALF, top + SLAB]);
    w.pd.push([cx - PAD_HALF, cx + PAD_HALF, top]);
  }
  for (let i = 1; i < COLS; i++) {
    const x = COL_W * i, top = SPIRE_LO + pick(w, (SPIRE_HI - SPIRE_LO) / 100 + 1) * 100;
    w.r.push([x - SPIRE_HALF, top, x + SPIRE_HALF, FLOOR]);
  }
}

// The pad a cab stands on, or -1: standing, its feet on the pad's top and its
// middle over the pad.
function padUnder(w, d) {
  if (d.st !== 1) return -1;
  for (let i = 0; i < w.pd.length; i++) {
    const q = w.pd[i];
    if (d.y + LH === q[2] && d.x >= q[0] && d.x <= q[1]) return i;
  }
  return -1;
}

// The one leader, as every copy works it out: the most coins this round, when
// somebody has some and nobody matches them.
function leaderOf(w) {
  let top = 0, who = NOBODY, tie = false;
  for (const id of playersIn(w)) {
    const r = w.p[id].rp;
    if (r > top) { top = r; who = id; tie = false; } else if (r === top && r > 0) tie = true;
  }
  return tie ? NOBODY : who;
}
const trails = (w, id) => w.ph === PLAY && playersIn(w).some((o) => w.p[o].rp > w.p[id].rp);
const rush = (w) => w.ph === PLAY && PLAY_STEPS - w.pt >= RUSH_AT;

// The open spot along the top of the canyon furthest from every other cab:
// where a fresh cab comes in.
function farX(w, id) {
  let best = W / 2, score = -1;
  for (let i = 0; i < 9; i++) {
    const x = 800 + i * 1400;
    let near = BIG;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o !== id && e.st !== 2) near = Math.min(near, Math.abs(e.x - x) + Math.abs(e.y - SPAWN_Y));
    }
    if (near > score) { score = near; best = x; }
  }
  return best;
}

function comeIn(w, d, x) {
  d.x = x;
  d.y = SPAWN_Y;
  d.vx = d.vy = 0;
  d.st = 0;
  d.t = 0;
  d.fu = FUEL;
  d.sp = 0;
  d.sf = SAFE + HANG;
  d.fd = -1;
  d.fv = d.fg = d.fa = 0;
  d.bf = -1;
  d.bd = 0;
}

// A hand, at its place in the room's order: one integer, 0..5 — which side
// jet burns, plus three when the jet underneath does. Being heard is how a
// player arrives: in a fresh cab, at the top of the canyon.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w);
    comeIn(w, d, farX(w, id));
    if (w.ph === COUNT || w.ph === END) d.y = HOVER_Y;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.jx = (input % 3) - 1;
  d.ju = input >= 3 ? 1 : 0;
}

// A hand off the wire, made safe: one integer in its range, or nothing.
function inputOf(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : null;
}

// Somebody gone: their cab goes, and a fare aboard it bails out where it was.
function leave(w, id) {
  const d = w.p[id];
  if (d && d.fd >= 0 && d.st !== 2) eject(w, d, 0);
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.04;         // how often it stops steering a moment rather than decide
const BOT_RAM = 0.3;           // how often it goes for a rival carrying a fare
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot flies while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    const d = (w.p[BOT_ID] = newPlayer(w));
    comeIn(w, d, farX(w, BOT_ID));
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// The highest rock top anywhere between two places, counting the width of a
// cab: the height a cab has to clear to fly from one to the other.
function clearTop(w, xa, xb) {
  const lo = Math.min(xa, xb) - LW - 200, hi = Math.max(xa, xb) + LW + 200;
  let top = FLOOR;
  for (const q of w.r) if (q[2] > lo && q[0] < hi) top = Math.min(top, q[1]);
  return top;
}

// The top of whatever rock stands under a place, or the floor.
function groundUnder(w, x) {
  let top = FLOOR;
  for (const q of w.r) if (x >= q[0] && x <= q[2]) top = Math.min(top, q[1]);
  return top;
}

// Whether a waiting fare can be reached from the open sky: nothing over it.
const reachable = (w, x, y) => groundUnder(w, x) === y;

// It flies the way a careful driver does: up over whatever stands between it
// and where it is going, across, and straight down onto the spot, slowing as
// it comes. It goes for its fare's pad, or for the nearest fare, a parachute
// before one on a ledge, now and then for a rival with a fare aboard, and for a
// pad to fill up at when its tank runs low. It decides every few steps and now
// and then lets go of the side jets a moment, so it can be outflown.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || w.n % BOT_EVERY !== 0) return;
  d.jx = 0;
  d.ju = 0;
  if (d.st === 2 || d.sp > 0) return;
  let tx = d.x, ty = HOVER_Y, land = false;
  if (d.fd >= 0) {
    const q = w.pd[d.fd];
    tx = (q[0] + q[1]) / 2;
    ty = q[2];
    land = true;
  } else if (d.fu < 260) {
    let near = BIG;
    for (const q of w.pd) {
      const e = Math.abs((q[0] + q[1]) / 2 - d.x);
      if (e < near) { near = e; tx = (q[0] + q[1]) / 2; ty = q[2]; }
    }
    land = true;
  } else {
    let near = BIG, rival = null;
    for (const f of w.f) {
      const e = Math.abs(f[2] - d.x) + Math.abs(f[3] - d.y) / 2 - (f[1] === 1 ? 2000 : 0);
      if (f[1] === 0 && !reachable(w, f[2], f[3])) continue;
      if (e < near) { near = e; tx = f[2]; ty = f[3]; land = f[1] === 0; }
    }
    for (const id of humans(w)) {
      const e = w.p[id];
      if (e.fd >= 0 && e.st === 0 && e.sf === 0 && Math.abs(e.x - d.x) < 3000) rival = e;
    }
    if (rival && (d.bw > 0 || draw01(w) < BOT_RAM)) {
      d.bw = Math.max(d.bw, 30);
      tx = rival.x;
      ty = rival.y;
      land = false;
    }
    if (near === BIG && !rival) { tx = W / 2 + (pick(w, 3) - 1) * 3000; ty = HOVER_Y; }
  }
  if (d.bw > 0) d.bw -= BOT_EVERY;
  const dx = tx - d.x;
  // Standing where it means to be — a fare climbing in or out, or a tank
  // filling — it stays put.
  if (d.st === 1 && land && Math.abs(dx) < PICK - 80 && (d.bf !== -1 || d.fu < FUEL - 40)) return;
  let wantY;
  if (Math.abs(dx) > 260) wantY = Math.min(land ? ty - LH - 900 : ty, clearTop(w, d.x, tx) - LH - 700);
  else wantY = land ? ty - LH : ty;
  // Vertical: a speed to fall or climb at, toward the height it wants, never
  // faster than it can stop from — and gentle for the last stretch onto rock.
  const gap = wantY - d.y;
  let wantVy = clamp(Math.trunc(gap / 18), -110, 110);
  if (land && Math.abs(dx) <= 260 && gap < 1400) wantVy = clamp(Math.trunc(gap / 14), 18, 45);
  if (d.vy > wantVy) d.ju = 1;
  // Sideways: only once it is high enough to clear what stands between.
  const high = d.y <= Math.max(wantY, clearTop(w, d.x, tx) - LH - 300) + 400;
  let wantVx = high || Math.abs(dx) <= 260 ? clamp(Math.trunc(dx / 12), -110, 110) : 0;
  if (draw01(w) < BOT_IDLE) d.bw = -(6 + pick(w, 12));
  if (d.bw < 0) { d.bw += BOT_EVERY; if (d.bw > 0) d.bw = 0; wantVx = d.vx; }
  if (d.vx < wantVx - 12) d.jx = 1;
  else if (d.vx > wantVx + 12) d.jx = -1;
}

// ── a step ─────────────────────────────────────────────────────────────────
// The seats close up in order, every cab hanging over a spot of its own.
function lineUp(w) {
  const ids = bySeat(w);
  ids.forEach((id, i) => {
    const d = w.p[id];
    comeIn(w, d, Math.trunc((W * (2 * i + 1)) / (2 * ids.length)));
    d.y = HOVER_Y;
  });
}

function clearCanyon(w) {
  carve(w);
  w.f = [];
  w.nf = SPAWN_GAP;
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  clearCanyon(w);
  for (const id of playersIn(w)) { const d = w.p[id]; d.rp = d.fares = d.rams = 0; }
  lineUp(w);
}

// A round: a fresh canyon, the seats closed up in order, everybody hanging in
// a row along the top.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  clearCanyon(w);
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  for (const id of ids) { const d = w.p[id]; d.rp = d.fares = d.rams = 0; }
  lineUp(w);
  fx(w, 'round', 0, 0, 0);
}

// The horn: the round to whoever has the most coins, the more fares delivered
// between two who match, and nobody if that matches too.
function finish(w) {
  const ids = bySeat(w);
  const rank = (a, b) => w.p[b].rp - w.p[a].rp || w.p[b].fares - w.p[a].fares;
  const order = ids.slice().sort((a, b) => rank(a, b) || a - b);
  const top = order[0];
  w.win = ids.length > 1 && (order.length < 2 || rank(top, order[1]) !== 0) ? top : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  w.res = order.map((id) => [id, w.p[id].rp, w.p[id].fares, w.p[id].rams, w.p[id].wn]);
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
      if (PLAY_STEPS - w.pt === RUSH_AT) fx(w, 'rush', 0, 0, 0);
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody moves while a round is counted in or its result is up: the cabs
  // hang where they are, with their tanks full.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      if (d.st === 2) comeIn(w, d, farX(w, id));
      d.vx = d.vy = 0;
      d.fu = FUEL;
    }
    return;
  }
  fly(w);
}

function fly(w) {
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) move(w, w.p[id], id);
  meet(w, ids);
  for (const id of ids) ferry(w, w.p[id], id);
  chutes(w, ids);
  fares(w);
}

// One cab through one step: its jets, gravity and the air, then the rock.
function move(w, d, id) {
  if (d.t < 100000) d.t += 1;
  if (d.st === 2) {
    if (d.t >= WRECK) { comeIn(w, d, farX(w, id)); fx(w, 'in', d.x, d.y, 0, id); }
    return;
  }
  if (d.sf > 0) d.sf -= 1;
  if (d.sp > 0) d.sp -= 1;
  const behind = trails(w, id);
  const jets = d.sp === 0 && d.fu > 0;
  const ju = jets ? d.ju : 0, jx = jets ? d.jx : 0;
  // A fresh cab hangs where it came in until its pilot first burns a jet, so
  // nobody falls out of the sky before they have found the keys.
  if (d.sf > SAFE) {
    if (!ju && !jx) { d.vx = d.vy = 0; return; }
    d.sf = SAFE;
  }
  if (d.st === 1) {
    // Standing: only the jet underneath lifts it off. A pad fills the tank.
    if (padUnder(w, d) >= 0) d.fu = Math.min(FUEL, d.fu + REFUEL);
    if (!ju) { d.vx = d.vy = 0; return; }
    d.st = 0;
    d.t = 0;
    d.bf = -1;
    d.bd = 0;
  }
  if (ju || jx) d.fu -= 1;
  d.vx += jx * (behind ? SIDE_BEHIND : SIDE_JET);
  d.vy += G - ju * (behind ? UP_BEHIND : UP);
  d.vx -= Math.trunc(d.vx / DRAG_X);
  d.vy -= Math.trunc(d.vy / DRAG_Y);
  d.vx = clamp(d.vx, -VMAX, VMAX);
  d.vy = clamp(d.vy, -VMAX, VMAX);
  moveX(w, d, id);
  if (d.st === 2) return;
  moveY(w, d, id);
}

const overlapsX = (x, q) => x - LW < q[2] && x + LW > q[0];
const overlapsY = (y, q) => y - LH < q[3] && y + LH > q[1];

// Across: a cab stops flush against the first rock in its way, and one that
// hits it too fast is wrecked.
function moveX(w, d, id) {
  if (!d.vx) return;
  let nx = clamp(d.x + d.vx, LW, W - LW);
  let hit = nx !== d.x + d.vx;
  for (const q of w.r) {
    if (!overlapsY(d.y, q) || !overlapsX(nx, q) || overlapsX(d.x, q)) continue;
    hit = true;
    nx = d.vx > 0 ? Math.min(nx, q[0] - LW) : Math.max(nx, q[2] + LW);
  }
  nx = d.vx > 0 ? Math.max(d.x, nx) : Math.min(d.x, nx);
  d.x = nx;
  if (!hit) return;
  if (Math.abs(d.vx) > CRASH_SIDE) { wreck(w, d, id); return; }
  if (Math.abs(d.vx) > 30) fx(w, 'clunk', d.x + (d.vx > 0 ? LW : -LW), d.y, 0, id);
  d.vx = -Math.trunc(d.vx / 3);
}

// Up and down: a cab coming down gently onto rock with its middle over it
// stands there; too fast and it is wrecked; in between, or caught on an edge,
// it bounces. The ceiling of the sky stops a cab and no more.
function moveY(w, d, id) {
  if (!d.vy) return;
  let ny = d.y + d.vy, top = null;
  if (ny < LH) { ny = LH; d.vy = 0; return void (d.y = ny); }
  for (const q of w.r) {
    if (!overlapsX(d.x, q) || !overlapsY(ny, q) || overlapsY(d.y, q)) continue;
    if (d.vy > 0) { if (q[1] - LH < ny) { ny = q[1] - LH; top = q; } } else ny = Math.max(ny, q[3] + LH);
  }
  ny = d.vy > 0 ? Math.max(d.y, ny) : Math.min(d.y, ny);
  const hitUp = d.vy < 0 && ny !== d.y + d.vy;
  d.y = ny;
  if (hitUp) {
    if (-d.vy > CRASH_V) { wreck(w, d, id); return; }
    d.vy = 0;
    return;
  }
  if (!top) return;
  if (d.vy > CRASH_V) { wreck(w, d, id); return; }
  if (d.vy <= LAND_V && Math.abs(d.vx) <= LAND_VX && d.x >= top[0] && d.x <= top[2]) {
    d.st = 1;
    d.t = 0;
    d.vx = d.vy = 0;
    d.bf = -1;
    d.bd = 0;
    fx(w, 'land', d.x, d.y + LH, 0, id);
    return;
  }
  // Too fast to stand, or hanging over the edge: it bounces, and off an edge
  // it is tipped away from the rock.
  fx(w, 'clunk', d.x, d.y + LH, 1, id);
  d.vy = -Math.trunc(d.vy / 3) - 6;
  if (d.x < top[0]) d.vx -= 10; else if (d.x > top[2]) d.vx += 10;
}

// A fare bails out of a cab on a parachute, where the cab is, drifting the
// way the cab was going.
function eject(w, d, up) {
  if (d.fd < 0) return;
  if (w.f.length < MAX_F) {
    w.fn = (w.fn + 1) % 100000;
    w.f.push([w.fn, 1, d.x, clamp(d.y - up, LH, FLOOR - 100), clamp(Math.trunc(d.vx / 2), -60, 60), d.fd, d.fv, STRAND_LIFE, d.fg]);
    fx(w, 'eject', d.x, d.y, d.fg, NOBODY);
  }
  d.fd = -1;
  d.fv = d.fg = d.fa = 0;
}

function wreck(w, d, id) {
  fx(w, 'wreck', d.x, d.y, d.fd >= 0 ? 1 : 0, id);
  eject(w, d, 300);
  d.st = 2;
  d.t = 0;
  d.vx = d.vy = 0;
  d.bf = -1;
  d.bd = 0;
}

// Whether a cab put at a place would stand inside rock.
function inRock(w, x, y) {
  for (const q of w.r) if (overlapsX(x, q) && overlapsY(y, q)) return true;
  return false;
}

// A cab pushed aside by another moves only where there is no rock, so a push
// never lodges a cab inside a ledge.
function shove(w, d, dx, dy) {
  const x = clamp(d.x + dx, LW, W - LW), y = clamp(d.y + dy, LH, FLOOR - LH);
  if (!inRock(w, x, y)) { d.x = x; d.y = y; } else if (!inRock(w, x, d.y)) d.x = x; else if (!inRock(w, d.x, y)) d.y = y;
}

// Cabs that meet push each other apart, an even trade of speed along the line
// between them. Hard enough, and the one that did the ramming — the faster
// toward the other — knocks the other spinning: it loses its jets a moment,
// its fare bails out, and the rammer is paid. Every pair is weighed first and
// the rams applied after, so the order cabs are looked at in never decides
// who rammed whom.
function meet(w, ids) {
  const rams = [];
  for (let i = 0; i < ids.length; i++) {
    const A = w.p[ids[i]];
    if (A.st === 2) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const B = w.p[ids[j]];
      if (B.st === 2) continue;
      const dx = B.x - A.x, dy = B.y - A.y, e = dx * dx + dy * dy;
      if (e >= 4 * LR * LR) continue;
      const m = Math.max(1, isqrt(e));
      const nx = m > 1 ? dx : 1, ny = m > 1 ? dy : 0, mm = m > 1 ? m : 1;
      // Pushed apart, each half the overlap, along the line between them.
      const over = 2 * LR - m;
      const push = Math.trunc(over / 2) + 1;
      if (A.st !== 1) shove(w, A, -Math.trunc((nx * push) / mm), -Math.trunc((ny * push) / mm));
      if (B.st !== 1) shove(w, B, Math.trunc((nx * push) / mm), Math.trunc((ny * push) / mm));
      const ua = Math.trunc((A.vx * nx + A.vy * ny) / mm), ub = Math.trunc((B.vx * nx + B.vy * ny) / mm);
      const closing = ua - ub;
      if (closing <= 0) continue;
      // Equal cabs: the speeds along the line are traded, a little lost.
      const k = Math.trunc((closing * 9) / 10);
      A.vx -= Math.trunc((nx * k) / mm); A.vy -= Math.trunc((ny * k) / mm);
      B.vx += Math.trunc((nx * k) / mm); B.vy += Math.trunc((ny * k) / mm);
      if (A.st === 1 && k > 20) A.st = 0;
      if (B.st === 1 && k > 20) B.st = 0;
      fx(w, 'bump', Math.trunc((A.x + B.x) / 2), Math.trunc((A.y + B.y) / 2), closing, ids[i], ids[j]);
      if (closing < RAM_V) continue;
      // Whoever came on faster rammed the other.
      if (ua > -ub) { if (B.sf === 0 && B.sp === 0) rams.push([ids[j], ids[i]]); } else if (A.sf === 0 && A.sp === 0) rams.push([ids[i], ids[j]]);
    }
  }
  for (const [victim, by] of rams) {
    const d = w.p[victim], p = w.p[by];
    if (!d || !p || d.sp > 0) continue;
    const pts = w.ph === PLAY ? RAM_PTS + (leaderOf(w) === victim ? LEAD_BONUS : 0) : 0;
    p.rp += pts;
    p.rams += 1;
    d.sp = SPIN;
    d.st = 0;
    d.bf = -1;
    d.bd = 0;
    fx(w, 'ram', d.x, d.y, pts, victim, by);
    eject(w, d, 0);
  }
}

// Standing on rock: a waiting fare close by climbs in, and a fare aboard
// climbs out on the pad it asked for and pays. Either takes a moment, and a
// cab that lifts off or is knocked off in that moment leaves it undone.
function ferry(w, d, id) {
  if (d.st !== 1) {
    if (d.fd >= 0) d.fa = Math.min(d.fa + 1, BIG);
    return;
  }
  if (d.fd >= 0) {
    d.fa = Math.min(d.fa + 1, BIG);
    if (padUnder(w, d) !== d.fd) return;
    if (d.bf !== -2) { d.bf = -2; d.bd = 0; }
    if (++d.bd < BOARD) return;
    pay(w, d, id);
    return;
  }
  // The nearest fare waiting on this same rock that nobody else is taking.
  let best = null, near = PICK + 1;
  for (const f of w.f) {
    if (f[1] !== 0 || f[3] !== d.y + LH) continue;
    const e = Math.abs(f[2] - d.x);
    if (e > PICK || e >= near) continue;
    if (playersIn(w).some((o) => o !== id && w.p[o].bf === f[0])) continue;
    near = e;
    best = f;
  }
  if (!best) { d.bf = -1; d.bd = 0; return; }
  if (d.bf !== best[0]) { d.bf = best[0]; d.bd = 0; }
  if (++d.bd < BOARD) return;
  aboard(w, d, best);
  fx(w, 'board', best[2], best[3], best[8], id);
  d.bf = -1;
  d.bd = 0;
}

function aboard(w, d, f) {
  w.f.splice(w.f.indexOf(f), 1);
  d.fd = f[5];
  d.fv = f[6];
  d.fg = f[8];
  d.fa = 0;
}

// What the fare aboard a cab pays as things stand: its price, less a coin for
// every stretch over the ride's fair time — longer the further it goes — but
// never less than one.
function fareNow(d) {
  if (d.fd < 0) return 0;
  const cols = (d.fg ? Math.trunc(d.fv / 2) : d.fv) - 2;
  const par = PAR0 + PAR_COL * Math.max(0, cols);
  return Math.max(1, d.fv - Math.trunc(Math.max(0, d.fa - par) / LATE_STEP));
}

// Paid: the fare as it stands, a coin more for whoever trails, and twice it
// all in rush hour.
function pay(w, d, id) {
  let v = fareNow(d);
  if (trails(w, id)) v += 1;
  if (rush(w)) v *= 2;
  d.rp += v;
  d.fares += 1;
  fx(w, 'pay', d.x, d.y + LH, v, id, d.fg);
  d.fd = -1;
  d.fv = d.fg = d.fa = 0;
  d.bf = -1;
  d.bd = 0;
}

// Parachutes come down slowly, drifting less as they go. A cab flying by with
// nobody aboard catches one; one that reaches rock waits there, and one that
// reaches the very pad it wanted has got there on its own.
function chutes(w, ids) {
  for (const f of w.f.slice()) {
    if (f[1] !== 1) continue;
    f[4] -= Math.trunc(f[4] / 16);
    const nx = clamp(f[2] + f[4], 100, W - 100), ny = f[3] + CHUTE_V;
    let catcher = null, near = CATCH * CATCH;
    for (const id of ids) {
      const d = w.p[id];
      if (d.st !== 0 || d.fd >= 0 || d.sp > 0) continue;
      const e = dist2(d.x, d.y, nx, ny);
      if (e < near) { near = e; catcher = d; }
    }
    if (catcher) {
      aboard(w, catcher, f);
      fx(w, 'catch', nx, ny, f[8], ids.find((id) => w.p[id] === catcher));
      continue;
    }
    // Rock under it this step: it settles on the rock's top.
    let land = null;
    for (const q of w.r) if (nx >= q[0] && nx <= q[2] && ny >= q[1] && f[3] <= q[1]) { if (!land || q[1] < land[1]) land = q; }
    f[2] = nx;
    if (!land) { f[3] = ny; continue; }
    f[3] = land[1];
    f[1] = 0;
    f[4] = 0;
    const at = w.pd.findIndex((q) => q[2] === land[1] && nx >= q[0] && nx <= q[1]);
    if (at === f[5]) {
      w.f.splice(w.f.indexOf(f), 1);
      fx(w, 'home', nx, land[1], 0, NOBODY);
      continue;
    }
    f[7] = at >= 0 ? FARE_LIFE : STRAND_LIFE;
    fx(w, 'touch', nx, land[1], 0, NOBODY);
  }
}

// Fares turn up on pads with nobody standing on them and nobody waiting
// there already, asking for another pad, and give up after a while. There
// are always about as many as there are cabs and one more.
function fares(w) {
  for (const f of w.f.slice()) {
    if (f[1] !== 0) continue;
    if (playersIn(w).some((id) => w.p[id].bf === f[0])) continue;
    if (--f[7] > 0) continue;
    w.f.splice(w.f.indexOf(f), 1);
    fx(w, 'gone', f[2], f[3], 0, NOBODY);
  }
  if (w.nf > 0) w.nf -= 1;
  if (w.nf > 0) return;
  w.nf = rush(w) ? SPAWN_GAP_RUSH : SPAWN_GAP;
  const ids = playersIn(w);
  const want = clamp(ids.length + 1, 3, 7) + (rush(w) ? 2 : 0);
  const riding = ids.filter((id) => w.p[id].fd >= 0).length;
  if (w.f.length + riding >= Math.min(want, MAX_F)) return;
  const free = [];
  for (let i = 0; i < COLS; i++) {
    const q = w.pd[i];
    if (w.f.some((f) => f[1] === 0 && f[3] === q[2] && f[2] >= q[0] && f[2] <= q[1])) continue;
    if (ids.some((id) => padUnder(w, w.p[id]) === i)) continue;
    free.push(i);
  }
  if (!free.length) return;
  const at = free[pick(w, free.length)];
  let to = pick(w, COLS - 1);
  if (to >= at) to += 1;
  const gold = draw01(w) < VIP ? 1 : 0;
  const q = w.pd[at];
  const x = q[0] + 200 + pick(w, (q[1] - q[0] - 400) / 50 + 1) * 50;
  const coins = (2 + Math.abs(to - at)) * (gold ? 2 : 1);
  w.fn = (w.fn + 1) % 100000;
  w.f.push([w.fn, 0, x, q[2], 0, to, coins, FARE_LIFE, gold]);
  fx(w, 'fare', x, q[2], gold, NOBODY);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.fn, 0, 99999) || !int(raw.nf, 0, SPAWN_GAP)) return null;
  if (!Array.isArray(raw.r) || raw.r.length < COLS || raw.r.length > 2 * COLS) return null;
  const r = [];
  for (const q of raw.r) {
    if (!Array.isArray(q) || q.length !== 4 || !int(q[0], 0, W) || !int(q[2], 0, W) || !int(q[1], 0, H) || !int(q[3], 0, H)) return null;
    if (q[0] >= q[2] || q[1] >= q[3]) return null;
    r.push(q.slice());
  }
  if (!Array.isArray(raw.pd) || raw.pd.length !== COLS) return null;
  const pd = [];
  for (const q of raw.pd) {
    if (!Array.isArray(q) || q.length !== 3 || !int(q[0], 0, W) || !int(q[1], 0, W) || !int(q[2], LEDGE_LO, FLOOR) || q[0] >= q[1]) return null;
    pd.push(q.slice());
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
    if (!int(d.x, LW, W - LW) || !int(d.y, LH, FLOOR - LH) || !int(d.vx, -VMAX, VMAX) || !int(d.vy, -VMAX, VMAX)) return null;
    if (!int(d.jx, -1, 1) || !int(d.ju, 0, 1) || !int(d.st, 0, 2) || !int(d.t, 0, 100000) || !int(d.fu, 0, FUEL)) return null;
    if (!int(d.sp, 0, SPIN) || !int(d.sf, 0, SAFE + HANG) || !int(d.fd, -1, COLS - 1) || !int(d.fv, 0, 99) || !int(d.fg, 0, 1)) return null;
    if (!int(d.fa, 0, BIG) || !int(d.bf, -2, 99999) || !int(d.bd, 0, BOARD)) return null;
    if (!int(d.rp, 0, 99999) || !int(d.fares, 0, 99999) || !int(d.rams, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bw, -99, 99) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  if (!Array.isArray(raw.f) || raw.f.length > MAX_F) return null;
  const f = [];
  const nums = new Set();
  for (const q of raw.f) {
    if (!Array.isArray(q) || q.length !== 9) return null;
    const [n, st, x, y, vx, to, coins, life, gold] = q;
    if (!int(n, 0, 99999) || nums.has(n) || !int(st, 0, 1) || !int(x, 0, W) || !int(y, 0, H) || !int(vx, -60, 60)) return null;
    if (!int(to, 0, COLS - 1) || !int(coins, 0, 99) || !int(life, -1, FARE_LIFE) || !int(gold, 0, 1)) return null;
    nums.add(n);
    f.push(q.slice());
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const row of raw.res) {
      if (!Array.isArray(row) || row.length !== 5 || !row.every((v) => int(v, -BIG, BIG))) return null;
      res.push(row.slice());
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, r, pd, fn: raw.fn, f, nf: raw.nf, p, res, win: raw.win };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, z, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, z, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a canyon at night under a violet sky with a city glowing far
// off, slate rock with a cold rim of moonlight, pads lit in neon teal, and
// every cab a bright colour of its own with a taxi light on its roof.
const INK = {
  page: '#0f0a24', skyTop: '#140e33', skyMid: '#2a1a55', skyLow: '#5a2a66', glow: '#ff7a59',
  text: '#ffffff', muted: '#d9d3f2', dim: '#9a90c4', gold: '#ffd166', danger: '#ff6b6b',
  rock: '#2a2342', rockDeep: '#1a1530', rim: '#6b5b9a', strata: 'rgba(255,255,255,0.05)',
  pad: '#3ff0d2', padDim: 'rgba(63,240,210,0.35)', glass: '#9fe8ff', flame: '#ffb347', smoke: '#cfc7ea',
  coat: '#e8e0ff', panel: 'rgba(14,10,34,0.93)', ink: 'rgba(12,8,30,0.85)',
};
const SEAT = ['#ff4f7b', '#2f8cff', '#ffa31a', '#3ccf4e', '#b44dff', '#00c2d6', '#ff6a2b', '#f4f4f4'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4d3f7a;' +
  `background:#1f1840;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
const SIDE = 160;              // the least a column beside the canyon needs for the scoreboard
let VW = 640, VH = 400, sc = 0.03, ox = 0, oy = 58, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340;
let wide = false, colW = 0;
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

// The whole canyon is always on screen, as large as the frame lets it be. A
// frame wider than the canyon puts the status, the scoreboard, your tank and
// your fare and the line of controls in the columns either side of it, so the
// canyon takes the whole height. A narrower one stacks them in strips above and
// below it, with NOTE_ROOM under it for the practice note and, in a round, for
// your tank — pads stand on the floor too, so nothing covers it. Whichever of
// the two draws the canyon bigger is the one used. The rim of rock round the
// canyon is part of what is fitted, so it is never cropped either.
const RIM = 160;               // the rim's width, in units
function fit() {
  const fw = W + 2 * RIM, fh = H + 2 * RIM;
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  const tall = Math.min((VW - 8) / fw, ah / fh), side = Math.min((VH - 12) / fh, (VW - 2 * SIDE) / fw);
  wide = side > tall;
  sc = Math.max(0.002, wide ? side : tall);
  ox = (VW - sc * W) / 2;
  oy = wide ? (VH - sc * H) / 2 : TOP + (ah - sc * H) / 2;
  colW = wide ? ox - RIM * sc : 0;
  fieldTop = oy - RIM * sc;
  fieldBot = oy + sc * (H + RIM);
}

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

const SX = (x) => ox + x * sc + shakeX;
const SY = (y) => oy + y * sc + shakeY;
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
const sound = {
  jet(up) { if (ready('jet', 110)) puff(0.16, up ? 0.05 : 0.025, up ? 420 : 900, 0, 0.7); },
  land() { if (ready('land', 120)) { tone(110, 0.12, 'sine', 0.1, 0.7); puff(0.1, 0.05, 600, 0, 1); } },
  clunk(near) { if (ready('clunk', 90)) { tone(160, 0.08, 'square', 0.03 + 0.05 * near, 0.6); puff(0.05, 0.04, 1500, 0, 1.5); } },
  wreck(near) {
    if (!ready('wreck', 120)) return;
    puff(0.6, 0.1 + 0.18 * near, 280, 0, 0.6);
    tone(90, 0.5, 'sawtooth', 0.04 + 0.08 * near, 0.3);
  },
  ram(mine) { if (ready('ram', 80)) { tone(mine ? 520 : 380, 0.12, 'square', mine ? 0.08 : 0.04, 0.5); puff(0.1, 0.08, 2600, 0, 1.2); } },
  bump() { if (ready('bump', 90)) tone(200, 0.08, 'sine', 0.06, 0.7); },
  board() { if (ready('board', 100)) [660, 880].forEach((f, i) => tone(f, 0.09, 'triangle', 0.07, 0, i * 0.06)); },
  pay(gold) {
    if (!ready('pay', 80)) return;
    (gold ? [988, 1319, 1568, 1976] : [1319, 1568, 1976]).forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, i * 0.05));
  },
  ding() { if (ready('ding', 150)) tone(1175, 0.18, 'sine', 0.025, 1); },
  bail() { if (ready('bail', 120)) { tone(700, 0.25, 'sine', 0.05, 0.4); puff(0.2, 0.04, 2000, 0.05, 0.8); } },
  catch() { if (ready('catch', 120)) [784, 1047, 1319].forEach((f, i) => tone(f, 0.1, 'square', 0.04, 1, i * 0.05)); },
  rush() { if (ready('rush', 400)) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'square', 0.04, 1, i * 0.09)); },
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
// fast screen and a slow one see the same spray. Positions are canyon units.
const bits = [];      // { x, y, vx, vy, g, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, g) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: g || 0, life: 0, max: 18 + Math.random() * 24, size, colour });
  }
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 15 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 26, r }); }
function moveBits(n) {
  for (let j = 0; j < n; j++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.93; b.vy *= 0.93;
      b.vy += b.g / BIT_HZ;
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
const looks = new Map();      // id -> { tilt, seen, squash, flame, side }
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const lookOf = (id, now) => {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { tilt: 0, seen: now, squash: 0, flame: 0, side: 0 }));
  l.seen = now;
  return l;
};

function play(e, t, now) {
  const me = myId();
  const mine = e.a === me;
  if (e.kind === 'land') {
    spray(e.x, e.y, 10, INK.smoke, 900, 40, 0);
    lookOf(e.a, now).squash = 1;
    if (mine) sound.land();
  } else if (e.kind === 'clunk') {
    spray(e.x, e.y, 6, '#ffe7a8', 1600, 30, 0);
    lookOf(e.a, now).squash = 0.6;
    if (mine) { sound.clunk(1); shake = Math.max(shake, 2); }
  } else if (e.kind === 'wreck') {
    const c = colourOf(t, e.a);
    spray(e.x, e.y, 34, INK.flame, 2600, 60, 600);
    spray(e.x, e.y, 18, c, 2000, 70, 900);
    spray(e.x, e.y, 14, INK.smoke, 900, 90, -200);
    ring(e.x, e.y, INK.flame, 700);
    pop(e.x, e.y - 300, 'boom!', INK.flame, mine ? 22 : 15);
    if (mine) shake = Math.max(shake, 12);
    sound.wreck(mine ? 1 : 0.3);
  } else if (e.kind === 'in') {
    ring(e.x, e.y, colourOf(t, e.a), 500);
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 5, '#ffffff', 1400, 26, 0);
    if (e.a === me || e.b === me) sound.bump();
  } else if (e.kind === 'ram') {
    spray(e.x, e.y, 16, '#ffe7a8', 2400, 34, 0);
    ring(e.x, e.y, '#ffffff', 600);
    if (mine) { shake = Math.max(shake, 8); pop(e.x, e.y - 260, 'spun!', INK.danger, 20); }
    if (e.z) pop(e.x, e.y - 420, '+' + e.z + (e.b === me ? '' : ' ' + nickOf(e.b)), e.b === me ? INK.gold : colourOf(t, e.b), e.b === me ? 21 : 14);
    if (e.b === me) shake = Math.max(shake, 4);
    sound.ram(mine || e.b === me);
  } else if (e.kind === 'eject') {
    spray(e.x, e.y, 8, e.z ? INK.gold : INK.coat, 1200, 30, 0);
    pop(e.x, e.y - 300, 'bail!', INK.coat, 13);
    sound.bail();
  } else if (e.kind === 'catch') {
    spray(e.x, e.y, 14, e.z ? INK.gold : INK.coat, 1500, 34, 0);
    ring(e.x, e.y, INK.pad, 500);
    pop(e.x, e.y - 300, 'catch!', mine ? INK.gold : colourOf(t, e.a), mine ? 20 : 14);
    if (mine) sound.catch();
  } else if (e.kind === 'board') {
    spray(e.x, e.y - 100, 8, e.z ? INK.gold : INK.coat, 900, 28, 0);
    pop(e.x, e.y - 360, 'hop!', mine ? INK.text : colourOf(t, e.a), mine ? 17 : 12);
    if (mine) sound.board();
  } else if (e.kind === 'pay') {
    spray(e.x, e.y - 120, 18, INK.gold, 1500, 40, 1600);
    ring(e.x, e.y, INK.gold, 600);
    pop(e.x, e.y - 520, '+' + e.z + (mine ? '' : ' ' + nickOf(e.a)), mine ? INK.gold : colourOf(t, e.a), mine ? 24 : 14);
    if (mine) { shake = Math.max(shake, 3); sound.pay(e.b); }
  } else if (e.kind === 'fare') {
    ring(e.x, e.y - 160, e.z ? INK.gold : INK.pad, 360);
    sound.ding();
  } else if (e.kind === 'gone' || e.kind === 'home') {
    spray(e.x, e.y - 120, 8, INK.smoke, 600, 30, -300);
  } else if (e.kind === 'touch') {
    spray(e.x, e.y, 6, INK.smoke, 700, 26, 0);
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'rush') {
    shake = Math.max(shake, 4);
    sound.rush();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(e.b === me);
  }
}

// The night: a violet sky over a glowing city far off, a moon, and stars that
// twinkle on the page's clock.
function drawBack(t, now) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.skyTop);
  g.addColorStop(0.55, INK.skyMid);
  g.addColorStop(1, INK.skyLow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  for (let i = 0; i < 60; i++) {
    const x = ((i * 0.6180339) % 1) * VW, y = ((i * 0.3819660 * 7) % 1) * VH * 0.7;
    const a = 0.2 + 0.3 * (0.5 + 0.5 * Math.sin(now / 600 + i * 2.3));
    ctx.fillStyle = `rgba(240,236,255,${a.toFixed(3)})`;
    disc(x, y, 0.7 + (i % 3) * 0.45);
    ctx.fill();
  }
  const mx = VW * 0.82, my = VH * 0.14, mr = Math.max(10, Math.min(VW, VH) * 0.05);
  const mg = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 3);
  mg.addColorStop(0, 'rgba(255,240,220,0.22)');
  mg.addColorStop(1, 'rgba(255,240,220,0)');
  ctx.fillStyle = mg;
  ctx.fillRect(mx - mr * 3, my - mr * 3, mr * 6, mr * 6);
  ctx.fillStyle = '#fff1dc';
  disc(mx, my, mr);
  ctx.fill();
  ctx.fillStyle = INK.skyMid;
  disc(mx + mr * 0.45, my - mr * 0.2, mr * 0.85);
  ctx.fill();
  // The city, far off: towers with a few lit windows.
  const base = VH * 0.98;
  ctx.fillStyle = 'rgba(20,12,44,0.75)';
  for (let i = 0; i < 26; i++) {
    const bw = VW / 22, x = i * bw * 0.9 - bw * 0.3, h = VH * (0.08 + 0.14 * ((i * 0.618) % 1));
    ctx.fillRect(x, base - h, bw * 0.8, h + VH);
  }
  ctx.fillStyle = 'rgba(255,190,120,0.35)';
  for (let i = 0; i < 70; i++) {
    const x = ((i * 0.7548776) % 1) * VW, y = base - VH * 0.02 - ((i * 0.5698403) % 1) * VH * 0.12;
    if (Math.sin(now / 1900 + i * 4.1) > 0.75) continue;
    ctx.fillRect(x, y, 2, 2);
  }
}

// One block of rock: slate with a moonlit rim along its top, and faint
// strata across it.
function drawRock(x0, y0, x1, y1, deep) {
  const X0 = SX(x0), Y0 = SY(y0), w = (x1 - x0) * sc, h = (y1 - y0) * sc;
  const g = ctx.createLinearGradient(0, Y0, 0, Y0 + h);
  g.addColorStop(0, INK.rock);
  g.addColorStop(1, INK.rockDeep);
  ctx.fillStyle = g;
  roundRect(X0, Y0, w, h, Math.min(8, 60 * sc));
  ctx.fill();
  ctx.save();
  roundRect(X0, Y0, w, h, Math.min(8, 60 * sc));
  ctx.clip();
  ctx.fillStyle = INK.strata;
  for (let y = Y0 + 220 * sc; y < Y0 + h; y += 260 * sc) ctx.fillRect(X0, y, w, Math.max(1, 30 * sc));
  ctx.restore();
  if (!deep) {
    ctx.fillStyle = INK.rim;
    roundRect(X0, Y0, w, Math.max(2, 50 * sc), Math.min(3, 25 * sc));
    ctx.fill();
  }
}

// The canyon: a rim of rock round the sky, the floor, the spires and the
// ledges, and on every pad a strip of neon with its letter painted below —
// the pad your fare wants beaming a column of light up into the sky.
function drawCanyon(t, now, want) {
  flat();
  const r = RIM * sc;
  ctx.fillStyle = INK.rockDeep;
  ctx.fillRect(SX(0) - r, SY(0) - r, W * sc + 2 * r, r);
  ctx.fillRect(SX(0) - r, SY(0), r, H * sc + r);
  ctx.fillRect(SX(W), SY(0), r, H * sc + r);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(SX(0) - 1, SY(0), 1, H * sc);
  ctx.fillRect(SX(W), SY(0), 1, H * sc);
  // The beam of the pad your fare wants, under everything else.
  if (want >= 0 && t.pd[want]) {
    const q = t.pd[want], x0 = SX(q[0]), w = (q[1] - q[0]) * sc, k = 0.5 + 0.5 * Math.sin(now / 220);
    const g = ctx.createLinearGradient(0, SY(0), 0, SY(q[2]));
    g.addColorStop(0, 'rgba(63,240,210,0)');
    g.addColorStop(1, `rgba(63,240,210,${(0.16 + 0.12 * k).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(x0 + w * 0.15, SY(0), w * 0.7, (q[2]) * sc);
  }
  for (const q of t.r) drawRock(q[0], q[1], q[2], Math.min(q[3], H), q[1] >= FLOOR);
  ctx.fillStyle = INK.rim;
  ctx.fillRect(SX(0), SY(FLOOR), W * sc, Math.max(2, 50 * sc));
  t.pd.forEach((q, i) => {
    const x0 = SX(q[0]), w = (q[1] - q[0]) * sc, y = SY(q[2]);
    const lit = i === want ? 0.75 + 0.25 * Math.sin(now / 160) : 0.85;
    ctx.shadowColor = INK.pad;
    ctx.shadowBlur = i === want ? 16 : 8;
    ctx.fillStyle = alpha(INK.pad, lit);
    roundRect(x0 + w * 0.06, y - Math.max(2, 40 * sc), w * 0.88, Math.max(3, 70 * sc), Math.max(1, 30 * sc));
    ctx.fill();
    ctx.shadowBlur = 0;
    // Little lights at the pad's two ends.
    for (const e of [0.06, 0.94]) {
      ctx.fillStyle = Math.floor(now / 500 + i) % 2 ? '#ffffff' : INK.pad;
      disc(x0 + w * e, y - Math.max(2, 40 * sc), Math.max(1.5, 45 * sc));
      ctx.fill();
    }
    const px = Math.max(10, Math.min(30, 300 * sc));
    const ly = q[2] >= FLOOR ? y + Math.max(px * 0.9, (SLAB * 0.75) * sc) : y + (SLAB * 0.5) * sc + px * 0.36;
    text(LETTER[i], x0 + w / 2, ly, px, i === want ? INK.pad : alpha(INK.pad, 0.75), 'center');
  });
}

// A person: a round head and a coat, white or gold, as many units tall as `h`.
function person(x, y, h, gold, wave, now) {
  ctx.fillStyle = gold ? INK.gold : INK.coat;
  ctx.strokeStyle = 'rgba(20,10,40,0.6)';
  ctx.lineWidth = Math.max(1, h * 0.05);
  ctx.beginPath();
  ctx.moveTo(x - h * 0.2, y);
  ctx.lineTo(x - h * 0.16, y - h * 0.62);
  ctx.quadraticCurveTo(x, y - h * 0.74, x + h * 0.16, y - h * 0.62);
  ctx.lineTo(x + h * 0.2, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  disc(x, y - h * 0.82, h * 0.15);
  ctx.fillStyle = '#f2c9a0';
  ctx.fill();
  ctx.stroke();
  if (wave) {
    const a = Math.sin(now / 140) * 0.5;
    ctx.strokeStyle = gold ? INK.gold : INK.coat;
    ctx.lineWidth = Math.max(1.5, h * 0.09);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + h * 0.14, y - h * 0.58);
    ctx.lineTo(x + h * 0.3 + Math.sin(a) * h * 0.1, y - h * 0.95);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
}

// A waiting fare: a person on the rock with a bubble over them naming the
// pad they want and what they pay, fading as they lose patience.
function drawWaiting(f, t, now, claimed) {
  const x = SX(f[2]), y = SY(f[3]), h = Math.max(9, 300 * sc);
  const fade = f[7] < 3 * HZ && !claimed ? 0.45 + 0.55 * Math.abs(Math.sin(now / 160)) : 1;
  ctx.globalAlpha = fade;
  person(x, y, h, f[8], !claimed, now);
  const label = LETTER[f[5]] + ' ' + f[6];
  const px = Math.max(9, Math.min(15, 170 * sc));
  ctx.font = font(px);
  const bw = ctx.measureText(label).width + px * 0.9, bh = px * 1.45;
  const by = y - h * 1.3 - bh - Math.sin(now / 300 + f[0]) * 2;
  ctx.fillStyle = f[8] ? INK.gold : '#ffffff';
  roundRect(x - bw / 2, by, bw, bh, bh / 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 3, by + bh - 1);
  ctx.lineTo(x, by + bh + 4);
  ctx.lineTo(x + 3, by + bh - 1);
  ctx.fill();
  text(label, x, by + bh * 0.72, px, '#21163f', 'center');
  // Patience: a thin ring that empties.
  const k = clamp(f[7] / (f[7] > STRAND_LIFE ? FARE_LIFE : STRAND_LIFE), 0, 1);
  ctx.strokeStyle = 'rgba(33,22,63,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x + bw / 2 + 5, by + bh / 2, 3.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// A fare under a parachute, swinging as it comes down.
function drawChute(f, x, y, now) {
  const X = SX(x), Y = SY(y), h = Math.max(9, 300 * sc), sw = Math.sin(now / 260 + f[0]) * 0.25;
  ctx.save();
  ctx.translate(X, Y);
  ctx.rotate(sw);
  const cr = h * 0.95;
  ctx.fillStyle = f[8] ? INK.gold : '#ff8fb8';
  ctx.beginPath();
  ctx.arc(0, -h * 1.4, cr, Math.PI, 0);
  ctx.quadraticCurveTo(cr * 0.5, -h * 1.25, 0, -h * 1.4);
  ctx.quadraticCurveTo(-cr * 0.5, -h * 1.25, -cr, -h * 1.4);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.arc(0, -h * 1.4, cr, Math.PI * 1.35, Math.PI * 1.65);
  ctx.lineTo(0, -h * 1.4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-cr, -h * 1.4);
  ctx.lineTo(0, -h * 0.75);
  ctx.lineTo(cr, -h * 1.4);
  ctx.stroke();
  person(0, h * 0.25, h, f[8], false, now);
  ctx.restore();
}

// A cab: a rounded body in its seat's colour with a band of checks, a glass
// dome with its fare inside when it has one, a taxi light on the roof — lit
// while it is free for hire — two legs, and its jets burning. Wrecked, it is
// smoke; spinning, it turns over; a fresh one blinks.
function drawCab(id, X, Y, d, colour, me, now) {
  const look = lookOf(id, now);
  const s = sc;
  const ju = d.st !== 2 && d.sp === 0 && d.fu > 0 && d.ju === 1;
  const jx = d.st !== 2 && d.sp === 0 && d.fu > 0 ? d.jx : 0;
  look.flame += ((ju ? 1 : 0) - look.flame) * per60(0.35);
  look.side += (jx - look.side) * per60(0.35);
  const want = d.sp > 0 ? (now / 60) % (Math.PI * 2) : clamp(d.vx / 900 + jx * 0.12, -0.35, 0.35);
  if (d.sp > 0) look.tilt = want; else look.tilt += (want - look.tilt) * per60(0.18);
  look.squash *= Math.pow(0.86, frameDt * 60);
  if (d.sf > 0 && Math.floor(now / 90) % 2) ctx.globalAlpha = 0.45;
  ctx.save();
  ctx.translate(X, Y);
  ctx.rotate(look.tilt);
  ctx.scale(1 + 0.12 * look.squash, 1 - 0.12 * look.squash);
  const bw = LW * s, bh = LH * s;
  // Jets: the big flame under it, the small ones at its sides.
  if (look.flame > 0.05) {
    const fl = bh * (1.2 + 0.4 * Math.sin(now / 30 + id)) * look.flame;
    const g = ctx.createLinearGradient(0, bh * 0.7, 0, bh * 0.7 + fl);
    g.addColorStop(0, '#fff3c4');
    g.addColorStop(0.4, INK.flame);
    g.addColorStop(1, 'rgba(255,90,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-bw * 0.28, bh * 0.7);
    ctx.quadraticCurveTo(0, bh * 0.7 + fl * 1.3, bw * 0.28, bh * 0.7);
    ctx.fill();
  }
  if (Math.abs(look.side) > 0.05) {
    const dir = look.side > 0 ? -1 : 1, fl = bw * 0.45 * Math.abs(look.side) * (1 + 0.3 * Math.sin(now / 25));
    ctx.fillStyle = 'rgba(255,200,120,0.85)';
    ctx.beginPath();
    ctx.moveTo(dir * bw * 0.95, -bh * 0.15);
    ctx.lineTo(dir * (bw * 0.95 + fl), 0);
    ctx.lineTo(dir * bw * 0.95, bh * 0.15);
    ctx.fill();
  }
  // Legs.
  ctx.strokeStyle = '#3b3358';
  ctx.lineWidth = Math.max(1.2, 40 * s);
  ctx.beginPath();
  ctx.moveTo(-bw * 0.55, bh * 0.4);
  ctx.lineTo(-bw * 0.75, bh);
  ctx.moveTo(bw * 0.55, bh * 0.4);
  ctx.lineTo(bw * 0.75, bh);
  ctx.stroke();
  // The dome, with the fare inside.
  ctx.fillStyle = alpha(INK.glass, 0.55);
  ctx.beginPath();
  ctx.ellipse(0, -bh * 0.25, bw * 0.55, bh * 0.75, 0, Math.PI, 0);
  ctx.fill();
  if (d.fd >= 0) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, -bh * 0.25, bw * 0.55, bh * 0.75, 0, Math.PI, 0);
    ctx.clip();
    person(bw * 0.12, bh * 0.15, bh * 1.1, d.fg, false, now);
    ctx.restore();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(1, 20 * s);
  ctx.beginPath();
  ctx.ellipse(0, -bh * 0.25, bw * 0.55, bh * 0.75, 0, Math.PI, 0);
  ctx.stroke();
  // The roof light: lit while free for hire.
  const free = d.fd < 0;
  ctx.fillStyle = free ? '#ffe066' : '#5c5470';
  if (free) { ctx.shadowColor = '#ffe066'; ctx.shadowBlur = 8; }
  roundRect(-bw * 0.18, -bh * 1.18, bw * 0.36, bh * 0.22, bh * 0.08);
  ctx.fill();
  ctx.shadowBlur = 0;
  // The body.
  const g = ctx.createLinearGradient(0, -bh * 0.3, 0, bh * 0.6);
  g.addColorStop(0, mix(colour, '#ffffff', 0.25));
  g.addColorStop(1, mix(colour, '#000000', 0.25));
  ctx.fillStyle = g;
  roundRect(-bw, -bh * 0.3, bw * 2, bh * 0.95, bh * 0.45);
  ctx.fill();
  ctx.save();
  roundRect(-bw, -bh * 0.3, bw * 2, bh * 0.95, bh * 0.45);
  ctx.clip();
  const ck = bh * 0.16;
  for (let i = 0; i * ck < bw * 2; i++) {
    ctx.fillStyle = i % 2 ? '#1c1430' : '#fff8e0';
    ctx.fillRect(-bw + i * ck, bh * 0.08, ck, ck);
    ctx.fillStyle = i % 2 ? '#fff8e0' : '#1c1430';
    ctx.fillRect(-bw + i * ck, bh * 0.08 + ck, ck, ck);
  }
  ctx.restore();
  roundRect(-bw, -bh * 0.3, bw * 2, bh * 0.95, bh * 0.45);
  ctx.strokeStyle = me ? '#ffffff' : 'rgba(10,6,24,0.6)';
  ctx.lineWidth = me ? Math.max(1.5, 30 * s) : Math.max(1, 18 * s);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

// A wreck: a puff of smoke rising where it was, until the next cab comes.
function drawWreck(X, Y, d, now) {
  const k = d.t / WRECK;
  for (let i = 0; i < 4; i++) {
    const r = (LW * sc) * (0.5 + 0.4 * i) * (0.6 + k);
    ctx.fillStyle = `rgba(90,80,120,${(0.35 * (1 - k)).toFixed(3)})`;
    disc(X + Math.sin(i * 2.1 + now / 400) * r * 0.4, Y - k * 600 * sc - i * r * 0.5, r);
    ctx.fill();
  }
}

// Your fare's pad, when it is off where you are looking: an arrow at the
// edge of your cab pointing toward it.
function drawPointer(t, x, y, d, now) {
  if (d.fd < 0 || d.st === 2) return;
  const q = t.pd[d.fd];
  const tx = (q[0] + q[1]) / 2, ty = q[2];
  const dx = tx - x, dy = ty - y, m = Math.hypot(dx, dy);
  if (m < 1400) return;
  const ux = dx / m, uy = dy / m, rr = (LW + 260) * sc + 2 * Math.sin(now / 150);
  const X = SX(x) + ux * rr, Y = SY(y) + uy * rr, s = Math.max(5, 90 * sc);
  ctx.fillStyle = INK.pad;
  ctx.beginPath();
  ctx.moveTo(X + ux * s, Y + uy * s);
  ctx.lineTo(X - uy * s * 0.6, Y + ux * s * 0.6);
  ctx.lineTo(X + uy * s * 0.6, Y - ux * s * 0.6);
  ctx.closePath();
  ctx.fill();
}

function drawBits() {
  flat();
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = Math.max(1, 3 * (1 - k));
    disc(SX(r.x), SY(r.y), r.r * sc * ease(k));
    ctx.stroke();
  }
  for (const b of bits) {
    ctx.globalAlpha = 1 - b.life / b.max;
    ctx.fillStyle = b.colour;
    const s = Math.max(1.2, b.size * sc);
    ctx.fillRect(SX(b.x) - s / 2, SY(b.y) - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const k = p.life / p.max;
    ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    const s = k < 0.15 ? 0.6 + (0.4 * k) / 0.15 : 1;
    const X = SX(p.x), Y = SY(p.y) - ease(Math.min(1, k * 1.4)) * 22;
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(14,8,32,0.7)';
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
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left';
    if (rush(t)) { status += ' · rush hour'; colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text; }
  } else status = 'round ' + t.rd + ' · over';
  text('jetcab', 12, 22, titlePx, '#ffe066', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('jetcab').width;
  if (wide) fitText(status, 12, 44, 14, colour, colW - 24, 'left');
  else fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with their coins this
  // round and rounds won, and gold on the leader's coins. A row across the
  // top of a narrow frame, a column down the left of a wide one.
  const ids = bySeat(t);
  const lead = leaderOf(t);
  if (ids.length) {
    const gap = 6;
    const cw = wide ? Math.min(200, colW - 24) : Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = wide ? 12 : (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    let y = wide ? 76 : narrow ? 46 : 44;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.3)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      disc(x + 11, y - 2, 5);
      ctx.fillStyle = c;
      ctx.fill();
      if (d.fd >= 0) { disc(x + 11, y - 2, 2); ctx.fillStyle = d.fg ? INK.gold : '#ffffff'; ctx.fill(); }
      const score = String(d.rp);
      ctx.font = font(12);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 8, y + 3, 12, id === lead ? INK.gold : INK.text, 'right');
      const wins = t.ph !== WAIT && d.wn ? '★' + d.wn : '';
      ctx.font = font(10);
      const ww = wins ? ctx.measureText(wins).width + 5 : 0;
      if (wins && cw > 56) text(wins, x + cw - 12 - sw, y + 2, 10, '#eef1ff', 'right');
      if (cw > 64) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw - ww, 'left');
      if (wide) y += 22 + gap; else x += cw + gap;
    }
  }

  // The one line that says how to play: across the foot of a narrow frame, and
  // broken into lines at the foot of the right-hand column of a wide one.
  const how = coarse
    ? 'drag up to lift · drag sideways to steer · set down softly by a fare · fly them to their letter'
    : 'up, W or space lifts · left/right or A/D steer · set down softly by a fare · fly them to their letter · M mutes';
  if (!wide) { fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20); return; }
  const lines = wrap(how, 12, colW - 24);
  lines.forEach((s, i) => text(s, VW - 12, VH - 12 - (lines.length - 1 - i) * 17, 12, INK.muted, 'right'));
}

// Your tank and your fare while a round is on: in the strip under the canyon,
// or halfway down the right-hand column of a wide one.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = wide ? VH / 2 : Math.min(fieldBot + NOTE_ROOM / 2 - 8, VH - BOT - 22);
  const mid = wide ? VW - colW / 2 : VW / 2, room_ = wide ? colW - 24 : VW - 24;
  const bar = Math.min(90, room_ * 0.3);
  let say;
  if (d.st === 2) say = 'wrecked · a new cab is coming';
  else if (d.sp > 0) say = 'spinning!';
  else if (d.sf > SAFE) say = 'hanging · burn a jet to fly';
  else if (d.fd >= 0) say = 'fare to ' + LETTER[d.fd] + ' · pays ' + fareNow(d) + (rush(t) ? ' ×2' : '');
  else if (d.bf >= 0) say = 'climbing in…';
  else say = 'free · set down by a fare';
  ctx.font = font(12);
  const word = 'fuel';
  const kw = ctx.measureText(word).width;
  const sw = Math.min(room_ - kw - bar - 24, ctx.measureText(say).width);
  const total = kw + 6 + bar + 14 + sw;
  let x = mid - total / 2;
  const low = d.fu < FUEL / 5;
  text(word, x, y + 4, 12, low ? INK.danger : INK.dim, 'left');
  x += kw + 6;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(x, y - 4, bar, 8, 4);
  ctx.fill();
  ctx.fillStyle = low ? INK.danger : SEAT[d.c];
  roundRect(x, y - 4, Math.max(8, (bar * d.fu) / FUEL), 8, 4);
  ctx.fill();
  x += bar + 14;
  fitText(say, x, y + 4, 12, d.fd >= 0 ? (d.fg ? INK.gold : INK.pad) : INK.text, sw + 1, 'left');
  if (trails(t, myId())) fitText('behind: stronger jets · a coin more a fare', mid, y + 22, 11, INK.dim, room_);
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
  const cx = VW / 2, mid = (fieldTop + fieldBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'feather the jet to come down slowly · land beside a fare, then fly them to their letter';
    if (wide) practiceNote(now, VW, head, tip, [], VH - 8);
    else practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 380), 30);
    fitText('pick up fares · fly them to their pad · land softly', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 360));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('fly!', cx, mid + big * 0.5);
    text('fly!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && PLAY_STEPS - t.pt >= RUSH_AT && PLAY_STEPS - t.pt < RUSH_AT + 2 * HZ) {
    const k = (PLAY_STEPS - t.pt - RUSH_AT) / (2 * HZ);
    ctx.globalAlpha = 1 - k * k;
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * 1.3);
    ctx.textAlign = 'center';
    ctx.strokeText('rush hour · fares pay double', cx, mid);
    fitText('rush hour · fares pay double', cx, mid, big * 1.3, INK.gold, VW - 24);
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= 5 * HZ) {
    const n = Math.ceil(t.pt / HZ);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * 2);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big * 0.7);
    text(String(n), cx, mid + big * 0.7, big * 2, INK.gold, 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 340), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody came out on top';
    else head = t.win === me ? 'you rule the night shift!' : nickOf(t.win) + ' rules the night shift';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('fares', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('rams', cx + w / 2 - 62, y0 + 52, 10, INK.dim, 'right');
    text('coins', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, rp, fares, rams, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(fares), cx + w / 2 - 110, y, 13, '#eef1ff', 'right');
      text(String(rams), cx + w / 2 - 62, y, 13, '#eef1ff', 'right');
      text(String(rp), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a cab is as drawn: between two steps, and never slid across a jump —
// a fresh cab coming in at the top, or one put in line for a new round.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 1500) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

// Your own cab is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a hand a step away from where
// the guess had it. So the cab drawn is pulled toward the guess a little every
// frame rather than put on it, and a guess far off — a table taken afresh, a
// new cab — puts it there at once. Only the drawing is smoothed: the canyon,
// and every rule in it, are untouched.
const PULL = 0.5;
let shown = null;        // [x, y] in units: where your cab is drawn

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 1500) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  fit();
  const b = agreedAt(now);
  drawBack(b ? b.to : null, now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the canyon…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a table this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t, now);
    else i++;
  }
  const me = myId();
  // Your own cab as the guess has it, while the guess has you at all.
  const m = mineAt(now);
  let mine = null, mx = 0, my = 0;
  if (t.p[me]) {
    const own = m && m.to.p[me] ? m : b;
    const p = bodyAt(own, me);
    [mx, my] = settle(p[0], p[1]);
    mine = p[2];
    if (mine.st !== 2 && mine.sp === 0 && mine.fu > 0 && (mine.ju || mine.jx)) sound.jet(mine.ju === 1);
  } else {
    shown = null;
  }
  drawCanyon(t, now, mine && mine.fd >= 0 ? mine.fd : -1);
  flat();
  const before = new Map(b.from.f.map((f) => [f[0], f]));
  const claimed = new Set(playersIn(t).map((id) => t.p[id].bf));
  for (const f of t.f) {
    if (f[1] === 0) { drawWaiting(f, t, now, claimed.has(f[0])); continue; }
    const a = before.get(f[0]);
    const x = a && a[1] === 1 ? lerp(a[2], f[2], b.k) : f[2], y = a && a[1] === 1 ? lerp(a[3], f[3], b.k) : f[3];
    drawChute(f, x, y, now);
  }
  for (const id of bySeat(t)) {
    if (id === me) continue;
    const p = bodyAt(b, id);
    if (p[2].st === 2) drawWreck(SX(p[0]), SY(p[1]), p[2], now);
    else drawCab(id, SX(p[0]), SY(p[1]), p[2], SEAT[p[2].c], false, now);
  }
  if (mine) {
    if (mine.st === 2) drawWreck(SX(mx), SY(my), mine, now);
    else { drawCab(me, SX(mx), SY(my), mine, SEAT[mine.c], true, now); drawPointer(t, mx, my, mine, now); }
  }
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: which side jet burns and whether the one underneath
// does, as one number. It goes out when it changes, no oftener than
// STEER_EVERY for a thumb, because a thumb changes it on every move the
// screen reports and the clock's ticks share the same seat's ceiling on
// messages; a key goes out at once.
const STEER_EVERY = 60;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const LEFT = ['ArrowLeft', 'KeyA'], RIGHT = ['ArrowRight', 'KeyD'], LIFT = ['ArrowUp', 'KeyW', 'Space', 'KeyK'];
const ALL = [...LEFT, ...RIGHT, ...LIFT, 'ArrowDown', 'KeyS'];

// A thumb or a mouse: a stick from wherever it lands. Dragged up past a
// little dead ring it burns the jet underneath, dragged to a side it burns
// that side's jet — a drag rather than a press, because iOS keeps a long
// press inside a frame for itself.
const DEAD = 14;
const REACH = 46;
let stick = null;        // { id, ox, oy, dx, dy }

function handNow() {
  let jx = 0, ju = 0;
  if (stick) {
    if (stick.dx > DEAD) jx = 1; else if (stick.dx < -DEAD) jx = -1;
    if (stick.dy < -DEAD * 0.7) ju = 1;
  }
  const kx = (RIGHT.some((c) => keys.has(c)) ? 1 : 0) - (LEFT.some((c) => keys.has(c)) ? 1 : 0);
  if (kx) jx = kx;
  if (LIFT.some((c) => keys.has(c))) ju = 1;
  return jx + 1 + 3 * ju;
}

function sayHand(now, force) {
  const h = handNow();
  if (h === lastSaid) return;
  if (!force && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (!ALL.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
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
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (stick) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
  paintStick();
});
cv.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.id) return;
  stick.dx = e.clientX - stick.ox;
  stick.dy = e.clientY - stick.oy;
  paintStick();
  sayHand(performance.now(), false);
});
function liftPointer(e) {
  if (!stick || e.pointerId !== stick.id) return;
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', liftPointer);
addEventListener('pointerup', liftPointer);
addEventListener('pointercancel', liftPointer);

const stickRing = document.createElement('div');
stickRing.style.cssText =
  `position:fixed;display:none;width:${REACH * 2}px;height:${REACH * 2}px;` +
  `margin:${-REACH}px 0 0 ${-REACH}px;border-radius:50%;pointer-events:none;` +
  'border:1px solid rgba(255,255,255,0.35);background:rgba(255,255,255,0.06)';
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  'border-radius:50%;pointer-events:none;background:#ffffff;opacity:.55';
document.body.append(stickRing, knob);

function paintStick() {
  if (!stick || !coarse) { stickRing.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(stick.dx, stick.dy);
  const k = far > REACH ? REACH / far : 1;
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

// Called by the kernel once it stands. Hanging with no jets is a hand too: it
// is how a player arrives in the canyon.
function start() {
  lastSaid = 1;
  setHand(1);
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
