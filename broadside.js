/**
 * @disk     broadside
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Sailing ships whose guns only fire sideways. Sail across the wind for speed, turn side-on to a rival and let both broadsides go. Fish treasure out of the sea, sink a ship to spill its gold, and outrun the squall. Most gold at the horn wins.
 * @tags     game, party, realtime, naval, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/broadside.png
 */
// broadside.js — a bay of sailing ships where the room's order is the referee.
//
// Every copy holds the wind, every island, every ship, every cannonball in the
// air and every chest afloat, and changes them only on what comes back round
// the room, so every copy applies the same hands in the same order and holds
// the same bay. Nobody sends where they are, whom they hit or what they
// picked up: a hand is a way to turn, a way to aim the bow, whether the sails
// are reefed, and a counter that moves on by one for every volley asked for;
// everything else is the same arithmetic on every machine. A page with a
// console open can sail its own ship however it likes, at that ship's own
// speed, and fire no oftener than its guns reload.
//
// While a player is alone, a bot sails with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own ship does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.abs`, `Math.min`,
// `Math.max` and `Math.imul` are fixed by the language to the last bit;
// `Math.sin`, `Math.cos` and `**` are not, so a ship turns by a short series
// instead, and every square is a product.

// A heading turned by a small angle `a`, kept a unit vector. Turns in one step
// are well under half a radian, where the series is exact to far below what a
// ship's heading cares about.
function turned(hx, hy, a) {
  const a2 = a * a;
  const c = 1 - (a2 / 2) * (1 - a2 / 12);
  const s = a * (1 - (a2 / 6) * (1 - a2 / 20));
  const x = hx * c - hy * s, y = hx * s + hy * c;
  const l = Math.sqrt(x * x + y * y);
  return [x / l, y / l];
}

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sq = (v) => v * v;
function unit(x, y) {
  const l = Math.sqrt(x * x + y * y);
  return l > 1e-9 ? [x / l, y / l] : [1, 0];
}

// Sixteen ways round the compass, the same numbers on every machine.
const WDIR = [[1, 0], [0.9239, 0.3827], [0.7071, 0.7071], [0.3827, 0.9239], [0, 1], [-0.3827, 0.9239],
  [-0.7071, 0.7071], [-0.9239, 0.3827], [-1, 0], [-0.9239, -0.3827], [-0.7071, -0.7071], [-0.3827, -0.9239],
  [0, -1], [0.3827, -0.9239], [0.7071, -0.7071], [0.9239, -0.3827]];

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own ship a trip ahead, with your hand in it
const DT = 1 / HZ;

// The bay is 1.6 by 1.2, the frame's own shape; speeds are bay units a second.
const FW = 1.6, FH = 1.2;
const HL = 0.046, HB = 0.017;  // half a hull's length and half its beam
const SR = 0.021, SO = 0.024;  // a hull against anything solid: two circles, at bow and stern
const VMAX = 0.25;             // a ship at its best point of sail
const TURN = 1.8;              // radians a second at the helm's hardest, with way on
const REEF_V = 0.45;           // reefed sails: this share of the speed,
const REEF_TURN = 1.55;        // and this much more turn
const BALL_V = 0.66;           // a cannonball off the side, before the ship's own way
const BALL_LIFE = 12;          // steps until a ball drops into the sea
const BR = 0.007;              // a ball's radius
const BALLS_MAX = 120;
const RELOAD = 36;             // steps between two broadsides
const RELOAD_LOW = 24;         // and for the poorest ship, when somebody is richer
const HP = 4, HP_MAX = 5;      // planks a hull takes; whoever has won fewest rounds gets one more
const SHIELD = 40;             // steps a ship back afloat can neither be hit nor ram
const BACK_STEPS = 50;         // steps from a sinking to sailing again
const CHEST_V = 3;             // gold in a chest
const CHEST_EVERY = 50;        // steps between two chances of a chest
const CHEST_LIFE = 30 * HZ;
const COIN_LIFE = 15 * HZ;     // gold spilled from a wreck floats this long
const CHESTS_MAX = 40;
const GRAB = 0.05;             // how near a ship's middle a chest has to come
const BOUNTY = 2;              // gold for sinking a ship,
const LEADER_BOUNTY = 3;       // and more for sinking the richest
const LEAD_FROM = 4;           // the richest counts as the leader from this much gold
const GOLD_MAX = 99999;
const ISLES = 4;
const HURT_GAP = 30;           // steps between two planks lost to a rock or the squall
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 100 * HZ;
const END_STEPS = 7 * HZ;
const SQ_AT = 55 * HZ;         // steps into a round when the squall starts to close
const SQ_EVERY = 7 * HZ;       // steps between two bands of it
const SQ_MAX = 4;
const SQ_X = 0.09, SQ_Y = 0.0675;
const RUSH_AT = 80 * HZ;       // steps into a round when chests start coming up doubled
const WIND_EVERY = 8 * HZ;     // steps between two changes in how the wind veers
const WIND_TURN = 0.0035;      // the most it veers in a step

const SAIL = 0, GONE = 1;

// How fast a ship sails against how it lies to the wind: `c` is the bow's
// cosine with where the wind blows, -1 straight into it, 1 straight before it.
// Into the wind a ship is in irons and barely moves; across it is fastest.
const POLAR_C = [-1, -0.72, -0.5, 0, 0.5, 1];
const POLAR_V = [0.14, 0.17, 0.62, 1, 0.9, 0.72];
const IRONS = -0.72;
function polar(c) {
  if (c <= POLAR_C[0]) return POLAR_V[0];
  for (let i = 1; i < POLAR_C.length; i++) {
    if (c <= POLAR_C[i]) {
      const k = (c - POLAR_C[i - 1]) / (POLAR_C[i] - POLAR_C[i - 1]);
      return POLAR_V[i - 1] + (POLAR_V[i] - POLAR_V[i - 1]) * k;
    }
  }
  return POLAR_V[POLAR_V.length - 1];
}

const RANGE = BALL_V * BALL_LIFE * DT;
const inZone = (th, x, y) => th === 0 || (x >= th * SQ_X && x <= FW - th * SQ_X && y >= th * SQ_Y && y <= FH - th * SQ_Y);

// Where each seat starts a round, as shares of the bay: corners first, so two
// players start as far apart as the bay allows.
const SPOT = [[0.14, 0.18], [0.86, 0.82], [0.86, 0.18], [0.14, 0.82], [0.5, 0.11], [0.5, 0.89], [0.08, 0.5], [0.92, 0.5]];
const spotOf = (s) => [SPOT[s][0] * FW, SPOT[s][1] * FH];

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   th: bands of the squall closed in; wx, wy: where the wind blows, a unit
//   vector; wr: how far it veers a step; is: the islands, [x, y, radius]; bl:
//   cannonballs in the air, [x, y, vx, vy, steps left, who fired]; ch: gold
//   afloat, [x, y, gold, 0 a chest or 1 a coin, steps left]; res: the last
//   round's [id, gold, ships sunk, rounds won] rows; win: its winner
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, th: 0, wx: 1, wy: 0, wr: 0, is: [], bl: [], ch: [], p: {}, res: null, win: -1 };
  lay(w);
  return w;
}

// A fresh bay: islands where nobody starts, nothing afloat, a new wind.
function lay(w) {
  w.th = 0;
  w.bl = [];
  w.ch = [];
  w.is = [];
  for (let tries = 0; tries < 300 && w.is.length < ISLES; tries++) {
    const r = 0.05 + draw01(w) * 0.035;
    const x = 0.2 * FW + draw01(w) * 0.6 * FW, y = 0.2 * FH + draw01(w) * 0.6 * FH;
    if (SPOT.some(([a, b]) => sq(a * FW - x) + sq(b * FH - y) < sq(r + 0.16))) continue;
    if (w.is.some(([a, b, c]) => sq(a - x) + sq(b - y) < sq(r + c + 0.14))) continue;
    w.is.push([x, y, r]);
  }
  const k = Math.floor(draw01(w) * WDIR.length);
  const [ux, uy] = unit(WDIR[k][0], WDIR[k][1]);
  w.wx = ux;
  w.wy = uy;
  w.wr = 0;
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'hx', 'hy', 'v', 'kx', 'ky', 'tu', 'ax', 'ay', 'rf', 'q', 'hq', 'cd',
  'hp', 'mh', 'sh', 'rt', 'g', 'sk', 'wn', 'dc', 'bc', 'bt', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; st: sailing or sunk; x, y: where; hx, hy: the way the
//   bow points, a unit vector; v: speed through the water; kx, ky: a knock
//   being worked off, units a step; tu, ax, ay, rf: the hand's helm, the way it
//   aims the bow, a thousand at full, and whether it reefs; q: the volley
//   counter as last heard; hq: a volley to fire this step; cd: steps until the
//   guns are loaded; hp, mh: planks left and planks this round; sh: steps of
//   shield left; rt: steps until a sunk ship sails again; g: gold this round;
//   sk: ships sunk this round; wn: rounds won; dc: steps until a rock or the
//   squall can cost a plank again; bc: steps until a bump sounds again; bt, bw:
//   the bot's way and its pause; hs, hc: hands this step.
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
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: GONE, x: FW / 2, y: FH / 2, hx: 1, hy: 0, v: 0, kx: 0, ky: 0,
    tu: 0, ax: 0, ay: 0, rf: 0, q, hq: 0, cd: 0, hp: HP, mh: HP, sh: 0, rt: BACK_STEPS, g: 0, sk: 0, wn: 0,
    dc: 0, bc: 0, bt: -1, bw: 0, hs: w.n, hc: 0,
  });
}

// A ship put on the water, still, its guns loaded and its hull whole.
function place(d, x, y, hx, hy) {
  d.st = SAIL;
  d.x = x;
  d.y = y;
  d.hx = hx;
  d.hy = hy;
  d.v = d.kx = d.ky = d.cd = d.sh = d.rt = d.hq = d.dc = d.bc = d.bw = 0;
  d.hp = d.mh;
  d.bt = -1;
}

function placeAtSpot(d) {
  const [x, y] = spotOf(d.s);
  const [hx, hy] = unit(FW / 2 - x, FH / 2 - y);
  place(d, x, y, hx, hy);
}

// Back afloat after a sinking: the best of a few spots inside the squall,
// clear of the islands and as far from every other ship as they come, across
// the wind so the ship has way at once, and shielded for a moment so nobody
// can wait on a spot.
function respawn(w, id) {
  const d = w.p[id];
  const mx = w.th * SQ_X + 0.08, my = w.th * SQ_Y + 0.08;
  let best = null, score = -Infinity;
  for (let k = 0; k < 16; k++) {
    const x = mx + draw01(w) * Math.max(0.01, FW - 2 * mx), y = my + draw01(w) * Math.max(0.01, FH - 2 * my);
    if (w.is.some(([a, b, r]) => sq(a - x) + sq(b - y) < sq(r + 0.08))) continue;
    let near = 9;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o === id || e.st !== SAIL) continue;
      near = Math.min(near, Math.sqrt(sq(e.x - x) + sq(e.y - y)));
    }
    if (near > score) { score = near; best = [x, y]; }
  }
  if (!best) best = spotOf(d.s);
  let hx = -w.wy, hy = w.wx;
  if (hx * (FW / 2 - best[0]) + hy * (FH / 2 - best[1]) < 0) { hx = -hx; hy = -hy; }
  place(d, best[0], best[1], hx, hy);
  d.sh = SHIELD;
  fx(w, 'back', d.x, d.y, 0, id);
}

// A hand, at its place in the room's order: [the helm, -1 port to 1
// starboard; the way to aim the bow, across and down, a thousand at full, or
// none; 1 to reef; the volley counter]. A volley is asked for once, when the
// counter changes; the same hand said again to keep a player at the table
// fires nothing. Being heard is how a player arrives: on the water at once
// while the table waits for a round or counts one in, and a moment later
// while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[4]);
    if (w.ph === WAIT) respawn(w, id);
    else if (w.ph === COUNT) placeAtSpot(d);
    d.tu = input[0];
    d.ax = input[1];
    d.ay = input[2];
    d.rf = input[3];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; when the guns are loaded is the table's to say.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.tu = input[0];
  d.ax = input[1];
  d.ay = input[2];
  d.rf = input[3];
  if (input[4] !== d.q) { d.q = input[4]; d.hq = 1; }
}

// A hand off the wire, made safe: five integers in their ranges, or nothing.
// How fast a ship sails or turns is the ship's business: an aim names a way,
// never a speed, and nothing a hand says turns a hull faster than its helm.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  const [tu, ax, ay, rf, q] = raw;
  if (![tu, ax, ay, rf, q].every(Number.isInteger)) return null;
  if (tu < -1 || tu > 1 || ax < -1000 || ax > 1000 || ay < -1000 || ay > 1000 || rf < 0 || rf > 1 || q < 0 || q > 999) return null;
  return [tu, ax, ay, rf, q];
}

function leave(w, id) {
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions
const BOT_IDLE = 0.07;         // how often it holds its course a moment rather than decide
const BOT_FIRE = 0.5;          // how often it fires when a rival lies abeam
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot sails while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    respawn(w, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// How bad a way looks a little ahead: the bay's edge, the squall, an island.
function hazard(w, x, y, ux, uy) {
  let s = 0;
  for (let n = 1; n <= 3; n++) {
    const px = x + ux * 0.09 * n, py = y + uy * 0.09 * n, k = 4 - n;
    if (px < 0.05 || px > FW - 0.05 || py < 0.05 || py > FH - 0.05) s += k * 6;
    else if (!inZone(w.th, px, py)) s += k * 4;
    for (const [a, b, r] of w.is) if (sq(a - px) + sq(b - py) < sq(r + 0.05)) s += k * 7;
  }
  return s;
}

function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== SAIL) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 4 + Math.floor(draw01(w) * 8); return; }
  let foe = null, far = Infinity;
  for (const o of humans(w)) {
    const e = w.p[o];
    if (e.st !== SAIL) continue;
    const f = Math.sqrt(sq(e.x - d.x) + sq(e.y - d.y));
    if (f < far) { far = f; foe = e; }
  }
  let gx, gy;
  if (foe && far < 0.75 && far > 1e-6 && foe.sh === 0) {
    // A rival near: close in at an angle, then lie side-on to it.
    const ux = (foe.x - d.x) / far, uy = (foe.y - d.y) / far;
    let px = -uy, py = ux;
    if (px * d.hx + py * d.hy < 0) { px = -px; py = -py; }
    const toward = far > 0.3 ? 1.4 : 0.2;
    gx = px + ux * toward;
    gy = py + uy * toward;
    if (d.cd === 0 && far < RANGE * 0.9 && Math.abs(ux * d.hx + uy * d.hy) < 0.5 && draw01(w) < BOT_FIRE) d.hq = 1;
  } else {
    let best = null, bd = Infinity;
    for (const c of w.ch) {
      const f = sq(c[0] - d.x) + sq(c[1] - d.y);
      if (f < bd) { bd = f; best = c; }
    }
    gx = (best ? best[0] : FW / 2) - d.x;
    gy = (best ? best[1] : FH / 2) - d.y;
  }
  const [ex, ey] = unit(gx, gy);
  let pick = 0, score = -Infinity;
  for (let k = 0; k < WDIR.length; k++) {
    const [ux, uy] = WDIR[k];
    // What a way makes good toward the goal, its speed included: straight
    // into the wind makes nothing, so the bot tacks like a sailor would.
    const c = ux * w.wx + uy * w.wy, sp = polar(c);
    let s = (ux * ex + uy * ey) * sp * 14 + sp * 2 + (k === d.bt ? 3 : 0) + draw01(w) * 0.8 - (c < IRONS + 0.1 ? 6 : 0);
    s -= hazard(w, d.x, d.y, ux, uy);
    if (s > score) { score = s; pick = k; }
  }
  d.bt = pick;
  d.tu = 0;
  d.ax = Math.round(WDIR[pick][0] * 1000);
  d.ay = Math.round(WDIR[pick][1] * 1000);
  d.rf = 0;
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
    d.mh = HP;
    d.g = d.sk = 0;
    placeAtSpot(d);
  }
}

// A round: a fresh bay, the seats closed up in order, everybody at a spot of
// their own. Whoever has won the fewest rounds, when somebody has won more,
// sails a hull with a plank to spare.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  lay(w);
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) { lo = Math.min(lo, w.p[id].wn); hi = Math.max(hi, w.p[id].wn); }
  for (const id of ids) {
    const d = w.p[id];
    d.mh = hi > lo && d.wn === lo ? HP_MAX : HP;
    d.g = d.sk = 0;
    placeAtSpot(d);
  }
  fx(w, 'round', 0, 0, 0);
}

// The horn: the round to the most gold, if nobody matches it.
function finish(w) {
  const ids = bySeat(w);
  let top = 0;
  for (const id of ids) top = Math.max(top, w.p[id].g);
  const best = ids.filter((id) => w.p[id].g === top);
  w.win = best.length === 1 && ids.length > 1 && top > 0 ? best[0] : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, w.p[id].g, w.p[id].sk, w.p[id].wn]);
  res.sort((a, b) => b[1] - a[1] || b[2] - a[2] || b[3] - a[3] || a[0] - b[0]);
  w.res = res;
  w.bl = [];
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
  // Nobody moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      d.hq = 0;
      d.v = d.kx = d.ky = 0;
    }
    return;
  }
  sail(w);
}

function sail(w) {
  botThink(w);
  wind(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== GONE) continue;
    d.hq = 0;
    if (d.rt > 1) d.rt -= 1;
    else respawn(w, id);
  }
  for (const id of ids) if (w.p[id].st === SAIL) control(w, w.p[id], id);
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== SAIL) continue;
    d.x += d.hx * d.v * DT + d.kx;
    d.y += d.hy * d.v * DT + d.ky;
    d.kx = clamp(d.kx * 0.8, -0.05, 0.05);
    d.ky = clamp(d.ky * 0.8, -0.05, 0.05);
    if (Math.abs(d.kx) < 1e-5) d.kx = 0;
    if (Math.abs(d.ky) < 1e-5) d.ky = 0;
    edges(d);
    if (d.cd > 0) d.cd -= 1;
    if (d.sh > 0) d.sh -= 1;
    if (d.dc > 0) d.dc -= 1;
    if (d.bc > 0) d.bc -= 1;
  }
  ships(w, ids);
  isles(w, ids);
  balls(w, ids);
  if (w.ph === PLAY) squall(w);
  storm(w, ids);
  treasure(w, ids);
}

// The wind veers on its own, a little every step, and every few seconds it
// picks a new way and pace to veer by.
function wind(w) {
  if (w.n % WIND_EVERY === 0) w.wr = (draw01(w) * 2 - 1) * WIND_TURN;
  const h = turned(w.wx, w.wy, w.wr);
  w.wx = h[0];
  w.wy = h[1];
}

// The helm: an aim turns the bow toward it, at the helm's pace; a helm with
// no aim turns it as held. A ship needs way on to answer the helm, so one
// standing still turns slowly. Then the sails: the speed a ship gathers,
// slowly, is set by how its bow lies to the wind, and reefing trades speed
// for a tighter turn. A volley asked for goes off if the guns are loaded.
function control(w, d, id) {
  let steer = d.tu;
  if (d.ax !== 0 || d.ay !== 0) {
    const al = Math.sqrt(d.ax * d.ax + d.ay * d.ay), ux = d.ax / al, uy = d.ay / al;
    const cross = d.hx * uy - d.hy * ux, dot = d.hx * ux + d.hy * uy;
    steer = dot > 0 ? clamp(cross * 3, -1, 1) : cross >= 0 ? 1 : -1;
  }
  const reef = d.rf === 1;
  if (steer !== 0) {
    const way = clamp(d.v / (0.5 * VMAX), 0, 1);
    const h = turned(d.hx, d.hy, TURN * DT * steer * (0.6 + 0.4 * way) * (reef ? REEF_TURN : 1));
    d.hx = h[0];
    d.hy = h[1];
  }
  const target = VMAX * polar(d.hx * w.wx + d.hy * w.wy) * (reef ? REEF_V : 1);
  d.v += (target - d.v) * (target > d.v ? 0.05 : 0.1);
  if (d.hq) {
    d.hq = 0;
    if (d.cd === 0) fire(w, d, id);
  }
}

// The poorest ship reloads faster, once somebody has more gold than it.
function reloadOf(w, id) {
  const d = w.p[id];
  let poorest = true, richer = false;
  for (const o of playersIn(w)) {
    if (o === id) continue;
    if (w.p[o].g < d.g) poorest = false;
    if (w.p[o].g > d.g) richer = true;
  }
  return poorest && richer ? RELOAD_LOW : RELOAD;
}

// Both broadsides at once: three balls off each side, square to the hull,
// carrying half the ship's own way with them.
function fire(w, d, id) {
  const nx = -d.hy, ny = d.hx;
  for (const side of [1, -1]) {
    for (const k of [-1, 0, 1]) {
      if (w.bl.length >= BALLS_MAX) break;
      const along = k * 0.026, out = side * (HB + 0.006);
      const x = d.x + d.hx * along + nx * out, y = d.y + d.hy * along + ny * out;
      const fwd = d.v * 0.5 + k * 0.05;
      w.bl.push([x, y, (d.hx * fwd + nx * side * BALL_V) * DT, (d.hy * fwd + ny * side * BALL_V) * DT, BALL_LIFE, id]);
    }
  }
  d.cd = reloadOf(w, id);
  fx(w, 'fire', d.x, d.y, 0, id);
}

// The bay's edge is a reef: a ship stops at it, and loses its way while its
// bow points into it.
function edges(d) {
  if (d.x < HL) { d.x = HL; d.kx = 0; if (d.hx < 0) d.v *= 0.9; }
  if (d.x > FW - HL) { d.x = FW - HL; d.kx = 0; if (d.hx > 0) d.v *= 0.9; }
  if (d.y < HL) { d.y = HL; d.ky = 0; if (d.hy < 0) d.v *= 0.9; }
  if (d.y > FH - HL) { d.y = FH - HL; d.ky = 0; if (d.hy > 0) d.v *= 0.9; }
}

// Two hulls that touch push apart and both lose way. A ship back afloat
// passes through the others until its shield is gone.
function ships(w, ids) {
  for (let a = 0; a < ids.length; a++) {
    const p = w.p[ids[a]];
    if (p.st !== SAIL || p.sh > 0) continue;
    for (let b = a + 1; b < ids.length; b++) {
      const o = w.p[ids[b]];
      if (o.st !== SAIL || o.sh > 0) continue;
      for (const ka of [-1, 1]) {
        for (const kb of [-1, 1]) {
          const ax = p.x + p.hx * SO * ka, ay = p.y + p.hy * SO * ka;
          const bx = o.x + o.hx * SO * kb, by = o.y + o.hy * SO * kb;
          let dx = bx - ax, dy = by - ay;
          const d2 = dx * dx + dy * dy;
          if (d2 >= 4 * SR * SR) continue;
          let far = Math.sqrt(d2);
          if (far < 1e-9) { dx = 1; dy = 0; far = 1; }
          const ux = dx / far, uy = dy / far, push = (2 * SR - far) / 2 + 1e-4;
          p.x -= ux * push; p.y -= uy * push;
          o.x += ux * push; o.y += uy * push;
          p.kx -= ux * 0.004; p.ky -= uy * 0.004;
          o.kx += ux * 0.004; o.ky += uy * 0.004;
          p.v *= 0.9;
          o.v *= 0.9;
          if (p.bc === 0 && o.bc === 0) {
            p.bc = o.bc = 10;
            fx(w, 'bump', (ax + bx) / 2, (ay + by) / 2, 0, ids[a], ids[b]);
          }
        }
      }
      edges(p);
      edges(o);
    }
  }
}

// An island does not move. A hull that runs into one is pushed off and loses
// its way, and one that hits it at speed loses a plank.
function hurt(w, id, by, kind, x, y) {
  const d = w.p[id];
  d.hp -= 1;
  fx(w, kind, x, y, d.hp, id, by);
  if (d.hp <= 0) sink(w, by, id);
}

function isles(w, ids) {
  for (const id of ids) {
    const d = w.p[id];
    for (const [ix, iy, ir] of w.is) {
      for (const k of [-1, 1]) {
        if (d.st !== SAIL) break;
        const cx = d.x + d.hx * SO * k, cy = d.y + d.hy * SO * k;
        let dx = cx - ix, dy = cy - iy;
        const reach = ir + SR, d2 = dx * dx + dy * dy;
        if (d2 >= reach * reach) continue;
        let far = Math.sqrt(d2);
        if (far < 1e-9) { dx = 1; dy = 0; far = 1; }
        const ux = dx / far, uy = dy / far, push = reach - far;
        d.x += ux * push;
        d.y += uy * push;
        const hard = d.v > 0.55 * VMAX;
        d.v *= 0.4;
        d.kx += ux * 0.003;
        d.ky += uy * 0.003;
        edges(d);
        if (hard && d.dc === 0 && d.sh === 0) {
          d.dc = HURT_GAP;
          hurt(w, id, -1, 'rock', ix + ux * ir, iy + uy * ir);
        }
      }
    }
  }
}

// Cannonballs fly straight. One that meets a hull other than its own ship's
// costs that hull a plank and knocks it along; one that meets an island
// thuds into the sand; one that runs out drops into the sea.
function balls(w, ids) {
  const keep = [];
  for (const b of w.bl) {
    b[0] += b[2];
    b[1] += b[3];
    b[4] -= 1;
    let gone = b[0] < 0 || b[0] > FW || b[1] < 0 || b[1] > FH;
    if (!gone) {
      for (const [ix, iy, ir] of w.is) {
        if (sq(b[0] - ix) + sq(b[1] - iy) < ir * ir) { fx(w, 'thud', b[0], b[1]); gone = true; break; }
      }
    }
    if (!gone) {
      for (const id of ids) {
        const d = w.p[id];
        if (!d || id === b[5] || d.st !== SAIL || d.sh > 0) continue;
        const rx = b[0] - d.x, ry = b[1] - d.y;
        const along = rx * d.hx + ry * d.hy, side = ry * d.hx - rx * d.hy;
        if (sq(along / (HL + BR)) + sq(side / (HB + BR)) >= 1) continue;
        d.kx += b[2] * 0.12;
        d.ky += b[3] * 0.12;
        hurt(w, id, b[5], 'hit', b[0], b[1]);
        gone = true;
        break;
      }
    }
    if (!gone && b[4] <= 0) { fx(w, 'splash', b[0], b[1]); gone = true; }
    if (!gone) keep.push(b);
  }
  w.bl = keep;
}

// A ship out of planks goes down. Half its gold spills into the sea round the
// wreck for anybody to fish out, and whoever sank it is paid a bounty, a
// bigger one for the richest ship afloat.
function sink(w, by, vid) {
  const v = w.p[vid];
  let lead = v.g >= LEAD_FROM;
  for (const o of playersIn(w)) if (o !== vid && w.p[o].g >= v.g) lead = false;
  const spill = Math.floor(v.g / 2);
  v.g -= spill;
  scatter(w, v.x, v.y, spill);
  let bonus = 0;
  const s = by !== vid ? w.p[by] : undefined;
  if (s) {
    bonus = BOUNTY + (lead ? LEADER_BOUNTY : 0);
    s.g = Math.min(GOLD_MAX, s.g + bonus);
    s.sk += 1;
  }
  fx(w, 'sink', v.x, v.y, bonus, s ? by : -1, vid);
  v.st = GONE;
  v.rt = BACK_STEPS;
  v.v = v.kx = v.ky = v.hq = v.cd = v.sh = v.hp = 0;
}

// Gold spilled from a wreck: up to six coins in a ring round it.
const RING = [0, 3, 5, 8, 11, 13];
function scatter(w, x, y, gold) {
  const n = Math.min(RING.length, gold);
  if (n <= 0) return;
  const base = Math.floor(gold / n);
  let rest = gold - base * n;
  for (let k = 0; k < n; k++) {
    if (w.ch.length >= CHESTS_MAX) return;
    const [ux, uy] = WDIR[RING[k]];
    let cx = clamp(x + ux * 0.05, 0.03, FW - 0.03), cy = clamp(y + uy * 0.05, 0.03, FH - 0.03);
    if (w.is.some(([a, b, r]) => sq(a - cx) + sq(b - cy) < r * r)) { cx = x; cy = y; }
    w.ch.push([cx, cy, base + (rest > 0 ? 1 : 0), 1, COIN_LIFE]);
    if (rest > 0) rest -= 1;
  }
}

// Late in a round a squall closes in from the rim, band by band.
function squall(w) {
  const into = PLAY_STEPS - w.pt;
  if (into === SQ_AT - 2 * HZ) fx(w, 'warn', 0, 0, 0);
  if (into === RUSH_AT) fx(w, 'rush', 0, 0, 0);
  if (into < SQ_AT || (into - SQ_AT) % SQ_EVERY !== 0 || w.th >= SQ_MAX) return;
  w.th += 1;
  fx(w, 'squall', 0, 0, 0);
}

// A ship in the squall loses a plank every so often.
function storm(w, ids) {
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== SAIL || d.sh > 0 || d.dc > 0 || inZone(w.th, d.x, d.y)) continue;
    d.dc = HURT_GAP;
    hurt(w, id, -1, 'storm', d.x, d.y);
  }
}

// Gold afloat: it drifts nowhere, sinks when its time is up or the squall
// takes its water, and is fished out by the first hull over it. Chests come up
// every so often, more of them with more ships, and in the last stretch of a
// round they come up faster and worth double.
function treasure(w, ids) {
  w.ch = w.ch.filter((c) => { c[4] -= 1; return c[4] > 0 && inZone(w.th, c[0], c[1]); });
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== SAIL) continue;
    for (let i = w.ch.length - 1; i >= 0; i--) {
      const c = w.ch[i];
      if (sq(c[0] - d.x) + sq(c[1] - d.y) >= GRAB * GRAB) continue;
      d.g = Math.min(GOLD_MAX, d.g + c[2]);
      fx(w, c[3] ? 'coin' : 'chest', c[0], c[1], c[2], id);
      w.ch.splice(i, 1);
    }
  }
  const rush = w.ph === PLAY && PLAY_STEPS - w.pt >= RUSH_AT;
  if (w.n % (rush ? CHEST_EVERY / 2 : CHEST_EVERY) !== 0) return;
  const cap = 2 + Math.floor(ids.length / 2) + (rush ? 2 : 0);
  if (w.ch.filter((c) => c[3] === 0).length >= cap || w.ch.length >= CHESTS_MAX) return;
  const mx = w.th * SQ_X + 0.07, my = w.th * SQ_Y + 0.07;
  for (let tries = 0; tries < 20; tries++) {
    const x = mx + draw01(w) * Math.max(0.01, FW - 2 * mx), y = my + draw01(w) * Math.max(0.01, FH - 2 * my);
    if (w.is.some(([a, b, r]) => sq(a - x) + sq(b - y) < sq(r + 0.05))) continue;
    if (ids.some((id) => w.p[id].st === SAIL && sq(w.p[id].x - x) + sq(w.p[id].y - y) < sq(0.18))) continue;
    w.ch.push([x, y, rush ? 2 * CHEST_V : CHEST_V, 0, CHEST_LIFE]);
    fx(w, 'up', x, y, rush ? 1 : 0);
    return;
  }
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isUnit = (x, y) => num(x, -1.01, 1.01) && num(y, -1.01, 1.01) && Math.abs(x * x + y * y - 1) < 0.02;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.th, 0, SQ_MAX) || !isUnit(raw.wx, raw.wy) || !num(raw.wr, -WIND_TURN, WIND_TURN)) return null;
  if (!Array.isArray(raw.is) || raw.is.length > ISLES) return null;
  if (!raw.is.every((t) => Array.isArray(t) && t.length === 3 && num(t[0], 0, FW) && num(t[1], 0, FH) && num(t[2], 0.01, 0.2))) return null;
  if (!Array.isArray(raw.bl) || raw.bl.length > BALLS_MAX) return null;
  if (!raw.bl.every((b) => Array.isArray(b) && b.length === 6 && num(b[0], 0, FW) && num(b[1], 0, FH) &&
    num(b[2], -0.1, 0.1) && num(b[3], -0.1, 0.1) && int(b[4], 0, BALL_LIFE) && int(b[5], -BIG, BIG))) return null;
  if (!Array.isArray(raw.ch) || raw.ch.length > CHESTS_MAX) return null;
  if (!raw.ch.every((c) => Array.isArray(c) && c.length === 5 && num(c[0], 0, FW) && num(c[1], 0, FH) &&
    int(c[2], 1, GOLD_MAX) && int(c[3], 0, 1) && int(c[4], 0, CHEST_LIFE))) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, SAIL, GONE) || !num(d.x, 0, FW) || !num(d.y, 0, FH) || !isUnit(d.hx, d.hy)) return null;
    if (!num(d.v, 0, VMAX * 1.01) || !num(d.kx, -0.1, 0.1) || !num(d.ky, -0.1, 0.1)) return null;
    if (inputOf([d.tu, d.ax, d.ay, d.rf, d.q]) === null || !int(d.hq, 0, 1) || !int(d.cd, 0, RELOAD)) return null;
    if (!int(d.mh, HP, HP_MAX) || !int(d.hp, 0, d.mh) || !int(d.sh, 0, SHIELD) || !int(d.rt, 0, BACK_STEPS)) return null;
    if (!int(d.g, 0, GOLD_MAX) || !int(d.sk, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.dc, 0, HURT_GAP) || !int(d.bc, 0, 99) || !int(d.bt, -1, WDIR.length - 1) || !int(d.bw, 0, 99)) return null;
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
  if (!int(raw.win, -BIG, BIG)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, th: raw.th, wx: raw.wx, wy: raw.wy, wr: raw.wr,
    is: raw.is.map((t) => t.slice()), bl: raw.bl.map((b) => b.slice()), ch: raw.ch.map((c) => c.slice()),
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
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a tropical bay at dusk. Teal water darker in the deep, sandy
// islands ringed with shallows, wooden hulls, and every ship's sails in its
// player's bright colour; the squall is slate and rain.
const INK = {
  page: '#0b1d2c', glow: '#173b54', text: '#ffffff', muted: '#cfe3ee', dim: '#86a3b5', gold: '#ffd166',
  danger: '#ff5a6e', sea: '#1d6f86', seaDeep: '#145269', foam: '#e8f6ff', sand: '#ecd393', sandDark: '#c9a965',
  shallow: '#47c1bf', palm: '#2f9a5f', palmDark: '#21704a', wood: '#8f5d36', woodDark: '#5a381e', deck: '#b98450',
  storm: '#283048', bank: '#08141f', panel: 'rgba(10,22,34,0.93)',
};
const SEAT = ['#ff4f7b', '#3fa9ff', '#ffb020', '#9cff3a', '#e25cff', '#20e3ff', '#ff7a2e', '#ffffff'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #3e6a85;' +
  `background:#183a52;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, sc = 300, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340;
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

// The whole bay is always on screen, as large as it fits. NOTE_ROOM under it
// keeps the practice note off the bottom row, and in a round the same strip
// says how your hull stands and whether your guns are loaded.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  sc = Math.max(10, Math.min((VW - 16) / FW, ah / FH));
  ox = (VW - FW * sc) / 2;
  oy = TOP + (ah - FH * sc) / 2;
  fieldTop = oy;
  fieldBot = oy + FH * sc;
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
function puff(dur, vol, freq, delay, q, type) {
  if (!noise) {
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.9), actx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = actx.currentTime + (delay || 0);
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  src.buffer = noise;
  f.type = type || 'bandpass';
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
  boom(near, mine) {
    if (!ready('boom', 70)) return;
    const v = mine ? 1 : 0.25 + 0.6 * near;
    puff(0.5, 0.16 * v, 320, 0, 0.6, 'lowpass');
    tone(mine ? 95 : 80, 0.35, 'sine', 0.13 * v, 0.45);
    puff(0.3, 0.1 * v, 260, 0.07, 0.6, 'lowpass');
  },
  splash() { if (ready('splash', 90)) puff(0.2, 0.025, 2600, 0, 1.4); },
  thud() { if (ready('thud', 90)) { tone(120, 0.1, 'sine', 0.05, 0.6); puff(0.15, 0.03, 900, 0, 1); } },
  hit(mine) {
    if (!ready('hit', 60)) return;
    tone(170, 0.12, 'square', 0.05, 0.5);
    puff(0.18, 0.08, 1300, 0, 1.1);
    if (mine) tone(880, 0.08, 'triangle', 0.06, 1.2, 0.04);
  },
  hitMe() { if (ready('hitMe', 120)) { tone(120, 0.22, 'sawtooth', 0.07, 0.5); puff(0.3, 0.14, 900, 0, 0.9); } },
  sink(near, mine) {
    if (!ready('sink', 150)) return;
    puff(0.9, 0.06 + 0.1 * near, 500, 0, 0.5);
    tone(260, 0.9, 'triangle', 0.05 + 0.05 * near, 0.3);
    if (mine) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, 0.1 + i * 0.06));
  },
  sunk() { if (ready('sunk', 300)) { puff(1.0, 0.16, 400, 0, 0.5); tone(330, 1.0, 'sawtooth', 0.05, 0.2); } },
  coin(big) {
    if (!ready('coin', 60)) return;
    tone(big ? 988 : 1319, 0.09, 'triangle', 0.07);
    tone(big ? 1319 : 1760, 0.14, 'triangle', 0.06, 0, 0.06);
    if (big) tone(1760, 0.18, 'triangle', 0.05, 0, 0.12);
  },
  loaded() { if (ready('loaded', 200)) { tone(1100, 0.04, 'square', 0.025); tone(1400, 0.05, 'square', 0.02, 0, 0.06); } },
  bump() { if (ready('bump', 120)) { tone(140, 0.12, 'sine', 0.06, 0.6); puff(0.12, 0.04, 700, 0, 1); } },
  thunder() { if (ready('thunder', 500)) { puff(1.1, 0.13, 140, 0, 0.4, 'lowpass'); puff(0.5, 0.08, 400, 0.05, 0.6); } },
  back() { if (ready('back', 200)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.05)); },
  warn() { if (ready('warn', 400)) [392, 370, 349].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.04, 1, i * 0.18)); },
  rush() { if (ready('rush', 400)) [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.12, 'triangle', 0.07, 0, i * 0.07)); },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(220, 0.6, 'sawtooth', 0.05, 1); tone(330, 0.6, 'sawtooth', 0.04, 1); tone(440, 0.3, 'sine', 0.06, 1, 0.2); } },
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

// ── bits: particles, pops, rings, foam, shake ──────────────────────────────
// Stepped on a clock of their own at a fixed rate, never once per frame, so a
// fast screen and a slow one see the same spray. Positions are bay units.
const bits = [];      // { x, y, vx, vy, vz, z, life, max, size, colour, drag }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
const foam = [];      // { x, y, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0, flash = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, up, drag) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: (up || 0) * (0.5 + Math.random()), z: 0, life: 0,
      max: 18 + Math.random() * 22, size, colour, drag: drag || 0.92 });
  }
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}
function smoke(x, y, vx, vy, size) {
  bits.push({ x, y, vx, vy, vz: 0, z: 0, life: 0, max: 40 + Math.random() * 30, size, colour: '#d9dde3', drag: 0.94, puff: true });
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 15 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let j = 0; j < n; j++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= b.drag; b.vy *= b.drag;
      if (!b.puff) {
        b.z += b.vz / BIT_HZ;
        b.vz -= 1.8 / BIT_HZ;
        if (b.z < 0) { b.z = 0; b.vz = 0; b.life = Math.max(b.life, b.max - 4); }
      }
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = foam.length - 1; i >= 0; i--) if (++foam[i].life >= foam[i].max) foam.splice(i, 1);
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    shake *= 0.85;
    if (shake < 0.2) shake = 0;
    flash *= 0.9;
    if (flash < 0.01) flash = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();      // id -> { hit, wake, seen, tilt }
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const lookOf = (id, now) => {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { hit: 0, wake: 0, seen: now, smoke: 0 }));
  return look;
};

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = md && md.st === SAIL ? Math.max(0, 1 - Math.sqrt(sq(md.x - e.x) + sq(md.y - e.y)) / 0.9) : 0.4;
  if (e.kind === 'fire') {
    const d = t.p[e.a];
    if (d) {
      const nx = -d.hy, ny = d.hx;
      for (const side of [1, -1]) {
        for (const k of [-1, 0, 1]) {
          const x = d.x + d.hx * k * 0.026 + nx * side * (HB + 0.008), y = d.y + d.hy * k * 0.026 + ny * side * (HB + 0.008);
          for (let i = 0; i < 2; i++) smoke(x, y, nx * side * (0.06 + Math.random() * 0.08), ny * side * (0.06 + Math.random() * 0.08), 0.008 + Math.random() * 0.006);
          spray(x, y, 2, '#ffd27a', 0.1, 0.004, 0, 0.8);
        }
      }
      lookOf(e.a, performance.now()).tilt = 1;
    }
    if (e.a === me) shake = Math.max(shake, 4);
    else sound.boom(near, false);
  } else if (e.kind === 'splash') {
    spray(e.x, e.y, 6, INK.foam, 0.08, 0.004, 0.12);
    ring(e.x, e.y, 'rgba(232,246,255,0.8)', 0.03);
    if (near > 0.5) sound.splash();
  } else if (e.kind === 'thud') {
    spray(e.x, e.y, 8, INK.sandDark, 0.12, 0.005, 0.1);
    sound.thud();
  } else if (e.kind === 'hit' || e.kind === 'rock' || e.kind === 'storm') {
    if (e.kind !== 'storm') {
      spray(e.x, e.y, 12, INK.wood, 0.25, 0.005, 0.15);
      spray(e.x, e.y, 5, '#ffe2a0', 0.2, 0.004, 0.08, 0.85);
      ring(e.x, e.y, '#ffffff', 0.04);
    } else {
      flash = Math.max(flash, 0.6);
      sound.thunder();
    }
    lookOf(e.a, performance.now()).hit = 1;
    if (e.a === me) {
      shake = Math.max(shake, e.kind === 'hit' ? 10 : 7);
      sound.hitMe();
      if (e.kind === 'storm') pop(e.x, e.y, 'the squall!', INK.danger, 15);
    } else {
      if (e.b === me) pop(e.x, e.y, 'hit!', colourOf(t, me), 16);
      if (e.kind !== 'storm') sound.hit(e.b === me);
    }
  } else if (e.kind === 'sink') {
    spray(e.x, e.y, 26, INK.foam, 0.3, 0.007, 0.25);
    spray(e.x, e.y, 14, INK.wood, 0.25, 0.006, 0.12);
    spray(e.x, e.y, 6, colourOf(t, e.b), 0.2, 0.006, 0.1);
    ring(e.x, e.y, colourOf(t, e.b), 0.12);
    for (let i = 0; i < 5; i++) smoke(e.x, e.y, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, 0.014);
    const s = t.p[e.a];
    if (s && e.z > 0) pop(s.x, s.y - HL, '+' + e.z, INK.gold, e.a === me ? 19 : 15);
    if (e.b === me) { pop(e.x, e.y, 'sunk!', INK.danger, 20); shake = Math.max(shake, 14); sound.sunk(); }
    else {
      if (e.a === me) shake = Math.max(shake, 7);
      sound.sink(near, e.a === me);
    }
    looks.delete(e.b);
  } else if (e.kind === 'chest' || e.kind === 'coin') {
    spray(e.x, e.y, e.kind === 'chest' ? 12 : 5, INK.gold, 0.18, 0.004, 0.12, 0.85);
    pop(e.x, e.y, '+' + e.z, INK.gold, e.a === me ? 17 : 13);
    if (e.a === me || near > 0.6) sound.coin(e.kind === 'chest');
  } else if (e.kind === 'up') {
    ring(e.x, e.y, e.z ? INK.gold : 'rgba(232,246,255,0.8)', 0.05);
    spray(e.x, e.y, 6, INK.foam, 0.08, 0.004, 0.12);
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 6, INK.foam, 0.12, 0.004, 0.1);
    if (e.a === me || e.b === me) { shake = Math.max(shake, 5); sound.bump(); }
  } else if (e.kind === 'back') {
    ring(e.x, e.y, colourOf(t, e.a), 0.09);
    if (e.a === me) { pop(e.x, e.y, 'back afloat!', INK.text, 15); sound.back(); }
  } else if (e.kind === 'warn') {
    pop(FW / 2, FH / 2, 'a squall is coming!', INK.gold, 22);
    sound.warn();
  } else if (e.kind === 'squall') {
    shake = Math.max(shake, 4);
    flash = Math.max(flash, 0.45);
    sound.thunder();
  } else if (e.kind === 'rush') {
    pop(FW / 2, FH / 2, 'gold rush! chests are worth double', INK.gold, 20);
    sound.rush();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

function drawSky(now) {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.8);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
}

// The sea: deep in the middle, lighter toward the rim, and little crests that
// run the way the wind blows.
let crestX = 0, crestY = 0;
function drawSea(t, now) {
  flat();
  const x0 = SX(0), y0 = SY(0), w = FW * sc, h = FH * sc;
  ctx.fillStyle = 'rgba(3,8,16,0.45)';
  roundRect(x0 - 3, y0 + 3, w + 10, h + 8, 12);
  ctx.fill();
  ctx.fillStyle = INK.bank;
  roundRect(x0 - 5, y0 - 5, w + 10, h + 10, 12);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, w, h, 8);
  ctx.clip();
  const g = ctx.createRadialGradient(x0 + w / 2, y0 + h / 2, 10, x0 + w / 2, y0 + h / 2, Math.max(w, h) * 0.7);
  g.addColorStop(0, INK.seaDeep);
  g.addColorStop(1, INK.sea);
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, h);
  crestX = (crestX + t.wx * frameDt * 0.05 + 10) % 1;
  crestY = (crestY + t.wy * frameDt * 0.05 + 10) % 1;
  const a = Math.atan2(t.wy, t.wx);
  ctx.strokeStyle = 'rgba(220,245,255,0.16)';
  ctx.lineWidth = Math.max(1, sc * 0.004);
  ctx.beginPath();
  const cols = 9, rows = 7;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const fx_ = ((i + 0.5 + ((j * 0.37) % 1)) / cols + crestX) % 1, fy_ = ((j + 0.5 + ((i * 0.23) % 1)) / rows + crestY) % 1;
      const cx = x0 + fx_ * w, cy = y0 + fy_ * h, r = sc * 0.022;
      const bob = Math.sin(now / 600 + i * 1.3 + j * 0.7) * 0.25;
      ctx.moveTo(cx + Math.cos(a + 1.9) * r, cy + Math.sin(a + 1.9) * r);
      ctx.arc(cx, cy, r, a + 1.9, a + 1.9 + 1.4 + bob);
    }
  }
  ctx.stroke();
  // Foam the hulls leave behind.
  for (const f of foam) {
    const k = f.life / f.max;
    ctx.fillStyle = `rgba(232,246,255,${(0.35 * (1 - k)).toFixed(3)})`;
    disc(SX(f.x), SY(f.y), (f.r + k * f.r * 1.6) * sc);
    ctx.fill();
  }
  ctx.restore();
}

// The squall: slate water and slanting rain outside the bands still open, and
// the next band glowing for the two seconds before it closes.
function drawSquall(t, now) {
  flat();
  const x0 = SX(0), y0 = SY(0), w = FW * sc, h = FH * sc;
  const into = PLAY_STEPS - t.pt;
  const warnBand = t.ph === PLAY && t.th < SQ_MAX && into >= SQ_AT - 2 * HZ &&
    (into < SQ_AT ? SQ_AT - into : SQ_EVERY - ((into - SQ_AT) % SQ_EVERY)) <= 2 * HZ;
  if (!t.th && !warnBand) return;
  ctx.save();
  roundRect(x0, y0, w, h, 8);
  ctx.clip();
  const ix = t.th * SQ_X * sc, iy = t.th * SQ_Y * sc;
  if (t.th) {
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.rect(x0 + ix, y0 + iy, w - 2 * ix, h - 2 * iy);
    ctx.fillStyle = 'rgba(32,38,62,0.62)';
    ctx.fill('evenodd');
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.rect(x0 + ix, y0 + iy, w - 2 * ix, h - 2 * iy);
    ctx.clip('evenodd');
    ctx.strokeStyle = 'rgba(190,210,235,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const slant = t.wx * 0.5;
    for (let i = 0; i < 70; i++) {
      const rx = x0 + (((i * 73.1) % 100) / 100) * w, ry = y0 + ((((i * 37.7) % 100) / 100) * h + now / 3) % h;
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx + slant * 10, ry + 10);
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(200,215,240,0.55)';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + ix, y0 + iy, w - 2 * ix, h - 2 * iy);
    ctx.setLineDash([]);
  }
  if (warnBand) {
    const nx = (t.th + 1) * SQ_X * sc, ny = (t.th + 1) * SQ_Y * sc;
    ctx.beginPath();
    ctx.rect(x0 + ix, y0 + iy, w - 2 * ix, h - 2 * iy);
    ctx.rect(x0 + nx, y0 + ny, w - 2 * nx, h - 2 * ny);
    ctx.fillStyle = `rgba(255,150,80,${(0.18 + 0.14 * Math.sin(now / 110)).toFixed(3)})`;
    ctx.fill('evenodd');
  }
  ctx.restore();
}

// An island: shallows round it, a sandy body that is a little lumpy, a rock or
// two and a palm.
function drawIsle(ix, iy, ir, k, now) {
  const x = SX(ix), y = SY(iy), r = ir * sc;
  ctx.fillStyle = alpha(INK.shallow, 0.35);
  disc(x, y, r * 1.38);
  ctx.fill();
  ctx.fillStyle = alpha(INK.shallow, 0.5);
  disc(x, y, r * 1.16);
  ctx.fill();
  const lump = (size) => {
    ctx.beginPath();
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * Math.PI * 2, rr = r * size * (1 + 0.07 * Math.sin(a * 3 + k * 2.1) + 0.04 * Math.sin(a * 5 + k));
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
  };
  ctx.fillStyle = INK.sandDark;
  lump(1.0);
  ctx.fill();
  ctx.fillStyle = INK.sand;
  lump(0.88);
  ctx.fill();
  ctx.fillStyle = '#8c8a86';
  disc(x + r * 0.42 * (k % 2 ? 1 : -1), y + r * 0.35, r * 0.17);
  ctx.fill();
  ctx.fillStyle = '#a9a6a0';
  disc(x + r * 0.38 * (k % 2 ? 1 : -1), y + r * 0.31, r * 0.1);
  ctx.fill();
  // A palm, its fronds stirring.
  const px = x - r * 0.15, py = y - r * 0.1;
  ctx.fillStyle = 'rgba(30,60,40,0.25)';
  ctx.beginPath(); ctx.ellipse(px + r * 0.15, py + r * 0.18, r * 0.45, r * 0.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#7a5532';
  ctx.lineWidth = Math.max(1.5, r * 0.09);
  ctx.beginPath(); ctx.moveTo(px + r * 0.12, py + r * 0.25); ctx.quadraticCurveTo(px + r * 0.1, py, px, py - r * 0.18); ctx.stroke();
  const sway = Math.sin(now / 900 + k) * 0.12;
  for (let i = 0; i < 5; i++) {
    const a = sway + (i / 5) * Math.PI * 2;
    ctx.fillStyle = i % 2 ? INK.palm : INK.palmDark;
    ctx.beginPath();
    ctx.ellipse(px + Math.cos(a) * r * 0.24, py - r * 0.18 + Math.sin(a) * r * 0.24, r * 0.3, r * 0.1, a, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#5b3d22';
  disc(px, py - r * 0.18, r * 0.07);
  ctx.fill();
}

// Gold afloat: a chest bobbing, glowing when it is worth double; a coin a
// small gold disc that blinks as it is about to sink.
function drawGold(c, now, i) {
  const x = SX(c[0]), y = SY(c[1]) + Math.sin(now / 400 + i) * sc * 0.003;
  if (c[4] < 3 * HZ && Math.floor(now / 140) % 2 === 0) return;
  if (c[3] === 1) {
    const r = Math.max(2.5, sc * 0.009);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    disc(x + 1, y + 1.5, r);
    ctx.fill();
    ctx.fillStyle = INK.gold;
    disc(x, y, r);
    ctx.fill();
    ctx.fillStyle = '#fff3c4';
    disc(x - r * 0.3, y - r * 0.3, r * 0.35);
    ctx.fill();
    return;
  }
  const w = Math.max(9, sc * 0.03), h = w * 0.7;
  if (c[2] > CHEST_V) {
    ctx.fillStyle = `rgba(255,209,102,${(0.3 + 0.2 * Math.sin(now / 160)).toFixed(3)})`;
    disc(x, y, w * 0.95);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(232,246,255,0.35)';
  ctx.beginPath(); ctx.ellipse(x, y + h * 0.45, w * 0.7, h * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#7a4a26';
  roundRect(x - w / 2, y - h / 2, w, h, 2);
  ctx.fill();
  ctx.fillStyle = '#a0663a';
  roundRect(x - w / 2, y - h / 2, w, h * 0.42, 2);
  ctx.fill();
  ctx.fillStyle = INK.gold;
  ctx.fillRect(x - w / 2, y - h * 0.1, w, Math.max(1.2, h * 0.14));
  ctx.fillRect(x - w * 0.08, y - h / 2, w * 0.16, h);
  if (Math.sin(now / 250 + i * 2) > 0.8) {
    ctx.fillStyle = '#ffffff';
    disc(x + w * 0.3, y - h * 0.35, Math.max(1, w * 0.07));
    ctx.fill();
  }
}

// The way your guns reach: a band off each side as far as a ball flies,
// bright while they are loaded.
function drawReach(x, y, hx, hy, d, colour) {
  const a = Math.atan2(hy, hx), L = HL * sc, B = (HB + 0.006) * sc, R = RANGE * sc;
  const loaded = d.cd === 0;
  ctx.save();
  ctx.translate(SX(x), SY(y));
  ctx.rotate(a);
  for (const side of [1, -1]) {
    const g = ctx.createLinearGradient(0, side * B, 0, side * (B + R));
    g.addColorStop(0, alpha(colour, loaded ? 0.24 : 0.07));
    g.addColorStop(1, alpha(colour, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-L * 0.8, side * B);
    ctx.lineTo(L * 0.8, side * B);
    ctx.lineTo(L * 1.3, side * (B + R));
    ctx.lineTo(-L * 1.3, side * (B + R));
    ctx.closePath();
    ctx.fill();
    if (loaded) {
      ctx.strokeStyle = alpha(colour, 0.45);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(-L * 1.3, side * (B + R));
      ctx.lineTo(L * 1.3, side * (B + R));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

// A ship as drawn: its hull, its guns, two masts and their sails in its
// player's colour, filled or slack by how it lies to the wind, reefed small
// when the hand reefs them; a flash where it was hit, smoke when it is near
// to sinking, a gold pennant on the richest ship.
function drawShip(id, x, y, hx, hy, d, colour, me, lead, t, now) {
  const look = lookOf(id, now);
  look.seen = now;
  look.hit *= Math.pow(0.88, frameDt * 60);
  look.tilt = (look.tilt || 0) * Math.pow(0.9, frameDt * 60);
  const a = Math.atan2(hy, hx), L = HL * sc, B = HB * sc;
  const sx = SX(x), sy = SY(y);
  // The wake: foam shed from the stern while the ship has way on.
  if (now - look.wake > 70 && d.v > 0.04) {
    look.wake = now;
    foam.push({ x: x - hx * HL, y: y - hy * HL, life: 0, max: 50, r: 0.006 + d.v * 0.02 });
    if (foam.length > 260) foam.splice(0, foam.length - 260);
  }
  if (d.hp <= 2 && now - look.smoke > 160) {
    look.smoke = now;
    smoke(x, y, (Math.random() - 0.5) * 0.03, -0.03, 0.006 + Math.random() * 0.004);
  }
  if (d.sh > 0 && Math.floor(now / 120) % 2 === 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    disc(sx, sy, L * 1.35);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (me) {
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(sx, sy, L * 1.25, B * 2.3, a, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(a);
  ctx.scale(1, 1 - look.tilt * 0.12);
  ctx.fillStyle = 'rgba(5,20,30,0.3)';
  ctx.beginPath(); ctx.ellipse(L * 0.1, B * 0.6, L * 1.05, B * 1.2, 0, 0, Math.PI * 2); ctx.fill();
  const hull = () => {
    ctx.beginPath();
    ctx.moveTo(L * 1.08, 0);
    ctx.quadraticCurveTo(L * 0.6, -B * 1.1, -L * 0.1, -B);
    ctx.lineTo(-L * 0.95, -B * 0.8);
    ctx.lineTo(-L * 0.95, B * 0.8);
    ctx.lineTo(-L * 0.1, B);
    ctx.quadraticCurveTo(L * 0.6, B * 1.1, L * 1.08, 0);
    ctx.closePath();
  };
  ctx.fillStyle = INK.wood;
  hull();
  ctx.fill();
  ctx.strokeStyle = INK.woodDark;
  ctx.lineWidth = Math.max(1, B * 0.18);
  ctx.stroke();
  // The guns, three a side.
  ctx.fillStyle = '#2b2b30';
  for (const side of [1, -1]) {
    for (const k of [-0.56, 0, 0.56]) ctx.fillRect(k * L - B * 0.2, side * B * 0.92 - B * 0.17, B * 0.4, B * 0.34);
  }
  ctx.fillStyle = INK.deck;
  ctx.save();
  ctx.scale(0.78, 0.66);
  hull();
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(90,56,30,0.5)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (const k of [-0.5, 0, 0.5]) { ctx.moveTo(-L * 0.7, k * B * 0.5); ctx.lineTo(L * 0.6, k * B * 0.5); }
  ctx.stroke();
  if (look.hit > 0.05) {
    ctx.fillStyle = `rgba(255,255,255,${(look.hit * 0.7).toFixed(3)})`;
    hull();
    ctx.fill();
  }
  // The sails, square across the hull and swung toward the wind's side; full
  // and bellied before the wind, slack and shivering in irons.
  const lwx = t.wx * hx + t.wy * hy, lwy = t.wy * hx - t.wx * hy;
  const full = clamp((polar(lwx) - 0.17) / 0.83, 0, 1);
  const swing = clamp(lwy * 0.6, -0.7, 0.7);
  const reef = d.rf === 1;
  const span = B * (reef ? 1.1 : 1.6);
  for (const [mx, k] of [[L * 0.32, 0.85], [-L * 0.3, 1]]) {
    ctx.save();
    ctx.translate(mx, 0);
    ctx.rotate(swing);
    const s = span * k, belly = (reef ? 0.35 : 0.7) * B * (0.3 + full) + (full < 0.1 ? Math.sin(now / 50) * B * 0.2 : 0);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(-B * 0.15, -s);
    ctx.lineTo(-B * 0.15, s);
    ctx.quadraticCurveTo(belly * 2.4, 0, -B * 0.15, -s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.moveTo(-B * 0.15, -s * 0.5);
    ctx.lineTo(-B * 0.15, s * 0.5);
    ctx.quadraticCurveTo(belly * 1.5, 0, -B * 0.15, -s * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = INK.woodDark;
    ctx.lineWidth = Math.max(1, B * 0.14);
    ctx.beginPath(); ctx.moveTo(0, -s * 1.02); ctx.lineTo(0, s * 1.02); ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = '#3a2412';
  for (const mx of [L * 0.32, -L * 0.3]) { disc(mx, 0, Math.max(1.2, B * 0.2)); ctx.fill(); }
  if (lead) {
    const wave = Math.sin(now / 150) * B * 0.2;
    ctx.fillStyle = INK.gold;
    ctx.beginPath();
    ctx.moveTo(-L * 0.3, 0);
    ctx.lineTo(-L * 0.3 - L * 0.7 * Math.max(0.4, 0.5 + lwx * 0.5), wave - B * 0.3);
    ctx.lineTo(-L * 0.3 - L * 0.7 * Math.max(0.4, 0.5 + lwx * 0.5), wave + B * 0.3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // Planks left, and the name.
  const pip = Math.max(3, Math.min(6, sc * 0.008)), gap = 2;
  const pw = d.mh * pip + (d.mh - 1) * gap;
  let top = sy - L * 1.25 - 4;
  for (let i = 0; i < d.mh; i++) {
    ctx.fillStyle = i < d.hp ? (d.hp <= 1 ? INK.danger : '#e8f6ff') : 'rgba(255,255,255,0.2)';
    ctx.fillRect(sx - pw / 2 + i * (pip + gap), top - pip, pip, pip);
  }
  top -= pip + 3;
  const px = Math.max(9, Math.min(13, 7 + sc * 0.012));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(8,20,32,0.8)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  ctx.strokeText(label, sx, top);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, sx, top);
}

function drawBall(x, y, vx, vy) {
  const sx = SX(x), sy = SY(y), r = Math.max(1.8, BR * sc);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = r;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx - vx * sc * 1.6, sy - vy * sc * 1.6);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  disc(sx + r * 0.6, sy + r * 0.9, r);
  ctx.fill();
  ctx.fillStyle = '#1d1f26';
  disc(sx, sy, r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  disc(sx - r * 0.35, sy - r * 0.35, r * 0.35);
  ctx.fill();
}

function drawBits() {
  flat();
  for (const b of bits) {
    const f = b.life / b.max;
    if (b.puff) {
      ctx.globalAlpha = 0.55 * (1 - f);
      ctx.fillStyle = b.colour;
      disc(SX(b.x), SY(b.y), b.size * sc * (1 + f * 1.8));
    } else {
      ctx.globalAlpha = 1 - f * 0.6;
      ctx.fillStyle = b.colour;
      disc(SX(b.x), SY(b.y) - b.z * sc, Math.max(0.8, b.size * sc * (1 - f * 0.5)));
    }
    ctx.fill();
  }
  for (const r of rings) {
    const f = r.life / r.max;
    ctx.globalAlpha = (1 - f) * 0.75;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - f) + 1;
    disc(SX(r.x), SY(r.y), r.r * sc * ease(f));
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
    ctx.strokeStyle = 'rgba(8,20,32,0.8)';
    ctx.font = font(p.px * scale);
    const half = Math.min(VW / 2 - 8, ctx.measureText(p.s).width / 2 + 4);
    const X = Math.max(half, Math.min(VW - half, SX(p.x))), Y = Math.max(TOP + 10, SY(p.y) - rise);
    ctx.strokeText(p.s, X, Y);
    ctx.fillStyle = p.colour;
    ctx.fillText(p.s, X, Y);
  }
  ctx.globalAlpha = 1;
  if (flash > 0) {
    ctx.fillStyle = `rgba(220,230,255,${(flash * 0.35).toFixed(3)})`;
    ctx.fillRect(0, 0, VW, VH);
  }
}

// The wind, in a corner of the bay: an arrow the way it blows.
function drawWind(t, now) {
  flat();
  const r = Math.max(13, Math.min(20, sc * 0.03));
  const cx = SX(FW) - r - 8, cy = SY(0) + r + 8;
  ctx.fillStyle = 'rgba(8,20,32,0.55)';
  disc(cx, cy, r + 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  disc(cx, cy, r);
  ctx.stroke();
  const a = Math.atan2(t.wy, t.wx) + Math.sin(now / 700) * 0.03;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-r * 0.7, 0); ctx.lineTo(r * 0.45, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(r * 0.8, 0); ctx.lineTo(r * 0.3, -r * 0.32); ctx.lineTo(r * 0.3, r * 0.32); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-r * 0.7, 0); ctx.lineTo(-r * 0.9, -r * 0.3); ctx.moveTo(-r * 0.5, 0); ctx.lineTo(-r * 0.7, -r * 0.3); ctx.stroke();
  ctx.restore();
  text('wind', cx, cy + r + 13, 10, INK.muted, 'center');
}

const clock = (steps) => {
  const s = Math.ceil(steps / HZ);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// The richest ship afloat, as every copy works it out: -1 when there is none.
function leaderOf(t) {
  let top = -1, best = LEAD_FROM - 1, tie = false;
  for (const id of playersIn(t)) {
    const g = t.p[id].g;
    if (g > best) { best = g; top = id; tie = false; } else if (g === best) tie = true;
  }
  return tie ? -1 : top;
}

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, and the time left in it.
  let status = '', colour = INK.text;
  const into = PLAY_STEPS - t.pt;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left';
    if (into >= RUSH_AT) { status += ' · gold rush'; colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text; }
    else if (t.th > 0) status += ' · the squall closes in';
    else if (into >= SQ_AT - 3 * HZ) status += ' · squall soon';
  } else status = 'round ' + t.rd + ' · over';
  text('broadside', 12, 22, titlePx, '#9fe3ff', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('broadside').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with their gold; the
  // chip of a sunk ship is hollow.
  const ids = bySeat(t);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      disc(x + 11, y - 2, 5);
      if (d.st === SAIL) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      const gold = String(d.g);
      ctx.font = font(12);
      const gw = ctx.measureText(gold).width;
      text(gold, x + cw - 8, y + 3, 12, INK.gold, 'right');
      const wins = t.ph !== WAIT && d.wn ? '★' + d.wn : '';
      ctx.font = font(10);
      const ww = wins ? ctx.measureText(wins).width + 5 : 0;
      if (wins && cw > 56) text(wins, x + cw - 12 - gw, y + 2, 10, '#dff0ff', 'right');
      if (cw > 64) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st === SAIL ? (mine ? INK.text : INK.muted) : INK.dim, cw - 34 - gw - ww, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to steer · tap to fire both sides · a light push reefs'
    : 'mouse or ←→/AD steer · click or space fires both sides · S reefs · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// How your hull stands, whether your guns are loaded and how you lie to the
// wind, in the strip under the bay while a round is on.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = Math.min(fieldBot + NOTE_ROOM / 2, VH - BOT - 18);
  if (d.st !== SAIL) {
    const line = t.ph === PLAY ? 'sunk! you are back afloat in a moment' : t.ph === COUNT ? 'get ready' : '';
    if (line) fitText(line, VW / 2, y + 5, 13, INK.muted, VW - 24);
    return;
  }
  const irons = d.hx * t.wx + d.hy * t.wy < IRONS;
  const bar = 70, pip = 8, gap = 3, pw = d.mh * pip + (d.mh - 1) * gap;
  const tag = irons ? 'in irons · turn off the wind' : d.cd === 0 ? 'guns loaded' : 'reloading';
  ctx.font = font(12);
  const tagW = ctx.measureText(tag).width;
  const total = pw + 18 + bar + 10 + tagW;
  let x = VW / 2 - total / 2;
  for (let i = 0; i < d.mh; i++) {
    ctx.fillStyle = i < d.hp ? (d.hp <= 1 ? INK.danger : '#e8f6ff') : 'rgba(255,255,255,0.18)';
    ctx.fillRect(x + i * (pip + gap), y - pip / 2, pip, pip);
  }
  x += pw + 18;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(x, y - 5, bar, 10, 5);
  ctx.fill();
  const k = d.cd === 0 ? 1 : 1 - d.cd / RELOAD;
  ctx.fillStyle = d.cd === 0 ? SEAT[d.c] : 'rgba(255,255,255,0.45)';
  roundRect(x, y - 5, Math.max(10, bar * k), 10, 5);
  ctx.fill();
  x += bar + 10;
  text(tag, x, y + 4, 12, irons ? INK.danger : d.cd === 0 ? INK.text : INK.dim, 'left');
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
    const tip = two ? null : 'your guns only fire sideways · turn side-on to a ship · sail across the wind';
    practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(8,20,32,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 320), 30);
    fitText('the most gold at the horn wins', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 300));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(8,20,32,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('sail!', cx, mid + big * 0.5);
    text('sail!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= 5 * HZ) {
    const n = Math.ceil(t.pt / HZ);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(8,20,32,0.6)';
    ctx.font = font(big * 2);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big * 0.7);
    text(String(n), cx, mid + big * 0.7, big * 2, INK.gold, 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 330), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody came out richest';
    else head = t.win === me ? 'you hold the most gold!' : nickOf(t.win) + ' holds the most gold';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('gold', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('sunk', cx + w / 2 - 62, y0 + 52, 10, INK.dim, 'right');
    text('rounds', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, g, sk, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(g), cx + w / 2 - 110, y, 14, INK.gold, 'right');
      text(String(sk), cx + w / 2 - 62, y, 13, '#dff0ff', 'right');
      text('★' + wins, cx + w / 2 - 18, y, 13, INK.text, 'right');
    });
    fitText('sink a ship to spill its gold · next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a ship is as drawn: between two steps, and never slid across a jump —
// a ship back afloat after a sinking.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 0.2) return [z.x, z.y, z.hx, z.hy, z];
  const [hx, hy] = unit(lerp(a.hx, z.hx, b.k), lerp(a.hy, z.hy, b.k));
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), hx, hy, z];
}

// Your own ship is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a hand a step away from where
// the guess had it. So the ship drawn is pulled toward the guess a little
// every frame rather than put on it, and a guess far off — a table taken
// afresh, a ship back afloat — puts it there at once. Only the drawing is
// smoothed: the bay, and every rule on it, are untouched.
const PULL = 0.45;
let shown = null;        // [x, y, hx, hy]: where your ship is drawn
let myPos = null;        // the same, for the mouse to steer by
let wasLoaded = true;

function settle(x, y, hx, hy) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 0.15) return (shown = [x, y, hx, hy]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  const [ux, uy] = unit(shown[2] + (hx - shown[2]) * k, shown[3] + (hy - shown[3]) * k);
  shown[2] = ux;
  shown[3] = uy;
  return shown;
}

function draw(now) {
  fit();
  drawSky(now);
  const b = agreedAt(now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the bay…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  drawSea(t, now);
  t.is.forEach(([ix, iy, ir], k) => drawIsle(ix, iy, ir, k, now));
  t.ch.forEach((c, i) => drawGold(c, now, i));
  drawSquall(t, now);
  const lead = leaderOf(t);
  const items = [];
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st !== SAIL) continue;
    const p = bodyAt(b, id);
    items.push([p[1], () => drawShip(id, p[0], p[1], p[2], p[3], d, SEAT[d.c], false, id === lead, t, now)]);
  }
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own && own.to.p[me].st === SAIL) {
    const p = bodyAt(own, me);
    const [x, y, hx, hy] = settle(p[0], p[1], p[2], p[3]);
    const d = p[4];
    myPos = [x, y];
    drawReach(x, y, hx, hy, d, SEAT[d.c]);
    items.push([y, () => drawShip(me, x, y, hx, hy, d, SEAT[d.c], true, me === lead, t, now)]);
    const loaded = t.p[me] && t.p[me].cd === 0;
    if (loaded && !wasLoaded && t.ph === PLAY) sound.loaded();
    wasLoaded = loaded;
  } else {
    myPos = shown = null;
  }
  items.sort((p, q) => p[0] - q[0]);
  for (const [, f] of items) f();
  // Cannonballs: everybody else's from the agreed table, your own from the
  // guess, so they leave the guns where your ship is drawn.
  for (const bl of t.bl) if (bl[5] !== me) drawBall(bl[0] - bl[2] * (1 - b.k), bl[1] - bl[3] * (1 - b.k), bl[2], bl[3]);
  const mine = m && m.to.p[me] ? m : b;
  for (const bl of mine.to.bl) if (bl[5] === me) drawBall(bl[0] - bl[2] * (1 - mine.k), bl[1] - bl[3] * (1 - mine.k), bl[2], bl[3]);
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawWind(t, now);
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the helm, the way to aim the bow, a thousand at full,
// whether the sails are reefed, and how many volleys so far. A change of aim
// goes out no oftener than STEER_EVERY, because a thumb or a mouse changes it
// on every move the screen reports and the clock's ticks share the same
// seat's ceiling on messages; a volley goes out at once.
const STEER_EVERY = 80;
let mode = '';           // what steers: 'keys', 'mouse', 'touch', or nothing yet
let volleys = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_TURN = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
const KEY_REEF = { ArrowDown: 1, KeyS: 1 };

// A thumb: a stick from wherever it lands, aiming the bow the way it is
// pushed, and a light push reefs; a tap fires — a drag rather than a press,
// because iOS keeps a long press inside a frame for itself. A second finger
// down while the first steers fires too. Let go and the ship holds its
// course. A mouse: your bow turns toward the pointer wherever it is, and the
// pointer close by reefs; a click fires.
const DEAD = 9;
const REACHOUT = 46;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }
const mouse = { x: 0, y: 0, on: false };

function steerNow() {
  if (mode === 'keys') {
    let tu = 0, rf = 0;
    for (const c of keys) { if (c in KEY_TURN) tu += KEY_TURN[c]; if (c in KEY_REEF) rf = 1; }
    return [clamp(tu, -1, 1), 0, 0, rf];
  }
  if (mode === 'touch') {
    if (!stick) return [0, 0, 0, 0];
    const l = Math.hypot(stick.dx, stick.dy);
    if (l < DEAD) return [0, 0, 0, 0];
    return [0, clamp(Math.round((stick.dx / l) * 1000), -1000, 1000), clamp(Math.round((stick.dy / l) * 1000), -1000, 1000), l < REACHOUT * 0.55 ? 1 : 0];
  }
  if (mode === 'mouse' && mouse.on && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]);
    const l = Math.hypot(dx, dy), hull = HL * sc;
    if (l < hull * 0.8) return [0, 0, 0, 1];
    return [0, clamp(Math.round((dx / l) * 1000), -1000, 1000), clamp(Math.round((dy / l) * 1000), -1000, 1000), l < hull * 2.4 ? 1 : 0];
  }
  return [0, 0, 0, 0];
}

function sayHand(now, force) {
  const [tu, ax, ay, rf] = steerNow();
  const h = [tu, ax, ay, rf, volleys], s = lastSaid;
  if (s && h.every((v, i) => v === s[i])) return;
  if (!force && s && h[4] === s[4] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A volley: heard at once, and fired a trip later on every copy alike, if the
// table says the guns are loaded.
function fireNow() {
  wake();
  if (!world) return;
  volleys = (volleys + 1) % 1000;
  sayHand(performance.now(), true);
  const d = world.p[myId()];
  if (d && d.st === SAIL && d.cd === 0 && (world.ph === PLAY || world.ph === WAIT)) sound.boom(1, true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyF' || e.code === 'KeyX') {
    e.preventDefault();
    if (!e.repeat) fireNow();
    return;
  }
  if (!(e.code in KEY_TURN) && !(e.code in KEY_REEF) && e.code !== 'ArrowUp' && e.code !== 'KeyW') return;
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
    if (stick) { fireNow(); return; }
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
  fireNow();
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
  if (tap) fireNow();
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

// Called by the kernel once it stands. Holding a course is a hand too: it is
// how a player arrives on the water.
function start() {
  setHand([0, 0, 0, 0, volleys]);
  lastSaid = [0, 0, 0, 0, volleys];
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
