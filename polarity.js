/**
 * @disk     polarity
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Magnet ball for a crowd. Hold to switch your magnet on and pull steel balls in, let go to blast them out the way you face. Every player guards a goal on the rim: steel in a rival's goal scores, steel in yours costs you.
 * @tags     game, party, realtime, physics, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/polarity.png
 */
// polarity.js — magnet ball in lockstep: nobody kicks anything, they pull and
// they blast.
//
// A round arena, a goal for every player cut into its rim, and a few steel
// balls rolling about. Your magnet goes where you steer it. Hold to switch it
// on: every ball near it is drawn in and clings, and the longer you hold the
// more charge builds. Let go and the charge goes off — what clings is fired
// the way you face, what is near is thrown off, and a rival caught close is
// knocked back and loses their hold. Steel in a rival's goal scores for
// whoever fired it last; steel in your own costs you a point. Whoever leads
// has the widest goal, a player who has just conceded surges with a full
// charge for a few seconds, and the last stretch of a round drops an extra
// ball and opens every goal.
//
// Every copy holds the whole arena and moves it only on what comes back round
// the room, so every copy applies the same hands in the same order and holds
// the same balls. Nobody sends where they are, a hit or a goal: a hand is a
// direction to steer, whether the magnet is on, and a count of blasts asked
// for. How fast a magnet moves, how hard it pulls and how often it may blast
// are the table's business, the same arithmetic on the same numbers on every
// machine.
//
// While a player is alone, a bot plays with them. It is a magnet like any
// other, and its hand is a function of the table alone, so it plays the same
// on every copy and says nothing over the wire. When a second player arrives,
// practice runs on for three seconds under a note that says so, and the bot
// leaves before the round is laid out: it never plays in a round.
//
// Your own magnet does not wait for the trip: it is drawn from the agreed
// table played forward by the trip, with your hands already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.floor`, `Math.abs`, `Math.min`, `Math.max` and
// `Math.imul` are fixed by the language to the last bit; `Math.sin` and
// `Math.cos` are not, so where the goals sit on the rim comes from a series
// written out here.

// The sine and cosine of `a`, from their series after bringing `a` within half
// a turn of zero, where twenty terms are far finer than a goal's edge.
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
const HZ = 30;                 // steps of the arena a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own magnet a trip ahead, with your hands in it
const DT = 1 / HZ;
const SUB = 3;                 // pieces a step is cut into, so no ball flies through a magnet
const SDT = DT / SUB;

const CX = 0.5, CY = 0.5;      // the arena's centre, in a field one unit square
const RA = 0.46;               // the arena's radius, to the inside of the rim
const MR = 0.03;               // a magnet's radius
const BR = 0.017;              // a ball's
const M_MASS = 4;              // a magnet weighs this many balls
const M_V = 0.5;               // a magnet's top speed, in field units a second
const M_VCAP = 3;              // the fastest a knocked magnet ever slides
const M_ACC = 7;               // how fast a magnet takes up the speed it is steered to, a second
const STUN_DRAG = 2.2;         // what a knocked magnet loses of its slide, a second
const PULL_SLOW = 0.8;         // a magnet that is on moves this much slower
const LOAD_SLOW = 0.09;        // and this much slower again for every ball clinging to it
const PULL_R = 0.24;           // how far a magnet that is on reaches
const PULL_A = 3.8;            // how hard it pulls at the heart of that reach
const CLING_D = MR + BR + 0.012;  // a ball this near a magnet that is on clings to it
const CLING_K = 0.28;          // how much of the magnet's own motion a clinging ball takes on, a piece
const CH_MAX = HZ;             // a full charge: a second of holding
const CH_MIN_P = 0.35;         // what a blast with no charge at all is worth
// A blast cools for longer than the longest knock it can deal, so nobody can
// keep a rival dead by blasting as fast as the magnet allows.
const CD_STEPS = 16;           // steps after a blast before the magnet comes on again
const STUN_STEPS = 14;         // a magnet caught in a full blast is dead this long
const SURGE_STEPS = 4 * HZ;    // a magnet that has just conceded charges at once this long
const SHOT_V = 1.3;            // how fast a full blast fires what clings
const PULSE_R = 0.2;           // how far a blast throws what does not cling
const PUSH_V = 0.9;
const KNOCK_V = 0.85;          // how hard a blast knocks a rival's magnet
const RECOIL = 0.15;
const B_DECEL = 0.16;          // what the floor takes off a rolling ball, a second
const B_VMAX = 2.0;
const WALL_E = 0.82;           // what the rim gives back
const BALL_E = 0.92;           // what two balls give back to each other
const HIT_E = 0.6;             // what a ball and a magnet give back
const BUMP_E = 0.5;            // what two magnets give back
const RESPAWN_STEPS = Math.round(1.2 * HZ);
const MAX_P = 8;
const MAX_B = 7;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const BLAST_MAX = 1e9;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const ROUND_STEPS = 90 * HZ;
const RUSH_STEPS = 25 * HZ;    // the last stretch of a round: an extra ball, and every goal opens
const END_STEPS = 7 * HZ;

// How many balls roll for so many magnets.
const ballsFor = (n) => Math.min(6, 2 + Math.floor(n / 2));

// ── the table ──────────────────────────────────────────────────────────────
//   rng: the draws; ph, pt: the phase and the steps left in it (in practice,
//   the count after a second player arrives, 0 for none); rd: rounds begun;
//   b: the balls; p: the magnets by id; res: the last round's [id, points,
//   goals, rounds won] rows; win: its winner, or -1 for a tie
function freshTable(seed) {
  const t = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, b: [], p: {}, res: null, win: -1 };
  return t;
}

const FIELDS = ['k', 'x', 'y', 'vx', 'vy', 'ax', 'ay', 'dx', 'dy', 'h', 'bk', 'bs', 'ch', 'cd', 'st', 'rg',
  'sc', 'gl', 'wn', 'bw', 'hs', 'hc'];
//   k: seat, which is its colour and where its goal sits; x, y, vx, vy: the
//   magnet; ax, ay: the way it faces, a unit vector; dx, dy, h, bk: the hand —
//   the way it is steered in thousandths, whether it is on, and how many
//   blasts it has asked for; bs: how many of those went off or were let go;
//   ch: charge in steps; cd: steps before it may come on again; st: steps it
//   stays knocked dead; rg: steps of its surge; sc: points this round; gl:
//   goals this round; wn: rounds won; bw: the bot's pause; hs, hc: hands this
//   step.
function magnet(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}
const BFIELDS = ['x', 'y', 'vx', 'vy', 'lt', 'rs'];
//   x, y, vx, vy: the ball; lt: whose magnet last held or blasted it, 0 for
//   nobody's; rs: steps before it rolls back in from the middle, 0 while in play
function steel(v) {
  const b = {};
  for (const f of BFIELDS) b[f] = v[f];
  return b;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const sorted = (w) => playersIn(w).sort((a, b) => a - b);
const bySeat = (w) => sorted(w).sort((a, b) => w.p[a].k - w.p[b].k);

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// Where the goals sit: one for every magnet, round the rim in seat order, the
// first on the left. A goal is a direction from the centre and the half-angle
// it is open by: wider for whoever leads, by how far they lead, and wider for
// everybody in the last stretch of a round.
function goalsOf(w) {
  const ids = bySeat(w);
  const n = ids.length;
  if (!n) return [];
  let lo = Infinity;
  for (const id of ids) lo = Math.min(lo, w.p[id].sc);
  const sector = Math.PI / n;
  const base = Math.min(0.27, sector * 0.34);
  const rush = w.ph === PLAY && w.pt <= RUSH_STEPS ? 1.2 : 1;
  return ids.map((id, i) => {
    const [s, c] = sincos(Math.PI + (2 * Math.PI * i) / n);
    const lead = clamp(1 + 0.1 * (w.p[id].sc - lo), 1, 1.5);
    const half = Math.min(sector * 0.9, base * lead * rush);
    return { id, gx: c, gy: s, half, cos: sincos(half)[1] };
  });
}

// Whose goal a direction from the centre runs into, or null for the rim.
function goalAt(goals, ux, uy) {
  for (const g of goals) if (ux * g.gx + uy * g.gy >= g.cos) return g.id;
  return null;
}

// A magnet's place in front of its own goal, facing in.
function spotOf(goals, id) {
  const g = goals.find((q) => q.id === id);
  if (!g) return [CX, CY, 1, 0];
  return [CX + g.gx * RA * 0.68, CY + g.gy * RA * 0.68, -g.gx, -g.gy];
}

function setDown(d, x, y, ax, ay) {
  d.x = x; d.y = y; d.vx = 0; d.vy = 0; d.ax = ax; d.ay = ay;
  d.ch = 0; d.cd = 0; d.st = 0; d.rg = 0; d.bs = d.bk;
}

function newMagnet(w, id, blasts) {
  const d = (w.p[id] = magnet({
    k: freeSeat(w), x: CX, y: CY, vx: 0, vy: 0, ax: 1, ay: 0, dx: 0, dy: 0, h: 0, bk: blasts, bs: blasts,
    ch: 0, cd: 0, st: 0, rg: 0, sc: 0, gl: 0, wn: 0, bw: 0, hs: w.n, hc: 0,
  }));
  const [x, y, ax, ay] = spotOf(goalsOf(w), id);
  setDown(d, x, y, ax, ay);
  fx(w, 'spawn', d.x, d.y, id);
  return d;
}

// A hand, at its place in the room's order: [steer x, steer y, on, blasts
// asked for]. Being heard is how a player arrives, and their magnet is put
// down in front of their goal — with every blast they asked for before
// counted as let go, so a page that comes back fires nothing it asked for
// while away.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = newMagnet(w, id, input[3]);
  }
  // A flood of hands in one step is cut off where no player's thumb could
  // reach, on every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.dx = input[0];
  d.dy = input[1];
  d.h = input[2];
  d.bk = input[3];
}

// A hand off the wire, made safe: four integers in their ranges, or nothing.
// How fast a magnet goes is the table's business: a steer names a share of
// the top speed, and nothing a hand says makes it more than all of it.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  if (!raw.every(Number.isInteger)) return null;
  const [dx, dy, h, k] = raw;
  if (dx < -1000 || dx > 1000 || dy < -1000 || dy > 1000 || h < 0 || h > 1 || k < 0 || k > BLAST_MAX) return null;
  return [dx, dy, h, k];
}

function leave(w, id) {
  delete w.p[id];
  for (const b of w.b) if (b.lt === id) b.lt = 0;
}

// The bot plays practice and is never in a round.
const BOT_ID = -100;
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// ── the round ──────────────────────────────────────────────────────────────

// The balls of a fresh round: in a small ring round the middle, still.
function rackBalls(w, n) {
  w.b = [];
  for (let i = 0; i < n; i++) {
    const [s, c] = sincos((TAU * i) / n + 0.3);
    w.b.push(steel({ x: CX + c * 0.06, y: CY + s * 0.06, vx: 0, vy: 0, lt: 0, rs: 0 }));
  }
}

// In practice the number of balls follows the number of magnets: one that
// comes is rolled in from the middle, one too many is taken off the end.
function fitBalls(w) {
  const want = ballsFor(playersIn(w).length);
  while (w.b.length < want) w.b.push(steel({ x: CX, y: CY, vx: 0, vy: 0, lt: 0, rs: RESPAWN_STEPS }));
  while (w.b.length > want) w.b.pop();
}

function placeAll(w) {
  const goals = goalsOf(w);
  for (const id of playersIn(w)) {
    const [x, y, ax, ay] = spotOf(goals, id);
    setDown(w.p[id], x, y, ax, ay);
  }
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  fitBalls(w);
}

function beginRound(w) {
  w.rd += 1;
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.res = null;
  w.win = -1;
  for (const id of playersIn(w)) { const d = w.p[id]; d.sc = 0; d.gl = 0; }
  placeAll(w);
  rackBalls(w, ballsFor(playersIn(w).length));
  fx(w, 'round');
}

// The last stretch: one more ball rolls in from the middle.
function rush(w) {
  if (w.b.length < MAX_B) w.b.push(steel({ x: CX, y: CY, vx: 0, vy: 0, lt: 0, rs: 1 }));
  fx(w, 'rush');
}

function standings(w) {
  return sorted(w).sort((a, b) => {
    const A = w.p[a], B = w.p[b];
    return B.sc - A.sc || B.gl - A.gl || a - b;
  });
}

function endRound(w) {
  const order = standings(w);
  const first = order[0], second = order[1];
  const A = first !== undefined ? w.p[first] : null, B = second !== undefined ? w.p[second] : null;
  // Level on points and goals at the top is a tie, and nobody takes the round.
  const tie = !A || (B && A.sc === B.sc && A.gl === B.gl);
  if (!tie) A.wn += 1;
  w.win = tie ? -1 : first;
  w.res = order.map((id) => { const d = w.p[id]; return [id, d.sc, d.gl, d.wn]; });
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, w.win);
}

// ── a magnet's own step ────────────────────────────────────────────────────

const isOn = (d) => d.h === 1 && d.cd === 0 && d.st === 0;

// The balls clinging to a magnet, in the order they lie in the table.
function clinging(w, d) {
  const out = [];
  for (const b of w.b) {
    if (b.rs) continue;
    const dx = b.x - d.x, dy = b.y - d.y;
    if (dx * dx + dy * dy <= (CLING_D + 0.01) * (CLING_D + 0.01)) out.push(b);
  }
  return out;
}

// A blast: what clings is fired the way the magnet faces, side by side in
// front of it; whatever else is near is thrown off; a rival's magnet caught
// close is knocked back and dies for a moment, letting go of what it held.
function blast(w, id, d) {
  const p = d.rg > 0 ? 1 : CH_MIN_P + ((1 - CH_MIN_P) * d.ch) / CH_MAX;
  const held = clinging(w, d);
  const nx = -d.ay, ny = d.ax;
  held.forEach((b, i) => {
    const side = (i - (held.length - 1) / 2) * (2 * BR + 0.003);
    b.x = d.x + d.ax * (MR + BR + 0.006) + nx * side;
    b.y = d.y + d.ay * (MR + BR + 0.006) + ny * side;
    b.vx = d.ax * SHOT_V * p + d.vx * 0.5;
    b.vy = d.ay * SHOT_V * p + d.vy * 0.5;
    b.lt = id;
  });
  for (const b of w.b) {
    if (b.rs || held.includes(b)) continue;
    const dx = b.x - d.x, dy = b.y - d.y, dd = Math.sqrt(dx * dx + dy * dy);
    if (dd >= PULSE_R || dd < 1e-9) continue;
    const k = (PUSH_V * p * (1 - dd / PULSE_R)) / dd;
    b.vx += dx * k; b.vy += dy * k;
    b.lt = id;
  }
  for (const o of sorted(w)) {
    if (o === id) continue;
    const e = w.p[o];
    const dx = e.x - d.x, dy = e.y - d.y, dd = Math.sqrt(dx * dx + dy * dy), R = PULSE_R + MR;
    if (dd >= R || dd < 1e-9) continue;
    const k = (KNOCK_V * p * (1 - dd / R)) / dd;
    e.vx += dx * k; e.vy += dy * k;
    e.st = Math.max(e.st, Math.round(STUN_STEPS * p));
    e.ch = 0;
    fx(w, 'knock', e.x, e.y, o, id);
  }
  d.vx -= d.ax * RECOIL * p;
  d.vy -= d.ay * RECOIL * p;
  d.cd = CD_STEPS;
  d.ch = 0;
  fx(w, 'blast', d.x, d.y, id, Math.round(p * 1000), held.length);
}

// The timers, the way it faces, a blast asked for, and the charge.
function control(w, id, d) {
  if (d.cd > 0) d.cd -= 1;
  if (d.st > 0) d.st -= 1;
  if (d.rg > 0) d.rg -= 1;
  const l = Math.sqrt(d.dx * d.dx + d.dy * d.dy);
  if (l > 250) { d.ax = d.dx / l; d.ay = d.dy / l; }
  if (d.bk > d.bs) {
    // However many were asked for, one goes off, and only once the magnet may.
    d.bs = d.bk;
    if (d.cd === 0 && d.st === 0) blast(w, id, d);
  }
  if (isOn(d)) d.ch = d.rg > 0 ? CH_MAX : Math.min(CH_MAX, d.ch + 1);
  else if (!d.h) d.ch = Math.max(0, d.ch - 2);
}

// One piece of a step for a magnet: steered toward the speed its hand names,
// slower while it is on and slower again under load; a knocked magnet only
// slides. The rim holds it in, goal mouths included.
function moveMagnet(d, load) {
  if (d.st > 0) {
    const k = Math.max(0, 1 - STUN_DRAG * SDT);
    d.vx *= k; d.vy *= k;
  } else {
    let wx = d.dx / 1000, wy = d.dy / 1000;
    const wl = Math.sqrt(wx * wx + wy * wy);
    if (wl > 1) { wx /= wl; wy /= wl; }
    const top = M_V * (isOn(d) ? PULL_SLOW : 1) * Math.max(0.5, 1 - LOAD_SLOW * load);
    const k = Math.min(1, M_ACC * SDT);
    d.vx += (wx * top - d.vx) * k;
    d.vy += (wy * top - d.vy) * k;
  }
  // However many blasts land on one magnet at once, it never flies faster than this.
  const sp = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
  if (sp > M_VCAP) { d.vx *= M_VCAP / sp; d.vy *= M_VCAP / sp; }
  d.x += d.vx * SDT;
  d.y += d.vy * SDT;
  const rx = d.x - CX, ry = d.y - CY, r = Math.sqrt(rx * rx + ry * ry), lim = RA - MR;
  if (r > lim) {
    const ux = rx / r, uy = ry / r;
    d.x = CX + ux * lim; d.y = CY + uy * lim;
    const vn = d.vx * ux + d.vy * uy;
    if (vn > 0) { d.vx -= ux * vn * 1.5; d.vy -= uy * vn * 1.5; }
  }
}

// What every magnet that is on does to every ball in its reach: draws it in,
// harder nearer, and holds one that has reached it, carrying it along.
function pull(w, ids) {
  for (const id of ids) {
    const d = w.p[id];
    if (!isOn(d)) continue;
    const strength = d.rg > 0 ? 1.3 : 1;
    for (const b of w.b) {
      if (b.rs) continue;
      const dx = d.x - b.x, dy = d.y - b.y, dd = Math.sqrt(dx * dx + dy * dy);
      if (dd >= PULL_R || dd < 1e-9) continue;
      const a = (PULL_A * strength * (1 - dd / PULL_R) * SDT) / dd;
      b.vx += dx * a; b.vy += dy * a;
      if (dd < CLING_D) {
        b.vx += (d.vx - b.vx) * CLING_K;
        b.vy += (d.vy - b.vy) * CLING_K;
        if (b.lt !== id) { b.lt = id; fx(w, 'grab', b.x, b.y, id); }
      }
    }
  }
}

// One piece of a step for a ball: the floor slows it, it rolls, and at the
// rim it either bounces or, in a goal's mouth, goes in.
function roll(w, goals, b) {
  const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy), dec = B_DECEL * SDT;
  if (sp <= dec) { b.vx = 0; b.vy = 0; }
  else {
    const keep = ((sp - dec) / sp) * (sp > B_VMAX ? B_VMAX / sp : 1);
    b.vx *= keep; b.vy *= keep;
    b.x += b.vx * SDT;
    b.y += b.vy * SDT;
  }
  const rx = b.x - CX, ry = b.y - CY, r = Math.sqrt(rx * rx + ry * ry);
  if (r <= RA - BR) return;
  const ux = rx / r, uy = ry / r;
  const owner = goalAt(goals, ux, uy);
  if (owner !== null) {
    if (r > RA + 1.5 * BR) score(w, b, owner);
    return;
  }
  b.x = CX + ux * (RA - BR); b.y = CY + uy * (RA - BR);
  const vn = b.vx * ux + b.vy * uy;
  if (vn > 0) {
    b.vx -= ux * vn * (1 + WALL_E); b.vy -= uy * vn * (1 + WALL_E);
    if (vn > 0.25) fx(w, 'rim', b.x, b.y, b.lt, Math.round(vn * 1000));
  }
}

// Steel in a goal. Its owner pays a point and surges; whoever fired or held it
// last scores, unless that was the owner. The ball rolls back in from the
// middle a moment later.
function score(w, b, owner) {
  const o = w.p[owner];
  const by = b.lt !== 0 && b.lt !== owner && w.p[b.lt] ? b.lt : 0;
  fx(w, 'goal', b.x, b.y, owner, by);
  if (o) { o.sc -= 1; o.rg = SURGE_STEPS; }
  if (by) { w.p[by].sc += 1; w.p[by].gl += 1; }
  b.x = CX; b.y = CY; b.vx = 0; b.vy = 0; b.lt = 0;
  b.rs = RESPAWN_STEPS;
}

// Things that touch push apart and trade what they were closing at, by weight.
function collide(w, ids) {
  const bs = w.b;
  for (let i = 0; i < bs.length; i++) {
    const A = bs[i];
    if (A.rs) continue;
    for (let j = i + 1; j < bs.length; j++) {
      const B = bs[j];
      if (B.rs) continue;
      const dx = B.x - A.x, dy = B.y - A.y, dd = dx * dx + dy * dy;
      if (dd >= 4 * BR * BR || dd < 1e-14) continue;
      const dist = Math.sqrt(dd), nx = dx / dist, ny = dy / dist, push = (2 * BR - dist) / 2;
      A.x -= nx * push; A.y -= ny * push;
      B.x += nx * push; B.y += ny * push;
      const rv = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
      if (rv >= 0) continue;
      const jn = (-(1 + BALL_E) * rv) / 2;
      A.vx -= nx * jn; A.vy -= ny * jn;
      B.vx += nx * jn; B.vy += ny * jn;
      if (-rv > 0.2) fx(w, 'click', (A.x + B.x) / 2, (A.y + B.y) / 2, 0, 0, Math.round(-rv * 1000));
    }
  }
  for (const id of ids) {
    const m = w.p[id];
    for (const b of bs) {
      if (b.rs) continue;
      const dx = b.x - m.x, dy = b.y - m.y, dd = dx * dx + dy * dy, R = BR + MR;
      if (dd >= R * R || dd < 1e-14) continue;
      const dist = Math.sqrt(dd), nx = dx / dist, ny = dy / dist, over = R - dist;
      b.x += (nx * over * M_MASS) / (1 + M_MASS); b.y += (ny * over * M_MASS) / (1 + M_MASS);
      m.x -= (nx * over) / (1 + M_MASS); m.y -= (ny * over) / (1 + M_MASS);
      const rv = (b.vx - m.vx) * nx + (b.vy - m.vy) * ny;
      if (rv >= 0) continue;
      const jn = (-(1 + HIT_E) * rv) / (1 + 1 / M_MASS);
      b.vx += nx * jn; b.vy += ny * jn;
      m.vx -= (nx * jn) / M_MASS; m.vy -= (ny * jn) / M_MASS;
      if (-rv > 0.35) fx(w, 'clink', b.x, b.y, id, 0, Math.round(-rv * 1000));
    }
  }
  for (let i = 0; i < ids.length; i++) {
    const A = w.p[ids[i]];
    for (let j = i + 1; j < ids.length; j++) {
      const B = w.p[ids[j]];
      const dx = B.x - A.x, dy = B.y - A.y, dd = dx * dx + dy * dy;
      if (dd >= 4 * MR * MR || dd < 1e-14) continue;
      const dist = Math.sqrt(dd), nx = dx / dist, ny = dy / dist, push = (2 * MR - dist) / 2;
      A.x -= nx * push; A.y -= ny * push;
      B.x += nx * push; B.y += ny * push;
      const rv = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
      if (rv >= 0) continue;
      const jn = (-(1 + BUMP_E) * rv) / 2;
      A.vx -= nx * jn; A.vy -= ny * jn;
      B.vx += nx * jn; B.vy += ny * jn;
      if (-rv > 0.2) fx(w, 'bump', (A.x + B.x) / 2, (A.y + B.y) / 2, ids[i], ids[j], Math.round(-rv * 1000));
    }
  }
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_PACE = 780;          // the bot steers at this share of the top speed

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && Object.keys(w.p).length < MAX_P) newMagnet(w, BOT_ID, 0);
  else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

function steerTo(d, tx, ty, pace) {
  const dx = tx - d.x, dy = ty - d.y, l = Math.sqrt(dx * dx + dy * dy);
  if (l < 0.008) { d.dx = 0; d.dy = 0; return l; }
  const k = (pace * Math.min(1, l / 0.05)) / l;
  d.dx = clamp(Math.round(dx * k), -1000, 1000);
  d.dy = clamp(Math.round(dy * k), -1000, 1000);
  return l;
}

// The bot's mind, a function of the table alone: with steel in hand and some
// charge, it runs at the nearest rival goal and lets go once it faces it,
// a little off now and then; a ball rolling at its own goal it goes after
// and catches; otherwise it hunts the nearest loose ball and switches on as
// it comes within reach. Every so often it stands and thinks.
function botHand(w, goals) {
  const d = w.p[BOT_ID];
  if (!d || w.n % BOT_EVERY) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (draw01(w) < 0.04) { d.bw = 3 + Math.floor(draw01(w) * 6); d.dx = 0; d.dy = 0; return; }
  const mine = goals.find((g) => g.id === BOT_ID);
  const held = clinging(w, d).length;
  if (held > 0 && d.h) {
    let best = null, bd = Infinity;
    for (const g of goals) {
      if (g.id === BOT_ID) continue;
      const tx = CX + g.gx * RA, ty = CY + g.gy * RA, q = (tx - d.x) * (tx - d.x) + (ty - d.y) * (ty - d.y);
      if (q < bd) { bd = q; best = [tx, ty]; }
    }
    if (!best) return;
    const far = steerTo(d, best[0], best[1], BOT_PACE);
    const fxv = (best[0] - d.x) / (far || 1), fyv = (best[1] - d.y) / (far || 1);
    if (d.ch >= 14 && far < 0.4 && d.ax * fxv + d.ay * fyv > 0.92) {
      // A miss: the way it faces swung a little as it lets go.
      if (draw01(w) < 0.3) { const [ux, uy] = turned(d.ax, d.ay, (draw01(w) - 0.5) * 0.7); d.ax = ux; d.ay = uy; }
      d.h = 0;
      d.bk = Math.min(BLAST_MAX, d.bk + 1);
    }
    return;
  }
  let target = null, td = Infinity;
  if (mine) {
    const gx = CX + mine.gx * RA, gy = CY + mine.gy * RA;
    for (const b of w.b) {
      if (b.rs) continue;
      const q = (b.x - gx) * (b.x - gx) + (b.y - gy) * (b.y - gy);
      const toward = b.vx * mine.gx + b.vy * mine.gy;
      if (q < 0.35 * 0.35 && toward > 0.15 && q < td) { td = q; target = b; }
    }
  }
  if (!target) {
    for (const b of w.b) {
      if (b.rs) continue;
      const q = (b.x - d.x) * (b.x - d.x) + (b.y - d.y) * (b.y - d.y);
      if (q < td) { td = q; target = b; }
    }
  }
  if (!target) { steerTo(d, CX, CY, BOT_PACE * 0.6); d.h = 0; return; }
  const far = steerTo(d, target.x, target.y, BOT_PACE);
  d.h = far < PULL_R * 0.75 ? 1 : 0;
}

// One step of the arena: a function of the arena alone.
function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting table otherwise leaves at zero. The bot goes first, so
    // the round is laid out without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); beginRound(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = ROUND_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === RUSH_STEPS) rush(w);
      if (w.pt <= 0) endRound(w);
    } else if (w.pt <= 0) {
      beginRound(w);
    }
  }
  if (w.ph === WAIT) fitBalls(w);

  const ids = sorted(w);
  if (w.ph !== WAIT && w.ph !== PLAY) {
    // Laid out or scored: everything stands, and a blast asked for meanwhile
    // is let go rather than kept for the start.
    for (const id of ids) { const d = w.p[id]; d.bs = d.bk; d.ch = 0; }
    return;
  }
  const goals = goalsOf(w);
  botHand(w, goals);
  for (const id of ids) control(w, id, w.p[id]);
  const loads = ids.map((id) => (isOn(w.p[id]) ? clinging(w, w.p[id]).length : 0));
  for (let s = 0; s < SUB; s++) {
    ids.forEach((id, i) => moveMagnet(w.p[id], loads[i]));
    pull(w, ids);
    for (const b of w.b) if (!b.rs) roll(w, goals, b);
    collide(w, ids);
  }
  for (const b of w.b) {
    if (!b.rs) continue;
    b.rs -= 1;
    if (b.rs === 0) {
      // Rolled back in from the middle, in a direction of the draw's choosing.
      const [s, c] = sincos(draw01(w) * TAU);
      b.x = CX; b.y = CY; b.vx = c * 0.12; b.vy = s * 0.12; b.lt = 0;
      fx(w, 'drop', b.x, b.y);
    }
  }
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, ROUND_STEPS)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.k, 0, MAX_P - 1) || seats.has(d.k)) return null;
    if (!num(d.x, -1, 2) || !num(d.y, -1, 2) || !num(d.vx, -9, 9) || !num(d.vy, -9, 9)) return null;
    if (!num(d.ax, -1.01, 1.01) || !num(d.ay, -1.01, 1.01)) return null;
    if (inputOf([d.dx, d.dy, d.h, d.bk]) === null || !int(d.bs, 0, BLAST_MAX)) return null;
    if (!int(d.ch, 0, CH_MAX) || !int(d.cd, 0, CD_STEPS) || !int(d.st, 0, STUN_STEPS) || !int(d.rg, 0, SURGE_STEPS)) return null;
    if (!int(d.sc, -99999, 99999) || !int(d.gl, 0, 99999) || !int(d.wn, 0, 99999) || !int(d.bw, 0, 99)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    seats.add(d.k);
    p[id] = magnet(d);
  }
  if (!Array.isArray(raw.b) || raw.b.length > MAX_B) return null;
  const b = [];
  for (const q of raw.b) {
    if (!q || typeof q !== 'object') return null;
    if (!num(q.x, -1, 2) || !num(q.y, -1, 2) || !num(q.vx, -9, 9) || !num(q.vy, -9, 9)) return null;
    if (!int(q.lt, -BIG, BIG) || !int(q.rs, 0, RESPAWN_STEPS)) return null;
    b.push(steel(q));
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
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, b, p, res, win: raw.win };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a physics lab after hours — a deep blue-violet floor, a dark
// steel arena ringed in brushed metal, silver balls, and a bright colour for
// each seat that is its magnet's, its goal's and its chip's.
const INK = {
  bg: '#15132b', bgHi: '#1d1a3a', grid: 'rgba(140,130,255,0.07)', floor: '#1f2442', floorHi: '#283056',
  ring: 'rgba(160,180,255,0.08)', rim: '#9aa6c8', rimHi: '#e3e9ff', rimDark: '#4a5373', text: '#f5f3ff',
  muted: '#cfd0ec', dim: '#9a9cc4', gold: '#ffd166', danger: '#ff5a6e', panel: 'rgba(16,14,36,0.93)',
  steel: '#c9d0e0', steelHi: '#ffffff', steelLo: '#5c6480',
};
const SEAT = ['#ff5d73', '#3ec1d3', '#ffd23f', '#9b7bff', '#ff9f43', '#5bd17a', '#f5f5f5', '#ff7ad9'];
const FONT = "600 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.bg};touch-action:none;` +
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a4a86;' +
  `background:#1d1a3a;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 480, sc = 1, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1;
let fieldBox = [0, 0, 0, 0];   // left, top, right, bottom on the screen
// NOTE_ROOM under the field keeps the practice note off the goal at the foot
// of the arena.
const NOTE_ROOM = 60;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 480;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  bg.width = cv.width;
  bg.height = cv.height;
  bgKey = '';
  dpx = dpr;
  TOP = VW < 420 ? 66 : 58;
  BOT = 26;
  const aw = VW - 16, ah = Math.max(60, VH - TOP - BOT - NOTE_ROOM);
  sc = Math.max(10, Math.min(aw, ah));
  ox = (VW - sc) / 2;
  oy = TOP + (ah - sc) / 2;
  fieldBox = [ox, oy, ox + sc, oy + sc];
}
layout();
window.addEventListener('resize', layout);

const P = (x, y) => [ox + x * sc, oy + y * sc];
function fieldOn(c, sx, sy) { c.setTransform(dpx * sc, 0, 0, dpx * sc, dpx * (ox + sx), dpx * (oy + sy)); }
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
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Easing per frame, scaled to the frame's length so a fast screen and a slow
// one settle at the same pace.
let frameDt = 1 / 60, lastFrame = 0;
const per60 = (k) => 1 - Math.pow(1 - k, frameDt * 60);
const ease = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
const lerp = (a, b, k) => a + (b - a) * k;

// ── the floor, painted once a size ─────────────────────────────────────────
function paintFloor() {
  const c = bgx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  const g0 = c.createLinearGradient(0, 0, 0, bg.height);
  g0.addColorStop(0, INK.bgHi);
  g0.addColorStop(1, INK.bg);
  c.fillStyle = g0;
  c.fillRect(0, 0, bg.width, bg.height);
  // A faint grid of dots across the whole lab floor.
  c.fillStyle = INK.grid;
  const step = 22 * dpx;
  for (let y = step / 2; y < bg.height; y += step) for (let x = step / 2; x < bg.width; x += step) c.fillRect(x, y, 2 * dpx, 2 * dpx);
  fieldOn(c, 0, 0);
  // The arena: a disc of dark steel with rings turned into it, a shadow under its rim.
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.beginPath(); c.arc(CX + 0.006, CY + 0.012, RA + 0.03, 0, TAU); c.fill();
  const g = c.createRadialGradient(CX - 0.1, CY - 0.12, 0.02, CX, CY, RA);
  g.addColorStop(0, INK.floorHi);
  g.addColorStop(1, INK.floor);
  c.fillStyle = g;
  c.beginPath(); c.arc(CX, CY, RA + 0.012, 0, TAU); c.fill();
  c.strokeStyle = INK.ring;
  c.lineWidth = 0.002;
  for (let r = 0.06; r < RA; r += 0.06) { c.beginPath(); c.arc(CX, CY, r, 0, TAU); c.stroke(); }
  c.beginPath(); c.moveTo(CX - RA, CY); c.lineTo(CX + RA, CY); c.moveTo(CX, CY - RA); c.lineTo(CX, CY + RA); c.stroke();
  // The middle, where balls roll back in.
  c.strokeStyle = 'rgba(200,210,255,0.16)';
  c.lineWidth = 0.003;
  c.setLineDash([0.008, 0.008]);
  c.beginPath(); c.arc(CX, CY, 0.035, 0, TAU); c.stroke();
  c.setLineDash([]);
}

function drawFloor() {
  const key = VW + 'x' + VH + ':' + dpx;
  if (key !== bgKey) { paintFloor(); bgKey = key; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bg, Math.round(shakeX * dpx), Math.round(shakeY * dpx));
}

// The rim, and every goal cut into it: a pocket in its owner's colour, its
// mouth lit, and a flash when steel goes in. A direction is drawn by angle
// here, which is only the drawing's business.
const goalLit = new Map();     // owner id -> brightness
function drawRim(t, goals, now) {
  inField();
  ctx.lineCap = 'butt';
  for (const g of goals) {
    const a = Math.atan2(g.gy, g.gx), lit = goalLit.get(g.id) || 0;
    const col = t.p[g.id] ? SEAT[t.p[g.id].k] : '#888888';
    ctx.strokeStyle = alpha(col, 0.18 + lit * 0.4);
    ctx.lineWidth = 0.05;
    ctx.beginPath(); ctx.arc(CX, CY, RA + 0.03, a - g.half, a + g.half); ctx.stroke();
    // The net: a few strands across the pocket.
    ctx.strokeStyle = alpha(col, 0.35 + lit * 0.4);
    ctx.lineWidth = 0.002;
    for (let i = -3; i <= 3; i++) {
      const q = a + (g.half * i) / 3.5, cq = Math.cos(q), sq = Math.sin(q);
      ctx.beginPath(); ctx.moveTo(CX + cq * RA, CY + sq * RA); ctx.lineTo(CX + cq * (RA + 0.052), CY + sq * (RA + 0.052)); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(CX, CY, RA + 0.054, a - g.half, a + g.half); ctx.stroke();
  }
  // The rim between the goals: brushed metal, a dark under-edge and a lit top.
  const spans = goals.map((g) => { const a = Math.atan2(g.gy, g.gx); return [a - g.half, a + g.half]; }).sort((p, q) => p[0] - q[0]);
  const rimArc = (from, to) => { ctx.beginPath(); ctx.arc(CX, CY, RA + 0.008, from, to); ctx.stroke(); };
  for (const [w, colour] of [[0.022, INK.rimDark], [0.014, INK.rim], [0.004, INK.rimHi]]) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = w;
    if (!spans.length) { rimArc(0, TAU); continue; }
    for (let i = 0; i < spans.length; i++) {
      const end = spans[i][1], next = i + 1 < spans.length ? spans[i + 1][0] : spans[0][0] + TAU;
      if (next > end) rimArc(end, next);
    }
  }
  // Each goal's mouth: a bright line in its owner's colour, posts at its ends.
  for (const g of goals) {
    const a = Math.atan2(g.gy, g.gx), lit = goalLit.get(g.id) || 0;
    const col = t.p[g.id] ? SEAT[t.p[g.id].k] : '#888888';
    ctx.strokeStyle = lit > 0.05 ? lighter(col, lit * 0.7) : col;
    ctx.lineWidth = 0.005 + lit * 0.006;
    ctx.setLineDash([0.012, 0.008]);
    ctx.lineDashOffset = -(now / 1000) * 0.03;
    ctx.beginPath(); ctx.arc(CX, CY, RA + 0.004, a - g.half, a + g.half); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    for (const e of [a - g.half, a + g.half]) {
      ctx.fillStyle = INK.rimHi;
      disc(CX + Math.cos(e) * (RA + 0.008), CY + Math.sin(e) * (RA + 0.008), 0.009); ctx.fill();
      ctx.fillStyle = col;
      disc(CX + Math.cos(e) * (RA + 0.008), CY + Math.sin(e) * (RA + 0.008), 0.005); ctx.fill();
    }
  }
}

// Under each goal, outside the rim, whose it is.
function drawGoalNames(t, goals) {
  flat();
  const me = myId();
  for (const g of goals) {
    const d = t.p[g.id];
    if (!d) continue;
    const [X, Y] = P(CX + g.gx * (RA + 0.08), CY + g.gy * (RA + 0.08));
    const label = g.id === me ? 'your goal' : nickOf(g.id);
    // Kept inside the field's own box, clear of the board above it and the
    // note below it.
    fitText(label, clamp(X, 44, VW - 44) + shakeX, clamp(Y + 4, fieldBox[1] + 12, fieldBox[3] - 2) + shakeY, 11,
      g.id === me ? INK.text : alpha(SEAT[d.k], 0.95), 86);
  }
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
  on() { if (ready('on', 120)) { tone(140, 0.18, 'sawtooth', 0.035, 2.2); tone(70, 0.2, 'sine', 0.06, 1.5); } },
  grab(mine) { if (ready('grab', 70)) { tone(1500, 0.04, 'square', mine ? 0.05 : 0.018, 0.7); tone(900, 0.06, 'triangle', mine ? 0.05 : 0.02, 1.2, 0.01); } },
  blast(mine, p) {
    if (!ready('blast', 60)) return;
    puff(0.25 + p * 0.2, (mine ? 0.28 : 0.1) * (0.5 + p * 0.5), 600 + p * 900, 0, 0.8, 'lowpass');
    tone(220 + p * 180, 0.22, 'sawtooth', mine ? 0.07 : 0.025, 0.3);
    tone(90, 0.25, 'sine', mine ? 0.12 : 0.04, 0.5);
  },
  knock(mine) { if (ready('knock', 120)) { tone(180, 0.2, 'square', mine ? 0.08 : 0.03, 0.4); puff(0.12, mine ? 0.15 : 0.05, 400, 0, 1); } },
  click(k) { if (ready('click', 45)) { tone(2400, 0.035, 'square', 0.03 * Math.min(1, 0.3 + k), 0.7); tone(3400, 0.03, 'triangle', 0.02, 0.8, 0.004); } },
  clink(mine, k) { if (ready('clink', 55)) tone(1100, 0.07, 'triangle', (mine ? 0.08 : 0.03) * Math.min(1, 0.4 + k), 0.6); },
  rim(k) { if (ready('rim', 60)) { tone(420, 0.12, 'triangle', 0.05 * Math.min(1, 0.3 + k), 0.7); tone(1260, 0.08, 'sine', 0.025 * Math.min(1, 0.3 + k), 0.9, 0.005); } },
  bump() { if (ready('bump', 100)) { tone(110, 0.12, 'triangle', 0.07, 0.6); puff(0.06, 0.06, 300, 0, 1); } },
  scored() { if (ready('scored', 250)) [659, 784, 988, 1319].forEach((f, i) => tone(f, 0.2, 'triangle', 0.08, 0, i * 0.07)); },
  conceded() { if (ready('conceded', 250)) { [392, 311, 233].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.045, 0, i * 0.09)); puff(0.3, 0.1, 300, 0, 0.8, 'lowpass'); } },
  goal() { if (ready('goal', 150)) { puff(0.2, 0.08, 1800, 0, 1.5); tone(523, 0.14, 'triangle', 0.04, 1.5); } },
  drop() { if (ready('drop', 200)) tone(880, 0.1, 'sine', 0.03, 1.3); },
  beep() { if (ready('beep', 200)) tone(440, 0.16, 'square', 0.06); },
  go() { if (ready('go', 300)) { tone(880, 0.3, 'square', 0.07); tone(1760, 0.26, 'sine', 0.04, 1.0, 0.05); } },
  rush() { if (ready('rush', 600)) [330, 440, 554, 659, 880].forEach((f, i) => tone(f, 0.12, 'sawtooth', 0.04, 0, i * 0.06)); },
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

// ── bits: particles, pops, rings, shake ────────────────────────────────────
// Stepped on a clock of their own at a fixed rate, never once per frame, so a
// fast screen and a slow one see the same spray.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, drag } in field units
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r, w }
let shakeX = 0, shakeY = 0, shake = 0, flash = 0, flashColour = '#ffffff';
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
function ring(x, y, colour, r, w) { rings.push({ x, y, colour, life: 0, max: 26, r, w: w || 0.006 }); }
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
    for (const look of looks.values()) { look.squash *= 0.86; look.kick *= 0.85; }
    for (const [i, v] of goalLit) { if (v < 0.03) goalLit.delete(i); else goalLit.set(i, v * 0.94); }
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.9;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, kick, seen }
let drawFailed = false;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, kick: 0, seen: 0 }));
  l.seen = performance.now();
  return l;
}
const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].k] : '#dddddd');

function play(e, t) {
  const me = myId();
  const mine = e.a === me;
  if (e.kind === 'blast') {
    const p = e.b / 1000, c = colourOf(t, e.a);
    ring(e.x, e.y, c, PULSE_R * (0.6 + p * 0.4), 0.01);
    ring(e.x, e.y, '#ffffff', PULSE_R * 0.5, 0.004);
    spray(e.x, e.y, 10 + Math.round(p * 14), c, 0.5 + p * 0.5, 0.006, 0.86);
    lookOf(e.a).kick = 1;
    if (mine) shake = Math.max(shake, 2 + p * 5);
    sound.blast(mine, p);
  } else if (e.kind === 'knock') {
    spray(e.x, e.y, 12, '#ffffff', 0.6, 0.005, 0.85);
    lookOf(e.a).squash = 1;
    if (mine) { shake = Math.max(shake, 7); pop(e.x, e.y, 'knocked!', INK.danger, 15, 26); }
    else if (e.b === me) pop(e.x, e.y, 'knocked ' + nickOf(e.a), INK.gold, 13, 22);
    sound.knock(mine || e.b === me);
  } else if (e.kind === 'grab') {
    spray(e.x, e.y, 3, colourOf(t, e.a), 0.15, 0.004, 0.8);
    sound.grab(mine);
  } else if (e.kind === 'click') {
    spray(e.x, e.y, 3 + Math.round(e.c / 300), '#ffffff', 0.3, 0.004, 0.85);
    sound.click(e.c / 1000);
  } else if (e.kind === 'clink') {
    spray(e.x, e.y, 4, INK.steelHi, 0.3, 0.004, 0.85);
    lookOf(e.a).squash = Math.min(1, e.c / 1200);
    sound.clink(mine, e.c / 1000);
  } else if (e.kind === 'rim') {
    spray(e.x, e.y, 4 + Math.round(e.b / 300), INK.rimHi, 0.3, 0.005, 0.85);
    sound.rim(e.b / 1000);
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 6, '#ffffff', 0.35, 0.005, 0.85);
    lookOf(e.a).squash = Math.min(1, e.c / 600);
    lookOf(e.b).squash = Math.min(1, e.c / 600);
    if (e.a === me || e.b === me) shake = Math.max(shake, 2 + e.c / 300);
    sound.bump();
  } else if (e.kind === 'goal') {
    const owner = e.a, by = e.b, c = colourOf(t, owner), cb = by ? colourOf(t, by) : '#ffffff';
    goalLit.set(owner, 1);
    for (let i = 0; i < 3; i++) spray(e.x, e.y, 12, i ? cb : '#ffffff', 0.8, 0.007, 0.9);
    ring(e.x, e.y, c, 0.1, 0.01);
    ring(e.x, e.y, cb, 0.06, 0.006);
    if (owner === me) {
      shake = Math.max(shake, 9);
      flash = 0.8;
      flashColour = INK.danger;
      pop(e.x, e.y, by ? (by === me ? 'own goal' : nickOf(by) + ' scored on you') : 'own goal · -1', INK.danger, 17, 34);
      sound.conceded();
    } else if (by === me) {
      shake = Math.max(shake, 5);
      flash = 0.5;
      flashColour = INK.gold;
      pop(e.x, e.y, '+1 · into ' + nickOf(owner) + "'s goal", INK.gold, 18, 34);
      sound.scored();
    } else {
      pop(e.x, e.y, by ? nickOf(by) + ' +1' : nickOf(owner) + ' -1', cb === '#ffffff' ? c : cb, 13, 24);
      sound.goal();
    }
  } else if (e.kind === 'drop') {
    ring(e.x, e.y, INK.steelHi, 0.05, 0.004);
    sound.drop();
  } else if (e.kind === 'spawn') {
    ring(e.x, e.y, colourOf(t, e.a), 0.07, 0.008);
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'rush') {
    flash = 0.5;
    flashColour = INK.gold;
    sound.rush();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(e.a === me);
  } else if (e.kind === 'round') {
    goalLit.clear();
  }
}

// A magnet: a shadow, a disc in its seat's colour, a horseshoe on top that
// points the way it faces, and round it what it is doing — the reach of its
// pull drawn in as rings closing on it, its charge as an arc filling, a
// knocked magnet's sparks, a surge's gold.
function drawMagnet(t, id, d, x, y, me, now) {
  inField();
  const col = SEAT[d.k], look = lookOf(id), on = isOn(d);
  if (on) {
    ctx.fillStyle = alpha(col, 0.06);
    disc(x, y, PULL_R); ctx.fill();
    ctx.strokeStyle = alpha(col, 0.5);
    ctx.lineWidth = 0.0025;
    for (let i = 0; i < 3; i++) {
      const k = 1 - ((now / 700 + i / 3) % 1);
      ctx.globalAlpha = (1 - k) * 0.9;
      disc(x, y, MR + (PULL_R - MR) * k); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (d.rg > 0) {
    ctx.fillStyle = alpha(INK.gold, 0.18 + 0.1 * Math.sin(now / 90));
    disc(x, y, MR + 0.016); ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  disc(x + 0.004, y + 0.007, MR); ctx.fill();
  const s = 1 + look.squash * 0.18;
  ctx.save();
  ctx.translate(x - d.ax * look.kick * 0.008, y - d.ay * look.kick * 0.008);
  ctx.scale(s, 2 - s);
  ctx.fillStyle = d.st > 0 ? lighter(col, 0.45) : col;
  disc(0, 0, MR); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.003;
  disc(0, 0, MR * 0.98); ctx.stroke();
  // The horseshoe: a U whose open end faces the way the magnet does, its
  // poles red and silver.
  const a = Math.atan2(d.ay, d.ax);
  ctx.rotate(a);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(20,18,40,0.85)';
  ctx.lineWidth = MR * 0.36;
  ctx.beginPath();
  ctx.arc(-MR * 0.12, 0, MR * 0.42, Math.PI * 0.5, Math.PI * 1.5);
  ctx.stroke();
  ctx.lineWidth = MR * 0.36;
  ctx.strokeStyle = '#ff4d5e';
  ctx.beginPath(); ctx.moveTo(-MR * 0.12, -MR * 0.42); ctx.lineTo(MR * 0.42, -MR * 0.42); ctx.stroke();
  ctx.strokeStyle = '#e8ecf8';
  ctx.beginPath(); ctx.moveTo(-MR * 0.12, MR * 0.42); ctx.lineTo(MR * 0.42, MR * 0.42); ctx.stroke();
  ctx.restore();
  if (me) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.0035; disc(x, y, MR + 0.006); ctx.stroke(); }
  if (d.ch > 0) {
    const full = d.ch >= CH_MAX;
    ctx.strokeStyle = full ? INK.gold : lighter(col, 0.4);
    ctx.lineWidth = 0.005;
    ctx.beginPath();
    ctx.arc(x, y, MR + 0.012, -Math.PI / 2, -Math.PI / 2 + (TAU * d.ch) / CH_MAX);
    ctx.stroke();
  }
  if (d.st > 0) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.0025;
    for (let i = 0; i < 3; i++) {
      const q = now / 160 + (i * TAU) / 3, r = MR + 0.012;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(q) * r, y + Math.sin(q) * r);
      ctx.lineTo(x + Math.cos(q + 0.4) * (r + 0.01), y + Math.sin(q + 0.4) * (r + 0.01)); ctx.stroke();
    }
  }
}

// Where your blast would send what clings to you: a dotted line the way you
// face, longer and brighter the more charge there is.
function drawAim(d, x, y, now) {
  if (!isOn(d) && !d.ch) return;
  inField();
  const p = d.rg > 0 ? 1 : CH_MIN_P + ((1 - CH_MIN_P) * d.ch) / CH_MAX;
  const len = 0.05 + p * 0.22;
  ctx.strokeStyle = d.ch >= CH_MAX || d.rg > 0 ? INK.gold : '#ffffff';
  ctx.globalAlpha = 0.35 + p * 0.5;
  ctx.lineWidth = 0.004;
  ctx.lineCap = 'round';
  ctx.setLineDash([0.008, 0.012]);
  ctx.lineDashOffset = -(now / 1000) * 0.1;
  ctx.beginPath();
  ctx.moveTo(x + d.ax * (MR + 0.03), y + d.ay * (MR + 0.03));
  ctx.lineTo(x + d.ax * (MR + 0.03 + len), y + d.ay * (MR + 0.03 + len));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

// A steel ball: a shadow, a silver sphere lit from the top left, and a streak
// behind it in the colour of whoever last sent it when it flies.
function drawBall(x, y, vx, vy, colour) {
  inField();
  const sp = Math.sqrt(vx * vx + vy * vy);
  if (sp > 0.35 && colour) {
    const l = Math.min(0.09, sp * 0.05);
    const g = ctx.createLinearGradient(x, y, x - (vx / sp) * l, y - (vy / sp) * l);
    g.addColorStop(0, alpha(colour, 0.7));
    g.addColorStop(1, alpha(colour, 0));
    ctx.strokeStyle = g;
    ctx.lineWidth = BR * 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - (vx / sp) * l, y - (vy / sp) * l); ctx.stroke();
    ctx.lineCap = 'butt';
  }
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  disc(x + 0.003, y + 0.005, BR); ctx.fill();
  const g = ctx.createRadialGradient(x - BR * 0.35, y - BR * 0.4, BR * 0.1, x, y, BR);
  g.addColorStop(0, INK.steelHi);
  g.addColorStop(0.45, INK.steel);
  g.addColorStop(1, INK.steelLo);
  ctx.fillStyle = g;
  disc(x, y, BR); ctx.fill();
}

function drawBits() {
  inField();
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = r.w * (1 - k) + 0.0015;
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
    const X = clamp(X0 + shakeX, 80, VW - 80), Y = clamp(Y0 + shakeY, TOP + 30, VH - 20) - ease(Math.min(1, k * 1.4)) * p.lift;
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10,8,25,0.75)';
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
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    const rushing = t.pt <= RUSH_STEPS;
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + (rushing ? ' · rush' : '');
    if (d) status += ' · you ' + (d.sc > 0 ? '+' : '') + d.sc;
    if (rushing) colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('polarity', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('polarity').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 82, 'left');
  text(wireNote(), VW - 50, 33, 9, INK.dim, 'right');

  // The board: one chip a player, in order of points this round, in its seat's
  // colour, with its points and the rounds it has won.
  if (order.length) {
    const y = narrow ? 54 : 48;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (order.length - 1)) / order.length);
    let x = (VW - (cw * order.length + gap * (order.length - 1))) / 2;
    order.forEach((id) => {
      const c = t.p[id], mine = id === me;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.16)' : 'rgba(5,4,20,0.5)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[c.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[c.k];
      disc(x + 11, y - 2, 6);
      ctx.fill();
      const score = (c.sc > 0 ? '+' : '') + c.sc + (c.wn ? ' ★' + c.wn : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, c.sc < 0 ? '#ff9aa6' : INK.text, 'right');
      if (cw - 34 - sw > 14) fitText(mine ? 'you' : nickOf(id), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    });
  }

  // The one line that says how to play.
  const how = coarse
    ? 'touch: your magnet follows and pulls · lift to blast · steel in a rival goal scores'
    : 'steer with the mouse or WASD · hold the button or space to pull · let go to blast · M mutes';
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
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const me = myId();
  const cx = VW / 2, cy = (fieldBox[1] + fieldBox[3]) / 2;
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : "hold to pull the steel in · let go facing the bot's goal to blast it";
    practiceNote(now, VW, head, tip, [[TOP, fieldBox[1] - 4], [fieldBox[3] + 4, VH - BOT]], VH - BOT - 4);
  } else if (t.ph === COUNT) {
    const n = Math.ceil(t.pt / HZ);
    const w = Math.min(VW - 32, 360), h = 112;
    panel(cx, cy, w, h);
    fitText('round ' + t.rd + ' · ' + clock(ROUND_STEPS), cx, cy - 22, 20, INK.text, w - 24);
    fitText("steel in a rival's goal scores · in yours costs a point", cx, cy + 2, 13, INK.muted, w - 24);
    text(String(n), cx, cy + 40, 26, INK.gold, 'center');
  } else if (t.ph === PLAY && t.pt > ROUND_STEPS - HZ) {
    const k = (ROUND_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('go!', cx, cy + big * 0.5, big * (2 + k), INK.gold, 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= RUSH_STEPS && t.pt > RUSH_STEPS - 3 * HZ) {
    const k = (RUSH_STEPS - t.pt) / (3 * HZ);
    const s = 'rush · one more ball · every goal opens';
    ctx.globalAlpha = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
    ctx.font = font(15);
    const w = Math.min(VW - 24, ctx.measureText(s).width + 32);
    panel(cx, fieldBox[1] + 20, w, 30);
    fitText(s, cx, fieldBox[1] + 25, 15, INK.gold, w - 16);
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 100 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 6, Math.min(VH - BOT - h / 2 - 6, cy)) + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.win !== -1) { head = t.win === me ? 'you take the round!' : nickOf(t.win) + ' takes the round'; hc = colourOf(t, t.win); }
    else head = 'a tie at the top';
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 34, 22, hc, w - 24);
    rows.forEach(([id, pts, goals, won], i) => {
      const y = y0 + 64 + i * 22;
      text(ord(i + 1), cx - w / 2 + 30, y, 13, i === 0 ? INK.gold : INK.dim, 'center');
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 54, y - 4, 5);
      ctx.fill();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 66, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(goals + (goals === 1 ? ' goal' : ' goals'), cx + w / 2 - 92, y, 11, INK.dim, 'right');
      if (won) text('★' + won, cx + w / 2 - 56, y, 12, INK.gold, 'right');
      text((pts > 0 ? '+' : '') + pts, cx + w / 2 - 18, y, 15, pts < 0 ? '#ff9aa6' : INK.text, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// A magnet or a ball between two tables: one put down afresh — a new round,
// a ball back from a goal — is drawn where the newer table has it rather than
// slid there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || (p.x - q.x) ** 2 + (p.y - q.y) ** 2 > 0.1 * 0.1) return [p.x, p.y];
  return [lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k)];
}
function ballBetween(b, i) {
  const p = b.to.b[i], q = b.from.b[i];
  if (!p || p.rs) return null;
  if (!q || q.rs || (p.x - q.x) ** 2 + (p.y - q.y) ** 2 > 0.15 * 0.15) return [p.x, p.y, p.vx, p.vy, p.lt];
  return [lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k), p.vx, p.vy, p.lt];
}

// Your own magnet is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh, a new round — is taken at once.
let shown = null;
const SNAP = 0.1;
function settle(pos) {
  if (!shown || (pos[0] - shown[0]) ** 2 + (pos[1] - shown[1]) ** 2 > SNAP * SNAP) return (shown = pos.slice());
  const k = per60(0.5);
  for (let i = 0; i < 2; i++) shown[i] += (pos[i] - shown[i]) * k;
  return shown;
}

let myPos = null;      // [x, y]: where your magnet is drawn
function draw(now) {
  const b = agreedAt(now);
  if (!b) {
    flat();
    ctx.fillStyle = INK.bg;
    ctx.fillRect(0, 0, VW, VH);
    myPos = shown = null;
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('switching the magnets on…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  drawFloor();
  const goals = goalsOf(t);
  drawRim(t, goals, now);
  const me = myId();
  const ids = bySeat(t);

  // Where every magnet is drawn: yours from the guess, the rest from the agreed table.
  const at = new Map();
  for (const id of ids) {
    if (id === me) continue;
    const pos = between(b, id);
    if (pos) at.set(id, pos);
  }
  const m = mineAt(now);
  // A guess already in the next phase while the drawing is still in this one
  // draws your magnet from the agreed table for that moment.
  const guessed = !!(m && m.to.p[me] && m.to.ph === t.ph && m.to.b.length === t.b.length);
  const minePos = guessed ? between(m, me) : between(b, me);
  if (minePos) at.set(me, settle(minePos));
  const dOf = (id) => (id === me && guessed ? m.to.p[me] : t.p[id]);
  myPos = at.get(me) || null;
  if (!myPos) shown = null;

  for (const id of ids) {
    const pos = at.get(id);
    if (pos) drawMagnet(t, id, dOf(id), pos[0], pos[1], id === me, now);
  }
  // The balls: one clinging to your own magnet in the guess goes with it,
  // drawn from the guess too, or it would trail a trip behind your hands.
  const mg = guessed ? m.to.p[me] : null;
  t.b.forEach((q, i) => {
    let pos = null;
    if (mg) {
      const g = m.to.b[i];
      if (g && !g.rs && (g.x - mg.x) ** 2 + (g.y - mg.y) ** 2 < (CLING_D + 0.02) ** 2) pos = ballBetween(m, i);
    }
    if (!pos) pos = ballBetween(b, i);
    if (pos) drawBall(pos[0], pos[1], pos[2], pos[3], pos[4] && t.p[pos[4]] ? SEAT[t.p[pos[4]].k] : null);
  });
  const myD = myPos ? dOf(me) : null;
  if (myD) drawAim(myD, myPos[0], myPos[1], now);

  // Names over the magnets.
  flat();
  for (const id of ids) {
    const pos = at.get(id), d = dOf(id);
    if (!pos) continue;
    const [X, Y] = P(pos[0], pos[1]);
    const mine = id === me;
    let label = mine ? 'you' : nickOf(id);
    if (d.st > 0) label += ' · knocked';
    else if (d.rg > 0 && t.ph !== WAIT) label += ' · surge';
    fitText(label, X + shakeX, Y + shakeY - sc * (MR + 0.02) - 2, 10, mine ? '#ffffff' : 'rgba(255,255,255,0.78)', 100);
  }
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawGoalNames(t, goals);
  drawBits();

  // A goal on you flushes the edges of the screen red; one of yours, gold.
  if (flash > 0.05) {
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    g.addColorStop(0, alpha(flashColour, 0));
    g.addColorStop(1, alpha(flashColour, 0.3 * flash));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(t, now, t.ph === WAIT ? ids : standings(t));
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: [steer x, steer y, on, blasts asked for]. The mouse
// steers toward where it points, a thumb toward where it touches, the keys the
// way they press; the steer eases off near the point, so a magnet comes to
// rest on it. Holding the button, a thumb on the glass or space switches the
// magnet on, and letting go asks for a blast. A change of steer goes out no
// oftener than STEER_EVERY, because a pointer changes it on every move the
// screen reports and the clock's ticks share the same seat's ceiling on
// messages; switching on and blasting go out at once.
const STEER_EVERY = 110;
const steer = { mode: '', tx: CX, ty: CY, follow: false };
let on = false;
let asked = 0;          // blasts this page has asked for
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const MOVE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];

function steerNow() {
  if (steer.mode === 'keys') {
    let x = 0, y = 0;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) x -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
    if (keys.has('ArrowUp') || keys.has('KeyW')) y -= 1;
    if (keys.has('ArrowDown') || keys.has('KeyS')) y += 1;
    const l = Math.hypot(x, y) || 1;
    return [Math.round((x / l) * 1000), Math.round((y / l) * 1000)];
  }
  if (!steer.follow || !myPos) return [0, 0];
  const dx = steer.tx - myPos[0], dy = steer.ty - myPos[1], l = Math.hypot(dx, dy);
  if (l < 0.012) return [0, 0];
  const k = Math.min(1, l / 0.07) * 1000 / l;
  return [clamp(Math.round(dx * k), -1000, 1000), clamp(Math.round(dy * k), -1000, 1000)];
}
function handNow() {
  const [dx, dy] = steerNow();
  return [dx, dy, on ? 1 : 0, asked];
}
function sayHand(now, force) {
  const h = handNow(), s = lastSaid;
  if (s && h.every((v, i) => v === s[i])) return;
  const same = s && h[2] === s[2] && h[3] === s[3];
  if (same && !force && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

function switchOn() {
  if (on) return;
  on = true;
  sound.on();
  sayHand(performance.now(), true);
}
// Letting go: a blast, which goes off once the table says the magnet may.
function letGo() {
  if (!on) return;
  on = false;
  const d = world && world.p[myId()];
  asked = Math.min(BLAST_MAX, Math.max(asked, d ? d.bs : 0) + 1);
  sayHand(performance.now(), true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (e.repeat) return;
    coarse = false;
    switchOn();
    return;
  }
  if (!MOVE_KEYS.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  steer.mode = 'keys';
  keys.add(e.code);
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'Enter') { letGo(); return; }
  keys.delete(e.code);
});
addEventListener('blur', () => {
  keys.clear();
  if (drag !== null) { drag = null; steer.follow = steer.mode === 'mouse'; }
  if (on) letGo();
});

// A pointer: the mouse steers wherever it points, buttons up or down; a thumb
// steers only while it is on the glass. Pressing switches the magnet on and
// lifting blasts, captured, so a press that leaves the frame still lets go
// where it should.
let drag = null;   // the pointer id held down, or null
function aimAt(e) {
  steer.tx = (e.clientX - ox) / sc;
  steer.ty = (e.clientY - oy) / sc;
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (drag !== null) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  drag = e.pointerId;
  steer.mode = coarse ? 'touch' : 'mouse';
  steer.follow = true;
  aimAt(e);
  switchOn();
});
cv.addEventListener('pointermove', (e) => {
  if (drag !== null && e.pointerId !== drag) return;
  if (drag === null && e.pointerType !== 'mouse') return;
  if (drag === null) {
    if (steer.mode === 'keys' && keys.size) return;
    steer.mode = 'mouse';
    steer.follow = true;
    coarse = false;
  }
  aimAt(e);
});
function lift(e) {
  if (drag === null || e.pointerId !== drag) return;
  drag = null;
  if (steer.mode === 'touch') steer.follow = false;
  letGo();
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);

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
// a player arrives and is put in front of their goal.
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
