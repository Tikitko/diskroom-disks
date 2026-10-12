/**
 * @disk     snowball
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Roll a snowball over fresh snow and it grows. Crash into a smaller ball to burst it and take half its snow, but the bigger you roll, the slower you turn. Lunge to catch or flee, mind the trees, and outrun the thaw. Biggest ball at the whistle wins.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/snowball.png
 */
// snowball.js — a snowfield where the room's order is the referee.
//
// Every copy holds every cell of snow and how deep it lies, every tree, and
// every ball, how much snow it carries and how fast it rolls, and changes it
// only on what comes back round the room, so every copy applies the same hands
// in the same order and holds the same field. Nobody sends how big they are,
// what they picked up or whom they burst: a hand is the way a player pushes
// and a counter that moves on by one for every lunge, and everything else is
// the same arithmetic on the same whole numbers on every machine. A page with
// a console open can steer its own ball however it likes, at that ball's own
// speed, and lunge no oftener than the cooldown allows, paying for each.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own ball does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — a cell is 256 units across, a speed
// is units a step, a ball's size is the snow it carries — and use nothing but
// `+ - * /`, comparisons, `Math.floor`, `Math.trunc`, `Math.min`, `Math.max`,
// `Math.abs`, `Math.sqrt` and `Math.imul`, whose results the language fixes to
// the last bit. Trigonometry appears only in the drawing, which is nobody's
// business but the screen's.

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
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own ball a trip ahead, with your hand in it

// The field: cells of snow on frozen grass, a cell 256 units across.
const CELL = 256, HALF = 128;
const GW = 20, GH = 15, NC = GW * GH;
const FW = GW * CELL, FH = GH * CELL;
const DMAX = 4;                // the deepest a cell gets: a burst piles snow up
const D0 = 2;                  // how deep a fresh field lies
const REFILL = 3;              // fresh snow falls on a cell up to this deep
const FALLS = 2;               // cells snowed on in a step
const SNOW = 12;               // what one depth of one cell adds to a ball

// A ball is the snow it carries; its radius grows with the square root of it,
// so a ball twice the snow is not twice as wide.
const M0 = 360;                // a fresh ball
const MIN_M = 220;             // nothing melts or chips a ball smaller
const MMAX = 20000;
const HEAD_START = 120;        // more snow a round starts with for whoever trails
const BURST_OVER = 5;          // a ball bursts another it outweighs by five to four
const BURST_OF = 4;
const SHIELD = 40;             // steps a ball back on the field can neither burst nor be burst
const BACK_STEPS = 30;         // steps from a burst to rolling again
const LUNGE_V = 40;            // what a lunge adds to the top speed
const LUNGE_CD = 30;           // steps between two lunges
const LUNGE_HOLD = 10;         // steps of a lunge that steering cannot bend
const LUNGE_COST = 7;          // per cent of a ball a lunge sheds behind it
const VMAX = 120;              // the fastest any ball ever goes
const BUMP = 3;                // what two balls that touch give each other at the least
const TREES = 6;
const TREE_R = 110;
const SUN_FROM = 2500;         // the biggest ball melts in the sun from this size on
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 80 * HZ;
const END_STEPS = 6 * HZ;
const THAW_AT = 45 * HZ;       // steps into a round when the rim starts to thaw
const THAW_EVERY = 5 * HZ;     // steps between two rings of it
const TH_MAX = 5;              // rings that thaw before the whistle

const ROLL = 0, GONE = 1;

const rOf = (m) => isqrt(m * 40);
const vmaxOf = (r) => Math.max(14, 40 - Math.trunc(r / 16));
// How much of the gap to the speed pushed for a step closes, in 64ths: a big
// ball carries its speed and turns wide.
const turnOf = (r) => Math.max(5, 30 - Math.trunc(r / 20));
const tvOf = (th) => Math.trunc((th * 3) / 4);
const inZone = (th, i, j) => i >= th && i < GW - th && j >= tvOf(th) && j < GH - tvOf(th);
const cellI = (x) => clamp(Math.floor(x / CELL), 0, GW - 1);
const cellJ = (y) => clamp(Math.floor(y / CELL), 0, GH - 1);
const clampV = (v) => (v < -VMAX ? -VMAX : v > VMAX ? VMAX : v);
const canBurst = (a, b) => a.st === ROLL && b.st === ROLL && a.sh === 0 && b.sh === 0 && a.m * BURST_OF >= b.m * BURST_OVER;

// Where each seat starts a round, as cells: corners first, so two players
// start as far apart as the field allows.
const SPOT = [[2, 2], [17, 12], [17, 2], [2, 12], [9, 2], [10, 12], [2, 7], [17, 7]];
const spotOf = (s) => [SPOT[s][0] * CELL + HALF, SPOT[s][1] * CELL + HALF];

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   th: rings of the rim thawed; sn: every cell's snow, row by row, 0 bare to
//   DMAX; tr: the trees, [x, y]; res: the last round's [id, balls outsized,
//   points, rounds won, size] rows; win: its winner
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, th: 0, sn: [], tr: [], p: {}, res: null, win: -1 };
  lay(w);
  return w;
}

// A fresh field: snow everywhere, and trees where nobody starts.
function lay(w) {
  w.th = 0;
  w.sn = new Array(NC).fill(D0);
  w.tr = [];
  for (let tries = 0; tries < 200 && w.tr.length < TREES; tries++) {
    const i = 3 + Math.floor(draw01(w) * (GW - 6)), j = 3 + Math.floor(draw01(w) * (GH - 6));
    if (SPOT.some(([a, b]) => Math.max(Math.abs(a - i), Math.abs(b - j)) < 2)) continue;
    if (w.tr.some(([x, y]) => Math.max(Math.abs(cellI(x) - i), Math.abs(cellJ(y) - j)) < 3)) continue;
    w.tr.push([i * CELL + HALF, j * CELL + HALF]);
  }
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'vx', 'vy', 'dx', 'dy', 'q', 'hq', 'm', 'cd', 'sh', 'rt', 'bu', 'ot',
  'pts', 'wn', 'bt', 'bw', 'bc', 'hs', 'hc'];
//   c: colour; s: seat; st: rolling or burst; x, y, vx, vy: where and how fast,
//   in units; dx, dy: the way the hand pushes, a thousand at full; q: the lunge
//   counter as last heard; hq: a lunge to take this step; m: snow carried; cd:
//   steps until the next lunge; sh: steps of shield left; rt: steps until a
//   burst ball rolls again; bu: balls burst this round; ot: balls outsized at
//   the last whistle; pts: points; wn: rounds won; bt, bw: the bot's heading
//   and its pause; bc: steps until a knock chips again; hs, hc: hands this step.
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
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: GONE, x: FW / 2, y: FH / 2, vx: 0, vy: 0, dx: 0, dy: 0, q, hq: 0,
    m: M0, cd: 0, sh: 0, rt: BACK_STEPS, bu: 0, ot: -1, pts: 0, wn: 0, bt: -1, bw: 0, bc: 0, hs: w.n, hc: 0,
  });
}

// A ball put down on the field, still.
function place(d, x, y, m) {
  d.st = ROLL;
  d.x = x;
  d.y = y;
  d.vx = d.vy = d.cd = d.sh = d.rt = d.hq = d.bw = 0;
  d.m = m;
  d.bt = -1;
}

function clampPos(d) {
  const r = Math.min(rOf(d.m), FH / 2);
  d.x = clamp(d.x, r, FW - r);
  d.y = clamp(d.y, r, FH - r);
}

// Back on the field after a burst: the best of a few spots inside the snow,
// clear of the trees and as far from every other ball as they come, shielded
// for a moment so nobody can wait on a spot.
function respawn(w, id) {
  const d = w.p[id];
  const tv = tvOf(w.th);
  let best = null, score = -Infinity;
  for (let k = 0; k < 16; k++) {
    const i = w.th + 1 + Math.floor(draw01(w) * Math.max(1, GW - 2 * w.th - 2));
    const j = tv + 1 + Math.floor(draw01(w) * Math.max(1, GH - 2 * tv - 2));
    const x = i * CELL + HALF, y = j * CELL + HALF;
    if (w.tr.some(([a, b]) => Math.abs(a - x) + Math.abs(b - y) < 2 * CELL)) continue;
    let near = 1e9;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o === id || e.st !== ROLL) continue;
      near = Math.min(near, Math.abs(e.x - x) + Math.abs(e.y - y) - rOf(e.m));
    }
    if (near > score) { score = near; best = [x, y]; }
  }
  if (!best) best = spotOf(d.s);
  place(d, best[0], best[1], M0);
  d.sh = SHIELD;
  fx(w, 'back', d.x, d.y, 0, id);
}

// A hand, at its place in the room's order: [the way pushed, across and down,
// the lunge counter]. A lunge is asked for once, when the counter changes; the
// same hand said again to keep a player at the table lunges nobody. Being
// heard is how a player arrives: on the field at once while the table waits
// for a round or counts one in, and a moment later while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[2]);
    if (w.ph === WAIT) respawn(w, id);
    else if (w.ph === COUNT) { const [x, y] = spotOf(d.s); place(d, x, y, M0); }
    d.dx = input[0];
    d.dy = input[1];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; what a lunge costs is the table's to say, not the hand's.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.dx = input[0];
  d.dy = input[1];
  if (input[2] !== d.q) { d.q = input[2]; d.hq = 1; }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
// How fast a ball goes is the table's business: a push names a share of the
// top speed, and nothing a hand says makes it more than all of it.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [a, b, q] = raw;
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(q)) return null;
  if (a < -1000 || a > 1000 || b < -1000 || b > 1000 || q < 0 || q > 999) return null;
  return [a, b, q];
}

function leave(w, id) {
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions
const BOT_IDLE = 0.07;         // how often it stands a moment rather than decide
const BOT_LUNGE = 0.3;         // how often it lunges when a lunge would pay
// Twelve ways to go, a thousand long, whole numbers on every machine.
const BDIR = [[1000, 0], [866, 500], [500, 866], [0, 1000], [-500, 866], [-866, 500], [-1000, 0], [-866, -500],
  [-500, -866], [0, -1000], [500, -866], [866, -500]];
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

// How good a way looks: snow along it, no wall, thaw or tree close ahead, a
// smaller ball it points at and a bigger one it points away from.
function wayScore(w, d, k, r) {
  const [ux, uy] = BDIR[k];
  let s = 0;
  for (let n = 1; n <= 5; n++) {
    const far = r + 150 * n;
    const px = d.x + Math.trunc((ux * far) / 1000), py = d.y + Math.trunc((uy * far) / 1000);
    if (px < 0 || px >= FW || py < 0 || py >= FH) { s -= n <= 2 ? 30 : 8; break; }
    const i = Math.floor(px / CELL), j = Math.floor(py / CELL);
    if (!inZone(w.th, i, j)) { s -= n <= 2 ? 20 : 6; break; }
    s += w.sn[j * GW + i] * (6 - n);
    if (n <= 2) for (const [tx, ty] of w.tr) if (Math.abs(px - tx) + Math.abs(py - ty) < TREE_R + r) s -= 12;
  }
  for (const o of playersIn(w)) {
    const e = w.p[o];
    if (o === BOT_ID || e.st !== ROLL) continue;
    const ex = e.x - d.x, ey = e.y - d.y, far = isqrt(ex * ex + ey * ey) || 1;
    if (far >= 7 * CELL) continue;
    const dot = Math.trunc((ux * ex + uy * ey) / far), close = 7 * CELL - far;
    if (canBurst(d, e)) s += Math.trunc((dot * close) / 30000);
    else if (canBurst(e, d) || (e.sh > 0 && e.m * BURST_OF >= d.m * BURST_OVER)) s -= Math.trunc((dot * close) / 20000);
  }
  if (w.th > 0) s += Math.trunc((-(d.x - FW / 2) * ux - (d.y - FH / 2) * uy) / 200000);
  return s;
}

function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.st !== ROLL) return;
  if (d.bw > 0) { d.bw -= 1; d.dx = d.dy = 0; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 3 + Math.floor(draw01(w) * 6); d.dx = d.dy = 0; return; }
  const r = rOf(d.m);
  let best = 0, score = -Infinity;
  for (let k = 0; k < BDIR.length; k++) {
    const s = wayScore(w, d, k, r) + (k === d.bt ? 4 : 0) + Math.floor(draw01(w) * 4);
    if (s > score) { score = s; best = k; }
  }
  d.bt = best;
  d.dx = BDIR[best][0];
  d.dy = BDIR[best][1];
  if (d.cd > 0 || d.m < MIN_M + 200) return;
  // A lunge at a smaller ball just ahead, or away from a bigger one close by.
  for (const o of humans(w)) {
    const e = w.p[o];
    if (e.st !== ROLL) continue;
    const ex = e.x - d.x, ey = e.y - d.y;
    const gap = isqrt(ex * ex + ey * ey) - r - rOf(e.m);
    if (gap >= 2 * CELL) continue;
    const ahead = ex * BDIR[best][0] + ey * BDIR[best][1] > 0;
    if (((canBurst(d, e) && ahead) || (canBurst(e, d) && !ahead)) && draw01(w) < BOT_LUNGE) { d.hq = 1; return; }
  }
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
    const [x, y] = spotOf(d.s);
    place(d, x, y, M0);
  }
}

// A round: a fresh field, the seats closed up in order, everybody at a spot
// of their own with a fresh ball. Whoever has the fewest points, when
// somebody has more, starts a little bigger.
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
  for (const id of ids) { lo = Math.min(lo, w.p[id].pts); hi = Math.max(hi, w.p[id].pts); }
  for (const id of ids) {
    const d = w.p[id];
    const [x, y] = spotOf(d.s);
    place(d, x, y, M0 + (hi > lo && d.pts === lo ? HEAD_START : 0));
    d.bu = 0;
  }
  fx(w, 'round', 0, 0, 0);
}

// The whistle: a point for every ball yours outweighs, and the round to the
// biggest ball if nobody matches it.
function finish(w) {
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    d.ot = ids.filter((o) => w.p[o].m < d.m).length;
  }
  let top = -1;
  for (const id of ids) top = Math.max(top, w.p[id].ot);
  const best = ids.filter((id) => w.p[id].ot === top);
  w.win = best.length === 1 && ids.length > 1 ? best[0] : -1;
  for (const id of ids) w.p[id].pts += w.p[id].ot;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, w.p[id].ot, w.p[id].pts, w.p[id].wn, w.p[id].m]);
  res.sort((a, b) => b[4] - a[4] || b[2] - a[2] || b[3] - a[3] || a[0] - b[0]);
  w.res = res;
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
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      d.hq = 0;
      d.vx = d.vy = 0;
    }
    return;
  }
  roll(w);
}

function roll(w) {
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== GONE) continue;
    d.hq = 0;
    if (d.rt > 1) d.rt -= 1;
    else respawn(w, id);
  }
  for (const id of ids) if (w.p[id].st === ROLL) control(w, w.p[id], id);
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== ROLL) continue;
    d.x += d.vx;
    d.y += d.vy;
    walls(d);
    if (d.cd > 0) d.cd -= 1;
    if (d.sh > 0) d.sh -= 1;
    if (d.bc > 0) d.bc -= 1;
  }
  trees(w, ids);
  clash(w, ids);
  for (const id of ids) if (w.p[id].st === ROLL) gather(w, w.p[id]);
  melt(w, ids);
  snowfall(w);
  if (w.ph === PLAY) thaw(w);
}

// A push becomes a speed, a share of the gap closed each step, and the
// bigger the ball the smaller the share. A lunge asked for is taken if the
// cooldown is over and the ball has snow to shed: it flings the ball the way
// pushed and leaves a heap of its snow behind.
function control(w, d, id) {
  const r = rOf(d.m), vm = vmaxOf(r);
  if (d.hq) {
    d.hq = 0;
    if (d.cd === 0 && d.m >= MIN_M + 60) {
      const push = isqrt(d.dx * d.dx + d.dy * d.dy), sp = isqrt(d.vx * d.vx + d.vy * d.vy);
      let ux = 0, uy = 0, l = 0;
      if (push >= 300) { ux = d.dx; uy = d.dy; l = push; } else if (sp >= 3) { ux = d.vx; uy = d.vy; l = sp; }
      if (l) {
        const cost = Math.min(d.m - MIN_M, Math.max(20, Math.trunc((d.m * LUNGE_COST) / 100)));
        d.m -= cost;
        d.vx = clampV(Math.trunc((ux * (vm + LUNGE_V)) / l));
        d.vy = clampV(Math.trunc((uy * (vm + LUNGE_V)) / l));
        d.cd = LUNGE_CD;
        deposit(w, d.x - Math.trunc((ux * (r + CELL)) / l), d.y - Math.trunc((uy * (r + CELL)) / l), cost, null);
        fx(w, 'lunge', d.x, d.y, cost, id);
        return;
      }
    }
  }
  const push = isqrt(d.dx * d.dx + d.dy * d.dy);
  const tx = push < 120 ? 0 : Math.trunc((d.dx * vm) / Math.max(push, 1000));
  const ty = push < 120 ? 0 : Math.trunc((d.dy * vm) / Math.max(push, 1000));
  const k = d.cd > LUNGE_CD - LUNGE_HOLD ? 2 : turnOf(r);
  d.vx += Math.trunc(((tx - d.vx) * k) / 64);
  d.vy += Math.trunc(((ty - d.vy) * k) / 64);
  if (Math.abs(tx - d.vx) <= 2) d.vx = tx;
  if (Math.abs(ty - d.vy) <= 2) d.vy = ty;
}

// The field's edge is a bank: a ball stops at it and rolls back a little.
function walls(d) {
  const r = Math.min(rOf(d.m), FH / 2);
  if (d.x < r) { d.x = r; if (d.vx < 0) d.vx = -Math.trunc(d.vx / 2); }
  if (d.x > FW - r) { d.x = FW - r; if (d.vx > 0) d.vx = -Math.trunc(d.vx / 2); }
  if (d.y < r) { d.y = r; if (d.vy < 0) d.vy = -Math.trunc(d.vy / 2); }
  if (d.y > FH - r) { d.y = FH - r; if (d.vy > 0) d.vy = -Math.trunc(d.vy / 2); }
}

// Snow put down round a point, nearest cells first, never deeper than DMAX
// and never on thawed ground; `away` is a ball whose reach it is kept out of.
function deposit(w, x, y, mass, away) {
  let units = Math.trunc(mass / SNOW);
  if (units <= 0) return;
  const ci = cellI(x), cj = cellJ(y);
  const ar = away ? rOf(away.m) + HALF : 0;
  for (let k = 0; k <= 4; k++) {
    for (let j = cj - k; j <= cj + k; j++) {
      for (let i = ci - k; i <= ci + k; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== k) continue;
        if (i < 0 || i >= GW || j < 0 || j >= GH || !inZone(w.th, i, j)) continue;
        if (away) {
          const ex = i * CELL + HALF - away.x, ey = j * CELL + HALF - away.y;
          if (ex * ex + ey * ey < ar * ar) continue;
        }
        const c = j * GW + i, add = Math.min(DMAX - w.sn[c], units);
        if (add <= 0) continue;
        w.sn[c] += add;
        units -= add;
        if (units <= 0) return;
      }
    }
  }
}

// A tree does not move. A ball that runs into one bounces off, and one that
// hits it hard knocks a chunk of itself off onto the far side of the trunk.
function trees(w, ids) {
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== ROLL) continue;
    const r = rOf(d.m);
    for (const [tx, ty] of w.tr) {
      let ex = d.x - tx, ey = d.y - ty;
      const reach = r + TREE_R, d2 = ex * ex + ey * ey;
      if (d2 >= reach * reach) continue;
      let far = isqrt(d2);
      if (far === 0) { ex = 1; ey = 0; far = 1; }
      d.x = tx + Math.trunc((ex * reach) / far);
      d.y = ty + Math.trunc((ey * reach) / far);
      const vn = Math.trunc((d.vx * ex + d.vy * ey) / far);
      if (vn < 0) {
        d.vx = clampV(d.vx - Math.trunc((ex * vn * 17) / (10 * far)));
        d.vy = clampV(d.vy - Math.trunc((ey * vn * 17) / (10 * far)));
        const hit = -vn;
        if (hit > 16 && d.bc === 0) {
          const chip = Math.min(d.m - MIN_M, Math.trunc((d.m * Math.min(hit, 90)) / 1800));
          d.bc = 6;
          if (chip > 0) {
            d.m -= chip;
            deposit(w, tx - Math.trunc((ex * (TREE_R + CELL)) / far), ty - Math.trunc((ey * (TREE_R + CELL)) / far), chip, d);
          }
          fx(w, 'tree', tx + Math.trunc((ex * TREE_R) / far), ty + Math.trunc((ey * TREE_R) / far), chip, id, hit);
        }
      }
      walls(d);
    }
  }
}

// Two balls that touch: one that outweighs the other by enough bursts it and
// takes half its snow, and the rest lies round where it burst. Two balls near
// the same size bounce, the lighter one the further, and a hard knock chips
// snow off both.
function clash(w, ids) {
  for (let a = 0; a < ids.length; a++) {
    const p = w.p[ids[a]];
    if (p.st !== ROLL) continue;
    for (let b = a + 1; b < ids.length; b++) {
      const o = w.p[ids[b]];
      if (o.st !== ROLL || p.st !== ROLL) continue;
      const ra = rOf(p.m), rb = rOf(o.m), reach = ra + rb;
      let dx = o.x - p.x, dy = o.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= reach * reach) continue;
      if (canBurst(p, o)) { burst(w, ids[a], ids[b]); continue; }
      if (canBurst(o, p)) { burst(w, ids[b], ids[a]); continue; }
      let far = isqrt(d2);
      if (far === 0) { dx = 1; dy = 0; far = 1; }
      const ma = p.m, mb = o.m, tot = ma + mb, over = reach - far + 1;
      p.x -= Math.trunc((dx * over * mb) / (far * tot));
      p.y -= Math.trunc((dy * over * mb) / (far * tot));
      o.x += Math.trunc((dx * over * ma) / (far * tot));
      o.y += Math.trunc((dy * over * ma) / (far * tot));
      const closing = Math.trunc(((p.vx - o.vx) * dx + (p.vy - o.vy) * dy) / far);
      const c = Math.max(0, closing);
      const jp = Math.trunc((c * 17 * mb) / (10 * tot)) + BUMP, jo = Math.trunc((c * 17 * ma) / (10 * tot)) + BUMP;
      p.vx = clampV(p.vx - Math.trunc((dx * jp) / far));
      p.vy = clampV(p.vy - Math.trunc((dy * jp) / far));
      o.vx = clampV(o.vx + Math.trunc((dx * jo) / far));
      o.vy = clampV(o.vy + Math.trunc((dy * jo) / far));
      walls(p);
      walls(o);
      if (closing > 18 && p.bc === 0 && o.bc === 0) {
        p.bc = o.bc = 6;
        const hit = Math.min(closing, 100);
        for (const [e, sx] of [[p, -1], [o, 1]]) {
          if (e.sh > 0) continue;
          const chip = Math.min(e.m - MIN_M, Math.trunc((e.m * hit) / 2500));
          if (chip <= 0) continue;
          e.m -= chip;
          const re = rOf(e.m) + CELL;
          deposit(w, e.x + Math.trunc((sx * dx * re) / far), e.y + Math.trunc((sx * dy * re) / far), chip, null);
        }
        fx(w, 'bump', p.x + Math.trunc((dx * ra) / far), p.y + Math.trunc((dy * ra) / far), closing, ids[a], ids[b]);
      }
    }
  }
}

function burst(w, bid, sid) {
  const big = w.p[bid], s = w.p[sid];
  const gain = Math.trunc(s.m / 2);
  big.m = Math.min(MMAX, big.m + gain);
  deposit(w, s.x, s.y, s.m - gain, big);
  fx(w, 'burst', s.x, s.y, gain, bid, sid);
  big.bu += 1;
  s.st = GONE;
  s.rt = BACK_STEPS;
  s.m = M0;
  s.vx = s.vy = s.cd = s.sh = s.hq = 0;
}

// Snow under a ball, and round it as far as it reaches, is rolled up into it.
function gather(w, d) {
  const reach = Math.max(rOf(d.m), 182);
  const i0 = cellI(d.x - reach), i1 = cellI(d.x + reach), j0 = cellJ(d.y - reach), j1 = cellJ(d.y + reach);
  let got = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * GW + i;
      if (!w.sn[c]) continue;
      const ex = i * CELL + HALF - d.x, ey = j * CELL + HALF - d.y;
      if (ex * ex + ey * ey > reach * reach) continue;
      got += w.sn[c];
      w.sn[c] = 0;
    }
  }
  if (got) d.m = Math.min(MMAX, d.m + got * SNOW);
}

// A ball on thawed ground melts, fast; and the one biggest ball, once it is
// big, melts a little in the sun wherever it is. The practice bot melts
// besides whenever it grows well past the biggest player, so it stays a match
// for somebody learning rather than a wall.
function melt(w, ids) {
  let top = -1, topM = -1, tie = false, rolling = 0, most = 0;
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== ROLL) continue;
    rolling += 1;
    if (id !== BOT_ID) most = Math.max(most, d.m);
    if (d.m > topM) { top = id; topM = d.m; tie = false; } else if (d.m === topM) tie = true;
  }
  const bot = w.p[BOT_ID];
  if (bot && bot.st === ROLL && bot.m > Math.trunc((most * 3) / 2) + 600) bot.m = Math.max(MIN_M, bot.m - Math.max(2, Math.trunc(bot.m / 400)));
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== ROLL) continue;
    let loss = 0;
    if (!inZone(w.th, cellI(d.x), cellJ(d.y))) loss += Math.max(3, Math.trunc(d.m / 300));
    if (id === top && !tie && rolling >= 2 && d.m >= SUN_FROM) loss += Math.trunc(d.m / SUN_FROM);
    d.m = Math.max(MIN_M, d.m - loss);
  }
}

// The leader in the sun, as every copy works it out: -1 when there is none.
function sunOn(w) {
  let top = -1, topM = -1, tie = false, rolling = 0;
  for (const id of playersIn(w)) {
    const d = w.p[id];
    if (d.st !== ROLL) continue;
    rolling += 1;
    if (d.m > topM) { top = id; topM = d.m; tie = false; } else if (d.m === topM) tie = true;
  }
  return !tie && rolling >= 2 && topM >= SUN_FROM ? top : -1;
}

function snowfall(w) {
  for (let k = 0; k < FALLS; k++) {
    const c = Math.floor(draw01(w) * NC);
    if (w.sn[c] < REFILL && inZone(w.th, c % GW, Math.floor(c / GW))) w.sn[c] += 1;
  }
}

// Late in a round the rim thaws, ring by ring, and its snow is gone.
function thaw(w) {
  const into = PLAY_STEPS - w.pt;
  if (into === THAW_AT - 2 * HZ) fx(w, 'warn', 0, 0, 0);
  if (into < THAW_AT || (into - THAW_AT) % THAW_EVERY !== 0 || w.th >= TH_MAX) return;
  w.th += 1;
  for (let c = 0; c < NC; c++) if (!inZone(w.th, c % GW, Math.floor(c / GW))) w.sn[c] = 0;
  fx(w, 'thaw', 0, 0, 0);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.th, 0, TH_MAX)) return null;
  if (!Array.isArray(raw.sn) || raw.sn.length !== NC) return null;
  if (!raw.sn.every((v, c) => int(v, 0, DMAX) && (v === 0 || inZone(raw.th, c % GW, Math.floor(c / GW))))) return null;
  if (!Array.isArray(raw.tr) || raw.tr.length > TREES) return null;
  if (!raw.tr.every((t) => Array.isArray(t) && t.length === 2 && int(t[0], 0, FW) && int(t[1], 0, FH))) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, ROLL, GONE) || !int(d.x, 0, FW) || !int(d.y, 0, FH)) return null;
    if (!int(d.vx, -VMAX, VMAX) || !int(d.vy, -VMAX, VMAX) || inputOf([d.dx, d.dy, d.q]) === null) return null;
    if (!int(d.hq, 0, 1) || !int(d.m, MIN_M, MMAX) || !int(d.cd, 0, LUNGE_CD) || !int(d.sh, 0, SHIELD)) return null;
    if (!int(d.rt, 0, BACK_STEPS) || !int(d.bu, 0, 99999) || !int(d.ot, -1, MAX_P)) return null;
    if (!int(d.pts, 0, 999999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bt, -1, BDIR.length - 1) || !int(d.bw, 0, 99) || !int(d.bc, 0, 99)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
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
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, th: raw.th, sn: raw.sn.slice(),
    tr: raw.tr.map((t) => t.slice()), p, res, win: raw.win,
  };
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
// One palette: a snowfield at dusk. Blue-white snow, deeper where it is
// whiter, over frozen teal grass, the thawed rim gone to mud, dark pines, and
// every ball snow-white ringed in its player's bright colour.
const INK = {
  page: '#18203c', glow: '#2b3a6b', text: '#ffffff', muted: '#c9d6f0', dim: '#8d9bc2', gold: '#ffd166',
  danger: '#ff5a6e', grass: '#2f6158', grassDark: '#24504a', mud: '#6b543f', mudDark: '#57432f',
  bank: '#0f1630', outline: '#16203d', panel: 'rgba(16,22,44,0.93)', sun: '#ffcf4a',
};
const SNOWC = ['', '#bcd3ea', '#d6e5f4', '#ebf3fb', '#ffffff'];
const SNOWR = [0, 0.66, 0.6, 0.54, 0.5];      // a depth's blob, in cells
const SEAT = ['#ff4f7b', '#3fa9ff', '#ffb020', '#9cff3a', '#e25cff', '#20e3ff', '#ff7a2e', '#7d6bff'];
const FONT = "700 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));
const kg = (m) => Math.round(m / 10) + ' kg';

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.page};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a5a8f;' +
  `background:#24305a;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, sc = 0.05, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340;
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

// The whole field is always on screen, as large as it fits. NOTE_ROOM under it
// keeps the practice note off the bottom row, and in a round the same strip
// says how big you are and whether a lunge is ready.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  sc = Math.max(0.005, Math.min((VW - 16) / FW, ah / FH));
  ox = (VW - FW * sc) / 2;
  oy = TOP + (ah - FH * sc) / 2;
  fieldTop = oy;
  fieldBot = oy + FH * sc;
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
  lunge() { if (ready('lunge', 80)) { puff(0.22, 0.07, 1800, 0, 0.9); tone(260, 0.18, 'triangle', 0.06, 1.8); } },
  burst(near, mine) {
    if (!ready('burst', 60)) return;
    puff(0.45, 0.06 + 0.12 * near, 700, 0, 0.6);
    tone(mine ? 180 : 140, 0.3, 'sine', 0.08 + 0.1 * near, 0.4);
    if (mine) [523, 659, 784].forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, 0.05 + i * 0.05));
  },
  burstMe() { if (ready('burstMe', 200)) { puff(0.5, 0.16, 500, 0, 0.6); tone(420, 0.6, 'sawtooth', 0.05, 0.25); } },
  bump(hard) { if (ready('bump', 70)) { puff(0.12, 0.05 + 0.06 * hard, 900, 0, 1.2); tone(150 + 60 * hard, 0.09, 'sine', 0.07, 0.6); } },
  tree(hard) { if (ready('tree', 90)) { tone(110, 0.16, 'square', 0.05 + 0.04 * hard, 0.5); puff(0.25, 0.06, 2400, 0.02, 1.4); } },
  back() { if (ready('back', 200)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.05)); },
  crunch(vol) { if (ready('crunch', 110)) puff(0.07, 0.012 + 0.03 * vol, 3200, 0, 2.5); },
  rumble() { if (ready('rumble', 300)) { puff(0.6, 0.06, 260, 0, 0.5); tone(70, 0.5, 'sine', 0.08, 0.7); } },
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
// fast screen and a slow one see the same powder. Positions are field units.
const bits = [];      // { x, y, vx, vy, vz, z, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, up) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: (up || 0) * (0.5 + Math.random()), z: 0, life: 0, max: 18 + Math.random() * 22, size, colour });
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
      b.z += b.vz / BIT_HZ;
      b.vz -= 2400 / BIT_HZ;
      if (b.z < 0) { b.z = 0; b.vz = -b.vz * 0.3; }
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
const looks = new Map();      // id -> { x, y, r, roll, fx, fy, squash, seen }
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = md && md.st === ROLL ? Math.max(0, 1 - (Math.abs(md.x - e.x) + Math.abs(md.y - e.y)) / (8 * CELL)) : 0.3;
  if (e.kind === 'burst') {
    const colour = colourOf(t, e.a);
    spray(e.x, e.y, 30, '#ffffff', 5 * CELL, 46, 900);
    spray(e.x, e.y, 10, colourOf(t, e.b), 4 * CELL, 30, 700);
    ring(e.x, e.y, colour, 3 * CELL);
    const big = t.p[e.a];
    if (big) pop(big.x, big.y - rOf(big.m), '+' + kg(e.z), colour, e.a === me ? 18 : 14);
    if (e.b === me) { pop(e.x, e.y, 'burst!', INK.danger, 20); shake = Math.max(shake, 14); sound.burstMe(); }
    else {
      if (e.a === me) shake = Math.max(shake, 7);
      sound.burst(near, e.a === me);
    }
    const look = looks.get(e.a);
    if (look) look.squash = 1;
    looks.delete(e.b);
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 10, '#ffffff', 3 * CELL, 26, 500);
    if (e.a === me || e.b === me) shake = Math.max(shake, 6);
    for (const id of [e.a, e.b]) { const look = looks.get(id); if (look) look.squash = 0.7; }
    sound.bump(Math.min(1, e.z / 60));
  } else if (e.kind === 'tree') {
    spray(e.x, e.y, 8, '#ffffff', 3 * CELL, 26, 600);
    spray(e.x, e.y, 5, '#3f8f6a', 2 * CELL, 16, 400);
    if (e.a === me) { shake = Math.max(shake, 7); if (e.z > 0) pop(e.x, e.y, '-' + kg(e.z), '#ffffff', 14); }
    const look = looks.get(e.a);
    if (look) look.squash = 0.8;
    sound.tree(Math.min(1, e.b / 60));
  } else if (e.kind === 'lunge') {
    spray(e.x, e.y, 12, '#ffffff', 2.5 * CELL, 30, 400);
    if (e.a !== me) sound.lunge();
  } else if (e.kind === 'back') {
    ring(e.x, e.y, colourOf(t, e.a), 1.5 * CELL);
    if (e.a === me) { pop(e.x, e.y, 'back in!', INK.text, 15); sound.back(); }
  } else if (e.kind === 'warn') {
    pop(FW / 2, FH / 2, 'the thaw is coming!', INK.gold, 22);
    sound.warn();
  } else if (e.kind === 'thaw') {
    shake = Math.max(shake, 4);
    sound.rumble();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

function drawSky(now) {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.8);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // Flakes drifting down past the field.
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < 26; i++) {
    const x = ((i * 97.3 + Math.sin(now / 1300 + i) * 30) % VW + VW) % VW;
    const y = ((i * 61.7 + now / (28 + (i % 5) * 6)) % (VH + 20)) - 10;
    disc(x, y, 1 + (i % 3) * 0.6);
    ctx.fill();
  }
}

// The field: grass, mud where it thawed, and the snow as soft blobs, one pass a
// depth, so deeper snow sits whiter on top of shallower. The ring that thaws
// next glows for the two seconds before it does.
function drawField(t, snow, now) {
  flat();
  const x0 = SX(0), y0 = SY(0), w = FW * sc, h = FH * sc, c = CELL * sc;
  ctx.fillStyle = 'rgba(5,8,20,0.45)';
  roundRect(x0 - 3, y0 + 3, w + 10, h + 8, 12);
  ctx.fill();
  ctx.fillStyle = INK.bank;
  roundRect(x0 - 5, y0 - 5, w + 10, h + 10, 12);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, w, h, 8);
  ctx.clip();
  ctx.fillStyle = INK.grass;
  ctx.fillRect(x0, y0, w, h);
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      if (!inZone(t.th, i, j)) {
        ctx.fillStyle = (i + j) % 2 ? INK.mud : INK.mudDark;
        ctx.fillRect(x0 + i * c - 0.5, y0 + j * c - 0.5, c + 1, c + 1);
      } else if ((i * 7 + j * 3) % 5 === 0) {
        ctx.fillStyle = INK.grassDark;
        ctx.fillRect(x0 + i * c + c * 0.3, y0 + j * c + c * 0.55, c * 0.08, c * 0.2);
        ctx.fillRect(x0 + i * c + c * 0.45, y0 + j * c + c * 0.5, c * 0.08, c * 0.25);
      }
    }
  }
  for (let depth = 1; depth <= DMAX; depth++) {
    ctx.fillStyle = depth === 1 ? '#9fb9d6' : SNOWC[depth - 1];
    ctx.beginPath();
    const rr = c * SNOWR[depth];
    for (let k = 0; k < NC; k++) {
      if (snow[k] < depth) continue;
      const x = x0 + ((k % GW) + 0.5) * c, y = y0 + (Math.floor(k / GW) + 0.5) * c + c * 0.06;
      ctx.moveTo(x + rr, y);
      ctx.arc(x, y, rr, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = SNOWC[depth];
    ctx.beginPath();
    for (let k = 0; k < NC; k++) {
      if (snow[k] < depth) continue;
      const x = x0 + ((k % GW) + 0.5) * c, y = y0 + (Math.floor(k / GW) + 0.5) * c;
      ctx.moveTo(x + rr, y);
      ctx.arc(x, y, rr, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  // Sparkles on deep snow.
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (let k = 0; k < NC; k++) {
    if (snow[k] < 3) continue;
    const tw = Math.sin(now / 300 + k * 1.7);
    if (tw < 0.85) continue;
    disc(x0 + ((k % GW) + 0.3 + ((k * 37) % 40) / 100) * c, y0 + (Math.floor(k / GW) + 0.3 + ((k * 53) % 40) / 100) * c, Math.max(1, c * 0.05));
    ctx.fill();
  }
  const into = PLAY_STEPS - t.pt;
  if (t.ph === PLAY && t.th < TH_MAX && into >= THAW_AT - 2 * HZ) {
    const left = into < THAW_AT ? THAW_AT - into : THAW_EVERY - ((into - THAW_AT) % THAW_EVERY);
    if (left <= 2 * HZ) {
      ctx.fillStyle = `rgba(255,140,60,${(0.22 + 0.18 * Math.sin(now / 110)).toFixed(3)})`;
      for (let j = 0; j < GH; j++) {
        for (let i = 0; i < GW; i++) {
          if (inZone(t.th, i, j) && !inZone(t.th + 1, i, j)) ctx.fillRect(x0 + i * c, y0 + j * c, c, c);
        }
      }
    }
  }
  ctx.restore();
}

// A pine: its shadow, its trunk, three tiers of green each capped with snow.
function drawTree(tx, ty) {
  const x = SX(tx), y = SY(ty), r = TREE_R * sc;
  ctx.fillStyle = 'rgba(10,20,30,0.3)';
  ctx.beginPath(); ctx.ellipse(x + r * 0.4, y + r * 0.5, r * 1.4, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#5b3b26';
  ctx.fillRect(x - r * 0.25, y - r * 0.4, r * 0.5, r * 0.9);
  const tiers = [[1.0, 2.0, 2.6], [0.8, 1.55, 1.75], [0.55, 1.1, 0.95]];
  for (const [wk, hk, base] of tiers) {
    const by = y - r * base * 0.55, ty0 = by - r * hk;
    ctx.fillStyle = '#1d5a45';
    ctx.beginPath(); ctx.moveTo(x - r * wk * 1.5, by); ctx.lineTo(x + r * wk * 1.5, by); ctx.lineTo(x, ty0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#2b7a5c';
    ctx.beginPath(); ctx.moveTo(x - r * wk * 1.5, by); ctx.lineTo(x, by); ctx.lineTo(x, ty0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f4f9ff';
    ctx.beginPath(); ctx.moveTo(x - r * wk * 0.6, ty0 + r * hk * 0.42); ctx.lineTo(x, ty0); ctx.lineTo(x + r * wk * 0.6, ty0 + r * hk * 0.42);
    ctx.lineTo(x + r * wk * 0.25, ty0 + r * hk * 0.32); ctx.lineTo(x, ty0 + r * hk * 0.45); ctx.lineTo(x - r * wk * 0.3, ty0 + r * hk * 0.3); ctx.closePath(); ctx.fill();
  }
}

// A ball as drawn: on its shadow, snow-white and shaded, ringed in its
// player's colour, with flecks that roll over its face the way it goes; a
// shield blinks round it, the sun beats on the biggest.
function drawBall(id, x, y, d, colour, me, sun, now) {
  let look = looks.get(id);
  const rt = rOf(d.m);
  if (!look) looks.set(id, (look = { x, y, r: rt, roll: 0, fx: 1, fy: 0, squash: 0, seen: now }));
  const mx = x - look.x, my = y - look.y, l = Math.hypot(mx, my);
  if (l > 1) {
    look.fx = lerp(look.fx, mx / l, per60(0.35));
    look.fy = lerp(look.fy, my / l, per60(0.35));
    look.roll += l / Math.max(40, look.r);
    if (Math.random() < Math.min(0.5, l / 40)) {
      spray(x - look.fx * look.r * 0.8, y - look.fy * look.r * 0.8, 1, '#ffffff', CELL * 0.6, 14 + look.r * 0.05, 150);
    }
  }
  look.x = x; look.y = y; look.seen = now;
  look.r = lerp(look.r, rt, per60(0.18));
  look.squash *= Math.pow(0.86, frameDt * 60);
  const r = look.r * sc, sx = SX(x), sy = SY(y);
  const sq = look.squash, rx = r * (1 + sq * 0.18), ry = r * (1 - sq * 0.15);
  ctx.fillStyle = 'rgba(12,22,48,0.32)';
  ctx.beginPath(); ctx.ellipse(sx + r * 0.25, sy + r * 0.45, r * 1.02, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  const g = ctx.createRadialGradient(sx - r * 0.35, sy - r * 0.4, r * 0.1, sx, sy, r * 1.05);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.65, '#e8f1fb');
  g.addColorStop(1, mix('#b9cde6', colour, 0.18));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  // Flecks of grass and grit rolled up with the snow, turning over the top.
  const fx_ = look.fx, fy_ = look.fy;
  for (let i = 0; i < 7; i++) {
    const a = look.roll + i * 0.8976;
    const cz = Math.cos(a);
    if (cz < 0.1) continue;
    const along = Math.sin(a) * 0.72, side = (((i * 5) % 7) / 6 - 0.5) * 1.2 * Math.sqrt(Math.max(0, 1 - along * along));
    const px = sx + (fx_ * along - fy_ * side) * rx, py = sy + (fy_ * along + fx_ * side) * ry;
    ctx.fillStyle = i % 3 ? 'rgba(90,120,150,' + (0.45 * cz).toFixed(3) + ')' : alpha(colour, 0.55 * cz);
    disc(px, py, Math.max(0.8, r * 0.09 * cz));
    ctx.fill();
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(2, Math.min(6, r * 0.16));
  ctx.beginPath(); ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath(); ctx.ellipse(sx - r * 0.35, sy - r * 0.42, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2); ctx.fill();
  if (d.sh > 0 && Math.floor(now / 120) % 2 === 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    disc(sx, sy, r + 5);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    disc(sx, sy, r + (d.sh > 0 ? 9 : 4));
    ctx.stroke();
  }
  let top = sy - ry - 5;
  if (sun) {
    const s = Math.max(5, Math.min(9, r * 0.35)), cy = top - s - 2;
    ctx.strokeStyle = INK.sun;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = k * 0.785 + now / 900;
      ctx.moveTo(sx + Math.cos(a) * s * 1.2, cy + Math.sin(a) * s * 1.2);
      ctx.lineTo(sx + Math.cos(a) * s * 1.7, cy + Math.sin(a) * s * 1.7);
    }
    ctx.stroke();
    ctx.fillStyle = INK.sun;
    disc(sx, cy, s);
    ctx.fill();
    // Drips running down the melting ball.
    ctx.fillStyle = 'rgba(150,200,255,0.8)';
    for (let k = 0; k < 2; k++) {
      const f = ((now / 700 + k * 0.5) % 1);
      disc(sx + (k ? 0.5 : -0.4) * r, sy + r * (0.2 + f * 0.9), Math.max(1, r * 0.07));
      ctx.fill();
    }
    top = cy - s * 1.7 - 2;
  }
  const px = Math.max(9, Math.min(13, 7 + r * 0.25));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(16,22,44,0.8)';
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
    disc(SX(b.x), SY(b.y) - b.z * sc, b.size * sc * (1 - f * 0.5));
    ctx.fill();
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
    ctx.strokeStyle = 'rgba(16,22,44,0.8)';
    const X = Math.max(60, Math.min(VW - 60, SX(p.x))), Y = Math.max(TOP + 10, SY(p.y) - rise);
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
  const into = PLAY_STEPS - t.pt;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left';
    if (t.th > 0) {
      status += ' · the rim is thawing';
      colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
    } else if (into >= THAW_AT - 3 * HZ) status += ' · thaw soon';
  } else status = 'round ' + t.rd + ' · over';
  text('snowball', 12, 22, titlePx, '#bfe6ff', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('snowball').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with how big they roll
  // now and, in a round, their points; the chip of a burst ball is hollow.
  const ids = bySeat(t);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      disc(x + 11, y - 2, 5);
      if (d.st === ROLL) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      const score = t.ph === WAIT ? '' : String(d.pts);
      const size = d.st === ROLL ? String(Math.round(d.m / 10)) : '–';
      ctx.font = font(12);
      const sw = score ? ctx.measureText(score).width + 6 : 0;
      if (score) text(score, x + cw - 8, y + 3, 12, INK.gold, 'right');
      ctx.font = font(11);
      const kw = ctx.measureText(size).width;
      if (cw > 40) text(size, x + cw - 8 - sw, y + 3, 11, '#dff0ff', 'right');
      if (cw > 64) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st === ROLL ? (mine ? INK.text : INK.muted) : INK.dim, cw - 34 - sw - kw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to roll · tap to lunge · grow on snow, burst smaller balls'
    : 'mouse or arrows/WASD roll · click or space lunges · burst smaller balls · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// How big you are and whether a lunge is ready, in the strip under the field
// while a round is on.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = Math.min(fieldBot + NOTE_ROOM / 2, VH - BOT - 18);
  if (d.st !== ROLL) {
    const line = t.ph === PLAY ? 'burst! you roll again in a moment' : t.ph === COUNT ? 'get ready' : '';
    if (line) fitText(line, VW / 2, y + 5, 13, INK.muted, VW - 24);
    return;
  }
  const size = kg(d.m), ready = d.cd === 0 && d.m >= MIN_M + 60;
  ctx.font = font(15);
  const sw = ctx.measureText(size).width;
  const bar = 70, total = 14 + sw + 18 + 44 + bar;
  let x = VW / 2 - total / 2;
  ctx.fillStyle = SEAT[d.c];
  disc(x + 6, y, 6);
  ctx.fill();
  text(size, x + 16, y + 5, 15, INK.text, 'left');
  x += 16 + sw + 18;
  text('lunge', x, y + 5, 12, ready ? INK.text : INK.dim, 'left');
  x += 42;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(x, y - 5, bar, 10, 5);
  ctx.fill();
  const k = ready ? 1 : 1 - d.cd / LUNGE_CD;
  ctx.fillStyle = ready ? SEAT[d.c] : 'rgba(255,255,255,0.45)';
  roundRect(x, y - 5, Math.max(10, bar * k), 10, 5);
  ctx.fill();
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
    const tip = two ? null : 'roll over snow to grow · a ball a quarter smaller than yours bursts on touch';
    practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(16,22,44,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 320), 30);
    fitText('the biggest snowball at the whistle wins', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 300));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(16,22,44,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('roll!', cx, mid + big * 0.5);
    text('roll!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= 5 * HZ) {
    const n = Math.ceil(t.pt / HZ);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(16,22,44,0.6)';
    ctx.font = font(big * 2);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big * 0.7);
    text(String(n), cx, mid + big * 0.7, big * 2, INK.gold, 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 330), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · the biggest were the same size';
    else head = t.win === me ? 'you rolled the biggest snowball!' : nickOf(t.win) + ' rolled the biggest snowball';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('size', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('round', cx + w / 2 - 62, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, ot, pts, wins, m], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(kg(m), cx + w / 2 - 110, y, 13, '#dff0ff', 'right');
      text('+' + Math.max(0, ot), cx + w / 2 - 62, y, 14, INK.text, 'right');
      text(String(pts), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('a point for every ball you outsize · next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a ball is as drawn: between two steps, and never slid across a jump —
// a ball back on the field after a burst.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 3 * CELL) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

// Your own ball is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a push a step away from where
// the guess had it. So the ball drawn is pulled toward the guess a little
// every frame rather than put on it, and a guess far off — a table taken
// afresh, a ball put back — puts it there at once. Only the drawing is
// smoothed: the field, and every rule on it, are untouched.
const PULL = 0.45;
let shown = null;        // [x, y] in units: where your ball is drawn
let myPos = null;        // the same, for the mouse to steer by

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 2 * CELL) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

let lastCrunch = 0;
function draw(now) {
  fit();
  drawSky(now);
  const b = agreedAt(now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the snowfield…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  // The snow is drawn from the guess when there is one, so the trail your own
  // ball leaves keeps up with it.
  const snowT = m && m.to.p[me] ? m.to : t;
  drawField(t, snowT.sn, now);
  const sun = sunOn(t);
  const items = [];
  for (const [tx, ty] of t.tr) items.push([ty, () => drawTree(tx, ty)]);
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st !== ROLL) continue;
    const p = bodyAt(b, id);
    items.push([p[1], () => drawBall(id, p[0], p[1], d, SEAT[d.c], false, id === sun, now)]);
  }
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own && own.to.p[me].st === ROLL) {
    const p = bodyAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    const d = p[2];
    myPos = [x, y];
    items.push([y, () => drawBall(me, x, y, d, SEAT[d.c], true, me === sun, now)]);
    // A soft crunch while your own ball picks snow up.
    const md = t.p[me];
    if (md && md.st === ROLL && now - lastCrunch > 140 && (Math.abs(md.vx) + Math.abs(md.vy)) > 6) {
      const c = cellJ(md.y) * GW + cellI(md.x);
      if (snowT.sn[c] > 0 || t.sn[c] > 0) { lastCrunch = now; sound.crunch(Math.min(1, (Math.abs(md.vx) + Math.abs(md.vy)) / 60)); }
    }
  } else {
    myPos = shown = null;
  }
  items.sort((p, q) => p[0] - q[0]);
  for (const [, f] of items) f();
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way pushed, across and down, a thousand at full, and
// how many lunges so far. A change of way goes out no oftener than
// STEER_EVERY, because a thumb or a mouse changes it on every move the screen
// reports and the clock's ticks share the same seat's ceiling on messages; a
// lunge goes out at once.
const STEER_EVERY = 80;
let mode = '';           // what steers: 'keys', 'mouse', 'touch', or nothing yet
let lungesAsked = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_DIR = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };

// A thumb: a stick from wherever it lands, read as far as it is pushed, and a
// tap lunges — a drag rather than a press, because iOS keeps a long press
// inside a frame for itself. A second finger down while the first steers
// lunges too. A mouse: your ball rolls toward the pointer wherever it is; a
// click lunges.
const DEAD = 9;
const REACHOUT = 46;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }
const mouse = { x: 0, y: 0, on: false, parked: false };

function steerNow() {
  if (mode === 'keys') {
    let x = 0, y = 0;
    for (const c of keys) { x += KEY_DIR[c][0]; y += KEY_DIR[c][1]; }
    const l = Math.hypot(x, y);
    return l ? [Math.round((x / l) * 1000), Math.round((y / l) * 1000)] : [0, 0];
  }
  if (mode === 'touch') {
    if (!stick) return [0, 0];
    const l = Math.hypot(stick.dx, stick.dy);
    if (l < DEAD) return [0, 0];
    const k = Math.min(1, l / REACHOUT) * 1000 / l;
    return [clamp(Math.round(stick.dx * k), -1000, 1000), clamp(Math.round(stick.dy * k), -1000, 1000)];
  }
  if (mode === 'mouse' && mouse.on && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]);
    const l = Math.hypot(dx, dy), cell = CELL * sc;
    // Stopped on arrival, and off again only once the pointer is clearly away:
    // one threshold for both makes a ball that stops and starts on every
    // twitch of the hand.
    if (l < cell * 0.25) mouse.parked = true;
    else if (l > cell * 0.5) mouse.parked = false;
    if (mouse.parked) return [0, 0];
    const k = Math.min(1, l / (cell * 1.5)) * 1000 / l;
    return [clamp(Math.round(dx * k), -1000, 1000), clamp(Math.round(dy * k), -1000, 1000)];
  }
  return [0, 0];
}

function sayHand(now, force) {
  const [dx, dy] = steerNow();
  const h = [dx, dy, lungesAsked], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1] && h[2] === s[2]) return;
  if (!force && s && h[2] === s[2] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A lunge: heard at once, and taken a trip later on every copy alike, if the
// table says the cooldown is over.
function lunge() {
  wake();
  if (!world) return;
  lungesAsked = (lungesAsked + 1) % 1000;
  sayHand(performance.now(), true);
  const d = world.p[myId()];
  if (d && d.st === ROLL && d.cd === 0 && d.m >= MIN_M + 60) sound.lunge();
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyE' || e.code === 'KeyX') {
    e.preventDefault();
    if (!e.repeat) lunge();
    return;
  }
  if (!(e.code in KEY_DIR)) return;
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
  stick = null;
  paintStick();
  mouse.on = false;
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    mode = 'touch';
    if (stick) { lunge(); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0, at: performance.now(), moved: false };
    paintStick();
    return;
  }
  coarse = false;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mode = 'mouse';
  mouse.on = true;
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  lunge();
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    stick.dx = e.clientX - stick.ox;
    stick.dy = e.clientY - stick.oy;
    if (Math.hypot(stick.dx, stick.dy) >= DEAD) stick.moved = true;
    paintStick();
    sayHand(performance.now(), false);
  } else if (e.pointerType === 'mouse') {
    const moved = Math.abs(e.clientX - mouse.x) + Math.abs(e.clientY - mouse.y);
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    // A mouse resting on the frame while the keys steer leaves them to it.
    if (mode === 'keys' && keys.size) return;
    if (mode !== 'mouse' && moved < 4) return;
    mode = 'mouse';
    mouse.on = true;
    coarse = false;
  }
});
cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') mouse.on = false; });
function liftPointer(e) {
  if (!stick || e.pointerId !== stick.id) return;
  const tap = !stick.moved && performance.now() - stick.at < 260;
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
  if (tap) lunge();
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', liftPointer);
addEventListener('pointerup', liftPointer);
addEventListener('pointercancel', liftPointer);

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

function paintStick() {
  if (!stick) { stickRing.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(stick.dx, stick.dy);
  const k = far > REACHOUT ? REACHOUT / far : 1;
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
// a player arrives on the field.
function start() {
  setHand([0, 0, lungesAsked]);
  lastSaid = [0, 0, lungesAsked];
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
