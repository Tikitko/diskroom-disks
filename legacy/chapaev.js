/**
 * @disk     chapaev
 * @author   Bugord
 * @version  0.7.9
 * @players  2-2
 * @about    Physics checkers duel. Pull back your own piece slingshot-style and let go to launch it into the opponent's checkers and knock them off the board.
 * @tags     physics, versus, checkers, realtime, duel
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/chapaev.png
 */

// ── world ────────────────────────────────────────────────────────────────
// A fixed, id-based layout: 8 checkers in a "bottom" group, 8 in a "top"
// group, in world space. Which physical side a player controls is decided
// by comparing player ids (deterministic on both machines); the render
// transform then flips the view so each player always sees their own row
// at the bottom of their own screen. The world is square so the board is
// always a square, centred in whatever canvas it is drawn into.

const W = 900, H = 900, R = 33, N = 8;
const FRICTION_PER_SEC = 0.12;   // fraction of speed left after 1s
const REST = 0.78;               // checker-checker bounciness
const HEAVY = 60;                 // mass multiplier while anchored/aiming
const HARD_HIT = 440;             // closing speed that breaks an anchor
const MAX_PULL = 230;             // world units — hard stop on the sling stretch
const MIN_PULL = 12;              // world units, below this = no shot
const MAX_SPEED = 1700;           // world units/s
const SUBSTEP = 1 / 120;
const PIXEL = 2;                  // canvas backing-store downscale for a chunky pixel-art look
const CHECKER_MULT = 1;           // checker "pixels" are this many real backing pixels wide

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

let checkers = makeLayout();
let gameOver = null;      // 'bottom' | 'top' | 'draw' | null
let announcedOut = new Set();
let particles = [];       // debris from destroyed checkers, purely cosmetic
let flashes = [];         // expanding rings from destroyed checkers

// ── tick history ─────────────────────────────────────────────────────────
// Both sides advance a shared notion of "tick" (one per SUBSTEP), the host
// stamps its periodic 'sync' with its own tick number, and we keep a ring
// buffer of our own past states indexed the same way. Reconciling then means
// "go back to the tick the packet describes, patch in what the host said,
// and resimulate forward from there" instead of yanking the live/current
// state straight to a value that — thanks to network latency — already
// describes a moment slightly in the past. See `reconcile()` below.
let tick = 0;
const HISTORY_TICKS = 300; // ~2.5s at 120Hz — comfortably covers sync interval + latency
let history = [{ tick, snap: snapshotOf(checkers) }]; // [{ tick, snap }]
let eventLog = [];         // [{ tick, msg }] — shoot/aim/out events, replayed during reconcile

// Bumped by every resetGame(), and carried on every 'sync'/'state' packet.
// Whoever clicks restart resets their own tick/history to 0 *locally*
// first, then tells the other side — so for a window as long as that
// message takes to arrive, the other side's independent 'sync' timer keeps
// broadcasting the *previous* game's (much larger) tick completely
// obliviously. Without a generation check, that stale packet looks like
// a huge tick gap and would blow straight through hardApply(), overwriting
// the freshly-reset board with the dead/scattered state of the game that
// just ended. Comparing generations instead of guessing from tick size
// alone drops it outright, no matter which side happens to click restart.
let gen = 0;

function makeLayout() {
  const arr = [];
  const xs = [];
  for (let i = 0; i < N; i++) xs.push(W * (0.1 + 0.8 * (i / (N - 1))));
  for (let i = 0; i < N; i++) {
    arr.push({ id: i, group: 'bottom', x: xs[i], y: H - 135, vx: 0, vy: 0, alive: true, aiming: false, pullFrac: 0 });
  }
  for (let i = 0; i < N; i++) {
    arr.push({ id: N + i, group: 'top', x: xs[i], y: 135, vx: 0, vy: 0, alive: true, aiming: false, pullFrac: 0 });
  }
  return arr;
}

function resetGame() {
  checkers = makeLayout();
  gameOver = null;
  announcedOut = new Set();
  particles = [];
  flashes = [];
  tick = 0;
  history = [{ tick, snap: snapshotOf(checkers) }];
  eventLog = [];
  gen++;
  dragging = null;
  hideOverlay();
}

// (initial state already set above; resetGame() below is only ever called
// later, from the restart button or a 'restart' message, once the DOM and
// the `dragging` variable further down this file have been initialised)

// ── players / roles ─────────────────────────────────────────────────────

function otherPlayer() {
  if (!room.me) return null;
  return room.players.find((p) => p.id !== room.me.id) || null;
}

function myGroup() {
  const op = otherPlayer();
  if (!room.me || !op) return 'bottom';
  return room.me.id < op.id ? 'bottom' : 'top';
}

// Only one side may run the real collision simulation — otherwise two
// independent physics sims applying the same impulses at slightly
// different real moments diverge within seconds (classic chaotic n-body
// sensitivity). The host is that one side; everyone else just interpolates
// toward what the host reports. Solo/studio testing has no host at all, so
// it falls back to simulating locally.
function authoritative() {
  return room.isHost || !room.me;
}

// ── screen ───────────────────────────────────────────────────────────────

const FONT = "'Courier New',ui-monospace,monospace";

document.body.style.cssText =
  `margin:0;height:100%;overflow:hidden;background:${BG};font-family:${FONT};touch-action:none`;

const canvas = document.createElement('canvas');
canvas.style.cssText =
  'display:block;width:100%;height:100%;image-rendering:pixelated;image-rendering:-moz-crisp-edges';
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');

// CRT scanlines + vignette, pure CSS so they cost nothing per frame.
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

function showOverlay(win) {
  overlayText.textContent = win === null ? 'Draw' : win ? 'You win' : 'You lose';
  overlay.style.display = 'flex';
}
function hideOverlay() { overlay.style.display = 'none'; }

overlayBtn.onclick = () => {
  resetGame();
  room.send({ t: 'restart' });
};

let cw = 0, ch = 0, scale = 1, offX = 0, offY = 0;
let bpx = 1, bpy = 1; // exact CSS-px size of one backing-store pixel, for pixel-perfect snapping

function updateTransform() {
  // Square world, so the board is always a square, sized to the smaller
  // of the two viewport dimensions and centred on both axes, with a
  // visible margin around it.
  scale = Math.min(cw, ch) / W * 0.8;
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
  // Draw calls stay in CSS-pixel space; this maps that space down to the
  // small backing store, which the browser then upscales with nearest-
  // neighbour sampling (image-rendering:pixelated) for chunky pixels.
  // bpx/bpy are the exact CSS size of one such backing pixel (not just
  // ~PIXEL, since iw/ih are rounded) — snapping to multiples of these
  // lines shapes up exactly with the rendered pixel grid.
  bpx = cw / iw;
  bpy = ch / ih;
  ctx.setTransform(iw / cw, 0, 0, ih / ch, 0, 0);
  updateTransform();
}
window.addEventListener('resize', resize);
resize();

function worldToScreen(x, y) {
  let sx = offX + x * scale, sy = offY + y * scale;
  if (myGroup() === 'top') { sx = cw - sx; sy = ch - sy; }
  return [sx, sy];
}
function screenToWorld(sx, sy) {
  if (myGroup() === 'top') { sx = cw - sx; sy = ch - sy; }
  return [(sx - offX) / scale, (sy - offY) / scale];
}

// ── input ────────────────────────────────────────────────────────────────

let dragging = null;      // { id, pointerId }
let dragAnchor = [0, 0];  // world space — the checker's fixed position while aimed
let dragPointer = [0, 0]; // world space — clamped to MAX_PULL from dragAnchor

function findOwn(worldX, worldY) {
  const g = myGroup();
  let best = null, bestD = R * 2.4;
  for (const c of checkers) {
    if (!c.alive || c.group !== g) continue;
    const d = Math.hypot(c.x - worldX, c.y - worldY);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

let lastPullSend = 0;

canvas.addEventListener('pointerdown', (e) => {
  if (gameOver) return;
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  const c = findOwn(wx, wy);
  if (!c || dragging) return;
  canvas.setPointerCapture(e.pointerId);
  dragging = { id: c.id, pointerId: e.pointerId };
  dragAnchor = [c.x, c.y];
  dragPointer = [wx, wy];
  c.aiming = true;
  c.pullFrac = 0;
  const aimOn = { t: 'aim', id: c.id, on: true };
  room.send(aimOn);
  logEvent(aimOn);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging || e.pointerId !== dragging.pointerId) return;
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  // Hard stop on the sling stretch: clamp the pointer to a MAX_PULL ring
  // around the anchor so the band cannot be pulled back indefinitely.
  const dx = wx - dragAnchor[0], dy = wy - dragAnchor[1];
  const d = Math.hypot(dx, dy);
  if (d > MAX_PULL) {
    const k = MAX_PULL / d;
    dragPointer = [dragAnchor[0] + dx * k, dragAnchor[1] + dy * k];
  } else {
    dragPointer = [wx, wy];
  }
  const c = checkers.find((k) => k.id === dragging.id);
  if (!c) return;
  const frac = Math.min(d, MAX_PULL) / MAX_PULL;
  c.pullFrac = frac; // immediate local feedback — the piece trembles harder as you pull
  const now = performance.now();
  if (now - lastPullSend > 50) { // ~20/s, well under the send-rate ceiling
    lastPullSend = now;
    room.send({ t: 'aimpull', id: c.id, frac: Math.round(frac * 100) / 100 });
  }
});

function endDrag(e) {
  if (!dragging || (e && e.pointerId !== dragging.pointerId)) return;
  const c = checkers.find((k) => k.id === dragging.id);
  const id = dragging.id;
  dragging = null;
  if (!c || !c.alive) return;
  if (!c.aiming) return; // was already cancelled by a hard hit
  if (gameOver) {
    c.aiming = false; c.pullFrac = 0;
    const off = { t: 'aim', id, on: false };
    room.send(off); logEvent(off);
    return;
  }
  const dx = c.x - dragPointer[0], dy = c.y - dragPointer[1];
  const pull = Math.hypot(dx, dy);
  if (pull < MIN_PULL) {
    c.aiming = false;
    c.pullFrac = 0;
    const off = { t: 'aim', id, on: false };
    room.send(off); logEvent(off);
    return;
  }
  const clamped = Math.min(pull, MAX_PULL);
  const speed = (clamped / MAX_PULL) * MAX_SPEED;
  const vx = (dx / pull) * speed, vy = (dy / pull) * speed;
  c.vx = vx; c.vy = vy; c.aiming = false; c.pullFrac = 0;
  const shot = { t: 'shoot', id, vx, vy };
  room.send(shot);
  logEvent(shot);
  hint.style.opacity = '0';
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ── physics ──────────────────────────────────────────────────────────────

let shake = 0;          // decaying impact shake

function explode(c) {
  flashes.push({ x: c.x, y: c.y, life: 1 });
  const hi = c.group === myGroup() ? CREAM_HI : DARK_HI;
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
    const sp = 70 + Math.random() * 220;
    particles.push({ x: c.x, y: c.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, col: hi });
  }
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

function eliminate(c) {
  if (!c.alive) return;
  c.alive = false;
  explode(c);
  shake = Math.min(shake + 3.5, 10);
  checkWin();
}

function markOut(c) {
  const wasAlive = c.alive;
  eliminate(c);
  if (wasAlive && !announcedOut.has(c.id)) {
    announcedOut.add(c.id);
    room.send({ t: 'out', id: c.id });
  }
}

function checkWin() {
  if (gameOver) return;
  const bottomLeft = checkers.some((c) => c.group === 'bottom' && c.alive);
  const topLeft = checkers.some((c) => c.group === 'top' && c.alive);
  if (!bottomLeft && !topLeft) {
    gameOver = 'draw';
    showOverlay(null);
  } else if (!bottomLeft || !topLeft) {
    const winnerGroup = bottomLeft ? 'bottom' : 'top';
    gameOver = winnerGroup;
    showOverlay(winnerGroup === myGroup());
  }
}

function resolveCollision(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  if (dist === 0) { dist = 0.01; }
  if (dist >= R * 2) return;
  const nx = dx / dist, ny = dy / dist;

  let ma = a.aiming ? HEAVY : 1;
  let mb = b.aiming ? HEAVY : 1;

  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const closing = -(rvx * nx + rvy * ny);

  // A hard enough hit breaks the anchor of an aiming checker.
  if (a.aiming && closing > HARD_HIT) { ma = 1; breakAnchor(a); }
  if (b.aiming && closing > HARD_HIT) { mb = 1; breakAnchor(b); }

  const invA = 1 / ma, invB = 1 / mb;
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rel < 0) {
    const j = -(1 + REST) * rel / (invA + invB);
    a.vx -= j * invA * nx; a.vy -= j * invA * ny;
    b.vx += j * invB * nx; b.vy += j * invB * ny;
  }

  const overlap = R * 2 - dist;
  if (overlap > 0) {
    const total = invA + invB;
    a.x -= (overlap * (invA / total)) * nx;
    a.y -= (overlap * (invA / total)) * ny;
    b.x += (overlap * (invB / total)) * nx;
    b.y += (overlap * (invB / total)) * ny;
  }

  shake = Math.min(shake + Math.max(0, closing) * 0.005, 10);
}

function breakAnchor(c) {
  c.aiming = false;
  c.pullFrac = 0;
  // Only the authoritative side actually detects this (it's the only one
  // running collision physics), so it alone announces it — regardless of
  // whose checker it is.
  if (authoritative()) room.send({ t: 'aim', id: c.id, on: false });
  // Whoever owns the checker also stops their own local drag input.
  if (c.group === myGroup() && dragging && dragging.id === c.id) dragging = null;
}

// Both sides run this every frame — client-side prediction. Since both are
// fed the same shoot/aim/out events over the network, running the same
// integration and collisions locally means bounces and reactions look
// instant and correct on both screens, not just on the host's. The host's
// periodic 'sync' then reconciles whatever small drift accumulates instead
// of being the only thing that ever moves anyone but your own piece.
//
// `doElimination` is only ever true on the authoritative side: a checker
// leaving the board is a real, one-way decision (announced over 'out'), and
// letting a prediction declare that unilaterally risks a checker going
// "eliminated" locally while the host's real simulation never agreed — with
// no way back, since sync only ever updates checkers the host still
// considers alive.
function physicsStep(dt, doElimination) {
  const decay = Math.pow(FRICTION_PER_SEC, dt);
  for (const c of checkers) {
    if (!c.alive) continue;
    if (c.aiming) { c.vx = 0; c.vy = 0; continue; }
    c.x += c.vx * dt; c.y += c.vy * dt;
    c.vx *= decay; c.vy *= decay;
    if (Math.hypot(c.vx, c.vy) < 3) { c.vx = 0; c.vy = 0; }
  }
  for (let i = 0; i < checkers.length; i++) {
    if (!checkers[i].alive) continue;
    for (let j = i + 1; j < checkers.length; j++) {
      if (!checkers[j].alive) continue;
      resolveCollision(checkers[i], checkers[j]);
    }
  }
  if (!doElimination) return;
  // A checker is out once it has fully cleared the board rectangle — the
  // destruction zone matches the drawn edge instead of trailing off into
  // empty space beyond it.
  const M = R;
  for (const c of checkers) {
    if (!c.alive) continue;
    if (c.x < -M || c.x > W + M || c.y < -M || c.y > H + M) markOut(c);
  }
}

// Physics-relevant fields only: `pullFrac` is cosmetic (jitter amplitude,
// doesn't feed physics) and `dragging` is live UI input, neither belongs in
// a replayable snapshot.
function snapshotOf(list) {
  return list.map((c) => ({ id: c.id, x: c.x, y: c.y, vx: c.vx, vy: c.vy, alive: c.alive, aiming: c.aiming }));
}

function pushHistory() {
  history.push({ tick, snap: snapshotOf(checkers) });
  while (history.length > 1 && history[0].tick < tick - HISTORY_TICKS) history.shift();
}

function trimEventLog() {
  const floor = tick - HISTORY_TICKS;
  while (eventLog.length && eventLog[0].tick < floor) eventLog.shift();
}

// One fixed-step tick, everywhere it's used — the live loop and the replay
// inside reconcile() both go through this so history/eventLog bookkeeping
// never drifts out of sync with the actual simulated tick count.
function stepTick(doElimination) {
  physicsStep(SUBSTEP, doElimination);
  tick++;
  pushHistory();
  trimEventLog();
}

// ── rendering ────────────────────────────────────────────────────────────
// Dark-navy pixel-CRT board: cream vs. near-black pieces, a magenta accent,
// scanlines and a low-res backing store for a chunky retro look. Shapes are
// snapped to the backing-store pixel grid and flat-shaded (no gradients,
// minimal blur) so they read as deliberate pixel art instead of a blurry
// downscaled circle.

// Snapping to bpx/bpy (the exact CSS size of one backing-store pixel, see
// resize()) rather than to the PIXEL constant means every shape's edges
// land exactly on the rendered pixel grid — true pixel-perfect, not just
// an approximation of it.
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

  // halfway line — the front between the two sides
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
// Checkers snap to a coarser multiple of that same real pixel grid — bigger,
// more visibly blocky pixel art than the board/UI, but still exactly on-grid.
function snapCX(v) { const u = bpx * CHECKER_MULT; return Math.round(v / u) * u; }
function snapCY(v) { const u = bpy * CHECKER_MULT; return Math.round(v / u) * u; }
function snapCSize(v) { const u = bpx * CHECKER_MULT; return Math.max(u, Math.round(v / u) * u); }

function drawChecker(c) {
  // The checker itself trembles while being aimed, harder the further the
  // shot is pulled back — not a screen shake, the piece's own jitter.
  let jx = 0, jy = 0;
  if (c.aiming) {
    const amp = 1.2 + 3.6 * (c.pullFrac || 0);
    jx = (Math.sin(t * 45 + c.id) * 0.62 + Math.sin(t * 71 + c.id * 2) * 0.4) * amp;
    jy = (Math.cos(t * 39 + c.id * 1.7) * 0.62 + Math.sin(t * 63 + c.id) * 0.4) * amp;
  }
  const [sx, sy] = worldToScreen(c.x, c.y);
  const px = snapCX(sx + jx), py = snapCY(sy + jy);
  const rad = snapCSize(R * scale);
  const mine = c.group === myGroup();
  const pulse = c.aiming ? 0.6 + 0.4 * Math.sin(t * 16 + c.id) : 0;

  // flat base fill — no gradient, so it stays crisp instead of muddy
  if (c.aiming) { ctx.shadowColor = PINK_BRIGHT; ctx.shadowBlur = 10 + 8 * pulse; }
  ctx.beginPath();
  ctx.arc(px, py, rad, 0, Math.PI * 2);
  ctx.fillStyle = mine ? CREAM_LO : DARK_LO;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.lineWidth = snapCSize(rad * 0.2);
  ctx.strokeStyle = c.aiming ? PINK_BRIGHT : INK;
  ctx.stroke();

  // a single flat highlight block — pixel-art specular, not a smooth blend
  const hs = snapCSize(rad * 0.55);
  const hx = snapCX(px - rad * 0.3) - hs / 2, hy = snapCY(py - rad * 0.35) - hs / 2;
  ctx.fillStyle = mine ? CREAM_HI : DARK_HI;
  ctx.fillRect(hx, hy, hs, hs);

  // a matching flat shadow block on the opposite side, for a faceted read
  const ss = snapCSize(rad * 0.4);
  const shx = snapCX(px + rad * 0.28) - ss / 2, shy = snapCY(py + rad * 0.32) - ss / 2;
  ctx.fillStyle = mine ? 'rgba(26,21,48,.3)' : 'rgba(0,0,0,.45)';
  ctx.fillRect(shx, shy, ss, ss);
}

function drawAimLine() {
  if (!dragging) return;
  const c = checkers.find((k) => k.id === dragging.id);
  if (!c || !c.aiming) return;
  const [ax, ay] = worldToScreen(c.x, c.y);
  const [px, py] = worldToScreen(dragPointer[0], dragPointer[1]);
  const dx = c.x - dragPointer[0], dy = c.y - dragPointer[1];
  const pull = Math.min(Math.hypot(dx, dy), MAX_PULL);
  const frac = pull / MAX_PULL;
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

  // shot preview: opposite direction from the pull
  const tx = ax + (ax - px) * 0.7, ty = ay + (ay - py) * 0.7;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(tx, ty);
  ctx.strokeStyle = 'rgba(240,220,196,.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // MAX_PULL ring — the visible limit of the stretch
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
  if (shake > 0.3) {
    ctx.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);
  }
  ctx.fillStyle = BG;
  ctx.fillRect(-40, -40, cw + 80, ch + 80);
  drawBoard();
  for (const c of checkers) if (c.alive) drawChecker(c);
  drawEffects();
  drawAimLine();
  ctx.restore();

  const mine = checkers.filter((c) => c.group === myGroup() && c.alive).length;
  const theirs = checkers.filter((c) => c.group !== myGroup() && c.alive).length;
  hud.textContent = `Opponent: ${theirs}   ·   You: ${mine}`;
}

// ── main loop ────────────────────────────────────────────────────────────

let last = performance.now();
let acc = 0;
function loop(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  t += dt;
  if (!gameOver) {
    const doElimination = authoritative();
    acc += dt;
    let steps = 0;
    while (acc >= SUBSTEP && steps < 8) { stepTick(doElimination); acc -= SUBSTEP; steps++; }
  }
  updateEffects(dt);
  shake *= Math.pow(0.001, dt);
  if (shake < 0.05) shake = 0;
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// The host is the single source of truth, so it broadcasts its real state
// often — this is what the non-authoritative side actually reconciles
// against, not just an occasional drift correction. 45ms keeps combined
// send rate well under the platform's per-second ceiling alongside
// 'aimpull'. The whole roster (not just the living) travels every time —
// see `reconcile()` for why that matters — tagged with the tick it was
// captured at so the receiver can place it in its own history correctly.
setInterval(() => {
  if (!room.isHost) return;
  const c = checkers.map((k) => [
    k.id, Math.round(k.x), Math.round(k.y), Math.round(k.vx), Math.round(k.vy),
    k.alive ? 1 : 0, k.aiming ? 1 : 0,
  ]);
  room.send({ t: 'sync', tick, gen, c, s: Math.round(shake * 10) / 10 });
}, 45);

// ── networking ───────────────────────────────────────────────────────────
// State mutation is split from side effects (explosions, screen shake, the
// win check) so the same mutation can be replayed silently from `reconcile`
// without re-triggering visuals for something that already happened.

function applyShoot(msg) {
  const c = checkers.find((k) => k.id === msg.id);
  if (c && c.alive) { c.vx = msg.vx; c.vy = msg.vy; c.aiming = false; c.pullFrac = 0; }
}
function applyAim(msg) {
  const c = checkers.find((k) => k.id === msg.id);
  if (c && c.alive) { c.aiming = !!msg.on; c.pullFrac = 0; }
  // The host can break our own anchor from a hard hit we don't compute
  // ourselves — make sure our drag input actually lets go when that happens.
  if (!msg.on && dragging && dragging.id === msg.id) dragging = null;
}
function applyOutState(id) {
  const c = checkers.find((k) => k.id === id);
  if (c) c.alive = false;
}

function logEvent(msg) { eventLog.push({ tick, msg }); }

function replayEvent(msg) {
  if (msg.t === 'shoot') applyShoot(msg);
  else if (msg.t === 'aim') applyAim(msg);
  else if (msg.t === 'out') applyOutState(msg.id);
}

// Show the effects for any elimination we're only now finding out about
// (typically a self-healed dropped 'out'), exactly once, then re-check the
// win condition — shared by both the replayed and the direct-apply path.
function healEliminations(wasAlive) {
  for (const c of checkers) {
    if (wasAlive.get(c.id) && !c.alive) {
      announcedOut.add(c.id);
      explode(c);
      shake = Math.min(shake + 3.5, 10);
    }
  }
  checkWin();
}

// Beyond this gap a replay is pure waste: normal network latency is a
// handful of ticks, not hundreds, so a bigger gap means the host's report
// doesn't correlate with our own clock right now (e.g. its tab is
// backgrounded and throttled, so its tick barely advances) — replaying our
// *entire* retained history against it every single sync would just burn
// CPU for no benefit. Past this point, skip the replay and apply directly.
const MAX_REPLAY_TICKS = 60; // ~0.5s

function hardApply(msg) {
  const wasAlive = new Map(checkers.map((c) => [c.id, c.alive]));
  for (const s of msg.c) {
    const c = checkers.find((k) => k.id === s[0]);
    if (!c || (dragging && dragging.id === c.id)) continue;
    c.x = s[1]; c.y = s[2]; c.vx = s[3]; c.vy = s[4]; c.alive = !!s[5]; c.aiming = !!s[6];
  }
  // Realign our clock to the host's so the *next* sync (if the host's tick
  // has resumed advancing normally) lands back on the cheap replay path
  // instead of staying pinned to this same worst case forever.
  tick = Math.round(msg.tick) || 0;
  history = [{ tick, snap: snapshotOf(checkers) }];
  eventLog = [];
  if (typeof msg.s === 'number' && msg.s > shake) shake = msg.s;
  healEliminations(wasAlive);
}

// Reconcile a 'sync' packet against our own tick history instead of writing
// it straight into the live state. The host's tick and ours track the same
// real clock (aligned once at the 'state' handshake, advanced at the same
// SUBSTEP rate since), so `msg.tick` doubles as an index into our own
// history: find that point in our past, patch in what the host actually
// saw there, then resimulate forward — replaying any shoot/aim/out events
// that happened since — to arrive back at a corrected "now". A checker we
// are actively dragging is left untouched throughout: our own pointer is
// authoritative for our own in-progress aim, not a packet describing a
// moment before (or without knowledge of) that input.
//
// This is what actually fixes the "shot rewinds slightly on release" glitch
// — teleporting *now* to a packet that (thanks to latency) already
// describes a moment in the past is exactly what caused it — and, as a side
// effect, self-heals a dropped 'out' or anchor-break 'aim' message: since
// the whole roster (dead pieces and all) rides along on every sync, a lost
// one-shot event is corrected by the very next periodic packet instead of
// leaving that checker permanently stuck.
function reconcile(msg) {
  const targetTick = tick;
  const wantTick = Math.round(msg.tick);
  if (Math.abs(targetTick - wantTick) > MAX_REPLAY_TICKS) {
    hardApply(msg);
    return;
  }
  const anchorTick = Math.max(history[0].tick, Math.min(targetTick, wantTick));
  const base = history.find((h) => h.tick === anchorTick);
  if (!base) {
    return; // shouldn't happen — history has no gaps — but don't crash if it does
  }

  const wasAlive = new Map(checkers.map((c) => [c.id, c.alive]));

  // Patch the authoritative data into our own history at the point it
  // actually describes...
  for (const s of msg.c) {
    const slot = base.snap.find((k) => k.id === s[0]);
    if (slot) { slot.x = s[1]; slot.y = s[2]; slot.vx = s[3]; slot.vy = s[4]; slot.alive = !!s[5]; slot.aiming = !!s[6]; }
  }
  history = history.filter((h) => h.tick <= anchorTick);
  for (const s of base.snap) {
    const c = checkers.find((k) => k.id === s.id);
    if (!c || (dragging && dragging.id === c.id)) continue;
    c.x = s.x; c.y = s.y; c.vx = s.vx; c.vy = s.vy; c.alive = s.alive; c.aiming = s.aiming;
  }
  tick = anchorTick;

  // ...then resimulate forward to catch back up to "now", replaying
  // whatever genuinely happened since the corrected point.
  for (let step = anchorTick + 1; step <= targetTick; step++) {
    for (const ev of eventLog) if (ev.tick === step - 1) replayEvent(ev.msg);
    stepTick(false); // the client never self-eliminates, replay or not
  }

  if (typeof msg.s === 'number' && msg.s > shake) shake = msg.s;
  healEliminations(wasAlive);
}

room.on('message', (from, msg) => {
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'shoot') {
    applyShoot(msg);
    logEvent(msg);
  } else if (msg.t === 'aim') {
    applyAim(msg);
    logEvent(msg);
  } else if (msg.t === 'aimpull') {
    const c = checkers.find((k) => k.id === msg.id);
    if (c && c.alive && c.aiming) c.pullFrac = Math.max(0, Math.min(1, msg.frac));
  } else if (msg.t === 'out') {
    const c = checkers.find((k) => k.id === msg.id);
    if (c) { announcedOut.add(c.id); eliminate(c); }
    logEvent(msg);
  } else if (msg.t === 'sync') {
    if (room.isHost) return;
    if (msg.gen !== gen) return;
    reconcile(msg);
  } else if (msg.t === 'restart') {
    resetGame();
  } else if (msg.t === 'hello') {
    // The host's board is the one that counts, so only the host answers. Were
    // every copy to answer, a newcomer would keep whichever reply came last —
    // a copy that had drifted, or one a generation behind, after which every
    // sync from the host would be refused as belonging to another game.
    if (room.isHost) room.send({ t: 'state', c: checkers, over: gameOver, tick, gen }, { to: from });
  } else if (msg.t === 'state') {
    if (room.isHost || !Array.isArray(msg.c)) return;
    checkers = msg.c;
    gameOver = msg.over || null;
    tick = msg.tick || 0;
    gen = msg.gen || 0;
    history = [{ tick, snap: snapshotOf(checkers) }];
    eventLog = [];
    if (gameOver === 'draw') showOverlay(null);
    else if (gameOver) showOverlay(gameOver === myGroup());
    else hideOverlay();
  }
});

room.on('leave', () => console.log('opponent left the room'));
// `hostchange` hands over an id, not a player.
room.on('hostchange', (host) => {
  if (room.me && host === room.me.id) console.log('I am the host now');
});

room.send({ t: 'hello' });
