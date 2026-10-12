/**
 * @disk     grapple
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    A brawl on a floating island where you never steer. Hold to hook a post and whirl round it, let go to fly, and slam rivals off the edge. A hard hit snaps a rope, the island crumbles from the rim, and whoever falls haunts the posts and can put their lights out.
 * @tags     game, party, realtime, physics, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/grapple.png
 */
// grapple.js — a one-button brawl in lockstep: nobody steers, they swing.
//
// A stone island floats over the clouds with lamp posts standing on it. Your
// pod slides wherever it was going, slowing as it goes. Hold the button and a
// rope shoots to the post nearest where you point — if it is in reach — and
// you whirl round it, faster with every turn as the rope reels in. Let go and
// you fly off along the turn. That is the whole control, and the whole game is
// in when you grab and when you let go: fly into a rival and they take your
// speed; a pod that slides off the edge without a rope on a post falls.
// Whoever hit it last scores the knockout. A rope holds a swinging pod on the
// island, but a hit hard enough snaps it.
//
// A round is last one standing. The island crumbles from the rim once a round
// is under way, taking its posts with it. A pod that falls is not out of the
// game: it haunts the island as a ghost, and a ghost can blow out a post for a
// moment — every rope on it snaps, and a pod sent off the edge that way is the
// ghost's knockout. Knockouts and the last one standing score toward a match;
// whoever trails the leader far enough throws a longer rope.
//
// Every copy holds the whole island and moves it only on what comes back round
// the room, so every copy applies the same hands in the same order and holds
// the same pods. Nobody sends where they are, a hit or a knockout: a hand is
// whether the button is held and where the pointer is. Which post a rope
// catches, how fast a pod swings and who scored are the table's business, the
// same arithmetic on the same numbers on every machine.
//
// While a player is alone, a bot plays with them. Its hand is a function of
// the table alone, so it plays the same on every copy and says nothing over
// the wire. When a second player arrives, practice runs on for three seconds
// under a note that says so, and the bot leaves before the round is laid out:
// it never plays in a round.
//
// Your own pod does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hands already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.floor`, `Math.abs`, `Math.min`, `Math.max` and
// `Math.imul` are fixed by the language to the last bit; `Math.sin` and
// `Math.cos` are not, so where the pods start on the island comes from a series
// written out here.

const TAU = 6.283185307179586;
function sincos(a) {
  a -= Math.floor(a / TAU + 0.5) * TAU;
  const a2 = a * a;
  let s = 0, c = 0, ts = a, tc = 1;
  for (let i = 0; i < 10; i++) {
    s += ts;
    c += tc;
    ts *= -a2 / ((2 * i + 2) * (2 * i + 3));
    tc *= -a2 / ((2 * i + 1) * (2 * i + 2));
  }
  return [s, c];
}

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the island a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own pod a trip ahead, with your hands in it
const DT = 1 / HZ;
const SUB = 3;                 // pieces a step is cut into, so no pod flies through another
const SDT = DT / SUB;

const FW = 1.4, FH = 1;        // the field, in units
const CX = 0.7, CY = 0.5;      // the island's centre
const IA = 0.62, IB = 0.42;    // the island's half-width and half-height at full size
const PR = 0.026;              // a pod's radius
const QR = 0.011;              // a post's
const REACH = 0.3;             // how far a rope reaches
const REACH_LONG = 0.36;       // and for whoever trails the leader far enough
const TRAIL_BY = 3;            // points behind the leader that earn the longer rope
const ROPE_MIN = 0.085;        // a rope reels in no shorter than this
const REEL = 0.22;             // how fast a rope reels in, units a second
const SWING_A = 1.15;          // how hard a rope whirls a pod along its turn, a second
const SWING_MAX = 1.35;        // the turn adds speed up to this
const V_CAP = 2.4;             // the fastest anything is ever thrown
const FR_FREE = 1.5;           // what the stone takes off a sliding pod, a second
const FR_ROPE = 0.25;          // and off a swinging one
// A rope carries a pod round its turn, but a blow that throws the pod outward
// faster than this snaps it: nobody is safe on a post for ever.
const SNAP_V = 0.9;
const POD_E = 1;               // what two pods give back to each other
const KNOCK = 0.16;            // and the extra shove a real hit adds to both
const HIT_MIN = 0.15;          // closing faster than this is a hit
const POST_E = 0.5;
const HIT_MEM = 4 * HZ;        // a pod that falls this soon after a hit is the hitter's knockout
const RE_CD = 4;               // steps after letting go before a rope flies again
const SNAP_CD = 18;            // and after a rope snaps
const GHOST_V = 0.45;          // how fast a ghost drifts
const SNUFF_R = 0.075;         // how near a post a ghost must be to blow it out
const SNUFF_STEPS = Math.round(1.5 * HZ);  // a post blown out stays dark this long
const GHOST_CD = 4 * HZ;       // and the ghost must wait this long to do it again
const RESPAWN_STEPS = Math.round(1.5 * HZ); // practice: a fallen pod is back after this
const MAX_P = 8;
const MAX_Q = 20;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const ROUND_STEPS = 80 * HZ;
const SHRINK_FROM = 15 * HZ;   // steps into a round before the rim starts to crumble
const SHRINK_LEN = 45 * HZ;    // and how long it crumbles for
const S_MIN = 0.34;            // what is left of the island once it stops
const END_STEPS = 6 * HZ;
const MATCH = 10;              // points that take the match
const KO_PTS = 1, LAST_PTS = 2, TIME_PTS = 1;

// ── the table ──────────────────────────────────────────────────────────────
//   rng: the draws; ph, pt: the phase and the steps left in it (in practice,
//   the count after a second player arrives, 0 for none); rd: rounds begun;
//   s: how much of the island stands, in thousandths; q: the posts, each
//   [x, y, steps it stays dark, 1 once fallen]; p: the pods by id; res: the
//   last round's [id, knockouts, points, 1 if standing] rows; win: its winner,
//   or -1 for none; ch: the player who took the match that round, or -1
function freshTable(seed) {
  const t = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, s: 1000, q: [], p: {}, res: null, win: -1, ch: -1 };
  layPosts(t);
  return t;
}

const FIELDS = ['k', 'x', 'y', 'vx', 'vy', 'hk', 'L', 'rot', 'h', 'ax', 'ay', 'cd', 'al', 'fl', 'sc', 'ko',
  'lh', 'lt', 'gc', 'ht', 'bw', 'hs', 'hc'];
//   k: seat, which is its colour; x, y, vx, vy: the pod, or its ghost; hk: the
//   post its rope is on, -1 for none; L: the rope's length; rot: which way it
//   whirls, 1 or -1; h, ax, ay: the hand — the button, and where it points in
//   thousandths of a unit, -1 for nowhere; cd: steps before a rope may fly;
//   al: 1 on the island, 0 a ghost; fl: steps since it fell (practice: steps
//   until it is back); sc: points this match; ko: knockouts this round; lh,
//   lt: who hit it or blew its post out last, and how many steps that still
//   counts; gc: steps before a ghost may blow a post out again; ht: steps on
//   its rope; bw: the bot's pause; hs, hc: hands this step.
function pod(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const sorted = (w) => playersIn(w).sort((a, b) => a - b);
const bySeat = (w) => sorted(w).sort((a, b) => w.p[a].k - w.p[b].k);

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// Where a point stands against the island's edge: below 1 is on it.
const scaleOf = (w) => w.s / 1000;
function edgeOf(x, y, s) {
  const u = (x - CX) / (IA * s), v = (y - CY) / (IB * s);
  return u * u + v * v;
}

// The posts of a fresh island: one in the middle, the rest scattered over it
// no nearer to each other than a pod's swing needs.
function layPosts(w) {
  w.q = [[CX, CY, 0, 0]];
  for (let tries = 0; tries < 400 && w.q.length < 15; tries++) {
    const x = CX + (draw01(w) * 2 - 1) * IA, y = CY + (draw01(w) * 2 - 1) * IB;
    if (edgeOf(x, y, 1) > 0.8) continue;
    let ok = true;
    for (const q of w.q) if ((q[0] - x) * (q[0] - x) + (q[1] - y) * (q[1] - y) < 0.17 * 0.17) { ok = false; break; }
    if (ok) w.q.push([Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000, 0, 0]);
  }
}

const postUp = (q) => q[3] === 0;
const postLit = (q) => q[3] === 0 && q[2] === 0;

// How far a player's rope reaches: further for whoever trails the leader by
// enough in a match, which is what keeps them swinging for it.
function reachOf(w, id) {
  if (w.ph === WAIT) return REACH;
  const hs = humans(w);
  if (hs.length < 2) return REACH;
  let hi = -Infinity;
  for (const h of hs) hi = Math.max(hi, w.p[h].sc);
  return hi - w.p[id].sc >= TRAIL_BY ? REACH_LONG : REACH;
}

// The post a rope thrown now would catch: of the lit posts in reach, the one
// nearest where the hand points, or the nearest of all when it points nowhere.
// The same function shows a player which post they would catch.
function pickPost(w, x, y, ax, ay, reach) {
  let best = -1, bd = Infinity;
  const tx = ax < 0 ? x : ax / 1000, ty = ax < 0 ? y : ay / 1000;
  for (let i = 0; i < w.q.length; i++) {
    const q = w.q[i];
    if (!postLit(q)) continue;
    const dx = q[0] - x, dy = q[1] - y;
    if (dx * dx + dy * dy > reach * reach) continue;
    const ex = q[0] - tx, ey = q[1] - ty, e = ex * ex + ey * ey;
    if (e < bd) { bd = e; best = i; }
  }
  return best;
}

// A pod put down on the island, still, with no rope out.
function setDown(d, x, y) {
  d.x = x; d.y = y; d.vx = 0; d.vy = 0; d.hk = -1; d.L = 0; d.cd = RE_CD; d.al = 1; d.fl = 0;
  d.lh = 0; d.lt = 0; d.gc = 0; d.ht = 0;
}

// A free place for a pod: somewhere on the inner island, clear of the posts
// and of every other pod, as the draw finds one.
function freeSpot(w, id) {
  let x = CX, y = CY;
  for (let i = 0; i < 24; i++) {
    const [s, c] = sincos(draw01(w) * TAU);
    const r = 0.25 + draw01(w) * 0.35;
    x = CX + c * IA * r; y = CY + s * IB * r;
    let ok = true;
    for (const q of w.q) if ((q[0] - x) * (q[0] - x) + (q[1] - y) * (q[1] - y) < (PR + QR + 0.02) * (PR + QR + 0.02)) ok = false;
    for (const o of playersIn(w)) {
      const e = w.p[o];
      if (o !== id && e.al && (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y) < 16 * PR * PR) ok = false;
    }
    if (ok) break;
  }
  return [x, y];
}

function newPod(w, id) {
  const d = (w.p[id] = pod({
    k: freeSeat(w), x: CX, y: CY, vx: 0, vy: 0, hk: -1, L: 0, rot: 1, h: 0, ax: -1, ay: -1, cd: 0, al: 1, fl: 0,
    sc: 0, ko: 0, lh: 0, lt: 0, gc: 0, ht: 0, bw: 0, hs: w.n, hc: 0,
  }));
  if (w.ph === WAIT || w.ph === COUNT) {
    const [x, y] = freeSpot(w, id);
    setDown(d, x, y);
    fx(w, 'spawn', d.x, d.y, id);
  } else {
    // Arriving in the middle of a round, a player haunts it until the next.
    d.al = 0; d.fl = HZ; d.x = CX; d.y = 0.08;
  }
  return d;
}

// A hand, at its place in the room's order: [button, point x, point y]. Being
// heard is how a player arrives.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = newPod(w, id);
  }
  // A flood of hands in one step is cut off where no player's thumb could
  // reach, on every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.h = input[0];
  d.ax = input[1];
  d.ay = input[2];
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
// A point is somewhere on the field or nowhere at all, and a hand that points
// nowhere does so on both axes.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  if (!raw.every(Number.isInteger)) return null;
  const [h, ax, ay] = raw;
  if (h < 0 || h > 1) return null;
  if (ax === -1 && ay === -1) return [h, -1, -1];
  if (ax < 0 || ax > FW * 1000 || ay < 0 || ay > FH * 1000) return null;
  return [h, ax, ay];
}

function leave(w, id) {
  delete w.p[id];
  for (const d of Object.values(w.p)) if (d.lh === id) { d.lh = 0; d.lt = 0; }
}

// The bot plays practice and is never in a round.
const BOT_ID = -100;
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// ── the round ──────────────────────────────────────────────────────────────

// Every pod on a ring round the middle of a fresh island, in seat order.
function placeAll(w) {
  const ids = bySeat(w);
  const turn = draw01(w) * TAU;
  ids.forEach((id, i) => {
    const [s, c] = sincos(turn + (TAU * i) / ids.length);
    setDown(w.p[id], CX + c * IA * 0.58, CY + s * IB * 0.58);
    w.p[id].ko = 0;
  });
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.s = 1000;
  for (const q of w.q) { q[3] = 0; q[2] = 0; }
  for (const id of playersIn(w)) {
    const d = w.p[id];
    if (!d.al) { const [x, y] = freeSpot(w, id); setDown(d, x, y); }
  }
}

function beginRound(w) {
  w.rd += 1;
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.s = 1000;
  w.res = null;
  w.win = -1;
  if (w.ch !== -1) {
    // A match was taken last round: this one starts the next from nothing.
    for (const id of playersIn(w)) w.p[id].sc = 0;
    w.ch = -1;
  }
  layPosts(w);
  placeAll(w);
  fx(w, 'round');
}

function endRound(w, timeUp) {
  const standing = sorted(w).filter((id) => w.p[id].al);
  if (standing.length === 1 && !timeUp) {
    w.p[standing[0]].sc += LAST_PTS;
    w.win = standing[0];
  } else {
    if (timeUp) for (const id of standing) w.p[id].sc += TIME_PTS;
    w.win = -1;
  }
  const order = sorted(w).sort((a, b) => w.p[b].sc - w.p[a].sc || w.p[b].ko - w.p[a].ko || a - b);
  const top = order[0], next = order[1];
  w.ch = -1;
  if (top !== undefined && w.p[top].sc >= MATCH && (next === undefined || w.p[next].sc < w.p[top].sc)) w.ch = top;
  w.res = order.map((id) => { const d = w.p[id]; return [id, d.ko, d.sc, d.al]; });
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, w.win, w.ch);
}

// ── a pod's own step ───────────────────────────────────────────────────────

function letGo(w, id, d, cd, kind) {
  if (d.hk < 0) return;
  d.hk = -1;
  d.ht = 0;
  d.cd = cd;
  fx(w, kind, d.x, d.y, id);
}

// The timers, a rope that loses its post, a rope let go, and a rope thrown
// while the button is held and a post is in reach.
function control(w, id, d) {
  if (d.cd > 0) d.cd -= 1;
  if (d.lt > 0) d.lt -= 1;
  if (d.gc > 0) d.gc -= 1;
  if (!d.al) {
    d.fl = Math.min(d.fl + 1, 9999);
    if (w.ph === WAIT && d.fl >= RESPAWN_STEPS) {
      const [x, y] = freeSpot(w, id);
      setDown(d, x, y);
      fx(w, 'spawn', x, y, id);
    }
    return;
  }
  if (d.hk >= 0) {
    if (!postLit(w.q[d.hk])) return letGo(w, id, d, SNAP_CD, 'snap');
    if (!d.h) return letGo(w, id, d, RE_CD, 'let');
    d.ht = Math.min(d.ht + 1, 9999);
    return;
  }
  if (!d.h || d.cd > 0) return;
  const i = pickPost(w, d.x, d.y, d.ax, d.ay, reachOf(w, id));
  if (i < 0) return;
  const q = w.q[i];
  const rx = d.x - q[0], ry = d.y - q[1], r = Math.sqrt(rx * rx + ry * ry);
  // It whirls the way the pod was already going round the post; a pod at rest
  // goes the way its seat does.
  const cross = rx * d.vy - ry * d.vx;
  d.rot = Math.abs(cross) > 0.02 * r ? (cross > 0 ? 1 : -1) : d.k % 2 ? -1 : 1;
  d.hk = i;
  d.L = clamp(r, ROPE_MIN, REACH_LONG);
  d.ht = 0;
  fx(w, 'hook', q[0], q[1], id, i);
}

// One piece of a step for a pod on a rope: the rope reels in and whirls it
// along its turn, and holds it at the rope's length — unless what throws it
// outward is more than the rope takes, and the rope snaps.
function swing(w, id, d) {
  const q = w.q[d.hk];
  let rx = d.x - q[0], ry = d.y - q[1], r = Math.sqrt(rx * rx + ry * ry);
  if (r < 1e-9) { rx = 1e-9; r = 1e-9; }
  if (d.L > ROPE_MIN) d.L = Math.max(ROPE_MIN, d.L - REEL * SDT);
  const tx = (-ry / r) * d.rot, ty = (rx / r) * d.rot;
  if (d.vx * tx + d.vy * ty < SWING_MAX) { d.vx += tx * SWING_A * SDT; d.vy += ty * SWING_A * SDT; }
  const k = 1 - FR_ROPE * SDT;
  d.vx *= k; d.vy *= k;
  d.x += d.vx * SDT;
  d.y += d.vy * SDT;
  rx = d.x - q[0]; ry = d.y - q[1]; r = Math.sqrt(rx * rx + ry * ry);
  if (r > d.L && r > 1e-9) {
    const ux = rx / r, uy = ry / r;
    const vr = d.vx * ux + d.vy * uy;
    if (vr > SNAP_V) return letGo(w, id, d, SNAP_CD, 'snap');
    d.x = q[0] + ux * d.L; d.y = q[1] + uy * d.L;
    if (vr > 0) { d.vx -= ux * vr; d.vy -= uy * vr; }
  }
}

// One piece of a step for a pod without a rope: it slides, and the stone
// slows it.
function slide(d) {
  const k = 1 - FR_FREE * SDT;
  d.vx *= k; d.vy *= k;
  d.x += d.vx * SDT;
  d.y += d.vy * SDT;
}

function capSpeed(d) {
  const sp = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
  if (sp > V_CAP) { d.vx *= V_CAP / sp; d.vy *= V_CAP / sp; }
}

// A ghost drifts toward where its hand points and, with the button held by a
// lit post, blows it out: every rope on it snaps, and the pods it held count
// the ghost as the last to have touched them.
function haunt(w, id, d) {
  if (d.ax >= 0) {
    const dx = d.ax / 1000 - d.x, dy = d.ay / 1000 - d.y, l = Math.sqrt(dx * dx + dy * dy);
    const go = Math.min(l, GHOST_V * DT);
    if (l > 1e-9) { d.x += (dx / l) * go; d.y += (dy / l) * go; }
  }
  d.x = clamp(d.x, 0.03, FW - 0.03);
  d.y = clamp(d.y, 0.03, FH - 0.03);
  d.vx = 0; d.vy = 0;
  if (!d.h || d.gc > 0 || w.ph === WAIT || w.ph === END) return;
  let best = -1, bd = SNUFF_R * SNUFF_R;
  for (let i = 0; i < w.q.length; i++) {
    const q = w.q[i];
    if (!postLit(q)) continue;
    const e = (q[0] - d.x) * (q[0] - d.x) + (q[1] - d.y) * (q[1] - d.y);
    if (e < bd) { bd = e; best = i; }
  }
  if (best < 0) return;
  w.q[best][2] = SNUFF_STEPS;
  d.gc = GHOST_CD;
  fx(w, 'snuff', w.q[best][0], w.q[best][1], id, best);
  for (const o of sorted(w)) {
    const e = w.p[o];
    if (e.al && e.hk === best) { e.lh = id; e.lt = HIT_MEM; letGo(w, o, e, SNAP_CD, 'snap'); }
  }
}

// Pods that touch push apart and trade what they were closing at; a real hit
// shoves both a little harder, and each remembers the other.
function collide(w, ids) {
  for (let i = 0; i < ids.length; i++) {
    const A = w.p[ids[i]];
    if (!A.al) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const B = w.p[ids[j]];
      if (!B.al) continue;
      const dx = B.x - A.x, dy = B.y - A.y, dd = dx * dx + dy * dy;
      if (dd >= 4 * PR * PR || dd < 1e-14) continue;
      const dist = Math.sqrt(dd), nx = dx / dist, ny = dy / dist, push = (2 * PR - dist) / 2;
      A.x -= nx * push; A.y -= ny * push;
      B.x += nx * push; B.y += ny * push;
      const rv = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
      if (rv >= 0) continue;
      let jn = (-(1 + POD_E) * rv) / 2;
      if (-rv > HIT_MIN) {
        jn += KNOCK;
        A.lh = ids[j]; A.lt = HIT_MEM;
        B.lh = ids[i]; B.lt = HIT_MEM;
        fx(w, 'bump', (A.x + B.x) / 2, (A.y + B.y) / 2, ids[i], ids[j], Math.round(-rv * 1000));
      }
      A.vx -= nx * jn; A.vy -= ny * jn;
      B.vx += nx * jn; B.vy += ny * jn;
    }
  }
  for (const id of ids) {
    const d = w.p[id];
    if (!d.al) continue;
    for (const q of w.q) {
      if (!postUp(q)) continue;
      const dx = d.x - q[0], dy = d.y - q[1], dd = dx * dx + dy * dy, R = PR + QR;
      if (dd >= R * R || dd < 1e-14) continue;
      const dist = Math.sqrt(dd), nx = dx / dist, ny = dy / dist;
      d.x = q[0] + nx * R; d.y = q[1] + ny * R;
      const vn = d.vx * nx + d.vy * ny;
      if (vn < 0) {
        d.vx -= nx * vn * (1 + POST_E); d.vy -= ny * vn * (1 + POST_E);
        if (-vn > 0.3) fx(w, 'post', q[0], q[1], id, 0, Math.round(-vn * 1000));
      }
    }
  }
}

// A pod off the edge with no rope to hold it falls. Whoever hit it, or blew
// out its post, not long before scores the knockout.
function falls(w, ids) {
  const s = scaleOf(w);
  for (const id of ids) {
    const d = w.p[id];
    if (!d.al || d.hk >= 0 || edgeOf(d.x, d.y, s) <= 1) continue;
    const by = d.lt > 0 && d.lh !== id && w.p[d.lh] ? d.lh : 0;
    if (by && w.ph === PLAY) { w.p[by].sc += KO_PTS; w.p[by].ko += 1; }
    fx(w, 'fall', d.x, d.y, id, by);
    d.al = 0;
    d.fl = 0;
    d.cd = 0;
    d.gc = Math.round(GHOST_CD / 2);
    d.x = clamp(d.x, 0.03, FW - 0.03);
    d.y = clamp(d.y, 0.03, FH - 0.03);
    d.vx = 0; d.vy = 0;
    d.lh = 0; d.lt = 0;
  }
}

// The rim crumbles once a round is under way, a little every step, and a post
// it reaches falls with it — snapping whatever rope was on it.
function crumble(w) {
  const e = ROUND_STEPS - w.pt;
  if (e < SHRINK_FROM) return;
  const k = Math.min(1, (e - SHRINK_FROM) / SHRINK_LEN);
  const s = Math.round(1000 - (1000 - S_MIN * 1000) * k);
  if (s >= w.s) return;
  if (w.s === 1000) fx(w, 'crack');
  w.s = s;
  const sc = s / 1000;
  w.q.forEach((q, i) => {
    if (!postUp(q) || edgeOf(q[0], q[1], sc) <= 0.94) return;
    q[3] = 1;
    fx(w, 'drop', q[0], q[1], 0, i);
  });
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_EVERY = 3;           // steps between the bot's decisions

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && Object.keys(w.p).length < MAX_P) newPod(w, BOT_ID);
  else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

function botPoint(d, x, y) {
  d.ax = clamp(Math.round(x * 1000), 0, FW * 1000);
  d.ay = clamp(Math.round(y * 1000), 0, FH * 1000);
}

// The bot's mind, a function of the table alone. Sliding toward the edge, it
// grabs the post nearest the middle. Swinging fast with a rival straight
// ahead along its turn, it lets go — late now and then. Slowing down in the
// open, it grabs the post nearest a rival to whirl up toward them. Every so
// often it stands and thinks.
function botHand(w) {
  const d = w.p[BOT_ID];
  if (!d || !d.al || w.n % BOT_EVERY) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (draw01(w) < 0.03) { d.bw = 3 + Math.floor(draw01(w) * 6); return; }
  let target = null, td = Infinity;
  for (const id of humans(w)) {
    const e = w.p[id];
    if (!e.al) continue;
    const q = (e.x - d.x) * (e.x - d.x) + (e.y - d.y) * (e.y - d.y);
    if (q < td) { td = q; target = e; }
  }
  const sp = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
  const s = scaleOf(w);
  const danger = edgeOf(d.x + d.vx * 0.5, d.y + d.vy * 0.5, s) > 0.8;
  if (d.hk >= 0) {
    if (!target) { if (d.ht > 3 * HZ) d.h = 0; return; }
    const dx = target.x - d.x, dy = target.y - d.y, l = Math.sqrt(dx * dx + dy * dy) || 1;
    const lined = sp > 0.8 && (d.vx * dx + d.vy * dy) / (sp * l) > 0.93 && l < 0.6;
    if ((lined && draw01(w) < 0.7) || d.ht > 5 * HZ) d.h = 0;
    return;
  }
  if (danger) { d.h = 1; botPoint(d, CX, CY); return; }
  if (sp < 0.4) {
    d.h = 1;
    if (target) botPoint(d, target.x, target.y); else { d.ax = -1; d.ay = -1; }
  } else d.h = 0;
}

// One step of the island: a function of the island alone.
function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting table otherwise leaves at zero. The bot goes first, so
    // the round is laid out without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); beginRound(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = ROUND_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt <= 0) endRound(w, true);
    } else if (w.pt <= 0) {
      beginRound(w);
    }
  }

  const ids = sorted(w);
  for (const q of w.q) if (q[2] > 0) q[2] -= 1;
  if (w.ph === COUNT) {
    // Laid out: every pod stands where it was put, ropes in.
    for (const id of ids) { const d = w.p[id]; d.vx = 0; d.vy = 0; d.hk = -1; d.cd = RE_CD; }
    return;
  }
  if (w.ph === PLAY) crumble(w);
  botHand(w);
  for (const id of ids) {
    const d = w.p[id];
    control(w, id, d);
    if (!d.al) haunt(w, id, d);
  }
  for (let s = 0; s < SUB; s++) {
    for (const id of ids) {
      const d = w.p[id];
      if (!d.al) continue;
      if (d.hk >= 0) swing(w, id, d); else slide(d);
      capSpeed(d);
    }
    collide(w, ids);
  }
  falls(w, ids);
  if (w.ph === PLAY && ids.filter((id) => w.p[id].al).length <= 1) endRound(w, false);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG) || !int(raw.s, 0, 1000)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, ROUND_STEPS)) return null;
  if (!Array.isArray(raw.q) || raw.q.length > MAX_Q) return null;
  const q = [];
  for (const v of raw.q) {
    if (!Array.isArray(v) || v.length !== 4) return null;
    if (!num(v[0], 0, FW) || !num(v[1], 0, FH) || !int(v[2], 0, SNUFF_STEPS) || !int(v[3], 0, 1)) return null;
    q.push([v[0], v[1], v[2], v[3]]);
  }
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.k, 0, MAX_P - 1) || seats.has(d.k)) return null;
    if (!num(d.x, -1, 3) || !num(d.y, -1, 3) || !num(d.vx, -9, 9) || !num(d.vy, -9, 9)) return null;
    if (!int(d.hk, -1, q.length - 1) || !num(d.L, 0, 1) || (d.rot !== 1 && d.rot !== -1)) return null;
    if (inputOf([d.h, d.ax, d.ay]) === null) return null;
    if (!int(d.cd, 0, SNAP_CD) || !int(d.al, 0, 1) || !int(d.fl, 0, 9999)) return null;
    if (!int(d.sc, 0, 99999) || !int(d.ko, 0, 999) || !int(d.lh, -BIG, BIG) || !int(d.lt, 0, HIT_MEM)) return null;
    if (!int(d.gc, 0, GHOST_CD) || !int(d.ht, 0, 9999) || !int(d.bw, 0, 99)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    seats.add(d.k);
    p[id] = pod(d);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push([r[0], r[1], r[2], r[3]]);
    }
  }
  if (!int(raw.win, -BIG, BIG) || !int(raw.ch, -BIG, BIG)) return null;
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, s: raw.s, q, p, res, win: raw.win, ch: raw.ch };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: dusk over a sea of cloud — a violet sky warming to rose at the
// horizon, a slate island with moss in its joints and a dark cliff under it,
// brass lamp posts, and a bright colour for each seat that is its pod's, its
// rope's and its chip's.
const INK = {
  sky: '#1c1740', skyLo: '#4a2b5e', glow: '#a8577a', cloud: 'rgba(255,214,236,0.07)', cloudHi: 'rgba(255,230,245,0.12)',
  stone: '#5d6684', stoneHi: '#7a84a3', joint: 'rgba(20,22,40,0.28)', moss: 'rgba(120,170,110,0.32)',
  cliff: '#2b2c46', cliffLo: '#17172b', rim: '#9aa3c4', text: '#fbf6ff', muted: '#d8d0ec', dim: '#a49cc4',
  gold: '#ffd166', danger: '#ff5a6e', panel: 'rgba(20,14,40,0.93)', brass: '#d9a94e', brassHi: '#ffe7a8',
  lamp: '#ffe08a', dark: '#545a72', ghost: 'rgba(235,240,255,0.5)',
};
const SEAT = ['#ff5d73', '#3ec1d3', '#ffd23f', '#9b7bff', '#ff9f43', '#5bd17a', '#f5f5f5', '#ff7ad9'];
const FONT = "600 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.sky};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%;cursor:crosshair;touch-action:none';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');
const bg = document.createElement('canvas');
const bgx = bg.getContext('2d');
let bgKey = '';

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #5a4a86;' +
  `background:#2a2050;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 480, sc = 1, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1;
let fieldBox = [0, 0, 0, 0];   // left, top, right, bottom on the screen
// NOTE_ROOM under the field keeps the practice note off the foot of the
// island, where a pod about to fall needs to be seen.
const NOTE_ROOM = 60;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 480;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  bg.width = cv.width;
  bg.height = cv.height;
  bgKey = '';
  dpx = dpr;
  TOP = VW < 420 ? 66 : 58;
  BOT = 26;
  const aw = VW - 12, ah = Math.max(60, VH - TOP - BOT - NOTE_ROOM);
  sc = Math.max(10, Math.min(aw / FW, ah / FH));
  ox = (VW - sc * FW) / 2;
  oy = TOP + (ah - sc * FH) / 2;
  fieldBox = [ox, oy, ox + sc * FW, oy + sc * FH];
}
layout();
window.addEventListener('resize', layout);

const P = (x, y) => [ox + x * sc, oy + y * sc];
function fieldOn(c, sx, sy) { c.setTransform(dpx * sc, 0, 0, dpx * sc, dpx * (ox + sx), dpx * (oy + sy)); }
function inField() { fieldOn(ctx, shakeX, shakeY); }
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

function nickOf(id) {
  if (id === BOT_ID) return 'bot';
  if (room.me && id === room.me.id) return room.me.nick;
  const p = room.players.find((x) => x.id === id);
  const nick = p ? String(p.nick) : 'p' + id;
  return nick.length > 12 ? nick.slice(0, 11) + '…' : nick;
}
const ord = (n) => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

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
function roundRect(x, y, w, h, r, c) {
  c = c || ctx;
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function disc(x, y, r, c) {
  c = c || ctx;
  c.beginPath();
  c.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}
function oval(c, x, y, a, b) {
  c.beginPath();
  c.ellipse(x, y, Math.max(0, a), Math.max(0, b), 0, 0, Math.PI * 2);
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
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Easing per frame, scaled to the frame's length so a fast screen and a slow
// one settle at the same pace.
let frameDt = 1 / 60, lastFrame = 0;
const per60 = (k) => 1 - Math.pow(1 - k, frameDt * 60);
const ease = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
const lerp = (a, b, k) => a + (b - a) * k;

// ── the sky, painted once a size ───────────────────────────────────────────
// A fixed scatter for the drawing alone, so the clouds and the moss stand in
// the same places on every frame and every screen.
function scatter(seed, n) {
  let s = seed;
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  for (let i = 0; i < n; i++) out.push([r(), r(), r(), r()]);
  return out;
}
const CLOUDS = scatter(7, 22);
const MOSS = scatter(31, 70);
const STARS = scatter(91, 60);

function paintSky() {
  const c = bgx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  const g0 = c.createLinearGradient(0, 0, 0, bg.height);
  g0.addColorStop(0, INK.sky);
  g0.addColorStop(0.62, INK.skyLo);
  g0.addColorStop(1, INK.glow);
  c.fillStyle = g0;
  c.fillRect(0, 0, bg.width, bg.height);
  c.fillStyle = 'rgba(255,255,255,0.5)';
  for (const [x, y, k] of STARS) {
    if (y > 0.5) continue;
    c.globalAlpha = 0.2 + k * 0.5;
    c.fillRect(x * bg.width, y * bg.height, (1 + k) * dpx, (1 + k) * dpx);
  }
  c.globalAlpha = 1;
  // A sea of cloud in the lower half, in soft banks.
  for (const [x, y, k, j] of CLOUDS) {
    const cy = bg.height * (0.55 + y * 0.5), cx = bg.width * x, r = bg.width * (0.07 + k * 0.1);
    c.fillStyle = j > 0.5 ? INK.cloudHi : INK.cloud;
    c.beginPath();
    c.ellipse(cx, cy, r, r * 0.38, 0, 0, Math.PI * 2);
    c.fill();
  }
}

function drawSky(now) {
  const key = VW + 'x' + VH + ':' + dpx;
  if (key !== bgKey) { paintSky(); bgKey = key; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bg, 0, 0);
  // A few clouds drift slowly past under the island.
  flat();
  for (let i = 0; i < 5; i++) {
    const [x, y, k] = CLOUDS[i];
    const X = ((x * VW + (now / 1000) * (6 + k * 8)) % (VW + 240)) - 120, Y = VH * (0.62 + y * 0.32);
    ctx.fillStyle = INK.cloud;
    oval(ctx, X, Y, 70 + k * 60, 18 + k * 10);
    ctx.fill();
  }
}

// The island at how much of it stands: a dark cliff under a slate top, rings
// of paving and moss in the joints, the rim lit pale — and, while it
// crumbles, the rim flushed red.
function drawIsland(s, crumbling, now) {
  inField();
  const a = IA * s, b = IB * s;
  ctx.fillStyle = 'rgba(10,6,24,0.35)';
  oval(ctx, CX + 0.01, CY + 0.075, a * 1.02, b * 1.0);
  ctx.fill();
  const gc = ctx.createLinearGradient(0, CY, 0, CY + b + 0.06);
  gc.addColorStop(0, INK.cliff);
  gc.addColorStop(1, INK.cliffLo);
  ctx.fillStyle = gc;
  oval(ctx, CX, CY + 0.04, a, b);
  ctx.fill();
  ctx.fillRect(CX - a, CY, 2 * a, 0.04);
  const g = ctx.createRadialGradient(CX - a * 0.3, CY - b * 0.4, 0.02, CX, CY, Math.max(a, b));
  g.addColorStop(0, INK.stoneHi);
  g.addColorStop(1, INK.stone);
  ctx.fillStyle = g;
  oval(ctx, CX, CY, a, b);
  ctx.fill();
  ctx.save();
  oval(ctx, CX, CY, a, b);
  ctx.clip();
  ctx.strokeStyle = INK.joint;
  ctx.lineWidth = 0.003;
  // Rings of paving laid at full size, so the rim cuts through them as it goes.
  for (let r = 0.12; r < 1.05; r += 0.12) { oval(ctx, CX, CY, IA * r, IB * r); ctx.stroke(); }
  for (let i = 0; i < 16; i++) {
    const q = (i / 16) * TAU, c = Math.cos(q), n = Math.sin(q);
    ctx.beginPath(); ctx.moveTo(CX + c * IA * 0.12, CY + n * IB * 0.12); ctx.lineTo(CX + c * IA, CY + n * IB); ctx.stroke();
  }
  ctx.fillStyle = INK.moss;
  for (const [u, v, k] of MOSS) {
    const q = u * TAU, r = 0.15 + v * 0.85;
    disc(CX + Math.cos(q) * IA * r, CY + Math.sin(q) * IB * r, 0.004 + k * 0.01);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = crumbling ? alpha(INK.danger, 0.55 + 0.35 * Math.sin(now / 140)) : 'rgba(220,226,255,0.55)';
  ctx.lineWidth = crumbling ? 0.006 : 0.004;
  oval(ctx, CX, CY, a, b);
  ctx.stroke();
}

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
  g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
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
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(actx.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}
const sound = {
  hook(mine) { if (ready('hook', 60)) { tone(1800, 0.05, 'square', mine ? 0.05 : 0.016, 0.5); tone(600, 0.08, 'triangle', mine ? 0.06 : 0.02, 1.6, 0.02); } },
  let(mine) { if (ready('let', 60)) puff(0.18, mine ? 0.12 : 0.04, 1400, 0, 0.9); },
  snap(mine) { if (ready('snap', 80)) { tone(2600, 0.04, 'sawtooth', mine ? 0.07 : 0.025, 0.3); puff(0.1, mine ? 0.14 : 0.05, 3000, 0, 2); } },
  bump(mine, k) {
    if (!ready('bump', 70)) return;
    const v = Math.min(1, 0.35 + k);
    tone(150, 0.16, 'triangle', (mine ? 0.13 : 0.05) * v, 0.5);
    puff(0.09, (mine ? 0.2 : 0.07) * v, 500, 0, 1);
  },
  post(k) { if (ready('post', 60)) tone(880, 0.09, 'triangle', 0.03 * Math.min(1, 0.4 + k), 0.8); },
  fall(mine) { if (ready('fall', 120)) { tone(mine ? 620 : 520, 0.7, 'sine', mine ? 0.09 : 0.035, 0.25); puff(0.5, mine ? 0.08 : 0.03, 700, 0.05, 0.7, 'lowpass'); } },
  ko() { if (ready('ko', 200)) [659, 880, 1175].forEach((f, i) => tone(f, 0.16, 'triangle', 0.08, 0, i * 0.06)); },
  snuff(mine) { if (ready('snuff', 120)) { puff(0.35, mine ? 0.14 : 0.05, 900, 0, 0.6, 'lowpass'); tone(330, 0.3, 'sine', mine ? 0.05 : 0.02, 0.5); } },
  drop() { if (ready('drop', 120)) { puff(0.3, 0.06, 260, 0, 0.8, 'lowpass'); tone(200, 0.3, 'sine', 0.03, 0.5); } },
  crack() { if (ready('crack', 600)) { puff(0.6, 0.12, 180, 0, 0.6, 'lowpass'); [294, 247, 196].forEach((f, i) => tone(f, 0.2, 'sawtooth', 0.035, 0, i * 0.1)); } },
  spawn() { if (ready('spawn', 150)) tone(700, 0.12, 'sine', 0.03, 1.5); },
  beep() { if (ready('beep', 200)) tone(440, 0.16, 'square', 0.06); },
  go() { if (ready('go', 300)) { tone(880, 0.3, 'square', 0.07); tone(1760, 0.26, 'sine', 0.04, 1.0, 0.05); } },
  end(won) {
    if (!ready('end', 500)) return;
    if (won) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, 'triangle', 0.1, 0, i * 0.09));
    else [392, 330, 262].forEach((f, i) => tone(f, 0.26, 'triangle', 0.07, 0, i * 0.1));
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
const bits = [];      // { x, y, vx, vy, life, max, size, colour, drag, fall } in field units
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r, w }
const fallers = [];   // { x, y, vx, vy, colour, life, max }: a pod going down past the edge
let shakeX = 0, shakeY = 0, shake = 0, flash = 0, flashColour = '#ffffff';
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, drag, fall) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 16 + Math.random() * 22, size, colour, drag: drag || 0.9, fall: fall || 0 });
  }
  if (bits.length > 600) bits.splice(0, bits.length - 600);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 70, px: px || 16, lift: lift || 22 }); }
function ring(x, y, colour, r, w) { rings.push({ x, y, colour, life: 0, max: 26, r, w: w || 0.006 }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= b.drag; b.vy = b.vy * b.drag + b.fall / BIT_HZ;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    for (let i = fallers.length - 1; i >= 0; i--) {
      const f = fallers[i];
      f.x += f.vx / BIT_HZ; f.y += f.vy / BIT_HZ;
      f.vx *= 0.96; f.vy = f.vy * 0.96 + 0.6 / BIT_HZ;
      if (++f.life >= f.max) fallers.splice(i, 1);
    }
    for (const look of looks.values()) look.squash *= 0.86;
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.9;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, seen, trail, fx, fy }
let drawFailed = false;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, seen: 0, trail: [], fx: 1, fy: 0 }));
  l.seen = performance.now();
  return l;
}
const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].k] : '#dddddd');

function play(e, t) {
  const me = myId();
  const mine = e.a === me;
  if (e.kind === 'hook') {
    ring(e.x, e.y, colourOf(t, e.a), 0.03, 0.005);
    spray(e.x, e.y, 4, INK.brassHi, 0.2, 0.004, 0.85);
    sound.hook(mine);
  } else if (e.kind === 'let') {
    sound.let(mine);
  } else if (e.kind === 'snap') {
    spray(e.x, e.y, 8, colourOf(t, e.a), 0.4, 0.005, 0.86);
    if (mine) pop(e.x, e.y, 'snap!', INK.danger, 15, 24);
    sound.snap(mine);
  } else if (e.kind === 'bump') {
    const k = e.c / 1000;
    spray(e.x, e.y, 6 + Math.round(k * 10), '#ffffff', 0.3 + k * 0.4, 0.005, 0.85);
    ring(e.x, e.y, '#ffffff', 0.03 + k * 0.03, 0.006);
    lookOf(e.a).squash = Math.min(1, k * 0.9);
    lookOf(e.b).squash = Math.min(1, k * 0.9);
    const near = e.a === me || e.b === me;
    if (near) shake = Math.max(shake, 3 + k * 7);
    if (k > 1.1) pop(e.x, e.y, 'boom!', INK.gold, 14, 22);
    sound.bump(near, k);
  } else if (e.kind === 'post') {
    spray(e.x, e.y, 3, INK.brassHi, 0.2, 0.004, 0.85);
    sound.post(e.c / 1000);
  } else if (e.kind === 'fall') {
    const c = colourOf(t, e.a), d = t.p[e.a];
    fallers.push({ x: e.x, y: e.y, vx: d ? d.vx * 0.3 : 0, vy: 0.05, colour: c, life: 0, max: 50 });
    spray(e.x, e.y, 14, c, 0.45, 0.006, 0.88, 0.4);
    spray(e.x, e.y, 8, INK.stoneHi, 0.3, 0.005, 0.88, 0.6);
    ring(e.x, e.y, c, 0.08, 0.008);
    if (mine) {
      shake = Math.max(shake, 9);
      flash = 0.8;
      flashColour = INK.danger;
      pop(e.x, e.y, e.b ? nickOf(e.b) + ' knocked you off' : 'over the edge', INK.danger, 16, 30);
    } else if (e.b === me) {
      flash = 0.5;
      flashColour = INK.gold;
      pop(e.x, e.y, t.ph === WAIT ? 'knocked off!' : '+1 · ' + nickOf(e.a) + ' is off', INK.gold, 17, 32);
      sound.ko();
    } else {
      pop(e.x, e.y, e.b ? nickOf(e.b) + ' +1' : nickOf(e.a) + ' fell', e.b ? colourOf(t, e.b) : c, 13, 24);
    }
    sound.fall(mine);
  } else if (e.kind === 'snuff') {
    spray(e.x, e.y, 14, INK.ghost, 0.35, 0.006, 0.9, -0.2);
    ring(e.x, e.y, colourOf(t, e.a), SNUFF_R, 0.006);
    if (mine) pop(e.x, e.y, 'puff!', INK.text, 14, 22);
    sound.snuff(mine);
  } else if (e.kind === 'drop') {
    spray(e.x, e.y, 10, INK.stoneHi, 0.3, 0.006, 0.9, 0.7);
    spray(e.x, e.y, 5, INK.brassHi, 0.25, 0.004, 0.9, 0.7);
    sound.drop();
  } else if (e.kind === 'crack') {
    flash = 0.4;
    flashColour = INK.danger;
    sound.crack();
  } else if (e.kind === 'spawn') {
    ring(e.x, e.y, colourOf(t, e.a), 0.06, 0.008);
    if (mine) sound.spawn();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(e.a === me || e.b === me);
  }
}

// Crumbs fall off the rim while it crumbles: made from the table as it
// stands, nothing over the wire.
let lastS = 1000;
function crumbs(t) {
  if (t.s < lastS && t.ph === PLAY) {
    const s = t.s / 1000;
    for (let i = 0; i < 2; i++) {
      const q = Math.random() * TAU;
      spray(CX + Math.cos(q) * IA * s, CY + Math.sin(q) * IB * s, 1, Math.random() < 0.5 ? INK.stone : INK.cliff, 0.08, 0.007, 0.95, 0.5);
    }
  }
  lastS = t.s;
}

// A post: a shadow, a brass pole and a lamp on top, lit or blown out. The one
// your rope would catch now is ringed.
function drawPost(q, i, target, reachable, now) {
  inField();
  const lit = postLit(q);
  ctx.fillStyle = 'rgba(10,6,24,0.35)';
  oval(ctx, q[0] + 0.004, q[1] + 0.008, QR * 1.2, QR * 0.8);
  ctx.fill();
  ctx.fillStyle = lit ? INK.brass : INK.dark;
  disc(q[0], q[1], QR);
  ctx.fill();
  if (lit) {
    const g = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], QR * 3.2);
    g.addColorStop(0, 'rgba(255,224,138,0.45)');
    g.addColorStop(1, 'rgba(255,224,138,0)');
    ctx.fillStyle = g;
    disc(q[0], q[1], QR * 3.2);
    ctx.fill();
    ctx.fillStyle = INK.lamp;
    disc(q[0], q[1], QR * 0.55);
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(200,210,240,0.35)';
    disc(q[0], q[1], QR * 0.45);
    ctx.fill();
    ctx.strokeStyle = 'rgba(220,230,255,0.35)';
    ctx.lineWidth = 0.002;
    const k = q[2] / SNUFF_STEPS;
    ctx.beginPath();
    ctx.arc(q[0], q[1], QR * 1.7, -Math.PI / 2, -Math.PI / 2 + TAU * k);
    ctx.stroke();
  }
  if (reachable && lit && i !== target) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 0.002;
    disc(q[0], q[1], QR * 2);
    ctx.stroke();
  }
  if (i === target) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.003;
    ctx.setLineDash([0.006, 0.005]);
    ctx.lineDashOffset = -(now / 1000) * 0.03;
    disc(q[0], q[1], QR * 2.4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }
}

// A rope from a pod to its post: the seat's colour round a pale core.
function drawRope(x, y, q, colour, tight) {
  inField();
  ctx.lineCap = 'round';
  ctx.strokeStyle = alpha(colour, 0.9);
  ctx.lineWidth = 0.006;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(q[0], q[1]); ctx.stroke();
  ctx.strokeStyle = tight ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 0.002;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(q[0], q[1]); ctx.stroke();
  ctx.lineCap = 'butt';
}

// A pod: a streak behind it when it flies, a shadow, a round body in its
// seat's colour that squashes on a hit, and two eyes that look where it goes.
function drawPod(id, d, x, y, me, now) {
  inField();
  const col = SEAT[d.k], look = lookOf(id);
  const sp = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
  if (sp > 0.15) { look.fx += (d.vx / sp - look.fx) * per60(0.3); look.fy += (d.vy / sp - look.fy) * per60(0.3); }
  const fl = Math.sqrt(look.fx * look.fx + look.fy * look.fy) || 1;
  const fx0 = look.fx / fl, fy0 = look.fy / fl;
  const tr = look.trail;
  tr.push([x, y]);
  while (tr.length > 10) tr.shift();
  if (sp > 0.5 && tr.length > 2) {
    ctx.lineCap = 'round';
    for (let i = 1; i < tr.length; i++) {
      ctx.strokeStyle = alpha(col, (i / tr.length) * 0.35 * Math.min(1, sp / 1.2));
      ctx.lineWidth = PR * 1.6 * (i / tr.length);
      ctx.beginPath(); ctx.moveTo(tr[i - 1][0], tr[i - 1][1]); ctx.lineTo(tr[i][0], tr[i][1]); ctx.stroke();
    }
    ctx.lineCap = 'butt';
  } else if (sp <= 0.5) tr.splice(0, Math.max(0, tr.length - 2));
  ctx.fillStyle = 'rgba(10,6,24,0.4)';
  oval(ctx, x + 0.004, y + 0.01, PR, PR * 0.8);
  ctx.fill();
  const s = 1 + look.squash * 0.25;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, 2 - s);
  const g = ctx.createRadialGradient(-PR * 0.35, -PR * 0.4, PR * 0.1, 0, 0, PR);
  g.addColorStop(0, lighter(col, 0.45));
  g.addColorStop(1, col);
  ctx.fillStyle = g;
  disc(0, 0, PR);
  ctx.fill();
  ctx.strokeStyle = darker(col, 0.45);
  ctx.lineWidth = 0.003;
  disc(0, 0, PR * 0.97);
  ctx.stroke();
  for (const side of [-1, 1]) {
    const ex = fx0 * PR * 0.38 - fy0 * side * PR * 0.36, ey = fy0 * PR * 0.38 + fx0 * side * PR * 0.36;
    ctx.fillStyle = '#ffffff';
    disc(ex, ey, PR * 0.26);
    ctx.fill();
    ctx.fillStyle = '#1a1530';
    disc(ex + fx0 * PR * 0.1, ey + fy0 * PR * 0.1, PR * 0.13);
    ctx.fill();
  }
  ctx.restore();
  if (me) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.0035; disc(x, y, PR + 0.006); ctx.stroke(); }
}

// A ghost: a pale wisp with its seat's colour in it and a wavering tail; the
// arc round it fills as it gets ready to blow a post out again.
function drawGhost(id, d, x, y, me, now, canSnuff) {
  inField();
  const col = SEAT[d.k];
  const bob = Math.sin(now / 300 + d.k) * 0.004;
  ctx.globalAlpha = me ? 0.75 : 0.5;
  ctx.fillStyle = alpha(col, 0.35);
  ctx.beginPath();
  ctx.moveTo(x - PR, y + bob);
  ctx.arc(x, y + bob, PR, Math.PI, 0);
  for (let i = 0; i <= 4; i++) {
    const qx = x + PR - (i * PR) / 2, qy = y + bob + PR * 0.9 + Math.sin(now / 120 + i) * PR * 0.18;
    ctx.lineTo(qx, qy);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(240,244,255,0.8)';
  ctx.lineWidth = 0.0025;
  ctx.stroke();
  ctx.fillStyle = '#1a1530';
  disc(x - PR * 0.33, y + bob - PR * 0.1, PR * 0.15); ctx.fill();
  disc(x + PR * 0.33, y + bob - PR * 0.1, PR * 0.15); ctx.fill();
  ctx.globalAlpha = 1;
  if (canSnuff) {
    const k = 1 - d.gc / GHOST_CD;
    ctx.strokeStyle = k >= 1 ? alpha(col, 0.9) : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.003;
    ctx.beginPath();
    ctx.arc(x, y + bob, PR + 0.01, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, k));
    ctx.stroke();
    if (me && k >= 1) {
      ctx.setLineDash([0.006, 0.008]);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      disc(x, y + bob, SNUFF_R);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawFallers() {
  inField();
  for (const f of fallers) {
    const k = f.life / f.max;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = f.colour;
    disc(f.x, f.y, PR * (1 - k * 0.8));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawBits() {
  inField();
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = r.w * (1 - k) + 0.0015;
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
    const [X0, Y0] = P(p.x, p.y);
    const X = clamp(X0 + shakeX, 80, VW - 80), Y = clamp(Y0 + shakeY, TOP + 30, VH - 20) - ease(Math.min(1, k * 1.4)) * p.lift;
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(16,10,32,0.75)';
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

const standings = (t) => sorted(t).sort((a, b) => t.p[b].sc - t.p[a].sc || t.p[b].ko - t.p[a].ko || a - b);

function drawHud(t, now, order) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  const d = t.p[me];
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    const left = t.pt, alive = sorted(t).filter((id) => t.p[id].al).length;
    status = 'round ' + t.rd + ' · ' + clock(left) + ' · ' + alive + ' standing';
    if (d && !d.al) status += ' · you haunt';
    if (t.s < 1000) colour = Math.floor(now / 500) % 2 ? '#ffb3bd' : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('grapple', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('grapple').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 82, 'left');
  text(wireNote(), VW - 50, 33, 9, INK.dim, 'right');

  // The board: one chip a player, in order of match points, in its seat's
  // colour, with its points and this round's knockouts; a ghost's chip dims.
  if (order.length) {
    const y = narrow ? 54 : 48;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (order.length - 1)) / order.length);
    let x = (VW - (cw * order.length + gap * (order.length - 1))) / 2;
    order.forEach((id) => {
      const c = t.p[id], mine = id === me;
      ctx.globalAlpha = c.al || t.ph === WAIT ? 1 : 0.55;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.16)' : 'rgba(12,6,30,0.5)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[c.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[c.k];
      disc(x + 11, y - 2, 6);
      ctx.fill();
      const score = t.ph === WAIT ? '' : c.sc + (c.ko ? ' ✦' + c.ko : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, INK.text, 'right');
      if (cw - 34 - sw > 14) fitText(mine ? 'you' : nickOf(id), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      ctx.globalAlpha = 1;
      x += cw + gap;
    });
  }

  // The one line that says how to play.
  const how = d && !d.al && t.ph !== WAIT
    ? (coarse ? 'touch: your ghost drifts to your thumb · hold by a lamp to blow it out' : 'your ghost follows the mouse · hold the button by a lamp to blow it out')
    : coarse
      ? 'hold a thumb by a post to hook it · lift to fly · knock rivals off the island'
      : 'hold the button or space to hook the post by the pointer · let go to fly · knock rivals off · M mutes';
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
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const me = myId();
  const cx = VW / 2, cy = (fieldBox[1] + fieldBox[3]) / 2;
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'hold to hook a post and whirl · let go aimed at the bot to knock it off';
    practiceNote(now, VW, head, tip, [[TOP, fieldBox[1] - 4], [fieldBox[3] + 4, VH - BOT]], VH - BOT - 4);
  } else if (t.ph === COUNT) {
    const n = Math.ceil(t.pt / HZ);
    const w = Math.min(VW - 32, 380), h = 112;
    panel(cx, cy, w, h);
    fitText('round ' + t.rd + ' · last one standing', cx, cy - 22, 20, INK.text, w - 24);
    fitText('a knockout +' + KO_PTS + ' · standing last +' + LAST_PTS + ' · first to ' + MATCH + ' takes the match', cx, cy + 2, 13, INK.muted, w - 24);
    text(String(n), cx, cy + 40, 26, INK.gold, 'center');
  } else if (t.ph === PLAY && t.pt > ROUND_STEPS - HZ) {
    const k = (ROUND_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('go!', cx, cy + big * 0.5, big * (2 + k), INK.gold, 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && ROUND_STEPS - t.pt >= SHRINK_FROM && ROUND_STEPS - t.pt < SHRINK_FROM + 3 * HZ) {
    const k = (ROUND_STEPS - t.pt - SHRINK_FROM) / (3 * HZ);
    const s = 'the rim is crumbling · its posts go with it';
    ctx.globalAlpha = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
    ctx.font = font(15);
    const w = Math.min(VW - 24, ctx.measureText(s).width + 32);
    panel(cx, fieldBox[1] + 18, w, 30);
    fitText(s, cx, fieldBox[1] + 23, 15, '#ffb3bd', w - 16);
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 330), h = 100 + rows.length * 22 + (t.ch !== -1 ? 22 : 0);
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 6, Math.min(VH - BOT - h / 2 - 6, cy)) + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.win !== -1) { head = t.win === me ? 'you stand last!' : nickOf(t.win) + ' stands last'; hc = colourOf(t, t.win); }
    else head = sorted(t).some((id) => t.p[id].al) ? 'time · everyone standing scores' : 'nobody left standing';
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 34, 22, hc, w - 24);
    let y1 = y0 + 64;
    if (t.ch !== -1) {
      fitText(t.ch === me ? 'and you take the match!' : nickOf(t.ch) + ' takes the match!', cx, y1 - 4, 15, INK.gold, w - 24);
      y1 += 22;
    }
    rows.forEach(([id, ko, pts, up], i) => {
      const y = y1 + i * 22;
      text(ord(i + 1), cx - w / 2 + 30, y, 13, i === 0 ? INK.gold : INK.dim, 'center');
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 54, y - 4, 5);
      ctx.fill();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 66, y, 14, id === me ? INK.text : INK.muted, w - 200, 'left');
      text(ko + ' ✦', cx + w / 2 - 92, y, 11, INK.dim, 'right');
      if (up) text('▲', cx + w / 2 - 62, y, 11, INK.gold, 'right');
      text(String(pts), cx + w / 2 - 18, y, 15, INK.text, 'right');
    });
    fitText('✦ knockouts this round · ▲ standing · next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 14, 11, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// A pod between two tables: one put down afresh — a new round, a fall, a
// return — is drawn where the newer table has it rather than slid there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || q.al !== p.al || (p.x - q.x) ** 2 + (p.y - q.y) ** 2 > 0.15 * 0.15) return [p.x, p.y];
  return [lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k)];
}

// Your own pod is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh, a new round — is taken at once.
let shown = null;
const SNAP = 0.1;
function settle(pos) {
  if (!shown || (pos[0] - shown[0]) ** 2 + (pos[1] - shown[1]) ** 2 > SNAP * SNAP) return (shown = pos.slice());
  const k = per60(0.6);
  for (let i = 0; i < 2; i++) shown[i] += (pos[i] - shown[i]) * k;
  return shown;
}

let myPos = null;      // [x, y]: where your pod or ghost is drawn
let myLive = false;    // whether that is a pod on the island
function draw(now) {
  const b = agreedAt(now);
  if (!b) {
    flat();
    ctx.fillStyle = INK.sky;
    ctx.fillRect(0, 0, VW, VH);
    myPos = shown = null;
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('lighting the lamps…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  crumbs(t);
  drawSky(now);
  const s = lerp(b.from.s, b.to.s, b.k) / 1000;
  drawIsland(s, t.ph === PLAY && t.s < 1000, now);
  const me = myId();
  const ids = bySeat(t);

  // Where everybody is drawn: you from the guess, the rest from the agreed table.
  const at = new Map();
  for (const id of ids) {
    if (id === me) continue;
    const pos = between(b, id);
    if (pos) at.set(id, pos);
  }
  const m = mineAt(now);
  // A guess already in the next phase while the drawing is still in this one
  // draws your pod from the agreed table for that moment.
  const guessed = !!(m && m.to.p[me] && m.to.ph === t.ph && t.p[me] && m.to.p[me].al === t.p[me].al);
  const minePos = guessed ? between(m, me) : between(b, me);
  if (minePos) at.set(me, settle(minePos));
  const dOf = (id) => (id === me && guessed ? m.to.p[me] : t.p[id]);
  myPos = at.get(me) || null;
  if (!myPos) shown = null;
  const myD = myPos ? dOf(me) : null;
  myLive = !!(myD && myD.al);

  // The post your rope would catch if you held now, and every post in reach.
  let target = -1;
  const reach = myLive ? reachOf(t, me) : 0;
  if (myLive && myD.hk < 0 && t.ph !== COUNT) {
    const [ax, ay] = aimNow();
    target = pickPost(t, myPos[0], myPos[1], ax, ay, reach);
  }
  t.q.forEach((q, i) => {
    if (!postUp(q)) return;
    const near = myLive && (q[0] - myPos[0]) ** 2 + (q[1] - myPos[1]) ** 2 <= reach * reach;
    drawPost(q, i, target, near, now);
  });
  if (myLive && myD.hk < 0 && t.ph !== COUNT && t.ph !== END) {
    // Your reach, faint, so you can see a post come into it.
    inField();
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = 0.002;
    ctx.setLineDash([0.01, 0.01]);
    disc(myPos[0], myPos[1], reach);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const id of ids) {
    const pos = at.get(id), d = dOf(id);
    if (!pos || !d.al || d.hk < 0) continue;
    const tq = (id === me && guessed ? m.to : t).q[d.hk];
    if (tq) drawRope(pos[0], pos[1], tq, SEAT[d.k], d.ht > 0);
  }
  drawFallers();
  for (const id of ids) {
    const pos = at.get(id), d = dOf(id);
    if (!pos) continue;
    if (d.al) drawPod(id, d, pos[0], pos[1], id === me, now);
    else if (t.ph !== WAIT) drawGhost(id, d, pos[0], pos[1], id === me, now, t.ph === PLAY);
  }

  // Names over the pods.
  flat();
  for (const id of ids) {
    const pos = at.get(id), d = dOf(id);
    if (!pos || (!d.al && t.ph === WAIT)) continue;
    const [X, Y] = P(pos[0], pos[1]);
    const mine = id === me;
    let label = mine ? 'you' : nickOf(id);
    if (!d.al) label += ' · ghost';
    else if (t.ph !== WAIT && reachOf(t, id) > REACH) label += ' · long rope';
    fitText(label, X + shakeX, Y + shakeY - sc * (PR + 0.018) - 2, 10, mine ? '#ffffff' : 'rgba(255,255,255,0.8)', 110);
  }
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawBits();

  // A fall of yours flushes the edges of the screen red; a knockout, gold.
  if (flash > 0.05) {
    const g = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    g.addColorStop(0, alpha(flashColour, 0));
    g.addColorStop(1, alpha(flashColour, 0.3 * flash));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(t, now, t.ph === WAIT ? ids : standings(t));
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: [button, point x, point y], the point in thousandths of
// a unit or -1 for nowhere. The mouse points where it is, a thumb where it
// touches, the arrow keys a little way off your pod the way they press, and
// space alone points nowhere — the rope then takes the nearest post. Holding
// the button, a thumb on the glass or space throws the rope. A ghost drifts to
// the point and, held by a lamp, blows it out. A change of point goes out no
// oftener than AIM_EVERY, because a pointer changes it on every move the
// screen reports and the clock's ticks share the same seat's ceiling on
// messages; the button goes out at once.
const AIM_EVERY = 110;
const aim = { mode: '', x: CX, y: CY };
let held = false;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const MOVE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];

function aimNow() {
  if (aim.mode === 'keys') {
    let x = 0, y = 0;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) x -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
    if (keys.has('ArrowUp') || keys.has('KeyW')) y -= 1;
    if (keys.has('ArrowDown') || keys.has('KeyS')) y += 1;
    if ((!x && !y) || !myPos) return [-1, -1];
    const l = Math.hypot(x, y), far = myLive ? REACH * 0.8 : 0.3;
    return [
      clamp(Math.round((myPos[0] + (x / l) * far) * 1000), 0, FW * 1000),
      clamp(Math.round((myPos[1] + (y / l) * far) * 1000), 0, FH * 1000),
    ];
  }
  if (!aim.mode) return [-1, -1];
  // Rounded to a few thousandths: a hand that differs by a hair is not worth
  // a message.
  return [clamp(Math.round(aim.x * 200) * 5, 0, FW * 1000), clamp(Math.round(aim.y * 200) * 5, 0, FH * 1000)];
}
function handNow() {
  const [ax, ay] = aimNow();
  return [held ? 1 : 0, ax, ay];
}
function sayHand(now, force) {
  const h = handNow(), s = lastSaid;
  if (s && h.every((v, i) => v === s[i])) return;
  const same = s && h[0] === s[0];
  if (same && !force && now - saidAt < AIM_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

function press() {
  if (held) return;
  held = true;
  sayHand(performance.now(), true);
}
function release() {
  if (!held) return;
  held = false;
  sayHand(performance.now(), true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (e.repeat) return;
    coarse = false;
    // Space alone throws at the nearest post; a pointer already in use keeps pointing.
    if (!aim.mode) aim.mode = 'keys';
    press();
    return;
  }
  if (!MOVE_KEYS.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  aim.mode = 'keys';
  keys.add(e.code);
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'Enter') { release(); return; }
  keys.delete(e.code);
});
addEventListener('blur', () => {
  keys.clear();
  drag = null;
  release();
});

// A pointer: the mouse points wherever it is, buttons up or down; a thumb
// points where it touches. Pressing throws the rope and lifting lets go,
// captured, so a press that leaves the frame still lets go where it should.
let drag = null;   // the pointer id held down, or null
function pointAt(e) {
  aim.x = (e.clientX - ox) / sc;
  aim.y = (e.clientY - oy) / sc;
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (drag !== null) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  drag = e.pointerId;
  aim.mode = coarse ? 'touch' : 'mouse';
  pointAt(e);
  press();
});
cv.addEventListener('pointermove', (e) => {
  if (drag !== null && e.pointerId !== drag) return;
  if (drag === null && e.pointerType !== 'mouse') return;
  if (drag === null) {
    if (aim.mode === 'keys' && keys.size) return;
    aim.mode = 'mouse';
    coarse = false;
  }
  pointAt(e);
});
function lift(e) {
  if (drag === null || e.pointerId !== drag) return;
  drag = null;
  release();
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);

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
// a player arrives and is put on the island.
function start() {
  lastSaid = handNow();
  setHand(lastSaid.slice());
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
