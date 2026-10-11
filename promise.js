/**
 * @disk     promise
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    A trick-taking card game where you promise exactly how many tricks you will take. Keep it to the trick for ten and more, miss and it costs you. The last to promise can never make the promises add up, and whoever trails is dealt a spare card to throw away.
 * @tags     game, party, cards, trick-taking, turn-based
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/promise.png
 */
// promise.js — an exact-bid trick-taking game, run by the host.
//
// A game is a few hands, each one card bigger than the last. Every hand a
// card is turned up from what is left of the deck and its suit is trump.
// Then, one after another from the dealer's left, everybody promises how many
// tricks they will take: not at least, exactly. The dealer promises last and
// may not make the promises add up to the cards in a hand, so somebody at the
// table is always going to miss. Then the tricks are played: follow the suit
// that was led if you can; the highest trump takes the trick, or the highest
// card of the suit led when no trump was played; whoever takes it leads the
// next. A promise kept scores ten and one for each trick in it; a promise
// missed costs one for every trick it was out by. So a hand of aces is no
// good to somebody who promised none, and the decision on every card is
// whether to win this trick or duck it. Whoever trails the table is dealt one
// card more and throws one away, unseen, before promising: the spare is a
// choice the leader does not get, and it keeps a trailing player in the game.
// The best score after the last hand wins.
//
// The host is the authority. It shuffles and deals, and a hand goes to its
// own player alone, with `to`; the table everybody holds shows only what is
// on it: promises, tricks taken, the trick being played and the trump. A move
// travels to the host alone and counts only from the player whose turn it
// is, for the hand on the table, and only if it is legal. A new host knows
// nobody's hand but its own, so it deals the hand being played afresh, scores
// unchanged. What this does not stop is a hostile host: it deals, it sees
// every hand, and nothing in a host-run game can take that from it.
//
// A player alone is dealt a practice game against three bots at once, and
// another after it, for as long as nobody else runs the disk. When somebody
// does, practice ends three seconds on under a note that says so, and the host
// deals the real game.

// ── rules ───────────────────────────────────────────────────────────────────

const MAX_SEATS = 8;
const DECK = 52;
const BID_MS = 15000;        // a promise runs this long before it makes itself
const PLAY_MS = 12000;       // and a card
const DEAL_MS = 900;         // the cards going round
const CARD_MS = 320;         // a card flying onto the table
const TRICK_MS = 1300;       // a finished trick stays on the table this long
const SWEEP_MS = 450;        // and is swept off to whoever took it
const HAND_MS = 4800;        // the score of a hand is on screen this long
const OVER_MS = 9000;        // a finished game is on screen this long before the next
const PRACTICE_AGAIN = 6000; // and a finished practice game this long
const JOIN_MS = 3000;        // practice runs on this long after somebody joins
const GRACE = 8000;          // how long a dropped connection has to come back
const AWAY_MS = 1500;        // a turn whose player has dropped out waits this long
const EXACT = 10;            // a promise kept scores this, and one a trick
const BOT_NAMES = ['Bot Ruby', 'Bot Onyx', 'Bot Jade'];

// The hands of a game, by the size of the table: fewer and smaller at a big
// table, so a game stays a few minutes long and the deck always has enough.
const sizesFor = (n) => (n <= 3 ? [2, 3, 4, 5, 6] : n <= 5 ? [1, 2, 3, 4, 5] : [1, 2, 3, 4]);

// One colour per seat, in seat order, so no two players at a table share one.
const PAL = ['#ff6b7a', '#ffc94d', '#4cbcff', '#c08cff', '#ff9a52', '#ff74c8', '#a6dc5c', '#5ef0dc'];
const C = {
  bg0: '#1e6450', bg1: '#08251c', panel: 'rgba(6,26,20,0.94)', line: '#2f6b55',
  row: 'rgba(230,255,240,0.05)', text: '#f4fbf5', dim: '#b7d6c6', faint: '#6f9887',
  gold: '#ffcc4d', red: '#ff5d73', green: '#62e6a2', face: '#fbf6ea', edge: '#d8ccb0',
  back0: '#7a1f33', back1: '#4a0f1f',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// A card is a number 0..51: its suit is the number over 13, its rank 2..14.
// The deck has four colours, so a suit reads at a glance on a small screen.
const SUIT_GLYPH = ['♠︎', '♥︎', '♦︎', '♣︎'];
const SUIT_NAME = ['spades', 'hearts', 'diamonds', 'clubs'];
const SUIT_COL = ['#1d2433', '#d6334a', '#2f6fd6', '#1f9a5a'];
const RANK = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const suitOf = (c) => Math.floor(c / 13);
const rankOf = (c) => (c % 13) + 2;

// ── the rules of a trick ────────────────────────────────────────────────────

// The seat that takes a trick: the highest trump, or the highest card of the
// suit that was led.
function trickWinner(trick, trump) {
  if (!trick.length) return -1;
  let best = trick[0];
  for (let k = 1; k < trick.length; k++) {
    const p = trick[k];
    const s = suitOf(p[1]), bs = suitOf(best[1]);
    if (s === trump && bs !== trump) best = p;
    else if (s === bs && rankOf(p[1]) > rankOf(best[1])) best = p;
  }
  return best[0];
}

// What may be played into a trick: the suit led if the hand holds it,
// anything otherwise, and anything at all to lead.
function legalCards(hand, trick) {
  if (!trick.length) return hand.slice();
  const led = suitOf(trick[0][1]);
  const follow = hand.filter((c) => suitOf(c) === led);
  return follow.length ? follow : hand.slice();
}

// The promise the dealer may not make: the one that makes them all add up.
function forbiddenBid(seats, dl, hs) {
  let sum = 0;
  for (let i = 0; i < seats.length; i++) {
    if (i === dl) continue;
    if (seats[i].bid < 0) return -1;
    sum += seats[i].bid;
  }
  const f = hs - sum;
  return f >= 0 && f <= hs ? f : -1;
}

const handScore = (bid, took) => (bid === took ? EXACT + bid : -Math.abs(bid - took));

// Cards in the order a hand is held: by suit, trump last, then by rank.
function sortHand(cards, trump) {
  const key = (c) => {
    const s = suitOf(c);
    const order = s === trump ? 4 : s;
    return order * 20 + rankOf(c);
  };
  return cards.slice().sort((a, b) => key(a) - key(b));
}

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g      game number, so a stale move for an old game is recognised
//   ph     'wait' | 'bid' | 'play' | 'hand' | 'over'
//   hn hc  the hand being played, and how many a game has
//   hs     cards in this hand
//   dk     deals so far this game, so a hand dealt again is a new hand
//   dl     the dealer's seat
//   tn     the seat whose turn it is
//   seq    moves made this game, so a move is only ever for the table it saw
//   tr     the trump card, turned up, -1 before a deal
//   tk     the trick on the table, [[seat, card]] in the order played
//   tw     the seat that took it once it is complete, -1 before
//   seats  [{ id, sc, bid, tk, ex, n }]: score, promise (-1 not yet), tricks
//          taken, a spare card still to throw away, cards in hand
//   last   what the hand just scored, seat by seat, while it is shown
//   mv     the last move, for the screen: ['b', seat, promise] | ['p', seat, card]
//   win    the winner's id once the game is over, null for a draw
let S = blank();
let endAt = 0;           // local clock: when this turn ends
let lockUntil = 0;       // local clock: when the last move has finished playing
let joinEnd = 0;         // local clock: when practice ends for somebody who joined, 0 if it does not
let overAt = -1e9;       // local clock: when the last game ended
let gotState = false;

function blank() {
  return { g: 0, ph: 'wait', hn: 0, hc: 0, hs: 0, dk: 0, dl: 0, tn: 0, seq: 0, tr: -1, tk: [], tw: -1, seats: [], last: null, mv: null, win: null };
}

// The host's alone.
let hands = [];          // every seat's cards, by seat; the host's secret
let lastPub = 0;
let shortAt = 0;         // when the table last fell below two players, 0 if it has not
let botAt = 0;
let awayAt = 0;          // when an absent player's turn started waiting
const here = new Set();  // ids that have said hello: their disk is running

// Mine.
let myHand = { g: 0, dk: 0, c: [] };
let pending = null;      // { g, seq, at, c } — a move sent and not yet on the table
let pendingDc = null;    // { g, dk, at, c } — a card thrown away and not yet confirmed
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
const trumpSuit = () => (S.tr >= 0 ? suitOf(S.tr) : -1);

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

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function hostNewGame(force) {
  const now = performance.now();
  if (!amHost()) return;
  if (!force && !(S.ph === 'wait' || S.ph === 'over')) return;
  joinEnd = 0;
  let ids = solo() ? [-1] : room.players.filter((p) => p.id === myId() || here.has(p.id)).slice(0, MAX_SEATS).map((p) => p.id);
  // Fewer than two people is a practice table: the host is dealt three bots.
  if (ids.length < 2) ids = ids.concat([-2, -3, -4]);
  S = blank();
  S.g = Math.floor(Math.random() * 1e9) + 1;
  S.seats = shuffle(ids.slice()).map((id) => ({ id, sc: 0, bid: -1, tk: 0, ex: 0, n: 0 }));
  S.hc = sizesFor(S.seats.length).length;
  S.dl = Math.floor(Math.random() * S.seats.length);
  shortAt = 0;
  dealHand(now);
}

// Deal the hand `S.hn`: shuffle all 52, give whoever trails one card more,
// turn up a trump, and start the promises from the dealer's left.
function dealHand(now) {
  const n = S.seats.length;
  S.hs = sizesFor(n)[S.hn];
  const deck = shuffle(Array.from({ length: DECK }, (_, k) => k));
  const scores = S.seats.map((s) => s.sc);
  const low = Math.min(...scores), high = Math.max(...scores);
  hands = [];
  S.seats.forEach((s, i) => {
    s.ex = S.hn > 0 && low < high && s.sc === low ? 1 : 0;
    s.bid = -1;
    s.tk = 0;
    hands[i] = deck.splice(0, S.hs + s.ex);
    s.n = hands[i].length;
  });
  S.tr = deck.pop();
  S.ph = 'bid';
  S.tk = [];
  S.tw = -1;
  S.last = null;
  S.mv = null;
  S.dk += 1;
  S.seq += 1;
  S.tn = (S.dl + 1) % n;
  // Bots throw their spare away at once; nobody needs to wait for that.
  S.seats.forEach((s, i) => { if (isBot(s.id) && s.ex) discard(i, botDiscard(i)); });
  lockUntil = now + DEAL_MS;
  awayAt = 0;
  startTurn(now);
  sendHands();
}

function startTurn(now) {
  const from = Math.max(now, lockUntil);
  endAt = from + (S.ph === 'bid' ? BID_MS : PLAY_MS);
  botAt = from + 650 + Math.random() * 1100;
  awayAt = 0;
  publish(now);
}

const nextSeat = (i) => (i + 1) % S.seats.length;

function discard(i, c) {
  const h = hands[i], s = S.seats[i];
  const k = h ? h.indexOf(c) : -1;
  if (!s || !s.ex || k < 0) return false;
  h.splice(k, 1);
  s.ex = 0;
  s.n = h.length;
  return true;
}

// A move by seat `i`, from whoever the room says sent it: kind 'dc' throws
// the spare card away, 'b' promises, 'p' plays a card. Each counts only when
// the rules allow it, and anything else is ignored.
function hostAct(i, kind, v, now) {
  const s = S.seats[i];
  if (!s) return;
  if (kind === 'dc') {
    // The spare goes any time during the promises, without waiting a turn.
    if (S.ph !== 'bid' || !discard(i, v)) return;
    publish(now);
    sendHand(i);
    return;
  }
  if (now < lockUntil || i !== S.tn) return;
  if (kind === 'b') {
    if (S.ph !== 'bid' || s.ex || s.bid >= 0) return;
    if (!Number.isInteger(v) || v < 0 || v > S.hs) return;
    if (i === S.dl && v === forbiddenBid(S.seats, S.dl, S.hs)) return;
    s.bid = v;
    S.seq += 1;
    S.mv = ['b', i, v];
    if (S.seats.every((x) => x.bid >= 0)) {
      S.ph = 'play';
      S.tn = (S.dl + 1) % S.seats.length;
      lockUntil = now + 500;
    } else S.tn = nextSeat(i);
    startTurn(now);
    return;
  }
  if (kind === 'p') {
    if (S.ph !== 'play' || S.tw >= 0 || S.tk.length >= S.seats.length) return;
    const h = hands[i];
    if (!h || !legalCards(h, S.tk).includes(v)) return;
    h.splice(h.indexOf(v), 1);
    s.n = h.length;
    S.tk.push([i, v]);
    S.seq += 1;
    S.mv = ['p', i, v];
    if (S.tk.length === S.seats.length) {
      S.tw = trickWinner(S.tk, trumpSuit());
      S.seats[S.tw].tk += 1;
      lockUntil = now + TRICK_MS;
      publish(now);
    } else {
      S.tn = nextSeat(i);
      lockUntil = now + CARD_MS;
      startTurn(now);
    }
    sendHand(i);
  }
}

// A finished trick leaves the table; whoever took it leads the next, or the
// hand is scored when the cards are gone.
function hostSweep(now) {
  S.tn = S.tw;
  S.tk = [];
  S.tw = -1;
  S.seq += 1;
  S.mv = null;
  lockUntil = now + SWEEP_MS;
  if (S.seats.every((s) => s.n === 0)) {
    S.last = S.seats.map((s) => handScore(s.bid, s.tk));
    S.seats.forEach((s, i) => { s.sc += S.last[i]; });
    S.ph = 'hand';
    endAt = now + HAND_MS;
    publish(now);
    return;
  }
  startTurn(now);
}

function hostNextHand(now) {
  S.hn += 1;
  if (S.hn >= S.hc) { S.hn = S.hc - 1; finish(now, winner()); return; }
  S.dl = nextSeat(S.dl);
  dealHand(now);
}

// The best score; null when that is a tie.
function winner() {
  let best = null, bs = -1e9, tie = false;
  for (const s of S.seats) {
    if (s.sc > bs) { best = s.id; bs = s.sc; tie = false; }
    else if (s.sc === bs) tie = true;
  }
  return tie ? null : best;
}

function finish(now, win) {
  S.ph = 'over';
  S.win = win;
  S.tk = [];
  S.tw = -1;
  overAt = Math.max(now, lockUntil);
  endAt = overAt;
  publish(now);
}

// ── the bots, and a turn that runs out ──────────────────────────────────────

// How likely a card is to take a trick: a trump by its rank, an ace or a
// king of another suit often, anything lower hardly ever; less so at a big
// table, where more cards stand against it.
function cardOdds(c, trump, n) {
  const r = rankOf(c);
  if (suitOf(c) === trump) return 0.3 + 0.7 * (r - 2) / 12;
  const p = r === 14 ? 0.8 : r === 13 ? 0.5 : r === 12 ? 0.22 : 0;
  return p * (n <= 3 ? 1.1 : n >= 6 ? 0.7 : 0.9);
}
const cardValue = (c, trump) => (suitOf(c) === trump ? 100 : 0) + rankOf(c);

function botDiscard(i) {
  const h = hands[i], tr = trumpSuit(), n = S.seats.length;
  let best = h[0];
  for (const c of h) {
    const a = cardOdds(c, tr, n), b = cardOdds(best, tr, n);
    if (a < b || (a === b && rankOf(c) < rankOf(best))) best = c;
  }
  return best;
}

// A promise is the tricks the hand looks good for, rounded, moved one off
// when the dealer may not make it, and now and then a guess one out.
function botBid(i, sloppy) {
  const h = hands[i], tr = trumpSuit(), n = S.seats.length;
  const est = h.reduce((t, c) => t + cardOdds(c, tr, n), 0);
  let v = clamp(Math.round(est), 0, S.hs);
  if (sloppy && Math.random() < 0.15) v = clamp(v + (Math.random() < 0.5 ? -1 : 1), 0, S.hs);
  const f = i === S.dl ? forbiddenBid(S.seats, S.dl, S.hs) : -1;
  if (v === f) v = est > v && v < S.hs ? v + 1 : v > 0 ? v - 1 : v + 1;
  return v;
}

// A card: still short of the promise, win the trick as cheaply as possible
// or throw the least useful card; already there, duck under the trick with
// the highest card that does not take it, and shed the danger.
function botPlay(i, sloppy) {
  const h = hands[i], tr = trumpSuit();
  const legal = legalCards(h, S.tk);
  if (sloppy && Math.random() < 0.08) return legal[Math.floor(Math.random() * legal.length)];
  const s = S.seats[i];
  const want = s.tk < s.bid;
  const byVal = legal.slice().sort((a, b) => cardValue(a, tr) - cardValue(b, tr));
  const lowest = byVal[0], highest = byVal[byVal.length - 1];
  if (!S.tk.length) {
    if (want) return highest;
    const plain = byVal.filter((c) => suitOf(c) !== tr);
    return plain.length ? plain[0] : lowest;
  }
  const wins = (c) => trickWinner(S.tk.concat([[i, c]]), tr) === i;
  const winners = byVal.filter(wins), losers = byVal.filter((c) => !wins(c));
  if (want) return winners.length ? winners[0] : lowest;
  return losers.length ? losers[losers.length - 1] : highest;
}

function autoMove(i, sloppy, now) {
  const s = S.seats[i];
  if (S.ph === 'bid') {
    if (s.ex) hostAct(i, 'dc', botDiscard(i), now);
    hostAct(i, 'b', botBid(i, sloppy), now);
  } else if (S.ph === 'play') hostAct(i, 'p', botPlay(i, sloppy), now);
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
  if (alone(now) && (S.ph === 'wait' || (S.ph === 'over' && now - overAt >= PRACTICE_AGAIN))) { hostNewGame(); return; }
  // Somebody joined a practice game: it ends three seconds on, for the real one.
  if (running() >= 2 && practiceTable()) {
    if (!joinEnd) { joinEnd = now + JOIN_MS; publish(now); }
    else if (now >= joinEnd) { hostNewGame(true); return; }
  } else if (joinEnd) { joinEnd = 0; publish(now); }
  // Two or more people: a game is dealt at once, and the next one when the
  // last has been on screen long enough to read.
  if (running() >= 2 && !practiceTable() && (S.ph === 'wait' || (S.ph === 'over' && now - overAt >= OVER_MS))) { hostNewGame(); return; }
  if ((S.ph === 'bid' || S.ph === 'play' || S.ph === 'hand') && tooFew(now)) { finish(now, winner()); return; }
  if (S.ph === 'hand' && now >= endAt) { hostNextHand(now); return; }
  if (S.ph === 'play' && S.tw >= 0 && now >= lockUntil) { hostSweep(now); return; }
  if ((S.ph === 'bid' || S.ph === 'play') && S.tw < 0 && now >= lockUntil) {
    const s = S.seats[S.tn];
    if (!s) { S.tn = 0; startTurn(now); return; }
    if (isBot(s.id)) {
      if (now >= botAt) autoMove(S.tn, true, now);
    } else if (!present(s.id)) {
      // Somebody whose connection dropped is played for, the way a turn
      // that runs out is: the table goes on and their seat stays theirs.
      if (!awayAt) awayAt = now;
      else if (now - awayAt > AWAY_MS) autoMove(S.tn, false, now);
    } else if (now >= endAt) autoMove(S.tn, false, now);
  }
  // A heartbeat, so one lost broadcast is never the only thing that carried a
  // change, and a clock that drifted is put back.
  if (S.g > 0 && now - lastPub > 2500) { publish(now); sendHands(); }
}

function wire(now) {
  return {
    t: 'st', g: S.g, ph: S.ph, hn: S.hn, hc: S.hc, hs: S.hs, dk: S.dk, dl: S.dl, tn: S.tn, seq: S.seq,
    tr: S.tr, tk: S.tk.map((p) => p.slice()), tw: S.tw,
    seats: S.seats.map((s) => [s.id, s.sc, s.bid, s.tk, s.ex, s.n]),
    last: S.last, mv: S.mv, win: S.win,
    ms: Math.max(0, Math.round(endAt - now)),
    a: Math.max(0, Math.round(lockUntil - now)),
    j: joinEnd ? Math.max(0, Math.round(joinEnd - now)) : -1,
  };
}

function publish(now) {
  lastPub = now;
  if (!solo()) room.send(wire(now));
  observe(now);
}

// A hand goes to its own player alone. The host's own is simply kept.
function sendHand(i) {
  const s = S.seats[i];
  if (!s || isBot(s.id) || !hands[i]) return;
  if (s.id === myId()) { myHand = { g: S.g, dk: S.dk, c: hands[i].slice() }; return; }
  if (!solo() && inRoom(s.id)) room.send({ t: 'hd', g: S.g, dk: S.dk, c: hands[i].slice() }, { to: s.id });
}
function sendHands() {
  if (S.ph !== 'bid' && S.ph !== 'play') return;
  S.seats.forEach((s, i) => sendHand(i));
}

// ── receiving ───────────────────────────────────────────────────────────────

// A table off the wire is a claim and is read as one: the right shape, numbers
// in range, lists of bounded length, every card on the table once at most, ids
// that are seated. Anything else is dropped whole.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID_MIN = -8, ID_MAX = 2147483647;
const ms = (v, hi) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, hi) : null);

function cardList(a, max) {
  if (!Array.isArray(a) || a.length > max) return null;
  const seen = new Set();
  for (const c of a) {
    if (!int(c, 0, DECK - 1) || seen.has(c)) return null;
    seen.add(c);
  }
  return a.slice();
}

function stateOf(m) {
  if (!int(m.g, 1, 1e9 + 1) || !['bid', 'play', 'hand', 'over'].includes(m.ph)) return null;
  if (!Array.isArray(m.seats) || m.seats.length < 1 || m.seats.length > MAX_SEATS) return null;
  const n = m.seats.length;
  if (!int(m.hc, 1, 8) || !int(m.hn, 0, m.hc - 1) || !int(m.hs, 1, 13) || !int(m.dk, 1, 1e6)) return null;
  if (!int(m.dl, 0, n - 1) || !int(m.tn, 0, n - 1) || !int(m.seq, 0, 1e7)) return null;
  const seats = [];
  for (const r of m.seats) {
    if (!Array.isArray(r) || r.length !== 6) return null;
    const [id, sc, bid, tk, ex, cn] = r;
    if (!int(id, ID_MIN, ID_MAX) || seats.some((s) => s.id === id)) return null;
    if (!int(sc, -10000, 10000) || !int(bid, -1, m.hs) || !int(tk, 0, m.hs) || !int(ex, 0, 1) || !int(cn, 0, m.hs + 1)) return null;
    seats.push({ id, sc, bid, tk, ex, n: cn });
  }
  if (!int(m.tr, 0, DECK - 1)) return null;
  if (!Array.isArray(m.tk) || m.tk.length > n) return null;
  const used = new Set([m.tr]), seatsIn = new Set();
  const tk = [];
  for (const p of m.tk) {
    if (!Array.isArray(p) || p.length !== 2 || !int(p[0], 0, n - 1) || !int(p[1], 0, DECK - 1)) return null;
    if (used.has(p[1]) || seatsIn.has(p[0])) return null;
    used.add(p[1]);
    seatsIn.add(p[0]);
    tk.push([p[0], p[1]]);
  }
  if (!int(m.tw, -1, n - 1)) return null;
  let last = null;
  if (m.last !== null && m.last !== undefined) {
    if (!Array.isArray(m.last) || m.last.length !== n || !m.last.every((v) => int(v, -100, 100))) return null;
    last = m.last.slice();
  }
  let mv = null;
  if (m.mv !== null && m.mv !== undefined) {
    if (!Array.isArray(m.mv) || m.mv.length !== 3 || !int(m.mv[1], 0, n - 1)) return null;
    if (m.mv[0] === 'b' && int(m.mv[2], 0, m.hs)) mv = ['b', m.mv[1], m.mv[2]];
    else if (m.mv[0] === 'p' && int(m.mv[2], 0, DECK - 1)) mv = ['p', m.mv[1], m.mv[2]];
    else return null;
  }
  if (!(m.win === null || (int(m.win, ID_MIN, ID_MAX) && seats.some((s) => s.id === m.win)))) return null;
  const t = ms(m.ms, Math.max(BID_MS, HAND_MS) + 5000), a = ms(m.a, 5000);
  if (t === null || a === null) return null;
  return {
    S: { g: m.g, ph: m.ph, hn: m.hn, hc: m.hc, hs: m.hs, dk: m.dk, dl: m.dl, tn: m.tn, seq: m.seq, tr: m.tr, tk, tw: m.tw, seats, last, mv, win: m.win },
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
      case 'hi': {
        if (!inRoom(from)) break;
        here.add(from);
        // One answer a second to any one seat, however often it asks.
        if (amHost() && S.g > 0 && now - (hiAt.get(from) || -1e9) > 1000) {
          hiAt.set(from, now);
          room.send(wire(now), { to: from });
          const i = seatIndex(from);
          if (i >= 0 && (S.ph === 'bid' || S.ph === 'play')) sendHand(i);
        }
        break;
      }
      // A move counts only from a seat at this game, for this deal; the host
      // checks the rest against the rules and the hand it dealt.
      case 'dc':
      case 'b':
      case 'p': {
        if (!amHost() || !inRoom(from) || msg.g !== S.g || msg.dk !== S.dk) break;
        if (msg.t !== 'dc' && msg.s !== S.seq) break;
        const i = seatIndex(from);
        const max = msg.t === 'b' ? 13 : DECK - 1;
        if (i < 0 || !int(msg.v, 0, max)) break;
        here.add(from);
        hostAct(i, msg.t, msg.v, now);
        break;
      }
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
      case 'hd': {
        if (amHost() || !fromHost(from) || msg.g !== S.g || !int(msg.dk, 1, 1e6) || msg.dk < S.dk) break;
        const c = cardList(msg.c, 14);
        if (!c) break;
        myHand = { g: msg.g, dk: msg.dk, c };
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
  // The new host has the table as last broadcast, and nobody's cards but its
  // own. A hand in progress is dealt again, scores unchanged; nobody loses
  // anything for it but the cards they held.
  const now = performance.now();
  if (S.ph === 'bid' || S.ph === 'play') {
    S.seats.forEach((s) => { s.tk = 0; });
    dealHand(now);
  } else {
    if (S.ph === 'hand') endAt = now + HAND_MS;
    publish(now);
  }
});

// ── my moves ────────────────────────────────────────────────────────────────

const mySeat = () => S.seats[mySeatIndex()] || null;
const myTurn = () => (S.ph === 'bid' || S.ph === 'play') && S.tw < 0 && S.seats[S.tn] && S.seats[S.tn].id === myId();
const waiting = (now) => pending && pending.g === S.g && pending.seq === S.seq && now - pending.at < 1500;
const canAct = (now) => myTurn() && now >= lockUntil && !waiting(now);
const handFresh = () => myHand.g === S.g && myHand.dk === S.dk;

// The cards I hold, as this screen should show them: not one already on the
// table, nor one sent and not yet answered.
function heldCards(now) {
  if (!handFresh() || !(S.ph === 'bid' || S.ph === 'play')) return [];
  const out = new Set(S.tk.map((p) => p[1]));
  if (waiting(now) && pending.c >= 0) out.add(pending.c);
  if (pendingDc && pendingDc.g === S.g && pendingDc.dk === S.dk && now - pendingDc.at < 1500) out.add(pendingDc.c);
  return sortHand(myHand.c.filter((c) => !out.has(c)), trumpSuit());
}

function send(kind, v) {
  const now = performance.now();
  const i = mySeatIndex();
  if (i < 0) return;
  if (amHost()) hostAct(i, kind, v, now);
  else if (room.host) room.send({ t: kind, g: S.g, dk: S.dk, s: S.seq, v }, { to: room.host.id });
}

function tryBid(v) {
  const now = performance.now();
  const s = mySeat();
  if (!s || S.ph !== 'bid' || !canAct(now)) return;
  if (s.ex || v < 0 || v > S.hs || (S.tn === S.dl && v === forbiddenBid(S.seats, S.dl, S.hs))) { sfx.deny(); denyAt = now; return; }
  pending = { g: S.g, seq: S.seq, at: now, c: -1 };
  send('b', v);
}

// A card from my hand: thrown away while I hold a spare, played on my turn.
function tryCard(c) {
  const now = performance.now();
  const s = mySeat();
  if (!s) return;
  if (S.ph === 'bid' && s.ex) {
    if (pendingDc && pendingDc.dk === S.dk && now - pendingDc.at < 1500) return;
    pendingDc = { g: S.g, dk: S.dk, at: now, c };
    sfx.flick();
    send('dc', c);
    return;
  }
  if (S.ph !== 'play' || !canAct(now)) { if (S.ph === 'play') { sfx.deny(); denyAt = now; } return; }
  if (!legalCards(heldCards(now), S.tk).includes(c)) { sfx.deny(); denyAt = now; denyCard = c; return; }
  pending = { g: S.g, seq: S.seq, at: now, c };
  send('p', c);
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects come from the table as it changes on this screen, never from the
// wire: a card is flown in from the card the trick names.
let shown = { g: 0, dk: 0, seq: -1, tk: [], tw: -1, ph: '' };
let dealAt = -1e9;
let flights = [];        // [{ i, c, start }] cards on their way into the trick
let sweep = null;        // { cards, to, start } a finished trick going to its taker
let wonAt = -1e9;        // when the trick on the table was taken
let turnChimeKey = '';
let lastTick = -1;
let denyAt = -1e9;
let denyCard = -1;
let celebrated = true;

function observe(now) {
  const n = S.seats.length;
  if (S.g !== shown.g || S.dk !== shown.dk) {
    flights = [];
    sweep = null;
    wonAt = -1e9;
    if (S.g && S.ph === 'bid') { dealAt = now; sfx.deal(); }
  } else {
    const was = shown.tk;
    if (S.tk.length > was.length) {
      for (let k = was.length; k < S.tk.length; k++) {
        const [i, c] = S.tk[k];
        flights.push({ i, c, start: now + (k - was.length) * 90 });
        const ruff = k > 0 && suitOf(c) === trumpSuit() && suitOf(S.tk[0][1]) !== trumpSuit();
        if (ruff) { sfx.trump(); shake = Math.min(6, shake + 3); } else sfx.card();
      }
    }
    if (S.tw >= 0 && shown.tw < 0) {
      wonAt = now;
      const me = S.seats[S.tw] && S.seats[S.tw].id === myId();
      sfx.take(me);
      const P = seatAnchor(S.tw);
      if (P) pop(P.x, P.y - 6, '+1 trick', colorOfSeat(S.tw));
      if (L) {
        const q = slotOf(S.tw);
        burst(q.x + q.w / 2, q.y + q.h / 2, colorOfSeat(S.tw), 16, 170);
      }
    }
    if (!S.tk.length && was.length === n && shown.tw >= 0) {
      sweep = { cards: was.map((p) => p.slice()), to: shown.tw, start: now };
      sfx.sweep();
    }
    if (S.mv && S.mv[0] === 'b' && S.seq === shown.seq + 1) {
      const [, i, v] = S.mv;
      const P = seatAnchor(i);
      if (P) pop(P.x, P.y - 6, 'promises ' + v, colorOfSeat(i));
      sfx.bid(v);
    }
  }
  if (S.ph === 'hand' && shown.ph !== 'hand' && S.last && S.g === shown.g) {
    const i = mySeatIndex();
    let mine = null;
    S.seats.forEach((s, k) => {
      const d = S.last[k];
      const P = seatAnchor(k);
      if (P) {
        pop(P.x, P.y + 4, (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d), d > 0 ? C.green : C.red);
        if (d > 0) burst(P.x, P.y, colorOfSeat(k), 12, 150);
      }
      if (k === i) mine = d;
    });
    if (mine !== null) mine > 0 ? sfx.exact() : sfx.miss();
    else sfx.sweep();
  }
  if (S.ph === 'over' && (shown.ph !== 'over' || S.g !== shown.g)) celebrated = false;
  if (pending && (pending.g !== S.g || pending.seq !== S.seq)) pending = null;
  shown = { g: S.g, dk: S.dk, seq: S.seq, tk: S.tk.map((p) => p.slice()), tw: S.tw, ph: S.ph };
}

function sideEffects(now) {
  if (S.ph === 'over' && now >= lockUntil && !celebrated) {
    celebrated = true;
    celebrate();
  }
  // A chime when my turn comes round, once the move before it has played.
  const key = S.g + ':' + S.seq + ':' + S.tn + ':' + S.ph;
  const live = myTurn() && now >= lockUntil;
  if (live && turnChimeKey !== key) { turnChimeKey = key; sfx.turn(); }
  if (live) {
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
  card: () => { tone(900, 0.05, 'triangle', 0.05, 400); tone(220, 0.06, 'sine', 0.04, null, 0.02); },
  trump: () => { tone(160, 0.2, 'sawtooth', 0.04, 90); tone(660, 0.12, 'triangle', 0.05, 990, 0.04); },
  take: (me) => { const b = me ? 660 : 440; tone(b, 0.1, 'triangle', 0.06); tone(b * 1.5, 0.16, 'triangle', 0.05, null, 0.08); },
  sweep: () => tone(1400, 0.12, 'sine', 0.025, 500),
  bid: (v) => tone(520 + v * 60, 0.09, 'sine', 0.06),
  flick: () => tone(700, 0.08, 'triangle', 0.05, 300),
  turn: () => { tone(740, 0.09, 'sine', 0.06); tone(990, 0.12, 'sine', 0.05, null, 0.08); },
  tick: () => tone(1200, 0.03, 'square', 0.03),
  deny: () => tone(150, 0.12, 'sawtooth', 0.04, 110),
  deal: () => { for (let k = 0; k < 6; k++) tone(1100 + k * 40, 0.035, 'triangle', 0.03, 600, k * 0.07); },
  exact: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.06, null, i * 0.08)),
  miss: () => { tone(330, 0.2, 'triangle', 0.05, 260); tone(247, 0.3, 'triangle', 0.05, 196, 0.14); },
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
function pop(x, y, s, color) { if (pops.length < 40) pops.push({ x, y, s, color, t: 0 }); }

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
const NOTE_ROOM = 60;
let TOP = 44;
let STATUS_H = 38;
let btns = [];
let handRects = [];
let L = null;            // this frame's layout
let press = '';
let pressCard = -1;
let pressY = 0;
let hoverBtn = '';
let hoverCard = -1;
let kbSel = -1;
let touchSeen = false;

function computeLayout() {
  TOP = H < 360 ? 34 : 44;
  STATUS_H = H < 360 ? 30 : 38;
  const n = Math.max(1, S.seats.length);
  const wide = W >= H * 1.05;
  const panelW = wide ? clamp(Math.round(W * 0.3), 128, 270) : 0;
  const noteRoom = practiceTable() ? NOTE_ROOM : 0;
  const rects = [];
  let chipsH = 0;
  if (wide) {
    const x = W - PAD - panelW;
    const rh = clamp(Math.floor((H - TOP - STATUS_H - 8) / n), 28, 60);
    for (let i = 0; i < n; i++) rects.push({ x, y: TOP + 2 + i * rh, w: panelW, h: rh - 5 });
  } else {
    const cols = W < 300 ? 1 : 2;
    const rowsN = Math.ceil(n / cols);
    const ch = 42;
    const cw = (W - 2 * PAD - (cols - 1) * 6) / cols;
    for (let i = 0; i < n; i++) rects.push({ x: PAD + (i % cols) * (cw + 6), y: TOP + Math.floor(i / cols) * (ch + 4), w: cw, h: ch });
    chipsH = rowsN * (ch + 4) + 4;
  }
  const fx = PAD, fy = TOP + chipsH;
  const fw = W - 2 * PAD - (panelW ? panelW + PAD : 0);
  const fh = Math.max(80, H - fy - STATUS_H - noteRoom - 6);
  const seated = mySeatIndex() >= 0 && S.g > 0;
  const handH = seated ? clamp(Math.round(fh * 0.3), 46, 130) : 0;
  const hand = { x: fx, y: fy + fh - handH, w: fw, h: handH };
  const ay0 = fy + 4, ay1 = seated ? hand.y - 14 : fy + fh;
  const areaH = Math.max(40, ay1 - ay0);
  // The trump turned up in the corner of the table, when there is room for it.
  const showTrump = areaH >= 110 && fw >= 220;
  const trH = showTrump ? clamp(areaH * 0.3, 40, 92) : 0;
  const trump = { x: fx + 8, y: ay0 + 16, w: trH * 0.7, h: trH };
  const tch = clamp(Math.min(areaH * 0.36, fw * 0.62 / Math.max(3, Math.ceil(n / 2) + 1) / 0.7), 30, 120);
  const tcw = tch * 0.7;
  const left = showTrump ? trump.x + trump.w + 6 : fx;
  const tcx = (left + fx + fw) / 2;
  const tcy = ay0 + areaH / 2;
  const rx = Math.max(0, Math.min((fx + fw - left) / 2 - tcw / 2 - 4, tcw * 2.8));
  const ry = Math.max(0, areaH / 2 - tch / 2 - 2);
  L = { wide, panelW, rects, fx, fy, fw, fh, hand, seated, trump, showTrump, ay0, ay1, areaH, tch, tcw, tcx, tcy, rx, ry };
}

// Where a seat's card lies in the trick: round an oval, my own seat nearest
// me at the bottom, the rest in turn order round from it.
function slotOf(i) {
  const n = Math.max(1, S.seats.length);
  const me = mySeatIndex();
  const r = (i - (me >= 0 ? me : 0) + n) % n;
  const a = Math.PI / 2 + r * 2 * Math.PI / n;
  return { x: L.tcx + Math.cos(a) * L.rx - L.tcw / 2, y: L.tcy + Math.sin(a) * L.ry - L.tch / 2, w: L.tcw, h: L.tch };
}

function seatAnchor(i) {
  if (!L) return null;
  if (i === mySeatIndex() && L.seated && L.hand.h > 0) return { x: L.hand.x + L.hand.w / 2, y: L.hand.y + L.hand.h * 0.3 };
  const r = L.rects[i];
  if (!r) return null;
  return { x: r.x + r.w * 0.5, y: r.y + r.h / 2 };
}

// ── drawing pieces ──────────────────────────────────────────────────────────

function drawBackground(now) {
  const g = ctx.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.5, Math.max(W, H) * 0.8);
  g.addColorStop(0, C.bg0);
  g.addColorStop(1, C.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // The weave of the baize, crossed fine and drifting slowly, so the table is
  // never a flat colour.
  ctx.strokeStyle = 'rgba(200,255,220,0.035)';
  ctx.lineWidth = 1;
  const s = 9, off = (now * 0.002) % s;
  ctx.beginPath();
  for (let x = -H - s; x < W + s; x += s) {
    ctx.moveTo(x + off, 0); ctx.lineTo(x + off + H, H);
  }
  ctx.stroke();
}

// A suit's mark, drawn as a glyph in the suit's own colour.
function pip(su, x, y, size) {
  text(SUIT_GLYPH[su], x, y, size, SUIT_COL[su], 'center', 700);
}

// A card face up, `w` wide: the rank and suit in the corner, the suit large
// in the middle when there is room for it.
function drawCard(x, y, w, h, c, glow) {
  const r = Math.max(3, w * 0.1);
  ctx.save();
  ctx.shadowColor = glow || 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = glow ? 18 : 6;
  ctx.shadowOffsetY = glow ? 0 : 2;
  rr(x, y, w, h, r);
  ctx.fillStyle = C.face;
  ctx.fill();
  ctx.restore();
  rr(x, y, w, h, r);
  ctx.strokeStyle = glow || C.edge;
  ctx.lineWidth = glow ? 2 : 1;
  ctx.stroke();
  const su = suitOf(c), rk = RANK[c % 13];
  const col = SUIT_COL[su];
  if (w < 30) {
    text(rk, x + w / 2, y + h * 0.34, w * 0.42, col, 'center', 800);
    pip(su, x + w / 2, y + h * 0.7, w * 0.46);
    return;
  }
  const cs = w * 0.26;
  text(rk, x + w * 0.2, y + cs * 0.75, cs, col, 'center', 800);
  pip(su, x + w * 0.2, y + cs * 1.75, cs * 0.85);
  pip(su, x + w * 0.58, y + h * 0.6, w * 0.52);
}

// A card face down: a deep red back with a gold diamond on it.
function drawBack(x, y, w, h) {
  const r = Math.max(3, w * 0.1);
  rr(x, y, w, h, r);
  ctx.fillStyle = C.back0;
  ctx.fill();
  ctx.strokeStyle = '#e8c87a';
  ctx.lineWidth = 1;
  ctx.stroke();
  rr(x + w * 0.1, y + w * 0.1, w * 0.8, h - w * 0.2, r * 0.6);
  ctx.fillStyle = C.back1;
  ctx.fill();
  const cx = x + w / 2, cy = y + h / 2, s = w * 0.22;
  ctx.fillStyle = 'rgba(232,200,122,0.75)';
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 1.4); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy + s * 1.4); ctx.lineTo(cx - s, cy);
  ctx.closePath();
  ctx.fill();
}

function drawTrump(now) {
  if (!L.showTrump || S.tr < 0 || !(S.ph === 'bid' || S.ph === 'play')) return;
  const t = L.trump;
  text('TRUMP', t.x + t.w / 2, t.y - 9, 10, C.gold, 'center', 800);
  drawBack(t.x + 5, t.y + 4, t.w, t.h);
  const f = clamp((now - dealAt) / DEAL_MS, 0, 1);
  // Turned up as the deal finishes.
  const sx = f < 0.6 ? 1 : Math.abs(Math.cos((f - 0.6) / 0.4 * Math.PI));
  ctx.save();
  ctx.translate(t.x + t.w / 2, t.y + t.h / 2);
  ctx.scale(Math.max(0.02, sx), 1);
  if (f < 0.8) drawBack(-t.w / 2, -t.h / 2, t.w, t.h);
  else drawCard(-t.w / 2, -t.h / 2, t.w, t.h, S.tr, alpha(C.gold, 0.8));
  ctx.restore();
  text(SUIT_NAME[suitOf(S.tr)], t.x + t.w / 2, t.y + t.h + 12, 11, C.dim, 'center', 700);
}

// The trick: an empty place for every seat, its card when played, flown in
// from where its player sits, and the trick taken swept off to its taker.
function drawTrick(now) {
  if (S.ph !== 'play') { drawSweep(now); return; }
  const n = S.seats.length;
  const tw = S.tw;
  const wk = tw >= 0 ? easeOut((now - wonAt) / 300) : 0;
  for (let i = 0; i < n; i++) {
    const p = slotOf(i);
    const played = S.tk.find((q) => q[0] === i);
    const col = colorOfSeat(i);
    if (!played) {
      const live = i === S.tn && tw < 0 && now >= lockUntil;
      rr(p.x, p.y, p.w, p.h, p.w * 0.1);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = alpha(col, live ? 0.55 + 0.35 * Math.sin(now / 180) : 0.22);
      ctx.lineWidth = live ? 2 : 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (L.tcw >= 38 && n > 1) {
      const s = S.seats[i];
      text(clip(nickOf(s.id), 10, p.w + 24), p.x + p.w / 2, p.y + p.h + 8, 10, alpha(col, 0.85), 'center', 700);
    }
  }
  // Cards in the order they were played, the later ones on top.
  for (const [i, c] of S.tk) {
    const p = slotOf(i);
    const fl = flights.find((f) => f.i === i && f.c === c);
    let x = p.x, y = p.y, rot = ((c * 37) % 9 - 4) * 0.02;
    if (fl) {
      const k = easeOut((now - fl.start) / CARD_MS);
      const A = seatAnchor(i) || { x: L.tcx, y: L.tcy };
      x = lerp(A.x - p.w / 2, p.x, k);
      y = lerp(A.y - p.h / 2, p.y, k) - Math.sin(k * Math.PI) * 18;
      rot *= k;
      if (k >= 1) flights = flights.filter((f) => f !== fl);
    }
    const win = tw === i;
    ctx.save();
    ctx.translate(x + p.w / 2, y + p.h / 2 - (win ? 6 * wk : 0));
    ctx.rotate(rot);
    const sc = win ? 1 + 0.08 * wk : 1;
    ctx.scale(sc, sc);
    drawCard(-p.w / 2, -p.h / 2, p.w, p.h, c, win ? colorOfSeat(i) : null);
    if (tw >= 0 && !win) {
      rr(-p.w / 2, -p.h / 2, p.w, p.h, p.w * 0.1);
      ctx.fillStyle = 'rgba(6,26,20,' + 0.35 * wk + ')';
      ctx.fill();
    }
    ctx.restore();
  }
  drawSweep(now);
}

function drawSweep(now) {
  if (!sweep) return;
  const k = easeInOut((now - sweep.start) / SWEEP_MS);
  if (k >= 1 || !L) { sweep = null; return; }
  const A = seatAnchor(sweep.to) || { x: L.tcx, y: L.tcy };
  for (const [i, c] of sweep.cards) {
    if (i >= S.seats.length) continue;
    const p = slotOf(i);
    const s = lerp(1, 0.3, k);
    const x = lerp(p.x + p.w / 2, A.x, k), y = lerp(p.y + p.h / 2, A.y, k);
    ctx.save();
    ctx.globalAlpha = 1 - k * 0.6;
    ctx.translate(x, y);
    ctx.rotate(k * 1.2);
    drawCard(-p.w * s / 2, -p.h * s / 2, p.w * s, p.h * s, c, null);
    ctx.restore();
  }
}

function button(id, label, x, y, w, h, col, on, crossed) {
  const pressed = press === id;
  const hot = hoverBtn === id && on;
  ctx.save();
  ctx.globalAlpha = on ? 1 : 0.38;
  rr(x, y + (pressed ? 2 : 0), w, h, Math.min(12, h / 2));
  ctx.fillStyle = col;
  ctx.fill();
  if (hot) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke(); }
  text(label, x + w / 2, y + h / 2 + (pressed ? 2 : 0), Math.min(20, h * 0.5), '#10251c', 'center', 900, w - 8);
  if (crossed) {
    ctx.strokeStyle = C.red;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + 6, y + h - 6); ctx.lineTo(x + w - 6, y + 6);
    ctx.stroke();
  }
  ctx.restore();
  if (on) btns.push({ id, x, y, w, h });
}

// While the table promises: whose promise it is, and on my turn the numbers
// to pick from, the one the dealer may not make struck through.
function drawPromises(now) {
  if (S.ph !== 'bid') return;
  const s = mySeat();
  const cx = L.tcx, cy = L.tcy;
  const turn = S.seats[S.tn];
  const forb = S.tn === S.dl ? forbiddenBid(S.seats, S.dl, S.hs) : -1;
  const sum = S.seats.reduce((t, x) => t + (x.bid > 0 ? x.bid : 0), 0);
  const fw = Math.min(L.fw - 10, 460);
  if (s && s.ex) {
    text('you trail: throw away one card', cx, cy - 14, 15, C.gold, 'center', 800, fw);
    text('tap the card you want rid of', cx, cy + 10, 12, C.dim, 'center', 600, fw);
    return;
  }
  const mine = myTurn() && s && s.bid < 0;
  if (!mine) {
    const who = turn ? nickOf(turn.id) : 'someone';
    text(who + ' is promising' + '.'.repeat(1 + Math.floor(now / 400) % 3), cx, cy - 10, 15, turn ? colorOfSeat(S.tn) : C.dim, 'center', 800, fw);
    text(sum + ' promised of ' + S.hs + (S.hs === 1 ? ' trick' : ' tricks'), cx, cy + 14, 12, C.dim, 'center', 600, fw);
    return;
  }
  const k = S.hs + 1;
  const bh = clamp(L.areaH * 0.3, 30, 48);
  const bw = Math.min(bh * 1.15, (fw - (k - 1) * 6) / k);
  const total = k * bw + (k - 1) * 6;
  const live = canAct(now);
  text('how many tricks will you take?', cx, cy - bh / 2 - 14, Math.min(15, L.areaH * 0.12), C.text, 'center', 800, fw);
  for (let v = 0; v < k; v++) {
    const x = cx - total / 2 + v * (bw + 6);
    button('b' + v, String(v), x, cy - bh / 2 + 4, bw, bh, v === forb ? '#8aa597' : C.gold, live && v !== forb, v === forb);
  }
  const note = forb >= 0 ? 'not ' + forb + ': the promises may never add up to ' + S.hs : sum + ' promised so far';
  text(note + (touchSeen ? '' : ' · keys 0-9'), cx, cy + bh / 2 + 18, 11, C.dim, 'center', 600, fw);
}

// My cards along the foot of the table: the ones I may play lifted a little,
// the rest dimmed, and dealt in one by one at the start of a hand.
function drawHand(now) {
  handRects = [];
  if (!L.seated || !L.hand.h) return;
  const s = mySeat();
  const cards = heldCards(now);
  const hb = L.hand;
  if (!cards.length) {
    let msg = '';
    if (S.ph === 'hand') msg = 'hand over';
    else if (S.ph === 'over') msg = '';
    else if (!handFresh()) msg = 'dealing…';
    if (msg) text(msg, hb.x + hb.w / 2, hb.y + hb.h / 2, 13, C.faint, 'center', 600);
    return;
  }
  const k = cards.length;
  const ch = hb.h, cw = ch * 0.7;
  const step = k > 1 ? Math.min(cw * 1.06, (hb.w - cw) / (k - 1)) : 0;
  const total = cw + step * (k - 1);
  const x0 = hb.x + (hb.w - total) / 2;
  const playing = S.ph === 'play' && canAct(now);
  const throwing = S.ph === 'bid' && s && s.ex;
  const legal = playing ? legalCards(cards, S.tk) : cards;
  if (kbSel >= k) kbSel = k - 1;
  cards.forEach((c, j) => {
    let x = x0 + j * step, y = hb.y;
    const ok = legal.includes(c);
    const df = clamp((now - dealAt - j * 70) / 380, 0, 1);
    if (df < 1) {
      const A = L.showTrump ? L.trump : { x: L.tcx, y: L.tcy, w: 0, h: 0 };
      const e = easeOut(df);
      x = lerp(A.x, x, e);
      y = lerp(A.y, y, e);
      if (df <= 0) return;
    }
    let lift = 0;
    if ((playing && ok) || throwing) lift += 5;
    if ((hoverCard === c || (kbSel === j && !touchSeen)) && (playing || throwing)) lift += 9;
    if (pressCard === c) lift += 4;
    y -= lift;
    drawCard(x, y, cw, ch, c, throwing && (hoverCard === c || kbSel === j) ? C.gold : null);
    if (playing && !ok) {
      rr(x, y, cw, ch, cw * 0.1);
      ctx.fillStyle = 'rgba(6,26,20,0.45)';
      ctx.fill();
    }
    if (denyCard === c && now - denyAt < 400) {
      rr(x, y, cw, ch, cw * 0.1);
      ctx.strokeStyle = 'rgba(255,93,115,' + (1 - (now - denyAt) / 400) + ')';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    handRects.push({ c, x, y, w: j === k - 1 ? cw : Math.min(step, cw), h: ch + lift });
  });
}

// Pips for a promise: a ring for every trick promised, filled as tricks are
// taken, and red for every trick taken past it.
function drawPips(x, y, bid, took, r, col) {
  const k = Math.max(bid, took);
  for (let j = 0; j < k; j++) {
    const px = x + j * (r * 2 + 3) + r;
    ctx.beginPath();
    ctx.arc(px, y, r, 0, Math.PI * 2);
    if (j < took) { ctx.fillStyle = j < bid ? col : C.red; ctx.fill(); }
    else { ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke(); }
  }
  return k * (r * 2 + 3);
}

// Who is playing: their colour, their name, their score, the dealer's mark,
// and their promise against the tricks they have taken.
function drawSeats(now) {
  const n = S.seats.length;
  if (!n) return;
  const turnLeft = clamp((endAt - Math.max(now, lockUntil)) / (S.ph === 'bid' ? BID_MS : PLAY_MS), 0, 1);
  S.seats.forEach((s, i) => {
    const r = L.rects[i];
    if (!r) return;
    const col = colorOfSeat(i);
    const active = (S.ph === 'bid' || S.ph === 'play') && i === S.tn && S.tw < 0;
    const away = !present(s.id);
    ctx.save();
    ctx.globalAlpha = away ? 0.5 : 1;
    rr(r.x, r.y, r.w, r.h, Math.min(12, r.h / 2));
    ctx.fillStyle = active ? alpha(col, 0.18) : S.tw === i ? alpha(col, 0.12) : C.row;
    ctx.fill();
    if (active) { ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke(); }
    const two = r.h >= 38;
    const ly = two ? r.y + 12 : r.y + r.h / 2;
    const dx = r.x + 12, dr = 5.5;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(dx, ly, dr, 0, Math.PI * 2);
    ctx.fill();
    if (active && now >= lockUntil) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dx, ly, dr + 3.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * turnLeft);
      ctx.stroke();
    }
    const scoreW = 34, tallyW = two ? 0 : 34;
    let nameW = r.w - 28 - scoreW - tallyW;
    if (i === S.dl && S.ph !== 'over') {
      // The dealer promises last, and may not make the promises add up.
      const bx = r.x + r.w - scoreW - tallyW - 12;
      rr(bx - 7, ly - 7, 14, 14, 4);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fill();
      text('D', bx, ly + 0.5, 10, C.text, 'center', 800);
      nameW -= 18;
    }
    text(clip(nameOf(s.id), 12, Math.max(20, nameW)), dx + dr + 7, ly, 12, C.text, 'left', 600);
    text(String(s.sc), r.x + r.w - 9, ly, 14, col, 'right', 900);
    const ly2 = two ? r.y + r.h - 10 : ly;
    const px = two ? r.x + 10 : r.x + r.w - scoreW - tallyW;
    if (S.ph === 'bid' || S.ph === 'play' || S.ph === 'hand') {
      if (s.bid < 0) {
        const msg = s.ex ? '+1 card, throwing one' : active ? 'promising…' : '';
        if (two && msg) text(msg, px, ly2, 10, s.ex ? C.gold : C.faint, 'left', 600);
      } else if (two) {
        const rp = clamp(r.h * 0.08, 3, 4.5);
        const w = drawPips(px, ly2, s.bid, s.tk, rp, col);
        const label = s.bid === 0 ? 'promised none' : s.tk + ' of ' + s.bid;
        text(label, px + w + 4, ly2, 10, s.tk > s.bid ? C.red : C.dim, 'left', 600, r.w - w - 24);
      } else text(s.tk + '/' + s.bid, px, ly2, 11, s.tk > s.bid ? C.red : C.dim, 'left', 700);
    }
    ctx.restore();
  });
}

function drawMute() {
  const s = 28, x = W - PAD - s, y = (TOP - s) / 2;
  ctx.save();
  rr(x, y, s, s, s / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fill();
  ctx.fillStyle = muted ? C.faint : C.dim;
  ctx.beginPath();
  ctx.moveTo(x + 7, y + 11); ctx.lineTo(x + 11, y + 11); ctx.lineTo(x + 16, y + 7);
  ctx.lineTo(x + 16, y + 21); ctx.lineTo(x + 11, y + 17); ctx.lineTo(x + 7, y + 17);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = muted ? C.red : C.dim;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (muted) { ctx.moveTo(x + 18, y + 10); ctx.lineTo(x + 24, y + 18); ctx.moveTo(x + 24, y + 10); ctx.lineTo(x + 18, y + 18); }
  else { ctx.arc(x + 16, y + 14, 5, -0.9, 0.9); ctx.moveTo(x + 22.5, y + 8.5); ctx.arc(x + 16, y + 14, 8.5, -0.85, 0.85); }
  ctx.stroke();
  ctx.restore();
  btns.push({ id: 'mute', x: x - 6, y: y - 6, w: s + 12, h: s + 12 });
}

// The name with a little fan of cards, and the hand and trump in the middle.
function drawTopBar(now) {
  const cy = TOP / 2;
  for (let k = 0; k < 3; k++) {
    ctx.save();
    ctx.translate(PAD + 10, cy + 8);
    ctx.rotate((k - 1) * 0.32 + Math.sin(now / 1200) * 0.03);
    rr(-6, -20, 12, 17, 2);
    ctx.fillStyle = k === 1 ? C.face : k === 0 ? '#e9dfc6' : '#dfd3b6';
    ctx.fill();
    ctx.restore();
  }
  text('♥︎', PAD + 10, cy - 3, 9, SUIT_COL[1], 'center', 800);
  text('PROMISE', PAD + 26, cy, 16, C.text, 'left', 900);
  if (S.g > 0 && S.ph !== 'over' && W >= 300) {
    const tr = trumpSuit();
    const mid = 'hand ' + (S.hn + 1) + ' of ' + S.hc + ' · ' + S.hs + (S.hs === 1 ? ' card' : ' cards');
    font(12, 700);
    const w = ctx.measureText(mid).width;
    const x0 = W / 2 - (w + (tr >= 0 ? 64 : 0)) / 2;
    text(mid, x0, cy, 12, C.dim, 'left', 700);
    if (tr >= 0) {
      text('· trump', x0 + w + 4, cy, 12, C.dim, 'left', 700);
      rr(x0 + w + 50, cy - 9, 16, 18, 3);
      ctx.fillStyle = C.face;
      ctx.fill();
      pip(tr, x0 + w + 58, cy + 1, 13);
    }
  } else if (W >= 380) text('promise exactly what you will take', W / 2, cy, 12, C.faint, 'center', 600, W * 0.42);
  drawMute();
}

// The line at the foot: whose turn, what to do, and the turn running out.
function drawStatus(now) {
  const y = H - STATUS_H;
  ctx.fillStyle = 'rgba(2,14,10,0.55)';
  ctx.fillRect(0, y, W, STATUS_H);
  const pre = practiceTable() ? 'practice · ' : '';
  const s = S.seats[S.tn];
  const me = mySeat();
  let line;
  if (S.g === 0) line = 'promise how many tricks you will take, then take exactly that many';
  else if (S.ph === 'over') line = pre + 'game over';
  else if (S.ph === 'hand') line = pre + 'hand over · a promise kept scores ' + EXACT + ' and one a trick';
  else if (!me) line = 'watching · you play from the next game';
  else if (S.ph === 'play' && S.tw >= 0) line = pre + nickOf(S.seats[S.tw].id) + ' takes the trick';
  else if (S.ph === 'bid' && me.ex) line = pre + 'you trail, so you hold a spare card · throw one away';
  else if (myTurn() && S.ph === 'bid') line = pre + 'your promise · how many tricks will you take, exactly?';
  else if (myTurn() && S.ph === 'play') {
    const need = me.bid - me.tk;
    const aim = need > 0 ? 'you need ' + need + ' more' : need === 0 ? 'take no more' : 'you are over';
    line = pre + (S.tk.length ? 'your card · follow ' + SUIT_NAME[suitOf(S.tk[0][1])] + ' if you can' : 'your lead') + ' · ' + aim;
  } else if (S.ph === 'bid') line = pre + (s ? nickOf(s.id) : 'someone') + ' promises · the dealer may not make them add up';
  else line = pre + (s ? nickOf(s.id) : 'someone') + ' plays · highest trump, or highest of the suit led, takes it';
  text(line, W / 2, y + STATUS_H / 2 + 1, W < 420 ? 11 : 13, myTurn() && now >= lockUntil ? C.text : C.dim, 'center', 600, W - 24);
  if ((S.ph === 'bid' || S.ph === 'play') && s && S.tw < 0 && now >= lockUntil) {
    const k = clamp((endAt - now) / (S.ph === 'bid' ? BID_MS : PLAY_MS), 0, 1);
    ctx.fillStyle = colorOfSeat(S.tn);
    ctx.fillRect(0, y, W * k, 3);
  }
}

function drawLobby(now) {
  const pw = Math.min(W - 2 * PAD, 420);
  const ph = Math.min(H - 2 * PAD, 250);
  const x = (W - pw) / 2, y = (H - ph) / 2;
  rr(x, y, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  [12, 25, 51].forEach((c, k) => {
    const w = 34, h = 48;
    const cx = x + pw / 2 + (k - 1) * (w + 10);
    drawCard(cx - w / 2, y + 18 + Math.sin(now / 500 + k) * 3, w, h, c, null);
  });
  text('PROMISE', x + pw / 2, y + 92, 26, C.text, 'center', 900);
  const lines = [
    'Promise how many tricks you will take, then take',
    'exactly that many: ten and one a trick for a promise kept.',
    'The dealer may never make the promises add up.',
  ];
  lines.forEach((l, i) => text(l, x + pw / 2, y + 124 + i * 19, 13, C.dim, 'center', 500, pw - 28));
  const dots = '.'.repeat(1 + Math.floor(now / 400) % 3);
  text((amHost() ? 'setting up the table' : 'waiting for the table') + dots, x + pw / 2, y + ph - 24, 13, C.faint, 'center', 500);
}

// What the hand just scored, seat by seat, over the empty table.
function drawHandScore(now) {
  if (S.ph !== 'hand' || !S.last) return;
  const n = S.seats.length;
  const k = easeOut((now - lockUntil + SWEEP_MS) / 400);
  const pw = Math.min(L.fw - 8, 380);
  const rowH = clamp(Math.floor((L.areaH - 40) / n), 14, 26);
  const ph = 34 + n * rowH + 6;
  const x = L.fx + (L.fw - pw) / 2, y = L.ay0 + Math.max(0, (L.areaH - ph) / 2) + (1 - k) * 16;
  ctx.save();
  ctx.globalAlpha = k;
  rr(x, y, pw, ph, 14);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  text('hand ' + (S.hn + 1) + ' of ' + S.hc, x + pw / 2, y + 17, 13, C.text, 'center', 800);
  S.seats.forEach((s, i) => {
    const cy = y + 34 + i * rowH + rowH / 2;
    const col = colorOfSeat(i);
    const d = S.last[i];
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x + 14, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    const fs = Math.min(12, rowH * 0.6);
    text(clip(nameOf(s.id), fs, pw * 0.36), x + 24, cy, fs, C.text, 'left', 600);
    text((s.bid === s.tk ? 'kept ' : 'took ' + s.tk + ', promised ') + s.bid, x + pw * 0.5, cy, fs, d > 0 ? C.dim : C.faint, 'left', 600, pw * 0.3);
    text((d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d), x + pw - 12, cy, fs + 1, d > 0 ? C.green : C.red, 'right', 900);
  });
  ctx.restore();
}

function drawOver(now) {
  const k = easeOut((now - overAt) / 500);
  ctx.fillStyle = 'rgba(2,14,10,' + 0.62 * k + ')';
  ctx.fillRect(0, 0, W, H);
  const order = S.seats.map((s, i) => ({ s, i })).sort((a, b) => b.s.sc - a.s.sc);
  const pw = Math.min(W - 2 * PAD, 400);
  const rowH = clamp(Math.floor((H - 150) / Math.max(1, order.length)), 20, 34);
  const ph = Math.min(H - 16, 110 + order.length * rowH);
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
  text('a promise kept scores ' + EXACT + ' and one a trick, a miss one a trick off', x + pw / 2, y + 54, 11, C.faint, 'center', 500, pw - 28);
  order.forEach((r, n) => {
    const yy = y + 72 + n * rowH;
    if (yy + rowH > y + ph - 28) return;
    const cy = yy + rowH / 2;
    text(String(n + 1), x + 20, cy, 12, C.faint, 'center', 800);
    ctx.fillStyle = colorOfSeat(r.i);
    ctx.beginPath();
    ctx.arc(x + 38, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    text(clip(nameOf(r.s.id), 13, pw - 120), x + 50, cy, 13, C.text, 'left', 600);
    text(String(r.s.sc), x + pw - 16, cy, 16, colorOfSeat(r.i), 'right', 900);
  });
  const wait = (practiceTable() ? PRACTICE_AGAIN : OVER_MS) - (now - overAt);
  const left = Math.max(1, Math.ceil(wait / 1000));
  text((practiceTable() ? 'next practice game in ' : 'next game in ') + left, x + pw / 2, y + ph - 16, 13, C.dim, 'center', 600);
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
    sideEffects(now);
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    drawBackground(now);
    if (S.g === 0) drawLobby(now);
    else {
      drawSeats(now);
      drawTrump(now);
      drawTrick(now);
      drawPromises(now);
      drawHandScore(now);
      drawHand(now);
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
      ctx.translate(p.x, p.y - 30 * easeOut(k));
      ctx.scale(s, s);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(2,14,10,0.85)';
      font(15, 900);
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
      const tip = joinEnd ? null : 'the dealer may not make the promises add up';
      const bottom = L.fy + L.fh;
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
// The topmost card under a point: later cards lie over earlier ones.
function cardAt(p) {
  for (let k = handRects.length - 1; k >= 0; k--) if (inside(p, handRects[k])) return handRects[k].c;
  return -1;
}
function act(id) {
  if (id === 'mute') { muted = !muted; if (!muted) sfx.card(); }
  else if (id[0] === 'b') tryBid(Number(id.slice(1)));
}

// A finger or the mouse goes down on a button or a card, and it counts when
// it is let go over the same one, or when a card is pushed up off the hand;
// a thumb that slides off sideways changes its mind.
cv.addEventListener('pointerdown', (e) => {
  audio();
  if (e.pointerType !== 'mouse') touchSeen = true;
  const p = pt(e);
  press = buttonAt(p);
  pressCard = press ? -1 : cardAt(p);
  pressY = p.y;
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ }
  e.preventDefault();
});
cv.addEventListener('pointermove', (e) => {
  const p = pt(e);
  hoverBtn = buttonAt(p);
  hoverCard = hoverBtn ? -1 : cardAt(p);
  if (e.pointerType === 'mouse') cv.style.cursor = hoverBtn || hoverCard >= 0 ? 'pointer' : 'default';
});
cv.addEventListener('pointerup', (e) => {
  const p = pt(e);
  if (press && buttonAt(p) === press) act(press);
  else if (pressCard >= 0 && (cardAt(p) === pressCard || pressY - p.y > 28)) tryCard(pressCard);
  press = '';
  pressCard = -1;
  if (e.pointerType !== 'mouse') { hoverBtn = ''; hoverCard = -1; }
});
cv.addEventListener('pointercancel', () => { press = ''; pressCard = -1; hoverBtn = ''; hoverCard = -1; });
cv.addEventListener('pointerleave', () => { hoverBtn = ''; hoverCard = -1; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  audio();
  touchSeen = false;
  const k = e.key;
  if (e.repeat) return;
  if (k === 'm' || k === 'M') { act('mute'); return; }
  if (k >= '0' && k <= '9') { tryBid(Number(k)); e.preventDefault(); return; }
  const cards = heldCards(performance.now());
  if (!cards.length) return;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') { kbSel = kbSel <= 0 ? cards.length - 1 : kbSel - 1; e.preventDefault(); }
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') { kbSel = kbSel < 0 || kbSel >= cards.length - 1 ? 0 : kbSel + 1; e.preventDefault(); }
  else if ((k === 'Enter' || k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W') && kbSel >= 0 && kbSel < cards.length) {
    tryCard(cards[kbSel]);
    e.preventDefault();
  }
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
