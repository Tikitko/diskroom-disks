/**
 * @disk     outbid
 * @author   claude
 * @version  2
 * @players  2-8
 * @about    A sealed-bid auction. Everyone holds cards 1 to 15 and spends one per prize tile: the highest bid nobody matched takes a plus tile, the lowest takes a minus one. Matching bids cancel and the pot rolls over.
 * @tags     game, party, cards, auction, bluffing
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/outbid.png
 */
// outbid.js — a sealed-bid card auction, run by the host.
//
// Each turn a prize tile flips onto the pot. Every seated player plays one card
// from a hand of 1..15, face down; each card is spent once a game. When the
// cards turn over, any value played by two or more people cancels. Of the bids
// left, the highest takes a plus pot and the lowest takes a minus pot. If every
// bid cancelled, the pot stays and the next tile lands on top of it.
//
// The host is the authority. A bid travels to the host alone, addressed, so no
// other seat has it on the wire before the reveal; the host checks it against
// that player's hand, and only the host's broadcasts move the table. Every
// hand is public on purpose: which cards a rival has left is the information
// the game is about. What this does not stop is a hostile host: the host's
// own copy holds the bids before the reveal and the order of the tiles, and
// nothing in a host-run game can take that away from it.
//
// A player alone is dealt a practice game against two bots at once, and
// another after it, for as long as nobody else is here. When somebody joins,
// practice ends three seconds on under a note that says so, and the host deals
// the real game.

// ── rules ───────────────────────────────────────────────────────────────────

const CARDS = 15;
const FULL = (1 << CARDS) - 1;          // a hand is a bit mask: bit c-1 holds card c
const TILES = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TURNS = TILES.length;
const BID_MS = 12000;                   // time to bid, set by the host's clock
const SHOW_MS = 3800;                   // how long a reveal stays up
const DEAL_COOLDOWN = 2500;             // a finished game is on screen at least this long
const PRACTICE_AGAIN = 6000;            // a finished practice game is on screen this long before the next
const JOIN_MS = 3000;                   // practice runs on this long after somebody joins
const MAX_SEATS = 8;
const BOT_NAMES = ['Bot Ada', 'Bot Rex'];

// One colour per seat, in seat order, so no two players at a table share one.
const PAL = ['#ff7a7a', '#ffd166', '#4ee0a8', '#5cc8ff', '#b79cff', '#ff9f5a', '#ff6fb5', '#a3d977'];
const C = {
  bg0: '#1b2140', bg1: '#0f1326', panel: 'rgba(16,20,40,0.92)', line: '#2c3563',
  text: '#f3f1ea', dim: '#aab0d0', faint: '#6b7299',
  gold: '#ffcf5a', goldDeep: '#3d2f0c', red: '#ff5d73', redDeep: '#3d0f18',
  card: '#f6efe0', cardInk: '#1c1f33',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g      game number, so a stale bid for an old game is recognised
//   ph     'wait' | 'bid' | 'show' | 'over'
//   turn   1..TURNS, the tile being bid on
//   pot    tiles in the pot now (more than one after a carry-over)
//   out    every tile flipped this game, so a new host knows what is left
//   seats  [{ id, hand, score, won }]
//   locked ids that have a bid in, never which card
//   last   the reveal: { bids: [[id, card]], win, val, pot }
let S = { g: 0, ph: 'wait', turn: 0, pot: [], out: [], seats: [], locked: [], last: null };
let endAt = 0;           // local clock: when this phase ends
let joinEnd = 0;         // local clock: when practice ends for somebody who joined, 0 if it does not
let overAt = -1e9;       // local clock: when the last game ended

// The host's alone.
let deck = [];
const bids = new Map();  // seat id -> card, never broadcast before the reveal
const botAt = new Map(); // bot seat id -> when it bids
let lastPub = 0;
let shortAt = 0;         // when the table last fell below two players, 0 if it has not
const GRACE = 8000;      // how long a dropped connection has to come back

// Mine.
let myPick = null;       // { g, turn, c }
let sentKey = '';        // which host and turn my pick was last sent to
let sendTimer = null;
let lastSend = 0;

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
const present = (id) => (id < -1 ? true : id === -1 ? solo() : inRoom(id));
const isBot = (id) => id < -1;
const seatOf = (id) => S.seats.find((s) => s.id === id) || null;
const mySeat = () => seatOf(myId());
const has = (hand, c) => ((hand >> (c - 1)) & 1) === 1;
const handSize = (hand) => { let n = 0; for (let c = 1; c <= CARDS; c++) if (has(hand, c)) n++; return n; };
const lowest = (hand) => { for (let c = 1; c <= CARDS; c++) if (has(hand, c)) return c; return 0; };
const potValue = (pot) => pot.reduce((a, b) => a + b, 0);

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

// Who takes a pot worth `val`, given everybody's [id, card]. A card played by
// two or more cancels; of the unique ones, the highest takes a plus pot and
// the lowest takes a minus pot. Null when every bid cancelled.
function winnerOf(list, val) {
  const count = new Map();
  for (const [, c] of list) count.set(c, (count.get(c) || 0) + 1);
  let best = null;
  for (const [id, c] of list) {
    if (count.get(c) !== 1) continue;
    if (best === null || (val >= 0 ? c > best[1] : c < best[1])) best = [id, c];
  }
  return best ? best[0] : null;
}

// ── the host ────────────────────────────────────────────────────────────────

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The tiles not yet flipped. A host that inherits a game mid-way never saw
// the old host's deck, so it deals the rest of the set in an order of its own.
function remainingTiles() {
  const left = TILES.slice();
  for (const t of S.out) {
    const i = left.indexOf(t);
    if (i >= 0) left.splice(i, 1);
  }
  return left;
}

const canDeal = (now) => S.ph === 'wait' || (S.ph === 'over' && now - overAt >= DEAL_COOLDOWN);
const people = () => (solo() ? 1 : room.players.length);
const practiceTable = () => S.g > 0 && S.ph !== 'wait' && S.seats.some((s) => isBot(s.id));

// `force` deals over a game still running: the practice game somebody joined.
function hostDeal(force) {
  const now = performance.now();
  if (!amHost() || (!force && !canDeal(now))) return;
  joinEnd = 0;
  let ids = solo() ? [-1] : room.players.slice(0, MAX_SEATS).map((p) => p.id);
  // Fewer than two people is a practice table: the host is dealt two bots.
  if (ids.length < 2) ids = ids.concat([-2, -3]);
  S = {
    g: S.g + 1, ph: 'bid', turn: 0, pot: [], out: [], locked: [], last: null,
    seats: ids.map((id) => ({ id, hand: FULL, score: 0, won: 0 })),
  };
  deck = shuffle(TILES.slice());
  shortAt = 0;
  nextTurn(now);
}

function scheduleBots(now) {
  botAt.clear();
  for (const s of S.seats) if (isBot(s.id)) botAt.set(s.id, now + 1800 + Math.random() * 5000);
}

function nextTurn(now) {
  if (!deck.length) { finish(now); return; }
  const t = deck.pop();
  S.pot.push(t);
  S.out.push(t);
  S.turn += 1;
  S.ph = 'bid';
  S.locked = [];
  S.last = null;
  bids.clear();
  scheduleBots(now);
  endAt = now + BID_MS;
  publish(now);
}

function finish(now) {
  S.ph = 'over';
  S.locked = [];
  bids.clear();
  botAt.clear();
  endAt = now;
  overAt = now;
  publish(now);
}

// A bid, from whoever the room says sent it. It counts only for the game and
// turn on the table, for a seated player who is here, and for a card still in
// that player's hand; it may be changed until the reveal.
function hostSetBid(id, c, now) {
  if (S.ph !== 'bid') return;
  const s = seatOf(id);
  if (!s || !present(id) || !has(s.hand, c)) return;
  bids.set(id, c);
  if (!S.locked.includes(id)) {
    S.locked.push(id);
    publish(now);
  }
}

// A bot plays roughly what the pot is worth, a little higher for a big plus
// pot, and keeps away from the bottom of its hand when the pot is a minus.
function botPick(s) {
  const v = potValue(S.pot);
  const target = v >= 0 ? v * 1.35 + 1 + (Math.random() * 6 - 3) : 4 - v + (Math.random() * 6 - 3);
  let best = 0, gap = 1e9;
  for (let c = 1; c <= CARDS; c++) {
    if (!has(s.hand, c)) continue;
    const d = Math.abs(c - target);
    if (d < gap) { gap = d; best = c; }
  }
  return best;
}

function reveal(now) {
  const list = [];
  for (const s of S.seats) {
    if (!present(s.id) || !s.hand) continue;
    let c = bids.get(s.id);
    // Whoever did not bid in time plays their lowest card.
    if (!c || !has(s.hand, c)) c = lowest(s.hand);
    s.hand &= ~(1 << (c - 1));
    list.push([s.id, c]);
  }
  const val = potValue(S.pot);
  const pot = S.pot.slice();
  const win = winnerOf(list, val);
  if (win !== null) {
    const s = seatOf(win);
    s.score += val;
    s.won += pot.length;
    S.pot = [];
  }
  S.last = { bids: list, win, val, pot };
  S.ph = 'show';
  S.locked = [];
  bids.clear();
  botAt.clear();
  endAt = now + SHOW_MS;
  publish(now);
}

// A table with fewer than two players, or with nobody but bots, is over — but
// not on the instant: a dropped connection comes back as a leave and a join,
// and one blip must not end everybody's game.
function tooFew(live, now) {
  if (live.length >= 2 && live.some((s) => !isBot(s.id))) { shortAt = 0; return false; }
  if (!shortAt) shortAt = now;
  return now - shortAt > GRACE;
}

function hostTick() {
  if (!amHost()) return;
  const now = performance.now();
  // Alone, a practice game is dealt at once, and the next when it is over.
  if (people() < 2 && (S.ph === 'wait' || (S.ph === 'over' && now - overAt >= PRACTICE_AGAIN))) { hostDeal(); return; }
  // Somebody joined a practice game: it ends three seconds on, for the real one.
  if (people() >= 2 && practiceTable()) {
    if (!joinEnd) { joinEnd = now + JOIN_MS; publish(now); }
    else if (now >= joinEnd) { hostDeal(true); return; }
  } else if (joinEnd) { joinEnd = 0; publish(now); }
  if (S.ph === 'bid') {
    for (const [id, at] of botAt) {
      if (now < at) continue;
      botAt.delete(id);
      const s = seatOf(id);
      if (s && s.hand) hostSetBid(id, botPick(s), now);
    }
    const live = S.seats.filter((s) => present(s.id) && s.hand);
    if (tooFew(live, now)) { finish(now); return; }
    if (now >= endAt || live.every((s) => bids.has(s.id))) { reveal(now); return; }
  } else if (S.ph === 'show' && now >= endAt) {
    if (tooFew(S.seats.filter((s) => present(s.id)), now)) finish(now);
    else nextTurn(now);
    return;
  }
  // A heartbeat, so one lost broadcast is never the only thing that carried a
  // change, and a clock that drifted is put back.
  if (S.g > 0 && now - lastPub > 2500) publish(now);
}

function wire(now) {
  return {
    t: 'st', g: S.g, ph: S.ph, turn: S.turn, pot: S.pot, out: S.out,
    seats: S.seats.map((s) => [s.id, s.hand, s.score, s.won]),
    locked: S.locked,
    ms: Math.max(0, Math.round(endAt - now)),
    j: joinEnd ? Math.max(0, Math.round(joinEnd - now)) : -1,
    last: S.last,
  };
}

function publish(now) {
  lastPub = now;
  if (!solo()) room.send(wire(now));
  observe(now, Math.max(0, endAt - now));
}

// ── receiving ───────────────────────────────────────────────────────────────

// A table off the wire is a claim and is read as one: the right shape, numbers
// in range, lists of bounded length. Anything else is dropped whole.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isTile = (v) => TILES.includes(v);
const ID_MIN = -8, ID_MAX = 2147483647;

function stateOf(m) {
  if (!int(m.g, 1, 1e9) || !['bid', 'show', 'over'].includes(m.ph) || !int(m.turn, 0, TURNS)) return null;
  if (!Array.isArray(m.pot) || m.pot.length > TURNS || !m.pot.every(isTile)) return null;
  if (!Array.isArray(m.out) || m.out.length > TURNS || !m.out.every(isTile)) return null;
  if (!Array.isArray(m.seats) || m.seats.length < 1 || m.seats.length > MAX_SEATS) return null;
  const seats = [];
  for (const r of m.seats) {
    if (!Array.isArray(r) || r.length !== 4) return null;
    const [id, hand, score, won] = r;
    if (!int(id, ID_MIN, ID_MAX) || !int(hand, 0, FULL) || !int(score, -1000, 1000) || !int(won, 0, TURNS)) return null;
    if (seats.some((s) => s.id === id)) return null;
    seats.push({ id, hand, score, won });
  }
  const seated = (id) => seats.some((s) => s.id === id);
  if (!Array.isArray(m.locked) || m.locked.length > MAX_SEATS || !m.locked.every((id) => int(id, ID_MIN, ID_MAX) && seated(id))) return null;
  if (typeof m.ms !== 'number' || !Number.isFinite(m.ms)) return null;
  let last = null;
  if (m.last !== null && m.last !== undefined) {
    const l = m.last;
    if (!l || typeof l !== 'object' || !Array.isArray(l.bids) || l.bids.length > MAX_SEATS) return null;
    const list = [];
    for (const b of l.bids) {
      if (!Array.isArray(b) || b.length !== 2 || !seated(b[0]) || !int(b[1], 1, CARDS)) return null;
      list.push([b[0], b[1]]);
    }
    if (!(l.win === null || (int(l.win, ID_MIN, ID_MAX) && seated(l.win)))) return null;
    if (!int(l.val, -100, 100) || !Array.isArray(l.pot) || l.pot.length > TURNS || !l.pot.every(isTile)) return null;
    last = { bids: list, win: l.win, val: l.val, pot: l.pot.slice() };
  }
  const j = typeof m.j === 'number' && Number.isFinite(m.j) && m.j >= 0 ? Math.min(m.j, JOIN_MS) : -1;
  return {
    S: { g: m.g, ph: m.ph, turn: m.turn, pot: m.pot.slice(), out: m.out.slice(), seats, locked: m.locked.slice(), last },
    ms: Math.min(Math.max(m.ms, 0), BID_MS + SHOW_MS),
    j,
  };
}

// Every sender gets a bucket: ten messages a second, twenty at once. An honest
// copy sends a few a turn; one that floods is dropped here before any of its
// messages is even read, so it cannot stall the table for the rest.
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
      // A disk that has just started asks where the game is; the host answers
      // that one seat alone.
      case 'hello':
        if (amHost() && S.g > 0 && inRoom(from)) room.send(wire(now), { to: from });
        break;
      case 'bid':
        if (amHost() && from !== myId() && msg.g === S.g && msg.turn === S.turn && int(msg.c, 1, CARDS)) {
          hostSetBid(from, msg.c, now);
        }
        break;
      case 'deal':
        if (amHost() && inRoom(from)) hostDeal();
        break;
      case 'st': {
        if (amHost() || !fromHost(from)) break;
        const st = stateOf(msg);
        if (!st) break;
        S = st.S;
        endAt = now + st.ms;
        joinEnd = st.j >= 0 ? now + st.j : 0;
        observe(now, st.ms);
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
});

room.on('hostchange', () => {
  sentKey = '';
  if (!amHost() || S.g === 0) return;
  // The bids went to the old host and left with it, and so did its deck. The
  // turn on the table is bid again on a fresh clock; every copy that had
  // picked sends its pick again when it sees the new host's table.
  const now = performance.now();
  deck = shuffle(remainingTiles());
  bids.clear();
  if (S.ph === 'bid') {
    S.locked = [];
    endAt = now + BID_MS;
    scheduleBots(now);
    if (myPick && myPick.g === S.g && myPick.turn === S.turn) {
      const s = mySeat();
      if (s && has(s.hand, myPick.c)) { bids.set(myId(), myPick.c); S.locked.push(myId()); }
    }
  } else if (S.ph === 'show') {
    endAt = now + 1500;
  }
  publish(now);
});

// ── my moves ────────────────────────────────────────────────────────────────

const canBid = () => S.ph === 'bid' && !!mySeat() && mySeat().hand !== 0;

function sendPick() {
  if (sendTimer) return;
  // At most four bid messages a second, the last pick always going out: a
  // player flicking through cards is never cut off by the host's bucket.
  const wait = Math.max(0, lastSend + 250 - performance.now());
  sendTimer = setTimeout(() => {
    sendTimer = null;
    lastSend = performance.now();
    if (!myPick || myPick.g !== S.g || myPick.turn !== S.turn || !room.host || amHost()) return;
    room.send({ t: 'bid', g: myPick.g, turn: myPick.turn, c: myPick.c }, { to: room.host.id });
    sentKey = room.host.id + ':' + S.g + ':' + S.turn;
  }, wait);
}

function play(c) {
  const s = mySeat();
  if (!canBid() || !has(s.hand, c)) return;
  if (myPick && myPick.g === S.g && myPick.turn === S.turn && myPick.c === c) return;
  myPick = { g: S.g, turn: S.turn, c };
  sfx.pick();
  const r = cardRects.get(c);
  if (r) burst(r.x + r.w / 2, r.y, colorOf(myId()), 10, 140);
  if (amHost()) hostSetBid(myId(), c, performance.now());
  else sendPick();
}

function deal() {
  const now = performance.now();
  if (!canDeal(now)) return;
  sfx.pick();
  if (amHost()) hostDeal();
  else if (room.host) room.send({ t: 'deal' }, { to: room.host.id });
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects are drawn from the table as it changes on this screen, never sent.
let seenKey = '';
let seenLocked = new Set();
let turnAt = -1e9;
let revealAt = -1e9;
const fired = new Set();

function observe(now, ms) {
  const key = S.g + ':' + S.turn + ':' + S.ph;
  if (key !== seenKey) {
    const was = seenKey;
    seenKey = key;
    if (S.ph === 'bid') { turnAt = now - (BID_MS - ms); sfx.flip(); }
    if (S.ph === 'show') { revealAt = now - (SHOW_MS - ms); fired.clear(); }
    if (S.ph === 'over') {
      overAt = now;
      if (was) celebrate();
    }
    seenLocked = new Set();
  }
  if (myPick && (myPick.g !== S.g || myPick.turn !== S.turn)) myPick = null;
  // A soft click when somebody else's bid goes in; my own already had a sound.
  if (S.ph === 'bid' && S.locked.some((id) => id !== myId() && !seenLocked.has(id))) sfx.lock();
  seenLocked = new Set(S.locked);
  // A new host never saw my pick: send it again, once per host and turn.
  if (!amHost() && S.ph === 'bid' && myPick && room.host && !S.locked.includes(myId())) {
    if (sentKey !== room.host.id + ':' + S.g + ':' + S.turn) sendPick();
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
  pick: () => { tone(660, 0.07, 'triangle', 0.07); tone(990, 0.08, 'triangle', 0.05, null, 0.05); },
  lock: () => tone(420, 0.06, 'square', 0.025),
  flip: () => tone(300, 0.12, 'triangle', 0.06, 520),
  card: (i) => tone(520 + i * 40, 0.05, 'square', 0.03, null, i * 0.08),
  tie: () => { tone(140, 0.25, 'sawtooth', 0.07, 70); tone(110, 0.3, 'square', 0.04, 60, 0.03); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.06, null, i * 0.07)),
  sting: () => [392, 330, 262].forEach((f, i) => tone(f, 0.2, 'sawtooth', 0.04, null, i * 0.09)),
  carry: () => tone(200, 0.4, 'sine', 0.06, 600),
  land: () => tone(880, 0.12, 'sine', 0.07, 1320),
  tick: () => tone(1200, 0.03, 'square', 0.03),
  fanfare: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.06, null, i * 0.11)),
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

let W = 640, H = 400;
let coarse = matchMedia('(pointer: coarse)').matches;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  coarse = matchMedia('(pointer: coarse)').matches;
  W = cv.clientWidth || window.innerWidth || 640;
  H = cv.clientHeight || window.innerHeight || 400;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
layout();
window.addEventListener('resize', layout);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ease = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2; };
const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); };
const back = (t) => { t = clamp(t, 0, 1); const k = 1.7; return 1 + (k + 1) * (t - 1) ** 3 + k * (t - 1) ** 2; };

function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
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
const sign = (v) => (v > 0 ? '+' + v : v < 0 ? '−' + -v : '0');
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

// ── effects ─────────────────────────────────────────────────────────────────

const parts = [];
const pops = [];
let shake = 0;

function burst(x, y, color, n, speed) {
  for (let i = 0; i < n && parts.length < 300; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.8);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, life: 1, decay: 0.9 + Math.random() * 0.8, color, r: 2 + Math.random() * 2.5 });
  }
}
function pop(x, y, s, color) { pops.push({ x, y, s, color, t: 0 }); }

function celebrate() {
  sfx.fanfare();
  const top = standings()[0];
  const color = top ? colorOf(top.id) : C.gold;
  for (let i = 0; i < 5; i++) burst(W * (0.15 + 0.7 * Math.random()), H * (0.25 + 0.3 * Math.random()), i % 2 ? color : C.gold, 22, 260);
}

// Particles and pops move by the elapsed time, not by the frame, so a slow or
// fast screen shows the same motion.
function stepFx(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.vy += 420 * dt;
    p.vx *= 1 - 1.5 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= p.decay * dt;
    if (p.life <= 0) parts.splice(i, 1);
  }
  for (let i = pops.length - 1; i >= 0; i--) {
    pops[i].t += dt;
    if (pops[i].t > 1.3) pops.splice(i, 1);
  }
  shake = Math.max(0, shake - 30 * dt);
}

// ── layout of the table ─────────────────────────────────────────────────────

const PAD = 12;
let btns = [];
const cardRects = new Map();     // card number -> where it was drawn this frame
const lift = new Map();          // card number -> eased raise, px
let hover = 0;
let focus = 0;
let drag = null;                 // { c, x0, y0, x, y }
let press = '';

function seatsLayout(n) {
  const top = 44;
  const gap = 8;
  let cols = n;
  let w = (W - 2 * PAD - (cols - 1) * gap) / cols;
  if (w < 84 && n > 1) {
    cols = Math.ceil(n / 2);
    w = (W - 2 * PAD - (cols - 1) * gap) / cols;
  }
  w = Math.min(w, 168);
  const h = H < 460 ? 54 : 64;
  const rows = Math.ceil(n / cols);
  const rects = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i - row * cols;
    const rowW = inRow * w + (inRow - 1) * gap;
    rects.push({ x: (W - rowW) / 2 + col * (w + gap), y: top + row * (h + gap + 20), w, h });
  }
  return { rects, bottom: top + rows * (h + gap + 20) };
}

function handLayout() {
  const avail = W - 2 * PAD;
  const one = (avail - 14 * 5) / 15;
  const perRow = one >= 34 ? 15 : 8;
  const rows = perRow === 15 ? 1 : 2;
  const cw = Math.min(56, (avail - (perRow - 1) * 5) / perRow);
  const ch = Math.round(cw * 1.38);
  const h = rows * ch + (rows - 1) * 8;
  const top = H - 30 - h - 6;
  const rects = new Map();
  for (let c = 1; c <= CARDS; c++) {
    const row = c <= perRow ? 0 : 1;
    const inRow = row === 0 ? Math.min(perRow, CARDS) : CARDS - perRow;
    const col = row === 0 ? c - 1 : c - 1 - perRow;
    const rowW = inRow * cw + (inRow - 1) * 5;
    rects.set(c, { x: (W - rowW) / 2 + col * (cw + 5), y: top + row * (ch + 8), w: cw, h: ch });
  }
  return { rects, top, cw, ch };
}

// ── drawing pieces ──────────────────────────────────────────────────────────

function drawBackground(now) {
  const g = ctx.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.5, Math.max(W, H) * 0.75);
  g.addColorStop(0, C.bg0);
  g.addColorStop(1, C.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // A faint lattice, drifting slowly, so the felt is never a flat colour.
  ctx.strokeStyle = 'rgba(140,155,230,0.05)';
  ctx.lineWidth = 1;
  const s = 34;
  const off = (now * 0.006) % s;
  ctx.beginPath();
  for (let x = -H - s; x < W + s; x += s) {
    ctx.moveTo(x + off, 0); ctx.lineTo(x + off + H, H);
    ctx.moveTo(x - off + H, 0); ctx.lineTo(x - off, H);
  }
  ctx.stroke();
}

function drawTile(x, y, size, v, a) {
  const pos = v >= 0;
  ctx.save();
  ctx.globalAlpha = a === undefined ? 1 : a;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = size * 0.18;
  ctx.shadowOffsetY = size * 0.06;
  rr(x - size / 2, y - size / 2, size, size, size * 0.2);
  ctx.fillStyle = pos ? C.gold : C.red;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  rr(x - size / 2 + size * 0.07, y - size / 2 + size * 0.07, size * 0.86, size * 0.86, size * 0.15);
  ctx.strokeStyle = pos ? 'rgba(61,47,12,0.35)' : 'rgba(61,15,24,0.35)';
  ctx.lineWidth = Math.max(1.5, size * 0.03);
  ctx.stroke();
  text(sign(v), x, y + size * 0.03, size * 0.46, pos ? C.goldDeep : C.redDeep, 'center', 800);
  ctx.restore();
}

function drawCard(r, c, o) {
  ctx.save();
  const cx = r.x + r.w / 2;
  ctx.translate(cx, r.y + r.h / 2);
  if (o.sx !== undefined) ctx.scale(Math.max(0.02, o.sx), 1);
  if (o.rot) ctx.rotate(o.rot);
  ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  const x = -r.w / 2, y = -r.h / 2;
  if (o.glow) { ctx.shadowColor = o.glow; ctx.shadowBlur = 16; }
  else { ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2; }
  rr(x, y, r.w, r.h, r.w * 0.16);
  if (o.back) {
    ctx.fillStyle = o.color || C.dim;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    rr(x + r.w * 0.16, y + r.w * 0.16, r.w * 0.68, r.h - r.w * 0.32, r.w * 0.1);
    ctx.strokeStyle = 'rgba(16,20,40,0.45)';
    ctx.lineWidth = Math.max(1, r.w * 0.06);
    ctx.stroke();
  } else if (o.spent) {
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(170,176,208,0.18)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    text(String(c), 0, 0, r.w * 0.4, 'rgba(170,176,208,0.22)', 'center', 700);
  } else {
    ctx.fillStyle = C.card;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.save();
    rr(x, y, r.w, r.h, r.w * 0.16);
    ctx.clip();
    ctx.fillStyle = o.color || C.dim;
    ctx.fillRect(x, y, r.w, r.h * 0.16);
    ctx.restore();
    text(String(c), 0, r.h * 0.07, r.w * 0.5, C.cardInk, 'center', 800);
    if (o.cross) {
      ctx.strokeStyle = C.red;
      ctx.lineWidth = Math.max(2, r.w * 0.09);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + r.w * 0.2, y + r.h * 0.25); ctx.lineTo(x + r.w * 0.8, y + r.h * 0.85);
      ctx.moveTo(x + r.w * 0.8, y + r.h * 0.25); ctx.lineTo(x + r.w * 0.2, y + r.h * 0.85);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function button(id, label, x, y, w, h, enabled, primary) {
  const pressed = press === id;
  ctx.save();
  ctx.globalAlpha = enabled ? 1 : 0.4;
  rr(x, y + (pressed ? 2 : 0), w, h, h / 2);
  ctx.fillStyle = primary ? C.gold : 'rgba(255,255,255,0.08)';
  ctx.fill();
  if (!primary) { ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke(); }
  text(label, x + w / 2, y + h / 2 + (pressed ? 2 : 0), Math.min(18, h * 0.42), primary ? C.goldDeep : C.text, 'center', 800, w - 20);
  ctx.restore();
  if (enabled) btns.push({ id, x, y, w, h });
}

function drawMute() {
  const s = 30, x = W - PAD - s, y = 8;
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
  return S.seats.slice().sort((a, b) => b.score - a.score || b.won - a.won);
}

// ── the frame ───────────────────────────────────────────────────────────────

let prevNow = performance.now();
let lastTickSec = -1;

function frame(now) {
  const dt = clamp((now - prevNow) / 1000, 0, 0.1);
  prevNow = now;
  stepFx(dt);
  btns = [];
  cardRects.clear();

  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawBackground(now);
  if (S.g === 0 || S.ph === 'wait') drawLobby(now);
  else drawTable(now, dt);
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
    const s = 1 + 0.4 * (1 - easeOut(p.t * 4));
    ctx.translate(p.x, p.y - 40 * easeOut(k));
    ctx.scale(s, s);
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(10,12,26,0.85)';
    font(22, 900);
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

function drawLobby(now) {
  const people = solo() ? [] : room.players.slice(0, MAX_SEATS);
  const pw = Math.min(W - 2 * PAD, 420);
  // A short frame loses the picture at the top rather than overlapping the rest.
  const cut = H < 350 ? 64 : 0;
  const ph = 330 - cut;
  const x = (W - pw) / 2, y = Math.max(8, (H - ph) / 2) - cut;
  rr(x, y + cut, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const bob = Math.sin(now / 600) * 3;
  if (!cut) drawTile(x + pw / 2 - 34, y + 44 + bob, 40, 7);
  if (!cut) drawTile(x + pw / 2 + 14, y + 50 - bob, 34, -3);
  text('OUTBID', x + pw / 2, y + 96, 28, C.text, 'center', 900);
  const lines = [
    'Everyone holds cards 1-15 and spends one per tile.',
    'Highest bid nobody matched takes a plus tile;',
    'lowest takes a minus. Ties cancel, the pot rolls on.',
  ];
  lines.forEach((l, i) => text(l, x + pw / 2, y + 128 + i * 20, 14, C.dim, 'center', 500, pw - 28));
  let yy = y + 198;
  if (people.length) {
    const dot = 10, gap = 6;
    const total = people.length * (dot + gap) - gap;
    people.forEach((p, i) => {
      ctx.fillStyle = PAL[i % PAL.length];
      ctx.beginPath();
      ctx.arc(x + pw / 2 - total / 2 + i * (dot + gap) + dot / 2, yy, dot / 2, 0, Math.PI * 2);
      ctx.fill();
    });
    yy += 20;
  }
  const n = people.length;
  const status = solo() ? 'No room here: practise against two bots.'
    : n < 2 ? 'Waiting for a second player, or practise against bots.'
    : n + ' players at the table. Anyone can deal.';
  text(status, x + pw / 2, yy, 13, C.faint, 'center', 500, pw - 28);
  const label = solo() || n < 2 ? 'Practice vs bots' : 'Deal';
  button('deal', label, x + pw / 2 - 90, y + 330 - 64, 180, 46, true, true);
  text('Enter to deal', x + pw / 2, y + 330 - 10, 11, C.faint, 'center', 500);
}

function drawTable(now, dt) {
  const seats = S.seats;
  const L = seatsLayout(seats.length);
  const me = mySeat();
  const HL = handLayout();
  const showT = (now - revealAt) / 1000;
  const last = S.ph === 'show' ? S.last : null;
  const left = Math.max(0, endAt - now);

  // Top bar.
  text('OUTBID', PAD, 24, 15, C.text, 'left', 900);
  font(15, 900);
  const tw = ctx.measureText('OUTBID').width;
  text('Turn ' + Math.min(S.turn, TURNS) + '/' + TURNS + '  ·  ' + (TURNS - S.out.length) + ' tiles left', PAD + tw + 12, 24, 12, C.dim, 'left', 600, W - PAD * 2 - tw - 60);

  // The reveal's timeline, from the moment this screen saw it.
  if (last) {
    const fire = (k, at, fn) => { if (showT >= at && !fired.has(k)) { fired.add(k); if (showT < at + 0.6) fn(); } };
    fire('flip', 0, () => last.bids.forEach((b, i) => sfx.card(i)));
    const tied = last.bids.filter((b) => last.bids.filter((o) => o[1] === b[1]).length > 1);
    fire('tie', 0.8, () => {
      if (!tied.length) return;
      sfx.tie();
      shake = 7;
    });
    fire('call', 1.3, () => {
      if (last.win === null) { sfx.carry(); pop(W / 2, potCenter(L, HL).y - 50, 'Carried over!', C.dim); }
      else if (last.val >= 0) sfx.win();
      else sfx.sting();
    });
    fire('land', 2.1, () => {
      if (last.win === null) return;
      const i = seats.findIndex((s) => s.id === last.win);
      if (i < 0) return;
      const r = L.rects[i];
      sfx.land();
      shake = Math.max(shake, 3);
      burst(r.x + r.w / 2, r.y + r.h / 2, last.val >= 0 ? C.gold : C.red, 26, 220);
      pop(r.x + r.w / 2, r.y + r.h + 4, sign(last.val), last.val >= 0 ? C.gold : C.red);
    });
  }

  // Seats.
  seats.forEach((s, i) => {
    const r = L.rects[i];
    const col = PAL[i % PAL.length];
    const here = present(s.id);
    const isWin = last && last.win === s.id && showT >= 1.3;
    ctx.save();
    if (!here) ctx.globalAlpha = 0.4;
    if (isWin) {
      ctx.shadowColor = last.val >= 0 ? C.gold : C.red;
      ctx.shadowBlur = 18 + 6 * Math.sin(now / 120);
    }
    rr(r.x, r.y, r.w, r.h, 12);
    ctx.fillStyle = alpha(col, s.id === myId() ? 0.22 : 0.12);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = isWin ? (last.val >= 0 ? C.gold : C.red) : alpha(col, s.id === myId() ? 0.9 : 0.5);
    ctx.lineWidth = s.id === myId() || isWin ? 2 : 1.2;
    ctx.stroke();
    // The avatar: a disc in the seat's colour with the first letter.
    const ar = Math.min(13, r.h * 0.22);
    const ax = r.x + 8 + ar, ay = r.y + 8 + ar;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(ax, ay, ar, 0, Math.PI * 2);
    ctx.fill();
    const name = nickOf(s.id);
    text(name.slice(0, 1).toUpperCase(), ax, ay + 1, ar * 1.1, C.bg1, 'center', 900);
    // The score shows what it was until the pot lands on the chip.
    const pending = last && last.win === s.id && showT < 2.1 ? last.val : 0;
    const shown = s.score - pending;
    const scoreW = Math.max(26, r.w * 0.3);
    text(clip(name + (s.id === myId() && !solo() ? ' (you)' : ''), 12, r.w - ar * 2 - scoreW - 20), ax + ar + 6, ay, 12, C.text, 'left', 600);
    text(String(shown), r.x + r.w - 10, ay + 1, Math.min(22, r.h * 0.38), shown < 0 ? C.red : C.text, 'right', 800);
    // The hand, as pips: which cards this player still holds is public.
    const pw = (r.w - 16) / CARDS;
    for (let c = 1; c <= CARDS; c++) {
      const held = has(s.hand, c);
      ctx.fillStyle = held ? alpha(col, 0.85) : 'rgba(255,255,255,0.08)';
      const ph = held ? 4 + (c / CARDS) * 6 : 3;
      ctx.fillRect(r.x + 8 + (c - 1) * pw + 0.5, r.y + r.h - 8 - ph, Math.max(1, pw - 1.5), ph);
    }
    ctx.restore();

    // A face-down card for a bid that is in; the face once it is revealed.
    const cw = Math.min(28, r.w * 0.22), chh = cw * 1.38;
    const cr = { x: r.x + r.w / 2 - cw / 2, y: r.y + r.h - chh * 0.35, w: cw, h: chh };
    if (S.ph === 'bid' && S.locked.includes(s.id)) {
      drawCard(cr, 0, { back: true, color: col, rot: -0.08 });
    } else if (last) {
      const b = last.bids.find((x) => x[0] === s.id);
      if (b) {
        const t = clamp((showT - i * 0.08) / 0.35, 0, 1);
        const isTied = last.bids.filter((o) => o[1] === b[1]).length > 1;
        const wob = isTied && showT > 0.8 && showT < 1.3 ? Math.sin(showT * 60) * 0.15 : 0;
        if (t < 0.5) drawCard(cr, 0, { back: true, color: col, sx: 1 - t * 2 });
        else drawCard(cr, b[1], {
          color: col, sx: (t - 0.5) * 2, rot: wob,
          cross: isTied && showT > 0.8,
          alpha: isTied && showT > 1.3 ? 0.5 : 1,
          glow: last.win === s.id && showT > 1.3 ? (last.val >= 0 ? C.gold : C.red) : null,
        });
      }
    }
  });

  // The pot.
  const pc = potCenter(L, HL);
  const ts = clamp(Math.min(W * 0.2, (HL.top - L.bottom) * 0.36), 40, 104);
  const potNow = last ? last.pot : S.pot;
  const val = potValue(potNow);
  const inT = easeOut((now - turnAt) / 450);
  let fly = 0, target = null;
  if (last && last.win !== null) {
    fly = ease((showT - 1.4) / 0.7);
    const i = seats.findIndex((s) => s.id === last.win);
    if (i >= 0) target = { x: L.rects[i].x + L.rects[i].w / 2, y: L.rects[i].y + L.rects[i].h / 2 };
  }
  if (!(last && last.win !== null && showT >= 2.1)) {
    potNow.forEach((v, k) => {
      const newest = k === potNow.length - 1 && S.ph === 'bid';
      const off = (potNow.length - 1 - k) * ts * 0.16;
      let x = pc.x - off, y = pc.y - off * 0.6;
      let size = ts * (newest ? back(inT) : 1);
      if (newest) y -= (1 - inT) * 60;
      if (target && fly > 0) {
        x += (target.x - x) * fly;
        y += (target.y - y) * fly;
        size *= 1 - 0.6 * fly;
      }
      if (size > 1) drawTile(x, y, size, v, newest ? clamp(inT * 2, 0, 1) : 1);
    });
  }
  // The timer ring around the pot.
  if (S.ph === 'bid') {
    const frac = clamp(left / BID_MS, 0, 1);
    const rad = ts * 0.78 + (potNow.length - 1) * ts * 0.08;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.arc(pc.x, pc.y, rad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = left < 3000 ? C.red : C.dim;
    ctx.beginPath();
    ctx.arc(pc.x, pc.y, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
    const sec = Math.ceil(left / 1000);
    text(String(sec), pc.x + rad + 8, pc.y - rad + 6, 14, left < 3000 ? C.red : C.dim, 'left', 800);
    if (sec <= 3 && sec > 0 && sec !== lastTickSec && me && !(myPick && myPick.turn === S.turn && myPick.g === S.g)) sfx.tick();
    lastTickSec = sec;
  }
  // What the pot is worth and who takes it.
  // One line under the pot: the rule while bidding, the verdict once it is called.
  const ry = pc.y + ts * 0.5 + 20 + (potNow.length - 1) * 2;
  if (S.ph === 'bid' || (last && showT < 1.3)) {
    const pos = val >= 0;
    const rule = pos ? 'Highest unique bid takes it' : 'Lowest unique bid takes it';
    text((potNow.length > 1 ? 'Pot ' : '') + sign(val) + '  ·  ' + rule, pc.x, ry, 14, pos ? C.gold : C.red, 'center', 700, W - 2 * PAD);
  }
  if (last && showT >= 1.3) {
    const msg = last.win === null ? 'Every bid matched another. The pot carries over.'
      : nickOf(last.win) + (last.win === myId() && !solo() ? ' (you)' : '') + ' takes ' + sign(last.val);
    text(msg, pc.x, ry, 15, C.text, 'center', 700, W - 2 * PAD);
  }

  // My hand.
  if (me) {
    for (let c = 1; c <= CARDS; c++) {
      const r = HL.rects.get(c);
      const held = has(me.hand, c);
      const picked = myPick && myPick.g === S.g && myPick.turn === S.turn && myPick.c === c && S.ph === 'bid';
      const want = !held ? 0 : picked ? 16 : (hover === c || focus === c) && canBid() ? 6 : 0;
      const cur = lift.get(c) || 0;
      const nl = cur + (want - cur) * (1 - Math.exp(-dt * 18));
      lift.set(c, nl);
      const rr2 = { x: r.x, y: r.y - nl, w: r.w, h: r.h };
      if (drag && drag.c === c) continue;
      if (held) cardRects.set(c, rr2);
      drawCard(rr2, c, {
        spent: !held,
        color: colorOf(myId()),
        alpha: held && !canBid() ? 0.55 : 1,
        glow: picked ? C.gold : null,
      });
      if (picked) text('BID', r.x + r.w / 2, rr2.y - 9, 10, C.gold, 'center', 900);
      if (focus === c && held && canBid() && !picked) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        rr(rr2.x - 2, rr2.y - 2, rr2.w + 4, rr2.h + 4, r.w * 0.2);
        ctx.stroke();
      }
    }
    if (drag) {
      const r = HL.rects.get(drag.c);
      const up = drag.y - drag.y0 < -36;
      drawCard({ x: r.x + drag.x - drag.x0, y: r.y + drag.y - drag.y0, w: r.w, h: r.h }, drag.c,
        { color: colorOf(myId()), glow: up ? C.gold : 'rgba(255,255,255,0.4)', rot: (drag.x - drag.x0) * 0.002 });
    }
  } else {
    text('You are watching. You get a seat on the next deal.', W / 2, HL.top + HL.ch / 2, 14, C.dim, 'center', 600, W - 2 * PAD);
  }

  // One line of how-to, always on screen.
  const how = S.ph === 'over' ? '' : me && S.ph === 'bid'
    ? (coarse ? 'Tap or drag a card up to bid. You can change it until the reveal.'
      : 'Click or drag a card up to bid · keys 1-9, 0, arrows + Enter · change it until the reveal')
    : 'Ties cancel. Each card can be played once a game.';
  text(how, W / 2, H - 16, 12, C.faint, 'center', 500, W - 2 * PAD);

  if (S.ph === 'over') drawOver(now);
  if (practiceTable()) {
    const head = joinEnd ? joinHead(Math.max(1, Math.ceil((joinEnd - now) / 1000)))
      : 'practice with bots · a game starts when someone joins';
    const tip = joinEnd ? null : 'the highest bid nobody matched takes a plus tile, the lowest a minus one';
    practiceNote(now, W, head, tip, [], HL.top - 10);
  }
}

function potCenter(L, HL) {
  return { x: W / 2, y: L.bottom + (HL.top - L.bottom) * 0.44 };
}

function drawOver(now) {
  const k = easeOut((now - overAt) / 500);
  ctx.fillStyle = 'rgba(8,10,22,' + 0.55 * k + ')';
  ctx.fillRect(0, 0, W, H);
  const list = standings();
  const pw = Math.min(W - 2 * PAD, 380);
  const rowH = 30;
  const ph = Math.min(H - 24, 150 + list.length * rowH);
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
  const winners = top ? list.filter((s) => s.score === top.score && s.won === top.won) : [];
  const title = !winners.length ? 'Game over'
    : winners.length > 1 ? 'A tie at ' + top.score
    : nickOf(top.id) + (top.id === myId() && !solo() ? ' (you)' : '') + ' wins';
  text(title, x + pw / 2, y + 34, 24, winners.length === 1 ? colorOf(top.id) : C.text, 'center', 900, pw - 28);
  list.forEach((s, i) => {
    const yy = y + 70 + i * rowH;
    if (yy > y + ph - 70) return;
    ctx.fillStyle = colorOf(s.id);
    ctx.beginPath();
    ctx.arc(x + 30, yy, 6, 0, Math.PI * 2);
    ctx.fill();
    text((i + 1) + '.  ' + clip(nickOf(s.id), 14, pw - 150), x + 44, yy, 14, C.text, 'left', 600);
    text(s.won + ' tiles', x + pw - 78, yy, 11, C.faint, 'right', 500);
    text(String(s.score), x + pw - 24, yy, 16, s.score < 0 ? C.red : C.gold, 'right', 800);
  });
  const ready = now - overAt >= DEAL_COOLDOWN;
  const people = solo() ? 0 : room.players.length;
  button('deal', people >= 2 ? 'Deal again' : 'Practice again', x + pw / 2 - 90, y + ph - 60, 180, 44, ready, true);
  ctx.restore();
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
function cardAt(p) {
  for (const [c, r] of cardRects) if (inside(p, { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 22 })) return c;
  return 0;
}
function act(id) {
  if (id === 'mute') { muted = !muted; if (!muted) sfx.pick(); }
  else if (id === 'deal') deal();
}

cv.addEventListener('pointerdown', (e) => {
  audio();
  const p = pt(e);
  const b = buttonAt(p);
  if (b) { press = b; e.preventDefault(); return; }
  const c = cardAt(p);
  if (c && canBid()) {
    drag = { c, x0: p.x, y0: p.y, x: p.x, y: p.y };
    focus = c;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ }
  }
  e.preventDefault();
});
cv.addEventListener('pointermove', (e) => {
  const p = pt(e);
  if (drag) { drag.x = p.x; drag.y = p.y; }
  if (e.pointerType === 'mouse') {
    hover = cardAt(p);
    cv.style.cursor = hover && canBid() ? 'grab' : buttonAt(p) ? 'pointer' : 'default';
  }
});
cv.addEventListener('pointerup', (e) => {
  const p = pt(e);
  if (press) {
    if (buttonAt(p) === press) act(press);
    press = '';
  }
  if (drag) {
    const dx = drag.x - drag.x0, dy = drag.y - drag.y0;
    // A drag upward plays the card; so does a tap that barely moved.
    if (dy < -36 || dx * dx + dy * dy < 144) play(drag.c);
    drag = null;
  }
});
cv.addEventListener('pointercancel', () => { drag = null; press = ''; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  audio();
  const k = e.key;
  if (k === 'm' || k === 'M') { act('mute'); return; }
  if ((S.g === 0 || S.ph === 'wait' || S.ph === 'over') && (k === 'Enter' || k === ' ')) { deal(); e.preventDefault(); return; }
  const me = mySeat();
  if (!me || !canBid()) return;
  if (/^[0-9]$/.test(k)) {
    const c = k === '0' ? 10 : Number(k);
    if (has(me.hand, c)) { focus = c; play(c); }
    return;
  }
  const step = (d) => {
    let c = focus || (d > 0 ? 0 : CARDS + 1);
    for (let i = 0; i < CARDS; i++) {
      c += d;
      if (c < 1) c = CARDS;
      if (c > CARDS) c = 1;
      if (has(me.hand, c)) { focus = c; return; }
    }
  };
  if (k === 'ArrowRight') { step(1); e.preventDefault(); }
  else if (k === 'ArrowLeft') { step(-1); e.preventDefault(); }
  else if ((k === 'Enter' || k === ' ' || k === 'ArrowUp') && focus && has(me.hand, focus)) { play(focus); e.preventDefault(); }
});

// ── start ───────────────────────────────────────────────────────────────────

setInterval(hostTick, 100);
requestAnimationFrame(frame);
// Nothing is replayed, so a disk that has just started asks where the game is.
// With no room around it this goes nowhere, and the host's tick deals practice.
if (!solo()) room.send({ t: 'hello' });
