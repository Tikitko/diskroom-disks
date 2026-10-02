/**
 * @disk     liars_dice
 * @author   claude
 * @version  2
 * @players  2-8
 * @about    Liar's dice in a smoky tavern. Shake a hidden cup, then bid on how many of a face lie under every cup at once, aces wild. Raise the bid or call the last bidder a liar and lift the cups. Call it exact to win a die back. Last cup standing wins.
 * @tags     game, party, dice, bluffing
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/liars_dice.png
 */
// liars_dice.js — liar's dice (Perudo rules), run by the host.
//
// Each round every player rolls their dice under a cup. In turn they bid on
// how many dice of one face are on the whole table, counting everybody's cups,
// with aces wild. The next player raises the bid or calls. "Liar" lifts every
// cup: if the bid stood, the caller loses a die, otherwise the bidder does.
// "Exact" bets the bid is spot on: right wins a die back, wrong loses one. A
// player who drops to a single die for the first time plays a palifico round:
// aces are not wild and the face of the opening bid is locked. The last player
// with dice wins.
//
// The host keeps the turn order and rules on every bid, but it never sees a
// die before the cups are lifted. A cup is rolled with commit and reveal: each
// player draws a secret of their own and sends only its hash; the host has
// published the hash of a salt of its own before that, and shows the salt once
// every hash is in. A player's dice come from their secret, the salt and the
// list of hashes together, so nobody can choose their dice, the host cannot
// read anyone's, and a lifted cup is checked by every copy against the hash
// sent before the bidding. What this cannot stop: a hostile host can rule a
// bid or a count wrongly in plain sight (every copy recounts and says so), can
// leave a player out of a round, and can see the dice of the bots it deals at
// a practice table, which are its own.
//
// A player alone is dealt a practice game against two bots at once, and
// another after it, for as long as nobody else runs the disk. When somebody
// does, practice ends three seconds on under a note that says so, and the host
// deals the real game.

// ── rules ───────────────────────────────────────────────────────────────────

const MAX_SEATS = 8;
const ROLL_MS = 8000;      // time for every cup to be sealed
const TURN_MS = 30000;     // time to bid or call
const AWAY_MS = 6000;      // a turn whose player has dropped out waits this long
const OPEN_MS = 10000;     // time for every cup to be lifted after a call
const SHOW_MS = 8000;      // how long the lifted cups stay on screen
const LIFT_AT = 0.6;       // seconds into the reveal when the cups come up
const COUNT_AT = 1.4;      // and when the count starts
const DEAL_COOLDOWN = 2500;
const PRACTICE_AGAIN = 6000; // a finished practice game is on screen this long before the next
const JOIN_MS = 3000;      // practice runs on this long after somebody joins
const GRACE = 8000;        // how long a dropped connection has to come back
const HIST = 24;           // bids kept from the current round
const BOT_NAMES = ['Bot Bones', 'Bot Mags', 'Bot Finn'];

// How many dice everybody starts with: fewer at a bigger table, so a game
// stays a few minutes long however many sit down.
const startDice = (n) => (n <= 3 ? 5 : n <= 5 ? 4 : 3);

// One colour per seat, in seat order, so no two players at a table share one.
const PAL = ['#ff6b6b', '#ffc145', '#46d39a', '#4cc3ff', '#b48cff', '#ff8f4c', '#ff6fb7', '#9bd65a'];
const C = {
  bg0: '#4a2e1d', bg1: '#1c110b', felt0: '#23735a', felt1: '#103a2d', rim: '#5e3a22', rimHi: '#8a5a36',
  panel: 'rgba(28,18,12,0.93)', line: '#6b4a32',
  text: '#f7efe2', dim: '#d6c4a6', faint: '#9e8a6e',
  gold: '#ffcf5a', goldDeep: '#3d2c08', red: '#ff5b5b', redDeep: '#3d0d0d', amber: '#ffa94d',
  die: '#fbf6ec', pip: '#2a1d14',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Is `q` of face `f` a legal bid after `prev` ([q, f] or null), with `n` dice
// on the table? Aces are wild, so a bid on aces is worth about two of any
// other face: moving onto aces may halve the count, rounded up, and moving off
// them must more than double it. Nobody opens on aces except in a palifico
// round, where the face is locked and only the count goes up.
function legal(prev, q, f, pal, n) {
  if (!Number.isInteger(q) || !Number.isInteger(f) || q < 1 || q > n || f < 1 || f > 6) return false;
  if (!prev) return pal || f !== 1;
  const pq = prev[0], pf = prev[1];
  if (pal) return f === pf && q > pq;
  if (pf === 1 && f === 1) return q > pq;
  if (pf === 1) return q >= pq * 2 + 1;
  if (f === 1) return q >= Math.ceil(pq / 2);
  return q > pq || (q === pq && f > pf);
}
// The smallest legal count for face `f`, or 0 when there is none.
function minRaise(prev, f, pal, n) {
  for (let q = 1; q <= n; q++) if (legal(prev, q, f, pal, n)) return q;
  return 0;
}
const matches = (d, f, pal) => d === f || (!pal && f !== 1 && d === 1);

// ── hashing ─────────────────────────────────────────────────────────────────

// SHA-256 over an ASCII string, written out because the frame may not be a
// secure context and the subtle crypto API is asynchronous where it exists.
// A commitment is only as good as its hash: a short one lets a player find two
// secrets with the same seal and pick whichever dice they like after the salt.
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
function sha256(msg) {
  const l = msg.length;
  const n = (((l + 8) >> 6) + 1) * 16;
  const m = new Array(n).fill(0);
  for (let i = 0; i < l; i++) m[i >> 2] |= (msg.charCodeAt(i) & 255) << (24 - (i & 3) * 8);
  m[l >> 2] |= 0x80 << (24 - (l & 3) * 8);
  m[n - 1] = l * 8;
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let j = 0; j < n; j += 16) {
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i++) {
      if (i < 16) w[i] = m[j + i] | 0;
      else {
        const x = w[i - 15], y = w[i - 2];
        w[i] = (w[i - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + w[i - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10))) | 0;
      }
      const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + k) | 0;
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

// A secret is drawn from the browser's own generator, not Math.random, whose
// state another copy of the same browser engine could reconstruct.
function randHex(bytes) {
  const a = new Uint8Array(bytes);
  try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < bytes; i++) a[i] = (Math.random() * 256) | 0; }
  let s = '';
  for (const b of a) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const roundKey = (g, k) => g + '.' + k;
const sealOf = (s, g, k, id) => sha256(s + '|' + roundKey(g, k) + '|' + id);
const saltSealOf = (r, g, k) => sha256(r + '|' + roundKey(g, k));
// Every seal in the round, in seat order, folded into one digest: a player's
// dice depend on everyone's seals, which nobody knew when sealing their own.
const sealsDigest = (cm) => sha256(cm.map((x) => x[0] + ':' + x[1]).join(','));

// `n` dice from a secret, the round's salt and the digest of the seals. A byte
// of 252 or more is skipped so every face is exactly as likely.
function diceOf(s, r, cd, n) {
  const out = [];
  let h = sha256(s + '|' + r + '|' + cd), i = 0, more = 0;
  while (out.length < n) {
    if (i >= 64) { more++; h = sha256(h + '#' + more); i = 0; }
    const b = parseInt(h.substr(i, 2), 16);
    i += 2;
    if (b < 252) out.push((b % 6) + 1);
  }
  return out;
}

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g, k   game and round number, so a stale message is recognised
//   ph     'wait' | 'roll' (sealing cups) | 'bid' | 'open' (lifting) | 'show' | 'over'
//   seats  [{ id, d: dice, sit: out of this round, pu: palifico used }]
//   sd     dice each player started with
//   tn     seat index whose turn it is
//   bid    [q, f, id] or null; hs the round's bids as [id, q, f]
//   pal    1 in a palifico round
//   rc, r  the seal of the host's salt, and the salt once every cup is sealed
//   cm     [[id, seal]] for the cups sealed this round, in seat order
//   rd     ids whose cup has been lifted
//   call   [id, 0 liar | 1 exact] or null
//   res    the outcome, once the cups are up
//   win    the winner's id when the game is over
//   hr     ids of everyone running the disk, for the lobby
let S = blank();
let endAt = 0;
let overAt = -1e9;
let gotState = false;
let joinEnd = 0;               // when practice ends for somebody who joined, 0 if it does not

function blank() {
  return { g: 0, k: 0, ph: 'wait', seats: [], sd: 0, tn: 0, bid: null, hs: [], pal: 0, rc: '', r: '', cm: [], rd: [], call: null, res: null, win: null, hr: [] };
}

// The host's alone.
let salt = '';                 // the salt behind S.rc, shown at the end of 'roll'
const reveals = new Map();     // id -> secret, during 'open'
const botDice = new Map();     // bot id -> dice; bots have no secrets to keep
let botAt = 0;
let palNext = 0;
let starter = 0;
let lastPub = 0;
let shortAt = 0;
const here = new Set();        // ids that have said hello: their disk is running

// Mine.
let mine = null;               // { key, s, c } for the round I sealed
let myDice = null;             // { key, dice }
let lastCm = 0, lastRv = 0, lastHi = -1e9;
let warn = '';                 // something the host did that this copy could check and disproved
let liftedKey = '';            // the round whose cup I have lifted
const nicks = new Map();

// `room.me` is null in the studio and on Run solo. The disk is its own host
// there and deals a practice game against bots.
const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const amHost = () => !room.me || (room.host !== null && room.host.id === room.me.id);
const fromHost = (from) => room.host !== null && from === room.host.id;
const inRoom = (id) => room.players.some((p) => p.id === id);
const isBot = (id) => id < -1;
const present = (id) => (isBot(id) ? true : id === -1 ? solo() : inRoom(id));
const seatIndex = (id) => S.seats.findIndex((s) => s.id === id);
const seatOf = (id) => S.seats.find((s) => s.id === id) || null;
const mySeat = () => seatOf(myId());
const inRound = (s) => s.d > 0 && !s.sit;
const tableDice = () => S.seats.reduce((a, s) => a + (inRound(s) ? s.d : 0), 0);
const sealed = (id) => S.cm.some((x) => x[0] === id);
const sealFor = (id) => { const x = S.cm.find((y) => y[0] === id); return x ? x[1] : ''; };

function nickOf(id) {
  if (id === -1) return 'You';
  if (isBot(id)) return BOT_NAMES[(-id - 2) % BOT_NAMES.length];
  const p = room.players.find((x) => x.id === id);
  if (p) { nicks.set(id, p.nick); return p.nick; }
  return nicks.get(id) || 'Player';
}
const nameOf = (id) => nickOf(id) + (id === myId() && !solo() ? ' (you)' : '');

function colorOf(id) {
  const i = seatIndex(id);
  return i >= 0 ? PAL[i % PAL.length] : C.dim;
}

// ── the host ────────────────────────────────────────────────────────────────

const canDeal = (now) => S.ph === 'wait' || (S.ph === 'over' && now - overAt >= DEAL_COOLDOWN);
const running = () => (solo() ? 1 : room.players.filter((p) => p.id === myId() || here.has(p.id)).length);
// Alone: nobody else in the room, or nobody else's disk has said hello in the
// time a disk that is running would have.
const alone = (now) => running() < 2 && (solo() || room.players.length < 2 || now - startedAt > 4000);
const practiceTable = () => S.g > 0 && S.ph !== 'wait' && S.seats.some((s) => isBot(s.id));

// `force` deals over a game still running: the practice game somebody joined.
function hostDeal(force) {
  const now = performance.now();
  if (!amHost() || (!force && !canDeal(now))) return;
  joinEnd = 0;
  let ids = solo() ? [-1] : room.players.filter((p) => p.id === myId() || here.has(p.id)).slice(0, MAX_SEATS).map((p) => p.id);
  // Fewer than two people is a practice table: the host is dealt two bots.
  if (ids.length < 2) ids = ids.concat([-2, -3]);
  const sd = startDice(ids.length);
  S = blank();
  S.g = Math.floor(Math.random() * 1e9) + 1;
  S.sd = sd;
  S.seats = ids.map((id) => ({ id, d: sd, sit: 0, pu: 0 }));
  palNext = 0;
  shortAt = 0;
  newRound(now, Math.floor(Math.random() * ids.length));
}

function nextIn(i) {
  const n = S.seats.length;
  for (let j = 1; j <= n; j++) {
    const s = S.seats[(i + j) % n];
    if (inRound(s)) return (i + j) % n;
  }
  return i;
}

function newRound(now, first) {
  S.k += 1;
  for (const s of S.seats) s.sit = s.d > 0 && present(s.id) ? 0 : 1;
  const live = S.seats.filter(inRound);
  if (live.length < 2) { finish(now); return; }
  S.ph = 'roll';
  S.bid = null; S.hs = []; S.cm = []; S.rd = []; S.call = null; S.res = null; S.r = '';
  S.pal = palNext && live.length > 2 ? 1 : 0;
  palNext = 0;
  salt = randHex(16);
  S.rc = saltSealOf(salt, S.g, S.k);
  starter = first;
  S.tn = inRound(S.seats[first % S.seats.length]) ? first % S.seats.length : nextIn(first % S.seats.length);
  reveals.clear();
  botDice.clear();
  for (const s of S.seats) {
    if (!isBot(s.id) || !inRound(s)) continue;
    const d = [];
    for (let i = 0; i < s.d; i++) d.push(1 + Math.floor(Math.random() * 6));
    botDice.set(s.id, d);
  }
  endAt = now + ROLL_MS;
  publish(now);
  myRoundStart(now);
}

function finish(now) {
  const alive = S.seats.filter((s) => s.d > 0);
  const best = alive.slice().sort((a, b) => b.d - a.d)[0];
  S.win = alive.length === 1 ? alive[0].id : best && alive.filter((s) => s.d === best.d).length === 1 ? best.id : null;
  S.ph = 'over';
  S.call = null;
  endAt = now;
  overAt = now;
  publish(now);
}

// A seal, from whoever the room says sent it, for a seat in this round.
function hostSeal(id, c, now) {
  if (S.ph !== 'roll' || !HEX64.test(c)) return;
  const s = seatOf(id);
  if (!s || !inRound(s) || isBot(id) || sealed(id)) return;
  S.cm.push([id, c]);
  S.cm.sort((a, b) => seatIndex(a[0]) - seatIndex(b[0]));
  const waiting = S.seats.some((x) => inRound(x) && !isBot(x.id) && !sealed(x.id));
  if (!waiting) toBid(now);
  else publish(now);
}

// The bidding starts once every cup is sealed or the time is up. A cup that is
// still open then sits the round out: dealing it dice nobody can check later
// would make it the one cup that could be anything.
function toBid(now) {
  for (const s of S.seats) if (inRound(s) && !isBot(s.id) && !sealed(s.id)) s.sit = 1;
  if (S.seats.filter(inRound).length < 2) { finish(now); return; }
  if (!inRound(S.seats[S.tn])) S.tn = nextIn(S.tn);
  S.r = salt;
  S.ph = 'bid';
  endAt = now + TURN_MS;
  botAt = now + 1400 + Math.random() * 1600;
  publish(now);
}

function hostBid(id, q, f, now) {
  if (S.ph !== 'bid') return;
  const s = S.seats[S.tn];
  if (!s || s.id !== id || !legal(S.bid, q, f, S.pal, tableDice())) return;
  S.bid = [q, f, id];
  S.hs.push([id, q, f]);
  if (S.hs.length > HIST) S.hs.shift();
  S.tn = nextIn(S.tn);
  endAt = now + TURN_MS;
  botAt = now + 1400 + Math.random() * 2200;
  publish(now);
}

// A call is made on your own turn, on somebody else's bid. Exact is not open
// heads-up: with two players it would only ever be a coin toss for a free die.
function hostCall(id, x, now) {
  if (S.ph !== 'bid' || !S.bid) return;
  const s = S.seats[S.tn];
  if (!s || s.id !== id || S.bid[2] === id) return;
  if (x === 1 && S.seats.filter(inRound).length <= 2) return;
  S.call = [id, x];
  S.ph = 'open';
  endAt = now + OPEN_MS;
  publish(now);
  myLift(now);
  maybeResolve(now);
}

function hostReveal(id, sec, now) {
  if (S.ph !== 'open' || !HEX32.test(sec) || reveals.has(id)) return;
  const c = sealFor(id);
  if (!c || sealOf(sec, S.g, S.k, id) !== c) return;
  reveals.set(id, sec);
  S.rd.push(id);
  if (!maybeResolve(now)) publish(now);
}

function maybeResolve(now) {
  if (S.ph === 'open' && S.cm.every((x) => reveals.has(x[0]))) { resolve(now); return true; }
  return false;
}

// Count the table and settle the call. A sealed cup that is never lifted
// cannot be counted, so the round is void and that player loses a die: an
// honest copy lifts its cup on its own, so only a cut connection or a refusal
// gets here, and refusing never saves the refuser anything.
function resolve(now) {
  const miss = S.cm.filter((x) => !reveals.has(x[0])).map((x) => x[0]);
  const res = { v: miss.length ? 1 : 0, cnt: 0, lose: null, gain: null, up: 0, miss, rv: [], bd: [] };
  for (const x of S.cm) if (reveals.has(x[0])) res.rv.push([x[0], reveals.get(x[0])]);
  for (const [id, d] of botDice) res.bd.push([id, d.slice()]);
  if (res.v) {
    for (const id of miss) { const s = seatOf(id); if (s && s.d > 0) s.d -= 1; }
  } else {
    const all = allDice(S, res);
    const [q, f, by] = S.bid;
    const [cl, x] = S.call;
    for (const d of all.values()) for (const v of d) if (matches(v, f, S.pal)) res.cnt++;
    if (x === 0) res.lose = res.cnt >= q ? cl : by;
    else if (res.cnt === q) res.gain = cl;
    else res.lose = cl;
    if (res.lose !== null) {
      const s = seatOf(res.lose);
      s.d -= 1;
      // Down to one die for the first time, with more than two left: the next
      // round is that player's palifico.
      if (s.d === 1 && !s.pu && S.seats.filter((y) => y.d > 0).length > 2) { s.pu = 1; palNext = 1; }
    }
    if (res.gain !== null) { const s = seatOf(res.gain); if (s.d < S.sd) { s.d += 1; res.up = 1; } }
  }
  S.res = res;
  starter = starterAfter(res);
  S.ph = 'show';
  endAt = now + SHOW_MS;
  publish(now);
}

// Whoever lost the die opens the next round, or the next seat when they are
// out; an exact call that landed opens it for the caller.
function starterAfter(res) {
  const who = res.gain !== null ? res.gain : res.lose !== null ? res.lose : res.miss.length ? res.miss[0] : S.call ? S.call[0] : null;
  const i = seatIndex(who);
  return i >= 0 && S.seats[i].d > 0 ? i : nextAlive(i < 0 ? 0 : i);
}

function nextAlive(i) {
  const n = S.seats.length;
  for (let j = 1; j <= n; j++) if (S.seats[(i + j) % n].d > 0) return (i + j) % n;
  return i;
}

// Everyone's dice for a round, from the lifted secrets and the bots' list.
// A secret that does not match its seal counts for nothing.
function allDice(st, res) {
  const out = new Map();
  const cd = sealsDigest(st.cm);
  for (const [id, sec] of res.rv) {
    const s = st.seats.find((x) => x.id === id);
    const c = st.cm.find((x) => x[0] === id);
    if (!s || !c || sealOf(sec, st.g, st.k, id) !== c[1]) continue;
    // The count a cup was rolled with: the dice now, plus the one lost on this
    // very call, minus the one won back.
    const n = s.d + (res.lose === id ? 1 : 0) - (res.gain === id && res.up ? 1 : 0);
    out.set(id, diceOf(sec, st.r, cd, n));
  }
  for (const [id, d] of res.bd) out.set(id, d);
  return out;
}

// A bot counts what it can see, expects a third of the dice it cannot see to
// match (a sixth for aces or in a palifico), calls a bid that looks a die or
// two too high, and otherwise makes the raise it likes best, with some nerve.
function botMove(s) {
  const own = botDice.get(s.id) || [];
  const n = tableDice();
  const unseen = n - own.length;
  const exp = (f) => own.filter((d) => matches(d, f, S.pal)).length + unseen * (S.pal || f === 1 ? 1 / 6 : 1 / 3);
  const b = S.bid;
  const many = S.seats.filter(inRound).length > 2;
  if (b) {
    const doubt = b[0] - exp(b[1]);
    if (many && Math.abs(doubt) < 0.4 && Math.random() < 0.2) return { x: 1 };
    if (doubt > 0.8 + Math.random() * 0.9) return { x: 0 };
  }
  let best = null;
  for (let f = 1; f <= 6; f++) {
    const q = minRaise(b, f, S.pal, n);
    if (!q) continue;
    const m = exp(f) - q + Math.random() * 0.9 - (f === 1 && !S.pal ? 0.3 : 0);
    if (!best || m > best.m) best = { q, f, m };
  }
  if (!best) return b ? { x: 0 } : { q: 1, f: 2 };
  if (b && best.m < -0.7) return { x: 0 };
  let q = best.q;
  if (best.m > 1.6 && Math.random() < 0.4 && legal(b, q + 1, best.f, S.pal, n)) q += 1;
  return { q, f: best.f };
}

// A turn that runs out plays itself: the opening bid is the smallest there is,
// and a bid already on the table is called.
function autoMove(s, now) {
  if (!S.bid) hostBid(s.id, 1, 2, now);
  else if (S.bid[2] !== s.id) hostCall(s.id, 0, now);
  else { S.tn = nextIn(S.tn); endAt = now + TURN_MS; publish(now); }
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
  if (S.ph === 'roll') {
    if (now >= endAt) toBid(now);
  } else if (S.ph === 'bid') {
    const s = S.seats[S.tn];
    if (s && isBot(s.id) && now >= botAt) {
      const m = botMove(s);
      if (m.x !== undefined) hostCall(s.id, m.x, now);
      else hostBid(s.id, m.q, m.f, now);
    } else if (s && !present(s.id) && endAt - now > AWAY_MS) {
      endAt = now + AWAY_MS;
      publish(now);
    } else if (s && now >= endAt) {
      autoMove(s, now);
    }
  } else if (S.ph === 'open') {
    if (now >= endAt) resolve(now);
  } else if (S.ph === 'show' && now >= endAt) {
    // Somebody whose connection dropped is given a moment before a round is
    // dealt without them, which would end a game of two on one blip.
    const alive = S.seats.filter((s) => s.d > 0);
    const herePlayers = alive.filter((s) => present(s.id));
    if (alive.length < 2 || !alive.some((s) => !isBot(s.id) && present(s.id))) { finish(now); return; }
    if (herePlayers.length < 2) {
      if (!shortAt) shortAt = now;
      if (now - shortAt < GRACE) return;
      finish(now);
      return;
    }
    shortAt = 0;
    newRound(now, starter);
    return;
  }
  // A heartbeat, so one lost broadcast is never the only thing that carried a
  // change, and a clock that drifted is put back.
  if (now - lastPub > 2500) publish(now);
}

function wire(now) {
  return {
    t: 'st', g: S.g, k: S.k, ph: S.ph, sd: S.sd, tn: S.tn, pal: S.pal,
    seats: S.seats.map((s) => [s.id, s.d, s.sit, s.pu]),
    bid: S.bid, hs: S.hs, rc: S.rc, r: S.r, cm: S.cm, rd: S.rd, call: S.call,
    res: S.res, win: S.win, hr: [...here].filter(inRoom).slice(0, MAX_SEATS),
    ms: Math.max(0, Math.round(endAt - now)),
    j: joinEnd ? Math.max(0, Math.round(joinEnd - now)) : -1,
  };
}

function publish(now) {
  lastPub = now;
  if (!solo()) room.send(wire(now));
  S.hr = [...here].filter(inRoom).slice(0, MAX_SEATS);
  observe(now);
}

// ── receiving ───────────────────────────────────────────────────────────────

// A table off the wire is a claim and is read as one: the right shape, numbers
// in range, lists of bounded length, ids that are seated. Anything else is
// dropped whole.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID_MIN = -8, ID_MAX = 2147483647;
const isId = (v) => int(v, ID_MIN, ID_MAX);
const PHASES = ['wait', 'roll', 'bid', 'open', 'show', 'over'];

function stateOf(m) {
  if (!int(m.g, 0, 1e9) || !int(m.k, 0, 1e6) || !PHASES.includes(m.ph)) return null;
  if (!int(m.sd, 0, 5) || !int(m.tn, 0, MAX_SEATS - 1) || !int(m.pal, 0, 1)) return null;
  if (!Array.isArray(m.seats) || m.seats.length > MAX_SEATS) return null;
  const seats = [];
  for (const r of m.seats) {
    if (!Array.isArray(r) || r.length !== 4) return null;
    const [id, d, sit, pu] = r;
    if (!isId(id) || !int(d, 0, 5) || !int(sit, 0, 1) || !int(pu, 0, 1)) return null;
    if (seats.some((s) => s.id === id)) return null;
    seats.push({ id, d, sit, pu });
  }
  const seated = (id) => seats.some((s) => s.id === id);
  let bid = null;
  if (m.bid !== null) {
    if (!Array.isArray(m.bid) || m.bid.length !== 3 || !int(m.bid[0], 1, 40) || !int(m.bid[1], 1, 6) || !seated(m.bid[2])) return null;
    bid = m.bid.slice();
  }
  if (!Array.isArray(m.hs) || m.hs.length > HIST) return null;
  for (const h of m.hs) if (!Array.isArray(h) || h.length !== 3 || !seated(h[0]) || !int(h[1], 1, 40) || !int(h[2], 1, 6)) return null;
  if (typeof m.rc !== 'string' || !(m.rc === '' || HEX64.test(m.rc))) return null;
  if (typeof m.r !== 'string' || !(m.r === '' || HEX32.test(m.r))) return null;
  if (!Array.isArray(m.cm) || m.cm.length > MAX_SEATS) return null;
  for (const x of m.cm) if (!Array.isArray(x) || x.length !== 2 || !seated(x[0]) || typeof x[1] !== 'string' || !HEX64.test(x[1])) return null;
  if (!Array.isArray(m.rd) || m.rd.length > MAX_SEATS || !m.rd.every(seated)) return null;
  let call = null;
  if (m.call !== null) {
    if (!Array.isArray(m.call) || m.call.length !== 2 || !seated(m.call[0]) || !int(m.call[1], 0, 1)) return null;
    call = m.call.slice();
  }
  let res = null;
  if (m.res !== null) {
    const r = m.res;
    if (!r || typeof r !== 'object' || !int(r.v, 0, 1) || !int(r.up, 0, 1) || !int(r.cnt, 0, 40)) return null;
    if (!(r.lose === null || seated(r.lose)) || !(r.gain === null || seated(r.gain))) return null;
    if (!Array.isArray(r.miss) || r.miss.length > MAX_SEATS || !r.miss.every(seated)) return null;
    if (!Array.isArray(r.rv) || r.rv.length > MAX_SEATS) return null;
    for (const x of r.rv) if (!Array.isArray(x) || x.length !== 2 || !seated(x[0]) || typeof x[1] !== 'string' || !HEX32.test(x[1])) return null;
    if (!Array.isArray(r.bd) || r.bd.length > MAX_SEATS) return null;
    for (const x of r.bd) {
      if (!Array.isArray(x) || x.length !== 2 || !seated(x[0]) || !isBot(x[0]) || !Array.isArray(x[1]) || x[1].length > 5) return null;
      if (!x[1].every((v) => int(v, 1, 6))) return null;
    }
    res = { v: r.v, cnt: r.cnt, lose: r.lose, gain: r.gain, up: r.up, miss: r.miss.slice(), rv: r.rv.map((x) => x.slice()), bd: r.bd.map((x) => [x[0], x[1].slice()]) };
  }
  if (!(m.win === null || seated(m.win))) return null;
  if (!Array.isArray(m.hr) || m.hr.length > MAX_SEATS || !m.hr.every(isId)) return null;
  if (typeof m.ms !== 'number' || !Number.isFinite(m.ms)) return null;
  if (m.tn >= Math.max(1, seats.length)) return null;
  return {
    S: { g: m.g, k: m.k, ph: m.ph, seats, sd: m.sd, tn: m.tn, bid, hs: m.hs.map((h) => h.slice()), pal: m.pal, rc: m.rc, r: m.r, cm: m.cm.map((x) => x.slice()), rd: m.rd.slice(), call, res, win: m.win, hr: m.hr.slice() },
    ms: Math.min(Math.max(m.ms, 0), TURN_MS),
    j: typeof m.j === 'number' && Number.isFinite(m.j) && m.j >= 0 ? Math.min(m.j, JOIN_MS) : -1,
  };
}

// Every sender gets a bucket: ten messages a second, twenty-four at once. An
// honest copy sends a handful a round; one that floods is dropped here before
// any of its messages is even read, so it cannot stall the table for the rest.
const buckets = new Map();
function allow(from, now) {
  let b = buckets.get(from);
  if (!b) { b = { tok: 24, at: now }; buckets.set(from, b); }
  b.tok = Math.min(24, b.tok + (now - b.at) * 0.01);
  b.at = now;
  if (b.tok < 1) return false;
  b.tok -= 1;
  return true;
}

const sameRound = (msg) => msg.g === S.g && msg.k === S.k;

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
        if (amHost()) room.send(wire(now), { to: from });
        break;
      case 'go':
        if (amHost() && inRoom(from)) { here.add(from); hostDeal(); }
        break;
      case 'cm':
        if (!amHost() || !sameRound(msg) || typeof msg.c !== 'string' || !HEX64.test(msg.c)) break;
        here.add(from);
        hostSeal(from, msg.c, now);
        break;
      case 'bd':
        if (amHost() && sameRound(msg) && int(msg.q, 1, 40) && int(msg.f, 1, 6)) hostBid(from, msg.q, msg.f, now);
        break;
      case 'ca':
        if (amHost() && sameRound(msg) && int(msg.x, 0, 1)) hostCall(from, msg.x, now);
        break;
      case 'rv':
        if (amHost() && sameRound(msg) && typeof msg.s === 'string') hostReveal(from, msg.s, now);
        break;
      case 'st': {
        if (amHost() || !fromHost(from)) break;
        const st = stateOf(msg);
        if (!st) break;
        adopt(st.S, now, st.ms);
        joinEnd = st.j >= 0 ? now + st.j : 0;
        break;
      }
    }
  } catch (e) {
    // A message that breaks this handler is the sender's problem, never the table's.
  }
});

function adopt(next, now, ms) {
  S = next;
  gotState = true;
  endAt = now + ms;
  observe(now);
  myRoundStart(now);
  if (S.ph === 'open') myLift(now);
}

room.on('join', (p) => { nicks.set(p.id, p.nick); });

room.on('leave', (p) => {
  nicks.set(p.id, p.nick);
  buckets.delete(p.id);
});

room.on('hostchange', () => {
  if (!amHost() || S.g === 0) return;
  // The old host took its salt and its bots' dice with it, so a round that
  // was being played is dealt again from the start with the same dice counts
  // and the same opener; nobody loses anything for it.
  const now = performance.now();
  if (S.ph === 'roll' || S.ph === 'bid' || S.ph === 'open') {
    newRound(now, S.tn);
  } else if (S.ph === 'show') {
    starter = S.res ? starterAfter(S.res) : S.tn;
    endAt = now + 1500;
    publish(now);
  } else {
    publish(now);
  }
});

// ── my cup ──────────────────────────────────────────────────────────────────

// A new round on the table: draw a secret and send its seal, once per round.
function myRoundStart(now) {
  const s = mySeat();
  const key = roundKey(S.g, S.k);
  if (S.ph !== 'roll' || !s || !inRound(s)) return;
  if (mine && mine.key === key) return;
  const sec = randHex(16);
  // The salt's seal as it stood before I sealed: a host that swaps it for
  // another after seeing every seal is caught when the salt comes out.
  mine = { key, s: sec, c: sealOf(sec, S.g, S.k, myId()), rc: S.rc };
  myDice = null;
  sendSeal(now);
}

function sendSeal(now) {
  if (!mine || S.ph !== 'roll') return;
  lastCm = now;
  if (amHost()) hostSeal(myId(), mine.c, now);
  else if (room.host) room.send({ t: 'cm', g: S.g, k: S.k, c: mine.c }, { to: room.host.id });
}

function myLift(now) {
  if (!mine || mine.key !== roundKey(S.g, S.k) || S.ph !== 'open' || !sealed(myId())) return;
  if (S.rd.includes(myId())) return;
  lastRv = now;
  liftedKey = mine.key;
  if (amHost()) hostReveal(myId(), mine.s, now);
  else if (room.host) room.send({ t: 'rv', g: S.g, k: S.k, s: mine.s }, { to: room.host.id });
}

// My dice, once the salt is out: worked out here from my own secret, never
// sent to me by anyone. The salt is checked against the seal the host showed
// before any cup was sealed, and my seal against the one the host listed.
function computeMine() {
  const key = roundKey(S.g, S.k);
  if (myDice && myDice.key === key) return myDice.dice;
  if (!mine || mine.key !== key || !S.r || !sealed(myId())) return null;
  if (saltSealOf(S.r, S.g, S.k) !== mine.rc) warn = 'The host\'s salt did not match its seal. Dice may be rigged.';
  if (sealFor(myId()) !== mine.c) warn = 'The host listed a seal that is not yours.';
  const s = mySeat();
  myDice = { key, dice: diceOf(mine.s, S.r, sealsDigest(S.cm), s ? s.d : 0) };
  rollAt = performance.now();
  return myDice.dice;
}

// ── my moves ────────────────────────────────────────────────────────────────

const sel = { q: 1, f: 2 };
let selKey = '';
let selTouched = '';          // the round in which I last lined up a bid myself

const myTurn = () => S.ph === 'bid' && S.seats[S.tn] && S.seats[S.tn].id === myId() && !!mySeat();
const canExact = () => S.seats.filter(inRound).length > 2;

// When my turn comes, the controls start on the smallest raise of the face I
// hold most of, so a quick bid is one press.
function primeSel() {
  const key = roundKey(S.g, S.k) + ':' + S.hs.length;
  if (selKey === key) return;
  selKey = key;
  const n = tableDice();
  // A bid I lined up while waiting stands, as long as it is still legal.
  if (selTouched === roundKey(S.g, S.k) && legal(S.bid, sel.q, sel.f, S.pal, n)) return;
  const d = computeMine() || [];
  let bestF = S.bid ? S.bid[1] : 2, bestC = -1;
  if (!S.pal || !S.bid) {
    for (let f = S.pal ? 1 : 2; f <= 6; f++) {
      const c = d.filter((v) => matches(v, f, S.pal)).length;
      if (c > bestC) { bestC = c; bestF = f; }
    }
  }
  sel.f = bestF;
  sel.q = minRaise(S.bid, bestF, S.pal, n) || Math.max(1, Math.min(n, S.bid ? S.bid[0] : 1));
}

let lastAct = 0;
function act(kind) {
  const now = performance.now();
  if (!myTurn() || now - lastAct < 300) return;
  if (kind === 'bid') {
    if (!legal(S.bid, sel.q, sel.f, S.pal, tableDice())) { sfx.no(); nudge = now; return; }
    lastAct = now;
    sfx.click();
    if (amHost()) hostBid(myId(), sel.q, sel.f, now);
    else if (room.host) room.send({ t: 'bd', g: S.g, k: S.k, q: sel.q, f: sel.f }, { to: room.host.id });
  } else {
    const x = kind === 'exact' ? 1 : 0;
    if (!S.bid || S.bid[2] === myId() || (x === 1 && !canExact())) return;
    lastAct = now;
    if (amHost()) hostCall(myId(), x, now);
    else if (room.host) room.send({ t: 'ca', g: S.g, k: S.k, x }, { to: room.host.id });
  }
}

function deal() {
  const now = performance.now();
  if (!canDeal(now)) return;
  sfx.click();
  if (amHost()) hostDeal();
  else if (room.host) room.send({ t: 'go' }, { to: room.host.id });
}

function setQ(q) {
  const n = Math.max(1, tableDice());
  const v = clamp(q, 1, n);
  if (v !== sel.q) { sel.q = v; sfx.tick(); }
  selTouched = roundKey(S.g, S.k);
}
function setF(f) {
  if (S.pal && S.bid) return;   // the face is locked in a palifico round
  selTouched = roundKey(S.g, S.k);
  if (f !== sel.f) {
    sel.f = f;
    sfx.tick();
    // Moving to a face where the count is too low lifts it to the smallest
    // legal one, so picking a face never leaves the button greyed out.
    if (myTurn() && !legal(S.bid, sel.q, sel.f, S.pal, tableDice())) {
      const q = minRaise(S.bid, f, S.pal, tableDice());
      if (q) sel.q = q;
    }
  }
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects are drawn from the table as it changes on this screen, never sent.
let seen = { key: '', ph: '', hs: 0, tn: -1 };
let rollAt = -1e9, bidAt = -1e9, callAt = -1e9, showAt = -1e9, turnAt = -1e9;
let shown = null;          // { key, dice: Map, cnt, list: [[id, idx]], hostCnt }
let nudge = -1e9;
const fired = new Set();

function observe(now) {
  const key = roundKey(S.g, S.k);
  const left = Math.max(0, endAt - now);
  if (key !== seen.key || S.ph !== seen.ph) {
    if (S.ph === 'roll') { sfx.rattle(); rollAt = now; }
    if (S.ph === 'open') { callAt = now; S.call && S.call[1] === 1 ? sfx.exact() : sfx.liar(); shake = 9; }
    if (S.ph === 'show') { showAt = now - (SHOW_MS - left); fired.clear(); shown = null; }
    if (S.ph === 'over' && seen.ph && seen.ph !== 'over') { overAt = now; celebrate(); }
    if (S.ph === 'over' && !seen.ph) overAt = now - DEAL_COOLDOWN;
  }
  if (S.ph === 'bid' && (S.hs.length !== seen.hs || key !== seen.key) && S.hs.length) {
    bidAt = now;
    sfx.bid(S.hs.length);
  }
  if (S.ph === 'bid' && S.tn !== seen.tn) {
    turnAt = now;
    if (myTurn()) sfx.yours();
  }
  seen = { key, ph: S.ph, hs: S.hs.length, tn: S.tn };
  // My secret went out on a call. A round that is bid on after that is one
  // the host can read every lifted cup of.
  if ((S.ph === 'bid' || S.ph === 'roll') && liftedKey === key) warn = 'The host lifted the cups and went on bidding. It can see your dice.';
  // Worked out while the dice counts are still the ones the cups were rolled
  // with; a copy that first sees a round after the call has no dice to show.
  if (S.ph === 'bid' || S.ph === 'open') computeMine();
  if (S.ph === 'show' && S.res && (!shown || shown.key !== key)) {
    const dice = allDice(S, S.res);
    const list = [];
    let cnt = 0;
    if (!S.res.v && S.bid) {
      for (const s of S.seats) {
        const d = dice.get(s.id);
        if (!d) continue;
        d.forEach((v, i) => { if (matches(v, S.bid[1], S.pal)) { list.push([s.id, i]); cnt++; } });
      }
      if (cnt !== S.res.cnt) warn = 'The host counted ' + S.res.cnt + ' but the lifted cups show ' + cnt + '.';
    }
    shown = { key, dice, cnt, list };
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
    g.gain.exponentialRampToValueAtTime(v || 0.08, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t);
    o.stop(t + d + 0.03);
  } catch (e) { /* a sound is never worth an error */ }
}
// A short burst of filtered noise: dice knocking on wood.
function knock(delay, v, hz) {
  if (muted || !ac) return;
  try {
    const t = ac.currentTime + (delay || 0);
    const len = Math.floor(ac.sampleRate * 0.05);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len) * (1 - i / len);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hz || 1800;
    bp.Q.value = 2.5;
    const g = ac.createGain();
    g.gain.value = v || 0.25;
    src.connect(bp); bp.connect(g); g.connect(ac.destination);
    src.start(t);
  } catch (e) { /* as above */ }
}
const sfx = {
  rattle: () => { for (let i = 0; i < 9; i++) knock(i * 0.055 + Math.random() * 0.02, 0.18 + Math.random() * 0.12, 1400 + Math.random() * 1400); },
  bid: (i) => { tone(392 + Math.min(i, 12) * 22, 0.09, 'triangle', 0.07); tone(588 + Math.min(i, 12) * 33, 0.1, 'triangle', 0.05, null, 0.06); },
  yours: () => { tone(660, 0.12, 'sine', 0.07); tone(880, 0.16, 'sine', 0.06, null, 0.1); },
  click: () => tone(720, 0.05, 'triangle', 0.06),
  tick: () => tone(1100, 0.025, 'square', 0.025),
  no: () => tone(180, 0.14, 'square', 0.05, 120),
  liar: () => { knock(0, 0.5, 400); tone(150, 0.35, 'sawtooth', 0.08, 70); tone(95, 0.4, 'square', 0.05, 55, 0.03); },
  exact: () => { knock(0, 0.4, 600); tone(523, 0.2, 'triangle', 0.07); tone(784, 0.25, 'triangle', 0.06, null, 0.08); },
  lift: () => { tone(260, 0.25, 'sine', 0.05, 520); knock(0.05, 0.15, 900); },
  count: (i) => { knock(0, 0.22, 2200); tone(500 + i * 35, 0.06, 'triangle', 0.045); },
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.04, null, i * 0.09)),
  gain: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.06, null, i * 0.07)),
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
const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); };
const ease = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2; };
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
  const color = S.win !== null ? colorOf(S.win) : C.gold;
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
    if (pops[i].t > 1.4) pops.splice(i, 1);
  }
  shake = Math.max(0, shake - 30 * dt);
}

// ── drawing pieces ──────────────────────────────────────────────────────────

const PIPS = {
  1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

function drawDie(x, y, size, v, o) {
  o = o || {};
  ctx.save();
  ctx.translate(x, y);
  if (o.rot) ctx.rotate(o.rot);
  if (o.scale !== undefined) ctx.scale(o.scale, o.scale);
  ctx.globalAlpha *= o.alpha === undefined ? 1 : o.alpha;
  const h = size / 2;
  if (o.glow) { ctx.shadowColor = o.glow; ctx.shadowBlur = size * 0.6; }
  else { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = size * 0.15; ctx.shadowOffsetY = size * 0.07; }
  rr(-h, -h, size, size, size * 0.2);
  ctx.fillStyle = o.face || C.die;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  if (o.edge) { ctx.strokeStyle = o.edge; ctx.lineWidth = Math.max(1.5, size * 0.07); ctx.stroke(); }
  const pr = size * 0.095;
  const sp = size * 0.26;
  ctx.fillStyle = v === 1 ? (o.ace || '#c43a2f') : (o.pip || C.pip);
  for (const [px, py] of PIPS[v] || []) {
    ctx.beginPath();
    ctx.arc(px * sp, py * sp, v === 1 ? pr * 1.6 : pr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// A leather dice cup in the seat's colour, lifted by `lift` of its height.
function drawCup(x, y, w, color, lift, wob) {
  const h = w * 0.95;
  ctx.save();
  ctx.translate(x, y - lift * h * 1.1);
  if (wob) ctx.rotate(wob);
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = w * 0.25;
  ctx.shadowOffsetY = w * 0.1 + lift * w * 0.4;
  ctx.beginPath();
  ctx.moveTo(-w * 0.5, 0);
  ctx.lineTo(-w * 0.36, -h);
  ctx.lineTo(w * 0.36, -h);
  ctx.lineTo(w * 0.5, 0);
  ctx.closePath();
  const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  g.addColorStop(0, alpha(color, 0.75));
  g.addColorStop(0.45, color);
  g.addColorStop(1, alpha(color, 0.55));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-w * 0.5, -h * 0.16, w, h * 0.08);
  ctx.fillRect(-w * 0.4, -h * 0.84, w * 0.8, h * 0.06);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(-w * 0.22, -h * 0.75, w * 0.07, h * 0.5);
  ctx.restore();
}

function button(id, label, x, y, w, h, enabled, style) {
  const pressed = press === id;
  ctx.save();
  ctx.globalAlpha = enabled ? 1 : 0.38;
  rr(x, y + (pressed ? 2 : 0), w, h, Math.min(h / 2, 14));
  const fill = style === 'gold' ? C.gold : style === 'red' ? C.red : style === 'amber' ? C.amber : 'rgba(255,255,255,0.08)';
  ctx.fillStyle = fill;
  ctx.fill();
  if (!style) { ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke(); }
  const ink = style === 'gold' ? C.goldDeep : style === 'red' ? '#fff4ee' : style === 'amber' ? '#3a1d00' : C.text;
  text(label, x + w / 2, y + h / 2 + (pressed ? 2 : 0), Math.min(17, h * 0.42), ink, 'center', 800, w - 14);
  ctx.restore();
  if (enabled) btns.push({ id, x, y, w, h });
}

function drawMute() {
  const s = 30, x = W - 10 - s, y = 6;
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
  btns.push({ id: 'mute', x: x - 6, y: y - 4, w: s + 12, h: s + 10 });
}

function drawBackground(now) {
  const g = ctx.createRadialGradient(W / 2, H * 0.35, 10, W / 2, H * 0.5, Math.max(W, H) * 0.8);
  g.addColorStop(0, C.bg0);
  g.addColorStop(1, C.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Planks, faint, so the tavern floor is never a flat colour.
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let y = 26; y < H; y += 52) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  // A lamp's flicker.
  const f = 0.06 + 0.025 * Math.sin(now / 170) * Math.sin(now / 530);
  const lg = ctx.createRadialGradient(W / 2, -H * 0.1, 10, W / 2, -H * 0.1, H * 0.9);
  lg.addColorStop(0, 'rgba(255,190,110,' + f + ')');
  lg.addColorStop(1, 'rgba(255,190,110,0)');
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, W, H);
}

// ── layout ──────────────────────────────────────────────────────────────────

let btns = [];
let press = '';
let qBox = null, fRow = null;
let drag = null;               // { kind: 'q' | 'f', y0, q0 }

// Two shapes. A wide frame puts my cup and the controls in a panel to the
// right of the table; anything else stacks them under it, which is what a
// phone held upright needs.
function geom() {
  const top = 42;
  const side = W >= 640 && W > H * 1.25;
  if (side) {
    const pw = clamp(Math.round(W * 0.36), 260, 340);
    const px = W - pw - 8;
    const cw = pw - 20;
    const fb = clamp(Math.floor((cw - 40) / 6), 30, 46);
    const rowH = clamp(Math.round(fb * 0.9), 34, 42);
    const die = clamp(Math.floor(Math.min((pw - 40) / 5 - 8, H * 0.09)), 24, 46);
    const tray = { x: px, y: top + 12, w: pw };
    const ctrl = { x: px + 10, y: tray.y + die + 22 + 16, w: cw };
    const panel = { x: px, y: top + 2, w: pw, h: ctrl.y - top + fb + 10 + rowH * 2 + 8 + 12 };
    return { side, narrow: true, top, fb, rowH, die, tray, ctrl, panel, tab: { x: 0, y: top, w: px, h: H - 30 - top } };
  }
  const narrow = W < 460;
  const cw = Math.min(W, 520) - 24;
  const fb = clamp(Math.floor((cw - 40) / 6), 30, 50);
  const rowH = clamp(Math.round(fb * 0.9), 34, 44);
  const ctrlH = fb + 10 + rowH + (narrow ? 8 + rowH : 0);
  const die = clamp(Math.floor(Math.min(W * 0.11, H * 0.08)), 24, 48);
  const ctrl = { x: (W - cw) / 2, y: H - 28 - ctrlH, w: cw };
  const tray = { x: 0, y: ctrl.y - die - 26, w: W };
  return { side, narrow, top, fb, rowH, die, tray, ctrl, panel: null, tab: { x: 0, y: top, w: W, h: tray.y - 6 - top } };
}

function tableShape(G) {
  const t = G.tab;
  return { cx: t.x + t.w / 2, cy: t.y + t.h / 2, rx: Math.max(60, t.w / 2 - 64), ry: Math.max(50, t.h / 2 - 34) };
}

// Seats sit around the table in turn order, clockwise, with me at the bottom.
function seatPos(T, i) {
  const n = S.seats.length;
  const mi = seatIndex(myId());
  const j = ((i - (mi >= 0 ? mi : 0)) % n + n) % n;
  const a = Math.PI / 2 + (2 * Math.PI * j) / n;
  return { x: T.cx + Math.cos(a) * T.rx, y: T.cy + Math.sin(a) * T.ry, a };
}

// ── the frame ───────────────────────────────────────────────────────────────

let prevNow = performance.now();
let lastTickSec = -1;

function frame(now) {
  const dt = clamp((now - prevNow) / 1000, 0, 0.1);
  prevNow = now;
  stepFx(dt);
  btns = [];
  qBox = null; fRow = null;

  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawBackground(now);
  if (S.g === 0 || S.ph === 'wait') drawLobby(now);
  else drawTable(now);
  for (const p of parts) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const k = p.t / 1.4;
    ctx.save();
    ctx.globalAlpha = 1 - k * k;
    const s = 1 + 0.4 * (1 - easeOut(p.t * 4));
    ctx.translate(p.x, p.y - 40 * easeOut(k));
    ctx.scale(s, s);
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(20,12,8,0.85)';
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
  const running = (id) => id === myId() || here.has(id) || S.hr.includes(id);
  const pw = Math.min(W - 24, 420);
  const cut = H < 360 ? 70 : 0;
  const ph = 340 - cut;
  const x = (W - pw) / 2, y = Math.max(8, (H - ph) / 2) - cut;
  rr(x, y + cut, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (!cut) {
    const bob = Math.sin(now / 500) * 3;
    drawCup(x + pw / 2 - 40, y + 70 + bob, 44, PAL[0], 0, Math.sin(now / 300) * 0.05);
    drawDie(x + pw / 2 + 18, y + 54 - bob, 30, 5, { rot: 0.2 });
    drawDie(x + pw / 2 + 48, y + 62 + bob, 26, 1, { rot: -0.3 });
  }
  text("LIAR'S DICE", x + pw / 2, y + 104, 28, C.text, 'center', 900, pw - 24);
  const lines = [
    'Bid on how many of a face lie under ALL the cups.',
    'Aces are wild. Raise the bid, or call the last one a liar.',
    'Lose the call, lose a die. Last cup standing wins.',
  ];
  lines.forEach((l, i) => text(l, x + pw / 2, y + 138 + i * 20, 13.5, C.dim, 'center', 500, pw - 28));
  let yy = y + 210;
  if (people.length) {
    const gap = 6;
    const dot = 12;
    const total = people.length * (dot + gap) - gap;
    people.forEach((p, i) => {
      const cx = x + pw / 2 - total / 2 + i * (dot + gap) + dot / 2;
      ctx.beginPath();
      ctx.arc(cx, yy, dot / 2, 0, Math.PI * 2);
      if (running(p.id)) { ctx.fillStyle = PAL[i % PAL.length]; ctx.fill(); }
      else { ctx.strokeStyle = PAL[i % PAL.length]; ctx.lineWidth = 1.5; ctx.stroke(); }
    });
    yy += 20;
  }
  const n = people.filter((p) => running(p.id)).length;
  const hostQuiet = !solo() && !amHost() && !gotState && performance.now() - startedAt > 4000;
  const status = solo() ? 'No room here: practise against two bots.'
    : hostQuiet ? 'Waiting for ' + clip(room.host ? room.host.nick : 'the host', 13, 140) + ' (host) to run the disk.'
    : n < 2 ? 'Waiting for a second player, or practise against bots.'
    : n + ' players ready. Anyone can start.';
  text(status, x + pw / 2, yy, 13, C.faint, 'center', 500, pw - 28);
  const label = solo() || n < 2 ? 'Practice vs bots' : 'Start';
  button('go', label, x + pw / 2 - 90, y + ph + cut - 70, 180, 46, solo() || amHost() || gotState, 'gold');
  text('Enter to start', x + pw / 2, y + ph + cut - 14, 11, C.faint, 'center', 500);
}

function drawTable(now) {
  const G = geom();
  const T = tableShape(G);
  const left = Math.max(0, endAt - now);
  const me = mySeat();
  const showT = (now - showAt) / 1000;
  const res = S.ph === 'show' ? S.res : null;
  const nTable = tableDice();

  // Top bar.
  text("LIAR'S DICE", 12, 21, 15, C.text, 'left', 900);
  font(15, 900);
  const tw = ctx.measureText("LIAR'S DICE").width;
  const info = 'Round ' + S.k + '  ·  ' + nTable + ' dice on the table' + (S.pal ? '  ·  PALIFICO' : '');
  text(info, 24 + tw, 21, 12, S.pal ? C.amber : C.dim, 'left', 600, W - tw - 80);

  // The table itself.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  ctx.beginPath();
  ctx.ellipse(T.cx, T.cy, T.rx + 16, T.ry + 16, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.rim;
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = C.rimHi;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(T.cx, T.cy, T.rx + 14, T.ry + 14, 0, 0, Math.PI * 2);
  ctx.stroke();
  const fg = ctx.createRadialGradient(T.cx, T.cy - T.ry * 0.3, 10, T.cx, T.cy, Math.max(T.rx, T.ry));
  fg.addColorStop(0, C.felt0);
  fg.addColorStop(1, C.felt1);
  ctx.beginPath();
  ctx.ellipse(T.cx, T.cy, T.rx, T.ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fg;
  ctx.fill();

  // The reveal's timeline, from the moment this screen saw it: the call is
  // slammed down, the cups come up, the matching dice light one by one, and
  // the verdict lands on whoever pays for it.
  const step = shown && shown.list.length ? Math.min(0.16, 2.4 / shown.list.length) : 0.16;
  const tallyEnd = COUNT_AT + (shown ? shown.list.length : 0) * step;
  const verdictAt = res && res.v ? 1.0 : tallyEnd + 0.35;
  if (res && shown) {
    const fire = (k, at, fn) => { if (showT >= at && !fired.has(k)) { fired.add(k); if (showT < at + 0.6) fn(); } };
    fire('lift', LIFT_AT, () => sfx.lift());
    shown.list.forEach((m, i) => fire('c' + i, COUNT_AT + i * step, () => sfx.count(i)));
    fire('verdict', verdictAt, () => {
      const hit = res.gain !== null ? res.gain : res.lose !== null ? res.lose : res.miss[0];
      const i = seatIndex(hit);
      if (i >= 0) {
        const p = seatPos(T, i);
        if (res.gain !== null) { sfx.gain(); burst(p.x, p.y, C.gold, 26, 220); pop(p.x, p.y - 30, '+1 die', C.gold); }
        else { sfx.lose(); shake = 8; burst(p.x, p.y, C.red, 26, 220); pop(p.x, p.y - 30, '−1 die', C.red); }
      }
      for (const id of res.miss) {
        const j = seatIndex(id);
        if (j >= 0 && id !== hit) { const p = seatPos(T, j); burst(p.x, p.y, C.red, 16, 180); pop(p.x, p.y - 30, '−1 die', C.red); }
      }
    });
  }

  // Seats.
  const cupW = clamp(Math.min(T.rx, T.ry) * 0.3, 26, 46);
  S.seats.forEach((s, i) => {
    const p = seatPos(T, i);
    const col = PAL[i % PAL.length];
    const turn = (S.ph === 'bid' || S.ph === 'roll') && S.tn === i;
    const out = s.d === 0 && !(res && (res.lose === s.id || res.miss.includes(s.id)) && showT < verdictAt);
    const away = !present(s.id);
    // Dice shown on the chip: what it held before this call until the verdict lands.
    let d = s.d;
    if (res && showT < verdictAt) d += (res.lose === s.id || res.miss.includes(s.id) ? 1 : 0) - (res.gain === s.id && res.up ? 1 : 0);
    // The cup, between the seat and the middle of the table.
    const k = 0.34;
    const cx = p.x + (T.cx - p.x) * k, cy = p.y + (T.cy - p.y) * k + cupW * 0.4;
    const playing = !s.sit && (d > 0 || !!(res && shown && shown.dice.has(s.id)));
    if (playing) {
      const lift = res ? easeOut((showT - LIFT_AT) / 0.5) : S.ph === 'open' ? 0.08 * Math.abs(Math.sin(now / 90)) : 0;
      const rollWob = S.ph === 'roll' || now - rollAt < 700 ? Math.sin(now / 45 + i) * 0.12 : 0;
      const dice = res && shown ? shown.dice.get(s.id) : null;
      if (dice) {
        const ds = clamp(cupW * 0.42, 12, 22);
        const tot = dice.length * (ds + 3) - 3;
        dice.forEach((v, j) => {
          const hl = shown.list.findIndex((m) => m[0] === s.id && m[1] === j);
          const lit = hl >= 0 && showT >= COUNT_AT + hl * step;
          drawDie(cx - tot / 2 + ds / 2 + j * (ds + 3), cy - ds * 0.6, ds, v, {
            glow: lit ? C.gold : null, edge: lit ? C.gold : null,
            alpha: res.v || lit || showT < COUNT_AT ? 1 : 0.45,
            scale: lit ? 1 + 0.25 * (1 - easeOut((showT - COUNT_AT - hl * step) / 0.25)) : 1,
          });
        });
      } else if (res && !res.v) {
        text('?', cx, cy - 10, 16, C.faint, 'center', 800);
      }
      drawCup(cx, cy, cupW, col, lift, rollWob);
    }
    // The chip: avatar, name, dice left.
    const cw = clamp(W * 0.22, 84, 128), ch = 40;
    const bx = clamp(p.x - cw / 2, G.tab.x + 4, G.tab.x + G.tab.w - cw - 4), by = clamp(p.y - ch / 2, G.top, G.tab.y + G.tab.h - ch);
    ctx.save();
    if (out || away) ctx.globalAlpha = 0.45;
    if (turn) { ctx.shadowColor = col; ctx.shadowBlur = 14 + 6 * Math.sin(now / 160); }
    rr(bx, by, cw, ch, 12);
    ctx.fillStyle = 'rgba(28,18,12,0.88)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = turn ? col : alpha(col, s.id === myId() ? 0.85 : 0.45);
    ctx.lineWidth = turn || s.id === myId() ? 2 : 1.2;
    ctx.stroke();
    const ar = 12;
    const ax = bx + 8 + ar, ay = by + ch / 2;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(ax, ay, ar, 0, Math.PI * 2);
    ctx.fill();
    const name = nickOf(s.id);
    text(name.slice(0, 1).toUpperCase(), ax, ay + 1, 13, C.bg1, 'center', 900);
    text(clip(name, 12, cw - ar * 2 - 22), ax + ar + 6, by + 13, 12, C.text, 'left', 600);
    // Dice left, as little squares; a lost one fades out where it stood.
    const slots = Math.max(S.sd, d, 1);
    const sq = clamp((cw - ar * 2 - 26) / slots - 3, 4, 7);
    for (let j = 0; j < slots; j++) {
      ctx.fillStyle = j < d ? col : 'rgba(255,255,255,0.1)';
      ctx.fillRect(ax + ar + 6 + j * (sq + 3), by + 24, sq, sq);
    }
    if (s.sit && s.d > 0) text('sits out', bx + cw - 8, by + 28, 9, C.faint, 'right', 600);
    if (out) text('OUT', bx + cw - 8, by + 28, 10, C.red, 'right', 800);
    if (turn && S.ph === 'bid') {
      // The turn's clock, a thin bar under the chip.
      const frac = clamp(left / TURN_MS, 0, 1);
      ctx.fillStyle = left < 5000 ? C.red : col;
      ctx.fillRect(bx + 10, by + ch - 4, (cw - 20) * frac, 2);
    }
    ctx.restore();
    // The seat's latest bid, in a bubble, while the round is being bid.
    if (S.ph === 'bid' || S.ph === 'open') {
      let last = null;
      for (let h = S.hs.length - 1; h >= 0; h--) if (S.hs[h][0] === s.id) { last = S.hs[h]; break; }
      if (last) {
        const newest = S.bid && S.bid[2] === s.id;
        const t = newest ? back((now - bidAt) / 350) : 1;
        const bxx = clamp(p.x, G.tab.x + 34, G.tab.x + G.tab.w - 34), byy = by - 14;
        ctx.save();
        ctx.translate(bxx, byy);
        ctx.scale(t, t);
        ctx.globalAlpha = newest ? 1 : 0.55;
        rr(-30, -12, 60, 22, 11);
        ctx.fillStyle = newest ? C.die : 'rgba(251,246,236,0.6)';
        ctx.fill();
        text(last[1] + ' ×', -9, -1, 13, C.pip, 'center', 800);
        drawDie(15, -1, 15, last[2], {});
        ctx.restore();
      }
    }
  });

  // The middle: the bid on the table, the call, or the count.
  const midS = clamp(Math.min(T.rx, T.ry) * 0.42, 34, 70);
  if (S.ph === 'roll') {
    text('Shaking the cups…', T.cx, T.cy, 16, C.dim, 'center', 700);
  } else if (S.ph === 'bid' && !S.bid) {
    const who = S.seats[S.tn];
    text(who ? (who.id === myId() ? 'Your opening bid' : nameOf(who.id) + ' opens') : '', T.cx, T.cy - 8, 16, C.text, 'center', 700, T.rx * 1.4);
    text(S.pal ? 'Palifico: aces are not wild, the face is locked' : 'Aces are wild', T.cx, T.cy + 16, 12, S.pal ? C.amber : C.dim, 'center', 600, T.rx * 1.4);
  } else if (S.bid) {
    const t = S.ph === 'bid' ? back((now - bidAt) / 400) : 1;
    const q = S.bid[0], f = S.bid[1];
    ctx.save();
    ctx.translate(T.cx, T.cy - midS * 0.15);
    ctx.scale(t, t);
    text(q + ' ×', -midS * 0.42, 0, midS * 0.62, C.text, 'center', 900);
    drawDie(midS * 0.5, 0, midS * 0.8, f, { rot: -0.08 });
    ctx.restore();
    let sub = 'bid by ' + nameOf(S.bid[2]);
    if (S.ph === 'open' || res) {
      const c = S.call;
      sub = c ? nameOf(c[0]) + (c[1] ? ' calls it EXACT' : ' calls LIAR') : '';
    }
    text(sub, T.cx, T.cy + midS * 0.52, 13, S.call ? (S.call[1] ? C.amber : C.red) : C.dim, 'center', 700, T.rx * 1.5);
    if (res && shown && !res.v) {
      const cnt = shown.list.filter((m, i) => showT >= COUNT_AT + i * step).length;
      const done = showT >= verdictAt;
      text('Counted: ' + cnt, T.cx, T.cy + midS * 0.52 + 22, 16, done ? (cnt >= q ? C.gold : C.red) : C.text, 'center', 900);
    }
  }
  // The call itself, slammed onto the table.
  if (S.ph === 'open' || (res && showT < 1.6)) {
    const t = (now - callAt) / 1000;
    if (S.call && t < 2.2) {
      const k = back(t / 0.3);
      ctx.save();
      ctx.translate(T.cx, T.cy - T.ry * 0.55);
      ctx.scale(k, k);
      ctx.rotate(-0.06);
      ctx.globalAlpha = clamp((2.2 - t) / 0.4, 0, 1);
      text(S.call[1] ? 'EXACT!' : 'LIAR!', 0, 0, midS * 0.6, S.call[1] ? C.amber : C.red, 'center', 900);
      ctx.restore();
    }
  }

  // My cup, in the tray.
  if (G.panel) {
    rr(G.panel.x, G.panel.y, G.panel.w, G.panel.h, 16);
    ctx.fillStyle = 'rgba(20,12,8,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(138,90,54,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  drawTray(G, now);
  drawControls(G, now);

  // The verdict.
  if (res && showT >= verdictAt) {
    let msg;
    if (res.v) msg = res.miss.map(nickOf).join(', ') + ' never lifted ' + (res.miss.length > 1 ? 'their cups' : 'the cup') + ': round void, −1 die.';
    else if (res.gain !== null) msg = 'Spot on! ' + nameOf(res.gain) + ' wins a die back.';
    else if (S.call && S.call[1]) msg = 'Not exact. ' + nameOf(res.lose) + ' loses a die.';
    else msg = (shown && S.bid && shown.cnt >= S.bid[0] ? 'The bid was true. ' : 'A lie! ') + nameOf(res.lose) + ' loses a die.';
    const k = easeOut((showT - verdictAt) / 0.3);
    ctx.save();
    ctx.globalAlpha = k;
    font(15, 800);
    const mw = Math.min(G.tab.w - 16, ctx.measureText(msg).width + 36);
    const vy = G.tab.y + G.tab.h - 30;
    rr(T.cx - mw / 2, vy - 14, mw, 28, 14);
    ctx.fillStyle = C.panel;
    ctx.fill();
    text(msg, T.cx, vy, 15, res.gain !== null ? C.gold : C.text, 'center', 800, mw - 20);
    ctx.restore();
  }

  if (warn) text('⚠ ' + warn, T.cx, G.top + 6, 11, C.amber, 'center', 700, G.tab.w - 16);
  if (S.ph === 'over') drawOver(now);
  if (practiceTable()) {
    const head = joinEnd ? joinHead(Math.max(1, Math.ceil((joinEnd - now) / 1000)))
      : 'practice with bots · a game starts when someone joins';
    const tip = joinEnd ? null : 'bid on how many of a face lie under every cup · aces are wild';
    // Between the middle of the table and my own cup, which stands a third of
    // the way in from my seat.
    const cupTop = T.cy + T.ry * 0.66 + cupW * 0.4 - cupW * 1.2;
    practiceNote(now, G.tab.w, head, tip, [], cupTop - 8, G.tab.x);
  }
}

function drawTray(G, now) {
  const me = mySeat();
  const cx = G.tray.x + G.tray.w / 2, y = G.tray.y, maxW = G.tray.w - 16;
  const D = G.die;
  if (!me) {
    text('You are watching. You get a seat next game.', cx, y + 10 + D / 2, 13, C.dim, 'center', 600, maxW);
    return;
  }
  const col = colorOf(myId());
  const dice = myDice && myDice.key === roundKey(S.g, S.k) ? myDice.dice : null;
  const n = dice ? dice.length : me.d;
  const tot = n * (D + 8) - 8;
  const w = Math.min(maxW, Math.max(tot + 40, 200));
  rr(cx - w / 2, y + 2, w, D + 16, 12);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();
  ctx.strokeStyle = alpha(col, 0.55);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const say = (msg) => text(msg, cx, y + 10 + D / 2, 13, C.faint, 'center', 600, w - 20);
  if (me.d === 0 && S.ph !== 'show') { say('Out of dice. Watch the rest play it out.'); return; }
  if (me.sit) { say('Sitting this round out.'); return; }
  if (!dice && S.ph !== 'roll') { say('This cup was sealed before the page started. Bid blind.'); return; }
  const f = myTurn() ? sel.f : S.bid ? S.bid[1] : sel.f;
  for (let j = 0; j < n; j++) {
    const x = cx - tot / 2 + D / 2 + j * (D + 8), yy = y + 10 + D / 2;
    if (!dice) {
      // Still sealing: the dice tumble under the cup.
      const v = 1 + ((Math.floor(now / 90) + j * 3) % 6);
      drawDie(x, yy, D, v, { rot: Math.sin(now / 70 + j) * 0.4, alpha: 0.35 });
      continue;
    }
    // Fresh dice tumble in one after another, then settle; the ones that
    // count for the face in play are ringed in my colour.
    const t = (now - rollAt) / 1000 - j * 0.07;
    const v = t < 0.45 ? 1 + ((Math.floor(now / 60) + j) % 6) : dice[j];
    const lit = (S.ph === 'bid' || S.ph === 'open') && matches(dice[j], f, S.pal);
    drawDie(x, yy - (t < 0.45 ? Math.abs(Math.sin(t * 14)) * 8 : 0), D, v, {
      rot: t < 0.45 ? (0.45 - t) * 3 * Math.sin(j * 2.1 + 1) : 0,
      scale: t < 0.6 ? 0.85 + 0.15 * back(t / 0.6) : 1,
      edge: lit && t >= 0.45 ? col : null,
    });
  }
}

function drawControls(G, now) {
  const me = mySeat();
  const yours = myTurn();
  const n = Math.max(1, tableDice());
  const x0 = G.ctrl.x, span = G.ctrl.w;
  let y = G.ctrl.y;
  const how = S.ph === 'over' ? ''
    : yours ? (coarse ? 'Pick a face, drag the count up or down, then bid or call.' : 'Faces 1-6 · count ↑↓, wheel or drag · Enter bids · L liar · E exact')
    : me && me.d > 0 && S.ph === 'bid' ? 'Waiting for ' + nameOf(S.seats[S.tn].id) + '. Line up your next bid meanwhile.'
    : 'Aces are wild. Lose a call, lose a die.';
  text(how, W / 2, H - 13, 12, C.faint, 'center', 500, W - 24);
  if (!me || me.d === 0 || S.ph === 'over') return;
  if (yours) primeSel();
  const on = S.ph === 'bid' && !me.sit;
  const col = colorOf(myId());
  // Faces.
  const fb = G.fb, gap = (span - fb * 6) / 5;
  fRow = { x: x0, y, w: span, h: fb };
  for (let f = 1; f <= 6; f++) {
    const x = x0 + (f - 1) * (fb + gap) + fb / 2;
    const chosen = sel.f === f;
    const locked = S.pal && S.bid && S.bid[1] !== f;
    drawDie(x, y + fb / 2, fb * (chosen ? 0.92 : 0.78), f, {
      alpha: on && !locked ? (chosen ? 1 : 0.7) : 0.3,
      edge: chosen ? col : null,
      glow: chosen && yours ? alpha(col, 0.8) : null,
    });
  }
  y += fb + 10;
  // Count, bid and the two calls.
  const rh = G.rowH;
  const sq = rh;
  const nudged = now - nudge < 400 ? Math.sin((now - nudge) / 25) * 4 : 0;
  button('qm', '−', x0, y, sq, rh, on && sel.q > 1);
  const qw = Math.max(46, rh * 1.3);
  qBox = { x: x0 + sq + 4, y, w: qw, h: rh };
  rr(qBox.x + nudged, y, qw, rh, 10);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();
  ctx.strokeStyle = yours ? alpha(col, 0.6) : 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  text(String(sel.q), qBox.x + qw / 2 + nudged, y + rh / 2 + 1, rh * 0.55, on ? C.text : C.faint, 'center', 900);
  button('qp', '+', x0 + sq + 8 + qw, y, sq, rh, on && sel.q < n);
  const bx = x0 + sq * 2 + 16 + qw;
  const valid = legal(S.bid, sel.q, sel.f, S.pal, n);
  const canCall = yours && !!S.bid && S.bid[2] !== myId();
  const label = 'Bid ' + sel.q + ' × ' + sel.f + 's';
  if (G.narrow) {
    button('bid', label, bx, y, x0 + span - bx, rh, yours && valid, 'gold');
    y += rh + 8;
    const hw = (span - 8) / 2;
    button('liar', 'Liar!', x0, y, hw, rh, canCall, 'red');
    button('exact', 'Exact', x0 + hw + 8, y, hw, rh, canCall && canExact(), 'amber');
  } else {
    const rest = x0 + span - bx;
    const bw = rest * 0.42, cw = (rest - bw - 16) / 2;
    button('bid', label, bx, y, bw, rh, yours && valid, 'gold');
    button('liar', 'Liar!', bx + bw + 8, y, cw, rh, canCall, 'red');
    button('exact', 'Exact', bx + bw + 16 + cw, y, cw, rh, canCall && canExact(), 'amber');
  }
  // The last seconds of my own turn tick.
  if (yours) {
    const sec = Math.ceil(Math.max(0, endAt - now) / 1000);
    if (sec <= 5 && sec > 0 && sec !== lastTickSec) sfx.tick();
    lastTickSec = sec;
  }
}

function drawOver(now) {
  const k = easeOut((now - overAt) / 500);
  ctx.fillStyle = 'rgba(14,8,5,' + 0.6 * k + ')';
  ctx.fillRect(0, 0, W, H);
  const list = S.seats.slice().sort((a, b) => b.d - a.d);
  const pw = Math.min(W - 24, 380);
  const rowH = 28;
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
  const title = S.win === null ? 'Game over' : nameOf(S.win) + ' wins';
  text(title, x + pw / 2, y + 34, 24, S.win === null ? C.text : colorOf(S.win), 'center', 900, pw - 28);
  list.forEach((s, i) => {
    const yy = y + 72 + i * rowH;
    if (yy > y + ph - 70) return;
    ctx.fillStyle = colorOf(s.id);
    ctx.beginPath();
    ctx.arc(x + 30, yy, 6, 0, Math.PI * 2);
    ctx.fill();
    text(clip(nickOf(s.id), 14, pw - 150), x + 44, yy, 14, C.text, 'left', 600);
    text(s.d ? s.d + (s.d === 1 ? ' die left' : ' dice left') : 'out', x + pw - 24, yy, 13, s.d ? C.gold : C.faint, 'right', 700);
  });
  const ready = now - overAt >= DEAL_COOLDOWN;
  const people = solo() ? 0 : room.players.length;
  button('go', people >= 2 ? 'Play again' : 'Practice again', x + pw / 2 - 90, y + ph - 60, 180, 44, ready, 'gold');
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
const inside = (p, r) => !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
function buttonAt(p) { const b = btns.find((x) => inside(p, x)); return b ? b.id : ''; }
const faceAt = (p) => clamp(1 + Math.floor(((p.x - fRow.x) / fRow.w) * 6), 1, 6);

function press1(id) {
  if (id === 'mute') { muted = !muted; if (!muted) sfx.click(); }
  else if (id === 'go') deal();
  else if (id === 'qm') setQ(sel.q - 1);
  else if (id === 'qp') setQ(sel.q + 1);
  else act(id);
}

cv.addEventListener('pointerdown', (e) => {
  audio();
  const p = pt(e);
  const b = buttonAt(p);
  e.preventDefault();
  if (b) { press = b; return; }
  const me = mySeat();
  if (!me || S.ph !== 'bid') return;
  // The count and the face are both dragged: up or down on the count, across
  // the row of faces. A tap is a drag that did not move.
  if (inside(p, qBox)) drag = { kind: 'q', y0: p.y, q0: sel.q };
  else if (inside(p, { x: fRow.x - 6, y: fRow.y - 6, w: fRow.w + 12, h: fRow.h + 12 })) { drag = { kind: 'f' }; setF(faceAt(p)); }
  if (drag) { try { cv.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ } }
});
cv.addEventListener('pointermove', (e) => {
  const p = pt(e);
  if (drag && drag.kind === 'q') setQ(drag.q0 + Math.round((drag.y0 - p.y) / 22));
  else if (drag && drag.kind === 'f' && fRow) setF(faceAt(p));
  if (e.pointerType === 'mouse') cv.style.cursor = buttonAt(p) ? 'pointer' : inside(p, qBox) ? 'ns-resize' : inside(p, fRow) ? 'pointer' : 'default';
});
cv.addEventListener('pointerup', (e) => {
  const p = pt(e);
  if (press) {
    if (buttonAt(p) === press) press1(press);
    press = '';
  }
  drag = null;
});
cv.addEventListener('pointercancel', () => { drag = null; press = ''; });
cv.addEventListener('wheel', (e) => {
  if (inside(pt(e), qBox)) { setQ(sel.q + (e.deltaY < 0 ? 1 : -1)); e.preventDefault(); }
}, { passive: false });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  audio();
  const k = e.key;
  if (k === 'm' || k === 'M') { press1('mute'); return; }
  if ((S.g === 0 || S.ph === 'wait' || S.ph === 'over') && (k === 'Enter' || k === ' ')) { deal(); e.preventDefault(); return; }
  if (!mySeat() || S.ph !== 'bid') return;
  if (/^[1-6]$/.test(k)) setF(Number(k));
  else if (k === 'ArrowUp' || k === 'ArrowRight') { setQ(sel.q + 1); e.preventDefault(); }
  else if (k === 'ArrowDown' || k === 'ArrowLeft') { setQ(sel.q - 1); e.preventDefault(); }
  else if (k === 'Enter') { act('bid'); e.preventDefault(); }
  else if (k === 'l' || k === 'L') act('liar');
  else if (k === 'e' || k === 'E') act('exact');
});

// ── start ───────────────────────────────────────────────────────────────────

const startedAt = performance.now();

// The host's clock and this copy's resends share one beat. A seal or a lifted
// cup that was lost on the way is sent again until the table shows it arrived;
// a hello is repeated slowly until somebody answers.
setInterval(() => {
  try {
    const now = performance.now();
    hostTick(now);
    if (solo()) return;
    if (!amHost()) {
      if (S.ph === 'roll' && mine && mine.key === roundKey(S.g, S.k) && !sealed(myId()) && now - lastCm > 1500) sendSeal(now);
      if (S.ph === 'open' && now - lastRv > 2000) myLift(now);
      if (!gotState && now - lastHi > 3000) { lastHi = now; room.send({ t: 'hi' }); }
    }
  } catch (e) {
    // A tick that throws once must not stop every tick after it.
  }
}, 100);
requestAnimationFrame(frame);
