/**
 * @disk     flail
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    An arena brawl where you never swing: your weapon hangs on a chain and only your running whirls it. Run in circles to wind up a flail, an axe, a meteor or an anchor, turn hard to whip it, and throw it when it hums. Last one standing takes the round.
 * @tags     game, party, realtime, physics, fighting, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/flail.png
 */
// flail.js — a brawl in which the weapon is driven by the feet, and the room's
// order is the referee.
//
// Every copy holds the whole arena — every fighter, every weapon and every one
// lying loose on the floor — and moves it only on what comes back round the
// room, so every copy applies the same hands in the same order and holds the
// same arena. Nobody sends where they stand, how fast their weapon turns, who
// was hit or a score: a hand is a direction and a throw counter, and the rest
// is the same arithmetic on the same numbers on every machine. A page with a
// console open can steer its own fighter however it likes, at a fighter's own
// pace, and spin its weapon no faster than its legs can.
//
// While a fighter is alone, a bot fights with them. It is part of the arena
// like anybody, and its legs are a function of the arena alone, so it moves the
// same on every copy and says nothing over the wire. When a second fighter
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own fighter does not wait for the trip: it is drawn from the agreed
// arena played forward by the trip, with your hand already in it.
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
const HZ = 30;                 // steps of the arena a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own fighter a trip ahead, with your hand in it
const SUB = 3;                 // pieces one step is cut into, so a fast head cannot pass through a body
const DT = 1 / (HZ * SUB);

const R0 = 0.6;                // the arena's radius at the start of a round
const RMIN = 0.34;             // what the closing wall leaves at the end of one
const VIEW = 0.66;             // the half-width drawn round the arena
const PR = 0.042;              // a fighter's radius
const M_BODY = 2;              // a fighter's mass, against a weapon head's
const ACC = 3.2;               // how hard legs push
const KEEP = 0.9726;           // what one piece of a step leaves of a running fighter's speed
const KNOCK_KEEP = 0.93;       // and of one knocked faster than it can run
const RUN_BARE = 0.95;         // top speed with nothing in hand
const GHOST_V = 0.45;
const VCAP = 2.6;              // nothing moves faster than this, a knock included

// The spin. Nothing turns a weapon but its fighter's legs: turning while
// running feeds it in the way of the turn, a sudden change of pace whips it,
// running straight lets it trail, and the air takes a little of it all along.
const PUMP = 0.36;             // spin from turning on the run
const COUP = 0.6;              // spin a change of pace adds to a weapon already turning
const COUP_SLOW = 1.4;         // and swings one that hangs
const FLING = 0.7;             // a stop throws a trailing head over your shoulder
const TRAIL = 1.2;             // how a slow weapon swings round behind a runner
const DAMP = 0.5;              // spin the air takes, a second
const TUG = 0.5;               // how hard a whirling head pulls its fighter round
const CAP = 3.6;               // the fastest a head flies
const VMIN = 0.9;              // a head slower than this only taps
const ACC_MOST = 6;            // the hardest change of pace legs make, a second
const TURN_MOST = 12;          // the sharpest turn that feeds a spin, radians a second

// The weapons. `L` the chain or haft, `m` the head's mass, `r` its radius,
// `dmg` health per unit of speed past VMIN, `knock` how far a hit sends,
// `run` its fighter's top speed, `sq` the square root of `m`, written out
// because a root taken here would be a root taken on every copy.
const WEAPONS = [
  { name: 'flail', L: 0.15, m: 1, r: 0.03, dmg: 13, knock: 0.55, run: 0.8, sq: 1 },
  { name: 'axe', L: 0.11, m: 0.8, r: 0.032, dmg: 16, knock: 0.35, run: 0.84, sq: 0.894427191 },
  { name: 'meteor', L: 0.24, m: 0.55, r: 0.022, dmg: 11, knock: 0.42, run: 0.84, sq: 0.741619849 },
  { name: 'anchor', L: 0.14, m: 1.9, r: 0.038, dmg: 14, knock: 0.95, run: 0.7, sq: 1.378404875 },
];
const KINDS = WEAPONS.length;

const HP = 100;
const ARMOR = 30;              // what a trailing fighter starts a round with on top
const IFRAMES = 9;             // steps a fighter cannot be hurt again after a hit
const CREDIT_STEPS = 5 * HZ;   // a knock-out this soon after a hit is the hitter's
const RESPAWN = 2 * HZ;        // in practice, the knocked-out are back this soon
const THROW_KEEP = 0.95;       // what one step leaves of a flying weapon's speed
const SLIDE_KEEP = 0.8;        // and of one sliding on the floor
const LAND_V = 0.35;           // a thrown weapon slower than this has landed
const PICK_LOCK = 15;          // steps before a thrower can take back what it threw
const SPAWN_EVERY = 7 * HZ;
const LOOSE_MOST = 3;          // weapons lying about before more stop arriving
const ITEMS_MOST = 12;
const DROP_STEPS = 20;         // steps a new weapon takes to fall in
const HANDS_PER_STEP = 8;      // past this, a sender's hand in one step steers but cannot throw or seat
const MAX_P = 8;
const WIN_PTS = 2, KO_PTS = 1, MATCH = 8;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second fighter arrives
const PLAY_STEPS = 80 * HZ;
const END_STEPS = 6 * HZ;
const CHAMP_STEPS = 9 * HZ;
const SHRINK_FROM = 25 * HZ;   // steps into a round when the wall starts to close
const SHRINK_END = 65 * HZ;    // and when it has closed down to RMIN

// The arena. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every fighter is made by one function with its fields in one order.
//   p:  player id -> a fighter (see `fighter`)
//   it: weapons not in anybody's hand, each
//       [x, y, vx, vy, kind, owner, flying, steps until it lands, ux, uy, spin]
//   sp: steps until the next weapon falls in; R: the wall
//   res: the last round's [id, points gained, points held] rows; win/champ: ids or -1
function freshTable(seed) {
  return { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, R: R0, sp: SPAWN_EVERY, p: {}, it: [], res: null, win: -1, champ: -1 };
}

const FIELDS = ['x', 'y', 'vx', 'vy', 'dx', 'dy', 'bs', 'wk', 'ux', 'uy', 'w', 'hp', 'ar', 'al', 'ot', 'iv',
  'hb', 'ht', 'tq', 'pk', 'sc', 'rg', 'k', 'hs', 'hc'];
//   x, y, vx, vy: the body; dx, dy: the hand's direction in thousandths; bs:
//   throw counter as last heard; wk: the weapon in hand, -1 for none; ux, uy:
//   which way its head hangs from the body; w: how fast it turns, radians a
//   second; hp, ar: health and armour; al: standing; ot: the step it went
//   down; iv: the step it can be hurt again; hb, ht: who last hit it, and when;
//   tq: a throw to make; pk: the step it last threw; sc: points; rg: points
//   this round; k: seat, which is its colour; hs, hc: hands this step.
function fighter(v) {
  const s = {};
  for (const f of FIELDS) s[f] = v[f];
  return s;
}

function newFighter(w, bs) {
  return fighter({
    x: 0, y: 0, vx: 0, vy: 0, dx: 0, dy: 0, bs, wk: -1, ux: 1, uy: 0, w: 0, hp: HP, ar: 0, al: 0, ot: w.n,
    iv: 0, hb: -1, ht: 0, tq: 0, pk: -PICK_LOCK, sc: 0, rg: 0, k: freeSeat(w), hs: w.n, hc: 0,
  });
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const standingIn = (w) => playersIn(w).filter((id) => w.p[id].al);

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// Back on the floor with a weapon in hand, somewhere the arena picks.
function arm(w, d) {
  d.wk = Math.floor(draw01(w) * KINDS);
  const a = draw01(w) * TAU;
  d.ux = dcos(a);
  d.uy = dsin(a);
  d.w = 0;
}
function respawn(w, d) {
  const a = draw01(w) * TAU, r = 0.12 + draw01(w) * 0.3;
  d.x = dcos(a) * r;
  d.y = dsin(a) * r;
  d.vx = d.vy = 0;
  arm(w, d);
  d.hp = HP; d.ar = 0; d.al = 1; d.iv = w.n + IFRAMES * 3; d.hb = -1; d.ht = 0; d.tq = 0;
}

// A hand, at its place in the room's order: [dx, dy, throws] — a direction in
// thousandths and a counter that moves on by one for every throw. Being heard
// is how a fighter arrives: on the floor between rounds, a ghost during one.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = w.p[id] = newFighter(w, input[2]);
    if (w.ph === WAIT || w.ph === END) respawn(w, d);
  }
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  d.dx = input[0];
  d.dy = input[1];
  if (input[2] !== d.bs) {
    d.bs = input[2];
    // A throw is a request; whether it happens is the arena's, the same on
    // every copy, and a flood of hands in one step buys none.
    if (d.hc <= HANDS_PER_STEP && w.ph !== COUNT && d.al && d.wk >= 0) d.tq = 1;
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
  w.it = [];
  w.sp = SPAWN_EVERY;
  // Everybody round a ring, evenly, the ring turned a different way each round;
  // whoever trails the leader starts with armour on.
  const ids = playersIn(w).sort((a, b) => a - b);
  let top = 0;
  for (const id of ids) top = Math.max(top, w.p[id].sc);
  const turn = draw01(w) * TAU;
  ids.forEach((id, i) => {
    const d = w.p[id];
    respawn(w, d);
    const a = turn + (i / ids.length) * TAU;
    d.x = dcos(a) * 0.32;
    d.y = dsin(a) * 0.32;
    d.ux = dcos(a);
    d.uy = dsin(a);
    d.iv = 0;
    d.rg = 0;
    d.ar = d.sc < top ? ARMOR : 0;
  });
  fx(w, 'round');
}

function finish(w, timeUp) {
  const standing = standingIn(w);
  let win = -1;
  if (standing.length === 1) win = standing[0];
  else if (timeUp && standing.length > 1) {
    // The clock runs out on a crowd: whoever has the most left holds on.
    const life = (id) => w.p[id].hp + w.p[id].ar;
    standing.sort((a, b) => life(b) - life(a) || a - b);
    if (life(standing[0]) > life(standing[1])) win = standing[0];
  }
  if (win !== -1) {
    w.p[win].sc += WIN_PTS;
    w.p[win].rg += WIN_PTS;
  }
  w.win = win;
  const res = playersIn(w).map((id) => [id, w.p[id].rg, w.p[id].sc]);
  res.sort((a, b) => b[2] - a[2] || b[1] - a[1] || a[0] - b[0]);
  w.res = res;
  // A match is won outright: two fighters level at the top play another round.
  if (res.length && res[0][2] >= MATCH && (res.length < 2 || res[1][2] < res[0][2])) w.champ = res[0][0];
  w.ph = END;
  w.pt = w.champ !== -1 ? CHAMP_STEPS : END_STEPS;
  fx(w, 'end', 0, 0, w.win);
}

function rimAt(e) {
  if (e < SHRINK_FROM) return R0;
  if (e < SHRINK_END) return R0 - ((R0 - RMIN) * (e - SHRINK_FROM)) / (SHRINK_END - SHRINK_FROM);
  return RMIN;
}

// Where a fighter's weapon head is, and how fast it flies, on the floor.
function headOf(d) {
  const W = WEAPONS[d.wk];
  const s = W.L * d.w;
  return [d.x + d.ux * W.L, d.y + d.uy * W.L, d.vx - d.uy * s, d.vy + d.ux * s];
}

function dropWeapon(w, d, flying, owner, keep) {
  if (d.wk < 0) return;
  const [hx, hy, hvx, hvy] = headOf(d);
  if (w.it.length < ITEMS_MOST) {
    w.it.push([hx, hy, hvx * keep, hvy * keep, d.wk, owner, flying, 0, d.ux, d.uy, d.w * 0.6]);
  }
  d.wk = -1;
  d.w = 0;
}

function knockOut(w, id, d) {
  d.al = 0;
  d.ot = w.n;
  d.hp = 0;
  d.ar = 0;
  d.tq = 0;
  fx(w, 'ko', d.x, d.y, id, d.hb);
  dropWeapon(w, d, 0, -1, 0.4);
  if (w.ph !== PLAY) return;
  const by = d.hb;
  if (by !== id && w.p[by] && w.n - d.ht <= CREDIT_STEPS) {
    w.p[by].sc += KO_PTS;
    w.p[by].rg += KO_PTS;
    fx(w, 'point', d.x, d.y, by, id);
  }
}

// Something flying at `vx, vy` from `x, y` meets fighter `vid`. The approach
// along the line between them decides: past VMIN it is a hit and hurts by the
// weapon's measure, slower it only taps. Returns how fast it came in, or 0 for
// nothing at all.
function strike(w, by, vid, x, y, vx, vy, W, r) {
  const v = w.p[vid];
  const nx0 = v.x - x, ny0 = v.y - y, dd = nx0 * nx0 + ny0 * ny0, reach = PR + r;
  if (dd >= reach * reach) return 0;
  const dist = Math.sqrt(dd), nx = dist > 1e-9 ? nx0 / dist : 1, ny = dist > 1e-9 ? ny0 / dist : 0;
  const s = (vx - v.vx) * nx + (vy - v.vy) * ny;
  if (s <= 0.12) return 0;
  // The weapon is rigid to its fighter: whoever it rests on is pushed aside.
  v.x += nx * (reach - dist) * 0.5;
  v.y += ny * (reach - dist) * 0.5;
  if (s < VMIN || w.n < v.iv) {
    v.vx += nx * s * 0.25;
    v.vy += ny * s * 0.25;
    fx(w, 'tap', x + nx * r, y + ny * r, vid);
    return s;
  }
  const dmg = Math.max(1, Math.round((s - VMIN) * W.dmg));
  const kick = s * W.knock;
  v.vx += nx * kick;
  v.vy += ny * kick;
  v.iv = w.n + IFRAMES;
  v.hb = by;
  v.ht = w.n;
  const soak = Math.min(v.ar, dmg);
  v.ar -= soak;
  v.hp = Math.max(0, v.hp - (dmg - soak));
  fx(w, 'hit', x + nx * r, y + ny * r, vid, by, dmg);
  if (v.hp <= 0) knockOut(w, vid, v);
  return s;
}

// A weapon's head bounces off something: it turns back the way it came,
// slower.
function rebound(d, k) {
  d.w = -d.w * k;
}

function clampSpeed(o, top) {
  const v = Math.sqrt(o.vx * o.vx + o.vy * o.vy);
  if (v > top) { o.vx = (o.vx / v) * top; o.vy = (o.vy / v) * top; }
}

// One piece of a step: legs, spin, walls, bodies, heads and loose weapons.
function physics(w, ids) {
  const R = w.R;
  for (const id of ids) {
    const d = w.p[id];
    const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy);
    const moving = len > 60;
    const ix = moving ? d.dx / len : 0, iy = moving ? d.dy / len : 0;
    if (!d.al) {
      // A ghost drifts over everything and touches nothing.
      d.x += ix * GHOST_V * DT;
      d.y += iy * GHOST_V * DT;
      const gr = Math.sqrt(d.x * d.x + d.y * d.y);
      if (gr > VIEW - 0.04) { d.x = (d.x / gr) * (VIEW - 0.04); d.y = (d.y / gr) * (VIEW - 0.04); }
      continue;
    }
    const W = d.wk >= 0 ? WEAPONS[d.wk] : null;
    const ovx = d.vx, ovy = d.vy, top = W ? W.run : RUN_BARE;
    const v0 = Math.sqrt(ovx * ovx + ovy * ovy);
    d.vx += ix * ACC * DT;
    d.vy += iy * ACC * DT;
    if (W) {
      // A whirling head pulls its fighter toward it, the heavier the harder.
      const tug = (W.m / M_BODY) * W.L * d.w * d.w * TUG;
      d.vx += d.ux * tug * DT;
      d.vy += d.uy * tug * DT;
    }
    // Legs never carry a fighter past its top speed, and a knock that did
    // dies away quickly rather than being cut off where it lands.
    const keep = v0 > top ? KNOCK_KEEP : KEEP;
    d.vx *= keep;
    d.vy *= keep;
    clampSpeed(d, Math.max(top, v0 * keep));
    d.x += d.vx * DT;
    d.y += d.vy * DT;
    if (!W) continue;

    // What turns the weapon is what the legs did, so a change of pace is
    // capped at what legs can do: a knock taken is not a spin given.
    let ax = (d.vx - ovx) / DT, ay = (d.vy - ovy) / DT;
    const al = Math.sqrt(ax * ax + ay * ay);
    if (al > ACC_MOST) { ax = (ax / al) * ACC_MOST; ay = (ay / al) * ACC_MOST; }
    const tx = -d.uy, ty = d.ux, spd = Math.abs(d.w) * W.L;
    const sign = d.w >= 0 ? 1 : -1;
    const kick = -(ax * tx + ay * ty) / W.L;
    let wd;
    if (spd < 0.4) {
      wd = COUP_SLOW * kick;
      // Stopping with the head behind you throws it over your shoulder.
      const au = ax * d.ux + ay * d.uy;
      if (au > 0) wd += (FLING * au * sign) / W.L;
    } else {
      wd = COUP * Math.abs(kick) * sign;
    }
    wd -= (TRAIL * (d.vx * tx + d.vy * ty)) / W.L / (1 + spd * spd);
    const vo = Math.sqrt(ovx * ovx + ovy * ovy), vn = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    if (vo > 0.05 && vn > 0.05) {
      const turn = Math.max(-TURN_MOST, Math.min(TURN_MOST, (ovx * d.vy - ovy * d.vx) / (vo * vn) / DT));
      wd += (PUMP * turn * vn) / W.L / W.sq;
    }
    wd -= DAMP * d.w;
    d.w += wd * DT;
    const most = CAP / W.L;
    if (d.w > most) d.w = most;
    else if (d.w < -most) d.w = -most;
    const a = d.w * DT, c = dcos(a), s = dsin(a);
    const nux = d.ux * c - d.uy * s, nuy = d.ux * s + d.uy * c;
    const ul = Math.sqrt(nux * nux + nuy * nuy) || 1;
    d.ux = nux / ul;
    d.uy = nuy / ul;
  }

  // Bodies stay inside the wall; a weapon that meets the wall rings off it and
  // pushes its fighter back, because a haft or a taut chain does not bend.
  for (const id of ids) {
    const d = w.p[id];
    if (!d.al) continue;
    let r = Math.sqrt(d.x * d.x + d.y * d.y);
    if (r > R - PR) {
      const nx = d.x / r, ny = d.y / r;
      d.x = nx * (R - PR);
      d.y = ny * (R - PR);
      const vr = d.vx * nx + d.vy * ny;
      if (vr > 0) { d.vx -= nx * vr * 1.4; d.vy -= ny * vr * 1.4; }
      r = R - PR;
    }
    if (d.wk < 0) continue;
    const W = WEAPONS[d.wk];
    const [hx, hy, hvx, hvy] = headOf(d);
    const hr = Math.sqrt(hx * hx + hy * hy);
    if (hr > R - W.r) {
      const nx = hx / hr, ny = hy / hr, out = hvx * nx + hvy * ny, over = hr - (R - W.r);
      d.x -= nx * over;
      d.y -= ny * over;
      if (out > 0) {
        if (out > VMIN) fx(w, 'wall', nx * R, ny * R, id, Math.min(9, Math.round(out * 2)));
        rebound(d, 0.45);
      }
    }
  }

  // Bodies bump bodies.
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = w.p[ids[i]], b = w.p[ids[j]];
    if (!a.al || !b.al) continue;
    const dx = b.x - a.x, dy = b.y - a.y, dd = dx * dx + dy * dy, m = 2 * PR;
    if (dd >= m * m) continue;
    const dist = Math.sqrt(dd), nx = dist > 1e-9 ? dx / dist : 1, ny = dist > 1e-9 ? dy / dist : 0, over = (m - dist) / 2;
    a.x -= nx * over; a.y -= ny * over;
    b.x += nx * over; b.y += ny * over;
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn < 0) {
      const j2 = -0.8 * vn;
      a.vx -= nx * j2; a.vy -= ny * j2;
      b.vx += nx * j2; b.vy += ny * j2;
    }
  }

  // Heads meet bodies, and heads meet heads.
  for (const id of ids) {
    const d = w.p[id];
    if (!d.al || d.wk < 0) continue;
    const W = WEAPONS[d.wk];
    for (const vid of ids) {
      if (vid === id || !w.p[vid].al || d.wk < 0 || !d.al) continue;
      const [hx, hy, hvx, hvy] = headOf(d);
      const s = strike(w, id, vid, hx, hy, hvx, hvy, W, W.r);
      if (s >= VMIN) rebound(d, 0.25);
      else if (s > 0) rebound(d, 0.5);
    }
  }
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = w.p[ids[i]], b = w.p[ids[j]];
    if (!a.al || !b.al || a.wk < 0 || b.wk < 0) continue;
    const A = WEAPONS[a.wk], B = WEAPONS[b.wk];
    const ha = headOf(a), hb = headOf(b);
    const dx = hb[0] - ha[0], dy = hb[1] - ha[1], dd = dx * dx + dy * dy, m = A.r + B.r;
    if (dd >= m * m) continue;
    const dist = Math.sqrt(dd), nx = dist > 1e-9 ? dx / dist : 1, ny = dist > 1e-9 ? dy / dist : 0;
    const s = (ha[2] - hb[2]) * nx + (ha[3] - hb[3]) * ny;
    if (s <= 0.2) continue;
    // A clash: both heads turn back, the lighter one more.
    const k = A.m / (A.m + B.m);
    rebound(a, 0.2 + 0.5 * k);
    rebound(b, 0.7 - 0.5 * k);
    if (s > 0.6) fx(w, 'clang', (ha[0] + hb[0]) / 2, (ha[1] + hb[1]) / 2, Math.min(9, Math.round(s * 2)), ids[i], ids[j]);
  }

  // Loose weapons: thrown ones fly and hurt, landed ones slide to a stop.
  for (const it of w.it) {
    if (it[7] > 0) continue;
    const W = WEAPONS[it[4]];
    it[0] += it[2] * DT;
    it[1] += it[3] * DT;
    const a = it[10] * DT, c = dcos(a), s = dsin(a);
    const nux = it[8] * c - it[9] * s, nuy = it[8] * s + it[9] * c, ul = Math.sqrt(nux * nux + nuy * nuy) || 1;
    it[8] = nux / ul;
    it[9] = nuy / ul;
    const r = Math.sqrt(it[0] * it[0] + it[1] * it[1]);
    if (r > R - W.r) {
      const nx = it[0] / r, ny = it[1] / r, vr = it[2] * nx + it[3] * ny;
      it[0] = nx * (R - W.r);
      it[1] = ny * (R - W.r);
      if (vr > 0) {
        it[2] -= nx * vr * 1.6;
        it[3] -= ny * vr * 1.6;
        if (it[6] && vr > VMIN) fx(w, 'wall', nx * R, ny * R, it[5], Math.min(9, Math.round(vr * 2)));
      }
    }
    if (!it[6]) continue;
    for (const vid of ids) {
      if (vid === it[5] || !w.p[vid].al) continue;
      const hit = strike(w, it[5], vid, it[0], it[1], it[2], it[3], W, W.r);
      if (hit > 0) { it[2] *= -0.3; it[3] *= -0.3; it[10] = -it[10]; }
    }
    // A whirling head bats a thrown weapon away, and makes it its own.
    for (const id of ids) {
      const d = w.p[id];
      if (!d.al || d.wk < 0 || id === it[5]) continue;
      const D = WEAPONS[d.wk];
      const [hx, hy, hvx, hvy] = headOf(d);
      const dx = it[0] - hx, dy = it[1] - hy, dd = dx * dx + dy * dy, m = W.r + D.r;
      if (dd >= m * m) continue;
      const dist = Math.sqrt(dd), nx = dist > 1e-9 ? dx / dist : 1, ny = dist > 1e-9 ? dy / dist : 0;
      const sIn = (hvx - it[2]) * nx + (hvy - it[3]) * ny;
      if (sIn <= 0) continue;
      it[2] += nx * sIn * 1.6;
      it[3] += ny * sIn * 1.6;
      it[5] = id;
      rebound(d, 0.5);
      fx(w, 'clang', (it[0] + hx) / 2, (it[1] + hy) / 2, Math.min(9, Math.round(sIn * 2)), id, -9);
    }
  }
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions: slow enough to be beaten
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot stands in the arena while it waits for a round, and goes the moment
// a round's countdown starts.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && Object.keys(w.p).length < MAX_P) {
    respawn(w, (w.p[BOT_ID] = newFighter(w, 0)));
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

function steer(d, x, y) {
  const l = Math.sqrt(x * x + y * y);
  if (l < 1e-6) { d.dx = d.dy = 0; return; }
  d.dx = Math.round((x / l) * 1000);
  d.dy = Math.round((y / l) * 1000);
}

// The bot's legs: unarmed, it runs for the nearest weapon on the floor; armed,
// it circles you to wind its weapon up, closes in once it hums, and now and
// then throws it. Every so often it only stands there, so it can be caught out.
function botLegs(w) {
  const d = w.p[BOT_ID];
  if (!d || !d.al || w.n % BOT_EVERY) return;
  if (draw01(w) < 0.18) { steer(d, 0, 0); return; }
  if (d.wk < 0) {
    let best = null, bd = 1e9;
    for (const it of w.it) {
      if (it[6] || it[7]) continue;
      const qx = it[0] - d.x, qy = it[1] - d.y, q = qx * qx + qy * qy;
      if (q < bd) { bd = q; best = it; }
    }
    if (best) steer(d, best[0] - d.x, best[1] - d.y); else steer(d, -d.x, -d.y);
    return;
  }
  let you = null, yd = 1e9;
  for (const id of humans(w).sort((a, b) => a - b)) {
    const h = w.p[id];
    if (!h.al) continue;
    const qx = h.x - d.x, qy = h.y - d.y, q = qx * qx + qy * qy;
    if (q < yd) { yd = q; you = h; }
  }
  if (!you) { steer(d, -d.x, -d.y); return; }
  const W = WEAPONS[d.wk];
  const vx = you.x - d.x, vy = you.y - d.y, dist = Math.sqrt(vx * vx + vy * vy) || 1e-6;
  const spd = Math.abs(d.w) * W.L;
  if (spd > 2.6 && dist > 0.22 && dist < 0.48 && draw01(w) < 0.06) { d.tq = 1; return; }
  if (spd > 2.2 && dist < W.L + 0.25) { steer(d, vx, vy); return; }
  // Round you, a little further out than its weapon reaches, the way it spins,
  // and away from the wall.
  const orbit = W.L + 0.16, way = d.w < 0 ? -1 : 1;
  const tx = (-vy / dist) * way, ty = (vx / dist) * way, pull = Math.max(-1, Math.min(1, (dist - orbit) * 5));
  let sx = tx + (vx / dist) * pull, sy = ty + (vy / dist) * pull;
  const r = Math.sqrt(d.x * d.x + d.y * d.y);
  if (r > w.R * 0.8) { sx -= (d.x / r) * 1.5; sy -= (d.y / r) * 1.5; }
  steer(d, sx, sy);
}

// One step of the arena: a function of the arena alone.
function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second fighter ends practice, three seconds on: the count runs in pt,
    // which a waiting arena otherwise leaves at zero. The bot goes first, so
    // the round's ring is laid out without it.
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
      if (w.pt <= 0) finish(w, true);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  if (w.ph === PLAY) w.R = rimAt(PLAY_STEPS - w.pt);

  const ids = playersIn(w).sort((a, b) => a - b);
  // In practice the knocked-out are back on their feet in a moment.
  if (w.ph === WAIT) for (const id of ids) {
    const d = w.p[id];
    if (!d.al && w.n - d.ot >= RESPAWN) { respawn(w, d); fx(w, 'back', d.x, d.y, id); }
  }
  if (w.ph === COUNT) return;

  // A weapon falls in every so often, while few lie about.
  if (w.ph === WAIT || w.ph === PLAY) {
    if (--w.sp <= 0) {
      w.sp = SPAWN_EVERY;
      let loose = 0;
      for (const it of w.it) if (!it[6]) loose += 1;
      if (loose < LOOSE_MOST && w.it.length < ITEMS_MOST) {
        const a = draw01(w) * TAU, r = draw01(w) * w.R * 0.7, kind = Math.floor(draw01(w) * KINDS);
        w.it.push([dcos(a) * r, dsin(a) * r, 0, 0, kind, -1, 0, DROP_STEPS, dcos(a + 1), dsin(a + 1), 0]);
      }
    }
  }
  for (const it of w.it) if (it[7] > 0 && --it[7] === 0) fx(w, 'land', it[0], it[1], it[4]);

  botLegs(w);

  // Throws: the head lets go at the speed it was flying, with a flick on top.
  for (const id of ids) {
    const d = w.p[id];
    if (!d.tq) continue;
    d.tq = 0;
    if (!d.al || d.wk < 0) continue;
    const [hx, hy, hvx, hvy] = headOf(d);
    const W = WEAPONS[d.wk];
    const flick = 0.5 + 0.2 * Math.min(1, Math.abs(d.w) * W.L);
    if (w.it.length < ITEMS_MOST) {
      const it = [hx, hy, hvx * 1.2 + d.ux * flick, hvy * 1.2 + d.uy * flick, d.wk, id, 1, 0, d.ux, d.uy, d.w * 0.6 + 6];
      const v = Math.sqrt(it[2] * it[2] + it[3] * it[3]);
      if (v > 5) { it[2] = (it[2] / v) * 5; it[3] = (it[3] / v) * 5; }
      w.it.push(it);
    }
    fx(w, 'throw', hx, hy, id, Math.min(9, Math.round(Math.sqrt(hvx * hvx + hvy * hvy) * 2)));
    d.wk = -1;
    d.w = 0;
    d.pk = w.n;
  }

  for (let s = 0; s < SUB; s++) physics(w, ids);

  // Loose weapons slow down; a thrown one lands once it is slow enough. Nothing
  // flies faster than VCAP, a knock included.
  for (const it of w.it) {
    if (it[7] > 0) continue;
    const keep = it[6] ? THROW_KEEP : SLIDE_KEEP;
    it[2] *= keep;
    it[3] *= keep;
    it[10] *= it[6] ? 0.97 : 0.8;
    const v = Math.sqrt(it[2] * it[2] + it[3] * it[3]);
    if (v > 5) { it[2] = (it[2] / v) * 5; it[3] = (it[3] / v) * 5; }
    if (it[6] && v < LAND_V) { it[6] = 0; fx(w, 'land', it[0], it[1], it[4]); }
    if (!it[6] && v < 0.01) { it[2] = it[3] = it[10] = 0; }
  }
  for (const id of ids) {
    const d = w.p[id];
    clampSpeed(d, VCAP);
    // Empty hands pick up whatever lies under them.
    if (!d.al || d.wk >= 0) continue;
    for (let i = 0; i < w.it.length; i++) {
      const it = w.it[i];
      if (it[6] || it[7] || (it[5] === id && w.n - d.pk < PICK_LOCK)) continue;
      const dx = it[0] - d.x, dy = it[1] - d.y, dd = dx * dx + dy * dy, m = PR + 0.04;
      if (dd >= m * m) continue;
      const dist = Math.sqrt(dd);
      d.wk = it[4];
      d.ux = dist > 1e-6 ? dx / dist : 1;
      d.uy = dist > 1e-6 ? dy / dist : 0;
      d.w = 0;
      w.it.splice(i, 1);
      fx(w, 'pick', d.x, d.y, id, d.wk);
      break;
    }
  }

  if (w.ph === PLAY && standingIn(w).length <= 1) finish(w, false);
}

// An arena handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;
const SPIN_MOST = CAP / 0.11 + 1;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!num(raw.R, RMIN, R0) || !int(raw.sp, 0, SPAWN_EVERY)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!num(d.x, -1, 1) || !num(d.y, -1, 1) || !num(d.vx, -VCAP, VCAP) || !num(d.vy, -VCAP, VCAP)) return null;
    if (!num(d.ux, -1.001, 1.001) || !num(d.uy, -1.001, 1.001) || !num(d.w, -SPIN_MOST, SPIN_MOST)) return null;
    if (inputOf([d.dx, d.dy, d.bs]) === null || !int(d.wk, -1, KINDS - 1)) return null;
    if (!int(d.hp, 0, HP) || !int(d.ar, 0, ARMOR)) return null;
    for (const k of ['al', 'tq']) if (d[k] !== 0 && d[k] !== 1) return null;
    if (!int(d.k, 0, MAX_P - 1) || seats.has(d.k)) return null;
    seats.add(d.k);
    for (const k of ['ot', 'iv', 'hb', 'ht', 'pk', 'hs']) if (!int(d[k], -BIG, BIG)) return null;
    if (!int(d.sc, 0, 9999) || !int(d.rg, 0, 9999) || !int(d.hc, 0, BIG)) return null;
    p[id] = fighter(d);
  }
  if (!Array.isArray(raw.it) || raw.it.length > ITEMS_MOST) return null;
  const it = [];
  for (const v of raw.it) {
    if (!Array.isArray(v) || v.length !== 11) return null;
    if (!num(v[0], -1, 1) || !num(v[1], -1, 1) || !num(v[2], -5, 5) || !num(v[3], -5, 5)) return null;
    if (!int(v[4], 0, KINDS - 1) || !int(v[5], -BIG, BIG) || (v[6] !== 0 && v[6] !== 1) || !int(v[7], 0, DROP_STEPS)) return null;
    if (!num(v[8], -1.001, 1.001) || !num(v[9], -1.001, 1.001) || !num(v[10], -60, 60)) return null;
    it.push(v.slice());
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
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, R: raw.R, sp: raw.sp, p, it, res, win: raw.win, champ: raw.champ };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed arena steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a dusk-violet stone arena in a dark pit, steel weapons, and a
// colour for each seat that is the fighter's, its weapon's grip and its chip's
// on the scoreboard.
const INK = {
  page: '#16122a', pitTop: '#1d1836', pitLow: '#0f0c1f', floor: '#3a3256', floorIn: '#433a63', tile: 'rgba(255,255,255,0.045)',
  wall: '#6c5d96', wallDark: '#3f3560', stud: '#9c8fc8', ghost: 'rgba(170,150,230,0.25)', steel: '#d6dbe8',
  steelDark: '#7d8599', iron: '#3d4150', wood: '#9a6a3c', text: '#f1edfb', muted: '#b4abd3', dim: '#7d74a0',
  gold: '#ffd166', danger: '#ff5d6c', armor: '#7fd6ff', panel: 'rgba(16,12,32,0.92)', hp: '#6ee7a0', spark: '#fff2b8',
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a3f72;' +
  `background:#241d42;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
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

// The arena to the screen and back.
const SX = (x) => cx + x * sc;
const SY = (y) => cy + y * sc;
function inField() {
  ctx.setTransform(dpx, 0, 0, dpx, 0, 0);
  ctx.translate(cx + shakeX, cy + shakeY);
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
  whoosh(k) { if (ready('whoosh', 90)) puff(0.12, 0.04 + 0.08 * k, 700 + 1600 * k, 0, 1.6); },
  hit(v, mine) {
    if (!ready('hit', 60)) return;
    const k = mine ? 1 : 0.6;
    tone(170, 0.16, 'square', (0.05 + 0.08 * v) * k, 0.4);
    puff(0.1, (0.08 + 0.14 * v) * k, 900, 0, 0.9);
  },
  tap() { if (ready('tap', 90)) tone(240, 0.06, 'sine', 0.05, 0.6); },
  clang(v) {
    if (!ready('clang', 70)) return;
    tone(1250 + 300 * v, 0.28, 'triangle', 0.05 + 0.04 * v, 0.96);
    tone(1870 + 400 * v, 0.22, 'sine', 0.03 + 0.03 * v, 0.97);
    puff(0.05, 0.08, 4200);
  },
  wall(v) { if (ready('wall', 90)) { tone(110, 0.14, 'square', 0.04 + 0.04 * v, 0.6); puff(0.08, 0.07, 600); } },
  ko(mine) {
    if (!ready('ko', 150)) return;
    const k = mine ? 1 : 0.7;
    tone(300, 0.5, 'sawtooth', 0.07 * k, 0.25);
    puff(0.35, 0.16 * k, 380, 0, 0.7);
  },
  ding() { if (ready('ding', 80)) { tone(880, 0.1, 'triangle', 0.12); tone(1320, 0.18, 'triangle', 0.1, 0, 0.07); } },
  throwIt() { if (ready('throw', 100)) { puff(0.2, 0.12, 1300, 0, 0.8); tone(520, 0.16, 'sine', 0.04, 1.6); } },
  pick() { if (ready('pick', 80)) { tone(420, 0.07, 'square', 0.04); tone(640, 0.09, 'square', 0.035, 0, 0.06); } },
  land() { if (ready('land', 100)) { tone(150, 0.1, 'square', 0.04, 0.7); puff(0.06, 0.05, 700); } },
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
const bits = [];      // { x, y, vx, vy, life, max, size, colour } in arena units
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 16 + Math.random() * 20, size, colour });
  }
  if (bits.length > 500) bits.splice(0, bits.length - 500);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 55, px: px || 16, lift: lift || 16 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 22, r }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.92; b.vy *= 0.92;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    for (const look of looks.values()) { look.squash *= 0.86; look.flash *= 0.85; }
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();   // id -> { squash, flash, seen }
let drawFailed = false;

function lookOf(id) {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { squash: 0, flash: 0, seen: 0 }));
  l.seen = performance.now();
  return l;
}
function colourOf(t, id) {
  const d = t.p[id];
  return d ? SEAT[d.k] : '#dddddd';
}
const whoOf = (id) => (id === myId() ? 'you' : nickOf(id));

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  if (e.kind === 'hit') {
    const v = Math.min(1, e.c / 30);
    spray(e.x, e.y, 6 + Math.round(v * 14), INK.spark, 0.5 + v * 0.8, 0.008);
    spray(e.x, e.y, 4 + Math.round(v * 6), colourOf(t, e.a), 0.4 + v * 0.5, 0.01);
    ring(e.x, e.y, '#ffffff', 0.05 + v * 0.07);
    const lk = lookOf(e.a);
    lk.squash = 1;
    lk.flash = 1;
    pop(e.x, e.y - 0.02, '-' + e.c, e.c >= 25 ? INK.danger : '#ffffff', 13 + v * 9, 22 + v * 14);
    const mine = e.a === me || e.b === me;
    if (e.a === me) shake = Math.max(shake, 5 + v * 9);
    else if (e.b === me) shake = Math.max(shake, 2 + v * 4);
    sound.hit(v, mine);
  } else if (e.kind === 'tap') {
    lookOf(e.a).squash = Math.max(lookOf(e.a).squash, 0.4);
    sound.tap();
  } else if (e.kind === 'clang') {
    spray(e.x, e.y, 6 + e.a * 2, INK.spark, 0.4 + e.a * 0.08, 0.007);
    ring(e.x, e.y, INK.spark, 0.04 + e.a * 0.006);
    if (e.b === me || e.c === me) shake = Math.max(shake, 2 + e.a * 0.5);
    sound.clang(Math.min(1, e.a / 8));
  } else if (e.kind === 'wall') {
    spray(e.x, e.y, 3 + e.b, INK.stud, 0.3 + e.b * 0.05, 0.007);
    if (e.a === me) shake = Math.max(shake, 1.5 + e.b * 0.4);
    sound.wall(Math.min(1, e.b / 8));
  } else if (e.kind === 'ko') {
    const colour = colourOf(t, e.a);
    spray(e.x, e.y, 30, colour, 0.9, 0.012);
    spray(e.x, e.y, 16, '#ffffff', 0.6, 0.008);
    ring(e.x, e.y, colour, 0.16);
    pop(e.x, e.y - 0.04, e.a === me ? 'knocked out!' : 'K.O.', colour, e.a === me ? 22 : 18, 34);
    if (e.a === me) shake = Math.max(shake, 14);
    sound.ko(e.a === me);
  } else if (e.kind === 'point') {
    pop(e.x, e.y + 0.06, '+1 ' + whoOf(e.a), colourOf(t, e.a), 16, 44);
    if (e.a === me) sound.ding();
  } else if (e.kind === 'throw') {
    spray(e.x, e.y, 5 + e.b, '#ffffff', 0.4, 0.006);
    if (e.a !== me) sound.throwIt();
  } else if (e.kind === 'pick') {
    ring(e.x, e.y, colourOf(t, e.a), PR * 2.4);
    pop(e.x, e.y - 0.05, WEAPONS[e.b].name + '!', colourOf(t, e.a), e.a === me ? 16 : 12, 22);
    if (e.a === me) sound.pick();
  } else if (e.kind === 'land') {
    spray(e.x, e.y, 6, INK.stud, 0.25, 0.006);
    sound.land();
  } else if (e.kind === 'back') {
    ring(e.x, e.y, colourOf(t, e.a), PR * 2.6);
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    if (md || e.a === me) sound.end(e.a === me);
  }
}

// The pit round the arena: a dark gradient and a few slow embers, drawn from
// the clock alone.
function drawPit(now) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.pitTop);
  g.addColorStop(1, INK.pitLow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  const tt = now / 1000;
  for (let i = 0; i < 18; i++) {
    const x = ((i * 97.3 + tt * (6 + (i % 5) * 2)) % (VW + 40)) - 20;
    const y = VH - (((i * 53.7 + tt * (10 + (i % 7) * 3)) % (VH + 40)) - 20);
    ctx.fillStyle = `rgba(255,${150 + (i % 4) * 20},90,${0.08 + 0.06 * Math.sin(tt * 2 + i)})`;
    ctx.fillRect(x, y, 2, 2);
  }
}

function drawArena(R, now) {
  inField();
  // Where the wall stood at the start of the round.
  if (R < R0 - 0.005) {
    ctx.strokeStyle = INK.ghost;
    ctx.lineWidth = 0.006;
    ctx.setLineDash([0.02, 0.025]);
    disc(0, 0, R0);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  disc(0, 0.02, R + 0.03);
  ctx.fill();
  const g = ctx.createRadialGradient(0, -R * 0.2, R * 0.1, 0, 0, R);
  g.addColorStop(0, INK.floorIn);
  g.addColorStop(1, INK.floor);
  ctx.fillStyle = g;
  disc(0, 0, R);
  ctx.fill();
  // Flagstones: rings and spokes.
  ctx.save();
  disc(0, 0, R);
  ctx.clip();
  ctx.strokeStyle = INK.tile;
  ctx.lineWidth = 0.004;
  for (let r = 0.12; r < R0; r += 0.12) { disc(0, 0, r); ctx.stroke(); }
  for (let ri = 0, r = 0; r < R0; ri++, r += 0.12) {
    const n = 6 + ri * 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ri * 0.4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a) * (r + 0.12), Math.sin(a) * (r + 0.12));
      ctx.stroke();
    }
  }
  ctx.restore();
  // The emblem in the middle.
  ctx.strokeStyle = 'rgba(255,209,102,0.10)';
  ctx.lineWidth = 0.008;
  disc(0, 0, 0.07);
  ctx.stroke();
  // The wall, studded; it glows while it closes in.
  const closing = R < R0 - 0.005 && R > RMIN + 0.005;
  ctx.lineWidth = 0.03;
  ctx.strokeStyle = INK.wallDark;
  disc(0, 0, R + 0.015);
  ctx.stroke();
  ctx.lineWidth = 0.014;
  ctx.strokeStyle = closing ? `rgba(255,93,108,${0.55 + 0.3 * Math.sin(now / 160)})` : INK.wall;
  disc(0, 0, R + 0.008);
  ctx.stroke();
  ctx.fillStyle = INK.stud;
  const studs = Math.round(R * 60);
  for (let i = 0; i < studs; i++) {
    const a = (i / studs) * Math.PI * 2;
    disc(Math.cos(a) * (R + 0.02), Math.sin(a) * (R + 0.02), 0.005);
    ctx.fill();
  }
}

// A weapon's head, drawn at `x, y`, turned so its edge leads: `ax, ay` is the
// way from the hand to it, `way` the way it turns.
function drawHead(kind, x, y, ax, ay, way, colour, spin) {
  const W = WEAPONS[kind];
  const r = W.r;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(ay, ax));
  if (kind === 0) {
    // A spiked ball.
    ctx.rotate(spin || 0);
    ctx.fillStyle = INK.steelDark;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a - 0.3) * r * 0.8, Math.sin(a - 0.3) * r * 0.8);
      ctx.lineTo(Math.cos(a) * r * 1.45, Math.sin(a) * r * 1.45);
      ctx.lineTo(Math.cos(a + 0.3) * r * 0.8, Math.sin(a + 0.3) * r * 0.8);
      ctx.fill();
    }
    ctx.fillStyle = INK.steel;
    disc(0, 0, r);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    disc(-r * 0.3, -r * 0.3, r * 0.3);
    ctx.fill();
  } else if (kind === 1) {
    // An axe: a crescent blade across the end of the haft, its edge leading.
    ctx.scale(1, way < 0 ? -1 : 1);
    ctx.fillStyle = INK.steel;
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, 0);
    ctx.lineTo(-r * 0.3, r * 0.5);
    ctx.quadraticCurveTo(r * 1.4, r * 1.9, r * 0.9, r * 0.1);
    ctx.quadraticCurveTo(r * 1.1, -r * 0.4, r * 0.2, -r * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = r * 0.18;
    ctx.beginPath();
    ctx.moveTo(-r * 0.25, r * 0.55);
    ctx.quadraticCurveTo(r * 1.35, r * 1.85, r * 0.9, r * 0.15);
    ctx.stroke();
    ctx.fillStyle = INK.iron;
    disc(0, 0, r * 0.32);
    ctx.fill();
  } else if (kind === 2) {
    // A meteor: a small heavy ball with a ribbon in its fighter's colour.
    ctx.strokeStyle = colour;
    ctx.lineWidth = r * 0.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, 0);
    ctx.quadraticCurveTo(-r * 1.6, r * 1.2 * (way < 0 ? -1 : 1), -r * 2.6, r * 0.4 * (way < 0 ? -1 : 1));
    ctx.stroke();
    ctx.lineCap = 'butt';
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#8e97ad');
    ctx.fillStyle = g;
    disc(0, 0, r);
    ctx.fill();
  } else {
    // An anchor: a shank, a crown and two flukes, in dark iron.
    ctx.fillStyle = INK.iron;
    ctx.strokeStyle = '#5c6274';
    ctx.lineWidth = r * 0.42;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-r * 0.9, 0);
    ctx.lineTo(r * 0.6, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-r * 0.1, 0, r * 0.9, -1.25, 1.25);
    ctx.stroke();
    ctx.lineCap = 'butt';
    for (const s of [-1, 1]) {
      const fx_ = Math.cos(1.25 * s) * r * 0.9 - r * 0.1, fy = Math.sin(1.25 * s) * r * 0.9;
      ctx.beginPath();
      ctx.moveTo(fx_ + r * 0.1, fy);
      ctx.lineTo(fx_ - r * 0.55, fy + s * r * 0.15);
      ctx.lineTo(fx_ - r * 0.1, fy - s * r * 0.45);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#7b8194';
    disc(r * 0.75, 0, r * 0.28);
    ctx.fill();
  }
  ctx.restore();
}

// The chain or haft from a fighter's body to its head. A slow chain sags away
// from the way it turns; a fast one is drawn taut.
function drawLink(kind, bx, by, hx, hy, way, spd, colour) {
  const W = WEAPONS[kind];
  const dx = hx - bx, dy = hy - by, l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const sx = bx + ux * PR * 0.8, sy = by + uy * PR * 0.8;
  if (kind === 1) {
    ctx.strokeStyle = INK.wood;
    ctx.lineWidth = 0.011;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 0.013;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + ux * 0.022, sy + uy * 0.022);
    ctx.stroke();
    ctx.lineCap = 'butt';
    return;
  }
  const sag = (W.L * 0.3) / (1 + spd * spd * 1.5);
  const mx = (sx + hx) / 2 + uy * sag * way, my = (sy + hy) / 2 - ux * sag * way;
  const n = Math.max(4, Math.round(W.L / 0.016));
  ctx.fillStyle = kind === 3 ? '#8c92a6' : INK.steelDark;
  for (let i = 1; i < n; i++) {
    const k = i / n, a = (1 - k) * (1 - k), b = 2 * (1 - k) * k, c = k * k;
    disc(a * sx + b * mx + c * hx, a * sy + b * my + c * hy, kind === 3 ? 0.0065 : 0.005);
    ctx.fill();
  }
  ctx.fillStyle = colour;
  disc(sx, sy, 0.009);
  ctx.fill();
}

// A whirl leaves a fading arc behind its head, longer and brighter the faster
// it goes, and red once it is fast enough to hurt.
function drawTrail(bx, by, ax, ay, kind, wSpin, alpha) {
  const W = WEAPONS[kind];
  const spd = Math.abs(wSpin) * W.L;
  if (spd < 0.5) return;
  const a = Math.atan2(ay, ax), span = Math.min(2.2, Math.abs(wSpin) * 0.07);
  const k = Math.min(1, (spd - 0.5) / (CAP - 0.5));
  const hot = spd >= VMIN;
  const steps = 6;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < steps; i++) {
    const a0 = a - Math.sign(wSpin) * (span * i) / steps, a1 = a - Math.sign(wSpin) * (span * (i + 1)) / steps;
    ctx.globalAlpha = alpha * (0.5 * k + 0.12) * (1 - i / steps);
    ctx.strokeStyle = hot ? (spd > 2.4 ? '#ff8a5c' : '#ffd38a') : 'rgba(220,225,240,1)';
    ctx.lineWidth = W.r * (1.6 - i * 0.18);
    ctx.beginPath();
    ctx.arc(bx, by, W.L, Math.min(a0, a1), Math.max(a0, a1));
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function drawLoose(it, now) {
  const W = WEAPONS[it[4]];
  const f = it[7] / DROP_STEPS;
  const y = it[1] - f * 0.25;
  // The shadow first, sharper the nearer it is to landing.
  ctx.fillStyle = `rgba(0,0,0,${0.18 + 0.2 * (1 - f)})`;
  ctx.beginPath();
  ctx.ellipse(it[0], it[1] + 0.006, W.r * 1.4 * (1 - 0.4 * f), W.r * (1 - 0.4 * f), 0, 0, Math.PI * 2);
  ctx.fill();
  // One lying still glows a little, so it reads as something to pick up.
  if (!it[6] && !it[7]) {
    ctx.strokeStyle = `rgba(255,209,102,${0.25 + 0.2 * Math.sin(now / 240 + it[0] * 9)})`;
    ctx.lineWidth = 0.004;
    disc(it[0], it[1], W.r + 0.03);
    ctx.stroke();
  }
  const owner = latest && latest.p[it[5]] ? SEAT[latest.p[it[5]].k] : '#c9c3dd';
  const len = W.L * 0.55;
  const tx = it[0] - it[8] * len, ty = y - it[9] * len;
  drawLink(it[4], tx, ty, it[0], y, 1, it[6] ? 3 : 0, owner);
  drawHead(it[4], it[0], y, it[8], it[9], 1, owner, now / 300);
}

function drawFighter(id, x, y, d, ux, uy, colour, me, now) {
  const look = lookOf(id);
  const sq = look.squash;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(x + 0.005, y + 0.014, PR * 1.02, PR * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  if (d.ar > 0) {
    ctx.strokeStyle = INK.armor;
    ctx.globalAlpha = 0.35 + 0.5 * (d.ar / ARMOR);
    ctx.lineWidth = 0.007;
    disc(x, y, PR + 0.012);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const v = Math.hypot(d.vx, d.vy);
  // It watches its weapon when it has one, and the way it runs when it has not.
  let fx_ = d.wk >= 0 ? ux : (v > 0.05 ? d.vx / v : 0), fy_ = d.wk >= 0 ? uy : (v > 0.05 ? d.vy / v : 1);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1 + 0.24 * sq, 1 - 0.24 * sq);
  ctx.fillStyle = colour;
  disc(0, 0, PR);
  ctx.fill();
  if (look.flash > 0.05) {
    ctx.fillStyle = `rgba(255,255,255,${look.flash * 0.8})`;
    disc(0, 0, PR);
    ctx.fill();
  }
  ctx.strokeStyle = me ? '#ffffff' : 'rgba(0,0,0,0.35)';
  ctx.lineWidth = me ? 0.006 : 0.004;
  disc(0, 0, PR);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  disc(-PR * 0.32, -PR * 0.35, PR * 0.36);
  ctx.fill();
  const px = -fy_, py = fx_;
  const hurt = look.flash > 0.3;
  for (const side of [-1, 1]) {
    const ex = fx_ * PR * 0.36 + px * PR * 0.36 * side, ey = fy_ * PR * 0.36 + py * PR * 0.36 * side;
    ctx.fillStyle = '#ffffff';
    disc(ex, ey, PR * 0.25);
    ctx.fill();
    if (hurt) {
      ctx.strokeStyle = '#1a1a22';
      ctx.lineWidth = PR * 0.1;
      ctx.beginPath();
      ctx.moveTo(ex - PR * 0.12, ey - PR * 0.12); ctx.lineTo(ex + PR * 0.12, ey + PR * 0.12);
      ctx.moveTo(ex + PR * 0.12, ey - PR * 0.12); ctx.lineTo(ex - PR * 0.12, ey + PR * 0.12);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#1a1a22';
      disc(ex + fx_ * PR * 0.1, ey + fy_ * PR * 0.1, PR * 0.12);
      ctx.fill();
    }
  }
  ctx.restore();
  // Health, over every head; yours a little bolder.
  const bw = PR * 2.3, bh = me ? 0.012 : 0.009, bx = x - bw / 2, by = y - PR - 0.03;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(bx - 0.002, by - 0.002, bw + 0.004, bh + 0.004);
  const hk = d.hp / HP;
  ctx.fillStyle = hk > 0.5 ? INK.hp : hk > 0.25 ? INK.gold : INK.danger;
  ctx.fillRect(bx, by, bw * hk, bh);
  if (d.ar > 0) {
    ctx.fillStyle = INK.armor;
    ctx.fillRect(bx, by - bh * 0.7, bw * (d.ar / ARMOR), bh * 0.5);
  }
}

function drawGhost(x, y, colour, me, now) {
  const bob = Math.sin(now / 300 + x * 10) * 0.006;
  ctx.globalAlpha = me ? 0.45 : 0.3;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y + bob - 0.005, PR * 0.85, Math.PI, 0);
  ctx.lineTo(x + PR * 0.85, y + bob + PR * 0.7);
  for (let i = 0; i < 4; i++) {
    const k = 1 - (i + 0.5) / 4 * 2;
    ctx.lineTo(x + PR * 0.85 * k, y + bob + PR * (i % 2 ? 0.7 : 0.45));
  }
  ctx.lineTo(x - PR * 0.85, y + bob + PR * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#1a1a22';
  disc(x - PR * 0.28, y + bob - PR * 0.1, PR * 0.12);
  ctx.fill();
  disc(x + PR * 0.28, y + bob - PR * 0.1, PR * 0.12);
  ctx.fill();
  ctx.globalAlpha = 1;
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
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
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
    const e = PLAY_STEPS - t.pt;
    status = 'round ' + t.rd + ' · ' + standingIn(t).length + ' standing · ' + clock(t.pt);
    if (e >= SHRINK_FROM && e < SHRINK_END) { status += ' · the wall closes in'; colour = (Math.floor(now / 300) % 2) ? INK.danger : INK.text; }
    else if (t.pt < 10 * HZ) colour = (Math.floor(now / 250) % 2) ? INK.danger : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('flail', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('flail').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 100, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a fighter, in its seat's colour, with its points.
  const ids = playersIn(t).sort((a, b) => t.p[a].k - t.p[b].k);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, down = !d.al && t.ph !== WAIT;
      ctx.globalAlpha = down ? 0.5 : 1;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.3)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[d.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[d.k];
      ctx.strokeStyle = SEAT[d.k];
      ctx.lineWidth = 2;
      disc(x + 11, y - 2, 5);
      if (down) ctx.stroke(); else ctx.fill();
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
  let how, hc = INK.muted;
  if (md && !md.al) { how = 'knocked out · drift about until the next round'; hc = INK.dim; }
  else if (md && md.wk < 0) { how = 'empty-handed · run over a weapon on the floor to pick it up'; hc = INK.gold; }
  else how = coarse ? 'drag to run · run in circles to whirl it · turn hard to whip · tap to throw'
    : 'WASD/arrows or hold the mouse to run · circle to whirl it · turn hard to whip · space/click throws · M mutes';
  fitText(how, VW / 2, VH - 10, 12, hc, VW - 20);
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

// Practice ends a moment after a second fighter arrives: who it was, as this
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
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'run in circles to whirl your weapon up · hit the bot while it glows hot';
    practiceNote(now, VW, head, tip, [[TOP, SY(-VIEW) - 4], [SY(VIEW) + 4, VH - BOT]], VH - BOT - 2);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    fitText('whirl it up · last one standing · first to ' + MATCH + ' takes the match', cx, cy + big * 2.2, 15, INK.text, VW - 40);
    const md = t.p[me];
    if (md && md.ar > 0) fitText('you trail, so you start with armour', cx, cy + big * 2.2 + 22, 13, INK.armor, VW - 40);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('fight!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
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
    else if (t.win !== -1) { head = t.win === me ? 'you are the last one standing!' : nickOf(t.win) + ' stands last'; hc = colourOf(t, t.win); }
    else head = 'nobody stands';
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

// A fighter between two tables: a body, and the way its weapon hangs, walked
// the short way round. One that has just gone down or come back, or changed
// weapons, is drawn as the newer table has it rather than walked there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q || q.al !== p.al || q.wk !== p.wk) return { x: p.x, y: p.y, a: Math.atan2(p.uy, p.ux), w: p.w };
  const a0 = Math.atan2(q.uy, q.ux), a1 = Math.atan2(p.uy, p.ux);
  let da = a1 - a0;
  da -= Math.PI * 2 * Math.round(da / (Math.PI * 2));
  return { x: lerp(q.x, p.x, b.k), y: lerp(q.y, p.y, b.k), a: a0 + da * b.k, w: lerp(q.w, p.w, b.k) };
}

// Your own fighter is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh — is taken at once. Its weapon is drawn
// from the guess as it is, hung off the eased body.
let shown = null;
const SNAP = 0.15;
function settle(tx, ty, alive) {
  if (!shown || shown[2] !== alive || (tx - shown[0]) ** 2 + (ty - shown[1]) ** 2 > SNAP * SNAP) return (shown = [tx, ty, alive]);
  const k = per60(0.4);
  shown[0] += (tx - shown[0]) * k;
  shown[1] += (ty - shown[1]) * k;
  return shown;
}

// The hum of your own weapon: a whoosh every half turn once it flies fast.
let humAngle = null;
function hum(a, spd) {
  if (humAngle === null || spd < 1.2) { humAngle = a; return; }
  let da = a - humAngle;
  da -= Math.PI * 2 * Math.round(da / (Math.PI * 2));
  if (Math.abs(da) > Math.PI * 0.9 || Math.abs(da) < 0.01) return;
  if (Math.abs(da) >= Math.PI / 2) {
    sound.whoosh(Math.min(1, (spd - 1.2) / (CAP - 1.2)));
    humAngle = a;
  }
}

let latest = null;     // the arena the drawing stands on, for things drawn outside `draw`
let myPos = null;      // [x, y]: where your fighter is drawn
function drawArmed(id, pos, d, me, now) {
  const colour = SEAT[d.k];
  if (!d.al) { drawGhost(pos.x, pos.y, colour, me, now); return; }
  if (d.wk >= 0) {
    const W = WEAPONS[d.wk];
    const ax = Math.cos(pos.a), ay = Math.sin(pos.a), spd = Math.abs(pos.w) * W.L;
    const hx = pos.x + ax * W.L, hy = pos.y + ay * W.L;
    drawTrail(pos.x, pos.y, ax, ay, d.wk, pos.w, 1);
    drawLink(d.wk, pos.x, pos.y, hx, hy, pos.w >= 0 ? 1 : -1, spd, colour);
    drawFighter(id, pos.x, pos.y, d, ax, ay, colour, me, now);
    drawHead(d.wk, hx, hy, ax, ay, pos.w >= 0 ? 1 : -1, colour, pos.a * 0.5);
    // Your own speed, as a ring round you: grey while it would only tap, hot
    // once it would hurt.
    if (me) {
      const k = Math.min(1, spd / CAP);
      ctx.strokeStyle = spd >= VMIN ? (spd > 2.4 ? '#ff8a5c' : INK.gold) : 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 0.006;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, PR + 0.02, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, k));
      ctx.stroke();
      hum(pos.a, spd);
    }
  } else {
    drawFighter(id, pos.x, pos.y, d, 0, 1, colour, me, now);
  }
}

function draw(now) {
  drawPit(now);
  const b = agreedAt(now);
  if (!b) {
    myPos = shown = latest = null;
    flat();
    panel(cx, cy, Math.min(VW - 32, 300), 60);
    text('catching up with the arena…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  latest = t;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to an arena this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const R = lerp(b.from.R, t.R, b.k);
  drawArena(R, now);
  inField();
  // Weapons on the floor and in the air: a weapon is walked between tables
  // only while the same one stands at the same place in the list.
  const was = b.from.it;
  for (let i = 0; i < t.it.length; i++) {
    const c = t.it[i];
    const q = was[i] && was[i][4] === c[4] && was[i][5] === c[5] && was[i][7] >= c[7] ? was[i] : c;
    const ix = lerp(q[0], c[0], b.k), iy = lerp(q[1], c[1], b.k);
    drawLoose([ix, iy, c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10]], now);
  }
  const me = myId();
  const ids = playersIn(t);
  let mine = null;
  const m = mineAt(now);
  if (m && m.to.p[me]) {
    const pos = between(m, me), d = m.to.p[me];
    if (pos) {
      const s = settle(pos.x, pos.y, d.al);
      mine = { d, pos: { x: s[0], y: s[1], a: pos.a, w: pos.w } };
    }
  }
  myPos = mine ? [mine.pos.x, mine.pos.y] : (shown = null);
  // Ghosts under everything, the standing over them, and you on top.
  for (const pass of [0, 1]) {
    for (const id of ids) {
      if (id === me) continue;
      const d = t.p[id];
      if ((pass === 0) === !!d.al) continue;
      const pos = between(b, id);
      if (pos) drawArmed(id, pos, d, false, now);
    }
    if (mine && (pass === 0) === !mine.d.al) drawArmed(me, mine.pos, mine.d, true, now);
  }
  // Names under the others, so a hit has somebody to be aimed at.
  flat();
  for (const id of ids) {
    if (id === me) continue;
    const d = t.p[id], pos = between(b, id);
    if (pos && d.al) fitText(nickOf(id), SX(pos.x), SY(pos.y) + PR * sc + 13, 11, INK.text, 90);
  }
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: a direction in thousandths, and how many throws so far.
// Setting off and stopping go out at once; a change of direction while running
// goes out no oftener than TURN_EVERY, because a thumb moving in a circle —
// which is how this game is played — changes it on every move the screen
// reports, and the clock's ticks share the same seat's ceiling on messages.
const TURN_EVERY = 50;
let wanted = [0, 0];
let lastSaid = [0, 0];
let saidAt = -1e9;
let throws = 0;
let myThrowAt = -1e9;

function shove(fx_, fy_) {
  const far = Math.hypot(fx_, fy_);
  wanted = far < 0.01 ? [0, 0] : [Math.round((fx_ / far) * 1000), Math.round((fy_ / far) * 1000)];
  sayHand(performance.now());
}
function sayHand(now) {
  const d = wanted;
  if (Math.hypot(d[0] - lastSaid[0], d[1] - lastSaid[1]) < 60) return;
  const still = (v) => v[0] === 0 && v[1] === 0;
  if (!still(d) && !still(lastSaid) && now - saidAt < TURN_EVERY) return;
  lastSaid = d;
  saidAt = now;
  setHand([d[0], d[1], throws]);
}

// A throw is asked for only with a weapon in hand, so it is never spent on
// nothing; the arena lets go of it a trip later on every copy alike, at the
// speed the head is flying then.
function throwIt() {
  wake();
  if (!world) return;
  const d = world.p[myId()];
  const now = performance.now();
  if (!d || !d.al || d.wk < 0 || world.ph === COUNT || now - myThrowAt < 400) return;
  myThrowAt = now;
  throws = (throws + 1) % 64;
  lastSaid = wanted;
  saidAt = now;
  setHand([wanted[0], wanted[1], throws]);
  if (myPos) {
    ring(myPos[0], myPos[1], SEAT[d.k], PR * 2.2);
    sound.throwIt();
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
    if (!e.repeat) throwIt();
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

// A thumb: a stick from wherever it lands, and a tap throws — a drag rather
// than a press, because iOS keeps a long press inside a frame for itself. A
// second finger down while the first runs throws too.
// A mouse: hold the button and the fighter runs to the pointer; a click throws.
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
    if (stick) { throwIt(); return; }
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
    if (tap) throwIt();
  } else if (mouse && e.pointerId === mouse.id) {
    const click = !mouse.moved && performance.now() - mouse.at < 220;
    mouse = null;
    if (click) throwIt();
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

// The mouse steers toward the pointer, held down: circling the pointer round
// your fighter is circling the fighter.
function steerToMouse() {
  if (!mouse || !myPos) return;
  const r = cv.getBoundingClientRect();
  const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]);
  // A held button that has not moved yet may still be a click.
  if (!mouse.moved && performance.now() - mouse.at < 220) return;
  // Stopped on arrival, and off again only once the pointer is clearly away:
  // one threshold for both makes a fighter that stops and starts on every
  // twitch of the hand.
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
// a fighter arrives in the arena.
function start() {
  setHand([0, 0, throws]);
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
