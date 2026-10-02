/**
 * @disk     chapaev
 * @author   diskroom
 * @version  0.10.0
 * @players  2-8
 * @about    Physics checkers duel. Pull back your own piece slingshot-style and let go to launch it into the opponent's checkers and knock them off the board.
 * @tags     physics, versus, checkers, realtime, duel, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/chapaev.png
 */
// chapaev.js — chapaev where the room's order is the referee.
//
// The legacy chapaev.js (disks/legacy/chapaev.js) runs the collisions on the
// host, lets the other copy run them too as a guess, and sends the host's board
// every 45 ms so that the guess can be wound back and replayed against it —
// because two copies of a physics board, each applying the same shot at a
// slightly different moment, part within seconds. Here the shot is applied at
// the same moment everywhere: it is sent with `{ echo: true }`, and every copy
// applies it at its place in the room's order, between the same two steps of
// the board. So every copy runs the same collisions from the same start and
// holds the same board. Nothing is sent about the board at all, only the shots,
// the anchors and the ticks.
//
// That needs the collisions to come out the same on every machine to the last
// bit, which is why the friction below is a number rather than `Math.pow`, and
// why a distance is a square root rather than `Math.hypot`.
//
// A shot is a number as well as a push: a hand is said again every second in
// case it was lost, and a shot said twice must not fly twice. The board keeps
// the last number it applied from each player and ignores any it has seen. A
// restart names the game it wants to start the same way.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
function dhypot(x, y) { return Math.sqrt(x * x + y * y); }
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 120;
const STEPS_PER_TICK = 4;
// No guess ahead: the pieces are one board, and a board half a trip ahead and
// half behind would show collisions that never happen.
const PREDICT = false;

const W = 900, H = 900, R = 33, N = 8;
const SUBSTEP = 1 / HZ;
// 0.12 of the speed left after a second, as the factor for one step. Written
// out, because `Math.pow` is one of the functions an engine may round its own
// way.
const DECAY = 0.9824863162646956;
const REST = 0.78;               // checker-checker bounciness
const HEAVY = 60;                // mass multiplier while anchored/aiming
const HARD_HIT = 440;            // closing speed that breaks an anchor
const MAX_PULL = 230;            // world units — hard stop on the sling stretch
const MIN_PULL = 12;             // world units, below this = no shot
const MAX_SPEED = 1700;          // world units/s
const PIXEL = 2;                 // canvas backing-store downscale for a chunky pixel-art look
const CHECKER_MULT = 1;

// ── palette — dark-navy pixel-CRT with a magenta accent ──────────────────
const BG = '#12162a';
const PANEL = '#1b2140';
const PINK = '#e2436b';
const PINK_BRIGHT = '#ff8fac';
const MAUVE = '#8f7fa8';
const CREAM = '#f0dcc4';
const INK = '#1a1530';
const CREAM_HI = '#faf1de';
const CREAM_LO = '#cfae82';
const DARK_HI = '#3a2f52';
const DARK_LO = '#0c0a18';

const groupOf = (i) => (i < N ? 'bottom' : 'top');

// The board. A checker is [x, y, vx, vy, alive, aiming]; the first N are the
// bottom row's, the rest the top's. `side` is who plays which row.
function layout() {
  const c = [];
  for (let g = 0; g < 2; g++) {
    for (let i = 0; i < N; i++) c.push([W * (0.1 + 0.8 * (i / (N - 1))), g === 0 ? H - 135 : 135, 0, 0, 1, 0]);
  }
  return c;
}

function freshTable(seed) {
  return { rng: seed | 0, c: layout(), side: [null, null], over: null, gen: 0, aim: {}, shots: {} };
}

const playersIn = (w) => w.side.filter((id) => id !== null);
const sideOf = (w, id) => (w.side[0] === id ? 0 : w.side[1] === id ? 1 : -1);
const owns = (side, i) => (side === 0 ? i < N : i >= N);

// A hand: [aimed piece or -1, shot number, shot piece, vx, vy, game wanted].
function hand(w, id, input) {
  let side = sideOf(w, id);
  if (side < 0) {
    side = w.side[0] === null ? 0 : w.side[1] === null ? 1 : -1;
    if (side < 0) return;                        // both rows are taken: watching
    w.side[side] = id;
  }
  const [aimed, shot, piece, vx, vy, wanted] = input;
  if (wanted === w.gen + 1) {
    w.c = layout();
    w.over = null;
    w.gen += 1;
    w.aim = {};
    return;
  }
  if (w.over) return;

  // An anchor changes when the hand says a different piece than it last did,
  // not whenever it is said: a hit hard enough to break an anchor must not be
  // undone by the same hand repeated a second later.
  const was = w.aim[id] === undefined ? -1 : w.aim[id];
  if (aimed !== was) {
    w.aim[id] = aimed;
    for (let i = 0; i < w.c.length; i++) if (owns(side, i)) w.c[i][5] = 0;
    if (aimed >= 0 && owns(side, aimed) && w.c[aimed][4]) {
      const k = w.c[aimed];
      k[5] = 1; k[2] = 0; k[3] = 0;
    }
  }
  if (shot > (w.shots[id] || 0)) {
    w.shots[id] = shot;
    if (piece >= 0 && owns(side, piece) && w.c[piece][4]) {
      const speed = dhypot(vx, vy);
      const k = speed > MAX_SPEED ? MAX_SPEED / speed : 1;
      const c = w.c[piece];
      c[2] = vx * k; c[3] = vy * k; c[5] = 0;
    }
  }
}

function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 6) return null;
  const [aimed, shot, piece, vx, vy, wanted] = raw;
  const piece16 = (v) => Number.isInteger(v) && v >= -1 && v < 2 * N;
  if (!piece16(aimed) || !piece16(piece) || !Number.isInteger(shot) || shot < 0 || !Number.isInteger(wanted)) return null;
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
  return raw.slice();
}

function leave(w, id) {
  const side = sideOf(w, id);
  if (side >= 0) {
    w.side[side] = null;
    for (let i = 0; i < w.c.length; i++) if (owns(side, i)) w.c[i][5] = 0;
  }
  delete w.aim[id];
  // The last shot number stays. A player dropped for going quiet — a phone
  // switched to another app — still has their last hand said again every
  // second, and when they come back that hand seats them again; with the
  // number forgotten, the shot in it would fly a second time from wherever the
  // piece stands now.
}

function collide(w, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let dist = dhypot(dx, dy);
  if (dist === 0) dist = 0.01;
  if (dist >= R * 2) return;
  const nx = dx / dist, ny = dy / dist;
  let ma = a[5] ? HEAVY : 1;
  let mb = b[5] ? HEAVY : 1;
  const closing = -((b[2] - a[2]) * nx + (b[3] - a[3]) * ny);
  // A hard enough hit breaks the anchor of an aiming checker.
  if (a[5] && closing > HARD_HIT) { ma = 1; a[5] = 0; }
  if (b[5] && closing > HARD_HIT) { mb = 1; b[5] = 0; }
  const invA = 1 / ma, invB = 1 / mb;
  const rel = (b[2] - a[2]) * nx + (b[3] - a[3]) * ny;
  if (rel < 0) {
    const j = (-(1 + REST) * rel) / (invA + invB);
    a[2] -= j * invA * nx; a[3] -= j * invA * ny;
    b[2] += j * invB * nx; b[3] += j * invB * ny;
  }
  const overlap = R * 2 - dist;
  if (overlap > 0) {
    const total = invA + invB;
    a[0] -= overlap * (invA / total) * nx; a[1] -= overlap * (invA / total) * ny;
    b[0] += overlap * (invB / total) * nx; b[1] += overlap * (invB / total) * ny;
  }
  if (live) shake = Math.min(shake + Math.max(0, closing) * 0.005, 10);
}

function step(w) {
  if (w.over) return;
  for (const c of w.c) {
    if (!c[4]) continue;
    if (c[5]) { c[2] = 0; c[3] = 0; continue; }
    c[0] += c[2] * SUBSTEP; c[1] += c[3] * SUBSTEP;
    c[2] *= DECAY; c[3] *= DECAY;
    if (c[2] * c[2] + c[3] * c[3] < 9) { c[2] = 0; c[3] = 0; }
  }
  for (let i = 0; i < w.c.length; i++) {
    if (!w.c[i][4]) continue;
    for (let j = i + 1; j < w.c.length; j++) if (w.c[j][4]) collide(w, w.c[i], w.c[j]);
  }
  // A checker is out once it has fully cleared the board rectangle.
  let out = false;
  for (let i = 0; i < w.c.length; i++) {
    const c = w.c[i];
    if (!c[4] || !(c[0] < -R || c[0] > W + R || c[1] < -R || c[1] > H + R)) continue;
    c[4] = 0;
    c[5] = 0;
    out = true;
    if (live) explode(i, c);
  }
  if (!out) return;
  const bottom = w.c.some((c, i) => i < N && c[4]);
  const top = w.c.some((c, i) => i >= N && c[4]);
  if (!bottom && !top) w.over = 'draw';
  else if (!bottom || !top) w.over = bottom ? 'bottom' : 'top';
}

function tableOf(raw) {
  if (!raw || !Number.isInteger(raw.rng) || !Number.isInteger(raw.gen) || !Array.isArray(raw.c) || raw.c.length !== 2 * N) return null;
  const c = [];
  for (const k of raw.c) {
    if (!Array.isArray(k) || k.length !== 6 || !k.slice(0, 4).every(Number.isFinite)) return null;
    c.push([k[0], k[1], k[2], k[3], k[4] ? 1 : 0, k[5] ? 1 : 0]);
  }
  if (!Array.isArray(raw.side) || raw.side.length !== 2 || !raw.side.every((v) => v === null || Number.isInteger(v))) return null;
  if (!(raw.over === null || raw.over === 'bottom' || raw.over === 'top' || raw.over === 'draw')) return null;
  const aim = {}, shots = {};
  for (const [id, v] of Object.entries(raw.aim || {})) if (Number.isInteger(Number(id)) && Number.isInteger(v)) aim[id] = v;
  for (const [id, v] of Object.entries(raw.shots || {})) if (Number.isInteger(Number(id)) && Number.isInteger(v)) shots[id] = v;
  return { rng: raw.rng, c, side: raw.side.slice(), over: raw.over, gen: raw.gen, aim, shots };
}

// ═══════════════════ the screen ═══════════════════
const FONT = "'Courier New',ui-monospace,monospace";

document.body.style.cssText =
  `margin:0;height:100%;overflow:hidden;background:${BG};font-family:${FONT};touch-action:none`;

const canvas = document.createElement('canvas');
canvas.style.cssText =
  'display:block;width:100%;height:100%;image-rendering:pixelated;image-rendering:-moz-crisp-edges';
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');

const scan = document.createElement('div');
scan.style.cssText =
  'position:fixed;inset:0;pointer-events:none;z-index:3;mix-blend-mode:overlay;' +
  'background:repeating-linear-gradient(rgba(0,0,0,.5) 0 1px,transparent 1px 3px)';
document.body.appendChild(scan);

const vignette = document.createElement('div');
vignette.style.cssText =
  'position:fixed;inset:0;pointer-events:none;z-index:3;' +
  'box-shadow:inset 0 0 16vmin rgba(4,5,12,.85)';
document.body.appendChild(vignette);

const GLITCH_SHADOW = `-1px 0 rgba(255,60,140,.6),1px 0 rgba(70,220,255,.4),0 2px 3px #000`;

const hud = document.createElement('div');
hud.style.cssText =
  `position:fixed;left:0;right:0;top:12px;text-align:center;color:${CREAM};font-family:${FONT};` +
  `font-size:16px;letter-spacing:2px;text-transform:uppercase;pointer-events:none;` +
  `text-shadow:${GLITCH_SHADOW};z-index:2`;
document.body.appendChild(hud);

const hint = document.createElement('div');
hint.textContent = 'Pull your own checker back, then let go';
hint.style.cssText =
  `position:fixed;left:0;right:0;bottom:18px;text-align:center;color:${MAUVE};font-family:${FONT};` +
  'font-size:12px;letter-spacing:1px;opacity:.85;pointer-events:none;text-shadow:0 1px 3px #000;' +
  'transition:opacity .4s;z-index:2';
document.body.appendChild(hint);

const wire = document.createElement('div');
wire.style.cssText =
  `position:fixed;right:12px;bottom:18px;color:${MAUVE};font-family:${FONT};font-size:11px;` +
  'opacity:.6;pointer-events:none;z-index:2';
document.body.appendChild(wire);

const overlay = document.createElement('div');
overlay.style.cssText =
  'position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;' +
  `background:rgba(8,9,20,.9);color:${CREAM};gap:18px;z-index:5;font-family:${FONT}`;
const overlayText = document.createElement('div');
overlayText.style.cssText =
  `font-size:34px;font-weight:700;letter-spacing:4px;text-transform:uppercase;text-shadow:0 0 16px ${PINK},0 2px 4px #000`;
const overlayBtn = document.createElement('button');
overlayBtn.textContent = 'Play again';
overlayBtn.style.cssText =
  `font-family:${FONT};font-size:15px;letter-spacing:1.5px;padding:11px 26px;` +
  `border-radius:2px;border:2px solid ${PINK};background:${PANEL};color:${CREAM};cursor:pointer;` +
  `text-shadow:0 1px 3px #000;box-shadow:0 0 12px rgba(226,67,107,.45),inset 0 0 10px rgba(0,0,0,.5)`;
overlay.appendChild(overlayText);
overlay.appendChild(overlayBtn);
document.body.appendChild(overlay);

function showOverlay(over) {
  const g = myGroup();
  overlayText.textContent = over === 'draw' ? 'Draw' : !seated() ? over + ' wins' : over === g ? 'You win' : 'You lose';
  overlay.style.display = 'flex';
}
function hideOverlay() { overlay.style.display = 'none'; }

overlayBtn.onclick = () => {
  if (world) say({ wanted: world.gen + 1, aimed: -1 });
};

let cw = 0, ch = 0, scale = 1, offX = 0, offY = 0;
let bpx = 1, bpy = 1;

function updateTransform() {
  scale = (Math.min(cw, ch) / W) * 0.8;
  offX = (cw - W * scale) / 2;
  offY = (ch - H * scale) / 2;
}

function resize() {
  cw = window.innerWidth; ch = window.innerHeight;
  const iw = Math.max(1, Math.round(cw / PIXEL));
  const ih = Math.max(1, Math.round(ch / PIXEL));
  canvas.width = iw;
  canvas.height = ih;
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  bpx = cw / iw;
  bpy = ch / ih;
  ctx.setTransform(iw / cw, 0, 0, ih / ch, 0, 0);
  updateTransform();
}
window.addEventListener('resize', resize);
resize();

// Which row is this player's, as the board the room agrees on has it. Somebody
// watching sees the board from the bottom.
function myGroup() {
  if (world && world.side[1] === myId()) return 'top';
  return 'bottom';
}
const seated = () => !!world && sideOf(world, myId()) >= 0;

function worldToScreen(x, y) {
  let sx = offX + x * scale, sy = offY + y * scale;
  if (myGroup() === 'top') { sx = cw - sx; sy = ch - sy; }
  return [sx, sy];
}
function screenToWorld(sx, sy) {
  if (myGroup() === 'top') { sx = cw - sx; sy = ch - sy; }
  return [(sx - offX) / scale, (sy - offY) / scale];
}

// The board as drawn: the last two tables, walked between.
let checkers = [];
function shownCheckers(now) {
  const b = agreedAt(now);
  if (!b) return [];
  const { from, to, k } = b;
  return to.c.map((c, i) => {
    const o = from.c[i];
    const near = o && o[4] && Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) < 200;
    return {
      id: i, group: groupOf(i),
      x: near ? o[0] + (c[0] - o[0]) * k : c[0],
      y: near ? o[1] + (c[1] - o[1]) * k : c[1],
      alive: !!c[4], aiming: !!c[5],
      pullFrac: dragging && dragging.id === i ? dragFrac : 0,
    };
  });
}

// ── the hand ────────────────────────────────────────────────────────────────
const mine = { aimed: -1, shot: 0, piece: -1, vx: 0, vy: 0, wanted: 0 };
function say(change) {
  Object.assign(mine, change);
  setHand([mine.aimed, mine.shot, mine.piece, mine.vx, mine.vy, mine.wanted]);
}

let dragging = null;      // { id, pointerId }
let dragPointer = [0, 0];
let dragFrac = 0;

function findOwn(wx, wy) {
  if (!seated()) return null;
  const g = myGroup();
  let best = null, bestD = R * 2.4;
  for (const c of checkers) {
    if (!c.alive || c.group !== g) continue;
    const d = Math.hypot(c.x - wx, c.y - wy);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!world || world.over) return;
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  const c = findOwn(wx, wy);
  if (!c || dragging) return;
  canvas.setPointerCapture(e.pointerId);
  dragging = { id: c.id, pointerId: e.pointerId };
  dragPointer = [wx, wy];
  dragFrac = 0;
  say({ aimed: c.id });
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging || e.pointerId !== dragging.pointerId) return;
  const c = checkers.find((k) => k.id === dragging.id);
  if (!c) return;
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  // Hard stop on the sling stretch: clamp the pointer to a ring of MAX_PULL
  // around the piece so the band cannot be pulled back indefinitely.
  const dx = wx - c.x, dy = wy - c.y;
  const d = Math.hypot(dx, dy);
  dragPointer = d > MAX_PULL ? [c.x + (dx * MAX_PULL) / d, c.y + (dy * MAX_PULL) / d] : [wx, wy];
  dragFrac = Math.min(d, MAX_PULL) / MAX_PULL;
});

function endDrag(e) {
  if (!dragging || (e && e.pointerId !== dragging.pointerId)) return;
  const id = dragging.id;
  dragging = null;
  const c = checkers.find((k) => k.id === id);
  if (!c || !c.alive || !world || world.over) { say({ aimed: -1 }); return; }
  const dx = c.x - dragPointer[0], dy = c.y - dragPointer[1];
  const pull = Math.hypot(dx, dy);
  if (pull < MIN_PULL) { say({ aimed: -1 }); return; }
  const speed = (Math.min(pull, MAX_PULL) / MAX_PULL) * MAX_SPEED;
  // A shot's number is the next after any this copy or the board has used:
  // two shots let go before the first came back must not share one.
  const shot = Math.max(mine.shot, world.shots[myId()] || 0) + 1;
  say({ aimed: -1, shot, piece: id, vx: Math.round((dx / pull) * speed), vy: Math.round((dy / pull) * speed) });
  hint.style.opacity = '0';
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ── effects: made when the agreed board steps, and never from a guess ────────
let shake = 0;
let particles = [];
let flashes = [];

function explode(i, c) {
  flashes.push({ x: c[0], y: c[1], life: 1 });
  const hi = groupOf(i) === myGroup() ? CREAM_HI : DARK_HI;
  for (let k = 0; k < 9; k++) {
    const a = (Math.PI * 2 * k) / 9 + Math.random() * 0.6;
    const sp = 70 + Math.random() * 220;
    particles.push({ x: c[0], y: c[1], vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, col: hi });
  }
  shake = Math.min(shake + 3.5, 10);
}

function updateEffects(dt) {
  for (const f of flashes) f.life -= dt / 0.35;
  flashes = flashes.filter((f) => f.life > 0);
  for (const p of particles) {
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.9; p.vy *= 0.9;
    p.life -= dt / 0.6;
  }
  particles = particles.filter((p) => p.life > 0);
}

// ── rendering ───────────────────────────────────────────────────────────────
function snapX(v) { return Math.round(v / bpx) * bpx; }
function snapY(v) { return Math.round(v / bpy) * bpy; }
function snapSize(v) { return Math.max(bpx, Math.round(v / bpx) * bpx); }

function drawBoard() {
  const a = worldToScreen(0, 0), b = worldToScreen(W, H);
  const x0 = snapX(Math.min(a[0], b[0])), y0 = snapY(Math.min(a[1], b[1]));
  const x1 = snapX(Math.max(a[0], b[0])), y1 = snapY(Math.max(a[1], b[1]));
  const bw = x1 - x0, bh = y1 - y0;
  const cells = 8;
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      ctx.fillStyle = (gx + gy) % 2 === 0 ? CREAM : MAUVE;
      const p1 = worldToScreen((gx * W) / cells, (gy * H) / cells);
      const p2 = worldToScreen(((gx + 1) * W) / cells, ((gy + 1) * H) / cells);
      const cx0 = snapX(Math.min(p1[0], p2[0])), cy0 = snapY(Math.min(p1[1], p2[1]));
      const cx1 = snapX(Math.max(p1[0], p2[0])), cy1 = snapY(Math.max(p1[1], p2[1]));
      ctx.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    }
  }
  const [mx1, my1] = worldToScreen(0, H / 2);
  const [mx2, my2] = worldToScreen(W, H / 2);
  ctx.setLineDash([12, 9]);
  ctx.strokeStyle = 'rgba(226,67,107,.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mx1, my1); ctx.lineTo(mx2, my2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = PINK;
  ctx.lineWidth = 3;
  ctx.strokeRect(x0, y0, bw, bh);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 4, y0 + 4, bw - 8, bh - 8);
}

let t = 0;
function snapCX(v) { const u = bpx * CHECKER_MULT; return Math.round(v / u) * u; }
function snapCY(v) { const u = bpy * CHECKER_MULT; return Math.round(v / u) * u; }
function snapCSize(v) { const u = bpx * CHECKER_MULT; return Math.max(u, Math.round(v / u) * u); }

function drawChecker(c) {
  let jx = 0, jy = 0;
  if (c.aiming) {
    const amp = 1.2 + 3.6 * (c.pullFrac || 0);
    jx = (Math.sin(t * 45 + c.id) * 0.62 + Math.sin(t * 71 + c.id * 2) * 0.4) * amp;
    jy = (Math.cos(t * 39 + c.id * 1.7) * 0.62 + Math.sin(t * 63 + c.id) * 0.4) * amp;
  }
  const [sx, sy] = worldToScreen(c.x, c.y);
  const px = snapCX(sx + jx), py = snapCY(sy + jy);
  const rad = snapCSize(R * scale);
  const mineOne = c.group === myGroup();
  const pulse = c.aiming ? 0.6 + 0.4 * Math.sin(t * 16 + c.id) : 0;
  if (c.aiming) { ctx.shadowColor = PINK_BRIGHT; ctx.shadowBlur = 10 + 8 * pulse; }
  ctx.beginPath();
  ctx.arc(px, py, rad, 0, Math.PI * 2);
  ctx.fillStyle = mineOne ? CREAM_LO : DARK_LO;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = snapCSize(rad * 0.2);
  ctx.strokeStyle = c.aiming ? PINK_BRIGHT : INK;
  ctx.stroke();
  const hs = snapCSize(rad * 0.55);
  const hx = snapCX(px - rad * 0.3) - hs / 2, hy = snapCY(py - rad * 0.35) - hs / 2;
  ctx.fillStyle = mineOne ? CREAM_HI : DARK_HI;
  ctx.fillRect(hx, hy, hs, hs);
  const ss = snapCSize(rad * 0.4);
  const shx = snapCX(px + rad * 0.28) - ss / 2, shy = snapCY(py + rad * 0.32) - ss / 2;
  ctx.fillStyle = mineOne ? 'rgba(26,21,48,.3)' : 'rgba(0,0,0,.45)';
  ctx.fillRect(shx, shy, ss, ss);
}

function drawAimLine() {
  if (!dragging) return;
  const c = checkers.find((k) => k.id === dragging.id);
  if (!c) return;
  const [ax, ay] = worldToScreen(c.x, c.y);
  const [px, py] = worldToScreen(dragPointer[0], dragPointer[1]);
  const frac = dragFrac;
  const col = `rgb(${Math.round(143 + frac * 91)},${Math.round(127 - frac * 5)},${Math.round(168 - frac * 55)})`;
  ctx.shadowColor = PINK_BRIGHT;
  ctx.shadowBlur = 4 + frac * 12;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(px, py);
  ctx.strokeStyle = col;
  ctx.lineWidth = 3;
  ctx.setLineDash([9, 7]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  const tx = ax + (ax - px) * 0.7, ty = ay + (ay - py) * 0.7;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(tx, ty);
  ctx.strokeStyle = 'rgba(240,220,196,.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ax, ay, MAX_PULL * scale, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(226,67,107,.3)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawEffects() {
  for (const f of flashes) {
    const [sx, sy] = worldToScreen(f.x, f.y);
    const rad = R * scale * (1 + (1 - f.life) * 1.8);
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,143,172,${Math.max(0, f.life)})`;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  for (const p of particles) {
    const [sx, sy] = worldToScreen(p.x, p.y);
    const s = Math.max(1, 6 * scale * p.life);
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.col;
    ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
}

function render() {
  ctx.save();
  ctx.clearRect(0, 0, cw, ch);
  if (shake > 0.3) ctx.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);
  ctx.fillStyle = BG;
  ctx.fillRect(-40, -40, cw + 80, ch + 80);
  drawBoard();
  for (const c of checkers) if (c.alive) drawChecker(c);
  drawEffects();
  drawAimLine();
  ctx.restore();

  if (!world) {
    hud.textContent = 'catching up with the board';
  } else if (!seated() && world.side[0] !== null && world.side[1] !== null) {
    hud.textContent = 'watching';
  } else {
    const g = myGroup();
    const mineLeft = checkers.filter((c) => c.group === g && c.alive).length;
    const theirs = checkers.filter((c) => c.group !== g && c.alive).length;
    hud.textContent = `Opponent: ${theirs}   ·   You: ${mineLeft}`;
  }
  wire.textContent = wireNote();
}

// ── the loop ────────────────────────────────────────────────────────────────
let last = performance.now();
let shownOver = null;
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  t += dt;
  checkers = shownCheckers(now);
  const over = world ? world.over : null;
  if (over !== shownOver) {
    shownOver = over;
    if (over) showOverlay(over);
    else hideOverlay();
  }
  updateEffects(dt);
  shake *= Math.pow(0.001, dt);
  if (shake < 0.05) shake = 0;
  render();
  requestAnimationFrame(loop);
}

// Called by the kernel once it stands. An empty hand is how a player arrives
// and takes a row.
function start() {
  say({});
  requestAnimationFrame(loop);
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
