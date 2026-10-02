/**
 * @disk     planning_poker
 * @author   claude
 * @version  1
 * @players  1-8
 * @about    Planning poker for a team estimating its work. Everyone picks a card face down and the room turns them over at once. A card is sealed by a hash until then, so nobody can read it early, the host included.
 * @tags     tool, meeting, agile, estimation, team
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/planning_poker.png
 */
// planning_poker.js — estimation for a team, with no authority in it.
//
// A pick does not travel as a card. It travels as a commitment: the SHA-256 of
// the round, the voter's id, the card and a random salt that stays on the
// voter's machine. Every copy, the host's included, holds nothing but those
// hashes until somebody turns the cards over; then each voter sends the card
// and the salt, and every copy checks them against the hash it already has.
// So "nobody sees your card before the reveal" is arithmetic rather than
// politeness, and it holds against a copy with a console open, which is the
// only kind of copy that would ever try. The voter's id is inside the hash so
// that copying somebody else's commitment and then their opening gets nobody
// anywhere: an opening proves a card for the one id it was sealed with.
//
// What a voter can still do after the reveal is stay silent — a card they
// never open is shown as withheld, not guessed at. A card cannot be changed by
// then; it can only be kept back, and that is visible to the whole room.
//
// Every action that changes the table — a vote, a reveal, a new round — goes
// out with `echo` and is applied only when the room hands it back, the
// sender's own included. All copies apply the same actions in the same order,
// so anybody may run the table and nobody has to own it: two people pressing
// "Reveal" at once is one reveal, and the second press finds it done.

// ── rules ───────────────────────────────────────────────────────────────────

// The last two cards of every deck are the abstentions: "no idea" and "I need
// a break". They are shown with everybody else's cards and never counted.
const DECKS = [
  { name: 'Fibonacci', cards: ['0', '1/2', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', 'coffee'] },
  { name: 'Modified Fibonacci', cards: ['0', '1/2', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', 'coffee'] },
  { name: 'T-shirt sizes', cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', 'coffee'] },
  { name: 'Powers of 2', cards: ['0', '1', '2', '4', '8', '16', '32', '64', '?', 'coffee'] },
];

// A topic, the whole table and a slice of the log travel in payloads whose
// ceiling is 4 KiB. A field with no cap is how a disk meets `RangeError` in
// front of a room, so the topic is cut on the way in, and the log is cut into
// pieces measured in bytes rather than counted in entries.
const TOPIC_MAX = 100;
const HISTORY_MAX = 60;
const PIECE_BYTES = 3000;

const HELLO_RETRY_MS = 3000;   // a hello that never came back went into a dead socket
const ANSWER_WAIT_MS = 1500;   // how long a newcomer waits for somebody holding the table
const RESEND_MS = 2000;        // a vote or an opening the room never handed back is sent again
const PIECE_MS = 60;           // the pace a catch-up is drained at, not a loop

// The platform's own colour tokens, copied by hand, and one warm accent for
// the cards. A disk has no reach into the stylesheet around it, so looking
// like diskroom is a choice this file makes.
const C = {
  bg: '#1c1c1c', sunken: '#1f1f1f', surface: '#242424', raised: '#2a2a2a', border: '#2f2f2f',
  text: '#f5f5f5', dim: '#ededed', muted: '#8f8f8f', faint: '#6e6e6e',
  ok: '#a9c0a9', bad: '#d3a9a9',
  card: '#f3ead8', ink: '#1d1d1d', accent: '#d9b86c', back: '#3a3326',
};
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

// ── SHA-256 ─────────────────────────────────────────────────────────────────
// Written out rather than borrowed: `crypto.subtle` exists only in a secure
// context, and whether the frame is one depends on how the deployment serves
// it. A commitment that one copy can compute and another cannot is no
// commitment at all, so every copy carries the same few lines of arithmetic.

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const ror = (x, n) => (x >>> n) | (x << (32 - n));

function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const words = ((len + 9 + 63) >> 6) << 4;
  const w = new Uint32Array(words);
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
  w[len >> 2] |= 0x80 << (24 - (len & 3) * 8);
  w[words - 1] = len * 8;
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const m = new Uint32Array(64);
  for (let off = 0; off < words; off += 16) {
    for (let t = 0; t < 16; t++) m[t] = w[off + t];
    for (let t = 16; t < 64; t++) {
      const a = m[t - 15], b = m[t - 2];
      const s0 = ror(a, 7) ^ ror(a, 18) ^ (a >>> 3);
      const s1 = ror(b, 17) ^ ror(b, 19) ^ (b >>> 10);
      m[t] = (m[t - 16] + s0 + m[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + m[t]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + k) | 0;
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

function randomHex(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// What a commitment seals. Everything that makes a card mean something is in
// it — the round, the voter, the deck — so an opening cannot be carried over
// to another round, another seat or another deck.
const sealed = (r, id, deck, c, salt) => sha256(`planning_poker|${r}|${id}|${deck}|${c}|${salt}`);

// ── state ───────────────────────────────────────────────────────────────────

// The table, the same on every copy because it moves only by actions the room
// has ordered. Keys of the maps are player ids as strings, since a payload is
// JSON.
//   r       the round number
//   topic   what is being estimated
//   deck    an index into DECKS
//   ph      'vote' | 'shown'
//   commits id -> hash of the card, while a round is open and after
//   opens   id -> card index once the cards are over; -1 for an opening that
//           did not match its hash
//   names   id -> nick, so a voter who left still has a name on the table
//   by      who turned the cards over
//   final   the estimate the room settled on, a card index, or null
//   watch   ids that sit at the table without voting
function fresh(r, topic, deck, watch) {
  return { r, topic, deck, ph: 'vote', commits: {}, opens: {}, names: {}, by: null, final: null, watch };
}
let S = fresh(0, '', 0, []);
let past = [];        // finished rounds, oldest first: { n, t, d, f, v: [[nick, c]] }

// Mine alone. The salt of a card never leaves this copy until the cards are
// over, and every commitment of this round is kept, not only the last one —
// the room may have ordered an earlier pick after a later one was sent.
let picked = null;       // the card index I have chosen this round, or null
const seals = new Map(); // hash -> { r, c, salt }
let voteSent = 0;        // when my current pick last went out
let openSent = 0;        // when my opening last went out

// Who has this disk running, as far as this copy has heard. A display matter
// only: it decides who the table is waiting for, never what the table is.
const running = new Set();
const nicks = new Map();

// The handshake. 'pre': my hello is out and everything before it is in the
// table I am about to be handed. 'buf': my hello is back, and what follows it
// waits to be applied on top of that table. 'ok': I hold the table.
let sync = 'ok';
let helloKey = '';
let helloAt = 0;
let askedAll = false;
let haveTable = false;   // whether this copy ever held a table, so a resync keeps it
let buffer = [];
let source = null;       // whose catch-up I took, so a second answer is ignored
let answerTimer = null;
const outbox = [];       // catch-up pieces waiting to go out, one per PIECE_MS

// `room.me` is null in the studio and on Run solo. The disk is a table of one
// there: every action applies at once, since no room is going to hand it back.
const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const me = () => String(myId());

function nickOf(id) {
  const n = Number(id);
  if (n === myId() && solo()) return 'You';
  const p = room.players.find((x) => x.id === n);
  if (p) { nicks.set(n, p.nick); return p.nick; }
  return S.names[id] || nicks.get(n) || 'Player ' + id;
}

const deckOf = (d) => DECKS[d] || DECKS[0];
const isCard = (d, c) => Number.isInteger(c) && c >= 0 && c < deckOf(d).cards.length;
const abstains = (d, c) => c >= deckOf(d).cards.length - 2;
const watching = (id) => S.watch.includes(Number(id));

// ── the actions, as every copy applies them ─────────────────────────────────

function act(msg) {
  if (solo()) {
    apply(myId(), msg);
    forgetOldRounds();
    settle();
    render();
  } else {
    room.send(msg, { echo: true });
  }
}

// Every field is checked here, because anybody can send anything: a payload is
// whatever another copy, or another person's console, chose to put in it.
function apply(from, msg) {
  const id = String(from);
  const now = typeof msg.r === 'number' && msg.r === S.r;
  switch (msg.t) {
    case 'vote': {
      if (!now || S.ph !== 'vote' || watching(id)) return;
      if (msg.h === null) {
        delete S.commits[id];
      } else if (typeof msg.h === 'string' && /^[0-9a-f]{64}$/.test(msg.h)) {
        S.commits[id] = msg.h;
        S.names[id] = nickOf(id);
      }
      return;
    }
    case 'reveal': {
      if (!now || S.ph !== 'vote' || Object.keys(S.commits).length === 0) return;
      S.ph = 'shown';
      S.by = from;
      return;
    }
    case 'open': {
      if (!now || S.ph !== 'shown' || !S.commits[id] || id in S.opens) return;
      if (!isCard(S.deck, msg.c) || typeof msg.s !== 'string' || !/^[0-9a-f]{32}$/.test(msg.s)) return;
      S.opens[id] = sealed(S.r, id, S.deck, msg.c, msg.s) === S.commits[id] ? msg.c : -1;
      return;
    }
    case 'final': {
      if (!now || S.ph !== 'shown') return;
      if (msg.c === null || isCard(S.deck, msg.c)) S.final = msg.c;
      return;
    }
    case 'topic': {
      if (!now || typeof msg.topic !== 'string') return;
      S.topic = msg.topic.slice(0, TOPIC_MAX);
      return;
    }
    case 'round': {
      if (!now || typeof msg.topic !== 'string' || !DECKS[msg.deck]) return;
      if (S.ph === 'shown') record();
      S = fresh(S.r + 1, msg.topic.slice(0, TOPIC_MAX), msg.deck, S.watch);
      return;
    }
    case 'watch': {
      const n = Number(id);
      if (msg.on === true && !S.watch.includes(n)) {
        S.watch.push(n);
        if (S.ph === 'vote') delete S.commits[id];
      } else if (msg.on === false) {
        S.watch = S.watch.filter((x) => x !== n);
      }
      return;
    }
  }
}

// A finished round goes into the log as names and cards rather than ids: the
// log outlives the seats it was about.
function record() {
  const v = Object.keys(S.commits).map((id) => {
    const c = id in S.opens ? S.opens[id] : -2;
    return [S.names[id] || nickOf(id), c];
  });
  past.push({ n: S.r + 1, t: S.topic, d: S.deck, f: S.final, v });
  if (past.length > HISTORY_MAX) past = past.slice(-HISTORY_MAX);
}

// ── my own part: picking, and opening what I picked ─────────────────────────

function pick(c) {
  if (S.ph !== 'vote' || watching(me())) return;
  if (picked === c) {
    picked = null;
    act({ t: 'vote', r: S.r, h: null });
  } else {
    picked = c;
    const salt = randomHex(16);
    const h = sealed(S.r, me(), S.deck, c, salt);
    seals.set(h, { r: S.r, c, salt });
    act({ t: 'vote', r: S.r, h });
  }
  voteSent = Date.now();
  render();
}

// The table I hold and what I meant may part: a vote the room never handed
// back, an opening lost with a dropped connection. Nothing is replayed, so the
// difference is noticed here and sent again rather than trusted to one message.
function settle() {
  if (sync !== 'ok') return;
  const mine = S.commits[me()];
  const now = Date.now();
  if (S.ph === 'vote') {
    const want = picked === null ? null : wantedHash();
    if ((mine || null) !== want && now - voteSent > RESEND_MS && !watching(me())) {
      voteSent = now;
      act({ t: 'vote', r: S.r, h: want });
    }
  } else if (mine && !(me() in S.opens)) {
    const seal = seals.get(mine);
    if (seal && seal.r === S.r && now - openSent > RESEND_MS) {
      openSent = now;
      act({ t: 'open', r: S.r, c: seal.c, s: seal.salt });
    }
  }
}

function wantedHash() {
  let last = null;
  for (const [h, seal] of seals) if (seal.r === S.r && seal.c === picked) last = h;
  return last;
}

// A new round leaves nothing of mine behind: the salts of a round nobody can
// open any more are just secrets kept for no reason.
function forgetOldRounds() {
  for (const [h, seal] of seals) if (seal.r !== S.r) seals.delete(h);
  if (![...seals.values()].some((s) => s.c === picked)) picked = null;
  const mine = S.commits[me()];
  if (S.ph === 'vote' && mine && seals.has(mine)) picked = seals.get(mine).c;
}

// ── the handshake: whoever holds the table hands it over ────────────────────

function hello(all) {
  sync = 'pre';
  buffer = [];
  source = null;
  helloKey = randomHex(6);
  helloAt = Date.now();
  room.send({ t: 'hello', k: helloKey, all: !!all }, { echo: true });
}

// Asking again is paced: a round number from the future is something any copy
// can make up, and one that does so on purpose should cost the room a
// handshake now and then, not a handshake on every message.
let lastResync = 0;
function resync() {
  if (Date.now() - lastResync < HELLO_RETRY_MS) return;
  lastResync = Date.now();
  askedAll = false;
  hello(false);
  render();
}

// Nobody answered: either nobody else is running the disk, or the one meant
// to answer is not. The second time everybody is asked; after that the copy
// goes on with what it has — a table of its own if it never had one.
function noAnswer() {
  answerTimer = null;
  if (sync !== 'buf') return;
  const others = [...running].some((id) => id !== myId());
  if (others && !askedAll) {
    askedAll = true;
    hello(true);
    return;
  }
  if (!haveTable) S = fresh(0, '', 0, []);
  take();
}

// The table is mine now: apply whatever the room ordered after my hello.
function take() {
  sync = 'ok';
  haveTable = true;
  clearTimeout(answerTimer);
  answerTimer = null;
  const queued = buffer;
  buffer = [];
  for (const [from, msg] of queued) {
    ordered(from, msg);
    if (sync !== 'ok') return;   // the buffer itself showed this copy behind; it asked again
  }
  forgetOldRounds();
  render();
}

// The host answers a hello; everybody answers a hello that asks everybody.
// The answer is cut at the moment the hello is handled, since that is the
// place in the room's order the newcomer will apply it at, however long the
// pieces take to go out.
function answer(to, all, k) {
  const host = room.host;
  const hostRuns = host !== null && running.has(host.id) && host.id !== to;
  const mine = host !== null && host.id === myId();
  if (!all && !mine && hostRuns) return;
  const pieces = [];
  let piece = [];
  let size = 0;
  past.forEach((entry, i) => {
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
    if (piece.length > 0 && size + bytes > PIECE_BYTES) {
      pieces.push(piece);
      piece = [];
      size = 0;
    }
    if (piece.length === 0) piece.from = i;
    piece.push(entry);
    size += bytes;
  });
  if (piece.length > 0) pieces.push(piece);
  outbox.push({ to, msg: { t: 'state', k, s: JSON.parse(JSON.stringify(S)), hn: past.length } });
  for (const p of pieces) outbox.push({ to, msg: { t: 'hist', i: p.from, items: p.slice() } });
}

setInterval(() => {
  const next = outbox.shift();
  if (!next) return;
  if (!room.players.some((p) => p.id === next.to)) return;
  try { room.send(next.msg, { to: next.to }); } catch (e) { console.log('catch-up piece refused: ' + e.message); }
}, PIECE_MS);

// A table handed over is checked as carefully as an action: it comes from
// another copy, which is to say from anybody.
function validTable(s) {
  if (!s || typeof s !== 'object') return false;
  if (!Number.isInteger(s.r) || s.r < 0 || !DECKS[s.deck] || typeof s.topic !== 'string') return false;
  if (s.ph !== 'vote' && s.ph !== 'shown') return false;
  for (const k of ['commits', 'opens', 'names']) if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) return false;
  if (!Array.isArray(s.watch) || !s.watch.every(Number.isInteger)) return false;
  if (!Object.values(s.commits).every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) return false;
  if (!Object.values(s.opens).every((c) => c === -1 || isCard(s.deck, c))) return false;
  if (!Object.values(s.names).every((n) => typeof n === 'string')) return false;
  if (s.by !== null && !Number.isInteger(s.by)) return false;
  return s.final === null || isCard(s.deck, s.final);
}

function validEntry(e) {
  return e && typeof e === 'object' && Number.isInteger(e.n) && typeof e.t === 'string' &&
    DECKS[e.d] && Array.isArray(e.v) &&
    (e.f === null || isCard(e.d, e.f)) &&
    e.v.every((x) => Array.isArray(x) && typeof x[0] === 'string' && (x[1] === -1 || x[1] === -2 || isCard(e.d, x[1])));
}

function onTable(from, msg) {
  // The key names the hello this table answers: an answer to an earlier one
  // stands at an earlier place in the room's order than the buffer it would be
  // laid under.
  if (sync !== 'buf' || source !== null || msg.k !== helloKey) return;
  if (!validTable(msg.s) || !Number.isInteger(msg.hn)) return;
  source = from;
  S = msg.s;
  S.topic = S.topic.slice(0, TOPIC_MAX);
  past = new Array(Math.min(msg.hn, HISTORY_MAX)).fill(null);
  take();
}

function onHistory(from, msg) {
  if (from !== source || !Number.isInteger(msg.i) || !Array.isArray(msg.items)) return;
  msg.items.forEach((entry, k) => {
    const at = msg.i + k;
    if (at >= 0 && at < past.length && past[at] === null && validEntry(entry)) past[at] = entry;
  });
  render();
}

// ── the wire ────────────────────────────────────────────────────────────────

room.on('message', (from, msg) => {
  if (!msg || typeof msg !== 'object') return;
  running.add(from);
  if (msg.t === 'state') return onTable(from, msg);
  if (msg.t === 'hist') return onHistory(from, msg);
  if (msg.t === 'here') return render();
  if (msg.t === 'hello') {
    if (from !== myId()) {
      try { room.send({ t: 'here' }, { to: from }); } catch (e) { /* nothing to say it with */ }
    }
  }
  if (sync === 'pre') {
    if (msg.t === 'hello' && from === myId() && msg.k === helloKey) {
      sync = 'buf';
      answerTimer = setTimeout(noAnswer, ANSWER_WAIT_MS);
    }
    return;
  }
  if (sync === 'buf') {
    buffer.push([from, msg]);
    return;
  }
  ordered(from, msg);
  settle();
  render();
});

function ordered(from, msg) {
  if (msg.t === 'hello') {
    if (from !== myId()) answer(from, msg.all === true, typeof msg.k === 'string' ? msg.k.slice(0, 16) : '');
    return;
  }
  // An action for a round this copy has not reached means it missed what
  // started that round. It is not guessed at: the table is asked for again.
  if (typeof msg.r === 'number' && msg.r > S.r) {
    resync();
    return;
  }
  const round = S.r;
  apply(from, msg);
  if (S.r !== round) forgetOldRounds();
}

room.on('join', () => render());
room.on('leave', (player) => {
  nicks.set(player.id, player.nick);
  running.delete(player.id);
  outbox.splice(0, outbox.length, ...outbox.filter((o) => o.to !== player.id));
  render();
});
room.on('hostchange', () => render());

setInterval(() => {
  if (!solo() && sync === 'pre' && Date.now() - helloAt > HELLO_RETRY_MS) hello(askedAll);
  settle();
}, 500);

// ── what the cards say ──────────────────────────────────────────────────────

function valueOf(d, c) {
  const label = deckOf(d).cards[c];
  if (label === '1/2') return 0.5;
  const n = Number(label);
  return Number.isFinite(n) ? n : null;
}

// Everything the result panel shows, from the cards that were opened. Medians
// and spreads work by position in the deck, so they mean the same thing for
// T-shirt sizes as for numbers; an average exists only for a numeric deck.
function summarise(d, cards) {
  const counted = cards.filter((c) => c >= 0 && !abstains(d, c)).sort((a, b) => a - b);
  const counts = new Map();
  for (const c of cards) if (c >= 0) counts.set(c, (counts.get(c) || 0) + 1);
  const out = { counted, counts, consensus: null, median: null, average: null, nearest: null, low: null, high: null };
  if (counted.length === 0) return out;
  out.low = counted[0];
  out.high = counted[counted.length - 1];
  out.median = counted[(counted.length - 1) >> 1];
  if (counted.length >= 2 && out.low === out.high) out.consensus = out.low;
  const values = counted.map((c) => valueOf(d, c));
  if (values.every((v) => v !== null)) {
    out.average = values.reduce((a, b) => a + b, 0) / values.length;
    let best = null;
    deckOf(d).cards.forEach((_, c) => {
      const v = valueOf(d, c);
      if (v === null) return;
      if (best === null || Math.abs(v - out.average) <= Math.abs(valueOf(d, best) - out.average)) best = c;
    });
    out.nearest = best;
  }
  return out;
}

// The estimate a round leaves if nobody settled it by hand.
const suggested = (sum) => (sum.consensus ?? sum.nearest ?? sum.median);

const label = (d, c) => {
  const text = deckOf(d).cards[c];
  return text === '1/2' ? '½' : text === 'coffee' ? '☕' : text;
};

function cardText(d, c) {
  if (c === -1) return 'invalid';
  if (c === -2) return 'withheld';
  return label(d, c);
}

function summaryText() {
  const done = past.filter((e) => e !== null);
  const lines = [`Planning poker: ${done.length} ${done.length === 1 ? 'story' : 'stories'}`];
  done.forEach((e, i) => {
    const sum = summarise(e.d, e.v.map((x) => x[1]));
    const est = e.f !== null && e.f !== undefined ? label(e.d, e.f) : suggested(sum) !== null ? '~' + label(e.d, suggested(sum)) : 'no estimate';
    const votes = e.v.map(([nick, c]) => `${nick} ${cardText(e.d, c)}`).join(', ');
    lines.push(`${i + 1}. ${e.t || 'Round ' + e.n}: ${est} (${votes})`);
  });
  return lines.join('\n');
}

// ── the screen ──────────────────────────────────────────────────────────────

function el(tag, css, text) {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A phone browser zooms the whole page when a field smaller than 16px gets
// focus, and a finger needs a bigger target than a pointer; both are answered
// by measurements rather than by a second layout.
const COARSE = matchMedia('(pointer: coarse)').matches;
const TAP = COARSE ? 44 : 34;
const FIELD_SIZE = COARSE ? 16 : 14;

document.documentElement.style.cssText = 'height:100%';
document.body.style.cssText =
  `margin:0;height:100%;overflow:hidden;background:${C.bg};color:${C.dim};font:14px/1.45 ${FONT}`;

const root = el('div',
  'box-sizing:border-box;height:100%;padding:16px;display:flex;flex-direction:column;gap:14px;' +
  'overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;' +
  'max-width:920px;margin:0 auto');
document.body.appendChild(root);

function button(text, kind) {
  const b = el('button',
    `padding:0 14px;font:inherit;border-radius:3px;cursor:pointer;min-height:${TAP}px;white-space:nowrap;` +
    (kind === 'primary'
      ? `border:0;background:${C.dim};color:${C.bg};font-weight:600`
      : `border:1px solid ${C.border};background:${C.surface};color:${C.dim}`), text);
  b.onpointerenter = () => { if (!b.disabled) b.style.filter = 'brightness(1.15)'; };
  b.onpointerleave = () => { b.style.filter = ''; };
  return b;
}

const FIELD =
  `box-sizing:border-box;padding:0 10px;border:1px solid ${C.border};border-radius:3px;` +
  `background:${C.sunken};color:${C.text};font:inherit;font-size:${FIELD_SIZE}px;outline:none;min-height:${TAP}px`;

// The head: the round, the deck and the choice to sit out.
const head = el('div', 'display:flex;flex-wrap:wrap;align-items:center;gap:10px');
const roundLabel = el('div', `font:11px ${MONO};color:${C.muted};letter-spacing:.06em;text-transform:uppercase;flex:1;min-width:120px`);
const deckSelect = el('select', FIELD + ';cursor:pointer');
DECKS.forEach((d, i) => {
  const o = el('option', '', d.name);
  o.value = String(i);
  deckSelect.appendChild(o);
});
deckSelect.title = 'Changing the deck starts the round again';
deckSelect.onchange = () => act({ t: 'round', r: S.r, topic: S.topic, deck: Number(deckSelect.value) });
const watchButton = button('Just watching');
watchButton.onclick = () => act({ t: 'watch', on: !watching(me()) });
head.append(roundLabel, deckSelect, watchButton);

// The topic is one field everybody may edit. What is typed goes to the room
// when the field is left or Enter is pressed, not on every key: a keystroke
// per message would be the whole room's traffic for a sentence.
const topicInput = el('input', FIELD + `;width:100%;font-size:${COARSE ? 16 : 17}px;min-height:${TAP + 8}px`);
topicInput.placeholder = 'What are we estimating?';
topicInput.maxLength = TOPIC_MAX;
let topicDirty = false;
topicInput.oninput = () => { topicDirty = true; };
const sendTopic = () => {
  if (!topicDirty) return;
  topicDirty = false;
  const text = topicInput.value.trim().slice(0, TOPIC_MAX);
  if (text !== S.topic) act({ t: 'topic', r: S.r, topic: text });
};
topicInput.onblur = sendTopic;
topicInput.onkeydown = (e) => { if (e.key === 'Enter') { sendTopic(); topicInput.blur(); } };

const table = el('div', 'display:flex;flex-wrap:wrap;gap:14px;justify-content:center;padding:18px 8px;' +
  `background:${C.sunken};border:1px solid ${C.border};border-radius:6px;min-height:120px;align-content:center`);
const statusBox = el('div', 'display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:center;text-align:center');
const result = el('div', 'display:flex;flex-direction:column;gap:12px');
const handTitle = el('div', `font:11px ${MONO};color:${C.muted};letter-spacing:.06em;text-transform:uppercase`);
const hand = el('div', 'display:flex;flex-wrap:wrap;gap:8px;justify-content:center');
const logBox = el('details', `border-top:1px solid ${C.border};padding-top:10px`);
const logTitle = el('summary', `cursor:pointer;font:11px ${MONO};color:${C.muted};letter-spacing:.06em;text-transform:uppercase`);
const logList = el('div', 'display:flex;flex-direction:column;gap:6px;margin-top:10px;user-select:text;-webkit-user-select:text');
const logText = el('textarea',
  FIELD + `;width:100%;min-height:120px;padding:8px 10px;font:12px/1.5 ${MONO};resize:vertical;margin-top:10px`);
logText.readOnly = true;
const selectAll = button('Select the summary');
selectAll.style.marginTop = '8px';
selectAll.onclick = () => { logText.focus(); logText.select(); };
const logHint = el('div', `font-size:12px;color:${C.faint};margin-top:6px`,
  'A disk has no clipboard of its own: select the summary and copy it with your keyboard, ' +
  'and it is gone when the room is.');
logBox.append(logTitle, logList, logText, selectAll, logHint);

root.append(head, topicInput, table, statusBox, result, handTitle, hand, logBox);
// The column scrolls; its parts keep their height. A flex column shorter than
// its content shrinks its children instead, and on a phone the table of cards
// is then drawn over the topic above it.
for (const part of root.children) part.style.flexShrink = '0';

// One card, face down, face up, or an empty place for somebody yet to pick.
function cardFace(kind, text, size) {
  const w = size === 'small' ? 44 : 58;
  const hgt = size === 'small' ? 62 : 82;
  const base = `box-sizing:border-box;width:${w}px;height:${hgt}px;border-radius:6px;display:flex;` +
    'align-items:center;justify-content:center;font-weight:700;flex:none;';
  if (kind === 'up') {
    const fs = text.length > 3 ? 13 : text.length > 2 ? 17 : 22;
    return el('div', base + `background:${C.card};color:${C.ink};font-size:${fs}px;box-shadow:0 2px 0 rgba(0,0,0,.35)`, text);
  }
  if (kind === 'down') {
    return el('div', base + `border:2px solid ${C.accent};color:${C.accent};font-size:20px;` +
      `background:repeating-linear-gradient(45deg,${C.back} 0 6px,#2d281e 6px 12px)`, '✓');
  }
  if (kind === 'bad') {
    return el('div', base + `border:1px dashed ${C.bad};color:${C.bad};font-size:11px;font-weight:400`, text);
  }
  return el('div', base + `border:1px dashed ${C.faint};color:${C.faint};font-size:12px;font-weight:400`, text);
}

// Who sits at the table: everybody whose disk is running, and everybody who
// has a card in this round even if they have since walked out.
function seats() {
  const ids = new Set(Object.keys(S.commits).map(Number));
  if (solo()) ids.add(-1);
  for (const p of room.players) if (running.has(p.id) || p.id === myId()) ids.add(p.id);
  return [...ids].sort((a, b) => (a === myId() ? -1 : b === myId() ? 1 : a - b));
}

const present = (id) => solo() ? id === -1 : room.players.some((p) => p.id === id);

function render() {
  const d = S.deck;
  const deck = deckOf(d);
  const meWatching = watching(me());

  roundLabel.textContent = sync === 'ok'
    ? `Round ${S.r + 1}` + (past.length ? ` · ${past.length} done` : '')
    : 'Catching up with the room…';
  if (deckSelect.value !== String(d)) deckSelect.value = String(d);
  watchButton.textContent = meWatching ? 'Watching — join the vote' : 'Just watching';
  // A field somebody is typing into keeps what they typed; one they only
  // clicked into follows the room, or "Next story" would leave the old topic
  // standing in the field it has just focused.
  if (!topicDirty && topicInput.value !== S.topic) topicInput.value = S.topic;

  // ── the table
  table.replaceChildren();
  const ids = seats();
  const voters = ids.filter((id) => !watching(id));
  const shown = S.ph === 'shown';
  const sum = shown ? summarise(d, Object.keys(S.commits).map((id) => (id in S.opens ? S.opens[id] : -2))) : null;
  for (const id of ids) {
    const key = String(id);
    const seat = el('div', 'display:flex;flex-direction:column;align-items:center;gap:6px;width:84px');
    let face;
    let note = '';
    if (watching(key)) {
      face = cardFace('empty', 'watching');
    } else if (!shown) {
      face = S.commits[key] ? cardFace('down') : cardFace('empty', 'thinking');
    } else if (!S.commits[key]) {
      face = cardFace('empty', 'no card');
    } else if (key in S.opens) {
      const c = S.opens[key];
      face = c < 0 ? cardFace('bad', 'invalid') : cardFace('up', label(d, c));
      if (c >= 0 && sum.low !== sum.high && (c === sum.low || c === sum.high) && !abstains(d, c)) {
        face.style.outline = `2px solid ${C.accent}`;
        face.style.outlineOffset = '3px';
        note = c === sum.low ? 'lowest' : 'highest';
      }
    } else {
      face = cardFace('down');
      face.style.opacity = '.55';
      note = present(id) ? 'opening…' : 'left, withheld';
    }
    const name = el('div', `max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;` +
      `color:${id === myId() ? C.text : C.dim};font-weight:${id === myId() ? 700 : 400}`,
      id === myId() && !solo() ? nickOf(key) + ' (you)' : nickOf(key));
    if (!present(id)) name.style.color = C.faint;
    seat.append(face, name);
    if (note) seat.append(el('div', `font:10px ${MONO};color:${C.muted};text-transform:uppercase`, note));
    table.appendChild(seat);
  }

  // ── what to do next
  statusBox.replaceChildren();
  result.replaceChildren();
  const votedCount = voters.filter((id) => S.commits[String(id)]).length;
  if (!shown) {
    const waiting = voters.filter((id) => !S.commits[String(id)] && present(id)).map((id) => nickOf(String(id)));
    const line = votedCount === 0
      ? 'Nobody has picked a card yet.'
      : waiting.length === 0
        ? 'Everybody has picked. Turn the cards over.'
        : `${votedCount} picked · waiting for ${waiting.join(', ')}`;
    statusBox.append(el('div', `width:100%;color:${C.muted}`, line));
    const reveal = button('Reveal cards', waiting.length === 0 && votedCount > 0 ? 'primary' : undefined);
    reveal.disabled = votedCount === 0 || sync !== 'ok';
    reveal.style.opacity = reveal.disabled ? '.45' : '';
    reveal.onclick = () => act({ t: 'reveal', r: S.r });
    const restart = button('Start over');
    restart.disabled = votedCount === 0 || sync !== 'ok';
    restart.style.opacity = restart.disabled ? '.45' : '';
    restart.onclick = () => act({ t: 'round', r: S.r, topic: S.topic, deck: S.deck });
    statusBox.append(reveal, restart);
  } else {
    showResult(d, sum);
  }

  // ── my hand
  hand.replaceChildren();
  handTitle.textContent = meWatching
    ? 'You are watching this round'
    : shown ? 'The cards are over' : picked === null ? 'Pick a card' : 'Your card — pick it again to take it back';
  if (!meWatching && !shown) {
    deck.cards.forEach((_, c) => {
      const chosen = picked === c;
      const b = el('button',
        `box-sizing:border-box;width:${COARSE ? 52 : 50}px;height:${COARSE ? 72 : 70}px;border-radius:6px;cursor:pointer;` +
        `font:700 ${label(d, c).length > 2 ? 14 : 19}px ${FONT};transition:transform .08s;` +
        (chosen
          ? `background:${C.card};color:${C.ink};border:2px solid ${C.accent};transform:translateY(-8px)`
          : `background:${C.surface};color:${C.text};border:1px solid ${C.border}`),
        label(d, c));
      b.title = deck.cards[c] === '?' ? 'No idea' : deck.cards[c] === 'coffee' ? 'I need a break' : '';
      b.onclick = () => pick(c);
      b.disabled = sync !== 'ok';
      hand.appendChild(b);
    });
  }

  // ── the log
  const done = past.filter((e) => e !== null);
  logTitle.textContent = `Session log (${done.length})`;
  logList.replaceChildren();
  if (done.length === 0) logList.append(el('div', `color:${C.faint};font-size:13px`, 'Finished rounds land here.'));
  done.slice().reverse().forEach((e) => {
    const s = summarise(e.d, e.v.map((x) => x[1]));
    const est = e.f !== null && e.f !== undefined ? label(e.d, e.f) : suggested(s) !== null ? '~' + label(e.d, suggested(s)) : '—';
    const row = el('div', `display:flex;gap:10px;align-items:baseline;font-size:13px;border-bottom:1px solid ${C.border};padding-bottom:6px`);
    row.append(
      el('span', `font:700 15px ${FONT};color:${C.accent};min-width:44px`, est),
      el('span', `flex:1;color:${C.dim}`, e.t || 'Round ' + e.n),
      el('span', `color:${C.muted};font-size:12px`, e.v.map(([nick, c]) => `${nick} ${cardText(e.d, c)}`).join(' · ')));
    logList.append(row);
  });
  logText.value = summaryText();
}

function stat(name, value, strong) {
  const box = el('div', `display:flex;flex-direction:column;gap:2px;padding:10px 14px;background:${C.surface};` +
    `border:1px solid ${strong ? C.accent : C.border};border-radius:4px;min-width:84px`);
  box.append(el('div', `font:10px ${MONO};color:${C.muted};text-transform:uppercase;letter-spacing:.06em`, name),
    el('div', `font-size:22px;font-weight:700;color:${strong ? C.accent : C.text}`, value));
  return box;
}

function showResult(d, sum) {
  const deck = deckOf(d);
  const by = S.by !== null ? nickOf(String(S.by)) : null;
  const pending = Object.keys(S.commits).filter((id) => !(id in S.opens) && present(Number(id))).length;
  statusBox.append(el('div', `width:100%;color:${C.muted}`,
    (by ? `${by} turned the cards over.` : 'The cards are over.') +
    (pending ? ` ${pending} still opening…` : '')));

  const stats = el('div', 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center');
  if (sum.counted.length === 0) {
    stats.append(stat('Result', 'no estimates'));
  } else {
    if (sum.consensus !== null) stats.append(stat('Consensus', label(d, sum.consensus), true));
    if (sum.average !== null) stats.append(stat('Average', String(Math.round(sum.average * 10) / 10)));
    if (sum.nearest !== null && sum.consensus === null) stats.append(stat('Nearest card', label(d, sum.nearest)));
    stats.append(stat('Median', label(d, sum.median)));
    if (sum.low !== sum.high) stats.append(stat('Spread', `${label(d, sum.low)}–${label(d, sum.high)}`));
  }
  result.append(stats);

  // How the cards fell, one bar per card that somebody played.
  const bars = el('div', 'display:flex;gap:6px;justify-content:center;align-items:flex-end;min-height:70px');
  const most = Math.max(1, ...sum.counts.values());
  deck.cards.forEach((_, c) => {
    const n = sum.counts.get(c) || 0;
    if (!n) return;
    const col = el('div', 'display:flex;flex-direction:column;align-items:center;gap:3px');
    col.append(el('div', `font:11px ${MONO};color:${C.muted}`, String(n)),
      el('div', `width:26px;height:${8 + Math.round((n / most) * 44)}px;border-radius:3px 3px 0 0;` +
        `background:${abstains(d, c) ? C.faint : C.accent}`),
      el('div', `font-size:13px;color:${C.dim}`, label(d, c)));
    bars.append(col);
  });
  result.append(bars);

  if (sum.low !== null && sum.low !== sum.high) {
    const holders = (c) => Object.keys(S.opens).filter((id) => S.opens[id] === c).map((id) => nickOf(id));
    result.append(el('div', `text-align:center;color:${C.muted};font-size:13px`,
      `Lowest ${label(d, sum.low)} from ${holders(sum.low).join(', ')}; highest ${label(d, sum.high)} from ` +
      `${holders(sum.high).join(', ')}. Hear them out before voting again.`));
  }

  // The estimate the room settles on is one more action, so the log records
  // what the room agreed rather than what a formula guessed.
  const finalRow = el('div', 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;align-items:center');
  finalRow.append(el('span', `color:${C.muted};font-size:13px;margin-right:4px`, 'Settle on'));
  const hint = suggested(sum);
  deck.cards.forEach((_, c) => {
    if (abstains(d, c)) return;
    const on = S.final === c;
    const b = el('button',
      `min-width:${TAP}px;min-height:${TAP}px;padding:0 8px;border-radius:4px;cursor:pointer;font:600 14px ${FONT};` +
      (on ? `background:${C.accent};color:${C.ink};border:0`
        : `background:${C.surface};color:${C.dim};border:1px ${c === hint ? 'dashed ' + C.accent : 'solid ' + C.border}`),
      label(d, c));
    b.onclick = () => act({ t: 'final', r: S.r, c: on ? null : c });
    finalRow.append(b);
  });
  result.append(finalRow);

  const next = el('div', 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center');
  const nextStory = button('Next story', 'primary');
  nextStory.onclick = () => {
    act({ t: 'round', r: S.r, topic: '', deck: S.deck });
    setTimeout(() => topicInput.focus(), 0);
  };
  const again = button('Vote again');
  again.onclick = () => act({ t: 'round', r: S.r, topic: S.topic, deck: S.deck });
  next.append(nextStory, again);
  result.append(next);
}

// ── start ───────────────────────────────────────────────────────────────────

if (solo()) {
  haveTable = true;
  render();
} else {
  render();
  hello(false);
}
