/**
 * @disk     fuse
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Bombs in a hedge maze. Drop one, run, and let the blast open crates for more fire, more bombs, speed and a kick. Caught in a blast, you haunt the rim and lob bombs back in: hit somebody and you take their place. Then the hedge closes in.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/fuse.png
 */
// fuse.js — bombs in a hedge maze, where the room's order is the referee.
//
// Every copy holds the whole maze — every crate, every bomb and how long its
// fuse has left, every flame, every player and ghost — and changes it only on
// what comes back round the room, so every copy applies the same hands in the
// same order and holds the same maze. Nobody sends where they stand, what a
// blast reached or who it caught: a hand is the way a player is pushing and a
// counter that moves on by one for every bomb, and everything else is the same
// arithmetic on the same whole numbers on every machine. A page with a console
// open can walk its own player however it likes, at that player's own speed,
// and drop no more bombs than the maze has given it.
//
// While a player is alone in the maze, a bot plays with them. It is part of
// the maze like any player, and its moves are a function of the maze alone, so
// it plays the same on every copy and says nothing over the wire. When a second
// player arrives, practice runs on for three seconds under a note that says
// so, and the bot leaves before the round is laid out: it never takes part in
// one.
//
// Your own player does not wait for the trip: it is drawn from the agreed maze
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — a cell is 120 units, a speed is units
// a step — and use nothing but `+ - *`, comparisons, `Math.floor`, `Math.min`,
// `Math.max`, `Math.abs`, `Math.sign` and `Math.imul`, which the language
// fixes to the last bit. Trigonometry appears only in the drawing, which is
// nobody's business but the screen's.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the maze a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own player a trip ahead, with your hand in it

const GW = 13, GH = 11, NC = GW * GH;   // the maze, in cells
const U = 120;                 // units a cell
const HALF = U / 2;
// Speeds stay under half a cell a step, so no step carries a player over the
// middle of a cell and on into a wall beyond it.
const SPEED0 = 18, SPEED_UP = 3, SPEED_MAX = 30;
const BOMBS0 = 1, BOMBS_MAX = 8;
const RANGE0 = 2, RANGE_MAX = 8;
const FUSE = Math.round(2.5 * HZ);     // steps from a bomb dropped to its blast
const FLAME = Math.round(0.5 * HZ);    // steps a flame burns
const SLIDE = 40;              // units a kicked bomb travels a step: a cell in three
const SHIELD = Math.round(1.5 * HZ);   // steps nothing can catch a player just back in the maze
const GHOST_SPEED = 24;        // units a step a ghost floats along the rim
const GHOST_RELOAD = 3 * HZ;   // steps between two bombs lobbed from the rim
const GHOST_RANGE = 2;
const LOB_FROM = 2;            // a lobbed bomb lands at least this many cells in from the edge
const LOB_STEPS = 8;           // steps a lobbed bomb is drawn in the air
const PRACTICE_GHOST = 4 * HZ; // steps a practising player haunts the rim before walking back in
const REGROW = 2 * HZ;         // steps between two crates growing back in practice
const PRACTICE_CRATES = 44;
const CRATE_ODDS = 0.72;
const ITEM_ODDS = 0.42;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const MAX_BOMBS = 64;
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 110 * HZ;
const END_STEPS = 6 * HZ;
const HEDGE_AT = 50 * HZ;      // steps left in a round when the hedge starts to close
const HEDGE_EVERY = 10;        // steps between two cells of it

const FLOOR = 0, PILLAR = 1, CRATE = 2, HEDGE = 3;
const FIRE = 0, BOMB = 1, BOOTS = 2, KICK = 3;
// A direction: none, up, right, down, left.
const DIRS = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];

const pillarAt = (x, y) => x % 2 === 1 && y % 2 === 1;
const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Where players start, in the order seats are handed out: two players stand
// in opposite corners. Each start keeps the cells beside it clear of crates,
// so there is always a corner to step round from the first bomb.
const SPAWNS = [[0, 0], [12, 10], [12, 0], [0, 10], [6, 0], [6, 10], [0, 5], [12, 5]];
const ZONE = SPAWNS.map(([x, y]) => {
  const cells = [y * GW + x];
  for (let k = 1; k <= 4; k++) {
    const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
    if (nx >= 0 && ny >= 0 && nx < GW && ny < GH && !pillarAt(nx, ny)) cells.push(ny * GW + nx);
  }
  return cells;
});
const ZONED = new Set(ZONE.flat());

// The order the hedge closes in, from the outside: three rings, clockwise,
// leaving the middle of the maze for the last of a round.
const SPIRAL = [];
for (let L = 0; L < 3; L++) {
  const x0 = L, y0 = L, x1 = GW - 1 - L, y1 = GH - 1 - L;
  const ring = [];
  for (let x = x0; x <= x1; x++) ring.push([x, y0]);
  for (let y = y0 + 1; y <= y1; y++) ring.push([x1, y]);
  for (let x = x1 - 1; x >= x0; x--) ring.push([x, y1]);
  for (let y = y1 - 1; y > y0; y--) ring.push([x0, y]);
  for (const [x, y] of ring) if (!pillarAt(x, y)) SPIRAL.push(y * GW + x);
}

// The rim: the lane round the maze that ghosts float along, as one loop
// measured in units, clockwise from the top left corner.
const RA = (GW + 1) * U, RB = (GH + 1) * U, RIM = 2 * (RA + RB);
const TAN = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const rimSide = (s) => (s < RA ? 0 : s < RA + RB ? 1 : s < 2 * RA + RB ? 2 : 3);
function rimPoint(s) {
  const side = rimSide(s);
  if (side === 0) return [-HALF + s, -HALF];
  if (side === 1) return [GW * U + HALF, -HALF + (s - RA)];
  if (side === 2) return [GW * U + HALF - (s - RA - RB), GH * U + HALF];
  return [-HALF, GH * U + HALF - (s - 2 * RA - RB)];
}
// The place on the rim nearest a point in the maze.
function rimNear(x, y) {
  const dt = y, db = GH * U - y, dl = x, dr = GW * U - x, m = Math.min(dt, db, dl, dr);
  if (m === dt) return clampi(x + HALF, 0, RA - 1);
  if (m === dr) return RA + clampi(y + HALF, 0, RB - 1);
  if (m === db) return RA + RB + clampi(GW * U + HALF - x, 0, RA - 1);
  return 2 * RA + RB + clampi(GH * U + HALF - y, 0, RB - 1);
}

// The maze. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   g:  each cell: floor, pillar, crate, or hedge closed over it
//   it: each cell's power-up, -1 for none; under a crate it waits to be shown
//   fl: steps each cell's flame burns on; fo: whose blast lit it
//   b:  bombs, each [x, y, owner, fuse, range, sliding direction, units slid
//       into the next cell, rim place it was lobbed from or -1, age, serial]
//   bs: the serial of the last bomb; hi: cells of the hedge closed so far
//   gw: steps until a crate grows back in practice
//   res: the last round's [id, won, rounds won, catches] rows; win: its winner
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, g: [], it: [], fl: [], fo: [], b: [], bs: 0, hi: 0, gw: REGROW, p: {},
    res: null, win: -1,
  };
  lay(w, null);
  return w;
}

// A new maze: pillars on a grid, crates scattered over the rest, and the
// starts of the seats in use left clear — all of them for practice.
function lay(w, used) {
  const keep = new Set();
  for (let k = 0; k < SPAWNS.length; k++) if (!used || used.has(k)) for (const c of ZONE[k]) keep.add(c);
  w.g = []; w.it = []; w.fl = []; w.fo = [];
  for (let c = 0; c < NC; c++) {
    const x = c % GW, y = (c - x) / GW;
    let g = FLOOR, it = -1;
    if (pillarAt(x, y)) g = PILLAR;
    else if (!keep.has(c) && draw01(w) < CRATE_ODDS) { g = CRATE; it = hiddenItem(w); }
    w.g.push(g); w.it.push(it); w.fl.push(0); w.fo.push(0);
  }
  w.b = [];
  w.hi = 0;
}

function hiddenItem(w) {
  if (draw01(w) >= ITEM_ODDS) return -1;
  const r = draw01(w);
  return r < 0.36 ? FIRE : r < 0.72 ? BOMB : r < 0.9 ? BOOTS : KICK;
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'fc', 'd1', 'd2', 'q', 'bq', 'cap', 'rg', 'sp', 'kk', 'sh', 'gp', 'gr', 'gt',
  'rv', 'bt', 'bw', 'hs', 'hc', 'wn', 'kl'];
//   c: colour; s: seat; st: 0 in the maze, 1 a ghost on the rim; x, y: where,
//   in units; fc: the way it faces; d1, d2: the way its hand pushes, and the
//   way to try when that one is walled; q: the bomb counter as last heard; bq:
//   a bomb to drop this step; cap, rg, sp, kk: bombs at once, blast reach,
//   speed, and the kick; sh: shield steps left; gp: place on the rim; gr: steps
//   until the next lob; gt: steps until a practising ghost walks back in; rv:
//   comebacks this round; bt, bw: the bot's goal and its pause; hs, hc: hands
//   this step; wn: rounds won; kl: players caught this round.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);
const cellOf = (d) => Math.floor(d.y / U) * GW + Math.floor(d.x / U);

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

function newPlayer(w, q) {
  const s = freeOf(w, 's');
  return player({
    c: freeOf(w, 'c'), s, st: 0, x: SPAWNS[s][0] * U + HALF, y: SPAWNS[s][1] * U + HALF, fc: 3, d1: 0, d2: 0, q, bq: 0,
    cap: BOMBS0, rg: RANGE0, sp: SPEED0, kk: 0, sh: 0, gp: 0, gr: 0, gt: 0, rv: 0, bt: -1, bw: 0, hs: w.n, hc: 0, wn: 0,
    kl: 0,
  });
}

function basePowers(d) {
  d.cap = BOMBS0;
  d.rg = RANGE0;
  d.sp = SPEED0;
  d.kk = 0;
}

// A cell a player may walk into: floor, with no bomb on it or sliding into it.
function open(w, x, y) {
  if (x < 0 || y < 0 || x >= GW || y >= GH || w.g[y * GW + x] !== FLOOR) return false;
  for (const b of w.b) {
    if (b[0] === x && b[1] === y) return false;
    if (b[5] && b[6] > 0 && b[0] + DIRS[b[5]][0] === x && b[1] + DIRS[b[5]][1] === y) return false;
  }
  return true;
}

// Practice: a start nobody is standing near and no bomb is about to reach,
// the player's own seat's first.
function spawnFor(w, id) {
  const d = w.p[id];
  const ok = (k) => {
    const [sx, sy] = SPAWNS[k];
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o === id || e.st !== 0) continue;
      if (Math.abs(Math.floor(e.x / U) - sx) + Math.abs(Math.floor(e.y / U) - sy) <= 2) return false;
    }
    for (const b of w.b) if (Math.abs(b[0] - sx) + Math.abs(b[1] - sy) <= 3) return false;
    for (const c of ZONE[k]) if (w.fl[c] > 0) return false;
    return true;
  };
  if (ok(d.s)) return d.s;
  for (let k = 0; k < SPAWNS.length; k++) if (ok(k)) return k;
  return d.s;
}

function respawn(w, id) {
  const d = w.p[id];
  const k = spawnFor(w, id);
  for (const c of ZONE[k]) if (w.g[c] === CRATE) { w.g[c] = FLOOR; w.it[c] = -1; }
  d.st = 0;
  d.x = SPAWNS[k][0] * U + HALF;
  d.y = SPAWNS[k][1] * U + HALF;
  d.fc = 3;
  basePowers(d);
  d.sh = SHIELD;
  d.gt = d.gr = d.bq = 0;
  d.bt = -1;
  d.bw = 0;
}

function toGhost(w, id) {
  const d = w.p[id];
  d.st = 1;
  d.gp = rimNear(d.x, d.y);
  d.gr = GHOST_RELOAD;
  d.gt = w.ph === WAIT ? PRACTICE_GHOST : 0;
  d.sh = d.bq = 0;
}

// A hand, at its place in the room's order: [the way pushed, the way to try
// when that one is walled, the bomb counter]. A bomb is asked for once, when
// the counter changes; the same hand said again to keep a player at the table
// drops nothing. Being heard is how a player arrives: in the maze while it
// waits for a round or counts one in, and on the rim, as a ghost, while a
// round is on — from where a well-thrown bomb brings them in.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[2]);
    if (w.ph === WAIT) respawn(w, id);
    else if (w.ph === COUNT) {
      // In time for the round: on its own start, cleared for it.
      for (const c of ZONE[d.s]) if (w.g[c] === CRATE) { w.g[c] = FLOOR; w.it[c] = -1; }
    } else toGhost(w, id);
    d.d1 = input[0];
    d.d2 = input[1];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; what a bomb costs is the maze's to say, not the hand's.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.d1 = input[0];
  d.d2 = input[1];
  if (input[2] !== d.q) { d.q = input[2]; d.bq = 1; }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [a, b, q] = raw;
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(q)) return null;
  if (a < 0 || a > 4 || b < 0 || b > 4 || q < 0 || q > 999) return null;
  return [a, b, q];
}

function leave(w, id) {
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.08;         // how often it stands a moment rather than decide
const BOT_BOLD = 0.75;         // how often it takes a good chance to drop a bomb
const INF = 1e9;
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the maze waits for a round, and goes the moment a round
// is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    respawn(w, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// The cells a blast from (x, y) would reach: up to a pillar, the hedge or the
// edge, and the first crate or bomb in each line.
function reachOf(w, x, y, range) {
  const out = [y * GW + x];
  for (let k = 1; k <= 4; k++) {
    for (let r = 1; r <= range; r++) {
      const nx = x + DIRS[k][0] * r, ny = y + DIRS[k][1] * r;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) break;
      const c = ny * GW + nx, g = w.g[c];
      if (g === PILLAR || g === HEDGE) break;
      out.push(c);
      if (g === CRATE || w.b.some((o) => o[0] === nx && o[1] === ny)) break;
    }
  }
  return out;
}

// For every cell, the steps until fire reaches it, as the bot reads the maze:
// burning now is 0, out of every bomb's reach is INF.
function danger(w, extra) {
  const dz = new Array(NC).fill(INF);
  for (let c = 0; c < NC; c++) if (w.fl[c] > 0) dz[c] = 0;
  const bombs = extra ? w.b.concat([extra]) : w.b;
  for (const b of bombs) for (const c of reachOf(w, b[0], b[1], b[4])) dz[c] = Math.min(dz[c], Math.max(0, b[3]));
  return dz;
}

// The first step of the shortest way from `from` to a cell `goal` likes,
// through cells the bot can cross before fire gets there; -1 if none, and the
// cell itself when it is already there.
function route(w, from, dz, per, goal) {
  if (goal(from)) return from;
  const seen = new Map([[from, -1]]);
  let edge = [from];
  for (let depth = 1; edge.length && depth < 40; depth++) {
    const next = [];
    for (const c of edge) {
      const x = c % GW, y = (c - x) / GW;
      for (let k = 1; k <= 4; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1], n = ny * GW + nx;
        if (!open(w, nx, ny) || seen.has(n)) continue;
        if (dz[n] !== INF && dz[n] <= (depth + 1) * per + 1) continue;
        seen.set(n, c);
        if (goal(n)) {
          let at = n;
          while (seen.get(at) !== from) at = seen.get(at);
          return at;
        }
        next.push(n);
      }
    }
    edge = next;
  }
  return -1;
}

// Push the bot toward the middle of a cell next to it, or of its own.
function steerTo(d, c) {
  if (c < 0) { d.d1 = d.d2 = 0; return; }
  const tx = (c % GW) * U + HALF, ty = Math.floor(c / GW) * U + HALF;
  const dx = tx - d.x, dy = ty - d.y;
  if (c === cellOf(d) && Math.abs(dx) + Math.abs(dy) <= d.sp) {
    // Arrived: stood on the middle rather than walked past it and back.
    d.x = tx; d.y = ty; d.d1 = d.d2 = 0;
    return;
  }
  const h = dx > 0 ? 2 : dx < 0 ? 4 : 0, v = dy > 0 ? 3 : dy < 0 ? 1 : 0;
  if (Math.abs(dx) >= Math.abs(dy)) { d.d1 = h; d.d2 = v; } else { d.d1 = v; d.d2 = h; }
}

function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.st === 1) { botHaunt(w, d); return; }
  const here = cellOf(d);
  const dz = danger(w, null);
  const per = Math.ceil(U / d.sp);
  // Fire on the way comes first, every step: out of every bomb's reach.
  if (dz[here] !== INF) {
    d.bw = 0;
    d.bt = -1;
    steerTo(d, route(w, here, dz, per, (c) => dz[c] === INF));
    return;
  }
  if (d.bw > 0) { d.bw -= 1; d.d1 = d.d2 = 0; return; }
  if (w.n % BOT_EVERY === 0) {
    if (draw01(w) < BOT_IDLE) { d.bw = 6 + Math.floor(draw01(w) * 10); d.d1 = d.d2 = 0; return; }
    const x = here % GW, y = (here - x) / GW;
    let mine = 0;
    for (const b of w.b) if (b[2] === BOT_ID && b[7] < 0) mine += 1;
    if (mine < d.cap && !w.b.some((b) => b[0] === x && b[1] === y) && worthBomb(w, d, x, y) && draw01(w) < BOT_BOLD) {
      const dz2 = danger(w, [x, y, BOT_ID, FUSE, d.rg]);
      if (route(w, here, dz2, per, (c) => dz2[c] === INF) >= 0) { d.bq = 1; d.bt = -1; return; }
    }
    d.bt = botGoal(w, d, here, dz, per);
  }
  if (d.bt < 0) { d.d1 = d.d2 = 0; return; }
  const goal = d.bt;
  steerTo(d, route(w, here, dz, per, (c) => c === goal));
}

// Worth a bomb: a crate in its reach, or a player who is not a ghost.
function worthBomb(w, d, x, y) {
  for (const c of reachOf(w, x, y, d.rg)) {
    if (w.g[c] === CRATE) return true;
    for (const id of humans(w)) {
      const e = w.p[id];
      if (e.st === 0 && e.sh === 0 && cellOf(e) === c) return true;
    }
  }
  return false;
}

// Where the bot heads: a power-up in sight first, then the nearest place a
// bomb would open a crate or reach a player.
function botGoal(w, d, here, dz, per) {
  const safe = (c) => dz[c] === INF;
  const item = route(w, here, dz, per, (c) => safe(c) && w.it[c] >= 0 && w.g[c] === FLOOR);
  if (item >= 0 && draw01(w) < 0.8) return nearestWith(w, here, (c) => w.it[c] >= 0 && w.g[c] === FLOOR);
  return nearestWith(w, here, (c) => safe(c) && worthBomb(w, d, c % GW, (c - (c % GW)) / GW));
}

function nearestWith(w, from, goal) {
  const seen = new Set([from]);
  let edge = [from];
  for (let depth = 0; edge.length && depth < 40; depth++) {
    const next = [];
    for (const c of edge) {
      if (goal(c)) return c;
      const x = c % GW, y = (c - x) / GW;
      for (let k = 1; k <= 4; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1], n = ny * GW + nx;
        if (!open(w, nx, ny) || seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    edge = next;
  }
  return -1;
}

// A ghost bot floats toward the nearest player in the maze and lobs when it
// lines up with them, now and then.
function botHaunt(w, d) {
  let best = -1, far = INF;
  for (const id of humans(w)) {
    const e = w.p[id];
    if (e.st !== 0) continue;
    const s = rimNear(e.x, e.y);
    let diff = s - d.gp;
    if (diff > RIM / 2) diff -= RIM;
    if (diff < -RIM / 2) diff += RIM;
    if (Math.abs(diff) < Math.abs(far)) { far = diff; best = id; }
  }
  d.d1 = d.d2 = 0;
  if (best === -1) return;
  if (Math.abs(far) < HALF) {
    if (d.gr === 0 && w.n % BOT_EVERY === 0 && draw01(w) < 0.25) d.bq = 1;
    return;
  }
  const t = TAN[rimSide(d.gp)], sg = far > 0 ? 1 : -1;
  const vx = t[0] * sg, vy = t[1] * sg;
  d.d1 = vx > 0 ? 2 : vx < 0 ? 4 : vy > 0 ? 3 : 1;
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  lay(w, null);
  w.gw = REGROW;
  for (const id of bySeat(w)) respawn(w, id);
}

// A round: a new maze, the seats closed up in order so the starts in use are
// the first ones, everybody back on their feet with nothing picked up. Whoever
// has won fewest rounds, when somebody has won more, starts with a second bomb.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  lay(w, new Set(ids.map((_, i) => i)));
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) { lo = Math.min(lo, w.p[id].wn); hi = Math.max(hi, w.p[id].wn); }
  for (const id of ids) {
    const d = w.p[id];
    d.st = 0;
    d.x = SPAWNS[d.s][0] * U + HALF;
    d.y = SPAWNS[d.s][1] * U + HALF;
    d.fc = 3;
    basePowers(d);
    if (hi > lo && d.wn === lo) d.cap += 1;
    d.sh = d.gr = d.gt = d.rv = d.kl = d.bq = 0;
    d.bt = -1;
    d.bw = 0;
  }
  fx(w, 'round');
}

function finish(w) {
  const ids = bySeat(w);
  const alive = ids.filter((id) => w.p[id].st === 0);
  w.win = alive.length === 1 ? alive[0] : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, id === w.win ? 1 : 0, w.p[id].wn, w.p[id].kl]);
  res.sort((a, b) => b[1] - a[1] || b[2] - a[2] || b[3] - a[3] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  w.b = [];
  w.fl.fill(0);
  fx(w, 'end', 0, w.win);
}

function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting maze otherwise leaves at zero. The bot goes first, so
    // the round's seats close up without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === HEDGE_AT) fx(w, 'hedgewarn');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) w.p[id].bq = 0;
    return;
  }
  arena(w);
}

function arena(w) {
  const practice = w.ph === WAIT;
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.bq) {
      d.bq = 0;
      if (d.st === 0) plant(w, id);
      else lob(w, id);
    }
    if (d.sh > 0) d.sh -= 1;
    if (d.gr > 0) d.gr -= 1;
  }
  for (const id of ids) {
    const d = w.p[id];
    if (d.st === 0) walk(w, d);
    else haunt(d);
  }
  slide(w);
  for (let c = 0; c < NC; c++) if (w.fl[c] > 0) w.fl[c] -= 1;
  burn(w);
  // Caught: anybody standing in fire, unless just back in the maze.
  for (const id of ids) {
    const d = w.p[id];
    if (!d || d.st !== 0 || d.sh > 0) continue;
    const c = cellOf(d);
    if (w.fl[c] > 0) catchOut(w, id, w.fo[c]);
  }
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== 0) continue;
    const c = cellOf(d), it = w.it[c];
    if (it < 0 || w.g[c] !== FLOOR) continue;
    if (it === FIRE) d.rg = Math.min(RANGE_MAX, d.rg + 1);
    else if (it === BOMB) d.cap = Math.min(BOMBS_MAX, d.cap + 1);
    else if (it === BOOTS) d.sp = Math.min(SPEED_MAX, d.sp + SPEED_UP);
    else d.kk = 1;
    w.it[c] = -1;
    fx(w, 'pick', c, id, it);
  }
  if (practice) {
    for (const id of ids) {
      const d = w.p[id];
      if (d.st === 1 && d.gt > 0 && --d.gt === 0) { respawn(w, id); fx(w, 'back', cellOf(d), id); }
    }
    regrow(w);
    return;
  }
  hedge(w);
  let alive = 0;
  for (const id of ids) if (w.p[id].st === 0) alive += 1;
  if (alive <= 1) finish(w);
}

// One way of walking, if it goes anywhere. A player keeps to the lanes: going
// across one, it is first drawn to the lane's middle, and only when the cell
// ahead is open; and it never walks past the middle of a cell into a wall.
function go(w, d, dir) {
  const dx = DIRS[dir][0], dy = DIRS[dir][1];
  const cx = Math.floor(d.x / U), cy = Math.floor(d.y / U);
  const mx = cx * U + HALF, my = cy * U + HALF;
  const across = dx ? d.y - my : d.x - mx;
  const along = dx ? (d.x - mx) * dx : (d.y - my) * dy;
  const ahead = open(w, cx + dx, cy + dy);
  let left = d.sp;
  if (across !== 0) {
    if (!ahead) return false;
    const m = Math.min(Math.abs(across), left);
    if (dx) d.y -= Math.sign(across) * m;
    else d.x -= Math.sign(across) * m;
    left -= m;
    d.fc = dir;
    if (!left) return true;
  }
  if (ahead) {
    d.x += dx * left;
    d.y += dy * left;
    d.fc = dir;
    return true;
  }
  if (along < 0) {
    const m = Math.min(-along, left);
    d.x += dx * m;
    d.y += dy * m;
    d.fc = dir;
    return true;
  }
  if (d.kk) kick(w, cx + dx, cy + dy, dir);
  return false;
}

function walk(w, d) {
  if (d.d1 && go(w, d, d.d1)) return;
  if (d.d2 && d.d2 !== d.d1) go(w, d, d.d2);
  else if (d.d1) d.fc = d.d1;
}

// A ghost floats along the rim the way its hand pushes, read along the side
// it is on — or, at a corner, the side it has just come round.
function haunt(d) {
  for (const dir of [d.d1, d.d2]) {
    if (!dir) continue;
    const dx = DIRS[dir][0], dy = DIRS[dir][1];
    const along = (s) => dx * TAN[rimSide(s)][0] + dy * TAN[rimSide(s)][1];
    let k = along(d.gp);
    if (!k) k = along((d.gp + RIM - 1) % RIM);
    if (!k) continue;
    d.gp = (d.gp + k * GHOST_SPEED + RIM) % RIM;
    d.fc = dir;
    return;
  }
}

function plant(w, id) {
  const d = w.p[id];
  const x = Math.floor(d.x / U), y = Math.floor(d.y / U);
  if (w.g[y * GW + x] !== FLOOR || w.b.length >= MAX_BOMBS) return;
  let mine = 0;
  for (const b of w.b) {
    if (b[0] === x && b[1] === y) return;
    if (b[2] === id && b[7] < 0) mine += 1;
  }
  if (mine >= d.cap) return;
  w.bs = (w.bs + 1) % 1000000;
  w.b.push([x, y, id, FUSE, d.rg, 0, 0, -1, 0, w.bs]);
  fx(w, 'plant', y * GW + x, id);
}

// Where a bomb lobbed from a place on the rim lands: straight in from it, on
// the first open cell a little way into the maze.
function lobCell(w, s) {
  const side = rimSide(s), [px, py] = rimPoint(s);
  let x, y, dx, dy;
  if (side === 0) { x = clampi(Math.floor(px / U), 0, GW - 1); y = 0; dx = 0; dy = 1; }
  else if (side === 1) { x = GW - 1; y = clampi(Math.floor(py / U), 0, GH - 1); dx = -1; dy = 0; }
  else if (side === 2) { x = clampi(Math.floor(px / U), 0, GW - 1); y = GH - 1; dx = 0; dy = -1; }
  else { x = 0; y = clampi(Math.floor(py / U), 0, GH - 1); dx = 1; dy = 0; }
  for (let k = LOB_FROM; ; k++) {
    const cx = x + dx * k, cy = y + dy * k;
    if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) return -1;
    if (open(w, cx, cy) && w.fl[cy * GW + cx] === 0) return cy * GW + cx;
  }
}

function lob(w, id) {
  const d = w.p[id];
  if (d.gr > 0 || w.b.length >= MAX_BOMBS) return;
  const c = lobCell(w, d.gp);
  if (c < 0) return;
  w.bs = (w.bs + 1) % 1000000;
  w.b.push([c % GW, (c - (c % GW)) / GW, id, FUSE, GHOST_RANGE, 0, 0, d.gp, 0, w.bs]);
  d.gr = GHOST_RELOAD;
  fx(w, 'lob', c, id);
}

// A cell a kicked bomb may slide into.
function slideFree(w, x, y) {
  if (!open(w, x, y)) return false;
  for (const id of playersIn(w)) {
    const d = w.p[id];
    if (d.st === 0 && Math.floor(d.x / U) === x && Math.floor(d.y / U) === y) return false;
  }
  return true;
}

function kick(w, x, y, dir) {
  const b = w.b.find((o) => o[0] === x && o[1] === y && o[5] === 0);
  if (!b || !slideFree(w, x + DIRS[dir][0], y + DIRS[dir][1])) return;
  b[5] = dir;
  b[6] = 0;
  fx(w, 'kick', y * GW + x, b[2]);
}

// Kicked bombs slide a cell in three steps, and stop at the first thing in
// the way.
function slide(w) {
  for (const b of w.b) {
    if (!b[5]) continue;
    const dx = DIRS[b[5]][0], dy = DIRS[b[5]][1];
    if (b[6] === 0 && !slideFree(w, b[0] + dx, b[1] + dy)) {
      b[5] = 0;
      fx(w, 'thunk', b[1] * GW + b[0]);
      continue;
    }
    b[6] += SLIDE;
    if (b[6] >= U) { b[0] += dx; b[1] += dy; b[6] = 0; }
  }
}

function flame(w, c, owner) {
  w.fl[c] = FLAME;
  w.fo[c] = owner;
}

// Fuses burn down, and every bomb whose fuse is out, or that fire has
// reached, goes off — one at a time, in the order they lie, so a chain runs
// the same way on every copy.
function burn(w) {
  for (const b of w.b) {
    b[3] -= 1;
    if (b[8] < 99) b[8] += 1;
  }
  // A crate burnt this step shows what it hid, and this step's blasts leave
  // that be: it is there to be picked up.
  const shown = new Set();
  for (let guard = 0; guard < MAX_BOMBS + 1; guard++) {
    const i = w.b.findIndex((b) => b[3] <= 0 || w.fl[b[1] * GW + b[0]] > 0);
    if (i < 0) break;
    const b = w.b.splice(i, 1)[0];
    blast(w, b, shown);
  }
}

function blast(w, b, shown) {
  const bx = b[0], by = b[1], owner = b[2], range = b[4];
  flame(w, by * GW + bx, owner);
  fx(w, 'boom', by * GW + bx, owner, range);
  for (let k = 1; k <= 4; k++) {
    for (let r = 1; r <= range; r++) {
      const x = bx + DIRS[k][0] * r, y = by + DIRS[k][1] * r;
      if (x < 0 || y < 0 || x >= GW || y >= GH) break;
      const c = y * GW + x, g = w.g[c];
      if (g === PILLAR || g === HEDGE) break;
      if (g === CRATE) {
        w.g[c] = FLOOR;
        shown.add(c);
        flame(w, c, owner);
        fx(w, 'crate', c, w.it[c]);
        break;
      }
      flame(w, c, owner);
      if (w.b.some((o) => o[0] === x && o[1] === y)) break;
      if (w.it[c] >= 0 && !shown.has(c)) {
        w.it[c] = -1;
        fx(w, 'singe', c);
        break;
      }
    }
  }
}

// Somebody caught. A ghost whose bomb did it — one who has not come back yet
// this round — walks back into the maze where they fell, shielded a moment,
// with nothing picked up; and they take the rim in its place.
function catchOut(w, id, by) {
  const d = w.p[id];
  const c = cellOf(d);
  toGhost(w, id);
  fx(w, 'out', c, id, by === null ? 0 : by);
  if (by === null || by === id) return;
  const k = w.p[by];
  if (!k) return;
  k.kl += 1;
  if (k.st !== 1 || (w.ph !== WAIT && k.rv >= 1)) return;
  k.st = 0;
  k.x = (c % GW) * U + HALF;
  k.y = Math.floor(c / GW) * U + HALF;
  k.fc = 3;
  basePowers(k);
  k.sh = SHIELD;
  k.rv += 1;
  k.gt = k.bq = 0;
  k.bt = -1;
  fx(w, 'revive', c, by, id);
}

// Practice: crates grow back now and then on open floor nobody stands near,
// so there is always something to blow up.
function regrow(w) {
  if (--w.gw > 0) return;
  w.gw = REGROW;
  let crates = 0;
  for (let c = 0; c < NC; c++) if (w.g[c] === CRATE) crates += 1;
  if (crates >= PRACTICE_CRATES) return;
  for (let t = 0; t < 12; t++) {
    const c = Math.floor(draw01(w) * NC);
    if (w.g[c] !== FLOOR || w.it[c] >= 0 || w.fl[c] > 0 || ZONED.has(c)) continue;
    const x = c % GW, y = (c - x) / GW;
    if (w.b.some((b) => Math.abs(b[0] - x) + Math.abs(b[1] - y) <= 1)) continue;
    let near = false;
    for (const id of playersIn(w)) {
      const d = w.p[id];
      if (d.st === 0 && Math.abs(Math.floor(d.x / U) - x) + Math.abs(Math.floor(d.y / U) - y) <= 1) near = true;
    }
    if (near) continue;
    w.g[c] = CRATE;
    w.it[c] = hiddenItem(w);
    fx(w, 'grow', c);
    return;
  }
}

// The last stretch of a round: the hedge closes in a cell at a time from the
// outside. Whatever stands in a cell as it closes is gone; a player there is
// out, and nobody's bomb did it.
function hedge(w) {
  if (w.pt > HEDGE_AT || w.hi >= SPIRAL.length || (HEDGE_AT - w.pt) % HEDGE_EVERY) return;
  const c = SPIRAL[w.hi];
  w.hi += 1;
  const x = c % GW, y = (c - x) / GW;
  w.g[c] = HEDGE;
  w.it[c] = -1;
  w.fl[c] = 0;
  w.b = w.b.filter((b) => b[0] !== x || b[1] !== y);
  for (const b of w.b) {
    if (b[5] && b[0] + DIRS[b[5]][0] === x && b[1] + DIRS[b[5]][1] === y) { b[5] = 0; b[6] = 0; }
  }
  fx(w, 'hedge', c);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d.st === 0 && cellOf(d) === c) catchOut(w, id, null);
  }
}

// A maze handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.bs, 0, 999999) || !int(raw.hi, 0, SPIRAL.length) || !int(raw.gw, 0, REGROW)) return null;
  const cells = (a, ok) => Array.isArray(a) && a.length === NC && a.every(ok);
  if (!cells(raw.g, (v, c) => (pillarAt(c % GW, Math.floor(c / GW)) ? v === PILLAR : v === FLOOR || v === CRATE || v === HEDGE))) return null;
  if (!cells(raw.it, (v) => int(v, -1, 3)) || !cells(raw.fl, (v) => int(v, 0, FLAME)) || !cells(raw.fo, (v) => int(v, -BIG, BIG))) return null;
  if (!Array.isArray(raw.b) || raw.b.length > MAX_BOMBS) return null;
  const b = [];
  for (const o of raw.b) {
    if (!Array.isArray(o) || o.length !== 10) return null;
    if (!int(o[0], 0, GW - 1) || !int(o[1], 0, GH - 1) || !int(o[2], -BIG, BIG) || !int(o[3], 1, FUSE)) return null;
    if (!int(o[4], 1, RANGE_MAX) || !int(o[5], 0, 4) || !int(o[6], 0, U - 1) || !int(o[7], -1, RIM - 1)) return null;
    if (!int(o[8], 0, 99) || !int(o[9], 0, 999999)) return null;
    b.push(o.slice());
  }
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, 0, 1) || !int(d.x, 0, GW * U - 1) || !int(d.y, 0, GH * U - 1) || !int(d.fc, 0, 4)) return null;
    if (inputOf([d.d1, d.d2, d.q]) === null || !int(d.bq, 0, 1)) return null;
    if (!int(d.cap, 1, BOMBS_MAX) || !int(d.rg, 1, RANGE_MAX) || !int(d.sp, SPEED0, SPEED_MAX) || !int(d.kk, 0, 1)) return null;
    if (!int(d.sh, 0, SHIELD) || !int(d.gp, 0, RIM - 1) || !int(d.gr, 0, GHOST_RELOAD) || !int(d.gt, 0, PRACTICE_GHOST)) return null;
    if (!int(d.rv, 0, BIG) || !int(d.bt, -1, NC - 1) || !int(d.bw, 0, 99)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG) || !int(d.wn, 0, 99999) || !int(d.kl, 0, 99999)) return null;
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
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, g: raw.g.slice(), it: raw.it.slice(), fl: raw.fl.slice(),
    fo: raw.fo.slice(), b, bs: raw.bs, hi: raw.hi, gw: raw.gw, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed maze steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, c, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, c: c || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a garden at dusk. Warm sand paths, grey stone posts, wooden
// crates, a dark green hedge, and a bright colour for each player that is
// their body's, their ghost's and the band round their bombs.
const INK = {
  page: '#1c1a33', glow: '#2e2a55', rim: '#14122a', rimEdge: '#3a3566', track: 'rgba(255,255,255,0.10)',
  sandA: '#ead7a8', sandB: '#e2cc9a', sandShade: 'rgba(90,60,25,0.16)',
  stone: '#6b7390', stoneTop: '#9099b8', stoneDark: '#474c66',
  crate: '#c78a49', crateTop: '#dca56a', crateDark: '#8a582b',
  hedge: '#2f7a4f', hedgeTop: '#46a16a', hedgeDark: '#1d5536',
  bomb: '#26243c', bombHi: '#6a6890',
  flameOut: '#ff6a3d', flameMid: '#ffb63f', flameCore: '#fff5c4',
  text: '#ffffff', muted: '#cbc6ea', dim: '#8e89b6', gold: '#ffd166', danger: '#ff5a6e',
  panel: 'rgba(18,16,38,0.93)',
};
const SEAT = ['#ff4f7b', '#3fa9ff', '#b072ff', '#ff9a2e', '#21c8a5', '#f2f2ff', '#ff5ad8', '#93d63f'];
const ITEM_INK = ['#ff7b3a', '#5059a8', '#25b39b', '#cf4fcf'];
const ITEM_WORD = ['+fire', '+bomb', '+speed', 'kick!'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a4580;' +
  `background:#25224a;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, cs = 24, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
  // NOTE_ROOM under the maze keeps the practice note off its bottom row, where
  // two of the starts are; in a round the same strip carries your power-ups.
  const aw = VW - 12, ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  cs = Math.max(6, Math.min(aw / (GW + 2), ah / (GH + 2)));
  ox = (VW - cs * (GW + 2)) / 2;
  oy = TOP + (ah - cs * (GH + 2)) / 2;
}
layout();
window.addEventListener('resize', layout);

// Maze units to the screen: the rim is the cell-wide lane round the maze.
const PX = (u) => ox + (u / U + 1) * cs + shakeX;
const PY = (v) => oy + (v / U + 1) * cs + shakeY;
const midX = (c) => (c % GW) * U + HALF;
const midY = (c) => Math.floor(c / GW) * U + HALF;
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
  boom(near) {
    if (!ready('boom', 50)) return;
    const v = 0.08 + 0.22 * near;
    puff(0.45, v, 180, 0, 0.7);
    puff(0.25, v * 0.6, 900, 0, 0.9);
    tone(90, 0.35, 'sine', v * 0.8, 0.4);
  },
  crack() { if (ready('crack', 40)) { puff(0.08, 0.07, 1600, 0, 2); tone(260, 0.06, 'square', 0.03, 0.6); } },
  plant() { if (ready('plant', 50)) { tone(520, 0.05, 'square', 0.05, 0.7); tone(180, 0.08, 'sine', 0.1, 0.6); } },
  fizz() { if (ready('fizz', 60)) puff(0.18, 0.04, 4200, 0, 3); },
  lob() { if (ready('lob', 80)) tone(300, 0.28, 'triangle', 0.08, 2.4); },
  kick() { if (ready('kick', 60)) { tone(140, 0.08, 'sine', 0.16, 0.6); puff(0.05, 0.06, 500); } },
  pick() {
    if (!ready('pick', 60)) return;
    tone(740, 0.08, 'triangle', 0.11);
    tone(1110, 0.12, 'triangle', 0.1, 0, 0.06);
  },
  out(me) {
    if (!ready('out', 80)) return;
    if (me) { tone(520, 0.5, 'sawtooth', 0.07, 0.3); tone(260, 0.5, 'triangle', 0.08, 0.4, 0.05); }
    else tone(440, 0.25, 'triangle', 0.08, 0.5);
  },
  revive() { if (ready('revive', 200)) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.14, 'triangle', 0.09, 0, i * 0.06)); },
  hedge() { if (ready('hedge', 70)) { puff(0.12, 0.05, 700, 0, 1); tone(110, 0.1, 'sine', 0.07, 0.7); } },
  warn() { if (ready('warn', 400)) [392, 370, 349].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.04, 1, i * 0.18)); },
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
// fast screen and a slow one see the same smoke. Positions are maze units.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, kind }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, kind) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 18 + Math.random() * 22, size, colour, kind: kind || 0 });
  }
  if (bits.length > 600) bits.splice(0, bits.length - 600);
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 55, px: px || 15 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.9; b.vy *= 0.9;
      if (b.kind === 2) b.vy -= 4;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    shake *= 0.85;
    if (shake < 0.2) shake = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();      // id -> { walk, squash, seen }
const closedAt = new Map();   // cell -> when the hedge closed over it, for its drop
let drawFailed = false;

function colourOf(t, id) {
  const d = t.p[id];
  return d ? SEAT[d.c] : '#dddddd';
}

// Where somebody stands as drawn: between two steps, and never slid across a
// jump — a player brought back, or one who has just become a ghost.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > U) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}
function rimAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st) return [z.gp, z];
  let diff = z.gp - a.gp;
  if (diff > RIM / 2) diff -= RIM;
  if (diff < -RIM / 2) diff += RIM;
  return [(a.gp + diff * b.k + RIM) % RIM, z];
}
function rimXY(s) {
  const f = Math.floor(s), k = s - f;
  const a = rimPoint(f % RIM), c = rimPoint((f + 1) % RIM);
  return [lerp(a[0], c[0], k), lerp(a[1], c[1], k)];
}

function play(e, t) {
  const me = myId();
  const x = midX(e.c), y = midY(e.c);
  const md = t.p[me];
  const near = md && md.st === 0 ? Math.max(0, 1 - (Math.abs(md.x - x) + Math.abs(md.y - y)) / (6 * U)) : 0.15;
  if (e.kind === 'boom') {
    spray(x, y, 16, INK.flameMid, 9 * U, 0.12 * U, 1);
    spray(x, y, 10, 'rgba(90,80,110,0.55)', 4 * U, 0.2 * U, 2);
    ring(x, y, INK.flameCore, (e.b + 0.5) * U);
    shake = Math.max(shake, 3 + 9 * near);
    sound.boom(near);
  } else if (e.kind === 'crate') {
    spray(x, y, 12, INK.crateDark, 6 * U, 0.09 * U);
    spray(x, y, 6, INK.crateTop, 5 * U, 0.07 * U);
    sound.crack();
  } else if (e.kind === 'singe') {
    spray(x, y, 8, 'rgba(120,110,130,0.7)', 3 * U, 0.14 * U, 2);
  } else if (e.kind === 'out') {
    const colour = colourOf(t, e.a);
    spray(x, y, 26, colour, 7 * U, 0.1 * U);
    ring(x, y, colour, 1.2 * U);
    pop(x, y, e.a === me ? 'caught!' : 'out!', colour, 18);
    if (e.a === me) shake = Math.max(shake, 14);
    sound.out(e.a === me);
  } else if (e.kind === 'revive') {
    const colour = colourOf(t, e.a);
    ring(x, y, colour, 1.6 * U);
    spray(x, y, 20, colour, 6 * U, 0.08 * U, 1);
    pop(x, y, e.a === me ? 'you are back!' : 'back in!', colour, 18);
    sound.revive();
  } else if (e.kind === 'back') {
    ring(x, y, colourOf(t, e.a), 1.1 * U);
  } else if (e.kind === 'pick') {
    const colour = ITEM_INK[e.b] || INK.gold;
    ring(x, y, colour, 0.9 * U);
    pop(x, y, ITEM_WORD[e.b] || '+', colour, e.a === me ? 17 : 13);
    if (e.a === me) sound.pick();
  } else if (e.kind === 'plant') {
    if (e.a !== me) sound.plant();
  } else if (e.kind === 'lob') {
    if (e.a !== me) sound.lob();
  } else if (e.kind === 'kick') {
    spray(x, y, 6, '#ffffff', 3 * U, 0.06 * U);
    sound.kick();
  } else if (e.kind === 'thunk') {
    spray(x, y, 4, '#ffffff', 2 * U, 0.05 * U);
  } else if (e.kind === 'hedge') {
    closedAt.set(e.c, performance.now());
    spray(x, y, 8, INK.hedgeTop, 4 * U, 0.08 * U);
    sound.hedge();
  } else if (e.kind === 'hedgewarn') {
    pop(GW * U / 2, GH * U / 2, 'the hedge closes in!', INK.gold, 22);
    sound.warn();
  } else if (e.kind === 'grow') {
    spray(x, y, 6, INK.crateTop, 2 * U, 0.06 * U);
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'round') {
    closedAt.clear();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

function drawGround(now) {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  const x0 = PX(-U), y0 = PY(-U), w = cs * (GW + 2), h = cs * (GH + 2);
  ctx.fillStyle = INK.rim;
  roundRect(x0 - 3, y0 - 3, w + 6, h + 6, cs * 0.45);
  ctx.fill();
  ctx.strokeStyle = INK.rimEdge;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // The ghosts' lane: a dotted track round the maze.
  ctx.strokeStyle = INK.track;
  ctx.lineWidth = Math.max(1, cs * 0.06);
  ctx.setLineDash([cs * 0.12, cs * 0.3]);
  ctx.lineDashOffset = -now / 60;
  ctx.strokeRect(PX(-HALF), PY(-HALF), cs * (GW + 1), cs * (GH + 1));
  ctx.setLineDash([]);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      ctx.fillStyle = (x + y) % 2 ? INK.sandB : INK.sandA;
      ctx.fillRect(PX(x * U), PY(y * U), cs + 0.5, cs + 0.5);
    }
  }
}

function drawStone(sx, sy) {
  const s = cs;
  ctx.fillStyle = INK.sandShade;
  roundRect(sx + s * 0.08, sy + s * 0.14, s * 0.92, s * 0.92, s * 0.16);
  ctx.fill();
  ctx.fillStyle = INK.stoneDark;
  roundRect(sx + s * 0.04, sy + s * 0.06, s * 0.92, s * 0.9, s * 0.16);
  ctx.fill();
  ctx.fillStyle = INK.stone;
  roundRect(sx + s * 0.04, sy + s * 0.02, s * 0.92, s * 0.8, s * 0.16);
  ctx.fill();
  ctx.fillStyle = INK.stoneTop;
  roundRect(sx + s * 0.14, sy + s * 0.1, s * 0.72, s * 0.22, s * 0.1);
  ctx.fill();
}
function drawCrate(sx, sy) {
  const s = cs, p = s * 0.06;
  ctx.fillStyle = INK.sandShade;
  ctx.fillRect(sx + p + s * 0.05, sy + p + s * 0.1, s - 2 * p, s - 2 * p);
  ctx.fillStyle = INK.crateDark;
  roundRect(sx + p, sy + p, s - 2 * p, s - 2 * p, s * 0.08);
  ctx.fill();
  ctx.fillStyle = INK.crate;
  ctx.fillRect(sx + p + s * 0.1, sy + p + s * 0.1, s - 2 * p - s * 0.2, s - 2 * p - s * 0.2);
  ctx.strokeStyle = INK.crateDark;
  ctx.lineWidth = Math.max(1, s * 0.08);
  ctx.beginPath();
  ctx.moveTo(sx + p + s * 0.12, sy + s - p - s * 0.12);
  ctx.lineTo(sx + s - p - s * 0.12, sy + p + s * 0.12);
  ctx.stroke();
  ctx.fillStyle = INK.crateTop;
  ctx.fillRect(sx + p, sy + p, s - 2 * p, s * 0.07);
}
function drawHedge(sx, sy, k, c) {
  const s = cs, drop = (1 - ease(k)) * s * 1.2;
  ctx.globalAlpha = Math.min(1, k * 2);
  ctx.fillStyle = INK.hedgeDark;
  roundRect(sx + s * 0.02, sy + s * 0.04 - drop, s * 0.96, s * 0.96, s * 0.2);
  ctx.fill();
  ctx.fillStyle = INK.hedge;
  roundRect(sx + s * 0.02, sy - drop, s * 0.96, s * 0.84, s * 0.2);
  ctx.fill();
  ctx.fillStyle = INK.hedgeTop;
  for (let i = 0; i < 4; i++) {
    const a = (c * 7 + i * 3) % 10;
    disc(sx + s * (0.22 + 0.18 * i), sy - drop + s * (0.25 + (a % 3) * 0.14), s * 0.11);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawItem(c, it, now) {
  const s = cs, sx = PX((c % GW) * U), sy = PY(Math.floor(c / GW) * U);
  const bob = Math.sin(now / 260 + c) * s * 0.04;
  const x = sx + s / 2, y = sy + s / 2 + bob;
  ctx.fillStyle = INK.sandShade;
  ctx.beginPath(); ctx.ellipse(x, sy + s * 0.84, s * 0.3, s * 0.08, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = ITEM_INK[it];
  roundRect(x - s * 0.33, y - s * 0.36, s * 0.66, s * 0.66, s * 0.16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.stroke();
  itemGlyph(it, x, y - s * 0.03, s * 0.26);
}
function itemGlyph(it, x, y, r) {
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (it === FIRE) {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x + r * 0.95, y - r * 0.05, x + r * 0.55, y + r * 0.7);
    ctx.quadraticCurveTo(x, y + r * 1.05, x - r * 0.55, y + r * 0.7);
    ctx.quadraticCurveTo(x - r * 0.9, y + r * 0.1, x, y - r);
    ctx.fill();
    ctx.fillStyle = INK.flameMid;
    disc(x, y + r * 0.42, r * 0.32);
    ctx.fill();
  } else if (it === BOMB) {
    disc(x - r * 0.08, y + r * 0.15, r * 0.72);
    ctx.fill();
    ctx.lineWidth = r * 0.22;
    ctx.beginPath(); ctx.moveTo(x + r * 0.3, y - r * 0.38); ctx.lineTo(x + r * 0.7, y - r * 0.8); ctx.stroke();
  } else if (it === BOOTS) {
    ctx.lineWidth = r * 0.3;
    for (const o of [-0.4, 0.3]) {
      ctx.beginPath();
      ctx.moveTo(x + r * (o - 0.25), y - r * 0.6);
      ctx.lineTo(x + r * (o + 0.25), y);
      ctx.lineTo(x + r * (o - 0.25), y + r * 0.6);
      ctx.stroke();
    }
  } else {
    // A foot meeting a ball.
    ctx.lineWidth = r * 0.3;
    ctx.beginPath(); ctx.moveTo(x - r * 0.75, y - r * 0.7); ctx.lineTo(x - r * 0.75, y + r * 0.3); ctx.lineTo(x - r * 0.1, y + r * 0.3); ctx.stroke();
    disc(x + r * 0.5, y + r * 0.05, r * 0.42);
    ctx.fill();
  }
  ctx.lineCap = 'butt';
}

function drawMaze(t, now) {
  // The cells about to close glow a warning for the seconds before they do.
  const warn = new Set();
  if (t.ph === PLAY && t.pt <= HEDGE_AT + 2 * HZ) {
    for (let i = t.hi; i < Math.min(SPIRAL.length, t.hi + 4); i++) warn.add(SPIRAL[i]);
  }
  for (let c = 0; c < NC; c++) {
    const g = t.g[c];
    const sx = PX((c % GW) * U), sy = PY(Math.floor(c / GW) * U);
    if (g === PILLAR) drawStone(sx, sy);
    else if (g === CRATE) drawCrate(sx, sy);
    else if (g === HEDGE) {
      const at = closedAt.get(c);
      drawHedge(sx, sy, at === undefined ? 1 : Math.min(1, (now - at) / 260), c);
    } else {
      if (t.it[c] >= 0) drawItem(c, t.it[c], now);
      if (warn.has(c)) {
        ctx.fillStyle = `rgba(29,85,54,${(0.25 + 0.2 * Math.sin(now / 120)).toFixed(3)})`;
        roundRect(sx + 2, sy + 2, cs - 4, cs - 4, cs * 0.18);
        ctx.fill();
      }
    }
  }
}

function drawFlames(t, now) {
  const fl = t.fl;
  const on = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH && fl[y * GW + x] > 0;
  const layers = [[INK.flameOut, 0.86], [INK.flameMid, 0.62], [INK.flameCore, 0.34]];
  for (const [colour, wide] of layers) {
    ctx.fillStyle = colour;
    for (let c = 0; c < NC; c++) {
      if (fl[c] <= 0) continue;
      const x = c % GW, y = (c - x) / GW, k = fl[c] / FLAME;
      const flick = 1 + 0.08 * Math.sin(now / 35 + c * 1.7);
      const w = cs * wide * (0.55 + 0.45 * k) * flick;
      const sx = PX(x * U), sy = PY(y * U), mx = sx + cs / 2, my = sy + cs / 2;
      ctx.globalAlpha = Math.min(1, 0.35 + k);
      const l = on(x - 1, y) ? sx : mx - w / 2, r = on(x + 1, y) ? sx + cs : mx + w / 2;
      const u = on(x, y - 1) ? sy : my - w / 2, d = on(x, y + 1) ? sy + cs : my + w / 2;
      if (l < mx - w / 2 || r > mx + w / 2) ctx.fillRect(l, my - w / 2, r - l, w);
      if (u < my - w / 2 || d > my + w / 2) ctx.fillRect(mx - w / 2, u, w, d - u);
      disc(mx, my, w / 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// A bomb as drawn: slid between steps, and a lobbed one flying in from the rim.
function bombXY(b, prev, k) {
  const dx = DIRS[b[5]][0], dy = DIRS[b[5]][1];
  let x = b[0] * U + HALF + dx * b[6], y = b[1] * U + HALF + dy * b[6];
  if (prev) {
    const px = prev[0] * U + HALF + DIRS[prev[5]][0] * prev[6], py = prev[1] * U + HALF + DIRS[prev[5]][1] * prev[6];
    if (Math.abs(px - x) + Math.abs(py - y) <= U) { x = lerp(px, x, k); y = lerp(py, y, k); }
  }
  return [x, y];
}

function drawBomb(t, b, prev, k, now) {
  let [x, y] = bombXY(b, prev, k);
  let lift = 0;
  const age = b[8] - 1 + k;
  if (b[7] >= 0 && age < LOB_STEPS) {
    const f = Math.max(0, age / LOB_STEPS);
    const [rx, ry] = rimPoint(b[7]);
    x = lerp(rx, x, f);
    y = lerp(ry, y, f);
    lift = Math.sin(f * Math.PI) * U * 1.6;
  }
  const sx = PX(x), sy = PY(y), r = cs * 0.34;
  const fuse = Math.max(0, b[3] - k);
  const beat = 1 + 0.08 * Math.sin(now / (40 + fuse * 4));
  ctx.fillStyle = 'rgba(40,25,10,0.25)';
  ctx.beginPath(); ctx.ellipse(sx, sy + r * 0.85, r * 0.9, r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  const cy = sy - lift / U * cs;
  ctx.fillStyle = INK.bomb;
  disc(sx, cy, r * beat);
  ctx.fill();
  ctx.strokeStyle = colourOf(t, b[2]);
  ctx.lineWidth = Math.max(1.5, cs * 0.08);
  disc(sx, cy, r * beat * 0.82);
  ctx.stroke();
  ctx.fillStyle = INK.bombHi;
  disc(sx - r * 0.35, cy - r * 0.35, r * 0.22);
  ctx.fill();
  // The fuse, and its spark, which flares as it runs down.
  ctx.strokeStyle = '#7b6a55';
  ctx.lineWidth = Math.max(1, cs * 0.06);
  ctx.beginPath();
  ctx.moveTo(sx + r * 0.45, cy - r * 0.75);
  ctx.quadraticCurveTo(sx + r * 0.7, cy - r * 1.3, sx + r * 1.0, cy - r * 1.15);
  ctx.stroke();
  const spark = r * (0.22 + 0.18 * Math.random() + 0.25 * (1 - fuse / FUSE));
  ctx.fillStyle = Math.random() < 0.5 ? INK.flameCore : INK.flameMid;
  disc(sx + r * 1.0, cy - r * 1.15, spark);
  ctx.fill();
  if (fuse < FUSE * 0.3 && Math.floor(now / 90) % 2) {
    ctx.fillStyle = 'rgba(255,90,60,0.35)';
    disc(sx, cy, r * beat);
    ctx.fill();
  }
}

function drawBody(id, x, y, d, colour, me, now) {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { walk: 0, x, y, seen: now }));
  const moved = Math.abs(x - look.x) + Math.abs(y - look.y);
  look.walk += moved / U * 7;
  look.x = x; look.y = y; look.seen = now;
  const sx = PX(x), sy = PY(y), r = cs * 0.36;
  const step = moved > 0.5 ? Math.sin(look.walk) : 0;
  if (d.sh > 0 && Math.floor(now / 80) % 2) ctx.globalAlpha = 0.45;
  ctx.fillStyle = 'rgba(40,25,10,0.28)';
  ctx.beginPath(); ctx.ellipse(sx, sy + r * 0.95, r * 0.9, r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = darker(colour, 0.45);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(sx + side * r * 0.45, sy + r * 0.82 - (side * step > 0 ? r * 0.18 : 0), r * 0.3, r * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const by = sy - Math.abs(step) * r * 0.12;
  ctx.fillStyle = darker(colour, 0.35);
  disc(sx, by + r * 0.06, r);
  ctx.fill();
  ctx.fillStyle = colour;
  disc(sx, by, r);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  disc(sx - r * 0.35, by - r * 0.4, r * 0.25);
  ctx.fill();
  // Eyes look the way the player faces.
  const [fx_, fy_] = DIRS[d.fc] || [0, 1];
  for (const side of [-1, 1]) {
    const ex = sx + (fy_ ? side * r * 0.32 : fx_ * r * 0.35 + side * r * 0.16), ey = by - r * 0.1 + fy_ * r * 0.18;
    ctx.fillStyle = '#ffffff';
    disc(ex, ey, r * 0.2);
    ctx.fill();
    ctx.fillStyle = '#1c1a33';
    disc(ex + fx_ * r * 0.08, ey + fy_ * r * 0.08, r * 0.1);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (d.sh > 0) {
    ctx.strokeStyle = alpha('#ffffff', 0.5 + 0.3 * Math.sin(now / 70));
    ctx.lineWidth = 2;
    disc(sx, by, r * 1.35);
    ctx.stroke();
  }
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    disc(sx, by, r + 1.5);
    ctx.stroke();
  }
  const px = Math.max(9, Math.min(13, cs * 0.42));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(20,18,40,0.7)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  ctx.strokeText(label, sx, by - r - 4);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, sx, by - r - 4);
}

function drawGhost(id, s, d, colour, me, now) {
  const [x, y] = rimXY(s);
  const sx = PX(x), sy = PY(y) + Math.sin(now / 300 + id) * cs * 0.06, r = cs * 0.34;
  ctx.globalAlpha = me ? 0.92 : 0.72;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(sx, sy - r * 0.15, r, Math.PI, 0);
  const waves = 3;
  ctx.lineTo(sx + r, sy + r * 0.75);
  for (let i = 0; i < waves; i++) {
    const x0 = sx + r - (2 * r * (i + 0.5)) / waves;
    const lift = Math.sin(now / 120 + i) * r * 0.1;
    ctx.quadraticCurveTo(x0, sy + r * 0.35 + lift, sx + r - (2 * r * (i + 1)) / waves, sy + r * 0.75);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  const [fx_, fy_] = DIRS[d.fc] || [0, 0];
  for (const side of [-1, 1]) {
    disc(sx + side * r * 0.32 + fx_ * r * 0.1, sy - r * 0.2 + fy_ * r * 0.1, r * 0.2);
    ctx.fill();
  }
  ctx.fillStyle = '#1c1a33';
  for (const side of [-1, 1]) {
    disc(sx + side * r * 0.32 + fx_ * r * 0.17, sy - r * 0.2 + fy_ * r * 0.17, r * 0.1);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (me) {
    // Your ghost wears a ring that fills while the next lob gets ready.
    const k = 1 - d.gr / GHOST_RELOAD;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    disc(sx, sy, r * 1.45);
    ctx.stroke();
    ctx.strokeStyle = k >= 1 ? '#ffffff' : colour;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 1.45, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
    ctx.stroke();
  }
}

function drawBits() {
  flat();
  for (const b of bits) {
    const k = b.life / b.max;
    ctx.globalAlpha = (1 - k) * (b.kind === 2 ? 0.6 : 1);
    ctx.fillStyle = b.colour;
    const r = (b.size / U) * cs * (b.kind === 2 ? 0.6 + k * 1.4 : 1 - k * 0.5);
    disc(PX(b.x), PY(b.y), r);
    ctx.fill();
  }
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = (1 - k) * 0.7;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - k) + 1;
    disc(PX(r.x), PY(r.y), (r.r / U) * cs * ease(k));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const k = p.life / p.max;
    const rise = 10 + ease(k) * 26;
    const scale = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, k - 0.15);
    ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    ctx.font = font(p.px * scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(20,18,40,0.8)';
    const X = PX(p.x), Y = PY(p.y) - rise;
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
    let alive = 0;
    for (const id of playersIn(t)) if (t.p[id].st === 0) alive += 1;
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' · ' + alive + ' standing';
    if (t.pt <= HEDGE_AT) colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('fuse', 12, 22, titlePx, INK.flameMid, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('fuse').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with rounds won; a
  // ghost's chip is hollow.
  const ids = bySeat(t);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(140, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      disc(x + 11, y - 2, 5);
      if (d.st === 0) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      const score = d.wn ? '★' + d.wn : '';
      ctx.font = font(12);
      const sw = score ? ctx.measureText(score).width : 0;
      if (score) text(score, x + cw - 8, y + 3, 12, INK.gold, 'right');
      if (cw > 46) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st === 0 ? (mine ? INK.text : INK.muted) : INK.dim, cw - 30 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to walk · tap to drop a bomb · as a ghost, tap to lob one in'
    : 'arrows/WASD walk · space drops a bomb · as a ghost, space lobs one in · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// Your power-ups, or what a ghost can do, in the strip under the maze while a
// round is on.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = PY(GH * U + U) + 3 + NOTE_ROOM / 2 - 6 - shakeY;
  if (d.st === 1) {
    const line = t.ph === PLAY && d.rv >= 1
      ? 'out again · lob bombs in to get even'
      : 'you haunt the rim · lob a bomb in · catch somebody and you take their place';
    fitText(line, VW / 2, y + 5, 13, INK.muted, VW - 24);
    return;
  }
  const items = [[BOMB, '×' + d.cap], [FIRE, '×' + d.rg], [BOOTS, '×' + (1 + (d.sp - SPEED0) / SPEED_UP)]];
  if (d.kk) items.push([KICK, '']);
  const w = 54, total = items.length * w;
  let x = VW / 2 - total / 2;
  for (const [it, label] of items) {
    ctx.fillStyle = ITEM_INK[it];
    roundRect(x + 2, y - 10, 20, 20, 6);
    ctx.fill();
    itemGlyph(it, x + 12, y - 0.5, 7);
    if (label) text(label, x + 26, y + 5, 13, INK.text, 'left');
    x += w;
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

// Practice ends a moment after a second player arrives: who it was, as this
// page sees it — the room lists its players in the order they came.
function joinHead(t, left) {
  const me = myId();
  const order = (id) => { const i = room.players.findIndex((p) => p.id === id); return i < 0 ? 1e9 : i; };
  const hs = humans(t).sort((a, b) => order(a) - order(b));
  const last = hs[hs.length - 1];
  return (last === me ? 'you joined ' + nickOf(hs[0]) : nickOf(last) + ' joined') + ' · practice ends in ' + left;
}

function panel(cx, cy, w, h) {
  ctx.fillStyle = INK.panel;
  roundRect(cx - w / 2, cy - h / 2, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawOverlay(t, now) {
  flat();
  const top = PY(-U) - shakeY, bottom = PY(GH * U + U) - shakeY;
  const cx = VW / 2, cy = (top + bottom) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'blast crates for power-ups · caught, you haunt the rim and lob bombs back in';
    practiceNote(now, VW, head, tip, [[TOP, top - 4], [bottom + 4, VH - BOT]], Math.min(bottom, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,18,40,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, cy + big);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, cy + big * 2.1, Math.min(VW - 32, 300), 30);
    fitText('last one standing takes the round', cx, cy + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 280));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,18,40,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('go!', cx, cy + big * 0.5);
    text('go!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, cy + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody left alone';
    else head = t.win === me ? 'you win the round!' : nickOf(t.win) + ' wins the round';
    const y0 = cy + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('rounds', cx + w / 2 - 70, y0 + 52, 10, INK.dim, 'right');
    text('caught', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, won, wins, caught], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (won ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 150, 'left');
      text(String(wins), cx + w / 2 - 70, y, 14, INK.gold, 'right');
      text(String(caught), cx + w / 2 - 18, y, 14, INK.text, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Your own player is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a turn a step away from
// where the guess had it. So the player drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a player brought back — puts it there at once. Only the
// drawing is smoothed: the maze, and every rule in it, are untouched.
const PULL = 0.45;
let shown = null;        // [x, y] in units: where your player is drawn
let shownRim = null;     // the same for your ghost, as a place on the rim
let myPos = null;        // [x, y] in units, for the mouse to steer from

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > U * 0.9) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}
function settleRim(s) {
  if (shownRim === null) return (shownRim = s);
  let diff = s - shownRim;
  if (diff > RIM / 2) diff -= RIM;
  if (diff < -RIM / 2) diff += RIM;
  if (Math.abs(diff) > U * 2) return (shownRim = s);
  shownRim = (shownRim + diff * per60(PULL) + RIM) % RIM;
  return shownRim;
}

function draw(now) {
  const b = agreedAt(now);
  drawGround(now);
  if (!b) {
    flat();
    const cx = VW / 2, cy = VH / 2;
    panel(cx, cy, Math.min(VW - 32, 300), 60);
    text('catching up with the maze…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a maze this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  drawMaze(t, now);
  drawFlames(t, now);
  const me = myId();
  const m = mineAt(now);
  const prev = new Map();
  for (const o of b.from.b) prev.set(o[9], o);
  for (const o of t.b) drawBomb(t, o, prev.get(o[9]), b.k, now);
  // A bomb of your own shows the moment you drop it, from the guess.
  if (m && m.to !== t) {
    const taken = new Set(t.b.map((o) => o[1] * GW + o[0]));
    for (const o of m.to.b) if (o[2] === me && o[8] <= 4 && !taken.has(o[1] * GW + o[0])) drawBomb(t, o, null, 0, now);
  }
  const bodies = [], ghosts = [];
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st === 0) {
      const p = bodyAt(b, id);
      bodies.push([p[1], () => drawBody(id, p[0], p[1], p[2], SEAT[d.c], false, now)]);
    } else {
      const r = rimAt(b, id);
      ghosts.push(() => drawGhost(id, r[0], r[1], SEAT[d.c], false, now));
    }
  }
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own) {
    const d = own.to.p[me];
    if (d.st === 0) {
      const p = bodyAt(own, me);
      const [x, y] = settle(p[0], p[1]);
      shownRim = null;
      myPos = [x, y];
      bodies.push([y, () => drawBody(me, x, y, d, SEAT[d.c], true, now)]);
    } else {
      const r = rimAt(own, me);
      const s = settleRim(r[0]);
      shown = null;
      myPos = rimXY(s);
      ghosts.push(() => drawGhost(me, s, d, SEAT[d.c], true, now));
    }
  } else myPos = shown = shownRim = null;
  bodies.sort((p, q) => p[0] - q[0]);
  for (const [, f] of bodies) f();
  for (const f of ghosts) f();
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way pushed, the way to try when that one is walled
// — a thumb pushed between two lanes takes whichever opens first — and how
// many bombs so far. A change goes out at once, but no oftener than
// TURN_EVERY while it keeps changing, because a thumb wobbling round a corner
// changes it on every move the screen reports and the clock's ticks share the
// same seat's ceiling on messages.
const TURN_EVERY = 50;
let wanted = [0, 0];
let lastSaid = null;
let saidAt = -1e9;
let bombs = 0;

function push(d1, d2) {
  wanted = [d1, d2];
  sayHand(performance.now());
}
function sayHand(now) {
  if (lastSaid && wanted[0] === lastSaid[0] && wanted[1] === lastSaid[1]) return;
  if (now - saidAt < TURN_EVERY) return;
  lastSaid = wanted;
  saidAt = now;
  setHand([wanted[0], wanted[1], bombs]);
}

// The two ways a push leans: the stronger, and the other when it leans that
// way too.
function dirsOf(dx, dy) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < 1e-6 && ay < 1e-6) return [0, 0];
  const h = dx > 0 ? 2 : 4, v = dy > 0 ? 3 : 1;
  if (ax >= ay) return [h, ay > ax * 0.3 ? v : 0];
  return [v, ax > ay * 0.3 ? h : 0];
}

// A bomb: dropped in the maze, lobbed in from the rim. It is heard at once,
// and the maze carries it out a trip later on every copy alike.
function bomb() {
  wake();
  if (!world) return;
  bombs = (bombs + 1) % 1000;
  lastSaid = wanted;
  saidAt = performance.now();
  setHand([wanted[0], wanted[1], bombs]);
  const d = world.p[myId()];
  if (d && d.st === 1) sound.lob();
  else sound.plant();
}

// Keys are read by where they sit, not what they type, so every layout runs.
// The key pressed last leads, and another held across it is the way to try
// when that one is walled.
const KEY_DIR = { ArrowUp: 1, KeyW: 1, ArrowRight: 2, KeyD: 2, ArrowDown: 3, KeyS: 3, ArrowLeft: 4, KeyA: 4 };
const held = [];
function fromKeys() {
  if (!held.length) return [0, 0];
  const d1 = KEY_DIR[held[held.length - 1]];
  for (let i = held.length - 2; i >= 0; i--) {
    const d = KEY_DIR[held[i]];
    if (d % 2 !== d1 % 2) return [d1, d];
  }
  return [d1, 0];
}
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'KeyE' || e.code === 'Enter' || e.code === 'KeyX') {
    e.preventDefault();
    if (!e.repeat) bomb();
    return;
  }
  if (!(e.code in KEY_DIR)) return;
  e.preventDefault();
  coarse = false;
  if (!held.includes(e.code)) held.push(e.code);
  if (!stick && !mouse) push(...fromKeys());
});
addEventListener('keyup', (e) => {
  const i = held.indexOf(e.code);
  if (i >= 0) held.splice(i, 1);
  if (!stick && !mouse) push(...fromKeys());
});
addEventListener('blur', () => { held.length = 0; dropStick(); mouse = null; push(0, 0); });

// A thumb: a stick from wherever it lands, and a tap drops a bomb — a drag
// rather than a press, because iOS keeps a long press inside a frame for
// itself. A second finger down while the first walks drops one too.
// A mouse: hold the button and your player walks toward the pointer; a click,
// or the right button, drops a bomb.
const DEAD = 9;
const REACHOUT = 46;
let stick = null;
let mouse = null;

function dropStick() {
  stick = null;
  paintStick(0, 0);
  if (!mouse) push(...fromKeys());
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    if (stick) { bomb(); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
    paintStick(0, 0);
    return;
  }
  coarse = false;
  if (e.button === 2) { bomb(); return; }
  if (e.button !== 0) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mouse = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    paintStick(dx, dy);
    const still = Math.hypot(dx, dy) < DEAD;
    if (!still) stick.moved = true;
    push(...(still ? [0, 0] : dirsOf(dx, dy)));
  } else if (mouse && e.pointerId === mouse.id) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (Math.hypot(mouse.x - mouse.ox, mouse.y - mouse.oy) > 6) mouse.moved = true;
  }
});
function lift(e) {
  if (stick && e.pointerId === stick.id) {
    const tap = !stick.moved && performance.now() - stick.at < 260;
    dropStick();
    if (tap) bomb();
  } else if (mouse && e.pointerId === mouse.id) {
    const click = !mouse.moved && performance.now() - mouse.at < 220;
    mouse = null;
    push(...fromKeys());
    if (click) bomb();
  }
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

const stickRing = document.createElement('div');
stickRing.style.cssText =
  `position:fixed;display:none;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
  `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;pointer-events:none;` +
  'border:1px solid rgba(255,255,255,0.35);background:rgba(255,255,255,0.06)';
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  'border-radius:50%;pointer-events:none;background:#ffffff;opacity:.55';
document.body.append(stickRing, knob);

function paintStick(dx, dy) {
  if (!stick) { stickRing.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(dx, dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
  stickRing.style.display = knob.style.display = 'block';
  stickRing.style.left = stick.ox + 'px';
  stickRing.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + dx * k + 'px';
  knob.style.top = stick.oy + dy * k + 'px';
}

// The mouse steers toward the pointer from where your player is drawn.
function steerToMouse() {
  if (!mouse || !myPos) return;
  const r = cv.getBoundingClientRect();
  const dx = mouse.x - r.left - PX(myPos[0]);
  const dy = mouse.y - r.top - PY(myPos[1]);
  // Stopped on arrival, and off again only once the pointer is clearly
  // away: one threshold for both makes a player that stops and starts on
  // every twitch of the hand.
  const far = Math.hypot(dx, dy);
  if (far < cs * 0.3) mouse.parked = true;
  else if (far > cs * 0.6) mouse.parked = false;
  if (mouse.parked) push(0, 0);
  else push(...dirsOf(dx, dy));
}

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  steerToMouse();
  sayHand(now);
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a player arrives in the maze.
function start() {
  setHand([0, 0, bombs]);
  lastSaid = [0, 0];
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
