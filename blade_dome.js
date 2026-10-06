/**
 * @disk     blade_dome
 * @author   diskroom
 * @version  3
 * @players  1-8
 * @about    Hold the dome together against waves of blobs. Your blade hangs on a spring and follows the mouse or a thumb: the faster the tip, the harder it bites. Bat their spit back at them, vault off the floor, and survive the Warden.
 * @tags     game, action, physics, coop, realtime, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/blade_dome.png
 */
// blade_dome.js — a co-op arena where every blade is physics and the room's
// order is the referee.
//
// Everybody stands in one dome, a half circle on a floor, and the blobs come in
// waves through its roof. A player does not aim a blade so much as pull it: the
// hand says which way the mouse points, and the blade swings after it on a
// spring, with a speed of its own and an overshoot. A hit is worth what the
// point of the blade that landed was moving at, so a flick of the wrist does
// more than a blade held out, and the tip more than the hilt. The same blade
// bats a blob's spit back at the blobs, stops it dead when held still, clashes
// with a friend's blade, and slammed into the floor or the dome throws its
// owner the other way.
//
// Only hands and ticks travel: a hand is which keys are down and an angle cut
// into 256, sent with `{ echo: true }` like the ticks, so every copy applies
// every hand at the same place between the same two steps and runs the same
// arithmetic on the same numbers. Nothing here keeps its own idea of the dome:
// the blobs' minds draw on the table's random numbers, a wave is counted in
// steps, and the score is the table's. What is drawn on top of it — sparks,
// gibs, the numbers that fly off a hit, sound — is made only while the agreed
// table steps, held until the drawing reaches the step that made it, and never
// travels.
//
// Your own blob and blade answer at once: they are drawn from the agreed table
// played forward by the trip it takes, with your hand in it.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.abs`, `Math.min`,
// `Math.max`, `Math.sign` and `Math.imul` are fixed by the language to the last
// bit. `Math.sin`, `Math.cos`, `Math.atan2`, `Math.hypot`, `Math.pow` and
// `Math.exp` are not — an engine may round them its own way — so the rules use
// these instead. Their accuracy is ample for a game; their point is that every
// engine computes them identically.
const PI = 3.141592653589793, TAU = 6.283185307179586;

function dsin(a) {
  let x = a - TAU * Math.round(a / TAU);
  if (x > PI / 2) x = PI - x;
  else if (x < -PI / 2) x = -PI - x;
  const x2 = x * x;
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - (x2 / 110) * (1 - x2 / 156))))));
}
function dcos(a) { return dsin(a + PI / 2); }

function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a) => a - TAU * Math.round(a / TAU);

// ═══════════════════ the game ═══════════════════
const HZ = 60;               // every constant below is per step
const STEPS_PER_TICK = 2;
const PREDICT = true;

const LW = 960, LH = 540;
// The dome: a half circle of radius R standing on the floor, centred at CX.
const CX = 480, FLOOR = 480, R = 450;
// One-way ledges, [left, right, top]: stood on from above, jumped through from
// below, dropped through with down held.
const PLATFORMS = [[140, 300, 370], [660, 820, 370], [390, 570, 270], [235, 345, 170], [615, 725, 170]];

const PR = 15;                                       // a player's body
const GRAV = 0.36, MAXFALL = 10, MAXRISE = 12;
const RUN = 4.3, ACC_GROUND = 0.8, ACC_AIR = 0.42;
const JUMP = 8.3, AIR_JUMP = 7.4, WALL_JUMP = 7.8, WALL_KICK = 5.5, CUT = 0.45;
const COYOTE = 6, WALL_GRACE = 8;

// The blade reaches from HILT to BLADE out of the body's centre and is pulled
// toward the hand's angle by a spring that is deliberately a little loose: it
// overshoots, and the overshoot is what a swing is.
const HILT = 16, BLADE = 66, EDGE = 3;
const SPRING = 0.13, BRAKE = 0.28, SPIN = 0.5;
const SWEEP = 4;                                     // samples of a blade's path through one step
const VAULT = 7.5;                                   // the most a blade struck into the ground throws you
const AIMS = 256;                                    // an angle said in a hand is one of these

const HP = 100, IFRAMES = 50, RESPAWN = 420, HEAL = 35;
const STREAK = 150;                                  // steps a kill keeps a streak alive
const HIT_GAP = 12, PAIR_GAP = 14;                   // steps before one blade may hit one thing again
const ORB_HURT = 10, ORB_DMG = 14;

const BREAK = 0, FIGHT = 1, OVER = 2;
const FIRST_BREAK = 240, BREAK_STEPS = 200, OVER_STEPS = 420, SPAWN_GAP = 38;

const HOP = 0, FLY = 1, SPIT = 2, BRUTE = 3, BOSS = 4;
// r: size · hp: at wave one · m: how little a hit moves it · hit: what touching
// it costs · pts: what it is worth · armor: the slowest blade that cuts it.
const KINDS = [
  { r: 13, hp: 12, m: 1, hit: 8, pts: 10, armor: 0 },
  { r: 11, hp: 8, m: 0.7, hit: 7, pts: 15, armor: 0 },
  { r: 15, hp: 18, m: 1.2, hit: 6, pts: 20, armor: 0 },
  { r: 26, hp: 60, m: 3.5, hit: 16, pts: 40, armor: 10 },
  { r: 46, hp: 300, m: 12, hit: 20, pts: 250, armor: 7 },
];
const GROWS = [30, 30, 30, 30, 60];                  // steps a blob takes to come through the roof

const HUES = ['#ededed', '#a9c0a9', '#a9bad3', '#a9d3cc', '#c4d3a9', '#bdb3d9', '#cfe0e6', '#b3b3b3'];

// Where the blobs come in: points just inside the roof.
const GATES = [-0.5, -0.72, -0.28, -0.86, -0.14].map((k) => [
  CX + dcos(k * PI) * (R - 60), FLOOR + dsin(k * PI) * (R - 60),
]);

// A table is plain data, and its fingerprint is the text of it — so every
// object in it is built in one fixed order of keys, the order it is read back
// in from a handover. F is a number, I a whole number, N a whole number or
// null, M a map from ids to whole numbers.
const F = 0, I = 1, N = 2, M = 3;
const FIGHTER = [['x', F], ['y', F], ['vx', F], ['vy', F], ['a', F], ['w', F], ['ox', F], ['oy', F], ['oa', F],
  ['h', I], ['pj', I], ['up', I], ['g', I], ['co', I], ['aj', I], ['wc', I], ['wx', I],
  ['hp', I], ['dn', I], ['iv', I], ['ht', I], ['bt', I], ['sc', I], ['k', I], ['cb', I], ['ct', I], ['c', I], ['s', I]];
const ENEMY = [['i', I], ['k', I], ['x', F], ['y', F], ['vx', F], ['vy', F], ['hp', I], ['mx', I],
  ['t', I], ['st', I], ['f', I], ['g', I], ['b', I], ['hu', I], ['lh', N], ['lo', I], ['hb', M]];
const ORB = [['i', I], ['x', F], ['y', F], ['vx', F], ['vy', F], ['r', F], ['fr', I], ['by', N], ['l', I]];
const TABLE = [['rng', I], ['wave', I], ['ph', I], ['pt', I], ['ws', I], ['sa', I], ['eid', I], ['oid', I],
  ['nc', I], ['best', I], ['run', I]];

function shaped(spec, values) {
  const o = {};
  for (const [key] of spec) o[key] = values[key];
  return o;
}

function freshTable(seed) {
  const t = shaped(TABLE, { rng: seed | 0, wave: 0, ph: BREAK, pt: FIRST_BREAK, ws: 0, sa: 0, eid: 1, oid: 1, nc: 0, best: 0, run: 0 });
  t.q = []; t.p = {}; t.e = []; t.o = []; t.cd = {};
  return t;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const grown = (w, e) => w.n - e.b >= GROWS[e.k];

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made them
// until the drawing gets there: a guess replayed ten times makes none of them.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, a: a || 0, b: b || 0, c: c || 0 });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ── bodies and the dome ────────────────────────────────────────────────────
// The floor and the ledges. Returns whether the body stands on something.
function land(b, oy, r, drop) {
  if (b.y + r >= FLOOR) {
    b.y = FLOOR - r;
    if (b.vy > 0) b.vy = 0;
    return 1;
  }
  if (b.vy < 0 || drop) return 0;
  for (const [x1, x2, top] of PLATFORMS) {
    if (b.x < x1 - r * 0.5 || b.x > x2 + r * 0.5) continue;
    if (oy + r <= top + 0.001 && b.y + r >= top) {
      b.y = top - r;
      b.vy = 0;
      return 1;
    }
  }
  return 0;
}

// The dome's shell. Returns the outward normal's x where the body touches it,
// or null where it does not.
function dome(b, r, bounce) {
  const dx = b.x - CX, dy = b.y - FLOOR;
  const d = Math.sqrt(dx * dx + dy * dy), lim = R - r;
  if (d <= lim) return null;
  const nx = dx / d, ny = dy / d;
  b.x = CX + nx * lim;
  b.y = FLOOR + ny * lim;
  const vn = b.vx * nx + b.vy * ny;
  if (vn > 0) {
    b.vx -= nx * vn * (1 + bounce);
    b.vy -= ny * vn * (1 + bounce);
  }
  return nx;
}

// Something that flies keeps off the floor rather than standing on it.
function skim(b, r) {
  if (b.y + r <= FLOOR) return;
  b.y = FLOOR - r;
  if (b.vy > 0) b.vy = -b.vy * 0.5;
}

function steer(e, gx, gy, acc, most) {
  const dx = gx - e.x, dy = gy - e.y, d = Math.sqrt(dx * dx + dy * dy);
  if (d > 1) {
    e.vx += (dx / d) * acc;
    e.vy += (dy / d) * acc;
  }
  // Eased down to the pace rather than cut to it, so a blow carries.
  const sp = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
  if (sp > most) {
    const k = Math.max(most / sp, 0.92);
    e.vx *= k;
    e.vy *= k;
  }
}

// ── the players ────────────────────────────────────────────────────────────
function newFighter(w, id) {
  w.p[id] = shaped(FIGHTER, {
    x: CX + (draw01(w) - 0.5) * 360, y: 90, vx: 0, vy: 0, a: -PI / 2, w: 0, ox: 0, oy: 0, oa: -PI / 2,
    h: 0, pj: 0, up: 0, g: 0, co: 0, aj: 1, wc: 0, wx: 0,
    hp: HP, dn: 0, iv: w.n + 120, ht: -1000, bt: 0, sc: 0, k: 0, cb: 0, ct: 0, c: w.nc++ % HUES.length, s: 0,
  });
  const f = w.p[id];
  f.ox = f.x;
  f.oy = f.y;
}

function revive(w, f) {
  f.dn = 0;
  f.hp = HP;
  f.iv = w.n + 120;
  f.x = f.ox = CX + (draw01(w) - 0.5) * 360;
  f.y = f.oy = 90;
  f.vx = 0; f.vy = 0; f.w = 0; f.up = 0;
  f.s += 1;
}

function hurt(w, id, f, dmg, nx, ny) {
  if (f.dn || w.n < f.iv) return false;
  f.hp -= dmg;
  f.iv = w.n + IFRAMES;
  f.ht = w.n;
  f.vx += nx * 5.5;
  f.vy = Math.min(f.vy, 0) - 3 + ny * 2;
  f.g = 0;
  f.up = 0;
  if (f.hp <= 0) {
    f.hp = 0;
    f.dn = w.n + RESPAWN;
    fx(w, 'down', f.x, f.y, id, f.c);
  } else {
    fx(w, 'hurt', f.x, f.y, id, dmg);
  }
  return true;
}

// The hand, read: bits 0-3 are left, right, jump and down, and the angle is
// above them.
function move(w, id, f) {
  f.ox = f.x;
  f.oy = f.y;
  f.oa = f.a;
  if (f.dn) {
    if (w.ph === FIGHT && w.n >= f.dn) revive(w, f);
    return;
  }
  const h = f.h;
  const dir = (h & 2 ? 1 : 0) - (h & 1 ? 1 : 0);
  const jump = (h >> 2) & 1, drop = (h >> 3) & 1;
  const acc = f.g ? ACC_GROUND : ACC_AIR;
  f.vx += clamp(dir * RUN - f.vx, -acc, acc);

  // A jump is the moment the key goes down, not the key held.
  if (jump && !f.pj) {
    if (f.g || f.co > 0) {
      f.vy = -JUMP; f.co = 0; f.up = 1;
      fx(w, 'jump', f.x, f.y + PR);
    } else if (f.wc > 0) {
      f.vy = -WALL_JUMP; f.vx = f.wx * WALL_KICK; f.wc = 0; f.up = 1;
      fx(w, 'jump', f.x - f.wx * PR, f.y);
    } else if (f.aj > 0) {
      f.vy = -AIR_JUMP; f.aj -= 1; f.up = 1;
      fx(w, 'jump', f.x, f.y + PR);
    }
  }
  f.pj = jump;
  // A jump let go of early is a short one; a throw from the blade is not a
  // jump and is never cut.
  if (f.vy >= 0) f.up = 0;
  f.vy = clamp(f.vy + GRAV + (f.up && !jump ? CUT : 0), -MAXRISE, MAXFALL);

  const oy = f.y;
  f.x += f.vx;
  f.y += f.vy;
  f.g = land(f, oy, PR, drop);
  if (f.g) { f.co = COYOTE; f.aj = 1; f.up = 0; } else if (f.co > 0) f.co -= 1;
  const nx = dome(f, PR, 0);
  if (nx !== null && !f.g && Math.abs(nx) > 0.6) { f.wc = WALL_GRACE; f.wx = nx > 0 ? -1 : 1; }
  else if (f.wc > 0) f.wc -= 1;

  const aim = (((h >> 4) & 255) / AIMS) * TAU - PI;
  f.w = clamp(f.w + wrap(aim - f.a) * SPRING - f.w * BRAKE, -SPIN, SPIN);
  f.a += f.w;
  vault(w, id, f);
  f.a = wrap(f.a);
}

// A blade driven into the floor or the shell throws its owner the other way,
// by as much as the tip was moving into it.
function vault(w, id, f) {
  const c = dcos(f.a), s = dsin(f.a);
  const tx = f.x + c * BLADE, ty = f.y + s * BLADE;
  let nx = 0, ny = -1, pen = ty - FLOOR;
  if (pen <= 0) {
    const dx = tx - CX, dy = ty - FLOOR, d = Math.sqrt(dx * dx + dy * dy);
    if (d <= R) return;
    nx = -dx / d;
    ny = -dy / d;
    pen = d - R;
  }
  if (w.n < f.bt) return;
  const vx = f.vx - s * f.w * BLADE, vy = f.vy + c * f.w * BLADE;
  const into = -(vx * nx + vy * ny);
  if (into < 3) return;
  const kick = Math.min(into * 0.42, VAULT);
  f.vx += nx * kick;
  f.vy = Math.max(-MAXRISE, f.vy + ny * kick);
  f.w *= -0.3;
  f.bt = w.n + 8;
  f.up = 0;
  if (f.vy < 0) f.g = 0;
  fx(w, 'vault', tx - nx * pen, ty - ny * pen, nx, ny, kick);
}

// A blade's path through the step just taken, sampled: where the pivot was,
// which way the blade pointed, and how fast the pivot and the angle moved.
function sweepOf(f) {
  const da = wrap(f.a - f.oa);
  const s = [];
  for (let k = 1; k <= SWEEP; k++) {
    const t = k / SWEEP, a = f.oa + da * t;
    s.push([f.ox + (f.x - f.ox) * t, f.oy + (f.y - f.oy) * t, dcos(a), dsin(a)]);
  }
  return { s, da, vx: f.x - f.ox, vy: f.y - f.oy };
}

// Where a blade's sweep first meets a circle, and how fast that point of the
// blade was moving — or null.
function meet(sw, cx, cy, r) {
  const reach = (r + EDGE) * (r + EDGE);
  for (const [px, py, c, s] of sw.s) {
    const u = clamp((cx - px) * c + (cy - py) * s, HILT, BLADE);
    const qx = px + c * u, qy = py + s * u;
    const dx = cx - qx, dy = cy - qy;
    if (dx * dx + dy * dy < reach) {
      return { x: qx, y: qy, vx: sw.vx - s * sw.da * u, vy: sw.vy + c * sw.da * u };
    }
  }
  return null;
}

function slash(w, id, sw, f, e) {
  const K = KINDS[e.k];
  const last = e.hb[id];
  if (last !== undefined && w.n - last < HIT_GAP) return;
  const hit = meet(sw, e.x, e.y, K.r);
  if (!hit) return;
  e.hb[id] = w.n;
  const rvx = hit.vx - e.vx, rvy = hit.vy - e.vy;
  const sp = Math.sqrt(rvx * rvx + rvy * rvy);
  f.w *= 0.55;
  if (sp < 1) return;
  const push = Math.min(12, sp * 0.5) / K.m;
  e.vx += (rvx / sp) * push;
  e.vy += (rvy / sp) * push;
  if (sp < K.armor) {
    fx(w, 'tink', hit.x, hit.y, rvx / sp, rvy / sp);
    return;
  }
  const dmg = Math.max(1, Math.floor((sp - 2) * 1.5));
  e.hp -= dmg;
  e.hu = w.n;
  e.lh = Number(id);
  e.lo = 0;
  // A blow breaks off a dive and a charge.
  if (e.k === FLY && e.st === 1) { e.st = 0; e.t = w.n + 90; }
  if (e.k === BRUTE && e.st === 1 && dmg >= 20) { e.st = 0; e.t = w.n + 120; }
  fx(w, 'hit', hit.x, hit.y, rvx / sp, rvy / sp, dmg * 8 + e.k);
}

// Spit met by a blade: batted back the way the blade was moving when it is
// swung, stopped dead when the blade is held still.
function parry(w, id, sw, f, o) {
  const hit = meet(sw, o.x, o.y, o.r);
  if (!hit) return;
  const sp = Math.sqrt(hit.vx * hit.vx + hit.vy * hit.vy);
  if (sp < 3.5) {
    o.l = 0;
    fx(w, 'block', o.x, o.y);
    return;
  }
  const v = clamp(sp * 0.6, 6.5, 13);
  o.vx = (hit.vx / sp) * v;
  o.vy = (hit.vy / sp) * v;
  o.fr = 1;
  o.by = Number(id);
  o.l = 240;
  fx(w, 'parry', o.x, o.y, f.c);
}

const cooled = (w, key, gap) => w.cd[key] === undefined || w.n - w.cd[key] >= gap;

// A friend's blade does no harm, but it does move you.
function bonk(w, ia, sw, A, ib, B) {
  const key = ia + '>' + ib;
  if (!cooled(w, key, PAIR_GAP)) return;
  const hit = meet(sw, B.x, B.y, PR);
  if (!hit) return;
  const rvx = hit.vx - (B.x - B.ox), rvy = hit.vy - (B.y - B.oy);
  const sp = Math.sqrt(rvx * rvx + rvy * rvy);
  if (sp < 3) return;
  w.cd[key] = w.n;
  const push = Math.min(8, sp * 0.45);
  B.vx += (rvx / sp) * push;
  B.vy += (rvy / sp) * push - 1.5;
  B.g = 0;
  B.up = 0;
  A.w *= 0.6;
  fx(w, 'bonk', hit.x, hit.y);
}

// Two blades that cross at speed ring off each other: each is knocked the way
// the other was moving across it.
function clash(w, ia, swA, A, ib, swB, B) {
  const key = ia + '|' + ib;
  if (!cooled(w, key, PAIR_GAP)) return;
  const ca = dcos(A.a), sa = dsin(A.a), cb = dcos(B.a), sb = dsin(B.a);
  let best = Infinity, bu = 0, bv = 0;
  for (let k = 0; k <= 5; k++) {
    const u = HILT + ((BLADE - HILT) * k) / 5;
    const px = A.x + ca * u, py = A.y + sa * u;
    const v = clamp((px - B.x) * cb + (py - B.y) * sb, HILT, BLADE);
    const dx = px - (B.x + cb * v), dy = py - (B.y + sb * v);
    const d2 = dx * dx + dy * dy;
    if (d2 < best) { best = d2; bu = u; bv = v; }
  }
  if (best > 49) return;
  const avx = swA.vx - sa * swA.da * bu, avy = swA.vy + ca * swA.da * bu;
  const bvx = swB.vx - sb * swB.da * bv, bvy = swB.vy + cb * swB.da * bv;
  const rx = bvx - avx, ry = bvy - avy;
  if (rx * rx + ry * ry < 16) return;
  w.cd[key] = w.n;
  A.w = clamp(-A.w * 0.3 + ((rx * -sa + ry * ca) / bu) * 0.8, -SPIN, SPIN);
  B.w = clamp(-B.w * 0.3 + ((-rx * -sb + -ry * cb) / bv) * 0.8, -SPIN, SPIN);
  const dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy);
  if (d > 0) {
    A.vx -= (dx / d) * 2.5; A.vy -= (dy / d) * 2.5;
    B.vx += (dx / d) * 2.5; B.vy += (dy / d) * 2.5;
  }
  fx(w, 'clash', A.x + ca * bu, A.y + sa * bu);
}

// ── the blobs ──────────────────────────────────────────────────────────────
function nearest(w, x, y) {
  let best = null, bd = Infinity;
  for (const id of Object.keys(w.p)) {
    const f = w.p[id];
    if (f.dn) continue;
    const dx = f.x - x, dy = f.y - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

// A blob is tougher every wave, and the Warden tougher for every blade in the
// dome as well: one fight that a room of eight ends in seconds is no fight.
function spawn(w, k, x, y) {
  const many = k === BOSS ? 1 + 0.3 * (Object.keys(w.p).length - 1) : 1;
  const hp = Math.round(KINDS[k].hp * (1 + 0.1 * (w.wave - 1)) * many);
  w.e.push(shaped(ENEMY, {
    i: w.eid++, k, x, y, vx: 0, vy: 0, hp, mx: hp, t: w.n + GROWS[k] + 20 + Math.floor(draw01(w) * 40),
    st: 0, f: 1, g: 0, b: w.n, hu: -1000, lh: null, lo: 0, hb: {},
  }));
}

function fire(w, x, y, vx, vy) {
  if (w.o.length >= 80) return;
  w.o.push(shaped(ORB, { i: w.oid++, x, y, vx, vy, r: 7, fr: 0, by: null, l: 420 }));
  fx(w, 'spit', x, y);
}

function fall(e, r) {
  e.vy = Math.min(MAXFALL, e.vy + GRAV);
  const oy = e.y;
  e.x += e.vx;
  e.y += e.vy;
  e.g = land(e, oy, r, 0);
  dome(e, r, 0.4);
}

function drift(e, r) {
  e.x += e.vx;
  e.y += e.vy;
  skim(e, r);
  dome(e, r, 0.6);
}

function think(w, e) {
  for (const key of Object.keys(e.hb)) if (w.n - e.hb[key] > HIT_GAP) delete e.hb[key];
  if (!grown(w, e)) return;
  const K = KINDS[e.k];
  const tg = nearest(w, e.x, e.y);
  if (e.k === HOP) {
    fall(e, K.r);
    if (!e.g) return;
    e.vx *= 0.8;
    if (w.n < e.t) return;
    const dir = tg ? (tg.x >= e.x ? 1 : -1) : draw01(w) < 0.5 ? -1 : 1;
    const up = tg && tg.y < e.y - 60 ? 1.3 : 1;
    e.vx = dir * (2.4 + draw01(w) * 2.2);
    e.vy = -(5.8 + draw01(w) * 2.6) * up;
    e.f = dir;
    e.t = w.n + 30 + Math.floor(draw01(w) * 45);
  } else if (e.k === FLY) {
    if (e.st === 0) {
      const gx = tg ? tg.x + dsin(w.n * 0.03 + e.i) * 80 : CX;
      const gy = tg ? tg.y - 120 : 200;
      steer(e, gx, gy, 0.14, 3.2);
      if (tg && w.n >= e.t) {
        const dx = tg.x - e.x, dy = tg.y - e.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        e.vx = (dx / d) * 6.8;
        e.vy = (dy / d) * 6.8;
        e.st = 1;
        e.t = w.n + 45;
      }
    } else {
      e.vx *= 0.99;
      e.vy *= 0.99;
      if (w.n >= e.t) { e.st = 0; e.t = w.n + 100 + Math.floor(draw01(w) * 90); }
    }
    drift(e, K.r);
  } else if (e.k === SPIT) {
    let gx = CX, gy = 150 + dsin(w.n * 0.02 + e.i) * 40;
    if (tg) gx = clamp(tg.x + (e.x < tg.x ? -230 : 230), CX - 360, CX + 360);
    steer(e, gx, gy, 0.08, 2);
    if (tg && w.n >= e.t) {
      const dx = tg.x - e.x, dy = tg.y - e.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      fire(w, e.x + (dx / d) * K.r, e.y + (dy / d) * K.r, (dx / d) * 3.6, (dy / d) * 3.6);
      e.t = w.n + 130 + Math.floor(draw01(w) * 70);
    }
    drift(e, K.r);
  } else if (e.k === BRUTE) {
    // Walks, winds up where it stands, then charges along the floor.
    if (e.st === 0) {
      if (tg) {
        e.f = tg.x >= e.x ? 1 : -1;
        e.vx += clamp(e.f * 1.2 - e.vx, -0.15, 0.15);
        if (e.g && w.n >= e.t && Math.abs(tg.y - e.y) < 90) { e.st = 2; e.t = w.n + 36; }
        else if (e.g && tg.y < e.y - 90 && draw01(w) < 0.012) e.vy = -9.5;
      } else e.vx *= 0.9;
    } else if (e.st === 2) {
      e.vx *= 0.8;
      if (w.n >= e.t) { e.st = 1; e.vx = e.f * 5.4; e.t = w.n + 55; }
    } else {
      e.vx += (e.f * 5.4 - e.vx) * 0.1;
      if (w.n >= e.t) { e.st = 0; e.t = w.n + 150 + Math.floor(draw01(w) * 90); }
    }
    const was = e.vx;
    fall(e, K.r);
    if (e.st === 1 && Math.abs(e.vx) < Math.abs(was) * 0.5) {
      e.st = 0;
      e.t = w.n + 150;
      fx(w, 'vault', e.x + e.f * K.r, e.y, -e.f, 0, 6);
    }
  } else {
    // The Warden drifts across the dome, throws rings of spit, and calls
    // hoppers down; past half its health it throws them faster and thicker.
    const gx = CX + dsin(w.n * 0.009 + 1) * 250, gy = 190 + dsin(w.n * 0.021) * 70;
    steer(e, gx, gy, 0.05, 1.6);
    if (w.n >= e.t) {
      const angry = e.hp * 2 < e.mx;
      const count = angry ? 14 : 10;
      const off = draw01(w) * TAU;
      for (let j = 0; j < count; j++) {
        const a = off + (j * TAU) / count, c = dcos(a), s = dsin(a);
        fire(w, e.x + c * (K.r + 8), e.y + s * (K.r + 8), c * 3, s * 3);
      }
      e.t = w.n + (angry ? 110 : 160);
      e.st += 1;
      if (e.st % 3 === 0 && w.e.length < 14) {
        spawn(w, HOP, e.x - 40, e.y + K.r);
        spawn(w, HOP, e.x + 40, e.y + K.r);
      }
    }
    drift(e, K.r);
  }
}

// Blobs do not stack: overlapping ones are pushed apart, the lighter further.
function crowd(w) {
  const es = w.e;
  for (let i = 0; i < es.length; i++) {
    for (let j = i + 1; j < es.length; j++) {
      const a = es[i], b = es[j];
      const ra = KINDS[a.k].r, rb = KINDS[b.k].r;
      const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, min = ra + rb;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2), over = min - d, ma = KINDS[a.k].m, mb = KINDS[b.k].m;
      const nx = dx / d, ny = dy / d;
      a.x -= nx * over * (mb / (ma + mb)); a.y -= ny * over * (mb / (ma + mb));
      b.x += nx * over * (ma / (ma + mb)); b.y += ny * over * (ma / (ma + mb));
    }
  }
}

// A blob that touches a player hurts them and bounces off.
function touch(w, e) {
  if (!grown(w, e)) return;
  const K = KINDS[e.k];
  for (const id of Object.keys(w.p)) {
    const f = w.p[id];
    if (f.dn) continue;
    const dx = f.x - e.x, dy = f.y - e.y, d2 = dx * dx + dy * dy, min = PR + K.r;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2) || 1, nx = d2 ? dx / d : 0, ny = d2 ? dy / d : -1;
    if (hurt(w, Number(id), f, K.hit, nx, ny)) {
      e.vx -= (nx * 3) / K.m;
      e.vy -= (ny * 3) / K.m;
      if (e.k === FLY) { e.st = 0; e.t = w.n + 80; }
    }
  }
}

function orbs(w) {
  for (const o of w.o) {
    if (o.l <= 0) continue;
    o.x += o.vx;
    o.y += o.vy;
    o.l -= 1;
    const dx = o.x - CX, dy = o.y - FLOOR;
    if (o.y + o.r > FLOOR || dx * dx + dy * dy > (R - o.r) * (R - o.r)) {
      o.l = 0;
      fx(w, 'pop', o.x, o.y, o.fr);
      continue;
    }
    if (o.fr) {
      for (const e of w.e) {
        if (e.hp <= 0 || !grown(w, e)) continue;
        const K = KINDS[e.k], ex = e.x - o.x, ey = e.y - o.y, min = K.r + o.r;
        if (ex * ex + ey * ey >= min * min) continue;
        e.hp -= ORB_DMG;
        e.hu = w.n;
        e.lh = o.by;
        e.lo = 1;
        e.vx += (o.vx * 0.4) / K.m;
        e.vy += (o.vy * 0.4) / K.m;
        o.l = 0;
        const v = Math.sqrt(o.vx * o.vx + o.vy * o.vy) || 1;
        fx(w, 'hit', o.x, o.y, o.vx / v, o.vy / v, ORB_DMG * 8 + e.k);
        break;
      }
    } else {
      for (const id of Object.keys(w.p)) {
        const f = w.p[id];
        if (f.dn) continue;
        const px = f.x - o.x, py = f.y - o.y, min = PR + o.r;
        if (px * px + py * py >= min * min) continue;
        const v = Math.sqrt(o.vx * o.vx + o.vy * o.vy) || 1;
        if (hurt(w, Number(id), f, ORB_HURT, o.vx / v, o.vy / v)) { o.l = 0; break; }
      }
    }
  }
  w.o = w.o.filter((o) => o.l > 0);
}

// The dead are counted to whoever struck last — twice over for a blob killed
// with its own spit, and more for every kill that follows closely on another.
function reap(w) {
  for (const e of w.e) {
    if (e.hp > 0) continue;
    const f = e.lh === null ? undefined : w.p[e.lh];
    let streak = 0;
    if (f) {
      f.cb = w.n <= f.ct ? f.cb + 1 : 1;
      f.ct = w.n + STREAK;
      streak = f.cb;
      f.sc += Math.round(KINDS[e.k].pts * (e.lo ? 2 : 1) * Math.min(3, 1 + 0.25 * (f.cb - 1)));
      f.k += 1;
    }
    fx(w, 'kill', e.x, e.y, e.k, e.lo, streak);
  }
  w.e = w.e.filter((e) => e.hp > 0);
}

// ── the waves ──────────────────────────────────────────────────────────────
function startWave(w, people) {
  w.wave += 1;
  w.ph = FIGHT;
  w.ws = w.n;
  w.sa = w.n + 40;
  const boss = w.wave % 5 === 0;
  let count = Math.round((4 + w.wave * 2) * (1 + 0.35 * (people - 1)));
  w.q = [];
  if (boss) { w.q.push(BOSS); count = Math.round(count / 2); }
  for (let i = 0; i < count; i++) {
    const r = draw01(w);
    w.q.push(w.wave >= 4 && r < 0.14 ? BRUTE : w.wave >= 3 && r < 0.34 ? SPIT : w.wave >= 2 && r < 0.6 ? FLY : HOP);
  }
  fx(w, 'wave', CX, 200, w.wave, boss ? 1 : 0);
}

function clearWave(w) {
  w.ph = BREAK;
  w.pt = w.n + BREAK_STEPS;
  w.best = Math.max(w.best, w.wave);
  w.o = w.o.filter((o) => o.fr);
  for (const id of Object.keys(w.p)) {
    const f = w.p[id];
    if (f.dn) revive(w, f);
    else f.hp = Math.min(HP, f.hp + HEAL);
  }
  fx(w, 'clear', CX, 200, w.wave);
}

function newRun(w) {
  w.wave = 0;
  w.ph = BREAK;
  w.pt = w.n + FIRST_BREAK;
  w.q = [];
  w.e = [];
  w.o = [];
  w.run += 1;
  for (const id of Object.keys(w.p)) {
    const f = w.p[id];
    revive(w, f);
    f.sc = 0;
    f.k = 0;
  }
}

function waves(w) {
  const people = Object.keys(w.p).length;
  if (!people) {
    // An empty dome waits, and whoever walks in next starts from the top.
    if (w.wave || w.e.length || w.o.length || w.ph !== BREAK) newRun(w);
    w.pt = w.n + FIRST_BREAK;
    return;
  }
  if (w.ph === BREAK) {
    if (w.n >= w.pt) startWave(w, people);
    return;
  }
  if (w.ph === OVER) {
    if (w.n >= w.pt) newRun(w);
    return;
  }
  if (w.q.length && w.n >= w.sa && w.e.length < Math.min(18, 5 + 2 * people)) {
    const k = w.q.shift();
    const [x, y] = GATES[Math.floor(draw01(w) * GATES.length)];
    spawn(w, k, x, y);
    w.sa = w.n + SPAWN_GAP;
  }
  if (!w.q.length && !w.e.length) clearWave(w);
  else if (Object.keys(w.p).every((id) => w.p[id].dn)) {
    w.ph = OVER;
    w.pt = w.n + OVER_STEPS;
    w.best = Math.max(w.best, w.wave - 1);
    fx(w, 'over', CX, 200, w.wave);
  }
}

// ── one step ───────────────────────────────────────────────────────────────
function step(w) {
  waves(w);
  const ids = Object.keys(w.p);
  for (const id of ids) move(w, Number(id), w.p[id]);

  const sweeps = new Map();
  for (const id of ids) if (!w.p[id].dn) sweeps.set(id, sweepOf(w.p[id]));
  for (const [id, sw] of sweeps) {
    const f = w.p[id];
    for (const e of w.e) if (grown(w, e)) slash(w, id, sw, f, e);
    for (const o of w.o) if (!o.fr && o.l > 0) parry(w, id, sw, f, o);
  }
  for (const [ia, swA] of sweeps) {
    for (const [ib, swB] of sweeps) {
      if (ia === ib) continue;
      bonk(w, ia, swA, w.p[ia], ib, w.p[ib]);
      if (ia < ib) clash(w, ia, swA, w.p[ia], ib, swB, w.p[ib]);
    }
  }

  for (const e of w.e) think(w, e);
  crowd(w);
  for (const e of w.e) touch(w, e);
  orbs(w);
  reap(w);
  for (const key of Object.keys(w.cd)) if (w.n - w.cd[key] > 60) delete w.cd[key];
}

function hand(w, id, input) {
  if (!w.p[id]) newFighter(w, id);
  w.p[id].h = input;
}

function inputOf(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw < 16 * AIMS ? raw : null;
}

function leave(w, id) {
  delete w.p[id];
  const key = String(id);
  for (const e of w.e) {
    delete e.hb[key];
    if (e.lh === id) e.lh = null;
  }
  for (const o of w.o) if (o.by === id) o.by = null;
  for (const k of Object.keys(w.cd)) if (k.split(/[|>]/).includes(key)) delete w.cd[k];
}

// ── a table off the wire ───────────────────────────────────────────────────
// Somebody else's claim about the dome, read as one: every field of the shape
// it must have, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);

function readShape(raw, spec) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = {};
  for (const [key, type] of spec) {
    const v = raw[key];
    if (type === F) { if (!Number.isFinite(v)) return null; o[key] = v; }
    else if (type === I) { if (!Number.isInteger(v)) return null; o[key] = v; }
    else if (type === N) { if (v !== null && !Number.isInteger(v)) return null; o[key] = v; }
    else {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      const m = {};
      for (const [k, x] of Object.entries(v)) { if (!isId(k) || !Number.isInteger(x)) return null; m[k] = x; }
      o[key] = m;
    }
  }
  return o;
}

function readList(raw, spec, most, ok) {
  if (!Array.isArray(raw) || raw.length > most) return null;
  const out = [];
  for (const item of raw) {
    const o = readShape(item, spec);
    if (!o || !ok(o)) return null;
    out.push(o);
  }
  return out;
}

function tableOf(raw) {
  const t = readShape(raw, TABLE);
  if (!t || t.ph < BREAK || t.ph > OVER) return null;
  if (!Array.isArray(raw.q) || raw.q.length > 200 || !raw.q.every((k) => Number.isInteger(k) && k >= 0 && k < KINDS.length)) return null;
  t.q = raw.q.slice();
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p) || Object.keys(raw.p).length > 16) return null;
  t.p = {};
  for (const [id, q] of Object.entries(raw.p)) {
    const f = readShape(q, FIGHTER);
    if (!isId(id) || !f || inputOf(f.h) === null || f.c < 0 || f.c >= HUES.length) return null;
    t.p[id] = f;
  }
  t.e = readList(raw.e, ENEMY, 64, (e) => e.k >= 0 && e.k < KINDS.length);
  t.o = readList(raw.o, ORB, 200, (o) => o.r > 0 && o.r < 40);
  if (!t.e || !t.o) return null;
  if (!raw.cd || typeof raw.cd !== 'object' || Array.isArray(raw.cd)) return null;
  t.cd = {};
  for (const [k, v] of Object.entries(raw.cd)) {
    if (!/^-?\d{1,12}[|>]-?\d{1,12}$/.test(k) || !Number.isInteger(v)) return null;
    t.cd[k] = v;
  }
  return t;
}

// ═══════════════════ the screen ═══════════════════
document.body.style.cssText =
  'margin:0;height:100vh;overflow:hidden;background:#1c1c1c;touch-action:none;cursor:crosshair;' +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none';

let coarse = matchMedia('(pointer: coarse)').matches;

const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100%;height:100%;background:#1c1c1c';
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');

// The platform's own inks, so a disk in the room looks like it belongs there.
const INK = {
  bg: '#1c1c1c', sunken: '#1f1f1f', surface: '#242424', line: '#2f2f2f', strong: '#3a3a3a',
  text: '#f5f5f5', dim: '#ededed', muted: '#9a9a9a', ok: '#a9c0a9', warn: '#d6c493', danger: '#d3a9a9',
  gold: '#e6c169', goldBg: '#33291a',
};
const FOE = ['#d38f8f', '#d3a0c8', '#d6c493', '#c28a6a', '#e6c169'];
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

let DPR = 1, sc = 1, ox = 0, oy = 0, CW = LW, CH = LH;
function fit() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  CW = canvas.clientWidth || innerWidth;
  CH = canvas.clientHeight || innerHeight;
  canvas.width = Math.round(CW * DPR);
  canvas.height = Math.round(CH * DPR);
  sc = Math.min(CW / LW, CH / LH);
  ox = (CW - LW * sc) / 2;
  oy = (CH - LH * sc) / 2;
}
addEventListener('resize', fit);
fit();

// A size in the world's units that is never smaller than `least` pixels on
// screen: on a phone the dome is small, and its words must not be.
const px = (size, least) => Math.max(size, (least || 10) / sc);
function text(s, x, y, size, colour, align, weight) {
  ctx.font = (weight ? weight + ' ' : '') + size + 'px ' + MONO;
  ctx.fillStyle = colour;
  ctx.textAlign = align || 'center';
  ctx.fillText(s, x, y);
}
// Shrinks a line until it fits the width given.
function fitText(s, x, y, size, colour, most, align) {
  ctx.font = size + 'px ' + MONO;
  const wide = ctx.measureText(s).width;
  text(s, x, y, wide > most ? (size * most) / wide : size, colour, align);
}

function nickOf(id) {
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((pp) => pp.id === id);
  return p ? p.nick : '???';
}

// ── what a frame shows ─────────────────────────────────────────────────────
const lerp = (a, b, k) => a + (b - a) * k;

function scene(b, m) {
  const me = String(myId());
  const fighters = [];
  for (const id of Object.keys(b.to.p)) {
    const pair = id === me && m && m.to.p[id] ? m : b;
    const f = pair.to.p[id], o = pair.from.p[id];
    const same = o && o.s === f.s;
    const k = pair.k;
    fighters.push({
      id: Number(id), f, x: same ? lerp(o.x, f.x, k) : f.x, y: same ? lerp(o.y, f.y, k) : f.y,
      a: same ? o.a + wrap(f.a - o.a) * k : f.a, spin: f.w, n: lerp(pair.from.n, pair.to.n, k),
    });
  }
  const before = new Map(b.from.e.map((e) => [e.i, e]));
  const enemies = b.to.e.map((e) => {
    const o = before.get(e.i);
    return { e, x: o ? lerp(o.x, e.x, b.k) : e.x, y: o ? lerp(o.y, e.y, b.k) : e.y };
  });
  const orbsBefore = new Map(b.from.o.map((o) => [o.i, o]));
  const balls = b.to.o.map((o) => {
    const p = orbsBefore.get(o.i);
    return { o, x: p && p.fr === o.fr ? lerp(p.x, o.x, b.k) : o.x, y: p && p.fr === o.fr ? lerp(p.y, o.y, b.k) : o.y };
  });
  return {
    t: b.to, n: lerp(b.from.n, b.to.n, b.k), fighters, enemies, balls,
    me: fighters.find((q) => q.id === myId()) || null,
  };
}

// ── things that fly off ────────────────────────────────────────────────────
let bits = [];          // particles: sparks, gibs, dust, rings, numbers
let shake = 0;
let hurtFlash = 0;

function burst(x, y, n, colour, speed, opts) {
  const o = opts || {};
  for (let i = 0; i < n; i++) {
    const a = o.dir !== undefined ? o.dir + (Math.random() - 0.5) * (o.spread || 1.2) : Math.random() * TAU;
    const v = speed * (0.35 + Math.random() * 0.8);
    bits.push({
      kind: o.kind || 'dot', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: o.g === undefined ? 0.12 : o.g,
      r: (o.r || 2.5) * (0.6 + Math.random() * 0.8), life: 1, decay: o.decay || 0.03 + Math.random() * 0.02, col: colour,
    });
  }
}
function ring(x, y, r, colour, decay) {
  bits.push({ kind: 'ring', x, y, vx: 0, vy: 0, g: 0, r, life: 1, decay: decay || 0.06, col: colour });
}
function words(s, x, y, colour, size) {
  bits.push({ kind: 'text', s, x, y, vx: 0, vy: -1.1, g: 0.02, r: size || 14, life: 1, decay: 0.022, col: colour });
}

function play(e) {
  switch (e.kind) {
    case 'hit': {
      const dmg = e.c >> 3, kind = e.c & 7;
      burst(e.x, e.y, 6 + Math.min(10, dmg >> 2), INK.text, 3 + dmg * 0.12, { dir: Math.atan2(e.b, e.a), spread: 1.1, kind: 'spark', g: 0 });
      burst(e.x, e.y, 3 + Math.min(8, dmg >> 3), FOE[kind], 2 + dmg * 0.08, { dir: Math.atan2(e.b, e.a), spread: 1.6 });
      words(String(dmg), e.x, e.y - 10, dmg >= 30 ? INK.gold : dmg >= 15 ? INK.dim : INK.muted, dmg >= 30 ? 20 : 15);
      shake = Math.max(shake, Math.min(9, dmg * 0.18));
      sound.hit(dmg);
      break;
    }
    case 'tink':
      burst(e.x, e.y, 5, INK.muted, 3, { dir: Math.atan2(-e.b, -e.a), spread: 1.4, kind: 'spark', g: 0 });
      words('tink', e.x, e.y - 12, INK.muted, 12);
      sound.tink();
      break;
    case 'kill': {
      const K = KINDS[e.a];
      burst(e.x, e.y, 14 + K.r, FOE[e.a], 3 + K.r * 0.08, { r: 3 + K.r * 0.08, decay: 0.012 });
      ring(e.x, e.y, K.r, FOE[e.a], 0.05);
      if (e.b) words('own spit ×2', e.x, e.y - K.r - 6, INK.gold, 14);
      if (e.c >= 2) words('streak ' + e.c, e.x, e.y - K.r - (e.b ? 24 : 6), e.c >= 5 ? INK.gold : INK.ok, 13 + Math.min(8, e.c));
      shake = Math.max(shake, e.a === BOSS ? 22 : 4 + K.r * 0.12);
      sound.kill(e.a);
      break;
    }
    case 'clash':
      burst(e.x, e.y, 16, INK.text, 5, { kind: 'spark', g: 0, decay: 0.05 });
      ring(e.x, e.y, 6, INK.text, 0.09);
      shake = Math.max(shake, 5);
      sound.clash();
      break;
    case 'parry':
      ring(e.x, e.y, 8, HUES[e.a] || INK.text, 0.07);
      burst(e.x, e.y, 8, HUES[e.a] || INK.text, 3.5, { kind: 'spark', g: 0 });
      sound.parry();
      break;
    case 'block':
      burst(e.x, e.y, 7, INK.warn, 2.2, { g: 0.05 });
      sound.tink();
      break;
    case 'bonk':
      words('bonk', e.x, e.y - 10, INK.muted, 12);
      sound.bonk();
      break;
    case 'vault':
      burst(e.x, e.y, 5 + Math.round(e.c), INK.muted, 1.5 + e.c * 0.3, { dir: Math.atan2(e.b, e.a), spread: 2.2, g: 0.08 });
      sound.thud(e.c);
      break;
    case 'jump':
      burst(e.x, e.y, 4, INK.strong, 1.4, { dir: -PI / 2, spread: 2.6, g: 0.02, r: 2 });
      break;
    case 'hurt':
      ring(e.x, e.y, PR, INK.danger, 0.08);
      burst(e.x, e.y, 6, INK.danger, 2.5);
      if (e.a === myId()) { hurtFlash = 1; shake = Math.max(shake, 8); }
      sound.hurt(e.a === myId());
      break;
    case 'down':
      burst(e.x, e.y, 26, HUES[e.b] || INK.text, 4.5, { r: 3.4, decay: 0.012 });
      ring(e.x, e.y, PR * 1.4, INK.danger, 0.03);
      if (e.a === myId()) { hurtFlash = 1.4; shake = Math.max(shake, 14); }
      sound.down();
      break;
    case 'pop':
      burst(e.x, e.y, 4, e.a ? INK.dim : INK.warn, 1.6, { g: 0.04, r: 2 });
      break;
    case 'spit':
      sound.spit();
      break;
    case 'wave':
      sound.wave(e.b);
      break;
    case 'clear':
      sound.clear();
      break;
    case 'over':
      sound.over();
      break;
  }
}

function moveBits(steps) {
  for (let s = 0; s < steps; s++) {
    for (const p of bits) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.97;
      p.vy = p.vy * 0.97 + p.g;
      if (p.kind === 'dot' && p.y > FLOOR - p.r) { p.y = FLOOR - p.r; p.vy *= -0.35; p.vx *= 0.7; }
      if (p.kind === 'ring') p.r += 1.4;
      p.life -= p.decay;
    }
    shake *= 0.86;
    hurtFlash *= 0.93;
  }
  bits = bits.filter((p) => p.life > 0);
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}

function drawBits() {
  for (const p of bits) {
    const a = Math.max(0, Math.min(1, p.life));
    ctx.globalAlpha = a;
    if (p.kind === 'spark') {
      ctx.strokeStyle = p.col;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2);
      ctx.stroke();
    } else if (p.kind === 'ring') {
      ctx.strokeStyle = p.col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.stroke();
    } else if (p.kind === 'text') {
      text(p.s, p.x, p.y, px(p.r, 9), p.col, 'center', '600');
    } else {
      ctx.fillStyle = p.col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ── sound ──────────────────────────────────────────────────────────────────
// Made in the page, from nothing: a few oscillators and a burst of noise. It
// starts on the first key or touch, because a browser keeps a page silent
// until then; M turns it off.
let actx = null;
let muted = false;
let noiseBuf = null;
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
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}
function hiss(dur, vol, freq, q) {
  if (!noiseBuf) {
    noiseBuf = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.5), actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = actx.currentTime;
  const s = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  s.buffer = noiseBuf;
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q || 1;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f);
  f.connect(g);
  g.connect(actx.destination);
  s.start(t);
  s.stop(t + dur + 0.02);
}
const sound = {
  hit(dmg) { if (ready('hit', 30)) { hiss(0.09, 0.22, 1400 + dmg * 30, 0.8); tone(160 + dmg * 3, 0.1, 'triangle', 0.18, 0.5); } },
  tink() { if (ready('tink', 40)) tone(1900, 0.08, 'square', 0.05, 0.8); },
  kill(k) { if (ready('kill', 30)) { hiss(k === BOSS ? 0.8 : 0.22, 0.25, k === BOSS ? 300 : 700, 0.7); tone(k === BOSS ? 70 : 220 - k * 30, k === BOSS ? 0.9 : 0.2, 'sine', 0.25, 0.35); } },
  clash() { if (ready('clash', 60)) { tone(1320, 0.25, 'triangle', 0.12, 0.97); tone(1980, 0.18, 'sine', 0.07, 0.98); hiss(0.05, 0.15, 5000, 1.5); } },
  parry() { if (ready('parry', 50)) { tone(520, 0.14, 'triangle', 0.14, 2.2); } },
  bonk() { if (ready('bonk', 80)) tone(240, 0.09, 'sine', 0.16, 0.6); },
  thud(k) { if (ready('thud', 60)) { tone(90, 0.12, 'sine', 0.1 + k * 0.02, 0.5); hiss(0.06, 0.08, 400, 0.8); } },
  hurt(mine) { if (ready('hurt', 80)) tone(mine ? 300 : 380, 0.18, 'sawtooth', mine ? 0.1 : 0.04, 0.4); },
  down() { if (ready('down', 200)) { tone(420, 0.6, 'sawtooth', 0.09, 0.2); } },
  spit() { if (ready('spit', 70)) { tone(700, 0.08, 'sine', 0.04, 0.5); } },
  wave(boss) { if (ready('wave', 400)) { tone(boss ? 110 : 330, 0.35, 'triangle', 0.12); tone(boss ? 104 : 495, 0.45, 'triangle', 0.1, 1, 0.16); } },
  clear() { if (ready('clear', 400)) { tone(523, 0.2, 'triangle', 0.1); tone(659, 0.2, 'triangle', 0.1, 1, 0.1); tone(784, 0.35, 'triangle', 0.1, 1, 0.2); } },
  over() { if (ready('over', 400)) { tone(330, 0.4, 'triangle', 0.1, 0.7); tone(220, 0.7, 'triangle', 0.1, 0.6, 0.3); } },
  swish(speed) { if (ready('swish', 140)) hiss(0.12, Math.min(0.12, speed * 0.2), 900 + speed * 1600, 1.2); },
};

// ── drawing ────────────────────────────────────────────────────────────────
const trails = new Map();         // player id -> the last few blades drawn, for the smear behind a swing

function drawDome() {
  ctx.fillStyle = INK.sunken;
  ctx.beginPath();
  ctx.arc(CX, FLOOR, R, PI, TAU);
  ctx.closePath();
  ctx.fill();
  // Ribs and rings, the dome's frame, faint.
  ctx.strokeStyle = '#232323';
  ctx.lineWidth = 1;
  for (let k = 1; k < 12; k++) {
    const a = PI + (k * PI) / 12;
    ctx.beginPath();
    ctx.moveTo(CX + Math.cos(a) * 60, FLOOR + Math.sin(a) * 60);
    ctx.lineTo(CX + Math.cos(a) * R, FLOOR + Math.sin(a) * R);
    ctx.stroke();
  }
  for (const f of [0.33, 0.66]) {
    ctx.beginPath();
    ctx.arc(CX, FLOOR, R * f, PI, TAU);
    ctx.stroke();
  }
  for (const [x1, x2, top] of PLATFORMS) {
    ctx.fillStyle = '#292929';
    ctx.fillRect(x1, top, x2 - x1, 9);
    ctx.fillStyle = '#4a4a4a';
    ctx.fillRect(x1, top, x2 - x1, 2);
  }
}

// Drawn over everything that may poke into it, so a blade buried in the floor
// or the shell looks buried.
function drawShell() {
  // The canvas in the world's units, a little over: a tall phone has room
  // above and below the dome, and the ground goes on down into it.
  const l = -ox / sc - 40, t = -oy / sc - 40, r = (CW - ox) / sc + 40, b = (CH - oy) / sc + 40;
  ctx.fillStyle = INK.bg;
  ctx.beginPath();
  ctx.rect(l, t, r - l, FLOOR - t);
  ctx.moveTo(CX + R, FLOOR);
  ctx.arc(CX, FLOOR, R, 0, PI, true);
  ctx.closePath();
  ctx.fill('evenodd');
  ctx.fillStyle = INK.surface;
  ctx.fillRect(l, FLOOR, r - l, b - FLOOR);
  ctx.strokeStyle = INK.strong;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CX, FLOOR, R + 1, PI, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(CX - R - 30, FLOOR + 1);
  ctx.lineTo(CX + R + 30, FLOOR + 1);
  ctx.stroke();
  // The gates in the roof.
  ctx.fillStyle = INK.strong;
  for (const [gx, gy] of GATES) {
    const a = Math.atan2(gy - FLOOR, gx - CX);
    ctx.beginPath();
    ctx.arc(CX + Math.cos(a) * (R + 1), FLOOR + Math.sin(a) * (R + 1), 5, 0, TAU);
    ctx.fill();
  }
}

function drawFighter(q, now, S) {
  const { f, x, y, a } = q;
  const hue = HUES[f.c];
  const mine = q.id === myId();
  if (f.dn) {
    if (S.t.ph !== FIGHT) return;
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = hue;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, PR, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const back = Math.max(0, Math.ceil((f.dn - S.n) / HZ));
    text(String(back), x, y + 4, px(12), INK.muted);
    return;
  }
  const blink = S.n < f.iv && Math.floor(now / 70) % 2 === 0;
  ctx.globalAlpha = blink ? 0.45 : 1;

  // The smear behind a swing: the last few blades drawn, faded.
  const c = Math.cos(a), s = Math.sin(a);
  const trail = trails.get(q.id) || [];
  trail.push({ x, y, a });
  while (trail.length > 7) trail.shift();
  trails.set(q.id, trail);
  for (let i = 1; i < trail.length; i++) {
    const p0 = trail[i - 1], p1 = trail[i];
    const turn = Math.abs(wrap(p1.a - p0.a));
    if (turn < 0.04 || turn > 1.2) continue;
    ctx.globalAlpha = (blink ? 0.45 : 1) * Math.min(0.5, turn * 1.6) * (i / trail.length);
    ctx.fillStyle = hue;
    ctx.beginPath();
    ctx.moveTo(p0.x + Math.cos(p0.a) * HILT, p0.y + Math.sin(p0.a) * HILT);
    ctx.lineTo(p0.x + Math.cos(p0.a) * BLADE, p0.y + Math.sin(p0.a) * BLADE);
    ctx.lineTo(p1.x + Math.cos(p1.a) * BLADE, p1.y + Math.sin(p1.a) * BLADE);
    ctx.lineTo(p1.x + Math.cos(p1.a) * HILT, p1.y + Math.sin(p1.a) * HILT);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = blink ? 0.45 : 1;

  // Feet, walking when the body moves along the ground.
  const stride = f.g ? Math.sin(x * 0.18) * Math.min(1, Math.abs(f.vx) / 2) : 0.6;
  ctx.fillStyle = hue;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + side * 7 + stride * side * 3, y + PR - 1 - (f.g ? Math.max(0, stride * side) * 3 : 0), 5, 3, 0, 0, TAU);
    ctx.fill();
  }
  // The body, squashed a little by how fast it falls or rises.
  const squash = clamp(f.vy * 0.025, -0.18, 0.18);
  ctx.beginPath();
  ctx.ellipse(x, y, PR * (1 - squash * 0.6), PR * (1 + squash), 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = INK.bg;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Eyes that look where the blade points.
  const ex = c * 4, ey = s * 3;
  ctx.fillStyle = INK.bg;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + ex + side * 5, y - 3 + ey, 2.3, 0, TAU);
    ctx.fill();
  }

  // The blade: a guard in the player's colour, and the edge.
  const hx = x + c * HILT, hy = y + s * HILT;
  const tx = x + c * BLADE, ty = y + s * BLADE;
  const fast = Math.min(1, Math.abs(q.spin) / 0.3);
  if (fast > 0.2) {
    ctx.strokeStyle = hue;
    ctx.globalAlpha = (blink ? 0.45 : 1) * 0.35 * fast;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.globalAlpha = blink ? 0.45 : 1;
  }
  ctx.strokeStyle = INK.text;
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.strokeStyle = hue;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(hx - s * 6, hy + c * 6);
  ctx.lineTo(hx + s * 6, hy - c * 6);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.globalAlpha = 1;

  // Name and health.
  const top = y - PR - 22;
  text(nickOf(q.id), x, top, px(11, 9), mine ? INK.text : INK.muted);
  const frac = f.hp / HP;
  ctx.fillStyle = INK.line;
  ctx.fillRect(x - 16, top + 5, 32, 3);
  ctx.fillStyle = frac > 0.5 ? INK.ok : frac > 0.25 ? INK.warn : INK.danger;
  ctx.fillRect(x - 16, top + 5, 32 * frac, 3);
}

function drawEnemy(q, S, now) {
  const { e, x, y } = q;
  const K = KINDS[e.k];
  const age = S.n - e.b;
  const hue = FOE[e.k];
  if (age < GROWS[e.k]) {
    // Coming through the roof: a ring closing in on a body that grows.
    const k = Math.max(0, age / GROWS[e.k]);
    ctx.strokeStyle = hue;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, K.r * (2.6 - 1.6 * k), 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.25 + 0.5 * k;
    ctx.fillStyle = hue;
    ctx.beginPath();
    ctx.arc(x, y, K.r * k, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  const flash = S.n - e.hu < 5;
  const tg = S.fighters.filter((q2) => !q2.f.dn).reduce((best, q2) => {
    const d = (q2.x - x) ** 2 + (q2.y - y) ** 2;
    return !best || d < best.d ? { q: q2, d } : best;
  }, null);
  const look = tg ? Math.atan2(tg.q.y - y, tg.q.x - x) : PI / 2;
  const fill = flash ? INK.text : hue;
  let jx = 0;
  const tell = (e.k === BRUTE && e.st === 2) || (e.k === FLY && e.st === 0 && e.t - S.n < 22 && e.t - S.n > 0) ||
               (e.k === SPIT && e.t - S.n < 26 && e.t - S.n > 0);
  if (tell) jx = Math.sin(now * 0.08) * 1.5;

  ctx.fillStyle = fill;
  if (e.k === HOP) {
    const sq = clamp(e.vy * 0.04, -0.3, 0.3) * (e.g ? 0 : 1) + (e.g ? 0.15 * Math.max(0, 1 - (e.t - S.n) / 20) : 0);
    ctx.beginPath();
    ctx.ellipse(x, y + K.r * sq * 0.5, K.r * (1 + sq * 0.6), K.r * (1 - sq), 0, 0, TAU);
    ctx.fill();
  } else if (e.k === FLY) {
    const flap = Math.sin(now * 0.03 + e.i) * 0.6;
    ctx.beginPath();
    for (const side of [-1, 1]) {
      ctx.moveTo(x + side * K.r * 0.6, y);
      ctx.lineTo(x + side * K.r * 2.1, y - K.r * (0.4 + flap));
      ctx.lineTo(x + side * K.r * 1.5, y + K.r * 0.4);
      ctx.closePath();
    }
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + jx, y, K.r, 0, TAU);
    ctx.fill();
  } else if (e.k === SPIT) {
    ctx.beginPath();
    ctx.arc(x + jx, y, K.r, 0, TAU);
    ctx.fill();
    if (tell) {
      const k = 1 - (e.t - S.n) / 26;
      ctx.strokeStyle = INK.warn;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, K.r + 4 + 6 * (1 - k), 0, TAU);
      ctx.stroke();
    }
  } else if (e.k === BRUTE) {
    ctx.beginPath();
    ctx.arc(x + jx, y, K.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = flash ? INK.text : '#8a5f47';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x + jx, y, K.r - 5, PI * 1.1, PI * 1.9);
    ctx.stroke();
  } else {
    // The Warden: a dark core in a gold shell with a ring of teeth turning.
    ctx.fillStyle = INK.goldBg;
    ctx.beginPath();
    ctx.arc(x, y, K.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = flash ? INK.text : INK.gold;
    ctx.lineWidth = 4;
    ctx.stroke();
    const angry = e.hp * 2 < e.mx;
    const turn = now * (angry ? 0.004 : 0.0022);
    ctx.fillStyle = flash ? INK.text : INK.gold;
    for (let j = 0; j < 12; j++) {
      const a = turn + (j * TAU) / 12;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * (K.r - 10), y + Math.sin(a) * (K.r - 10), 3.2, 0, TAU);
      ctx.fill();
    }
    const soon = e.t - S.n < 30 && e.t - S.n > 0;
    ctx.fillStyle = soon || angry ? INK.danger : INK.gold;
    ctx.beginPath();
    ctx.arc(x + Math.cos(look) * 8, y + Math.sin(look) * 8, 12, 0, TAU);
    ctx.fill();
    ctx.fillStyle = INK.bg;
    ctx.beginPath();
    ctx.arc(x + Math.cos(look) * 12, y + Math.sin(look) * 12, 5, 0, TAU);
    ctx.fill();
    return;
  }
  // An eye, on the one that looks for you.
  const er = e.k === BRUTE ? 5 : 4.5;
  const exx = x + jx + Math.cos(look) * K.r * 0.35, eyy = y + Math.sin(look) * K.r * 0.3 - K.r * 0.15;
  ctx.fillStyle = INK.dim;
  ctx.beginPath();
  ctx.arc(exx, eyy, er, 0, TAU);
  ctx.fill();
  ctx.fillStyle = (e.k === BRUTE && e.st !== 0) || (e.k === FLY && e.st === 1) ? '#b04040' : INK.bg;
  ctx.beginPath();
  ctx.arc(exx + Math.cos(look) * 2, eyy + Math.sin(look) * 2, er * 0.5, 0, TAU);
  ctx.fill();
  if (e.mx > 20 && e.hp < e.mx) {
    ctx.fillStyle = INK.line;
    ctx.fillRect(x - K.r, y - K.r - 9, K.r * 2, 3);
    ctx.fillStyle = hue;
    ctx.fillRect(x - K.r, y - K.r - 9, K.r * 2 * Math.max(0, e.hp / e.mx), 3);
  }
}

function drawOrb(q, S) {
  const { o, x, y } = q;
  const hue = o.fr ? (S.t.p[o.by] ? HUES[S.t.p[o.by].c] : INK.dim) : INK.warn;
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = hue;
  ctx.beginPath();
  ctx.arc(x - o.vx * 1.5, y - o.vy * 1.5, o.r * 0.8, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, o.r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = o.fr ? INK.text : '#8a7a4a';
  ctx.beginPath();
  ctx.arc(x, y, o.r * 0.45, 0, TAU);
  ctx.fill();
}

// The corners of the screen, in pixels rather than the world's units: on a
// phone held upright the dome is a strip across the middle, and the words
// belong in the room around it rather than squeezed into its corners.
function drawCorners(S) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const t = S ? S.t : null;
  if (t) {
    const alive = t.e.length + t.q.length;
    text(t.wave ? 'WAVE ' + t.wave : 'BLADE DOME', 14, 28, 20, INK.text, 'left', '600');
    const sub = t.ph === FIGHT ? alive + ' left' : t.ph === OVER ? 'the dome fell' : t.wave ? 'cleared' : 'get ready';
    text(sub + (t.best ? ' · best ' + t.best : ''), 14, 46, 12, INK.muted, 'left');

    // Everybody, best first.
    const rows = S.fighters.slice().sort((a, b) => b.f.sc - a.f.sc || a.id - b.id);
    rows.forEach((q, i) => {
      const y = 22 + i * 18;
      const mine = q.id === myId();
      ctx.fillStyle = HUES[q.f.c];
      ctx.fillRect(CW - 158, y - 8, 8, 8);
      const name = nickOf(q.id);
      text(name.length > 11 ? name.slice(0, 10) + '…' : name, CW - 144, y, 12, mine ? INK.text : INK.muted, 'left');
      text(q.f.dn ? 'down' : String(q.f.sc), CW - 14, y, 12, q.f.dn ? INK.danger : mine ? INK.text : INK.muted, 'right');
    });
  }

  // Under the floor: how to play, and what the wire costs.
  const how = coarse
    ? 'left thumb runs · up jumps · right thumb swings the blade'
    : 'A D run · W or space jumps, twice, and off the walls · S drops · the mouse swings the blade · M ' + (muted ? 'sound on' : 'mutes');
  const under = Math.min(CH - 30, oy + FLOOR * sc + 20);
  fitText(how, CW / 2, under, 12, INK.muted, CW - 24);
  fitText(wireNote(), CW / 2, under + 17, 11, '#6a6a6a', CW - 24);
}

function drawHud(S) {
  const t = S.t;
  const me = S.me;

  // The Warden's health, across the top of the dome.
  const boss = S.enemies.find((q) => q.e.k === BOSS && S.n - q.e.b >= GROWS[BOSS]);
  if (boss) {
    const wide = 320;
    ctx.fillStyle = INK.line;
    ctx.fillRect(CX - wide / 2, 64, wide, 5);
    ctx.fillStyle = INK.gold;
    ctx.fillRect(CX - wide / 2, 64, wide * Math.max(0, boss.e.hp / boss.e.mx), 5);
    text('THE WARDEN', CX, 58, px(11, 9), INK.gold, 'center', '600');
  }

  // The middle: whatever the dome is doing between fights.
  const secs = (to) => Math.max(0, Math.ceil((to - S.n) / HZ));
  if (t.ph === BREAK) {
    if (!t.wave) {
      text('BLADE DOME', CX, 190, px(40, 18), INK.text, 'center', '700');
      text('the blobs come in ' + secs(t.pt), CX, 222, px(14, 10), INK.muted);
      text('swing fast — the tip bites hardest · bat the spit back', CX, 244, px(12, 9), INK.muted);
    } else {
      text('WAVE ' + t.wave + ' CLEARED', CX, 200, px(26, 14), INK.ok, 'center', '700');
      const next = t.wave + 1;
      text((next % 5 === 0 ? 'the Warden comes in ' : 'wave ' + next + ' in ') + secs(t.pt), CX, 228, px(14, 10), INK.muted);
    }
  } else if (t.ph === FIGHT && S.n - t.ws < 110) {
    const boss5 = t.wave % 5 === 0;
    ctx.globalAlpha = Math.min(1, (110 - (S.n - t.ws)) / 30);
    text('WAVE ' + t.wave, CX, 200, px(34, 16), boss5 ? INK.gold : INK.text, 'center', '700');
    if (boss5) text('the Warden', CX, 228, px(16, 10), INK.gold);
    ctx.globalAlpha = 1;
  } else if (t.ph === OVER) {
    text('THE DOME FELL', CX, 190, px(34, 16), INK.danger, 'center', '700');
    text('held ' + Math.max(0, t.wave - 1) + (t.wave - 1 === 1 ? ' wave' : ' waves') + ' · again in ' + secs(t.pt), CX, 222, px(14, 10), INK.muted);
  }
  if (me && !me.f.dn && me.f.cb >= 2 && S.n <= me.f.ct) {
    ctx.globalAlpha = Math.min(1, (me.f.ct - S.n) / 40);
    text('streak ' + me.f.cb + ' · ×' + Math.round(Math.min(3, 1 + 0.25 * (me.f.cb - 1)) * 100) / 100,
         me.x, me.y - PR - 38, px(12, 9), me.f.cb >= 5 ? INK.gold : INK.ok, 'center', '600');
    ctx.globalAlpha = 1;
  }
  if (me && me.f.dn && t.ph === FIGHT) {
    text('down — back in ' + secs(me.f.dn), CX, 300, px(14, 10), INK.danger);
  }
}

function draw(S, now) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = INK.bg;
  ctx.fillRect(0, 0, CW, CH);
  const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;
  ctx.setTransform(DPR * sc, 0, 0, DPR * sc, DPR * (ox + sx * sc), DPR * (oy + sy * sc));
  drawDome();
  if (!S) {
    drawShell();
    text('catching up with the dome', CX, 250, px(15, 10), INK.muted);
    drawCorners(null);
    return;
  }
  for (const q of S.balls) drawOrb(q, S);
  for (const q of S.enemies) drawEnemy(q, S, now);
  for (const q of S.fighters) if (q.id !== myId()) drawFighter(q, now, S);
  if (S.me) drawFighter(S.me, now, S);
  drawShell();
  drawBits();
  drawHud(S);
  drawCorners(S);

  if (hurtFlash > 0.02) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.strokeStyle = INK.danger;
    ctx.globalAlpha = Math.min(1, hurtFlash);
    ctx.lineWidth = 10;
    ctx.strokeRect(0, 0, CW, CH);
    ctx.globalAlpha = 1;
  }
}

// ═══════════════════ the hands ═══════════════════
// A hand is one whole number: left, right, jump and down in the low four bits,
// and the blade's angle, one of 256, above them.
const keys = new Set();
const CODES = {
  KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r', KeyW: 'j', ArrowUp: 'j', Space: 'j', KeyS: 'd', ArrowDown: 'd',
};
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { muted = !muted; return; }
  const k = CODES[e.code];
  if (!k) return;
  e.preventDefault();
  keys.add(k);
});
addEventListener('keyup', (e) => {
  const k = CODES[e.code];
  if (k) keys.delete(k);
});
addEventListener('blur', () => { keys.clear(); runStick = aimStick = null; paintSticks(); });
addEventListener('contextmenu', (e) => e.preventDefault());

let mouse = null;               // in the world's units
let myAim = -PI / 2;
addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const box = canvas.getBoundingClientRect();
  mouse = { x: (e.clientX - box.left - ox) / sc, y: (e.clientY - box.top - oy) / sc };
});
addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') wake(); });

// Two thumbs on a phone. The left runs, and pushed up it jumps, pushed down it
// drops; the right points the blade the way it is pushed, so a thumb drawn round
// in a circle is a blade swung in one. Dragged rather than held, because iOS
// keeps a long press inside a frame for itself.
const OVER_X = 14, OVER_Y = 30, DEAD = 10, REACHOUT = 46;
let runStick = null, aimStick = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  coarse = true;
  wake();
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  const st = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
  if (e.clientX < innerWidth / 2) { if (!runStick) runStick = st; }
  else if (!aimStick) aimStick = st;
  paintSticks();
});
canvas.addEventListener('pointermove', (e) => {
  const st = runStick && e.pointerId === runStick.pointerId ? runStick
           : aimStick && e.pointerId === aimStick.pointerId ? aimStick : null;
  if (!st) return;
  st.dx = e.clientX - st.ox;
  st.dy = e.clientY - st.oy;
  if (st === aimStick && Math.hypot(st.dx, st.dy) >= DEAD) myAim = Math.atan2(st.dy, st.dx);
  paintSticks();
});
const lift = (e) => {
  if (runStick && e.pointerId === runStick.pointerId) runStick = null;
  if (aimStick && e.pointerId === aimStick.pointerId) aimStick = null;
  paintSticks();
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

function stickParts(colour) {
  const ringEl = document.createElement('div');
  ringEl.style.cssText =
    `position:fixed;display:none;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
    `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;pointer-events:none;` +
    `border:1px solid ${INK.strong};background:rgba(154,154,154,0.06)`;
  const knob = document.createElement('div');
  knob.style.cssText =
    'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
    `border-radius:50%;pointer-events:none;opacity:.7;background:${colour}`;
  document.body.append(ringEl, knob);
  return { ring: ringEl, knob };
}
const runParts = stickParts(INK.dim);
const aimParts = stickParts(INK.warn);
function paintStick(st, parts) {
  if (!st) { parts.ring.style.display = parts.knob.style.display = 'none'; return; }
  const far = Math.hypot(st.dx, st.dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
  parts.ring.style.display = parts.knob.style.display = 'block';
  parts.ring.style.left = st.ox + 'px';
  parts.ring.style.top = st.oy + 'px';
  parts.knob.style.left = st.ox + st.dx * k + 'px';
  parts.knob.style.top = st.oy + st.dy * k + 'px';
}
function paintSticks() {
  paintStick(runStick, runParts);
  paintStick(aimStick, aimParts);
}

function heldBits() {
  if (runStick) {
    return (runStick.dx <= -OVER_X ? 1 : 0) | (runStick.dx >= OVER_X ? 2 : 0) |
           (runStick.dy <= -OVER_Y ? 4 : 0) | (runStick.dy >= OVER_Y ? 8 : 0);
  }
  return (keys.has('l') ? 1 : 0) | (keys.has('r') ? 2 : 0) | (keys.has('j') ? 4 : 0) | (keys.has('d') ? 8 : 0);
}

// What the hand says. The keys go out the moment they change; the angle alone
// goes out no oftener than once every AIM_EVERY, because it changes with every
// twitch of the mouse, and the clock's ticks and this hand share one seat's ceiling on
// messages. The spring in the blade smooths over the gaps between them.
const AIM_EVERY = 55;
let aimSentAt = -1e9;
let said = null;
function sayHand(now) {
  const held = heldBits();
  const idx = ((Math.round(((myAim + PI) / TAU) * AIMS) % AIMS) + AIMS) % AIMS;
  const next = held | (idx << 4);
  if (said !== null && next === said) return;
  if (said !== null && (said & 15) === held && now - aimSentAt < AIM_EVERY) return;
  said = next;
  aimSentAt = now;
  setHand(next);
}

// ═══════════════════ the frame ═══════════════════
let bitsClock = performance.now();
let lastSpin = 0;
function frame(now) {
  const b = agreedAt(now);
  const S = b ? scene(b, mineAt(now)) : null;
  if (S) {
    for (let i = 0; i < fxq.length;) {
      // One far ahead of the drawing belongs to a table this copy has since
      // dropped for the room's.
      if (fxq[i].n > S.n + 600) fxq.splice(i, 1);
      else if (fxq[i].n <= S.n + 0.5) play(fxq.splice(i, 1)[0]);
      else i++;
    }
    // The aim is taken against the blob as drawn, which is where you are.
    if (S.me && mouse && !aimStick) myAim = Math.atan2(mouse.y - S.me.y, mouse.x - S.me.x);
    const spin = S.me ? Math.abs(S.me.spin) : 0;
    if (spin > 0.26 && lastSpin <= 0.26) sound.swish(spin);
    lastSpin = spin;
  }
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  sayHand(now);
  draw(S, now);
  requestAnimationFrame(frame);
}

function start() {
  sayHand(performance.now());
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
