/**
 * @disk     tag
 * @author   diskroom
 * @version  9
 * @players  2-8
 * @about    Tag on an open field. One player is it and a touch passes it on. One machine runs the chase and everybody else sends it which way they are running.
 * @tags     game, arcade, realtime, example
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/tag.png
 */
// tag.js — one machine runs the field, everybody else sends which way.
//
// The host owns the chase: where every dot is, who is it, and what counts as a
// touch. A player's copy sends one thing — the direction they are running, and
// only when it changes — and draws what comes back. No copy but the host works
// anything out, so there is nothing anywhere to be wrong about, nothing to
// predict, and nothing to correct.
//
// The price is plain: your own dot turns after a round trip to the host. On a
// wire of a tenth of a second that is a tenth of a second of turning circle,
// for everyone including the person who is it. What is bought is that the whole
// room is looking at the same field, and that a catch happens once, in one
// place, and cannot be seen differently by the two people it happened to.
//
// The one thing done locally is drawing between the host's twenty pictures a
// second, so that dots move at the rate of the screen rather than of the wire.

const FW = 1.6, FH = 1.0;   // the field, in units every copy agrees on
const R = 0.030;            // a player's radius
const SPEED = 0.62;         // how fast a dot runs, field units a second
const REACH = 0.075;        // close enough to count as a touch
const IMMUNE_MS = 1200;     // after a catch, so it cannot bounce straight back
const TICK = 50;            // ms between the host's pictures — 20 a second
const LAG = 60;             // ms behind: the cushion the drawing runs on
const STALE = 3000;         // ms before an old latency measurement is ignored
const PROBE_EVERY = 1000;   // ms between host round-trip measurements
const HOST_LAG_FALLBACK = 25; // ms until the first player answers a probe

const C = { bg: '#1c1c1c', line: '#2f2f2f', muted: '#8f8f8f', mine: '#a9c0a9', it: '#d3a9a9' };
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

// ── the field, as the host holds it ────────────────────────────────────────
const runners = new Map();   // id -> { x, y }
const push = new Map();      // id -> { dx, dy } — which way that hand is running
const seen = new Map();      // id -> when we last heard from them
let it = null;
let immuneUntil = 0;
let caughtAt = 0;
let myPush = { dx: 0, dy: 0 };
let hostPush = { dx: 0, dy: 0 };
const heldInputs = [];
const roundTrips = new Map();
let probedAt = 0;

// The round trip to the machine running the field, measured by this copy: a
// ping it sends and the host echoes back. Not the platform's own badge — that
// one is the way to the server, and what decides a chase is the way to whoever
// is running it.
let hostId = null;
let pingMs = null;
let pingAt = 0;

// The last two pictures from the host. The drawing lives between them.
let prev = null, next = null, prevAt = 0, nextAt = 0;
let hostPrev = null, hostNext = null, hostPrevAt = 0, hostNextAt = 0;

const myId = () => (room.me ? room.me.id : -1);
const boss = () => room.isHost || !room.me;
let authority = room.isHost ? myId() : null;
const clampX = (x) => Math.max(R, Math.min(FW - R, x));
const clampY = (y) => Math.max(R, Math.min(FH - R, y));
const r3 = (v) => Math.round(v * 1000) / 1000;

function hostLag(now) {
  if (!room.me || !room.players.some((player) => player.id !== myId())) return 0;
  const legs = [];
  for (const [id, sample] of roundTrips) {
    if (id !== myId() && now - sample.at < STALE) legs.push(sample.rtt / 2);
  }
  // The slowest active link is the only choice that cannot leave the host
  // acting before one of the people they are playing against.
  return Math.max(0, Math.min(250, legs.length ? Math.max(...legs) : HOST_LAG_FALLBACK));
}

function releaseHeldInputs(now) {
  while (heldInputs.length && heldInputs[0].at <= now) hostPush = heldInputs.shift().dir;
}

function rememberHostField(now, field) {
  hostPrev = hostNext;
  hostPrevAt = hostNextAt;
  hostNext = field;
  hostNextAt = now + hostLag(now);
  if (!hostPrev) {
    hostPrev = field;
    hostPrevAt = hostNextAt - TICK;
  }
}

function nickOf(id) {
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((x) => x.id === id);
  return p ? p.nick : 'p' + id;
}

function runner(id) {
  let r = runners.get(id);
  if (!r) {
    // Somewhere other than the middle: everybody starting on one spot means the
    // first tick finds two dots touching and the game opens with a tag nobody
    // made.
    r = { x: 0.2 + Math.random() * (FW - 0.4), y: 0.2 + Math.random() * (FH - 0.4) };
    runners.set(id, r);
  }
  return r;
}

// ── the chase. Only the host ever runs any of this ─────────────────────────
function run(dt, now) {
  const here = new Set(room.players.map((p) => p.id));
  here.add(myId());
  for (const id of [...runners.keys()]) {
    if (!here.has(id)) {
      runners.delete(id);
      push.delete(id);
    }
  }
  // Everybody in the room stands on the field, whether or not they have moved
  // yet: a player who has not touched the mouse is still a player.
  for (const id of here) runner(id);

  for (const [id, r] of runners) {
    const d = id === myId() ? hostPush : push.get(id) || { dx: 0, dy: 0 };
    const far = Math.hypot(d.dx, d.dy);
    if (far < 0.01) continue;
    r.x = clampX(r.x + (d.dx / far) * SPEED * dt);
    r.y = clampY(r.y + (d.dy / far) * SPEED * dt);
  }

  if (it === null || !runners.has(it)) {
    it = myId();
    immuneUntil = now + IMMUNE_MS;
    caughtAt = now;
    return;
  }
  if (now < immuneUntil) return;
  const chaser = runners.get(it);
  for (const [id, r] of runners) {
    if (id === it) continue;
    if (Math.hypot(r.x - chaser.x, r.y - chaser.y) <= REACH) {
      it = id;
      immuneUntil = now + IMMUNE_MS;
      if (id === myId()) caughtAt = now;
      return;
    }
  }
}

// ── the wire ───────────────────────────────────────────────────────────────
function shove(dx, dy) {
  const far = Math.hypot(dx, dy);
  const d = far < 0.01 ? { dx: 0, dy: 0 } : { dx: dx / far, dy: dy / far };
  // Only a real change of direction is worth a message; a hand held steady
  // costs nothing at all.
  if (Math.hypot(d.dx - myPush.dx, d.dy - myPush.dy) < 0.08) return;
  myPush = d;
  if (boss()) {
    heldInputs.push({ at: performance.now() + hostLag(performance.now()), dir: { ...d } });
  }
  if (room.me) room.send({ t: 'in', x: r3(d.dx), y: r3(d.dy) });
}

function picture() {
  const list = [];
  for (const [id, r] of runners) list.push([id, r3(r.x), r3(r.y)]);
  // A handover needs the direction in the simulation, not a newer host key
  // press which is still intentionally waiting in the fairness queue.
  const input = [[myId(), r3(hostPush.dx), r3(hostPush.dy)]];
  for (const [id, d] of push) input.push([id, r3(d.dx), r3(d.dy)]);
  return {
    t: 'field',
    it,
    imm: Math.round(Math.max(0, immuneUntil - performance.now())),
    list,
    input,
  };
}

function fieldOf(msg) {
  if (!Array.isArray(msg.list) || msg.list.length > 8) return false;
  const restored = new Map();
  for (const row of msg.list) {
    if (!Array.isArray(row) || row.length !== 3) return false;
    const [id, x, y] = row;
    if (!Number.isInteger(id) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    restored.set(id, { x: clampX(x), y: clampY(y) });
  }
  runners.clear();
  for (const [id, r] of restored) runners.set(id, r);

  push.clear();
  if (Array.isArray(msg.input)) {
    for (const row of msg.input) {
      if (!Array.isArray(row) || row.length !== 3) continue;
      const [id, dx, dy] = row;
      if (id === myId() || !restored.has(id) || !Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      const far = Math.hypot(dx, dy);
      push.set(id, far < 0.01 ? { dx: 0, dy: 0 } : { dx: dx / far, dy: dy / far });
    }
  }
  it = restored.has(msg.it) ? msg.it : null;
  immuneUntil = performance.now() + Math.max(0, finite(msg.imm));
  return true;
}

// A number off the wire, or 0. `Number(x) || 0` lets Infinity through, and a
// single Infinity in a runner's step is a NaN in its position for good — after
// which every picture the host sends is refused by every copy that gets it.
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

room.on('message', (from, msg) => {
  if (!msg || typeof msg.t !== 'string') return;
  seen.set(from, performance.now());

  if (msg.t === 'in') {
    push.set(from, { dx: finite(msg.x), dy: finite(msg.y) });
  } else if (msg.t === 'probe') {
    room.send({ t: 'probeBack', at: msg.at }, { to: from });
  } else if (msg.t === 'probeBack' && boss()) {
    const rtt = performance.now() - Number(msg.at);
    if (Number.isFinite(rtt) && rtt >= 0) roundTrips.set(from, { rtt, at: performance.now() });
  } else if (msg.t === 'ping') {
    room.send({ t: 'pong', at: msg.at }, { to: from });
  } else if (msg.t === 'pong') {
    const rtt = performance.now() - Number(msg.at);
    if (!Number.isFinite(rtt) || rtt < 0) return;
    pingMs = pingMs === null ? rtt : pingMs * 0.7 + rtt * 0.3;
  } else if (msg.t === 'field' && !boss() && (authority === null || authority === from)) {
    if (!fieldOf(msg)) return;
    authority = from;
    hostId = from;
    prev = next;
    prevAt = nextAt;
    next = msg;
    nextAt = performance.now();
    if (!prev) { prev = msg; prevAt = nextAt - TICK; }
    if (msg.it !== it && msg.it === myId()) caughtAt = performance.now();
  } else if (msg.t === 'hello' && boss()) {
    room.send(picture(), { to: from });
  }
});

setInterval(() => {
  const now = performance.now();
  if (boss()) {
    const field = picture();
    rememberHostField(now, field);
    if (room.me) room.send(field);
    if (now - probedAt >= PROBE_EVERY) {
      probedAt = now;
      for (const player of room.players) {
        if (player.id !== myId()) room.send({ t: 'probe', at: Math.round(now) }, { to: player.id });
      }
    }
  }
  if (!boss() && hostId !== null && now - pingAt > 1000) {
    pingAt = now;
    room.send({ t: 'ping', at: Math.round(now) }, { to: hostId });
  }
}, TICK);

room.on('join', (p) => console.log(p.nick + ' walked in'));

room.on('leave', (p) => {
  runners.delete(p.id);
  push.delete(p.id);
  seen.delete(p.id);
  roundTrips.delete(p.id);
  console.log(p.nick + ' left');
});

room.on('hostchange', (h) => {
  heldInputs.length = 0;
  hostPush = { dx: 0, dy: 0 };
  if (boss() && (myPush.dx || myPush.dy)) {
    heldInputs.push({ at: performance.now() + hostLag(performance.now()), dir: { ...myPush } });
  }
  hostPrev = hostNext = null;
  authority = h;
  hostId = h;
  if (!boss()) room.send({ t: 'hello' });
  console.log('the field is now run by ' + nickOf(h));
});

// ── the screen ─────────────────────────────────────────────────────────────
// Which hand the screen writes its instructions for. A device that says its
// pointer is coarse is taken at its word to begin with, and the first finger
// that actually lands settles it. Nothing but the wording hangs on this: both
// hands reach `shove()` the same way, and the wire cannot tell them apart.
let coarse = matchMedia('(pointer: coarse)').matches;

// `-webkit-touch-callout` and the selection rules are not decoration: a
// finger held still on iOS Safari is a long press, and a long press there
// selects what is under it and puts a Copy / Look Up bar over the page —
// which takes the pointer away mid-gesture and ends the hold. A drag escapes
// it because the movement cancels the press, so a game played by dragging
// never meets this; one played by holding meets it every time.
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
  // Letterboxed rather than stretched: it is the same field for everyone, and
  // stretching it would make a catch depend on the shape of a window.
  sc = Math.min(w / FW, h / FH) * 0.94;
  ox = (w - FW * sc) / 2;
  oy = (h - FH * sc) / 2;
}
layout();
window.addEventListener('resize', layout);

const X = (x) => ox + x * sc;
const Y = (y) => oy + y * sc;

// Every screen, including the host's, draws the moment between two pictures.
// The host keeps its own history on the same delayed timeline as its players.
function view(now) {
  const before = boss() ? hostPrev : prev;
  const after = boss() ? hostNext : next;
  const beforeAt = boss() ? hostPrevAt : prevAt;
  const afterAt = boss() ? hostNextAt : nextAt;
  if (!before || !after) {
    const out = new Map();
    for (const [id, r] of runners) out.set(id, { x: r.x, y: r.y });
    return out;
  }
  const span = Math.max(1, afterAt - beforeAt);
  const k = Math.max(0, Math.min(1, (now - LAG - beforeAt) / span));
  const was = new Map(before.list.map((e) => [e[0], e]));
  const out = new Map();
  for (const [id, x, y] of after.list) {
    const old = was.get(id);
    out.set(id, old ? { x: old[1] + (x - old[1]) * k, y: old[2] + (y - old[2]) * k } : { x, y });
  }
  return out;
}

function dot(r, colour, label, ring) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(X(r.x), Y(r.y), R * sc, 0, Math.PI * 2);
  ctx.fill();
  if (ring) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1, sc * 0.006);
    ctx.beginPath();
    ctx.arc(X(r.x), Y(r.y), R * sc * 1.9, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = C.muted;
  ctx.font = `${Math.round(sc * 0.035)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText(label, X(r.x), Y(r.y) + R * sc + sc * 0.055);
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

  const shown = view(now);
  for (const [id, r] of shown) {
    if (id === myId()) continue;
    dot(r, id === it ? C.it : C.muted, nickOf(id), id === it);
  }
  const me = shown.get(myId());
  if (me) dot(me, it === myId() ? C.it : C.mine, 'you', it === myId());

  ctx.textAlign = 'left';
  ctx.font = `${Math.round(sc * 0.042)}px ${MONO}`;
  const amIt = it === myId();
  ctx.fillStyle = amIt ? C.it : C.muted;
  ctx.fillText(
    it === null ? 'waiting for the field' : amIt ? 'you are it — touch someone' : 'it: ' + nickOf(it),
    X(0), Y(0) - sc * 0.03,
  );
  ctx.textAlign = 'right';
  ctx.fillStyle = C.line;
  ctx.fillText(boss() ? 'you run the field' : pingMs === null ? 'ping —' : 'ping ' + Math.round(pingMs) + ' ms',
               X(FW), Y(0) - sc * 0.03);

  if (amIt && now - caughtAt < 600) {
    ctx.strokeStyle = C.it;
    ctx.lineWidth = Math.max(2, sc * 0.01) * (1 - (now - caughtAt) / 600);
    ctx.strokeRect(X(0), Y(0), FW * sc, FH * sc);
  }

  ctx.textAlign = 'center';
  ctx.font = `${Math.round(sc * 0.032)}px ${MONO}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(coarse ? 'controls: drag anywhere to run' : 'controls: ← ↑ ↓ →',
               X(FW / 2), Y(FH) + sc * 0.09);
}

// ── the hands ──────────────────────────────────────────────────────────────
// Arrow keys name a direction, or nothing at all. Keeping one control scheme
// makes the same move available without a pointer or a keyboard layout choice.
const keys = new Set();
function fromKeys() {
  let dx = 0, dy = 0;
  if (keys.has('ArrowLeft')) dx -= 1;
  if (keys.has('ArrowRight')) dx += 1;
  if (keys.has('ArrowUp')) dy -= 1;
  if (keys.has('ArrowDown')) dy += 1;
  return { dx, dy };
}
// A thumb on the glass has the last word over the keys while it is down. The
// two are never both in use on a phone, but on a machine that has both a key
// released would otherwise stop a dot the thumb is still pushing, and nothing
// would start it again until the thumb moved.
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
  keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  const d = fromKeys();
  if (!stick) shove(d.dx, d.dy);
});
addEventListener('keyup', (e) => {
  keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  const d = fromKeys();
  if (!stick) shove(d.dx, d.dy);
});
addEventListener('blur', () => { keys.clear(); drop(); });

// ── the thumbs ─────────────────────────────────────────────────────────────
// A phone has no arrow keys, and a stick painted into a corner puts it where
// the thumb is not: a hand holding a phone lands where it lands. So the stick
// is wherever the finger goes down — that first touch is the centre, and the
// direction is the offset from it, which is the one thing this disk ever says
// about a hand.
//
// It is a direction and not a place on the field for the same reason the keys
// are: a dot told to run toward where a finger rests arrives there a round
// trip late, has already gone past, and is sent back — a dot pacing to and fro
// on its own. An offset from the thumb cannot overshoot anything.
//
// Only touches are read. A laptop with a touchscreen answers the coarse
// pointer query as loudly as a phone does, and on one of those every click on
// the field would otherwise plant a stick under the mouse.
const DEAD = 8;    // px of slack, so a thumb resting still is standing still
const REACHOUT = 46; // px from the centre at which the stick is all the way over
let stick = null;  // { pointerId, ox, oy } — where the thumb went down

function drop() {
  stick = null;
  paintStick(0, 0);
  shove(0, 0);
}

// On the canvas and captured, which is not a detail: a disk is played inside a
// frame on a page that scrolls, and a drag that merely bubbles to `window` is
// still a drag the page above can decide is its own scroll and take away
// halfway through. `setPointerCapture` binds the rest of the gesture to this
// element the moment it starts, so every move and the release come here no
// matter what the page around the frame makes of them. It is what chapaev.js
// does, and it is why chapaev is playable on a phone.
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || stick) return;
  coarse = true;   // a finger has landed, whatever the device claimed
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
// `pointercancel` as well as `pointerup`: a touch the browser takes away — a
// system gesture starting over the frame — never reports a release, and the
// dot would be left running with nobody's thumb on it.
const lift = (e) => { if (stick && e.pointerId === stick.pointerId) drop(); };
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
// Heard on the window as well as on the canvas: a capture broken before it
// took hold sends the release somewhere else, and a stick left standing under
// no thumb refuses the next one.
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

// The stick, drawn in the page rather than on the canvas: the field is the
// same picture for everybody in the room, and one screen's controls are not
// part of it.
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
  // The knob stops at the rim: past it the thumb is only saying the same
  // direction louder, and this disk has no louder to say it in.
  const k = far > REACHOUT ? REACHOUT / far : 1;
  ring.style.display = knob.style.display = 'block';
  ring.style.left = stick.ox + 'px';
  ring.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + dx * k + 'px';
  knob.style.top = stick.oy + dy * k + 'px';
}

// ── the loop ───────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (boss()) {
    releaseHeldInputs(now);
    run(dt, now);
  }

  draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

room.send({ t: 'hello' });

console.log('tag.js up · host:', boss());
