/**
 * @disk     crumble
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Hex floors that fall away under your feet. Every tile you step on crumbles a moment later, three floors deep. Keep moving, hop over the gaps, and land a hop beside a rival to crack the ground under them. Last one standing takes the round.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/crumble.png
 */
// crumble.js — three floors of hexagons that fall away, where the room's order
// is the referee.
//
// Every copy holds every tile of all three floors and how long each one that
// has been stepped on has left, every player, how fast they slide and how
// long they have been in the air, and changes it only on what comes back round
// the room, so every copy applies the same hands in the same order and holds
// the same floors. Nobody sends where they stand, which tile fell or who went
// through it: a hand is the way a player pushes and a counter that moves on by
// one for every hop, and everything else is the same arithmetic on the same
// whole numbers on every machine. A page with a console open can steer its own
// player however it likes, at that player's own speed, and hop no more often
// than the round has given it hops.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own player does not wait for the trip: it is drawn from the agreed
// table played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — a tile is 104 units across, a speed
// is units a step — and use nothing but `+ - * /`, comparisons, `Math.floor`,
// `Math.trunc`, `Math.min`, `Math.max`, `Math.abs`, `Math.sqrt` and
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

// The whole part of a square root. `Math.sqrt` is rounded correctly by the
// language's own definition, so this is the same number on every machine.
const isqrt = (n) => (n <= 0 ? 0 : Math.floor(Math.sqrt(n)));

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own player a trip ahead, with your hand in it

// The floors: hexagons standing on a point, in axial coordinates (q, r). A
// tile's middle is at x = 104q + 52r, y = 90r, so neighbours are 104 apart.
const LAYERS = 3;
const RMAX = 7;                // the widest floor reaches this many tiles from its middle
const SPAN = 2 * RMAX + 1;
const HW = 104, HH = 52, VS = 90, HR = 60;
const HEX = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const TQ = [], TR = [], TRING = [];
const IDX = new Array(SPAN * SPAN).fill(-1);
for (let r = -RMAX; r <= RMAX; r++) {
  for (let q = -RMAX; q <= RMAX; q++) {
    const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
    if (ring > RMAX) continue;
    IDX[(r + RMAX) * SPAN + q + RMAX] = TQ.length;
    TQ.push(q); TR.push(r); TRING.push(ring);
  }
}
const NT = TQ.length;          // tiles a floor
const tileX = (i) => HW * TQ[i] + HH * TR[i];
const tileY = (i) => VS * TR[i];
const tileAt = (q, r) => (q < -RMAX || q > RMAX || r < -RMAX || r > RMAX ? -1 : IDX[(r + RMAX) * SPAN + q + RMAX]);
const NEAR = [];               // each tile's neighbours on its floor
for (let i = 0; i < NT; i++) {
  NEAR.push(HEX.map(([dq, dr]) => tileAt(TQ[i] + dq, TR[i] + dr)).filter((k) => k >= 0));
}

// The tile a point stands on, or -1 off every tile. The nearest middle on the
// lattice is the tile, and it is always one of the two nearest in each of the
// two rows round the point — including middles off the floor's edge, which
// are holes.
function hexAt(x, y) {
  const r0 = Math.floor(y / VS);
  let bq = 0, br = 0, bd = Infinity;
  for (let r = r0; r <= r0 + 1; r++) {
    const q0 = Math.floor((x - HH * r) / HW);
    for (let q = q0; q <= q0 + 1; q++) {
      const ex = x - (HW * q + HH * r), ey = y - VS * r, d = ex * ex + ey * ey;
      if (d < bd) { bd = d; bq = q; br = r; }
    }
  }
  return tileAt(bq, br);
}

// The tiles of one ring round the middle, walked the same way every time.
function ringTiles(k) {
  if (k === 0) return [tileAt(0, 0)];
  const out = [];
  let q = HEX[4][0] * k, r = HEX[4][1] * k;
  for (let side = 0; side < 6; side++) {
    for (let j = 0; j < k; j++) {
      out.push(tileAt(q, r));
      q += HEX[side][0];
      r += HEX[side][1];
    }
  }
  return out;
}

const SPEED = 14;              // units a step at a full push
const ACCEL = 3;               // a step closes a third of the gap to the speed pushed for
const VMAX = 60;               // the fastest anybody ever slides
const PR = 30;                 // a player's radius
const BUMP = 5;                // what two players who touch give each other at the least
const HOP_V = 22;              // units a step through the air
const AIR = 12;                // steps a hop lasts
const HOPS0 = 2;               // hops a round starts with
const HOPS_MAX = 5;
const STOMP_CR = 8;            // a hop's landing leaves the tiles round it this long
const STOMP_R = 210;           // and shoves anybody this near
const STOMP_V = 26;
const FALL = 12;               // steps from a hole to the floor below
const CR0 = 16;                // steps from stepping on a tile to its fall
const CR_LATE = 11;            // the same once the rim starts to go
const RING_CR = 30;            // a ring of the rim cracks this long before it drops
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const POS = 3000;              // nobody stands further than this from the middle
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 6 * HZ;
const COLLAPSE_AT = 25 * HZ;   // steps into a round when the rim starts to go
const COLLAPSE_EVERY = 5 * HZ; // steps between two rings of it
const BACK_STEPS = Math.round(1.5 * HZ);  // a practising player who fell through is back this soon
const FRESH_SHARE = 0.3;       // under this share of the top floor left, practice lays new floors

const ON = 0, FALLING = 1, OUT = 2;

// How wide the floors are for so many players: wide enough to run, small
// enough that the holes meet before long.
const radFor = (n) => (n <= 2 ? 5 : n <= 4 ? 6 : 7);

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   rad: how far the floors reach; tl: every tile of every floor, the top
//   floor's first: 0 whole, a count of steps to its fall once stepped on, -1
//   gone; cr: how long a tile lasts once stepped on; cn: the next ring of the
//   rim to go; outs: players through the last floor this round; res: the last
//   round's [id, players outlasted, points, rounds won] rows; win: its winner
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, rad: radFor(2), cr: CR0, cn: 0, outs: 0, tl: [], p: {}, res: null, win: -1 };
  lay(w);
  return w;
}

function lay(w) {
  w.tl = [];
  for (let z = 0; z < LAYERS; z++) for (let i = 0; i < NT; i++) w.tl.push(TRING[i] <= w.rad ? 0 : -1);
  w.cr = CR0;
  w.cn = w.rad;
}

const FIELDS = ['c', 's', 'st', 'z', 'x', 'y', 'vx', 'vy', 'dx', 'dy', 'q', 'hq', 'air', 'hops', 'fl', 'rt', 'ot',
  'pts', 'wn', 'bt', 'bw', 'bc', 'hs', 'hc'];
//   c: colour; s: seat; st: on a floor, falling, or out; z: which floor, the
//   top one 0; x, y, vx, vy: where and how fast, in units; dx, dy: the way the
//   hand pushes, a thousand at full; q: the hop counter as last heard; hq: a
//   hop to take this step; air: steps of a hop left; hops: hops left this
//   round; fl: steps of a fall left; rt: steps until a practising player who
//   fell through is back; ot: players outlasted this round, -1 while still in;
//   pts: points; wn: rounds won; bt, bw: the bot's heading and its pause; bc:
//   steps until a bump makes a sound again; hs, hc: hands this step.
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
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: OUT, z: 0, x: 0, y: 0, vx: 0, vy: 0, dx: 0, dy: 0, q, hq: 0, air: 0,
    hops: HOPS0, fl: 0, rt: 0, ot: -1, pts: 0, wn: 0, bt: -1, bw: 0, bc: 0, hs: w.n, hc: 0,
  });
}

// Standing a player on a tile of the top floor, still and on their feet.
function standOn(w, d, i) {
  d.st = ON;
  d.z = 0;
  d.x = tileX(i);
  d.y = tileY(i);
  d.vx = d.vy = d.air = d.fl = d.rt = d.hq = 0;
  d.ot = -1;
  d.bt = -1;
  d.bw = 0;
}

// Where a seat starts a round: spread round a ring a little in from the rim.
function startTile(w, seat, n) {
  const ring = ringTiles(Math.max(1, w.rad - 2));
  return ring[Math.floor((seat * ring.length) / Math.max(1, n))];
}

// Practice: a whole tile of the top floor as far from everybody else as there
// is, near the player's own start; -1 when the top floor has none left.
function spawnTile(w, id) {
  const d = w.p[id];
  const home = startTile(w, d.s, MAX_P);
  let best = -1, score = -Infinity;
  for (let i = 0; i < NT; i++) {
    if (w.tl[i] !== 0) continue;
    let near = 1e9;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o === id || e.st !== ON || e.z !== 0) continue;
      near = Math.min(near, Math.abs(e.x - tileX(i)) + Math.abs(e.y - tileY(i)));
    }
    const s = Math.min(near, 600) - (Math.abs(tileX(i) - tileX(home)) + Math.abs(tileY(i) - tileY(home))) / 4;
    if (s > score) { score = s; best = i; }
  }
  return best;
}

function wholeShare(w) {
  let whole = 0, all = 0;
  for (let i = 0; i < NT; i++) {
    if (TRING[i] > w.rad) continue;
    all += 1;
    if (w.tl[i] === 0) whole += 1;
  }
  return all ? whole / all : 0;
}

// Practice, from the top: new floors, and everybody back on the top one.
function freshFloors(w) {
  lay(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    standOn(w, d, startTile(w, d.s, MAX_P));
    d.hops = HOPS0;
  }
  fx(w, 'fresh', 0, 0, 0);
}

function respawn(w, id) {
  const i = spawnTile(w, id);
  if (i < 0 || wholeShare(w) < FRESH_SHARE) { freshFloors(w); return; }
  const d = w.p[id];
  standOn(w, d, i);
  d.hops = HOPS0;
  fx(w, 'back', d.x, d.y, 0, id);
}

// A hand, at its place in the room's order: [the way pushed, across and down,
// the hop counter]. A hop is asked for once, when the counter changes; the
// same hand said again to keep a player at the table hops nobody. Being heard
// is how a player arrives: on the top floor while the table waits for a round
// or counts one in, and watching from the rim while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[2]);
    if (w.ph === WAIT) respawn(w, id);
    else if (w.ph === COUNT) standOn(w, d, startTile(w, d.s, playersIn(w).length));
    d.dx = input[0];
    d.dy = input[1];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; what a hop costs is the round's to say, not the hand's.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.dx = input[0];
  d.dy = input[1];
  if (input[2] !== d.q) { d.q = input[2]; d.hq = 1; }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
// How fast a player goes is the table's business: a push names a share of the
// top speed, and nothing a hand says makes it more than all of it.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [a, b, q] = raw;
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(q)) return null;
  if (a < -1000 || a > 1000 || b < -1000 || b > 1000 || q < 0 || q > 999) return null;
  return [a, b, q];
}

function leave(w, id) {
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions
const BOT_IDLE = 0.07;         // how often it stands a moment rather than decide
const BOT_HOP = 0.6;           // how often it takes a hop over a gap it sees
const BOT_STOMP = 0.12;        // how often it hops at a rival close by
// Twelve ways to go, a thousand long, whole numbers on every machine.
const BDIR = [[1000, 0], [866, 500], [500, 866], [0, 1000], [-500, 866], [-866, 500], [-1000, 0], [-866, -500],
  [-500, -866], [0, -1000], [500, -866], [866, -500]];
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    respawn(w, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// What a tile of a floor is under a point: 0 whole, a count while it
// crumbles, -1 a hole.
function floorAt(w, z, x, y) {
  const i = hexAt(x, y);
  return i < 0 ? -1 : w.tl[z * NT + i];
}

// How good a way looks: whole ground along it with whole ground round it, no
// hole close ahead, and a little toward the middle, where the floor lasts
// longest. A crumbling tile counts as ground only if it will still be there
// when the bot gets to it.
function wayScore(w, d, k) {
  const [ux, uy] = BDIR[k];
  let s = 0, last = -2;
  for (let far = 60; far <= 420; far += 60) {
    const i = hexAt(d.x + Math.trunc((ux * far) / 1000), d.y + Math.trunc((uy * far) / 1000));
    if (i === last) continue;
    last = i;
    const v = i < 0 ? -1 : w.tl[d.z * NT + i];
    if (v < 0 || (v > 0 && v <= Math.trunc(far / SPEED) + 2)) { s -= far <= 120 ? 40 : far <= 240 ? 14 : 4; break; }
    s += v === 0 ? 5 : 1;
    if (far === 180 || far === 360) for (const n of NEAR[i]) if (w.tl[d.z * NT + n] === 0) s += 1;
  }
  return s + Math.trunc((-d.x * ux - d.y * uy) / 100000);
}

function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== ON || d.air > 0) return;
  if (d.bw > 0) { d.bw -= 1; d.dx = d.dy = 0; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 3 + Math.floor(draw01(w) * 6); d.dx = d.dy = 0; return; }
  let best = 0, score = -Infinity;
  for (let k = 0; k < BDIR.length; k++) {
    const s = wayScore(w, d, k) + (k === d.bt ? 3 : 0) + Math.floor(draw01(w) * 3);
    if (s > score) { score = s; best = k; }
  }
  d.bt = best;
  d.dx = BDIR[best][0];
  d.dy = BDIR[best][1];
  if (d.hops <= 0) return;
  // A gap just ahead with ground past it is a hop; so, now and then, is a
  // rival on the same floor close enough to shake.
  const [ux, uy] = BDIR[best];
  const ahead = floorAt(w, d.z, d.x + Math.trunc(ux / 10), d.y + Math.trunc(uy / 10));
  const past = floorAt(w, d.z, d.x + Math.trunc((ux * 23) / 100), d.y + Math.trunc((uy * 23) / 100));
  if ((ahead < 0 || score < -25) && past >= 0 && draw01(w) < BOT_HOP) { d.hq = 1; return; }
  for (const id of humans(w)) {
    const e = w.p[id];
    if (e.st !== ON || e.z !== d.z || e.air > 0) continue;
    if (Math.abs(e.x - d.x) + Math.abs(e.y - d.y) < 260 && draw01(w) < BOT_STOMP) {
      const far = isqrt((e.x - d.x) * (e.x - d.x) + (e.y - d.y) * (e.y - d.y)) || 1;
      d.dx = Math.trunc(((e.x - d.x) * 1000) / far);
      d.dy = Math.trunc(((e.y - d.y) * 1000) / far);
      d.hq = 1;
      return;
    }
  }
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  w.rad = radFor(2);
  lay(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    standOn(w, d, startTile(w, d.s, MAX_P));
    d.hops = HOPS0;
  }
}

// A round: new floors sized for the players, the seats closed up in order,
// everybody back on the top floor and still. Whoever has the fewest points,
// when somebody has more, starts with a hop to spare.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.outs = 0;
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  w.rad = radFor(ids.length);
  lay(w);
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) { lo = Math.min(lo, w.p[id].pts); hi = Math.max(hi, w.p[id].pts); }
  for (const id of ids) {
    const d = w.p[id];
    standOn(w, d, startTile(w, d.s, ids.length));
    d.hops = HOPS0 + (hi > lo && d.pts === lo ? 1 : 0);
  }
  fx(w, 'round', 0, 0, 0);
}

// The round is over: whoever is still on a floor outlasted everybody who went
// through, and a point is a player outlasted.
function finish(w) {
  const ids = bySeat(w);
  const still = ids.filter((id) => w.p[id].st !== OUT && w.p[id].ot < 0);
  for (const id of still) w.p[id].ot = w.outs;
  let top = -1;
  for (const id of ids) top = Math.max(top, w.p[id].ot);
  const best = ids.filter((id) => w.p[id].ot === top && top >= 0);
  w.win = best.length === 1 ? best[0] : -1;
  for (const id of ids) {
    const d = w.p[id];
    if (d.ot > 0) d.pts += d.ot;
  }
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, w.p[id].ot, w.p[id].pts, w.p[id].wn]);
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
  // Nobody moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      d.hq = 0;
      d.vx = d.vy = 0;
    }
    return;
  }
  floors(w);
}

function floors(w) {
  const practice = w.ph === WAIT;
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) control(w, w.p[id]);
  for (const id of ids) {
    const d = w.p[id];
    if (d.st === OUT) continue;
    d.x = Math.max(-POS, Math.min(POS, d.x + d.vx));
    d.y = Math.max(-POS, Math.min(POS, d.y + d.vy));
    if (d.bc > 0) d.bc -= 1;
  }
  bumps(w, ids);
  // Feet on the floor: a whole tile starts to crumble under them, and a hole
  // is a fall. A hop's end is a landing, which shakes the tiles round it.
  const through = [];
  for (const id of ids) {
    const d = w.p[id];
    if (d.st === ON) {
      if (d.air > 0) {
        d.air -= 1;
        if (d.air === 0) land(w, id);
        continue;
      }
      stand(w, id);
    } else if (d.st === FALLING) {
      d.vx = Math.trunc((d.vx * 3) / 4);
      d.vy = Math.trunc((d.vy * 3) / 4);
      if (--d.fl > 0) continue;
      d.z += 1;
      if (d.z >= LAYERS) { through.push(id); continue; }
      d.st = ON;
      fx(w, 'drop', d.x, d.y, d.z, id);
      stand(w, id);
    }
  }
  // Everybody through the last floor in the same step shares a place.
  for (const id of through) {
    const d = w.p[id];
    d.st = OUT;
    d.z = LAYERS - 1;
    d.vx = d.vy = 0;
    d.ot = w.outs;
    d.rt = BACK_STEPS;
    fx(w, 'out', d.x, d.y, LAYERS - 1, id);
  }
  w.outs += through.length;
  for (let k = 0; k < w.tl.length; k++) {
    const v = w.tl[k];
    if (v > 0 && --w.tl[k] === 0) {
      w.tl[k] = -1;
      const i = k % NT;
      fx(w, 'fall', tileX(i), tileY(i), (k - i) / NT, k);
    }
  }
  if (practice) {
    for (const id of ids) {
      const d = w.p[id];
      if (d && d.st === OUT && d.rt > 0 && --d.rt === 0) respawn(w, id);
    }
    return;
  }
  collapse(w);
  let still = 0;
  for (const id of ids) if (w.p[id].st !== OUT) still += 1;
  if (still <= 1) finish(w);
}

// A push becomes a speed, closed on a third at a time on the ground; in the
// air a player goes the way the hop sent them. A hop asked for is taken if
// there is one left and the player stands on a floor.
function control(w, d) {
  if (d.st !== ON) { d.hq = 0; return; }
  if (d.hq) {
    d.hq = 0;
    if (d.air === 0 && d.hops > 0) {
      d.hops -= 1;
      d.air = AIR;
      const push = isqrt(d.dx * d.dx + d.dy * d.dy), sp = isqrt(d.vx * d.vx + d.vy * d.vy);
      if (push >= 300) {
        d.vx = Math.trunc((d.dx * HOP_V) / push);
        d.vy = Math.trunc((d.dy * HOP_V) / push);
      } else if (sp >= 3) {
        d.vx = Math.trunc((d.vx * HOP_V) / sp);
        d.vy = Math.trunc((d.vy * HOP_V) / sp);
      } else d.vx = d.vy = 0;
      fx(w, 'hop', d.x, d.y, d.z, idOf(w, d));
      return;
    }
  }
  if (d.air > 0) return;
  const push = isqrt(d.dx * d.dx + d.dy * d.dy);
  const tx = push < 120 ? 0 : Math.trunc((d.dx * SPEED) / Math.max(push, 1000));
  const ty = push < 120 ? 0 : Math.trunc((d.dy * SPEED) / Math.max(push, 1000));
  d.vx += Math.trunc((tx - d.vx) / ACCEL);
  d.vy += Math.trunc((ty - d.vy) / ACCEL);
  if (Math.abs(tx - d.vx) < ACCEL) d.vx = tx;
  if (Math.abs(ty - d.vy) < ACCEL) d.vy = ty;
}

function idOf(w, d) {
  for (const id of playersIn(w)) if (w.p[id] === d) return id;
  return 0;
}

function stand(w, id) {
  const d = w.p[id];
  const i = hexAt(d.x, d.y);
  const k = i < 0 ? -1 : d.z * NT + i;
  if (k < 0 || w.tl[k] < 0) {
    d.st = FALLING;
    d.fl = FALL;
    d.air = 0;
    fx(w, 'slip', d.x, d.y, d.z, id);
    return;
  }
  if (w.tl[k] === 0) w.tl[k] = w.cr;
}

function land(w, id) {
  const d = w.p[id];
  d.vx = Math.trunc((d.vx * 6) / 10);
  d.vy = Math.trunc((d.vy * 6) / 10);
  const i = hexAt(d.x, d.y);
  if (i < 0 || w.tl[d.z * NT + i] < 0) { stand(w, id); return; }
  for (const c of [i].concat(NEAR[i])) {
    const k = d.z * NT + c;
    if (w.tl[k] === 0) w.tl[k] = STOMP_CR;
    else if (w.tl[k] > STOMP_CR) w.tl[k] = STOMP_CR;
  }
  fx(w, 'land', d.x, d.y, d.z, id);
  for (const o of playersIn(w)) {
    const e = w.p[o];
    if (o === id || e.st !== ON || e.z !== d.z || e.air > 0) continue;
    const ex = e.x - d.x, ey = e.y - d.y, far = isqrt(ex * ex + ey * ey);
    if (far >= STOMP_R) continue;
    const kick = Math.trunc((STOMP_V * (STOMP_R - far)) / STOMP_R) + 4;
    const f = far || 1;
    e.vx = clampV(e.vx + Math.trunc(((far ? ex : 1) * kick) / f));
    e.vy = clampV(e.vy + Math.trunc(((far ? ey : 0) * kick) / f));
  }
  stand(w, id);
}

const clampV = (v) => (v < -VMAX ? -VMAX : v > VMAX ? VMAX : v);

// Two players on one floor, both on their feet or both in the air, never
// stand in each other: they are put apart and the one that ran in shoves the
// other on, harder the faster it came.
function bumps(w, ids) {
  for (let a = 0; a < ids.length; a++) {
    const p = w.p[ids[a]];
    if (p.st !== ON) continue;
    for (let b = a + 1; b < ids.length; b++) {
      const o = w.p[ids[b]];
      if (o.st !== ON || o.z !== p.z || (o.air > 0) !== (p.air > 0)) continue;
      let dx = o.x - p.x, dy = o.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 4 * PR * PR) continue;
      let far = isqrt(d2);
      if (far === 0) { dx = 1; dy = 0; far = 1; }
      const over = 2 * PR - far, half = Math.floor(over / 2) + 1;
      p.x -= Math.trunc((dx * half) / far);
      p.y -= Math.trunc((dy * half) / far);
      o.x += Math.trunc((dx * half) / far);
      o.y += Math.trunc((dy * half) / far);
      const closing = Math.trunc(((p.vx - o.vx) * dx + (p.vy - o.vy) * dy) / far);
      const j = Math.max(0, closing) + BUMP;
      p.vx = clampV(p.vx - Math.trunc((dx * j) / far));
      p.vy = clampV(p.vy - Math.trunc((dy * j) / far));
      o.vx = clampV(o.vx + Math.trunc((dx * j) / far));
      o.vy = clampV(o.vy + Math.trunc((dy * j) / far));
      if (closing > 6 && p.bc === 0 && o.bc === 0) {
        p.bc = o.bc = 6;
        fx(w, 'bump', (p.x + o.x) >> 1, (p.y + o.y) >> 1, p.z, ids[a], closing);
      }
    }
  }
}

// The rim goes, ring by ring, on every floor at once: each ring cracks a
// while before it drops, and every tile still standing goes faster once it
// has begun.
function collapse(w) {
  const into = PLAY_STEPS - w.pt;
  if (into === COLLAPSE_AT - 2 * HZ) fx(w, 'warn', 0, 0, 0);
  if (into < COLLAPSE_AT || (into - COLLAPSE_AT) % COLLAPSE_EVERY !== 0 || w.cn < 0) return;
  for (const i of ringTiles(w.cn)) {
    for (let z = 0; z < LAYERS; z++) {
      const k = z * NT + i;
      if (w.tl[k] === 0 || w.tl[k] > RING_CR) w.tl[k] = RING_CR;
    }
  }
  w.cn -= 1;
  w.cr = CR_LATE;
  fx(w, 'collapse', 0, 0, 0);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.rad, 2, RMAX) || !int(raw.cr, 1, CR0) || !int(raw.cn, -1, RMAX) || !int(raw.outs, 0, MAX_P)) return null;
  if (!Array.isArray(raw.tl) || raw.tl.length !== LAYERS * NT) return null;
  if (!raw.tl.every((v, k) => int(v, -1, RING_CR) && (TRING[k % NT] <= raw.rad || v === -1))) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, ON, OUT) || !int(d.z, 0, LAYERS - 1) || !int(d.x, -POS, POS) || !int(d.y, -POS, POS)) return null;
    if (!int(d.vx, -VMAX, VMAX) || !int(d.vy, -VMAX, VMAX) || inputOf([d.dx, d.dy, d.q]) === null) return null;
    if (!int(d.hq, 0, 1) || !int(d.air, 0, AIR) || !int(d.hops, 0, HOPS_MAX) || !int(d.fl, 0, FALL)) return null;
    if (!int(d.rt, 0, BACK_STEPS) || !int(d.ot, -1, MAX_P) || !int(d.pts, 0, 999999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bt, -1, BDIR.length - 1) || !int(d.bw, 0, 99) || !int(d.bc, 0, 99)) return null;
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
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, rad: raw.rad, cr: raw.cr, cn: raw.cn, outs: raw.outs,
    tl: raw.tl.slice(), p, res, win: raw.win,
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
// One palette: three floors lit from above over a dark shaft. Honey on top,
// mint below it, lilac at the bottom, every tile going ember-red as it
// crumbles, and a bright colour for each player, ringed in ink so it reads on
// any floor.
const INK = {
  page: '#14132e', glow: '#2a2763', pit: '#07071a', text: '#ffffff', muted: '#cbc6ea', dim: '#8e89b6',
  gold: '#ffd166', danger: '#ff5a6e', ember: '#ff6a3d', outline: '#191733', panel: 'rgba(18,16,38,0.93)',
};
const FLOOR_TOP = ['#ffcf5c', '#5fd4c4', '#b49cff'];
const FLOOR_SIDE = ['#b9822a', '#2b8a82', '#6a52c2'];
const FLOOR_LINE = ['#fff0bf', '#c4fff6', '#e6dcff'];
const FLOOR_NAME = ['top floor', 'middle floor', 'last floor'];
const LK = [1, 0.8, 0.64];     // how large each floor is drawn: the lower, the further
const SEAT = ['#ff4f7b', '#3fa9ff', '#f4f4ff', '#ff8a2e', '#9cff3a', '#e25cff', '#ff2e2e', '#20e3ff'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a4580;' +
  `background:#25224a;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, sc = 0.2, cx = 320, cy = 200, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340;
let shownRad = 0;
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

// The field fits the floors as wide as this round has them, with a little room
// above the top row for names. NOTE_ROOM under it keeps the practice note off
// the bottom row, and in a round the same strip says how many hops you have.
function fit(rad) {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  const hw = rad * HW + HH + 16, hh = rad * VS + HR + 26;
  sc = Math.max(0.02, Math.min((VW - 16) / (2 * hw), ah / (2 * hh + 50)));
  fieldTop = TOP + (ah - (2 * hh + 50) * sc) / 2;
  cx = VW / 2;
  cy = fieldTop + (50 + hh) * sc;
  fieldBot = cy + hh * sc;
}

// Field units to the screen, on a floor drawn `k` as large as the top one.
const SX = (x, k) => cx + x * sc * k + shakeX;
const SY = (y, k) => cy + y * sc * k + shakeY;
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
  crumble(near) { if (ready('crumble', 70)) { puff(0.18, 0.03 + 0.06 * near, 420, 0, 0.8); tone(120, 0.12, 'sine', 0.03 + 0.05 * near, 0.5); } },
  hop() { if (ready('hop', 60)) { tone(330, 0.16, 'triangle', 0.1, 2.2); puff(0.08, 0.03, 2600, 0, 2); } },
  land(near) {
    if (!ready('land', 60)) return;
    tone(110, 0.18, 'sine', 0.08 + 0.14 * near, 0.5);
    puff(0.2, 0.04 + 0.08 * near, 300, 0, 0.7);
  },
  bump(hard) { if (ready('bump', 70)) { tone(200 + 60 * hard, 0.07, 'square', 0.04, 0.6); puff(0.06, 0.06, 900, 0, 1.5); } },
  slip(me) { if (ready('slip', 90)) tone(me ? 620 : 520, me ? 0.5 : 0.3, 'triangle', me ? 0.09 : 0.05, 0.35); },
  drop() { if (ready('drop', 120)) { tone(90, 0.16, 'sine', 0.12, 0.6); puff(0.1, 0.06, 500, 0, 1); } },
  out(me) {
    if (!ready('out', 80)) return;
    if (me) { tone(520, 0.6, 'sawtooth', 0.06, 0.25); tone(260, 0.6, 'triangle', 0.08, 0.3, 0.05); }
    else tone(440, 0.3, 'triangle', 0.07, 0.4);
  },
  back() { if (ready('back', 200)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.05)); },
  fresh() { if (ready('fresh', 300)) [392, 523, 659, 784].forEach((f, i) => tone(f, 0.14, 'triangle', 0.08, 0, i * 0.06)); },
  rumble() { if (ready('rumble', 300)) { puff(0.7, 0.08, 140, 0, 0.6); tone(60, 0.6, 'sine', 0.1, 0.8); } },
  warn() { if (ready('warn', 400)) [392, 370, 349].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.04, 1, i * 0.18)); },
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
// fast screen and a slow one see the same dust. Positions are field units on
// a floor drawn `k` as large as the top one.
const bits = [];      // { x, y, k, vx, vy, vz, z, life, max, size, colour }
const pops = [];      // { x, y, k, s, colour, life, max, px }
const rings = [];     // { x, y, k, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, k, count, colour, speed, size, up) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, k, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7, vz: (up || 0) * (0.5 + Math.random()), z: 0, life: 0, max: 18 + Math.random() * 22, size, colour });
  }
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}
function pop(x, y, k, s, colour, px) { pops.push({ x, y, k, s, colour, life: 0, max: 60, px: px || 15 }); }
function ring(x, y, k, colour, r) { rings.push({ x, y, k, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let j = 0; j < n; j++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.92; b.vy *= 0.92;
      b.z += b.vz / BIT_HZ;
      b.vz -= 2400 / BIT_HZ;
      if (b.z < 0) { b.z = 0; b.vz = -b.vz * 0.3; }
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
const looks = new Map();      // id -> { x, y, squash, seen, fx, fy }
const fellAt = new Map();     // tile of a floor -> when it fell, for its drop
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const kOf = (z) => LK[Math.max(0, Math.min(LAYERS - 1, z))];

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const k = kOf(e.z);
  const near = md && md.st !== OUT ? Math.max(0, 1 - (Math.abs(md.x - e.x) + Math.abs(md.y - e.y)) / (6 * HW)) : 0.2;
  if (e.kind === 'fall') {
    fellAt.set(e.a, performance.now());
    spray(e.x, e.y, k, 5, FLOOR_SIDE[e.z] || INK.dim, 2 * HW, 9, 300);
    if (md && md.z === e.z && near > 0.6) sound.crumble(near);
  } else if (e.kind === 'hop') {
    spray(e.x, e.y, k, 6, '#ffffff', 2 * HW, 6, 200);
    if (e.a !== me) sound.hop();
  } else if (e.kind === 'land') {
    ring(e.x, e.y, k, colourOf(t, e.a), STOMP_R);
    spray(e.x, e.y, k, 14, FLOOR_LINE[e.z] || '#ffffff', 4 * HW, 8, 500);
    shake = Math.max(shake, 2 + 8 * near);
    const look = looks.get(e.a);
    if (look) look.squash = 1;
    sound.land(near);
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, k, 8, '#ffffff', 3 * HW, 6, 200);
    if (e.a === me || (md && Math.abs(md.x - e.x) + Math.abs(md.y - e.y) < 3 * PR)) shake = Math.max(shake, 5);
    sound.bump(Math.min(1, e.b / 30));
  } else if (e.kind === 'slip') {
    pop(e.x, e.y, k, e.a === me ? 'whoops!' : 'slip!', colourOf(t, e.a), e.a === me ? 17 : 13);
    sound.slip(e.a === me);
  } else if (e.kind === 'drop') {
    ring(e.x, e.y, k, colourOf(t, e.a), 1.2 * HW);
    spray(e.x, e.y, k, 10, FLOOR_TOP[e.z] || '#ffffff', 3 * HW, 7, 400);
    if (e.a === me) {
      shake = Math.max(shake, 9);
      pop(e.x, e.y, k, 'down to the ' + FLOOR_NAME[e.z] + '!', FLOOR_LINE[e.z], 16);
    }
    sound.drop();
  } else if (e.kind === 'out') {
    const colour = colourOf(t, e.a);
    ring(e.x, e.y, k, colour, 1.6 * HW);
    pop(e.x, e.y, k, e.a === me ? 'you fell through!' : nickOf(e.a) + ' is out', colour, e.a === me ? 18 : 14);
    if (e.a === me) shake = Math.max(shake, 14);
    sound.out(e.a === me);
  } else if (e.kind === 'back') {
    ring(e.x, e.y, 1, colourOf(t, e.a), 1.1 * HW);
    if (e.a === me) sound.back();
  } else if (e.kind === 'fresh') {
    fellAt.clear();
    pop(0, 0, 1, 'fresh floors', INK.gold, 22);
    sound.fresh();
  } else if (e.kind === 'warn') {
    pop(0, -VS, 1, 'the rim is going!', INK.gold, 22);
    sound.warn();
  } else if (e.kind === 'collapse') {
    shake = Math.max(shake, 6);
    sound.rumble();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'round') {
    fellAt.clear();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

function drawGround(now) {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.5, 10, VW / 2, VH * 0.5, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // The shaft the floors hang in: darker toward its bottom.
  const r = (shownRad * HW + HH) * sc;
  const p = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.1);
  p.addColorStop(0, INK.pit);
  p.addColorStop(0.7, 'rgba(10,9,30,0.85)');
  p.addColorStop(1, 'rgba(10,9,30,0)');
  ctx.fillStyle = p;
  disc(cx, cy, r * 1.1);
  ctx.fill();
  // Dust drifting up out of the dark.
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 18; i++) {
    const a = i * 2.39996, rr = r * (0.2 + ((i * 37) % 80) / 100);
    const y = cy + Math.sin(a) * rr * 0.8 - ((now / 40 + i * 53) % (r * 0.6));
    disc(cx + Math.cos(a) * rr, y, 1.5 + (i % 3));
    ctx.fill();
  }
}

const HEXV = [];
for (let i = 0; i < 6; i++) HEXV.push([Math.cos(((60 * i - 90) * Math.PI) / 180), Math.sin(((60 * i - 90) * Math.PI) / 180)]);
function hexPath(x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x + HEXV[0][0] * r, y + HEXV[0][1] * r);
  for (let i = 1; i < 6; i++) ctx.lineTo(x + HEXV[i][0] * r, y + HEXV[i][1] * r);
  ctx.closePath();
}

// One floor's tiles: a top face over a darker side, so each tile reads as a
// slab. A tile stepped on shakes, cracks and reddens as its count runs down;
// one that has just fallen drops away and fades.
function drawFloor(t, z, faint, warn, now) {
  const k = LK[z], r = HR * sc * k * 0.95, th = r * 0.32;
  ctx.globalAlpha = faint ? 0.22 : 1;
  for (let i = 0; i < NT; i++) {
    if (TRING[i] > t.rad) continue;
    const key = z * NT + i, v = t.tl[key];
    let x = SX(tileX(i), k), y = SY(tileY(i), k), rr = r, fade = 1;
    if (v < 0) {
      const at = fellAt.get(key);
      if (at === undefined || now - at > 550) continue;
      const f = (now - at) / 550;
      y += f * f * r * 3;
      rr = r * (1 - f * 0.5);
      fade = 1 - f;
    }
    let heat = 0;
    if (v > 0) {
      heat = Math.max(0, Math.min(1, 1 - v / CR0));
      const j = (0.03 + 0.07 * heat) * r;
      x += Math.sin(now / 27 + i * 1.7) * j;
      y += Math.cos(now / 31 + i * 2.3) * j + heat * th * 0.5;
    }
    if (fade < 1) ctx.globalAlpha = (faint ? 0.22 : 1) * fade;
    const top = v < 0 ? mix(FLOOR_TOP[z], INK.ember, 0.8) : v > 0 ? mix(FLOOR_TOP[z], INK.ember, 0.25 + 0.6 * heat) : FLOOR_TOP[z];
    ctx.fillStyle = v === 0 ? FLOOR_SIDE[z] : darker(FLOOR_SIDE[z], 0.25);
    hexPath(x, y + th, rr);
    ctx.fill();
    ctx.fillStyle = top;
    hexPath(x, y, rr);
    ctx.fill();
    if (v === 0 && (TQ[i] + 2 * TR[i] + 30) % 3 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      hexPath(x, y, rr * 0.8);
      ctx.fill();
    }
    if (v !== 0) {
      // Cracks out from the middle, more of them as it goes.
      ctx.strokeStyle = 'rgba(40,10,10,0.55)';
      ctx.lineWidth = Math.max(1, rr * 0.07);
      ctx.beginPath();
      const n = 2 + Math.floor(heat * 3);
      for (let c = 0; c < n; c++) {
        const a = (i * 2.1 + c * 2.4) % 6.283;
        ctx.moveTo(x + Math.cos(a) * rr * 0.12, y + Math.sin(a) * rr * 0.12);
        ctx.lineTo(x + Math.cos(a + 0.3) * rr * 0.5, y + Math.sin(a + 0.3) * rr * 0.5);
        ctx.lineTo(x + Math.cos(a - 0.1) * rr * 0.82, y + Math.sin(a - 0.1) * rr * 0.82);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = alpha(FLOOR_LINE[z], 0.55);
      ctx.lineWidth = Math.max(1, rr * 0.05);
      hexPath(x, y, rr * 0.93);
      ctx.stroke();
    }
    if (warn.has(i) && v >= 0) {
      ctx.strokeStyle = `rgba(255,90,60,${(0.45 + 0.35 * Math.sin(now / 110)).toFixed(3)})`;
      ctx.lineWidth = Math.max(1.5, rr * 0.12);
      hexPath(x, y, rr * 0.86);
      ctx.stroke();
    }
    if (fade < 1) ctx.globalAlpha = faint ? 0.22 : 1;
  }
  ctx.globalAlpha = 1;
}

// A player as drawn: a round body on its own shadow, ringed in ink, eyes the
// way it is going; lifted off the floor in a hop, squashed on a landing, and
// shrinking into the dark as it falls.
function drawBody(id, x, y, z, d, colour, me, now, air, fall) {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { x, y, squash: 0, seen: now, fx: 0, fy: 1 }));
  const mx = x - look.x, my = y - look.y;
  if (Math.abs(mx) + Math.abs(my) > 1) {
    const l = Math.hypot(mx, my);
    look.fx = lerp(look.fx, mx / l, per60(0.3));
    look.fy = lerp(look.fy, my / l, per60(0.3));
  }
  look.x = x; look.y = y; look.seen = now;
  look.squash *= Math.pow(0.86, frameDt * 60);
  let k = kOf(z), fade = 1;
  if (fall > 0) {
    const nk = z + 1 < LAYERS ? LK[z + 1] : LK[LAYERS - 1] * 0.4;
    k = lerp(k, nk, ease(fall));
    if (z + 1 >= LAYERS) fade = 1 - fall;
  }
  const r = PR * sc * k * 1.25;
  const sx = SX(x, k), sy = SY(y, k);
  const lift = air > 0 ? Math.sin(Math.PI * air) * r * 2.4 : 0;
  const sq = look.squash;
  ctx.globalAlpha = fade;
  if (fall === 0) {
    ctx.fillStyle = 'rgba(10,8,25,0.35)';
    const sh = 1 - Math.min(0.5, lift / (r * 5));
    ctx.beginPath(); ctx.ellipse(sx, sy + r * 0.55, r * 0.95 * sh, r * 0.35 * sh, 0, 0, Math.PI * 2); ctx.fill();
  }
  const by = sy - lift - r * 0.35;
  const rx = r * (1 + sq * 0.3), ry = r * (1 - sq * 0.25);
  ctx.fillStyle = INK.outline;
  ctx.beginPath(); ctx.ellipse(sx, by + r * 0.08, rx + 2, ry + 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = darker(colour, 0.3);
  ctx.beginPath(); ctx.ellipse(sx, by + r * 0.06, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.ellipse(sx, by, rx, ry * 0.94, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  disc(sx - r * 0.35, by - r * 0.4, r * 0.22);
  ctx.fill();
  const fx_ = look.fx, fy_ = look.fy;
  for (const side of [-1, 1]) {
    const ex = sx + fx_ * r * 0.3 + side * r * 0.3 * (1 - Math.abs(fx_) * 0.4), ey = by - r * 0.08 + fy_ * r * 0.18;
    ctx.fillStyle = '#ffffff';
    disc(ex, ey, r * 0.21);
    ctx.fill();
    ctx.fillStyle = INK.outline;
    disc(ex + fx_ * r * 0.08, ey + fy_ * r * 0.08, r * (fall > 0 ? 0.13 : 0.1));
    ctx.fill();
  }
  if (me && fall === 0) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(sx, by, rx + 4, ry + 4, 0, 0, Math.PI * 2); ctx.stroke();
  }
  const px = Math.max(9, Math.min(13, r * 0.9));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(20,18,40,0.75)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  ctx.strokeText(label, sx, by - ry - 5);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, sx, by - ry - 5);
  // Hops left, as pips under the name.
  if (d.hops > 0 && fall === 0) {
    for (let h = 0; h < d.hops; h++) {
      ctx.fillStyle = '#ffffff';
      disc(sx + (h - (d.hops - 1) / 2) * 6, by - ry - 5 - px - 2, 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawBits() {
  flat();
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    disc(SX(b.x, b.k), SY(b.y, b.k) - b.z * sc * b.k, b.size * sc * b.k * (1 - f * 0.5));
    ctx.fill();
  }
  for (const r of rings) {
    const f = r.life / r.max;
    ctx.globalAlpha = (1 - f) * 0.75;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - f) + 1;
    ctx.beginPath();
    ctx.ellipse(SX(r.x, r.k), SY(r.y, r.k), r.r * sc * r.k * ease(f), r.r * sc * r.k * ease(f) * 0.86, 0, 0, Math.PI * 2);
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
    ctx.strokeStyle = 'rgba(20,18,40,0.8)';
    const X = Math.max(60, Math.min(VW - 60, SX(p.x, p.k))), Y = SY(p.y, p.k) - rise;
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
const standing = (t) => playersIn(t).filter((id) => t.p[id].st !== OUT).length;

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, and the time and players left in it.
  let status = '', colour = INK.text;
  const into = PLAY_STEPS - t.pt;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(into) + ' · ' + standing(t) + ' standing';
    if (into >= COLLAPSE_AT && t.cn >= 0) {
      status += ' · the rim is going';
      colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
    }
  } else status = 'round ' + t.rd + ' · over';
  text('crumble', 12, 22, titlePx, FLOOR_TOP[0], 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('crumble').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points; the chip
  // of somebody out of this round is hollow, and shows the floor they are on.
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
      if (d.st !== OUT) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      if (d.st !== OUT && t.ph !== WAIT) {
        ctx.fillStyle = FLOOR_TOP[d.z];
        disc(x + 11, y + 6, 2);
        ctx.fill();
      }
      const score = t.ph === WAIT ? '' : String(d.pts);
      ctx.font = font(12);
      const sw = score ? ctx.measureText(score).width : 0;
      if (score) text(score, x + cw - 8, y + 3, 12, INK.gold, 'right');
      if (cw > 46) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st !== OUT ? (mine ? INK.text : INK.muted) : INK.dim, cw - 30 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to run · tap to hop · keep moving, the floor falls behind you'
    : 'mouse or arrows/WASD run · click or space hops · keep moving · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// Your hops, or where you are, in the strip under the floors while a round is on.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = Math.min(fieldBot + NOTE_ROOM / 2, VH - BOT - 18);
  if (d.st === OUT) {
    const line = t.ph === PLAY ? (d.ot >= 0 ? 'you fell through · the round goes on without you' : 'watching · you play from the next round')
      : t.ph === COUNT ? 'get ready' : '';
    if (line) fitText(line, VW / 2, y + 5, 13, INK.muted, VW - 24);
    return;
  }
  ctx.font = font(13);
  const label = 'hops', lw = ctx.measureText(label).width;
  const total = lw + 10 + Math.max(1, d.hops) * 18 + 90;
  let x = VW / 2 - total / 2;
  text(label, x, y + 5, 13, INK.muted, 'left');
  x += lw + 10;
  if (!d.hops) { text('none left', x, y + 5, 13, INK.dim, 'left'); x += 64; }
  for (let h = 0; h < d.hops; h++) {
    ctx.fillStyle = SEAT[d.c];
    disc(x + 7, y, 6);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    x += 18;
  }
  ctx.fillStyle = FLOOR_TOP[d.z];
  hexPath(x + 16, y, 7);
  ctx.fill();
  text(FLOOR_NAME[d.z], x + 28, y + 5, 13, INK.text, 'left');
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
  const mid = (fieldTop + fieldBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'every tile you touch falls · hop over gaps · land beside the bot to crack its floor';
    practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,18,40,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 300), 30);
    fitText('last one standing takes the round', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 280));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,18,40,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('go!', cx, mid + big * 0.5);
    text('go!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · they fell together';
    else head = t.win === me ? 'you are the last one standing!' : nickOf(t.win) + ' is the last one standing';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('this round', cx + w / 2 - 74, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, ot, pts, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 160, 'left');
      text(ot < 0 ? '—' : '+' + ot, cx + w / 2 - 74, y, 14, INK.text, 'right');
      text(String(pts), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('a point for every player you outlast · next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where somebody stands as drawn: between two steps, and never slid across a
// jump — a player put back on the top floor, or one who has changed floors.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.z !== z.z || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 3 * HW) return [z.x, z.y, z, a];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z, a];
}
// How far through a hop (0 to 1) or a fall (0 to 1) somebody is, as drawn.
function airOf(a, z, k) {
  if (!z.air && !(a && a.air)) return 0;
  const left = a && a.st === z.st && a.air > 0 ? lerp(a.air, z.air, k) : z.air;
  return Math.max(0, Math.min(1, 1 - left / AIR));
}
function fallOf(a, z, k) {
  if (z.st !== FALLING) return 0;
  const left = a && a.st === FALLING && a.z === z.z ? lerp(a.fl, z.fl, k) : z.fl;
  return Math.max(0.001, Math.min(1, 1 - left / FALL));
}

// Your own player is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a push a step away from
// where the guess had it. So the player drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a player put back — puts it there at once. Only the drawing
// is smoothed: the floors, and every rule on them, are untouched.
const PULL = 0.45;
let shown = null;        // [x, y] in units: where your player is drawn
let myPos = null;        // [x, y, k]: the same, and how large its floor is drawn

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > HW) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  const b = agreedAt(now);
  shownRad = shownRad ? lerp(shownRad, b ? b.to.rad : 5, per60(0.08)) : b ? b.to.rad : 5;
  fit(shownRad);
  drawGround(now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the floors…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  // Every body goes with the floor it is on, falling bodies with the floor
  // they fall toward, so a floor above hides what is under it but for its
  // holes. A floor above your own is drawn faint, so you never lose yourself
  // under one; out of the round, the floor above the deepest player is.
  const groups = [];
  for (let z = 0; z <= LAYERS; z++) groups.push([]);
  const place = (id, x, y, d, a, k, mine) => {
    const fall = fallOf(a, d, k);
    const air = fall ? 0 : airOf(a, d, k);
    const g = d.st === FALLING ? d.z + 1 : d.z;
    groups[g].push([y + (air ? 1e5 : 0), () => drawBody(id, x, y, d.z, d, SEAT[d.c], mine, now, air, fall)]);
  };
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st === OUT) continue;
    const p = bodyAt(b, id);
    place(id, p[0], p[1], d, p[3], b.k, false);
  }
  let view = -1;
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own && own.to.p[me].st !== OUT) {
    const p = bodyAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    const d = p[2];
    myPos = [x, y, kOf(d.z)];
    view = d.z;
    place(me, x, y, d, p[3], own.k, true);
  } else {
    myPos = shown = null;
    for (const id of playersIn(t)) if (t.p[id].st !== OUT) view = Math.max(view, t.p[id].z);
  }
  // The ring of the rim that goes next glows for the two seconds before it does.
  const warn = new Set();
  const into = PLAY_STEPS - t.pt;
  if (t.ph === PLAY && t.cn >= 0 && into >= COLLAPSE_AT - 2 * HZ) {
    const left = into < COLLAPSE_AT ? COLLAPSE_AT - into : COLLAPSE_EVERY - ((into - COLLAPSE_AT) % COLLAPSE_EVERY);
    if (left <= 2 * HZ) for (const i of ringTiles(t.cn)) warn.add(i);
  }
  for (let z = LAYERS; z >= 0; z--) {
    if (z < LAYERS) drawFloor(t, z, view >= 0 && z < view, warn, now);
    groups[z].sort((p, q) => p[0] - q[0]);
    for (const [, f] of groups[z]) f();
  }
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way pushed, across and down, a thousand at full, and
// how many hops so far. A change of way goes out no oftener than STEER_EVERY,
// because a thumb or a mouse changes it on every move the screen reports and
// the clock's ticks share the same seat's ceiling on messages; a hop goes out
// at once.
const STEER_EVERY = 80;
let mode = '';           // what steers: 'keys', 'mouse', 'touch', or nothing yet
let hopsAsked = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_DIR = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// A thumb: a stick from wherever it lands, read as far as it is pushed, and a
// tap hops — a drag rather than a press, because iOS keeps a long press inside
// a frame for itself. A second finger down while the first runs hops too.
// A mouse: your player runs toward the pointer wherever it is; a click hops.
const DEAD = 9;
const REACHOUT = 46;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }
const mouse = { x: 0, y: 0, on: false };

function steerNow() {
  if (mode === 'keys') {
    let x = 0, y = 0;
    for (const c of keys) { x += KEY_DIR[c][0]; y += KEY_DIR[c][1]; }
    const l = Math.hypot(x, y);
    return l ? [Math.round((x / l) * 1000), Math.round((y / l) * 1000)] : [0, 0];
  }
  if (mode === 'touch') {
    if (!stick) return [0, 0];
    const l = Math.hypot(stick.dx, stick.dy);
    if (l < DEAD) return [0, 0];
    const k = Math.min(1, l / REACHOUT) * 1000 / l;
    return [clamp(Math.round(stick.dx * k), -1000, 1000), clamp(Math.round(stick.dy * k), -1000, 1000)];
  }
  if (mode === 'mouse' && mouse.on && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0], myPos[2]), dy = mouse.y - r.top - (SY(myPos[1], myPos[2]) - PR * sc * myPos[2]);
    const l = Math.hypot(dx, dy), tile = HW * sc * myPos[2];
    // Stopped on arrival, and off again only once the pointer is clearly away:
    // one threshold for both makes a player that stops and starts on every
    // twitch of the hand.
    if (l < tile * 0.2) mouse.parked = true;
    else if (l > tile * 0.4) mouse.parked = false;
    if (mouse.parked) return [0, 0];
    const k = Math.min(1, l / (tile * 1.2)) * 1000 / l;
    return [clamp(Math.round(dx * k), -1000, 1000), clamp(Math.round(dy * k), -1000, 1000)];
  }
  return [0, 0];
}

function sayHand(now, force) {
  const [dx, dy] = steerNow();
  const h = [dx, dy, hopsAsked], s = lastSaid;
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
  if (d && d.st === ON && d.air === 0 && d.hops > 0) sound.hop();
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyE' || e.code === 'KeyX') {
    e.preventDefault();
    if (!e.repeat) hop();
    return;
  }
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

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a player arrives on the floors.
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
