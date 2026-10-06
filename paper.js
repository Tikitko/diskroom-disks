/**
 * @disk     paper
 * @author   diskroom
 * @version  6
 * @players  1-8
 * @about    Grab ground by drawing a loop around it, with the arrow keys, WASD or a thumb. Leave your own patch and you are drawing a line; get back to it and everything you went around is yours. Anyone who crosses that line before you are home takes you off the board.
 * @tags     game, arcade, realtime, territory, example, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/paper.png
 */
// paper.js — paper where the room's order is the referee.
//
// The legacy paper.js (disks/legacy/paper.js) runs the board on the host and
// sends the whole of it, every cell, every step, to every seat: that is what a
// board has to cost when one copy holds it and the rest only look. Here every
// copy holds it. What travels is a turn — a number from 0 to 3 — and the tick
// that says one step has passed, both sent with `{ echo: true }`, so every copy
// walks the same heads over the same board in the same order and draws the same
// ground. The board itself crosses the wire once, to somebody arriving late.
//
// A turn is answered at once on your own screen: the board drawn is the agreed
// one played forward by the trip it takes, with your turn in it, and replayed
// from the agreed one whenever that moves.
//
// A turn names the life it was made in. A player who dies and is put back
// somewhere else is in a new life, and a turn from the old one — a repeat of
// the key held when they hit the wall — is refused rather than walking them
// into it again.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The board is integers and nothing else needs more: a random number is the
// only thing the rules draw, and it is drawn from the table.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 1000 / 92;           // one cell every 92 ms
const STEPS_PER_TICK = 1;
const PREDICT = true;
// A player whose tab has gone quiet stays on the board, as on the legacy
// paper.js: taken off it, they would lose their seat, their colour and their
// score for being in another tab. Only leaving the room takes somebody off the
// board.
const KEEP_SILENT = true;

const W = 48, H = 30;           // cells, in the proportion of a wide screen
const RESPAWN_STEPS = 24;
const NOTE_STEPS = 33;          // how long a line about who cut whom stays up
const HOME = 2;                 // half-width of the patch you start on
const KEEP = 3;                 // bots make the board up to this many
const BOT_IDS = [-2, -3];
const SEATS = 8;
const TURNS_KEPT = 3;           // turns a player may have waiting for the steps to take them

// 0 is bare ground, 1..8 is a seat's ground, 9..16 is a seat's line.
const GROUND = (seat) => 1 + seat;
const LINE = (seat) => 9 + seat;
const seatOfGround = (v) => (v >= 1 && v <= 8 ? v - 1 : -1);
const seatOfLine = (v) => (v >= 9 && v <= 16 ? v - 9 : -1);

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // up, right, down, left

const C = { bg: '#1c1c1c', grid: '#242424', edge: '#2f2f2f', muted: '#8f8f8f', dim: '#4a4a4a' };
const INK = ['#a9c0a9', '#d3a9a9', '#a9b6d3', '#d3c4a9', '#bda9d3', '#a9d0d3', '#d3a9c4', '#c0b49a'];
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

const isBot = (id) => id < -1;
const at = (x, y) => y * W + x;
const inside = (x, y) => x >= 0 && x < W && y >= 0 && y < H;

// The board. Plain data only: fingerprinted and handed over as JSON.
function freshTable(seed) {
  return {
    rng: seed | 0,
    g: new Array(W * H).fill(0),  // the ground, cell by cell
    p: {},                        // player id -> a head, see `join`
    turn: {},                     // player id -> [dir, life] as last heard
    tq: {},                       // player id -> turns heard and not yet taken, oldest first
    note: null,                   // [what, by, who, step] — the last cut, told as data
  };
}

const playersIn = (w) => Object.keys(w.p).map(Number).filter((id) => !isBot(id));

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((p) => p.seat));
  for (let s = 0; s < SEATS; s += 1) if (!taken.has(s)) return s;
  return -1;
}

// Somewhere with nobody else's ground under it, so nobody is born owning what
// somebody else has already walked around.
function homeSpot(w) {
  let best = null, bestScore = -1;
  for (let tries = 0; tries < 60; tries += 1) {
    const x = HOME + 1 + Math.floor(draw01(w) * (W - 2 * HOME - 2));
    const y = HOME + 1 + Math.floor(draw01(w) * (H - 2 * HOME - 2));
    let bare = 0;
    for (let dy = -HOME; dy <= HOME; dy += 1) {
      for (let dx = -HOME; dx <= HOME; dx += 1) if (w.g[at(x + dx, y + dy)] === 0) bare += 1;
    }
    if (bare > bestScore) { bestScore = bare; best = { x, y }; }
    if (bare === (2 * HOME + 1) * (2 * HOME + 1)) break;
  }
  return best;
}

// The way with the most room ahead of it. A run that starts three cells from a
// wall pointed at the wall is over before the person has touched a key.
function safeDir(x, y) {
  const room = [y, W - 1 - x, H - 1 - y, x];
  let best = 0;
  for (let d = 1; d < 4; d += 1) if (room[d] > room[best]) best = d;
  return best;
}

function settle(w, id, p) {
  const spot = homeSpot(w);
  p.x = spot.x; p.y = spot.y; p.hx = spot.x; p.hy = spot.y;
  p.dir = safeDir(spot.x, spot.y);
  p.want = p.dir;
  p.line = [];
  p.alive = true;
  p.life = w.n;                   // a turn from before this is a turn from another life
  delete w.turn[id];
  delete w.tq[id];
  for (let dy = -HOME; dy <= HOME; dy += 1) {
    for (let dx = -HOME; dx <= HOME; dx += 1) w.g[at(p.x + dx, p.y + dy)] = GROUND(p.seat);
  }
}

function join(w, id) {
  const seat = freeSeat(w);
  if (seat < 0) return null;
  const p = { seat, x: 0, y: 0, dir: 1, want: 1, alive: false, line: [], hx: 0, hy: 0,
              cells: 0, kills: 0, back: 0, legs: 0, life: 0 };
  w.p[id] = p;
  settle(w, id, p);
  return p;
}

function wipe(w, p) {
  for (let i = 0; i < w.g.length; i += 1) {
    if (w.g[i] === GROUND(p.seat) || w.g[i] === LINE(p.seat)) w.g[i] = 0;
  }
  p.line = [];
}

function fell(w, id, p, by) {
  if (!p.alive) return;
  p.alive = false;
  p.back = w.n + RESPAWN_STEPS;
  wipe(w, p);
  if (by !== null && by !== id) {
    const killer = w.p[by];
    if (killer) killer.kills += 1;
    w.note = ['cut', by, id, w.n];
  } else {
    w.note = ['off', id, id, w.n];
  }
}

// Everything the outside cannot reach is inside the loop, and inside the loop
// is what the loop was for.
function claim(w, id, p) {
  const seat = p.seat;
  for (const cell of p.line) w.g[cell] = GROUND(seat);
  p.line = [];

  const outside = new Uint8Array(W * H);
  const queue = [];
  const seed = (i) => { if (w.g[i] !== GROUND(seat) && !outside[i]) { outside[i] = 1; queue.push(i); } };
  for (let x = 0; x < W; x += 1) { seed(at(x, 0)); seed(at(x, H - 1)); }
  for (let y = 0; y < H; y += 1) { seed(at(0, y)); seed(at(W - 1, y)); }
  while (queue.length) {
    const i = queue.pop();
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inside(nx, ny)) continue;
      const j = at(nx, ny);
      if (outside[j] || w.g[j] === GROUND(seat)) continue;
      outside[j] = 1;
      queue.push(j);
    }
  }

  const cutOff = new Set();
  for (let i = 0; i < w.g.length; i += 1) {
    if (outside[i] || w.g[i] === GROUND(seat)) continue;
    const theirs = seatOfLine(w.g[i]);
    if (theirs >= 0) cutOff.add(theirs);
    w.g[i] = GROUND(seat);
  }
  // A line that ends up under somebody else's ground has nowhere left to come
  // home to, and its owner goes down with it.
  for (const key of Object.keys(w.p)) {
    const other = Number(key), q = w.p[key];
    if (other === id || !q.alive || !cutOff.has(q.seat)) continue;
    fell(w, other, q, id);
  }
}

function stepOne(w, id, p) {
  const d = DIRS[p.dir];
  const nx = p.x + d[0], ny = p.y + d[1];
  if (!inside(nx, ny)) { fell(w, id, p, null); return; }

  const hurt = seatOfLine(w.g[at(nx, ny)]);
  if (hurt >= 0) {
    for (const key of Object.keys(w.p)) {
      if (w.p[key].seat !== hurt) continue;
      fell(w, Number(key), w.p[key], id);
      break;
    }
    if (!p.alive) return;                       // it was this player's own line
  }

  p.x = nx;
  p.y = ny;
  if (w.g[at(nx, ny)] === GROUND(p.seat)) {
    if (p.line.length) claim(w, id, p);
  } else {
    w.g[at(nx, ny)] = LINE(p.seat);
    p.line.push(at(nx, ny));
  }
}

// A bot goes out, turns a couple of corners and heads home. What it is for is
// a board with something on it when the first person arrives.
function botTurn(w, p) {
  const ok = (dir) => {
    if ((dir + 2) % 4 === p.dir) return false;
    const nx = p.x + DIRS[dir][0], ny = p.y + DIRS[dir][1];
    return inside(nx, ny) && seatOfLine(w.g[at(nx, ny)]) !== p.seat;
  };
  const options = [0, 1, 2, 3].filter(ok);
  if (!options.length) return p.dir;
  if (p.line.length === 0) p.legs = 4 + Math.floor(draw01(w) * 7);
  if (p.line.length < p.legs) {
    if (ok(p.dir) && draw01(w) > 0.16) return p.dir;
    return options[Math.floor(draw01(w) * options.length)];
  }
  let best = options[0], bestFar = Infinity;
  for (const dir of options) {
    const far = Math.abs(p.x + DIRS[dir][0] - p.hx) + Math.abs(p.y + DIRS[dir][1] - p.hy);
    if (far < bestFar) { bestFar = far; best = dir; }
  }
  return best;
}

// Bots make up the numbers, and give way as people arrive.
function bots(w) {
  const people = playersIn(w).length;
  const wanted = Math.max(0, Math.min(BOT_IDS.length, KEEP - people));
  const have = Object.keys(w.p).map(Number).filter(isBot);
  while (have.length > wanted) {
    const id = have.pop();
    wipe(w, w.p[id]);
    delete w.p[id];
  }
  for (const id of BOT_IDS) {
    if (have.length >= wanted || w.p[id]) continue;
    if (join(w, id)) have.push(id);
  }
}

// A turn, at its place in the room's order. Being heard is how you arrive.
//
// Turns wait in line for the steps that take them, one a step. A head moves a
// cell every step and a hand is quicker than that: up and then left pressed
// inside one step, to turn back on yourself, would otherwise leave only the
// left — a way straight back into your own neck, which is refused, and the
// head runs on as if nothing had been pressed.
function hand(w, id, input) {
  let p = w.p[id];
  if (!p) {
    p = join(w, id);
    if (!p) return;
  }
  if (input[1] !== p.life) return;              // a turn from a life that is over
  const last = w.turn[id];
  if (last && last[0] === input[0]) return;     // the same hand said again, not a new turn
  w.turn[id] = input;
  const q = w.tq[id] || (w.tq[id] = []);
  if (q.length < TURNS_KEPT) q.push(input[0]);
}

function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [d, life] = raw;
  if (!Number.isInteger(d) || d < 0 || d > 3 || !Number.isInteger(life)) return null;
  return [d, life];
}

function leave(w, id) {
  const p = w.p[id];
  if (!p) return;
  wipe(w, p);
  delete w.p[id];
  delete w.turn[id];
  delete w.tq[id];
}

function step(w) {
  bots(w);
  for (const key of Object.keys(w.p)) {
    const id = Number(key), p = w.p[key];
    if (!p.alive) {
      if (w.n >= p.back) settle(w, id, p);
      continue;
    }
    if (isBot(id)) p.want = botTurn(w, p);
    else if (w.tq[key]) {
      // The first waiting turn that changes anything: one the head is already
      // going, or one straight back, is spent without costing the step.
      const q = w.tq[key];
      while (q.length) {
        const d = q.shift();
        if (d !== p.dir && (d + 2) % 4 !== p.dir) { p.want = d; break; }
      }
      if (!q.length) delete w.tq[key];
    }
    // A turn back into your own neck is a way to die that no hand meant.
    if ((p.want + 2) % 4 !== p.dir) p.dir = p.want;
    stepOne(w, id, p);
  }

  // Two heads that walked into the same cell in the same step: neither was
  // there first, so neither survives it.
  const where = new Map();
  for (const key of Object.keys(w.p)) {
    const p = w.p[key];
    if (!p.alive) continue;
    const cell = at(p.x, p.y);
    if (where.has(cell)) {
      const other = where.get(cell);
      fell(w, Number(key), p, null);
      fell(w, Number(other), w.p[other], null);
    } else where.set(cell, key);
  }

  const bySeat = new Map();
  for (const p of Object.values(w.p)) { p.cells = 0; bySeat.set(p.seat, p); }
  for (let i = 0; i < w.g.length; i += 1) {
    const seat = seatOfGround(w.g[i]);
    if (seat >= 0 && bySeat.has(seat)) bySeat.get(seat).cells += 1;
  }
}

// A board handed over by somebody else is their claim, and is read as one.
function tableOf(raw) {
  if (!raw || !Number.isInteger(raw.rng) || !Array.isArray(raw.g) || raw.g.length !== W * H) return null;
  if (!raw.g.every((v) => Number.isInteger(v) && v >= 0 && v <= 16)) return null;
  const p = {};
  const cell = (v) => Number.isInteger(v) && v >= 0 && v < W * H;
  for (const [id, q] of Object.entries(raw.p || {})) {
    if (!Number.isInteger(Number(id)) || !q || typeof q !== 'object') return null;
    const ints = ['seat', 'x', 'y', 'dir', 'want', 'hx', 'hy', 'cells', 'kills', 'back', 'legs', 'life'];
    if (!ints.every((k) => Number.isInteger(q[k]))) return null;
    if (q.seat < 0 || q.seat >= SEATS || !inside(q.x, q.y) || q.dir < 0 || q.dir > 3 || q.want < 0 || q.want > 3) return null;
    if (!Array.isArray(q.line) || !q.line.every(cell)) return null;
    p[id] = { seat: q.seat, x: q.x, y: q.y, dir: q.dir, want: q.want, alive: !!q.alive, line: q.line.slice(),
              hx: q.hx, hy: q.hy, cells: q.cells, kills: q.kills, back: q.back, legs: q.legs, life: q.life };
  }
  const turn = {};
  for (const [id, t] of Object.entries(raw.turn || {})) {
    const input = inputOf(t);
    if (Number.isInteger(Number(id)) && input) turn[id] = input;
  }
  const tq = {};
  for (const [id, q] of Object.entries(raw.tq || {})) {
    if (!Number.isInteger(Number(id)) || !Array.isArray(q) || !q.length || q.length > TURNS_KEPT) return null;
    if (!q.every((d) => Number.isInteger(d) && d >= 0 && d <= 3)) return null;
    tq[id] = q.slice();
  }
  let note = null;
  if (Array.isArray(raw.note) && raw.note.length === 4 && (raw.note[0] === 'cut' || raw.note[0] === 'off') &&
      raw.note.slice(1).every(Number.isInteger)) note = raw.note.slice();
  return { rng: raw.rng, g: raw.g.slice(), p, turn, tq, note };
}

// ═══════════════════ the screen ═══════════════════
let coarse = matchMedia('(pointer: coarse)').matches;

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${C.bg};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

let cell = 8, ox = 0, oy = 0;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth || 640, h = cv.clientHeight || 400;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Whole cells only, and the same board on every screen.
  cell = Math.max(2, Math.floor(Math.min((w * 0.98) / W, (h * 0.90) / H)));
  ox = Math.round((w - W * cell) / 2);
  oy = Math.round((h - H * cell) / 2) + Math.round(cell * 0.6);
}
layout();
window.addEventListener('resize', layout);

const seatInk = (seat) => INK[seat % INK.length];

function nickOf(id) {
  if (isBot(id)) return 'bot' + (-id - 1);
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((x) => x.id === id);
  return p ? p.nick : 'p' + id;
}

function noteOf(w) {
  if (!w.note || w.n - w.note[3] > NOTE_STEPS) return '';
  const [what, by, who] = w.note;
  return what === 'cut' ? nickOf(by) + ' cut ' + nickOf(who) + ' off' : nickOf(who) + ' went off the board';
}

function draw(now) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
  ctx.fillStyle = C.grid;
  ctx.fillRect(ox, oy, W * cell, H * cell);

  const b = agreedAt(now);
  const m = mineAt(now);
  ctx.font = `${Math.max(10, Math.round(cell * 1.05))}px ${MONO}`;
  if (!b) {
    ctx.textAlign = 'center';
    ctx.fillStyle = C.muted;
    ctx.fillText('catching up with the board', ox + (W * cell) / 2, oy + (H * cell) / 2);
    return;
  }
  const { to } = b;
  const me = String(myId());

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = to.g[at(x, y)];
      if (v === 0) continue;
      const ground = seatOfGround(v);
      ctx.globalAlpha = ground >= 0 ? 0.62 : 0.30;
      ctx.fillStyle = seatInk(ground >= 0 ? ground : seatOfLine(v));
      ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
    }
  }
  // This player's line as the guess has it: drawn where the hand is, not a trip
  // behind.
  const guessed = m.to.p[me];
  if (guessed && guessed.alive) {
    ctx.globalAlpha = 0.30;
    ctx.fillStyle = seatInk(guessed.seat);
    for (const i of guessed.line) ctx.fillRect(ox + (i % W) * cell, oy + Math.floor(i / W) * cell, cell, cell);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = C.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, oy + 0.5, W * cell - 1, H * cell - 1);

  const heads = [];
  for (const key of Object.keys(to.p)) {
    const pair = key === me && m.to.p[key] ? m : b;
    const { from, k } = pair;
    const p = pair.to.p[key], old = from.p[key];
    const id = Number(key);
    let fx = p.x, fy = p.y;
    // A head put back somewhere else is not walking across the board to get
    // there.
    if (old && old.alive && p.alive && Math.abs(old.x - p.x) + Math.abs(old.y - p.y) <= 1) {
      fx = old.x + (p.x - old.x) * k;
      fy = old.y + (p.y - old.y) * k;
    }
    heads.push({ id, p, fx, fy });
  }
  for (const { id, p, fx, fy } of heads) {
    if (!p.alive) continue;
    const x = ox + fx * cell, y = oy + fy * cell;
    ctx.fillStyle = seatInk(p.seat);
    ctx.fillRect(x - cell * 0.15, y - cell * 0.15, cell * 1.3, cell * 1.3);
    if (id === myId()) {
      ctx.strokeStyle = '#f5f5f5';
      ctx.lineWidth = Math.max(1, cell * 0.16);
      ctx.strokeRect(x - cell * 0.35, y - cell * 0.35, cell * 1.7, cell * 1.7);
    }
  }

  const whole = W * H;
  ctx.textAlign = 'left';
  let cursor = ox;
  for (const { id, p } of [...heads].sort((a, b) => b.p.cells - a.p.cells)) {
    const text = nickOf(id) + ' ' + ((p.cells / whole) * 100).toFixed(1) + '%';
    ctx.fillStyle = id === myId() ? '#f5f5f5' : seatInk(p.seat);
    ctx.globalAlpha = p.alive ? 1 : 0.4;
    ctx.fillText(text, cursor, oy - cell * 0.7);
    cursor += ctx.measureText(text + '   ').width;
  }
  ctx.globalAlpha = 1;

  // Only where the scores leave room for it: the scores are the game.
  const note = wireNote();
  if (cursor + ctx.measureText(note).width <= ox + W * cell) {
    ctx.textAlign = 'right';
    ctx.fillStyle = C.dim;
    ctx.fillText(note, ox + W * cell, oy - cell * 0.7);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = C.muted;
  ctx.fillText(noteOf(to) || (coarse
                 ? 'drag to steer — leave your patch, draw a loop, come back'
                 : 'arrows or wasd — leave your patch, draw a loop, come back'),
               ox + (W * cell) / 2, oy + H * cell + cell * 1.4);
}

// ═══════════════════ the hands ═══════════════════
// A turn is said for the life the agreed board has this player in; before the
// board has heard of them at all, for none in particular — their first turn
// is how they arrive, and it only has to be heard.
function steer(d) {
  const me = world && world.p[myId()];
  setHand([d, me ? me.life : 0]);
}

// Keys are read by where they sit, not by what they type: `e.code` is the same
// on every layout, while `e.key` is a Cyrillic letter on a Russian one, a
// capital with Caps Lock or Shift down, and a key let go under Shift would
// never match the one pressed and stay held for good.
const KEYS = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3, KeyW: 0, KeyD: 1, KeyS: 2, KeyA: 3 };
addEventListener('keydown', (e) => {
  const d = KEYS[e.code];
  if (d === undefined) return;
  e.preventDefault();
  steer(d);
});

// A drag rather than a press, because iOS keeps a long press inside a frame
// for itself. The furthest axis wins outright: a head on a grid has four ways
// to go and no fifth.
const DEAD = 12;
const REACHOUT = 46;
let stick = null;

cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || stick) return;
  coarse = true;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  stick = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
  paintStick();
});
cv.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  stick.dx = e.clientX - stick.ox;
  stick.dy = e.clientY - stick.oy;
  paintStick();
  if (Math.hypot(stick.dx, stick.dy) < DEAD) return;
  steer(Math.abs(stick.dx) > Math.abs(stick.dy) ? (stick.dx > 0 ? 1 : 3) : (stick.dy > 0 ? 2 : 0));
});
const lift = (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  stick = null;
  paintStick();
};
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

const pad = document.createElement('div');
pad.style.cssText = 'position:fixed;inset:0;display:none;pointer-events:none';
const ring = document.createElement('div');
ring.style.cssText =
  `position:fixed;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
  `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;` +
  `border:1px solid ${C.edge};background:rgba(143,143,143,0.06)`;
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;' +
  `background:${C.muted};opacity:.75`;
pad.append(ring, knob);
document.body.appendChild(pad);

function paintStick() {
  if (!stick) { pad.style.display = 'none'; return; }
  const far = Math.hypot(stick.dx, stick.dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
  pad.style.display = 'block';
  ring.style.left = stick.ox + 'px';
  ring.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + stick.dx * k + 'px';
  knob.style.top = stick.oy + stick.dy * k + 'px';
}

function frame(now) {
  draw(now);
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. The first turn is the one the board
// would give anyway; saying it is how this player arrives.
function start() {
  setHand([1, 0]);
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
// Steps the guess is moved by, learned from where my hands actually land. The
// steady clock settles on the earliest ticks, so on a wire whose delay jumps it
// runs ahead of the table most ticks arrive at, and the trip on top of it puts
// every hand a step or three later than the room does — my piece snapping back
// each time the truth arrives. Each hand that comes back says by how much.
let guessOff = 0;
const GUESS_LEARN = 0.2;                 // how much of one hand's miss moves the guess
const GUESS_MISS = 3;                    // the most steps one hand's miss counts for
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
    if (h.clocked && world) {
      // It lands at the table as it stands now, and steps on from there.
      const miss = Math.max(-GUESS_MISS, Math.min(GUESS_MISS, world.n - h.step));
      guessOff = Math.max(-GUESS_REACH, Math.min(GUESS_REACH, guessOff + miss * GUESS_LEARN));
    }
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
  // Only a hand placed off the clock, after a tick has set it, teaches the
  // guess anything: one placed without it was never the guess's to miss.
  const clocked = !!world && stepClock !== null && !stepClockGuessed && tripMs !== null;
  const at = world
    ? stepClock !== null && tripMs !== null
      ? Math.max(world.n, Math.floor(stepNow(performance.now()) + tripMs / STEP_MS + guessOff))
      : world.n + aheadSteps()
    : 0;
  unheard.push({ seq: inSeq, at: performance.now(), step: at, input: myHand, measured, clocked });
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
  // The piece is drawn as far ahead as its hands land: drawn any further, a
  // hand lands in what is already on screen and the piece jumps as it is made.
  const want = Math.max(0, Math.min(GUESS_REACH, tripMs / STEP_MS + guessOff));
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
