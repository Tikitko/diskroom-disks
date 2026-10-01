/**
 * @disk     ragdoll_clash
 * @author   diskroom
 * @version  27
 * @players  1-8
 * @about    A ragdoll brawl. Push your whole body with the arrow keys, WASD or a thumb, tumble into your opponent, and knock their damage up until they come apart.
 * @tags     fighting, physics, ragdoll, pvp, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/ragdoll_clash.png
 */
// ragdoll_clash.js — the brawl where the room's order is the referee.
//
// The legacy ragdoll_clash.js (disks/legacy/ragdoll_clash.js) runs the fight on
// the host, sends its bodies every 90 ms, and every other copy pulls its own
// bodies toward them — a chaotic physics fight parts from any copy of itself
// within moments, so the host's has to be dragged back in. Here nothing is
// dragged back, because nothing parts: the pushes are sent with `{ echo: true
// }`, every copy applies them at the same place between the same two steps, and
// the fight is the same arithmetic on the same numbers everywhere. Only the
// pushes and the ticks travel. Damage is counted by every copy, and every copy
// counts the same.
//
// For that the physics has to come out the same on every machine to the last
// bit, so a distance here is a square root rather than `Math.hypot`, an angle
// is `datan2` rather than `Math.atan2`, and the dummy's mind is drawn from the
// table's own random numbers. The blood is not the fight: it is sprayed with
// `Math.random`, only when the agreed fight steps, and never travels.
//
// Your own body answers at once: the fight drawn is the agreed one played
// forward by the trip it takes, with your push in it.

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
function datan(z) {
  const z2 = z * z;
  return z * (0.99997726 + z2 * (-0.33262347 + z2 * (0.19354346 + z2 * (-0.11643287 + z2 * (0.05265332 + z2 * -0.0117212)))));
}
function datan2(y, x) {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x), ay = Math.abs(y);
  let a = ax >= ay ? datan(ay / ax) : PI / 2 - datan(ax / ay);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}
function dhypot(x, y) { return Math.sqrt(x * x + y * y); }

function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 60;               // Verlet has no dt in it: every constant below is per step
const STEPS_PER_TICK = 2;
const PREDICT = true;

const LW = 960, LH = 540;
const ARENA = { l: 40, r: LW - 40, t: 40, b: LH - 60 };

const HEAD = 0, CHEST = 1, PELVIS = 2, LELB = 3, LHAND = 4, RELB = 5, RHAND = 6, LKNE = 7, LFOOT = 8, RKNE = 9, RFOOT = 10;
const POSE = [
  [0, -47], [0, -27], [0, 0], [-20, -20], [-30, -3.3], [20, -20], [30, -3.3], [-10, 26.7], [-10, 53.3], [10, 26.7], [10, 53.3],
];
const RADIUS = [8.7, 6.7, 6.7, 4.7, 4.7, 4.7, 4.7, 4.7, 4.7, 4.7, 4.7];
const MASS = [1.3, 1.6, 1.6, 0.9, 0.7, 0.9, 0.7, 0.9, 0.7, 0.9, 0.7];
const BONE_PAIRS = [[HEAD, CHEST], [CHEST, PELVIS], [CHEST, LELB], [LELB, LHAND], [CHEST, RELB], [RELB, RHAND],
                    [PELVIS, LKNE], [LKNE, LFOOT], [PELVIS, RKNE], [RKNE, RFOOT]];
// Pairs a limb may not fold closer than this share of its pose — a cheap
// stand-in for joint limits, so the body keeps a shape instead of going
// spaghetti.
const ANGLE_PAIRS = [[HEAD, PELVIS, 0.6], [CHEST, LHAND, 0.55], [CHEST, RHAND, 0.55],
                     [PELVIS, LFOOT, 0.55], [PELVIS, RFOOT, 0.55], [LELB, RELB, 0.7],
                     [CHEST, LKNE, 0.78], [CHEST, RKNE, 0.78],
                     [LKNE, RKNE, 0.85], [LFOOT, RFOOT, 0.85]];
const poseGap = (a, b) => dhypot(POSE[a][0] - POSE[b][0], POSE[a][1] - POSE[b][1]);
const BONES = BONE_PAIRS.map(([a, b]) => [a, b, poseGap(a, b)]);
const LIMITS = ANGLE_PAIRS.map(([a, b, f]) => [a, b, poseGap(a, b) * f]);

const GRAV = 0.004, DAMP = 0.997, WALLBOUNCE = 0.35, MAXV = 15;
const CONSTRAINT_ITERS = 3, IMPACT_THRESH = 0.4, MAX_DAMAGE = 100;
const COMBO_WINDOW = 66, COMBO_STEP = 0.35, COMBO_MAX = 3.5;   // the window in steps
const THRUST = 0.2;
const RESPAWN = 180;                                           // steps
const CRIT_MULT = 1.8;
const DAMAGE_MULT = 1.6;
const SINGLE_HIT_CAP = 20;
const HIT_COOLDOWN = 13;                                       // steps between two hits of one pair
const DUMMY = -9;                                              // never a player id

const PALETTE = [[245, 245, 245], [142, 142, 142], [211, 169, 169], [169, 186, 211],
                 [169, 192, 169], [214, 196, 147], [196, 169, 211], [211, 169, 196]];

// A body is its eleven particles, each [x, y, px, py], and what has been done
// to it. Radius and mass are the pose's and never change, so they are not in
// the table.
function body(cx, cy) {
  return POSE.map((o) => [cx + o[0], cy + o[1], cx + o[0], cy + o[1]]);
}

function freshTable(seed) {
  return { rng: seed | 0, f: {}, held: {}, combo: 1, comboUntil: 0, cd: {}, nextColour: 0, dummyAt: 0 };
}

const playersIn = (w) => Object.keys(w.f).map(Number).filter((id) => id !== DUMMY);

function spawnPos(index, total) {
  const n = Math.max(total, 1);
  return [ARENA.l + ((index + 1) * (ARENA.r - ARENA.l)) / (n + 1), ARENA.b - 80];
}

function newFighter(w, id) {
  const ids = Object.keys(w.f);
  const [x, y] = spawnPos(ids.length, ids.length + 1);
  const colour = id === DUMMY ? 1 : w.nextColour++ % PALETTE.length;
  w.f[id] = { p: body(x, y), dmg: 0, ex: 0, exAt: 0, seq: 0, colour };
}

function respawn(w, f, index, total) {
  const [x, y] = spawnPos(index, total);
  f.p = body(x, y);
  f.dmg = 0; f.ex = 0; f.exAt = 0; f.seq += 1;
}

function integrate(f) {
  for (const p of f.p) {
    let vx = (p[0] - p[2]) * DAMP, vy = (p[1] - p[3]) * DAMP;
    const sp = dhypot(vx, vy);
    if (sp > MAXV) { vx = (vx / sp) * MAXV; vy = (vy / sp) * MAXV; }
    p[2] = p[0]; p[3] = p[1];
    p[0] += vx; p[1] += vy + GRAV;
  }
}

function wallCollide(p, r) {
  if (p[0] < ARENA.l + r) { p[0] = ARENA.l + r; p[2] = p[0] + (p[0] - p[2]) * WALLBOUNCE; }
  if (p[0] > ARENA.r - r) { p[0] = ARENA.r - r; p[2] = p[0] + (p[0] - p[2]) * WALLBOUNCE; }
  if (p[1] < ARENA.t + r) { p[1] = ARENA.t + r; p[3] = p[1] + (p[1] - p[3]) * WALLBOUNCE; }
  if (p[1] > ARENA.b - r) { p[1] = ARENA.b - r; p[3] = p[1] + (p[1] - p[3]) * WALLBOUNCE; }
}

function pull(A, B, rest, onlyCloser) {
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const d = dhypot(dx, dy) || 0.0001;
  if (onlyCloser && d >= rest) return;
  const diff = ((d - rest) / d) * 0.5;
  A[0] += dx * diff; A[1] += dy * diff;
  B[0] -= dx * diff; B[1] -= dy * diff;
}

function constrain(f) {
  for (let k = 0; k < CONSTRAINT_ITERS; k++) {
    for (const [a, b, rest] of BONES) pull(f.p[a], f.p[b], rest, false);
    for (const [a, b, least] of LIMITS) pull(f.p[a], f.p[b], least, true);
    f.p.forEach((p, i) => wallCollide(p, RADIUS[i]));
  }
}

function push(f, bits) {
  const head = f.p[HEAD];
  if (bits & 1) head[3] += THRUST;          // up
  if (bits & 2) head[3] -= THRUST;          // down
  if (bits & 4) head[2] += THRUST;          // left
  if (bits & 8) head[2] -= THRUST;          // right
}

function dealDamage(w, f, energy, crit) {
  const dmg = Math.min(energy * 1.4 * DAMAGE_MULT * w.combo * (crit ? CRIT_MULT : 1), SINGLE_HIT_CAP);
  f.dmg += dmg;
  w.combo = Math.min(COMBO_MAX, w.combo + COMBO_STEP);
  w.comboUntil = w.n + COMBO_WINDOW;
  if (f.dmg >= MAX_DAMAGE && !f.ex) explode(w, f);
}

function explode(w, f) {
  f.ex = 1;
  f.exAt = w.n;
  const cx = f.p[PELVIS][0], cy = f.p[PELVIS][1];
  for (const p of f.p) {
    const ang = datan2(p[1] - cy, p[0] - cx) + (draw01(w) - 0.5);
    const spd = 4 + draw01(w) * 6;
    p[2] = p[0] - dcos(ang) * spd;
    p[3] = p[1] - dsin(ang) * spd;
  }
}

function collide(w, idA, A, idB, B) {
  for (let ai = 0; ai < A.p.length; ai++) {
    const a = A.p[ai];
    for (let bi = 0; bi < B.p.length; bi++) {
      const b = B.p[bi];
      const minD = RADIUS[ai] + RADIUS[bi];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      let dist = dhypot(dx, dy);
      let overlapping = dist > 0 && dist < minD;
      if (!overlapping) {
        // A fast, small limb can fly clean through the opponent within a
        // single step; sample a few points along each path to catch it.
        for (let s = 1; s < 4; s++) {
          const t = s / 4;
          const ax = a[2] + (a[0] - a[2]) * t, ay = a[3] + (a[1] - a[3]) * t;
          const bx = b[2] + (b[0] - b[2]) * t, by = b[3] + (b[1] - b[3]) * t;
          const sdx = bx - ax, sdy = by - ay, sdist = dhypot(sdx, sdy);
          if (sdist > 0 && sdist < minD) { overlapping = true; dx = sdx; dy = sdy; dist = sdist; break; }
        }
      }
      if (!overlapping) continue;
      const nx = dx / dist, ny = dy / dist;
      const invA = 1 / MASS[ai], invB = 1 / MASS[bi], sum = invA + invB;
      const overlap = Math.max(minD - dhypot(b[0] - a[0], b[1] - a[1]), 0);
      if (overlap > 0) {
        a[0] -= nx * overlap * (invA / sum); a[1] -= ny * overlap * (invA / sum);
        b[0] += nx * overlap * (invB / sum); b[1] += ny * overlap * (invB / sum);
      }
      const avx = a[0] - a[2], avy = a[1] - a[3], bvx = b[0] - b[2], bvy = b[1] - b[3];
      const closing = -((avx - bvx) * nx + (avy - bvy) * ny);
      if (closing <= IMPACT_THRESH) continue;
      const jn = (-(1 + 0.4) * closing) / sum;
      a[2] += nx * jn * invA; a[3] += ny * jn * invA;
      b[2] -= nx * jn * invB; b[3] -= ny * jn * invB;
      const energy = closing * (MASS[ai] + MASS[bi]) * 0.5;
      if (live) spawnBlood((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, nx, ny, energy);
      // One damage event per pair per cooldown, so a head rammed in and held
      // there does not score a fresh hit every step. Only the side that got
      // hit is hurt, judged by who was closing the gap — both, head on head.
      const key = idA + '|' + idB;
      if (w.n - (w.cd[key] === undefined ? -1e9 : w.cd[key]) < HIT_COOLDOWN) continue;
      w.cd[key] = w.n;
      const aApproach = avx * nx + avy * ny;
      const bApproach = -(bvx * nx + bvy * ny);
      if (ai === HEAD && bi === HEAD) { dealDamage(w, A, energy, true); dealDamage(w, B, energy, true); }
      else if (aApproach >= bApproach) dealDamage(w, B, energy, bi === HEAD);
      else dealDamage(w, A, energy, ai === HEAD);
    }
  }
}

// The dummy flies about at random while nobody else is here, and goes the
// moment a second player arrives.
function dummy(w) {
  const people = playersIn(w).length;
  if (people < 2 && !w.f[DUMMY]) { newFighter(w, DUMMY); w.held[DUMMY] = 0; w.dummyAt = w.n; }
  else if (people >= 2 && w.f[DUMMY]) { delete w.f[DUMMY]; delete w.held[DUMMY]; }
  if (!w.f[DUMMY] || w.n < w.dummyAt) return;
  let bits = 0;
  if (draw01(w) > 0.15) {
    if (draw01(w) < 0.55) bits |= draw01(w) < 0.5 ? 4 : 8;
    if (draw01(w) < 0.55 || bits === 0) bits |= draw01(w) < 0.5 ? 1 : 2;
  }
  w.held[DUMMY] = bits;
  w.dummyAt = w.n + 18 + Math.floor(draw01(w) * 36);
}

function hand(w, id, bits) {
  if (!w.f[id]) newFighter(w, id);
  w.held[id] = bits;
}

function inputOf(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw < 16 ? raw : null;
}

function leave(w, id) {
  delete w.f[id];
  delete w.held[id];
  for (const key of Object.keys(w.cd)) if (key.split('|').map(Number).includes(id)) delete w.cd[key];
}

function step(w) {
  dummy(w);
  if (w.n > w.comboUntil) w.combo = 1;
  const ids = Object.keys(w.f);
  ids.forEach((key, index) => {
    const f = w.f[key];
    if (!f.ex) push(f, w.held[key] || 0);
    integrate(f);
    if (!f.ex) constrain(f);
    else f.p.forEach((p, i) => wallCollide(p, RADIUS[i]));
    if (f.ex && w.n - f.exAt > RESPAWN) respawn(w, f, index, ids.length);
  });
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = w.f[ids[i]], B = w.f[ids[j]];
      if (A.ex || B.ex) continue;
      collide(w, ids[i], A, ids[j], B);
    }
  }
}

function tableOf(raw) {
  if (!raw || !Number.isInteger(raw.rng) || !Number.isFinite(raw.combo) || !Number.isInteger(raw.comboUntil)) return null;
  if (!Number.isInteger(raw.nextColour) || !Number.isInteger(raw.dummyAt)) return null;
  const f = {};
  for (const [id, q] of Object.entries(raw.f || {})) {
    if (!Number.isInteger(Number(id)) || !q || !Array.isArray(q.p) || q.p.length !== POSE.length) return null;
    if (!q.p.every((p) => Array.isArray(p) && p.length === 4 && p.every(Number.isFinite))) return null;
    if (!Number.isFinite(q.dmg) || ![q.exAt, q.seq, q.colour].every(Number.isInteger)) return null;
    f[id] = { p: q.p.map((p) => p.slice()), dmg: q.dmg, ex: q.ex ? 1 : 0, exAt: q.exAt, seq: q.seq,
              colour: ((q.colour % PALETTE.length) + PALETTE.length) % PALETTE.length };
  }
  const held = {}, cd = {};
  for (const [id, v] of Object.entries(raw.held || {})) if (Number.isInteger(Number(id)) && inputOf(v) !== null) held[id] = v;
  for (const [key, v] of Object.entries(raw.cd || {})) if (Number.isInteger(v)) cd[key] = v;
  return { rng: raw.rng, f, held, combo: raw.combo, comboUntil: raw.comboUntil, cd, nextColour: raw.nextColour, dummyAt: raw.dummyAt };
}

// ═══════════════════ the screen ═══════════════════
document.body.style.cssText =
  'margin:0;height:100vh;overflow:hidden;background:#1c1c1c;touch-action:none;' +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;' +
  "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif";

let coarse = matchMedia('(pointer: coarse)').matches;

const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100%;height:100%;background:#1f1f1f';
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');

const INK = { line: '#3a3a3a', floor: '#242424', text: '#ededed', muted: '#8f8f8f', warn: '#d6c493', blood: '150,110,110' };
const FONT = "ui-monospace, 'SF Mono', Menlo, monospace";

// One scale for both axes, and the arena centred in what is left over. Scaled
// to the screen on each axis alone, a phone held upright drew the fighters
// several times taller than they are wide, and a wide window flattened them.
let SC = 1, OX = 0, OY = 0, CW = LW, CH = LH, DPR = 1;
function fit() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  CW = canvas.clientWidth || innerWidth;
  CH = canvas.clientHeight || innerHeight;
  canvas.width = Math.round(CW * DPR);
  canvas.height = Math.round(CH * DPR);
  SC = Math.min(CW / LW, CH / LH);
  OX = (CW - LW * SC) / 2;
  OY = (CH - LH * SC) / 2;
}
addEventListener('resize', fit); fit();

function fitted(text, size) {
  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.font = size + 'px ' + FONT;
  const wide = ctx.measureText(text).width;
  ctx.restore();
  const room = Math.max(1, (canvas.clientWidth || LW) - 16);
  return (wide > room ? Math.max(8, Math.floor((size * room) / wide)) : size) + 'px ' + FONT;
}

function label(text, wx, wy, font, colour, align) {
  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = align || 'center';
  ctx.fillText(text, OX + wx * SC, OY + wy * SC);
  ctx.restore();
}

function nickOf(id) {
  if (id === DUMMY) return 'Dummy';
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((pp) => pp.id === id);
  return p ? p.nick : '???';
}

// Cosmetic only, and sprayed only when the agreed fight steps: a guess
// replayed ten times would otherwise spray the same hit ten times.
let blood = [];
function spawnBlood(x, y, nx, ny, energy) {
  const n = Math.min(10, 3 + Math.round(energy * 0.8));
  for (let i = 0; i < n; i++) {
    const ang = Math.atan2(ny, nx) + (Math.random() - 0.5) * 1.6;
    const speed = 1.5 + Math.random() * 3 + energy * 0.15;
    blood.push({ x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
                 r: 1.5 + Math.random() * 2, life: 1, decay: 0.012 + Math.random() * 0.01 });
  }
  if (blood.length > 260) blood.splice(0, blood.length - 260);
}
function updateBlood(steps) {
  for (let s = 0; s < steps; s++) {
    for (const d of blood) {
      d.x += d.vx; d.y += d.vy;
      d.vx *= 0.96; d.vy = d.vy * 0.96 + 0.03;
      d.life -= d.decay;
    }
  }
  blood = blood.filter((d) => d.life > 0);
}
function drawBlood() {
  for (const d of blood) {
    ctx.fillStyle = `rgba(${INK.blood},${Math.max(0, d.life).toFixed(2)})`;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.fill();
  }
}

const teamColor = (base) => `rgb(${base[0]},${base[1]},${base[2]})`;
// Health is shown at the palms only: the fighter's own colour at full, red at
// none.
function wristColor(base, frac) {
  return `rgb(${(base[0] + (225 - base[0]) * frac) | 0},${(base[1] + (40 - base[1]) * frac) | 0},${(base[2] + (40 - base[2]) * frac) | 0})`;
}

function drawBody(pts, f) {
  const base = PALETTE[f.colour];
  const dmgFrac = Math.min(1, f.dmg / MAX_DAMAGE);
  if (!f.ex) {
    ctx.strokeStyle = teamColor(base);
    ctx.lineWidth = 7; ctx.lineCap = 'round';
    for (const [a, b] of BONES) {
      ctx.beginPath(); ctx.moveTo(pts[a][0], pts[a][1]); ctx.lineTo(pts[b][0], pts[b][1]); ctx.stroke();
    }
  }
  pts.forEach((p, i) => {
    ctx.fillStyle = i === LHAND || i === RHAND ? wristColor(base, dmgFrac) : teamColor(base);
    ctx.beginPath(); ctx.arc(p[0], p[1], RADIUS[i], 0, 7); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(28,28,28,.55)'; ctx.stroke();
  });
}

function draw(now) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, CW, CH);
  ctx.setTransform(SC * DPR, 0, 0, SC * DPR, OX * DPR, OY * DPR);
  ctx.strokeStyle = INK.line; ctx.lineWidth = 4;
  ctx.strokeRect(ARENA.l, ARENA.t, ARENA.r - ARENA.l, ARENA.b - ARENA.t);
  ctx.fillStyle = INK.floor;
  ctx.fillRect(ARENA.l, ARENA.b, ARENA.r - ARENA.l, LH - ARENA.b);
  drawBlood();

  const b = agreedAt(now);
  const m = mineAt(now);
  if (!b) {
    label('catching up with the fight', LW / 2, LH / 2, '15px ' + FONT, INK.muted);
    return;
  }
  const { to } = b;
  for (const key of Object.keys(to.f)) {
    const pair = key === String(myId()) && m.to.f[key] ? m : b;
    const { from, k } = pair;
    const f = pair.to.f[key], old = from.f[key];
    const same = old && old.seq === f.seq;
    const pts = f.p.map((p, i) => (same ? [old.p[i][0] + (p[0] - old.p[i][0]) * k, old.p[i][1] + (p[1] - old.p[i][1]) * k] : p));
    drawBody(pts, f);
    label(nickOf(Number(key)) + ' · ' + Math.round(f.dmg), pts[HEAD][0], pts[HEAD][1] - 26, '12px ' + FONT, INK.text);
  }
  if (to.combo > 1.05) label('COMBO x' + to.combo.toFixed(1), LW / 2, 34, '600 18px ' + FONT, INK.warn);
  if (playersIn(to).length < 2) {
    const alone = 'no real opponent yet — practicing against the dummy';
    label(alone, LW / 2, LH / 2 - 100, fitted(alone, 15), INK.muted);
  }
  label(wireNote(), ARENA.l, ARENA.t - 12, '11px ' + FONT, INK.muted, 'left');
  const how = coarse
    ? 'drag anywhere — impulse your whole ragdoll, tumble into your opponent'
    : 'WASD / arrow keys — impulse your whole ragdoll, tumble into your opponent';
  label(how, LW / 2, LH - 16, fitted(how, 12), INK.muted);
}

// ═══════════════════ the hands ═══════════════════
// Four ways held or not, said as four bits whenever one of them changes. A way
// is held while any key for it is: letting go of the arrow while the letter for
// the same way is still down does not let go of the way.
// Keys are read by where they sit, not by what they type: `e.code` is the same
// on every layout, while `e.key` is a Cyrillic letter on a Russian one, a
// capital with Caps Lock or Shift down, and a key let go under Shift would
// never match the one pressed and stay held for good.
const KEYMAP = { ArrowUp: 1, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 8, KeyW: 1, KeyS: 2, KeyA: 4, KeyD: 8 };
const held = new Set();
let keyBits = 0;
let stickBits = 0;
const sayBits = () => setHand(keyBits | stickBits);
const fromKeys = () => { keyBits = 0; for (const c of held) keyBits |= KEYMAP[c]; };

addEventListener('keydown', (e) => {
  if (!KEYMAP[e.code]) return;
  e.preventDefault();
  held.add(e.code);
  fromKeys();
  sayBits();
});
addEventListener('keyup', (e) => {
  if (!KEYMAP[e.code]) return;
  held.delete(e.code);
  fromKeys();
  sayBits();
});
addEventListener('blur', () => { held.clear(); keyBits = 0; stick = null; stickBits = 0; paintStick(); sayBits(); });

// A drag rather than a press, because iOS keeps a long press inside a frame for
// itself. Both axes can be over at once: the diagonals are what this game is
// played on.
const OVER = 14;
const REACHOUT = 46;
let stick = null;

function fromStick() {
  const dx = stick ? stick.dx : 0, dy = stick ? stick.dy : 0;
  stickBits = (dy <= -OVER ? 1 : 0) | (dy >= OVER ? 2 : 0) | (dx <= -OVER ? 4 : 0) | (dx >= OVER ? 8 : 0);
  sayBits();
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || stick) return;
  coarse = true;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  stick = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
  paintStick();
});
canvas.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  stick.dx = e.clientX - stick.ox;
  stick.dy = e.clientY - stick.oy;
  fromStick();
  paintStick();
});
const lift = (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  stick = null;
  fromStick();
  paintStick();
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

const ring = document.createElement('div');
ring.style.cssText =
  `position:fixed;display:none;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
  `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;pointer-events:none;` +
  `border:1px solid ${INK.line};background:rgba(143,143,143,0.06)`;
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  `border-radius:50%;pointer-events:none;opacity:.7;background:${INK.text}`;
document.body.append(ring, knob);
function paintStick() {
  if (!stick) { ring.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(stick.dx, stick.dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
  ring.style.display = knob.style.display = 'block';
  ring.style.left = stick.ox + 'px';
  ring.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + stick.dx * k + 'px';
  knob.style.top = stick.oy + stick.dy * k + 'px';
}

// The blood moves at the fight's pace, a step at a time off the same clock.
let bloodClock = performance.now();
function frame(now) {
  const steps = Math.min(8, Math.floor((now - bloodClock) / (1000 / HZ)));
  if (steps > 0) { updateBlood(steps); bloodClock += steps * (1000 / HZ); }
  if (now - bloodClock > 1000) bloodClock = now;
  draw(now);
  requestAnimationFrame(frame);
}

function start() {
  sayBits();
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
