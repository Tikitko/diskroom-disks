/**
 * @disk     volley
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Beach volleyball for blobs, in teams. Your whole body is the bat: where the ball meets your dome decides where it flies. Three touches a side, a long rally heats the ball up and makes it worth two, and the net slides toward whoever trails.
 * @tags     game, party, realtime, sports, team, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/volley.png
 */
// volley.js — a beach court where the room's order is the referee.
//
// Every copy holds every blob, the ball, the net and the score, and changes
// them only on what comes back round the room, so every copy applies the same
// hands in the same order and holds the same court. Nobody sends where the
// ball went, who touched it or who scored: a hand is which way a player leans,
// whether the jump is held and a counter that moves on by one for every dash,
// and everything else is the same arithmetic on the same whole numbers on
// every machine. A page with a console open can move its own blob however it
// likes, at that blob's own speed, jump only from the sand and dash no oftener
// than the cooldown allows.
//
// While a player is alone, a bot plays across the net from them. It is part of
// the table like any player, and its moves are a function of the table alone,
// so it plays the same on every copy and says nothing over the wire. When a
// second player arrives, practice runs on for three seconds under a note that
// says so, and the bot leaves before the set is laid out: it never takes part
// in one.
//
// Your own blob does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — the court is 64000 units across, a
// speed is units a substep — and use nothing but `+ - * /`, comparisons,
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
const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the court a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own blob a trip ahead, with your hand in it

// The court, side on: x across, y down, the sand at GY. The ball and the blobs
// move in SUB substeps a step, so the fastest ball moves less than its own
// size between two looks and never slips through a blob or the net.
const FW = 64000, GY = 36000;
const SUB = 4;
const SAND = 4200;             // sand drawn under the court, where nothing plays
const NET_H = 7600, NET_TOP = GY - NET_H, NW = 300;
const R0 = 3800;               // a blob's radius
const R_UP = 700;              // more radius for every player a side is short
const BR = 1100;               // the ball's radius
const SG = 6;                  // what gravity adds to a blob's fall, a substep
const BG = 3;                  // and to the ball's
const JUMP_V = 330;
const SPD = 180;               // a blob's top speed on the sand
const DASH_V = 430;            // a dash's speed, held for DASH_HOLD steps
const DASH_HOLD = 6;
const DASH_CD = 40;            // steps between two dashes
const VMAX0 = 380;             // the fastest the ball flies early in a rally
const VSTEP = 24;              // and what every crossing of the net adds to that
const POP_MIN = 150;           // the least a touch sends the ball away at
const TOUCHES = 3;             // touches a side may take before it must be over
const TOUCH_GAP = 3;           // steps one blob's touch lasts, however it rolls
const HOT_AT = 6;              // crossings in a rally that make the ball hot
const SHIFT = 1200;            // how far the net slides for every point of the gap
const SHIFT_MAX = 6000;
const NET_STEP = 160;          // how fast it slides, a step, between points
const SERVE_Y = GY - 16000;
const SERVE_HOLD = 30;         // steps the ball hangs before a serve drops
const PAUSE = 45;              // steps from a point to the next serve
const SET_TO = 7, SET_CAP = 11;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;
const VLIM = 2000;             // no speed in the table is ever beyond this

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const END_STEPS = 6 * HZ;

const HOLD = 0, LIVE = 1, DOWN = 2;   // the ball: hanging for a serve, in play, dead

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   sc: the two sides' points; sv: the side that serves next; sr: whose turn to
//   serve on each side; nx: where the net stands; bx, by, bvx, bvy: the ball;
//   bf: hanging, in play or dead; bh: steps a serve still hangs; bs: the side
//   the ball is over; tn, ts: touches taken and the side that took them; rx:
//   crossings in this rally; lt: who touched it last; pz: steps of the pause
//   after a point; res: the last set's [id, side, kills, sets won] rows; win:
//   the side that took it
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, sc: [0, 0], sv: 0, sr: [0, 0], nx: FW / 2,
    bx: FW / 4, by: SERVE_Y, bvx: 0, bvy: 0, bf: HOLD, bh: SERVE_HOLD, bs: 0, tn: 0, ts: -1, rx: 0, lt: -1, pz: 0,
    p: {}, res: null, win: -1,
  };
  return w;
}

const FIELDS = ['c', 's', 'sd', 'x', 'y', 'vx', 'vy', 'mx', 'j', 'jc', 'fc', 'q', 'hq', 'dc', 'dh', 'tc',
  'k', 'kt', 'wn', 'be', 'bt', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; sd: the side of the net, 0 left or 1 right; x, y:
//   where, y the sand under the blob; vx, vy: how fast, a substep; mx: the way
//   the hand leans, a thousand at full; j: the jump held; jc: a jump already
//   cut short; fc: the way last leaned; q: the dash counter as last heard; hq:
//   a dash to take this step; dc: steps until the next dash; dh: steps of a
//   dash still flying; tc: steps of a touch still going on; k, kt: points
//   finished this set and in all; wn: sets won; be, bt, bw: the bot's aim
//   off, what it was aimed for and its pause; hs, hc: hands this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);
const sideOf = (w, s) => bySeat(w).filter((id) => w.p[id].sd === s);

// A side a player short plays bigger blobs, so two against one is a match.
function radOf(w, d) {
  let mine = 0, theirs = 0;
  for (const id of playersIn(w)) if (w.p[id].sd === d.sd) mine += 1; else theirs += 1;
  return R0 + R_UP * clamp(theirs - mine, 0, 2);
}

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

function smallerSide(w) {
  const n = [0, 0];
  for (const id of playersIn(w)) n[w.p[id].sd] += 1;
  return n[1] < n[0] ? 1 : 0;
}

function newPlayer(w, q) {
  const sd = smallerSide(w);
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), sd, x: sd ? w.nx + NW + R0 * 2 : w.nx - NW - R0 * 2, y: GY, vx: 0, vy: 0,
    mx: 0, j: 0, jc: 0, fc: sd ? -1 : 1, q, hq: 0, dc: 0, dh: 0, tc: 0, k: 0, kt: 0, wn: 0, be: 0, bt: -1, bw: 0,
    hs: w.n, hc: 0,
  });
}

// The ends of the sand a side's blob may stand on.
const loOf = (w, d, r) => (d.sd ? w.nx + NW + r : r);
const hiOf = (w, d, r) => (d.sd ? FW - r : w.nx - NW - r);

// Every side's players spread out over their half, still, on the sand.
function placeAll(w) {
  for (const s of [0, 1]) {
    const ids = sideOf(w, s), n = ids.length;
    ids.forEach((id, k) => {
      const d = w.p[id];
      const a = s ? w.nx + NW : 0, b = s ? FW : w.nx - NW;
      d.x = a + Math.trunc(((b - a) * (k + 1)) / (n + 1));
      d.y = GY;
      d.vx = d.vy = d.dh = d.hq = d.tc = 0;
      d.fc = s ? -1 : 1;
      const r = radOf(w, d);
      d.x = clamp(d.x, loOf(w, d, r), hiOf(w, d, r));
    });
  }
}

// Sides never differ by more than one: whoever arrived last on the bigger side
// crosses over, between rallies only.
function balance(w) {
  for (let guard = 0; guard < MAX_P; guard++) {
    const l = sideOf(w, 0), r = sideOf(w, 1);
    if (Math.abs(l.length - r.length) <= 1) return;
    const from = l.length > r.length ? l : r;
    const d = w.p[from[from.length - 1]];
    d.sd = 1 - d.sd;
    d.fc = d.sd ? -1 : 1;
    d.x = d.sd ? FW - R0 * 2 : R0 * 2;
    d.vx = d.vy = d.dh = 0;
    d.y = GY;
  }
}

// A hand, at its place in the room's order: [the way leaned, the jump held,
// the dash counter]. A dash is asked for once, when the counter changes; the
// same hand said again to keep a player at the table dashes nobody. Being
// heard is how a player arrives: on the smaller side, at once.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[2]);
    d.mx = input[0];
    d.j = input[1];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.mx = input[0];
  d.j = input[1];
  if (input[2] !== d.q) { d.q = input[2]; d.hq = 1; }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
// How fast a blob goes is the table's business: a lean names a share of the
// top speed, and nothing a hand says makes it more than all of it.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [m, j, q] = raw;
  if (!Number.isInteger(m) || !Number.isInteger(j) || !Number.isInteger(q)) return null;
  if (m < -1000 || m > 1000 || j < 0 || j > 1 || q < 0 || q > 999) return null;
  return [m, j, q];
}

function leave(w, id) {
  delete w.p[id];
  if (w.lt === id) w.lt = -1;
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.05;         // how often it stands a moment rather than decide
const BOT_JUMP = 0.55;         // how often it jumps when a jump would reach
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a set, and goes the moment a set is
// laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Where the ball comes down to the height of a blob's dome, as gravity and the
// walls would take it: the net is left out, the way a player reads a ball.
function landing(w, top) {
  let x = w.bx, y = w.by, vx = w.bf === HOLD ? 0 : w.bvx, vy = w.bf === HOLD ? 0 : w.bvy;
  for (let i = 0; i < 900; i++) {
    vy += BG;
    x += vx;
    y += vy;
    if (x < BR) { x = BR; vx = -vx; }
    if (x > FW - BR) { x = FW - BR; vx = -vx; }
    if (y < BR) { y = BR; vy = -vy; }
    if (vy > 0 && y >= top) return x;
  }
  return x;
}

function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.bw > 0) { d.bw -= 1; d.mx = 0; d.j = 0; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 3 + Math.floor(draw01(w) * 6); d.mx = 0; d.j = 0; return; }
  const r = radOf(w, d);
  const away = d.sd ? 1 : -1;
  const home = d.sd ? w.nx + Math.trunc((FW - w.nx) * 11 / 20) : Math.trunc((w.nx * 9) / 20);
  let target = home, jump = 0;
  if (w.bf !== DOWN) {
    const px = landing(w, GY - r - Math.trunc(BR / 2));
    const mine = (px < w.nx) === (d.sd === 0);
    if (mine) {
      // A fresh aim, a little off, every time the rally turns a page.
      const key = w.rx * 8 + w.tn;
      if (key !== d.bt) { d.bt = key; d.be = Math.trunc((draw01(w) - 0.5) * r * 0.8); }
      // Stand on the far side of where it falls, so the dome sends it at the
      // net; further still on the last touch, so it goes over.
      const off = Math.trunc((r * (w.ts === d.sd && w.tn >= TOUCHES - 1 ? 70 : 42)) / 100);
      target = px + away * off + d.be;
      const ex = w.bx - d.x, above = GY - r - w.by;
      if (w.bf === LIVE && Math.abs(ex) < Math.trunc((r * 13) / 10) && above > 1500 && above < 11000 && w.bvy > -60 && d.y >= GY) {
        if (draw01(w) < BOT_JUMP) jump = 1;
      }
    }
  }
  const lo = loOf(w, d, r), hi = hiOf(w, d, r);
  target = clamp(target, lo, hi);
  const gap = target - d.x;
  d.mx = Math.abs(gap) < 120 ? 0 : clamp(Math.trunc((gap * 1000) / Math.max(1, Math.trunc((r * 7) / 10))), -1000, 1000);
  // A jump once begun is held to its top: the bot never cuts one short.
  d.j = jump || (d.j && d.y < GY && d.vy < 0) ? 1 : 0;
  if (Math.abs(gap) > r * 3 && d.dc === 0 && w.bf === LIVE && draw01(w) < 0.25) d.hq = 1;
}

// ── a step ─────────────────────────────────────────────────────────────────
// A serve: the sides evened out, and the ball hung high over whoever's turn it
// is on the serving side, clear of the net.
function serve(w) {
  balance(w);
  let side = w.sv;
  let ids = sideOf(w, side);
  if (!ids.length) { side = 1 - side; ids = sideOf(w, side); }
  w.bvx = w.bvy = 0;
  w.by = SERVE_Y;
  w.bf = HOLD;
  w.bh = SERVE_HOLD;
  w.tn = w.rx = 0;
  w.ts = w.lt = -1;
  if (!ids.length) { w.bx = w.nx; w.bs = 0; return; }
  const id = ids[w.sr[side] % ids.length];
  w.sr[side] = (w.sr[side] + 1) % 64;
  const d = w.p[id], r = radOf(w, d);
  w.bx = side ? clamp(d.x, w.nx + NW + r * 2, FW - r) : clamp(d.x, r, w.nx - NW - r * 2);
  w.bs = side;
  fx(w, 'serve', w.bx, w.by, 0, id);
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  w.sc = [0, 0];
  w.nx = FW / 2;
  const ids = humans(w).sort((a, b) => w.p[a].s - w.p[b].s);
  ids.forEach((id, i) => { w.p[id].sd = i % 2; });
  if (w.p[BOT_ID]) w.p[BOT_ID].sd = ids.length % 2;
  placeAll(w);
  serve(w);
}

// A set: the seats closed up in order and shuffled into two sides, the net in
// the middle, the score at nothing and a serve hanging for a side drawn.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  for (let i = ids.length - 1; i > 0; i--) {
    const k = Math.floor(draw01(w) * (i + 1));
    const t = ids[i]; ids[i] = ids[k]; ids[k] = t;
  }
  ids.forEach((id, i) => { const d = w.p[id]; d.sd = i % 2; d.k = 0; });
  w.sc = [0, 0];
  w.nx = FW / 2;
  w.sv = Math.floor(draw01(w) * 2);
  w.sr = [0, 0];
  placeAll(w);
  serve(w);
  fx(w, 'round', 0, 0, 0);
}

const setOver = (w) => {
  const hi = Math.max(w.sc[0], w.sc[1]), lo = Math.min(w.sc[0], w.sc[1]);
  return (hi >= SET_TO && hi - lo >= 2) || hi >= SET_CAP;
};
// A point away from taking the set, as the score stands: -1 when neither is.
function setPointFor(w) {
  for (const s of [0, 1]) {
    const a = w.sc[s] + 1, b = w.sc[1 - s];
    if ((a >= SET_TO && a - b >= 2) || a >= SET_CAP) return s;
  }
  return -1;
}

// The whistle: the side that took the set, and a set won for everybody on it.
function finish(w) {
  const win = w.sc[0] > w.sc[1] ? 0 : 1;
  const ids = bySeat(w);
  for (const id of ids) if (w.p[id].sd === win) w.p[id].wn += 1;
  const res = ids.map((id) => [id, w.p[id].sd, w.p[id].k, w.p[id].wn]);
  res.sort((a, b) => (a[1] === win ? 0 : 1) - (b[1] === win ? 0 : 1) || b[2] - a[2] || b[3] - a[3] || a[0] - b[0]);
  w.res = res;
  w.win = win;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, 0, win);
}

function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting table otherwise leaves at zero. The bot goes first, so
    // the set's seats close up without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else if (w.ph === COUNT) {
    w.pt -= 1;
    if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, 0, w.pt / HZ);
    if (w.pt <= 0) { w.ph = PLAY; w.pt = 0; w.bh = SERVE_HOLD; fx(w, 'go', 0, 0, 0); }
  } else if (w.ph === END) {
    if (--w.pt <= 0) begin(w);
  }
  // Nobody moves while the result of a set is up.
  if (w.ph === END) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      d.hq = d.vx = d.dh = 0;
      if (d.y < GY) { d.vy += SG * SUB; d.y = Math.min(GY, d.y + d.vy * SUB); } else d.vy = 0;
    }
    return;
  }
  rally(w);
}

function rally(w) {
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.dc > 0) d.dc -= 1;
    if (d.dh > 0) d.dh -= 1;
    if (d.tc > 0) d.tc -= 1;
    if (d.mx > 200) d.fc = 1; else if (d.mx < -200) d.fc = -1;
    if (d.hq) {
      d.hq = 0;
      if (d.dc === 0) {
        const dir = d.mx > 200 ? 1 : d.mx < -200 ? -1 : d.fc;
        d.vx = dir * DASH_V;
        d.dh = DASH_HOLD;
        d.dc = DASH_CD;
        fx(w, 'dash', d.x, d.y, dir, id);
      }
    }
  }
  if (w.bf === HOLD && w.ph !== COUNT && --w.bh <= 0) { w.bf = LIVE; w.bh = 0; }
  if (w.bf !== LIVE) slideNet(w);
  if (w.bf === DOWN && --w.pz <= 0) {
    w.pz = 0;
    if (setOver(w)) {
      if (w.ph === PLAY) { finish(w); return; }
      fx(w, 'pset', 0, 0, 0, w.sc[0] > w.sc[1] ? 0 : 1);
      w.sc = [0, 0];
    }
    serve(w);
  }
  const radii = {};
  for (const id of ids) radii[id] = radOf(w, w.p[id]);
  for (let s = 0; s < SUB; s++) {
    for (const id of ids) move(w, w.p[id], radii[id], id);
    crowd(w, ids, radii);
    ball(w, ids, radii);
    if (w.ph === END) return;
  }
}

// Between points the net slides to where the score puts it: toward whoever
// trails, so the leader has more sand to cover and the trailer more to aim at.
function slideNet(w) {
  const want = FW / 2 + clamp((w.sc[0] - w.sc[1]) * SHIFT, -SHIFT_MAX, SHIFT_MAX);
  if (w.nx < want) w.nx = Math.min(want, w.nx + NET_STEP);
  else if (w.nx > want) w.nx = Math.max(want, w.nx - NET_STEP);
}

// A blob leans toward the speed its hand asks for, jumps off the sand while
// the jump is held, and falls short when it is let go on the way up. A dash
// holds its speed for a moment whatever the hand says.
function move(w, d, r, id) {
  if (d.dh <= 0) {
    const tv = Math.trunc((d.mx * SPD) / 1000);
    d.vx += Math.trunc((tv - d.vx) / 3);
    if (Math.abs(tv - d.vx) <= 3) d.vx = tv;
  }
  if (d.y >= GY && d.vy >= 0 && d.j) {
    d.vy = -JUMP_V;
    d.jc = 0;
    fx(w, 'jump', d.x, d.y, 0, id);
  }
  if (d.y < GY || d.vy < 0) {
    if (!d.j && d.vy < 0 && !d.jc) { d.vy = Math.trunc(d.vy / 2); d.jc = 1; }
    d.vy += SG;
    d.y += d.vy;
    if (d.y >= GY) {
      if (d.vy > 200) fx(w, 'land', d.x, GY, d.vy, id);
      d.y = GY;
      d.vy = 0;
    }
  }
  d.x += d.vx;
  const lo = loOf(w, d, r), hi = hiOf(w, d, r);
  if (d.x < lo) { d.x = lo; if (d.vx < 0) d.vx = 0; }
  if (d.x > hi) { d.x = hi; if (d.vx > 0) d.vx = 0; }
}

// Two blobs of one side never stand in each other: they are eased apart along
// the sand, half each.
function crowd(w, ids, radii) {
  for (let a = 0; a < ids.length; a++) {
    const p = w.p[ids[a]];
    for (let b = a + 1; b < ids.length; b++) {
      const o = w.p[ids[b]];
      if (o.sd !== p.sd) continue;
      const ra = radii[ids[a]], rb = radii[ids[b]], reach = ra + rb;
      const dx = o.x - p.x, dy = o.y - p.y;
      if (dx * dx + dy * dy >= reach * reach) continue;
      const far = isqrt(dx * dx + dy * dy);
      const s = dx === 0 ? (ids[a] < ids[b] ? 1 : -1) : sign(dx);
      const push = Math.trunc((reach - far) / 2) + 1;
      p.x = clamp(p.x - s * push, loOf(w, p, ra), hiOf(w, p, ra));
      o.x = clamp(o.x + s * push, loOf(w, o, rb), hiOf(w, o, rb));
    }
  }
}

const vmaxOf = (w) => VMAX0 + VSTEP * Math.min(w.rx, 12);

function capBall(w) {
  const sp = isqrt(w.bvx * w.bvx + w.bvy * w.bvy), most = vmaxOf(w);
  if (sp > most) {
    w.bvx = Math.trunc((w.bvx * most) / sp);
    w.bvy = Math.trunc((w.bvy * most) / sp);
  }
}

// One substep of the ball: gravity, the walls and the sky, the net, every
// blob it meets, the side it is over and the sand.
function ball(w, ids, radii) {
  if (w.bf === HOLD) return;
  w.bvy += BG;
  w.bx += w.bvx;
  w.by += w.bvy;
  if (w.bx < BR) { w.bx = BR; w.bvx = Math.abs(w.bvx); fx(w, 'wall', 0, w.by, w.bvx); }
  if (w.bx > FW - BR) { w.bx = FW - BR; w.bvx = -Math.abs(w.bvx); fx(w, 'wall', FW, w.by, -w.bvx); }
  if (w.by < BR) { w.by = BR; w.bvy = Math.abs(w.bvy); }
  net(w);
  if (w.bf === LIVE) for (const id of ids) blob(w, id, w.p[id], radii[id]);
  const s = w.bx < w.nx ? 0 : 1;
  if (s !== w.bs) {
    w.bs = s;
    if (w.bf === LIVE) {
      w.rx += 1;
      w.tn = 0;
      w.ts = -1;
      if (w.rx === HOT_AT) fx(w, 'hot', w.bx, w.by, 0);
    }
  }
  if (w.by >= GY - BR) {
    w.by = GY - BR;
    if (w.bf === LIVE) { land(w); return; }
    w.bvy = -Math.trunc((w.bvy * 2) / 5);
    w.bvx = Math.trunc((w.bvx * 3) / 4);
    if (Math.abs(w.bvy) < 24) w.bvy = 0;
  }
}

// The net is a post with a round top. The ball bounces off its top whichever
// way it rolls, and off its side back to the side it came from.
function net(w) {
  if (w.by < NET_TOP) {
    let dx = w.bx - w.nx, dy = w.by - NET_TOP;
    const reach = BR + NW;
    if (dx * dx + dy * dy >= reach * reach) return;
    let far = isqrt(dx * dx + dy * dy);
    if (far === 0) { dx = 0; dy = -1; far = 1; }
    w.bx = w.nx + Math.trunc((dx * reach) / far);
    w.by = NET_TOP + Math.trunc((dy * reach) / far);
    const vn = Math.trunc((w.bvx * dx + w.bvy * dy) / far);
    if (vn < 0) {
      w.bvx -= Math.trunc((vn * dx * 18) / (far * 10));
      w.bvy -= Math.trunc((vn * dy * 18) / (far * 10));
      fx(w, 'net', w.nx, NET_TOP, -vn);
    }
    return;
  }
  if (Math.abs(w.bx - w.nx) >= NW + BR) return;
  const hit = Math.abs(w.bvx);
  if (w.bs === 0) { w.bx = w.nx - NW - BR; w.bvx = -Math.trunc((hit * 6) / 10); }
  else { w.bx = w.nx + NW + BR; w.bvx = Math.trunc((hit * 6) / 10); }
  if (hit > 30) fx(w, 'net', w.nx, w.by, hit);
}

// The ball meets a blob's dome: it bounces off the dome as off a wall moving
// at the blob's speed, so where on the dome it lands decides where it flies,
// and a blob jumping into it sends it hard. Under a blob in the air it is
// pressed down. Every meeting is a touch for that blob's side.
function blob(w, id, d, r) {
  if (w.bf !== LIVE) return;
  const reach = r + BR;
  let dx = w.bx - d.x, dy = w.by - d.y;
  if (dx * dx + dy * dy >= reach * reach) return;
  if (dy > 0) {
    w.by = d.y + BR;
    if (w.bvy < d.vy + 40) w.bvy = d.vy + 40;
  } else {
    let far = isqrt(dx * dx + dy * dy);
    if (far === 0) { dx = 0; dy = -1; far = 1; }
    w.bx = d.x + Math.trunc((dx * reach) / far);
    w.by = d.y + Math.trunc((dy * reach) / far);
    let rvx = w.bvx - d.vx, rvy = w.bvy - d.vy;
    const vn = Math.trunc((rvx * dx + rvy * dy) / far);
    if (vn < 0) {
      rvx -= Math.trunc((2 * vn * dx) / far);
      rvy -= Math.trunc((2 * vn * dy) / far);
    }
    w.bvx = rvx + d.vx;
    w.bvy = rvy + d.vy;
    const out = Math.trunc(((w.bvx - d.vx) * dx + (w.bvy - d.vy) * dy) / far);
    if (out < POP_MIN) {
      w.bvx += Math.trunc(((POP_MIN - out) * dx) / far);
      w.bvy += Math.trunc(((POP_MIN - out) * dy) / far);
    }
  }
  capBall(w);
  if (w.bx < BR) w.bx = BR;
  if (w.bx > FW - BR) w.bx = FW - BR;
  if (d.tc > 0) { d.tc = TOUCH_GAP; return; }
  d.tc = TOUCH_GAP;
  if (w.ts !== d.sd) { w.ts = d.sd; w.tn = 0; }
  w.tn += 1;
  w.lt = id;
  fx(w, 'hit', w.bx, w.by, isqrt(w.bvx * w.bvx + w.bvy * w.bvy), id, w.tn);
  if (w.tn > TOUCHES) fault(w, d.sd);
}

// A point: the ball on the sand is the other side's, a fourth touch is the
// other side's, and a hot ball counts two. The side that lost it serves.
function point(w, to, why) {
  const v = w.rx >= HOT_AT ? 2 : 1;
  w.sc[to] += v;
  const lt = w.p[w.lt];
  if (lt && lt.sd === to && why === 0) { lt.k += 1; lt.kt += 1; }
  w.sv = 1 - to;
  w.bf = DOWN;
  w.pz = PAUSE;
  fx(w, 'point', w.bx, w.by, v, to, why);
}

function land(w) {
  fx(w, 'land_ball', w.bx, GY, w.bvy);
  const to = w.bx < w.nx ? 1 : 0;
  w.bvy = -Math.trunc((w.bvy * 2) / 5);
  w.bvx = Math.trunc((w.bvx * 3) / 4);
  point(w, to, 0);
}

function fault(w, side) {
  point(w, 1 - side, 1);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const pair = (a, lo, hi) => Array.isArray(a) && a.length === 2 && int(a[0], lo, hi) && int(a[1], lo, hi);

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, END_STEPS + COUNT_STEPS)) return null;
  if (!pair(raw.sc, 0, SET_CAP + 2) || !int(raw.sv, 0, 1) || !pair(raw.sr, 0, 63)) return null;
  if (!int(raw.nx, FW / 2 - SHIFT_MAX, FW / 2 + SHIFT_MAX)) return null;
  if (!int(raw.bx, 0, FW) || !int(raw.by, -VLIM, GY) || !int(raw.bvx, -VLIM, VLIM) || !int(raw.bvy, -VLIM, VLIM)) return null;
  if (!int(raw.bf, HOLD, DOWN) || !int(raw.bh, 0, SERVE_HOLD) || !int(raw.bs, 0, 1)) return null;
  if (!int(raw.tn, 0, TOUCHES + 1) || !int(raw.ts, -1, 1) || !int(raw.rx, 0, BIG) || !int(raw.pz, 0, PAUSE)) return null;
  if (!Number.isInteger(raw.lt) || !(raw.lt === -1 || isId(String(raw.lt)))) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.sd, 0, 1) || !int(d.x, 0, FW) || !int(d.y, 0, GY)) return null;
    if (!int(d.vx, -VLIM, VLIM) || !int(d.vy, -VLIM, VLIM) || inputOf([d.mx, d.j, d.q]) === null) return null;
    if (!int(d.jc, 0, 1) || !int(d.fc, -1, 1) || !int(d.hq, 0, 1)) return null;
    if (!int(d.dc, 0, DASH_CD) || !int(d.dh, 0, DASH_HOLD) || !int(d.tc, 0, TOUCH_GAP)) return null;
    if (!int(d.k, 0, 99999) || !int(d.kt, 0, 999999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.be, -R0 * 2, R0 * 2) || !int(d.bt, -1, BIG) || !int(d.bw, 0, 99)) return null;
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
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -1, 1)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, sc: raw.sc.slice(), sv: raw.sv, sr: raw.sr.slice(), nx: raw.nx,
    bx: raw.bx, by: raw.by, bvx: raw.bvx, bvy: raw.bvy, bf: raw.bf, bh: raw.bh, bs: raw.bs, tn: raw.tn, ts: raw.ts,
    rx: raw.rx, lt: raw.lt, pz: raw.pz, p, res, win: raw.win,
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
// One palette: a beach at sunset. A violet sky going gold at the horizon, the
// sea under it, warm sand, a dark wooden net post, and every blob a bright
// colour of its own; the two sides are coral and lagoon.
const INK = {
  page: '#1c1538', skyTop: '#33266e', skyMid: '#7a3f86', skyLow: '#ff9566', sun: '#ffd27a', sea: '#2d5f93',
  seaDark: '#22487a', sand: '#f0c486', sandLit: '#f7d7a3', sandDark: '#d7a364', wood: '#5a3a2a', woodLit: '#7b5038',
  text: '#ffffff', muted: '#efe4ff', dim: '#b3a5d6', gold: '#ffd166', danger: '#ff5a6e',
  panel: 'rgba(28,20,58,0.93)', outline: '#1d1438',
};
const TEAM = ['#ff7a59', '#2ed3c6'];
const TEAMN = ['coral', 'lagoon'];
const SEAT = ['#ff4f7b', '#3fa9ff', '#ffb020', '#9cff3a', '#e25cff', '#20e3ff', '#ff7a2e', '#7d6bff'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #5a4a8f;' +
  `background:#2c2258;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, sc = 0.01, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340, groundY = 300;
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

// The whole court is always on screen, as large as it fits, with the sand
// under it: nothing plays below the line the blobs stand on, so the practice
// note may sit on that sand when it fits there.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 26);
  sc = Math.max(0.002, Math.min((VW - 16) / FW, ah / (GY + SAND)));
  ox = (VW - FW * sc) / 2;
  oy = TOP + (ah - (GY + SAND) * sc) / 2;
  fieldTop = oy;
  fieldBot = oy + (GY + SAND) * sc;
  groundY = oy + GY * sc;
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
function outlined(s, x, y, px, colour, width) {
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = width || 4;
  ctx.strokeStyle = 'rgba(29,20,56,0.75)';
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
function lighter(hex, k) {
  const c = rgb(hex).map((v) => Math.round(v + (255 - v) * k));
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
  hit(k, mine) {
    if (!ready('hit', 45)) return;
    tone(mine ? 330 + 260 * k : 280 + 200 * k, 0.12, 'sine', 0.1 + 0.06 * k, 0.55);
    puff(0.07, 0.04 + 0.05 * k, 1400, 0, 1.4);
  },
  touch(n) { if (ready('touch', 60)) tone([0, 660, 784, 988, 440][Math.min(4, n)], 0.07, 'triangle', 0.05, 1, 0.03); },
  net(k) { if (ready('net', 80)) { tone(120, 0.14, 'square', 0.04 + 0.04 * k, 0.6); puff(0.12, 0.05, 600, 0, 0.8); } },
  wall() { if (ready('wall', 90)) tone(220, 0.06, 'sine', 0.05, 0.8); },
  thud(k) { if (ready('thud', 120)) { puff(0.3, 0.08 + 0.08 * k, 300, 0, 0.6); tone(80, 0.25, 'sine', 0.1, 0.6); } },
  jump() { if (ready('jump', 90)) tone(240, 0.16, 'sine', 0.06, 2.2); },
  land() { if (ready('land', 120)) puff(0.1, 0.03, 900, 0, 1.0); },
  dash() { if (ready('dash', 120)) { puff(0.2, 0.07, 2200, 0, 0.8); tone(380, 0.14, 'triangle', 0.04, 1.6); } },
  whistle() { if (ready('whistle', 300)) { tone(2100, 0.09, 'square', 0.03); tone(2300, 0.22, 'square', 0.03, 1, 0.1); } },
  won() { if (ready('won', 300)) [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, 0.12 + i * 0.06)); },
  lost() { if (ready('lost', 300)) [392, 311].forEach((f, i) => tone(f, 0.16, 'triangle', 0.06, 0, 0.12 + i * 0.1)); },
  fault() { if (ready('fault', 300)) tone(140, 0.4, 'sawtooth', 0.05, 0.8, 0.05); },
  hot() { if (ready('hot', 400)) { puff(0.6, 0.08, 500, 0, 0.5); [440, 554, 659, 880].forEach((f, i) => tone(f, 0.1, 'sawtooth', 0.03, 1, i * 0.05)); } },
  serve() { if (ready('serve', 200)) tone(880, 0.08, 'sine', 0.05, 1.2); },
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
// fast screen and a slow one see the same spray. Positions are court units.
const bits = [];      // { x, y, vx, vy, g, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, up, g) {
  for (let i = 0; i < count; i++) {
    const a = Math.PI + Math.random() * Math.PI * (up ? 1 : 2), v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: g === undefined ? 30000 : g, life: 0, max: 20 + Math.random() * 24, size, colour });
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
      b.vx *= 0.96; b.vy = b.vy * 0.96 + b.g / BIT_HZ;
      if (b.y > GY + 300 && b.g > 0) { b.y = GY + 300; b.vy = -b.vy * 0.2; b.vx *= 0.6; }
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
const looks = new Map();      // id -> { x, y, sq, seen }
let drawFailed = false;
let spin = 0, ballLast = null, hotSince = -1;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const sideName = (s) => TEAMN[s];

function squash(id, k) {
  const look = looks.get(id);
  if (look) look.sq = Math.max(look.sq, k);
}

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const mySide = md ? md.sd : -1;
  if (e.kind === 'hit') {
    const k = Math.min(1, e.z / 500);
    spray(e.x, e.y, 6 + Math.round(8 * k), '#ffffff', 3000 + 5000 * k, 220, false, 8000);
    squash(e.a, 0.5 + 0.5 * k);
    if (e.a === me) shake = Math.max(shake, 2 + 4 * k);
    sound.hit(k, e.a === me);
    const d = t.p[e.a];
    if (d && e.b >= 1) {
      pop(e.x, e.y - BR * 1.6, e.b > TOUCHES ? 'four!' : String(e.b), e.b > TOUCHES ? INK.danger : e.b === TOUCHES ? INK.gold : TEAM[d.sd], e.b > TOUCHES ? 18 : 13);
      sound.touch(e.b);
    }
  } else if (e.kind === 'net') {
    spray(e.x, e.y, 6, '#ffffff', 2500, 160, false, 8000);
    sound.net(Math.min(1, e.z / 300));
  } else if (e.kind === 'wall') {
    sound.wall();
  } else if (e.kind === 'land_ball') {
    spray(e.x, GY, 22, INK.sandLit, 6000, 260, true);
    spray(e.x, GY, 10, INK.sandDark, 4000, 200, true);
    ring(e.x, GY, '#ffffff', 5000);
    shake = Math.max(shake, 7);
    sound.thud(Math.min(1, e.z / 400));
  } else if (e.kind === 'point') {
    const colour = TEAM[e.a];
    const v = e.z === 2 ? '+2' : '+1';
    const cx = e.a ? (t.nx + FW) / 2 : t.nx / 2;
    pop(cx, 6500, v, colour, 26);
    if (e.b === 1) { pop(e.x, e.y - BR * 2.5, 'four touches!', INK.danger, 16); sound.fault(); }
    for (let i = 0; i < 18; i++) spray(cx, 5500, 1, [colour, '#ffffff', INK.gold][i % 3], 9000, 180, true, 20000);
    sound.whistle();
    if (mySide === e.a) sound.won(); else if (mySide !== -1) sound.lost();
  } else if (e.kind === 'serve') {
    ring(e.x, e.y, '#ffffff', 3000);
    sound.serve();
  } else if (e.kind === 'hot') {
    pop(e.x, e.y - BR * 2, 'hot ball! worth two', INK.gold, 18);
    shake = Math.max(shake, 4);
    sound.hot();
  } else if (e.kind === 'jump') {
    squash(e.a, 0.6);
    spray(e.x, GY, 6, INK.sandLit, 3000, 160, true);
    if (e.a === me) sound.jump();
  } else if (e.kind === 'land') {
    squash(e.a, Math.min(1, e.z / 400));
    spray(e.x, GY, 5, INK.sandLit, 2500, 140, true);
    if (e.a === me) sound.land();
  } else if (e.kind === 'dash') {
    spray(e.x, GY - 600, 10, INK.sandLit, 4000, 180, true);
    if (e.a === me) sound.dash();
  } else if (e.kind === 'pset') {
    pop(FW / 2, 12000, sideName(e.a) + ' takes the practice set', TEAM[e.a], 18);
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === mySide);
  }
}

// The sky over the court, the sun on the sea, the sand. The court's own air is
// framed, so the walls the ball bounces off are where the frame is.
function drawCourt(t, now) {
  flat();
  const g0 = ctx.createLinearGradient(0, 0, 0, VH);
  g0.addColorStop(0, '#171230');
  g0.addColorStop(1, INK.page);
  ctx.fillStyle = g0;
  ctx.fillRect(0, 0, VW, VH);
  const x0 = SX(0), y0 = SY(0), w = FW * sc, h = (GY + SAND) * sc, gy = SY(GY);
  ctx.fillStyle = 'rgba(5,3,15,0.45)';
  roundRect(x0 - 3, y0 + 4, w + 8, h + 6, 12);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, w, h, 10);
  ctx.clip();
  const hz = SY(GY - 8200);
  const g = ctx.createLinearGradient(0, y0, 0, hz);
  g.addColorStop(0, INK.skyTop);
  g.addColorStop(0.55, INK.skyMid);
  g.addColorStop(1, INK.skyLow);
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, hz - y0 + 1);
  // The sun, half down into the sea, and a few slow clouds.
  const sx = SX(FW * 0.7), sr = 5200 * sc;
  ctx.fillStyle = alpha(INK.sun, 0.25);
  disc(sx, hz, sr * 1.5);
  ctx.fill();
  ctx.fillStyle = INK.sun;
  disc(sx, hz, sr);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,214,190,0.18)';
  for (let i = 0; i < 4; i++) {
    const cx = x0 + ((((i * 0.29 + now / 90000) % 1) + 1) % 1) * (w + 200) - 100, cy = y0 + h * (0.12 + i * 0.07);
    ctx.beginPath();
    ctx.ellipse(cx, cy, 60 * sc * 100, 9 * sc * 100, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 30 * sc * 100, cy - 5 * sc * 100, 34 * sc * 100, 8 * sc * 100, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // The sea, with the sun's path across it in short strokes.
  const shore = SY(GY - 2200);
  ctx.fillStyle = INK.sea;
  ctx.fillRect(x0, hz, w, shore - hz + 1);
  ctx.fillStyle = INK.seaDark;
  ctx.fillRect(x0, hz + (shore - hz) * 0.55, w, (shore - hz) * 0.45 + 1);
  ctx.fillStyle = alpha(INK.sun, 0.55);
  for (let i = 0; i < 6; i++) {
    const yy = hz + (shore - hz) * (0.12 + i * 0.14), ww = sr * (1.2 - i * 0.12) * (0.8 + 0.2 * Math.sin(now / 500 + i));
    ctx.fillRect(sx - ww / 2, yy, ww, Math.max(1, 300 * sc));
  }
  // The sand: the beach behind the court, the line the blobs stand on, and
  // the deep sand in front where nothing plays.
  ctx.fillStyle = INK.sandLit;
  ctx.fillRect(x0, shore, w, gy - shore + 1);
  ctx.fillStyle = INK.sand;
  ctx.fillRect(x0, gy, w, y0 + h - gy);
  ctx.fillStyle = INK.sandDark;
  for (let i = 0; i < 40; i++) {
    const px = x0 + ((i * 0.618) % 1) * w, py = gy + 6 + ((i * 0.377) % 1) * (y0 + h - gy - 8);
    ctx.fillRect(px, py, Math.max(1.5, 260 * sc), Math.max(1, 120 * sc));
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = Math.max(1, 160 * sc);
  ctx.beginPath();
  ctx.moveTo(x0, gy + 1);
  ctx.lineTo(x0 + w, gy + 1);
  ctx.stroke();
  // Each side's half of the sand, faintly in its colour.
  for (const s of [0, 1]) {
    const a = s ? SX(t.nx) : x0, b = s ? x0 + w : SX(t.nx);
    ctx.fillStyle = alpha(TEAM[s], 0.12);
    ctx.fillRect(a, gy + 2, b - a, y0 + h - gy);
  }
  // The score, big and soft in each side's sky.
  const big = Math.max(26, Math.min(72, 9000 * sc));
  for (const s of [0, 1]) {
    const cx = s ? SX((t.nx + FW) / 2) : SX(t.nx / 2);
    ctx.globalAlpha = 0.85;
    outlined(String(t.sc[s]), cx, SY(1500) + big, big, TEAM[s], 5);
    ctx.globalAlpha = 1;
    if (t.sv === s && t.bf !== LIVE && t.ph !== END) {
      ctx.font = font(big);
      const ww = ctx.measureText(String(t.sc[s])).width;
      drawBallAt(cx + ww / 2 + big * 0.35, SY(1500) + big * 0.62, big * 0.2, now / 400, false);
    }
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  roundRect(x0, y0, w, h, 10);
  ctx.stroke();
}

// The net post, from the sand to its round white top, with a strip of mesh.
function drawNet(t) {
  flat();
  const x = SX(t.nx), top = SY(NET_TOP), gy = SY(GY), hw = Math.max(2, NW * sc);
  ctx.fillStyle = 'rgba(40,20,20,0.25)';
  ctx.beginPath();
  ctx.ellipse(x + hw * 2, gy + 2, hw * 6, Math.max(2, 300 * sc), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK.wood;
  ctx.fillRect(x - hw, top, hw * 2, gy - top + 2);
  ctx.fillStyle = INK.woodLit;
  ctx.fillRect(x - hw, top, hw * 0.7, gy - top + 2);
  // Mesh strung down the post's side, the way a net looks end-on.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  const mt = top + 400 * sc, mb = top + 3200 * sc, mw = hw * 2.6;
  ctx.beginPath();
  for (let y = mt; y <= mb; y += Math.max(3, 400 * sc)) { ctx.moveTo(x - mw, y); ctx.lineTo(x + mw, y); }
  ctx.moveTo(x - mw, mt); ctx.lineTo(x - mw, mb);
  ctx.moveTo(x + mw, mt); ctx.lineTo(x + mw, mb);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  disc(x, top, hw * 1.15);
  ctx.fill();
  ctx.fillRect(x - mw, mt - Math.max(1.5, 160 * sc), mw * 2, Math.max(2, 320 * sc));
  // An arrow on the sand while the net stands off the middle: which way the
  // trailing side's half shrank.
  const off = t.nx - FW / 2;
  if (Math.abs(off) >= SHIFT) {
    const s = off < 0 ? 0 : 1, dir = s ? 1 : -1, ay = gy + Math.min(SAND * sc * 0.35, 16);
    ctx.fillStyle = alpha(TEAM[s], 0.9);
    ctx.beginPath();
    ctx.moveTo(x + dir * hw * 4, ay - 5);
    ctx.lineTo(x + dir * (hw * 4 + 8), ay);
    ctx.lineTo(x + dir * hw * 4, ay + 5);
    ctx.closePath();
    ctx.fill();
  }
}

// A beach ball: white, with three coloured panels turning as it spins.
function drawBallAt(x, y, r, a, hot) {
  ctx.save();
  if (hot) {
    ctx.fillStyle = 'rgba(255,140,40,0.35)';
    disc(x, y, r * 1.55);
    ctx.fill();
  }
  ctx.fillStyle = '#ffffff';
  disc(x, y, r);
  ctx.fill();
  ctx.save();
  disc(x, y, r);
  ctx.clip();
  const cols = hot ? ['#ff4a2e', '#ffb020', '#ff4a2e'] : ['#ff4f7b', '#ffd166', '#3fa9ff'];
  for (let i = 0; i < 3; i++) {
    const a0 = a + (i * Math.PI * 2) / 3;
    ctx.fillStyle = cols[i];
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r, a0, a0 + Math.PI / 3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(20,10,40,0.18)';
  disc(x + r * 0.25, y + r * 0.3, r);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  disc(x, y, r * 0.18);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.38, y - r * 0.42, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(29,20,56,0.55)';
  ctx.lineWidth = Math.max(1, r * 0.08);
  disc(x, y, r);
  ctx.stroke();
  ctx.restore();
}

// The ball, its shadow on the sand to read where it comes down, and while a
// serve hangs, the time left on a ring round it and a line to the sand.
function drawBall(t, x, y, now) {
  flat();
  const r = BR * sc, sx = SX(x), sy = SY(y), gy = SY(GY);
  const hot = t.rx >= HOT_AT && t.bf === LIVE;
  const high = Math.max(0, Math.min(1, (GY - y) / 26000));
  ctx.fillStyle = `rgba(60,30,30,${(0.35 - high * 0.2).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(sx, gy + 1, r * (1.2 - high * 0.5), Math.max(1.5, r * 0.3), 0, 0, Math.PI * 2);
  ctx.fill();
  if (t.bf === HOLD) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx, sy + r);
    ctx.lineTo(sx, gy);
    ctx.stroke();
    ctx.setLineDash([]);
    const k = t.ph === COUNT ? 1 : t.bh / SERVE_HOLD;
    ctx.strokeStyle = TEAM[t.bs];
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sx, sy, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
    ctx.stroke();
  }
  if (hot && Math.random() < 0.8) {
    bits.push({ x: x + (Math.random() - 0.5) * BR, y: y + (Math.random() - 0.5) * BR, vx: 0, vy: -1500, g: 0, life: 0, max: 14 + Math.random() * 10, size: 260 + Math.random() * 200, colour: Math.random() < 0.5 ? '#ff7a2e' : '#ffd166' });
  }
  drawBallAt(sx, sy, r, spin, hot);
}

// A blob: a half dome in its player's colour, squashed a little when it lands
// or hits, an eye that watches the ball, and its name over it.
function drawBlob(t, id, x, y, d, me, ballX, ballY, now) {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { x, y, sq: 0, seen: now }));
  look.x = x; look.y = y; look.seen = now;
  look.sq *= Math.pow(0.85, frameDt * 60);
  const r = radOf(t, d) * sc, sx = SX(x), sy = SY(y), gy = SY(GY);
  const colour = SEAT[d.c];
  const air = Math.max(0, Math.min(1, (GY - y) / 9000));
  // Its shadow, smaller the higher it flies.
  ctx.fillStyle = 'rgba(60,30,30,0.28)';
  ctx.beginPath();
  ctx.ellipse(sx, gy + 1, r * (1 - air * 0.4), Math.max(2, r * 0.18 * (1 - air * 0.4)), 0, 0, Math.PI * 2);
  ctx.fill();
  const sq = look.sq, rx = r * (1 + sq * 0.16), ry = r * (1 - sq * 0.18);
  const g = ctx.createLinearGradient(0, sy - ry, 0, sy);
  g.addColorStop(0, lighter(colour, 0.25));
  g.addColorStop(1, darker(colour, 0.2));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(sx, sy, rx, ry, 0, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = darker(colour, 0.45);
  ctx.lineWidth = Math.max(1.5, r * 0.07);
  ctx.stroke();
  // A shine on the dome, and a band in the side's colour at its foot.
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(sx - rx * 0.35, sy - ry * 0.62, rx * 0.2, ry * 0.1, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = TEAM[d.sd];
  ctx.fillRect(sx - rx * 0.92, sy - Math.max(2, ry * 0.12), rx * 1.84, Math.max(2, ry * 0.12));
  // The eye, on the side facing the net, looking at the ball.
  const ex = sx + (d.sd ? -1 : 1) * rx * 0.42, ey = sy - ry * 0.55, er = Math.max(2.5, r * 0.2);
  ctx.fillStyle = '#ffffff';
  disc(ex, ey, er);
  ctx.fill();
  const bx = SX(ballX) - ex, by = SY(ballY) - ey, bl = Math.hypot(bx, by) || 1;
  ctx.fillStyle = '#1d1438';
  disc(ex + (bx / bl) * er * 0.45, ey + (by / bl) * er * 0.45, er * 0.5);
  ctx.fill();
  // Under your own blob, on the sand: whether the dash is ready.
  if (me) {
    const bw = Math.max(18, r * 1.4), by0 = gy + Math.max(5, Math.min(10, SAND * sc * 0.18));
    const k = d.dc === 0 ? 1 : 1 - d.dc / DASH_CD;
    ctx.fillStyle = 'rgba(29,20,56,0.35)';
    roundRect(sx - bw / 2, by0, bw, 4, 2);
    ctx.fill();
    ctx.fillStyle = d.dc === 0 ? '#ffffff' : 'rgba(255,255,255,0.5)';
    roundRect(sx - bw / 2, by0, Math.max(4, bw * k), 4, 2);
    ctx.fill();
  }
  const px = Math.max(9, Math.min(13, 7 + r * 0.2));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(29,20,56,0.8)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  const ly = sy - ry - 5;
  ctx.strokeText(label, sx, ly);
  ctx.fillStyle = me ? '#ffffff' : lighter(colour, 0.3);
  ctx.fillText(label, sx, ly);
  if (me) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(sx - 4, ly - px - 4);
    ctx.lineTo(sx + 4, ly - px - 4);
    ctx.lineTo(sx, ly - px + 1);
    ctx.closePath();
    ctx.fill();
  }
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
    const rise = 10 + ease(f) * 22;
    const scale = f < 0.15 ? 0.6 + (f / 0.15) * 0.5 : 1.1 - Math.min(0.1, f - 0.15);
    ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
    ctx.font = font(p.px * scale);
    const half = ctx.measureText(p.s).width / 2 + 6;
    const X = Math.max(half, Math.min(VW - half, SX(p.x))), Y = Math.max(TOP + 14, SY(p.y) - rise);
    outlined(p.s, X, Y, p.px * scale, p.colour, 3);
  }
  ctx.globalAlpha = 1;
}

// Touches taken by the side that has the ball, three dots on its sand, and
// how long the rally has run.
function drawRally(t, now) {
  flat();
  if (t.bf === LIVE || t.bf === HOLD) {
    const gy = SY(GY), dy = gy + Math.max(8, Math.min(SAND * sc * 0.55, 26));
    for (const s of [0, 1]) {
      const cx = s ? SX((t.nx + FW) / 2) : SX(t.nx / 2);
      const n = t.ts === s ? t.tn : 0, rr = Math.max(3, Math.min(6, 500 * sc));
      for (let i = 0; i < TOUCHES; i++) {
        const x = cx + (i - 1) * rr * 3.2;
        disc(x, dy, rr);
        if (i < n) { ctx.fillStyle = n >= TOUCHES ? INK.gold : TEAM[s]; ctx.fill(); }
        else { ctx.strokeStyle = alpha(TEAM[s], 0.6); ctx.lineWidth = 1.5; ctx.stroke(); }
      }
    }
  }
  if (t.rx >= 2 && t.bf !== HOLD) {
    const hot = t.rx >= HOT_AT;
    const s = hot ? 'hot ball · worth two · rally ' + t.rx : 'rally ' + t.rx + (t.rx >= HOT_AT - 2 ? ' · hot at ' + HOT_AT : '');
    const px = 12;
    ctx.font = font(px);
    const w = ctx.measureText(s).width + 20, x = SX(t.nx), y = SY(1500) + 4;
    ctx.fillStyle = hot ? `rgba(255,110,40,${(0.75 + 0.2 * Math.sin(now / 120)).toFixed(3)})` : 'rgba(29,20,56,0.6)';
    roundRect(x - w / 2, y, w, 20, 10);
    ctx.fill();
    text(s, x, y + 14, px, hot ? '#ffffff' : INK.muted, 'center');
  }
}

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, and how far the set has gone.
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'set ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'set ' + t.rd + ' · first to ' + SET_TO + ', two clear';
    const sp = setPointFor(t);
    if (sp !== -1) { status = 'set ' + t.rd + ' · set point ' + sideName(sp); colour = Math.floor(now / 400) % 2 ? TEAM[sp] : INK.text; }
  } else status = 'set ' + t.rd + ' · over';
  text('volley', 12, 22, titlePx, '#ffd9b8', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('volley').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The players: each side's chips on its own half of the screen, in the
  // side's colour, with every player's own colour and sets won.
  const y = narrow ? 46 : 44;
  for (const s of [0, 1]) {
    const ids = bySeat(t).filter((id) => t.p[id].sd === s);
    if (!ids.length) continue;
    const span = VW / 2 - 16, gap = 5, cw = Math.min(124, (span - gap * (ids.length - 1)) / ids.length);
    let x = s ? VW - 8 - cw : 8;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.3)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      ctx.strokeStyle = alpha(TEAM[s], mine ? 1 : 0.55);
      ctx.lineWidth = mine ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x + 11, y + 2, 6, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      const wins = d.wn ? '★' + d.wn : '';
      ctx.font = font(11);
      const ww = wins ? ctx.measureText(wins).width + 6 : 0;
      if (wins && cw > 44) text(wins, x + cw - 8, y + 3, 11, INK.gold, 'right');
      if (cw > 40) fitText(mine ? 'you' : nickOf(id), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 29 - ww, 'left');
      x += s ? -(cw + gap) : cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to move · drag up to jump · tap to dash · three touches a side'
    : 'A/D or arrows move · W, ↑ or space jumps · S or shift dashes · mouse: follow, click jumps · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
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
  const cx = VW / 2, mid = (fieldTop + groundY) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const me = myId(), md = t.p[me];
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'where the ball meets your dome decides where it flies · three touches a side';
    practiceNote(now, VW, head, tip, [[groundY + 2, VH - BOT]], VH - BOT - 4);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    outlined(String(n), cx, mid + big * 0.6, big * 2.6 * s, '#ffffff', 6);
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 1.7, Math.min(VW - 32, 340), 30);
    const line = md ? 'you play for ' + sideName(md.sd) + ' · first to ' + SET_TO + ', two clear' : 'first to ' + SET_TO + ', two clear';
    fitText(line, cx, mid + big * 1.7 + 5, 14, md ? TEAM[md.sd] : INK.text, Math.min(VW - 48, 320));
  } else if (t.ph === PLAY && t.bf === HOLD && t.bh > SERVE_HOLD - HZ && t.sc[0] + t.sc[1] === 0) {
    const k = (SERVE_HOLD - t.bh) / HZ;
    ctx.globalAlpha = 1 - k;
    outlined('serve!', cx, mid, big * (2 + k), '#ffffff', 6);
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 340), h = 100 + rows.length * 22;
    const pyc = Math.min(mid, VH / 2) + (1 - k) * 30;
    ctx.globalAlpha = k;
    panel(cx, pyc, w, h);
    const head = md && md.sd === t.win ? 'your side takes the set!' : sideName(t.win) + ' takes the set';
    const y0 = pyc - h / 2;
    fitText(head, cx, y0 + 30, 21, TEAM[t.win], w - 24);
    text(t.sc[0] + ' : ' + t.sc[1], cx, y0 + 50, 14, INK.muted, 'center');
    text('points', cx + w / 2 - 62, y0 + 66, 10, INK.dim, 'right');
    text('sets', cx + w / 2 - 18, y0 + 66, 10, INK.dim, 'right');
    rows.forEach(([id, sd, kills, wins], i) => {
      const y = y0 + 86 + i * 22;
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.beginPath();
      ctx.arc(cx - w / 2 + 24, y - 1, 6, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = TEAM[sd];
      ctx.fillRect(cx - w / 2 + 18, y, 12, 2);
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 38, y, 14, id === me ? INK.text : INK.muted, w - 150, 'left');
      text(String(kills), cx + w / 2 - 62, y, 14, INK.text, 'right');
      text('★' + wins, cx + w / 2 - 18, y, 13, INK.gold, 'right');
    });
    fitText('sides are drawn again · next set in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a blob is as drawn: between two steps, and never slid across a jump —
// a blob sent across to even the sides.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.sd !== z.sd || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 12000) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

function ballAt(b) {
  const a = b.from, z = b.to;
  if (a.bf !== z.bf && z.bf === HOLD) return [z.bx, z.by];
  if (Math.abs(a.bx - z.bx) + Math.abs(a.by - z.by) > 16000) return [z.bx, z.by];
  return [lerp(a.bx, z.bx, b.k), lerp(a.by, z.by, b.k)];
}

// Your own blob is drawn from the guess a trip ahead, which is remade on every
// tick from a table where the room may have put a lean a step away from where
// the guess had it. So the blob drawn is pulled toward the guess a little
// every frame rather than put on it, and a guess far off puts it there at
// once. Only the drawing is smoothed: the court, and every rule on it, are
// untouched.
const PULL = 0.45;
let shown = null;        // [x, y] in units: where your blob is drawn
let myPos = null;        // the same, for the mouse to steer by

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 9000) return (shown = [x, y]);
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
    text('walking down to the beach…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  const [bx, by] = ballAt(b);
  if (ballLast) spin += ((bx - ballLast[0]) / BR) * 0.9;
  ballLast = [bx, by];
  drawCourt(t, now);
  drawNet(t);
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const p = bodyAt(b, id);
    if (p) drawBlob(t, id, p[0], p[1], p[2], false, bx, by, now);
  }
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own) {
    const p = bodyAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    myPos = [x, y];
    drawBlob(t.p[me] ? t : own.to, me, x, y, p[2], true, bx, by, now);
  } else {
    myPos = shown = null;
  }
  drawBall(t, bx, by, now);
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawRally(t, now);
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way leaned, a thousand at full, whether the jump is
// held, and how many dashes so far. A change of lean goes out no oftener than
// STEER_EVERY, because a thumb or a mouse changes it on every move the screen
// reports and the clock's ticks share the same seat's ceiling on messages; a
// jump pressed or let go and a dash go out at once.
const STEER_EVERY = 80;
let mode = '';           // what steers: 'keys', 'mouse', 'touch', or nothing yet
let dashesAsked = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_X = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
const KEY_JUMP = new Set(['ArrowUp', 'KeyW', 'Space']);
const KEY_DASH = new Set(['ArrowDown', 'KeyS', 'ShiftLeft', 'ShiftRight', 'KeyX', 'Enter']);

// A thumb: a stick from wherever it lands, read across as far as it is pushed,
// and pushed up past JUMP_PULL it holds the jump; a tap dashes — a drag rather
// than a press, because iOS keeps a long press inside a frame for itself. A
// second finger down holds the jump while it stays. A mouse: your blob runs
// under the pointer wherever it is; the left button holds the jump, the right
// one dashes.
const DEAD = 8;
const REACHOUT = 46;
const JUMP_PULL = 22;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }
let thumb2 = null;       // a second finger's id, holding the jump
const mouse = { x: 0, y: 0, on: false, down: false };

function leanNow() {
  if (mode === 'keys') {
    let x = 0;
    for (const c of keys) if (c in KEY_X) x += KEY_X[c];
    return clamp(x, -1, 1) * 1000;
  }
  if (mode === 'touch') {
    if (!stick || Math.abs(stick.dx) < DEAD) return 0;
    return clamp(Math.round((stick.dx / REACHOUT) * 20) * 50, -1000, 1000);
  }
  if (mode === 'mouse' && mouse.on && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0]), unit = R0 * sc;
    if (Math.abs(dx) < unit * 0.12) return 0;
    return clamp(Math.round((dx / (unit * 0.9)) * 20) * 50, -1000, 1000);
  }
  return 0;
}

function jumpNow() {
  for (const c of keys) if (KEY_JUMP.has(c)) return 1;
  if (mouse.down) return 1;
  if (thumb2 !== null) return 1;
  if (stick && stick.dy < -JUMP_PULL) return 1;
  return 0;
}

function sayHand(now, force) {
  const h = [leanNow(), jumpNow(), dashesAsked], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1] && h[2] === s[2]) return;
  if (!force && s && h[1] === s[1] && h[2] === s[2] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A dash: heard at once, and taken a trip later on every copy alike, if the
// table says the cooldown is over.
function dash() {
  wake();
  if (!world) return;
  dashesAsked = (dashesAsked + 1) % 1000;
  sayHand(performance.now(), true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (KEY_DASH.has(e.code)) {
    e.preventDefault();
    if (!e.repeat) dash();
    return;
  }
  if (!(e.code in KEY_X) && !KEY_JUMP.has(e.code)) return;
  e.preventDefault();
  coarse = false;
  if (e.code in KEY_X) mode = 'keys';
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
  thumb2 = null;
  paintStick();
  mouse.on = mouse.down = false;
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    mode = 'touch';
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    if (stick) { thumb2 = e.pointerId; sayHand(performance.now(), true); return; }
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
  if (e.button === 2) { dash(); return; }
  mouse.down = true;
  sayHand(performance.now(), true);
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
  if (e.pointerType === 'mouse' && e.button !== 2) {
    if (mouse.down) { mouse.down = false; sayHand(performance.now(), true); }
    return;
  }
  if (thumb2 !== null && e.pointerId === thumb2) { thumb2 = null; sayHand(performance.now(), true); return; }
  if (!stick || e.pointerId !== stick.id) return;
  const tap = !stick.moved && performance.now() - stick.at < 260;
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
  if (tap) dash();
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
  knob.style.background = stick.dy < -JUMP_PULL ? '#ffd166' : '#ffffff';
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
// a player arrives on the court.
function start() {
  setHand([0, 0, dashesAsked]);
  lastSaid = [0, 0, dashesAsked];
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
