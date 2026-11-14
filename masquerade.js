/**
 * @disk     masquerade
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    A masked ball where every guest looks the same and most of them are nobody. Dance like the crowd, stand by a dark candle to light it, and unmask a rival when you are sure, but unmask a stranger and the whole room sees your face.
 * @tags     game, party, realtime, bluff, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/masquerade.png
 */
// masquerade.js — a ballroom of identical masked dancers where the room's
// order is the referee.
//
// Every copy holds every dancer on the floor, the guests the ball invented
// and the players hidden among them alike, which candles burn and which have
// gone dark, and changes it only on what comes back round the room, so every
// copy applies the same hands in the same order and holds the same ball.
// Nobody sends where they are, whom they unmasked or what they lit: a hand is
// which of eight ways a dancer walks, or that it stands, and a counter that
// moves on by one for every lunge, and everything else is the same arithmetic
// on the same whole numbers on every machine. A player and an invented guest
// walk by one rule — the same eight ways at the same pace, from a standstill
// to full stride in one step — so the only tell is how they choose to walk.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own dancer does not wait for the trip: it is drawn from the agreed
// table played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — the floor is 1600 units across, a
// stride is units a step — and use nothing but `+ - * /`, comparisons,
// `Math.floor`, `Math.min`, `Math.max`, `Math.abs` and `Math.imul`, whose
// results the language fixes to the last bit. Trigonometry appears only in the
// drawing, which is nobody's business but the screen's.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (w, n) => Math.floor(draw01(w) * n);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the ball a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own dancer a trip ahead, with your hand in it

// The ballroom, seen from above. Every dancer walks one of eight ways at one
// pace or stands still: the strides below are whole units a step, the same
// for a guest the ball invented and for a player, so nothing in the way a
// dancer moves says which it is — only where and when it chooses to.
const W = 1600, H = 1200;
const DR = 34;                 // a dancer's footprint, its distance from the walls
const STRIDE = [[0, 0], [9, 0], [6, 6], [0, 9], [-6, 6], [-9, 0], [-6, -6], [0, -9], [6, -6]];
//                 stand  right  down-r  down   down-l  left   up-l    up     up-r
const CROWD = 34;              // dancers on the floor, players among them
const LOOKS = 6;               // gowns a dancer may wear
const CANDLES = [[250, 240], [800, 160], [1350, 240], [1450, 600], [1350, 960], [800, 1040], [250, 960], [150, 600]];
const LIGHT_R = 105;           // how near a candle a dancer stands to light it
const LIGHT_STEPS = 40;        // steps of standing still beside a dark candle that light it
const DARK = 3;                // candles that are out at once
const DARK_LATE = 4;           // the same, after midnight
const BLOW_GAP = 2 * HZ;       // steps after a candle is lit before another goes out
const REACH = 120;             // how far a lunge reaches to unmask somebody
const REACH_BEHIND = 165;      // the same, for whoever trails the leader
const LUNGE_CD = 75;           // steps between two lunges
const LUNGE_CD_BEHIND = 48;    // the same, for whoever trails the leader
const WHIFF_CD = 20;           // steps after a lunge at nobody
const STUN = 45;               // steps a dancer who unmasked a stranger stands dazed
const SHOWN = 4 * HZ;          // steps their face is shown to the room
const SHOWN_HIT = 45;          // steps an unmasker's face is shown after a catch
const OUT = 3 * HZ;            // steps an unmasked player waits to slip back into the crowd
const CATCH_PTS = 2;           // points for unmasking a player
const LEAD_BONUS = 1;          // more, when they were the leader
const CAUGHT_COST = 1;         // points an unmasked player loses
const GLINT_EVERY = 4 * HZ;    // the leader's mask catches the light this often
const GLINT_LEN = 9;           // and for this many steps
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const MAX_G = CROWD + MAX_P;
const BIG = 2147483647;
const NOBODY = -9999;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 120 * HZ;
const END_STEPS = 6 * HZ;
const MIDNIGHT_AT = 90 * HZ;   // steps into a round when midnight strikes and every candle counts double

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   gn: the next dancer's number; g: the guests the ball invented, each
//   [number, x, y, way, steps left walking, steps left standing, gown]; cl:
//   one flag a candle, 1 burning and 0 dark; bo: steps until the next candle
//   goes out, 0 while none is due; res: the last round's [id, points, lit,
//   unmasked, rounds won] rows; win: its winner
function freshTable(seed) {
  const t = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, gn: 0, g: [], cl: CANDLES.map(() => 1), bo: 0, p: {}, res: null, win: -1 };
  layCrowd(t);
  return t;
}

const FIELDS = ['c', 's', 'x', 'y', 'dir', 'dn', 'lk', 'kq', 'kb', 'cd', 'st', 'rv', 'out', 'lc', 'lw', 'rp', 'lit', 'um',
  'wn', 'bw', 'bl', 'hs', 'hc'];
//   c: colour; s: seat; x, y: where it stands, in units; dir: the way the hand
//   walks, an index into STRIDE; dn: the number of the dancer it wears, -1
//   while it waits to slip back in; lk: that dancer's gown; kq: the lunge
//   counter as last heard; kb: a lunge to take this step; cd: steps until it
//   lunges again; st: steps it stands dazed; rv: steps its face is shown; out:
//   steps until it slips back into the crowd; lc: steps it has stood lighting;
//   lw: the candle it lights; rp: points this round; lit: candles lit; um:
//   rivals unmasked; wn: rounds won; bw, bl: the bot's standing and walking
//   steps; hs, hc: hands this step.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);
const onFloor = (d) => d.dn >= 0;

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

function newPlayer(w, kq) {
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), x: W / 2, y: H / 2, dir: 0, dn: -1, lk: 0, kq, kb: 0, cd: 0, st: 0, rv: 0,
    out: 0, lc: 0, lw: -1, rp: 0, lit: 0, um: 0, wn: 0, bw: 0, bl: 0, hs: w.n, hc: 0,
  });
}

function addGuest(w, x, y, look, num) {
  if (w.g.length >= MAX_G) return;
  if (num === undefined) { num = w.gn; w.gn = (w.gn + 1) % 100000; }
  w.g.push([num, clamp(x, DR, W - DR), clamp(y, DR, H - DR), 0, 0, 10 + pick(w, 40), look]);
}

// A fresh floor: the crowd scattered over it in their gowns, and every
// player slipped into one of them at random, so nobody starts anywhere a
// rival could guess.
function layCrowd(w) {
  w.g = [];
  for (let i = 0; i < CROWD; i++) addGuest(w, DR + pick(w, W - 2 * DR), DR + pick(w, H - 2 * DR), pick(w, LOOKS));
  for (const id of bySeat(w)) {
    w.p[id].dn = -1;
    slipIn(w, w.p[id]);
  }
}

// A player takes the place of one guest of the crowd, chosen at random: the
// guest is gone and the player wears its gown where it stood, so to anybody
// watching nothing happens at all.
function slipIn(w, d) {
  if (!w.g.length) return;
  const i = pick(w, w.g.length);
  const q = w.g[i];
  w.g.splice(i, 1);
  d.dn = q[0];
  d.x = q[1];
  d.y = q[2];
  d.lk = q[6];
  d.out = d.lc = d.st = d.rv = 0;
  d.lw = -1;
}

// A player's dancer handed back to the crowd: it walks on as a guest.
function slipOut(w, d, rest) {
  if (!onFloor(d)) return;
  w.g.push([d.dn, d.x, d.y, 0, 0, rest, d.lk]);
  d.dn = -1;
  d.lc = 0;
  d.lw = -1;
}

// The one leader, as every copy works it out: the most points this round, when
// somebody has some and nobody matches them.
function leaderOf(w) {
  let top = 0, who = NOBODY, tie = false;
  for (const id of playersIn(w)) {
    const r = w.p[id].rp;
    if (r > top) { top = r; who = id; tie = false; } else if (r === top && r > 0) tie = true;
  }
  return tie ? NOBODY : who;
}
const trails = (w, id) => w.ph === PLAY && playersIn(w).some((o) => w.p[o].rp > w.p[id].rp);
const midnight = (w) => w.ph === PLAY && PLAY_STEPS - w.pt >= MIDNIGHT_AT;
const glinting = (w, id) => w.ph === PLAY && leaderOf(w) === id && w.n % GLINT_EVERY < GLINT_LEN;

// The way, of the eight, that points most nearly along (dx, dy): a diagonal
// when neither axis is more than about two and a half times the other.
function wayTo(dx, dy) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (!ax && !ay) return 0;
  const sx = ax * 5 < ay * 2 ? 0 : dx > 0 ? 1 : -1;
  const sy = ay * 5 < ax * 2 ? 0 : dy > 0 ? 1 : -1;
  for (let k = 1; k < 9; k++) {
    if (Math.sign(STRIDE[k][0]) === sx && Math.sign(STRIDE[k][1]) === sy) return k;
  }
  return 0;
}

// How many strides along a way bring a dancer about level with (dx, dy):
// along the axis it walks, or the nearer of the two on a diagonal.
function strides(dx, dy, way) {
  const [vx, vy] = STRIDE[way];
  const ax = vx ? Math.floor(Math.abs(dx) / Math.abs(vx)) : BIG, ay = vy ? Math.floor(Math.abs(dy) / Math.abs(vy)) : BIG;
  return Math.max(1, Math.min(ax, ay, 90));
}

// A hand, at its place in the room's order: [the way walked, 0 to stand and 1
// to 8 for the eight ways; the lunge counter]. A lunge is asked for once, when
// its counter changes; the same hand said again to keep a player at the table
// asks for nothing. Being heard is how a player arrives: slipped into the
// crowd at random.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[1]);
    slipIn(w, d);
    d.dir = input[0];
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.dir = input[0];
  if (input[1] !== d.kq) { d.kq = input[1]; d.kb = 1; }
}

// A hand off the wire, made safe: two integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [way, k] = raw;
  if (!Number.isInteger(way) || !Number.isInteger(k)) return null;
  if (way < 0 || way > 8 || k < 0 || k > 999) return null;
  return [way, k];
}

// Somebody gone: their dancer stays on the floor as one more guest.
function leave(w, id) {
  const d = w.p[id];
  if (d) slipOut(w, d, 20);
  delete w.p[id];
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions about lunging
const BOT_CANDLE = 0.35;       // how often a new walk of its heads for a dark candle
const BOT_PAUSE = 0.4;         // how often it lets a chance to lunge go by
const BOT_GUESS = 0.003;       // how often it lunges at whoever is nearest, on a hunch
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    const d = (w.p[BOT_ID] = newPlayer(w, 0));
    slipIn(w, d);
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// The dark candle nearest a point, or -1.
function darkNear(w, x, y, most) {
  let best = -1, far = most * most;
  for (let k = 0; k < CANDLES.length; k++) {
    if (w.cl[k]) continue;
    const e = dist2(x, y, CANDLES[k][0], CANDLES[k][1]);
    if (e < far) { far = e; best = k; }
  }
  return best;
}

// It walks the way the crowd walks — straight lines and pauses — now and then
// to a dark candle to stand there until it burns. It lunges at a rival whose
// face is shown, or at one it watched stand at a candle, and once in a long
// while at whoever is nearest, on a hunch. It does not always take its
// chance.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || !onFloor(d)) return;
  if (d.st > 0) { d.dir = 0; return; }
  const at = darkNear(w, d.x, d.y, LIGHT_R - 25);
  if (at >= 0 && d.bl === 0) { d.dir = 0; d.bw = Math.max(d.bw, 2); }
  if (d.bl > 0) {
    d.bl -= 1;
    if (d.bl === 0) { d.dir = 0; d.bw = 8 + pick(w, 50); }
  } else if (d.bw > 0) {
    d.bw -= 1;
  } else {
    const k = draw01(w) < BOT_CANDLE ? darkNear(w, d.x, d.y, BIG) : -1;
    if (k >= 0) {
      const dx = CANDLES[k][0] - d.x, dy = CANDLES[k][1] + 40 - d.y;
      d.dir = wayTo(dx, dy);
      d.bl = d.dir ? strides(dx, dy, d.dir) : 0;
    } else {
      d.dir = 1 + pick(w, 8);
      d.bl = 12 + pick(w, 45);
    }
  }
  if (w.n % BOT_EVERY !== 0 || d.cd > 0) return;
  const reach = trails(w, BOT_ID) ? REACH_BEHIND : REACH;
  for (const id of playersIn(w)) {
    const e = w.p[id];
    if (id === BOT_ID || !onFloor(e) || dist2(d.x, d.y, e.x, e.y) > reach * reach) continue;
    const suspect = e.rv > 0 || (e.lc > 12 && draw01(w) < 0.25);
    if (suspect && draw01(w) >= BOT_PAUSE) { d.kb = 1; return; }
  }
  if (draw01(w) < BOT_GUESS) d.kb = 1;
}

// ── a step ─────────────────────────────────────────────────────────────────
function resetRound(w) {
  w.res = null;
  w.win = -1;
  w.bo = 0;
  w.cl = CANDLES.map(() => 1);
  for (let i = 0; i < DARK; i++) blowOut(w, false);
  for (const id of playersIn(w)) {
    const d = w.p[id];
    d.rp = d.lit = d.um = d.cd = d.kb = d.bw = d.bl = 0;
  }
  layCrowd(w);
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  resetRound(w);
}

// A round: a fresh crowd, the seats closed up in order, every player slipped
// into the crowd somewhere new.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  bySeat(w).forEach((id, i) => { w.p[id].s = i; });
  resetRound(w);
  fx(w, 'round', 0, 0, 0);
}

// The last bell: the round to whoever has the most points, the more rivals
// unmasked between two who match, and nobody if that matches too.
function finish(w) {
  const ids = bySeat(w);
  const rank = (a, b) => w.p[b].rp - w.p[a].rp || w.p[b].um - w.p[a].um;
  const order = ids.slice().sort((a, b) => rank(a, b) || a - b);
  const top = order[0];
  w.win = ids.length > 1 && (order.length < 2 || rank(top, order[1]) !== 0) ? top : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  w.res = order.map((id) => [id, w.p[id].rp, w.p[id].lit, w.p[id].um, w.p[id].wn]);
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
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go', 0, 0, 0); }
    } else if (w.ph === PLAY) {
      if (PLAY_STEPS - w.pt === MIDNIGHT_AT) fx(w, 'midnight', 0, 0, 0);
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody moves while a round is counted in or its result is up — the crowd
  // included, or the only dancers standing still would be the players.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) w.p[id].kb = 0;
    return;
  }
  dance(w);
}

function dance(w) {
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    if (!onFloor(d)) {
      d.kb = 0;
      if (d.out > 0) d.out -= 1;
      if (d.out === 0) { slipIn(w, d); fx(w, 'back', d.x, d.y, 0, id); }
      continue;
    }
    if (d.cd > 0) d.cd -= 1;
    if (d.rv > 0) d.rv -= 1;
    if (d.st > 0) { d.st -= 1; continue; }
    walk(d, d.dir, false);
  }
  for (const q of w.g) wander(w, q);
  for (const id of ids) {
    const d = w.p[id];
    if (d.kb) lunge(w, d, id);
    d.kb = 0;
  }
  for (const id of ids) light(w, w.p[id], id);
  candles(w);
}

// One stride along a way, stopped at the walls. Returns whether a wall
// stopped it.
function walk(d, way, guest) {
  const [vx, vy] = STRIDE[way];
  if (!vx && !vy) return false;
  const x = d.x + vx, y = d.y + vy;
  const nx = clamp(x, DR, W - DR), ny = clamp(y, DR, H - DR);
  if (guest && (nx !== x || ny !== y)) return true;
  d.x = nx;
  d.y = ny;
  return nx !== x || ny !== y;
}

// A guest walks a straight line some way, stops a while, and walks off
// another way; one walk in three heads for a candle, and a guest stands there
// longer, the way a player lighting it would.
function wander(w, q) {
  const at = { x: q[1], y: q[2] };
  if (q[4] > 0) {
    if (walk(at, q[3], true)) q[4] = 0; else q[4] -= 1;
    q[1] = at.x;
    q[2] = at.y;
    if (q[4] === 0) {
      const near = CANDLES.some(([cx, cy]) => dist2(q[1], q[2], cx, cy) < LIGHT_R * LIGHT_R);
      q[5] = near ? 30 + pick(w, 70) : 8 + pick(w, 55);
    }
    return;
  }
  if (q[5] > 0) { q[5] -= 1; return; }
  if (draw01(w) < 0.33) {
    const [cx, cy] = CANDLES[pick(w, CANDLES.length)];
    const dx = cx - 60 + pick(w, 121) - q[1], dy = cy + 30 + pick(w, 41) - q[2];
    q[3] = wayTo(dx, dy);
    q[4] = q[3] ? strides(dx, dy, q[3]) : 0;
  } else {
    q[3] = 1 + pick(w, 8);
    q[4] = 12 + pick(w, 50);
  }
  if (!q[4]) q[5] = 10 + pick(w, 30);
}

// A lunge unmasks the nearest dancer within reach. A player behind the mask
// is caught: the lunger scores, more for the leader, and shows their own face
// a moment for it; the one caught loses a point, and their dancer walks on as
// a guest while they wait to slip back into the crowd. A guest behind it is a
// blunder the whole room sees: the lunger stands dazed with their face shown.
// A lunge at nobody costs a moment.
function lunge(w, d, id) {
  if (d.cd > 0 || d.st > 0 || !onFloor(d)) return;
  const trail = trails(w, id);
  const reach = trail ? REACH_BEHIND : REACH;
  let best = reach * reach + 1, guest = null, rival = NOBODY;
  for (const q of w.g) {
    const e = dist2(d.x, d.y, q[1], q[2]);
    if (e < best) { best = e; guest = q; }
  }
  for (const o of bySeat(w)) {
    const e = w.p[o];
    if (o === id || !onFloor(e)) continue;
    const f = dist2(d.x, d.y, e.x, e.y);
    if (f < best) { best = f; rival = o; guest = null; }
  }
  if (rival !== NOBODY) {
    const e = w.p[rival];
    const v = CATCH_PTS + (leaderOf(w) === rival ? LEAD_BONUS : 0);
    d.rp += v;
    d.um += 1;
    d.cd = trail ? LUNGE_CD_BEHIND : LUNGE_CD;
    d.rv = Math.max(d.rv, SHOWN_HIT);
    d.lc = 0;
    const lost = Math.min(CAUGHT_COST, e.rp);
    e.rp -= lost;
    fx(w, 'catch', e.x, e.y, v, rival, id, e.lk);
    fx(w, 'lunge', d.x, d.y, e.x - d.x, id, e.y - d.y);
    slipOut(w, e, 40);
    e.out = OUT;
    e.st = e.rv = 0;
  } else if (guest) {
    d.cd = trail ? LUNGE_CD_BEHIND : LUNGE_CD;
    d.st = STUN;
    d.rv = SHOWN;
    d.lc = 0;
    d.lw = -1;
    guest[4] = 0;
    guest[5] = Math.max(guest[5], 35);
    fx(w, 'blunder', d.x, d.y, 0, id, guest[0]);
    fx(w, 'lunge', d.x, d.y, guest[1] - d.x, id, guest[2] - d.y);
  } else {
    d.cd = WHIFF_CD;
    fx(w, 'lunge', d.x, d.y, 0, id, 0);
  }
}

// A player standing still beside a dark candle lights it a little every
// step, and walking off puts the taper out again. Lit, it pays a point, two
// after midnight. Several players at one candle each light it on their own,
// and the first to finish has it.
function light(w, d, id) {
  if (!onFloor(d) || d.st > 0 || d.dir !== 0) { d.lc = 0; d.lw = -1; return; }
  const k = darkNear(w, d.x, d.y, LIGHT_R);
  if (k < 0) { d.lc = 0; d.lw = -1; return; }
  if (d.lw !== k) { d.lw = k; d.lc = 0; }
  d.lc += 1;
  if (d.lc < LIGHT_STEPS) return;
  w.cl[k] = 1;
  const v = midnight(w) ? 2 : 1;
  d.rp += v;
  d.lit += 1;
  d.lc = 0;
  d.lw = -1;
  fx(w, 'light', CANDLES[k][0], CANDLES[k][1], v, id);
}

// The draught: a moment after a candle is lit, another somewhere else goes
// out, so there are always a few dark ones to make for — one more after
// midnight.
function candles(w) {
  const want = midnight(w) ? DARK_LATE : DARK;
  const dark = w.cl.filter((v) => !v).length;
  if (dark >= want) { w.bo = 0; return; }
  if (w.bo === 0) { w.bo = BLOW_GAP; return; }
  if (--w.bo === 0) blowOut(w, true);
}

function blowOut(w, show) {
  const lit = [];
  for (let k = 0; k < CANDLES.length; k++) if (w.cl[k]) lit.push(k);
  if (!lit.length) return;
  const k = lit[pick(w, lit.length)];
  w.cl[k] = 0;
  if (show) fx(w, 'blow', CANDLES[k][0], CANDLES[k][1], k);
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!int(raw.gn, 0, 99999) || !int(raw.bo, 0, BLOW_GAP)) return null;
  if (!Array.isArray(raw.cl) || raw.cl.length !== CANDLES.length || !raw.cl.every((v) => v === 0 || v === 1)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set(), nums = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.x, DR, W - DR) || !int(d.y, DR, H - DR) || !int(d.dir, 0, 8)) return null;
    if (!int(d.dn, -1, 99999) || (d.dn >= 0 && nums.has(d.dn)) || !int(d.lk, 0, LOOKS - 1)) return null;
    if (!int(d.kq, 0, 999) || !int(d.kb, 0, 1) || !int(d.cd, 0, LUNGE_CD) || !int(d.st, 0, STUN)) return null;
    if (!int(d.rv, 0, SHOWN) || !int(d.out, 0, OUT) || !int(d.lc, 0, LIGHT_STEPS) || !int(d.lw, -1, CANDLES.length - 1)) return null;
    if (!int(d.rp, 0, 99999) || !int(d.lit, 0, 99999) || !int(d.um, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bw, 0, 999) || !int(d.bl, 0, 999) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    if (d.dn >= 0) nums.add(d.dn);
    p[id] = player(d);
  }
  if (!Array.isArray(raw.g) || raw.g.length > MAX_G) return null;
  const g = [];
  for (const q of raw.g) {
    if (!Array.isArray(q) || q.length !== 7) return null;
    const [n, x, y, way, legs, rest, look] = q;
    if (!int(n, 0, 99999) || nums.has(n) || !int(x, DR, W - DR) || !int(y, DR, H - DR) || !int(way, 0, 8)) return null;
    if (!int(legs, 0, 999) || !int(rest, 0, 999) || !int(look, 0, LOOKS - 1)) return null;
    nums.add(n);
    g.push([n, x, y, way, legs, rest, look]);
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 5 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, gn: raw.gn, g, cl: raw.cl.slice(), bo: raw.bo, p, res, win: raw.win };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed table steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, z, a, b, c) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x, y, z, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, c: c === undefined ? 0 : c });
  if (fxq.length > 400) fxq.splice(0, fxq.length - 400);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a ballroom by candlelight. A parquet of honey and walnut under
// a chandelier's pool of light, plum walls with gold trim, candelabras round
// the floor, and every guest in one of six gowns with a gold mask — the
// players' own colours appear only on the scoreboard, and on a face the room
// has seen.
const INK = {
  page: '#1a0d1f', glow: '#3a1838', text: '#ffffff', muted: '#f1dfe8', dim: '#b597aa', gold: '#ffd166',
  woodA: '#c48a4f', woodB: '#9a6236', woodLine: 'rgba(60,30,10,0.25)', wall: '#4a1e43', wallShade: '#2c1029',
  trim: '#d9a84e', flame: '#ffcf5c', smoke: 'rgba(220,210,230,0.5)', skin: '#f2d2b6', mask: '#f0c24b',
  panel: 'rgba(26,12,30,0.93)', ink: 'rgba(24,10,26,0.85)',
};
const GOWN = [['#a3264b', '#ffd166'], ['#1f7a80', '#f7e3af'], ['#6a3fa0', '#f2a6cf'], ['#2e7d4f', '#f4d35e'], ['#2d4f99', '#ffb4a2'], ['#e8dcc4', '#c0395a']];
const SEAT = ['#ff4f7b', '#2f8cff', '#ffa31a', '#3ccf4e', '#b44dff', '#00c2d6', '#ff6a2b', '#7d6bff'];
const FONT = "700 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #7a4a6e;' +
  `background:#3a1838;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
const SIDE = 160;              // the least a column beside the floor needs for the scoreboard
let VW = 640, VH = 400, sc = 0.2, ox = 0, oy = 58, TOP = 58, BOT = 26, dpx = 1, fieldTop = 58, fieldBot = 340;
let wide = false, colW = 0;
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

// The whole floor is always on screen, as large as the frame lets it be. A
// frame wider than the floor puts the status, the scoreboard, your lunge and
// the line of controls in the columns either side of it, so the floor takes
// the whole height. A narrower one stacks them in strips above and below it,
// with NOTE_ROOM under it for the practice note and, in a round, for your
// lunge — two candles stand on the bottom edge, so nothing covers it.
// Whichever of the two draws the floor bigger is the one used. The wall round
// the floor is part of what is fitted, so it is never cropped either.
const BANK = 44;               // the wall's width, in units
function fit() {
  const fw = W + 2 * BANK, fh = H + 2 * BANK;
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  const tall = Math.min((VW - 8) / fw, ah / fh), side = Math.min((VH - 12) / fh, (VW - 2 * SIDE) / fw);
  wide = side > tall;
  sc = Math.max(0.02, wide ? side : tall);
  ox = (VW - sc * W) / 2;
  oy = wide ? (VH - sc * H) / 2 : TOP + (ah - sc * H) / 2;
  colW = wide ? ox - BANK * sc : 0;
  fieldTop = oy - BANK * sc;
  fieldBot = oy + sc * (H + BANK);
}

// Words broken into lines no wider than `most`, at the dots between phrases
// first and at spaces only when a phrase alone is too long.
function wrap(s, px, most) {
  ctx.font = font(px);
  const out = [];
  let line = '';
  const put = (piece, sep) => {
    const next = line ? line + sep + piece : piece;
    if (!line || ctx.measureText(next).width <= most) { line = next; return; }
    out.push(line);
    line = piece;
  };
  for (const phrase of s.split(' · ')) {
    if (ctx.measureText(phrase).width <= most) { put(phrase, ' · '); continue; }
    phrase.split(' ').forEach((word, i) => put(word, i ? ' ' : ' · '));
  }
  if (line) out.push(line);
  return out;
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
function roundRect(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
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
function alpha(hex, a) {
  const c = rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function shade(hex, k) {
  const c = rgb(hex).map((v) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k));
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
  lunge(mine) { if (ready('lunge', 60)) puff(0.16, mine ? 0.08 : 0.035, 1800, 0, 0.7); },
  light(mine, near) {
    if (!ready('light', 80)) return;
    puff(0.25, 0.03 + 0.04 * near, 900, 0, 0.6);
    if (mine) [784, 1175, 1568].forEach((f, i) => tone(f, 0.16, 'triangle', 0.07, 0, 0.05 + i * 0.06));
    else tone(1047, 0.12, 'sine', 0.02 + 0.03 * near, 1);
  },
  blow(near) { if (ready('blow', 120)) puff(0.45, 0.02 + 0.05 * near, 600, 0, 0.5); },
  catch_(mine, me) {
    if (!ready('catch', 80)) return;
    puff(0.1, 0.08, 3000, 0, 1.5);
    tone(me ? 330 : 520, 0.2, 'triangle', 0.08, me ? 0.5 : 1.6);
    if (mine) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, 'triangle', 0.08, 0, 0.1 + i * 0.06));
  },
  blunder(mine) {
    if (!ready('blunder', 120)) return;
    tone(mine ? 300 : 260, 0.18, 'sawtooth', mine ? 0.07 : 0.03, 0.7);
    tone(mine ? 225 : 195, 0.3, 'sawtooth', mine ? 0.07 : 0.03, 0.6, 0.18);
  },
  back() { if (ready('back', 200)) tone(392, 0.2, 'sine', 0.06, 1.5); },
  midnight() {
    if (!ready('midnight', 400)) return;
    for (let i = 0; i < 4; i++) { tone(523, 0.9, 'sine', 0.07, 1, i * 0.5); tone(1046, 0.6, 'sine', 0.025, 1, i * 0.5); }
  },
  beep(hi) { if (ready('beep', 200)) tone(hi ? 880 : 660, 0.14, 'sine', 0.1); },
  go() { if (ready('go', 300)) [392, 494, 587].forEach((f, i) => tone(f, 0.22, 'triangle', 0.08, 1, i * 0.12)); },
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
// fast screen and a slow one see the same spray. Positions are floor units.
const bits = [];      // { x, y, vx, vy, g, life, max, size, colour, sq }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
const masks = [];     // a mask knocked flying: { x, y, vx, vy, spin, life, max, look }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, g, sq) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: g || 0, life: 0, max: 18 + Math.random() * 22, size, colour, sq: !!sq });
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
      b.vy += b.g / BIT_HZ;
      if (++b.life >= b.max) bits.splice(i, 1);
    }
    for (let i = masks.length - 1; i >= 0; i--) {
      const m = masks[i];
      m.x += m.vx / BIT_HZ; m.y += m.vy / BIT_HZ;
      m.vy += 900 / BIT_HZ;
      m.spin += 0.25;
      if (++m.life >= m.max) masks.splice(i, 1);
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
const looks = new Map();      // dancer number -> { gait, seen, lunge, lx, ly, face }
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const lookOf = (num, now) => {
  let l = looks.get(num);
  if (!l) looks.set(num, (l = { gait: 0, seen: now, lunge: 0, lx: 0, ly: 0, face: 1 }));
  l.seen = now;
  return l;
};

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = md && onFloor(md) ? Math.max(0, 1 - (Math.abs(md.x - e.x) + Math.abs(md.y - e.y)) / 1400) : 0.3;
  if (e.kind === 'lunge') {
    const d = t.p[e.a];
    if (d && onFloor(d)) {
      const l = looks.get(d.dn);
      const m = Math.hypot(e.z, e.b);
      if (l) { l.lunge = 1; l.lx = m ? e.z / m : 0; l.ly = m ? e.b / m : 0; }
    }
    spray(e.x, e.y - 40, 6, '#ffffff', 300, 5, 0);
    sound.lunge(e.a === me);
  } else if (e.kind === 'catch') {
    const g = GOWN[e.c] || GOWN[0];
    masks.push({ x: e.x, y: e.y - 80, vx: (Math.random() - 0.5) * 500, vy: -520, spin: 0, life: 0, max: 50, look: e.c });
    spray(e.x, e.y - 60, 18, INK.mask, 520, 7, 300, true);
    spray(e.x, e.y - 60, 10, g[1], 420, 6, 0);
    ring(e.x, e.y - 40, colourOf(t, e.a), 160);
    pop(e.x, e.y - 110, 'unmasked!', colourOf(t, e.a), e.a === me || e.b === me ? 18 : 14);
    pop(e.x, e.y - 70, '+' + e.z, colourOf(t, e.b), e.b === me ? 20 : 15);
    if (e.a === me) shake = Math.max(shake, 12);
    else if (e.b === me) shake = Math.max(shake, 5);
    sound.catch_(e.b === me, e.a === me);
  } else if (e.kind === 'blunder') {
    const c = colourOf(t, e.a);
    spray(e.x, e.y - 60, 14, c, 420, 7, 0);
    ring(e.x, e.y - 40, c, 140);
    pop(e.x, e.y - 110, 'oops!', '#ffffff', e.a === me ? 18 : 14);
    if (e.a === me) shake = Math.max(shake, 8);
    sound.blunder(e.a === me);
  } else if (e.kind === 'light') {
    spray(e.x, e.y - 90, 16, INK.flame, 420, 6, -200);
    ring(e.x, e.y - 60, INK.flame, 150);
    // Who lit it shows on the scoreboard, not on the floor: everybody else
    // sees a candle catch, and only its lighter sees their colour on it.
    pop(e.x, e.y - 120, '+' + e.z, e.a === me ? colourOf(t, e.a) : INK.gold, e.a === me ? 20 : 14);
    sound.light(e.a === me, near);
  } else if (e.kind === 'blow') {
    spray(e.x, e.y - 90, 10, '#d9cfe0', 160, 7, -120);
    sound.blow(near);
  } else if (e.kind === 'back') {
    if (e.a === me) { ring(e.x, e.y - 30, colourOf(t, e.a), 120); sound.back(); }
  } else if (e.kind === 'midnight') {
    pop(W / 2, H / 2, 'midnight · candles count double!', INK.gold, 22);
    shake = Math.max(shake, 4);
    sound.midnight();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

// The night outside the ballroom: a deep plum dusk with a glow at the top,
// and faint damask diamonds on it.
function drawBack(now) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  ctx.strokeStyle = 'rgba(255,210,140,0.05)';
  ctx.lineWidth = 1;
  const s = 34;
  ctx.beginPath();
  for (let x = -VH; x < VW + VH; x += s) {
    ctx.moveTo(x, 0); ctx.lineTo(x + VH, VH);
    ctx.moveTo(x, VH); ctx.lineTo(x + VH, 0);
  }
  ctx.stroke();
}

// The floor: plum walls trimmed with gold round a parquet laid in diamonds,
// a pool of chandelier light in the middle and, after midnight, moonlight blue
// over all of it.
function drawFloor(t, now) {
  flat();
  const x0 = SX(0), y0 = SY(0), w = W * sc, h = H * sc, bk = BANK * sc;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  roundRect(x0 - bk + 3, y0 - bk + 6, w + 2 * bk, h + 2 * bk, bk * 0.6);
  ctx.fill();
  const bg = ctx.createLinearGradient(0, y0 - bk, 0, y0 + h + bk);
  bg.addColorStop(0, INK.wall);
  bg.addColorStop(1, INK.wallShade);
  ctx.fillStyle = bg;
  roundRect(x0 - bk, y0 - bk, w + 2 * bk, h + 2 * bk, bk * 0.6);
  ctx.fill();
  ctx.strokeStyle = INK.trim;
  ctx.lineWidth = Math.max(1, 5 * sc);
  roundRect(x0 - bk * 0.45, y0 - bk * 0.45, w + bk * 0.9, h + bk * 0.9, bk * 0.4);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.fillStyle = INK.woodA;
  ctx.fillRect(x0, y0, w, h);
  // Parquet: diamonds of the darker wood on the lighter.
  const tile = 100 * sc;
  ctx.fillStyle = INK.woodB;
  for (let j = 0; j * 100 <= H + 100; j++) {
    for (let i = 0; i * 100 <= W + 100; i++) {
      if ((i + j) % 2) continue;
      const cx = x0 + i * tile, cy = y0 + j * tile;
      ctx.beginPath();
      ctx.moveTo(cx, cy - tile / 2);
      ctx.lineTo(cx + tile / 2, cy);
      ctx.lineTo(cx, cy + tile / 2);
      ctx.lineTo(cx - tile / 2, cy);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.strokeStyle = INK.woodLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i * 100 <= W; i++) { ctx.moveTo(x0 + i * tile, y0); ctx.lineTo(x0 + i * tile, y0 + h); }
  for (let j = 0; j * 100 <= H; j++) { ctx.moveTo(x0, y0 + j * tile); ctx.lineTo(x0 + w, y0 + j * tile); }
  ctx.stroke();
  // The chandelier's light, and the dark round the edges.
  const cx = SX(W / 2), cy = SY(H / 2);
  const pool = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.62);
  pool.addColorStop(0, 'rgba(255,236,190,0.32)');
  pool.addColorStop(0.55, 'rgba(255,220,160,0.06)');
  pool.addColorStop(1, 'rgba(30,8,30,0.45)');
  ctx.fillStyle = pool;
  ctx.fillRect(x0, y0, w, h);
  if (midnight(t)) {
    ctx.fillStyle = `rgba(30,40,110,${(0.26 + 0.04 * Math.sin(now / 600)).toFixed(3)})`;
    ctx.fillRect(x0, y0, w, h);
  }
  ctx.restore();
}

// A candelabra on its stand: three tapers, burning with a glow round them or
// dark with a thread of smoke, and a ring on the floor round a dark one
// showing where to stand. Somebody lighting it sends sparks up its tapers for
// everybody to see — not who it is.
function drawCandle(t, k, now, mineLc) {
  const [x, y] = CANDLES[k];
  const lit = t.cl[k] === 1;
  const sx = SX(x), sy = SY(y), s = sc;
  if (!lit) {
    ctx.strokeStyle = `rgba(255,214,120,${(0.35 + 0.2 * Math.sin(now / 300 + k)).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, 4 * s);
    ctx.setLineDash([Math.max(2, 14 * s), Math.max(2, 12 * s)]);
    disc(sx, sy, LIGHT_R * s);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    const glow = ctx.createRadialGradient(sx, sy - 70 * s, 0, sx, sy - 70 * s, 190 * s);
    glow.addColorStop(0, 'rgba(255,214,120,0.42)');
    glow.addColorStop(1, 'rgba(255,214,120,0)');
    ctx.fillStyle = glow;
    disc(sx, sy - 70 * s, 190 * s);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(30,10,20,0.35)';
  ctx.beginPath(); ctx.ellipse(sx, sy + 4 * s, 34 * s, 12 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#b8862f';
  ctx.beginPath(); ctx.ellipse(sx, sy, 24 * s, 9 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(sx - 4 * s, sy - 60 * s, 8 * s, 60 * s);
  ctx.strokeStyle = '#d9a84e';
  ctx.lineWidth = Math.max(1, 6 * s);
  ctx.beginPath();
  ctx.moveTo(sx - 34 * s, sy - 78 * s);
  ctx.quadraticCurveTo(sx - 34 * s, sy - 56 * s, sx, sy - 58 * s);
  ctx.quadraticCurveTo(sx + 34 * s, sy - 56 * s, sx + 34 * s, sy - 78 * s);
  ctx.stroke();
  const busy = playersIn(t).some((id) => t.p[id].lw === k && t.p[id].lc > 0);
  for (const dx of [-34, 0, 34]) {
    const tx = sx + dx * s, top = sy - (dx ? 100 : 112) * s;
    ctx.fillStyle = '#f7efe0';
    ctx.fillRect(tx - 5 * s, top, 10 * s, (dx ? 22 : 34) * s);
    if (lit) {
      const f = 1 + 0.12 * Math.sin(now / 90 + dx + k * 3);
      ctx.fillStyle = 'rgba(255,170,60,0.9)';
      ctx.beginPath(); ctx.ellipse(tx, top - 9 * s * f, 7 * s, 14 * s * f, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff3c4';
      ctx.beginPath(); ctx.ellipse(tx, top - 6 * s * f, 3.5 * s, 7 * s * f, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = INK.smoke;
      ctx.lineWidth = Math.max(1, 3 * s);
      ctx.beginPath();
      ctx.moveTo(tx, top);
      for (let i = 1; i <= 4; i++) ctx.lineTo(tx + Math.sin(now / 400 + i + dx) * 6 * s, top - i * 12 * s);
      ctx.stroke();
      if (busy) {
        for (let i = 0; i < 3; i++) {
          const ph = ((now / 600 + i / 3 + dx / 100) % 1);
          ctx.fillStyle = `rgba(255,214,120,${(0.9 * (1 - ph)).toFixed(3)})`;
          disc(tx + Math.sin(now / 150 + i * 2) * 5 * s, top - ph * 40 * s, Math.max(1, 3.5 * s));
          ctx.fill();
        }
      }
    }
  }
  if (mineLc > 0 && !lit) {
    ctx.strokeStyle = INK.gold;
    ctx.lineWidth = Math.max(2, 8 * s);
    ctx.beginPath();
    ctx.arc(sx, sy, LIGHT_R * s, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * mineLc) / LIGHT_STEPS);
    ctx.stroke();
  }
}

// A mask: a gold domino with two eye holes and a feather in the gown's accent.
function maskShape(x, y, r, accent, face, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot || 0);
  ctx.scale(face, 1);
  ctx.fillStyle = INK.mask;
  ctx.beginPath();
  ctx.moveTo(-r * 1.05, -r * 0.1);
  ctx.quadraticCurveTo(-r * 0.6, -r * 0.55, 0, -r * 0.25);
  ctx.quadraticCurveTo(r * 0.6, -r * 0.55, r * 1.05, -r * 0.1);
  ctx.quadraticCurveTo(r * 0.7, r * 0.45, 0, r * 0.15);
  ctx.quadraticCurveTo(-r * 0.7, r * 0.45, -r * 1.05, -r * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2a1424';
  ctx.beginPath(); ctx.ellipse(-r * 0.42, -r * 0.07, r * 0.22, r * 0.12, 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(r * 0.42, -r * 0.07, r * 0.22, r * 0.12, -0.2, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(r * 0.9, -r * 0.25);
  ctx.quadraticCurveTo(r * 1.5, -r * 1.0, r * 1.1, -r * 1.7);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.restore();
}

// A dancer, standing up on the floor: a bell of a gown, a bodice, a head and
// a gold mask with a feather, swaying as it walks. Every guest and every
// player is drawn by this one function from what the table says alone, so no
// screen can tell them apart. A face the room has seen has its mask off, a
// ring under it in its player's colour and their name over it; a dancer
// dazed has stars round its head; the leader's mask catches the light. Your
// own dancer has a dashed ring and an arrow over it, on your screen only.
function drawDancer(num, sx, sy, look, moving, opts, now) {
  const l = lookOf(num, now);
  l.gait += frameDt * (moving ? 9 : 2.2);
  l.lunge *= Math.pow(0.86, frameDt * 60);
  if (moving && opts.vx) l.face = opts.vx > 0 ? 1 : -1;
  const s = 40 * sc;
  const [gown, accent] = GOWN[look] || GOWN[0];
  const sway = Math.sin(l.gait) * (moving ? 0.1 : 0.04);
  const bob = moving ? Math.abs(Math.sin(l.gait)) * s * 0.08 : 0;
  const lx = sx + l.lx * l.lunge * s * 0.9, ly = sy + l.ly * l.lunge * s * 0.6;
  ctx.fillStyle = 'rgba(40,14,10,0.32)';
  ctx.beginPath(); ctx.ellipse(lx, ly, s * 0.95, s * 0.34, 0, 0, Math.PI * 2); ctx.fill();
  if (opts.ring) {
    ctx.strokeStyle = opts.ring;
    ctx.lineWidth = Math.max(2, s * 0.14);
    ctx.beginPath(); ctx.ellipse(lx, ly, s * 1.15, s * 0.46, 0, 0, Math.PI * 2); ctx.stroke();
  }
  if (opts.me) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1.5, s * 0.07);
    ctx.setLineDash([Math.max(2, s * 0.25), Math.max(2, s * 0.18)]);
    ctx.beginPath(); ctx.ellipse(lx, ly, s * 1.3, s * 0.55, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.save();
  ctx.translate(lx, ly - bob);
  ctx.rotate(sway + l.lx * l.lunge * 0.3);
  // The gown: a bell from the waist to the floor, with a hem of the accent.
  const gg = ctx.createLinearGradient(-s, 0, s, 0);
  gg.addColorStop(0, shade(gown, -0.25));
  gg.addColorStop(0.45, shade(gown, 0.12));
  gg.addColorStop(1, shade(gown, -0.35));
  ctx.fillStyle = gg;
  ctx.beginPath();
  ctx.moveTo(-s * 0.32, -s * 1.15);
  ctx.quadraticCurveTo(-s * 0.95, -s * 0.4, -s * 0.92, -s * 0.05);
  ctx.quadraticCurveTo(0, s * 0.22, s * 0.92, -s * 0.05);
  ctx.quadraticCurveTo(s * 0.95, -s * 0.4, s * 0.32, -s * 1.15);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, s * 0.08);
  ctx.beginPath();
  ctx.moveTo(-s * 0.9, -s * 0.12);
  ctx.quadraticCurveTo(0, s * 0.14, s * 0.9, -s * 0.12);
  ctx.stroke();
  // The bodice and the arms.
  ctx.fillStyle = shade(gown, -0.15);
  roundRect(-s * 0.3, -s * 1.7, s * 0.6, s * 0.65, s * 0.2);
  ctx.fill();
  ctx.strokeStyle = INK.skin;
  ctx.lineWidth = Math.max(1, s * 0.12);
  ctx.lineCap = 'round';
  const arm = Math.sin(l.gait) * (moving ? 0.25 : 0.08);
  ctx.beginPath();
  ctx.moveTo(-s * 0.28, -s * 1.55); ctx.lineTo(-s * 0.55, -s * (1.05 + arm));
  ctx.moveTo(s * 0.28, -s * 1.55); ctx.lineTo(s * 0.55 + l.lunge * s * 0.5, -s * (1.05 - arm) - l.lunge * s * 0.4);
  ctx.stroke();
  ctx.lineCap = 'butt';
  // The head, the hair, and the mask — or the face, once the room has seen it.
  const hy = -s * 2.0;
  ctx.fillStyle = INK.skin;
  disc(0, hy, s * 0.38);
  ctx.fill();
  ctx.fillStyle = shade(gown, -0.55);
  ctx.beginPath();
  ctx.arc(0, hy - s * 0.05, s * 0.4, Math.PI * 1.05, Math.PI * 1.95);
  ctx.fill();
  if (opts.shown) {
    ctx.fillStyle = '#2a1424';
    disc(-s * 0.13 * l.face, hy, Math.max(0.8, s * 0.05)); ctx.fill();
    disc(s * 0.13 * l.face, hy, Math.max(0.8, s * 0.05)); ctx.fill();
    ctx.strokeStyle = '#8a3a4a';
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.beginPath(); ctx.arc(0, hy + s * 0.12, s * 0.1, 0.2, Math.PI - 0.2); ctx.stroke();
  } else {
    maskShape(0, hy + s * 0.02, s * 0.36, accent, l.face, 0);
    if (opts.glint) {
      const k = 0.6 + 0.4 * Math.sin(now / 60);
      ctx.fillStyle = `rgba(255,255,240,${k.toFixed(3)})`;
      const gx = s * 0.3 * l.face, gy = hy - s * 0.08, r = s * 0.42 * k;
      ctx.beginPath();
      ctx.moveTo(gx, gy - r); ctx.lineTo(gx + r * 0.2, gy - r * 0.2); ctx.lineTo(gx + r, gy);
      ctx.lineTo(gx + r * 0.2, gy + r * 0.2); ctx.lineTo(gx, gy + r); ctx.lineTo(gx - r * 0.2, gy + r * 0.2);
      ctx.lineTo(gx - r, gy); ctx.lineTo(gx - r * 0.2, gy - r * 0.2);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
  let top = ly - bob - s * 2.55;
  if (opts.dazed) {
    ctx.fillStyle = INK.gold;
    for (let i = 0; i < 3; i++) {
      const a = now / 220 + (i * Math.PI * 2) / 3;
      disc(lx + Math.cos(a) * s * 0.55, top + s * 0.1 + Math.sin(a) * s * 0.18, Math.max(1.2, s * 0.1));
      ctx.fill();
    }
    top -= s * 0.25;
  }
  if (opts.me) {
    const ay = top - s * 0.15 - Math.abs(Math.sin(now / 300)) * s * 0.15;
    ctx.fillStyle = opts.mine;
    ctx.beginPath();
    ctx.moveTo(lx, ay);
    ctx.lineTo(lx - s * 0.22, ay - s * 0.3);
    ctx.lineTo(lx + s * 0.22, ay - s * 0.3);
    ctx.closePath();
    ctx.fill();
    top = ay - s * 0.35;
  }
  if (opts.label) {
    const px = Math.max(9, Math.min(13, 6 + s * 0.2));
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(px);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.strokeText(opts.label, lx, top - 2);
    ctx.fillStyle = opts.ring || '#ffffff';
    ctx.fillText(opts.label, lx, top - 2);
  }
}

function drawBits() {
  flat();
  for (const m of masks) {
    const f = m.life / m.max;
    ctx.globalAlpha = 1 - f * f;
    maskShape(SX(m.x), SY(m.y), 40 * sc * 0.4, (GOWN[m.look] || GOWN[0])[1], 1, m.spin);
  }
  for (const b of bits) {
    const f = b.life / b.max;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = b.colour;
    const r = b.size * sc * (1 - f * 0.5);
    if (b.sq) {
      ctx.save();
      ctx.translate(SX(b.x), SY(b.y));
      ctx.rotate(b.life * 0.3);
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    } else {
      disc(SX(b.x), SY(b.y), r);
      ctx.fill();
    }
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
    ctx.font = font(p.px * scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK.ink;
    const half = Math.min(W * sc / 2 - 10, ctx.measureText(p.s).width / 2 + 6);
    const X = Math.max(ox + half, Math.min(ox + W * sc - half, SX(p.x))), Y = Math.max(fieldTop + 18, SY(p.y) - rise);
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
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left';
    if (midnight(t)) { status += ' · midnight'; colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text; }
  } else status = 'round ' + t.rd + ' · over';
  text('masquerade', 12, 22, titlePx, '#ffd9ec', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('masquerade').width;
  if (wide) fitText(status, 12, 44, 14, colour, colW - 24, 'left');
  else fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with their points this
  // round and rounds won, and a crown's gold on the leader's points. A row
  // across the top of a narrow frame, a column down the left of a wide one.
  const ids = bySeat(t);
  const lead = leaderOf(t);
  if (ids.length) {
    const gap = 6;
    const cw = wide ? Math.min(200, colW - 24) : Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = wide ? 12 : (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    let y = wide ? 76 : narrow ? 46 : 44;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      disc(x + 11, y - 2, 5);
      ctx.fillStyle = c;
      ctx.fill();
      if (!onFloor(d)) { ctx.strokeStyle = INK.page; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + 7, y - 6); ctx.lineTo(x + 15, y + 2); ctx.stroke(); }
      const score = String(d.rp);
      ctx.font = font(12);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 8, y + 3, 12, id === lead ? INK.gold : INK.text, 'right');
      const wins = t.ph !== WAIT && d.wn ? '★' + d.wn : '';
      ctx.font = font(10);
      const ww = wins ? ctx.measureText(wins).width + 5 : 0;
      if (wins && cw > 56) text(wins, x + cw - 12 - sw, y + 2, 10, '#fff1f8', 'right');
      if (cw > 64) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw - ww, 'left');
      if (wide) y += 22 + gap; else x += cw + gap;
    }
  }

  // The one line that says how to play: across the foot of a narrow frame, and
  // broken into lines at the foot of the right-hand column of a wide one.
  const how = coarse
    ? 'drag to walk · stand by a dark candle to light it · tap to unmask whoever is nearest'
    : 'arrows/WASD walk · stand by a dark candle to light it · space, X or click unmasks the nearest · M mutes';
  if (!wide) { fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20); return; }
  const lines = wrap(how, 12, colW - 24);
  lines.forEach((s, i) => text(s, VW - 12, VH - 12 - (lines.length - 1 - i) * 17, 12, INK.muted, 'right'));
}

// Your lunge while a round is on: in the strip under the floor, or halfway
// down the right-hand column of a wide one.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = wide ? VH / 2 : Math.min(fieldBot + NOTE_ROOM / 2 - 4, VH - BOT - 18);
  const mid = wide ? VW - colW / 2 : VW / 2, room_ = wide ? colW - 24 : VW - 24;
  const behind = trails(t, myId());
  let word = 'unmask', top = behind ? LUNGE_CD_BEHIND : LUNGE_CD, left = d.cd, hue = d.cd === 0 ? SEAT[d.c] : INK.dim;
  if (!onFloor(d)) { word = 'unmasked · back in ' + Math.max(1, Math.ceil(d.out / HZ)); top = OUT; left = d.out; hue = '#ff8a8a'; }
  else if (d.st > 0) { word = 'dazed'; top = STUN; left = d.st; hue = '#ff8a8a'; }
  else if (d.rv > 0) { word = 'face shown'; top = SHOWN; left = d.rv; hue = '#ffb27a'; }
  ctx.font = font(12);
  const kw = ctx.measureText(word).width;
  const bar = 60;
  const total = kw + 8 + bar;
  const k = Math.min(1, room_ / total);
  let x = mid - (total * k) / 2;
  text(word, x, y + 4, 12, hue === INK.dim ? INK.dim : INK.text, 'left');
  x += (kw + 8) * k;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(x, y - 4, bar * k, 8, 4);
  ctx.fill();
  ctx.fillStyle = hue;
  roundRect(x, y - 4, Math.max(8, bar * k * (1 - Math.min(1, left / top))), 8, 4);
  ctx.fill();
  if (behind) fitText('behind: you reach further and unmask sooner', mid, y + 22, 11, INK.dim, room_);
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
  if (t.ph === WAIT) {
    const two = humans(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'walk in straight lines and pause, like the crowd · the bot is one of the dancers';
    if (wide) practiceNote(now, VW, head, tip, [], VH - 8);
    else practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
    const d = t.p[myId()];
    if (d && !onFloor(d)) {
      panel(cx, mid, Math.min(VW - 32, 280), 34);
      fitText('unmasked · back in the crowd in ' + Math.max(1, Math.ceil(d.out / HZ)), cx, mid + 5, 14, INK.text, Math.min(VW - 48, 260));
    }
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 380), 30);
    fitText('find yourself · blend in · light candles · unmask rivals', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 360));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('dance!', cx, mid + big * 0.5);
    text('dance!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= 5 * HZ) {
    const n = Math.ceil(t.pt / HZ);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK.ink;
    ctx.font = font(big * 2);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big * 0.7);
    text(String(n), cx, mid + big * 0.7, big * 2, INK.gold, 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 340), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody stole the ball';
    else head = t.win === me ? 'you are the belle of the ball!' : nickOf(t.win) + ' is the belle of the ball';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('lit', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('caught', cx + w / 2 - 62, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, rp, lit, um, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(lit), cx + w / 2 - 110, y, 13, '#fff1f8', 'right');
      text(String(um), cx + w / 2 - 62, y, 13, '#fff1f8', 'right');
      text(String(rp), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Every dancer on a table, by number: where it stands, its gown, and the
// player wearing it, if any.
function dancers(t) {
  const m = new Map();
  for (const q of t.g) m.set(q[0], { x: q[1], y: q[2], lk: q[6], id: null });
  for (const id of playersIn(t)) {
    const d = t.p[id];
    if (onFloor(d)) m.set(d.dn, { x: d.x, y: d.y, lk: d.lk, id });
  }
  return m;
}

// Your own dancer is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a hand a step away from
// where the guess had it. So the dancer drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a dancer slipped into somewhere new — puts it there at once.
// Only the drawing is smoothed: the floor, and every rule on it, are
// untouched.
const PULL = 0.5;
let shown = null;        // [x, y, number] in units: where your dancer is drawn

function settle(x, y, num) {
  if (!shown || shown[2] !== num || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 200) return (shown = [x, y, num]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  fit();
  const b = agreedAt(now);
  drawBack(now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('finding the ballroom…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  const md = t.p[me];
  // Your own dancer as the guess has it, while the guess has you on the floor.
  const m = mineAt(now);
  let mine = null;
  if (md && onFloor(md)) {
    const own = m && m.to.p[me] && onFloor(m.to.p[me]) && m.to.p[me].dn === md.dn ? m : b;
    const a = own.from.p[me], z = own.to.p[me];
    let x = z.x, y = z.y, vx = 0;
    if (a && a.dn === z.dn && Math.abs(a.x - z.x) + Math.abs(a.y - z.y) <= 200) {
      x = lerp(a.x, z.x, own.k); y = lerp(a.y, z.y, own.k); vx = z.x - a.x;
      mine = { moving: a.x !== z.x || a.y !== z.y };
    } else mine = { moving: false };
    const [sx, sy] = settle(x, y, z.dn);
    Object.assign(mine, { x: sx, y: sy, vx, d: z });
  } else {
    shown = null;
  }
  drawFloor(t, now);
  const things = [];
  CANDLES.forEach(([, cy], k) => things.push({ y: cy, f: () => drawCandle(t, k, now, md && md.lw === k ? md.lc : 0) }));
  const before = dancers(b.from), after = dancers(t);
  const lead = leaderOf(t);
  for (const [num, z] of after) {
    if (z.id === me) continue;
    const a = before.get(num);
    let x = z.x, y = z.y, vx = 0, moving = false;
    if (a && Math.abs(a.x - z.x) + Math.abs(a.y - z.y) <= 200) {
      x = lerp(a.x, z.x, b.k); y = lerp(a.y, z.y, b.k); vx = z.x - a.x; moving = a.x !== z.x || a.y !== z.y;
    }
    const d = z.id !== null ? t.p[z.id] : null;
    const opts = { vx };
    if (d) {
      if (d.rv > 0) { opts.shown = true; opts.ring = SEAT[d.c]; opts.label = nickOf(z.id); }
      if (d.st > 0) opts.dazed = true;
      if (z.id === lead && glinting(t, z.id)) opts.glint = true;
    }
    things.push({ y, f: () => drawDancer(num, SX(x), SY(y), z.lk, moving, opts, now) });
  }
  if (mine) {
    const d = mine.d;
    const opts = { vx: mine.vx, me: true, mine: SEAT[d.c], dazed: d.st > 0, glint: me === lead && glinting(t, me) };
    if (d.rv > 0) { opts.shown = true; opts.ring = SEAT[d.c]; opts.label = 'you'; }
    things.push({ y: mine.y, f: () => drawDancer(d.dn, SX(mine.x), SY(mine.y), d.lk, mine.moving, opts, now) });
  }
  things.sort((p, q) => p.y - q.y);
  flat();
  for (const th of things) th.f();
  for (const [num, look] of looks) if (now - look.seen > 1000) looks.delete(num);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: which of the eight ways to walk, or to stand, and how
// many lunges so far. A change of way goes out no oftener than STEER_EVERY,
// because a thumb changes it on every move the screen reports and the clock's
// ticks share the same seat's ceiling on messages; a lunge goes out at once.
const STEER_EVERY = 80;
let lungesAsked = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const LEFT = ['ArrowLeft', 'KeyA'], RIGHT = ['ArrowRight', 'KeyD'], UP = ['ArrowUp', 'KeyW'], DOWN = ['ArrowDown', 'KeyS'];
const LUNGE = ['Space', 'KeyX', 'KeyJ', 'KeyK', 'Enter'];

// A thumb or a mouse: a stick from wherever it lands, pointing one of the
// eight ways once it is dragged past DEAD; a tap lunges — a drag rather than
// a press, because iOS keeps a long press inside a frame for itself. A second
// finger down while the first steers lunges too, and so does a right click.
const DEAD = 14;
const REACH_PX = 46;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }

function handNow() {
  let way = 0;
  if (stick && Math.hypot(stick.dx, stick.dy) > DEAD) way = wayTo(Math.round(stick.dx * 100), Math.round(stick.dy * 100));
  const kx = (RIGHT.some((c) => keys.has(c)) ? 1 : 0) - (LEFT.some((c) => keys.has(c)) ? 1 : 0);
  const ky = (DOWN.some((c) => keys.has(c)) ? 1 : 0) - (UP.some((c) => keys.has(c)) ? 1 : 0);
  if (kx || ky) way = wayTo(kx, ky);
  return way;
}

function sayHand(now, force) {
  const h = [handNow(), lungesAsked], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1]) return;
  if (!force && s && h[1] === s[1] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A lunge: heard at once, and taken a trip later on every copy alike, if the
// table says the cooldown is over.
function lungeNow() {
  wake();
  if (!world) return;
  lungesAsked = (lungesAsked + 1) % 1000;
  sayHand(performance.now(), true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (LUNGE.includes(e.code)) { e.preventDefault(); if (!e.repeat) lungeNow(); return; }
  if (![...LEFT, ...RIGHT, ...UP, ...DOWN].includes(e.code)) return;
  e.preventDefault();
  coarse = false;
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
  sayHand(performance.now(), true);
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (e.button === 2) { lungeNow(); return; }
  if (stick) { lungeNow(); return; }
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0, at: performance.now(), moved: false };
  paintStick();
});
cv.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.id) return;
  stick.dx = e.clientX - stick.ox;
  stick.dy = e.clientY - stick.oy;
  if (Math.hypot(stick.dx, stick.dy) >= DEAD) stick.moved = true;
  paintStick();
  sayHand(performance.now(), false);
});
function liftPointer(e) {
  if (!stick || e.pointerId !== stick.id) return;
  const tap = !stick.moved && performance.now() - stick.at < 260;
  stick = null;
  paintStick();
  sayHand(performance.now(), true);
  if (tap) lungeNow();
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', liftPointer);
addEventListener('pointerup', liftPointer);
addEventListener('pointercancel', liftPointer);

const stickRing = document.createElement('div');
stickRing.style.cssText =
  `position:fixed;display:none;width:${REACH_PX * 2}px;height:${REACH_PX * 2}px;` +
  `margin:${-REACH_PX}px 0 0 ${-REACH_PX}px;border-radius:50%;pointer-events:none;` +
  'border:1px solid rgba(255,255,255,0.35);background:rgba(255,255,255,0.06)';
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  'border-radius:50%;pointer-events:none;background:#ffffff;opacity:.55';
document.body.append(stickRing, knob);
function paintStick() {
  if (!stick || !coarse) { stickRing.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(stick.dx, stick.dy);
  const k = far > REACH_PX ? REACH_PX / far : 1;
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
  setHand([0, lungesAsked]);
  lastSaid = [0, lungesAsked];
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
