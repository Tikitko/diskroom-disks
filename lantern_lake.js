/**
 * @disk     lantern_lake
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Night fishing by sonar. Every cast sends you alone a ring that says how far the nearest fish is, but everyone sees where you cast. Read your rings, shadow a rival who seems to know, and never share a cell: two lines tangle and the fish escapes.
 * @tags     game, party, deduction, bluffing
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/lantern_lake.png
 */
// lantern_lake.js — a deduction game of hidden fish and public casts, run by the host.
//
// A nine by nine lake hides a few fish: minnows, perch and one golden carp.
// A game is ten casts. Each cast everyone picks a cell at once, face down.
// At the reveal, a lone line on a fish lands it; two or more lines on the
// same cell tangle and the fish escapes. Every caught or escaped fish
// surfaces again somewhere else, and now and then a fish drifts a cell.
// After the reveal each caster is told, privately, the distance to the
// nearest fish from where their bobber landed: a ring on their own screen.
// Where everyone cast is public, so a player who keeps casting near the same
// spot is telling the room something, true or not. The last three casts are
// at dusk and count double, and whoever trails alone also gets the direction
// to the nearest fish, so a losing player always has the best information.
//
// The host is the authority. The fish live in the host's copy alone; a cast
// travels to the host alone, addressed, so no seat has it on the wire before
// the reveal; a reading travels addressed to its caster alone. The host
// broadcasts only who has cast, never where, until the reveal. A host that
// inherits the game has no fish to inherit: the pond is stirred, every fish
// lands somewhere new, and every copy throws its old rings away. What this
// does not stop is a hostile host: its own copy holds every fish and every
// cast before the reveal, and nothing in a host-run game can take that away.

// ── rules ───────────────────────────────────────────────────────────────────

const N = 9;                            // the lake is N by N cells
const CELLS = N * N;
const TURNS = 10;                       // casts in a game
const DUSK = 3;                         // the last casts, which count double
const CAST_MS = 12000;                  // time to cast, set by the host's clock
const MIN_CAST_MS = 900;                // a turn is on screen at least this long
const SHOW_MS = 3400;                   // how long a reveal stays up
const DEAL_COOLDOWN = 2500;             // a finished game is on screen at least this long
const GRACE = 8000;                     // how long a dropped connection has to come back
const DRIFT = 0.3;                      // the chance a fish moves a cell after a reveal
const MAX_SEATS = 8;
const MAX_FISH = 9;
const KIND_VALUE = [1, 2, 5];           // minnow, perch, golden carp
const KIND_NAME = ['minnow', 'perch', 'golden carp'];
const RING_TURNS = 3;                   // how many casts back a ring stays on screen
const BOT_NAMES = ['Bot Ada', 'Bot Rex', 'Bot Ivy'];

// One colour per seat, in seat order, so no two players at a table share one.
const PAL = ['#ff7a7a', '#ffd166', '#6fe0ff', '#c3a4ff', '#ff9f5a', '#ff7ac0', '#a3e07a', '#f4f1ea'];
const FISH_COL = ['#cfe3ea', '#8fe0a0', '#ffcf4a'];
const C = {
  sky0: '#1d2c4a', sky1: '#0b1426', water0: '#174a63', water1: '#0b2438', shore: '#11291f', reed: '#2b5a3a',
  panel: 'rgba(10,20,34,0.93)', line: '#2f4a66', text: '#eef4f8', dim: '#a9bfcf', faint: '#6f8aa0',
  moon: '#f6ecc6', lamp: '#ffcf6e', lampDeep: '#3a2a08', red: '#ff5a6a', grid: 'rgba(190,225,255,0.07)',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const cx = (c) => c % N;
const cy = (c) => Math.floor(c / N);
const dist = (a, b) => Math.max(Math.abs(cx(a) - cx(b)), Math.abs(cy(a) - cy(b)));
const isCell = (c) => Number.isInteger(c) && c >= 0 && c < CELLS;
const dusk = (turn) => turn > TURNS - DUSK;
const rndInt = (n) => Math.floor(Math.random() * n);
const fishCount = (n) => Math.min(MAX_FISH, 5 + Math.floor(n / 2));

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g      game number, so a stale cast for an old game is recognised
//   ph     'wait' | 'cast' | 'show' | 'over'
//   turn   casts so far this game, 1..TURNS once dealt
//   sr     how many times the pond was stirred, so a copy knows its rings are stale
//   nf     how many fish the lake holds
//   seats  [{ id, sc, n }]: score and fish landed
//   locked ids that have a line in this turn, never where
//   q      players running the disk who are not seated, joining next cast
//   last   the latest reveal: { turn, casts: [[id, cell, result, value]] }
//          result 0 a miss, 1 a catch, 2 a tangle
//   fish   [[cell, kind]] shown once the game is over, empty before
let S = blank();
let endAt = 0;           // local clock: when this phase ends
let overAt = -1e9;       // local clock: when the last game ended

function blank() {
  return { g: 0, ph: 'wait', turn: 0, sr: 0, nf: 0, seats: [], locked: [], q: [], last: null, fish: [] };
}

// The host's alone.
let pond = [];             // [{ c, k }]: where each fish is and what kind; never broadcast during a game
const casts = new Map();   // seat id -> cell, never broadcast before the reveal
const botAt = new Map();   // bot seat id -> when it casts
const botMem = new Map();  // bot seat id -> [{ turn, c, d }], its own readings
const lastRd = new Map();  // seat id -> the latest reading sent, for a copy that asks again
const ready = new Map();   // player id -> when its disk last said hello
const answered = new Map();// player id -> when its hello was last answered
let castAt = 0;            // when the current cast phase opened
let lastPub = 0;
let shortAt = 0;           // when the table last fell below two players, 0 if it has not
let gameNo = 0;            // the last game number dealt or seen, so a new host counts on

// Mine.
let myCast = null;         // { g, turn, c }
let aim = -1;              // the cell my cursor is on
let sentKey = '';          // which host and turn my cast was last sent to
let sendTimer = null;
let lastSend = 0;
let helloAt = -1e9;
let rings = [];            // my readings: [{ g, sr, turn, c, d, dir, at }]

const nicks = new Map();   // id -> last nick seen, so a seat that left keeps a name

// `room.me` is null in the studio and on Run solo. The disk is its own host
// there and runs a practice game against bots.
const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const amHost = () => !room.me || (room.host !== null && room.host.id === room.me.id);
const fromHost = (from) => room.host !== null && from === room.host.id;
const inRoom = (id) => room.players.some((p) => p.id === id);
// Bots (ids below -1) sit only at a practice table the host dealt; -1 is me
// with no room around me.
const isBot = (id) => id < -1;
const present = (id) => (isBot(id) ? true : id === -1 ? solo() : inRoom(id));
const seatOf = (id) => S.seats.find((s) => s.id === id) || null;
const mySeat = () => seatOf(myId());

function nickOf(id) {
  if (id === -1) return 'You';
  if (isBot(id)) return BOT_NAMES[(-id - 2) % BOT_NAMES.length];
  const p = room.players.find((x) => x.id === id);
  if (p) { nicks.set(id, p.nick); return p.nick; }
  return nicks.get(id) || 'Player';
}

function colorOf(id) {
  const i = S.seats.findIndex((s) => s.id === id);
  return i >= 0 ? PAL[i % PAL.length] : C.dim;
}

// Whoever trails alone at the bottom, with somebody above them, gets the
// direction to the nearest fish as well as its distance. Every copy works it
// out from the public scores, so the badge on screen and the host's reading
// always agree.
function trailing(id) {
  if (S.seats.length < 2) return false;
  const s = seatOf(id);
  if (!s) return false;
  let lo = Infinity, hi = -Infinity;
  for (const o of S.seats) { lo = Math.min(lo, o.sc); hi = Math.max(hi, o.sc); }
  return hi > lo && s.sc === lo;
}

// ── the pond (the host's) ───────────────────────────────────────────────────

function makePond(n) {
  const kinds = [2, 1, 1];
  while (kinds.length < n) kinds.push(0);
  const used = new Set();
  return kinds.map((k) => {
    let c;
    do c = rndInt(CELLS); while (used.has(c));
    used.add(c);
    return { c, k };
  });
}

// A fish that was caught or escaped surfaces away from every bobber of that
// cast, so the next reading is a search, never a gift.
function freeCell(avoid) {
  const busy = new Set(pond.map((f) => f.c));
  for (let tries = 0; tries < 300; tries++) {
    const c = rndInt(CELLS);
    if (!busy.has(c) && avoid.every((a) => dist(a, c) >= 2)) return c;
  }
  for (let c = 0; c < CELLS; c++) if (!busy.has(c)) return c;
  return 0;
}

function drift() {
  for (const f of pond) {
    if (Math.random() >= DRIFT) continue;
    const dx = rndInt(3) - 1, dy = rndInt(3) - 1;
    const x = cx(f.c) + dx, y = cy(f.c) + dy;
    if (x < 0 || y < 0 || x >= N || y >= N) continue;
    const c = y * N + x;
    if (!pond.some((o) => o.c === c)) f.c = c;
  }
}

// The distance to the nearest fish, and which of the eight ways it lies.
// The direction is 0..8 read as (dy + 1) * 3 + (dx + 1); 4 is the cell itself.
function sound(c) {
  let best = Infinity, dir = 4;
  for (const f of pond) {
    const d = dist(c, f.c);
    if (d < best) {
      best = d;
      dir = (Math.sign(cy(f.c) - cy(c)) + 1) * 3 + (Math.sign(cx(f.c) - cx(c)) + 1);
    }
  }
  return { d: best === Infinity ? N : best, dir };
}

// ── the host ────────────────────────────────────────────────────────────────

function readyHumans() {
  if (solo()) return [-1];
  const ids = [];
  if (room.me) ids.push(myId());
  for (const id of ready.keys()) if (id !== myId() && inRoom(id)) ids.push(id);
  return ids.slice(0, MAX_SEATS);
}

function queued() {
  if (solo()) return [];
  return readyHumans().filter((id) => !seatOf(id));
}

const canDeal = (now) => S.ph === 'wait' || (S.ph === 'over' && now - overAt >= DEAL_COOLDOWN);

function hostDeal() {
  const now = performance.now();
  if (!amHost() || !canDeal(now)) return;
  let ids = readyHumans();
  // Fewer than two people is a practice lake: the host is dealt bots.
  if (ids.length < 2) ids = ids.concat([-2, -3, -4]);
  gameNo = Math.max(gameNo, S.g) + 1;
  const sr = S.sr;
  S = blank();
  S.g = gameNo;
  S.sr = sr;
  S.seats = ids.map((id) => ({ id, sc: 0, n: 0 }));
  S.nf = fishCount(S.seats.length);
  pond = makePond(S.nf);
  botMem.clear();
  lastRd.clear();
  shortAt = 0;
  startTurn(now);
}

function startTurn(now) {
  S.turn += 1;
  // Whoever started the disk during the last cast sits down now, from zero:
  // trailing alone, they fish with the direction as well as the distance.
  for (const id of queued()) {
    if (S.seats.length >= MAX_SEATS) break;
    S.seats.push({ id, sc: 0, n: 0 });
  }
  S.ph = 'cast';
  S.locked = [];
  casts.clear();
  scheduleBots(now);
  castAt = now;
  endAt = now + CAST_MS;
  publish(now);
}

// A cast, from whoever the room says sent it. It counts only for the turn on
// the table, for a seated player who is here, and only once: a line in the
// water stays there until the reveal.
function hostCast(id, c, now) {
  if (S.ph !== 'cast' || !isCell(c)) return;
  const s = seatOf(id);
  if (!s || !present(id) || casts.has(id)) return;
  casts.set(id, c);
  S.locked.push(id);
  publish(now);
}

function reveal(now) {
  const byCell = new Map();
  for (const s of S.seats) {
    if (!casts.has(s.id) || !present(s.id)) continue;
    const c = casts.get(s.id);
    if (!byCell.has(c)) byCell.set(c, []);
    byCell.get(c).push(s.id);
  }
  const mult = dusk(S.turn) ? 2 : 1;
  const rows = [];
  const surfaced = [];
  for (const [c, ids] of byCell) {
    const f = pond.find((x) => x.c === c);
    if (!f) { for (const id of ids) rows.push([id, c, 0, 0]); continue; }
    const v = KIND_VALUE[f.k];
    if (ids.length === 1) {
      const s = seatOf(ids[0]);
      s.sc += v * mult;
      s.n += 1;
      rows.push([ids[0], c, 1, v * mult]);
    } else {
      for (const id of ids) rows.push([id, c, 2, v]);
    }
    surfaced.push(f);
  }
  const avoid = [...byCell.keys()];
  for (const f of surfaced) f.c = -1;
  for (const f of surfaced) f.c = freeCell(avoid);
  drift();
  S.last = { turn: S.turn, casts: rows };
  S.ph = 'show';
  S.locked = [];
  endAt = now + SHOW_MS;
  publish(now);
  // The readings follow the table, each to its own caster alone.
  for (const [c, ids] of byCell) {
    for (const id of ids) {
      const r = sound(c);
      const rd = { t: 'rd', g: S.g, turn: S.turn, c, d: r.d, dir: trailing(id) ? r.dir : -1 };
      if (isBot(id)) {
        const mem = botMem.get(id) || [];
        mem.push({ turn: S.turn, c, d: r.d });
        while (mem.length > RING_TURNS) mem.shift();
        botMem.set(id, mem);
      } else if (id === myId()) {
        takeReading(rd, now);
      } else {
        lastRd.set(id, rd);
        room.send(rd, { to: id });
      }
    }
  }
  casts.clear();
}

function finish(now) {
  S.ph = 'over';
  S.locked = [];
  S.fish = pond.map((f) => [f.c, f.k]);
  casts.clear();
  botAt.clear();
  endAt = now;
  overAt = now;
  publish(now);
}

function scheduleBots(now) {
  botAt.clear();
  for (const s of S.seats) if (isBot(s.id)) botAt.set(s.id, now + 1500 + Math.random() * 6000);
}

// A bot fishes with what it was told and nothing more: it stays out of every
// cell its recent rings said was empty, and mostly casts on its latest ring.
function botPick(id) {
  const mem = (botMem.get(id) || []).filter((r) => S.turn - r.turn < RING_TURNS);
  const ok = [], ring = [];
  for (let c = 0; c < CELLS; c++) {
    let good = true, on = false;
    for (const r of mem) {
      const d = dist(c, r.c);
      if (d < r.d) { good = false; break; }
      if (r.turn === S.turn - 1 && d === r.d) on = true;
    }
    if (good) { ok.push(c); if (on) ring.push(c); }
  }
  const pool = ring.length && Math.random() < 0.8 ? ring : ok;
  return pool.length ? pool[rndInt(pool.length)] : rndInt(CELLS);
}

// A table with fewer than two players, or with nobody but bots, is over, but
// not on the instant: a dropped connection comes back as a leave and a join,
// and one blip must not end everybody's game.
function tooFew(now) {
  const live = S.seats.filter((s) => present(s.id));
  if (live.length >= 2 && live.some((s) => !isBot(s.id))) { shortAt = 0; return false; }
  if (!shortAt) shortAt = now;
  return now - shortAt > GRACE;
}

function hostTick() {
  if (!amHost()) return;
  const now = performance.now();
  if (S.g > 0 && S.ph !== 'over' && S.ph !== 'wait' && tooFew(now)) { finish(now); return; }
  if (S.ph === 'cast') {
    for (const [id, at] of botAt) {
      if (now < at) continue;
      botAt.delete(id);
      if (seatOf(id)) hostCast(id, botPick(id), now);
    }
    const live = S.seats.filter((s) => present(s.id));
    const all = live.length > 0 && live.every((s) => casts.has(s.id));
    if (now >= endAt || (all && now - castAt >= MIN_CAST_MS)) { reveal(now); return; }
  } else if (S.ph === 'show' && now >= endAt) {
    if (S.turn >= TURNS) finish(now);
    else startTurn(now);
    return;
  }
  // A heartbeat, so one lost broadcast is never the only thing that carried a
  // change, and a clock that drifted is put back. The lobby beats too, so
  // everybody sees who has the disk running.
  if (now - lastPub > 2500) publish(now);
}

function wire(now) {
  return {
    t: 'st', g: S.g, ph: S.ph, turn: S.turn, sr: S.sr, nf: S.nf,
    seats: S.seats.map((s) => [s.id, s.sc, s.n]),
    locked: S.locked,
    q: queued().slice(0, MAX_SEATS),
    ms: Math.max(0, Math.round(endAt - now)),
    last: S.last,
    fish: S.ph === 'over' ? S.fish : [],
  };
}

function publish(now) {
  lastPub = now;
  if (!solo()) room.send(wire(now));
  S.q = queued();
  observe(now, Math.max(0, endAt - now));
}

// ── receiving ───────────────────────────────────────────────────────────────

// A table off the wire is a claim and is read as one: the right shape, numbers
// in range, lists of bounded length. Anything else is dropped whole.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID_MIN = -8, ID_MAX = 2147483647;
const isId = (v) => int(v, ID_MIN, ID_MAX);
const PHASES = ['wait', 'cast', 'show', 'over'];
const MAX_SCORE = 1000;

function idList(a, ok) {
  if (!Array.isArray(a) || a.length > MAX_SEATS || !a.every((id) => isId(id) && ok(id))) return null;
  return a.slice();
}

function stateOf(m) {
  if (!int(m.g, 0, 1e9) || !PHASES.includes(m.ph) || !int(m.turn, 0, TURNS) || !int(m.sr, 0, 1e9) || !int(m.nf, 0, MAX_FISH)) return null;
  if (!Array.isArray(m.seats) || m.seats.length > MAX_SEATS) return null;
  const seats = [];
  for (const r of m.seats) {
    if (!Array.isArray(r) || r.length !== 3) return null;
    const [id, sc, n] = r;
    if (!isId(id) || !int(sc, 0, MAX_SCORE) || !int(n, 0, TURNS)) return null;
    if (seats.some((s) => s.id === id)) return null;
    seats.push({ id, sc, n });
  }
  const seated = (id) => seats.some((s) => s.id === id);
  const locked = idList(m.locked, seated);
  const q = idList(m.q, (id) => !seated(id));
  if (!locked || !q) return null;
  if (typeof m.ms !== 'number' || !Number.isFinite(m.ms)) return null;
  let last = null;
  if (m.last !== null && m.last !== undefined) {
    const l = m.last;
    if (!l || typeof l !== 'object' || !int(l.turn, 1, TURNS) || !Array.isArray(l.casts) || l.casts.length > MAX_SEATS) return null;
    const rows = [];
    for (const r of l.casts) {
      if (!Array.isArray(r) || r.length !== 4 || !seated(r[0]) || !isCell(r[1]) || !int(r[2], 0, 2) || !int(r[3], 0, 10)) return null;
      if (rows.some((x) => x[0] === r[0])) return null;
      rows.push(r.slice());
    }
    last = { turn: l.turn, casts: rows };
  }
  if (!Array.isArray(m.fish) || m.fish.length > MAX_FISH) return null;
  const fish = [];
  for (const f of m.fish) {
    if (!Array.isArray(f) || f.length !== 2 || !isCell(f[0]) || !int(f[1], 0, KIND_VALUE.length - 1)) return null;
    fish.push([f[0], f[1]]);
  }
  return {
    S: { g: m.g, ph: m.ph, turn: m.turn, sr: m.sr, nf: m.nf, seats, locked, q, last, fish },
    ms: Math.min(Math.max(m.ms, 0), Math.max(CAST_MS, SHOW_MS)),
  };
}

// Every sender gets a bucket: ten messages a second, twenty at once. An honest
// copy sends a few a turn; one that floods is dropped here before any of its
// messages is even read, so it cannot stall the lake for the rest.
const buckets = new Map();
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
    if (!Number.isInteger(from) || !allow(from, now)) return;
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    switch (msg.t) {
      // A disk that has just started says so, and asks where the game is. The
      // host answers that one seat alone, and no more than once in a while:
      // a copy that repeats its hello must not make the host send for it.
      case 'hello': {
        if (!amHost() || !inRoom(from) || from === myId()) break;
        const fresh = !ready.has(from);
        ready.delete(from);
        ready.set(from, now);
        while (ready.size > 64) ready.delete(ready.keys().next().value);
        if (fresh) publish(now);
        else if (now - (answered.get(from) || -1e9) > 1500) {
          answered.set(from, now);
          room.send(wire(now), { to: from });
          const rd = lastRd.get(from);
          if (rd && rd.g === S.g) room.send(rd, { to: from });
        }
        break;
      }
      case 'cast':
        if (amHost() && from !== myId() && msg.g === S.g && msg.turn === S.turn && isCell(msg.c)) {
          hostCast(from, msg.c, now);
        }
        break;
      case 'go':
        if (amHost() && inRoom(from) && from !== myId()) {
          if (!ready.has(from)) ready.set(from, now);
          hostDeal();
        }
        break;
      case 'st': {
        if (amHost() || !fromHost(from)) break;
        const st = stateOf(msg);
        if (!st) break;
        S = st.S;
        gameNo = Math.max(gameNo, S.g);
        endAt = now + st.ms;
        observe(now, st.ms);
        break;
      }
      case 'rd':
        if (amHost() || !fromHost(from)) break;
        if (msg.g !== S.g || !int(msg.turn, 1, TURNS) || !isCell(msg.c) || !int(msg.d, 0, N) || !int(msg.dir, -1, 8)) break;
        takeReading({ g: msg.g, turn: msg.turn, c: msg.c, d: msg.d, dir: msg.dir }, now);
        break;
    }
  } catch (e) {
    // A message that breaks this handler is the sender's problem, never the lake's.
  }
});

room.on('join', (p) => { nicks.set(p.id, p.nick); });

room.on('leave', (p) => {
  nicks.set(p.id, p.nick);
  buckets.delete(p.id);
  answered.delete(p.id);
});

room.on('hostchange', () => {
  sentKey = '';
  const now = performance.now();
  if (!amHost()) {
    // The new host never heard my hello: it needs to know my disk is running.
    helloAt = -1e9;
    sayHello(now);
    return;
  }
  ready.clear();
  gameNo = Math.max(gameNo, S.g);
  for (const s of S.seats) if (!isBot(s.id) && s.id !== myId()) ready.set(s.id, now);
  for (const id of S.q) if (id !== myId()) ready.set(id, now);
  // The fish left with the old host. The pond is stirred: the same number
  // of fish lands somewhere new, and every copy drops the rings it had. The
  // casts went to the old host too; the turn on the table is cast again on a
  // fresh clock, and every copy that had cast sends its cast again when it
  // sees the new host's table.
  casts.clear();
  botMem.clear();
  lastRd.clear();
  if (S.ph === 'cast' || S.ph === 'show') {
    S.sr += 1;
    pond = makePond(S.nf || fishCount(S.seats.length));
  }
  if (S.ph === 'cast') {
    S.locked = [];
    castAt = now;
    endAt = now + CAST_MS;
    scheduleBots(now);
    if (myCast && myCast.g === S.g && myCast.turn === S.turn && mySeat()) {
      casts.set(myId(), myCast.c);
      S.locked.push(myId());
    }
  } else if (S.ph === 'show') {
    endAt = now + 1500;
  }
  publish(now);
});

// ── my moves ────────────────────────────────────────────────────────────────

const myLine = () => (myCast && myCast.g === S.g && myCast.turn === S.turn ? myCast : null);
const canCast = () => S.ph === 'cast' && !!mySeat() && !myLine();

function sendCast() {
  if (sendTimer) return;
  // At most two cast messages a second: a copy resending for a new host or a
  // lost message never runs into the host's bucket.
  const wait = Math.max(0, lastSend + 500 - performance.now());
  sendTimer = setTimeout(() => {
    sendTimer = null;
    lastSend = performance.now();
    const line = myLine();
    if (!line || !room.host || amHost()) return;
    room.send({ t: 'cast', g: line.g, turn: line.turn, c: line.c }, { to: room.host.id });
    sentKey = room.host.id + ':' + S.g + ':' + S.turn;
  }, wait);
}

// A tap casts only on a cell aimed at during this turn, so the first tap of
// a turn never casts at a cell left over from the last one.
let aimKey = '';
const turnKey = () => S.g + ':' + S.turn;
function setAim(c) {
  if (!isCell(c)) return;
  aimKey = turnKey();
  if (c === aim) return;
  aim = c;
  sfx.aim();
}

function cast() {
  if (!canCast() || !isCell(aim)) return;
  myCast = { g: S.g, turn: S.turn, c: aim };
  sfx.cast();
  const p = cellCenter(aim);
  if (p) burst(p.x, p.y, colorOf(myId()), 10, 120);
  squash = 1;
  if (amHost()) hostCast(myId(), aim, performance.now());
  else sendCast();
}

let goAt = -1e9;
function go() {
  const now = performance.now();
  // A held key repeats; the host hears one request in half a second.
  if (!canDeal(now) || now - goAt < 500) return;
  goAt = now;
  sfx.aim();
  if (amHost()) hostDeal();
  else if (room.host) room.send({ t: 'go' }, { to: room.host.id });
}

function sayHello(now) {
  if (solo() || amHost() || !room.host || now - helloAt < 3000) return;
  helloAt = now;
  room.send({ t: 'hello' }, { to: room.host.id });
}

// A reading is mine to keep. It shows once the bobber has landed on screen,
// and the old ones fade a turn at a time.
function takeReading(rd, now) {
  if (rd.g !== S.g || rings.some((r) => r.g === rd.g && r.sr === S.sr && r.turn === rd.turn)) return;
  const land = S.ph === 'show' && S.last && S.last.turn === rd.turn ? phaseAt + 1100 : now;
  rings.push({ g: rd.g, sr: S.sr, turn: rd.turn, c: rd.c, d: rd.d, dir: rd.dir, at: Math.max(now, land) });
  while (rings.length > RING_TURNS + 1) rings.shift();
  later(Math.max(now, land), () => sfx.ping(rd.d));
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects are drawn from the table as it changes on this screen, never sent.
let seenKey = '';
let seenSr = -1;
let seenG = -1;
let seenLocked = new Set();
let phaseAt = -1e9;      // when this screen saw the current phase start
let stirAt = -1e9;       // when this screen last saw the pond stirred
let primed = false;      // the first table seen sets the scene without a fanfare
const trail = [];        // reveals seen, newest last: [{ turn, casts }]

function observe(now, ms) {
  if (S.g !== seenG) { seenG = S.g; rings = []; trail.length = 0; }
  if (S.sr !== seenSr) {
    if (primed && seenSr >= 0 && S.g > 0 && S.ph !== 'wait') stirAt = now;
    seenSr = S.sr;
    rings = rings.filter((r) => r.sr === S.sr);
  }
  const key = S.g + ':' + S.turn + ':' + S.ph;
  if (key !== seenKey) {
    seenKey = key;
    const span = S.ph === 'cast' ? CAST_MS : S.ph === 'show' ? SHOW_MS : 0;
    phaseAt = span ? now - Math.max(0, span - ms) : now;
    if (S.last && !trail.some((t) => t.turn === S.last.turn)) {
      trail.push(S.last);
      while (trail.length > 2) trail.shift();
    }
    if (primed && S.ph === 'show') revealFx(now);
    if (primed && S.ph === 'cast' && S.turn === TURNS - DUSK + 1) sfx.dusk();
    if (S.ph === 'cast' && !isCell(aim)) aim = (N * N - 1) / 2;
    if (S.ph === 'over') {
      overAt = now;
      if (primed) celebrate();
    }
    seenLocked = new Set();
  }
  primed = true;
  if (myCast && (myCast.g !== S.g || myCast.turn !== S.turn)) myCast = null;
  // A soft click when somebody else's line goes in; my own already had a sound.
  if (S.ph === 'cast' && S.locked.some((id) => id !== myId() && !seenLocked.has(id))) sfx.lock();
  seenLocked = new Set(S.locked);
  // A new host never saw my cast, and a cast can be lost on the way: while the
  // table does not show mine as in, it goes again, once per host and turn and
  // then at the pace of the host's heartbeat.
  if (!amHost() && S.ph === 'cast' && myLine() && room.host && !S.locked.includes(myId())) {
    if (sentKey !== room.host.id + ':' + S.g + ':' + S.turn || now - lastSend > 1500) sendCast();
  }
  // A host that does not list me has not heard my hello.
  if (!amHost() && !mySeat() && !S.q.includes(myId())) sayHello(now);
}

// Things that happen a moment after the reveal, on this screen's clock.
const queue = [];
function later(at, fn) { queue.push({ at, fn }); }
function runLater(now) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (now < queue[i].at) continue;
    const q = queue.splice(i, 1)[0];
    try { q.fn(); } catch (e) { /* an effect is never worth an error */ }
  }
}

function revealFx(now) {
  const l = S.last;
  if (!l) return;
  sfx.whoosh();
  const splash = now + 560;
  for (const [id, c, res, v] of l.casts) {
    later(splash, () => {
      const p = cellCenter(c);
      if (!p) return;
      burst(p.x, p.y, '#bfe8ff', 8, 90);
      ripples.push({ c, at: performance.now() });
    });
    if (res === 1) {
      later(splash + 140, () => {
        const p = cellCenter(c);
        if (p) { burst(p.x, p.y, FISH_COL[kindOf(v, l.turn)], 16, 170); pop(p.x, p.y - 10, '+' + v, FISH_COL[kindOf(v, l.turn)]); }
        popAtSeat(id, '+' + v, C.lamp);
      });
    } else if (res === 2) {
      later(splash + 140, () => {
        const p = cellCenter(c);
        if (p) burst(p.x, p.y, C.red, 10, 130);
        shake = Math.max(shake, 6);
      });
    }
  }
  sfx.plop(0.56);
  if (l.casts.some((r) => r[2] === 1)) {
    const top = Math.max(...l.casts.filter((r) => r[2] === 1).map((r) => KIND_VALUE[kindOf(r[3], l.turn)]));
    sfx.catch(top, 0.7);
  }
  if (l.casts.some((r) => r[2] === 2)) sfx.tangle(0.7);
}

// The value on a catch is doubled at dusk; the kind is what it was before.
function kindOf(v, turn) {
  const base = dusk(turn) && v > 0 && v % 2 === 0 ? v / 2 : v;
  const k = KIND_VALUE.indexOf(base);
  return k < 0 ? 0 : k;
}

// ── sound ───────────────────────────────────────────────────────────────────

let ac = null;
let muted = false;
let noise = null;
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
// A breath of filtered noise, made once: the swish of a line, a splash.
function hiss(d, v, f0, f1, delay) {
  if (muted || !ac) return;
  try {
    if (!noise) {
      noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 1.2), ac.sampleRate);
      const ch = noise.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    }
    const t = ac.currentTime + (delay || 0);
    const src = ac.createBufferSource();
    src.buffer = noise;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + d);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    src.connect(f);
    f.connect(g);
    g.connect(ac.destination);
    src.start(t);
    src.stop(t + d + 0.05);
  } catch (e) { /* a sound is never worth an error */ }
}
const sfx = {
  aim: () => tone(880, 0.03, 'triangle', 0.03),
  lock: () => tone(520, 0.05, 'sine', 0.03, 380),
  cast: () => { hiss(0.28, 0.1, 2400, 700); tone(300, 0.1, 'sine', 0.05, 180, 0.26); },
  whoosh: () => hiss(0.5, 0.09, 3000, 600),
  plop: (delay) => { tone(520, 0.12, 'sine', 0.07, 140, delay); hiss(0.18, 0.06, 900, 300, delay); },
  catch: (v, delay) => (v >= 5 ? [784, 988, 1175, 1568, 1976] : v >= 2 ? [659, 880, 1175] : [784, 1047])
    .forEach((f, i) => tone(f, 0.16, 'triangle', 0.05, null, delay + i * 0.07)),
  tangle: (delay) => { tone(180, 0.3, 'sawtooth', 0.04, 120, delay); tone(190, 0.3, 'sawtooth', 0.04, 110, delay + 0.03); },
  // A sonar ping: higher the nearer the fish.
  ping: (d) => { const f = 1500 - Math.min(d, 6) * 110; tone(f, 0.5, 'sine', 0.05, f * 0.93); tone(f, 0.4, 'sine', 0.018, f * 0.93, 0.22); },
  tick: () => tone(1200, 0.03, 'square', 0.025),
  dusk: () => { tone(220, 0.8, 'triangle', 0.05, 196); tone(330, 0.8, 'sine', 0.03, 294, 0.1); },
  fanfare: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.06, null, i * 0.11)),
};

// ── the screen ──────────────────────────────────────────────────────────────

document.documentElement.style.cssText = 'height:100%;background:' + C.sky1;
document.body.style.cssText =
  'margin:0;height:100%;overflow:hidden;background:' + C.sky1 + ';touch-action:none;' +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none';
const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

let W = 640, H = 400;
let coarse = matchMedia('(pointer: coarse)').matches;
let stars = [];          // laid out once per size
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  coarse = matchMedia('(pointer: coarse)').matches;
  W = cv.clientWidth || window.innerWidth || 640;
  H = cv.clientHeight || window.innerHeight || 400;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  stars = [];
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const n = Math.round((W * H) / 5000);
  for (let i = 0; i < n; i++) stars.push({ x: rnd() * W, y: rnd() * H, r: 0.4 + rnd() * 1.1, p: rnd() * 6.28 });
}
layout();
window.addEventListener('resize', layout);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); };
const easeInOut = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const follow = (cur, want, dt, rate) => cur + (want - cur) * (1 - Math.exp(-dt * rate));

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
// A nick is at most 16 characters, but a long one in a narrow chip is cut
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
const ripples = [];      // [{ c, at }]
let shake = 0;
let squash = 0;

function burst(x, y, color, n, speed) {
  for (let i = 0; i < n && parts.length < 320; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.8);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.4, life: 1, decay: 1 + Math.random() * 0.9, color, r: 1.6 + Math.random() * 2.2, g: 380 });
  }
}
function pop(x, y, s, color) { pops.push({ x, y, s, color, t: 0 }); }
const seatRect = new Map();  // seat id -> where its chip was drawn last frame
function popAtSeat(id, s, color) {
  const r = seatRect.get(id);
  if (r) pop(r.x + r.w / 2, r.y + r.h / 2, s, color);
}

function celebrate() {
  sfx.fanfare();
  const top = standings()[0];
  const color = top ? colorOf(top.id) : C.lamp;
  for (let i = 0; i < 5; i++) burst(W * (0.15 + 0.7 * Math.random()), H * (0.25 + 0.3 * Math.random()), i % 2 ? color : C.lamp, 22, 240);
}

// Particles, pops and ripples move by the elapsed time, not by the frame, so
// a slow or fast screen shows the same motion.
function stepFx(dt, now) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.vy += p.g * dt;
    p.vx *= 1 - 1.5 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= p.decay * dt;
    if (p.life <= 0 || p.y > H + 40) parts.splice(i, 1);
  }
  for (let i = pops.length - 1; i >= 0; i--) {
    pops[i].t += dt;
    if (pops[i].t > 1.3) pops.splice(i, 1);
  }
  for (let i = ripples.length - 1; i >= 0; i--) if (now - ripples[i].at > 1400) ripples.splice(i, 1);
  shake = Math.max(0, shake - 30 * dt);
  squash = Math.max(0, squash - 4 * dt);
}

// ── layout of the lake ──────────────────────────────────────────────────────

const PAD = 12;
let btns = [];
const btnRect = new Map();
let press = '';
let lake = { x: 0, y: 0, s: 30 };   // the grid's corner and cell size
let aimX = -1, aimY = -1;           // the cursor on screen, eased toward the aimed cell

function cellCenter(c) {
  if (!isCell(c)) return null;
  return { x: lake.x + (cx(c) + 0.5) * lake.s, y: lake.y + (cy(c) + 0.5) * lake.s };
}
function cellAt(p, clampIt) {
  let x = Math.floor((p.x - lake.x) / lake.s), y = Math.floor((p.y - lake.y) / lake.s);
  if (clampIt) { x = clamp(x, 0, N - 1); y = clamp(y, 0, N - 1); }
  if (x < 0 || y < 0 || x >= N || y >= N) return -1;
  return y * N + x;
}

function seatsLayout(n) {
  const top = 42;
  const gap = 6;
  let cols = Math.max(1, n);
  let w = (W - 2 * PAD - (cols - 1) * gap) / cols;
  if (w < 92 && n > 1) {
    cols = Math.ceil(n / 2);
    w = (W - 2 * PAD - (cols - 1) * gap) / cols;
  }
  w = Math.min(w, 150);
  const h = 40;
  const rows = Math.ceil(n / cols);
  const rects = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i - row * cols;
    const rowW = inRow * w + (inRow - 1) * gap;
    rects.push({ x: (W - rowW) / 2 + col * (w + gap), y: top + row * (h + gap), w, h });
  }
  return { rects, bottom: top + rows * (h + gap) - gap };
}

// ── drawing pieces ──────────────────────────────────────────────────────────

function drawBackground(now) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, C.sky0);
  g.addColorStop(1, C.sky1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (const s of stars) {
    ctx.globalAlpha = 0.25 + 0.25 * Math.sin(now / 900 + s.p);
    ctx.fillStyle = '#dfe9ff';
    ctx.fillRect(s.x, s.y, s.r, s.r);
  }
  ctx.globalAlpha = 1;
  // The moon, low and to one side, with a soft halo.
  const mx = W * 0.86, my = Math.min(H * 0.12, 70), mr = Math.min(W, H) * 0.035 + 6;
  const halo = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 5);
  halo.addColorStop(0, 'rgba(246,236,198,0.18)');
  halo.addColorStop(1, 'rgba(246,236,198,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(mx - mr * 5, my - mr * 5, mr * 10, mr * 10);
  ctx.fillStyle = C.moon;
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(29,44,74,0.9)';
  ctx.beginPath();
  ctx.arc(mx + mr * 0.45, my - mr * 0.2, mr * 0.85, 0, Math.PI * 2);
  ctx.fill();
}

// Fireflies drift over the lake: light, never information.
function drawFireflies(now) {
  for (let i = 0; i < 14; i++) {
    const t = now / 1000;
    const x = (W * ((i * 0.137 + 0.05) % 1)) + Math.sin(t * 0.4 + i * 1.7) * 30;
    const y = (H * ((i * 0.291 + 0.2) % 1)) + Math.cos(t * 0.33 + i * 2.3) * 22;
    const a = 0.25 + 0.35 * Math.max(0, Math.sin(t * 1.3 + i * 0.9));
    ctx.fillStyle = 'rgba(255,214,120,' + a + ')';
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLake(now) {
  const { x, y, s } = lake;
  const G = s * N;
  const m = Math.max(8, s * 0.35);
  // The shore, then the water inside it.
  ctx.save();
  rr(x - m, y - m, G + 2 * m, G + 2 * m, m * 1.6);
  ctx.fillStyle = C.shore;
  ctx.fill();
  const wg = ctx.createRadialGradient(x + G / 2, y + G * 0.4, G * 0.1, x + G / 2, y + G / 2, G * 0.75);
  wg.addColorStop(0, C.water0);
  wg.addColorStop(1, C.water1);
  rr(x - m * 0.35, y - m * 0.35, G + m * 0.7, G + m * 0.7, m);
  ctx.fillStyle = wg;
  ctx.fill();
  // The moon's path on the water, a few shimmering strokes.
  ctx.clip();
  for (let i = 0; i < 9; i++) {
    const yy = y + G * (0.08 + i * 0.1);
    const w = G * (0.08 + 0.05 * Math.sin(now / 700 + i * 1.3));
    ctx.fillStyle = 'rgba(246,236,198,' + (0.05 + 0.03 * Math.sin(now / 500 + i)) + ')';
    ctx.fillRect(x + G * 0.72 - w / 2 + Math.sin(now / 900 + i) * 4, yy, w, 1.6);
  }
  ctx.restore();
  // Reeds on the shore corners.
  ctx.strokeStyle = C.reed;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  for (const [rx, ry, dir] of [[x - m * 0.6, y + G * 0.15, -1], [x + G + m * 0.6, y + G * 0.7, 1], [x + G * 0.2, y + G + m * 0.6, -1]]) {
    for (let k = 0; k < 4; k++) {
      const sway = Math.sin(now / 800 + k) * 2;
      ctx.beginPath();
      ctx.moveTo(rx + k * 3 * dir, ry + 6);
      ctx.quadraticCurveTo(rx + k * 3 * dir + sway, ry - 6, rx + k * 3 * dir + sway * 2 + dir * 3, ry - 14 - k * 2);
      ctx.stroke();
    }
  }
  // The grid: a dot at every crossing, quiet enough to stay out of the way.
  ctx.fillStyle = C.grid;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) ctx.fillRect(x + i * s - 1, y + j * s - 1, 2, 2);
  }
  ctx.strokeStyle = 'rgba(190,225,255,0.05)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, G - 1, G - 1);
}

function fishShape(x, y, r, k, flip) {
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.fillStyle = FISH_COL[k];
  ctx.beginPath();
  ctx.ellipse(0, 0, r, r * 0.48, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-r * 0.8, 0);
  ctx.lineTo(-r * 1.45, -r * 0.5);
  ctx.lineTo(-r * 1.45, r * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(10,20,34,0.85)';
  ctx.beginPath();
  ctx.arc(r * 0.5, -r * 0.1, Math.max(0.8, r * 0.11), 0, Math.PI * 2);
  ctx.fill();
  if (k === 1) {
    ctx.strokeStyle = 'rgba(20,60,30,0.6)';
    ctx.lineWidth = Math.max(1, r * 0.12);
    for (const dx of [-0.25, 0.05, 0.35]) {
      ctx.beginPath();
      ctx.moveTo(r * dx, -r * 0.38);
      ctx.lineTo(r * dx, r * 0.38);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function bobber(x, y, r, color, sq) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1 + 0.25 * sq, 1 - 0.25 * sq);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(0, r * 0.9, r * 1.2, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f4f1ea';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(10,20,34,0.8)';
  ctx.lineWidth = Math.max(1, r * 0.18);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(0, -r * 1.7);
  ctx.stroke();
  ctx.restore();
}

function lamp(x, y, r, color, letter, lit) {
  ctx.save();
  if (lit) { ctx.shadowColor = color; ctx.shadowBlur = r * 1.4; }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(8,14,24,0.85)';
  ctx.lineWidth = Math.max(1.2, r * 0.18);
  ctx.stroke();
  if (letter) text(letter, x, y + 0.5, r * 1.1, C.sky1, 'center', 900);
  ctx.restore();
}

function button(id, label, x, y, w, h, enabled, fill, ink, glow) {
  const pressed = press === id;
  ctx.save();
  ctx.globalAlpha = enabled ? 1 : 0.4;
  if (glow) { ctx.shadowColor = fill; ctx.shadowBlur = 16; }
  rr(x, y + (pressed ? 2 : 0), w, h, Math.min(h / 2, 18));
  ctx.fillStyle = fill || 'rgba(255,255,255,0.08)';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  if (!fill) { ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke(); }
  text(label, x + w / 2, y + h / 2 + (pressed ? 2 : 0), Math.min(18, h * 0.38), ink || C.text, 'center', 800, w - 16);
  ctx.restore();
  btnRect.set(id, { x, y, w, h });
  if (enabled) btns.push({ id, x, y, w, h });
}

function drawMute() {
  const s = 30, x = W - PAD - s, y = 6;
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

function standings() {
  return S.seats.slice().sort((a, b) => b.sc - a.sc || b.n - a.n);
}

// My rings: inside a ring there was no fish when it was read, on it there was
// at least one. The newest is bright and the older ones fade, because fish
// drift and a reading goes stale.
function drawRings(now) {
  const me = myId();
  const col = colorOf(me);
  const { x, y, s } = lake;
  const newest = rings.length ? Math.max(...rings.map((r) => r.turn)) : 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, s * N, s * N);
  ctx.clip();
  for (const r of rings) {
    if (r.g !== S.g || r.sr !== S.sr) continue;
    const age = (S.ph === 'cast' ? S.turn - 1 : newest) - r.turn;
    if (age >= RING_TURNS || now < r.at) continue;
    const fade = age <= 0 ? 1 : age === 1 ? 0.45 : 0.2;
    const grow = easeOut((now - r.at) / 550);
    const rx = cx(r.c), ry = cy(r.c);
    // The empty inside.
    if (r.d > 0) {
      const k = (r.d - 1) * grow + 0.5;
      ctx.fillStyle = 'rgba(4,10,20,' + 0.32 * fade + ')';
      ctx.fillRect(x + (rx + 0.5 - k) * s, y + (ry + 0.5 - k) * s, 2 * k * s, 2 * k * s);
    }
    // The ring itself, as a band of cells.
    const R = r.d * grow;
    const o = (R + 0.5) * s, i = Math.max(0, R - 0.5) * s;
    const ccx = x + (rx + 0.5) * s, ccy = y + (ry + 0.5) * s;
    ctx.fillStyle = alpha(col, 0.2 * fade);
    ctx.beginPath();
    ctx.rect(ccx - o, ccy - o, 2 * o, 2 * o);
    if (i > 0) ctx.rect(ccx + i, ccy - i, -2 * i, 2 * i);
    ctx.fill('evenodd');
    ctx.strokeStyle = alpha(col, 0.85 * fade);
    ctx.lineWidth = age <= 0 ? 2 : 1.2;
    rr(ccx - o + 1, ccy - o + 1, 2 * o - 2, 2 * o - 2, s * 0.25);
    ctx.stroke();
    // The number on the cast cell, and the way to go if I trail.
    text(String(r.d), ccx, ccy, s * 0.42, alpha(col, fade), 'center', 900);
    if (r.dir >= 0 && r.dir !== 4 && age <= 0) {
      const dx = (r.dir % 3) - 1, dy = Math.floor(r.dir / 3) - 1;
      const len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len;
      const a0 = s * 0.42, a1 = s * (0.42 + 0.5 * grow + 0.08 * Math.sin(now / 200));
      ctx.strokeStyle = C.lamp;
      ctx.fillStyle = C.lamp;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(ccx + ux * a0, ccy + uy * a0);
      ctx.lineTo(ccx + ux * a1, ccy + uy * a1);
      ctx.stroke();
      const hx = ccx + ux * (a1 + 5), hy = ccy + uy * (a1 + 5);
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - ux * 7 - uy * 4.5, hy - uy * 7 + ux * 4.5);
      ctx.lineTo(hx - ux * 7 + uy * 4.5, hy - uy * 7 - ux * 4.5);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

// Where everybody cast, once it is public: the turn being revealed in full,
// the one before as small markers, so anybody can read where the room is
// looking.
function drawTrail(now) {
  const s = lake.s;
  const showing = S.ph === 'show' && S.last ? S.last.turn : -1;
  for (const t of trail) {
    if (t.turn === showing) continue;
    const age = S.turn - t.turn;
    if (age > 2) continue;
    const a = age <= 1 ? 0.75 : 0.35;
    // Several casters on one cell sit side by side.
    const byCell = new Map();
    for (const r of t.casts) { if (!byCell.has(r[1])) byCell.set(r[1], []); byCell.get(r[1]).push(r); }
    for (const [c, rows] of byCell) {
      const p = cellCenter(c);
      rows.forEach((r, k) => {
        const off = (k - (rows.length - 1) / 2) * s * 0.22;
        ctx.globalAlpha = a;
        ctx.fillStyle = colorOf(r[0]);
        ctx.beginPath();
        ctx.arc(p.x + off, p.y + s * 0.3, Math.max(2, s * 0.09), 0, Math.PI * 2);
        ctx.fill();
        if (r[2] === 1) { ctx.globalAlpha = a * 0.8; fishShape(p.x, p.y - s * 0.05, s * 0.17, kindOf(r[3], t.turn), false); }
        if (r[2] === 2) {
          ctx.globalAlpha = a * 0.8;
          ctx.strokeStyle = C.red;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(p.x - s * 0.15, p.y - s * 0.15); ctx.lineTo(p.x + s * 0.15, p.y + s * 0.05);
          ctx.moveTo(p.x + s * 0.15, p.y - s * 0.15); ctx.lineTo(p.x - s * 0.15, p.y + s * 0.05);
          ctx.stroke();
        }
      });
    }
  }
  ctx.globalAlpha = 1;
}

// The reveal: every line flies from its owner's chip to its cell, lands, and
// then the lake answers each one.
function drawReveal(now) {
  const l = S.last;
  const s = lake.s;
  const t = (now - phaseAt) / 1000;
  const byCell = new Map();
  for (const r of l.casts) { if (!byCell.has(r[1])) byCell.set(r[1], []); byCell.get(r[1]).push(r); }
  for (const [c, rows] of byCell) {
    const p = cellCenter(c);
    rows.forEach((r, k) => {
      const [id, , res, v] = r;
      const col = colorOf(id);
      const from = seatRect.get(id);
      const fx = from ? from.x + from.w / 2 : W / 2, fy = from ? from.y + from.h : lake.y - 20;
      const off = (k - (rows.length - 1) / 2) * s * 0.26;
      const tx = p.x + off, ty = p.y;
      const f = easeInOut(t / 0.55);
      const bx = fx + (tx - fx) * f, by = fy + (ty - fy) * f - Math.sin(f * Math.PI) * s * 1.6;
      // The line, slack once the bobber is down.
      ctx.strokeStyle = alpha(col, t < 2.6 ? 0.5 : Math.max(0, 0.5 - (t - 2.6)));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo((fx + bx) / 2, Math.min(fy, by) - s * (f < 1 ? 1.2 : 0.2), bx, by);
      ctx.stroke();
      const land = t > 0.55 ? Math.max(0, 1 - (t - 0.55) * 4) : 0;
      const bob = t > 0.55 ? Math.sin((t - 0.55) * 6) * s * 0.03 : 0;
      bobber(bx, by + bob, Math.max(3, s * 0.15), col, land);
      if (t > 0.7) {
        if (res === 1 && k === 0) {
          // The fish leaps and flies to whoever landed it.
          const q = clamp((t - 0.7) / 0.9, 0, 1);
          const e = easeInOut(q);
          const jx = p.x + (fx - p.x) * e, jy = p.y + (fy - p.y) * e - Math.sin(q * Math.PI) * s * 1.4;
          ctx.globalAlpha = 1 - clamp((t - 1.5) * 3, 0, 1);
          fishShape(jx, jy, s * (0.28 + 0.1 * Math.sin(q * Math.PI)), kindOf(v, l.turn), fx < p.x);
          ctx.globalAlpha = 1;
        } else if (res === 2 && k === 0) {
          // A tangle: the lines knot and the fish darts off.
          const q = clamp((t - 0.7) / 0.8, 0, 1);
          ctx.globalAlpha = 1 - q;
          fishShape(p.x + q * s * 1.2, p.y + Math.sin(q * 12) * s * 0.06, s * 0.24, KIND_VALUE.indexOf(v) < 0 ? 0 : KIND_VALUE.indexOf(v), false);
          ctx.globalAlpha = 1;
          text('TANGLE', p.x, p.y - s * 0.62, Math.max(10, s * 0.3), C.red, 'center', 900);
        }
      }
    });
  }
  // Ripples where each bobber went in.
  for (const rp of ripples) {
    const p = cellCenter(rp.c);
    const q = (now - rp.at) / 1400;
    for (let k = 0; k < 2; k++) {
      const qq = q - k * 0.2;
      if (qq <= 0 || qq >= 1) continue;
      ctx.strokeStyle = 'rgba(200,235,255,' + 0.5 * (1 - qq) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + s * 0.1, s * 0.6 * qq + 2, s * 0.25 * qq + 1, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawAim(now, dt) {
  if (!isCell(aim)) return;
  const p = cellCenter(aim);
  if (aimX < 0) { aimX = p.x; aimY = p.y; }
  aimX = follow(aimX, p.x, dt, 22);
  aimY = follow(aimY, p.y, dt, 22);
  const s = lake.s;
  const line = myLine();
  const col = colorOf(myId());
  const pulse = 1 + 0.06 * Math.sin(now / 160);
  const h = s * 0.5 * (line ? 0.9 : pulse);
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  if (!line) ctx.setLineDash([5, 4]);
  rr(aimX - h, aimY - h, 2 * h, 2 * h, s * 0.18);
  ctx.stroke();
  ctx.setLineDash([]);
  if (line) bobber(aimX, aimY, Math.max(3, s * 0.15), col, squash);
  ctx.restore();
}

function drawFinalFish(now) {
  const s = lake.s;
  const k = easeOut((now - overAt) / 600);
  for (const [c, kind] of S.fish) {
    const p = cellCenter(c);
    ctx.globalAlpha = k;
    ctx.fillStyle = alpha(FISH_COL[kind], 0.18);
    ctx.beginPath();
    ctx.arc(p.x, p.y, s * 0.45, 0, Math.PI * 2);
    ctx.fill();
    fishShape(p.x, p.y + Math.sin(now / 400 + c) * 1.5, s * 0.26, kind, c % 2 === 0);
  }
  ctx.globalAlpha = 1;
}

// ── the frame ───────────────────────────────────────────────────────────────

let prevNow = performance.now();
let lastTickSec = -1;
const shown = new Map();       // seat id -> score as counted up on screen

function frame(now) {
  const dt = clamp((now - prevNow) / 1000, 0, 0.1);
  prevNow = now;
  runLater(now);
  stepFx(dt, now);
  btns = [];
  btnRect.clear();

  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawBackground(now);
  if (S.g === 0 || S.ph === 'wait') drawLobby(now);
  else drawTable(now, dt);
  drawFireflies(now);
  for (const p of parts) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const k = p.t / 1.3;
    ctx.save();
    ctx.globalAlpha = 1 - k * k;
    const sc = 1 + 0.4 * (1 - easeOut(p.t * 4));
    ctx.translate(p.x, p.y - 36 * easeOut(k));
    ctx.scale(sc, sc);
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(8,14,24,0.85)';
    font(20, 900);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText(p.s, 0, 0);
    ctx.fillStyle = p.color;
    ctx.fillText(p.s, 0, 0);
    ctx.restore();
  }
  ctx.restore();
  drawMute();
  requestAnimationFrame(frame);
}

function lobbyIds() {
  const ids = [];
  if (room.me) ids.push(myId());
  for (const id of S.q) if (!ids.includes(id) && inRoom(id)) ids.push(id);
  return ids.slice(0, MAX_SEATS);
}

function drawLobby(now) {
  const people = solo() ? [] : lobbyIds();
  const pw = Math.min(W - 2 * PAD, 440);
  const cut = H < 380 ? 70 : 0;
  const ph = 370 - cut;
  const x = (W - pw) / 2, y = Math.max(8, (H - ph) / 2) - cut;
  rr(x, y + cut, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (!cut) {
    // A little scene: a bobber, a ring, a fish just under it.
    const sx = x + pw / 2, sy = y + 50;
    const q = (now / 1800) % 1;
    ctx.strokeStyle = alpha(PAL[2], 0.7 * (1 - q));
    ctx.lineWidth = 2;
    rr(sx - 10 - q * 34, sy - 10 - q * 34, 20 + q * 68, 20 + q * 68, 8);
    ctx.stroke();
    fishShape(sx + 30, sy + 12 + Math.sin(now / 500) * 2, 9, 2, false);
    bobber(sx, sy + Math.sin(now / 400) * 2, 7, PAL[2], 0);
  }
  text('LANTERN LAKE', x + pw / 2, y + 112, 27, C.text, 'center', 900, pw - 24);
  const lines = [
    'Ten casts on a dark lake. Everyone casts at once.',
    'Your sonar ring, yours alone, says how far the nearest fish is.',
    'Everyone sees where you cast. Two lines on one fish tangle.',
    'The last three casts count double.',
  ];
  lines.forEach((l, i) => text(l, x + pw / 2, y + 144 + i * 20, 13.5, C.dim, 'center', 500, pw - 28));
  let yy = y + 236;
  if (people.length) {
    const dot = 12, gap = 6;
    const total = people.length * (dot + gap) - gap;
    people.forEach((id, i) => lamp(x + pw / 2 - total / 2 + i * (dot + gap) + dot / 2, yy, dot / 2, PAL[i % PAL.length], '', true));
    yy += 22;
  }
  const n = people.length;
  const status = solo() ? 'No room here: practise against three bots.'
    : n < 2 ? 'Waiting for a second player to run the disk.'
    : n + ' players ready. Anyone can start.';
  text(status, x + pw / 2, yy, 13, C.faint, 'center', 500, pw - 28);
  const label = solo() || n < 2 ? 'Practice vs bots' : 'Light the lanterns';
  button('go', label, x + pw / 2 - 100, y + ph + cut - 68, 200, 46, true, C.lamp, C.lampDeep, true);
  text(coarse ? 'Tap to start' : 'Enter to start', x + pw / 2, y + ph + cut - 12, 11, C.faint, 'center', 500);
}

function drawTable(now, dt) {
  const seats = S.seats;
  const L = seatsLayout(seats.length);
  const me = mySeat();
  const left = Math.max(0, endAt - now);

  // Top bar: the title, the cast, the clock.
  text('LANTERN LAKE', PAD, 21, 14, C.text, 'left', 900);
  font(14, 900);
  const tw = ctx.measureText('LANTERN LAKE').width;
  const isDusk = dusk(S.turn);
  const turnLabel = 'Cast ' + Math.max(1, S.turn) + '/' + TURNS + (isDusk ? '  ·  DUSK ×2' : '') + '  ·  ' + S.nf + ' fish';
  text(turnLabel, PAD + tw + 12, 21, 12, isDusk ? C.lamp : C.dim, 'left', 700, W - PAD * 2 - tw - 110);
  if (S.ph === 'cast') {
    const sec = Math.ceil(left / 1000);
    text(sec + 's', W - PAD - 42, 21, 14, left < 3000 ? C.red : C.text, 'right', 800);
    if (sec <= 3 && sec > 0 && sec !== lastTickSec && canCast()) sfx.tick();
    lastTickSec = sec;
  }

  // Seats.
  seatRect.clear();
  seats.forEach((s, i) => {
    const r = L.rects[i];
    seatRect.set(s.id, r);
    const col = PAL[i % PAL.length];
    const here = present(s.id);
    const mine = s.id === myId();
    ctx.save();
    if (!here) ctx.globalAlpha = 0.4;
    rr(r.x, r.y, r.w, r.h, 10);
    ctx.fillStyle = alpha(col, mine ? 0.2 : 0.09);
    ctx.fill();
    ctx.strokeStyle = alpha(col, mine ? 0.9 : 0.4);
    ctx.lineWidth = mine ? 2 : 1.2;
    ctx.stroke();
    const ar = 8;
    const ax = r.x + 6 + ar, ay = r.y + 13;
    const name = nickOf(s.id);
    const lit = S.ph === 'cast' && S.locked.includes(s.id);
    lamp(ax, ay, ar, col, name.slice(0, 1).toUpperCase(), lit);
    const cur = shown.has(s.id) ? shown.get(s.id) : s.sc;
    const nv = Math.abs(s.sc - cur) < 0.5 ? s.sc : follow(cur, s.sc, dt, 5);
    shown.set(s.id, nv);
    text(clip(name + (mine && !solo() ? ' (you)' : ''), 11, r.w - ar * 2 - 40), ax + ar + 5, ay, 11, C.text, 'left', 600);
    text(String(Math.round(nv)), r.x + r.w - 7, ay + 1, 16, C.lamp, 'right', 800);
    let status = '', sc = C.faint;
    if (S.ph === 'cast') {
      if (S.locked.includes(s.id)) { status = 'line in'; sc = C.text; }
      else status = 'aiming' + '...'.slice(0, 1 + Math.floor(now / 400) % 3);
    } else status = s.n + ' fish';
    text(status, r.x + 8, r.y + r.h - 9, 10, sc, 'left', 700, r.w * 0.5);
    if (S.ph !== 'over' && trailing(s.id)) text('DEEP SONAR', r.x + r.w - 7, r.y + r.h - 9, 9, C.lamp, 'right', 800, r.w * 0.45);
    ctx.restore();
  });

  // The lake fills what is left between the chips and the controls.
  const ctrlH = 48;
  const howY = H - 12;
  const ctrlTop = howY - 12 - ctrlH;
  const top = L.bottom + 18;
  const room0 = Math.max(60, Math.min(W - 2 * PAD - 16, ctrlTop - top - 14));
  const s = Math.floor(room0 / N);
  lake = { x: Math.round((W - s * N) / 2), y: Math.round(top + (ctrlTop - top - s * N) / 2), s };

  drawLake(now);
  if (S.ph === 'over') drawFinalFish(now);
  drawRings(now);
  drawTrail(now);
  if (S.ph === 'show' && S.last) drawReveal(now);
  if (S.ph === 'cast' && me) drawAim(now, dt);

  // The pond was stirred: the host changed and the fish moved with it.
  const st = (now - stirAt) / 1000;
  if (st < 3) banner('The pond stirred: a new host, new fish. Old rings are gone.', lake.y + lake.s * 0.6, clamp(Math.min(st / 0.25, (3 - st) / 0.5), 0, 1));
  // A new cast announces itself; dusk louder.
  const pt0 = (now - phaseAt) / 1000;
  if (S.ph === 'cast' && pt0 < 1.4 && st >= 3) {
    const k = clamp(Math.min(pt0 / 0.2, (1.4 - pt0) / 0.4), 0, 1);
    const label = S.turn === TURNS ? 'LAST CAST' : isDusk ? 'DUSK  ·  CAST ' + S.turn : 'CAST ' + S.turn;
    ctx.save();
    ctx.globalAlpha = k;
    const sc = 1 + 0.12 * (1 - easeOut(pt0 / 0.4));
    ctx.translate(W / 2, lake.y + lake.s * N / 2);
    ctx.scale(sc, sc);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(8,14,24,0.8)';
    font(Math.min(40, W / 10), 900);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = isDusk ? C.lamp : C.moon;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  // My control: the cast button, or what is going on.
  const bw = Math.min(260, W - 2 * PAD);
  const bx = W / 2 - bw / 2, by = ctrlTop + 2;
  if (S.ph === 'cast' && me) {
    const frac = clamp(left / CAST_MS, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    rr(bx, ctrlTop - 6, bw, 4, 2);
    ctx.fill();
    ctx.fillStyle = left < 3000 ? C.red : C.lamp;
    rr(bx, ctrlTop - 6, bw * frac, 4, 2);
    ctx.fill();
    const line = myLine();
    const label = line ? 'Line in. Waiting for the others' : 'CAST at ' + cellName(aim);
    button('cast', label, bx, by, bw, ctrlH - 4, !line, line ? null : colorOf(myId()), line ? C.dim : C.sky1, !line);
  } else {
    let msg = '';
    if (!me && S.ph !== 'over') msg = 'You are watching. You join at the next cast.';
    else if (S.ph === 'show') msg = summary();
    if (msg) text(msg, W / 2, by + ctrlH / 2 - 2, 14, C.dim, 'center', 600, W - 2 * PAD);
  }

  // One line of how-to, always on screen.
  const how = S.ph === 'cast' && me
    ? (coarse ? 'Tap or drag to aim, tap again to cast. A ring is how far the nearest fish is.'
      : 'Click to aim, click again or Space to cast. Arrows move. A ring is how far the nearest fish is.')
    : 'Inside your ring: no fish. On it: at least one. Lone lines land fish; shared ones tangle.';
  text(how, W / 2, howY, 11.5, C.faint, 'center', 500, W - 2 * PAD);

  if (S.ph === 'over') drawOver(now);
}

function cellName(c) {
  if (!isCell(c)) return '';
  return 'ABCDEFGHI'[cx(c)] + (cy(c) + 1);
}

function summary() {
  const l = S.last;
  if (!l) return '';
  const caught = l.casts.filter((r) => r[2] === 1);
  const tangled = l.casts.filter((r) => r[2] === 2);
  const bits = [];
  for (const r of caught) bits.push(nickOf(r[0]) + ' landed a ' + KIND_NAME[kindOf(r[3], l.turn)]);
  if (tangled.length) bits.push(tangled.length + ' lines tangled');
  return bits.length ? bits.join(' · ') : 'Nothing bit.';
}

function banner(msg, y, k) {
  ctx.save();
  ctx.globalAlpha = k;
  font(13, 800);
  const w = Math.min(W - 2 * PAD, ctx.measureText(msg).width + 32);
  rr(W / 2 - w / 2, y - 14, w, 28, 14);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  text(msg, W / 2, y, 13, C.text, 'center', 800, w - 20);
  ctx.restore();
}

function drawOver(now) {
  const k = easeOut((now - overAt) / 450);
  ctx.fillStyle = 'rgba(6,12,22,' + 0.4 * k + ')';
  ctx.fillRect(0, 0, W, H);
  const list = standings();
  const pw = Math.min(W - 2 * PAD, 360);
  const rowH = 25;
  const ph = Math.min(H - 20, 128 + list.length * rowH);
  const x = (W - pw) / 2, y = (H - ph) / 2 + (1 - k) * 30;
  ctx.save();
  ctx.globalAlpha = k;
  rr(x, y, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const top = list[0];
  const winners = top ? list.filter((s) => s.sc === top.sc && s.n === top.n) : [];
  const title = !winners.length ? 'The lanterns go out'
    : winners.length > 1 ? 'A tie at ' + top.sc
    : nickOf(top.id) + (top.id === myId() && !solo() ? ' (you)' : '') + ' wins';
  text(title, x + pw / 2, y + 30, 22, winners.length === 1 ? colorOf(top.id) : C.text, 'center', 900, pw - 28);
  list.forEach((s, i) => {
    const yy = y + 62 + i * rowH;
    if (yy > y + ph - 62) return;
    lamp(x + 28, yy, 7, colorOf(s.id), '', i === 0);
    text((i + 1) + '.  ' + clip(nickOf(s.id), 14, pw - 150), x + 42, yy, 14, C.text, 'left', 600);
    text(s.n + ' fish', x + pw - 62, yy, 11, C.faint, 'right', 500);
    text(String(s.sc), x + pw - 22, yy, 16, C.lamp, 'right', 800);
  });
  const readyNow = now - overAt >= DEAL_COOLDOWN;
  const people = solo() ? 0 : S.seats.filter((s) => !isBot(s.id) && present(s.id)).length + S.q.length;
  button('go', people >= 2 ? 'Fish again' : 'Practice again', x + pw / 2 - 90, y + ph - 54, 180, 42, readyNow, C.lamp, C.lampDeep, readyNow);
  ctx.restore();
}

// ── input ───────────────────────────────────────────────────────────────────

function pt(e) {
  const b = cv.getBoundingClientRect();
  return { x: e.clientX - b.left, y: e.clientY - b.top };
}
const insideRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
function buttonAt(p) { const b = btns.find((x) => insideRect(p, x)); return b ? b.id : ''; }
function act(id) {
  if (id === 'mute') { muted = !muted; if (!muted) sfx.aim(); }
  else if (id === 'go') go();
  else if (id === 'cast') cast();
}

// A press on the lake aims, a drag moves the aim, and a tap on the cell that
// was already aimed at casts. Nothing waits on a long press, which a phone
// keeps for itself.
let drag = null;   // { id, before, down, moved }
cv.addEventListener('pointerdown', (e) => {
  audio();
  const p = pt(e);
  const id = buttonAt(p);
  press = id;
  drag = { id, before: aimKey === turnKey() ? aim : -1, down: -1, moved: false };
  if (!id && canCast()) {
    const c = cellAt(p, false);
    if (c >= 0) { drag.down = c; setAim(c); }
  }
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ }
  e.preventDefault();
});
cv.addEventListener('pointermove', (e) => {
  const p = pt(e);
  if (drag && drag.down >= 0 && canCast()) {
    const c = cellAt(p, true);
    if (c !== drag.down) drag.moved = true;
    setAim(c);
  }
  if (e.pointerType === 'mouse') {
    cv.style.cursor = buttonAt(p) || (canCast() && cellAt(p, false) >= 0) ? 'pointer' : 'default';
  }
});
cv.addEventListener('pointerup', (e) => {
  const p = pt(e);
  if (drag) {
    if (drag.id && buttonAt(p) === drag.id) act(drag.id);
    else if (drag.down >= 0 && !drag.moved && drag.down === drag.before && canCast()) cast();
  }
  drag = null;
  press = '';
});
cv.addEventListener('pointercancel', () => { drag = null; press = ''; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  audio();
  const k = e.key;
  if (k === 'm' || k === 'M') { act('mute'); return; }
  if ((S.g === 0 || S.ph === 'wait' || S.ph === 'over') && (k === 'Enter' || k === ' ')) { go(); e.preventDefault(); return; }
  if (!canCast()) return;
  const a = isCell(aim) ? aim : (CELLS - 1) / 2;
  let x = cx(a), y = cy(a);
  if (k === 'ArrowUp' || k === 'w' || k === 'W') y--;
  else if (k === 'ArrowDown' || k === 's' || k === 'S') y++;
  else if (k === 'ArrowLeft' || k === 'a' || k === 'A') x--;
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') x++;
  else if (k === ' ' || k === 'Enter') { if (!e.repeat) cast(); e.preventDefault(); return; }
  else return;
  e.preventDefault();
  setAim(clamp(y, 0, N - 1) * N + clamp(x, 0, N - 1));
});

// ── start ───────────────────────────────────────────────────────────────────

setInterval(hostTick, 100);
requestAnimationFrame(frame);
// Nothing is replayed, so a disk that has just started says so and asks where
// the game is. With no room around it this goes nowhere, and the practice
// lake is a click away.
observe(performance.now(), 0);
