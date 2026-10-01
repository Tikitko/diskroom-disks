/**
 * @disk     pong
 * @author   diskroom
 * @version  10
 * @players  1-8
 * @about    Pong on a shared table, played on the arrow keys or by dragging a thumb up and down. Two seats, everyone else watches, an empty seat is played by a bot, and one machine runs the whole table while the others send it which way they are pushing.
 * @tags     game, arcade, realtime, example
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/pong.png
 */
// pong.js — one machine plays the table, everybody else sends which way.
//
// The host owns everything: both paddles, the ball, the score, the bot. A
// player's copy sends one thing — the direction their hand is pushing — and
// draws what comes back. A quiet heartbeat keeps a held paddle seated. Nothing is
// predicted, nothing is guessed, nothing is corrected, because no copy but the
// host ever computes anything to be wrong about.
//
// The price is stated rather than hidden: your own paddle answers after a round
// trip to the host, and on a wire of a tenth of a second that is what it will
// feel like. What is bought is that every screen in the room shows the same
// table, and that there is exactly one place where the game is.
//
// The only thing done locally is drawing between the host's twenty pictures a
// second: two of them are kept and the moment between is interpolated, so the
// table moves at the rate of the screen rather than the rate of the wire.

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
const TICK = 50;                   // ms between the host's pictures — 20 a second
const LAG = 60;                    // ms behind: the cushion the drawing runs on
const STALE = 3000;                // ms of silence before a seat goes to the bot
const HEARTBEAT = 1000;             // a held key still proves that its disk is alive
const PROBE_EVERY = 1000;           // ms between the host's round-trip measurements
const HOST_LAG_FALLBACK = 25;       // ms until the first client answers a probe

// ── the table, as the host holds it ────────────────────────────────────────
const world = {
  b: [FW / 2, FH / 2, 0, 0],       // ball: x, y, vx, vy
  p: [FH / 2, FH / 2],             // paddle y, per seat
  c: [0, 0],                       // score, per seat
  q: [null, null],                 // seat -> player id, null means the bot has it
  sv: 1.2,                         // seconds until the next serve; 0 means the ball is live
  w: null,                         // winning seat, or null while the game is on
};

let srvDir = Math.random() < 0.5 ? -1 : 1;
const push = new Map();            // id -> -1, 0 or 1: which way that hand is pushing
const seen = new Map();            // id -> when we last heard from them
let myPush = 0;
let hostPush = 0;
const heldInputs = [];
const roundTrips = new Map();
let probedAt = 0;

// The round trip to the machine running the table, measured by this copy: a
// ping it sends and the host echoes. It is not the platform's latency badge —
// that one measures the way to the server, and what matters to a player is the
// way to whoever is playing the table.
let hostId = null;
let pingMs = null;
let pingAt = 0;

// The last two pictures from the host, and nothing else: the drawing runs
// between them.
let prev = null, next = null, prevAt = 0, nextAt = 0;
let hostPrev = null, hostNext = null, hostPrevAt = 0, hostNextAt = 0;

const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const boss = () => room.isHost || solo();
let authority = room.isHost ? myId() : null;
const clampY = (y) => Math.max(PH / 2, Math.min(FH - PH / 2, y));
const mySeat = () => (world.q[0] === myId() ? 0 : world.q[1] === myId() ? 1 : -1);
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

function rememberHostTable(now, table) {
  hostPrev = hostNext;
  hostPrevAt = hostNextAt;
  hostNext = table;
  hostNextAt = now + hostLag(now);
  if (!hostPrev) {
    hostPrev = table;
    hostPrevAt = hostNextAt - TICK;
  }
}

function nickOf(id) {
  if (id === null) return 'bot';
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((x) => x.id === id);
  return p ? p.nick : 'player';
}

// ── the rules. Only the host ever runs any of this ─────────────────────────
function paddleHit(s) {
  const b = world.b;
  const px = s === 0 ? PX : FW - PX;
  const face = s === 0 ? px + PW / 2 + BR : px - PW / 2 - BR;
  if (s === 0 ? b[2] >= 0 : b[2] <= 0) return;            // already going away
  if (s === 0 ? b[0] > face : b[0] < face) return;        // not at the paddle yet
  if (Math.abs(b[0] - px) > 0.05) return;                 // long past it: that was a point
  const rel = (b[1] - world.p[s]) / (PH / 2 + BR);
  if (Math.abs(rel) > 1) return;                          // missed
  const speed = Math.min(Math.hypot(b[2], b[3]) * VGAIN, VMAX);
  const ang = rel * MAXANG;                               // the edges of the paddle steer
  b[2] = Math.cos(ang) * speed * (s === 0 ? 1 : -1);
  b[3] = Math.sin(ang) * speed;
}

function walls(b) {
  if (b[1] < BR) { b[1] = BR; b[3] = Math.abs(b[3]); }
  if (b[1] > FH - BR) { b[1] = FH - BR; b[3] = -Math.abs(b[3]); }
}

function serve() {
  const ang = (Math.random() * 2 - 1) * 0.5;
  world.b = [FW / 2, FH / 2, Math.cos(ang) * V0 * srvDir, Math.sin(ang) * V0];
}

function point(s) {
  world.c[s]++;
  world.b = [FW / 2, FH / 2, 0, 0];
  srvDir = s === 0 ? 1 : -1;              // the ball goes back to whoever was scored on
  world.sv = world.c[s] >= WIN ? 4 : 1.2;
  if (world.c[s] >= WIN) world.w = s;
}

function newGame() {
  world.c = [0, 0];
  world.w = null;
  world.b = [FW / 2, FH / 2, 0, 0];
  world.sv = 1.5;
}

function seats(now) {
  const here = new Set(room.players.map((p) => p.id));
  for (let s = 0; s < 2; s++) {
    const id = world.q[s];
    if (id === null || id === myId()) continue;
    if (!here.has(id) || now - (seen.get(id) || 0) > STALE) world.q[s] = null;
  }
  const taken = new Set(world.q.filter((v) => v !== null));
  const waiting = [myId(), ...[...seen.keys()].filter((id) => here.has(id))]
    .filter((id) => !taken.has(id));
  for (let s = 0; s < 2; s++) {
    if (world.q[s] === null && waiting.length) world.q[s] = waiting.shift();
  }
}

function run(dt, now) {
  seats(now);
  for (let s = 0; s < 2; s++) {
    const id = world.q[s];
    if (id === null) {
      // The bot: it steers itself toward the ball when the ball is coming.
      const coming = s === 0 ? world.b[2] < 0 : world.b[2] > 0;
      const target = coming ? world.b[1] : FH / 2;
      const d = target - world.p[s];
      world.p[s] = clampY(world.p[s] + Math.sign(d) * Math.min(BOT_SPEED * dt, Math.abs(d)));
      continue;
    }
    const dir = id === myId() ? hostPush : push.get(id) || 0;
    if (dir) world.p[s] = clampY(world.p[s] + dir * PSPEED * dt);
  }

  if (world.w !== null) {
    if ((world.sv -= dt) <= 0) newGame();
    return;
  }
  if (world.sv > 0) {
    if ((world.sv -= dt) <= 0) serve();
    return;
  }
  const b = world.b;
  let left = dt;
  while (left > 1e-6) {
    const h = Math.min(left, 1 / 240);   // small steps: a fast ball must not step over a paddle
    left -= h;
    b[0] += b[2] * h;
    b[1] += b[3] * h;
    walls(b);
    paddleHit(0);
    paddleHit(1);
    if (b[0] < -0.1) return point(1);
    if (b[0] > FW + 0.1) return point(0);
  }
}

// ── the wire ───────────────────────────────────────────────────────────────
function shove(dir) {
  if (dir === myPush) return;          // only a change is worth a message
  myPush = dir;
  if (boss()) heldInputs.push({ at: performance.now() + hostLag(performance.now()), dir });
  if (!solo()) room.send({ t: 'in', d: dir });
}

function tableOf(msg) {
  if (!Array.isArray(msg.b) || msg.b.length !== 4 || !Array.isArray(msg.p) || msg.p.length !== 2 ||
      !Array.isArray(msg.c) || msg.c.length !== 2 || !Array.isArray(msg.q) || msg.q.length !== 2) return false;
  if (!msg.b.every(Number.isFinite) || !msg.p.every(Number.isFinite) || !msg.c.every(Number.isFinite)) return false;
  world.b = [Math.max(-0.1, Math.min(FW + 0.1, msg.b[0])), clampY(msg.b[1]), msg.b[2], msg.b[3]];
  world.p = [clampY(msg.p[0]), clampY(msg.p[1])];
  world.c = msg.c.map((n) => Math.max(0, Math.floor(n)));
  world.q = msg.q.map((id) => (Number.isInteger(id) ? id : null));
  world.w = msg.w === 0 || msg.w === 1 ? msg.w : null;
  world.sv = Number.isFinite(Number(msg.sv)) ? Math.max(0, Number(msg.sv)) : 0;
  srvDir = msg.d === 1 ? 1 : -1;

  push.clear();
  if (Array.isArray(msg.input)) {
    for (const row of msg.input) {
      if (!Array.isArray(row) || row.length !== 2) continue;
      const [id, dir] = row;
      if (id !== myId() && Number.isInteger(id)) push.set(id, dir === 1 ? 1 : dir === -1 ? -1 : 0);
    }
  }
  const now = performance.now();
  for (const id of world.q) if (id !== null && id !== myId()) seen.set(id, now);
  return true;
}

room.on('message', (from, msg) => {
  if (!msg || typeof msg.t !== 'string') return;
  seen.set(from, performance.now());

  if (msg.t === 'in') {
    push.set(from, msg.d === 1 ? 1 : msg.d === -1 ? -1 : 0);
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
  } else if (msg.t === 'table' && !boss() && (authority === null || authority === from)) {
    if (!tableOf(msg)) return;
    authority = from;
    hostId = from;
    // A picture from the host. Two are kept: the drawing lives between them.
    prev = next;
    prevAt = nextAt;
    next = msg;
    nextAt = performance.now();
    if (!prev) { prev = msg; prevAt = nextAt - TICK; }
  } else if (msg.t === 'hello' && boss()) {
    room.send(picture(), { to: from });
  }
});

function picture() {
  // A handover carries the direction the host is actually applying, rather
  // than the newer local intent that is still waiting out the fairness delay.
  const input = [[myId(), hostPush]];
  for (const [id, dir] of push) input.push([id, dir]);
  return { t: 'table', b: world.b.map(r3), p: world.p.map(r3), c: world.c,
           q: world.q, sv: Math.round(world.sv * 100) / 100, w: world.w, d: srvDir, input };
}

setInterval(() => {
  const now = performance.now();
  if (boss()) {
    const table = picture();
    rememberHostTable(now, table);
    if (!solo()) room.send(table);
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

setInterval(() => {
  if (!solo()) room.send({ t: 'in', d: myPush });
}, HEARTBEAT);

room.on('join', (p) => console.log(p.nick + ' walked in'));

room.on('leave', (p) => {
  seen.delete(p.id);
  push.delete(p.id);
  roundTrips.delete(p.id);
  for (let s = 0; s < 2; s++) if (world.q[s] === p.id) world.q[s] = null;
  console.log(p.nick + ' left; the bot takes their paddle');
});

room.on('hostchange', (h) => {
  heldInputs.length = 0;
  hostPush = 0;
  if (boss() && myPush) {
    heldInputs.push({ at: performance.now() + hostLag(performance.now()), dir: myPush });
  }
  hostPrev = hostNext = null;
  authority = h;
  hostId = h;
  if (!boss()) room.send({ t: 'hello' });
  console.log('the table is now run by ' + nickOf(h));
});

// ── the screen ─────────────────────────────────────────────────────────────
// Which hand the screen writes its instructions for. A device that says its
// pointer is coarse is taken at its word to begin with, and the first finger
// that actually lands settles it. Nothing but the wording hangs on this: a
// thumb and the arrow keys both reach `shove()`, and the wire cannot tell one
// from the other.
let coarse = matchMedia('(pointer: coarse)').matches;
// As short as the line it shares with the rest of the note: the table on a
// phone held upright is about a third of a desktop's width, and past a certain
// length the line is shrunk to fit until it is too small to read.
const pushing = () => (coarse ? 'drag up or down' : 'up and down arrows');

// `-webkit-touch-callout` and the selection rules are not decoration: a
// finger held still on iOS Safari is a long press, and a long press there
// selects what is under it and puts a Copy / Look Up bar over the page —
// which takes the pointer away mid-gesture and ends the hold. A drag escapes
// it because the movement cancels the press, so a game played by dragging
// never meets this; one played by holding meets it every time.
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

// Sets a font no wider than the table for the line about to be drawn in it. A
// phone held upright leaves the table about a third of the width a desktop
// does, and a line laid out for the wider one runs off both ends of the
// narrower — taking with it the half that says how to play.
function fitted(text, size) {
  ctx.font = `${Math.round(size)}px ui-monospace,Menlo,monospace`;
  const wide = ctx.measureText(text).width;
  if (wide <= FW * sc) return;
  ctx.font = `${Math.max(8, Math.round((size * FW * sc) / wide))}px ui-monospace,Menlo,monospace`;
}

// Every screen, including the host's, draws the moment between two pictures.
// The host keeps its own history on the same delayed timeline as its players.
function view(now) {
  const before = boss() ? hostPrev : prev;
  const after = boss() ? hostNext : next;
  const beforeAt = boss() ? hostPrevAt : prevAt;
  const afterAt = boss() ? hostNextAt : nextAt;
  if (!before || !after) return { b: world.b, p: world.p };
  const span = Math.max(1, afterAt - beforeAt);
  const k = Math.max(0, Math.min(1, (now - LAG - beforeAt) / span));
  const mix = (a, b) => a + (b - a) * k;
  // A ball that has been put back to the middle is not slid there: the two
  // pictures are of different rallies, and the second one is simply the truth.
  const jump = Math.hypot(after.b[0] - before.b[0], after.b[1] - before.b[1]) > 0.3;
  return {
    b: jump ? after.b : [mix(before.b[0], after.b[0]), mix(before.b[1], after.b[1])],
    p: [mix(before.p[0], after.p[0]), mix(before.p[1], after.p[1])],
  };
}

function draw(now) {
  const w = cv.clientWidth, h = cv.clientHeight;
  const v = view(now);
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

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let s = 0; s < 2; s++) {
    const x = X(s === 0 ? FW * 0.32 : FW * 0.68);
    ctx.fillStyle = hue(world.q[s]) || '#4b5563';
    ctx.font = `600 ${Math.round(sc * 0.16)}px ui-monospace,Menlo,monospace`;
    ctx.fillText(String(world.c[s]), x, Y(0.05));
    ctx.font = `${Math.round(sc * 0.045)}px ui-monospace,Menlo,monospace`;
    ctx.fillText(nickOf(world.q[s]) + (world.q[s] === myId() ? ' (you)' : ''), x, Y(0.05) + sc * 0.17);
  }

  for (let s = 0; s < 2; s++) {
    const cx = s === 0 ? PX : FW - PX;
    ctx.fillStyle = hue(world.q[s]) || '#59626e';
    const rx = X(cx - PW / 2), ry = Y(v.p[s] - PH / 2);
    const rw = PW * sc, rh = PH * sc, r = rw / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(rx, ry, rw, rh, r); else ctx.rect(rx, ry, rw, rh);
    ctx.fill();
  }

  if (world.w === null) {
    ctx.fillStyle = world.sv > 0 ? 'rgba(233,238,244,0.35)' : '#e9eef4';
    ctx.beginPath();
    ctx.arc(X(v.b[0]), Y(v.b[1]), BR * sc, 0, Math.PI * 2);
    ctx.fill();
  }

  // The wire, in the corner, in the platform's own quiet grey.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.font = `${Math.round(sc * 0.035)}px ui-monospace,Menlo,monospace`;
  ctx.fillStyle = '#59626e';
  ctx.fillText(boss() ? 'you run the table' : pingMs === null ? 'ping —' : 'ping ' + Math.round(pingMs) + ' ms',
               X(FW) , Y(FH) + sc * 0.02);

  let note = '';
  if (world.w !== null) note = nickOf(world.q[world.w]).toUpperCase() + ' WINS';
  else if (mySeat() < 0) note = 'watching — you play when a seat opens';
  else if (world.q[1 - mySeat()] === null) note = pushing() + ' · playing the bot until someone takes the other paddle';
  else note = pushing();
  // Centred, and said so: the line above this one is the only right-aligned
  // thing on the table, and both of these are placed at the middle of it. Left
  // as inherited they are laid out from the middle leftwards, which on a wide
  // table merely looks wrong and on a phone puts the beginning of the line off
  // the side of the screen.
  ctx.textAlign = 'center';
  if (note) {
    fitted(note, sc * 0.05);
    ctx.fillStyle = world.w !== null ? '#e9eef4' : '#79838f';
    ctx.textBaseline = 'bottom';
    ctx.fillText(note, X(FW / 2), Y(FH) - sc * 0.04);
  }

  const how = 'controls: ' + (coarse ? 'drag up / down' : '↑ / ↓');
  fitted(how, sc * 0.032);
  ctx.fillStyle = '#59626e';
  ctx.textBaseline = 'bottom';
  ctx.fillText(how, X(FW / 2), Y(FH) + sc * 0.09);
}

// ── the hands ──────────────────────────────────────────────────────────────
// Arrow keys, and nothing else. Everything a hand can say here is one of three
// things — up, down, or nothing — and it is said when it changes. The same
// value is repeated once a second so a stopped frame yields its seat to the bot.
//
// The mouse is deliberately not wired to this. Pointing at a place and letting
// the disk push toward it is a loop closed through the network: the paddle
// arrives where it was told a round trip ago, has already gone past, and is
// told to come back. On a wire of any length that is a paddle sliding to and
// fro on its own, ignoring the hand. A key is a direction, not a destination,
// and a direction cannot overshoot.
const keys = new Set();
function fromKeys() {
  let d = 0;
  if (keys.has('ArrowUp') || keys.has('w') || keys.has('W')) d -= 1;
  if (keys.has('ArrowDown') || keys.has('s') || keys.has('S')) d += 1;
  return d;
}
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'w', 'W', 's', 'S'].includes(e.key)) e.preventDefault();
  keys.add(e.key);
  shove(hands());
});
addEventListener('keyup', (e) => { keys.delete(e.key); shove(hands()); });
addEventListener('blur', () => { keys.clear(); letGo(); });

// ── the thumbs ─────────────────────────────────────────────────────────────
// A phone has no arrow keys, so up and down are said with a thumb: the touch
// that goes down is the middle of a short stick, and dragging above or below
// that point is the direction, held for as long as the thumb stays there.
//
// A drag rather than a press on a half of the table, and the reason is iOS
// rather than taste. A finger held still is a long press there, and a long
// press is a gesture the browser keeps for itself — inside a frame it selects
// what is under it and puts a Copy bar over the page, and the disk is handed a
// `pointercancel` in place of the hold. A drag never reaches that: the
// movement cancels the press before the browser claims it. It is the gesture
// chapaev.js is played with, and the one that is known to survive a frame.
//
// It stays a direction rather than a place on the table, which is what the
// mouse was kept away from above: a paddle sent toward where a finger rests
// arrives a round trip late, has already gone past, and is sent back — a
// paddle pacing on its own. An offset from the thumb cannot overshoot.
//
// Only touches are read. A laptop with a touchscreen answers the coarse
// pointer query as loudly as a phone does, and on one of those every click on
// the table would otherwise plant a stick under the mouse.
const DEAD = 10;     // px of slack, so a thumb resting still is a paddle at rest
const REACHOUT = 46; // px at which the stick is all the way over
let stick = null;    // { pointerId, ox, oy, dy }

function fromThumb() {
  if (!stick || Math.abs(stick.dy) < DEAD) return 0;
  return stick.dy < 0 ? -1 : 1;
}
// A thumb overrides the keys rather than adding to them: pressing both at once
// is nobody's intention, and summing them would cancel to a stopped paddle,
// which is the one answer neither hand asked for.
function hands() { return fromThumb() || fromKeys(); }

function letGo() {
  stick = null;
  paintStick();
  shove(hands());
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
  stick = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, dy: 0 };
  paintStick();
});
cv.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  stick.dy = e.clientY - stick.oy;
  paintStick();
  shove(hands());
});
// `pointercancel` as well as `pointerup`: a touch the browser takes away — a
// system gesture starting over the frame — never reports a release, and the
// paddle would be left travelling with nobody's thumb on it. Both are heard on
// the window as well: a capture that was broken before it took hold sends the
// release somewhere else, and a stick left standing refuses the next thumb.
const lift = (e) => { if (stick && e.pointerId === stick.pointerId) letGo(); };
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

// The stick is drawn in the page rather than on the canvas: the table is the
// same picture for everyone in the room, and one screen's controls are not
// part of it.
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
  // The knob stops at the rim: past it the thumb is only saying the same
  // direction louder, and a paddle has no louder to be pushed in.
  const k = Math.abs(stick.dy) > REACHOUT ? REACHOUT / Math.abs(stick.dy) : 1;
  pad.style.display = 'block';
  track.style.left = stick.ox + 'px';
  track.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + 'px';
  knob.style.top = stick.oy + stick.dy * k + 'px';
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

console.log('pong.js up · host:', boss());
