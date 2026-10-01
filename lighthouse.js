/**
 * @disk     lighthouse
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    One player keeps the lighthouse and sweeps its beam across a night bay; everyone else rows crates into the coves. Hold the beam on a boat and it is caught. Hide in the shadows of rocks, dash, and take your turn at the lamp.
 * @tags     game, party, realtime, asymmetric, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/lighthouse.png
 */
// lighthouse.js — a smuggling run under a sweeping beam, refereed by the room's order.
//
// Every copy holds the whole bay — every boat, every crate, every rock and the
// beam — and moves it only on what comes back round the room, so every copy
// applies the same hands in the same order and holds the same bay. Nobody sends
// where they are, what they carry, who was caught or a score: a hand is a
// direction, a dash counter and whether the lamp is narrowed, and everything
// else is the same arithmetic on the same numbers on every machine. A page with
// a console open can row its own boat however it likes, at a boat's own pace,
// and dash no oftener than anybody else; as the keeper it can aim the beam no
// faster than the lamp turns.
//
// Your own boat, and the beam while you keep it, do not wait for the trip: they
// are drawn from the agreed bay played forward by the trip, with your hand in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.abs`, `Math.min`,
// `Math.max` and `Math.imul` are fixed by the language to the last bit;
// `Math.sin` and `Math.cos` are not, so a step uses these instead.
const PI = 3.141592653589793, TAU = 6.283185307179586;

function dsin(a) {
  let x = a - TAU * Math.round(a / TAU);
  if (x > PI / 2) x = PI - x;
  else if (x < -PI / 2) x = -PI - x;
  const x2 = x * x;
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - (x2 / 110) * (1 - x2 / 156))))));
}
function dcos(a) { return dsin(a + PI / 2); }

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the bay a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own boat a trip ahead, with your hand in it
const DT = 1 / HZ;

const BAY = 1;                 // the bay's radius; the lighthouse stands in its middle
const VIEW = 1.04;             // the half-width drawn round it
const ISLE = 0.1;              // the lighthouse's island
const BR = 0.045;              // a boat's radius
const CR = 0.033;              // a crate's half-width
const COVE_D = 0.9;            // how far out the coves sit
const COVE_R = 0.1;            // and how wide each one is
const COVES = [[0.7071, -0.7071], [0.7071, 0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071]]
  .map(([x, y]) => [x * COVE_D, y * COVE_D]);
const ROCKS = 6;
const ACC = 1.5;               // how hard oars pull
const ACC_LOADED = 1.15;       // and with a crate aboard
const FRIC = 0.92;             // what one step leaves of a boat's speed
const VMAX = 0.6, VMAX_LOADED = 0.46, VMAX_DASH = 1.2;
const DASH_V = 0.7;
const DASH_CD = Math.round(2.5 * HZ);
const DASH_STEPS = 8;
const BOUNCE = 0.6;
const M_BOAT = 1, M_LOADED = 1.35, M_DASH = 1.8;

// The beam. A wide beam turns fast and catches slowly; narrowed, it turns at
// half the pace and catches in half the time.
const HALF_WIDE = 0.3, HALF_NARROW = 0.13;           // half the cone, radians
const TURN_WIDE = 2.0 * DT, TURN_NARROW = 1.0 * DT;  // radians a step
const TURN_IDLE = 0.5 * DT;                          // the lamp turning by itself between rounds
const FINAL_TURN = 1.25;                             // and how much faster in the last seconds
const COS2_WIDE = dcos(HALF_WIDE) * dcos(HALF_WIDE);
const COS2_NARROW = dcos(HALF_NARROW) * dcos(HALF_NARROW);
const TURNS = {};              // radians -> [cos, sin], worked out once
for (const a of [TURN_WIDE, TURN_NARROW, TURN_IDLE, TURN_WIDE * FINAL_TURN, TURN_NARROW * FINAL_TURN]) {
  TURNS[a] = [dcos(a), dsin(a)];
}

// Being seen: a boat in the light fills its gauge, and a full gauge is caught.
const FILL_WIDE = DT / 1.0, FILL_NARROW = DT / 0.55;
const DRAIN = DT / 1.6;
const STILL_V = 0.12;          // a boat slower than this is a dark hull on dark water
const STILL_K = 0.55;          // and fills this much slower
const LEADER_K = 1.25;         // the leader's polished hull fills this much faster
const DAZE = Math.round(1.4 * HZ);
const IMMUNE = Math.round(3.2 * HZ);
const CATCH_PTS = 1, CATCH_LOADED_PTS = 2;

const MAX_CRATES = 8;
const SPAWN_EVERY = Math.round(1.2 * HZ);
const INNER = 0.45;            // a crate this near the lamp is worth two
const HANDS_PER_STEP = 6;      // past this, a sender's hands in one step are dropped
const MAX_P = 8;
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const PLAY_STEPS = 45 * HZ;
const FINAL_STEPS = 12 * HZ;   // the last seconds of a round count double
const END_STEPS = 6 * HZ;
const CHAMP_STEPS = 9 * HZ;

// The bay. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every boat is made by one function with its fields in one order.
//   kp: who keeps the light this round, or -1; kept: who has kept it this match
//   bx, by: the beam's direction; tx, ty: where the keeper last aimed it; fo: narrowed
//   rk: rocks, each [x, y, r]; c: crates, each [x, y, worth, step it surfaced]
//   p:  player id -> a boat (see `boat`)
//   res: the last round's [id, points gained, points held] rows; champ: the
//   match's winner, -2 for a tie at the top, -1 while it goes on
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, mt: 1, kp: -1, kept: [], bx: 1, by: 0, tx: 1000, ty: 0, fo: 0,
    rk: [], c: [], p: {}, res: null, champ: -1,
  };
  w.rk = makeRocks(w);
  return w;
}

const FIELDS = ['x', 'y', 'vx', 'vy', 'dx', 'dy', 'f', 'fx', 'fy', 'bs', 'ld', 'dq', 'dd', 'cr', 'ex', 'dz', 'im',
  'sc', 'rg', 'k', 'hs', 'hc'];
//   x, y, vx, vy: on the water; dx, dy: the hand's direction in thousandths; f:
//   the hand narrows the beam; fx, fy: the way the bow last pointed; bs: dash
//   counter as last heard; ld: step of the last dash; dq: a dash to make this
//   step; dd: steps of dash left; cr: the crate aboard, by its worth; ex: how
//   seen, 0..1; dz: steps left dazed; im: steps left the beam slides off; sc:
//   points this match; rg: points this round; k: seat, which is its colour; hs,
//   hc: hands this step.
function boat(v) {
  const s = {};
  for (const f of FIELDS) s[f] = v[f];
  return s;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const rowersIn = (w) => playersIn(w).filter((id) => id !== w.kp);

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// Rocks, scattered between the lamp and the coves and never on top of each
// other, so every round's bay has its own shadows to run through.
function makeRocks(w) {
  const rk = [];
  for (let tries = 0; tries < 60 && rk.length < ROCKS; tries++) {
    const r = 0.05 + draw01(w) * 0.045;
    const d = 0.3 + draw01(w) * 0.42;
    const a = draw01(w) * TAU;
    const x = dcos(a) * d, y = dsin(a) * d;
    let ok = true;
    for (const o of rk) {
      const gx = o[0] - x, gy = o[1] - y, m = o[2] + r + 0.13;
      if (gx * gx + gy * gy < m * m) { ok = false; break; }
    }
    for (const c of COVES) {
      const gx = c[0] - x, gy = c[1] - y, m = COVE_R + r + 0.12;
      if (gx * gx + gy * gy < m * m) { ok = false; break; }
    }
    if (ok) rk.push([x, y, r]);
  }
  return rk;
}

function inRock(w, x, y, pad) {
  for (const r of w.rk) {
    const gx = x - r[0], gy = y - r[1], m = r[2] + pad;
    if (gx * gx + gy * gy < m * m) return true;
  }
  return false;
}

// A boat starts at a cove, the seats shared round the four of them.
function moor(w, d) {
  const c = COVES[d.k % 4];
  const back = 0.06 + 0.07 * Math.floor(d.k / 4);
  d.x = c[0] * (1 - back / COVE_D);
  d.y = c[1] * (1 - back / COVE_D);
  d.fx = Math.round(-c[0] / COVE_D * 1000);
  d.fy = Math.round(-c[1] / COVE_D * 1000);
  d.vx = d.vy = 0;
  d.cr = 0; d.ex = 0; d.dz = 0; d.im = 0; d.dd = 0; d.dq = 0;
  d.ld = w.n - DASH_CD;
}

// A hand, at its place in the room's order: [dx, dy, dashes, narrowed] — a
// direction in thousandths, a counter that moves on by one for every dash, and
// whether the keeper holds the lamp narrow. Being heard is how a boat arrives.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = w.p[id] = boat({
      x: 0, y: 0, vx: 0, vy: 0, dx: 0, dy: 0, f: 0, fx: 0, fy: 0, bs: input[2], ld: 0, dq: 0, dd: 0,
      cr: 0, ex: 0, dz: 0, im: 0, sc: 0, rg: 0, k: freeSeat(w), hs: w.n, hc: 0,
    });
    moor(w, d);
  }
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  // A flood of hands in one step is somebody's console, not somebody's thumb:
  // every copy drops the same ones.
  if (d.hc > HANDS_PER_STEP) return;
  d.dx = input[0];
  d.dy = input[1];
  d.f = input[3];
  if (input[2] !== d.bs) {
    d.bs = input[2];
    // A dash is a request; whether it happens is the bay's cooldown, the same
    // on every copy.
    if (id !== w.kp && w.ph !== COUNT && d.dz === 0 && w.n - d.ld >= DASH_CD) {
      d.ld = w.n;
      d.dq = 1;
      const len = Math.sqrt(input[0] * input[0] + input[1] * input[1]);
      if (len > 60) { d.fx = Math.round((input[0] / len) * 1000); d.fy = Math.round((input[1] / len) * 1000); }
    }
  }
}

// A hand off the wire, made safe: four integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [dx, dy, b, f] = raw;
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || !Number.isInteger(b) || !Number.isInteger(f)) return null;
  if (dx < -1000 || dx > 1000 || dy < -1000 || dy > 1000 || b < 0 || b > 63 || (f !== 0 && f !== 1)) return null;
  return [dx, dy, b, f];
}

function leave(w, id) {
  delete w.p[id];
}

// Who keeps the light next: the first seat that has not kept it this match,
// or the first seat of a match about to begin.
function nextKeeper(w) {
  const ids = playersIn(w).sort((a, b) => w.p[a].k - w.p[b].k);
  if (w.champ === -1) for (const id of ids) if (!w.kept.includes(id)) return id;
  return ids.length ? ids[0] : -1;
}

function crateWanted(w) {
  return Math.min(MAX_CRATES, 2 + rowersIn(w).length);
}

function spawnCrate(w) {
  for (let tries = 0; tries < 10; tries++) {
    const d = 0.22 + draw01(w) * 0.58;
    const a = draw01(w) * TAU;
    const x = dcos(a) * d, y = dsin(a) * d;
    if (inRock(w, x, y, CR + 0.03)) continue;
    let near = false;
    for (const c of w.c) {
      const gx = c[0] - x, gy = c[1] - y;
      if (gx * gx + gy * gy < 0.12 * 0.12) { near = true; break; }
    }
    if (near) continue;
    w.c.push([x, y, d < INNER ? 2 : 1, w.n]);
    return;
  }
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  if (w.kp !== -1 && w.p[w.kp]) moor(w, w.p[w.kp]);
  w.kp = -1;
  w.fo = 0;
  for (const id of playersIn(w)) { const d = w.p[id]; d.ex = 0; d.dz = 0; d.im = 0; }
}

function begin(w) {
  const here = playersIn(w);
  w.kept = w.kept.filter((id) => here.includes(id));
  let kp = nextKeeper(w);
  if (w.champ !== -1 || w.kept.includes(kp)) {
    // A new match: the scores and the turns at the lamp start over.
    for (const id of here) w.p[id].sc = 0;
    w.kept = [];
    w.champ = -1;
    w.mt += 1;
    kp = nextKeeper(w);
  }
  w.kp = kp;
  w.kept.push(kp);
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.rk = makeRocks(w);
  w.c = [];
  w.fo = 0;
  // The beam starts pointing away from the first cove, and the keeper's aim with it.
  w.bx = -0.7071067811865476; w.by = 0.7071067811865476;
  w.tx = -707; w.ty = 707;
  for (const id of here) {
    const d = w.p[id];
    moor(w, d);
    d.rg = 0;
    if (id === kp) { d.x = 0; d.y = 0; }
  }
  for (let i = crateWanted(w); i > 0; i--) spawnCrate(w);
  fx(w, 'round', 0, 0, kp);
}

function finish(w) {
  const here = playersIn(w);
  const res = here.map((id) => [id, w.p[id].rg, w.p[id].sc]);
  res.sort((a, b) => b[2] - a[2] || b[1] - a[1] || a[0] - b[0]);
  w.res = res;
  if (here.every((id) => w.kept.includes(id)) && res.length) {
    w.champ = res.length > 1 && res[1][2] === res[0][2] ? -2 : res[0][0];
  }
  w.ph = END;
  w.pt = w.champ !== -1 ? CHAMP_STEPS : END_STEPS;
  fx(w, 'end', 0, 0, w.champ);
}

// The one whose hull shines: a rower strictly ahead of everybody on points.
function leaderOf(w) {
  let best = -1, top = 0, tied = false;
  for (const id of playersIn(w)) {
    const s = w.p[id].sc;
    if (s > top) { top = s; best = id; tied = false; } else if (s === top && s > 0) tied = true;
  }
  return tied || best === w.kp ? -1 : best;
}

// Whether a point on the water is in the beam: inside the cone, and with no
// rock between it and the lamp.
function lit(w, x, y) {
  const dot = x * w.bx + y * w.by;
  if (dot <= 0) return false;
  const dd = x * x + y * y;
  if (dot * dot < dd * (w.fo ? COS2_NARROW : COS2_WIDE)) return false;
  for (const r of w.rk) {
    const along = (r[0] * x + r[1] * y) / dd;
    const t = along < 0 ? 0 : along > 1 ? 1 : along;
    const gx = r[0] - x * t, gy = r[1] - y * t;
    if (gx * gx + gy * gy < r[2] * r[2]) return false;
  }
  return true;
}

// The beam turns toward the keeper's aim, never faster than the lamp turns.
function turnBeam(w, tx, ty, rate) {
  const tl = Math.sqrt(tx * tx + ty * ty);
  if (tl < 1) return;
  const cross = w.bx * ty - w.by * tx, dot = w.bx * tx + w.by * ty;
  const [c, s] = TURNS[rate];
  if (dot > 0 && cross * cross <= s * s * tl * tl) {
    w.bx = tx / tl;
    w.by = ty / tl;
    return;
  }
  const sg = cross < 0 ? -1 : 1;
  const nx = w.bx * c - w.by * s * sg, ny = w.bx * s * sg + w.by * c;
  const nl = Math.sqrt(nx * nx + ny * ny);
  w.bx = nx / nl;
  w.by = ny / nl;
}

// Two round bodies that overlap are parted and bounce, by their masses. Bodies
// are [x, y, vx, vy, mass, radius], written back by the caller.
function bump(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy, m = a[5] + b[5];
  if (dd >= m * m) return 0;
  const dist = dd < 1e-12 ? 0 : Math.sqrt(dd);
  const nx = dist ? dx / dist : 1, ny = dist ? dy / dist : 0;
  const ia = 1 / a[4], ib = 1 / b[4], over = m - dist;
  a[0] -= nx * over * ia / (ia + ib);
  a[1] -= ny * over * ia / (ia + ib);
  b[0] += nx * over * ib / (ia + ib);
  b[1] += ny * over * ib / (ia + ib);
  const vn = (b[2] - a[2]) * nx + (b[3] - a[3]) * ny;
  if (vn >= 0) return 0;
  const j = (-(1 + BOUNCE) * vn) / (ia + ib);
  a[2] -= j * ia * nx; a[3] -= j * ia * ny;
  b[2] += j * ib * nx; b[3] += j * ib * ny;
  return -vn;
}

// A boat against something that does not move: pushed out to its edge, and its
// speed into it turned back. Inside (`out` false) for the shore, outside for
// rocks and the island.
function fend(d, cx, cy, r, out) {
  const gx = d.x - cx, gy = d.y - cy, dd = gx * gx + gy * gy;
  if (out ? dd >= r * r : dd <= r * r) return 0;
  const dist = Math.sqrt(dd);
  const nx = dist > 1e-9 ? gx / dist : 1, ny = dist > 1e-9 ? gy / dist : 0;
  d.x = cx + nx * r;
  d.y = cy + ny * r;
  const vn = d.vx * nx + d.vy * ny;
  if (out ? vn < 0 : vn > 0) {
    d.vx -= (1 + 0.4) * vn * nx;
    d.vy -= (1 + 0.4) * vn * ny;
    return Math.abs(vn);
  }
  return 0;
}

// One step of the bay: a function of the bay alone.
function step(w) {
  const many = playersIn(w).length;
  if (w.ph === WAIT) {
    if (many >= 2) begin(w);
  } else if (many < 2) {
    toWait(w);
  } else if ((w.ph === COUNT || w.ph === PLAY) && !w.p[w.kp]) {
    // The keeper left: the round ends as it stands, and the lamp passes on.
    finish(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === FINAL_STEPS) fx(w, 'final');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }

  const final = w.ph === PLAY && w.pt <= FINAL_STEPS;
  const twice = final ? 2 : 1;

  // The beam: the keeper's to aim, and turning by itself while nobody keeps it.
  const keeper = w.p[w.kp];
  if (keeper && (w.ph === COUNT || w.ph === PLAY)) {
    if (keeper.dx !== 0 || keeper.dy !== 0) { w.tx = keeper.dx; w.ty = keeper.dy; }
    w.fo = keeper.f;
    const rate = w.fo ? TURN_NARROW : TURN_WIDE;
    turnBeam(w, w.tx, w.ty, final ? rate * FINAL_TURN : rate);
  } else if (w.ph === WAIT || w.ph === END) {
    w.fo = 0;
    turnBeam(w, -w.by * 1000, w.bx * 1000, TURN_IDLE);
  }

  const ids = playersIn(w);
  const frozen = w.ph === COUNT;

  // Boats: oars, a dash, the water's drag.
  for (const id of ids) {
    if (id === w.kp) continue;
    const d = w.p[id];
    if (d.im > 0) d.im -= 1;
    const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy);
    const moving = len > 60 && d.dz === 0 && !frozen;
    const ux = moving ? d.dx / len : 0, uy = moving ? d.dy / len : 0;
    if (moving) { d.fx = Math.round(ux * 1000); d.fy = Math.round(uy * 1000); }
    if (d.dz > 0) d.dz -= 1;
    if (d.dq) {
      d.dq = 0;
      if (!frozen) {
        const fl = Math.sqrt(d.fx * d.fx + d.fy * d.fy) || 1;
        d.vx += (d.fx / fl) * DASH_V;
        d.vy += (d.fy / fl) * DASH_V;
        d.dd = DASH_STEPS;
        fx(w, 'dash', d.x, d.y, id);
      }
    }
    const acc = d.cr ? ACC_LOADED : ACC;
    const keep = frozen ? 0.6 : d.dd > 0 ? 0.97 : FRIC;
    d.vx = (d.vx + (moving ? ux * acc * DT : 0)) * keep;
    d.vy = (d.vy + (moving ? uy * acc * DT : 0)) * keep;
    const v = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    const most = d.dd > 0 ? VMAX_DASH : d.cr ? VMAX_LOADED : VMAX;
    if (v > most) { d.vx = (d.vx / v) * most; d.vy = (d.vy / v) * most; }
    d.x += d.vx * DT;
    d.y += d.vy * DT;
    if (d.dd > 0) d.dd -= 1;
  }

  // Boats bump each other: a dash is how one rower shoves another into the light.
  const bodies = [];
  for (const id of ids) {
    if (id === w.kp) continue;
    const d = w.p[id];
    const m = d.dd > 0 ? M_DASH : d.cr ? M_LOADED : M_BOAT;
    bodies.push({ id, d, b: [d.x, d.y, d.vx, d.vy, m, BR] });
  }
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const A = bodies[i], B = bodies[j];
    const hit = bump(A.b, B.b);
    if (hit > 0.25) fx(w, 'bump', (A.b[0] + B.b[0]) / 2, (A.b[1] + B.b[1]) / 2, Math.min(9, Math.round(hit * 6)), A.id, B.id);
  }
  for (const o of bodies) { o.d.x = o.b[0]; o.d.y = o.b[1]; o.d.vx = o.b[2]; o.d.vy = o.b[3]; }

  // Rocks, the island and the shore do not move.
  for (const o of bodies) {
    const d = o.d;
    let hit = 0;
    for (const r of w.rk) hit = Math.max(hit, fend(d, r[0], r[1], r[2] + BR, true));
    hit = Math.max(hit, fend(d, 0, 0, ISLE + BR, true));
    hit = Math.max(hit, fend(d, 0, 0, BAY - BR, false));
    if (hit > 0.3) fx(w, 'scrape', d.x, d.y, Math.min(9, Math.round(hit * 6)), o.id);
  }

  // Crates: picked up by whoever reaches one with an empty deck, landed at any cove.
  for (const o of bodies) {
    const d = o.d;
    if (d.dz > 0) continue;
    if (!d.cr) {
      for (let i = 0; i < w.c.length; i++) {
        const c = w.c[i], gx = c[0] - d.x, gy = c[1] - d.y, m = BR + CR + 0.012;
        if (gx * gx + gy * gy >= m * m) continue;
        d.cr = c[2];
        w.c.splice(i, 1);
        fx(w, 'pick', d.x, d.y, o.id, d.cr);
        break;
      }
    } else {
      for (const c of COVES) {
        const gx = c[0] - d.x, gy = c[1] - d.y, m = COVE_R + BR * 0.5;
        if (gx * gx + gy * gy >= m * m) continue;
        const pts = w.ph === PLAY ? d.cr * twice : 0;
        d.sc += pts;
        d.rg += pts;
        d.cr = 0;
        fx(w, 'land', d.x, d.y, o.id, pts);
        break;
      }
    }
  }

  // The light: a boat held in it fills its gauge, and a full one is caught.
  if (w.ph === PLAY && keeper) {
    const lead = leaderOf(w);
    for (const o of bodies) {
      const d = o.d;
      const seen = d.dz === 0 && d.im === 0 && lit(w, d.x, d.y);
      if (!seen) { d.ex = Math.max(0, d.ex - DRAIN); continue; }
      const v = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
      let rate = w.fo ? FILL_NARROW : FILL_WIDE;
      if (v < STILL_V) rate *= STILL_K;
      if (o.id === lead) rate *= LEADER_K;
      d.ex = Math.min(1, d.ex + rate);
      if (d.ex < 1) continue;
      // Caught: the crate goes over the side where the boat stands, the boat
      // reels, and the light slides off it for a while.
      const pts = (d.cr ? CATCH_LOADED_PTS : CATCH_PTS) * twice;
      keeper.sc += pts;
      keeper.rg += pts;
      if (d.cr && w.c.length < MAX_CRATES) w.c.push([d.x, d.y, d.cr, w.n]);
      fx(w, 'caught', d.x, d.y, o.id, pts, d.cr);
      d.cr = 0;
      d.ex = 0;
      d.dz = DAZE;
      d.im = IMMUNE;
      d.dd = 0;
      d.vx *= 0.3;
      d.vy *= 0.3;
    }
  } else {
    for (const o of bodies) o.d.ex = Math.max(0, o.d.ex - DRAIN);
  }

  // New crates surface while the bay is short of them.
  if (w.ph !== END && w.c.length < crateWanted(w) && w.n % SPAWN_EVERY === 0) spawnCrate(w);
}

// A bay handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG) || !int(raw.mt, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.kp, -BIG, BIG) || !int(raw.champ, -BIG, BIG)) return null;
  if (!Array.isArray(raw.kept) || raw.kept.length > 2 * MAX_P || !raw.kept.every((v) => int(v, -BIG, BIG))) return null;
  if (!num(raw.bx, -1.01, 1.01) || !num(raw.by, -1.01, 1.01)) return null;
  const bl = raw.bx * raw.bx + raw.by * raw.by;
  if (bl < 0.98 || bl > 1.02) return null;
  if (!int(raw.tx, -1000, 1000) || !int(raw.ty, -1000, 1000) || (raw.fo !== 0 && raw.fo !== 1)) return null;
  if (!Array.isArray(raw.rk) || raw.rk.length > ROCKS) return null;
  const rk = [];
  for (const r of raw.rk) {
    if (!Array.isArray(r) || r.length !== 3 || !num(r[0], -1, 1) || !num(r[1], -1, 1) || !num(r[2], 0.01, 0.2)) return null;
    rk.push([r[0], r[1], r[2]]);
  }
  if (!Array.isArray(raw.c) || raw.c.length > MAX_CRATES) return null;
  const c = [];
  for (const v of raw.c) {
    if (!Array.isArray(v) || v.length !== 4 || !num(v[0], -1, 1) || !num(v[1], -1, 1)) return null;
    if (!int(v[2], 1, 2) || !int(v[3], -BIG, BIG)) return null;
    c.push([v[0], v[1], v[2], v[3]]);
  }
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!num(d.x, -1.2, 1.2) || !num(d.y, -1.2, 1.2) || !num(d.vx, -3, 3) || !num(d.vy, -3, 3)) return null;
    if (inputOf([d.dx, d.dy, d.bs, d.f]) === null || !int(d.fx, -1000, 1000) || !int(d.fy, -1000, 1000)) return null;
    if ((d.dq !== 0 && d.dq !== 1) || !int(d.dd, 0, DASH_STEPS) || !int(d.cr, 0, 2) || !num(d.ex, 0, 1)) return null;
    if (!int(d.dz, 0, DAZE) || !int(d.im, 0, IMMUNE) || !int(d.k, 0, MAX_P - 1) || seats.has(d.k)) return null;
    seats.add(d.k);
    for (const k of ['ld', 'hs']) if (!int(d[k], -BIG, BIG)) return null;
    if (!int(d.sc, 0, 99999) || !int(d.rg, 0, 99999) || !int(d.hc, 0, BIG)) return null;
    p[id] = boat(d);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 3 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push([r[0], r[1], r[2]]);
    }
  }
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, mt: raw.mt, kp: raw.kp, kept: raw.kept.slice(),
    bx: raw.bx, by: raw.by, tx: raw.tx, ty: raw.ty, fo: raw.fo, rk, c, p, res, champ: raw.champ,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed bay steps, and kept with the step that made them
// until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a night sea in deep blues, one warm lamp, and a colour for each
// seat that is the boat's hull and its chip on the scoreboard.
const INK = {
  page: '#081326', seaTop: '#0d2142', seaLow: '#060e1f', wave: 'rgba(140,180,255,0.07)',
  shore: '#1c2436', sand: '#3a3a4a', cove: '#7fe3d0', rock: '#2a3245', rockTop: '#3b4660',
  isle: '#3b3a48', tower: '#e9e4d8', beam: '255,226,150', lamp: '#ffe9a8',
  text: '#eef1f8', muted: '#9fb0cf', dim: '#5f7196', gold: '#ffd166', danger: '#ff6b5e',
  panel: 'rgba(7,14,30,0.92)', crate: '#b5824a', crateDark: '#6e4a26',
};
const SEAT = ['#ff8a5c', '#5cc8ff', '#ffd95c', '#c38bff', '#ff6fa8', '#4fe0b0', '#ff5c5c', '#a0b4ff'];
const FONT = "600 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.page};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');
// The beam is drawn on a layer of its own, so the rocks' shadows can be cut
// out of it before it lands on the water.
const layer = document.createElement('canvas');
const lctx = layer.getContext('2d');

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #2a3a5e;' +
  `background:#101d38;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, sc = 1, cx = 320, cy = 200, TOP = 56, BOT = 28, dpx = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  layer.width = cv.width;
  layer.height = cv.height;
  dpx = dpr;
  TOP = VW < 420 ? 64 : 56;
  BOT = 28;
  const aw = VW - 12, ah = Math.max(40, VH - TOP - BOT);
  sc = Math.max(10, Math.min(aw, ah) / (2 * VIEW));
  cx = VW / 2;
  cy = TOP + ah / 2;
}
layout();
window.addEventListener('resize', layout);

// The bay to the screen and back.
const SX = (x) => cx + x * sc;
const SY = (y) => cy + y * sc;
function inField(c) {
  const g = c || ctx;
  g.setTransform(dpx, 0, 0, dpx, 0, 0);
  g.translate(cx + shakeX, cy + shakeY);
  g.scale(sc, sc);
}
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

function nickOf(id) {
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
  text(s, x, y, wd > most ? Math.max(8, (px * most) / wd) : px, colour, align);
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
function disc(x, y, r, c) {
  const g = c || ctx;
  g.beginPath();
  g.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
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
  splash() { if (ready('splash', 80)) { puff(0.2, 0.12, 900, 0, 0.8); puff(0.14, 0.05, 2600, 0.03); } },
  knock(v) {
    if (!ready('knock', 70)) return;
    tone(150, 0.12, 'sine', 0.05 + 0.14 * v, 0.55);
    puff(0.06, 0.03 + 0.07 * v, 500);
  },
  pick(two) { if (ready('pick', 80)) { tone(two ? 660 : 520, 0.08, 'triangle', 0.1); tone(two ? 990 : 780, 0.12, 'triangle', 0.08, 0, 0.06); } },
  land() { if (ready('land', 80)) [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.16, 'triangle', 0.09, 0, i * 0.06)); },
  seen(k) { if (ready('seen', 150 - 90 * k)) tone(420 + 520 * k, 0.06, 'square', 0.03 + 0.03 * k); },
  caught(mine) {
    if (!ready('caught', 150)) return;
    const v = mine ? 1 : 0.55;
    tone(900, 0.5, 'sawtooth', 0.06 * v, 0.35);
    tone(1200, 0.35, 'square', 0.03 * v, 0.4, 0.05);
    puff(0.35, 0.1 * v, 700, 0.05, 0.7);
  },
  score() { if (ready('score', 80)) { tone(1046, 0.1, 'triangle', 0.1); tone(1568, 0.18, 'triangle', 0.08, 0, 0.07); } },
  bell() {
    if (!ready('bell', 600)) return;
    tone(392, 1.2, 'sine', 0.09, 0.98);
    tone(784, 0.9, 'sine', 0.05, 0.99, 0.01);
    tone(1176, 0.6, 'sine', 0.03, 1, 0.02);
  },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(700, 0.12, 'sine', 0.12, 2.0); tone(1400, 0.25, 'sine', 0.08, 1.0, 0.12); } },
  end(won) {
    if (!ready('end', 500)) return;
    if (won) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, 'triangle', 0.1, 0, i * 0.09));
    else [392, 330, 262].forEach((f, i) => tone(f, 0.26, 'triangle', 0.08, 0, i * 0.1));
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
// fast screen and a slow one see the same spray.
const bits = [];      // { x, y, vx, vy, life, max, size, colour } in bay units
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r }
const wakes = [];     // { x, y, life, max }: the foam a moving boat leaves
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 20 + Math.random() * 22, size, colour });
  }
  if (bits.length > 500) bits.splice(0, bits.length - 500);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 16, lift: lift || 18 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 26, r }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.92; b.vy *= 0.92;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    for (let i = wakes.length - 1; i >= 0; i--) if (++wakes[i].life >= wakes[i].max) wakes.splice(i, 1);
    for (const look of looks.values()) look.squash *= 0.88;
    flash *= 0.9;
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, seen, wx, wy }
let myDashAt = -1e9;
let drawFailed = false;
let flash = 0;             // the whole screen lit for a moment: you were caught
const DASH_MS = (DASH_CD / HZ) * 1000 + 150;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, seen: 0, wx: null, wy: null }));
  l.seen = performance.now();
  return l;
}
function colourOf(t, id) {
  const d = t.p[id];
  return d ? SEAT[d.k] : '#dddddd';
}
const who = (id) => (id === myId() ? 'you' : nickOf(id));

function play(e, t) {
  const me = myId();
  if (e.kind === 'dash') {
    lookOf(e.a).squash = 1;
    if (e.a === me) return;    // your own was heard and seen the moment you pressed
    spray(e.x, e.y, 6, 'rgba(220,235,255,0.8)', 0.3, 0.008);
    sound.splash();
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 3 + e.a, '#e6eeff', 0.25 + e.a * 0.05, 0.008);
    lookOf(e.b).squash = Math.min(1, e.a / 5);
    lookOf(e.c).squash = Math.min(1, e.a / 5);
    const mine = e.b === me || e.c === me;
    if (mine) shake = Math.max(shake, 2 + e.a);
    sound.knock(mine ? Math.min(1, e.a / 5) : 0.25);
  } else if (e.kind === 'scrape') {
    spray(e.x, e.y, 4, '#c9d3e8', 0.25, 0.007);
    if (e.b === me) { shake = Math.max(shake, 1 + e.a * 0.6); sound.knock(Math.min(1, e.a / 6)); }
  } else if (e.kind === 'pick') {
    ring(e.x, e.y, e.b === 2 ? INK.gold : INK.crate, 0.07);
    if (e.a === me) { pop(e.x, e.y, e.b === 2 ? 'crate ×2' : 'crate', e.b === 2 ? INK.gold : INK.text, 14, 22); sound.pick(e.b === 2); }
  } else if (e.kind === 'land') {
    spray(e.x, e.y, 16, INK.cove, 0.45, 0.009);
    spray(e.x, e.y, 8, colourOf(t, e.a), 0.35, 0.009);
    ring(e.x, e.y, INK.cove, COVE_R * 1.6);
    if (e.b > 0) pop(e.x, e.y, '+' + e.b + ' ' + who(e.a), colourOf(t, e.a), e.a === me ? 18 : 14, 30);
    if (e.a === me) sound.land(); else sound.score();
  } else if (e.kind === 'caught') {
    spray(e.x, e.y, 22, '#fff3c8', 0.6, 0.01);
    if (e.c) spray(e.x, e.y, 10, INK.crate, 0.4, 0.012);
    ring(e.x, e.y, INK.lamp, 0.16);
    lookOf(e.a).squash = 1;
    pop(e.x, e.y, e.a === me ? 'caught!' : 'caught ' + nickOf(e.a), INK.lamp, e.a === me ? 20 : 15, 30);
    pop(0, -ISLE - 0.05, '+' + e.b, INK.lamp, t.kp === me ? 20 : 15, 26);
    if (e.a === me) { shake = Math.max(shake, 10); flash = 1; }
    if (t.kp === me) shake = Math.max(shake, 4);
    sound.caught(e.a === me || t.kp === me);
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'final') {
    sound.bell();
    pop(0, -0.32, 'double points!', INK.gold, 22, 24);
  } else if (e.kind === 'round') {
    sound.bell();
  } else if (e.kind === 'end') {
    const best = [...(t.res || [])].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (t.p[me]) sound.end(e.a === -1 ? !!best && best[0] === me && best[1] > 0 : e.a === me);
  }
}

// The night sea: two shades and slow lines of swell, drawn from the clock alone.
function drawSea(now) {
  flat();
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, INK.seaTop);
  g.addColorStop(1, INK.seaLow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  ctx.strokeStyle = INK.wave;
  ctx.lineWidth = 1.2;
  const gap = Math.max(16, sc * 0.08);
  const tt = now / 1000;
  for (let row = 0, y = (tt * 5) % gap - gap; y < VH + gap; y += gap, row++) {
    ctx.beginPath();
    for (let x = -10; x <= VW + 10; x += 14) {
      const yy = y + Math.sin(x / 42 + tt * 1.1 + row * 1.7) * 2.5;
      if (x === -10) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
}

// The shore round the bay, and its four coves lit by lanterns.
function drawShore(now) {
  inField();
  ctx.save();
  ctx.beginPath();
  ctx.rect(-VIEW * 3, -VIEW * 3, VIEW * 6, VIEW * 6);
  ctx.arc(0, 0, BAY, 0, Math.PI * 2, true);
  ctx.fillStyle = INK.shore;
  ctx.fill('evenodd');
  ctx.restore();
  ctx.strokeStyle = INK.sand;
  ctx.lineWidth = 0.018;
  disc(0, 0, BAY + 0.006);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(200,220,255,0.12)';
  ctx.lineWidth = 0.005;
  disc(0, 0, BAY - 0.01 - 0.004 * Math.sin(now / 500));
  ctx.stroke();
  for (const c of COVES) {
    const k = 0.75 + 0.25 * Math.sin(now / 380 + c[0] * 3);
    const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], COVE_R * 2);
    g.addColorStop(0, `rgba(127,227,208,${0.28 * k})`);
    g.addColorStop(1, 'rgba(127,227,208,0)');
    ctx.fillStyle = g;
    disc(c[0], c[1], COVE_R * 2);
    ctx.fill();
    ctx.strokeStyle = INK.cove;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 0.006;
    ctx.setLineDash([0.018, 0.014]);
    disc(c[0], c[1], COVE_R);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // The jetty and its lantern, on the shore side of the cove.
    const ox = c[0] / COVE_D, oy = c[1] / COVE_D;
    ctx.strokeStyle = '#6e5a44';
    ctx.lineWidth = 0.022;
    ctx.beginPath();
    ctx.moveTo(ox * (BAY + 0.03), oy * (BAY + 0.03));
    ctx.lineTo(ox * (COVE_D + 0.02), oy * (COVE_D + 0.02));
    ctx.stroke();
    ctx.fillStyle = INK.cove;
    disc(ox * (BAY + 0.025), oy * (BAY + 0.025), 0.012 * k + 0.004);
    ctx.fill();
  }
}

// The beam: a cone of warm light from the lamp to the shore, with every rock's
// shadow cut out of it.
function drawBeam(t, bx, by, fo, keeper, now) {
  const g = lctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, layer.width, layer.height);
  inField(g);
  const a = Math.atan2(by, bx), half = fo ? HALF_NARROW : HALF_WIDE;
  const far = BAY * 1.02;
  const strong = fo ? 0.5 : 0.36;
  const grad = g.createRadialGradient(0, 0, ISLE * 0.5, 0, 0, far);
  grad.addColorStop(0, `rgba(${INK.beam},${strong + 0.2})`);
  grad.addColorStop(0.6, `rgba(${INK.beam},${strong})`);
  grad.addColorStop(1, `rgba(${INK.beam},${strong * 0.45})`);
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, 0);
  g.arc(0, 0, far, a - half, a + half);
  g.closePath();
  g.fill();
  // A hot core down the middle.
  g.fillStyle = `rgba(255,248,220,${fo ? 0.22 : 0.12})`;
  g.beginPath();
  g.moveTo(0, 0);
  g.arc(0, 0, far, a - half * 0.35, a + half * 0.35);
  g.closePath();
  g.fill();
  // The rocks' shadows: from the two tangents out past the shore.
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  for (const r of t.rk) {
    const d = Math.hypot(r[0], r[1]);
    if (d <= r[2] + 1e-3) continue;
    const ra = Math.atan2(r[1], r[0]), s = Math.asin(r[2] / d), tl = Math.sqrt(d * d - r[2] * r[2]);
    g.beginPath();
    g.moveTo(Math.cos(ra - s) * tl, Math.sin(ra - s) * tl);
    g.lineTo(Math.cos(ra - s) * 3, Math.sin(ra - s) * 3);
    g.lineTo(Math.cos(ra + s) * 3, Math.sin(ra + s) * 3);
    g.lineTo(Math.cos(ra + s) * tl, Math.sin(ra + s) * tl);
    g.closePath();
    g.fill();
  }
  // Nothing beyond the shore.
  g.beginPath();
  g.rect(-4, -4, 8, 8);
  g.arc(0, 0, BAY, 0, Math.PI * 2, true);
  g.fill('evenodd');
  g.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer, 0, 0);
  // The lamp's own glow round the island.
  inField();
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.42);
  glow.addColorStop(0, `rgba(${INK.beam},0.16)`);
  glow.addColorStop(1, `rgba(${INK.beam},0)`);
  ctx.fillStyle = glow;
  disc(0, 0, 0.42);
  ctx.fill();
  // The keeper's colour runs along the beam's edges, so it is plain whose light it is.
  ctx.strokeStyle = keeper;
  ctx.globalAlpha = 0.35 + 0.1 * Math.sin(now / 200);
  ctx.lineWidth = 0.004;
  for (const e of [a - half, a + half]) {
    ctx.beginPath();
    ctx.moveTo(Math.cos(e) * ISLE, Math.sin(e) * ISLE);
    ctx.lineTo(Math.cos(e) * BAY, Math.sin(e) * BAY);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawRocks(t, bx, by, fo) {
  inField();
  const cos2 = fo ? COS2_NARROW : COS2_WIDE;
  for (const r of t.rk) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    disc(r[0] + 0.008, r[1] + 0.012, r[2] * 1.05);
    ctx.fill();
    ctx.fillStyle = INK.rock;
    disc(r[0], r[1], r[2]);
    ctx.fill();
    ctx.fillStyle = INK.rockTop;
    disc(r[0] - r[2] * 0.18, r[1] - r[2] * 0.2, r[2] * 0.68);
    ctx.fill();
    // The face toward the lamp catches the light when the beam is on it.
    const d = Math.hypot(r[0], r[1]) || 1, dot = r[0] * bx + r[1] * by;
    const onIt = dot > 0 && dot * dot >= d * d * cos2 * 0.97;
    const ra = Math.atan2(-r[1], -r[0]);
    ctx.strokeStyle = onIt ? INK.lamp : 'rgba(255,230,170,0.18)';
    ctx.lineWidth = onIt ? 0.01 : 0.005;
    ctx.beginPath();
    ctx.arc(r[0], r[1], r[2] - 0.004, ra - 1.1, ra + 1.1);
    ctx.stroke();
  }
}

function drawCrate(x, y, worth, born, n, now) {
  const age = Math.min(1, (n - born) / (HZ * 0.5));
  const s = CR * ease(age);
  if (s <= 0.001) return;
  const bob = Math.sin(now / 420 + x * 13 + y * 7) * 0.004;
  ctx.fillStyle = 'rgba(160,200,255,0.12)';
  ctx.beginPath();
  ctx.ellipse(x, y + 0.008, s * 1.6, s * 1.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.rotate(0.25 * Math.sin(now / 900 + x * 5));
  ctx.fillStyle = INK.crate;
  ctx.fillRect(-s, -s, 2 * s, 2 * s);
  ctx.strokeStyle = INK.crateDark;
  ctx.lineWidth = 0.005;
  ctx.strokeRect(-s, -s, 2 * s, 2 * s);
  ctx.beginPath();
  ctx.moveTo(-s, -s); ctx.lineTo(s, s);
  ctx.moveTo(s, -s); ctx.lineTo(-s, s);
  ctx.stroke();
  if (worth === 2) {
    ctx.strokeStyle = INK.gold;
    ctx.lineWidth = 0.006;
    ctx.strokeRect(-s - 0.006, -s - 0.006, 2 * s + 0.012, 2 * s + 0.012);
  }
  ctx.restore();
}

function drawIsland(t, bx, by, keeper, now) {
  inField();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  disc(0.01, 0.015, ISLE * 1.05);
  ctx.fill();
  ctx.fillStyle = INK.isle;
  disc(0, 0, ISLE);
  ctx.fill();
  ctx.fillStyle = '#4a4858';
  disc(-0.015, -0.018, ISLE * 0.75);
  ctx.fill();
  // The tower from above: white with the keeper's stripes, and the lamp turning.
  const tr = ISLE * 0.55;
  ctx.fillStyle = INK.tower;
  disc(0, 0, tr);
  ctx.fill();
  ctx.strokeStyle = keeper;
  ctx.lineWidth = tr * 0.28;
  disc(0, 0, tr * 0.72);
  ctx.stroke();
  ctx.fillStyle = '#2a2a36';
  disc(0, 0, tr * 0.45);
  ctx.fill();
  const lx = bx * tr * 0.3, ly = by * tr * 0.3;
  const glow = ctx.createRadialGradient(lx, ly, 0, lx, ly, tr * 0.6);
  glow.addColorStop(0, '#fffbe8');
  glow.addColorStop(1, `rgba(${INK.beam},0)`);
  ctx.fillStyle = glow;
  disc(lx, ly, tr * 0.6);
  ctx.fill();
  if (t.kp === myId() && (t.ph === COUNT || t.ph === PLAY) && aimShown) {
    // Where you are turning the lamp to, ahead of the lamp itself.
    const a = Math.atan2(aimShown[1], aimShown[0]);
    ctx.strokeStyle = 'rgba(255,233,168,0.5)';
    ctx.setLineDash([0.02, 0.02]);
    ctx.lineWidth = 0.005;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (ISLE + 0.02), Math.sin(a) * (ISLE + 0.02));
    ctx.lineTo(Math.cos(a) * (BAY - 0.04), Math.sin(a) * (BAY - 0.04));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK.lamp;
    disc(Math.cos(a) * (BAY - 0.04), Math.sin(a) * (BAY - 0.04), 0.012 + 0.003 * Math.sin(now / 120));
    ctx.fill();
  }
}

function drawBoat(id, x, y, d, colour, me, seen, lead, now) {
  const look = lookOf(id);
  const sq = look.squash;
  const fl = Math.hypot(d.fx, d.fy) || 1, ux = d.fx / fl || 1, uy = d.fy / fl;
  // Foam behind a boat on the move.
  if (look.wx !== null && Math.hypot(x - look.wx, y - look.wy) > 0.025) {
    wakes.push({ x: look.wx, y: look.wy, life: 0, max: 40 });
    if (wakes.length > 240) wakes.splice(0, wakes.length - 240);
    look.wx = x; look.wy = y;
  } else if (look.wx === null) { look.wx = x; look.wy = y; }
  const blink = d.im > 0 && d.dz === 0 && Math.floor(now / 110) % 2 === 0;
  // In the light a boat glows and shows plainly; in the dark it is a shape.
  if (seen) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, BR * 2.6);
    g.addColorStop(0, 'rgba(255,240,190,0.55)');
    g.addColorStop(1, 'rgba(255,240,190,0)');
    ctx.fillStyle = g;
    disc(x, y, BR * 2.6);
    ctx.fill();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = blink ? 0.45 : 1;
  ctx.rotate(Math.atan2(uy, ux) + (d.dz > 0 ? Math.sin(now / 60) * 0.5 : 0));
  ctx.scale(1 + 0.25 * sq, 1 - 0.2 * sq);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0.004, 0.008, BR * 1.25, BR * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();
  // The hull: pointed at the bow.
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(BR * 1.35, 0);
  ctx.quadraticCurveTo(BR * 0.6, -BR * 0.75, -BR * 1.05, -BR * 0.62);
  ctx.lineTo(-BR * 1.05, BR * 0.62);
  ctx.quadraticCurveTo(BR * 0.6, BR * 0.75, BR * 1.35, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = me ? '#ffffff' : 'rgba(0,0,0,0.45)';
  ctx.lineWidth = me ? 0.006 : 0.004;
  ctx.stroke();
  ctx.fillStyle = 'rgba(20,16,12,0.45)';
  ctx.beginPath();
  ctx.ellipse(-BR * 0.05, 0, BR * 0.8, BR * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  if (d.cr) {
    const s = CR * 0.8;
    ctx.fillStyle = INK.crate;
    ctx.fillRect(-BR * 0.2 - s, -s, 2 * s, 2 * s);
    ctx.strokeStyle = d.cr === 2 ? INK.gold : INK.crateDark;
    ctx.lineWidth = 0.005;
    ctx.strokeRect(-BR * 0.2 - s, -s, 2 * s, 2 * s);
  } else {
    // Oars when the deck is empty.
    ctx.strokeStyle = 'rgba(230,220,200,0.7)';
    ctx.lineWidth = 0.004;
    const sw = Math.sin(now / 140 + id) * 0.25;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, side * BR * 0.5);
      ctx.lineTo(-BR * 0.5 + sw * BR, side * BR * 1.25);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  if (lead) {
    // The leader's hull shines, and the light finds it sooner.
    ctx.fillStyle = INK.gold;
    const tw = 0.006 + 0.004 * Math.sin(now / 160);
    ctx.beginPath();
    ctx.moveTo(x, y - BR * 1.9 - tw); ctx.lineTo(x + tw, y - BR * 1.9); ctx.lineTo(x, y - BR * 1.9 + tw); ctx.lineTo(x - tw, y - BR * 1.9);
    ctx.closePath();
    ctx.fill();
  }
  // How seen it is: a gauge round the boat, warm to red.
  if (d.ex > 0.01) {
    ctx.strokeStyle = d.ex > 0.66 ? INK.danger : d.ex > 0.33 ? '#ffb347' : INK.lamp;
    ctx.lineWidth = 0.008;
    ctx.beginPath();
    ctx.arc(x, y, BR + 0.02, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * d.ex);
    ctx.stroke();
  }
  if (d.dz > 0) {
    // Dazed: stars round its head.
    ctx.fillStyle = '#fff3c8';
    for (let i = 0; i < 3; i++) {
      const a = now / 200 + (i * Math.PI * 2) / 3;
      disc(x + Math.cos(a) * BR * 1.3, y + Math.sin(a) * BR * 0.6 - BR * 1.2, 0.006);
      ctx.fill();
    }
  }
  if (me && performance.now() - myDashAt < DASH_MS && d.dz === 0) {
    const k = (performance.now() - myDashAt) / DASH_MS;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.004;
    ctx.beginPath();
    ctx.arc(x, y, BR + 0.033, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
    ctx.stroke();
  }
}

function drawBits() {
  inField();
  for (const wk of wakes) {
    const k = wk.life / wk.max;
    ctx.globalAlpha = 0.22 * (1 - k);
    ctx.strokeStyle = '#cfe0ff';
    ctx.lineWidth = 0.004;
    disc(wk.x, wk.y, 0.012 + 0.03 * k);
    ctx.stroke();
  }
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 0.008 * (1 - k) + 0.002;
    disc(r.x, r.y, r.r * ease(k));
    ctx.stroke();
  }
  for (const b of bits) {
    ctx.globalAlpha = 1 - b.life / b.max;
    ctx.fillStyle = b.colour;
    ctx.fillRect(b.x - b.size / 2, b.y - b.size / 2, b.size, b.size);
  }
  ctx.globalAlpha = 1;
  flat();
  for (const p of pops) {
    const k = p.life / p.max;
    ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    const s = k < 0.15 ? 0.6 + (0.4 * k) / 0.15 : 1;
    const X = SX(p.x) + shakeX, Y = SY(p.y) + shakeY - ease(Math.min(1, k * 1.4)) * p.lift;
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
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
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'waiting for a second boat';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · ' + who(t.kp) + (t.kp === me ? ' keep' : ' keeps') + ' the light';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt);
    if (t.pt <= FINAL_STEPS) { status += ' · double points!'; colour = (Math.floor(now / 300) % 2) ? INK.gold : INK.text; }
  } else status = t.champ !== -1 ? 'match over' : 'round ' + t.rd + ' over';
  text('lighthouse', 12, 22, titlePx, INK.lamp, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('lighthouse').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 100, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a boat, in its seat's colour, with its points;
  // the keeper's chip carries the lamp.
  const ids = playersIn(t).sort((a, b) => t.p[a].k - t.p[b].k);
  const lead = leaderOf(t);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, keeps = id === t.kp && t.ph !== WAIT;
      ctx.fillStyle = keeps ? 'rgba(255,226,150,0.18)' : mine ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.3)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[d.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[d.k];
      disc(x + 11, y - 2, 5);
      ctx.fill();
      if (keeps) {
        ctx.fillStyle = INK.lamp;
        disc(x + 11, y - 2, 2.2);
        ctx.fill();
      }
      const score = String(d.sc) + (id === lead ? '★' : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, id === lead ? INK.gold : INK.text, 'right');
      if (cw > 50) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const keeping = t.kp === me && (t.ph === COUNT || t.ph === PLAY);
  const how = keeping
    ? coarse ? 'you keep the light · drag to aim the beam · tap to narrow it · hold a boat in it'
      : 'you keep the light · aim with the mouse or ←/→ · hold click or space to narrow it'
    : coarse ? 'drag to row · tap to dash · bring crates to a cove · stay out of the beam'
      : 'WASD/arrows or hold the mouse to row · space/click dashes · crates to a cove, out of the light · M mutes';
  fitText(how, VW / 2, VH - 10, 12, keeping ? INK.lamp : INK.muted, VW - 20);
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
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const me = myId();
  if (flash > 0.02) {
    ctx.fillStyle = `rgba(255,240,200,${0.35 * flash})`;
    ctx.fillRect(0, 0, VW, VH);
  }
  if (t.ph === WAIT) {
    const w = Math.min(VW - 32, 390), py = TOP + 52;
    panel(cx, py, w, 92);
    fitText('waiting for a second boat', cx, py - 14, 18, INK.text, w - 24);
    fitText('practise: grab a crate and row it to a glowing cove', cx, py + 12, 13, INK.muted, w - 24);
    fitText('a round starts the moment somebody joins', cx, py + 32, 12, INK.dim, w - 24);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    const w = Math.min(VW - 32, 420), py = cy + big * 2.4;
    panel(cx, py, w, 62);
    if (t.kp === me) {
      fitText('you keep the light', cx, py - 6, 18, INK.lamp, w - 24);
      fitText('hold the beam on a boat until it is caught · a loaded boat is worth 2', cx, py + 16, 12, INK.muted, w - 24);
    } else {
      fitText(nickOf(t.kp) + ' keeps the light', cx, py - 6, 18, colourOf(t, t.kp), w - 24);
      fitText('row crates to the coves · rocks cast shadows · gold crates are worth 2', cx, py + 16, 12, INK.muted, w - 24);
    }
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    text(String(n), cx, cy - big * 0.4, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text(t.kp === me ? 'find them!' : 'row!', cx, cy - big * 0.6, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const total = t.champ !== -1 ? CHAMP_STEPS : END_STEPS;
    const k = ease(Math.min(1, (total - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 330), h = 104 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = cy + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.champ === -2) { head = 'a tie at the top!'; hc = INK.gold; }
    else if (t.champ !== -1) { head = t.champ === me ? 'you win the match!' : nickOf(t.champ) + ' wins the match!'; hc = INK.gold; }
    else {
      const best = [...rows].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (best && best[1] > 0) { head = (best[0] === me ? 'you' : nickOf(best[0])) + ' took the most: +' + best[1]; hc = colourOf(t, best[0]); }
      else head = 'a quiet night';
    }
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 34, 21, hc, w - 24);
    rows.forEach(([id, got, held], i) => {
      const y = y0 + 64 + i * 22;
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      const tag = id === t.kp ? '  (lamp)' : '';
      fitText((id === me ? 'you' : nickOf(id)) + tag + (id === t.champ ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 130, 'left');
      if (got) text('+' + got, cx + w / 2 - 56, y, 13, INK.gold, 'right');
      text(String(held), cx + w / 2 - 22, y, 15, INK.text, 'right');
    });
    const nk = nextKeeper(t);
    const nextLine = (t.champ !== -1 ? 'a new match in ' : 'next round in ') + Math.ceil(t.pt / HZ) +
      (nk !== -1 && t.champ === -1 ? ' · ' + who(nk) + (nk === me ? ' keep' : ' keeps') + ' the light' : ' · everyone keeps the light once');
    fitText(nextLine, cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Positions between two tables: a boat that has just been moored again is
// drawn where the newer table has it rather than rowed there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || (q.x - p.x) ** 2 + (q.y - p.y) ** 2 > 0.04) return [p.x, p.y];
  return [lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k)];
}

// The beam between two tables, the short way round.
function beamBetween(b) {
  const a0 = Math.atan2(b.from.by, b.from.bx), a1 = Math.atan2(b.to.by, b.to.bx);
  let da = a1 - a0;
  if (da > Math.PI) da -= Math.PI * 2;
  else if (da < -Math.PI) da += Math.PI * 2;
  const a = a0 + da * b.k;
  return [Math.cos(a), Math.sin(a)];
}

// Your own boat is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a bay taken afresh — is taken at once.
let shown = null;
const SNAP = 0.15;
function settle(tx, ty) {
  if (!shown || (tx - shown[0]) ** 2 + (ty - shown[1]) ** 2 > SNAP * SNAP) return (shown = [tx, ty]);
  const k = per60(0.35);
  shown[0] += (tx - shown[0]) * k;
  shown[1] += (ty - shown[1]) * k;
  return shown;
}

let myPos = null;      // [x, y]: where your boat is drawn
let wasKeeper = false;
let aimShown = null;   // where you, keeping the light, are turning it to
function draw(now) {
  drawSea(now);
  const b = agreedAt(now);
  if (!b) {
    myPos = shown = null;
    drawShore(now);
    flat();
    panel(cx, cy, Math.min(VW - 32, 300), 60);
    text('rowing out to the bay…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const me = myId();
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a bay this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const keeping = t.kp === me && (t.ph === COUNT || t.ph === PLAY);
  if (keeping !== wasKeeper) { wasKeeper = keeping; roleChanged(keeping); }
  const m = mineAt(now);
  // The beam: from the guess while you keep it, so it answers your hand at once.
  const beamFrom = keeping && m ? m : b;
  const [bx, by] = beamBetween(beamFrom);
  const fo = beamFrom.to.fo;
  const keeperInk = t.kp !== -1 && t.p[t.kp] ? colourOf(t, t.kp) : INK.lamp;
  // What the bay calls lit, drawn with the beam as shown.
  const shownBeam = { bx, by, fo, rk: t.rk };

  drawShore(now);
  drawBeam(t, bx, by, fo, keeperInk, now);
  inField();
  for (const c of t.c) drawCrate(c[0], c[1], c[2], c[3], nShown, now);
  drawRocks(t, bx, by, fo);
  drawIsland(t, bx, by, keeperInk, now);

  inField();
  const lead = leaderOf(t);
  const ids = playersIn(t);
  let mine = null;
  if (!keeping && m && m.to.p[me] && t.p[me] && t.kp !== me) {
    const pos = between(m, me);
    if (pos) {
      const s = settle(pos[0], pos[1]);
      // What the bay says about your boat — the gauge, the daze — is the agreed one.
      mine = { d: t.p[me], g: m.to.p[me], x: s[0], y: s[1] };
    }
  }
  myPos = mine ? [mine.x, mine.y] : (shown = null);
  for (const id of ids) {
    if (id === me || id === t.kp) continue;
    const d = t.p[id], pos = between(b, id);
    if (pos) drawBoat(id, pos[0], pos[1], d, SEAT[d.k], false, lit(shownBeam, pos[0], pos[1]) && t.ph !== WAIT, id === lead, now);
  }
  if (mine) {
    const d = { ...mine.d, fx: mine.g.fx, fy: mine.g.fy, cr: mine.g.cr };
    const seen = lit(shownBeam, mine.x, mine.y) && t.ph !== WAIT;
    drawBoat(me, mine.x, mine.y, d, SEAT[d.k], true, seen, me === lead, now);
    if (seen && t.ph === PLAY && mine.d.dz === 0 && mine.d.im === 0) sound.seen(mine.d.ex);
  }
  // Names under the others, so a shove has somebody to be aimed at.
  flat();
  for (const id of ids) {
    if (id === me || id === t.kp) continue;
    const pos = between(b, id);
    if (pos) fitText(nickOf(id), SX(pos[0]), SY(pos[1]) + BR * sc + 14, 11, INK.text, 90);
  }
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: a direction in thousandths, how many dashes so far, and
// whether the lamp is narrowed. A rower's direction is where to row; the
// keeper's is where to turn the lamp. Setting off and stopping go out at once;
// a change of direction goes out no oftener than TURN_EVERY, because a thumb
// moving in a circle changes it on every move the screen reports and the
// clock's ticks share the same seat's ceiling on messages.
const TURN_EVERY = 66;
let wanted = [0, 0];
let lastSaid = [0, 0];
let saidAt = -1e9;
let dashes = 0;
let narrowed = 0;
let saidNarrow = 0;
let keeperNow = false;
let aimA = null;          // the keeper's aim off the keys, radians

function shove(fx_, fy_) {
  const far = Math.hypot(fx_, fy_);
  wanted = far < 0.01 ? [0, 0] : [Math.round((fx_ / far) * 1000), Math.round((fy_ / far) * 1000)];
  if (keeperNow && far >= 0.01) aimShown = wanted;
  sayHand(performance.now());
}
function sayHand(now) {
  const d = wanted;
  const fine = keeperNow ? 30 : 80;
  if (narrowed === saidNarrow && Math.hypot(d[0] - lastSaid[0], d[1] - lastSaid[1]) < fine) return;
  const still = (v) => v[0] === 0 && v[1] === 0;
  if (narrowed === saidNarrow && !still(d) && !still(lastSaid) && now - saidAt < TURN_EVERY) return;
  lastSaid = d;
  saidNarrow = narrowed;
  saidAt = now;
  setHand([d[0], d[1], dashes, narrowed]);
}
function setNarrow(on) {
  narrowed = on && keeperNow ? 1 : 0;
  sayHand(performance.now());
}

// Taking the lamp, or handing it on, starts the hand afresh: a direction to
// row in is no aim for a lamp, and the other way round.
function roleChanged(keeping) {
  keeperNow = keeping;
  aimA = null;
  aimShown = null;
  narrowed = 0;
  keys.clear();
  dropStick();
  mouse = null;
  wanted = [0, 0];
  sayHand(performance.now());
}

// A dash is asked for no sooner than the bay will allow it, so it is never
// spent on a cooldown; you hear and see it at once, and the bay carries it out
// a trip later on every copy alike.
function dash() {
  wake();
  if (!world || keeperNow) return;
  const d = world.p[myId()];
  const now = performance.now();
  if (world.ph === COUNT || !d || d.dz > 0 || now - myDashAt < DASH_MS) return;
  myDashAt = now;
  dashes = (dashes + 1) % 64;
  lastSaid = wanted;
  saidAt = now;
  setHand([wanted[0], wanted[1], dashes, narrowed]);
  if (myPos) {
    ring(myPos[0], myPos[1], SEAT[d.k], BR * 2.6);
    spray(myPos[0], myPos[1], 6, 'rgba(220,235,255,0.8)', 0.3, 0.008);
    lookOf(myId()).squash = 1;
    sound.splash();
  }
}

// Keys are read by where they sit, not what they type, so every layout runs.
const RUN_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
const keys = new Set();
function fromKeys() {
  let dx = 0, dy = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1;
  return [dx, dy];
}
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'KeyE' || e.code === 'Enter') {
    e.preventDefault();
    if (keeperNow) setNarrow(true);
    else if (!e.repeat) dash();
    return;
  }
  if (!RUN_KEYS.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  keys.add(e.code);
  if (!keeperNow && !stick && !mouse) shove(...fromKeys());
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'KeyE' || e.code === 'Enter') { if (keeperNow) setNarrow(false); return; }
  keys.delete(e.code);
  if (!keeperNow && !stick && !mouse) shove(...fromKeys());
});
addEventListener('blur', () => { keys.clear(); dropStick(); mouse = null; if (keeperNow) setNarrow(false); else shove(0, 0); });

// The keeper on the keys: left and right turn the aim, up and down point it.
function keeperKeys() {
  if (!keeperNow || !keys.size || stick) return;
  const [dx, dy] = fromKeys();
  if (aimA === null) aimA = world ? Math.atan2(world.by, world.bx) : 0;
  const turnKeys = (keys.has('ArrowLeft') || keys.has('KeyA') ? -1 : 0) + (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0);
  if (turnKeys) aimA += turnKeys * 2.4 * frameDt;
  else if (dy) aimA = Math.atan2(dy, dx);
  shove(Math.cos(aimA), Math.sin(aimA));
}

// A rower's thumb: a stick from wherever it lands, and a tap dashes — a drag
// rather than a press, because iOS keeps a long press inside a frame for
// itself. A second finger down while the first rows dashes too.
// A rower's mouse: hold the button and the boat rows to the pointer; a click
// dashes toward it.
// The keeper's thumb drags the aim to where it is; a tap narrows or widens the
// lamp. The keeper's mouse aims wherever it points, and a held button narrows.
const DEAD = 8;
const REACHOUT = 46;
let stick = null;
let mouse = null;

function dropStick() {
  stick = null;
  paintStick(0, 0);
  if (!mouse && !keeperNow) shove(...fromKeys());
}
// Where the lamp is on screen, so a pointer can be aimed from it.
function aimAt(clientX, clientY) {
  const r = cv.getBoundingClientRect();
  const dx = clientX - r.left - SX(0), dy = clientY - r.top - SY(0);
  if (Math.hypot(dx, dy) < 6) return;
  aimA = null;
  shove(dx, dy);
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    if (keeperNow) {
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
      stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false, aim: true };
      return;
    }
    if (stick) { dash(); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
    paintStick(0, 0);
    return;
  }
  coarse = false;
  if (e.button !== 0 && e.button !== 2) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mouse = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
  if (keeperNow) { aimAt(e.clientX, e.clientY); setNarrow(true); }
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    if (Math.hypot(dx, dy) >= DEAD) stick.moved = true;
    if (stick.aim) {
      if (stick.moved) aimAt(e.clientX, e.clientY);
      return;
    }
    paintStick(dx, dy);
    const still = Math.hypot(dx, dy) < DEAD;
    shove(still ? 0 : dx, still ? 0 : dy);
  } else if (e.pointerType !== 'touch') {
    if (keeperNow) aimAt(e.clientX, e.clientY);
    if (mouse && e.pointerId === mouse.id) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      if (Math.hypot(mouse.x - mouse.ox, mouse.y - mouse.oy) > 6) mouse.moved = true;
    }
  }
});
function lift(e) {
  if (stick && e.pointerId === stick.id) {
    const tap = !stick.moved && performance.now() - stick.at < 260;
    const aiming = stick.aim;
    dropStick();
    if (aiming) { if (tap && keeperNow) setNarrow(!narrowed); return; }
    if (tap) dash();
  } else if (mouse && e.pointerId === mouse.id) {
    const click = !mouse.moved && performance.now() - mouse.at < 220;
    const toward = pointerWay(mouse);
    mouse = null;
    if (keeperNow) { setNarrow(false); return; }
    if (click) {
      // A click dashes toward the pointer: the hand that asks for it points
      // there, and the bay turns the bow that way as it takes the dash.
      if (toward) shove(toward[0], toward[1]);
      dash();
    }
    shove(...fromKeys());
  }
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

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

function paintStick(dx, dy) {
  if (!stick || stick.aim) { stickRing.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(dx, dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
  stickRing.style.display = knob.style.display = 'block';
  stickRing.style.left = stick.ox + 'px';
  stickRing.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + dx * k + 'px';
  knob.style.top = stick.oy + dy * k + 'px';
}

// The way from where your boat is drawn to the pointer, in pixels.
function pointerWay(m) {
  if (!m || !myPos) return null;
  const r = cv.getBoundingClientRect();
  return [m.x - r.left - SX(myPos[0]), m.y - r.top - SY(myPos[1])];
}

// The mouse rows toward the pointer, held down.
function steerToMouse() {
  if (!mouse || !myPos || keeperNow) return;
  const [dx, dy] = pointerWay(mouse);
  // A held button that has not moved yet may still be a click.
  if (!mouse.moved && performance.now() - mouse.at < 220) return;
  // Stopped on arrival, and off again only once the pointer is clearly away:
  // one threshold for both makes a boat that stops and starts on every twitch.
  const far = Math.hypot(dx, dy);
  if (far < 10) mouse.parked = true;
  else if (far > 24) mouse.parked = false;
  if (mouse.parked) shove(0, 0);
  else shove(dx, dy);
}

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  steerToMouse();
  keeperKeys();
  sayHand(now);
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Resting on the oars is a hand too: it
// is how a boat arrives in the bay.
function start() {
  setHand([0, 0, dashes, 0]);
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
  const at = world
    ? stepClock !== null && tripMs !== null
      ? Math.max(world.n, Math.floor(stepNow(performance.now()) + tripMs / STEP_MS))
      : world.n + aheadSteps()
    : 0;
  unheard.push({ seq: inSeq, at: performance.now(), step: at, input: myHand, measured });
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
let guessPrev = null, guessLast = null;     // { n, t }
let guessTable = null;
let reach = 0;                               // steps the guess runs ahead of the agreed table

function aheadSteps() {
  if (!PREDICT || solo() || tripMs === null) return 0;
  // Moved only when the trip has moved a whole step: a guess that flips
  // between two reaches jumps everything it draws back and forth by a step.
  const want = Math.min(GUESS_REACH, tripMs / STEP_MS);
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
  const o = performance.now() - world.n * STEP_MS;
  if (stepClock === null) stepClock = o;
  else stepClock += (o - stepClock) * (o < stepClock ? 0.3 : 0.02);
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
  if (!world) return;
  if (!PREDICT || solo()) { guessPrev = guessLast = guessTable = null; return; }
  const reachNow = Math.max(aheadSteps(), STEPS_PER_TICK);
  const [before, t] = played(reachNow, STEPS_PER_TICK);
  guessPrev = { n: before.n, t: before };
  guessLast = { n: t.n, t };
  guessTable = t;
}

// The agreed table as drawn: { from, to, k }.
function agreedAt(now) {
  if (!agreed.length) return null;
  const at = stepNow(now) - SHOWN_BEHIND;
  let i = agreed.length - 1;
  while (i > 0 && agreed[i].n > at) i--;
  const a = agreed[i], b = agreed[i + 1] || a;
  const k = b === a ? 0 : Math.max(0, Math.min(1, (at - a.n) / (b.n - a.n)));
  return { from: a.t, to: b.t, k };
}

// This copy's own piece as drawn: { from, to, k } — the agreed table where
// there is no guess to draw it from.
function mineAt(now) {
  if (!guessLast) return agreedAt(now);
  const a = guessPrev || guessLast, b = guessLast;
  const at = stepNow(now) + Math.max(reach, STEPS_PER_TICK) - STEPS_PER_TICK;
  const k = b.n === a.n ? 1 : Math.max(0, Math.min(1, (at - a.n) / (b.n - a.n)));
  return { from: a.t, to: b.t, k };
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
