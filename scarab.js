/**
 * @disk     scarab
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    A chain of gems rolls along a spiral groove into a pit, and everyone fires gems into the same chain. Three of a colour pop for points, a gap that closes on a match pops again for more, and every plain gem the pit swallows is billed to the leader.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/scarab.png
 */
// scarab.js — one chain of gems in a spiral groove, a shooter for every player
// on the dais in the middle, and the room's order as the referee.
//
// Every copy holds the whole temple — every gem in the chain and where along
// the groove it stands, every gem in flight, every shooter and what it has
// loaded — and changes it only on what comes back round the room, so every
// copy applies the same hands in the same order and holds the same temple.
// Nobody sends where a gem landed, what popped or who scored: a hand is where
// a shooter points and two counters, one for shots and one for swaps, and
// everything else is the same arithmetic on the same whole numbers on every
// machine. A page with a console open can aim and fire its own shooter however
// it likes, but no faster than the shooter reloads.
//
// While a player is alone in the temple, a bot plays with them. It is part of
// the temple like any player, and its shots are a function of the temple
// alone, so it plays the same on every copy and says nothing over the wire.
// When a second player arrives, practice runs on for three seconds under a
// note that says so, and the bot leaves before the round is laid out: it never
// takes part in one.
//
// Your own gems in flight do not wait for the trip: they are drawn from the
// agreed temple played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers — a unit is a thousandth of the temple's
// radius, and whatever moves counts sixteenths of one — and touch them with
// nothing but `+ - * /`, comparisons, `Math.floor`, `Math.round`, `Math.min`,
// `Math.max`, `Math.abs` and `Math.imul`, which the language fixes to the last
// bit. The groove and the compass a shooter aims by are worked out once, as
// the disk starts, by series written here from those same operations, so they
// come out alike on every machine too; the browser's own `Math.sin` and
// `Math.sqrt` appear only in the drawing.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const TAU = 2 * Math.PI;

// Sine and cosine by their series, after folding the angle into [-pi, pi].
function sinS(x) {
  x -= TAU * Math.floor((x + Math.PI) / TAU);
  const x2 = x * x;
  let term = x, sum = x;
  for (let k = 1; k < 12; k++) {
    term = (-term * x2) / ((2 * k) * (2 * k + 1));
    sum += term;
  }
  return sum;
}
const cosS = (x) => sinS(x + Math.PI / 2);

// A square root by Newton's steps from a guess fixed by the number alone.
function sqrtS(v) {
  if (v <= 0) return 0;
  let r = v > 1 ? v / 2 : 1;
  for (let i = 0; i < 60; i++) {
    const n = (r + v / r) / 2;
    if (n === r) break;
    r = n;
  }
  return r;
}

const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the temple a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own gems a trip ahead, with your hand in it

const FIELD = 1000;            // the temple's radius, in units
const SUB = 16;                // sixteenths of a unit: what moves counts these
const R_IN = 880;              // the groove starts this far out
const R_PIT = 330;             // and ends in the pit this far out
const TURNS = 2.1;             // turns of the spiral between them
const PHI0 = -Math.PI / 2;     // where the groove starts: the top
const HUB = 150;               // the shooters stand round the dais this far out
const MUZZLE = 46;             // and a gem leaves the mouth this far ahead of them
const A = 1024;                // a full turn of a shooter, in steps of its aim
const GEM = 68;                // a gem's width along the groove, in units
const D16 = GEM * SUB;
const TOUCH = 2 * SUB;         // slack within which two gems count as touching
const HIT = 64;                // centres this close mean a flying gem has hit the chain
const SHOT_SUB = 12;           // units a flying gem moves in one of a step's slices
const SHOT_SLICES = 4;         // slices a step
const PULL16 = 12 * SUB;       // how fast a gap closes on a match, a step
const V0 = 70;                 // how fast the scarab pushes the chain as a round starts, sixteenths a step, for two
const V1 = 180;                // and as it ends
const VP = 50;                 // and while it waits for a round
const NG = 5;                  // colours of gem
const BOMB = 5;                // a loaded gem that bursts whatever it hits
const START_GEMS = 26;         // the chain as a round starts
const MAXB = 160;              // more than the groove can hold
const MAX_SHOTS = 2;           // gems one shooter may have in flight
const COOL = 7;                // steps between two shots of one shooter
const FIRE_GRACE = 6;          // steps a shot asked for early waits for the reload
const PER_GEM = 10;            // points a popped gem is worth, times the combo
const BOOM_GEM = 10;           // and one a bomb bursts
const PIT_BILL = 10;           // what a gem in the pit costs whoever it is billed to
const CH_FULL = 20 * HZ;       // charge that loads a bomb
const CH_RATE_MAX = 2;         // the fastest a charge fills, a step
const DANGER = 1500 * SUB;     // the head this close to the pit is a warning
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;
const SCORE_MAX = 99999;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 7 * HZ;

// ── the groove and the compass ─────────────────────────────────────────────
// The groove is a spiral from the rim to the pit, kept as one point every unit
// of its length; a gem a distance along it stands on the point there. The
// compass is where a shooter points for each of its A steps of aim.
const GX = [], GY = [];
(function groove() {
  const N = 48000, th = TURNS * TAU;
  let px = R_IN * cosS(PHI0), py = R_IN * sinS(PHI0), run = 0, next = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N, r = R_IN + (R_PIT - R_IN) * t, phi = PHI0 + th * t;
    const x = r * cosS(phi), y = r * sinS(phi);
    const dx = x - px, dy = y - py;
    run += sqrtS(dx * dx + dy * dy);
    px = x; py = y;
    while (run >= next) { GX.push(Math.round(x)); GY.push(Math.round(y)); next += 1; }
  }
})();
const LEN = GX.length;
const LEN16 = (LEN - 1) * SUB;
const TC = [], TS = [];
for (let a = 0; a < A; a++) { TC.push(cosS((a * TAU) / A)); TS.push(sinS((a * TAU) / A)); }
const HX = TC.map((c) => Math.round(c * HUB)), HY = TS.map((s) => Math.round(s * HUB));
const at16 = (s) => clampi(s >> 4, 0, LEN - 1);

// ── the temple ─────────────────────────────────────────────────────────────
// Plain data only: it is fingerprinted and handed over as JSON, and the copy a
// newcomer reads back must print exactly like the one it came from.
//   b:  the chain from the scarab to the pit, each gem
//       [where along the groove in sixteenths, colour, who fired it or 0,
//        who a closing gap pays or 0, the combo that pays, a number of its own]
//   f:  gems in flight, [x, y, dx, dy in sixteenths, colour, shooter, number]
//   uc: the last number handed out; lf: the colour last fed into the chain
//   res: the last round's [id, won, rounds won, points, gems popped, best combo]
//   win: its winner, or -1
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, uc: 0, lf: 0, b: [], f: [], p: {}, res: null, win: -1 };
  lay(w);
  return w;
}

const nextU = (w) => (w.uc = w.uc >= BIG - 1 ? 1 : w.uc + 1);

function feedColour(w) {
  const c = draw01(w) < 0.35 ? w.lf : Math.floor(draw01(w) * NG);
  w.lf = c;
  return c;
}

// A fresh chain at the mouth of the groove, nothing in flight.
function lay(w) {
  w.b = [];
  w.f = [];
  for (let i = 0; i < START_GEMS; i++) w.b.push([i * D16, feedColour(w), 0, 0, 0, nextU(w)]);
}

// A colour to load: one the chain still holds, so every shot can make a match.
function loadColour(w) {
  const have = [];
  for (const g of w.b) if (!have.includes(g[1])) have.push(g[1]);
  if (!have.length) return Math.floor(draw01(w) * NG);
  have.sort((x, y) => x - y);
  return have[Math.floor(draw01(w) * have.length)];
}

const FIELDS = ['c', 's', 'ha', 'aim', 'q', 'fq', 'cd', 'g1', 'g2', 'ws', 'ch', 'sc', 'pp', 'cm', 'wn', 'bw', 'hs', 'hc'];
//   c: colour; s: seat; ha: where on the dais, in steps of aim; aim: where it
//   points; q: the shot counter last heard; fq: steps a shot asked for still
//   waits for the reload; cd: steps of reload left; g1, g2: the gem loaded and
//   the next one; ws: the swap counter last heard; ch: charge toward a bomb;
//   sc: points this round; pp: gems popped this round; cm: best combo this
//   round; wn: rounds won; bw: the bot's pause; hs, hc: hands this step.
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

function newPlayer(w, input) {
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), ha: 0, aim: input[0], q: input[1], fq: 0, cd: 0,
    g1: loadColour(w), g2: loadColour(w), ws: input[2], ch: 0, sc: 0, pp: 0, cm: 0, wn: 0, bw: 0, hs: w.n, hc: 0,
  });
}

// The shooters stand evenly round the dais, in seat order.
function arrange(w) {
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].ha = Math.floor((i * A) / ids.length) % A; });
}

// A hand, at its place in the room's order: [where the shooter points, the
// shot counter, the swap counter]. A shot or a swap is asked for once, when its
// counter changes; the same hand said again to keep a player at the table does
// nothing. Being heard is how a player arrives: as a shooter on the dais.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    w.p[id] = newPlayer(w, input);
    arrange(w);
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike; how often a shooter fires is the reload's to say.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.aim = input[0];
  if (input[1] !== d.q) { d.q = input[1]; d.fq = FIRE_GRACE; }
  if (input[2] !== d.ws) { d.ws = input[2]; swapGems(d); }
}

function swapGems(d) {
  const g = d.g1;
  d.g1 = d.g2;
  d.g2 = g;
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [a, q, s] = raw;
  if (!Number.isInteger(a) || !Number.isInteger(q) || !Number.isInteger(s)) return null;
  if (a < 0 || a >= A || q < 0 || q > 999 || s < 0 || s > 999) return null;
  return [a, q, s];
}

function leave(w, id) {
  delete w.p[id];
  arrange(w);
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions
const BOT_IDLE = 0.12;         // how often it lets a decision go by
const BOT_REST = 12;           // steps it waits after a shot, and a few more
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the temple waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, [0, 0, 0]);
    w.p[BOT_ID].bw = 2 * HZ;
    arrange(w);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// The step of aim that points most nearly along (dx, dy).
function aimTo(dx, dy) {
  let best = 0, top = -Infinity;
  for (let a = 0; a < A; a++) {
    const v = TC[a] * dx + TS[a] * dy;
    if (v > top) { top = v; best = a; }
  }
  return best;
}

// Whether a gem flying from (ox, oy) to gem i would meet another gem first.
function blocked(w, ox, oy, i) {
  const g = w.b[i], tx = GX[at16(g[0])], ty = GY[at16(g[0])];
  const dx = tx - ox, dy = ty - oy, l2 = dx * dx + dy * dy;
  if (l2 <= 0) return false;
  for (let j = 0; j < w.b.length; j++) {
    if (j === i) continue;
    const h = w.b[j], x = GX[at16(h[0])] - ox, y = GY[at16(h[0])] - oy;
    const t = (x * dx + y * dy) / l2;
    if (t <= 0 || t >= 1) continue;
    const ex = x - t * dx, ey = y - t * dy;
    if (ex * ex + ey * ey < (HIT - 8) * (HIT - 8)) return true;
  }
  return false;
}

// The gem the bot would shoot at with a colour, as [index], or -1: a pair of
// that colour first, a lone gem of it next, nearer the pit the better, and
// only one it can see. A bomb goes at whatever is nearest the pit.
function botTarget(w, d, colour) {
  const ox = HX[d.ha], oy = HY[d.ha];
  const cands = [];
  const b = w.b;
  for (let i = 0; i < b.length; i++) {
    let v;
    if (colour === BOMB) v = b[i][0] / D16;
    else {
      if (b[i][1] !== colour) continue;
      const pair = (i > 0 && b[i - 1][1] === colour && b[i][0] - b[i - 1][0] <= D16 + TOUCH) ||
        (i + 1 < b.length && b[i + 1][1] === colour && b[i + 1][0] - b[i][0] <= D16 + TOUCH);
      v = (pair ? 200 : 0) + b[i][0] / D16;
    }
    cands.push([v, i]);
  }
  cands.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (let k = 0; k < cands.length && k < 8; k++) if (!blocked(w, ox, oy, cands[k][1])) return cands[k][1];
  return -1;
}

function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (w.n % BOT_EVERY !== 0 || d.cd > 0 || !w.b.length) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 6 + Math.floor(draw01(w) * 14); return; }
  let i = botTarget(w, d, d.g1);
  if (i < 0) {
    if (botTarget(w, d, d.g2) >= 0) { swapGems(d); d.bw = 4; return; }
    i = botTarget(w, d, BOMB);
    if (i < 0) return;
  }
  // Aim where the gem will be, roughly, and a little off now and then.
  const g = w.b[i], ox = HX[d.ha], oy = HY[d.ha];
  const far = Math.abs(GX[at16(g[0])] - ox) + Math.abs(GY[at16(g[0])] - oy);
  const lead = i === 0 || g[0] - w.b[i - 1][0] <= D16 + TOUCH ? Math.floor((far / (SHOT_SUB * SHOT_SLICES)) * speedOf(w) * 0.7) : 0;
  const s = at16(g[0] + lead);
  d.aim = (aimTo(GX[s] - ox, GY[s] - oy) + Math.floor(draw01(w) * 9) - 4 + A) % A;
  d.fq = 1;
  d.bw = BOT_REST + Math.floor(draw01(w) * 12);
}

// ── a step ─────────────────────────────────────────────────────────────────
function freshRound(w) {
  lay(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    d.sc = d.pp = d.cm = d.ch = d.fq = d.cd = 0;
    d.g1 = loadColour(w);
    d.g2 = loadColour(w);
  }
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  freshRound(w);
}

// A round: a new chain, the seats closed up in order, nothing scored.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  bySeat(w).forEach((id, i) => { w.p[id].s = i; w.p[id].bw = 0; });
  arrange(w);
  freshRound(w);
  fx(w, 'round');
}

function finish(w) {
  const ids = bySeat(w);
  let top = -1, win = -1;
  for (const id of ids) {
    const sc = w.p[id].sc;
    if (sc > top) { top = sc; win = id; } else if (sc === top) win = -1;
  }
  w.win = top > 0 ? win : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, id === w.win ? 1 : 0, w.p[id].wn, w.p[id].sc, w.p[id].pp, w.p[id].cm]);
  res.sort((a, b) => b[3] - a[3] || b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  w.f = [];
  fx(w, 'end', 0, 0, w.win);
}

function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting temple otherwise leaves at zero. The bot goes first, so
    // the round's seats close up without it.
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
      if (w.pt === 15 * HZ) fx(w, 'late');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nothing moves while a round is counted in or its result is up, and a shot
  // asked for meanwhile is not saved up for the moment it starts.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) w.p[id].fq = 0;
    return;
  }
  temple(w);
}

// How fast the scarab pushes: faster as the round runs down, and faster with
// more shooters on the dais, so a full room feels the pit as much as two do.
function speedOf(w) {
  if (w.ph !== PLAY) return VP;
  const v = V0 + Math.floor(((V1 - V0) * (PLAY_STEPS - w.pt)) / PLAY_STEPS);
  return Math.floor((v * (6 + Math.min(MAX_P, playersIn(w).length))) / 8);
}

// Whoever has the most points, alone, and any at all: the one the pit bills.
function leaderOf(w) {
  let top = 0, who = -1;
  for (const id of bySeat(w)) {
    const sc = w.p[id].sc;
    if (sc > top) { top = sc; who = id; } else if (sc === top) who = -1;
  }
  return who;
}

function temple(w) {
  botThink(w);
  const ids = bySeat(w);
  const lead = leaderOf(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.cd > 0) d.cd -= 1;
    // A bomb charges for everybody but the leader, faster the more players
    // are ahead, and is loaded next once it is full.
    if (id !== lead && d.g1 !== BOMB && d.g2 !== BOMB) {
      let ahead = 0;
      for (const o of ids) if (w.p[o].sc > d.sc) ahead += 1;
      d.ch = Math.min(CH_FULL, d.ch + Math.min(CH_RATE_MAX, ahead));
      if (d.ch >= CH_FULL) { d.ch = 0; d.g2 = BOMB; fx(w, 'bomb', 0, 0, id); }
    }
    if (d.fq > 0) {
      d.fq -= 1;
      if (d.cd === 0 && inFlight(w, id) < MAX_SHOTS) { fire(w, id, d); d.fq = 0; }
    }
  }
  fly(w);
  chain(w);
}

const inFlight = (w, id) => w.f.reduce((n, s) => n + (s[5] === id ? 1 : 0), 0);

function fire(w, id, d) {
  const x = Math.round((HX[d.ha] + TC[d.aim] * MUZZLE) * SUB), y = Math.round((HY[d.ha] + TS[d.aim] * MUZZLE) * SUB);
  const vx = Math.round(TC[d.aim] * SHOT_SUB * SUB), vy = Math.round(TS[d.aim] * SHOT_SUB * SUB);
  w.f.push([x, y, vx, vy, d.g1, id, nextU(w)]);
  d.g1 = d.g2;
  d.g2 = loadColour(w);
  d.cd = COOL;
  fx(w, 'fire', 0, 0, id, d.aim);
}

// Gems in flight, a slice at a time: the first gem of the chain one comes
// near is the one it hits; one that leaves the temple is gone.
function fly(w) {
  const far = FIELD * SUB, far2 = far * far, hit = HIT * SUB, hit2 = hit * hit;
  for (let k = 0; k < w.f.length; k++) {
    const s = w.f[k];
    let gone = false;
    for (let sl = 0; sl < SHOT_SLICES && !gone; sl++) {
      s[0] += s[2];
      s[1] += s[3];
      if (s[0] * s[0] + s[1] * s[1] > far2) { gone = true; break; }
      let best = -1, low = hit2;
      for (let i = 0; i < w.b.length; i++) {
        const g = at16(w.b[i][0]);
        const dx = s[0] - GX[g] * SUB;
        if (dx >= hit || dx <= -hit) continue;
        const dy = s[1] - GY[g] * SUB;
        if (dy >= hit || dy <= -hit) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 < low) { low = d2; best = i; }
      }
      if (best >= 0) {
        if (s[4] === BOMB) burst(w, s, best);
        else insert(w, s, best);
        gone = true;
      }
    }
    if (gone) { w.f.splice(k, 1); k -= 1; }
  }
}

const touching = (b, j) => b[j][0] - b[j - 1][0] <= D16 + TOUCH;

// From gem j, every one of its colour it touches, either way: [first, last].
function runAt(b, j) {
  let lo = j, hi = j;
  while (lo > 0 && b[lo - 1][1] === b[j][1] && touching(b, lo)) lo -= 1;
  while (hi + 1 < b.length && b[hi + 1][1] === b[j][1] && touching(b, hi + 1)) hi += 1;
  return [lo, hi];
}

// Gems ahead of j that overlap it are pushed on, as far as they touch.
function pushOn(b, j) {
  for (let i = j + 1; i < b.length; i++) {
    if (b[i][0] >= b[i - 1][0] + D16) break;
    b[i][0] = b[i - 1][0] + D16;
  }
}

// A gem that hits the chain goes in beside the gem it hit, on the side it
// came down on, and pushes the gems ahead of it on.
function insert(w, s, h) {
  const b = w.b, at = b[h][0];
  const f = at16(at + D16), r = at16(Math.max(0, at - D16));
  const fx_ = s[0] - GX[f] * SUB, fy_ = s[1] - GY[f] * SUB, rx = s[0] - GX[r] * SUB, ry = s[1] - GY[r] * SUB;
  const df = fx_ * fx_ + fy_ * fy_, dr = rx * rx + ry * ry;
  const k = df < dr ? h + 1 : h;
  b.splice(k, 0, [df < dr ? at + D16 : at, s[4], s[5], 0, 0, nextU(w)]);
  pushOn(b, k);
  const g = at16(b[k][0]);
  fx(w, 'clack', GX[g], GY[g], s[5], s[4]);
  const [lo, hi] = runAt(b, k);
  if (hi - lo + 1 >= 3) pop(w, lo, hi, s[5], 1);
}

// A bomb bursts the gem it hits and two either side.
function burst(w, s, h) {
  const b = w.b;
  const lo = Math.max(0, h - 2), hi = Math.min(b.length - 1, h + 2);
  const n = hi - lo + 1, g = at16(b[h][0]);
  const d = w.p[s[5]];
  if (d) { d.sc = Math.min(SCORE_MAX, d.sc + n * BOOM_GEM); d.pp += n; }
  fx(w, 'boom', GX[g], GY[g], s[5], n * BOOM_GEM);
  b.splice(lo, n);
  gapAfter(w, lo, s[5], 1);
}

// Gems that pop: points to whoever made them pop, times the combo.
function pop(w, lo, hi, who, m) {
  const b = w.b, n = hi - lo + 1, mid = b[(lo + hi) >> 1], g = at16(mid[0]);
  const d = w.p[who];
  const pts = d ? n * PER_GEM * m : 0;
  if (d) { d.sc = Math.min(SCORE_MAX, d.sc + pts); d.pp += n; if (m > d.cm) d.cm = m; }
  fx(w, 'pop', GX[g], GY[g], d ? who : 0, mid[1], pts, m, n);
  b.splice(lo, n);
  gapAfter(w, lo, d ? who : 0, m);
}

// The gap a pop leaves: when the gems either side of it match, the gems ahead
// roll back to close it, and whatever that pops pays the same player a combo
// more.
function gapAfter(w, lo, who, m) {
  const b = w.b;
  if (lo > 0 && lo < b.length && b[lo - 1][1] === b[lo][1]) { b[lo][3] = who; b[lo][4] = Math.min(9, m + 1); }
}

// Two parts of the chain have just met at gem j: if that makes three of a
// colour they pop, for whoever the meeting was owed to, or for nobody.
function meet(w, j) {
  const b = w.b;
  const [lo, hi] = runAt(b, j);
  const who = b[j][3], m = b[j][4];
  b[j][3] = 0;
  b[j][4] = 0;
  if (hi - lo + 1 < 3) return false;
  if (who !== 0 && w.p[who]) pop(w, lo, hi, who, Math.max(2, m));
  else pop(w, lo, hi, 0, 1);
  return true;
}

function chain(w) {
  const b = w.b;
  // The scarab pushes the back of the chain, and whatever touches it ahead.
  if (b.length) {
    let prevOld = b[0][0], met = -1;
    b[0][0] += speedOf(w);
    for (let j = 1; j < b.length; j++) {
      const old = b[j][0];
      if (old >= b[j - 1][0] + D16) break;
      if (old - prevOld > D16 + TOUCH && met < 0) met = j;
      prevOld = old;
      b[j][0] = b[j - 1][0] + D16;
    }
    if (met > 0) meet(w, met);
  }
  // A gap with a match either side closes, the part ahead rolling back.
  for (let j = 1; j < b.length; j++) {
    const gap = b[j][0] - b[j - 1][0];
    if (gap <= D16 + TOUCH || b[j][1] !== b[j - 1][1]) continue;
    let e = j;
    while (e + 1 < b.length && touching(b, e + 1)) e += 1;
    const back = Math.min(PULL16, gap - D16);
    for (let i = j; i <= e; i++) b[i][0] -= back;
    if (touching(b, j) && meet(w, j)) j = 0;
  }
  // The scarab feeds a new gem in behind the chain as soon as there is room.
  if (!b.length || b[0][0] >= D16) {
    if (b.length < MAXB) b.unshift([b.length ? b[0][0] - D16 : 0, feedColour(w), 0, 0, 0, nextU(w)]);
  }
  // The pit swallows whatever reaches it. Practice starts a fresh chain; in a
  // round a gem somebody fired costs them, and a plain gem costs the leader.
  while (b.length && b[b.length - 1][0] >= LEN16) {
    const g = b.pop();
    if (w.ph === WAIT) { lay(w); fx(w, 'fresh'); return; }
    const who = g[2] !== 0 && w.p[g[2]] ? g[2] : leaderOf(w);
    const d = w.p[who];
    if (d) d.sc = Math.max(0, d.sc - PIT_BILL);
    fx(w, 'pit', 0, 0, d ? who : 0, g[1]);
  }
}

// A temple handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const anyId = (v) => int(v, -BIG, BIG);

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG) || !int(raw.uc, 0, BIG) || !int(raw.lf, 0, NG - 1)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!Array.isArray(raw.b) || raw.b.length > MAXB) return null;
  const b = [];
  for (let i = 0; i < raw.b.length; i++) {
    const g = raw.b[i];
    if (!Array.isArray(g) || g.length !== 6 || !int(g[0], -D16, LEN16 + D16) || !int(g[1], 0, NG - 1)) return null;
    if (!anyId(g[2]) || !anyId(g[3]) || !int(g[4], 0, 9) || !int(g[5], 0, BIG)) return null;
    if (i > 0 && g[0] < b[i - 1][0]) return null;
    b.push(g.slice());
  }
  if (!Array.isArray(raw.f) || raw.f.length > MAX_P * MAX_SHOTS) return null;
  const f = [];
  const far = (FIELD + 100) * SUB, sp = SHOT_SUB * SUB + 1;
  for (const s of raw.f) {
    if (!Array.isArray(s) || s.length !== 7) return null;
    if (!int(s[0], -far, far) || !int(s[1], -far, far) || !int(s[2], -sp, sp) || !int(s[3], -sp, sp)) return null;
    if (!int(s[4], 0, BOMB) || !anyId(s[5]) || !int(s[6], 0, BIG)) return null;
    f.push(s.slice());
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
    if (!int(d.ha, 0, A - 1) || !int(d.aim, 0, A - 1) || !int(d.q, 0, 999) || !int(d.ws, 0, 999)) return null;
    if (!int(d.fq, 0, FIRE_GRACE) || !int(d.cd, 0, COOL) || !int(d.g1, 0, BOMB) || !int(d.g2, 0, BOMB)) return null;
    if (!int(d.ch, 0, CH_FULL) || !int(d.sc, 0, SCORE_MAX) || !int(d.pp, 0, BIG) || !int(d.cm, 0, 9)) return null;
    if (!int(d.wn, 0, 99999) || !int(d.bw, 0, 999) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 6 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, uc: raw.uc, lf: raw.lf, b, f, p, res, win: raw.win };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed temple steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c, d, e) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b || 0, c: c || 0, d: d || 0, e: e || 0 });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a temple at dusk. A slate floor with a groove cut in it, a gold
// scarab at the mouth, an ember-lit pit in the middle, and five gems that each
// carry a shape of their own as well as a colour. Every player has a bright
// colour that is their shooter's and their chip's.
const INK = {
  page: '#121821', glow: '#22303b', floor: '#2a383e', floorHi: '#33464c', ring: '#3a5056',
  groove: '#10171a', grooveIn: '#1a2428', grooveEdge: '#55747a', dais: '#3a4e55', daisRim: '#86aaad',
  gold: '#ffcf5a', goldDark: '#9a6b1c', pit: '#06080b', ember: '#ff7a3c', danger: '#ff4a4a',
  text: '#ffffff', muted: '#c9d6d8', dim: '#86999c', panel: 'rgba(12,18,24,0.93)',
};
const GEMS = ['#ff4f6e', '#ffb931', '#37d98a', '#3d9bff', '#b97bff'];
const SEAT = ['#ffd23f', '#ff5d8f', '#3fc8ff', '#7be35a', '#ff9a3c', '#c58bff', '#f2f2ff', '#25e0c0'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #3d5157;' +
  `background:#1d2a31;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
// NOTE_ROOM under the temple keeps the practice note off the bottom of the
// groove; in a round the same strip says what your shooter has coming.
const NOTE_ROOM = 60;
let VW = 640, VH = 400, fr = 150, cx = 320, cy = 200, kk = 0.15, TOP = 58, BOT = 26, dpx = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
  const ah = Math.max(80, VH - TOP - BOT - 4 - NOTE_ROOM);
  fr = Math.max(40, Math.min((VW - 16) / 2, ah / 2));
  cx = VW / 2;
  cy = TOP + 2 + ah / 2;
  kk = fr / FIELD;
}
layout();
window.addEventListener('resize', layout);

const SX = (x) => cx + x * kk + shakeX;
const SY = (y) => cy + y * kk + shakeY;
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
// Each gem colour rings on a note of its own, so a pop is heard as its colour.
const NOTES = [523, 587, 659, 784, 880];
const sound = {
  fire(mine) {
    if (!ready(mine ? 'fire' : 'fire2', mine ? 40 : 90)) return;
    tone(mine ? 320 : 260, 0.09, 'triangle', mine ? 0.08 : 0.035, 0.5);
    puff(0.06, mine ? 0.05 : 0.02, 1800, 0, 2);
  },
  clack(c) { if (ready('clack', 40)) { tone(NOTES[c] * 1.5, 0.05, 'square', 0.03, 0.8); puff(0.03, 0.04, 3000, 0, 3); } },
  pop(c, m, mine) {
    if (!ready('pop', 50)) return;
    const base = NOTES[c] * (1 + (m - 1) * 0.25);
    [1, 1.26, 1.5].forEach((k, i) => tone(base * k, 0.14, 'triangle', mine ? 0.08 : 0.04, 0, i * 0.035));
    if (m > 1) [2, 2.52].forEach((k, i) => tone(base * k, 0.18, 'sine', 0.05, 0, 0.12 + i * 0.05));
  },
  boom(mine) {
    if (!ready('boom', 120)) return;
    puff(0.35, mine ? 0.2 : 0.1, 300, 0, 0.8);
    tone(160, 0.35, 'sawtooth', mine ? 0.08 : 0.04, 0.3);
  },
  pit(mine) {
    if (!ready('pit', 140)) return;
    tone(mine ? 140 : 110, 0.3, 'sawtooth', mine ? 0.07 : 0.035, 0.45);
    puff(0.2, mine ? 0.07 : 0.03, 260, 0, 1);
  },
  bomb() { if (ready('bomb', 300)) [988, 1319, 1760].forEach((f, i) => tone(f, 0.08, 'square', 0.035, 0, i * 0.05)); },
  swap() { if (ready('swap', 60)) { tone(1100, 0.04, 'sine', 0.05); tone(1500, 0.05, 'sine', 0.04, 0, 0.04); } },
  danger() { if (ready('danger', 900)) { tone(70, 0.18, 'sine', 0.14, 0.8); tone(66, 0.2, 'sine', 0.12, 0.8, 0.22); } },
  fresh() { if (ready('fresh', 400)) [392, 523, 659].forEach((f, i) => tone(f, 0.12, 'triangle', 0.05, 0, i * 0.07)); },
  warn() { if (ready('warn', 400)) [523, 659, 523, 784].forEach((f, i) => tone(f, 0.16, 'square', 0.04, 1, i * 0.13)); },
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
// fast screen and a slow one see the same sparks. Positions are temple units.
const bits = [];      // { x, y, vx, vy, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 18 + Math.random() * 22, size, colour });
  }
  if (bits.length > 600) bits.splice(0, bits.length - 600);
}
function popText(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 15 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.9; b.vy *= 0.9;
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
let drawFailed = false;
let floorArt = null;          // the floor and the groove, drawn once a size
let floorKey = '';
const born = new Map();       // gem number -> when it was first drawn
const seats = new Map();      // id -> the angle its shooter is drawn at, eased round the dais
let ghosts = [];              // your gems that hit in the guess, held a moment for the room to agree
let lastMine = new Map();     // your gems in flight last frame: number -> [x, y, colour]

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const PIT_X = GX[LEN - 1], PIT_Y = GY[LEN - 1];

function play(e, t) {
  const me = myId();
  if (e.kind === 'fire') {
    if (e.a !== me) sound.fire(false);
  } else if (e.kind === 'clack') {
    ring(e.x, e.y, GEMS[e.b], 50);
    spray(e.x, e.y, 4, lighter(GEMS[e.b], 0.5), 160, 6);
    sound.clack(e.b);
  } else if (e.kind === 'pop') {
    const colour = GEMS[e.b];
    spray(e.x, e.y, 14 + e.e * 4, colour, 420, 9);
    spray(e.x, e.y, 8, '#ffffff', 300, 5);
    ring(e.x, e.y, colour, 110 + e.e * 10);
    const mine = e.a === me;
    if (e.c > 0) popText(e.x, e.y, '+' + e.c, mine ? '#ffffff' : colourOf(t, e.a), mine ? 18 : 14);
    if (e.d > 1) {
      popText(e.x, e.y - 60, 'combo x' + e.d + '!', INK.gold, mine ? 20 : 15);
      ring(e.x, e.y, INK.gold, 180);
    }
    if (mine) shake = Math.max(shake, 2 + e.d * 2);
    sound.pop(e.b, e.d, mine);
  } else if (e.kind === 'boom') {
    spray(e.x, e.y, 34, INK.ember, 600, 10);
    spray(e.x, e.y, 16, '#ffffff', 420, 6);
    ring(e.x, e.y, INK.ember, 200);
    popText(e.x, e.y, 'boom! +' + e.b, e.a === me ? '#ffffff' : colourOf(t, e.a), e.a === me ? 20 : 15);
    shake = Math.max(shake, e.a === me ? 10 : 5);
    sound.boom(e.a === me);
  } else if (e.kind === 'pit') {
    spray(PIT_X, PIT_Y, 10, GEMS[e.b], 260, 8);
    ring(PIT_X, PIT_Y, INK.danger, 120);
    const mine = e.a === me;
    if (e.a !== 0) popText(PIT_X, PIT_Y - 40, '-' + PIT_BILL, mine ? INK.danger : colourOf(t, e.a), mine ? 18 : 13);
    if (mine) shake = Math.max(shake, 6);
    sound.pit(mine);
  } else if (e.kind === 'bomb') {
    if (e.a === me) { sound.bomb(); popText(0, -HUB - 40, 'bomb loaded!', INK.ember, 16); }
  } else if (e.kind === 'fresh') {
    popText(0, 0, 'the pit is fed · a fresh chain', INK.muted, 14);
    sound.fresh();
  } else if (e.kind === 'late') {
    popText(0, 0, '15 seconds!', INK.gold, 20);
    sound.warn();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'round') {
    born.clear();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

function drawGround() {
  flat();
  const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
}

// The floor, the groove and the dais, into a picture of their own whenever
// the size changes: nothing on them moves.
function floorPicture() {
  const key = fr.toFixed(2) + '|' + dpx;
  if (floorArt && key === floorKey) return floorArt;
  floorKey = key;
  const size = Math.ceil(fr * 2 + 12);
  if (!floorArt) floorArt = document.createElement('canvas');
  floorArt.width = Math.ceil(size * dpx);
  floorArt.height = Math.ceil(size * dpx);
  const g = floorArt.getContext('2d');
  g.setTransform(dpx, 0, 0, dpx, 0, 0);
  g.clearRect(0, 0, size, size);
  const o = size / 2;
  const P = (u) => o + u * kk;
  // A round slate floor with a rim and a few rings worn into it.
  g.fillStyle = '#1b2529';
  g.beginPath(); g.arc(o, o, fr + 4, 0, Math.PI * 2); g.fill();
  const fl = g.createRadialGradient(o, o - fr * 0.3, fr * 0.1, o, o, fr);
  fl.addColorStop(0, INK.floorHi);
  fl.addColorStop(1, INK.floor);
  g.fillStyle = fl;
  g.beginPath(); g.arc(o, o, fr, 0, Math.PI * 2); g.fill();
  g.strokeStyle = INK.ring;
  g.lineWidth = Math.max(1, fr * 0.006);
  for (const r of [0.97, 0.62, 0.36]) { g.beginPath(); g.arc(o, o, fr * r, 0, Math.PI * 2); g.stroke(); }
  // The groove: an edge, a channel, and a floor to the channel.
  const lineOf = () => {
    g.beginPath();
    g.moveTo(P(GX[0]), P(GY[0]));
    for (let i = 6; i < LEN; i += 6) g.lineTo(P(GX[i]), P(GY[i]));
    g.lineTo(P(GX[LEN - 1]), P(GY[LEN - 1]));
  };
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [colour, wd] of [[INK.grooveEdge, 1.3], [INK.groove, 1.16], [INK.grooveIn, 0.8]]) {
    g.strokeStyle = colour;
    g.lineWidth = GEM * wd * kk;
    lineOf();
    g.stroke();
  }
  // Marks along the groove every few gems, so its run can be read at a glance.
  g.fillStyle = 'rgba(134,170,173,0.35)';
  for (let i = GEM * 3; i < LEN - GEM; i += GEM * 3) {
    g.beginPath(); g.arc(P(GX[i]), P(GY[i]), Math.max(1, GEM * 0.06 * kk), 0, Math.PI * 2); g.fill();
  }
  // The dais the shooters stand on.
  g.fillStyle = '#1b2529';
  g.beginPath(); g.arc(o, o, (HUB + 48) * kk + 3, 0, Math.PI * 2); g.fill();
  g.fillStyle = INK.dais;
  g.beginPath(); g.arc(o, o, (HUB + 48) * kk, 0, Math.PI * 2); g.fill();
  g.strokeStyle = INK.daisRim;
  g.lineWidth = Math.max(1, 2 * kk * 3);
  g.beginPath(); g.arc(o, o, (HUB + 40) * kk, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(255,207,90,0.18)';
  g.beginPath(); g.arc(o, o, (HUB - 70) * kk, 0, Math.PI * 2); g.fill();
  return floorArt;
}

function drawFloor() {
  flat();
  const art = floorPicture();
  const s = art.width / dpx;
  ctx.drawImage(art, cx - s / 2 + shakeX, cy - s / 2 + shakeY, s, s);
}

// The pit: a hole with embers round its rim, burning hotter as the head of
// the chain comes near.
function drawPit(heat, now) {
  const x = SX(PIT_X), y = SY(PIT_Y), r = GEM * 0.95 * kk;
  const pulse = 0.5 + 0.5 * Math.sin(now / (heat > 0.5 ? 90 : 260));
  ctx.fillStyle = alpha(heat > 0.5 ? INK.danger : INK.ember, 0.18 + 0.25 * heat * pulse + 0.08);
  disc(x, y, r * (1.9 + 0.4 * heat * pulse));
  ctx.fill();
  ctx.fillStyle = INK.ember;
  disc(x, y, r * 1.12);
  ctx.fill();
  const g = ctx.createRadialGradient(x, y, 1, x, y, r);
  g.addColorStop(0, INK.pit);
  g.addColorStop(0.75, '#140c08');
  g.addColorStop(1, '#4a1c0c');
  ctx.fillStyle = g;
  disc(x, y, r);
  ctx.fill();
}

// A gem: a disc of its colour, a darker lower lip, its shape cut into it in a
// paler tone, and a glint. `spin` turns the shape as the gem rolls.
function drawGem(x, y, r, c, spin) {
  if (c === BOMB) { drawBomb(x, y, r); return; }
  const base = GEMS[c];
  ctx.fillStyle = darker(base, 0.35);
  disc(x, y + r * 0.06, r);
  ctx.fill();
  ctx.fillStyle = base;
  disc(x, y - r * 0.04, r * 0.92);
  ctx.fill();
  ctx.save();
  ctx.translate(x, y - r * 0.04);
  ctx.rotate(spin);
  ctx.fillStyle = lighter(base, 0.45);
  const s = r * 0.5;
  ctx.beginPath();
  if (c === 0) { ctx.moveTo(0, -s); ctx.lineTo(s * 0.8, 0); ctx.lineTo(0, s); ctx.lineTo(-s * 0.8, 0); }
  else if (c === 1) ctx.arc(0, 0, s * 0.62, 0, Math.PI * 2);
  else if (c === 2) { ctx.moveTo(0, -s); ctx.lineTo(s * 0.9, s * 0.65); ctx.lineTo(-s * 0.9, s * 0.65); }
  else if (c === 3) ctx.rect(-s * 0.62, -s * 0.62, s * 1.24, s * 1.24);
  else {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4, l = i % 2 ? s * 0.38 : s;
      ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l);
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.35, y - r * 0.42, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

function drawBomb(x, y, r) {
  const now = performance.now();
  ctx.fillStyle = '#0d1114';
  disc(x, y + r * 0.06, r);
  ctx.fill();
  ctx.fillStyle = '#2b3338';
  disc(x, y - r * 0.04, r * 0.9);
  ctx.fill();
  ctx.strokeStyle = INK.goldDark;
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.beginPath();
  ctx.moveTo(x + r * 0.4, y - r * 0.7);
  ctx.quadraticCurveTo(x + r * 0.8, y - r * 1.2, x + r * 1.0, y - r * 1.0);
  ctx.stroke();
  ctx.fillStyle = Math.floor(now / 80) % 2 ? INK.gold : INK.ember;
  disc(x + r * 1.0, y - r * 1.0, r * (0.22 + 0.08 * Math.sin(now / 50)));
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  disc(x - r * 0.3, y - r * 0.35, r * 0.18);
  ctx.fill();
}

// The point a distance along the groove, in sixteenths, and the way it runs.
function grooveAt(s16) {
  const s = Math.max(0, Math.min(LEN - 1.001, s16 / SUB)), i = Math.floor(s), k = s - i;
  const x = GX[i] + (GX[i + 1] - GX[i]) * k, y = GY[i] + (GY[i + 1] - GY[i]) * k;
  const j = Math.min(LEN - 1, i + 8), h = Math.max(0, i - 8);
  return [x, y, Math.atan2(GY[j] - GY[h], GX[j] - GX[h])];
}

// The chain as drawn: each gem between where it stood at the two steps the
// drawing is between, matched by its number; a gem that jumped more than a
// few gems' worth — a fresh chain — is put where it is now.
function drawChain(b, now) {
  const from = new Map();
  for (const g of b.from.b) from.set(g[5], g[0]);
  const r = GEM * 0.5 * kk;
  const out = [];
  for (const g of b.to.b) {
    const a = from.get(g[5]);
    const s = a !== undefined && Math.abs(a - g[0]) < 4 * D16 ? lerp(a, g[0], b.k) : g[0];
    let t0 = born.get(g[5]);
    if (t0 === undefined) { t0 = now; born.set(g[5], now); }
    const grow = Math.min(1, (now - t0) / 160);
    const [x, y] = grooveAt(s);
    out.push([x, y, s, g]);
    drawGem(SX(x), SY(y), r * (0.55 + 0.45 * ease(grow)), g[1], s / SUB / (GEM * 0.5));
    // Whose gem it is, when somebody fired it: their colour at its heart, and
    // a white one for your own, which the pit would bill to you.
    if (g[2] !== 0 && b.to.p[g[2]]) {
      ctx.fillStyle = g[2] === myId() ? '#ffffff' : SEAT[b.to.p[g[2]].c];
      disc(SX(x), SY(y) - r * 0.04, Math.max(1.5, r * 0.17));
      ctx.fill();
    }
  }
  if (born.size > 600) {
    const keep = new Set(b.to.b.map((g) => g[5]));
    for (const u of born.keys()) if (!keep.has(u)) born.delete(u);
  }
  return out;
}

// The scarab, behind the last gem of the chain, pushing.
function drawScarab(b, now) {
  const tail = b.to.b[0];
  const s = tail ? Math.max(0, tail[0] - D16 * 0.85) : 0;
  const [x, y, dir] = grooveAt(s);
  const X = SX(x), Y = SY(y), r = GEM * 0.5 * kk;
  ctx.save();
  ctx.translate(X, Y);
  ctx.rotate(dir);
  const step = Math.sin(now / 90) * r * 0.18;
  ctx.strokeStyle = INK.goldDark;
  ctx.lineWidth = Math.max(1, r * 0.14);
  ctx.beginPath();
  for (const side of [-1, 1]) {
    for (let i = -1; i <= 1; i++) {
      const lx = i * r * 0.45 + (i === 0 ? step : -step) * side;
      ctx.moveTo(lx, side * r * 0.5);
      ctx.lineTo(lx + r * 0.2, side * r * 0.98);
    }
  }
  ctx.stroke();
  ctx.fillStyle = INK.goldDark;
  ctx.beginPath(); ctx.ellipse(-r * 0.05, 0, r * 0.82, r * 0.66, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = INK.gold;
  ctx.beginPath(); ctx.ellipse(-r * 0.1, 0, r * 0.74, r * 0.58, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = INK.goldDark;
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.beginPath(); ctx.moveTo(-r * 0.8, 0); ctx.lineTo(r * 0.4, 0); ctx.stroke();
  ctx.fillStyle = '#c99a32';
  ctx.beginPath(); ctx.ellipse(r * 0.62, 0, r * 0.3, r * 0.36, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath(); ctx.ellipse(-r * 0.3, -r * 0.28, r * 0.25, r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Where a shooter stands, eased round the dais when the seats change.
function seatAngle(id, ha) {
  const want = (ha / A) * Math.PI * 2;
  let a = seats.get(id);
  if (a === undefined) a = want;
  let d = want - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  a += d * per60(0.15);
  seats.set(id, a);
  return a;
}

// A shooter: a stone idol in its seat's colour on the dais, turned to where it
// points, with the gem it has loaded in its mouth and the next one behind; a
// ring round it fills as a bomb charges.
function drawShooter(t, id, d, sa, aimRad, me, now, lead) {
  const x = SX(Math.cos(sa) * HUB), y = SY(Math.sin(sa) * HUB), r = 30 * kk + 2;
  const colour = SEAT[d.c];
  const recoil = me ? Math.max(0, 1 - (now - firedAt) / 140) : 0;
  if (d.ch > 0 && d.g1 !== BOMB && d.g2 !== BOMB) {
    ctx.strokeStyle = alpha(INK.ember, 0.75);
    ctx.lineWidth = Math.max(1.5, r * 0.16);
    ctx.beginPath();
    ctx.arc(x, y, r * 1.35, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * d.ch) / CH_FULL);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  disc(x, y + r * 0.2, r * 1.05);
  ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aimRad);
  ctx.translate(-recoil * r * 0.3, 0);
  ctx.fillStyle = darker(colour, 0.35);
  roundRect(-r * 0.2, -r * 0.48, r * 1.5, r * 0.96, r * 0.4);
  ctx.fill();
  ctx.fillStyle = colour;
  disc(0, 0, r);
  ctx.fill();
  ctx.fillStyle = darker(colour, 0.55);
  disc(-r * 0.05, -r * 0.42, r * 0.16);
  disc(-r * 0.05, r * 0.42, r * 0.16);
  ctx.fill();
  ctx.restore();
  const gr = GEM * 0.5 * kk * 0.86;
  const mx = x + Math.cos(aimRad) * (r * 1.15 - recoil * r * 0.3), my = y + Math.sin(aimRad) * (r * 1.15 - recoil * r * 0.3);
  if (d.cd === 0 || !me) drawGem(mx, my, gr, d.g1, 0);
  else drawGem(mx, my, gr * (1 - d.cd / COOL), d.g1, 0);
  drawGem(x - Math.cos(aimRad) * r * 0.55, y - Math.sin(aimRad) * r * 0.55, gr * 0.55, d.g2, 0);
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    disc(x, y, r + 2);
    ctx.stroke();
  }
  // The name sits outside the dais, along the seat's own line.
  const lx = SX(Math.cos(sa) * (HUB + 105)), ly = SY(Math.sin(sa) * (HUB + 105)) + 4;
  const px = Math.max(9, Math.min(13, fr * 0.05));
  const label = (me ? 'you' : nickOf(id)) + (id === lead ? ' ♛' : '');
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(12,18,24,0.8)';
  ctx.strokeText(label, lx, ly);
  ctx.fillStyle = id === lead ? INK.gold : me ? '#ffffff' : colour;
  ctx.fillText(label, lx, ly);
}

// Where your shot would go: a dotted line from the mouth to the first gem it
// would meet, and a ghost of your gem there.
function drawGuide(sa, aimRad, chain, colour) {
  const ox = Math.cos(sa) * HUB + Math.cos(aimRad) * MUZZLE, oy = Math.sin(sa) * HUB + Math.sin(aimRad) * MUZZLE;
  const dx = Math.cos(aimRad), dy = Math.sin(aimRad);
  let hitAt = null, l = 0;
  for (; l < FIELD * 2; l += 10) {
    const x = ox + dx * l, y = oy + dy * l;
    if (x * x + y * y > FIELD * FIELD) break;
    for (const g of chain) {
      const ex = g[0] - x, ey = g[1] - y;
      if (ex * ex + ey * ey < HIT * HIT) { hitAt = [x, y]; break; }
    }
    if (hitAt) break;
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(SX(ox), SY(oy));
  ctx.lineTo(SX(ox + dx * l), SY(oy + dy * l));
  ctx.stroke();
  ctx.setLineDash([]);
  if (hitAt) {
    ctx.globalAlpha = 0.35;
    drawGem(SX(hitAt[0]), SY(hitAt[1]), GEM * 0.5 * kk, colour, 0);
    ctx.globalAlpha = 1;
  }
}

// Gems in flight between two steps, matched by number, with a short trail.
function drawShots(b, keep, now) {
  const from = new Map();
  for (const s of b.from.f) from.set(s[6], s);
  const r = GEM * 0.5 * kk * 0.9;
  const seen = new Map();
  for (const s of b.to.f) {
    if (!keep(s)) continue;
    const a = from.get(s[6]);
    const x = (a ? lerp(a[0], s[0], b.k) : s[0]) / SUB, y = (a ? lerp(a[1], s[1], b.k) : s[1]) / SUB;
    seen.set(s[6], [x, y, s[4]]);
    const vx = s[2] / SUB, vy = s[3] / SUB;
    for (let i = 3; i >= 1; i--) {
      ctx.globalAlpha = 0.12 * (4 - i);
      ctx.fillStyle = s[4] === BOMB ? INK.ember : GEMS[s[4]];
      disc(SX(x - vx * i * 1.6), SY(y - vy * i * 1.6), r * (1 - i * 0.18));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    drawGem(SX(x), SY(y), r, s[4], now / 90);
  }
  return seen;
}

function drawBits() {
  flat();
  for (const b of bits) {
    const k = b.life / b.max;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = b.colour;
    disc(SX(b.x), SY(b.y), b.size * kk * (1 - k * 0.5) + 0.5);
    ctx.fill();
  }
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = (1 - k) * 0.7;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - k) + 1;
    disc(SX(r.x), SY(r.y), r.r * kk * ease(k));
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
    ctx.strokeStyle = 'rgba(12,18,24,0.85)';
    const X = SX(p.x), Y = SY(p.y) - rise;
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
    const late = t.pt <= 15 * HZ;
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + (late ? ' · hurry!' : '');
    if (late) colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('scarab', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('scarab').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, points this round and
  // rounds won; the leader's points in gold, a bomb on the way as an ember dot.
  const ids = bySeat(t);
  const lead = leaderOf(t);
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
      ctx.fillStyle = c;
      disc(x + 11, y - 2, 5);
      ctx.fill();
      if (d.g1 === BOMB || d.g2 === BOMB) {
        ctx.fillStyle = INK.ember;
        disc(x + 11, y - 2, 2.2);
        ctx.fill();
      }
      const score = String(d.sc) + (d.wn && cw > 60 ? ' ★' + d.wn : '');
      ctx.font = font(12);
      const sw = Math.min(cw - 24, ctx.measureText(score).width);
      fitText(score, x + cw - 8, y + 3, 12, id === lead ? INK.gold : INK.text, cw - 24, 'right');
      if (cw > 56) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to aim, let go to fire · tap your shooter to swap · three of a colour pop'
    : 'aim with the mouse or A/D · click or Space fires · right-click or S swaps · three of a colour pop · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// In a round, the strip under the temple says what your shooter has coming,
// or what leading costs you.
function drawMine(t, d, now) {
  if (!d || t.ph !== PLAY) return;
  flat();
  const y = cy + fr + 6 + NOTE_ROOM / 2 - 2;
  let line = '', colour = INK.muted;
  if (d.g1 === BOMB) { line = 'bomb loaded · it bursts the gem it hits and two either side'; colour = INK.ember; }
  else if (d.g2 === BOMB) { line = 'a bomb is next · swap it in, or fire this gem first'; colour = INK.ember; }
  else if (leaderOf(t) === myId()) { line = 'you lead · every plain gem the pit swallows costs you ' + PIT_BILL; colour = INK.gold; }
  else line = 'behind · your bomb charges ' + Math.round((100 * d.ch) / CH_FULL) + '%';
  if (colour !== INK.muted && Math.floor(now / 500) % 2) colour = INK.text;
  fitText(line, VW / 2, y, 13, colour, VW - 24);
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
  const top = cy - fr - 6, bottom = cy + fr + 6;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'fire into the chain · three of a colour pop · a gap that closes on a match pops again';
    practiceNote(now, VW, head, tip, [[TOP, top - 4], [bottom + 4, VH - BOT]], Math.min(bottom, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,18,24,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, cy + big);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, cy + big * 2.1, Math.min(VW - 32, 340), 30);
    fitText('most points when the time is up takes the round', cx, cy + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 320));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(12,18,24,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('go!', cx, cy + big * 0.5);
    text('go!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 360), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, cy + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody scored the most';
    else head = t.win === me ? 'you win the round!' : nickOf(t.win) + ' wins the round';
    const y0 = cy + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    const cols = [['points', 156], ['gems', 108], ['combo', 62], ['rounds', 16]];
    for (const [name, off] of cols) text(name, cx + w / 2 - off, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, won, wins, pts, gems, combo], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (won ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 230, 'left');
      text(String(pts), cx + w / 2 - 156, y, 14, INK.text, 'right');
      text(String(gems), cx + w / 2 - 108, y, 14, INK.text, 'right');
      text(combo > 1 ? 'x' + combo : '—', cx + w / 2 - 62, y, 14, combo > 1 ? INK.gold : INK.dim, 'right');
      text(String(wins), cx + w / 2 - 16, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Everybody else's aim, eased toward what the table says, since a hand that
// turns arrives a few times a second rather than every frame.
const aims = new Map();
function shownAim(id, a) {
  const want = (a / A) * Math.PI * 2;
  let v = aims.get(id);
  if (v === undefined) v = want;
  let d = want - v;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  v += d * per60(0.3);
  aims.set(id, v);
  return v;
}

function draw(now) {
  const b = agreedAt(now);
  drawGround();
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the temple…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a temple this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const me = myId();
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : null;
  drawFloor();
  const head = t.b.length ? t.b[t.b.length - 1][0] : 0;
  const heat = Math.max(0, Math.min(1, 1 - (LEN16 - head) / DANGER));
  if (heat > 0.6 && t.ph === PLAY) sound.danger();
  drawPit(heat, now);
  const chainAt = drawChain(b, now);
  drawScarab(b, now);
  const lead = t.ph === WAIT || t.ph === PLAY ? leaderOf(t) : -1;
  for (const id of bySeat(t)) {
    if (id === me) continue;
    const d = t.p[id];
    drawShooter(t, id, d, seatAngle(id, d.ha), shownAim(id, d.aim), false, now, lead);
  }
  drawShots(b, (s) => s[5] !== me, now);
  const mine = own ? own.to.p[me] : t.p[me];
  if (mine) {
    const sa = seatAngle(me, t.p[me] ? t.p[me].ha : mine.ha);
    if (t.ph !== END) drawGuide(sa, aimRad, chainAt, mine.g1);
    // Your gems in flight are the guess's; one the guess has seen hit is held
    // a moment where it hit, until the room's temple shows it in the chain.
    const flying = drawShots(own || b, (s) => s[5] === me, now);
    for (const [u, v] of lastMine) {
      if (flying.has(u) || v[0] * v[0] + v[1] * v[1] > (FIELD - 40) * (FIELD - 40)) continue;
      let near = false;
      for (const f of flying.values()) if (Math.abs(f[0] - v[0]) + Math.abs(f[1] - v[1]) < 120) near = true;
      if (!near) ghosts.push({ x: v[0], y: v[1], c: v[2], t0: now });
    }
    lastMine = flying;
    ghosts = ghosts.filter((g) => now - g.t0 < 220);
    for (const g of ghosts) {
      ctx.globalAlpha = 1 - (now - g.t0) / 220;
      drawGem(SX(g.x), SY(g.y), GEM * 0.5 * kk * 0.9, g.c, 0);
    }
    ctx.globalAlpha = 1;
    drawShooter(t, me, mine, sa, aimRad, true, now, lead);
  } else lastMine = new Map();
  for (const id of seats.keys()) if (!t.p[id]) { seats.delete(id); aims.delete(id); }
  drawBits();
  drawHud(t, now);
  drawMine(t, mine, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: where your shooter points, in steps of aim, and two
// counters, one for shots and one for swaps. A turn of the aim goes out no
// oftener than AIM_EVERY, because a thumb or a mouse changes it on every move
// the screen reports and the clock's ticks share the same seat's ceiling on
// messages; a shot or a swap goes out at once.
const AIM_EVERY = 100;
const TURN_RATE = 2.4;         // radians a second the keys turn the aim
let shots = 0, swaps = 0, saidAt = -1e9, lastSaid = null;
let aimRad = -Math.PI / 2, aimSet = false, synced = false, firedAt = -1e9;
const keys = new Set();

function aimIdx() {
  let a = Math.round((aimRad / (Math.PI * 2)) * A) % A;
  if (a < 0) a += A;
  return a;
}

function sayHand(now, force) {
  const h = [aimIdx(), shots, swaps], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1] && h[2] === s[2]) return;
  if (!force && s && h[1] === s[1] && h[2] === s[2] && now - saidAt < AIM_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// Your shooter on the screen, where it is drawn.
function shooterScreen() {
  const d = world && world.p[myId()];
  if (!d) return null;
  const sa = seats.has(myId()) ? seats.get(myId()) : (d.ha / A) * Math.PI * 2;
  return [SX(Math.cos(sa) * HUB), SY(Math.sin(sa) * HUB)];
}

function aimAt(px, py) {
  const o = shooterScreen();
  if (!o) return;
  const dx = px - o[0], dy = py - o[1];
  if (dx * dx + dy * dy < 64) return;
  aimRad = Math.atan2(dy, dx);
  aimSet = true;
}

// A shot: heard at once, and fired a trip later on every copy alike, if the
// table says the shooter has reloaded.
function shoot() {
  wake();
  const now = performance.now();
  shots = (shots + 1) % 1000;
  sayHand(now, true);
  const m = mineAt(now);
  const d = m && m.to.p[myId()];
  if (d && d.cd === 0 && world && (world.ph === PLAY || world.ph === WAIT)) { firedAt = now; sound.fire(true); }
}

function swap() {
  wake();
  swaps = (swaps + 1) % 1000;
  sayHand(performance.now(), true);
  sound.swap();
}

// Keys are read by where they sit, not what they type, so every layout runs.
const KEY_FIRE = new Set(['Space', 'Enter', 'ArrowUp', 'KeyW']);
const KEY_SWAP = new Set(['KeyS', 'ArrowDown', 'KeyX', 'ShiftLeft', 'ShiftRight']);
const KEY_TURN = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (KEY_FIRE.has(e.code)) { e.preventDefault(); coarse = false; if (!e.repeat) shoot(); return; }
  if (KEY_SWAP.has(e.code)) { e.preventDefault(); coarse = false; if (!e.repeat) swap(); return; }
  if (e.code in KEY_TURN) { e.preventDefault(); coarse = false; keys.add(e.code); }
});
addEventListener('keyup', (e) => { keys.delete(e.code); });
addEventListener('blur', () => { keys.clear(); drag = null; });

// A mouse aims as it moves and fires on a click; a right click swaps. A thumb
// aims where it is put down and as it drags, and fires as it lifts; a tap on
// your own shooter swaps. Bound to the canvas and captured there, because iOS
// keeps a long press inside a frame for itself.
const DEAD = 12;
let drag = null;               // { id, x0, y0, x, y, moved, onMe }
const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  const [px, py] = local(e);
  if (e.pointerType === 'mouse') {
    if (e.button === 2) { swap(); return; }
    if (e.button !== 0) return;
    aimAt(px, py);
    shoot();
    return;
  }
  if (drag) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  const o = shooterScreen();
  const onMe = !!o && Math.hypot(px - o[0], py - o[1]) < Math.max(24, 34 * kk + 12);
  drag = { id: e.pointerId, x0: px, y0: py, x: px, y: py, moved: false, onMe };
  if (!onMe) aimAt(px, py);
});
cv.addEventListener('pointermove', (e) => {
  const [px, py] = local(e);
  if (e.pointerType === 'mouse' && !drag) { aimAt(px, py); return; }
  if (!drag || e.pointerId !== drag.id) return;
  drag.x = px;
  drag.y = py;
  if (Math.hypot(px - drag.x0, py - drag.y0) > DEAD) drag.moved = true;
  if (!drag.onMe || drag.moved) aimAt(px, py);
});
function lift(e, fire) {
  if (!drag || e.pointerId !== drag.id) return;
  const was = drag;
  drag = null;
  if (!fire) return;
  if (was.onMe && !was.moved) swap();
  else shoot();
}
cv.addEventListener('pointerup', (e) => lift(e, true));
cv.addEventListener('pointercancel', (e) => lift(e, false));

// Where the thumb is, while it aims.
function drawDrag() {
  if (!drag || (drag.onMe && !drag.moved)) return;
  flat();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  disc(drag.x, drag.y, 20);
  ctx.stroke();
}

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  // The first time the table has your shooter, the counters pick up from it,
  // so a page opened again does not fire what the last one already fired, and
  // the aim starts out pointing away from the dais.
  const d = world && world.p[myId()];
  if (d && !synced) {
    synced = true;
    if (shots === 0 && swaps === 0) { shots = d.q; swaps = d.ws; }
    if (!aimSet) aimRad = (d.ha / A) * Math.PI * 2;
  }
  let turn = 0;
  for (const k of keys) turn += KEY_TURN[k] || 0;
  if (turn) { aimRad += Math.sign(turn) * TURN_RATE * frameDt; aimSet = true; }
  sayHand(now);
  try { draw(now); drawDrag(); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. A hand is how a player arrives on the
// dais, so one is said at once.
function start() {
  lastSaid = [0, 0, 0];
  setHand([0, 0, 0]);
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
