/**
 * @disk     pile_up
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    One well, and everybody's blocks fall into it at once. A full row clears and pays every block in it to whoever dropped it, plus a bonus to whoever finished it. Steal the finish, jam a rival's gap, and mind the floor rising. Whoever trails drops gold.
 * @tags     game, party, realtime, puzzle, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/pile_up.png
 */
// pile_up.js — falling blocks in one shared well, where the room's order is the
// referee.
//
// Every copy holds every cell of the well and whose block sits in it, and
// every falling piece, and changes them only on what comes back round the
// room, so every copy applies the same hands in the same order and holds the
// same well. Nobody sends where their piece is, which row they cleared or what
// they scored: a hand is which way a player pushes or the column they point
// at, a counter for turns, a counter for drops and whether they hold the piece
// down. Everything else is the same arithmetic on the same whole numbers on
// every machine. A page with a console open can steer its own piece however it
// likes, no faster than every piece moves, and nothing else.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own piece does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole cells and whole steps only, and use nothing but
// `+ - * /`, comparisons, `Math.floor`, `Math.min`, `Math.max`, `Math.abs` and
// `Math.imul`, whose results the language fixes to the last bit.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own piece a trip ahead, with your hand in it

// The well: a grid as wide as the room needs, a row of cells per line. A cell
// is empty, a block in a seat's colour plus one (with GOLD added when it pays
// double), or rubble that pays nobody. The top rows are where pieces are dealt.
const W_MAX = 28, H = 22;
const SPAWN_ROWS = 2;
const PRACTICE_W = 10;
const wellFor = (n) => Math.min(W_MAX, Math.max(PRACTICE_W, 4 + 3 * n));
const RUBBLE = 9, GOLD = 16;
const MAX_P = 8;

const MOVE_FIRST = 7;          // steps before a held push repeats
const MOVE_EVERY = 2;          // steps between repeats, and between columns on the way to one picked
const LOCK_STEPS = 15;         // steps a piece rests on the stack before it sets
const LOCK_RESETS = 12;        // how often a move may put that off, per piece
const SPAWN_STEPS = 8;         // steps between a piece setting and the next one dealt
const SOFT_EVERY = 2;          // steps a row while a piece is held down
const FALL_SLOW = 30;          // steps a row as a round starts
const FALL_FAST = 6;           // and as it ends
const PRACTICE_FALL = 14;
const CLOSE_BONUS = [0, 3, 7, 12, 20];   // to whoever finishes 1, 2, 3, 4 rows at once
const CHOKE_COST = 6;          // points lost when your next piece has nowhere to go
const BLAST_W = 3;             // columns either side of a lane a choke blows clear
const BLAST_ROWS = 8;          // and how far down
const RISE_AT = 75 * HZ;       // steps into a round when the floor starts to rise
const RISE_EVERY = 10 * HZ;    // and a row of rubble this often after
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 120 * HZ;
const END_STEPS = 6 * HZ;

const OUT = 0, IN = 1;         // watching, in the well

// The seven pieces, each as its cells in a box it turns in, and every turn of
// each worked out once: a cell (x, y) in a box n wide turns to (n - 1 - y, x).
const BASE = [
  [4, [[0, 1], [1, 1], [2, 1], [3, 1]]],   // I
  [2, [[0, 0], [1, 0], [0, 1], [1, 1]]],   // O
  [3, [[1, 0], [0, 1], [1, 1], [2, 1]]],   // T
  [3, [[1, 0], [2, 0], [0, 1], [1, 1]]],   // S
  [3, [[0, 0], [1, 0], [1, 1], [2, 1]]],   // Z
  [3, [[0, 0], [0, 1], [1, 1], [2, 1]]],   // J
  [3, [[2, 0], [0, 1], [1, 1], [2, 1]]],   // L
];
const SHAPES = BASE.map(([n, cells]) => {
  const turns = [cells];
  for (let r = 1; r < 4; r++) turns.push(turns[r - 1].map(([x, y]) => [n - 1 - y, x]));
  return turns;
});
const BOX = BASE.map(([n]) => n);
// The middle column of a piece as it is turned, from the left of its box: what
// a column picked with a pointer is lined up against.
const MID = SHAPES.map((turns) => turns.map((cells) => {
  let lo = 9, hi = -9;
  for (const [x] of cells) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return Math.floor((lo + hi) / 2);
}));
const KICKS = [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0], [1, -1], [-1, -1]];

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   wd: how many columns the well is wide; rs: rows of rubble risen so far
//   this round; g: every cell, W_MAX to a row, the columns past wd empty; res:
//   the last round's [id, points, rows finished, rounds won] rows; win: who
//   took it, -1 for a tie
function freshTable(seed) {
  return { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, wd: PRACTICE_W, rs: 0, g: new Array(W_MAX * H).fill(0), p: {}, res: null, win: -1 };
}

const FIELDS = ['c', 's', 'st', 'm', 'v', 'q', 'hd', 'sd', 'rq', 'hq', 'k', 'r', 'x', 'y', 'pc', 'ft', 'lt', 'lr', 'mt',
  'sp', 'nk', 'bag', 'gn', 'ln', 'wn', 'bx', 'br', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; st: watching or in the well; m, v: the hand, a push
//   (m 0, v -1 to 1) or a column to slide to (m 1, v a column); q, hd: the
//   turn and drop counters as last heard; sd: held down; rq: quarter turns
//   still to make; hq: a drop to make this step; k: the falling piece, -1 for
//   none; r, x, y: its turn and the top left of its box; pc: pieces dealt so
//   far; ft: steps since it last fell a row; lt: steps it has rested; lr: how
//   often a move has put off its setting; mt: steps to its next column; sp:
//   steps to the next piece; nk: the piece after this one; bag: the pieces
//   left before the seven are shuffled again; gn: points this round; ln: rows
//   finished; wn: rounds won; bx, br, bw: where the bot means to put its
//   piece, how turned, and its pause; hs, hc: hands this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = f === 'bag' ? v[f].slice() : v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);
const inWell = (w) => bySeat(w).filter((id) => w.p[id].st === IN);

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// The next piece from a bag of all seven, so nobody waits long for a long one.
function deal(w, d) {
  if (!d.bag.length) d.bag = [0, 1, 2, 3, 4, 5, 6];
  const i = Math.floor(draw01(w) * d.bag.length);
  return d.bag.splice(i, 1)[0];
}

function newPlayer(w, input) {
  const d = player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: OUT, m: input[0], v: input[1], q: input[2], hd: input[3], sd: input[4],
    rq: 0, hq: 0, k: -1, r: 0, x: 0, y: 0, pc: 0, ft: 0, lt: 0, lr: 0, mt: 0, sp: SPAWN_STEPS, nk: 0, bag: [],
    gn: 0, ln: 0, wn: 0, bx: -1, br: 0, bw: 0, hs: w.n, hc: 0,
  });
  d.nk = deal(w, d);
  return d;
}

const at = (x, y) => y * W_MAX + x;

// Whether a piece would stand against a wall, the floor or the stack. Falling
// pieces pass through each other: in a well this crowded, pieces that blocked
// each other would leave everybody waiting on everybody, and the game is in
// the stack, where every block stays.
function blocked(w, k, r, x, y) {
  for (const [dx, dy] of SHAPES[k][r]) {
    const cx = x + dx, cy = y + dy;
    if (cx < 0 || cx >= w.wd || cy < 0 || cy >= H || w.g[at(cx, cy)] !== 0) return true;
  }
  return false;
}
const fits = (w, d, r, x, y) => !blocked(w, d.k, r, x, y);

// The column a player's pieces are dealt over: the well cut into as many lanes
// as it has players, in seat order.
function laneOf(w, id) {
  const ids = inWell(w);
  const i = Math.max(0, ids.indexOf(id)), n = Math.max(1, ids.length);
  return Math.floor(((2 * i + 1) * w.wd) / (2 * n));
}

// Whoever has the fewest points this round, while somebody has more, drops
// gold: their blocks pay double when a row clears.
function trailing(w, id) {
  if (w.ph !== PLAY) return false;
  const ids = inWell(w);
  let lo = BIG, hi = -1;
  for (const o of ids) { lo = Math.min(lo, w.p[o].gn); hi = Math.max(hi, w.p[o].gn); }
  return hi > lo && w.p[id].gn === lo;
}

// A piece dealt at the top of a player's lane. When the stack there has
// reached the top it chokes: the lane is blown clear, which costs its player
// points in a round.
function spawn(w, id) {
  const d = w.p[id];
  const k = d.nk, n = BOX[k];
  const x = Math.max(0, Math.min(w.wd - n, laneOf(w, id) - (n >> 1)));
  if (blocked(w, k, 0, x, 0)) {
    choke(w, id);
    if (blocked(w, k, 0, x, 0)) { d.sp = 2; return; }
  }
  d.k = k;
  d.nk = deal(w, d);
  d.r = 0;
  d.x = x;
  d.y = 0;
  d.pc = (d.pc + 1) % 1000000;
  d.ft = d.lt = d.lr = d.mt = d.rq = d.hq = 0;
  d.bx = -1;
}

function choke(w, id) {
  const d = w.p[id];
  const lane = laneOf(w, id);
  for (let y = 0; y < BLAST_ROWS; y++) {
    for (let x = Math.max(0, lane - BLAST_W); x <= Math.min(w.wd - 1, lane + BLAST_W); x++) w.g[at(x, y)] = 0;
  }
  if (w.ph === PLAY) d.gn = Math.max(0, d.gn - CHOKE_COST);
  fx(w, 'choke', lane, 2, id, w.ph === PLAY ? CHOKE_COST : 0);
}

// A move made while a piece rests on the stack puts its setting off, a few
// times a piece, so nobody can hold it up for ever by wiggling it.
function moved(w, id, d) {
  if (blocked(w, d.k, d.r, d.x, d.y + 1) && d.lr < LOCK_RESETS) { d.lt = 0; d.lr += 1; }
}

function shift(w, id, d, dx) {
  if (!fits(w, d, d.r, d.x + dx, d.y)) return false;
  d.x += dx;
  moved(w, id, d);
  return true;
}

function turn(w, id, d) {
  const r = (d.r + 1) & 3;
  for (const [kx, ky] of KICKS) {
    if (!fits(w, d, r, d.x + kx, d.y + ky)) continue;
    d.r = r;
    d.x += kx;
    d.y += ky;
    moved(w, id, d);
    return true;
  }
  return false;
}

// Where the blocks of a piece set at (x, y) end up: every block tumbles down
// its own column onto whatever is there, the lowest first, so the stack never
// holds a hole. In a well this crowded, holes would be everybody's and
// nobody's fault, and every row would be lost to them; without them, every
// row is a race anybody can read.
function crumble(g, k, r, x, y) {
  const cells = SHAPES[k][r].map(([dx, dy]) => [x + dx, y + dy]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const out = [];
  for (const [cx, cy] of cells) {
    let ty = cy;
    while (ty + 1 < H && g[at(cx, ty + 1)] === 0 && !out.some(([ox, , oy]) => ox === cx && oy === ty + 1)) ty += 1;
    out.push([cx, cy, ty]);
  }
  return out;
}

// A piece sets into the stack. Every full row then clears, every block in it
// paying whoever dropped it, and the one who finished the rows takes a bonus.
function lock(w, id) {
  const d = w.p[id];
  const gold = trailing(w, id) ? GOLD : 0;
  const mid = d.x + MID[d.k][d.r];
  const v = d.c + 1 + gold;
  let top = H, bot = -1;
  const fell = crumble(w.g, d.k, d.r, d.x, d.y);
  for (const [cx, , ty] of fell) {
    w.g[at(cx, ty)] = v;
    top = Math.min(top, ty);
    bot = Math.max(bot, ty);
  }
  fx(w, 'lock', mid, bot, id, v, fell);
  d.k = -1;
  d.sp = SPAWN_STEPS;
  unstick(w);
  const full = [];
  for (let y = top; y <= bot; y++) if (fullRow(w, y)) full.push(y);
  if (!full.length) return;
  const byColour = new Map();
  for (const o of playersIn(w)) byColour.set(w.p[o].c + 1, o);
  const paid = new Map();
  for (const y of full) {
    const cells = [];
    for (let x = 0; x < w.wd; x++) {
      const v = w.g[at(x, y)];
      cells.push(v);
      const o = byColour.get(v & 15);
      if (v === RUBBLE || o === undefined) continue;
      paid.set(o, (paid.get(o) || 0) + (v & GOLD ? 2 : 1));
    }
    fx(w, 'row', 0, y, id, 0, cells);
  }
  // The rows go, everything above them comes down.
  const keep = [];
  for (let y = 0; y < H; y++) if (!full.includes(y)) keep.push(w.g.slice(at(0, y), at(0, y) + W_MAX));
  while (keep.length < H) keep.unshift(new Array(W_MAX).fill(0));
  for (let y = 0; y < H; y++) for (let x = 0; x < W_MAX; x++) w.g[at(x, y)] = keep[y][x];
  const bonus = CLOSE_BONUS[Math.min(4, full.length)];
  paid.set(id, (paid.get(id) || 0) + bonus);
  d.ln += full.length;
  for (const [o, n] of paid) {
    w.p[o].gn += n;
    fx(w, 'paid', 0, 0, o, n);
  }
  fx(w, 'clear', mid, full[0], id, full.length, [bonus]);
  unstick(w);
}

// A row clears when every cell of it is taken — but not a row of the floor
// risen from below, which is all rubble and is there to stay.
function fullRow(w, y) {
  let solid = true;
  for (let x = 0; x < w.wd; x++) {
    const v = w.g[at(x, y)];
    if (v === 0) return false;
    if (v !== RUBBLE) solid = false;
  }
  return !solid;
}

// The stack moved under the falling pieces — rows came down, or rubble came
// up. A piece it now runs through is lifted clear, and one with no room left
// above it is lost, and its player is dealt the next.
function unstick(w) {
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d.k < 0) continue;
    let lift = 0;
    while (lift < H && overlapsStack(w, d, d.y - lift)) lift += 1;
    if (!lift) continue;
    if (belowTop(d, d.y - lift)) { d.y -= lift; continue; }
    d.k = -1;
    d.sp = SPAWN_STEPS;
  }
}
function overlapsStack(w, d, y) {
  for (const [dx, dy] of SHAPES[d.k][d.r]) {
    const cy = y + dy;
    if (cy >= 0 && cy < H && w.g[at(d.x + dx, cy)] !== 0) return true;
  }
  return false;
}
function belowTop(d, y) {
  for (const [, dy] of SHAPES[d.k][d.r]) if (y + dy < 0) return false;
  return true;
}

// The floor rises: a solid row of rubble pushed in under the stack, which
// never clears, so the well is a row shallower for the rest of the round.
function rise(w) {
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W_MAX; x++) w.g[at(x, y)] = w.g[at(x, y + 1)];
  for (let x = 0; x < W_MAX; x++) w.g[at(x, H - 1)] = x < w.wd ? RUBBLE : 0;
  w.rs += 1;
  unstick(w);
  fx(w, 'rise', w.wd >> 1, H - 1, 0);
}

// A hand, at its place in the room's order: [a push or a column, which, the
// turn counter, the drop counter, held down]. A turn and a drop are asked for
// by moving a counter; the same hand said again to keep a player at the table
// turns and drops nothing. Being heard is how a player arrives: in the well
// while the table waits for a round, and watching while one is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input);
    if (w.ph === WAIT) d.st = IN;
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; how fast a piece moves is the table's to say, not the
  // hand's.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.m = input[0];
  d.v = input[1];
  d.sd = input[4];
  const dq = (input[2] - d.q + 1000) % 1000;
  if (dq) { d.q = input[2]; d.rq = (d.rq + dq) & 3; }
  if (input[3] !== d.hd) { d.hd = input[3]; d.hq = 1; }
}

// A hand off the wire, made safe: five integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  const [m, v, q, hd, sd] = raw;
  if (![m, v, q, hd, sd].every(Number.isInteger)) return null;
  if (m === 0 ? v < -1 || v > 1 : m === 1 ? v < 0 || v >= W_MAX : true) return null;
  if (q < 0 || q > 999 || hd < 0 || hd > 999 || (sd !== 0 && sd !== 1)) return null;
  return [m, v, q, hd, sd];
}

// Somebody gone from the room. Their blocks stay in the well as rubble, which
// pays nobody — a colour handed to whoever comes next must not inherit them.
function leave(w, id) {
  const d = w.p[id];
  if (!d) return;
  for (let k = 0; k < w.g.length; k++) if ((w.g[k] & 15) === d.c + 1) w.g[k] = RUBBLE;
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions
const BOT_IDLE = 0.1;          // how often it stops to think a moment
const BOT_SLIP = 0.22;         // how often it settles for a worse spot
const BOT_DROP = 0.3;          // how often, lined up, it drops rather than wait
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    const d = (w.p[BOT_ID] = newPlayer(w, [0, 0, 0, 0, 0]));
    d.st = IN;
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// How good the stack would be with a piece set at (x, y) turned r: rows it
// finishes count for a lot, a rough or tall stack against it.
function judge(w, k, r, x, y) {
  const g = w.g.slice();
  for (const [cx, , ty] of crumble(w.g, k, r, x, y)) g[at(cx, ty)] = 1;
  let rows = 0, height = 0, bump = 0, prev = -1, tallest = 0;
  for (let cy = 0; cy < H; cy++) {
    let all = true;
    for (let cx = 0; cx < w.wd && all; cx++) if (!g[at(cx, cy)]) all = false;
    if (all) rows += 1;
  }
  for (let cx = 0; cx < w.wd; cx++) {
    let h = 0;
    for (let cy = 0; cy < H; cy++) if (g[at(cx, cy)]) { h = H - cy; break; }
    height += h;
    tallest = Math.max(tallest, h);
    if (prev >= 0) bump += Math.abs(h - prev);
    prev = h;
  }
  return rows * 90 - height * 4 - bump * 3 - (tallest > H - 6 ? 60 : 0);
}

function botPlan(w, id, d) {
  let best = null, second = null;
  for (let r = 0; r < 4; r++) {
    for (let x = -3; x < w.wd; x++) {
      if (blocked(w, d.k, r, x, d.y)) continue;
      let y = d.y;
      while (!blocked(w, d.k, r, x, y + 1)) y += 1;
      const s = judge(w, d.k, r, x, y) + Math.floor(draw01(w) * 6);
      const pick = [s, x + MID[d.k][r], r];
      if (!best || s > best[0]) { second = best; best = pick; } else if (!second || s > second[0]) second = pick;
    }
  }
  const pick = second && draw01(w) < BOT_SLIP ? second : best;
  if (!pick) return;
  d.bx = Math.max(0, Math.min(w.wd - 1, pick[1]));
  d.br = pick[2];
}

function botThink(w, id) {
  const d = w.p[id];
  if (!d || d.st !== IN || d.k < 0) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 2 + Math.floor(draw01(w) * 8); return; }
  if (d.bx < 0) botPlan(w, id, d);
  if (d.bx < 0) return;
  d.m = 1;
  d.v = d.bx;
  if (d.r !== d.br) d.rq = 1;
  else if (d.x + MID[d.k][d.r] === d.bx && d.y >= 2 && draw01(w) < BOT_DROP) d.hq = 1;
}

// ── a step ─────────────────────────────────────────────────────────────────
function clearWell(w) {
  w.g.fill(0);
  w.rs = 0;
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  w.wd = PRACTICE_W;
  clearWell(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    d.st = IN;
    d.k = -1;
    d.sp = SPAWN_STEPS;
    d.gn = d.ln = 0;
  }
}

// A round: an empty well as wide as the room needs, the seats closed up in
// order, and every piece dealt the moment it starts.
function begin(w) {
  const ids = bySeat(w);
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.wd = wellFor(ids.length);
  clearWell(w);
  ids.forEach((id, i) => {
    const d = w.p[id];
    d.s = i;
    d.st = IN;
    d.k = -1;
    d.sp = 0;
    d.gn = d.ln = 0;
    d.bag = [];
    d.nk = deal(w, d);
  });
  fx(w, 'round', 0, 0, 0);
}

// The round is over: most points takes it, and nobody does on a tie.
function finish(w) {
  const ids = inWell(w);
  let top = -1;
  for (const id of ids) top = Math.max(top, w.p[id].gn);
  const best = ids.filter((id) => w.p[id].gn === top);
  w.win = best.length === 1 ? best[0] : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, w.p[id].gn, w.p[id].ln, w.p[id].wn]);
  res.sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
  w.res = res;
  for (const id of playersIn(w)) w.p[id].k = -1;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, w.win);
}

function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting table otherwise leaves at zero. The bot goes first, so
    // the round's seats close up without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); return; }
  } else if (many < 2) {
    toWait(w);
    return;
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go', 0, 0, 0); }
      return;
    } else if (w.ph === PLAY) {
      if (w.pt <= 0) { finish(w); return; }
      const into = PLAY_STEPS - w.pt;
      if (into === RISE_AT - 2 * HZ) fx(w, 'warn', 0, 0, 0);
      if (into >= RISE_AT && (into - RISE_AT) % RISE_EVERY === 0) rise(w);
    } else {
      if (w.pt <= 0) begin(w);
      return;
    }
  }
  botThink(w, BOT_ID);
  const fall = w.ph === WAIT ? PRACTICE_FALL
    : FALL_SLOW - Math.floor(((FALL_SLOW - FALL_FAST) * (PLAY_STEPS - w.pt)) / PLAY_STEPS);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (!d || d.st !== IN) continue;
    if (d.k < 0) {
      d.rq = d.hq = 0;
      if (d.sp > 0) d.sp -= 1;
      if (d.sp === 0) spawn(w, id);
      continue;
    }
    fallOne(w, id, d, fall);
  }
}

// One piece through one step, in seat order: its turns, a drop, its push, the
// pull of the well, and whether it has rested long enough to set.
function fallOne(w, id, d, fall) {
  for (; d.rq > 0; d.rq--) turn(w, id, d);
  if (d.hq) {
    d.hq = 0;
    // A drop aimed with a pointer lands in the column pointed at, as far as
    // the way there is clear.
    if (d.m === 1) {
      const dir = Math.sign(d.v - (d.x + MID[d.k][d.r]));
      while (d.x + MID[d.k][d.r] !== d.v && shift(w, id, d, dir));
    }
    const from = d.y;
    while (fits(w, d, d.r, d.x, d.y + 1)) d.y += 1;
    fx(w, 'slam', d.x + MID[d.k][d.r], d.y, id, d.y - from);
    if (blocked(w, d.k, d.r, d.x, d.y + 1)) { lock(w, id); return; }
  }
  if (d.m === 0) {
    if (d.v === 0) d.mt = 0;
    else if (d.mt === 0) { shift(w, id, d, d.v); d.mt = MOVE_FIRST; }
    else if (--d.mt === 0) { shift(w, id, d, d.v); d.mt = MOVE_EVERY; }
  } else {
    const dir = Math.sign(d.v - (d.x + MID[d.k][d.r]));
    if (dir === 0) d.mt = 0;
    else if (d.mt > 0) d.mt -= 1;
    else { shift(w, id, d, dir); d.mt = MOVE_EVERY - 1; }
  }
  d.ft += 1;
  if (d.ft >= (d.sd ? Math.min(SOFT_EVERY, fall) : fall)) {
    d.ft = 0;
    if (fits(w, d, d.r, d.x, d.y + 1)) { d.y += 1; d.lt = 0; }
  }
  if (blocked(w, d.k, d.r, d.x, d.y + 1)) {
    d.lt += d.sd ? 2 : 1;
    if (d.lt >= LOCK_STEPS) lock(w, id);
  } else d.lt = 0;
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const cellOk = (v) => int(v, 0, RUBBLE) || int(v, GOLD + 1, GOLD + MAX_P);

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.wd, PRACTICE_W, W_MAX) || !int(raw.rs, 0, BIG)) return null;
  if (!Array.isArray(raw.g) || raw.g.length !== W_MAX * H || !raw.g.every(cellOk)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, OUT, IN) || inputOf([d.m, d.v, d.q, d.hd, d.sd]) === null) return null;
    if (!int(d.rq, 0, 3) || !int(d.hq, 0, 1) || !int(d.k, -1, 6) || !int(d.r, 0, 3)) return null;
    if (!int(d.x, -3, W_MAX) || !int(d.y, -3, H) || !int(d.pc, 0, 999999)) return null;
    if (!int(d.ft, 0, FALL_SLOW) || !int(d.lt, 0, LOCK_STEPS + 1) || !int(d.lr, 0, LOCK_RESETS) || !int(d.mt, 0, MOVE_FIRST)) return null;
    if (!int(d.sp, 0, SPAWN_STEPS) || !int(d.nk, 0, 6) || !Array.isArray(d.bag) || d.bag.length > 7) return null;
    if (!d.bag.every((k) => int(k, 0, 6)) || new Set(d.bag).size !== d.bag.length) return null;
    if (!int(d.gn, 0, 999999) || !int(d.ln, 0, 999999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bx, -1, W_MAX - 1) || !int(d.br, 0, 3) || !int(d.bw, 0, 9) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    // A falling piece inside the well and clear of the stack, or the table is
    // somebody's invention.
    if (d.k >= 0) {
      for (const [dx, dy] of SHAPES[d.k][d.r]) {
        const cx = d.x + dx, cy = d.y + dy;
        if (cx < 0 || cx >= raw.wd || cy < 0 || cy >= H || raw.g[at(cx, cy)] !== 0) return null;
      }
    }
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, wd: raw.wd, rs: raw.rs, g: raw.g.slice(), p, res, win: raw.win };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, list) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, list: list || null });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: glossy candy blocks in a deep plum well. Each seat has a bright
// colour of its own, its pieces and its blocks alike; rubble is slate, and a
// gold block wears a gold rim whoever dropped it.
const INK = {
  page: '#160f26', glow: '#2b1b48', well: '#1d1533', wellHi: '#251b40', grid: 'rgba(200,180,255,0.05)',
  rim: '#5b4a96', text: '#ffffff', muted: '#cfc6ec', dim: '#8a80b0', gold: '#ffd166', danger: '#ff5a6e',
  rubble: '#5d5a72', outline: '#0e0a1c', panel: 'rgba(20,14,38,0.93)', spawn: 'rgba(255,90,110,0.07)',
};
const SEAT = ['#ff4f7b', '#3fd3ff', '#ffd23f', '#7dff6a', '#c77dff', '#ff8a3d', '#f4f4ff', '#2effc8'];
const FONT = "700 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.page};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a3c7a;' +
  `background:#2b1b48;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, TOP = 58, BOT = 26, dpx = 1;
let CP = 16, FX0 = 0, FY0 = 0, FWP = 192, FHP = 320, fieldBot = 400, shownWd = PRACTICE_W;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
}
layout();
window.addEventListener('resize', layout);

// The well keeps its own shape, as large as the frame lets it be. While the
// table waits for a round a strip under it holds the practice note, which
// would otherwise sit on the bottom row, where the stack is.
function fit(t) {
  const wd = t.wd;
  shownWd = Math.abs(shownWd - wd) < 0.02 ? wd : lerp(shownWd, wd, per60(0.18));
  const room = t.ph === WAIT ? NOTE_ROOM : 20;
  const ah = Math.max(60, VH - TOP - BOT - 4 - room);
  CP = Math.max(3, Math.min((VW - 16) / shownWd, ah / H));
  FWP = wd * CP;
  FHP = H * CP;
  FX0 = (VW - FWP) / 2;
  FY0 = TOP + (ah - FHP) / 2;
  fieldBot = FY0 + FHP;
}

// Cells to the screen: the left or top edge of a column or a row.
const SX = (x) => FX0 + x * CP + shakeX;
const SY = (y) => FY0 + y * CP + shakeY;
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

function nickOf(id) {
  if (id === BOT_ID) return 'bot';
  if (room.me && id === room.me.id) return room.me.nick;
  const p = room.players.find((x) => x.id === id);
  const nick = p ? String(p.nick) : 'p' + id;
  return nick.length > 12 ? nick.slice(0, 11) + '…' : nick;
}

function text(s, x, y, px, colour, align, base) {
  ctx.font = font(px);
  ctx.fillStyle = colour;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = base || 'alphabetic';
  ctx.fillText(s, x, y);
}
function fitText(s, x, y, px, colour, most, align) {
  ctx.font = font(px);
  const wd = ctx.measureText(s).width;
  text(s, x, y, wd > most ? Math.max(7, (px * most) / wd) : px, colour, align);
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function disc(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function darker(hex, k) {
  const c = rgb(hex).map((v) => Math.round(v * (1 - k)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function alpha(hex, a) {
  const c = rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

// Easing per frame, scaled to the frame's length so a fast screen and a slow
// one settle at the same pace.
let frameDt = 1 / 60, lastFrame = 0;
const per60 = (k) => 1 - Math.pow(1 - k, frameDt * 60);
const ease = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
const lerp = (a, b, k) => a + (b - a) * k;

// ── sound ──────────────────────────────────────────────────────────────────
// Made in the page from a few oscillators and a little noise. It starts on the
// first key or touch, because a browser keeps a page silent until then.
let actx = null, muted = false, noise = null;
const lastSound = new Map();
function wake() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { actx = null; }
  }
  if (actx && actx.state === 'suspended') actx.resume();
}
function ready(kind, gap) {
  if (!actx || muted || actx.state !== 'running') return false;
  const now = performance.now();
  if (now - (lastSound.get(kind) || -1e9) < (gap || 40)) return false;
  lastSound.set(kind, now);
  return true;
}
function tone(freq, dur, type, vol, slide, delay) {
  const t = actx.currentTime + (delay || 0);
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}
function puff(dur, vol, freq, delay, q) {
  if (!noise) {
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.6), actx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = actx.currentTime + (delay || 0);
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  src.buffer = noise;
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q || 1.2;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(actx.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}
const sound = {
  turn() { if (ready('turn', 40)) tone(660, 0.05, 'triangle', 0.05, 1.3); },
  slam(me) { if (ready('slam', 50)) { puff(0.12, me ? 0.09 : 0.04, 500, 0, 0.9); tone(150, 0.12, 'sine', me ? 0.09 : 0.04, 0.5); } },
  lock(me, gold) {
    if (!ready('lock', 45)) return;
    tone(me ? 220 : 180, 0.08, 'square', me ? 0.035 : 0.015, 0.7);
    if (gold && me) tone(1320, 0.12, 'triangle', 0.04, 1.2, 0.03);
  },
  clear(rows, me) {
    if (!ready('clear', 120)) return;
    const base = me ? 523 : 440;
    for (let i = 0; i < 2 + rows; i++) tone(base * Math.pow(1.26, i), 0.12, 'triangle', me ? 0.08 : 0.04, 0, i * 0.055);
    puff(0.25, me ? 0.05 : 0.025, 3000, 0, 1.5);
  },
  paid() { if (ready('paid', 90)) tone(1568, 0.08, 'sine', 0.05, 1.1); },
  choke(me) {
    if (!ready('choke', 80)) return;
    puff(me ? 0.55 : 0.35, me ? 0.16 : 0.07, 260, 0, 0.6);
    tone(me ? 110 : 140, me ? 0.5 : 0.3, 'sawtooth', me ? 0.07 : 0.03, 0.4);
  },
  rise() { if (ready('rise', 300)) { puff(0.4, 0.06, 140, 0, 0.7); tone(70, 0.35, 'sine', 0.08, 1.4); } },
  warn() { if (ready('warn', 400)) [392, 370, 349].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.04, 1, i * 0.18)); },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(700, 0.12, 'sine', 0.12, 2.0); tone(1400, 0.25, 'sine', 0.08, 1.0, 0.12); } },
  end(won) {
    if (!ready('end', 500)) return;
    if (won) [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.2, 'triangle', 0.09, 0, i * 0.08));
    else [392, 330, 262].forEach((f, i) => tone(f, 0.25, 'triangle', 0.08, 0, i * 0.12));
  },
};
function setMuted(m) {
  muted = m;
  muteBtn.textContent = muted ? '×' : '♪';
  muteBtn.style.opacity = muted ? '0.6' : '1';
}
muteBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
muteBtn.addEventListener('click', (e) => { e.stopPropagation(); wake(); setMuted(!muted); });

// ── bits: particles, pops, flashes, shake ──────────────────────────────────
// Stepped on a clock of their own at a fixed rate, never once per frame, so a
// fast screen and a slow one see the same sparks. Positions are in cells.
const bits = [];      // { x, y, vx, vy, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const flashes = [];   // { y, life, max, colour }: a row as it clears
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, up) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.25 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (up || 0), life: 0, max: 18 + Math.random() * 24, size, colour });
  }
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 15 }); }
function moveBits(n) {
  for (let j = 0; j < n; j++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.94; b.vy = b.vy * 0.94 + 0.5;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = flashes.length - 1; i >= 0; i--) if (++flashes[i].life >= flashes[i].max) flashes.splice(i, 1);
    shake *= 0.85;
    if (shake < 0.2) shake = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
let drawFailed = false;
const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const cellColour = (v) => (v === RUBBLE ? INK.rubble : SEAT[(v & 15) - 1] || INK.rubble);

function play(e, t) {
  const me = myId();
  if (e.kind === 'lock') {
    const gold = (e.b & GOLD) !== 0, now = performance.now();
    for (const [x, y0, y1] of e.list || []) {
      if (y1 > y0) tumbling.push({ x, y0, y1, v: e.b, at: now, ms: 70 + 25 * Math.sqrt(y1 - y0) });
      spray(x + 0.5, y1 + 1, 2, gold ? INK.gold : cellColour(e.b), 6, 1.5, 2);
    }
    if (tumbling.length > 64) tumbling.splice(0, tumbling.length - 64);
    sound.lock(e.a === me, gold);
  } else if (e.kind === 'slam') {
    if (e.b >= 2) {
      spray(e.x + 0.5, e.y + 1.5, 6 + Math.min(10, e.b), '#ffffff', 9, 1.8, 3);
      if (e.a === me) shake = Math.max(shake, Math.min(6, 1 + e.b * 0.4));
      sound.slam(e.a === me);
    }
  } else if (e.kind === 'row') {
    flashes.push({ y: e.y, life: 0, max: 22 });
    const cells = e.list || [];
    cells.forEach((v, x) => {
      if (v) spray(x + 0.5, e.y + 0.5, 3, v & GOLD ? INK.gold : cellColour(v), 14, 2.2, 6);
    });
  } else if (e.kind === 'clear') {
    const bonus = e.list ? e.list[0] : 0;
    pop(Math.max(1, Math.min(t.wd - 1, e.x + 0.5)), e.y, (e.b >= 4 ? 'pile up! ' : e.b >= 2 ? 'x' + e.b + ' ' : '') + '+' + bonus,
      colourOf(t, e.a), e.a === me ? 20 : 16);
    shake = Math.max(shake, 2 + e.b * (e.a === me ? 2.5 : 1.2));
    sound.clear(e.b, e.a === me);
  } else if (e.kind === 'paid') {
    if (e.a === me) sound.paid();
    scoreBump.set(e.a, 1);
  } else if (e.kind === 'choke') {
    const colour = colourOf(t, e.a);
    spray(e.x + 0.5, e.y, 30, colour, 26, 2.6, 4);
    spray(e.x + 0.5, e.y, 12, '#ffffff', 20, 2, 4);
    pop(e.x + 0.5, e.y + 3, e.b ? 'boom! -' + e.b : 'boom!', INK.danger, e.a === me ? 20 : 16);
    shake = Math.max(shake, e.a === me ? 14 : 6);
    sound.choke(e.a === me);
  } else if (e.kind === 'rise') {
    shake = Math.max(shake, 5);
    for (let x = 0; x < t.wd; x += 2) spray(x + 0.5, e.y + 1, 2, INK.rubble, 10, 2.2, 6);
    sound.rise();
  } else if (e.kind === 'warn') {
    pop(t.wd / 2, H / 2, 'the floor will rise!', INK.danger, 20);
    sound.warn();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}
const scoreBump = new Map();   // id -> a chip swelling for points just paid
// Blocks of a piece just set, on their way down their columns: drawn falling
// from where the piece stood to where the stack has them, and the stack's own
// cell left out until they get there.
const tumbling = [];           // { x, y0, y1, v, at, ms }

function drawGround() {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
}

// The well: a slab a little lighter than the page, a faint grid, a rim that
// glows, and the rows pieces are dealt into tinted, because a stack that
// reaches them chokes.
function drawWell(t, now) {
  const x0 = FX0 + shakeX, y0 = FY0 + shakeY;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(x0 - 7, y0 - 5, FWP + 14, FHP + 16, 10);
  ctx.fill();
  const f = ctx.createLinearGradient(0, y0, 0, y0 + FHP);
  f.addColorStop(0, INK.wellHi);
  f.addColorStop(1, INK.well);
  ctx.fillStyle = f;
  roundRect(x0 - 3, y0 - 3, FWP + 6, FHP + 6, 7);
  ctx.fill();
  ctx.fillStyle = INK.spawn;
  ctx.fillRect(x0, y0, FWP, SPAWN_ROWS * CP);
  ctx.strokeStyle = alpha(INK.danger, 0.35);
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + SPAWN_ROWS * CP);
  ctx.lineTo(x0 + FWP, y0 + SPAWN_ROWS * CP);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = INK.grid;
  ctx.beginPath();
  for (let x = 1; x < t.wd; x++) { ctx.moveTo(x0 + x * CP, y0); ctx.lineTo(x0 + x * CP, y0 + FHP); }
  for (let y = 1; y < H; y++) { ctx.moveTo(x0, y0 + y * CP); ctx.lineTo(x0 + FWP, y0 + y * CP); }
  ctx.stroke();
  ctx.strokeStyle = INK.rim;
  ctx.lineWidth = 2;
  roundRect(x0 - 3, y0 - 3, FWP + 6, FHP + 6, 7);
  ctx.stroke();
  // Each player's lane, as a little tab over the rim in their colour.
  for (const id of inWell(t)) {
    const lane = laneOf(t, id), c = colourOf(t, id);
    const x = x0 + (lane + 0.5) * CP;
    ctx.fillStyle = id === myId() ? c : alpha(c, 0.6);
    ctx.beginPath();
    ctx.moveTo(x - 6, y0 - 9);
    ctx.lineTo(x + 6, y0 - 9);
    ctx.lineTo(x, y0 - 3);
    ctx.closePath();
    ctx.fill();
  }
  if (t.ph === PLAY && PLAY_STEPS - t.pt >= RISE_AT - 2 * HZ) {
    ctx.strokeStyle = alpha(INK.danger, 0.5 + 0.3 * Math.sin(now / 140));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0 - 3, y0 + FHP + 3);
    ctx.lineTo(x0 + FWP + 3, y0 + FHP + 3);
    ctx.stroke();
  }
}

// One block: a rounded candy with a lighter top, a darker foot and a shine.
// Gold blocks carry a gold rim; rubble is flat slate with a crack.
function block(px, py, s, colour, gold, a) {
  const pad = Math.max(0.5, s * 0.06), r = Math.max(1, s * 0.22);
  ctx.globalAlpha = a === undefined ? 1 : a;
  ctx.fillStyle = darker(colour, 0.38);
  roundRect(px + pad, py + pad, s - 2 * pad, s - 2 * pad, r);
  ctx.fill();
  ctx.fillStyle = colour;
  roundRect(px + pad, py + pad, s - 2 * pad, s - 2 * pad - Math.max(1, s * 0.14), r);
  ctx.fill();
  if (s >= 7) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    roundRect(px + s * 0.22, py + s * 0.18, s * 0.34, s * 0.14, s * 0.07);
    ctx.fill();
  }
  if (gold) {
    ctx.strokeStyle = INK.gold;
    ctx.lineWidth = Math.max(1.2, s * 0.12);
    roundRect(px + pad + 1, py + pad + 1, s - 2 * pad - 2, s - 2 * pad - 2, r);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function rubble(px, py, s) {
  const pad = Math.max(0.5, s * 0.06);
  ctx.fillStyle = INK.rubble;
  roundRect(px + pad, py + pad, s - 2 * pad, s - 2 * pad, Math.max(1, s * 0.12));
  ctx.fill();
  if (s >= 8) {
    ctx.strokeStyle = 'rgba(14,10,28,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + s * 0.3, py + s * 0.25);
    ctx.lineTo(px + s * 0.5, py + s * 0.5);
    ctx.lineTo(px + s * 0.42, py + s * 0.78);
    ctx.stroke();
  }
}

function drawStack(t, now) {
  const moving = new Set();
  for (let i = tumbling.length - 1; i >= 0; i--) {
    const f = tumbling[i];
    if (now - f.at >= f.ms || t.g[at(f.x, f.y1)] !== f.v) tumbling.splice(i, 1);
    else moving.add(at(f.x, f.y1));
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < t.wd; x++) {
      const v = t.g[at(x, y)];
      if (!v || moving.has(at(x, y))) continue;
      if (v === RUBBLE) rubble(SX(x), SY(y), CP);
      else block(SX(x), SY(y), CP, cellColour(v), v & GOLD);
    }
  }
  for (const f of tumbling) {
    const k = Math.min(1, (now - f.at) / f.ms);
    block(SX(f.x), SY(f.y0 + (f.y1 - f.y0) * k * k), CP, cellColour(f.v), f.v & GOLD);
  }
}

// A falling piece at (x, y) in cells, which need not be whole: drawn between
// steps. Other players' pieces are a little see-through, because falling
// pieces pass through each other.
function drawPiece(t, id, k, r, x, y, me, now) {
  const d = t.p[id];
  if (!d) return;
  const colour = SEAT[d.c], gold = trailing(t, id);
  for (const [dx, dy] of SHAPES[k][r]) block(SX(x + dx), SY(y + dy), CP, colour, gold, me ? 1 : 0.88);
  if (me) {
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 + 0.25 * Math.sin(now / 160)) + ')';
    ctx.lineWidth = 1.5;
    for (const [dx, dy] of SHAPES[k][r]) {
      roundRect(SX(x + dx) + 1, SY(y + dy) + 1, CP - 2, CP - 2, Math.max(1, CP * 0.2));
      ctx.stroke();
    }
  }
  // The name over the top of the piece, for everybody but you.
  if (!me && CP >= 6) {
    let top = 9, mid = 0;
    for (const [dx, dy] of SHAPES[k][r]) { top = Math.min(top, dy); mid += dx; }
    const px = Math.max(10, Math.min(12, CP * 0.8));
    ctx.font = font(px);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(14,10,28,0.85)';
    const lx = SX(x + mid / 4 + 0.5), ly = SY(y + top) - 3;
    ctx.strokeText(nickOf(id), lx, ly);
    ctx.fillStyle = colour;
    ctx.fillText(nickOf(id), lx, ly);
  }
}

// Where your blocks would end up if dropped now: their outlines in the
// stack, each tumbled down its column, and a faint column under each.
function drawGhost(t, d) {
  let y = d.y;
  while (fits(t, d, d.r, d.x, y + 1)) y += 1;
  const c = SEAT[d.c];
  for (const [cx, , ty] of crumble(t.g, d.k, d.r, d.x, y)) {
    ctx.fillStyle = alpha(c, 0.05);
    ctx.fillRect(SX(cx), SY(0), CP, SY(ty) - SY(0));
    ctx.strokeStyle = alpha(c, 0.7);
    ctx.fillStyle = alpha(c, 0.14);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    roundRect(SX(cx) + 2, SY(ty) + 2, CP - 4, CP - 4, Math.max(1, CP * 0.18));
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawFlashes(t) {
  for (const f of flashes) {
    const k = f.life / f.max;
    ctx.globalAlpha = (1 - k) * 0.85;
    ctx.fillStyle = '#ffffff';
    const grow = ease(k) * CP * 0.5;
    ctx.fillRect(SX(0) - grow, SY(f.y) + CP * 0.5 * k, t.wd * CP + 2 * grow, CP * (1 - k));
  }
  ctx.globalAlpha = 1;
}

function drawBits() {
  flat();
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    const s = b.size * (1 - f * 0.5) * Math.max(0.7, CP / 14);
    ctx.fillRect(SX(b.x) - s, SY(b.y) - s, 2 * s, 2 * s);
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const f = p.life / p.max;
    const rise = 10 + ease(f) * 26;
    const scale = f < 0.15 ? 0.6 + (f / 0.15) * 0.5 : 1.1 - Math.min(0.1, f - 0.15);
    ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
    ctx.font = font(p.px * scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(14,10,28,0.85)';
    const X = Math.max(60, Math.min(VW - 60, SX(p.x))), Y = SY(p.y) - rise;
    ctx.strokeText(p.s, X, Y);
    ctx.fillStyle = p.colour;
    ctx.fillText(p.s, X, Y);
  }
  ctx.globalAlpha = 1;
}

const clock = (steps) => {
  const s = Math.ceil(steps / HZ);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, and the time left in it.
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left';
    if (PLAY_STEPS - t.pt >= RISE_AT) {
      status += ' · the floor rises';
      colour = Math.floor(now / 400) % 2 ? INK.danger : INK.text;
    }
  } else status = 'round ' + t.rd + ' · over';
  text('pile up', 12, 22, titlePx, SEAT[2], 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('pile up').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points; whoever
  // drops gold right now has a gold dot.
  const ids = bySeat(t).filter((id) => t.p[id].st === IN);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(140, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      const bump = scoreBump.get(id) || 0;
      if (bump) scoreBump.set(id, bump < 0.03 ? 0 : bump * (1 - per60(0.08)));
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13 - bump * 2, cw, 22 + bump * 4, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      const gold = trailing(t, id);
      ctx.fillStyle = gold ? INK.gold : c;
      roundRect(x + 6, y - 7, 10, 10, 3);
      ctx.fill();
      if (gold) { ctx.fillStyle = c; ctx.fillRect(x + 9, y - 4, 4, 4); }
      const score = String(d.gn);
      ctx.font = font(12 + bump * 3);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 8, y + 3, 12 + bump * 3, INK.gold, 'right');
      if (cw > 46) fitText(mine ? 'you' : nickOf(id), x + 22, y + 3, 12, mine ? INK.text : INK.muted, cw - 32 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to move · tap to turn · flick down to drop · full rows pay'
    : 'arrows/AD or mouse move · up/X turn · space or click drops · full rows pay · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// The piece after this one, in the strip beside the well when there is room
// for it, and in its top corner, faintly, when there is not.
function drawNext(t) {
  const d = t.p[myId()];
  if (!d || d.st !== IN || t.ph === END) return;
  flat();
  const side = FX0 - 8 >= 64;
  const s = side ? Math.min(14, CP * 0.8) : Math.max(4, CP * 0.45);
  const bx = side ? FX0 + FWP + 14 : FX0 + FWP - 4 * s - 4, by = side ? FY0 + 18 : FY0 + 4;
  if (side) {
    text('next', bx, FY0 + 10, 11, INK.dim, 'left');
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    roundRect(bx - 4, by - 4, 4 * s + 8, 2 * s + 8, 6);
    ctx.fill();
  }
  const gold = trailing(t, myId());
  for (const [dx, dy] of SHAPES[d.nk][0]) {
    const oy = d.nk === 0 ? -1 : 0;
    block(bx + dx * s + (BOX[d.nk] === 2 ? s : BOX[d.nk] === 3 ? s / 2 : 0), by + (dy + oy) * s, s, SEAT[d.c], gold, side ? 1 : 0.45);
  }
  if (side && gold) fitText('gold: x2', bx, by + 2 * s + 22, 11, INK.gold, FX0 - 16, 'left');
}

// Under the well while a round is on: what you are doing in it.
function drawMine(t) {
  if (t.ph !== PLAY) return;
  flat();
  const d = t.p[myId()];
  const y = fieldBot + 15;
  let line;
  if (!d || d.st !== IN) line = 'watching · you play from the next round';
  else if (trailing(t, myId())) line = 'you trail · your blocks are gold and pay double';
  else line = 'your blocks pay you when their row clears · finish a row for +' + CLOSE_BONUS[1];
  fitText(line, VW / 2, y, 11, d && trailing(t, myId()) ? INK.gold : INK.dim, VW - 24);
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

// Practice ends a moment after a second player arrives: who it was, as this
// page sees it — the room lists its players in the order they came.
function joinHead(t, left) {
  const me = myId();
  const order = (id) => { const i = room.players.findIndex((p) => p.id === id); return i < 0 ? 1e9 : i; };
  const hs = humans(t).sort((a, b) => order(a) - order(b));
  const last = hs[hs.length - 1];
  return (last === me ? 'you joined ' + nickOf(hs[0]) : nickOf(last) + ' joined') + ' · practice ends in ' + left;
}

function panel(px, py, w, h) {
  ctx.fillStyle = INK.panel;
  roundRect(px - w / 2, py - h / 2, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawOverlay(t, now) {
  flat();
  const cx = VW / 2, mid = (FY0 + fieldBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'full rows pay every block in them to its owner · finishing one pays a bonus';
    practiceNote(now, VW, head, tip, [[fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(14,10,28,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big * 0.3);
    text(String(n), cx, mid + big * 0.3, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    const w = Math.min(VW - 32, 360);
    panel(cx, mid + big * 1.7, w, 46);
    fitText('a full row pays each block in it to its owner', cx, mid + big * 1.7 - 4, 13, INK.text, w - 20);
    fitText('finish it yourself for a bonus · trailing drops gold', cx, mid + big * 1.7 + 14, 12, INK.gold, w - 20);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(14,10,28,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('go!', cx, mid + big * 0.5);
    text('go!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head, hc = INK.text;
    if (t.win !== -1) {
      head = t.win === me ? 'you take the round!' : nickOf(t.win) + ' takes the round';
      hc = colourOf(t, t.win);
    } else head = 'a tie at the top';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, hc, w - 24);
    text('rows finished', cx + w / 2 - 70, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, gn, ln, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      roundRect(cx - w / 2 + 19, y - 9, 10, 10, 3);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 170, 'left');
      text(String(ln), cx + w / 2 - 70, y, 14, INK.text, 'right');
      text(String(gn), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a piece stands as drawn: between two steps, and never slid across a
// jump — a new piece, a turn, or a drop.
function pieceAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z || z.k < 0) return null;
  if (!a || a.k !== z.k || a.pc !== z.pc || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 2) return [z.k, z.r, z.x, z.y, z];
  return [z.k, z.r, lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

// Your own piece is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a move a step away from where
// the guess had it. So the piece drawn is pulled toward the guess a little
// every frame rather than put on it, and a new piece, or one moved far, is put
// there at once. Only the drawing is smoothed: the well, and every rule in it,
// are untouched.
const PULL = 0.55;
let shown = null;        // [x, y, pc] in cells: where your piece is drawn
let myMid = null;        // the column your piece's middle stands over, as drawn

function settle(x, y, pc) {
  if (!shown || shown[2] !== pc || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 3) return (shown = [x, y, pc]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  const b = agreedAt(now);
  drawGround();
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the well…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  fit(t);
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a table this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  flat();
  drawWell(t, now);
  drawStack(t, now);
  const me = myId();
  for (const id of bySeat(t)) {
    if (id === me) continue;
    const p = pieceAt(b, id);
    if (p) drawPiece(t, id, p[0], p[1], p[2], p[3], false, now);
  }
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : b;
  const p = t.p[me] && t.p[me].st === IN ? pieceAt(own, me) : null;
  if (p) {
    const [x, y] = settle(p[2], p[3], p[4].pc);
    myMid = x + MID[p[0]][p[1]];
    drawGhost(own.to, p[4]);
    drawPiece(t, me, p[0], p[1], x, y, true, now);
  } else {
    shown = null;
    myMid = null;
  }
  drawFlashes(t);
  drawBits();
  drawHud(t, now);
  drawNext(t);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: a push left or right from the keys, or a column to slide
// to from a thumb or a mouse; a turn counter, a drop counter, and whether the
// piece is held down. A column picked goes out no oftener than SLIDE_SAY,
// because a pointer changes it on every move the screen reports and the
// clock's ticks share the same seat's ceiling on messages; a push, a turn and
// a drop go at once.
const SLIDE_SAY = 60;
let mode = '';           // what moves the piece: 'keys', 'mouse', 'touch', or nothing yet
let turns = 0, drops = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_PUSH = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
const TURN_KEYS = new Set(['ArrowUp', 'KeyW', 'KeyX']);
const BACK_KEYS = new Set(['KeyZ', 'KeyQ']);
const SOFT_KEYS = new Set(['ArrowDown', 'KeyS']);
const DROP_KEYS = new Set(['Space', 'Enter']);

// A thumb: drag across and the piece follows, a column for every so many
// pixels from where the thumb landed; drag down and hold to hurry it, flick
// down to drop it, tap to turn it — drags and taps, because iOS keeps a long
// press inside a frame for itself. A mouse: the piece slides to the column
// under the pointer; a click drops, a right click or the wheel turns.
let drag = null;         // { id, ox, oy, from, at, moved, lx, ly, lt }
let pinned = null;       // the piece a thumb's column was picked for
const mouse = { col: -1 };
let wheelAt = 0;
const colPx = () => Math.max(CP, 18);

function wellCol(clientX) {
  const r = cv.getBoundingClientRect();
  const wd = world ? world.wd : PRACTICE_W;
  return Math.max(0, Math.min(wd - 1, Math.floor((clientX - r.left - FX0) / CP)));
}

function handNow() {
  let m = 0, v = 0, sd = 0;
  if (mode === 'keys') {
    for (const c of keys) if (c in KEY_PUSH) v += KEY_PUSH[c];
    v = Math.max(-1, Math.min(1, v));
    for (const c of keys) if (SOFT_KEYS.has(c)) sd = 1;
  } else if (mode === 'mouse' && mouse.col >= 0) {
    m = 1;
    v = mouse.col;
  } else if (mode === 'touch' && drag && drag.col >= 0) {
    m = 1;
    v = drag.col;
    sd = drag.soft ? 1 : 0;
  } else if (mode === 'touch' && pinned && pinned.col >= 0) {
    m = 1;
    v = pinned.col;
  }
  return [m, v, turns, drops, sd];
}

function sayHand(now, force) {
  const h = handNow(), s = lastSaid;
  if (s && h.every((v, i) => v === s[i])) return;
  if (!force && s && h[2] === s[2] && h[3] === s[3] && h[4] === s[4] && now - saidAt < SLIDE_SAY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

const mine = () => (world && world.p[myId()] && world.p[myId()].st === IN && world.p[myId()].k >= 0 ? world.p[myId()] : null);

// A turn and a drop: heard at once, and made a trip later on every copy alike.
function turnPiece(back) {
  wake();
  turns = (turns + (back ? 3 : 1)) % 1000;
  sayHand(performance.now(), true);
  if (mine()) sound.turn();
}
function dropPiece() {
  wake();
  drops = (drops + 1) % 1000;
  sayHand(performance.now(), true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (TURN_KEYS.has(e.code) || BACK_KEYS.has(e.code)) {
    e.preventDefault();
    if (!e.repeat) turnPiece(BACK_KEYS.has(e.code));
    return;
  }
  if (DROP_KEYS.has(e.code)) {
    e.preventDefault();
    if (!e.repeat) dropPiece();
    return;
  }
  if (!(e.code in KEY_PUSH) && !SOFT_KEYS.has(e.code)) return;
  e.preventDefault();
  coarse = false;
  mode = 'keys';
  keys.add(e.code);
  sayHand(performance.now(), true);
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  sayHand(performance.now(), true);
});
addEventListener('blur', () => {
  keys.clear();
  drag = null;
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const now = performance.now();
  if (now - wheelAt < 110) return;
  wheelAt = now;
  turnPiece(e.deltaY < 0);
}, { passive: false });
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    mode = 'touch';
    // A second finger while the first drags turns the piece.
    if (drag) { turnPiece(false); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    const now = performance.now();
    const from = myMid !== null ? Math.round(myMid) : pinned ? pinned.col : Math.floor((world ? world.wd : PRACTICE_W) / 2);
    drag = { id: e.pointerId, ox: e.clientX, oy: e.clientY, from, col: -1, at: now, moved: false, soft: false, lx: e.clientX, ly: e.clientY, lt: now, vy: 0 };
    return;
  }
  coarse = false;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mode = 'mouse';
  mouse.col = wellCol(e.clientX);
  if (e.button === 2) turnPiece(false);
  else dropPiece();
});
cv.addEventListener('pointermove', (e) => {
  if (drag && e.pointerId === drag.id) {
    const now = performance.now();
    const dx = e.clientX - drag.ox, dy = e.clientY - drag.oy;
    if (Math.abs(dx) + Math.abs(dy) > 10) drag.moved = true;
    const wd = world ? world.wd : PRACTICE_W;
    if (Math.abs(dx) > 6 || drag.col >= 0) drag.col = Math.max(0, Math.min(wd - 1, drag.from + Math.round(dx / colPx())));
    drag.soft = dy > 34 && dy > Math.abs(dx);
    const dt = Math.max(1, now - drag.lt);
    drag.vy = drag.vy * 0.5 + ((e.clientY - drag.ly) / dt) * 0.5;
    drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = now;
    sayHand(now, false);
  } else if (e.pointerType === 'mouse') {
    // A mouse resting on the frame while the keys move the piece leaves it to them.
    if (mode === 'keys' && keys.size) return;
    const col = wellCol(e.clientX);
    if (mode !== 'mouse' && col === mouse.col) return;
    mode = 'mouse';
    mouse.col = col;
    coarse = false;
  }
});
function liftPointer(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const now = performance.now();
  const dy = e.clientY - drag.oy, dx = e.clientX - drag.ox;
  const tap = !drag.moved && now - drag.at < 260;
  const flick = dy > 40 && dy > Math.abs(dx) * 1.3 && drag.vy > 0.6;
  // The column picked holds for the piece it was picked for, so a piece let
  // go of on its way still gets there; the next one is dealt free of it.
  pinned = drag.col >= 0 && world && world.p[myId()] ? { col: drag.col, pc: world.p[myId()].pc } : null;
  drag = null;
  sayHand(now, true);
  if (tap) turnPiece(false);
  else if (flick) dropPiece();
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', liftPointer);
addEventListener('pointerup', liftPointer);
addEventListener('pointercancel', liftPointer);

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  if (pinned && !drag && world) {
    const d = world.p[myId()];
    if (!d || d.pc !== pinned.pc) pinned = null;
  }
  sayHand(now, false);
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a player arrives in the well.
function start() {
  lastSaid = [0, 0, turns, drops, 0];
  setHand(lastSaid);
  requestAnimationFrame(frame);
}

// ═══════════════════ the lockstep kernel ═══════════════════
// The kernel every lockstep disk carries at its end, word for word. A disk is
// one file with no imports, so it cannot share this; `splice.py` writes it into
// each of them between the kernel's two marker lines, and `--check` fails when
// one has drifted.
//
// A table is the whole state of a game: plain data, fingerprinted and handed
// over as JSON. Every copy changes it only on what comes back round the room —
// hands and ticks alike are sent with `{ echo: true }` — so every copy applies
// the same things in the same order and holds the same table. One copy sends
// the ticks, which is keeping a clock and nothing more: a hand joins whichever
// tick reaches the server after it, so how far that copy is from the server
// decides how evenly the table moves and not how late anybody's hand lands. The
// host keeps the clock while its page is on screen, and the next in the room's
// line stands in for it when its ticks stop — see the clock, below.
//
// Every copy runs these same bytes, but a page with a console open does not
// have to, and anything it sends is read as a claim. Nobody can be taken off the
// table by a tick unless every copy can see for itself that they are gone or
// silent; a tick's word that the tables have parted is taken from the host, or
// from a stand-in while the host is quiet, and from nobody else; a handover is
// one sender's table, the host's before anybody's. What stays open, and is not
// claimed otherwise: a tick moves the table forward whoever sends it, so such a
// page can run the game faster for everybody, and it can play its own hand any
// way it likes — the table is agreed, not refereed.
//
// What the game above provides:
//
//   HZ, STEPS_PER_TICK, PREDICT, and KEEP_SILENT if a silent player should stay
//   freshTable(seed)     a new table, without `n` and `seen` — those are the kernel's
//   step(w)              one step; `w.n` is already the step being taken
//   hand(w, id, input)   a hand, at its place in the room's order
//   inputOf(raw)         a hand off the wire made safe, or null
//   leave(w, id)         somebody is gone from the room
//   playersIn(w)         the ids the table has a place for
//   tableOf(raw)         a table off the wire made safe, or null
//   start()              called once, when the kernel stands
//
// What the kernel gives the game:
//
//   world                the table the room agrees on, or null while catching up
//   agreedAt(now)        { from, to, k } — the agreed table as drawn, on a steady
//                        clock a little behind the last tick: everybody else's pieces
//   mineAt(now)          { from, to, k } — the same a trip ahead, with this copy's
//                        hands in it: this copy's own piece. The agreed table
//                        when PREDICT is off
//   setHand(input)       this copy's hand has changed
//   live                 true only while the agreed table steps: effects — a
//                        sound, a spray of blood — are made then, so a guess
//                        replayed ten times makes none of them
//   wireNote()           a line saying what the wire costs, for a corner

const STEP_MS = 1000 / HZ;
const TICK_MS = STEP_MS * STEPS_PER_TICK;
const TICK_BATCH = 4;                    // ticks' worth of steps one tick may carry after a stall
const HAND_EVERY = 1000;                 // a hand held still is said again this often
const RESEND_AFTER = 500;                // a hand the room never handed back is said again
const HANDOVER_WAIT = 3000;              // how long to wait for somebody to hand the table over
const HANDOVER_GRACE = 500;              // how long a handover from anybody but the host waits for the host's
// A hand not heard from in this long has left the table — unless the game says
// otherwise with `KEEP_SILENT`, where leaving the table costs more than a
// silent player standing at it does.
const SILENT_STEPS = typeof KEEP_SILENT !== 'undefined' && KEEP_SILENT ? Infinity : 3 * HZ;
const PRINTS_KEPT = 10 * HZ;             // steps of fingerprints kept to compare with the clock's
const HANDOVER_PIECE = 3000;             // characters of a table in one piece of a handover
const GUESS_REACH = Math.ceil(400 / STEP_MS); // a guess never reaches further ahead than this

const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const isHost = (id) => room.host !== null && room.host.id === id;

let world = null;
let helloNonce = null;                   // which of my requests for the table is the live one
let helloHeard = false;                  // whether the room has handed that request back
let helloAt = 0;
const streamBacklog = [];                // what the room said after my request, until the table arrives
const handovers = new Map();             // sender -> a handover of theirs being put together
let offered = null;                      // { from, table, at }: a whole handover from somebody not the host
const prints = new Map();                // step -> fingerprint of the table right after it
let lastPrint = null;
let catchUpFrom = 0;                     // the first step whose fingerprint this copy vouches for
let live = false;

let myHand = null;
let inSeq = 0;
const unheard = [];                      // my hands the room has not handed back yet
const unticked = [];                     // my hands handed back, waiting for the tick that moves them
const lags = [];                         // hand to agreed table, ms — kept for a check to read
let lagMs = null;
let tripMs = null;                       // hand to its own echo, ms
// Steps the guess is moved by, learned from where my hands actually land. The
// steady clock settles on the earliest ticks, so on a wire whose delay jumps it
// runs ahead of the table most ticks arrive at, and the trip on top of it puts
// every hand a step or three later than the room does — my piece snapping back
// each time the truth arrives. Each hand that comes back says by how much.
let guessOff = 0;
const GUESS_LEARN = 0.2;                 // how much of one hand's miss moves the guess
const GUESS_MISS = 3;                    // the most steps one hand's miss counts for
let echoAt = null;                       // when something this copy sent last came back to it
const ECHO_LOST = 3000;                  // ms without an echo that mean echoes are not coming back

// Whether what this copy sends comes back to it. A page opened before the
// server learned the echo sends everything as a plain broadcast, so nothing it
// says ever comes back: its table never moves on its own ticks or its own
// hands, and it is wrong about everything from then on. Such a copy must not
// keep the clock or hand anybody its table — one that did would hand a stale
// table to every copy that asked, and tick a clock nobody's table agrees with,
// round and round.
const hearsItself = (now) => solo() || (echoAt !== null && now - echoAt < ECHO_LOST);

// The fingerprint of a table. The text of a number is fixed by the language,
// so equal tables print equally.
function fingerprint(w) {
  const text = JSON.stringify(w);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function startTable(seed) {
  const t = freshTable(seed);
  t.n = 0;
  t.seen = {};
  return t;
}

// The kernel's own part of a table off the wire, then the game's.
function readTable(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.n) || raw.n < 0) return null;
  const t = tableOf(raw);
  if (!t) return null;
  t.n = raw.n;
  t.seen = {};
  for (const [id, at] of Object.entries(raw.seen || {})) {
    if (Number.isInteger(Number(id)) && Number.isInteger(at)) t.seen[id] = at;
  }
  return t;
}

const copyTable = (w) => JSON.parse(JSON.stringify(w));

// Everything that changes the table goes round the room, the sender's copy
// included. Without a room there is nobody to go round, and it is applied here.
function emitRoom(msg) {
  if (solo()) fromStream(myId(), msg);
  else room.send(msg, { echo: true });
}

function adoptTable(table) {
  world = table;
  tableAt = movedAt = performance.now();
  prints.clear();
  lastPrint = null;
  catchUpFrom = table.n;
  keepAgreed(true);
  guessPrev = guessLast = null;
  reshow();
}

function askForTable() {
  world = null;
  helloHeard = false;
  streamBacklog.length = 0;
  handovers.clear();
  offered = null;
  // Not part of the table: it only tells this request from an older one.
  helloNonce = Math.floor(Math.random() * 1e9);
  helloAt = performance.now();
  room.send({ t: 'hello', nonce: helloNonce }, { echo: true });
}

// A copy that has parted from the others does not argue: it drops its table
// and asks for the room's.
function parted(why) {
  console.log('this table parted from the room (' + why + ') — asking for it again');
  askForTable();
}

function fromStream(from, msg) {
  // Anything of this copy's that comes back round is an echo, whatever the
  // table goes on to make of it; and a tick is a clock somebody is keeping,
  // whether or not this copy holds a table to step yet.
  const now = performance.now();
  if (from === myId()) echoAt = now;
  if (msg.t === 'tick') clockHeard.set(from, now);
  if (!world) {
    if (msg.t === 'hello' && from === myId() && msg.nonce === helloNonce) {
      // From here on is what the table handed over has not seen.
      helloHeard = true;
      streamBacklog.length = 0;
    } else if (helloHeard) {
      streamBacklog.push([from, msg]);
    }
    return;
  }
  applyStream(from, msg);
}

function applyStream(from, msg) {
  if (msg.t === 'in') {
    const input = inputOf(msg.i);
    if (input === null || !Number.isInteger(from)) return;
    hand(world, from, input);
    world.seen[from] = world.n;
    lateAgreed = null;
    if (from === myId()) heardMine(msg.s);
  } else if (msg.t === 'tick') {
    onTick(from, msg);
  } else if (msg.t === 'hello' && from !== myId() && hearsItself(performance.now()) &&
             (isHost(myId()) || isHost(from) || keepsClock(performance.now()))) {
    // Every copy holding the table holds this one at this point in the order,
    // which is exactly where the newcomer will replay from. The host answers,
    // and whoever is standing in for its clock — a host whose tab is out of
    // sight answers nobody — or, when the host is the one asking, everybody who
    // can. Two answers are the same table twice.
    handOver(from, msg.nonce, JSON.stringify(world));
  }
}

function heardMine(seq) {
  const now = performance.now();
  while (unheard.length && unheard[0].seq <= seq) {
    const h = unheard.shift();
    if (h.seq !== seq) continue;
    const trip = now - h.at;
    tripMs = tripMs === null ? trip : tripMs * 0.8 + trip * 0.2;
    if (h.measured) unticked.push(h);
    if (h.clocked && world) {
      // It lands at the table as it stands now, and steps on from there.
      const miss = Math.max(-GUESS_MISS, Math.min(GUESS_MISS, world.n - h.step));
      guessOff = Math.max(-GUESS_REACH, Math.min(GUESS_REACH, guessOff + miss * GUESS_LEARN));
    }
  }
}

// A handover, cut into pieces a payload holds and sent a few milliseconds
// apart rather than in one loop, so that it never meets the burst ceiling.
function handOver(to, nonce, text) {
  const of = Math.max(1, Math.ceil(text.length / HANDOVER_PIECE));
  for (let i = 0; i < of; i++) {
    const part = text.slice(i * HANDOVER_PIECE, (i + 1) * HANDOVER_PIECE);
    setTimeout(() => room.send({ t: 'snap', nonce, i, of, part }, { to }), i * 15);
  }
}

// A tick names the step it brings the table to rather than how many steps to
// take. Two clocks ticking at once — a stand-in taking over while the one it
// stands in for comes back — then bring the table to the same step twice, and
// the second does nothing; a tick the room lost is made up by the next one.
//
// Whether this copy has parted is its own business, so what a tick says about
// that is believed only from a sender entitled to say it; whether the table
// steps is everybody's, so that turns on nothing but the tick and the table.
function onTick(from, msg) {
  const to = msg.to;
  if (!Number.isInteger(to)) return;
  if (to <= world.n) return;
  const k = to - world.n;
  const vouched = isHost(from) || hostQuiet(performance.now());
  if (k > STEPS_PER_TICK * TICK_BATCH * 2) return vouched ? parted('the clock is somewhere else') : undefined;

  // The clock says what the table looked like when it last saw it. That step
  // is behind this one in the room's order, so this copy has been there too —
  // and if it saw something else, or cannot have been there at all, it has
  // parted.
  if (vouched && Number.isInteger(msg.hn)) {
    if (msg.hn > world.n || msg.hn < world.n - PRINTS_KEPT) return parted('the clock is somewhere else');
    if (msg.hn >= catchUpFrom && prints.has(msg.hn) && prints.get(msg.hn) !== msg.h) {
      return parted('different tables at step ' + msg.hn);
    }
  }

  // Somebody leaves the table only if every copy can see for itself that they
  // should: they are gone from the room, or the table has not heard them in a
  // while. The room's roster is the same on every copy at this point in the
  // order, and so is the table; a name on the list alone is nobody's word.
  if (Array.isArray(msg.drop)) {
    const here = new Set(room.players.map((p) => p.id));
    for (const id of msg.drop) {
      if (!Number.isInteger(id)) continue;
      const heard = world.seen[id];
      if (here.has(id) && heard !== undefined && world.n - heard <= SILENT_STEPS) continue;
      leave(world, id);
      delete world.seen[id];
    }
  }
  live = true;
  try {
    for (let i = 0; i < k; i++) {
      world.n += 1;
      step(world);
    }
  } finally {
    live = false;
  }

  movedAt = performance.now();
  lastPrint = world.n;
  prints.set(world.n, fingerprint(world));
  for (const n of prints.keys()) {
    if (n < world.n - PRINTS_KEPT) prints.delete(n);
    else break;
  }

  const now = performance.now();
  for (const h of unticked.splice(0)) {
    const lag = now - h.at;
    lags.push(Math.round(lag));
    if (lags.length > 200) lags.shift();
    lagMs = lagMs === null ? lag : lagMs * 0.7 + lag * 0.3;
  }
  keepAgreed(false);
  reshow();
}

// A handover is put together from one sender's pieces alone. The request's
// nonce comes back round the room to everybody, so anybody can answer it; pieces
// from two senders mixed are a table nobody sent, and one sender answering with
// a table of its own making must not be able to finish somebody else's.
//
// Whose table is taken is decided by who sent it rather than by who was
// quickest. The host's is taken the moment it is whole. Anybody else's — a
// stand-in answering for a host out of sight, or everybody answering a host
// that asked — waits a moment for the host's, and then the one from whoever
// stands earliest in the room's line is taken. A player with a console open can
// still answer first; they can no longer be taken first for it.
room.on('message', (from, msg) => {
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t !== 'snap') return fromStream(from, msg);
  if (world || !helloHeard || msg.nonce !== helloNonce) return;
  if (!Number.isInteger(msg.of) || msg.of < 1 || msg.of > 64 || !Number.isInteger(msg.i)) return;
  if (msg.i < 0 || msg.i >= msg.of || typeof msg.part !== 'string') return;
  let parts = handovers.get(from);
  if (!parts || parts.of !== msg.of) handovers.set(from, (parts = { of: msg.of, got: [] }));
  parts.got[msg.i] = msg.part;
  for (let i = 0; i < parts.of; i++) if (typeof parts.got[i] !== 'string') return;
  handovers.delete(from);
  let table = null;
  try { table = readTable(JSON.parse(parts.got.join(''))); } catch (_) { table = null; }
  if (!table) return;
  if (isHost(from)) return takeHandover(table);
  if (!offered || placeOf(from) < placeOf(offered.from)) {
    offered = { from, table, at: offered ? offered.at : performance.now() };
  }
});

function takeHandover(table) {
  adoptTable(table);
  // Everything the room said since my request, on top of the table as it
  // stood at my request.
  for (const [f, m] of streamBacklog.splice(0)) {
    if (!world) break;
    applyStream(f, m);
  }
}

// ── the hand ────────────────────────────────────────────────────────────────
function setHand(input) {
  if (myHand !== null && JSON.stringify(input) === JSON.stringify(myHand)) return;
  myHand = input;
  sendHand(true);
  reshow();
}

function sendHand(measured) {
  if (myHand === null) return;
  inSeq += 1;
  // The step the room will apply this hand at: the agreed table it will have
  // stepped to by the time the hand comes back, read off the steady clock and
  // the measured trip rather than off the last table and a rounded reach. A
  // guess that puts a turn one step early or late is a piece that snaps a step
  // when the truth arrives, and on a board of coarse steps that is a whole cell.
  // Only a hand placed off the clock, after a tick has set it, teaches the
  // guess anything: one placed without it was never the guess's to miss.
  const clocked = !!world && stepClock !== null && !stepClockGuessed && tripMs !== null;
  const at = world
    ? stepClock !== null && tripMs !== null
      ? Math.max(world.n, Math.floor(stepNow(performance.now()) + tripMs / STEP_MS + guessOff))
      : world.n + aheadSteps()
    : 0;
  unheard.push({ seq: inSeq, at: performance.now(), step: at, input: myHand, measured, clocked });
  if (unheard.length > 64) unheard.shift();
  emitRoom({ t: 'in', s: inSeq, i: myHand });
}

// ── what is drawn ───────────────────────────────────────────────────────────
// Two things are drawn, on one steady clock.
//
// The agreed table, a little in the past. Every table a tick produces is kept
// with the step it stands at, and the drawing walks between two of them at a
// pace set by the step numbers rather than by when each happened to arrive. A
// tick that lands a few milliseconds early or late then moves nothing on
// screen; walking from whatever arrived last, every one of them is a jolt.
//
// And this copy's own piece, a trip ahead: the agreed table played forward by
// the trip it takes, with this copy's hands in it, remade whenever the agreed
// table moves or a hand changes. The guess is kept at two steps a tick apart,
// both played from the same agreed table in one pass, and the piece walks
// between them on the same clock — two guesses from two different tables
// disagree about a turn made in between, and the piece covers both of their
// ideas of it in one tick. A game
// draws its own piece from the guess and everybody else's from the agreed
// table, because a guess about somebody else's hand is wrong every time they
// change it, and a piece that jumps back a whole trip each time is worse to
// watch than one that is a trip late.
const SHOWN_BEHIND = 1.5 * STEPS_PER_TICK;   // steps the agreed drawing trails the last tick
const SHOWN_KEPT = 8;
const agreed = [];                           // [{ n, t }], oldest first
let stepClock = null;                        // when step 0 would have arrived, ms
let stepClockGuessed = false;                // set from a table taken, not yet from a tick
let guessPrev = null, guessLast = null;     // { n, t }
let guessTable = null;
let reach = 0;                               // steps the guess runs ahead of the agreed table

function aheadSteps() {
  if (!PREDICT || solo() || tripMs === null) return 0;
  // Moved only when the trip has moved a whole step: a guess that flips
  // between two reaches jumps everything it draws back and forth by a step.
  // The piece is drawn as far ahead as its hands land: drawn any further, a
  // hand lands in what is already on screen and the piece jumps as it is made.
  const want = Math.max(0, Math.min(GUESS_REACH, tripMs / STEP_MS + guessOff));
  if (Math.abs(want - reach) >= 1) reach = Math.round(want);
  return reach;
}

function keepAgreed(fresh) {
  if (fresh) { agreed.length = 0; stepClock = null; }
  agreed.push({ n: world.n, t: copyTable(world) });
  while (agreed.length > SHOWN_KEPT) agreed.shift();
  // Early arrivals pull the clock in quickly, late ones push it out slowly:
  // it settles on the steady pace the host's ticks are sent at, not on the
  // wire's jitter.
  //
  // A table taken is no arrival: it stands a whole trip ahead of the first tick
  // that comes back round, and a clock set by it is one that late ones would
  // take seconds to push out — every frame of those seconds drawn on the newest
  // table, the game moving in jolts. So it holds the clock only until that
  // tick, and the tick sets it outright.
  const o = performance.now() - world.n * STEP_MS;
  if (stepClock === null || stepClockGuessed) stepClock = o;
  else stepClock += (o - stepClock) * (o < stepClock ? 0.3 : 0.02);
  stepClockGuessed = fresh;
}

// The step the clock says it is, as a fraction.
const stepNow = (now) => (now - stepClock) / STEP_MS;

// The agreed table played forward with this copy's unheard hands, each at the
// step it was made at; `keep` is a step to take a copy at on the way.
function played(steps, keep) {
  const w = copyTable(world);
  let kept = steps - keep <= 0 ? copyTable(w) : null;
  let i = 0;
  for (let s = 0; s < steps; s++) {
    while (i < unheard.length && unheard[i].step <= w.n) hand(w, myId(), unheard[i++].input);
    w.n += 1;
    step(w);
    if (s + 1 === steps - keep) kept = copyTable(w);
  }
  while (i < unheard.length) hand(w, myId(), unheard[i++].input);
  return [kept, w];
}

function reshow() {
  lateAgreed = lateMine = null;
  if (!world) return;
  if (!PREDICT || solo()) { guessPrev = guessLast = guessTable = null; return; }
  const reachNow = Math.max(aheadSteps(), STEPS_PER_TICK);
  const [before, t] = played(reachNow, STEPS_PER_TICK);
  guessPrev = { n: before.n, t: before };
  guessLast = { n: t.n, t };
  guessTable = t;
}

// A table among `list` — [{ n, t }], in step order — as drawn at step `at`.
function walkAt(list, at) {
  let i = list.length - 1;
  while (i > 0 && list[i].n > at) i--;
  const a = list[i], b = list[i + 1] || a;
  const k = b === a ? 0 : Math.max(0, Math.min(1, (at - a.n) / (b.n - a.n)));
  return { from: a.t, to: b.t, k };
}

// The agreed table as drawn: { from, to, k }.
function agreedAt(now) {
  if (!agreed.length) return null;
  const at = stepNow(now) - SHOWN_BEHIND;
  const last = agreed[agreed.length - 1];
  if (at > last.n && world && world.n === last.n) {
    if (!lateAgreed) lateAgreed = lateFrom(last, world, PREDICT && !solo());
    const to = Math.min(at, last.n + LATE_STEPS);
    return walkAt(playOn(lateAgreed, Math.ceil(to)), to);
  }
  return walkAt(agreed, at);
}

// This copy's own piece as drawn: { from, to, k } — the agreed table where
// there is no guess to draw it from.
function mineAt(now) {
  if (!guessLast) return agreedAt(now);
  const a = guessPrev || guessLast, b = guessLast;
  const at = stepNow(now) + Math.max(reach, STEPS_PER_TICK) - STEPS_PER_TICK;
  if (at > b.n && world) {
    // The guess's last table has every hand of this copy in it already.
    if (!lateMine) lateMine = lateFrom(b, b.t, false);
    const to = Math.min(at, b.n + LATE_STEPS);
    return walkAt(playOn(lateMine, Math.ceil(to)), to);
  }
  const k = b.n === a.n ? 1 : Math.max(0, Math.min(1, (at - a.n) / (b.n - a.n)));
  return { from: a.t, to: b.t, k };
}

// ── when a tick is late ─────────────────────────────────────────────────────
// A tick that is late leaves the drawing nothing newer to walk to, and a
// drawing that stands on the newest table until the tick lands is a game that
// stops dead and then jumps — on a wire that stalls for a tenth of a second
// now and then, which is any wifi, that is several times a minute. So the
// drawing walks on into tables played forward from the newest one, every hand
// held as it stands, and this copy's own where it guesses, at the steps they
// will land at.
//
// Only the drawing walks on. The table, its fingerprints and everything that
// is decided wait for the tick as before, and `live` is off, so no effect
// comes of a table played this way: the effect comes with the tick. When the
// tick lands the walk is dropped for the truth, and the two differ only if a
// hand changed in between. That is why the walk is short: a point or a hit the
// room never agreed on is on screen for a few frames at most, and a clock that
// has stopped altogether — a host gone, a tab hidden — leaves the drawing
// standing a little ahead rather than running away from the table.
const LATE_REACH_MS = 120;
const LATE_STEPS = Math.max(1, Math.round(LATE_REACH_MS / STEP_MS));
let lateAgreed = null;                       // the walk on from the newest agreed table
let lateMine = null;                         // the walk on from the guess's last table

function lateFrom(start, tip, hands) {
  return { list: [start], tip, hands, seq: 0 };
}

// The walk taken as far as step `to`, a step at a time, each kept: a frame
// asks for the step it is at, and the walk is played once and not per frame.
function playOn(late, to) {
  const wasLive = live;
  live = false;
  try {
    while (late.list[late.list.length - 1].n < to) {
      const t = copyTable(late.tip);
      if (late.hands) {
        for (const h of unheard) {
          if (h.seq <= late.seq) continue;
          if (h.step > t.n) break;
          hand(t, myId(), h.input);
          late.seq = h.seq;
        }
      }
      t.n += 1;
      step(t);
      late.tip = t;
      late.list.push({ n: t.n, t });
    }
  } finally {
    live = wasLive;
  }
  return late.list;
}

function wireNote() {
  if (solo()) return 'solo';
  if (world && !hearsItself(performance.now()) && performance.now() - tableAt > ECHO_LOST) {
    return 'this page does not hear itself — reload it';
  }
  if (!world) return 'catching up';
  const trip = tripMs === null ? '—' : Math.round(tripMs) + ' ms';
  return (keepsClock(performance.now()) ? 'you keep the clock · ' : '') + 'trip ' + trip;
}

// ── the clock ───────────────────────────────────────────────────────────────
// Whoever keeps the clock sends the ticks; every copy, the keeper's included,
// steps the table only when a tick comes back round.
//
// The host keeps it while its page is on screen. Everybody else stands in line
// behind it in the room's order, and takes the clock over when nobody ahead of
// them has ticked for a while — the longer the further back they stand, so that
// one stand-in starts at a time — and hands it back the moment somebody ahead
// ticks again. A page out of sight keeps no clock: a browser slows the timers of
// a tab in the background to a crawl, and a clock kept there stops the game for
// everybody. The line is read off `room.players`, which is the room's own order
// and the same on every copy.
const CLOCK_SILENCE = 250;               // ms without a tick from ahead before stepping in, per place
const CLOCK_STALL = 100;                 // ms between this copy's own timers that count as a stall
const clockHeard = new Map();            // player id -> when a tick of theirs last came round
let clockBase = null;
let clockSent = 0;
let clockTo = 0;                         // the step the next tick of this copy starts from
let clockLast = 0;                       // when this copy's timer last ran
let tableAt = 0;                         // when this copy last took a table
let movedAt = 0;                         // when this copy's table last moved, or was taken

const placeOf = (id) => {
  const i = room.players.findIndex((p) => p.id === id);
  return i < 0 ? Infinity : i;
};
const onScreen = () => !(typeof document !== 'undefined' && document.visibilityState === 'hidden');

// Whether the host has ticked lately, as this copy heard it — a host out of
// sight, or gone, leaves a stand-in keeping the clock.
function hostQuiet(now) {
  if (!room.host) return true;
  const at = clockHeard.get(room.host.id);
  return at === undefined || now - at > CLOCK_SILENCE * 2;
}

function keepsClock(now) {
  if (solo()) return true;
  if (!world || !onScreen() || !hearsItself(now)) return false;
  const mine = placeOf(myId());
  if (mine === 0) return true;
  let heard = tableAt;
  for (const [id, at] of clockHeard) if (placeOf(id) < mine && at > heard) heard = at;
  return now - heard > CLOCK_SILENCE * mine;
}

setInterval(() => {
  const now = performance.now();
  const stalled = now - clockLast > CLOCK_STALL;
  clockLast = now;

  if (!world && offered && now - offered.at > HANDOVER_GRACE) takeHandover(offered.table);

  // Ticks that keep coming while the table never moves mean a table that
  // stands ahead of the room's clock — one handed over with a step number it
  // never reached — and every tick is ignored as one it has passed. Nothing
  // else would ever end that, so it is a parting like any other.
  if (world && !solo() && now - movedAt > HANDOVER_WAIT) {
    let lastTick = -Infinity;
    for (const at of clockHeard.values()) lastTick = Math.max(lastTick, at);
    if (lastTick > movedAt + HANDOVER_GRACE) parted('ticks come and the table does not move');
  }

  if (!world && !solo() && now - helloAt > HANDOVER_WAIT) {
    // Nobody handed the table over. The host starts one, and so does anybody
    // when no clock has ticked in all that time — then there is no table in
    // play to wait for, only a host that cannot hand one over. Anybody else
    // asks again.
    let lastTick = -Infinity;
    for (const at of clockHeard.values()) lastTick = Math.max(lastTick, at);
    if (isHost(myId()) || now - lastTick > HANDOVER_WAIT) adoptTable(startTable(Math.floor(Math.random() * 4294967296)));
    else askForTable();
  }

  if (world && unheard.length && now - unheard[unheard.length - 1].at > RESEND_AFTER) {
    // Never handed back means nobody got it. A repeat is not a measurement.
    sendHand(false);
  }

  // A clock that stops ticking, or stalled long enough to have been stood in
  // for, starts over from the table as it stands rather than playing back the
  // time it was away.
  if (!keepsClock(now) || stalled) {
    clockBase = null;
    if (!keepsClock(now)) return;
  }
  if (clockBase === null) {
    clockBase = now;
    clockSent = 0;
    // From where this clock already brought the table, not from where the
    // agreed table stands: the ticks it sent before a stall are still on their
    // way, and starting behind them sends ticks the table has already passed —
    // a table standing still for a trip.
    clockTo = Math.max(clockTo, world.n);
  }
  let due = Math.floor((now - clockBase) / STEP_MS) - clockSent;
  if (due < STEPS_PER_TICK) return;
  const most = STEPS_PER_TICK * TICK_BATCH;
  if (due > most) {
    clockSent += due - most;
    due = most;
  }
  clockSent += due;
  clockTo = Math.max(clockTo, world.n) + due;
  // Who leaves the table is decided here, where the clock is, and said in the
  // tick, so every copy lets them go at the same step: gone from the room, or
  // not heard from in a while.
  const here = new Set(room.players.map((p) => p.id));
  const drop = solo() ? [] : playersIn(world).filter((id) => {
    if (id < 0) return false;
    const heard = world.seen[id];
    return !here.has(id) || heard === undefined || world.n - heard > SILENT_STEPS;
  });
  emitRoom({ t: 'tick', to: clockTo, drop, hn: lastPrint, h: lastPrint === null ? null : prints.get(lastPrint) });
}, 8);

setInterval(() => {
  if (world && !unheard.length) sendHand(false);
}, HAND_EVERY);

room.on('hostchange', () => {
  clockBase = null;
});

// The host starts a table; everybody else asks for the one in play. A host
// whose disk was restarted starts a new game this way, and the others find out
// from the next tick that the clock is somewhere they are not, and ask.
if (solo() || isHost(myId())) adoptTable(startTable(Math.floor(Math.random() * 4294967296)));
else askForTable();
start();
// ═══════════════════ end of the kernel ═══════════════════
