/**
 * @disk     jinx
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Cursed idols come up one at a time, each worth its number in bad luck. Pay a coin to pass it on, or take it with every coin piled on it. A run of idols counts only its lowest, and the leader pays two to pass. Least bad luck wins.
 * @tags     game, party, cards, push-your-luck, turn-based
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/jinx.png
 */
// jinx.js — a pay-or-take card game, run by the host.
//
// Thirty-three cursed idols are numbered 3 to 35, and nine of them are set
// aside unseen before the game, so nobody can count on the one that would
// close their gap. One idol is turned up at a time. Whoever's turn it is
// either pays a coin onto it and passes it to the next player, or takes it,
// with every coin piled on it so far, and turns up the next. An idol counts
// its number against whoever holds it, a coin counts one for them, and an
// unbroken run of idols counts only its lowest: 21, 22, 23 and 24 cost 21
// together. So every idol is poison until the pot on it is fat enough, or it
// fits somebody's run, and the pot grows for exactly as long as everybody
// believes somebody else will blink first. A player well ahead pays two coins
// to pass rather than one, which drains the leader and keeps a trailing player
// in the game. When the last idol is taken, the least bad luck wins.
//
// The host is the authority. A move travels to the host alone, and counts only
// from the player whose turn it is, for the idol on the table, and a pass only
// from somebody who can pay for it; the host deals and broadcasts the table.
// The deck's order is the one thing on the table nobody else holds, and a new
// host draws its own from the idols nobody has seen, which is the same draw by
// another hand. What this does not stop is a hostile host: it shuffles the
// deck and keeps the clock, and nothing in a host-run game can take that from
// it. Coins and idols are public, as they are on a real table where everybody
// sees every pass.
//
// A player alone is dealt a practice game against two bots at once, and
// another after it, for as long as nobody else runs the disk. When somebody
// does, practice ends three seconds on under a note that says so, and the host
// deals the real game.

// ── rules ───────────────────────────────────────────────────────────────────

const MAX_SEATS = 8;
const LOW = 3, HIGH = 35;    // the idols, numbered
const HIDDEN = 9;            // set aside unseen every game
const TURN_MS = 10000;       // a turn runs this long before it plays itself
const OVER_MS = 9000;        // a finished game is on screen this long before the next
const PRACTICE_AGAIN = 6000; // and a finished practice game this long
const JOIN_MS = 3000;        // practice runs on this long after somebody joins
const GRACE = 8000;          // how long a dropped connection has to come back
const AWAY_MS = 1500;        // a turn whose player has dropped out waits this long
const PASS_MS = 420;         // a coin sliding onto the pot
const TAKE_MS = 900;         // an idol carried off, and the next turned up
const LEAD_GAP = 5;          // a leader this far ahead pays two to pass
const BOT_NAMES = ['Bot Ruby', 'Bot Onyx'];

// Fewer coins at a bigger table, so the pot has to go round fewer times
// before somebody runs dry.
const startCoins = (n) => (n <= 5 ? 11 : n === 6 ? 9 : 7);

// One colour per seat, in seat order, so no two players at a table share one.
const PAL = ['#ff6b7a', '#ffc94d', '#3fe0a6', '#4cbcff', '#b78cff', '#ff9a52', '#ff74c8', '#a6dc5c'];
const C = {
  bg0: '#3a2350', bg1: '#140c22', panel: 'rgba(24,14,38,0.94)', line: '#4c3468',
  row: 'rgba(255,240,220,0.05)', text: '#fbf3e4', dim: '#c7b6dc', faint: '#7f6f99',
  gold: '#ffcc4d', goldDk: '#b8860b', red: '#ff5d73', green: '#5fe0a0',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ── scoring ─────────────────────────────────────────────────────────────────

// Idols in ascending order, cut into unbroken runs.
function runsOf(cards) {
  const s = cards.slice().sort((a, b) => a - b);
  const out = [];
  for (const c of s) {
    const r = out[out.length - 1];
    if (r && c === r[r.length - 1] + 1) r.push(c);
    else out.push([c]);
  }
  return out;
}
// What a hand of idols costs: the lowest of every run.
const idolPts = (cards) => runsOf(cards).reduce((t, r) => t + r[0], 0);
// Bad luck all told, coins counting against it. Lower is better.
const points = (s) => idolPts(s.cards) - s.coins;
// What taking idol `c` with `pot` coins on it would change for a seat.
const takeDelta = (s, c, pot) => idolPts(s.cards.concat([c])) - idolPts(s.cards) - pot;

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g      game number, so a stale move for an old game is recognised
//   ph     'wait' | 'play' | 'over'
//   seats  [{ id, coins, cards }]
//   cur    the idol turned up, 0 once the deck is done
//   pot    coins piled on it
//   left   idols still in the deck, not counting the hidden ones
//   tn     the seat whose turn it is
//   seq    moves made this game, so a move is only ever for the table it saw
//   mv     the last move, [seat, 0 pass | 1 take, idol, coins], for the screen
//   win    the winner's id once the game is over, null for a draw
let S = blank();
let endAt = 0;           // local clock: when this turn ends
let lockUntil = 0;       // local clock: when the last move has finished playing
let joinEnd = 0;         // local clock: when practice ends for somebody who joined, 0 if it does not
let overAt = -1e9;       // local clock: when the last game ended
let gotState = false;

function blank() {
  return { g: 0, ph: 'wait', seats: [], cur: 0, pot: 0, left: 0, tn: 0, seq: 0, mv: null, win: null };
}

// The host's alone.
let deck = [];           // the idols still to come, in order; the host's secret
let lastPub = 0;
let shortAt = 0;         // when the table last fell below two players, 0 if it has not
let botAt = 0;
let awayAt = 0;          // when an absent player's turn started waiting
const here = new Set();  // ids that have said hello: their disk is running

// Mine.
let pending = null;      // { g, seq, at } — a move sent and not yet on the table
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

// The seat well ahead of everybody else, or -1. Only one can be, and only by
// a clear margin, so an even table never pays extra.
function leaderSeat() {
  if (S.seats.length < 2) return -1;
  const p = S.seats.map(points);
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] < p[best]) best = i;
  for (let i = 0; i < p.length; i++) if (i !== best && p[i] - p[best] < LEAD_GAP) return -1;
  return best;
}
const passCost = (i) => (i === leaderSeat() ? 2 : 1);
const canPass = (i) => S.seats[i] && S.seats[i].coins >= passCost(i);

// ── the host ────────────────────────────────────────────────────────────────

const running = () => (solo() ? 1 : room.players.filter((p) => p.id === myId() || here.has(p.id)).length);
// Alone: nobody else in the room, or nobody else's disk has said hello in the
// time a disk that is running would have.
const alone = (now) => running() < 2 && (solo() || room.players.length < 2 || now - startedAt > 4000);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function hostDeal(force) {
  const now = performance.now();
  if (!amHost()) return;
  if (!force && !(S.ph === 'wait' || S.ph === 'over')) return;
  joinEnd = 0;
  let ids = solo() ? [-1] : room.players.filter((p) => p.id === myId() || here.has(p.id)).slice(0, MAX_SEATS).map((p) => p.id);
  // Fewer than two people is a practice table: the host is dealt two bots.
  if (ids.length < 2) ids = ids.concat([-2, -3]);
  const all = [];
  for (let c = LOW; c <= HIGH; c++) all.push(c);
  deck = shuffle(all).slice(HIDDEN);
  S = blank();
  S.g = Math.floor(Math.random() * 1e9) + 1;
  S.ph = 'play';
  const coins = startCoins(ids.length);
  S.seats = shuffle(ids.slice()).map((id) => ({ id, coins, cards: [] }));
  S.cur = deck.pop();
  S.left = deck.length;
  S.tn = Math.floor(Math.random() * ids.length);
  shortAt = 0;
  awayAt = 0;
  lockUntil = now + TAKE_MS;
  startTurn(now);
}

// A host that took over mid-game holds the table but not the deck. Whatever
// nobody has seen is equally likely to be in it, so it draws the deck afresh
// from those, as many as the table says are left.
function redrawDeck() {
  const seen = new Set([S.cur]);
  for (const s of S.seats) for (const c of s.cards) seen.add(c);
  const unseen = [];
  for (let c = LOW; c <= HIGH; c++) if (!seen.has(c)) unseen.push(c);
  deck = shuffle(unseen).slice(0, S.left);
}

function startTurn(now) {
  const from = Math.max(now, lockUntil);
  endAt = from + TURN_MS;
  botAt = from + 650 + Math.random() * 1200;
  awayAt = 0;
  publish(now);
}

const nextSeat = (i) => (i + 1) % S.seats.length;

// A move, from whoever the room says sent it. It counts only during a game,
// once the last move has played out, from the player whose turn it is; a pass
// only from somebody who can pay for it.
function hostAct(id, a, now) {
  if (S.ph !== 'play' || now < lockUntil || !S.cur) return;
  const i = S.tn;
  const s = S.seats[i];
  if (!s || s.id !== id) return;
  if (a === 0) {
    const cost = passCost(i);
    if (s.coins < cost) return;
    s.coins -= cost;
    S.pot += cost;
    S.seq += 1;
    S.mv = [i, 0, S.cur, cost];
    S.tn = nextSeat(i);
    lockUntil = now + PASS_MS;
    startTurn(now);
    return;
  }
  // Whoever takes it turns up the next idol and decides on it first.
  s.cards.push(S.cur);
  s.coins += S.pot;
  S.seq += 1;
  S.mv = [i, 1, S.cur, S.pot];
  S.pot = 0;
  S.cur = deck.length ? deck.pop() : 0;
  S.left = deck.length;
  lockUntil = now + TAKE_MS;
  if (!S.cur) { finish(now, winner()); return; }
  startTurn(now);
}

// The least bad luck; then the fewer idols; null when that is a tie too.
function winner() {
  let best = null, bp = 1e9, bc = 1e9, tie = false;
  for (const s of S.seats) {
    const p = points(s), c = s.cards.length;
    if (p < bp || (p === bp && c < bc)) { best = s.id; bp = p; bc = c; tie = false; }
    else if (p === bp && c === bc) tie = true;
  }
  return tie ? null : best;
}

function finish(now, win) {
  S.ph = 'over';
  S.win = win;
  overAt = Math.max(now, lockUntil);
  endAt = overAt;
  publish(now);
}

// A bot weighs what taking would cost it against how many coins it has left
// to keep refusing with. An idol that fits its own run, and no rival's, it
// lets go round once more to fatten the pot. It thinks for a moment first,
// and now and then it does not do what it meant to.
function botPick(i, sloppy) {
  const s = S.seats[i];
  if (!canPass(i)) return 1;
  const d = takeDelta(s, S.cur, S.pot);
  const fit = idolPts(s.cards.concat([S.cur])) - idolPts(s.cards);
  const rivalFits = S.seats.some((o, j) => j !== i && (o.cards.includes(S.cur - 1) || o.cards.includes(S.cur + 1)));
  const thr = s.coins >= 8 ? -1 : s.coins >= 5 ? 3 : s.coins >= 3 ? 7 : 12;
  let take = d <= thr;
  if (fit <= 0 && !rivalFits && S.pot < 4 && s.coins >= 3 && Math.random() < 0.65) take = false;
  if (fit <= 0 && rivalFits) take = true;
  if (sloppy) return Math.random() < 0.5 ? 1 : 0;
  if (Math.random() < 0.1) take = !take;
  return take ? 1 : canPass(i) ? 0 : 1;
}

// A table with fewer than two people in it is over — but not on the instant:
// a dropped connection comes back as a leave and a join, and one blip must
// not end everybody's game.
function tooFew(now) {
  const live = S.seats.filter((s) => present(s.id));
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
    if (tooFew(now)) { finish(now, winner()); return; }
    const s = S.seats[S.tn];
    if (!s) { S.tn = 0; startTurn(now); return; }
    if (isBot(s.id)) {
      if (now >= botAt) hostAct(s.id, botPick(S.tn, false), now);
    } else if (!present(s.id)) {
      // Somebody whose connection dropped is passed over, and pays nothing
      // for it: they miss the idol, not the game.
      if (!awayAt) awayAt = now;
      else if (now - awayAt > AWAY_MS) { S.tn = nextSeat(S.tn); startTurn(now); }
    } else if (now >= endAt) {
      // A turn that runs out pays to pass if it can, and takes if it cannot.
      hostAct(s.id, canPass(S.tn) ? 0 : 1, now);
    }
  }
  // A heartbeat, so one lost broadcast is never the only thing that carried a
  // change, and a clock that drifted is put back.
  if (S.g > 0 && now - lastPub > 2500) publish(now);
}

function wire(now, withMove) {
  return {
    t: 'st', g: S.g, ph: S.ph,
    seats: S.seats.map((s) => [s.id, s.coins, s.cards]),
    cur: S.cur, pot: S.pot, left: S.left, tn: S.tn, seq: S.seq,
    mv: withMove ? S.mv : null, win: S.win,
    ms: Math.max(0, Math.round(endAt - now)),
    a: Math.max(0, Math.round(lockUntil - now)),
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
// in range, lists of bounded length, every idol held once at most, ids that are
// seated. Anything else is dropped whole.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID_MIN = -8, ID_MAX = 2147483647;
const ms = (v, hi) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, hi) : null);
const DECK = HIGH - LOW + 1;

function stateOf(m) {
  if (!int(m.g, 1, 1e9 + 1) || !['play', 'over'].includes(m.ph)) return null;
  if (!Array.isArray(m.seats) || m.seats.length < 1 || m.seats.length > MAX_SEATS) return null;
  const seen = new Set();
  const seats = [];
  for (const r of m.seats) {
    if (!Array.isArray(r) || r.length !== 3) return null;
    const [id, coins, cards] = r;
    if (!int(id, ID_MIN, ID_MAX) || !int(coins, 0, 200)) return null;
    if (seats.some((s) => s.id === id)) return null;
    if (!Array.isArray(cards) || cards.length > DECK) return null;
    for (const c of cards) {
      if (!int(c, LOW, HIGH) || seen.has(c)) return null;
      seen.add(c);
    }
    seats.push({ id, coins, cards: cards.slice() });
  }
  if (!(m.cur === 0 || (int(m.cur, LOW, HIGH) && !seen.has(m.cur)))) return null;
  if (!int(m.pot, 0, 200) || !int(m.left, 0, DECK) || seen.size + (m.cur ? 1 : 0) + m.left > DECK) return null;
  if (!int(m.tn, 0, seats.length - 1) || !int(m.seq, 0, 1e6)) return null;
  let mv = null;
  if (m.mv !== null && m.mv !== undefined) {
    if (!Array.isArray(m.mv) || m.mv.length !== 4 || !int(m.mv[0], 0, seats.length - 1) || !int(m.mv[1], 0, 1) ||
      !int(m.mv[2], LOW, HIGH) || !int(m.mv[3], 0, 200)) return null;
    mv = m.mv.slice();
  }
  if (!(m.win === null || (int(m.win, ID_MIN, ID_MAX) && seats.some((s) => s.id === m.win)))) return null;
  const t = ms(m.ms, TURN_MS + 5000), a = ms(m.a, 5000);
  if (t === null || a === null) return null;
  return {
    S: { g: m.g, ph: m.ph, seats, cur: m.cur, pot: m.pot, left: m.left, tn: m.tn, seq: m.seq, mv, win: m.win },
    ms: t, a,
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
      case 'act':
        if (!amHost() || !inRoom(from) || msg.g !== S.g || msg.s !== S.seq || !int(msg.a, 0, 1)) break;
        here.add(from);
        hostAct(from, msg.a, now);
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
  // The new host has the table as last broadcast and draws the deck from what
  // nobody has seen. The turn on the table is played again on a fresh clock;
  // nobody loses anything for it.
  const now = performance.now();
  redrawDeck();
  if (S.ph === 'play') startTurn(now);
  else publish(now);
});

// ── my moves ────────────────────────────────────────────────────────────────

const myTurn = () => S.ph === 'play' && S.cur > 0 && S.seats[S.tn] && S.seats[S.tn].id === myId();
const canAct = (now) => myTurn() && now >= lockUntil && !(pending && pending.g === S.g && pending.seq === S.seq && now - pending.at < 1200);

function tryAct(a) {
  const now = performance.now();
  if (!canAct(now)) return;
  if (a === 0 && !canPass(S.tn)) { sfx.deny(); denyAt = now; return; }
  pending = { g: S.g, seq: S.seq, at: now };
  if (amHost()) hostAct(myId(), a, now);
  else if (room.host) room.send({ t: 'act', g: S.g, s: S.seq, a }, { to: room.host.id });
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects come from the table as it changes on this screen, never from the
// wire: a move is played out here from the move the table names.
let shown = { g: 0, seq: -1 };
let anim = null;         // { kind, start, dur, seat, card, coins, delta, landed }
let seenPh = '';
let turnChimeKey = '';
let lastTick = -1;
let denyAt = -1e9;
let celebrated = true;

function observe(now) {
  if (S.g !== shown.g) {
    anim = null;
    if (S.g) { anim = { kind: 'deal', start: now, dur: TAKE_MS, landed: false }; sfx.start(); }
  } else if (S.seq !== shown.seq && S.seq === shown.seq + 1 && S.mv) {
    const [i, a, card, coins] = S.mv;
    const s = S.seats[i];
    if (a === 0) {
      anim = { kind: 'pass', start: now, dur: PASS_MS, seat: i, card, coins, landed: false };
      sfx.coin();
    } else {
      // How much worse, or better, the taker came out: the idol's cost in
      // their hand as it now stands, less the coins that came with it.
      const before = s ? s.cards.filter((c) => c !== card) : [];
      const delta = idolPts(before.concat([card])) - idolPts(before) - coins;
      anim = { kind: 'take', start: now, dur: TAKE_MS, seat: i, card, coins, delta, landed: false };
      sfx.take();
    }
  } else if (S.seq !== shown.seq) anim = null;
  shown = { g: S.g, seq: S.seq };
  const ph = S.g + ':' + S.ph;
  if (ph !== seenPh) {
    seenPh = ph;
    if (S.ph === 'over') celebrated = false;
  }
  if (pending && (pending.g !== S.g || pending.seq !== S.seq)) pending = null;
}

// The halfway point of a move is where its sound lands and its pop shows.
function stepAnim(now) {
  if (!anim) return;
  const t = (now - anim.start) / anim.dur;
  if (!anim.landed && t >= (anim.kind === 'take' ? 0.55 : 0.85)) {
    anim.landed = true;
    if (anim.kind === 'pass') {
      const P = potCentre();
      if (P) burst(P.x, P.y, C.gold, 5, 70);
    } else if (anim.kind === 'take') {
      const P = seatAnchor(anim.seat);
      if (P) {
        burst(P.x, P.y, colorOfSeat(anim.seat), 10, 140);
        const d = anim.delta;
        pop(P.x, P.y - 8, (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d), d > 0 ? C.red : C.green);
        shake = Math.min(8, shake + (d > 10 ? 6 : 3));
      }
      sfx.flip();
    }
  }
  if (t >= 1.2) anim = null;
}

function sideEffects(now) {
  const busy = now < lockUntil;
  if (S.ph === 'over' && !busy && !celebrated) {
    celebrated = true;
    celebrate();
  }
  // A chime when my turn comes round, once the move before it has played.
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
  coin: () => { tone(1900, 0.06, 'square', 0.025); tone(2500, 0.12, 'sine', 0.04, null, 0.04); },
  take: () => { tone(300, 0.22, 'triangle', 0.06, 150); tone(2200, 0.05, 'sine', 0.03, null, 0.05); tone(2600, 0.05, 'sine', 0.03, null, 0.1); },
  flip: () => { tone(520, 0.07, 'triangle', 0.05, 900); },
  turn: () => { tone(740, 0.09, 'sine', 0.06); tone(990, 0.12, 'sine', 0.05, null, 0.08); },
  tick: () => tone(1200, 0.03, 'square', 0.03),
  deny: () => tone(150, 0.12, 'sawtooth', 0.04, 110),
  start: () => [262, 311, 392].forEach((f, i) => tone(f, 0.14, 'triangle', 0.05, null, i * 0.08)),
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
const lerp = (a, b, t) => a + (b - a) * t;

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

// An idol's colour runs from jade for the cheap ones to blood red for the worst.
const hueOf = (v) => Math.round(150 - (clamp(v, LOW, HIGH) - LOW) / (HIGH - LOW) * 150);
const idolCol = (v, l, s) => 'hsl(' + hueOf(v) + ',' + (s || 55) + '%,' + l + '%)';

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
let press = '';
let hoverBtn = '';
let touchSeen = false;

function computeLayout() {
  const n = Math.max(1, S.seats.length);
  const wide = W >= H * 1.05;
  const panelW = wide ? clamp(Math.round(W * 0.36), 140, 300) : 0;
  const noteRoom = practiceTable() ? NOTE_ROOM : 0;
  const rects = [];
  let chipsH = 0;
  if (wide) {
    const x = W - PAD - panelW;
    const rh = clamp(Math.floor((H - TOP - STATUS_H - noteRoom - 8) / n), 30, 66);
    for (let i = 0; i < n; i++) rects.push({ x, y: TOP + 2 + i * rh, w: panelW, h: rh - 6 });
  } else {
    const cols = W < 300 ? 1 : 2;
    const rowsN = Math.ceil(n / cols);
    const ch = 46;
    const cw = (W - 2 * PAD - (cols - 1) * 6) / cols;
    for (let i = 0; i < n; i++) rects.push({ x: PAD + (i % cols) * (cw + 6), y: TOP + Math.floor(i / cols) * (ch + 4), w: cw, h: ch });
    chipsH = rowsN * (ch + 4) + 4;
  }
  const fx = PAD, fy = TOP + chipsH;
  const fw = W - 2 * PAD - (panelW ? panelW + PAD : 0);
  const fh = Math.max(60, H - fy - STATUS_H - noteRoom - 6);
  const seated = mySeatIndex() >= 0 && S.ph !== 'wait';
  const tabH = seated ? clamp(Math.round(fh * 0.22), 42, 92) : 0;
  const btnH = seated && S.ph === 'play' ? clamp(Math.round(fh * 0.12), 34, 50) : 0;
  const gaps = (tabH ? 8 : 0) + (btnH ? 8 : 0);
  const areaH = fh - tabH - btnH - gaps;
  let ch = Math.max(30, areaH * 0.9);
  ch = Math.min(ch, fw * 0.92 / 2.05 * 1.42, 260);
  const cw = ch / 1.42;
  const dw = cw * 0.8, dh = ch * 0.8;
  const pairW = dw + cw * 0.3 + cw;
  const px = fx + (fw - pairW) / 2;
  const cy = fy + (areaH - ch) / 2;
  const card = { x: px + dw + cw * 0.3, y: cy, w: cw, h: ch };
  const deckR = { x: px, y: cy + (ch - dh) / 2, w: dw, h: dh };
  const by = fy + areaH + 8;
  const bw = Math.min(190, (fw - 10) / 2);
  const pass = { x: fx + fw / 2 - bw - 5, y: by, w: bw, h: btnH };
  const take = { x: fx + fw / 2 + 5, y: by, w: bw, h: btnH };
  const tab = { x: fx, y: by + (btnH ? btnH + 8 : 0), w: fw, h: tabH };
  L = { wide, panelW, rects, fx, fy, fw, fh, card, deck: deckR, pass, take, tab, seated };
}

function seatAnchor(i) {
  if (!L) return null;
  if (i === mySeatIndex() && L.seated && L.tab.h > 0) return { x: L.tab.x + L.tab.w / 2, y: L.tab.y + L.tab.h / 2 };
  const r = L.rects[i];
  if (!r) return null;
  return { x: r.x + r.w * 0.7, y: r.y + r.h / 2 };
}
function potCentre() {
  if (!L) return null;
  return { x: L.card.x + L.card.w / 2, y: L.card.y + L.card.h * 0.86 };
}

// ── drawing pieces ──────────────────────────────────────────────────────────

function drawBackground(now) {
  const g = ctx.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.5, Math.max(W, H) * 0.8);
  g.addColorStop(0, C.bg0);
  g.addColorStop(1, C.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // A slow lattice of diamonds, like the cloth of a fortune-teller's table,
  // so the backdrop is never a flat colour.
  ctx.strokeStyle = 'rgba(255,210,150,0.045)';
  ctx.lineWidth = 1;
  const s = 38, off = (now * 0.006) % s;
  ctx.beginPath();
  for (let x = -H - s; x < W + s; x += s) {
    ctx.moveTo(x + off, 0); ctx.lineTo(x + off + H, H);
    ctx.moveTo(x - off + H, 0); ctx.lineTo(x - off, H);
  }
  ctx.stroke();
}

// One coin, a gold disc with a rim and a hole, the way old cash looked.
function drawCoin(x, y, r) {
  ctx.fillStyle = C.goldDk;
  ctx.beginPath();
  ctx.arc(x, y + r * 0.18, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.gold;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(140,90,0,0.55)';
  ctx.lineWidth = Math.max(0.8, r * 0.14);
  ctx.beginPath();
  ctx.arc(x, y, r * 0.66, 0, Math.PI * 2);
  ctx.stroke();
  if (r >= 5) {
    ctx.fillStyle = 'rgba(120,70,0,0.6)';
    ctx.fillRect(x - r * 0.18, y - r * 0.18, r * 0.36, r * 0.36);
  }
}

// The mask every idol wears: a head, two slit eyes and a mouth that grins
// wider the worse the idol is.
function drawMask(x, y, s, v) {
  const t = (clamp(v, LOW, HIGH) - LOW) / (HIGH - LOW);
  ctx.fillStyle = idolCol(v, 40, 50);
  ctx.beginPath();
  ctx.ellipse(x, y, s * 0.42, s * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = idolCol(v, 88, 40);
  for (const k of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(x + k * s * 0.08, y - s * 0.1);
    ctx.lineTo(x + k * s * 0.3, y - s * 0.16 - t * s * 0.06);
    ctx.lineTo(x + k * s * 0.26, y - s * 0.02);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = idolCol(v, 88, 40);
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - s * (0.12 + t * 0.12), y + s * 0.2);
  ctx.quadraticCurveTo(x, y + s * (0.2 + t * 0.16), x + s * (0.12 + t * 0.12), y + s * 0.2);
  ctx.stroke();
}

// An idol card face up, `w` wide. The number is what it costs; the full card
// is the one that counts, a dimmed one is carried free by the run below it.
function drawIdol(x, y, w, h, v, dim, glow) {
  const r = Math.max(3, w * 0.12);
  ctx.save();
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = 18;
  }
  rr(x, y, w, h, r);
  ctx.fillStyle = idolCol(v, 84, 38);
  ctx.fill();
  ctx.restore();
  rr(x, y, w, h, r);
  ctx.strokeStyle = idolCol(v, 46, 55);
  ctx.lineWidth = Math.max(1, w * 0.035);
  ctx.stroke();
  if (w >= 40) {
    rr(x + w * 0.07, y + w * 0.07, w * 0.86, h - w * 0.14, r * 0.7);
    ctx.strokeStyle = idolCol(v, 60, 45);
    ctx.lineWidth = 1;
    ctx.stroke();
    drawMask(x + w / 2, y + h * 0.4, w * 0.62, v);
    text(String(v), x + w / 2, y + h * 0.78, w * 0.34, idolCol(v, 24, 60), 'center', 900);
    text(String(v), x + w * 0.16, y + w * 0.16, w * 0.13, idolCol(v, 30, 60), 'center', 800);
  } else {
    text(String(v), x + w / 2, y + h * 0.55, Math.max(8, w * 0.52), idolCol(v, 24, 60), 'center', 900);
  }
  if (dim) {
    rr(x, y, w, h, r);
    ctx.fillStyle = 'rgba(20,12,34,0.5)';
    ctx.fill();
  }
}

// The deck face down: a few cards' worth of edge, and how many are left.
function drawBack(x, y, w, h) {
  const r = Math.max(3, w * 0.12);
  rr(x, y, w, h, r);
  ctx.fillStyle = '#2b1842';
  ctx.fill();
  ctx.strokeStyle = '#7a56a8';
  ctx.lineWidth = Math.max(1, w * 0.03);
  ctx.stroke();
  rr(x + w * 0.1, y + w * 0.1, w * 0.8, h - w * 0.2, r * 0.6);
  ctx.strokeStyle = 'rgba(255,204,77,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // An eye in the middle of the back.
  const cx = x + w / 2, cy = y + h / 2, s = w * 0.28;
  ctx.strokeStyle = 'rgba(255,204,77,0.6)';
  ctx.lineWidth = Math.max(1, w * 0.03);
  ctx.beginPath();
  ctx.moveTo(cx - s, cy);
  ctx.quadraticCurveTo(cx, cy - s * 0.8, cx + s, cy);
  ctx.quadraticCurveTo(cx, cy + s * 0.8, cx - s, cy);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,204,77,0.7)';
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.26, 0, Math.PI * 2);
  ctx.fill();
}

function drawDeck(now) {
  const d = L.deck;
  const n = S.left + (anim && anim.kind === 'take' && S.cur && (now - anim.start) / anim.dur < 0.55 ? 1 : 0);
  if (n > 0) {
    const layers = Math.min(4, Math.ceil(n / 6));
    for (let k = layers - 1; k >= 0; k--) drawBack(d.x - k * 2, d.y - k * 2, d.w, d.h);
  } else {
    rr(d.x, d.y, d.w, d.h, d.w * 0.12);
    ctx.strokeStyle = 'rgba(199,182,220,0.2)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  text(n + ' left', d.x + d.w / 2, d.y + d.h + 12, 12, C.dim, 'center', 700);
  text(HIDDEN + ' hidden', d.x + d.w / 2, d.y + d.h + 27, 10, C.faint, 'center', 600);
}

// The pot: coins spilled about the foot of the idol, in a spiral that keeps
// the same coin in the same place as it grows.
function drawPot(n, x, y, r) {
  for (let k = 0; k < n; k++) {
    const a = k * 2.39996;
    const d = r * 0.9 * Math.sqrt(k);
    drawCoin(x + Math.cos(a) * d * 1.5, y + Math.sin(a) * d * 0.55, r);
  }
}

function drawCentre(now) {
  const c = L.card;
  const mine = myTurn();
  const busy = now < lockUntil;
  const coinR = clamp(c.w * 0.075, 4, 10);
  // A take carries the old idol and its pot off to the taker, and the next one
  // turns up from the deck behind it.
  if (anim && anim.kind === 'take') {
    const t = (now - anim.start) / anim.dur;
    const P = seatAnchor(anim.seat) || { x: c.x, y: c.y };
    const k = easeInOut(t / 0.6);
    if (t < 0.6) {
      const s = lerp(1, 0.25, k);
      const x = lerp(c.x + c.w / 2, P.x, k), y = lerp(c.y + c.h / 2, P.y, k) - Math.sin(k * Math.PI) * c.h * 0.25;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(k * 0.4);
      drawIdol(-c.w * s / 2, -c.h * s / 2, c.w * s, c.h * s, anim.card, false, null);
      ctx.restore();
      for (let i = 0; i < Math.min(anim.coins, 30); i++) {
        const kk = easeInOut((t - i * 0.006) / 0.6);
        const a = i * 2.39996, d = coinR * 0.9 * Math.sqrt(i);
        const sx = c.x + c.w / 2 + Math.cos(a) * d * 1.5, sy = c.y + c.h * 0.86 + Math.sin(a) * d * 0.55;
        drawCoin(lerp(sx, P.x, kk), lerp(sy, P.y, kk) - Math.sin(kk * Math.PI) * c.h * 0.3, coinR * lerp(1, 0.6, kk));
      }
    }
    if (S.cur && t >= 0.45) {
      const f = clamp((t - 0.45) / 0.45, 0, 1);
      const d = L.deck;
      const x = lerp(d.x, c.x, easeOut(f)), y = lerp(d.y, c.y, easeOut(f));
      const w = lerp(d.w, c.w, easeOut(f)), h = lerp(d.h, c.h, easeOut(f));
      const sx = Math.abs(Math.cos(f * Math.PI));
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.scale(Math.max(0.02, sx), 1);
      if (f < 0.5) drawBack(-w / 2, -h / 2, w, h);
      else drawIdol(-w / 2, -h / 2, w, h, S.cur, false, null);
      ctx.restore();
    }
    return;
  }
  if (anim && anim.kind === 'deal') {
    const f = clamp((now - anim.start) / anim.dur, 0, 1);
    if (f < 1 && S.cur) {
      const d = L.deck;
      const x = lerp(d.x, c.x, easeOut(f)), y = lerp(d.y, c.y, easeOut(f));
      const w = lerp(d.w, c.w, easeOut(f)), h = lerp(d.h, c.h, easeOut(f));
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.scale(Math.max(0.02, Math.abs(Math.cos(f * Math.PI))), 1);
      if (f < 0.5) drawBack(-w / 2, -h / 2, w, h);
      else drawIdol(-w / 2, -h / 2, w, h, S.cur, false, null);
      ctx.restore();
      return;
    }
  }
  if (!S.cur) return;
  // A slow bob, and a squash when a coin lands on it.
  let sq = 0;
  if (anim && anim.kind === 'pass') {
    const t = (now - anim.start) / anim.dur;
    if (t > 0.8) sq = Math.sin(clamp((t - 0.8) / 0.4, 0, 1) * Math.PI) * 0.05;
  }
  const bob = Math.sin(now / 700) * 2;
  const seatCol = S.ph === 'play' && S.seats[S.tn] ? colorOfSeat(S.tn) : null;
  ctx.save();
  ctx.translate(c.x + c.w / 2, c.y + c.h + bob);
  ctx.scale(1 + sq, 1 - sq);
  drawIdol(-c.w / 2, -c.h, c.w, c.h, S.cur, false, seatCol && !busy ? alpha(seatCol, mine ? 0.9 : 0.45) : null);
  ctx.restore();
  // Coins already on it, and the one sliding in.
  let n = S.pot;
  if (anim && anim.kind === 'pass') {
    const t = clamp((now - anim.start) / anim.dur, 0, 1);
    if (t < 0.85) {
      n = Math.max(0, S.pot - anim.coins);
      const P = seatAnchor(anim.seat) || { x: c.x, y: c.y };
      const k = easeInOut(t / 0.85);
      const to = potCentre();
      for (let j = 0; j < anim.coins; j++) drawCoin(lerp(P.x, to.x + j * coinR, k), lerp(P.y, to.y, k) - Math.sin(k * Math.PI) * 40, coinR);
    }
  }
  const P = potCentre();
  drawPot(n, P.x, P.y + bob, coinR);
  if (S.pot > 0) {
    const tx = c.x + c.w + 6, ty = c.y + c.h * 0.86 + bob;
    drawCoin(tx + 8, ty, 7);
    text('×' + S.pot, tx + 18, ty, 15, C.gold, 'left', 900);
  }
}

function button(id, label, sub, x, y, w, h, col, on) {
  const pressed = press === id;
  const hot = hoverBtn === id && on;
  ctx.save();
  ctx.globalAlpha = on ? 1 : 0.38;
  rr(x, y + (pressed ? 2 : 0), w, h, h / 2);
  ctx.fillStyle = col;
  ctx.fill();
  if (hot) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke(); }
  const dark = '#22140a';
  if (sub) {
    text(label, x + w / 2, y + h * 0.37 + (pressed ? 2 : 0), Math.min(16, h * 0.36), dark, 'center', 900, w - 20);
    text(sub, x + w / 2, y + h * 0.72 + (pressed ? 2 : 0), Math.min(12, h * 0.26), 'rgba(34,20,10,0.75)', 'center', 700, w - 20);
  } else text(label, x + w / 2, y + h / 2 + (pressed ? 2 : 0), Math.min(16, h * 0.4), dark, 'center', 900, w - 20);
  ctx.restore();
  if (on) btns.push({ id, x, y, w, h });
}

function drawButtons(now) {
  if (!L.seated || S.ph !== 'play' || !L.pass.h) return;
  const i = mySeatIndex();
  const s = S.seats[i];
  const live = canAct(now);
  const cost = passCost(i);
  const keys = !touchSeen;
  const passOk = live && canPass(i);
  const passSub = s.coins < cost ? 'no coins left' : 'pay ' + cost + (cost > 1 ? ' coins' : ' coin') + (cost > 1 ? ' · you lead' : '') + (keys ? ' · N' : '');
  button('pass', 'NO THANKS', passSub, L.pass.x, L.pass.y, L.pass.w, L.pass.h, '#c7b6dc', passOk);
  let takeSub = '';
  if (S.cur) {
    const d = takeDelta(s, S.cur, S.pot);
    takeSub = (d > 0 ? '+' + d : d < 0 ? '−' + Math.abs(d) : '±0') + ' bad luck' + (keys ? ' · T' : '');
  }
  button('take', 'TAKE IT', takeSub, L.take.x, L.take.y, L.take.w, L.take.h, C.gold, live);
  if (now - denyAt < 400) {
    const k = 1 - (now - denyAt) / 400;
    rr(L.pass.x, L.pass.y, L.pass.w, L.pass.h, L.pass.h / 2);
    ctx.strokeStyle = 'rgba(255,93,115,' + k + ')';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

// A hand of idols laid out in runs, `h` tall within `maxW`: the lowest card
// of every run in full, the rest tucked behind it and dimmed, because they
// cost nothing. Returns the width used.
function drawHand(cards, x, y, maxW, h, hideLast) {
  const runs = runsOf(cards);
  if (!runs.length) return 0;
  let cw = h * 0.72, step = cw * 0.5, gap = cw * 0.3;
  const total = () => runs.reduce((t, r) => t + cw + (r.length - 1) * step, 0) + (runs.length - 1) * gap;
  const k = Math.min(1, maxW / Math.max(1, total()));
  if (k < 1) { step *= k; gap *= k; if (total() > maxW) { const k2 = maxW / total(); cw *= k2; step *= k2; gap *= k2; } }
  const ch = Math.min(h, cw / 0.72);
  let cx = x;
  for (const r of runs) {
    for (let j = r.length - 1; j >= 0; j--) {
      if (hideLast !== undefined && r[j] === hideLast) continue;
      drawIdol(cx + j * step, y + (h - ch) / 2, cw, ch, r[j], j > 0, null);
    }
    cx += cw + (r.length - 1) * step + gap;
  }
  return cx - x - gap;
}

// Who is playing: their colour, their name, their coins, their bad luck so
// far, and their idols in runs; whose turn it is and how long it has left.
function drawSeats(now) {
  const n = S.seats.length;
  if (!n) return;
  const lead = leaderSeat();
  const turnLeft = clamp((endAt - Math.max(now, lockUntil)) / TURN_MS, 0, 1);
  const flying = anim && anim.kind === 'take' && (now - anim.start) / anim.dur < 0.55 ? anim : null;
  S.seats.forEach((s, i) => {
    const r = L.rects[i];
    if (!r) return;
    const col = colorOfSeat(i);
    const active = S.ph === 'play' && i === S.tn;
    const away = !present(s.id);
    ctx.save();
    ctx.globalAlpha = away ? 0.5 : 1;
    rr(r.x, r.y, r.w, r.h, Math.min(12, r.h / 2));
    ctx.fillStyle = active ? alpha(col, 0.18) : C.row;
    ctx.fill();
    if (active) { ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke(); }
    const two = r.h >= 40;
    const ly = two ? r.y + 13 : r.y + r.h / 2;
    const dx = r.x + 13, dr = 6;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(dx, ly, dr, 0, Math.PI * 2);
    ctx.fill();
    if (active && now >= lockUntil) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dx, ly, dr + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * turnLeft);
      ctx.stroke();
    }
    // Crowned when well ahead: that seat pays two to pass.
    if (i === lead && S.ph === 'play') {
      ctx.fillStyle = C.gold;
      ctx.beginPath();
      ctx.moveTo(dx - 6, ly - 8); ctx.lineTo(dx - 6, ly - 13); ctx.lineTo(dx - 3, ly - 10); ctx.lineTo(dx, ly - 14);
      ctx.lineTo(dx + 3, ly - 10); ctx.lineTo(dx + 6, ly - 13); ctx.lineTo(dx + 6, ly - 8);
      ctx.closePath();
      ctx.fill();
    }
    const scoreW = 34, coinW = 38;
    const nameW = r.w - 30 - scoreW - coinW;
    text(clip(nameOf(s.id), 12, Math.max(20, nameW)), dx + dr + 7, ly, 12, C.text, 'left', 600);
    drawCoin(r.x + r.w - scoreW - coinW + 6, ly, 5.5);
    text(String(s.coins), r.x + r.w - scoreW - coinW + 15, ly, 12, C.gold, 'left', 800);
    text(String(points(s)), r.x + r.w - 9, ly, 14, col, 'right', 900);
    if (two) {
      const hh = Math.min(r.h - 26, 30);
      if (s.cards.length) drawHand(s.cards, r.x + 8, r.y + 22, r.w - 16, hh, flying && flying.seat === i ? flying.card : undefined);
      else text('no idols yet', r.x + 10, r.y + 22 + hh / 2, 10, C.faint, 'left', 500);
    }
    ctx.restore();
  });
}

// My own idols, big, along the foot of the field.
function drawTableau(now) {
  if (!L.seated || !L.tab.h) return;
  const i = mySeatIndex();
  const s = S.seats[i];
  const t = L.tab;
  rr(t.x, t.y, t.w, t.h, 12);
  ctx.fillStyle = 'rgba(255,240,220,0.06)';
  ctx.fill();
  ctx.strokeStyle = alpha(colorOfSeat(i), 0.5);
  ctx.lineWidth = 1.2;
  ctx.stroke();
  const lw = Math.min(96, t.w * 0.28);
  text('your bad luck', t.x + 10, t.y + 14, 11, C.dim, 'left', 600, lw - 10);
  text(String(points(s)), t.x + 10, t.y + t.h * 0.62, Math.min(28, t.h * 0.42), colorOfSeat(i), 'left', 900);
  const flying = anim && anim.kind === 'take' && anim.seat === i && (now - anim.start) / anim.dur < 0.55 ? anim.card : undefined;
  if (s.cards.length) drawHand(s.cards, t.x + lw, t.y + 6, t.w - lw - 10, t.h - 12, flying);
  else text('take an idol when the pot on it is worth it', t.x + lw + (t.w - lw) / 2, t.y + t.h / 2, 12, C.faint, 'center', 500, t.w - lw - 16);
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
  drawMask(PAD + 11, 22, 22, 20 + Math.round(Math.sin(now / 900) * 12));
  text('JINX', PAD + 28, 22, 17, C.text, 'left', 900);
  if (W >= 380) text('least bad luck wins', W / 2, 22, 12, C.faint, 'center', 600, W * 0.4);
  drawMute();
}

// The line at the foot: whose turn, what to do, and the turn running out.
function drawStatus(now) {
  const y = H - STATUS_H;
  ctx.fillStyle = 'rgba(10,6,18,0.55)';
  ctx.fillRect(0, y, W, STATUS_H);
  const pre = practiceTable() ? 'practice · ' : '';
  let line;
  const s = S.seats[S.tn];
  if (S.g === 0) line = 'pay a coin to pass an idol on, or take it and every coin on it';
  else if (S.ph === 'over') line = pre + 'game over';
  else if (mySeatIndex() < 0) line = 'watching · you play from the next game';
  else if (myTurn()) line = pre + 'your turn · pay to pass the idol on, or take it with its ' + S.pot + (S.pot === 1 ? ' coin' : ' coins');
  else line = pre + (s ? nickOf(s.id) : 'someone') + ' decides · a run of idols costs only its lowest';
  text(line, W / 2, y + STATUS_H / 2 + 1, W < 420 ? 12 : 13, myTurn() && now >= lockUntil ? C.text : C.dim, 'center', 600, W - 24);
  if (S.ph === 'play' && s && now >= lockUntil) {
    const k = clamp((endAt - now) / TURN_MS, 0, 1);
    ctx.fillStyle = colorOfSeat(S.tn);
    ctx.fillRect(0, y, W * k, 3);
  }
}

function drawLobby(now) {
  const pw = Math.min(W - 2 * PAD, 420);
  const ph = Math.min(H - 2 * PAD, 260);
  const x = (W - pw) / 2, y = (H - ph) / 2;
  rr(x, y, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  [7, 21, 33].forEach((v, k) => {
    const w = 36, h = 50;
    const cx = x + pw / 2 + (k - 1) * (w + 12);
    drawIdol(cx - w / 2, y + 18 + Math.sin(now / 500 + k) * 3, w, h, v, false, null);
  });
  text('JINX', x + pw / 2, y + 96, 26, C.text, 'center', 900);
  const lines = [
    'Pay a coin to pass the idol on, or take it',
    'with every coin piled on it. An idol costs its number,',
    'a run of idols only its lowest. Least bad luck wins.',
  ];
  lines.forEach((l, i) => text(l, x + pw / 2, y + 128 + i * 19, 13, C.dim, 'center', 500, pw - 28));
  const dots = '.'.repeat(1 + Math.floor(now / 400) % 3);
  text((amHost() ? 'setting up the table' : 'waiting for the table') + dots, x + pw / 2, y + ph - 26, 13, C.faint, 'center', 500);
}

function drawOver(now) {
  const k = easeOut((now - overAt) / 500);
  ctx.fillStyle = 'rgba(10,6,18,' + 0.62 * k + ')';
  ctx.fillRect(0, 0, W, H);
  const order = S.seats.map((s, i) => ({ s, i, p: points(s) }))
    .sort((a, b) => (a.s.id === S.win ? -1 : b.s.id === S.win ? 1 : 0) || a.p - b.p || a.s.cards.length - b.s.cards.length);
  const pw = Math.min(W - 2 * PAD, 440);
  const rowH = clamp(Math.floor((H - 150) / Math.max(1, order.length)), 22, 40);
  const ph = Math.min(H - 16, 116 + order.length * rowH);
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
  text(title, x + pw / 2, y + 30, 23, wi < 0 ? C.text : colorOfSeat(wi), 'center', 900, pw - 28);
  text('the least bad luck: idols, a run at its lowest, less coins', x + pw / 2, y + 54, 11, C.faint, 'center', 500, pw - 28);
  order.forEach((r, n) => {
    const yy = y + 74 + n * rowH;
    if (yy + rowH > y + ph - 30) return;
    const cy = yy + rowH / 2;
    ctx.fillStyle = colorOfSeat(r.i);
    ctx.beginPath();
    ctx.arc(x + 20, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    const nw = Math.min(110, pw * 0.26);
    text(clip(nameOf(r.s.id), 13, nw), x + 32, cy, 13, C.text, 'left', 600);
    const hx = x + 36 + nw;
    const hw = pw - (hx - x) - 96;
    if (r.s.cards.length) drawHand(r.s.cards, hx, yy + 3, hw, rowH - 6);
    drawCoin(x + pw - 78, cy, 5);
    text('−' + r.s.coins, x + pw - 70, cy, 11, C.gold, 'left', 700);
    text(String(r.p), x + pw - 14, cy, 16, colorOfSeat(r.i), 'right', 900);
  });
  const wait = (practiceTable() ? PRACTICE_AGAIN : OVER_MS) - (now - overAt);
  const left = Math.max(1, Math.ceil(wait / 1000));
  text((practiceTable() ? 'next practice game in ' : 'next game in ') + left, x + pw / 2, y + ph - 18, 13, C.dim, 'center', 600);
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
    sideEffects(now);
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    drawBackground(now);
    if (S.g === 0) drawLobby(now);
    else {
      drawSeats(now);
      drawDeck(now);
      drawTableau(now);
      drawCentre(now);
      drawButtons(now);
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
      ctx.strokeStyle = 'rgba(10,6,18,0.85)';
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
      const tip = joinEnd ? null : 'a run of idols costs only its lowest · every coin counts one off';
      const bottom = L.tab.h ? L.tab.y + L.tab.h : L.card.y + L.card.h + 34;
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
  if (id === 'mute') { muted = !muted; if (!muted) sfx.coin(); }
  else if (id === 'pass') tryAct(0);
  else if (id === 'take') tryAct(1);
}

// A finger or the mouse goes down on a button and the button counts when it
// is let go over the same one, so a thumb that slides off changes its mind.
cv.addEventListener('pointerdown', (e) => {
  audio();
  if (e.pointerType !== 'mouse') touchSeen = true;
  const p = pt(e);
  press = buttonAt(p);
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ }
  e.preventDefault();
});
cv.addEventListener('pointermove', (e) => {
  const p = pt(e);
  hoverBtn = buttonAt(p);
  if (e.pointerType === 'mouse') cv.style.cursor = hoverBtn ? 'pointer' : 'default';
});
cv.addEventListener('pointerup', (e) => {
  const p = pt(e);
  if (press && buttonAt(p) === press) act(press);
  press = '';
  if (e.pointerType !== 'mouse') hoverBtn = '';
});
cv.addEventListener('pointercancel', () => { press = ''; hoverBtn = ''; });
cv.addEventListener('pointerleave', () => { hoverBtn = ''; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  audio();
  touchSeen = false;
  const k = e.key;
  if (e.repeat) return;
  if (k === 'm' || k === 'M') { act('mute'); return; }
  if (k === 'n' || k === 'N' || k === 'ArrowLeft') { tryAct(0); e.preventDefault(); }
  else if (k === 't' || k === 'T' || k === 'ArrowRight' || k === 'Enter') { tryAct(1); e.preventDefault(); }
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
