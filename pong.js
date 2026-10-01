/**
 * @disk     pong
 * @author   diskroom
 * @version  13
 * @players  1-8
 * @about    Pong on a shared table, played on the arrow keys, W and S, or by dragging a thumb up and down. Two seats, everyone else watches, and an empty seat is played by a bot.
 * @tags     game, arcade, realtime, example, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/pong.png
 */
// pong.js — pong where the room's order is the referee.
//
// Nobody runs the table. Every copy holds all of it and changes it only on
// what comes back from the room: a hand is sent with `{ echo: true }` and
// applied when the room hands it back, at the place the room gave it, and so
// is a tick — one step of the table. Every copy applies the same things in the
// same order to the same starting table, and so holds the same table, without
// any copy deciding for the others.
//
// What that buys is where the wait is. In the legacy pong.js
// (disks/legacy/pong.js) a hand goes to the server, on to the host, back to the
// server and back again: two trips. Here it goes to the server and back: one
// trip, plus up to one tick waiting for the next step of the table.
//
// Somebody still keeps the clock — the host sends the ticks — but the clock is
// not in the way. A hand joins whichever tick reaches the server after it, and
// ticks pass the server continuously, so how far the host is from the server
// decides how evenly the table moves and not how late a hand lands.
//
// The price is that the table has to come out the same on every machine to
// the last bit, from the same moves. So nothing below reads a clock, draws a
// random number the others cannot draw, or calls a function an engine may
// round its own way: `Math.sin` and `Math.cos` are allowed to differ between
// browsers in the last digit, and one digit becomes a different rally a minute
// later. What the table does use — `+ - * /`, comparisons, `Math.imul` — is
// the same everywhere by the letter of the language.
//
// Your own paddle does not wait even for that one trip: the table drawn is the
// agreed one played forward by the trip it takes, with your hand in it, and
// replayed from the agreed one whenever that moves. The kernel at the bottom
// is the same in every lockstep disk; what sits above it is the game.

// ── the table, in field units ──────────────────────────────────────────────
const FW = 1.6, FH = 1.0;          // field width and height
const BR = 0.018;                  // ball radius
const PW = 0.022, PH = 0.18;       // paddle width and height
const PX = 0.06;                   // paddle centre, distance from its wall
const V0 = 0.85, VMAX = 2.4;       // serve speed and ceiling, units per second
const VGAIN = 1.05;                // speed added by every paddle hit
const MAXANG = 0.95;               // steepest bounce off a paddle, radians
const PSPEED = 1.5;                // how fast a paddle travels, units per second
const BOT_SPEED = 0.95;            // a beatable bot: slower than a good rally
const WIN = 7;

// ── the clock ──────────────────────────────────────────────────────────────
const HZ = 30;                     // steps of the table per second
const STEPS_PER_TICK = 1;
// No guess ahead: a paddle drawn a trip ahead of the ball it is meant to meet
// shows a hit or a miss that the table does not agree with.
const PREDICT = false;
const STEP = 1 / HZ;               // seconds one step covers
const SUB = 8;                     // substeps per step: a fast ball must not step over a paddle
const SERVE_STEPS = 36;            // the pause before a serve
const WIN_STEPS = 4 * HZ;          // the pause after a game is won

// ── arithmetic that comes out the same everywhere ──────────────────────────
// sin and cos from `+ - * /` alone. Accuracy is not the point — the angles here
// never pass MAXANG, and these series are closer than a paddle can tell there;
// the point is that every engine computes them identically.
function dsin(x) {
  const x2 = x * x;
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - x2 / 110)))));
}
function dcos(x) {
  const x2 = x * x;
  return 1 - (x2 / 2) * (1 - (x2 / 12) * (1 - (x2 / 30) * (1 - (x2 / 56) * (1 - x2 / 90))));
}

// A random number every copy draws alike: its state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ── the table, as every copy holds it ──────────────────────────────────────
// Plain data only: it is fingerprinted as JSON and handed to a latecomer as
// JSON. The ball carries its speed beside its velocity, so that a hit never
// needs a square root to know how fast it was going.
function freshTable(seed) {
  return {
    b: [FW / 2, FH / 2, 0, 0, 0],  // ball: x, y, vx, vy, speed
    p: [FH / 2, FH / 2],           // paddle y, per seat
    c: [0, 0],                     // score, per seat
    q: [null, null],               // seat -> player id, null means the bot has it
    sv: SERVE_STEPS,               // steps until the next serve; 0 means the ball is live
    w: null,                       // winning seat, or null while the game is on
    d: 1,                          // which way the next serve goes
    rng: seed | 0,
    push: {},                      // player id -> -1, 0 or 1, as last heard in the room's order
  };
}

const clampY = (y) => Math.max(PH / 2, Math.min(FH - PH / 2, y));

// Somebody gone from the room, or not heard from in a while: the kernel says
// which, in a tick, so every copy lets them go at the same step.
function leave(w, id) {
  for (let s = 0; s < 2; s++) if (w.q[s] === id) w.q[s] = null;
  delete w.push[id];
}

// Everybody who has been heard, seated or watching.
const playersIn = (w) => Object.keys(w.push).map(Number);

// A hand, applied at its place in the room's order. Speaking is also how a
// seat is taken: the first to be heard while a paddle is free gets it.
function hand(w, id, dir) {
  w.push[id] = dir;
  if (w.q[0] === id || w.q[1] === id) return;
  const free = w.q[0] === null ? 0 : w.q[1] === null ? 1 : -1;
  if (free >= 0) w.q[free] = id;
}

function paddleHit(w, s) {
  const b = w.b;
  const px = s === 0 ? PX : FW - PX;
  const face = s === 0 ? px + PW / 2 + BR : px - PW / 2 - BR;
  if (s === 0 ? b[2] >= 0 : b[2] <= 0) return;            // already going away
  if (s === 0 ? b[0] > face : b[0] < face) return;        // not at the paddle yet
  if (Math.abs(b[0] - px) > 0.05) return;                 // long past it: that was a point
  const rel = (b[1] - w.p[s]) / (PH / 2 + BR);
  if (Math.abs(rel) > 1) return;                          // missed
  const speed = Math.min(b[4] * VGAIN, VMAX);
  const ang = rel * MAXANG;                               // the edges of the paddle steer
  b[2] = dcos(ang) * speed * (s === 0 ? 1 : -1);
  b[3] = dsin(ang) * speed;
  b[4] = speed;
}

function serve(w) {
  const ang = (draw01(w) * 2 - 1) * 0.5;
  w.b = [FW / 2, FH / 2, dcos(ang) * V0 * w.d, dsin(ang) * V0, V0];
}

function point(w, s) {
  w.c[s]++;
  w.b = [FW / 2, FH / 2, 0, 0, 0];
  w.d = s === 0 ? 1 : -1;          // the ball goes back to whoever was scored on
  w.sv = w.c[s] >= WIN ? WIN_STEPS : SERVE_STEPS;
  if (w.c[s] >= WIN) w.w = s;
}

function newGame(w) {
  w.c = [0, 0];
  w.w = null;
  w.b = [FW / 2, FH / 2, 0, 0, 0];
  w.sv = SERVE_STEPS;
}

// One step of the table. The only place it moves, and a function of the table
// alone.
function step(w) {
  for (let s = 0; s < 2; s++) {
    const id = w.q[s];
    if (id === null) {
      // The bot: it steers itself toward the ball when the ball is coming.
      const coming = s === 0 ? w.b[2] < 0 : w.b[2] > 0;
      const target = coming ? w.b[1] : FH / 2;
      const d = target - w.p[s];
      w.p[s] = clampY(w.p[s] + Math.sign(d) * Math.min(BOT_SPEED * STEP, Math.abs(d)));
      continue;
    }
    const dir = w.push[id] || 0;
    if (dir) w.p[s] = clampY(w.p[s] + dir * PSPEED * STEP);
  }

  if (w.w !== null) {
    if (--w.sv <= 0) newGame(w);
    return;
  }
  if (w.sv > 0) {
    if (--w.sv <= 0) serve(w);
    return;
  }
  const b = w.b;
  const h = STEP / SUB;
  for (let i = 0; i < SUB; i++) {
    b[0] += b[2] * h;
    b[1] += b[3] * h;
    if (b[1] < BR) { b[1] = BR; b[3] = Math.abs(b[3]); }
    if (b[1] > FH - BR) { b[1] = FH - BR; b[3] = -Math.abs(b[3]); }
    paddleHit(w, 0);
    paddleHit(w, 1);
    if (b[0] < -0.1) return point(w, 1);
    if (b[0] > FW + 0.1) return point(w, 0);
  }
}

const inputOf = (d) => (d === 1 || d === -1 || d === 0 ? d : null);

// A table handed over by somebody else is somebody else's claim, and is read
// as one: the right shape, finite numbers, ids that are ids.
function tableOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nums = (a, len) => Array.isArray(a) && a.length === len && a.every(Number.isFinite);
  if (!nums(raw.b, 5) || !nums(raw.p, 2) || !nums(raw.c, 2)) return null;
  if (!Array.isArray(raw.q) || raw.q.length !== 2) return null;
  if (!raw.q.every((id) => id === null || Number.isInteger(id))) return null;
  if (!Number.isInteger(raw.sv) || !Number.isInteger(raw.rng)) return null;
  if (!(raw.w === null || raw.w === 0 || raw.w === 1) || !(raw.d === 1 || raw.d === -1)) return null;
  const push = {};
  for (const [id, dir] of Object.entries(raw.push || {})) {
    if (Number.isInteger(Number(id)) && inputOf(dir) !== null) push[id] = dir;
  }
  return {
    b: raw.b.slice(), p: raw.p.slice(), c: raw.c.slice(), q: raw.q.slice(),
    sv: raw.sv, w: raw.w, d: raw.d, rng: raw.rng, push,
  };
}

// ── the screen ─────────────────────────────────────────────────────────────
let coarse = matchMedia('(pointer: coarse)').matches;
const pushing = () => (coarse ? 'drag up or down' : 'arrows or W / S');

document.body.style.cssText =
  'margin:0;height:100vh;overflow:hidden;background:#0b0d10;touch-action:none;' +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;' +
  'font:16px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

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
const hue = (id) => (id === null ? null : `hsl(${(((id * 67) % 360) + 360) % 360} 70% 62%)`);
const mySeat = () => (!world ? -1 : world.q[0] === myId() ? 0 : world.q[1] === myId() ? 1 : -1);

function nickOf(id) {
  if (id === null) return 'bot';
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((x) => x.id === id);
  return p ? p.nick : 'player';
}

function fitted(text, size) {
  ctx.font = `${Math.round(size)}px ui-monospace,Menlo,monospace`;
  const wide = ctx.measureText(text).width;
  if (wide <= FW * sc) return;
  ctx.font = `${Math.max(8, Math.round((size * FW * sc) / wide))}px ui-monospace,Menlo,monospace`;
}

// The table as drawn: the last two the kernel gave, walked between.
function view(now) {
  const bl = agreedAt(now);
  if (!bl) return null;
  const { from, to, k } = bl;
  const mix = (a, b) => a + (b - a) * k;
  // A ball put back to the middle is not slid there: the two tables are of
  // different rallies, and the second is simply the truth.
  const jump = Math.abs(to.b[0] - from.b[0]) + Math.abs(to.b[1] - from.b[1]) > 0.3;
  return {
    t: to,
    b: jump ? to.b : [mix(from.b[0], to.b[0]), mix(from.b[1], to.b[1])],
    p: [mix(from.p[0], to.p[0]), mix(from.p[1], to.p[1])],
  };
}

function draw(now) {
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#1e242c';
  ctx.lineWidth = 2;
  ctx.strokeRect(X(0), Y(0), FW * sc, FH * sc);
  ctx.setLineDash([sc * 0.03, sc * 0.03]);
  ctx.beginPath();
  ctx.moveTo(X(FW / 2), Y(0));
  ctx.lineTo(X(FW / 2), Y(FH));
  ctx.stroke();
  ctx.setLineDash([]);

  const v = view(now);
  ctx.textAlign = 'center';
  if (!v) {
    fitted('catching up with the table', sc * 0.05);
    ctx.fillStyle = '#79838f';
    ctx.textBaseline = 'middle';
    ctx.fillText('catching up with the table', X(FW / 2), Y(FH / 2));
    return;
  }

  const t = v.t;
  ctx.textBaseline = 'top';
  for (let s = 0; s < 2; s++) {
    const x = X(s === 0 ? FW * 0.32 : FW * 0.68);
    ctx.fillStyle = hue(t.q[s]) || '#4b5563';
    ctx.font = `600 ${Math.round(sc * 0.16)}px ui-monospace,Menlo,monospace`;
    ctx.fillText(String(t.c[s]), x, Y(0.05));
    ctx.font = `${Math.round(sc * 0.045)}px ui-monospace,Menlo,monospace`;
    ctx.fillText(nickOf(t.q[s]) + (t.q[s] === myId() ? ' (you)' : ''), x, Y(0.05) + sc * 0.17);
  }

  for (let s = 0; s < 2; s++) {
    const cx = s === 0 ? PX : FW - PX;
    ctx.fillStyle = hue(t.q[s]) || '#59626e';
    const rx = X(cx - PW / 2), ry = Y(v.p[s] - PH / 2);
    const rw = PW * sc, rh = PH * sc, r = rw / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(rx, ry, rw, rh, r); else ctx.rect(rx, ry, rw, rh);
    ctx.fill();
  }

  if (t.w === null) {
    ctx.fillStyle = t.sv > 0 ? 'rgba(233,238,244,0.35)' : '#e9eef4';
    ctx.beginPath();
    ctx.arc(X(v.b[0]), Y(v.b[1]), BR * sc, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.font = `${Math.round(sc * 0.035)}px ui-monospace,Menlo,monospace`;
  ctx.fillStyle = '#59626e';
  ctx.fillText(wireNote(), X(FW), Y(FH) + sc * 0.02);

  let note = '';
  if (t.w !== null) note = nickOf(t.q[t.w]).toUpperCase() + ' WINS';
  else if (mySeat() < 0) note = 'watching — you play when a seat opens';
  else if (t.q[1 - mySeat()] === null) note = pushing() + ' · playing the bot until someone takes the other paddle';
  else note = pushing();
  ctx.textAlign = 'center';
  fitted(note, sc * 0.05);
  ctx.fillStyle = t.w !== null ? '#e9eef4' : '#79838f';
  ctx.textBaseline = 'bottom';
  ctx.fillText(note, X(FW / 2), Y(FH) - sc * 0.04);

  const how = 'controls: ' + (coarse ? 'drag up / down' : '↑ / ↓ or W / S') + ' · lockstep over echo';
  fitted(how, sc * 0.032);
  ctx.fillStyle = '#59626e';
  ctx.textBaseline = 'bottom';
  ctx.fillText(how, X(FW / 2), Y(FH) + sc * 0.09);
}

// ── the hands ──────────────────────────────────────────────────────────────
// A key is a direction, not a destination, so a paddle a trip late cannot
// overshoot: the same reason the legacy pong.js (disks/legacy/pong.js) keeps
// the mouse away. Up, down or nothing, said when it changes.
function shove(dir) {
  setHand(dir);
}

// Keys are read by where they sit, not by what they type: `e.code` is the same
// on every layout, while `e.key` is a Cyrillic letter on a Russian one, a
// capital with Caps Lock or Shift down, and a key let go under Shift would
// never match the one pressed and stay held for good.
const UP = ['ArrowUp', 'KeyW'], DOWN = ['ArrowDown', 'KeyS'];
const keys = new Set();
function fromKeys() {
  let d = 0;
  if (UP.some((c) => keys.has(c))) d -= 1;
  if (DOWN.some((c) => keys.has(c))) d += 1;
  return d;
}
addEventListener('keydown', (e) => {
  if (!UP.includes(e.code) && !DOWN.includes(e.code)) return;
  e.preventDefault();
  keys.add(e.code);
  shove(hands());
});
addEventListener('keyup', (e) => { keys.delete(e.code); shove(hands()); });
addEventListener('blur', () => { keys.clear(); letGo(); });

// A drag rather than a press, because iOS keeps a long press inside a frame for
// itself; the stick is a direction from where the thumb landed.
const DEAD = 10;
const REACHOUT = 46;
let stick = null;

function fromThumb() {
  if (!stick || Math.abs(stick.dy) < DEAD) return 0;
  return stick.dy < 0 ? -1 : 1;
}
function hands() { return fromThumb() || fromKeys(); }

function letGo() {
  stick = null;
  paintStick();
  shove(hands());
}

cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || stick) return;
  coarse = true;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  stick = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, dy: 0 };
  paintStick();
});
cv.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  stick.dy = e.clientY - stick.oy;
  paintStick();
  shove(hands());
});
const lift = (e) => { if (stick && e.pointerId === stick.pointerId) letGo(); };
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

const pad = document.createElement('div');
pad.style.cssText = 'position:fixed;inset:0;display:none;pointer-events:none';
const track = document.createElement('div');
track.style.cssText =
  `position:fixed;width:34px;height:${REACHOUT * 2}px;margin:${-REACHOUT}px 0 0 -17px;` +
  'border-radius:17px;border:1px solid #1e242c;background:rgba(89,98,110,0.10)';
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;' +
  'background:#e9eef4;opacity:.65';
pad.append(track, knob);
document.body.appendChild(pad);

function paintStick() {
  if (!stick) { pad.style.display = 'none'; return; }
  const k = Math.abs(stick.dy) > REACHOUT ? REACHOUT / Math.abs(stick.dy) : 1;
  pad.style.display = 'block';
  track.style.left = stick.ox + 'px';
  track.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + 'px';
  knob.style.top = stick.oy + stick.dy * k + 'px';
}

// ── the start ──────────────────────────────────────────────────────────────
function frame(now) {
  draw(now);
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. A hand at rest is how a player is heard
// and takes a free paddle.
function start() {
  setHand(0);
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
