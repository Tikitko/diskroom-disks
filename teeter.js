/**
 * @disk     teeter
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Everyone stands on one raft balanced on a pivot, and it tips toward the weight. Run, let go to dig in, dash to shove a rival over the edge. Overboard, you fly as a gull and drop crates to tip it back. Last one dry wins the round.
 * @tags     game, party, realtime, physics, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/teeter.png
 */
// teeter.js — a balance brawl where the room's order is the referee.
//
// Every copy holds the whole raft — every sailor, every crate, the tilt — and
// moves it only on what comes back round the room, so every copy applies the
// same hands in the same order and holds the same raft. Nobody sends where they
// stand, who shoved whom, who fell or a score: a hand is a direction and a dash
// counter, and everything else is the same arithmetic on the same numbers on
// every machine. A page with a console open can steer its own sailor however it
// likes, at a sailor's own pace, and dash no oftener than anybody else.
//
// Your own sailor does not wait for the trip: it is drawn from the agreed raft
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.round`, `Math.floor`, `Math.abs`, `Math.min`,
// `Math.max` and `Math.imul` are fixed by the language to the last bit;
// `Math.sin` and `Math.cos` are not, so a step uses these instead.
const PI = 3.141592653589793, TAU = 6.283185307179586;

function dsin(a) {
  let x = a - TAU * Math.round(a / TAU);
  if (x > PI / 2) x = PI - x;
  else if (x < -PI / 2) x = -PI - x;
  const x2 = x * x;
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - (x2 / 110) * (1 - x2 / 156))))));
}
function dcos(a) { return dsin(a + PI / 2); }

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the raft a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own sailor a trip ahead, with your hand in it
const DT = 1 / HZ;

const R0 = 0.5;                // the raft's radius at the start of a round
const RMIN = 0.2;              // what the crumbling rim leaves for the long middle of a round
const VIEW = 0.66;             // the half-width of water drawn round the raft
const PR = 0.042;              // a sailor's radius
const CR = 0.036;              // a crate's half-width, and its radius for bumping
const ACC = 1.25;              // how hard legs push
const FRIC = 0.92;             // what one step leaves of a sliding sailor's speed
const GRAV = 0.85;             // how hard a full tilt pulls downhill
const PLANT_FRIC = 0.7;        // and of one dug in
const PLANT_GRAV = 0.15;       // how much of the slope a dug-in sailor still feels
const VMAX = 1.6;
const DASH_V = 0.95;
const DASH_CD = Math.round(2.2 * HZ);
const DASH_STEPS = 8;
const GRIP_DRAIN = DT / 2.2;   // a full grip lasts this many seconds dug in
const GRIP_FILL = DT / 4;      // and comes back over this many on the move
const GRIP_AGAIN = 0.35;       // a grip worn out takes hold again only past this
const TILT_K = 1.15;           // tilt per unit of weight at the rim's distance
const BOUNCE = 0.75;
const M_BASE = 1, M_PLANT = 4, M_DASH = 1.8, M_CRATE = 1.4;
const W_PLANT = 2, W_CRATE = 0.8;       // weight on the pivot, a sailor standing being one
const GULL_V = 0.7;
const GULL_CD = Math.round(3 * HZ);
const CRATE_FALL = 20;         // steps a dropped crate takes to land
const MAX_CRATES = 6;
const CRATE_KNOCK = 0.8;
const CREDIT_STEPS = 3 * HZ;   // a fall this soon after a shove is the shover's
const RESPAWN = 40;
const HANDS_PER_STEP = 8;      // past this, a sender's hand in one step steers but cannot dash or seat
const MAX_P = 8;
const WIN_PTS = 3, KO_PTS = 1, MATCH = 10;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const PLAY_STEPS = 110 * HZ;
const END_STEPS = 6 * HZ;
const CHAMP_STEPS = 9 * HZ;
const SHRINK_FROM = 15 * HZ;   // steps into a round when the rim starts to crumble
const SHRINK_END = 80 * HZ;    // and when it has crumbled down to RMIN
const FINAL = 100 * HZ;        // and when the last of it goes
const SWELL_FIRST = 6 * HZ;
const SWELL_EVERY = 9 * HZ;
const SWELL_WARN = 36;
const SWELL_LEN = 30;
const SWELL_PUSH = 0.55;

// The raft. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every sailor is made by one function with its fields in one order.
//   p:  player id -> a sailor (see `sailor`)
//   c:  crates, each [x, y, vx, vy, steps until it lands, the gull who dropped it]
//   tx, ty / ux, uy: the tilt, and how fast it is swinging
//   sx, sy, sn: the swell's direction and the steps left of it (0: none)
//   res: the last round's [id, points gained, points held] rows; win/champ: ids or -1
function freshTable(seed) {
  return {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, R: R0, tx: 0, ty: 0, ux: 0, uy: 0,
    sx: 0, sy: 0, sn: 0, p: {}, c: [], res: null, win: -1, champ: -1,
  };
}

const FIELDS = ['x', 'y', 'vx', 'vy', 'dx', 'dy', 'fx', 'fy', 'bs', 'ld', 'dq', 'dd', 'st', 'pl', 'tr',
  'al', 'ot', 'gx', 'gy', 'lg', 'gq', 'hb', 'ht', 'sc', 'rg', 'k', 'hs', 'hc'];
//   x, y, vx, vy: on the raft; dx, dy: the hand's direction in thousandths;
//   fx, fy: the way it last faced; bs: dash counter as last heard; ld: step of
//   the last dash; dq: a dash to make this step; dd: steps of dash left; st:
//   grip, 0..1; pl: dug in; tr: grip worn out; al: on the raft; ot: the step
//   it went overboard; gx, gy: where its gull flies; lg: the gull's last drop;
//   gq: a drop to make; hb, ht: who last shoved it, and when; sc: points; rg:
//   points this round; k: seat, which is its colour; hs, hc: hands this step.
function sailor(v) {
  const s = {};
  for (const f of FIELDS) s[f] = v[f];
  return s;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const aliveIn = (w) => playersIn(w).filter((id) => w.p[id].al);

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

function respawn(w, d) {
  d.x = (draw01(w) - 0.5) * 0.3;
  d.y = (draw01(w) - 0.5) * 0.3;
  d.vx = d.vy = 0;
  d.st = 1; d.pl = 0; d.tr = 0; d.dd = 0; d.dq = 0; d.gq = 0;
  d.al = 1; d.hb = -1; d.ht = 0;
}

// A hand, at its place in the room's order: [dx, dy, dashes] — a direction in
// thousandths and a counter that moves on by one for every dash. Being heard is
// how a sailor arrives: on the raft between rounds, as a gull during one.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = w.p[id] = sailor({
      x: 0, y: 0, vx: 0, vy: 0, dx: 0, dy: 0, fx: 1000, fy: 0, bs: input[2], ld: -DASH_CD, dq: 0, dd: 0,
      st: 1, pl: 0, tr: 0, al: 0, ot: w.n, gx: 0, gy: 0, lg: -GULL_CD, gq: 0, hb: -1, ht: 0,
      sc: 0, rg: 0, k: freeSeat(w), hs: w.n, hc: 0,
    });
    if (w.ph === WAIT || w.ph === END) respawn(w, d);
  }
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  d.dx = input[0];
  d.dy = input[1];
  if (input[2] !== d.bs) {
    d.bs = input[2];
    // A dash is a request; whether it happens is the raft's cooldown, the same
    // on every copy, and a flood of hands in one step buys none.
    if (d.hc <= HANDS_PER_STEP && w.ph !== COUNT) {
      if (d.al && w.n - d.ld >= DASH_CD) {
        d.ld = w.n;
        d.dq = 1;
        // The hand that asks for a dash aims it, even if the next one stops.
        const len = Math.sqrt(input[0] * input[0] + input[1] * input[1]);
        if (len > 60) { d.fx = Math.round((input[0] / len) * 1000); d.fy = Math.round((input[1] / len) * 1000); }
      }
      else if (!d.al && w.ph === PLAY && w.n - d.lg >= GULL_CD) d.gq = 1;
    }
  }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [dx, dy, b] = raw;
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || !Number.isInteger(b)) return null;
  if (dx < -1000 || dx > 1000 || dy < -1000 || dy > 1000 || b < 0 || b > 63) return null;
  return [dx, dy, b];
}

function leave(w, id) {
  delete w.p[id];
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.R = R0;
  w.c = [];
  w.sn = 0;
  for (const id of playersIn(w)) if (!w.p[id].al) respawn(w, w.p[id]);
}

function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  if (w.champ !== -1) {
    for (const id of playersIn(w)) w.p[id].sc = 0;
    w.champ = -1;
  }
  w.R = R0;
  w.tx = w.ty = w.ux = w.uy = 0;
  w.sn = 0;
  w.c = [];
  // Everybody round a ring, evenly, the ring turned a different way each round.
  const ids = playersIn(w).sort((a, b) => a - b);
  const turn = draw01(w) * TAU;
  ids.forEach((id, i) => {
    const d = w.p[id];
    respawn(w, d);
    const a = turn + (i / ids.length) * TAU;
    d.x = dcos(a) * 0.26;
    d.y = dsin(a) * 0.26;
    d.fx = Math.round(-dcos(a) * 1000);
    d.fy = Math.round(-dsin(a) * 1000);
    d.rg = 0;
    d.ld = w.n - DASH_CD;
  });
  fx(w, 'round');
}

function finish(w) {
  const alive = aliveIn(w);
  if (alive.length === 1) {
    const d = w.p[alive[0]];
    d.sc += WIN_PTS;
    d.rg += WIN_PTS;
    w.win = alive[0];
  }
  const res = playersIn(w).map((id) => [id, w.p[id].rg, w.p[id].sc]);
  res.sort((a, b) => b[2] - a[2] || b[1] - a[1] || a[0] - b[0]);
  w.res = res;
  // A match is won outright: two sailors level at the top play another round.
  if (res.length && res[0][2] >= MATCH && (res.length < 2 || res[1][2] < res[0][2])) w.champ = res[0][0];
  w.ph = END;
  w.pt = w.champ !== -1 ? CHAMP_STEPS : END_STEPS;
  fx(w, 'end', 0, 0, w.win);
}

function rimAt(e) {
  if (e < SHRINK_FROM) return R0;
  if (e < SHRINK_END) return R0 - ((R0 - RMIN) * (e - SHRINK_FROM)) / (SHRINK_END - SHRINK_FROM);
  if (e < FINAL) return RMIN;
  return Math.max(0, RMIN * (1 - (e - FINAL) / (PLAY_STEPS - FINAL)));
}

function overboard(w, id, d) {
  d.al = 0;
  d.ot = w.n;
  d.pl = 0;
  d.gx = d.x;
  d.gy = d.y;
  d.lg = w.n - GULL_CD;
  fx(w, 'splash', d.x, d.y, id);
  if (w.ph !== PLAY) return;
  const by = d.hb;
  if (by !== id && w.p[by] && w.n - d.ht <= CREDIT_STEPS) {
    w.p[by].sc += KO_PTS;
    w.p[by].rg += KO_PTS;
    fx(w, 'ko', d.x, d.y, by, id);
  }
}

// Two round bodies that overlap are parted and bounce, by their masses. Bodies
// are [x, y, vx, vy, mass, radius], written back by the caller.
function bump(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dd = dx * dx + dy * dy, m = a[5] + b[5];
  if (dd >= m * m) return 0;
  const dist = dd < 1e-12 ? 0 : Math.sqrt(dd);
  // Two bodies on one spot are parted along the raft's width.
  const nx = dist ? dx / dist : 1, ny = dist ? dy / dist : 0;
  const ia = 1 / a[4], ib = 1 / b[4], over = m - dist;
  a[0] -= nx * over * ia / (ia + ib);
  a[1] -= ny * over * ia / (ia + ib);
  b[0] += nx * over * ib / (ia + ib);
  b[1] += ny * over * ib / (ia + ib);
  const vn = (b[2] - a[2]) * nx + (b[3] - a[3]) * ny;
  if (vn >= 0) return 0;
  const j = (-(1 + BOUNCE) * vn) / (ia + ib);
  a[2] -= j * ia * nx; a[3] -= j * ia * ny;
  b[2] += j * ib * nx; b[3] += j * ib * ny;
  return -vn;
}

// One step of the raft: a function of the raft alone.
function step(w) {
  const many = playersIn(w).length;
  if (w.ph === WAIT) {
    if (many >= 2) begin(w);
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }

  // The rim crumbles and the sea swells, the longer a round goes on.
  if (w.ph === PLAY) {
    const e = PLAY_STEPS - w.pt;
    w.R = rimAt(e);
    if (e >= SWELL_FIRST && (e - SWELL_FIRST) % SWELL_EVERY === 0) {
      const a = draw01(w) * TAU;
      w.sx = dcos(a);
      w.sy = dsin(a);
      w.sn = SWELL_WARN + SWELL_LEN;
      fx(w, 'swell', w.sx, w.sy);
    }
  }
  if (w.sn > 0) w.sn -= 1;

  const ids = playersIn(w);
  const frozen = w.ph === COUNT;

  // The tilt leans toward the weight, measured against the rim, so a raft that
  // has crumbled is no steadier than a whole one.
  let gx = 0, gy = 0;
  if (!frozen) {
    for (const id of ids) {
      const d = w.p[id];
      if (!d.al) continue;
      const m = d.pl ? W_PLANT : 1;
      gx += m * d.x; gy += m * d.y;
    }
    for (const c of w.c) if (c[4] === 0) { gx += W_CRATE * c[0]; gy += W_CRATE * c[1]; }
  }
  const lever = TILT_K / Math.max(w.R, 0.08);
  gx *= lever; gy *= lever;
  if (w.sn > 0 && w.sn <= SWELL_LEN) { gx += w.sx * SWELL_PUSH; gy += w.sy * SWELL_PUSH; }
  const gl = Math.sqrt(gx * gx + gy * gy);
  if (gl > 1) { gx /= gl; gy /= gl; }
  w.ux = w.ux * 0.78 + (gx - w.tx) * 0.06;
  w.uy = w.uy * 0.78 + (gy - w.ty) * 0.06;
  w.tx += w.ux;
  w.ty += w.uy;
  const tl = Math.sqrt(w.tx * w.tx + w.ty * w.ty);
  if (tl > 1.1) { w.tx = (w.tx / tl) * 1.1; w.ty = (w.ty / tl) * 1.1; }
  if (frozen) return;

  // Sailors: legs, grip and the slope.
  for (const id of ids) {
    const d = w.p[id];
    const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy);
    const moving = len > 60;
    const ux = moving ? d.dx / len : 0, uy = moving ? d.dy / len : 0;
    if (!d.al) {
      // A gull flies over the water and drops what it carries.
      d.gx += ux * GULL_V * DT;
      d.gy += uy * GULL_V * DT;
      const gr = Math.sqrt(d.gx * d.gx + d.gy * d.gy);
      if (gr > VIEW - 0.04) { d.gx = (d.gx / gr) * (VIEW - 0.04); d.gy = (d.gy / gr) * (VIEW - 0.04); }
      if (d.gq) {
        d.gq = 0;
        if (w.ph === PLAY && w.n - d.lg >= GULL_CD && w.c.length < MAX_CRATES) {
          d.lg = w.n;
          w.c.push([d.gx, d.gy, 0, 0, CRATE_FALL, id]);
          fx(w, 'drop', d.gx, d.gy, id);
        }
      }
      if ((w.ph === WAIT || w.ph === END) && w.n - d.ot >= RESPAWN) respawn(w, d);
      continue;
    }
    if (moving) { d.fx = Math.round(ux * 1000); d.fy = Math.round(uy * 1000); }
    d.pl = !moving && d.dd === 0 && !d.tr && d.st > 0 ? 1 : 0;
    if (d.pl) {
      d.st -= GRIP_DRAIN;
      if (d.st <= 0) { d.st = 0; d.tr = 1; d.pl = 0; fx(w, 'slip', d.x, d.y, id); }
    } else {
      d.st = Math.min(1, d.st + GRIP_FILL);
      if (d.tr && d.st >= GRIP_AGAIN) d.tr = 0;
    }
    if (d.dq) {
      d.dq = 0;
      const fl = Math.sqrt(d.fx * d.fx + d.fy * d.fy) || 1;
      const ax = moving ? ux : d.fx / fl, ay = moving ? uy : d.fy / fl;
      d.vx += ax * DASH_V;
      d.vy += ay * DASH_V;
      d.dd = DASH_STEPS;
      d.pl = 0;
      fx(w, 'dash', d.x, d.y, id);
    }
    const g = d.pl ? PLANT_GRAV : 1;
    let ax = GRAV * w.tx * g, ay = GRAV * w.ty * g;
    if (moving && !d.pl) { ax += ux * ACC; ay += uy * ACC; }
    const keep = d.pl ? PLANT_FRIC : d.dd > 0 ? 0.97 : FRIC;
    d.vx = (d.vx + ax * DT) * keep;
    d.vy = (d.vy + ay * DT) * keep;
    const v = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    if (v > VMAX) { d.vx = (d.vx / v) * VMAX; d.vy = (d.vy / v) * VMAX; }
    d.x += d.vx * DT;
    d.y += d.vy * DT;
    if (d.dd > 0) d.dd -= 1;
  }

  // Crates: falling ones land, landed ones slide.
  for (let i = w.c.length - 1; i >= 0; i--) {
    const c = w.c[i];
    if (c[4] > 0) {
      c[4] -= 1;
      if (c[4] > 0) continue;
      if (c[0] * c[0] + c[1] * c[1] > w.R * w.R) {
        fx(w, 'plop', c[0], c[1]);
        w.c.splice(i, 1);
        continue;
      }
      fx(w, 'thunk', c[0], c[1], c[5]);
      for (const id of ids) {
        const d = w.p[id];
        if (!d.al) continue;
        const dx = d.x - c[0], dy = d.y - c[1], dd = dx * dx + dy * dy, m = PR + CR + 0.02;
        if (dd >= m * m) continue;
        const dist = Math.sqrt(dd), nx = dist > 1e-6 ? dx / dist : 1, ny = dist > 1e-6 ? dy / dist : 0;
        const f = d.pl ? CRATE_KNOCK / 3 : CRATE_KNOCK;
        d.vx += nx * f;
        d.vy += ny * f;
        d.hb = c[5];
        d.ht = w.n;
        fx(w, 'hit', d.x, d.y, id);
      }
      continue;
    }
    c[2] = (c[2] + GRAV * w.tx * DT) * 0.93;
    c[3] = (c[3] + GRAV * w.ty * DT) * 0.93;
    c[0] += c[2] * DT;
    c[1] += c[3] * DT;
  }

  // Everything standing on the raft bumps everything else.
  const bodies = [];
  for (const id of ids) {
    const d = w.p[id];
    if (!d.al) continue;
    const m = d.pl ? M_PLANT : d.dd > 0 ? M_DASH : M_BASE;
    bodies.push({ id, d, b: [d.x, d.y, d.vx, d.vy, m, PR] });
  }
  for (const c of w.c) if (c[4] === 0) bodies.push({ id: null, c, b: [c[0], c[1], c[2], c[3], M_CRATE, CR] });
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const A = bodies[i], B = bodies[j];
    const hit = bump(A.b, B.b);
    if (hit < 0.12) continue;
    // A shove is remembered against whoever took it, so a fall soon after is
    // the shover's: a crate shoves for the gull that dropped it.
    const by = (o) => (o.id !== null ? o.id : o.c[5]);
    if (A.id !== null) { A.d.hb = by(B); A.d.ht = w.n; }
    if (B.id !== null) { B.d.hb = by(A); B.d.ht = w.n; }
    if (hit > 0.2) fx(w, 'bump', (A.b[0] + B.b[0]) / 2, (A.b[1] + B.b[1]) / 2, Math.min(9, Math.round(hit * 6)),
      A.id !== null ? A.id : -9, B.id !== null ? B.id : -9);
  }
  for (const o of bodies) {
    const t = o.id !== null ? o.d : null;
    if (t) { t.x = o.b[0]; t.y = o.b[1]; t.vx = o.b[2]; t.vy = o.b[3]; }
    else { o.c[0] = o.b[0]; o.c[1] = o.b[1]; o.c[2] = o.b[2]; o.c[3] = o.b[3]; }
  }

  // Whatever stands past the rim goes into the sea.
  for (const id of ids) {
    const d = w.p[id];
    if (d.al && d.x * d.x + d.y * d.y > w.R * w.R) overboard(w, id, d);
  }
  for (let i = w.c.length - 1; i >= 0; i--) {
    const c = w.c[i];
    if (c[4] === 0 && c[0] * c[0] + c[1] * c[1] > w.R * w.R) {
      fx(w, 'plop', c[0], c[1]);
      w.c.splice(i, 1);
    }
  }

  if (w.ph === PLAY && aliveIn(w).length <= 1) finish(w);
}

// A raft handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!num(raw.R, 0, R0)) return null;
  for (const k of ['tx', 'ty', 'ux', 'uy', 'sx', 'sy']) if (!num(raw[k], -2, 2)) return null;
  if (!int(raw.sn, 0, SWELL_WARN + SWELL_LEN)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!num(d.x, -2, 2) || !num(d.y, -2, 2) || !num(d.vx, -5, 5) || !num(d.vy, -5, 5)) return null;
    if (!num(d.gx, -1, 1) || !num(d.gy, -1, 1) || !num(d.st, 0, 1)) return null;
    if (inputOf([d.dx, d.dy, d.bs]) === null || !int(d.fx, -1000, 1000) || !int(d.fy, -1000, 1000)) return null;
    for (const k of ['dq', 'pl', 'tr', 'al', 'gq']) if (d[k] !== 0 && d[k] !== 1) return null;
    if (!int(d.dd, 0, DASH_STEPS) || !int(d.k, 0, MAX_P - 1) || seats.has(d.k)) return null;
    seats.add(d.k);
    for (const k of ['ld', 'ot', 'lg', 'hb', 'ht', 'hs']) if (!int(d[k], -BIG, BIG)) return null;
    if (!int(d.sc, 0, 9999) || !int(d.rg, 0, 9999) || !int(d.hc, 0, BIG)) return null;
    p[id] = sailor(d);
  }
  if (!Array.isArray(raw.c) || raw.c.length > MAX_CRATES) return null;
  const c = [];
  for (const v of raw.c) {
    if (!Array.isArray(v) || v.length !== 6) return null;
    if (!num(v[0], -1, 1) || !num(v[1], -1, 1) || !num(v[2], -5, 5) || !num(v[3], -5, 5)) return null;
    if (!int(v[4], 0, CRATE_FALL) || !int(v[5], -BIG, BIG)) return null;
    c.push(v.slice());
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
  if (!int(raw.win, -BIG, BIG) || !int(raw.champ, -BIG, BIG)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, R: raw.R, tx: raw.tx, ty: raw.ty, ux: raw.ux, uy: raw.uy,
    sx: raw.sx, sy: raw.sy, sn: raw.sn, p, c, res, win: raw.win, champ: raw.champ,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed raft steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a cold sea, a warm wooden raft, and a colour for each seat that
// is the sailor's, its gull's and its chip's on the scoreboard.
const INK = {
  page: '#0b2a3a', seaTop: '#0f3a4f', seaLow: '#08202e', wave: 'rgba(160,220,240,0.10)',
  deck: '#c89a5c', plank: '#b98a4f', seam: 'rgba(90,55,25,0.45)', rim: '#7a5530', ghost: 'rgba(200,160,100,0.22)',
  foam: '#e8f6fa', text: '#f3efe6', muted: '#a9c3cc', dim: '#6f8f99', gold: '#ffd166',
  panel: 'rgba(8,28,40,0.9)', danger: '#ff6b5e', crate: '#b5824a', crateDark: '#7a5530',
};
const SEAT = ['#ff7f50', '#4fc3f7', '#ffd54f', '#ba68c8', '#f06292', '#4dd0b5', '#ef5350', '#9fa8ff'];
const FONT = "600 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #2c5568;' +
  `background:#123447;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, sc = 1, cx = 320, cy = 200, TOP = 56, BOT = 28, dpx = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 56;
  BOT = 28;
  const aw = VW - 16, ah = Math.max(40, VH - TOP - BOT);
  sc = Math.max(10, Math.min(aw, ah) / (2 * VIEW));
  cx = VW / 2;
  cy = TOP + ah / 2;
}
layout();
window.addEventListener('resize', layout);

// The raft to the screen and back.
const SX = (x) => cx + x * sc;
const SY = (y) => cy + y * sc;
function inField() {
  ctx.setTransform(dpx, 0, 0, dpx, 0, 0);
  ctx.translate(cx + shakeX, cy + shakeY);
  ctx.scale(sc, sc);
}
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

function nickOf(id) {
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
  whoosh() { if (ready('whoosh', 80)) { puff(0.16, 0.13, 1500, 0, 0.8); puff(0.12, 0.06, 3000, 0.03); } },
  thud(v) {
    if (!ready('thud', 70)) return;
    tone(130, 0.13, 'sine', 0.06 + 0.16 * v, 0.5);
    puff(0.06, 0.04 + 0.08 * v, 420);
  },
  splash(mine) {
    if (!ready('splash', 120)) return;
    const v = mine ? 1 : 0.6;
    puff(0.45, 0.22 * v, 650, 0, 0.7);
    puff(0.3, 0.1 * v, 2400, 0.05);
    tone(360, 0.22, 'sine', 0.05 * v, 0.35);
  },
  ding() { if (ready('ding', 80)) { tone(880, 0.1, 'triangle', 0.12); tone(1320, 0.18, 'triangle', 0.1, 0, 0.07); } },
  whistle() { if (ready('whistle', 120)) tone(1500, 0.55, 'sine', 0.045, 0.45); },
  thunk() { if (ready('thunk', 80)) { tone(95, 0.16, 'square', 0.07, 0.6); puff(0.08, 0.12, 520); } },
  plop() { if (ready('plop', 80)) tone(520, 0.12, 'sine', 0.07, 0.4); },
  swell() {
    if (!ready('swell', 600)) return;
    tone(98, 0.9, 'sawtooth', 0.045, 1.25);
    tone(147, 0.9, 'sawtooth', 0.03, 1.2);
    puff(0.9, 0.06, 300, 0.1, 0.6);
  },
  slip() { if (ready('slip', 200)) { tone(760, 0.14, 'square', 0.035, 0.55); tone(560, 0.14, 'square', 0.03, 0.55, 0.09); } },
  beep(hi) { if (ready('beep', 200)) tone(hi ? 880 : 620, 0.12, 'sine', 0.12); },
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
const bits = [];      // { x, y, vx, vy, life, max, size, colour, fall } in raft units
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, fall) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (fall ? speed * 0.8 : 0), life: 0,
      max: 20 + Math.random() * 22, size, colour, fall: fall || 0 });
  }
  if (bits.length > 500) bits.splice(0, bits.length - 500);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 55, px: px || 16, lift: lift || 16 }); }
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
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, seen }
let myDashAt = -1e9;
let drawFailed = false;
const DASH_MS = (DASH_CD / HZ) * 1000 + 150;
const GULL_MS = (GULL_CD / HZ) * 1000 + 150;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, seen: 0 }));
  l.seen = performance.now();
  return l;
}
function colourOf(t, id) {
  const d = t.p[id];
  return d ? SEAT[d.k] : '#dddddd';
}

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  if (e.kind === 'dash') {
    lookOf(e.a).squash = 1;
    if (e.a === me) return;    // your own was heard and seen the moment you pressed
    spray(e.x, e.y, 6, 'rgba(232,246,250,0.8)', 0.3, 0.006);
    sound.whoosh();
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 3 + e.a, '#fff3d6', 0.25 + e.a * 0.05, 0.006);
    // A crate in a bump is named -9: it has no face to squash.
    if (e.b !== -9) lookOf(e.b).squash = Math.min(1, e.a / 5);
    if (e.c !== -9) lookOf(e.c).squash = Math.min(1, e.a / 5);
    const mine = e.b === me || e.c === me;
    if (mine) shake = Math.max(shake, 2 + e.a);
    sound.thud(mine ? Math.min(1, e.a / 5) : 0.25);
  } else if (e.kind === 'splash') {
    spray(e.x, e.y, 26, INK.foam, 0.6, 0.009, 1.4);
    spray(e.x, e.y, 10, SEAT[(t.p[e.a] || { k: 0 }).k], 0.4, 0.007, 1.2);
    ring(e.x, e.y, INK.foam, 0.14);
    if (e.a === me) { shake = Math.max(shake, 9); pop(e.x, e.y, 'overboard!', INK.foam, 20, 30); }
    else pop(e.x, e.y, 'splash!', INK.foam, 15, 24);
    sound.splash(e.a === me);
  } else if (e.kind === 'ko') {
    pop(e.x, e.y + 0.05, '+1 ' + (e.a === me ? 'you' : nickOf(e.a)), colourOf(t, e.a), 16, 40);
    if (e.a === me) sound.ding();
  } else if (e.kind === 'drop') {
    if (e.a !== me) sound.whistle();
  } else if (e.kind === 'thunk') {
    spray(e.x, e.y, 10, INK.deck, 0.4, 0.008);
    ring(e.x, e.y, colourOf(t, e.a), PR + CR + 0.02);
    shake = Math.max(shake, 3);
    sound.thunk();
  } else if (e.kind === 'hit') {
    lookOf(e.a).squash = 1;
    if (e.a === me) shake = Math.max(shake, 7);
  } else if (e.kind === 'plop') {
    spray(e.x, e.y, 10, INK.foam, 0.35, 0.007, 1.2);
    sound.plop();
  } else if (e.kind === 'swell') {
    const r = (t.R || R0) + 0.07;
    pop(e.x * r, e.y * r, 'swell!', INK.foam, 18, 22);
    sound.swell();
  } else if (e.kind === 'slip') {
    if (e.a === me) { pop(e.x, e.y, 'grip gone!', INK.danger, 14, 26); sound.slip(); }
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    if (md || e.a === me) sound.end(e.a === me);
  }
}

// The sea: two shades and slow lines of swell, drawn from the clock alone.
function drawSea(now) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.seaTop);
  g.addColorStop(1, INK.seaLow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  ctx.strokeStyle = INK.wave;
  ctx.lineWidth = 1.5;
  const gap = Math.max(18, sc * 0.09);
  const tt = now / 1000;
  for (let row = 0, y = (tt * 6) % gap - gap; y < VH + gap; y += gap, row++) {
    ctx.beginPath();
    for (let x = -10; x <= VW + 10; x += 12) {
      const yy = y + Math.sin(x / 38 + tt * 1.3 + row * 1.7) * 3;
      if (x === -10) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
}

function drawRaft(t, tx, ty, R, now) {
  inField();
  const tl = Math.min(1.1, Math.hypot(tx, ty));
  const nx = tl > 1e-4 ? tx / tl : 1, ny = tl > 1e-4 ? ty / tl : 0;
  // Where the rim stood at the start of the round, crumbled away.
  if (R < R0 - 0.005) {
    ctx.strokeStyle = INK.ghost;
    ctx.lineWidth = 0.006;
    ctx.setLineDash([0.02, 0.025]);
    disc(0, 0, R0);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (R <= 0.002) return;
  // Its shadow in the water slides toward the low side.
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  disc(nx * tl * 0.035, ny * tl * 0.035 + 0.02, R + 0.014);
  ctx.fill();
  ctx.fillStyle = INK.rim;
  disc(0, 0, R + 0.014);
  ctx.fill();
  ctx.save();
  disc(0, 0, R);
  ctx.clip();
  ctx.fillStyle = INK.deck;
  ctx.fillRect(-R, -R, 2 * R, 2 * R);
  ctx.fillStyle = INK.plank;
  for (let y = -R0, i = 0; y < R0; y += 0.07, i++) if (i % 2) ctx.fillRect(-R0, y, 2 * R0, 0.07);
  ctx.strokeStyle = INK.seam;
  ctx.lineWidth = 0.003;
  for (let y = -R0; y < R0; y += 0.07) { ctx.beginPath(); ctx.moveTo(-R0, y); ctx.lineTo(R0, y); ctx.stroke(); }
  // Light on the high side, shade on the low.
  if (tl > 0.01) {
    const g = ctx.createLinearGradient(-nx * R, -ny * R, nx * R, ny * R);
    g.addColorStop(0, `rgba(255,240,200,${0.16 * tl})`);
    g.addColorStop(0.5, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,20,40,${0.45 * tl})`);
    ctx.fillStyle = g;
    ctx.fillRect(-R, -R, 2 * R, 2 * R);
  }
  ctx.restore();
  // The sea washing over the low edge.
  if (tl > 0.04) {
    const a = Math.atan2(ny, nx), span = 0.3 + 0.9 * Math.min(1, tl);
    ctx.strokeStyle = `rgba(232,246,250,${Math.min(0.85, tl * 1.2)})`;
    ctx.lineWidth = 0.01 + 0.02 * Math.min(1, tl) + 0.004 * Math.sin(now / 160);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, R + 0.012, a - span / 2, a + span / 2);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  // The level on the pivot: its bubble runs uphill.
  ctx.fillStyle = 'rgba(60,35,15,0.35)';
  disc(0, 0, 0.03);
  ctx.fill();
  ctx.fillStyle = tl > 0.75 ? INK.danger : INK.foam;
  disc(-nx * Math.min(1, tl) * 0.02, -ny * Math.min(1, tl) * 0.02, 0.01);
  ctx.fill();
}

// A swell coming: a crest on the water that rolls in from where it will push.
function drawSwell(t, R, now) {
  if (!t.sn) return;
  inField();
  const warn = t.sn > SWELL_LEN;
  const k = warn ? 1 - (t.sn - SWELL_LEN) / SWELL_WARN : 1 - t.sn / SWELL_LEN;
  const a = Math.atan2(t.sy, t.sx);
  const r = warn ? VIEW - 0.02 - k * (VIEW - R - 0.06) : R + 0.04;
  ctx.strokeStyle = `rgba(232,246,250,${warn ? 0.35 + 0.4 * Math.abs(Math.sin(now / 120)) : 0.6 * (1 - k)})`;
  ctx.lineWidth = 0.018;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, r, a - 0.5, a + 0.5);
  ctx.stroke();
  ctx.lineWidth = 0.008;
  ctx.beginPath();
  ctx.arc(0, 0, r + 0.035, a - 0.35, a + 0.35);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawCrate(c, colour) {
  const f = c[4] / CRATE_FALL;
  // The shadow first, sharper the nearer the crate is to landing.
  ctx.fillStyle = `rgba(0,0,0,${0.18 + 0.2 * (1 - f)})`;
  ctx.beginPath();
  ctx.ellipse(c[0], c[1] + 0.006, CR * (1 - 0.5 * f), CR * 0.7 * (1 - 0.5 * f), 0, 0, Math.PI * 2);
  ctx.fill();
  const s = CR * (1 + 0.6 * f), y = c[1] - f * 0.3;
  ctx.fillStyle = INK.crate;
  ctx.fillRect(c[0] - s, y - s, 2 * s, 2 * s);
  ctx.strokeStyle = INK.crateDark;
  ctx.lineWidth = 0.006;
  ctx.strokeRect(c[0] - s, y - s, 2 * s, 2 * s);
  ctx.beginPath();
  ctx.moveTo(c[0] - s, y - s); ctx.lineTo(c[0] + s, y + s);
  ctx.moveTo(c[0] + s, y - s); ctx.lineTo(c[0] - s, y + s);
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fillRect(c[0] - s, y - s, 2 * s, s * 0.32);
}

function drawSailor(id, x, y, d, colour, me, now) {
  const look = lookOf(id);
  const sq = look.squash;
  // Its dash leaves a few ghosts behind it.
  if (d.dd > 0) {
    const v = Math.hypot(d.vx, d.vy) || 1;
    for (let i = 1; i <= 3; i++) {
      ctx.globalAlpha = 0.18 / i;
      ctx.fillStyle = colour;
      disc(x - (d.vx / v) * PR * 1.1 * i, y - (d.vy / v) * PR * 1.1 * i, PR * (1 - i * 0.12));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(x + 0.005, y + 0.012, PR * 1.02, PR * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  // Dug in: feet spread and claws in the planks.
  if (d.pl) {
    ctx.strokeStyle = 'rgba(40,22,8,0.7)';
    ctx.lineWidth = 0.006;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * PR * 0.95, y + Math.sin(a) * PR * 0.95);
      ctx.lineTo(x + Math.cos(a) * PR * 1.3, y + Math.sin(a) * PR * 1.3);
      ctx.stroke();
    }
  }
  const fl = Math.hypot(d.fx, d.fy) || 1, fx_ = d.fx / fl, fy_ = d.fy / fl;
  ctx.save();
  ctx.translate(x, y);
  const sx = 1 + 0.22 * sq, sy = 1 - 0.22 * sq;
  ctx.scale(d.pl ? 1.06 : sx, d.pl ? 0.94 : sy);
  ctx.fillStyle = colour;
  disc(0, 0, PR);
  ctx.fill();
  ctx.strokeStyle = me ? '#ffffff' : 'rgba(0,0,0,0.35)';
  ctx.lineWidth = me ? 0.006 : 0.004;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  disc(-PR * 0.32, -PR * 0.35, PR * 0.38);
  ctx.fill();
  // Eyes that look where it is going.
  const px = -fy_, py = fx_;
  for (const side of [-1, 1]) {
    const ex = fx_ * PR * 0.38 + px * PR * 0.36 * side, ey = fy_ * PR * 0.38 + py * PR * 0.36 * side;
    ctx.fillStyle = '#ffffff';
    disc(ex, ey, PR * 0.26);
    ctx.fill();
    ctx.fillStyle = '#1a1a22';
    disc(ex + fx_ * PR * 0.1, ey + fy_ * PR * 0.1, PR * 0.12);
    ctx.fill();
  }
  ctx.restore();
  // Worn out: a bead of sweat.
  if (d.tr) {
    ctx.fillStyle = 'rgba(200,235,255,0.9)';
    disc(x + PR * 0.9, y - PR * 0.9 - 0.006 * Math.abs(Math.sin(now / 150)), PR * 0.18);
    ctx.fill();
  }
  // Your own grip, round your own sailor.
  if (me) {
    ctx.strokeStyle = d.tr ? INK.danger : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 0.007;
    ctx.beginPath();
    ctx.arc(x, y, PR + 0.014, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, d.st));
    ctx.stroke();
  }
}

function drawGull(x, y, colour, me, now, cool) {
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, y, 0.024, 0.014, 0, 0, Math.PI * 2);
  ctx.fill();
  if (me) {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 0.004;
    ctx.setLineDash([0.012, 0.01]);
    disc(x, y, CR + 0.014);
    ctx.stroke();
    ctx.setLineDash([]);
    if (cool < 1) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 0.006;
      ctx.beginPath();
      ctx.arc(x, y, CR + 0.024, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cool);
      ctx.stroke();
    }
  }
  const by = y - 0.1, flap = 0.022 * Math.sin(now / 95 + x * 20);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 0.012;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 0.05, by - flap);
  ctx.quadraticCurveTo(x - 0.024, by - 0.02 - flap * 0.5, x, by);
  ctx.quadraticCurveTo(x + 0.024, by - 0.02 - flap * 0.5, x + 0.05, by - flap);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  disc(x, by + 0.002, 0.009);
  ctx.fill();
  ctx.lineCap = 'butt';
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
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
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
  if (t.ph === WAIT) status = 'waiting for a second sailor';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    const e = PLAY_STEPS - t.pt;
    status = 'round ' + t.rd + ' · ' + aliveIn(t).length + ' afloat · ' + clock(t.pt);
    if (e >= FINAL) { status += ' · last planks!'; colour = (Math.floor(now / 250) % 2) ? INK.danger : INK.text; }
    else if (e >= SHRINK_FROM && e < SHRINK_END) status += ' · rim crumbling';
  } else status = 'round ' + t.rd + ' · over';
  text('teeter', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('teeter').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 100, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a sailor, in its seat's colour, with its points.
  const ids = playersIn(t).sort((a, b) => t.p[a].k - t.p[b].k);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, wet = !d.al && t.ph === PLAY;
      ctx.globalAlpha = wet ? 0.55 : 1;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[d.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[d.k];
      ctx.strokeStyle = SEAT[d.k];
      ctx.lineWidth = 2;
      disc(x + 11, y - 2, 5);
      if (wet) ctx.stroke(); else ctx.fill();
      const score = String(d.sc);
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, INK.text, 'right');
      if (cw > 50) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      ctx.globalAlpha = 1;
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const md = t.p[me];
  const gull = md && !md.al && t.ph === PLAY;
  const how = gull
    ? coarse ? 'you are a gull · drag to fly · tap to drop a crate' : 'you are a gull · move to fly · space or click drops a crate'
    : coarse ? 'drag to run · let go to dig in · tap to dash · shove them overboard'
      : 'WASD/arrows or hold the mouse to run · let go to dig in · space/click dashes · M mutes';
  fitText(how, VW / 2, VH - 10, 12, gull ? INK.gold : INK.muted, VW - 20);
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
  if (t.ph === WAIT) {
    // Kept to the top of the sea, so the raft in the middle stays in view.
    const w = Math.min(VW - 32, 380), py = TOP + 52;
    panel(cx, py, w, 92);
    fitText('waiting for a second sailor', cx, py - 14, 18, INK.text, w - 24);
    fitText('practise: walk to the rim and feel the raft tip', cx, py + 12, 13, INK.muted, w - 24);
    fitText('a round starts the moment somebody joins', cx, py + 32, 12, INK.dim, w - 24);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    fitText('last one dry wins · ' + MATCH + ' points takes the match', cx, cy + big * 2.2, 15, INK.text, VW - 40);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('go!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const total = t.champ !== -1 ? CHAMP_STEPS : END_STEPS;
    const k = ease(Math.min(1, (total - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 100 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = cy + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.champ !== -1) { head = t.champ === me ? 'you win the match!' : nickOf(t.champ) + ' wins the match!'; hc = INK.gold; }
    else if (t.win !== -1) { head = t.win === me ? 'you stayed dry!' : nickOf(t.win) + ' stayed dry'; hc = colourOf(t, t.win); }
    else head = 'everybody got wet';
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 34, 22, hc, w - 24);
    rows.forEach(([id, got, held], i) => {
      const y = y0 + 64 + i * 22;
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (id === t.champ ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 130, 'left');
      if (got) text('+' + got, cx + w / 2 - 56, y, 13, INK.gold, 'right');
      text(String(held), cx + w / 2 - 22, y, 15, INK.text, 'right');
    });
    fitText((t.champ !== -1 ? 'a new match in ' : 'next round in ') + Math.ceil(t.pt / HZ) + ' · first to ' + MATCH,
      cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Positions between two tables: a sailor that has just gone overboard, or just
// come back, is drawn where the newer table has it rather than walked there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || q.al !== p.al) return [p.x, p.y, p.gx, p.gy];
  return [lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k), lerp(q.gx, p.gx, b.k), lerp(q.gy, p.gy, b.k)];
}

// Your own sailor is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh — is taken at once.
let shown = null;
const SNAP = 0.15;
function settle(tx, ty, alive) {
  if (!shown || shown[2] !== alive || (tx - shown[0]) ** 2 + (ty - shown[1]) ** 2 > SNAP * SNAP) return (shown = [tx, ty, alive]);
  const k = per60(0.35);
  shown[0] += (tx - shown[0]) * k;
  shown[1] += (ty - shown[1]) * k;
  return shown;
}

let myPos = null;      // [x, y]: where your sailor, or your gull, is drawn
function draw(now) {
  drawSea(now);
  const b = agreedAt(now);
  if (!b) {
    myPos = shown = null;
    flat();
    panel(cx, cy, Math.min(VW - 32, 300), 60);
    text('catching up with the raft…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a raft this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const R = lerp(b.from.R, t.R, b.k);
  drawRaft(t, lerp(b.from.tx, t.tx, b.k), lerp(b.from.ty, t.ty, b.k), R, now);
  drawSwell(t, R, now);
  inField();
  const crates = t.c, was = b.from.c.length === crates.length ? b.from.c : null;
  for (let i = 0; i < crates.length; i++) {
    const c = crates[i];
    if (c[4] !== 0) continue;
    const q = was && was[i][5] === c[5] ? was[i] : c;
    drawCrate([lerp(q[0], c[0], b.k), lerp(q[1], c[1], b.k), 0, 0, 0, c[5]], colourOf(t, c[5]));
  }
  const me = myId();
  const ids = playersIn(t);
  let mine = null;
  const m = mineAt(now);
  if (m && m.to.p[me]) {
    const pos = between(m, me), d = m.to.p[me];
    if (pos) {
      const s = d.al ? settle(pos[0], pos[1], 1) : settle(pos[2], pos[3], 0);
      mine = { d, x: s[0], y: s[1] };
    }
  }
  myPos = mine ? [mine.x, mine.y] : (shown = null);
  for (const id of ids) {
    if (id === me) continue;
    const d = t.p[id], pos = between(b, id);
    if (pos && d.al) drawSailor(id, pos[0], pos[1], d, SEAT[d.k], false, now);
  }
  if (mine && mine.d.al) drawSailor(me, mine.x, mine.y, mine.d, SEAT[mine.d.k], true, now);
  // Names under the others, so a shove has somebody to be aimed at.
  flat();
  for (const id of ids) {
    if (id === me) continue;
    const d = t.p[id], pos = between(b, id);
    if (pos && d.al) fitText(nickOf(id), SX(pos[0]), SY(pos[1]) + PR * sc + 13, 11, INK.text, 90);
  }
  inField();
  // Crates still falling, and the gulls above it all.
  for (const c of crates) if (c[4] > 0) drawCrate(c, colourOf(t, c[5]));
  for (const id of ids) {
    if (id === me) continue;
    const d = t.p[id], pos = between(b, id);
    if (pos && !d.al && t.ph === PLAY) drawGull(pos[2], pos[3], SEAT[d.k], false, now, 1);
  }
  if (mine && !mine.d.al && t.ph === PLAY) {
    const cool = Math.min(1, (t.n - mine.d.lg) / GULL_CD);
    drawGull(mine.x, mine.y, SEAT[mine.d.k], true, now, cool);
  }
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: a direction in thousandths, and how many dashes so far.
// Setting off and stopping go out at once; a change of direction while running
// goes out no oftener than TURN_EVERY, because a thumb moving in a circle
// changes it on every move the screen reports and the clock's ticks share the
// same seat's ceiling on messages.
const TURN_EVERY = 66;
let wanted = [0, 0];
let lastSaid = [0, 0];
let saidAt = -1e9;
let dashes = 0;

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
  setHand([d[0], d[1], dashes]);
}

// A dash, or a gull's crate, is asked for no sooner than the raft will allow
// it, so it is never spent on a cooldown; you hear and see it at once, and the
// raft carries it out a trip later on every copy alike.
function dash() {
  wake();
  if (!world) return;
  const d = world.p[myId()];
  const now = performance.now();
  const gull = d && !d.al;
  if (gull && world.ph !== PLAY) return;
  if (world.ph === COUNT || now - myDashAt < (gull ? GULL_MS : DASH_MS)) return;
  myDashAt = now;
  dashes = (dashes + 1) % 64;
  lastSaid = wanted;
  saidAt = now;
  setHand([wanted[0], wanted[1], dashes]);
  if (myPos && d) {
    if (gull) {
      ring(myPos[0], myPos[1], SEAT[d.k], CR + 0.03);
      sound.whistle();
    } else {
      ring(myPos[0], myPos[1], SEAT[d.k], PR * 2.4);
      spray(myPos[0], myPos[1], 6, 'rgba(232,246,250,0.8)', 0.3, 0.006);
      lookOf(myId()).squash = 1;
      sound.whoosh();
    }
  }
}

// Keys are read by where they sit, not what they type, so every layout runs.
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
  if (e.code === 'Space' || e.code === 'KeyE' || e.code === 'Enter') {
    e.preventDefault();
    if (!e.repeat) dash();
    return;
  }
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

// A thumb: a stick from wherever it lands, and a tap dashes — a drag rather
// than a press, because iOS keeps a long press inside a frame for itself. A
// second finger down while the first runs dashes too.
// A mouse: hold the button and the sailor runs to the pointer; a click dashes
// toward it.
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
    if (stick) { dash(); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
    paintStick(0, 0);
    return;
  }
  coarse = false;
  if (e.button !== 0 && e.button !== 2) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mouse = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    paintStick(dx, dy);
    const still = Math.hypot(dx, dy) < DEAD;
    if (!still) stick.moved = true;
    shove(still ? 0 : dx, still ? 0 : dy);
  } else if (mouse && e.pointerId === mouse.id) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (Math.hypot(mouse.x - mouse.ox, mouse.y - mouse.oy) > 6) mouse.moved = true;
  }
});
function lift(e) {
  if (stick && e.pointerId === stick.id) {
    const tap = !stick.moved && performance.now() - stick.at < 260;
    dropStick();
    if (tap) dash();
  } else if (mouse && e.pointerId === mouse.id) {
    const click = !mouse.moved && performance.now() - mouse.at < 220;
    const toward = pointerWay(mouse);
    mouse = null;
    if (click) {
      // A click dashes toward the pointer: the hand that asks for it points
      // there, and the raft turns the sailor that way as it takes the dash.
      if (toward) shove(toward[0], toward[1]);
      dash();
    }
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

// The way from where your sailor, or gull, is drawn to the pointer, in pixels.
function pointerWay(m) {
  if (!m || !myPos) return null;
  const r = cv.getBoundingClientRect();
  return [m.x - r.left - SX(myPos[0]), m.y - r.top - SY(myPos[1])];
}

// The mouse steers toward the pointer, held down.
function steerToMouse() {
  if (!mouse || !myPos) return;
  const [dx, dy] = pointerWay(mouse);
  // A held button that has not moved yet may still be a click.
  if (!mouse.moved && performance.now() - mouse.at < 220) return;
  // Stopped on arrival, and off again only once the pointer is clearly away:
  // one threshold for both makes a sailor that stops and starts on every
  // twitch of the hand — and stopping here is digging in.
  const far = Math.hypot(dx, dy);
  if (far < 10) mouse.parked = true;
  else if (far > 24) mouse.parked = false;
  if (mouse.parked) shove(0, 0);
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

// Called by the kernel once it stands. Standing still is a hand too: it is how
// a sailor arrives on the raft.
function start() {
  setHand([0, 0, dashes]);
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
  const o = performance.now() - world.n * STEP_MS;
  if (stepClock === null) stepClock = o;
  else stepClock += (o - stepClock) * (o < stepClock ? 0.3 : 0.02);
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
