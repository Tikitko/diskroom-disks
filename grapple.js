/**
 * @disk     grapple
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Swing up a volcano shaft on a grappling hook while the lava rises. Grab a crystal, let go at the top of the swing to fly, and slam into rivals to knock them off their rope and steal a gem. Crystals crack if you hang on too long.
 * @tags     game, party, realtime, physics, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/grapple.png
 */
// grapple.js — a grappling-hook climb where the room's order is the referee.
//
// Every copy holds the whole shaft — every climber, every rope, the lava and
// what is left of the crystals and gems — and moves it only on what comes back
// round the room, so every copy applies the same hands in the same order and
// holds the same shaft. Nobody sends where they are, whom they hit or a score:
// a hand names the crystal its player reaches for and which way they lean, and
// whether that crystal is in reach, who knocks whom off a rope and who picks up
// a gem is the same arithmetic on the same numbers on every machine. A page
// with a console open can play its own climber however it likes, at a
// climber's own pace, and no faster.
//
// The crystals and gems are not kept in the table: where they are is a pure
// function of the round's seed and the row, so a shaft of any height costs
// nothing to hand over. The table keeps only which crystals broke and which
// gems were taken, and forgets both once the lava has passed them.
//
// While a climber is alone, a bot climbs with them. It is part of the shaft
// like any climber, and its hand is a function of the shaft alone, so it plays
// the same on every copy and says nothing over the wire. When a second climber
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own climber does not wait for the trip: it is drawn from the agreed
// shaft played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.ceil`, `Math.abs`,
// `Math.min`, `Math.max` and `Math.imul` are fixed by the language to the last
// bit; nothing else is used inside a step.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// A number in [0, 1) fixed by the round's seed, a row and what is asked about
// it: the same three integers give the same number on every machine, so the
// shaft is laid out without being stored.
function hash01(seed, row, what) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((row + 0x632be5ab) | 0, 0xc2b2ae35);
  h = (h ^ Math.imul((what + 0x27d4eb2f) | 0, 0x165667b1)) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the shaft a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own climber a trip ahead, with your hand in it
const DT = 1 / HZ;

// The shaft is 1 wide; heights grow upward, and the lava starts a round below 0.
const W = 1;
const R = 0.032;               // a climber's radius
const G = 1.85;                // gravity
const REACH = 0.46;            // the longest rope: a crystal further off cannot be grabbed
const REACH_SLACK = 1.2;       // what a grab allows past that, for a hand judged on a table a trip old
const L_MIN = 0.075;           // the winch stops this far under the crystal
const REEL = 0.5;              // how fast the winch pulls a hooked climber up, a second
const PUMP = 1.5;              // how hard leaning swings a climber on a rope
const AIR = 0.8;               // and steers one in the air
const VMAX = 2.6;              // the fastest anybody flies
const WALL_BOUNCE = 0.45;
const HOLD = Math.round(2.4 * HZ);    // steps a crystal takes a climber's weight before it breaks
const KNOCK = 0.75;            // closing speed past which a collision knocks somebody off
const STUN = Math.round(0.6 * HZ);    // steps a knocked climber cannot grab
const FRESH = Math.round(1.5 * HZ);   // steps a climber just launched bounces off the lava and cannot be knocked
const BURNT = Math.round(1.2 * HZ);   // steps before a burnt climber is launched again
const LAUNCH_V = 1.75;         // how hard a launch throws a climber up out of the lava
const BAND = 1.75;             // crystals more than this far above the lava are still in the smoke
const ROW = 0.16;              // the height between two rows of crystals
const ROW_OFF = 8;             // rows below zero still get ids of zero and up
const PID_MAX = 1 << 30;
const QMAX = 1000000;
const GEM_R = 0.03;
const GOLD = 3;                // what a gold gem is worth; a plain one is worth 1
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second climber arrives
const PLAY_STEPS = 75 * HZ;
const END_STEPS = 8 * HZ;
const ERUPT = 15 * HZ;         // the last steps of a round, when the lava surges and gems count double
const LAVA_WAIT = 0.085;       // how fast the lava rises in practice, a second
const LAVA_START = 0.07;       // and in a round: from this,
const LAVA_GROW = 0.0018;      // growing by this every second,
const LAVA_SURGE = 1.5;        // and this much faster through the eruption
const START_Y = 0.3;           // where climbers hover through a countdown
const START_LAVA = -0.45;

// The shaft. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every climber is made by one function with its fields in one order.
//   sd: the round's seed, which lays out its crystals and gems; lv: the lava's height
//   g: gems taken, b: crystals broken, both by id and forgotten below the lava
//   res: the last round's [id, gems, rounds won] rows; win: its winner or -1
function freshTable(seed) {
  return {
    rng: seed | 0, sd: seed | 0, ph: WAIT, pt: 0, rd: 0, lv: START_LAVA, g: [], b: [],
    p: {}, res: null, win: -1,
  };
}

const FIELDS = ['x', 'y', 'vx', 'vy', 'hk', 'L', 'ht', 'st', 't', 'fr', 'sn', 'sc', 'wn', 'k', 'q', 'ip', 'pw', 'fl', 'hs', 'hc'];
//   x, y, vx, vy: the climber; hk: the crystal it hangs from, or -1; L: the
//   rope's length; ht: steps on that crystal; st: 0 climbing, 1 burnt; t: steps
//   in that state; fr: fresh steps left; sn: stunned steps left; sc: gems this
//   round; wn: rounds won; k: seat, which is its colour; q: the last grab its
//   hand made; ip: the crystal its hand holds on to, or -1 for none; pw: a grab
//   still waiting for its crystal to come in reach, or -1; fl: which way it
//   leans, 1 left and 2 right; hs, hc: hands this step.
function climber(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const sorted = (w) => playersIn(w).sort((a, b) => a - b);
const erupting = (w) => w.ph === PLAY && w.pt <= ERUPT;
const scoring = (w) => w.ph === PLAY || w.ph === WAIT;

// ── the crystals and the gems ───────────────────────────────────────────────
// A row holds one crystal or two, and a gem between it and the next row most
// of the time. A crystal's id is its row and which of the two it is; a gem's
// is its row.
const pegCount = (sd, r) => (hash01(sd, r, 0) < 0.42 ? 1 : 2);

function pegAt(w, pid) {
  if (!Number.isInteger(pid) || pid < 0 || pid >= PID_MAX) return null;
  const r = (pid >> 1) - ROW_OFF, j = pid & 1, n = pegCount(w.sd, r);
  if (j >= n) return null;
  let x;
  if (n === 1) x = 0.2 + 0.6 * hash01(w.sd, r, 1);
  else if (j === 0) x = 0.08 + 0.32 * hash01(w.sd, r, 2);
  else x = 0.6 + 0.32 * hash01(w.sd, r, 3);
  return [x, r * ROW + (hash01(w.sd, r, 4) - 0.5) * 0.06];
}
const pegId = (r, j) => (r + ROW_OFF) * 2 + j;

function gemAt(w, r) {
  if (r < -ROW_OFF || hash01(w.sd, r, 5) >= 0.74) return null;
  return [0.1 + 0.8 * hash01(w.sd, r, 6), r * ROW + ROW * 0.5, hash01(w.sd, r, 7) < 0.11 ? GOLD : 1];
}
const gemId = (r) => r + ROW_OFF;

const broken = (w, pid) => w.b.includes(pid);
// A crystal can be grabbed while it is out of the lava and below the smoke.
const pegOpen = (w, p) => p[1] > w.lv + 0.04 && p[1] <= w.lv + BAND;

// The crystals near a height, as [id, x, y], in one order on every copy.
function pegsNear(w, y, span) {
  const out = [];
  const r0 = Math.max(-ROW_OFF, Math.floor((y - span) / ROW) - 1), r1 = Math.ceil((y + span) / ROW) + 1;
  for (let r = r0; r <= r1; r++) {
    for (let j = 0; j < 2; j++) {
      const pid = pegId(r, j), p = pegAt(w, pid);
      if (p && !broken(w, pid)) out.push([pid, p[0], p[1]]);
    }
  }
  return out;
}

// The best crystal to grab from where a climber is: high above it, toward the
// way it leans, near a gem; never in the lava or the smoke. Shared by the bot
// and by a keyboard's grab, which has no pointer to aim with.
function bestPeg(w, d, lean, most) {
  let best = -1, top = -Infinity;
  for (const [pid, px, py] of pegsNear(w, d.y, most)) {
    if (!pegOpen(w, [px, py])) continue;
    const dx = px - d.x, dy = py - d.y, far = Math.sqrt(dx * dx + dy * dy);
    if (far > most || far < 0.05) continue;
    let s = dy + lean * dx * 0.6 - Math.abs(far - 0.32) * 0.3;
    if (pid === d.hk) s -= 1;
    const r = Math.floor((py - ROW * 0.5) / ROW);
    for (const gr of [r, r + 1]) {
      const g = gemAt(w, gr);
      if (g && !w.g.includes(gemId(gr)) && Math.abs(g[0] - px) < 0.18) s += 0.12 * g[2];
    }
    if (s > top) { top = s; best = pid; }
  }
  return best;
}

// ── who is where ────────────────────────────────────────────────────────────
function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// A launch: out of the lava, or off the floor of a round, straight up, with a
// moment in which the lava bounces the climber rather than burning it.
function launch(w, d, x, y, id) {
  d.x = x;
  d.y = y;
  d.vx = 0;
  d.vy = LAUNCH_V;
  d.hk = -1; d.L = 0; d.ht = 0; d.st = 0; d.t = 0; d.fr = FRESH; d.sn = 0; d.pw = -1;
  fx(w, 'launch', x, y, id);
}

// Where somebody arriving or coming back is launched from: the stretch of the
// shaft furthest from every other climber near the lava.
function openX(w, id) {
  let best = 0.5, far = -1;
  for (let i = 0; i <= 16; i++) {
    const x = 0.12 + (0.76 * i) / 16;
    let near = Infinity;
    for (const o of playersIn(w)) {
      if (o === id) continue;
      const e = w.p[o];
      if (Math.abs(e.y - w.lv) < 0.8) near = Math.min(near, Math.abs(e.x - x));
    }
    if (near > far + 1e-9) { far = near; best = x; }
  }
  return best;
}

function newClimber(w, id) {
  return (w.p[id] = climber({
    x: 0.5, y: 0, vx: 0, vy: 0, hk: -1, L: 0, ht: 0, st: 0, t: 0, fr: 0, sn: 0, sc: 0, wn: 0,
    k: freeSeat(w), q: 0, ip: -1, pw: -1, fl: 0, hs: w.n, hc: 0,
  }));
}

// A hand, at its place in the room's order: [grab, crystal, lean]. A new grab
// number is a new press; holding the same one again is still holding, so a
// hand said again never grabs twice, and a climber knocked off its crystal
// does not climb back on until its player presses again. Being heard is how a
// climber arrives, and it is launched up at once.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = newClimber(w, id);
    d.q = input[0];
    if (w.ph === COUNT) { hover(w, d); d.x = openX(w, id); }
    else launch(w, d, openX(w, id), w.lv + 0.12, id);
  }
  // A flood of hands in one step is cut off where no player's fingers could
  // reach, on every copy alike; the ones that are heard only ever reach.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  const [q, pid, fl] = input;
  d.fl = fl;
  d.ip = pid;
  if (q !== d.q) {
    d.q = q;
    d.pw = pid;
  } else if (pid !== d.pw) {
    d.pw = -1;
  }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
// Whether the crystal it names exists, is whole and is in reach is the step's
// business, judged on the table every copy holds.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [q, pid, fl] = raw;
  if (!Number.isInteger(q) || q < 0 || q >= QMAX) return null;
  if (!Number.isInteger(pid) || pid < -1 || pid >= PID_MAX) return null;
  if (!Number.isInteger(fl) || fl < 0 || fl > 3) return null;
  return [q, pid, fl];
}

function leave(w, id) {
  delete w.p[id];
}

function hover(w, d) {
  d.vx = d.vy = 0;
  d.hk = -1; d.L = 0; d.ht = 0; d.st = 0; d.t = 0; d.fr = 0; d.sn = 0; d.pw = -1;
  d.y = START_Y;
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
}

// A round: a new shaft, the lava back down, the climbers spread across it in
// seat order and hovering, the gems wiped.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.sd = Math.floor(draw01(w) * 2147483647);
  w.lv = START_LAVA;
  w.g = [];
  w.b = [];
  const ids = sorted(w).sort((a, b) => w.p[a].k - w.p[b].k);
  ids.forEach((id, i) => {
    const d = w.p[id];
    d.sc = 0;
    hover(w, d);
    d.x = 0.1 + (0.8 * (i + 0.5)) / ids.length;
  });
  fx(w, 'round');
}

function finish(w) {
  const res = sorted(w).map((id) => [id, w.p[id].sc, w.p[id].wn]);
  res.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (res.length && res[0][1] > 0 && (res.length < 2 || res[1][1] < res[0][1])) {
    w.win = res[0][0];
    w.p[w.win].wn += 1;
    res[0][2] += 1;
  }
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, w.win);
}

function lavaSpeed(w) {
  if (w.ph === WAIT) return LAVA_WAIT;
  if (w.ph !== PLAY) return 0;
  const v = LAVA_START + (LAVA_GROW * (PLAY_STEPS - w.pt)) / HZ;
  return erupting(w) ? v * LAVA_SURGE : v;
}

// Whether a climber stands alone at the top of the gems: knocking them off
// steals two, so a runaway leader is everybody's target.
function leads(w, id) {
  const sc = w.p[id].sc;
  if (sc <= 0) return false;
  for (const o of playersIn(w)) if (o !== id && w.p[o].sc >= sc) return false;
  return true;
}

function letGo(w, d, id) {
  if (d.hk < 0) return;
  d.hk = -1;
  d.L = 0;
  d.ht = 0;
  fx(w, 'let', d.x, d.y, id);
}

// A crystal that has held somebody too long breaks, and drops whoever hangs
// from it.
function breakPeg(w, pid) {
  if (!broken(w, pid)) w.b.push(pid);
  const p = pegAt(w, pid);
  if (p) fx(w, 'break', p[0], p[1], pid);
  for (const id of sorted(w)) {
    const d = w.p[id];
    if (d.hk === pid) { d.hk = -1; d.L = 0; d.ht = 0; }
  }
}

// One climber through one step: its grab, its lean, gravity, and the rope that
// will not let it further from its crystal than its length.
function climb(w, id, d) {
  if (d.t < 100000) d.t += 1;
  if (d.st === 1) {
    if (d.t >= BURNT) launch(w, d, openX(w, id), w.lv + 0.12, id);
    return;
  }
  if (d.fr > 0) d.fr -= 1;
  if (d.sn > 0) d.sn -= 1;

  // Letting go is the hand holding nothing; a grab is tried every step until
  // its crystal comes in reach, or the player lets go of it.
  if (d.ip < 0 && d.hk >= 0) letGo(w, d, id);
  if (d.pw >= 0 && d.sn === 0) {
    const p = pegAt(w, d.pw);
    if (!p || broken(w, d.pw) || !pegOpen(w, p)) d.pw = -1;
    else {
      const dx = p[0] - d.x, dy = p[1] - d.y, far = Math.sqrt(dx * dx + dy * dy);
      if (far <= REACH * REACH_SLACK) {
        d.hk = d.pw;
        d.L = Math.max(L_MIN, far);
        d.ht = 0;
        d.pw = -1;
        fx(w, 'hook', p[0], p[1], id);
      }
    }
  }

  const lean = (d.fl & 2 ? 1 : 0) - (d.fl & 1 ? 1 : 0);
  d.vy -= G * DT;
  d.vx += lean * (d.hk >= 0 ? PUMP : AIR) * DT;
  d.vx *= 0.997;
  d.vy *= 0.997;
  d.x += d.vx * DT;
  d.y += d.vy * DT;

  if (d.hk >= 0) {
    const p = pegAt(w, d.hk);
    if (!p || broken(w, d.hk)) { d.hk = -1; d.L = 0; d.ht = 0; }
    else {
      // The winch takes in the rope, and a climber further out than the rope
      // is pulled back onto it, losing only the speed that carried it outward.
      d.L = Math.max(L_MIN, d.L - REEL * DT);
      const rx = d.x - p[0], ry = d.y - p[1], r = Math.sqrt(rx * rx + ry * ry);
      if (r > d.L && r > 1e-9) {
        const nx = rx / r, ny = ry / r;
        d.x = p[0] + nx * d.L;
        d.y = p[1] + ny * d.L;
        const out = d.vx * nx + d.vy * ny;
        if (out > 0) { d.vx -= nx * out; d.vy -= ny * out; }
      } else {
        d.L = Math.max(L_MIN, r);
      }
      d.ht += 1;
      if (d.ht >= HOLD) breakPeg(w, d.hk);
    }
  }

  if (d.x < R) { d.x = R; if (d.vx < 0) { d.vx = -d.vx * WALL_BOUNCE; fx(w, 'wall', d.x, d.y, id); } }
  if (d.x > W - R) { d.x = W - R; if (d.vx > 0) { d.vx = -d.vx * WALL_BOUNCE; fx(w, 'wall', d.x, d.y, id); } }
  const s = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
  if (s > VMAX) { d.vx *= VMAX / s; d.vy *= VMAX / s; }
}

// Two climbers that meet bounce apart; one that hits the other hard enough
// knocks it off its rope, stuns it, and takes a gem off it — two off the
// leader. Pairs are taken in id order on every copy alike.
function collide(w, ids) {
  for (let i = 0; i < ids.length; i++) {
    const A = w.p[ids[i]];
    if (A.st !== 0) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const B = w.p[ids[j]];
      if (B.st !== 0) continue;
      const dx = B.x - A.x, dy = B.y - A.y, dd = dx * dx + dy * dy;
      if (dd >= 4 * R * R || dd < 1e-12) continue;
      const far = Math.sqrt(dd), nx = dx / far, ny = dy / far;
      const push = (2 * R - far) / 2;
      A.x -= nx * push; A.y -= ny * push;
      B.x += nx * push; B.y += ny * push;
      const an = A.vx * nx + A.vy * ny, bn = B.vx * nx + B.vy * ny;
      const close = an - bn;
      if (close <= 0) continue;
      // Equal weights: the closing speed is shared out again, a little less of it.
      const e = 0.85, ka = (an + bn) / 2 - (e * close) / 2, kb = (an + bn) / 2 + (e * close) / 2;
      A.vx += (ka - an) * nx; A.vy += (ka - an) * ny;
      B.vx += (kb - bn) * nx; B.vy += (kb - bn) * ny;
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      if (close < KNOCK || A.fr > 0 || B.fr > 0) { fx(w, 'bump', mx, my, ids[i], ids[j]); continue; }
      // Whoever brought more of the closing speed did the hitting.
      const aHits = Math.max(0, an) >= Math.max(0, -bn);
      const hitter = aHits ? ids[i] : ids[j], victim = aHits ? ids[j] : ids[i];
      knock(w, hitter, victim, mx, my, aHits ? nx : -nx, aHits ? ny : -ny);
    }
  }
}

function knock(w, hitter, victim, x, y, nx, ny) {
  const V = w.p[victim], H = w.p[hitter];
  V.hk = -1; V.L = 0; V.ht = 0; V.pw = -1;
  V.sn = STUN;
  V.vx += nx * 0.35;
  V.vy += ny * 0.35;
  let take = 0;
  if (scoring(w)) {
    take = Math.min(V.sc, leads(w, victim) ? 2 : 1);
    V.sc -= take;
    H.sc += take;
  }
  fx(w, 'knock', x, y, victim, hitter, take);
}

// Gems go to whoever touches them first, in id order on every copy alike.
function gems(w, ids) {
  if (w.ph !== PLAY && w.ph !== WAIT) return;
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== 0) continue;
    const r0 = Math.floor((d.y - ROW) / ROW) - 1, r1 = r0 + 3;
    for (let r = r0; r <= r1; r++) {
      const g = gemAt(w, r), gid = gemId(r);
      if (!g || g[1] < w.lv || w.g.includes(gid)) continue;
      const dx = g[0] - d.x, dy = g[1] - d.y;
      if (dx * dx + dy * dy > (R + GEM_R) * (R + GEM_R)) continue;
      w.g.push(gid);
      const pts = g[2] * (erupting(w) ? 2 : 1);
      d.sc += pts;
      fx(w, 'gem', g[0], g[1], id, pts, g[2]);
    }
  }
}

// The lava: it rises, and burns a third of the gems of anybody it catches who
// is not fresh from a launch; a fresh climber bounces off it instead.
function lava(w, ids) {
  w.lv += lavaSpeed(w) * DT;
  for (const id of ids) {
    const d = w.p[id];
    if (d.st !== 0 || d.y - R * 0.4 > w.lv) continue;
    if (d.fr > 0 || w.ph === END || w.ph === COUNT) {
      d.y = Math.max(d.y, w.lv + R * 0.4);
      if (d.vy < LAUNCH_V * 0.8) { d.vy = LAUNCH_V * 0.8; fx(w, 'bounce', d.x, w.lv, id); }
      continue;
    }
    const lost = scoring(w) ? Math.ceil(d.sc / 3) : 0;
    d.sc -= lost;
    d.st = 1;
    d.t = 0;
    d.hk = -1; d.L = 0; d.ht = 0; d.pw = -1;
    d.vx = d.vy = 0;
    fx(w, 'burn', d.x, w.lv, id, lost);
  }
  // What the lava has passed is forgotten: it can never come back.
  if (w.n % HZ === 0) {
    const r = Math.floor((w.lv - 0.3) / ROW);
    w.g = w.g.filter((gid) => gid - ROW_OFF >= r);
    w.b = w.b.filter((pid) => (pid >> 1) - ROW_OFF >= r);
  }
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot climbs while the shaft waits for a round, and goes the moment a
// round's countdown starts.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && Object.keys(w.p).length < MAX_P) {
    const d = newClimber(w, BOT_ID);
    launch(w, d, openX(w, BOT_ID), w.lv + 0.12, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

function botPress(d, pid) {
  d.q = (d.q + 1) % QMAX;
  d.ip = d.pw = pid;
}

// The bot's hand: it grabs a high crystal near the top of a rise, swings the
// way it is already going, and lets go once the winch has it near the crystal
// and it is swinging up — or before the crystal breaks. Now and then it
// hesitates, and it never aims at anybody, so it can be beaten and knocked.
function botThink(w, id, d) {
  if (d.st !== 0 || w.n % BOT_EVERY) return;
  if (draw01(w) < 0.1) return;
  if (d.hk >= 0) {
    d.fl = d.vx > 0.05 ? 2 : d.vx < -0.05 ? 1 : 0;
    const near = d.L <= L_MIN + 0.03;
    if ((near && d.vy > 0.15) || d.ht > HOLD - 12 || (near && d.ht > HZ && draw01(w) < 0.3)) {
      d.ip = -1;
      d.pw = -1;
    }
    return;
  }
  d.fl = 0;
  if (d.pw >= 0) return;
  if (d.vy < 0.4 || d.y - w.lv < 0.35) {
    const pid = bestPeg(w, d, d.vx > 0 ? 0.5 : -0.5, REACH * 0.95);
    if (pid >= 0) botPress(d, pid);
  } else {
    d.ip = -1;
  }
}

// One step of the shaft: a function of the shaft alone.
function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second climber ends practice, three seconds on: the count runs in pt,
    // which a waiting shaft otherwise leaves at zero. The bot goes first, so
    // the round spreads the climbers across the shaft without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) {
        w.ph = PLAY;
        w.pt = PLAY_STEPS;
        for (const id of sorted(w)) launch(w, w.p[id], w.p[id].x, w.p[id].y, id);
        fx(w, 'go');
      }
    } else if (w.ph === PLAY) {
      if (w.pt === ERUPT) fx(w, 'erupt');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  const ids = sorted(w);
  if (w.ph === COUNT) {
    for (const id of ids) { const d = w.p[id]; d.vx = d.vy = 0; d.hk = -1; d.pw = -1; d.st = 0; }
    return;
  }
  if (w.p[BOT_ID]) botThink(w, BOT_ID, w.p[BOT_ID]);
  for (const id of ids) climb(w, id, w.p[id]);
  collide(w, ids);
  gems(w, ids);
  lava(w, ids);
}

// A shaft handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;
const HIGH = 1e6;

function idList(raw, most) {
  if (!Array.isArray(raw) || raw.length > most) return null;
  const out = [];
  for (const v of raw) {
    if (!int(v, 0, PID_MAX) || out.includes(v)) return null;
    out.push(v);
  }
  return out;
}

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !Number.isInteger(raw.sd) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!num(raw.lv, -1, HIGH)) return null;
  const g = idList(raw.g, 600), b = idList(raw.b, 600);
  if (!g || !b) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!num(d.x, -0.5, W + 0.5) || !num(d.y, -50, HIGH) || !num(d.vx, -10, 10) || !num(d.vy, -10, 10)) return null;
    if (!int(d.hk, -1, PID_MAX) || !num(d.L, 0, 2) || !int(d.ht, 0, HOLD) || !int(d.st, 0, 1) || !int(d.t, 0, BIG)) return null;
    if (!int(d.fr, 0, FRESH) || !int(d.sn, 0, STUN) || !int(d.sc, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.k, 0, MAX_P - 1) || seats.has(d.k) || !int(d.q, 0, QMAX - 1)) return null;
    if (!int(d.ip, -1, PID_MAX) || !int(d.pw, -1, PID_MAX) || !int(d.fl, 0, 3)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    seats.add(d.k);
    p[id] = climber(d);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 3 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push([r[0], r[1], r[2]]);
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return { rng: raw.rng, sd: raw.sd, ph: raw.ph, pt: raw.pt, rd: raw.rd, lv: raw.lv, g, b, p, res, win: raw.win };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed shaft steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a basalt shaft lit from below by orange lava, ice-blue crystals
// to swing from, green and gold gems, and a bright colour for each seat that
// is its climber's, its rope's and its chip's on the scoreboard.
const INK = {
  rockTop: '#1d1228', rockLow: '#3a1620', wall: '#140b18', wallEdge: '#4a2a3e', strata: 'rgba(255,170,120,0.05)',
  text: '#fff3e8', muted: '#e0c8c8', dim: '#a88f98', gold: '#ffd166', danger: '#ff5a3c',
  panel: 'rgba(24,12,22,0.92)', crystal: '#8ff3ff', crystalDark: '#2aa8c4', gem: '#5dffa0', gemDark: '#1fae66',
  lavaHi: '#ffd23a', lava: '#ff7a1f', lavaLow: '#b3141f', smoke: '42,30,48',
};
const SEAT = ['#ff5d8f', '#3ec1ff', '#ffd23f', '#7bf08a', '#c08cff', '#ff9f43', '#5b8cff', '#f5f5f5'];
const FONT = "600 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.rockTop};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%;cursor:crosshair';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #5a3550;' +
  `background:#2a1626;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

// The field shows the whole width of the shaft and at least VIEW_MIN of its
// height; the camera rides up with your climber.
const VIEW_MIN = 1.2;
let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, sc = 300, ox = 0, midY = 200, TOP = 58, BOT = 26, dpx = 1;
let camY = null;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 66 : 58;
  BOT = 26;
  const ah = Math.max(60, VH - TOP - BOT);
  sc = Math.max(60, Math.min((VW - 16) / W, ah / VIEW_MIN));
  ox = (VW - W * sc) / 2;
  midY = TOP + ah / 2;
}
layout();
window.addEventListener('resize', layout);

const SX = (x) => ox + x * sc + shakeX;
const SY = (y) => midY - (y - camY) * sc + shakeY;
const altAt = (py) => camY + (midY - py) / sc;
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
  text(s, x, y, wd > most ? Math.max(8, (px * most) / wd) : px, colour, align);
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
function lighter(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function darker(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - k)));
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
  hook(mine) {
    if (!ready('hook', 60)) return;
    tone(mine ? 1500 : 1100, 0.05, 'square', mine ? 0.05 : 0.025);
    tone(420, 0.16, 'sawtooth', mine ? 0.035 : 0.015, 1.9, 0.02);
  },
  let() { if (ready('let', 80)) puff(0.18, 0.06, 1400, 0, 0.9); },
  gem(gold) {
    if (!ready('gem', 50)) return;
    const notes = gold ? [880, 1109, 1319, 1760] : [1319, 1760];
    notes.forEach((f, i) => tone(f, 0.18, 'triangle', 0.08, 0, i * 0.05));
  },
  knock(mine) {
    if (!ready('knock', 90)) return;
    tone(170, 0.18, 'square', mine ? 0.12 : 0.06, 0.5);
    puff(0.12, mine ? 0.2 : 0.1, 900, 0, 1);
  },
  steal() { if (ready('steal', 120)) { tone(660, 0.08, 'triangle', 0.1); tone(990, 0.16, 'triangle', 0.09, 0, 0.07); } },
  bump() { if (ready('bump', 140)) tone(240, 0.06, 'sine', 0.05, 0.8); },
  wall() { if (ready('wall', 120)) puff(0.06, 0.05, 500, 0, 1); },
  burn(mine) {
    if (!ready('burn', 150)) return;
    puff(0.55, mine ? 0.22 : 0.1, 3200, 0, 0.7);
    tone(220, 0.45, 'sawtooth', mine ? 0.06 : 0.03, 0.3);
  },
  launch() { if (ready('launch', 150)) { tone(260, 0.35, 'sine', 0.08, 2.6); puff(0.3, 0.05, 700, 0, 0.6); } },
  bounce() { if (ready('bounce', 150)) tone(150, 0.14, 'sine', 0.08, 2.2); },
  crack() { if (ready('crack', 80)) { puff(0.08, 0.18, 5200, 0, 3); tone(2100, 0.12, 'triangle', 0.04, 0.4); } },
  erupt() {
    if (!ready('erupt', 800)) return;
    tone(55, 1.6, 'sawtooth', 0.07, 0.7);
    puff(1.5, 0.16, 180, 0, 0.5);
    puff(0.9, 0.08, 700, 0.3, 0.6);
  },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(500, 0.14, 'sine', 0.12, 2.0); tone(1000, 0.25, 'sine', 0.08, 1.0, 0.12); } },
  end(won) {
    if (!ready('end', 500)) return;
    if (won) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, 'triangle', 0.1, 0, i * 0.09));
    else [392, 330, 262].forEach((f, i) => tone(f, 0.26, 'triangle', 0.08, 0, i * 0.1));
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
// fast screen and a slow one see the same spray. Positions are in shaft units,
// heights upward.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, fall }
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r }
const embers = [];    // { x, y, vy, life, max, wob }
let shakeX = 0, shakeY = 0, shake = 0, flash = 0, burnGlow = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, fall) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v + (fall ? speed * 0.5 : 0), life: 0,
      max: 18 + Math.random() * 22, size, colour, fall: fall || 0 });
  }
  if (bits.length > 500) bits.splice(0, bits.length - 500);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 16, lift: lift || 18 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
let lavaSeen = 0;
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.93; b.vy = b.vy * 0.93 - b.fall / BIT_HZ;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    // Embers rise off the lava all the time: the page's own, for looks alone.
    if (embers.length < 70 && Math.random() < 0.5) {
      embers.push({ x: Math.random() * W, y: lavaSeen, vy: 0.08 + Math.random() * 0.22, life: 0, max: 90 + Math.random() * 140, wob: Math.random() * 6 });
    }
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      e.y += e.vy / BIT_HZ;
      e.x += Math.sin(e.life / 20 + e.wob) * 0.0008;
      if (++e.life >= e.max) embers.splice(i, 1);
    }
    for (const look of looks.values()) look.squash *= 0.88;
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.9;
    burnGlow *= 0.97;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, seen, trail: [[x, y]], trailAt, eye: [x, y] }
let drawFailed = false;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, seen: 0, trail: [], trailAt: 0, eye: [0, 0] }));
  l.seen = performance.now();
  return l;
}
const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].k] : '#dddddd');
// Only what happens in sight is heard, but your own climber is always heard.
const near = (y) => camY !== null && Math.abs(y - camY) < 1.3;

function play(e, t) {
  const me = myId();
  if (e.kind === 'hook') {
    const mine = e.a === me;
    spray(e.x, e.y, mine ? 8 : 4, INK.crystal, 0.35, 0.006);
    ring(e.x, e.y, colourOf(t, e.a), 0.04);
    if (mine || near(e.y)) sound.hook(mine);
  } else if (e.kind === 'let') {
    if (e.a === me) sound.let();
  } else if (e.kind === 'gem') {
    const mine = e.a === me, gold = e.c === GOLD;
    spray(e.x, e.y, gold ? 24 : 12, gold ? INK.gold : INK.gem, 0.45, 0.007);
    ring(e.x, e.y, gold ? INK.gold : INK.gem, gold ? 0.09 : 0.06);
    pop(e.x, e.y, '+' + e.b + (mine ? '' : ' ' + nickOf(e.a)), mine ? (gold ? INK.gold : INK.gem) : colourOf(t, e.a), mine ? 20 : 13, 26);
    if (mine) sound.gem(gold);
    else if (near(e.y)) sound.gem(false);
  } else if (e.kind === 'knock') {
    const victim = e.a === me, hitter = e.b === me;
    spray(e.x, e.y, 18, colourOf(t, e.a), 0.6, 0.008);
    spray(e.x, e.y, 10, '#ffffff', 0.8, 0.005);
    ring(e.x, e.y, '#ffffff', 0.08);
    lookOf(e.a).squash = 1;
    lookOf(e.b).squash = 0.6;
    if (victim) { shake = Math.max(shake, 10); flash = 1; pop(e.x, e.y, e.c ? 'knocked! −' + e.c : 'knocked off!', INK.danger, 20, 30); }
    else if (hitter) { shake = Math.max(shake, 5); pop(e.x, e.y, e.c ? 'stole +' + e.c : 'smash!', colourOf(t, e.b), 20, 30); }
    else if (e.c) pop(e.x, e.y, nickOf(e.b) + ' +' + e.c, colourOf(t, e.b), 13, 26);
    if (victim || hitter || near(e.y)) sound.knock(victim || hitter);
    if (hitter && e.c) sound.steal();
  } else if (e.kind === 'bump') {
    lookOf(e.a).squash = Math.max(lookOf(e.a).squash, 0.35);
    lookOf(e.b).squash = Math.max(lookOf(e.b).squash, 0.35);
    if ((e.a === me || e.b === me)) sound.bump();
  } else if (e.kind === 'wall') {
    lookOf(e.a).squash = Math.max(lookOf(e.a).squash, 0.4);
    spray(e.x, e.y, 3, '#7a5568', 0.25, 0.006, 0.6);
    if (e.a === me) sound.wall();
  } else if (e.kind === 'burn') {
    const mine = e.a === me;
    spray(e.x, e.y, 26, INK.lava, 0.6, 0.009, 0.8);
    spray(e.x, e.y, 14, '#5a4a52', 0.35, 0.012, -0.4);
    ring(e.x, e.y, INK.lavaHi, 0.1);
    if (mine) { shake = Math.max(shake, 12); burnGlow = 1; pop(e.x, e.y + 0.08, e.b ? 'burnt! −' + e.b : 'burnt!', INK.danger, 22, 34); }
    else pop(e.x, e.y + 0.06, nickOf(e.a) + (e.b ? ' −' + e.b : ''), colourOf(t, e.a), 13, 24);
    if (mine || near(e.y)) sound.burn(mine);
  } else if (e.kind === 'launch') {
    const l = lookOf(e.a);
    l.trail = [];
    l.squash = 0.8;
    spray(e.x, e.y, 10, INK.lavaHi, 0.4, 0.007);
    if (e.a === me) sound.launch();
  } else if (e.kind === 'bounce') {
    spray(e.x, e.y, 8, INK.lavaHi, 0.4, 0.007);
    lookOf(e.a).squash = 0.7;
    if (e.a === me) sound.bounce();
  } else if (e.kind === 'break') {
    spray(e.x, e.y, 16, INK.crystal, 0.5, 0.008, 1.2);
    spray(e.x, e.y, 6, '#ffffff', 0.6, 0.005, 1.2);
    if (near(e.y)) sound.crack();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'erupt') {
    flash = 0.8;
    shake = Math.max(shake, 8);
    sound.erupt();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(e.a === me);
  } else if (e.kind === 'round') {
    for (const l of looks.values()) l.trail = [];
    camY = null;
  }
}

// A shaft wall's face at a height: the page's own wobble, for looks alone.
const wallAt = (y) => 0.022 + 0.011 * Math.sin(y * 23.1) + 0.007 * Math.sin(y * 57.7 + 1.3) + 0.004 * Math.sin(y * 131.9);

function drawShaft(lv) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.rockTop);
  g.addColorStop(1, INK.rockLow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // Strata in the rock behind, drifting past slower than the shaft: depth.
  ctx.strokeStyle = INK.strata;
  ctx.lineWidth = 2;
  const deep = camY * 0.45, gap = 0.21;
  for (let k = Math.floor((deep - 2) / gap); k <= Math.ceil((deep + 2) / gap); k++) {
    const y = midY - (k * gap - deep) * sc;
    if (y < -10 || y > VH + 10) continue;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= VW; x += 24) ctx.lineTo(x, y + Math.sin(x * 0.02 + k * 1.7) * 5);
    ctx.stroke();
  }
  // The lava lights the shaft from below.
  const ly = SY(lv);
  const glow = ctx.createLinearGradient(0, ly - sc * 0.9, 0, ly);
  glow.addColorStop(0, 'rgba(255,110,40,0)');
  glow.addColorStop(1, `rgba(255,110,40,${0.32 + 0.25 * burnGlow})`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, ly - sc * 0.9, VW, sc * 0.9);
}

function drawWalls() {
  flat();
  for (const side of [0, 1]) {
    ctx.beginPath();
    const edge = side ? VW + 2 : -2;
    ctx.moveTo(edge, -10);
    for (let py = -10; py <= VH + 16; py += 6) {
      const y = altAt(py);
      const inset = wallAt(y + side * 3.7);
      ctx.lineTo(side ? SX(W - inset + R * 0.4) : SX(inset - R * 0.4), py);
    }
    ctx.lineTo(edge, VH + 16);
    ctx.closePath();
    ctx.fillStyle = INK.wall;
    ctx.fill();
    ctx.strokeStyle = INK.wallEdge;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// A crystal: a glowing hexagon. One taking somebody's weight cracks as the
// steps run out, and shakes at the end.
function drawPeg(x, y, wear, open, now) {
  const px = SX(x), py = SY(y), s = Math.max(5, sc * 0.02);
  if (wear > 0.75) {
    const j = (wear - 0.75) * 10;
    ctx.translate(Math.sin(now / 23) * j, 0);
  }
  ctx.globalAlpha = open ? 1 : 0.35;
  const halo = ctx.createRadialGradient(px, py, 0, px, py, s * 2.6);
  halo.addColorStop(0, 'rgba(143,243,255,0.35)');
  halo.addColorStop(1, 'rgba(143,243,255,0)');
  ctx.fillStyle = halo;
  disc(px, py, s * 2.6);
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    ctx[i ? 'lineTo' : 'moveTo'](px + Math.cos(a) * s, py + Math.sin(a) * s * 1.15);
  }
  ctx.closePath();
  ctx.fillStyle = INK.crystalDark;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(px, py - s * 1.15);
  ctx.lineTo(px + s * 0.87, py - s * 0.57);
  ctx.lineTo(px, py);
  ctx.lineTo(px - s * 0.87, py - s * 0.57);
  ctx.closePath();
  ctx.fillStyle = INK.crystal;
  ctx.fill();
  if (wear > 0) {
    ctx.strokeStyle = wear > 0.75 ? '#ffffff' : 'rgba(20,30,40,0.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const n = 1 + Math.floor(wear * 4);
    for (let i = 0; i < n; i++) {
      const a = i * 2.1 + 0.4;
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a) * s * 0.6, py + Math.sin(a) * s * 0.6);
      ctx.lineTo(px + Math.cos(a + 0.4) * s, py + Math.sin(a + 0.4) * s);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  flat();
}

function drawGem(x, y, value, now) {
  const gold = value === GOLD;
  const bob = Math.sin(now / 300 + x * 9) * 0.006;
  const px = SX(x), py = SY(y + bob), s = Math.max(4, sc * (gold ? 0.024 : 0.017));
  const halo = ctx.createRadialGradient(px, py, 0, px, py, s * 2.4);
  halo.addColorStop(0, gold ? 'rgba(255,209,102,0.45)' : 'rgba(93,255,160,0.3)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  disc(px, py, s * 2.4);
  ctx.fill();
  ctx.fillStyle = gold ? '#c98a12' : INK.gemDark;
  ctx.beginPath();
  ctx.moveTo(px, py - s); ctx.lineTo(px + s * 0.8, py); ctx.lineTo(px, py + s * 1.1); ctx.lineTo(px - s * 0.8, py);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = gold ? INK.gold : INK.gem;
  ctx.beginPath();
  ctx.moveTo(px, py - s); ctx.lineTo(px + s * 0.8, py); ctx.lineTo(px, py + s * 0.25); ctx.lineTo(px - s * 0.8, py);
  ctx.closePath();
  ctx.fill();
  const tw = (Math.sin(now / 180 + x * 31) + 1) / 2;
  if (tw > 0.85) {
    ctx.fillStyle = '#ffffff';
    disc(px - s * 0.25, py - s * 0.4, 1.6);
    ctx.fill();
  }
}

function drawLava(lv, now, surge) {
  flat();
  const ly = SY(lv);
  if (ly > VH + 20) return;
  const g = ctx.createLinearGradient(0, ly - 6, 0, Math.max(ly + 10, VH));
  g.addColorStop(0, INK.lavaHi);
  g.addColorStop(0.12, INK.lava);
  g.addColorStop(1, INK.lavaLow);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, VH + 4);
  const amp = surge ? 1.7 : 1;
  for (let x = 0; x <= VW + 8; x += 8) {
    ctx.lineTo(x, ly + amp * (4 * Math.sin(x * 0.031 + now / 380) + 3 * Math.sin(x * 0.073 - now / 610)));
  }
  ctx.lineTo(VW, VH + 4);
  ctx.closePath();
  ctx.fill();
  // A crust of bright light along the top, and slow bubbles under it.
  ctx.strokeStyle = 'rgba(255,240,170,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= VW + 8; x += 8) {
    const y = ly + amp * (4 * Math.sin(x * 0.031 + now / 380) + 3 * Math.sin(x * 0.073 - now / 610));
    ctx[x ? 'lineTo' : 'moveTo'](x, y);
  }
  ctx.stroke();
  for (let i = 0; i < 9; i++) {
    const ph = (now / 1700 + i * 0.37) % 1;
    const x = ((i * 137.7) % VW + VW) % VW;
    const y = ly + 10 + (1 - ph) * 40;
    if (y > VH) continue;
    ctx.fillStyle = `rgba(255,220,120,${0.5 * (1 - ph)})`;
    disc(x, y, 2 + ph * 4);
    ctx.fill();
  }
}

function drawSmoke(lv, now) {
  flat();
  const sy = SY(lv + BAND);
  if (sy < -60) return;
  const g = ctx.createLinearGradient(0, sy + sc * 0.12, 0, sy - sc * 0.3);
  g.addColorStop(0, `rgba(${INK.smoke},0)`);
  g.addColorStop(1, `rgba(${INK.smoke},0.86)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, sy - sc * 0.3, VW, sc * 0.42);
  ctx.fillStyle = `rgba(${INK.smoke},0.86)`;
  if (sy - sc * 0.3 > 0) ctx.fillRect(0, 0, VW, sy - sc * 0.3);
  // Puffs along the edge of the smoke, drifting on the page's clock.
  for (let i = 0; i < 10; i++) {
    const x = ((i * 0.13 + now / 21000 * (i % 2 ? 1 : -1)) % 1 + 1) % 1;
    ctx.fillStyle = `rgba(${INK.smoke},0.5)`;
    ctx.beginPath();
    ctx.ellipse(x * VW, sy - sc * 0.05 + Math.sin(now / 900 + i) * 5, sc * 0.12, sc * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// A climber: a round body in the seat's colour with eyes that look the way it
// flies, squashed by whatever it hits, stars round it while stunned.
function drawClimber(id, x, y, vx, vy, d, colour, me, now, crowned) {
  const look = lookOf(id);
  if (now - look.trailAt > 30) {
    look.trailAt = now;
    look.trail.unshift([x, y]);
    if (look.trail.length > 9) look.trail.length = 9;
  }
  const tl = look.trail;
  for (let i = 1; i < tl.length; i++) {
    ctx.globalAlpha = 0.18 * (1 - i / tl.length);
    ctx.fillStyle = colour;
    disc(SX(tl[i][0]), SY(tl[i][1]), sc * R * (1 - i / (tl.length + 2)));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const px = SX(x), py = SY(y), r = sc * R;
  const sp = Math.sqrt(vx * vx + vy * vy);
  const sq = look.squash;
  const stretch = Math.min(0.25, sp * 0.06);
  const ang = Math.atan2(-vy, vx);
  ctx.save();
  if (d.fr > 0) ctx.globalAlpha = 0.6 + 0.4 * Math.abs(Math.sin(now / 70));
  ctx.translate(px, py);
  ctx.rotate(ang);
  ctx.scale(1 + stretch - sq * 0.2, 1 - stretch * 0.6 + sq * 0.25);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  disc(1.5, 2.5, r);
  ctx.fill();
  ctx.fillStyle = colour;
  disc(0, 0, r);
  ctx.fill();
  ctx.strokeStyle = me ? '#ffffff' : darker(colour, 0.45);
  ctx.lineWidth = me ? 2.2 : 1.4;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  if (d.fr > 0) ctx.globalAlpha = 0.6 + 0.4 * Math.abs(Math.sin(now / 70));
  ctx.fillStyle = lighter(colour, 0.5);
  disc(px - r * 0.3, py - r * 0.35, r * 0.32);
  ctx.fill();
  // Eyes, easing toward where it is going.
  const want = sp > 0.05 ? [vx / sp, -vy / sp] : [0, 0.3];
  look.eye[0] += (want[0] - look.eye[0]) * per60(0.2);
  look.eye[1] += (want[1] - look.eye[1]) * per60(0.2);
  const ex = look.eye[0] * r * 0.35, ey = look.eye[1] * r * 0.35;
  for (const s of [-1, 1]) {
    ctx.fillStyle = '#ffffff';
    disc(px + s * r * 0.36 + ex * 0.5, py - r * 0.08 + ey * 0.5, r * 0.27);
    ctx.fill();
    ctx.fillStyle = '#1a0d18';
    disc(px + s * r * 0.36 + ex, py - r * 0.08 + ey, r * 0.13);
    ctx.fill();
  }
  ctx.restore();
  if (d.sn > 0) {
    for (let i = 0; i < 3; i++) {
      const a = now / 160 + (i * Math.PI * 2) / 3;
      ctx.fillStyle = INK.gold;
      disc(px + Math.cos(a) * r * 1.4, py - r * 1.1 + Math.sin(a) * r * 0.4, 2.2);
      ctx.fill();
    }
  }
  if (crowned) drawCrown(px, py - r * 1.55, r, now);
}

function drawCrown(x, y, r, now) {
  const s = Math.max(5, r * 0.6), b = Math.sin(now / 250) * 1.5;
  ctx.fillStyle = INK.gold;
  ctx.strokeStyle = 'rgba(60,30,10,0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - s, y + b + s * 0.6);
  ctx.lineTo(x - s, y + b - s * 0.4);
  ctx.lineTo(x - s * 0.5, y + b);
  ctx.lineTo(x, y + b - s * 0.7);
  ctx.lineTo(x + s * 0.5, y + b);
  ctx.lineTo(x + s, y + b - s * 0.4);
  ctx.lineTo(x + s, y + b + s * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawRope(x0, y0, x1, y1, colour, me) {
  const ax = SX(x0), ay = SY(y0), bx = SX(x1), by = SY(y1);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = me ? 4 : 3;
  ctx.beginPath();
  ctx.moveTo(ax + 1, ay + 1.5);
  ctx.lineTo(bx + 1, by + 1.5);
  ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = me ? 2.4 : 1.7;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  // The hook's claws round the crystal.
  ctx.strokeStyle = '#d8d0e0';
  ctx.lineWidth = 1.6;
  const s = Math.max(4, sc * 0.014);
  ctx.beginPath();
  ctx.arc(ax, ay, s, Math.PI * 0.1, Math.PI * 0.9);
  ctx.stroke();
}

function drawBits() {
  flat();
  for (const e of embers) {
    const k = e.life / e.max;
    ctx.globalAlpha = (1 - k) * 0.8;
    ctx.fillStyle = k < 0.3 ? INK.lavaHi : INK.lava;
    const s = Math.max(1, sc * 0.004 * (1 - k * 0.6));
    ctx.fillRect(SX(e.x) - s / 2, SY(e.y) - s / 2, s, s);
  }
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - k) + 0.8;
    disc(SX(r.x), SY(r.y), r.r * sc * ease(k));
    ctx.stroke();
  }
  for (const b of bits) {
    ctx.globalAlpha = 1 - b.life / b.max;
    ctx.fillStyle = b.colour;
    const s = Math.max(1.5, b.size * sc);
    ctx.fillRect(SX(b.x) - s / 2, SY(b.y) - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const k = p.life / p.max;
    ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    const s = k < 0.15 ? 0.6 + (0.4 * k) / 0.15 : 1;
    const X = SX(p.x), Y = SY(p.y) - ease(Math.min(1, k * 1.4)) * p.lift;
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(20,8,16,0.65)';
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
  const bar = ctx.createLinearGradient(0, 0, 0, TOP + 4);
  bar.addColorStop(0, 'rgba(20,10,20,0.88)');
  bar.addColorStop(1, 'rgba(20,10,20,0)');
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, VW, TOP + 4);
  const titlePx = narrow ? 15 : 17;
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt);
    if (erupting(t)) {
      status += ' · eruption ×2';
      colour = Math.floor(now / 300) % 2 ? INK.gold : INK.danger;
    }
  } else status = 'round ' + t.rd + ' · over';
  text('grapple', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('grapple').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 120, 'left');
  text(wireNote(), VW - 50, 22, 9, INK.dim, 'right');

  // The scoreboard: one chip a climber, in its seat's colour, with its gems
  // and the rounds it has won.
  const ids = playersIn(t).sort((a, b) => t.p[a].k - t.p[b].k);
  if (ids.length) {
    const y = narrow ? 54 : 46;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, down = d.st !== 0;
      ctx.globalAlpha = down && t.ph === PLAY ? 0.55 : 1;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.16)' : 'rgba(10,4,12,0.45)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[d.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[d.k];
      disc(x + 11, y - 2, 5);
      ctx.fill();
      const score = String(d.sc) + (d.wn ? ' ★' + d.wn : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, INK.text, 'right');
      ctx.fillStyle = INK.gem;
      ctx.beginPath();
      const gx = x + cw - 14 - sw, gy = y - 2;
      ctx.moveTo(gx, gy - 5); ctx.lineTo(gx + 4, gy); ctx.lineTo(gx, gy + 5); ctx.lineTo(gx - 4, gy);
      ctx.closePath();
      ctx.fill();
      if (cw - 44 - sw > 14) fitText(mine ? 'you' : nickOf(id), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 44 - sw, 'left');
      ctx.globalAlpha = 1;
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'touch a crystal to grab it · lift to let go and fly · drag sideways to swing'
    : 'click a crystal or hold Space to grab · let go to fly · A/D swing · M mutes';
  ctx.fillStyle = 'rgba(20,10,20,0.6)';
  ctx.fillRect(0, VH - BOT + 4, VW, BOT);
  fitText(how, VW / 2, VH - 9, 12, INK.muted, VW - 20);
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

// Practice ends a moment after a second climber arrives: who it was, as this
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
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const me = myId();
  const cx = VW / 2, cy = TOP + (VH - TOP - BOT) * 0.36;
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'grab a crystal, let go at the top of the swing to fly · crystals crack if you hang on';
    // Beside the shaft when there is room there, else at the foot of the
    // screen over the line of controls.
    if (ox >= 230) practiceNote(now, ox, head, tip, [[TOP, VH - BOT]], VH - BOT, 0);
    else practiceNote(now, VW, head, tip, [], VH - BOT + 2);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    fitText('grab a crystal · let go at the top of a swing to fly', cx, cy + big * 2.2, 15, INK.text, VW - 40);
    fitText('slam a rival off their rope to steal a gem · the lava takes a third', cx, cy + big * 2.2 + 22, 13, INK.muted, VW - 40);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('climb!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= ERUPT && t.pt > ERUPT - HZ * 2) {
    const k = (ERUPT - t.pt) / (HZ * 2);
    ctx.globalAlpha = 1 - k;
    text('eruption!', cx, cy, big * 1.6, INK.danger, 'center');
    fitText('the lava surges · gems count double', cx, cy + big, 15, INK.text, VW - 40);
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 100 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 6, Math.min(VH - BOT - h / 2 - 6, cy + 30)) + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.win !== -1) { head = t.win === me ? 'you climbed richest!' : nickOf(t.win) + ' wins the climb'; hc = colourOf(t, t.win); }
    else head = 'a tie at the top';
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 34, 22, hc, w - 24);
    rows.forEach(([id, pts, won], i) => {
      const y = y0 + 64 + i * 22;
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (id === t.win ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 130, 'left');
      if (won) text('★' + won, cx + w / 2 - 56, y, 12, INK.gold, 'right');
      text(String(pts), cx + w / 2 - 22, y, 15, INK.text, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ) + ' · gems count, steals too', cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// A climber between two tables: one that has just been launched or burnt, or
// set out for a round, is drawn where the newer table has it rather than
// walked there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || q.st !== p.st || p.t < q.t) return [p.x, p.y, p.vx, p.vy];
  return [lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k), lerp(q.vx, p.vx, b.k), lerp(q.vy, p.vy, b.k)];
}
const lavaOf = (b) => (Math.abs(b.to.lv - b.from.lv) > 0.5 ? b.to.lv : lerp(b.from.lv, b.to.lv, b.k));

// Your own climber is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh, a launch — is taken at once.
let shown = null;
const SNAP = 0.15;
function settle(tx, ty, st) {
  if (!shown || shown[2] !== st || (tx - shown[0]) * (tx - shown[0]) + (ty - shown[1]) * (ty - shown[1]) > SNAP * SNAP) {
    return (shown = [tx, ty, st]);
  }
  const k = per60(0.45);
  shown[0] += (tx - shown[0]) * k;
  shown[1] += (ty - shown[1]) * k;
  return shown;
}

function marker(x, up, colour) {
  const px = Math.max(10, Math.min(VW - 10, SX(x))), py = up ? TOP + 10 : VH - BOT - 8;
  ctx.fillStyle = colour;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (up) { ctx.moveTo(px, py - 6); ctx.lineTo(px + 7, py + 5); ctx.lineTo(px - 7, py + 5); }
  else { ctx.moveTo(px, py + 6); ctx.lineTo(px + 7, py - 5); ctx.lineTo(px - 7, py - 5); }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

let myPos = null;      // [x, y, vx, vy]: where your climber is drawn
let hoverPeg = -1;     // the crystal under the mouse, lit up
function draw(now) {
  const b = agreedAt(now);
  if (!b) {
    if (camY === null) camY = 0.6;
    drawShaft(-0.5);
    drawWalls();
    drawLava(-0.5, now, false);
    myPos = shown = null;
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the shaft…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a shaft this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const me = myId();
  const lv = lavaOf(b);
  lavaSeen = lv;
  const ids = playersIn(t).sort((a, c) => t.p[a].k - t.p[c].k);

  // Where every climber is drawn: yours from the guess, the rest from the agreed shaft.
  const at = new Map();
  for (const id of ids) {
    if (id === me) continue;
    const pos = between(b, id);
    if (pos) at.set(id, pos);
  }
  const m = mineAt(now);
  const mine = m && m.to.p[me] ? m.to.p[me] : null;
  if (mine && mine.st === 0) {
    const pos = between(m, me);
    if (pos) {
      const s = settle(pos[0], pos[1], mine.st);
      at.set(me, [s[0], s[1], pos[2], pos[3]]);
    }
  }
  const dOf = (id) => (id === me && mine ? mine : t.p[id]);
  myPos = at.has(me) ? at.get(me) : null;
  if (!myPos) shown = null;

  // The camera rides with your climber — or with the highest one while you
  // are in the lava — and never shows much below the lava or above the smoke.
  let want = lv + 0.9;
  if (myPos) want = myPos[1] + 0.1;
  else {
    let top = -Infinity;
    for (const [, p] of at) top = Math.max(top, p[1]);
    if (top > -Infinity) want = Math.min(top, lv + 0.9);
  }
  const viewH = (VH - TOP - BOT) / sc;
  const lo = lv - 0.3 + viewH / 2, hi = lv + BAND + 0.35 - viewH / 2;
  want = lo > hi ? lo : Math.max(lo, Math.min(hi, want));
  if (camY === null || Math.abs(want - camY) > 2.5) camY = want;
  else camY += (want - camY) * per60(0.14);

  drawShaft(lv);
  flat();
  const yTop = altAt(-40), yBot = altAt(VH + 40);
  const wear = new Map();
  for (const id of ids) {
    const d = dOf(id);
    if (d.st === 0 && d.hk >= 0) wear.set(d.hk, Math.max(wear.get(d.hk) || 0, d.ht / HOLD));
  }
  const r0 = Math.max(-ROW_OFF, Math.floor(yBot / ROW) - 1), r1 = Math.ceil(yTop / ROW) + 1;
  for (let r = r0; r <= r1; r++) {
    const g = gemAt(t, r);
    if (g && g[1] > lv - 0.02 && !t.g.includes(gemId(r))) drawGem(g[0], g[1], g[2], now);
  }
  for (let r = r0; r <= r1; r++) {
    for (let j = 0; j < 2; j++) {
      const pid = pegId(r, j), p = pegAt(t, pid);
      if (!p || broken(t, pid) || p[1] < lv - 0.05) continue;
      drawPeg(p[0], p[1], wear.get(pid) || 0, pegOpen(t, p), now);
    }
  }
  drawSmoke(lv, now);
  drawWalls();

  // Your reach, faintly, and the crystal you are about to grab.
  if (myPos && t.ph !== COUNT) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    disc(SX(myPos[0]), SY(myPos[1]), REACH * sc);
    ctx.stroke();
    ctx.setLineDash([]);
    const aimAt = mine && mine.pw >= 0 ? mine.pw : hoverPeg;
    const p = aimAt >= 0 ? pegAt(t, aimAt) : null;
    if (p) {
      ctx.strokeStyle = mine.pw >= 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1.5;
      if (mine.pw >= 0) {
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(SX(myPos[0]), SY(myPos[1]));
        ctx.lineTo(SX(p[0]), SY(p[1]));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      disc(SX(p[0]), SY(p[1]), Math.max(9, sc * 0.034) + Math.sin(now / 120) * 1.5);
      ctx.stroke();
    }
  }
  // Ropes under every climber.
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos || d.st !== 0 || d.hk < 0) continue;
    const p = pegAt(t, d.hk);
    if (p) drawRope(p[0], p[1], pos[0], pos[1], SEAT[d.k], id === me);
  }
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos || d.st !== 0) continue;
    drawClimber(id, pos[0], pos[1], pos[2], pos[3], d, SEAT[d.k], id === me, now, t.ph === PLAY && leads(t, id));
  }
  // Names over the others, so a knock has somebody to be aimed at.
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos || d.st !== 0 || id === me) continue;
    fitText(nickOf(id), SX(pos[0]), SY(pos[1]) - sc * R - (t.ph === PLAY && leads(t, id) ? 16 : 6), 11, INK.muted, 90);
  }
  drawLava(lv, now, erupting(t));
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawBits();

  // Climbers out of sight, as arrows at the edge they are past.
  flat();
  for (const id of ids) {
    if (id === me) continue;
    const pos = at.get(id);
    if (!pos || t.p[id].st !== 0) continue;
    const py = SY(pos[1]);
    if (py < TOP + 4) marker(pos[0], true, SEAT[t.p[id].k]);
    else if (py > VH - BOT - 4) marker(pos[0], false, SEAT[t.p[id].k]);
  }

  // Close to the lava, or just hit: the edges of the screen glow.
  const low = myPos && t.ph !== COUNT && t.ph !== END ? Math.max(0, 1 - (myPos[1] - lv) / 0.45) : 0;
  const k = Math.max(flash, low * (0.6 + 0.3 * Math.sin(now / 90)), burnGlow * 0.8);
  if (k > 0.03) {
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    g.addColorStop(0, 'rgba(255,80,40,0)');
    g.addColorStop(1, `rgba(255,80,40,${0.38 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
  }
  const md = t.p[me];
  if (md && md.st === 1 && t.ph !== COUNT) {
    panel(VW / 2, TOP + (VH - TOP - BOT) * 0.45, Math.min(VW - 32, 240), 46);
    text('burnt · back in ' + Math.max(1, Math.ceil((BURNT - md.t) / HZ)), VW / 2, TOP + (VH - TOP - BOT) * 0.45 + 6, 16, INK.lavaHi, 'center');
  } else if (mine && mine.sn > 0 && t.ph !== COUNT) {
    fitText('stunned!', SX(myPos ? myPos[0] : 0.5), SY(myPos ? myPos[1] : lv) - sc * R - 10, 13, INK.gold, 100);
  } else if (mine && mine.hk >= 0 && mine.ht > HOLD * 0.7 && myPos) {
    fitText('it cracks!', SX(myPos[0]), SY(myPos[1]) + sc * R + 16, 12, '#ffffff', 100);
  }
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: [grab, crystal, lean]. A press counts the grab number on
// by one, so a hand said again is still the same press; letting go is the
// crystal -1. A press waits for a crystal in reach, and then for that crystal
// to come in reach; a change of lean goes out no oftener than TURN_EVERY,
// because a thumb sliding about changes it on every move the screen reports,
// and the clock's ticks share the same seat's ceiling on messages.
const TURN_EVERY = 110;
const RETRY_EVERY = 120;
let grabs = Math.floor(Math.random() * QMAX);   // a reloaded page must not repeat its last press number
let hold = -1;
let lean = 0;
let leanSaidAt = -1e9;
let grab = null;       // { kind: 'ptr' | 'key', id, code, ox, x, y, at, hooked }
let pointerAt = null;  // where the mouse is, for lighting up the crystal under it

function say() { setHand([grabs, hold, lean]); }
function press(pid) {
  grabs = (grabs + 1) % QMAX;
  hold = pid;
  say();
}
function letGoNow() {
  grab = null;
  if (hold !== -1) { hold = -1; say(); }
}

// This copy's own climber, as guessed a trip ahead, and the table it is in.
function mineNow() {
  const m = mineAt(performance.now());
  if (!m) return null;
  const d = m.to.p[myId()];
  return d && d.st === 0 ? { t: m.to, d } : null;
}

// The crystal in reach nearest to a point on the screen.
function pegForPoint(t, d, cx, cy) {
  const r = cv.getBoundingClientRect();
  const wx = (cx - r.left - ox) / sc, wy = altAt(cy - r.top);
  let best = -1, bd = Infinity;
  for (const [pid, px, py] of pegsNear(t, d.y, REACH)) {
    if (!pegOpen(t, [px, py])) continue;
    const dx = px - d.x, dy = py - d.y;
    if (dx * dx + dy * dy > REACH * REACH) continue;
    const ex = px - wx, ey = py - wy, e = ex * ex + ey * ey;
    if (e < bd) { bd = e; best = pid; }
  }
  return best;
}

const keys = new Set();
function leanNow() {
  const l = keys.has('ArrowLeft') || keys.has('KeyA'), r = keys.has('ArrowRight') || keys.has('KeyD');
  if (l !== r) return l ? 1 : 2;
  if (grab && grab.kind === 'ptr') {
    const dx = grab.x - grab.ox;
    if (dx > 22) return 2;
    if (dx < -22) return 1;
  }
  return 0;
}

function aim() {
  const m = mineNow();
  if (!m || !grab) return -1;
  if (grab.kind === 'key') {
    const l = leanNow();
    return bestPeg(m.t, m.d, l === 2 ? 1 : l === 1 ? -1 : m.d.vx > 0.2 ? 0.4 : m.d.vx < -0.2 ? -0.4 : 0, REACH);
  }
  return pegForPoint(m.t, m.d, grab.x, grab.y);
}

function startGrab(g) {
  grab = g;
  grab.at = performance.now();
  grab.hooked = false;
  const pid = aim();
  if (pid >= 0) press(pid);
}

// While a grab is held and has not caught yet, it keeps looking for a crystal
// in reach. Once it has caught, losing the crystal — knocked off, or the
// crystal broke — needs a new press.
function keepGrab(now) {
  if (!grab || now - grab.at < RETRY_EVERY) return;
  grab.at = now;
  const m = mineNow();
  if (!m) return;
  const d = m.d;
  if (hold >= 0 && d.hk === hold) { grab.hooked = true; return; }
  if (grab.hooked) return;
  const pid = aim();
  if (pid < 0) return;
  if (pid !== hold || d.pw !== hold) press(pid);
}

function keepLean(now) {
  const f = leanNow();
  if (f === lean || now - leanSaidAt < TURN_EVERY) return;
  lean = f;
  leanSaidAt = now;
  say();
}

// Keys are read by where they sit, not what they type, so every layout climbs.
const GRAB_KEYS = ['Space', 'KeyW', 'ArrowUp', 'KeyJ', 'KeyK'];
const LEAN_KEYS = ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'];
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (GRAB_KEYS.includes(e.code)) {
    e.preventDefault();
    coarse = false;
    if (!e.repeat && !grab) startGrab({ kind: 'key', code: e.code });
    return;
  }
  if (!LEAN_KEYS.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  keys.add(e.code);
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (grab && grab.kind === 'key' && grab.code === e.code) letGoNow();
});
addEventListener('blur', () => { keys.clear(); letGoNow(); });

// A finger or the mouse: press on a crystal to grab it, slide sideways to
// swing, lift to let go — a drag rather than a long press, because iOS keeps a
// long press inside a frame for itself.
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (grab && grab.kind === 'ptr') return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  if (grab) letGoNow();
  startGrab({ kind: 'ptr', id: e.pointerId, ox: e.clientX, x: e.clientX, y: e.clientY });
});
cv.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') pointerAt = [e.clientX, e.clientY];
  if (grab && grab.kind === 'ptr' && e.pointerId === grab.id) {
    grab.x = e.clientX;
    grab.y = e.clientY;
  }
});
cv.addEventListener('pointerleave', () => { pointerAt = null; });
function lift(e) {
  if (grab && grab.kind === 'ptr' && e.pointerId === grab.id) letGoNow();
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  keepGrab(now);
  keepLean(now);
  const m = pointerAt && !grab && !coarse ? mineNow() : null;
  hoverPeg = m ? pegForPoint(m.t, m.d, pointerAt[0], pointerAt[1]) : -1;
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Holding nothing is a hand too: it is
// how a climber arrives and is launched up.
function start() {
  say();
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
  const at = world
    ? stepClock !== null && tripMs !== null
      ? Math.max(world.n, Math.floor(stepNow(performance.now()) + tripMs / STEP_MS))
      : world.n + aheadSteps()
    : 0;
  unheard.push({ seq: inSeq, at: performance.now(), step: at, input: myHand, measured });
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
  const want = Math.min(GUESS_REACH, tripMs / STEP_MS);
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
  if (!world) return;
  if (!PREDICT || solo()) { guessPrev = guessLast = guessTable = null; return; }
  const reachNow = Math.max(aheadSteps(), STEPS_PER_TICK);
  const [before, t] = played(reachNow, STEPS_PER_TICK);
  guessPrev = { n: before.n, t: before };
  guessLast = { n: t.n, t };
  guessTable = t;
}

// The agreed table as drawn: { from, to, k }.
function agreedAt(now) {
  if (!agreed.length) return null;
  const at = stepNow(now) - SHOWN_BEHIND;
  let i = agreed.length - 1;
  while (i > 0 && agreed[i].n > at) i--;
  const a = agreed[i], b = agreed[i + 1] || a;
  const k = b === a ? 0 : Math.max(0, Math.min(1, (at - a.n) / (b.n - a.n)));
  return { from: a.t, to: b.t, k };
}

// This copy's own piece as drawn: { from, to, k } — the agreed table where
// there is no guess to draw it from.
function mineAt(now) {
  if (!guessLast) return agreedAt(now);
  const a = guessPrev || guessLast, b = guessLast;
  const at = stepNow(now) + Math.max(reach, STEPS_PER_TICK) - STEPS_PER_TICK;
  const k = b.n === a.n ? 1 : Math.max(0, Math.min(1, (at - a.n) / (b.n - a.n)));
  return { from: a.t, to: b.t, k };
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
