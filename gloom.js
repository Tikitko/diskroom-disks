/**
 * @disk     gloom
 * @author   claude
 * @version  1
 * @players  1-8
 * @about    A Doom-style raycaster shooter. Frag each other and hold off the fiends together. Click to lock the mouse, WASD to move, click or Space to fire, 1 and 2 for weapons, Tab for scores.
 * @tags     shooter, fps, deathmatch, coop, realtime
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/gloom.png
 */

'use strict';

// ── constants & helpers ─────────────────────────────────────────────────────
const W = 320, VH = 200, H = 240, HALF = VH / 2, HW = W / 2;
const TS = 64, NL = 16, PX = 0.015, TAU = Math.PI * 2;
const R_PLAYER = 0.25, R_MON = 0.3;
const SPAWN_SAFE = 1500;

let seed = 0x2545f491;
function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
function hash2(a, b) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul((b | 0) + 0x632be5ab, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function rgb(r, g, b) {
  return (0xff000000 | (clamp(b | 0, 0, 255) << 16) | (clamp(g | 0, 0, 255) << 8) | clamp(r | 0, 0, 255)) >>> 0;
}
function shade(c, f) {
  return (0xff000000 | ((((c >>> 16) & 255) * f >> 8) << 16) | ((((c >>> 8) & 255) * f >> 8) << 8) | ((c & 255) * f >> 8)) >>> 0;
}
const r2 = (v) => Math.round(v * 100) / 100;
const normA = (a) => ((a % TAU) + TAU) % TAU;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
const now = () => performance.now();

// ── the map ─────────────────────────────────────────────────────────────────
const MAP = [
  '########################',
  '#......#........#......#',
  '#......#........#......#',
  '#..R...M...BB...M...R..#',
  '#......#........#......#',
  '#......#........#......#',
  'BBB..BBBBB....BBBBB..BBB',
  '#......................#',
  '#..B..............B....#',
  '#.......MM....MM.......#',
  '#.......M......M.......#',
  '#..R...................#',
  '#...........R..........#',
  '#.......M......M....R..#',
  '#.......MM....MM.......#',
  '#..B..............B....#',
  '#......................#',
  'BBB..BBBBB....BBBBB..BBB',
  '#......#........#......#',
  '#......#........#......#',
  '#..R...M...BB...M...R..#',
  '#......#........#......#',
  '#......#........#......#',
  '########################',
];
const MW = MAP[0].length, MH = MAP.length;
const WALLT = { '#': 1, B: 2, M: 3, R: 4 };
const grid = new Uint8Array(MW * MH);
for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) grid[y * MW + x] = WALLT[MAP[y][x]] || 0;
const cellAt = (x, y) => (x < 0 || y < 0 || x >= MW || y >= MH ? 1 : grid[(y | 0) * MW + (x | 0)]);
const blocked = (x, y, r) => cellAt(x - r, y - r) || cellAt(x + r, y - r) || cellAt(x - r, y + r) || cellAt(x + r, y + r);
function moveEnt(e, dx, dy, r) {
  const ox = e.x, oy = e.y;
  if (!blocked(e.x + dx, e.y, r)) e.x += dx;
  if (!blocked(e.x, e.y + dy, r)) e.y += dy;
  return Math.abs(e.x - ox) + Math.abs(e.y - oy) > (Math.abs(dx) + Math.abs(dy)) * 0.5;
}
function los(x0, y0, x1, y1) {
  const d = dist(x0, y0, x1, y1), n = Math.ceil(d / 0.15);
  for (let i = 1; i < n; i++) if (cellAt(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return false;
  return true;
}
function castDist(x, y, dx, dy) {
  let mx = x | 0, my = y | 0;
  const ddx = dx === 0 ? 1e30 : Math.abs(1 / dx), ddy = dy === 0 ? 1e30 : Math.abs(1 / dy);
  let sx, sy, sdx, sdy;
  if (dx < 0) { sx = -1; sdx = (x - mx) * ddx; } else { sx = 1; sdx = (mx + 1 - x) * ddx; }
  if (dy < 0) { sy = -1; sdy = (y - my) * ddy; } else { sy = 1; sdy = (my + 1 - y) * ddy; }
  for (let i = 0; i < 128; i++) {
    if (sdx < sdy) { sdx += ddx; mx += sx; if (cellAt(mx, my)) return sdx - ddx; }
    else { sdy += ddy; my += sy; if (cellAt(mx, my)) return sdy - ddy; }
  }
  return 64;
}

// Open cells with room around them: where players and fiends appear.
const SPAWNS = [];
for (let y = 1; y < MH - 1; y++) for (let x = 1; x < MW - 1; x++) {
  let ok = true;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (cellAt(x + i, y + j)) ok = false;
  if (ok) SPAWNS.push({ x: x + 0.5, y: y + 0.5 });
}

// Pickups: 0 medkit, 1 shells, 2 bullets.
const PK = [
  { x: 2.5, y: 2.5, k: 0 }, { x: 11.5, y: 2.5, k: 1 }, { x: 21.5, y: 2.5, k: 2 },
  { x: 2.5, y: 21.5, k: 1 }, { x: 12.5, y: 21.5, k: 0 }, { x: 21.5, y: 21.5, k: 1 },
  { x: 10.5, y: 11.5, k: 0 }, { x: 13.5, y: 13.5, k: 1 }, { x: 4.5, y: 12.5, k: 2 }, { x: 19.5, y: 11.5, k: 2 },
];

// ── textures ────────────────────────────────────────────────────────────────
function genTex(fn) {
  const t = new Uint32Array(TS * TS);
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) { const c = fn(x, y); t[y * TS + x] = rgb(c[0], c[1], c[2]); }
  return t;
}
const N = () => rnd() - 0.5;
const TEX = [
  null,
  genTex((x, y) => { // 1 stone blocks
    const row = y >> 4, ox = (row & 1) * 16, bx = (x + ox) & 31, by = y & 15, id = hash2(((x + ox) >> 5) + row * 7, row);
    if (bx === 0 || by === 0) return [30, 30, 34];
    if (bx === 1 || by === 1) return [118, 118, 124];
    const v = 72 + id * 34 + N() * 22 - (by > 12 ? 12 : 0);
    return [v, v, v + 6];
  }),
  genTex((x, y) => { // 2 brick
    const row = y >> 3, ox = (row & 1) * 8, bx = (x + ox) & 15, by = y & 7, id = hash2(((x + ox) >> 4) + row * 13, row + 3);
    if (bx === 0 || by === 0) return [54, 46, 40];
    const v = id * 30 + N() * 18 - (by === 7 ? 14 : 0);
    return [112 + v, 50 + v * 0.5, 36 + v * 0.3];
  }),
  genTex((x, y) => { // 3 tech panel
    const bx = x & 31, by = y & 31;
    let v = 92 + N() * 10;
    if (bx === 0 || by === 0) return [26, 28, 32];
    if (bx === 1 || by === 1) v += 40;
    if (bx === 31 || by === 31) v -= 30;
    if ((bx === 4 || bx === 27) && (by === 4 || by === 27)) return [180, 180, 170];
    if (by >= 12 && by <= 19 && bx >= 8 && bx <= 23) {
      if (by === 12 || by === 19 || bx === 8 || bx === 23) return [36, 40, 36];
      return ((x >> 1) + (y >> 1)) & 1 ? [50, 210, 100] : [20, 120, 55];
    }
    return [v * 0.85, v * 0.9, v];
  }),
  genTex((x, y) => { // 4 flesh
    const s = Math.sin(x * 0.35 + Math.sin(y * 0.21) * 2.2) * Math.sin(y * 0.29 + Math.sin(x * 0.17) * 1.7);
    const v = N() * 20;
    if (Math.abs(s) < 0.12) return [60 + v, 8, 10];
    return [136 + v + s * 34, 32 + v * 0.4, 28 + v * 0.3];
  }),
  genTex((x, y) => { // 5 floor
    const bx = x & 31, by = y & 31, id = hash2(x >> 5, (y >> 5) + 9);
    if (bx === 0 || by === 0) return [22, 20, 18];
    const v = 56 + id * 16 + N() * 16;
    return [v * 1.05, v * 0.92, v * 0.78];
  }),
  genTex((x, y) => { // 6 ceiling
    const bx = x & 31, by = y & 31;
    if (bx === 0 || by === 0) return [18, 18, 20];
    if (bx >= 12 && bx <= 19 && by >= 12 && by <= 19)
      return bx === 12 || bx === 19 || by === 12 || by === 19 ? [90, 90, 80] : [235, 228, 190];
    const v = 46 + N() * 12;
    return [v, v, v + 4];
  }),
];
const lightF = (l) => Math.max(0.07, 1 - l * 0.062);
const SH = TEX.map((t) => {
  if (!t) return null;
  const levels = [];
  for (let l = 0; l < NL; l++) {
    const f = (lightF(l) * 256) | 0, o = new Uint32Array(t.length);
    for (let i = 0; i < t.length; i++) o[i] = shade(t[i], f);
    levels.push(o);
  }
  return levels;
});

// ── sprites (drawn here, original art) ──────────────────────────────────────
function makeSprite(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g);
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Uint32Array(w * h);
  for (let i = 0; i < w * h; i++) { const j = i * 4; if (d[j + 3] >= 128) out[i] = rgb(d[j], d[j + 1], d[j + 2]); }
  return { w, h, data: out };
}
function rect(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); }
function ell(g, x, y, rx, ry, c) { g.fillStyle = c; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.fill(); }
function tri(g, p, c) { g.fillStyle = c; g.beginPath(); g.moveTo(p[0][0], p[0][1]); g.lineTo(p[1][0], p[1][1]); g.lineTo(p[2][0], p[2][1]); g.closePath(); g.fill(); }
function glow(g, x, y, r, inner, outer) {
  const gr = g.createRadialGradient(x, y, 0.5, x, y, r);
  gr.addColorStop(0, '#fffbe0'); gr.addColorStop(0.35, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
}

function drawFiend(g, f) { // 0 walkA 1 walkB 2 attack 3 pain
  const skin = f === 3 ? '#b47e56' : '#7d5c36', dark = f === 3 ? '#84542f' : '#4b3519', bone = '#dcd2b0';
  const lo = f === 0 ? -2 : f === 1 ? 2 : 0;
  rect(g, 13 + lo, 31, 6, 13, dark); rect(g, 21 - lo, 31, 6, 13, dark);
  rect(g, 11 + lo, 43, 9, 4, bone); rect(g, 20 - lo, 43, 9, 4, bone);
  ell(g, 20, 25, 11, 11, skin);
  ell(g, 20, 29, 6, 5, dark);
  rect(g, 15, 21, 10, 1, dark); rect(g, 16, 24, 8, 1, dark);
  tri(g, [[9, 17], [4, 6], [13, 15]], bone); tri(g, [[31, 17], [36, 6], [27, 15]], bone);
  if (f === 2) {
    rect(g, 6, 7, 5, 15, skin); rect(g, 29, 7, 5, 15, skin);
    glow(g, 20, 6, 6, '#ffb030', 'rgba(255,80,0,0.6)');
  } else {
    const sw = f === 1 ? 2 : f === 0 ? -2 : 0;
    rect(g, 4, 17 + sw, 5, 14, skin); rect(g, 31, 17 - sw, 5, 14, skin);
    rect(g, 3, 31 + sw, 2, 3, bone); rect(g, 7, 31 + sw, 2, 3, bone);
    rect(g, 31, 31 - sw, 2, 3, bone); rect(g, 35, 31 - sw, 2, 3, bone);
  }
  ell(g, 20, 11, 7, 7, skin);
  tri(g, [[14, 7], [11, 0], [17, 5]], bone); tri(g, [[26, 7], [29, 0], [23, 5]], bone);
  const eye = f === 2 ? '#fff6a0' : '#ffd23a';
  rect(g, 15, 9, 4, 2, eye); rect(g, 21, 9, 4, 2, eye);
  rect(g, 16, 13, 8, 4, '#2a0505');
  for (let i = 0; i < 4; i++) { rect(g, 16 + i * 2, 13, 1, 1, bone); rect(g, 17 + i * 2, 16, 1, 1, bone); }
}
const FIEND = [0, 1, 2, 3].map((f) => makeSprite(40, 48, (g) => drawFiend(g, f)));
const FIEND_DEAD = makeSprite(40, 14, (g) => {
  ell(g, 20, 10, 19, 4, '#5a0a0a');
  ell(g, 16, 9, 9, 4, '#7d5c36'); ell(g, 27, 9, 6, 3, '#4b3519');
  tri(g, [[22, 8], [30, 1], [25, 9]], '#dcd2b0');
  rect(g, 12, 8, 2, 1, '#806010');
});

function drawSoldier(g, hue, f) { // 0 stand 1 walkA 2 walkB 3 shoot
  const arm = `hsl(${hue},55%,45%)`, armD = `hsl(${hue},55%,30%)`, armL = `hsl(${hue},60%,62%)`;
  const lo = f === 1 ? -2 : f === 2 ? 2 : 0;
  rect(g, 10, 30, 6, 13 + lo, '#34382f'); rect(g, 17, 30, 6, 13 - lo, '#34382f');
  rect(g, 9, 42 + lo, 8, 3, '#161616'); rect(g, 16, 42 - lo, 8, 3, '#161616');
  rect(g, 9, 16, 15, 15, arm);
  rect(g, 11, 18, 11, 6, armL);
  rect(g, 9, 29, 15, 2, '#222');
  ell(g, 8, 18, 4, 3, armD); ell(g, 25, 18, 4, 3, armD);
  rect(g, 5, 19, 4, 10, armD); rect(g, 24, 19, 4, 10, armD);
  rect(g, 11, 23, 11, 5, '#2a2a2e'); rect(g, 15, 21, 3, 3, '#111');
  ell(g, 16.5, 10, 6, 6.5, arm);
  rect(g, 12, 8, 9, 4, '#0d1a2a'); rect(g, 13, 9, 3, 1, '#7fd8ff');
  if (f === 3) glow(g, 16.5, 21, 6, '#ffd040', 'rgba(255,120,0,0.6)');
}
const soldierCache = new Map();
function soldier(hue) {
  let s = soldierCache.get(hue);
  if (!s) {
    s = [0, 1, 2, 3].map((f) => makeSprite(32, 46, (g) => drawSoldier(g, hue, f)));
    s.push(makeSprite(32, 12, (g) => {
      ell(g, 16, 8, 15, 3.5, '#5a0a0a');
      ell(g, 15, 6, 9, 3.5, `hsl(${hue},55%,40%)`); ell(g, 25, 6, 3.5, 3.5, `hsl(${hue},55%,45%)`);
      rect(g, 3, 5, 6, 3, '#34382f');
    }));
    soldierCache.set(hue, s);
  }
  return s;
}
const hueOf = (id) => (((id * 67) % 360) + 360) % 360;

const PKIMG = [
  makeSprite(20, 14, (g) => {
    rect(g, 0, 2, 20, 12, '#d8d8d0'); rect(g, 0, 12, 20, 2, '#9a9a92');
    rect(g, 8, 4, 4, 8, '#c01818'); rect(g, 5, 6, 10, 4, '#c01818');
  }),
  makeSprite(18, 12, (g) => {
    rect(g, 0, 4, 18, 8, '#8a1a12'); rect(g, 0, 4, 18, 1, '#b02a20');
    for (let i = 0; i < 5; i++) { rect(g, 1 + i * 3.4, 0, 3, 3, '#d8b030'); rect(g, 1 + i * 3.4, 3, 3, 2, '#a01810'); }
  }),
  makeSprite(14, 10, (g) => {
    rect(g, 0, 4, 14, 6, '#3a4a2a');
    for (let i = 0; i < 4; i++) rect(g, 1 + i * 3.3, 0, 2, 5, '#c8a040');
  }),
];
const BALL = [6, 7].map((r) => makeSprite(16, 16, (g) => glow(g, 8, 8, r, '#ffa020', 'rgba(255,40,0,0.55)')));
const BLOOD = makeSprite(3, 3, (g) => rect(g, 0, 0, 3, 3, '#a00808'));
const PUFF = makeSprite(6, 6, (g) => ell(g, 3, 3, 3, 3, '#a8a8a0'));
const SPARK = makeSprite(4, 4, (g) => rect(g, 0, 0, 4, 4, '#ffd060'));

// ── the screen ──────────────────────────────────────────────────────────────
document.documentElement.style.cssText = 'height:100%;background:#000';
document.body.style.cssText =
  'margin:0;height:100%;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden';
const cv = document.createElement('canvas');
cv.width = W; cv.height = H; cv.tabIndex = 0;
cv.style.cssText =
  'display:block;image-rendering:pixelated;width:min(100vw,133.333vh);height:min(75vw,100vh);cursor:crosshair;outline:none;background:#000';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');
const img = ctx.createImageData(W, VH);
const buf = new Uint32Array(img.data.buffer);
const zbuf = new Float64Array(W);

// ── sound (synthesised) ─────────────────────────────────────────────────────
let AC = null, master = null, noiseBuf = null;
function initAudio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    AC = new Ctor();
    master = AC.createGain(); master.gain.value = 0.45; master.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch (e) { AC = null; }
}
function noise(dur, vol, freq) {
  if (!AC || vol <= 0.01) return;
  const t = AC.currentTime, s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
  s.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur);
}
function tone(f0, f1, dur, vol, type, delay) {
  if (!AC || vol <= 0.01) return;
  const t = AC.currentTime + (delay || 0), o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'square';
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur);
}
const SFX = {
  pistol(v) { noise(0.16, 0.55 * v, 2600); tone(320, 80, 0.07, 0.18 * v); },
  shotgun(v) { noise(0.42, 0.9 * v, 1500); tone(150, 40, 0.18, 0.35 * v, 'sawtooth'); },
  empty() { tone(1100, 900, 0.03, 0.12); },
  hurt() { tone(240, 90, 0.22, 0.28, 'sawtooth'); },
  die() { tone(320, 45, 0.8, 0.35, 'sawtooth'); noise(0.5, 0.3, 500); },
  pickup() { tone(620, 1240, 0.1, 0.15); tone(900, 1500, 0.08, 0.12, 'square', 0.08); },
  growl(v) { tone(130, 55, 0.4, 0.3 * v, 'sawtooth'); noise(0.35, 0.25 * v, 700); },
  mdie(v) { tone(220, 40, 0.6, 0.32 * v, 'sawtooth'); noise(0.4, 0.3 * v, 400); },
  frag() { tone(500, 700, 0.08, 0.15); tone(700, 1000, 0.1, 0.15, 'square', 0.09); },
};
const volAt = (x, y) => Math.max(0, 1 - dist(P.x, P.y, x, y) / 18);

// ── input ───────────────────────────────────────────────────────────────────
const keys = Object.create(null);
let mouseDX = 0, mouseFire = false, everClicked = false;
const NOSCROLL = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (NOSCROLL.has(e.code)) e.preventDefault();
  if (e.code === 'Digit1') pickWeapon(0);
  if (e.code === 'Digit2') pickWeapon(1);
  if (e.code === 'KeyQ') pickWeapon(1 - P.w);
  initAudio();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseFire = false; });
cv.addEventListener('mousedown', (e) => {
  everClicked = true;
  initAudio();
  cv.focus();
  if (document.pointerLockElement !== cv && cv.requestPointerLock) {
    try { const r = cv.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (err) { /* not allowed here */ }
  }
  if (e.button === 0) mouseFire = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) mouseFire = false; });
addEventListener('mousemove', (e) => { if (document.pointerLockElement === cv) mouseDX += e.movementX || 0; });
addEventListener('wheel', (e) => { if (e.deltaY) pickWeapon(1 - P.w); }, { passive: true });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

// ── the room ────────────────────────────────────────────────────────────────
const myId = () => (room.me ? room.me.id : -1);
function nick(id) {
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = (room.players || []).find((q) => q.id === id);
  return p ? p.nick : 'player ' + id;
}
function send(msg, opt) {
  if (!room.me) return;
  try { room.send(msg, opt); } catch (e) { /* too big or not in a room; the next tick carries the state */ }
}

// Every running copy broadcasts its own player ~12 times a second, so a late
// joiner is caught up within a tick and a dropped message is replaced by the next.
const others = new Map();   // id -> latest state of that player's disk
const parked = new Map();   // id -> kill tally of someone who left (scores stay)
const startedAt = now();
const ready = () => now() - startedAt > 2000;

// Fiends need one simulator. It is the platform host when that host's disk is
// running and settled in; otherwise the lowest-id running disk. Everyone
// computes this from the same broadcasts, so they agree within a tick.
function authorityId() {
  const t = now(), cands = [];
  if (ready()) cands.push(myId());
  for (const [id, o] of others) if (o.r && t - o.last < 2000) cands.push(id);
  if (!cands.length) return null;
  if (room.host && cands.includes(room.host.id)) return room.host.id;
  return Math.min(...cands);
}
let isAuth = false;

// ── the player ──────────────────────────────────────────────────────────────
const P = {
  x: 2.5, y: 2.5, a: 0, hp: 100, dead: false, deadAt: 0, spawnAt: -1e9, w: 0, ammo: [50, 8],
  cool: 0, sc: 0, l: 0, k: {}, bob: 0, moveAmt: 0, flash: 0, kick: 0, hurt: 0, bonus: 0, killer: '',
};
function pickWeapon(w) { if (P.ammo[w] > 0 || P.ammo[1 - w] <= 0) P.w = w; }

function pickSpawn(minFrom) {
  const pts = [];
  if (!P.dead && minFrom !== 'me') pts.push([P.x, P.y]);
  if (minFrom === 'me' || minFrom === 'all') {
    for (const o of others.values()) if (!o.dead) pts.push([o.x, o.y]);
    for (const m of monsView()) if (m.st < 4) pts.push([m.x, m.y]);
  }
  let best = SPAWNS[(rnd() * SPAWNS.length) | 0], bs = -1;
  for (let i = 0; i < 14; i++) {
    const s = SPAWNS[(rnd() * SPAWNS.length) | 0];
    let d = 99;
    for (const p of pts) d = Math.min(d, dist(s.x, s.y, p[0], p[1]));
    if (d > bs) { bs = d; best = s; }
  }
  return best;
}
function respawn() {
  const s = pickSpawn('me');
  P.x = s.x; P.y = s.y; P.a = rnd() * TAU;
  P.hp = 100; P.dead = false; P.ammo = [50, 8]; P.w = 1; P.cool = 0.3;
  P.spawnAt = now(); P.l++; P.hurt = 0;
  sendPos();
}
function takeHit(d, by) {
  if (P.dead || now() - P.spawnAt < SPAWN_SAFE) return;
  P.hp -= d | 0;
  P.hurt = Math.min(1, P.hurt + d / 35);
  if (P.hp <= 0) die(by); else SFX.hurt();
}
function die(by) {
  P.hp = 0; P.dead = true; P.deadAt = now();
  const key = by === 'm' ? 'm' : String(by);
  P.k[key] = (P.k[key] || 0) + 1;
  P.killer = by === 'm' ? 'torn apart by a fiend' : 'fragged by ' + nick(by);
  SFX.die();
  addFeed(by === 'm' ? 'a fiend got you' : nick(by) + ' fragged you');
  send({ t: 'kf', by });
  sendPos();
}
function applyPick(k) {
  if (k === 0) P.hp = Math.min(100, P.hp + 25);
  else if (k === 1) { if (P.ammo[1] === 0) P.w = 1; P.ammo[1] = Math.min(50, P.ammo[1] + 8); }
  else if (k === 2) P.ammo[0] = Math.min(200, P.ammo[0] + 20);
  P.bonus = 0.6;
  SFX.pickup();
}
const needs = (k) => (k === 0 ? P.hp < 100 : k === 1 ? P.ammo[1] < 50 : P.ammo[0] < 200);

let lastPos = 0;
function sendPos() {
  lastPos = now();
  send({
    t: 'p', x: r2(P.x), y: r2(P.y), a: r2(P.a), h: Math.max(0, P.hp | 0), d: P.dead ? 1 : 0,
    w: P.w, s: P.sc, l: P.l, k: P.k, r: ready() ? 1 : 0,
  });
}

// ── scores ──────────────────────────────────────────────────────────────────
// Every player keeps the tally of who killed them; frags are summed from those.
// Nothing about a score rides on a single message.
function fragsOf(id) {
  const key = String(id);
  let n = 0;
  const add = (k) => { if (k && num(k[key])) n += k[key] | 0; };
  add(P.k);
  for (const o of others.values()) add(o.k);
  for (const k of parked.values()) add(k);
  return n;
}
function killsOf(id) {
  const mk = isAuth ? sim.mk : view.mk;
  const v = mk && mk[String(id)];
  return num(v) ? v | 0 : 0;
}

const feed = [];
function addFeed(text) { feed.push({ text, t: now() }); if (feed.length > 5) feed.shift(); }

// ── fiends: the simulator (authority only) and the view (everyone) ──────────
const sim = { mons: [], balls: [], pk: PK.map(() => 0), mk: {}, lastSnap: 0 };
const view = { snaps: [], pk: (1 << PK.length) - 1, mk: {} };

function wantMons() {
  let n = 1;
  const t = now();
  for (const o of others.values()) if (t - o.last < 2000) n++;
  return Math.min(12, 4 + n * 2);
}
function newMon(delay) {
  return { x: 1.5, y: 1.5, hp: 0, st: 5, deadAt: now() - 10000 + delay, cool: 1, wa: rnd() * TAU, wt: 0, alert: 0, tgt: null, fired: true, stT: 0 };
}
function spawnMon(m) {
  const s = pickSpawn('all');
  m.x = s.x; m.y = s.y; m.hp = 60; m.st = 0; m.cool = 1 + rnd() * 2; m.alert = 0; m.tgt = null; m.wt = 0;
}
function monTargets() {
  const t = now(), out = [];
  if (!P.dead && t - P.spawnAt > SPAWN_SAFE) out.push({ id: myId(), x: P.x, y: P.y });
  for (const [id, o] of others) if (!o.dead && t - o.last < 2000) out.push({ id, x: o.x, y: o.y });
  return out;
}
function hurtPlayer(id, d) {
  if (id === myId()) takeHit(d, 'm');
  else send({ t: 'hurt', d }, { to: id });
}
function hurtMon(i, d, by) {
  const m = sim.mons[i];
  if (!m || m.st >= 4) return;
  m.hp -= d;
  if (m.hp <= 0) {
    m.st = 4; m.deadAt = now(); m.hp = 0;
    const key = String(by);
    sim.mk[key] = (sim.mk[key] || 0) + 1;
  } else if (rnd() < 0.55) { m.st = 3; m.stT = 0.25; }
  else m.alert = 4;
}
function walkMon(m, ang, d) { return moveEnt(m, Math.cos(ang) * d, Math.sin(ang) * d, R_MON); }

function simStep(dt) {
  const t = now(), tg = monTargets(), want = wantMons();
  for (let i = sim.mons.length; i < want; i++) sim.mons.push(newMon(i * 500));
  sim.mons.forEach((m, i) => {
    if (m.st >= 4) { if (t - m.deadAt > 10000 && tg.length) spawnMon(m); return; }
    if (m.st === 3) { m.stT -= dt; if (m.stT <= 0) m.st = 1; return; }
    if (m.st === 2) {
      m.stT -= dt;
      if (!m.fired && m.stT < 0.2) {
        m.fired = true;
        const tt = tg.find((q) => q.id === m.tgt);
        if (tt && sim.balls.length < 24) {
          const a = Math.atan2(tt.y - m.y, tt.x - m.x) + (rnd() - 0.5) * 0.08;
          sim.balls.push({ x: m.x + Math.cos(a) * 0.35, y: m.y + Math.sin(a) * 0.35, vx: Math.cos(a) * 6.5, vy: Math.sin(a) * 6.5, life: 4 });
        }
      }
      if (m.stT <= 0) m.st = 1;
      return;
    }
    let best = null, bd = 1e9, seen = false;
    for (const q of tg) {
      const d = dist(m.x, m.y, q.x, q.y);
      if (d > 16 || d >= bd) continue;
      const v = los(m.x, m.y, q.x, q.y);
      if (v || (m.alert > 0 && m.tgt === q.id)) { best = q; bd = d; seen = v; }
    }
    m.alert -= dt; m.cool -= dt;
    if (best) {
      if (seen) m.alert = 4;
      m.tgt = best.id;
      if (bd < 1.1 && m.cool <= 0) { hurtPlayer(best.id, (5 + rnd() * 10) | 0); m.cool = 1.1; m.st = 2; m.stT = 0.35; m.fired = true; return; }
      if (seen && bd < 13 && m.cool <= 0) { m.st = 2; m.stT = 0.55; m.fired = false; m.cool = 1.8 + rnd() * 1.8; return; }
      if (bd > 1.3) {
        const a = Math.atan2(best.y - m.y, best.x - m.x) + Math.sin(t / 600 + i) * 0.5;
        if (!walkMon(m, a, 2.0 * dt)) walkMon(m, a + (i & 1 ? 1.2 : -1.2), 2.0 * dt);
      }
      m.st = 1;
    } else {
      m.wt -= dt;
      if (m.wt <= 0) { m.wa = rnd() * TAU; m.wt = 1.5 + rnd() * 2.5; }
      if (!walkMon(m, m.wa, 0.9 * dt)) m.wt = 0;
      m.st = 1;
    }
  });
  // keep fiends from stacking
  for (let i = 0; i < sim.mons.length; i++) for (let j = i + 1; j < sim.mons.length; j++) {
    const a = sim.mons[i], b = sim.mons[j];
    if (a.st >= 4 || b.st >= 4) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (d > 0.001 && d < 0.6) {
      const push = (0.6 - d) * 0.5;
      moveEnt(a, -dx / d * push, -dy / d * push, R_MON);
      moveEnt(b, dx / d * push, dy / d * push, R_MON);
    }
  }
  for (let j = sim.balls.length - 1; j >= 0; j--) {
    const b = sim.balls[j];
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    let gone = b.life <= 0 || cellAt(b.x, b.y);
    if (!gone) for (const q of tg) if (dist(b.x, b.y, q.x, q.y) < 0.4) { hurtPlayer(q.id, (6 + rnd() * 14) | 0); gone = true; break; }
    if (gone) sim.balls.splice(j, 1);
  }
}
const pkBits = () => sim.pk.reduce((b, v, i) => (v <= now() ? b | (1 << i) : b), 0);
function sendSnap() {
  sim.lastSnap = now();
  send({
    t: 'm',
    m: sim.mons.map((m) => [r2(m.x), r2(m.y), Math.max(0, m.hp | 0), m.st]),
    b: sim.balls.map((b) => [r2(b.x), r2(b.y), r2(b.vx), r2(b.vy)]),
    p: pkBits(), k: sim.mk,
  });
}
function grantPick(i, who) {
  if (i < 0 || i >= PK.length || sim.pk[i] > now()) return;
  if (who !== myId()) {
    const o = others.get(who);
    if (!o || dist(o.x, o.y, PK[i].x, PK[i].y) > 1.5) return;
  }
  sim.pk[i] = now() + 25000;
  if (who === myId()) applyPick(PK[i].k);
  else send({ t: 'gave', k: PK[i].k }, { to: who });
}
// Becoming the simulator: carry on from the last world we were shown.
function takeOver() {
  const S = view.snaps[view.snaps.length - 1], t = now();
  sim.balls = []; sim.mk = Object.assign({}, view.mk);
  if (S && t - S.t < 4000) {
    sim.mons = S.m.map((o) => ({
      x: o.x, y: o.y, hp: o.hp, st: o.st === 2 || o.st === 3 ? 1 : o.st, deadAt: t - 5000,
      cool: 1 + rnd(), wa: rnd() * TAU, wt: 0, alert: 0, tgt: null, fired: true, stT: 0,
    }));
    sim.balls = S.b.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, life: 3 }));
    sim.pk = PK.map((_, i) => (view.pk & (1 << i) ? 0 : t + 8000 + rnd() * 8000));
  } else {
    sim.mons = [];
    for (let i = 0; i < wantMons(); i++) sim.mons.push(newMon(i * 400));
    sim.pk = PK.map(() => 0);
  }
}
// Handing the role on: keep showing what we had until the new one speaks.
function handOff() {
  view.snaps.push({
    t: now(),
    m: sim.mons.map((m) => ({ x: m.x, y: m.y, hp: m.hp, st: m.st })),
    b: sim.balls.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy })),
  });
  if (view.snaps.length > 4) view.snaps.shift();
  view.pk = pkBits(); view.mk = Object.assign({}, sim.mk);
}
function onSnap(msg) {
  if (!Array.isArray(msg.m) || !Array.isArray(msg.b)) return;
  const m = [], b = [];
  for (const e of msg.m.slice(0, 16)) if (Array.isArray(e) && num(e[0]) && num(e[1])) m.push({ x: e[0], y: e[1], hp: e[2] | 0, st: clamp(e[3] | 0, 0, 5) });
  for (const e of msg.b.slice(0, 32)) if (Array.isArray(e) && num(e[0]) && num(e[1]) && num(e[2]) && num(e[3])) b.push({ x: e[0], y: e[1], vx: e[2], vy: e[3] });
  view.snaps.push({ t: now(), m, b });
  if (view.snaps.length > 4) view.snaps.shift();
  if (num(msg.p)) view.pk = msg.p | 0;
  if (msg.k && typeof msg.k === 'object' && !Array.isArray(msg.k)) view.mk = msg.k;
}
function monsView() {
  if (isAuth) return sim.mons;
  const S = view.snaps;
  if (!S.length) return [];
  const t = now() - 170;
  let A = null, B = null;
  for (let i = S.length - 1; i >= 0; i--) if (S[i].t <= t) { A = S[i]; B = S[i + 1] || null; break; }
  if (!A) return S[0].m;
  if (!B) return A.m;
  const f = clamp((t - A.t) / (B.t - A.t), 0, 1);
  return B.m.map((b, i) => {
    const a = A.m[i];
    if (!a || a.st >= 4 || b.st >= 4 || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 2) return b;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, hp: b.hp, st: b.st };
  });
}
function ballsView() {
  if (isAuth) return sim.balls;
  const S = view.snaps[view.snaps.length - 1];
  if (!S) return [];
  const dt = Math.min(0.3, (now() - S.t) / 1000);
  return S.b.map((b) => ({ x: b.x + b.vx * dt, y: b.y + b.vy * dt })).filter((b) => !cellAt(b.x, b.y));
}
const pkAvail = (i) => (isAuth ? sim.pk[i] <= now() : !!(view.pk & (1 << i)));

// ── messages ────────────────────────────────────────────────────────────────
function onPos(from, m) {
  if (!num(m.x) || !num(m.y) || !num(m.a)) return;
  const t = now();
  let o = others.get(from);
  if (!o) { o = { buf: [], s: m.s | 0, l: m.l | 0, shootAt: 0 }; others.set(from, o); parked.delete(from); }
  if ((m.l | 0) !== o.l) { o.buf.length = 0; o.l = m.l | 0; }
  o.buf.push({ t, x: m.x, y: m.y, a: m.a });
  if (o.buf.length > 8) o.buf.shift();
  o.x = m.x; o.y = m.y; o.a = m.a; o.hp = m.h | 0; o.dead = !!m.d; o.w = m.w | 0; o.r = !!m.r; o.last = t;
  o.k = m.k && typeof m.k === 'object' && !Array.isArray(m.k) ? m.k : {};
  const s = m.s | 0;
  if (s > o.s) {
    o.shootAt = t;
    const v = volAt(o.x, o.y);
    if (o.w === 1) SFX.shotgun(v * 0.8); else SFX.pistol(v * 0.8);
  }
  o.s = s;
}
room.on('message', (from, msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'p': onPos(from, msg); break;
    case 'hit': if (num(msg.d)) takeHit(clamp(msg.d, 0, 110), from); break;
    case 'hurt': if (from === authorityId() && num(msg.d)) takeHit(clamp(msg.d, 0, 25), 'm'); break;
    case 'kf':
      if (msg.by === 'm') addFeed(nick(from) + ' was torn apart');
      else if (num(msg.by)) {
        if (msg.by === myId()) { addFeed('you fragged ' + nick(from)); SFX.frag(); }
        else addFeed(nick(msg.by) + ' fragged ' + nick(from));
      }
      break;
    case 'm': if (!isAuth && from === authorityId()) onSnap(msg); break;
    case 'mh': if (isAuth && num(msg.i) && num(msg.d)) hurtMon(msg.i | 0, clamp(msg.d, 0, 110), from); break;
    case 'pick': if (isAuth && num(msg.i)) grantPick(msg.i | 0, from); break;
    case 'gave': if (from === authorityId() && num(msg.k)) applyPick(clamp(msg.k | 0, 0, 2)); break;
  }
});
room.on('join', (p) => addFeed(p.nick + ' entered'));
room.on('leave', (p) => {
  const o = others.get(p.id);
  if (o) { parked.set(p.id, o.k || {}); others.delete(p.id); }
  addFeed(p.nick + ' left');
});
room.on('hostchange', () => { /* authorityId() follows room.host on its own */ });

// ── shooting ────────────────────────────────────────────────────────────────
const particles = [];
function burst(x, y, z, img, n, up) {
  for (let i = 0; i < n; i++) {
    particles.push({ x: x + (rnd() - 0.5) * 0.15, y: y + (rnd() - 0.5) * 0.15, z: z + (rnd() - 0.5) * 0.1,
      vz: up ? 0.4 + rnd() * 0.3 : (rnd() - 0.2) * 1.5, life: up ? 0.35 : 0.55, img, up });
  }
  if (particles.length > 120) particles.splice(0, particles.length - 120);
}
function interp(o, t) {
  const b = o.buf;
  if (!b.length) return null;
  if (t <= b[0].t) return b[0];
  for (let i = b.length - 1; i > 0; i--) {
    if (b[i - 1].t <= t) {
      const A = b[i - 1], B = b[i];
      if (t >= B.t) return B;
      const f = (t - A.t) / (B.t - A.t);
      let da = B.a - A.a;
      if (da > Math.PI) da -= TAU; else if (da < -Math.PI) da += TAU;
      return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, a: A.a + da * f };
    }
  }
  return b[b.length - 1];
}
const activeOthers = () => [...others].filter(([, o]) => now() - o.last < 3000 && o.buf.length);

function shoot() {
  const w = P.w;
  if (P.ammo[w] <= 0) {
    if (P.ammo[1 - w] > 0) { P.w = 1 - w; P.cool = 0.25; } else { SFX.empty(); P.cool = 0.35; }
    return;
  }
  P.ammo[w]--; P.sc++;
  P.cool = w ? 0.95 : 0.38; P.flash = 0.07; P.kick = 1;
  if (w) SFX.shotgun(1); else SFX.pistol(1);
  const targets = [];
  const rt = now() - 140;
  for (const [id, o] of activeOthers()) {
    if (o.dead) continue;
    const q = interp(o, rt);
    if (q) targets.push({ kind: 'p', id, x: q.x, y: q.y, r: 0.32 });
  }
  monsView().forEach((m, i) => { if (m.st < 4) targets.push({ kind: 'm', id: i, x: m.x, y: m.y, r: 0.38 }); });
  const dmg = new Map();
  const pellets = w ? 7 : 1, spread = w ? 0.1 : 0.015;
  for (let p = 0; p < pellets; p++) {
    const ang = P.a + (rnd() * 2 - 1) * spread, dx = Math.cos(ang), dy = Math.sin(ang);
    let best = castDist(P.x, P.y, dx, dy), hit = null;
    for (const t of targets) {
      const rx = t.x - P.x, ry = t.y - P.y, proj = rx * dx + ry * dy;
      if (proj <= 0 || proj >= best) continue;
      if (rx * rx + ry * ry - proj * proj < t.r * t.r) { best = proj; hit = t; }
    }
    const hx = P.x + dx * (best - 0.05), hy = P.y + dy * (best - 0.05);
    if (hit) {
      const key = hit.kind + hit.id;
      const d = w ? 5 + rnd() * 10 : 8 + rnd() * 8;
      dmg.set(key, { t: hit, d: (dmg.has(key) ? dmg.get(key).d : 0) + d });
      burst(hx, hy, 0.4, BLOOD, 3, false);
    } else burst(hx, hy, 0.45 + (rnd() - 0.5) * 0.2, PUFF, 1, true);
  }
  const auth = authorityId();
  for (const { t, d } of dmg.values()) {
    const dd = Math.round(d);
    if (t.kind === 'p') send({ t: 'hit', d: dd }, { to: t.id });
    else if (isAuth) hurtMon(t.id, dd, myId());
    else if (auth !== null) send({ t: 'mh', i: t.id, d: dd }, { to: auth });
  }
}

// ── the loop ────────────────────────────────────────────────────────────────
const pkReq = [];
const monSt = [];
function update(dt) {
  const t = now(), me = myId(), auth = authorityId();
  const nowAuth = auth !== null && auth === me;
  if (nowAuth && !isAuth) takeOver();
  else if (!nowAuth && isAuth) handOff();
  isAuth = nowAuth;

  const turn = mouseDX * 0.0024; mouseDX = 0;
  let moving = 0;
  if (!P.dead) {
    P.a = normA(P.a + turn + ((keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0)) * 2.6 * dt);
    const fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    const str = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    if (fwd || str) {
      const ca = Math.cos(P.a), sa = Math.sin(P.a), len = Math.hypot(fwd, str);
      const sp = (keys.ShiftLeft || keys.ShiftRight ? 2.2 : 4.2) * dt / len;
      moveEnt(P, (ca * fwd - sa * str) * sp, (sa * fwd + ca * str) * sp, R_PLAYER);
      moving = 1;
    }
    P.cool -= dt;
    if ((mouseFire || keys.Space || keys.ControlLeft) && P.cool <= 0) shoot();
    for (let i = 0; i < PK.length; i++) {
      const p = PK[i];
      if (!pkAvail(i) || !needs(p.k) || dist(P.x, P.y, p.x, p.y) > 0.6 || t - (pkReq[i] || 0) < 500) continue;
      pkReq[i] = t;
      if (isAuth) grantPick(i, me);
      else if (auth !== null) send({ t: 'pick', i }, { to: auth });
    }
  } else if ((t - P.deadAt > 1200 && (mouseFire || keys.Space)) || t - P.deadAt > 6000) respawn();
  P.moveAmt += (moving - P.moveAmt) * Math.min(1, dt * 8);
  P.bob += dt * 9 * P.moveAmt;
  P.flash = Math.max(0, P.flash - dt);
  P.kick = Math.max(0, P.kick - dt * 5);
  P.hurt = Math.max(0, P.hurt - dt * 1.2);
  P.bonus = Math.max(0, P.bonus - dt * 2);

  if (isAuth) { simStep(dt); if (t - sim.lastSnap > 125) sendSnap(); }
  if (t - lastPos > 80) sendPos();

  monsView().forEach((m, i) => {
    const p = monSt[i];
    if (p !== undefined && p !== m.st) {
      const v = volAt(m.x, m.y);
      if (m.st === 2) SFX.growl(v); else if (m.st === 4) SFX.mdie(v);
    }
    monSt[i] = m.st;
  });
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.life -= dt;
    if (q.up) q.z += q.vz * dt; else { q.vz -= 4 * dt; q.z = Math.max(0, q.z + q.vz * dt); }
    if (q.life <= 0) particles.splice(i, 1);
  }
  while (feed.length && t - feed[0].t > 5000) feed.shift();
}

// ── rendering ───────────────────────────────────────────────────────────────
function render() {
  const dX = Math.cos(P.a), dY = Math.sin(P.a), pX = -dY * 0.66, pY = dX * 0.66;
  const px = P.x, py = P.y;
  // floor and ceiling
  const r0x = dX - pX, r0y = dY - pY, r1x = dX + pX, r1y = dY + pY;
  for (let y = HALF + 1; y < VH; y++) {
    const rowD = HALF / (y - HALF);
    const sx = rowD * (r1x - r0x) / W, sy = rowD * (r1y - r0y) / W;
    let fx = px + rowD * r0x, fy = py + rowD * r0y;
    const lvl = Math.min(NL - 1, (rowD * 1.25) | 0);
    const ft = SH[5][lvl], ct = SH[6][lvl], rf = y * W, rc = (VH - y - 1) * W;
    for (let x = 0; x < W; x++) {
      const ti = ((((fy * TS) | 0) & 63) << 6) | (((fx * TS) | 0) & 63);
      buf[rf + x] = ft[ti]; buf[rc + x] = ct[ti];
      fx += sx; fy += sy;
    }
  }
  buf.fill(0xff000000, (HALF - 1) * W, (HALF + 1) * W);
  // walls
  for (let x = 0; x < W; x++) {
    const cam = 2 * x / W - 1, rx = dX + pX * cam, ry = dY + pY * cam;
    let mx = px | 0, my = py | 0;
    const ddx = rx === 0 ? 1e30 : Math.abs(1 / rx), ddy = ry === 0 ? 1e30 : Math.abs(1 / ry);
    let sx, sy, sdx, sdy, side = 0, t = 0;
    if (rx < 0) { sx = -1; sdx = (px - mx) * ddx; } else { sx = 1; sdx = (mx + 1 - px) * ddx; }
    if (ry < 0) { sy = -1; sdy = (py - my) * ddy; } else { sy = 1; sdy = (my + 1 - py) * ddy; }
    for (let g = 0; g < 128; g++) {
      if (sdx < sdy) { sdx += ddx; mx += sx; side = 0; } else { sdy += ddy; my += sy; side = 1; }
      t = cellAt(mx, my);
      if (t) break;
    }
    if (!t) t = 1;
    let perp = side === 0 ? sdx - ddx : sdy - ddy;
    if (perp < 0.02) perp = 0.02;
    zbuf[x] = perp;
    const lh = VH / perp;
    let ys = Math.ceil(HALF - lh / 2), ye = Math.floor(HALF + lh / 2);
    if (ys < 0) ys = 0;
    if (ye > VH - 1) ye = VH - 1;
    let wx = side === 0 ? py + perp * ry : px + perp * rx;
    wx -= Math.floor(wx);
    let tx = (wx * TS) | 0;
    if ((side === 0 && rx > 0) || (side === 1 && ry < 0)) tx = TS - 1 - tx;
    const lvl = Math.min(NL - 1, ((perp * 1.25) | 0) + side * 2);
    const tex = SH[t][lvl], step = TS / lh;
    let tp = (ys - HALF + lh / 2) * step;
    for (let y = ys; y <= ye; y++) { buf[y * W + x] = tex[((tp | 0) & 63) * TS + tx]; tp += step; }
  }
  // sprites
  const list = [];
  const t = now();
  for (let i = 0; i < PK.length; i++) if (pkAvail(i)) list.push({ x: PK[i].x, y: PK[i].y, img: PKIMG[PK[i].k], z: 0 });
  for (const m of monsView()) {
    if (m.st === 5) continue;
    const img = m.st === 4 ? FIEND_DEAD : m.st === 2 ? FIEND[2] : m.st === 3 ? FIEND[3] : FIEND[((t / 220) | 0) & 1];
    list.push({ x: m.x, y: m.y, img, z: 0 });
  }
  for (const [id, o] of activeOthers()) {
    const q = interp(o, t - 140);
    if (!q) continue;
    const fr = soldier(hueOf(id));
    let img;
    if (o.dead) img = fr[4];
    else if (t - o.shootAt < 160) img = fr[3];
    else {
      const b = o.buf, n = b.length;
      const mv = n > 1 && Math.abs(b[n - 1].x - b[n - 2].x) + Math.abs(b[n - 1].y - b[n - 2].y) > 0.02;
      img = mv ? fr[1 + (((t / 180) | 0) & 1)] : fr[0];
    }
    list.push({ x: q.x, y: q.y, img, z: 0 });
  }
  for (const b of ballsView()) list.push({ x: b.x, y: b.y, img: BALL[((t / 90) | 0) & 1], z: 0.28, full: true });
  for (const q of particles) list.push({ x: q.x, y: q.y, img: q.img, z: q.z, full: q.img === SPARK });
  for (const s of list) s.d = (s.x - px) * (s.x - px) + (s.y - py) * (s.y - py);
  list.sort((a, b) => b.d - a.d);
  const invDet = 1 / (pX * dY - dX * pY);
  for (const s of list) {
    const sx = s.x - px, sy = s.y - py;
    const tX = invDet * (dY * sx - dX * sy), tY = invDet * (-pY * sx + pX * sy);
    if (tY < 0.2) continue;
    const im = s.img, scrX = HW * (1 + tX / tY);
    const hgt = (VH / tY) * im.h * PX, wid = (VH / tY) * im.w * PX;
    const bottom = HALF + HALF / tY - s.z * VH / tY, top = bottom - hgt, x0 = scrX - wid / 2;
    const xs = Math.max(0, Math.ceil(x0)), xe = Math.min(W - 1, Math.floor(x0 + wid));
    const ys = Math.max(0, Math.ceil(top)), ye = Math.min(VH - 1, Math.floor(bottom));
    if (xs > xe || ys > ye) continue;
    const f = s.full ? 256 : (lightF(Math.min(NL - 1, (tY * 1.25) | 0)) * 256) | 0;
    const iw = im.w, ih = im.h, d = im.data;
    for (let x = xs; x <= xe; x++) {
      if (tY >= zbuf[x]) continue;
      const tx = Math.min(iw - 1, ((x - x0) / wid * iw) | 0);
      for (let y = ys; y <= ye; y++) {
        const ty = Math.min(ih - 1, ((y - top) / hgt * ih) | 0);
        const c = d[ty * iw + tx];
        if (c) buf[y * W + x] = f >= 256 ? c : shade(c, f);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

function muzzle(x, y, r) {
  const gr = ctx.createRadialGradient(x, y, 1, x, y, r);
  gr.addColorStop(0, 'rgba(255,255,225,1)'); gr.addColorStop(0.4, 'rgba(255,200,60,0.9)'); gr.addColorStop(1, 'rgba(255,110,0,0)');
  ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
function drawWeapon() {
  if (P.dead) return;
  const g = ctx, m = P.moveAmt;
  const bx = (HW + Math.sin(P.bob) * 7 * m) | 0;
  const by = (VH + Math.abs(Math.cos(P.bob)) * 5 * m + P.kick * 9) | 0;
  if (P.w === 1) {
    if (P.flash > 0) muzzle(bx, by - 72, 22);
    rect(g, bx - 9, by - 68, 18, 6, '#1c1c20');
    rect(g, bx - 9, by - 62, 18, 34, '#4a4b52');
    rect(g, bx - 1, by - 62, 2, 34, '#2a2b30');
    rect(g, bx - 7, by - 62, 2, 34, '#6a6c74'); rect(g, bx + 3, by - 62, 2, 34, '#6a6c74');
    ell(g, bx - 4, by - 65, 2.5, 2, '#000'); ell(g, bx + 4, by - 65, 2.5, 2, '#000');
    rect(g, bx - 12, by - 40, 24, 12, '#6b4423');
    for (let i = 0; i < 4; i++) rect(g, bx - 12, by - 38 + i * 3, 24, 1, '#4e301a');
    g.fillStyle = '#2e2f35'; g.beginPath();
    g.moveTo(bx - 11, by - 28); g.lineTo(bx + 11, by - 28); g.lineTo(bx + 20, by); g.lineTo(bx - 20, by); g.closePath(); g.fill();
    rect(g, bx - 26, by - 16, 13, 16, '#3f4a2e'); rect(g, bx + 13, by - 16, 13, 16, '#3f4a2e');
  } else {
    if (P.flash > 0) muzzle(bx, by - 60, 15);
    rect(g, bx - 6, by - 56, 12, 26, '#5a5d66');
    rect(g, bx - 6, by - 56, 12, 2, '#7d808a');
    rect(g, bx - 2, by - 55, 4, 3, '#000');
    rect(g, bx - 8, by - 30, 16, 14, '#383a40');
    rect(g, bx - 11, by - 18, 22, 18, '#3f4a2e');
  }
}
function text(s, x, y, size, col, align) {
  ctx.font = (size >= 14 ? 'bold ' : '') + size + 'px monospace';
  ctx.textAlign = align || 'left';
  ctx.fillStyle = '#000'; ctx.fillText(s, x + 1, y + 1);
  ctx.fillStyle = col; ctx.fillText(s, x, y);
}
function drawHud() {
  drawWeapon();
  const g = ctx, t = now(), me = myId();
  if (!P.dead) { rect(g, HW - 3, HALF, 2, 1, '#e0e0a0'); rect(g, HW + 2, HALF, 2, 1, '#e0e0a0'); rect(g, HW, HALF - 3, 1, 2, '#e0e0a0'); rect(g, HW, HALF + 2, 1, 2, '#e0e0a0'); }
  if (P.hurt > 0) { g.fillStyle = `rgba(200,0,0,${Math.min(0.55, P.hurt * 0.55)})`; g.fillRect(0, 0, W, VH); }
  if (P.bonus > 0) { g.fillStyle = `rgba(255,220,80,${P.bonus * 0.3})`; g.fillRect(0, 0, W, VH); }
  if (P.dead) {
    g.fillStyle = 'rgba(90,0,0,0.55)'; g.fillRect(0, 0, W, VH);
    text('YOU DIED', HW, 80, 24, '#ff3a2a', 'center');
    text(P.killer, HW, 100, 9, '#f0d0c0', 'center');
    if (t - P.deadAt > 1200) text('click or Space to respawn', HW, 120, 8, '#ddd', 'center');
  }
  feed.forEach((f, i) => text(f.text, 4, 12 + i * 10, 8, '#ffe0a0'));
  // scores
  const rows = [{ id: me, n: nick(me) }];
  for (const [id] of activeOthers()) rows.push({ id, n: nick(id) });
  if (rows.length > 1 || keys.Tab) {
    rows.forEach((r) => { r.f = fragsOf(r.id); r.kl = killsOf(r.id); });
    rows.sort((a, b) => b.f - a.f || b.kl - a.kl);
    const x0 = W - 104;
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x0 - 3, 2, 105, 13 + rows.length * 9);
    text('PLAYER      FRG KIL', x0, 11, 8, '#aaa');
    rows.forEach((r, i) => {
      const col = r.id === me ? '#ffe060' : `hsl(${hueOf(r.id)},70%,70%)`;
      text(String(r.n).slice(0, 11).padEnd(12) + String(r.f).padStart(3) + String(r.kl).padStart(4), x0, 20 + i * 9, 8, col);
    });
  }
  // status bar
  const y0 = VH;
  rect(g, 0, y0, W, 40, '#4a4a46'); rect(g, 0, y0, W, 1, '#7a7a74'); rect(g, 0, H - 1, W, 1, '#22221f');
  const cells = [[0, 62, 'AMMO', String(P.ammo[P.w])], [62, 74, 'HEALTH', Math.max(0, P.hp) + '%'], [136, 64, 'ARMS', null],
    [200, 60, 'FRAGS', String(fragsOf(me))], [260, 60, 'KILLS', String(killsOf(me))]];
  for (const [x, w, label, val] of cells) {
    rect(g, x + 2, y0 + 3, w - 4, 34, '#2c2c2a'); rect(g, x + 2, y0 + 3, w - 4, 1, '#1a1a18');
    text(label, x + w / 2, y0 + 35, 8, '#c8c8c0', 'center');
    if (val !== null) text(val, x + w / 2, y0 + 24, 18, '#d42020', 'center');
  }
  text('1 PISTOL ' + P.ammo[0], 141, y0 + 13, 8, P.w === 0 ? '#ffd040' : '#888');
  text('2 SHOTGN ' + P.ammo[1], 141, y0 + 24, 8, P.w === 1 ? '#ffd040' : '#888');
  // start screen / hints
  if (!everClicked) {
    g.fillStyle = 'rgba(0,0,0,0.72)'; g.fillRect(0, 0, W, VH);
    text('GLOOM', HW, 62, 32, '#d42020', 'center');
    text('click to play', HW, 88, 10, '#fff', 'center');
    text('WASD move   mouse / arrows turn', HW, 112, 8, '#ccc', 'center');
    text('click / Space fire   1 2 Q wheel weapons', HW, 124, 8, '#ccc', 'center');
    text('Shift walk   Tab scores', HW, 136, 8, '#ccc', 'center');
    text(room.me ? 'frag everyone, kill fiends' : 'solo run: the fiends are waiting', HW, 160, 8, '#e08070', 'center');
  } else if (document.pointerLockElement !== cv) {
    text('click to capture the mouse', HW, VH - 6, 8, '#bbb', 'center');
  }
}

let last = now(), failed = false;
function frame(ts) {
  const dt = Math.min(0.05, Math.max(0, (ts - last) / 1000));
  last = ts;
  try { update(dt); render(); drawHud(); }
  catch (e) { if (!failed) { failed = true; console.log('gloom error: ' + (e && e.stack ? e.stack : e)); } }
  requestAnimationFrame(frame);
}
respawn();
P.spawnAt = now() - SPAWN_SAFE + 3000;   // a little grace on the very first spawn
requestAnimationFrame(frame);