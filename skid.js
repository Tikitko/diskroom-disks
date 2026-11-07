/**
 * @disk     skid
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Penguins on an ice floe skid until they hit something. Everyone gets the same puzzle at once: bring the hungry penguin to the fish in the fewest slides, using the others as stoppers. The first answer starts a countdown to beat it.
 * @tags     game, party, puzzle, board, ice
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/skid.png
 */
// skid.js — a sliding-penguin puzzle race, run by the host.
//
// Every round lays a fresh floe: rocks, a few snowdrifts, four penguins and a
// fish. A penguin pushed in a direction skids until a rock, the edge or
// another penguin stops it, or it runs into a snowdrift and sticks there. The
// penguin in the gold scarf is hungry, and the round is about bringing it to
// rest on the fish; the other three exist to be skidded into place as
// stoppers. Everyone works the same floe at once on a copy of their own, and
// the fewest slides takes the round.
//
// The host is the authority. A solution travels to the host alone, addressed,
// so nobody else has it on the wire; the host replays it on the floe and only
// then counts it, and what the room hears is how many slides it took, never
// the slides themselves. The first solution in starts a countdown to beat it;
// a shorter one later buys a few more seconds. When the round closes the
// winning path is played out on everybody's floe — or, if nobody found one,
// the shortest the host's own search found. What this does not stop is a
// hostile host: its copy holds every solution sent in and the shortest path,
// and nothing in a host-run game can take that away from it.
//
// A player alone is dealt a practice game against two bots at once, and
// another after it, for as long as nobody else is here. When somebody joins,
// practice ends three seconds on under a note that says so, and the host deals
// the real game. Bots never sit at a real table.

// ── rules ───────────────────────────────────────────────────────────────────

const N = 12;                  // the floe is N x N cells
const CELLS = N * N;
const ROUNDS = 5;              // the last one pays double
const MAX_MOVES = 24;          // a longer answer is not an answer
const SOLVE_MS = 90000;        // the most a round can run, on the host's clock
const CLAIM_MS = 25000;        // after the first answer, this long at most to beat it
const BEAT_MS = 12000;         // a new shortest answer leaves at least this long
const LOBBY_MS = 4000;
const ALONE_MS = 8000;         // a host whose room has not said hello waits this long, then deals bots in
const JOIN_MS = 3000;          // practice runs on this long after somebody joins
const OVER_MS = 14000;
const GRACE = 8000;            // how long a dropped connection has to come back
const SHOW_LEAD = 1300;        // a reveal waits this long before the first slide
const SHOW_STEP = 520;         // one slide of a reveal
const SHOW_TAIL = 2800;        // and stays up this long after the last
const MAX_SEATS = 8;
const SEARCH_DEPTH = 7;        // the host's search looks this many slides deep
const SEARCH_CAP = 120000;     // and keeps at most this many positions
const DX = [0, 1, 0, -1];      // directions: 0 up, 1 right, 2 down, 3 left
const DY = [-1, 0, 1, 0];
const BOT_NAMES = ['Bot Pip', 'Bot Nell'];
const PHASES = ['lobby', 'solve', 'show', 'over'];

// One colour per seat, so no two players at a table share one.
const PAL = ['#ff7a8a', '#4fc3ff', '#8be36b', '#c79bff', '#ffb35c', '#3fe0c0', '#ff8bd1', '#e6edf5'];
// Scarves: gold is the hungry penguin; the stoppers wear the rest.
const SCARF = ['#ffc23d', '#5fd4ff', '#c79bff', '#7ff0b2'];
const C = {
  bg0: '#123a52', bg1: '#071726', panel: 'rgba(8,24,40,0.9)', line: '#24506e',
  text: '#eef8ff', dim: '#a9c6db', faint: '#6f90a8',
  ice0: '#d9f2ff', ice1: '#b4def5', iceLine: 'rgba(70,140,190,0.18)', rim: '#e9f8ff',
  rock: '#5d7489', rockTop: '#8aa2b6', rockDeep: '#3b4d5e',
  snow: '#ffffff', snowShade: '#d5e9f6',
  fish: '#ff8a5c', fishDeep: '#d4553a',
  gold: '#ffc23d', goldDeep: '#4a3306', red: '#ff6b6b', good: '#8be36b',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ── the floe ────────────────────────────────────────────────────────────────

// A board is CELLS numbers: 0 ice, 1 rock, 2 snowdrift.
// Where penguin i ends up when pushed in direction d: it skids cell by cell
// until the next one is off the floe, a rock or another penguin, and stops on
// the first snowdrift it enters.
function slide(bd, pos, i, d) {
  let x = pos[i] % N, y = (pos[i] / N) | 0;
  for (;;) {
    const nx = x + DX[d], ny = y + DY[d];
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) break;
    const c = ny * N + nx;
    if (bd[c] === 1) break;
    let hit = false;
    for (let k = 0; k < pos.length; k++) if (k !== i && pos[k] === c) { hit = true; break; }
    if (hit) break;
    x = nx;
    y = ny;
    if (bd[c] === 2) break;
  }
  return y * N + x;
}

// Plays a list of moves (penguin * 4 + direction) from `start`. A push that
// moves nothing is not a move, so a path holding one is refused whole.
function replay(bd, start, path) {
  const pos = start.slice();
  for (const m of path) {
    const i = m >> 2, d = m & 3;
    const to = slide(bd, pos, i, d);
    if (to === pos[i]) return null;
    pos[i] = to;
  }
  return pos;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeBoard(empty) {
  const bd = new Array(CELLS).fill(0);
  if (empty) return bd;
  const put = (c, v) => { if (c >= 0 && c < CELLS && bd[c] === 0) bd[c] = v; };
  // Short walls of two rocks, single rocks between them, and a few drifts.
  for (let k = 0; k < 5; k++) {
    const x = 1 + Math.floor(Math.random() * (N - 3)), y = 1 + Math.floor(Math.random() * (N - 3));
    const c = y * N + x;
    put(c, 1);
    put(Math.random() < 0.5 ? c + 1 : c + N, 1);
  }
  for (let k = 0; k < 9; k++) put(Math.floor(Math.random() * CELLS), 1);
  for (let k = 0; k < 4; k++) put(Math.floor(Math.random() * CELLS), 2);
  return bd;
}

// The host's search: breadth first from the start, the three stoppers taken
// as one unordered set since they are interchangeable, so a position is the
// hungry penguin's cell and three sorted cells. It records, for every cell and
// every depth, the first position found with the hungry penguin resting
// there — the shortest answer for a fish on that cell, and longer ones too.
const K1 = CELLS, K2 = CELLS * CELLS, K3 = K2 * CELLS;
function keyOf(h, a, b, c) {
  let t;
  if (a > b) { t = a; a = b; b = t; }
  if (b > c) { t = b; b = c; c = t; }
  if (a > b) { t = a; a = b; b = t; }
  return h * K3 + a * K2 + b * K1 + c;
}

function explore(bd, pg, maxDepth, cap) {
  const keys = new Int32Array(cap), par = new Int32Array(cap), mv = new Int16Array(cap), dep = new Uint8Array(cap);
  const M1 = maxDepth + 1;
  const first = new Int32Array(CELLS * M1).fill(-1);
  const seen = new Map();
  const k0 = keyOf(pg[0], pg[1], pg[2], pg[3]);
  keys[0] = k0; par[0] = -1; mv[0] = -1; dep[0] = 0;
  seen.set(k0, 0);
  first[pg[0] * M1] = 0;
  let n = 1;
  const pos = [0, 0, 0, 0];
  for (let q = 0; q < n && n < cap; q++) {
    if (dep[q] >= maxDepth) break;
    let k = keys[q];
    pos[0] = (k / K3) | 0; k -= pos[0] * K3;
    pos[1] = (k / K2) | 0; k -= pos[1] * K2;
    pos[2] = (k / K1) | 0; pos[3] = k - pos[2] * K1;
    for (let i = 0; i < 4 && n < cap; i++) {
      for (let d = 0; d < 4 && n < cap; d++) {
        const from = pos[i];
        const to = slide(bd, pos, i, d);
        if (to === from) continue;
        pos[i] = to;
        const nk = keyOf(pos[0], pos[1], pos[2], pos[3]);
        const hc = pos[0];
        pos[i] = from;
        if (seen.has(nk)) continue;
        seen.set(nk, n);
        keys[n] = nk; par[n] = q; mv[n] = from * 4 + d; dep[n] = dep[q] + 1;
        const fi = hc * M1 + dep[n];
        if (first[fi] < 0) first[fi] = n;
        n++;
      }
    }
  }
  return { par, mv, first, M1 };
}

// A recorded position back to the moves that reach it, as penguin * 4 + dir.
function pathTo(ex, idx, bd, pg) {
  const raw = [];
  for (let q = idx; q > 0; q = ex.par[q]) raw.push(ex.mv[q]);
  raw.reverse();
  const pos = pg.slice(), out = [];
  for (const m of raw) {
    const from = m >> 2, d = m & 3;
    const i = pos.indexOf(from);
    if (i < 0) return null;
    pos[i] = slide(bd, pos, i, d);
    out.push(i * 4 + d);
  }
  return out;
}

// Paths for a fish on `f`: the shortest, and one and two slides longer where
// the search found them (the bots' first, rougher answers).
function answersFor(ex, bd, pg, f) {
  let opt = -1;
  for (let d = 1; d < ex.M1; d++) if (ex.first[f * ex.M1 + d] >= 0) { opt = d; break; }
  if (opt < 0) return null;
  const paths = [];
  for (let d = opt; d <= Math.min(ex.M1 - 1, opt + 2); d++) {
    const idx = ex.first[f * ex.M1 + d];
    paths.push(idx >= 0 ? pathTo(ex, idx, bd, pg) : null);
  }
  if (!paths[0]) return null;
  return { opt, paths };
}

// A floe worth solving: the fish sits where the shortest answer is four or
// five slides, so it takes some thought and still fits in a round. A floe
// with no such cell is thrown away; after a few, the range widens.
function makePuzzle() {
  for (let tries = 0; tries < 40; tries++) {
    const bd = makeBoard(tries >= 36);
    const free = [];
    for (let c = 0; c < CELLS; c++) if (bd[c] === 0) free.push(c);
    shuffle(free);
    const pg = free.slice(0, 4);
    const ex = explore(bd, pg, SEARCH_DEPTH, SEARCH_CAP);
    const lo = tries < 8 ? 4 : tries < 20 ? 3 : 1;
    const hi = tries < 8 ? 5 : tries < 20 ? 6 : SEARCH_DEPTH;
    const cands = [];
    for (let c = 0; c < CELLS; c++) {
      if (pg.includes(c) || bd[c] === 1) continue;
      for (let d = 1; d < ex.M1; d++) {
        if (ex.first[c * ex.M1 + d] < 0) continue;
        if (d >= lo && d <= hi) cands.push(c);
        break;
      }
    }
    if (!cands.length) continue;
    const f = cands[Math.floor(Math.random() * cands.length)];
    const ans = answersFor(ex, bd, pg, f);
    if (ans) return { bd, pg, f, opt: ans.opt, paths: ans.paths };
  }
  // An empty floe always has an answer: the hungry penguin skids to an edge.
  const bd = makeBoard(true);
  const pg = [5 * N + 5, 0, N - 1, CELLS - 1];
  return { bd, pg, f: 5 * N, opt: 1, paths: [[3]] };
}

// ── state ───────────────────────────────────────────────────────────────────

// The public table: every copy holds this, the host's copy is the truth.
//   g      game number, so a stale answer for an old game is recognised
//   ph     'lobby' | 'solve' | 'show' | 'over'
//   rd     round, 1..ROUNDS
//   bd     the floe; pg the four penguins' cells, the hungry one first; f the fish
//   seats  [{ id, seat, sc, bot }]
//   cl     answers in: [[id, slides, order]] — never the slides themselves
//   ld     the leader as the round began, whose answer counts one slide more
//   last   the reveal: { w, p, n, o, gn } — winner (null if none), the path
//          played out, its length, the shortest possible, [[id, points]]
//   rdy    players whose disk runs and who play from the next deal
function blankTable(g) {
  return { g, ph: 'lobby', rd: 0, bd: [], pg: [], f: -1, seats: [], cl: [], ld: null, last: null, rdy: [] };
}
let S = blankTable(0);
let haveTable = false;
let tableHost = null;    // whose table this copy holds
let endAt = 0;           // local clock: when this phase ends
let joinEnd = 0;         // local clock: when practice ends for somebody who joined, 0 if it does not

// The host's alone.
const ready = new Set();
const sols = new Map();      // id -> { n, ord, path }, never broadcast
const botPlans = new Map();  // bot id -> [{ at, path }]
const parked = new Map();    // id -> score, for a player who stepped out mid-game
const lastReply = new Map();
let P = null;                // { opt, paths } for the floe on the table
let ord = 0;
let solveEnd = 0;
let shortAt = 0;
let lastPub = 0;

// Mine.
let local = { key: '', pos: [], moves: [], anim: null, nudge: null };
let sel = 0;
let mySol = null;            // { key, path }, my shortest answer this round
let lastSolSend = -1e9;
let helloAt = -1e9;
let goAt = -1e9;

const nicks = new Map();
const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const amHost = () => !room.me || (room.host !== null && room.host.id === room.me.id);
const fromHost = (from) => room.host !== null && from === room.host.id;
const inRoom = (id) => room.players.some((p) => p.id === id);
// Bots (ids below -1) sit only at a practice table the host dealt; -1 is me
// with no room around me.
const isBot = (id) => id < -1;
const present = (id) => (isBot(id) ? true : id === -1 ? solo() : inRoom(id));
const key = () => S.g + ':' + S.rd;
const seatOf = (id) => S.seats.find((s) => s.id === id) || null;
const mySeat = () => seatOf(myId());
const claimOf = (id) => S.cl.find((c) => c[0] === id) || null;
const practiceTable = () => S.ph !== 'lobby' && S.seats.some((s) => s.bot);
const readyHumans = () => [...ready].filter((id) => !isBot(id) && present(id));

function nickOf(id) {
  if (id === myId()) return 'You';
  if (isBot(id)) return BOT_NAMES[(-id - 2) % BOT_NAMES.length];
  const p = room.players.find((x) => x.id === id);
  if (p) { nicks.set(id, p.nick); return p.nick; }
  return nicks.get(id) || 'Player';
}
function colorOf(id) {
  const s = seatOf(id);
  return s ? PAL[s.seat % PAL.length] : C.dim;
}
const showTotal = (n) => SHOW_LEAD + n * SHOW_STEP + SHOW_TAIL;

// ── the host ────────────────────────────────────────────────────────────────

// Alone in the room, practice starts at once; with others in it, the host
// waits a few seconds for their disks to say hello.
function hostLobby(now) {
  S = blankTable(S.g);
  endAt = now + (solo() || room.players.length < 2 ? 400 : readyHumans().length >= 2 ? LOBBY_MS : ALONE_MS);
  publish(now);
}

function freeSeat() {
  for (let s = 0; s < MAX_SEATS; s++) if (!S.seats.some((x) => x.seat === s)) return s;
  return -1;
}
function addSeat(id, sc) {
  const seat = freeSeat();
  if (seat < 0) return false;
  S.seats.push({ id, seat, sc, bot: isBot(id) });
  return true;
}

function startGame(now) {
  const humans = readyHumans().slice(0, MAX_SEATS);
  S = blankTable(S.g + 1);
  for (const id of humans) addSeat(id, 0);
  // A practice table: one person alone plays against two bots.
  if (humans.length < 2) for (let i = 0; i < BOT_NAMES.length; i++) addSeat(-2 - i, 0);
  parked.clear();
  shortAt = 0;
  joinEnd = 0;
  nextRound(now);
}

// The roster changes only between rounds, so nobody is seated half way
// through a floe they never saw from the start.
function nextRound(now) {
  const practice = S.seats.some((s) => s.bot);
  S.seats = S.seats.filter((s) => {
    if (present(s.id)) return true;
    parked.set(s.id, s.sc);
    return false;
  });
  if (!practice) {
    for (const id of readyHumans()) {
      if (seatOf(id)) continue;
      if (addSeat(id, parked.get(id) || 0)) parked.delete(id);
    }
  }
  S.rd++;
  if (S.rd > ROUNDS) { finish(now); return; }
  let top = -1, count = 0, lead = null;
  for (const s of S.seats) {
    if (s.sc > top) { top = s.sc; count = 1; lead = s.id; } else if (s.sc === top) count++;
  }
  S.ld = top > 0 && count === 1 ? lead : null;
  const pz = makePuzzle();
  S.bd = pz.bd;
  S.pg = pz.pg;
  S.f = pz.f;
  P = { opt: pz.opt, paths: pz.paths };
  S.ph = 'solve';
  S.cl = [];
  S.last = null;
  sols.clear();
  ord = 0;
  endAt = solveEnd = now + SOLVE_MS;
  planBots(now);
  publish(now);
}

// A bot's answers arrive on a timer: the rougher ones first when the search
// found any, the shortest later, and now and then never.
function planBots(now) {
  botPlans.clear();
  for (const s of S.seats) {
    if (!s.bot) continue;
    const list = [];
    let t = now + 15000 + Math.random() * 15000;
    let any = false;
    for (let k = Math.min(2, P.paths.length - 1); k >= 0; k--) {
      const p = P.paths[k];
      if (!p) continue;
      if (k === 0 && Math.random() < 0.4) break;
      if (k === 0 && !any) t += 15000 + Math.random() * 15000;
      list.push({ at: t, path: p });
      any = true;
      t += 9000 + Math.random() * 16000;
    }
    botPlans.set(s.id, list);
  }
}

// An answer, from whoever the room says sent it: for this game and round, from
// somebody seated and here, a path of real moves that leaves the hungry
// penguin on the fish, and shorter than what that player already has in.
function hostSol(id, path, now) {
  if (S.ph !== 'solve') return;
  const s = seatOf(id);
  if (!s || !present(id)) return;
  if (!Array.isArray(path) || path.length < 1 || path.length > MAX_MOVES) return;
  for (const m of path) if (!Number.isInteger(m) || m < 0 || m > 15) return;
  const end = replay(S.bd, S.pg, path);
  if (!end || end[0] !== S.f) return;
  const prior = sols.get(id);
  if (prior && prior.n <= path.length) return;
  const bestBefore = bestN();
  sols.set(id, { n: path.length, ord: ++ord, path: path.slice() });
  S.cl = [...sols].map(([k, v]) => [k, v.n, v.ord]);
  if (bestBefore === 0) endAt = Math.min(endAt, now + CLAIM_MS);
  else if (path.length < bestBefore) endAt = Math.min(solveEnd, Math.max(endAt, now + BEAT_MS));
  publish(now);
}
function bestN() {
  let b = 0;
  for (const v of sols.values()) if (!b || v.n < b) b = v.n;
  return b;
}

function reveal(now) {
  const base = S.rd === ROUNDS ? 2 : 1;
  let win = null, best = null;
  for (const [id, v] of sols) {
    if (!seatOf(id)) continue;
    const eff = v.n + (id === S.ld ? 1 : 0);
    if (!best || eff < best.eff || (eff === best.eff && v.ord < best.ord)) best = { eff, ord: v.ord, id };
  }
  if (best) win = best.id;
  const gn = [];
  for (const [id, v] of sols) {
    const s = seatOf(id);
    if (!s) continue;
    const pts = base * (id === win ? 3 : 1) + (P && v.n <= P.opt ? base : 0);
    s.sc += pts;
    gn.push([id, pts]);
  }
  const path = win !== null ? sols.get(win).path : (P ? P.paths[0] : []);
  // Without a path to play out there is nothing to reveal but the points.
  S.last = path.length ? { w: win, p: path.slice(), n: path.length, o: P ? P.opt : path.length, gn } : null;
  S.ph = 'show';
  botPlans.clear();
  endAt = now + (S.last ? showTotal(path.length) : 1500);
  publish(now);
}

function finish(now) {
  S.ph = 'over';
  S.rd = Math.min(S.rd, ROUNDS);
  botPlans.clear();
  endAt = now + OVER_MS;
  publish(now);
}

// A real table with fewer than two people at it ends — but not on the
// instant: a dropped connection comes back as a leave and a join, and one
// blip must not end everybody's game.
function tooFew(now) {
  if (S.seats.some((s) => s.bot)) return false;
  if (S.seats.filter((s) => present(s.id)).length >= 2) { shortAt = 0; return false; }
  if (!shortAt) shortAt = now;
  return now - shortAt > GRACE;
}

function hostTick() {
  if (!amHost() || !haveTable) return;
  const now = performance.now();
  // Somebody joined a practice game: it ends three seconds on, for the real one.
  if (readyHumans().length >= 2 && practiceTable()) {
    if (!joinEnd) { joinEnd = now + JOIN_MS; publish(now); }
    else if (now >= joinEnd) { startGame(now); return; }
  } else if (joinEnd) { joinEnd = 0; publish(now); }
  if (S.ph === 'lobby') {
    if (now >= endAt) startGame(now);
    else if (now - lastPub > 2500) publish(now);
    return;
  }
  if (S.ph !== 'over' && tooFew(now)) { finish(now); return; }
  if (S.ph === 'solve') {
    for (const [id, list] of botPlans) {
      while (list.length && now >= list[0].at) hostSol(id, list.shift().path, now);
    }
    // Every seat already has the shortest possible in: nothing is left to beat.
    const seated = S.seats.filter((s) => present(s.id));
    const done = P && seated.length > 0 && seated.every((s) => { const v = sols.get(s.id); return v && v.n <= P.opt; });
    if (now >= endAt || done) { reveal(now); return; }
  } else if (S.ph === 'show') {
    if (now >= endAt) { nextRound(now); return; }
  } else if (S.ph === 'over') {
    if (now >= endAt) { startGame(now); return; }
  }
  // The table goes out again every few seconds: any one message can be lost
  // for the whole room, and a copy that missed one picks up the next.
  if (now - lastPub > 2500) publish(now);
}

function hostHello(from, now) {
  ready.add(from);
  if (S.ph === 'lobby' && readyHumans().length >= 2) endAt = Math.min(endAt, now + LOBBY_MS);
  // A copy that asks twice in a second is answered once.
  if (now - (lastReply.get(from) || -1e9) < 1000) return;
  lastReply.set(from, now);
  room.send(wire(now), { to: from });
}

function hostGo(now) {
  if (S.ph !== 'lobby' && S.ph !== 'over') return;
  if (endAt > now + 1500) {
    endAt = now + 1500;
    publish(now);
  }
}

function wire(now) {
  const st = [];
  for (const s of S.seats) st.push(s.id, s.seat, s.sc, s.bot ? 1 : 0);
  const cl = [];
  for (const c of S.cl) cl.push(c[0], c[1], c[2]);
  let la = null;
  if (S.last && S.ph === 'show') {
    const gn = [];
    for (const g of S.last.gn) gn.push(g[0], g[1]);
    la = { w: S.last.w, p: S.last.p, n: S.last.n, o: S.last.o, gn };
  }
  return {
    t: 'st', g: S.g, ph: S.ph, rd: S.rd, bd: S.bd.join(''), pg: S.pg, f: S.f, st, cl,
    ld: S.ld, la, rdy: readyHumans().filter((id) => id >= 0).slice(0, MAX_SEATS),
    ms: Math.max(0, Math.round(endAt - now)),
    j: joinEnd ? Math.max(0, Math.round(joinEnd - now)) : -1,
  };
}

function publish(now) {
  lastPub = now;
  S.rdy = readyHumans().slice(0, MAX_SEATS);
  if (!solo()) room.send(wire(now));
  tableHost = room.host ? room.host.id : null;
  observe(now);
}

// ── reading what arrives ────────────────────────────────────────────────────

// The host's table is checked field by field before it replaces mine: a copy
// that breaks on a malformed one is a copy the host can switch off.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID_MIN = -9, ID_MAX = Number.MAX_SAFE_INTEGER;
const isId = (v) => int(v, ID_MIN, ID_MAX);
const isMove = (m) => int(m, 0, 15);

function readTable(m) {
  if (!int(m.g, 0, 1e9) || !PHASES.includes(m.ph) || !int(m.rd, 0, ROUNDS + 1)) return null;
  if (typeof m.ms !== 'number' || !Number.isFinite(m.ms)) return null;
  let bd = [], pg = [], f = -1;
  if (m.ph === 'solve' || m.ph === 'show') {
    if (typeof m.bd !== 'string' || !/^[012]{144}$/.test(m.bd)) return null;
    bd = Array.from(m.bd, (ch) => ch.charCodeAt(0) - 48);
    if (!Array.isArray(m.pg) || m.pg.length !== 4 || !m.pg.every((c) => int(c, 0, CELLS - 1))) return null;
    if (new Set(m.pg).size !== 4 || m.pg.some((c) => bd[c] === 1)) return null;
    if (!int(m.f, 0, CELLS - 1) || bd[m.f] === 1) return null;
    pg = m.pg.slice();
    f = m.f;
  }
  if (!Array.isArray(m.st) || m.st.length > MAX_SEATS * 4 || m.st.length % 4) return null;
  const seats = [];
  const ids = new Set(), seatNos = new Set();
  for (let i = 0; i < m.st.length; i += 4) {
    const [id, seat, sc, bot] = m.st.slice(i, i + 4);
    if (!isId(id) || !int(seat, 0, MAX_SEATS - 1) || !int(sc, 0, 9999) || !int(bot, 0, 1)) return null;
    if (ids.has(id) || seatNos.has(seat)) return null;
    ids.add(id);
    seatNos.add(seat);
    seats.push({ id, seat, sc, bot: bot === 1 });
  }
  if (!Array.isArray(m.cl) || m.cl.length > MAX_SEATS * 3 || m.cl.length % 3) return null;
  const cl = [];
  for (let i = 0; i < m.cl.length; i += 3) {
    const [id, n, o] = m.cl.slice(i, i + 3);
    if (!ids.has(id) || !int(n, 1, MAX_MOVES) || !int(o, 1, 1e6) || cl.some((c) => c[0] === id)) return null;
    cl.push([id, n, o]);
  }
  if (!(m.ld === null || (isId(m.ld) && ids.has(m.ld)))) return null;
  let last = null;
  if (m.la !== null && m.la !== undefined) {
    if (m.ph !== 'show') return null;
    const l = m.la;
    if (!l || typeof l !== 'object' || !(l.w === null || (isId(l.w) && ids.has(l.w)))) return null;
    if (!Array.isArray(l.p) || l.p.length < 1 || l.p.length > MAX_MOVES || !l.p.every(isMove)) return null;
    if (l.n !== l.p.length || !int(l.o, 1, MAX_MOVES)) return null;
    const end = replay(bd, pg, l.p);
    if (!end || end[0] !== f) return null;
    if (!Array.isArray(l.gn) || l.gn.length > MAX_SEATS * 2 || l.gn.length % 2) return null;
    const gn = [];
    for (let i = 0; i < l.gn.length; i += 2) {
      if (!ids.has(l.gn[i]) || !int(l.gn[i + 1], 0, 20)) return null;
      gn.push([l.gn[i], l.gn[i + 1]]);
    }
    last = { w: l.w, p: l.p.slice(), n: l.n, o: l.o, gn };
  }
  const idList = (a) => Array.isArray(a) && a.length <= MAX_SEATS && a.every(isId);
  if (!idList(m.rdy)) return null;
  return {
    S: { g: m.g, ph: m.ph, rd: m.rd, bd, pg, f, seats, cl, ld: m.ld, last, rdy: m.rdy.slice() },
    ms: Math.min(Math.max(m.ms, 0), SOLVE_MS + showTotal(MAX_MOVES)),
    j: typeof m.j === 'number' && Number.isFinite(m.j) && m.j >= 0 ? Math.min(m.j, JOIN_MS) : -1,
  };
}

// Every sender gets a bucket: ten messages a second, twenty at once. An honest
// copy sends a handful a round; one that floods is dropped here before any of
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
      case 'sol':
        if (amHost() && inRoom(from) && msg.g === S.g && msg.rd === S.rd) hostSol(from, msg.m, now);
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
  // The old host's answers and search left with it. Whoever is seated plays
  // on; every copy sends its answer again when it sees this table without it.
  ready.clear();
  ready.add(myId());
  for (const s of S.seats) if (!s.bot && present(s.id)) ready.add(s.id);
  for (const id of S.rdy) if (present(id)) ready.add(id);
  if (!haveTable || S.ph === 'lobby') {
    haveTable = true;
    hostLobby(now);
    return;
  }
  if (S.ph === 'solve' || S.ph === 'show') {
    const ex = explore(S.bd, S.pg, SEARCH_DEPTH, SEARCH_CAP);
    P = answersFor(ex, S.bd, S.pg, S.f);
  }
  if (S.ph === 'solve') {
    sols.clear();
    ord = 0;
    S.cl = [];
    if (mySol && mySol.key === key()) hostSol(myId(), mySol.path, now);
    solveEnd = now + SOLVE_MS;
    endAt = Math.max(endAt, now + 8000);
    if (P) planBots(now);
  } else if (S.ph === 'over') {
    endAt = Math.max(endAt, now + 3000);
  }
  shortAt = 0;
  publish(now);
});

// ── my moves ────────────────────────────────────────────────────────────────

const onFloe = () => (S.ph === 'solve' || S.ph === 'show') && S.pg.length === 4;
const canSlide = () => S.ph === 'solve' && local.key === key();

function syncLocal() {
  if (local.key === key() || !onFloe()) return;
  local = { key: key(), pos: S.pg.slice(), moves: [], anim: null, nudge: null };
  sel = 0;
  mySol = null;
}

function move(i, d) {
  if (!canSlide() || i < 0 || i > 3) return;
  const now = performance.now();
  const from = local.pos[i];
  if (local.moves.length >= MAX_MOVES) { sfx.stuck(); local.nudge = { i, d, t0: now }; return; }
  const to = slide(S.bd, local.pos, i, d);
  if (to === from) { sfx.stuck(); local.nudge = { i, d, t0: now }; return; }
  const dist = Math.abs((to % N) - (from % N)) + Math.abs(((to / N) | 0) - ((from / N) | 0));
  local.pos[i] = to;
  local.moves.push({ m: i * 4 + d, from });
  local.anim = { i, from, to, d, t0: now, dur: 70 + dist * 45, landed: false };
  sel = i;
  sfx.slide(dist);
}

function undo() {
  if (!canSlide() || !local.moves.length) return;
  const last = local.moves.pop();
  const i = last.m >> 2;
  local.pos[i] = last.from;
  local.anim = null;
  sel = i;
  sfx.undo();
}
function reset() {
  if (!canSlide() || !local.moves.length) return;
  local.pos = S.pg.slice();
  local.moves = [];
  local.anim = null;
  sel = 0;
  sfx.undo();
}

// Checked every frame and every tick, so an answer goes out even while the
// page is in the background and draws nothing.
function settle(now) {
  const a = local.anim;
  if (a && local.key === key() && !a.landed && now - a.t0 >= a.dur) { a.landed = true; landed(a, now); }
}

// A slide that has finished skidding: a puff of snow, and if it was the hungry
// penguin coming to rest on the fish, the answer goes to the host.
function landed(a, now) {
  const p = G ? cellCenter(a.to) : { x: 0, y: 0 };
  if (G) burst(p.x, p.y + G.cs * 0.3, '#ffffff', 7, G.cs * 1.4);
  sfx.bonk();
  if (a.i === 0 && local.pos[0] === S.f && local.key === key()) {
    const n = local.moves.length;
    sfx.gulp();
    if (G) {
      burst(p.x, p.y, C.fish, 18, G.cs * 3);
      pop(p.x, p.y - G.cs * 0.6, 'gulp!', C.gold);
    }
    if (!mySeat()) return;
    if (!mySol || n < mySol.path.length) {
      mySol = { key: key(), path: local.moves.map((x) => x.m) };
      sendSol(now);
    }
  }
}

function sendSol(now) {
  if (!mySol || mySol.key !== key() || S.ph !== 'solve') return;
  lastSolSend = now;
  if (amHost()) hostSol(myId(), mySol.path, now);
  else if (room.host) room.send({ t: 'sol', g: S.g, rd: S.rd, m: mySol.path }, { to: room.host.id });
}

function go() {
  const now = performance.now();
  if (S.ph !== 'lobby' && S.ph !== 'over') return;
  if (now - goAt < 1000) return;
  goAt = now;
  sfx.claim();
  if (amHost()) hostGo(now);
  else if (room.host) room.send({ t: 'go' }, { to: room.host.id });
}

// Whatever this copy still needs from the host it asks for, at most every
// two and a half seconds: the table, or a seat at the next deal.
function wantHello() {
  if (amHost() || !room.host || !room.me) return false;
  if (!haveTable || tableHost !== room.host.id) return true;
  return !S.rdy.includes(myId()) && !mySeat();
}
function clientTick() {
  const now = performance.now();
  settle(now);
  if (wantHello() && now - helloAt > 2500) {
    helloAt = now;
    room.send({ t: 'hello' }, { to: room.host.id });
  }
  // An answer the table does not show yet is sent again: it may have been
  // lost, or gone to a host that has since left.
  if (!amHost() && mySol && mySol.key === key() && S.ph === 'solve' && mySeat() && now - lastSolSend > 2000) {
    const c = claimOf(myId());
    if (!c || c[1] > mySol.path.length) sendSol(now);
  }
}

// ── what happened, for effects ──────────────────────────────────────────────

// Effects are drawn from the table as it changes on this screen, never sent.
let seenKey = '';
let seenPh = '';
let seenCl = new Map();
let roundAt = -1e9;
let showAt = -1e9;
let overAt = -1e9;
let firedSteps = 0;
let gainsShown = false;
const flashAt = new Map();   // id -> when their chip last flashed

function observe(now) {
  syncLocal();
  const k = key();
  if (S.ph === 'solve' && (k !== seenKey || seenPh !== 'solve')) {
    roundAt = now;
    sfx.round();
  }
  if (S.ph === 'show' && (k !== seenKey || seenPh !== 'show')) {
    const total = S.last ? showTotal(S.last.n) : 0;
    showAt = now - Math.max(0, total - Math.max(0, endAt - now));
    // Whoever arrives in the middle of a reveal sees the rest of it, not every
    // step that already played going off at once.
    firedSteps = stepsDone(now - showAt - SHOW_LEAD);
    gainsShown = S.last ? now - showAt >= total - SHOW_TAIL + 200 : true;
  }
  if (S.ph === 'over' && seenPh !== 'over') {
    overAt = now;
    if (seenPh) celebrate();
  }
  if (k !== seenKey) seenCl = new Map();
  // A soft ping when somebody's answer comes in or gets shorter; mine already
  // had its gulp.
  if (S.ph === 'solve') {
    for (const [id, n] of S.cl) {
      const was = seenCl.get(id);
      if (was === undefined || n < was) {
        flashAt.set(id, now);
        if (id !== myId()) sfx.claim();
      }
    }
  }
  seenCl = new Map(S.cl.map((c) => [c[0], c[1]]));
  seenKey = k;
  seenPh = S.ph;
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
  slide: (n) => tone(720, 0.06 + n * 0.035, 'sine', 0.035, 300),
  bonk: () => tone(190, 0.08, 'triangle', 0.06, 110),
  stuck: () => tone(130, 0.09, 'square', 0.03, 100),
  undo: () => tone(420, 0.07, 'triangle', 0.04, 300),
  gulp: () => { tone(380, 0.08, 'sine', 0.08, 820); tone(880, 0.1, 'triangle', 0.05, 1400, 0.07); },
  claim: () => { tone(880, 0.07, 'triangle', 0.045); tone(1320, 0.09, 'triangle', 0.035, null, 0.06); },
  round: () => [392, 523, 659].forEach((f, i) => tone(f, 0.14, 'triangle', 0.05, null, i * 0.07)),
  step: () => tone(560, 0.07, 'sine', 0.04, 360),
  tick: () => tone(1200, 0.03, 'square', 0.025),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.06, null, i * 0.07)),
  none: () => [392, 330, 262].forEach((f, i) => tone(f, 0.2, 'sine', 0.05, null, i * 0.1)),
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

let W = 640, H = 480;
let coarse = matchMedia('(pointer: coarse)').matches;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  coarse = matchMedia('(pointer: coarse)').matches;
  W = cv.clientWidth || window.innerWidth || 640;
  H = cv.clientHeight || window.innerHeight || 480;
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
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
const fmtTime = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

// Where everything goes. A wide frame puts the panel beside the floe and the
// floe takes the whole height; a tall one stacks the status above and the
// scores and controls below, and the floe takes the whole width. Both are
// worked out and whichever draws the floe bigger is used.
let G = null;
const PAD = 10;
const NOTE_ROOM = 60;
function geom() {
  const n = Math.max(1, S.seats.length);
  const pw = clamp(W * 0.33, 190, 320);
  const bsA = Math.min(W - pw - PAD * 3, H - PAD * 2);
  const topH = 40, bandH = 26 + NOTE_ROOM;
  const cols = Math.max(2, Math.min(4, Math.floor((W - 2 * PAD) / 150)));
  const rows = Math.ceil(n / cols);
  const panelH = rows * 34 + 52 + 24;
  const bsB = Math.min(W - PAD * 2, H - topH - bandH - panelH - PAD);
  let g;
  if (bsA >= bsB) {
    const bs = Math.max(60, bsA);
    const total = bs + PAD + pw;
    const bx = Math.max(PAD, (W - total) / 2);
    g = { side: true, bx, by: (H - bs) / 2, bs, px: bx + bs + PAD, pw: Math.min(pw, W - bx - bs - PAD * 2), cols: 1 };
  } else {
    const bs = Math.max(60, bsB);
    const spare = Math.max(0, H - topH - bs - bandH - panelH - PAD);
    const by = topH + spare / 2;
    g = { side: false, bx: (W - bs) / 2, by, bs, topH, bandTop: by + bs, panelTop: by + bs + bandH, cols, panelH };
  }
  const fp = g.bs * 0.025;
  g.fp = fp;
  g.gx = g.bx + fp;
  g.gy = g.by + fp;
  g.cs = (g.bs - fp * 2) / N;
  return g;
}
function cellCenter(c) {
  return { x: G.gx + ((c % N) + 0.5) * G.cs, y: G.gy + (((c / N) | 0) + 0.5) * G.cs };
}
function cellAt(x, y) {
  if (!G) return -1;
  const cx = Math.floor((x - G.gx) / G.cs), cy = Math.floor((y - G.gy) / G.cs);
  if (cx < 0 || cy < 0 || cx >= N || cy >= N) return -1;
  return cy * N + cx;
}

// ── effects ─────────────────────────────────────────────────────────────────

const parts = [];
const pops = [];
let shake = 0;
function burst(x, y, color, n, speed) {
  for (let i = 0; i < n && parts.length < 300; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random() * 0.8);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.25, life: 1, decay: 1.4 + Math.random() * 1.2, color, r: 1.5 + Math.random() * 2.5 });
  }
}
function pop(x, y, s, color) { pops.push({ x, y, s, color, t: 0 }); }
function stepFx(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.vy += 260 * dt;
    p.vx *= 1 - 2 * dt;
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
function celebrate() {
  sfx.fanfare();
  const top = standings()[0];
  const color = top ? colorOf(top.id) : C.gold;
  for (let i = 0; i < 5; i++) burst(W * (0.15 + 0.7 * Math.random()), H * (0.25 + 0.3 * Math.random()), i % 2 ? color : C.gold, 22, 260);
}
function standings() { return S.seats.slice().sort((a, b) => b.sc - a.sc); }

// ── drawing the floe ────────────────────────────────────────────────────────

// A floe to look at before the first round is dealt.
const idle = (() => {
  const bd = makeBoard(false);
  const free = [];
  for (let c = 0; c < CELLS; c++) if (bd[c] === 0) free.push(c);
  shuffle(free);
  return { bd, pg: free.slice(0, 4), f: free[4] };
})();

function drawBackground(now) {
  const g = ctx.createRadialGradient(W / 2, H * 0.35, 10, W / 2, H * 0.5, Math.max(W, H) * 0.8);
  g.addColorStop(0, C.bg0);
  g.addColorStop(1, C.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Snow drifting down, each flake placed by its number alone.
  ctx.fillStyle = 'rgba(230,246,255,0.35)';
  for (let i = 0; i < 46; i++) {
    const s = ((i * 7919) % 1000) / 1000, u = ((i * 104729) % 1000) / 1000;
    const sp = 12 + u * 22;
    const y = ((now / 1000) * sp + s * (H + 20)) % (H + 20) - 10;
    const x = (s * W + Math.sin(now / 1500 + i) * 14 + W) % W;
    const r = 0.8 + u * 1.6;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBoard(now, bd, fish, fishEaten) {
  const { bx, by, bs, gx, gy, cs } = G;
  // The floe: a slab of ice with a bright rim and a soft shadow.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = bs * 0.04;
  ctx.shadowOffsetY = bs * 0.012;
  rr(bx, by, bs, bs, bs * 0.04);
  ctx.fillStyle = C.rim;
  ctx.fill();
  ctx.restore();
  const ig = ctx.createLinearGradient(gx, gy, gx + cs * N, gy + cs * N);
  ig.addColorStop(0, C.ice0);
  ig.addColorStop(1, C.ice1);
  rr(gx, gy, cs * N, cs * N, cs * 0.3);
  ctx.fillStyle = ig;
  ctx.fill();
  ctx.save();
  rr(gx, gy, cs * N, cs * N, cs * 0.3);
  ctx.clip();
  ctx.strokeStyle = C.iceLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < N; i++) {
    ctx.moveTo(gx + i * cs, gy); ctx.lineTo(gx + i * cs, gy + N * cs);
    ctx.moveTo(gx, gy + i * cs); ctx.lineTo(gx + N * cs, gy + i * cs);
  }
  ctx.stroke();
  // A few glints that sweep across the ice.
  const sw = ((now / 4200) % 1.6) - 0.3;
  const lg = ctx.createLinearGradient(gx + sw * N * cs - cs * 2, gy, gx + sw * N * cs + cs * 2, gy + N * cs);
  lg.addColorStop(0, 'rgba(255,255,255,0)');
  lg.addColorStop(0.5, 'rgba(255,255,255,0.22)');
  lg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = lg;
  ctx.fillRect(gx, gy, N * cs, N * cs);
  ctx.restore();
  for (let c = 0; c < CELLS; c++) {
    if (bd[c] === 0) continue;
    const x = gx + (c % N) * cs, y = gy + ((c / N) | 0) * cs;
    if (bd[c] === 1) drawRock(x, y, cs, c);
    else drawSnow(x, y, cs, c);
  }
  if (fish >= 0 && !fishEaten) {
    const p = { x: gx + ((fish % N) + 0.5) * cs, y: gy + (((fish / N) | 0) + 0.5) * cs };
    ctx.fillStyle = 'rgba(255,138,92,0.18)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, cs * (0.42 + 0.04 * Math.sin(now / 300)), 0, Math.PI * 2);
    ctx.fill();
    drawFish(p.x, p.y + Math.sin(now / 420) * cs * 0.04, cs * 0.62, Math.sin(now / 520) * 0.15);
  }
}

function drawRock(x, y, s, c) {
  const k = ((c * 37) % 7) / 7;
  const m = s * 0.08;
  rr(x + m, y + m + s * 0.06, s - 2 * m, s - 2 * m, s * 0.3);
  ctx.fillStyle = C.rockDeep;
  ctx.fill();
  rr(x + m, y + m, s - 2 * m, s - 2 * m - s * 0.04, s * 0.3);
  ctx.fillStyle = C.rock;
  ctx.fill();
  ctx.fillStyle = C.rockTop;
  ctx.beginPath();
  ctx.ellipse(x + s * (0.4 + k * 0.1), y + s * 0.33, s * 0.22, s * 0.11, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.ellipse(x + s * 0.5, y + s * 0.2, s * 0.28, s * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawSnow(x, y, s, c) {
  const k = ((c * 53) % 5) / 5;
  ctx.fillStyle = C.snowShade;
  for (const [ox, oy, r] of [[0.3, 0.6, 0.26], [0.62, 0.56, 0.3], [0.48, 0.42, 0.26]]) {
    ctx.beginPath();
    ctx.arc(x + s * ox, y + s * (oy + 0.04), s * r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = C.snow;
  for (const [ox, oy, r] of [[0.3, 0.6, 0.24], [0.62, 0.56, 0.28], [0.48, 0.42, 0.24]]) {
    ctx.beginPath();
    ctx.arc(x + s * ox, y + s * oy, s * r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(120,170,210,0.35)';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x + s * (0.3 + i * 0.18 + k * 0.05), y + s * (0.55 - (i % 2) * 0.1), s * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFish(x, y, s, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = C.fishDeep;
  ctx.beginPath();
  ctx.moveTo(s * 0.28, 0);
  ctx.lineTo(s * 0.52, -s * 0.22);
  ctx.lineTo(s * 0.52, s * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = C.fish;
  ctx.beginPath();
  ctx.ellipse(-s * 0.04, 0, s * 0.36, s * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(-s * 0.08, -s * 0.07, s * 0.2, s * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1b2433';
  ctx.beginPath();
  ctx.arc(-s * 0.24, -s * 0.03, s * 0.04, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// A penguin, `s` across: black back, white front, an orange beak and feet,
// and a scarf in its own colour. `face` is the way it last skidded.
function drawPenguin(x, y, s, scarf, face, o) {
  const sq = o.sq || 0;
  ctx.save();
  ctx.translate(x, y + s * 0.42);
  ctx.scale(1 + sq * 0.25, 1 - sq * 0.25);
  ctx.translate(0, -s * 0.42);
  ctx.fillStyle = 'rgba(20,60,90,0.22)';
  ctx.beginPath();
  ctx.ellipse(0, s * 0.42, s * 0.34, s * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();
  if (o.ring) {
    ctx.strokeStyle = o.ring;
    ctx.lineWidth = Math.max(2, s * 0.06);
    ctx.beginPath();
    ctx.ellipse(0, s * 0.42, s * 0.44, s * 0.14, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#f39a2b';
  ctx.beginPath();
  ctx.ellipse(-s * 0.13, s * 0.4, s * 0.1, s * 0.05, 0, 0, Math.PI * 2);
  ctx.ellipse(s * 0.13, s * 0.4, s * 0.1, s * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1d2a3a';
  ctx.beginPath();
  ctx.ellipse(0, s * 0.04, s * 0.3, s * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  const side = face === 1 ? 1 : face === 3 ? -1 : 0;
  ctx.fillStyle = '#ffffff';
  if (face !== 0) {
    // Skidding away it shows its back; otherwise its white front.
    ctx.beginPath();
    ctx.ellipse(side * s * 0.05, s * 0.1, s * 0.2, s * 0.29, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(side * s * 0.06 - s * 0.09, -s * 0.16, s * 0.08, s * 0.08, 0, 0, Math.PI * 2);
    ctx.ellipse(side * s * 0.06 + s * 0.09, -s * 0.16, s * 0.08, s * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#10161f';
    const blink = o.blink ? 0.2 : 1;
    for (const ex of [-0.09, 0.09]) {
      ctx.beginPath();
      ctx.ellipse(side * s * 0.09 + ex * s, -s * 0.15, s * 0.035, s * 0.04 * blink, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f39a2b';
    ctx.beginPath();
    const bx = side * s * 0.13;
    ctx.moveTo(bx - s * 0.07, -s * 0.07);
    ctx.lineTo(bx + s * 0.07, -s * 0.07);
    ctx.lineTo(bx + side * s * 0.1, s * 0.02);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = scarf;
  rr(-s * 0.27, -s * 0.01, s * 0.54, s * 0.1, s * 0.05);
  ctx.fill();
  rr(face === 3 ? s * 0.08 : -s * 0.2, s * 0.04, s * 0.11, s * 0.2, s * 0.04);
  ctx.fill();
  ctx.restore();
}

// In a reveal, slide k skids from k * SHOW_STEP for SKID and rests the rest.
const SKID = SHOW_STEP * 0.8;
function stepsDone(t) {
  if (!S.last || t < SKID) return 0;
  return clamp(Math.floor((t - SKID) / SHOW_STEP) + 1, 0, S.last.p.length);
}

// Where each penguin is drawn now: from my own floe while I solve, from the
// reveal's clock while a path is played out.
function penguinPoses(now) {
  const out = [];
  if (S.ph === 'show' && S.last) {
    const t = now - showAt - SHOW_LEAD;
    const pos = S.pg.slice();
    const face = [2, 2, 2, 2];
    const sq = [0, 0, 0, 0];
    let moving = null;
    const done = stepsDone(t);
    for (let k = 0; k < done; k++) {
      const m = S.last.p[k];
      pos[m >> 2] = slide(S.bd, pos, m >> 2, m & 3);
      face[m >> 2] = m & 3;
    }
    if (done < S.last.p.length && t >= 0) {
      const m = S.last.p[done];
      const i = m >> 2, d = m & 3;
      const to = slide(S.bd, pos, i, d);
      moving = { i, from: pos[i], to, k: ease((t - done * SHOW_STEP) / SKID) };
      face[i] = d;
    }
    if (done > 0) {
      const since = t - ((done - 1) * SHOW_STEP + SKID);
      if (since < 160) sq[S.last.p[done - 1] >> 2] = 1 - since / 160;
    }
    // A step that has just finished is heard and seen once.
    while (firedSteps < done) {
      const m = S.last.p[firedSteps];
      firedSteps++;
      const replayed = replay(S.bd, S.pg, S.last.p.slice(0, firedSteps));
      if (replayed) {
        const p = cellCenter(replayed[m >> 2]);
        burst(p.x, p.y + G.cs * 0.3, '#ffffff', 6, G.cs * 1.3);
        if (firedSteps === S.last.p.length) {
          sfx.gulp();
          burst(p.x, p.y, C.fish, 20, G.cs * 3);
          pop(p.x, p.y - G.cs * 0.6, 'gulp!', C.gold);
          shake = 4;
        } else sfx.step();
      }
    }
    for (let i = 0; i < 4; i++) {
      let p = cellCenter(pos[i]);
      if (moving && moving.i === i) {
        const a = cellCenter(moving.from), b = cellCenter(moving.to);
        p = { x: lerp(a.x, b.x, moving.k), y: lerp(a.y, b.y, moving.k) };
      }
      out.push({ i, x: p.x, y: p.y, face: face[i], sq: Math.max(0, sq[i]) });
    }
    return { poses: out, eaten: done >= S.last.p.length };
  }
  const pos = onFloe() && local.key === key() ? local.pos : onFloe() ? S.pg : idle.pg;
  const a = local.anim;
  settle(now);
  for (let i = 0; i < 4; i++) {
    let p = cellCenter(pos[i]);
    let face = 2, sq = 0;
    if (a && a.i === i && local.key === key()) {
      face = a.d;
      const k = (now - a.t0) / a.dur;
      if (k < 1) {
        const f = cellCenter(a.from), t = cellCenter(a.to);
        const e = easeOut(k);
        p = { x: lerp(f.x, t.x, e), y: lerp(f.y, t.y, e) };
      } else sq = clamp(1 - (now - a.t0 - a.dur) / 180, 0, 1);
    }
    const nu = local.nudge;
    if (nu && nu.i === i && local.key === key()) {
      const k = (now - nu.t0) / 180;
      if (k < 1) {
        const w = Math.sin(k * Math.PI) * G.cs * 0.12;
        p = { x: p.x + DX[nu.d] * w, y: p.y + DY[nu.d] * w };
        face = nu.d;
      }
    }
    out.push({ i, x: p.x, y: p.y, face, sq });
  }
  const eaten = onFloe() && local.key === key() && local.pos[0] === S.f && !(a && !a.landed);
  return { poses: out, eaten };
}

// For the penguin I have picked: where each of its four slides would stop.
function drawHints(now) {
  if (!canSlide()) return;
  const from = local.pos[sel];
  const p0 = cellCenter(from);
  const cs = G.cs;
  for (let d = 0; d < 4; d++) {
    const to = slide(S.bd, local.pos, sel, d);
    if (to === from) continue;
    const p1 = cellCenter(to);
    ctx.strokeStyle = alpha(SCARF[sel], 0.55);
    ctx.lineWidth = Math.max(1.5, cs * 0.06);
    ctx.setLineDash([cs * 0.12, cs * 0.16]);
    ctx.lineDashOffset = -now / 40;
    ctx.beginPath();
    ctx.moveTo(p0.x + DX[d] * cs * 0.42, p0.y + DY[d] * cs * 0.42);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = alpha(SCARF[sel], 0.4);
    ctx.beginPath();
    ctx.arc(p1.x, p1.y, cs * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── drawing the panel ───────────────────────────────────────────────────────

let hits = [];
let press = '';
function button(id, label, x, y, w, h, on, primary) {
  const pressed = press === id;
  ctx.save();
  ctx.globalAlpha = on ? 1 : 0.4;
  rr(x, y + (pressed ? 2 : 0), w, h, h / 2);
  ctx.fillStyle = primary ? C.gold : 'rgba(255,255,255,0.08)';
  ctx.fill();
  if (!primary) { ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke(); }
  text(label, x + w / 2, y + h / 2 + (pressed ? 2 : 0), Math.min(16, h * 0.42), primary ? C.goldDeep : C.text, 'center', 800, w - 14);
  ctx.restore();
  if (on) hits.push({ id, x, y, w, h });
}

function drawMute(x, y) {
  const s = 28;
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
  hits.push({ id: 'mute', x: x - 6, y: y - 6, w: s + 12, h: s + 12 });
}

// The status line: what is going on and how long it has left.
function status(now) {
  const left = Math.max(0, endAt - now);
  if (!haveTable) return room.host && !amHost() ? 'waiting for the host…' : 'setting up…';
  if (S.ph === 'lobby') return 'next floe in ' + Math.ceil(left / 1000);
  if (S.ph === 'over') return practiceTable() ? 'practice · game over' : 'game over';
  const pre = practiceTable() ? 'practice · ' : '';
  const rd = 'round ' + S.rd + '/' + ROUNDS + (S.rd === ROUNDS ? ' ×2' : '');
  if (S.ph === 'show') return pre + rd + ' · reveal';
  return pre + rd + ' · ' + fmtTime(left);
}

// The line under the floe: the race as it stands, or the verdict.
function verdict(now) {
  if (S.ph === 'solve') {
    // The leader's answer counts one slide more, here as at the reveal.
    const eff = (c) => c[1] + (c[0] === S.ld ? 1 : 0);
    let best = null;
    for (const c of S.cl) if (!best || eff(c) < eff(best) || (eff(c) === eff(best) && c[2] < best[2])) best = c;
    if (!best) return { s: 'Slide the gold-scarf penguin onto the fish', col: C.dim };
    const who = best[0] === myId() ? 'you' : nickOf(best[0]);
    return { s: 'Best: ' + best[1] + (best[0] === S.ld ? '+1' : '') + ' slides (' + who + ') · beat it in ' + fmtTime(endAt - now), col: C.gold };
  }
  if (S.ph === 'show' && S.last) {
    const l = S.last;
    if (l.w === null) return { s: 'Nobody found it. It could be done in ' + l.o + '.', col: C.dim };
    const who = l.w === myId() ? 'You take' : nickOf(l.w) + ' takes';
    return { s: who + ' it in ' + l.n + (l.n <= l.o ? ' · the shortest there is!' : ' · shortest was ' + l.o), col: colorOf(l.w) };
  }
  return null;
}

function pendingGain(id, now) {
  if (S.ph !== 'show' || !S.last) return 0;
  if (now - showAt >= showTotal(S.last.n) - SHOW_TAIL + 200) return 0;
  const g = S.last.gn.find((x) => x[0] === id);
  return g ? g[1] : 0;
}

function drawChip(s, x, y, w, h, now) {
  const col = PAL[s.seat % PAL.length];
  const here = present(s.id);
  const me = s.id === myId();
  const fl = flashAt.get(s.id);
  const flash = fl ? clamp(1 - (now - fl) / 600, 0, 1) : 0;
  ctx.save();
  if (!here) ctx.globalAlpha = 0.4;
  rr(x, y, w, h, h / 2);
  ctx.fillStyle = alpha(col, me ? 0.22 + flash * 0.3 : 0.1 + flash * 0.3);
  ctx.fill();
  ctx.strokeStyle = alpha(col, me ? 0.9 : 0.45);
  ctx.lineWidth = me ? 2 : 1.2;
  ctx.stroke();
  const r = h * 0.3;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(x + h / 2, y + h / 2, r, 0, Math.PI * 2);
  ctx.fill();
  const shown = s.sc - pendingGain(s.id, now);
  const c = claimOf(s.id);
  const pill = c ? 30 : 0;
  const scoreW = 28;
  const lead = S.ld === s.id && S.ph === 'solve' ? 22 : 0;
  text(clip(nickOf(s.id), 12, w - h - pill - scoreW - lead - 12), x + h, y + h / 2, 12, C.text, 'left', 600);
  text(String(shown), x + w - 10, y + h / 2 + 1, Math.min(17, h * 0.55), C.text, 'right', 800);
  if (lead) text('+1', x + w - scoreW - pill - 14, y + h / 2, 10, C.red, 'center', 800);
  if (c) {
    const px = x + w - scoreW - pill - 2;
    rr(px, y + h * 0.2, pill - 4, h * 0.6, h * 0.3);
    ctx.fillStyle = C.gold;
    ctx.fill();
    text(String(c[1]), px + (pill - 4) / 2, y + h / 2 + 1, h * 0.42, C.goldDeep, 'center', 900);
  }
  ctx.restore();
  chipAt.set(s.id, { x, y, w, h });
}
const chipAt = new Map();

// The points pop up over the chips once the reveal's path has played out.
function drawGains(now) {
  if (S.ph !== 'show' || !S.last || gainsShown) return;
  if (now - showAt < showTotal(S.last.n) - SHOW_TAIL + 200) return;
  gainsShown = true;
  if (S.last.w !== null) sfx.win(); else sfx.none();
  for (const [id, pts] of S.last.gn) {
    const r = chipAt.get(id);
    if (!r) continue;
    pop(r.x + r.w - 20, r.y, '+' + pts, colorOf(id));
    burst(r.x + r.w - 20, r.y + r.h / 2, colorOf(id), 12, 140);
  }
}

function drawCounter(x, y, w, h) {
  const me = mySeat();
  const n = local.key === key() ? local.moves.length : 0;
  text(String(n), x + 4, y + h / 2, Math.min(34, h * 0.8), C.text, 'left', 900);
  font(Math.min(34, h * 0.8), 900);
  const nw = ctx.measureText(String(n)).width;
  text(n === 1 ? 'slide' : 'slides', x + nw + 10, y + h * 0.36, 11, C.dim, 'left', 600);
  const sub = !me && S.ph === 'solve' ? 'watching · you play next round'
    : mySol && mySol.key === key() ? 'your best: ' + mySol.path.length : 'no answer yet';
  text(sub, x + nw + 10, y + h * 0.7, 11, mySol && mySol.key === key() ? C.gold : C.faint, 'left', 600, w - nw - 14);
}

function howTo() {
  if (S.ph !== 'solve') return 'fewest slides takes 3 · any answer 1 · the shortest possible +1 · the leader counts one slide extra';
  return coarse ? 'drag a penguin to skid it · tap one to pick it, swipe anywhere'
    : 'drag a penguin, or 1-4 to pick and arrows to skid · Z undo · R reset';
}

function drawSidePanel(now) {
  const x = G.px, w = G.pw;
  let y = PAD + 4;
  text('SKID', x + 2, y + 10, 20, C.text, 'left', 900);
  drawMute(x + w - 28, y - 4);
  y += 30;
  text(status(now), x + 2, y, 13, practiceTable() ? C.gold : C.dim, 'left', 700, w - 4);
  y += 18;
  const seats = S.seats;
  const rowH = clamp((H - 300) / Math.max(1, seats.length), 22, 32);
  for (const s of seats) {
    drawChip(s, x, y, w, rowH - 4, now);
    y += rowH;
  }
  y += 6;
  if (S.ph === 'solve' || S.ph === 'show') {
    drawCounter(x, y, w, 40);
    y += 46;
    const bw = (w - 8) / 2;
    button('undo', 'Undo', x, y, bw, 34, canSlide() && local.moves.length > 0, false);
    button('reset', 'Reset', x + bw + 8, y, bw, 34, canSlide() && local.moves.length > 0, false);
    y += 44;
    const v = verdict(now);
    if (v) { wrapText(v.s, x + 2, y, w - 4, 13, v.col, 700, 2); y += 38; }
  } else if (S.ph === 'lobby' || !haveTable) {
    text('Everyone gets the same floe.', x + 2, y + 8, 12, C.dim, 'left', 500, w - 4);
    text('Fewest slides takes the round.', x + 2, y + 26, 12, C.dim, 'left', 500, w - 4);
    y += 44;
  }
  wrapText(howTo(), x + 2, y, w - 4, 11, C.faint, 500, 3);
  y += 44;
  return y;
}

function wrapText(s, x, y, w, size, col, weight, maxLines) {
  font(size, weight);
  const words = s.split(' ');
  const lines = [];
  let cur = '';
  for (const wd of words) {
    const t = cur ? cur + ' ' + wd : wd;
    if (ctx.measureText(t).width > w && cur) { lines.push(cur); cur = wd; } else cur = t;
  }
  if (cur) lines.push(cur);
  lines.slice(0, maxLines).forEach((l, i) => text(l, x, y + i * (size + 5), size, col, 'left', weight, w));
}

function drawStackPanel(now) {
  // Top bar.
  text('SKID', PAD + 2, 20, 18, C.text, 'left', 900);
  font(18, 900);
  const tw = ctx.measureText('SKID').width;
  text(status(now), PAD + tw + 12, 21, 13, practiceTable() ? C.gold : C.dim, 'left', 700, W - tw - 70);
  drawMute(W - PAD - 28, 6);
  // Under the floe: the race as it stands.
  const v = verdict(now);
  if (v) text(v.s, W / 2, G.bandTop + 14, 13, v.col, 'center', 700, W - 2 * PAD);
  else if (S.ph === 'lobby' || !haveTable) text('Everyone gets the same floe. Fewest slides takes the round.', W / 2, G.bandTop + 14, 13, C.dim, 'center', 600, W - 2 * PAD);
  // Scores, then my counter and buttons, then the how-to.
  let y = G.panelTop;
  const cols = G.cols;
  const cw = (W - 2 * PAD - (cols - 1) * 6) / cols;
  S.seats.forEach((s, i) => {
    drawChip(s, PAD + (i % cols) * (cw + 6), y + Math.floor(i / cols) * 34, cw, 30, now);
  });
  y += Math.ceil(Math.max(1, S.seats.length) / cols) * 34 + 4;
  if (S.ph === 'solve' || S.ph === 'show') {
    const bw = Math.min(96, (W - 2 * PAD) * 0.22);
    drawCounter(PAD, y, W - 2 * PAD - bw * 2 - 16, 40);
    button('undo', 'Undo', W - PAD - bw * 2 - 8, y + 4, bw, 34, canSlide() && local.moves.length > 0, false);
    button('reset', 'Reset', W - PAD - bw, y + 4, bw, 34, canSlide() && local.moves.length > 0, false);
  }
  text(howTo(), W / 2, H - 12, 11, C.faint, 'center', 500, W - 2 * PAD);
}

function drawOverlay(now) {
  if (S.ph === 'over') {
    const k = easeOut((now - overAt) / 500);
    ctx.fillStyle = 'rgba(4,14,24,' + 0.55 * k + ')';
    ctx.fillRect(0, 0, W, H);
    const list = standings();
    const pw = Math.min(W - 2 * PAD, 360);
    const rowH = 28;
    const ph = Math.min(H - 20, 140 + list.length * rowH);
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
    const tied = top ? list.filter((s) => s.sc === top.sc).length : 0;
    const title = !top ? 'Game over' : tied > 1 ? 'A tie at ' + top.sc
      : (top.id === myId() ? 'You win' : nickOf(top.id) + ' wins');
    text(title, x + pw / 2, y + 32, 24, tied === 1 ? colorOf(top.id) : C.text, 'center', 900, pw - 28);
    list.forEach((s, i) => {
      const yy = y + 66 + i * rowH;
      if (yy > y + ph - 66) return;
      ctx.fillStyle = colorOf(s.id);
      ctx.beginPath();
      ctx.arc(x + 30, yy, 6, 0, Math.PI * 2);
      ctx.fill();
      text((i + 1) + '.  ' + clip(nickOf(s.id), 14, pw - 120), x + 44, yy, 14, C.text, 'left', 600);
      text(String(s.sc), x + pw - 24, yy, 16, C.gold, 'right', 800);
    });
    const people = solo() ? 0 : room.players.length;
    button('go', people >= 2 ? 'Play again' : 'Practice again', x + pw / 2 - 90, y + ph - 56, 180, 42, true, true);
    text('next game in ' + Math.ceil(Math.max(0, endAt - now) / 1000), x + pw / 2, y + ph - 6, 10, C.faint, 'center', 500);
    ctx.restore();
  } else if (S.ph === 'lobby' || !haveTable) {
    const cx = G.bx + G.bs / 2, cy = G.by + G.bs / 2;
    const pw = Math.min(G.bs - 20, 300), ph = 120;
    rr(cx - pw / 2, cy - ph / 2, pw, ph, 16);
    ctx.fillStyle = C.panel;
    ctx.fill();
    text('SKID', cx, cy - 30, 26, C.text, 'center', 900);
    text(status(now), cx, cy + 2, 13, C.dim, 'center', 600, pw - 20);
    if (haveTable && S.ph === 'lobby') button('go', 'Start now', cx - 70, cy + 18, 140, 34, true, true);
  } else if (S.ph === 'solve') {
    // A new floe announces itself.
    const k = (now - roundAt) / 1400;
    if (k < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - k * k;
      const s = 1 + 0.25 * (1 - easeOut(k * 3));
      ctx.translate(G.bx + G.bs / 2, G.by + G.bs / 2);
      ctx.scale(s, s);
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(8,24,40,0.85)';
      font(Math.min(44, G.bs * 0.1), 900);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = S.rd === ROUNDS ? 'last floe ×2' : 'floe ' + S.rd;
      ctx.strokeText(label, 0, 0);
      ctx.fillStyle = C.text;
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }
}

// ── the frame ───────────────────────────────────────────────────────────────

let lastFrame = performance.now();
let lastTickSec = -1;
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
  chipAt.clear();
  stepFx(dt);
  drawBackground(now);
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  const floe = onFloe();
  const pp = penguinPoses(now);
  drawBoard(now, floe ? S.bd : idle.bd, floe ? S.f : idle.f, pp.eaten);
  drawHints(now);
  const order = pp.poses.slice().sort((a, b) => a.y - b.y);
  for (const p of order) {
    const pick = canSlide() && p.i === sel;
    const blink = ((now / 1000 + p.i * 0.9) % 3.7) < 0.12;
    drawPenguin(p.x, p.y, G.cs * 0.86, SCARF[p.i], p.face, {
      sq: p.sq, blink,
      ring: pick ? alpha(SCARF[p.i], 0.6 + 0.35 * Math.sin(now / 180)) : null,
    });
    // The hungry one dreams of the fish until it has it.
    if (p.i === 0 && !pp.eaten && floe) {
      const bx = p.x + G.cs * 0.38, by = p.y - G.cs * 0.62 + Math.sin(now / 500) * G.cs * 0.03;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.arc(bx, by, G.cs * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x + G.cs * 0.2, p.y - G.cs * 0.38, G.cs * 0.05, 0, Math.PI * 2);
      ctx.fill();
      drawFish(bx, by, G.cs * 0.3, 0);
    }
  }
  for (const p of parts) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  let sideBottom = 0;
  if (G.side) sideBottom = drawSidePanel(now);
  else drawStackPanel(now);
  drawGains(now);
  for (const p of pops) {
    const k = p.t / 1.3;
    ctx.save();
    ctx.globalAlpha = 1 - k * k;
    const s = 1 + 0.4 * (1 - easeOut(p.t * 4));
    ctx.translate(p.x, p.y - 36 * easeOut(k));
    ctx.scale(s, s);
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(8,24,40,0.85)';
    font(20, 900);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText(p.s, 0, 0);
    ctx.fillStyle = p.color;
    ctx.fillText(p.s, 0, 0);
    ctx.restore();
  }
  drawOverlay(now);
  if (haveTable && practiceTable()) {
    const head = joinEnd ? joinHead(Math.max(1, Math.ceil((joinEnd - now) / 1000)))
      : 'practice with bots · a game starts when someone joins';
    const tip = joinEnd ? null : 'fewest slides wins · a penguin skids until something stops it';
    if (G.side) practiceNote(now, G.pw, head, tip, [[sideBottom + 4, H - 4]], H - 4, G.px);
    else practiceNote(now, W, head, tip, [[G.bandTop + 26, G.panelTop - 2]], G.panelTop - 2);
  }
  // A tick in the last seconds, for somebody still solving.
  if (S.ph === 'solve' && mySeat()) {
    const left = Math.ceil((endAt - now) / 1000);
    if (left <= 5 && left > 0 && left !== lastTickSec) { lastTickSec = left; sfx.tick(); }
  }
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
  if (id === 'mute') { muted = !muted; if (!muted) sfx.claim(); return; }
  if (id === 'go') return go();
  if (id === 'undo') return undo();
  if (id === 'reset') return reset();
}

function penguinAt(c) {
  if (!canSlide()) return -1;
  return local.pos.indexOf(c);
}

// A drag that starts on a penguin skids that penguin; one that starts anywhere
// else skids the penguin picked last. A tap picks a penguin, or skids the
// picked one toward an empty cell in its row or column.
let drag = null;
cv.addEventListener('pointerdown', (e) => {
  audio();
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { press = h.id; e.preventDefault(); return; }
  }
  if (!canSlide()) return;
  const c = cellAt(x, y);
  const i = penguinAt(c);
  if (i >= 0) sel = i;
  drag = { i: i >= 0 ? i : sel, x0: x, y0: y, cell: c, on: i >= 0 };
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ }
  e.preventDefault();
});
cv.addEventListener('pointerup', (e) => {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (press) {
    const h = hits.find((b) => b.id === press);
    if (h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) act(press);
    press = '';
    return;
  }
  if (!drag) return;
  const d0 = drag;
  drag = null;
  const dx = x - d0.x0, dy = y - d0.y0;
  const far = Math.max(14, G ? G.cs * 0.35 : 14);
  if (dx * dx + dy * dy >= far * far) {
    const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
    move(d0.i, d);
    return;
  }
  if (d0.on || d0.cell < 0 || !canSlide()) return;
  const from = local.pos[sel];
  const fx = from % N, fy = (from / N) | 0, tx = d0.cell % N, ty = (d0.cell / N) | 0;
  if (fx === tx && fy !== ty) move(sel, ty > fy ? 2 : 0);
  else if (fy === ty && fx !== tx) move(sel, tx > fx ? 1 : 3);
});
cv.addEventListener('pointercancel', () => { drag = null; press = ''; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  audio();
  const k = e.key;
  if (k === 'm' || k === 'M') { act('mute'); return; }
  if (S.ph === 'lobby' || S.ph === 'over') {
    if (k === 'Enter' || k === ' ') { go(); e.preventDefault(); }
    return;
  }
  if (!canSlide()) return;
  if (k >= '1' && k <= '4') { sel = Number(k) - 1; return; }
  if (k === 'Tab') { sel = (sel + (e.shiftKey ? 3 : 1)) % 4; e.preventDefault(); return; }
  const dir = { ArrowUp: 0, w: 0, W: 0, ArrowRight: 1, d: 1, D: 1, ArrowDown: 2, s: 2, S: 2, ArrowLeft: 3, a: 3, A: 3 }[k];
  if (dir !== undefined) { move(sel, dir); e.preventDefault(); return; }
  if (k === 'z' || k === 'Z' || k === 'u' || k === 'U' || k === 'Backspace') { undo(); e.preventDefault(); return; }
  if (k === 'r' || k === 'R') { reset(); }
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
