/**
 * @disk     dodgeball
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Team dodgeball where every out is a point. Grab a ball, throw it at a rival, and duck or catch what flies back: a catch puts the thrower out and brings a teammate back in. Out, you throw from behind their line, and a hit brings you home.
 * @tags     game, party, realtime, sports, team, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/dodgeball.png
 */
// dodgeball.js — two teams on one court, where the room's order is the
// referee.
//
// Every copy holds every player, every ball and who stands in which jail, and
// changes them only on what comes back round the room, so every copy applies
// the same hands in the same order and holds the same court. Nobody sends where
// a ball went, who it hit or who caught it: a hand is which way a player runs,
// which way they aim, and a counter that moves on by one every time they press
// the one button. Whether that press throws or opens their arms for a catch is
// the table's business, and so is everything after it — the same arithmetic on
// the same whole numbers on every machine. A page with a console open can run
// its own player however it likes, at the speed every player runs, inside its
// own half, and throw only a ball it holds, at the speed every throw flies.
//
// While a player is alone, a bot plays on the other team. It is part of the
// table like any player, and its moves are a function of the table alone, so
// it plays the same on every copy and says nothing over the wire. When a second
// player arrives, practice runs on for three seconds under a note that says so,
// and the bot leaves before the round is laid out: it never takes part in one.
//
// Your own player does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — the court is 72000 units across, a
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

// A direction stretched or shrunk to a length, in whole units: nothing if it
// points nowhere.
function toLength(x, y, len) {
  const l = isqrt(x * x + y * y);
  if (l === 0) return [0, 0];
  return [Math.trunc((x * len) / l), Math.trunc((y * len) / l)];
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the court a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own player a trip ahead, with your hand in it

// The court, seen from above: x across, y down. Each team plays on its own
// half of the middle, and a team's jail is the strip behind the other team's
// back line, so whoever is out stands behind the people they want to hit.
// Everything moves in SUB substeps a step, so the fastest ball moves less than
// a player's size between two looks and never slips through anybody.
const FW = 72000, FH = 46000;
const JW = 6000;               // a jail strip's depth
const MID = FW / 2;
const SUB = 3;
const R = 1600;                // a player's radius
const BR = 760;                // a ball's
const SPD = 100;               // a player's top speed, a substep
const HOLD_SPD = 82;           // with a ball in hand
const STANCE_SPD = 45;         // with the arms open for a catch
const THROW_V = 420;           // a throw's speed, a substep
const FEVER_V = 520;           // and once the fever is on
const SHORT_V = 90;            // and more for a team a player short
const LIVE_SUBS = 26 * SUB;    // substeps a throw flies before it drops dead
const CATCH_STEPS = 8;         // steps the arms stay open
const LAST_CATCH = 13;         // and for the last of a team still on court
const CATCH_CD = 22;           // steps from opening the arms to opening them again
const THROW_CD = 8;            // steps from a throw to picking up again
const HOLD_WARN = 4 * HZ;      // steps a ball may be held before it starts to slip
const HOLD_MAX = 5 * HZ;       // and before it is gone
const STALE = 8 * HZ;          // steps a ball may lie still before it rolls over the middle
const REACH = R + BR + 300;    // how near a loose ball must be to be picked up
const ROUND_STEPS = 90 * HZ;
const FEVER_AT = 60 * HZ;      // half a minute from the end the balls fly faster
const OT_STEPS = 20 * HZ;      // sudden death after a tie, then a draw
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const MAX_B = 8;
const BIG = 2147483647;
const VLIM = 2000;             // no speed in the table is ever beyond this

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const END_STEPS = 6 * HZ;

const LOOSE = 0, LIVE = 1, HELD = 2;   // a ball: on the floor, in flight, in somebody's hands

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player and every ball is made by one function with its fields in
// one order.
//   sc: each team's points; ck: steps played in this round; fv: the fever is
//   on; ot: sudden death, the next point takes it; b: the balls; res: the last round's [id, team, outs, catches, rounds won]
//   rows; win: the team that took it, -1 for a draw
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, sc: [0, 0], ck: 0, fv: 0, ot: 0, p: {}, b: [], res: null, win: -1 };
  resetBalls(w);
  return w;
}

const BFIELDS = ['x', 'y', 'vx', 'vy', 'z', 'h', 'tm', 'th', 'lv', 'st'];
//   x, y: where; vx, vy: how fast, a substep; z: loose, live or held; h: who
//   holds it, 0 for nobody; tm: the team that threw it, -1 for none; th: who
//   threw it, 0 for nobody; lv: substeps of flight left; st: steps it has lain
//   still
function ballOf(v) {
  const b = {};
  for (const f of BFIELDS) b[f] = v[f];
  return b;
}
const looseBall = (x, y) => ballOf({ x, y, vx: 0, vy: 0, z: LOOSE, h: 0, tm: -1, th: 0, lv: 0, st: 0 });

const FIELDS = ['c', 's', 'tm', 'o', 'oa', 'x', 'y', 'vx', 'vy', 'mx', 'my', 'ax', 'ay', 'fx', 'fy', 'q', 'hq',
  'hb', 'ht', 'cs', 'cc', 'tc', 'k', 'cg', 'wn', 'bw', 'bt', 'hs', 'hc'];
//   c: colour; s: seat; tm: team, 0 on the left or 1 on the right; o: out, in
//   the jail behind the other team; oa: the step they went out at, so the
//   first out is the first back; x, y: where; vx, vy: how fast, a substep; mx,
//   my: the way the hand runs, a thousand at full; ax, ay: the way it aims;
//   fx, fy: the way the player faces; q: the button counter as last heard; hq:
//   a press to take this step; hb: the ball held, -1 for none; ht: steps it has
//   been held; cs: steps the arms stay open; cc: steps until they may open
//   again; tc: steps until a ball may be picked up after a throw; k, cg: outs
//   made and catches this round; wn: rounds won; bw, bt: the bot's pause and
//   how long it means to hold a ball; hs, hc: hands this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);
const teamOf = (w, t) => bySeat(w).filter((id) => w.p[id].tm === t);
const onCourt = (w, t) => teamOf(w, t).filter((id) => !w.p[id].o);

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

function smallerTeam(w) {
  const n = [0, 0];
  for (const id of playersIn(w)) n[w.p[id].tm] += 1;
  return n[1] < n[0] ? 1 : 0;
}

// Where a player may stand: their own half while on court, and the jail
// behind the other team while out.
function zoneOf(d) {
  if (!d.o) return d.tm ? [MID + R, FW - JW - R] : [JW + R, MID - R];
  return d.tm ? [R, JW - R] : [FW - JW + R, FW - R];
}
const backX = (t) => (t ? FW - JW - 5000 : JW + 5000);
const jailX = (t) => (t ? JW / 2 : FW - JW / 2);
const forward = (t) => (t ? -1 : 1);

function newPlayer(w, q) {
  const tm = smallerTeam(w);
  // Somebody arriving in the middle of a round starts in jail, and plays their
  // way in like anybody who was hit.
  const o = w.ph === PLAY ? 1 : 0;
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), tm, o, oa: w.n, x: o ? jailX(tm) : backX(tm), y: FH / 2, vx: 0, vy: 0,
    mx: 0, my: 0, ax: 0, ay: 0, fx: forward(tm) * 1000, fy: 0, q, hq: 0, hb: -1, ht: 0, cs: 0, cc: 0, tc: 0,
    k: 0, cg: 0, wn: 0, bw: 0, bt: 0, hs: w.n, hc: 0,
  });
}

// How many balls a court of this many players plays with.
const ballsFor = (n) => clamp(2 + Math.ceil(n / 2), 3, 6);

// The balls laid along the middle line, still, for both teams to rush. A team
// a player short finds one more on its own side.
function resetBalls(w) {
  const n = ballsFor(playersIn(w).length);
  w.b = [];
  for (let i = 0; i < n; i++) w.b.push(looseBall(MID, Math.trunc((FH * (i + 1)) / (n + 1))));
  const a = teamOf(w, 0).length, z = teamOf(w, 1).length;
  if (a !== z && a && z) {
    const t = a < z ? 0 : 1;
    w.b.push(looseBall(MID + forward(t) * -9000, FH / 2));
  }
  for (const id of playersIn(w)) { w.p[id].hb = -1; w.p[id].ht = 0; }
}

// Every team's players spread out along their back line, still, nobody out.
function placeAll(w) {
  for (const t of [0, 1]) {
    const ids = teamOf(w, t), n = ids.length;
    ids.forEach((id, k) => {
      const d = w.p[id];
      d.o = 0;
      d.x = backX(t);
      d.y = Math.trunc((FH * (k + 1)) / (n + 1));
      d.vx = d.vy = d.cs = d.cc = d.tc = d.hq = 0;
      d.fx = forward(t) * 1000;
      d.fy = 0;
    });
  }
}

// Teams never differ by more than one: whoever arrived last on the bigger team
// crosses over, between rounds only.
function balance(w) {
  for (let guard = 0; guard < MAX_P; guard++) {
    const a = teamOf(w, 0), z = teamOf(w, 1);
    if (Math.abs(a.length - z.length) <= 1) return;
    const from = a.length > z.length ? a : z;
    w.p[from[from.length - 1]].tm = a.length > z.length ? 1 : 0;
  }
}

// A hand, at its place in the room's order: [the way run across, and down, the
// way aimed across, and down, the button counter]. A press is taken once,
// when the counter changes; the same hand said again to keep a player at the
// table presses nothing. Being heard is how a player arrives: on the smaller
// team, at once.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[4]);
    d.mx = input[0]; d.my = input[1]; d.ax = input[2]; d.ay = input[3];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.mx = input[0]; d.my = input[1]; d.ax = input[2]; d.ay = input[3];
  if (input[4] !== d.q) { d.q = input[4]; d.hq = 1; }
}

// A hand off the wire, made safe: five integers in their ranges, or nothing.
// How fast a player runs and a ball flies is the table's business: a hand
// names a direction, and nothing it says makes either faster.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  for (const v of raw) if (!Number.isInteger(v)) return null;
  const [mx, my, ax, ay, q] = raw;
  if (mx < -1000 || mx > 1000 || my < -1000 || my > 1000) return null;
  if (ax < -1000 || ax > 1000 || ay < -1000 || ay > 1000 || q < 0 || q > 999) return null;
  return [mx, my, ax, ay, q];
}

// A ball let go where its holder stands, still.
function drop(w, d) {
  const b = w.b[d.hb];
  if (b) {
    b.z = LOOSE; b.h = 0; b.vx = b.vy = 0; b.tm = -1; b.th = 0; b.lv = 0;
    b.x = clamp(d.x, BR, FW - BR); b.y = clamp(d.y, BR, FH - BR);
  }
  d.hb = -1;
  d.ht = 0;
}

function leave(w, id) {
  const d = w.p[id];
  if (!d) return;
  if (d.hb >= 0) drop(w, d);
  for (const b of w.b) if (b.th === id) b.th = 0;
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.06;         // how often it stands a moment rather than decide
const BOT_CATCH = 0.4;         // how often it tries a catch rather than run
const BOT_MISS = 3000;         // how far off its throws may land, in units
const BOT_SEE = 0.7;           // how often it sees a throw coming at all
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a round
// is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// The live ball of a rival that will pass nearest to this player soon, as
// [ball, substeps until it is nearest, how near it passes], or null.
function threatTo(w, d) {
  let best = null;
  for (const b of w.b) {
    if (b.z !== LIVE || b.tm === d.tm) continue;
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 === 0) continue;
    const t = Math.trunc(((d.x - b.x) * b.vx + (d.y - b.y) * b.vy) / v2);
    if (t < 0 || t > 16 * SUB || t > b.lv) continue;
    const cx = b.x + b.vx * t - d.x, cy = b.y + b.vy * t - d.y;
    const miss = isqrt(cx * cx + cy * cy);
    if (miss > R + BR + 900) continue;
    if (!best || t < best[1]) best = [b, t, miss, cx, cy];
  }
  return best;
}

function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.bw > 0) { d.bw -= 1; d.mx = d.my = 0; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 4 + Math.floor(draw01(w) * 8); d.mx = d.my = 0; return; }
  const [lo, hi] = zoneOf(d);
  let tx = d.x, ty = d.y;
  // Something flying at it: open the arms when it is about to arrive, or run
  // across its path.
  const threat = d.o || draw01(w) >= BOT_SEE ? null : threatTo(w, d);
  if (threat) {
    const [b, t, , cx, cy] = threat;
    if (d.hb < 0 && d.cc === 0 && t <= 4 * SUB && draw01(w) < BOT_CATCH) { d.hq = 1; d.mx = d.my = 0; return; }
    let px = -b.vy, py = b.vx;
    if (px * -cx + py * -cy < 0) { px = -px; py = -py; }
    const [ux, uy] = toLength(px, py, 1000);
    d.mx = ux; d.my = uy;
    return;
  }
  if (d.hb >= 0) {
    // A ball in hand: walk up toward the line, and throw at the nearest rival
    // on court once it has held the ball as long as it meant to.
    let near = null, nd = 0;
    for (const id of onCourt(w, 1 - d.tm)) {
      const o = w.p[id], dd = (o.x - d.x) * (o.x - d.x) + (o.y - d.y) * (o.y - d.y);
      if (!near || dd < nd) { near = o; nd = dd; }
    }
    if (!d.o) tx = MID - forward(d.tm) * 7000;
    if (near) {
      ty = near.y + Math.trunc((draw01(w) - 0.5) * 8000);
      if (d.ht >= d.bt || d.ht >= HOLD_WARN) {
        const far = isqrt(nd);
        const lead = Math.trunc(far / speedOf(w, d.tm));
        const ex = near.x + near.vx * lead + Math.trunc((draw01(w) - 0.5) * 2 * BOT_MISS);
        const ey = near.y + near.vy * lead + Math.trunc((draw01(w) - 0.5) * 2 * BOT_MISS);
        const [ax, ay] = toLength(ex - d.x, ey - d.y, 1000);
        if (ax || ay) { d.ax = ax; d.ay = ay; d.hq = 1; }
      }
    }
  } else {
    // No ball: go for the nearest loose one it can reach.
    let near = null, nd = 0;
    for (const b of w.b) {
      if (b.z !== LOOSE || b.x < lo - REACH || b.x > hi + REACH) continue;
      const dd = (b.x - d.x) * (b.x - d.x) + (b.y - d.y) * (b.y - d.y);
      if (!near || dd < nd) { near = b; nd = dd; }
    }
    if (near) { tx = near.x; ty = near.y; d.bt = Math.floor(HZ / 3 + draw01(w) * 1.5 * HZ); }
    else { tx = Math.trunc((lo + hi) / 2) + Math.trunc((draw01(w) - 0.5) * 6000); ty = FH / 2 + Math.trunc((draw01(w) - 0.5) * 20000); }
  }
  tx = clamp(tx, lo, hi);
  ty = clamp(ty, R, FH - R);
  const gx = tx - d.x, gy = ty - d.y;
  if (Math.abs(gx) + Math.abs(gy) < 600) { d.mx = d.my = 0; return; }
  const [ux, uy] = toLength(gx, gy, 1000);
  d.mx = ux; d.my = uy;
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  w.ck = w.fv = w.ot = 0;
  w.sc = [0, 0];
  const ids = humans(w).sort((a, b) => w.p[a].s - w.p[b].s);
  ids.forEach((id, i) => { w.p[id].tm = i % 2; });
  if (w.p[BOT_ID]) w.p[BOT_ID].tm = ids.length % 2;
  placeAll(w);
  resetBalls(w);
}

// A round: the seats closed up in order and shuffled into two teams, everybody
// on their back line, and the balls on the middle line.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.ck = w.fv = w.ot = 0;
  w.sc = [0, 0];
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  for (let i = ids.length - 1; i > 0; i--) {
    const k = Math.floor(draw01(w) * (i + 1));
    const t = ids[i]; ids[i] = ids[k]; ids[k] = t;
  }
  ids.forEach((id, i) => { const d = w.p[id]; d.tm = i % 2; d.k = 0; d.cg = 0; });
  balance(w);
  placeAll(w);
  resetBalls(w);
  fx(w, 'round', 0, 0, 0);
}

// The whistle: the team that took the round, and a round won for everybody
// on it.
function finish(w, win) {
  const ids = bySeat(w);
  for (const id of ids) if (w.p[id].tm === win) w.p[id].wn += 1;
  const res = ids.map((id) => [id, w.p[id].tm, w.p[id].k, w.p[id].cg, w.p[id].wn]);
  res.sort((a, b) => (a[1] === win ? 0 : 1) - (b[1] === win ? 0 : 1) || b[2] - a[2] || b[3] - a[3] || a[0] - b[0]);
  w.res = res;
  w.win = win;
  w.ph = END;
  w.pt = END_STEPS;
  for (const id of ids) if (w.p[id].hb >= 0) drop(w, w.p[id]);
  fx(w, 'end', 0, 0, 0, win);
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
  } else if (w.ph === COUNT) {
    w.pt -= 1;
    if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, 0, w.pt / HZ);
    if (w.pt <= 0) { w.ph = PLAY; w.pt = 0; fx(w, 'go', 0, 0, 0); }
  } else if (w.ph === END) {
    if (--w.pt <= 0) begin(w);
  }
  // Nobody moves while the result of a round is up.
  if (w.ph === END) {
    for (const id of playersIn(w)) { const d = w.p[id]; d.vx = d.vy = d.hq = d.cs = 0; }
    rollBalls(w);
    return;
  }
  court(w);
  if (w.ph === PLAY) clock(w);
}

// The round's clock: the fever half a minute from the end, and at the end the
// team with more points takes it — or, level, the next point does.
function clock(w) {
  w.ck += 1;
  if (!w.fv && w.ck >= FEVER_AT) {
    w.fv = 1;
    if (w.b.length < MAX_B) w.b.push(looseBall(MID, FH / 2));
    fx(w, 'fever', MID, FH / 2, 0);
  }
  if (w.ck === ROUND_STEPS) {
    if (w.sc[0] !== w.sc[1]) { finish(w, w.sc[0] > w.sc[1] ? 0 : 1); return; }
    w.ot = 1;
    fx(w, 'sudden', 0, 0, 0);
  }
  if (w.ck >= ROUND_STEPS + OT_STEPS) finish(w, -1);
}

function court(w) {
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.cs > 0) d.cs -= 1;
    if (d.cc > 0) d.cc -= 1;
    if (d.tc > 0) d.tc -= 1;
    if (d.hq) {
      d.hq = 0;
      if (d.hb >= 0) throwBall(w, d, id);
      else if (d.cc === 0 && !d.o && w.ph !== COUNT) {
        const last = onCourt(w, d.tm).length === 1 && w.ph === PLAY;
        d.cs = last ? LAST_CATCH : CATCH_STEPS;
        d.cc = CATCH_CD;
        fx(w, 'stance', d.x, d.y, 0, id);
      }
    }
    if (d.hb >= 0) {
      d.ht += 1;
      if (d.ht >= HOLD_MAX) slip(w, d, id);
    }
  }
  for (let s = 0; s < SUB; s++) {
    for (const id of ids) move(w.p[id]);
    crowd(w, ids);
    flyBalls(w, ids);
    if (w.ph === END) return;
  }
  rollBalls(w);
  if (w.ph !== COUNT) pickUp(w, ids);
  // A team is never left with nobody on court: there would be nobody for the
  // other team to throw at, and the round would stand still. The first of it
  // to go out walks straight back in.
  for (const t of [0, 1]) {
    if (onCourt(w, t).length) continue;
    const first = firstOut(w, t);
    if (first !== -1) back(w, w.p[first], first);
  }
}

function firstOut(w, t) {
  let first = -1;
  for (const k of teamOf(w, t)) {
    const o = w.p[k];
    if (o.o && (first === -1 || o.oa < w.p[first].oa)) first = k;
  }
  return first;
}

// A ball sent rolling over the middle line, to stop on the far side of it.
// Friction takes away an eighth a step, so a ball sent at v rolls about
// SUB * 7 * v before it stops.
function rollOver(b) {
  b.vx = clamp(Math.trunc((MID + (b.x < MID ? 6000 : -6000) - b.x) / (SUB * 7)), -VLIM, VLIM);
  b.vy = 0;
}

// How fast a throw of this team flies: faster in the fever, and faster for a
// team a player short, so that two against three is still a match.
function speedOf(w, t) {
  const short = teamOf(w, t).length < teamOf(w, 1 - t).length;
  return (w.fv ? FEVER_V : THROW_V) + (short ? SHORT_V : 0);
}

// A throw: the ball leaves the hand the way the hand aims, or the way the
// player faces when it aims nowhere, at the speed every throw of its team
// flies.
function throwBall(w, d, id) {
  const b = w.b[d.hb];
  const v = speedOf(w, d.tm);
  let [vx, vy] = toLength(d.ax, d.ay, v);
  if (!vx && !vy) [vx, vy] = toLength(d.fx, d.fy, v);
  if (!vx && !vy) vx = forward(d.tm) * v;
  const [ox, oy] = toLength(vx, vy, R - 200);
  b.x = clamp(d.x + ox, BR, FW - BR);
  b.y = clamp(d.y + oy, BR, FH - BR);
  b.vx = vx; b.vy = vy;
  b.z = LIVE; b.h = 0; b.tm = d.tm; b.th = id; b.lv = LIVE_SUBS;
  d.hb = -1;
  d.ht = 0;
  d.tc = THROW_CD;
  d.cs = 0;
  fx(w, 'throw', b.x, b.y, 0, id);
}

// A ball held too long slips out of the hands and rolls over the middle line,
// a gift rather than a throw.
function slip(w, d, id) {
  const b = w.b[d.hb];
  drop(w, d);
  rollOver(b);
  d.tc = THROW_CD;
  fx(w, 'slip', b.x, b.y, 0, id);
}

// A player runs toward the speed its hand asks for, inside its own zone, and
// slower with a ball in hand or the arms open.
function move(d) {
  let [tx, ty] = [d.mx, d.my];
  const l = isqrt(tx * tx + ty * ty);
  if (l > 1000) [tx, ty] = toLength(tx, ty, 1000);
  const top = d.cs > 0 ? STANCE_SPD : d.hb >= 0 ? HOLD_SPD : SPD;
  tx = Math.trunc((tx * top) / 1000);
  ty = Math.trunc((ty * top) / 1000);
  d.vx += Math.trunc((tx - d.vx) / 4);
  d.vy += Math.trunc((ty - d.vy) / 4);
  if (Math.abs(tx - d.vx) <= 3) d.vx = tx;
  if (Math.abs(ty - d.vy) <= 3) d.vy = ty;
  if (l > 200) { const [fx_, fy_] = toLength(d.mx, d.my, 1000); d.fx = fx_; d.fy = fy_; }
  d.x += d.vx;
  d.y += d.vy;
  const [lo, hi] = zoneOf(d);
  if (d.x < lo) { d.x = lo; if (d.vx < 0) d.vx = 0; }
  if (d.x > hi) { d.x = hi; if (d.vx > 0) d.vx = 0; }
  if (d.y < R) { d.y = R; if (d.vy < 0) d.vy = 0; }
  if (d.y > FH - R) { d.y = FH - R; if (d.vy > 0) d.vy = 0; }
}

// Two players in one zone never stand in each other: they are eased apart,
// half each.
function crowd(w, ids) {
  for (let a = 0; a < ids.length; a++) {
    const p = w.p[ids[a]];
    for (let b = a + 1; b < ids.length; b++) {
      const o = w.p[ids[b]];
      if (o.tm !== p.tm || o.o !== p.o) continue;
      const reach = R * 2;
      let dx = o.x - p.x, dy = o.y - p.y;
      if (dx * dx + dy * dy >= reach * reach) continue;
      let far = isqrt(dx * dx + dy * dy);
      if (far === 0) { dx = ids[a] < ids[b] ? 1 : -1; dy = 0; far = 1; }
      const push = Math.trunc((reach - far) / 2) + 1;
      p.x -= Math.trunc((dx * push) / far); p.y -= Math.trunc((dy * push) / far);
      o.x += Math.trunc((dx * push) / far); o.y += Math.trunc((dy * push) / far);
      for (const d of [p, o]) {
        const [lo, hi] = zoneOf(d);
        d.x = clamp(d.x, lo, hi);
        d.y = clamp(d.y, R, FH - R);
      }
    }
  }
}

// A held ball goes where its holder goes; a live one flies on until it meets
// a wall, a rival on court or the end of its flight.
function flyBalls(w, ids) {
  for (let i = 0; i < w.b.length; i++) {
    const b = w.b[i];
    if (b.z === HELD) {
      const d = w.p[b.h];
      if (d) { b.x = clamp(d.x, BR, FW - BR); b.y = clamp(d.y, BR, FH - BR); }
      continue;
    }
    if (b.z !== LIVE) continue;
    b.x += b.vx;
    b.y += b.vy;
    walls(w, b);
    if (b.z !== LIVE) continue;
    for (const id of ids) {
      const d = w.p[id];
      if (d.o || d.tm === b.tm) continue;
      const dx = d.x - b.x, dy = d.y - b.y;
      if (dx * dx + dy * dy >= (R + BR) * (R + BR)) continue;
      if (d.cs > 0 && d.hb < 0) caught(w, b, i, d, id);
      else hit(w, b, d, id);
      if (w.ph === END) return;
      break;
    }
    if (b.z === LIVE && --b.lv <= 0) {
      b.z = LOOSE;
      b.vx = Math.trunc(b.vx / 3); b.vy = Math.trunc(b.vy / 3);
      fx(w, 'land', b.x, b.y, 0);
    }
  }
}

// The walls round the whole court: a ball bounces off them, and a live one
// that meets one is dead from then on.
function walls(w, b) {
  let bang = false;
  if (b.x < BR) { b.x = BR; b.vx = Math.abs(b.vx); bang = true; }
  if (b.x > FW - BR) { b.x = FW - BR; b.vx = -Math.abs(b.vx); bang = true; }
  if (b.y < BR) { b.y = BR; b.vy = Math.abs(b.vy); bang = true; }
  if (b.y > FH - BR) { b.y = FH - BR; b.vy = -Math.abs(b.vy); bang = true; }
  if (bang && b.z === LIVE) {
    b.z = LOOSE;
    b.vx = Math.trunc(b.vx / 3); b.vy = Math.trunc(b.vy / 3);
    fx(w, 'wall', b.x, b.y, 0);
  }
}

// Loose balls roll to a stop. One left lying still too long rolls over the
// middle line on its own, so a team that sits on the balls cannot stop the
// game: a ball nobody wants is the other team's.
function rollBalls(w) {
  for (const b of w.b) {
    if (b.z !== LOOSE) { b.st = 0; continue; }
    if (!b.vx && !b.vy) {
      if (++b.st < STALE) continue;
      b.st = 0;
      rollOver(b);
      fx(w, 'stale', b.x, b.y, 0);
    }
    for (let s = 0; s < SUB; s++) { b.x += b.vx; b.y += b.vy; walls(w, b); }
    b.vx = Math.trunc((b.vx * 7) / 8);
    b.vy = Math.trunc((b.vy * 7) / 8);
    if (Math.abs(b.vx) < 4) b.vx = 0;
    if (Math.abs(b.vy) < 4) b.vy = 0;
  }
}

// Empty hands take a loose ball within reach, the earliest seat first, unless
// they have just thrown or have their arms open for a catch.
function pickUp(w, ids) {
  for (let i = 0; i < w.b.length; i++) {
    const b = w.b[i];
    if (b.z !== LOOSE) continue;
    for (const id of ids) {
      const d = w.p[id];
      if (d.hb >= 0 || d.tc > 0 || d.cs > 0) continue;
      const dx = d.x - b.x, dy = d.y - b.y;
      if (dx * dx + dy * dy >= REACH * REACH) continue;
      b.z = HELD; b.h = id; b.vx = b.vy = 0; b.tm = -1; b.th = 0; b.lv = 0;
      d.hb = i;
      d.ht = 0;
      fx(w, 'pick', b.x, b.y, 0, id);
      break;
    }
  }
}

// A point for a team; in sudden death, the round.
function score(w, t) {
  w.sc[t] = Math.min(9999, w.sc[t] + 1);
  if (w.ph === PLAY && w.ot) finish(w, t);
}

// A rival hit on court is out, off to the jail behind the other team, and a
// point for the thrower's; the ball drops dead off them, and a thrower who was
// in jail has earned the way back.
function hit(w, b, d, id) {
  const by = w.p[b.th], t = b.tm;
  b.z = LOOSE;
  b.vx = -Math.trunc(b.vx / 4); b.vy = -Math.trunc(b.vy / 4);
  fx(w, 'hit', d.x, d.y, 0, id, b.th);
  b.tm = -1;
  if (by) {
    by.k += 1;
    if (by.o) back(w, by, b.th);
  }
  b.th = 0;
  out(w, d, id);
  score(w, t);
}

// A catch: a point, the ball is the catcher's, the thrower is out if they
// were on court, and the first of the catcher's team to go out comes back in.
function caught(w, b, i, d, id) {
  const th = b.th, by = w.p[th];
  b.z = HELD; b.h = id; b.vx = b.vy = 0; b.tm = -1; b.th = 0; b.lv = 0;
  d.hb = i;
  d.ht = 0;
  d.cs = 0;
  d.cg += 1;
  d.k += 1;
  fx(w, 'catch', d.x, d.y, 0, id, th);
  const first = firstOut(w, d.tm);
  if (first !== -1) back(w, w.p[first], first);
  if (by && !by.o) out(w, by, th);
  score(w, d.tm);
}

function out(w, d, id) {
  if (d.hb >= 0) drop(w, d);
  d.o = 1;
  d.oa = w.n;
  d.cs = d.vx = d.vy = 0;
  d.x = jailX(d.tm);
  d.y = clamp(d.y, R, FH - R);
  fx(w, 'out', d.x, d.y, 0, id);
}

function back(w, d, id) {
  d.o = 0;
  d.cs = d.vx = d.vy = 0;
  d.x = backX(d.tm);
  d.y = clamp(d.y, R, FH - R);
  fx(w, 'back', d.x, d.y, 0, id);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const idOr0 = (v) => Number.isInteger(v) && (v === 0 || isId(String(v)));

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, END_STEPS + COUNT_STEPS)) return null;
  if (!Array.isArray(raw.sc) || raw.sc.length !== 2 || !int(raw.sc[0], 0, 9999) || !int(raw.sc[1], 0, 9999)) return null;
  if (!int(raw.ck, 0, ROUND_STEPS + OT_STEPS) || !int(raw.fv, 0, 1) || !int(raw.ot, 0, 1)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  if (!Array.isArray(raw.b) || raw.b.length > MAX_B) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const b = [];
  for (const v of raw.b) {
    if (!v || typeof v !== 'object') return null;
    if (!int(v.x, 0, FW) || !int(v.y, 0, FH) || !int(v.vx, -VLIM, VLIM) || !int(v.vy, -VLIM, VLIM)) return null;
    if (!int(v.z, LOOSE, HELD) || !idOr0(v.h) || !int(v.tm, -1, 1) || !idOr0(v.th) || !int(v.lv, 0, LIVE_SUBS)) return null;
    if (!int(v.st, 0, STALE)) return null;
    if ((v.z === HELD) !== (v.h !== 0) || (v.h !== 0 && !raw.p[String(v.h)])) return null;
    b.push(ballOf(v));
  }
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.tm, 0, 1) || !int(d.o, 0, 1) || !int(d.oa, -BIG, BIG)) return null;
    if (!int(d.x, 0, FW) || !int(d.y, 0, FH) || !int(d.vx, -VLIM, VLIM) || !int(d.vy, -VLIM, VLIM)) return null;
    if (inputOf([d.mx, d.my, d.ax, d.ay, d.q]) === null || !int(d.fx, -1000, 1000) || !int(d.fy, -1000, 1000)) return null;
    if (!int(d.hq, 0, 1) || !int(d.hb, -1, MAX_B - 1) || !int(d.ht, 0, HOLD_MAX)) return null;
    if (d.hb >= 0 && (!b[d.hb] || b[d.hb].h !== Number(id))) return null;
    if (!int(d.cs, 0, LAST_CATCH) || !int(d.cc, 0, CATCH_CD) || !int(d.tc, 0, THROW_CD)) return null;
    if (!int(d.k, 0, 99999) || !int(d.cg, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bw, 0, 99) || !int(d.bt, 0, 9999) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  for (const v of b) if (v.z === HELD && p[String(v.h)].hb < 0) return null;
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 5 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -1, 1)) return null;
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, sc: raw.sc.slice(), ck: raw.ck, fv: raw.fv, ot: raw.ot, p, b, res, win: raw.win };
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
// One palette: a school gym after hours. A deep blue rubber floor with white
// lines, the two jails darker and striped in the colour of whoever is kept in
// them, red rubber balls, and every player a bright colour of their own ringed
// in their team's: tangerine on the left, sky on the right.
const INK = {
  page: '#121731', floor: '#26386b', floorLit: '#2e437d', jail: '#1a2449', line: '#e9eeff', wall: '#0d1126',
  ball: '#ff4d5e', ballLit: '#ff8a94', ballDark: '#b8263a',
  text: '#ffffff', muted: '#dfe6ff', dim: '#a3aed6', gold: '#ffd166', danger: '#ff5a6e',
  panel: 'rgba(16,22,48,0.93)', outline: '#0f1430',
};
const TEAM = ['#ff9a3d', '#3dc8ff'];
const TEAMN = ['tangerine', 'sky'];
const SEAT = ['#ff4f7b', '#3fd27f', '#ffd23f', '#b06bff', '#ff7a2e', '#2ee6d6', '#f2f2f2', '#ff6ad5'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #44528f;' +
  `background:#1f2a55;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
// NOTE_ROOM under the court keeps the practice note off the bottom of the
// court, where players run and balls roll.
const NOTE_ROOM = 60;
let VW = 640, VH = 400, sc = 0.01, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1, courtBot = 340;
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

function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  sc = Math.max(0.002, Math.min((VW - 16) / FW, ah / FH));
  ox = (VW - FW * sc) / 2;
  oy = TOP + (ah - FH * sc) / 2;
  courtBot = oy + FH * sc;
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
  ctx.strokeStyle = 'rgba(12,16,40,0.8)';
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
  throw(mine) { if (ready('throw', 50)) { puff(0.16, mine ? 0.09 : 0.05, 1800, 0, 0.7); tone(mine ? 520 : 420, 0.1, 'triangle', 0.04, 0.6); } },
  hit(mine) {
    if (!ready('hit', 60)) return;
    puff(0.22, 0.14, 420, 0, 0.6);
    tone(mine ? 160 : 220, 0.3, 'sine', 0.12, 0.45);
    if (mine) tone(330, 0.4, 'sawtooth', 0.04, 0.5, 0.08);
  },
  catch() { if (ready('catch', 120)) { puff(0.08, 0.1, 900, 0, 1); [659, 880, 1175].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, 0.03 + i * 0.05)); } },
  back() { if (ready('back', 150)) [392, 523, 659].forEach((f, i) => tone(f, 0.1, 'sine', 0.07, 0, i * 0.05)); },
  stance() { if (ready('stance', 80)) tone(300, 0.1, 'sine', 0.05, 1.8); },
  pick() { if (ready('pick', 60)) tone(700, 0.06, 'triangle', 0.05, 1.3); },
  slip() { if (ready('slip', 200)) tone(500, 0.35, 'triangle', 0.06, 0.4); },
  thud() { if (ready('thud', 80)) { puff(0.08, 0.05, 500, 0, 1); tone(110, 0.08, 'sine', 0.05, 0.7); } },
  fever() { if (ready('fever', 400)) { puff(0.5, 0.08, 600, 0, 0.5); [440, 554, 659, 880].forEach((f, i) => tone(f, 0.1, 'sawtooth', 0.03, 1, i * 0.05)); } },
  whistle() { if (ready('whistle', 300)) { tone(2100, 0.09, 'square', 0.03); tone(2300, 0.22, 'square', 0.03, 1, 0.1); } },
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
const looks = new Map();      // id -> { x, y, sq, flash, seen }
const trails = new Map();     // ball index -> recent [x, y] while it flies
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');

function lookOf(id, now) {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { x: null, y: null, sq: 0, flash: 0, seen: now }));
  return look;
}
function squash(id, k) { const look = looks.get(id); if (look) look.sq = Math.max(look.sq, k); }
function flash(id, k) { const look = looks.get(id); if (look) look.flash = Math.max(look.flash, k); }

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  if (e.kind === 'throw') {
    spray(e.x, e.y, 5, '#ffffff', 5000, 220);
    squash(e.a, 0.5);
    sound.throw(e.a === me);
  } else if (e.kind === 'hit') {
    const colour = colourOf(t, e.a);
    spray(e.x, e.y, 22, colour, 14000, 420);
    spray(e.x, e.y, 10, '#ffffff', 9000, 260);
    ring(e.x, e.y, INK.danger, 5200);
    pop(e.x, e.y - R * 1.6, e.a === me ? 'you are out!' : 'out!', INK.danger, e.a === me ? 20 : 17);
    squash(e.a, 1);
    flash(e.a, 1);
    shake = Math.max(shake, e.a === me ? 11 : e.b === me ? 6 : 4);
    sound.hit(e.a === me);
  } else if (e.kind === 'catch') {
    spray(e.x, e.y, 18, INK.gold, 11000, 320);
    ring(e.x, e.y, INK.gold, 6000);
    pop(e.x, e.y - R * 1.7, 'caught!', INK.gold, 20);
    squash(e.a, 0.8);
    flash(e.a, 0.8);
    shake = Math.max(shake, e.a === me || e.b === me ? 8 : 4);
    sound.catch();
  } else if (e.kind === 'back') {
    const d = t.p[e.a];
    ring(e.x, e.y, d ? TEAM[d.tm] : '#ffffff', 4500);
    spray(e.x, e.y, 12, d ? TEAM[d.tm] : '#ffffff', 8000, 260);
    pop(e.x, e.y - R * 1.6, e.a === me ? 'you are back!' : 'back in!', d ? lighter(TEAM[d.tm], 0.3) : '#ffffff', 16);
    sound.back();
  } else if (e.kind === 'out') {
    ring(e.x, e.y, '#ffffff', 3000);
  } else if (e.kind === 'stance') {
    ring(e.x, e.y, '#ffffff', R * 2.4);
    if (e.a === me) sound.stance();
  } else if (e.kind === 'pick') {
    spray(e.x, e.y, 4, INK.ballLit, 3000, 180);
    if (e.a === me) sound.pick();
  } else if (e.kind === 'slip') {
    pop(e.x, e.y - R * 1.6, 'too slow!', INK.danger, 15);
    if (e.a === me) sound.slip();
  } else if (e.kind === 'stale') {
    ring(e.x, e.y, '#ffffff', 2600);
    sound.thud();
  } else if (e.kind === 'wall' || e.kind === 'land') {
    spray(e.x, e.y, 5, '#ffffff', 3500, 160);
    sound.thud();
  } else if (e.kind === 'fever') {
    pop(MID, FH / 2 - 3000, 'fever! balls fly faster', INK.gold, 19);
    ring(MID, FH / 2, INK.gold, 12000);
    shake = Math.max(shake, 5);
    sound.fever();
  } else if (e.kind === 'sudden') {
    pop(MID, FH / 2 - 3000, 'level! next point wins', INK.danger, 20);
    sound.whistle();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.whistle();
    sound.end(md ? e.a === md.tm : false);
  }
}

// The floor: both halves faintly in their team's colour, the two jails
// striped in the colour of whoever stands in them, and the lines.
function drawCourt(t, now) {
  flat();
  const g0 = ctx.createLinearGradient(0, 0, 0, VH);
  g0.addColorStop(0, '#182046');
  g0.addColorStop(1, INK.page);
  ctx.fillStyle = g0;
  ctx.fillRect(0, 0, VW, VH);
  const x0 = SX(0), y0 = SY(0), w = FW * sc, h = FH * sc;
  ctx.fillStyle = 'rgba(4,6,18,0.5)';
  roundRect(x0 - 3, y0 + 4, w + 8, h + 6, 12);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, w, h, 10);
  ctx.clip();
  const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
  g.addColorStop(0, INK.floorLit);
  g.addColorStop(1, INK.floor);
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, h);
  // A board pattern in the floor, faint, so the eye reads speed off it.
  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  for (let i = 0; i < 18; i += 2) ctx.fillRect(x0, y0 + (h * i) / 18, w, h / 18);
  for (const s of [0, 1]) {
    const a = s ? SX(MID) : SX(JW), b = s ? SX(FW - JW) : SX(MID);
    ctx.fillStyle = alpha(TEAM[s], 0.09);
    ctx.fillRect(a, y0, b - a, h);
  }
  // The jails: the left one holds sky's players who are out, the right one
  // tangerine's.
  for (const s of [0, 1]) {
    const a = s ? x0 : SX(FW - JW), jw = JW * sc;
    ctx.fillStyle = INK.jail;
    ctx.fillRect(a, y0, jw, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(a, y0, jw, h);
    ctx.clip();
    ctx.strokeStyle = alpha(TEAM[s ? 1 : 0], 0.22);
    ctx.lineWidth = Math.max(2, 500 * sc);
    ctx.beginPath();
    for (let k = 0; k < jw + h; k += Math.max(8, 2400 * sc)) { ctx.moveTo(a + k, y0); ctx.lineTo(a + k - h, y0 + h); }
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 0.55;
    fitText('out', a + jw / 2, y0 + 16, 11, lighter(TEAM[s ? 1 : 0], 0.2), jw - 4);
    ctx.globalAlpha = 1;
  }
  // The lines: the back lines, the middle line and its circle.
  ctx.strokeStyle = alpha(INK.line, 0.55);
  ctx.lineWidth = Math.max(1.5, 220 * sc);
  ctx.setLineDash([Math.max(4, 900 * sc), Math.max(3, 600 * sc)]);
  ctx.beginPath();
  ctx.moveTo(SX(JW), y0); ctx.lineTo(SX(JW), y0 + h);
  ctx.moveTo(SX(FW - JW), y0); ctx.lineTo(SX(FW - JW), y0 + h);
  ctx.stroke();
  ctx.setLineDash([]);
  const hot = t.fv ? 0.6 + 0.4 * Math.sin(now / 140) : 0;
  ctx.strokeStyle = t.fv ? `rgba(255,${Math.round(150 - 60 * hot)},90,0.95)` : alpha(INK.line, 0.85);
  ctx.lineWidth = Math.max(2, 360 * sc);
  ctx.beginPath();
  ctx.moveTo(SX(MID), y0); ctx.lineTo(SX(MID), y0 + h);
  ctx.stroke();
  ctx.lineWidth = Math.max(1.5, 220 * sc);
  disc(SX(MID), SY(FH / 2), 5200 * sc);
  ctx.stroke();
  // Each team's points, big and soft on its own half of the floor.
  const big = Math.max(24, Math.min(80, 11000 * sc));
  for (const s of [0, 1]) {
    ctx.globalAlpha = 0.22;
    outlined(String(t.sc[s]), SX(s ? (MID + FW - JW) / 2 : (JW + MID) / 2), SY(FH / 2) + big * 0.36, big, TEAM[s], 1);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  roundRect(x0, y0, w, h, 10);
  ctx.stroke();
}

// A red rubber ball with a seam and a shine, lifted off the floor by `lift`
// screen pixels over its shadow.
function drawBallAt(x, y, r, lift, glow) {
  ctx.fillStyle = 'rgba(4,6,20,0.35)';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.2, y + r * 0.35, r * (1 - Math.min(0.4, lift / (r * 8))), r * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  const yy = y - lift;
  if (glow) {
    ctx.fillStyle = alpha(glow, 0.35);
    disc(x, yy, r * 1.7);
    ctx.fill();
  }
  const g = ctx.createRadialGradient(x - r * 0.35, yy - r * 0.35, r * 0.1, x, yy, r);
  g.addColorStop(0, INK.ballLit);
  g.addColorStop(0.6, INK.ball);
  g.addColorStop(1, INK.ballDark);
  ctx.fillStyle = g;
  disc(x, yy, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(90,10,25,0.6)';
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.beginPath();
  ctx.arc(x - r * 1.1, yy, r * 1.15, -0.75, 0.75);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.35, yy - r * 0.42, r * 0.25, r * 0.14, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

// A loose ball on the floor, or a live one in flight: lifted on an arc over
// its shadow, glowing in its thrower's colour, with a streak behind it.
function drawBalls(b, now) {
  flat();
  const t = b.to;
  for (let i = 0; i < t.b.length; i++) {
    const z = t.b[i];
    if (z.z === HELD) { trails.delete(i); continue; }
    const a = b.from.b[i];
    let x = z.x, y = z.y;
    if (a && Math.abs(a.x - z.x) + Math.abs(a.y - z.y) < 12000) { x = lerp(a.x, z.x, b.k); y = lerp(a.y, z.y, b.k); }
    const r = BR * sc;
    let lift = 0, glow = null;
    if (z.z === LIVE) {
      const f = 1 - z.lv / LIVE_SUBS;
      lift = Math.sin(Math.PI * Math.min(1, f * 1.1 + 0.05)) * 1300 * sc;
      glow = TEAM[z.tm] || null;
      let tr = trails.get(i);
      if (!tr) trails.set(i, (tr = []));
      tr.push([x, y, lift / sc]);
      if (tr.length > 9) tr.shift();
      ctx.lineCap = 'round';
      for (let k = 1; k < tr.length; k++) {
        ctx.strokeStyle = alpha(glow || '#ffffff', (k / tr.length) * 0.5);
        ctx.lineWidth = r * 1.4 * (k / tr.length);
        ctx.beginPath();
        ctx.moveTo(SX(tr[k - 1][0]), SY(tr[k - 1][1]) - tr[k - 1][2] * sc);
        ctx.lineTo(SX(tr[k][0]), SY(tr[k][1]) - tr[k][2] * sc);
        ctx.stroke();
      }
    } else trails.delete(i);
    drawBallAt(SX(x), SY(y), r, lift, glow);
  }
}

// A player seen from above: a round body in their own colour ringed in their
// team's, two eyes the way they face, a ball in the hand that holds one, arms
// thrown wide while they are open for a catch, and their name.
function drawPlayer(t, id, x, y, d, me, aim, now) {
  const look = lookOf(id, now);
  look.seen = now;
  look.sq *= Math.pow(0.86, frameDt * 60);
  look.flash *= Math.pow(0.9, frameDt * 60);
  const r = R * sc, sx = SX(x), sy = SY(y);
  const colour = SEAT[d.c], team = TEAM[d.tm];
  let fxv = d.fx / 1000, fyv = d.fy / 1000;
  if (aim) { fxv = aim[0]; fyv = aim[1]; }
  const fl = Math.hypot(fxv, fyv) || 1;
  fxv /= fl; fyv /= fl;
  ctx.fillStyle = 'rgba(4,6,20,0.35)';
  ctx.beginPath();
  ctx.ellipse(sx + r * 0.18, sy + r * 0.3, r * 1.05, r * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  const sq = look.sq, rr = r * (1 + sq * 0.15);
  // Arms: out wide for a catch, else a hand at the front.
  const ang = Math.atan2(fyv, fxv);
  if (d.cs > 0) {
    ctx.strokeStyle = alpha('#ffffff', 0.85);
    ctx.lineWidth = Math.max(1.5, r * 0.14);
    ctx.beginPath();
    ctx.arc(sx, sy, rr * 1.55, ang - 1.1, ang + 1.1);
    ctx.stroke();
    for (const s of [-1, 1]) {
      const a = ang + s * 1.1;
      ctx.fillStyle = lighter(colour, 0.2);
      disc(sx + Math.cos(a) * rr * 1.55, sy + Math.sin(a) * rr * 1.55, r * 0.3);
      ctx.fill();
    }
  }
  const g = ctx.createRadialGradient(sx - rr * 0.35, sy - rr * 0.4, rr * 0.1, sx, sy, rr);
  g.addColorStop(0, lighter(colour, 0.35));
  g.addColorStop(1, darker(colour, 0.15));
  ctx.fillStyle = g;
  disc(sx, sy, rr);
  ctx.fill();
  ctx.strokeStyle = team;
  ctx.lineWidth = Math.max(2, r * 0.2);
  if (d.o) ctx.setLineDash([Math.max(2, r * 0.35), Math.max(2, r * 0.25)]);
  disc(sx, sy, rr);
  ctx.stroke();
  ctx.setLineDash([]);
  if (look.flash > 0.05) {
    ctx.fillStyle = `rgba(255,255,255,${(look.flash * 0.8).toFixed(3)})`;
    disc(sx, sy, rr);
    ctx.fill();
  }
  // The eyes, the way they face.
  const px = -fyv, py = fxv;
  for (const s of [-1, 1]) {
    const ex = sx + fxv * rr * 0.42 + px * s * rr * 0.32, ey = sy + fyv * rr * 0.42 + py * s * rr * 0.32;
    ctx.fillStyle = '#ffffff';
    disc(ex, ey, Math.max(1.5, rr * 0.2));
    ctx.fill();
    ctx.fillStyle = '#10142c';
    disc(ex + fxv * rr * 0.07, ey + fyv * rr * 0.07, Math.max(1, rr * 0.1));
    ctx.fill();
  }
  // A ball in hand, held out front on the right, and a ring that runs out as
  // it is held too long.
  if (d.hb >= 0) {
    const hx = sx + fxv * rr * 1.05 + px * rr * 0.55, hy = sy + fyv * rr * 1.05 + py * rr * 0.55;
    drawBallAt(hx, hy, BR * sc, 0, null);
    if (d.ht >= HOLD_WARN - HZ) {
      const k = 1 - (d.ht - (HOLD_WARN - HZ)) / (HOLD_MAX - HOLD_WARN + HZ);
      ctx.strokeStyle = d.ht >= HOLD_WARN && Math.floor(now / 120) % 2 ? INK.danger : INK.gold;
      ctx.lineWidth = Math.max(2, r * 0.16);
      ctx.beginPath();
      ctx.arc(sx, sy, rr * 1.3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, k));
      ctx.stroke();
    }
  }
  // Under your own player: whether the arms are ready to open again.
  if (me && d.cc > 0 && d.hb < 0) {
    const bw = Math.max(18, r * 2.2), by = sy + rr + 5;
    ctx.fillStyle = 'rgba(10,14,36,0.5)';
    roundRect(sx - bw / 2, by, bw, 4, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    roundRect(sx - bw / 2, by, Math.max(4, bw * (1 - d.cc / CATCH_CD)), 4, 2);
    ctx.fill();
  }
  const fpx = Math.max(9, Math.min(13, 7 + r * 0.25));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(12,16,40,0.85)';
  ctx.font = font(fpx);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  const ly = sy - rr - 5;
  ctx.strokeText(label, sx, ly);
  ctx.fillStyle = me ? '#ffffff' : lighter(colour, 0.3);
  ctx.fillText(label, sx, ly);
  if (me) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(sx - 4, ly - fpx - 4);
    ctx.lineTo(sx + 4, ly - fpx - 4);
    ctx.lineTo(sx, ly - fpx + 1);
    ctx.closePath();
    ctx.fill();
  }
}

// Where a throw of yours would go: a dotted line from your hand, ending on the
// rival it picked out when it aims for you.
function drawAim(x, y, aim, target) {
  if (!aim) return;
  const sx = SX(x), sy = SY(y), len = Math.min(16000, LIVE_SUBS * THROW_V * 0.5) * sc;
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.moveTo(sx + aim[0] * R * sc * 1.4, sy + aim[1] * R * sc * 1.4);
  ctx.lineTo(sx + aim[0] * len, sy + aim[1] * len);
  ctx.stroke();
  ctx.setLineDash([]);
  if (target) {
    const tx = SX(target[0]), ty = SY(target[1]), rr = R * sc * 1.5;
    ctx.strokeStyle = 'rgba(255,90,110,0.85)';
    ctx.lineWidth = 2;
    disc(tx, ty, rr);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx - rr - 3, ty); ctx.lineTo(tx - rr + 4, ty);
    ctx.moveTo(tx + rr + 3, ty); ctx.lineTo(tx + rr - 4, ty);
    ctx.moveTo(tx, ty - rr - 3); ctx.lineTo(tx, ty - rr + 4);
    ctx.moveTo(tx, ty + rr + 3); ctx.lineTo(tx, ty + rr - 4);
    ctx.stroke();
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

const clockText = (steps) => {
  const s = Math.max(0, Math.ceil(steps / HZ));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, and the round's clock.
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    if (t.ot) { status = 'sudden death · next point wins · ' + clockText(ROUND_STEPS + OT_STEPS - t.ck); colour = Math.floor(now / 400) % 2 ? INK.danger : INK.text; }
    else if (t.fv) { status = 'fever · ' + clockText(ROUND_STEPS - t.ck) + ' left'; colour = Math.floor(now / 500) % 2 ? INK.gold : INK.text; }
    else status = 'round ' + t.rd + ' · ' + clockText(ROUND_STEPS - t.ck) + ' left';
  } else status = 'round ' + t.rd + ' · over';
  text('dodgeball', 12, 22, titlePx, '#ffc89a', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('dodgeball').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The players: each team's chips on its own half of the screen, those out
  // dimmed, and between them the score.
  const y = narrow ? 48 : 44;
  const counts = t.sc;
  ctx.font = font(15);
  const mid = counts[0] + ' : ' + counts[1];
  const midW = ctx.measureText(mid).width + 16;
  for (const s of [0, 1]) {
    const ids = teamOf(t, s);
    if (!ids.length) continue;
    const span = VW / 2 - 12 - midW / 2, gap = 4, cw = Math.min(118, (span - gap * (ids.length - 1)) / ids.length);
    let x = s ? VW - 8 - cw : 8;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.globalAlpha = d.o ? 0.5 : 1;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.3)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      ctx.strokeStyle = alpha(TEAM[s], mine ? 1 : 0.6);
      ctx.lineWidth = mine ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = c;
      disc(x + 11, y - 2, 5.5);
      ctx.fill();
      const wins = d.wn ? '★' + d.wn : '';
      ctx.font = font(11);
      const ww = wins ? ctx.measureText(wins).width + 6 : 0;
      if (wins && cw > 46) text(wins, x + cw - 8, y + 3, 11, INK.gold, 'right');
      if (cw > 36) fitText((mine ? 'you' : nickOf(id)) + (d.o ? ' · out' : ''), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 29 - ww, 'left');
      ctx.globalAlpha = 1;
      x += s ? -(cw + gap) : cw + gap;
    }
  }
  ctx.font = font(15);
  const cw0 = ctx.measureText(String(counts[0])).width, cwc = ctx.measureText(' : ').width;
  const x0 = VW / 2 - ctx.measureText(mid).width / 2;
  text(String(counts[0]), x0, y + 4, 15, TEAM[0], 'left');
  text(' : ', x0 + cw0, y + 4, 15, INK.dim, 'left');
  text(String(counts[1]), x0 + cw0 + cwc, y + 4, 15, TEAM[1], 'left');

  // The one line that says how to play.
  const how = coarse
    ? 'drag to run · tap to throw, or to catch · flick a second finger to aim'
    : 'WASD or arrows run · mouse aims · click or space throws, or catches with empty hands · M mutes';
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
  const cx = VW / 2, mid = (oy + courtBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const me = myId(), md = t.p[me];
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'catch a throw with empty hands and the thrower is out · hit from jail to come back';
    practiceNote(now, VW, head, tip, [[courtBot + 2, VH - BOT]], VH - BOT - 4);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    outlined(String(n), cx, mid + big * 0.6, big * 2.6 * s, '#ffffff', 6);
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 1.7, Math.min(VW - 32, 360), 30);
    const short = md && teamOf(t, md.tm).length < teamOf(t, 1 - md.tm).length;
    const line = !md ? 'every out is a point' : 'you play for ' + TEAMN[md.tm] + (short ? ' · a player short, you throw harder' : ' · every out is a point');
    fitText(line, cx, mid + big * 1.7 + 5, 14, md ? lighter(TEAM[md.tm], 0.2) : INK.text, Math.min(VW - 48, 340));
  } else if (t.ph === PLAY && t.ck < HZ) {
    const k = t.ck / HZ;
    ctx.globalAlpha = 1 - k;
    outlined('go!', cx, mid, big * (2 + k), '#ffffff', 6);
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 360), h = 100 + rows.length * 22;
    const pyc = Math.min(mid, VH / 2) + (1 - k) * 30;
    ctx.globalAlpha = k;
    panel(cx, pyc, w, h);
    const head = t.win < 0 ? 'a draw' : md && md.tm === t.win ? 'your team takes the round!' : TEAMN[t.win] + ' takes the round';
    const y0 = pyc - h / 2;
    fitText(head, cx, y0 + 30, 21, t.win < 0 ? INK.text : TEAM[t.win], w - 24);
    text(t.sc[0] + ' : ' + t.sc[1] + (t.win < 0 ? ' · nobody scored in sudden death' : ''), cx, y0 + 50, 13, INK.muted, 'center');
    text('outs', cx + w / 2 - 100, y0 + 68, 10, INK.dim, 'right');
    text('catches', cx + w / 2 - 54, y0 + 68, 10, INK.dim, 'right');
    text('rounds', cx + w / 2 - 14, y0 + 68, 10, INK.dim, 'right');
    rows.forEach(([id, tm, outs, catches, wins], i) => {
      const y = y0 + 88 + i * 22;
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 24, y - 4, 6);
      ctx.fill();
      ctx.strokeStyle = TEAM[tm];
      ctx.lineWidth = 2;
      ctx.stroke();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 38, y, 14, id === me ? INK.text : INK.muted, w - 180, 'left');
      text(String(outs), cx + w / 2 - 100, y, 14, INK.text, 'right');
      text(String(catches), cx + w / 2 - 54, y, 14, INK.text, 'right');
      text('★' + wins, cx + w / 2 - 14, y, 13, INK.gold, 'right');
    });
    fitText('teams are drawn again · next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a player is as drawn: between two steps — and when the table moves
// them a long way at once, off to jail or back in, eased across rather than
// put there.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || a.o !== z.o || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 9000) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}
function glide(look, x, y) {
  if (look.x === null || Math.abs(x - look.x) + Math.abs(y - look.y) < 3000) { look.x = x; look.y = y; return [x, y]; }
  const k = per60(0.16);
  look.x += (x - look.x) * k;
  look.y += (y - look.y) * k;
  return [look.x, look.y];
}

// Your own player is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a run a step away from
// where the guess had it. So the player drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a trip to
// jail — is eased across. Only the drawing is smoothed: the court, and every
// rule on it, are untouched.
const PULL = 0.45;
let shown = null;        // [x, y] in units: where your player is drawn
let myPos = null;        // the same, for the mouse to aim from

function settle(x, y) {
  if (!shown) return (shown = [x, y]);
  const far = Math.abs(x - shown[0]) + Math.abs(y - shown[1]);
  const k = per60(far > 6000 ? 0.16 : PULL);
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
    text('walking into the gym…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  drawCourt(t, now);
  drawBalls(b, now);
  for (const id of bySeat(t)) {
    if (id === me) continue;
    const p = bodyAt(b, id);
    if (!p) continue;
    const [x, y] = glide(lookOf(id, now), p[0], p[1]);
    drawPlayer(t, id, x, y, p[2], false, null, now);
  }
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own) {
    const p = bodyAt(own, me);
    const [x, y] = settle(p[0], p[1]);
    myPos = [x, y];
    // Where you run and whether your arms are open come from the guess; the
    // ball in your hands comes from the agreed table, like every other ball,
    // so it is never drawn twice or not at all while a trip is under way.
    const a = t.p[me];
    const d = a ? Object.assign({}, p[2], { hb: a.hb, ht: a.ht }) : p[2];
    const aim = d.hb >= 0 ? aimFor(t, x, y, d) : null;
    if (aim) drawAim(x, y, aim.v, aim.target);
    drawPlayer(t, me, x, y, d, true, aim ? aim.v : null, now);
  } else {
    myPos = shown = null;
  }
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way run, a thousand at full across and down, the way
// aimed, the same, and how many presses so far. A change of run goes out no
// oftener than STEER_EVERY, because a thumb changes it on every move the screen
// reports and the clock's ticks share the same seat's ceiling on messages; a
// press goes out at once, carrying the aim as it stands. The aim on its own
// is never sent: it matters only at the moment of a throw.
const STEER_EVERY = 80;
let mode = '';           // what runs: 'keys', 'mouse', 'touch', or nothing yet
let presses = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_X = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
const KEY_Y = { ArrowUp: -1, KeyW: -1, ArrowDown: 1, KeyS: 1 };
const KEY_ACT = new Set(['Space', 'Enter', 'KeyJ', 'KeyK', 'KeyX']);

// A thumb: a stick from wherever it lands, read as far as it is pushed; a tap
// throws or catches — a drag rather than a press, because iOS keeps a long
// press inside a frame for itself. A second finger presses as it lifts, and if
// it was flicked, the throw goes the way it was flicked. A mouse aims wherever
// it points, the left button presses, and the right one held runs toward it.
const DEAD = 8;
const REACHOUT = 46;
const FLICK = 24;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }
let thumb2 = null;       // { id, ox, oy, at }
let flickAim = null;     // a flicked direction waiting for its press
const mouse = { x: 0, y: 0, on: false, run: false };

function runNow() {
  if (mode === 'keys') {
    let x = 0, y = 0;
    for (const c of keys) { if (c in KEY_X) x += KEY_X[c]; if (c in KEY_Y) y += KEY_Y[c]; }
    x = clamp(x, -1, 1); y = clamp(y, -1, 1);
    const k = x && y ? 707 : 1000;
    return [x * k, y * k];
  }
  if (mode === 'touch') {
    if (!stick || Math.hypot(stick.dx, stick.dy) < DEAD) return [0, 0];
    const k = Math.min(1, Math.hypot(stick.dx, stick.dy) / REACHOUT);
    const a = Math.atan2(stick.dy, stick.dx);
    return [Math.round(Math.cos(a) * k * 20) * 50, Math.round(Math.sin(a) * k * 20) * 50];
  }
  if (mode === 'mouse' && mouse.run && mouse.on && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]), unit = R * sc;
    const l = Math.hypot(dx, dy);
    if (l < unit * 0.5) return [0, 0];
    const k = Math.min(1, l / (unit * 2.5));
    return [Math.round((dx / l) * k * 20) * 50, Math.round((dy / l) * k * 20) * 50];
  }
  return [0, 0];
}

// The way a throw from here would go: to the pointer while a mouse is in use,
// the way a second finger was flicked, or else at the nearest rival on court,
// led by where they are running.
function aimFor(t, x, y, d) {
  if (flickAim) return { v: flickAim, target: null };
  if (mouse.on) {
    const r = cv.getBoundingClientRect();
    const dx = (mouse.x - r.left - SX(x)) / sc, dy = (mouse.y - r.top - SY(y)) / sc;
    const l = Math.hypot(dx, dy);
    if (l > 1) return { v: [dx / l, dy / l], target: null };
  }
  let near = null, nd = 0;
  for (const id of onCourt(t, 1 - d.tm)) {
    const o = t.p[id], dd = Math.hypot(o.x - x, o.y - y);
    if (!near || dd < nd) { near = o; nd = dd; }
  }
  if (!near) return { v: [d.fx / 1000 || forward(d.tm), d.fy / 1000], target: null };
  const lead = nd / speedOf(t, d.tm);
  const tx = near.x + near.vx * lead * 0.8, ty = near.y + near.vy * lead * 0.8;
  const l = Math.hypot(tx - x, ty - y) || 1;
  return { v: [(tx - x) / l, (ty - y) / l], target: [near.x, near.y] };
}

function aimNow() {
  const b = world ? agreedAt(performance.now()) : null;
  const t = b ? b.to : null;
  const d = t && t.p[myId()];
  if (!d || !myPos) return [0, 0];
  const a = aimFor(t, myPos[0], myPos[1], d).v;
  return [clamp(Math.round(a[0] * 1000), -1000, 1000), clamp(Math.round(a[1] * 1000), -1000, 1000)];
}

function sayHand(now, force) {
  const run = runNow(), s = lastSaid;
  if (!force && s && run[0] === s[0] && run[1] === s[1]) return;
  if (!force && s && now - saidAt < STEER_EVERY) return;
  const aim = force ? aimNow() : s ? [s[2], s[3]] : [0, 0];
  const h = [run[0], run[1], aim[0], aim[1], presses];
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A press: heard at once, and taken a trip later on every copy alike — a throw
// if the table says a ball is in hand, arms open for a catch if not.
function press() {
  wake();
  if (!world) return;
  presses = (presses + 1) % 1000;
  sayHand(performance.now(), true);
  flickAim = null;
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (KEY_ACT.has(e.code)) {
    e.preventDefault();
    if (!e.repeat) press();
    return;
  }
  if (!(e.code in KEY_X) && !(e.code in KEY_Y)) return;
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
  thumb2 = null;
  paintStick();
  mouse.on = mouse.run = false;
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  if (e.pointerType === 'touch') {
    coarse = true;
    mode = 'touch';
    if (stick) { thumb2 = { id: e.pointerId, ox: e.clientX, oy: e.clientY, at: performance.now() }; return; }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0, at: performance.now(), moved: false };
    paintStick();
    return;
  }
  coarse = false;
  mouse.on = true;
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  if (e.button === 2) { mode = 'mouse'; mouse.run = true; sayHand(performance.now(), true); return; }
  press();
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    stick.dx = e.clientX - stick.ox;
    stick.dy = e.clientY - stick.oy;
    if (Math.hypot(stick.dx, stick.dy) >= DEAD) stick.moved = true;
    paintStick();
    sayHand(performance.now(), false);
  } else if (e.pointerType === 'mouse') {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.on = true;
    coarse = false;
  }
});
cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') mouse.on = false; });
function liftPointer(e) {
  if (e.pointerType === 'mouse') {
    if (e.button === 2 && mouse.run) { mouse.run = false; sayHand(performance.now(), true); }
    return;
  }
  if (thumb2 && e.pointerId === thumb2.id) {
    const dx = e.clientX - thumb2.ox, dy = e.clientY - thumb2.oy, l = Math.hypot(dx, dy);
    thumb2 = null;
    if (l >= FLICK) flickAim = [dx / l, dy / l];
    press();
    return;
  }
  if (!stick || e.pointerId !== stick.id) return;
  const tap = !stick.moved && performance.now() - stick.at < 260;
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
  if (tap) press();
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
// a player arrives on the court.
function start() {
  setHand([0, 0, 0, 0, presses]);
  lastSaid = [0, 0, 0, 0, presses];
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
