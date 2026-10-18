/**
 * @disk     orbit
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Little ships circling one sun. Burn back to drop into a lower, faster orbit and catch what is ahead, burn forward to climb. Scoop up stardust, ram a slower ship to knock its dust loose, and refuel close to the sun without touching it.
 * @tags     game, party, realtime, space, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/orbit.png
 */
// orbit.js — a little solar system where the room's order is the referee.
//
// Every copy holds the sun, every ship and every grain of stardust in flight,
// and changes them only on what comes back round the room, so every copy
// applies the same hands in the same order and holds the same sky. Nobody
// sends where they are, what they scooped up or whom they rammed: a hand is a
// way to point the engine, how hard, and a counter that moves on by one for
// every kick asked for; gravity, fuel and every crash are the same arithmetic
// on every machine. A page with a console open can fly its own ship however it
// likes, but no harder than its engine pushes and no longer than its fuel lasts.
//
// While a player is alone, a bot flies with them. It is part of the table like
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
// `Math.sin`, `Math.cos`, `Math.atan2` and `**` are not, so nothing inside a
// step turns by an angle: every direction is a vector, and gravity is a product
// and one square root.

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

// A way picked at random, as a unit vector: a point in the square, kept only
// when it falls inside the circle, so every way is as likely as any other.
function randomWay(w) {
  for (let i = 0; i < 12; i++) {
    const x = draw01(w) * 2 - 1, y = draw01(w) * 2 - 1, l2 = x * x + y * y;
    if (l2 > 0.04 && l2 <= 1) return unit(x, y);
  }
  return [1, 0];
}

// Eight ways round the sun, the same numbers on every machine.
const WAY8 = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own ship a trip ahead, with your hand in it
const DT = 1 / HZ;
const SUB = 4;                 // gravity is worked out this many times a step,
const H = DT / SUB;            // so a fast orbit close to the sun stays an orbit

// The sun sits at the middle; distances are shares of the rim's radius and
// speeds are those a second. A circular orbit at half the rim takes six
// seconds; one at the rim about seventeen.
const GM = 0.137;
const RIM = 1;                 // the edge of the system as drawn
const LOST_R = 1.12;           // past this a ship is lost in space
const SUN_R = 0.07;            // the sun's radius,
const SUN_BIG = 0.15;          // and as big as it swells late in a round
const SHIP_R = 0.026;
const A_TH = 0.42;             // what the engine adds a second, at full throttle
const VMAX = 2.4;
const FUEL = 100, FUEL_BIG = 130; // a tank; whoever has won fewest rounds flies a bigger one
const BURN = 0.8;              // fuel a step at full throttle
const SOLAR = 0.3;             // fuel a step coasting, far from the sun,
const SOLAR_NEAR = 0.6;        // and how much more it is worth close in
const KICK_V = 0.2;            // a kick: this much speed at once,
const KICK_FUEL = 18;          // for this much fuel,
const KICK_CD = 20;            // and not again for this many steps
const RAM_V = 0.14;            // closing speed that makes a bump a crash
const BOUNTY = 2;              // dust for a rival lost soon after you rammed them
const BLAME_STEPS = 3 * HZ;
const SHIELD = 40;             // steps a ship back in flight can neither ram nor be rammed
const BACK_STEPS = 50;         // steps from being lost to flying again
const GRAB = 0.045, GRAB_COMET = 0.06;
const DUST_MAX = 60;
const DUST_EVERY = 20;         // steps between two chances of fresh dust
const DUST_LIFE = 40 * HZ;
const SPILL_LIFE = 20 * HZ;
const COMET_EVERY = 12 * HZ;
const COMET_V = 3;
const GOLD_MAX = 99999;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 7 * HZ;
const SWELL_AT = 55 * HZ;      // steps into a round when the sun starts to swell,
const SWELL_TO = 75 * HZ;      // and when it is done
const RUSH_AT = 72 * HZ;       // steps into a round when dust comes in worth double

const FLY = 0, GONE = 1;
const DUST = 0, COMET = 1, SPILL = 2;

// The speed of a circular orbit at radius r.
const circ = (r) => Math.sqrt(GM / r);

// The shape of the orbit a ship is on, from where it is and how it moves:
// how near the sun it will pass and how far out it will swing. Energy and
// angular momentum give both with nothing but products and square roots;
// a ship on its way out of the system swings out for ever.
function orbitOf(x, y, vx, vy) {
  const r = Math.sqrt(x * x + y * y), e2 = vx * vx + vy * vy;
  const en = e2 / 2 - GM / r, h = x * vy - y * vx;
  const e = Math.sqrt(Math.max(0, 1 + (2 * en * h * h) / (GM * GM)));
  const p = (h * h) / GM;
  return { rp: p / (1 + e), ra: e < 1 ? p / (1 - e) : Infinity, r };
}

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   sr: the sun's radius; ds: stardust in flight, [x, y, vx, vy, worth, steps
//   left, dust, comet or spill]; res: the last round's [id, dust, rams, rounds
//   won] rows; win: its winner
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, sr: SUN_R, ds: [], p: {}, res: null, win: -1 };
  lay(w);
  return w;
}

// A fresh sky: the sun at its own size and a sprinkle of dust already
// circling, so there is something to chase from the first second.
function lay(w) {
  w.sr = SUN_R;
  w.ds = [];
  for (let i = 0; i < 8; i++) addDust(w, DUST, 1);
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'vx', 'vy', 'fu', 'mf', 'fr', 'ax', 'ay', 'q', 'hq', 'th', 'cd', 'sh',
  'rt', 'g', 'kn', 'wn', 'lb', 'lt', 'bc', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; st: flying or lost; x, y, vx, vy: where and how fast;
//   fu, mf: fuel and the tank's size; fr, ax, ay: the hand's engine — a way on
//   the screen (fr 0) or along and across the ship's own motion (fr 1), a
//   thousand at full; q: the kick counter as last heard; hq: a kick to make
//   this step; th: whether the engine burned this step; cd: steps until the
//   next kick; sh: steps of shield left; rt: steps until a lost ship flies
//   again; g: dust this round; kn: rivals rammed this round; wn: rounds won;
//   lb, lt: who rammed this ship last, and for how many steps more that
//   counts; bc: steps until a bump sounds again; bw: the bot's pause; hs, hc:
//   hands this step.
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
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: GONE, x: 0, y: -0.6, vx: 0, vy: 0, fu: FUEL, mf: FUEL,
    fr: 0, ax: 0, ay: 0, q, hq: 0, th: 0, cd: 0, sh: 0, rt: BACK_STEPS, g: 0, kn: 0, wn: 0, lb: 0, lt: 0,
    bc: 0, bw: 0, hs: w.n, hc: 0,
  });
}

// A ship put on a circular orbit, counter-clockwise like everything else
// here, with a full tank.
function place(d, ux, uy, r) {
  const v = circ(r);
  d.st = FLY;
  d.x = ux * r;
  d.y = uy * r;
  d.vx = uy * v;
  d.vy = -ux * v;
  d.fu = d.mf;
  d.hq = d.th = d.cd = d.sh = d.rt = d.lt = d.bc = d.bw = 0;
  d.lb = 0;
}

// Seats round the sun, every other way first, so two players start opposite.
const SEAT_WAY = [6, 2, 0, 4, 7, 3, 1, 5];
const START_R = 0.62;
function placeAtSeat(d) {
  const [ux, uy] = WAY8[SEAT_WAY[d.s]];
  place(d, ux, uy, START_R);
}

// Back in flight after being lost: the way round the sun furthest from every
// other ship, on a circular orbit, and shielded for a moment so nobody can
// wait on it.
function respawn(w, id) {
  const d = w.p[id];
  const off = Math.floor(draw01(w) * 8);
  let best = 0, score = -Infinity;
  for (let k = 0; k < 8; k++) {
    const [ux, uy] = WAY8[(k + off) % 8];
    let near = 9;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o === id || e.st !== FLY) continue;
      near = Math.min(near, sq(e.x - ux * START_R) + sq(e.y - uy * START_R));
    }
    if (near > score) { score = near; best = (k + off) % 8; }
  }
  place(d, WAY8[best][0], WAY8[best][1], START_R);
  d.sh = SHIELD;
  fx(w, 'back', d.x, d.y, 0, id);
}

// A hand, at its place in the room's order: [0 for a way on the screen or 1
// for one along and across the ship's motion; that way, a thousand at full;
// the kick counter]. A kick is asked for once, when the counter changes; the
// same hand said again to keep a player at the table kicks nothing. Being
// heard is how a player arrives: in flight at once while the table waits for
// a round, at a seat of their own while one is counted in, and a moment later
// while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[3]);
    if (w.ph === WAIT) respawn(w, id);
    else if (w.ph === COUNT) placeAtSeat(d);
    d.fr = input[0];
    d.ax = input[1];
    d.ay = input[2];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; when a kick is ready is the table's to say.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.fr = input[0];
  d.ax = input[1];
  d.ay = input[2];
  if (input[3] !== d.q) { d.q = input[3]; d.hq = 1; }
}

// A hand off the wire, made safe: four integers in their ranges, or nothing.
// How hard an engine pushes is the ship's business: a hand names a way and a
// share of full throttle, never a speed.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [fr, ax, ay, q] = raw;
  if (![fr, ax, ay, q].every(Number.isInteger)) return null;
  if (fr < 0 || fr > 1 || ax < -1000 || ax > 1000 || ay < -1000 || ay > 1000 || q < 0 || q > 999) return null;
  return [fr, ax, ay, q];
}

function leave(w, id) {
  delete w.p[id];
}

// Where a hand points the engine, as a unit vector on the screen, and how
// hard: a way along and across the ship's motion is turned by that motion.
function engineOf(d) {
  if (d.ax === 0 && d.ay === 0) return [0, 0, 0];
  const l = Math.sqrt(d.ax * d.ax + d.ay * d.ay);
  const thr = Math.min(1, l / 1000);
  let ex = d.ax / l, ey = d.ay / l;
  if (d.fr === 1) {
    const [ux, uy] = unit(d.vx, d.vy);
    const ax = ex, ay = ey;
    ex = ux * ax - uy * ay;
    ey = uy * ax + ux * ay;
  }
  return [ex, ey, thr];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions
const BOT_IDLE = 0.08;         // how often it coasts a moment rather than decide
const BOT_RAM = 0.35;          // how often it goes for a slower rival close by
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot flies while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    respawn(w, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

function botAim(d, gx, gy, thr) {
  const [ux, uy] = unit(gx, gy);
  d.fr = 0;
  d.ax = Math.round(ux * 1000 * thr);
  d.ay = Math.round(uy * 1000 * thr);
}

// The bot keeps its own orbit safe first — out of the sun, inside the rim —
// and then flies at a target the plain way, closing in on where it is while
// matching how it moves. Short of fuel, it coasts to fill up.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== FLY) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 4 + Math.floor(draw01(w) * 10); d.ax = d.ay = 0; return; }
  const o = orbitOf(d.x, d.y, d.vx, d.vy);
  const [px, py] = unit(d.vx, d.vy), [rx, ry] = unit(d.x, d.y);
  // Stuck low it climbs; falling toward the sun it pushes straight out; past
  // the low point it waits for the high one, where a push ahead lifts the low
  // point cheaply, rather than speeding up near the sun and flinging itself
  // out of the system.
  const out = d.x * d.vx + d.y * d.vy > 0;
  if (o.rp < w.sr + 0.13) {
    if (o.ra < 0.4) botAim(d, px, py, 0.7);
    else if (!out) botAim(d, rx, ry, 1);
    else if (o.r > 0.45) botAim(d, px, py, 0.6);
    else d.ax = d.ay = 0;
    return;
  }
  if (o.ra > 0.92 || (out && o.ra > 0.8)) { botAim(d, -px - rx * 0.4, -py - ry * 0.4, 1); return; }
  if (d.fu < 22) { d.ax = d.ay = 0; return; }
  const sp = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
  let tx = 0, ty = 0, tvx = 0, tvy = 0, best = Infinity, foe = null;
  for (const id of humans(w)) {
    const e = w.p[id];
    if (e.st !== FLY || e.sh > 0) continue;
    const f = sq(e.x - d.x) + sq(e.y - d.y);
    if (f < sq(0.3) && sp > Math.sqrt(e.vx * e.vx + e.vy * e.vy) + 0.05 && f < best) { best = f; foe = e; }
  }
  if (foe && draw01(w) < BOT_RAM) {
    tx = foe.x; ty = foe.y; tvx = foe.vx; tvy = foe.vy;
    if (d.cd === 0 && best < sq(0.12) && d.fu > KICK_FUEL + 10) d.hq = 1;
  } else {
    best = Infinity;
    let pick = null;
    for (const s of w.ds) {
      if (sq(s[0]) + sq(s[1]) > sq(0.88)) continue;
      const f = (Math.sqrt(sq(s[0] - d.x) + sq(s[1] - d.y)) + 0.5 * Math.sqrt(sq(s[2] - d.vx) + sq(s[3] - d.vy))) / (1 + 0.3 * s[4]);
      if (f < best) { best = f; pick = s; }
    }
    if (!pick) { d.ax = d.ay = 0; return; }
    [tx, ty, tvx, tvy] = pick;
  }
  const gx = (tx - d.x) * 1.6 + (tvx - d.vx), gy = (ty - d.y) * 1.6 + (tvy - d.vy);
  const need = Math.sqrt(gx * gx + gy * gy);
  if (need < 0.04) { d.ax = d.ay = 0; return; }
  botAim(d, gx, gy, need > 0.25 ? 1 : 0.6);
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
    d.mf = FUEL;
    d.g = d.kn = 0;
    placeAtSeat(d);
  }
}

// A round: a fresh sky, the seats closed up in order, everybody on an orbit
// of their own. Whoever has won the fewest rounds, when somebody has won more,
// flies with a bigger tank.
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
    d.mf = hi > lo && d.wn === lo ? FUEL_BIG : FUEL;
    d.g = d.kn = 0;
    placeAtSeat(d);
  }
  fx(w, 'round', 0, 0, 0);
}

// The end of a round: it goes to the most dust, if nobody matches it.
function finish(w) {
  const ids = bySeat(w);
  let top = 0;
  for (const id of ids) top = Math.max(top, w.p[id].g);
  const best = ids.filter((id) => w.p[id].g === top);
  w.win = best.length === 1 && ids.length > 1 && top > 0 ? best[0] : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, w.p[id].g, w.p[id].kn, w.p[id].wn]);
  res.sort((a, b) => b[1] - a[1] || b[2] - a[2] || b[3] - a[3] || a[0] - b[0]);
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
  // The sky stands still while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) { w.p[id].hq = 0; w.p[id].th = 0; }
    return;
  }
  fly(w);
}

function fly(w) {
  botThink(w);
  if (w.ph === PLAY) swell(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== GONE) continue;
    d.hq = d.th = 0;
    if (d.rt > 1) d.rt -= 1;
    else respawn(w, id);
  }
  const pushes = new Map();
  for (const id of ids) if (w.p[id].st === FLY) pushes.set(id, engine(w, w.p[id], id));
  for (const id of ids) if (pushes.has(id)) move(w, w.p[id], id, pushes.get(id));
  crashes(w, ids);
  dust(w, ids);
  for (const id of ids) {
    const d = w.p[id];
    if (d.cd > 0) d.cd -= 1;
    if (d.sh > 0) d.sh -= 1;
    if (d.lt > 0) d.lt -= 1;
    if (d.bc > 0) d.bc -= 1;
  }
}

// Late in a round the sun swells, a little every step, and the dust comes in
// worth double for the last stretch.
function swell(w) {
  const into = PLAY_STEPS - w.pt;
  if (into === SWELL_AT - 2 * HZ) fx(w, 'warn', 0, 0, 0);
  if (into === RUSH_AT) fx(w, 'rush', 0, 0, 0);
  if (into < SWELL_AT) return;
  w.sr = SUN_R + (SUN_BIG - SUN_R) * Math.min(1, (into - SWELL_AT) / (SWELL_TO - SWELL_AT));
}

// The ship trailing everybody, once somebody has more dust than it.
function trailing(w, id) {
  const d = w.p[id];
  let poorest = true, richer = false;
  for (const o of playersIn(w)) {
    if (o === id) continue;
    if (w.p[o].g < d.g) poorest = false;
    if (w.p[o].g > d.g) richer = true;
  }
  return poorest && richer;
}

// The engine burns fuel as long as it is asked to and there is fuel to burn;
// a ship coasting fills its tank from the sun, much faster close in, and the
// ship trailing everybody fills twice as fast. A kick asked for goes off if it
// is ready and there is fuel for it: a jump of speed the way the engine
// points, or straight ahead when it points nowhere.
function engine(w, d, id) {
  const [ex, ey, thr] = engineOf(d);
  let push = [0, 0];
  d.th = 0;
  if (thr > 0 && d.fu > 0) {
    const k = Math.min(thr, d.fu / BURN);
    d.fu = Math.max(0, d.fu - k * BURN);
    d.th = 1;
    push = [ex * A_TH * k, ey * A_TH * k];
  } else {
    const r2 = d.x * d.x + d.y * d.y;
    const sun = SOLAR + SOLAR_NEAR * Math.min(4, (0.15 * 0.15) / Math.max(1e-6, r2));
    d.fu = Math.min(d.mf, d.fu + sun * (trailing(w, id) ? 2 : 1));
  }
  if (d.hq) {
    d.hq = 0;
    if (d.cd === 0 && d.fu >= KICK_FUEL) {
      const [kx, ky] = thr > 0 ? [ex, ey] : unit(d.vx, d.vy);
      d.vx += kx * KICK_V;
      d.vy += ky * KICK_V;
      d.fu -= KICK_FUEL;
      d.cd = KICK_CD;
      fx(w, 'kick', d.x, d.y, 0, id);
    }
  }
  return push;
}

// Gravity and the engine, a few times a step. A ship that touches the sun
// burns up; one that sails past the edge of the system is lost in space.
function move(w, d, id, push) {
  const [tx, ty] = push;
  let x = d.x, y = d.y, vx = d.vx, vy = d.vy;
  for (let k = 0; k < SUB; k++) {
    const r2 = x * x + y * y, r = Math.sqrt(r2);
    if (r < w.sr + SHIP_R * 0.5) { d.x = x; d.y = y; d.vx = vx; d.vy = vy; lost(w, id, 0); return; }
    const g = GM / (r2 * r);
    vx += (tx - x * g) * H;
    vy += (ty - y * g) * H;
    x += vx * H;
    y += vy * H;
  }
  const v2 = vx * vx + vy * vy;
  if (v2 > VMAX * VMAX) { const k = VMAX / Math.sqrt(v2); vx *= k; vy *= k; }
  d.x = x;
  d.y = y;
  d.vx = vx;
  d.vy = vy;
  if (x * x + y * y > LOST_R * LOST_R) lost(w, id, 1);
}

// A ship lost to the sun or to space loses a third of its dust, and whoever
// rammed it into that a moment before is paid a bounty.
function lost(w, id, why) {
  const d = w.p[id];
  d.g -= Math.floor(d.g / 3);
  let by = -1;
  if (d.lt > 0 && d.lb !== id && w.p[d.lb]) {
    by = d.lb;
    const s = w.p[by];
    s.g = Math.min(GOLD_MAX, s.g + BOUNTY);
  }
  fx(w, 'lost', clamp(d.x, -LOST_R, LOST_R), clamp(d.y, -LOST_R, LOST_R), why, id, by);
  d.st = GONE;
  d.rt = BACK_STEPS;
  d.x = clamp(d.x, -LOST_R, LOST_R);
  d.y = clamp(d.y, -LOST_R, LOST_R);
  d.vx = d.vy = 0;
  d.hq = d.th = d.cd = d.sh = d.lt = 0;
  d.lb = 0;
}

// Two ships that touch bounce apart like two billiard balls. Hard enough, it
// is a crash, and the faster ship wins it: the slower one sheds a third of
// its dust into space around it, for anybody to scoop up. Low orbits are fast
// ones, so whoever dives wins the crash. A ship back in flight passes through
// the others until its shield is gone.
function crashes(w, ids) {
  for (let a = 0; a < ids.length; a++) {
    const p = w.p[ids[a]];
    if (p.st !== FLY || p.sh > 0) continue;
    for (let b = a + 1; b < ids.length; b++) {
      const o = w.p[ids[b]];
      if (o.st !== FLY || o.sh > 0) continue;
      let dx = o.x - p.x, dy = o.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 4 * SHIP_R * SHIP_R) continue;
      let far = Math.sqrt(d2);
      if (far < 1e-9) { dx = 1; dy = 0; far = 1; }
      const nx = dx / far, ny = dy / far;
      const push = (2 * SHIP_R - far) / 2 + 1e-4;
      p.x -= nx * push; p.y -= ny * push;
      o.x += nx * push; o.y += ny * push;
      const vn = (o.vx - p.vx) * nx + (o.vy - p.vy) * ny;
      if (vn >= 0) continue;
      const sp = p.vx * p.vx + p.vy * p.vy, so = o.vx * o.vx + o.vy * o.vy;
      const j = -0.95 * vn;
      p.vx -= nx * j; p.vy -= ny * j;
      o.vx += nx * j; o.vy += ny * j;
      const mx = (p.x + o.x) / 2, my = (p.y + o.y) / 2;
      if (-vn >= RAM_V && sp !== so) {
        const [win, lose] = sp > so ? [ids[a], ids[b]] : [ids[b], ids[a]];
        ram(w, win, lose, mx, my);
      } else if (p.bc === 0 && o.bc === 0) {
        fx(w, 'bump', mx, my, 0, ids[a], ids[b]);
      }
      p.bc = o.bc = 10;
    }
  }
}

function ram(w, by, vid, x, y) {
  const v = w.p[vid], s = w.p[by];
  const spill = v.g > 0 ? Math.max(1, Math.floor(v.g / 3)) : 0;
  v.g -= spill;
  v.lb = by;
  v.lt = BLAME_STEPS;
  s.kn += 1;
  scatter(w, v, spill);
  fx(w, 'ram', x, y, spill, by, vid);
}

// Dust shed by a ship: up to five grains thrown off round it, each carrying
// the ship's own motion and a little more, so they drift on orbits of their
// own close to where it was.
function scatter(w, v, worth) {
  const n = Math.min(5, worth);
  if (n <= 0) return;
  const base = Math.floor(worth / n);
  let rest = worth - base * n;
  for (let k = 0; k < n; k++) {
    if (w.ds.length >= DUST_MAX) return;
    const [ux, uy] = randomWay(w);
    const kick = 0.05 + draw01(w) * 0.06;
    w.ds.push([v.x + ux * 0.035, v.y + uy * 0.035, v.vx + ux * kick, v.vy + uy * kick, base + (rest > 0 ? 1 : 0), SPILL_LIFE, SPILL]);
    if (rest > 0) rest -= 1;
  }
}

// Fresh dust on a nearly circular orbit somewhere between the sun and the
// rim, away from every ship; a comet comes in from the rim on a long ellipse
// that dives past the sun.
function addDust(w, kind, worth) {
  for (let tries = 0; tries < 12; tries++) {
    const [ux, uy] = randomWay(w);
    const r = kind === COMET ? 0.96 : 0.22 + draw01(w) * 0.7;
    const x = ux * r, y = uy * r;
    if (playersIn(w).some((id) => w.p[id].st === FLY && sq(w.p[id].x - x) + sq(w.p[id].y - y) < sq(0.15))) continue;
    const v = circ(r) * (kind === COMET ? 0.55 + draw01(w) * 0.12 : 0.96 + draw01(w) * 0.08);
    w.ds.push([x, y, uy * v, -ux * v, worth, DUST_LIFE, kind]);
    if (kind === COMET) fx(w, 'comet', x, y);
    return;
  }
}

// Dust falls round the sun like everything else, burns up in it, drifts off
// past the rim, and runs out after a while. The first ship over a grain
// scoops it up. Fresh dust comes every second while there is room for it,
// more with more ships, and worth double in the last stretch of a round.
function dust(w, ids) {
  const keep = [];
  for (const s of w.ds) {
    let x = s[0], y = s[1], vx = s[2], vy = s[3], gone = false;
    for (let k = 0; k < SUB; k++) {
      const r2 = x * x + y * y, r = Math.sqrt(r2);
      if (r < w.sr) { gone = true; break; }
      const g = GM / (r2 * r);
      vx -= x * g * H;
      vy -= y * g * H;
      x += vx * H;
      y += vy * H;
    }
    s[0] = x; s[1] = y; s[2] = vx; s[3] = vy;
    s[5] -= 1;
    if (gone) { if (s[6] !== DUST) fx(w, 'fizz', x, y); continue; }
    if (x * x + y * y > LOST_R * LOST_R || Math.abs(vx) > 4 || Math.abs(vy) > 4 || s[5] <= 0) continue;
    let took = false;
    for (const id of ids) {
      const d = w.p[id];
      if (d.st !== FLY) continue;
      const reach = s[6] === COMET ? GRAB_COMET : GRAB;
      if (sq(x - d.x) + sq(y - d.y) >= reach * reach) continue;
      d.g = Math.min(GOLD_MAX, d.g + s[4]);
      fx(w, 'grab', x, y, s[4], id, s[6]);
      took = true;
      break;
    }
    if (!took) keep.push(s);
  }
  w.ds = keep;
  const rush = w.ph === PLAY && PLAY_STEPS - w.pt >= RUSH_AT;
  const into = w.ph === PLAY ? PLAY_STEPS - w.pt : w.n;
  if (into > 0 && into % COMET_EVERY === 0 && w.ds.length < DUST_MAX) addDust(w, COMET, rush ? 2 * COMET_V : COMET_V);
  if (w.n % (rush ? DUST_EVERY / 2 : DUST_EVERY) !== 0) return;
  const cap = 8 + 2 * ids.length + (rush ? 4 : 0);
  if (w.ds.filter((s) => s[6] === DUST).length >= cap || w.ds.length >= DUST_MAX) return;
  addDust(w, DUST, rush ? 2 : 1);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!num(raw.sr, SUN_R, SUN_BIG)) return null;
  if (!Array.isArray(raw.ds) || raw.ds.length > DUST_MAX) return null;
  if (!raw.ds.every((s) => Array.isArray(s) && s.length === 7 && num(s[0], -2, 2) && num(s[1], -2, 2) &&
    num(s[2], -4, 4) && num(s[3], -4, 4) && int(s[4], 1, 2 * COMET_V) && int(s[5], 0, DUST_LIFE) && int(s[6], DUST, SPILL))) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, FLY, GONE) || !num(d.x, -2, 2) || !num(d.y, -2, 2) || !num(d.vx, -4, 4) || !num(d.vy, -4, 4)) return null;
    if (!(d.mf === FUEL || d.mf === FUEL_BIG) || !num(d.fu, 0, d.mf)) return null;
    if (inputOf([d.fr, d.ax, d.ay, d.q]) === null || !int(d.hq, 0, 1) || !int(d.th, 0, 1) || !int(d.cd, 0, KICK_CD)) return null;
    if (!int(d.sh, 0, SHIELD) || !int(d.rt, 0, BACK_STEPS) || !int(d.g, 0, GOLD_MAX) || !int(d.kn, 0, 99999)) return null;
    if (!int(d.wn, 0, 99999) || !int(d.lb, -BIG, BIG) || !int(d.lt, 0, BLAME_STEPS) || !int(d.bc, 0, 99) || !int(d.bw, 0, 99)) return null;
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
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, sr: raw.sr, ds: raw.ds.map((s) => s.slice()), p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, z, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, z: z === undefined ? 0 : z, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: deep violet space with a dusting of stars, a warm sun with a
// living corona, faint rings marking the orbits, pale blue stardust, golden
// dust when it is worth double, and every ship a bright arrow in its player's
// colour with a flame behind it while it burns.
const INK = {
  page: '#0a0820', glow: '#21194d', text: '#ffffff', muted: '#d6d2f5', dim: '#8f89bf', gold: '#ffd166',
  danger: '#ff5a6e', sun: '#ffd36b', sunHot: '#fff4c9', corona: '#ff8a3d', ring: 'rgba(160,150,255,0.13)',
  rim: 'rgba(190,180,255,0.4)', dust: '#bfeaff', comet: '#9ef0ff', panel: 'rgba(14,11,38,0.93)',
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a4290;' +
  `background:#1e1848;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
const SPAN = 2.3;              // the width of sky always on screen, past the edge of the system
let VW = 640, VH = 400, sc = 150, cx0 = 320, cy0 = 200, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340;
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

// The whole system is always on screen, as large as it fits. NOTE_ROOM under
// it keeps the practice note off the bottom of the system, and in a round the
// same strip says how much fuel you have and where your orbit is taking you.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  sc = Math.max(10, Math.min((VW - 16) / SPAN, ah / SPAN));
  cx0 = VW / 2;
  cy0 = TOP + ah / 2;
  fieldTop = cy0 - (SPAN / 2) * sc;
  fieldBot = cy0 + (SPAN / 2) * sc;
}

const SX = (x) => cx0 + x * sc + shakeX;
const SY = (y) => cy0 + y * sc + shakeY;
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
let chain = 0, chainAt = -1e9;
const sound = {
  burn() { if (ready('burn', 130)) puff(0.16, 0.035, 480, 0, 0.7, 'lowpass'); },
  grab(worth) {
    if (!ready('grab', 45)) return;
    const now = performance.now();
    chain = now - chainAt < 1500 ? Math.min(chain + 1, 8) : 0;
    chainAt = now;
    const f = 880 * (1 + chain * 0.09);
    tone(f, 0.08, 'triangle', 0.07);
    tone(f * 1.5, 0.12, 'triangle', 0.05, 0, 0.05);
    if (worth >= 3) tone(f * 2, 0.18, 'sine', 0.05, 0, 0.1);
  },
  kick() { if (ready('kick', 90)) { tone(260, 0.16, 'sawtooth', 0.04, 2.2); puff(0.2, 0.07, 1500, 0, 0.8); } },
  ram(mine) {
    if (!ready('ram', 90)) return;
    tone(110, 0.25, 'square', 0.06, 0.5);
    puff(0.3, 0.12, 900, 0, 0.8);
    if (mine) [660, 880].forEach((f, i) => tone(f, 0.1, 'triangle', 0.06, 0, 0.06 + i * 0.06));
  },
  rammed() { if (ready('rammed', 150)) { tone(150, 0.35, 'sawtooth', 0.07, 0.4); puff(0.4, 0.14, 700, 0, 0.7); } },
  bump() { if (ready('bump', 120)) tone(180, 0.1, 'sine', 0.06, 0.7); },
  burnUp() { if (ready('burnUp', 300)) { puff(0.9, 0.16, 300, 0, 0.5, 'lowpass'); tone(400, 0.8, 'sawtooth', 0.05, 0.2); } },
  drift() { if (ready('drift', 300)) { tone(660, 0.9, 'sine', 0.06, 0.25); tone(990, 0.7, 'sine', 0.03, 0.3, 0.1); } },
  lostFar() { if (ready('lostFar', 200)) puff(0.4, 0.05, 500, 0, 0.6); },
  bounty() { if (ready('bounty', 200)) [784, 988, 1319].forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, i * 0.06)); },
  back() { if (ready('back', 200)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.05)); },
  comet() { if (ready('comet', 400)) tone(1600, 0.5, 'sine', 0.03, 0.6); },
  fizz() { if (ready('fizz', 150)) puff(0.15, 0.025, 3000, 0, 1.2); },
  warn() { if (ready('warn', 400)) [392, 370, 349].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.04, 1, i * 0.18)); },
  rush() { if (ready('rush', 400)) [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.12, 'triangle', 0.07, 0, i * 0.07)); },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(220, 0.6, 'sawtooth', 0.05, 2); tone(330, 0.6, 'sawtooth', 0.04, 2); tone(660, 0.3, 'sine', 0.06, 1, 0.2); } },
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
// fast screen and a slow one see the same spray. Positions are sky units.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, drag }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0, flash = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, drag, bvx, bvy) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v + (bvx || 0), vy: Math.sin(a) * v + (bvy || 0), life: 0,
      max: 18 + Math.random() * 22, size, colour, drag: drag || 0.92 });
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
      b.vx *= b.drag; b.vy *= b.drag;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
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
const looks = new Map();      // id -> { trail, trailAt, seen, hit, squash }
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const lookOf = (id, now) => {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { trail: [], trailAt: 0, seen: now, hit: 0, squash: 0 }));
  return look;
};

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = md && md.st === FLY ? Math.max(0, 1 - Math.sqrt(sq(md.x - e.x) + sq(md.y - e.y)) / 1.2) : 0.4;
  if (e.kind === 'grab') {
    const colour = e.z >= 2 ? INK.gold : INK.dust;
    spray(e.x, e.y, e.b === COMET ? 14 : 7, colour, 0.25, 0.006, 0.88);
    ring(e.x, e.y, colour, 0.04);
    pop(e.x, e.y, '+' + e.z, e.z >= 2 ? INK.gold : INK.text, e.a === me ? 17 : 13);
    if (e.a === me) sound.grab(e.z);
  } else if (e.kind === 'kick') {
    const d = t.p[e.a];
    ring(e.x, e.y, colourOf(t, e.a), 0.05);
    if (d) spray(e.x, e.y, 8, '#ffe2a0', 0.3, 0.005, 0.85, -d.vx * 0.3, -d.vy * 0.3);
    if (e.a === me) { shake = Math.max(shake, 3); sound.kick(); }
  } else if (e.kind === 'ram') {
    spray(e.x, e.y, 18, '#ffffff', 0.45, 0.006, 0.86);
    spray(e.x, e.y, 10, colourOf(t, e.b), 0.35, 0.006, 0.86);
    ring(e.x, e.y, '#ffffff', 0.08);
    lookOf(e.b, performance.now()).hit = 1;
    lookOf(e.a, performance.now()).squash = 1;
    lookOf(e.b, performance.now()).squash = 1;
    if (e.b === me) {
      shake = Math.max(shake, 12);
      sound.rammed();
      if (e.z > 0) pop(e.x, e.y, '-' + e.z, INK.danger, 18);
    } else if (e.a === me) {
      shake = Math.max(shake, 7);
      sound.ram(true);
      pop(e.x, e.y, 'crash!', colourOf(t, me), 18);
    } else if (near > 0.3) sound.ram(false);
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 5, '#ffffff', 0.15, 0.004);
    lookOf(e.a, performance.now()).squash = 0.6;
    lookOf(e.b, performance.now()).squash = 0.6;
    if (e.a === me || e.b === me) { shake = Math.max(shake, 3); sound.bump(); }
  } else if (e.kind === 'lost') {
    const sun = e.z === 0;
    spray(e.x, e.y, 26, sun ? INK.corona : colourOf(t, e.a), 0.4, 0.007, 0.9);
    spray(e.x, e.y, 12, sun ? INK.sunHot : '#ffffff', 0.3, 0.005, 0.9);
    ring(e.x, e.y, colourOf(t, e.a), 0.12);
    if (e.a === me) {
      shake = Math.max(shake, sun ? 14 : 6);
      if (sun) { flash = Math.max(flash, 0.7); sound.burnUp(); pop(e.x, e.y, 'burned!', INK.danger, 20); }
      else { sound.drift(); pop(clamp(e.x, -0.85, 0.85), clamp(e.y, -0.85, 0.85), 'lost in space!', INK.danger, 18); }
    } else {
      if (sun) flash = Math.max(flash, 0.25);
      sound.lostFar();
    }
    const s = t.p[e.b];
    if (s && e.b !== -1) {
      pop(s.x, s.y - 0.06, '+' + BOUNTY, INK.gold, e.b === me ? 18 : 14);
      if (e.b === me) sound.bounty();
    }
    looks.delete(e.a);
  } else if (e.kind === 'back') {
    ring(e.x, e.y, colourOf(t, e.a), 0.09);
    if (e.a === me) { pop(e.x, e.y, 'back in orbit!', INK.text, 15); sound.back(); }
  } else if (e.kind === 'comet') {
    ring(e.x, e.y, INK.comet, 0.07);
    sound.comet();
  } else if (e.kind === 'fizz') {
    spray(e.x, e.y, 6, INK.corona, 0.15, 0.004);
    if (near > 0.5) sound.fizz();
  } else if (e.kind === 'warn') {
    pop(0, -0.35, 'the sun is swelling!', INK.gold, 22);
    sound.warn();
  } else if (e.kind === 'rush') {
    pop(0, -0.35, 'stardust shower! worth double', INK.gold, 20);
    sound.rush();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

// Stars, made once and drawn from their place on the screen's own shape, so
// a resize moves them with it.
const STARS = [];
for (let i = 0; i < 140; i++) {
  STARS.push({ x: Math.random(), y: Math.random(), r: Math.random() < 0.15 ? 1.4 : 0.7 + Math.random() * 0.5, tw: Math.random() * 6.3 });
}

function drawSky(now) {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.8);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  for (const s of STARS) {
    const a = 0.35 + 0.35 * Math.sin(now / 900 + s.tw);
    ctx.fillStyle = `rgba(230,225,255,${a.toFixed(3)})`;
    ctx.fillRect(s.x * VW, s.y * VH, s.r, s.r);
  }
}

// The rings that mark the orbits, the edge of the system, and the dark
// beyond it where a ship is lost; the stretch close to the sun where a tank
// fills fast glows faintly.
function drawSystem(t, now) {
  flat();
  const x = SX(0), y = SY(0);
  ctx.fillStyle = 'rgba(5,3,18,0.55)';
  disc(x, y, LOST_R * sc);
  ctx.fill();
  const g = ctx.createRadialGradient(x, y, 0, x, y, RIM * sc);
  g.addColorStop(0, 'rgba(70,50,150,0.35)');
  g.addColorStop(1, 'rgba(30,22,80,0.25)');
  ctx.fillStyle = g;
  disc(x, y, RIM * sc);
  ctx.fill();
  ctx.strokeStyle = INK.ring;
  ctx.lineWidth = 1;
  for (const r of [0.25, 0.5, 0.75]) { disc(x, y, r * sc); ctx.stroke(); }
  ctx.strokeStyle = INK.rim;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 6]);
  ctx.lineDashOffset = -now / 80;
  disc(x, y, RIM * sc);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,90,110,0.35)';
  ctx.setLineDash([2, 7]);
  disc(x, y, LOST_R * sc);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  const fill = ctx.createRadialGradient(x, y, t.sr * sc, x, y, 0.24 * sc);
  fill.addColorStop(0, 'rgba(255,200,90,0.16)');
  fill.addColorStop(1, 'rgba(255,200,90,0)');
  ctx.fillStyle = fill;
  disc(x, y, 0.24 * sc);
  ctx.fill();
}

// The sun: a glow, a body with a hotter middle, and a corona of flickering
// tongues that grows with it.
function drawSun(t, now) {
  flat();
  const x = SX(0), y = SY(0), r = t.sr * sc;
  const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3.2);
  glow.addColorStop(0, 'rgba(255,170,70,0.55)');
  glow.addColorStop(1, 'rgba(255,120,50,0)');
  ctx.fillStyle = glow;
  disc(x, y, r * 3.2);
  ctx.fill();
  ctx.fillStyle = alpha(INK.corona, 0.75);
  ctx.beginPath();
  const n = 18;
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 + now / 4000;
    const lick = i % 2 ? 1.08 : 1.22 + 0.12 * Math.sin(now / 180 + i * 1.7);
    const px = x + Math.cos(a) * r * lick, py = y + Math.sin(a) * r * lick;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  const body = ctx.createRadialGradient(x - r * 0.25, y - r * 0.25, r * 0.1, x, y, r);
  body.addColorStop(0, INK.sunHot);
  body.addColorStop(0.6, INK.sun);
  body.addColorStop(1, '#ffa94a');
  ctx.fillStyle = body;
  disc(x, y, r);
  ctx.fill();
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,220,160,${(flash * 0.35).toFixed(3)})`;
    ctx.fillRect(0, 0, VW, VH);
  }
}

// Stardust: a soft glint, golden when it is worth double; a comet a bright
// head with a tail streaming away from the sun; dust shed in a crash glints in
// the colour of nobody, and blinks as it is about to run out.
function drawDust(s, k, now, i) {
  if (s[5] < 3 * HZ && Math.floor(now / 140) % 2 === 0) return;
  const x = SX(s[0] - s[2] * DT * (1 - k)), y = SY(s[1] - s[3] * DT * (1 - k));
  const colour = s[6] === COMET ? INK.comet : s[4] >= 2 ? INK.gold : INK.dust;
  if (s[6] === COMET) {
    const [ux, uy] = unit(s[0], s[1]);
    const L = sc * 0.12;
    const g = ctx.createLinearGradient(x, y, x + ux * L, y + uy * L);
    g.addColorStop(0, alpha(colour, 0.7));
    g.addColorStop(1, alpha(colour, 0));
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(2, sc * 0.016);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + ux * L, y + uy * L);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  const r = Math.max(2, sc * (s[6] === COMET ? 0.014 : 0.009));
  const tw = 0.75 + 0.25 * Math.sin(now / 200 + i * 1.3);
  ctx.fillStyle = alpha(colour, 0.25);
  disc(x, y, r * 2.4 * tw);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y - r * 1.4);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r * 1.4);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  disc(x, y, r * 0.35);
  ctx.fill();
}

// Where your orbit takes you if you let go now: the same gravity the table
// runs, worked out ahead from where your ship is drawn, a dotted line that
// fades as it reaches further, red where it ends in the sun or past the rim.
// It is only a drawing: nothing in the table comes from it.
function drawPath(x, y, vx, vy, sr, colour) {
  const h = 1 / 60;
  let px = x, py = y, end = 0;
  const pts = [];
  for (let i = 0; i < 420; i++) {
    const r2 = px * px + py * py, r = Math.sqrt(r2);
    if (r < sr) { end = 1; break; }
    if (r > LOST_R) { end = 2; break; }
    const g = GM / (r2 * r);
    vx -= px * g * h;
    vy -= py * g * h;
    px += vx * h;
    py += vy * h;
    if (i % 4 === 0) pts.push([px, py]);
  }
  for (let i = 0; i < pts.length; i++) {
    const a = 0.55 * (1 - i / pts.length);
    ctx.fillStyle = end && i > pts.length - 12 ? `rgba(255,90,110,${(a + 0.3).toFixed(3)})` : alpha(colour, a.toFixed(3));
    disc(SX(pts[i][0]), SY(pts[i][1]), Math.max(1, sc * 0.005));
    ctx.fill();
  }
  if (end && pts.length) {
    const [ex, ey] = pts[pts.length - 1];
    const X = SX(ex), Y = SY(ey), s = Math.max(4, sc * 0.02);
    ctx.strokeStyle = INK.danger;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X - s, Y - s); ctx.lineTo(X + s, Y + s);
    ctx.moveTo(X + s, Y - s); ctx.lineTo(X - s, Y + s);
    ctx.stroke();
  }
  return end;
}

// A ship as drawn: an arrow pointing where the engine pushes while it burns,
// and the way it is moving while it coasts, with a flame behind it, a trail
// of where it has been, a flash where it was rammed, a little squash on every
// bump, a ring round your own and a blinking one round a shield.
function drawShip(id, x, y, d, colour, me, t, now) {
  const look = lookOf(id, now);
  look.seen = now;
  look.hit *= Math.pow(0.88, frameDt * 60);
  look.squash *= Math.pow(0.85, frameDt * 60);
  if (now - look.trailAt > 45) {
    look.trailAt = now;
    look.trail.push([x, y]);
    if (look.trail.length > 26) look.trail.shift();
  }
  const tr = look.trail;
  if (tr.length > 1) {
    ctx.lineCap = 'round';
    for (let i = 1; i < tr.length; i++) {
      ctx.strokeStyle = alpha(colour, ((i / tr.length) * 0.45).toFixed(3));
      ctx.lineWidth = Math.max(1, sc * 0.012 * (i / tr.length));
      ctx.beginPath();
      ctx.moveTo(SX(tr[i - 1][0]), SY(tr[i - 1][1]));
      ctx.lineTo(SX(tr[i][0]), SY(tr[i][1]));
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }
  const [ex, ey, thr] = engineOf(d);
  const burning = d.th === 1 && thr > 0;
  const [hx, hy] = burning ? [ex, ey] : unit(d.vx, d.vy);
  const sx = SX(x), sy = SY(y), R = Math.max(5, SHIP_R * sc * 1.15);
  if (burning && Math.random() < 0.7) {
    spray(x - hx * SHIP_R, y - hy * SHIP_R, 1, Math.random() < 0.5 ? '#ffd27a' : '#ff8a3d', 0.08, 0.005, 0.85, d.vx * 0.6 - hx * 0.35, d.vy * 0.6 - hy * 0.35);
  }
  if (d.sh > 0 && Math.floor(now / 120) % 2 === 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    disc(sx, sy, R * 1.7);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (me) {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    disc(sx, sy, R * 1.45);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(Math.atan2(hy, hx));
  const sq_ = 1 + look.squash * 0.35;
  ctx.scale(1 / sq_, sq_);
  if (burning) {
    const f = 0.7 + 0.3 * Math.sin(now / 40 + id);
    ctx.fillStyle = 'rgba(255,170,70,0.85)';
    ctx.beginPath();
    ctx.moveTo(-R * 0.55, -R * 0.38);
    ctx.lineTo(-R * (1.2 + 0.9 * thr * f), 0);
    ctx.lineTo(-R * 0.55, R * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,240,200,0.9)';
    ctx.beginPath();
    ctx.moveTo(-R * 0.55, -R * 0.2);
    ctx.lineTo(-R * (0.9 + 0.4 * thr * f), 0);
    ctx.lineTo(-R * 0.55, R * 0.2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.moveTo(R * 1.15 + 1.5, 1.5);
  ctx.lineTo(-R * 0.75 + 1.5, R * 0.8 + 1.5);
  ctx.lineTo(-R * 0.4 + 1.5, 1.5);
  ctx.lineTo(-R * 0.75 + 1.5, -R * 0.8 + 1.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = look.hit > 0.3 ? '#ffffff' : colour;
  ctx.beginPath();
  ctx.moveTo(R * 1.15, 0);
  ctx.lineTo(-R * 0.75, R * 0.8);
  ctx.lineTo(-R * 0.4, 0);
  ctx.lineTo(-R * 0.75, -R * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  disc(R * 0.3, 0, R * 0.22);
  ctx.fill();
  ctx.restore();
}

function drawBits() {
  flat();
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.strokeStyle = r.colour;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 2;
    disc(SX(r.x), SY(r.y), (r.r * (0.4 + k)) * sc);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const b of bits) {
    const k = b.life / b.max;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = b.colour;
    const s = Math.max(1, b.size * sc * (1 - k * 0.5));
    ctx.fillRect(SX(b.x) - s / 2, SY(b.y) - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const k = p.life / p.max;
    const rise = ease(Math.min(1, k * 1.5)) * 22;
    const s = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, (k - 0.15));
    ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(10,8,32,0.7)';
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const X = clamp(SX(p.x), 60, VW - 60), Y = SY(p.y) - rise;
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
  const into = PLAY_STEPS - t.pt;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left';
    if (into >= RUSH_AT) { status += ' · stardust shower'; colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text; }
    else if (into >= SWELL_AT) status += ' · the sun swells';
    else if (into >= SWELL_AT - 3 * HZ) status += ' · the sun stirs';
  } else status = 'round ' + t.rd + ' · over';
  text('orbit', 12, 22, titlePx, '#c9b8ff', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('orbit').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with their dust; the
  // chip of a lost ship is hollow.
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
      if (d.st === FLY) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      const score = String(d.g);
      ctx.font = font(12);
      const gw = ctx.measureText(score).width;
      text(score, x + cw - 8, y + 3, 12, INK.dust, 'right');
      const wins = t.ph !== WAIT && d.wn ? '★' + d.wn : '';
      ctx.font = font(10);
      const ww = wins ? ctx.measureText(wins).width + 5 : 0;
      if (wins && cw > 56) text(wins, x + cw - 12 - gw, y + 2, 10, '#efeaff', 'right');
      if (cw > 64) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st === FLY ? (mine ? INK.text : INK.muted) : INK.dim, cw - 34 - gw - ww, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to fire the engine that way · tap to kick'
    : 'hold the mouse to burn toward it · ↑↓ speed up or slow down, ←→ sideways · space kicks · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// Your fuel, whether a kick is ready and where your orbit is taking you, in
// the strip under the system while a round is on.
function drawMine(t, end) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = Math.min(fieldBot + NOTE_ROOM / 2 - 8, VH - BOT - 18);
  if (d.st !== FLY) {
    const line = t.ph === PLAY ? 'lost! you are back in orbit in a moment' : t.ph === COUNT ? 'get ready' : '';
    if (line) fitText(line, VW / 2, y + 5, 13, INK.muted, VW - 24);
    return;
  }
  const bar = Math.min(110, VW * 0.22);
  const tag = end === 1 ? 'falling into the sun!' : end === 2 ? 'drifting out of the system!' : d.cd === 0 && d.fu >= KICK_FUEL ? 'kick ready' : 'kick charging';
  const bad = end !== 0;
  ctx.font = font(12);
  const tagW = ctx.measureText(tag).width;
  const total = 34 + bar + 14 + tagW;
  let x = VW / 2 - total / 2;
  text('fuel', x, y + 4, 11, INK.dim, 'left');
  x += 34;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(x, y - 5, bar, 10, 5);
  ctx.fill();
  const k = d.fu / d.mf;
  ctx.fillStyle = k < 0.2 ? INK.danger : SEAT[d.c];
  roundRect(x, y - 5, Math.max(10, bar * k), 10, 5);
  ctx.fill();
  if (d.mf > FUEL) {
    ctx.fillStyle = INK.gold;
    disc(x + bar + 4, y, 2.5);
    ctx.fill();
  }
  x += bar + 14;
  text(tag, x, y + 4, 12, bad ? (Math.floor(performance.now() / 250) % 2 ? INK.danger : INK.text) : d.cd === 0 ? INK.text : INK.dim, 'left');
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
    const tip = two ? null : 'burn back to drop lower and catch up · coast near the sun to refuel';
    practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(10,8,32,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid - big * 1.6);
    text(String(n), cx, mid - big * 1.6, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.3, Math.min(VW - 32, 330), 30);
    fitText('the most stardust when time runs out wins', cx, mid + big * 2.3 + 5, 14, INK.text, Math.min(VW - 48, 310));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(10,8,32,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('fly!', cx, mid - big * 1.4);
    text('fly!', cx, mid - big * 1.4, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= 5 * HZ) {
    const n = Math.ceil(t.pt / HZ);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(10,8,32,0.6)';
    ctx.font = font(big * 2);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid - big * 1.6);
    text(String(n), cx, mid - big * 1.6, big * 2, INK.gold, 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 330), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody came out ahead';
    else head = t.win === me ? 'you hold the most stardust!' : nickOf(t.win) + ' holds the most stardust';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('dust', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('rams', cx + w / 2 - 62, y0 + 52, 10, INK.dim, 'right');
    text('rounds', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, g, kn, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(g), cx + w / 2 - 110, y, 14, INK.dust, 'right');
      text(String(kn), cx + w / 2 - 62, y, 13, '#efeaff', 'right');
      text('★' + wins, cx + w / 2 - 18, y, 13, INK.text, 'right');
    });
    fitText('the faster ship wins a crash · next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a ship is as drawn: between two steps, and never slid across a jump —
// a ship back in orbit after being lost.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 0.3) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

// Your own ship is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a hand a step away from where
// the guess had it. So the ship drawn is pulled toward the guess a little
// every frame rather than put on it, and a guess far off — a table taken
// afresh, a ship back in orbit — puts it there at once. Only the drawing is
// smoothed: the sky, and every rule in it, are untouched.
const PULL = 0.45;
let shown = null;        // [x, y]: where your ship is drawn
let myPos = null;        // the same, for the mouse to burn toward

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 0.2) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  fit();
  drawSky(now);
  const b = agreedAt(now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the sky…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  drawSystem(t, now);
  t.ds.forEach((s, i) => drawDust(s, b.k, now, i));
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st !== FLY) continue;
    const p = bodyAt(b, id);
    drawShip(id, p[0], p[1], d, SEAT[d.c], false, t, now);
  }
  let end = 0;
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own && own.to.p[me].st === FLY) {
    const p = bodyAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    const d = p[2];
    myPos = [x, y];
    if (t.ph !== END) end = drawPath(x, y, d.vx, d.vy, t.sr, SEAT[d.c]);
    drawShip(me, x, y, d, SEAT[d.c], true, t, now);
    if (d.th === 1 && t.ph !== COUNT) sound.burn();
  } else {
    myPos = shown = null;
  }
  drawSun(t, now);
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t, end);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: which way the engine points and how hard, and how many
// kicks so far. A change of the engine goes out no oftener than STEER_EVERY,
// because a thumb or a mouse changes it on every move the screen reports and
// the clock's ticks share the same seat's ceiling on messages; a kick goes out
// at once.
const STEER_EVERY = 80;
let mode = '';           // what steers: 'keys', 'mouse', 'touch', or nothing yet
let kicks = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_ALONG = { ArrowUp: 1, KeyW: 1, ArrowDown: -1, KeyS: -1 };
const KEY_ACROSS = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };

// The keys burn along and across the way the ship is moving: up speeds it up,
// down slows it down, left and right push it to either side of its path. A
// thumb: a stick from wherever it lands, the engine pointing the way it is
// pushed and burning harder the further; a tap kicks — a drag rather than a
// press, because iOS keeps a long press inside a frame for itself. A second
// finger down while the first steers kicks too. A mouse: hold a button and
// the engine burns toward the pointer; the right button kicks.
const DEAD = 9;
const REACHOUT = 52;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }
const mouse = { x: 0, y: 0, down: false };

function steerNow() {
  if (mode === 'keys') {
    let along = 0, across = 0;
    for (const c of keys) { if (c in KEY_ALONG) along += KEY_ALONG[c]; if (c in KEY_ACROSS) across += KEY_ACROSS[c]; }
    along = clamp(along, -1, 1);
    across = clamp(across, -1, 1);
    if (!along && !across) return [0, 0, 0];
    const l = Math.hypot(along, across);
    return [1, Math.round((along / l) * 1000), Math.round((across / l) * 1000)];
  }
  if (mode === 'touch') {
    if (!stick) return [0, 0, 0];
    const l = Math.hypot(stick.dx, stick.dy);
    if (l < DEAD) return [0, 0, 0];
    const k = clamp(0.3 + (0.7 * (l - DEAD)) / (REACHOUT - DEAD), 0.3, 1);
    return [0, clamp(Math.round((stick.dx / l) * 1000 * k), -1000, 1000), clamp(Math.round((stick.dy / l) * 1000 * k), -1000, 1000)];
  }
  if (mode === 'mouse' && mouse.down && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]);
    const l = Math.hypot(dx, dy);
    if (l < 4) return [0, 0, 0];
    return [0, clamp(Math.round((dx / l) * 1000), -1000, 1000), clamp(Math.round((dy / l) * 1000), -1000, 1000)];
  }
  return [0, 0, 0];
}

function sayHand(now, force) {
  const [fr, ax, ay] = steerNow();
  const h = [fr, ax, ay, kicks], s = lastSaid;
  if (s && h.every((v, i) => v === s[i])) return;
  if (!force && s && h[3] === s[3] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A kick: heard at once, and made a trip later on every copy alike, if the
// table says it is ready and there is fuel for it.
function kickNow() {
  wake();
  if (!world) return;
  kicks = (kicks + 1) % 1000;
  sayHand(performance.now(), true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyF' || e.code === 'KeyX') {
    e.preventDefault();
    if (!e.repeat) kickNow();
    return;
  }
  if (!(e.code in KEY_ALONG) && !(e.code in KEY_ACROSS)) return;
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
    if (stick) { kickNow(); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0, at: performance.now(), moved: false };
    paintStick();
    return;
  }
  coarse = false;
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  if (e.button === 2) { kickNow(); return; }
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mode = 'mouse';
  mouse.down = true;
  sayHand(performance.now(), true);
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    stick.dx = e.clientX - stick.ox;
    stick.dy = e.clientY - stick.oy;
    if (Math.hypot(stick.dx, stick.dy) >= DEAD) stick.moved = true;
    paintStick();
    sayHand(performance.now(), false);
  } else if (e.pointerType === 'mouse') {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
});
function liftPointer(e) {
  if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
    if (e.button === 2 || !mouse.down) return;
    mouse.down = false;
    sayHand(performance.now(), true);
    return;
  }
  if (!stick || e.pointerId !== stick.id) return;
  const tap = !stick.moved && performance.now() - stick.at < 260;
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
  if (tap) kickNow();
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

// Called by the kernel once it stands. Coasting is a hand too: it is how a
// player arrives in orbit.
function start() {
  setHand([0, 0, 0, kicks]);
  lastSaid = [0, 0, 0, kicks];
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
