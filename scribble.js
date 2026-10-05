/**
 * @disk     scribble
 * @author   diskroom
 * @version  6
 * @players  1-8
 * @about    A shared page to draw on. Every stroke lands on everyone else's canvas, nobody is in charge, and one player who already has the ink catches a latecomer up.
 * @tags     toy, drawing, canvas, example
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/scribble.png
 */
// scribble.js — the disk with no authority in it at all.
//
// tag.js gives one seat the last word on a catch, because two players can
// claim the same one. Here there is nothing to claim: a stroke never collides
// with another stroke, so whoever already holds the ink can hand it to a
// newcomer — any one of them, since every copy holds the same strokes under the
// same ids, and a run that arrives twice finds its points already in place.

// ── layout ───────────────────────────────────────────────────────────────
document.documentElement.style.cssText = 'height:100%';
// `-webkit-touch-callout` and the selection rules are not decoration: a
// finger held still on iOS Safari is a long press, and a long press there
// selects what is under it and puts a Copy / Look Up bar over the page —
// which takes the pointer away mid-gesture and ends the hold. A drag escapes
// it because the movement cancels the press, so a game played by dragging
// never meets this; one played by holding meets it every time.
document.body.style.cssText =
  'margin:0;height:100%;overflow:hidden;background:#ececec;' +
  'font-family:system-ui,sans-serif;touch-action:none;' +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;';

const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;display:block;touch-action:none';
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

const COLORS = ['#111111', '#e63946', '#f4a261', '#2a9d8f', '#264653', '#e9c46a', '#a06cd5', '#ffffff'];
const SIZES = [3, 6, 11, 18];

let curColor = COLORS[0];
let curSize = SIZES[1];

// ── toolbar ──────────────────────────────────────────────────────────────
// A thumb is a blunter instrument than a mouse pointer, so the buttons are
// bigger where the screen says the pointer is coarse. It is the size that
// changes and nothing else: a target of a couple of dozen pixels is a target
// missed on a phone, and a miss here paints a stroke in the wrong colour on
// everybody's canvas at once.
const COARSE = matchMedia('(pointer: coarse)').matches;
const SWATCH = COARSE ? 34 : 24;
const KNOB = COARSE ? 38 : 28;

// The bar wraps rather than running off the sides. Twelve buttons in a row
// need about 450 px and a phone held upright has 375: unwrapped, the pill sits
// centred on the screen with both of its ends — one of them the clear button —
// hanging off it where no finger can reach them.
//
// The centring is a strip of its own rather than `left:50%` on the pill,
// because a wrapping box centred that way has only the right half of the
// screen to lay itself out in and folds into a tall column down one side. The
// strip spans the whole width and the pill is still only as wide as its
// buttons need, so on a screen where they fit in a row nothing about it moves.
const strip = document.createElement('div');
strip.style.cssText =
  'position:fixed;left:0;right:0;bottom:16px;display:flex;justify-content:center;' +
  'padding:0 8px;box-sizing:border-box;pointer-events:none';
document.body.appendChild(strip);

const bar = document.createElement('div');
bar.style.cssText =
  'display:flex;flex-wrap:wrap;justify-content:center;max-width:100%;box-sizing:border-box;' +
  'align-items:center;gap:10px;padding:8px 12px;border-radius:22px;pointer-events:auto;' +
  'background:rgba(255,255,255,0.92);box-shadow:0 2px 12px rgba(0,0,0,0.18)';
strip.appendChild(bar);

const swatchEls = [];
COLORS.forEach((c) => {
  const s = document.createElement('button');
  s.style.cssText =
    `width:${SWATCH}px;height:${SWATCH}px;border-radius:50%;background:${c};cursor:pointer;` +
    `border:2px solid ${c === '#ffffff' ? '#ccc' : c};box-sizing:border-box;padding:0`;
  s.onclick = () => selectColor(c);
  bar.appendChild(s);
  swatchEls.push(s);
});

function selectColor(c) {
  curColor = c;
  swatchEls.forEach((el, i) => {
    el.style.boxShadow = COLORS[i] === c ? '0 0 0 3px rgba(0,0,0,0.35)' : 'none';
  });
}
selectColor(curColor);

const divider1 = document.createElement('div');
divider1.style.cssText = `width:1px;height:${KNOB - 6}px;background:#ddd`;
bar.appendChild(divider1);

const sizeEls = [];
SIZES.forEach((sz) => {
  const b = document.createElement('button');
  b.style.cssText =
    `width:${KNOB}px;height:${KNOB}px;border-radius:50%;background:#f2f2f2;cursor:pointer;` +
    'border:2px solid transparent;box-sizing:border-box;padding:0;display:flex;' +
    'align-items:center;justify-content:center';
  const dot = document.createElement('span');
  dot.style.cssText = `display:block;border-radius:50%;background:#333;width:${sz}px;height:${sz}px`;
  b.appendChild(dot);
  b.onclick = () => selectSize(sz, b);
  bar.appendChild(b);
  sizeEls.push(b);
});

function selectSize(sz, el) {
  curSize = sz;
  sizeEls.forEach((e) => (e.style.borderColor = 'transparent'));
  el.style.borderColor = '#333';
}
selectSize(curSize, sizeEls[1]);

const divider2 = document.createElement('div');
divider2.style.cssText = `width:1px;height:${KNOB - 6}px;background:#ddd`;
bar.appendChild(divider2);

const clearBtn = document.createElement('button');
clearBtn.textContent = 'Clear';
clearBtn.style.cssText =
  `padding:0 14px;height:${KNOB}px;border-radius:999px;border:none;background:#f2f2f2;` +
  'cursor:pointer;font-size:13px;color:#333';
clearBtn.onclick = () => {
  epoch += 1;
  wipe();
  room.send({ t: 'clear', e: epoch });
};
bar.appendChild(clearBtn);

// ── shared drawing state ────────────────────────────────────────────────
// Every stroke is additive and strokes never conflict with each other, so
// there is no need for a single authority: any player who already holds a
// stroke can hand it to a newcomer, and duplicates are harmless (same id).
//
// A point knows its place in its stroke, and it is put there whichever way it
// arrives — as the drawer sends it, or in a catch-up from somebody who already
// holds it. The two roads cross for a stroke still being drawn when somebody
// arrives: its tail comes from the drawer while its head is still queued in a
// catch-up, and a stroke that could only grow at its end would keep the tail
// and turn the head away as a repeat.
const strokes = new Map(); // id -> { c, w, p: [[x,y], ...] with holes, n: points held }  x,y in 0..1
const order = [];          // insertion order, oldest first
let pointCount = 0;
const MAX_POINTS = 12000;  // keeps redraws and catch-up payloads small
const MAX_STROKE = 20000;  // no place in a stroke past this: an offset off the wire is somebody's claim

// Which clear the page is past. Every message about ink says which clear it was
// drawn after, so ink from before a clear — a catch-up already on the wire, a
// run a drawer sent before the clear reached them — is recognised and dropped
// rather than painted back onto a page everybody else has wiped.
let epoch = 0;

function myId() {
  return room.me ? room.me.id : -1;
}

function forget(id) {
  const s = strokes.get(id);
  if (s) pointCount -= s.n;
  strokes.delete(id);
}

// Oldest first, and never the stroke under this player's own finger. What is
// forgotten is taken off the canvas as well: left there, it would stay on
// screen until a resize wiped it and never reach anybody arriving after.
function prune() {
  if (pointCount <= MAX_POINTS) return;
  let dropped = false;
  for (let i = 0; pointCount > MAX_POINTS && i < order.length - 1;) {
    if (order[i] === curId) { i += 1; continue; }
    forget(order[i]);
    order.splice(i, 1);
    dropped = true;
  }
  if (dropped) redrawAll();
}

function wipe() {
  strokes.clear();
  order.length = 0;
  pointCount = 0;
  catchUp.length = 0;
  blankPage();
  // A stroke under the finger when the page is wiped is wiped with it; the
  // rest of that drag draws nothing rather than feeding a stroke that is gone.
  drawing = false;
  curId = null;
  pending = [];
}

// ── the page ─────────────────────────────────────────────────────────────
// One page of one shape for everybody, as large as the screen allows and
// centred in it; what is left over is margin. A point is a fraction of the
// page, and a stroke's width is in the page's own units, so a drawing is the
// same drawing on a phone held upright and on a wide monitor. Fractions of each
// player's own window made a circle drawn on one an ellipse on the other, and
// ink near an edge landed somewhere else entirely.
const PAGE_W = 4, PAGE_H = 3;  // the page's shape
const PAGE_REF = 960;          // the page width, in CSS pixels, a stroke's width is measured against
let page = { x: 0, y: 0, w: 1, h: 1 };   // in CSS pixels

function blankPage() {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(page.x * dpr, page.y * dpr, page.w * dpr, page.h * dpr);
  ctx.restore();
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  const w = Math.min(innerWidth, (innerHeight * PAGE_W) / PAGE_H);
  const h = (w * PAGE_H) / PAGE_W;
  page = { x: (innerWidth - w) / 2, y: (innerHeight - h) / 2, w, h };
  // Resizing a canvas resets its state, the clip included, so everything the
  // context carries is set again here.
  ctx.fillStyle = '#ececec';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  ctx.rect(page.x * dpr, page.y * dpr, page.w * dpr, page.h * dpr);
  ctx.clip();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  redrawAll();
}

// A point on the page, in device pixels.
function px(pt) {
  const dpr = window.devicePixelRatio || 1;
  return [(page.x + pt[0] * page.w) * dpr, (page.y + pt[1] * page.h) * dpr];
}

// A stroke's width on this screen: the same share of the page everywhere.
function inked(width) {
  return Math.max(1, width * (window.devicePixelRatio || 1) * (page.w / PAGE_REF));
}

function paintSegment(a, b, color, width) {
  const p1 = px(a), p2 = px(b);
  ctx.strokeStyle = color;
  ctx.lineWidth = inked(width);
  ctx.beginPath();
  ctx.moveTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.stroke();
}

function paintDot(a, color, width) {
  const p1 = px(a);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p1[0], p1[1], inked(width) / 2, 0, Math.PI * 2);
  ctx.fill();
}

// A stroke with holes in it is painted where it is whole; a point with no
// neighbour yet is a dot, which the segment that later reaches it covers.
function paintStroke(s) {
  for (let j = 0; j < s.p.length; j++) {
    if (!s.p[j]) continue;
    if (s.p[j - 1]) paintSegment(s.p[j - 1], s.p[j], s.c, s.w);
    else if (!s.p[j + 1]) paintDot(s.p[j], s.c, s.w);
  }
}

function redrawAll() {
  blankPage();
  for (const id of order) paintStroke(strokes.get(id));
}

window.addEventListener('resize', resize);
resize();

// ── points, wherever they come from ─────────────────────────────────────────
const isPoint = (pt) =>
  Array.isArray(pt) && pt.length === 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]);

// The stroke a message names, made if this is the first word of it. What a
// message says about colour and width is somebody's claim and is read as one.
function strokeOf(id, c, w) {
  let s = strokes.get(id);
  if (!s) {
    s = {
      c: typeof c === 'string' && c.length <= 32 ? c : COLORS[0],
      w: Number.isFinite(w) ? Math.max(1, Math.min(40, w)) : SIZES[1],
      p: [],
      n: 0,
    };
    strokes.set(id, s);
    order.push(id);
  }
  return s;
}

// Puts a run of points at its place, keeping any point already held there.
function place(s, o, pts) {
  for (let i = 0; i < pts.length; i++) {
    const j = o + i;
    if (j >= MAX_STROKE) break;
    if (s.p[j] || !isPoint(pts[i])) continue;
    s.p[j] = pts[i];
    s.n += 1;
    pointCount += 1;
    if (s.p[j - 1]) paintSegment(s.p[j - 1], s.p[j], s.c, s.w);
    if (s.p[j + 1]) paintSegment(s.p[j], s.p[j + 1], s.c, s.w);
    if (!s.p[j - 1] && !s.p[j + 1]) paintDot(s.p[j], s.c, s.w);
  }
}

// Whether a message about ink belongs to this page. Ink from a later clear
// than this copy knows of means a clear it never heard — a newcomer's catch-up
// after one, say — so the page is wiped up to it first.
function current(e) {
  if (!Number.isInteger(e) || e < epoch) return false;
  if (e > epoch) {
    epoch = e;
    wipe();
  }
  return true;
}

// ── local input, throttled network out ──────────────────────────────────
let drawing = false;
let curId = null;
let curPointer = null;   // the finger or mouse this stroke belongs to
let pending = [];
let pendingAt = 0;       // the place of the first pending point in its stroke

// A pointer as a point on the page. A drag that runs off the page goes on
// along its edge rather than off it.
const onPage = (e) =>
  e.clientX >= page.x && e.clientX <= page.x + page.w && e.clientY >= page.y && e.clientY <= page.y + page.h;
function norm(e) {
  const fit = (v) => Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000;
  return [fit((e.clientX - page.x) / page.w), fit((e.clientY - page.y) / page.h)];
}

// A stroke belongs to one pointer from beginning to end. On a phone that is
// not a formality: a second finger landing — a palm on the glass, the other
// hand steadying it — would otherwise take `curId` over, and the points the
// first finger is still drawing would be appended to the second one's stroke
// and sent to the room as part of it.
canvas.addEventListener('pointerdown', (e) => {
  if (drawing || !onPage(e)) return;
  drawing = true;
  curPointer = e.pointerId;
  curId = myId() + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const pt = norm(e);
  place(strokeOf(curId, curColor, curSize), 0, [pt]);
  pending = [pt];
  pendingAt = 0;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!drawing || e.pointerId !== curPointer) return;
  const s = strokes.get(curId);
  if (!s || s.p.length >= MAX_STROKE) return;
  const pt = norm(e);
  if (!pending.length) pendingAt = s.p.length;
  place(s, s.p.length, [pt]);
  pending.push(pt);
});

function stopStroke(e) {
  if (!drawing || (e && e.pointerId !== curPointer)) return;
  flush();
  drawing = false;
  curId = null;
  curPointer = null;
}
canvas.addEventListener('pointerup', stopStroke);
canvas.addEventListener('pointercancel', stopStroke);
canvas.addEventListener('pointerleave', stopStroke);

// Talk at ~20 Hz, well under the ceiling, and only when there is something
// new to say.
function flush() {
  const s = curId && strokes.get(curId);
  if (s && pending.length) {
    room.send({ t: 'seg', e: epoch, id: curId, c: s.c, w: s.w, o: pendingAt, p: pending });
  }
  pending = [];
}
// ── catching a newcomer up ───────────────────────────────────────────────
// A canvas holds far more than one payload does, so it travels as a pile of
// runs drained on the timer below rather than sent in a loop. A loop long
// enough to empty the platform's burst allowance has everything past it
// dropped without a word, and the newcomer is left holding half a drawing with
// no error to explain it.
//
// And one player hands it over, not everybody who holds it. Every copy carries
// the same ink, so a second answer is the same canvas sent again — and a full
// room all answering one newcomer at once spends the room's shared byte
// ceiling several times over, which drops the tail of every answer, the one
// that mattered included.
const catchUp = [];
let lastTo = null;         // whom the last chunk went to

function queueCatchUp(to) {
  for (const chunk of buildSyncChunks()) catchUp.push({ to, s: chunk });
  catchUp.push({ to, done: true });
}

function say(msg, to) {
  try { room.send(msg, { to }); } catch (e) { /* they have left; whoever asked moves on */ }
}

// The newcomer's side: one player asked at a time, in the room's order — the
// host first, who has been here longest. A player with nothing to give, or
// still being caught up themselves and so holding only part of the page, says
// so and the next one is asked. One who falls silent half-way, or leaves, is
// passed over the same way, and what the next one sends lands on the points
// already held.
const ASK_WAIT = 2000;     // ms of silence from the one asked before asking the next
const asked = new Set();
let asking = null;         // the id of the player handing the page over, while one is
let heardAt = 0;
let settled = false;       // this page holds the room's ink: caught up, or there was none

function askNext() {
  asking = null;
  const next = room.me && room.players.find((p) => p.id !== myId() && !asked.has(p.id));
  if (!next) {
    settled = true;
    return;
  }
  asked.add(next.id);
  asking = next.id;
  heardAt = performance.now();
  say({ t: 'hello' }, next.id);
}

setInterval(() => {
  flush();
  // One chunk a tick — twenty a second, which alongside `flush` above stays
  // clear of the platform's ceiling even while this player is drawing. Taken
  // in turn among those waiting rather than one newcomer's page after
  // another's: the second in line would otherwise hear nothing for as long as
  // the first page takes, give this player up for gone, and ask somebody else
  // to send the whole page again.
  const turn = catchUp.findIndex((c) => c.to !== lastTo);
  const next = catchUp.splice(turn >= 0 ? turn : 0, 1)[0];
  if (next) {
    lastTo = next.to;
    say(next.done ? { t: 'synced' } : { t: 'sync', e: epoch, s: next.s }, next.to);
  }
  if (asking !== null && performance.now() - heardAt > ASK_WAIT) askNext();
  prune();
}, 50);

room.on('leave', (p) => {
  for (let i = catchUp.length - 1; i >= 0; i--) if (catchUp[i].to === p.id) catchUp.splice(i, 1);
  if (p.id === asking) askNext();
});

// ── network in ───────────────────────────────────────────────────────────
// `o` is the place of the run's first point inside its stroke, so a stroke too
// long for one payload arrives in several and the receiver knows where each
// piece belongs. Splitting by whole strokes is not enough: an unbroken drag of
// a few seconds is already past a payload on its own.
const CHUNK_BYTES = 3600;  // under the payload ceiling, with the envelope allowed for
const RUN_POINTS = 200;    // ~3.4 KB of points at four decimals apiece

function buildSyncChunks() {
  const chunks = [];
  let cur = [];
  let size = 32;           // `{"t":"sync","e":0,"s":[]}` and the commas between entries
  const put = (entry) => {
    const len = JSON.stringify(entry).length + 1;
    if (cur.length && size + len > CHUNK_BYTES) {
      chunks.push(cur);
      cur = [];
      size = 32;
    }
    cur.push(entry);
    size += len;
  };
  for (const id of order) {
    const s = strokes.get(id);
    // Only the whole stretches of a stroke: a hole is a run on its way to
    // this copy too, and it is not this copy's to hand on yet.
    for (let o = 0; o < s.p.length;) {
      if (!s.p[o]) { o += 1; continue; }
      let end = o;
      while (end < s.p.length && end - o < RUN_POINTS && s.p[end]) end += 1;
      // `slice`, not a reference: the run is measured now and sent later, and a
      // stroke still being drawn would grow past the ceiling in between.
      put({ id, c: s.c, w: s.w, o, p: s.p.slice(o, end) });
      o = end;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// A run off the wire: a place in a stroke and the points from there.
const runOf = (id, o, p) =>
  typeof id === 'string' && id.length <= 64 && Number.isInteger(o) && o >= 0 && o < MAX_STROKE &&
  Array.isArray(p);

room.on('message', (from, msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'seg') {
    if (!current(msg.e) || !runOf(msg.id, msg.o, msg.p)) return;
    place(strokeOf(msg.id, msg.c, msg.w), msg.o, msg.p);
  } else if (msg.t === 'clear') {
    if (Number.isInteger(msg.e) && msg.e > epoch) {
      epoch = msg.e;
      wipe();
    }
  } else if (msg.t === 'hello') {
    // Nothing is ever replayed by the platform, so a player who holds the
    // page hands it over; one who does not says so, and is passed over.
    if (settled && order.length) queueCatchUp(from);
    else say({ t: 'none' }, from);
  } else if (msg.t === 'sync') {
    if (from === asking) heardAt = performance.now();
    if (!current(msg.e) || !Array.isArray(msg.s)) return;
    for (const run of msg.s) {
      if (!run || !runOf(run.id, run.o, run.p)) continue;
      place(strokeOf(run.id, run.c, run.w), run.o, run.p);
    }
    prune();
  } else if (msg.t === 'synced' && from === asking) {
    asking = null;
    settled = true;
  } else if (msg.t === 'none' && from === asking) {
    askNext();
  }
});

// Ask the room to catch us up. Outside a room — the studio's "Test locally",
// a disk's own "Run solo" — there is nobody to ask, and the canvas starts blank.
askNext();
