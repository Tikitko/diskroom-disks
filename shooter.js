/**
 * @disk     shooter
 * @author   diskroom
 * @version  7
 * @players  1-8
 * @about    A top-down arena shootout with cover. Run with the arrows, WASD or a left thumb, aim with the mouse or a right one, hold to fire.
 * @tags     game, arcade, realtime, shooter, example, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/shooter.png
 */
// shooter.js — the arena where the room's order is the referee.
//
// The legacy shooter.js (disks/legacy/shooter.js) runs the arena on the host,
// so a shot waits for a trip to the server, on to the host and back before
// anybody sees it leave. Here every copy runs the arena, and what travels is a
// hand: which way you are running, which way you are looking, and whether the
// trigger is down. Hands and the ticks that step the arena are sent with `{
// echo: true }`, so every copy applies the same hands in the same order and
// decides every hit the same way — a hit is still decided once, because it is
// the same arithmetic on the same numbers everywhere.
//
// The trigger is a state rather than a message. A hand that says "held" fires
// whenever the gun has cooled, and the cooling is counted in steps of the
// arena, so no copy can fire faster than another by sending faster.
//
// Your own fighter moves and fires the moment you do: the arena drawn is the
// agreed one played forward by the trip it takes, with your hand in it, and
// replayed from the agreed one every time that moves.

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
const dwrap = (a) => a - TAU * Math.round(a / TAU);

function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;
const STEPS_PER_TICK = 1;
const PREDICT = true;
const STEP = 1 / HZ;

const FW = 1.6, FH = 1.0;
const R = 0.028;              // a fighter's radius
const SPEED = 0.52;           // how fast a fighter runs, field units a second
const BR = 0.009;             // a shot's radius
const BSPEED = 1.25;          // field units a second
const BLIFE = 40;             // steps before a shot gives up
const COOLDOWN = 8;           // steps between shots
const HP = 3;
const RESPAWN = 54;           // steps
const IMMUNE = 45;            // steps untouchable after standing back up
const MAX_SHOTS = 40;
const KEEP_FIGHTERS = 3;      // bots fill the arena up to this many
const BOT_IDS = [-2, -3];
const BOT_SPEED = 0.42;
const BOT_TURN = 2.6;         // radians a second: a bot that has to aim is beatable
const BOT_RANGE = 0.42;
const HURT_STEPS = 10;        // how long the edge of your screen says you were hit

// Cover, as [x, y, w, h], symmetric under a half turn about the centre.
const WALLS = [
  [0.35, 0.20, 0.10, 0.22],
  [0.35, 0.58, 0.10, 0.22],
  [1.15, 0.20, 0.10, 0.22],
  [1.15, 0.58, 0.10, 0.22],
  [0.72, 0.42, 0.16, 0.16],
];
const SPAWNS = [
  [0.12, 0.12], [0.80, 0.10], [1.48, 0.12], [0.12, 0.50],
  [1.48, 0.50], [0.12, 0.88], [0.80, 0.90], [1.48, 0.88],
];

const C = {
  bg: '#1c1c1c', line: '#2f2f2f', wall: '#262626', edge: '#3a3a3a',
  muted: '#8f8f8f', mine: '#a9c0a9', foe: '#d3a9a9', dim: '#4a4a4a',
};
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

const isBot = (id) => id < -1;
const clampX = (x) => Math.max(R, Math.min(FW - R, x));
const clampY = (y) => Math.max(R, Math.min(FH - R, y));

// The arena. Plain data only: fingerprinted and handed over as JSON. A shot is
// [id, x, y, vx, vy, by, until].
function freshTable(seed) {
  return { rng: seed | 0, f: {}, s: [], sq: 0, hand: {} };
}

const playersIn = (w) => Object.keys(w.f).map(Number).filter((id) => !isBot(id));

function inWall(x, y) {
  for (const b of WALLS) if (x > b[0] && x < b[0] + b[2] && y > b[1] && y < b[1] + b[3]) return true;
  return false;
}

// A circle pushed back out of whatever block it has walked into, so a fighter
// slides along a wall instead of sticking to it.
function unstick(f) {
  for (const b of WALLS) {
    const cx = Math.max(b[0], Math.min(f.x, b[0] + b[2]));
    const cy = Math.max(b[1], Math.min(f.y, b[1] + b[3]));
    const dx = f.x - cx, dy = f.y - cy;
    const d = dhypot(dx, dy);
    if (d >= R) continue;
    if (d < 1e-6) {
      const left = f.x - b[0], right = b[0] + b[2] - f.x, up = f.y - b[1], down = b[1] + b[3] - f.y;
      const least = Math.min(left, right, up, down);
      if (least === left) f.x = b[0] - R;
      else if (least === right) f.x = b[0] + b[2] + R;
      else if (least === up) f.y = b[1] - R;
      else f.y = b[1] + b[3] + R;
      continue;
    }
    f.x = cx + (dx / d) * R;
    f.y = cy + (dy / d) * R;
  }
}

function clearLine(from, to) {
  const far = dhypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(far / 0.025));
  for (let i = 1; i < steps; i++) {
    const k = i / steps;
    if (inWall(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k)) return false;
  }
  return true;
}

function spawnSpot(w) {
  let best = SPAWNS[0], bestGap = -1;
  for (const s of SPAWNS) {
    let gap = 9;
    for (const f of Object.values(w.f)) if (f.hp > 0) gap = Math.min(gap, dhypot(f.x - s[0], f.y - s[1]));
    if (gap > bestGap) { bestGap = gap; best = s; }
  }
  return { x: clampX(best[0] + (draw01(w) - 0.5) * 0.05), y: clampY(best[1] + (draw01(w) - 0.5) * 0.05) };
}

function newFighter(w, id) {
  const spot = spawnSpot(w);
  return {
    x: spot.x, y: spot.y, a: 0, ax: 1, ay: 0, hp: HP, kills: 0,
    cool: 0, imm: w.n + IMMUNE, back: 0, hurt: -999,
    strafe: 1, strafeAt: 0, wob: 0, wobAt: 0,
  };
}

function revive(w, f) {
  const spot = spawnSpot(w);
  f.x = spot.x; f.y = spot.y; f.hp = HP; f.imm = w.n + IMMUNE;
}

// Bots make up the numbers so that one person alone has something to shoot
// at, and give way as people arrive.
function bots(w) {
  const wanted = Math.max(0, Math.min(BOT_IDS.length, KEEP_FIGHTERS - playersIn(w).length));
  const have = Object.keys(w.f).map(Number).filter(isBot);
  while (have.length > wanted) delete w.f[have.pop()];
  for (const id of BOT_IDS) {
    if (have.length >= wanted || w.f[id]) continue;
    w.f[id] = newFighter(w, id);
    have.push(id);
  }
}

function fire(w, id, f) {
  if (f.hp <= 0 || w.n < f.cool) return;
  const far = dhypot(f.ax, f.ay);
  if (far < 0.01) return;
  const ux = f.ax / far, uy = f.ay / far;
  f.cool = w.n + (isBot(id) ? Math.round(COOLDOWN * 1.5) : COOLDOWN);
  const x = f.x + ux * (R + BR + 0.006);
  const y = f.y + uy * (R + BR + 0.006);
  // A muzzle inside a block eats the shot rather than putting one through the
  // far side of the wall the shooter is standing against.
  if (inWall(x, y)) return;
  w.sq += 1;
  w.s.push([w.sq, x, y, ux * BSPEED, uy * BSPEED, id, w.n + BLIFE]);
  while (w.s.length > MAX_SHOTS) w.s.shift();
}

function hit(w, id, f, by) {
  f.hp -= 1;
  f.hurt = w.n;
  if (f.hp > 0) return;
  f.hp = 0;
  f.back = w.n + RESPAWN;
  const killer = w.f[by];
  if (killer && by !== id) killer.kills += 1;
}

// A bot holds a distance, strafes, turns at a rate rather than snapping onto
// its target, and does not fire through a wall.
function think(w, id, f) {
  let target = null, nearest = 9;
  for (const key of Object.keys(w.f)) {
    const o = w.f[key];
    if (Number(key) === id || o.hp <= 0) continue;
    const d = dhypot(o.x - f.x, o.y - f.y);
    if (d < nearest) { nearest = d; target = o; }
  }
  if (!target) return [0, 0];
  if (w.n >= f.wobAt) { f.wob = (draw01(w) - 0.5) * 0.22; f.wobAt = w.n + 15 + Math.floor(draw01(w) * 21); }
  if (w.n >= f.strafeAt) { f.strafe = draw01(w) < 0.5 ? -1 : 1; f.strafeAt = w.n + 18 + Math.floor(draw01(w) * 27); }

  const want = datan2(target.y - f.y, target.x - f.x);
  const turn = dwrap(want + f.wob - f.a);
  const most = BOT_TURN * STEP;
  f.a = dwrap(f.a + Math.max(-most, Math.min(most, turn)));
  f.ax = dcos(f.a);
  f.ay = dsin(f.a);

  const closer = nearest > BOT_RANGE + 0.06 ? 1 : nearest < BOT_RANGE - 0.06 ? -1 : 0;
  const side = want + PI / 2;
  if (Math.abs(dwrap(f.a - want)) < 0.10 && clearLine(f, target)) fire(w, id, f);
  return [dcos(want) * closer + dcos(side) * f.strafe * 0.9, dsin(want) * closer + dsin(side) * f.strafe * 0.9];
}

// A hand, at its place in the room's order: [dx, dy, ax, ay, trigger].
// Being heard is how you arrive.
function hand(w, id, input) {
  if (!w.f[id]) w.f[id] = newFighter(w, id);
  w.hand[id] = input;
}

function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  if (!raw.slice(0, 4).every((v) => Number.isFinite(v) && Math.abs(v) <= 1)) return null;
  if (raw[4] !== 0 && raw[4] !== 1) return null;
  return raw.slice();
}

function leave(w, id) {
  delete w.f[id];
  delete w.hand[id];
}

function step(w) {
  bots(w);
  for (const key of Object.keys(w.f)) {
    const id = Number(key), f = w.f[key];
    if (f.hp <= 0) {
      if (w.n >= f.back) revive(w, f);
      continue;
    }
    let move;
    if (isBot(id)) move = think(w, id, f);
    else {
      const h = w.hand[key] || [0, 0, f.ax, f.ay, 0];
      f.ax = h[2];
      f.ay = h[3];
      move = [h[0], h[1]];
      if (h[4]) fire(w, id, f);
    }
    const far = dhypot(move[0], move[1]);
    if (far < 0.01) continue;
    const speed = isBot(id) ? BOT_SPEED : SPEED;
    f.x = clampX(f.x + (move[0] / far) * speed * STEP);
    f.y = clampY(f.y + (move[1] / far) * speed * STEP);
    unstick(f);
  }

  // A shot crosses more than its own radius in one step, so it is walked there
  // in pieces: a whole step would let it pass through a wall, or through
  // somebody, without ever being inside either.
  const pieces = Math.max(1, Math.ceil((BSPEED * STEP) / (BR * 2)));
  for (let i = w.s.length - 1; i >= 0; i--) {
    const s = w.s[i];
    if (w.n >= s[6]) { w.s.splice(i, 1); continue; }
    let spent = false;
    for (let p = 0; p < pieces && !spent; p++) {
      s[1] += (s[3] * STEP) / pieces;
      s[2] += (s[4] * STEP) / pieces;
      if (s[1] < 0 || s[1] > FW || s[2] < 0 || s[2] > FH || inWall(s[1], s[2])) { spent = true; break; }
      for (const key of Object.keys(w.f)) {
        const id = Number(key), f = w.f[key];
        if (id === s[5] || f.hp <= 0 || w.n < f.imm) continue;
        const dx = f.x - s[1], dy = f.y - s[2];
        if (dx * dx + dy * dy > (R + BR) * (R + BR)) continue;
        hit(w, id, f, s[5]);
        spent = true;
        break;
      }
    }
    if (spent) w.s.splice(i, 1);
  }
}

// An arena handed over by somebody else is their claim, and is read as one.
function tableOf(raw) {
  if (!raw || !Number.isInteger(raw.rng) || !Number.isInteger(raw.sq) || !Array.isArray(raw.s)) return null;
  const f = {};
  const nums = ['x', 'y', 'a', 'ax', 'ay', 'wob'];
  const ints = ['hp', 'kills', 'cool', 'imm', 'back', 'hurt', 'strafe', 'strafeAt', 'wobAt'];
  for (const [id, q] of Object.entries(raw.f || {})) {
    if (!Number.isInteger(Number(id)) || !q || typeof q !== 'object') return null;
    if (!nums.every((k) => Number.isFinite(q[k])) || !ints.every((k) => Number.isInteger(q[k]))) return null;
    const c = {};
    for (const k of [...nums, ...ints]) c[k] = q[k];
    c.x = clampX(c.x);
    c.y = clampY(c.y);
    f[id] = {
      x: c.x, y: c.y, a: c.a, ax: c.ax, ay: c.ay, hp: c.hp, kills: c.kills, cool: c.cool, imm: c.imm,
      back: c.back, hurt: c.hurt, strafe: c.strafe, strafeAt: c.strafeAt, wob: c.wob, wobAt: c.wobAt,
    };
  }
  const s = [];
  for (const shot of raw.s.slice(0, MAX_SHOTS)) {
    if (!Array.isArray(shot) || shot.length !== 7) return null;
    if (![0, 5, 6].every((i) => Number.isInteger(shot[i])) || ![1, 2, 3, 4].every((i) => Number.isFinite(shot[i]))) return null;
    s.push(shot.slice());
  }
  const handOf = {};
  for (const [id, h] of Object.entries(raw.hand || {})) {
    const input = inputOf(h);
    if (Number.isInteger(Number(id)) && input) handOf[id] = input;
  }
  return { rng: raw.rng, f, s, sq: raw.sq, hand: handOf };
}

// ═══════════════════ the screen ═══════════════════
let coarse = matchMedia('(pointer: coarse)').matches;

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${C.bg};touch-action:none;` +
  'cursor:crosshair;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

let sc = 1, ox = 0, oy = 0;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth || 640, h = cv.clientHeight || 400;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sc = Math.min(w / FW, h / FH) * 0.92;
  ox = (w - FW * sc) / 2;
  oy = (h - FH * sc) / 2;
}
layout();
window.addEventListener('resize', layout);

const X = (x) => ox + x * sc;
const Y = (y) => oy + y * sc;

function nickOf(id) {
  if (isBot(id)) return 'bot' + (-id - 1);
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((x) => x.id === id);
  return p ? p.nick : 'p' + id;
}

// The arena between the last two tables, as the drawing needs it.
// Everybody else and their shots from the agreed arena; this fighter and its
// shots from the guess, where the hand is. What happens to this fighter — a
// hit, a death — is still read from the agreed arena, so a guessed hit that
// the room did not agree with is never shown.
function view(b, m) {
  const f = new Map(), s = new Map();
  const me = String(myId());
  const place = ({ from, to: t, k }, key) => {
    const q = t.f[key], old = from.f[key];
    const moved = old && Math.abs(old.x - q.x) + Math.abs(old.y - q.y) < 0.2;
    return { x: moved ? old.x + (q.x - old.x) * k : q.x, y: moved ? old.y + (q.y - old.y) * k : q.y };
  };
  const { to } = b;
  for (const key of Object.keys(to.f)) {
    const q = to.f[key];
    const at = key === me && m.to.f[key] ? place(m, key) : place(b, key);
    f.set(Number(key), {
      x: at.x, y: at.y, ax: q.ax, ay: q.ay, hp: q.hp, kills: q.kills,
      immune: q.hp > 0 && to.n < q.imm, back: q.hp > 0 ? 0 : (q.back - to.n) / HZ, hurt: q.hurt,
    });
  }
  const shots = ({ from, to: t, k }, mine) => {
    const was = new Map(from.s.map((shot) => [shot[0], shot]));
    for (const shot of t.s) {
      if ((shot[5] === myId()) !== mine) continue;
      const old = was.get(shot[0]);
      s.set((mine ? 'g' : 'a') + shot[0], {
        x: old ? old[1] + (shot[1] - old[1]) * k : shot[1],
        y: old ? old[2] + (shot[2] - old[2]) * k : shot[2],
        by: shot[5],
      });
    }
  };
  shots(b, false);
  shots(m, m !== b);
  if (m === b) shots(b, true);
  return { f, s, n: to.n };
}

function fighterAt(r, id) {
  const mine = id === myId();
  const colour = mine ? C.mine : C.muted;
  if (r.hp <= 0) {
    ctx.strokeStyle = C.dim;
    ctx.lineWidth = Math.max(1, sc * 0.006);
    const arm = R * sc * 0.8;
    ctx.beginPath();
    ctx.moveTo(X(r.x) - arm, Y(r.y) - arm); ctx.lineTo(X(r.x) + arm, Y(r.y) + arm);
    ctx.moveTo(X(r.x) + arm, Y(r.y) - arm); ctx.lineTo(X(r.x) - arm, Y(r.y) + arm);
    ctx.stroke();
    return;
  }
  const aim = mine ? [Math.cos(myAim), Math.sin(myAim)] : [r.ax, r.ay];
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.5, sc * 0.009);
  ctx.beginPath();
  ctx.moveTo(X(r.x), Y(r.y));
  ctx.lineTo(X(r.x + aim[0] * R * 1.9), Y(r.y + aim[1] * R * 1.9));
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(X(r.x), Y(r.y), R * sc, 0, Math.PI * 2);
  ctx.fill();
  if (r.immune) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1, sc * 0.005);
    ctx.globalAlpha = 0.35 + 0.25 * Math.sin(performance.now() / 90);
    ctx.beginPath();
    ctx.arc(X(r.x), Y(r.y), R * sc * 1.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const pip = sc * 0.012;
  for (let i = 0; i < HP; i++) {
    ctx.fillStyle = i < r.hp ? colour : C.dim;
    ctx.fillRect(X(r.x) - pip * 2.5 + i * pip * 2.5, Y(r.y) - R * sc - pip * 2.6, pip * 1.6, pip * 1.2);
  }
  ctx.fillStyle = C.muted;
  ctx.font = `${Math.round(sc * 0.030)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText(nickOf(id), X(r.x), Y(r.y) + R * sc + sc * 0.052);
}

function draw(shown) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(X(0), Y(0), FW * sc, FH * sc);
  for (let x = 0.2; x < FW; x += 0.2) {
    ctx.beginPath(); ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(FH)); ctx.stroke();
  }
  for (let y = 0.2; y < FH; y += 0.2) {
    ctx.beginPath(); ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(FW), Y(y)); ctx.stroke();
  }
  for (const b of WALLS) {
    ctx.fillStyle = C.wall;
    ctx.fillRect(X(b[0]), Y(b[1]), b[2] * sc, b[3] * sc);
    ctx.strokeStyle = C.edge;
    ctx.strokeRect(X(b[0]), Y(b[1]), b[2] * sc, b[3] * sc);
  }
  if (!shown) {
    ctx.textAlign = 'center';
    ctx.fillStyle = C.muted;
    ctx.font = `${Math.round(sc * 0.04)}px ${MONO}`;
    ctx.fillText('catching up with the arena', X(FW / 2), Y(FH / 2));
    return;
  }

  for (const s of shown.s.values()) {
    ctx.fillStyle = s.by === myId() ? C.mine : C.foe;
    ctx.beginPath();
    ctx.arc(X(s.x), Y(s.y), Math.max(1.5, BR * sc), 0, Math.PI * 2);
    ctx.fill();
  }
  for (const [id, r] of shown.f) if (id !== myId()) fighterAt(r, id);
  const me = shown.f.get(myId());
  if (me) {
    fighterAt(me, myId());
    if (me.hp > 0) {
      ctx.strokeStyle = C.dim;
      ctx.lineWidth = 1;
      ctx.setLineDash([sc * 0.02, sc * 0.02]);
      ctx.beginPath();
      ctx.moveTo(X(me.x), Y(me.y));
      ctx.lineTo(X(me.x + Math.cos(myAim) * 0.9), Y(me.y + Math.sin(myAim) * 0.9));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  const board = [...shown.f.entries()].sort((a, b) => b[1].kills - a[1].kills || a[0] - b[0]);
  ctx.textAlign = 'left';
  ctx.font = `${Math.round(sc * 0.034)}px ${MONO}`;
  let cursor = X(0);
  for (const [id, r] of board) {
    const text = nickOf(id) + ' ' + r.kills;
    ctx.fillStyle = id === myId() ? C.mine : C.muted;
    ctx.fillText(text, cursor, Y(0) - sc * 0.03);
    cursor += ctx.measureText(text + '   ').width;
  }
  // Only where the scores leave room for it: the scores are the game.
  const note = wireNote();
  if (cursor + ctx.measureText(note).width <= X(FW)) {
    ctx.textAlign = 'right';
    ctx.fillStyle = C.line;
    ctx.fillText(note, X(FW), Y(0) - sc * 0.03);
  }

  ctx.textAlign = 'center';
  ctx.font = `${Math.round(sc * 0.030)}px ${MONO}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(coarse
                 ? 'left thumb runs · right thumb aims and fires'
                 : 'arrows or wasd to run · mouse to aim · click or space to fire',
               X(FW / 2), Y(FH) + sc * 0.075);

  if (me && me.hp <= 0) {
    ctx.font = `${Math.round(sc * 0.06)}px ${MONO}`;
    ctx.fillStyle = C.foe;
    ctx.fillText('down — back in ' + Math.max(0, me.back).toFixed(1) + ' s', X(FW / 2), Y(FH / 2));
  }
  const since = me ? shown.n - me.hurt : 99;
  if (since < HURT_STEPS) {
    ctx.strokeStyle = C.foe;
    ctx.lineWidth = Math.max(2, sc * 0.012) * (1 - since / HURT_STEPS);
    ctx.strokeRect(X(0), Y(0), FW * sc, FH * sc);
  }
}

// ═══════════════════ the hands ═══════════════════
const keys = new Set();
let firing = false;
let mouse = null;
let myAim = 0;

function fromKeys() {
  let dx = 0, dy = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1;
  return [dx, dy];
}

// Keys are read by where they sit, not by what they type: `e.code` is the same
// on every layout, while `e.key` is a Cyrillic letter on a Russian one, a
// capital with Caps Lock or Shift down, and a key let go under Shift would
// never match the one pressed and stay held for good.
const RUN_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
addEventListener('keydown', (e) => {
  if (RUN_KEYS.includes(e.code) || e.code === 'Space') e.preventDefault();
  keys.add(e.code);
  if (e.code === 'Space') firing = true;
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Space') firing = false;
});
addEventListener('blur', () => { keys.clear(); firing = false; runStick = aimStick = null; paintSticks(); });
addEventListener('mousemove', (e) => {
  const box = cv.getBoundingClientRect();
  mouse = { x: (e.clientX - box.left - ox) / sc, y: (e.clientY - box.top - oy) / sc };
  thumbAim = null;
});
addEventListener('mousedown', (e) => { if (e.button === 0) firing = true; });
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
addEventListener('contextmenu', (e) => e.preventDefault());

// Two thumbs on a phone: the left half runs, the right half aims and fires
// while pushed over. Dragged rather than held, because iOS keeps a long press
// inside a frame for itself.
const DEAD = 8;
const REACHOUT = 46;
let runStick = null;
let aimStick = null;
let thumbAim = null;

const pushed = (st) => (st ? Math.hypot(st.dx, st.dy) >= DEAD : false);
function hands() { return pushed(runStick) ? [runStick.dx, runStick.dy] : fromKeys(); }

cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  coarse = true;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  const st = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
  if (e.clientX < innerWidth / 2) { if (!runStick) runStick = st; }
  else if (!aimStick) aimStick = st;
  paintSticks();
});
cv.addEventListener('pointermove', (e) => {
  const st = runStick && e.pointerId === runStick.pointerId ? runStick
           : aimStick && e.pointerId === aimStick.pointerId ? aimStick : null;
  if (!st) return;
  st.dx = e.clientX - st.ox;
  st.dy = e.clientY - st.oy;
  if (st === aimStick && pushed(st)) thumbAim = Math.atan2(st.dy, st.dx);
  paintSticks();
});
const lift = (e) => {
  if (runStick && e.pointerId === runStick.pointerId) runStick = null;
  if (aimStick && e.pointerId === aimStick.pointerId) aimStick = null;
  paintSticks();
};
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

function stickParts(colour) {
  const ring = document.createElement('div');
  ring.style.cssText =
    `position:fixed;display:none;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
    `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;pointer-events:none;` +
    `border:1px solid ${C.line};background:rgba(143,143,143,0.06)`;
  const knob = document.createElement('div');
  knob.style.cssText =
    'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
    `border-radius:50%;pointer-events:none;opacity:.7;background:${colour}`;
  document.body.append(ring, knob);
  return { ring, knob };
}
const runParts = stickParts(C.mine);
const aimParts = stickParts(C.foe);
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

// What the hand says. Running and the trigger go out the moment they change;
// the aim alone goes out no oftener than once every AIM_EVERY, because it
// changes with every twitch of the mouse, and the host's ticks and this hand share one
// seat's ceiling on messages.
const AIM_EVERY = 66;
let aimSentAt = -1e9;
let said = null;
function sayHand(now) {
  const run = hands();
  const far = Math.hypot(run[0], run[1]);
  const q = (v) => Math.round(v * 1000) / 1000;
  const next = [far < 0.01 ? 0 : q(run[0] / far), far < 0.01 ? 0 : q(run[1] / far),
                q(Math.cos(myAim)), q(Math.sin(myAim)), (firing || pushed(aimStick)) ? 1 : 0];
  if (said && next[0] === said[0] && next[1] === said[1] && next[4] === said[4]) {
    const turned = Math.abs(Math.atan2(next[3], next[2]) - Math.atan2(said[3], said[2]));
    if (turned < 0.02 || now - aimSentAt < AIM_EVERY) return;
  }
  said = next;
  aimSentAt = now;
  setHand(next);
}

function frame(now) {
  const b = agreedAt(now);
  const shown = b ? view(b, mineAt(now)) : null;
  // The aim is taken against the fighter as drawn, so the crosshair does not
  // swing about while you move — and what is drawn is a trip ahead, so it is
  // taken against where you are rather than where you were.
  const me = shown && shown.f.get(myId());
  if (thumbAim !== null) myAim = thumbAim;
  else if (me && mouse) myAim = Math.atan2(mouse.y - me.y, mouse.x - me.x);
  sayHand(now);
  draw(shown);
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
