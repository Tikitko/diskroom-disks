/**
 * @disk     floe
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Penguins on a rink full of ice blocks. Kick a block and it slides until it hits something, so line one up on a rival to flatten them and spill their fish. Crack fish out of the ice, step out of the line of fire, and feast in the blizzard.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/floe.png
 */
// floe.js — a rink of penguins and ice blocks where the room's order is the
// referee.
//
// Every copy holds every penguin, where it stands, which way it faces and how
// long it stays flattened, every block of ice and where it is sliding, and
// every fish on the ice, and changes it only on what comes back round the
// room, so every copy applies the same hands in the same order and holds the
// same rink. Nobody sends where they are, what they kicked or whom they
// flattened: a hand is which way a penguin waddles and a counter that moves on
// by one for every kick, and everything else is the same arithmetic on the
// same whole numbers on every machine. A page with a console open can play its
// own hand however it likes, at its own top speed, and kick no oftener than
// the cooldown allows, and only a block it stands against.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own penguin does not wait for the trip: it is drawn from the agreed
// table played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — the rink is 1800 units across, a
// speed is units a step — and use nothing but `+ - * /`, comparisons,
// `Math.floor`, `Math.trunc`, `Math.min`, `Math.max`, `Math.abs`, `Math.sqrt`
// and `Math.imul`, whose results the language fixes to the last bit. Every
// product of two coordinates stays far below 2^53, where a double still holds
// a whole number exactly. Trigonometry appears only in the drawing, which is
// nobody's business but the screen's.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (w, n) => Math.floor(draw01(w) * n);

// The whole part of a square root. `Math.sqrt` is rounded correctly by the
// language's own definition, so this is the same number on every machine.
const isqrt = (n) => (n <= 0 ? 0 : Math.floor(Math.sqrt(n)));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

// Whether a circle overlaps a square, by the point of the square nearest it.
function hitsBox(px, py, r, x0, y0, s) {
  const cx = clamp(px, x0, x0 + s), cy = clamp(py, y0, y0 + s);
  return dist2(px, py, cx, cy) < r * r;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the rink a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own penguin a trip ahead, with your hand in it

// The rink, seen from above: a grid of cells, each empty ice or one block. A
// penguin waddles anywhere on the ice and stops against a block; a block moves
// only when it is kicked, and then slides a cell at a time until the next cell
// is a wall or another block.
const CELL = 120;
const COLS = 15, ROWS = 11;
const W = COLS * CELL, H = ROWS * CELL;
const PR = 40;                 // a penguin's radius
const RUN = 15;                // top waddling speed
const RUN_BEHIND = 3;          // more, for whoever trails the leader
const ACC = 3;                 // how fast a speed changes, a step
const NUDGE = 5;               // how far a penguin held against a block is eased toward its lane, a step
const SLIDE = 30;              // units a step a kicked block slides; a cell divides by it
const KICK_REACH = 30;         // how far from a block's face a penguin may stand and still kick it
const KICK_CD = 14;            // steps between two kicks
const KICK_CD_BEHIND = 9;      // the same, for whoever trails the leader
const FLAT = 2 * HZ;           // steps a flattened penguin lies on the ice
const SAFE = 45;               // steps it blinks afterwards, and nothing flattens it
const SQUASH_PTS = 2;          // points for flattening a rival
const LEAD_BONUS = 1;          // more, when the rival was the leader
const SPILL = 2;               // the most fish a flattened penguin spills
const FISH_LIFE = 14 * HZ;     // steps a fish lies on the ice before it is gone
const GRAB_R = PR + 34;        // how close a penguin comes to a fish to grab it
const FALL_STEPS = 45;         // steps a falling block's shadow shows before it lands
const FALL_GAP = 4 * HZ;       // steps between two blocks falling
const FALL_GAP_RUSH = 2 * HZ;  // the same, in the blizzard
const BLOCKS_WANT = 40;        // blocks fall only while the rink holds fewer than this
const MAX_B = COLS * ROWS;
const MAX_I = 40;              // fish on the ice at once
const MAX_FALL = 6;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;
const NOBODY = -9999;

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // right, down, left, up
// Where the seats start, in seat order: opposite corners first.
const START = [[0, 0], [14, 10], [14, 0], [0, 10], [7, 0], [7, 10], [0, 5], [14, 5]];

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 6 * HZ;
const RUSH_AT = 70 * HZ;       // steps into a round when the blizzard comes and every fish counts double

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   bn: the next block's number; b: the blocks, each [number, column, row,
//   kind (0 plain, 1 fish, 2 gold fish), dx, dy, how far into the next cell,
//   kicked by, cells slid]; fa: blocks falling, each [column, row, kind, steps
//   left]; nf: steps until the next one; inum: the next fish's number; it: the
//   fish on the ice, each [number, x, y, gold, age]; res: the last round's
//   [id, points, fish, flattened, rounds won] rows; win: its winner
function freshTable(seed) {
  const t = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, bn: 0, b: [], fa: [], nf: FALL_GAP, inum: 0, it: [], p: {}, res: null, win: -1 };
  layBlocks(t);
  return t;
}

const FIELDS = ['c', 's', 'x', 'y', 'vx', 'vy', 'mx', 'my', 'fc', 'kq', 'kb', 'cd', 'fl', 'inv', 'rp', 'fish', 'sq', 'wn',
  'bw', 'hs', 'hc'];
//   c: colour; s: seat; x, y: where it stands, in units; vx, vy: speed; mx,
//   my: the way the hand waddles, out of 1000; fc: the way it faces, an index
//   into DIRS; kq: the kick counter as last heard; kb: a kick to take this
//   step; cd: steps until it kicks again; fl: steps it lies flattened; inv:
//   steps it is safe for after; rp: points this round; fish: fish grabbed; sq:
//   rivals flattened; wn: rounds won; bw: the bot's pause; hs, hc: hands this
//   step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

function newPlayer(w, kq) {
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), x: CELL / 2, y: CELL / 2, vx: 0, vy: 0, mx: 0, my: 0, fc: 1, kq, kb: 0,
    cd: 0, fl: 0, inv: SAFE, rp: 0, fish: 0, sq: 0, wn: 0, bw: 0, hs: w.n, hc: 0,
  });
}

const cellOf = (v, n) => clamp(Math.floor(v / CELL), 0, n - 1);
const inRink = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const moving = (q) => q[4] !== 0 || q[5] !== 0;
const boxX = (q) => q[1] * CELL + q[4] * q[6];
const boxY = (q) => q[2] * CELL + q[5] * q[6];

// Whether a cell is taken for a block moving into it: a wall, a block standing
// there, or a block sliding into it or out of it.
function occupied(w, x, y, self) {
  if (!inRink(x, y)) return true;
  for (const q of w.b) {
    if (q === self) continue;
    if (q[1] === x && q[2] === y) return true;
    if (moving(q) && q[1] + q[4] === x && q[2] + q[5] === y) return true;
  }
  return false;
}
const stillAt = (w, x, y) => w.b.find((q) => q[1] === x && q[2] === y && !moving(q)) || null;

function addBlock(w, x, y, kind) {
  if (w.b.length >= MAX_B) return;
  w.bn = (w.bn + 1) % 100000;
  w.b.push([w.bn, x, y, kind, 0, 0, 0, NOBODY, 0]);
}

// What a new block holds: mostly ice, now and then a fish frozen in it, and
// rarely a gold one.
function kindRoll(w, fish, gold) {
  const r = draw01(w);
  return r < gold ? 2 : r < gold + fish ? 1 : 0;
}

// A new rink: blocks scattered over it, thicker on the cells where a column
// and a row both run odd so lanes open between them, and none near where the
// seats start.
function layBlocks(w) {
  w.b = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (START.some(([sx, sy]) => Math.abs(sx - x) <= 1 && Math.abs(sy - y) <= 1)) continue;
      const p = x % 2 === 1 && y % 2 === 1 ? 0.72 : 0.3;
      if (draw01(w) < p) addBlock(w, x, y, kindRoll(w, 0.22, 0.05));
    }
  }
}

// A penguin put down at the centre of a cell, still, and safe a moment.
function placeAt(d, x, y) {
  d.x = x * CELL + CELL / 2;
  d.y = y * CELL + CELL / 2;
  d.vx = d.vy = d.kb = d.fl = 0;
  d.inv = SAFE;
}

// The open cell furthest from every other penguin: where a newcomer starts.
function farCell(w, id) {
  let best = null, score = -1;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (occupied(w, x, y, null) || w.fa.some((f) => f[0] === x && f[1] === y)) continue;
      const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
      let near = BIG;
      for (const o of playersIn(w)) if (o !== id) near = Math.min(near, dist2(w.p[o].x, w.p[o].y, px, py));
      if (near > score) { score = near; best = [x, y]; }
    }
  }
  return best || START[0];
}

// The one leader, as every copy works it out: the most points this round, when
// somebody has some and nobody matches them.
function leaderOf(w) {
  let top = 0, who = NOBODY, tie = false;
  for (const id of playersIn(w)) {
    const r = w.p[id].rp;
    if (r > top) { top = r; who = id; tie = false; } else if (r === top && r > 0) tie = true;
  }
  return tie ? NOBODY : who;
}
const trails = (w, id) => w.ph === PLAY && playersIn(w).some((o) => w.p[o].rp > w.p[id].rp);
const rush = (w) => w.ph === PLAY && PLAY_STEPS - w.pt >= RUSH_AT;

// A waddle off the wire is brought inside the circle of the stick, so no hand
// goes faster on a diagonal than straight ahead. The length it is divided by
// is rounded up, so what comes out is inside the circle and never on its rim.
function steer(d, mx, my) {
  const m2 = mx * mx + my * my;
  if (m2 > 1000000) {
    const m = isqrt(m2) + 1;
    mx = Math.trunc((mx * 1000) / m);
    my = Math.trunc((my * 1000) / m);
  }
  d.mx = mx;
  d.my = my;
}

// A hand, at its place in the room's order: [the way waddled, x and y out of
// 1000; the kick counter]. A kick is asked for once, when its counter changes;
// the same hand said again to keep a player at the table asks for nothing.
// Being heard is how a player arrives: on the open cell furthest from
// everybody.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[2]);
    const [x, y] = farCell(w, id);
    placeAt(d, x, y);
    steer(d, input[0], input[1]);
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  steer(d, input[0], input[1]);
  if (input[2] !== d.kq) { d.kq = input[2]; d.kb = 1; }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [x, y, k] = raw;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(k)) return null;
  if (x < -1000 || x > 1000 || y < -1000 || y > 1000 || k < 0 || k > 999) return null;
  return [x, y, k];
}

// Somebody gone: their penguin goes, and a block they kicked slides on
// without anybody to credit.
function leave(w, id) {
  delete w.p[id];
  for (const q of w.b) if (q[7] === id) q[7] = NOBODY;
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.05;         // how often it stops a moment rather than decide
const BOT_SHOT = 0.35;         // how often it takes a shot it has lined up
const BOT_DODGE = 0.5;         // how often it sees a block coming in time to step aside
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    const d = (w.p[BOT_ID] = newPlayer(w, 0));
    const [x, y] = farCell(w, BOT_ID);
    placeAt(d, x, y);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Whether a rival stands in the open line that runs from cell (x, y) on the
// way (dx, dy), up to the first block or wall.
function rivalInLine(w, x, y, dx, dy, self) {
  for (let k = 0; k < COLS; k++) {
    x += dx;
    y += dy;
    if (occupied(w, x, y, null)) return false;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o === self || e.fl > 0 || e.inv > 0) continue;
      if (cellOf(e.x, COLS) === x && cellOf(e.y, ROWS) === y) return true;
    }
  }
  return false;
}

// The ways out of every cell the bot can reach, nearest first: a walk across
// the open ice, round the blocks, from the cell it stands in.
function reachFrom(w, sx, sy) {
  const n = COLS * ROWS, far = new Array(n).fill(-1), from = new Array(n).fill(-1);
  const solid = new Array(n).fill(false);
  for (const q of w.b) if (!moving(q)) solid[q[2] * COLS + q[1]] = true;
  const queue = [sy * COLS + sx];
  far[queue[0]] = 0;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i], cx = c % COLS, cy = (c - cx) / COLS;
    for (const [dx, dy] of DIRS) {
      const x = cx + dx, y = cy + dy, k = y * COLS + x;
      if (!inRink(x, y) || solid[k] || far[k] >= 0) continue;
      far[k] = far[c] + 1;
      from[k] = c;
      queue.push(k);
    }
  }
  return { far, from };
}

function botGo(d, tx, ty) {
  const dx = tx - d.x, dy = ty - d.y, m = isqrt(dx * dx + dy * dy);
  if (m < 6) { d.mx = d.my = 0; return; }
  steer(d, Math.trunc((dx * 1000) / m), Math.trunc((dy * 1000) / m));
}

// It steps out of the way of a block sliding at it, when it sees it in time;
// kicks a block a rival stands in line with; and otherwise goes for the
// nearest fish on the ice, or for the nearest fish frozen in a block, to kick
// it out. Now and then it stops to think.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.fl > 0) { d.mx = d.my = 0; return; }
  if (d.bw > 0) { d.bw -= 1; d.mx = d.my = 0; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 6 + pick(w, 14); d.mx = d.my = 0; return; }
  const cx = cellOf(d.x, COLS), cy = cellOf(d.y, ROWS);
  const { far, from } = reachFrom(w, cx, cy);
  // A block sliding at it down its own row or column.
  for (const q of w.b) {
    if (!moving(q) || q[7] === BOT_ID) continue;
    const toward = (q[4] !== 0 && q[2] === cy && (cx - q[1]) * q[4] > 0 && (cx - q[1]) * q[4] < 5) ||
      (q[5] !== 0 && q[1] === cx && (cy - q[2]) * q[5] > 0 && (cy - q[2]) * q[5] < 5);
    if (!toward || draw01(w) >= BOT_DODGE) continue;
    for (const [dx, dy] of q[4] !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]) {
      const x = cx + dx, y = cy + dy;
      if (inRink(x, y) && far[y * COLS + x] === 1) { botGo(d, x * CELL + CELL / 2, y * CELL + CELL / 2); return; }
    }
  }
  // A shot lined up: a block beside it with open ice and a rival beyond.
  for (let f = 0; f < 4; f++) {
    const [dx, dy] = DIRS[f];
    const q = stillAt(w, cx + dx, cy + dy);
    if (!q || occupied(w, cx + 2 * dx, cy + 2 * dy, q) || !rivalInLine(w, cx + dx, cy + dy, dx, dy, BOT_ID)) continue;
    botGo(d, (cx + dx) * CELL + CELL / 2, (cy + dy) * CELL + CELL / 2);
    if (d.fc === f && d.cd === 0 && draw01(w) < BOT_SHOT) d.kb = 1;
    return;
  }
  // The nearest fish it can walk to, or the nearest cell beside a fish block.
  let goal = -1, cost = BIG, face = -1;
  for (const it of w.it) {
    const k = cellOf(it[2], ROWS) * COLS + cellOf(it[1], COLS);
    if (far[k] >= 0 && far[k] < cost) { cost = far[k]; goal = k; face = -1; }
  }
  for (const q of w.b) {
    if (q[3] === 0 || moving(q)) continue;
    for (let f = 0; f < 4; f++) {
      const x = q[1] - DIRS[f][0], y = q[2] - DIRS[f][1], k = y * COLS + x;
      if (!inRink(x, y) || far[k] < 0) continue;
      const c = far[k] * 2 + 3 + (q[3] === 2 ? -2 : 0);
      if (c < cost) { cost = c; goal = k; face = f; }
    }
  }
  if (goal < 0) {
    // Nothing to go for: anywhere open.
    const [dx, dy] = DIRS[pick(w, 4)];
    if (!occupied(w, cx + dx, cy + dy, null)) botGo(d, (cx + dx) * CELL + CELL / 2, (cy + dy) * CELL + CELL / 2);
    return;
  }
  if (far[goal] === 0) {
    if (face < 0) {
      const it = w.it.find((q) => cellOf(q[2], ROWS) === cy && cellOf(q[1], COLS) === cx);
      if (it) botGo(d, it[1], it[2]);
      return;
    }
    // Beside the block: lean into it, and kick once it faces it.
    const [dx, dy] = DIRS[face];
    botGo(d, (cx + dx) * CELL + CELL / 2, (cy + dy) * CELL + CELL / 2);
    if (d.fc === face && d.cd === 0) d.kb = 1;
    return;
  }
  let k = goal;
  while (from[k] >= 0 && far[from[k]] > 0) k = from[k];
  const x = k % COLS, y = (k - x) / COLS;
  botGo(d, x * CELL + CELL / 2, y * CELL + CELL / 2);
}

// ── a step ─────────────────────────────────────────────────────────────────
// The seats close up in order, each on its own starting cell.
function lineUp(w) {
  bySeat(w).forEach((id, i) => {
    const [x, y] = START[i % START.length];
    const d = w.p[id];
    placeAt(d, x, y);
    d.fc = y === 0 ? 1 : y === ROWS - 1 ? 3 : x === 0 ? 0 : 2;
  });
}

function clearRink(w) {
  layBlocks(w);
  w.fa = [];
  w.it = [];
  w.nf = FALL_GAP;
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  clearRink(w);
  for (const id of playersIn(w)) { const d = w.p[id]; d.rp = d.fish = d.sq = d.cd = 0; }
  lineUp(w);
}

// A round: a fresh rink, the seats closed up in order, everybody on a corner
// or an edge of their own.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  clearRink(w);
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  for (const id of ids) { const d = w.p[id]; d.rp = d.fish = d.sq = d.cd = 0; }
  lineUp(w);
  fx(w, 'round', 0, 0, 0);
}

// The whistle: the round to whoever has the most points, the more rivals
// flattened between two who match, and nobody if that matches too.
function finish(w) {
  const ids = bySeat(w);
  const rank = (a, b) => w.p[b].rp - w.p[a].rp || w.p[b].sq - w.p[a].sq;
  const order = ids.slice().sort((a, b) => rank(a, b) || a - b);
  const top = order[0];
  w.win = ids.length > 1 && (order.length < 2 || rank(top, order[1]) !== 0) ? top : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  w.res = order.map((id) => [id, w.p[id].rp, w.p[id].fish, w.p[id].sq, w.p[id].wn]);
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, 0, w.win);
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
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go', 0, 0, 0); }
    } else if (w.ph === PLAY) {
      if (PLAY_STEPS - w.pt === RUSH_AT) fx(w, 'rush', 0, 0, 0);
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      d.kb = 0;
      d.vx = d.vy = 0;
    }
    return;
  }
  skate(w);
}

function skate(w) {
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.fl > 0) { if (--d.fl === 0) { d.inv = SAFE; fx(w, 'up', d.x, d.y, 0, id); } } else if (d.inv > 0) d.inv -= 1;
    waddle(w, d, id);
    if (d.cd > 0) d.cd -= 1;
  }
  for (const id of ids) {
    const d = w.p[id];
    if (d.kb) kick(w, d, id);
    d.kb = 0;
  }
  slide(w, ids);
  falls(w, ids);
  grab(w, ids);
}

const toward = (v, target) => (v < target ? Math.min(target, v + ACC) : Math.max(target, v - ACC));

// One axis of a waddle: the penguin goes as far as the ice lets it and stops
// flush against the first block in its way. A block it already overlaps — one
// that came to rest on it while it lay flattened — does not hold it, so it
// can always walk out. Returns whether a block stopped it.
function walkAxis(d, still, ax, v) {
  if (!v) return false;
  const nx = ax === 0 ? clamp(d.x + v, PR, W - PR) : d.x;
  const ny = ax === 1 ? clamp(d.y + v, PR, H - PR) : d.y;
  let to = ax === 0 ? nx : ny, hit = false;
  for (const q of still) {
    const x0 = q[1] * CELL, y0 = q[2] * CELL;
    if (!hitsBox(nx, ny, PR, x0, y0, CELL) || hitsBox(d.x, d.y, PR, x0, y0, CELL)) continue;
    hit = true;
    const edge = ax === 0 ? (v > 0 ? x0 - PR : x0 + CELL + PR) : (v > 0 ? y0 - PR : y0 + CELL + PR);
    to = v > 0 ? Math.min(to, edge) : Math.max(to, edge);
  }
  const was = ax === 0 ? d.x : d.y;
  const wall = (ax === 0 ? nx : ny) !== was + v;
  to = v > 0 ? Math.max(was, to) : Math.min(was, to);
  if (ax === 0) d.x = to; else d.y = to;
  return hit || wall;
}

// The hand's way becomes a speed, closed a little every step, and the way it
// points most becomes the way the penguin faces. A penguin held against a
// block with no word on the other axis is eased toward the middle of its lane,
// so it slips round a corner rather than catching on it.
function waddle(w, d, id) {
  if (d.fl > 0) { d.vx = d.vy = 0; return; }
  const v = RUN + (trails(w, id) ? RUN_BEHIND : 0);
  d.vx = toward(d.vx, Math.trunc((d.mx * v) / 1000));
  d.vy = toward(d.vy, Math.trunc((d.my * v) / 1000));
  if (Math.abs(d.mx) > 300 || Math.abs(d.my) > 300) {
    d.fc = Math.abs(d.mx) >= Math.abs(d.my) ? (d.mx > 0 ? 0 : 2) : (d.my > 0 ? 1 : 3);
  }
  const still = w.b.filter((q) => !moving(q));
  if (walkAxis(d, still, 0, d.vx) && Math.abs(d.my) < 400) {
    const mid = cellOf(d.y, ROWS) * CELL + CELL / 2;
    d.y = clamp(d.y + clamp(mid - d.y, -NUDGE, NUDGE), PR, H - PR);
    d.vx = 0;
  }
  if (walkAxis(d, still, 1, d.vy) && Math.abs(d.mx) < 400) {
    const mid = cellOf(d.x, COLS) * CELL + CELL / 2;
    d.x = clamp(d.x + clamp(mid - d.x, -NUDGE, NUDGE), PR, W - PR);
    d.vy = 0;
  }
}

// A kick: the block standing in the next cell the penguin faces, if it stands
// close enough to its face. With open ice beyond, it slides; with a wall or a
// block beyond, it shatters where it stands. A kick at nothing costs nothing.
function kick(w, d, id) {
  if (d.cd > 0 || d.fl > 0) return;
  const [dx, dy] = DIRS[d.fc];
  const tx = cellOf(d.x, COLS) + dx, ty = cellOf(d.y, ROWS) + dy;
  const q = inRink(tx, ty) ? stillAt(w, tx, ty) : null;
  const gap = !q ? BIG : dx > 0 ? tx * CELL - d.x : dx < 0 ? d.x - (tx + 1) * CELL : dy > 0 ? ty * CELL - d.y : d.y - (ty + 1) * CELL;
  if (gap > PR + KICK_REACH) { fx(w, 'miss', d.x, d.y, 0, id); return; }
  d.cd = trails(w, id) ? KICK_CD_BEHIND : KICK_CD;
  if (occupied(w, tx + dx, ty + dy, q)) { shatter(w, q, id); return; }
  q[4] = dx;
  q[5] = dy;
  q[6] = 0;
  q[7] = id;
  q[8] = 0;
  fx(w, 'kick', tx * CELL + CELL / 2, ty * CELL + CELL / 2, d.fc, id);
}

// A block gone to pieces where it stands, and whatever it held left on the
// ice in its place.
function shatter(w, q, by) {
  const i = w.b.indexOf(q);
  if (i < 0) return;
  w.b.splice(i, 1);
  const x = q[1] * CELL + CELL / 2, y = q[2] * CELL + CELL / 2;
  fx(w, 'shatter', x, y, q[3], by);
  if (q[3] > 0) addFish(w, x, y, q[3] === 2 ? 1 : 0);
}

function addFish(w, x, y, gold) {
  if (w.it.length >= MAX_I) return;
  w.inum = (w.inum + 1) % 100000;
  w.it.push([w.inum, clamp(x, PR, W - PR), clamp(y, PR, H - PR), gold, 0]);
}

// Every sliding block moves on; one that has come into a cell with no room
// beyond stops there, and one holding a fish cracks open where it stops. Then
// whoever a sliding block runs over is flattened, to the credit of whoever
// kicked it.
function slide(w, ids) {
  for (const q of w.b.slice()) {
    if (!moving(q)) continue;
    q[6] += SLIDE;
    if (q[6] < CELL) continue;
    q[1] += q[4];
    q[2] += q[5];
    q[6] = 0;
    q[8] = Math.min(99, q[8] + 1);
    if (!occupied(w, q[1] + q[4], q[2] + q[5], q)) continue;
    q[4] = q[5] = 0;
    const x = q[1] * CELL + CELL / 2, y = q[2] * CELL + CELL / 2;
    if (q[3] > 0) {
      w.b.splice(w.b.indexOf(q), 1);
      fx(w, 'crack', x, y, q[3], q[7]);
      addFish(w, x, y, q[3] === 2 ? 1 : 0);
    } else fx(w, 'thud', x, y, q[8], q[7]);
    q[7] = NOBODY;
  }
  for (const q of w.b) {
    if (!moving(q)) continue;
    for (const id of ids) {
      const d = w.p[id];
      if (d && d.fl === 0 && d.inv === 0 && hitsBox(d.x, d.y, PR - 8, boxX(q), boxY(q), CELL)) squash(w, id, q[7]);
    }
  }
}

// Flattened: it lies on the ice a moment and spills up to SPILL of its points
// as fish for anybody to grab. Whoever kicked the block scores, and more for
// flattening the leader; a block from the sky credits nobody.
function squash(w, id, by) {
  const d = w.p[id];
  const lead = leaderOf(w) === id;
  d.fl = FLAT;
  d.vx = d.vy = d.kb = 0;
  const spill = Math.min(d.rp, SPILL);
  d.rp -= spill;
  for (let i = 0; i < spill; i++) {
    const a = DIRS[(d.fc + 1 + 2 * i) % 4];
    addFish(w, d.x + a[0] * 70, d.y + a[1] * 70, 0);
  }
  const k = by !== id ? w.p[by] : null;
  let v = 0;
  if (k) {
    v = SQUASH_PTS + (lead ? LEAD_BONUS : 0);
    k.rp += v;
    k.sq += 1;
  }
  fx(w, 'squash', d.x, d.y, v, id, k ? by : NOBODY);
}

// Now and then a block falls out of the sky onto open ice: its shadow shows
// first, and whoever is still under it when it lands is flattened. A cell
// filled in the meantime takes it as a shower of ice instead.
function falls(w, ids) {
  for (const f of w.fa.slice()) {
    if (--f[3] > 0) continue;
    w.fa.splice(w.fa.indexOf(f), 1);
    const x = f[0] * CELL + CELL / 2, y = f[1] * CELL + CELL / 2;
    if (occupied(w, f[0], f[1], null)) { fx(w, 'shatter', x, y, 0, NOBODY); continue; }
    addBlock(w, f[0], f[1], f[2]);
    fx(w, 'land', x, y, f[2]);
    for (const id of ids) {
      const d = w.p[id];
      if (d && d.fl === 0 && d.inv === 0 && hitsBox(d.x, d.y, PR - 8, f[0] * CELL, f[1] * CELL, CELL)) squash(w, id, NOBODY);
    }
  }
  if (w.nf > 0) w.nf -= 1;
  if (w.nf > 0) return;
  w.nf = rush(w) ? FALL_GAP_RUSH : FALL_GAP;
  if (w.b.length + w.fa.length >= BLOCKS_WANT + (rush(w) ? 8 : 0) || w.fa.length >= MAX_FALL) return;
  for (let tries = 0; tries < 20; tries++) {
    const x = pick(w, COLS), y = pick(w, ROWS);
    if (occupied(w, x, y, null) || w.fa.some((f) => f[0] === x && f[1] === y)) continue;
    w.fa.push([x, y, kindRoll(w, 0.35, 0.07), FALL_STEPS]);
    return;
  }
}

// A penguin on its feet that comes close to a fish grabs it: the nearest one
// to it first, the first in seat order between two as near. A point, three for
// a gold one, twice that in the blizzard. A fish left long enough is gone.
function grab(w, ids) {
  const gone = new Set();
  for (const it of w.it) {
    it[4] += 1;
    if (it[4] > FISH_LIFE) { gone.add(it[0]); continue; }
    let who = null, best = GRAB_R * GRAB_R;
    for (const id of ids) {
      const d = w.p[id];
      if (d.fl > 0) continue;
      const e = dist2(d.x, d.y, it[1], it[2]);
      if (e < best) { best = e; who = id; }
    }
    if (who === null) continue;
    const v = (it[3] ? 3 : 1) * (rush(w) ? 2 : 1);
    const d = w.p[who];
    d.rp += v;
    d.fish += 1;
    gone.add(it[0]);
    fx(w, 'grab', it[1], it[2], v, who, it[3]);
  }
  if (gone.size) w.it = w.it.filter((it) => !gone.has(it[0]));
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.bn, 0, 99999) || !int(raw.inum, 0, 99999) || !int(raw.nf, 0, FALL_GAP)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  const top = RUN + RUN_BEHIND;
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.x, PR, W - PR) || !int(d.y, PR, H - PR) || !int(d.vx, -top, top) || !int(d.vy, -top, top)) return null;
    if (!int(d.mx, -1000, 1000) || !int(d.my, -1000, 1000) || d.mx * d.mx + d.my * d.my > 1000000) return null;
    if (!int(d.fc, 0, 3) || !int(d.kq, 0, 999) || !int(d.kb, 0, 1) || !int(d.cd, 0, KICK_CD)) return null;
    if (!int(d.fl, 0, FLAT) || !int(d.inv, 0, SAFE)) return null;
    if (!int(d.rp, 0, 99999) || !int(d.fish, 0, 99999) || !int(d.sq, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bw, 0, 99) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  if (!Array.isArray(raw.b) || raw.b.length > MAX_B) return null;
  const b = [];
  const nums = new Set(), cells = new Set();
  for (const q of raw.b) {
    if (!Array.isArray(q) || q.length !== 9) return null;
    const [n, x, y, kind, dx, dy, off, by, slid] = q;
    if (!int(n, 0, 99999) || nums.has(n) || !int(x, 0, COLS - 1) || !int(y, 0, ROWS - 1) || !int(kind, 0, 2)) return null;
    if (!int(dx, -1, 1) || !int(dy, -1, 1) || Math.abs(dx) + Math.abs(dy) > 1) return null;
    if (!int(off, 0, CELL - SLIDE) || off % SLIDE !== 0 || (dx === 0 && dy === 0 && off !== 0)) return null;
    if (!int(by, -BIG, BIG) || !int(slid, 0, 99)) return null;
    if (cells.has(y * COLS + x)) return null;
    if ((dx !== 0 || dy !== 0) && !inRink(x + dx, y + dy)) return null;
    nums.add(n);
    cells.add(y * COLS + x);
    b.push([n, x, y, kind, dx, dy, off, by, slid]);
  }
  if (!Array.isArray(raw.fa) || raw.fa.length > MAX_FALL) return null;
  const fa = [];
  for (const f of raw.fa) {
    if (!Array.isArray(f) || f.length !== 4) return null;
    if (!int(f[0], 0, COLS - 1) || !int(f[1], 0, ROWS - 1) || !int(f[2], 0, 2) || !int(f[3], 1, FALL_STEPS)) return null;
    fa.push(f.slice());
  }
  if (!Array.isArray(raw.it) || raw.it.length > MAX_I) return null;
  const it = [];
  const inums = new Set();
  for (const q of raw.it) {
    if (!Array.isArray(q) || q.length !== 5) return null;
    const [n, x, y, gold, age] = q;
    if (!int(n, 0, 99999) || inums.has(n) || !int(x, PR, W - PR) || !int(y, PR, H - PR) || !int(gold, 0, 1) || !int(age, 0, FISH_LIFE)) return null;
    inums.add(n);
    it.push(q.slice());
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 5 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, bn: raw.bn, b, fa, nf: raw.nf, inum: raw.inum, it, p, res, win: raw.win };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, z, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, z, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a rink under the polar night. Pale blue ice with a sheen and
// a snowbank round it, glassy blocks with a fish frozen in some and gold in a
// few, the aurora over the dark, and every penguin a bright colour of its
// own with a white front.
const INK = {
  page: '#0a1426', glow: '#13284a', text: '#ffffff', muted: '#d3e4f5', dim: '#8ea6c4', gold: '#ffd166',
  iceTop: '#e4f4fd', iceBot: '#b9dcf1', line: 'rgba(120,170,210,0.22)', bank: '#f5fbff', bankShade: '#9fc0db',
  blockTop: '#bfe9ff', blockSide: '#6fb6e0', blockEdge: '#e9f8ff', fish: '#ff8c5a', fishGold: '#ffd23f',
  panel: 'rgba(10,20,38,0.93)', ink: 'rgba(10,22,44,0.85)',
};
const SEAT = ['#ff4f7b', '#2f8cff', '#ffa31a', '#3ccf4e', '#b44dff', '#00c2d6', '#ff6a2b', '#7d6bff'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #3f5f8a;' +
  `background:#162a4a;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
const SIDE = 160;              // the least a column beside the rink needs for the scoreboard
let VW = 640, VH = 400, sc = 0.2, ox = 0, oy = 58, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340;
let wide = false, colW = 0;
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

// The whole rink is always on screen, as large as the frame lets it be. A
// frame wider than the rink puts the status, the scoreboard, your kick and the
// line of controls in the columns either side of it, so the rink takes the
// whole height. A narrower one stacks them in strips above and below it, with
// NOTE_ROOM under it for the practice note and, in a round, for your kick —
// the bottom row is a row of seats, so nothing covers it. Whichever of the two
// draws the rink bigger is the one used. The snowbank round the rink is part
// of what is fitted, so it is never cropped either.
const BANK = 34;               // the snowbank's width, in units
function fit() {
  const fw = W + 2 * BANK, fh = H + 2 * BANK;
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  const tall = Math.min((VW - 8) / fw, ah / fh), side = Math.min((VH - 12) / fh, (VW - 2 * SIDE) / fw);
  wide = side > tall;
  sc = Math.max(0.02, wide ? side : tall);
  ox = (VW - sc * W) / 2;
  oy = wide ? (VH - sc * H) / 2 : TOP + (ah - sc * H) / 2;
  colW = wide ? ox - BANK * sc : 0;
  fieldTop = oy - BANK * sc;
  fieldBot = oy + sc * (H + BANK);
}

// Words broken into lines no wider than `most`, at the dots between phrases
// first and at spaces only when a phrase alone is too long.
function wrap(s, px, most) {
  ctx.font = font(px);
  const out = [];
  let line = '';
  const put = (piece, sep) => {
    const next = line ? line + sep + piece : piece;
    if (!line || ctx.measureText(next).width <= most) { line = next; return; }
    out.push(line);
    line = piece;
  };
  for (const phrase of s.split(' · ')) {
    if (ctx.measureText(phrase).width <= most) { put(phrase, ' · '); continue; }
    phrase.split(' ').forEach((word, i) => put(word, i ? ' ' : ' · '));
  }
  if (line) out.push(line);
  return out;
}

const SX = (x) => ox + x * sc + shakeX;
const SY = (y) => oy + y * sc + shakeY;
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
  r = Math.max(0, Math.min(r, w / 2, h / 2));
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
function alpha(hex, a) {
  const c = rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function mix(a, b, k) {
  const p = rgb(a), q = rgb(b);
  return `rgb(${Math.round(p[0] + (q[0] - p[0]) * k)},${Math.round(p[1] + (q[1] - p[1]) * k)},${Math.round(p[2] + (q[2] - p[2]) * k)})`;
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
  kick(mine) { if (ready('kick', 60)) { tone(mine ? 150 : 120, 0.09, 'square', mine ? 0.09 : 0.04, 0.5); puff(0.35, mine ? 0.06 : 0.025, 2400, 0.02, 0.8); } },
  thud(near) { if (ready('thud', 60)) { tone(90, 0.14, 'sine', 0.05 + 0.1 * near, 0.6); puff(0.06, 0.03 + 0.05 * near, 700, 0, 1); } },
  shatter(near) {
    if (!ready('shatter', 60)) return;
    puff(0.22, 0.05 + 0.1 * near, 5200, 0, 1.5);
    [2093, 2637, 3136].forEach((f, i) => tone(f, 0.08, 'triangle', 0.015 + 0.03 * near, 0.9, i * 0.03));
  },
  crack(near, gold) { if (ready('crack', 60)) { puff(0.12, 0.05 + 0.08 * near, 4200, 0, 2); tone(gold ? 1568 : 1175, 0.18, 'triangle', 0.03 + 0.05 * near, 1.2, 0.04); } },
  squash(mine, me) {
    if (!ready('squash', 80)) return;
    tone(mine ? 220 : 180, 0.35, 'sawtooth', mine ? 0.08 : 0.04, 0.3);
    puff(0.12, mine ? 0.1 : 0.05, 600, 0, 1);
    if (me) [523, 659, 784].forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, 0.08 + i * 0.05));
  },
  grab(mine, gold) {
    if (!ready('grab', 50)) return;
    if (mine) (gold ? [784, 988, 1319] : [659, 988]).forEach((f, i) => tone(f, 0.09, 'triangle', 0.08, 0, i * 0.05));
    else tone(520, 0.06, 'sine', 0.025, 1.2);
  },
  land(near) { if (ready('land', 80)) { tone(70, 0.22, 'sine', 0.05 + 0.12 * near, 0.5); puff(0.18, 0.03 + 0.06 * near, 900, 0, 0.8); } },
  miss() { if (ready('miss', 120)) tone(260, 0.05, 'sine', 0.03, 0.8); },
  up() { if (ready('up', 150)) tone(440, 0.14, 'triangle', 0.05, 1.8); },
  rush() { if (ready('rush', 400)) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'square', 0.04, 1, i * 0.09)); },
  beep(hi) { if (ready('beep', 200)) tone(hi ? 880 : 620, 0.12, 'sine', 0.12); },
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

// ── bits: particles, pops, rings, shake ────────────────────────────────────
// Stepped on a clock of their own at a fixed rate, never once per frame, so a
// fast screen and a slow one see the same spray. Positions are rink units.
const bits = [];      // { x, y, vx, vy, g, life, max, size, colour, sq }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
const flakes = [];    // the blizzard's snow, in screen fractions
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, g, sq) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: g || 0, life: 0, max: 18 + Math.random() * 22, size, colour, sq: !!sq });
  }
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 15 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let j = 0; j < n; j++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.92; b.vy *= 0.92;
      b.vy += b.g / BIT_HZ;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    for (const f of flakes) {
      f.x += f.vx / BIT_HZ; f.y += f.vy / BIT_HZ;
      if (f.y > 1.05) { f.y = -0.05; f.x = Math.random(); }
      if (f.x > 1.05) f.x = -0.05;
    }
    shake *= 0.85;
    if (shake < 0.2) shake = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}
for (let i = 0; i < 90; i++) {
  flakes.push({ x: Math.random(), y: Math.random(), vx: 0.12 + Math.random() * 0.1, vy: 0.18 + Math.random() * 0.2, r: 1 + Math.random() * 2.2 });
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();      // id -> { ang, gait, seen, kick }
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const lookOf = (id, now) => {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { gait: 0, seen: now, kick: 0 }));
  l.seen = now;
  return l;
};

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = md ? Math.max(0, 1 - (Math.abs(md.x - e.x) + Math.abs(md.y - e.y)) / 1500) : 0.3;
  if (e.kind === 'kick') {
    const [dx, dy] = DIRS[e.z];
    spray(e.x - dx * 60, e.y - dy * 60, 10, '#ffffff', 380, 7, 0);
    const l = looks.get(e.a);
    if (l) l.kick = 1;
    if (e.a === me) { pop(e.x - dx * 60, e.y - dy * 60 - 40, 'kick!', colourOf(t, e.a), 14); shake = Math.max(shake, 3); }
    sound.kick(e.a === me);
  } else if (e.kind === 'thud') {
    spray(e.x, e.y, 6, '#ffffff', 260, 6, 0);
    ring(e.x, e.y, '#ffffff', 90);
    if (near > 0.4) sound.thud(near);
  } else if (e.kind === 'shatter') {
    spray(e.x, e.y, 22, INK.blockTop, 620, 10, 300, true);
    spray(e.x, e.y, 10, '#ffffff', 500, 6, 0, true);
    pop(e.x, e.y - 30, 'smash!', '#ffffff', e.a === me ? 15 : 13);
    if (e.a === me || near > 0.6) shake = Math.max(shake, 4);
    sound.shatter(e.a === me ? 1 : near);
  } else if (e.kind === 'crack') {
    const c = e.z === 2 ? INK.fishGold : INK.fish;
    spray(e.x, e.y, 18, INK.blockTop, 560, 9, 300, true);
    spray(e.x, e.y, 8, c, 420, 7, 0);
    ring(e.x, e.y, c, 130);
    pop(e.x, e.y - 30, 'crack!', c, 14);
    sound.crack(e.a === me ? 1 : near, e.z === 2);
  } else if (e.kind === 'squash') {
    const c = colourOf(t, e.a);
    spray(e.x, e.y, 22, '#ffffff', 600, 8, 0);
    spray(e.x, e.y, 12, c, 520, 9, 0);
    ring(e.x, e.y, c, 170);
    pop(e.x, e.y - 50, 'splat!', '#ffffff', e.a === me || e.b === me ? 18 : 14);
    if (e.z > 0) pop(e.x, e.y - 10, '+' + e.z, colourOf(t, e.b), e.b === me ? 20 : 15);
    if (e.a === me) shake = Math.max(shake, 12);
    else if (e.b === me) shake = Math.max(shake, 5);
    sound.squash(e.a === me || e.b === me || near > 0.5, e.b === me);
  } else if (e.kind === 'grab') {
    const c = colourOf(t, e.a);
    spray(e.x, e.y, 12, e.b ? INK.fishGold : INK.fish, 420, 7, 0);
    ring(e.x, e.y, c, 100);
    pop(e.x, e.y - 30, '+' + e.z, e.b ? INK.gold : c, e.a === me ? 20 : 14);
    sound.grab(e.a === me, e.b === 1);
  } else if (e.kind === 'land') {
    spray(e.x, e.y, 18, '#ffffff', 520, 8, 0);
    ring(e.x, e.y, '#ffffff', 150);
    shake = Math.max(shake, 2 + 5 * near);
    sound.land(near);
  } else if (e.kind === 'miss') {
    if (e.a === me) sound.miss();
  } else if (e.kind === 'up') {
    ring(e.x, e.y, colourOf(t, e.a), 90);
    if (e.a === me) sound.up();
  } else if (e.kind === 'rush') {
    pop(W / 2, H / 2, 'blizzard · fish count double!', INK.gold, 22);
    shake = Math.max(shake, 5);
    sound.rush();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

// The night over the rink: a dark sky with the aurora drifting across it and
// a few stars, and in the blizzard snow blowing over the whole frame.
function drawBack(t, now) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    const base = VH * (0.18 + k * 0.2);
    ctx.moveTo(0, base);
    for (let x = 0; x <= VW; x += 24) ctx.lineTo(x, base + Math.sin(x / (130 + k * 40) + now / (2600 + k * 900) + k * 2) * VH * 0.06);
    ctx.lineTo(VW, base + VH * 0.12);
    ctx.lineTo(0, base + VH * 0.12);
    ctx.closePath();
    ctx.fillStyle = k === 1 ? 'rgba(170,110,255,0.07)' : 'rgba(80,255,190,0.07)';
    ctx.fill();
  }
  for (let i = 0; i < 40; i++) {
    const x = ((i * 137.5) % 1) * VW + ((i * 97.13) % VW), y = ((i * 61.7) % (VH * 0.9));
    const a = 0.15 + 0.25 * (0.5 + 0.5 * Math.sin(now / 500 + i * 1.9));
    ctx.fillStyle = `rgba(230,240,255,${a.toFixed(3)})`;
    disc(x % VW, y, 0.9 + (i % 3) * 0.4);
    ctx.fill();
  }
}

function drawSnow(t) {
  if (!rush(t)) return;
  flat();
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (const f of flakes) { disc(f.x * VW, f.y * VH, f.r); ctx.fill(); }
}

// The rink: a snowbank round pale blue ice with a sheen across it, faint lines
// between the cells and a few scratches from skates.
function drawRink(t, now) {
  flat();
  const x0 = SX(0), y0 = SY(0), w = W * sc, h = H * sc, bk = BANK * sc;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(x0 - bk + 3, y0 - bk + 6, w + 2 * bk, h + 2 * bk, bk * 1.2);
  ctx.fill();
  const bg = ctx.createLinearGradient(0, y0 - bk, 0, y0 + h + bk);
  bg.addColorStop(0, INK.bank);
  bg.addColorStop(1, INK.bankShade);
  ctx.fillStyle = bg;
  roundRect(x0 - bk, y0 - bk, w + 2 * bk, h + 2 * bk, bk * 1.2);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, w, h, bk * 0.5);
  ctx.clip();
  const g = ctx.createLinearGradient(x0, y0, x0 + w * 0.4, y0 + h);
  g.addColorStop(0, INK.iceTop);
  g.addColorStop(1, INK.iceBot);
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, h);
  const sheen = ctx.createLinearGradient(x0, y0, x0 + w, y0 + h);
  const s = (now / 9000) % 1;
  sheen.addColorStop(Math.max(0, s - 0.1), 'rgba(255,255,255,0)');
  sheen.addColorStop(s, 'rgba(255,255,255,0.28)');
  sheen.addColorStop(Math.min(1, s + 0.1), 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = INK.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < COLS; i++) { ctx.moveTo(SX(i * CELL), y0); ctx.lineTo(SX(i * CELL), y0 + h); }
  for (let i = 1; i < ROWS; i++) { ctx.moveTo(x0, SY(i * CELL)); ctx.lineTo(x0 + w, SY(i * CELL)); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = Math.max(1, 3 * sc);
  for (let i = 0; i < 26; i++) {
    const sx = ((i * 0.6180339 + 0.21) % 1) * W, sy = ((i * 0.381966 * 5 + 0.37) % 1) * H, a = i * 2.4;
    ctx.beginPath();
    ctx.arc(SX(sx), SY(sy), (160 + (i % 4) * 70) * sc, a, a + 0.6 + (i % 3) * 0.3);
    ctx.stroke();
  }
  // Starting marks where the seats line up.
  for (let i = 0; i < START.length; i++) {
    const [cx, cy] = START[i];
    ctx.strokeStyle = 'rgba(80,130,180,0.25)';
    ctx.lineWidth = Math.max(1, 4 * sc);
    disc(SX(cx * CELL + CELL / 2), SY(cy * CELL + CELL / 2), 44 * sc);
    ctx.stroke();
  }
  if (rush(t)) {
    ctx.fillStyle = `rgba(255,255,255,${(0.1 + 0.05 * Math.sin(now / 240)).toFixed(3)})`;
    ctx.fillRect(x0, y0, w, h);
  }
  ctx.restore();
}

// A fish: a little body, a tail and an eye, gold for the rare one.
function fishShape(x, y, r, gold, ang) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.fillStyle = gold ? INK.fishGold : INK.fish;
  ctx.beginPath();
  ctx.ellipse(0, 0, r, r * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-r * 0.8, 0);
  ctx.lineTo(-r * 1.5, -r * 0.55);
  ctx.lineTo(-r * 1.5, r * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.ellipse(r * 0.1, -r * 0.18, r * 0.5, r * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a2233';
  disc(r * 0.5, -r * 0.08, Math.max(0.8, r * 0.12));
  ctx.fill();
  ctx.restore();
}

// A block: a glassy cube seen from a little above, its top face lifted off the
// ice and its front face darker, a fish frozen inside some of them.
const LIFT = 0.2;
function drawBlock(x, y, kind, now, n, k) {
  const c = CELL * sc, sx = SX(x), sy = SY(y), lift = c * LIFT;
  ctx.fillStyle = 'rgba(30,70,110,0.22)';
  roundRect(sx + c * 0.06, sy + c * 0.12, c * 0.98, c * 0.94, c * 0.12);
  ctx.fill();
  ctx.fillStyle = INK.blockSide;
  roundRect(sx + 1, sy - lift + c * 0.3, c - 2, c * 0.7 + lift - 1, c * 0.12);
  ctx.fill();
  const g = ctx.createLinearGradient(sx, sy - lift, sx + c, sy - lift + c);
  g.addColorStop(0, '#e7f8ff');
  g.addColorStop(1, INK.blockTop);
  ctx.fillStyle = g;
  roundRect(sx + 1, sy - lift + 1, c - 2, c - 2 - lift * 0.15, c * 0.12);
  ctx.fill();
  ctx.strokeStyle = INK.blockEdge;
  ctx.lineWidth = Math.max(1, c * 0.04);
  ctx.stroke();
  if (kind > 0) {
    const wob = Math.sin(now / 500 + n) * 0.08;
    if (kind === 2) {
      const glow = ctx.createRadialGradient(sx + c / 2, sy - lift + c / 2, 0, sx + c / 2, sy - lift + c / 2, c * 0.55);
      glow.addColorStop(0, 'rgba(255,220,80,0.55)');
      glow.addColorStop(1, 'rgba(255,220,80,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(sx, sy - lift, c, c);
    }
    const was = ctx.globalAlpha;
    ctx.globalAlpha = was * 0.85;
    fishShape(sx + c / 2, sy - lift + c * 0.47, c * 0.22, kind === 2, -0.3 + wob);
    ctx.globalAlpha = was;
  }
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.moveTo(sx + c * 0.14, sy - lift + c * 0.12);
  ctx.lineTo(sx + c * 0.42, sy - lift + c * 0.12);
  ctx.lineTo(sx + c * 0.14, sy - lift + c * 0.4);
  ctx.closePath();
  ctx.fill();
  if (k) {
    // Sliding: streaks of spray behind it.
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = Math.max(1, c * 0.05);
    const [dx, dy] = k;
    for (let i = 0; i < 3; i++) {
      const ax = sx + c / 2 - dx * c * 0.6 + (dy ? (i - 1) * c * 0.3 : 0), ay = sy + c / 2 - dy * c * 0.6 + (dx ? (i - 1) * c * 0.3 : 0);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - dx * c * 0.5, ay - dy * c * 0.5);
      ctx.stroke();
    }
  }
}

// The block your next kick would move, outlined, with the path it would take
// marked to where it would stop — or a burst where it would shatter.
function drawAim(t, d, now) {
  if (!d || d.fl > 0 || t.ph === COUNT || t.ph === END) return;
  const [dx, dy] = DIRS[d.fc];
  const tx = cellOf(d.x, COLS) + dx, ty = cellOf(d.y, ROWS) + dy;
  const q = inRink(tx, ty) ? stillAt(t, tx, ty) : null;
  if (!q) return;
  const gap = dx > 0 ? tx * CELL - d.x : dx < 0 ? d.x - (tx + 1) * CELL : dy > 0 ? ty * CELL - d.y : d.y - (ty + 1) * CELL;
  if (gap > PR + KICK_REACH) return;
  flat();
  const c = CELL * sc, colour = SEAT[d.c], ready_ = d.cd === 0;
  ctx.strokeStyle = alpha(colour, ready_ ? 0.95 : 0.4);
  ctx.lineWidth = Math.max(1.5, c * 0.06);
  roundRect(SX(tx * CELL) - 2, SY(ty * CELL) - c * LIFT - 2, c + 4, c + 4, c * 0.15);
  ctx.stroke();
  let ex = tx, ey = ty;
  while (!occupied(t, ex + dx, ey + dy, q)) { ex += dx; ey += dy; }
  if (ex === tx && ey === ty) {
    const k = 0.5 + 0.5 * Math.sin(now / 120);
    ctx.strokeStyle = `rgba(255,255,255,${(0.4 + 0.4 * k).toFixed(3)})`;
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3, cx = SX(tx * CELL + CELL / 2), cy = SY(ty * CELL + CELL / 2) - c * LIFT;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * c * 0.2, cy + Math.sin(a) * c * 0.2);
      ctx.lineTo(cx + Math.cos(a) * c * (0.4 + 0.1 * k), cy + Math.sin(a) * c * (0.4 + 0.1 * k));
      ctx.stroke();
    }
    return;
  }
  ctx.fillStyle = alpha(colour, ready_ ? 0.6 : 0.25);
  for (let x = tx, y = ty, i = 0; x !== ex || y !== ey; i++) {
    x += dx;
    y += dy;
    const k = (now / 400 + i * 0.2) % 1;
    disc(SX(x * CELL + CELL / 2 - dx * CELL * 0.5 * k), SY(y * CELL + CELL / 2 - dy * CELL * 0.5 * k), Math.max(1.5, c * 0.06));
    ctx.fill();
  }
  ctx.strokeStyle = alpha(colour, ready_ ? 0.7 : 0.3);
  ctx.setLineDash([Math.max(2, c * 0.1), Math.max(2, c * 0.08)]);
  roundRect(SX(ex * CELL) + c * 0.1, SY(ey * CELL) + c * 0.1, c * 0.8, c * 0.8, c * 0.12);
  ctx.stroke();
  ctx.setLineDash([]);
}

// A falling block dropping out of the sky over its shadow, which is drawn on
// the ice beneath everything else, and a warning blinking as it lands.
function drawFall(f, now) {
  const c = CELL * sc, k = 1 - f[3] / FALL_STEPS;
  const sx = SX(f[0] * CELL), sy = SY(f[1] * CELL);
  if (f[3] < 12 && Math.floor(now / 80) % 2) {
    ctx.strokeStyle = 'rgba(255,80,80,0.8)';
    ctx.lineWidth = 2;
    roundRect(sx + 2, sy + 2, c - 4, c - 4, c * 0.15);
    ctx.stroke();
  }
  const up = (1 - k) * (1 - k) * 900;
  ctx.globalAlpha = Math.min(1, k * 2.5);
  drawBlock(f[0] * CELL, f[1] * CELL - up, f[2], now, f[0] * 31 + f[1], null);
  ctx.globalAlpha = 1;
}

function drawFishOnIce(it, now) {
  const c = CELL * sc, bob = Math.sin(now / 200 + it[0]) * c * 0.04;
  const late = it[4] > FISH_LIFE - 3 * HZ;
  if (late && Math.floor(now / 120) % 2) return;
  const sx = SX(it[1]), sy = SY(it[2]);
  ctx.fillStyle = 'rgba(30,60,100,0.22)';
  ctx.beginPath();
  ctx.ellipse(sx, sy + c * 0.12, c * 0.24, c * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
  if (it[3]) {
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, c * 0.5);
    g.addColorStop(0, 'rgba(255,220,80,0.6)');
    g.addColorStop(1, 'rgba(255,220,80,0)');
    ctx.fillStyle = g;
    disc(sx, sy, c * 0.5);
    ctx.fill();
  }
  fishShape(sx, sy - c * 0.08 + bob, c * 0.2, it[3] === 1, Math.sin(now / 300 + it[0]) * 0.25);
}

// A penguin, standing up on the ice: a round body in its seat's colour with a
// white front, a beak and eyes the way it faces (its back when it faces away),
// flippers, orange feet that waddle, a crown on the leader, its name above it.
// Flattened, it is a pancake with stars going round; just up again, it blinks.
function drawPenguin(id, sx, sy, d, colour, me, t, now) {
  const l = lookOf(id, now);
  const sp = Math.hypot(d.vx, d.vy);
  l.gait += frameDt * sp * 0.75;
  l.kick *= Math.pow(0.85, frameDt * 60);
  const s = PR * sc;
  ctx.fillStyle = 'rgba(30,60,100,0.3)';
  ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.55, s * 1.05, s * 0.38, 0, 0, Math.PI * 2); ctx.fill();
  if (d.fl > 0) {
    ctx.fillStyle = colour;
    ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.25, s * 1.45, s * 0.55, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(sx, sy + s * 0.32, s * 0.9, s * 0.32, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1a2233';
    ctx.lineWidth = Math.max(1, s * 0.1);
    for (const k of [-1, 1]) {
      const ex = sx + k * s * 0.35, ey = sy + s * 0.05;
      ctx.beginPath();
      ctx.moveTo(ex - s * 0.12, ey - s * 0.1); ctx.lineTo(ex + s * 0.12, ey + s * 0.1);
      ctx.moveTo(ex + s * 0.12, ey - s * 0.1); ctx.lineTo(ex - s * 0.12, ey + s * 0.1);
      ctx.stroke();
    }
    ctx.fillStyle = INK.gold;
    for (let i = 0; i < 3; i++) {
      const a = now / 250 + (i * Math.PI * 2) / 3;
      disc(sx + Math.cos(a) * s * 1.1, sy - s * 0.5 + Math.sin(a) * s * 0.3, Math.max(1.2, s * 0.13));
      ctx.fill();
    }
  } else {
    if (d.inv > 0 && Math.floor(now / 90) % 2) ctx.globalAlpha = 0.45;
    const tilt = sp > 1.5 ? Math.sin(l.gait) * 0.14 : 0;
    const hop = sp > 1.5 ? Math.abs(Math.sin(l.gait)) * s * 0.12 : 0;
    // Feet.
    ctx.fillStyle = '#ff9a2e';
    for (const k of [-1, 1]) {
      const step_ = sp > 1.5 ? Math.sin(l.gait + (k > 0 ? Math.PI : 0)) * s * 0.12 : 0;
      ctx.beginPath(); ctx.ellipse(sx + k * s * 0.32, sy + s * 0.55 + step_, s * 0.26, s * 0.13, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.save();
    ctx.translate(sx, sy - hop);
    ctx.rotate(tilt);
    const by = -s * 0.15;
    const g = ctx.createRadialGradient(-s * 0.35, by - s * 0.5, s * 0.1, 0, by, s * 1.2);
    g.addColorStop(0, mix(colour, '#ffffff', 0.3));
    g.addColorStop(1, mix(colour, '#000000', 0.25));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, by, s * 0.88, s * 1.05, 0, 0, Math.PI * 2); ctx.fill();
    const fc = d.fc;
    // Flippers, one swung out on a kick.
    ctx.fillStyle = mix(colour, '#000000', 0.35);
    for (const k of [-1, 1]) {
      const out = (fc === 0 && k > 0) || (fc === 2 && k < 0) ? l.kick * 0.9 : 0;
      ctx.save();
      ctx.translate(k * s * 0.8, by + s * 0.05);
      ctx.rotate(k * (0.35 + out + (sp > 1.5 ? Math.sin(l.gait * 2) * 0.12 : 0)));
      ctx.beginPath(); ctx.ellipse(0, s * 0.3, s * 0.18, s * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    if (fc !== 3) {
      // The white front, and a face turned the way it looks.
      const look = fc === 0 ? 1 : fc === 2 ? -1 : 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.ellipse(look * s * 0.2, by + s * 0.22, s * (look ? 0.5 : 0.6), s * 0.72, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(look * s * 0.22, by - s * 0.45, s * (look ? 0.42 : 0.55), s * 0.34, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a2233';
      const eyes = look ? [look * s * 0.38] : [-s * 0.24, s * 0.24];
      for (const ex of eyes) { disc(ex, by - s * 0.48, Math.max(1, s * 0.11)); ctx.fill(); }
      ctx.fillStyle = '#ffffff';
      for (const ex of eyes) { disc(ex + s * 0.04, by - s * 0.52, Math.max(0.5, s * 0.04)); ctx.fill(); }
      ctx.fillStyle = '#ff9a2e';
      ctx.beginPath();
      const bx = look ? look * s * 0.62 : 0, byk = by - s * 0.3;
      ctx.moveTo(bx - (look ? 0 : s * 0.16), byk - s * 0.06);
      ctx.lineTo(bx + (look ? look * s * 0.36 : s * 0.16), byk - (look ? 0 : s * 0.06));
      ctx.lineTo(bx + (look ? 0 : 0), byk + s * 0.16);
      ctx.closePath();
      ctx.fill();
      // A scarf in a darker shade of the seat's colour.
      ctx.fillStyle = mix(colour, '#000000', 0.15);
      roundRect(-s * 0.72, by - s * 0.14, s * 1.44, s * 0.2, s * 0.1);
      ctx.fill();
    } else {
      ctx.fillStyle = mix(colour, '#000000', 0.15);
      roundRect(-s * 0.72, by - s * 0.14, s * 1.44, s * 0.2, s * 0.1);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.ellipse(0, by + s * 0.35, s * 0.35, s * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  let top = sy - s * 1.45;
  if (leaderOf(t) === id) {
    const cs = Math.max(5, s * 0.45), cy = top - cs * 0.2;
    ctx.fillStyle = INK.gold;
    ctx.beginPath();
    ctx.moveTo(sx - cs, cy);
    ctx.lineTo(sx - cs, cy - cs * 0.9);
    ctx.lineTo(sx - cs * 0.5, cy - cs * 0.4);
    ctx.lineTo(sx, cy - cs * 1.1);
    ctx.lineTo(sx + cs * 0.5, cy - cs * 0.4);
    ctx.lineTo(sx + cs, cy - cs * 0.9);
    ctx.lineTo(sx + cs, cy);
    ctx.closePath();
    ctx.fill();
    top = cy - cs * 1.1 - 3;
  }
  const px = Math.max(9, Math.min(13, 6 + s * 0.2));
  ctx.lineWidth = 3;
  ctx.strokeStyle = INK.ink;
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  ctx.strokeText(label, sx, top);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, sx, top);
}

function drawBits() {
  flat();
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    const r = b.size * sc * (1 - f * 0.5);
    if (b.sq) {
      ctx.save();
      ctx.translate(SX(b.x), SY(b.y));
      ctx.rotate(b.life * 0.3);
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    } else {
      disc(SX(b.x), SY(b.y), r);
      ctx.fill();
    }
  }
  for (const r of rings) {
    const f = r.life / r.max;
    ctx.globalAlpha = (1 - f) * 0.75;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - f) + 1;
    disc(SX(r.x), SY(r.y), r.r * sc * ease(f));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const f = p.life / p.max;
    const rise = 14 + ease(f) * 26;
    const scale = f < 0.15 ? 0.6 + (f / 0.15) * 0.5 : 1.1 - Math.min(0.1, f - 0.15);
    ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
    ctx.font = font(p.px * scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK.ink;
    const half = Math.min(W * sc / 2 - 10, ctx.measureText(p.s).width / 2 + 6);
    const X = Math.max(ox + half, Math.min(ox + W * sc - half, SX(p.x))), Y = Math.max(fieldTop + 18, SY(p.y) - rise);
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
    if (rush(t)) { status += ' · blizzard'; colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text; }
  } else status = 'round ' + t.rd + ' · over';
  text('floe', 12, 22, titlePx, '#d6ecff', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('floe').width;
  if (wide) fitText(status, 12, 44, 14, colour, colW - 24, 'left');
  else fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with their points this
  // round and rounds won, and a crown's gold on the leader's points. A row
  // across the top of a narrow frame, a column down the left of a wide one.
  const ids = bySeat(t);
  const lead = leaderOf(t);
  if (ids.length) {
    const gap = 6;
    const cw = wide ? Math.min(200, colW - 24) : Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = wide ? 12 : (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    let y = wide ? 76 : narrow ? 46 : 44;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      disc(x + 11, y - 2, 5);
      ctx.fillStyle = c;
      ctx.fill();
      const score = String(d.rp);
      ctx.font = font(12);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 8, y + 3, 12, id === lead ? INK.gold : INK.text, 'right');
      const wins = t.ph !== WAIT && d.wn ? '★' + d.wn : '';
      ctx.font = font(10);
      const ww = wins ? ctx.measureText(wins).width + 5 : 0;
      if (wins && cw > 56) text(wins, x + cw - 12 - sw, y + 2, 10, '#eef1ff', 'right');
      if (cw > 64) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw - ww, 'left');
      if (wide) y += 22 + gap; else x += cw + gap;
    }
  }

  // The one line that says how to play: across the foot of a narrow frame, and
  // broken into lines at the foot of the right-hand column of a wide one.
  const how = coarse
    ? 'drag to waddle · walk into a block, then tap to kick it · flatten rivals · grab the fish'
    : 'arrows/WASD waddle · space, X or click kicks the block you face · M mutes';
  if (!wide) { fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20); return; }
  const lines = wrap(how, 12, colW - 24);
  lines.forEach((s, i) => text(s, VW - 12, VH - 12 - (lines.length - 1 - i) * 17, 12, INK.muted, 'right'));
}

// Your kick while a round is on: in the strip under the rink, or halfway down
// the right-hand column of a wide one.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = wide ? VH / 2 : Math.min(fieldBot + NOTE_ROOM / 2 - 4, VH - BOT - 18);
  const mid = wide ? VW - colW / 2 : VW / 2, room_ = wide ? colW - 24 : VW - 24;
  const word = d.fl > 0 ? 'flattened' : 'kick';
  ctx.font = font(12);
  const kw = ctx.measureText(word).width;
  const bar = 60;
  const total = kw + 8 + bar;
  const k = Math.min(1, room_ / total);
  let x = mid - (total * k) / 2;
  text(word, x, y + 4, 12, d.fl > 0 ? '#ff8a8a' : d.cd === 0 ? INK.text : INK.dim, 'left');
  x += (kw + 8) * k;
  const top = d.fl > 0 ? FLAT : trails(t, myId()) ? KICK_CD_BEHIND : KICK_CD;
  const left = d.fl > 0 ? d.fl : d.cd;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(x, y - 4, bar * k, 8, 4);
  ctx.fill();
  ctx.fillStyle = d.fl > 0 ? '#ff8a8a' : d.cd === 0 ? SEAT[d.c] : INK.dim;
  roundRect(x, y - 4, Math.max(8, bar * k * (1 - Math.min(1, left / top))), 8, 4);
  ctx.fill();
  if (trails(t, myId())) fitText('behind: you waddle faster and kick sooner', mid, y + 22, 11, INK.dim, room_);
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
  const cx = VW / 2, mid = (fieldTop + fieldBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'walk into a block and kick it: fish blocks crack open, and any block flattens the bot';
    if (wide) practiceNote(now, VW, head, tip, [], VH - 8);
    else practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 360), 30);
    fitText('kick blocks · flatten rivals · crack out the fish', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 340));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('kick!', cx, mid + big * 0.5);
    text('kick!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= 5 * HZ) {
    const n = Math.ceil(t.pt / HZ);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * 2);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big * 0.7);
    text(String(n), cx, mid + big * 0.7, big * 2, INK.gold, 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 340), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody came out on top';
    else head = t.win === me ? 'you rule the rink!' : nickOf(t.win) + ' rules the rink';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('fish', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('splats', cx + w / 2 - 62, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, rp, fish, sq, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(fish), cx + w / 2 - 110, y, 13, '#eef1ff', 'right');
      text(String(sq), cx + w / 2 - 62, y, 13, '#eef1ff', 'right');
      text(String(rp), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a penguin is as drawn: between two steps, and never slid across a
// jump — a penguin put on its starting cell for a new round.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 200) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

// Your own penguin is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a hand a step away from
// where the guess had it. So the penguin drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a penguin put on its starting cell for a new round — puts it
// there at once. Only the drawing is smoothed: the rink, and every rule on
// it, are untouched.
const PULL = 0.5;
let shown = null;        // [x, y] in units: where your penguin is drawn

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 200) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  fit();
  const b = agreedAt(now);
  drawBack(b ? b.to : { ph: WAIT, pt: 0 }, now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the rink…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a table this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const me = myId();
  // Your own penguin as the guess has it, while the guess has you at all.
  const m = mineAt(now);
  let mine = null, mx = 0, my = 0;
  if (t.p[me]) {
    const own = m && m.to.p[me] ? m : b;
    const p = bodyAt(own, me);
    [mx, my] = settle(p[0], p[1]);
    mine = p[2];
  } else {
    shown = null;
  }
  drawRink(t, now);
  for (const f of t.fa) {
    const c = CELL * sc, k = 1 - f[3] / FALL_STEPS;
    ctx.fillStyle = `rgba(20,50,90,${(0.1 + 0.35 * k).toFixed(3)})`;
    const s = 0.5 + 0.5 * k;
    roundRect(SX(f[0] * CELL) + c * (1 - s) / 2, SY(f[1] * CELL) + c * (1 - s) / 2, c * s, c * s, c * 0.15);
    ctx.fill();
  }
  for (const it of t.it) drawFishOnIce(it, now);
  if (mine) drawAim(t, Object.assign({}, mine, { x: mx, y: my }), now);
  // Blocks between their two steps, and penguins, drawn from the top of the
  // rink down so whatever stands nearer the bottom stands in front.
  const before = new Map(b.from.b.map((q) => [q[0], q]));
  const things = [];
  for (const q of t.b) {
    const a = before.get(q[0]);
    let x = boxX(q), y = boxY(q);
    if (a) {
      const ax = boxX(a), ay = boxY(a);
      if (Math.abs(ax - x) + Math.abs(ay - y) <= 2 * CELL) { x = lerp(ax, x, b.k); y = lerp(ay, y, b.k); }
    }
    const k = moving(q) ? [q[4], q[5]] : a && moving(a) ? [a[4], a[5]] : null;
    things.push({ y: y + CELL, f: () => drawBlock(x, y, q[3], now, q[0], k) });
  }
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const p = bodyAt(b, id);
    things.push({ y: p[1] + PR, f: () => drawPenguin(id, SX(p[0]), SY(p[1]), p[2], SEAT[p[2].c], false, t, now) });
  }
  if (mine) things.push({ y: my + PR, f: () => drawPenguin(me, SX(mx), SY(my), mine, SEAT[mine.c], true, t, now) });
  things.sort((p, q) => p.y - q.y);
  flat();
  for (const th of things) th.f();
  for (const f of t.fa) drawFall(f, now);
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawSnow(t);
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way waddled, and how many kicks so far. A change of
// way goes out no oftener than STEER_EVERY, because a thumb changes it on
// every move the screen reports and the clock's ticks share the same seat's
// ceiling on messages; a kick goes out at once.
const STEER_EVERY = 80;
let kicksAsked = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const LEFT = ['ArrowLeft', 'KeyA'], RIGHT = ['ArrowRight', 'KeyD'], UP = ['ArrowUp', 'KeyW'], DOWN = ['ArrowDown', 'KeyS'];
const KICK = ['Space', 'KeyX', 'KeyJ', 'KeyK', 'Enter'];

// A thumb or a mouse: a stick from wherever it lands, the waddle as fast as
// the drag is long, full at REACH; a tap kicks — a drag rather than a press,
// because iOS keeps a long press inside a frame for itself. A second finger
// down while the first steers kicks too, and so does a right click.
const DEAD = 10;
const REACH = 46;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }

function handNow() {
  let mx = 0, my = 0;
  if (stick) {
    const far = Math.hypot(stick.dx, stick.dy);
    if (far > DEAD) {
      const k = Math.min(1, (far - DEAD) / (REACH - DEAD)) / far;
      mx = Math.round(stick.dx * k * 1000);
      my = Math.round(stick.dy * k * 1000);
    }
  }
  const kx = (RIGHT.some((c) => keys.has(c)) ? 1 : 0) - (LEFT.some((c) => keys.has(c)) ? 1 : 0);
  const ky = (DOWN.some((c) => keys.has(c)) ? 1 : 0) - (UP.some((c) => keys.has(c)) ? 1 : 0);
  if (kx || ky) {
    const k = kx && ky ? 707 : 1000;
    mx = kx * k;
    my = ky * k;
  }
  return [clamp(mx, -1000, 1000), clamp(my, -1000, 1000)];
}

function sayHand(now, force) {
  const [mx, my] = handNow();
  const h = [mx, my, kicksAsked], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1] && h[2] === s[2]) return;
  if (!force && s && h[2] === s[2] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A kick: heard at once, and taken a trip later on every copy alike, if the
// table says the cooldown is over and a block stands in front.
function kickNow() {
  wake();
  if (!world) return;
  kicksAsked = (kicksAsked + 1) % 1000;
  sayHand(performance.now(), true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (KICK.includes(e.code)) { e.preventDefault(); if (!e.repeat) kickNow(); return; }
  if (![...LEFT, ...RIGHT, ...UP, ...DOWN].includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  keys.add(e.code);
  sayHand(performance.now(), true);
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  sayHand(performance.now(), true);
});
addEventListener('blur', () => {
  keys.clear();
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (e.button === 2) { kickNow(); return; }
  if (stick) { kickNow(); return; }
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0, at: performance.now(), moved: false };
  paintStick();
});
cv.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.id) return;
  stick.dx = e.clientX - stick.ox;
  stick.dy = e.clientY - stick.oy;
  if (Math.hypot(stick.dx, stick.dy) >= DEAD) stick.moved = true;
  paintStick();
  sayHand(performance.now(), false);
});
function liftPointer(e) {
  if (!stick || e.pointerId !== stick.id) return;
  const tap = !stick.moved && performance.now() - stick.at < 260;
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
  if (tap) kickNow();
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', liftPointer);
addEventListener('pointerup', liftPointer);
addEventListener('pointercancel', liftPointer);

const stickRing = document.createElement('div');
stickRing.style.cssText =
  `position:fixed;display:none;width:${REACH * 2}px;height:${REACH * 2}px;` +
  `margin:${-REACH}px 0 0 ${-REACH}px;border-radius:50%;pointer-events:none;` +
  'border:1px solid rgba(255,255,255,0.35);background:rgba(255,255,255,0.06)';
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  'border-radius:50%;pointer-events:none;background:#ffffff;opacity:.55';
document.body.append(stickRing, knob);

function paintStick() {
  if (!stick || !coarse) { stickRing.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(stick.dx, stick.dy);
  const k = far > REACH ? REACH / far : 1;
  stickRing.style.display = knob.style.display = 'block';
  stickRing.style.left = stick.ox + 'px';
  stickRing.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + stick.dx * k + 'px';
  knob.style.top = stick.oy + stick.dy * k + 'px';
}

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  sayHand(now, false);
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a player arrives on the rink.
function start() {
  setHand([0, 0, kicksAsked]);
  lastSaid = [0, 0, kicksAsked];
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
