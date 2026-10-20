/**
 * @disk     splat
 * @author   claude
 * @version  2
 * @players  2-8
 * @about    A turf war in paint. Spray ink to colour the floor: your own ink is a fast lane that refills your tank, a rival's is mud. Splat a rival to splash their ground, lob ink bombs, grab the orb, and hold the most floor when time runs out.
 * @tags     game, party, realtime, paint, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/splat.png
 */
// splat.js — a floor of paint where the room's order is the referee.
//
// Every copy holds the floor, every painter and every drop of ink in flight,
// and changes them only on what comes back round the room, so every copy
// applies the same hands in the same order and holds the same floor. Nobody
// sends where they are, what they painted or whom they hit: a hand is a way to
// walk, a way to aim, whether the trigger is held, and a counter that moves on
// by one for every bomb asked for; the tank, every drop and every splat are the
// same arithmetic on every machine. A page with a console open can play its
// own painter however it likes, but no faster than its feet carry it and no
// more ink than its tank holds.
//
// While a player is alone, a bot paints with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own painter does not wait for the trip: it is drawn from the agreed
// table played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.abs`, `Math.min`,
// `Math.max` and `Math.imul` are fixed by the language to the last bit;
// `Math.sin`, `Math.cos`, `Math.atan2` and `**` are not, so nothing inside a
// step turns by an angle: every direction is a vector, and every place on the
// floor is a whole number of hundredths of a cell.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sq = (v) => v * v;
function unit(x, y) {
  const l = Math.sqrt(x * x + y * y);
  return l > 1e-9 ? [x / l, y / l] : [1, 0];
}

// A way picked at random, as a unit vector: a point in the square, kept only
// when it falls inside the circle, so every way is as likely as any other.
function randomWay(w) {
  for (let i = 0; i < 12; i++) {
    const x = draw01(w) * 2 - 1, y = draw01(w) * 2 - 1, l2 = x * x + y * y;
    if (l2 > 0.04 && l2 <= 1) return unit(x, y);
  }
  return [1, 0];
}

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own painter a trip ahead, with your hand in it

// The floor is a grid of cells; a place on it is in hundredths of a cell, so
// every position in the table is a whole number. A cell holds '.' when it is
// bare, '#' when it is a wall, and a seat's colour as one digit when it is
// painted.
const W = 40, H = 30, N = W * H;
const CELL = 100;
const BARE = '.', WALL = '#';
const R = 36;                  // a painter's radius
const SPEED_OWN = 30;          // a step's walk on your own ink,
const SPEED_BARE = 21;         // on bare floor,
const SPEED_FOE = 12;          // and wading through a rival's
const FIRE_SLOW = 0.75;        // how much of that is left while spraying
const TANK = 1000, TANK_BIG = 1300; // a tank; whoever has won fewest rounds carries a bigger one
const SHOT_COST = 40;          // ink a drop costs,
const SHOT_EVERY = 2;          // steps between two drops,
const SHOT_V = 90;             // how far a drop flies a step,
const SHOT_LIFE = 7;           // and for how many steps before it lands
const SHOT_HIT = 55;           // how close a drop must pass a rival to hit them
const SHOT_MAX = 160;
const SPLASH = 135;            // how far a landing drop spreads,
const SPLASH_MORE = 45;        // and how much further in the rush or for whoever trails
const REFILL_WAIT = 8;         // steps off the trigger before the tank refills,
const REFILL_OWN = 18;         // what it takes back a step on your own ink,
const REFILL_BARE = 5;         // on bare floor, and nothing on a rival's
const HP = 5;                  // drops a painter takes before being splatted
const REGEN_WAIT = 30;         // steps unhit before a painter starts to mend,
const REGEN_EVERY = 8;         // and steps between two drops' worth mended
const BOMB_COST = 350, BOMB_CD = 40;
const BOMB_V = 48, BOMB_LIFE = 12; // a bomb flies this far a step for this many steps,
const BOMB_R = 300;            // then paints this far round,
const BOMB_HURT = 250;         // and hurts anybody this close,
const BOMB_DMG = 3;            // this many drops' worth
const BOMB_MAX = 16;
const SPLAT_R = 250;           // the splash a splatted painter leaves in the colour of whoever did it
const BACK_STEPS = 3 * HZ;     // steps from being splatted to painting again,
const BACK_FAST = 2 * HZ;      // and for whoever trails
const SHIELD = 30;             // steps a painter back on its pad cannot be hit
const ORB_EVERY = 15 * HZ;     // steps between two ink orbs,
const ORB_RUSH = 7 * HZ;       // and in the rush
const ORB_R = 350;             // how far an orb paints for whoever grabs it
const ORB_GRAB = 75;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 80 * HZ;
const END_STEPS = 7 * HZ;
const RUSH_AT = 60 * HZ;       // steps into a round when the ink rush starts

const LIVE = 0, DOWN = 1;

// Each seat's pad, in cells, every other one opposite the last through the
// middle of the floor, so two players start in opposite corners.
const PADS = [[3, 3], [36, 26], [36, 3], [3, 26], [19, 2], [20, 27], [2, 14], [37, 15]];
const MIDX = (W * CELL) / 2, MIDY = (H * CELL) / 2;

// The cell at a place, read from the floor as a string or as an array alike;
// past the edge is a wall.
const cellAt = (g, cx, cy) => (cx < 0 || cy < 0 || cx >= W || cy >= H ? WALL : g[cy * W + cx]);
const cellOf = (g, x, y) => cellAt(g, Math.floor(x / CELL), Math.floor(y / CELL));

// While a step runs, the floor is an array of cells; it goes back into the
// table as a string, which prints shortly and compares at a glance.
let cells = null;
function withCells(w, fn) {
  if (cells) { fn(); return; }
  cells = w.g.split('');
  try { fn(); } finally { w.g = cells.join(''); cells = null; }
}

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   g: the floor; sh: drops in flight, [x, y, vx, vy, thrower, steps left,
//   colour]; bm: bombs, the same; ob: the cell the ink orb sits on, or -1;
//   res: the last round's [id, cells, splats, rounds won] rows; win: its winner
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, g: '', sh: [], bm: [], ob: -1, p: {}, res: null, win: -1 };
  lay(w);
  return w;
}

// A fresh floor: bare, with a few blocks of wall laid out the same through
// the middle point, so every pad faces the same floor as the one opposite.
// Blocks never touch each other, the pads or the middle, so no corner of the
// floor is ever shut off.
function lay(w) {
  const g = new Array(N).fill(BARE);
  const kept = (cx, cy) => (Math.abs(cx * 2 + 1 - W) <= 7 && Math.abs(cy * 2 + 1 - H) <= 7) ||
    PADS.some(([px, py]) => Math.abs(px - cx) <= 3 && Math.abs(py - cy) <= 3);
  const want = 5 + Math.floor(draw01(w) * 4);
  for (let made = 0, tries = 0; made < want && tries < 80; tries++) {
    const wide = draw01(w) < 0.5;
    const bw = wide ? 2 + Math.floor(draw01(w) * 3) : 2;
    const bh = wide ? 2 : 2 + Math.floor(draw01(w) * 3);
    const x0 = 2 + Math.floor(draw01(w) * (W / 2 - 1 - bw));
    const y0 = 2 + Math.floor(draw01(w) * (H - 3 - bh));
    let ok = true;
    for (let cy = y0 - 1; cy <= y0 + bh && ok; cy++) {
      for (let cx = x0 - 1; cx <= x0 + bw && ok; cx++) {
        const inside = cx >= x0 && cx < x0 + bw && cy >= y0 && cy < y0 + bh;
        if (cellAt(g, cx, cy) === WALL && cx >= 0 && cy >= 0 && cx < W && cy < H) ok = false;
        if (inside && kept(cx, cy)) ok = false;
      }
    }
    if (!ok) continue;
    for (let cy = y0; cy < y0 + bh; cy++) {
      for (let cx = x0; cx < x0 + bw; cx++) {
        g[cy * W + cx] = WALL;
        g[(H - 1 - cy) * W + (W - 1 - cx)] = WALL;
      }
    }
    made += 1;
  }
  w.g = g.join('');
  w.sh = [];
  w.bm = [];
  w.ob = -1;
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'fx', 'fy', 'mx', 'my', 'ax', 'ay', 'fi', 'q', 'hq', 'ink', 'mt', 'hp',
  'ht', 'sh', 'rt', 'cd', 'bc', 'rf', 'k', 'dn', 'wn', 'hs', 'hc', 'bw', 'lx', 'ly', 'tx', 'ty', 'tt'];
//   c: colour; s: seat; st: painting or splatted; x, y: where; fx, fy: the
//   way the painter faces, a thousand long; mx, my, ax, ay, fi: the hand — a
//   way to walk and a way to aim, a thousand at full, and the trigger; q: the
//   bomb counter as last heard; hq: a bomb to throw this step; ink, mt: the
//   tank and its size; hp: drops it can still take; ht: steps since it was
//   last hit; sh: steps of shield left; rt: steps until a splatted painter
//   is back; cd: steps until the next drop; bc: steps until the next bomb; rf:
//   steps since the trigger was last pulled; k: rivals splatted this round;
//   dn: times splatted this round; wn: rounds won; hs, hc: hands this step;
//   bw, lx, ly, tx, ty, tt: the bot's pause, where it stood when it last
//   thought, and where it is heading and for how long.
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

function newPlayer(w, q) {
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: DOWN, x: MIDX, y: MIDY, fx: 0, fy: 1000, mx: 0, my: 0, ax: 0, ay: 0,
    fi: 0, q, hq: 0, ink: TANK, mt: TANK, hp: HP, ht: 0, sh: 0, rt: BACK_STEPS, cd: 0, bc: 0, rf: 0, k: 0, dn: 0,
    wn: 0, hs: w.n, hc: 0, bw: 0, lx: 0, ly: 0, tx: 0, ty: 0, tt: 0,
  });
}

// Paint every open cell whose middle lies within r of a place, in a colour.
function splash(x, y, c, r) {
  const ch = String(c), r2 = r * r;
  const x0 = Math.max(0, Math.floor((x - r) / CELL)), x1 = Math.min(W - 1, Math.floor((x + r) / CELL));
  const y0 = Math.max(0, Math.floor((y - r) / CELL)), y1 = Math.min(H - 1, Math.floor((y + r) / CELL));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const i = cy * W + cx;
      if (cells[i] === WALL) continue;
      if (sq(cx * CELL + CELL / 2 - x) + sq(cy * CELL + CELL / 2 - y) <= r2) cells[i] = ch;
    }
  }
}

// A painter on its own pad, facing the middle, with a full tank, its pad
// painted in its colour and a shield for a moment so nobody can wait on it.
function spawn(w, id, quiet) {
  const d = w.p[id];
  const [px, py] = PADS[d.s];
  d.st = LIVE;
  d.x = px * CELL + CELL / 2;
  d.y = py * CELL + CELL / 2;
  const [ux, uy] = unit(MIDX - d.x, MIDY - d.y);
  d.fx = Math.round(ux * 1000);
  d.fy = Math.round(uy * 1000);
  d.ink = d.mt;
  d.hp = HP;
  d.ht = d.rf = 99;
  d.sh = SHIELD;
  d.rt = d.cd = d.bc = d.hq = d.bw = d.tt = 0;
  d.lx = d.x;
  d.ly = d.y;
  withCells(w, () => splash(d.x, d.y, d.c, 160));
  if (!quiet) fx(w, 'back', d.x, d.y, 0, id);
}

// A hand, at its place in the room's order: [a way to walk and a way to aim,
// a thousand at full; the trigger; the bomb counter]. A bomb is asked for once,
// when the counter changes; the same hand said again to keep a player at the
// table throws nothing. Being heard is how a player arrives: on its pad at
// once while the table waits for a round or counts one in, and a moment later
// while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[5]);
    if (w.ph === WAIT || w.ph === COUNT) spawn(w, id, w.ph === COUNT);
  } else {
    // A flood of hands in one step is cut off where no thumb could reach, on
    // every copy alike; when a bomb is ready is the table's to say.
    if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
    d.hc += 1;
    if (d.hc > HANDS_PER_STEP) return;
    if (input[5] !== d.q) { d.q = input[5]; d.hq = 1; }
  }
  d.mx = input[0];
  d.my = input[1];
  d.ax = input[2];
  d.ay = input[3];
  d.fi = input[4];
}

// A hand off the wire, made safe: six integers in their ranges, or nothing.
// How fast a painter walks is the floor's business: a hand names a way and a
// share of full stride, never a speed or a place.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 6) return null;
  const [mx, my, ax, ay, fi, q] = raw;
  if (![mx, my, ax, ay, fi, q].every(Number.isInteger)) return null;
  if ([mx, my, ax, ay].some((v) => v < -1000 || v > 1000) || fi < 0 || fi > 1 || q < 0 || q > 999) return null;
  return [mx, my, ax, ay, fi, q];
}

// Somebody gone takes their ink with them, so the colour is bare floor again
// before anybody else can be given it, and their drops and bombs in flight
// fall with them.
function leave(w, id) {
  const d = w.p[id];
  if (!d) return;
  w.g = w.g.split(String(d.c)).join(BARE);
  w.sh = w.sh.filter((s) => s[4] !== id);
  w.bm = w.bm.filter((s) => s[4] !== id);
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions
const BOT_IDLE = 0.07;         // how often it stands a moment rather than decide
const BOT_FIGHT = 0.5;         // how often it turns on a rival close by
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot paints while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    spawn(w, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

const toward = (x, y) => { const [ux, uy] = unit(x, y); return [Math.round(ux * 1000), Math.round(uy * 1000)]; };

// The nearest of a handful of cells picked at random that the bot wants.
function pickCell(w, d, want) {
  let best = null, far = Infinity;
  for (let i = 0; i < 28; i++) {
    const cx = Math.floor(draw01(w) * W), cy = Math.floor(draw01(w) * H);
    if (!want(cells[cy * W + cx])) continue;
    const x = cx * CELL + CELL / 2, y = cy * CELL + CELL / 2;
    const f = sq(x - d.x) + sq(y - d.y);
    if (f < far) { far = f; best = [x, y]; }
  }
  return best;
}

// The bot fills its tank on its own ink when it runs low, turns on a rival
// close by about half the time, and otherwise walks to some floor that is not
// yours yet and sprays it. Stuck on a wall, it wanders off a different way.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== LIVE) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (w.n % BOT_EVERY !== 0) return;
  const own = String(d.c);
  const stuck = (d.mx !== 0 || d.my !== 0) && Math.abs(d.x - d.lx) + Math.abs(d.y - d.ly) < 6;
  d.lx = d.x;
  d.ly = d.y;
  if (stuck) {
    const [ux, uy] = randomWay(w);
    d.mx = Math.round(ux * 1000); d.my = Math.round(uy * 1000);
    d.ax = d.ay = 0; d.fi = 0; d.bw = 6; d.tt = 0;
    return;
  }
  if (draw01(w) < BOT_IDLE) { d.bw = 4 + Math.floor(draw01(w) * 10); d.mx = d.my = 0; d.fi = 0; return; }
  if (d.ink < 120) {
    const t = pickCell(w, d, (ch) => ch === own);
    if (t && sq(t[0] - d.x) + sq(t[1] - d.y) > sq(60)) [d.mx, d.my] = toward(t[0] - d.x, t[1] - d.y);
    else d.mx = d.my = 0;
    d.ax = d.ay = 0; d.fi = 0; d.tt = 0;
    return;
  }
  let foe = null, near = sq(480);
  for (const id of humans(w)) {
    const e = w.p[id];
    if (e.st !== LIVE || e.sh > 0) continue;
    const f = sq(e.x - d.x) + sq(e.y - d.y);
    if (f < near) { near = f; foe = e; }
  }
  if (foe && draw01(w) < BOT_FIGHT) {
    const ex = foe.x + (draw01(w) - 0.5) * 180, ey = foe.y + (draw01(w) - 0.5) * 180;
    [d.ax, d.ay] = toward(ex - d.x, ey - d.y);
    if (near > sq(300)) [d.mx, d.my] = [d.ax, d.ay];
    else [d.mx, d.my] = draw01(w) < 0.5 ? [-d.ay, d.ax] : [d.ay, -d.ax];
    d.fi = 1;
    if (d.bc === 0 && d.ink > BOMB_COST + 200 && draw01(w) < 0.12) d.hq = 1;
    return;
  }
  if (d.tt <= 0 || cellOf(cells, d.tx, d.ty) === own) {
    const t = pickCell(w, d, (ch) => ch !== own && ch !== WALL);
    if (!t) { d.mx = d.my = 0; d.fi = 0; return; }
    d.tx = t[0]; d.ty = t[1]; d.tt = 2 * HZ;
  }
  d.tt -= BOT_EVERY;
  const dx = d.tx - d.x, dy = d.ty - d.y, f = dx * dx + dy * dy;
  [d.ax, d.ay] = toward(dx, dy);
  if (f > sq(260)) [d.mx, d.my] = [d.ax, d.ay];
  else d.mx = d.my = 0;
  d.fi = f < sq(640) ? 1 : 0;
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  lay(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    d.mt = TANK;
    d.k = d.dn = 0;
    spawn(w, id, true);
  }
}

// A round: a fresh floor, the seats closed up in order, everybody on a pad of
// their own. Whoever has won the fewest rounds, when somebody has won more,
// carries a bigger tank.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  lay(w);
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) { lo = Math.min(lo, w.p[id].wn); hi = Math.max(hi, w.p[id].wn); }
  for (const id of ids) {
    const d = w.p[id];
    d.mt = hi > lo && d.wn === lo ? TANK_BIG : TANK;
    d.k = d.dn = 0;
    spawn(w, id, true);
  }
  fx(w, 'round', 0, 0, 0);
}

// Cells of each colour on a floor.
function countCells(g) {
  const n = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    const v = g[i].charCodeAt(0) - 48;
    if (v >= 0 && v < 8) n[v] += 1;
  }
  return n;
}

// The end of a round: it goes to the most floor, if nobody matches it.
function finish(w) {
  const ids = bySeat(w);
  const n = countCells(w.g);
  let top = 0;
  for (const id of ids) top = Math.max(top, n[w.p[id].c]);
  const best = ids.filter((id) => n[w.p[id].c] === top);
  w.win = best.length === 1 && ids.length > 1 && top > 0 ? best[0] : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, n[w.p[id].c], w.p[id].k, w.p[id].wn]);
  res.sort((a, b) => b[1] - a[1] || b[2] - a[2] || b[3] - a[3] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  w.sh = [];
  w.bm = [];
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
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // The floor stands still while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) w.p[id].hq = 0;
    return;
  }
  withCells(w, () => run(w));
}

// Whoever trails: the colours with the least floor, once somebody has more.
function trailers(w, n) {
  const ids = playersIn(w);
  let lo = Infinity, hi = -Infinity;
  for (const id of ids) { lo = Math.min(lo, n[w.p[id].c]); hi = Math.max(hi, n[w.p[id].c]); }
  const out = new Set();
  if (hi > lo) for (const id of ids) if (n[w.p[id].c] === lo) out.add(w.p[id].c);
  return out;
}

function run(w) {
  const ids = bySeat(w);
  const into = w.ph === PLAY ? PLAY_STEPS - w.pt : w.n;
  const rush = w.ph === PLAY && into >= RUSH_AT;
  if (w.ph === PLAY && into === RUSH_AT) fx(w, 'rush', 0, 0, 0);
  const low = trailers(w, countCells(cells));
  botThink(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== DOWN) continue;
    d.hq = 0;
    if (d.rt > 1) d.rt -= 1;
    else spawn(w, id);
  }
  for (const id of ids) if (w.p[id].st === LIVE) walk(w.p[id]);
  for (const id of ids) if (w.p[id].st === LIVE) shoot(w, w.p[id], id);
  drops(w, ids, rush, low);
  bombs(w, ids);
  orb(w, ids, into, rush);
  for (const id of ids) {
    const d = w.p[id];
    if (d.cd > 0) d.cd -= 1;
    if (d.bc > 0) d.bc -= 1;
    if (d.sh > 0) d.sh -= 1;
    if (d.st !== LIVE) continue;
    if (d.rf < 99) d.rf += 1;
    if (d.ht < 999) d.ht += 1;
    if (d.ht >= REGEN_WAIT && d.hp < HP && d.ht % REGEN_EVERY === 0) d.hp += 1;
    if (d.rf >= REFILL_WAIT && d.ink < d.mt) {
      const under = cellOf(cells, d.x, d.y);
      let add = under === String(d.c) ? REFILL_OWN : under === BARE ? REFILL_BARE : 0;
      if (rush) add *= 2;
      if (low.has(d.c)) add = Math.floor((add * 3) / 2);
      d.ink = Math.min(d.mt, d.ink + add);
    }
  }
}

// Whether a painter standing here would overlap a wall.
const blocked = (x, y) => cellOf(cells, x - R, y - R) === WALL || cellOf(cells, x + R, y - R) === WALL ||
  cellOf(cells, x - R, y + R) === WALL || cellOf(cells, x + R, y + R) === WALL;

// Your own ink carries you, bare floor less, a rival's least of all; a
// painter spraying walks slower still. Across and along are tried apart, so a
// painter against a wall slides along it rather than sticking.
function walk(d) {
  const l = Math.sqrt(d.mx * d.mx + d.my * d.my);
  if (l < 1) return;
  const under = cellOf(cells, d.x, d.y);
  let v = under === String(d.c) ? SPEED_OWN : under === BARE ? SPEED_BARE : SPEED_FOE;
  if (d.fi && d.ink >= SHOT_COST) v *= FIRE_SLOW;
  const k = (v * Math.min(1, l / 1000)) / l;
  const nx = Math.round(d.x + d.mx * k);
  if (!blocked(nx, d.y)) d.x = nx;
  const ny = Math.round(d.y + d.my * k);
  if (!blocked(d.x, ny)) d.y = ny;
}

// The way a painter faces: where it aims, or else where it walks, or else
// where it faced already.
function face(d) {
  let ax = d.ax, ay = d.ay;
  if (ax === 0 && ay === 0) { ax = d.mx; ay = d.my; }
  if (ax === 0 && ay === 0) return;
  [d.fx, d.fy] = toward(ax, ay);
}

// A bomb asked for flies off the way the painter faces, if one is ready and
// the tank holds enough for it. The trigger held lets a drop go every other
// step while there is ink for it; held on an empty tank it only sputters, and
// the tank still refills.
function shoot(w, d, id) {
  face(d);
  const ux = d.fx / 1000, uy = d.fy / 1000;
  if (d.hq) {
    d.hq = 0;
    if (d.bc === 0 && d.ink >= BOMB_COST && w.bm.length < BOMB_MAX) {
      w.bm.push([d.x, d.y, Math.round(ux * BOMB_V), Math.round(uy * BOMB_V), id, BOMB_LIFE, d.c]);
      d.ink -= BOMB_COST;
      d.bc = BOMB_CD;
      d.rf = 0;
      fx(w, 'toss', d.x, d.y, 0, id);
    }
  }
  if (!d.fi || d.cd > 0) return;
  if (d.ink < SHOT_COST) { d.cd = 8; fx(w, 'dry', d.x, d.y, 0, id); return; }
  if (w.sh.length >= SHOT_MAX) return;
  const j = (draw01(w) - 0.5) * 0.2;
  w.sh.push([d.x + Math.round(ux * R), d.y + Math.round(uy * R), Math.round((ux - uy * j) * SHOT_V),
    Math.round((uy + ux * j) * SHOT_V), id, SHOT_LIFE, d.c]);
  d.ink -= SHOT_COST;
  d.cd = SHOT_EVERY;
  d.rf = 0;
}

// A drop paints the cell it flies over, splashes where it lands, splashes a
// little short of any wall it meets, and stops in the first rival it passes
// close to. A landing drop spreads further in the rush and for whoever trails.
function drops(w, ids, rush, low) {
  const keep = [];
  for (const s of w.sh) {
    const px = s[0], py = s[1];
    s[0] += s[2];
    s[1] += s[3];
    s[5] -= 1;
    if (cellOf(cells, s[0], s[1]) === WALL) { splash(px, py, s[6], SPLASH * 0.7); continue; }
    const i = Math.floor(s[1] / CELL) * W + Math.floor(s[0] / CELL);
    cells[i] = String(s[6]);
    let hit = false;
    for (const id of ids) {
      const e = w.p[id];
      if (id === s[4] || e.st !== LIVE || e.sh > 0 || e.c === s[6]) continue;
      if (sq(e.x - s[0]) + sq(e.y - s[1]) >= sq(SHOT_HIT + R * 0.5)) continue;
      splash(s[0], s[1], s[6], SPLASH * 0.7);
      hurt(w, id, s[4], 1);
      hit = true;
      break;
    }
    if (hit) continue;
    if (s[5] <= 0) {
      splash(s[0], s[1], s[6], SPLASH + (rush || low.has(s[6]) ? SPLASH_MORE : 0));
      fx(w, 'drop', s[0], s[1], s[6], s[4]);
      continue;
    }
    keep.push(s);
  }
  w.sh = keep;
}

// A painter hit loses a drop's worth; out of them, it is splatted: it bursts
// in the colour of whoever did it, painting the floor round it, and is back
// on its pad a few seconds on — sooner for whoever trails.
function hurt(w, vid, by, dmg) {
  const v = w.p[vid];
  v.hp -= dmg;
  v.ht = 0;
  if (v.hp > 0) { fx(w, 'hit', v.x, v.y, dmg, vid, by); return; }
  const s = w.p[by];
  if (s && by !== vid) {
    s.k += 1;
    splash(v.x, v.y, s.c, SPLAT_R);
  }
  v.dn += 1;
  fx(w, 'splat', v.x, v.y, s ? s.c : v.c, vid, s ? by : 0);
  const low = trailers(w, countCells(cells));
  v.st = DOWN;
  v.rt = low.has(v.c) ? BACK_FAST : BACK_STEPS;
  v.hp = 0;
  v.hq = v.sh = 0;
}

// A bomb flies a short arc, stops dead against a wall, and bursts where it
// comes down: a wide splash in its thrower's colour, and a hard knock for
// every rival close by.
function bombs(w, ids) {
  const keep = [];
  for (const b of w.bm) {
    const nx = b[0] + b[2], ny = b[1] + b[3];
    if (cellOf(cells, nx, ny) === WALL) { b[2] = 0; b[3] = 0; } else { b[0] = nx; b[1] = ny; }
    b[5] -= 1;
    if (b[5] > 0) { keep.push(b); continue; }
    splash(b[0], b[1], b[6], BOMB_R);
    fx(w, 'boom', b[0], b[1], b[6], b[4]);
    for (const id of ids) {
      const e = w.p[id];
      if (id === b[4] || e.st !== LIVE || e.sh > 0 || e.c === b[6]) continue;
      if (sq(e.x - b[0]) + sq(e.y - b[1]) < sq(BOMB_HURT)) hurt(w, id, b[4], BOMB_DMG);
    }
  }
  w.bm = keep;
}

// Every so often an ink orb rises near the middle of the floor, oftener in
// the rush; the first painter to reach it bursts it over the floor round it
// in their colour and fills their tank.
function orb(w, ids, into, rush) {
  if (w.ob === -1 && into > 0 && into % (rush ? ORB_RUSH : ORB_EVERY) === 0) {
    for (let tries = 0; tries < 12; tries++) {
      const cx = W / 2 - 4 + Math.floor(draw01(w) * 8), cy = H / 2 - 4 + Math.floor(draw01(w) * 8);
      if (cells[cy * W + cx] === WALL) continue;
      w.ob = cy * W + cx;
      fx(w, 'orbUp', cx * CELL + CELL / 2, cy * CELL + CELL / 2);
      break;
    }
  }
  if (w.ob === -1) return;
  const x = (w.ob % W) * CELL + CELL / 2, y = Math.floor(w.ob / W) * CELL + CELL / 2;
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== LIVE || sq(d.x - x) + sq(d.y - y) >= sq(ORB_GRAB + R)) continue;
    splash(x, y, d.c, ORB_R);
    d.ink = d.mt;
    w.ob = -1;
    fx(w, 'orb', x, y, d.c, id);
    return;
  }
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const FLOOR = /^[.#0-7]+$/;

function flying(list, most, life, speed) {
  return Array.isArray(list) && list.length <= most && list.every((s) => Array.isArray(s) && s.length === 7 &&
    int(s[0], -CELL, (W + 1) * CELL) && int(s[1], -CELL, (H + 1) * CELL) && int(s[2], -speed, speed) &&
    int(s[3], -speed, speed) && int(s[4], -BIG, BIG) && int(s[5], 0, life) && int(s[6], 0, MAX_P - 1));
}

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (typeof raw.g !== 'string' || raw.g.length !== N || !FLOOR.test(raw.g)) return null;
  if (!flying(raw.sh, SHOT_MAX, SHOT_LIFE, SHOT_V + 10) || !flying(raw.bm, BOMB_MAX, BOMB_LIFE, BOMB_V)) return null;
  if (!int(raw.ob, -1, N - 1)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, LIVE, DOWN) || !int(d.x, 0, W * CELL) || !int(d.y, 0, H * CELL)) return null;
    if (!int(d.fx, -1000, 1000) || !int(d.fy, -1000, 1000)) return null;
    if (inputOf([d.mx, d.my, d.ax, d.ay, d.fi, d.q]) === null || !int(d.hq, 0, 1)) return null;
    if (!(d.mt === TANK || d.mt === TANK_BIG) || !int(d.ink, 0, d.mt) || !int(d.hp, 0, HP) || !int(d.ht, 0, 999)) return null;
    if (!int(d.sh, 0, SHIELD) || !int(d.rt, 0, BACK_STEPS) || !int(d.cd, 0, 8) || !int(d.bc, 0, BOMB_CD)) return null;
    if (!int(d.rf, 0, 99) || !int(d.k, 0, 99999) || !int(d.dn, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG) || !int(d.bw, 0, 99)) return null;
    if (!int(d.lx, 0, W * CELL) || !int(d.ly, 0, H * CELL) || !int(d.tx, 0, W * CELL) || !int(d.ty, 0, H * CELL)) return null;
    if (!int(d.tt, -BOT_EVERY, 2 * HZ)) return null;
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
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, g: raw.g, sh: raw.sh.map((s) => s.slice()),
    bm: raw.bm.map((s) => s.slice()), ob: raw.ob, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, z, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, z: z === undefined ? 0 : z, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a slate-blue tiled floor under soft light, raised walls of
// warm stone, and every painter's ink a bright colour of its seat, with a
// darker rim so each patch reads as a puddle rather than a pixel.
const INK = {
  page: '#141a2e', glow: '#26304f', text: '#ffffff', muted: '#d5dcf0', dim: '#8d97b8', gold: '#ffd166',
  danger: '#ff5a6e', floor: '#39435f', floor2: '#343d57', wallTop: '#c9b79c', wallSide: '#7a6a55',
  frame: '#0c1022', panel: 'rgba(14,18,38,0.93)',
};
const SEAT = ['#ff4f9a', '#2fd3ff', '#ffc21a', '#7dff4a', '#a46bff', '#ff7a2e', '#22e6b0', '#f4f4f4'];
const FONT = "700 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.page};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:crosshair';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

// The floor is drawn into a canvas of its own whenever it changes, and that
// is laid on the screen every frame.
const board = document.createElement('canvas');
const bctx = board.getContext('2d');
let boardKey = '';

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #47557f;' +
  `background:#202a48;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
const SIDE = 160;              // the least a column beside the floor needs for the scoreboard
let VW = 640, VH = 400, cs = 12, ox = 0, oy = 64, TOP = 64, BOT = 26, dpx = 1, fieldTop = 64, fieldBot = 340;
let wide = false, colW = 0;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 70 : 64;
  BOT = 26;
}
layout();
window.addEventListener('resize', layout);

// The whole floor is always on screen, as large as the frame lets it be. A
// frame wider than the floor puts the status, the scoreboard, your tank and
// bomb and the line of controls in the columns either side of it, so the
// floor takes the whole height. A narrower one stacks them in strips above
// and below it, with NOTE_ROOM under it for the practice note and, in a round,
// for your tank and your bomb. Whichever of the two draws the floor bigger is
// the one used.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  const tall = Math.min((VW - 8) / W, ah / H), side = Math.min((VH - 12) / H, (VW - 2 * SIDE) / W);
  wide = side > tall;
  cs = Math.max(3, wide ? side : tall);
  ox = (VW - cs * W) / 2;
  oy = wide ? (VH - cs * H) / 2 : TOP + (ah - cs * H) / 2;
  colW = wide ? ox : 0;
  fieldTop = oy;
  fieldBot = oy + cs * H;
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

const SX = (x) => ox + (x / CELL) * cs + shakeX;
const SY = (y) => oy + (y / CELL) * cs + shakeY;
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
function alpha(hex, a) {
  const c = rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function shade(hex, k) {
  const c = rgb(hex).map((v) => Math.round(v * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
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
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.9), actx.sampleRate);
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
  spray() { if (ready('spray', 95)) puff(0.09, 0.05, 2200 + Math.random() * 600, 0, 0.9); },
  drop() { if (ready('drop', 70)) puff(0.07, 0.03, 700 + Math.random() * 300, 0, 1.5, 'lowpass'); },
  dry() { if (ready('dry', 300)) { tone(240, 0.08, 'square', 0.03, 0.6); tone(200, 0.08, 'square', 0.03, 0.6, 0.09); } },
  hit() { if (ready('hit', 60)) { tone(520, 0.07, 'triangle', 0.06, 1.4); puff(0.06, 0.05, 1600, 0, 1.4); } },
  hurt() { if (ready('hurt', 80)) { tone(180, 0.12, 'sawtooth', 0.06, 0.6); puff(0.12, 0.08, 900, 0, 0.9); } },
  splat(mine) {
    if (!ready('splat', 90)) return;
    puff(0.35, 0.16, 500, 0, 0.6, 'lowpass');
    tone(140, 0.3, 'sine', 0.08, 0.4);
    if (mine) [660, 880, 1100].forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, 0.05 + i * 0.06));
  },
  splatted() { if (ready('splatted', 200)) { puff(0.5, 0.18, 400, 0, 0.5, 'lowpass'); tone(300, 0.6, 'sawtooth', 0.06, 0.25); } },
  toss() { if (ready('toss', 120)) tone(300, 0.22, 'sine', 0.06, 2.2); },
  boom(near) { if (ready('boom', 90)) { puff(0.45, 0.1 + 0.12 * near, 320, 0, 0.6, 'lowpass'); tone(90, 0.35, 'sine', 0.05 + 0.08 * near, 0.5); } },
  orbUp() { if (ready('orbUp', 400)) [988, 1319, 1568].forEach((f, i) => tone(f, 0.14, 'sine', 0.04, 0, i * 0.07)); },
  orb() { if (ready('orb', 200)) { puff(0.3, 0.12, 900, 0, 0.7); [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, i * 0.05)); } },
  back() { if (ready('back', 200)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.05)); },
  rush() { if (ready('rush', 400)) [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.12, 'triangle', 0.07, 0, i * 0.07)); },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { puff(0.4, 0.12, 1800, 0, 0.8); tone(330, 0.4, 'triangle', 0.07, 2); tone(660, 0.3, 'sine', 0.06, 1, 0.15); } },
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
// fast screen and a slow one see the same spray. Positions are floor units.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, drag }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0, flash = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, drag) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 16 + Math.random() * 20, size, colour, drag: drag || 0.9 });
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
      b.vx *= b.drag; b.vy *= b.drag;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    shake *= 0.85;
    if (shake < 0.2) shake = 0;
    flash *= 0.9;
    if (flash < 0.01) flash = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();      // id -> { seen, hit, squash }
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const lookOf = (id, now) => {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { seen: now, hit: 0, squash: 0 }));
  return look;
};

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = md && md.st === LIVE ? Math.max(0, 1 - Math.sqrt(sq(md.x - e.x) + sq(md.y - e.y)) / 1600) : 0.4;
  const now = performance.now();
  if (e.kind === 'drop') {
    spray(e.x, e.y, 3, SEAT[e.z], 160, 0.09, 0.86);
    if (e.a === me || near > 0.75) sound.drop();
  } else if (e.kind === 'dry') {
    if (e.a === me) { pop(e.x, e.y - 60, 'empty!', INK.danger, 13); sound.dry(); }
  } else if (e.kind === 'hit') {
    spray(e.x, e.y, 7, colourOf(t, e.b), 220, 0.1, 0.86);
    lookOf(e.a, now).hit = 1;
    lookOf(e.a, now).squash = 0.7;
    if (e.a === me) { shake = Math.max(shake, 4); sound.hurt(); }
    else if (e.b === me) sound.hit();
  } else if (e.kind === 'splat') {
    const c = SEAT[e.z];
    spray(e.x, e.y, 30, c, 420, 0.14, 0.88);
    spray(e.x, e.y, 10, '#ffffff', 300, 0.08, 0.88);
    ring(e.x, e.y, c, 260);
    if (e.a === me) {
      shake = Math.max(shake, 12);
      flash = Math.max(flash, 0.6);
      sound.splatted();
      pop(e.x, e.y, 'splatted!', INK.danger, 20);
    } else if (e.b === me) {
      shake = Math.max(shake, 6);
      sound.splat(true);
      pop(e.x, e.y, 'splat!', c, 20);
    } else {
      sound.splat(false);
      pop(e.x, e.y, 'splat!', c, 15);
    }
    looks.delete(e.a);
  } else if (e.kind === 'toss') {
    if (e.a === me) sound.toss();
  } else if (e.kind === 'boom') {
    const c = SEAT[e.z];
    spray(e.x, e.y, 26, c, 480, 0.13, 0.87);
    ring(e.x, e.y, c, BOMB_R);
    ring(e.x, e.y, '#ffffff', BOMB_HURT * 0.7);
    pop(e.x, e.y, 'boom!', c, e.a === me ? 18 : 14);
    shake = Math.max(shake, 2 + 8 * near);
    sound.boom(near);
  } else if (e.kind === 'orbUp') {
    ring(e.x, e.y, '#ffffff', 160);
    sound.orbUp();
  } else if (e.kind === 'orb') {
    const c = SEAT[e.z];
    spray(e.x, e.y, 34, c, 520, 0.14, 0.88);
    spray(e.x, e.y, 14, INK.gold, 360, 0.09, 0.88);
    ring(e.x, e.y, c, ORB_R);
    pop(e.x, e.y, e.a === me ? 'full tank!' : 'splash!', c, e.a === me ? 18 : 14);
    if (e.a === me) shake = Math.max(shake, 5);
    sound.orb();
  } else if (e.kind === 'back') {
    ring(e.x, e.y, colourOf(t, e.a), 140);
    if (e.a === me) { pop(e.x, e.y - 40, 'back in!', INK.text, 15); sound.back(); }
  } else if (e.kind === 'rush') {
    pop(MIDX, MIDY - 300, 'ink rush! splashes grow', INK.gold, 20);
    sound.rush();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

// The floor as a picture: tiles, then every painted cell as a disc a little
// wider than the cell, a darker one under a brighter one, so neighbouring
// cells of one colour run together into a puddle with a rim; then the walls,
// raised, with their sides in shadow.
function drawBoard(t) {
  const s = cs * dpx;
  const bw = Math.max(1, Math.round(W * s)), bh = Math.max(1, Math.round(H * s));
  const key = bw + 'x' + bh + ':' + t.g;
  if (key === boardKey) return;
  boardKey = key;
  if (board.width !== bw || board.height !== bh) { board.width = bw; board.height = bh; }
  const g = t.g;
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.fillStyle = INK.floor;
  bctx.fillRect(0, 0, bw, bh);
  bctx.fillStyle = INK.floor2;
  for (let cy = 0; cy < H; cy++) for (let cx = (cy & 1); cx < W; cx += 2) bctx.fillRect(cx * s, cy * s, s, s);
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 0; c < MAX_P; c++) {
      const ch = String(c);
      bctx.beginPath();
      let any = false;
      const r = s * (pass ? 0.64 : 0.74);
      for (let i = 0; i < N; i++) {
        if (g[i] !== ch) continue;
        const x = (i % W + 0.5) * s, y = (Math.floor(i / W) + 0.5) * s;
        bctx.moveTo(x + r, y);
        bctx.arc(x, y, r, 0, Math.PI * 2);
        any = true;
      }
      if (!any) continue;
      bctx.fillStyle = pass ? SEAT[c] : shade(SEAT[c], 0.62);
      bctx.fill();
    }
  }
  const lift = Math.max(1, s * 0.22);
  bctx.fillStyle = 'rgba(0,0,0,0.3)';
  for (let i = 0; i < N; i++) if (g[i] === WALL) bctx.fillRect((i % W) * s + lift * 0.6, Math.floor(i / W) * s + lift * 0.6, s, s);
  bctx.fillStyle = INK.wallSide;
  for (let i = 0; i < N; i++) if (g[i] === WALL) bctx.fillRect((i % W) * s, Math.floor(i / W) * s, s, s);
  bctx.fillStyle = INK.wallTop;
  for (let i = 0; i < N; i++) if (g[i] === WALL) bctx.fillRect((i % W) * s, Math.floor(i / W) * s - lift, s, s);
}

// The floor and its frame, with each seat's pad ringed in its colour.
function drawFloor(t, now) {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.8);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  const x = ox + shakeX, y = oy + shakeY, w = cs * W, h = cs * H;
  ctx.fillStyle = INK.frame;
  roundRect(x - 5, y - 5, w + 10, h + 10, 8);
  ctx.fill();
  drawBoard(t);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(board, x, y, w, h);
  for (const id of playersIn(t)) {
    const d = t.p[id];
    const [px, py] = PADS[d.s];
    ctx.strokeStyle = alpha(SEAT[d.c], 0.55 + 0.2 * Math.sin(now / 400 + d.s));
    ctx.lineWidth = Math.max(1, cs * 0.12);
    ctx.setLineDash([cs * 0.3, cs * 0.25]);
    disc(SX(px * CELL + CELL / 2), SY(py * CELL + CELL / 2), cs * 1.25);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// The ink orb: a ball of every seat's colour turning round a white heart.
function drawOrb(t, now) {
  if (t.ob === -1) return;
  const x = SX((t.ob % W) * CELL + CELL / 2), y = SY(Math.floor(t.ob / W) * CELL + CELL / 2);
  const r = Math.max(4, cs * 0.55) * (1 + 0.08 * Math.sin(now / 160));
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  disc(x, y, r * 2);
  ctx.fill();
  for (let i = 0; i < 6; i++) {
    const a = now / 500 + (i / 6) * Math.PI * 2;
    ctx.fillStyle = SEAT[i];
    disc(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.5);
    ctx.fill();
  }
  ctx.fillStyle = '#ffffff';
  disc(x, y, r * 0.42);
  ctx.fill();
}

// Drops: a bead of ink with a glint, drawn between steps; bombs: a ball on a
// low arc with its shadow on the floor, blinking faster as it comes down.
function drawFlying(t, k, now) {
  for (const s of t.sh) {
    const x = SX(s[0] - s[2] * (1 - k)), y = SY(s[1] - s[3] * (1 - k));
    const r = Math.max(1.6, cs * 0.17);
    ctx.fillStyle = shade(SEAT[s[6]], 0.6);
    disc(x, y, r * 1.25);
    ctx.fill();
    ctx.fillStyle = SEAT[s[6]];
    disc(x, y, r);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    disc(x - r * 0.3, y - r * 0.3, r * 0.35);
    ctx.fill();
  }
  for (const b of t.bm) {
    const x = SX(b[0] - b[2] * (1 - k)), y = SY(b[1] - b[3] * (1 - k));
    const l = clamp((b[5] - k) / BOMB_LIFE, 0, 1);
    const up = 4 * l * (1 - l) * cs * 1.6;
    const r = Math.max(3, cs * 0.36);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.4, r, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shade(SEAT[b[6]], 0.55);
    disc(x, y - up, r * 1.15);
    ctx.fill();
    ctx.fillStyle = Math.floor(now / (40 + 160 * l)) % 2 ? '#ffffff' : SEAT[b[6]];
    disc(x, y - up, r);
    ctx.fill();
  }
}

// A painter as drawn: a round body in its seat's colour with a tank of ink
// on its back filled as far as its own is, a nozzle the way it aims, two eyes
// looking the same way, a white flash and a squash when it is hit, a ring
// round your own, a blinking one round a shield, and pips for the drops it
// can still take once it has been hit.
function drawPainter(id, x, y, fxv, fyv, d, me, now) {
  const look = lookOf(id, now);
  look.seen = now;
  look.hit *= Math.pow(0.86, frameDt * 60);
  look.squash *= Math.pow(0.85, frameDt * 60);
  const colour = SEAT[d.c];
  const sx = SX(x), sy = SY(y), r = Math.max(4, (R / CELL) * cs * 1.15);
  const [ux, uy] = unit(fxv, fyv);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(sx + r * 0.15, sy + r * 0.75, r * 1.05, r * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  if (d.sh > 0 && Math.floor(now / 120) % 2 === 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    disc(sx, sy, r * 1.7);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (me) {
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.5;
    disc(sx, sy, r * 1.45);
    ctx.stroke();
  }
  // the tank, behind the body
  const tx = sx - ux * r * 0.85, ty = sy - uy * r * 0.85;
  ctx.fillStyle = '#1b2036';
  disc(tx, ty, r * 0.62);
  ctx.fill();
  const full = clamp(d.ink / d.mt, 0, 1);
  if (full > 0) {
    ctx.save();
    disc(tx, ty, r * 0.5);
    ctx.clip();
    ctx.fillStyle = colour;
    ctx.fillRect(tx - r, ty + r * 0.5 - r * full, r * 2, r * full + 1);
    ctx.restore();
  }
  // the nozzle
  ctx.strokeStyle = '#1b2036';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, r * 0.42);
  ctx.beginPath();
  ctx.moveTo(sx + ux * r * 0.4, sy + uy * r * 0.4);
  ctx.lineTo(sx + ux * r * 1.45, sy + uy * r * 1.45);
  ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.beginPath();
  ctx.moveTo(sx + ux * r * 1.2, sy + uy * r * 1.2);
  ctx.lineTo(sx + ux * r * 1.45, sy + uy * r * 1.45);
  ctx.stroke();
  ctx.lineCap = 'butt';
  // the body
  const sqz = 1 + look.squash * 0.3;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(sqz, 1 / sqz);
  ctx.fillStyle = shade(colour, 0.55);
  disc(0, 0, r * 1.06);
  ctx.fill();
  ctx.fillStyle = look.hit > 0.35 ? '#ffffff' : colour;
  disc(0, 0, r * 0.92);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  disc(-r * 0.3, -r * 0.35, r * 0.35);
  ctx.fill();
  ctx.restore();
  // the eyes
  const px = -uy, py = ux;
  for (const side of [-1, 1]) {
    const ex = sx + ux * r * 0.38 + px * side * r * 0.34, ey = sy + uy * r * 0.38 + py * side * r * 0.34;
    ctx.fillStyle = '#ffffff';
    disc(ex, ey, r * 0.26);
    ctx.fill();
    ctx.fillStyle = '#141a2e';
    disc(ex + ux * r * 0.1, ey + uy * r * 0.1, r * 0.13);
    ctx.fill();
  }
  if (d.hp < HP) {
    for (let i = 0; i < HP; i++) {
      ctx.fillStyle = i < d.hp ? '#ffffff' : 'rgba(255,255,255,0.22)';
      disc(sx + (i - (HP - 1) / 2) * r * 0.45, sy - r * 1.75, Math.max(1.3, r * 0.15));
      ctx.fill();
    }
  }
  if (!me && cs > 9) fitText(nickOf(id), sx, sy + r * 2.3, 10, 'rgba(255,255,255,0.75)', 80);
}

function drawBits() {
  flat();
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.strokeStyle = r.colour;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 2.5;
    disc(SX(r.x), SY(r.y), (r.r / CELL) * (0.4 + k) * cs);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const b of bits) {
    const k = b.life / b.max;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = b.colour;
    disc(SX(b.x), SY(b.y), Math.max(1, b.size * cs * (1 - k * 0.5)));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const k = p.life / p.max;
    const rise = ease(Math.min(1, k * 1.5)) * 22;
    const s = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, (k - 0.15));
    ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(12,16,34,0.75)';
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const X = clamp(SX(p.x), 60, VW - 60), Y = SY(p.y) - rise;
    ctx.strokeText(p.s, X, Y);
    ctx.fillStyle = p.colour;
    ctx.fillText(p.s, X, Y);
  }
  ctx.globalAlpha = 1;
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${(flash * 0.3).toFixed(3)})`;
    ctx.fillRect(0, 0, VW, VH);
  }
}

const clock = (steps) => {
  const s = Math.ceil(steps / HZ);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// Floor counts, worked out once for each floor drawn.
let countsFor = '', counts = [0, 0, 0, 0, 0, 0, 0, 0], openCells = N;
function countsOf(t) {
  if (t.g !== countsFor) {
    countsFor = t.g;
    counts = countCells(t.g);
    openCells = 0;
    for (let i = 0; i < N; i++) if (t.g[i] !== WALL) openCells += 1;
  }
  return counts;
}
const share = (n) => Math.round((100 * n) / Math.max(1, openCells));

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  const n = countsOf(t);
  // The status line: the phase, and the time left in it.
  let status = '', colour = INK.text;
  const into = PLAY_STEPS - t.pt;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left';
    if (into >= RUSH_AT) { status += ' · ink rush'; colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text; }
  } else status = 'round ' + t.rd + ' · over';
  text('splat', 12, 22, titlePx, '#ff8ac2', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('splat').width;
  if (wide) fitText(status, 12, 44, 14, colour, colW - 24, 'left');
  else fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with their share of the
  // floor; the chip of a splatted painter is hollow. Under it, the whole floor
  // as one bar, every colour's share of it side by side. A row across the top
  // of a narrow frame, a column down the left of a wide one with the bar at its
  // head.
  const ids = bySeat(t);
  if (ids.length) {
    const gap = 6;
    const cw = wide ? Math.min(200, colW - 24) : Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = wide ? 12 : (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    let y = wide ? 86 : narrow ? 46 : 42;
    const top = y;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      disc(x + 11, y - 2, 5);
      if (d.st === LIVE) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      const score = share(n[d.c]) + '%';
      ctx.font = font(12);
      const gw = ctx.measureText(score).width;
      text(score, x + cw - 8, y + 3, 12, c, 'right');
      const wins = t.ph !== WAIT && d.wn ? '★' + d.wn : '';
      ctx.font = font(10);
      const ww = wins ? ctx.measureText(wins).width + 5 : 0;
      if (wins && cw > 56) text(wins, x + cw - 12 - gw, y + 2, 10, '#eef1ff', 'right');
      if (cw > 64) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st === LIVE ? (mine ? INK.text : INK.muted) : INK.dim, cw - 34 - gw - ww, 'left');
      if (wide) y += 22 + gap; else x += cw + gap;
    }
    const bw = wide ? cw : Math.min(VW - 24, cs * W), bx = wide ? 12 : (VW - bw) / 2, by = wide ? top - 26 : y + 13;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    roundRect(bx, by, bw, 5, 2.5);
    ctx.fill();
    ctx.save();
    roundRect(bx, by, bw, 5, 2.5);
    ctx.clip();
    let at = bx;
    for (const id of ids) {
      const part = (bw * n[t.p[id].c]) / Math.max(1, openCells);
      ctx.fillStyle = SEAT[t.p[id].c];
      ctx.fillRect(at, by, part, 5);
      at += part;
    }
    ctx.restore();
  }

  // The one line that says how to play: across the foot of a narrow frame, and
  // broken into lines at the foot of the right-hand column of a wide one.
  const how = coarse
    ? 'left thumb walks · a second thumb sprays the way it drags · tap to lob a bomb'
    : 'WASD walks · aim with the mouse, hold to spray (or space) · right click or E lobs a bomb · M mutes';
  if (!wide) { fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20); return; }
  const lines = wrap(how, 12, colW - 24);
  lines.forEach((s, i) => text(s, VW - 12, VH - 12 - (lines.length - 1 - i) * 17, 12, INK.muted, 'right'));
}

// Your tank, your bomb and the drops you can still take while a round is on:
// in the strip under the floor, or halfway down the right-hand column of a
// wide frame, the tag under the gauge.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = wide ? VH / 2 : Math.min(fieldBot + NOTE_ROOM / 2 - 8, VH - BOT - 18);
  const mid = wide ? VW - colW / 2 : VW / 2, room = wide ? colW - 24 : VW - 24;
  if (d.st !== LIVE) {
    const line = t.ph === PLAY ? 'splatted! back on your pad in ' + Math.max(1, Math.ceil(d.rt / HZ)) : '';
    if (line) fitText(line, mid, y + 5, 13, INK.muted, room);
    return;
  }
  const bar = wide ? Math.min(140, room - 30) : Math.min(110, VW * 0.22);
  const tag = d.bc === 0 && d.ink >= BOMB_COST ? 'bomb ready' : 'bomb charging';
  ctx.font = font(12);
  const tagW = ctx.measureText(tag).width;
  const total = wide ? 30 + bar : 30 + bar + 14 + tagW;
  let x = mid - total / 2;
  if (wide) fitText(tag, mid, y + 26, 12, d.bc === 0 && d.ink >= BOMB_COST ? INK.text : INK.dim, room);
  text('ink', x, y + 4, 11, INK.dim, 'left');
  x += 30;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(x, y - 5, bar, 10, 5);
  ctx.fill();
  const k = d.ink / d.mt;
  ctx.fillStyle = k < 0.15 ? INK.danger : SEAT[d.c];
  roundRect(x, y - 5, Math.max(10, bar * k), 10, 5);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x + bar * (BOMB_COST / d.mt), y - 5, 1.5, 10);
  if (d.mt > TANK) {
    ctx.fillStyle = INK.gold;
    disc(x + bar + 4, y, 2.5);
    ctx.fill();
  }
  if (wide) return;
  x += bar + 14;
  text(tag, x, y + 4, 12, d.bc === 0 && d.ink >= BOMB_COST ? INK.text : INK.dim, 'left');
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
    const tip = two ? null : 'your own ink is a fast lane and refills your tank · a rival\'s is mud';
    // A wide frame has no strip above or below the floor: the note sits at
    // the foot of it for as long as practice lasts.
    if (wide) practiceNote(now, VW, head, tip, [], VH - 8);
    else practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,16,34,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid - big * 1.2);
    text(String(n), cx, mid - big * 1.2, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 1.8, Math.min(VW - 32, 340), 30);
    fitText('the most floor in your colour when time runs out wins', cx, mid + big * 1.8 + 5, 14, INK.text, Math.min(VW - 48, 320));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,16,34,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('splat!', cx, mid - big * 1.2);
    text('splat!', cx, mid - big * 1.2, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= 5 * HZ) {
    const n = Math.ceil(t.pt / HZ);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(12,16,34,0.6)';
    ctx.font = font(big * 2);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid - big * 1.2);
    text(String(n), cx, mid - big * 1.2, big * 2, INK.gold, 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 330), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody holds the most floor';
    else head = t.win === me ? 'the floor is yours!' : nickOf(t.win) + ' holds the most floor';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('floor', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('splats', cx + w / 2 - 62, y0 + 52, 10, INK.dim, 'right');
    text('rounds', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    countsOf(t);
    rows.forEach(([id, cellsHeld, kn, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(share(cellsHeld) + '%', cx + w / 2 - 110, y, 14, c, 'right');
      text(String(kn), cx + w / 2 - 62, y, 13, '#eef1ff', 'right');
      text('★' + wins, cx + w / 2 - 18, y, 13, INK.text, 'right');
    });
    fitText('a splat paints the floor where it lands · next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a painter is as drawn: between two steps, and never slid across a
// jump — a painter back on its pad.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 150) return [z.x, z.y, z.fx, z.fy, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), lerp(a.fx, z.fx, b.k), lerp(a.fy, z.fy, b.k), z];
}

// Your own painter is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a hand a step away from
// where the guess had it. So the painter drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a painter back on its pad — puts it there at once. Only the
// drawing is smoothed: the floor, and every rule on it, are untouched.
const PULL = 0.45;
let shown = null;        // [x, y]: where your painter is drawn
let myPos = null;        // the same, for the mouse to aim from

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
  if (!b) {
    flat();
    ctx.fillStyle = INK.page;
    ctx.fillRect(0, 0, VW, VH);
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the floor…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  const m = mineAt(now);
  drawFloor(t, now);
  drawOrb(t, now);
  drawFlying(t, b.k, now);
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st !== LIVE) continue;
    const p = bodyAt(b, id);
    drawPainter(id, p[0], p[1], p[2], p[3], d, false, now);
  }
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own && own.to.p[me].st === LIVE) {
    const p = bodyAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    const d = p[4];
    myPos = [x, y];
    drawPainter(me, x, y, p[2], p[3], d, true, now);
    if (d.fi && d.ink >= SHOT_COST && t.ph !== COUNT && t.ph !== END) sound.spray();
  } else {
    myPos = shown = null;
  }
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: which way to walk, which way to aim, whether the
// trigger is held, and how many bombs so far. A change of aim or walk goes out
// no oftener than STEER_EVERY, because a thumb or a mouse changes it on every
// move the screen reports and the clock's ticks share the same seat's ceiling
// on messages; the trigger and a bomb go out at once.
const STEER_EVERY = 80;
let aimByMouse = false;  // whether the pointer aims: once the mouse has moved over the floor
let thrown = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_X = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
const KEY_Y = { ArrowUp: -1, KeyW: -1, ArrowDown: 1, KeyS: 1 };
const FIRE_KEYS = new Set(['Space', 'KeyJ', 'Enter']);
const BOMB_KEYS = new Set(['KeyE', 'KeyK', 'KeyQ', 'ShiftLeft', 'ShiftRight']);
let fireKey = false;

// The keys walk; space sprays the way the mouse points, or the way you walk.
// A thumb: the first one down is a stick from wherever it lands, walking the
// way it is pushed and further the further; a second one down sprays while it
// stays, the way it is dragged or else the way you walk; a quick tap of either
// lobs a bomb — a drag rather than a press, because iOS keeps a long press
// inside a frame for itself. A mouse: the pointer aims, a held button sprays,
// the right button lobs a bomb.
const DEAD = 9;
const REACHOUT = 52;
let walkStick = null;    // { id, ox, oy, dx, dy, at, moved }
let sprayStick = null;   // the same, for the second thumb
const mouse = { x: 0, y: 0, down: false };

function handNow() {
  let mx = 0, my = 0, ax = 0, ay = 0, fi = 0;
  if (walkStick) {
    const l = Math.hypot(walkStick.dx, walkStick.dy);
    if (l >= DEAD) {
      const k = clamp(0.35 + (0.65 * (l - DEAD)) / (REACHOUT - DEAD), 0.35, 1);
      mx = Math.round((walkStick.dx / l) * 1000 * k);
      my = Math.round((walkStick.dy / l) * 1000 * k);
    }
  } else {
    let sx = 0, sy = 0;
    for (const c of keys) { if (c in KEY_X) sx += KEY_X[c]; if (c in KEY_Y) sy += KEY_Y[c]; }
    sx = clamp(sx, -1, 1);
    sy = clamp(sy, -1, 1);
    if (sx || sy) {
      const l = Math.hypot(sx, sy);
      mx = Math.round((sx / l) * 1000);
      my = Math.round((sy / l) * 1000);
    }
  }
  if (sprayStick) {
    fi = 1;
    const l = Math.hypot(sprayStick.dx, sprayStick.dy);
    if (l >= DEAD) { ax = Math.round((sprayStick.dx / l) * 1000); ay = Math.round((sprayStick.dy / l) * 1000); }
  } else if (aimByMouse && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]);
    const l = Math.hypot(dx, dy);
    // A way rounded to a few dozen, so a mouse at rest says nothing new.
    if (l >= 4) { ax = Math.round((dx / l) * 20) * 50; ay = Math.round((dy / l) * 20) * 50; }
    if (mouse.down) fi = 1;
  }
  if (fireKey) fi = 1;
  return [clamp(mx, -1000, 1000), clamp(my, -1000, 1000), clamp(ax, -1000, 1000), clamp(ay, -1000, 1000), fi, thrown];
}

function sayHand(now, force) {
  const h = handNow(), s = lastSaid;
  if (s && h.every((v, i) => v === s[i])) return;
  if (!force && s && h[4] === s[4] && h[5] === s[5] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A bomb: heard at once, and thrown a trip later on every copy alike, if the
// table says one is ready and the tank holds enough for it.
function bombNow() {
  wake();
  if (!world) return;
  thrown = (thrown + 1) % 1000;
  sayHand(performance.now(), true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (BOMB_KEYS.has(e.code)) { e.preventDefault(); if (!e.repeat) bombNow(); return; }
  if (FIRE_KEYS.has(e.code)) { e.preventDefault(); fireKey = true; sayHand(performance.now(), true); return; }
  if (!(e.code in KEY_X) && !(e.code in KEY_Y)) return;
  e.preventDefault();
  coarse = false;
  keys.add(e.code);
  sayHand(performance.now(), true);
});
addEventListener('keyup', (e) => {
  if (FIRE_KEYS.has(e.code)) fireKey = false;
  keys.delete(e.code);
  sayHand(performance.now(), true);
});
addEventListener('blur', () => {
  keys.clear();
  fireKey = false;
  walkStick = sprayStick = null;
  paintSticks();
  mouse.down = false;
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    const s = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0, at: performance.now(), moved: false };
    if (walkStick && sprayStick) return;
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    if (!walkStick) walkStick = s;
    else sprayStick = s;
    paintSticks();
    sayHand(performance.now(), true);
    return;
  }
  coarse = false;
  aimByMouse = true;
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  if (e.button === 2) { bombNow(); return; }
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mouse.down = true;
  sayHand(performance.now(), true);
});
cv.addEventListener('pointermove', (e) => {
  const s = walkStick && e.pointerId === walkStick.id ? walkStick : sprayStick && e.pointerId === sprayStick.id ? sprayStick : null;
  if (s) {
    s.dx = e.clientX - s.ox;
    s.dy = e.clientY - s.oy;
    if (Math.hypot(s.dx, s.dy) >= DEAD) s.moved = true;
    paintSticks();
    sayHand(performance.now(), false);
  } else if (e.pointerType === 'mouse') {
    aimByMouse = true;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
});
function liftPointer(e) {
  if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
    if (e.button === 2 || !mouse.down) return;
    mouse.down = false;
    sayHand(performance.now(), true);
    return;
  }
  const s = walkStick && e.pointerId === walkStick.id ? walkStick : sprayStick && e.pointerId === sprayStick.id ? sprayStick : null;
  if (!s) return;
  const tap = !s.moved && performance.now() - s.at < 240;
  if (s === walkStick) walkStick = null;
  else sprayStick = null;
  paintSticks();
  sayHand(performance.now(), true);
  if (tap) bombNow();
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', liftPointer);
addEventListener('pointerup', liftPointer);
addEventListener('pointercancel', liftPointer);

function stickParts(colour) {
  const ring = document.createElement('div');
  ring.style.cssText =
    `position:fixed;display:none;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
    `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;pointer-events:none;` +
    `border:1px solid ${colour};background:rgba(255,255,255,0.06)`;
  const knob = document.createElement('div');
  knob.style.cssText =
    'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
    'border-radius:50%;pointer-events:none;background:#ffffff;opacity:.55';
  document.body.append(ring, knob);
  return [ring, knob];
}
const walkParts = stickParts('rgba(255,255,255,0.35)');
const sprayParts = stickParts('rgba(255,138,194,0.6)');

function paintStick(s, [ring, knob]) {
  if (!s) { ring.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(s.dx, s.dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
  ring.style.display = knob.style.display = 'block';
  ring.style.left = s.ox + 'px';
  ring.style.top = s.oy + 'px';
  knob.style.left = s.ox + s.dx * k + 'px';
  knob.style.top = s.oy + s.dy * k + 'px';
}
function paintSticks() {
  paintStick(walkStick, walkParts);
  paintStick(sprayStick, sprayParts);
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
// a player arrives on the floor.
function start() {
  setHand([0, 0, 0, 0, 0, thrown]);
  lastSaid = [0, 0, 0, 0, 0, thrown];
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
