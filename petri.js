/**
 * @disk     petri
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Colonies at war in one petri dish. Drag from a colony you own to any other to send half its microbes: more than the defenders takes it. Big colonies grow faster, the gold nucleus twice as fast. Wiped out, you drift back as a spore. Most microbes at the horn wins.
 * @tags     game, party, realtime, strategy, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/petri.png
 */
// petri.js — a colony war in one dish, where the room's order is the referee.
//
// Every copy holds the whole dish — every colony, who owns it, how many
// microbes are in it, every swarm on its way — and changes it only on what
// comes back round the room, so every copy applies the same hands in the same
// order and holds the same dish. Nobody sends how many microbes they have,
// whom a swarm beat or who took a colony: a hand is "send half of this colony
// of mine to that one", nothing else, and what the swarm does when it lands is
// worked out by the same arithmetic on the same numbers on every machine. A
// page with a console open can send swarms from its own colonies however it
// likes, at a hand's own pace, and no faster.
//
// Your own sends do not wait for the trip: the dish is drawn from the agreed
// one played forward by the trip, with your hands already in it.
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

// Sine and cosine from + - * / alone, since a browser may round its own
// `Math.sin` its own way and the dish is laid by every copy for itself. Where
// colonies stand is rounded to whole units after this, too.
const TAU = 6.283185307179586;
function sinT(x) {
  x -= TAU * Math.round(x / TAU);
  const x2 = x * x;
  let term = x, sum = x;
  for (let k = 1; k <= 9; k++) {
    term *= -x2 / ((2 * k) * (2 * k + 1));
    sum += term;
  }
  return sum;
}
const cosT = (x) => sinT(x + TAU / 4);

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the dish a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw the dish a trip ahead, with your own sends in it

const R = 100;                 // the dish's radius, in units
const MAXC = 32;               // the most colonies a dish holds
const MAX_P = 8;
const MAX_FL = 160;            // swarms on their way at once, every player's together
const RADI = [0, 5, 7, 9];     // a colony's radius by its size, 1 to 3
const CAP = [0, 40, 80, 120];  // what a colony of each size holds before it starts to starve
const GROW = 60;               // growth a microbe costs; a colony earns its size twice over a step
const SPEED = 2;               // units a swarm crosses a step
const REFILL = 5;              // steps a send costs, out of a purse that refills a step at a time
const PURSE = 3 * REFILL;      // the most a purse holds: three sends back to back, no more
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const HOME_POP = 30;           // microbes a home colony starts a round with
const SPORE_POP = 15;          // microbes a spore lands with
const RESPAWN = 4 * HZ;        // steps a wiped-out player drifts before landing as a spore
const UI_GAP = 220;            // ms this page waits between its own sends, a little over the purse's pace
const BOT_ID = -100;           // the practice bot's id: no room hands out a negative one
const BOT_THINK0 = 26, BOT_THINK1 = 46; // steps the bot waits between looks at the dish
const BOT_SLIP = 0.25;         // how often it takes a worse send than the best it found
const BOT_DOZE = 0.2;          // how often it lets a look go by without sending anything

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 100 * HZ;
const END_STEPS = 8 * HZ;
const BLOOM = 25 * HZ;         // the last steps of a round, where every colony grows twice as fast

// The dish. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came
// from, so every player is made by one function with its fields in one order.
//   x, y: where each colony stands, whole units from the middle; z: its size,
//   1 to 3; o: its owner's id, or -1 for nobody; m: microbes in it; g: growth
//   saved towards the next microbe
//   nu: the gold nucleus's index; fl: swarms as [id, owner, microbes, from,
//   to, steps left, steps in all]; fid: the next swarm's id
//   res: the last round's [id, microbes, rounds won, colonies taken] rows;
//   win: its winner or -1
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, nu: 0, fid: 0, x: [], y: [], z: [], o: [], m: [], g: [], fl: [], p: {},
    res: null, win: -1,
  };
  lay(w, []);
  return w;
}

const FIELDS = ['c', 's', 'q', 'tk', 'hs', 'hc', 'wn', 'tot', 'bz', 'ds', 'tl'];
//   c: colour; s: seat; q: the number of the last send heard; tk: the send
//   purse; hs, hc: hands this step; wn: rounds won; tot: microbes held, in
//   colonies and on the way; bz: 1 while they trail far enough to grow twice
//   as fast; ds: steps spent wiped out; tl: colonies taken this round.
function player(v) {
  const d = {};
  for (const f of FIELDS) d[f] = v[f];
  return d;
}

const playersIn = (w) => Object.keys(w.p).map(Number);
const bySeat = (w) => playersIn(w).sort((a, b) => w.p[a].s - w.p[b].s);
const humansIn = (w) => playersIn(w).filter((id) => id !== BOT_ID);

function freeOf(w, f) {
  const taken = new Set(Object.values(w.p).map((d) => d[f]));
  for (let k = 0; k < MAX_P; k++) if (!taken.has(k)) return k;
  return 0;
}

// A new dish for these players: the gold nucleus in the middle, a home for
// each of them spaced evenly round the rim, and wild colonies scattered over
// one slice and copied round to every other, so every home faces the same
// dish. A dish laid for one player is laid for two, the second home wild.
function lay(w, ids) {
  const n = Math.max(2, ids.length);
  const per = n <= 2 ? 6 : n === 3 ? 5 : n === 4 ? 4 : n <= 6 ? 3 : 2;
  const rot = draw01(w) * TAU;
  const xs = [0], ys = [0], zs = [3];
  const fits = (x, y, z) => {
    if (x * x + y * y > (R - RADI[z] - 4) * (R - RADI[z] - 4)) return false;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - x, dy = ys[i] - y, gap = RADI[zs[i]] + RADI[z] + 7;
      if (dx * dx + dy * dy < gap * gap) return false;
    }
    return true;
  };
  for (let k = 0; k < n; k++) {
    const a = rot + (TAU * k) / n;
    xs.push(Math.round(cosT(a) * 74));
    ys.push(Math.round(sinT(a) * 74));
    zs.push(2);
  }
  const pops = [];
  for (let placed = 0, guard = 0; placed < per && guard < 300; guard++) {
    const rr = 24 + draw01(w) * 66;
    const off = (draw01(w) - 0.5) * (TAU / n);
    const roll = draw01(w);
    const z = roll < 0.45 ? 1 : roll < 0.8 ? 2 : 3;
    const pop = 2 + Math.floor(draw01(w) * 5) + 5 * z;
    const at = [];
    for (let k = 0; k < n; k++) {
      const a = rot + (TAU * k) / n + off;
      at.push([Math.round(cosT(a) * rr), Math.round(sinT(a) * rr)]);
    }
    // Every copy round the dish has to fit, each beside the others.
    const before = xs.length;
    let ok = true;
    for (const [x, y] of at) {
      if (!fits(x, y, z)) { ok = false; break; }
      xs.push(x); ys.push(y); zs.push(z);
    }
    if (!ok || xs.length > MAXC) {
      xs.length = before; ys.length = before; zs.length = before;
      continue;
    }
    for (let k = 0; k < n; k++) pops.push(pop);
    placed += 1;
  }
  w.nu = 0;
  w.x = xs;
  w.y = ys;
  w.z = zs;
  w.o = xs.map(() => -1);
  w.m = xs.map(() => 0);
  w.g = xs.map(() => 0);
  w.m[0] = 30;
  for (let k = 0; k < n; k++) {
    const id = k < ids.length ? ids[k] : -1;
    w.o[1 + k] = id;
    w.m[1 + k] = id === -1 ? 20 : HOME_POP;
  }
  for (let i = 0; i < pops.length; i++) w.m[1 + n + i] = pops[i];
  w.fl = [];
}

// How far apart two colonies are in steps of a swarm, rim to rim. A square
// root is rounded the same way by every engine, so this is the same number on
// every copy.
function travel(w, a, b) {
  const dx = w.x[b] - w.x[a], dy = w.y[b] - w.y[a];
  const d = Math.sqrt(dx * dx + dy * dy) - RADI[w.z[a]] - RADI[w.z[b]];
  return Math.max(1, Math.ceil(d / SPEED));
}

// Half of a colony leaves for another, if it is the sender's to send from and
// the sender's purse can pay for it.
function launch(w, id, a, b) {
  const d = w.p[id];
  const K = w.x.length;
  if (!d || a < 0 || b < 0 || a >= K || b >= K || a === b) return false;
  if (w.o[a] !== id || w.m[a] < 2 || d.tk < REFILL || w.fl.length >= MAX_FL) return false;
  const n = Math.floor(w.m[a] / 2);
  const steps = travel(w, a, b);
  w.m[a] -= n;
  d.tk -= REFILL;
  w.fl.push([w.fid, id, n, a, b, steps, steps]);
  w.fid = (w.fid + 1) % 1000000;
  fx(w, 'send', a, id, b, n);
  return true;
}

// A hand, at its place in the room's order: [the number of this send, from,
// to]. A send is heard once, when its number changes; the same hand said
// again to keep a player at the table sends nothing. Being heard is how a
// player arrives: alone with the bot they get a fresh dish of their own, in a
// round they drift in as a spore, and between those they wait for the next.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    w.p[id] = player({
      c: freeOf(w, 'c'), s: freeOf(w, 's'), q: input[0], tk: PURSE, hs: w.n, hc: 0, wn: 0, tot: 0, bz: 0,
      ds: RESPAWN - HZ, tl: 0,
    });
    if (w.ph === WAIT && humansIn(w).length < 2) lay(w, bySeat(w));
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike, and a send is paid for out of a purse that refills at a
  // hand's pace whoever sends it.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  const q = input[0];
  if (q === d.q) return;
  d.q = q;
  if (!moving(w)) return;
  launch(w, id, input[1], input[2]);
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const q = raw[0], a = raw[1], b = raw[2];
  if (!Number.isInteger(q) || q < 0 || q > 999) return null;
  if (!Number.isInteger(a) || a < -1 || a >= MAXC || !Number.isInteger(b) || b < -1 || b >= MAXC) return null;
  return [q, a, b];
}

// Whoever leaves takes their swarms with them; their colonies go wild with
// whatever is in them.
function leave(w, id) {
  delete w.p[id];
  for (let i = 0; i < w.o.length; i++) if (w.o[i] === id) w.o[i] = -1;
  w.fl = w.fl.filter((f) => f[1] !== id);
}

// The dish moves while practice runs with one player and through a round;
// the count before a round and the scores after it hold still.
const moving = (w) => w.ph === PLAY || (w.ph === WAIT && humansIn(w).length < 2);

// The practice bot sits in while the dish waits for a round, so whoever has
// it to themselves has somebody to play, and stands up just before a round
// begins: it never takes part in one. It lives in the table and is moved by
// the step, so every copy plays it alike and nobody's page can steer it.
function seatBot(w) {
  const here = !!w.p[BOT_ID];
  if (w.ph === WAIT && humansIn(w).length === 1 && !here) {
    w.p[BOT_ID] = player({
      c: freeOf(w, 'c'), s: freeOf(w, 's'), q: BOT_THINK1, tk: PURSE, hs: 0, hc: 0, wn: 0, tot: 0, bz: 0, ds: 0,
      tl: 0,
    });
    lay(w, bySeat(w));
  } else if ((w.ph !== WAIT || !humansIn(w).length) && here) {
    leave(w, BOT_ID);
  }
}

// How fast a colony grows this step: twice its size, twice that for the
// nucleus, twice again in the bloom and for whoever trails far behind.
function rateOf(w, i) {
  let r = 2 * w.z[i];
  if (i === w.nu) r *= 2;
  if (w.ph === PLAY && w.pt <= BLOOM) r *= 2;
  const d = w.p[w.o[i]];
  if (d && d.bz) r *= 2;
  return r;
}

// The bot's hand: every few steps it weighs every send it could make from a
// colony that has something to send, and takes the one that wins the most for
// the least — or, now and then, one that wins less, or none at all. It never
// sends a swarm it does not expect to win with, counting what the target
// grows while the swarm is on its way.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.q > 0) { d.q -= 1; return; }
  d.q = BOT_THINK0 + Math.floor(draw01(w) * (BOT_THINK1 - BOT_THINK0));
  if (d.tk < REFILL || draw01(w) < BOT_DOZE) return;
  const K = w.x.length;
  const good = [];
  for (let a = 0; a < K; a++) {
    if (w.o[a] !== BOT_ID || w.m[a] < 8) continue;
    const send = Math.floor(w.m[a] / 2);
    for (let b = 0; b < K; b++) {
      if (b === a || w.o[b] === BOT_ID) continue;
      const steps = travel(w, a, b);
      const def = w.m[b] + (w.o[b] === -1 ? 0 : Math.floor((rateOf(w, b) * steps) / GROW)) + 2;
      if (send <= def) continue;
      const worth = w.z[b] * 10 + (b === w.nu ? 12 : 0) + (w.o[b] === -1 ? 0 : 5);
      good.push([Math.floor((worth * 1000) / (def * 3 + steps + 20)), a, b]);
    }
  }
  if (!good.length) return;
  good.sort((p, q) => q[0] - p[0] || p[1] - q[1] || p[2] - q[2]);
  const pick = good.length > 1 && draw01(w) < BOT_SLIP ? good[1] : good[0];
  launch(w, BOT_ID, pick[1], pick[2]);
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  for (const id of playersIn(w)) w.p[id].bz = 0;
  lay(w, bySeat(w));
}

// A round: a new dish, the seats closed up in order so the homes go round
// the rim without a gap, every purse full.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  bySeat(w).forEach((id, i) => {
    const d = w.p[id];
    d.s = i;
    d.tk = PURSE;
    d.bz = 0;
    d.ds = 0;
    d.tl = 0;
  });
  lay(w, bySeat(w));
  totals(w);
  fx(w, 'round');
}

function finish(w) {
  totals(w);
  const res = bySeat(w).map((id) => {
    const d = w.p[id];
    return [id, d.tot, d.wn, d.tl];
  });
  res.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (res.length && res[0][1] > 0 && (res.length < 2 || res[1][1] < res[0][1])) {
    w.win = res[0][0];
    w.p[w.win].wn += 1;
    res[0][2] += 1;
  }
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  w.fl = [];
  fx(w, 'end', 0, w.win);
}

// Microbes each player holds, and who trails far enough behind the leader —
// under half of them — to grow twice as fast.
function totals(w) {
  const ids = playersIn(w);
  for (const id of ids) w.p[id].tot = 0;
  for (let i = 0; i < w.o.length; i++) if (w.p[w.o[i]]) w.p[w.o[i]].tot += w.m[i];
  for (const f of w.fl) if (w.p[f[1]]) w.p[f[1]].tot += f[2];
  let top = 0;
  for (const id of ids) top = Math.max(top, w.p[id].tot);
  for (const id of ids) {
    const d = w.p[id];
    const bz = ids.length >= 2 && top >= 20 && d.tot * 2 < top ? 1 : 0;
    if (bz && !d.bz) fx(w, 'boost', 0, id);
    d.bz = bz;
  }
}

// Whoever stands alone at the top, or -1.
function leaderOf(w) {
  let top = -1, best = 0, tie = false;
  for (const id of bySeat(w)) {
    const t = w.p[id].tot;
    if (t > best) { best = t; top = id; tie = false; }
    else if (t === best && best > 0) tie = true;
  }
  return tie ? -1 : top;
}

// A player with no colony and no swarm drifts a few seconds, then lands as a
// spore on the weakest wild colony — or, with none left, on the leader's
// weakest, which is theirs from then on. Nobody is out of a round for long.
function respawn(w) {
  for (const id of bySeat(w)) {
    const d = w.p[id];
    if (w.o.includes(id) || w.fl.some((f) => f[1] === id)) { d.ds = 0; continue; }
    d.ds = Math.min(RESPAWN, d.ds + 1);
    if (d.ds < RESPAWN) continue;
    let at = -1;
    for (let i = 0; i < w.o.length; i++) if (w.o[i] === -1 && (at < 0 || w.m[i] < w.m[at])) at = i;
    if (at < 0) {
      const top = leaderOf(w);
      for (let i = 0; i < w.o.length; i++) if (w.o[i] === top && top !== id && (at < 0 || w.m[i] < w.m[at])) at = i;
    }
    if (at < 0) continue;
    const was = w.o[at];
    w.o[at] = id;
    w.m[at] = Math.max(SPORE_POP, Math.min(w.m[at], SPORE_POP * 2));
    w.g[at] = 0;
    d.ds = 0;
    fx(w, 'spore', at, id, was);
  }
}

// Swarms on their way, and what they do when they land: they join a colony of
// their owner's, or fight whatever holds the one they reach, microbe for
// microbe. More than the defenders takes the colony with what is left over.
function fly(w) {
  const still = [];
  for (const f of w.fl) {
    f[5] -= 1;
    if (f[5] > 0) { still.push(f); continue; }
    const id = f[1], n = f[2], b = f[4];
    if (w.o[b] === id) {
      w.m[b] += n;
      fx(w, 'land', b, id, 0, n);
    } else if (n > w.m[b]) {
      const was = w.o[b];
      w.m[b] = n - w.m[b];
      w.o[b] = id;
      w.g[b] = 0;
      if (w.p[id]) w.p[id].tl += 1;
      fx(w, 'take', b, id, was, n);
    } else {
      w.m[b] -= n;
      fx(w, 'hit', b, id, w.o[b], n);
    }
  }
  w.fl = still;
}

function grow(w) {
  for (let i = 0; i < w.o.length; i++) {
    if (w.o[i] === -1) continue;
    const cap = CAP[w.z[i]] * (i === w.nu ? 2 : 1);
    if (w.m[i] >= cap) {
      // A colony past what it can hold starves slowly back to it.
      w.g[i] = 0;
      if (w.m[i] > cap && w.n % 10 === 0) w.m[i] -= 1;
      continue;
    }
    w.g[i] += rateOf(w, i);
    while (w.g[i] >= GROW) { w.g[i] -= GROW; w.m[i] += 1; }
  }
}

function step(w) {
  seatBot(w);
  const many = humansIn(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting dish otherwise leaves at zero. The bot stands up first,
    // so the round's seats close up without it.
    if (many < 2) w.pt = 0;
    else if (!w.pt) w.pt = JOIN_STEPS;
    else if (--w.pt <= 0) { leave(w, BOT_ID); begin(w); }
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === BLOOM) fx(w, 'bloom');
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  if (w.ph === COUNT) respawn(w);
  if (!moving(w)) return;
  botThink(w);
  for (const id of playersIn(w)) if (w.p[id].tk < PURSE) w.p[id].tk += 1;
  fly(w);
  grow(w);
  totals(w);
  respawn(w);
}

// A dish handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG) || !int(raw.fid, 0, 999999)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.q, 0, 999) || !int(d.tk, 0, PURSE) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    if (!int(d.wn, 0, 99999) || !int(d.tot, 0, 9999999) || !int(d.bz, 0, 1) || !int(d.ds, 0, RESPAWN)) return null;
    if (!int(d.tl, 0, 99999)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  const owner = (v) => v === -1 || (Number.isInteger(v) && Object.prototype.hasOwnProperty.call(p, String(v)));
  const K = Array.isArray(raw.x) ? raw.x.length : 0;
  if (K < 3 || K > MAXC) return null;
  const cells = (a, ok) => Array.isArray(a) && a.length === K && a.every(ok);
  if (!cells(raw.x, (v) => int(v, -R, R)) || !cells(raw.y, (v) => int(v, -R, R)) || !cells(raw.z, (v) => int(v, 1, 3))) return null;
  if (!cells(raw.o, owner) || !cells(raw.m, (v) => int(v, 0, 99999)) || !cells(raw.g, (v) => int(v, 0, GROW))) return null;
  if (!int(raw.nu, 0, K - 1)) return null;
  if (!Array.isArray(raw.fl) || raw.fl.length > MAX_FL) return null;
  const fl = [];
  for (const f of raw.fl) {
    if (!Array.isArray(f) || f.length !== 7 || !int(f[0], 0, 999999) || !owner(f[1]) || f[1] === -1) return null;
    if (!int(f[2], 1, 99999) || !int(f[3], 0, K - 1) || !int(f[4], 0, K - 1) || !int(f[6], 1, 9999) || !int(f[5], 0, f[6])) return null;
    fl.push(f.slice());
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_P) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => int(v, -BIG, BIG))) return null;
      res.push(r.slice());
    }
  }
  if (!int(raw.win, -BIG, BIG)) return null;
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, nu: raw.nu, fid: raw.fid, x: raw.x.slice(), y: raw.y.slice(),
    z: raw.z.slice(), o: raw.o.slice(), m: raw.m.slice(), g: raw.g.slice(), fl, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed dish steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, c, a, b, v) {
  if (!live) return;
  fxq.push({ n: w.n, kind, c: c || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b, v: v || 0 });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a dark lab bench in deep teal, a glass dish of green agar, wild
// colonies the colour of pale lichen, and a bright colour for each player that
// is their colonies', their swarms' and their chip's on the scoreboard.
const INK = {
  bgIn: '#123640', bgOut: '#061419', agarIn: '#1f4a3f', agarOut: '#12302b', glass: 'rgba(205,245,255,0.42)',
  text: '#ffffff', muted: '#c4e2dc', dim: '#7fa7a0', gold: '#ffd166', danger: '#ff5a6e',
  panel: 'rgba(7,22,26,0.93)', wild: '#9fb3a2', wildEdge: '#c9d8c6',
};
const SEAT = ['#ff5d8f', '#38e0cf', '#ffd23f', '#8be36b', '#b98cff', '#ff9f43', '#5b9cff', '#f2f2f2'];
const FONT = "700 {px}px ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
const font = (px) => FONT.replace('{px}', String(Math.round(px)));

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${INK.bgOut};touch-action:none;` +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;cursor:default';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

const muteBtn = document.createElement('button');
muteBtn.style.cssText =
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #2f6a66;' +
  `background:#123a3c;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
let VW = 640, VH = 400, sc = 1, ox = 0, oy = 0, TOP = 56, BOT = 26, dpx = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 66 : 58;
  BOT = 26;
  // NOTE_ROOM under the dish keeps the practice note off its bottom colonies.
  const aw = VW - 12, ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  sc = Math.max(0.2, Math.min(aw, ah) / (2 * (R + 6)));
  ox = VW / 2;
  oy = TOP + ah / 2;
}
layout();
window.addEventListener('resize', layout);

// Dish units: the middle is (0, 0) and the rim is R away.
const PX = (u) => ox + u * sc + shakeX;
const PY = (v) => oy + v * sc + shakeY;
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
function fitText(s, x, y, px, colour, most, align, base) {
  ctx.font = font(px);
  const wd = ctx.measureText(s).width;
  text(s, x, y, wd > most ? Math.max(7, (px * most) / wd) : px, colour, align, base);
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
function lighter(hex, k) {
  const c = rgb(hex).map((v) => Math.round(v + (255 - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
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
function hiss(dur, vol, freq, delay, q) {
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
  send() {
    if (!ready('send', 60)) return;
    tone(440, 0.12, 'triangle', 0.07, 1.8);
    hiss(0.08, 0.05, 2400, 0, 1.5);
  },
  pick() { if (ready('pick', 60)) tone(880, 0.05, 'sine', 0.05, 1.2); },
  far() { if (ready('far', 90)) tone(330, 0.06, 'triangle', 0.025, 1.4); },
  deny() { if (ready('deny', 120)) tone(140, 0.12, 'sawtooth', 0.05, 0.8); },
  land() { if (ready('land', 90)) tone(620, 0.08, 'sine', 0.05, 0.9); },
  hit(mine) {
    if (!ready('hit', 80)) return;
    tone(mine ? 200 : 260, 0.12, 'square', mine ? 0.06 : 0.035, 0.6);
    hiss(0.1, mine ? 0.09 : 0.05, 1200, 0, 1);
  },
  take() {
    if (!ready('take', 120)) return;
    [523, 784, 1047].forEach((f, i) => tone(f, 0.14, 'triangle', 0.08, 0, i * 0.05));
    hiss(0.18, 0.06, 1800, 0, 0.8);
  },
  lost() {
    if (!ready('lost', 150)) return;
    tone(330, 0.35, 'sawtooth', 0.07, 0.4);
    hiss(0.3, 0.1, 700, 0, 0.8);
  },
  spore() { if (ready('spore', 200)) [660, 990, 1320].forEach((f, i) => tone(f, 0.18, 'sine', 0.06, 1.1, i * 0.06)); },
  boost() { if (ready('boost', 400)) tone(300, 0.4, 'triangle', 0.06, 2.4); },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(700, 0.12, 'sine', 0.12, 2.0); tone(1400, 0.25, 'sine', 0.08, 1.0, 0.12); } },
  bloom() {
    if (!ready('bloom', 800)) return;
    tone(110, 1.1, 'sawtooth', 0.05, 2.2);
    hiss(1.0, 0.08, 500, 0, 0.5);
  },
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
// fast screen and a slow one see the same spray. Positions are in dish units.
const bits = [];      // { x, y, vx, vy, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0, flash = 0, flashColour = '255,90,110';
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 16 + Math.random() * 22, size, colour });
  }
  if (bits.length > 600) bits.splice(0, bits.length - 600);
}
function pop(x, y, s, colour, px) {
  pops.push({ x, y, s, colour, life: 0, max: 60, px: px || 15 });
  if (pops.length > 40) pops.shift();
}
function ring(x, y, colour, r) {
  rings.push({ x, y, colour, life: 0, max: 24, r });
  if (rings.length > 60) rings.shift();
}
const squash = new Array(MAXC).fill(0);   // how hard a colony was just struck, easing back to rest
const glow = new Array(MAXC).fill(0);     // a colony just taken, glowing in its new colour
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
    for (let i = 0; i < MAXC; i++) { squash[i] *= 0.9; glow[i] *= 0.95; }
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.92;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
let drawFailed = false;
const colourOf = (t, id) => (t && t.p[id] ? SEAT[t.p[id].c] : INK.wild);

function play(e, t) {
  const me = myId();
  const K = t.x.length;
  const at = (c) => (c >= 0 && c < K ? [t.x[c], t.y[c]] : [0, 0]);
  if (e.kind === 'send') {
    const [x, y] = at(e.c);
    spray(x, y, 6, colourOf(t, e.a), 22, 1.4);
    squash[e.c] = Math.max(squash[e.c], 0.4);
    if (e.a !== me) sound.far();
  } else if (e.kind === 'land') {
    const [x, y] = at(e.c);
    ring(x, y, colourOf(t, e.a), 1.3);
    squash[e.c] = Math.max(squash[e.c], 0.35);
    if (e.a === me) sound.land();
  } else if (e.kind === 'hit') {
    const [x, y] = at(e.c);
    spray(x, y, 12, colourOf(t, e.a), 30, 1.6);
    spray(x, y, 6, colourOf(t, e.b), 22, 1.4);
    squash[e.c] = 1;
    const mineHit = e.b === me;
    if (mineHit || e.a === me) {
      pop(x, y - RADI[t.z[e.c]] - 3, '-' + e.v, mineHit ? INK.danger : colourOf(t, e.a), mineHit ? 16 : 13);
      if (mineHit) shake = Math.max(shake, 3);
      sound.hit(mineHit);
    }
  } else if (e.kind === 'take') {
    const [x, y] = at(e.c);
    spray(x, y, 26, colourOf(t, e.a), 40, 1.8);
    ring(x, y, colourOf(t, e.a), 2.4);
    squash[e.c] = 1;
    glow[e.c] = 1;
    if (e.a === me) {
      pop(x, y - RADI[t.z[e.c]] - 3, e.c === t.nu ? 'nucleus!' : 'taken!', colourOf(t, me), 17);
      shake = Math.max(shake, 4);
      sound.take();
    } else if (e.b === me) {
      pop(x, y - RADI[t.z[e.c]] - 3, 'lost!', INK.danger, 17);
      shake = Math.max(shake, 7);
      flash = 1;
      flashColour = '255,90,110';
      sound.lost();
    } else {
      sound.hit(false);
    }
  } else if (e.kind === 'spore') {
    const [x, y] = at(e.c);
    ring(x, y, colourOf(t, e.a), 3);
    spray(x, y, 18, colourOf(t, e.a), 26, 1.2);
    glow[e.c] = 1;
    pop(x, y - RADI[t.z[e.c]] - 3, e.a === me ? 'you drift back!' : 'spore!', colourOf(t, e.a), e.a === me ? 16 : 12);
    if (e.a === me) sound.spore();
    else if (e.b === me) sound.lost();
  } else if (e.kind === 'boost') {
    if (e.a === me) {
      flash = 0.6;
      flashColour = '120,230,200';
      sound.boost();
    }
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'bloom') {
    shake = Math.max(shake, 5);
    flash = 0.8;
    flashColour = '255,209,102';
    sound.bloom();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(e.a === me);
  }
}

// The bench: a teal glow behind the dish, warming toward amber in the bloom.
function drawBack(t, now) {
  flat();
  const bloom = t && t.ph === PLAY && t.pt <= BLOOM;
  const g = ctx.createRadialGradient(VW / 2, oy, 10, VW / 2, oy, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, bloom ? '#3d3a2a' : INK.bgIn);
  g.addColorStop(1, INK.bgOut);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // Faint specks drifting on the page's clock, no part of the game.
  ctx.fillStyle = 'rgba(190,255,235,0.07)';
  for (let i = 0; i < 26; i++) {
    const x = ((i * 97.13 + now * 0.003 * (1 + (i % 3))) % (VW + 40)) - 20;
    const y = (i * 61.7 + Math.sin(now / 2600 + i) * 14) % VH;
    disc(x, y, 1 + (i % 3));
    ctx.fill();
  }
}

// The dish: a glass rim round a disc of agar, with a highlight where the
// light catches the glass.
function drawDish(t, now) {
  flat();
  const cx = PX(0), cy = PY(0), r = R * sc;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  disc(cx + 3, cy + 6, r + 6 * sc);
  ctx.fill();
  const bloom = t && t.ph === PLAY && t.pt <= BLOOM;
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  g.addColorStop(0, bloom ? '#4b5a33' : INK.agarIn);
  g.addColorStop(1, bloom ? '#2c3420' : INK.agarOut);
  ctx.fillStyle = g;
  disc(cx, cy, r);
  ctx.fill();
  // Faint rings in the agar, like the marks a pour leaves.
  ctx.strokeStyle = 'rgba(200,255,230,0.05)';
  ctx.lineWidth = 1;
  for (let k = 1; k <= 4; k++) { disc(cx, cy, (r * k) / 5); ctx.stroke(); }
  ctx.strokeStyle = INK.glass;
  ctx.lineWidth = Math.max(2, 3 * sc);
  disc(cx, cy, r + 2 * sc);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(205,245,255,0.16)';
  ctx.lineWidth = Math.max(1, 1.5 * sc);
  disc(cx, cy, r + 5 * sc);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = Math.max(2, 2.5 * sc);
  ctx.beginPath();
  ctx.arc(cx, cy, r - 3 * sc, Math.PI * 1.08, Math.PI * 1.42);
  ctx.stroke();
}

// A colony: a soft membrane that wobbles a little, darker at its heart, with
// how many microbes it holds written across it.
function drawColony(g, i, now, picked, aimed) {
  const x = PX(g.x[i]), y = PY(g.y[i]);
  const z = g.z[i], owner = g.o[i];
  const cap = CAP[z] * (i === g.nu ? 2 : 1);
  const full = Math.min(1, g.m[i] / cap);
  const r = RADI[z] * sc * (0.86 + 0.26 * full) * (1 + 0.12 * squash[i]);
  const wild = owner === -1 || !g.p[owner];
  const colour = wild ? INK.wild : SEAT[g.p[owner].c];
  if (i === g.nu) {
    // The nucleus keeps a gold halo, whoever holds it.
    ctx.strokeStyle = alpha(INK.gold, 0.45 + 0.2 * Math.sin(now / 300));
    ctx.lineWidth = Math.max(1.5, 1.6 * sc);
    disc(x, y, r + 3.2 * sc);
    ctx.stroke();
  }
  if (glow[i] > 0.05) {
    ctx.fillStyle = alpha(wild ? '#ffffff' : SEAT[g.p[owner].c], 0.35 * glow[i]);
    disc(x, y, r * (1.3 + 0.6 * (1 - glow[i])));
    ctx.fill();
  }
  ctx.beginPath();
  const pts = 20;
  for (let k = 0; k <= pts; k++) {
    const a = (k / pts) * Math.PI * 2;
    const wob = 1 + 0.045 * Math.sin(a * 3 + now / 420 + i * 1.7) + 0.03 * Math.sin(a * 5 - now / 300 + i);
    const px = x + Math.cos(a) * r * wob, py = y + Math.sin(a) * r * wob;
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  const fill = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  fill.addColorStop(0, wild ? alpha(INK.wild, 0.55) : lighter(colour, 0.25));
  fill.addColorStop(1, wild ? alpha(INK.wild, 0.28) : darker(colour, 0.25));
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = wild ? alpha(INK.wildEdge, 0.6) : lighter(colour, 0.45);
  ctx.lineWidth = Math.max(1, (picked ? 2.4 : 1.3) * sc * 0.6);
  if (wild) ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  if (picked || aimed) {
    ctx.strokeStyle = picked ? '#ffffff' : alpha('#ffffff', 0.7);
    ctx.lineWidth = 2;
    disc(x, y, r + 4 + (picked ? 1.5 * Math.sin(now / 160) : 0));
    ctx.stroke();
  }
  const px = Math.max(9, Math.min(22, r * 0.95));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(5,20,20,0.55)';
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeText(String(g.m[i]), x, y + 1);
  ctx.fillStyle = wild ? '#e9f2e6' : '#ffffff';
  ctx.fillText(String(g.m[i]), x, y + 1);
}

// Where a swarm is, between the two tables it is drawn between.
function swarmAt(m, f) {
  const k = m.k;
  let left = f[5];
  if (m.from && m.from !== m.to) {
    const was = m.from.fl.find((e) => e[0] === f[0]);
    left = was ? was[5] + (f[5] - was[5]) * k : f[5] + 1 - k;
  }
  return Math.max(0, Math.min(1, 1 - left / f[6]));
}

function drawSwarms(g, m, now) {
  for (const f of g.fl) {
    const a = f[3], b = f[4];
    if (a >= g.x.length || b >= g.x.length) continue;
    const s = swarmAt(m, f);
    const dx = g.x[b] - g.x[a], dy = g.y[b] - g.y[a];
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const ux = dx / len, uy = dy / len;
    const ra = RADI[g.z[a]], rb = RADI[g.z[b]];
    const along = ra + (len - ra - rb) * s;
    const x = g.x[a] + ux * along, y = g.y[a] + uy * along;
    const colour = colourOf(g, f[1]);
    // A faint trail back toward where it came from.
    ctx.strokeStyle = alpha(colour, 0.22);
    ctx.lineWidth = Math.max(1, 1.2 * sc);
    ctx.beginPath();
    ctx.moveTo(PX(g.x[a] + ux * ra), PY(g.y[a] + uy * ra));
    ctx.lineTo(PX(x), PY(y));
    ctx.stroke();
    const dots = Math.min(14, 2 + Math.ceil(f[2] / 5));
    const spread = Math.min(5, 1.6 + Math.sqrt(f[2]) * 0.35);
    ctx.fillStyle = colour;
    for (let k = 0; k < dots; k++) {
      const seed = f[0] * 7.31 + k * 2.17;
      const ang = seed + now / (380 + (k % 3) * 90);
      const rr = spread * (0.35 + 0.65 * ((k * 0.618) % 1));
      disc(PX(x + Math.cos(ang) * rr), PY(y + Math.sin(ang) * rr), Math.max(1.3, 0.9 * sc));
      ctx.fill();
    }
    if (f[2] >= 4) {
      const px = Math.max(9, Math.min(14, 4 * sc));
      ctx.font = font(px);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(5,20,20,0.6)';
      ctx.strokeText(String(f[2]), PX(x), PY(y - spread - 3));
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(f[2]), PX(x), PY(y - spread - 3));
    }
  }
}

function drawBits() {
  flat();
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = Math.max(1, 2.5 * (1 - k));
    disc(PX(r.x), PY(r.y), sc * RADI[1] * r.r * ease(k));
    ctx.stroke();
  }
  for (const b of bits) {
    ctx.globalAlpha = 1 - b.life / b.max;
    ctx.fillStyle = b.colour;
    const s = Math.max(1.5, b.size * sc);
    ctx.fillRect(PX(b.x) - s / 2, PY(b.y) - s / 2, s, s);
  }
  for (const p of pops) {
    const k = p.life / p.max;
    ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    const s = k < 0.15 ? 0.6 + (0.4 * k) / 0.15 : 1;
    const X = PX(p.x), Y = PY(p.y) - ease(Math.min(1, k * 1.4)) * 20;
    ctx.font = font(p.px * s);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(5,20,20,0.7)';
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

// Scores shown ease toward the table's, so a swarm landing counts up rather
// than jumping.
const shownT = new Map();
function totShown(id, v) {
  let s = shownT.get(id);
  s = s === undefined ? v : s + (v - s) * per60(0.2);
  if (Math.abs(v - s) < 0.5) s = v;
  shownT.set(id, s);
  return Math.round(s);
}

function drawCrown(x, y, size, now) {
  ctx.fillStyle = INK.gold;
  ctx.beginPath();
  const b = y + Math.sin(now / 300) * 0.8;
  ctx.moveTo(x - size, b + size * 0.6);
  ctx.lineTo(x - size, b - size * 0.4);
  ctx.lineTo(x - size * 0.5, b + size * 0.1);
  ctx.lineTo(x, b - size * 0.7);
  ctx.lineTo(x + size * 0.5, b + size * 0.1);
  ctx.lineTo(x + size, b - size * 0.4);
  ctx.lineTo(x + size, b + size * 0.6);
  ctx.closePath();
  ctx.fill();
}

function drawHud(t, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  let status = '';
  if (t.ph === WAIT) status = 'practice';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) status = 'round ' + t.rd + ' · ' + clock(t.pt) + (t.pt <= BLOOM ? ' · BLOOM' : '');
  else status = 'round ' + t.rd + ' · over';
  text('petri', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('petri').width;
  fitText(status, 22 + tw, 22, titlePx, t.ph === PLAY && t.pt <= BLOOM ? INK.gold : INK.text, VW - tw - 90, 'left');
  text(wireNote(), VW - 50, 33, 9, INK.dim, 'right');

  // The scoreboard: a chip each, in the player's colour, with their microbes.
  const ids = bySeat(t);
  const top = t.ph === PLAY || t.ph === WAIT ? leaderOf(t) : -1;
  if (ids.length) {
    const y = narrow ? 54 : 48;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.16)' : 'rgba(4,16,18,0.5)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[d.c]; ctx.lineWidth = 1.5; ctx.stroke(); }
      if (d.bz && moving(t)) {
        // Trailing far behind: the chip's edge breathes, and the colonies grow twice as fast.
        ctx.strokeStyle = alpha('#7ff0c8', 0.5 + 0.5 * Math.abs(Math.sin(now / 260)));
        ctx.lineWidth = 2;
        roundRect(x, y - 13, cw, 22, 11);
        ctx.stroke();
      }
      ctx.fillStyle = SEAT[d.c];
      disc(x + 11, y - 2, 5);
      ctx.fill();
      if (id === top) drawCrown(x + 11, y - 13, 4, now);
      const score = String(totShown(id, d.tot)) + (d.bz && moving(t) ? ' ×2' : '') + (d.wn ? ' ★' + d.wn : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, INK.text, 'right');
      if (cw - 34 - sw > 14) fitText(mine ? 'you' : nickOf(id), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    }
  }
  for (const id of shownT.keys()) if (!t.p[id]) shownT.delete(id);

  const how = coarse
    ? 'drag from your colony to another to send half of it · more than the defenders takes it'
    : 'drag from your colony to another to send half of it · or click, then click the target · arrows + space · M mutes';
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
  const hs = humansIn(t).sort((a, b) => order(a) - order(b));
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
  const cx = VW / 2, cy = oy - big;
  if (t.ph === WAIT) {
    const two = humansIn(t).length >= 2;
    const head = two ? joinHead(t, Math.max(1, Math.ceil(t.pt / HZ))) : 'practice with the bot · a round starts when someone joins';
    const tip = two ? null : 'drag from your colony to a smaller one to take it · then go for the bot\'s';
    const edge = oy + (R + 6) * sc;
    practiceNote(now, VW, head, tip, [[TOP, oy - (R + 6) * sc - 4], [edge + 6, VH - BOT]], Math.min(edge + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(5,20,20,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, cy + big);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    const w = Math.min(VW - 24, 470);
    panel(cx, cy + big * 2.2 + 6, w, 52);
    fitText('send half a colony at a time · more than the defenders takes it', cx, cy + big * 2.2, 15, INK.text, w - 20);
    fitText('the gold nucleus grows twice as fast · most microbes at the horn wins', cx, cy + big * 2.2 + 21, 13, INK.muted, w - 20);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('grow!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= BLOOM && t.pt > BLOOM - 2 * HZ) {
    const k = (BLOOM - t.pt) / (2 * HZ);
    ctx.globalAlpha = 1 - k;
    text('BLOOM', cx, cy, big * 1.6, INK.gold, 'center');
    fitText('every colony grows twice as fast', cx, cy + big, 15, INK.text, VW - 40);
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 24, 340), h = 104 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 4, Math.min(VH - BOT - h / 2 - 4, oy)) + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.win !== -1) { head = t.win === me ? 'your colony rules the dish!' : nickOf(t.win) + ' rules the dish'; hc = colourOf(t, t.win); }
    else head = 'a dead heat in the dish';
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 32, 22, hc, w - 24);
    text('microbes', cx + w / 2 - 22, y0 + 54, 10, INK.dim, 'right');
    text('taken', cx + w / 2 - 90, y0 + 54, 10, INK.dim, 'right');
    rows.forEach(([id, tot, won, took], i) => {
      const y = y0 + 74 + i * 22;
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 22, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (won ? '  ★' + won : ''), cx - w / 2 + 34, y, 14, id === me ? INK.text : INK.muted, w - 170, 'left');
      text(String(took), cx + w / 2 - 90, y, 12, INK.dim, 'right');
      text(String(tot), cx + w / 2 - 22, y, 15, INK.text, 'right');
    });
    fitText('a new dish in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
  // Wiped out: where you are while you drift back.
  if (moving(t) && t.p[me] && !t.o.includes(me) && !t.fl.some((f) => f[1] === me)) {
    const left = Math.max(1, Math.ceil((RESPAWN - t.p[me].ds) / HZ));
    const w = Math.min(VW - 24, 300);
    panel(cx, oy, w, 46);
    fitText('wiped out · you drift back as a spore in ' + left, cx, oy + 5, 15, INK.text, w - 20);
  }
}

function draw(now) {
  const b = agreedAt(now);
  drawBack(b ? b.to : null, now);
  if (!b) {
    drawDish(null, now);
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the dish…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a dish this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  // The dish is drawn as this copy will have it a trip from now, with its own
  // sends in it; the scores and the clock as the room agrees on them.
  const m = mineAt(now);
  const g = m && m.to ? m.to : t;
  const mm = m && m.to ? m : { from: null, to: g, k: 1 };
  const me = myId();
  if (pick >= 0 && (pick >= g.o.length || g.o[pick] !== me)) pick = -1;

  drawDish(t, now);
  flat();
  // The send being lined up: a line from the colony picked to the one aimed
  // at, or to the pointer, with what would go.
  const aim = aimCell();
  if (pick >= 0) {
    const sx = PX(g.x[pick]), sy = PY(g.y[pick]);
    let tx = null, ty = null;
    if (aim >= 0 && aim !== pick) { tx = PX(g.x[aim]); ty = PY(g.y[aim]); }
    else if (drag && drag.moved) { tx = drag.x; ty = drag.y; }
    if (tx !== null) {
      const colour = colourOf(g, me);
      ctx.strokeStyle = alpha(colour, 0.85);
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -now / 40;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
      const half = Math.floor(g.m[pick] / 2);
      if (aim >= 0 && aim !== pick) {
        const wins = g.o[aim] === me || half > g.m[aim];
        const label = (g.o[aim] === me ? '+' : '') + half;
        ctx.font = font(14);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(5,20,20,0.7)';
        const lx = (sx + tx) / 2, ly = (sy + ty) / 2 - 10;
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = wins ? '#ffffff' : '#ffb3bd';
        ctx.fillText(label, lx, ly);
      }
    }
  }
  for (let i = 0; i < g.x.length; i++) drawColony(g, i, now, i === pick, i === aim && i !== pick);
  drawSwarms(g, mm, now);
  if (keyCell >= 0 && keyCell < g.x.length && keyCell !== pick && keyCell !== aim) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    disc(PX(g.x[keyCell]), PY(g.y[keyCell]), RADI[g.z[keyCell]] * sc + 6);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawBits();
  flat();
  if (flash > 0.05) {
    const gr = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    gr.addColorStop(0, `rgba(${flashColour},0)`);
    gr.addColorStop(1, `rgba(${flashColour},${0.3 * flash})`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(t, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: [the number of this send, from, to]. The number goes up
// by one with every send, so a send is heard once however often the hand is
// said again. A send is checked here against the dish as drawn — a colony of
// yours with microbes to spare, and this page's own pace kept — so a tap that
// would be refused says so at once instead of going round the room.
let seq = 0;
let readyAt = 0;
let pick = -1;             // the colony picked to send from, or -1
let hover = -1;            // the colony under the mouse or a finger, or -1
let keyCell = -1;          // the keyboard's cursor, or -1 while the pointer leads
let drag = null;           // { id, from, x, y, moved, sx, sy }

function boardNow() {
  const m = world ? mineAt(performance.now()) : null;
  return m && m.to ? m.to : world;
}

function aimCell() {
  if (drag) return hover;
  if (keyCell >= 0) return keyCell;
  return hover;
}

const mine = (g, c) => !!g && c >= 0 && c < g.o.length && g.o[c] === myId();

function send(a, b) {
  const g = boardNow();
  if (!g || a < 0 || b < 0 || a === b || a >= g.o.length || b >= g.o.length) return;
  const now = performance.now();
  if (!mine(g, a) || g.m[a] < 2 || !moving(g) || now < readyAt) {
    squash[a] = Math.max(squash[a], 0.5);
    sound.deny();
    return;
  }
  readyAt = now + UI_GAP;
  seq = (seq + 1) % 1000;
  sound.send();
  setHand([seq, a, b]);
}

// The colony under a point on the screen: the nearest one whose rim is within
// reach, a little wider for a finger.
function cellAt(clientX, clientY) {
  const g = boardNow();
  if (!g) return -1;
  const r = cv.getBoundingClientRect();
  const x = (clientX - r.left - ox) / sc, y = (clientY - r.top - oy) / sc;
  const pad = (coarse ? 14 : 8) / Math.max(0.5, sc) + 2;
  let best = -1, bd = 1e9;
  for (let i = 0; i < g.x.length; i++) {
    const dx = g.x[i] - x, dy = g.y[i] - y, d = Math.sqrt(dx * dx + dy * dy) - RADI[g.z[i]];
    if (d < pad && d < bd) { bd = d; best = i; }
  }
  return best;
}

function screenXY(e) {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  keyCell = -1;
  const c = cellAt(e.clientX, e.clientY);
  const g = boardNow();
  const [x, y] = screenXY(e);
  hover = c;
  // A drag starts from a colony of yours; a press anywhere else is the second
  // half of a click-and-click send, or lets go of the colony picked.
  drag = { id: e.pointerId, from: mine(g, c) ? c : -1, prev: pick, x, y, sx: x, sy: y, moved: false };
  if (drag.from >= 0) { pick = drag.from; sound.pick(); }
});
cv.addEventListener('pointermove', (e) => {
  const [x, y] = screenXY(e);
  if (drag && e.pointerId === drag.id) {
    drag.x = x;
    drag.y = y;
    if (Math.abs(x - drag.sx) + Math.abs(y - drag.sy) > 8) drag.moved = true;
    hover = cellAt(e.clientX, e.clientY);
  } else if (e.pointerType !== 'touch') {
    hover = cellAt(e.clientX, e.clientY);
    if (hover >= 0) keyCell = -1;
  }
});
function lift(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  const g = boardNow();
  const u = e.type === 'pointercancel' ? -1 : cellAt(e.clientX, e.clientY);
  if (e.pointerType === 'touch') hover = -1;
  if (u < 0 && !d.moved) { pick = -1; return; }
  if (d.from >= 0) {
    // Dragged from a colony of yours onto another: that is a send. Lifted on
    // the colony it began on, it stays picked for a click on the target.
    if (u >= 0 && u !== d.from) send(d.from, u);
    else if (u === d.from && !d.moved && d.prev === d.from) pick = -1;
    return;
  }
  if (u >= 0 && d.prev >= 0 && mine(g, d.prev) && u !== d.prev) send(d.prev, u);
  else pick = -1;
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
cv.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !drag) hover = -1; });

// The keyboard's cursor hops to the nearest colony the way an arrow points.
function hop(dx, dy) {
  const g = boardNow();
  if (!g) return;
  const from = keyCell >= 0 && keyCell < g.x.length ? keyCell : -1;
  if (from < 0) {
    let best = -1;
    for (let i = 0; i < g.x.length; i++) if (mine(g, i) && (best < 0 || g.m[i] > g.m[best])) best = i;
    keyCell = best >= 0 ? best : g.nu;
    return;
  }
  let best = -1, bs = 1e9;
  for (let i = 0; i < g.x.length; i++) {
    if (i === from) continue;
    const vx = g.x[i] - g.x[from], vy = g.y[i] - g.y[from];
    const ahead = vx * dx + vy * dy;
    if (ahead <= 0) continue;
    const side = Math.abs(vx * dy - vy * dx);
    const s = ahead + side * 2;
    if (s < bs) { bs = s; best = i; }
  }
  if (best >= 0) keyCell = best;
}

// Keys are read by where they sit, not what they type, so every layout plays.
const MOVES = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  const mv = MOVES[e.code];
  if (mv) {
    e.preventDefault();
    coarse = false;
    hover = -1;
    hop(mv[0], mv[1]);
  } else if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    const g = boardNow();
    if (keyCell < 0) { hop(0, 0); return; }
    if (pick < 0 || keyCell === pick) {
      if (keyCell === pick) pick = -1;
      else if (mine(g, keyCell)) { pick = keyCell; sound.pick(); }
      else sound.deny();
    } else {
      send(pick, keyCell);
    }
  } else if (e.code === 'Escape') {
    pick = -1;
  }
});
addEventListener('blur', () => { drag = null; hover = -1; });

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. The first hand sends nothing: it is how
// a player arrives at the dish.
function start() {
  setHand([seq, -1, -1]);
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
