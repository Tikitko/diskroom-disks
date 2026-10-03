/**
 * @disk     conga
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Lead a conga line round a disco floor and pick up loose dancers. Cut across a rival's line and everyone behind the cut lets go, up for grabs. The longest line at the last note takes the round; three rounds take the match.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/conga.png
 */
// conga.js — a line-stealing dance where the room's order is the referee.
//
// Every copy holds the whole floor — every leader, every dancer behind them,
// every loose dancer, the spotlight — and moves it only on what comes back
// round the room, so every copy applies the same hands in the same order and
// holds the same floor. Nobody sends where they are, whose line they cut or how
// long a line is: a hand is a direction and a shimmy counter, and everything
// else is the same arithmetic on the same numbers on every machine. A page with
// a console open can steer its own leader however it likes, at a leader's own
// pace, and shimmy no oftener than anybody else.
//
// While a dancer is alone on the floor, a bot dances with them. It is part of
// the floor like any leader, and its steps are a function of the floor alone,
// so it moves the same on every copy and says nothing over the wire. When a
// second dancer arrives, practice runs on for three seconds under a note that
// says so, and the bot leaves before the round is laid out: it never takes part
// in one.
//
// Your own line does not wait for the trip: it is drawn from the agreed floor
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

// Positions are kept to a ten-thousandth, so a floor of many dancers stays a
// small table to fingerprint and hand over. Rounding is exact everywhere.
const r4 = (v) => Math.round(v * 10000) / 10000;

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the floor a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own line a trip ahead, with your hand in it
const DT = 1 / HZ;

const F = 0.6;                 // half the floor's width
const VIEW = 0.64;             // half the width drawn round the floor
const RH = 0.034;              // a leader's radius
const RD = 0.023;              // a dancer's radius
const SP = 0.05;               // the gap from one dancer to the next in a line
const SPEED = 0.34;            // a leader's pace, floor widths a second
const LOAD = 0.006;            // what each dancer in tow takes off that pace
const TURN = 0.12;             // the most a leader turns in one step
const TURN_C = dcos(TURN), TURN_S = dsin(TURN);
const CATCH = 0.95;            // how fast a dancer hurries to its place in a line
const SHIMMY_K = 2.0;          // a shimmy's pace, against a walk's
const SHIMMY_STEPS = 12;
const SHIMMY_CD = 3 * HZ;
const SONG_K = 1.25;           // the last song's pace, against the rest
const DIZZY = 10;              // steps a dancer who let go cannot be picked up
const GRACE = 45;              // steps a line that was cut cannot be cut again
const START_LINE = 2;          // dancers every leader starts a round with
const MAX_LINE = 30;
const MAX_LOOSE = 20;
const SPAWN_EVERY = 36;
const LIGHT_V = 0.2;           // how fast the spotlight drifts to the shortest line
const HANDS_PER_STEP = 8;      // past this, a sender's hand in one step steers but cannot shimmy or seat
const MAX_P = 8;
const MATCH = 3;               // rounds that take the match

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second dancer arrives
const PLAY_STEPS = 75 * HZ;
const SONG_STEPS = 15 * HZ;    // the last song: the closing stretch of a round, faster
const END_STEPS = 6 * HZ;
const CHAMP_STEPS = 9 * HZ;

// The floor. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every leader is made by one function with its fields in one order.
//   p:  player id -> a leader (see `leader`)
//   f:  loose dancers, each [x, y, vx, vy, dizzy steps, the seat it last danced for or -1]
//   sx, sy: the spotlight, where new dancers come onto the floor
//   res: the last round's [id, line, crowns, crowned] rows; wn: who took it
function freshTable(seed) {
  return { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, sx: 0, sy: 0, p: {}, f: [], res: null, wn: [], champ: -1 };
}

const FIELDS = ['x', 'y', 'hx', 'hy', 'dx', 'dy', 'bs', 'ld', 'dq', 'dd', 'g', 'k', 'cr', 'ct', 'L', 'hs', 'hc'];
//   x, y: the leader; hx, hy: the way it faces, a unit; dx, dy: the hand's
//   direction in thousandths, 0 0 for straight on; bs: shimmy counter as last
//   heard; ld: step of the last shimmy; dq: a shimmy to make this step; dd:
//   steps of shimmy left; g: steps its line cannot be cut; k: seat, which is its
//   colour; cr: rounds taken; ct: lines cut this round; L: the line behind it,
//   [[x, y], ...]; hs, hc: hands this step.
function leader(v) {
  const s = {};
  for (const f of FIELDS) s[f] = v[f];
  return s;
}

const playersIn = (w) => Object.keys(w.p).map(Number).sort((a, b) => a - b);

function freeSeat(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// A leader set down at angle `a` on a ring, facing a little past the middle so
// a round opens in a swirl rather than a pile-up, its line behind it.
function place(d, a, r) {
  d.x = r4(dcos(a) * r);
  d.y = r4(dsin(a) * r);
  const ta = a + PI + 0.6;
  d.hx = r4(dcos(ta));
  d.hy = r4(dsin(ta));
  d.L = [];
  for (let i = 1; i <= START_LINE; i++) d.L.push([r4(d.x - d.hx * SP * i), r4(d.y - d.hy * SP * i)]);
  d.dd = 0; d.dq = 0; d.g = 0;
}

function newLeader(w, bs) {
  return leader({
    x: 0, y: 0, hx: 1, hy: 0, dx: 0, dy: 0, bs, ld: w.n - SHIMMY_CD, dq: 0, dd: 0, g: 0,
    k: freeSeat(w), cr: 0, ct: 0, L: [], hs: w.n, hc: 0,
  });
}

// A hand, at its place in the room's order: [dx, dy, shimmies] — a direction
// in thousandths and a counter that moves on by one for every shimmy. Being
// heard is how a leader arrives: onto the floor at once, with a short line.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_P) return;
    d = w.p[id] = newLeader(w, input[2]);
    place(d, draw01(w) * TAU, 0.42);
  }
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  d.dx = input[0];
  d.dy = input[1];
  if (input[2] !== d.bs) {
    d.bs = input[2];
    // A shimmy is a request; whether it happens is the floor's cooldown, the
    // same on every copy, and a flood of hands in one step buys none.
    if (d.hc <= HANDS_PER_STEP && w.ph !== COUNT && w.ph !== END && w.n - d.ld >= SHIMMY_CD) {
      d.ld = w.n;
      d.dq = 1;
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

// Whoever leaves the room lets go of their line, and its dancers are anybody's.
function leave(w, id) {
  const d = w.p[id];
  if (!d) return;
  letGo(w, d, 0, d.x, d.y);
  delete w.p[id];
}

// The dancers of `d` from `from` on let go of the line, and scatter a little
// away from (ox, oy). How many let go.
function letGo(w, d, from, ox, oy) {
  const gone = d.L.splice(from);
  for (const q of gone) {
    if (w.f.length >= MAX_LOOSE + MAX_LINE) break;
    const ex = q[0] - ox, ey = q[1] - oy, el = Math.sqrt(ex * ex + ey * ey);
    const j = (draw01(w) - 0.5) * 0.12;
    const vx = el > 1e-6 ? (ex / el) * 0.28 : 0, vy = el > 1e-6 ? (ey / el) * 0.28 : 0;
    w.f.push([q[0], q[1], r4(vx - vy * j * 4), r4(vy + vx * j * 4), DIZZY, d.k]);
  }
  return gone.length;
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
}

function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.wn = [];
  if (w.champ !== -1) {
    for (const id of playersIn(w)) w.p[id].cr = 0;
    w.champ = -1;
  }
  w.f = [];
  w.sx = w.sy = 0;
  // Everybody round a ring, evenly, the ring turned a different way each round.
  const ids = playersIn(w);
  const turn = draw01(w) * TAU;
  ids.forEach((id, i) => {
    const d = w.p[id];
    place(d, turn + (i / ids.length) * TAU, 0.42);
    d.ld = w.n - SHIMMY_CD;
    d.ct = 0;
  });
  for (let i = 0; i < 3 + ids.length; i++) spawn(w, false);
  fx(w, 'round');
}

function finish(w) {
  const ids = playersIn(w);
  let most = 0;
  for (const id of ids) most = Math.max(most, w.p[id].L.length);
  w.wn = most > 0 ? ids.filter((id) => w.p[id].L.length === most) : [];
  for (const id of w.wn) w.p[id].cr += 1;
  const res = ids.map((id) => [id, w.p[id].L.length, w.p[id].cr, w.wn.includes(id) ? 1 : 0]);
  res.sort((a, b) => b[2] - a[2] || b[1] - a[1] || a[0] - b[0]);
  w.res = res;
  // A match is taken outright: two leaders level at the top dance another round.
  if (res.length && res[0][2] >= MATCH && (res.length < 2 || res[1][2] < res[0][2])) w.champ = res[0][0];
  w.ph = END;
  w.pt = w.champ !== -1 ? CHAMP_STEPS : END_STEPS;
  fx(w, 'end', 0, 0, w.wn.length === 1 ? w.wn[0] : -1);
}

// A dancer comes onto the floor: most often under the spotlight, which drifts
// to whoever's line is shortest, otherwise anywhere.
function spawn(w, lit) {
  const m = F - 0.08;
  let x, y;
  if (lit) {
    const a = draw01(w) * TAU, r = 0.03 + draw01(w) * 0.12;
    x = w.sx + dcos(a) * r;
    y = w.sy + dsin(a) * r;
  } else {
    x = (draw01(w) * 2 - 1) * m;
    y = (draw01(w) * 2 - 1) * m;
  }
  x = r4(Math.max(-m, Math.min(m, x)));
  y = r4(Math.max(-m, Math.min(m, y)));
  w.f.push([x, y, 0, 0, 0, -1]);
  fx(w, 'spawn', x, y);
}

function shortest(w) {
  let best = null;
  for (const id of playersIn(w)) {
    const d = w.p[id];
    if (!best || d.L.length < best.L.length || (d.L.length === best.L.length && d.k < best.k)) best = d;
  }
  return best;
}

// Two leaders that meet bounce off each other, each turned away along the
// line between them.
function bump(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dd = dx * dx + dy * dy, m = 2 * RH;
  if (dd >= m * m) return false;
  const dist = dd < 1e-12 ? 0 : Math.sqrt(dd);
  const nx = dist ? dx / dist : 1, ny = dist ? dy / dist : 0, over = (m - dist) / 2;
  a.x -= nx * over; a.y -= ny * over;
  b.x += nx * over; b.y += ny * over;
  const an = a.hx * nx + a.hy * ny;
  if (an > 0) { a.hx -= 2 * an * nx; a.hy -= 2 * an * ny; }
  const bn = b.hx * nx + b.hy * ny;
  if (bn < 0) { b.hx -= 2 * bn * nx; b.hy -= 2 * bn * ny; }
  return true;
}

function unit(d) {
  const l = Math.sqrt(d.hx * d.hx + d.hy * d.hy);
  if (l < 1e-9) { d.hx = 1; d.hy = 0; return; }
  d.hx /= l;
  d.hy /= l;
}

// A leader turns toward its hand, no more than TURN in a step.
function turnToward(d, tx, ty) {
  const dot = d.hx * tx + d.hy * ty;
  if (dot >= TURN_C) { d.hx = tx; d.hy = ty; return; }
  const s = d.hx * ty - d.hy * tx >= 0 ? TURN_S : -TURN_S;
  const hx = d.hx * TURN_C - d.hy * s, hy = d.hx * s + d.hy * TURN_C;
  d.hx = hx;
  d.hy = hy;
  unit(d);
}

// The floor's edge: a leader slides along it rather than through it.
function wall(d) {
  const m = F - RH;
  if (d.x > m) { d.x = m; if (d.hx > 0) d.hx = 0; }
  if (d.x < -m) { d.x = -m; if (d.hx < 0) d.hx = 0; }
  if (d.y > m) { d.y = m; if (d.hy > 0) d.hy = 0; }
  if (d.y < -m) { d.y = -m; if (d.hy < 0) d.hy = 0; }
  if (d.hx === 0 && d.hy === 0) { d.hx = d.x > 0 ? -1 : 1; }
  unit(d);
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions: slow enough to be beaten
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot dances while the floor waits for a round, and goes the moment a
// round's countdown starts.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && Object.keys(w.p).length < MAX_P) {
    const d = (w.p[BOT_ID] = newLeader(w, 0));
    place(d, draw01(w) * TAU, 0.42);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

function steer(d, x, y) {
  const l = Math.sqrt(x * x + y * y);
  if (l < 1e-6) { d.dx = d.dy = 0; return; }
  d.dx = Math.round((x / l) * 1000);
  d.dy = Math.round((y / l) * 1000);
}

// The bot's steps: it cuts into a line it can reach ahead of it, and otherwise
// goes after the nearest loose dancer. Now and then it dances straight on, so
// it can be caught out.
function botLegs(w) {
  const d = w.p[BOT_ID];
  if (!d || w.n % BOT_EVERY) return;
  if (draw01(w) < 0.2) return;
  let tx = 0, ty = 0, best = 1e9, cut = false;
  const hunt = draw01(w) < 0.5;
  for (const id of hunt ? playersIn(w) : []) {
    const o = w.p[id];
    if (id === BOT_ID || o.g) continue;
    for (let k = 0; k < o.L.length; k++) {
      const ex = o.L[k][0] - d.x, ey = o.L[k][1] - d.y, dd = ex * ex + ey * ey;
      if (dd > 0.09 || ex * d.hx + ey * d.hy < 0) continue;
      // The nearer the head of a line, the more it is worth cutting.
      const cost = dd + k * 0.002;
      if (cost < best) { best = cost; tx = ex; ty = ey; cut = true; }
    }
  }
  if (!cut) {
    for (const q of w.f) {
      if (q[4]) continue;
      const ex = q[0] - d.x, ey = q[1] - d.y, dd = ex * ex + ey * ey;
      if (dd < best) { best = dd; tx = ex; ty = ey; }
    }
  }
  if (best === 1e9) { tx = w.sx - d.x; ty = w.sy - d.y; }
  steer(d, tx, ty);
  if (best < 0.03 && w.n - d.ld >= SHIMMY_CD && draw01(w) < 0.3) { d.ld = w.n; d.dq = 1; }
}

// One step of the floor: a function of the floor alone.
function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second dancer ends practice, three seconds on: the count runs in pt,
    // which a waiting floor otherwise leaves at zero. The bot goes first, so
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
      if (w.pt === SONG_STEPS) fx(w, 'song');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  if (w.ph === COUNT || w.ph === END) return;

  botLegs(w);
  const ids = playersIn(w);
  const pace = w.ph === PLAY && w.pt <= SONG_STEPS ? SONG_K : 1;

  // Leaders: turn toward the hand, then dance on. A leader never stops.
  for (const id of ids) {
    const d = w.p[id];
    const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy);
    if (len > 60) turnToward(d, d.dx / len, d.dy / len);
    if (d.dq) {
      d.dq = 0;
      d.dd = SHIMMY_STEPS;
      fx(w, 'shimmy', d.x, d.y, id);
    }
    const v = SPEED * pace * (1 - LOAD * d.L.length) * (d.dd > 0 ? SHIMMY_K : 1);
    d.x += d.hx * v * DT;
    d.y += d.hy * v * DT;
    wall(d);
    if (d.dd > 0) d.dd -= 1;
    if (d.g > 0) d.g -= 1;
  }
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = w.p[ids[i]], b = w.p[ids[j]];
    if (bump(a, b)) {
      unit(a); unit(b);
      fx(w, 'bump', (a.x + b.x) / 2, (a.y + b.y) / 2, ids[i], ids[j]);
    }
  }
  for (const id of ids) {
    const d = w.p[id];
    wall(d);
    d.x = r4(d.x); d.y = r4(d.y);
    d.hx = Math.round(d.hx * 1e6) / 1e6; d.hy = Math.round(d.hy * 1e6) / 1e6;
  }

  // Each dancer keeps its gap behind the one in front, hurrying when it is far.
  for (const id of ids) {
    const d = w.p[id];
    let px = d.x, py = d.y;
    for (const q of d.L) {
      const ex = q[0] - px, ey = q[1] - py, dist = Math.sqrt(ex * ex + ey * ey);
      if (dist > SP) {
        const most = CATCH * DT;
        if (dist - SP <= most) { q[0] = px + (ex / dist) * SP; q[1] = py + (ey / dist) * SP; }
        else { q[0] -= (ex / dist) * most; q[1] -= (ey / dist) * most; }
        q[0] = r4(q[0]); q[1] = r4(q[1]);
      }
      px = q[0]; py = q[1];
    }
  }

  // Loose dancers drift to a stop and get their bearings back.
  const m = F - RD;
  for (const q of w.f) {
    if (q[4] > 0) q[4] -= 1;
    if (q[2] !== 0 || q[3] !== 0) {
      q[0] = r4(Math.max(-m, Math.min(m, q[0] + q[2] * DT)));
      q[1] = r4(Math.max(-m, Math.min(m, q[1] + q[3] * DT)));
      q[2] = r4(q[2] * 0.88); q[3] = r4(q[3] * 0.88);
      if (Math.abs(q[2]) < 0.002 && Math.abs(q[3]) < 0.002) q[2] = q[3] = 0;
    }
  }

  // A leader who dances through somebody else's line cuts it there: every
  // dancer from that one back lets go.
  const reach = (RH + RD) * (RH + RD);
  for (const id of ids) {
    const a = w.p[id];
    for (const oid of ids) {
      const b = w.p[oid];
      if (oid === id || b.g > 0) continue;
      let at = -1;
      for (let k = 0; k < b.L.length; k++) {
        const ex = b.L[k][0] - a.x, ey = b.L[k][1] - a.y;
        if (ex * ex + ey * ey < reach) { at = k; break; }
      }
      if (at < 0) continue;
      const cx_ = b.L[at][0], cy_ = b.L[at][1];
      const n = letGo(w, b, at, a.x, a.y);
      b.g = GRACE;
      a.ct += 1;
      fx(w, 'cut', cx_, cy_, id, oid, n);
      break;
    }
  }

  // A leader who reaches a loose dancer that has its bearings takes it on at
  // the end of the line. Who is asked first goes round the floor step by step,
  // so a tie is nobody's for good.
  if (ids.length) {
    const grab = (RH + RD + 0.008) * (RH + RD + 0.008);
    for (let s = 0; s < ids.length; s++) {
      const id = ids[(s + w.n) % ids.length], d = w.p[id];
      for (let i = 0; i < w.f.length; i++) {
        const q = w.f[i];
        if (q[4] > 0 || d.L.length >= MAX_LINE) continue;
        const ex = q[0] - d.x, ey = q[1] - d.y;
        if (ex * ex + ey * ey >= grab) continue;
        d.L.push([q[0], q[1]]);
        w.f.splice(i--, 1);
        fx(w, 'join', q[0], q[1], id, d.L.length);
      }
    }
  }

  // The spotlight drifts to the shortest line, and new dancers come on under it.
  const low = shortest(w);
  if (low) {
    const ex = low.x - w.sx, ey = low.y - w.sy, el = Math.sqrt(ex * ex + ey * ey), most = LIGHT_V * DT;
    if (el <= most) { w.sx = low.x; w.sy = low.y; }
    else { w.sx = r4(w.sx + (ex / el) * most); w.sy = r4(w.sy + (ey / el) * most); }
  }
  const cap = Math.min(MAX_LOOSE, 3 + 2 * ids.length);
  if (w.n % SPAWN_EVERY === 0 && w.f.length < cap) spawn(w, draw01(w) < 0.6);
}

// A floor handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;
const spot = (q) => Array.isArray(q) && q.length === 2 && num(q[0], -1, 1) && num(q[1], -1, 1);

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!num(raw.sx, -1, 1) || !num(raw.sy, -1, 1)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!num(d.x, -1, 1) || !num(d.y, -1, 1) || !num(d.hx, -1.01, 1.01) || !num(d.hy, -1.01, 1.01)) return null;
    if (inputOf([d.dx, d.dy, d.bs]) === null) return null;
    if (d.dq !== 0 && d.dq !== 1) return null;
    if (!int(d.dd, 0, SHIMMY_STEPS) || !int(d.g, 0, GRACE) || !int(d.k, 0, MAX_P - 1) || seats.has(d.k)) return null;
    seats.add(d.k);
    for (const k of ['ld', 'hs']) if (!int(d[k], -BIG, BIG)) return null;
    if (!int(d.cr, 0, 9999) || !int(d.ct, 0, 99999) || !int(d.hc, 0, BIG)) return null;
    if (!Array.isArray(d.L) || d.L.length > MAX_LINE || !d.L.every(spot)) return null;
    const v = leader(d);
    v.L = d.L.map((q) => [q[0], q[1]]);
    p[id] = v;
  }
  if (!Array.isArray(raw.f) || raw.f.length > MAX_LOOSE + MAX_LINE) return null;
  const f = [];
  for (const v of raw.f) {
    if (!Array.isArray(v) || v.length !== 6) return null;
    if (!num(v[0], -1, 1) || !num(v[1], -1, 1) || !num(v[2], -2, 2) || !num(v[3], -2, 2)) return null;
    if (!int(v[4], 0, DIZZY) || !int(v[5], -1, MAX_P - 1)) return null;
    f.push(v.slice());
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
  if (!Array.isArray(raw.wn) || raw.wn.length > MAX_P || !raw.wn.every((v) => int(v, -BIG, BIG))) return null;
  if (!int(raw.champ, -BIG, BIG)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, sx: raw.sx, sy: raw.sy, p, f, res,
    wn: raw.wn.slice(), champ: raw.champ,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed floor steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a night-club purple, a floor of tiles that light up to the
// beat, and a colour for each seat that is its leader's, its line's and its
// chip's on the scoreboard.
const INK = {
  page: '#170c2b', pageLow: '#0c0618', tile: '#24163f', tileB: '#2b1b4a', grout: 'rgba(0,0,0,0.35)',
  edge: '#ffcf5a', text: '#f6effc', muted: '#b9a8d6', dim: '#7c6c9c', gold: '#ffd166',
  panel: 'rgba(16,8,32,0.92)', danger: '#ff5e7a', loose: '#fff3e0', light: 'rgba(255,240,200,0.16)',
};
const SEAT = ['#ff7f50', '#4fc3f7', '#ffd54f', '#c77dff', '#ff5fa2', '#4dd0b5', '#ff5252', '#9fa8ff'];
const GLOW = ['#ff4fa3', '#4fd1ff', '#ffd23f', '#b06bff', '#4fffa8', '#ff8f4f'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a3470;' +
  `background:#25163f;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

// The practice note's room under the floor, so it never sits on the bottom row.
const NOTE_ROOM = 60;
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
  const aw = VW - 16, ah = Math.max(40, VH - TOP - BOT - NOTE_ROOM);
  sc = Math.max(10, Math.min(aw, ah) / (2 * VIEW));
  cx = VW / 2;
  cy = TOP + ah / 2;
}
layout();
window.addEventListener('resize', layout);

// The floor to the screen and back.
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
// The conga's own beat: one-two-three-kick, on a bass and a shaker.
const SCALE = [262, 294, 330, 392, 440, 523, 587, 659, 784];
const sound = {
  kick() { if (ready('kick', 90)) { tone(110, 0.14, 'sine', 0.09, 0.45); } },
  shake() { if (ready('shake', 60)) puff(0.05, 0.035, 6000, 0, 1.5); },
  bass(f) { if (ready('bass', 90)) tone(f, 0.16, 'triangle', 0.05); },
  whoosh() { if (ready('whoosh', 80)) { puff(0.16, 0.12, 1700, 0, 0.8); puff(0.12, 0.05, 3200, 0.03); } },
  thud() { if (ready('thud', 90)) { tone(150, 0.12, 'sine', 0.12, 0.5); puff(0.06, 0.06, 420); } },
  snip(mine) {
    if (!ready('snip', 90)) return;
    puff(0.07, mine ? 0.2 : 0.1, 5200, 0, 3);
    puff(0.07, mine ? 0.18 : 0.08, 4200, 0.07, 3);
    tone(mine ? 900 : 700, 0.14, 'square', mine ? 0.05 : 0.025, 0.5, 0.02);
  },
  lost() { if (ready('lost', 200)) [523, 440, 349].forEach((f, i) => tone(f, 0.16, 'sawtooth', 0.04, 0.9, i * 0.08)); },
  join(n) { if (ready('join', 40)) tone(SCALE[Math.min(SCALE.length - 1, n % SCALE.length)] * (n >= SCALE.length ? 2 : 1), 0.1, 'triangle', 0.08); },
  spawn() { if (ready('spawn', 300)) tone(1760, 0.08, 'sine', 0.02, 1.4); },
  song() { if (ready('song', 600)) [392, 523, 659, 784].forEach((f, i) => tone(f, 0.18, 'square', 0.05, 0, i * 0.07)); },
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

// The beat, kept by the page's own clock while a round is danced: it is music,
// not the game, and nothing in the floor waits on it.
let beatAt = 0, beatN = 0;
const BASS = [131, 131, 165, 196];
function keepBeat(t, now) {
  if (t.ph !== PLAY && t.ph !== WAIT) return;
  const fast = t.ph === PLAY && t.pt <= SONG_STEPS;
  const gap = (fast ? 0.4 : 0.5) * 1000 / 2;
  if (now - beatAt < gap) return;
  beatAt = now - beatAt > gap * 3 ? now : beatAt + gap;
  beatN += 1;
  const b = beatN % 8;
  if (t.ph === WAIT) { if (b === 0) sound.shake(); return; }
  if (b === 6) sound.kick();
  if (b % 2 === 0) sound.bass(BASS[(b / 2) | 0]);
  else sound.shake();
}

// ── bits: particles, pops, rings, shake ────────────────────────────────────
// Stepped on a clock of their own at a fixed rate, never once per frame, so a
// fast screen and a slow one see the same spray.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, fall, spin } in floor units
const pops = [];      // { x, y, s, colour, life, max, px, lift }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, fall) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (fall ? speed * 0.6 : 0), life: 0,
      max: 22 + Math.random() * 24, size, colour, fall: fall || 0, spin: Math.random() * 6 });
  }
  if (bits.length > 500) bits.splice(0, bits.length - 500);
}
function confetti(x, y, count, colour) {
  for (let i = 0; i < count; i++) spray(x, y, 1, i % 3 ? colour : GLOW[i % GLOW.length], 0.5, 0.012, 0.9);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 55, px: px || 16, lift: lift || 16 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      b.vx *= 0.93; b.vy = b.vy * 0.93 + b.fall / BIT_HZ;
      b.spin += 0.2;
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
let myShimmyAt = -1e9;
let drawFailed = false;
const SHIMMY_MS = (SHIMMY_CD / HZ) * 1000 + 150;

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
  if (e.kind === 'shimmy') {
    lookOf(e.a).squash = 1;
    if (e.a === me) return;    // your own was heard and seen the moment you pressed
    spray(e.x, e.y, 6, 'rgba(255,255,255,0.8)', 0.3, 0.007);
    sound.whoosh();
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 8, '#fff3d6', 0.35, 0.007);
    lookOf(e.a).squash = 1;
    lookOf(e.b).squash = 1;
    if (e.a === me || e.b === me) shake = Math.max(shake, 4);
    sound.thud();
  } else if (e.kind === 'cut') {
    const victim = colourOf(t, e.b);
    confetti(e.x, e.y, 16 + Math.min(20, e.c * 2), victim);
    ring(e.x, e.y, '#ffffff', 0.09);
    lookOf(e.b).squash = 1;
    if (e.b === me) {
      shake = Math.max(shake, 10);
      pop(e.x, e.y, 'cut! −' + e.c, INK.danger, 20, 30);
      sound.snip(true);
      sound.lost();
    } else if (e.a === me) {
      shake = Math.max(shake, 4);
      pop(e.x, e.y, 'snip! ' + e.c + ' loose', INK.gold, 18, 28);
      sound.snip(true);
    } else {
      pop(e.x, e.y, 'snip!', victim, 14, 22);
      sound.snip(false);
    }
  } else if (e.kind === 'join') {
    const c = colourOf(t, e.a);
    spray(e.x, e.y, 4, c, 0.18, 0.006);
    if (e.a === me) { pop(e.x, e.y, '+1', c, 14, 20); sound.join(e.b); }
  } else if (e.kind === 'spawn') {
    ring(e.x, e.y, 'rgba(255,240,200,0.8)', 0.05);
    sound.spawn();
  } else if (e.kind === 'song') {
    pop(0, -0.1, 'last song!', INK.gold, 26, 30);
    sound.song();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(t.wn.includes(me));
  }
}

// The room: a purple gradient and a scatter of glitter from a mirror ball,
// drawn from the clock alone.
function drawRoom(now) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.page);
  g.addColorStop(1, INK.pageLow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  const tt = now / 1000;
  for (let i = 0; i < 46; i++) {
    const a = i * 2.39996 + tt * 0.12, r = 0.18 + ((i * 0.618) % 1) * 0.9;
    const x = VW / 2 + Math.cos(a) * r * VW * 0.6, y = VH * 0.45 + Math.sin(a) * r * VH * 0.6;
    const tw = 0.5 + 0.5 * Math.sin(tt * 2.3 + i * 1.7);
    ctx.fillStyle = `rgba(255,255,255,${0.04 + 0.1 * tw})`;
    ctx.fillRect(x, y, 2, 2);
  }
}

// The floor: tiles that light up in a slow wave to the beat, its edge, and the
// spotlight where new dancers come on.
const TILES = 10;
function drawFloor(t, sx, sy, now) {
  inField();
  const s = (2 * F) / TILES;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(-F + 0.012, -F + 0.02, 2 * F, 2 * F, 0.04);
  ctx.fill();
  ctx.save();
  roundRect(-F, -F, 2 * F, 2 * F, 0.04);
  ctx.clip();
  const tt = now / 1000, fast = t.ph === PLAY && t.pt <= SONG_STEPS;
  const beat = tt * (fast ? 2.5 : 2);
  for (let i = 0; i < TILES; i++) for (let j = 0; j < TILES; j++) {
    const x = -F + i * s, y = -F + j * s;
    ctx.fillStyle = (i + j) % 2 ? INK.tile : INK.tileB;
    ctx.fillRect(x, y, s, s);
    const wave = Math.sin(beat * PI * 0.5 + (i * 0.7 + j * 1.3)) * 0.5 + 0.5;
    const lit = wave > 0.8 ? (wave - 0.8) / 0.2 : 0;
    if (lit > 0) {
      ctx.globalAlpha = 0.22 * lit * (fast ? 1.4 : 1);
      ctx.fillStyle = GLOW[(i * 3 + j * 5) % GLOW.length];
      ctx.fillRect(x + s * 0.06, y + s * 0.06, s * 0.88, s * 0.88);
      ctx.globalAlpha = 1;
    }
  }
  ctx.strokeStyle = INK.grout;
  ctx.lineWidth = 0.004;
  for (let i = 1; i < TILES; i++) {
    ctx.beginPath(); ctx.moveTo(-F + i * s, -F); ctx.lineTo(-F + i * s, F); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-F, -F + i * s); ctx.lineTo(F, -F + i * s); ctx.stroke();
  }
  // The spotlight.
  const lr = 0.17 + 0.01 * Math.sin(tt * 3);
  const lg = ctx.createRadialGradient(sx, sy, 0, sx, sy, lr);
  lg.addColorStop(0, 'rgba(255,244,214,0.30)');
  lg.addColorStop(0.7, 'rgba(255,244,214,0.12)');
  lg.addColorStop(1, 'rgba(255,244,214,0)');
  ctx.fillStyle = lg;
  disc(sx, sy, lr);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = INK.edge;
  ctx.lineWidth = 0.008;
  roundRect(-F, -F, 2 * F, 2 * F, 0.04);
  ctx.stroke();
  // Bulbs round the edge, chasing each other.
  const nb = 28;
  for (let i = 0; i < nb; i++) {
    const u = i / nb, side = Math.floor(u * 4), f = (u * 4) % 1;
    const x = side === 0 ? -F + f * 2 * F : side === 1 ? F : side === 2 ? F - f * 2 * F : -F;
    const y = side === 0 ? -F : side === 1 ? -F + f * 2 * F : side === 2 ? F : F - f * 2 * F;
    const on = (i + Math.floor(beat * 2)) % 4 === 0;
    ctx.fillStyle = on ? '#fff6c8' : 'rgba(255,207,90,0.35)';
    disc(x, y, on ? 0.008 : 0.005);
    ctx.fill();
  }
}

// A dancer: a round body in its line's colour, two arms forward onto the one in
// front, and a little bounce to the beat.
function drawDancer(x, y, fx_, fy_, colour, i, now, alpha) {
  const bob = Math.sin(now / 150 + i * 0.9);
  const px = -fy_, py = fx_;
  const ox = px * bob * 0.004, oy = py * bob * 0.004;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(x + 0.004, y + 0.01, RD, RD * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 0.007;
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(x + ox + px * RD * 0.7 * side, y + oy + py * RD * 0.7 * side);
    ctx.lineTo(x + ox + fx_ * RD * 1.5 + px * RD * 0.55 * side, y + oy + fy_ * RD * 1.5 + py * RD * 0.55 * side);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.fillStyle = colour;
  disc(x + ox, y + oy, RD * (1 + 0.05 * bob));
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.003;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  disc(x + ox - RD * 0.3, y + oy - RD * 0.32, RD * 0.35);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// A leader: a bigger body, sunglasses that look where it goes, a crown on
// whoever leads the longest line.
function drawLeader(id, x, y, hx, hy, d, colour, me, crown, now) {
  const look = lookOf(id);
  const sq = look.squash;
  if (d.dd > 0) {
    for (let i = 1; i <= 3; i++) {
      ctx.globalAlpha = 0.2 / i;
      ctx.fillStyle = colour;
      disc(x - hx * RH * 1.1 * i, y - hy * RH * 1.1 * i, RH * (1 - i * 0.12));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(x + 0.005, y + 0.012, RH * 1.02, RH * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  const wig = d.dd > 0 ? Math.sin(now / 40) * 0.15 : 0;
  ctx.rotate(wig);
  ctx.scale(1 + 0.22 * sq, 1 - 0.22 * sq);
  ctx.fillStyle = colour;
  disc(0, 0, RH);
  ctx.fill();
  ctx.strokeStyle = me ? '#ffffff' : 'rgba(0,0,0,0.4)';
  ctx.lineWidth = me ? 0.007 : 0.004;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  disc(-RH * 0.32, -RH * 0.35, RH * 0.38);
  ctx.fill();
  const px = -hy, py = hx;
  ctx.fillStyle = '#16101f';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(hx * RH * 0.42 + px * RH * 0.33 * side, hy * RH * 0.42 + py * RH * 0.33 * side, RH * 0.27, RH * 0.2,
      Math.atan2(hy, hx) + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#16101f';
  ctx.lineWidth = 0.004;
  ctx.beginPath();
  ctx.moveTo(hx * RH * 0.42 + px * RH * 0.33, hy * RH * 0.42 + py * RH * 0.33);
  ctx.lineTo(hx * RH * 0.42 - px * RH * 0.33, hy * RH * 0.42 - py * RH * 0.33);
  ctx.stroke();
  ctx.restore();
  if (crown) {
    const cy_ = y - RH - 0.018 - 0.004 * Math.abs(Math.sin(now / 200));
    ctx.fillStyle = INK.gold;
    ctx.beginPath();
    ctx.moveTo(x - 0.022, cy_ + 0.012);
    ctx.lineTo(x - 0.022, cy_ - 0.006);
    ctx.lineTo(x - 0.011, cy_ + 0.003);
    ctx.lineTo(x, cy_ - 0.012);
    ctx.lineTo(x + 0.011, cy_ + 0.003);
    ctx.lineTo(x + 0.022, cy_ - 0.006);
    ctx.lineTo(x + 0.022, cy_ + 0.012);
    ctx.closePath();
    ctx.fill();
  }
  if (me) {
    const cool = Math.min(1, (performance.now() - myShimmyAt) / SHIMMY_MS);
    if (cool < 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 0.006;
      ctx.beginPath();
      ctx.arc(x, y, RH + 0.014, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cool);
      ctx.stroke();
    }
  }
}

// A loose dancer waiting to be asked: pale, arms up, swaying; one that has
// just let go spins with stars round its head.
function drawLoose(q, x, y, now, i) {
  const sway = Math.sin(now / 220 + i * 1.3);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(x + 0.004, y + 0.01, RD, RD * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();
  const tint = q[5] >= 0 ? SEAT[q[5]] : INK.loose;
  ctx.strokeStyle = tint;
  ctx.lineWidth = 0.007;
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(x + side * RD * 0.6, y - RD * 0.3);
    ctx.lineTo(x + side * RD * (1.1 + 0.2 * sway * side), y - RD * 1.6);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.fillStyle = INK.loose;
  disc(x + sway * 0.003, y, RD);
  ctx.fill();
  ctx.strokeStyle = tint;
  ctx.lineWidth = 0.005;
  ctx.stroke();
  if (q[4] > 0) {
    for (let s = 0; s < 3; s++) {
      const a = now / 120 + (s * TAU) / 3;
      ctx.fillStyle = INK.gold;
      disc(x + Math.cos(a) * RD * 1.3, y - RD * 1.2 + Math.sin(a) * RD * 0.5, 0.004);
      ctx.fill();
    }
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
    const w = b.size * (0.4 + 0.6 * Math.abs(Math.cos(b.spin)));
    ctx.fillRect(b.x - w / 2, b.y - b.size / 2, w, b.size);
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

// Whoever leads the longest line right now, or nobody when it is shared or empty.
function topLine(t) {
  let best = -1, most = 0, tie = false;
  for (const id of playersIn(t)) {
    const n = t.p[id].L.length;
    if (n > most) { most = n; best = id; tie = false; } else if (n === most && n > 0) tie = true;
  }
  return tie ? -1 : best;
}

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
    if (t.pt <= SONG_STEPS) { status += ' · last song!'; colour = (Math.floor(now / 250) % 2) ? INK.gold : INK.text; }
  } else status = 'round ' + t.rd + ' · over';
  text('conga', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('conga').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 100, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a leader, in its seat's colour, with its line and
  // the rounds it has taken.
  const ids = playersIn(t).sort((a, b) => t.p[a].k - t.p[b].k);
  if (ids.length) {
    const y = narrow ? 46 : 44;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.3)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[d.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = SEAT[d.k];
      disc(x + 11, y - 2, 5);
      ctx.fill();
      const score = String(d.L.length) + (d.cr ? ' ' + '★'.repeat(Math.min(5, d.cr)) : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, d.cr ? INK.gold : INK.text, 'right');
      if (cw > 50 + sw) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse ? 'drag to steer · tap to shimmy · cut across a line to steal its tail'
    : 'mouse or WASD/arrows steer · click or space shimmies · cut across a rival line · M mutes';
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

// Practice ends a moment after a second dancer arrives: who it was, as this
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
    const tip = two ? null : 'pick up loose dancers · cut across the bot\'s line to steal its tail';
    practiceNote(now, VW, head, tip, [[TOP, SY(-VIEW) - 4], [SY(VIEW) + 4, VH - BOT]], VH - BOT - 2);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    fitText('longest line at the last note takes the round · ' + MATCH + ' rounds take the match', cx, cy + big * 2.2, 15, INK.text, VW - 40);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('dance!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
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
    else if (t.wn.length === 1) {
      const id = t.wn[0];
      head = id === me ? 'your line was the longest!' : nickOf(id) + ' led the longest line';
      hc = colourOf(t, id);
    } else if (t.wn.length > 1) head = 'a tie · a round each';
    else head = 'nobody kept a dancer';
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 34, 22, hc, w - 24);
    rows.forEach(([id, line, held, got], i) => {
      const y = y0 + 64 + i * 22;
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (id === t.champ ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 150, 'left');
      text(line + ' in line', cx + w / 2 - 64, y, 12, got ? INK.gold : INK.dim, 'right');
      text(String(held), cx + w / 2 - 22, y, 15, INK.text, 'right');
    });
    fitText((t.champ !== -1 ? 'a new match in ' : 'next round in ') + Math.ceil(t.pt / HZ) + ' · first to ' + MATCH + ' rounds',
      cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// A leader and its line between two tables, as [hx, hy, x, y, [[x, y], ...]].
// A dancer only one table has — just taken on, just let go — is drawn where
// that table has it rather than walked there.
function between(b, id) {
  const p = b.to.p[id], q = b.from.p[id];
  if (!p) return null;
  if (!q) return [p.hx, p.hy, p.x, p.y, p.L.map((v) => [v[0], v[1]])];
  const L = p.L.map((v, i) => (i < q.L.length ? [lerp(q.L[i][0], v[0], b.k), lerp(q.L[i][1], v[1], b.k)] : [v[0], v[1]]));
  let hx = lerp(q.hx, p.hx, b.k), hy = lerp(q.hy, p.hy, b.k);
  const hl = Math.hypot(hx, hy) || 1;
  hx /= hl; hy /= hl;
  return [hx, hy, lerp(q.x, p.x, b.k), lerp(q.y, p.y, b.k), L];
}

// Your own leader is drawn from the guess a trip ahead, eased toward it rather
// than set on it, so a guess remade on every tick never shows as a twitch; a
// guess far off — a table taken afresh — is taken at once.
let shown = null;
const SNAP = 0.15;
function settle(tx, ty) {
  if (!shown || (tx - shown[0]) ** 2 + (ty - shown[1]) ** 2 > SNAP * SNAP) return (shown = [tx, ty]);
  const k = per60(0.35);
  shown[0] += (tx - shown[0]) * k;
  shown[1] += (ty - shown[1]) * k;
  return shown;
}

function drawLine(pos, d, colour, now, flash) {
  const [hx, hy, x, y, L] = pos;
  const alpha = flash ? 0.45 + 0.45 * Math.abs(Math.sin(now / 70)) : 1;
  if (L.length) {
    ctx.globalAlpha = 0.28 * alpha;
    ctx.strokeStyle = colour;
    ctx.lineWidth = RD * 1.3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (const q of L) ctx.lineTo(q[0], q[1]);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }
  for (let i = L.length - 1; i >= 0; i--) {
    const q = L[i], prev = i ? L[i - 1] : [x, y];
    let fx_ = prev[0] - q[0], fy_ = prev[1] - q[1];
    const fl = Math.hypot(fx_, fy_);
    if (fl > 1e-6) { fx_ /= fl; fy_ /= fl; } else { fx_ = hx; fy_ = hy; }
    drawDancer(q[0], q[1], fx_, fy_, colour, i, now, alpha);
  }
}

let myPos = null;      // [x, y]: where your leader is drawn
function draw(now) {
  drawRoom(now);
  const b = agreedAt(now);
  if (!b) {
    myPos = shown = null;
    flat();
    panel(cx, cy, Math.min(VW - 32, 300), 60);
    text('catching up with the floor…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a floor this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  keepBeat(t, now);
  drawFloor(t, lerp(b.from.sx, t.sx, b.k), lerp(b.from.sy, t.sy, b.k), now);
  inField();
  const same = b.from.f.length === t.f.length;
  t.f.forEach((q, i) => {
    const o = same ? b.from.f[i] : q;
    drawLoose(q, lerp(o[0], q[0], b.k), lerp(o[1], q[1], b.k), now, i);
  });

  const me = myId();
  const ids = playersIn(t);
  let mine = null;
  const m = mineAt(now);
  if (m && m.to.p[me]) {
    const pos = between(m, me);
    if (pos) {
      const s = settle(pos[2], pos[3]);
      // The line follows the eased leader, less and less down its length.
      const ex = s[0] - pos[2], ey = s[1] - pos[3];
      pos[4].forEach((q, i) => { const k = Math.max(0, 1 - i / 5); q[0] += ex * k; q[1] += ey * k; });
      pos[2] = s[0]; pos[3] = s[1];
      mine = { d: m.to.p[me], pos };
    }
  }
  myPos = mine ? [mine.pos[2], mine.pos[3]] : (shown = null);
  const top = topLine(t);
  const others = [];
  for (const id of ids) {
    if (id === me) continue;
    const pos = between(b, id);
    if (pos) others.push([id, pos, t.p[id]]);
  }
  for (const [, pos, d] of others) drawLine(pos, d, SEAT[d.k], now, d.g > 0);
  if (mine) drawLine(mine.pos, mine.d, SEAT[mine.d.k], now, mine.d.g > 0);
  for (const [id, pos, d] of others) drawLeader(id, pos[2], pos[3], pos[0], pos[1], d, SEAT[d.k], false, id === top, now);
  if (mine) drawLeader(me, mine.pos[2], mine.pos[3], mine.pos[0], mine.pos[1], mine.d, SEAT[mine.d.k], true, me === top, now);
  // Names under the others, so a cut has somebody to be aimed at.
  flat();
  for (const [id, pos] of others) fitText(nickOf(id), SX(pos[2]), SY(pos[3]) + RH * sc + 13, 11, INK.text, 90);
  for (const [id, look] of looks) if (now - look.seen > 2000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: a direction in thousandths, or 0 0 to dance straight on,
// and how many shimmies so far. Taking a direction up and letting it go are
// said at once; a change of direction while steering goes out no oftener than
// TURN_EVERY, because a thumb moving in a circle changes it on every move the
// screen reports and the clock's ticks share the same seat's ceiling on
// messages.
const TURN_EVERY = 100;
let wanted = [0, 0];
let lastSaid = [0, 0];
let saidAt = -1e9;
let shimmies = 0;

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
  setHand([d[0], d[1], shimmies]);
}

// A shimmy is asked for no sooner than the floor will allow it, so it is never
// spent on a cooldown; you hear and see it at once, and the floor carries it
// out a trip later on every copy alike.
function shimmy() {
  wake();
  if (!world) return;
  const d = world.p[myId()];
  const now = performance.now();
  if (world.ph === COUNT || world.ph === END || now - myShimmyAt < SHIMMY_MS) return;
  myShimmyAt = now;
  shimmies = (shimmies + 1) % 64;
  lastSaid = wanted;
  saidAt = now;
  setHand([wanted[0], wanted[1], shimmies]);
  if (myPos && d) {
    ring(myPos[0], myPos[1], SEAT[d.k], RH * 2.4);
    spray(myPos[0], myPos[1], 6, 'rgba(255,255,255,0.8)', 0.3, 0.007);
    lookOf(myId()).squash = 1;
    sound.whoosh();
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
    if (!e.repeat) shimmy();
    return;
  }
  if (!RUN_KEYS.includes(e.code)) return;
  e.preventDefault();
  coarse = false;
  mouse = null;
  keys.add(e.code);
  if (!stick) shove(...fromKeys());
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (!stick && !mouse) shove(...fromKeys());
});
addEventListener('blur', () => { keys.clear(); dropStick(); mouse = null; shove(0, 0); });

// A thumb: a stick from wherever it lands, and a tap shimmies — a drag rather
// than a press, because iOS keeps a long press inside a frame for itself. A
// second finger down while the first steers shimmies too. Let go, and the line
// dances straight on.
// A mouse: the leader heads for the pointer wherever it is over the floor, and
// a click shimmies.
const DEAD = 8;
const REACHOUT = 46;
let stick = null;
let mouse = null;      // { x, y }: the pointer, while it is over the canvas
let press = null;      // { id, x, y, at }: a mouse button held, maybe a click

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
    if (stick) { shimmy(); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
    paintStick(0, 0);
    return;
  }
  coarse = false;
  if (e.button !== 0 && e.button !== 2) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mouse = { x: e.clientX, y: e.clientY };
  press = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now() };
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    paintStick(dx, dy);
    const still = Math.hypot(dx, dy) < DEAD;
    if (!still) stick.moved = true;
    shove(still ? 0 : dx, still ? 0 : dy);
  } else if (e.pointerType !== 'touch') {
    if (!mouse && keys.size) return;
    mouse = { x: e.clientX, y: e.clientY };
  }
});
cv.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'touch' || press) return;
  mouse = null;
  shove(...fromKeys());
});
function lift(e) {
  if (stick && e.pointerId === stick.id) {
    const tap = !stick.moved && performance.now() - stick.at < 260;
    dropStick();
    if (tap) shimmy();
  } else if (press && e.pointerId === press.id) {
    const click = Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8 && performance.now() - press.at < 300;
    press = null;
    if (click) shimmy();
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

// The mouse steers toward the pointer. Near enough to the leader it says
// nothing new, so a pointer resting on it does not spin it round.
function steerToMouse() {
  if (!mouse || !myPos || stick) return;
  const r = cv.getBoundingClientRect();
  const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]);
  if (Math.hypot(dx, dy) < 14) return;
  shove(dx, dy);
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

// Called by the kernel once it stands. Dancing straight on is a hand too: it is
// how a leader arrives on the floor.
function start() {
  setHand([0, 0, shimmies]);
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
