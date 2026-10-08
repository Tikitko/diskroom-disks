/**
 * @disk     fission
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Chain reactions on a shared grid. Drop an orb into an empty cell or one of yours. A cell holding as many orbs as it has neighbours bursts into them and takes them over, and they may burst too. A new floor of holes every game. Last colour left wins.
 * @tags     game, strategy, turn-based, board, party
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/fission.png
 */
// fission.js — a chain-reaction board game, run by the host.
//
// Players take turns dropping one orb into a cell that is empty or already
// theirs. A cell is critical when it holds as many orbs as it has neighbours:
// it bursts, sends one orb into each neighbour and paints every one of them in
// the colour of whoever set it off, whatever colour it was before. A
// neighbour that fills up bursts in its turn, so one orb can sweep across a
// rival's ground. A player whose last cell is taken is out; the last colour on
// the board wins, or whoever holds the most orbs when the clock runs out.
// Every game is laid on a fresh floor with a few holes in it, and a hole
// changes how many neighbours the cells around it have, so where the cheap
// bursts are is different every time.
//
// The host is the authority. A move travels to the host alone, and counts only
// from the player whose turn it is, for the move on the table, into a legal
// cell; the host resolves the chain and broadcasts the board. Every copy plays
// the chain out on its own screen from the board before and the move, and
// shows it only when it lands on exactly the board the host sent. What this
// does not stop is a hostile host: it lays the floor, keeps the clock and
// resolves every chain, and nothing in a host-run game can take that from it.
// Nothing in this game is hidden, so there is nothing for it to read early.
//
// A player alone is dealt a practice game against two bots at once, and
// another after it, for as long as nobody else runs the disk. When somebody
// does, practice ends three seconds on under a note that says so, and the host
// deals the real game.

// ── rules ───────────────────────────────────────────────────────────────────

const MAX_SEATS = 8;
const OVER_MS = 7000;        // a finished game is on screen this long before the next
const PRACTICE_AGAIN = 5000; // and a finished practice game this long
const JOIN_MS = 3000;        // practice runs on this long after somebody joins
const GRACE = 8000;          // how long a dropped connection has to come back
const AWAY_MS = 1500;        // a turn whose player has dropped out waits this long
const PLACE_MS = 240;        // an orb dropping in, before the first burst
const MAX_WAVES = 400;       // a chain is cut off here whatever happens
const BOT_NAMES = ['Bot Curie', 'Bot Bohr'];

// A bigger table gets a bigger floor, a shorter turn and a longer clock, so a
// game stays a few minutes long however many sit down.
const dims = (n) => (n <= 2 ? [8, 6] : n <= 4 ? [9, 7] : n <= 6 ? [10, 7] : [11, 8]);
const turnMs = (n) => (n <= 3 ? 10000 : 8000);
const roundMs = (n) => 180000 + n * 20000;

// One colour per seat, in seat order, so no two players at a table share one.
const PAL = ['#ff6b7a', '#ffc94d', '#3fe0a6', '#4cbcff', '#b78cff', '#ff9a52', '#ff74c8', '#a6dc5c'];
const C = {
  bg0: '#1c2147', bg1: '#0c0f24', panel: 'rgba(15,19,42,0.94)', line: '#2f3870',
  cell: 'rgba(150,165,255,0.06)', link: 'rgba(150,165,255,0.16)', hole: 'rgba(4,6,16,0.7)',
  text: '#f2f0ff', dim: '#a9afd6', faint: '#666f9e', gold: '#ffd166', red: '#ff5d73',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ── the board ───────────────────────────────────────────────────────────────

// A cell is one integer: -1 is a hole, otherwise owner * 8 + orbs, where the
// owner is the seat index plus one and 0 means nobody.
const own = (v) => (v < 0 ? 0 : v >> 3);
const orbs = (v) => (v < 0 ? 0 : v & 7);
const cellOf = (o, n) => (n <= 0 ? 0 : o * 8 + Math.min(n, 7));

function neighbours(cols, rows, b, i) {
  const out = [];
  const x = i % cols, y = (i / cols) | 0;
  if (x > 0 && b[i - 1] >= 0) out.push(i - 1);
  if (x < cols - 1 && b[i + 1] >= 0) out.push(i + 1);
  if (y > 0 && b[i - cols] >= 0) out.push(i - cols);
  if (y < rows - 1 && b[i + cols] >= 0) out.push(i + cols);
  return out;
}

// Each cell's neighbours, worked out once per floor: how many there are is
// how many orbs the cell holds before it bursts.
let geoKey = '';
let geo = { cols: 0, rows: 0, nb: [], cap: [] };
function geometry(cols, rows, b) {
  let key = cols + 'x' + rows + ':';
  for (let i = 0; i < b.length; i++) if (b[i] < 0) key += i + ',';
  if (key === geoKey) return geo;
  geoKey = key;
  const nb = [], cap = [];
  for (let i = 0; i < cols * rows; i++) {
    nb.push(b[i] < 0 ? [] : neighbours(cols, rows, b, i));
    cap.push(nb[i].length);
  }
  geo = { cols, rows, nb, cap };
  return geo;
}

// One orb dropped by seat `who` into cell `c`, and the chain it sets off, in
// waves: every critical cell bursts at once, then the next wave is looked for.
// A chain stops when every orb on the board is the mover's, because a full
// board of one colour would otherwise burst for ever; whatever is still over
// its limit then is settled one orb short of bursting. `frames` holds the
// board before each wave and the cells that burst in it, for the screen.
function resolve(G, b0, c, who, keepFrames) {
  const b = b0.slice();
  const o = who + 1;
  b[c] = cellOf(o, orbs(b[c]) + 1);
  const frames = [];
  for (let w = 0; w < MAX_WAVES; w++) {
    const ex = [];
    for (let i = 0; i < b.length; i++) if (b[i] >= 0 && G.cap[i] > 0 && orbs(b[i]) >= G.cap[i]) ex.push(i);
    if (!ex.length) break;
    if (b.every((v) => v <= 0 || orbs(v) === 0 || own(v) === o)) {
      for (const i of ex) b[i] = cellOf(o, G.cap[i] - 1);
      break;
    }
    if (keepFrames) frames.push({ b: b.slice(), ex });
    const add = new Array(b.length).fill(0);
    for (const i of ex) {
      const left = orbs(b[i]) - G.cap[i];
      b[i] = cellOf(o, left);
      for (const n of G.nb[i]) add[n] += 1;
    }
    for (let i = 0; i < b.length; i++) if (add[i]) b[i] = cellOf(o, orbs(b[i]) + add[i]);
  }
  return { b, frames };
}

const legal = (b, c, who) => c >= 0 && c < b.length && b[c] >= 0 && (orbs(b[c]) === 0 || own(b[c]) === who + 1);
function tally(b, who) {
  let n = 0, cells = 0;
  for (const v of b) if (v > 0 && orbs(v) > 0 && own(v) === who + 1) { n += orbs(v); cells += 1; }
  return { n, cells };
}

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g      game number, so a stale move for an old game is recognised
//   ph     'wait' | 'play' | 'over'
//   cols, rows, b   the floor and every orb on it
//   seats  [{ id, out, mv }] — out once their last cell is taken, mv moves made
//   tn     the seat whose turn it is
//   seq    moves made this game, so a move is only ever for the board it saw
//   mv     the last move, [cell, seat], so every copy can play its chain out
//   win    the winner's id once the game is over, null for a draw
let S = blank();
let endAt = 0;           // local clock: when this turn ends
let lockUntil = 0;       // local clock: when the last chain has finished playing
let roundEnd = 0;        // local clock: when the game's clock runs out
let joinEnd = 0;         // local clock: when practice ends for somebody who joined, 0 if it does not
let overAt = -1e9;       // local clock: when the last game ended
let gotState = false;

function blank() {
  return { g: 0, ph: 'wait', cols: 0, rows: 0, b: [], seats: [], tn: 0, seq: 0, mv: null, win: null };
}

// The host's alone.
let lastPub = 0;
let shortAt = 0;         // when the table last fell below two players, 0 if it has not
let botAt = 0;
let awayAt = 0;          // when an absent player's turn started waiting
const here = new Set();  // ids that have said hello: their disk is running

// Mine.
let pending = null;      // { g, seq, c, at } — a move sent and not yet on the table
let lastHi = -1e9;
const nicks = new Map(); // id -> last nick seen, so a seat that left keeps a name

// `room.me` is null in the studio and on Run solo. The disk is its own host
// there and deals a practice game against bots.
const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const amHost = () => !room.me || (room.host !== null && room.host.id === room.me.id);
const fromHost = (from) => room.host !== null && from === room.host.id;
const inRoom = (id) => room.players.some((p) => p.id === id);
// Bots (ids below -1) sit only at a practice table the host dealt; -1 is me
// with no room around me.
const isBot = (id) => id < -1;
const present = (id) => (isBot(id) ? true : id === -1 ? solo() : inRoom(id));
const seatIndex = (id) => S.seats.findIndex((s) => s.id === id);
const mySeatIndex = () => seatIndex(myId());
const practiceTable = () => S.g > 0 && S.ph !== 'wait' && S.seats.some((s) => isBot(s.id));

function nickOf(id) {
  if (id === -1) return 'You';
  if (isBot(id)) return BOT_NAMES[(-id - 2) % BOT_NAMES.length];
  const p = room.players.find((x) => x.id === id);
  if (p) { nicks.set(id, p.nick); return p.nick; }
  return nicks.get(id) || 'Player';
}
const nameOf = (id) => nickOf(id) + (id === myId() && !solo() ? ' (you)' : '');
const colorOfSeat = (i) => (i >= 0 ? PAL[i % PAL.length] : C.dim);

// ── the host ────────────────────────────────────────────────────────────────

const running = () => (solo() ? 1 : room.players.filter((p) => p.id === myId() || here.has(p.id)).length);
// Alone: nobody else in the room, or nobody else's disk has said hello in the
// time a disk that is running would have.
const alone = (now) => running() < 2 && (solo() || room.players.length < 2 || now - startedAt > 4000);

// A floor with a few holes, laid symmetrically about the centre so no corner
// of the board is better than the one across from it. Every cell left keeps
// at least two neighbours and the floor stays in one piece: a cell with one
// neighbour could never hold an orb, and a floor in two pieces could keep a
// chain going in one of them for ever.
function makeFloor(cols, rows) {
  const N = cols * rows;
  for (let tries = 0; tries < 60; tries++) {
    const b = new Array(N).fill(0);
    const pairs = Math.round(N * 0.035) + Math.floor(Math.random() * 3);
    for (let k = 0; k < pairs; k++) {
      const i = Math.floor(Math.random() * N);
      b[i] = -1;
      b[N - 1 - i] = -1;
    }
    if (floorOk(cols, rows, b)) return b;
  }
  return new Array(N).fill(0);
}
function floorOk(cols, rows, b) {
  let start = -1, open = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] < 0) continue;
    open += 1;
    if (start < 0) start = i;
    if (neighbours(cols, rows, b, i).length < 2) return false;
  }
  if (start < 0) return false;
  const seen = new Set([start]);
  const todo = [start];
  while (todo.length) for (const n of neighbours(cols, rows, b, todo.pop())) if (!seen.has(n)) { seen.add(n); todo.push(n); }
  return seen.size === open;
}

function hostDeal(force) {
  const now = performance.now();
  if (!amHost()) return;
  if (!force && !(S.ph === 'wait' || S.ph === 'over')) return;
  joinEnd = 0;
  let ids = solo() ? [-1] : room.players.filter((p) => p.id === myId() || here.has(p.id)).slice(0, MAX_SEATS).map((p) => p.id);
  // Fewer than two people is a practice table: the host is dealt two bots.
  if (ids.length < 2) ids = ids.concat([-2, -3]);
  const [cols, rows] = dims(ids.length);
  S = blank();
  S.g = Math.floor(Math.random() * 1e9) + 1;
  S.ph = 'play';
  S.cols = cols;
  S.rows = rows;
  S.b = makeFloor(cols, rows);
  S.seats = ids.map((id) => ({ id, out: 0, mv: 0 }));
  S.tn = Math.floor(Math.random() * ids.length);
  shortAt = 0;
  awayAt = 0;
  lockUntil = now;
  roundEnd = now + roundMs(ids.length);
  startTurn(now);
}

function startTurn(now) {
  const from = Math.max(now, lockUntil);
  endAt = from + turnMs(S.seats.length);
  botAt = from + 700 + Math.random() * 1100;
  awayAt = 0;
  publish(now);
}

function nextSeat(i) {
  const n = S.seats.length;
  for (let j = 1; j <= n; j++) if (!S.seats[(i + j) % n].out) return (i + j) % n;
  return i;
}

// How long a chain of `waves` takes on screen: the longer the chain, the
// quicker each wave, so a huge one never holds the table up for long.
const waveMs = (waves) => Math.min(170, 2400 / Math.max(1, waves));
const animMs = (waves) => PLACE_MS + waves * waveMs(waves) + 120;

// A move, from whoever the room says sent it. It counts only during a game,
// once the last chain has played out, from the player whose turn it is, into
// a cell that is empty or theirs.
function hostPut(id, c, now) {
  if (S.ph !== 'play' || now < lockUntil) return;
  const i = S.tn;
  const s = S.seats[i];
  if (!s || s.id !== id || s.out || !legal(S.b, c, i)) return;
  const G = geometry(S.cols, S.rows, S.b);
  const r = resolve(G, S.b, c, i, true);
  S.b = r.b;
  s.mv += 1;
  S.seq += 1;
  S.mv = [c, i];
  lockUntil = now + animMs(r.frames.length);
  settle(now);
}

// After a move, or after a seat was skipped: whoever has no cell left is out
// — once they have moved, or if they are gone — and the game ends when one
// colour is left or the clock has run out.
function settle(now) {
  S.seats.forEach((s, i) => {
    if (!s.out && tally(S.b, i).cells === 0 && (s.mv > 0 || !present(s.id))) s.out = 1;
  });
  const live = S.seats.filter((s) => !s.out);
  if (live.length <= 1) { finish(now, live.length ? live[0].id : null); return; }
  if (now >= roundEnd) { finish(now, leader()); return; }
  S.tn = nextSeat(S.tn);
  startTurn(now);
}

// Whoever holds the most orbs, then the most cells; null when that is a tie.
function leader() {
  let best = null, bn = -1, bc = -1, tie = false;
  S.seats.forEach((s, i) => {
    if (s.out) return;
    const t = tally(S.b, i);
    if (t.n > bn || (t.n === bn && t.cells > bc)) { best = s.id; bn = t.n; bc = t.cells; tie = false; }
    else if (t.n === bn && t.cells === bc) tie = true;
  });
  return tie ? null : best;
}

function finish(now, win) {
  S.ph = 'over';
  S.win = win;
  overAt = Math.max(now, lockUntil);
  endAt = overAt;
  publish(now);
}

// A bot looks one move ahead: what it would hold, what the others would, and
// how much of its own it leaves next to a rival's cell about to burst. It
// thinks for a moment first, and now and then it does not pick its best.
function botPick(i, sloppy) {
  const G = geometry(S.cols, S.rows, S.b);
  const filled = S.b.filter((v) => v > 0 && orbs(v) > 0).length;
  const opts = [];
  for (let c = 0; c < S.b.length; c++) {
    if (!legal(S.b, c, i)) continue;
    const r = resolve(G, S.b, c, i, false);
    let me = 0, mine = 0, them = 0;
    for (const v of r.b) {
      if (v <= 0 || orbs(v) === 0) continue;
      if (own(v) === i + 1) { me += orbs(v); mine += 1; } else them += orbs(v);
    }
    let score = me + mine * 0.6 - them * 0.9;
    if (them === 0 && S.seats.every((s, j) => j === i || s.out || s.mv > 0)) score += 1e4;
    for (let x = 0; x < r.b.length; x++) {
      if (own(r.b[x]) !== i + 1 || orbs(r.b[x]) === 0) continue;
      for (const n of G.nb[x]) {
        const v = r.b[n];
        if (v > 0 && own(v) !== i + 1 && orbs(v) === G.cap[n] - 1 && orbs(r.b[x]) < G.cap[x] - 1) {
          score -= (orbs(r.b[x]) + 1) * 1.4;
          break;
        }
      }
    }
    if (filled < S.b.length * 0.25 && G.cap[c] === 2) score += 1.2;
    opts.push({ c, score: score + Math.random() * 0.8 });
  }
  if (!opts.length) return -1;
  opts.sort((a, b) => b.score - a.score);
  const roll = Math.random();
  if (sloppy || roll < 0.08) return opts[Math.floor(Math.random() * opts.length)].c;
  if (roll < 0.3) return opts[Math.min(opts.length - 1, 1 + Math.floor(Math.random() * 3))].c;
  return opts[0].c;
}

// A table with fewer than two people in it is over — but not on the instant:
// a dropped connection comes back as a leave and a join, and one blip must
// not end everybody's game.
function tooFew(now) {
  const live = S.seats.filter((s) => !s.out && present(s.id));
  if (live.length >= 2 && live.some((s) => !isBot(s.id))) { shortAt = 0; return false; }
  if (!shortAt) shortAt = now;
  return now - shortAt > GRACE;
}

function hostTick(now) {
  if (!amHost()) return;
  // Alone, a practice game is dealt at once, and the next when it is over.
  if (alone(now) && (S.ph === 'wait' || (S.ph === 'over' && now - overAt >= PRACTICE_AGAIN))) { hostDeal(); return; }
  // Somebody joined a practice game: it ends three seconds on, for the real one.
  if (running() >= 2 && practiceTable()) {
    if (!joinEnd) { joinEnd = now + JOIN_MS; publish(now); }
    else if (now >= joinEnd) { hostDeal(true); return; }
  } else if (joinEnd) { joinEnd = 0; publish(now); }
  // Two or more people: a game is dealt at once, and the next one when the
  // last has been on screen long enough to read.
  if (running() >= 2 && !practiceTable() && (S.ph === 'wait' || (S.ph === 'over' && now - overAt >= OVER_MS))) { hostDeal(); return; }
  if (S.ph === 'play' && now >= lockUntil) {
    if (now >= roundEnd) { finish(now, leader()); return; }
    if (tooFew(now)) {
      const live = S.seats.filter((s) => !s.out && present(s.id));
      finish(now, live.length === 1 ? live[0].id : leader());
      return;
    }
    const s = S.seats[S.tn];
    if (!s || s.out) { S.tn = nextSeat(S.tn); startTurn(now); return; }
    if (isBot(s.id)) {
      if (now >= botAt) {
        const c = botPick(S.tn, false);
        if (c < 0) settle(now);
        else hostPut(s.id, c, now);
      }
    } else if (!present(s.id)) {
      // Somebody whose connection dropped misses the turn, not the game.
      if (!awayAt) awayAt = now;
      else if (now - awayAt > AWAY_MS) settle(now);
    } else if (now >= endAt) {
      // A turn that runs out plays itself, and not well.
      const c = botPick(S.tn, true);
      if (c < 0) settle(now);
      else hostPut(s.id, c, now);
    }
  }
  // A heartbeat, so one lost broadcast is never the only thing that carried a
  // change, and a clock that drifted is put back.
  if (S.g > 0 && now - lastPub > 2500) publish(now);
}

function wire(now, withMove) {
  return {
    t: 'st', g: S.g, ph: S.ph, cols: S.cols, rows: S.rows, b: S.b,
    seats: S.seats.map((s) => [s.id, s.out, s.mv]),
    tn: S.tn, seq: S.seq, mv: withMove ? S.mv : null, win: S.win,
    ms: Math.max(0, Math.round(endAt - now)),
    a: Math.max(0, Math.round(lockUntil - now)),
    rm: Math.max(0, Math.round(roundEnd - now)),
    j: joinEnd ? Math.max(0, Math.round(joinEnd - now)) : -1,
  };
}

function publish(now) {
  lastPub = now;
  if (!solo()) room.send(wire(now, true));
  observe(now);
}

// ── receiving ───────────────────────────────────────────────────────────────

// A table off the wire is a claim and is read as one: the right shape, numbers
// in range, lists of bounded length, ids that are seated. Anything else is
// dropped whole.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID_MIN = -8, ID_MAX = 2147483647;
const ms = (v, hi) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, hi) : null);

function stateOf(m) {
  if (!int(m.g, 1, 1e9 + 1) || !['play', 'over'].includes(m.ph)) return null;
  if (!int(m.cols, 4, 12) || !int(m.rows, 4, 10)) return null;
  const N = m.cols * m.rows;
  if (!Array.isArray(m.seats) || m.seats.length < 1 || m.seats.length > MAX_SEATS) return null;
  const seats = [];
  for (const r of m.seats) {
    if (!Array.isArray(r) || r.length !== 3) return null;
    const [id, out, mv] = r;
    if (!int(id, ID_MIN, ID_MAX) || !int(out, 0, 1) || !int(mv, 0, 100000)) return null;
    if (seats.some((s) => s.id === id)) return null;
    seats.push({ id, out, mv });
  }
  if (!Array.isArray(m.b) || m.b.length !== N) return null;
  for (const v of m.b) if (!int(v, -1, 71) || own(v) > seats.length) return null;
  if (!int(m.tn, 0, seats.length - 1) || !int(m.seq, 0, 1e6)) return null;
  let mv = null;
  if (m.mv !== null && m.mv !== undefined) {
    if (!Array.isArray(m.mv) || m.mv.length !== 2 || !int(m.mv[0], 0, N - 1) || !int(m.mv[1], 0, seats.length - 1)) return null;
    mv = [m.mv[0], m.mv[1]];
  }
  if (!(m.win === null || (int(m.win, ID_MIN, ID_MAX) && seats.some((s) => s.id === m.win)))) return null;
  const t = ms(m.ms, 20000), a = ms(m.a, 5000), rm = ms(m.rm, 400000);
  if (t === null || a === null || rm === null) return null;
  return {
    S: { g: m.g, ph: m.ph, cols: m.cols, rows: m.rows, b: m.b.slice(), seats, tn: m.tn, seq: m.seq, mv, win: m.win },
    ms: t, a, rm,
    j: typeof m.j === 'number' && Number.isFinite(m.j) && m.j >= 0 ? Math.min(m.j, JOIN_MS) : -1,
  };
}

// Every sender gets a bucket: ten messages a second, twenty at once. An honest
// copy sends a few a turn; one that floods is dropped here before any of its
// messages is even read, so it cannot stall the table for the rest.
const buckets = new Map();
const hiAt = new Map();
function allow(from, now) {
  let b = buckets.get(from);
  if (!b) { b = { tok: 20, at: now }; buckets.set(from, b); }
  b.tok = Math.min(20, b.tok + (now - b.at) * 0.01);
  b.at = now;
  if (b.tok < 1) return false;
  b.tok -= 1;
  return true;
}

room.on('message', (from, msg) => {
  try {
    const now = performance.now();
    if (!Number.isInteger(from) || from === myId() || !allow(from, now)) return;
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    switch (msg.t) {
      // A disk that has just started says so to everyone, so whoever is host
      // now or later knows it is running; the host answers that seat alone.
      case 'hi':
        if (!inRoom(from)) break;
        here.add(from);
        // One answer a second to any one seat, however often it asks.
        if (amHost() && S.g > 0 && now - (hiAt.get(from) || -1e9) > 1000) {
          hiAt.set(from, now);
          room.send(wire(now, false), { to: from });
        }
        break;
      case 'put':
        if (!amHost() || !inRoom(from) || msg.g !== S.g || msg.s !== S.seq || !int(msg.c, 0, S.b.length - 1)) break;
        here.add(from);
        hostPut(from, msg.c, now);
        break;
      case 'st': {
        if (amHost() || !fromHost(from)) break;
        const st = stateOf(msg);
        if (!st) break;
        const wasOver = S.g === st.S.g && S.ph === 'over';
        S = st.S;
        gotState = true;
        endAt = now + st.ms;
        lockUntil = now + st.a;
        roundEnd = now + st.rm;
        joinEnd = st.j >= 0 ? now + st.j : 0;
        // Whoever sits at a table the host dealt is running the disk, and a
        // later host must know that without having heard them say so.
        for (const s of S.seats) if (inRoom(s.id) && s.id !== myId()) here.add(s.id);
        if (S.ph === 'over' && !wasOver) overAt = now + st.a;
        observe(now);
        break;
      }
    }
  } catch (e) {
    // A message that breaks this handler is the sender's problem, never the table's.
  }
});

room.on('join', (p) => { nicks.set(p.id, p.nick); });

room.on('leave', (p) => {
  nicks.set(p.id, p.nick);
  buckets.delete(p.id);
  hiAt.delete(p.id);
  here.delete(p.id);
});

room.on('hostchange', () => {
  if (!amHost() || S.g === 0) return;
  // The new host has the board as last broadcast. The turn on the table is
  // played again on a fresh clock; nobody loses anything for it.
  const now = performance.now();
  if (S.ph === 'play') startTurn(now);
  else publish(now);
});

// ── my moves ────────────────────────────────────────────────────────────────

const myTurn = () => S.ph === 'play' && S.seats[S.tn] && S.seats[S.tn].id === myId() && !S.seats[S.tn].out;
const canPut = (now) => myTurn() && now >= lockUntil && !(pending && pending.g === S.g && pending.seq === S.seq && now - pending.at < 1200);

function tryPut(c) {
  const now = performance.now();
  if (!canPut(now)) return;
  if (!legal(S.b, c, S.tn)) { sfx.deny(); denyAt = now; denyCell = c; return; }
  pending = { g: S.g, seq: S.seq, c, at: now };
  if (amHost()) hostPut(myId(), c, now);
  else if (room.host) room.send({ t: 'put', g: S.g, s: S.seq, c }, { to: room.host.id });
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects come from the table as it changes on this screen, never from the
// wire: a chain is played out here from the board before and the move.
let shown = { g: 0, seq: -1, b: [] };
let anim = null;         // { start, wm, frames, final, cell, who, fired, gain, landed }
let seenOut = '';
let seenPh = '';
let turnChimeKey = '';
let lastTick = -1;
let denyAt = -1e9, denyCell = -1;

function observe(now) {
  if (S.g !== shown.g) {
    anim = null;
    shown = { g: S.g, seq: S.seq, b: S.b.slice() };
    sfx.start();
  } else if (S.seq !== shown.seq) {
    anim = null;
    if (S.seq === shown.seq + 1 && S.mv && shown.b.length === S.b.length) {
      const G = geometry(S.cols, S.rows, S.b);
      const r = resolve(G, shown.b, S.mv[0], S.mv[1], true);
      if (r.b.every((v, i) => v === S.b[i])) {
        let gain = 0;
        for (let i = 0; i < r.b.length; i++) {
          const was = shown.b[i];
          if (was > 0 && orbs(was) > 0 && own(was) !== S.mv[1] + 1 && own(r.b[i]) === S.mv[1] + 1) gain += 1;
        }
        anim = { start: now, wm: waveMs(r.frames.length), frames: r.frames, final: S.b.slice(), cell: S.mv[0], who: S.mv[1], fired: -1, gain, landed: false };
        sfx.place();
        const P = cellCentre(S.mv[0]);
        if (P) burst(P.x, P.y, colorOfSeat(S.mv[1]), 6, 70);
      }
    }
    shown = { g: S.g, seq: S.seq, b: S.b.slice() };
  }
  const outKey = S.g + ':' + S.seats.map((s) => s.out).join('');
  if (outKey !== seenOut) {
    const was = seenOut;
    seenOut = outKey;
    if (was && was.split(':')[0] === String(S.g) && outKey.split(':')[1].includes('1')) pendingOut = true;
  }
  const ph = S.g + ':' + S.ph;
  if (ph !== seenPh) {
    seenPh = ph;
    if (S.ph === 'over') celebrated = false;
  }
  if (pending && (pending.g !== S.g || pending.seq !== S.seq)) pending = null;
}
let pendingOut = false;
let celebrated = true;

// The chain plays out over time; each wave's flash, sound and shake fire as
// the screen reaches it.
function stepAnim(now) {
  if (!anim) return;
  const t = now - anim.start - PLACE_MS;
  const k = t < 0 ? -1 : Math.floor(t / anim.wm);
  while (anim.fired < Math.min(k, anim.frames.length - 1)) {
    anim.fired += 1;
    const f = anim.frames[anim.fired];
    const col = colorOfSeat(anim.who);
    for (const i of f.ex) {
      const P = cellCentre(i);
      if (P) burst(P.x, P.y, col, 5, 150);
    }
    sfx.pop(anim.fired);
    shake = Math.min(9, shake + 1 + f.ex.length * 0.8);
  }
  if (!anim.landed && k >= anim.frames.length) {
    anim.landed = true;
    if (anim.gain > 0) {
      const P = cellCentre(anim.cell);
      if (P) pop(P.x, P.y - 10, '+' + anim.gain, colorOfSeat(anim.who));
      sfx.take(anim.gain);
    }
  }
}

function boardNow(now) {
  if (!anim) return { b: S.b, k: -1, p: 0 };
  const t = now - anim.start - PLACE_MS;
  if (t < 0) return { b: anim.frames.length ? anim.frames[0].b : anim.final, k: -1, p: 0, drop: clamp((t + PLACE_MS) / PLACE_MS, 0, 1) };
  const k = Math.floor(t / anim.wm);
  if (k >= anim.frames.length) return { b: anim.final, k: -1, p: 0 };
  return { b: anim.frames[k].b, k, p: (t - k * anim.wm) / anim.wm };
}

function sideEffects(now) {
  const busy = now < lockUntil;
  if (!busy && pendingOut) {
    pendingOut = false;
    sfx.out();
    shake = Math.min(10, shake + 6);
  }
  if (S.ph === 'over' && !busy && !celebrated) {
    celebrated = true;
    celebrate();
  }
  // A chime when my turn comes round, once the chain before it has played.
  const key = S.g + ':' + S.seq + ':' + S.tn;
  if (myTurn() && !busy && turnChimeKey !== key) { turnChimeKey = key; sfx.turn(); }
  if (myTurn() && !busy) {
    const left = Math.ceil((endAt - now) / 1000);
    if (left <= 3 && left >= 1 && left !== lastTick) { lastTick = left; sfx.tick(); }
  }
}

// ── sound ───────────────────────────────────────────────────────────────────

let ac = null;
let muted = false;
function audio() {
  try {
    if (!ac) {
      const A = window.AudioContext || window.webkitAudioContext;
      if (A) ac = new A();
    }
    if (ac && ac.state === 'suspended') ac.resume();
  } catch (e) { ac = null; }
}
function tone(f, d, type, v, f2, delay) {
  if (muted || !ac) return;
  try {
    const t = ac.currentTime + (delay || 0);
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v || 0.08, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t);
    o.stop(t + d + 0.03);
  } catch (e) { /* a sound is never worth an error */ }
}
const sfx = {
  place: () => { tone(480, 0.08, 'triangle', 0.07, 760); },
  pop: (k) => { tone(220 + Math.min(k, 24) * 34, 0.11, 'square', 0.035, 110 + Math.min(k, 24) * 20); tone(900 + Math.min(k, 24) * 50, 0.05, 'sine', 0.03); },
  take: (n) => [660, 880, 1100].slice(0, Math.min(3, 1 + (n >> 2))).forEach((f, i) => tone(f, 0.12, 'triangle', 0.05, null, i * 0.06)),
  turn: () => { tone(740, 0.09, 'sine', 0.06); tone(990, 0.12, 'sine', 0.05, null, 0.08); },
  tick: () => tone(1200, 0.03, 'square', 0.03),
  deny: () => tone(150, 0.12, 'sawtooth', 0.04, 110),
  out: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.18, 'sawtooth', 0.04, null, i * 0.08)),
  start: () => [330, 494, 659].forEach((f, i) => tone(f, 0.12, 'triangle', 0.05, null, i * 0.07)),
  fanfare: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'triangle', 0.06, null, i * 0.1)),
};

// ── the screen ──────────────────────────────────────────────────────────────

document.documentElement.style.cssText = 'height:100%;background:' + C.bg1;
document.body.style.cssText =
  'margin:0;height:100%;overflow:hidden;background:' + C.bg1 + ';touch-action:none;' +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none';
const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

let W = 640, H = 480;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  W = cv.clientWidth || window.innerWidth || 640;
  H = cv.clientHeight || window.innerHeight || 480;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
layout();
window.addEventListener('resize', layout);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); };
const easeInOut = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2; };
const back = (t) => { t = clamp(t, 0, 1); const k = 1.7; return 1 + (k + 1) * (t - 1) ** 3 + k * (t - 1) ** 2; };

function rr(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function font(size, weight) { ctx.font = (weight || 600) + ' ' + Math.round(size) + 'px ' + FONT; }
function text(s, x, y, size, color, align, weight, maxW) {
  font(size, weight);
  if (maxW) {
    const w = ctx.measureText(s).width;
    if (w > maxW) font(Math.max(8, size * maxW / w), weight);
  }
  ctx.fillStyle = color;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}
// A nick is at most 16 characters, but a long one in a narrow row is cut
// rather than shrunk to nothing.
function clip(s, size, maxW) {
  font(size, 600);
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

// ── effects ─────────────────────────────────────────────────────────────────

const parts = [];
const pops = [];
let shake = 0;

function burst(x, y, color, n, speed) {
  for (let i = 0; i < n && parts.length < 400; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.8);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: 1.4 + Math.random() * 1.2, color, r: 1.5 + Math.random() * 2.5 });
  }
}
function pop(x, y, s, color) { pops.push({ x, y, s, color, t: 0 }); }

function celebrate() {
  sfx.fanfare();
  const i = seatIndex(S.win);
  const color = i >= 0 ? colorOfSeat(i) : C.gold;
  for (let k = 0; k < 6; k++) burst(W * (0.15 + 0.7 * Math.random()), H * (0.2 + 0.4 * Math.random()), k % 2 ? color : C.gold, 24, 240);
}

// Particles and pops move by the elapsed time, not by the frame, so a slow or
// fast screen shows the same motion.
function stepFx(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.vx *= 1 - 2.2 * dt;
    p.vy *= 1 - 2.2 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= p.decay * dt;
    if (p.life <= 0) parts.splice(i, 1);
  }
  for (let i = pops.length - 1; i >= 0; i--) {
    pops[i].t += dt;
    if (pops[i].t > 1.3) pops.splice(i, 1);
  }
  shake = Math.max(0, shake - 28 * dt);
}

// ── layout of the table ─────────────────────────────────────────────────────

const PAD = 12;
const TOP = 44;
const STATUS_H = 40;
const NOTE_ROOM = 60;
let btns = [];
let L = null;            // this frame's layout
let cursor = -1;         // the cell a key or a finger points at
let hoverCell = -1;
let drag = false;
let press = '';

function computeLayout() {
  const n = Math.max(1, S.seats.length);
  const wide = W >= H * 1.1 && W >= 420;
  const panelW = wide ? clamp(Math.round(W * 0.25), 124, 210) : 0;
  let chipCols = 0, chipRows = 0, chipsH = 0;
  if (!wide) {
    chipCols = Math.min(n, W < 380 ? 2 : W < 560 ? 3 : 4);
    chipRows = Math.ceil(n / chipCols);
    chipsH = chipRows * 30 + 6;
  }
  const noteRoom = practiceTable() ? NOTE_ROOM : 0;
  const fx = PAD, fy = TOP + chipsH;
  const fw = W - 2 * PAD - (panelW ? panelW + PAD : 0);
  const fh = Math.max(40, H - fy - STATUS_H - noteRoom - 6);
  const cols = Math.max(1, S.cols), rows = Math.max(1, S.rows);
  const cs = Math.max(8, Math.floor(Math.min(fw / cols, fh / rows)));
  const gx = Math.round(fx + (fw - cs * cols) / 2);
  const gy = Math.round(fy + (fh - cs * rows) / 2);
  L = { wide, panelW, chipCols, chipRows, chipsH, fx, fy, fw, fh, cs, gx, gy, cols, rows };
}

function cellCentre(i) {
  if (!L || !S.cols) return null;
  const x = i % S.cols, y = (i / S.cols) | 0;
  return { x: L.gx + (x + 0.5) * L.cs, y: L.gy + (y + 0.5) * L.cs };
}
function cellAt(p) {
  if (!L || !S.cols) return -1;
  const x = Math.floor((p.x - L.gx) / L.cs), y = Math.floor((p.y - L.gy) / L.cs);
  if (x < 0 || y < 0 || x >= S.cols || y >= S.rows) return -1;
  return y * S.cols + x;
}

// ── drawing pieces ──────────────────────────────────────────────────────────

function drawBackground(now) {
  const g = ctx.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.5, Math.max(W, H) * 0.8);
  g.addColorStop(0, C.bg0);
  g.addColorStop(1, C.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Faint rings drifting outward, like a cloud chamber, so the backdrop is
  // never a flat colour.
  ctx.strokeStyle = 'rgba(140,155,255,0.05)';
  ctx.lineWidth = 1;
  const R = Math.max(W, H);
  const off = (now * 0.012) % 46;
  ctx.beginPath();
  for (let r = off; r < R; r += 46) { ctx.moveTo(W / 2 + r, H * 0.5); ctx.arc(W / 2, H * 0.5, r, 0, Math.PI * 2); }
  ctx.stroke();
}

// The orbs in one cell: one sits still, two and three circle each other, and
// the faster they spin the closer the cell is to bursting.
function drawOrbs(x, y, cs, n, cap, color, now, seed, scale) {
  if (n <= 0) return;
  const crit = cap > 0 && n >= cap - 1;
  const r = cs * 0.15 * (scale || 1);
  const spin = crit ? 3.4 : 0.9;
  const a0 = now / 1000 * spin + seed * 1.7;
  const jit = crit ? Math.sin(now / 45 + seed) * cs * 0.015 : 0;
  if (crit) {
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.15 * Math.sin(now / 120 + seed);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, cs * 0.38, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const pos = [];
  if (n === 1) pos.push([0, 0]);
  else {
    const rad = n === 2 ? cs * 0.15 : cs * 0.18;
    for (let k = 0; k < Math.min(n, 4); k++) {
      const a = a0 + k * Math.PI * 2 / Math.min(n, 4);
      pos.push([Math.cos(a) * rad, Math.sin(a) * rad]);
    }
  }
  for (const [dx, dy] of pos) {
    const px = x + dx + jit, py = y + dy;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(px - r * 0.32, py - r * 0.32, r * 0.36, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBoard(now) {
  if (!S.cols) return;
  const { cs, gx, gy } = L;
  const G = geometry(S.cols, S.rows, S.b);
  const view = boardNow(now);
  const b = view.b;
  const gap = Math.max(2, cs * 0.09);
  const exploding = view.k >= 0 ? new Set(anim.frames[view.k].ex) : null;
  const my = mySeatIndex();
  const live = canPut(now);
  // Links between neighbours: the number of links a cell has is how many orbs
  // it holds before it bursts.
  ctx.fillStyle = C.link;
  for (let i = 0; i < b.length; i++) {
    if (b[i] < 0) continue;
    const x = i % S.cols, y = (i / S.cols) | 0;
    const cx = gx + x * cs, cy = gy + y * cs;
    if (x < S.cols - 1 && b[i + 1] >= 0) ctx.fillRect(cx + cs - gap, cy + cs * 0.42, gap * 2, cs * 0.16);
    if (y < S.rows - 1 && b[i + S.cols] >= 0) ctx.fillRect(cx + cs * 0.42, cy + cs - gap, cs * 0.16, gap * 2);
  }
  for (let i = 0; i < b.length; i++) {
    const x = i % S.cols, y = (i / S.cols) | 0;
    const cx = gx + x * cs + gap / 2, cy = gy + y * cs + gap / 2, w = cs - gap;
    if (b[i] < 0) {
      rr(cx + w * 0.12, cy + w * 0.12, w * 0.76, w * 0.76, w * 0.2);
      ctx.fillStyle = C.hole;
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,165,255,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
      continue;
    }
    const o = own(b[i]) - 1;
    let n = orbs(b[i]);
    if (exploding && exploding.has(i)) n = Math.max(0, n - G.cap[i]);
    rr(cx, cy, w, w, w * 0.22);
    ctx.fillStyle = n > 0 && o >= 0 ? alpha(colorOfSeat(o), 0.13) : C.cell;
    ctx.fill();
    if (exploding && exploding.has(i)) {
      ctx.fillStyle = 'rgba(255,255,255,' + (0.35 * (1 - view.p)) + ')';
      ctx.fill();
    }
    // My cells, and the empty ones, are where I may play.
    if (live && (n === 0 || o === my)) {
      ctx.strokeStyle = alpha(colorOfSeat(my), 0.22 + 0.1 * Math.sin(now / 300));
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    // Pips under the orbs: how full the cell is out of how much it holds.
    const cap = G.cap[i];
    const pr = Math.max(1.2, cs * 0.032);
    const span = (cap - 1) * pr * 3;
    for (let k = 0; k < cap; k++) {
      ctx.fillStyle = k < n && o >= 0 ? alpha(colorOfSeat(o), 0.9) : 'rgba(170,180,230,0.18)';
      ctx.beginPath();
      ctx.arc(cx + w / 2 - span / 2 + k * pr * 3, cy + w - pr * 2.6, pr, 0, Math.PI * 2);
      ctx.fill();
    }
    let scale = 1;
    if (anim && view.drop !== undefined && i === anim.cell) scale = 0.6 + 0.4 * back(view.drop);
    if (n > 0 && o >= 0) drawOrbs(cx + w / 2, cy + w / 2 - cs * 0.04, cs, n, cap, colorOfSeat(o), now, i, scale);
  }
  // The last move, ringed for a moment.
  if (S.mv && !anim) {
    const P = cellCentre(S.mv[0]);
    if (P) {
      ctx.strokeStyle = alpha(colorOfSeat(S.mv[1]), 0.55);
      ctx.lineWidth = 2;
      rr(P.x - cs / 2 + gap / 2, P.y - cs / 2 + gap / 2, cs - gap, cs - gap, (cs - gap) * 0.22);
      ctx.stroke();
    }
  }
  // Orbs in flight from the cells bursting this wave.
  if (view.k >= 0) {
    const f = anim.frames[view.k];
    const col = colorOfSeat(anim.who);
    const e = easeInOut(view.p);
    for (const i of f.ex) {
      const A = cellCentre(i);
      for (const nb of G.nb[i]) {
        const B = cellCentre(nb);
        const px = A.x + (B.x - A.x) * e, py = A.y + (B.y - A.y) * e - Math.sin(e * Math.PI) * cs * 0.12;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(px, py, cs * 0.13, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.beginPath();
        ctx.arc(px - cs * 0.04, py - cs * 0.04, cs * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // Where a key or a finger points, and a red flash where a move was refused.
  const at = drag || cursor >= 0 ? cursor : hoverCell;
  if (at >= 0 && at < b.length && myTurn()) {
    const P = cellCentre(at);
    const ok = legal(S.b, at, S.tn);
    ctx.strokeStyle = ok ? colorOfSeat(my) : 'rgba(255,93,115,0.7)';
    ctx.lineWidth = 2.5;
    rr(P.x - cs / 2 + gap / 2 - 1, P.y - cs / 2 + gap / 2 - 1, cs - gap + 2, cs - gap + 2, (cs - gap) * 0.24);
    ctx.stroke();
  }
  if (now - denyAt < 400 && denyCell >= 0) {
    const P = cellCentre(denyCell);
    const k = 1 - (now - denyAt) / 400;
    ctx.fillStyle = 'rgba(255,93,115,' + 0.35 * k + ')';
    rr(P.x - cs / 2 + gap / 2, P.y - cs / 2 + gap / 2, cs - gap, cs - gap, (cs - gap) * 0.22);
    ctx.fill();
  }
}

function button(id, label, x, y, w, h) {
  const pressed = press === id;
  rr(x, y + (pressed ? 2 : 0), w, h, h / 2);
  ctx.fillStyle = C.gold;
  ctx.fill();
  text(label, x + w / 2, y + h / 2 + (pressed ? 2 : 0), Math.min(16, h * 0.42), '#2a2108', 'center', 800, w - 20);
  btns.push({ id, x, y, w, h });
}

function drawMute() {
  const s = 30, x = W - PAD - s, y = 7;
  ctx.save();
  rr(x, y, s, s, s / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fill();
  ctx.fillStyle = muted ? C.faint : C.dim;
  ctx.beginPath();
  ctx.moveTo(x + 8, y + 12); ctx.lineTo(x + 12, y + 12); ctx.lineTo(x + 17, y + 8);
  ctx.lineTo(x + 17, y + 22); ctx.lineTo(x + 12, y + 18); ctx.lineTo(x + 8, y + 18);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = muted ? C.red : C.dim;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (muted) { ctx.moveTo(x + 19, y + 11); ctx.lineTo(x + 25, y + 19); ctx.moveTo(x + 25, y + 11); ctx.lineTo(x + 19, y + 19); }
  else { ctx.arc(x + 17, y + 15, 5, -0.9, 0.9); ctx.moveTo(x + 23.5, y + 9.5); ctx.arc(x + 17, y + 15, 8.5, -0.85, 0.85); }
  ctx.stroke();
  ctx.restore();
  btns.push({ id: 'mute', x: x - 6, y: y - 6, w: s + 12, h: s + 12 });
}

function drawTopBar(now) {
  // A small atom beside the name.
  const ax = PAD + 12, ay = 22;
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 1.4;
  for (let k = 0; k < 3; k++) {
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(k * Math.PI / 3 + now / 4000);
    ctx.beginPath();
    ctx.ellipse(0, 0, 10, 4, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = C.gold;
  ctx.beginPath();
  ctx.arc(ax, ay, 2.6, 0, Math.PI * 2);
  ctx.fill();
  text('FISSION', ax + 20, ay, 17, C.text, 'left', 900);
  if (S.ph === 'play') {
    const left = Math.max(0, Math.ceil((roundEnd - now) / 1000));
    const s = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    const warn = left <= 20;
    text(s, W / 2, ay, 16, warn ? C.red : C.dim, 'center', 800);
  }
  drawMute();
}

// Who is playing: their colour, their name, their orbs, whose turn it is and
// how long it has left.
function drawSeats(now) {
  const n = S.seats.length;
  if (!n) return;
  const rects = [];
  if (L.wide) {
    const x = W - PAD - L.panelW;
    const rh = clamp(Math.floor((H - TOP - STATUS_H - 10) / n), 30, 46);
    S.seats.forEach((s, i) => rects.push({ x, y: TOP + 4 + i * rh, w: L.panelW, h: rh - 6 }));
  } else {
    const cw = (W - 2 * PAD - (L.chipCols - 1) * 6) / L.chipCols;
    S.seats.forEach((s, i) => {
      const r = Math.floor(i / L.chipCols), c = i % L.chipCols;
      rects.push({ x: PAD + c * (cw + 6), y: TOP + r * 30, w: cw, h: 26 });
    });
  }
  const turnLeft = clamp((endAt - Math.max(now, lockUntil)) / turnMs(n), 0, 1);
  S.seats.forEach((s, i) => {
    const r = rects[i];
    const col = colorOfSeat(i);
    const active = S.ph === 'play' && i === S.tn && !s.out;
    const t = tally(S.b, i);
    ctx.save();
    ctx.globalAlpha = s.out ? 0.45 : 1;
    rr(r.x, r.y, r.w, r.h, Math.min(12, r.h / 2));
    ctx.fillStyle = active ? alpha(col, 0.18) : 'rgba(255,255,255,0.05)';
    ctx.fill();
    if (active) { ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke(); }
    const dy = r.y + r.h / 2, dx = r.x + Math.min(16, r.h / 2 + 2);
    const dr = Math.min(7, r.h * 0.26);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(dx, dy, dr, 0, Math.PI * 2);
    ctx.fill();
    if (active && now >= lockUntil) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dx, dy, dr + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * turnLeft);
      ctx.stroke();
    }
    const size = r.h > 34 ? 13 : 12;
    const nameW = r.w - (dx - r.x) - dr - 50;
    text(clip(nameOf(s.id), size, Math.max(20, nameW)), dx + dr + 8, dy, size, C.text, 'left', 600);
    text(s.out ? 'out' : String(t.n), r.x + r.w - 10, dy, s.out ? 11 : 15, s.out ? C.faint : col, 'right', 800);
    if (s.out) {
      ctx.strokeStyle = C.faint;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(dx + dr + 6, dy);
      ctx.lineTo(r.x + r.w - 34, dy);
      ctx.stroke();
    }
    ctx.restore();
  });
}

// The line at the foot: whose turn, what to do, and the turn running out.
function drawStatus(now) {
  const y = H - STATUS_H;
  ctx.fillStyle = 'rgba(8,10,24,0.55)';
  ctx.fillRect(0, y, W, STATUS_H);
  const pre = practiceTable() ? 'practice · ' : '';
  let line;
  const s = S.seats[S.tn];
  if (S.g === 0) line = 'a cell bursts when it holds as many orbs as it has links';
  else if (S.ph === 'over') line = pre + 'game over';
  else if (mySeatIndex() < 0) line = 'watching · you play from the next game';
  else if (now < lockUntil) line = pre + 'chain reaction…';
  else if (myTurn()) line = pre + 'your turn · drop an orb into an empty cell or one of yours';
  else line = pre + (s ? nickOf(s.id) : 'someone') + "'s turn · a full cell bursts and takes its neighbours";
  text(line, W / 2, y + STATUS_H / 2 + 1, W < 420 ? 12 : 13, myTurn() && now >= lockUntil ? C.text : C.dim, 'center', 600, W - 24);
  if (S.ph === 'play' && s && !s.out && now >= lockUntil) {
    const k = clamp((endAt - now) / turnMs(S.seats.length), 0, 1);
    ctx.fillStyle = colorOfSeat(S.tn);
    ctx.fillRect(0, y, W * k, 3);
  }
}

function drawLobby(now) {
  const pw = Math.min(W - 2 * PAD, 400);
  const ph = Math.min(H - 2 * PAD, 250);
  const x = (W - pw) / 2, y = (H - ph) / 2;
  rr(x, y, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const cs = 34;
  [[2, 0], [3, 1], [1, 2]].forEach(([n, o], k) => {
    const cx = x + pw / 2 + (k - 1) * (cs + 10);
    rr(cx - cs / 2, y + 26, cs, cs, 8);
    ctx.fillStyle = alpha(PAL[o], 0.15);
    ctx.fill();
    drawOrbs(cx, y + 26 + cs / 2, cs, n, 4, PAL[o], now, k);
  });
  text('FISSION', x + pw / 2, y + 92, 26, C.text, 'center', 900);
  const lines = [
    'Drop an orb into an empty cell or one of yours.',
    'A cell holding as many orbs as it has links bursts,',
    'takes its neighbours, and they may burst too.',
  ];
  lines.forEach((l, i) => text(l, x + pw / 2, y + 124 + i * 19, 13, C.dim, 'center', 500, pw - 28));
  const dots = '.'.repeat(1 + Math.floor(now / 400) % 3);
  text((amHost() ? 'setting up the table' : 'waiting for the table') + dots, x + pw / 2, y + ph - 30, 13, C.faint, 'center', 500);
}

function drawOver(now) {
  const k = easeOut((now - overAt) / 500);
  ctx.fillStyle = 'rgba(6,8,20,' + 0.6 * k + ')';
  ctx.fillRect(0, 0, W, H);
  const order = S.seats.map((s, i) => ({ s, i, t: tally(S.b, i) }))
    .sort((a, b) => (a.s.id === S.win ? -1 : b.s.id === S.win ? 1 : 0) || a.s.out - b.s.out || b.t.n - a.t.n || b.t.cells - a.t.cells);
  const pw = Math.min(W - 2 * PAD, 360);
  const rowH = 28;
  const ph = Math.min(H - 20, 130 + order.length * rowH);
  const x = (W - pw) / 2, y = (H - ph) / 2 + (1 - k) * 24;
  ctx.save();
  ctx.globalAlpha = k;
  rr(x, y, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const wi = seatIndex(S.win);
  const title = wi < 0 ? 'A draw' : nameOf(S.win) + ' wins';
  text(title, x + pw / 2, y + 32, 23, wi < 0 ? C.text : colorOfSeat(wi), 'center', 900, pw - 28);
  const live = S.seats.filter((s) => !s.out).length;
  text(live <= 1 ? 'the last colour on the board' : 'the most orbs when the clock ran out', x + pw / 2, y + 56, 12, C.faint, 'center', 500, pw - 28);
  order.forEach((r, n) => {
    const yy = y + 84 + n * rowH;
    if (yy > y + ph - 44) return;
    ctx.fillStyle = colorOfSeat(r.i);
    ctx.beginPath();
    ctx.arc(x + 28, yy, 6, 0, Math.PI * 2);
    ctx.fill();
    text(clip(nameOf(r.s.id), 14, pw - 150), x + 42, yy, 14, r.s.out ? C.faint : C.text, 'left', 600);
    text(r.s.out ? 'out' : r.t.cells + ' cells', x + pw - 70, yy, 11, C.faint, 'right', 500);
    text(String(r.t.n), x + pw - 24, yy, 16, colorOfSeat(r.i), 'right', 800);
  });
  const wait = (practiceTable() ? PRACTICE_AGAIN : OVER_MS) - (now - overAt);
  const left = Math.max(1, Math.ceil(wait / 1000));
  text((practiceTable() ? 'next practice game in ' : 'next game in ') + left, x + pw / 2, y + ph - 22, 13, C.dim, 'center', 600);
  ctx.restore();
}

// ── the frame ───────────────────────────────────────────────────────────────

let prevNow = performance.now();

function frame(now) {
  try {
    const dt = clamp((now - prevNow) / 1000, 0, 0.1);
    prevNow = now;
    stepFx(dt);
    btns = [];
    computeLayout();
    stepAnim(now);
    if (anim && now >= lockUntil && anim.landed) anim = null;
    sideEffects(now);
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    drawBackground(now);
    if (S.g === 0) drawLobby(now);
    else {
      drawBoard(now);
      drawSeats(now);
    }
    for (const p of parts) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const p of pops) {
      const k = p.t / 1.3;
      ctx.save();
      ctx.globalAlpha = 1 - k * k;
      const s = 1 + 0.5 * (1 - easeOut(p.t * 4));
      ctx.translate(p.x, p.y - 36 * easeOut(k));
      ctx.scale(s, s);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(8,10,24,0.85)';
      font(20, 900);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeText(p.s, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.s, 0, 0);
      ctx.restore();
    }
    ctx.restore();
    drawTopBar(now);
    drawStatus(now);
    if (S.ph === 'over' && now >= lockUntil) drawOver(now);
    if (S.g > 0 && practiceTable()) {
      const head = joinEnd ? joinHead(Math.max(1, Math.ceil((joinEnd - now) / 1000)))
        : 'practice with bots · a game starts when someone joins';
      const tip = joinEnd ? null : 'fill a cell to its links and it bursts into its neighbours';
      const bottom = L.gy + L.cs * L.rows;
      practiceNote(now, L.fw, head, tip, [[bottom, H - STATUS_H]], H - STATUS_H, L.fx);
    }
  } catch (e) {
    // One bad frame must not stop every frame after it.
  }
  requestAnimationFrame(frame);
}

// ═══════════════════ the practice note ═══════════════════
// What a player sees while nobody else is here, alike in every game on this
// shelf: one short note at the foot of the screen, over the line of controls,
// saying who they practise with and what starts the real thing — or, once
// somebody has joined, that practice ends in a moment. It takes an empty strip
// beside the field instead when one is tall enough, so it covers nothing, and
// folds to its first line a few seconds in or at the first key or touch.
const NOTE_FOLD_MS = 6000;
const NOTE_FONT = "{w} {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const noteFont = (px, wt) => NOTE_FONT.replace('{w}', String(wt)).replace('{px}', String(Math.round(px * 10) / 10));
let noteSince = 0, noteSeen = -1e9, noteTouched = false;
addEventListener('keydown', () => { noteTouched = true; }, true);
addEventListener('pointerdown', () => { noteTouched = true; }, true);

// `bands` are the free strips beside the field, as [top, bottom] in screen
// pixels; `foot` is where the note's lower edge stands when none of them fits.
// The note is centred on a span `vw` wide from `left`: the screen, by default.
function practiceNote(now, vw, head, tip, bands, foot, left = 0) {
  if (now - noteSeen > 500) { noteSince = now; noteTouched = false; }
  noteSeen = now;
  const two = !!tip && !noteTouched && now - noteSince < NOTE_FOLD_MS;
  const h = two ? 50 : 30;
  ctx.font = noteFont(13, 700);
  const hw = ctx.measureText(head).width;
  ctx.font = noteFont(12, 600);
  const tw = two ? ctx.measureText(tip).width : 0;
  const w = Math.min(vw - 16, Math.max(hw + 14, tw) + 28);
  let y = foot - h, room = 0;
  for (const [a, b] of bands) if (b - a >= h + 4 && b - a > room) { room = b - a; y = (a + b - h) / 2; }
  const x = left + (vw - w) / 2, r = h / 2 > 15 ? 15 : h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(12,16,30,0.84)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textBaseline = 'middle';
  const hk = Math.min(1, (w - 42) / Math.max(1, hw));
  const hx = left + vw / 2 - (hw * hk + 14) / 2, hy = y + (two ? 17 : 15);
  ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now / 260);
  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.arc(hx + 4, hy, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.font = noteFont(13 * hk, 700);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(head, hx + 14, hy);
  if (two) {
    ctx.font = noteFont(12 * Math.min(1, (w - 28) / Math.max(1, tw)), 600);
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.textAlign = 'center';
    ctx.fillText(tip, left + vw / 2, y + 35);
  }
  ctx.restore();
}

// Practice ends a moment after somebody joins: who it was, as this page sees
// it — the room lists its players in the order they came.
function joinHead(left) {
  const ps = room.players, last = ps[ps.length - 1];
  const who = !last ? 'someone joined' : last.id === myId() ? 'you joined ' + nickOf(ps[0].id) : nickOf(last.id) + ' joined';
  return who + ' · practice ends in ' + left;
}

// ── input ───────────────────────────────────────────────────────────────────

function pt(e) {
  const b = cv.getBoundingClientRect();
  return { x: e.clientX - b.left, y: e.clientY - b.top };
}
const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
function buttonAt(p) { const b = btns.find((x) => inside(p, x)); return b ? b.id : ''; }
function act(id) {
  if (id === 'mute') { muted = !muted; if (!muted) sfx.place(); }
}

// A finger or the mouse goes down on a cell, may slide to another, and the
// orb drops where it is let go; let go off the board and nothing is played.
cv.addEventListener('pointerdown', (e) => {
  audio();
  const p = pt(e);
  const b = buttonAt(p);
  if (b) { press = b; e.preventDefault(); return; }
  if (S.g > 0 && S.ph === 'play') {
    drag = true;
    cursor = cellAt(p);
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ }
  }
  e.preventDefault();
});
cv.addEventListener('pointermove', (e) => {
  const p = pt(e);
  if (drag) cursor = cellAt(p);
  if (e.pointerType === 'mouse') {
    hoverCell = cellAt(p);
    cv.style.cursor = buttonAt(p) ? 'pointer' : hoverCell >= 0 && myTurn() ? 'pointer' : 'default';
  }
});
cv.addEventListener('pointerup', (e) => {
  const p = pt(e);
  if (press) {
    if (buttonAt(p) === press) act(press);
    press = '';
  }
  if (drag) {
    drag = false;
    const c = cellAt(p);
    if (c >= 0) tryPut(c);
    cursor = -1;
  }
});
cv.addEventListener('pointercancel', () => { drag = false; press = ''; cursor = -1; });
cv.addEventListener('pointerleave', () => { hoverCell = -1; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  audio();
  const k = e.key;
  if (k === 'm' || k === 'M') { act('mute'); return; }
  if (S.g === 0 || !S.cols) return;
  const N = S.cols * S.rows;
  const move = (dx, dy) => {
    if (cursor < 0 || cursor >= N) { cursor = ((S.rows >> 1) * S.cols + (S.cols >> 1)); return; }
    const x = clamp(cursor % S.cols + dx, 0, S.cols - 1), y = clamp(((cursor / S.cols) | 0) + dy, 0, S.rows - 1);
    cursor = y * S.cols + x;
  };
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') { move(-1, 0); e.preventDefault(); }
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') { move(1, 0); e.preventDefault(); }
  else if (k === 'ArrowUp' || k === 'w' || k === 'W') { move(0, -1); e.preventDefault(); }
  else if (k === 'ArrowDown' || k === 's' || k === 'S') { move(0, 1); e.preventDefault(); }
  else if ((k === 'Enter' || k === ' ') && cursor >= 0 && cursor < N) { tryPut(cursor); e.preventDefault(); }
});

// ── start ───────────────────────────────────────────────────────────────────

const startedAt = performance.now();

// The host's clock and this copy's hello share one beat. A hello is repeated
// slowly until a table arrives, so a host that started later still hears it.
setInterval(() => {
  try {
    const now = performance.now();
    hostTick(now);
    if (solo() || amHost()) return;
    if (!gotState && now - lastHi > 3000) { lastHi = now; room.send({ t: 'hi' }); }
  } catch (e) {
    // A tick that throws once must not stop every tick after it.
  }
}, 100);
requestAnimationFrame(frame);
// Everyone says hello once on starting, the host included, so any copy that
// becomes host later knows who is running the disk.
if (!solo()) { lastHi = performance.now(); room.send({ t: 'hi' }); }
