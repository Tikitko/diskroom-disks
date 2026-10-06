/**
 * @disk     kite_fight
 * @author   claude
 * @version  2
 * @players  2-8
 * @about    Fly a fighting kite at dusk. Where two strings cross, the faster kite saws through the other, so climb, dive across a rival's line and swoop away before the ground. Lanterns sharpen your string; the leader is worth a bonus.
 * @tags     game, party, realtime, physics, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/kite_fight.png
 */
// kite_fight.js — kite fighting where the room's order is the referee.
//
// Every copy holds the whole sky — every kite, every string, the wind and the
// lantern — and moves it only on what comes back round the room, so every copy
// applies the same hands in the same order and holds the same sky. Nobody sends
// where their kite is, whose string they cut or a score: a hand is a direction
// and nothing else, and how fast a kite flies, which strings cross and who
// saws through whom is the same arithmetic on the same numbers on every
// machine. A page with a console open can steer its own kite however it likes,
// at a kite's own pace, and no faster.
//
// While a flyer is alone, a bot flies a kite with them. It is part of the sky
// like any kite, and its hand is a function of the sky alone, so it flies the
// same on every copy and says nothing over the wire. Strings saw in practice
// as they do in a round, for no points. When a second flyer arrives, practice
// runs on for three seconds under a note that says so, and the bot leaves
// before the round is laid out: it never takes part in one.
//
// Your own kite does not wait for the trip: it is drawn from the agreed sky
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.abs`, `Math.min`,
// `Math.max` and `Math.imul` are fixed by the language to the last bit;
// `Math.sin` is not, so a step uses this instead.
const PI = 3.141592653589793, TAU = 6.283185307179586;

function dsin(a) {
  let x = a - TAU * Math.round(a / TAU);
  if (x > PI / 2) x = PI - x;
  else if (x < -PI / 2) x = -PI - x;
  const x2 = x * x;
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - (x2 / 110) * (1 - x2 / 156))))));
}

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
const PREDICT = true;          // draw your own kite a trip ahead, with your hand in it
const DT = 1 / HZ;

const W = 1.5;                 // the sky's width; its height is 1, the ground at the bottom
const AY = 0.88;               // the height the flyers hold their strings at
const GROUND = 0.91;           // a kite lower than this has hit the ground
const KR = 0.028;              // a kite's radius, against the walls, the ground and a lantern
const LINE = 1.0;              // a string's full length
const ACC = 2.4;               // how hard a kite answers its flyer's pull
const GRAV = 0.35;             // and how hard it sinks
const V_FLY = 0.55;            // the fastest a kite flies level or climbing
const V_DIVE = 0.5;            // and what a straight dive adds to that
const BLEED = 0.975;           // the most one step takes off a kite flying past its cap
const DRAG = 0.99;             // what one step leaves of a pulled kite's speed
const IDLE_DRAG = 0.93;        // and of one left alone, which hangs and slowly sinks
const SAW_K = 3.4;             // string worn away per unit of speed the sawing kite has over the other, a second
const SAW_MIN = 0.05;          // speeds closer than this saw neither string
const SHARP_X = 1.8;           // a lantern's glass on the string multiplies its saw
const MEND = 0.5 * DT;         // a string not crossed mends at this much a step
const SHARP_STEPS = 8 * HZ;
const FRESH = Math.round(1.5 * HZ);   // a kite just launched can neither saw nor be sawn
const LOOSE = Math.round(1.4 * HZ);   // steps a cut kite drifts off before it is gone
const DOWN = Math.round(2.4 * HZ);    // steps before a lost kite goes up again
const LR = 0.034;              // a lantern's radius
const LANTERN_V = 0.11;        // how fast a lantern rises
const LANTERN_GAP = Math.round(2.5 * HZ);
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const CUT_PTS = 2, BOUNTY_PTS = 1, LANTERN_PTS = 1;
const WIND_MAX = 0.22, STORM_WIND = 0.55;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second flyer arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 8 * HZ;
const STORM = 20 * HZ;         // the last steps of a round, when the wind gusts and points count double
const HOVER_Y = 0.55;          // where kites hang through a countdown

// The sky. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every kite is made by one function with its fields in one order.
//   wx, wt, wc: the wind, where it is heading, and the steps until it turns
//   L: the lantern as [x it sways about, y, sway phase], or null; lw: steps until the next
//   res: the last round's [id, points, rounds won] rows; win: its winner or -1
function freshTable(seed) {
  return {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, wx: 0, wt: 0, wc: 0, L: null, lw: LANTERN_GAP,
    p: {}, res: null, win: -1,
  };
}

const FIELDS = ['ax', 'x', 'y', 'vx', 'vy', 'dx', 'dy', 'h', 'st', 't', 'sh', 'sw', 'sc', 'wn', 'k', 'hs', 'hc'];
//   ax: where its flyer stands; x, y, vx, vy: the kite; dx, dy: the hand's
//   direction in thousandths; h: what is left of the string, 0..1; st: 0 in
//   the air, 1 cut loose, 2 on the ground; t: steps in that state; sh: steps
//   of glass left on the string; sw: who saws it this step, or -1; sc: points
//   this round; wn: rounds won; k: seat, which is its colour; hs, hc: hands
//   this step.
function kite(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const sorted = (w) => playersIn(w).sort((a, b) => a - b);
const storm = (w) => w.ph === PLAY && w.pt <= STORM;
const flying = (d) => d.st === 0;
const armed = (d) => d.st === 0 && d.t >= FRESH;

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// A newcomer stands wherever is furthest from every flyer already there.
function openSpot(w) {
  const taken = Object.values(w.p).map((d) => d.ax);
  if (!taken.length) return W / 2;
  let best = W / 2, far = -1;
  for (let i = 0; i <= 26; i++) {
    const x = 0.1 + ((W - 0.2) * i) / 26;
    let near = Infinity;
    for (const a of taken) near = Math.min(near, Math.abs(a - x));
    if (near > far + 1e-9) { far = near; best = x; }
  }
  return best;
}

function launch(w, d, y, vy) {
  d.x = d.ax;
  d.y = y;
  d.vx = 0;
  d.vy = vy;
  d.h = 1; d.st = 0; d.t = 0; d.sh = 0; d.sw = -1;
}

// A hand, at its place in the room's order: [dx, dy], a direction in
// thousandths. Being heard is how a flyer arrives, and its kite goes up at once.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = w.p[id] = kite({
      ax: openSpot(w), x: 0, y: 0, vx: 0, vy: 0, dx: 0, dy: 0, h: 1, st: 0, t: 0, sh: 0, sw: -1,
      sc: 0, wn: 0, k: freeSeat(w), hs: w.n, hc: 0,
    });
    if (w.ph === COUNT) launch(w, d, HOVER_Y, 0);
    else launch(w, d, GROUND - 0.12, -0.6);
    fx(w, 'launch', d.ax, GROUND, id);
  }
  // A flood of hands in one step is cut off where no flyer's thumb could
  // reach, on every copy alike; the ones that are heard only ever steer.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.dx = input[0];
  d.dy = input[1];
}

// A hand off the wire, made safe: two integers in their range, or nothing.
// How hard it pulls is the kite's business, not the hand's: any direction,
// however long, flies at a kite's pace.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [dx, dy] = raw;
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) return null;
  if (dx < -1000 || dx > 1000 || dy < -1000 || dy > 1000) return null;
  return [dx, dy];
}

function leave(w, id) {
  delete w.p[id];
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.L = null;
  w.lw = LANTERN_GAP;
}

// A round: the flyers spread evenly along the ground in seat order, every kite
// hanging at the same height, the points wiped.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.L = null;
  w.lw = LANTERN_GAP;
  w.wx = w.wt = 0;
  w.wc = 0;
  const ids = sorted(w).sort((a, b) => w.p[a].k - w.p[b].k);
  ids.forEach((id, i) => {
    const d = w.p[id];
    d.ax = (W * (i + 0.5)) / ids.length;
    d.sc = 0;
    launch(w, d, HOVER_Y, 0);
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
  w.L = null;
  fx(w, 'end', 0, 0, w.win);
}

function wind(w) {
  w.wc -= 1;
  if (w.wc <= 0) {
    const big = storm(w) ? STORM_WIND : WIND_MAX;
    w.wt = (draw01(w) * 2 - 1) * big;
    w.wc = Math.round((storm(w) ? 1.5 + draw01(w) * 1.5 : 4 + draw01(w) * 4) * HZ);
  }
  w.wx += (w.wt - w.wx) * 0.03;
}

// One kite through one step: its flyer's pull, the wind, its weight, and the
// string that will not let it go further than its length.
function fly(w, id, d) {
  if (d.t < 100000) d.t += 1;
  if (d.st === 1) {
    // Cut loose: it goes where the wind takes it, and down.
    d.vx = d.vx * 0.96 + w.wx * 1.5 * DT;
    d.vy = d.vy * 0.96 + 0.5 * DT;
    d.x += d.vx * DT;
    d.y += d.vy * DT;
    if (d.t >= LOOSE) { d.st = 2; d.t = 0; }
    return;
  }
  if (d.st === 2) {
    if (d.t >= DOWN) {
      launch(w, d, GROUND - 0.12, -0.6);
      fx(w, 'launch', d.ax, GROUND, id);
    }
    return;
  }
  if (d.sh > 0) d.sh -= 1;
  const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy);
  const pull = len > 100;
  let ax = w.wx, ay = GRAV;
  if (pull) { ax += (d.dx / len) * ACC; ay += (d.dy / len) * ACC; }
  const keep = pull ? DRAG : IDLE_DRAG;
  d.vx = (d.vx + ax * DT) * keep;
  d.vy = (d.vy + ay * DT) * keep;
  // A dive is faster than a climb, and the speed it gave bleeds off slowly,
  // so a kite that pulls out of a dive swoops on faster than it could fly.
  const s = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
  if (s > 1e-9) {
    const cap = V_FLY + V_DIVE * (d.vy > 0 ? d.vy / s : 0);
    if (s > cap) {
      const k = Math.max(cap / s, BLEED);
      d.vx *= k;
      d.vy *= k;
    }
  }
  d.x += d.vx * DT;
  d.y += d.vy * DT;
  const rx = d.x - d.ax, ry = d.y - AY, r = Math.sqrt(rx * rx + ry * ry);
  if (r > LINE) {
    const nx = rx / r, ny = ry / r;
    d.x = d.ax + nx * LINE;
    d.y = AY + ny * LINE;
    const out = d.vx * nx + d.vy * ny;
    if (out > 0) { d.vx -= nx * out; d.vy -= ny * out; }
  }
  if (d.x < KR) { d.x = KR; if (d.vx < 0) d.vx = 0; }
  if (d.x > W - KR) { d.x = W - KR; if (d.vx > 0) d.vx = 0; }
  if (d.y < KR) { d.y = KR; if (d.vy < 0) d.vy = 0; }
  if (d.y > GROUND) {
    fx(w, 'crash', d.x, GROUND, id);
    d.y = GROUND;
    d.vx = d.vy = 0;
    d.st = 2;
    d.t = 0;
    d.sw = -1;
  }
}

// Whether two strings cross: each runs straight from its flyer's hands to its
// kite, and they cross where each one's ends lie on either side of the other.
function side(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}
function crosses(a, b) {
  const d1 = side(b.ax, AY, b.x, b.y, a.ax, AY), d2 = side(b.ax, AY, b.x, b.y, a.x, a.y);
  const d3 = side(a.ax, AY, a.x, a.y, b.ax, AY), d4 = side(a.ax, AY, a.x, a.y, b.x, b.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
const sawOf = (d) => Math.sqrt(d.vx * d.vx + d.vy * d.vy) * (d.sh > 0 ? SHARP_X : 1);

// Where strings cross, the kite moving faster saws through the other's string,
// by how much faster it is. Every pair is weighed first and the wear applied
// after, so the order kites are looked at in never decides a duel.
function saw(w, ids) {
  const wear = new Map(), by = new Map(), crossed = new Set();
  const hurt = (id, from, x) => {
    wear.set(id, (wear.get(id) || 0) + x * SAW_K * DT);
    if (!by.has(id) || x > by.get(id)[1]) by.set(id, [from, x]);
  };
  for (let i = 0; i < ids.length; i++) {
    const A = w.p[ids[i]];
    if (!armed(A)) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const B = w.p[ids[j]];
      if (!armed(B) || !crosses(A, B)) continue;
      crossed.add(ids[i]);
      crossed.add(ids[j]);
      const pa = sawOf(A), pb = sawOf(B);
      if (pa - pb > SAW_MIN) hurt(ids[j], ids[i], pa - pb);
      else if (pb - pa > SAW_MIN) hurt(ids[i], ids[j], pb - pa);
    }
  }
  for (const id of ids) {
    const d = w.p[id];
    d.sw = by.has(id) ? by.get(id)[0] : -1;
    if (wear.has(id)) d.h = Math.max(0, d.h - wear.get(id));
    else if (flying(d) && !crossed.has(id)) d.h = Math.min(1, d.h + MEND);
  }
  for (const id of ids) {
    const d = w.p[id];
    if (flying(d) && d.h <= 0) cut(w, id, d, d.sw);
  }
}

// Whether a flyer stands alone at the top of the points: a cut of theirs pays
// a bounty, so a runaway leader is everybody's target.
function leads(w, id) {
  const sc = w.p[id].sc;
  if (sc <= 0) return false;
  for (const o of playersIn(w)) if (o !== id && w.p[o].sc >= sc) return false;
  return true;
}

function cut(w, id, d, byId) {
  const cutter = w.p[byId];
  if (cutter && byId !== id) {
    const pts = w.ph === PLAY ? (CUT_PTS + (leads(w, id) ? BOUNTY_PTS : 0)) * (storm(w) ? 2 : 1) : 0;
    cutter.sc += pts;
    fx(w, 'cut', d.x, d.y, id, byId, pts);
  } else {
    fx(w, 'cut', d.x, d.y, id, -1, 0);
  }
  d.h = 0;
  d.st = 1;
  d.t = 0;
  d.sh = 0;
  d.vx += w.wx * 0.5;
  d.vy = Math.min(d.vy, -0.15);
}

const lanternAt = (L) => [L[0] + dsin(L[2]) * 0.05, L[1]];

// One lantern at a time rises through the sky. Whichever kite reaches it first
// takes a point and glass on its string, which saws harder for a while.
function lantern(w, ids) {
  if (w.ph !== PLAY && w.ph !== WAIT) return;
  if (!w.L) {
    w.lw -= 1;
    if (w.lw <= 0) w.L = [0.15 + draw01(w) * (W - 0.3), GROUND - 0.02, draw01(w) * TAU];
    return;
  }
  const L = w.L;
  L[1] -= LANTERN_V * DT;
  L[2] += 1.6 * DT;
  if (L[2] > TAU) L[2] -= TAU;
  L[0] = Math.max(0.1, Math.min(W - 0.1, L[0] + w.wx * 0.15 * DT));
  const [lx, ly] = lanternAt(L);
  if (ly < -LR) {
    w.L = null;
    w.lw = LANTERN_GAP;
    return;
  }
  let best = -1, near = (KR + LR) * (KR + LR);
  for (const id of ids) {
    const d = w.p[id];
    if (!flying(d)) continue;
    const dx = d.x - lx, dy = d.y - ly, dd = dx * dx + dy * dy;
    if (dd < near) { near = dd; best = id; }
  }
  if (best === -1) return;
  const d = w.p[best];
  const pts = w.ph === PLAY ? LANTERN_PTS * (storm(w) ? 2 : 1) : 0;
  d.sc += pts;
  d.sh = SHARP_STEPS;
  fx(w, 'lantern', lx, ly, best, pts);
  w.L = null;
  w.lw = LANTERN_GAP;
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot flies while the sky waits for a round, and goes the moment a round's
// countdown starts.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && Object.keys(w.p).length < MAX_P) {
    const d = (w.p[BOT_ID] = kite({
      ax: openSpot(w), x: 0, y: 0, vx: 0, vy: 0, dx: 0, dy: 0, h: 1, st: 0, t: 0, sh: 0, sw: -1,
      sc: 0, wn: 0, k: freeSeat(w), hs: w.n, hc: 0,
    }));
    launch(w, d, GROUND - 0.12, -0.6);
    fx(w, 'launch', d.ax, GROUND, BOT_ID);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

function steer(d, x, y) {
  const l = Math.sqrt(x * x + y * y);
  if (l < 0.01) { d.dx = d.dy = 0; return; }
  d.dx = Math.round((x / l) * 1000);
  d.dy = Math.round((y / l) * 1000);
}

// The bot's hand: it climbs to a spot above your kite on its own side, dives
// across your string from there, and pulls out before the ground. Caught on a
// crossing it is losing, it climbs away; a lantern close by it takes. Now and
// then it lets the string go slack a moment, so it can be beaten.
function botHand(w) {
  const d = w.p[BOT_ID];
  if (!d || !flying(d) || w.n % BOT_EVERY) return;
  let you = null;
  for (const id of humans(w).sort((a, b) => a - b)) if (flying(w.p[id])) { you = w.p[id]; break; }
  if (d.y > 0.66 && d.vy > 0) { steer(d, (d.ax - d.x) * 0.3, -1); return; }
  if (draw01(w) < 0.08) { steer(d, 0, 0); return; }
  if (w.L) {
    const [lx, ly] = lanternAt(w.L), ex = lx - d.x, ey = ly - d.y;
    if (ex * ex + ey * ey < 0.22 * 0.22) { steer(d, ex, ey); return; }
  }
  if (!you) { steer(d, (d.ax - d.x) * 0.5, 0.3 - d.y); return; }
  const s = d.ax >= you.ax ? 1 : -1;
  if (armed(d) && armed(you) && crosses(d, you) && sawOf(d) < sawOf(you)) {
    steer(d, s, -1);
    return;
  }
  const above = you.y - d.y, dxy = (d.x - you.x) * s;
  if (above > 0.12 && dxy > -0.1 && dxy < 0.4 && d.y < 0.6) {
    // Dive down and across your string, toward your side.
    steer(d, you.x - s * 0.3 - d.x, you.y + 0.25 - d.y);
    return;
  }
  steer(d, you.x + s * 0.25 - d.x, Math.max(0.12, you.y - 0.3) - d.y);
}

// One step of the sky: a function of the sky alone.
function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second flyer ends practice, three seconds on: the count runs in pt,
    // which a waiting sky otherwise leaves at zero. The bot goes first, so the
    // round spreads the flyers along the ground without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === STORM) { w.wc = 0; fx(w, 'storm'); }
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  const ids = sorted(w);
  if (w.ph === COUNT) {
    for (const id of ids) { const d = w.p[id]; d.vx = d.vy = 0; d.sw = -1; }
    return;
  }
  wind(w);
  botHand(w);
  for (const id of ids) fly(w, id, w.p[id]);
  if (w.ph === PLAY || w.ph === WAIT) saw(w, ids);
  else for (const id of ids) { const d = w.p[id]; d.sw = -1; if (flying(d)) d.h = Math.min(1, d.h + MEND); }
  lantern(w, ids);
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
  if (!num(raw.wx, -1, 1) || !num(raw.wt, -1, 1) || !int(raw.wc, -BIG, BIG) || !int(raw.lw, -BIG, BIG)) return null;
  let L = null;
  if (raw.L !== null) {
    if (!Array.isArray(raw.L) || raw.L.length !== 3) return null;
    if (!num(raw.L[0], 0, W) || !num(raw.L[1], -1, 1) || !num(raw.L[2], -1, TAU + 1)) return null;
    L = [raw.L[0], raw.L[1], raw.L[2]];
  }
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!num(d.ax, 0, W) || !num(d.x, -2, 3) || !num(d.y, -2, 3) || !num(d.vx, -5, 5) || !num(d.vy, -5, 5)) return null;
    if (inputOf([d.dx, d.dy]) === null || !num(d.h, 0, 1) || !int(d.st, 0, 2) || !int(d.t, 0, BIG)) return null;
    if (!int(d.sh, 0, SHARP_STEPS) || !int(d.sw, -BIG, BIG) || !int(d.sc, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.k, 0, MAX_P - 1) || seats.has(d.k) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    seats.add(d.k);
    p[id] = kite(d);
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
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, wx: raw.wx, wt: raw.wt, wc: raw.wc, L, lw: raw.lw,
    p, res, win: raw.win,
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
// One palette: a dusk sky going from indigo to peach over dark hills, and a
// bright colour for each seat that is its kite's, its string's, its flyer's
// and its chip's on the scoreboard.
const INK = {
  skyTop: '#1b1d45', skyMid: '#5a3a74', skyLow: '#e98a6a', sun: '#ffd59a',
  hillFar: '#4a2f61', hillNear: '#2c1d44', ground: '#1d1430', grass: '#4b3769',
  text: '#fff4e6', muted: '#d8c3d6', dim: '#a48fb0', gold: '#ffd166', danger: '#ff5a6e',
  panel: 'rgba(22,14,40,0.9)', lantern: '#ffb347', glow: 'rgba(255,190,90,',
};
const SEAT = ['#ff5d73', '#3ec1d3', '#ffd23f', '#7bd389', '#b98cff', '#ff9f43', '#5b8cff', '#f5f5f5'];
const FONT = "600 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.skyTop};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #5a4378;' +
  `background:#2a1f4a;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, sc = 1, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 66 : 58;
  BOT = 26;
  const aw = VW - 16, ah = Math.max(40, VH - TOP - BOT);
  sc = Math.max(10, Math.min(aw / W, ah));
  ox = (VW - W * sc) / 2;
  // The sky stands on the bottom of the screen: whatever height is spare goes
  // above it, where there is sky to spare.
  oy = VH - BOT - sc;
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
  saw(winning) {
    if (!ready('saw', 110)) return;
    puff(0.09, winning ? 0.07 : 0.1, winning ? 3600 : 2600, 0, 4);
    tone(winning ? 900 : 640, 0.07, 'sawtooth', 0.025, 0.8);
  },
  snap(mine) {
    if (!ready('snap', 90)) return;
    puff(0.07, mine ? 0.3 : 0.16, 4200, 0, 2);
    tone(1400, 0.25, 'triangle', mine ? 0.1 : 0.05, 0.25);
  },
  score() { if (ready('score', 80)) { tone(660, 0.1, 'triangle', 0.12); tone(990, 0.2, 'triangle', 0.1, 0, 0.08); } },
  chime() {
    if (!ready('chime', 120)) return;
    [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.3, 'sine', 0.07, 0, i * 0.06));
  },
  crash() { if (ready('crash', 120)) { tone(110, 0.2, 'sine', 0.16, 0.5); puff(0.18, 0.12, 380, 0, 0.8); } },
  lift() { if (ready('lift', 150)) { tone(300, 0.35, 'sine', 0.05, 2.2); puff(0.3, 0.04, 1200, 0, 0.7); } },
  storm() {
    if (!ready('storm', 800)) return;
    tone(70, 1.4, 'sawtooth', 0.05, 0.8);
    puff(1.4, 0.12, 220, 0, 0.5);
    puff(0.9, 0.06, 900, 0.3, 0.6);
  },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(700, 0.12, 'sine', 0.12, 2.0); tone(1400, 0.25, 'sine', 0.08, 1.0, 0.12); } },
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
let shakeX = 0, shakeY = 0, shake = 0, flash = 0;
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
    for (const look of looks.values()) look.squash *= 0.88;
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.9;
    sparkTick();
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, seen, tilt, tail: [[x, y]], tailAt }
let drawFailed = false;
const sparks = [];         // [x, y, colour]: where strings saw each other, as last drawn
let sparkEvery = 0;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, seen: 0, tilt: 0, tail: [], tailAt: 0 }));
  l.seen = performance.now();
  return l;
}
const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].k] : '#dddddd');
const hands = (d) => [d.ax, AY];

// Sparks fly where strings saw, a few at a time on the bits' clock.
function sparkTick() {
  if (++sparkEvery % 3) return;
  for (const s of sparks) spray(s[0], s[1], 2, Math.random() < 0.5 ? '#fff6c8' : s[2], 0.35, 0.006, 0.9);
}

function play(e, t) {
  const me = myId();
  if (e.kind === 'cut') {
    const mine = e.a === me, mineBy = e.b === me;
    spray(e.x, e.y, 24, colourOf(t, e.a), 0.5, 0.008, 0.6);
    spray(e.x, e.y, 10, '#fff6c8', 0.7, 0.005);
    ring(e.x, e.y, '#fff6c8', 0.09);
    lookOf(e.a).squash = 1;
    if (mine) { shake = Math.max(shake, 9); flash = 1; pop(e.x, e.y, 'cut!', INK.danger, 22, 30); }
    if (e.b !== -1 && e.c) {
      const who = mineBy ? '+' + e.c : '+' + e.c + ' ' + nickOf(e.b);
      pop(e.x, e.y - 0.05, who, colourOf(t, e.b), mineBy ? 22 : 15, 40);
      if (mineBy) { shake = Math.max(shake, 4); sound.score(); }
    }
    sound.snap(mine || mineBy);
  } else if (e.kind === 'lantern') {
    spray(e.x, e.y, 22, INK.lantern, 0.5, 0.008);
    spray(e.x, e.y, 10, '#fff6c8', 0.3, 0.005);
    ring(e.x, e.y, INK.gold, 0.1);
    const mine = e.a === me;
    pop(e.x, e.y, (e.b ? '+' + e.b + ' · ' : '') + (mine ? 'sharp string!' : 'sharp ' + nickOf(e.a)), mine ? INK.gold : colourOf(t, e.a), mine ? 18 : 13, 30);
    if (mine) sound.chime(); else sound.score();
  } else if (e.kind === 'crash') {
    spray(e.x, e.y, 16, '#8a6f9e', 0.45, 0.008, 1.2);
    spray(e.x, e.y, 8, colourOf(t, e.a), 0.35, 0.007, 1.2);
    lookOf(e.a).squash = 1;
    if (e.a === me) { shake = Math.max(shake, 7); pop(e.x, e.y - 0.06, 'crashed!', INK.text, 18, 26); }
    sound.crash();
  } else if (e.kind === 'launch') {
    const l = lookOf(e.a);
    l.tail = [];
    if (e.a === me) sound.lift();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'storm') {
    flash = 0.8;
    shake = Math.max(shake, 5);
    sound.storm();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(e.a === me);
  } else if (e.kind === 'round') {
    for (const l of looks.values()) l.tail = [];
  }
}

// The sky: a dusk gradient, the sun on the hills, clouds that drift on the
// page's clock alone, and the ground the flyers stand on.
const clouds = [];
for (let i = 0; i < 7; i++) clouds.push([Math.random(), 0.08 + Math.random() * 0.45, 0.6 + Math.random() * 0.9, 0.004 + Math.random() * 0.01]);
function hill(y0, amp, f1, f2, colour) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(0, VH);
  for (let x = 0; x <= VW + 8; x += 8) {
    const u = (x - ox) / sc;
    ctx.lineTo(x, SY(y0 - amp * (0.5 + 0.3 * Math.sin(u * f1 + 1.3) + 0.2 * Math.sin(u * f2))));
  }
  ctx.lineTo(VW, VH);
  ctx.closePath();
  ctx.fill();
}
function drawSky(t, now, stormy) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, SY(GROUND));
  g.addColorStop(0, INK.skyTop);
  g.addColorStop(0.55, INK.skyMid);
  g.addColorStop(1, INK.skyLow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // The sun, low behind the hills.
  const sx = SX(W * 0.72), sy = SY(0.8), sr = sc * 0.1;
  const halo = ctx.createRadialGradient(sx, sy, sr * 0.6, sx, sy, sr * 4);
  halo.addColorStop(0, 'rgba(255,213,154,0.5)');
  halo.addColorStop(1, 'rgba(255,213,154,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(sx - sr * 4, sy - sr * 4, sr * 8, sr * 8);
  ctx.fillStyle = INK.sun;
  disc(sx, sy, sr);
  ctx.fill();
  // Clouds, drifting the way the wind blows.
  const tt = now / 1000;
  for (const c of clouds) {
    const span = W + 0.6;
    const u = (((c[0] * span + tt * c[3] * (1 + (t ? t.wx * 8 : 0))) % span) + span) % span - 0.3;
    const x = SX(u), y = SY(c[1]), s = sc * 0.06 * c[2];
    ctx.fillStyle = stormy ? 'rgba(60,50,90,0.55)' : 'rgba(255,220,230,0.13)';
    ctx.beginPath();
    ctx.ellipse(x, y, s * 2.2, s * 0.55, 0, 0, Math.PI * 2);
    ctx.ellipse(x + s * 0.8, y - s * 0.35, s * 1.1, s * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  hill(0.86, 0.18, 2.1, 5.3, INK.hillFar);
  hill(0.92, 0.1, 3.7, 7.9, INK.hillNear);
  // A storm darkens it all, and rain streaks the way the wind blows.
  if (stormy) {
    ctx.fillStyle = 'rgba(10,8,30,0.32)';
    ctx.fillRect(0, 0, VW, VH);
    ctx.strokeStyle = 'rgba(200,210,255,0.22)';
    ctx.lineWidth = 1;
    const lean = (t ? t.wx : 0) * 40;
    ctx.beginPath();
    for (let i = 0; i < 60; i++) {
      const x = (((i * 97.3 + tt * 230) % (VW + 80)) + VW + 80) % (VW + 80) - 40;
      const y = (i * 53.7 + tt * 700) % VH;
      ctx.moveTo(x, y);
      ctx.lineTo(x + lean * 0.3, y + 14);
    }
    ctx.stroke();
  }
  // The ground, out to the bottom of the screen.
  const gy = SY(GROUND + KR);
  ctx.fillStyle = INK.ground;
  ctx.fillRect(0, gy, VW, VH - gy);
  ctx.fillStyle = INK.grass;
  ctx.fillRect(0, gy, VW, Math.max(2, sc * 0.008));
  // Past the walls, the sky is shaded, so the edge a kite stops at shows.
  ctx.fillStyle = 'rgba(12,8,28,0.35)';
  if (ox > 1) { ctx.fillRect(0, 0, ox, gy); ctx.fillRect(SX(W), 0, VW - SX(W), gy); }
  // A cloud bank on the ceiling no kite can climb through.
  if (oy > 4) {
    const cg = ctx.createLinearGradient(0, oy - 20, 0, oy + sc * 0.03);
    cg.addColorStop(0, 'rgba(255,230,240,0)');
    cg.addColorStop(1, 'rgba(255,230,240,0.10)');
    ctx.fillStyle = cg;
    ctx.fillRect(0, oy - 20, VW, 20 + sc * 0.03);
  }
}

function drawFlyer(d, colour, me, alive) {
  const [hx, hy] = hands(d);
  // Drawn to the sky's own scale, so the raised hand is where the string starts.
  const x = SX(hx - 0.014), y = SY(GROUND + KR), s = sc * 0.018;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(x, y + s * 0.3, s * 1.3, s * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = colour;
  roundRect(x - s * 0.7, y - s * 2.2, s * 1.4, s * 2.2, s * 0.5);
  ctx.fill();
  if (me) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke(); }
  ctx.fillStyle = lighter(colour, 0.35);
  disc(x, y - s * 2.85, s * 0.65);
  ctx.fill();
  // An arm up to the string while the kite flies.
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.5, s * 0.35);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + s * 0.4, y - s * 1.8);
  if (alive) ctx.lineTo(SX(hx), SY(hy));
  else ctx.lineTo(x + s * 1.1, y - s * 0.9);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

// A string from the flyer's hands to the kite: fraying red as it wears, a
// glitter running along it while it carries glass.
function drawString(d, x, y, colour, me, now) {
  const [hx, hy] = hands(d);
  const worn = 1 - d.h;
  inField();
  ctx.lineWidth = (me ? 2.2 : 1.6) / sc;
  ctx.strokeStyle = worn > 0.02 ? (Math.floor(now / 90) % 2 && worn > 0.4 ? INK.danger : lighter(colour, 0.15)) : colour;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  // A barely slack line, so it reads as string rather than a ruler.
  const mx = (hx + x) / 2, my = (hy + y) / 2 + 0.012;
  ctx.quadraticCurveTo(mx, my, x, y);
  ctx.stroke();
  if (d.sh > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.setLineDash([0.01, 0.03]);
    ctx.lineDashOffset = -now / 900;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

function drawTail(look, colour) {
  const tl = look.tail;
  if (tl.length < 2) return;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 0.004;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  // Each point hangs a little lower the further back it is: a tail has weight.
  const sag = (i) => tl[i][1] + 0.004 * i;
  ctx.moveTo(tl[0][0], tl[0][1]);
  for (let i = 1; i < tl.length; i++) ctx.lineTo(tl[i][0], sag(i));
  ctx.stroke();
  for (let i = 2; i < tl.length; i += 2) {
    const x = tl[i][0], y = sag(i), s = 0.009 * (1 - i / (tl.length + 2));
    ctx.fillStyle = i % 4 ? '#ffffff' : colour;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s * 0.7);
    ctx.lineTo(x + s, y + s * 0.7);
    ctx.lineTo(x + s, y - s * 0.7);
    ctx.lineTo(x - s, y + s * 0.7);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// A kite: a diamond in the seat's colour, leaning with the way it flies.
function drawKite(id, x, y, vx, d, colour, me, now, tumble) {
  const look = lookOf(id);
  // The tail is the path the kite drew, sampled on the page's clock and
  // hanging off its tip.
  if (now - look.tailAt > 40) {
    look.tailAt = now;
    look.tail.unshift([x, y + 0.03]);
    if (look.tail.length > 12) look.tail.length = 12;
  }
  look.tail[0] = [x, y + 0.03];
  inField();
  drawTail(look, colour);
  const want = tumble ? look.tilt + 0.25 : Math.max(-0.7, Math.min(0.7, vx * 0.9)) + Math.sin(now / 300 + id) * 0.05;
  look.tilt = tumble ? want : look.tilt + (want - look.tilt) * per60(0.18);
  const sq = look.squash, s = 0.042 * (1 + 0.15 * sq);
  ctx.save();
  // Just gone up, it can neither saw nor be sawn yet, and it shimmers so.
  if (!tumble && d.t < FRESH) ctx.globalAlpha = 0.55 + 0.3 * Math.sin(now / 60);
  ctx.translate(x, y);
  ctx.rotate(look.tilt);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.moveTo(0.006, -s * 1.15 + 0.008); ctx.lineTo(s * 0.75 + 0.006, -s * 0.1 + 0.008);
  ctx.lineTo(0.006, s + 0.008); ctx.lineTo(-s * 0.75 + 0.006, -s * 0.1 + 0.008);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.15); ctx.lineTo(0, s); ctx.lineTo(-s * 0.75, -s * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = lighter(colour, 0.45);
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.15); ctx.lineTo(s * 0.75, -s * 0.1); ctx.lineTo(0, s);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(30,15,40,0.55)';
  ctx.lineWidth = 0.003;
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.15); ctx.lineTo(0, s);
  ctx.moveTo(-s * 0.75, -s * 0.1); ctx.lineTo(s * 0.75, -s * 0.1);
  ctx.stroke();
  ctx.strokeStyle = me ? '#ffffff' : 'rgba(30,15,40,0.5)';
  ctx.lineWidth = me ? 0.005 : 0.003;
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.15); ctx.lineTo(s * 0.75, -s * 0.1); ctx.lineTo(0, s); ctx.lineTo(-s * 0.75, -s * 0.1);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
  // What is left of the string, round the kite while it wears.
  if (!tumble && d.h < 0.999) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.008;
    disc(x, y, 0.062);
    ctx.stroke();
    ctx.strokeStyle = d.h < 0.4 ? INK.danger : '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 0.062, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, d.h));
    ctx.stroke();
  }
  // Glass on the string: a glint at the kite.
  if (!tumble && d.sh > 0) {
    ctx.fillStyle = `rgba(255,246,200,${0.5 + 0.4 * Math.sin(now / 120)})`;
    disc(x + 0.02, y - 0.03, 0.006);
    ctx.fill();
  }
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

function drawLantern(L, now) {
  inField();
  const [x, y] = lanternAt(L);
  const pulse = 0.85 + 0.15 * Math.sin(now / 200);
  const g = ctx.createRadialGradient(x, y, 0, x, y, LR * 3.2);
  g.addColorStop(0, INK.glow + (0.55 * pulse) + ')');
  g.addColorStop(1, INK.glow + '0)');
  ctx.fillStyle = g;
  disc(x, y, LR * 3.2);
  ctx.fill();
  ctx.fillStyle = INK.lantern;
  roundRect(x - LR * 0.75, y - LR, LR * 1.5, LR * 2, LR * 0.6);
  ctx.fill();
  ctx.fillStyle = `rgba(255,246,200,${0.8 * pulse})`;
  roundRect(x - LR * 0.4, y - LR * 0.6, LR * 0.8, LR * 1.2, LR * 0.35);
  ctx.fill();
  ctx.fillStyle = '#8a4b1f';
  ctx.fillRect(x - LR * 0.5, y - LR * 1.12, LR, LR * 0.2);
  ctx.fillRect(x - LR * 0.5, y + LR * 0.92, LR, LR * 0.2);
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
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(20,10,35,0.6)';
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
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt);
    if (storm(t)) {
      status += ' · storm ×2';
      colour = Math.floor(now / 300) % 2 ? INK.gold : INK.text;
    }
  } else status = 'round ' + t.rd + ' · over';
  text('kite fight', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('kite fight').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  // The wind, as an arrow as long as it blows.
  const ax = VW - 76, ay = 17, len = Math.max(-26, Math.min(26, t.wx * 70));
  text('wind', ax - 30, 21, 10, INK.dim, 'right');
  ctx.strokeStyle = Math.abs(t.wx) > 0.3 ? INK.gold : INK.muted;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ax - len / 2 - 0.01, ay);
  ctx.lineTo(ax + len / 2, ay);
  if (Math.abs(len) > 3) {
    const sgn = Math.sign(len);
    ctx.moveTo(ax + len / 2, ay);
    ctx.lineTo(ax + len / 2 - sgn * 5, ay - 4);
    ctx.moveTo(ax + len / 2, ay);
    ctx.lineTo(ax + len / 2 - sgn * 5, ay + 4);
  }
  ctx.stroke();
  ctx.lineCap = 'butt';
  text(wireNote(), VW - 8, 33, 9, INK.dim, 'right');

  // The scoreboard: one chip a flyer, in its seat's colour, with its points
  // and the rounds it has won.
  const ids = playersIn(t).sort((a, b) => t.p[a].k - t.p[b].k);
  if (ids.length) {
    const y = narrow ? 54 : 48;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, down = d.st !== 0;
      ctx.globalAlpha = down && t.ph === PLAY ? 0.55 : 1;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.16)' : 'rgba(10,5,25,0.35)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[d.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[d.k];
      ctx.beginPath();
      ctx.moveTo(x + 11, y - 9); ctx.lineTo(x + 16, y - 2); ctx.lineTo(x + 11, y + 5); ctx.lineTo(x + 6, y - 2);
      ctx.closePath();
      ctx.fill();
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
    ? 'drag to steer · dive across a string: the faster kite cuts'
    : 'arrows/WASD or hold the mouse to steer · dive across a string: the faster kite cuts · M mutes';
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

// Practice ends a moment after a second flyer arrives: who it was, as this
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
  const cx = VW / 2, cy = SY(0.42);
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'climb high, then dive across the bot\'s string: the faster kite saws through';
    practiceNote(now, VW, head, tip, [[TOP, SY(0) - 4]], SY(GROUND) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    fitText('where strings cross, the faster kite cuts · lanterns sharpen your string', cx, cy + big * 2.2, 15, INK.text, VW - 40);
    fitText('dive for speed, pull out before the ground · the crowned leader pays a bounty', cx, cy + big * 2.2 + 22, 13, INK.muted, VW - 40);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('fly!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= STORM && t.pt > STORM - HZ * 2) {
    const k = (STORM - t.pt) / (HZ * 2);
    ctx.globalAlpha = 1 - k;
    text('storm!', cx, cy, big * 1.6, INK.gold, 'center');
    fitText('every point counts double', cx, cy + big, 15, INK.text, VW - 40);
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 100 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 6, Math.min(VH - BOT - h / 2 - 6, cy)) + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.win !== -1) { head = t.win === me ? 'you rule the sky!' : nickOf(t.win) + ' rules the sky'; hc = colourOf(t, t.win); }
    else head = 'a draw in the sky';
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
    fitText('next round in ' + Math.ceil(t.pt / HZ) + ' · points for cuts and lanterns', cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// A kite between two tables: one that has just been cut, or has just gone up,
// is drawn where the newer table has it rather than walked there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || q.st !== p.st || (p.st === 0 && p.t < q.t)) return [p.x, p.y, p.vx];
  return [lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k), lerp(q.vx, p.vx, b.k)];
}

// Your own kite is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh, a kite gone up again — is taken at once.
let shown = null;
const SNAP = 0.15;
function settle(tx, ty, st) {
  if (!shown || shown[2] !== st || (tx - shown[0]) ** 2 + (ty - shown[1]) ** 2 > SNAP * SNAP) return (shown = [tx, ty, st]);
  const k = per60(0.35);
  shown[0] += (tx - shown[0]) * k;
  shown[1] += (ty - shown[1]) * k;
  return shown;
}

// Where two drawn strings cross, for the sparks.
function meet(a, b) {
  const [p0, p1, p2, p3] = [a[0], a[1], a[2] - a[0], a[3] - a[1]];
  const [q0, q1, q2, q3] = [b[0], b[1], b[2] - b[0], b[3] - b[1]];
  const den = p2 * q3 - p3 * q2;
  if (Math.abs(den) < 1e-9) return null;
  const u = ((q0 - p0) * q3 - (q1 - p1) * q2) / den;
  const v = ((q0 - p0) * p3 - (q1 - p1) * p2) / den;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [p0 + p2 * u, p1 + p3 * u];
}

let myPos = null;      // [x, y]: where your kite is drawn
function draw(now) {
  const b = agreedAt(now);
  if (!b) {
    drawSky(null, now, false);
    myPos = shown = null;
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
  drawSky(t, now, storm(t));
  const me = myId();
  const ids = playersIn(t).sort((a, c) => t.p[a].k - t.p[c].k);

  // Where every kite is drawn: yours from the guess, the rest from the agreed sky.
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
      at.set(me, [s[0], s[1], pos[2]]);
    }
  }
  const dOf = (id) => (id === me && m && m.to.p[me] ? m.to.p[me] : t.p[id]);
  myPos = at.has(me) && dOf(me).st === 0 ? at.get(me) : null;
  if (!at.has(me)) shown = null;

  // Strings first, under every kite; a cut kite trails what is left of its own.
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos || d.st !== 0) continue;
    drawString(d, pos[0], pos[1], SEAT[d.k], id === me, now);
  }
  // Sparks where a string is being sawn, and the sound of it when it is yours.
  sparks.length = 0;
  for (const id of ids) {
    const d = t.p[id];
    if (d.sw === -1 || !t.p[d.sw]) continue;
    const a = at.get(id), c = at.get(d.sw);
    if (!a || !c) continue;
    const s1 = [...hands(d), a[0], a[1]], s2 = [...hands(t.p[d.sw]), c[0], c[1]];
    const x = meet(s1, s2);
    if (!x) continue;
    sparks.push([x[0], x[1], SEAT[t.p[d.sw].k]]);
    inField();
    ctx.fillStyle = `rgba(255,246,200,${0.5 + 0.5 * Math.random()})`;
    disc(x[0], x[1], 0.008 + 0.006 * Math.random());
    ctx.fill();
    if (id === me) sound.saw(false);
    else if (d.sw === me) sound.saw(true);
  }
  if (t.L) drawLantern(t.L, now);
  for (const id of ids) {
    const d = dOf(id), pos = at.get(id);
    if (!pos) continue;
    if (d.st === 0) drawKite(id, pos[0], pos[1], pos[2], d, SEAT[d.k], id === me, now, false);
    else if (d.st === 1) {
      // Cut loose: the kite tumbles off with a scrap of string under it.
      inField();
      ctx.strokeStyle = SEAT[d.k];
      ctx.lineWidth = 1.2 / sc;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(pos[0], pos[1]);
      ctx.quadraticCurveTo(pos[0] - 0.05, pos[1] + 0.08, pos[0] + Math.sin(now / 150) * 0.03, pos[1] + 0.16);
      ctx.stroke();
      ctx.globalAlpha = 1;
      drawKite(id, pos[0], pos[1], 0, d, SEAT[d.k], id === me, now, true);
    }
  }
  // The leader wears a crown: cutting them pays a bounty.
  if (t.ph === PLAY) {
    for (const id of ids) {
      const d = dOf(id), pos = at.get(id);
      if (pos && d.st === 0 && leads(t, id)) drawCrown(pos[0], pos[1] - 0.085, now);
    }
  }
  flat();
  for (const id of ids) {
    const d = dOf(id);
    drawFlyer(d, SEAT[d.k], id === me, d.st === 0);
  }
  // Names on the ground under the flyers, so a cut has somebody to be aimed at.
  for (const id of ids) {
    const d = t.p[id];
    const room_ = VW < 420 ? 60 : 90;
    fitText(id === me ? 'you' : nickOf(id), SX(d.ax), Math.min(VH - 22, SY(GROUND + KR) + 13), 11, id === me ? INK.text : INK.muted, room_);
    if (d.st === 2 && t.ph !== COUNT) {
      const left = Math.max(0, DOWN - d.t);
      fitText('up in ' + Math.ceil(left / HZ), SX(d.ax), SY(AY) - 12, 11, INK.dim, room_);
    }
  }
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawBits();
  // Your own string under the saw: the edges of the screen flush red.
  const mine = t.p[me];
  if ((mine && mine.sw !== -1) || flash > 0.05) {
    const k = Math.max(flash, mine && mine.sw !== -1 ? 0.5 + 0.3 * Math.sin(now / 70) : 0);
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    g.addColorStop(0, 'rgba(255,90,110,0)');
    g.addColorStop(1, `rgba(255,90,110,${0.35 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: a direction in thousandths. Setting off and letting go
// go out at once; a change of direction while flying goes out no oftener than
// TURN_EVERY, because a thumb moving in a circle changes it on every move the
// screen reports, and the clock's ticks share the same seat's ceiling on
// messages.
const TURN_EVERY = 110;
let wanted = [0, 0];
let lastSaid = [0, 0];
let saidAt = -1e9;

function shove(fx_, fy_) {
  const far = Math.hypot(fx_, fy_);
  wanted = far < 0.01 ? [0, 0] : [Math.round((fx_ / far) * 1000), Math.round((fy_ / far) * 1000)];
  sayHand(performance.now());
}
function sayHand(now) {
  const d = wanted;
  if (Math.hypot(d[0] - lastSaid[0], d[1] - lastSaid[1]) < 80) return;
  const still = (v) => v[0] === 0 && v[1] === 0;
  if (!still(d) && !still(lastSaid) && now - saidAt < TURN_EVERY) return;
  lastSaid = d;
  saidAt = now;
  setHand([d[0], d[1]]);
}

// Keys are read by where they sit, not what they type, so every layout flies.
const RUN_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
const keys = new Set();
function fromKeys() {
  let dx = 0, dy = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1;
  return [dx, dy];
}
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (!RUN_KEYS.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  keys.add(e.code);
  if (!stick && !mouse) shove(...fromKeys());
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (!stick && !mouse) shove(...fromKeys());
});
addEventListener('blur', () => { keys.clear(); dropStick(); mouse = null; shove(0, 0); });

// A thumb: a stick from wherever it lands — a drag rather than a press,
// because iOS keeps a long press inside a frame for itself.
// A mouse: hold the button and the kite flies toward the pointer.
const DEAD = 8;
const REACHOUT = 46;
let stick = null;
let mouse = null;

function dropStick() {
  stick = null;
  paintStick(0, 0);
  if (!mouse) shove(...fromKeys());
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
  mouse = { id: e.pointerId, x: e.clientX, y: e.clientY };
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    paintStick(dx, dy);
    const still = Math.hypot(dx, dy) < DEAD;
    shove(still ? 0 : dx, still ? 0 : dy);
  } else if (mouse && e.pointerId === mouse.id) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
});
function lift(e) {
  if (stick && e.pointerId === stick.id) dropStick();
  else if (mouse && e.pointerId === mouse.id) {
    mouse = null;
    shove(...fromKeys());
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

// The mouse steers toward the pointer while held, and lets go of the kite
// once the pointer sits on it, rather than twitching round it.
function steerToMouse() {
  if (!mouse) return;
  if (!myPos) { shove(0, 0); return; }
  const r = cv.getBoundingClientRect();
  const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]);
  if (Math.hypot(dx, dy) < 10) shove(0, 0);
  else shove(dx, dy);
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
// a flyer arrives and sends a kite up.
function start() {
  setHand([0, 0]);
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
