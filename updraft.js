/**
 * @disk     updraft
 * @author   claude
 * @version  3
 * @players  2-8
 * @about    Hot-air balloon brawl. You only steer by climbing or sinking into wind bands that blow different ways and keep turning. Land on a rival from above to pop them, shove them into the storm or the sea, and mind the sky closing in.
 * @tags     game, party, realtime, physics, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/updraft.png
 */
// updraft.js — balloon fighting where the room's order is the referee.
//
// Every copy holds the whole sky — every balloon, every wind band, the storm
// above and the sea below — and moves it only on what comes back round the
// room, so every copy applies the same hands in the same order and holds the
// same sky. Nobody sends where their balloon is, whom they popped or a score: a
// hand is "burn, vent or neither" and "lean left, right or neither", nothing
// else, and how hot an envelope runs, where the wind carries it and whose
// basket lands on whose envelope is the same arithmetic on the same numbers on
// every machine. A page with a console open can fly its own balloon however it
// likes, at a balloon's own pace, and no faster.
//
// While a pilot is alone in the sky, a trainer flies with them. It is part of
// the sky like any balloon, and its pilot is a function of the sky alone, so it
// flies the same on every copy and says nothing over the wire. When a second
// pilot arrives, practice runs on for three seconds under a note that says so,
// and the trainer leaves as the round's countdown starts: it never takes part
// in a round.
//
// Your own balloon does not wait for the trip: it is drawn from the agreed sky
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the sky a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own balloon a trip ahead, with your hand in it
const DT = 1 / HZ;

const W = 1.5;                 // the sky's width, wrapping round; its height is 1
const R = 0.04;                // an envelope's radius
const BY = 0.062;              // from an envelope's middle down to the top of its basket
const BH = 0.022;              // a basket's height
const BW = 0.022;              // and its width
const BK = 0.014;              // how far into an envelope a basket has to reach to tear it
const NB = 6;                  // wind bands, top to bottom
const WIND_LO = 0.1, WIND_HI = 0.3;
const WIND_EASE = 0.05;        // how fast a band turns to its new wind, a step
const TURN_GAP = 4 * HZ;       // steps between one band turning and the next, at the least
const TELL = 2 * HZ;           // steps a turn is shown before it comes
const GRIP = 0.05;             // how much of the gap to the wind a balloon closes in a step
const LEAN = 0.075;            // what leaning out of the basket adds to the wind
const HEAT_UP = 1.6;           // heat a burner adds, a second
const HEAT_DOWN = 0.28;        // heat an envelope loses on its own, a second
const VENT = 1.6;              // and with the vent pulled
const NEUTRAL = 0.45;          // the heat a balloon hangs still at
const LIFT = 1.1;              // how hard heat lifts
const VY_MAX = 0.3;
const FALL = 0.95;             // how hard a torn envelope falls
const BUMP_KICK = 0.12;        // the least two envelopes push each other apart at
const CREDIT = Math.round(1.6 * HZ);  // steps a shove counts for if the shoved hits the storm or the sea
const FRESH = Math.round(1.6 * HZ);   // a balloon just gone up can neither pop nor be popped
const DOWN = Math.round(2.2 * HZ);    // steps from a splash to the next balloon
const ER = 0.022;              // an ember's radius
const EMBER_GAP = Math.round(3.5 * HZ);
const EMBER_LIFE = 12 * HZ;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const POP_PTS = 3, BOUNTY_PTS = 2, SHOVE_PTS = 2, EMBER_PTS = 1;

const CEIL0 = 0, SEA0 = 1;     // where the storm and the sea stand while the sky is open
const CEIL1 = 0.24, SEA1 = 0.8; // and where they have closed in to by the horn

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second pilot arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 8 * HZ;
const SQUEEZE_FROM = 25 * HZ;  // steps into a round before the sky starts to close
const HOVER_Y = 0.48;          // where balloons hang through a countdown

// The sky. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every balloon is made by one function with its fields in one order.
//   top, bot: where the storm's underside and the sea stand
//   bw, bt: each band's wind and the wind it is turning to; tb: [band, wind]
//   about to turn, or null; tc: steps until the next turn
//   E: the ember as [x, y, steps left], or null; ew: steps until the next
//   ai: the trainer's [height it is heading for, steps until it picks another]
//   res: the last round's [id, points, rounds won] rows; win: its winner or -1
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, top: CEIL0, bot: SEA0, bw: [], bt: [], tb: null, tc: TURN_GAP,
    E: null, ew: EMBER_GAP, ai: null, p: {}, res: null, win: -1,
  };
  calm(w);
  return w;
}

// Winds that alternate from band to band, so there is always a way back.
function calm(w) {
  const flip = draw01(w) < 0.5 ? 1 : -1;
  w.bw = [];
  w.bt = [];
  for (let i = 0; i < NB; i++) {
    const v = (i % 2 ? 1 : -1) * flip * (WIND_LO + draw01(w) * (WIND_HI - WIND_LO));
    w.bw.push(v);
    w.bt.push(v);
  }
  w.tb = null;
  w.tc = TURN_GAP;
}

const FIELDS = ['x', 'y', 'vx', 'vy', 'h', 'v', 'l', 'st', 't', 'sc', 'wn', 'k', 'lt', 'lc', 'hs', 'hc'];
//   x, y, vx, vy: the envelope's middle and how it moves; h: heat, 0..1;
//   v: 0 neither, 1 burning, 2 venting; l: lean, -1, 0 or 1; st: 0 aloft, 1
//   torn and falling, 2 in the sea; t: steps in that state; sc: points this
//   round; wn: rounds won; k: seat, which is its colour; lt: who touched it
//   last, or -1; lc: steps since; hs, hc: hands this step.
function balloon(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const sorted = (w) => playersIn(w).sort((a, b) => a - b);
const aloft = (d) => d.st === 0;
const armed = (d) => d.st === 0 && d.t >= FRESH;

const wrapX = (x) => {
  const m = x % W;
  return m < 0 ? m + W : m;
};
// The shortest way from a to b round a sky that wraps.
const dX = (a, b) => {
  let d = b - a;
  if (d > W / 2) d -= W;
  else if (d < -W / 2) d += W;
  return d;
};

// The wind at a height: each band blows evenly through its middle and hands
// over to the next across a narrow seam, so a band is a lane and not a slope.
function windAt(w, y) {
  const f = y * NB - 0.5;
  if (f <= 0) return w.bw[0];
  if (f >= NB - 1) return w.bw[NB - 1];
  const i = Math.floor(f);
  let k = (f - i - 0.35) / 0.3;
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  return w.bw[i] + (w.bw[i + 1] - w.bw[i]) * k;
}

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// A fresh balloon comes down out of the storm wherever is furthest from every
// balloon already aloft: high, which is where the fighting is won from.
function openSpot(w, self) {
  const others = [];
  for (const id of sorted(w)) {
    const d = w.p[id];
    if (d !== self && aloft(d)) others.push(d.x);
  }
  if (!others.length) return draw01(w) * W;
  let best = 0, far = -1;
  for (let i = 0; i < 30; i++) {
    const x = (W * i) / 30;
    let near = Infinity;
    for (const o of others) near = Math.min(near, Math.abs(dX(o, x)));
    if (near > far + 1e-9) { far = near; best = x; }
  }
  return best;
}

function rise(w, id, d) {
  d.x = openSpot(w, d);
  d.y = w.top + R + 0.05;
  d.vx = 0;
  d.vy = 0.04;
  d.h = NEUTRAL;
  d.st = 0;
  d.t = 0;
  d.lt = -1;
  d.lc = 0;
  fx(w, 'rise', d.x, d.y, id);
}

// A hand, at its place in the room's order: one integer, 0..8 — what the
// burner does plus three times which way the pilot leans. Being heard is how a
// pilot arrives, and a balloon comes down out of the storm for them.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = w.p[id] = balloon({
      x: 0, y: 0, vx: 0, vy: 0, h: NEUTRAL, v: 0, l: 0, st: 0, t: 0, sc: 0, wn: 0, k: freeSeat(w),
      lt: -1, lc: 0, hs: w.n, hc: 0,
    });
    if (w.ph === COUNT) {
      d.x = openSpot(w, d);
      d.y = HOVER_Y;
    } else rise(w, id, d);
  }
  // A flood of hands in one step is cut off where no pilot's thumb could
  // reach, on every copy alike; the ones that are heard only ever steer.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.v = input % 3;
  const lean = (input - d.v) / 3;
  d.l = lean === 1 ? -1 : lean === 2 ? 1 : 0;
}

// A hand off the wire, made safe: one integer in its range, or nothing.
function inputOf(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw <= 8 ? raw : null;
}

function leave(w, id) {
  delete w.p[id];
  for (const o of Object.values(w.p)) if (o.lt === id) o.lt = -1;
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
}

// A round: the balloons spread evenly across the sky in seat order, every one
// hanging at the same height, the points wiped and the winds made anew.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.top = CEIL0;
  w.bot = SEA0;
  w.E = null;
  w.ew = EMBER_GAP;
  calm(w);
  const ids = sorted(w).sort((a, b) => w.p[a].k - w.p[b].k);
  ids.forEach((id, i) => {
    const d = w.p[id];
    d.x = (W * (i + 0.5)) / ids.length;
    d.y = HOVER_Y;
    d.vx = d.vy = 0;
    d.h = NEUTRAL;
    d.st = 0;
    d.t = FRESH;
    d.sc = 0;
    d.lt = -1;
    d.lc = 0;
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
  w.E = null;
  fx(w, 'end', 0, 0, w.win);
}

// Whether a pilot stands alone at the top of the points: popping them pays a
// bounty, so a runaway leader is everybody's target.
function leads(w, id) {
  const sc = w.p[id].sc;
  if (sc <= 0) return false;
  for (const o of playersIn(w)) if (o !== id && w.p[o].sc >= sc) return false;
  return true;
}

// The storm and the sea close in through a round, slowly, and draw back
// between rounds.
function closeIn(w) {
  if (w.ph === PLAY) {
    const g = Math.max(0, Math.min(1, (PLAY_STEPS - w.pt - SQUEEZE_FROM) / (PLAY_STEPS - SQUEEZE_FROM)));
    w.top = CEIL0 + (CEIL1 - CEIL0) * g;
    w.bot = SEA0 - (SEA0 - SEA1) * g;
  } else {
    w.top = Math.max(CEIL0, w.top - 0.004);
    w.bot = Math.min(SEA0, w.bot + 0.004);
  }
}

// One band at a time turns: it is shown first, for TELL steps, so a pilot can
// climb into it or out of it before it comes.
function winds(w) {
  w.tc -= 1;
  if (w.tc === TELL) {
    const i = Math.floor(draw01(w) * NB);
    const now = w.bt[i];
    const flip = draw01(w) < 0.7 ? -1 : 1;
    const sign = now === 0 ? 1 : now > 0 ? flip : -flip;
    w.tb = [i, sign * (WIND_LO + draw01(w) * (WIND_HI - WIND_LO))];
  } else if (w.tc <= 0) {
    if (w.tb) {
      w.bt[w.tb[0]] = w.tb[1];
      fx(w, 'turn', 0, 0, w.tb[0]);
    }
    w.tb = null;
    w.tc = TURN_GAP + Math.floor(draw01(w) * 2 * HZ);
  }
  for (let i = 0; i < NB; i++) w.bw[i] += (w.bt[i] - w.bw[i]) * WIND_EASE;
}

// Whoever shoved a balloon into the storm or the sea in the last moments is
// paid for it, as long as they are still in the sky.
function credit(w, id, d) {
  if (d.lt === -1 || d.lt === id || d.lc > CREDIT || !w.p[d.lt] || w.ph !== PLAY) return [-1, 0];
  const pts = SHOVE_PTS + (leads(w, id) ? BOUNTY_PTS : 0);
  w.p[d.lt].sc += pts;
  return [d.lt, pts];
}

function tear(w, id, d) {
  d.st = 1;
  d.t = 0;
  d.h = 0;
  d.vy = Math.max(d.vy, 0.05);
}

// One balloon through one step: its burner and its vent, the wind at its
// height, its lean, and the storm and the sea.
function fly(w, id, d, hazards) {
  if (d.t < 100000) d.t += 1;
  if (d.lc < 100000) d.lc += 1;
  if (d.st === 2) {
    if (d.t >= DOWN && w.ph !== END && w.ph !== COUNT) rise(w, id, d);
    return;
  }
  if (d.st === 1) {
    // Torn: it drops, and the wind still has it.
    d.vy = Math.min(0.9, d.vy + FALL * DT);
    d.vx += (windAt(w, d.y) * 0.5 - d.vx) * GRIP;
    d.vx = Math.max(-1, Math.min(1, d.vx));
    d.x = wrapX(d.x + d.vx * DT);
    d.y += d.vy * DT;
    if (d.y + BY > w.bot) {
      fx(w, 'splash', d.x, w.bot, id, -1, 0);
      d.st = 2;
      d.t = 0;
    }
    return;
  }
  if (d.v === 1) d.h = Math.min(1, d.h + HEAT_UP * DT);
  else if (d.v === 2) d.h = Math.max(0, d.h - VENT * DT);
  else d.h = Math.max(0, d.h - HEAT_DOWN * DT);
  d.vy = (d.vy + (NEUTRAL - d.h) * LIFT * DT) * 0.97;
  if (d.vy > VY_MAX) d.vy = VY_MAX;
  if (d.vy < -VY_MAX) d.vy = -VY_MAX;
  d.vx += (windAt(w, d.y) + d.l * LEAN - d.vx) * GRIP;
  d.vx = Math.max(-1, Math.min(1, d.vx));
  d.x = wrapX(d.x + d.vx * DT);
  d.y += d.vy * DT;
  // A fresh balloon is out of reach of everything for a moment, the storm it
  // came out of included.
  if (!hazards || d.t < FRESH) {
    if (d.y - R < w.top) { d.y = w.top + R; if (d.vy < 0) d.vy = 0; }
    if (d.y + BY + BH > w.bot) { d.y = w.bot - BY - BH; if (d.vy > 0) d.vy = 0; }
    return;
  }
  if (d.y - R < w.top) {
    const [by, pts] = credit(w, id, d);
    fx(w, 'zap', d.x, w.top, id, by, pts);
    d.y = w.top + R;
    tear(w, id, d);
  } else if (d.y + BY + BH > w.bot) {
    const [by, pts] = credit(w, id, d);
    fx(w, 'splash', d.x, w.bot, id, by, pts);
    d.y = w.bot - BY - BH;
    d.st = 2;
    d.t = 0;
    d.vx = d.vy = 0;
  }
}

// Balloons that meet: a basket that comes down on an envelope tears it, and
// two envelopes side by side push each other apart. Every pair is weighed
// first and the tears applied after, so the order balloons are looked at in
// never decides who popped whom.
function meet(w, ids) {
  const torn = [];
  for (let i = 0; i < ids.length; i++) {
    const A = w.p[ids[i]];
    if (!armed(A)) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const B = w.p[ids[j]];
      if (!armed(B)) continue;
      const dx = dX(A.x, B.x), dy = B.y - A.y;
      if (dx > 3 * R || dx < -3 * R || dy > 3 * R || dy < -3 * R) continue;
      // A's basket on B's envelope, or B's on A's.
      const reach = (R + BK) * (R + BK);
      const ay = dy - (BY + BH / 2), by = -dy - (BY + BH / 2);
      if (dy > R * 0.5 && dx * dx + ay * ay < reach) { torn.push([ids[j], ids[i]]); continue; }
      if (-dy > R * 0.5 && dx * dx + by * by < reach) { torn.push([ids[i], ids[j]]); continue; }
      const dd = dx * dx + dy * dy, near = 2 * R * 0.95;
      if (dd >= near * near) continue;
      const dist = Math.sqrt(dd);
      const nx = dist > 1e-9 ? dx / dist : 1, ny = dist > 1e-9 ? dy / dist : 0;
      const over = (near - dist) / 2;
      A.x = wrapX(A.x - nx * over); A.y -= ny * over;
      B.x = wrapX(B.x + nx * over); B.y += ny * over;
      const closing = (A.vx - B.vx) * nx + (A.vy - B.vy) * ny;
      const push = Math.max(BUMP_KICK, closing) / 2;
      A.vx -= nx * push * 2; A.vy -= ny * push;
      B.vx += nx * push * 2; B.vy += ny * push;
      A.lt = ids[j]; A.lc = 0;
      B.lt = ids[i]; B.lc = 0;
      if (closing > 0.04) fx(w, 'bump', A.x + dX(A.x, B.x) / 2, (A.y + B.y) / 2, ids[i], ids[j]);
    }
  }
  for (const [victim, by] of torn) {
    const d = w.p[victim], p = w.p[by];
    if (!aloft(d)) continue;
    const pts = w.ph === PLAY ? POP_PTS + (leads(w, victim) ? BOUNTY_PTS : 0) : 0;
    p.sc += pts;
    // The basket that came down bounces off the envelope it tore.
    p.vy = Math.min(p.vy, -0.16);
    fx(w, 'pop', d.x, d.y - R * 0.3, victim, by, pts);
    tear(w, victim, d);
  }
}

// One ember at a time drifts on the wind. Whichever balloon reaches it first
// takes a point.
function ember(w, ids) {
  if (w.ph !== PLAY && w.ph !== WAIT) return;
  if (!w.E) {
    w.ew -= 1;
    if (w.ew <= 0) {
      const lo = w.top + 0.12, hi = w.bot - 0.16;
      w.E = [draw01(w) * W, lo + draw01(w) * Math.max(0, hi - lo), EMBER_LIFE];
    }
    return;
  }
  const E = w.E;
  E[0] = wrapX(E[0] + windAt(w, E[1]) * 0.5 * DT);
  E[1] = Math.max(w.top + 0.06, Math.min(w.bot - 0.1, E[1]));
  E[2] -= 1;
  if (E[2] <= 0) {
    w.E = null;
    w.ew = EMBER_GAP;
    return;
  }
  let best = -1, near = Infinity;
  for (const id of ids) {
    const d = w.p[id];
    if (!aloft(d)) continue;
    const dx = dX(d.x, E[0]);
    // The envelope or the basket.
    const e1 = dx * dx + (E[1] - d.y) * (E[1] - d.y);
    const e2 = dx * dx + (E[1] - d.y - BY - BH / 2) * (E[1] - d.y - BY - BH / 2);
    if (e1 < (R + ER) * (R + ER) && e1 < near) { near = e1; best = id; }
    if (e2 < (BW + ER) * (BW + ER) && e2 < near) { near = e2; best = id; }
  }
  if (best === -1) return;
  const pts = w.ph === PLAY ? EMBER_PTS : 0;
  w.p[best].sc += pts;
  fx(w, 'ember', E[0], E[1], best, pts);
  w.E = null;
  w.ew = EMBER_GAP;
}

// ── the trainer ────────────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const TRAINER = -100;
const BOT_EVERY = 4;           // steps between the trainer's decisions: slow enough to be beaten
const humans = (w) => playersIn(w).filter((id) => id !== TRAINER).length;

// The trainer flies while the sky is waiting for a round, and goes the moment a
// round's countdown starts.
function trainer(w) {
  const want = w.ph === WAIT && humans(w) >= 1;
  if (want && !w.p[TRAINER] && Object.keys(w.p).length < MAX_P) {
    const d = (w.p[TRAINER] = balloon({
      x: 0, y: 0, vx: 0, vy: 0, h: NEUTRAL, v: 0, l: 0, st: 0, t: 0, sc: 0, wn: 0, k: freeSeat(w),
      lt: -1, lc: 0, hs: 0, hc: 0,
    }));
    w.ai = [0.5, 0];
    rise(w, TRAINER, d);
  } else if (!want && w.p[TRAINER]) dismiss(w);
}

function dismiss(w) {
  const d = w.p[TRAINER];
  if (!d) return;
  if (aloft(d)) fx(w, 'away', d.x, d.y, TRAINER);
  leave(w, TRAINER);
  w.ai = null;
}

// The trainer's pilot: it rides the band that carries it toward you, drops on
// you when it is above you, and sinks out of the way when you are above it.
// It holds a height the way a person would, by the speed it is climbing or
// sinking at, and only decides every few steps.
function pilot(w) {
  const d = w.p[TRAINER];
  if (!d || !w.ai || w.n % BOT_EVERY) return;
  let you = null;
  for (const id of sorted(w)) if (id !== TRAINER) you = w.p[id];
  const ai = w.ai;
  ai[1] -= BOT_EVERY;
  let target = ai[0], lean = 0;
  if (you && aloft(you) && aloft(d)) {
    const dx = dX(d.x, you.x), side = dx < 0 ? -1 : 1;
    if (Math.abs(dx) < 0.14 && you.y > d.y + R) {
      // Above you: come down on your envelope.
      target = you.y - BY - BH;
      lean = side;
    } else if (Math.abs(dx) < 0.16 && you.y < d.y - R) {
      // Under you: get out of the way, down and aside.
      target = d.y + 0.18;
      lean = -side;
    } else if (ai[1] <= 0 || (windAt(w, ai[0]) < 0 ? -1 : 1) !== side) {
      // Otherwise ride a band whose wind blows toward you, the one nearest to a
      // little above you — now and then any of them, so it can be outguessed.
      let best = -1, far = Infinity;
      const aim = you.y - 0.14, any = draw01(w) < 0.25;
      for (let i = 0; i < NB; i++) {
        if ((w.bw[i] < 0 ? -1 : 1) !== side) continue;
        const gap = any ? draw01(w) : Math.abs((i + 0.5) / NB - aim);
        if (gap < far) { far = gap; best = i; }
      }
      ai[0] = Math.max(0, Math.min(1, best === -1 ? aim : (best + 0.5) / NB));
      ai[1] = Math.round((2.5 + draw01(w) * 3) * HZ);
      target = ai[0];
    }
  }
  target = Math.max(w.top + R + 0.1, Math.min(w.bot - BY - BH - 0.12, target));
  const wantVy = Math.max(-0.22, Math.min(0.22, (target - d.y) * 1.5));
  d.v = d.vy > wantVy + 0.03 ? 1 : d.vy < wantVy - 0.05 ? 2 : 0;
  d.l = lean;
}

// One step of the sky: a function of the sky alone.
function step(w) {
  trainer(w);
  const many = humans(w);
  if (w.ph === WAIT) {
    // A second pilot ends practice, three seconds on: the count runs in pt,
    // which a waiting sky otherwise leaves at zero. The trainer goes first, so
    // the round spreads the balloons without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { dismiss(w); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === PLAY_STEPS - SQUEEZE_FROM) fx(w, 'squeeze');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  const ids = sorted(w);
  if (w.ph === COUNT) {
    for (const id of ids) {
      const d = w.p[id];
      d.vx = d.vy = 0;
      d.h = NEUTRAL;
      if (d.st !== 0) { d.st = 0; d.y = HOVER_Y; }
    }
    return;
  }
  closeIn(w);
  winds(w);
  pilot(w);
  const hazards = w.ph === PLAY || w.ph === WAIT;
  for (const id of ids) fly(w, id, w.p[id], hazards);
  if (hazards) meet(w, ids);
  ember(w, ids);
}

// A sky handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!num(raw.top, CEIL0, CEIL1 + 0.01) || !num(raw.bot, SEA1 - 0.01, SEA0) || !int(raw.tc, -BIG, BIG)) return null;
  const winds = (a) => Array.isArray(a) && a.length === NB && a.every((v) => num(v, -WIND_HI, WIND_HI));
  if (!winds(raw.bw) || !winds(raw.bt)) return null;
  let tb = null;
  if (raw.tb !== null) {
    if (!Array.isArray(raw.tb) || raw.tb.length !== 2 || !int(raw.tb[0], 0, NB - 1) || !num(raw.tb[1], -WIND_HI, WIND_HI)) return null;
    tb = [raw.tb[0], raw.tb[1]];
  }
  let E = null;
  if (raw.E !== null) {
    if (!Array.isArray(raw.E) || raw.E.length !== 3) return null;
    if (!num(raw.E[0], 0, W) || !num(raw.E[1], 0, 1) || !int(raw.E[2], 0, EMBER_LIFE)) return null;
    E = [raw.E[0], raw.E[1], raw.E[2]];
  }
  if (!int(raw.ew, -BIG, BIG)) return null;
  let ai = null;
  if (raw.ai !== null) {
    if (!Array.isArray(raw.ai) || raw.ai.length !== 2 || !num(raw.ai[0], 0, 1) || !int(raw.ai[1], -BIG, BIG)) return null;
    ai = [raw.ai[0], raw.ai[1]];
  }
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!num(d.x, 0, W) || !num(d.y, -1, 2) || !num(d.vx, -5, 5) || !num(d.vy, -5, 5) || !num(d.h, 0, 1)) return null;
    if (!int(d.v, 0, 2) || !int(d.l, -1, 1) || !int(d.st, 0, 2) || !int(d.t, 0, BIG)) return null;
    if (!int(d.sc, 0, 99999) || !int(d.wn, 0, 99999) || !int(d.k, 0, MAX_P - 1) || seats.has(d.k)) return null;
    if (!int(d.lt, -BIG, BIG) || !int(d.lc, 0, BIG) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    seats.add(d.k);
    p[id] = balloon(d);
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
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, top: raw.top, bot: raw.bot, bw: raw.bw.slice(),
    bt: raw.bt.slice(), tb, tc: raw.tc, E, ew: raw.ew, ai, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed sky steps, and kept with the step that made them
// until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a bright afternoon sky between a slate storm above and a teal
// sea below, and a bright colour for each seat that is its envelope's, its
// basket's band and its chip's on the scoreboard.
const INK = {
  skyTop: '#4f7fb8', skyMid: '#8ec5e6', skyLow: '#ffe1bd', storm: '#3a3f5c', stormDeep: '#262a40',
  sea: '#1f8a93', seaDeep: '#0f4f5c', foam: '#d9fbff', wicker: '#9a6a3c', wickerDark: '#6b4524',
  text: '#ffffff', ink: '#16233a', muted: '#e3eefb', dim: '#b9c9dd', gold: '#ffd166', danger: '#ff5a6e',
  panel: 'rgba(18,28,52,0.9)', flame: '#ffb347', ember: '#ff8a3d', bolt: '#fff6b0',
};
const SEAT = ['#ff5d73', '#3ec1d3', '#ffd23f', '#7bd389', '#b98cff', '#ff9f43', '#5b8cff', '#f2f2f2'];
const FONT = "700 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.skyMid};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #5c6788;' +
  `background:#2c3350;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, sc = 1, ox = 0, oy = 0, TOP = 58, BOT = 24, dpx = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 66 : 58;
  BOT = 24;
  const aw = VW - 12, ah = Math.max(40, VH - TOP - BOT);
  sc = Math.max(10, Math.min(aw / W, ah));
  ox = (VW - W * sc) / 2;
  oy = TOP + (ah - sc) / 2;
}
layout();
window.addEventListener('resize', layout);

const SX = (x) => ox + x * sc;
const SY = (y) => oy + y * sc;
function inField() {
  ctx.setTransform(dpx, 0, 0, dpx, 0, 0);
  ctx.translate(ox + shakeX, oy + shakeY);
  ctx.scale(sc, sc);
}
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

function nickOf(id) {
  if (id === TRAINER) return 'trainer';
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
  burn() { if (ready('burn', 140)) { puff(0.32, 0.12, 520, 0, 0.6); puff(0.25, 0.05, 1800, 0.02, 0.8); } },
  vent() { if (ready('vent', 160)) puff(0.22, 0.06, 2600, 0, 1.5); },
  pop(mine) {
    if (!ready('pop', 70)) return;
    puff(0.08, mine ? 0.35 : 0.22, 1500, 0, 0.7);
    tone(mine ? 260 : 420, 0.22, 'triangle', mine ? 0.14 : 0.08, 0.35);
  },
  score() { if (ready('score', 80)) { tone(660, 0.1, 'triangle', 0.12); tone(990, 0.2, 'triangle', 0.1, 0, 0.08); } },
  bump() { if (ready('bump', 90)) { tone(150, 0.12, 'sine', 0.12, 0.7); puff(0.06, 0.05, 700, 0, 1); } },
  zap() {
    if (!ready('zap', 120)) return;
    tone(1800, 0.18, 'sawtooth', 0.05, 0.2);
    puff(0.3, 0.16, 300, 0.02, 0.6);
  },
  splash() { if (ready('splash', 120)) { puff(0.4, 0.16, 900, 0, 0.5); puff(0.25, 0.08, 2600, 0.05, 1); } },
  chime() {
    if (!ready('chime', 120)) return;
    [784, 988, 1175].forEach((f, i) => tone(f, 0.25, 'sine', 0.07, 0, i * 0.05));
  },
  turn() { if (ready('turn', 400)) { puff(0.6, 0.05, 400, 0, 0.4); tone(220, 0.5, 'sine', 0.03, 1.4); } },
  rumble() {
    if (!ready('rumble', 800)) return;
    tone(60, 1.3, 'sawtooth', 0.05, 0.8);
    puff(1.3, 0.1, 160, 0, 0.5);
  },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(700, 0.12, 'sine', 0.12, 2.0); tone(1400, 0.25, 'sine', 0.08, 1.0, 0.12); } },
  rise() { if (ready('rise', 200)) tone(330, 0.3, 'sine', 0.05, 1.6); },
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
// fast screen and a slow one see the same spray.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, fall } in sky units
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r }
const bolts = [];     // { x, life, max }: lightning, where the storm struck
let shakeX = 0, shakeY = 0, shake = 0, flash = 0, flashColour = '255,90,110';
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, fall) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (fall ? speed * 0.6 : 0), life: 0,
      max: 18 + Math.random() * 22, size, colour, fall: fall || 0 });
  }
  if (bits.length > 500) bits.splice(0, bits.length - 500);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 16, lift: lift || 18 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.93; b.vy = b.vy * 0.93 + b.fall / BIT_HZ;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    for (let i = bolts.length - 1; i >= 0; i--) if (++bolts[i].life >= bolts[i].max) bolts.splice(i, 1);
    for (const look of looks.values()) { look.squash *= 0.86; look.wob *= 0.95; }
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.9;
    driftStreaks();
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// The wind made visible: streaks that ride each band at its own speed, on the
// page's clock. They are drawn from the agreed winds and are no part of the game.
const streaks = [];
for (let i = 0; i < 54; i++) {
  streaks.push({ x: Math.random() * W, b: i % NB, dy: (Math.random() - 0.5) * 0.12, len: 0.03 + Math.random() * 0.06 });
}
let streakWinds = new Array(NB).fill(0);
function driftStreaks() {
  for (const s of streaks) s.x = wrapX(s.x + (streakWinds[s.b] * 1.6) / BIT_HZ);
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, wob, seen, tilt, v }
let drawFailed = false;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, wob: 0, seen: 0, tilt: 0, v: 0 }));
  l.seen = performance.now();
  return l;
}
const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].k] : '#dddddd');

function play(e, t) {
  const me = myId();
  if (e.kind === 'pop') {
    const mine = e.a === me, mineBy = e.b === me;
    spray(e.x, e.y, 26, colourOf(t, e.a), 0.55, 0.009, 0.5);
    spray(e.x, e.y, 10, '#ffffff', 0.7, 0.006);
    ring(e.x, e.y, '#ffffff', 0.1);
    lookOf(e.b).squash = 1;
    if (mine) { shake = Math.max(shake, 10); flash = 1; flashColour = '255,90,110'; pop(e.x, e.y, 'popped!', INK.danger, 22, 30); }
    if (mineBy && !e.c) { pop(e.x, e.y - 0.06, 'pop!', INK.gold, 22, 40); shake = Math.max(shake, 5); sound.score(); }
    if (e.c) {
      const who = mineBy ? '+' + e.c : '+' + e.c + ' ' + nickOf(e.b);
      pop(e.x, e.y - 0.06, who, colourOf(t, e.b), mineBy ? 24 : 15, 40);
      if (mineBy) { shake = Math.max(shake, 5); sound.score(); }
    }
    sound.pop(mine || mineBy);
  } else if (e.kind === 'zap') {
    bolts.push({ x: e.x, life: 0, max: 14 });
    spray(e.x, e.y + R, 18, INK.bolt, 0.6, 0.007, 0.4);
    spray(e.x, e.y + R, 12, colourOf(t, e.a), 0.4, 0.008, 0.6);
    lookOf(e.a).squash = 1;
    if (e.a === me) { shake = Math.max(shake, 9); flash = 1; flashColour = '255,246,176'; pop(e.x, e.y + 0.08, 'struck!', INK.bolt, 20, 26); }
    if (e.b !== -1 && e.c) {
      const mineBy = e.b === me;
      pop(e.x, e.y + 0.02, mineBy ? '+' + e.c + ' shove' : '+' + e.c + ' ' + nickOf(e.b), colourOf(t, e.b), mineBy ? 20 : 14, 20);
      if (mineBy) sound.score();
    }
    sound.zap();
  } else if (e.kind === 'splash') {
    spray(e.x, e.y, 22, INK.foam, 0.5, 0.008, 1.3);
    spray(e.x, e.y, 8, colourOf(t, e.a), 0.35, 0.007, 1.2);
    ring(e.x, e.y, INK.foam, 0.08);
    if (e.a === me) { shake = Math.max(shake, 6); pop(e.x, e.y - 0.08, 'splash!', INK.foam, 18, 26); }
    if (e.b !== -1 && e.c) {
      const mineBy = e.b === me;
      pop(e.x, e.y - 0.12, mineBy ? '+' + e.c + ' shove' : '+' + e.c + ' ' + nickOf(e.b), colourOf(t, e.b), mineBy ? 20 : 14, 24);
      if (mineBy) sound.score();
    }
    sound.splash();
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 6, '#ffffff', 0.25, 0.005);
    lookOf(e.a).wob = 1;
    lookOf(e.b).wob = 1;
    if (e.a === me || e.b === me) { shake = Math.max(shake, 3); sound.bump(); }
  } else if (e.kind === 'ember') {
    spray(e.x, e.y, 20, INK.ember, 0.5, 0.008);
    spray(e.x, e.y, 10, INK.gold, 0.3, 0.005);
    ring(e.x, e.y, INK.gold, 0.08);
    const mine = e.a === me;
    if (e.b) pop(e.x, e.y, '+' + e.b + (mine ? '' : ' ' + nickOf(e.a)), mine ? INK.gold : colourOf(t, e.a), mine ? 20 : 13, 26);
    if (mine) sound.chime(); else sound.score();
  } else if (e.kind === 'away') {
    spray(e.x, e.y, 16, colourOf(t, e.a), 0.4, 0.008);
    ring(e.x, e.y, '#ffffff', 0.08);
    pop(e.x, e.y - 0.05, 'trainer leaves', INK.text, 13, 30);
  } else if (e.kind === 'rise') {
    if (e.a === me) sound.rise();
  } else if (e.kind === 'turn') {
    sound.turn();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'squeeze') {
    shake = Math.max(shake, 4);
    sound.rumble();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(e.a === me);
  }
}

// The sky: an afternoon gradient, soft clouds far behind on the page's clock,
// the wind bands with their streaks and arrows, the storm overhead and the sea.
const clouds = [];
for (let i = 0; i < 6; i++) clouds.push([Math.random(), 0.15 + Math.random() * 0.6, 0.6 + Math.random() * 0.9, 0.006 + Math.random() * 0.01]);

function drawSky(t, now) {
  flat();
  const g = ctx.createLinearGradient(0, SY(0), 0, SY(1));
  g.addColorStop(0, INK.skyTop);
  g.addColorStop(0.55, INK.skyMid);
  g.addColorStop(1, INK.skyLow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  const tt = now / 1000;
  for (const c of clouds) {
    const span = W + 0.6;
    const u = (((c[0] * span + tt * c[3]) % span) + span) % span - 0.3;
    const x = SX(u), y = SY(c[1]), s = sc * 0.05 * c[2];
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.ellipse(x, y, s * 2.4, s * 0.6, 0, 0, Math.PI * 2);
    ctx.ellipse(x + s * 0.9, y - s * 0.4, s * 1.2, s * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (t) drawBands(t, now);
}

function arrow(x, y, dir, size, colour) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x + dir * size, y);
  ctx.lineTo(x - dir * size * 0.6, y - size * 0.75);
  ctx.lineTo(x - dir * size * 0.2, y);
  ctx.lineTo(x - dir * size * 0.6, y + size * 0.75);
  ctx.closePath();
  ctx.fill();
}

function drawBands(t, now) {
  // Every other band faintly tinted, so a lane reads as a lane.
  flat();
  for (let i = 0; i < NB; i++) {
    if (i % 2) continue;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, SY(i / NB), VW, (sc * 1) / NB);
  }
  // Streaks riding each band.
  streakWinds = t.bw.slice();
  inField();
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.004;
  for (const s of streaks) {
    const v = t.bw[s.b], y = (s.b + 0.5) / NB + s.dy;
    const len = s.len * Math.min(1.4, Math.abs(v) * 5 + 0.2), dir = v < 0 ? -1 : 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.beginPath();
    for (const off of [-W, 0, W]) {
      ctx.moveTo(s.x + off, y);
      ctx.lineTo(s.x + off - dir * len, y);
    }
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  // Arrows on both edges: how hard, and which way — and a band about to turn
  // blinks with the way it is about to blow.
  flat();
  const size = Math.max(5, Math.min(11, sc * 0.022));
  for (let i = 0; i < NB; i++) {
    const y = SY((i + 0.5) / NB), v = t.bw[i];
    const strong = Math.abs(v) / WIND_HI;
    const n = strong > 0.66 ? 3 : strong > 0.33 ? 2 : 1;
    const dir = v < 0 ? -1 : 1;
    const turning = t.tb && t.tb[0] === i;
    const blink = turning && Math.floor(now / 220) % 2 === 0;
    for (const edge of [0, 1]) {
      const base = edge ? SX(W) - size * 1.6 - (n - 1) * size * 1.1 : SX(0) + size * 1.6;
      for (let a = 0; a < n; a++) {
        const x = base + a * size * 1.1 * (edge ? 1 : 1);
        arrow(x, y, dir, size, blink ? 'rgba(255,209,102,0.25)' : 'rgba(255,255,255,0.55)');
      }
      if (turning) {
        const nd = t.tb[1] < 0 ? -1 : 1;
        const nx = edge ? SX(W) - size * 1.6 - n * size * 1.1 - size * 1.4 : SX(0) + size * 1.6 + n * size * 1.1 + size * 1.4;
        arrow(nx, y, nd, size * 1.15, INK.gold);
      }
    }
  }
}

// The storm: a bank of slate cloud down to `top`, with a lumpy underside that
// rolls on the page's clock and lightning where it struck.
function drawStorm(top, now) {
  flat();
  const y = SY(top);
  const g = ctx.createLinearGradient(0, 0, 0, y + sc * 0.03);
  g.addColorStop(0, INK.stormDeep);
  g.addColorStop(1, INK.storm);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(VW, 0);
  ctx.lineTo(VW, y);
  const tt = now / 1000, bump = sc * 0.025;
  for (let x = VW; x >= -10; x -= 10) {
    const u = (x - ox) / sc;
    ctx.lineTo(x, y + bump * (0.6 + 0.4 * Math.sin(u * 23 + tt * 0.7) * Math.sin(u * 7 - tt * 0.4)));
  }
  ctx.lineTo(0, y);
  ctx.closePath();
  ctx.fill();
  // A faint flicker inside, and a bolt where somebody was struck.
  const flick = Math.sin(tt * 13.7) * Math.sin(tt * 3.1);
  if (flick > 0.93) {
    ctx.fillStyle = 'rgba(255,246,176,0.12)';
    ctx.fillRect(0, 0, VW, y);
  }
  for (const b of bolts) {
    const k = b.life / b.max;
    ctx.strokeStyle = `rgba(255,246,176,${1 - k})`;
    ctx.lineWidth = 3 * (1 - k) + 1;
    ctx.beginPath();
    let bx = SX(b.x), by = Math.max(0, y - sc * 0.15);
    ctx.moveTo(bx, by);
    for (let i = 0; i < 5; i++) {
      bx += (Math.random() - 0.5) * sc * 0.03;
      by += (y + sc * 0.06 - by) / (5 - i);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
  }
}

function drawSea(bot, now) {
  flat();
  const y = SY(bot);
  const g = ctx.createLinearGradient(0, y, 0, VH);
  g.addColorStop(0, INK.sea);
  g.addColorStop(1, INK.seaDeep);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, VH);
  const tt = now / 1000, amp = sc * 0.008;
  for (let x = 0; x <= VW + 8; x += 8) {
    const u = (x - ox) / sc;
    ctx.lineTo(x, y + amp * Math.sin(u * 18 + tt * 2.2));
  }
  ctx.lineTo(VW, VH);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(217,251,255,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= VW + 8; x += 8) {
    const u = (x - ox) / sc;
    const yy = y + amp * Math.sin(u * 18 + tt * 2.2);
    if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
  }
  ctx.stroke();
}

// A balloon: an envelope in its seat's colour with lighter gores, ropes down
// to a wicker basket, a flame while it burns and a puff at the crown while it
// vents. Torn, it is a crumpled rag dragging a basket down.
function drawBalloon(id, x, y, d, colour, me, now, ghost) {
  const look = lookOf(id);
  inField();
  const want = Math.max(-0.35, Math.min(0.35, d.vx * 0.9 + d.l * 0.12));
  look.tilt += (want - look.tilt) * per60(0.12);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(look.tilt * 0.4);
  if (ghost) ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now / 60);
  const sq = look.squash, wob = look.wob * Math.sin(now / 40);
  const sx = 1 + 0.12 * sq + 0.06 * wob, sy = 1 - 0.1 * sq - 0.05 * wob;
  // Ropes and basket first, under the envelope.
  ctx.strokeStyle = 'rgba(40,30,20,0.7)';
  ctx.lineWidth = 0.0025;
  ctx.beginPath();
  ctx.moveTo(-R * 0.55 * sx, R * 0.72);
  ctx.lineTo(-BW / 2, BY);
  ctx.moveTo(R * 0.55 * sx, R * 0.72);
  ctx.lineTo(BW / 2, BY);
  ctx.stroke();
  ctx.fillStyle = INK.wicker;
  roundRect(-BW / 2, BY, BW, BH, 0.004);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.fillRect(-BW / 2, BY + BH * 0.22, BW, BH * 0.22);
  ctx.strokeStyle = INK.wickerDark;
  ctx.lineWidth = 0.002;
  roundRect(-BW / 2, BY, BW, BH, 0.004);
  ctx.stroke();
  // The flame, as tall as the burner is pushed.
  if (d.v === 1) {
    const f = 0.022 + 0.008 * Math.sin(now / 35 + id);
    ctx.fillStyle = INK.flame;
    ctx.beginPath();
    ctx.moveTo(-0.006, BY - 0.002);
    ctx.quadraticCurveTo(0, BY - f * 1.4, 0.006, BY - 0.002);
    ctx.fill();
    ctx.fillStyle = '#fff3c4';
    ctx.beginPath();
    ctx.moveTo(-0.003, BY - 0.002);
    ctx.quadraticCurveTo(0, BY - f * 0.8, 0.003, BY - 0.002);
    ctx.fill();
  }
  // The envelope: a round crown narrowing to a mouth over the basket.
  ctx.scale(sx, sy);
  const env = () => {
    ctx.beginPath();
    ctx.moveTo(-R * 0.42, R * 0.92);
    ctx.bezierCurveTo(-R * 1.15, R * 0.35, -R * 1.15, -R * 1.05, 0, -R * 1.05);
    ctx.bezierCurveTo(R * 1.15, -R * 1.05, R * 1.15, R * 0.35, R * 0.42, R * 0.92);
    ctx.closePath();
  };
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.save();
  ctx.translate(0.006, 0.006);
  env();
  ctx.fill();
  ctx.restore();
  env();
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.save();
  env();
  ctx.clip();
  // Gores: lighter panels down the envelope.
  ctx.fillStyle = lighter(colour, 0.4);
  for (const gx of [-0.62, 0.18]) {
    ctx.beginPath();
    ctx.ellipse(gx * R + R * 0.22, 0, R * 0.2, R * 1.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Heat shows as a glow low in the envelope.
  const hg = ctx.createRadialGradient(0, R * 0.8, 0, 0, R * 0.8, R * 1.2);
  hg.addColorStop(0, `rgba(255,190,90,${0.45 * d.h})`);
  hg.addColorStop(1, 'rgba(255,190,90,0)');
  ctx.fillStyle = hg;
  ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(-R * 0.45, -R * 0.55, R * 0.18, R * 0.3, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = darker(colour, 0.35);
  ctx.fillRect(-R * 0.42, R * 0.86, R * 0.84, R * 0.1);
  env();
  ctx.strokeStyle = me ? '#ffffff' : 'rgba(20,25,45,0.45)';
  ctx.lineWidth = me ? 0.005 : 0.0028;
  ctx.stroke();
  // Venting: a puff out of the crown.
  if (d.v === 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < 3; i++) {
      const k = ((now / 300 + i / 3) % 1);
      disc((i - 1) * 0.008, -R * 1.05 - k * 0.03, 0.006 * (1 - k) + 0.002);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawTorn(id, x, y, colour, now) {
  inField();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(now / 90 + id) * 0.4);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(-R * 0.4, R * 0.8);
  ctx.lineTo(-R * 0.9, -R * 0.1);
  ctx.lineTo(-R * 0.4, -R * 0.5);
  ctx.lineTo(-R * 0.1, -R * 0.05);
  ctx.lineTo(R * 0.3, -R * 0.6);
  ctx.lineTo(R * 0.85, -R * 0.05);
  ctx.lineTo(R * 0.4, R * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,25,45,0.5)';
  ctx.lineWidth = 0.0025;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-R * 0.4, R * 0.8);
  ctx.lineTo(-BW / 2, BY);
  ctx.moveTo(R * 0.4, R * 0.8);
  ctx.lineTo(BW / 2, BY);
  ctx.stroke();
  ctx.fillStyle = INK.wicker;
  ctx.fillRect(-BW / 2, BY, BW, BH);
  ctx.restore();
}

function drawCrown(x, y, now) {
  inField();
  const s = 0.016, b = Math.sin(now / 250) * 0.004;
  ctx.fillStyle = INK.gold;
  ctx.strokeStyle = 'rgba(60,30,10,0.6)';
  ctx.lineWidth = 0.003;
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

function drawEmber(E, now) {
  inField();
  const x = E[0], y = E[1] + Math.sin(now / 380) * 0.006;
  const pulse = 0.85 + 0.15 * Math.sin(now / 160);
  const fade = Math.min(1, E[2] / (2 * HZ));
  for (const off of [-W, 0, W]) {
    const gx = x + off;
    if (gx < -0.1 || gx > W + 0.1) continue;
    const g = ctx.createRadialGradient(gx, y, 0, gx, y, ER * 3.5);
    g.addColorStop(0, `rgba(255,160,70,${0.6 * pulse * fade})`);
    g.addColorStop(1, 'rgba(255,160,70,0)');
    ctx.fillStyle = g;
    disc(gx, y, ER * 3.5);
    ctx.fill();
    ctx.globalAlpha = fade;
    ctx.fillStyle = INK.ember;
    disc(gx, y, ER * 0.8);
    ctx.fill();
    ctx.fillStyle = '#fff1c2';
    disc(gx - ER * 0.2, y - ER * 0.2, ER * 0.35);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawBits() {
  inField();
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 0.008 * (1 - k) + 0.002;
    disc(r.x, r.y, r.r * ease(k));
    ctx.stroke();
  }
  for (const b of bits) {
    ctx.globalAlpha = 1 - b.life / b.max;
    ctx.fillStyle = b.colour;
    ctx.fillRect(b.x - b.size / 2, b.y - b.size / 2, b.size, b.size);
  }
  ctx.globalAlpha = 1;
  flat();
  for (const p of pops) {
    const k = p.life / p.max;
    ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    const s = k < 0.15 ? 0.6 + (0.4 * k) / 0.15 : 1;
    const X = SX(p.x) + shakeX, Y = SY(p.y) + shakeY - ease(Math.min(1, k * 1.4)) * p.lift;
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(16,22,40,0.65)';
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
  let status = '';
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) status = 'round ' + t.rd + ' · ' + clock(t.pt) + (t.top > CEIL0 + 0.001 ? ' · the sky is closing' : '');
  else status = 'round ' + t.rd + ' · over';
  text('updraft', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('updraft').width;
  fitText(status, 22 + tw, 22, titlePx, INK.text, VW - tw - 90, 'left');
  text(wireNote(), VW - 50, 33, 9, INK.dim, 'right');

  // The scoreboard: one chip a pilot, in its seat's colour, with its points
  // and the rounds it has won.
  const ids = playersIn(t).sort((a, b) => t.p[a].k - t.p[b].k);
  if (ids.length) {
    const y = narrow ? 54 : 48;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, down = d.st !== 0;
      ctx.globalAlpha = down && t.ph === PLAY ? 0.55 : 1;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.18)' : 'rgba(10,15,35,0.4)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[d.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[d.k];
      disc(x + 11, y - 4, 5.5);
      ctx.fill();
      ctx.fillStyle = INK.wicker;
      ctx.fillRect(x + 9, y + 3, 4, 3);
      const score = String(d.sc) + (d.wn ? ' ★' + d.wn : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, INK.text, 'right');
      if (cw - 34 - sw > 14) fitText(mine ? 'you' : nickOf(id), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      ctx.globalAlpha = 1;
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag up to burn, down to vent, sideways to lean · land on a balloon to pop it'
    : 'W/↑ burn · S/↓ vent · A/D lean (or hold left/right mouse) · land on a balloon to pop it · M mutes';
  fitText(how, VW / 2, VH - 8, 12, INK.muted, VW - 20);
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

// Practice ends a moment after a second pilot arrives: who it was, as this
// page sees it — the room lists its players in the order they came.
function joinHead(t, left) {
  const me = myId();
  const order = (id) => { const i = room.players.findIndex((p) => p.id === id); return i < 0 ? 1e9 : i; };
  const hs = playersIn(t).filter((id) => id !== TRAINER).sort((a, b) => order(a) - order(b));
  const last = hs[hs.length - 1];
  return (last === me ? 'you joined ' + nickOf(hs[0]) : nickOf(last) + ' joined') + ' · practice ends in ' + left;
}

function panel(px, py, w, h) {
  ctx.fillStyle = INK.panel;
  roundRect(px - w / 2, py - h / 2, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawOverlay(t, now) {
  flat();
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const me = myId();
  const cx = VW / 2, cy = SY(0.42);
  if (t.ph === WAIT) {
    const head = humans(t) >= 2 ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ)))
      : 'practice with the trainer · a round starts when someone joins';
    const tip = humans(t) >= 2 ? null : 'climb or sink into a wind band to steer · land on the trainer from above to pop it';
    const fieldTop = SY(0), fieldBot = SY(1);
    practiceNote(now, VW, head, tip, [[TOP, fieldTop], [fieldBot, VH - BOT]], Math.min(fieldBot, VH - BOT) - 8);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    fitText('you steer only by height: each band of wind blows its own way', cx, cy + big * 2.2, 15, INK.text, VW - 40);
    fitText('land on a balloon to pop it · shove rivals into the storm or the sea', cx, cy + big * 2.2 + 22, 13, INK.muted, VW - 40);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('fly!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= PLAY_STEPS - SQUEEZE_FROM && t.pt > PLAY_STEPS - SQUEEZE_FROM - 2 * HZ) {
    const k = (PLAY_STEPS - SQUEEZE_FROM - t.pt) / (2 * HZ);
    ctx.globalAlpha = 1 - k;
    text('the sky closes in', cx, cy, big * 1.3, INK.gold, 'center');
    fitText('the storm comes down and the sea comes up', cx, cy + big, 15, INK.text, VW - 40);
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 100 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 6, Math.min(VH - BOT - h / 2 - 6, SY(0.5))) + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.win !== -1) { head = t.win === me ? 'you own the sky!' : nickOf(t.win) + ' owns the sky'; hc = colourOf(t, t.win); }
    else head = 'nobody owns the sky';
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
    fitText('next round in ' + Math.ceil(t.pt / HZ) + ' · pop 3 · shove 2 · ember 1', cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// A balloon between two tables, walked the short way round the wrap: one that
// has just been torn, splashed or come down out of the storm is drawn where
// the newer table has it rather than walked there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || q.st !== p.st || p.t < q.t) return [p.x, p.y];
  return [wrapX(q.x + dX(q.x, p.x) * b.k), lerp(q.y, p.y, b.k)];
}

// Your own balloon is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh, a balloon come down anew — is taken at once.
let shown = null;
const SNAP = 0.15;
function settle(tx, ty, st) {
  if (!shown || shown[2] !== st || dX(shown[0], tx) ** 2 + (ty - shown[1]) ** 2 > SNAP * SNAP) return (shown = [tx, ty, st]);
  const k = per60(0.35);
  shown[0] = wrapX(shown[0] + dX(shown[0], tx) * k);
  shown[1] += (ty - shown[1]) * k;
  return shown;
}

// The storm and the sea are drawn eased, so the step a round ends at never
// shows as a jump.
let shownTop = CEIL0, shownBot = SEA0;

function draw(now) {
  const b = agreedAt(now);
  if (!b) {
    drawSky(null, now);
    drawStorm(CEIL0, now);
    drawSea(SEA0, now);
    shown = null;
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the sky…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a sky this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  shownTop += (lerp(b.from.top, t.top, b.k) - shownTop) * per60(0.3);
  shownBot += (lerp(b.from.bot, t.bot, b.k) - shownBot) * per60(0.3);
  drawSky(t, now);
  const me = myId();
  const ids = playersIn(t).sort((a, c) => t.p[a].k - t.p[c].k);

  // Where every balloon is drawn: yours from the guess, the rest from the agreed sky.
  const at = new Map();
  for (const id of ids) {
    if (id === me) continue;
    const pos = between(b, id);
    if (pos) at.set(id, pos);
  }
  const m = mineAt(now);
  if (m && m.to.p[me]) {
    const pos = between(m, me), d = m.to.p[me];
    if (pos) {
      const s = settle(pos[0], pos[1], d.st);
      at.set(me, [s[0], s[1]]);
    }
  }
  const dOf = (id) => (id === me && m && m.to.p[me] ? m.to.p[me] : t.p[id]);
  if (!at.has(me)) shown = null;

  if (t.E) drawEmber(t.E, now);
  // A balloon near an edge of the wrapping sky is drawn on both sides of it.
  inField();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, -1, W, 3);
  ctx.clip();
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos || d.st === 2) continue;
    for (const off of [-W, 0, W]) {
      const x = pos[0] + off;
      if (x < -R * 2 || x > W + R * 2) continue;
      if (d.st === 1) drawTorn(id, x, pos[1], SEAT[d.k], now);
      else drawBalloon(id, x, pos[1], d, SEAT[d.k], id === me, now, d.t < FRESH && t.ph !== COUNT);
    }
  }
  ctx.restore();
  // The leader wears a crown: popping them pays a bounty. Names over the rest.
  flat();
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos || d.st !== 0) continue;
    if (t.ph === PLAY && leads(t, id)) drawCrown(pos[0], pos[1] - R - 0.025, now);
    flat();
    const label = id === me ? 'you' : nickOf(id);
    fitText(label, SX(pos[0]), SY(pos[1] + BY + BH) + 13, 11, id === me ? INK.text : INK.ink, VW < 420 ? 60 : 90);
    // Your own heat, as an arc beside your envelope.
    if (id === me) {
      const x = SX(pos[0] + R * 1.5), y = SY(pos[1]), r = sc * 0.018;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(16,22,40,0.35)';
      ctx.beginPath();
      ctx.arc(x, y, r, Math.PI * 0.75, Math.PI * 2.25);
      ctx.stroke();
      ctx.strokeStyle = d.h > 0.75 ? INK.danger : INK.flame;
      ctx.beginPath();
      ctx.arc(x, y, r, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0.01, d.h));
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      const na = Math.PI * 0.75 + Math.PI * 1.5 * NEUTRAL;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(na) * r * 0.6, y + Math.sin(na) * r * 0.6);
      ctx.lineTo(x + Math.cos(na) * r * 1.35, y + Math.sin(na) * r * 1.35);
      ctx.stroke();
    }
  }
  // Waiting in the sea for the next balloon.
  const mine = dOf(me);
  if (mine && mine.st === 2 && t.ph !== COUNT && t.ph !== END) {
    flat();
    const left = Math.max(0, DOWN - mine.t);
    panel(VW / 2, SY(0.5), 200, 40);
    text('next balloon in ' + Math.max(1, Math.ceil(left / HZ)), VW / 2, SY(0.5) + 5, 14, INK.text, 'center');
  }
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawStorm(shownTop, now);
  drawSea(shownBot, now);
  drawBits();
  // Field edges past the wrap are shaded, so a balloon going off one side is
  // seen coming in on the other rather than vanishing into the margin.
  flat();
  if (ox > 1) {
    ctx.fillStyle = 'rgba(16,22,40,0.25)';
    ctx.fillRect(0, 0, ox, VH);
    ctx.fillRect(SX(W), 0, VW - SX(W), VH);
  }
  if (flash > 0.05) {
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    g.addColorStop(0, `rgba(${flashColour},0)`);
    g.addColorStop(1, `rgba(${flashColour},${0.35 * flash})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: one integer — the burner (0 neither, 1 burn, 2 vent)
// plus three times the lean (0 none, 1 left, 2 right). It goes out when it
// changes and no oftener than SAY_EVERY, because a thumb wobbling on a seam
// would otherwise change it on every move the screen reports, and the clock's
// ticks share the same seat's ceiling on messages.
const SAY_EVERY = 90;
let wantV = 0, wantL = 0;
let lastSaid = -1;
let saidAt = -1e9;

function intent(v, l) {
  if (v === 1 && wantV !== 1) sound.burn();
  if (v === 2 && wantV !== 2) sound.vent();
  wantV = v;
  wantL = l;
  sayHand(performance.now());
}
function sayHand(now) {
  const input = wantV + 3 * (wantL < 0 ? 1 : wantL > 0 ? 2 : 0);
  if (input === lastSaid) return;
  if (now - saidAt < SAY_EVERY) return;
  lastSaid = input;
  saidAt = now;
  setHand(input);
}

// Keys are read by where they sit, not what they type, so every layout flies.
const RUN_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'];
const keys = new Set();
function fromKeys() {
  let v = 0, l = 0;
  if (keys.has('ArrowUp') || keys.has('KeyW') || keys.has('Space')) v = 1;
  else if (keys.has('ArrowDown') || keys.has('KeyS')) v = 2;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) l -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) l += 1;
  return [v, l];
}
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (!RUN_KEYS.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  keys.add(e.code);
  if (!stick && !mouse) intent(...fromKeys());
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (!stick && !mouse) intent(...fromKeys());
});
addEventListener('blur', () => { keys.clear(); dropStick(); mouse = null; intent(0, 0); });

// A thumb: a stick from wherever it lands — a drag rather than a press,
// because iOS keeps a long press inside a frame for itself. Up burns, down
// vents, sideways leans.
// A mouse: hold the left button to burn, the right one to vent, and the
// pilot leans toward the pointer while either is held.
const DEAD = 14;
const REACHOUT = 46;
let stick = null;
let mouse = null;

function dropStick() {
  stick = null;
  paintStick(0, 0);
  if (!mouse) intent(...fromKeys());
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    if (stick) return;
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
    paintStick(0, 0);
    return;
  }
  coarse = false;
  if (e.button !== 0 && e.button !== 2) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mouse = { id: e.pointerId, x: e.clientX, v: e.button === 2 ? 2 : 1 };
  steerToMouse();
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    paintStick(dx, dy);
    const v = dy < -DEAD ? 1 : dy > DEAD ? 2 : 0;
    const l = dx < -DEAD ? -1 : dx > DEAD ? 1 : 0;
    intent(v, l);
  } else if (mouse && e.pointerId === mouse.id) {
    mouse.x = e.clientX;
  }
});
function lift(e) {
  if (stick && e.pointerId === stick.id) dropStick();
  else if (mouse && e.pointerId === mouse.id) {
    mouse = null;
    intent(...fromKeys());
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
  'border:1px solid rgba(255,255,255,0.45);background:rgba(255,255,255,0.08)';
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  'border-radius:50%;pointer-events:none;background:#ffffff;opacity:.6';
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

// The mouse leans toward the pointer while a button is held, and stops
// leaning once the pointer is over the balloon rather than twitching round it.
function steerToMouse() {
  if (!mouse) return;
  let l = 0;
  if (shown) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(shown[0]);
    l = dx < -24 ? -1 : dx > 24 ? 1 : 0;
  }
  intent(mouse.v, l);
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

// Called by the kernel once it stands. Holding still is a hand too: it is how
// a pilot arrives and a balloon comes down for them.
function start() {
  lastSaid = 0;
  saidAt = performance.now();
  setHand(0);
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
