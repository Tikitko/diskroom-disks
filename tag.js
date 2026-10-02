/**
 * @disk     tag
 * @author   diskroom
 * @version  12
 * @players  2-8
 * @about    Tag on an open field, run with the arrows, WASD or a thumb. One player is it and a touch passes it on.
 * @tags     game, arcade, realtime, example, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/tag.png
 */
// tag.js — tag where the room's order is the referee.
//
// The legacy tag.js (disks/legacy/tag.js) runs the chase on the host: a hand
// goes to the server, on to the host, and the answer comes back the same way.
// Here every copy holds the whole field and moves it only on what comes back
// round the room — hands and ticks alike are sent with `{ echo: true }` — so
// every copy applies the same moves in the same order and holds the same field.
// A catch still happens once, in one place: it is the same arithmetic on the
// same numbers everywhere.
//
// Your own dot does not wait even for that one trip. The field drawn is the
// agreed one played forward by the trip it takes, with your own hand in it the
// moment you move — and replayed from the agreed one every time a tick lands,
// so a guess that turned out wrong lasts one tick.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and the game's rules have to come out the same on every
// machine to the last bit: no clocks, no `Math.random`, no function a browser
// may round its own way. The first section has what they use instead.

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

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                // steps of the field a second
const STEPS_PER_TICK = 1;     // steps one tick of the clock carries
const PREDICT = true;         // draw the field a trip ahead, with your own hand in it

const FW = 1.6, FH = 1.0;     // the field, in units every copy agrees on
const R = 0.030;              // a player's radius
const SPEED = 0.62;           // how fast a dot runs, field units a second
const REACH = 0.075;          // close enough to count as a touch
const IMMUNE_STEPS = 36;      // after a catch, so it cannot bounce straight back
const STEP = 1 / HZ;

const C = { bg: '#1c1c1c', line: '#2f2f2f', muted: '#8f8f8f', mine: '#a9c0a9', it: '#d3a9a9' };
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

const clampX = (x) => Math.max(R, Math.min(FW - R, x));
const clampY = (y) => Math.max(R, Math.min(FH - R, y));

// The field. Plain data only: it is fingerprinted and handed over as JSON.
function freshTable(seed) {
  return {
    rng: seed | 0,
    r: {},                    // player id -> [x, y]
    push: {},                 // player id -> [dx, dy], the hand as last heard
    it: null,                 // who is it
    imm: 0,                   // steps until a touch counts again
    caught: -999,             // the step the last catch happened on
  };
}

// A hand, at its place in the room's order. Being heard is how you arrive:
// somewhere other than the middle, so the game does not open with a tag nobody
// made.
function hand(w, id, input) {
  if (!w.r[id]) w.r[id] = [0.2 + draw01(w) * (FW - 0.4), 0.2 + draw01(w) * (FH - 0.4)];
  w.push[id] = input;
}

function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [dx, dy] = raw;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return null;
  return [dx, dy];
}

function leave(w, id) {
  delete w.r[id];
  delete w.push[id];
  if (w.it === id) w.it = null;
}

const playersIn = (w) => Object.keys(w.r).map(Number);

// One step of the chase: a function of the field alone.
function step(w) {
  for (const key of Object.keys(w.r)) {
    const d = w.push[key];
    if (!d) continue;
    const far = dhypot(d[0], d[1]);
    if (far < 0.01) continue;
    const r = w.r[key];
    r[0] = clampX(r[0] + (d[0] / far) * SPEED * STEP);
    r[1] = clampY(r[1] + (d[1] / far) * SPEED * STEP);
  }

  const ids = playersIn(w);
  if (w.it === null || !w.r[w.it]) {
    if (!ids.length) return;
    w.it = ids[Math.floor(draw01(w) * ids.length)];
    w.imm = IMMUNE_STEPS;
    w.caught = w.n;
    return;
  }
  if (w.imm > 0) { w.imm -= 1; return; }
  const chaser = w.r[w.it];
  for (const id of ids) {
    if (id === w.it) continue;
    const r = w.r[id];
    const dx = r[0] - chaser[0], dy = r[1] - chaser[1];
    if (dx * dx + dy * dy <= REACH * REACH) {
      w.it = id;
      w.imm = IMMUNE_STEPS;
      w.caught = w.n;
      return;
    }
  }
}

// A field handed over by somebody else is their claim, and is read as one.
function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.rng)) return null;
  const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
  const r = {}, push = {};
  for (const [id, v] of Object.entries(raw.r || {})) {
    if (!Number.isInteger(Number(id)) || !pair(v)) return null;
    r[id] = [clampX(v[0]), clampY(v[1])];
  }
  for (const [id, v] of Object.entries(raw.push || {})) {
    const input = inputOf(v);
    if (Number.isInteger(Number(id)) && input) push[id] = input;
  }
  if (!(raw.it === null || Number.isInteger(raw.it))) return null;
  if (!Number.isInteger(raw.imm) || !Number.isInteger(raw.caught)) return null;
  return { rng: raw.rng, r, push, it: raw.it, imm: raw.imm, caught: raw.caught };
}

// ═══════════════════ the screen ═══════════════════
let coarse = matchMedia('(pointer: coarse)').matches;

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${C.bg};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;';

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
  sc = Math.min(w / FW, h / FH) * 0.94;
  ox = (w - FW * sc) / 2;
  oy = (h - FH * sc) / 2;
}
layout();
window.addEventListener('resize', layout);

const X = (x) => ox + x * sc;
const Y = (y) => oy + y * sc;

function nickOf(id) {
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((x) => x.id === id);
  return p ? p.nick : 'p' + id;
}

function dot(r, colour, label, ring) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(X(r[0]), Y(r[1]), R * sc, 0, Math.PI * 2);
  ctx.fill();
  if (ring) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1, sc * 0.006);
    ctx.beginPath();
    ctx.arc(X(r[0]), Y(r[1]), R * sc * 1.9, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = C.muted;
  ctx.font = `${Math.round(sc * 0.035)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText(label, X(r[0]), Y(r[1]) + R * sc + sc * 0.055);
}

function draw(now) {
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

  const b = agreedAt(now);
  const m = mineAt(now);
  ctx.font = `${Math.round(sc * 0.042)}px ${MONO}`;
  if (!b) {
    ctx.textAlign = 'left';
    ctx.fillStyle = C.muted;
    ctx.fillText('catching up with the field', X(0), Y(0) - sc * 0.03);
    return;
  }
  const { to } = b;
  const at = ({ from, to: t, k }, id) => {
    const a = t.r[id], was = from.r[id];
    return was ? [was[0] + (a[0] - was[0]) * k, was[1] + (a[1] - was[1]) * k] : a;
  };
  for (const id of playersIn(to)) {
    if (id === myId()) continue;
    dot(at(b, id), id === to.it ? C.it : C.muted, nickOf(id), id === to.it);
  }
  if (m.to.r[myId()]) dot(at(m, myId()), to.it === myId() ? C.it : C.mine, 'you', to.it === myId());

  ctx.textAlign = 'left';
  ctx.font = `${Math.round(sc * 0.042)}px ${MONO}`;
  const amIt = to.it === myId();
  ctx.fillStyle = amIt ? C.it : C.muted;
  ctx.fillText(
    to.it === null ? 'waiting for the field' : amIt ? 'you are it — touch someone' : 'it: ' + nickOf(to.it),
    X(0), Y(0) - sc * 0.03,
  );
  ctx.textAlign = 'right';
  ctx.fillStyle = C.line;
  ctx.fillText(wireNote(), X(FW), Y(0) - sc * 0.03);

  const since = to.n - to.caught;
  if (amIt && since < 18) {
    ctx.strokeStyle = C.it;
    ctx.lineWidth = Math.max(2, sc * 0.01) * (1 - since / 18);
    ctx.strokeRect(X(0), Y(0), FW * sc, FH * sc);
  }

  ctx.textAlign = 'center';
  ctx.font = `${Math.round(sc * 0.032)}px ${MONO}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(coarse ? 'controls: drag anywhere to run' : 'controls: ← ↑ ↓ → or WASD',
               X(FW / 2), Y(FH) + sc * 0.09);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says. Setting off and stopping go out the moment they happen;
// a change of direction while running goes out no oftener than TURN_EVERY,
// because a thumb drawn round in a circle changes it on every move the screen
// reports, and the clock's ticks and this hand share one seat's ceiling on
// messages — past it they are dropped without a word, ticks included. The frame
// loop says the last direction once the wait is over, so none is lost.
const TURN_EVERY = 66;
let wanted = [0, 0];
let lastSaid = [0, 0];
let saidAt = -1e9;
function shove(dx, dy) {
  const far = Math.hypot(dx, dy);   // the hand's own arithmetic: it is an input, not a rule
  wanted = far < 0.01 ? [0, 0] : [Math.round((dx / far) * 1000) / 1000, Math.round((dy / far) * 1000) / 1000];
  sayHand(performance.now());
}
function sayHand(now) {
  const d = wanted;
  // Only a real change of direction is worth a message.
  if (Math.hypot(d[0] - lastSaid[0], d[1] - lastSaid[1]) < 0.08) return;
  const still = (v) => v[0] === 0 && v[1] === 0;
  if (!still(d) && !still(lastSaid) && now - saidAt < TURN_EVERY) return;
  lastSaid = d;
  saidAt = now;
  setHand(d);
}

// Keys are read by where they sit, not by what they type: `e.code` is the same
// on every layout, while `e.key` is a Cyrillic letter on a Russian one, a
// capital with Caps Lock or Shift down, and a key let go under Shift would
// never match the one pressed and stay held for good.
const RUN_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
const keys = new Set();
function fromKeys() {
  let dx = 0, dy = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1;
  return [dx, dy];
}
addEventListener('keydown', (e) => {
  if (!RUN_KEYS.includes(e.code)) return;
  e.preventDefault();
  keys.add(e.code);
  if (!stick) shove(...fromKeys());
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (!stick) shove(...fromKeys());
});
addEventListener('blur', () => { keys.clear(); dropStick(); });

// A drag rather than a press, because iOS keeps a long press inside a frame
// for itself; the stick is a direction from where the thumb landed.
const DEAD = 8;
const REACHOUT = 46;
let stick = null;

function dropStick() {
  stick = null;
  paintStick(0, 0);
  shove(0, 0);
}
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || stick) return;
  coarse = true;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  stick = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY };
  paintStick(0, 0);
});
cv.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
  paintStick(dx, dy);
  const still = Math.hypot(dx, dy) < DEAD;
  shove(still ? 0 : dx, still ? 0 : dy);
});
const lift = (e) => { if (stick && e.pointerId === stick.pointerId) dropStick(); };
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

const ring = document.createElement('div');
ring.style.cssText =
  `position:fixed;display:none;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
  `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;pointer-events:none;` +
  `border:1px solid ${C.line};background:rgba(143,143,143,0.06)`;
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  `border-radius:50%;pointer-events:none;background:${C.mine};opacity:.7`;
document.body.append(ring, knob);

function paintStick(dx, dy) {
  if (!stick) { ring.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(dx, dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
  ring.style.display = knob.style.display = 'block';
  ring.style.left = stick.ox + 'px';
  ring.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + dx * k + 'px';
  knob.style.top = stick.oy + dy * k + 'px';
}

function frame(now) {
  sayHand(now);
  draw(now);
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a player arrives on the field.
function start() {
  setHand([0, 0]);
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
