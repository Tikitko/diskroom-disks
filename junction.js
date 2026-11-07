/**
 * @disk     junction
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Trains you never drive. Every train runs on its own, and all you do is throw switches, any switch on the map, yours or a rival's route. Pick up sacks along the line, bring them home to your station, and send rivals head-on into each other.
 * @tags     game, party, realtime, trains, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/junction.png
 */
// junction.js — a rail yard where nobody drives and everybody throws the
// switches, and the room's order is the referee.
//
// Every copy holds the whole yard — which tracks are laid, which way every
// switch points, every sack waiting on the line, every train and how far along
// its track it has run — and changes it only on what comes back round the
// room, so every copy applies the same hands in the same order and holds the
// same yard. Nobody sends where their train is, what it picked up or what it
// hit: a hand is a switch somebody threw and whether they hold the brake, and
// everything else is the same arithmetic on the same whole numbers on every
// machine. A page with a console open can throw switches as fast as its purse
// allows and no faster, and brake its own train however it likes.
//
// While a player is alone in the yard, a bot plays with them. It is part of
// the yard like any player, and its switches are a function of the yard alone,
// so it plays the same on every copy and says nothing over the wire. When a
// second player arrives, practice runs on for three seconds under a note that
// says so, and the bot leaves before the round is laid out: it never takes
// part in one.
//
// Your own train and the switches you throw do not wait for the trip: they are
// drawn from the agreed yard played forward by the trip, with your hand
// already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole units of track and whole steps only, and use
// nothing but `+ - *`, comparisons, `Math.floor`, `Math.min`, `Math.max`,
// `Math.abs` and `Math.imul`, which the language fixes to the last bit.
// Anything rounder appears only in the drawing, which is nobody's business but
// the screen's.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the yard a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own train a trip ahead, with your hand in it

// The yard is a lattice of stops, NX by NY, and a track may run between any two
// neighbours. A train runs LEN units along a track from one stop to the next.
const NX = 9, NY = 7, NN = NX * NY;
const HE = (NX - 1) * NY;      // tracks running across; the rest run up and down
const NE = HE + NX * (NY - 1);
const LEN = 30;
const MID = LEN / 2;           // where on a track its sack waits
const RUN = 2;                 // units a train runs a step
const FAST = 3;                // and for whoever trails the leader far enough
const SLOW = 1;                // and with the brake held
const BEHIND = 4;              // points behind the leader at which a train is quicker
const GAP = 16;                // units apart, along the rails, at which two trains collide
const CRASH = 50;              // steps a wrecked train lies on its side
const GUARD = 40;              // steps a train fresh out of its station passes through others
const CAP = 4;                 // sacks a train carries
const GOLD = 3;                // what a gold sack is worth; a plain one is worth 1
const GOLD_ODDS = 0.15;
const GOLD_RUSH = 0.3;
const COST = 12;               // purse units a switch costs; the purse refills one a step
const TK_MAX = 3 * COST;       // three throws saved up at most
const LOCK = 8;                // steps a thrown switch stands before anybody may throw it again
const SPAWN_EVERY = 30;        // steps between new sacks, while there are too few
const SPAWN_RUSH = 18;
const K_MAX = 24;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;
const SCORE_MAX = 99999;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 6 * HZ;
const RUSH_AT = 25 * HZ;       // steps left in a round when every sack brought home counts double

// A way out of a stop: up, right, down, left — clockwise, so the next way
// round is one more.
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

const at = (x, y) => y * NX + x;
const nxOf = (i) => i % NX;
const nyOf = (i) => (i - (i % NX)) / NX;

// For every stop and way out of it: the stop it leads to and the track that
// runs there, or -1 off the edge of the lattice. And for every track, the two
// stops it joins, the lower first.
const NB = new Array(NN * 4).fill(-1);
const EDGE = new Array(NN * 4).fill(-1);
const EA = new Array(NE).fill(0), EB = new Array(NE).fill(0);
for (let y = 0; y < NY; y++) {
  for (let x = 0; x < NX; x++) {
    const i = at(x, y);
    for (let d = 0; d < 4; d++) {
      const a = x + DX[d], b = y + DY[d];
      if (a < 0 || b < 0 || a >= NX || b >= NY) continue;
      NB[i * 4 + d] = at(a, b);
      const lx = Math.min(x, a), ly = Math.min(y, b);
      const e = DY[d] === 0 ? ly * (NX - 1) + lx : HE + ly * NX + lx;
      EDGE[i * 4 + d] = e;
      EA[e] = Math.min(i, at(a, b));
      EB[e] = Math.max(i, at(a, b));
    }
  }
}
// Every track's twin, turned half round the middle of the yard: the yard is
// laid in pairs, so no station is better placed than its own twin.
const TWIN = new Array(NE).fill(0);
for (let e = 0; e < NE; e++) {
  const a = NN - 1 - EA[e], b = NN - 1 - EB[e];
  for (let d = 0; d < 4; d++) if (NB[a * 4 + d] === b) TWIN[e] = EDGE[a * 4 + d];
}

// The stations, one a seat, in the order seats are handed out: two players
// stand on opposite sides, and every station has its twin across the middle.
const DEPOT = [[0, 3], [8, 3], [4, 0], [4, 6], [2, 0], [6, 6], [6, 0], [2, 6]].map(([x, y]) => at(x, y));
const DEPOT_SET = new Set(DEPOT);

const has = (w, i, d) => EDGE[i * 4 + d] >= 0 && w.on[EDGE[i * 4 + d]] === 1;
function degOf(w, i) {
  let n = 0;
  for (let d = 0; d < 4; d++) if (has(w, i, d)) n += 1;
  return n;
}
const isSwitch = (w, i) => degOf(w, i) >= 3;
function dirTo(i, j) {
  for (let d = 0; d < 4; d++) if (NB[i * 4 + d] === j) return d;
  return -1;
}

// Whether every stop can be reached from every other along the tracks laid.
function joined(on) {
  const seen = new Array(NN).fill(0);
  seen[0] = 1;
  let edge = [0], count = 1;
  while (edge.length) {
    const next = [];
    for (const i of edge) {
      for (let d = 0; d < 4; d++) {
        const e = EDGE[i * 4 + d];
        if (e < 0 || !on[e]) continue;
        const j = NB[i * 4 + d];
        if (seen[j]) continue;
        seen[j] = 1;
        count += 1;
        next.push(j);
      }
    }
    edge = next;
  }
  return count === NN;
}

// The yard. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   on: each track: 1 laid, 0 not
//   sw: each stop: the way its switch points, or -1 where there is no switch
//   lk: steps until a switch may be thrown again; lb: the colour that threw it
//   k:  the sacks waiting, as [track, worth]; sp: steps until the next
//   res: the last round's [id, won, rounds won, points, sacks] rows; win: its winner
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, on: [], sw: [], lk: [], lb: [], k: [], sp: SPAWN_EVERY, p: {}, res: null, win: -1,
  };
  lay(w);
  return w;
}

// A new yard: the whole lattice, with tracks taken up in pairs of twins until
// about a third are gone, never one that leaves a stop with fewer than two
// ways out — so a train never meets a dead end — or cuts the yard in two.
function lay(w) {
  const on = new Array(NE).fill(1);
  const order = [];
  for (let e = 0; e < NE; e++) order.push(e);
  for (let i = NE - 1; i > 0; i--) {
    const j = Math.floor(draw01(w) * (i + 1));
    const v = order[i]; order[i] = order[j]; order[j] = v;
  }
  const want = 22 + 2 * Math.floor(draw01(w) * 4);
  let gone = 0;
  const two = (i) => {
    let n = 0;
    for (let d = 0; d < 4; d++) if (EDGE[i * 4 + d] >= 0 && on[EDGE[i * 4 + d]]) n += 1;
    return n >= 2;
  };
  for (const e of order) {
    if (gone >= want) break;
    const t = TWIN[e];
    if (!on[e] || !on[t]) continue;
    on[e] = on[t] = 0;
    if (two(EA[e]) && two(EB[e]) && two(EA[t]) && two(EB[t]) && joined(on)) gone += 2;
    else on[e] = on[t] = 1;
  }
  w.on = on;
  w.sw = new Array(NN).fill(-1);
  w.lk = new Array(NN).fill(0);
  w.lb = new Array(NN).fill(-1);
  for (let i = 0; i < NN; i++) {
    if (!isSwitch(w, i)) continue;
    const ways = [];
    for (let d = 0; d < 4; d++) if (has(w, i, d)) ways.push(d);
    w.sw[i] = ways[Math.floor(draw01(w) * ways.length)];
  }
  w.k = [];
  w.sp = 6;
}

const FIELDS = ['c', 's', 'a', 'b', 'z', 'pr', 'ld', 'sc', 'sh', 'wn', 'tk', 'q', 'br', 'cr', 'gd', 'hs', 'hc', 'bw'];
//   c: colour; s: seat, which is also the station; a, b: the stops of the
//   track the train runs on, from and to; z: the stop before a, for the
//   wagons trailing behind; pr: units run along it; ld: the worth of each sack
//   carried; sc: points this round; sh: sacks brought home this round; wn:
//   rounds won; tk: the purse switches are paid from; q: the number of the
//   last throw heard; br: 1 while the brake is held; cr: steps the train lies
//   wrecked; gd: steps it passes through others; bw: the bot's pause; hs, hc:
//   hands this step.
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

// The way a train leaves a stop it arrived at from `from`: the only way on, if
// there is one; the switch's way, unless that is the way it came; straight on
// past a switch it came up against; and otherwise the next way round.
function exitOf(w, i, from) {
  let n = 0, only = -1;
  for (let d = 0; d < 4; d++) if (d !== from && has(w, i, d)) { n += 1; only = d; }
  if (n === 0) return from;
  if (n === 1) return only;
  const s = w.sw[i];
  if (s >= 0 && s !== from && has(w, i, s)) return s;
  const st = (from + 2) % 4;
  if (has(w, i, st)) return st;
  for (let k = 1; k < 4; k++) if (has(w, i, (from + k) % 4)) return (from + k) % 4;
  return from;
}

// A train put on the line at its own station, heading out the way the
// station's switch points or the first way out, passing through others a while.
function toStation(w, d) {
  const i = DEPOT[d.s];
  let e = w.sw[i];
  if (e < 0 || !has(w, i, e)) for (let k = 0; k < 4; k++) if (has(w, i, k)) { e = k; break; }
  d.a = d.z = i;
  d.b = NB[i * 4 + e];
  d.pr = 0;
  d.ld = [];
  d.cr = 0;
  d.gd = GUARD;
}

function newPlayer(w, input) {
  const d = player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), a: 0, b: 1, z: 0, pr: 0, ld: [], sc: 0, sh: 0, wn: 0, tk: TK_MAX,
    q: input[0], br: input[3], cr: 0, gd: 0, hs: w.n, hc: 0, bw: 0,
  });
  toStation(w, d);
  return d;
}

// A switch thrown, by a player or the bot alike: only a stop with a switch,
// only a way a track runs, only one nobody threw a moment ago, and only out of
// a purse that holds enough. Way 4 is the next way round from where it points.
function flip(w, id, i, dir) {
  const d = w.p[id];
  if (!d || (w.ph !== WAIT && w.ph !== PLAY)) return;
  if (i < 0 || i >= NN || !isSwitch(w, i) || w.lk[i] > 0 || d.tk < COST) return;
  let to = dir;
  if (dir === 4) {
    to = -1;
    for (let k = 1; k < 4 && to < 0; k++) if (has(w, i, (w.sw[i] + k) % 4)) to = (w.sw[i] + k) % 4;
  }
  if (to < 0 || to > 3 || !has(w, i, to) || to === w.sw[i]) return;
  d.tk -= COST;
  w.sw[i] = to;
  w.lk[i] = LOCK;
  w.lb[i] = d.c;
  fx(w, 'flip', i, 0, id);
}

// A hand, at its place in the room's order: the number of the last switch
// thrown, which stop and which way, and the brake. A switch is thrown only
// when its number changes, so a hand said again throws nothing twice. Being
// heard is how a player arrives: on the line at their own station.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    w.p[id] = newPlayer(w, input);
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  d.br = input[3];
  if (input[0] === d.q) return;
  d.q = input[0];
  if (input[1] >= 0) flip(w, id, input[1], input[2]);
}

// A hand off the wire, made safe: four integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [q, i, dir, br] = raw;
  if (!Number.isInteger(q) || q < 0 || q > 999) return null;
  if (!Number.isInteger(i) || i < -1 || i >= NN) return null;
  if (!Number.isInteger(dir) || dir < 0 || dir > 4) return null;
  if (br !== 0 && br !== 1) return null;
  return [q, i, dir, br];
}

function leave(w, id) {
  delete w.p[id];
}

// Where a train stands, in units: along its track from the stop it left.
function posOf(d) {
  const dir = dirTo(d.a, d.b);
  return [nxOf(d.a) * LEN + DX[dir] * d.pr, nyOf(d.a) * LEN + DY[dir] * d.pr];
}
const trackOf = (d) => EDGE[d.a * 4 + dirTo(d.a, d.b)];

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 5;           // steps between the bot's decisions
const BOT_IDLE = 0.08;         // how often it lets a decision go by and dawdles
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the yard waits for a round, and goes the moment a round
// is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) w.p[BOT_ID] = newPlayer(w, [0, -1, 0, 0]);
  else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// Stops between every stop and the nearest of `goals`, along the tracks laid.
function hopsTo(w, goals) {
  const dist = new Array(NN).fill(-1);
  let edge = [];
  for (const g of goals) if (dist[g] < 0) { dist[g] = 0; edge.push(g); }
  while (edge.length) {
    const next = [];
    for (const i of edge) {
      for (let d = 0; d < 4; d++) {
        if (!has(w, i, d)) continue;
        const j = NB[i * 4 + d];
        if (dist[j] >= 0) continue;
        dist[j] = dist[i] + 1;
        next.push(j);
      }
    }
    edge = next;
  }
  return dist;
}

// The bot heads for the nearest sack, or home once it carries enough, and sets
// the switch ahead of it that way when it is well along its track. It brakes
// for a train close ahead, and leaves everybody else's switches alone.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || d.cr > 0) return;
  if (d.bw > 0) { d.bw -= 1; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 8 + Math.floor(draw01(w) * 16); return; }
  const [x, y] = posOf(d);
  const way = dirTo(d.a, d.b);
  d.br = 0;
  for (const id of playersIn(w)) {
    const o = w.p[id];
    if (id === BOT_ID || o.cr > 0 || d.gd > 0 || o.gd > 0) continue;
    const [ox, oy] = posOf(o);
    if (Math.abs(ox - x) + Math.abs(oy - y) < 2 * GAP && (ox - x) * DX[way] + (oy - y) * DY[way] > 0) d.br = 1;
  }
  const home = d.ld.length >= 3 || (d.ld.length >= 1 && (rushOn(w) || !w.k.length));
  const goals = home ? [DEPOT[d.s]] : w.k.flatMap(([e]) => [EA[e], EB[e]]);
  if (!goals.length) return;
  const i = d.b;
  if (!isSwitch(w, i) || d.pr < LEN / 4) return;
  const dist = hopsTo(w, goals);
  const from = dirTo(i, d.a);
  const sacked = new Set(w.k.map(([e]) => e));
  let best = -1, low = BIG;
  for (let k = 0; k < 4; k++) {
    if (k === from || !has(w, i, k)) continue;
    const j = NB[i * 4 + k];
    let v = dist[j] < 0 ? 999 : dist[j] + 1;
    if (!home && sacked.has(EDGE[i * 4 + k])) v = 0;
    if (home && j === DEPOT[d.s]) v = 0;
    if (v < low) { low = v; best = k; }
  }
  if (best >= 0 && exitOf(w, i, from) !== best) flip(w, BOT_ID, i, best);
}

// ── a step ─────────────────────────────────────────────────────────────────
function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  lay(w);
  for (const id of bySeat(w)) {
    const d = w.p[id];
    toStation(w, d);
    d.sc = d.sh = 0;
  }
}

// A round: a new yard, the seats closed up in order so the stations in use
// are the first ones, every train at its own station with nothing aboard.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  lay(w);
  const ids = bySeat(w);
  ids.forEach((id, i) => {
    const d = w.p[id];
    d.s = i;
    toStation(w, d);
    d.sc = d.sh = d.bw = 0;
    d.tk = TK_MAX;
  });
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
  const res = ids.map((id) => [id, id === w.win ? 1 : 0, w.p[id].wn, w.p[id].sc, w.p[id].sh]);
  res.sort((a, b) => b[3] - a[3] || b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, w.win);
}

function step(w) {
  seatBot(w);
  const many = humans(w).length;
  if (w.ph === WAIT) {
    // A second player ends practice, three seconds on: the count runs in pt,
    // which a waiting yard otherwise leaves at zero. The bot goes first, so
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
      if (w.pt === RUSH_AT) fx(w, 'rush');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nothing runs while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) return;
  yard(w);
}

const rushOn = (w) => w.ph === PLAY && w.pt <= RUSH_AT;

// Whoever has the most points, alone, and any at all: the one with the crown.
function leaderOf(w) {
  let top = 0, who = -1;
  for (const id of bySeat(w)) {
    const sc = w.p[id].sc;
    if (sc > top) { top = sc; who = id; } else if (sc === top) who = -1;
  }
  return who;
}
function topOf(w) {
  let top = 0;
  for (const id of playersIn(w)) top = Math.max(top, w.p[id].sc);
  return top;
}
const trails = (w, d, top) => w.ph === PLAY && top - d.sc >= BEHIND;

function yard(w) {
  botThink(w);
  for (let i = 0; i < NN; i++) if (w.lk[i] > 0) w.lk[i] -= 1;
  const ids = bySeat(w);
  const top = topOf(w);
  for (const id of ids) {
    const d = w.p[id];
    const quick = trails(w, d, top);
    d.tk = Math.min(TK_MAX, d.tk + (quick ? 2 : 1));
    if (d.cr > 0) {
      d.cr -= 1;
      if (d.cr === 0) { toStation(w, d); fx(w, 'out', d.a, 0, id); }
      continue;
    }
    if (d.gd > 0) d.gd -= 1;
    run(w, id, d, d.br ? SLOW : quick ? FAST : RUN);
  }
  // Two trains on the line close enough along the rails both come off them,
  // and whatever they carried spills onto the tracks round the wreck.
  const on = ids.filter((id) => w.p[id].cr === 0 && w.p[id].gd === 0);
  const hit = new Set();
  for (let i = 0; i < on.length; i++) {
    const p = posOf(w.p[on[i]]);
    for (let j = i + 1; j < on.length; j++) {
      const q = posOf(w.p[on[j]]);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) >= GAP) continue;
      if (!hit.has(on[i]) && !hit.has(on[j])) fx(w, 'crash', (p[0] + q[0]) >> 1, (p[1] + q[1]) >> 1, on[i], on[j]);
      hit.add(on[i]);
      hit.add(on[j]);
    }
  }
  for (const id of ids) if (hit.has(id)) wreck(w, w.p[id]);
  if (w.sp > 0) w.sp -= 1;
  const want = Math.min(K_MAX, 3 + 2 * ids.length + (rushOn(w) ? 3 : 0));
  if (w.sp <= 0 && w.k.length < want) {
    spawn(w);
    w.sp = rushOn(w) ? SPAWN_RUSH : SPAWN_EVERY;
  }
}

// A train runs on: past the middle of its track it takes the sack waiting
// there if it has room, and at the end of it it arrives at a stop, unloads if
// the stop is its own station, and takes the way out the stop gives it.
function run(w, id, d, v) {
  const was = d.pr;
  d.pr += v;
  if (was < MID && d.pr >= MID) take(w, id, d);
  if (d.pr < LEN) return;
  d.pr -= LEN;
  const i = d.b;
  if (i === DEPOT[d.s]) unload(w, id, d, i);
  const e = exitOf(w, i, dirTo(i, d.a));
  d.z = d.a;
  d.a = i;
  d.b = NB[i * 4 + e];
}

function take(w, id, d) {
  const e = trackOf(d);
  const n = w.k.findIndex((k) => k[0] === e);
  if (n < 0) return;
  if (d.ld.length >= CAP) { fx(w, 'full', e, 0, id); return; }
  const v = w.k[n][1];
  w.k.splice(n, 1);
  d.ld.push(v);
  fx(w, 'take', e, 0, id, v);
}

function unload(w, id, d, i) {
  if (!d.ld.length) return;
  let v = 0;
  for (const s of d.ld) v += s;
  v *= rushOn(w) ? 2 : 1;
  d.sc = Math.min(SCORE_MAX, d.sc + v);
  d.sh = Math.min(SCORE_MAX, d.sh + d.ld.length);
  d.ld = [];
  fx(w, 'home', i, 0, id, v);
}

// A wrecked train lies where it stands a while, and every sack it carried
// lands on a free track near it, for anybody to pick up.
function wreck(w, d) {
  d.cr = CRASH;
  d.br = 0;
  const near = new Set();
  for (const i of [d.a, d.b]) {
    for (let k = 0; k < 4; k++) {
      if (!has(w, i, k)) continue;
      near.add(EDGE[i * 4 + k]);
      const j = NB[i * 4 + k];
      for (let m = 0; m < 4; m++) if (has(w, j, m)) near.add(EDGE[j * 4 + m]);
    }
  }
  const mine = trackOf(d);
  for (const v of d.ld) {
    if (w.k.length >= K_MAX) break;
    const free = [...near].filter((e) => e !== mine && !w.k.some((k) => k[0] === e)).sort((a, b) => a - b);
    if (!free.length) break;
    const e = free[Math.floor(draw01(w) * free.length)];
    w.k.push([e, v]);
    fx(w, 'spill', e, 0, v);
  }
  d.ld = [];
}

// A new sack on a laid track nobody runs on, away from every station in use.
function spawn(w) {
  const used = new Set(playersIn(w).map((id) => DEPOT[w.p[id].s]));
  const busy = new Set(playersIn(w).map((id) => trackOf(w.p[id])));
  const open = [];
  for (let e = 0; e < NE; e++) {
    if (!w.on[e] || busy.has(e) || used.has(EA[e]) || used.has(EB[e])) continue;
    if (w.k.some((k) => k[0] === e)) continue;
    open.push(e);
  }
  if (!open.length) return;
  const e = open[Math.floor(draw01(w) * open.length)];
  const v = draw01(w) < (rushOn(w) ? GOLD_RUSH : GOLD_ODDS) ? GOLD : 1;
  w.k.push([e, v]);
  fx(w, 'spawn', e, 0, v);
}

// A yard handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!Array.isArray(raw.on) || raw.on.length !== NE || !raw.on.every((v) => v === 0 || v === 1)) return null;
  const on = raw.on.slice();
  for (let i = 0; i < NN; i++) {
    let n = 0;
    for (let d = 0; d < 4; d++) if (EDGE[i * 4 + d] >= 0 && on[EDGE[i * 4 + d]]) n += 1;
    if (n < 2) return null;
  }
  if (!joined(on)) return null;
  const w = { on };
  for (const f of ['sw', 'lk', 'lb']) if (!Array.isArray(raw[f]) || raw[f].length !== NN) return null;
  for (let i = 0; i < NN; i++) {
    const s = raw.sw[i];
    if (isSwitch(w, i) ? !(int(s, 0, 3) && has(w, i, s)) : s !== -1) return null;
    if (!int(raw.lk[i], 0, LOCK) || !int(raw.lb[i], -1, MAX_P - 1)) return null;
  }
  if (!int(raw.sp, 0, SPAWN_EVERY) || !Array.isArray(raw.k) || raw.k.length > K_MAX) return null;
  const k = [], ks = new Set();
  for (const e of raw.k) {
    if (!Array.isArray(e) || e.length !== 2 || !int(e[0], 0, NE - 1) || !on[e[0]] || ks.has(e[0])) return null;
    if (e[1] !== 1 && e[1] !== GOLD) return null;
    ks.add(e[0]);
    k.push([e[0], e[1]]);
  }
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  const linked = (i, j) => int(i, 0, NN - 1) && int(j, 0, NN - 1) && dirTo(i, j) >= 0 && has(w, i, dirTo(i, j));
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!linked(d.a, d.b) || !(d.z === d.a || linked(d.z, d.a)) || !int(d.pr, 0, LEN - 1)) return null;
    if (!Array.isArray(d.ld) || d.ld.length > CAP || !d.ld.every((v) => v === 1 || v === GOLD)) return null;
    if (!int(d.sc, 0, SCORE_MAX) || !int(d.sh, 0, SCORE_MAX) || !int(d.wn, 0, 99999) || !int(d.tk, 0, TK_MAX)) return null;
    if (!int(d.q, 0, 999) || !int(d.br, 0, 1) || !int(d.cr, 0, CRASH) || !int(d.gd, 0, GUARD)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG) || !int(d.bw, 0, 99)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(Object.assign({}, d, { ld: d.ld.slice() }));
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
  return {
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, on, sw: raw.sw.slice(), lk: raw.lk.slice(), lb: raw.lb.slice(),
    k, sp: raw.sp, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed yard steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a country rail yard at night. A deep green meadow, grey
// ballast with dark sleepers and pale steel rails, brass switch levers, sacks
// of burlap and of gold, and a bright colour for each player that is their
// train's, their station's and their chip's.
const INK = {
  page: '#0e1b1a', glow: '#18302b', meadow: '#1d3b2f', meadowB: '#1a3529', edge: '#2c5241',
  ballast: '#3d4441', ballastHi: '#4b534f', tie: '#5a3f2c', rail: '#c8d2d6', railDark: '#7c878c',
  plate: '#262d33', plateRim: '#4a555e', lever: '#f2e6c4', bush: '#24503a', bushHi: '#2f6648',
  sack: '#c9a46a', sackDark: '#8b6a3a', sackHi: '#e6c993', gold: '#ffcf4a', goldHi: '#fff0a8', goldDark: '#b8860b',
  smoke: '#b9c3c4', lamp: '#ffe9a3',
  text: '#ffffff', muted: '#c4d6cf', dim: '#7c978d', danger: '#ff5a5a', warn: '#ffb03b',
  panel: 'rgba(10,20,18,0.93)',
};
const SEAT = ['#ff6b6b', '#4dc3ff', '#ffd23f', '#7be35a', '#c58bff', '#ff9a3c', '#2de0c0', '#ff7ac8'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #3b5a4f;' +
  `background:#183029;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
// The bottom row of the yard holds stations, so a narrow frame keeps
// NOTE_ROOM free under it for the practice note and, in a round, for the line
// about your own train.
const NOTE_ROOM = 60;
const SIDE = 160;              // the least a column beside the yard needs for the scoreboard
const FW = NX, FH = NY;        // the yard on screen, in cells: a stop in the middle of each
let VW = 640, VH = 400, cs = 24, ox = 0, oy = 0, TOP = 58, BOT = 26, dpx = 1;
let wide = false, colW = 0, fieldTop = 0, fieldBot = 0;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 64 : 58;
  BOT = 26;
  fit();
}

// The whole yard is always on screen, as large as the frame lets it be. A
// frame wider than the yard puts the status, the scoreboard, your train's line
// and the line of controls in the columns either side of it, so the yard takes
// the whole height. A narrower one stacks them in strips above and below it.
// Whichever of the two draws the yard bigger is the one used.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  const tall = Math.min((VW - 12) / FW, ah / FH), side = Math.min((VH - 12) / FH, (VW - 2 * SIDE) / FW);
  wide = side > tall;
  cs = Math.max(4, wide ? side : tall);
  ox = (VW - cs * FW) / 2;
  oy = wide ? (VH - cs * FH) / 2 : TOP + (ah - cs * FH) / 2;
  colW = wide ? ox : 0;
  fieldTop = oy;
  fieldBot = oy + cs * FH;
}
layout();
window.addEventListener('resize', layout);

// Screen pixels of a point in the yard, in cells from its top left corner;
// a stop stands in the middle of its cell, and a unit of track is 1/LEN of one.
const PX = (u) => ox + u * cs + shakeX;
const PY = (v) => oy + v * cs + shakeY;
const stopXY = (i) => [nxOf(i) + 0.5, nyOf(i) + 0.5];
const unitXY = (x, y) => [x / LEN + 0.5, y / LEN + 0.5];
const trackXY = (e) => [(nxOf(EA[e]) + nxOf(EB[e])) / 2 + 0.5, (nyOf(EA[e]) + nyOf(EB[e])) / 2 + 0.5];
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

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
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.8), actx.sampleRate);
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
  // A lever thrown: a hard clack of steel, a little brighter for your own.
  flip(mine) {
    if (!ready('flip', 60)) return;
    puff(0.05, mine ? 0.14 : 0.06, 2400, 0, 3);
    tone(mine ? 520 : 380, 0.05, 'square', mine ? 0.05 : 0.025, 0.6);
  },
  nope() { if (ready('nope', 150)) tone(180, 0.09, 'square', 0.04, 0.8); },
  take(mine, gold) {
    if (!ready('take', 70)) return;
    if (mine) { puff(0.08, 0.08, 300, 0, 1.5); tone(gold ? 880 : 620, 0.1, 'triangle', 0.07, 1.3); }
    else tone(420, 0.06, 'triangle', 0.025, 1.2);
  },
  full() { if (ready('full', 400)) tone(150, 0.18, 'sawtooth', 0.035, 0.9); },
  home(mine, v) {
    if (!ready('home', 80)) return;
    if (mine) {
      [523, 659, 784].concat(v > 3 ? [1047, 1319] : []).forEach((f, i) => tone(f, 0.14, 'triangle', 0.08, 0, i * 0.06));
      tone(1568, 0.5, 'sine', 0.04, 1, 0.18);
    } else tone(392, 0.15, 'triangle', 0.04, 1.3);
  },
  crash(mine) {
    if (!ready('crash', 120)) return;
    puff(0.6, mine ? 0.22 : 0.1, 260, 0, 0.7);
    puff(0.3, mine ? 0.12 : 0.05, 1600, 0.02, 1);
    tone(mine ? 110 : 90, 0.45, 'sawtooth', mine ? 0.07 : 0.035, 0.4);
  },
  // A whistle of two pipes as a train leaves its station.
  toot() { if (ready('toot', 400)) { tone(587, 0.32, 'sine', 0.05, 1.01); tone(740, 0.32, 'sine', 0.04, 1.01); } },
  spawn() { if (ready('spawn', 250)) tone(1200, 0.05, 'sine', 0.025, 1.4); },
  rush() { if (ready('rush', 600)) [988, 784, 988, 784, 1175].forEach((f, i) => tone(f, 0.16, 'square', 0.04, 1, i * 0.12)); },
  beep(hi) { if (ready('beep', 200)) tone(hi ? 880 : 620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(587, 0.45, 'sine', 0.09, 1.01); tone(740, 0.45, 'sine', 0.08, 1.01); tone(880, 0.45, 'sine', 0.05, 1.01); } },
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
// fast screen and a slow one see the same sparks. Positions are in cells.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, kind }: kind 1 falls, 2 is smoke
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, kind) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 18 + Math.random() * 22, size, colour, kind: kind || 0 });
  }
  if (bits.length > 700) bits.splice(0, bits.length - 700);
}
function smoke(x, y, size) {
  bits.push({ x, y, vx: (Math.random() - 0.5) * 0.3, vy: -0.25 - Math.random() * 0.3, life: 0, max: 50 + Math.random() * 30, size, colour: INK.smoke, kind: 2 });
}
function pop(x, y, s, colour, px) { pops.push({ x, y, s, colour, life: 0, max: 55, px: px || 15 }); }
function ring(x, y, colour, r) { rings.push({ x, y, colour, life: 0, max: 24, r }); }
function moveBits(n) {
  for (let k = 0; k < n; k++) {
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.x += b.vx / BIT_HZ; b.y += b.vy / BIT_HZ;
      if (b.kind === 2) { b.vx *= 0.99; b.vy *= 0.985; } else { b.vx *= 0.9; b.vy *= 0.9; }
      if (b.kind === 1) b.vy += 0.06;
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
const looks = new Map();      // id -> { ang, seen, puff }
let drawFailed = false;
let yardArt = null;           // the meadow and the tracks, drawn once a yard and size
let yardKey = '';

function colourOf(t, id) {
  const d = t.p[id];
  return d ? SEAT[d.c] : '#dddddd';
}
function lookOf(id) {
  let l = looks.get(id);
  if (!l) { l = { ang: null, seen: 0, puff: 0 }; looks.set(id, l); }
  l.seen = performance.now();
  return l;
}

function play(e, t) {
  const me = myId();
  if (e.kind === 'flip') {
    const [x, y] = stopXY(e.x);
    ring(x, y, colourOf(t, e.a), 0.55);
    spray(x, y, 5, '#fff2c0', 2, 0.04);
    sound.flip(e.a === me);
  } else if (e.kind === 'take') {
    const [x, y] = trackXY(e.x);
    const c = colourOf(t, e.a);
    spray(x, y, e.b > 1 ? 14 : 8, e.b > 1 ? INK.gold : INK.sackHi, 2.6, 0.05);
    ring(x, y, c, 0.5);
    if (e.a === me) pop(x, y, e.b > 1 ? 'gold!' : 'sack!', '#ffffff', 14);
    sound.take(e.a === me, e.b > 1);
  } else if (e.kind === 'full') {
    if (e.a === me) {
      const [x, y] = trackXY(e.x);
      pop(x, y, 'full!', INK.warn, 14);
      sound.full();
    }
  } else if (e.kind === 'home') {
    const [x, y] = stopXY(e.x);
    const c = colourOf(t, e.a);
    ring(x, y, c, 1.4);
    spray(x, y, e.b > 3 ? 24 : 14, e.b > 3 ? INK.gold : c, 4.5, 0.07);
    pop(x, y, '+' + e.b, e.a === me ? '#ffffff' : c, e.a === me ? 22 : 15);
    if (e.a === me) shake = Math.max(shake, 4);
    sound.home(e.a === me, e.b);
  } else if (e.kind === 'crash') {
    const [x, y] = unitXY(e.x, e.y);
    const mine = e.a === me || e.b === me;
    ring(x, y, '#ffb347', 1.3);
    spray(x, y, 26, '#ffb347', 6, 0.07);
    spray(x, y, 14, '#8a9599', 4, 0.08, 1);
    for (let i = 0; i < 8; i++) smoke(x + (Math.random() - 0.5) * 0.4, y + (Math.random() - 0.5) * 0.4, 0.12);
    pop(x, y, 'crash!', mine ? INK.danger : '#ffd9a8', mine ? 20 : 15);
    if (mine) shake = Math.max(shake, 12); else shake = Math.max(shake, 3);
    sound.crash(mine);
  } else if (e.kind === 'spill') {
    const [x, y] = trackXY(e.x);
    spray(x, y, 6, e.a > 1 ? INK.gold : INK.sack, 2.4, 0.05, 1);
    ring(x, y, e.a > 1 ? INK.gold : INK.sackHi, 0.5);
  } else if (e.kind === 'spawn') {
    const [x, y] = trackXY(e.x);
    ring(x, y, e.a > 1 ? INK.gold : INK.sackHi, 0.45);
    sound.spawn();
  } else if (e.kind === 'out') {
    const [x, y] = stopXY(e.x);
    ring(x, y, colourOf(t, e.a), 0.8);
    if (e.a === me) sound.toot();
  } else if (e.kind === 'rush') {
    pop(FW / 2, FH / 2, 'rush hour! every sack counts double', INK.gold, 22);
    sound.rush();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'round') {
    looks.clear();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

function drawGround() {
  flat();
  const g = ctx.createRadialGradient(VW / 2, VH * 0.45, 10, VW / 2, VH * 0.45, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
}

// A number every drawing of the same yard picks alike, for where its bushes
// grow: it is the screen's, so it need not be the table's.
function hash01(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// The meadow and every track laid, drawn into a picture of its own whenever
// the yard or the size changes: ballast, sleepers, then the two rails.
function yardArtOf(t) {
  const key = t.on.join('') + '|' + cs.toFixed(2) + '|' + dpx;
  if (yardArt && key === yardKey) return yardArt;
  yardKey = key;
  const wd = Math.ceil(cs * FW), ht = Math.ceil(cs * FH);
  if (!yardArt) yardArt = document.createElement('canvas');
  yardArt.width = Math.ceil(wd * dpx);
  yardArt.height = Math.ceil(ht * dpx);
  const g = yardArt.getContext('2d');
  g.setTransform(dpx, 0, 0, dpx, 0, 0);
  g.clearRect(0, 0, wd, ht);
  const rr = (x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  rr(1, 1, wd - 2, ht - 2, cs * 0.35);
  g.fillStyle = INK.meadow;
  g.fill();
  g.strokeStyle = INK.edge;
  g.lineWidth = 2;
  g.stroke();
  g.save();
  rr(1, 1, wd - 2, ht - 2, cs * 0.35);
  g.clip();
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      if ((x + y) % 2) continue;
      g.fillStyle = INK.meadowB;
      g.fillRect(x * cs, y * cs, cs, cs);
    }
  }
  // Bushes in the squares the tracks no longer ring, more where fewer run.
  for (let y = 0; y < NY - 1; y++) {
    for (let x = 0; x < NX - 1; x++) {
      const i = at(x, y);
      const ring4 = [EDGE[i * 4 + 1], EDGE[i * 4 + 2], EDGE[at(x + 1, y) * 4 + 2], EDGE[at(x, y + 1) * 4 + 1]];
      const open = ring4.filter((e) => !t.on[e]).length;
      const n = open >= 3 ? 3 : open >= 2 ? 2 : open >= 1 ? 1 : 0;
      for (let k = 0; k < n; k++) {
        const hx = (x + 0.5 + 0.25 + hash01(i * 7 + k) * 0.5) * cs, hy = (y + 0.5 + 0.25 + hash01(i * 13 + k + 99) * 0.5) * cs;
        const r = cs * (0.08 + hash01(i * 3 + k) * 0.07);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath(); g.arc(hx + r * 0.3, hy + r * 0.4, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = INK.bush;
        g.beginPath(); g.arc(hx, hy, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = INK.bushHi;
        g.beginPath(); g.arc(hx - r * 0.3, hy - r * 0.3, r * 0.5, 0, Math.PI * 2); g.fill();
      }
    }
  }
  g.restore();
  const sx = (i) => (nxOf(i) + 0.5) * cs, sy = (i) => (nyOf(i) + 0.5) * cs;
  g.lineCap = 'round';
  // Ballast under every track, and round every stop so a bend reads as one.
  g.strokeStyle = INK.ballast;
  g.lineWidth = cs * 0.34;
  g.beginPath();
  for (let e = 0; e < NE; e++) if (t.on[e]) { g.moveTo(sx(EA[e]), sy(EA[e])); g.lineTo(sx(EB[e]), sy(EB[e])); }
  g.stroke();
  g.strokeStyle = INK.ballastHi;
  g.lineWidth = cs * 0.04;
  g.stroke();
  // Sleepers across every track.
  g.fillStyle = INK.tie;
  for (let e = 0; e < NE; e++) {
    if (!t.on[e]) continue;
    const across = EB[e] - EA[e] === 1;
    for (let k = 1; k < 6; k++) {
      const f = k / 6;
      const x = lerp(sx(EA[e]), sx(EB[e]), f), y = lerp(sy(EA[e]), sy(EB[e]), f);
      if (across) g.fillRect(x - cs * 0.035, y - cs * 0.15, cs * 0.07, cs * 0.3);
      else g.fillRect(x - cs * 0.15, y - cs * 0.035, cs * 0.3, cs * 0.07);
    }
  }
  // Two rails a track, drawn to the stops at either end.
  const off = cs * 0.085;
  for (const [colour, width] of [[INK.railDark, cs * 0.05], [INK.rail, cs * 0.028]]) {
    g.strokeStyle = colour;
    g.lineWidth = Math.max(1, width);
    g.beginPath();
    for (let e = 0; e < NE; e++) {
      if (!t.on[e]) continue;
      const across = EB[e] - EA[e] === 1;
      for (const s of [-1, 1]) {
        const dx = across ? 0 : s * off, dy = across ? s * off : 0;
        const ex = across ? -off : 0, ey = across ? 0 : -off;
        g.moveTo(sx(EA[e]) + dx + ex, sy(EA[e]) + dy + ey);
        g.lineTo(sx(EB[e]) + dx - ex, sy(EB[e]) + dy - ey);
      }
    }
    g.stroke();
  }
  return yardArt;
}

function drawYard(t) {
  flat();
  ctx.drawImage(yardArtOf(t), PX(0), PY(0), cs * FW, cs * FH);
}

// The way a station faces: out of the yard, toward the rim it stands on.
function outOf(i) {
  const x = nxOf(i), y = nyOf(i);
  if (x === 0) return [-1, 0];
  if (x === NX - 1) return [1, 0];
  if (y === 0) return [0, -1];
  return [0, 1];
}

// Every station in use: a platform in its owner's colour round its stop, and
// a little station house with a lit window just outside the tracks.
function drawStations(t, now) {
  flat();
  const me = myId();
  for (const id of playersIn(t)) {
    const d = t.p[id], c = SEAT[d.c], i = DEPOT[d.s];
    const [x, y] = stopXY(i);
    const [vx, vy] = outOf(i);
    const X = PX(x), Y = PY(y), mine = id === me;
    ctx.fillStyle = alpha(c, mine ? 0.32 : 0.2);
    roundRect(X - cs * 0.3, Y - cs * 0.3, cs * 0.6, cs * 0.6, cs * 0.12);
    ctx.fill();
    ctx.setLineDash([cs * 0.1, cs * 0.07]);
    ctx.lineDashOffset = -now / 60;
    ctx.strokeStyle = alpha(c, mine ? 0.95 : 0.6);
    ctx.lineWidth = Math.max(1.5, cs * 0.04);
    ctx.stroke();
    ctx.setLineDash([]);
    const hx = X + vx * cs * 0.39, hy = Y + vy * cs * 0.39;
    const along = vx !== 0 ? cs * 0.18 : cs * 0.42, deep = vx !== 0 ? cs * 0.36 : cs * 0.18;
    const bw = vx !== 0 ? deep / 2 : along, bh = vx !== 0 ? along * 2 : deep;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    roundRect(hx - bw / 2 + cs * 0.03, hy - bh / 2 + cs * 0.04, bw, bh, cs * 0.04);
    ctx.fill();
    ctx.fillStyle = lighter(c, 0.15);
    roundRect(hx - bw / 2, hy - bh / 2, bw, bh, cs * 0.04);
    ctx.fill();
    // The roof, a ridge along its length, and a window lit warm.
    ctx.fillStyle = darker(c, 0.4);
    if (vx !== 0) ctx.fillRect(hx - cs * 0.015, hy - bh / 2, cs * 0.03, bh);
    else ctx.fillRect(hx - bw / 2, hy - cs * 0.015, bw, cs * 0.03);
    ctx.fillStyle = alpha(INK.lamp, 0.75 + 0.25 * Math.sin(now / 500 + i));
    disc(hx - vx * bw * 0.25, hy - vy * bh * 0.25, cs * 0.035);
    ctx.fill();
  }
}

// A sack waiting on its track: burlap tied at the neck, or a heap of gold.
function drawSacks(t, now) {
  flat();
  for (const [e, v] of t.k) {
    const [x, y] = trackXY(e);
    const bob = Math.sin(now / 300 + e) * cs * 0.02;
    drawSack(PX(x), PY(y) + bob, cs * 0.13, v > 1, now + e * 50);
  }
}
function drawSack(X, Y, r, gold, now) {
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(X + r * 0.2, Y + r * 0.8, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  if (gold) {
    ctx.fillStyle = INK.goldDark;
    disc(X, Y + r * 0.15, r * 0.95);
    ctx.fill();
    ctx.fillStyle = INK.gold;
    disc(X, Y, r * 0.85);
    ctx.fill();
    ctx.fillStyle = INK.goldHi;
    disc(X - r * 0.3, Y - r * 0.3, r * 0.3);
    ctx.fill();
    const k = 0.5 + 0.5 * Math.sin(now / 180);
    ctx.fillStyle = `rgba(255,255,255,${(0.3 + 0.6 * k).toFixed(3)})`;
    const s = r * (0.3 + 0.3 * k);
    ctx.beginPath();
    ctx.moveTo(X + r * 0.5, Y - r * 0.9 - s);
    ctx.lineTo(X + r * 0.5 + s * 0.3, Y - r * 0.9);
    ctx.lineTo(X + r * 0.5, Y - r * 0.9 + s);
    ctx.lineTo(X + r * 0.5 - s * 0.3, Y - r * 0.9);
    ctx.closePath();
    ctx.fill();
    return;
  }
  ctx.fillStyle = INK.sackDark;
  disc(X, Y + r * 0.1, r);
  ctx.fill();
  ctx.fillStyle = INK.sack;
  disc(X, Y, r * 0.88);
  ctx.fill();
  ctx.fillStyle = INK.sackHi;
  disc(X - r * 0.3, Y - r * 0.25, r * 0.3);
  ctx.fill();
  ctx.fillStyle = INK.sackDark;
  ctx.beginPath();
  ctx.moveTo(X - r * 0.4, Y - r * 0.95);
  ctx.lineTo(X + r * 0.4, Y - r * 0.95);
  ctx.lineTo(X + r * 0.15, Y - r * 0.6);
  ctx.lineTo(X - r * 0.15, Y - r * 0.6);
  ctx.closePath();
  ctx.fill();
}

// Every switch: a round plate with a brass lever pointing down the track a
// train will take, coloured by whoever threw it while it is locked.
function drawSwitches(t, sw, now, hot, next, mineColour) {
  flat();
  for (let i = 0; i < NN; i++) {
    if (t.sw[i] < 0) continue;
    const s = sw[i] >= 0 && has(t, i, sw[i]) ? sw[i] : t.sw[i];
    const [x, y] = stopXY(i);
    const X = PX(x), Y = PY(y);
    const locked = t.lk[i] > 0 && t.lb[i] >= 0;
    const c = locked ? SEAT[t.lb[i]] : INK.lever;
    // The rails of the way it points, lit.
    ctx.strokeStyle = alpha(locked ? SEAT[t.lb[i]] : '#fff3c4', 0.85);
    ctx.lineWidth = Math.max(2, cs * 0.07);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(X, Y);
    ctx.lineTo(X + DX[s] * cs * 0.4, Y + DY[s] * cs * 0.4);
    ctx.stroke();
    if (i === next) {
      ctx.strokeStyle = alpha(mineColour, 0.55 + 0.35 * Math.sin(now / 160));
      ctx.lineWidth = 2;
      disc(X, Y, cs * 0.27);
      ctx.stroke();
    }
    if (i === hot) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      disc(X, Y, cs * 0.33);
      ctx.fill();
    }
    ctx.fillStyle = INK.plate;
    disc(X, Y, cs * 0.13);
    ctx.fill();
    ctx.strokeStyle = INK.plateRim;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // The lever itself, with a knob at its end.
    const lx = X + DX[s] * cs * 0.17, ly = Y + DY[s] * cs * 0.17;
    ctx.strokeStyle = c;
    ctx.lineWidth = Math.max(2, cs * 0.05);
    ctx.beginPath();
    ctx.moveTo(X - DX[s] * cs * 0.05, Y - DY[s] * cs * 0.05);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.fillStyle = c;
    disc(lx, ly, cs * 0.05);
    ctx.fill();
    if (locked) {
      const f = t.lk[i] / LOCK;
      ctx.strokeStyle = alpha(SEAT[t.lb[i]], 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X, Y, cs * 0.19, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
      ctx.stroke();
    }
  }
}

// Where your own train goes from here, the way the switches stand now: a
// dotted line in your colour over the next few stops, and the first switch it
// meets, which is the one the keys throw.
function routeOf(t, d, stops) {
  const pts = [unitXY(...posOf(d))];
  let prev = d.a, i = d.b, first = -1;
  for (let k = 0; k < stops; k++) {
    pts.push(stopXY(i));
    if (first < 0 && isSwitch(t, i)) first = i;
    const e = exitOf(t, i, dirTo(i, prev));
    prev = i;
    i = NB[i * 4 + e];
  }
  return { pts, first };
}
function nextSwitch(t, d) {
  let prev = d.a, i = d.b;
  for (let k = 0; k < 12; k++) {
    if (isSwitch(t, i)) return { i, from: dirTo(i, prev) };
    const e = exitOf(t, i, dirTo(i, prev));
    prev = i;
    i = NB[i * 4 + e];
  }
  return null;
}
function drawRoute(pts, colour, now) {
  flat();
  ctx.strokeStyle = alpha(colour, 0.7);
  ctx.lineWidth = Math.max(2, cs * 0.06);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([cs * 0.06, cs * 0.14]);
  ctx.lineDashOffset = -now / 40;
  ctx.beginPath();
  pts.forEach(([x, y], k) => (k ? ctx.lineTo(PX(x), PY(y)) : ctx.moveTo(PX(x), PY(y))));
  ctx.stroke();
  ctx.setLineDash([]);
}

// Where a train and its wagons stand in one table, in units, with the way
// each faces. A wagon trails the engine along the rails it came by.
const WAGON = 11;
function poseIn(d) {
  const dir = dirTo(d.a, d.b);
  const ax = nxOf(d.a) * LEN, ay = nyOf(d.a) * LEN;
  const head = [ax + DX[dir] * d.pr, ay + DY[dir] * d.pr, dir];
  const wagons = [];
  for (let n = 0; n < d.ld.length; n++) {
    const s = WAGON * (n + 1) + 2;
    if (s <= d.pr) { wagons.push([ax + DX[dir] * (d.pr - s), ay + DY[dir] * (d.pr - s), dir]); continue; }
    const rem = Math.min(LEN, s - d.pr);
    const back = d.z === d.a ? dir : dirTo(d.z, d.a);
    wagons.push([ax - DX[back] * rem, ay - DY[back] * rem, back]);
  }
  return { head, wagons };
}
// And as drawn between two tables, never slid across a jump: a train back at
// its station, a new round.
function poseBetween(a, z, k) {
  const q = poseIn(z);
  if (!a) return q;
  const p = poseIn(a);
  if (Math.abs(p.head[0] - q.head[0]) + Math.abs(p.head[1] - q.head[1]) > LEN) return q;
  const mix = (u, v) => (Math.abs(u[0] - v[0]) + Math.abs(u[1] - v[1]) > LEN ? v : [lerp(u[0], v[0], k), lerp(u[1], v[1], k), v[2]]);
  return { head: mix(p.head, q.head), wagons: q.wagons.map((w, n) => (p.wagons[n] ? mix(p.wagons[n], w) : w)) };
}

const ANG = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
function turnToward(l, target) {
  if (l.ang === null) { l.ang = target; return l.ang; }
  let d = target - l.ang;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  l.ang += d * per60(0.35);
  return l.ang;
}

// A train from above: a wagon a sack, then the engine — a boiler in its
// colour, a dark cab at the back, a chimney puffing smoke and a lamp throwing
// light down the line. A wreck lies askew and smoulders; a train fresh out of
// its station flickers while it passes through others.
function drawTrain(t, id, pose, d, me, now, crowned, quick) {
  flat();
  const c = SEAT[d.c];
  const l = lookOf(id);
  const wrecked = d.cr > 0;
  const ghost = d.gd > 0 && !wrecked;
  ctx.globalAlpha = ghost ? 0.45 + 0.25 * Math.sin(now / 70) : 1;
  pose.wagons.forEach(([ux, uy, dir], n) => {
    const [x, y] = unitXY(ux, uy);
    const X = PX(x), Y = PY(y);
    ctx.save();
    ctx.translate(X, Y);
    ctx.rotate(ANG[dir] + (wrecked ? (n % 2 ? -0.5 : 0.6) : 0));
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    roundRect(-cs * 0.14 + cs * 0.03, -cs * 0.11 + cs * 0.04, cs * 0.28, cs * 0.22, cs * 0.04);
    ctx.fill();
    ctx.fillStyle = wrecked ? '#555c60' : darker(c, 0.3);
    roundRect(-cs * 0.14, -cs * 0.11, cs * 0.28, cs * 0.22, cs * 0.04);
    ctx.fill();
    ctx.restore();
    if (!wrecked) drawSack(X, Y - cs * 0.01, cs * 0.075, d.ld[n] > 1, now + n * 90);
  });
  const [x, y] = unitXY(pose.head[0], pose.head[1]);
  const X = PX(x), Y = PY(y);
  const ang = wrecked ? ANG[pose.head[2]] + 0.7 : turnToward(l, ANG[pose.head[2]]);
  if (wrecked) l.ang = null;
  ctx.save();
  ctx.translate(X, Y);
  ctx.rotate(ang);
  if (!wrecked && !ghost) {
    const g = ctx.createLinearGradient(cs * 0.22, 0, cs * 0.9, 0);
    g.addColorStop(0, 'rgba(255,233,163,0.32)');
    g.addColorStop(1, 'rgba(255,233,163,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cs * 0.22, -cs * 0.04);
    ctx.lineTo(cs * 0.9, -cs * 0.22);
    ctx.lineTo(cs * 0.9, cs * 0.22);
    ctx.lineTo(cs * 0.22, cs * 0.04);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  roundRect(-cs * 0.2 + cs * 0.03, -cs * 0.13 + cs * 0.05, cs * 0.44, cs * 0.26, cs * 0.08);
  ctx.fill();
  if (me && !wrecked) {
    ctx.strokeStyle = alpha(c, 0.55 + 0.3 * Math.sin(now / 220));
    ctx.lineWidth = 2;
    roundRect(-cs * 0.28, -cs * 0.21, cs * 0.6, cs * 0.42, cs * 0.14);
    ctx.stroke();
  }
  const body = wrecked ? '#6b7377' : c;
  ctx.fillStyle = darker(body, 0.35);
  roundRect(-cs * 0.2, -cs * 0.13, cs * 0.44, cs * 0.26, cs * 0.08);
  ctx.fill();
  ctx.fillStyle = body;
  roundRect(-cs * 0.06, -cs * 0.1, cs * 0.28, cs * 0.2, cs * 0.09);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fillRect(-cs * 0.04, -cs * 0.07, cs * 0.24, cs * 0.035);
  // The cab at the back, its roof darker, with a window.
  ctx.fillStyle = darker(body, 0.5);
  roundRect(-cs * 0.2, -cs * 0.12, cs * 0.13, cs * 0.24, cs * 0.04);
  ctx.fill();
  ctx.fillStyle = wrecked ? '#30363a' : alpha(INK.lamp, 0.85);
  ctx.fillRect(-cs * 0.12, -cs * 0.08, cs * 0.03, cs * 0.16);
  // The chimney, and the lamp at the very front.
  ctx.fillStyle = '#1b1f22';
  disc(cs * 0.13, 0, cs * 0.045);
  ctx.fill();
  ctx.fillStyle = wrecked ? '#444' : INK.lamp;
  disc(cs * 0.23, 0, cs * 0.03);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
  // Smoke out of the chimney, thicker for a wreck; only for the screen.
  const cx = x + Math.cos(ang) * 0.13, cy = y + Math.sin(ang) * 0.13;
  l.puff += frameDt * (wrecked ? 10 : quick ? 7 : 4);
  while (l.puff >= 1) { l.puff -= 1; smoke(cx, cy, wrecked ? 0.09 : 0.06); }
  if (wrecked && Math.random() < frameDt * 12) spray(x, y, 1, Math.random() < 0.5 ? '#ff9a3c' : '#ffd23f', 1.2, 0.04);
  if (crowned) drawCrown(X, Y - cs * 0.3, cs * 0.12, now);
  if (!me && cs > 14) {
    ctx.font = font(Math.max(9, Math.min(12, cs * 0.24)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10,20,18,0.85)';
    const s = nickOf(id);
    ctx.strokeText(s, X, Y + cs * 0.38);
    ctx.fillStyle = alpha(c, 0.95);
    ctx.fillText(s, X, Y + cs * 0.38);
  }
}

function drawCrown(x, y, s, now) {
  const b = Math.sin(now / 260) * s * 0.12;
  ctx.fillStyle = INK.gold;
  ctx.beginPath();
  ctx.moveTo(x - s, y + b);
  ctx.lineTo(x - s, y - s * 0.7 + b);
  ctx.lineTo(x - s * 0.5, y - s * 0.25 + b);
  ctx.lineTo(x, y - s * 0.9 + b);
  ctx.lineTo(x + s * 0.5, y - s * 0.25 + b);
  ctx.lineTo(x + s, y - s * 0.7 + b);
  ctx.lineTo(x + s, y + b);
  ctx.closePath();
  ctx.fill();
}

function drawBits() {
  flat();
  for (const b of bits) {
    const k = b.life / b.max;
    if (b.kind === 2) {
      ctx.globalAlpha = 0.28 * (1 - k);
      ctx.fillStyle = b.colour;
      disc(PX(b.x), PY(b.y), b.size * cs * (0.6 + k * 1.6));
      ctx.fill();
      continue;
    }
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = b.colour;
    disc(PX(b.x), PY(b.y), b.size * cs * (1 - k * 0.5));
    ctx.fill();
  }
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = (1 - k) * 0.7;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 3 * (1 - k) + 1;
    disc(PX(r.x), PY(r.y), r.r * cs * ease(k));
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
    ctx.strokeStyle = 'rgba(10,20,18,0.85)';
    const X = PX(p.x), Y = PY(p.y) - rise;
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
    status = 'round ' + t.rd + ' · ' + clock(t.pt) + ' left' + (rushOn(t) ? ' · rush hour!' : '');
    if (rushOn(t)) colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('junction', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('junction').width;
  if (wide) fitText(status, 12, 44, 14, colour, colW - 24, 'left');
  else fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 150, 'left');
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a player in their colour, with points this round
  // and rounds won. A row across the top of a narrow frame, a column down the
  // left of a wide one.
  const ids = bySeat(t);
  const crown = t.ph === WAIT || t.ph === PLAY ? leaderOf(t) : -1;
  const top = topOf(t);
  if (ids.length) {
    const gap = 6;
    const cw = wide ? Math.min(200, colW - 24) : Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = wide ? 12 : (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    let y = wide ? 78 : narrow ? 46 : 44;
    for (const id of ids) {
      const d = t.p[id], mine = id === me, c = SEAT[d.c];
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.28)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = c;
      roundRect(x + 6, y - 7, 10, 10, 2);
      ctx.fill();
      const fast = trails(t, d, top);
      const score = String(d.sc) + (fast && cw > 70 ? ' »' : '') + (d.wn && cw > 60 ? ' ★' + d.wn : '');
      ctx.font = font(12);
      const sw = Math.min(cw - 24, ctx.measureText(score).width);
      fitText(score, x + cw - 8, y + 3, 12, id === crown ? INK.gold : INK.text, cw - 24, 'right');
      if (cw > 56) fitText(mine ? 'you' : nickOf(id), x + 22, y + 3, 12, mine ? INK.text : INK.muted, cw - 36 - sw, 'left');
      if (wide) y += 22 + gap; else x += cw + gap;
    }
  }

  // The one line that says how to play: across the foot of a narrow frame, and
  // broken into lines at the foot of the right-hand column of a wide one.
  const how = coarse
    ? 'drag a switch toward the track you want · hold anywhere else to brake · bring sacks home to your station'
    : 'click a switch or drag it toward a track · ←↑→ throw the next switch ahead · hold Space to brake · M mutes';
  if (!wide) { fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20); return; }
  const lines = wrap(how, 12, colW - 24);
  lines.forEach((s, i) => text(s, VW - 12, VH - 12 - (lines.length - 1 - i) * 17, 12, INK.muted, 'right'));
}

// Your train, while a round is on: what it carries, what your purse holds,
// and why it runs as it does, in the strip under the yard or halfway down the
// right-hand column.
function drawMine(t, own) {
  const d = own && own.p[myId()];
  if (!d || t.ph !== PLAY) return;
  flat();
  const y = wide ? VH / 2 : Math.min(fieldBot + NOTE_ROOM / 2 - 2, VH - BOT - 14);
  const mid = wide ? VW - colW / 2 : VW / 2, most = wide ? colW - 24 : VW - 24;
  const top = topOf(t), lead = leaderOf(t);
  const pips = Math.floor(d.tk / COST);
  const purse = 'switches ' + '●'.repeat(pips) + '○'.repeat(3 - pips);
  const cargo = 'cargo ' + d.ld.length + '/' + CAP;
  let line, colour = INK.muted;
  if (d.cr > 0) { line = 'derailed! back on the line in ' + Math.ceil(d.cr / HZ) + 's · ' + purse; colour = INK.danger; }
  else if (d.gd > 0) line = 'fresh out of the station · you pass through trains · ' + purse;
  else if (myId() === lead) { line = 'you lead · ' + cargo + ' · ' + purse; colour = INK.gold; }
  else if (trails(t, d, top)) { line = 'catching up · faster train, quicker switches · ' + cargo + ' · ' + purse; colour = SEAT[d.c]; }
  else line = cargo + ' · bring it home to your station · ' + purse;
  if (d.br && d.cr === 0) line = 'braking · ' + line;
  if (wide) {
    const lines = wrap(line, 13, most);
    lines.forEach((s, i) => text(s, mid, y + i * 18, 13, colour, 'center'));
  } else fitText(line, mid, y, 13, colour, most);
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

function panel(cx, cy, w, h) {
  ctx.fillStyle = INK.panel;
  roundRect(cx - w / 2, cy - h / 2, w, h, 14);
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
    const tip = two ? null : 'throw the switch ahead of your train · bring sacks home to your station';
    // A wide frame has no strip above or below the yard: the note sits at the
    // foot of it for as long as practice lasts.
    if (wide) practiceNote(now, VW, head, tip, [], VH - 8);
    else practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(10,20,18,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid - big * 0.6);
    text(String(n), cx, mid - big * 0.6, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 1.4, Math.min(VW - 32, 380), 30);
    fitText('most sacks brought home to your station when time runs out wins', cx, mid + big * 1.4 + 5, 14, INK.text, Math.min(VW - 48, 360));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(10,20,18,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('go!', cx, mid + big * 0.5);
    text('go!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 340), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, mid + (1 - k) * 30, w, h);
    const me = myId();
    let head;
    if (t.win === -1) head = 'a draw · nobody brought home the most';
    else head = t.win === me ? 'you win the round!' : nickOf(t.win) + ' wins the round';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('points', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('sacks', cx + w / 2 - 64, y0 + 52, 10, INK.dim, 'right');
    text('rounds', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, won, wins, points, sacks], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      roundRect(cx - w / 2 + 19, y - 9, 10, 10, 2);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (won ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(points), cx + w / 2 - 110, y, 14, INK.text, 'right');
      text(String(sacks), cx + w / 2 - 64, y, 14, INK.text, 'right');
      text(String(wins), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Your own train is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put it a step away from
// where the guess had it. So the train drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a train back at its station — puts it there at once. Only
// the drawing is smoothed: the yard, and every rule in it, are untouched.
const PULL = 0.4;
let shown = null;        // the pose your train is drawn at, in units

function settle(pose) {
  const h = pose.head;
  if (!shown || Math.abs(h[0] - shown.head[0]) + Math.abs(h[1] - shown.head[1]) > LEN * 0.8) {
    shown = { head: h.slice(), wagons: pose.wagons.map((w) => w.slice()) };
    return shown;
  }
  const k = per60(PULL);
  const pull = (s, g) => (Math.abs(g[0] - s[0]) + Math.abs(g[1] - s[1]) > LEN * 0.8 ? g.slice()
    : [s[0] + (g[0] - s[0]) * k, s[1] + (g[1] - s[1]) * k, g[2]]);
  shown = { head: pull(shown.head, h), wagons: pose.wagons.map((w, n) => (shown.wagons[n] ? pull(shown.wagons[n], w) : w.slice())) };
  return shown;
}

function draw(now) {
  const b = agreedAt(now);
  drawGround();
  if (!b) {
    flat();
    const cx = VW / 2, cy = VH / 2;
    panel(cx, cy, Math.min(VW - 32, 300), 60);
    text('catching up with the yard…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a yard this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const me = myId();
  const m = mineAt(now);
  const own = m && m.to.p[me] ? m : t.p[me] ? b : null;
  ownTable = own ? own.to : null;
  drawYard(t);
  drawStations(t, now);
  drawSacks(t, now);
  const d = own ? own.to.p[me] : null;
  const c = d ? SEAT[d.c] : '#ffffff';
  const route = d && d.cr === 0 ? routeOf(own.to, d, 4) : null;
  if (route) drawRoute(route.pts, c, now);
  // A switch you threw shows at once, from the guess; everybody else's from
  // the agreed yard, which the guess is made from.
  drawSwitches(t, own ? own.to.sw : t.sw, now, hoverStop(t), route ? route.first : -1, c);
  if (throwing && throwing.way >= 0) drawThrow(throwing);
  const top = topOf(t);
  const crown = t.ph === WAIT || t.ph === PLAY ? leaderOf(t) : -1;
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const o = t.p[id];
    drawTrain(t, id, poseBetween(b.from.p[id], o, b.k), o, false, now, id === crown, trails(t, o, top));
  }
  if (own && d) {
    const pose = settle(poseBetween(own.from.p[me], d, own.k));
    drawTrain(t, me, pose, d, true, now, me === crown, trails(t, d, top));
  } else shown = null;
  for (const [id, look] of looks) if (now - look.seen > 4000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t, own ? own.to : null);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the number of the last switch thrown, which and which
// way, and whether the brake is held. A throw goes out at once; the brake no
// oftener than BRAKE_EVERY while it keeps changing, because a finger dabbing
// at the screen changes it on every touch and the clock's ticks share the
// same seat's ceiling on messages. Throws are spaced by THROW_EVERY, which is
// still quicker than the purse can pay for them.
const BRAKE_EVERY = 50;
const THROW_EVERY = 80;
let seq = 0, lastStop = -1, lastWay = 0, braking = 0, saidBrake = 0;
let saidAt = -1e9, thrownAt = -1e9;
let ownTable = null;     // the yard your own train is drawn from: the guess

function throwSwitch(i, way) {
  const now = performance.now();
  if (now - thrownAt < THROW_EVERY) return;
  thrownAt = now;
  seq = (seq + 1) % 1000;
  lastStop = i;
  lastWay = way;
  saidBrake = braking;
  saidAt = now;
  setHand([seq, lastStop, lastWay, braking]);
}
function brake(on) {
  braking = on ? 1 : 0;
  sayHand(performance.now());
}
function sayHand(now) {
  if (braking === saidBrake || now - saidAt < BRAKE_EVERY) return;
  saidBrake = braking;
  saidAt = now;
  setHand([seq, lastStop, lastWay, braking]);
}

// A throw from the keys: the next switch ahead of your train, set to the way
// the key names as your train sees it — left, straight on or right.
function throwAhead(turn) {
  const t = ownTable;
  const d = t && t.p[myId()];
  if (!d || d.cr > 0) return;
  const n = nextSwitch(t, d);
  if (!n) return;
  const heading = (n.from + 2) % 4;
  const way = (heading + turn + 4) % 4;
  if (!has(t, n.i, way) || way === n.from) { sound.nope(); return; }
  if (t.sw[n.i] === way) return;
  throwSwitch(n.i, way);
}

const KEY_TURN = { ArrowLeft: -1, KeyA: -1, ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1 };
const KEY_BRAKE = new Set(['Space', 'ArrowDown', 'KeyS', 'ShiftLeft', 'ShiftRight']);
const brakeKeys = new Set();
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { if (!e.repeat) setMuted(!muted); return; }
  if (e.code in KEY_TURN) {
    e.preventDefault();
    coarse = false;
    if (!e.repeat) throwAhead(KEY_TURN[e.code]);
    return;
  }
  if (!KEY_BRAKE.has(e.code)) return;
  e.preventDefault();
  coarse = false;
  brakeKeys.add(e.code);
  brake(true);
});
addEventListener('keyup', (e) => {
  if (!brakeKeys.delete(e.code)) return;
  if (!brakeKeys.size && !holding) brake(false);
});

// A thumb or a mouse. Pressed on a switch, it throws it: dragged toward one
// of its tracks, that way; let go where it was pressed, the next way round.
// Pressed anywhere else, it holds the brake until it lifts. Bound to the
// canvas and captured there, because iOS keeps a long press inside a frame
// for itself.
const PICK = 0.45;             // how near a stop, in cells, a press must land to take its switch
const AIM = 0.18;              // how far, in cells, a drag must go to name a way
let throwing = null;           // { id, i, x, y, way }: a press on a switch, in cells
let holding = null;            // the pointer holding the brake
let hover = null;              // [x, y] in cells: where the mouse is
function cellOf(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left - ox) / cs, (e.clientY - r.top - oy) / cs];
}
function stopNear(t, x, y) {
  if (!t) return -1;
  const sx = Math.round(x - 0.5), sy = Math.round(y - 0.5);
  if (sx < 0 || sy < 0 || sx >= NX || sy >= NY) return -1;
  if (Math.abs(x - (sx + 0.5)) > PICK || Math.abs(y - (sy + 0.5)) > PICK) return -1;
  const i = at(sx, sy);
  return t.sw[i] >= 0 ? i : -1;
}
function hoverStop(t) {
  if (throwing) return throwing.i;
  return hover && !coarse ? stopNear(t, hover[0], hover[1]) : -1;
}
function wayOf(t, th) {
  const [sx, sy] = stopXY(th.i);
  const dx = th.x - sx, dy = th.y - sy;
  if (Math.abs(dx) + Math.abs(dy) < AIM) return -1;
  const way = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
  return has(t, th.i, way) ? way : -1;
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  coarse = e.pointerType === 'touch';
  if (throwing || holding !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  const [x, y] = cellOf(e);
  const i = stopNear(ownTable || world, x, y);
  if (i >= 0) {
    throwing = { id: e.pointerId, i, x, y, way: -1 };
    throwing.way = wayOf(ownTable || world, throwing);
    return;
  }
  holding = e.pointerId;
  brake(true);
});
cv.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') hover = cellOf(e);
  if (!throwing || e.pointerId !== throwing.id) return;
  [throwing.x, throwing.y] = cellOf(e);
  const t = ownTable || world;
  throwing.way = t ? wayOf(t, throwing) : -1;
});
cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hover = null; });
function lift(e) {
  if (throwing && e.pointerId === throwing.id) {
    const th = throwing;
    throwing = null;
    const t = ownTable || world;
    if (e.type === 'pointercancel' || !t) return;
    [th.x, th.y] = cellOf(e);
    th.way = wayOf(t, th);
    const [sx, sy] = stopXY(th.i);
    const moved = Math.abs(th.x - sx) + Math.abs(th.y - sy) >= AIM;
    if (!moved) throwSwitch(th.i, 4);
    else if (th.way >= 0 && th.way !== t.sw[th.i]) throwSwitch(th.i, th.way);
    else if (th.way < 0) sound.nope();
    return;
  }
  if (holding !== null && e.pointerId === holding) {
    holding = null;
    if (!brakeKeys.size) brake(false);
  }
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);
addEventListener('blur', () => { throwing = null; holding = null; brakeKeys.clear(); brake(false); });

// A press on a switch, dragged: the way it would be thrown, under the thumb.
function drawThrow(th) {
  flat();
  const [sx, sy] = stopXY(th.i);
  const X = PX(sx), Y = PY(sy);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(3, cs * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(X, Y);
  ctx.lineTo(X + DX[th.way] * cs * 0.5, Y + DY[th.way] * cs * 0.5);
  ctx.stroke();
  const hx = X + DX[th.way] * cs * 0.5, hy = Y + DY[th.way] * cs * 0.5, s = cs * 0.1;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(hx + DX[th.way] * s * 1.3, hy + DY[th.way] * s * 1.3);
  ctx.lineTo(hx - DY[th.way] * s, hy + DX[th.way] * s);
  ctx.lineTo(hx + DY[th.way] * s, hy - DX[th.way] * s);
  ctx.closePath();
  ctx.fill();
}

function frame(now) {
  frameDt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const steps = Math.min(8, Math.floor((now - bitsClock) / (1000 / BIT_HZ)));
  if (steps > 0) { moveBits(steps); bitsClock += steps * (1000 / BIT_HZ); }
  if (now - bitsClock > 1000) bitsClock = now;
  sayHand(now);
  try { draw(now); } catch (err) {
    // Said once: a drawing that fails every frame would fill the console.
    if (!drawFailed) console.log('draw failed: ' + (err && err.message));
    drawFailed = true;
  }
  requestAnimationFrame(frame);
}

// Called by the kernel once it stands. Saying nothing thrown and no brake is a
// hand too: it is how a player arrives in the yard.
function start() {
  setHand([seq, -1, 0, 0]);
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
