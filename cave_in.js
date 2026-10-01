/**
 * @disk     cave_in
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Push your luck down one mine together. Every gem card is split among whoever is still inside; each turn you secretly dig deeper or run home with your haul. The second hazard of a kind buries everyone who stayed.
 * @tags     game, party, push-your-luck, bluffing
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/cave_in.png
 */
// cave_in.js — a push-your-luck expedition, run by the host.
//
// Five expeditions go down the same mine. Each turn the host flips a card from
// the mine's deck. Gems are split evenly among the players still inside, and
// what does not divide stays on the card. A hazard is harmless the first time;
// the second hazard of the same kind collapses the tunnel, everybody still
// inside loses what they carry, and one card of that kind leaves the deck for
// good. After every flip each player inside picks, face down, to dig on or to
// run. The runners bank what they carry and share the gems left lying on the
// path; a player who runs alone also takes the relics on it.
//
// The host is the authority. A pick travels to the host alone, addressed, so
// no other seat has it on the wire before the reveal, and the host broadcasts
// only who has picked, never what. Every gem count and every card left in the
// deck is public on purpose: the odds are what the game is about. The deck is
// kept as a multiset rather than an order, and the host draws from it at
// random at each flip, so a host that inherits the game mid-way needs nothing
// the old host did not publish. What this does not stop is a hostile host: its
// own copy holds every pick before the reveal and chooses each draw, and
// nothing in a host-run game can take that away from it.

// ── rules ───────────────────────────────────────────────────────────────────

const TREASURE = [1, 2, 3, 4, 5, 5, 7, 7, 9, 11, 11, 13, 14, 15, 17];
const HAZ = 5;                          // kinds of hazard
const HAZ_COPIES = 3;                   // of each, before any is removed
const H0 = 20;                          // card code of the first hazard kind
const RELIC = 30;                       // card code of a relic
const RELIC_VALUE = [5, 5, 5, 10, 10];  // by the order relics are carried out
const EXPEDITIONS = 5;
const PICK_MS = 10000;                  // time to pick, set by the host's clock
const MIN_PICK_MS = 800;                // a flip is on screen at least this long
const SHOW_MS = 2600;                   // how long a reveal stays up
const END_MS = 4800;                    // how long an expedition's summary stays up
const DEAL_COOLDOWN = 2500;             // a finished game is on screen at least this long
const GRACE = 8000;                     // how long a dropped connection has to come back
const MAX_SEATS = 8;
const MAX_PATH = 40;
const ST_IN = 0, ST_HOME = 1, ST_BURIED = 2;
const BOT_NAMES = ['Bot Ada', 'Bot Rex', 'Bot Ivy'];
const HAZ_NAMES = ['Gas', 'Flood', 'Rockfall', 'Spiders', 'Fire'];

// One colour per seat, in seat order, so no two players at a table share one.
const PAL = ['#ff7a7a', '#ffd166', '#5cc8ff', '#b79cff', '#ff9f5a', '#ff6fb5', '#a3d977', '#f2f2f2'];
const HAZ_COL = ['#9be564', '#4aa8ff', '#d2a679', '#c58cff', '#ff7a3d'];
const C = {
  bg0: '#33243a', bg1: '#120c17', rock: '#3a2a3f', panel: 'rgba(22,15,28,0.93)', line: '#4a3652',
  text: '#f6eee3', dim: '#c3b3c4', faint: '#85718a',
  gem: '#4fe3c1', gemDeep: '#0f3b35', gold: '#ffc857', goldDeep: '#3d2c08',
  red: '#ff5a5f', card: '#2a2033', cardEdge: '#5a4462', tunnel: '#0b070e',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const isGem = (c) => c >= 0 && c < TREASURE.length;
const isHaz = (c) => c >= H0 && c < H0 + HAZ;
const isCode = (c) => Number.isInteger(c) && (isGem(c) || isHaz(c) || c === RELIC);

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g      game number, so a stale pick for an old game is recognised
//   ph     'wait' | 'pick' | 'show' | 'end' | 'over'
//   ex     expedition 1..EXPEDITIONS
//   turn   flips so far this game, so a pick names the flip it answers
//   rem    the cards still in the deck, as a sorted multiset
//   path   [[card, n]] flipped this expedition: n is the gems left on a gem
//          card, 1 or 0 for a relic still lying there or carried out
//   gone   hazard kinds that collapsed a tunnel, one card each out of the deck
//   rt     relics carried out so far; their worth rises with the count
//   rd     relics still in the deck
//   seats  [{ id, tent, bag, rel, st }]: banked gems, carried gems, relics, state
//   locked ids that have a pick in, never which one
//   q      players running the disk who are not seated, joining next expedition
//   last   the latest outcome: { k, run, dig, got, h, lost }
let S = blank();
let endAt = 0;           // local clock: when this phase ends
let overAt = -1e9;       // local clock: when the last game ended

function blank() {
  return { g: 0, ph: 'wait', ex: 0, turn: 0, rem: [], path: [], gone: [], rt: 0, rd: 0, seats: [], locked: [], q: [], last: null };
}

// The host's alone.
const picks = new Map();  // seat id -> true to run, false to dig; never broadcast before the reveal
const botAt = new Map();  // bot seat id -> when it picks
const ready = new Map();  // player id -> when its disk last said hello
const answered = new Map(); // player id -> when its hello was last answered
let pickAt = 0;           // when the current pick phase opened
let lastPub = 0;
let shortAt = 0;          // when the table last fell below two players, 0 if it has not
let gameNo = 0;           // the last game number dealt or seen, so a new host counts on

// Mine.
let myPick = null;        // { g, turn, run }
let sentKey = '';         // which host and turn my pick was last sent to
let sendTimer = null;
let lastSend = 0;
let helloAt = -1e9;

const nicks = new Map();  // id -> last nick seen, so a seat that left keeps a name

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
const inside = () => S.seats.filter((s) => s.st === ST_IN);
const score = (s) => s.tent;

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

// Hazard kinds already on the path this expedition: one more of any of them
// collapses the tunnel.
function seenHaz(path) {
  const seen = new Array(HAZ).fill(0);
  for (const [c] of path) if (isHaz(c)) seen[c - H0]++;
  return seen;
}

// The chance the next card collapses the tunnel, from the public deck alone.
function risk() {
  if (!S.rem.length) return 0;
  const seen = seenHaz(S.path);
  let bad = 0;
  for (const c of S.rem) if (isHaz(c) && seen[c - H0] > 0) bad++;
  return bad / S.rem.length;
}

const pathLoot = () => S.path.reduce((a, [c, n]) => a + (isGem(c) ? n : 0), 0);
const pathRelics = () => S.path.reduce((a, [c, n]) => a + (c === RELIC && n > 0 ? 1 : 0), 0);
const relicWorth = (k) => RELIC_VALUE[Math.min(k, RELIC_VALUE.length - 1)];

// ── the host ────────────────────────────────────────────────────────────────

function readyHumans() {
  if (solo()) return [-1];
  const ids = [];
  if (room.me) ids.push(myId());
  for (const id of ready.keys()) if (id !== myId() && inRoom(id)) ids.push(id);
  return ids.slice(0, MAX_SEATS);
}

const canDeal = (now) => S.ph === 'wait' || (S.ph === 'over' && now - overAt >= DEAL_COOLDOWN);

function hostDeal() {
  const now = performance.now();
  if (!amHost() || !canDeal(now)) return;
  let ids = readyHumans();
  // Fewer than two people is a practice table: the host is dealt bots.
  if (ids.length < 2) ids = ids.concat([-2, -3, -4]);
  gameNo = Math.max(gameNo, S.g) + 1;
  S = blank();
  S.g = gameNo;
  S.seats = ids.map((id) => ({ id, tent: 0, bag: 0, rel: 0, st: ST_IN }));
  shortAt = 0;
  startExpedition(now);
}

function startExpedition(now) {
  S.ex += 1;
  // Whoever started the disk during the last expedition sits down now, level
  // with the lowest score at the table, so a latecomer is behind but in it.
  const low = S.seats.length ? Math.min(...S.seats.map(score)) : 0;
  for (const id of queued()) {
    if (S.seats.length >= MAX_SEATS) break;
    S.seats.push({ id, tent: low, bag: 0, rel: 0, st: ST_IN });
  }
  for (const s of S.seats) {
    s.bag = 0;
    // A seat whose player is away sits this expedition out rather than taking
    // a share of every gem card for nobody.
    s.st = present(s.id) ? ST_IN : ST_HOME;
  }
  S.rd += 1;
  const rem = [];
  for (let i = 0; i < TREASURE.length; i++) rem.push(i);
  for (let h = 0; h < HAZ; h++) {
    const n = HAZ_COPIES - S.gone.filter((x) => x === h).length;
    for (let k = 0; k < n; k++) rem.push(H0 + h);
  }
  for (let k = 0; k < S.rd; k++) rem.push(RELIC);
  S.rem = rem;
  S.path = [];
  S.last = null;
  flip(now);
}

function queued() {
  if (solo()) return [];
  return readyHumans().filter((id) => !seatOf(id));
}

function flip(now) {
  const ins = inside();
  if (!ins.length) { endExpedition(now, { k: 'home', run: [], dig: [], got: [], h: -1, lost: [] }); return; }
  if (!S.rem.length || S.path.length >= MAX_PATH) {
    // The deck ran out with people still inside: they walk out with what they carry.
    const got = [];
    for (const s of ins) { got.push([s.id, s.bag, 0]); s.tent += s.bag; s.bag = 0; s.st = ST_HOME; }
    endExpedition(now, { k: 'dry', run: [], dig: [], got, h: -1, lost: [] });
    return;
  }
  const i = Math.floor(Math.random() * S.rem.length);
  const c = S.rem.splice(i, 1)[0];
  S.turn += 1;
  if (isGem(c)) {
    const v = TREASURE[c];
    const share = Math.floor(v / ins.length);
    for (const s of ins) s.bag += share;
    S.path.push([c, v - share * ins.length]);
  } else if (c === RELIC) {
    S.rd = Math.max(0, S.rd - 1);
    S.path.push([c, 1]);
  } else {
    S.path.push([c, 0]);
    if (seenHaz(S.path)[c - H0] >= 2) {
      const lost = [];
      for (const s of ins) { lost.push([s.id, s.bag]); s.bag = 0; s.st = ST_BURIED; }
      S.gone.push(c - H0);
      endExpedition(now, { k: 'bust', run: [], dig: [], got: [], h: c - H0, lost });
      return;
    }
  }
  S.ph = 'pick';
  S.locked = [];
  S.last = null;
  picks.clear();
  scheduleBots(now);
  pickAt = now;
  endAt = now + PICK_MS;
  publish(now);
}

function endExpedition(now, last) {
  S.ph = 'end';
  S.locked = [];
  S.last = last;
  picks.clear();
  botAt.clear();
  endAt = now + END_MS;
  publish(now);
}

function finish(now) {
  S.ph = 'over';
  S.locked = [];
  for (const s of S.seats) { s.bag = 0; }
  picks.clear();
  botAt.clear();
  endAt = now;
  overAt = now;
  publish(now);
}

function scheduleBots(now) {
  botAt.clear();
  for (const s of inside()) if (isBot(s.id)) botAt.set(s.id, now + 900 + Math.random() * 3600);
}

// A bot runs more readily the more it carries, the more is lying on the path
// for whoever leaves, and the worse the odds of the next card.
function botRuns(s) {
  const p = risk() * 1.7 + s.bag / 34 + (pathLoot() + pathRelics() * 6) / 30 - 0.18;
  return Math.random() < clamp(p, 0.04, 0.95);
}

// A pick, from whoever the room says sent it. It counts only for the flip on
// the table, for a seated player who is inside and here; it may be changed
// until the reveal.
function hostSetPick(id, run, now) {
  if (S.ph !== 'pick') return;
  const s = seatOf(id);
  if (!s || s.st !== ST_IN || !present(id)) return;
  picks.set(id, run);
  if (!S.locked.includes(id)) {
    S.locked.push(id);
    publish(now);
  }
}

function reveal(now) {
  const ins = inside();
  const run = [], dig = [];
  for (const s of ins) {
    // Whoever did not pick in time, or is not here to, runs: an idle player
    // keeps what they carry instead of being walked into a cave-in.
    const r = present(s.id) && picks.has(s.id) ? picks.get(s.id) : true;
    (r ? run : dig).push(s.id);
  }
  const got = [];
  if (run.length) {
    const shares = new Map(run.map((id) => [id, 0]));
    for (const card of S.path) {
      if (!isGem(card[0]) || card[1] <= 0) continue;
      const each = Math.floor(card[1] / run.length);
      card[1] -= each * run.length;
      for (const id of run) shares.set(id, shares.get(id) + each);
    }
    let relics = 0, carried = 0;
    if (run.length === 1) {
      for (const card of S.path) {
        if (card[0] !== RELIC || card[1] <= 0) continue;
        card[1] = 0;
        relics += relicWorth(S.rt);
        S.rt += 1;
        carried += 1;
      }
    }
    for (const id of run) {
      const s = seatOf(id);
      const gems = s.bag + shares.get(id);
      s.tent += gems + relics;
      s.rel += carried;
      got.push([id, gems, relics]);
      s.bag = 0;
      s.st = ST_HOME;
    }
  }
  S.last = { k: 'show', run, dig, got, h: -1, lost: [] };
  S.ph = 'show';
  S.locked = [];
  picks.clear();
  botAt.clear();
  endAt = now + SHOW_MS;
  publish(now);
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
  if (S.g > 0 && S.ph !== 'over' && tooFew(now)) { finish(now); return; }
  if (S.ph === 'pick') {
    for (const [id, at] of botAt) {
      if (now < at) continue;
      botAt.delete(id);
      const s = seatOf(id);
      if (s && s.st === ST_IN) hostSetPick(id, botRuns(s), now);
    }
    const live = inside().filter((s) => present(s.id));
    const all = live.length > 0 && live.every((s) => picks.has(s.id));
    if (now >= endAt || (all && now - pickAt >= MIN_PICK_MS)) { reveal(now); return; }
  } else if (S.ph === 'show' && now >= endAt) {
    flip(now);
    return;
  } else if (S.ph === 'end' && now >= endAt) {
    if (S.ex >= EXPEDITIONS) finish(now);
    else startExpedition(now);
    return;
  }
  // A heartbeat, so one lost broadcast is never the only thing that carried a
  // change, and a clock that drifted is put back. The lobby beats too, so
  // everybody sees who has the disk running.
  if (now - lastPub > 2500) publish(now);
}

function wire(now) {
  return {
    t: 'st', g: S.g, ph: S.ph, ex: S.ex, turn: S.turn, rem: S.rem.slice().sort((a, b) => a - b),
    path: S.path, gone: S.gone, rt: S.rt, rd: S.rd,
    seats: S.seats.map((s) => [s.id, s.tent, s.bag, s.rel, s.st]),
    locked: S.locked,
    q: queued().slice(0, MAX_SEATS),
    ms: Math.max(0, Math.round(endAt - now)),
    last: S.last,
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
const PHASES = ['wait', 'pick', 'show', 'end', 'over'];
const KINDS = ['show', 'bust', 'dry', 'home'];
const MAX_SCORE = 100000;

function idList(a, ok) {
  if (!Array.isArray(a) || a.length > MAX_SEATS || !a.every((id) => isId(id) && ok(id))) return null;
  return a.slice();
}

function stateOf(m) {
  if (!int(m.g, 0, 1e9) || !PHASES.includes(m.ph) || !int(m.ex, 0, EXPEDITIONS) || !int(m.turn, 0, 1000)) return null;
  if (!Array.isArray(m.rem) || m.rem.length > MAX_PATH || !m.rem.every(isCode)) return null;
  if (!Array.isArray(m.path) || m.path.length > MAX_PATH) return null;
  const path = [];
  for (const p of m.path) {
    if (!Array.isArray(p) || p.length !== 2 || !isCode(p[0]) || !int(p[1], 0, 20)) return null;
    path.push([p[0], p[1]]);
  }
  if (!Array.isArray(m.gone) || m.gone.length > EXPEDITIONS || !m.gone.every((h) => int(h, 0, HAZ - 1))) return null;
  if (!int(m.rt, 0, EXPEDITIONS) || !int(m.rd, 0, EXPEDITIONS)) return null;
  if (!Array.isArray(m.seats) || m.seats.length > MAX_SEATS) return null;
  const seats = [];
  for (const r of m.seats) {
    if (!Array.isArray(r) || r.length !== 5) return null;
    const [id, tent, bag, rel, st] = r;
    if (!isId(id) || !int(tent, 0, MAX_SCORE) || !int(bag, 0, MAX_SCORE) || !int(rel, 0, EXPEDITIONS) || !int(st, 0, 2)) return null;
    if (seats.some((s) => s.id === id)) return null;
    seats.push({ id, tent, bag, rel, st });
  }
  const seated = (id) => seats.some((s) => s.id === id);
  const locked = idList(m.locked, seated);
  const q = idList(m.q, (id) => !seated(id));
  if (!locked || !q) return null;
  if (typeof m.ms !== 'number' || !Number.isFinite(m.ms)) return null;
  let last = null;
  if (m.last !== null && m.last !== undefined) {
    const l = m.last;
    if (!l || typeof l !== 'object' || !KINDS.includes(l.k) || !int(l.h, -1, HAZ - 1)) return null;
    const run = idList(l.run, seated), dig = idList(l.dig, seated);
    if (!run || !dig) return null;
    const rows = (a, n) => {
      if (!Array.isArray(a) || a.length > MAX_SEATS) return null;
      const out = [];
      for (const r of a) {
        if (!Array.isArray(r) || r.length !== n || !seated(r[0])) return null;
        for (let k = 1; k < n; k++) if (!int(r[k], 0, MAX_SCORE)) return null;
        out.push(r.slice());
      }
      return out;
    };
    const got = rows(l.got, 3), lost = rows(l.lost, 2);
    if (!got || !lost) return null;
    last = { k: l.k, run, dig, got, h: l.h, lost };
  }
  return {
    S: { g: m.g, ph: m.ph, ex: m.ex, turn: m.turn, rem: m.rem.slice(), path, gone: m.gone.slice(), rt: m.rt, rd: m.rd, seats, locked, q, last },
    ms: Math.min(Math.max(m.ms, 0), Math.max(PICK_MS, END_MS)),
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
        }
        break;
      }
      case 'pick':
        if (amHost() && from !== myId() && msg.g === S.g && msg.turn === S.turn && typeof msg.run === 'boolean') {
          hostSetPick(from, msg.run, now);
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
    }
  } catch (e) {
    // A message that breaks this handler is the sender's problem, never the table's.
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
  // The picks went to the old host and left with it. The flip on the table is
  // picked again on a fresh clock; every copy that had picked sends its pick
  // again when it sees the new host's table.
  picks.clear();
  if (S.ph === 'pick') {
    S.locked = [];
    pickAt = now;
    endAt = now + PICK_MS;
    scheduleBots(now);
    if (myPick && myPick.g === S.g && myPick.turn === S.turn) {
      const s = mySeat();
      if (s && s.st === ST_IN) { picks.set(myId(), myPick.run); S.locked.push(myId()); }
    }
  } else if (S.ph === 'show' || S.ph === 'end') {
    endAt = now + 1500;
  }
  publish(now);
});

// ── my moves ────────────────────────────────────────────────────────────────

const canPick = () => S.ph === 'pick' && !!mySeat() && mySeat().st === ST_IN;

function sendPick() {
  if (sendTimer) return;
  // At most four pick messages a second, the last pick always going out: a
  // player flicking between the two is never cut off by the host's bucket.
  const wait = Math.max(0, lastSend + 250 - performance.now());
  sendTimer = setTimeout(() => {
    sendTimer = null;
    lastSend = performance.now();
    if (!myPick || myPick.g !== S.g || myPick.turn !== S.turn || !room.host || amHost()) return;
    room.send({ t: 'pick', g: myPick.g, turn: myPick.turn, run: myPick.run }, { to: room.host.id });
    sentKey = room.host.id + ':' + S.g + ':' + S.turn;
  }, wait);
}

function choose(run) {
  if (!canPick()) return;
  if (myPick && myPick.g === S.g && myPick.turn === S.turn && myPick.run === run) return;
  myPick = { g: S.g, turn: S.turn, run };
  if (run) sfx.run(); else sfx.dig();
  const b = btnRect.get(run ? 'run' : 'dig');
  if (b) burst(b.x + b.w / 2, b.y + b.h / 2, run ? C.gem : C.gold, 12, 150);
  squash = 1;
  if (amHost()) hostSetPick(myId(), run, performance.now());
  else sendPick();
}

let goAt = -1e9;
function go() {
  const now = performance.now();
  // A held key repeats; the host hears one request in half a second.
  if (!canDeal(now) || now - goAt < 500) return;
  goAt = now;
  sfx.pick();
  if (amHost()) hostDeal();
  else if (room.host) room.send({ t: 'go' }, { to: room.host.id });
}

function sayHello(now) {
  if (solo() || amHost() || !room.host || now - helloAt < 3000) return;
  helloAt = now;
  room.send({ t: 'hello' }, { to: room.host.id });
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects are drawn from the table as it changes on this screen, never sent.
let seenKey = '';
let seenTurn = -1;
let seenEx = -1;
let seenLocked = new Set();
let phaseAt = -1e9;      // when this screen saw the current phase start
let flipAt = -1e9;       // when this screen saw the newest card land
let exAt = -1e9;         // when this screen saw the expedition start
let primed = false;      // the first table seen sets the scene without a fanfare

function observe(now, ms) {
  const key = S.g + ':' + S.ex + ':' + S.turn + ':' + S.ph;
  if (key !== seenKey) {
    seenKey = key;
    const span = S.ph === 'pick' ? PICK_MS : S.ph === 'show' ? SHOW_MS : S.ph === 'end' ? END_MS : 0;
    phaseAt = span ? now - Math.max(0, span - ms) : now;
    if (S.ex !== seenEx) { seenEx = S.ex; exAt = now; cardPos.length = 0; }
    if (S.turn !== seenTurn && S.path.length) {
      seenTurn = S.turn;
      flipAt = now;
      if (primed) flipFx();
    }
    if (primed && S.ph === 'show') showFx();
    if (primed && S.ph === 'end') endFx();
    if (S.ph === 'over') {
      overAt = now;
      if (primed) celebrate();
    }
    seenLocked = new Set();
  }
  primed = true;
  if (myPick && (myPick.g !== S.g || myPick.turn !== S.turn)) myPick = null;
  // A soft click when somebody else's pick goes in; my own already had a sound.
  if (S.ph === 'pick' && S.locked.some((id) => id !== myId() && !seenLocked.has(id))) sfx.lock();
  seenLocked = new Set(S.locked);
  // A new host never saw my pick, and a pick can be lost on the way: while the
  // table does not show mine as in, it goes again, once per host and turn and
  // then at the pace of the host's heartbeat.
  if (!amHost() && S.ph === 'pick' && myPick && room.host && !S.locked.includes(myId())) {
    if (sentKey !== room.host.id + ':' + S.g + ':' + S.turn || now - lastSend > 1500) sendPick();
  }
  // A host that does not list me has not heard my hello.
  if (!amHost() && !mySeat() && !S.q.includes(myId())) sayHello(now);
}

function flipFx() {
  const [c] = S.path[S.path.length - 1];
  const at = cardTarget(S.path.length);
  if (isGem(c)) {
    sfx.gem(TREASURE[c]);
    if (at) burst(at.x, at.y, C.gem, 10 + TREASURE[c], 160);
    const ins = inside();
    const share = ins.length ? Math.floor(TREASURE[c] / ins.length) : 0;
    if (share) for (const s of ins) popAtSeat(s.id, '+' + share, C.gem);
  } else if (c === RELIC) {
    sfx.relic();
    if (at) burst(at.x, at.y, C.gold, 24, 200);
  } else {
    // The first of a kind is a warning; the second never reaches here as a
    // flip alone, because it ends the expedition and plays the collapse.
    if (S.ph !== 'end') {
      sfx.warn();
      shake = Math.max(shake, 5);
      if (at) burst(at.x, at.y, HAZ_COL[c - H0], 14, 140);
    }
  }
}

function showFx() {
  const l = S.last;
  if (!l) return;
  if (l.run.length) sfx.bank();
  for (const [id, gems, relics] of l.got) {
    popAtSeat(id, '+' + (gems + relics), relics ? C.gold : C.gem);
    if (relics) setTimeout(() => sfx.relic(), 250);
  }
  if (l.dig.length && !l.run.length) sfx.dig();
}

function endFx() {
  const l = S.last;
  if (!l) return;
  if (l.k === 'bust') {
    sfx.collapse();
    shake = 16;
    rockfall();
    for (const [id, bag] of l.lost) if (bag) popAtSeat(id, '-' + bag, C.red);
  } else if (l.k === 'dry') {
    sfx.bank();
    for (const [id, gems] of l.got) popAtSeat(id, '+' + gems, C.gem);
  }
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
// A rumble: half a second of noise, made once and played through a low filter.
function rumble(d, v, cut) {
  if (muted || !ac) return;
  try {
    if (!noise) {
      noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 1.2), ac.sampleRate);
      const ch = noise.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    }
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = noise;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cut || 600, t);
    f.frequency.exponentialRampToValueAtTime(60, t + d);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    src.connect(f);
    f.connect(g);
    g.connect(ac.destination);
    src.start(t);
    src.stop(t + d + 0.05);
  } catch (e) { /* a sound is never worth an error */ }
}
const sfx = {
  pick: () => { tone(660, 0.07, 'triangle', 0.07); tone(990, 0.08, 'triangle', 0.05, null, 0.05); },
  lock: () => tone(420, 0.06, 'square', 0.025),
  dig: () => { rumble(0.18, 0.12, 900); tone(140, 0.12, 'triangle', 0.08, 90); },
  run: () => tone(380, 0.18, 'triangle', 0.06, 900),
  gem: (v) => [0, 1, 2].slice(0, v > 9 ? 3 : v > 4 ? 2 : 1).forEach((i) => tone(1100 + i * 260, 0.09, 'triangle', 0.05, null, i * 0.06)),
  relic: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.18, 'sine', 0.05, null, i * 0.07)),
  warn: () => { tone(110, 0.35, 'sawtooth', 0.05, 80); rumble(0.4, 0.1, 400); },
  collapse: () => { rumble(1.1, 0.3, 1400); tone(90, 0.8, 'sawtooth', 0.06, 40); },
  bank: () => [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.05, null, i * 0.06)),
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
let rocks = [];          // the cave wall's speckle, laid out once per size
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  coarse = matchMedia('(pointer: coarse)').matches;
  W = cv.clientWidth || window.innerWidth || 640;
  H = cv.clientHeight || window.innerHeight || 400;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rocks = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const n = Math.round((W * H) / 2600);
  for (let i = 0; i < n; i++) rocks.push({ x: rnd() * W, y: rnd() * H, r: 2 + rnd() * 14, l: rnd() });
}
layout();
window.addEventListener('resize', layout);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); };
const back = (t) => { t = clamp(t, 0, 1); const k = 1.7; return 1 + (k + 1) * (t - 1) ** 3 + k * (t - 1) ** 2; };
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
let shake = 0;
let squash = 0;

function burst(x, y, color, n, speed) {
  for (let i = 0; i < n && parts.length < 320; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.8);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, life: 1, decay: 0.9 + Math.random() * 0.8, color, r: 2 + Math.random() * 2.5, g: 420 });
  }
}
function rockfall() {
  for (let i = 0; i < 60 && parts.length < 320; i++) {
    parts.push({
      x: Math.random() * W, y: -10 - Math.random() * H * 0.4,
      vx: (Math.random() - 0.5) * 40, vy: 60 + Math.random() * 160,
      life: 1.4, decay: 0.55 + Math.random() * 0.4, color: Math.random() < 0.5 ? '#6b5560' : '#9a8478',
      r: 3 + Math.random() * 7, g: 700,
    });
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
  const color = top ? colorOf(top.id) : C.gold;
  for (let i = 0; i < 5; i++) burst(W * (0.15 + 0.7 * Math.random()), H * (0.25 + 0.3 * Math.random()), i % 2 ? color : C.gold, 22, 260);
}

// Particles and pops move by the elapsed time, not by the frame, so a slow or
// fast screen shows the same motion.
function stepFx(dt) {
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
  shake = Math.max(0, shake - 30 * dt);
  squash = Math.max(0, squash - 4 * dt);
}

// ── layout of the table ─────────────────────────────────────────────────────

const PAD = 12;
let btns = [];
const btnRect = new Map();
let press = '';
let swipe = null;              // { x0, y0, x, y, id }

function seatsLayout(n) {
  const top = 44;
  const gap = 8;
  let cols = Math.max(1, n);
  let w = (W - 2 * PAD - (cols - 1) * gap) / cols;
  if (w < 92 && n > 1) {
    cols = Math.ceil(n / 2);
    w = (W - 2 * PAD - (cols - 1) * gap) / cols;
  }
  w = Math.min(w, 160);
  const h = H < 460 ? 46 : 54;
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

// The tunnel: the camp in slot 0, then every card flipped, snaking back and
// forth across the space it has. Room is kept for a few more cards than are
// out, so the cards do not shrink on every flip.
let pathBox = { x: 0, y: 0, w: 100, h: 100 };
let pathGeo = null;
function pathLayout(n) {
  const slots = Math.max(n + 1, 9);
  const box = pathBox;
  for (let cw = 74; cw >= 18; cw -= 2) {
    const gap = Math.max(6, cw * 0.22);
    const ch = cw * 1.22;
    const cols = Math.floor((box.w + gap) / (cw + gap));
    if (cols < 2) continue;
    const rows = Math.ceil(slots / cols);
    const gh = rows * ch + (rows - 1) * gap;
    if (gh <= box.h || cw === 18) {
      const used = Math.min(cols, slots);
      const gw = used * cw + (used - 1) * gap;
      const x0 = box.x + (box.w - gw) / 2 + cw / 2;
      const y0 = box.y + Math.max(0, (box.h - gh) / 2) + ch / 2;
      return { cw, ch, gap, cols, x0, y0 };
    }
  }
  return { cw: 18, ch: 22, gap: 6, cols: 2, x0: box.x + 9, y0: box.y + 11 };
}
function slotXY(geo, i) {
  const row = Math.floor(i / geo.cols);
  let col = i % geo.cols;
  if (row % 2) col = geo.cols - 1 - col;
  return { x: geo.x0 + col * (geo.cw + geo.gap), y: geo.y0 + row * (geo.ch + geo.gap) };
}
function cardTarget(k) { return pathGeo ? slotXY(pathGeo, k) : null; }

// Where each card is drawn, eased toward where the layout wants it, so a card
// slides when the layout changes instead of jumping.
const cardPos = [];
const tokenPos = new Map();
const shown = new Map();       // seat id -> score as counted up on screen
let cwShown = 0;               // the card width on screen, eased toward the layout's

// ── drawing pieces ──────────────────────────────────────────────────────────

function drawBackground(now) {
  const g = ctx.createRadialGradient(W / 2, H * 0.55, 10, W / 2, H * 0.5, Math.max(W, H) * 0.8);
  g.addColorStop(0, C.bg0);
  g.addColorStop(1, C.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Speckled rock, so the wall is never a flat colour.
  for (const r of rocks) {
    ctx.fillStyle = r.l < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,220,240,0.025)';
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // A lantern's flicker over the middle of the mine.
  const fl = 0.08 + 0.02 * Math.sin(now / 170) + 0.015 * Math.sin(now / 53);
  const lg = ctx.createRadialGradient(W / 2, H * 0.5, 0, W / 2, H * 0.5, Math.max(W, H) * 0.55);
  lg.addColorStop(0, 'rgba(255,190,110,' + fl + ')');
  lg.addColorStop(1, 'rgba(255,190,110,0)');
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, W, H);
}

function gemIcon(x, y, r, color) {
  ctx.beginPath();
  ctx.moveTo(x - r * 0.62, y - r * 0.62);
  ctx.lineTo(x + r * 0.62, y - r * 0.62);
  ctx.lineTo(x + r, y - r * 0.12);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y - r * 0.12);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = Math.max(0.8, r * 0.12);
  ctx.beginPath();
  ctx.moveTo(x - r, y - r * 0.12);
  ctx.lineTo(x + r, y - r * 0.12);
  ctx.moveTo(x - r * 0.25, y - r * 0.62);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x + r * 0.25, y - r * 0.62);
  ctx.stroke();
}

function relicIcon(x, y, r) {
  ctx.fillStyle = C.gold;
  ctx.beginPath();
  ctx.arc(x, y - r * 0.45, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - r * 0.35, y - r * 0.1);
  ctx.lineTo(x + r * 0.35, y - r * 0.1);
  ctx.lineTo(x + r * 0.7, y + r * 0.9);
  ctx.lineTo(x - r * 0.7, y + r * 0.9);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = C.goldDeep;
  ctx.fillRect(x - r * 0.2, y - r * 0.55, r * 0.12, r * 0.12);
  ctx.fillRect(x + r * 0.08, y - r * 0.55, r * 0.12, r * 0.12);
}

function hazIcon(h, x, y, r) {
  const col = HAZ_COL[h];
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (h === 0) {                // gas: a cloud
    for (const [dx, dy, k] of [[-0.45, 0.15, 0.42], [0.05, -0.2, 0.55], [0.5, 0.15, 0.4], [0, 0.3, 0.42]]) {
      ctx.beginPath();
      ctx.arc(x + dx * r, y + dy * r, k * r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (h === 1) {         // flood: a drop over waves
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x + r * 0.6, y - r * 0.1, x + r * 0.45, y + r * 0.25);
    ctx.arc(x, y + r * 0.2, r * 0.45, 0.1, Math.PI - 0.1);
    ctx.quadraticCurveTo(x - r * 0.6, y - r * 0.1, x, y - r);
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, r * 0.14);
    ctx.beginPath();
    for (let k = 0; k < 2; k++) {
      const yy = y + r * (0.85 + k * 0.3);
      ctx.moveTo(x - r, yy);
      ctx.quadraticCurveTo(x - r * 0.5, yy - r * 0.2, x, yy);
      ctx.quadraticCurveTo(x + r * 0.5, yy + r * 0.2, x + r, yy);
    }
    ctx.stroke();
  } else if (h === 2) {         // rockfall: three stones
    for (const [dx, dy, k] of [[-0.45, 0.4, 0.5], [0.45, 0.45, 0.45], [0, -0.35, 0.5]]) {
      const cx = x + dx * r, cy = y + dy * r, s = k * r;
      ctx.beginPath();
      ctx.moveTo(cx - s, cy);
      ctx.lineTo(cx - s * 0.5, cy - s * 0.85);
      ctx.lineTo(cx + s * 0.6, cy - s * 0.7);
      ctx.lineTo(cx + s, cy + s * 0.2);
      ctx.lineTo(cx + s * 0.3, cy + s * 0.85);
      ctx.lineTo(cx - s * 0.7, cy + s * 0.7);
      ctx.closePath();
      ctx.fill();
    }
  } else if (h === 3) {         // spiders: a body and eight legs
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const yy = y - r * 0.35 + k * r * 0.25;
      ctx.moveTo(x, yy); ctx.lineTo(x - r * 0.75, yy - r * 0.3); ctx.lineTo(x - r * 0.95, yy + r * 0.35);
      ctx.moveTo(x, yy); ctx.lineTo(x + r * 0.75, yy - r * 0.3); ctx.lineTo(x + r * 0.95, yy + r * 0.35);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y + r * 0.1, r * 0.42, 0, Math.PI * 2);
    ctx.arc(x, y - r * 0.45, r * 0.26, 0, Math.PI * 2);
    ctx.fill();
  } else {                      // fire: two flames
    const flame = (cx, cy, s) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy - s);
      ctx.bezierCurveTo(cx + s * 0.9, cy - s * 0.1, cx + s * 0.6, cy + s * 0.8, cx, cy + s * 0.8);
      ctx.bezierCurveTo(cx - s * 0.6, cy + s * 0.8, cx - s * 0.9, cy - s * 0.1, cx, cy - s);
      ctx.fill();
    };
    flame(x, y, r);
    ctx.fillStyle = '#ffd166';
    flame(x, y + r * 0.3, r * 0.45);
  }
}

function tentIcon(x, y, r) {
  ctx.fillStyle = '#e7c58c';
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y + r * 0.7);
  ctx.lineTo(x - r, y + r * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = C.goldDeep;
  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.2);
  ctx.lineTo(x + r * 0.3, y + r * 0.7);
  ctx.lineTo(x - r * 0.3, y + r * 0.7);
  ctx.closePath();
  ctx.fill();
}

// A card on the path. `t` runs 0..1 as it flips face up after landing.
function drawPathCard(c, n, x, y, cw, ch, t, now, deadly) {
  ctx.save();
  ctx.translate(x, y);
  // The card turns on its long axis: the back narrows away, the face widens in.
  ctx.scale(Math.max(0.03, t < 0.5 ? 1 - t * 2 : (t - 0.5) * 2), 1);
  const faceUp = t >= 0.5;
  const w = cw, h = ch;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  rr(-w / 2, -h / 2, w, h, w * 0.14);
  if (!faceUp) {
    ctx.fillStyle = '#4b3654';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.5;
    rr(-w / 2 + w * 0.12, -h / 2 + w * 0.12, w * 0.76, h - w * 0.24, w * 0.08);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const haz = isHaz(c);
  ctx.fillStyle = haz ? '#3a1d2a' : c === RELIC ? '#3d3015' : C.card;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = deadly ? 2.5 : 1.4;
  ctx.strokeStyle = deadly ? alpha(C.red, 0.6 + 0.4 * Math.sin(now / 90)) : haz ? alpha(HAZ_COL[c - H0], 0.7) : c === RELIC ? alpha(C.gold, 0.8) : C.cardEdge;
  ctx.stroke();
  const r = w * 0.26;
  if (isGem(c)) {
    gemIcon(0, -h * 0.12, r, C.gem);
    text(String(TREASURE[c]), -w / 2 + w * 0.13, -h / 2 + w * 0.16, w * 0.24, C.dim, 'left', 800);
    // Gems left lying on the card, for whoever runs.
    const k = Math.min(n, 12);
    const pr = Math.max(1.6, w * 0.06);
    const per = Math.min(k, 6);
    for (let i = 0; i < k; i++) {
      const row = Math.floor(i / 6);
      const inRow = row === 0 ? per : k - 6;
      const gx = (i % 6 - (inRow - 1) / 2) * pr * 2.6;
      gemIcon(gx, h * 0.24 + row * pr * 2.4, pr, C.gem);
    }
  } else if (c === RELIC) {
    relicIcon(0, -h * 0.05, r * 1.1);
    if (n === 0) {
      ctx.fillStyle = 'rgba(20,14,26,0.6)';
      rr(-w / 2, -h / 2, w, h, w * 0.14);
      ctx.fill();
      text('taken', 0, h * 0.32, w * 0.2, C.faint, 'center', 700);
    }
  } else {
    hazIcon(c - H0, 0, -h * 0.06, r);
    text(HAZ_NAMES[c - H0], 0, h * 0.33, w * 0.17, alpha(HAZ_COL[c - H0], 0.9), 'center', 700, w * 0.9);
  }
  ctx.restore();
}

function lantern(x, y, r, color, letter, dead, glow) {
  ctx.save();
  if (!dead && glow) { ctx.shadowColor = color; ctx.shadowBlur = r * 1.4; }
  ctx.fillStyle = dead ? '#5b4d5e' : color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(12,8,16,0.85)';
  ctx.lineWidth = Math.max(1.2, r * 0.18);
  ctx.stroke();
  text(letter, x, y + 0.5, r * 1.1, dead ? '#2a2230' : C.bg1, 'center', 900);
  if (dead) {
    ctx.strokeStyle = C.red;
    ctx.lineWidth = Math.max(1.2, r * 0.2);
    ctx.beginPath();
    ctx.moveTo(x - r * 0.6, y - r * 0.6); ctx.lineTo(x + r * 0.6, y + r * 0.6);
    ctx.moveTo(x + r * 0.6, y - r * 0.6); ctx.lineTo(x - r * 0.6, y + r * 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

function button(id, label, x, y, w, h, enabled, fill, ink, selected) {
  const pressed = press === id;
  ctx.save();
  ctx.globalAlpha = enabled ? 1 : 0.4;
  if (selected) { ctx.shadowColor = fill; ctx.shadowBlur = 18; }
  rr(x, y + (pressed ? 2 : 0), w, h, Math.min(h / 2, 18));
  ctx.fillStyle = fill || 'rgba(255,255,255,0.08)';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  if (!fill) { ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke(); }
  if (selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(); }
  text(label, x + w / 2, y + h / 2 + (pressed ? 2 : 0), Math.min(19, h * 0.36), ink || C.text, 'center', 800, w - 16);
  ctx.restore();
  btnRect.set(id, { x, y, w, h });
  if (enabled) btns.push({ id, x, y, w, h });
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

function standings() {
  return S.seats.slice().sort((a, b) => b.tent - a.tent || b.rel - a.rel);
}

// ── the frame ───────────────────────────────────────────────────────────────

let prevNow = performance.now();
let lastTickSec = -1;

function frame(now) {
  const dt = clamp((now - prevNow) / 1000, 0, 0.1);
  prevNow = now;
  stepFx(dt);
  btns = [];
  btnRect.clear();

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
    ctx.translate(p.x, p.y - 36 * easeOut(k));
    ctx.scale(s, s);
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(12,8,16,0.85)';
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

function drawLobby(now) {
  const people = solo() ? [] : lobbyIds();
  const pw = Math.min(W - 2 * PAD, 430);
  // A short frame loses the picture at the top rather than overlapping the rest.
  const cut = H < 360 ? 70 : 0;
  const ph = 350 - cut;
  const x = (W - pw) / 2, y = Math.max(8, (H - ph) / 2) - cut;
  rr(x, y + cut, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const bob = Math.sin(now / 600) * 3;
  if (!cut) {
    ctx.save();
    ctx.translate(x + pw / 2, y + 48);
    drawPathCard(5, 0, -46, bob, 36, 44, 1, now, false);
    drawPathCard(RELIC, 1, 0, -bob - 4, 36, 44, 1, now, false);
    drawPathCard(H0 + 2, 0, 46, bob, 36, 44, 1, now, false);
    ctx.restore();
  }
  text('CAVE IN', x + pw / 2, y + 104, 28, C.text, 'center', 900);
  const lines = [
    'Five trips down one mine. Gems are split among',
    'whoever is still inside. Each turn: dig on or run home.',
    'A second hazard of a kind buries everyone who stayed.',
  ];
  lines.forEach((l, i) => text(l, x + pw / 2, y + 136 + i * 20, 14, C.dim, 'center', 500, pw - 28));
  let yy = y + 210;
  if (people.length) {
    const dot = 12, gap = 6;
    const total = people.length * (dot + gap) - gap;
    people.forEach((id, i) => {
      lantern(x + pw / 2 - total / 2 + i * (dot + gap) + dot / 2, yy, dot / 2, PAL[i % PAL.length], '', false, true);
    });
    yy += 22;
  }
  const n = people.length;
  const status = solo() ? 'No room here: practise against three bots.'
    : n < 2 ? 'Waiting for a second player to run the disk.'
    : n + ' players ready. Anyone can start.';
  text(status, x + pw / 2, yy, 13, C.faint, 'center', 500, pw - 28);
  const label = solo() || n < 2 ? 'Practice vs bots' : 'Start the dig';
  // Measured from the panel's bottom, which a short frame does not move.
  button('go', label, x + pw / 2 - 95, y + 350 - 66, 190, 46, true, C.gold, C.goldDeep);
  text(coarse ? 'Tap to start' : 'Enter to start', x + pw / 2, y + 350 - 11, 11, C.faint, 'center', 500);
}

function lobbyIds() {
  const ids = [];
  if (room.me) ids.push(myId());
  for (const id of S.q) if (!ids.includes(id) && inRoom(id)) ids.push(id);
  return ids.slice(0, MAX_SEATS);
}

function drawTable(now, dt) {
  const seats = S.seats;
  const L = seatsLayout(seats.length);
  const me = mySeat();
  const left = Math.max(0, endAt - now);
  const ctrlH = H < 430 ? 64 : 78;
  const howY = H - 13;
  const ctrlTop = howY - 14 - ctrlH;
  const last = S.last;

  // Top bar.
  text('CAVE IN', PAD, 22, 15, C.text, 'left', 900);
  font(15, 900);
  const tw = ctx.measureText('CAVE IN').width;
  const loot = pathLoot(), rel = pathRelics();
  const exLabel = 'Trip ' + Math.max(1, S.ex) + '/' + EXPEDITIONS + '  ·  ' + S.rem.length + ' cards left' +
    (loot || rel ? '  ·  on the path: ' + loot + ' gems' + (rel ? ' + ' + rel + (rel > 1 ? ' relics' : ' relic') : '') : '');
  text(exLabel, PAD + tw + 12, 22, 12, C.dim, 'left', 600, W - PAD * 2 - tw - 60);

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
    rr(r.x, r.y, r.w, r.h, 11);
    ctx.fillStyle = alpha(col, mine ? 0.2 : 0.1);
    ctx.fill();
    ctx.strokeStyle = alpha(col, mine ? 0.9 : 0.45);
    ctx.lineWidth = mine ? 2 : 1.2;
    ctx.stroke();
    const ar = Math.min(11, r.h * 0.22);
    const ax = r.x + 7 + ar, ay = r.y + 7 + ar;
    const name = nickOf(s.id);
    lantern(ax, ay, ar, col, name.slice(0, 1).toUpperCase(), s.st === ST_BURIED, s.st === ST_IN);
    const want = s.tent;
    const cur = shown.has(s.id) ? shown.get(s.id) : want;
    const nv = Math.abs(want - cur) < 0.5 ? want : follow(cur, want, dt, 5);
    shown.set(s.id, nv);
    const scoreW = Math.max(24, r.w * 0.28);
    text(clip(name + (mine && !solo() ? ' (you)' : ''), 12, r.w - ar * 2 - scoreW - 18), ax + ar + 6, ay, 12, C.text, 'left', 600);
    text(String(Math.round(nv)), r.x + r.w - 8, ay + 1, Math.min(20, r.h * 0.4), C.gold, 'right', 800);
    // The second line: what this player carries, or where they are.
    const ly = r.y + r.h - 11;
    let status = '', sc = C.faint;
    if (S.ph === 'pick' && s.st === ST_IN) {
      if (S.locked.includes(s.id)) { status = mine && myPick ? (myPick.run ? 'running' : 'digging') : 'picked'; sc = C.text; }
      else { status = 'thinking' + '...'.slice(0, 1 + Math.floor(now / 400) % 3); }
    } else if (S.ph === 'show' && last && last.k === 'show' && (last.run.includes(s.id) || last.dig.includes(s.id))) {
      const ran = last.run.includes(s.id);
      status = ran ? 'RAN' : 'DUG';
      sc = ran ? C.gem : C.gold;
    } else if (s.st === ST_HOME) status = 'at camp';
    else if (s.st === ST_BURIED) { status = 'buried'; sc = C.red; }
    else status = 'inside';
    text(status, r.x + 9, ly, 11, sc, 'left', 700, r.w * 0.5);
    if (s.st === ST_IN || s.bag > 0) {
      gemIcon(r.x + r.w - 14, ly, 4.5, C.gem);
      text(String(s.bag), r.x + r.w - 22, ly, 11, C.gem, 'right', 800);
    }
    if (s.rel && r.w >= 110) {
      relicIcon(r.x + r.w * 0.58, ly - 1, 4.5);
      if (s.rel > 1) text('x' + s.rel, r.x + r.w * 0.58 + 6, ly, 9, C.gold, 'left', 700);
    }
    ctx.restore();
  });

  // The danger line: the hazards out so far and the odds of the next card.
  const dy = L.bottom + 16;
  const seen = seenHaz(S.path);
  const kinds = [];
  for (let h = 0; h < HAZ; h++) if (seen[h]) kinds.push(h);
  const rk = Math.round(risk() * 100);
  const rkCol = rk >= 30 ? C.red : rk >= 15 ? '#ffb347' : C.dim;
  let dx = PAD;
  if (kinds.length) {
    text('Seen:', dx, dy, 12, C.faint, 'left', 600);
    dx += 38;
    for (const h of kinds) { hazIcon(h, dx + 7, dy, 7); dx += 20; }
  } else text('No hazards out yet', dx, dy, 12, C.faint, 'left', 600);
  text('Cave-in risk next card: ' + rk + '%', W - PAD, dy, 12, rkCol, 'right', 800, W - dx - PAD * 2);

  // The tunnel.
  pathBox = { x: PAD, y: dy + 12, w: W - 2 * PAD, h: Math.max(40, ctrlTop - dy - 20) };
  pathGeo = pathLayout(S.path.length);
  const geo = pathGeo;
  const deadly = seenHaz(S.path);
  // The tunnel itself, through every slot in order.
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.tunnel;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = geo.cw * 0.5;
  ctx.beginPath();
  for (let i = 0; i <= S.path.length; i++) {
    const p = i === 0 ? slotXY(geo, 0) : (cardPos[i - 1] || slotXY(geo, i));
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
  // The camp.
  const camp = slotXY(geo, 0);
  rr(camp.x - geo.cw / 2, camp.y - geo.ch / 2, geo.cw, geo.ch, geo.cw * 0.14);
  ctx.fillStyle = 'rgba(231,197,140,0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(231,197,140,0.35)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.setLineDash([]);
  tentIcon(camp.x, camp.y - geo.ch * 0.08, geo.cw * 0.28);
  text('CAMP', camp.x, camp.y + geo.ch * 0.33, geo.cw * 0.17, '#e7c58c', 'center', 800);
  // The cards, sliding into place and turning face up as they land.
  const from = { x: W / 2, y: pathBox.y - 10 };
  // The cards grow or shrink with the layout over a moment, never at once.
  cwShown = cwShown ? follow(cwShown, geo.cw, dt, 8) : geo.cw;
  S.path.forEach(([c, n], k) => {
    const want = slotXY(geo, k + 1);
    let p = cardPos[k];
    const newest = k === S.path.length - 1;
    if (!p) { p = newest && now - flipAt < 600 ? { x: from.x, y: from.y } : { x: want.x, y: want.y }; cardPos[k] = p; }
    p.x = follow(p.x, want.x, dt, 12);
    p.y = follow(p.y, want.y, dt, 12);
    const t = newest ? clamp((now - flipAt - 120) / 380, 0, 1) : 1;
    const land = newest ? back((now - flipAt) / 420) : 1;
    const isDeadly = isHaz(c) && deadly[c - H0] >= 2;
    drawPathCard(c, n, p.x, p.y, cwShown * (0.6 + 0.4 * land), cwShown * 1.22 * (0.6 + 0.4 * land), t, now, isDeadly);
  });
  cardPos.length = S.path.length;
  // A new trip announces itself over the empty tunnel.
  const ta = (now - exAt) / 1000;
  if (ta < 1.8 && S.ph !== 'over' && S.ph !== 'end') {
    ctx.save();
    ctx.globalAlpha = clamp(Math.min(ta / 0.25, (1.8 - ta) / 0.5), 0, 1);
    const s = 1 + 0.15 * (1 - easeOut(ta / 0.5));
    ctx.translate(W / 2, pathBox.y + pathBox.h / 2);
    ctx.scale(s, s);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,8,16,0.8)';
    font(Math.min(44, W / 9), 900);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = S.ex >= EXPEDITIONS ? 'LAST TRIP' : 'TRIP ' + S.ex + ' OF ' + EXPEDITIONS;
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = '#e7c58c';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  // The lanterns: everybody inside stands at the newest card, everybody out
  // at the camp, and the buried where the tunnel came down.
  const tr = clamp(geo.cw * 0.17, 5, 11);
  const ins = seats.filter((s) => s.st === ST_IN);
  const home = seats.filter((s) => s.st !== ST_IN);
  const deep = S.path.length ? (cardPos[S.path.length - 1] || slotXY(geo, S.path.length)) : camp;
  seats.forEach((s, i) => {
    let want;
    if (s.st === ST_IN || s.st === ST_BURIED) {
      const group = s.st === ST_IN ? ins : seats.filter((o) => o.st === ST_BURIED);
      const k = group.indexOf(s);
      const per = Math.max(1, Math.floor(geo.cw / (tr * 2.1)));
      const row = Math.floor(k / per), inRow = Math.min(per, group.length - row * per);
      want = { x: deep.x + ((k % per) - (inRow - 1) / 2) * tr * 2.1, y: deep.y - geo.ch / 2 + row * tr * 2.1 };
    } else {
      const k = home.indexOf(s);
      const per = Math.max(1, Math.floor(geo.cw / (tr * 2.1)));
      const row = Math.floor(k / per), inRow = Math.min(per, home.length - row * per);
      want = { x: camp.x + ((k % per) - (inRow - 1) / 2) * tr * 2.1, y: camp.y - geo.ch / 2 + row * tr * 2.1 };
    }
    let p = tokenPos.get(s.id);
    if (!p) { p = { x: want.x, y: want.y }; tokenPos.set(s.id, p); }
    p.x = follow(p.x, want.x, dt, 6);
    p.y = follow(p.y, want.y, dt, 6);
    if (!present(s.id) && s.st !== ST_IN) return;
    lantern(p.x, p.y, tr, PAL[i % PAL.length], nickOf(s.id).slice(0, 1).toUpperCase(), s.st === ST_BURIED, s.st === ST_IN);
  });

  // My controls.
  const bw = Math.min(200, (W - 2 * PAD - 12) / 2);
  const bx = W / 2 - bw - 6;
  const by = ctrlTop + 12;
  const bh = ctrlH - 14;
  if (me && me.st === ST_IN && S.ph === 'pick') {
    const frac = clamp(left / PICK_MS, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    rr(bx, ctrlTop, bw * 2 + 12, 5, 2.5);
    ctx.fill();
    ctx.fillStyle = left < 3000 ? C.red : C.dim;
    rr(bx, ctrlTop, (bw * 2 + 12) * frac, 5, 2.5);
    ctx.fill();
    const sec = Math.ceil(left / 1000);
    if (sec <= 3 && sec > 0 && sec !== lastTickSec && !(myPick && myPick.turn === S.turn && myPick.g === S.g)) sfx.tick();
    lastTickSec = sec;
    const picked = myPick && myPick.g === S.g && myPick.turn === S.turn ? myPick : null;
    const lean = swipe && canPick() ? clamp((swipe.y - swipe.y0) / 60, -1, 1) : 0;
    const sq = 1 - 0.06 * Math.sin(squash * Math.PI);
    ctx.save();
    ctx.translate(W / 2, by + bh / 2);
    ctx.scale(1, sq);
    ctx.translate(-W / 2, -(by + bh / 2));
    button('run', 'RUN ↓  bank ' + me.bag, bx, by + Math.max(0, lean) * 6, bw, bh, true,
      picked && picked.run ? C.gem : alpha(C.gem, 0.22 + Math.max(0, lean) * 0.4), picked && picked.run ? C.gemDeep : C.text, !!(picked && picked.run));
    button('dig', 'DIG ↑  deeper', bx + bw + 12, by + Math.min(0, lean) * 6, bw, bh, true,
      picked && !picked.run ? C.gold : alpha(C.gold, 0.22 + Math.max(0, -lean) * 0.4), picked && !picked.run ? C.goldDeep : C.text, !!(picked && !picked.run));
    ctx.restore();
    text(String(sec), bx + bw * 2 + 12, ctrlTop - 9, 12, left < 3000 ? C.red : C.dim, 'right', 800);
  } else {
    let msg;
    if (!me) msg = 'You are watching. You join at the start of the next trip.';
    else if (S.ph === 'end' || S.ph === 'over') msg = '';
    else if (me.st === ST_HOME) msg = 'Safe at camp with ' + me.tent + '. Watch the others push their luck.';
    else if (me.st === ST_BURIED) msg = 'Buried. You are back for the next trip.';
    else if (S.ph === 'show') msg = last && last.run.includes(myId()) ? 'You ran.' : 'You dig on...';
    else msg = '';
    if (msg) text(msg, W / 2, by + bh / 2, 14, C.dim, 'center', 600, W - 2 * PAD);
  }

  // One line of how-to, always on screen.
  const how = me && canPick()
    ? (coarse ? 'Swipe up to dig, down to run, or tap. Change it until the reveal.'
      : 'Click, or W / Up to dig and S / Down to run. Change it until the reveal.')
    : 'Runners split the gems left on the path. Run alone to take the relics too.';
  text(how, W / 2, howY, 12, C.faint, 'center', 500, W - 2 * PAD);

  if (S.ph === 'show' && last && last.k === 'show') drawReveal(now, L);
  if (S.ph === 'end') drawEnd(now);
  if (S.ph === 'over') drawOver(now);
}

function drawReveal(now, L) {
  const t = (now - phaseAt) / 1000;
  const l = S.last;
  const k = easeOut(t / 0.35);
  let msg;
  if (!l.run.length) msg = 'Nobody ran. Everyone digs deeper.';
  else if (!l.dig.length) msg = 'Everyone ran for it.';
  else msg = l.run.map(nickOf).join(', ') + ' ran. ' + l.dig.length + ' dig on.';
  const relic = l.got.find((g) => g[2] > 0);
  if (relic) msg += ' ' + nickOf(relic[0]) + ' carried out a relic!';
  const y = pathBox.y + 16;
  ctx.save();
  ctx.globalAlpha = k;
  font(14, 800);
  const w = Math.min(W - 2 * PAD, ctx.measureText(msg).width + 32);
  rr(W / 2 - w / 2, y - 14 + (1 - k) * 10, w, 28, 14);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  text(msg, W / 2, y + (1 - k) * 10, 14, C.text, 'center', 800, w - 20);
  ctx.restore();
}

function overlay(now, at) {
  const k = easeOut((now - at) / 450);
  ctx.fillStyle = 'rgba(10,6,14,' + 0.6 * k + ')';
  ctx.fillRect(0, 0, W, H);
  return k;
}

function drawEnd(now) {
  const k = overlay(now, phaseAt);
  const l = S.last || { k: 'home', got: [], lost: [], h: -1 };
  const list = standings();
  const pw = Math.min(W - 2 * PAD, 380);
  const rowH = 24;
  const ph = Math.min(H - 20, 150 + list.length * rowH);
  const x = (W - pw) / 2, y = (H - ph) / 2 + (1 - k) * 30;
  ctx.save();
  ctx.globalAlpha = k;
  rr(x, y, pw, ph, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = l.k === 'bust' ? alpha(C.red, 0.7) : C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  let title, sub;
  if (l.k === 'bust') hazIcon(l.h, x + pw / 2, y + 30, 14);
  else if (l.k === 'dry') gemIcon(x + pw / 2, y + 30, 12, C.gem);
  else tentIcon(x + pw / 2, y + 30, 14);
  if (l.k === 'bust') {
    title = 'Cave-in! ' + HAZ_NAMES[l.h] + ' again';
    const names = l.lost.map((r) => nickOf(r[0]));
    sub = names.length ? names.join(', ') + (names.length > 1 ? ' are' : ' is') + ' buried and lose what they carried.' : '';
  } else if (l.k === 'dry') {
    title = 'The vein ran dry';
    sub = 'Everyone inside walks out with what they carry.';
  } else {
    title = 'Everyone made it out';
    sub = 'What was left on the path stays in the mine.';
  }
  text(title, x + pw / 2, y + 58, 20, l.k === 'bust' ? C.red : C.text, 'center', 900, pw - 24);
  if (sub) text(sub, x + pw / 2, y + 82, 12, C.dim, 'center', 500, pw - 24);
  list.forEach((s, i) => {
    const yy = y + 108 + i * rowH;
    if (yy > y + ph - 36) return;
    lantern(x + 28, yy, 7, colorOf(s.id), '', s.st === ST_BURIED, false);
    text(clip(nickOf(s.id), 13, pw - 130), x + 42, yy, 13, C.text, 'left', 600);
    text(String(s.tent), x + pw - 24, yy, 15, C.gold, 'right', 800);
  });
  const secs = Math.ceil(Math.max(0, endAt - now) / 1000);
  const next = S.ex >= EXPEDITIONS ? 'Final scores in ' + secs : 'Trip ' + (S.ex + 1) + ' of ' + EXPEDITIONS + ' sets off in ' + secs;
  text(next, x + pw / 2, y + ph - 18, 12, C.faint, 'center', 600);
  ctx.restore();
}

function drawOver(now) {
  const k = overlay(now, overAt);
  const list = standings();
  const pw = Math.min(W - 2 * PAD, 380);
  const rowH = 28;
  const ph = Math.min(H - 20, 150 + list.length * rowH);
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
  const winners = top ? list.filter((s) => s.tent === top.tent && s.rel === top.rel) : [];
  const title = !winners.length ? 'Game over'
    : winners.length > 1 ? 'A tie at ' + top.tent
    : nickOf(top.id) + (top.id === myId() && !solo() ? ' (you)' : '') + ' wins';
  text(title, x + pw / 2, y + 34, 24, winners.length === 1 ? colorOf(top.id) : C.text, 'center', 900, pw - 28);
  list.forEach((s, i) => {
    const yy = y + 70 + i * rowH;
    if (yy > y + ph - 70) return;
    lantern(x + 30, yy, 7, colorOf(s.id), '', false, i === 0);
    text((i + 1) + '.  ' + clip(nickOf(s.id), 14, pw - 150), x + 44, yy, 14, C.text, 'left', 600);
    if (s.rel) text(s.rel + (s.rel > 1 ? ' relics' : ' relic'), x + pw - 70, yy, 11, C.faint, 'right', 500);
    text(String(s.tent), x + pw - 24, yy, 16, C.gold, 'right', 800);
  });
  const readyNow = now - overAt >= DEAL_COOLDOWN;
  const people = solo() ? 0 : S.seats.filter((s) => !isBot(s.id) && present(s.id)).length + S.q.length;
  button('go', people >= 2 ? 'Dig again' : 'Practice again', x + pw / 2 - 90, y + ph - 60, 180, 44, readyNow, C.gold, C.goldDeep);
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
  if (id === 'mute') { muted = !muted; if (!muted) sfx.pick(); }
  else if (id === 'go') go();
  else if (id === 'run') choose(true);
  else if (id === 'dig') choose(false);
}

// A press is either a tap on a button or a swipe anywhere: up to dig, down to
// run. Nothing waits on a long press, which a phone keeps for itself.
cv.addEventListener('pointerdown', (e) => {
  audio();
  const p = pt(e);
  const id = buttonAt(p);
  press = id;
  swipe = { x0: p.x, y0: p.y, x: p.x, y: p.y, id };
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ }
  e.preventDefault();
});
cv.addEventListener('pointermove', (e) => {
  const p = pt(e);
  if (swipe) {
    swipe.x = p.x; swipe.y = p.y;
    if (Math.abs(swipe.y - swipe.y0) > 14) press = '';
  }
  if (e.pointerType === 'mouse') cv.style.cursor = buttonAt(p) ? 'pointer' : 'default';
});
cv.addEventListener('pointerup', (e) => {
  const p = pt(e);
  if (swipe) {
    const dy = p.y - swipe.y0;
    if (Math.abs(dy) >= 40 && canPick()) choose(dy > 0);
    else if (swipe.id && buttonAt(p) === swipe.id) act(swipe.id);
  }
  swipe = null;
  press = '';
});
cv.addEventListener('pointercancel', () => { swipe = null; press = ''; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  audio();
  const k = e.key;
  if (k === 'm' || k === 'M') { act('mute'); return; }
  if ((S.g === 0 || S.ph === 'wait' || S.ph === 'over') && (k === 'Enter' || k === ' ')) { go(); e.preventDefault(); return; }
  if (!canPick()) return;
  if (k === 'ArrowUp' || k === 'w' || k === 'W') { choose(false); e.preventDefault(); }
  else if (k === 'ArrowDown' || k === 's' || k === 'S') { choose(true); e.preventDefault(); }
});

// ── start ───────────────────────────────────────────────────────────────────

setInterval(hostTick, 100);
requestAnimationFrame(frame);
// Nothing is replayed, so a disk that has just started says so and asks where
// the game is. With no room around it this goes nowhere, and the practice
// table is a click away.
observe(performance.now(), 0);
