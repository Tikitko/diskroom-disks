/**
 * @disk     bento
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Pack a bento by drafting. Take one dish from the tray in your hands, drop it into your three by three box and pass the rest on. Every dish scores by where it sits: salmon alone, tempura in clumps, pickles in corners, tamago in lines.
 * @tags     game, party, cards, drafting, puzzle
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/bento.png
 */
// bento.js — a drafting game, run by the host.
//
// A game is three rounds. Each round everybody is dealt a tray of nine dishes,
// face down to everyone else. At once, every player takes one dish from the
// tray in their hands and puts it into an empty compartment of their own
// three-by-three bento box; then the trays are passed on, left in the first and
// third round, right in the second. Nine picks fill every box, and the boxes
// are scored by where each dish sits:
//
//   rice     1 point for each different dish beside it
//   salmon   3 points, or none if it touches another salmon
//   tempura  as many points as tempura in its clump, at most 3 each
//   pickle   3 points in a corner, 1 anywhere else
//   tamago   2 points for every other tamago in its row and its column, at most 4
//   mochi    nothing in the box; whoever saved the most at the end gets 6,
//            whoever saved the fewest loses 3
//
// Whoever trails after a round gets the golden compartment for the next one:
// the middle of their box counts double.
//
// The host is the authority. It deals the trays and sends each player their
// own tray alone, addressed, so no other seat has it on the wire; a pick goes
// to the host alone, is checked against that tray and that box, and nothing
// moves until the host turns every pick over at once. Boxes and scores are
// public: every copy scores a box itself from the dishes in it. What this does
// not stop is a hostile host: the host's own copy holds every tray and every
// pick before the reveal, and nothing in a host-run game can take that away.
//
// A player alone is dealt a practice game against three bots at once, and
// another after it, for as long as nobody else runs the disk. When somebody
// does, practice ends three seconds on under a note that says so, and the host
// deals the real game without the bots.

// ── rules ───────────────────────────────────────────────────────────────────

const RICE = 0, SALMON = 1, TEMPURA = 2, PICKLE = 3, TAMAGO = 4, MOCHI = 5;
const KINDS = 6;
const COUNT = [16, 16, 16, 14, 16, 12];   // the deck: 90 dishes, enough for eight trays of nine
const HAND = 9;
const ROUNDS = 3;
const GOLD_SLOT = 4;
const PICK_MS = 20000;                     // time to pick, set by the host's clock
const SHOW_MS = 1700;                      // how long a reveal stays up before the trays pass
const SCORE_MS = 7000;                     // how long a scored round stays up
const DEAL_COOLDOWN = 2500;                // a finished game is on screen at least this long
const PRACTICE_AGAIN = 7000;               // a finished practice game stays up this long before the next
const JOIN_MS = 3000;                      // practice runs on this long after somebody joins
const HELLO_MS = 4000;                     // how long a copy waits for other disks to say hello
const GRACE = 8000;                        // how long a dropped connection has to come back
const MAX_SEATS = 8;
const BOT_NAMES = ['Bot Miso', 'Bot Nori', 'Bot Yuzu'];

const NAME = ['Rice', 'Salmon', 'Tempura', 'Pickle', 'Tamago', 'Mochi'];
const SHORT = ['variety', 'alone', 'clumps', 'corners', 'lines', 'save up'];
const RULE = [
  'Rice: 1 point for each different dish beside it',
  'Salmon: 3 points, but none if it touches another salmon',
  'Tempura: 1 point per tempura in its clump, at most 3 each',
  'Pickle: 3 points in a corner, 1 anywhere else',
  'Tamago: 2 points per other tamago in its row and column, at most 4',
  'Mochi: nothing now; most saved at the end +6, fewest -3',
];
const FOOD = ['#f4efe2', '#ff8a5c', '#e9a93a', '#7cc46a', '#ffd84d', '#ff9ec7'];

// Compartments are numbered 0..8 row by row; these are the ones beside each.
const NB = [[1, 3], [0, 2, 4], [1, 5], [0, 4, 6], [1, 3, 5, 7], [2, 4, 8], [3, 7], [4, 6, 8], [5, 7]];
const CORNER = [1, 0, 1, 0, 0, 0, 1, 0, 1];

// What each dish in a box is worth, compartment by compartment. Every copy
// works this out for itself from the dishes, so no message ever carries it.
function cellPoints(box) {
  const pts = new Array(9).fill(0);
  const clump = new Array(9).fill(0);
  for (let i = 0; i < 9; i++) {
    if (box[i] !== TEMPURA || clump[i]) continue;
    const group = [i];
    clump[i] = -1;
    for (let k = 0; k < group.length; k++) {
      for (const j of NB[group[k]]) if (box[j] === TEMPURA && !clump[j]) { clump[j] = -1; group.push(j); }
    }
    for (const j of group) clump[j] = group.length;
  }
  for (let i = 0; i < 9; i++) {
    const t = box[i];
    if (t === RICE) {
      const kinds = new Set();
      for (const j of NB[i]) if (box[j] >= 0 && box[j] !== RICE) kinds.add(box[j]);
      pts[i] = kinds.size;
    } else if (t === SALMON) {
      pts[i] = NB[i].some((j) => box[j] === SALMON) ? 0 : 3;
    } else if (t === TEMPURA) {
      pts[i] = Math.min(3, clump[i]);
    } else if (t === PICKLE) {
      pts[i] = CORNER[i] ? 3 : 1;
    } else if (t === TAMAGO) {
      const r = Math.floor(i / 3), c = i % 3;
      let n = 0;
      for (let j = 0; j < 9; j++) {
        if (j === i || box[j] !== TAMAGO) continue;
        if (Math.floor(j / 3) === r || j % 3 === c) n++;
      }
      pts[i] = Math.min(4, 2 * n);
    }
  }
  return pts;
}
function boxScore(box, gold) {
  const pts = cellPoints(box);
  let total = 0;
  for (let i = 0; i < 9; i++) total += pts[i] * (i === gold ? 2 : 1);
  return total;
}
const mochiIn = (box) => box.reduce((a, t) => a + (t === MOCHI ? 1 : 0), 0);
const filled = (box) => box.reduce((a, t) => a + (t >= 0 ? 1 : 0), 0);
const emptyBox = () => new Array(9).fill(-1);

// One colour per seat, in seat order, so no two players at a table share one.
const PAL = ['#ff6b6b', '#ffc145', '#46d39a', '#4cc3ff', '#b48cff', '#ff8f4c', '#ff6fb7', '#9bd65a'];
const C = {
  bg0: '#3d1a1f', bg1: '#170b0e', panel: 'rgba(30,14,17,0.94)', line: '#5e2a30',
  text: '#fbf1e6', dim: '#d9b9a8', faint: '#9c7a70',
  lacquer: '#120a0b', red: '#a3282e', redDeep: '#5c1519', well: '#6e1d22', wellHi: '#84262c',
  gold: '#ffcf5a', goldDeep: '#3d2c08', bad: '#ff5d6c',
  card: '#fff6e6', cardInk: '#2a1a16', nori: '#1d2a22',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g      game id, so a stale pick for an old game is recognised
//   ph     'wait' | 'pick' | 'show' | 'score' | 'over'
//   rd     round 1..ROUNDS, pk pick 1..HAND in it
//   hk     which trays are in hands: a pick and a tray name it
//   dir    1 when trays pass to the next seat, -1 to the one before
//   seats  [{ id, box, score, gold, mochi, rs }]: score and mochi count
//          finished rounds, gold is the compartment that counts double
//   locked ids that have a pick in, never which
//   last   the reveal: [[id, dish, compartment]]
//   ng     who gets the golden compartment next round
//   mb     the mochi bonus at the end: [[id, points]]
const blank = () => ({ g: 0, ph: 'wait', rd: 0, pk: 0, hk: 0, dir: 1, seats: [], locked: [], last: null, ng: [], mb: [] });
let S = blank();
let endAt = 0;           // local clock: when this phase ends
let joinEnd = 0;         // local clock: when practice ends for somebody who joined, 0 if it does not
let overAt = -1e9;       // local clock: when the last game ended

// The host's alone.
const hands = new Map(); // seat id -> the dishes in that tray now
const dealt = new Map(); // seat id -> the tray as it was dealt for this pick
const picks = new Map(); // seat id -> { i, s }, never broadcast before the reveal
const botAt = new Map(); // bot seat id -> when it picks
const here = new Set();  // ids that have said hello: their disk is running
let lastPub = 0;
let shortAt = 0;

// Mine.
let myTray = null;       // { g, hk, h } as the host sent it
let myPick = null;       // { g, hk, i, s }
let sel = -1;            // the dish in my tray I am holding
let slotCur = 4;         // the compartment the keyboard points at
let sentKey = '';
let sendTimer = null;
let lastSend = 0;
let lastHi = -1e9, lastAsk = 0;
let gotState = false;

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
const seatOf = (id) => S.seats.find((s) => s.id === id) || null;
const mySeat = () => seatOf(myId());

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

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// The whole deck, less whatever already sits in a box: a host that inherits a
// round never saw the old host's trays, so it deals what is left in its own order.
function deck(less) {
  const n = COUNT.slice();
  for (const t of less) if (t >= 0 && n[t] > 0) n[t]--;
  const d = [];
  for (let t = 0; t < KINDS; t++) for (let k = 0; k < n[t]; k++) d.push(t);
  return shuffle(d);
}

const running = () => (solo() ? 1 : room.players.filter((p) => p.id === myId() || here.has(p.id)).length);
const startedAt = performance.now();
// Alone: nobody else in the room, or nobody else's disk has said hello in the
// time a disk that is running would have.
const alone = (now) => running() < 2 && (solo() || room.players.length < 2 || now - startedAt > HELLO_MS);
const practiceTable = () => S.g > 0 && S.ph !== 'wait' && S.seats.some((s) => isBot(s.id));
const canDeal = (now) => S.ph === 'wait' || (S.ph === 'over' && now - overAt >= DEAL_COOLDOWN);

// `force` deals over a game still running: the practice game somebody joined.
function hostDeal(force) {
  const now = performance.now();
  if (!amHost() || (!force && !canDeal(now))) return;
  joinEnd = 0;
  let ids = solo() ? [-1] : room.players.filter((p) => p.id === myId() || here.has(p.id)).slice(0, MAX_SEATS).map((p) => p.id);
  // Fewer than two people is a practice table: the host is dealt three bots.
  if (ids.length < 2) ids = ids.concat([-2, -3, -4]);
  S = blank();
  S.g = Math.floor(Math.random() * 1e9) + 1;
  S.seats = ids.map((id) => ({ id, box: emptyBox(), score: 0, gold: -1, mochi: 0, rs: [] }));
  shortAt = 0;
  startRound(now);
}

function startRound(now) {
  S.rd += 1;
  S.dir = S.rd === 2 ? -1 : 1;
  for (const s of S.seats) {
    s.box = emptyBox();
    s.gold = S.ng.includes(s.id) ? GOLD_SLOT : -1;
  }
  S.ng = [];
  const d = deck([]);
  hands.clear();
  for (const s of S.seats) hands.set(s.id, d.splice(0, HAND));
  S.pk = 0;
  startPick(now);
}

function startPick(now) {
  S.pk += 1;
  S.hk += 1;
  S.ph = 'pick';
  S.locked = [];
  S.last = null;
  picks.clear();
  dealt.clear();
  for (const s of S.seats) dealt.set(s.id, (hands.get(s.id) || []).slice());
  botAt.clear();
  for (const s of S.seats) if (isBot(s.id)) botAt.set(s.id, now + 1500 + Math.random() * (S.pk < 3 ? 6000 : 4000));
  endAt = now + PICK_MS;
  publish(now);
  sendTrays();
}

// A pick, from whoever the room says sent it. It counts only for the trays on
// the table, for a seated player who is here, for a dish still in that tray and
// an empty compartment of that box; it may be changed until the reveal.
function hostPick(id, i, s, now) {
  if (S.ph !== 'pick') return;
  const seat = seatOf(id);
  const h = hands.get(id);
  if (!seat || !h || !present(id) || i >= h.length || seat.box[s] !== -1) return;
  picks.set(id, { i, s });
  if (!S.locked.includes(id)) {
    S.locked.push(id);
    publish(now);
  }
}

// The best dish and compartment for a box, as near as a quick look tells: what
// it scores now, and a little for what it may score once the box fills. A
// bot looks with some noise and now and then just grabs something; a player
// whose clock ran out is given the plain best.
function bestPick(seat, h, noisy) {
  const empty = [];
  for (let i = 0; i < 9; i++) if (seat.box[i] < 0) empty.push(i);
  if (!empty.length || !h.length) return null;
  if (noisy && Math.random() < 0.12) {
    return { i: Math.floor(Math.random() * h.length), s: empty[Math.floor(Math.random() * empty.length)] };
  }
  const base = boxScore(seat.box, seat.gold);
  const left = empty.length;
  let best = null, bv = -1e9;
  const tried = new Set();
  h.forEach((t, i) => {
    if (tried.has(t)) return;
    tried.add(t);
    for (const s of empty) {
      const b = seat.box.slice();
      b[s] = t;
      let v = boxScore(b, seat.gold) - base;
      const open = NB[s].filter((j) => b[j] < 0).length;
      if (t === MOCHI) v += 1.4 + (S.rd === ROUNDS ? 0.8 : 0);
      else if (t === TEMPURA) v += 0.5 * open * Math.min(1, left / 5);
      else if (t === RICE) v += 0.35 * open;
      else if (t === TAMAGO) {
        let line = 0;
        for (let j = 0; j < 9; j++) if (b[j] < 0 && (Math.floor(j / 3) === Math.floor(s / 3) || j % 3 === s % 3)) line++;
        v += 0.55 * line * Math.min(1, left / 5);
      }
      if (noisy) v += Math.random() * 1.6;
      if (v > bv) { bv = v; best = { i, s }; }
    }
  });
  return best;
}

function reveal(now) {
  const list = [];
  for (const seat of S.seats) {
    const h = hands.get(seat.id) || [];
    if (!h.length) continue;
    let p = picks.get(seat.id);
    if (!p || p.i >= h.length || seat.box[p.s] !== -1) p = bestPick(seat, h, false);
    if (!p) continue;
    const t = h.splice(p.i, 1)[0];
    seat.box[p.s] = t;
    list.push([seat.id, t, p.s]);
  }
  S.last = list;
  S.ph = 'show';
  S.locked = [];
  picks.clear();
  botAt.clear();
  endAt = now + SHOW_MS;
  publish(now);
}

// The trays move on one seat, every seat's at once, the empty seats' too: a
// player who dropped out still has a tray, and the host picks from it for them.
function passTrays() {
  const n = S.seats.length;
  const old = S.seats.map((s) => hands.get(s.id) || []);
  S.seats.forEach((s, j) => hands.set(s.id, old[(j - S.dir + n) % n]));
}

function endRound(now) {
  for (const s of S.seats) {
    const pts = boxScore(s.box, s.gold);
    s.score += pts;
    s.rs.push(pts);
    s.mochi += mochiIn(s.box);
  }
  // Whoever trails gets the golden compartment next round, unless everybody
  // is level and nobody trails.
  S.ng = [];
  if (S.rd < ROUNDS) {
    const lo = Math.min(...S.seats.map((s) => s.score));
    const hi = Math.max(...S.seats.map((s) => s.score));
    if (lo < hi) S.ng = S.seats.filter((s) => s.score === lo).map((s) => s.id);
  }
  S.ph = 'score';
  S.locked = [];
  endAt = now + SCORE_MS;
  publish(now);
}

function finish(now) {
  // Mochi pays out once, at the end: the most saved shares six, the fewest
  // share a loss of three when there are at least three boxes to compare.
  S.mb = [];
  const ms = S.seats.map((s) => s.mochi);
  const hi = Math.max(...ms), lo = Math.min(...ms);
  const bonus = new Map();
  if (hi > 0) {
    const top = S.seats.filter((s) => s.mochi === hi);
    for (const s of top) bonus.set(s.id, Math.floor(6 / top.length));
  }
  if (S.seats.length >= 3 && lo < hi) {
    const low = S.seats.filter((s) => s.mochi === lo);
    for (const s of low) bonus.set(s.id, -Math.floor(3 / low.length));
  }
  for (const s of S.seats) {
    const b = bonus.get(s.id) || 0;
    if (b) { s.score += b; S.mb.push([s.id, b]); }
  }
  S.ph = 'over';
  S.locked = [];
  S.last = null;
  picks.clear();
  botAt.clear();
  endAt = now;
  overAt = now;
  publish(now);
}

// A table without enough people is over — but not on the instant: a dropped
// connection comes back as a leave and a join, and one blip must not end
// everybody's game.
function tooFew(now) {
  const people = S.seats.filter((s) => !isBot(s.id) && present(s.id)).length;
  if (people >= (practiceTable() ? 1 : 2)) { shortAt = 0; return false; }
  if (!shortAt) shortAt = now;
  return now - shortAt > GRACE;
}

function hostTick(now) {
  if (!amHost()) return;
  // Alone, a practice game is dealt at once, and the next when it is over.
  if (alone(now) && (S.ph === 'wait' || (S.ph === 'over' && now - overAt >= PRACTICE_AGAIN))) { hostDeal(); return; }
  // Two disks running and nothing dealt yet: the real game starts by itself.
  if (!alone(now) && running() >= 2 && S.ph === 'wait') { hostDeal(); return; }
  // Somebody joined a practice game: it ends three seconds on, for the real one.
  if (running() >= 2 && practiceTable()) {
    if (!joinEnd) { joinEnd = now + JOIN_MS; publish(now); }
    else if (now >= joinEnd) { hostDeal(true); return; }
  } else if (joinEnd) { joinEnd = 0; publish(now); }
  if (S.ph === 'pick' || S.ph === 'show') {
    if (tooFew(now)) { finish(now); return; }
  }
  if (S.ph === 'pick') {
    for (const [id, at] of botAt) {
      if (now < at) continue;
      botAt.delete(id);
      const seat = seatOf(id);
      const p = seat && bestPick(seat, hands.get(id) || [], true);
      if (p) hostPick(id, p.i, p.s, now);
    }
    // Only those here are waited for; a seat whose player dropped out is
    // picked for at the reveal.
    const waiting = S.seats.some((s) => present(s.id) && !S.locked.includes(s.id) && (hands.get(s.id) || []).length);
    if (now >= endAt || !waiting) { reveal(now); return; }
  } else if (S.ph === 'show' && now >= endAt) {
    if (S.pk >= HAND) endRound(now);
    else { passTrays(); startPick(now); }
    return;
  } else if (S.ph === 'score' && now >= endAt) {
    if (S.rd >= ROUNDS) finish(now);
    else startRound(now);
    return;
  }
  // A heartbeat, so one lost broadcast is never the only thing that carried a
  // change, and a clock that drifted is put back.
  if (S.g > 0 && now - lastPub > 2500) { publish(now); if (S.ph === 'pick') sendTrays(); }
}

function wire(now) {
  return {
    t: 'st', g: S.g, ph: S.ph, rd: S.rd, pk: S.pk, hk: S.hk, dir: S.dir,
    seats: S.seats.map((s) => [s.id, s.box, s.score, s.gold, s.mochi, s.rs]),
    locked: S.locked, last: S.last, ng: S.ng, mb: S.mb,
    ms: Math.max(0, Math.round(endAt - now)),
    j: joinEnd ? Math.max(0, Math.round(joinEnd - now)) : -1,
  };
}

function publish(now) {
  lastPub = now;
  if (!solo()) room.send(wire(now));
  observe(now);
}

// Each tray goes to its holder alone. A tray is the one hidden thing in this
// game, so it is never broadcast and never kept anywhere but the host.
function trayFor(id) {
  return { t: 'hd', g: S.g, hk: S.hk, h: (dealt.get(id) || []).slice() };
}
function sendTrays() {
  if (solo()) return;
  for (const s of S.seats) {
    if (isBot(s.id) || s.id === myId() || !inRoom(s.id)) continue;
    room.send(trayFor(s.id), { to: s.id });
  }
}

// ── receiving ───────────────────────────────────────────────────────────────

// A table off the wire is a claim and is read as one: the right shape, numbers
// in range, lists of bounded length. Anything else is dropped whole.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID_MIN = -8, ID_MAX = 2147483647;
const isDish = (v) => int(v, 0, KINDS - 1);

function stateOf(m) {
  if (!int(m.g, 1, 1e9) || !['pick', 'show', 'score', 'over'].includes(m.ph)) return null;
  if (!int(m.rd, 1, ROUNDS) || !int(m.pk, 0, HAND) || !int(m.hk, 0, 1e9) || !(m.dir === 1 || m.dir === -1)) return null;
  if (!Array.isArray(m.seats) || m.seats.length < 1 || m.seats.length > MAX_SEATS) return null;
  const seats = [];
  for (const r of m.seats) {
    if (!Array.isArray(r) || r.length !== 6) return null;
    const [id, box, score, gold, mochi, rs] = r;
    if (!int(id, ID_MIN, ID_MAX) || seats.some((s) => s.id === id)) return null;
    if (!Array.isArray(box) || box.length !== 9 || !box.every((t) => int(t, -1, KINDS - 1))) return null;
    if (!int(score, -999, 999) || !int(gold, -1, 8) || !int(mochi, 0, HAND * ROUNDS)) return null;
    if (!Array.isArray(rs) || rs.length > ROUNDS || !rs.every((v) => int(v, 0, 999))) return null;
    seats.push({ id, box: box.slice(), score, gold, mochi, rs: rs.slice() });
  }
  const seated = (id) => seats.some((s) => s.id === id);
  const ids = (a) => Array.isArray(a) && a.length <= MAX_SEATS && a.every((id) => int(id, ID_MIN, ID_MAX) && seated(id));
  if (!ids(m.locked) || !ids(m.ng)) return null;
  let last = null;
  if (m.last !== null && m.last !== undefined) {
    if (!Array.isArray(m.last) || m.last.length > MAX_SEATS) return null;
    last = [];
    for (const x of m.last) {
      if (!Array.isArray(x) || x.length !== 3 || !seated(x[0]) || !isDish(x[1]) || !int(x[2], 0, 8)) return null;
      last.push([x[0], x[1], x[2]]);
    }
  }
  if (!Array.isArray(m.mb) || m.mb.length > MAX_SEATS) return null;
  for (const x of m.mb) if (!Array.isArray(x) || x.length !== 2 || !seated(x[0]) || !int(x[1], -6, 6)) return null;
  if (typeof m.ms !== 'number' || !Number.isFinite(m.ms)) return null;
  const j = typeof m.j === 'number' && Number.isFinite(m.j) && m.j >= 0 ? Math.min(m.j, JOIN_MS) : -1;
  return {
    S: { g: m.g, ph: m.ph, rd: m.rd, pk: m.pk, hk: m.hk, dir: m.dir, seats, locked: m.locked.slice(), last, ng: m.ng.slice(), mb: m.mb.map((x) => x.slice()) },
    ms: Math.min(Math.max(m.ms, 0), PICK_MS + SCORE_MS),
    j,
  };
}

// Every sender gets a bucket: ten messages a second, twenty at once. An honest
// copy sends a few a pick; one that floods is dropped here before any of its
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

// A question that costs the host an answer is answered at most once a while
// per sender, so asking in a loop cannot spend the host's own sending.
const answered = new Map();
function cool(kind, from, now, ms) {
  const k = kind + ':' + from;
  if (now - (answered.get(k) || -1e9) < ms) return false;
  answered.set(k, now);
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
        if (amHost() && S.g > 0 && cool('hi', from, now, 1000)) {
          room.send(wire(now), { to: from });
          if (S.ph === 'pick' && seatOf(from)) room.send(trayFor(from), { to: from });
        }
        break;
      // A copy that has the table but not its tray asks for the tray again.
      case 'nh':
        if (inRoom(from)) here.add(from);
        if (amHost() && S.ph === 'pick' && msg.g === S.g && seatOf(from) && inRoom(from) && cool('nh', from, now, 700)) room.send(trayFor(from), { to: from });
        break;
      case 'pk':
        if (inRoom(from)) here.add(from);
        if (amHost() && msg.g === S.g && msg.hk === S.hk && int(msg.i, 0, HAND - 1) && int(msg.s, 0, 8)) {
          hostPick(from, msg.i, msg.s, now);
        }
        break;
      case 'go':
        if (amHost() && inRoom(from)) { here.add(from); hostDeal(); }
        break;
      case 'st': {
        if (amHost() || !fromHost(from)) break;
        const st = stateOf(msg);
        if (!st) break;
        S = st.S;
        gotState = true;
        // Whoever has a seat is running the disk, which a copy that is host
        // later needs to know to deal them in.
        for (const s of S.seats) if (!isBot(s.id) && s.id >= 0) here.add(s.id);
        endAt = now + st.ms;
        joinEnd = st.j >= 0 ? now + st.j : 0;
        observe(now);
        break;
      }
      case 'hd': {
        if (amHost() || !fromHost(from)) break;
        if (!int(msg.g, 1, 1e9) || !int(msg.hk, 0, 1e9)) break;
        if (!Array.isArray(msg.h) || msg.h.length > HAND || !msg.h.every(isDish)) break;
        myTray = { g: msg.g, hk: msg.hk, h: msg.h.slice() };
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
  // The trays and the picks went to the old host and left with it. The pick on
  // the table is dealt again: every tray as many dishes as it held, from what
  // is not in a box yet, on a fresh clock. Nobody loses a dish already placed.
  const now = performance.now();
  for (const s of S.seats) if (!isBot(s.id) && s.id >= 0) here.add(s.id);
  picks.clear();
  botAt.clear();
  if (S.ph === 'pick' || S.ph === 'show') {
    const done = S.seats.length ? filled(S.seats[0].box) : HAND;
    if (done >= HAND) { endRound(now); return; }
    const d = deck(S.seats.flatMap((s) => s.box));
    hands.clear();
    for (const s of S.seats) hands.set(s.id, d.splice(0, HAND - done));
    S.pk = done;
    // Far past any tray the old host may have sent that this copy never saw,
    // so no tray of the old host's is ever taken for one of these.
    S.hk += 100;
    startPick(now);
  } else {
    endAt = now + 2000;
    publish(now);
  }
});

// ── my moves ────────────────────────────────────────────────────────────────

// My tray for the pick on the table: the host reads its own, everyone else
// the one the host sent them.
function trayNow() {
  if (S.ph !== 'pick' && S.ph !== 'show') return null;
  if (!mySeat()) return null;
  let h = null;
  if (amHost()) h = dealt.get(myId()) || null;
  else if (myTray && myTray.g === S.g && myTray.hk === S.hk) h = myTray.h;
  if (!h) return null;
  return h;
}
const canPick = () => S.ph === 'pick' && !!mySeat() && !!trayNow() && trayNow().length > 0;
const pickNow = () => (myPick && myPick.g === S.g && myPick.hk === S.hk ? myPick : null);

function sendPick() {
  if (sendTimer) return;
  // At most four pick messages a second, the last pick always going out: a
  // player trying compartments is never cut off by the host's bucket.
  const wait = Math.max(0, lastSend + 250 - performance.now());
  sendTimer = setTimeout(() => {
    sendTimer = null;
    lastSend = performance.now();
    const p = pickNow();
    if (!p || !room.host || amHost()) return;
    room.send({ t: 'pk', g: p.g, hk: p.hk, i: p.i, s: p.s }, { to: room.host.id });
    sentKey = room.host.id + ':' + S.g + ':' + S.hk;
  }, wait);
}

function place(i, s) {
  const h = trayNow();
  const me = mySeat();
  if (!canPick() || !h || i < 0 || i >= h.length || !me || me.box[s] !== -1) return;
  const p = pickNow();
  if (p && p.i === i && p.s === s) return;
  myPick = { g: S.g, hk: S.hk, i, s };
  sel = i;
  slotCur = s;
  sfx.pick();
  const r = slotRects[s];
  if (r) burst(r.x + r.w / 2, r.y + r.h / 2, FOOD[h[i]], 8, 110);
  if (amHost()) hostPick(myId(), i, s, performance.now());
  else sendPick();
}

function deal() {
  const now = performance.now();
  if (!canDeal(now)) return;
  sfx.pick();
  if (amHost()) hostDeal();
  else if (room.host) room.send({ t: 'go' }, { to: room.host.id });
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects are drawn from the table as it changes on this screen, never sent.
let seenKey = '';
let seenHk = -1;
let seenLocked = new Set();
let scoreAt = -1e9, trayAt = -1e9;
const landed = new Map();   // 'id:slot' -> when the dish landed on this screen
const queue = [];           // effects waiting for their moment: { at, fn }
let lastReveal = null;

function observe(now) {
  const key = S.g + ':' + S.rd + ':' + S.pk + ':' + S.ph;
  if (key !== seenKey) {
    const was = seenKey;
    seenKey = key;
    if (S.ph === 'pick' && S.pk === 1) { sfx.round(); landed.clear(); }
    if (S.ph === 'show' && S.last) {
      lastReveal = S.last.map((x) => x.slice());
      lastReveal.forEach(([id, t, s], k) => {
        const at = now + 80 + k * 70;
        landed.set(id + ':' + s, at);
        queue.push({ at, fn: () => landFx(id, t, s) });
      });
    }
    if (S.ph === 'score') { scoreAt = now; queueScore(now); }
    if (S.ph === 'over') {
      overAt = now;
      if (was) celebrate();
    }
    seenLocked = new Set();
  }
  if (S.hk !== seenHk) {
    seenHk = S.hk;
    trayAt = now;
    sel = -1;
    drag = null;
    if (S.ph === 'pick' && S.pk > 1) sfx.pass();
  }
  if (myPick && (myPick.g !== S.g || myPick.hk !== S.hk)) myPick = null;
  // A soft click when somebody else's pick goes in; my own already had a sound.
  if (S.ph === 'pick' && S.locked.some((id) => id !== myId() && !seenLocked.has(id))) sfx.lock();
  seenLocked = new Set(S.locked);
  // A new host never saw my pick: send it again, once per host and pick.
  if (!amHost() && S.ph === 'pick' && pickNow() && room.host && !S.locked.includes(myId())) {
    if (sentKey !== room.host.id + ':' + S.g + ':' + S.hk) sendPick();
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
  pick: () => { tone(620, 0.07, 'triangle', 0.07); tone(930, 0.08, 'triangle', 0.05, null, 0.05); },
  grab: () => tone(480, 0.05, 'triangle', 0.05, 640),
  lock: () => tone(420, 0.06, 'square', 0.022),
  plop: (k) => tone(340 + k * 30, 0.12, 'sine', 0.08, 170 + k * 15),
  pass: () => { tone(260, 0.22, 'sine', 0.04, 520); tone(390, 0.18, 'triangle', 0.03, 780, 0.05); },
  point: (k) => tone(560 + Math.min(k, 14) * 45, 0.07, 'triangle', 0.05),
  zero: () => tone(170, 0.18, 'sawtooth', 0.05, 110),
  gold: () => [784, 1047, 1319].forEach((f, i) => tone(f, 0.2, 'sine', 0.05, null, i * 0.08)),
  round: () => { tone(196, 0.5, 'sine', 0.06, 190); tone(392, 0.35, 'triangle', 0.03, null, 0.02); },
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

let W = 640, H = 400, DPR = 1;
let coarse = matchMedia('(pointer: coarse)').matches;
let bgCache = null;
function layout() {
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  coarse = matchMedia('(pointer: coarse)').matches;
  W = cv.clientWidth || window.innerWidth || 640;
  H = cv.clientHeight || window.innerHeight || 400;
  cv.width = Math.round(W * DPR);
  cv.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  bgCache = null;
}
layout();
window.addEventListener('resize', layout);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); };
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
const sign = (v) => (v > 0 ? '+' + v : v < 0 ? '−' + -v : '0');

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
function pop(x, y, s, color, size) { if (pops.length < 60) pops.push({ x, y, s, color, t: 0, size: size || 20 }); }

// Where a seat's compartment was drawn last frame, for effects that land on it.
function cellCenter(id, s) {
  if (id === myId() && slotRects[s]) {
    const r = slotRects[s];
    return { x: r.x + r.w / 2, y: r.y + r.h / 2, big: true };
  }
  const m = miniRects.get(id);
  if (!m) return null;
  const c = m.gs / 3;
  return { x: m.gx + (s % 3 + 0.5) * c, y: m.gy + (Math.floor(s / 3) + 0.5) * c, big: false };
}

function landFx(id, t, s) {
  const p = cellCenter(id, s);
  if (!p) return;
  burst(p.x, p.y, FOOD[t], p.big ? 14 : 6, p.big ? 150 : 70);
  if (!p.big) return;
  sfx.plop(s);
  const seat = mySeat();
  if (!seat) return;
  // What this dish changed in my box, all of it: a salmon beside a salmon
  // takes the other's points away too, and that is shown.
  const before = seat.box.slice();
  before[s] = -1;
  const d = boxScore(seat.box, seat.gold) - boxScore(before, seat.gold);
  pop(p.x, p.y - 10, sign(d), d > 0 ? C.gold : d < 0 ? C.bad : C.dim, 24);
  if (d < 0) { shake = 7; sfx.zero(); }
  else if (d >= 4) shake = 3;
}

function queueScore(now) {
  const seat = mySeat();
  if (!seat) return;
  const pts = cellPoints(seat.box);
  let k = 0;
  for (let s = 0; s < 9; s++) {
    if (seat.box[s] < 0) continue;
    const v = pts[s] * (s === seat.gold ? 2 : 1);
    const kk = k++;
    queue.push({
      at: now + 400 + kk * 160,
      fn: () => {
        const p = cellCenter(myId(), s);
        if (!p) return;
        pop(p.x, p.y, v ? '+' + v : '0', v ? (s === seat.gold ? C.gold : C.text) : C.faint, 22);
        if (v) { sfx.point(kk); burst(p.x, p.y, FOOD[seat.box[s]], 6, 90); } else sfx.lock();
      },
    });
  }
  if (S.ng.length) queue.push({ at: now + 600 + k * 160, fn: () => sfx.gold() });
}

function celebrate() {
  sfx.fanfare();
  const top = standings()[0];
  const color = top ? colorOf(top.id) : C.gold;
  for (let i = 0; i < 5; i++) burst(W * (0.15 + 0.7 * Math.random()), H * (0.25 + 0.3 * Math.random()), i % 2 ? color : C.gold, 22, 260);
}

// Particles and pops move by the elapsed time, not by the frame, so a slow or
// fast screen shows the same motion.
function stepFx(dt, now) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (now >= queue[i].at) { const q = queue.splice(i, 1)[0]; if (now - q.at < 800) q.fn(); }
  }
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
    if (pops[i].t > 1.2) pops.splice(i, 1);
  }
  shake = Math.max(0, shake - 30 * dt);
}

function standings() {
  return S.seats.slice().sort((a, b) => b.score - a.score || b.mochi - a.mochi);
}

// ── drawing pieces ──────────────────────────────────────────────────────────

// Lacquer with a faint wave pattern, drawn once per size into a canvas of its own.
function drawBackground() {
  if (!bgCache) {
    bgCache = document.createElement('canvas');
    bgCache.width = cv.width;
    bgCache.height = cv.height;
    const b = bgCache.getContext('2d');
    b.setTransform(DPR, 0, 0, DPR, 0, 0);
    const g = b.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.5, Math.max(W, H) * 0.8);
    g.addColorStop(0, C.bg0);
    g.addColorStop(1, C.bg1);
    b.fillStyle = g;
    b.fillRect(0, 0, W, H);
    b.strokeStyle = 'rgba(255,190,160,0.045)';
    b.lineWidth = 1.2;
    const R = 22;
    for (let row = 0, y = 0; y < H + R; row++, y += R * 0.55) {
      for (let x = (row % 2) * R - R; x < W + R; x += R * 2) {
        for (let k = 1; k <= 3; k++) {
          b.beginPath();
          b.arc(x, y, R * k / 3, Math.PI, 0);
          b.stroke();
        }
      }
    }
  }
  ctx.drawImage(bgCache, 0, 0, W, H);
}

// A dish, drawn flat on a box of `s` centred on (x, y).
function drawFood(t, x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 100, s / 100);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (t === RICE) {
    ctx.fillStyle = '#fdfaf2';
    ctx.beginPath();
    ctx.moveTo(0, -38);
    ctx.quadraticCurveTo(12, -38, 40, 16);
    ctx.quadraticCurveTo(48, 34, 28, 34);
    ctx.lineTo(-28, 34);
    ctx.quadraticCurveTo(-48, 34, -40, 16);
    ctx.quadraticCurveTo(-12, -38, 0, -38);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = C.nori;
    rr(-17, 6, 34, 28, 4);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(-14, -6, 2.4, 0, 7); ctx.arc(10, -14, 2.4, 0, 7); ctx.arc(20, 0, 2.4, 0, 7); ctx.fill();
  } else if (t === SALMON) {
    ctx.fillStyle = '#fdfaf2';
    rr(-36, 0, 72, 28, 13);
    ctx.fill();
    ctx.fillStyle = '#ff8a5c';
    ctx.beginPath();
    ctx.moveTo(-44, 2);
    ctx.quadraticCurveTo(-34, -30, 8, -28);
    ctx.quadraticCurveTo(46, -26, 46, -2);
    ctx.quadraticCurveTo(46, 10, 30, 10);
    ctx.lineTo(-34, 10);
    ctx.quadraticCurveTo(-48, 10, -44, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,238,224,0.85)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) { ctx.moveTo(-22 + k * 17, -20); ctx.lineTo(-30 + k * 17, 4); }
    ctx.stroke();
  } else if (t === TEMPURA) {
    ctx.strokeStyle = '#a5651a';
    ctx.lineWidth = 32;
    ctx.beginPath(); ctx.arc(-2, 18, 30, Math.PI * 1.05, Math.PI * 1.9); ctx.stroke();
    ctx.strokeStyle = '#efb34c';
    ctx.lineWidth = 25;
    ctx.beginPath(); ctx.arc(-2, 18, 30, Math.PI * 1.05, Math.PI * 1.9); ctx.stroke();
    ctx.fillStyle = 'rgba(165,101,26,0.75)';
    ctx.beginPath();
    for (let k = 0; k < 7; k++) {
      const a = Math.PI * (1.12 + k * 0.11), r = 30 + ((k % 3) - 1) * 7;
      ctx.moveTo(-2 + Math.cos(a) * r + 2.6, 18 + Math.sin(a) * r);
      ctx.arc(-2 + Math.cos(a) * r, 18 + Math.sin(a) * r, 2.6, 0, 7);
    }
    ctx.fill();
    ctx.fillStyle = '#ff6b4a';
    ctx.beginPath(); ctx.moveTo(22, 2); ctx.lineTo(44, -14); ctx.lineTo(40, 6); ctx.lineTo(46, 22); ctx.closePath(); ctx.fill();
  } else if (t === PICKLE) {
    for (const [cx, cy, r] of [[-13, 8, 25], [15, -8, 23]]) {
      ctx.fillStyle = '#4f9a45';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
      ctx.fillStyle = '#c9ecb2';
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.74, 0, 7); ctx.fill();
      ctx.fillStyle = '#8fc977';
      ctx.beginPath();
      for (let k = 0; k < 5; k++) {
        const a = k * 1.2566 + 0.3;
        ctx.moveTo(cx + Math.cos(a) * r * 0.36 + 2.6, cy + Math.sin(a) * r * 0.36);
        ctx.arc(cx + Math.cos(a) * r * 0.36, cy + Math.sin(a) * r * 0.36, 2.6, 0, 7);
      }
      ctx.fill();
    }
  } else if (t === TAMAGO) {
    ctx.fillStyle = '#ffd84d';
    rr(-38, -24, 76, 48, 9);
    ctx.fill();
    ctx.strokeStyle = '#e9b22c';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-34, -9); ctx.lineTo(34, -9); ctx.moveTo(-34, 6); ctx.lineTo(34, 6); ctx.stroke();
    ctx.fillStyle = C.nori;
    rr(-9, -28, 18, 56, 3);
    ctx.fill();
  } else if (t === MOCHI) {
    ctx.strokeStyle = '#c9a26a';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(-40, 40); ctx.lineTo(38, -38); ctx.stroke();
    const balls = [[-19, 19, '#9bd67a'], [0, 0, '#fdf5ec'], [19, -19, '#ff9ec7']];
    for (const [bx, by, col] of balls) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(bx, by, 16, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.arc(bx - 5, by - 6, 4.5, 0, 7); ctx.fill();
    }
  }
  ctx.restore();
}

function drawCard(x, y, w, h, t, o) {
  ctx.save();
  ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  ctx.translate(x + w / 2, y + h / 2);
  if (o.rot) ctx.rotate(o.rot);
  if (o.glow) { ctx.shadowColor = o.glow; ctx.shadowBlur = 16; }
  else { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2; }
  rr(-w / 2, -h / 2, w, h, w * 0.14);
  ctx.fillStyle = C.card;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.save();
  rr(-w / 2, -h / 2, w, h, w * 0.14);
  ctx.clip();
  ctx.fillStyle = FOOD[t];
  ctx.fillRect(-w / 2, -h / 2, w, h * 0.12);
  ctx.restore();
  drawFood(t, 0, -h * 0.06, w * 0.72);
  if (w >= 40) text(NAME[t], 0, h * 0.3, Math.min(13, w * 0.2), C.cardInk, 'center', 800, w - 6);
  if (w >= 52 && h >= 70) text(SHORT[t], 0, h * 0.42, Math.min(10, w * 0.16), '#8a6a5e', 'center', 600, w - 6);
  if (o.ring) {
    rr(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6, w * 0.18);
    ctx.strokeStyle = o.ring;
    ctx.lineWidth = 2;
    ctx.stroke();
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
  ctx.strokeStyle = muted ? C.bad : C.dim;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (muted) { ctx.moveTo(x + 19, y + 11); ctx.lineTo(x + 25, y + 19); ctx.moveTo(x + 25, y + 11); ctx.lineTo(x + 19, y + 19); }
  else { ctx.arc(x + 17, y + 15, 5, -0.9, 0.9); ctx.moveTo(x + 23.5, y + 9.5); ctx.arc(x + 17, y + 15, 8.5, -0.85, 0.85); }
  ctx.stroke();
  ctx.restore();
  btns.push({ id: 'mute', x: x - 6, y: y - 6, w: s + 12, h: s + 12 });
}

// ── layout of the table ─────────────────────────────────────────────────────

const PAD = 12;
const NOTE_ROOM = 60;
let btns = [];
let press = '';
let slotRects = [];            // my compartments as drawn this frame
const miniRects = new Map();   // seat id -> where its small box was drawn
let cardRects = [];            // my tray as drawn this frame, by index
let hoverSlot = -1;
let hoverCard = -1;
let drag = null;               // { i, x0, y0, x, y, moved }

// The small boxes of the other seats, fitted into a region: as many columns as
// give each the biggest grid.
function fitMinis(x, y, w, h, k) {
  let best = null;
  for (let cols = 1; cols <= k; cols++) {
    const rows = Math.ceil(k / cols);
    const cw = (w - (cols - 1) * 8) / cols;
    const ch = (h - (rows - 1) * 6) / rows;
    const gs = Math.min(cw - 10, ch - 34, 62);
    if (!best || gs > best.gs) best = { cols, rows, cw: Math.min(cw, 110), gs };
  }
  best.gs = Math.max(18, best.gs);
  const bh = best.gs + 34;
  const out = [];
  for (let i = 0; i < k; i++) {
    const row = Math.floor(i / best.cols);
    const inRow = row === best.rows - 1 ? k - row * best.cols : best.cols;
    const col = i - row * best.cols;
    const rowW = inRow * best.cw + (inRow - 1) * 8;
    out.push({ x: x + (w - rowW) / 2 + col * (best.cw + 8), y: y + row * (bh + 6), w: best.cw, h: bh, gs: best.gs });
  }
  return { rects: out, h: best.rows * (bh + 6) - 6 };
}

function lay() {
  const top = 44;
  const me = mySeat();
  const others = me ? S.seats.filter((s) => s.id !== myId()) : S.seats.slice();
  const note = practiceTable() ? NOTE_ROOM : 0;
  const L = { top, others, me, wide: W >= H * 1.2 && W >= 520 };
  if (L.wide) {
    // Wide: the other boxes on the left, mine in the middle, my tray on the right.
    const ah = H - top - 30;
    L.cw = clamp(Math.min((ah - 12) / 3 / 1.3, (W * 0.3 - 12) / 3), 30, 74);
    L.ch = L.cw * 1.3;
    L.handCols = 3;
    const handW = 3 * L.cw + 12;
    L.bs = clamp(Math.min(ah - 30 - note, W - handW - 2 * PAD - 150, 360), 120, 360);
    const restW = W - 2 * PAD - handW - L.bs - 32;
    const bx = PAD + restW + 16;
    L.box = { x: bx, y: top + 26 + Math.max(0, (ah - 30 - note - L.bs) / 2), s: L.bs };
    L.hand = { x: bx + L.bs + 16, y: top + Math.max(0, (ah - (3 * L.ch + 12)) / 2), cols: 3 };
    L.minis = fitMinis(PAD, top, restW, ah, Math.max(1, others.length)).rects;
    L.handTop = L.hand.y;
    L.handBottom = L.hand.y + 3 * L.ch + 12;
    L.foot = H - 30;
  } else {
    // Tall: the other boxes along the top, mine in the middle, my tray below.
    const k = Math.max(1, others.length);
    const fm = fitMinis(PAD, top, W - 2 * PAD, Math.min(H * 0.24, 200), k);
    L.minis = fm.rects;
    const stripBottom = top + (others.length ? fm.h : 0) + 8;
    let perRow = 9;
    let cw = (W - 2 * PAD - 8 * 6) / 9;
    if (cw < 46) { perRow = 5; cw = (W - 2 * PAD - 4 * 6) / 5; }
    L.cw = Math.min(cw, 68, H * 0.11);
    L.ch = L.cw * 1.3;
    L.handCols = perRow;
    const rows = Math.ceil(HAND / perRow);
    const handH = rows * L.ch + (rows - 1) * 6;
    L.handTop = H - 26 - handH;
    L.handBottom = H - 26;
    L.hand = { x: 0, y: L.handTop, cols: perRow };
    const avail = L.handTop - stripBottom - 26 - 10 - note;
    L.bs = clamp(Math.min(avail, W - 2 * PAD, 360), 90, 360);
    L.box = { x: (W - L.bs) / 2, y: stripBottom + 26 + Math.max(0, (avail - L.bs) / 2), s: L.bs };
    L.foot = L.handTop - 4;
  }
  return L;
}

// Where each dish of a tray of `n` sits.
function trayRects(L, n) {
  const out = [];
  const g = 6;
  if (L.wide) {
    for (let i = 0; i < n; i++) {
      out.push({ x: L.hand.x + (i % 3) * (L.cw + g), y: L.hand.y + Math.floor(i / 3) * (L.ch + g), w: L.cw, h: L.ch });
    }
    return out;
  }
  const per = L.handCols;
  const rows = Math.ceil(n / per);
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / per);
    const inRow = row === rows - 1 ? n - row * per : per;
    const col = i - row * per;
    const rowW = inRow * L.cw + (inRow - 1) * g;
    out.push({ x: (W - rowW) / 2 + col * (L.cw + g), y: L.handBottom - (rows - row) * (L.ch + g) + g, w: L.cw, h: L.ch });
  }
  return out;
}

// ── the frame ───────────────────────────────────────────────────────────────

let prevNow = performance.now();
let lastTickSec = -1;

function frame(now) {
  try {
    const dt = clamp((now - prevNow) / 1000, 0, 0.1);
    prevNow = now;
    stepFx(dt, now);
    btns = [];
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    drawBackground();
    if (S.g === 0 || S.ph === 'wait') drawLobby(now);
    else drawTable(now);
    for (const p of parts) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
    }
    ctx.globalAlpha = 1;
    for (const p of pops) {
      const k = p.t / 1.2;
      ctx.save();
      ctx.globalAlpha = 1 - k * k;
      const s = 1 + 0.4 * (1 - easeOut(p.t * 4));
      ctx.translate(p.x, p.y - 36 * easeOut(k));
      ctx.scale(s, s);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(20,8,10,0.85)';
      font(p.size, 900);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeText(p.s, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.s, 0, 0);
      ctx.restore();
    }
    ctx.restore();
    drawMute();
  } catch (e) {
    // One bad frame must not stop every frame after it.
  }
  requestAnimationFrame(frame);
}

function drawLobby(now) {
  const pw = Math.min(W - 2 * PAD, 420);
  const ph = Math.min(H - 24, 300);
  const x = (W - pw) / 2, y = (H - ph) / 2;
  rr(x, y, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const bob = Math.sin(now / 600) * 3;
  const fs = Math.min(46, ph * 0.16);
  [SALMON, TEMPURA, RICE, PICKLE, MOCHI].forEach((t, i) => drawFood(t, x + pw / 2 + (i - 2) * fs * 1.1, y + 20 + fs / 2 + (i % 2 ? bob : -bob), fs));
  text('BENTO', x + pw / 2, y + fs + 46, 28, C.text, 'center', 900);
  const lines = [
    'Take one dish from your tray, pack it into your box,',
    'pass the rest on. Every dish scores by where it sits.',
  ];
  lines.forEach((l, i) => text(l, x + pw / 2, y + fs + 78 + i * 20, 14, C.dim, 'center', 500, pw - 28));
  const n = solo() ? 1 : running();
  const quiet = !solo() && !amHost() && !gotState && now - startedAt > HELLO_MS + 2000;
  const status = quiet ? 'Waiting for the host (' + (room.host ? clip(room.host.nick, 13, 140) : 'nobody') + ') to run the disk…'
    : !solo() && !amHost() && !gotState ? 'Looking for the table…'
    : n >= 2 ? 'Packing the trays for ' + n + ' players…' : 'Setting up a practice table…';
  text(status, x + pw / 2, y + ph - 30, 13, C.faint, 'center', 500, pw - 28);
}

// The small box of another seat: its dishes, its score, whether its pick is in.
function drawMini(s, r, now, L, myIdx) {
  const i = seatIndex(s.id);
  const col = PAL[i % PAL.length];
  const on = present(s.id);
  ctx.save();
  if (!on) ctx.globalAlpha = 0.45;
  rr(r.x, r.y, r.w, r.h, 10);
  ctx.fillStyle = alpha(col, 0.1);
  ctx.fill();
  ctx.strokeStyle = alpha(col, 0.55);
  ctx.lineWidth = 1.2;
  ctx.stroke();
  const name = nickOf(s.id);
  const live = boxScore(s.box, s.gold);
  const shownScore = S.ph === 'score' || S.ph === 'over' ? s.score : s.score + live;
  text(clip(name, 11, r.w - 34), r.x + 7, r.y + 11, 11, C.text, 'left', 600);
  text(String(shownScore), r.x + r.w - 7, r.y + 11, 12, col, 'right', 800);
  const gs = r.gs, gx = r.x + (r.w - gs) / 2, gy = r.y + 20;
  miniRects.set(s.id, { gx, gy, gs });
  rr(gx - 2, gy - 2, gs + 4, gs + 4, 5);
  ctx.fillStyle = C.lacquer;
  ctx.fill();
  const c = gs / 3;
  for (let k = 0; k < 9; k++) {
    const cx = gx + (k % 3) * c, cy = gy + Math.floor(k / 3) * c;
    rr(cx + 1, cy + 1, c - 2, c - 2, 3);
    ctx.fillStyle = k === s.gold ? '#7a5a1a' : C.well;
    ctx.fill();
    const t = s.box[k];
    if (t < 0) continue;
    const at = landed.get(s.id + ':' + k);
    const kk = at === undefined ? 1 : back((now - at) / 320);
    if (kk <= 0.02) continue;
    if (c >= 14) drawFood(t, cx + c / 2, cy + c / 2, (c - 2) * kk);
    else { ctx.fillStyle = FOOD[t]; rr(cx + c * 0.2, cy + c * 0.2, c * 0.6 * kk, c * 0.6 * kk, 2); ctx.fill(); }
  }
  // The pick is in: a tick on the corner of the box.
  if (S.ph === 'pick' && S.locked.includes(s.id)) {
    const bx = gx + gs - 2, by = gy + 2;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(bx, by, 7, 0, 7); ctx.fill();
    ctx.strokeStyle = C.bg1;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx - 3.5, by); ctx.lineTo(bx - 1, by + 2.5); ctx.lineTo(bx + 3.5, by - 2.5); ctx.stroke();
  }
  ctx.restore();
  // Who hands me my next tray, and who gets mine.
  if (myIdx >= 0 && S.seats.length > 2) {
    const n = S.seats.length;
    const from = S.seats[(myIdx - S.dir + n) % n].id, to = S.seats[(myIdx + S.dir) % n].id;
    const tag = s.id === from ? 'passes to you' : s.id === to ? 'gets your tray' : '';
    if (tag) text(tag, r.x + r.w / 2, r.y + r.h - 6, 9, C.faint, 'center', 600, r.w - 4);
  } else if (myIdx >= 0) {
    text('trades trays with you', r.x + r.w / 2, r.y + r.h - 6, 9, C.faint, 'center', 600, r.w - 4);
  }
}

function drawBox(L, now, seat, tray, p) {
  const { x, y, s } = L.box;
  const pad = s * 0.045;
  const c = (s - pad * 2) / 3;
  // The lacquer box: black outside, red inside.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  rr(x, y, s, s, s * 0.06);
  ctx.fillStyle = C.lacquer;
  ctx.fill();
  ctx.restore();
  rr(x + 1, y + 1, s - 2, s - 2, s * 0.06);
  ctx.strokeStyle = alpha(colorOf(myId()), 0.7);
  ctx.lineWidth = 2;
  ctx.stroke();
  const pts = cellPoints(seat.box);
  const holding = drag ? drag.i : sel;
  const preview = canPick() && tray && holding >= 0 && holding < tray.length ? tray[holding] : -1;
  const base = preview >= 0 ? boxScore(seat.box, seat.gold) : 0;
  slotRects = [];
  for (let k = 0; k < 9; k++) {
    const cx = x + pad + (k % 3) * c, cy = y + pad + Math.floor(k / 3) * c;
    const r = { x: cx + 3, y: cy + 3, w: c - 6, h: c - 6 };
    slotRects.push(r);
    const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    g.addColorStop(0, C.redDeep);
    g.addColorStop(1, k === hoverSlot && preview >= 0 && seat.box[k] < 0 ? C.wellHi : C.well);
    rr(r.x, r.y, r.w, r.h, c * 0.1);
    ctx.fillStyle = g;
    ctx.fill();
    if (k === seat.gold) {
      ctx.save();
      ctx.shadowColor = C.gold;
      ctx.shadowBlur = 10 + 4 * Math.sin(now / 300);
      ctx.strokeStyle = C.gold;
      ctx.lineWidth = 2.5;
      rr(r.x + 1, r.y + 1, r.w - 2, r.h - 2, c * 0.1);
      ctx.stroke();
      ctx.restore();
      text('×2', r.x + r.w - 6, r.y + 11, Math.min(13, c * 0.16), C.gold, 'right', 900);
    }
    if (!coarse && k === slotCur && canPick() && seat.box[k] < 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      rr(r.x + 4, r.y + 4, r.w - 8, r.h - 8, c * 0.08);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const t = seat.box[k];
    if (t >= 0) {
      const at = landed.get(myId() + ':' + k);
      const kk = at === undefined ? 1 : back((now - at) / 340);
      if (kk > 0.02) drawFood(t, r.x + r.w / 2, r.y + r.h / 2, r.w * 0.78 * kk);
      const v = pts[k] * (k === seat.gold ? 2 : 1);
      // What this dish is worth where it is, in the corner of its compartment.
      const bs = Math.max(14, c * 0.2);
      ctx.fillStyle = v ? 'rgba(20,8,10,0.75)' : 'rgba(20,8,10,0.5)';
      ctx.beginPath(); ctx.arc(r.x + bs * 0.65, r.y + bs * 0.65, bs / 2, 0, 7); ctx.fill();
      text(String(v), r.x + bs * 0.65, r.y + bs * 0.68, bs * 0.62, v ? C.gold : C.faint, 'center', 800);
    } else if (p && p.s === k && tray && p.i < tray.length) {
      // My pick, waiting for the reveal: the dish shown faint where it will go.
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.15 * Math.sin(now / 200);
      drawFood(tray[p.i], r.x + r.w / 2, r.y + r.h / 2, r.w * 0.72);
      ctx.restore();
      ctx.strokeStyle = C.gold;
      ctx.lineWidth = 2;
      rr(r.x + 2, r.y + 2, r.w - 4, r.h - 4, c * 0.09);
      ctx.stroke();
    } else if (preview >= 0) {
      const b = seat.box.slice();
      b[k] = preview;
      const d = boxScore(b, seat.gold) - base;
      text(sign(d), r.x + r.w / 2, r.y + r.h / 2, Math.min(22, c * 0.28), d > 0 ? 'rgba(255,207,90,0.8)' : d < 0 ? 'rgba(255,93,108,0.8)' : 'rgba(255,255,255,0.3)', 'center', 800);
    }
  }
}

function drawTable(now) {
  const L = lay();
  const me = L.me;
  const myIdx = seatIndex(myId());
  const tray = trayNow();
  const p = pickNow();
  const left = Math.max(0, endAt - now);
  miniRects.clear();

  // The status line: where in the game we are, and the clock.
  const title = 'BENTO';
  text(title, PAD, 21, 16, C.text, 'left', 900);
  font(16, 900);
  const hw = ctx.measureText(title).width;
  const arrow = S.dir > 0 ? 'trays pass →' : '← trays pass';
  const phase = S.ph === 'score' ? 'round ' + S.rd + ' scored' : S.ph === 'over' ? 'game over' : 'round ' + S.rd + '/' + ROUNDS + ' · pick ' + S.pk + '/' + HAND + ' · ' + arrow;
  const status = (practiceTable() ? 'practice · ' : '') + phase;
  text(status, PAD + hw + 10, 21, 12, practiceTable() ? '#ffd166' : C.dim, 'left', 600, W - PAD * 2 - hw - 60);
  if (S.ph === 'pick') {
    const frac = clamp(left / PICK_MS, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(PAD, 38, W - 2 * PAD, 3);
    ctx.fillStyle = left < 5000 ? C.bad : C.gold;
    ctx.fillRect(PAD, 38, (W - 2 * PAD) * frac, 3);
    const sec = Math.ceil(left / 1000);
    if (sec <= 3 && sec > 0 && sec !== lastTickSec && me && !p) sfx.tick();
    lastTickSec = sec;
  }

  // Everybody else.
  L.others.forEach((s, i) => { if (L.minis[i]) drawMini(s, L.minis[i], now, L, myIdx); });

  if (!me) {
    text('You are watching. You get a seat on the next deal.', W / 2, L.box.y + L.box.s / 2, 14, C.dim, 'center', 600, W - 2 * PAD);
    slotRects = [];
    cardRects = [];
  } else {
    // My box, and above it what it is worth.
    const live = boxScore(me.box, me.gold);
    const total = S.ph === 'score' || S.ph === 'over' ? me.score : me.score + live;
    const cy = L.box.y - 14;
    text('your box ' + live, L.box.x, cy, 13, C.text, 'left', 800);
    text('total ' + total + (me.mochi + mochiIn(me.box) ? '  ·  mochi ' + (S.ph === 'score' || S.ph === 'over' ? me.mochi : me.mochi + mochiIn(me.box)) : ''), L.box.x + L.box.s, cy, 12, colorOf(myId()), 'right', 700);
    drawBox(L, now, me, tray, p);
    drawTray(L, now, tray, p);
  }

  if (S.ph === 'score') drawScored(L, now);

  // One line of how-to, always on screen.
  const holding = drag ? drag.i : sel;
  let how;
  if (S.ph === 'pick' && me && tray && holding >= 0 && holding < tray.length) how = RULE[tray[holding]];
  else if (S.ph === 'pick' && me) how = p ? 'Picked. You can change it until every pick is in.'
    : coarse ? 'Drag a dish from your tray into your box. Tap one to read its rule.'
    : 'Drag a dish into your box · or 1-9 to hold one, Q W E / A S D / Z X C to place it';
  else if (S.ph === 'show') how = 'Every pick turns over at once, then the trays move on.';
  else if (S.ph === 'score') how = S.rd < ROUNDS ? 'Next round in ' + Math.ceil(left / 1000) + ' · boxes start empty again' : 'Mochi pays out next';
  else how = '';
  if (how) text(how, W / 2, H - 13, 12, C.faint, 'center', 500, W - 2 * PAD);

  if (S.ph === 'over') drawOver(now);
  if (practiceTable()) {
    const head = joinEnd ? joinHead(Math.max(1, Math.ceil((joinEnd - now) / 1000)))
      : 'practice with bots · a game starts when someone joins';
    const tip = joinEnd ? null : 'salmon apart, tempura together, pickles in corners';
    // The room kept under my box holds it: across the screen when the box
    // stands alone in its row, centred on the box when columns flank it.
    const span = L.wide ? Math.min(W, L.box.s + 80) : W;
    practiceNote(now, span, head, tip, [], L.box.y + L.box.s + NOTE_ROOM - 4, L.box.x + L.box.s / 2 - span / 2);
  }
}

function drawTray(L, now, tray, p) {
  cardRects = [];
  if (!tray || S.ph === 'score' || S.ph === 'over') return;
  const list = tray.map((t, i) => ({ t, i }));
  // Once the picks turn over, my dish has left the tray: the one I held, or
  // the first of its kind when the host picked for me.
  const mine = S.ph === 'show' && lastReveal ? lastReveal.find((x) => x[0] === myId()) : null;
  if (mine) {
    const k = p && tray[p.i] === mine[1] ? list.findIndex((x) => x.i === p.i) : list.findIndex((x) => x.t === mine[1]);
    if (k >= 0) list.splice(k, 1);
  }
  const rects = trayRects(L, list.length);
  // A tray that has just been passed slides in from the side it came from.
  const from = S.dir > 0 ? -1 : 1;
  list.forEach((x, k) => {
    const r = rects[k];
    const e = easeOut((now - trayAt - k * 45) / 380);
    const ox = (1 - e) * from * W * 0.7;
    const picked = p && p.i === x.i;
    const held = (drag && drag.i === x.i) || sel === x.i;
    const lift = picked ? 10 : held || (hoverCard === x.i && canPick()) ? 5 : 0;
    const rr2 = { x: r.x + ox, y: r.y - lift, w: r.w, h: r.h };
    cardRects[x.i] = rr2;
    if (drag && drag.i === x.i && drag.moved) {
      drawCard(rr2.x, rr2.y, r.w, r.h, x.t, { alpha: 0.25 });
      return;
    }
    drawCard(rr2.x, rr2.y, r.w, r.h, x.t, {
      alpha: S.ph === 'pick' ? (picked ? 1 : p ? 0.75 : 1) : 0.5,
      glow: picked ? C.gold : null,
      ring: held && !picked ? 'rgba(255,255,255,0.7)' : null,
    });
  });
  if (drag && drag.moved && tray[drag.i] !== undefined) {
    const r = { w: L.cw, h: L.ch };
    drawCard(drag.x - r.w / 2, drag.y - r.h * 0.6, r.w, r.h, tray[drag.i], { glow: hoverSlot >= 0 ? C.gold : 'rgba(255,255,255,0.4)', rot: (drag.x - drag.x0) * 0.0015 });
  }
}

// A scored round: where the tray was, everybody's box total and the running score.
function drawScored(L, now) {
  const list = standings();
  const k = easeOut((now - scoreAt) / 400);
  const pw = L.wide ? Math.min(3 * L.cw + 12 + 40, W - L.hand.x + 20 - PAD) : Math.min(W - 2 * PAD, 420);
  const y0 = L.wide ? L.top + 8 : L.box.y + L.box.s + 8;
  const room0 = (L.wide ? H - 40 : H - 30) - y0;
  const rowH = clamp((room0 - 40 - (S.ng.length ? 22 : 0)) / Math.max(1, list.length), 15, 22);
  const ph = 40 + list.length * rowH + (S.ng.length ? 22 : 0);
  const x = L.wide ? W - PAD - pw : (W - pw) / 2;
  const y = L.wide ? y0 : Math.max(y0, H - 30 - ph);
  ctx.save();
  ctx.globalAlpha = k;
  rr(x, y + (1 - k) * 20, pw, ph, 14);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  const top = list[0];
  text('Round ' + S.rd + (top ? ' · ' + nameOf(top.id) + ' leads' : ''), x + pw / 2, y + 18, 14, top ? colorOf(top.id) : C.text, 'center', 800, pw - 20);
  list.forEach((s, i) => {
    const yy = y + 42 + i * rowH;
    ctx.fillStyle = colorOf(s.id);
    ctx.beginPath(); ctx.arc(x + 16, yy, 5, 0, 7); ctx.fill();
    text(clip(nameOf(s.id), 12, pw - 130), x + 28, yy, 12, C.text, 'left', 600);
    text('+' + (s.rs[s.rs.length - 1] || 0), x + pw - 58, yy, 12, C.dim, 'right', 700);
    text(String(s.score), x + pw - 14, yy, 14, C.gold, 'right', 800);
  });
  if (S.ng.length) {
    const who = S.ng.map((id) => nickOf(id)).join(', ');
    text('golden middle ×2 next round: ' + who, x + pw / 2, y + ph - 14, 11, C.gold, 'center', 700, pw - 20);
  }
  ctx.restore();
}

function drawOver(now) {
  const k = easeOut((now - overAt) / 500);
  ctx.fillStyle = 'rgba(14,6,8,' + 0.6 * k + ')';
  ctx.fillRect(0, 0, W, H);
  const list = standings();
  const pw = Math.min(W - 2 * PAD, 420);
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
  const winners = top ? list.filter((s) => s.score === top.score && s.mochi === top.mochi) : [];
  const title = !winners.length ? 'Game over'
    : winners.length > 1 ? 'A tie at ' + top.score
    : nameOf(top.id) + ' wins';
  text(title, x + pw / 2, y + 32, 24, winners.length === 1 ? colorOf(top.id) : C.text, 'center', 900, pw - 28);
  text('rounds', x + pw - 150, y + 58, 10, C.faint, 'center', 600);
  text('mochi', x + pw - 78, y + 58, 10, C.faint, 'center', 600);
  list.forEach((s, i) => {
    const yy = y + 80 + i * rowH;
    if (yy > y + ph - 70) return;
    ctx.fillStyle = colorOf(s.id);
    ctx.beginPath(); ctx.arc(x + 24, yy, 6, 0, Math.PI * 2); ctx.fill();
    text((i + 1) + '. ' + clip(nickOf(s.id), 14, pw - 220), x + 38, yy, 14, C.text, 'left', 600);
    text(s.rs.join(' · ') || '-', x + pw - 150, yy, 11, C.dim, 'center', 600, 80);
    const mb = S.mb.find((m) => m[0] === s.id);
    text(s.mochi + (mb ? ' (' + sign(mb[1]) + ')' : ''), x + pw - 78, yy, 11, mb ? (mb[1] > 0 ? C.gold : C.bad) : C.dim, 'center', 700, 60);
    text(String(s.score), x + pw - 18, yy, 16, C.gold, 'right', 800);
  });
  const ready = now - overAt >= DEAL_COOLDOWN;
  const people = solo() ? 1 : running();
  button('deal', people >= 2 ? 'Deal again' : 'Practice again', x + pw / 2 - 90, y + ph - 58, 180, 44, ready, true);
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
function cardAt(p) {
  for (let i = 0; i < cardRects.length; i++) if (inside(p, cardRects[i])) return i;
  return -1;
}
function slotAt(p) {
  for (let k = 0; k < slotRects.length; k++) if (inside(p, slotRects[k])) return k;
  return -1;
}
const slotFree = (k) => { const me = mySeat(); return !!me && k >= 0 && me.box[k] === -1; };

function act(id) {
  if (id === 'mute') { muted = !muted; if (!muted) sfx.pick(); }
  else if (id === 'deal') deal();
}

// A dish is dragged from the tray into a compartment; a tap on a dish holds it
// and shows its rule, and a tap on an empty compartment then places it.
cv.addEventListener('pointerdown', (e) => {
  audio();
  const p = pt(e);
  const b = buttonAt(p);
  if (b) { press = b; e.preventDefault(); return; }
  const c = cardAt(p);
  if (c >= 0 && canPick()) {
    drag = { i: c, x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false };
    sel = c;
    sfx.grab();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ }
  } else {
    const k = slotAt(p);
    if (k >= 0 && canPick() && sel >= 0 && slotFree(k)) place(sel, k);
  }
  e.preventDefault();
});
cv.addEventListener('pointermove', (e) => {
  const p = pt(e);
  if (drag) {
    drag.x = p.x;
    drag.y = p.y;
    if ((p.x - drag.x0) ** 2 + (p.y - drag.y0) ** 2 > 100) drag.moved = true;
  }
  const k = slotAt(p);
  hoverSlot = slotFree(k) ? k : -1;
  if (e.pointerType === 'mouse') {
    hoverCard = cardAt(p);
    cv.style.cursor = drag ? 'grabbing' : hoverCard >= 0 && canPick() ? 'grab' : buttonAt(p) || (hoverSlot >= 0 && sel >= 0 && canPick()) ? 'pointer' : 'default';
  }
});
cv.addEventListener('pointerup', (e) => {
  const p = pt(e);
  if (press) {
    if (buttonAt(p) === press) act(press);
    press = '';
  }
  if (drag) {
    const k = slotAt(p);
    if (drag.moved && slotFree(k)) place(drag.i, k);
    drag = null;
    if (e.pointerType !== 'mouse') hoverSlot = -1;
  }
});
cv.addEventListener('pointercancel', () => { drag = null; press = ''; hoverSlot = -1; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

const SLOT_KEYS = 'qweasdzxc';
window.addEventListener('keydown', (e) => {
  audio();
  const k = e.key;
  if (k === 'm' || k === 'M') { act('mute'); return; }
  if ((S.g === 0 || S.ph === 'wait' || S.ph === 'over') && (k === 'Enter' || k === ' ')) { deal(); e.preventDefault(); return; }
  if (!canPick()) return;
  const tray = trayNow();
  if (/^[1-9]$/.test(k)) {
    const i = Number(k) - 1;
    if (i < tray.length) { sel = i; sfx.grab(); }
    return;
  }
  const slot = SLOT_KEYS.indexOf(k.toLowerCase());
  if (slot >= 0 && k.length === 1) {
    slotCur = slot;
    if (sel >= 0 && slotFree(slot)) place(sel, slot);
    return;
  }
  const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[k];
  if (move) {
    const n = slotCur + move;
    if (n >= 0 && n < 9 && !(Math.abs(move) === 1 && Math.floor(n / 3) !== Math.floor(slotCur / 3))) slotCur = n;
    e.preventDefault();
  } else if (k === 'Tab') {
    sel = tray.length ? (sel + (e.shiftKey ? tray.length - 1 : 1)) % tray.length : -1;
    e.preventDefault();
  } else if ((k === 'Enter' || k === ' ') && sel >= 0 && slotFree(slotCur)) {
    place(sel, slotCur);
    e.preventDefault();
  }
});

// ── start ───────────────────────────────────────────────────────────────────

// The host's clock and this copy's resends share one beat. A tray that was
// lost on the way is asked for again; a hello is repeated slowly until
// somebody answers.
setInterval(() => {
  try {
    const now = performance.now();
    hostTick(now);
    if (solo() || amHost()) return;
    if (!gotState && now - lastHi > 3000) { lastHi = now; room.send({ t: 'hi' }); }
    if (S.ph === 'pick' && mySeat() && !trayNow() && now - lastAsk > 1500 && room.host) {
      lastAsk = now;
      room.send({ t: 'nh', g: S.g }, { to: room.host.id });
    }
  } catch (e) {
    // A tick that throws once must not stop every tick after it.
  }
}, 100);
requestAnimationFrame(frame);
// Nothing is replayed, so a disk that has just started says so; with no room
// around it this goes nowhere, and the host's tick deals practice.
if (!solo()) { lastHi = performance.now(); room.send({ t: 'hi' }); }
