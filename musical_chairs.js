/**
 * @disk     musical_chairs
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Musical chairs on a disco floor. Dance out wide to grab notes while the music plays, but when it stops, sit on a chair or spill half your notes. Fewer chairs than dancers, a dash to bump rivals aside, and the last songs pay double.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/musical_chairs.png
 */
// musical_chairs.js — a dance floor where the room's order is the referee.
//
// Every copy holds every dancer, every chair, every note on the floor and how
// long the music has left, and changes it only on what comes back round the
// room, so every copy applies the same hands in the same order and holds the
// same floor. Nobody sends where they sat, what they picked up or whom they
// bumped: a hand is the way a player pushes and a counter that moves on by one
// for every dash, and everything else is the same arithmetic on the same whole
// numbers on every machine. A page with a console open can steer its own
// dancer however it likes, at that dancer's own speed, and dash no oftener than
// the cooldown allows.
//
// While a player is alone, a bot dances with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own dancer does not wait for the trip: it is drawn from the agreed table
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — the floor is 5120 units across, a
// speed is units a step, an angle is a 65536th of a turn — and use nothing but
// `+ - * /`, comparisons, `Math.floor`, `Math.trunc`, `Math.min`, `Math.max`,
// `Math.abs`, `Math.sqrt` and `Math.imul`, whose results the language fixes to
// the last bit. Trigonometry appears only in the drawing, which is nobody's
// business but the screen's.

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

// A way round the circle, ten thousand long, read off a written table rather
// than `Math.cos`: a quarter turn in sixteen parts, the rest by symmetry, and
// whatever lies between two parts by a straight line.
const ANG = 65536;
const QUARTER = [10000, 9952, 9808, 9569, 9239, 8819, 8315, 7730, 7071, 6344, 5556, 4714, 3827, 2903, 1951, 980, 0];
const DIRS = [];
for (let i = 0; i < 64; i++) {
  const q = i >> 4, k = i & 15;
  const c = QUARTER[k], s = QUARTER[16 - k];
  DIRS.push(q === 0 ? [c, s] : q === 1 ? [-s, c] : q === 2 ? [-c, -s] : [s, -c]);
}
function dirOf(a) {
  a &= ANG - 1;
  const i = a >> 10, f = a & 1023, p = DIRS[i], q = DIRS[(i + 1) & 63];
  return [p[0] + Math.trunc(((q[0] - p[0]) * f) / 1024), p[1] + Math.trunc(((q[1] - p[1]) * f) / 1024)];
}

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the game a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own dancer a trip ahead, with your hand in it

// The floor, with a speaker in the middle and the chairs in a ring round it,
// backs to the speaker, the way a party sets them out.
const FW = 5120, FH = 3840, CX = 2560, CY = 1920;
const PR = 120;                // a dancer's radius
const CR = 130;                // a chair's
const SPK = 210;               // the speaker's
const SIT_REACH = PR + CR + 30;
const NOTE_REACH = PR + 80;
const V_WALK = 62;             // a dancer's top speed
const V_TRAIL = 72;            // whoever trails the round dances faster
const DASH_V = 150;
const DASH_HOLD = 6;           // steps of a dash that steering cannot bend
const DASH_CD = 36;            // steps between two dashes
const DASH_CD_TRAIL = 24;
const STUN = 14;               // steps a dancer a dash hits spins dizzy
const KNOCK_V = 110;
const VMAX = 170;
const BUMP = 4;                // what two dancers that touch give each other at the least
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;

// Notes lie on the floor while the music plays; gold ones are worth three.
// They come up away from the chairs, so every one is a step further from a
// seat when the music stops.
const NOTE_EVERY = 8;          // steps between two notes coming up
const NOTES_MAX = 40;          // the most notes on the floor at once, spilled ones included
const GOLD = 3;
const SEAT_PTS = 2;            // notes for sitting down in time
const SPILL_MAX = 6;           // a spill lands as at most this many notes
const NV_MAX = 9999;

const SONGS = 7;               // songs a round
const MUS_MIN = 6 * HZ, MUS_SPAN = 7 * HZ;          // how long the music plays
const MUS_MIN_LATE = 4 * HZ, MUS_SPAN_LATE = 5 * HZ;
const MUS_MOST = MUS_MIN + MUS_SPAN;
const SCR_STEPS = 5 * HZ;      // the longest a scramble for the chairs lasts
const SETTLE_STEPS = 50;       // steps between who sat and the next song
const EL_MAX = 999;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const MUSIC = 0, SCRAMBLE = 1, SETTLE = 2;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const END_STEPS = 6 * HZ;
const PT_MOST = Math.max(COUNT_STEPS, JOIN_STEPS, END_STEPS);

// Fewer chairs than dancers: one short with two or three, about a third short
// with more.
const chairsFor = (n) => Math.max(1, n - Math.ceil(n / 3));
const ringR = (nc) => 380 + 110 * nc;
const late = (w) => w.ph === PLAY && w.sg > SONGS - 2;

function chairAt(w, i) {
  const [ux, uy] = dirOf(w.ca + Math.trunc((i * ANG) / w.nc));
  const r = ringR(w.nc);
  return [CX + Math.trunc((ux * r) / 10000), CY + Math.trunc((uy * r) / 10000)];
}

// Where each seat stands to start a round: out on the floor, as far apart as
// the order allows.
const SPOT_TURN = [0, 4, 2, 6, 1, 5, 3, 7];
function spotOf(s) {
  const [ux, uy] = dirOf(SPOT_TURN[s] * 8192 + 4096);
  return [CX + Math.trunc((ux * 1500) / 10000), CY + Math.trunc((uy * 1300) / 10000)];
}

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   sg: songs played this round; ms: the music, the scramble or the pause after
//   it; mt: steps left of that; el: steps the music has played; ca, cv: the
//   ring of chairs' turn and how fast it spins; nc: chairs; chs: who sits on
//   each, -1 nobody; nts: the notes on the floor, [x, y, worth]; res: the last
//   round's [id, notes, rounds won] rows; win: its winner
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, sg: 1, ms: MUSIC, mt: MUS_MIN, el: 0, ca: 0, cv: 120, nc: 1,
    chs: [-1], nts: [], p: {}, res: null, win: -1,
  };
  return w;
}

const FIELDS = ['c', 's', 'x', 'y', 'vx', 'vy', 'dx', 'dy', 'q', 'hq', 'cd', 'da', 'sn', 'ch', 'nt', 'wn', 'lt',
  'bt', 'bw', 'br', 'hs', 'hc'];
//   c: colour; s: seat; x, y, vx, vy: where and how fast, in units; dx, dy: the
//   way the hand pushes, a thousand at full; q: the dash counter as last heard;
//   hq: a dash to take this step; cd: steps until the next dash; da: steps of a
//   dash left; sn: steps of dizziness left; ch: the chair sat on, -1 standing;
//   nt: notes this round; wn: rounds won; lt: how the last song went, 1 sat, -1
//   left standing, 0 nothing yet; bt, bw, br: the bot's nerve this song, its
//   pause and its reaction to the music stopping; hs, hc: hands this step.
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

function newPlayer(w, q) {
  const s = freeOf(w, 's');
  const [x, y] = spotOf(s);
  return player({
    c: freeOf(w, 'c'), s, x, y, vx: 0, vy: 0, dx: 0, dy: 0, q, hq: 0, cd: 0, da: 0, sn: 0, ch: -1, nt: 0,
    wn: 0, lt: 0, bt: 0, bw: 0, br: 0, hs: w.n, hc: 0,
  });
}

// A hand, at its place in the room's order: [the way pushed, across and down,
// the dash counter]. A dash is asked for once, when the counter changes; the
// same hand said again to keep a player at the table dashes nobody. Being
// heard is how a player arrives: on the floor at once, standing.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[2]);
    d.dx = input[0];
    d.dy = input[1];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.dx = input[0];
  d.dy = input[1];
  if (input[2] !== d.q) { d.q = input[2]; d.hq = 1; }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
// How fast a dancer goes is the table's business: a push names a share of the
// top speed, and nothing a hand says makes it more than all of it.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [a, b, q] = raw;
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(q)) return null;
  if (a < -1000 || a > 1000 || b < -1000 || b > 1000 || q < 0 || q > 999) return null;
  return [a, b, q];
}

// Somebody gone gives their chair back.
function leave(w, id) {
  const d = w.p[id];
  if (d && d.ch >= 0 && d.ch < w.chs.length && w.chs[d.ch] === id) w.chs[d.ch] = -1;
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 4;           // steps between the bot's decisions
const BOT_IDLE = 0.06;         // how often it stands a moment rather than decide
const BOT_DASH = 0.3;          // how often it dashes when a dash would pay
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    w.p[BOT_ID] = newPlayer(w, 0);
    w.p[BOT_ID].bt = 60 + Math.floor(draw01(w) * 160);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// A push toward a point, a thousand long.
function toward(d, x, y) {
  const ex = x - d.x, ey = y - d.y, l = isqrt(ex * ex + ey * ey);
  if (l < 40) { d.dx = d.dy = 0; return; }
  d.dx = Math.trunc((ex * 1000) / l);
  d.dy = Math.trunc((ey * 1000) / l);
}

// Where to wait beside a chair: just outside it, away from the speaker.
function besideChair(w, i) {
  const [x, y] = chairAt(w, i);
  const ex = x - CX, ey = y - CY, l = isqrt(ex * ex + ey * ey) || 1, k = CR + PR + 50;
  return [x + Math.trunc((ex * k) / l), y + Math.trunc((ey * k) / l)];
}

// The bot cannot hear when the music will stop any better than a person can:
// it dances out for notes until its nerve for the song runs out, then hangs
// round the nearest chair, and once the music stops it takes a moment to
// notice before it runs for a free one.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.ch >= 0 || d.sn > 0) return;
  if (w.ms === SCRAMBLE && d.br > 0) { d.br -= 1; return; }
  if (d.bw > 0) { d.bw -= 1; d.dx = d.dy = 0; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (w.ms !== SCRAMBLE && draw01(w) < BOT_IDLE) { d.bw = 3 + Math.floor(draw01(w) * 6); d.dx = d.dy = 0; return; }
  if (w.ms === MUSIC) {
    if (w.el < d.bt) {
      let best = -1, far = BIG;
      w.nts.forEach(([x, y], k) => {
        const f = Math.abs(x - d.x) + Math.abs(y - d.y);
        if (f < far) { far = f; best = k; }
      });
      if (best >= 0) { toward(d, w.nts[best][0], w.nts[best][1]); return; }
    }
    let best = 0, far = BIG;
    for (let i = 0; i < w.nc; i++) {
      const [x, y] = besideChair(w, i);
      const f = Math.abs(x - d.x) + Math.abs(y - d.y);
      if (f < far) { far = f; best = i; }
    }
    const [x, y] = besideChair(w, best);
    toward(d, x, y);
  } else if (w.ms === SCRAMBLE) {
    let best = -1, far = BIG;
    for (let i = 0; i < w.nc; i++) {
      if (w.chs[i] !== -1) continue;
      const [x, y] = chairAt(w, i);
      const f = Math.abs(x - d.x) + Math.abs(y - d.y);
      if (f < far) { far = f; best = i; }
    }
    if (best < 0) { d.dx = d.dy = 0; return; }
    const [x, y] = chairAt(w, best);
    toward(d, x, y);
    if (d.cd === 0 && far > 500 && far < 1400 && draw01(w) < BOT_DASH) d.hq = 1;
  } else {
    d.dx = d.dy = 0;
  }
}

// ── a step ─────────────────────────────────────────────────────────────────
// A song: everybody up, a chair for all but a few, the ring set spinning one
// way or the other, and music for a while nobody can read off a clock.
function startSong(w) {
  w.sg += 1;
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (d.ch >= 0) {
      // Up off the chair and a step out of the ring, before the ring moves.
      const ex = d.x - CX, ey = d.y - CY, l = isqrt(ex * ex + ey * ey) || 1, k = CR + PR + 30;
      d.x = clamp(d.x + Math.trunc((ex * k) / l), PR, FW - PR);
      d.y = clamp(d.y + Math.trunc((ey * k) / l), PR, FH - PR);
    }
    d.ch = -1;
    d.lt = 0;
    d.bt = 60 + Math.floor(draw01(w) * 160);
    d.br = 0;
  }
  w.nc = chairsFor(ids.length);
  w.chs = new Array(w.nc).fill(-1);
  w.cv = (draw01(w) < 0.5 ? -1 : 1) * (90 + Math.floor(draw01(w) * 90));
  w.mt = late(w) ? MUS_MIN_LATE + Math.floor(draw01(w) * MUS_SPAN_LATE) : MUS_MIN + Math.floor(draw01(w) * MUS_SPAN);
  w.el = 0;
  w.ms = MUSIC;
  fx(w, 'song', 0, 0, w.sg);
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  w.sg = 0;
  startSong(w);
}

// A round: the seats closed up in order, everybody at a spot of their own with
// no notes, the floor swept.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.sg = 0;
  w.nts = [];
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  for (const id of ids) {
    const d = w.p[id];
    [d.x, d.y] = spotOf(d.s);
    d.vx = d.vy = d.cd = d.da = d.sn = d.hq = 0;
    d.ch = -1;
    d.nt = 0;
    d.lt = 0;
  }
  w.nc = chairsFor(ids.length);
  w.chs = new Array(w.nc).fill(-1);
  w.ms = SETTLE;
  w.mt = 0;
  w.el = 0;
  fx(w, 'round', 0, 0, 0);
}

// The last song is over: the round to whoever holds the most notes, if nobody
// matches them.
function finish(w) {
  const ids = bySeat(w);
  let top = -1;
  for (const id of ids) top = Math.max(top, w.p[id].nt);
  const best = ids.filter((id) => w.p[id].nt === top);
  w.win = best.length === 1 && ids.length > 1 ? best[0] : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  const res = ids.map((id) => [id, w.p[id].nt, w.p[id].wn]);
  res.sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, 0, w.win);
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
    if (w.pt <= 0) { w.ph = PLAY; w.pt = 0; startSong(w); fx(w, 'go', 0, 0, 0); }
  } else if (w.ph === END) {
    w.pt -= 1;
    if (w.pt <= 0) begin(w);
  }
  // Nobody moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      d.hq = 0;
      d.vx = d.vy = d.da = 0;
    }
    return;
  }
  dance(w);
}

function dance(w) {
  botThink(w);
  const ids = bySeat(w);
  const trail = trailing(w, ids);
  for (const id of ids) control(w, w.p[id], id, trail.has(id));
  for (const id of ids) {
    const d = w.p[id];
    if (d.ch >= 0) continue;
    d.x += d.vx;
    d.y += d.vy;
    walls(d);
    if (d.cd > 0) d.cd -= 1;
    if (d.da > 0) d.da -= 1;
    if (d.sn > 0) d.sn -= 1;
  }
  props(w, ids);
  clash(w, ids);
  if (w.ms === MUSIC) {
    w.el = Math.min(EL_MAX, w.el + 1);
    w.ca = (w.ca + w.cv) & (ANG - 1);
    if (w.el % NOTE_EVERY === 0) sprout(w, ids.length);
    for (const id of ids) gather(w, w.p[id], id);
    w.mt -= 1;
    if (w.mt <= 0) musicStops(w);
  } else if (w.ms === SCRAMBLE) {
    sit(w, ids);
    w.mt -= 1;
    const standing = ids.filter((id) => w.p[id].ch < 0).length;
    if (w.mt <= 0 || standing === 0 || !w.chs.includes(-1)) settle(w, ids);
  } else {
    w.mt -= 1;
    if (w.mt <= 0) {
      if (w.ph === PLAY && w.sg >= SONGS) finish(w);
      else startSong(w);
    }
  }
}

// Whoever holds the fewest notes, when somebody holds more, dances faster and
// dashes oftener.
function trailing(w, ids) {
  if (ids.length < 2) return new Set();
  let lo = BIG, hi = -1;
  for (const id of ids) { lo = Math.min(lo, w.p[id].nt); hi = Math.max(hi, w.p[id].nt); }
  return hi > lo ? new Set(ids.filter((id) => w.p[id].nt === lo)) : new Set();
}

// A push becomes a speed, a share of the gap closed each step. A dash asked
// for is taken if the cooldown is over: it flings the dancer the way pushed,
// and steering waits until it is spent. Somebody sitting stays sat, and
// somebody dizzy slides on without a say.
function control(w, d, id, trails) {
  if (d.ch >= 0) { d.vx = d.vy = d.hq = d.da = 0; return; }
  if (d.sn > 0) {
    d.hq = 0;
    d.vx = Math.trunc((d.vx * 7) / 8);
    d.vy = Math.trunc((d.vy * 7) / 8);
    return;
  }
  if (d.hq) {
    d.hq = 0;
    if (d.cd === 0 && w.ms !== SETTLE) {
      const push = isqrt(d.dx * d.dx + d.dy * d.dy), sp = isqrt(d.vx * d.vx + d.vy * d.vy);
      let ux = 0, uy = 0, l = 0;
      if (push >= 300) { ux = d.dx; uy = d.dy; l = push; } else if (sp >= 3) { ux = d.vx; uy = d.vy; l = sp; }
      if (l) {
        d.vx = clampV(Math.trunc((ux * DASH_V) / l));
        d.vy = clampV(Math.trunc((uy * DASH_V) / l));
        d.cd = trails ? DASH_CD_TRAIL : DASH_CD;
        d.da = DASH_HOLD;
        fx(w, 'dash', d.x, d.y, 0, id);
        return;
      }
    }
  }
  if (d.da > 0) return;
  const vm = trails ? V_TRAIL : V_WALK;
  const push = isqrt(d.dx * d.dx + d.dy * d.dy);
  const tx = push < 120 ? 0 : Math.trunc((d.dx * vm) / Math.max(push, 1000));
  const ty = push < 120 ? 0 : Math.trunc((d.dy * vm) / Math.max(push, 1000));
  d.vx += Math.trunc(((tx - d.vx) * 22) / 64);
  d.vy += Math.trunc(((ty - d.vy) * 22) / 64);
  if (Math.abs(tx - d.vx) <= 2) d.vx = tx;
  if (Math.abs(ty - d.vy) <= 2) d.vy = ty;
}

const clampV = (v) => (v < -VMAX ? -VMAX : v > VMAX ? VMAX : v);

// The floor's edge is a wall: a dancer stops at it and bounces back a little.
function walls(d) {
  if (d.x < PR) { d.x = PR; if (d.vx < 0) d.vx = -Math.trunc(d.vx / 2); }
  if (d.x > FW - PR) { d.x = FW - PR; if (d.vx > 0) d.vx = -Math.trunc(d.vx / 2); }
  if (d.y < PR) { d.y = PR; if (d.vy < 0) d.vy = -Math.trunc(d.vy / 2); }
  if (d.y > FH - PR) { d.y = FH - PR; if (d.vy > 0) d.vy = -Math.trunc(d.vy / 2); }
}

// A dancer pushed out of a round thing that does not move, losing whatever of
// its speed ran into it.
function pushOut(d, cx, cy, reach) {
  let ex = d.x - cx, ey = d.y - cy;
  const d2 = ex * ex + ey * ey;
  if (d2 >= reach * reach) return;
  let far = isqrt(d2);
  if (far === 0) { ex = 1; ey = 0; far = 1; }
  d.x = cx + Math.trunc((ex * reach) / far);
  d.y = cy + Math.trunc((ey * reach) / far);
  const vn = Math.trunc((d.vx * ex + d.vy * ey) / far);
  if (vn < 0) {
    d.vx -= Math.trunc((ex * vn) / far);
    d.vy -= Math.trunc((ey * vn) / far);
  }
  walls(d);
}

// The speaker stands in everybody's way. A chair is in the way while the
// music plays and nobody may sit; once it stops, a free chair is there to be
// sat on, and a taken one is in the way as its sitter.
function props(w, ids) {
  for (const id of ids) {
    const d = w.p[id];
    if (d.ch >= 0) continue;
    pushOut(d, CX, CY, SPK + PR);
    if (w.ms === SCRAMBLE) continue;
    for (let i = 0; i < w.nc; i++) {
      if (w.chs[i] !== -1) continue;
      const [x, y] = chairAt(w, i);
      pushOut(d, x, y, CR + PR);
    }
  }
}

// Two dancers that touch push apart and bounce. A dash that lands on a dancer
// who is not dashing spins them dizzy and sends them sliding. Somebody sitting
// does not budge.
function clash(w, ids) {
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      const p = w.p[ids[a]], o = w.p[ids[b]];
      const reach = 2 * PR;
      let dx = o.x - p.x, dy = o.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= reach * reach) continue;
      if (p.ch >= 0 && o.ch >= 0) continue;
      let far = isqrt(d2);
      if (far === 0) { dx = ids[a] < ids[b] ? 1 : -1; dy = 0; far = 1; }
      const over = reach - far + 1;
      if (p.ch >= 0) {
        o.x += Math.trunc((dx * over) / far);
        o.y += Math.trunc((dy * over) / far);
      } else if (o.ch >= 0) {
        p.x -= Math.trunc((dx * over) / far);
        p.y -= Math.trunc((dy * over) / far);
      } else {
        p.x -= Math.trunc((dx * over) / (2 * far));
        p.y -= Math.trunc((dy * over) / (2 * far));
        o.x += Math.trunc((dx * over) / (2 * far));
        o.y += Math.trunc((dy * over) / (2 * far));
      }
      const closing = Math.max(0, Math.trunc(((p.vx - o.vx) * dx + (p.vy - o.vy) * dy) / far));
      if (p.da > 0 && o.da === 0 && o.ch < 0) knock(w, ids[a], ids[b], dx, dy, far);
      else if (o.da > 0 && p.da === 0 && p.ch < 0) knock(w, ids[b], ids[a], -dx, -dy, far);
      else {
        const j = Math.trunc(closing / 2) + BUMP;
        if (p.ch < 0) { p.vx = clampV(p.vx - Math.trunc((dx * j) / far)); p.vy = clampV(p.vy - Math.trunc((dy * j) / far)); }
        if (o.ch < 0) { o.vx = clampV(o.vx + Math.trunc((dx * j) / far)); o.vy = clampV(o.vy + Math.trunc((dy * j) / far)); }
        if (closing > 30) fx(w, 'bump', p.x + Math.trunc((dx * PR) / far), p.y + Math.trunc((dy * PR) / far), closing, ids[a], ids[b]);
      }
      walls(p);
      walls(o);
    }
  }
}

// `ex, ey` point from the dasher to whoever it hit.
function knock(w, hid, vid, ex, ey, far) {
  const h = w.p[hid], v = w.p[vid];
  if (v.sn > 0) return;
  v.sn = STUN;
  v.da = 0;
  v.vx = clampV(Math.trunc((ex * KNOCK_V) / far));
  v.vy = clampV(Math.trunc((ey * KNOCK_V) / far));
  h.vx = Math.trunc(h.vx / 3);
  h.vy = Math.trunc(h.vy / 3);
  h.da = 0;
  fx(w, 'knock', v.x, v.y, 0, hid, vid);
}

// A note comes up somewhere on the floor clear of the chairs and the speaker,
// now and then a gold one, while there are fewer than the dancers could want.
function sprout(w, n) {
  if (w.nts.length >= Math.min(NOTES_MAX, 8 + 2 * n)) return;
  const keep = ringR(w.nc) + CR + 320;
  for (let tries = 0; tries < 8; tries++) {
    const x = 220 + Math.floor(draw01(w) * (FW - 440)), y = 220 + Math.floor(draw01(w) * (FH - 440));
    const ex = x - CX, ey = y - CY;
    if (ex * ex + ey * ey < keep * keep) continue;
    if (w.nts.some(([a, b]) => Math.abs(a - x) + Math.abs(b - y) < 400)) continue;
    w.nts.push([x, y, draw01(w) < 0.14 ? GOLD : 1]);
    return;
  }
}

// Notes are picked up only while the music plays: the scramble is for chairs.
// The last two songs of a round pay double.
function gather(w, d, id) {
  if (d.ch >= 0) return;
  const mult = late(w) ? 2 : 1;
  for (let k = w.nts.length - 1; k >= 0; k--) {
    const [x, y, v] = w.nts[k];
    const ex = x - d.x, ey = y - d.y;
    if (ex * ex + ey * ey > NOTE_REACH * NOTE_REACH) continue;
    w.nts.splice(k, 1);
    d.nt = Math.min(NV_MAX * 10, d.nt + v * mult);
    fx(w, 'note', x, y, v * mult, id);
  }
}

// The music stops. Whoever is touching a free chair sits at once; the rest run.
function musicStops(w) {
  w.ms = SCRAMBLE;
  w.mt = SCR_STEPS;
  const bot = w.p[BOT_ID];
  if (bot) bot.br = 4 + Math.floor(draw01(w) * 9);
  fx(w, 'stop', 0, 0, 0);
}

// A free chair goes to the nearest standing dancer within reach of it, the
// earlier seat on a tie: one chair, one dancer, the same on every copy.
function sit(w, ids) {
  for (let i = 0; i < w.nc; i++) {
    if (w.chs[i] !== -1) continue;
    const [x, y] = chairAt(w, i);
    let best = -1, near = BIG;
    for (const id of ids) {
      const d = w.p[id];
      if (d.ch >= 0) continue;
      const ex = d.x - x, ey = d.y - y, d2 = ex * ex + ey * ey;
      if (d2 > SIT_REACH * SIT_REACH || d2 >= near) continue;
      near = d2;
      best = id;
    }
    if (best === -1) continue;
    const d = w.p[best];
    w.chs[i] = best;
    d.ch = i;
    d.x = x;
    d.y = y;
    d.vx = d.vy = d.da = d.sn = d.hq = 0;
    fx(w, 'sit', x, y, i, best);
  }
}

// Who sat gets notes for it; whoever is left standing spills half of theirs
// round where they stand, for anybody to grab when the music starts again.
function settle(w, ids) {
  const mult = late(w) ? 2 : 1;
  for (const id of ids) {
    const d = w.p[id];
    if (d.ch >= 0) {
      d.nt = Math.min(NV_MAX * 10, d.nt + SEAT_PTS * mult);
      d.lt = 1;
      fx(w, 'seated', d.x, d.y, SEAT_PTS * mult, id);
    } else {
      d.lt = -1;
      const lost = Math.floor(d.nt / 2);
      d.nt -= lost;
      spill(w, d, lost);
      fx(w, 'out', d.x, d.y, lost, id);
    }
  }
  w.ms = SETTLE;
  w.mt = SETTLE_STEPS;
}

function spill(w, d, lost) {
  const k = Math.min(SPILL_MAX, lost);
  if (k <= 0) return;
  const each = Math.floor(lost / k);
  const turn = Math.floor(draw01(w) * ANG);
  const keep = ringR(w.nc) + CR + 200;
  for (let i = 0; i < k; i++) {
    if (w.nts.length >= NOTES_MAX) w.nts.shift();
    const [ux, uy] = dirOf(turn + Math.trunc((i * ANG) / k));
    const far = 420 + Math.floor(draw01(w) * 360);
    let x = clamp(d.x + Math.trunc((ux * far) / 10000), 220, FW - 220);
    let y = clamp(d.y + Math.trunc((uy * far) / 10000), 220, FH - 220);
    // Kept off the ring of chairs, so a spilled note is never a seat in disguise.
    const ex = x - CX, ey = y - CY, l = isqrt(ex * ex + ey * ey);
    if (l < keep) {
      const m = l || 1, gx = l ? ex : 1, gy = l ? ey : 0;
      x = clamp(CX + Math.trunc((gx * keep) / m), 220, FW - 220);
      y = clamp(CY + Math.trunc((gy * keep) / m), 220, FH - 220);
    }
    w.nts.push([x, y, Math.min(NV_MAX, each + (i === 0 ? lost - each * k : 0))]);
  }
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PT_MOST)) return null;
  if (!int(raw.sg, 0, BIG) || ![MUSIC, SCRAMBLE, SETTLE].includes(raw.ms) || !int(raw.mt, 0, MUS_MOST)) return null;
  if (!int(raw.el, 0, EL_MAX) || !int(raw.ca, 0, ANG - 1) || !int(raw.cv, -400, 400)) return null;
  if (!int(raw.nc, 1, MAX_P) || !Array.isArray(raw.chs) || raw.chs.length !== raw.nc) return null;
  if (!Array.isArray(raw.nts) || raw.nts.length > NOTES_MAX) return null;
  if (!raw.nts.every((t) => Array.isArray(t) && t.length === 3 && int(t[0], 0, FW) && int(t[1], 0, FH) && int(t[2], 1, NV_MAX))) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.x, 0, FW) || !int(d.y, 0, FH)) return null;
    if (!int(d.vx, -VMAX, VMAX) || !int(d.vy, -VMAX, VMAX) || inputOf([d.dx, d.dy, d.q]) === null) return null;
    if (!int(d.hq, 0, 1) || !int(d.cd, 0, DASH_CD) || !int(d.da, 0, DASH_HOLD) || !int(d.sn, 0, STUN)) return null;
    if (!int(d.ch, -1, raw.nc - 1) || (d.ch >= 0 && raw.chs[d.ch] !== Number(id))) return null;
    if (!int(d.nt, 0, NV_MAX * 10) || !int(d.wn, 0, 99999) || !int(d.lt, -1, 1)) return null;
    if (!int(d.bt, 0, 999) || !int(d.bw, 0, 99) || !int(d.br, 0, 99)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  for (let i = 0; i < raw.nc; i++) {
    const c = raw.chs[i];
    if (c !== -1 && (!Number.isInteger(c) || !p[c] || p[c].ch !== i)) return null;
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 3 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, sg: raw.sg, ms: raw.ms, mt: raw.mt, el: raw.el, ca: raw.ca,
    cv: raw.cv, nc: raw.nc, chs: raw.chs.slice(), nts: raw.nts.map((t) => t.slice()), p, res, win: raw.win,
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
// One palette: a dance hall at night. A floor of violet tiles that light up to
// the beat, warm wooden chairs, a speaker in the middle, notes in neon cyan and
// gold, and every dancer a round body in their player's bright colour.
const INK = {
  page: '#1a1033', glow: '#3d2170', text: '#ffffff', muted: '#dcd2f7', dim: '#9d90c6', gold: '#ffd166',
  danger: '#ff5a6e', floorA: '#2c1e55', floorB: '#251849', rim: '#120a2a', panel: 'rgba(20,12,44,0.93)',
  note: '#7ef0ff', wood: '#e3a35c', woodDark: '#a5662f', woodLight: '#f5c98d', box: '#241d3d', cone: '#4f4282',
};
const SEAT = ['#ff4f7b', '#3fa9ff', '#ffb020', '#9cff3a', '#e25cff', '#20e3ff', '#ff7a2e', '#7d6bff'];
const FONT = "700 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));
const CELL = 256;

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
  `background:#2c2160;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, sc = 0.05, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340;
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

// The whole floor is always on screen, as large as it fits. NOTE_ROOM under it
// keeps the practice note off the bottom row, and in a round the same strip
// says how many notes you hold and whether a dash is ready.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  sc = Math.max(0.005, Math.min((VW - 16) / FW, ah / FH));
  ox = (VW - FW * sc) / 2;
  oy = TOP + (ah - FH * sc) / 2;
  fieldTop = oy;
  fieldBot = oy + FH * sc;
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
function outlined(s, x, y, px, colour, line) {
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = line || 5;
  ctx.strokeStyle = 'rgba(20,10,40,0.7)';
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

// The tempo of a song, the same on every copy: a little faster each song, and
// faster again for the last two of a round.
const bpmOf = (t) => 104 + 6 * Math.min(t.sg, 8) + (late(t) ? 14 : 0);

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
function tone(freq, dur, type, vol, slide, delay, at, out) {
  const t = at !== undefined ? at : actx.currentTime + (delay || 0);
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(out || actx.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}
function puff(dur, vol, freq, delay, q, at, out) {
  if (!noise) {
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.6), actx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = at !== undefined ? at : actx.currentTime + (delay || 0);
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  src.buffer = noise;
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q || 1.2;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(out || actx.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}
const sound = {
  note(v) { if (ready('note', 50)) { tone(880 + 120 * Math.min(v, 6), 0.09, 'triangle', 0.07, 1.5); tone(1320, 0.07, 'sine', 0.04, 0, 0.05); } },
  dash() { if (ready('dash', 80)) { puff(0.2, 0.07, 1600, 0, 0.9); tone(300, 0.15, 'triangle', 0.05, 1.8); } },
  knock(near) { if (ready('knock', 80)) { tone(180, 0.18, 'square', 0.05 + 0.05 * near, 0.4); puff(0.15, 0.08 * near + 0.03, 900, 0, 1.4); } },
  bump(hard) { if (ready('bump', 90)) tone(150 + 60 * hard, 0.08, 'sine', 0.06, 0.6); },
  scratch() {
    if (!ready('scratch', 300)) return;
    puff(0.32, 0.14, 2200, 0, 3);
    tone(700, 0.35, 'sawtooth', 0.06, 0.2);
    tone(90, 0.3, 'sine', 0.1, 0.5, 0.05);
  },
  sit(mine) { if (ready('sit', 50)) { tone(140, 0.12, 'sine', 0.1, 0.6); puff(0.08, 0.06, 500, 0, 1); if (mine) [659, 880].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, 0.05 + i * 0.07)); } },
  out() { if (ready('out', 300)) [392, 330, 247].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.04, 1, i * 0.12)); },
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

// The music itself: a loop of sixteen eighths — a kick, a bass, a hat and a
// little tune in a key of the song's own — played while the agreed table says
// the music is on and cut dead the moment it says it stopped. It is scheduled
// a moment ahead into a bus of its own, and dropping the bus is the cut, so
// nothing already scheduled plays on past the stop.
let bus = null, busSong = '', busNext = 0, busStep = 0;
const ROOTS = [220, 247, 196, 262, 233, 208];
const SCALE = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4];
function tuneOf(seed) {
  const out = [];
  let h = (seed * 2654435761) >>> 0;
  for (let i = 0; i < 16; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    out.push(i % 4 === 3 && h % 3 === 0 ? -1 : h % SCALE.length);
  }
  return out;
}
function cutMusic() {
  if (!bus) return;
  const g = bus;
  bus = null;
  busSong = '';
  try {
    g.gain.cancelScheduledValues(actx.currentTime);
    g.gain.setValueAtTime(g.gain.value, actx.currentTime);
    g.gain.linearRampToValueAtTime(0, actx.currentTime + 0.03);
  } catch (_) { /* a context closing under it */ }
  setTimeout(() => { try { g.disconnect(); } catch (_) { /* already gone */ } }, 200);
}
function playMusic(t) {
  const on = t.ms === MUSIC && (t.ph === WAIT || t.ph === PLAY);
  if (!on || !actx || muted || actx.state !== 'running') { cutMusic(); return; }
  const id = t.rd + ':' + t.sg + ':' + t.ph;
  if (!bus || busSong !== id) {
    cutMusic();
    bus = actx.createGain();
    bus.gain.value = 0.55;
    bus.connect(actx.destination);
    busSong = id;
    busNext = actx.currentTime + 0.04;
    busStep = 0;
  }
  // A page that was away comes back in step rather than playing the gap at once.
  if (busNext < actx.currentTime - 0.05) busNext = actx.currentTime + 0.02;
  const bpm = bpmOf(t), eighth = 30 / bpm;
  const root = ROOTS[(t.sg + t.rd) % ROOTS.length], tune = tuneOf(t.sg * 31 + t.rd * 7 + 1);
  while (busNext < actx.currentTime + 0.12) {
    const k = busStep % 16, at = busNext;
    if (k % 4 === 0) tone(110, 0.16, 'sine', 0.16, 0.4, 0, at, bus);
    if (k % 2 === 0) tone(root / 2 * (k % 8 === 4 ? 1.5 : 1), eighth * 1.6, 'triangle', 0.07, 0, 0, at, bus);
    else puff(0.04, 0.025, 7000, 0, 2, at, bus);
    if (tune[k] >= 0) tone(root * 2 * SCALE[tune[k]], eighth * 0.9, 'square', 0.022, 0, 0, at, bus);
    busNext += eighth;
    busStep += 1;
  }
}

// ── bits: particles, pops, rings, shake ────────────────────────────────────
// Stepped on a clock of their own at a fixed rate, never once per frame, so a
// fast screen and a slow one see the same confetti. Positions are field units.
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
const looks = new Map();      // id -> { x, y, fx, fy, squash, seen }
let drawFailed = false;
let stopAt = -1e9;            // when the music last stopped, on this screen

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = md ? Math.max(0, 1 - (Math.abs(md.x - e.x) + Math.abs(md.y - e.y)) / (8 * CELL)) : 0.3;
  if (e.kind === 'note') {
    spray(e.x, e.y, 10, e.z >= GOLD ? INK.gold : INK.note, 2.5 * CELL, 26);
    pop(e.x, e.y, '+' + e.z, e.z >= GOLD ? INK.gold : INK.note, e.a === me ? 16 : 12);
    if (e.a === me) sound.note(e.z);
  } else if (e.kind === 'dash') {
    spray(e.x, e.y, 8, '#ffffff', 2 * CELL, 22);
    if (e.a !== me) sound.dash();
  } else if (e.kind === 'knock') {
    spray(e.x, e.y, 14, INK.gold, 3 * CELL, 26);
    pop(e.x, e.y, 'bonk!', INK.gold, e.a === me || e.b === me ? 18 : 14);
    if (e.a === me || e.b === me) shake = Math.max(shake, e.b === me ? 12 : 6);
    const look = looks.get(e.b);
    if (look) look.squash = 1;
    sound.knock(e.a === me || e.b === me ? 1 : near);
  } else if (e.kind === 'bump') {
    spray(e.x, e.y, 5, '#ffffff', 1.5 * CELL, 18);
    for (const id of [e.a, e.b]) { const look = looks.get(id); if (look) look.squash = 0.6; }
    if (e.a === me || e.b === me) sound.bump(Math.min(1, e.z / 80));
  } else if (e.kind === 'stop') {
    stopAt = performance.now();
    shake = Math.max(shake, 5);
    sound.scratch();
  } else if (e.kind === 'sit') {
    ring(e.x, e.y, colourOf(t, e.a), 2 * CELL);
    spray(e.x, e.y, 10, colourOf(t, e.a), 2 * CELL, 24);
    const look = looks.get(e.a);
    if (look) look.squash = 0.9;
    if (e.a === me) pop(e.x, e.y - CR, 'sat!', INK.text, 18);
    sound.sit(e.a === me);
  } else if (e.kind === 'seated') {
    pop(e.x, e.y + CR, '+' + e.z, INK.gold, e.a === me ? 16 : 12);
  } else if (e.kind === 'out') {
    spray(e.x, e.y, 16, INK.note, 3 * CELL, 26);
    pop(e.x, e.y - PR, e.z > 0 ? '-' + e.z : 'no chair!', INK.danger, e.a === me ? 20 : 14);
    if (e.a === me) { shake = Math.max(shake, 10); sound.out(); }
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

function drawSky(now) {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.8);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // Specks of light from a mirror ball, turning slowly over the hall.
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  for (let i = 0; i < 24; i++) {
    const a = now / 5000 + i * 2.39;
    const x = VW / 2 + Math.cos(a) * VW * (0.18 + (i % 5) * 0.08);
    const y = VH / 2 + Math.sin(a * 1.3) * VH * (0.2 + (i % 4) * 0.08);
    disc(x, y, 1 + (i % 3) * 0.7);
    ctx.fill();
  }
}

// The floor: tiles, and while the music plays some of them lit to the beat in
// the dancers' colours. When it stops the lights go out but for a red wash.
function drawFloor(t, beat, now) {
  flat();
  const x0 = SX(0), y0 = SY(0), w = FW * sc, h = FH * sc, c = CELL * sc;
  ctx.fillStyle = 'rgba(5,2,15,0.45)';
  roundRect(x0 - 3, y0 + 3, w + 10, h + 8, 12);
  ctx.fill();
  ctx.fillStyle = INK.rim;
  roundRect(x0 - 5, y0 - 5, w + 10, h + 10, 12);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, w, h, 8);
  ctx.clip();
  ctx.fillStyle = INK.floorB;
  ctx.fillRect(x0, y0, w, h);
  const music = t.ms === MUSIC && (t.ph === WAIT || t.ph === PLAY);
  const bn = Math.floor(beat), bk = beat - bn;
  for (let j = 0; j < FH / CELL; j++) {
    for (let i = 0; i < FW / CELL; i++) {
      const x = x0 + i * c, y = y0 + j * c;
      ctx.fillStyle = (i + j) % 2 ? INK.floorA : INK.floorB;
      ctx.fillRect(x + 0.5, y + 0.5, c - 1, c - 1);
      if (!music) continue;
      const hsh = ((i * 73856093) ^ (j * 19349663) ^ (bn * 83492791)) >>> 0;
      if (hsh % 7 !== 0) continue;
      ctx.fillStyle = alpha(SEAT[hsh % SEAT.length], (0.32 * (1 - bk)).toFixed(3));
      ctx.fillRect(x + 1, y + 1, c - 2, c - 2);
    }
  }
  if (t.ms === SCRAMBLE) {
    ctx.fillStyle = `rgba(255,60,90,${(0.08 + 0.06 * Math.sin(now / 90)).toFixed(3)})`;
    ctx.fillRect(x0, y0, w, h);
  }
  ctx.restore();
}

// The speaker: a box with a cone that thumps on the beat, and notes rising off
// it while the music plays.
function drawSpeaker(t, beat, now) {
  const x = SX(CX), y = SY(CY), r = SPK * sc;
  const music = t.ms === MUSIC && (t.ph === WAIT || t.ph === PLAY);
  const thump = music ? Math.pow(1 - (beat % 1), 3) : 0;
  ctx.fillStyle = 'rgba(5,2,15,0.35)';
  roundRect(x - r * 0.9, y - r * 0.75, r * 2, r * 1.9, r * 0.3);
  ctx.fill();
  ctx.fillStyle = INK.box;
  roundRect(x - r, y - r, r * 2, r * 2, r * 0.3);
  ctx.fill();
  ctx.strokeStyle = '#3a3060';
  ctx.lineWidth = Math.max(1, r * 0.06);
  ctx.stroke();
  ctx.fillStyle = INK.cone;
  disc(x, y, r * (0.68 + 0.08 * thump));
  ctx.fill();
  ctx.fillStyle = '#2a2050';
  disc(x, y, r * (0.3 + 0.05 * thump));
  ctx.fill();
  ctx.fillStyle = music ? INK.note : INK.danger;
  disc(x, y, r * 0.12);
  ctx.fill();
  if (music) {
    for (let k = 0; k < 3; k++) {
      const f = ((now / 1400 + k / 3) % 1);
      ctx.globalAlpha = 1 - f;
      noteGlyph(x + Math.sin(f * 6 + k * 2) * r * 0.7, y - r - f * r * 2.2, r * 0.32, SEAT[(k * 3 + t.sg) % SEAT.length]);
      ctx.globalAlpha = 1;
    }
  }
}

// An eighth note: a head, a stem and a flag.
function noteGlyph(x, y, s, colour) {
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;
  ctx.beginPath();
  ctx.ellipse(x - s * 0.25, y + s * 0.55, s * 0.42, s * 0.3, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1, s * 0.16);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.12, y + s * 0.5);
  ctx.lineTo(x + s * 0.12, y - s * 0.75);
  ctx.quadraticCurveTo(x + s * 0.6, y - s * 0.45, x + s * 0.55, y - s * 0.05);
  ctx.stroke();
}

function drawNotes(t, now) {
  for (let k = 0; k < t.nts.length; k++) {
    const [nx, ny, v] = t.nts[k];
    const x = SX(nx), y = SY(ny) + Math.sin(now / 300 + k) * 2;
    const gold = v >= GOLD, s = (gold ? 150 : 110) * sc;
    ctx.fillStyle = gold ? 'rgba(255,209,102,0.22)' : 'rgba(126,240,255,0.16)';
    disc(x, y, s * 1.15);
    ctx.fill();
    noteGlyph(x, y, s, gold ? INK.gold : INK.note);
    if (v > GOLD || (v > 1 && !gold)) text(String(v), x + s * 0.9, y + s * 0.9, Math.max(8, s * 0.7), INK.text, 'center');
  }
}

// A chair, seen from above: a seat and a back, the back toward the speaker.
// While the scramble is on, a free one glows.
function drawChair(x, y, ang, taken, colour, glow, now) {
  const r = CR * sc;
  ctx.save();
  ctx.translate(SX(x), SY(y));
  ctx.rotate(ang);
  if (glow) {
    ctx.fillStyle = `rgba(255,209,102,${(0.25 + 0.2 * Math.sin(now / 90)).toFixed(3)})`;
    disc(0, 0, r * 1.7);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(5,2,15,0.35)';
  roundRect(-r * 0.75, -r * 0.6, r * 1.8, r * 1.6, r * 0.3);
  ctx.fill();
  ctx.fillStyle = taken ? colour : INK.wood;
  roundRect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7, r * 0.35);
  ctx.fill();
  ctx.fillStyle = taken ? darker(colour, 0.25) : INK.woodLight;
  roundRect(-r * 0.6, -r * 0.6, r * 1.2, r * 1.2, r * 0.25);
  ctx.fill();
  ctx.fillStyle = taken ? darker(colour, 0.45) : INK.woodDark;
  roundRect(-r * 1.15, -r * 0.95, r * 0.4, r * 1.9, r * 0.18);
  ctx.fill();
  ctx.restore();
}

// A dancer: a round body on its shadow in its player's colour, eyes the way it
// moves, a bounce on the beat while the music plays, stars round its head while
// it is dizzy, streaks behind a dash.
function drawDancer(id, x, y, d, colour, me, boost, beat, music, now) {
  let look = looks.get(id);
  if (!look) looks.set(id, (look = { x, y, fx: 0, fy: 1, squash: 0, seen: now }));
  const mx = x - look.x, my = y - look.y, l = Math.hypot(mx, my);
  if (l > 1) {
    look.fx = lerp(look.fx, mx / l, per60(0.3));
    look.fy = lerp(look.fy, my / l, per60(0.3));
  }
  look.x = x; look.y = y; look.seen = now;
  look.squash *= Math.pow(0.86, frameDt * 60);
  const r = PR * sc, sx = SX(x), sy = SY(y);
  const bob = music && d.ch < 0 ? Math.abs(Math.sin(beat * Math.PI)) : 0;
  const sq = look.squash, rx = r * (1 + sq * 0.2 - bob * 0.05), ry = r * (1 - sq * 0.15 + bob * 0.08);
  const lift = bob * r * 0.25;
  ctx.fillStyle = 'rgba(5,2,15,0.35)';
  ctx.beginPath(); ctx.ellipse(sx + r * 0.2, sy + r * 0.5, r * 0.95, r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
  if (d.da > 0) {
    ctx.strokeStyle = alpha(colour, 0.6);
    ctx.lineWidth = Math.max(1.5, r * 0.18);
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(sx - look.fx * r * 1.2 - look.fy * k * r * 0.5, sy - look.fy * r * 1.2 + look.fx * k * r * 0.5);
      ctx.lineTo(sx - look.fx * r * 2.4 - look.fy * k * r * 0.5, sy - look.fy * r * 2.4 + look.fx * k * r * 0.5);
      ctx.stroke();
    }
  }
  const by = sy - lift;
  ctx.fillStyle = darker(colour, 0.25);
  ctx.beginPath(); ctx.ellipse(sx, by + r * 0.08, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.ellipse(sx, by, rx * 0.96, ry * 0.92, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.ellipse(sx - r * 0.35, by - r * 0.4, r * 0.25, r * 0.15, -0.6, 0, Math.PI * 2); ctx.fill();
  // Eyes, looking the way the dancer goes; crosses while dizzy.
  const ex = look.fx * r * 0.28, ey = look.fy * r * 0.22;
  for (const side of [-1, 1]) {
    const cx = sx + side * r * 0.32 + ex * 0.5, cy = by - r * 0.08 + ey * 0.5;
    if (d.sn > 0) {
      ctx.strokeStyle = '#1a1033';
      ctx.lineWidth = Math.max(1, r * 0.1);
      const s = r * 0.13;
      ctx.beginPath(); ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s); ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s); ctx.stroke();
    } else {
      ctx.fillStyle = '#ffffff';
      disc(cx, cy, r * 0.2);
      ctx.fill();
      ctx.fillStyle = '#1a1033';
      disc(cx + ex * 0.35, cy + ey * 0.35, r * 0.1);
      ctx.fill();
    }
  }
  if (d.sn > 0) {
    ctx.fillStyle = INK.gold;
    for (let k = 0; k < 3; k++) {
      const a = now / 150 + k * 2.09;
      disc(sx + Math.cos(a) * r * 0.9, by - r * 1.05 + Math.sin(a) * r * 0.3, Math.max(1.2, r * 0.13));
      ctx.fill();
    }
  }
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    disc(sx, by, r + 4);
    ctx.stroke();
  }
  if (boost && d.ch < 0) {
    ctx.strokeStyle = alpha(INK.gold, 0.7);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.lineDashOffset = -now / 40;
    disc(sx, by, r + (me ? 8 : 5));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const top = by - ry - 5 - (d.sn > 0 ? r * 0.4 : 0);
  const px = Math.max(9, Math.min(13, 7 + r * 0.3));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(20,10,40,0.8)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const label = me ? 'you' : nickOf(id);
  ctx.strokeText(label, sx, top);
  ctx.fillStyle = me ? '#ffffff' : colour;
  ctx.fillText(label, sx, top);
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
    const rise = 14 + ease(f) * 26;
    const scale = f < 0.15 ? 0.6 + (f / 0.15) * 0.5 : 1.1 - Math.min(0.1, f - 0.15);
    ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
    const X = Math.max(60, Math.min(VW - 60, SX(p.x))), Y = Math.max(TOP + 10, SY(p.y) - rise);
    outlined(p.s, X, Y, p.px * scale, p.colour, 3);
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
  // The status line: the phase, the song, and what the music is doing.
  let status = '', colour = INK.text;
  const music = t.ms === MUSIC ? '♪ dance' : t.ms === SCRAMBLE ? 'stop · sit down!' : 'next song…';
  if (t.ph === WAIT) status = 'practice · song ' + t.sg + ' · ' + music;
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · song ' + t.sg + ' of ' + SONGS + ' · ' + music;
    if (late(t)) status += ' · notes pay double';
  } else status = 'round ' + t.rd + ' · over';
  if (t.ms === SCRAMBLE && (t.ph === WAIT || t.ph === PLAY)) colour = Math.floor(now / 250) % 2 ? INK.gold : INK.danger;
  text('musical chairs', 12, 22, titlePx, '#ffc6f0', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('musical chairs').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with the notes they
  // hold; a chair mark for whoever sits.
  const ids = bySeat(t);
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
      if (d.ch >= 0) {
        ctx.fillStyle = c;
        roundRect(x + 6, y - 7, 10, 10, 2);
        ctx.fill();
      } else {
        ctx.fillStyle = c;
        disc(x + 11, y - 2, 5);
        ctx.fill();
      }
      const score = String(d.nt);
      ctx.font = font(12);
      const sw = ctx.measureText(score).width + 6;
      text(score, x + cw - 8, y + 3, 12, INK.gold, 'right');
      if (cw > 56) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    }
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to dance · tap to dash · grab notes, sit when the music stops'
    : 'mouse or arrows/WASD dance · click or space dashes · sit when the music stops · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
}

// The notes you hold, whether a dash is ready and whether you dance faster for
// trailing, in the strip under the floor while a round is on.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = Math.min(fieldBot + NOTE_ROOM / 2, VH - BOT - 18);
  const boost = trailing(t, bySeat(t)).has(myId());
  const held = d.nt + (d.nt === 1 ? ' note' : ' notes');
  const ready = d.cd === 0;
  ctx.font = font(15);
  const sw = ctx.measureText(held).width;
  const bar = 70, extra = boost ? 70 : 0, total = 14 + sw + 18 + 40 + bar + extra;
  let x = VW / 2 - total / 2;
  ctx.fillStyle = SEAT[d.c];
  disc(x + 6, y, 6);
  ctx.fill();
  text(held, x + 16, y + 5, 15, INK.text, 'left');
  x += 16 + sw + 18;
  text('dash', x, y + 5, 12, ready ? INK.text : INK.dim, 'left');
  x += 38;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(x, y - 5, bar, 10, 5);
  ctx.fill();
  const k = ready ? 1 : 1 - d.cd / DASH_CD;
  ctx.fillStyle = ready ? SEAT[d.c] : 'rgba(255,255,255,0.45)';
  roundRect(x, y - 5, Math.max(10, bar * Math.max(0, k)), 10, 5);
  ctx.fill();
  if (boost) text('» faster', x + bar + 10, y + 5, 12, INK.gold, 'left');
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
  const cx = VW / 2, mid = (fieldTop + fieldBot) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const dancing = t.ph === WAIT || t.ph === PLAY;
  if (dancing && now - stopAt < 1100) {
    // The stop, as loud on screen as it is in the ears.
    const k = (now - stopAt) / 1100;
    ctx.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
    outlined('STOP!', cx, mid + big * 0.6, big * (3.2 - ease(Math.min(1, k * 4)) * 0.9), INK.danger, 7);
    ctx.globalAlpha = 1;
  } else if (dancing && t.ms === MUSIC && t.el < HZ * 1.2) {
    const k = t.el / (HZ * 1.2);
    ctx.globalAlpha = 1 - k;
    outlined(t.ph === PLAY && t.sg === 1 ? 'dance!' : 'song ' + t.sg, cx, mid + big * 0.5, big * (1.8 + k), '#ffffff', 6);
    if (late(t)) outlined('notes pay double!', cx, mid + big * 1.6, big * 0.8, INK.gold, 4);
    ctx.globalAlpha = 1;
  }
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'grab notes while the music plays · when it stops, sit on a chair!';
    practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    outlined(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 6);
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 360), 30);
    fitText(SONGS + ' songs · grab notes · sit when the music stops', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 340));
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · the most notes were level';
    else head = t.win === me ? 'you danced off with the most notes!' : nickOf(t.win) + ' danced off with the most notes';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('rounds', cx + w / 2 - 70, y0 + 52, 10, INK.dim, 'right');
    text('notes', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, nt, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText(id === me ? 'you' : nickOf(id), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 150, 'left');
      text(wins ? '★' + wins : '–', cx + w / 2 - 70, y, 13, INK.muted, 'right');
      text(String(nt), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('most notes after ' + SONGS + ' songs wins · next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a dancer is as drawn: between two steps, and never slid across a jump.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 3 * CELL) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

// The ring of chairs as drawn, between two steps: [x, y, facing] a chair.
function chairsAt(b) {
  const f = b.from, t = b.to;
  let ca = t.ca;
  if (f.nc === t.nc && f.ms === t.ms) {
    const delta = ((t.ca - f.ca + ANG / 2) & (ANG - 1)) - ANG / 2;
    ca = f.ca + delta * b.k;
  }
  const out = [], r = ringR(t.nc);
  for (let i = 0; i < t.nc; i++) {
    const a = (ca / ANG + i / t.nc) * Math.PI * 2;
    out.push([CX + Math.cos(a) * r, CY + Math.sin(a) * r, a]);
  }
  return out;
}

// Your own dancer is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a push a step away from
// where the guess had it. So the dancer drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a dancer sat down — puts it there at once. Only the drawing is
// smoothed: the floor, and every rule on it, are untouched.
const PULL = 0.45;
let shown = null;        // [x, y] in units: where your dancer is drawn
let myPos = null;        // the same, for the mouse to steer by

function pullShown(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 2 * CELL) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  fit();
  drawSky(now);
  const b = agreedAt(now);
  if (!b) {
    cutMusic();
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the dance…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  playMusic(t);
  const me = myId();
  const m = mineAt(now);
  const music = t.ms === MUSIC && (t.ph === WAIT || t.ph === PLAY);
  const elShown = b.from.ms === t.ms && b.from.el <= t.el ? lerp(b.from.el, t.el, b.k) : t.el;
  const beat = (elShown / HZ) * bpmOf(t) / 60;
  drawFloor(t, beat, now);
  // The notes are drawn from the guess when there is one, so a note your own
  // dancer runs over is gone as it gets there.
  drawNotes(m && m.to.p[me] ? m.to : t, now);
  const chairs = chairsAt(b);
  const items = [];
  chairs.forEach(([x, y, a], i) => {
    const who = t.chs[i];
    items.push([y - 1, () => drawChair(x, y, a, who !== -1, who !== -1 ? colourOf(t, who) : '', t.ms === SCRAMBLE && who === -1 && t.ph !== END, now)]);
  });
  items.push([CY, () => drawSpeaker(t, beat, now)]);
  const boost = trailing(t, bySeat(t));
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const d = t.p[id];
    const p = d.ch >= 0 && chairs[d.ch] ? [chairs[d.ch][0], chairs[d.ch][1], d] : bodyAt(b, id);
    items.push([p[1], () => drawDancer(id, p[0], p[1], d, SEAT[d.c], false, boost.has(id), beat, music, now)]);
  }
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  if (own) {
    const d = own.to.p[me];
    const p = d.ch >= 0 && t.p[me] && t.p[me].ch === d.ch && chairs[d.ch] ? [chairs[d.ch][0], chairs[d.ch][1], d] : bodyAt(own, me);
    const [x, y] = pullShown(p[0], p[1]);
    myPos = [x, y];
    items.push([y, () => drawDancer(me, x, y, d, SEAT[d.c], true, boost.has(me), beat, music, now)]);
  } else {
    myPos = shown = null;
  }
  items.sort((p, q) => p[0] - q[0]);
  for (const [, f] of items) f();
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way pushed, across and down, a thousand at full, and
// how many dashes so far. A change of way goes out no oftener than
// STEER_EVERY, because a thumb or a mouse changes it on every move the screen
// reports and the clock's ticks share the same seat's ceiling on messages; a
// dash goes out at once.
const STEER_EVERY = 80;
let mode = '';           // what steers: 'keys', 'mouse', 'touch', or nothing yet
let dashesAsked = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const KEY_DIR = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };

// A thumb: a stick from wherever it lands, read as far as it is pushed, and a
// tap dashes — a drag rather than a press, because iOS keeps a long press
// inside a frame for itself. A second finger down while the first steers
// dashes too. A mouse: your dancer heads for the pointer wherever it is; a
// click dashes.
const DEAD = 9;
const REACHOUT = 46;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }
const mouse = { x: 0, y: 0, on: false, parked: false };

function steerNow() {
  if (mode === 'keys') {
    let x = 0, y = 0;
    for (const c of keys) { x += KEY_DIR[c][0]; y += KEY_DIR[c][1]; }
    const l = Math.hypot(x, y);
    return l ? [Math.round((x / l) * 1000), Math.round((y / l) * 1000)] : [0, 0];
  }
  if (mode === 'touch') {
    if (!stick) return [0, 0];
    const l = Math.hypot(stick.dx, stick.dy);
    if (l < DEAD) return [0, 0];
    const k = Math.min(1, l / REACHOUT) * 1000 / l;
    return [clamp(Math.round(stick.dx * k), -1000, 1000), clamp(Math.round(stick.dy * k), -1000, 1000)];
  }
  if (mode === 'mouse' && mouse.on && myPos) {
    const r = cv.getBoundingClientRect();
    const dx = mouse.x - r.left - SX(myPos[0]), dy = mouse.y - r.top - SY(myPos[1]);
    const l = Math.hypot(dx, dy), cell = CELL * sc;
    // Stopped on arrival, and off again only once the pointer is clearly away:
    // one threshold for both makes a dancer that stops and starts on every
    // twitch of the hand.
    if (l < cell * 0.25) mouse.parked = true;
    else if (l > cell * 0.5) mouse.parked = false;
    if (mouse.parked) return [0, 0];
    const k = Math.min(1, l / (cell * 1.5)) * 1000 / l;
    return [clamp(Math.round(dx * k), -1000, 1000), clamp(Math.round(dy * k), -1000, 1000)];
  }
  return [0, 0];
}

function sayHand(now, force) {
  const [dx, dy] = steerNow();
  const h = [dx, dy, dashesAsked], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1] && h[2] === s[2]) return;
  if (!force && s && h[2] === s[2] && now - saidAt < STEER_EVERY) return;
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
  const d = world.p[myId()];
  if (d && d.ch < 0 && d.sn === 0 && d.cd === 0) sound.dash();
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyE' || e.code === 'KeyX') {
    e.preventDefault();
    if (!e.repeat) dash();
    return;
  }
  if (!(e.code in KEY_DIR)) return;
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
  paintStick();
  mouse.on = false;
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    coarse = true;
    mode = 'touch';
    if (stick) { dash(); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
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
  dash();
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
// a player arrives on the floor.
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
