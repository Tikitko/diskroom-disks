/**
 * @disk     slipstream
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Top-down micro racing where the car in front is your engine. Tuck in behind a rival to charge a slingshot, then pull out and fling past them. Ram somebody while you fly and they spin. Five laps, a new track every race.
 * @tags     game, party, realtime, racing, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/slipstream.png
 */
// slipstream.js — a top-down race where the room's order is the referee.
//
// Every copy holds the whole race — every car, the track, the laps and the
// charge in every slingshot — and moves it only on what comes back round the
// room, so every copy applies the same hands in the same order and holds the
// same race. Nobody sends where their car is, a lap, a finish or a score: a
// hand is a steer, an aim and a pedal and nothing else, and how fast a car
// goes, whose wake it sits in, who bumps whom and who crosses the line first
// is the same arithmetic on the same numbers on every machine. A page with a
// console open can drive its own car however it likes, at a car's own pace,
// and no faster.
//
// While a driver is alone, a bot races with them. It is a car in the race like
// any other, and its hand is a function of the race alone, so it drives the
// same on every copy and says nothing over the wire. When a second driver
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the grid is laid out: it never takes part in a race.
//
// Your own car does not wait for the trip: it is drawn from the agreed race
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.abs`, `Math.min`,
// `Math.max` and `Math.imul` are fixed by the language to the last bit;
// `Math.sin` and `Math.cos` are not, so a car turns by a short series instead.

// A heading turned by a small angle `a`, kept a unit vector. Turns in one step
// are well under half a radian, where the series is exact to far below what a
// car's heading cares about.
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

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the race a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own car a trip ahead, with your hand in it
const DT = 1 / HZ;

const FW = 1.6, FH = 1.0;      // the field: every track fits this box
const N = 240;                 // points along a track's middle line
const HW = 0.078;              // half the road's width
const WALL = HW + 0.026;       // how far from the middle line the barrier stands
const CR = 0.016;              // a car's radius, against another car
const VMAX = 0.62;             // the fastest a car drives on its own
const GAS_K = 1.7;             // how quickly the gas brings a car up to speed
const BRAKE = 1.5;             // speed a second the brake takes off
const COAST = 0.7;             // and the share a second a car rolling free loses
const BLEED = 0.55;            // speed a second a car over its cap sheds
const GRASS = 0.5;             // a car's cap off the road, as a share
const GRIP = 0.78;             // what one step leaves of a car's sideways slide on the road
const GRIP_GRASS = 0.9;        // and on the grass, where it slides more
const TURN = 3.6;              // radians a second at full lock
const DRAFT_LEN = 0.26;        // how far behind a car its wake reaches
const DRAFT_TOW = 1.1;         // a car in a wake drives this much faster
const CHARGE_S = 1.3;          // seconds in a wake that fill a slingshot
const SLING_MIN = 0.3;         // a slingshot weaker than this fizzles instead
const BOOST_STEPS = Math.round(1.5 * HZ);  // a full slingshot lasts this long
const BOOST_X = 1.4;           // and lifts the cap this much
const RAM = 0.2;               // closing speed at which a slingshot spins whoever it hits
const SPIN_STEPS = Math.round(0.8 * HZ);
const GHOST_STEPS = Math.round(1.5 * HZ);  // a car just put down passes through the others
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const LAPS = 5;
const PTS = [10, 7, 5, 4, 3, 2, 1, 0];

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second driver arrives
const PLAY_STEPS = 180 * HZ;   // no race runs longer than this
const CLOSE_STEPS = 15 * HZ;   // the rest have this long once somebody has finished
const END_STEPS = 8 * HZ;

// ── the tracks ─────────────────────────────────────────────────────────────
// Each is a loop of points the road's middle line runs smoothly through, and
// where its start line stands. The line is laid once, at load, by arithmetic
// alone, so every copy lays it to the same bits; a table only names which.
const TRACKS = [
  { name: 'goggles', at: 0.06, cp: [[0.32, 0.2], [0.8, 0.15], [1.28, 0.2], [1.46, 0.42], [1.38, 0.76], [1.08, 0.85], [0.86, 0.66], [0.62, 0.86], [0.28, 0.82], [0.15, 0.52]] },
  { name: 'hairpin', at: 0.04, cp: [[0.22, 0.2], [0.62, 0.14], [1.05, 0.2], [1.4, 0.14], [1.48, 0.3], [1.2, 0.36], [0.86, 0.5], [1.2, 0.68], [1.46, 0.74], [1.32, 0.88], [0.72, 0.86], [0.3, 0.84], [0.14, 0.52]] },
  { name: 'crown', at: 0.02, cp: [[0.2, 0.16], [0.52, 0.18], [0.78, 0.42], [1.04, 0.18], [1.4, 0.16], [1.47, 0.46], [1.16, 0.62], [1.4, 0.84], [0.84, 0.86], [0.52, 0.66], [0.24, 0.86], [0.13, 0.5]] },
  { name: 'kink', at: 0.07, cp: [[0.25, 0.18], [0.9, 0.14], [1.42, 0.2], [1.44, 0.46], [1.1, 0.58], [1.42, 0.78], [1.0, 0.87], [0.62, 0.7], [0.32, 0.86], [0.14, 0.56]] },
];

// A loop through the points (Catmull-Rom), walked finely and then laid again
// at N points an equal distance apart, starting at the start line. Each point
// carries its direction along the road and the road's length to it.
function layTrack(def) {
  const cp = def.cp, m = cp.length, dense = [];
  for (let i = 0; i < m; i++) {
    const p0 = cp[(i + m - 1) % m], p1 = cp[i], p2 = cp[(i + 1) % m], p3 = cp[(i + 2) % m];
    for (let s = 0; s < 32; s++) {
      const t = s / 32, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const D = dense.length, cum = [0];
  for (let i = 1; i <= D; i++) {
    const a = dense[i - 1], b = dense[i % D], dx = b[0] - a[0], dy = b[1] - a[1];
    cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const len = cum[D], x = [], y = [];
  let j = 0;
  for (let i = 0; i < N; i++) {
    let s = len * (def.at + i / N);
    if (s >= len) s -= len;
    if (s < cum[j]) j = 0;
    while (cum[j + 1] < s) j++;
    const a = dense[j], b = dense[(j + 1) % D], k = (s - cum[j]) / (cum[j + 1] - cum[j]);
    x.push(a[0] + (b[0] - a[0]) * k);
    y.push(a[1] + (b[1] - a[1]) * k);
  }
  const tx = [], ty = [];
  for (let i = 0; i < N; i++) {
    const dx = x[(i + 1) % N] - x[(i + N - 1) % N], dy = y[(i + 1) % N] - y[(i + N - 1) % N];
    const l = Math.sqrt(dx * dx + dy * dy);
    tx.push(dx / l);
    ty.push(dy / l);
  }
  return { name: def.name, x, y, tx, ty, len };
}
const LAID = TRACKS.map(layTrack);

// Where a car stands against its track: the stretch of road it is on, found
// near the one it was on last — never further, so no car is ever counted on a
// stretch it could only reach by cutting across the grass — how far along it,
// and how far off the middle line, signed (positive is to the right).
const NEAR_BACK = 5, NEAR_AHEAD = 6;
function locate(T, ci, x, y) {
  let best = ci, bu = 0, bd = Infinity, bs = 0;
  for (let o = -NEAR_BACK; o <= NEAR_AHEAD; o++) {
    const i = (ci + o + N) % N, j = (i + 1) % N;
    const ax = T.x[i], ay = T.y[i], sx = T.x[j] - ax, sy = T.y[j] - ay;
    const ll = sx * sx + sy * sy;
    const u = clamp(((x - ax) * sx + (y - ay) * sy) / ll, 0, 1);
    const px = ax + sx * u, py = ay + sy * u, dx = x - px, dy = y - py;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; bu = u; bs = sx * dy - sy * dx; }
  }
  const dist = Math.sqrt(bd);
  return { ci: best, u: bu, off: bs >= 0 ? dist : -dist };
}

// The race. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every car is made by one function with its fields in one order.
//   tr: the track; fin: how many have finished this race
//   res: the last race's [id, place, points, races won] rows, place 0 for
//   somebody who never finished; win: its winner or -1
function freshTable(seed) {
  return { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, tr: 0, fin: 0, p: {}, res: null, win: -1 };
}

const FIELDS = ['k', 'x', 'y', 'vx', 'vy', 'hx', 'hy', 'tu', 'ax', 'ay', 'fl', 'ci', 'L', 'ch', 'bo', 'dr',
  'sp', 'gh', 'wl', 'fn', 'sc', 'wn', 'hs', 'hc'];
//   k: seat, which is its colour; x, y, vx, vy: the car; hx, hy: where it
//   points, a unit vector; tu, ax, ay, fl: the hand — a turn of the keys, an
//   aim in thousandths, and the pedals; ci: the stretch of road it is on; L:
//   laps begun; ch: the slingshot's charge, 0..1; bo: steps of slingshot
//   left; dr: whose wake it sits in, or -1; sp: steps of spin left; gh: steps
//   it still passes through the others; wl: 1 while it scrapes the barrier;
//   fn: its place at the line this race, 0 until then; sc: points this cup;
//   wn: races won; hs, hc: hands this step.
function car(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const sorted = (w) => playersIn(w).sort((a, b) => a - b);
const trackOf = (w) => LAID[w.tr];

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// The grid: two columns behind the start line, a row every three points.
function gridSpot(T, slot) {
  const i = (N - 3 - 3 * Math.floor(slot / 2)) % N;
  const side = slot % 2 ? 1 : -1;
  // To the right of the road's direction is (-ty, tx) on a screen whose y runs down.
  const nx = -T.ty[i], ny = T.tx[i];
  return { ci: i, x: T.x[i] + nx * side * HW * 0.45, y: T.y[i] + ny * side * HW * 0.45, hx: T.tx[i], hy: T.ty[i] };
}

function place(w, d, slot) {
  const T = trackOf(w), g = gridSpot(T, slot);
  d.x = g.x; d.y = g.y; d.hx = g.hx; d.hy = g.hy; d.ci = g.ci;
  d.vx = 0; d.vy = 0; d.L = 0; d.ch = 0; d.bo = 0; d.dr = -1; d.sp = 0; d.gh = GHOST_STEPS; d.wl = 0; d.fn = 0;
}

function newCar(w, id) {
  const d = (w.p[id] = car({
    k: freeSeat(w), x: 0, y: 0, vx: 0, vy: 0, hx: 1, hy: 0, tu: 0, ax: 0, ay: 0, fl: 0, ci: 0, L: 0, ch: 0, bo: 0,
    dr: -1, sp: 0, gh: 0, wl: 0, fn: 0, sc: 0, wn: 0, hs: w.n, hc: 0,
  }));
  place(w, d, Object.keys(w.p).length - 1);
  fx(w, 'spawn', d.x, d.y, id);
  return d;
}

// A hand, at its place in the room's order: [turn, aim x, aim y, pedals].
// Being heard is how a driver arrives, and their car is put down on the grid.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = newCar(w, id);
  }
  // A flood of hands in one step is cut off where no driver's thumb could
  // reach, on every copy alike; the ones that are heard only ever steer.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.tu = input[0];
  d.ax = input[1];
  d.ay = input[2];
  d.fl = input[3];
}

// A hand off the wire, made safe: four integers in their ranges, or nothing.
// How hard a car turns or how fast it goes is the car's business, not the
// hand's: any aim, however long, drives at a car's pace.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [tu, ax, ay, fl] = raw;
  if (![tu, ax, ay, fl].every(Number.isInteger)) return null;
  if (tu < -1 || tu > 1 || ax < -1000 || ax > 1000 || ay < -1000 || ay > 1000 || fl < 0 || fl > 3) return null;
  return [tu, ax, ay, fl];
}

function leave(w, id) {
  delete w.p[id];
}

// Where a car stands in the race: finished cars by their place, the rest by
// how far round they are, the stretch of road and how far along it included.
function progress(T, d) {
  const i = d.ci, j = (i + 1) % N, sx = T.x[j] - T.x[i], sy = T.y[j] - T.y[i];
  const u = clamp(((d.x - T.x[i]) * sx + (d.y - T.y[i]) * sy) / (sx * sx + sy * sy), 0, 1);
  return d.L * N + i + u;
}
function standings(w) {
  const T = trackOf(w);
  const pg = new Map();
  for (const id of playersIn(w)) pg.set(id, progress(T, w.p[id]));
  return sorted(w).sort((a, b) => {
    const A = w.p[a], B = w.p[b];
    if (A.fn && B.fn) return A.fn - B.fn;
    if (A.fn || B.fn) return A.fn ? -1 : 1;
    return pg.get(b) - pg.get(a) || a - b;
  });
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  for (const id of playersIn(w)) w.p[id].fn = 0;
}

// A race: a new track, the drivers on the grid in seat order, lights out in
// three seconds.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.fin = 0;
  w.tr = (w.tr + 1 + Math.floor(draw01(w) * (LAID.length - 1))) % LAID.length;
  const ids = sorted(w).sort((a, b) => w.p[a].k - w.p[b].k);
  ids.forEach((id, i) => {
    const d = w.p[id];
    place(w, d, i);
    d.gh = 0;
  });
  fx(w, 'round');
}

function finish(w) {
  const order = standings(w);
  const res = order.map((id) => {
    const d = w.p[id];
    return [id, d.fn, d.fn ? PTS[Math.min(d.fn, PTS.length) - 1] : 0, d.wn];
  });
  for (const r of res) w.p[r[0]].sc += r[2];
  const first = res.find((r) => r[1] === 1);
  w.win = first ? first[0] : -1;
  if (first) { w.p[first[0]].wn += 1; first[3] += 1; }
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, w.win);
}

// One car through one step: the hand, the pedals, the grip, the road.
function drive(w, T, id, d) {
  if (d.gh > 0) d.gh -= 1;
  const nx = -d.hy, ny = d.hx;
  let f = d.vx * d.hx + d.vy * d.hy;      // speed along where it points
  let l = d.vx * nx + d.vy * ny;          // and its slide sideways
  const at = locate(T, d.ci, d.x, d.y);
  const grass = Math.abs(at.off) > HW;
  let cap = VMAX * (grass ? GRASS : 1);
  if (id === BOT_ID) cap *= BOT_PACE;
  if (d.dr !== -1) cap *= DRAFT_TOW;
  if (d.bo > 0) cap *= BOOST_X;

  let steer = 0, gas = false, brake = false;
  if (d.sp > 0) {
    d.sp -= 1;
    const h = turned(d.hx, d.hy, 9 * DT * (d.k % 2 ? 1 : -1));
    d.hx = h[0]; d.hy = h[1];
  } else if (d.ax !== 0 || d.ay !== 0) {
    // An aim: turn toward it, with gas, and brake for one that points back.
    const al = Math.sqrt(d.ax * d.ax + d.ay * d.ay), ux = d.ax / al, uy = d.ay / al;
    const cross = d.hx * uy - d.hy * ux, dot = d.hx * ux + d.hy * uy;
    steer = dot > 0 ? clamp(cross * 4, -1, 1) : cross >= 0 ? 1 : -1;
    gas = (d.fl & 1) === 1 && dot > -0.2;
    brake = (d.fl & 2) === 2 || dot <= -0.2;
  } else {
    steer = d.tu;
    gas = (d.fl & 1) === 1;
    brake = (d.fl & 2) === 2;
  }
  if (w.ph === COUNT) { gas = false; brake = true; steer = 0; }

  if (d.sp === 0 && steer !== 0) {
    // A car turns hardest at a middling speed, a little less flat out, and
    // still pivots slowly when it stands, so a car nose-first in a barrier
    // can always get out.
    const sp = Math.abs(f);
    const rate = TURN * steer * (0.35 + 0.65 * clamp(sp / 0.18, 0, 1)) * (1 - 0.3 * clamp(sp / VMAX, 0, 1));
    const h = turned(d.hx, d.hy, rate * DT);
    d.hx = h[0]; d.hy = h[1];
  }
  if (d.bo > 0) {
    d.bo -= 1;
    f += (cap - f) * GAS_K * 2 * DT;
  } else if (gas) {
    if (f < cap) f += (cap - f) * GAS_K * DT;
  } else if (brake) {
    f = Math.max(0, f - BRAKE * DT);
  } else {
    f -= f * COAST * DT;
  }
  if (f > cap) f = Math.max(cap, f - BLEED * DT);
  if (f < 0) f = Math.min(0, f + BRAKE * DT);
  l *= d.sp > 0 ? 0.95 : grass ? GRIP_GRASS : GRIP;
  const nx2 = -d.hy, ny2 = d.hx;
  d.vx = d.hx * f + nx2 * l;
  d.vy = d.hy * f + ny2 * l;
  d.x += d.vx * DT;
  d.y += d.vy * DT;

  // The road under it now, the laps it crossed the line for, and the barrier.
  const was = d.ci;
  const now = locate(T, was, d.x, d.y);
  d.ci = now.ci;
  if (was > N - 20 && d.ci < 20) crossed(w, id, d);
  else if (was < 20 && d.ci > N - 20) d.L = Math.max(-3, d.L - 1);
  if (Math.abs(now.off) > WALL) {
    const i = now.ci, j = (i + 1) % N;
    const px = T.x[i] + (T.x[j] - T.x[i]) * now.u, py = T.y[i] + (T.y[j] - T.y[i]) * now.u;
    const k = (now.off > 0 ? 1 : -1);
    const rx = -T.ty[i] * k, ry = T.tx[i] * k;   // pointing out through the barrier
    d.x = px + rx * WALL;
    d.y = py + ry * WALL;
    const out = d.vx * rx + d.vy * ry;
    if (out > 0) { d.vx -= rx * out; d.vy -= ry * out; }
    d.vx *= 0.97; d.vy *= 0.97;
    if (!d.wl) fx(w, 'scrape', d.x, d.y, id, out);
    d.wl = 1;
  } else d.wl = 0;
}

// Over the line, forward. In practice the laps simply count; in a race the
// last one is a finish, and the first finish starts the clock on everybody else.
function crossed(w, id, d) {
  d.L += 1;
  if (w.ph !== PLAY || d.fn) {
    if (d.L > 99) d.L = 1;
    if (d.L > 1) fx(w, 'lap', d.x, d.y, id, d.L);
    return;
  }
  if (d.L > LAPS) {
    w.fin += 1;
    d.fn = w.fin;
    d.L = LAPS + 1;
    fx(w, 'finish', d.x, d.y, id, d.fn);
    if (d.fn === 1) w.pt = Math.min(w.pt, CLOSE_STEPS);
  } else if (d.L > 1) fx(w, 'lap', d.x, d.y, id, d.L);
}

// Whose wake every car sits in: a car not far ahead, pointing much the same
// way, going at some pace, with this one inside the cone it leaves behind.
// Every car is weighed against the table as the step found it, then the
// charge is changed, so the order cars are looked at in never decides a wake.
function wakes(w, ids) {
  const sat = new Map();
  for (const a of ids) {
    const A = w.p[a];
    if (A.sp > 0) { sat.set(a, -1); continue; }
    let best = -1, near = DRAFT_LEN;
    for (const b of ids) {
      if (b === a) continue;
      const B = w.p[b];
      if (B.sp > 0 || B.gh > 0 || B.fn) continue;
      const fb = B.vx * B.hx + B.vy * B.hy;
      if (fb < 0.25 || A.hx * B.hx + A.hy * B.hy < 0.75) continue;
      const dx = B.x - A.x, dy = B.y - A.y;
      const along = dx * A.hx + dy * A.hy, side = Math.abs(dx * -A.hy + dy * A.hx);
      if (along < 0.03 || along >= near || side > 0.028 + along * 0.12) continue;
      near = along;
      best = b;
    }
    sat.set(a, best);
  }
  for (const a of ids) {
    const A = w.p[a], b = sat.get(a);
    A.dr = b;
    if (b !== -1) {
      A.ch = Math.min(1, A.ch + DT / CHARGE_S);
    } else if (A.ch >= SLING_MIN && A.sp === 0) {
      // Out of the wake with a charge: the slingshot goes off.
      A.bo = Math.max(A.bo, Math.round(A.ch * BOOST_STEPS));
      fx(w, 'sling', A.x, A.y, a, A.ch);
      A.ch = 0;
    } else {
      A.ch = Math.max(0, A.ch - DT * 0.5);
    }
  }
}

// Cars that touch push apart and trade what they were closing at. A car on a
// slingshot that hits another hard spins it; the one spun loses its charge.
function bumps(w, ids) {
  for (let i = 0; i < ids.length; i++) {
    const A = w.p[ids[i]];
    if (A.gh > 0 || A.fn) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const B = w.p[ids[j]];
      if (B.gh > 0 || B.fn) continue;
      const dx = B.x - A.x, dy = B.y - A.y, dd = dx * dx + dy * dy;
      if (dd >= 4 * CR * CR || dd < 1e-12) continue;
      const dist = Math.sqrt(dd), nx = dx / dist, ny = dy / dist, push = (2 * CR - dist) / 2;
      A.x -= nx * push; A.y -= ny * push;
      B.x += nx * push; B.y += ny * push;
      const rv = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
      if (rv >= 0) continue;
      const jn = (-(1 + 0.4) * rv) / 2;
      A.vx -= nx * jn; A.vy -= ny * jn;
      B.vx += nx * jn; B.vy += ny * jn;
      const hard = -rv;
      let spun = -1;
      if (hard > RAM && A.bo > 0 && B.bo === 0 && B.sp === 0) spun = ids[j];
      else if (hard > RAM && B.bo > 0 && A.bo === 0 && A.sp === 0) spun = ids[i];
      if (spun !== -1) {
        const V = w.p[spun];
        V.sp = SPIN_STEPS;
        V.ch = 0;
        fx(w, 'ram', (A.x + B.x) / 2, (A.y + B.y) / 2, spun, spun === ids[j] ? ids[i] : ids[j]);
      } else if (hard > 0.06) fx(w, 'bump', (A.x + B.x) / 2, (A.y + B.y) / 2, ids[i], ids[j], hard);
    }
  }
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_PACE = 0.93;         // the bot's cap, as a share of everybody else's
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot drives while the race waits for a race, and goes the moment a race's
// grid is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && Object.keys(w.p).length < MAX_P) newCar(w, BOT_ID);
  else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// The bot's hand: it looks down the road as far as its speed carries it and
// aims there, brakes when the road ahead bends away hard, tucks in behind
// you when you are just ahead, and pulls out to slingshot once it is charged.
// Now and then it lifts off the gas a moment, so it can be beaten.
function botHand(w, T) {
  const d = w.p[BOT_ID];
  if (!d || w.n % BOT_EVERY) return;
  const f = d.vx * d.hx + d.vy * d.hy;
  const look = (d.ci + 7 + Math.round(f * 14)) % N, far = (d.ci + 22) % N;
  let tx = T.x[look], ty = T.y[look];
  let target = null;
  for (const id of humans(w).sort((a, b) => a - b)) {
    const o = w.p[id];
    const dx = o.x - d.x, dy = o.y - d.y, along = dx * d.hx + dy * d.hy;
    if (along > 0.05 && along < 0.4 && Math.abs(dx * -d.hy + dy * d.hx) < 0.12) { target = o; break; }
  }
  if (target) {
    if (d.ch < 0.85) { tx = target.x; ty = target.y; }
    else {
      // Charged: step out to the side the road leaves more room on.
      const i = target.ci, side = (target.x - T.x[i]) * -T.ty[i] + (target.y - T.y[i]) * T.tx[i] > 0 ? -1 : 1;
      tx += -T.ty[look] * side * HW * 0.8;
      ty += T.tx[look] * side * HW * 0.8;
    }
  }
  const ax = tx - d.x, ay = ty - d.y, al = Math.sqrt(ax * ax + ay * ay) || 1;
  const bx = T.x[far] - d.x, by = T.y[far] - d.y, bl = Math.sqrt(bx * bx + by * by) || 1;
  const bend = (bx / bl) * d.hx + (by / bl) * d.hy;
  let fl = 1;
  if (bend < 0.55 && f > 0.34) fl = 2;
  if (draw01(w) < 0.06) fl = 0;
  d.tu = 0;
  d.ax = Math.round((ax / al) * 1000);
  d.ay = Math.round((ay / al) * 1000);
  d.fl = fl;
}

// One step of the race: a function of the race alone.
function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second driver ends practice, three seconds on: the count runs in pt,
    // which a waiting race otherwise leaves at zero. The bot goes first, so the
    // grid is laid out without it.
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
      if (w.pt <= 0 || (w.fin > 0 && humans(w).every((id) => w.p[id].fn))) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  const T = trackOf(w);
  const ids = sorted(w);
  botHand(w, T);
  for (const id of ids) drive(w, T, id, w.p[id]);
  if (w.ph !== COUNT && w.ph !== END) wakes(w, ids);
  else for (const id of ids) { const d = w.p[id]; d.dr = -1; d.ch = 0; d.bo = 0; }
  bumps(w, ids);
}

// A race handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.tr, 0, LAID.length - 1) || !int(raw.fin, 0, 99999)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.k, 0, MAX_P - 1) || seats.has(d.k)) return null;
    if (!num(d.x, -1, FW + 1) || !num(d.y, -1, FH + 1) || !num(d.vx, -5, 5) || !num(d.vy, -5, 5)) return null;
    if (!num(d.hx, -1.001, 1.001) || !num(d.hy, -1.001, 1.001) || Math.abs(d.hx * d.hx + d.hy * d.hy - 1) > 1e-6) return null;
    if (inputOf([d.tu, d.ax, d.ay, d.fl]) === null || !int(d.ci, 0, N - 1) || !int(d.L, -3, 99 + LAPS)) return null;
    if (!num(d.ch, 0, 1) || !int(d.bo, 0, BOOST_STEPS) || !int(d.dr, -BIG, BIG) || !int(d.sp, 0, SPIN_STEPS)) return null;
    if (!int(d.gh, 0, GHOST_STEPS) || !int(d.wl, 0, 1) || !int(d.fn, 0, 99999)) return null;
    if (!int(d.sc, 0, 999999) || !int(d.wn, 0, 99999) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    seats.add(d.k);
    p[id] = car(d);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push([r[0], r[1], r[2], r[3]]);
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, tr: raw.tr, fin: raw.fin, p, res, win: raw.win };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed race steps, and kept with the step that made them
// until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a summer circuit seen from above — mown grass in two greens, a
// slate road between red and white kerbs, a pale barrier — and a bright colour
// for each seat that is its car's, its wake's and its chip's on the board.
const INK = {
  grass: '#2f6a45', stripe: '#2b6240', runoff: '#3d7a52', wall: '#dfe4ec', road: '#3b404c', roadEdge: '#454b58',
  kerbA: '#f2f2f2', kerbB: '#e2474f', tree: '#1f4d33', treeHi: '#2c6343', text: '#fff8ec', muted: '#d9e6dc',
  dim: '#a7c1b0', gold: '#ffd166', danger: '#ff5a6e', panel: 'rgba(14,28,22,0.92)', skid: 'rgba(18,18,24,',
};
const SEAT = ['#ff5d73', '#3ec1d3', '#ffd23f', '#9b7bff', '#ff9f43', '#5b8cff', '#7bd389', '#f5f5f5'];
const FONT = "600 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.grass};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');
const bg = document.createElement('canvas');
const bgx = bg.getContext('2d');
let bgKey = '';

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4d7a5e;' +
  `background:#1d3b2a;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

// The field is drawn on its side on a tall screen, so a phone held upright
// shows the whole track as large as it can. A turn of a quarter keeps left
// and right where they were: a car steered left still turns to its left.
let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, sc = 1, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1, rot = false;
let fieldBox = [0, 0, 0, 0];   // left, top, right, bottom on the screen
// NOTE_ROOM under the field keeps the practice note off the bottom of the track.
const NOTE_ROOM = 60;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  bg.width = cv.width;
  bg.height = cv.height;
  bgKey = '';
  dpx = dpr;
  TOP = VW < 420 ? 66 : 58;
  BOT = 26;
  const aw = VW - 16, ah = Math.max(60, VH - TOP - BOT - NOTE_ROOM);
  rot = ah > aw * 1.15;
  const fw = rot ? FH : FW, fh = rot ? FW : FH;
  sc = Math.max(10, Math.min(aw / fw, ah / fh));
  ox = (VW - fw * sc) / 2;
  oy = TOP + (ah - fh * sc) / 2;
  fieldBox = [ox, oy, ox + fw * sc, oy + fh * sc];
}
layout();
window.addEventListener('resize', layout);

// Field to screen, and a direction on the screen back to the field.
const P = (x, y) => (rot ? [ox + (FH - y) * sc, oy + x * sc] : [ox + x * sc, oy + y * sc]);
const backDir = (dx, dy) => (rot ? [dy, -dx] : [dx, dy]);
function fieldOn(c, sx, sy) {
  if (rot) c.setTransform(0, dpx * sc, -dpx * sc, 0, dpx * (ox + FH * sc + sx), dpx * (oy + sy));
  else c.setTransform(dpx * sc, 0, 0, dpx * sc, dpx * (ox + sx), dpx * (oy + sy));
}
function inField() { fieldOn(ctx, shakeX, shakeY); }
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

function nickOf(id) {
  if (id === BOT_ID) return 'bot';
  if (room.me && id === room.me.id) return room.me.nick;
  const p = room.players.find((x) => x.id === id);
  const nick = p ? String(p.nick) : 'p' + id;
  return nick.length > 12 ? nick.slice(0, 11) + '…' : nick;
}
const ord = (n) => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

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
function roundRect(x, y, w, h, r, c) {
  c = c || ctx;
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function disc(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}
function lighter(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Easing per frame, scaled to the frame's length so a fast screen and a slow
// one settle at the same pace.
let frameDt = 1 / 60, lastFrame = 0;
const per60 = (k) => 1 - Math.pow(1 - k, frameDt * 60);
const ease = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
const lerp = (a, b, k) => a + (b - a) * k;

// ── the circuit, drawn once a track and a size ─────────────────────────────
function trackPath(c, T) {
  c.beginPath();
  c.moveTo(T.x[0], T.y[0]);
  for (let i = 1; i < N; i++) c.lineTo(T.x[i], T.y[i]);
  c.closePath();
}

// Trees stand where no road is, the same trees for a track on every visit.
function treesOf(T, seedN) {
  let s = seedN * 7919 + 17;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let k = 0; k < 400 && out.length < 26; k++) {
    const x = rnd() * FW, y = rnd() * FH, r = 0.025 + rnd() * 0.03;
    let ok = x > r && x < FW - r && y > r && y < FH - r;
    for (let i = 0; ok && i < N; i += 2) {
      const dx = T.x[i] - x, dy = T.y[i] - y;
      if (dx * dx + dy * dy < (WALL + r + 0.02) ** 2) ok = false;
    }
    for (const o of out) if (ok && (o[0] - x) ** 2 + (o[1] - y) ** 2 < (o[2] + r) ** 2) ok = false;
    if (ok) out.push([x, y, r]);
  }
  return out;
}

function paintCircuit(tr) {
  const T = LAID[tr], c = bgx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = INK.grass;
  c.fillRect(0, 0, bg.width, bg.height);
  fieldOn(c, 0, 0);
  // Mown stripes across the whole screen, a little darker outside the field.
  c.fillStyle = INK.stripe;
  for (let x = -2; x < FW + 2; x += 0.2) c.fillRect(x, -2, 0.1, FH + 4);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  trackPath(c, T);
  c.strokeStyle = INK.wall;
  c.lineWidth = 2 * WALL + 0.012;
  c.stroke();
  c.strokeStyle = INK.runoff;
  c.lineWidth = 2 * WALL;
  c.stroke();
  c.strokeStyle = INK.kerbA;
  c.lineWidth = 2 * HW + 0.016;
  c.stroke();
  c.setLineDash([0.026, 0.026]);
  c.strokeStyle = INK.kerbB;
  c.stroke();
  c.setLineDash([]);
  c.strokeStyle = INK.road;
  c.lineWidth = 2 * HW;
  c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.10)';
  c.lineWidth = 0.004;
  c.setLineDash([0.03, 0.045]);
  c.stroke();
  c.setLineDash([]);
  // The start line, chequered across the road, and the grid behind it.
  const nx = -T.ty[0], ny = T.tx[0], q = 0.0118;
  for (let r = 0; r < 2; r++) {
    for (let k = -Math.round(HW / q); k < Math.round(HW / q); k++) {
      c.fillStyle = (k + r) % 2 ? '#111' : '#f4f4f4';
      const bx = T.x[0] + nx * (k + 0.5) * q + T.tx[0] * (r - 1) * q, by = T.y[0] + ny * (k + 0.5) * q + T.ty[0] * (r - 1) * q;
      c.save();
      c.transform(T.tx[0], T.ty[0], nx, ny, bx, by);
      c.fillRect(-q / 2, -q / 2, q, q);
      c.restore();
    }
  }
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = 0.003;
  for (let s = 0; s < MAX_P; s++) {
    const g = gridSpot(T, s);
    c.save();
    c.transform(g.hx, g.hy, -g.hy, g.hx, g.x, g.y);
    c.beginPath();
    c.moveTo(-0.03, -0.016); c.lineTo(0.03, -0.016); c.lineTo(0.03, 0.016); c.lineTo(-0.03, 0.016);
    c.stroke();
    c.restore();
  }
  for (const [x, y, r] of treesOf(T, tr + 1)) {
    c.fillStyle = 'rgba(0,0,0,0.18)';
    c.beginPath(); c.arc(x + 0.008, y + 0.01, r, 0, Math.PI * 2); c.fill();
    c.fillStyle = INK.tree;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    c.fillStyle = INK.treeHi;
    c.beginPath(); c.arc(x - r * 0.25, y - r * 0.25, r * 0.55, 0, Math.PI * 2); c.fill();
  }
}

function drawCircuit(tr) {
  const key = tr + ':' + VW + 'x' + VH + ':' + dpx;
  if (key !== bgKey) { paintCircuit(tr); bgKey = key; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bg, Math.round(shakeX * dpx), Math.round(shakeY * dpx));
}

// ── sound ──────────────────────────────────────────────────────────────────
// Made in the page from a few oscillators and a little noise. It starts on the
// first key or touch, because a browser keeps a page silent until then.
let actx = null, muted = false, noise = null, engine = null;
const lastSound = new Map();
function wake() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { actx = null; }
  }
  if (actx && actx.state === 'suspended') actx.resume();
  if (actx && !engine) {
    // Your engine: one buzz through a soft filter, its pitch your speed.
    const o = actx.createOscillator(), f = actx.createBiquadFilter(), g = actx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = 50;
    f.type = 'lowpass';
    f.frequency.value = 500;
    g.gain.value = 0;
    o.connect(f); f.connect(g); g.connect(actx.destination);
    o.start();
    engine = { o, f, g };
  }
}
let humAt = 0;
function hum(speed, boost, on) {
  if (!engine || !actx) return;
  const now = performance.now();
  if (now - humAt < 60) return;
  humAt = now;
  const t = actx.currentTime;
  const v = on && !muted ? 0.028 + speed * 0.02 : 0;
  engine.g.gain.setTargetAtTime(v, t, 0.08);
  engine.o.frequency.setTargetAtTime(48 + speed * 150 + (boost ? 45 : 0), t, 0.06);
  engine.f.frequency.setTargetAtTime(380 + speed * 900 + (boost ? 600 : 0), t, 0.08);
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
  sling(mine) {
    if (!ready('sling', 120)) return;
    tone(220, 0.45, 'sawtooth', mine ? 0.06 : 0.025, 3.2);
    puff(0.5, mine ? 0.16 : 0.06, 1800, 0, 0.7);
  },
  charged() { if (ready('charged', 300)) { tone(880, 0.08, 'triangle', 0.08); tone(1320, 0.12, 'triangle', 0.07, 0, 0.07); } },
  bump(mine) { if (ready('bump', 90)) { tone(140, 0.12, 'square', mine ? 0.08 : 0.04, 0.5); puff(0.08, mine ? 0.12 : 0.05, 900, 0, 1); } },
  ram(mine) {
    if (!ready('ram', 150)) return;
    puff(0.25, mine ? 0.3 : 0.14, 600, 0, 0.8);
    tone(90, 0.35, 'sawtooth', mine ? 0.1 : 0.05, 0.4);
    tone(1200, 0.4, 'triangle', mine ? 0.05 : 0.02, 0.3, 0.05);
  },
  scrape(mine) { if (ready('scrape', 160)) puff(0.18, mine ? 0.12 : 0.04, 3200, 0, 2.5); },
  lap() { if (ready('lap', 200)) { tone(660, 0.1, 'triangle', 0.1); tone(990, 0.18, 'triangle', 0.09, 0, 0.08); } },
  last() {
    if (!ready('last', 400)) return;
    [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.22, 'triangle', 0.08, 0, i * 0.07));
  },
  beep() { if (ready('beep', 200)) tone(440, 0.16, 'square', 0.07); },
  go() { if (ready('go', 300)) { tone(880, 0.35, 'square', 0.08); tone(1760, 0.3, 'sine', 0.05, 1.0, 0.05); } },
  finish(first) {
    if (!ready('finish', 500)) return;
    if (first) [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.24, 'triangle', 0.1, 0, i * 0.08));
    else [523, 659, 784].forEach((f, i) => tone(f, 0.22, 'triangle', 0.08, 0, i * 0.08));
  },
  end(won) {
    if (!ready('end', 500)) return;
    if (won) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, 'triangle', 0.1, 0, i * 0.09));
    else [392, 330, 262].forEach((f, i) => tone(f, 0.26, 'triangle', 0.07, 0, i * 0.1));
  },
};
function setMuted(m) {
  muted = m;
  muteBtn.textContent = muted ? '×' : '♪';
  muteBtn.style.opacity = muted ? '0.6' : '1';
}
muteBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
muteBtn.addEventListener('click', (e) => { e.stopPropagation(); wake(); setMuted(!muted); });

// ── bits: particles, pops, rings, shake, skid marks ────────────────────────
// Stepped on a clock of their own at a fixed rate, never once per frame, so a
// fast screen and a slow one see the same spray.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, fall } in field units
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r }
const skids = [];     // [x1, y1, x2, y2, born]
let shakeX = 0, shakeY = 0, shake = 0, flash = 0;
const BIT_HZ = 60;
const SKID_MS = 6000;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, drag) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 16 + Math.random() * 22, size, colour, drag: drag || 0.9 });
  }
  if (bits.length > 600) bits.splice(0, bits.length - 600);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 64, px: px || 16, lift: lift || 22 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 26, r }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= b.drag; b.vy *= b.drag;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    for (const look of looks.values()) look.squash *= 0.86;
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.9;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, seen, rear: [x, y] | null, dustAt }
let drawFailed = false;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, seen: 0, rear: null, dustAt: 0 }));
  l.seen = performance.now();
  return l;
}
const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].k] : '#dddddd');

function play(e, t) {
  const me = myId();
  const mine = e.a === me;
  if (e.kind === 'sling') {
    const c = colourOf(t, e.a);
    ring(e.x, e.y, c, 0.06 + 0.05 * e.b);
    spray(e.x, e.y, 14, c, 0.5, 0.006, 0.88);
    spray(e.x, e.y, 6, '#ffffff', 0.4, 0.005, 0.88);
    if (mine) { pop(e.x, e.y, 'slingshot!', INK.gold, 18, 30); shake = Math.max(shake, 3); }
    sound.sling(mine);
  } else if (e.kind === 'ram') {
    spray(e.x, e.y, 26, '#fff3b0', 0.8, 0.006, 0.86);
    spray(e.x, e.y, 12, colourOf(t, e.a), 0.6, 0.008, 0.86);
    ring(e.x, e.y, '#ffffff', 0.08);
    lookOf(e.a).squash = 1;
    lookOf(e.b).squash = 0.6;
    if (mine) { shake = Math.max(shake, 10); flash = 1; pop(e.x, e.y, 'spun out!', INK.danger, 20, 30); }
    else if (e.b === me) { shake = Math.max(shake, 5); pop(e.x, e.y, 'spun ' + nickOf(e.a) + '!', INK.gold, 17, 30); }
    sound.ram(mine || e.b === me);
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 6 + Math.round(e.c * 20), '#ffe9a8', 0.4, 0.005, 0.86);
    lookOf(e.a).squash = Math.min(1, e.c * 3);
    lookOf(e.b).squash = Math.min(1, e.c * 3);
    const near = e.a === me || e.b === me;
    if (near) shake = Math.max(shake, 2 + e.c * 12);
    sound.bump(near);
  } else if (e.kind === 'scrape') {
    spray(e.x, e.y, 8, '#ffe28a', 0.5, 0.005, 0.85);
    if (mine) shake = Math.max(shake, 3);
    sound.scrape(mine);
  } else if (e.kind === 'lap') {
    if (mine) {
      const last = t.ph === PLAY && e.b === LAPS;
      pop(e.x, e.y, last ? 'final lap!' : t.ph === PLAY ? 'lap ' + e.b + '/' + LAPS : 'lap ' + e.b, last ? INK.gold : INK.text, last ? 20 : 15, 26);
      if (last) sound.last(); else sound.lap();
    }
  } else if (e.kind === 'finish') {
    const c = colourOf(t, e.a);
    for (let i = 0; i < 4; i++) spray(e.x, e.y, 10, SEAT[(i * 3 + e.b) % SEAT.length], 0.7, 0.008, 0.9);
    ring(e.x, e.y, c, 0.1);
    pop(e.x, e.y, mine ? ord(e.b) + '!' : ord(e.b) + ' ' + nickOf(e.a), mine ? INK.gold : c, mine ? 24 : 14, 34);
    if (mine) sound.finish(e.b === 1); else if (e.b === 1) sound.lap();
  } else if (e.kind === 'spawn') {
    ring(e.x, e.y, colourOf(t, e.a), 0.05);
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(e.a === me);
  } else if (e.kind === 'round') {
    skids.length = 0;
    for (const l of looks.values()) l.rear = null;
  }
}

// A car, nose along its heading: wheels, a body in its seat's colour, a
// cockpit with a helmet, wings front and back, and a flame on a slingshot.
function drawCar(x, y, hx, hy, colour, me, ghost, boost, squash, now) {
  inField();
  ctx.save();
  ctx.transform(hx, hy, -hy, hx, x, y);
  const s = 1 + squash * 0.18, w = 1 - squash * 0.12;
  ctx.scale(s, w);
  ctx.globalAlpha = ghost ? 0.45 : 1;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  roundRect(-0.021, -0.011, 0.046, 0.026, 0.008);
  ctx.fill();
  if (boost) {
    const f = 0.03 + 0.012 * Math.sin(now / 30);
    const g = ctx.createLinearGradient(-0.024, 0, -0.024 - f, 0);
    g.addColorStop(0, 'rgba(255,240,160,0.95)');
    g.addColorStop(0.5, 'rgba(255,150,60,0.7)');
    g.addColorStop(1, 'rgba(255,90,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-0.022, -0.007);
    ctx.lineTo(-0.024 - f, 0);
    ctx.lineTo(-0.022, 0.007);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = '#16181d';
  for (const u of [-0.014, 0.013]) for (const v of [-0.0135, 0.0075]) ctx.fillRect(u - 0.006, v, 0.012, 0.006);
  ctx.fillStyle = colour;
  roundRect(-0.022, -0.009, 0.042, 0.018, 0.007);
  ctx.fill();
  if (me) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.0035; ctx.stroke(); }
  ctx.fillStyle = lighter(colour, 0.35);
  ctx.fillRect(0.018, -0.013, 0.006, 0.026);
  ctx.fillRect(-0.025, -0.012, 0.005, 0.024);
  ctx.fillStyle = 'rgba(15,20,30,0.85)';
  ctx.beginPath();
  ctx.ellipse(-0.002, 0, 0.008, 0.0055, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-0.003, 0, 0.0035, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
}

// A wake: two ribbons of air running from the car in front back past the one
// sitting in it, moving as the air does.
function drawWake(ax, ay, bx, by, colour, now) {
  inField();
  const dx = ax - bx, dy = ay - by, l = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / l, ny = dx / l;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 0.003;
  ctx.setLineDash([0.012, 0.012]);
  ctx.lineDashOffset = -(now / 1000) * 0.12;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(bx + nx * side * 0.008, by + ny * side * 0.008);
    ctx.lineTo(ax + nx * side * 0.016 - (dx / l) * 0.03, ay + ny * side * 0.016 - (dy / l) * 0.03);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

// A slingshot's charge, a ring round the car filling as it sits in a wake.
function drawCharge(x, y, ch, colour, now) {
  if (ch <= 0.01) return;
  inField();
  const ready = ch >= SLING_MIN;
  ctx.strokeStyle = ready ? (ch >= 0.99 ? (Math.floor(now / 120) % 2 ? INK.gold : '#ffffff') : INK.gold) : 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 0.004;
  ctx.beginPath();
  ctx.arc(x, y, 0.032, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ch);
  ctx.stroke();
}

function drawSkids(now) {
  inField();
  ctx.lineWidth = 0.005;
  ctx.lineCap = 'round';
  while (skids.length && now - skids[0][4] >= SKID_MS) skids.shift();
  // In a few shades rather than one stroke a mark: hundreds of marks are drawn
  // every frame.
  const SHADES = 6;
  for (let b = 1; b <= SHADES; b++) {
    ctx.beginPath();
    for (const s of skids) {
      const k = 1 - (now - s[4]) / SKID_MS;
      if (Math.ceil(k * SHADES) !== b) continue;
      ctx.moveTo(s[0], s[1]);
      ctx.lineTo(s[2], s[3]);
    }
    ctx.strokeStyle = INK.skid + ((0.35 * b) / SHADES).toFixed(3) + ')';
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function drawBits() {
  inField();
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 0.006 * (1 - k) + 0.0015;
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
    const [X0, Y0] = P(p.x, p.y);
    const X = X0 + shakeX, Y = Y0 + shakeY - ease(Math.min(1, k * 1.4)) * p.lift;
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10,20,15,0.65)';
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

function drawHud(t, now, order) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  const d = t.p[me];
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'race ' + t.rd + ' · ' + LAID[t.tr].name + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'race ' + t.rd;
    if (d && d.fn) status += ' · you came ' + ord(d.fn);
    else if (d) {
      const lap = clamp(d.L, 1, LAPS);
      status += lap === LAPS ? ' · final lap' : ' · lap ' + lap + '/' + LAPS;
      status += ' · ' + ord(order.indexOf(me) + 1);
      if (lap === LAPS) colour = INK.gold;
    }
    if (t.fin > 0) {
      status += ' · ' + clock(t.pt) + ' left';
      colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
    }
  } else status = 'race ' + t.rd + ' · over';
  text('slipstream', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('slipstream').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 82, 'left');
  text(wireNote(), VW - 50, 33, 9, INK.dim, 'right');

  // The board: one chip a driver, in race order, in its seat's colour, with
  // its points this cup and the races it has won.
  if (order.length) {
    const y = narrow ? 54 : 48;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (order.length - 1)) / order.length);
    let x = (VW - (cw * order.length + gap * (order.length - 1))) / 2;
    order.forEach((id, i) => {
      const c = t.p[id], mine = id === me;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.18)' : 'rgba(5,20,12,0.4)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[c.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[c.k];
      disc(x + 11, y - 2, 6);
      ctx.fill();
      text(String(i + 1), x + 11, y + 2, 10, '#10201a', 'center');
      const score = String(c.sc) + (c.wn ? ' ★' + c.wn : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, INK.text, 'right');
      if (cw - 34 - sw > 14) fitText(mine ? 'you' : nickOf(id), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    });
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to drive · sit behind a car to charge, pull out to slingshot'
    : '↑ gas · ↓ brake · ← → steer, or hold the mouse · sit behind a car to charge, pull out to slingshot · M mutes';
  fitText(how, VW / 2, VH - 9, 12, INK.muted, VW - 20);
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
// Practice ends a moment after a second driver arrives: who it was, as this
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
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const me = myId();
  const cx = VW / 2, cy = (fieldBox[1] + fieldBox[3]) / 2;
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'sit right behind the bot to charge, then pull out to slingshot past';
    practiceNote(now, VW, head, tip, [[TOP, fieldBox[1] - 4], [fieldBox[3] + 4, VH - BOT]], VH - BOT - 4);
  } else if (t.ph === COUNT) {
    // Five lights come on as the count runs down, and go out together.
    const k = 1 - t.pt / COUNT_STEPS, lit = Math.min(5, Math.floor(k * 5.5));
    const r = Math.max(8, Math.min(16, VW * 0.025)), w = r * 2.6 * 5 + r;
    panel(cx, cy - r * 0.5, w, r * 3);
    for (let i = 0; i < 5; i++) {
      const x = cx - (r * 2.6 * 4) / 2 + i * r * 2.6;
      ctx.fillStyle = i < lit ? '#ff3b3b' : '#3a2222';
      disc(x, cy - r * 0.5, r);
      ctx.fill();
      if (i < lit) {
        ctx.fillStyle = 'rgba(255,120,120,0.35)';
        disc(x, cy - r * 0.5, r * 1.5);
        ctx.fill();
      }
    }
    fitText(LAID[t.tr].name + ' · ' + LAPS + ' laps', cx, cy + r * 2.4, 16, INK.text, VW - 40);
    fitText('sit in a wake to charge · pull out to slingshot · ram while you fly to spin them', cx, cy + r * 2.4 + 20, 13, INK.muted, VW - 40);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('go!', cx, cy + big * 0.5, big * (2 + k), '#7dff9a', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.fin > 0) {
    const first = playersIn(t).find((id) => t.p[id].fn === 1);
    if (first !== undefined) {
      const s = (first === me ? 'you won' : nickOf(first) + ' won') + ' · the rest have ' + clock(t.pt);
      ctx.font = font(13);
      const w = Math.min(VW - 24, ctx.measureText(s).width + 28);
      panel(cx, fieldBox[1] + 18, w, 26);
      fitText(s, cx, fieldBox[1] + 23, 13, INK.gold, w - 16);
    }
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 100 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 6, Math.min(VH - BOT - h / 2 - 6, cy)) + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.win !== -1) { head = t.win === me ? 'you take the flag!' : nickOf(t.win) + ' takes the flag'; hc = colourOf(t, t.win); }
    else head = 'nobody made it home';
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 34, 22, hc, w - 24);
    rows.forEach(([id, at, pts, won], i) => {
      const y = y0 + 64 + i * 22;
      text(at ? ord(at) : '—', cx - w / 2 + 30, y, 13, at === 1 ? INK.gold : INK.dim, 'center');
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 54, y - 4, 5);
      ctx.fill();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 66, y, 14, id === me ? INK.text : INK.muted, w - 160, 'left');
      if (won) text('★' + won, cx + w / 2 - 56, y, 12, INK.gold, 'right');
      text('+' + pts, cx + w / 2 - 18, y, 15, INK.text, 'right');
    });
    fitText('next race in ' + Math.ceil(t.pt / HZ) + ' · on a new track', cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// A car between two tables: one just put down on the grid is drawn where the
// newer table has it rather than driven there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || (p.x - q.x) ** 2 + (p.y - q.y) ** 2 > 0.1 * 0.1) return [p.x, p.y, p.hx, p.hy];
  let hx = lerp(q.hx, p.hx, b.k), hy = lerp(q.hy, p.hy, b.k);
  const l = Math.hypot(hx, hy) || 1;
  hx /= l; hy /= l;
  return [lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k), hx, hy];
}

// Your own car is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh, a car put on the grid — is taken at once.
let shown = null;
const SNAP = 0.12;
function settle(pos) {
  if (!shown || (pos[0] - shown[0]) ** 2 + (pos[1] - shown[1]) ** 2 > SNAP * SNAP) return (shown = pos.slice());
  const k = per60(0.4);
  for (let i = 0; i < 4; i++) shown[i] += (pos[i] - shown[i]) * k;
  const l = Math.hypot(shown[2], shown[3]) || 1;
  shown[2] /= l; shown[3] /= l;
  return shown;
}

// Rubber where a car slides or brakes hard, and dust where it runs on grass,
// from the cars as drawn: none of it is in the race.
function marks(id, d, pos, now, T) {
  const look = lookOf(id);
  const rx = pos[0] - pos[2] * 0.015, ry = pos[1] - pos[3] * 0.015;
  const f = d.vx * d.hx + d.vy * d.hy, side = Math.abs(d.vx * -d.hy + d.vy * d.hx);
  const off = Math.abs(locate(T, d.ci, pos[0], pos[1]).off);
  if (look.rear && (side > 0.09 || ((d.fl & 2) && f > 0.2) || d.sp > 0) && off < WALL) {
    const nx = -pos[3] * 0.009, ny = pos[2] * 0.009;
    skids.push([look.rear[0] + nx, look.rear[1] + ny, rx + nx, ry + ny, now]);
    skids.push([look.rear[0] - nx, look.rear[1] - ny, rx - nx, ry - ny, now]);
    if (skids.length > 900) skids.splice(0, skids.length - 900);
  }
  if (off > HW && f > 0.12 && now - look.dustAt > 60) {
    look.dustAt = now;
    spray(rx, ry, 2, '#9c8a5a', 0.12, 0.007, 0.9);
  }
  look.rear = [rx, ry];
}

let myPos = null;      // [x, y, hx, hy]: where your car is drawn
let wasCharged = false;
function draw(now) {
  const b = agreedAt(now);
  if (!b) {
    flat();
    ctx.fillStyle = INK.grass;
    ctx.fillRect(0, 0, VW, VH);
    myPos = shown = null;
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the race…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    hum(0, false, false);
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a race this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  drawCircuit(t.tr);
  drawSkids(now);
  const me = myId();
  const ids = playersIn(t).sort((a, c) => t.p[a].k - t.p[c].k);

  // Where every car is drawn: yours from the guess, the rest from the agreed race.
  const at = new Map();
  for (const id of ids) {
    if (id === me) continue;
    const pos = between(b, id);
    if (pos) at.set(id, pos);
  }
  const m = mineAt(now);
  // A guess already on the next track while the drawing is still on this one
  // draws your car from the agreed race for that moment.
  const guessed = !!(m && m.to.p[me] && m.to.tr === t.tr);
  const minePos = guessed ? between(m, me) : between(b, me);
  if (minePos) at.set(me, settle(minePos));
  const dOf = (id) => (id === me && guessed ? m.to.p[me] : t.p[id]);
  myPos = at.get(me) || null;
  if (!myPos) shown = null;

  for (const id of ids) if (at.has(id)) marks(id, dOf(id), at.get(id), now, LAID[t.tr]);
  // Wakes under the cars, then the cars, then the charge rings over them.
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos || d.dr === -1 || !at.has(d.dr)) continue;
    const a = at.get(d.dr);
    drawWake(a[0], a[1], pos[0], pos[1], SEAT[d.k], now);
  }
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos) continue;
    drawCar(pos[0], pos[1], pos[2], pos[3], SEAT[d.k], id === me, d.gh > 0 || d.fn > 0, d.bo > 0, lookOf(id).squash, now);
  }
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (pos) drawCharge(pos[0], pos[1], d.ch, SEAT[d.k], now);
  }
  // Names over the cars, so a ram has somebody to be aimed at.
  flat();
  for (const id of ids) {
    const pos = at.get(id);
    if (!pos) continue;
    const [X, Y] = P(pos[0], pos[1]);
    fitText(id === me ? 'you' : nickOf(id), X + shakeX, Y + shakeY - sc * 0.036, 10, id === me ? '#ffffff' : 'rgba(255,255,255,0.75)', 70);
  }
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawBits();

  const mine = dOf(me);
  const charged = !!(mine && mine.ch >= 0.99);
  if (charged && !wasCharged) sound.charged();
  wasCharged = charged;
  if (mine) hum(Math.min(1.5, Math.hypot(mine.vx, mine.vy) / VMAX), mine.bo > 0, true);
  else hum(0, false, false);
  // Spun out: the edges of the screen flush red.
  if (flash > 0.05 || (mine && mine.sp > 0)) {
    const k = Math.max(flash, mine && mine.sp > 0 ? 0.6 : 0);
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    g.addColorStop(0, 'rgba(255,90,110,0)');
    g.addColorStop(1, `rgba(255,90,110,${0.3 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(t, now, standings(t));
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: [turn, aim x, aim y, pedals]. The keys turn and press
// the pedals; a thumb or the mouse aims, and the car turns toward the aim and
// drives. A change of pedals goes out at once; a change of aim no oftener than
// TURN_EVERY, because a thumb moving in a circle changes it on every move the
// screen reports, and the clock's ticks share the same seat's ceiling on
// messages.
const TURN_EVERY = 110;
let wanted = [0, 0, 0, 0];
let lastSaid = [0, 0, 0, 0];
let saidAt = -1e9;

function aim(fx_, fy_) {
  const [dx, dy] = backDir(fx_, fy_);
  const far = Math.hypot(dx, dy);
  wanted = far < 0.01 ? [0, 0, 0, 0] : [0, Math.round((dx / far) * 1000), Math.round((dy / far) * 1000), 1];
  sayHand(performance.now());
}
function sayHand(now) {
  const d = wanted, s = lastSaid;
  const same = d[0] === s[0] && d[3] === s[3];
  if (same && Math.hypot(d[1] - s[1], d[2] - s[2]) < 60) return;
  const aiming = (v) => v[1] !== 0 || v[2] !== 0;
  if (same && aiming(d) && aiming(s) && now - saidAt < TURN_EVERY) return;
  lastSaid = d;
  saidAt = now;
  setHand(d.slice());
}

// Keys are read by where they sit, not what they type, so every layout drives.
const RUN_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
const keys = new Set();
function fromKeys() {
  let tu = 0, fl = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) tu -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) tu += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) fl |= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) fl |= 2;
  wanted = [tu, 0, 0, fl];
  sayHand(performance.now());
}
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (!RUN_KEYS.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  keys.add(e.code);
  if (!stick && !mouse) fromKeys();
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (!stick && !mouse) fromKeys();
});
addEventListener('blur', () => { keys.clear(); dropStick(); mouse = null; fromKeys(); });

// A thumb: a stick from wherever it lands — a drag rather than a press,
// because iOS keeps a long press inside a frame for itself — and the car
// drives the way it points. A mouse: hold the button and the car drives
// toward the pointer.
const DEAD = 10;
const REACHOUT = 46;
let stick = null;
let mouse = null;

function dropStick() {
  stick = null;
  paintStick(0, 0);
  if (!mouse) fromKeys();
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    if (stick) return;
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
    paintStick(0, 0);
    return;
  }
  coarse = false;
  if (e.button !== 0 && e.button !== 2) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mouse = { id: e.pointerId, x: e.clientX, y: e.clientY };
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    paintStick(dx, dy);
    if (Math.hypot(dx, dy) < DEAD) { wanted = [0, 0, 0, 0]; sayHand(performance.now()); }
    else aim(dx, dy);
  } else if (mouse && e.pointerId === mouse.id) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
});
function lift(e) {
  if (stick && e.pointerId === stick.id) dropStick();
  else if (mouse && e.pointerId === mouse.id) {
    mouse = null;
    fromKeys();
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
  if (!stick) { stickRing.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(dx, dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
  stickRing.style.display = knob.style.display = 'block';
  stickRing.style.left = stick.ox + 'px';
  stickRing.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + dx * k + 'px';
  knob.style.top = stick.oy + dy * k + 'px';
}

// The mouse drives toward the pointer while held, and rolls free once the
// pointer sits on the car, rather than circling round it.
function steerToMouse() {
  if (!mouse) return;
  if (!myPos) { wanted = [0, 0, 0, 0]; sayHand(performance.now()); return; }
  const r = cv.getBoundingClientRect();
  const [X, Y] = P(myPos[0], myPos[1]);
  const dx = mouse.x - r.left - X, dy = mouse.y - r.top - Y;
  if (Math.hypot(dx, dy) < 12) { wanted = [0, 0, 0, 0]; sayHand(performance.now()); }
  else aim(dx, dy);
}

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  steerToMouse();
  sayHand(now);
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Holding still is a hand too: it is how
// a driver arrives and is put on the grid.
function start() {
  setHand([0, 0, 0, 0]);
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
