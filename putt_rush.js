/**
 * @disk     putt_rush
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Crazy golf where nobody waits a turn. Everyone putts on the same hole at once, whenever their ball stops: first in the cup scores most, and your ball is everyone else's obstacle. Knock rivals into the pond. Five holes a cup.
 * @tags     game, party, realtime, golf, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/putt_rush.png
 */
// putt_rush.js — crazy golf for a whole room at once, where the room's order is
// the referee.
//
// Every copy holds the whole hole — every ball, the windmill, the points — and
// moves it only on what comes back round the room, so every copy applies the
// same hands in the same order and holds the same green. Nobody sends where
// their ball is, a sink or a score: a hand is an aim, a strength and a count of
// putts asked for, and a putt is struck only when the green says that ball is
// at rest, at a strength no harder than any putter can strike. Where it rolls,
// whom it knocks, what falls in the water and who is first in the cup is the
// same arithmetic on the same numbers on every machine.
//
// While a golfer is alone, a bot plays the hole with them. It is a ball on the
// green like any other, and its hand is a function of the green alone, so it
// plays the same on every copy and says nothing over the wire. When a second
// golfer arrives, practice runs on for three seconds under a note that says
// so, and the bot leaves before the first hole is laid out: it never plays in
// a cup.
//
// Your own ball does not wait for the trip: it is drawn from the agreed green
// played forward by the trip, with your putt already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.floor`, `Math.abs`, `Math.min`, `Math.max` and
// `Math.imul` are fixed by the language to the last bit; `Math.sin` and
// `Math.cos` are not, so the windmill turns by a series written out here.

// The sine and cosine of `a`, from their series after bringing `a` within half
// a turn of zero, where twenty terms are far finer than a windmill's blade.
const TAU = 6.283185307179586;
function sincos(a) {
  a -= Math.floor(a / TAU + 0.5) * TAU;
  const a2 = a * a;
  let s = 0, c = 0, ts = a, tc = 1;
  for (let i = 0; i < 10; i++) {
    s += ts;
    c += tc;
    ts *= -a2 / ((2 * i + 2) * (2 * i + 3));
    tc *= -a2 / ((2 * i + 1) * (2 * i + 2));
  }
  return [s, c];
}

// A unit vector turned by a small angle `a`, kept a unit vector.
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
const HZ = 30;                 // steps of the green a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own ball a trip ahead, with your putt in it
const DT = 1 / HZ;
const SUB = 4;                 // pieces a step is cut into, so no ball rolls through a rail
const SDT = DT / SUB;

const FW = 1.6, FH = 1.0;      // the field: every hole fits this box
const BR = 0.017;              // a ball's radius
const CUP_R = 0.03;            // the cup's
const VMAX = 1.6;              // the hardest putt, in field widths a second
const MIN_PW = 40;             // a putt softer than this, in thousandths, is no putt
const DECEL = 0.55;            // what the green takes off a rolling ball, a second
const SAND_DECEL = 3.2;        // and a bunker
const SINK_V = 0.8;            // a ball over the cup slower than this drops
const LIP_PULL = 2.4;          // how hard the cup's edge pulls a ball passing over it
const WALL_T = 0.007;          // half a rail's thickness
const WALL_E = 0.72;           // what a rail gives back
const BUMP_KICK = 0.3;         // what a bumper adds to a ball it throws back
const MILL_T = 0.008;          // half a windmill blade's thickness
const MILL_HUB = 0.024;
const BALL_E = 0.9;            // what two balls give back to each other
const SHOT_GAP = 10;           // steps after a putt before the next may be struck
const STUN_STEPS = Math.round(1.2 * HZ);   // a ball fished out of the water waits this long
const GHOST_STEPS = Math.round(1.0 * HZ);  // a ball just put down passes through the others
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const SHOT_MAX = 1e9;
const MAX_P = 8;
const HOLES = 5;
const PTS = [5, 3, 2, 1, 1, 1, 1, 1];
const ACE = 2;                 // a hole in one's bonus
const FORWARD = 0.1;           // how much nearer the cup the last golfer tees off

const WAIT = 0, COUNT = 1, PLAY = 2, HOLE_END = 3, CUP_END = 4;
const COUNT_STEPS = Math.round(2.5 * HZ);
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second golfer arrives
const PLAY_STEPS = 60 * HZ;    // no hole runs longer than this
const CLOSE_STEPS = 12 * HZ;   // the rest have this long once somebody is in the cup
const HOLE_END_STEPS = 4 * HZ;
const CUP_END_STEPS = 9 * HZ;
const RESPAWN_STEPS = Math.round(1.5 * HZ);  // in practice a ball in the cup comes back to the tee
const NEXT_STEPS = 2 * HZ;     // and a golfer's sink brings the next practice hole this soon

// ── the holes ──────────────────────────────────────────────────────────────
// Each is drawn once in the field's box and played in four ways: as it is,
// turned left for right, top for bottom, or both. A table only names which.
//   border: the outer rail, a loop of corners; walls: rails inside it;
//   bumpers [x, y, r]; water, sand: [x, y, w, h]; slopes [x, y, w, h, gx, gy]:
//   a pull across a patch; hills [x, y, r, g]: a pull away from a point;
//   mill [x, y, arm, turn a second]; tee and td: where the golfers stand and
//   which way the hole runs from there; via: where a golfer who cannot see the
//   cup aims first, nearest the cup last.
const RECT = [[0.06, 0.08], [1.54, 0.08], [1.54, 0.92], [0.06, 0.92]];
const HOLE_DEFS = [
  {
    name: 'dogleg', border: [[0.06, 0.08], [1.54, 0.08], [1.54, 0.92], [0.98, 0.92], [0.98, 0.46], [0.06, 0.46]],
    walls: [], bumpers: [[1.43, 0.19, 0.04]], water: [], sand: [[1.04, 0.56, 0.16, 0.1]],
    slopes: [[0.46, 0.08, 0.36, 0.38, 0, 0.42]], hills: [], mill: null,
    tee: [0.2, 0.27], td: [1, 0], cup: [1.27, 0.79], via: [[1.25, 0.28]],
  },
  {
    name: 'windmill', border: RECT,
    walls: [[0.8, 0.08, 0.8, 0.385], [0.8, 0.615, 0.8, 0.92]], bumpers: [[0.48, 0.25, 0.035], [0.48, 0.75, 0.035]],
    water: [], sand: [[1.12, 0.14, 0.2, 0.13], [1.12, 0.73, 0.2, 0.13]], slopes: [], hills: [],
    mill: [0.8, 0.5, 0.104, 1.7],
    tee: [0.2, 0.5], td: [1, 0], cup: [1.37, 0.5], via: [[0.8, 0.5]],
  },
  {
    name: 'the pond', border: RECT,
    walls: [], bumpers: [[1.3, 0.18, 0.03], [1.3, 0.82, 0.03]], water: [[0.55, 0.3, 0.5, 0.4]],
    sand: [], slopes: [], hills: [], mill: null,
    tee: [0.18, 0.5], td: [1, 0], cup: [1.41, 0.5], via: [[0.6, 0.2], [1.1, 0.2]],
  },
  {
    name: 'pinball', border: RECT,
    walls: [], bumpers: [[0.55, 0.56, 0.045], [0.8, 0.3, 0.04], [0.82, 0.77, 0.04], [1.06, 0.52, 0.045], [1.26, 0.34, 0.035], [1.2, 0.8, 0.035]],
    water: [], sand: [[1.3, 0.58, 0.18, 0.13]], slopes: [], hills: [], mill: null,
    tee: [0.17, 0.78], td: [0.8, -0.6], cup: [1.42, 0.19], via: [[0.67, 0.42], [1.1, 0.17]],
  },
  {
    name: 'the hill', border: RECT,
    walls: [[0.42, 0.08, 0.42, 0.26], [0.42, 0.74, 0.42, 0.92]], bumpers: [[0.66, 0.3, 0.04], [0.66, 0.7, 0.04]],
    water: [[1.42, 0.08, 0.12, 0.16], [1.42, 0.76, 0.12, 0.16]], sand: [[0.82, 0.44, 0.08, 0.12]], slopes: [],
    hills: [[1.16, 0.5, 0.22, 0.42]], mill: null,
    tee: [0.18, 0.5], td: [1, 0], cup: [1.16, 0.5], via: [],
  },
  {
    name: 'zigzag', border: RECT,
    walls: [[0.56, 0.08, 0.56, 0.64], [1.04, 0.92, 1.04, 0.36]], bumpers: [[0.8, 0.74, 0.04]],
    water: [], sand: [[1.2, 0.7, 0.2, 0.14]], slopes: [[0.6, 0.1, 0.42, 0.22, 0, 0.4]], hills: [], mill: null,
    tee: [0.2, 0.22], td: [0, 1], cup: [1.36, 0.24], via: [[0.56, 0.8], [1.04, 0.2]],
  },
  {
    name: 'the river', border: RECT,
    walls: [[0.7, 0.41, 0.86, 0.41], [0.7, 0.59, 0.86, 0.59]], bumpers: [[0.42, 0.3, 0.035]],
    water: [[0.7, 0.08, 0.16, 0.33], [0.7, 0.59, 0.16, 0.33]], sand: [[0.2, 0.14, 0.16, 0.1]],
    slopes: [[1.0, 0.42, 0.5, 0.48, 0, 0.36]], hills: [], mill: null,
    tee: [0.18, 0.76], td: [1, 0], cup: [1.38, 0.24], via: [[0.6, 0.5], [0.97, 0.5]],
  },
  {
    name: 'the fort', border: RECT,
    walls: [[1.16, 0.34, 1.16, 0.66], [1.16, 0.34, 1.4, 0.34], [1.16, 0.66, 1.4, 0.66]],
    bumpers: [[0.62, 0.22, 0.04], [0.62, 0.78, 0.04]], water: [], sand: [[0.9, 0.44, 0.1, 0.12]],
    slopes: [], hills: [], mill: null,
    tee: [0.2, 0.5], td: [1, 0], cup: [1.31, 0.5], via: [[1.0, 0.2], [1.47, 0.2], [1.47, 0.5]],
  },
];

// A hole turned over: `fx` left for right, `fy` top for bottom. Laid once, at
// load, by arithmetic alone, so every copy lays it to the same bits.
function layHole(def, mx, my) {
  const X = (x) => (mx ? FW - x : x), Y = (y) => (my ? FH - y : y);
  const box = (r) => [mx ? FW - r[0] - r[2] : r[0], my ? FH - r[1] - r[3] : r[1], r[2], r[3]];
  const border = def.border.map(([x, y]) => [X(x), Y(y)]);
  const segs = [];
  for (let i = 0; i < border.length; i++) {
    const a = border[i], b = border[(i + 1) % border.length];
    segs.push([a[0], a[1], b[0], b[1]]);
  }
  for (const s of def.walls) segs.push([X(s[0]), Y(s[1]), X(s[2]), Y(s[3])]);
  const tdx = (mx ? -1 : 1) * def.td[0], tdy = (my ? -1 : 1) * def.td[1], tl = Math.sqrt(tdx * tdx + tdy * tdy);
  return {
    name: def.name, border, segs,
    bumpers: def.bumpers.map(([x, y, r]) => [X(x), Y(y), r]),
    water: def.water.map(box), sand: def.sand.map(box),
    slopes: def.slopes.map((s) => box(s).concat([(mx ? -1 : 1) * s[4], (my ? -1 : 1) * s[5]])),
    hills: def.hills.map(([x, y, r, g]) => [X(x), Y(y), r, g]),
    // A windmill turned over turns the other way, as a mirror shows it.
    mill: def.mill ? [X(def.mill[0]), Y(def.mill[1]), def.mill[2], def.mill[3] * (mx !== my ? -1 : 1)] : null,
    tee: [X(def.tee[0]), Y(def.tee[1])], td: [tdx / tl, tdy / tl],
    cup: [X(def.cup[0]), Y(def.cup[1])], via: def.via.map(([x, y]) => [X(x), Y(y)]),
  };
}
const LAID = [];
for (const def of HOLE_DEFS) for (let f = 0; f < 4; f++) LAID.push(layHole(def, f & 1, f & 2));
const holeOf = (w) => LAID[w.lay];

const inBox = (r, x, y, pad) => x >= r[0] - pad && x <= r[0] + r[2] + pad && y >= r[1] - pad && y <= r[1] + r[3] + pad;

// The point of a rail nearest to (x, y), and how far it is.
function nearOnSeg(s, x, y) {
  const sx = s[2] - s[0], sy = s[3] - s[1], ll = sx * sx + sy * sy;
  const u = ll > 0 ? clamp(((x - s[0]) * sx + (y - s[1]) * sy) / ll, 0, 1) : 0;
  const qx = s[0] + sx * u, qy = s[1] + sy * u, dx = x - qx, dy = y - qy;
  return [qx, qy, Math.sqrt(dx * dx + dy * dy)];
}

// The windmill's four blades at step `n`: [x1, y1, x2, y2] each, from the hub out.
function blades(L, n) {
  if (!L.mill) return [];
  const [cx, cy, arm, turn] = L.mill;
  const [s, c] = sincos(n * turn * DT);
  return [[c, s], [-s, c], [-c, -s], [s, -c]].map(([ux, uy]) => [cx, cy, cx + ux * arm, cy + uy * arm]);
}

// The green. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every ball is made by one function with its fields in one order.
//   rd: cups begun; ho: the hole of this cup, from 0; lay: the hole laid out;
//   used: the kinds of hole played this cup, a bit each; fin: how many are in
//   the cup this hole; nx: steps until the next practice hole, 0 for none;
//   res: the last hole's [id, place, points, strokes] rows, place 0 for
//   somebody who never got down; cup: the last cup's [id, points, aces, cups
//   won] rows; win: its winner or -1
function freshTable(seed) {
  const t = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, ho: 0, lay: 0, used: 0, fin: 0, nx: 0, p: {}, res: null, cup: null, win: -1 };
  t.lay = Math.floor(draw01(t) * LAID.length);
  return t;
}

const FIELDS = ['k', 'x', 'y', 'vx', 'vy', 'lx', 'ly', 'ax', 'ay', 'pw', 'am', 'hk', 'sk', 'st', 'ts', 'sn', 'hp',
  'sc', 'wn', 'ac', 'cd', 'gh', 'bw', 'lt', 'lp', 'hs', 'hc'];
//   k: seat, which is its colour; x, y, vx, vy: the ball; lx, ly: where it was
//   last struck from, where the water hands it back; ax, ay, pw, am, hk: the
//   hand — an aim in thousandths, a strength in thousandths, whether it is
//   lining up, and how many putts it has asked for; sk: how many of those were
//   struck or let go; st: strokes this hole; ts: strokes this cup; sn: its
//   place in the cup this hole, 0 until then; hp: points this hole; sc: points
//   this cup; wn: cups won; ac: aces this cup; cd: steps before it may be
//   struck again; gh: steps it still passes through the others; bw: the bot's
//   pause before it putts; lt: whose ball last knocked it, 0 for nobody's;
//   lp: 1 while it rolls over the cup; hs, hc: hands this step.
function ball(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const sorted = (w) => playersIn(w).sort((a, b) => a - b);
const bySeat = (w) => sorted(w).sort((a, b) => w.p[a].k - w.p[b].k);

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// The tee: two rows of four across the line the hole runs from, the row
// behind a little further back, and anybody `forward` steps nearer the cup.
function teeSpot(L, slot, forward) {
  const row = Math.floor(slot / 4), col = slot % 4;
  const lat = (col - 1.5) * 0.042, along = forward - row * 0.042;
  const nx = -L.td[1], ny = L.td[0];
  return [L.tee[0] + L.td[0] * along + nx * lat, L.tee[1] + L.td[1] * along + ny * lat];
}

function setDown(d, x, y) {
  d.x = x; d.y = y; d.lx = x; d.ly = y; d.vx = 0; d.vy = 0;
  d.sn = 0; d.cd = 0; d.lt = 0; d.lp = 0;
}

function newBall(w, id, shots) {
  const d = (w.p[id] = ball({
    k: freeSeat(w), x: 0, y: 0, vx: 0, vy: 0, lx: 0, ly: 0, ax: 0, ay: 0, pw: 0, am: 0, hk: shots, sk: shots,
    st: 0, ts: 0, sn: 0, hp: 0, sc: 0, wn: 0, ac: 0, cd: 0, gh: GHOST_STEPS, bw: 0, lt: 0, lp: 0, hs: w.n, hc: 0,
  }));
  const [x, y] = teeSpot(holeOf(w), Object.keys(w.p).length - 1, 0);
  setDown(d, x, y);
  fx(w, 'spawn', d.x, d.y, id);
  return d;
}

// A hand, at its place in the room's order: [aim x, aim y, strength, putts
// asked for, lining up]. Being heard is how a golfer arrives, and their ball
// is put down on the tee — with every putt they asked for before counted as
// let go, so a page that comes back strikes nothing it asked for while away.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = newBall(w, id, input[3]);
  }
  // A flood of hands in one step is cut off where no golfer's thumb could
  // reach, on every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.ax = input[0];
  d.ay = input[1];
  d.pw = input[2];
  d.hk = input[3];
  d.am = input[4];
}

// A hand off the wire, made safe: five integers in their ranges, or nothing.
// How hard a ball is struck is the green's business: a strength names a share
// of the hardest putt, and nothing a hand says makes one harder.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  if (!raw.every(Number.isInteger)) return null;
  const [ax, ay, pw, k, am] = raw;
  if (ax < -1000 || ax > 1000 || ay < -1000 || ay > 1000 || pw < 0 || pw > 1000) return null;
  if (k < 0 || k > SHOT_MAX || am < 0 || am > 1) return null;
  return [ax, ay, pw, k, am];
}

function leave(w, id) {
  delete w.p[id];
}

// The bot plays practice and is never in a cup.
const BOT_ID = -100;
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// Everybody on the tee of the hole laid out: in seat order, the golfers
// furthest behind on points a little nearer the cup.
function teeUp(w) {
  const L = holeOf(w), ids = bySeat(w), hs = humans(w);
  ids.forEach((id, i) => {
    const d = w.p[id];
    let ahead = 0;
    for (const o of hs) if (w.p[o].sc > d.sc) ahead += 1;
    const forward = w.ph === WAIT || hs.length < 2 ? 0 : (FORWARD * ahead) / (hs.length - 1);
    const [x, y] = teeSpot(L, i, forward);
    setDown(d, x, y);
    d.st = 0; d.hp = 0; d.gh = 0; d.bw = 0;
    // A putt asked for before the hole was laid is not struck on it.
    d.sk = d.hk;
  });
}

// The next hole: one of a kind not yet played this cup, turned a new way.
function nextLay(w) {
  const now = Math.floor(w.lay / 4), kinds = HOLE_DEFS.length;
  w.used |= 1 << now;
  let open = [];
  for (let k = 0; k < kinds; k++) if (!(w.used >> k & 1)) open.push(k);
  if (!open.length) {
    w.used = 1 << now;
    open = [];
    for (let k = 0; k < kinds; k++) if (k !== now) open.push(k);
  }
  const kind = open[Math.floor(draw01(w) * open.length)];
  w.used |= 1 << kind;
  w.lay = kind * 4 + Math.floor(draw01(w) * 4);
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.nx = 0;
  w.fin = 0;
  teeUp(w);
}

function beginCup(w) {
  w.rd += 1;
  w.ho = 0;
  w.used = 0;
  w.res = null;
  w.cup = null;
  w.win = -1;
  for (const id of playersIn(w)) { const d = w.p[id]; d.sc = 0; d.ac = 0; d.ts = 0; }
  beginHole(w);
}

function beginHole(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.fin = 0;
  w.res = null;
  nextLay(w);
  teeUp(w);
  fx(w, 'round');
}

const lastHole = (w) => w.ho === HOLES - 1;

function endHole(w) {
  const ids = sorted(w).sort((a, b) => {
    const A = w.p[a], B = w.p[b];
    if (A.sn && B.sn) return A.sn - B.sn;
    if (A.sn || B.sn) return A.sn ? -1 : 1;
    return a - b;
  });
  w.res = ids.map((id) => { const d = w.p[id]; d.sc += d.hp; return [id, d.sn, d.hp, d.st]; });
  w.ph = HOLE_END;
  w.pt = HOLE_END_STEPS;
  fx(w, 'holeend');
}

function standings(w) {
  return sorted(w).sort((a, b) => {
    const A = w.p[a], B = w.p[b];
    return B.sc - A.sc || B.ac - A.ac || A.ts - B.ts || a - b;
  });
}

function endCup(w) {
  const order = standings(w);
  const first = order[0];
  if (first !== undefined) w.p[first].wn += 1;
  w.win = first === undefined ? -1 : first;
  w.cup = order.map((id) => { const d = w.p[id]; return [id, d.sc, d.ac, d.wn]; });
  w.ph = CUP_END;
  w.pt = CUP_END_STEPS;
  fx(w, 'cupend', 0, 0, w.win);
}

// A ball in the cup. In a cup it takes the next place and its points; in
// practice it is only a ball that comes back to the tee in a moment.
function sink(w, id, d) {
  const L = holeOf(w);
  d.x = L.cup[0]; d.y = L.cup[1]; d.vx = 0; d.vy = 0; d.lp = 0;
  if (w.ph === PLAY) {
    w.fin += 1;
    d.sn = w.fin;
    const ace = d.st === 1;
    d.hp = PTS[Math.min(d.sn, PTS.length) - 1] * (lastHole(w) ? 2 : 1) + (ace ? ACE : 0);
    if (ace) d.ac += 1;
    if (d.sn === 1) w.pt = Math.min(w.pt, CLOSE_STEPS);
    fx(w, 'sink', d.x, d.y, id, d.sn, d.hp + (ace ? 1000 : 0));
  } else {
    d.sn = 1;
    d.cd = RESPAWN_STEPS;
    if (id !== BOT_ID && !w.nx) w.nx = NEXT_STEPS;
    fx(w, 'sink', d.x, d.y, id, 0, d.st === 1 ? 1000 : 0);
  }
}

// Water, or off the green altogether: the ball comes back to where it was
// struck from, a stroke dearer, and waits a moment to be fished out.
function splash(w, id, d) {
  fx(w, 'splash', d.x, d.y, id, d.lt);
  d.x = d.lx; d.y = d.ly; d.vx = 0; d.vy = 0;
  d.cd = STUN_STEPS;
  d.gh = GHOST_STEPS;
  d.st += 1;
  if (w.ph === PLAY) d.ts += 1;
  d.lt = 0;
  d.lp = 0;
}

const atRest = (d) => d.vx === 0 && d.vy === 0;
const inPlay = (d) => d.sn === 0;

// A putt asked for is struck once the ball is still, on the tee or wherever
// it stopped, and never while the hole is being laid out or scored.
function strike(w, id, d) {
  if (d.hk <= d.sk) return;
  if (!inPlay(d)) { d.sk = d.hk; return; }
  if (w.ph !== PLAY && w.ph !== WAIT) return;
  if (d.cd > 0 || !atRest(d)) return;
  d.sk = d.hk;
  const al = Math.sqrt(d.ax * d.ax + d.ay * d.ay);
  if (d.pw < MIN_PW || al < 1) return;
  const v = (VMAX * d.pw) / 1000;
  d.vx = (d.ax / al) * v;
  d.vy = (d.ay / al) * v;
  d.lx = d.x; d.ly = d.y;
  d.st += 1;
  if (w.ph === PLAY) d.ts += 1;
  d.cd = SHOT_GAP;
  d.lt = 0;
  d.am = 0;
  fx(w, 'putt', d.x, d.y, id, d.pw);
}

// One ball through a piece of a step: the lie of the green, what the grass or
// the sand takes off it, then the rails, the bumpers, the blades, the water
// and the cup. A ball at rest only feels the lie, which moves it if it is
// steeper than the grass holds, and the blades, which sweep it on.
function roll(w, L, id, d, cuts) {
  let sand = false;
  for (const r of L.sand) if (inBox(r, d.x, d.y, 0)) { sand = true; break; }
  for (const s of L.slopes) if (inBox(s, d.x, d.y, 0)) { d.vx += s[4] * SDT; d.vy += s[5] * SDT; }
  for (const [hx, hy, r, g] of L.hills) {
    const dx = d.x - hx, dy = d.y - hy, dd = Math.sqrt(dx * dx + dy * dy);
    if (dd < r && dd > 0.012) { const k = (g * SDT * (1 - dd / r) * 2) / dd; d.vx += dx * k; d.vy += dy * k; }
  }
  const sp = Math.sqrt(d.vx * d.vx + d.vy * d.vy), dec = (sand ? SAND_DECEL : DECEL) * SDT;
  if (sp <= dec) {
    d.vx = 0; d.vy = 0;
    if (L.mill) sweep(w, L, id, d, cuts);
    return;
  }
  const keep = (sp - dec) / sp * (sp > VMAX * 1.25 ? (VMAX * 1.25) / sp : 1);
  d.vx *= keep;
  d.vy *= keep;
  d.x += d.vx * SDT;
  d.y += d.vy * SDT;

  for (const s of L.segs) {
    const [qx, qy, dist] = nearOnSeg(s, d.x, d.y), R = BR + WALL_T;
    if (dist >= R || dist < 1e-9) continue;
    const nx = (d.x - qx) / dist, ny = (d.y - qy) / dist;
    d.x = qx + nx * R; d.y = qy + ny * R;
    const vn = d.vx * nx + d.vy * ny;
    if (vn < 0) {
      d.vx -= nx * vn * (1 + WALL_E); d.vy -= ny * vn * (1 + WALL_E);
      if (vn < -0.12) fx(w, 'rail', d.x, d.y, id, -vn);
    }
  }
  for (const [bx, by, r] of L.bumpers) {
    const dx = d.x - bx, dy = d.y - by, dist = Math.sqrt(dx * dx + dy * dy), R = r + BR;
    if (dist >= R || dist < 1e-9) continue;
    const nx = dx / dist, ny = dy / dist;
    d.x = bx + nx * R; d.y = by + ny * R;
    const vn = d.vx * nx + d.vy * ny;
    if (vn < 0) {
      d.vx += nx * (-2 * vn + BUMP_KICK); d.vy += ny * (-2 * vn + BUMP_KICK);
      fx(w, 'bumper', bx + nx * r, by + ny * r, id, -vn);
    }
  }
  if (L.mill) sweep(w, L, id, d, cuts);

  let wet = d.x < 0 || d.x > FW || d.y < 0 || d.y > FH;
  for (const r of L.water) if (!wet && inBox(r, d.x, d.y, 0)) wet = true;
  if (wet) return splash(w, id, d);

  const cx = d.x - L.cup[0], cy = d.y - L.cup[1], cd = Math.sqrt(cx * cx + cy * cy);
  if (cd < CUP_R) {
    const s2 = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    if (s2 < SINK_V || cd < BR * 0.25) return sink(w, id, d);
    // Too fast to drop: the edge drags it round and slows it, and it may yet fall.
    const k = (LIP_PULL * SDT) / Math.max(cd, 1e-6);
    d.vx -= cx * k; d.vy -= cy * k;
    d.vx *= 0.985; d.vy *= 0.985;
    d.lp = 1;
  } else if (d.lp) {
    d.lp = 0;
    fx(w, 'lip', d.x, d.y, id);
  }
}

// The windmill's blades and hub against a ball. A blade moves where it meets
// the ball, and a ball it sweeps is thrown on at the blade's own pace.
function sweep(w, L, id, d, cuts) {
  const [cx, cy, , turn] = L.mill;
  for (let i = 0; i <= cuts.length; i++) {
    const b = i < cuts.length ? cuts[i] : [cx, cy, cx, cy];
    const [qx, qy, dist] = nearOnSeg(b, d.x, d.y), R = BR + (i < cuts.length ? MILL_T : MILL_HUB);
    if (dist >= R || dist < 1e-9) continue;
    const nx = (d.x - qx) / dist, ny = (d.y - qy) / dist;
    d.x = qx + nx * R; d.y = qy + ny * R;
    const bvx = -turn * (qy - cy), bvy = turn * (qx - cx);
    const vn = (d.vx - bvx) * nx + (d.vy - bvy) * ny;
    if (vn < 0) {
      d.vx -= nx * vn * 1.6; d.vy -= ny * vn * 1.6;
      if (vn < -0.1) fx(w, 'mill', d.x, d.y, id, -vn);
    }
  }
}

// Balls that touch push apart and trade what they were closing at; one that
// is knocked remembers whose ball did it, for the pond to say.
function knocks(w, ids) {
  for (let i = 0; i < ids.length; i++) {
    const A = w.p[ids[i]];
    if (A.gh > 0 || !inPlay(A)) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const B = w.p[ids[j]];
      if (B.gh > 0 || !inPlay(B)) continue;
      const dx = B.x - A.x, dy = B.y - A.y, dd = dx * dx + dy * dy;
      if (dd >= 4 * BR * BR || dd < 1e-12) continue;
      const dist = Math.sqrt(dd), nx = dx / dist, ny = dy / dist, push = (2 * BR - dist) / 2;
      A.x -= nx * push; A.y -= ny * push;
      B.x += nx * push; B.y += ny * push;
      const rv = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
      if (rv >= 0) continue;
      // Whichever was rolling faster is the one that did the knocking.
      const sa = A.vx * A.vx + A.vy * A.vy, sb = B.vx * B.vx + B.vy * B.vy;
      if (sa >= sb) B.lt = ids[i]; else A.lt = ids[j];
      const jn = (-(1 + BALL_E) * rv) / 2;
      A.vx -= nx * jn; A.vy -= ny * jn;
      B.vx += nx * jn; B.vy += ny * jn;
      if (-rv > 0.06) fx(w, 'clack', (A.x + B.x) / 2, (A.y + B.y) / 2, ids[i], ids[j], -rv);
    }
  }
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_EVERY = 3;           // steps between the bot's decisions

// The bot plays while the green waits for a cup, and goes the moment a cup's
// first hole is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && Object.keys(w.p).length < MAX_P) newBall(w, BOT_ID, 0);
  else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Whether a ball rolled from one point to another meets nothing on the way —
// rails, bumpers, water — read off the hole a short stride at a time.
function clearLine(L, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy);
  const n = Math.max(1, Math.ceil(len / 0.015));
  for (let i = 1; i <= n; i++) {
    const x = x1 + (dx * i) / n, y = y1 + (dy * i) / n;
    for (const s of L.segs) if (nearOnSeg(s, x, y)[2] < BR + WALL_T + 0.004) return false;
    for (const [bx, by, r] of L.bumpers) if ((x - bx) * (x - bx) + (y - by) * (y - by) < (r + BR + 0.004) * (r + BR + 0.004)) return false;
    for (const r of L.water) if (inBox(r, x, y, BR)) return false;
  }
  return true;
}

// The bot's putt: straight at the cup when it can see it, a little past it;
// otherwise at the point on the way nearest the cup that it can see, to stop
// there. It lines up for a moment first, which everybody sees, and it misses
// by a little, now and then by a lot.
function botAim(w, L, d) {
  let tx = L.cup[0], ty = L.cup[1], over = 0.12;
  if (!clearLine(L, d.x, d.y, tx, ty)) {
    let pick = -1;
    for (let i = L.via.length - 1; i >= 0 && pick < 0; i--) if (clearLine(L, d.x, d.y, L.via[i][0], L.via[i][1])) pick = i;
    if (pick < 0 && L.via.length) {
      let best = Infinity;
      L.via.forEach(([vx, vy], i) => { const q = (vx - d.x) * (vx - d.x) + (vy - d.y) * (vy - d.y); if (q < best) { best = q; pick = i; } });
    }
    if (pick >= 0) { tx = L.via[pick][0]; ty = L.via[pick][1]; over = 0; }
  }
  const dx = tx - d.x, dy = ty - d.y, dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const wild = draw01(w) < 0.1 ? 3 : 1;
  const [ux, uy] = turned(dx / dist, dy / dist, (draw01(w) - 0.5) * 0.12 * wild);
  const v = Math.sqrt(2 * DECEL * (dist + over)) * (0.86 + draw01(w) * 0.28);
  d.ax = Math.round(ux * 1000);
  d.ay = Math.round(uy * 1000);
  d.pw = clamp(Math.round((v / VMAX) * 1000), MIN_PW, 1000);
  d.am = 1;
}

function botHand(w, L) {
  const d = w.p[BOT_ID];
  if (!d || w.n % BOT_EVERY) return;
  if (!inPlay(d) || d.cd > 0 || !atRest(d) || d.hk > d.sk) { d.bw = 0; return; }
  if (d.bw === 0) {
    d.bw = 4 + Math.floor(draw01(w) * 9);
    botAim(w, L, d);
    return;
  }
  d.bw -= 1;
  if (d.bw === 0) d.hk = Math.min(SHOT_MAX, d.sk + 1);
}

// One step of the green: a function of the green alone.
function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second golfer ends practice, three seconds on: the count runs in pt,
    // which a waiting green otherwise leaves at zero. The bot goes first, so
    // the tee is laid out without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); beginCup(w); }
    if (w.ph === WAIT && w.nx > 0 && --w.nx === 0) {
      nextLay(w);
      teeUp(w);
      fx(w, 'round');
    }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt <= 0 || (w.fin > 0 && humans(w).every((id) => w.p[id].sn))) endHole(w);
    } else if (w.ph === HOLE_END) {
      if (w.pt <= 0) {
        if (w.ho + 1 < HOLES) { w.ho += 1; beginHole(w); } else endCup(w);
      }
    } else if (w.pt <= 0) {
      beginCup(w);
    }
  }

  const L = holeOf(w);
  const ids = sorted(w);
  botHand(w, L);
  for (const id of ids) {
    const d = w.p[id];
    if (d.gh > 0) d.gh -= 1;
    if (d.cd > 0) {
      d.cd -= 1;
      // In practice a ball in the cup comes back to the tee when its wait is up.
      if (d.cd === 0 && d.sn && w.ph === WAIT) {
        const [x, y] = teeSpot(L, bySeat(w).indexOf(id), 0);
        setDown(d, x, y);
        d.st = 0;
        d.gh = GHOST_STEPS;
      }
    }
    strike(w, id, d);
  }
  if (w.ph === HOLE_END || w.ph === CUP_END || w.ph === COUNT) return;
  const cuts = blades(L, w.n);
  for (let s = 0; s < SUB; s++) {
    for (const id of ids) {
      const d = w.p[id];
      if (inPlay(d)) roll(w, L, id, d, cuts);
    }
    knocks(w, ids);
  }
}

// A green handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;

function rowsOf(raw) {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length > MAX_P) return undefined;
  const out = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => int(v, -BIG, BIG))) return undefined;
    out.push([r[0], r[1], r[2], r[3]]);
  }
  return out;
}

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG) || !int(raw.ho, 0, HOLES - 1)) return null;
  if (![WAIT, COUNT, PLAY, HOLE_END, CUP_END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.lay, 0, LAID.length - 1) || !int(raw.used, 0, (1 << HOLE_DEFS.length) - 1) || !int(raw.fin, 0, 99) || !int(raw.nx, 0, NEXT_STEPS)) return null;
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
    if (!num(d.lx, -1, FW + 1) || !num(d.ly, -1, FH + 1)) return null;
    if (inputOf([d.ax, d.ay, d.pw, d.hk, d.am]) === null || !int(d.sk, 0, SHOT_MAX)) return null;
    if (!int(d.st, 0, 99999) || !int(d.ts, 0, 999999) || !int(d.sn, 0, 99) || !int(d.hp, 0, 99)) return null;
    if (!int(d.sc, 0, 999999) || !int(d.wn, 0, 99999) || !int(d.ac, 0, 9999)) return null;
    if (!int(d.cd, 0, 999) || !int(d.gh, 0, GHOST_STEPS) || !int(d.bw, 0, 99) || !int(d.lt, -BIG, BIG)) return null;
    if (!int(d.lp, 0, 1) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    seats.add(d.k);
    p[id] = ball(d);
  }
  const res = rowsOf(raw.res), cup = rowsOf(raw.cup);
  if (res === undefined || cup === undefined || !int(raw.win, -BIG, BIG)) return null;
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, ho: raw.ho, lay: raw.lay, used: raw.used, fin: raw.fin, nx: raw.nx, p, res, cup, win: raw.win };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed green steps, and kept with the step that made them
// until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a seaside crazy-golf course at noon — a deep hedge round a
// bright striped green, warm timber rails, cream sand, a teal pond, candy-red
// bumpers — and a bright colour for each seat that is its ball's and its chip's.
const INK = {
  hedge: '#18372b', hedgeHi: '#1f4434', green: '#4caf5a', stripe: '#46a453', fringe: '#2f7d42', rail: '#8a5a2e',
  railHi: '#d39b5c', sand: '#ecd9a2', sandDot: '#d6be7e', water: '#2a8fc4', waterHi: '#7fd0f0', bumper: '#e8455a',
  bumperHi: '#ffd1d8', mill: '#f2e3c4', millDark: '#a8714a', cup: '#10221a', tee: '#3b9a4c', text: '#fffaf0',
  muted: '#d8eadc', dim: '#a9c6b2', gold: '#ffd166', danger: '#ff5a6e', panel: 'rgba(12,28,22,0.92)',
};
const SEAT = ['#ff5d73', '#3ec1d3', '#ffd23f', '#9b7bff', '#ff9f43', '#5b8cff', '#f5f5f5', '#c86bfa'];
const FONT = "600 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.hedge};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%;cursor:crosshair';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');
const bg = document.createElement('canvas');
const bgx = bg.getContext('2d');
let bgKey = '';

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #3f7a5a;' +
  `background:#14301f;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

// The field is drawn on its side on a tall screen, so a phone held upright
// shows the whole hole as large as it can. A quarter turn is a turn, not a
// mirror: a putt dragged toward you still runs away from you.
let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, sc = 1, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1, rot = false;
let fieldBox = [0, 0, 0, 0];   // left, top, right, bottom on the screen
// NOTE_ROOM under the field keeps the practice note off the bottom of the hole.
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

// ── the course, painted once a hole and a size ─────────────────────────────
function borderPath(c, L) {
  c.beginPath();
  L.border.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
}

function paintCourse(lay) {
  const L = LAID[lay], c = bgx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = INK.hedge;
  c.fillRect(0, 0, bg.width, bg.height);
  fieldOn(c, 0, 0);
  // A hedge of round shrubs all round the course, the same for a hole every time.
  let s = lay * 7919 + 11;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const x = -0.6 + rnd() * (FW + 1.2), y = -0.6 + rnd() * (FH + 1.2), r = 0.02 + rnd() * 0.035;
    c.fillStyle = i % 3 ? INK.hedgeHi : '#14301f';
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  c.lineJoin = 'round';
  c.lineCap = 'round';
  // The green, mown in stripes across the way the hole runs, inside a fringe.
  c.save();
  borderPath(c, L);
  c.fillStyle = INK.fringe;
  c.fill();
  c.clip();
  c.fillStyle = INK.green;
  c.fillRect(0, 0, FW, FH);
  c.save();
  c.translate(L.tee[0], L.tee[1]);
  c.transform(L.td[0], L.td[1], -L.td[1], L.td[0], 0, 0);
  c.fillStyle = INK.stripe;
  for (let x = -3; x < 3; x += 0.16) c.fillRect(x, -3, 0.08, 6);
  c.restore();
  // Slopes: soft chevrons pointing downhill; a hill: rings round its top.
  c.strokeStyle = 'rgba(255,255,255,0.13)';
  c.lineWidth = 0.006;
  for (const [x, y, w, h, gx, gy] of L.slopes) {
    c.fillStyle = 'rgba(20,60,30,0.16)';
    c.fillRect(x, y, w, h);
    const gl = Math.hypot(gx, gy) || 1, ux = gx / gl, uy = gy / gl;
    for (let px = x + 0.05; px < x + w - 0.02; px += 0.09) {
      for (let py = y + 0.05; py < y + h - 0.02; py += 0.09) {
        c.beginPath();
        c.moveTo(px - ux * 0.02 - uy * 0.018, py - uy * 0.02 + ux * 0.018);
        c.lineTo(px + ux * 0.0, py + uy * 0.0);
        c.lineTo(px - ux * 0.02 + uy * 0.018, py - uy * 0.02 - ux * 0.018);
        c.stroke();
      }
    }
  }
  for (const [x, y, r] of L.hills) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,220,0.22)');
    g.addColorStop(1, 'rgba(255,255,220,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.12)';
    for (let k = 1; k <= 3; k++) { c.beginPath(); c.arc(x, y, (r * k) / 3.4, 0, Math.PI * 2); c.stroke(); }
  }
  // Sand, speckled.
  for (const [x, y, w, h] of L.sand) {
    roundRect(x, y, w, h, 0.03, c);
    c.fillStyle = INK.sand;
    c.fill();
    c.fillStyle = INK.sandDot;
    for (let i = 0; i < Math.round(w * h * 3000); i++) c.fillRect(x + 0.01 + rnd() * (w - 0.02), y + 0.01 + rnd() * (h - 0.02), 0.004, 0.004);
  }
  // Water, with a bright edge; its ripples move, and are drawn every frame.
  for (const [x, y, w, h] of L.water) {
    roundRect(x - 0.006, y - 0.006, w + 0.012, h + 0.012, 0.03, c);
    c.fillStyle = INK.waterHi;
    c.fill();
    roundRect(x, y, w, h, 0.026, c);
    c.fillStyle = INK.water;
    c.fill();
  }
  // The tee mat.
  const [tx, ty] = L.tee;
  c.save();
  c.translate(tx, ty);
  c.transform(L.td[0], L.td[1], -L.td[1], L.td[0], 0, 0);
  roundRect(-0.075, -0.1, 0.12, 0.2, 0.02, c);
  c.fillStyle = INK.tee;
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.lineWidth = 0.003;
  c.stroke();
  c.restore();
  // The cup, sunk into the green.
  const [cx, cy] = L.cup;
  c.fillStyle = 'rgba(255,255,255,0.18)';
  c.beginPath(); c.arc(cx, cy, CUP_R + 0.008, 0, Math.PI * 2); c.fill();
  c.fillStyle = INK.cup;
  c.beginPath(); c.arc(cx, cy, CUP_R, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#26402f';
  c.beginPath(); c.arc(cx, cy + 0.006, CUP_R * 0.7, 0, Math.PI); c.fill();
  c.restore();
  // The rails: the border all round, then any inside it, timber with a lit top.
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(0,0,0,0.3)';
  c.lineWidth = 2 * WALL_T + 0.006;
  c.save(); c.translate(0.004, 0.006);
  for (const sg of L.segs) { c.beginPath(); c.moveTo(sg[0], sg[1]); c.lineTo(sg[2], sg[3]); c.stroke(); }
  c.restore();
  c.strokeStyle = INK.rail;
  c.lineWidth = 2 * WALL_T + 0.004;
  for (const sg of L.segs) { c.beginPath(); c.moveTo(sg[0], sg[1]); c.lineTo(sg[2], sg[3]); c.stroke(); }
  c.strokeStyle = INK.railHi;
  c.lineWidth = WALL_T * 0.8;
  for (const sg of L.segs) { c.beginPath(); c.moveTo(sg[0], sg[1]); c.lineTo(sg[2], sg[3]); c.stroke(); }
}

function drawCourse(lay) {
  const key = lay + ':' + VW + 'x' + VH + ':' + dpx + ':' + rot;
  if (key !== bgKey) { paintCourse(lay); bgKey = key; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bg, Math.round(shakeX * dpx), Math.round(shakeY * dpx));
}

// What moves on the course: ripples on the water, the bumpers (lit when hit),
// the windmill, the flag.
const bumpLit = new Map();   // bumper index -> brightness
function drawFixtures(t, L, nShown, now) {
  inField();
  for (const [x, y, w, h] of L.water) {
    ctx.save();
    roundRect(x, y, w, h, 0.026);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 0.003;
    for (let i = 0; i < 6; i++) {
      const ry = y + ((i + 0.5) / 6) * h, sh = ((now / 3000 + i * 0.37) % 1) * 0.12;
      ctx.beginPath();
      for (let px = x - 0.12 + sh; px < x + w; px += 0.06) { ctx.moveTo(px, ry); ctx.quadraticCurveTo(px + 0.015, ry - 0.008, px + 0.03, ry); }
      ctx.stroke();
    }
    ctx.restore();
  }
  L.bumpers.forEach(([x, y, r], i) => {
    const lit = bumpLit.get(i) || 0;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    disc(x + 0.004, y + 0.006, r); ctx.fill();
    ctx.fillStyle = lit > 0.05 ? lighter(INK.bumper, lit * 0.6) : INK.bumper;
    disc(x, y, r * (1 + lit * 0.12)); ctx.fill();
    ctx.strokeStyle = INK.bumperHi;
    ctx.lineWidth = r * 0.22;
    disc(x, y, r * 0.62); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    disc(x - r * 0.25, y - r * 0.25, r * 0.16); ctx.fill();
  });
  if (L.mill) {
    const [cx, cy] = L.mill;
    // The blades as the step being drawn has them, not as the last step left them.
    const bs = blades(L, nShown);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2 * MILL_T + 0.004;
    for (const b of bs) { ctx.beginPath(); ctx.moveTo(b[0] + 0.005, b[1] + 0.008); ctx.lineTo(b[2] + 0.005, b[3] + 0.008); ctx.stroke(); }
    for (const b of bs) {
      ctx.strokeStyle = INK.millDark;
      ctx.lineWidth = 2 * MILL_T + 0.004;
      ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(b[2], b[3]); ctx.stroke();
      ctx.strokeStyle = INK.mill;
      ctx.lineWidth = 2 * MILL_T - 0.002;
      ctx.beginPath(); ctx.moveTo(b[0] + (b[2] - b[0]) * 0.3, b[1] + (b[3] - b[1]) * 0.3); ctx.lineTo(b[2], b[3]); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    ctx.fillStyle = '#c0392b';
    disc(cx, cy, MILL_HUB); ctx.fill();
    ctx.fillStyle = '#f7d9a8';
    disc(cx, cy, MILL_HUB * 0.45); ctx.fill();
  }
  // The flag: a pole from the cup and a pennant that flutters.
  const [gx, gy] = L.cup;
  const flagUp = !playersIn(t).some((id) => { const d = t.p[id]; return inPlay(d) && (d.x - gx) ** 2 + (d.y - gy) ** 2 < 0.09 * 0.09; });
  ctx.globalAlpha = flagUp ? 1 : 0.35;
  ctx.strokeStyle = '#f4f4f4';
  ctx.lineWidth = 0.004;
  ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + 0.012, gy - 0.085); ctx.stroke();
  const wv = Math.sin(now / 180) * 0.006;
  ctx.fillStyle = INK.danger;
  ctx.beginPath();
  ctx.moveTo(gx + 0.012, gy - 0.085);
  ctx.quadraticCurveTo(gx + 0.04, gy - 0.08 + wv, gx + 0.062, gy - 0.072 + wv);
  ctx.lineTo(gx + 0.009, gy - 0.056);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

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
  g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}
function puff(dur, vol, freq, delay, q, type) {
  if (!noise) {
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.8), actx.sampleRate);
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
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(actx.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}
const sound = {
  putt(mine, k) {
    if (!ready('putt', 60)) return;
    tone(520 + k * 300, 0.06, 'triangle', mine ? 0.12 : 0.04, 0.5);
    puff(0.05, mine ? 0.16 : 0.05, 2400, 0, 2);
  },
  clack(near, k) {
    if (!ready('clack', 50)) return;
    tone(1800, 0.05, 'square', (near ? 0.07 : 0.03) * Math.min(1, 0.4 + k), 0.6);
    tone(2600, 0.04, 'triangle', near ? 0.05 : 0.02, 0.8, 0.004);
  },
  rail(mine, k) { if (ready('rail', 70)) { tone(160, 0.09, 'triangle', (mine ? 0.1 : 0.04) * Math.min(1, 0.3 + k), 0.6); puff(0.05, mine ? 0.06 : 0.02, 700, 0, 1); } },
  bumper(mine) { if (ready('bumper', 80)) { tone(330, 0.18, 'sine', mine ? 0.12 : 0.05, 2.2); tone(660, 0.12, 'triangle', mine ? 0.05 : 0.02, 1.6, 0.02); } },
  mill(mine) { if (ready('mill', 120)) { tone(120, 0.16, 'sawtooth', mine ? 0.06 : 0.025, 0.5); puff(0.12, mine ? 0.1 : 0.04, 500, 0, 1); } },
  splash(mine) {
    if (!ready('splash', 120)) return;
    puff(0.45, mine ? 0.3 : 0.12, 900, 0, 0.7, 'lowpass');
    tone(300, 0.25, 'sine', mine ? 0.07 : 0.03, 0.4, 0.02);
  },
  lip(mine) { if (ready('lip', 200)) { tone(900, 0.12, 'triangle', mine ? 0.08 : 0.03, 1.4); tone(1300, 0.18, 'triangle', mine ? 0.06 : 0.02, 0.6, 0.1); } },
  sink(mine, first) {
    if (!ready('sink', 150)) return;
    puff(0.08, mine ? 0.2 : 0.08, 1500, 0, 3);
    tone(220, 0.1, 'triangle', mine ? 0.12 : 0.05, 0.7, 0.03);
    tone(260, 0.08, 'triangle', mine ? 0.08 : 0.03, 0.7, 0.11);
    if (mine) [659, 784, 988, first ? 1319 : 1175].forEach((f, i) => tone(f, 0.2, 'triangle', 0.08, 0, 0.18 + i * 0.07));
  },
  ace() { if (ready('ace', 600)) [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.26, 'triangle', 0.09, 0, i * 0.07)); },
  beep() { if (ready('beep', 200)) tone(440, 0.16, 'square', 0.06); },
  go() { if (ready('go', 300)) { tone(880, 0.3, 'square', 0.07); tone(1760, 0.26, 'sine', 0.04, 1.0, 0.05); } },
  end(won) {
    if (!ready('end', 500)) return;
    if (won) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, 'triangle', 0.1, 0, i * 0.09));
    else [392, 330, 262].forEach((f, i) => tone(f, 0.26, 'triangle', 0.07, 0, i * 0.1));
  },
  hole() { if (ready('hole', 400)) [523, 784].forEach((f, i) => tone(f, 0.16, 'triangle', 0.06, 0, i * 0.08)); },
};
function setMuted(m) {
  muted = m;
  muteBtn.textContent = muted ? '×' : '♪';
  muteBtn.style.opacity = muted ? '0.6' : '1';
}
muteBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
muteBtn.addEventListener('click', (e) => { e.stopPropagation(); wake(); setMuted(!muted); });

// ── bits: particles, pops, rings, shake, trails ────────────────────────────
// Stepped on a clock of their own at a fixed rate, never once per frame, so a
// fast screen and a slow one see the same spray.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, drag } in field units
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0, flash = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, drag) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 16 + Math.random() * 22, size, colour, drag: drag || 0.9 });
  }
  if (bits.length > 600) bits.splice(0, bits.length - 600);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 70, px: px || 16, lift: lift || 22 }); }
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
    for (const [i, v] of bumpLit) { if (v < 0.03) bumpLit.delete(i); else bumpLit.set(i, v * 0.88); }
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.9;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, seen, trail: [[x, y, t]] }
let drawFailed = false;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, seen: 0, trail: [] }));
  l.seen = performance.now();
  return l;
}
const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].k] : '#dddddd');

function play(e, t) {
  const me = myId();
  const mine = e.a === me;
  const L = holeOf(t);
  if (e.kind === 'putt') {
    spray(e.x, e.y, 6, '#bdf0a8', 0.25, 0.005, 0.86);
    lookOf(e.a).squash = 0.4 + e.b / 2000;
    sound.putt(mine, e.b / 1000);
  } else if (e.kind === 'clack') {
    spray(e.x, e.y, 5 + Math.round(e.c * 10), '#ffffff', 0.35, 0.005, 0.85);
    lookOf(e.a).squash = Math.min(1, e.c * 1.5);
    lookOf(e.b).squash = Math.min(1, e.c * 1.5);
    const near = e.a === me || e.b === me;
    if (near) shake = Math.max(shake, 1.5 + e.c * 5);
    sound.clack(near, e.c);
  } else if (e.kind === 'rail') {
    spray(e.x, e.y, 4, INK.railHi, 0.25, 0.005, 0.85);
    lookOf(e.a).squash = Math.min(1, e.b);
    sound.rail(mine, e.b);
  } else if (e.kind === 'bumper') {
    let best = -1, bd = Infinity;
    L.bumpers.forEach(([x, y], i) => { const q = (x - e.x) ** 2 + (y - e.y) ** 2; if (q < bd) { bd = q; best = i; } });
    if (best >= 0) bumpLit.set(best, 1);
    spray(e.x, e.y, 8, INK.bumperHi, 0.45, 0.006, 0.86);
    ring(e.x, e.y, '#ffffff', 0.04);
    if (mine) shake = Math.max(shake, 2.5);
    sound.bumper(mine);
  } else if (e.kind === 'mill') {
    spray(e.x, e.y, 10, INK.mill, 0.5, 0.006, 0.86);
    lookOf(e.a).squash = 1;
    if (mine) { shake = Math.max(shake, 4); pop(e.x, e.y, 'whack!', INK.gold, 15, 24); }
    sound.mill(mine);
  } else if (e.kind === 'splash') {
    for (let i = 0; i < 3; i++) spray(e.x, e.y, 9, i ? INK.waterHi : '#ffffff', 0.55, 0.007, 0.88);
    ring(e.x, e.y, INK.waterHi, 0.07);
    ring(e.x, e.y, '#ffffff', 0.045);
    if (mine) {
      shake = Math.max(shake, 7);
      flash = 0.8;
      pop(e.x, e.y, e.b && e.b !== me ? 'splashed by ' + nickOf(e.b) + '!' : 'splash! +1', INK.waterHi, 17, 30);
    } else if (e.b === me) pop(e.x, e.y, 'you sank ' + nickOf(e.a) + '!', INK.gold, 17, 30);
    else pop(e.x, e.y, 'splash', INK.waterHi, 13, 22);
    sound.splash(mine || e.b === me);
  } else if (e.kind === 'lip') {
    if (mine) pop(e.x, e.y, 'lipped out!', INK.muted, 15, 24);
    sound.lip(mine);
  } else if (e.kind === 'sink') {
    const c = colourOf(t, e.a), ace = e.c >= 1000, pts = e.c % 1000;
    for (let i = 0; i < (ace ? 6 : 3); i++) spray(e.x, e.y, 10, SEAT[(i * 3 + e.a) & 7], 0.7, 0.007, 0.9);
    ring(e.x, e.y, c, 0.09);
    if (e.b > 0) {
      const head = ace ? 'hole in one! ' : '';
      pop(e.x, e.y, mine ? head + '+' + pts : head + ord(e.b) + ' ' + nickOf(e.a), mine || ace ? INK.gold : c, mine ? 24 : 15, 36);
    } else pop(e.x, e.y, ace ? 'hole in one!' : mine ? 'in!' : 'in', mine ? INK.gold : c, mine ? 20 : 13, 30);
    if (mine) { shake = Math.max(shake, 3); if (ace) sound.ace(); else sound.sink(true, e.b === 1); } else sound.sink(false, false);
  } else if (e.kind === 'spawn') {
    ring(e.x, e.y, colourOf(t, e.a), 0.05);
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'holeend') {
    sound.hole();
  } else if (e.kind === 'cupend') {
    if (t.p[me]) sound.end(e.a === me);
  } else if (e.kind === 'round') {
    for (const l of looks.values()) l.trail.length = 0;
    bumpLit.clear();
  }
}

// A ball: a shadow, the ball in its seat's colour with a bright crown of
// light, a white ring round your own, and a little crown on the cup's leader.
function drawBall(x, y, colour, me, ghost, squash, lead, moving) {
  inField();
  ctx.globalAlpha = ghost ? 0.45 : 1;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(x + 0.004, y + 0.006, BR * 1.05, BR * 0.9, 0, 0, Math.PI * 2); ctx.fill();
  const s = 1 + squash * 0.22;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, 2 - s);
  ctx.fillStyle = colour;
  disc(0, 0, BR); ctx.fill();
  ctx.fillStyle = lighter(colour, 0.55);
  disc(-BR * 0.3, -BR * 0.32, BR * 0.42); ctx.fill();
  ctx.fillStyle = '#ffffff';
  disc(-BR * 0.38, -BR * 0.4, BR * 0.16); ctx.fill();
  if (me) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.0035; disc(0, 0, BR + 0.004); ctx.stroke(); }
  ctx.restore();
  if (lead && !moving) {
    ctx.fillStyle = INK.gold;
    ctx.beginPath();
    const cy = y - BR - 0.012;
    ctx.moveTo(x - 0.011, cy + 0.006); ctx.lineTo(x - 0.011, cy - 0.004); ctx.lineTo(x - 0.0055, cy + 0.001);
    ctx.lineTo(x, cy - 0.007); ctx.lineTo(x + 0.0055, cy + 0.001); ctx.lineTo(x + 0.011, cy - 0.004); ctx.lineTo(x + 0.011, cy + 0.006);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// The line a putt is lined up along: dashes as long as the putt is strong,
// in the colour of how hard it is; a rival's is faint, and is theirs to see too.
function drawAim(x, y, ux, uy, pw, colour, mine, now) {
  inField();
  const len = 0.05 + pw * 0.42;
  const hot = pw < 0.5 ? '#9cff9c' : pw < 0.8 ? '#ffe066' : '#ff7a6a';
  ctx.lineCap = 'round';
  ctx.strokeStyle = mine ? hot : colour;
  ctx.globalAlpha = mine ? 0.95 : 0.45;
  ctx.lineWidth = mine ? 0.0055 : 0.004;
  ctx.setLineDash([0.012, 0.012]);
  ctx.lineDashOffset = -(now / 1000) * 0.08;
  ctx.beginPath();
  ctx.moveTo(x + ux * (BR + 0.006), y + uy * (BR + 0.006));
  ctx.lineTo(x + ux * len, y + uy * len);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  if (mine) {
    // An arrowhead, and a ring round the ball filling with the strength.
    const hx = x + ux * len, hy = y + uy * len, nx = -uy, ny = ux;
    ctx.fillStyle = hot;
    ctx.beginPath();
    ctx.moveTo(hx + ux * 0.016, hy + uy * 0.016);
    ctx.lineTo(hx + nx * 0.01, hy + ny * 0.01);
    ctx.lineTo(hx - nx * 0.01, hy - ny * 0.01);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = hot;
    ctx.lineWidth = 0.004;
    const a0 = Math.atan2(uy, ux);
    ctx.beginPath();
    ctx.arc(x, y, BR + 0.012, a0 - Math.PI * pw, a0 + Math.PI * pw);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

function drawTrails(now) {
  inField();
  ctx.lineCap = 'round';
  for (const l of looks.values()) {
    while (l.trail.length && now - l.trail[0][2] > 450) l.trail.shift();
    if (l.trail.length < 2) continue;
    ctx.strokeStyle = l.colour || '#ffffff';
    for (let i = 1; i < l.trail.length; i++) {
      const k = 1 - (now - l.trail[i][2]) / 450;
      ctx.globalAlpha = 0.35 * k;
      ctx.lineWidth = BR * 1.3 * k;
      ctx.beginPath();
      ctx.moveTo(l.trail[i - 1][0], l.trail[i - 1][1]);
      ctx.lineTo(l.trail[i][0], l.trail[i][1]);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
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
    const X = clamp(X0 + shakeX, 60, VW - 60), Y = Y0 + shakeY - ease(Math.min(1, k * 1.4)) * p.lift;
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10,25,15,0.7)';
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
  const L = holeOf(t);
  let status = '', colour = INK.text;
  const holeName = 'hole ' + (t.ho + 1) + '/' + HOLES;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = holeName + ' · ' + L.name + ' · get ready';
  else if (t.ph === PLAY) {
    status = holeName + (lastHole(t) ? ' · double points' : '');
    if (d && d.sn) status += ' · you came ' + ord(d.sn);
    else if (d) status += ' · strokes ' + d.st;
    if (t.fin > 0) {
      status += ' · ' + clock(t.pt) + ' to get down';
      colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
    } else status += ' · ' + clock(t.pt);
  } else if (t.ph === HOLE_END) status = holeName + ' · done';
  else status = 'the cup is over';
  text('putt rush', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('putt rush').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 82, 'left');
  text(wireNote(), VW - 50, 33, 9, INK.dim, 'right');

  // The board: one chip a golfer, in order of points this cup, in its seat's
  // colour, with its points and the cups it has won.
  if (order.length) {
    const y = narrow ? 54 : 48;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (order.length - 1)) / order.length);
    let x = (VW - (cw * order.length + gap * (order.length - 1))) / 2;
    order.forEach((id) => {
      const c = t.p[id], mine = id === me;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.18)' : 'rgba(5,20,12,0.45)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[c.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[c.k];
      disc(x + 11, y - 2, 6);
      ctx.fill();
      if (c.sn && t.ph !== WAIT) text('✓', x + 11, y + 2, 10, '#10201a', 'center');
      const score = (t.ph === WAIT ? '' : String(c.sc)) + (c.wn ? ' ★' + c.wn : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, INK.text, 'right');
      if (cw - 34 - sw > 14) fitText(mine ? 'you' : nickOf(id), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    });
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag back from anywhere, let go to putt · first in the cup scores most'
    : 'drag back with the mouse and let go to putt · or ← → aim, ↑ ↓ strength, space putts · M mutes';
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
// Practice ends a moment after a second golfer arrives: who it was, as this
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
    const tip = two ? null : 'drag back from anywhere, let go to putt · knock the bot into the water';
    practiceNote(now, VW, head, tip, [[TOP, fieldBox[1] - 4], [fieldBox[3] + 4, VH - BOT]], VH - BOT - 4);
  } else if (t.ph === COUNT) {
    const n = Math.ceil(t.pt / HZ);
    const w = Math.min(VW - 32, 340), h = 112;
    panel(cx, cy, w, h);
    fitText('hole ' + (t.ho + 1) + ' of ' + HOLES + ' · ' + holeOf(t).name, cx, cy - 22, 20, INK.text, w - 24);
    fitText(lastHole(t) ? 'final hole · points count double' : 'first in scores 5 · then 3, 2, 1 · a hole in one +2',
      cx, cy + 2, 13, lastHole(t) ? INK.gold : INK.muted, w - 24);
    text(String(n), cx, cy + 40, 26, INK.gold, 'center');
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('putt!', cx, cy + big * 0.5, big * (2 + k), '#9dff8a', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.fin > 0) {
    const first = playersIn(t).find((id) => t.p[id].sn === 1);
    if (first !== undefined) {
      const mine = t.p[me];
      const s = (first === me ? 'you are in first' : nickOf(first) + ' is in first') +
        (mine && !mine.sn ? ' · you have ' + clock(t.pt) : ' · the rest have ' + clock(t.pt));
      ctx.font = font(13);
      const w = Math.min(VW - 24, ctx.measureText(s).width + 28);
      panel(cx, fieldBox[1] + 18, w, 26);
      fitText(s, cx, fieldBox[1] + 23, 13, INK.gold, w - 16);
    }
  } else if (t.ph === HOLE_END && t.res) {
    const k = ease(Math.min(1, (HOLE_END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 300), h = 76 + rows.length * 21;
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 6, Math.min(VH - BOT - h / 2 - 6, cy)) + (1 - k) * 30;
    panel(cx, py, w, h);
    const y0 = py - h / 2;
    const first = rows.find((r) => r[1] === 1);
    const head = first ? (first[0] === me ? 'you got down first' : nickOf(first[0]) + ' got down first') : 'nobody got down';
    fitText(head, cx, y0 + 30, 18, first ? colourOf(t, first[0]) : INK.text, w - 24);
    rows.forEach(([id, at, pts, st], i) => {
      const y = y0 + 56 + i * 21;
      text(at ? ord(at) : '—', cx - w / 2 + 28, y, 13, at === 1 ? INK.gold : INK.dim, 'center');
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 52, y - 4, 5);
      ctx.fill();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 64, y, 14, id === me ? INK.text : INK.muted, w - 170, 'left');
      text(st + (st === 1 ? ' stroke' : ' strokes'), cx + w / 2 - 56, y, 11, INK.dim, 'right');
      text('+' + pts, cx + w / 2 - 16, y, 15, pts ? INK.text : INK.dim, 'right');
    });
    ctx.globalAlpha = 1;
  } else if (t.ph === CUP_END && t.cup) {
    const k = ease(Math.min(1, (CUP_END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.cup.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 100 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 6, Math.min(VH - BOT - h / 2 - 6, cy)) + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.win !== -1) { head = t.win === me ? 'you win the cup!' : nickOf(t.win) + ' wins the cup'; hc = colourOf(t, t.win); }
    else head = 'the cup is over';
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 34, 22, hc, w - 24);
    rows.forEach(([id, pts, aces, won], i) => {
      const y = y0 + 64 + i * 22;
      text(ord(i + 1), cx - w / 2 + 30, y, 13, i === 0 ? INK.gold : INK.dim, 'center');
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 54, y - 4, 5);
      ctx.fill();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 66, y, 14, id === me ? INK.text : INK.muted, w - 180, 'left');
      if (aces) text(aces + (aces === 1 ? ' ace' : ' aces'), cx + w / 2 - 92, y, 11, INK.gold, 'right');
      if (won) text('★' + won, cx + w / 2 - 56, y, 12, INK.gold, 'right');
      text(String(pts), cx + w / 2 - 18, y, 15, INK.text, 'right');
    });
    fitText('next cup in ' + Math.ceil(t.pt / HZ) + ' · five new holes', cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// A ball between two tables: one put down afresh — on a tee, back from the
// water — is drawn where the newer table has it rather than rolled there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || (p.x - q.x) ** 2 + (p.y - q.y) ** 2 > 0.12 * 0.12 || p.sn !== q.sn) return [p.x, p.y];
  return [lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k)];
}

// Your own ball is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh, a ball put back — is taken at once.
let shown = null;
const SNAP = 0.1;
function settle(pos) {
  if (!shown || (pos[0] - shown[0]) ** 2 + (pos[1] - shown[1]) ** 2 > SNAP * SNAP) return (shown = pos.slice());
  const k = per60(0.5);
  for (let i = 0; i < 2; i++) shown[i] += (pos[i] - shown[i]) * k;
  return shown;
}

let myPos = null;      // [x, y]: where your ball is drawn
let myBall = null;     // your ball as the guess has it
function draw(now) {
  const b = agreedAt(now);
  if (!b) {
    flat();
    ctx.fillStyle = INK.hedge;
    ctx.fillRect(0, 0, VW, VH);
    myPos = shown = myBall = null;
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('walking to the green…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a green this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const L = holeOf(t);
  drawCourse(t.lay);
  drawFixtures(t, L, nShown, now);
  const me = myId();
  const ids = bySeat(t);

  // Where every ball is drawn: yours from the guess, the rest from the agreed green.
  const at = new Map();
  for (const id of ids) {
    if (id === me) continue;
    const pos = between(b, id);
    if (pos) at.set(id, pos);
  }
  const m = mineAt(now);
  // A guess already on the next hole while the drawing is still on this one
  // draws your ball from the agreed green for that moment.
  const guessed = !!(m && m.to.p[me] && m.to.lay === t.lay && m.to.ph === t.ph);
  const minePos = guessed ? between(m, me) : between(b, me);
  if (minePos) at.set(me, settle(minePos));
  const dOf = (id) => (id === me && guessed ? m.to.p[me] : t.p[id]);
  myPos = at.get(me) || null;
  myBall = myPos ? dOf(me) : null;
  if (!myPos) shown = null;

  for (const id of ids) {
    const pos = at.get(id), d = dOf(id);
    if (!pos || !inPlay(d)) continue;
    const look = lookOf(id);
    look.colour = SEAT[d.k];
    const last = look.trail[look.trail.length - 1];
    if (!atRest(d) && (!last || (last[0] - pos[0]) ** 2 + (last[1] - pos[1]) ** 2 > 0.00002)) {
      if (last && (last[0] - pos[0]) ** 2 + (last[1] - pos[1]) ** 2 > 0.01) look.trail.length = 0;
      look.trail.push([pos[0], pos[1], now]);
    }
  }
  drawTrails(now);
  // Rivals lining up a putt, faintly; then the balls; then your own line on top.
  for (const id of ids) {
    if (id === me) continue;
    const d = dOf(id), pos = at.get(id);
    if (!pos || !inPlay(d) || !d.am || !atRest(d) || (d.ax === 0 && d.ay === 0)) continue;
    const l = Math.hypot(d.ax, d.ay);
    drawAim(pos[0], pos[1], d.ax / l, d.ay / l, d.pw / 1000, SEAT[d.k], false, now);
  }
  const lead = t.ph !== WAIT && humans(t).length > 1 ? standings(t)[0] : undefined;
  const leadOk = lead !== undefined && t.p[lead].sc > 0;
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos || !inPlay(d)) continue;
    drawBall(pos[0], pos[1], SEAT[d.k], id === me, d.gh > 0 || d.cd > SHOT_GAP, lookOf(id).squash, leadOk && id === lead, !atRest(d));
  }
  if (myPos && myBall && inPlay(myBall) && aim.on && aim.p > 0) {
    drawAim(myPos[0], myPos[1], aim.ux, aim.uy, aim.p, SEAT[myBall.k], true, now);
  }
  // Names over the balls, and a mark over your own when it is ready to putt.
  flat();
  for (const id of ids) {
    const pos = at.get(id), d = dOf(id);
    if (!pos || !inPlay(d)) continue;
    const [X, Y] = P(pos[0], pos[1]);
    const mine = id === me;
    let label = mine ? 'you' : nickOf(id);
    if (mine && myBall && myBall.hk > myBall.sk) label = 'you · queued';
    else if (d.cd > SHOT_GAP) label += ' · wet';
    fitText(label, X + shakeX, Y + shakeY - sc * 0.03 - 4, 10, mine ? '#ffffff' : 'rgba(255,255,255,0.78)', 90);
  }
  if (myPos && myBall && inPlay(myBall) && atRest(myBall) && myBall.cd === 0 && !aim.on && (t.ph === PLAY || t.ph === WAIT)) {
    const [X, Y] = P(myPos[0], myPos[1]);
    const bob = Math.sin(now / 220) * 3;
    ctx.fillStyle = INK.gold;
    ctx.beginPath();
    ctx.moveTo(X + shakeX - 5, Y + shakeY - sc * 0.03 - 22 + bob);
    ctx.lineTo(X + shakeX + 5, Y + shakeY - sc * 0.03 - 22 + bob);
    ctx.lineTo(X + shakeX, Y + shakeY - sc * 0.03 - 15 + bob);
    ctx.closePath();
    ctx.fill();
  }
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawBits();

  // Fished out of the water: the edges of the screen flush blue.
  if (flash > 0.05) {
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    g.addColorStop(0, 'rgba(80,170,255,0)');
    g.addColorStop(1, `rgba(80,170,255,${0.3 * flash})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(t, now, t.ph === WAIT ? bySeat(t) : standings(t));
  drawOverlay(t, now);

  // A pull being dragged: a faint line from where it started to the thumb.
  if (drag && drag.live) {
    flat();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.moveTo(drag.sx, drag.sy); ctx.lineTo(drag.x, drag.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    disc(drag.sx, drag.sy, 4); ctx.fill();
  }
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: [aim x, aim y, strength, putts asked for, lining up].
// A drag pulls back from wherever it lands, like a putter drawn back, and the
// ball runs the other way, harder the further it is pulled; letting go asks
// for a putt. The keys turn the aim, set the strength and putt. A putt goes out
// at once; a change of aim no oftener than AIM_EVERY, because a thumb changes
// it on every move the screen reports, and the clock's ticks share the same
// seat's ceiling on messages.
const AIM_EVERY = 140;
const aim = { ux: 1, uy: 0, p: 0, on: false };
let asked = 0;          // putts this page has asked for
let saidAt = -1e9;
let lastSaid = null;

// The line and strength stay in the hand once the line is put away, so a putt
// asked for while the ball still rolls is struck as it was lined up.
function handNow() {
  return [Math.round(aim.ux * 1000), Math.round(aim.uy * 1000), Math.round(aim.p * 1000), asked, aim.on && aim.p > 0 ? 1 : 0];
}
function sayHand(now, force) {
  const h = handNow(), s = lastSaid;
  if (s && h.every((v, i) => v === s[i])) return;
  const same = s && h[3] === s[3] && h[4] === s[4];
  if (same && !force && now - saidAt < AIM_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A putt: struck once the ball is still, which the green decides.
function putt() {
  aim.on = false;
  keyAim = false;
  if (Math.round(aim.p * 1000) < MIN_PW) { sayHand(performance.now(), true); return; }
  const d = world && world.p[myId()];
  asked = Math.min(SHOT_MAX, Math.max(asked, d ? d.sk : 0) + 1);
  sayHand(performance.now(), true);
}

// Keys are read by where they sit, not what they type, so every layout putts.
const AIM_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
const keys = new Set();
let keyAim = false;
function startKeyAim() {
  if (keyAim) return;
  keyAim = true;
  // The keys start aimed at the cup, at half strength.
  if (world && myPos) {
    const L = holeOf(world);
    const dx = L.cup[0] - myPos[0], dy = L.cup[1] - myPos[1], l = Math.hypot(dx, dy) || 1;
    aim.ux = dx / l; aim.uy = dy / l;
  }
  if (!aim.p) aim.p = 0.45;
  aim.on = true;
}
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (e.repeat) return;
    coarse = false;
    if (!keyAim) { startKeyAim(); sayHand(performance.now(), true); } else putt();
    return;
  }
  if (e.code === 'Escape') { aim.on = false; keyAim = false; sayHand(performance.now(), true); return; }
  if (!AIM_KEYS.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  startKeyAim();
  keys.add(e.code);
});
addEventListener('keyup', (e) => { keys.delete(e.code); });
addEventListener('blur', () => { keys.clear(); drag = null; });

function keysTurn(dt) {
  if (!keyAim || drag) return;
  let turn = 0, more = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) turn -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) turn += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) more += 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) more -= 1;
  // Left turns the line to the left on the screen, whichever way the field lies.
  if (turn) {
    const a = turn * 1.6 * dt, c = Math.cos(a), s = Math.sin(a);
    const ux = aim.ux * c - aim.uy * s, uy = aim.ux * s + aim.uy * c;
    aim.ux = ux; aim.uy = uy;
  }
  if (more) aim.p = clamp(aim.p + more * 0.6 * dt, 0.03, 1);
}

// A drag, from anywhere on the field: a thumb or the mouse, captured, so a
// pull that leaves the frame still lets go where it should.
const DEAD = 12;
let drag = null;   // { id, sx, sy, x, y, live }
const pullSpan = () => clamp(Math.min(VW, VH) * 0.32, 90, 230);

function fromDrag() {
  const dx = drag.sx - drag.x, dy = drag.sy - drag.y, far = Math.hypot(dx, dy);
  if (far < DEAD) { drag.live = false; aim.on = false; return; }
  drag.live = true;
  const [ux, uy] = backDir(dx, dy);
  aim.ux = ux / far; aim.uy = uy / far;
  aim.p = clamp((far - DEAD) / pullSpan(), 0.02, 1);
  aim.on = true;
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (drag) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  keyAim = false;
  drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, live: false };
  aim.on = false;
});
cv.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  fromDrag();
});
function lift(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const was = drag.live;
  drag = null;
  if (was) putt();
  else { aim.on = false; sayHand(performance.now(), true); }
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  aim.on = false;
  sayHand(performance.now(), true);
});

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  keysTurn(frameDt);
  sayHand(now, false);
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a golfer arrives and is put on the tee.
function start() {
  lastSaid = handNow();
  setHand(lastSaid.slice());
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
let stepClockGuessed = false;                // set from a table taken, not yet from a tick
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
