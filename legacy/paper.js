/**
 * @disk     paper
 * @author   diskroom
 * @version  3
 * @players  1-8
 * @about    Grab ground by drawing a loop around it, with the arrow keys or a thumb. Leave your own patch and you are drawing a line; get back to it and everything you went around is yours. Anyone who crosses that line before you are home takes you off the board.
 * @tags     game, arcade, realtime, territory, example
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/paper.png
 */
// paper.js — the whole board on the wire, once per step.
//
// One machine runs the board and everybody else sends which way they are
// turning, as in tag.js. What is different here is what comes back: not a
// handful of positions but the ground itself — every cell of it, run-length
// packed, in every picture.
//
// That is a deliberate trade rather than a shortcut. Sending what changed
// would be smaller, and one lost message would leave a board that is wrong for
// good with nothing to notice it by; a room where at most once is the promise
// has no way to ask for it again. A board that arrives whole cannot be wrong
// for longer than one tick, and the packing is what makes that affordable.
//
// What makes it safe is that the packing has a ceiling rather than a habit:
// no board can pack to more than two characters a cell, so the worst one there
// is fits a payload with a quarter of it to spare, and copied to seven other
// seats eleven times a second it is still under half of what one player may
// send.
// An ordinary board, which is a few large blocks and a line or two, is a small
// fraction of that.
//
// The clock the game runs on is the step: a player moves one cell at a time,
// always. Nothing is interpolated in the rules — only in the drawing, which
// slides a head between the last two pictures so the board moves at the rate
// of the screen rather than of the wire.
//
// Which is why the step and the picture are one event and not two. The board
// changes on a step and at no other moment, so a picture taken between steps
// says nothing new, and a step that no picture was taken of is a cell the
// drawing has to cross in no time at all. Two clocks at 92 and 100 ms beat
// against each other: eleven pictures out of twelve carried one step and the
// twelfth carried two, and on that twelfth every head on the board jumped its
// cell instead of walking it — a jolt a second, in front of everybody at once,
// because the host steps the whole board in one pass.

// ── the board ───────────────────────────────────────────────────────────────
const W = 48, H = 30;           // cells, in the proportion of a wide screen
const STEP_MS = 92;             // how long one cell takes
const TICK = STEP_MS;           // one picture per step, and never one without
const RESPAWN_MS = 2200;
const HOME = 2;                 // half-width of the patch you start on
const KEEP = 3;                 // bots make the board up to this many
const BOT_IDS = [-2, -3];
const STALE = 3000;             // ms of silence before a hand is treated as straight
const HEARTBEAT = 1000;
const SEATS = 8;

// 0 is bare ground, 1..8 is a seat's ground, 9..16 is a seat's line.
const GROUND = (seat) => 1 + seat;
const LINE = (seat) => 9 + seat;
const seatOfGround = (v) => (v >= 1 && v <= 8 ? v - 1 : -1);
const seatOfLine = (v) => (v >= 9 && v <= 16 ? v - 9 : -1);

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // up, right, down, left

const C = { bg: '#1c1c1c', grid: '#242424', edge: '#2f2f2f', muted: '#8f8f8f', dim: '#4a4a4a' };
const INK = ['#a9c0a9', '#d3a9a9', '#a9b6d3', '#d3c4a9', '#bda9d3', '#a9d0d3', '#d3a9c4', '#c0b49a'];
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

// ── state ───────────────────────────────────────────────────────────────────
const board = new Uint8Array(W * H);
const players = new Map();      // id -> { seat, x, y, dir, want, alive, line[], ... }
const seats = new Map();        // id -> seat, kept while a player is in the room
const turn = new Map();         // id -> the direction that hand last named
const seen = new Map();
let myDir = 1;
let mySentAt = 0;
let authority = null;
let hostId = null;
let pingMs = null;
let pingAt = 0;
let wasAlive = false;           // whether the last picture still had us on the board
let note = '';
const roundTrips = new Map();   // id -> how long the way there and back took
const heldTurns = [];           // the host's own hands, waiting out the wire
let probedAt = 0;
const STALE_RTT = 3000;
const PROBE_EVERY = 1000;
const HOST_LAG_FALLBACK = 25;
let hostDir = 1;                // the host's hand as the board has it

// The last two pictures. The drawing lives between them.
let prev = null, next = null, prevAt = 0, nextAt = 0;

const myId = () => (room.me ? room.me.id : -1);
const boss = () => room.isHost || !room.me;
const isBot = (id) => id < -1;
const at = (x, y) => y * W + x;
const inside = (x, y) => x >= 0 && x < W && y >= 0 && y < H;

// The slowest active link is the only choice that cannot leave the machine
// running the board turning a corner before the people it is cutting off.
function hostLag(now) {
  if (!room.me || !room.players.some((player) => player.id !== myId())) return 0;
  const legs = [];
  for (const [id, sample] of roundTrips) {
    if (id !== myId() && now - sample.at < STALE_RTT) legs.push(sample.rtt / 2);
  }
  return Math.max(0, Math.min(250, legs.length ? Math.max(...legs) : HOST_LAG_FALLBACK));
}

function releaseHeldTurns(now) {
  while (heldTurns.length && heldTurns[0].at <= now) hostDir = heldTurns.shift().d;
}

function nickOf(id) {
  if (isBot(id)) return 'bot' + (-id - 1);
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((x) => x.id === id);
  return p ? p.nick : 'p' + id;
}

// ── the rules. Only the host ever runs any of this ──────────────────────────
function freeSeat() {
  const taken = new Set(seats.values());
  for (let s = 0; s < SEATS; s += 1) if (!taken.has(s)) return s;
  return -1;
}

// Somewhere with nobody else's ground under it, so nobody is born owning what
// somebody else has already walked around.
function homeSpot() {
  let best = null, bestScore = -1;
  for (let tries = 0; tries < 60; tries += 1) {
    const x = HOME + 1 + Math.floor(Math.random() * (W - 2 * HOME - 2));
    const y = HOME + 1 + Math.floor(Math.random() * (H - 2 * HOME - 2));
    let bare = 0;
    for (let dy = -HOME; dy <= HOME; dy += 1) {
      for (let dx = -HOME; dx <= HOME; dx += 1) if (board[at(x + dx, y + dy)] === 0) bare += 1;
    }
    if (bare > bestScore) { bestScore = bare; best = { x, y }; }
    if (bare === (2 * HOME + 1) ** 2) break;
  }
  return best;
}

// The way with the most room ahead of it. A run that starts three cells from a
// wall pointed at the wall is over before the person has touched a key, and
// the direction a run starts in is not something anybody asked for.
function safeDir(x, y) {
  const room = [y, W - 1 - x, H - 1 - y, x];   // up, right, down, left
  let best = 0;
  for (let d = 1; d < 4; d += 1) if (room[d] > room[best]) best = d;
  return best;
}

function settle(id, p) {
  const spot = homeSpot();
  p.x = spot.x;
  p.y = spot.y;
  p.hx = spot.x;
  p.hy = spot.y;
  p.dir = safeDir(spot.x, spot.y);
  p.want = p.dir;
  // The hand that was held when the run ended is forgotten with it. Otherwise
  // a player who died against a wall is put back on the board still walking
  // into it, and dies again without having done anything.
  turn.delete(id);
  if (id === myId()) {
    myDir = p.dir;
    hostDir = p.dir;
    heldTurns.length = 0;
  }
  p.line = [];
  p.alive = true;
  for (let dy = -HOME; dy <= HOME; dy += 1) {
    for (let dx = -HOME; dx <= HOME; dx += 1) board[at(p.x + dx, p.y + dy)] = GROUND(p.seat);
  }
}

function join(id, now) {
  let seat = seats.get(id);
  if (seat === undefined) {
    seat = freeSeat();
    if (seat < 0) return null;
    seats.set(id, seat);
  }
  const p = {
    seat, x: 0, y: 0, dir: 1, want: 1, alive: false, line: [],
    hx: 0, hy: 0, cells: 0, kills: 0, deadUntil: 0, legs: 0,
  };
  players.set(id, p);
  settle(id, p);
  p.deadUntil = 0;
  return p;
}

function wipe(p) {
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === GROUND(p.seat) || board[i] === LINE(p.seat)) board[i] = 0;
  }
  p.line = [];
}

function fell(id, p, by, now) {
  if (!p.alive) return;
  p.alive = false;
  p.deadUntil = now + RESPAWN_MS;
  wipe(p);
  if (by !== null && by !== id) {
    const killer = players.get(by);
    if (killer) killer.kills += 1;
    note = nickOf(by) + ' cut ' + nickOf(id) + ' off';
  } else {
    note = nickOf(id) + ' went off the board';
  }
}

// Everything the outside cannot reach is inside the loop, and inside the loop
// is what the loop was for. Walking the border first is what makes that true
// without ever tracing the shape of the line itself.
function claim(id, p) {
  const seat = p.seat;
  for (const cell of p.line) board[cell] = GROUND(seat);
  p.line = [];

  const outside = new Uint8Array(W * H);
  const queue = [];
  for (let x = 0; x < W; x += 1) {
    for (const y of [0, H - 1]) {
      const i = at(x, y);
      if (board[i] !== GROUND(seat) && !outside[i]) { outside[i] = 1; queue.push(i); }
    }
  }
  for (let y = 0; y < H; y += 1) {
    for (const x of [0, W - 1]) {
      const i = at(x, y);
      if (board[i] !== GROUND(seat) && !outside[i]) { outside[i] = 1; queue.push(i); }
    }
  }
  while (queue.length) {
    const i = queue.pop();
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inside(nx, ny)) continue;
      const j = at(nx, ny);
      if (outside[j] || board[j] === GROUND(seat)) continue;
      outside[j] = 1;
      queue.push(j);
    }
  }

  const cutOff = new Set();
  for (let i = 0; i < board.length; i += 1) {
    if (outside[i] || board[i] === GROUND(seat)) continue;
    const theirs = seatOfLine(board[i]);
    if (theirs >= 0) cutOff.add(theirs);
    board[i] = GROUND(seat);
  }
  // A line that ends up under somebody else's ground has nowhere left to come
  // home to, and its owner goes down with it.
  for (const [other, q] of players) {
    if (other === id || !q.alive || !cutOff.has(q.seat)) continue;
    fell(other, q, id, performance.now());
  }
}

function stepOne(id, p, now) {
  const d = DIRS[p.dir];
  const nx = p.x + d[0], ny = p.y + d[1];
  if (!inside(nx, ny)) { fell(id, p, null, now); return; }

  const cell = board[at(nx, ny)];
  const hurt = seatOfLine(cell);
  if (hurt >= 0) {
    for (const [other, q] of players) {
      if (q.seat !== hurt) continue;
      fell(other, q, id, now);
      break;
    }
    if (!p.alive) return;                       // it was this player's own line
  }

  p.x = nx;
  p.y = ny;
  const here = board[at(nx, ny)];
  if (here === GROUND(p.seat)) {
    if (p.line.length) claim(id, p);
  } else {
    board[at(nx, ny)] = LINE(p.seat);
    p.line.push(at(nx, ny));
  }
}

function step(now) {
  for (const [id, p] of [...players]) {
    if (!p.alive) {
      if (now >= p.deadUntil) settle(id, p);
      continue;
    }
    if (isBot(id)) p.want = botTurn(id, p);
    else {
      const said = turn.get(id);
      const fresh = said !== undefined && now - (seen.get(id) || 0) < STALE;
      if (id === myId()) p.want = hostDir;
      else if (fresh) p.want = said;
    }
    // A turn back into your own neck is a way to die that no hand meant, so
    // the one direction a step cannot take is the one it came from.
    if ((p.want + 2) % 4 !== p.dir) p.dir = p.want;
    stepOne(id, p, now);
  }

  // Two heads that walked into the same cell in the same step: neither was
  // there first, so neither survives it.
  const where = new Map();
  for (const [id, p] of players) {
    if (!p.alive) continue;
    const key = at(p.x, p.y);
    if (where.has(key)) {
      const other = where.get(key);
      fell(id, p, null, now);
      fell(other, players.get(other), null, now);
    } else where.set(key, id);
  }

  for (const p of players.values()) p.cells = 0;
  const bySeat = new Map([...players].map(([id, p]) => [p.seat, p]));
  for (let i = 0; i < board.length; i += 1) {
    const seat = seatOfGround(board[i]);
    if (seat >= 0 && bySeat.has(seat)) bySeat.get(seat).cells += 1;
  }
}

// A bot goes out, turns a couple of corners and heads home. It is not clever
// and is not meant to be: what it is for is a board with something on it when
// the first person arrives.
function botTurn(id, p) {
  const ok = (dir) => {
    if ((dir + 2) % 4 === p.dir) return false;
    const nx = p.x + DIRS[dir][0], ny = p.y + DIRS[dir][1];
    return inside(nx, ny) && seatOfLine(board[at(nx, ny)]) !== p.seat;
  };
  const options = [0, 1, 2, 3].filter(ok);
  if (!options.length) return p.dir;
  if (p.line.length === 0) p.legs = 4 + Math.floor(Math.random() * 7);
  if (p.line.length < p.legs) {
    // On the way out: mostly straight, with a corner now and then.
    if (ok(p.dir) && Math.random() > 0.16) return p.dir;
    return options[Math.floor(Math.random() * options.length)];
  }
  // On the way back: whichever step leaves it nearest the middle of the patch
  // it was born on. Reading the whole board for the nearest cell of its own
  // would be truer and costs the event loop four passes a step, which is a
  // price a bot does not get to charge the room.
  let best = options[0], bestFar = Infinity;
  for (const dir of options) {
    const far = Math.abs(p.x + DIRS[dir][0] - p.hx) + Math.abs(p.y + DIRS[dir][1] - p.hy);
    if (far < bestFar) { bestFar = far; best = dir; }
  }
  return best;
}

function roster(now) {
  const here = new Set(room.players.map((p) => p.id));
  here.add(myId());
  for (const [id, p] of [...players]) {
    if (isBot(id) || here.has(id)) continue;
    wipe(p);
    players.delete(id);
    seats.delete(id);
    turn.delete(id);
  }
  for (const id of here) if (!players.has(id)) join(id, now);

  const wanted = Math.max(0, Math.min(BOT_IDS.length, KEEP - here.size));
  const bots = [...players.keys()].filter(isBot);
  while (bots.length > wanted) {
    const id = bots.pop();
    wipe(players.get(id));
    players.delete(id);
    seats.delete(id);
  }
  for (const id of BOT_IDS) {
    if (bots.length >= wanted || players.has(id)) continue;
    if (join(id, now)) bots.push(id);
  }
}

// ── the wire ────────────────────────────────────────────────────────────────
const chr = (v) => (v === 0 ? '.' : String.fromCharCode(64 + v));

// A run costs one character and its length in digits, which for a run of one
// cell is two characters and never more per cell than that. So the worst board
// this format can be handed — every cell different from its neighbour — packs
// to twice the cells and no more, and that is what decides the size of the
// board above: two characters a cell over forty-eight by thirty is under three
// kilobytes, and the heads and the wrapping fit in what is left of the four.
// The ceiling is met by construction rather than by hoping boards stay tidy.
function pack() {
  let out = '', run = board[0], n = 0;
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === run) { n += 1; continue; }
    out += chr(run) + n;
    run = board[i];
    n = 1;
  }
  return out + chr(run) + n;
}

const scratch = new Uint8Array(W * H);

function unpack(text) {
  let i = 0, cell = 0;
  while (i < text.length && cell < board.length) {
    const ch = text[i];
    i += 1;
    let digits = '';
    while (i < text.length && text[i] >= '0' && text[i] <= '9') { digits += text[i]; i += 1; }
    const n = Number(digits);
    const v = ch === '.' ? 0 : ch.charCodeAt(0) - 64;
    if (!Number.isFinite(n) || n <= 0 || v < 0 || v > 16) return false;
    for (let k = 0; k < n && cell < board.length; k += 1) scratch[cell++] = v;
  }
  // A board that did not fill is a board with a hole in it, and a hole drawn
  // as bare ground is a lie about who owns what. It is put together beside the
  // real one and only then swapped in, so a message that turns out to be short
  // costs nothing at all rather than half a board.
  if (cell !== board.length) return false;
  board.set(scratch);
  return true;
}

function picture() {
  const heads = [];
  for (const [id, p] of players) {
    heads.push([id, p.seat, p.x, p.y, p.dir, p.alive ? 1 : 0, p.cells, p.kills]);
  }
  return { t: 'b', g: pack(), h: heads, n: note };
}

function headsOf(msg) {
  if (!Array.isArray(msg.h) || msg.h.length > SEATS + 2) return null;
  const out = [];
  for (const row of msg.h) {
    if (!Array.isArray(row) || row.length !== 8) return null;
    const [id, seat, x, y, dir, alive, cells, kills] = row;
    if (!Number.isInteger(id) || !Number.isInteger(seat) || seat < 0 || seat >= SEATS) return null;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !inside(x, y)) return null;
    out.push({ id, seat, x, y, dir: Number(dir) || 0, alive: !!alive, cells: Number(cells) || 0, kills: Number(kills) || 0 });
  }
  return out;
}

room.on('message', (from, msg) => {
  if (!msg || typeof msg.t !== 'string') return;
  seen.set(from, performance.now());

  if (msg.t === 'turn') {
    const d = Number(msg.d);
    if (Number.isInteger(d) && d >= 0 && d < 4) turn.set(from, d);
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
  } else if (msg.t === 'b' && !boss() && (authority === null || authority === from)) {
    const heads = headsOf(msg);
    if (!heads || typeof msg.g !== 'string' || !unpack(msg.g)) return;
    authority = from;
    hostId = from;
    note = String(msg.n ?? '').slice(0, 80);
    prev = next;
    prevAt = nextAt;
    next = heads;
    nextAt = performance.now();
    if (!prev) { prev = heads; prevAt = nextAt - TICK; }
    const mine = heads.find((head) => head.id === myId());
    if (mine) {
      if (mine.alive && !wasAlive) myDir = mine.dir;
      wasAlive = mine.alive;
    }
  } else if (msg.t === 'hello' && boss()) {
    room.send(picture(), { to: from });
  }
});

setInterval(() => {
  const now = performance.now();
  if (boss()) {
    roster(now);
    releaseHeldTurns(now);
    if (now - probedAt >= PROBE_EVERY) {
      probedAt = now;
      for (const player of room.players) {
        if (player.id !== myId()) room.send({ t: 'probe', at: Math.round(now) }, { to: player.id });
      }
    }
    // One step, then the picture of it. Not "as many steps as the clock is
    // owed": a tab that was in the background for a minute owes six hundred of
    // them, and a debt played out in one pass is how a disk stops answering —
    // here there is no debt to play out, because the timer not firing is the
    // board not moving. A late timer makes the step late, and the drawing,
    // which paces itself by the gap between the pictures it actually got,
    // walks the cell slower rather than skipping it.
    step(now);
    const shot = picture();
    prev = next;
    prevAt = nextAt;
    next = shot.h.map((row) => ({
      id: row[0], seat: row[1], x: row[2], y: row[3], dir: row[4],
      alive: !!row[5], cells: row[6], kills: row[7],
    }));
    nextAt = now;
    if (!prev) { prev = next; prevAt = nextAt - TICK; }
    if (room.me) room.send(shot);
  } else {
    if (hostId !== null && now - pingAt > 1000) {
      pingAt = now;
      room.send({ t: 'ping', at: Math.round(now) }, { to: hostId });
    }
  }
  if (!boss() && room.me && now - mySentAt >= HEARTBEAT) {
    mySentAt = now;
    room.send({ t: 'turn', d: myDir });
  }
}, TICK);

function steer(d) {
  if (d === myDir) return;
  myDir = d;
  const now = performance.now();
  if (boss()) heldTurns.push({ at: now + hostLag(now), d });
  else if (room.me) {
    mySentAt = now;
    room.send({ t: 'turn', d });
  }
}

room.on('join', (p) => console.log(p.nick + ' walked in'));
room.on('leave', (p) => { seen.delete(p.id); turn.delete(p.id); roundTrips.delete(p.id); console.log(p.nick + ' left'); });

room.on('hostchange', (h) => {
  authority = h;
  hostId = h;
  const last = next;
  prev = next = null;
  if (boss()) {
    heldTurns.length = 0;
    hostDir = myDir;
    // Who sits in which seat is the old host's, and only the old host kept
    // it. The last picture it sent names every head with its seat, and the
    // board is coloured by those seats: taken from anywhere else — dealt again
    // from the first free one — the ground and the lines on it would belong to
    // whoever happened to be handed that number, and a line would kill the
    // wrong player.
    if (last) {
      players.clear();
      seats.clear();
      for (const head of last) {
        seats.set(head.id, head.seat);
        players.set(head.id, {
          seat: head.seat, x: head.x, y: head.y, dir: head.dir & 3, want: head.dir & 3,
          alive: head.alive, line: [], hx: head.x, hy: head.y,
          cells: head.cells, kills: head.kills, deadUntil: 0, legs: 0,
        });
      }
    }
    // The board is the one thing every seat already has a whole copy of, so
    // the machine that has just been handed the room keeps playing on the last
    // one it was sent rather than starting the ground over.
    for (const [id, p] of [...players]) {
      p.line = [];
      for (let i = 0; i < board.length; i += 1) if (board[i] === LINE(p.seat)) board[i] = 0;
      if (!p.alive) settle(id, p);
    }
    note = 'the board is now run by ' + nickOf(h);
  } else {
    room.send({ t: 'hello' });
  }
});

// ── the screen ──────────────────────────────────────────────────────────────
// Which hand the board writes its instructions for. A device that says its
// pointer is coarse is taken at its word to begin with, and the first finger
// that actually lands settles it. Nothing but the wording hangs on this: a
// thumb and the arrow keys both reach `steer()`, and the wire cannot tell one
// from the other.
let coarse = matchMedia('(pointer: coarse)').matches;

// `-webkit-touch-callout` and the selection rules are not decoration: a finger
// held still on iOS Safari is a long press, and a long press there selects
// what is under it and puts a Copy bar over the page — which takes the pointer
// away mid-gesture. The stick below is dragged rather than held, which is what
// really keeps it clear of that, but there is no reason to leave the frame
// selectable as well.
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
  // Whole cells only, and the same board on every screen: half a cell of
  // rounding is a wall drawn where the rules do not have one.
  cell = Math.max(2, Math.floor(Math.min((w * 0.98) / W, (h * 0.90) / H)));
  ox = Math.round((w - W * cell) / 2);
  oy = Math.round((h - H * cell) / 2) + Math.round(cell * 0.6);
}
layout();
window.addEventListener('resize', layout);

const seatInk = (seat) => INK[seat % INK.length];
const mySeat = () => {
  const heads = next || [];
  const mine = heads.find((p) => p.id === myId());
  return mine ? mine.seat : -1;
};

function shown(now) {
  if (!prev || !next) return next || [];
  // One whole picture behind, and the cushion is the gap between the last two
  // rather than a number written here: the leg is then walked over exactly the
  // time the next picture takes to arrive. A fixed cushion shorter than that
  // gap — 60 ms against 100 — finished every leg early and left the head
  // standing on the cell for the rest of it.
  const span = Math.max(1, nextAt - prevAt);
  const k = Math.max(0, Math.min(1, (now - nextAt) / span));
  const was = new Map(prev.map((p) => [p.id, p]));
  return next.map((p) => {
    const old = was.get(p.id);
    if (!old || !old.alive || !p.alive) return { ...p, fx: p.x, fy: p.y };
    // A head that has been put back on the board somewhere else is not moving
    // across the board to get there.
    const far = Math.abs(old.x - p.x) + Math.abs(old.y - p.y);
    if (far > 1) return { ...p, fx: p.x, fy: p.y };
    return { ...p, fx: old.x + (p.x - old.x) * k, fy: old.y + (p.y - old.y) * k };
  });
}

function draw(now) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);

  ctx.fillStyle = C.grid;
  ctx.fillRect(ox, oy, W * cell, H * cell);

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = board[at(x, y)];
      if (v === 0) continue;
      const ground = seatOfGround(v);
      const line = seatOfLine(v);
      ctx.globalAlpha = ground >= 0 ? 0.62 : 0.30;
      ctx.fillStyle = seatInk(ground >= 0 ? ground : line);
      ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
    }
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = C.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + 0.5, oy + 0.5, W * cell - 1, H * cell - 1);

  const heads = shown(now);
  for (const p of heads) {
    if (!p.alive) continue;
    const x = ox + p.fx * cell, y = oy + p.fy * cell;
    ctx.fillStyle = seatInk(p.seat);
    ctx.fillRect(x - cell * 0.15, y - cell * 0.15, cell * 1.3, cell * 1.3);
    if (p.id === myId()) {
      ctx.strokeStyle = '#f5f5f5';
      ctx.lineWidth = Math.max(1, cell * 0.16);
      ctx.strokeRect(x - cell * 0.35, y - cell * 0.35, cell * 1.7, cell * 1.7);
    }
  }

  const whole = W * H;
  const table = [...heads].sort((a, b) => b.cells - a.cells);
  ctx.textAlign = 'left';
  ctx.font = `${Math.max(10, Math.round(cell * 1.05))}px ${MONO}`;
  let cursor = ox;
  for (const p of table) {
    const text = nickOf(p.id) + ' ' + ((p.cells / whole) * 100).toFixed(1) + '%';
    ctx.fillStyle = p.id === myId() ? '#f5f5f5' : seatInk(p.seat);
    ctx.globalAlpha = p.alive ? 1 : 0.4;
    ctx.fillText(text, cursor, oy - cell * 0.7);
    cursor += ctx.measureText(text + '   ').width;
  }
  ctx.globalAlpha = 1;

  ctx.textAlign = 'right';
  ctx.fillStyle = C.dim;
  ctx.fillText(boss() ? 'you run the board' : pingMs === null ? 'ping —' : 'ping ' + Math.round(pingMs) + ' ms',
               ox + W * cell, oy - cell * 0.7);

  ctx.textAlign = 'center';
  ctx.fillStyle = C.muted;
  ctx.fillText(note || (coarse
                 ? 'drag to steer — leave your patch, draw a loop, come back'
                 : 'arrows or wasd — leave your patch, draw a loop, come back'),
               ox + (W * cell) / 2, oy + H * cell + cell * 1.4);
}

// ── the hands ───────────────────────────────────────────────────────────────
const KEYS = {
  ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
  w: 0, d: 1, s: 2, a: 3,
};
addEventListener('keydown', (e) => {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const d = KEYS[key];
  if (d === undefined) return;
  e.preventDefault();
  steer(d);
});

// ── the thumbs ──────────────────────────────────────────────────────────────
// A phone has no arrow keys, so the four of them are said with a thumb: the
// touch that goes down is the middle of a stick, and whichever way it is
// dragged furthest is the way the head turns. The stick is wherever the finger
// lands rather than painted into a corner, because a hand holding a phone
// lands where it lands.
//
// The whole gesture is a drag, and on iOS that is not a preference: a finger
// held still is a long press, and the browser keeps that one for itself —
// inside a frame it selects what is under the thumb and hands the page a
// `pointercancel` in place of the gesture. Movement cancels the press before
// the browser can claim it.
//
// It reaches `steer()` and nothing else, so a head turned by a thumb is a head
// turned by the keys as far as the wire is concerned — including the guard
// there against saying the same direction twice.
//
// Only touches are read. A laptop with a touchscreen answers the coarse
// pointer query as loudly as a phone does, and on one of those every click on
// the board would otherwise plant a stick under the mouse.
const DEAD = 12;     // px of slack, so a resting thumb turns nothing
const REACHOUT = 46; // px at which the stick is all the way over
let stick = null;    // { pointerId, ox, oy, dx, dy }

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
  stick = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
  paintStick();
});
cv.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  stick.dx = e.clientX - stick.ox;
  stick.dy = e.clientY - stick.oy;
  paintStick();
  if (Math.hypot(stick.dx, stick.dy) < DEAD) return;
  // The furthest axis wins outright. A head that travels on a grid has four
  // ways to go and no fifth, so a diagonal has to be read as one of them
  // rather than as both by turns, which is a head that shakes in place.
  const d = Math.abs(stick.dx) > Math.abs(stick.dy)
    ? (stick.dx > 0 ? 1 : 3)
    : (stick.dy > 0 ? 2 : 0);
  steer(d);
});
// `pointercancel` as well as `pointerup`: a touch the browser takes away — a
// system gesture starting over the frame — never reports a release, and the
// stick would be left standing under no thumb, refusing the next one.
const lift = (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  // Letting go steers nothing: a head on this board keeps the way it was last
  // sent, and there is no standing still to fall back to.
  stick = null;
  paintStick();
};
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
// Heard on the window as well as on the canvas: a capture broken before it
// took hold sends the release somewhere else, and a stick left standing under
// no thumb refuses the next one.
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

// Drawn in the page rather than on the canvas: the board is the same picture
// for everybody in the room, and one screen's controls are not part of it.
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
  // The knob stops at the rim: past it the thumb is only saying the same
  // direction louder, and a turn has no louder to be said in.
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
requestAnimationFrame(frame);

room.send({ t: 'hello' });

console.log('paper.js up · host:', boss());
