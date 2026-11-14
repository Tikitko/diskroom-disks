/**
 * @disk     fizz
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    A bubble brawl on candy platforms. Blow a bubble into a rival to trap them, then touch it to pop it and score, but anyone can pop it first while they wriggle to break free. Bounce on empty bubbles to climb. The leader is worth a bonus, and the last stretch pays double.
 * @tags     game, party, realtime, platformer, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/fizz.png
 */
// fizz.js — a soda-fountain arena where the room's order is the referee.
//
// Every copy holds every player, where they stand and how fast they move,
// every bubble in the air and whom it holds, and changes it only on what comes
// back round the room, so every copy applies the same hands in the same order
// and holds the same arena. Nobody sends where they are, whom they trapped or
// whom they popped: a hand is which way a player runs, which buttons are held,
// and two counters that move on by one for every jump and every bubble blown,
// and everything else is the same arithmetic on the same whole numbers on
// every machine. A page with a console open can play its own hand however it
// likes, at its own top speed, and blow bubbles no oftener than the cooldown
// allows.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own blob does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — the arena is 2400 units across, a
// speed is units a step — and use nothing but `+ - * /`, comparisons,
// `Math.floor`, `Math.trunc`, `Math.min`, `Math.max`, `Math.abs`, `Math.sqrt`
// and `Math.imul`, whose results the language fixes to the last bit.
// Trigonometry appears only in the drawing, which is nobody's business but the
// screen's.

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
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the arena a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own blob a trip ahead, with your hand in it

// The arena, seen from the side: a floor, walls either side, and five rows of
// candy platforms you jump up through and land on.
const W = 2400, H = 1680;
const FLOOR = 1600;            // the top of the floor
const CEIL = 40;               // the foam line bubbles gather under
const PW = 30, PH = 72;        // half a blob's width, and its height
const RUN = 16;                // top running speed
const ACC_G = 4, ACC_A = 2;    // how fast running speed changes, on the ground and in the air
const GRAV = 2;
const JUMP_V = 34;             // a jump clears a row of platforms with a little to spare
const CUT_V = 10;              // letting go of jump early cuts the rise to this
const MAXFALL = 26;
const COYOTE = 4;              // steps after leaving a ledge that a jump is still taken
const JUMP_BUF = 5;            // steps a jump asked for in the air waits for the ground

// Bubbles: blown straight ahead, they trap the first rival they touch while
// they fly; then they float up, an empty one bounces whoever lands on it, and
// popping it from the side costs nothing. A full one floats up slower with its
// captive inside until somebody touches it, it times out, or the captive
// wriggles free.
const BR = 44, BF = 60;        // the radius of an empty bubble, and of a full one
const SHOT_V = 30;
const SHOT_STEPS = 16;         // steps a bubble flies before it floats
const SHOT_LONG = 21;          // the same, for whoever trails the leader
const SHOT_CD = 10;            // steps between two bubbles
const MAX_OWN = 3;             // empty bubbles one player keeps in the air
const RISE = 3, RISE_F = 2;
const EMPTY_LIFE = 210;        // steps an empty bubble lasts
const TRAP_LIFE = 150;         // steps a full one holds before it bursts on its own
const ESC_FULL = 100;          // the wriggle it takes to break out
const ESC_ADD = 7;             // one wriggle's worth
const ESC_BEHIND = 10;         // the same, for whoever trails the leader
const WRIGGLE_GAP = 2;         // steps between two wriggles that count
const BOUNCE = 28, BOUNCE_HI = 38;
const BACK_STEPS = 45;         // steps from being popped to standing again
const SHIELD = 60;             // steps a blob back in the arena cannot be trapped
const SHIELD_FREE = 24;        // the same, for one that broke out
const MAX_B = 40;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 6 * HZ;
const RUSH_AT = 70 * HZ;       // steps into a round when every pop starts counting double

const ALIVE = 0, TRAPPED = 1, GONE = 2;

// Three arenas, one a round: rows of platforms as [top, left, right] in units.
const ROWS = [1360, 1120, 880, 640, 400];
const LEVELS = [
  [[1360, 80, 640], [1360, 960, 1440], [1360, 1760, 2320], [1120, 320, 880], [1120, 1520, 2080],
    [880, 80, 560], [880, 880, 1520], [880, 1840, 2320], [640, 400, 960], [640, 1440, 2000],
    [400, 80, 480], [400, 880, 1520], [400, 1920, 2320]],
  [[1360, 240, 720], [1360, 1680, 2160], [1120, 80, 400], [1120, 960, 1440], [1120, 2000, 2320],
    [880, 400, 880], [880, 1520, 2000], [640, 80, 480], [640, 1040, 1360], [640, 1920, 2320],
    [400, 480, 1040], [400, 1360, 1920]],
  [[1360, 80, 880], [1360, 1520, 2320], [1120, 720, 1680], [880, 80, 640], [880, 1760, 2320],
    [640, 560, 1840], [400, 80, 560], [400, 1040, 1360], [400, 1840, 2320]],
];
// Where each seat starts a round, on the floor: neighbouring seats far apart.
const START = [0, 7, 3, 4, 1, 6, 2, 5];
const startX = (s) => 200 + START[s] * 285;

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   lv: which arena; bn: the next bubble's number; b: the bubbles, each
//   [number, x, y, vx, age, blower, full, captive, wriggle, flight]; res: the
//   last round's [id, points, pops, times caught, rounds won] rows; win: its
//   winner
function freshTable(seed) {
  return { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, lv: 0, bn: 0, b: [], p: {}, res: null, win: -1 };
}

const FIELDS = ['c', 's', 'st', 'x', 'y', 'vx', 'vy', 'f', 'mx', 'hb', 'jq', 'sq', 'jb', 'sb', 'g', 'ct', 'cd',
  'sh', 'rt', 'lm', 'wc', 'rp', 'pops', 'cau', 'wn', 'bw', 'bd', 'hs', 'hc'];
//   c: colour; s: seat; st: standing, trapped or popped; x, y: the middle of
//   the feet, in units; vx, vy: speed; f: the way faced; mx: the way the hand
//   runs; hb: buttons held, 1 jump and 2 down; jq, sq: the jump and bubble
//   counters as last heard; jb: steps a jump asked for still waits; sb: a
//   bubble to blow this step; g: on the ground; ct: steps since the ground; cd:
//   steps until the next bubble; sh: steps of shield left; rt: steps until a
//   popped blob stands again; lm: the last way run, for wriggles; wc: steps
//   until a wriggle counts again; rp: points this round; pops, cau: rivals
//   popped and times caught this round; wn: rounds won; bw, bd: the bot's
//   pause and how long it holds down; hs, hc: hands this step.
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

function newPlayer(w, jq, sq) {
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), st: GONE, x: W / 2, y: FLOOR, vx: 0, vy: 0, f: 1, mx: 0, hb: 0, jq, sq,
    jb: 0, sb: 0, g: 1, ct: 0, cd: 0, sh: 0, rt: 10, lm: 0, wc: 0, rp: 0, pops: 0, cau: 0, wn: 0, bw: 0, bd: 0,
    hs: w.n, hc: 0,
  });
}

// A blob put down standing, still.
function place(d, x, y) {
  d.st = ALIVE;
  d.x = x;
  d.y = y;
  d.vx = d.vy = d.jb = d.sb = d.cd = d.sh = d.rt = d.bw = d.bd = 0;
  d.g = 1;
  d.ct = 0;
  d.f = x < W / 2 ? 1 : -1;
}

// Back in the arena after a pop: the best of the floor and the platforms,
// as far from everybody else as they come, shielded for a moment so nobody
// can wait on a spot.
function respawn(w, id) {
  const d = w.p[id];
  const spots = [];
  for (let x = 200; x <= 2200; x += 400) spots.push([x, FLOOR]);
  for (const [y, x0, x1] of LEVELS[w.lv]) spots.push([Math.trunc((x0 + x1) / 2), y]);
  let best = spots[0], score = -Infinity;
  for (const [x, y] of spots) {
    let near = 99999;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o === id || e.st === GONE) continue;
      near = Math.min(near, Math.abs(e.x - x) + Math.abs(e.y - y));
    }
    const s = near + Math.floor(draw01(w) * 160);
    if (s > score) { score = s; best = [x, y]; }
  }
  place(d, best[0], best[1]);
  d.sh = SHIELD;
  fx(w, 'back', d.x, d.y - PH / 2, 0, id);
}

const bubbleOf = (w, id) => w.b.find((b) => b[6] === 1 && b[7] === id) || null;

// The one leader, as every copy works it out: the most points this round, when
// somebody has some and nobody matches them. -9999 when there is none.
const NOBODY = -9999;
function leaderOf(w) {
  let top = 0, who = NOBODY, tie = false;
  for (const id of playersIn(w)) {
    const r = w.p[id].rp;
    if (r > top) { top = r; who = id; tie = false; } else if (r === top && r > 0) tie = true;
  }
  return tie ? NOBODY : who;
}
const trails = (w, id) => playersIn(w).some((o) => w.p[o].rp > w.p[id].rp);

// One wriggle of a trapped blob: a change of the way it runs, counted no
// oftener than WRIGGLE_GAP, and worth more to whoever trails the leader.
function wriggle(w, id, mx) {
  const d = w.p[id];
  if (mx === 0 || mx === d.lm) return;
  d.lm = mx;
  if (d.st !== TRAPPED || d.wc > 0) return;
  const b = bubbleOf(w, id);
  if (!b) return;
  d.wc = WRIGGLE_GAP;
  b[8] = Math.min(ESC_FULL, b[8] + (trails(w, id) ? ESC_BEHIND : ESC_ADD));
}

// A hand, at its place in the room's order: [the way run, -1 to 1; buttons
// held, 1 jump and 2 down; the jump counter; the bubble counter]. A jump or a
// bubble is asked for once, when its counter changes; the same hand said again
// to keep a player at the table asks for nothing. Being heard is how a player
// arrives: in the arena at once while the table waits for a round or counts
// one in, and a moment later while a round is on.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[2], input[3]);
    if (w.ph === WAIT) respawn(w, id);
    else if (w.ph === COUNT) place(d, startX(d.s), FLOOR);
    d.mx = input[0];
    d.hb = input[1];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  wriggle(w, id, input[0]);
  d.mx = input[0];
  d.hb = input[1];
  if (input[2] !== d.jq) { d.jq = input[2]; d.jb = JUMP_BUF; }
  if (input[3] !== d.sq) { d.sq = input[3]; d.sb = 1; }
}

// A hand off the wire, made safe: four integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [m, h, j, s] = raw;
  if (!Number.isInteger(m) || !Number.isInteger(h) || !Number.isInteger(j) || !Number.isInteger(s)) return null;
  if (m < -1 || m > 1 || h < 0 || h > 3 || j < 0 || j > 999 || s < 0 || s > 999) return null;
  return [m, h, j, s];
}

function leave(w, id) {
  delete w.p[id];
  // A bubble holding somebody who has gone is an empty one now.
  for (const b of w.b) if (b[6] === 1 && b[7] === id) { b[6] = 0; b[7] = 0; b[8] = 0; b[4] = EMPTY_LIFE - 30; }
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.08;         // how often it stands a moment rather than decide
const BOT_SHOT = 0.4;          // how often it blows when a bubble would reach
const BOT_WRIGGLE = 0.5;       // how often it wriggles when it may
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0, 0);
    respawn(w, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// It goes for a trapped rival to pop when there is one, and for the nearest
// player to bubble when there is not: runs at it, jumps when it is above,
// drops through when it is below, and blows when it is level and in reach.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.st === TRAPPED) {
    if (w.n % BOT_EVERY === 0 && draw01(w) < BOT_WRIGGLE) {
      const mx = d.lm === 1 ? -1 : 1;
      wriggle(w, BOT_ID, mx);
      d.mx = mx;
    }
    return;
  }
  if (d.st !== ALIVE) return;
  if (d.bd > 0) d.bd -= 1;
  else d.hb &= 1;
  if (d.bw > 0) { d.bw -= 1; d.mx = 0; d.hb = 0; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 4 + Math.floor(draw01(w) * 10); d.mx = 0; d.hb = 0; return; }
  let tx = -1, ty = 0, hunt = false, best = Infinity;
  for (const b of w.b) {
    if (b[6] !== 1 || b[7] === BOT_ID) continue;
    const far = Math.abs(b[1] - d.x) + Math.abs(b[2] - d.y);
    if (far < best) { best = far; tx = b[1]; ty = b[2] + PH / 2; }
  }
  if (tx < 0) {
    for (const o of humans(w)) {
      const e = w.p[o];
      if (e.st !== ALIVE) continue;
      const far = Math.abs(e.x - d.x) + Math.abs(e.y - d.y);
      if (far < best) { best = far; tx = e.x; ty = e.y; hunt = e.sh === 0; }
    }
  }
  if (tx < 0) { d.mx = d.f; return; }
  const dx = tx - d.x, dy = ty - d.y;
  // Above it, it heads for the nearest platform a row up on the way there,
  // and jumps from under it.
  let gx = tx, under = true;
  if (dy < -150) {
    let cost = Infinity;
    for (const [py, x0, x1] of LEVELS[w.lv]) {
      if (py >= d.y - 60 || py < d.y - 280) continue;
      const nx = clamp(d.x, x0 + 50, x1 - 50), c = Math.abs(nx - d.x) + Math.trunc(Math.abs(nx - tx) / 2);
      if (c < cost) { cost = c; gx = nx; under = d.x >= x0 + 30 && d.x <= x1 - 30; }
    }
  }
  d.mx = Math.abs(gx - d.x) > (dy < -150 ? 10 : 30) ? sign(gx - d.x) : 0;
  d.hb = d.vy < 0 ? d.hb & 1 : 0;
  if (dy < -150 && d.g && under && draw01(w) < 0.7) { d.jb = 3; d.hb = 1; }
  else if (dy > 150 && d.g && d.y < FLOOR && draw01(w) < 0.5) { d.hb = 2; d.bd = 3; }
  // Level with its quarry it blows when the bubble would reach, at point
  // blank whichever way it faces.
  const level = hunt && Math.abs(dy) < 70;
  if (level && Math.abs(dx) < 40 && dx !== 0 && sign(dx) !== d.f) d.mx = sign(dx);
  if (level && Math.abs(dx) < 560 && (sign(dx) === d.f || dx === 0) && d.cd === 0 && draw01(w) < BOT_SHOT) d.sb = 1;
}

// ── a step ─────────────────────────────────────────────────────────────────
function lineUp(w) {
  for (const id of bySeat(w)) {
    const d = w.p[id];
    place(d, startX(d.s), FLOOR);
  }
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  w.b = [];
  for (const id of playersIn(w)) { const d = w.p[id]; d.rp = d.pops = d.cau = 0; }
  lineUp(w);
}

// A round: a fresh arena, the seats closed up in order, everybody on the
// floor at a spot of their own.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.lv = (w.lv + 1 + Math.floor(draw01(w) * (LEVELS.length - 1))) % LEVELS.length;
  w.b = [];
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  for (const id of ids) { const d = w.p[id]; d.rp = d.pops = d.cau = 0; }
  lineUp(w);
  fx(w, 'round', 0, 0, 0);
}

// The whistle: the round to whoever has the most points, the fewer times
// caught between two who match, and nobody if that matches too.
function finish(w) {
  const ids = bySeat(w);
  const rank = (a, b) => w.p[b].rp - w.p[a].rp || w.p[a].cau - w.p[b].cau;
  const order = ids.slice().sort((a, b) => rank(a, b) || a - b);
  const top = order[0];
  w.win = ids.length > 1 && (order.length < 2 || rank(top, order[1]) !== 0) ? top : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  w.res = order.map((id) => [id, w.p[id].rp, w.p[id].pops, w.p[id].cau, w.p[id].wn]);
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
      d.jb = d.sb = 0;
      d.vx = d.vy = 0;
    }
    return;
  }
  romp(w);
}

const rush = (w) => w.ph === PLAY && PLAY_STEPS - w.pt >= RUSH_AT;

function romp(w) {
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.wc > 0) d.wc -= 1;
    if (d.st === GONE) {
      d.jb = d.sb = 0;
      if (d.rt > 1) d.rt -= 1;
      else respawn(w, id);
    }
  }
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== ALIVE) continue;
    run(w, d, id);
    move(w, d, id);
    if (d.cd > 0) d.cd -= 1;
    if (d.sh > 0) d.sh -= 1;
  }
  for (const id of ids) {
    const d = w.p[id];
    if (d.st === ALIVE && d.sb) blow(w, d, id);
    d.sb = 0;
  }
  float(w, ids);
  touch(w, ids);
}

// The hand's way becomes a speed, closed quickly on the ground and slowly in
// the air; a jump asked for is taken on the ground, or just off a ledge, and
// waits a few steps for the ground otherwise. Letting go of jump early cuts
// the rise short.
function run(w, d, id) {
  const target = d.mx * RUN, acc = d.g ? ACC_G : ACC_A;
  if (d.vx < target) d.vx = Math.min(target, d.vx + acc);
  else if (d.vx > target) d.vx = Math.max(target, d.vx - acc);
  if (d.mx) d.f = d.mx;
  if (d.jb > 0) {
    if (d.ct <= COYOTE) {
      d.vy = -JUMP_V;
      d.jb = 0;
      d.ct = COYOTE + 1;
      d.g = 0;
      fx(w, 'jump', d.x, d.y, 0, id);
    } else d.jb -= 1;
  }
  if (d.vy < -CUT_V && !(d.hb & 1)) d.vy = -CUT_V;
  d.vy = Math.min(MAXFALL, d.vy + GRAV);
}

// Platforms are one way: a blob rises through them and lands on their top,
// unless it holds down, which drops it through. The floor holds everybody.
function move(w, d, id) {
  const oy = d.y;
  d.x += d.vx;
  if (d.x < PW) { d.x = PW; d.vx = 0; }
  if (d.x > W - PW) { d.x = W - PW; d.vx = 0; }
  d.y += d.vy;
  const fell = d.vy;
  d.g = 0;
  if (d.vy >= 0) {
    let land = d.y >= FLOOR ? FLOOR : -1;
    if (!(d.hb & 2)) {
      for (const [py, x0, x1] of LEVELS[w.lv]) {
        if (oy <= py && d.y >= py && d.x + PW > x0 && d.x - PW < x1 && (land < 0 || py < land)) land = py;
      }
    }
    if (land >= 0) {
      d.y = land;
      d.vy = 0;
      d.g = 1;
      if (fell > 16) fx(w, 'land', d.x, d.y, fell, id);
    }
  }
  if (d.y - PH < 0) { d.y = PH; if (d.vy < 0) d.vy = 0; }
  d.ct = d.g ? 0 : Math.min(99, d.ct + 1);
}

// A bubble blown from the mouth the way the blob faces. Past MAX_OWN empty
// bubbles of one's own in the air, the oldest of them pops to make room.
function blow(w, d, id) {
  if (d.cd > 0) return;
  const own = w.b.filter((b) => b[5] === id && b[6] === 0);
  if (own.length >= MAX_OWN) {
    const old = own[0];
    w.b.splice(w.b.indexOf(old), 1);
    fx(w, 'fizz', old[1], old[2], 0, id);
  }
  if (w.b.length >= MAX_B) return;
  const x = clamp(d.x + d.f * (PW + BR - 16), BR, W - BR), y = d.y - Math.trunc(PH / 2);
  w.bn = (w.bn + 1) % 100000;
  w.b.push([w.bn, x, y, d.f * SHOT_V, 0, id, 0, 0, 0, trails(w, id) ? SHOT_LONG : SHOT_STEPS]);
  d.cd = SHOT_CD;
  fx(w, 'shoot', x, y, d.f, id);
}

// Whether a circle and a blob's box overlap.
function hits(cx, cy, r, d) {
  const nx = clamp(cx, d.x - PW, d.x + PW), ny = clamp(cy, d.y - PH, d.y);
  const ex = cx - nx, ey = cy - ny;
  return ex * ex + ey * ey < r * r;
}

const flying = (b) => b[6] === 0 && b[4] <= b[9];

// A flying bubble that touches a rival who is standing and unshielded takes
// them: the first of them in seat order, and only one.
function catches(w, b, ids) {
  for (const id of ids) {
    const d = w.p[id];
    if (id === b[5] || d.st !== ALIVE || d.sh > 0 || !hits(b[1], b[2], BR, d)) continue;
    b[6] = 1; b[7] = id; b[8] = 0; b[4] = 0; b[3] = 0;
    b[2] = clamp(d.y - Math.trunc(PH / 2), CEIL + BF, FLOOR - BF);
    b[1] = clamp(d.x, BF, W - BF);
    d.st = TRAPPED;
    d.vx = d.vy = d.jb = 0;
    d.cau += 1;
    fx(w, 'trap', b[1], b[2], 0, b[5], id);
    return true;
  }
  return false;
}

// Every bubble moves: a flying one straight on, slowing at the end of its
// flight and trapping the first rival it touches; a floating one up, until the
// foam stops it. A full one carries its captive, and lets them go when they
// have wriggled enough or it has held them long enough.
function float(w, ids) {
  const gone = new Set();
  for (const b of w.b) {
    b[4] += 1;
    if (b[6] === 0) {
      if (b[4] <= b[9]) {
        // Tested where it starts the step and where it ends it, so a bubble
        // blown point blank does not fly past a rival before it is looked at.
        if (catches(w, b, ids)) continue;
        if (b[4] > b[9] - 4) b[3] = Math.trunc((b[3] * 3) / 4);
        b[1] += b[3];
        if (b[1] < BR || b[1] > W - BR) { b[1] = clamp(b[1], BR, W - BR); b[3] = 0; }
        catches(w, b, ids);
      } else {
        b[2] = Math.max(CEIL + BR, b[2] - RISE);
        if (b[4] > EMPTY_LIFE) { gone.add(b[0]); fx(w, 'fizz', b[1], b[2], 0, b[5]); }
      }
    } else {
      b[2] = Math.max(CEIL + BF, b[2] - RISE_F);
      if (b[8] >= ESC_FULL || b[4] > TRAP_LIFE) { gone.add(b[0]); free(w, b, b[8] >= ESC_FULL); }
    }
  }
  if (gone.size) w.b = w.b.filter((b) => !gone.has(b[0]));
  // Floating bubbles shoulder each other apart rather than pile up in one place.
  const still = w.b.filter((b) => !flying(b));
  for (let i = 0; i < still.length; i++) {
    for (let j = i + 1; j < still.length; j++) {
      const a = still[i], c = still[j];
      const reach = (a[6] ? BF : BR) + (c[6] ? BF : BR);
      let ex = c[1] - a[1], ey = c[2] - a[2];
      const d2 = ex * ex + ey * ey;
      if (d2 >= reach * reach) continue;
      let far = isqrt(d2);
      if (far === 0) { ex = a[0] < c[0] ? 1 : -1; ey = 0; far = 1; }
      const push = Math.trunc((reach - far) / 2) + 1;
      a[1] -= Math.trunc((ex * push) / far); a[2] -= Math.trunc((ey * push) / far);
      c[1] += Math.trunc((ex * push) / far); c[2] += Math.trunc((ey * push) / far);
    }
  }
  for (const b of still) {
    const r = b[6] ? BF : BR;
    b[1] = clamp(b[1], r, W - r);
    b[2] = clamp(b[2], CEIL + r, FLOOR - r);
  }
  // A captive sits in the middle of its bubble.
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== TRAPPED) continue;
    const b = bubbleOf(w, id);
    if (!b) { d.st = ALIVE; d.sh = SHIELD_FREE; continue; }
    d.x = b[1];
    d.y = b[2] + Math.trunc(PH / 2);
  }
}

// A captive out of its bubble, on its own: a little hop and a moment's shield.
function free(w, b, broke) {
  const d = w.p[b[7]];
  if (!d || d.st !== TRAPPED) return;
  d.st = ALIVE;
  d.x = clamp(b[1], PW, W - PW);
  d.y = clamp(b[2] + Math.trunc(PH / 2), PH, FLOOR);
  d.vx = 0;
  d.vy = -8;
  d.g = 0;
  d.ct = COYOTE + 1;
  d.sh = SHIELD_FREE;
  fx(w, 'free', b[1], b[2], broke ? 1 : 0, b[7]);
}

// A standing blob that touches a full bubble pops it and scores: a point, two
// in the last stretch, and one more when the captive is the leader. One that
// lands on an empty bubble bounces off it; one that bumps it any other way
// pops it for nothing.
function touch(w, ids) {
  const gone = new Set();
  for (const id of ids) {
    const d = w.p[id];
    for (const b of w.b) {
      if (d.st !== ALIVE || gone.has(b[0]) || flying(b)) continue;
      if (b[6] === 1) {
        if (b[7] === id || !hits(b[1], b[2], BF, d)) continue;
        const c = w.p[b[7]];
        gone.add(b[0]);
        if (!c) continue;
        const v = (rush(w) ? 2 : 1) + (leaderOf(w) === b[7] ? 1 : 0);
        d.rp += v;
        d.pops += 1;
        d.vy = Math.min(d.vy, -16);
        c.st = GONE;
        c.rt = BACK_STEPS;
        c.vx = c.vy = 0;
        fx(w, 'pop', b[1], b[2], v, id, b[7]);
      } else {
        if (!hits(b[1], b[2], BR, d)) continue;
        if (d.vy > 0 && d.y - d.vy <= b[2] - Math.trunc(BR / 2)) {
          d.vy = d.hb & 1 ? -BOUNCE_HI : -BOUNCE;
          d.y = Math.min(d.y, b[2] - Math.trunc(BR / 2));
          d.ct = COYOTE + 1;
          d.jb = 0;
          b[2] = Math.min(FLOOR - BR, b[2] + 10);
          fx(w, 'boing', b[1], b[2] - BR, 0, id);
        } else {
          gone.add(b[0]);
          fx(w, 'fizz', b[1], b[2], 0, id);
        }
      }
    }
  }
  if (gone.size) w.b = w.b.filter((b) => !gone.has(b[0]));
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.lv, 0, LEVELS.length - 1) || !int(raw.bn, 0, 99999)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.st, ALIVE, GONE) || !int(d.x, 0, W) || !int(d.y, 0, H)) return null;
    if (!int(d.vx, -RUN, RUN) || !int(d.vy, -BOUNCE_HI, MAXFALL) || !int(d.f, -1, 1) || d.f === 0) return null;
    if (inputOf([d.mx, d.hb, d.jq, d.sq]) === null || !int(d.jb, 0, JUMP_BUF) || !int(d.sb, 0, 1)) return null;
    if (!int(d.g, 0, 1) || !int(d.ct, 0, 99) || !int(d.cd, 0, SHOT_CD) || !int(d.sh, 0, SHIELD)) return null;
    if (!int(d.rt, 0, BACK_STEPS) || !int(d.lm, -1, 1) || !int(d.wc, 0, WRIGGLE_GAP)) return null;
    if (!int(d.rp, 0, 99999) || !int(d.pops, 0, 99999) || !int(d.cau, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bw, 0, 99) || !int(d.bd, 0, 9) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  if (!Array.isArray(raw.b) || raw.b.length > MAX_B) return null;
  const b = [];
  const nums = new Set();
  for (const q of raw.b) {
    if (!Array.isArray(q) || q.length !== 10) return null;
    const [n, x, y, vx, age, own, full, cap, esc, fl] = q;
    if (!int(n, 0, 99999) || nums.has(n) || !int(x, 0, W) || !int(y, 0, H) || !int(vx, -SHOT_V, SHOT_V)) return null;
    if (!int(age, 0, EMPTY_LIFE + 1) || !int(own, -BIG, BIG) || !int(full, 0, 1) || !int(cap, -BIG, BIG)) return null;
    if (!int(esc, 0, ESC_FULL) || !int(fl, SHOT_STEPS, SHOT_LONG)) return null;
    nums.add(n);
    b.push(q.slice());
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
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, lv: raw.lv, bn: raw.bn, b, p, res, win: raw.win };
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
// One palette: a soda fountain after dark. A plum-to-teal glass full of
// rising fizz, candy-striped platforms with cream tops, soap-film bubbles
// ringed in their blower's colour, and every blob a bright gumdrop of its own.
const INK = {
  page: '#1a1238', glow: '#2c2066', text: '#ffffff', muted: '#d7cdf5', dim: '#9a8fc4', gold: '#ffd166',
  danger: '#ff5a6e', glassTop: '#2a1d5c', glassBot: '#0f3b4f', candy: '#ff7aa8', candyDark: '#d9557f',
  cream: '#fff1d6', floor: '#5a2d6b', floorTop: '#ffb3d0', panel: 'rgba(18,12,42,0.93)', foam: 'rgba(255,255,255,0.28)',
};
const SEAT = ['#ff4f7b', '#3fa9ff', '#ffb020', '#9cff3a', '#e25cff', '#20e3ff', '#ff7a2e', '#b7a6ff'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #5a4a9f;' +
  `background:#2a2060;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
const SIDE = 160;              // the least a column beside the arena needs for the scoreboard
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

// The whole arena is always on screen, as large as the frame lets it be. A
// frame wider than the arena puts the status, the scoreboard, your bubbles and
// the line of controls in the columns either side of it, so the arena takes
// the whole height. A narrower one stacks them in strips above and below it,
// with NOTE_ROOM under it for the practice note and, in a round, for your
// bubbles — the floor is where everybody stands, so nothing covers it.
// Whichever of the two draws the arena bigger is the one used.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  const tall = Math.min((VW - 8) / W, ah / H), side = Math.min((VH - 12) / H, (VW - 2 * SIDE) / W);
  wide = side > tall;
  sc = Math.max(0.02, wide ? side : tall);
  ox = (VW - sc * W) / 2;
  oy = wide ? (VH - sc * H) / 2 : TOP + (ah - sc * H) / 2;
  colW = wide ? ox : 0;
  fieldTop = oy;
  fieldBot = oy + sc * H;
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
  blow() { if (ready('blow', 60)) { tone(320, 0.12, 'sine', 0.09, 2.2); puff(0.08, 0.03, 2600, 0, 2); } },
  jump() { if (ready('jump', 60)) tone(260, 0.12, 'square', 0.025, 1.9); },
  trap(mine) {
    if (!ready('trap', 80)) return;
    tone(mine ? 520 : 420, 0.35, 'triangle', 0.08, 0.6);
    tone(mine ? 780 : 640, 0.3, 'sine', 0.05, 0.7, 0.05);
  },
  trapped() { if (ready('trapped', 200)) { tone(300, 0.5, 'sine', 0.1, 0.5); tone(306, 0.5, 'sine', 0.06, 0.52); } },
  pop(near, mine) {
    if (!ready('pop', 50)) return;
    puff(0.16, 0.08 + 0.12 * near, 1600, 0, 0.8);
    tone(900, 0.09, 'sine', 0.08 + 0.08 * near, 0.35);
    if (mine) [659, 880, 1175].forEach((f, i) => tone(f, 0.1, 'triangle', 0.08, 0, 0.05 + i * 0.05));
  },
  popped() { if (ready('popped', 200)) { puff(0.3, 0.14, 900, 0, 0.7); tone(440, 0.5, 'sawtooth', 0.04, 0.3); } },
  fizz(near) { if (ready('fizz', 60)) puff(0.07, 0.015 + 0.04 * near, 4200, 0, 2.5); },
  boing() { if (ready('boing', 70)) { tone(180, 0.22, 'sine', 0.1, 3.2); tone(360, 0.12, 'triangle', 0.03, 2.0, 0.02); } },
  free() { if (ready('free', 150)) { puff(0.2, 0.08, 2000, 0, 1); [523, 784].forEach((f, i) => tone(f, 0.1, 'triangle', 0.07, 0, i * 0.06)); } },
  land(hard) { if (ready('land', 80)) puff(0.08, 0.02 + 0.05 * hard, 500, 0, 1.4); },
  back() { if (ready('back', 200)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, i * 0.05)); },
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
// fast screen and a slow one see the same spray. Positions are arena units.
const bits = [];      // { x, y, vx, vy, g, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, g) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: g === undefined ? 900 : g, life: 0, max: 18 + Math.random() * 22, size, colour });
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
      b.vx *= 0.93; b.vy *= 0.93;
      b.vy += b.g / BIT_HZ;
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
const looks = new Map();      // id -> { squash, lean, seen, blink }
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const lookOf = (id, now) => {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, lean: 0, seen: now, blink: now + 2000 + Math.random() * 3000 }));
  l.seen = now;
  return l;
};

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = md ? Math.max(0, 1 - (Math.abs(md.x - e.x) + Math.abs(md.y - e.y)) / 1600) : 0.3;
  if (e.kind === 'pop') {
    const c = colourOf(t, e.b);
    spray(e.x, e.y, 26, '#ffffff', 900, 14, 300);
    spray(e.x, e.y, 14, c, 700, 18, 600);
    ring(e.x, e.y, colourOf(t, e.a), 200);
    pop(e.x, e.y - 40, '+' + e.z, colourOf(t, e.a), e.a === me ? 20 : 15);
    pop(e.x, e.y + 30, 'pop!', '#ffffff', 16);
    if (e.b === me) { shake = Math.max(shake, 14); sound.popped(); }
    else { if (e.a === me) shake = Math.max(shake, 6); sound.pop(near, e.a === me); }
    const l = looks.get(e.a);
    if (l) l.squash = 1;
  } else if (e.kind === 'trap') {
    ring(e.x, e.y, colourOf(t, e.a), 150);
    spray(e.x, e.y, 10, '#ffffff', 400, 8, -200);
    pop(e.x, e.y - 70, 'trapped!', colourOf(t, e.a), e.a === me || e.b === me ? 17 : 13);
    if (e.b === me) { shake = Math.max(shake, 8); sound.trapped(); } else sound.trap(e.a === me);
  } else if (e.kind === 'free') {
    ring(e.x, e.y, '#ffffff', 140);
    spray(e.x, e.y, 16, '#ffffff', 600, 10, 200);
    if (e.a === me) { pop(e.x, e.y - 60, e.z ? 'broke free!' : 'free!', INK.text, 16); }
    else if (e.z) pop(e.x, e.y - 60, 'free!', colourOf(t, e.a), 13);
    sound.free();
  } else if (e.kind === 'fizz') {
    spray(e.x, e.y, 8, 'rgba(255,255,255,0.9)', 400, 7, -150);
    sound.fizz(near);
  } else if (e.kind === 'boing') {
    spray(e.x, e.y, 6, '#ffffff', 300, 7, 0);
    const l = looks.get(e.a);
    if (l) l.squash = 0.9;
    if (e.a === me || near > 0.6) sound.boing();
  } else if (e.kind === 'shoot') {
    spray(e.x, e.y, 4, '#ffffff', 250, 6, -100);
    if (e.a !== me && near > 0.4) sound.blow();
  } else if (e.kind === 'jump') {
    spray(e.x, e.y, 5, 'rgba(255,220,240,0.8)', 260, 7, 400);
    const l = looks.get(e.a);
    if (l) l.squash = -0.6;
  } else if (e.kind === 'land') {
    spray(e.x, e.y, 6, 'rgba(255,220,240,0.8)', 300, 7, 300);
    const l = looks.get(e.a);
    if (l) l.squash = Math.min(1, e.z / 26);
    if (e.a === me) sound.land(Math.min(1, e.z / 26));
  } else if (e.kind === 'back') {
    ring(e.x, e.y, colourOf(t, e.a), 120);
    if (e.a === me) { pop(e.x, e.y - 50, 'back in!', INK.text, 15); sound.back(); }
  } else if (e.kind === 'rush') {
    pop(W / 2, H / 2, 'double pops!', INK.gold, 24);
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

function drawBack(now) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // Fizz rising past the arena, all over the frame.
  for (let i = 0; i < 34; i++) {
    const sp = 22 + (i % 7) * 9;
    const x = ((i * 89.7 + Math.sin(now / 900 + i * 1.3) * 8) % VW + VW) % VW;
    const y = VH + 10 - ((i * 47.1 + now / (1000 / sp)) % (VH + 20));
    ctx.strokeStyle = `rgba(255,255,255,${0.12 + (i % 4) * 0.05})`;
    ctx.lineWidth = 1;
    disc(x, y, 1.2 + (i % 3) * 0.9);
    ctx.stroke();
  }
}

// The arena: a glass of soda with bubbles drifting up the back of it, the
// foam line, the candy platforms, and the floor.
function drawArena(t, now) {
  flat();
  const x0 = SX(0), y0 = SY(0), w = W * sc, h = H * sc;
  ctx.fillStyle = 'rgba(5,4,18,0.45)';
  roundRect(x0 - 3, y0 + 3, w + 10, h + 8, 12);
  ctx.fill();
  ctx.fillStyle = '#120c2c';
  roundRect(x0 - 5, y0 - 5, w + 10, h + 10, 12);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, w, h, 8);
  ctx.clip();
  const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
  g.addColorStop(0, INK.glassTop);
  g.addColorStop(1, INK.glassBot);
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, h);
  if (rush(t)) {
    ctx.fillStyle = `rgba(255,200,80,${(0.05 + 0.04 * Math.sin(now / 160)).toFixed(3)})`;
    ctx.fillRect(x0, y0, w, h);
  }
  // Soft bokeh of far-off bubbles, and the glass's long highlights.
  for (let i = 0; i < 14; i++) {
    const bx = x0 + (((i * 0.137 + 0.05) % 1) * w), r = (30 + (i % 5) * 22) * sc;
    const by = y0 + h - ((i * 0.31 * h + now * (0.008 + (i % 3) * 0.004) * sc * 10) % (h + 4 * r)) + 2 * r;
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    disc(bx, by, r);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(x0 + w * 0.08, y0, w * 0.035, h);
  ctx.fillRect(x0 + w * 0.88, y0, w * 0.015, h);
  // The foam under the rim, where bubbles gather.
  ctx.fillStyle = INK.foam;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let k = 0; k <= 24; k++) {
    const px = x0 + (k / 24) * w, py = SY(CEIL) + Math.sin(now / 700 + k * 1.7) * 3 * sc * 10;
    ctx.lineTo(px, py);
  }
  ctx.lineTo(x0 + w, y0);
  ctx.closePath();
  ctx.fill();
  // The platforms: candy bars with a cream top and stripes down their face.
  const ph = 26 * sc * 1.6;
  for (const [py, a, b] of LEVELS[t.lv]) drawBar(SX(a), SY(py), (b - a) * sc, ph);
  // The floor.
  const fy = SY(FLOOR);
  ctx.fillStyle = INK.floor;
  ctx.fillRect(x0, fy, w, y0 + h - fy);
  ctx.fillStyle = INK.floorTop;
  ctx.fillRect(x0, fy, w, Math.max(2, 12 * sc));
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  for (let k = 0; k < 30; k++) ctx.fillRect(x0 + (k + 0.3) * (w / 30), fy + 16 * sc, w / 60, y0 + h - fy);
  ctx.restore();
}

function drawBar(x, y, w, h) {
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  roundRect(x + 2, y + 3, w, h, h / 2);
  ctx.fill();
  ctx.save();
  roundRect(x, y, w, h, h / 2);
  ctx.clip();
  ctx.fillStyle = INK.candy;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = INK.candyDark;
  const step = h * 1.4;
  ctx.beginPath();
  for (let sx = x - h; sx < x + w + h; sx += step) {
    ctx.moveTo(sx, y + h);
    ctx.lineTo(sx + h * 0.5, y + h);
    ctx.lineTo(sx + h * 1.1, y);
    ctx.lineTo(sx + h * 0.6, y);
    ctx.closePath();
  }
  ctx.fill();
  ctx.fillStyle = INK.cream;
  ctx.fillRect(x, y, w, h * 0.36);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillRect(x + h * 0.4, y + h * 0.08, w - h * 0.8, h * 0.08);
  ctx.restore();
}

// A bubble: a film tinted by its blower's colour with a bright rim and a
// highlight; a flying one is stretched along its flight. A full one holds its
// captive, shows how far they have wriggled as an arc round it, and shivers as
// it is about to burst on its own.
function drawBubble(b, x, y, t, now) {
  const full = b[6] === 1, own = colourOf(t, b[5]);
  let r = (full ? BF : BR) * sc;
  const fly = flying(b);
  const wob = Math.sin(now / 180 + b[0]) * 0.04;
  let rx = r * (1 + wob), ry = r * (1 - wob);
  if (fly) { rx = r * 1.15; ry = r * 0.88; }
  if (!full && b[4] > EMPTY_LIFE - 30 && Math.floor(now / 90) % 2) { rx *= 0.96; ry *= 0.96; }
  const sx = SX(x), sy = SY(y);
  if (full) {
    const c = t.p[b[7]];
    if (c) drawBlob(b[7], sx, sy + PH * 0.5 * sc, c, colourOf(t, b[7]), b[7] === myId(), t, now, true);
  }
  const g = ctx.createRadialGradient(sx - rx * 0.3, sy - ry * 0.35, r * 0.1, sx, sy, r);
  g.addColorStop(0, 'rgba(255,255,255,0.04)');
  g.addColorStop(0.75, alpha(own, full ? 0.16 : 0.12));
  g.addColorStop(1, alpha(own, full ? 0.42 : 0.32));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = mix(own, '#ffffff', 0.45);
  ctx.lineWidth = Math.max(1.2, r * 0.07);
  ctx.beginPath(); ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(1.2, r * 0.09);
  ctx.beginPath(); ctx.ellipse(sx, sy, rx * 0.7, ry * 0.7, 0, Math.PI * 1.1, Math.PI * 1.45); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  disc(sx + rx * 0.42, sy - ry * 0.45, Math.max(1, r * 0.08));
  ctx.fill();
  if (full) {
    const c = t.p[b[7]];
    if (b[8] > 0 && c) {
      ctx.strokeStyle = SEAT[c.c];
      ctx.lineWidth = Math.max(2, r * 0.1);
      ctx.beginPath();
      ctx.arc(sx, sy, r + Math.max(3, r * 0.12), -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * b[8]) / ESC_FULL);
      ctx.stroke();
    }
    const left = TRAP_LIFE - b[4];
    if (left < 30) {
      ctx.strokeStyle = `rgba(255,255,255,${(0.4 + 0.4 * Math.sin(now / 50)).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      disc(sx, sy, r * 1.08);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// A blob: a gumdrop in its seat's colour, eyes the way it faces, little feet,
// squashed when it lands and stretched when it jumps; a crown on the leader,
// a blinking ring while shielded, its name over its head.
function drawBlob(id, sx, sy, d, colour, me, t, now, inside) {
  const l = lookOf(id, now);
  l.squash *= Math.pow(0.84, frameDt * 60);
  l.lean = lerp(l.lean, inside ? Math.sin(now / 90) * 0.25 : (d.vx / RUN) * 0.12, per60(0.25));
  const s = sc * (inside ? 0.82 : 1);
  const sq = l.squash;
  const bw = PW * 2.1 * s * (1 + sq * 0.2), bh = PH * s * (1 - sq * 0.22);
  const cx = sx, base = sy;
  if (!inside) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(cx, base + 2, bw * 0.55, Math.max(1.5, bw * 0.12), 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save();
  ctx.translate(cx, base);
  ctx.rotate(l.lean);
  // Feet.
  ctx.fillStyle = mix(colour, '#000000', 0.35);
  const step = !inside && d.g && Math.abs(d.vx) > 2 ? Math.sin(now / 60) * bw * 0.12 : 0;
  ctx.beginPath(); ctx.ellipse(-bw * 0.22 + step, -bh * 0.04, bw * 0.17, bh * 0.08, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(bw * 0.22 - step, -bh * 0.04, bw * 0.17, bh * 0.08, 0, 0, Math.PI * 2); ctx.fill();
  // Body.
  const g = ctx.createLinearGradient(0, -bh, 0, 0);
  g.addColorStop(0, mix(colour, '#ffffff', 0.25));
  g.addColorStop(1, mix(colour, '#000000', 0.18));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-bw / 2, -bh * 0.12);
  ctx.bezierCurveTo(-bw / 2, -bh * 1.08, bw / 2, -bh * 1.08, bw / 2, -bh * 0.12);
  ctx.quadraticCurveTo(0, bh * 0.02, -bw / 2, -bh * 0.12);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.ellipse(-bw * 0.18, -bh * 0.72, bw * 0.12, bh * 0.08, -0.5, 0, Math.PI * 2); ctx.fill();
  // Eyes, looking the way it faces; wide open when trapped.
  const f = d.f || 1, ey = -bh * 0.55, er = bw * (inside ? 0.15 : 0.13);
  const blink = !inside && now > l.blink && now < l.blink + 120;
  if (now > l.blink + 120) l.blink = now + 2000 + Math.random() * 3000;
  for (const k of [-1, 1]) {
    const ex = f * bw * 0.12 + k * bw * 0.17;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(ex, ey, er, blink ? er * 0.15 : er * 1.15, 0, 0, Math.PI * 2); ctx.fill();
    if (!blink) {
      ctx.fillStyle = '#1a1238';
      disc(ex + f * er * 0.35, ey + er * 0.1, er * (inside ? 0.38 : 0.5));
      ctx.fill();
    }
  }
  if (!inside) {
    // The wand-mouth the bubbles come out of.
    ctx.fillStyle = 'rgba(30,10,40,0.6)';
    disc(f * bw * 0.3, -bh * 0.3, Math.max(1, bw * 0.06));
    ctx.fill();
  }
  ctx.restore();
  if (inside) return;
  if (d.sh > 0 && Math.floor(now / 120) % 2 === 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    disc(cx, base - bh * 0.5, Math.max(bw, bh) * 0.75);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  let top = base - bh - 6;
  if (leaderOf(t) === id) {
    const cs = Math.max(5, bw * 0.28), cy = top - cs * 0.2;
    ctx.fillStyle = INK.gold;
    ctx.beginPath();
    ctx.moveTo(cx - cs, cy);
    ctx.lineTo(cx - cs, cy - cs * 0.9);
    ctx.lineTo(cx - cs * 0.5, cy - cs * 0.4);
    ctx.lineTo(cx, cy - cs * 1.1);
    ctx.lineTo(cx + cs * 0.5, cy - cs * 0.4);
    ctx.lineTo(cx + cs, cy - cs * 0.9);
    ctx.lineTo(cx + cs, cy);
    ctx.closePath();
    ctx.fill();
    top = cy - cs * 1.1 - 3;
  }
  const px = Math.max(9, Math.min(13, 6 + bh * 0.12));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(18,12,42,0.85)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  ctx.strokeText(label, cx, top);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, cx, top);
}

function drawBits() {
  flat();
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    disc(SX(b.x), SY(b.y), b.size * sc * (1 - f * 0.5));
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
    ctx.strokeStyle = 'rgba(18,12,42,0.85)';
    const X = Math.max(fieldLeft() + 50, Math.min(fieldLeft() + W * sc - 50, SX(p.x))), Y = Math.max(fieldTop + 18, SY(p.y) - rise);
    ctx.strokeText(p.s, X, Y);
    ctx.fillStyle = p.colour;
    ctx.fillText(p.s, X, Y);
  }
  ctx.globalAlpha = 1;
}
const fieldLeft = () => ox;

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
    if (rush(t)) { status += ' · double pops'; colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text; }
  } else status = 'round ' + t.rd + ' · over';
  text('fizz', 12, 22, titlePx, '#ffb3d0', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('fizz').width;
  if (wide) fitText(status, 12, 44, 14, colour, colW - 24, 'left');
  else fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with their points this
  // round and rounds won; a popped or trapped blob's chip is hollow, and the
  // leader's carries a crown. A row across the top of a narrow frame, a column
  // down the left of a wide one.
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
      if (d.st === ALIVE) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      const score = String(d.rp);
      ctx.font = font(12);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 8, y + 3, 12, id === lead ? INK.gold : INK.text, 'right');
      const wins = t.ph !== WAIT && d.wn ? '★' + d.wn : '';
      ctx.font = font(10);
      const ww = wins ? ctx.measureText(wins).width + 5 : 0;
      if (wins && cw > 56) text(wins, x + cw - 12 - sw, y + 2, 10, '#eef1ff', 'right');
      if (cw > 64) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, d.st === ALIVE ? (mine ? INK.text : INK.muted) : INK.dim, cw - 34 - sw - ww, 'left');
      if (wide) y += 22 + gap; else x += cw + gap;
    }
  }

  // The one line that says how to play: across the foot of a narrow frame, and
  // broken into lines at the foot of the right-hand column of a wide one.
  const how = coarse
    ? 'drag to run · drag up to jump, down to drop · tap to blow · pop trapped rivals'
    : 'arrows/WASD run · up, W or space jumps · down drops · X, J or click blows · M mutes';
  if (!wide) { fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20); return; }
  const lines = wrap(how, 12, colW - 24);
  lines.forEach((s, i) => text(s, VW - 12, VH - 12 - (lines.length - 1 - i) * 17, 12, INK.muted, 'right'));
}

// Your bubbles, or what is happening to you, while a round is on: in the
// strip under the arena, or halfway down the right-hand column of a wide one.
function drawMine(t, now) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = wide ? VH / 2 : Math.min(fieldBot + NOTE_ROOM / 2 - 4, VH - BOT - 18);
  const mid = wide ? VW - colW / 2 : VW / 2, room_ = wide ? colW - 24 : VW - 24;
  if (d.st === GONE) {
    if (t.ph === PLAY) fitText('popped! back in ' + Math.max(1, Math.ceil(d.rt / HZ)), mid, y + 5, 13, INK.muted, room_);
    return;
  }
  if (d.st === TRAPPED) {
    const b = bubbleOf(t, myId());
    const k = b ? b[8] / ESC_FULL : 0;
    const shake_ = Math.sin(now / 40) * 2;
    fitText('trapped! wriggle ← → to break out', mid + shake_, y - 4, 14, INK.gold, room_);
    const bar = Math.min(160, room_);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(mid - bar / 2, y + 6, bar, 8, 4);
    ctx.fill();
    ctx.fillStyle = SEAT[d.c];
    roundRect(mid - bar / 2, y + 6, Math.max(8, bar * k), 8, 4);
    ctx.fill();
    return;
  }
  const own = t.b.filter((b) => b[5] === myId() && b[6] === 0).length;
  const label = 'bubbles';
  ctx.font = font(12);
  const lw = ctx.measureText(label).width;
  const total = lw + 10 + MAX_OWN * 20;
  let x = mid - total / 2;
  text(label, x, y + 4, 12, INK.dim, 'left');
  x += lw + 18;
  for (let i = 0; i < MAX_OWN; i++) {
    const on = i < MAX_OWN - own;
    disc(x + i * 20, y, 7);
    ctx.fillStyle = on ? alpha(SEAT[d.c], 0.35) : 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = on ? '#ffffff' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (trails(t, myId()) && t.ph === PLAY) fitText('behind: your bubbles fly further, you wriggle faster', mid, y + 24, 11, INK.dim, room_);
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
    const tip = two ? null : 'blow a bubble into the bot, then touch it to pop it before it wriggles free';
    if (wide) practiceNote(now, VW, head, tip, [], VH - 8);
    else practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(18,12,42,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 340), 30);
    fitText('trap rivals in bubbles · whoever pops one scores', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 320));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(18,12,42,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('fizz!', cx, mid + big * 0.5);
    text('fizz!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= 5 * HZ) {
    const n = Math.ceil(t.pt / HZ);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(18,12,42,0.6)';
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
    else head = t.win === me ? 'you popped the most!' : nickOf(t.win) + ' popped the most';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('pops', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('caught', cx + w / 2 - 62, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, rp, pp, cau, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(pp), cx + w / 2 - 110, y, 13, '#eef1ff', 'right');
      text(String(cau), cx + w / 2 - 62, y, 13, '#eef1ff', 'right');
      text(String(rp), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a blob is as drawn: between two steps, and never slid across a jump —
// a blob back in the arena after a pop.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.st !== z.st || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 300) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

// Your own blob is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a hand a step away from where
// the guess had it. So the blob drawn is pulled toward the guess a little
// every frame rather than put on it, and a guess far off — a table taken
// afresh, a blob put back — puts it there at once. Only the drawing is
// smoothed: the arena, and every rule in it, are untouched.
const PULL = 0.5;
let shown = null;        // [x, y] in units: where your blob is drawn

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 240) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  fit();
  drawBack(now);
  const b = agreedAt(now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the fizz…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  drawArena(t, now);
  // Bubbles between their two steps; a new one where it is.
  const before = new Map(b.from.b.map((q) => [q[0], q]));
  for (const q of t.b) {
    const a = before.get(q[0]);
    let x = q[1], y = q[2];
    if (a && a[6] === q[6] && Math.abs(a[1] - q[1]) + Math.abs(a[2] - q[2]) < 200) { x = lerp(a[1], q[1], b.k); y = lerp(a[2], q[2], b.k); }
    if (q[6] === 0) drawBubble(q, x, y, t, now);
  }
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    if (d.st !== ALIVE) continue;
    const p = bodyAt(b, id);
    drawBlob(id, SX(p[0]), SY(p[1]), d, SEAT[d.c], false, t, now, false);
  }
  const m = mineAt(now);
  // Drawn from the guess while the guess has you standing too, and from the
  // agreed table for the moment the two disagree about a bubble.
  if (t.p[me] && t.p[me].st === ALIVE) {
    const own = m && m.to.p[me] && m.to.p[me].st === ALIVE ? m : b;
    const p = bodyAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    drawBlob(me, SX(x), SY(y), p[2], SEAT[p[2].c], true, t, now, false);
  } else {
    shown = null;
  }
  // Full bubbles over everybody, their captives inside them.
  for (const q of t.b) {
    if (q[6] !== 1) continue;
    const a = before.get(q[0]);
    let x = q[1], y = q[2];
    if (a && a[6] === 1) { x = lerp(a[1], q[1], b.k); y = lerp(a[2], q[2], b.k); }
    drawBubble(q, x, y, t, now);
  }
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way run, the buttons held, and how many jumps and
// bubbles so far. A change of way goes out no oftener than STEER_EVERY,
// because a thumb changes it on every move the screen reports and the clock's
// ticks share the same seat's ceiling on messages; a jump or a bubble goes out
// at once.
const STEER_EVERY = 80;
let jumpsAsked = 0, blowsAsked = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const LEFT = ['ArrowLeft', 'KeyA'], RIGHT = ['ArrowRight', 'KeyD'], UP = ['ArrowUp', 'KeyW', 'Space'], DOWN = ['ArrowDown', 'KeyS'];
const BLOW = ['KeyX', 'KeyJ', 'KeyK', 'Enter'];

// A thumb or a mouse: a stick from wherever it lands. Across runs, up past
// JUMP_DRAG jumps and holds the jump, down past it drops through; a tap blows
// a bubble — a drag rather than a press, because iOS keeps a long press
// inside a frame for itself. A second finger down while the first steers
// blows too, and so does a right click.
const DEAD = 14;
const JUMP_DRAG = 30;
let stick = null;        // { id, ox, oy, dx, dy, at, moved, run, up }

function handNow() {
  let mx = 0, hb = 0;
  if (stick) {
    if (stick.dx > DEAD) stick.run = 1;
    else if (stick.dx < -DEAD) stick.run = -1;
    else if (Math.abs(stick.dx) < DEAD / 2) stick.run = 0;
    mx = stick.run;
    if (stick.dy < -JUMP_DRAG) hb |= 1;
    if (stick.dy > JUMP_DRAG) hb |= 2;
  }
  const r = RIGHT.some((c) => keys.has(c)) ? 1 : 0, l = LEFT.some((c) => keys.has(c)) ? 1 : 0;
  if (r || l) mx = r - l;
  if (UP.some((c) => keys.has(c))) hb |= 1;
  if (DOWN.some((c) => keys.has(c))) hb |= 2;
  return [mx, hb];
}

function sayHand(now, force) {
  const [mx, hb] = handNow();
  const h = [mx, hb, jumpsAsked, blowsAsked], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1] && h[2] === s[2] && h[3] === s[3]) return;
  if (!force && s && h[2] === s[2] && h[3] === s[3] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

const standing = () => world && world.p[myId()] && world.p[myId()].st === ALIVE;

function jump() {
  wake();
  if (!world) return;
  jumpsAsked = (jumpsAsked + 1) % 1000;
  sayHand(performance.now(), true);
  if (standing() && world.p[myId()].ct <= COYOTE) sound.jump();
}

// A bubble: heard at once, and blown a trip later on every copy alike, if the
// table says the cooldown is over.
function blowBubble() {
  wake();
  if (!world) return;
  blowsAsked = (blowsAsked + 1) % 1000;
  sayHand(performance.now(), true);
  if (standing() && world.p[myId()].cd === 0) sound.blow();
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (BLOW.includes(e.code)) { e.preventDefault(); if (!e.repeat) blowBubble(); return; }
  if (![...LEFT, ...RIGHT, ...UP, ...DOWN].includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  const fresh = !keys.has(e.code);
  keys.add(e.code);
  if (UP.includes(e.code) && fresh && !e.repeat) jump();
  else sayHand(performance.now(), true);
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
  if (e.button === 2) { blowBubble(); return; }
  if (stick) { blowBubble(); return; }
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0, at: performance.now(), moved: false, run: 0, up: false };
  paintStick();
});
cv.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.id) return;
  stick.dx = e.clientX - stick.ox;
  stick.dy = e.clientY - stick.oy;
  if (Math.hypot(stick.dx, stick.dy) >= DEAD) stick.moved = true;
  const up = stick.dy < -JUMP_DRAG;
  paintStick();
  if (up && !stick.up) { stick.up = true; jump(); } else {
    if (!up && stick.dy > -JUMP_DRAG / 2) stick.up = false;
    sayHand(performance.now(), false);
  }
});
function liftPointer(e) {
  if (!stick || e.pointerId !== stick.id) return;
  const tap = !stick.moved && performance.now() - stick.at < 260;
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
  if (tap) blowBubble();
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', liftPointer);
addEventListener('pointerup', liftPointer);
addEventListener('pointercancel', liftPointer);

const REACH = 46;
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
// a player arrives in the arena.
function start() {
  setHand([0, 0, jumpsAsked, blowsAsked]);
  lastSaid = [0, 0, jumpsAsked, blowsAsked];
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
