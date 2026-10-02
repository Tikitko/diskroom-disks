/**
 * @disk     wind_up
 * @author   claude
 * @version  2
 * @players  2-8
 * @about    Wind-up robots on a board that falls apart. Everyone secretly picks three move cards, then every robot runs its program at once, highest card first. Grab coins, shove rivals into the gaps and take theirs.
 * @tags     game, party, cards, programming, simultaneous
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/wind_up.png
 */
// wind_up.js — wind-up robots run secret programs on a crumbling board, run by the host.
//
// Each turn every robot is dealt five move cards in secret and picks three of
// them, in order. When the picks are in, all programs run at once, one card a
// robot at a time: within each of the three registers the card with the higher
// number goes first. A robot that walks into another shoves it, a whole line
// of them if need be; whatever goes off the board or into a gap falls, and is
// back on a free tile for the next turn. A shove that drops a rival takes up
// to two of their coins (three off the leader) and one more for the shove; a
// robot that walks off on its own drops one. The outer rings crack and fall
// away as the game goes on, and a gem worth three lands in the middle twice.
//
// The host is the authority. A hand travels from the host to its player alone,
// addressed, and a pick travels to the host alone. The host checks every pick
// against the hand it dealt, broadcasts the programs only when it runs them,
// together with the seed for new coins and respawns, and every copy plays the
// turn out from that with the same integer rules. What this does not stop is
// a hostile host: its copy deals the cards and sees every pick before the
// reveal, and nothing in a host-run game can take that away from it.
//
// A player alone in the room is dealt a practice game against two bots at
// once, and another after it. When somebody joins, practice ends three seconds
// on under a note that says so, and the host starts the real game.

// ── rules ───────────────────────────────────────────────────────────────────

const N = 9;                 // the board is N x N tiles
const CELLS = N * N;
const MID = 4;               // the middle tile's x and y
const TURNS = 8;
const HAND = 5;
const REGS = 3;
const MAX_SEATS = 8;
const PLAN_MS = 20000;       // time to pick, on the host's clock
const LOBBY_MS = 5000;
const ALONE_MS = 9000;       // a host whose room has not said hello waits this long, then deals bots in
const JOIN_MS = 3000;        // practice runs on this long after somebody joins
const OVER_MS = 16000;
const GAP_MS = 900;          // a turn's last frame stays up this long
const STEP_MS = 230;         // one tile of movement
const TURN_MS = 190;
const FALL_MS = 320;
const CRUMBLE_MS = 900;
const SPAWN_MS = 650;
const CRACK = { 2: 4, 5: 3 };  // at the end of turn t, ring r cracks; it falls at the end of the next
const GEM_TURNS = [3, 6];      // at the end of these turns a gem lands in the middle
const DX = [0, 1, 0, -1];      // facing: 0 north, 1 east, 2 south, 3 west
const DY = [-1, 0, 1, 0];
const BOT_NAMES = ['Cogsworth', 'Sprocket', 'Tinbolt'];
const NAMES = ['Move 1', 'Move 2', 'Move 3', 'Back up', 'Turn left', 'Turn right', 'U-turn'];
const PHASES = ['lobby', 'plan', 'play', 'over'];

// A card is one integer: its number times ten, plus its kind. Every number is
// dealt once a turn, so two cards never tie for who goes first.
const DECK = [];
function addCards(kind, from, step, count) {
  for (let i = 0; i < count; i++) DECK.push((from + i * step) * 10 + kind);
}
addCards(6, 10, 10, 6);     // U-turn      10..60
addCards(4, 70, 20, 18);    // turn left   70..410
addCards(5, 80, 20, 18);    // turn right  80..420
addCards(3, 430, 10, 6);    // back up    430..480
addCards(0, 490, 10, 18);   // move 1     490..660
addCards(1, 670, 10, 12);   // move 2     670..780
addCards(2, 790, 10, 6);    // move 3     790..840
const DECK_SET = new Set(DECK);
const kindOf = (c) => c % 10;
const numOf = (c) => (c / 10) | 0;

// One colour per seat, in seat order, so no two robots at a table share one.
const PAL = ['#ff6b6b', '#4fc3ff', '#8be36b', '#b78cff', '#ff8bd1', '#ff9d47', '#3fe0c0', '#eef2f6'];
const C = {
  bg0: '#17384c', bg1: '#0b1c27', slab: '#10283a', rim: '#c9a25a', rimDark: '#6e5428',
  tileA: '#25495f', tileB: '#21435a', tileHi: '#2f5a73', hole: '#040b10',
  crack: '#5c4434', crackLine: '#1e140d', warn: '#ff7a4a',
  gold: '#ffcf4a', goldDeep: '#a87a22', gem: '#7ff4ff', gemDeep: '#2a9fb8',
  text: '#f2efe6', dim: '#a9bccb', faint: '#64808f', panel: 'rgba(9,22,31,0.86)', line: '#2a4b5e',
  card: '#f3ead7', cardInk: '#1b2a36', move: '#2fb898', back: '#f2715f', turn: '#f0a92e', uturn: '#a77ff0',
};
const KIND_COL = [C.move, C.move, C.move, C.back, C.turn, C.turn, C.uturn];
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ringOf = (x, y) => Math.max(Math.abs(x - MID), Math.abs(y - MID));
const onBoard = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
const standable = (tiles, x, y) => onBoard(x, y) && tiles[y * N + x] !== 1;

function startTiles() {
  const t = new Array(CELLS).fill(0);
  for (const [x, y] of [[2, 2], [6, 2], [2, 6], [6, 6]]) t[y * N + x] = 1;
  return t;
}

// A seeded generator on integers alone, so every copy draws the same coins and
// the same respawns from the seed the host sent.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
const randSeed = () => Math.floor(Math.random() * 0xffffffff) >>> 0;

function cloneTable(t) {
  return { turn: t.turn, tiles: t.tiles.slice(), coins: t.coins.map((c) => c.slice()), rb: t.rb.map((r) => ({ ...r })) };
}
function robotAt(st, x, y) {
  for (const r of st.rb) if (r.al && r.x === x && r.y === y) return r;
  return null;
}
function leaderId(st) {
  let best = null, top = 0, tie = false;
  for (const r of st.rb) {
    if (r.sc > top) { top = r.sc; best = r.id; tie = false; } else if (r.sc === top && top > 0) tie = true;
  }
  return tie ? null : best;
}
// A free tile: whole floor, nobody on it, no coin on it. `maxRing` keeps a
// starting robot away from the edge that will fall first.
function freeCell(st, rnd, maxRing) {
  const list = [];
  for (let i = 0; i < CELLS; i++) {
    const x = i % N, y = (i / N) | 0;
    if (st.tiles[i] !== 0 || ringOf(x, y) > maxRing || robotAt(st, x, y)) continue;
    if (st.coins.some((c) => c[0] === i)) continue;
    list.push(i);
  }
  return list.length ? list[rnd() % list.length] : -1;
}
const coinTarget = (n) => Math.min(6, 2 + Math.ceil(n / 2));
function refillCoins(st, rnd) {
  let small = st.coins.filter((c) => c[1] === 1).length;
  const want = coinTarget(st.rb.length);
  while (small < want) {
    const cell = freeCell(st, rnd, MID);
    if (cell < 0) break;
    st.coins.push([cell, 1]);
    small++;
  }
}

function take(st, r, ev) {
  const cell = r.y * N + r.x;
  const i = st.coins.findIndex((c) => c[0] === cell);
  if (i < 0) return;
  const v = st.coins[i][1];
  st.coins.splice(i, 1);
  r.sc += v;
  ev.push({ k: 'coin', id: r.id, cell, v });
}
function fall(st, r, by, ev) {
  const pusher = by !== null ? st.rb.find((o) => o.id === by) : null;
  if (pusher && pusher !== r) {
    const n = Math.min(r.sc, leaderId(st) === r.id ? 3 : 2);
    r.sc -= n;
    pusher.sc += n + 1;
    ev.push({ k: 'fall', id: r.id, by: pusher.id, n, x: r.x, y: r.y });
  } else {
    const n = Math.min(r.sc, 1);
    r.sc -= n;
    ev.push({ k: 'fall', id: r.id, by: null, n, x: r.x, y: r.y });
  }
  r.al = false;
}
// One tile of movement. Whoever stands in the way is shoved first, and whoever
// stands in their way before them, so a line moves as one.
function shove(st, r, dir, by, ev, depth) {
  const nx = r.x + DX[dir], ny = r.y + DY[dir];
  const o = depth < MAX_SEATS ? robotAt(st, nx, ny) : null;
  if (o) {
    ev.push({ k: 'push', id: by, vic: o.id, x: (r.x + nx) / 2, y: (r.y + ny) / 2 });
    shove(st, o, dir, by, ev, depth + 1);
  }
  r.x = nx;
  r.y = ny;
  if (!standable(st.tiles, nx, ny)) fall(st, r, depth > 0 ? by : null, ev);
  else take(st, r, ev);
}

// Plays a whole turn out from the table before it, the programs and the seed.
// Integer arithmetic and the seeded generator only, so every copy produces the
// same frames and the same table after. A frame is everybody's [x, y, facing,
// standing] after one step, with what happened on that step.
function resolve(pre, plans, seed) {
  const st = cloneTable(pre);
  const rnd = prng(seed);
  const frames = [];
  const snap = () => st.rb.map((r) => [r.x, r.y, r.d, r.al ? 1 : 0]);
  const push = (ms, ev, who, card, reg) => frames.push({ rb: snap(), ev, ms, who, card, reg });
  push(0, [], null, 0, -1);
  const prog = new Map();
  for (const p of plans) prog.set(p[0], p.slice(1));
  for (let reg = 0; reg < REGS; reg++) {
    const order = [];
    for (const r of st.rb) {
      const p = prog.get(r.id);
      if (r.al && p && DECK_SET.has(p[reg])) order.push([p[reg], r]);
    }
    order.sort((a, b) => b[0] - a[0]);
    for (const [c, r] of order) {
      if (!r.al) continue;
      const kind = kindOf(c);
      if (kind >= 4) {
        r.d = (r.d + (kind === 4 ? 3 : kind === 5 ? 1 : 2)) % 4;
        push(TURN_MS, [], r.id, c, reg);
      } else {
        const n = kind === 3 ? 1 : kind + 1;
        const dir = kind === 3 ? (r.d + 2) % 4 : r.d;
        for (let i = 0; i < n && r.al; i++) {
          const ev = [];
          shove(st, r, dir, r.id, ev, 0);
          push(STEP_MS + (ev.some((e) => e.k === 'fall') ? FALL_MS : 0), ev, r.id, c, reg);
        }
      }
    }
  }
  // The cracked ring gives way under whoever is still standing on it.
  const ev1 = [];
  const gone = [];
  for (let i = 0; i < CELLS; i++) if (st.tiles[i] === 2) { st.tiles[i] = 1; gone.push(i); }
  if (gone.length) {
    ev1.push({ k: 'crumble', cells: gone });
    for (const r of st.rb) if (r.al && st.tiles[r.y * N + r.x] === 1) fall(st, r, null, ev1);
    push(CRUMBLE_MS, ev1, null, 0, REGS);
  }
  st.coins = st.coins.filter((c) => st.tiles[c[0]] !== 1);
  // The next ring cracks, a gem may land, the coins are topped up and the
  // fallen come back, in that order.
  const ev2 = [];
  const ring = CRACK[pre.turn];
  if (ring !== undefined) {
    const cells = [];
    for (let i = 0; i < CELLS; i++) {
      if (st.tiles[i] === 0 && ringOf(i % N, (i / N) | 0) === ring) { st.tiles[i] = 2; cells.push(i); }
    }
    if (cells.length) ev2.push({ k: 'crack', cells });
  }
  if (GEM_TURNS.includes(pre.turn)) {
    const mid = MID * N + MID;
    if (st.tiles[mid] === 0 && !robotAt(st, MID, MID) && !st.coins.some((c) => c[0] === mid)) {
      st.coins.push([mid, 3]);
      ev2.push({ k: 'gem', cell: mid });
    }
  }
  refillCoins(st, rnd);
  for (const r of st.rb) {
    if (r.al) continue;
    const cell = freeCell(st, rnd, MID);
    if (cell < 0) continue;
    r.x = cell % N;
    r.y = (cell / N) | 0;
    r.d = rnd() % 4;
    r.al = true;
    ev2.push({ k: 'spawn', id: r.id });
  }
  ev2.push({ k: 'coins', list: st.coins.map((c) => c.slice()) });
  push(SPAWN_MS, ev2, null, 0, REGS);
  return { frames, post: st };
}

// One robot's program on its own, nobody else on the board: what the preview
// draws and what a bot weighs.
function simSolo(tiles, coins, r, cards) {
  let x = r.x, y = r.y, d = r.d, fell = false, got = 0;
  const path = [[x, y, d]];
  const taken = new Set();
  for (const c of cards) {
    if (fell) break;
    const kind = kindOf(c);
    if (kind >= 4) {
      d = (d + (kind === 4 ? 3 : kind === 5 ? 1 : 2)) % 4;
      path.push([x, y, d]);
      continue;
    }
    const n = kind === 3 ? 1 : kind + 1;
    const dir = kind === 3 ? (d + 2) % 4 : d;
    for (let i = 0; i < n && !fell; i++) {
      x += DX[dir];
      y += DY[dir];
      path.push([x, y, d]);
      if (!standable(tiles, x, y)) { fell = true; break; }
      const cell = y * N + x;
      const coin = coins.find((k) => k[0] === cell);
      if (coin && !taken.has(cell)) { taken.add(cell); got += coin[1]; }
    }
  }
  return { x, y, d, fell, got, taken, path };
}

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g       game number, so a stale pick for an old game is recognised
//   ph      'lobby' | 'plan' | 'play' | 'over'
//   turn    1..TURNS
//   tiles   CELLS of 0 floor, 1 gap, 2 cracked (falls at the end of this turn)
//   coins   [[cell, value]]
//   rb      [{ id, seat, x, y, d, sc, al, bot }]
//   locked  ids whose program is in, never what it is
//   plans   [[id, card, card, card]], only while a turn plays
//   seed    for the coins and respawns of the turn that plays
//   rd      players whose disk runs and who play from the next deal
function blankTable(g) {
  return { g, ph: 'lobby', turn: 0, tiles: startTiles(), coins: [], rb: [], locked: [], plans: [], seed: 0, rd: [] };
}
let S = blankTable(0);
let haveTable = false;
let tableHost = null;    // whose table this copy holds
let endAt = 0;           // local clock: when this phase ends
let joinEnd = 0;         // local clock: when practice ends for somebody who joined, 0 if it does not

// The host's alone.
const ready = new Set();
const hands = new Map();     // robot id -> the five cards dealt to it this turn
const progs = new Map();     // robot id -> its picks, as indexes into its hand
const botLockAt = new Map(); // bot id -> when it shows as locked
const parked = new Map();    // id -> score, for a player who stepped out mid-game
const lastReply = new Map();
let lastPub = 0;

// Mine.
let myHand = null;       // { key, cards }
let mySel = [];          // indexes into my hand, in the order they run
let myLocked = false;
let progTimer = null;
let lastProg = -1e9;
let helloAt = -1e9;
let goAt = -1e9;

const nicks = new Map();
const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const amHost = () => !room.me || (room.host !== null && room.host.id === room.me.id);
const fromHost = (from) => room.host !== null && from === room.host.id;
const inRoom = (id) => room.players.some((p) => p.id === id);
// Bots (ids below -1) sit only where the host dealt them; -1 is me with no
// room around me.
const isBot = (id) => id < -1;
const present = (id) => (isBot(id) ? true : id === -1 ? solo() : inRoom(id));
const key = () => S.g + ':' + S.turn;
const robotOf = (id) => S.rb.find((r) => r.id === id) || null;
const myRobot = () => robotOf(myId());

function nickOf(id) {
  if (id === myId()) return 'You';
  if (isBot(id)) return BOT_NAMES[(-id - 2) % BOT_NAMES.length];
  const p = room.players.find((x) => x.id === id);
  if (p) { nicks.set(id, p.nick); return p.nick; }
  return nicks.get(id) || 'Player';
}
function colorOfSeat(seat) { return PAL[seat % PAL.length]; }
function colorOf(id) {
  const r = robotOf(id) || (anim && anim.meta.find((m) => m.id === id));
  return r ? colorOfSeat(r.seat) : C.dim;
}

// ── the host ────────────────────────────────────────────────────────────────

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function facingIn(x, y) {
  const vx = MID - x, vy = MID - y;
  if (Math.abs(vx) >= Math.abs(vy)) return vx > 0 ? 1 : 3;
  return vy > 0 ? 2 : 0;
}
function freeSeat() {
  for (let s = 0; s < MAX_SEATS; s++) if (!S.rb.some((r) => r.seat === s)) return s;
  return -1;
}
function addRobot(id, sc, rnd, maxRing) {
  const seat = freeSeat();
  if (seat < 0) return false;
  const cell = freeCell(S, rnd, maxRing);
  if (cell < 0) return false;
  const x = cell % N, y = (cell / N) | 0;
  S.rb.push({ id, seat, x, y, d: facingIn(x, y), sc, al: true, bot: isBot(id) });
  return true;
}
const readyHumans = () => [...ready].filter((id) => !isBot(id) && present(id));

// Alone in the room, practice starts at once; with others in it, the host waits
// for them to say hello.
function hostLobby(now) {
  S = blankTable(S.g);
  endAt = now + (solo() || room.players.length < 2 ? 600 : readyHumans().length >= 2 ? LOBBY_MS : ALONE_MS);
  publish(now);
}

const practiceTable = () => S.ph !== 'lobby' && S.rb.some((r) => r.bot);

function startMatch(now) {
  const humans = readyHumans().slice(0, MAX_SEATS);
  S = blankTable(S.g + 1);
  const rnd = prng(randSeed());
  for (const id of humans) addRobot(id, 0, rnd, 3);
  // A practice table: one person alone plays against two bots.
  for (let i = 0; S.rb.length < 3 && humans.length < 2 && i < BOT_NAMES.length; i++) addRobot(-2 - i, 0, rnd, 3);
  refillCoins(S, rnd);
  S.ph = 'plan';
  parked.clear();
  beginTurn(now);
}

// The roster changes only between turns, so a program never runs for a robot
// that was not dealt in.
function beginTurn(now) {
  S.rb = S.rb.filter((r) => {
    if (present(r.id)) return true;
    parked.set(r.id, r.sc);
    return false;
  });
  const rnd = prng(randSeed());
  for (const id of readyHumans()) {
    if (S.rb.some((r) => r.id === id)) continue;
    if (addRobot(id, parked.get(id) || 0, rnd, MID)) parked.delete(id);
  }
  for (let i = 0; S.rb.length < 2 && i < BOT_NAMES.length; i++) {
    if (!S.rb.some((r) => r.id === -2 - i)) addRobot(-2 - i, 0, rnd, MID);
  }
  S.turn++;
  if (S.turn > TURNS) { finish(now); return; }
  S.ph = 'plan';
  S.locked = [];
  S.plans = [];
  S.seed = 0;
  deal(now);
  endAt = now + PLAN_MS;
  publish(now);
  sendHands();
}

function deal(now) {
  const deck = shuffle(DECK.slice());
  hands.clear();
  progs.clear();
  botLockAt.clear();
  S.locked = [];
  for (const r of S.rb) {
    hands.set(r.id, deck.splice(0, HAND));
    if (r.bot) {
      progs.set(r.id, botPlan(r, hands.get(r.id)));
      botLockAt.set(r.id, now + 2500 + Math.random() * 7000);
    }
  }
  const mine = hands.get(myId());
  if (mine) takeHand(S.g, S.turn, mine);
}

function sendHands() {
  if (solo()) return;
  for (const r of S.rb) {
    if (r.bot || r.id === myId() || !inRoom(r.id)) continue;
    room.send({ t: 'hand', g: S.g, turn: S.turn, c: hands.get(r.id) }, { to: r.id });
  }
}

function botPlan(r, hand) {
  const late = S.turn >= 5;
  let best = [0, 1, 2], bestScore = -1e9;
  for (let a = 0; a < HAND; a++) for (let b = 0; b < HAND; b++) for (let c = 0; c < HAND; c++) {
    if (a === b || b === c || a === c) continue;
    const sim = simSolo(S.tiles, S.coins, r, [hand[a], hand[b], hand[c]]);
    let sc = sim.got * 10;
    if (sim.fell) sc -= 60;
    else {
      if (S.tiles[sim.y * N + sim.x] === 2) sc -= 35;
      let near = 99;
      for (const [cell] of S.coins) {
        if (!sim.taken.has(cell)) near = Math.min(near, Math.abs((cell % N) - sim.x) + Math.abs(((cell / N) | 0) - sim.y));
      }
      if (near < 99) sc -= near * 1.5;
      sc -= ringOf(sim.x, sim.y) * (late ? 2 : 0.6);
      // Ending next to a rival is ending in reach of a shove.
      for (const o of S.rb) if (o !== r && Math.abs(o.x - sim.x) + Math.abs(o.y - sim.y) === 1) sc += 2;
    }
    sc += Math.random() * 4;
    if (sc > bestScore) { bestScore = sc; best = [a, b, c]; }
  }
  return best;
}

function hostTick() {
  if (!amHost() || !haveTable) return;
  const now = performance.now();
  // Somebody joined a practice game: it ends three seconds on, for the real one.
  if (readyHumans().length >= 2 && practiceTable()) {
    if (!joinEnd) { joinEnd = now + JOIN_MS; publish(now); }
    else if (now >= joinEnd) { joinEnd = 0; startMatch(now); return; }
  } else if (joinEnd) { joinEnd = 0; publish(now); }
  if (S.ph === 'lobby') {
    if (now >= endAt) startMatch(now);
  } else if (S.ph === 'plan') {
    let changed = false;
    const humans = S.rb.filter((r) => !r.bot && present(r.id));
    const allIn = humans.length > 0 && humans.every((r) => S.locked.includes(r.id));
    for (const [id, at] of botLockAt) {
      if ((now >= at || allIn) && !S.locked.includes(id)) { S.locked.push(id); changed = true; }
    }
    if (allIn && endAt > now + 700) { endAt = now + 700; changed = true; }
    if (now >= endAt) runTurn(now);
    else if (changed) publish(now);
  } else if (S.ph === 'play') {
    if (now >= endAt) afterPlay(now);
  } else if (S.ph === 'over') {
    if (now >= endAt) startMatch(now);
  }
  // The table goes out again every few seconds: any one message can be lost
  // for the whole room, and a copy that missed one picks the next.
  if (now - lastPub > 2500) publish(now);
}

// An unfinished program is finished at random from the cards left, the way a
// robot nobody wound runs whatever is in it.
function runTurn(now) {
  S.plans = [];
  for (const r of S.rb) {
    const hand = hands.get(r.id);
    if (!hand) continue;
    const pick = (progs.get(r.id) || []).slice(0, REGS);
    const rest = shuffle([0, 1, 2, 3, 4].filter((i) => !pick.includes(i)));
    while (pick.length < REGS) pick.push(rest.shift());
    S.plans.push([r.id, ...pick.map((i) => hand[i])]);
  }
  S.seed = randSeed();
  S.ph = 'play';
  S.locked = S.rb.map((r) => r.id);
  buildAnim(now);
  endAt = now + anim.total + GAP_MS;
  publish(now);
}

function afterPlay(now) {
  if (!anim || anim.key !== key()) buildAnim(now);
  const post = anim.post;
  S.tiles = post.tiles.slice();
  S.coins = post.coins.map((c) => c.slice());
  S.rb = post.rb.map((r) => ({ ...r }));
  S.plans = [];
  S.seed = 0;
  if (S.turn >= TURNS) finish(now);
  else beginTurn(now);
}

function finish(now) {
  S.ph = 'over';
  S.turn = TURNS;
  S.locked = [];
  S.plans = [];
  endAt = now + OVER_MS;
  publish(now);
}

function hostHello(from, now) {
  ready.add(from);
  if (S.ph === 'lobby' && readyHumans().length >= 2) endAt = Math.min(endAt, now + LOBBY_MS);
  // A copy that asks twice in a second is answered once.
  if (now - (lastReply.get(from) || -1e9) < 1000) return;
  lastReply.set(from, now);
  room.send(wire(now), { to: from });
  if (S.ph === 'plan' && hands.has(from)) room.send({ t: 'hand', g: S.g, turn: S.turn, c: hands.get(from) }, { to: from });
}

function hostProg(from, m, now) {
  if (S.ph !== 'plan' || m.g !== S.g || m.turn !== S.turn) return;
  const r = robotOf(from);
  if (!r || r.bot || !hands.has(from) || S.locked.includes(from)) return;
  if (!Array.isArray(m.sel) || m.sel.length > REGS || typeof m.lock !== 'boolean') return;
  const seen = new Set();
  for (const i of m.sel) {
    if (!int(i, 0, HAND - 1) || seen.has(i)) return;
    seen.add(i);
  }
  if (m.lock && m.sel.length !== REGS) return;
  progs.set(from, m.sel.slice());
  if (m.lock) {
    S.locked.push(from);
    publish(now);
  }
}

function hostGo(now) {
  if (S.ph !== 'lobby' && S.ph !== 'over') return;
  if (endAt > now + 1500) {
    endAt = now + 1500;
    publish(now);
  }
}

function wire(now) {
  const rb = [];
  for (const r of S.rb) rb.push(r.id, r.seat, r.x, r.y, r.d, r.sc, r.al ? 1 : 0, r.bot ? 1 : 0);
  const coins = [];
  for (const c of S.coins) coins.push(c[0], c[1]);
  return {
    t: 'st', g: S.g, ph: S.ph, turn: S.turn, tiles: S.tiles.join(''), coins, rb,
    lk: S.locked.slice(), pl: S.ph === 'play' ? S.plans : [], seed: S.ph === 'play' ? S.seed : 0,
    rd: readyHumans().filter((id) => id >= 0).slice(0, MAX_SEATS),
    ms: Math.max(0, Math.round(endAt - now)),
    j: joinEnd ? Math.max(0, Math.round(joinEnd - now)) : -1,
  };
}

function publish(now) {
  lastPub = now;
  S.rd = readyHumans().slice(0, MAX_SEATS);
  if (!solo()) room.send(wire(now));
  tableHost = room.host ? room.host.id : null;
  observe(now);
}

// ── reading what arrives ────────────────────────────────────────────────────

// The host's table is checked field by field before it replaces mine: a copy
// that breaks on a malformed one is a copy the host can switch off.
function readTable(m) {
  if (!int(m.g, 0, 1e9) || !PHASES.includes(m.ph) || !int(m.turn, 0, TURNS + 1)) return null;
  if (typeof m.tiles !== 'string' || !/^[012]{81}$/.test(m.tiles) || !Number.isFinite(m.ms)) return null;
  const tiles = Array.from(m.tiles, (ch) => ch.charCodeAt(0) - 48);
  if (!Array.isArray(m.coins) || m.coins.length > 40 || m.coins.length % 2) return null;
  const coins = [];
  for (let i = 0; i < m.coins.length; i += 2) {
    const c = m.coins[i], v = m.coins[i + 1];
    if (!int(c, 0, CELLS - 1) || (v !== 1 && v !== 3)) return null;
    coins.push([c, v]);
  }
  if (!Array.isArray(m.rb) || m.rb.length > MAX_SEATS * 8 || m.rb.length % 8) return null;
  const rb = [];
  const ids = new Set(), seats = new Set();
  for (let i = 0; i < m.rb.length; i += 8) {
    const [id, seat, x, y, d, sc, al, bot] = m.rb.slice(i, i + 8);
    if (!int(id, -9, Number.MAX_SAFE_INTEGER) || !int(seat, 0, MAX_SEATS - 1) || !int(d, 0, 3)) return null;
    if (!int(x, -1, N) || !int(y, -1, N) || !int(sc, 0, 9999) || !int(al, 0, 1) || !int(bot, 0, 1)) return null;
    if (ids.has(id) || seats.has(seat) || (al === 1 && !onBoard(x, y))) return null;
    ids.add(id);
    seats.add(seat);
    rb.push({ id, seat, x, y, d, sc, al: al === 1, bot: bot === 1 });
  }
  const idList = (a) => Array.isArray(a) && a.length <= MAX_SEATS && a.every((v) => int(v, -9, Number.MAX_SAFE_INTEGER));
  if (!idList(m.lk) || !idList(m.rd)) return null;
  let plans = [], seed = 0;
  if (m.ph === 'play') {
    if (!Array.isArray(m.pl) || m.pl.length > MAX_SEATS || !int(m.seed, 0, 0xffffffff)) return null;
    const seen = new Set();
    for (const p of m.pl) {
      if (!Array.isArray(p) || p.length !== REGS + 1 || !ids.has(p[0]) || seen.has(p[0])) return null;
      for (let j = 1; j <= REGS; j++) if (!DECK_SET.has(p[j])) return null;
      seen.add(p[0]);
      plans.push(p.slice());
    }
    seed = m.seed;
  }
  return {
    S: { g: m.g, ph: m.ph, turn: m.turn, tiles, coins, rb, locked: m.lk.slice(), plans, seed, rd: m.rd.slice() },
    ms: Math.min(Math.max(m.ms, 0), 60000),
    j: typeof m.j === 'number' && Number.isFinite(m.j) && m.j >= 0 ? Math.min(m.j, JOIN_MS) : -1,
  };
}

function readHand(m) {
  if (S.ph !== 'plan' || m.g !== S.g || m.turn !== S.turn) return;
  if (!Array.isArray(m.c) || m.c.length !== HAND || !m.c.every((c) => DECK_SET.has(c))) return;
  if (new Set(m.c).size !== HAND) return;
  takeHand(m.g, m.turn, m.c);
}

function takeHand(g, turn, cards) {
  const k = g + ':' + turn;
  if (myHand && myHand.key === k && myHand.cards.every((c, i) => c === cards[i])) {
    // The same hand again: the host asked for nothing new, but it may not
    // have my picks, so they go out once more.
    if (mySel.length) sendProg();
    return;
  }
  myHand = { key: k, cards: cards.slice() };
  mySel = [];
  myLocked = false;
  dealtAt = performance.now();
}

// Every sender gets a bucket: ten messages a second, twenty at once. An honest
// copy sends a handful a turn; one that floods is dropped here before any of
// its messages is read, so it cannot stall the table for the rest.
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
      case 'hello':
        if (amHost() && haveTable && inRoom(from)) hostHello(from, now);
        break;
      case 'prog':
        if (amHost() && inRoom(from)) hostProg(from, msg, now);
        break;
      case 'go':
        if (amHost() && inRoom(from)) hostGo(now);
        break;
      case 'st': {
        if (amHost() || !fromHost(from)) break;
        const t = readTable(msg);
        if (!t) break;
        S = t.S;
        endAt = now + t.ms;
        joinEnd = t.j >= 0 ? now + t.j : 0;
        haveTable = true;
        tableHost = from;
        observe(now);
        break;
      }
      case 'hand':
        if (!amHost() && fromHost(from)) readHand(msg);
        break;
    }
  } catch (e) {
    // A message that breaks this handler is the sender's problem, never the table's.
  }
});

room.on('join', (p) => { nicks.set(p.id, p.nick); });

room.on('leave', (p) => {
  nicks.set(p.id, p.nick);
  buckets.delete(p.id);
  ready.delete(p.id);
});

room.on('hostchange', () => {
  tableHost = null;
  if (!amHost()) return;
  const now = performance.now();
  // The old host's hands and picks left with it. Whoever plays already plays
  // on; anybody else says hello again and is seated at the next deal.
  ready.clear();
  ready.add(myId());
  for (const r of S.rb) if (!r.bot && present(r.id)) ready.add(r.id);
  for (const id of S.rd) if (present(id)) ready.add(id);
  if (!haveTable) {
    haveTable = true;
    hostLobby(now);
    return;
  }
  if (S.ph === 'plan') {
    deal(now);
    endAt = now + PLAN_MS;
    publish(now);
    sendHands();
  } else if (S.ph === 'play') {
    if (!anim || anim.key !== key()) buildAnim(now);
    endAt = Math.max(now + 300, anim.start + anim.total + GAP_MS);
    publish(now);
  } else {
    endAt = now + LOBBY_MS;
    publish(now);
  }
});

// ── my moves ────────────────────────────────────────────────────────────────

const canPlan = () => S.ph === 'plan' && !!myHand && myHand.key === key() && !!myRobot();

// At most four pick messages a second and the last pick always goes out, so a
// player flicking through cards is never cut off by the host's bucket.
function sendProg() {
  if (!canPlan()) return;
  if (amHost()) {
    hostProg(myId(), { g: S.g, turn: S.turn, sel: mySel.slice(), lock: myLocked }, performance.now());
    return;
  }
  if (progTimer) return;
  const wait = Math.max(0, lastProg + 250 - performance.now());
  progTimer = setTimeout(() => {
    progTimer = null;
    lastProg = performance.now();
    if (!canPlan() || !room.host || amHost()) return;
    room.send({ t: 'prog', g: S.g, turn: S.turn, sel: mySel.slice(), lock: myLocked }, { to: room.host.id });
  }, wait);
}

function toggle(i) {
  if (!canPlan() || myLocked || i < 0 || i >= HAND) return;
  const at = mySel.indexOf(i);
  if (at >= 0) { mySel.splice(at, 1); sfx.unpick(); } else if (mySel.length < REGS) {
    mySel.push(i);
    sfx.pick(mySel.length);
    const r = handRects[i];
    if (r) burstPx(r.x + r.w / 2, r.y + r.h / 2, colorOf(myId()), 10);
  } else return;
  sendProg();
}
function unslot(j) {
  if (!canPlan() || myLocked || j >= mySel.length) return;
  mySel.splice(j, 1);
  sfx.unpick();
  sendProg();
}
function lockIn() {
  if (!canPlan() || myLocked || mySel.length !== REGS) return;
  myLocked = true;
  sfx.lock();
  const r = myRobot();
  if (r) burst(r.x + 0.5, r.y + 0.5, colorOf(myId()), 14, 3);
  sendProg();
}
function go() {
  const now = performance.now();
  if (S.ph !== 'lobby' && S.ph !== 'over') return;
  if (now - goAt < 1000) return;
  goAt = now;
  sfx.pick(1);
  if (amHost()) hostGo(now);
  else if (room.host) room.send({ t: 'go' }, { to: room.host.id });
}

// Whatever this copy still needs from the host it asks for, at most every
// two and a half seconds: the table, a seat at the next deal, or its hand.
function wantHello() {
  if (amHost() || !room.host || !room.me) return false;
  if (!haveTable || tableHost !== room.host.id) return true;
  if (!S.rd.includes(myId()) && !myRobot()) return true;
  return S.ph === 'plan' && !!myRobot() && (!myHand || myHand.key !== key());
}
function clientTick() {
  const now = performance.now();
  if (wantHello() && now - helloAt > 2500) {
    helloAt = now;
    room.send({ t: 'hello' }, { to: room.host.id });
  }
  // A lock the host has not acknowledged is sent again.
  if (!amHost() && canPlan() && myLocked && !S.locked.includes(myId()) && now - lastProg > 2000) sendProg();
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects are drawn from the table as it changes on this screen, never sent.
let anim = null;
let seenKey = '';
let dealtAt = -1e9;
let lastTickSec = -1;

function buildAnim(start) {
  const res = resolve({ turn: S.turn, tiles: S.tiles, coins: S.coins, rb: S.rb }, S.plans, S.seed);
  const cum = [];
  let t = 0;
  for (const f of res.frames) { t += f.ms; cum.push(t); }
  anim = {
    key: key(), frames: res.frames, post: res.post, cum, total: t, start, next: 1,
    meta: S.rb.map((r) => ({ id: r.id, seat: r.seat, bot: r.bot })),
    plans: S.plans.map((p) => p.slice()),
    tiles: S.tiles.slice(), coins: S.coins.map((c) => c.slice()),
    sc: new Map(S.rb.map((r) => [r.id, r.sc])),
  };
}

function observe(now) {
  const k = S.g + ':' + S.turn + ':' + S.ph;
  if (k === seenKey) return;
  const was = seenKey;
  seenKey = k;
  if (S.ph === 'plan') {
    if (myHand && myHand.key !== key()) { myHand = null; mySel = []; myLocked = false; }
    sfx.deal();
  } else if (S.ph === 'play') {
    if (!anim || anim.key !== key()) {
      buildAnim(now);
      const elapsed = Math.max(0, anim.total + GAP_MS - (endAt - now));
      anim.start = now - elapsed;
    }
    sfx.go();
  } else if (S.ph === 'over') {
    if (was) celebrate();
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
let noiseBuf = null;
function noise(d, v, freq) {
  if (muted || !ac) return;
  try {
    if (!noiseBuf) {
      const len = Math.floor(ac.sampleRate * 1.2);
      noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
      const ch = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    }
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    src.connect(filt);
    filt.connect(g);
    g.connect(ac.destination);
    src.start(t);
    src.stop(t + d + 0.05);
  } catch (e) { /* a sound is never worth an error */ }
}
const sfx = {
  pick: (n) => tone(520 + n * 130, 0.07, 'triangle', 0.07),
  unpick: () => tone(420, 0.07, 'triangle', 0.05, 300),
  lock: () => { tone(330, 0.06, 'square', 0.04); tone(660, 0.12, 'triangle', 0.06, null, 0.06); },
  deal: () => [0, 1, 2, 3, 4].forEach((i) => tone(900 + i * 60, 0.03, 'square', 0.02, null, i * 0.05)),
  go: () => { tone(180, 0.35, 'sawtooth', 0.03, 420); tone(1200, 0.04, 'square', 0.02, null, 0.3); },
  step: () => tone(240 + Math.random() * 40, 0.04, 'square', 0.025),
  turn: () => tone(500, 0.08, 'triangle', 0.035, 700),
  push: () => { tone(110, 0.14, 'square', 0.07, 55); noise(0.12, 0.12, 900); },
  fall: () => tone(700, 0.55, 'sine', 0.08, 90),
  coin: () => { tone(1320, 0.07, 'square', 0.04); tone(1760, 0.14, 'triangle', 0.05, null, 0.06); },
  gem: () => [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, 0.12, 'triangle', 0.05, null, i * 0.06)),
  steal: () => [660, 880, 1100].forEach((f, i) => tone(f, 0.08, 'square', 0.035, null, i * 0.05)),
  crumble: () => { noise(0.9, 0.22, 400); tone(70, 0.8, 'sawtooth', 0.05, 40); },
  crack: () => { noise(0.25, 0.1, 2500); tone(160, 0.2, 'square', 0.03, 90); },
  spawn: () => tone(300, 0.2, 'sine', 0.05, 900),
  tick: () => tone(1500, 0.03, 'square', 0.03),
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
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  W = cv.clientWidth || window.innerWidth || 640;
  H = cv.clientHeight || window.innerHeight || 400;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
layout();
window.addEventListener('resize', layout);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2; };
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
function font(size, weight) { ctx.font = (weight || 600) + ' ' + Math.max(8, Math.round(size)) + 'px ' + FONT; }
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
// A nick is at most 16 characters, but a long one in a narrow place is cut
// rather than shrunk to nothing.
function clip(s, size, maxW, weight) {
  font(size, weight);
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
// Shrinks a line to fit, but never below a readable size: past that it is cut.
function textFit(s, x, y, size, color, align, weight, maxW) {
  font(size, weight);
  const w = ctx.measureText(s).width;
  let k = size;
  if (w > maxW) k = Math.max(10, size * maxW / w);
  text(clip(s, k, maxW, weight), x, y, k, color, align, weight);
}
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

// Where everything goes. A tall frame puts the cards under the board, a wide
// one beside it; either way the board is square and as large as fits.
let G = null;
// NOTE_ROOM under the board keeps the practice note off its bottom row.
const NOTE_ROOM = 60;
function geom() {
  const portrait = H >= W * 1.05;
  const topH = 64;
  let px, py, pw, ph, cw, ch, bs, bx, by;
  if (portrait) {
    pw = W;
    cw = Math.min(70, (W - 16 - 32) / 5);
    ch = cw * 1.3;
    ph = Math.round(ch * 2 + 64);
    px = 0;
    py = H - ph;
    const avail = H - topH - ph - 8 - NOTE_ROOM;
    bs = Math.max(80, Math.min(W - 16, avail));
    bx = (W - bs) / 2;
    by = topH + Math.max(0, (avail - bs) / 2);
  } else {
    pw = clamp(W * 0.36, 210, 340);
    cw = Math.min(62, (pw - 16 - 32) / 5);
    ch = cw * 1.3;
    px = W - pw;
    py = topH;
    ph = H - topH;
    const availW = W - pw - 16, availH = H - topH - 10 - NOTE_ROOM;
    bs = Math.max(80, Math.min(availW, availH));
    bx = (W - pw - bs) / 2;
    by = topH + (availH - bs) / 2;
  }
  const pad = bs * 0.035;
  return { portrait, topH, px, py, pw, ph, cw, ch, bx: bx + pad, by: by + pad, bs: bs - pad * 2, cs: (bs - pad * 2) / N, pad };
}
const sx = (x) => G.bx + x * G.cs;   // board units (tile = 1) to the screen
const sy = (y) => G.by + y * G.cs;

// ── effects ─────────────────────────────────────────────────────────────────

// Particles live in board units, so a resize carries them with the board.
const parts = [];
const pops = [];
let shake = 0;
function burst(x, y, color, n, speed) {
  for (let i = 0; i < n && parts.length < 400; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random() * 0.9);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, life: 1, decay: 1 + Math.random() * 1.2, color, r: 0.04 + Math.random() * 0.05, g: 6 });
  }
}
function burstPx(px, py, color, n) { if (G) burst((px - G.bx) / G.cs, (py - G.by) / G.cs, color, n, 3); }
function debris(cell) {
  const x = (cell % N) + 0.5, y = ((cell / N) | 0) + 0.5;
  for (let i = 0; i < 6 && parts.length < 400; i++) {
    parts.push({ x: x + (Math.random() - 0.5) * 0.8, y: y + (Math.random() - 0.5) * 0.8, vx: (Math.random() - 0.5) * 1.5, vy: Math.random() * 1.5, life: 1, decay: 1.1 + Math.random(), color: i % 2 ? C.crack : '#3a2b20', r: 0.06 + Math.random() * 0.07, g: 9 });
  }
}
function pop(x, y, s, color) { pops.push({ x, y, s, color, t: 0 }); }
function stepFx(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.vy += p.g * dt;
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

const flashAt = new Map();   // robot id -> when it was last hit
function celebrate() {
  sfx.fanfare();
  const top = standings()[0];
  const color = top ? colorOfSeat(top.seat) : C.gold;
  for (let i = 0; i < 6; i++) burst(1 + Math.random() * (N - 2), 1 + Math.random() * 3, i % 2 ? color : C.gold, 24, 5);
}

// The position of a robot in frame k of the turn, by its row in the frames.
function framePos(k, i) {
  const f = anim.frames[Math.min(k, anim.frames.length - 1)];
  return f.rb[i];
}
// The turn's events fire as the playback passes the middle of their frame. A
// copy that joined mid-turn or fell behind catches up without the noise.
function stepAnim(now) {
  const t = now - anim.start;
  while (anim.next < anim.frames.length) {
    const k = anim.next;
    const f = anim.frames[k];
    const at = anim.cum[k - 1] + f.ms * 0.5;
    if (t < at) break;
    fire(k, t - at < 400);
    anim.next++;
  }
}
function fire(k, live) {
  const f = anim.frames[k];
  const idx = (id) => anim.meta.findIndex((m) => m.id === id);
  if (live && f.who !== null && !f.ev.length) {
    if (kindOf(f.card) >= 4) sfx.turn(); else sfx.step();
  }
  for (const e of f.ev) {
    if (e.k === 'coin') {
      anim.coins = anim.coins.filter((c) => c[0] !== e.cell);
      anim.sc.set(e.id, (anim.sc.get(e.id) || 0) + e.v);
      if (live) {
        const x = (e.cell % N) + 0.5, y = ((e.cell / N) | 0) + 0.5;
        burst(x, y, e.v > 1 ? C.gem : C.gold, e.v > 1 ? 26 : 12, 3);
        pop(x, y - 0.4, '+' + e.v, e.v > 1 ? C.gem : C.gold);
        if (e.v > 1) sfx.gem(); else sfx.coin();
      }
    } else if (e.k === 'push') {
      if (live) {
        burst(e.x + 0.5, e.y + 0.5, '#ffffff', 8, 2.5);
        flashAt.set(e.vic, performance.now());
        shake = Math.max(shake, 5);
        sfx.push();
      }
    } else if (e.k === 'fall') {
      anim.sc.set(e.id, (anim.sc.get(e.id) || 0) - e.n);
      if (e.by !== null) anim.sc.set(e.by, (anim.sc.get(e.by) || 0) + e.n + 1);
      if (live) {
        const col = colorOf(e.id);
        burst(e.x + 0.5, e.y + 0.5, col, 16, 2.5);
        if (e.n > 0) pop(e.x + 0.5, e.y, '−' + e.n, C.warn);
        if (e.by !== null) {
          const i = idx(e.by);
          const p = i >= 0 ? framePos(k, i) : null;
          if (p) pop(p[0] + 0.5, p[1] - 0.2, '+' + (e.n + 1), colorOf(e.by));
          sfx.steal();
        }
        shake = Math.max(shake, 7);
        sfx.fall();
      }
    } else if (e.k === 'crumble') {
      for (const c of e.cells) anim.tiles[c] = 1;
      anim.coins = anim.coins.filter((c) => anim.tiles[c[0]] !== 1);
      if (live) {
        for (const c of e.cells) debris(c);
        shake = Math.max(shake, 9);
        sfx.crumble();
      }
    } else if (e.k === 'crack') {
      for (const c of e.cells) anim.tiles[c] = 2;
      if (live) sfx.crack();
    } else if (e.k === 'gem') {
      if (live) { burst(MID + 0.5, MID + 0.5, C.gem, 20, 3); sfx.gem(); }
    } else if (e.k === 'spawn') {
      const i = idx(e.id);
      const p = i >= 0 ? framePos(k, i) : null;
      if (live && p) { burst(p[0] + 0.5, p[1] + 0.5, colorOf(e.id), 14, 2); sfx.spawn(); }
    } else if (e.k === 'coins') {
      anim.coins = e.list.map((c) => c.slice());
    }
  }
}

// ── robots on screen ────────────────────────────────────────────────────────

// Every robot has a pose on screen that eases toward where the table puts it,
// so nothing jumps; while a turn plays the pose comes from the turn's frames.
const disp = new Map();   // id -> { x, y, a (quarter turns), s, spin }
function poses(now, dt) {
  const out = [];
  if (S.ph === 'play' && anim) {
    const t = now - anim.start;
    let k = 1;
    while (k < anim.frames.length - 1 && t >= anim.cum[k]) k++;
    const f = anim.frames[k];
    const prev = anim.frames[k - 1];
    const p = anim.frames.length > 1 ? clamp((t - anim.cum[k - 1]) / Math.max(1, f.ms), 0, 1) : 1;
    anim.meta.forEach((m, i) => {
      const A = prev.rb[i], B = f.rb[i];
      let x, y, a, s = 1, moving = false;
      let delta = (B[2] - A[2] + 4) % 4;
      if (delta === 3) delta = -1;
      if (A[3] && B[3]) {
        const e = ease(p);
        x = lerp(A[0], B[0], e);
        y = lerp(A[1], B[1], e);
        a = A[2] + delta * e;
        moving = A[0] !== B[0] || A[1] !== B[1] || delta !== 0;
      } else if (A[3] && !B[3]) {
        const q = ease(p / 0.45);
        x = lerp(A[0], B[0], q);
        y = lerp(A[1], B[1], q);
        s = 1 - clamp((p - 0.45) / 0.55, 0, 1);
        a = A[2] + (1 - s) * 3;
        moving = true;
      } else if (!A[3] && B[3]) {
        x = B[0]; y = B[1]; a = B[2]; s = back(p);
      } else {
        x = B[0]; y = B[1]; a = B[2]; s = 0;
      }
      let d = disp.get(m.id);
      if (!d) { d = { x, y, a, s, spin: 0 }; disp.set(m.id, d); }
      d.x = x; d.y = y; d.a = a; d.s = s;
      if (moving) d.spin += dt * 14;
      out.push({ id: m.id, seat: m.seat, x, y, a, s, spin: d.spin, acting: f.who === m.id && p < 1 });
    });
    return out;
  }
  for (const r of S.rb) {
    if (!r.al) continue;
    let d = disp.get(r.id);
    if (!d || Math.abs(d.x - r.x) + Math.abs(d.y - r.y) > 2.5) {
      // Somewhere new: it appears there rather than sliding across the board.
      d = { x: r.x, y: r.y, a: r.d, s: 0, spin: 0 };
      disp.set(r.id, d);
    }
    const k = 1 - Math.exp(-dt * 12);
    const ta = r.d + 4 * Math.round((d.a - r.d) / 4);
    const moving = Math.abs(d.x - r.x) + Math.abs(d.y - r.y) > 0.02;
    d.x += (r.x - d.x) * k;
    d.y += (r.y - d.y) * k;
    d.a += (ta - d.a) * k;
    d.s += (1 - d.s) * (1 - Math.exp(-dt * 9));
    if (moving) d.spin += dt * 14;
    out.push({ id: r.id, seat: r.seat, x: d.x, y: d.y, a: d.a, s: d.s, spin: d.spin, acting: false });
  }
  return out;
}

function drawRobot(px, py, s, ang, color, o) {
  if (o.scale <= 0.01) return;
  ctx.save();
  ctx.translate(px, py);
  const base = ctx.globalAlpha;
  ctx.globalAlpha = base * clamp(o.scale * 1.4, 0, 1);
  ctx.scale(o.scale, o.scale);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.ellipse(0, s * 0.42, s * 0.44, s * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  if (o.me) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, s * 0.04);
    ctx.setLineDash([s * 0.12, s * 0.1]);
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.68, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.rotate(ang * Math.PI / 2);
  // treads
  ctx.fillStyle = '#16232c';
  rr(-s * 0.5, -s * 0.4, s * 0.16, s * 0.8, s * 0.06); ctx.fill();
  rr(s * 0.34, -s * 0.4, s * 0.16, s * 0.8, s * 0.06); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  const tr = (o.spin * 0.25) % 1;
  for (let i = 0; i < 4; i++) {
    const yy = -s * 0.38 + ((i + tr) / 4) * s * 0.76;
    ctx.fillRect(-s * 0.49, yy, s * 0.14, s * 0.03);
    ctx.fillRect(s * 0.35, yy, s * 0.14, s * 0.03);
  }
  // wind-up key on the back, turning while the robot walks
  ctx.fillStyle = '#d9b45a';
  ctx.fillRect(-s * 0.045, s * 0.36, s * 0.09, s * 0.14);
  ctx.save();
  ctx.translate(0, s * 0.56);
  ctx.scale(Math.cos(o.spin), 1);
  ctx.beginPath();
  ctx.ellipse(-s * 0.13, 0, s * 0.13, s * 0.08, 0, 0, Math.PI * 2);
  ctx.ellipse(s * 0.13, 0, s * 0.13, s * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // body
  ctx.fillStyle = color;
  rr(-s * 0.37, -s * 0.4, s * 0.74, s * 0.8, s * 0.2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  rr(-s * 0.3, -s * 0.35, s * 0.6, s * 0.12, s * 0.06);
  ctx.fill();
  // face, toward where it walks
  ctx.fillStyle = 'rgba(8,18,26,0.88)';
  rr(-s * 0.26, -s * 0.33, s * 0.52, s * 0.26, s * 0.1);
  ctx.fill();
  ctx.fillStyle = o.blink ? 'rgba(234,252,255,0.3)' : '#eafcff';
  ctx.beginPath();
  ctx.arc(-s * 0.12, -s * 0.2, s * 0.06, 0, Math.PI * 2);
  ctx.arc(s * 0.12, -s * 0.2, s * 0.06, 0, Math.PI * 2);
  ctx.fill();
  // a rivet on the back plate
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.arc(0, s * 0.18, s * 0.07, 0, Math.PI * 2);
  ctx.fill();
  if (o.flash > 0) {
    ctx.globalAlpha = base * clamp(o.scale * 1.4, 0, 1) * o.flash;
    ctx.fillStyle = '#ffffff';
    rr(-s * 0.37, -s * 0.4, s * 0.74, s * 0.8, s * 0.2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCrown(x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = C.gold;
  ctx.strokeStyle = C.goldDeep;
  ctx.lineWidth = Math.max(1, s * 0.06);
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, s * 0.25);
  ctx.lineTo(-s * 0.5, -s * 0.2);
  ctx.lineTo(-s * 0.25, s * 0.02);
  ctx.lineTo(0, -s * 0.32);
  ctx.lineTo(s * 0.25, s * 0.02);
  ctx.lineTo(s * 0.5, -s * 0.2);
  ctx.lineTo(s * 0.5, s * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// ── cards ───────────────────────────────────────────────────────────────────

function chevron(cx, cy, w, h, up) {
  const k = up ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy + (k * h) / 2);
  ctx.lineTo(cx, cy - (k * h) / 2);
  ctx.lineTo(cx + w / 2, cy + (k * h) / 2);
  ctx.stroke();
}
function drawIcon(kind, cx, cy, s, col) {
  ctx.save();
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = Math.max(1.5, s * 0.13);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind <= 2) {
    const n = kind + 1;
    const gap = s * 0.24;
    for (let i = 0; i < n; i++) chevron(cx, cy + (i - (n - 1) / 2) * gap, s * 0.6, s * 0.26, true);
  } else if (kind === 3) {
    chevron(cx, cy + s * 0.05, s * 0.6, s * 0.3, false);
    ctx.beginPath();
    ctx.moveTo(cx, cy - s * 0.35);
    ctx.lineTo(cx, cy + s * 0.15);
    ctx.stroke();
  } else if (kind === 4 || kind === 5) {
    if (kind === 5) { ctx.translate(cx * 2, 0); ctx.scale(-1, 1); }
    const x0 = cx + s * 0.18, y0 = cy + s * 0.38, y1 = cy - s * 0.18, x3 = cx - s * 0.3;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1 + s * 0.1);
    ctx.quadraticCurveTo(x0, y1, x0 - s * 0.12, y1);
    ctx.lineTo(x3, y1);
    ctx.stroke();
    const h = s * 0.17;
    ctx.beginPath();
    ctx.moveTo(x3 + h, y1 - h);
    ctx.lineTo(x3, y1);
    ctx.lineTo(x3 + h, y1 + h);
    ctx.stroke();
  } else {
    const r = s * 0.2;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + s * 0.36);
    ctx.lineTo(cx - r, cy - s * 0.05);
    ctx.arc(cx, cy - s * 0.05, r, Math.PI, 0);
    ctx.lineTo(cx + r, cy + s * 0.3);
    ctx.stroke();
    const h = s * 0.16;
    ctx.beginPath();
    ctx.moveTo(cx + r - h, cy + s * 0.3 - h);
    ctx.lineTo(cx + r, cy + s * 0.3);
    ctx.lineTo(cx + r + h, cy + s * 0.3 - h);
    ctx.stroke();
  }
  ctx.restore();
}
function drawCard(c, x, y, w, h, o) {
  o = o || {};
  const kind = kindOf(c);
  ctx.save();
  ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  rr(x + 1, y + 2, w, h, w * 0.14);
  ctx.fill();
  ctx.fillStyle = C.card;
  rr(x, y, w, h, w * 0.14);
  ctx.fill();
  ctx.fillStyle = KIND_COL[kind];
  rr(x, y, w, h * 0.24, w * 0.14);
  ctx.fill();
  ctx.fillRect(x, y + h * 0.12, w, h * 0.12);
  text(String(numOf(c)), x + w / 2, y + h * 0.125, Math.max(9, h * 0.15), '#ffffff', 'center', 800);
  drawIcon(kind, x + w / 2, y + h * 0.58, Math.min(w, h * 0.7) * 0.62, C.cardInk);
  if (o.ring) {
    ctx.strokeStyle = o.ring;
    ctx.lineWidth = 3;
    rr(x - 2, y - 2, w + 4, h + 4, w * 0.16);
    ctx.stroke();
  }
  ctx.restore();
}

// ── drawing ─────────────────────────────────────────────────────────────────

let hits = [];
let handRects = [];
let lastFrame = performance.now();

function standings() {
  const list = S.rb.map((r) => ({ id: r.id, seat: r.seat, sc: r.sc }));
  list.sort((a, b) => b.sc - a.sc || a.seat - b.seat);
  return list;
}

function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  try {
    draw(now, dt);
  } catch (e) {
    // One bad frame is skipped rather than ending the loop.
  }
  requestAnimationFrame(frame);
}

function draw(now, dt) {
  G = geom();
  hits = [];
  handRects = [];
  stepFx(dt);
  if (S.ph === 'play' && anim && anim.key === key()) stepAnim(now);
  const playing = S.ph === 'play' && anim && anim.key === key();
  const tiles = playing ? anim.tiles : S.tiles;
  const coins = playing ? anim.coins : S.coins;
  const scoreOf = (id) => {
    if (playing && anim.sc.has(id)) return anim.sc.get(id);
    const r = robotOf(id);
    return r ? r.sc : 0;
  };

  // background
  const bg = ctx.createRadialGradient(W / 2, H * 0.4, 10, W / 2, H * 0.45, Math.max(W, H) * 0.8);
  bg.addColorStop(0, C.bg0);
  bg.addColorStop(1, C.bg1);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = C.rim;
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) gear(W * (0.1 + i * 0.4), H * (0.85 - i * 0.3), 40 + i * 26, now / (4000 + i * 1500) * (i % 2 ? -1 : 1));
  ctx.restore();

  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawBoard(now, tiles, coins);
  if (S.ph === 'plan') drawPreview(now);
  const ps = poses(now, dt);
  const lead = leaderOf(scoreOf);
  const cs = G.cs;
  for (const p of ps) {
    const fa = flashAt.get(p.id);
    const flash = fa ? clamp(1 - (now - fa) / 250, 0, 1) : 0;
    const blink = ((now / 1000 + p.seat * 0.7) % 4) < 0.12;
    const cx = sx(p.x + 0.5), cy = sy(p.y + 0.5);
    drawRobot(cx, cy, cs * 0.74, p.a, colorOfSeat(p.seat), { scale: p.s, spin: p.spin, me: p.id === myId(), flash, blink });
    if (p.s > 0.5) {
      if (p.id === lead) drawCrown(cx, cy - cs * 0.5, cs * 0.34);
      if (S.ph === 'plan' && S.locked.includes(p.id)) {
        ctx.fillStyle = 'rgba(8,18,26,0.85)';
        ctx.beginPath();
        ctx.arc(cx + cs * 0.34, cy - cs * 0.34, cs * 0.14, 0, Math.PI * 2);
        ctx.fill();
        text('✓', cx + cs * 0.34, cy - cs * 0.34, cs * 0.18, '#8be36b', 'center', 800);
      }
      if (p.acting && anim) {
        const f = anim.frames[Math.min(anim.frames.length - 1, frameIndex(now))];
        if (f && f.card) drawCard(f.card, cx - cs * 0.22, cy - cs * 1.15, cs * 0.44, cs * 0.56, { alpha: 0.95 });
      }
    }
  }
  drawFx();
  ctx.restore();

  drawTop(now, scoreOf, lead);
  drawPanel(now, scoreOf);
  drawOverlay(now, scoreOf);
  if (haveTable && practiceTable()) {
    const head = joinEnd ? joinHead(Math.max(1, Math.ceil((joinEnd - now) / 1000)))
      : 'practice with bots · a game starts when someone joins';
    const tip = joinEnd ? null : 'pick three cards, every robot runs at once · shove rivals into the gaps';
    const edge = G.by + G.bs + G.pad;
    practiceNote(now, G.bs + 2 * G.pad, head, tip, [[edge + 4, (G.portrait ? G.py : H) - 4]], edge - 4, G.bx - G.pad);
  }

  // tick in the last seconds, only for someone who still has to decide
  if (S.ph === 'plan' && canPlan() && !myLocked) {
    const left = Math.ceil((endAt - now) / 1000);
    if (left <= 5 && left > 0 && left !== lastTickSec) { lastTickSec = left; sfx.tick(); }
  }
}

function frameIndex(now) {
  const t = now - anim.start;
  let k = 1;
  while (k < anim.frames.length - 1 && t >= anim.cum[k]) k++;
  return k;
}

function leaderOf(scoreOf) {
  let best = null, top = 0, tie = false;
  const list = S.ph === 'play' && anim ? anim.meta : S.rb;
  for (const r of list) {
    const v = scoreOf(r.id);
    if (v > top) { top = v; best = r.id; tie = false; } else if (v === top && top > 0) tie = true;
  }
  return tie ? null : best;
}

function gear(x, y, r, a) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.beginPath();
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2;
    const rad = i % 2 ? r : r * 1.15;
    ctx.lineTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawBoard(now, tiles, coins) {
  const { bx, by, bs, cs, pad } = G;
  ctx.fillStyle = C.slab;
  rr(bx - pad, by - pad, bs + pad * 2, bs + pad * 2, pad * 1.4);
  ctx.fill();
  ctx.strokeStyle = C.rim;
  ctx.lineWidth = Math.max(1.5, pad * 0.35);
  ctx.stroke();
  const ins = Math.max(1, cs * 0.05);
  for (let i = 0; i < CELLS; i++) {
    const x = i % N, y = (i / N) | 0;
    const t = tiles[i];
    let X = bx + x * cs, Y = by + y * cs;
    if (t === 1) {
      ctx.fillStyle = C.hole;
      rr(X + ins, Y + ins, cs - ins * 2, cs - ins * 2, cs * 0.12);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(X + ins, Y + cs - ins * 2 - cs * 0.12, cs - ins * 2, cs * 0.12);
      continue;
    }
    if (t === 2 && S.ph === 'plan') X += Math.sin(now * 0.04 + i * 1.7) * cs * 0.015;
    ctx.fillStyle = t === 2 ? C.crack : (x + y) % 2 ? C.tileA : C.tileB;
    rr(X + ins, Y + ins, cs - ins * 2, cs - ins * 2, cs * 0.12);
    ctx.fill();
    ctx.fillStyle = t === 2 ? 'rgba(255,190,140,0.12)' : alpha(C.tileHi, 0.7);
    rr(X + ins, Y + ins, cs - ins * 2, cs * 0.14, cs * 0.12);
    ctx.fill();
    if (t === 2) {
      ctx.strokeStyle = C.crackLine;
      ctx.lineWidth = Math.max(1, cs * 0.04);
      ctx.beginPath();
      const v = (i * 37) % 7;
      ctx.moveTo(X + cs * 0.2, Y + cs * (0.3 + v * 0.03));
      ctx.lineTo(X + cs * 0.45, Y + cs * 0.5);
      ctx.lineTo(X + cs * 0.4, Y + cs * 0.75);
      ctx.moveTo(X + cs * 0.45, Y + cs * 0.5);
      ctx.lineTo(X + cs * 0.78, Y + cs * (0.4 + v * 0.04));
      ctx.stroke();
      ctx.strokeStyle = alpha(C.warn, 0.25 + 0.25 * Math.sin(now * 0.008));
      ctx.lineWidth = Math.max(1, cs * 0.04);
      rr(X + ins, Y + ins, cs - ins * 2, cs - ins * 2, cs * 0.12);
      ctx.stroke();
    }
  }
  // the middle tile carries a gear, where the gem lands
  if (tiles[MID * N + MID] !== 1) {
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = C.rim;
    ctx.lineWidth = Math.max(1, cs * 0.03);
    gear(sx(MID + 0.5), sy(MID + 0.5), cs * 0.3, now / 3000);
    ctx.restore();
  }
  for (const [cell, v] of coins) {
    const x = (cell % N) + 0.5, y = ((cell / N) | 0) + 0.5;
    const bob = Math.sin(now / 380 + cell) * cs * 0.04;
    const X = sx(x), Y = sy(y) + bob;
    if (v > 1) {
      const r = cs * 0.3;
      ctx.save();
      ctx.translate(X, Y);
      ctx.fillStyle = alpha(C.gem, 0.18 + 0.1 * Math.sin(now / 200));
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(Math.sin(now / 700) * 0.2);
      ctx.fillStyle = C.gem;
      ctx.strokeStyle = C.gemDeep;
      ctx.lineWidth = Math.max(1, cs * 0.04);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.8, -r * 0.2);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.8, -r * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      text('3', X, Y - cs * 0.02, cs * 0.24, C.gemDeep, 'center', 800);
    } else {
      const r = cs * 0.19;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(X, sy(y) + cs * 0.24, r * 0.9, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      const w = Math.abs(Math.cos(now / 500 + cell)) * 0.6 + 0.4;
      ctx.fillStyle = C.goldDeep;
      ctx.beginPath();
      ctx.ellipse(X, Y, r * w, r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.gold;
      ctx.beginPath();
      ctx.ellipse(X, Y, r * w * 0.78, r * 0.78, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// My own program, walked out on an empty board: where it ends and whether it
// walks off. The others' moves are not in it, which is the whole game.
function drawPreview(now) {
  const r = myRobot();
  if (!r || !myHand || myHand.key !== key() || !mySel.length) return;
  const sim = simSolo(S.tiles, S.coins, r, mySel.map((i) => myHand.cards[i]));
  const col = colorOf(myId());
  const cs = G.cs;
  ctx.save();
  ctx.strokeStyle = alpha(col, 0.8);
  ctx.lineWidth = Math.max(2, cs * 0.07);
  ctx.setLineDash([cs * 0.12, cs * 0.12]);
  ctx.lineDashOffset = -now / 40;
  ctx.beginPath();
  sim.path.forEach((p, i) => {
    const X = sx(p[0] + 0.5), Y = sy(p[1] + 0.5);
    if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
  for (const cell of sim.taken) {
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx((cell % N) + 0.5), sy(((cell / N) | 0) + 0.5), cs * 0.3, 0, Math.PI * 2);
    ctx.stroke();
  }
  const X = sx(sim.x + 0.5), Y = sy(sim.y + 0.5);
  if (sim.fell) {
    ctx.strokeStyle = C.warn;
    ctx.lineWidth = Math.max(2, cs * 0.08);
    const k = cs * 0.2;
    ctx.beginPath();
    ctx.moveTo(X - k, Y - k); ctx.lineTo(X + k, Y + k);
    ctx.moveTo(X + k, Y - k); ctx.lineTo(X - k, Y + k);
    ctx.stroke();
  } else {
    ctx.globalAlpha = 0.4;
    drawRobot(X, Y, cs * 0.74, sim.d, col, { scale: 1, spin: 0 });
  }
  ctx.restore();
}

function drawFx() {
  const cs = G.cs;
  for (const p of parts) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(sx(p.x), sy(p.y), Math.max(1, p.r * cs), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const k = p.t / 1.3;
    ctx.globalAlpha = 1 - clamp((k - 0.6) / 0.4, 0, 1);
    const size = cs * 0.42 * (0.7 + 0.3 * back(p.t * 4));
    const X = sx(p.x), Y = sy(p.y) - easeOut(k) * cs * 0.6;
    font(size, 800);
    ctx.lineWidth = Math.max(2, size * 0.18);
    ctx.strokeStyle = 'rgba(5,14,20,0.85)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText(p.s, X, Y);
    ctx.fillStyle = p.color;
    ctx.fillText(p.s, X, Y);
  }
  ctx.globalAlpha = 1;
}

function status(now) {
  if (!haveTable) return room.host ? 'Waiting for the host to run the disk…' : 'Waiting for the room…';
  if (S.ph === 'lobby') return 'Gathering robots — the game starts soon';
  if (S.ph === 'over') return 'Game over';
  if (S.ph === 'play') {
    if (!anim) return 'Running programs';
    const f = anim.frames[frameIndex(now)];
    if (f && f.reg >= REGS) return 'The board settles';
    return 'Running programs · card ' + ((f ? f.reg : 0) + 1) + ' of 3';
  }
  if (!myRobot()) return 'Watching — you are dealt in at the next turn';
  if (myLocked) {
    const waiting = S.rb.filter((r) => !S.locked.includes(r.id)).length;
    return waiting ? 'Locked in · waiting for ' + waiting : 'Locked in · here we go';
  }
  if (S.tiles.includes(2)) return 'The cracked ring falls after this turn!';
  return 'Pick 3 cards · all robots move at once, highest number first';
}

function drawTop(now, scoreOf, lead) {
  ctx.fillStyle = 'rgba(6,16,23,0.55)';
  ctx.fillRect(0, 0, W, G.topH);
  // turn pill
  const label = S.ph === 'lobby' || !haveTable ? 'WIND-UP' : S.ph === 'over' ? 'FINAL' : 'TURN ' + S.turn + '/' + TURNS;
  font(12, 800);
  const lw = ctx.measureText(label).width + 18;
  ctx.fillStyle = alpha(C.rim, 0.22);
  rr(8, 7, lw, 20, 10);
  ctx.fill();
  text(label, 8 + lw / 2, 17.5, 12, C.rim, 'center', 800);
  // mute
  const mx = W - 30, my = 4;
  hits.push({ id: 'mute', x: mx - 4, y: 0, w: 34, h: 32 });
  ctx.strokeStyle = muted ? C.faint : C.dim;
  ctx.fillStyle = muted ? C.faint : C.dim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mx + 4, my + 10); ctx.lineTo(mx + 9, my + 10); ctx.lineTo(mx + 14, my + 5);
  ctx.lineTo(mx + 14, my + 21); ctx.lineTo(mx + 9, my + 16); ctx.lineTo(mx + 4, my + 16);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  if (muted) { ctx.moveTo(mx + 17, my + 9); ctx.lineTo(mx + 23, my + 17); ctx.moveTo(mx + 23, my + 9); ctx.lineTo(mx + 17, my + 17); } else { ctx.arc(mx + 15, my + 13, 6, -0.8, 0.8); }
  ctx.stroke();
  // timer
  let right = W - 40;
  if (haveTable && S.ph !== 'play') {
    const left = Math.max(0, Math.ceil((endAt - now) / 1000));
    const low = S.ph === 'plan' && left <= 5;
    text(left + 's', right, 17.5, 15, low ? C.warn : C.text, 'right', 800);
    right -= 44;
  }
  const sx0 = 16 + lw;
  textFit(status(now), sx0, 17.5, 13, C.dim, 'left', 600, Math.max(40, right - sx0));
  // time bar
  if (haveTable && S.ph === 'plan') {
    const k = clamp((endAt - now) / PLAN_MS, 0, 1);
    ctx.fillStyle = alpha(C.line, 0.8);
    ctx.fillRect(0, 33, W, 3);
    ctx.fillStyle = k < 0.25 ? C.warn : C.rim;
    ctx.fillRect(0, 33, W * k, 3);
  }
  // score chips
  const list = (S.ph === 'play' && anim ? anim.meta : S.rb).map((r) => ({ id: r.id, seat: r.seat, sc: scoreOf(r.id) }));
  if (!list.length) return;
  const n = list.length;
  const gap = 5;
  const cwid = Math.min(150, (W - 16 - gap * (n - 1)) / n);
  let x = (W - (cwid * n + gap * (n - 1))) / 2;
  for (const r of list) {
    const col = colorOfSeat(r.seat);
    ctx.fillStyle = r.id === myId() ? alpha(col, 0.28) : 'rgba(255,255,255,0.06)';
    rr(x, 39, cwid, 21, 10);
    ctx.fill();
    if (r.id === lead) { ctx.strokeStyle = C.gold; ctx.lineWidth = 1.5; ctx.stroke(); }
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x + 10, 49.5, 5, 0, Math.PI * 2);
    ctx.fill();
    const scs = String(r.sc);
    font(13, 800);
    const sw = ctx.measureText(scs).width;
    text(scs, x + cwid - 7, 49.5, 13, C.text, 'right', 800);
    const room_ = cwid - 26 - sw - 6;
    if (room_ > 14) text(clip(nickOf(r.id), 11, room_, 600), x + 19, 49.5, 11, C.dim, 'left', 600);
    x += cwid + gap;
  }
}

function button(id, label, x, y, w, h, col, on) {
  hits.push({ id, x, y, w, h });
  ctx.fillStyle = on ? col : 'rgba(255,255,255,0.08)';
  rr(x, y, w, h, Math.min(12, h / 2));
  ctx.fill();
  text(label, x + w / 2, y + h / 2, Math.min(16, h * 0.36), on ? '#0b1c27' : C.faint, 'center', 800, w - 10);
}

function drawPanel(now, scoreOf) {
  const { px, py, pw, ph, cw, ch } = G;
  ctx.fillStyle = C.panel;
  rr(px + 4, py + 2, pw - 8, ph - 6, 14);
  ctx.fill();
  const x0 = px + 12, inner = pw - 24;
  if (!haveTable) return;
  if (S.ph === 'plan' && myRobot() && myHand && myHand.key === key()) {
    const col = colorOf(myId());
    text('YOUR PROGRAM', x0, py + 16, 11, C.rim, 'left', 800);
    text('high number moves first', x0 + inner, py + 16, 11, C.faint, 'right', 600, inner * 0.55);
    const gap = (inner - cw * 5) / 4;
    // the three registers
    const ys = py + 28;
    for (let j = 0; j < REGS; j++) {
      const X = x0 + j * (cw + gap);
      const i = mySel[j];
      if (i === undefined) {
        ctx.strokeStyle = alpha(col, 0.5);
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        rr(X, ys, cw, ch, cw * 0.14);
        ctx.stroke();
        ctx.setLineDash([]);
        text(String(j + 1), X + cw / 2, ys + ch / 2, ch * 0.3, alpha(col, 0.5), 'center', 800);
      } else {
        drawCard(myHand.cards[i], X, ys, cw, ch, { ring: myLocked ? null : alpha(col, 0.7) });
        hits.push({ id: 's' + j, x: X, y: ys, w: cw, h: ch });
      }
    }
    const lx = x0 + 3 * (cw + gap), lw = inner - 3 * (cw + gap);
    const full = mySel.length === REGS;
    if (myLocked) button('none', 'LOCKED ✓', lx, ys + ch * 0.18, lw, ch * 0.64, C.faint, false);
    else button('lock', full ? 'LOCK IN' : mySel.length + ' / 3', lx, ys + ch * 0.18, lw, ch * 0.64, col, full);
    // the hand
    const yh = ys + ch + 12;
    const since = now - dealtAt;
    for (let i = 0; i < HAND; i++) {
      const X = x0 + i * (cw + gap);
      const k = easeOut((since - i * 60) / 300);
      const Y = yh + (1 - k) * 30;
      const at = mySel.indexOf(i);
      handRects[i] = { x: X, y: Y, w: cw, h: ch };
      drawCard(myHand.cards[i], X, Y, cw, ch, { alpha: (at >= 0 || myLocked ? 0.3 : 1) * k });
      if (at >= 0) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(X + cw / 2, Y + ch / 2, cw * 0.2, 0, Math.PI * 2);
        ctx.fill();
        text(String(at + 1), X + cw / 2, Y + ch / 2, cw * 0.24, '#0b1c27', 'center', 800);
      } else if (!myLocked) {
        text(String(i + 1), X + cw - 7, Y + ch - 8, 9, C.faint, 'center', 700);
      }
      hits.push({ id: 'h' + i, x: X, y: Y, w: cw, h: ch });
    }
    const yt = yh + ch + 14;
    if (yt < py + ph - 8) text('Tap cards in the order to run them · keys 1-5, Enter', x0 + inner / 2, yt, 11, C.faint, 'center', 600, inner);
    return;
  }
  if (S.ph === 'plan' || S.ph === 'play') {
    // Every program on the table, face down until the turn plays.
    const rows = S.ph === 'play' && anim ? anim.meta : S.rb;
    const title = S.ph === 'play' ? 'PROGRAMS' : 'WINDING UP';
    text(title, x0, py + 16, 11, C.rim, 'left', 800);
    const top = py + 28;
    const rh = Math.min(34, (ph - 38) / Math.max(1, rows.length));
    const mh = rh - 5, mw = mh * 0.76;
    let done = new Set(), cur = 0;
    if (S.ph === 'play' && anim) {
      const k = frameIndex(now);
      for (let j = 1; j < k; j++) if (anim.frames[j].card) done.add(anim.frames[j].card);
      cur = anim.frames[k] ? anim.frames[k].card : 0;
      if (now - anim.start >= anim.total) { if (cur) done.add(cur); cur = 0; }
    }
    rows.forEach((r, i) => {
      const y = top + i * rh;
      const col = colorOfSeat(r.seat);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x0 + 6, y + rh / 2, 5, 0, Math.PI * 2);
      ctx.fill();
      const cardsW = (mw + 4) * 3;
      text(clip(nickOf(r.id), Math.min(13, rh * 0.42), inner - cardsW - 24, 600), x0 + 16, y + rh / 2, Math.min(13, rh * 0.42), C.text, 'left', 600);
      const plan = S.ph === 'play' && anim ? anim.plans.find((p) => p[0] === r.id) : null;
      for (let j = 0; j < REGS; j++) {
        const X = x0 + inner - cardsW + j * (mw + 4), Y = y + 2;
        if (plan) {
          const c = plan[j + 1];
          drawCard(c, X, Y, mw, mh, { alpha: done.has(c) ? 0.35 : 1, ring: c === cur ? '#ffffff' : null });
        } else {
          const lockedIn = S.locked.includes(r.id);
          ctx.fillStyle = lockedIn ? alpha(col, 0.55) : 'rgba(255,255,255,0.07)';
          rr(X, Y, mw, mh, mw * 0.16);
          ctx.fill();
          if (lockedIn) text('?', X + mw / 2, Y + mh / 2, mh * 0.4, '#0b1c27', 'center', 800);
        }
      }
    });
    return;
  }
  // lobby and the end of a game
  const over = S.ph === 'over';
  text(over ? 'STANDINGS' : 'ROBOTS READY', x0, py + 16, 11, C.rim, 'left', 800);
  const bh = Math.min(48, Math.max(34, ph * 0.2));
  const by = py + ph - bh - 14;
  const rows = over ? standings() : S.rd.map((id, i) => ({ id, seat: i, sc: null }));
  const rh = Math.min(26, Math.max(14, (by - py - 36) / Math.max(1, rows.length)));
  rows.forEach((r, i) => {
    const y = py + 30 + i * rh;
    if (y + rh > by - 4) return;
    ctx.fillStyle = over ? colorOfSeat(r.seat) : PAL[i % PAL.length];
    ctx.beginPath();
    ctx.arc(x0 + 6, y + rh / 2, 5, 0, Math.PI * 2);
    ctx.fill();
    text(clip((over ? (i + 1) + '. ' : '') + nickOf(r.id), Math.min(14, rh * 0.6), inner - 60, 600), x0 + 18, y + rh / 2, Math.min(14, rh * 0.6), C.text, 'left', 600);
    if (over) text(String(r.sc), x0 + inner, y + rh / 2, Math.min(15, rh * 0.62), C.gold, 'right', 800);
  });
  const left = Math.max(0, Math.ceil((endAt - now) / 1000));
  button('go', (over ? 'PLAY AGAIN' : 'START NOW') + ' · ' + left, x0, by, inner, bh, C.rim, true);
}

function drawOverlay(now, scoreOf) {
  const { bx, by, bs } = G;
  if (haveTable && S.ph !== 'lobby' && S.ph !== 'over') return;
  ctx.fillStyle = 'rgba(6,16,23,0.72)';
  rr(bx + bs * 0.08, by + bs * 0.24, bs * 0.84, bs * 0.52, 18);
  ctx.fill();
  ctx.strokeStyle = alpha(C.rim, 0.6);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const cx = bx + bs / 2;
  const tw = bs * 0.76;
  if (!haveTable || S.ph === 'lobby') {
    text('WIND-UP', cx, by + bs * 0.34, bs * 0.09, C.rim, 'center', 900, tw);
    text('Pick three cards. Every robot runs at once.', cx, by + bs * 0.45, bs * 0.04, C.text, 'center', 600, tw);
    text('Shove rivals into the gaps and take their coins.', cx, by + bs * 0.51, bs * 0.04, C.text, 'center', 600, tw);
    const msg = !haveTable ? 'Waiting for the host…'
      : S.rd.length >= 2 || solo() ? 'Starting in ' + Math.max(0, Math.ceil((endAt - now) / 1000))
        : 'Waiting for players · bots join in ' + Math.max(0, Math.ceil((endAt - now) / 1000));
    text(msg, cx, by + bs * 0.64, bs * 0.045, C.dim, 'center', 700, tw);
    return;
  }
  const st = standings();
  if (!st.length) {
    text('Game over', cx, by + bs * 0.5, bs * 0.075, C.text, 'center', 900, tw);
    return;
  }
  const top = st[0].sc;
  const winners = st.filter((r) => r.sc === top);
  const name = winners.length > 1 ? 'A tie at ' + top + '!' : nickOf(winners[0].id) + (winners[0].id === myId() ? ' win!' : ' wins!');
  const col = winners.length > 1 ? C.gold : colorOfSeat(winners[0].seat);
  if (winners.length === 1) {
    const bob = Math.sin(now / 300) * bs * 0.01;
    drawRobot(cx, by + bs * 0.37 + bob, bs * 0.13, Math.sin(now / 500) * 0.15, col, { scale: 1, spin: now / 120 });
    drawCrown(cx, by + bs * 0.29 + bob, bs * 0.06);
  }
  text(name, cx, by + bs * 0.5, bs * 0.075, col, 'center', 900, tw);
  text(top + (top === 1 ? ' coin' : ' coins'), cx, by + bs * 0.58, bs * 0.045, C.gold, 'center', 700, tw);
  text('Next game in ' + Math.max(0, Math.ceil((endAt - now) / 1000)) + 's', cx, by + bs * 0.67, bs * 0.04, C.dim, 'center', 600, tw);
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

function act(id) {
  if (id === 'mute') { muted = !muted; if (!muted) sfx.pick(1); return; }
  if (id === 'go') return go();
  if (id === 'lock') return lockIn();
  if (id[0] === 'h') return toggle(Number(id.slice(1)));
  if (id[0] === 's') return unslot(Number(id.slice(1)));
}

// A tap is the press itself: nothing here waits for a long press, which a
// phone keeps for itself.
cv.addEventListener('pointerdown', (e) => {
  audio();
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { act(h.id); e.preventDefault(); return; }
  }
});
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  audio();
  const k = e.key;
  if (k >= '1' && k <= '5') { toggle(Number(k) - 1); return; }
  if (k === 'Backspace') { if (mySel.length) unslot(mySel.length - 1); e.preventDefault(); return; }
  if (k === 'Enter' || k === ' ') {
    if (S.ph === 'plan') lockIn(); else go();
    e.preventDefault();
    return;
  }
  if (k === 'm' || k === 'M') act('mute');
});

// ── start ───────────────────────────────────────────────────────────────────

if (amHost()) {
  ready.add(myId());
  haveTable = true;
  hostLobby(performance.now());
}
setInterval(() => {
  try {
    hostTick();
    clientTick();
  } catch (e) {
    // A bad tick is skipped; the next one runs on the same table.
  }
}, 100);
requestAnimationFrame(frame);
