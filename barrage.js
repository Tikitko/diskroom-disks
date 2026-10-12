/**
 * @disk     barrage
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Artillery where nobody waits a turn. Pull back to aim, let go to lob, and read the wind: every shell bites the island away, so the ground under a rival is a target too. The sea rises late in a round, and a sunk tank keeps bombing from a blimp.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/barrage.png
 */
// barrage.js — artillery on an island that gives way, where the room's order is
// the referee.
//
// Every copy holds the height of every column of the island, the sea's level,
// the wind, every shell in the air, every crate and every tank, and changes it
// only on what comes back round the room, so every copy applies the same hands
// in the same order and holds the same island. Nobody sends where a shell went,
// whom it hit or how much ground it took: a hand is the way a tank drives, the
// way its barrel points and how hard, and a counter that moves on by one for
// every shot; everything else is the same arithmetic on the same whole numbers
// on every machine. A page with a console open can aim its own tank perfectly,
// but it fires no faster than its reload and no harder than any other barrel.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own tank does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — the island is 96000 units across, a
// speed is units a step — and use nothing but `+ - * /`, comparisons,
// `Math.floor`, `Math.trunc`, `Math.min`, `Math.max`, `Math.abs`, `Math.sqrt`
// and `Math.imul`, whose results the language fixes to the last bit. Every
// product stays far inside the integers a double holds exactly. Trigonometry
// appears only in the drawing and in reading a key-held barrel, which are
// nobody's business but the screen's.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// The whole part of a square root. `Math.sqrt` is rounded correctly by the
// language's own definition, so this is the same number on every machine.
const isqrt = (n) => (n <= 0 ? 0 : Math.floor(Math.sqrt(n)));
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own tank a trip ahead, with your hand in it

// The world: x across, y down, the sky's top at 0 and the sea floor at H. The
// island is a row of columns, each the height of its ground's top.
const W = 96000, H = 60000;
const NC = 120, CW = 800, HALF_CW = 400;
const COAST_L = 14, COAST_R = 105;     // the first and last column of dry land
const SEA_BED = 58000;
const SEA0 = 52000;            // the sea's level as a round starts
const SEA_MIN = 25000;         // and the highest it climbs
const SEA_AT = 35 * HZ;        // steps into a round when it starts to climb
const SEA_RATE = 20;           // units a step it climbs by
const GROUND_TOP = 16000;      // no ground stands higher than this

// Shells. A barrel at full pull throws a shell far enough to cross the whole
// island; gravity and wind are what make that hard.
const G = 64;                  // units a step, a step
const VSHOT = 2600;            // a shell's speed at full pull
const SUB = 4;                 // a step of a shell is checked in this many pieces
const VCAP = 6000;             // the fastest a shell ever goes, either way
const SHELL_AGE = 400;         // steps before a shell lost in the sky is let go
const SHELLS_EACH = 3;         // a player's shells in the air at once, at most
const SHELLS_MAX = 40;
const BARREL = 1300, TURRET = 1000;
const MIN_PULL = 100;          // a pull weaker than this fires nothing
// Kinds of shell: a plain one, a big one, one of a spread of three, and a
// blimp's bomb. Each has a blast radius, the most it takes off a tank, how hard
// it throws one, and how deep a share of its radius it digs.
const PLAIN = 0, BIG = 1, TRIPLE = 2, BOMB = 3;
const KR = [2300, 3600, 1900, 1700];
const KD = [34, 52, 22, 18];
const KK = [520, 900, 380, 300];
const KC = [90, 100, 80, 75];
const SPREAD_C = 985, SPREAD_S = 174;  // a triple's outer shells, ten degrees off

// Tanks.
const TR = 1100;               // half a tank's width
const T_SPEED = 150;           // units a step on the flat
const CLIMB = 520;             // the steepest rise a tank drives up in one step
const TG = 60;                 // gravity on a tank thrown off the ground
const TV = 3000;               // the fastest a tank is ever thrown
const SAFE_FALL = 900;         // landing faster than this hurts
const HP0 = 100;
const RELOAD = 46;             // steps between two shots
const RELOAD_LAST = 30;        // the same for a tank making its last stand
const BOT_RELOAD = 70;         // the practice bot's, slower on purpose
const FIRE_GRACE = 6;          // a shot asked for a moment early still goes
const WIN_PTS = 40;            // the last tank afloat's bonus

// The sky: sunk tanks fly blimps along it and drop bombs.
const SKY_Y = 3500;
const BLIMP_V = 220;
const BOMB_RELOAD = 60;

// Wind and crates.
const WMAX = 12;               // units a step, a step, either way
const WIND_EVERY = 15 * HZ;
const CRATE_EVERY = 9 * HZ;
const CRATES_MAX = 2;
const CRATE_V = 110;
const CRATE_R = 600;
const HEAL = 35;

const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const NONE = -999999;
const BIG_N = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 100 * HZ;
const END_STEPS = 6 * HZ;
const BACK_STEPS = 2 * HZ;     // a practising tank that sank is back this soon
const FRESH_LAND = 40;         // under this many dry columns, practice lays a new island

const TANK = 0, SKY = 1, DOWN = 2;

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player, shell and crate is made by one function with its fields in
// one order.
//   sea: the sea's level; wd: the wind; wt: steps until it turns; ct: steps
//   until the next crate; sid: the next shell's number; outs: tanks lost this
//   round; h: every column's ground; sh: shells in the air; cr: crates; res:
//   the last round's [id, damage dealt, points, rounds won] rows; win: its winner
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, sea: SEA0, wd: 0, wt: WIND_EVERY, ct: CRATE_EVERY, sid: 0, outs: 0,
    h: [], sh: [], cr: [], p: {}, res: null, win: -1,
  };
  island(w);
  return w;
}

// A new island: a beach rising from either coast to a plateau, with hills and
// a hollow or two laid over it, each a parabola of whole numbers.
function island(w) {
  const h = [];
  for (let i = 0; i < NC; i++) {
    if (i < COAST_L || i > COAST_R) { h.push(SEA_BED); continue; }
    const edge = Math.min(i - COAST_L, COAST_R - i);
    h.push(SEA0 + 600 - Math.min(edge * 1100, 9600));
  }
  const humps = 4 + Math.floor(draw01(w) * 3);
  for (let k = 0; k < humps; k++) {
    const c = COAST_L + 6 + Math.floor(draw01(w) * (COAST_R - COAST_L - 12));
    const wd = 6 + Math.floor(draw01(w) * 11);
    const amp = k === 0 && draw01(w) < 0.5 ? -4000 : 3000 + Math.floor(draw01(w) * 10000);
    for (let i = c - wd + 1; i < c + wd; i++) {
      if (i < COAST_L || i > COAST_R) continue;
      const d = i - c;
      h[i] -= Math.trunc((amp * (wd * wd - d * d)) / (wd * wd));
    }
  }
  for (let i = 0; i < NC; i++) h[i] = clampI(h[i], GROUND_TOP, SEA_BED);
  w.h = h;
}

// The ground's top under a point across, walked straight between the middles
// of two columns.
function groundAt(h, x) {
  const fx = x - HALF_CW;
  const i = Math.floor(fx / CW);
  const t = fx - i * CW;
  const a = h[clampI(i, 0, NC - 1)], b = h[clampI(i + 1, 0, NC - 1)];
  return a + Math.trunc(((b - a) * t) / CW);
}

// A blast takes a round bite out of the ground: every column the circle
// reaches down from above is cut to the circle's bottom.
function carve(w, x, y, r) {
  const lo = Math.max(0, Math.floor((x - r) / CW)), hi = Math.min(NC - 1, Math.floor((x + r) / CW));
  for (let i = lo; i <= hi; i++) {
    const dx = i * CW + HALF_CW - x;
    if (dx * dx >= r * r) continue;
    const s = isqrt(r * r - dx * dx);
    if (y - s <= w.h[i]) w.h[i] = Math.min(SEA_BED, Math.max(w.h[i], y + s));
  }
}

const dryColumn = (w, i) => w.h[i] < w.sea - 1000;
function dryCount(w) {
  let n = 0;
  for (let i = 0; i < NC; i++) if (dryColumn(w, i)) n += 1;
  return n;
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'vx', 'vy', 'mv', 'ax', 'ay', 'q', 'fq', 'rl', 'hp', 'am', 'dm', 'pts', 'wn',
  'ot', 'lh', 'rt', 'bk', 'bx', 'bw', 'bm', 'hs', 'hc'];
//   c: colour; s: seat; st: a tank, a blimp, or sunk in practice and waiting;
//   x, y, vx, vy: where and how fast, in units — a tank's y is its treads; mv:
//   the way it drives; ax, ay: where its barrel points and how hard, a thousand
//   at full; q: the shot counter as last heard; fq: steps a shot asked for
//   still waits to go; rl: steps of reload left; hp: armour; am: the next
//   shell's kind; dm: damage dealt this round; pts: points; wn: rounds won; ot:
//   the order this tank sank in this round, -1 while afloat; lh: who hit it
//   last; rt: steps until a practising tank is back; bk, bx, bw, bm: the bot's
//   spread of aim, its target, a pause and a drive; hs, hc: hands this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const SHELL_FIELDS = ['i', 'x', 'y', 'vx', 'vy', 'o', 'k', 'a'];
//   i: its number; o: whose; k: its kind; a: its age in steps
function shell(v) {
  const s = {};
  for (const f of SHELL_FIELDS) s[f] = v[f];
  return s;
}
const CRATE_FIELDS = ['x', 'y', 'k', 'l'];
//   k: what is in it — armour, a big shell, a spread of three; l: landed
function crate(v) {
  const c = {};
  for (const f of CRATE_FIELDS) c[f] = v[f];
  return c;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

function newPlayer(w, q) {
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: SKY, x: W / 2, y: SKY_Y, vx: 0, vy: 0, mv: 0, ax: 600, ay: -600, q, fq: 0,
    rl: 0, hp: HP0, am: PLAIN, dm: 0, pts: 0, wn: 0, ot: -1, lh: NONE, rt: 0, bk: 0, bx: NONE, bw: 0, bm: 0, hs: w.n, hc: 0,
  });
}

// A tank set down on its treads, still, armoured and loaded, its barrel up
// toward the middle of the island.
function placeTank(w, d, x) {
  d.st = TANK;
  d.x = clampI(x, TR, W - TR);
  d.y = groundAt(w.h, d.x);
  d.vx = d.vy = d.mv = d.fq = d.rl = d.rt = 0;
  d.hp = HP0;
  d.ot = -1;
  d.lh = NONE;
  d.bw = d.bm = 0;
  d.bx = NONE;
  const toward = d.x < W / 2 ? 1 : -1;
  d.ax = 600 * toward;
  d.ay = -600;
}

// Where a seat starts a round: spread evenly along the dry land.
function startX(seat, n) {
  const a = (COAST_L + 4) * CW, b = (COAST_R - 3) * CW;
  return a + Math.trunc(((b - a) * (2 * seat + 1)) / (2 * Math.max(1, n)));
}

// Practice: a dry column as far from every other tank as there is, near the
// player's own start; -1 when the island has too little left.
function spawnX(w, id) {
  const d = w.p[id];
  const home = startX(d.s, MAX_P);
  let best = -1, score = -Infinity;
  for (let i = 2; i < NC - 2; i++) {
    if (!dryColumn(w, i) || !dryColumn(w, i - 1) || !dryColumn(w, i + 1)) continue;
    const x = i * CW + HALF_CW;
    let near = 30000;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o === id || e.st !== TANK) continue;
      near = Math.min(near, Math.abs(e.x - x));
    }
    const s = near - Math.trunc(Math.abs(x - home) / 4);
    if (s > score) { score = s; best = x; }
  }
  return best;
}

// Practice, from the top: a new island, and everybody back on it.
function freshIsland(w) {
  island(w);
  w.sh = [];
  w.cr = [];
  for (const id of bySeat(w)) placeTank(w, w.p[id], startX(w.p[id].s, MAX_P));
  fx(w, 'fresh', W / 2, SEA0 - 12000);
}

function respawn(w, id) {
  const x = spawnX(w, id);
  if (x < 0 || dryCount(w) < FRESH_LAND) { freshIsland(w); return; }
  const d = w.p[id];
  placeTank(w, d, x);
  fx(w, 'back', d.x, d.y, id);
}

// A hand, at its place in the room's order: [the way driven, the barrel across
// and down, the shot counter]. A shot is asked for once, when the counter
// changes; the same hand said again to keep a player at the table fires
// nothing. Being heard is how a player arrives: as a tank while the table waits
// for a round or counts one in, and in a blimp while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[3]);
    if (w.ph === WAIT) respawn(w, id);
    else if (w.ph === COUNT) placeTank(w, d, startX(d.s, playersIn(w).length));
    else { d.x = W / 2; d.y = SKY_Y; d.rl = BOMB_RELOAD; }
    d.mv = input[0];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; how often a barrel fires is the reload's to say, not the
  // hand's.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.mv = input[0];
  d.ax = input[1];
  d.ay = input[2];
  if (input[3] !== d.q) { d.q = input[3]; d.fq = FIRE_GRACE; }
}

// A hand off the wire, made safe: four integers in their ranges, or nothing.
// How hard a barrel throws is the table's business: a pull names a share of
// the one muzzle speed every tank has, and nothing a hand says makes it more
// than all of it.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [m, a, b, q] = raw;
  if (!Number.isInteger(m) || !Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(q)) return null;
  if (m < -1 || m > 1 || a < -1000 || a > 1000 || b < -1000 || b > 1000 || q < 0 || q > 999) return null;
  return [m, a, b, q];
}

function leave(w, id) {
  delete w.p[id];
}

// A barrel's shot: where it leaves the muzzle and how fast, from the tank's
// place and its pull; null for a pull too weak to fire. A pull longer than full
// is cut back to full.
function launch(x, y, ax, ay) {
  let len = isqrt(ax * ax + ay * ay);
  if (len < MIN_PULL) return null;
  if (len > 1000) {
    ax = Math.trunc((ax * 1000) / len);
    ay = Math.trunc((ay * 1000) / len);
    len = isqrt(ax * ax + ay * ay) || 1;
  }
  return [
    x + Math.trunc((ax * BARREL) / len), y - TURRET + Math.trunc((ay * BARREL) / len),
    Math.trunc((ax * VSHOT) / 1000), Math.trunc((ay * VSHOT) / 1000),
  ];
}

// One step of a shell's flight: gravity and wind first, then the move, checked
// in pieces. What it meets, in the order it is met, is the answer: [where,
// what] — 0 the ground, 1 the sea, 2 off the side — or null while it flies.
function flyStep(w, s, hit) {
  s.vy = clampI(s.vy + G, -VCAP, VCAP);
  s.vx = clampI(s.vx + w.wd, -VCAP, VCAP);
  const x0 = s.x, y0 = s.y;
  for (let j = 1; j <= SUB; j++) {
    const x = x0 + Math.trunc((s.vx * j) / SUB), y = y0 + Math.trunc((s.vy * j) / SUB);
    if (x < 0 || x > W) { s.x = clampI(x, 0, W); s.y = y; return 2; }
    if (y >= w.sea) { s.x = x; s.y = w.sea; return 1; }
    if (y >= groundAt(w.h, x)) { s.x = x; s.y = y; return 0; }
    if (hit && hit(x, y)) { s.x = x; s.y = y; return 0; }
  }
  s.x = x0 + s.vx;
  s.y = Math.max(-200000, y0 + s.vy);
  return -1;
}

// Where a shot would come down, against the ground and the sea alone: what the
// bot reckons with, and nothing else.
function landingX(w, x, y, vx, vy) {
  const s = { x, y, vx, vy };
  for (let a = 0; a < 200; a++) {
    const r = flyStep(w, s, null);
    if (r === 2) return s.x <= 0 ? -W : 2 * W;
    if (r >= 0) return s.x;
  }
  return s.x;
}

// The tank whose armour is lowest of all those afloat, by itself, and half
// gone, reloads faster: a last stand.
function lastStand(w, id) {
  const d = w.p[id];
  if (w.ph !== PLAY || d.st !== TANK || d.hp > HP0 / 2) return false;
  for (const o of playersIn(w)) {
    const e = w.p[o];
    if (o !== id && e.st === TANK && e.hp <= d.hp) return false;
  }
  return true;
}

function shellsOf(w, id) {
  let n = 0;
  for (const s of w.sh) if (s.o === id) n += 1;
  return n;
}

function fire(w, id) {
  const d = w.p[id];
  if (d.rl > 0 || shellsOf(w, id) >= SHELLS_EACH || w.sh.length >= SHELLS_MAX - 2) return false;
  if (d.st === SKY) {
    w.sh.push(shell({ i: w.sid++, x: d.x, y: SKY_Y + 600, vx: d.mv * BLIMP_V, vy: 0, o: id, k: BOMB, a: 0 }));
    d.rl = BOMB_RELOAD;
    fx(w, 'drop', d.x, SKY_Y, id);
    return true;
  }
  if (d.st !== TANK) return false;
  const l = launch(d.x, d.y, d.ax, d.ay);
  if (!l) return false;
  const [mx, my, vx, vy] = l;
  const kind = d.am;
  if (kind === TRIPLE) {
    for (const side of [-1, 0, 1]) {
      const s = side * SPREAD_S;
      const c = side ? SPREAD_C : 1000;
      const rx = Math.trunc((vx * c - vy * s) / 1000), ry = Math.trunc((vx * s + vy * c) / 1000);
      w.sh.push(shell({ i: w.sid++, x: mx, y: my, vx: rx, vy: ry, o: id, k: TRIPLE, a: 0 }));
    }
  } else {
    w.sh.push(shell({ i: w.sid++, x: mx, y: my, vx, vy, o: id, k: kind, a: 0 }));
  }
  if (w.sid > 1e9) w.sid = 0;
  d.am = PLAIN;
  d.rl = id === BOT_ID ? BOT_RELOAD : lastStand(w, id) ? RELOAD_LAST : RELOAD;
  // The barrel kicks the tank back a little.
  d.vx = clampI(d.vx - Math.trunc(vx / 40), -TV, TV);
  fx(w, 'fire', mx, my, id, kind);
  return true;
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 5;           // steps between the bot's decisions
const BOT_IDLE = 0.08;         // how often it stands a moment rather than decide
const BOT_SPREAD = 260;        // how far off its first shot at somebody is, in pull
// Four ways to raise a barrel, a thousand long: 45, 55, 35 and 60 degrees.
const BAIM = [[707, 707], [574, 819], [819, 574], [500, 866]];
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    respawn(w, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// It drives now and then — to a crate it can reach, away from the water's edge,
// or a little either way — and fires at the nearest tank, reckoning a pull
// with the wind in it and then missing by a spread that narrows with every
// shot at the same tank, the way a gunner walks shells onto a target.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== TANK) return;
  if (d.bm > 0) d.bm -= 1;
  else d.mv = 0;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 4 + Math.floor(draw01(w) * 10); d.mv = 0; d.bm = 0; return; }
  if (d.bm === 0) {
    const coastL = groundAt(w.h, d.x - 3000) > w.sea - 600, coastR = groundAt(w.h, d.x + 3000) > w.sea - 600;
    let to = 0;
    for (const c of w.cr) if (c.l && Math.abs(c.x - d.x) < 16000 && draw01(w) < 0.5) to = c.x > d.x ? 1 : -1;
    if (coastL && !coastR) to = 1;
    else if (coastR && !coastL) to = -1;
    else if (!to && draw01(w) < 0.12) to = draw01(w) < 0.5 ? -1 : 1;
    if (to) { d.mv = to; d.bm = 6 + Math.floor(draw01(w) * 14); }
  }
  if (d.rl > 0) return;
  let target = NONE, far = Infinity;
  for (const id of humans(w)) {
    const e = w.p[id];
    if (e.st !== TANK) continue;
    if (Math.abs(e.x - d.x) < far) { far = Math.abs(e.x - d.x); target = id; }
  }
  if (target === NONE) return;
  if (draw01(w) < 0.35) return;
  const e = w.p[target];
  if (target !== d.bx) { d.bx = target; d.bk = BOT_SPREAD; }
  const dir = e.x >= d.x ? 1 : -1;
  const [c, s] = BAIM[Math.floor(draw01(w) * BAIM.length)];
  let best = 600, miss = Infinity;
  for (let p = 200; p <= 1000; p += 50) {
    const l = launch(d.x, d.y, Math.trunc((dir * c * p) / 1000), Math.trunc((-s * p) / 1000));
    if (!l) continue;
    const off = Math.abs(landingX(w, l[0], l[1], l[2], l[3]) - e.x);
    if (off < miss) { miss = off; best = p; }
  }
  const p = clampI(best + Math.trunc((draw01(w) * 2 - 1) * d.bk), 150, 1000);
  d.bk = Math.max(25, Math.trunc((d.bk * 55) / 100));
  d.ax = Math.trunc((dir * c * p) / 1000);
  d.ay = Math.trunc((-s * p) / 1000);
  d.fq = 1;
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  w.sea = SEA0;
  island(w);
  w.sh = [];
  w.cr = [];
  for (const id of bySeat(w)) {
    const d = w.p[id];
    placeTank(w, d, startX(d.s, MAX_P));
    d.am = PLAIN;
  }
}

// A round: a new island, the seats closed up in order, everybody back on it,
// armoured and still. Whoever has the fewest points, when somebody has more,
// starts with a big shell in the breech.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.outs = 0;
  w.sea = SEA0;
  w.sh = [];
  w.cr = [];
  w.wd = Math.floor(draw01(w) * (2 * WMAX + 1)) - WMAX;
  w.wt = WIND_EVERY;
  w.ct = CRATE_EVERY;
  island(w);
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) { lo = Math.min(lo, w.p[id].pts); hi = Math.max(hi, w.p[id].pts); }
  for (const id of ids) {
    const d = w.p[id];
    placeTank(w, d, startX(d.s, ids.length));
    d.dm = 0;
    d.am = hi > lo && d.pts === lo ? BIG : PLAIN;
  }
  fx(w, 'round', W / 2, 0);
}

// The round is over: the last tank afloat takes the bonus, or, when the clock
// runs out first, the one with the most armour left — if it is the only one.
function finish(w) {
  const ids = bySeat(w);
  const afloat = ids.filter((id) => w.p[id].st === TANK);
  let win = -1;
  if (afloat.length === 1) win = afloat[0];
  else if (afloat.length > 1) {
    let top = -1, n = 0;
    for (const id of afloat) {
      if (w.p[id].hp > top) { top = w.p[id].hp; win = id; n = 1; } else if (w.p[id].hp === top) n += 1;
    }
    if (n > 1) win = -1;
  }
  w.win = win;
  if (win !== -1) { w.p[win].pts += WIN_PTS; w.p[win].wn += 1; }
  const res = ids.map((id) => [id, w.p[id].dm, w.p[id].pts, w.p[id].wn]);
  res.sort((a, b) => (b[0] === win) - (a[0] === win) || b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', W / 2, 0, win);
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
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', W / 2, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go', W / 2, 0); }
    } else if (w.ph === PLAY) {
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nothing moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      d.fq = 0;
      d.vx = d.vy = 0;
    }
    return;
  }
  battle(w);
}

function battle(w) {
  const practice = w.ph === WAIT;
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.rl > 0) d.rl -= 1;
    if (d.fq > 0) {
      if (fire(w, id)) d.fq = 0;
      else d.fq -= 1;
    }
    if (d.st === TANK) drive(w, id);
    else if (d.st === SKY) d.x = clampI(d.x + d.mv * BLIMP_V, TR, W - TR);
  }
  shells(w);
  crates(w);
  weather(w);
  // Sunk or wrecked: out of the round and up into a blimp, or, in practice,
  // back on the island a moment later.
  for (const id of ids) {
    const d = w.p[id];
    if (!d || d.st !== TANK) continue;
    const sunk = d.y > w.sea - 250;
    if (!sunk && d.hp > 0) continue;
    fx(w, sunk ? 'sunk' : 'wreck', d.x, Math.min(d.y, w.sea), id, d.lh);
    if (practice) { d.st = DOWN; d.rt = BACK_STEPS; continue; }
    d.st = SKY;
    d.y = SKY_Y;
    d.vx = d.vy = 0;
    d.rl = BOMB_RELOAD;
    d.am = PLAIN;
    d.ot = w.outs;
    w.outs += 1;
  }
  if (practice) {
    for (const id of ids) {
      const d = w.p[id];
      if (d && d.st === DOWN && --d.rt <= 0) respawn(w, id);
    }
    return;
  }
  let afloat = 0;
  for (const id of ids) if (w.p[id].st === TANK) afloat += 1;
  if (afloat <= 1) finish(w);
}

// A tank on its treads drives along the ground, up no rise steeper than it can
// climb, and slides on a little after a blast; one thrown off the ground flies
// until it lands, and a hard landing hurts.
function drive(w, id) {
  const d = w.p[id];
  const g0 = groundAt(w.h, d.x);
  const onGround = d.vy >= 0 && d.y >= g0 - 2;
  if (onGround) {
    d.vx = Math.trunc((d.vx * 2) / 3);
    const tx = clampI(d.x + d.vx + d.mv * T_SPEED, TR, W - TR);
    const g = groundAt(w.h, tx);
    if (g >= d.y - CLIMB) d.x = tx;
    else d.vx = 0;
    const g2 = groundAt(w.h, d.x);
    if (g2 <= d.y + CLIMB) { d.y = g2; d.vy = 0; } else d.vy = 0;
    if (Math.abs(d.vx) < 3) d.vx = 0;
    return;
  }
  d.vy = clampI(d.vy + TG, -TV, TV);
  d.x = clampI(d.x + d.vx, TR, W - TR);
  d.y = Math.max(-20000, d.y + d.vy);
  const g = groundAt(w.h, d.x);
  if (d.y >= g) {
    if (d.vy > SAFE_FALL) {
      const hurt = Math.trunc((d.vy - SAFE_FALL) / 40);
      d.hp -= hurt;
      fx(w, 'thud', d.x, g, id, hurt);
    }
    d.y = g;
    d.vy = 0;
    d.vx = Math.trunc(d.vx / 2);
  }
}

function shells(w) {
  const keep = [];
  for (const s of w.sh) {
    s.a += 1;
    // A shell meets the first tank or crate in its way; its own tank only once
    // it has cleared the muzzle.
    const hit = (x, y) => {
      for (const id of playersIn(w)) {
        const d = w.p[id];
        if (d.st !== TANK || (id === s.o && s.a < 4)) continue;
        const dx = x - d.x, dy = y - (d.y - 450);
        if (dx * dx + dy * dy < TR * TR) return true;
      }
      for (const c of w.cr) {
        const dx = x - c.x, dy = y - (c.y - CRATE_R);
        if (dx * dx + dy * dy < (CRATE_R + 200) * (CRATE_R + 200)) return true;
      }
      return false;
    };
    const r = flyStep(w, s, hit);
    if (r === 0) blast(w, s.x, s.y, s.k, s.o);
    else if (r === 1) fx(w, 'splash', s.x, w.sea, s.o, s.k);
    else if (r === -1 && s.a < SHELL_AGE) keep.push(s);
  }
  w.sh = keep;
}

// A blast: a bite out of the ground, armour off every tank in reach — the
// nearer the more, all of it inside half the radius — and a shove away and
// up. Damage to a rival in a round is the shooter's points.
function blast(w, x, y, kind, owner) {
  const R = KR[kind];
  carve(w, x, y, Math.trunc((R * KC[kind]) / 100));
  const scoring = w.ph === PLAY && w.p[owner];
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (d.st !== TANK) continue;
    const dx = d.x - x, dy = d.y - 450 - y;
    const dist = isqrt(dx * dx + dy * dy);
    if (dist >= R) continue;
    const dmg = Math.min(KD[kind], Math.trunc((KD[kind] * (R - dist) * 2) / R));
    const kick = Math.trunc((KK[kind] * (R - dist)) / R);
    const f = dist || 1;
    d.vx = clampI(d.vx + Math.trunc(((dist ? dx : 0) * kick) / f), -TV, TV);
    d.vy = clampI(d.vy + Math.trunc(((dist ? dy : -1) * kick) / f) - Math.trunc(kick / 2), -TV, TV);
    if (dmg <= 0) continue;
    d.hp -= dmg;
    if (id !== owner) {
      d.lh = owner;
      if (scoring) { w.p[owner].dm += dmg; w.p[owner].pts += dmg; }
    }
    fx(w, 'hit', d.x, d.y, id, dmg);
  }
  const R2 = (R + CRATE_R) * (R + CRATE_R);
  w.cr = w.cr.filter((c) => {
    const dx = c.x - x, dy = c.y - CRATE_R - y;
    if (dx * dx + dy * dy >= R2) return true;
    fx(w, 'smash', c.x, c.y, c.k);
    return false;
  });
  fx(w, 'boom', x, y, owner, kind);
}

// Crates float down onto dry land now and then and sit there until a tank
// drives over one, a blast smashes it, or the sea takes it.
function crates(w) {
  if (--w.ct <= 0) {
    w.ct = CRATE_EVERY;
    if (w.cr.length < CRATES_MAX) {
      const dry = [];
      for (let i = 2; i < NC - 2; i++) if (dryColumn(w, i)) dry.push(i);
      if (dry.length) {
        const i = dry[Math.floor(draw01(w) * dry.length)];
        const k = Math.floor(draw01(w) * 3);
        w.cr.push(crate({ x: i * CW + HALF_CW, y: -1500, k, l: 0 }));
        fx(w, 'crate', i * CW + HALF_CW, 0, k);
      }
    }
  }
  const ids = bySeat(w);
  w.cr = w.cr.filter((c) => {
    const g = groundAt(w.h, c.x);
    if (c.y < g) { c.y = Math.min(g, c.y + CRATE_V); c.l = c.y >= g ? 1 : 0; } else c.y = g;
    if (c.y > w.sea - 200) { fx(w, 'splash', c.x, w.sea, NONE, PLAIN); return false; }
    for (const id of ids) {
      const d = w.p[id];
      if (d.st !== TANK || Math.abs(d.x - c.x) > TR + CRATE_R || Math.abs(d.y - c.y) > 1800) continue;
      if (c.k === 0) d.hp = Math.min(HP0, d.hp + HEAL);
      else d.am = c.k === 1 ? BIG : TRIPLE;
      fx(w, 'pick', c.x, c.y, id, c.k);
      return false;
    }
    return true;
  });
}

// The wind turns every so often, and late in a round the sea climbs.
function weather(w) {
  if (--w.wt <= 0) {
    w.wt = WIND_EVERY;
    const was = w.wd;
    w.wd = Math.floor(draw01(w) * (2 * WMAX + 1)) - WMAX;
    if (w.wd !== was) fx(w, 'wind', W / 2, 0, w.wd);
  }
  if (w.ph !== PLAY) return;
  const into = PLAY_STEPS - w.pt;
  if (into === SEA_AT - 2 * HZ) fx(w, 'warn', W / 2, 0);
  if (into >= SEA_AT) w.sea = Math.max(SEA_MIN, w.sea - SEA_RATE);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function tableOf(raw) {
  if (!isObj(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG_N)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.sea, SEA_MIN, SEA0) || !int(raw.wd, -WMAX, WMAX) || !int(raw.wt, 0, WIND_EVERY)) return null;
  if (!int(raw.ct, 0, CRATE_EVERY) || !int(raw.sid, 0, BIG_N) || !int(raw.outs, 0, MAX_P)) return null;
  if (!Array.isArray(raw.h) || raw.h.length !== NC || !raw.h.every((v) => int(v, GROUND_TOP, SEA_BED))) return null;
  if (!Array.isArray(raw.sh) || raw.sh.length > SHELLS_MAX) return null;
  const sh = [];
  for (const s of raw.sh) {
    if (!isObj(s) || !int(s.i, 0, BIG_N) || !int(s.x, 0, W) || !int(s.y, -200000, H)) return null;
    if (!int(s.vx, -VCAP, VCAP) || !int(s.vy, -VCAP, VCAP) || !int(s.o, -BIG_N, BIG_N)) return null;
    if (!int(s.k, PLAIN, BOMB) || !int(s.a, 0, SHELL_AGE)) return null;
    sh.push(shell(s));
  }
  if (!Array.isArray(raw.cr) || raw.cr.length > CRATES_MAX) return null;
  const cr = [];
  for (const c of raw.cr) {
    if (!isObj(c) || !int(c.x, 0, W) || !int(c.y, -1500, H) || !int(c.k, 0, 2) || !int(c.l, 0, 1)) return null;
    cr.push(crate(c));
  }
  if (!isObj(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !isObj(d)) return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, TANK, DOWN) || !int(d.x, 0, W) || !int(d.y, -20000, H)) return null;
    if (!int(d.vx, -TV, TV) || !int(d.vy, -TV, TV) || inputOf([d.mv, d.ax, d.ay, d.q]) === null) return null;
    if (!int(d.fq, 0, FIRE_GRACE) || !int(d.rl, 0, BIG_N) || !int(d.hp, -999, HP0) || !int(d.am, PLAIN, TRIPLE)) return null;
    if (!int(d.dm, 0, BIG_N) || !int(d.pts, 0, BIG_N) || !int(d.wn, 0, 99999) || !int(d.ot, -1, MAX_P)) return null;
    if (!int(d.lh, -BIG_N, BIG_N) || !int(d.rt, 0, BACK_STEPS) || !int(d.bk, 0, BOT_SPREAD) || !int(d.bx, -BIG_N, BIG_N)) return null;
    if (!int(d.bw, 0, 99) || !int(d.bm, 0, 99) || !int(d.hs, -BIG_N, BIG_N) || !int(d.hc, 0, BIG_N)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => int(v, -BIG_N, BIG_N))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -BIG_N, BIG_N)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, sea: raw.sea, wd: raw.wd, wt: raw.wt, ct: raw.ct, sid: raw.sid,
    outs: raw.outs, h: raw.h.slice(), sh, cr, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: an island at dusk. A violet sky going amber at the sea, a low
// sun, green turf over layered earth, a teal sea, and a bright colour for each
// tank, ringed in ink so it reads on any ground.
const INK = {
  page: '#1a1330', skyTop: '#241c58', skyMid: '#6a3a7a', skyLow: '#f0895a', sun: '#ffd27a',
  text: '#ffffff', muted: '#d5cdea', dim: '#968db8', gold: '#ffd166', danger: '#ff5a6e', fire: '#ffb347',
  outline: '#1b1430', panel: 'rgba(22,16,44,0.93)',
  turf: '#7fd17a', turfDark: '#3f9a5a', soil: '#c88a55', soilDeep: '#7a4a33', rock: '#3e2a30',
  sea: '#1f8aa8', seaDeep: '#0d3956', foam: '#c8f3ff',
};
const SEAT = ['#ff4f7b', '#3fa9ff', '#f4f4ff', '#ff8a2e', '#9cff3a', '#e25cff', '#ffe23a', '#20e3ff'];
const CRATE_NAME = ['armour', 'big shell', 'spread of three'];
const CRATE_MARK = ['+', 'B', '3'];
const CRATE_INK = ['#7fe07a', '#ff9a3c', '#45d6ff'];
const AMMO_NAME = ['shell', 'big shell', 'spread of three'];
const FONT = "700 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.page};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:crosshair';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4d3f80;' +
  `background:#2a2052;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, sc = 0.005, ox = 0, oy = 58, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340;
let fieldL = 8, fieldR = 632;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  sc = Math.max(0.0005, Math.min((VW - 16) / W, ah / H));
  ox = (VW - W * sc) / 2;
  oy = TOP + (ah - H * sc) / 2;
  fieldTop = oy;
  fieldBot = oy + H * sc;
  fieldL = ox;
  fieldR = ox + W * sc;
}
layout();
window.addEventListener('resize', layout);

// Field units to the screen.
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
function outlined(s, x, y, px, colour, align) {
  ctx.font = font(px);
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(20,14,40,0.8)';
  ctx.strokeText(s, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(s, x, y);
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
function puff(dur, vol, freq, delay, q, type) {
  if (!noise) {
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.8), actx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = actx.currentTime + (delay || 0);
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  src.buffer = noise;
  f.type = type || 'bandpass';
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
  fire(near, big) {
    if (!ready('fire', 50)) return;
    tone(big ? 70 : 95, 0.22, 'sine', 0.08 + 0.12 * near, 0.45);
    puff(0.14, 0.04 + 0.08 * near, 900, 0, 0.7);
  },
  drop() { if (ready('drop', 80)) tone(900, 0.35, 'triangle', 0.04, 0.4); },
  boom(near, big) {
    if (!ready('boom', 40)) return;
    puff(big ? 0.8 : 0.55, 0.06 + 0.16 * near, big ? 160 : 220, 0, 0.6, 'lowpass');
    tone(big ? 48 : 60, big ? 0.6 : 0.4, 'sine', 0.08 + 0.14 * near, 0.5);
  },
  hit(me) {
    if (!ready('hit', 60)) return;
    if (me) { tone(330, 0.18, 'square', 0.06, 0.5); puff(0.12, 0.07, 2400, 0, 3); }
    else tone(520, 0.1, 'square', 0.04, 0.7);
  },
  splash(near) { if (ready('splash', 70)) puff(0.35, 0.03 + 0.07 * near, 1800, 0, 0.6, 'highpass'); },
  sink(me) {
    if (!ready('sink', 120)) return;
    if (me) { tone(440, 0.8, 'triangle', 0.08, 0.25); puff(0.6, 0.06, 900, 0.1, 0.5); }
    else tone(330, 0.45, 'triangle', 0.06, 0.4);
  },
  wreck(me) {
    if (!ready('wreck', 120)) return;
    puff(0.7, me ? 0.16 : 0.09, 300, 0, 0.5, 'lowpass');
    tone(me ? 180 : 220, 0.5, 'sawtooth', me ? 0.06 : 0.04, 0.3);
  },
  pick() { if (ready('pick', 200)) [659, 784, 988, 1319].forEach((f, i) => tone(f, 0.1, 'triangle', 0.08, 0, i * 0.05)); },
  crate() { if (ready('crate', 300)) tone(1200, 0.18, 'sine', 0.03, 0.8); },
  wind() { if (ready('wind', 400)) puff(0.9, 0.05, 700, 0, 0.4); },
  thud() { if (ready('thud', 100)) tone(80, 0.18, 'sine', 0.12, 0.6); },
  loaded() { if (ready('loaded', 200)) { tone(1500, 0.04, 'square', 0.03); tone(1100, 0.05, 'square', 0.03, 0, 0.05); } },
  back() { if (ready('back', 200)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.05)); },
  fresh() { if (ready('fresh', 300)) [392, 523, 659, 784].forEach((f, i) => tone(f, 0.14, 'triangle', 0.08, 0, i * 0.06)); },
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
// fast screen and a slow one see the same dust. Positions are field units.
const bits = [];      // { x, y, vx, vy, g, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0, flash = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, up, g) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (up || 0) * (0.5 + Math.random()), g: g === undefined ? 1 : g, life: 0, max: 22 + Math.random() * 26, size, colour });
  }
  if (bits.length > 800) bits.splice(0, bits.length - 800);
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 64, px: px || 15 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 22, r }); }
function moveBits(n) {
  for (let j = 0; j < n; j++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.96; b.vy = b.vy * 0.96 + (60000 * b.g) / BIT_HZ;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.85;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();      // id -> { hit, squash, seen, tilt }
const trails = new Map();     // shell number -> [[x, y]...], newest last
let drawFailed = false;
let loadedSaid = true;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
function nearMe(t, x, y) {
  const d = t.p[myId()];
  if (!d || d.st === DOWN) return 0.35;
  return Math.max(0, 1 - (Math.abs(d.x - x) + Math.abs(d.y - y) * 0.5) / 40000);
}
function lookOf(id, now) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { hit: 0, squash: 0, seen: now, tilt: 0 }));
  return l;
}

function play(e, t, now) {
  const me = myId();
  const near = nearMe(t, e.x, e.y);
  if (e.kind === 'fire') {
    const c = colourOf(t, e.a);
    spray(e.x, e.y, 8, '#fff3c4', 9000, 260, 0, 0);
    spray(e.x, e.y, 5, alpha(c, 0.8), 6000, 300, 2000, 0.2);
    ring(e.x, e.y, '#ffe6a8', 1200);
    if (e.a !== me) sound.fire(near, e.b === BIG);
    lookOf(e.a, now).squash = 0.8;
  } else if (e.kind === 'drop') {
    if (e.a !== me) sound.drop();
  } else if (e.kind === 'boom') {
    const R = KR[e.b];
    ring(e.x, e.y, '#ffe1a0', R);
    ring(e.x, e.y, alpha(colourOf(t, e.a), 0.9), R * 0.7);
    spray(e.x, e.y, 14, INK.fire, R * 6, 380, R * 3, 0.4);
    spray(e.x, e.y, 10, '#fff1c8', R * 4, 260, R * 2, 0.1);
    spray(e.x, e.y, 18, INK.soil, R * 7, 300, R * 6, 1);
    spray(e.x, e.y, 8, INK.turf, R * 6, 240, R * 6, 1);
    shake = Math.max(shake, (e.b === BIG ? 6 : 3) + 12 * near);
    flash = Math.max(flash, 0.12 + 0.25 * near);
    sound.boom(near, e.b === BIG);
  } else if (e.kind === 'hit') {
    lookOf(e.a, now).hit = 1;
    pop(e.x, e.y - 2200, '-' + e.b, e.a === me ? INK.danger : '#ffffff', e.a === me ? 18 : 14);
    if (e.a === me) shake = Math.max(shake, 10);
    sound.hit(e.a === me);
  } else if (e.kind === 'splash') {
    spray(e.x, e.y, 16, INK.foam, 9000, 280, 14000, 1);
    ring(e.x, e.y, INK.foam, 1400);
    sound.splash(near);
  } else if (e.kind === 'sunk' || e.kind === 'wreck') {
    const c = colourOf(t, e.a);
    const by = e.b !== NONE && e.b !== e.a ? ' by ' + (e.b === me ? 'you' : nickOf(e.b)) : '';
    if (e.kind === 'sunk') spray(e.x, e.y, 26, INK.foam, 12000, 320, 20000, 1);
    else { spray(e.x, e.y, 26, INK.fire, 14000, 420, 16000, 0.5); spray(e.x, e.y, 14, '#3a2d3a', 9000, 500, 12000, 0.2); }
    ring(e.x, e.y, c, 3600);
    const what = e.kind === 'sunk' ? 'sunk' : 'wrecked';
    pop(e.x, e.y - 3000, e.a === me ? 'you were ' + what + by : nickOf(e.a) + ' ' + what + by, c, e.a === me ? 18 : 14);
    if (e.a === me) shake = Math.max(shake, 14);
    if (e.kind === 'sunk') sound.sink(e.a === me); else sound.wreck(e.a === me);
  } else if (e.kind === 'thud') {
    lookOf(e.a, now).squash = 1;
    spray(e.x, e.y, 10, INK.soil, 6000, 260, 6000, 1);
    sound.thud();
  } else if (e.kind === 'smash') {
    spray(e.x, e.y - CRATE_R, 16, '#b07a43', 9000, 300, 12000, 1);
    pop(e.x, e.y - 2000, 'crate smashed', CRATE_INK[e.a], 13);
  } else if (e.kind === 'pick') {
    ring(e.x, e.y - CRATE_R, CRATE_INK[e.b], 2600);
    spray(e.x, e.y - CRATE_R, 14, CRATE_INK[e.b], 9000, 260, 9000, 0.4);
    pop(e.x, e.y - 2600, (e.a === me ? 'you got ' : nickOf(e.a) + ' got ') + CRATE_NAME[e.b], CRATE_INK[e.b], e.a === me ? 17 : 13);
    if (e.a === me) sound.pick();
  } else if (e.kind === 'crate') {
    sound.crate();
  } else if (e.kind === 'wind') {
    pop(W / 2, 9000, 'the wind turns', INK.gold, 18);
    sound.wind();
  } else if (e.kind === 'warn') {
    pop(W / 2, 12000, 'the sea is rising!', INK.foam, 22);
    sound.warn();
  } else if (e.kind === 'back') {
    ring(e.x, e.y, colourOf(t, e.a), 3000);
    if (e.a === me) sound.back();
  } else if (e.kind === 'fresh') {
    pop(W / 2, 12000, 'a fresh island', INK.gold, 22);
    trails.clear();
    sound.fresh();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'round') {
    trails.clear();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

// The sky, the sun on the water and far hills, then the field's frame.
function drawSky(now, t) {
  flat();
  ctx.fillStyle = INK.page;
  ctx.fillRect(0, 0, VW, VH);
  ctx.save();
  roundRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop, 12);
  ctx.clip();
  const sea = t ? t.sea : SEA0;
  const g = ctx.createLinearGradient(0, fieldTop, 0, SY(sea));
  g.addColorStop(0, INK.skyTop);
  g.addColorStop(0.55, INK.skyMid);
  g.addColorStop(1, INK.skyLow);
  ctx.fillStyle = g;
  ctx.fillRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop);
  // Stars high up, twinkling a little.
  for (let i = 0; i < 40; i++) {
    const x = fieldL + ((i * 9301 + 49297) % 233280) / 233280 * (fieldR - fieldL);
    const y = fieldTop + ((i * 7919 + 12345) % 1000) / 1000 * (fieldBot - fieldTop) * 0.35;
    ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.25 * Math.sin(now / 600 + i * 1.7)).toFixed(3)})`;
    disc(x, y, 0.8 + (i % 3) * 0.4);
    ctx.fill();
  }
  // A low sun and a far range of hills behind the island.
  const sx = fieldL + (fieldR - fieldL) * 0.74, sy = SY(SEA0) - 9000 * sc;
  const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 16000 * sc);
  sg.addColorStop(0, 'rgba(255,214,130,0.55)');
  sg.addColorStop(1, 'rgba(255,214,130,0)');
  ctx.fillStyle = sg;
  ctx.fillRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop);
  ctx.fillStyle = INK.sun;
  disc(sx, sy, 3600 * sc);
  ctx.fill();
  ctx.fillStyle = 'rgba(70,40,90,0.55)';
  ctx.beginPath();
  ctx.moveTo(fieldL, SY(SEA0));
  for (let i = 0; i <= 40; i++) {
    const x = (W * i) / 40;
    const y = SEA0 - 5000 - 3200 * Math.sin(i * 0.7) - 2200 * Math.sin(i * 1.9 + 1);
    ctx.lineTo(SX(x), SY(y));
  }
  ctx.lineTo(fieldR, SY(SEA0));
  ctx.closePath();
  ctx.fill();
  // Streaks the wind blows across the sky, as fast as it blows.
  if (t) {
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1.5;
    const span = fieldR - fieldL;
    for (let i = 0; i < 9; i++) {
      const y = fieldTop + (0.12 + 0.07 * i) * (fieldBot - fieldTop);
      const len = 10 + Math.abs(t.wd) * 3.5;
      const x = fieldL + ((((i * 137 + (now / 1000) * t.wd * 14 + now / 1000 * 2) % span) + span) % span);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - Math.sign(t.wd || 1) * len, y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// The island: turf over layered earth, every bite out of it showing.
function drawGround(t) {
  flat();
  ctx.save();
  roundRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop, 12);
  ctx.clip();
  const h = t.h;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(SX(0), SY(H + 2000));
    ctx.lineTo(SX(0), SY(h[0]));
    for (let i = 0; i < NC; i++) ctx.lineTo(SX(i * CW + HALF_CW), SY(h[i]));
    ctx.lineTo(SX(W), SY(h[NC - 1]));
    ctx.lineTo(SX(W), SY(H + 2000));
    ctx.closePath();
  };
  const g = ctx.createLinearGradient(0, SY(GROUND_TOP), 0, SY(H));
  g.addColorStop(0, INK.soil);
  g.addColorStop(0.5, INK.soilDeep);
  g.addColorStop(1, INK.rock);
  path();
  ctx.fillStyle = g;
  ctx.fill();
  // Strata: faint bands across the earth.
  ctx.save();
  path();
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  for (let y = GROUND_TOP + 3000; y < H; y += 6000) ctx.fillRect(fieldL, SY(y), fieldR - fieldL, 2500 * sc);
  ctx.restore();
  // Turf along the top, where the ground still has its top.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = INK.turfDark;
  ctx.lineWidth = Math.max(2, 700 * sc);
  ctx.beginPath();
  for (let i = 0; i < NC; i++) {
    const x = SX(i * CW + HALF_CW), y = SY(h[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = INK.turf;
  ctx.lineWidth = Math.max(1, 320 * sc);
  ctx.stroke();
  ctx.restore();
}

function drawSea(t, now) {
  flat();
  ctx.save();
  roundRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop, 12);
  ctx.clip();
  const y0 = SY(t.sea);
  const g = ctx.createLinearGradient(0, y0, 0, fieldBot);
  g.addColorStop(0, 'rgba(40,160,190,0.82)');
  g.addColorStop(1, 'rgba(10,50,85,0.95)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(fieldL, fieldBot + 4);
  const amp = Math.max(1.5, 260 * sc);
  for (let x = fieldL; x <= fieldR + 6; x += 6) ctx.lineTo(x, y0 + Math.sin(x / 14 + now / 420) * amp);
  ctx.lineTo(fieldR + 6, fieldBot + 4);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = alpha(INK.foam, 0.7);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = fieldL; x <= fieldR + 6; x += 6) {
    const y = y0 + Math.sin(x / 14 + now / 420) * amp;
    if (x === fieldL) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // The sun's glitter on the water.
  ctx.fillStyle = 'rgba(255,220,150,0.35)';
  const sx = fieldL + (fieldR - fieldL) * 0.74;
  for (let i = 0; i < 6; i++) {
    const w = (12 - i * 1.5) * (1 + 0.2 * Math.sin(now / 300 + i));
    ctx.fillRect(sx - w, y0 + 3 + i * 4, w * 2, 1.5);
  }
  ctx.restore();
  // The frame round the field.
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  roundRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop, 12);
  ctx.stroke();
}

// A tank as drawn: treads on the ground, a hull in its seat's colour ringed in
// ink, a dome and a barrel pointing where it aims, tilted with the slope under
// it, flashing white when hit and squashed by a shot or a landing.
function drawTank(id, x, y, d, colour, me, now, ax, ay, slope) {
  const look = lookOf(id, now);
  look.seen = now;
  look.hit *= Math.pow(0.88, frameDt * 60);
  look.squash *= Math.pow(0.85, frameDt * 60);
  look.tilt = lerp(look.tilt, slope, per60(0.25));
  const s = Math.max(0.5, TR * sc);
  const px = SX(x), py = SY(y);
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(look.tilt);
  const sq = look.squash;
  ctx.scale(1 + sq * 0.12, 1 - sq * 0.15);
  // Treads.
  ctx.fillStyle = INK.outline;
  roundRect(-s * 1.05, -s * 0.42, s * 2.1, s * 0.46, s * 0.22);
  ctx.fill();
  ctx.fillStyle = '#4a4560';
  roundRect(-s * 0.98, -s * 0.38, s * 1.96, s * 0.36, s * 0.18);
  ctx.fill();
  ctx.fillStyle = '#8e88a8';
  for (let k = -3; k <= 3; k++) { disc(k * s * 0.27, -s * 0.2, s * 0.09); ctx.fill(); }
  // Barrel, under the dome.
  const al = Math.hypot(ax, ay) || 1;
  const ux = ax / al, uy = ay / al;
  ctx.restore();
  ctx.save();
  ctx.translate(px, py);
  const bx = 0, by = -s * 0.85;
  ctx.strokeStyle = INK.outline;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, s * 0.32);
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + ux * s * 1.25, by + uy * s * 1.25); ctx.stroke();
  ctx.strokeStyle = darker(colour, 0.15);
  ctx.lineWidth = Math.max(1, s * 0.18);
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + ux * s * 1.2, by + uy * s * 1.2); ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(look.tilt);
  ctx.scale(1 + sq * 0.12, 1 - sq * 0.15);
  // Hull and dome.
  ctx.fillStyle = INK.outline;
  roundRect(-s * 0.92, -s * 0.78, s * 1.84, s * 0.48, s * 0.2);
  ctx.fill();
  disc(0, -s * 0.8, s * 0.48);
  ctx.fill();
  ctx.fillStyle = darker(colour, 0.25);
  roundRect(-s * 0.86, -s * 0.72, s * 1.72, s * 0.38, s * 0.16);
  ctx.fill();
  ctx.fillStyle = colour;
  roundRect(-s * 0.86, -s * 0.72, s * 1.72, s * 0.22, s * 0.12);
  ctx.fill();
  disc(0, -s * 0.8, s * 0.4);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  disc(-s * 0.14, -s * 0.94, s * 0.12);
  ctx.fill();
  if (look.hit > 0.05) {
    ctx.globalAlpha = Math.min(1, look.hit);
    ctx.fillStyle = '#ffffff';
    roundRect(-s * 0.92, -s * 0.78, s * 1.84, s * 0.48, s * 0.2);
    ctx.fill();
    disc(0, -s * 0.8, s * 0.48);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (me) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px - s * 0.3, py + s * 0.35);
    ctx.lineTo(px, py + s * 0.15);
    ctx.lineTo(px + s * 0.3, py + s * 0.35);
    ctx.stroke();
  }
  // Name, armour and what is in the breech, over the tank.
  const top = py - s * 1.45;
  const bw = Math.max(26, s * 2.2), bh = 4;
  ctx.fillStyle = 'rgba(20,14,40,0.75)';
  roundRect(px - bw / 2 - 1, top - 1, bw + 2, bh + 2, 3);
  ctx.fill();
  const hp = Math.max(0, d.hp) / HP0;
  ctx.fillStyle = hp > 0.5 ? '#7fe07a' : hp > 0.25 ? '#ffd166' : '#ff5a6e';
  roundRect(px - bw / 2, top, bw * hp, bh, 2);
  ctx.fill();
  const label = me ? 'you' : nickOf(id);
  outlined(label, px, top - 4, Math.max(9, Math.min(13, s * 0.9)), me ? '#ffffff' : colour);
  if (d.am !== PLAIN) {
    ctx.fillStyle = CRATE_INK[d.am];
    disc(px + bw / 2 + 6, top + 2, 4.5);
    ctx.fill();
    text(CRATE_MARK[d.am], px + bw / 2 + 6, top + 5.5, 8, INK.outline);
  }
}

// A blimp, for a tank that sank: it drifts along the top of the sky and drops
// bombs on whoever is still afloat.
function drawBlimp(id, x, d, colour, me, now) {
  const s = Math.max(0.5, TR * sc);
  const px = SX(x), py = SY(SKY_Y) + Math.sin(now / 500 + id) * 2;
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = INK.outline;
  ctx.beginPath(); ctx.ellipse(px, py, s * 1.55, s * 0.62, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.ellipse(px, py, s * 1.45, s * 0.54, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath(); ctx.ellipse(px - s * 0.3, py - s * 0.22, s * 0.8, s * 0.14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = darker(colour, 0.35);
  ctx.beginPath();
  ctx.moveTo(px - s * 1.3, py); ctx.lineTo(px - s * 1.85, py - s * 0.5); ctx.lineTo(px - s * 1.85, py + s * 0.5);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = INK.outline;
  roundRect(px - s * 0.4, py + s * 0.5, s * 0.8, s * 0.3, s * 0.1);
  ctx.fill();
  ctx.globalAlpha = 1;
  outlined(me ? 'you' : nickOf(id), px, py - s * 0.8, Math.max(9, Math.min(12, s * 0.8)), me ? '#ffffff' : colour);
  // Its reload, as a thin bar under the gondola.
  if (d.rl > 0) {
    const k = 1 - d.rl / BOMB_RELOAD;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(px - s * 0.6, py + s * 1.0, s * 1.2 * k, 2);
  }
}

function drawCrate(c, now) {
  const s = Math.max(0.5, CRATE_R * sc);
  const px = SX(c.x), py = SY(c.y);
  if (!c.l) {
    // Under its canopy, swaying.
    const sw = Math.sin(now / 400 + c.x) * s * 0.3;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px - s, py - s * 2); ctx.lineTo(px - s * 1.6 + sw, py - s * 4);
    ctx.moveTo(px + s, py - s * 2); ctx.lineTo(px + s * 1.6 + sw, py - s * 4);
    ctx.stroke();
    ctx.fillStyle = '#f2eef8';
    ctx.beginPath();
    ctx.ellipse(px + sw, py - s * 4.1, s * 2, s * 1.1, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = CRATE_INK[c.k];
    ctx.beginPath();
    ctx.ellipse(px + sw, py - s * 4.1, s * 0.7, s * 1.1, 0, Math.PI, 0);
    ctx.fill();
  }
  ctx.fillStyle = INK.outline;
  roundRect(px - s - 1.5, py - s * 2 - 1.5, s * 2 + 3, s * 2 + 3, 3);
  ctx.fill();
  ctx.fillStyle = '#b8814a';
  roundRect(px - s, py - s * 2, s * 2, s * 2, 2);
  ctx.fill();
  ctx.fillStyle = CRATE_INK[c.k];
  disc(px, py - s, s * 0.62);
  ctx.fill();
  text(CRATE_MARK[c.k], px, py - s + s * 0.42, Math.max(7, s * 1.1), INK.outline);
}

function drawShells(b, now) {
  const from = new Map(b.from.sh.map((s) => [s.i, s]));
  const seen = new Set();
  for (const s of b.to.sh) {
    const a = from.get(s.i);
    const x = a ? lerp(a.x, s.x, b.k) : s.x, y = a ? lerp(a.y, s.y, b.k) : s.y;
    seen.add(s.i);
    let tr = trails.get(s.i);
    if (!tr) trails.set(s.i, (tr = []));
    const last = tr[tr.length - 1];
    if (!last || Math.abs(last[0] - x) + Math.abs(last[1] - y) > 400) tr.push([x, y]);
    if (tr.length > 14) tr.shift();
    const c = colourOf(b.to, s.o);
    // Its trail, fading behind it.
    ctx.lineCap = 'round';
    for (let i = 1; i < tr.length; i++) {
      ctx.strokeStyle = alpha(c, (i / tr.length) * 0.55);
      ctx.lineWidth = Math.max(1, (i / tr.length) * 3);
      ctx.beginPath();
      ctx.moveTo(SX(tr[i - 1][0]), SY(tr[i - 1][1]));
      ctx.lineTo(SX(tr[i][0]), SY(tr[i][1]));
      ctx.stroke();
    }
    const r = Math.max(2.2, (s.k === BIG ? 420 : s.k === BOMB ? 300 : 320) * sc);
    if (y < 0) {
      // Above the top of the field: a mark on its edge where it will come down.
      const px = Math.max(fieldL + 6, Math.min(fieldR - 6, SX(x)));
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(px, fieldTop + 3); ctx.lineTo(px - 5, fieldTop + 11); ctx.lineTo(px + 5, fieldTop + 11);
      ctx.closePath();
      ctx.fill();
      continue;
    }
    ctx.fillStyle = alpha(c, 0.35);
    disc(SX(x), SY(y), r * 2.2);
    ctx.fill();
    ctx.fillStyle = INK.outline;
    disc(SX(x), SY(y), r + 1);
    ctx.fill();
    ctx.fillStyle = s.k === BIG ? '#ff9a3c' : '#fff6dc';
    disc(SX(x), SY(y), r);
    ctx.fill();
  }
  for (const k of trails.keys()) if (!seen.has(k)) trails.delete(k);
}

function drawBits() {
  flat();
  ctx.save();
  roundRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop, 12);
  ctx.clip();
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    disc(SX(b.x), SY(b.y), Math.max(0.8, b.size * sc * (1 - f * 0.5)));
    ctx.fill();
  }
  for (const r of rings) {
    const f = r.life / r.max;
    ctx.globalAlpha = (1 - f) * 0.8;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - f) + 1;
    disc(SX(r.x), SY(r.y), r.r * sc * ease(f));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (flash > 0.02) {
    ctx.fillStyle = `rgba(255,236,200,${flash.toFixed(3)})`;
    ctx.fillRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop);
  }
  ctx.restore();
  for (const p of pops) {
    const f = p.life / p.max;
    const rise = 14 + ease(f) * 26;
    const scale = f < 0.15 ? 0.6 + (f / 0.15) * 0.5 : 1.1 - Math.min(0.1, f - 0.15);
    ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
    ctx.font = font(p.px * scale);
    const wd = ctx.measureText(p.s).width / 2 + 6;
    const X = Math.max(wd, Math.min(VW - wd, SX(p.x))), Y = Math.max(fieldTop + 18, SY(p.y) - rise);
    outlined(p.s, X, Y, p.px * scale, p.colour);
  }
  ctx.globalAlpha = 1;
}

const clock = (steps) => {
  const s = Math.ceil(steps / HZ);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const afloat = (t) => playersIn(t).filter((id) => t.p[id].st === TANK).length;

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, and the time and tanks left in it.
  let status = '', colour = INK.text;
  const into = PLAY_STEPS - t.pt;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' · ' + afloat(t) + ' afloat';
    if (into >= SEA_AT && t.sea > SEA_MIN) {
      status += ' · the sea is rising';
      colour = Math.floor(now / 400) % 2 ? INK.foam : INK.text;
    }
  } else status = 'round ' + t.rd + ' · over';
  text('barrage', 12, 22, titlePx, INK.fire, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('barrage').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points and a
  // sliver of armour; the chip of somebody in a blimp is hollow.
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
      if (d.st === TANK) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      if (d.st === TANK) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x + 12, y + 6, cw - 24, 2);
        ctx.fillStyle = c;
        ctx.fillRect(x + 12, y + 6, (cw - 24) * Math.max(0, d.hp) / HP0, 2);
      }
      const score = t.ph === WAIT ? '' : String(d.pts);
      ctx.font = font(12);
      const sw = score ? ctx.measureText(score).width : 0;
      if (score) text(score, x + cw - 8, y + 3, 12, INK.gold, 'right');
      if (cw > 46) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st === TANK ? (mine ? INK.text : INK.muted) : INK.dim, cw - 30 - sw, 'left');
      x += cw + gap;
    }
  }

  // The wind, top middle of the field: an arrow as long as it blows.
  const wx = (fieldL + fieldR) / 2, wy = fieldTop + 16;
  const wl = (Math.abs(t.wd) / WMAX) * 46;
  ctx.fillStyle = 'rgba(20,14,40,0.55)';
  roundRect(wx - 64, wy - 11, 128, 22, 11);
  ctx.fill();
  if (t.wd === 0) text('no wind', wx, wy + 4, 11, INK.muted);
  else {
    const dir = Math.sign(t.wd);
    ctx.strokeStyle = INK.foam;
    ctx.fillStyle = INK.foam;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    const x0 = wx - (dir * wl) / 2, x1 = wx + (dir * wl) / 2;
    ctx.beginPath(); ctx.moveTo(x0, wy); ctx.lineTo(x1, wy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1 + dir * 5, wy); ctx.lineTo(x1 - dir * 3, wy - 6); ctx.lineTo(x1 - dir * 3, wy + 6); ctx.closePath(); ctx.fill();
    text('wind ' + Math.abs(t.wd), wx - dir * 40, wy + 4, 10, INK.muted);
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag back to aim · let go to fire · drag along the bottom to drive'
    : 'drag back to aim, let go to fire · A/D drive · W/S turn · hold space to fire · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// Your armour, reload and what is in the breech, in the strip under the field.
function drawMine(t, now) {
  const me = myId();
  const d = t.p[me];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = Math.min(fieldBot + NOTE_ROOM / 2, VH - BOT - 18);
  if (d.st !== TANK) {
    const line = t.ph === PLAY ? 'you are in a blimp · drive along and drop bombs on whoever is still afloat'
      : t.ph === COUNT ? 'get ready' : '';
    if (line) fitText(line, VW / 2, y + 5, 13, INK.muted, VW - 24);
    return;
  }
  const parts = [];
  const rel = d.rl > 0 ? 'loading' : 'ready';
  parts.push([rel, d.rl > 0 ? INK.dim : '#7fe07a']);
  parts.push(['· ' + AMMO_NAME[d.am], d.am !== PLAIN ? CRATE_INK[d.am] : INK.text]);
  parts.push(['· armour ' + Math.max(0, d.hp), d.hp > 50 ? INK.text : INK.danger]);
  if (lastStand(t, me)) parts.push(['· last stand: fast reload', Math.floor(now / 300) % 2 ? INK.gold : INK.text]);
  ctx.font = font(13);
  let total = 0;
  for (const [s] of parts) total += ctx.measureText(s).width + 8;
  let x = Math.max(8, VW / 2 - total / 2);
  for (const [s, c] of parts) {
    text(s, x, y + 5, 13, c, 'left');
    x += ctx.measureText(s).width + 8;
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
  const cx = VW / 2;
  const mid = (fieldTop + fieldBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'pull back and let go to lob · mind the wind · blast the ground out from under it';
    practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,14,40,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big * 0.3);
    text(String(n), cx, mid + big * 0.3, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 1.5, Math.min(VW - 32, 320), 30);
    fitText('last tank afloat takes the round', cx, mid + big * 1.5 + 5, 14, INK.text, Math.min(VW - 48, 300));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(20,14,40,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('fire!', cx, mid);
    text('fire!', cx, mid, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody kept the island';
    else head = t.win === me ? 'you are the last tank afloat!' : nickOf(t.win) + ' is the last tank afloat';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('damage', cx + w / 2 - 74, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, dm, pts, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 160, 'left');
      text(String(dm), cx + w / 2 - 74, y, 14, INK.text, 'right');
      text(String(pts), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('a point per armour knocked off a rival, ' + WIN_PTS + ' for the last afloat · next in ' + Math.ceil(t.pt / HZ),
      cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where somebody is as drawn: between two steps, and never slid across a jump
// — a tank put back on the island, or one that has just taken to a blimp.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 8000) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}
const slopeAt = (h, x) => Math.atan2(groundAt(h, x + TR) - groundAt(h, x - TR), 2 * TR);

// Your own tank is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a push a step away from where
// the guess had it. So the tank drawn is pulled toward the guess a little every
// frame rather than put on it, and a guess far off — a table taken afresh, a
// tank put back — puts it there at once. Only the drawing is smoothed.
const PULL_TO = 0.45;
let shown = null;        // [x, y] in units: where your tank is drawn
let myPos = null;        // [x, y]: the same, for the aim

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 6000) return (shown = [x, y]);
  const k = per60(PULL_TO);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

// While you aim, the first moments of the shot are dotted in front of the
// barrel, wind and all: where it is going, never where it lands.
function drawAim(t, now) {
  if (!myPos || !aiming()) return;
  const [ax, ay] = aimNow();
  const len = Math.hypot(ax, ay);
  if (len < MIN_PULL) return;
  const ux = ax / len, uy = ay / len, k = Math.min(1000, len) / 1000;
  let x = myPos[0] + ux * BARREL, y = myPos[1] - TURRET + uy * BARREL;
  let vx = ux * k * VSHOT, vy = uy * k * VSHOT;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 18; i++) {
    vy += G; vx += t.wd;
    x += vx; y += vy;
    if (y > groundAt(t.h, x) || x < 0 || x > W) break;
    ctx.globalAlpha = 0.85 * (1 - i / 18);
    disc(SX(x), SY(y), 2.2 - i * 0.07);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // The pull, as a bar beside the tank.
  const px = SX(myPos[0]) - TR * sc - 12, py = SY(myPos[1]);
  ctx.fillStyle = 'rgba(20,14,40,0.7)';
  roundRect(px - 3, py - 34, 6, 32, 3);
  ctx.fill();
  ctx.fillStyle = k > 0.8 ? INK.danger : k > 0.5 ? INK.gold : '#7fe07a';
  roundRect(px - 2, py - 3 - 30 * k, 4, 30 * k, 2);
  ctx.fill();
  if (pull) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pull.ox, pull.oy);
    ctx.lineTo(pull.x, pull.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    disc(pull.ox, pull.oy, 6);
    ctx.stroke();
  }
}

// On a touch screen, the strip along the bottom of the field drives.
function drawDrivePad() {
  if (!coarse) return;
  const top = driveTop();
  ctx.fillStyle = drv ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
  roundRect(fieldL + 6, top, fieldR - fieldL - 12, fieldBot - top - 6, 10);
  ctx.fill();
  fitText('◀  drag here to drive  ▶', VW / 2, (top + fieldBot) / 2 + 3, 11, 'rgba(255,255,255,0.55)', fieldR - fieldL - 24);
}

let wasLoaded = true;
function draw(now) {
  const b = agreedAt(now);
  drawSky(now, b ? b.to : null);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the island…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a table this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t, now);
    else i++;
  }
  const me = myId();
  const md = t.p[me];
  const loaded = !!md && md.st === TANK && md.rl === 0;
  if (loaded && !wasLoaded && t.ph === PLAY) sound.loaded();
  wasLoaded = loaded;
  drawGround(t);
  flat();
  ctx.save();
  roundRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop, 12);
  ctx.clip();
  for (const c of t.cr) drawCrate(c, now);
  const m = mineAt(now);
  for (const id of bySeat(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st !== TANK) continue;
    const p = bodyAt(b, id);
    drawTank(id, p[0], p[1], d, SEAT[d.c], false, now, d.ax, d.ay, slopeAt(t.h, p[0]));
  }
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  myPos = null;
  if (own && own.to.p[me].st === TANK) {
    const p = bodyAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    myPos = [x, y];
    const [ax, ay] = aimNow();
    drawTank(me, x, y, p[2], SEAT[p[2].c], true, now, ax, ay, slopeAt(t.h, x));
  } else shown = null;
  drawShells(b, now);
  ctx.restore();
  drawSea(t, now);
  flat();
  ctx.save();
  roundRect(fieldL, fieldTop, fieldR - fieldL, fieldBot - fieldTop, 12);
  ctx.clip();
  for (const id of bySeat(t)) {
    const d = t.p[id];
    if (d.st !== SKY) continue;
    const src = id === me && own && own.to.p[me] && own.to.p[me].st === SKY ? own : b;
    const p = bodyAt(src, id);
    if (p) drawBlimp(id, p[0], d, SEAT[d.c], id === me, now);
  }
  ctx.restore();
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawAim(t, now);
  drawDrivePad();
  drawHud(t, now);
  drawMine(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way driven, where the barrel points and how hard, a
// thousand at full, and how many shots so far. A turn of the barrel goes out no
// oftener than AIM_EVERY, because a thumb or a mouse changes it on every move
// the screen reports and the clock's ticks share the same seat's ceiling on
// messages; a shot or a change of way goes out at once.
const AIM_EVERY = 90;
let shots = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_LEFT = new Set(['ArrowLeft', 'KeyA']), KEY_RIGHT = new Set(['ArrowRight', 'KeyD']);
const KEY_UP = new Set(['ArrowUp', 'KeyW']), KEY_DOWN = new Set(['ArrowDown', 'KeyS']);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// The barrel as the keys hold it: an angle up from the right, and a pull.
let keyAng = Math.PI / 4, keyPow = 0.7, charging = false, chargeFrom = 0;
// A drag that aims: from where it went down to where it is now, pulled back
// like a catapult's arm; and a drag along the bottom that drives.
let pull = null;         // { id, ox, oy, x, y }
let drv = null;          // { id, ox, x }
const DEAD = 12;
const pullPx = () => Math.max(90, Math.min(VW, VH) * 0.32);
const driveTop = () => fieldBot - Math.max(34, (fieldBot - fieldTop) * 0.15);

const aiming = () => !!pull || charging;

function aimNow() {
  if (pull) {
    const dx = pull.ox - pull.x, dy = pull.oy - pull.y, l = Math.hypot(dx, dy);
    if (l >= DEAD) {
      const k = Math.min(1, l / pullPx());
      return [clamp(Math.round((dx / l) * k * 1000), -1000, 1000), clamp(Math.round((dy / l) * k * 1000), -1000, 1000)];
    }
  }
  const p = charging ? chargeNow(performance.now()) : keyPow;
  return [clamp(Math.round(Math.cos(keyAng) * p * 1000), -1000, 1000), clamp(Math.round(-Math.sin(keyAng) * p * 1000), -1000, 1000)];
}
// Held, the pull climbs to full in a second and stays there.
const chargeNow = (now) => Math.min(1, 0.15 + ((now - chargeFrom) / 1000) * 0.85);

function moveNow() {
  let m = 0;
  for (const c of keys) { if (KEY_LEFT.has(c)) m -= 1; if (KEY_RIGHT.has(c)) m += 1; }
  if (drv) m += drv.x - drv.ox > DEAD ? 1 : drv.x - drv.ox < -DEAD ? -1 : 0;
  return clamp(m, -1, 1);
}

function sayHand(now, force) {
  const [ax, ay] = aimNow();
  const h = [moveNow(), ax, ay, shots], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1] && h[2] === s[2] && h[3] === s[3]) return;
  if (!force && s && h[0] === s[0] && h[3] === s[3] && now - saidAt < AIM_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// Remembering the last aim in the keys' terms, so that a drag and the keys
// pick up where the other left off.
function keepAim() {
  const [ax, ay] = aimNow();
  const l = Math.hypot(ax, ay);
  if (l < MIN_PULL) return;
  keyAng = Math.atan2(-ay, ax);
  keyPow = Math.min(1, l / 1000);
}

// A shot: heard at once, and fired a trip later on every copy alike, if the
// table says the barrel is loaded.
function shoot() {
  wake();
  if (!world) return;
  shots = (shots + 1) % 1000;
  sayHand(performance.now(), true);
  const d = world.p[myId()];
  if (d && d.st === TANK && d.rl === 0 && Math.hypot(...aimNow()) >= MIN_PULL) sound.fire(1, d.am === BIG);
  else if (d && d.st === SKY && d.rl === 0) sound.drop();
}

function inSky() {
  const d = world && world.p[myId()];
  return !!d && d.st === SKY;
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (e.repeat) return;
    coarse = false;
    if (inSky()) { shoot(); return; }
    charging = true;
    chargeFrom = performance.now();
    return;
  }
  if (!(KEY_LEFT.has(e.code) || KEY_RIGHT.has(e.code) || KEY_UP.has(e.code) || KEY_DOWN.has(e.code))) return;
  e.preventDefault();
  coarse = false;
  keys.add(e.code);
  sayHand(performance.now(), true);
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if ((e.code === 'Space' || e.code === 'Enter') && charging) {
    keyPow = chargeNow(performance.now());
    charging = false;
    shoot();
    return;
  }
  sayHand(performance.now(), true);
});
addEventListener('blur', () => {
  keys.clear();
  charging = false;
  pull = drv = null;
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (e.pointerType === 'touch') coarse = true;
  else { coarse = false; if (e.button !== 0) return; }
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  if (coarse && y >= driveTop() && !drv) {
    drv = { id: e.pointerId, ox: x, x };
    sayHand(performance.now(), true);
    return;
  }
  if (pull) return;
  pull = { id: e.pointerId, ox: x, oy: y, x, y };
});
cv.addEventListener('pointermove', (e) => {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (drv && e.pointerId === drv.id) { drv.x = x; sayHand(performance.now(), false); return; }
  if (pull && e.pointerId === pull.id) { pull.x = x; pull.y = y; sayHand(performance.now(), false); }
});
function liftPointer(e) {
  if (drv && e.pointerId === drv.id) { drv = null; sayHand(performance.now(), true); return; }
  if (!pull || e.pointerId !== pull.id) return;
  const far = Math.hypot(pull.x - pull.ox, pull.y - pull.oy);
  const cancelled = e.type === 'pointercancel';
  if (far >= DEAD) keepAim();
  pull = null;
  // A blimp drops its bomb on any tap; a tank fires a pull, and a drag let go
  // where it started fires nothing.
  if (!cancelled && (far >= pullPx() * 0.1 || inSky())) shoot();
  else sayHand(performance.now(), true);
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
  // Keys held turn the barrel, a full half turn in two seconds.
  let turn = 0;
  for (const c of keys) { if (KEY_UP.has(c)) turn += 1; if (KEY_DOWN.has(c)) turn -= 1; }
  if (turn) keyAng = clamp(keyAng + turn * frameDt * (Math.PI / 2), -Math.PI * 0.15, Math.PI * 1.15);
  sayHand(now, false);
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a player arrives on the island. The barrel starts toward the middle.
function start() {
  const d = world && world.p[myId()];
  if (d && d.x > W / 2) keyAng = (Math.PI * 3) / 4;
  const [ax, ay] = aimNow();
  setHand([0, ax, ay, shots]);
  lastSaid = [0, ax, ay, shots];
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
