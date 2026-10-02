/**
 * @disk     glint
 * @author   claude
 * @version  2
 * @players  2-8
 * @about    A duel of light on a board of mirrors. Flip any mirror to bend your beam into a rival's gem and drain its light, and turn their beams off yours. The leader pays extra, sparks pay the first beam to reach them, and whoever shines brightest when the clock runs out wins.
 * @tags     game, party, realtime, puzzle, lockstep, practice
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/glint.png
 */
// glint.js — beams and mirrors, where the room's order is the referee.
//
// Every copy holds the whole board — every mirror, which way it leans, who
// flipped it last, every player's light — and changes it only on what comes
// back round the room, so every copy applies the same hands in the same order
// and holds the same board. Nobody sends where their beam lands, whose gem it
// drains or how much light anybody has: a hand is "flip the mirror in this
// cell", nothing else, and where every beam goes and what it takes is traced
// by the same arithmetic on the same numbers on every machine. A page with a
// console open can flip mirrors however it likes, at a hand's own pace, and
// no faster.
//
// Your own flips do not wait for the trip: the board is drawn from the agreed
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

// ═══════════════════ the game ═══════════════════
const HZ = 20;                 // steps of the board a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw the board a trip ahead, with your own flips in it

const N = 9;                   // cells a side; the ring of slots round them is one cell wide
const NN = N * N;
const MID = (NN - 1) / 2;      // the centre cell, which is its own mirror image
const HALF_PIVOTS = 11;        // mirrors laid in one half of the board, and copied into the other
const MAX_P = 8;
const LOCK = Math.round(1.5 * HZ);     // steps a mirror just flipped cannot be flipped again
const REFILL = Math.round(0.75 * HZ);  // steps a flip costs, out of a purse that refills a step at a time
const PURSE = 2 * REFILL;              // the most a purse holds: two flips back to back, no more
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const START = 5000;            // light a round starts with, in hundredths
const RATE0 = 20, RATE1 = 60;  // hundredths a beam drains a step, at the start of a round and at its end
const SPARK = 1000;            // what a spark is worth
const SPARK_GAP = 5 * HZ, SPARK_GAP_SURGE = 3 * HZ, SPARK_LIFE = 10 * HZ, SPARK_MAX = 3;
const UI_GAP = 800;
const BOT_ID = -2;                // the practice bot's id: no room hands out a negative one
const BOT_THINK0 = 22, BOT_THINK1 = 34; // steps the bot waits between looks at the board
const BOT_SLIP = 0.3;          // how often it takes a worse flip than the best it found            // ms this page waits between its own flips, a little over the purse's pace

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 8 * HZ;
const SURGE = 20 * HZ;         // the last steps of a round, where beams drain half as hard again

// A slot is a place on the ring: side * N + i, the sides being bottom, top,
// left and right, and i counting left to right or top to bottom. A seat is a
// base of two slots side by side, a lamp that shines into the board and the
// gem it guards, and the slot beside them where its light is shown. Seats are
// handed out in this order, so two players sit opposite each other, and the
// board is laid half-turn symmetric, so opposite seats face the same board.
const SEATS = [
  [2, 1, 3], [N + 6, N + 7, N + 5], [2 * N + 6, 2 * N + 7, 2 * N + 5], [3 * N + 2, 3 * N + 1, 3 * N + 3],
  [6, 7, 5], [N + 2, N + 1, N + 3], [2 * N + 2, 2 * N + 1, 2 * N + 3], [3 * N + 6, 3 * N + 7, 3 * N + 5],
];

// The board. Plain data only: it is fingerprinted and handed over as JSON,
// and the copy a newcomer reads back must print exactly like the one it came
// from, so every player is made by one function with its fields in one order.
//   pv: each cell's mirror, 0 none, 1 leaning like /, 2 like \
//   lk: steps until a mirror may be flipped again; lb: the colour of whoever
//   flipped it, or -1
//   sp: sparks as [cell, steps left]; sg: steps until the next one
//   res: the last round's [id, light, rounds won, stolen, sparks] rows; win:
//   its winner or -1
function freshTable(seed) {
  const w = {
    rng: seed | 0, ph: WAIT, pt: 0, rd: 0, pv: [], lk: [], lb: [], sp: [], sg: SPARK_GAP, p: {}, res: null, win: -1,
  };
  lay(w);
  return w;
}

// A new board: mirrors scattered over one half and copied a half turn round,
// and every line a base stands on crossed by two mirrors at least, so every
// lamp can be bent and every gem can be reached. A board where some lamp
// already shines on a gem is laid again, so a round starts with nobody
// drained and the first hit is somebody's doing.
function lay(w) {
  let pv = null;
  for (let tries = 0; tries < 20; tries++) {
    pv = layOnce(w);
    const gems = new Set(SEATS.map((s) => s[1]));
    if (SEATS.every((s) => !gems.has(trace(pv, s[0], null)))) break;
  }
  w.pv = pv;
  w.lk = new Array(NN).fill(0);
  w.lb = new Array(NN).fill(-1);
}

function layOnce(w) {
  const pv = new Array(NN).fill(0);
  const put = (i) => {
    const m = draw01(w) < 0.5 ? 1 : 2;
    pv[i] = m;
    pv[NN - 1 - i] = m;
  };
  let placed = 0;
  for (let guard = 0; placed < HALF_PIVOTS && guard < 500; guard++) {
    const i = Math.floor(draw01(w) * MID);
    if (pv[i]) continue;
    put(i);
    placed += 1;
  }
  const count = (line, col) => {
    let c = 0;
    for (let k = 0; k < N; k++) if (pv[col ? k * N + line : line * N + k]) c += 1;
    return c;
  };
  for (const line of [1, 2, 6, 7]) {
    for (const col of [true, false]) {
      for (let guard = 0; count(line, col) < 2 && guard < 60; guard++) {
        const k = Math.floor(draw01(w) * N);
        const i = col ? k * N + line : line * N + k;
        if (pv[i] || i === MID) continue;
        put(i);
      }
    }
  }
  return pv;
}

const FIELDS = ['c', 's', 'L', 'tk', 'q', 'by', 'hs', 'hc', 'wn', 'st', 'sk'];
//   c: colour; s: seat; L: light, in hundredths; tk: the flip purse; q: the
//   number of the last flip heard; by: whose beam is on this gem, or -1; hs,
//   hc: hands this step; wn: rounds won; st: light stolen this round; sk:
//   sparks this round.
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

// Where a beam from a slot goes: the cells it crosses, pushed onto `cells`,
// and the slot it leaves the board by. A mirror turns it a quarter; a beam
// that came in from the ring always goes out to it, since every mirror
// sends it back the way it came if it is turned round.
function trace(pv, slot, cells) {
  const side = Math.floor(slot / N), i = slot % N;
  let x, y, dx, dy;
  if (side === 0) { x = i; y = N - 1; dx = 0; dy = -1; }
  else if (side === 1) { x = i; y = 0; dx = 0; dy = 1; }
  else if (side === 2) { x = 0; y = i; dx = 1; dy = 0; }
  else { x = N - 1; y = i; dx = -1; dy = 0; }
  for (let guard = 0; guard < 4 * NN; guard++) {
    const c = y * N + x;
    if (cells) cells.push(c);
    const m = pv[c];
    if (m === 1) { const t = dx; dx = -dy; dy = -t; }
    else if (m === 2) { const t = dx; dx = dy; dy = t; }
    x += dx;
    y += dy;
    if (y < 0) return N + x;
    if (y >= N) return x;
    if (x < 0) return 2 * N + y;
    if (x >= N) return 3 * N + y;
  }
  return -1;
}

// Light a newcomer brings into a round already running: what the room holds
// on average, and never more than a round starts with.
function joinLight(w) {
  const ids = playersIn(w);
  if (!ids.length) return START;
  let sum = 0;
  for (const id of ids) sum += w.p[id].L;
  return Math.min(START, Math.floor(sum / ids.length));
}

// A hand, at its place in the room's order: [the number of this flip, the
// cell]. A flip is heard once, when its number changes; the same hand said
// again to keep a player at the table flips nothing. Being heard is how a
// player arrives, and a base is lit for them.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    w.p[id] = player({
      c: freeOf(w, 'c'), s: freeOf(w, 's'), L: w.ph === PLAY ? joinLight(w) : START, tk: PURSE, q: input[0],
      by: -1, hs: w.n, hc: 0, wn: 0, st: 0, sk: 0,
    });
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike, and a flip is paid for out of a purse that refills at a
  // hand's pace whoever sends it.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  const q = input[0], cell = input[1];
  if (q === d.q) return;
  d.q = q;
  if (cell < 0 || !w.pv[cell] || w.lk[cell] > 0 || d.tk < REFILL) return;
  d.tk -= REFILL;
  w.pv[cell] = 3 - w.pv[cell];
  w.lk[cell] = LOCK;
  w.lb[cell] = d.c;
}

// A hand off the wire, made safe: two integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const q = raw[0], cell = raw[1];
  if (!Number.isInteger(q) || q < 0 || q > 999 || !Number.isInteger(cell) || cell < -1 || cell >= NN) return null;
  return [q, cell];
}

function leave(w, id) {
  delete w.p[id];
  for (const o of Object.values(w.p)) if (o.by === id) o.by = -1;
}

const humansIn = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The practice bot sits in whenever one person has the board to themselves,
// and stands up the moment a second one arrives, who then get a round of
// their own from the start. It lives in the table and is moved by the step,
// so every copy plays it alike and nobody's page can steer it.
function seatBot(w) {
  const humans = humansIn(w).length;
  const here = !!w.p[BOT_ID];
  if (humans === 1 && !here) {
    w.p[BOT_ID] = player({
      c: freeOf(w, 'c'), s: freeOf(w, 's'), L: START, tk: PURSE, q: BOT_THINK1, by: -1, hs: 0, hc: 0, wn: 0,
      st: 0, sk: 0,
    });
  } else if (humans !== 1 && here) {
    leave(w, BOT_ID);
    if (humans >= 2 && (w.ph === COUNT || w.ph === PLAY)) begin(w);
  }
}

// How a board looks to the bot: its beam on a rival's gem or a spark is good,
// a beam on its own gem is bad, a rival burning themselves is a small gift.
function botScore(w, pv) {
  const gemOf = new Map();
  for (const id of playersIn(w)) gemOf.set(SEATS[w.p[id].s][1], id);
  const sparkAt = new Set(w.sp.map((sp) => sp[0]));
  let score = 0;
  for (const id of bySeat(w)) {
    const cells = id === BOT_ID ? [] : null;
    const v = gemOf.get(trace(pv, SEATS[w.p[id].s][0], cells));
    if (id === BOT_ID) {
      if (v === BOT_ID) score -= 3;
      else if (v !== undefined) score += 3;
      for (const c of cells) if (sparkAt.has(c)) score += 2;
    } else if (v === BOT_ID) score -= 4;
    else if (v === id) score += 1;
  }
  return score;
}

// The bot's hand: every few steps it tries each mirror it may flip, looking
// one flip further for what that one opens up, since a gem is seldom one flip
// away; and it takes the flip that helps it most — or, now and then, one that
// helps it less.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d || w.ph !== PLAY) return;
  if (d.q > 0) { d.q -= 1; return; }
  d.q = BOT_THINK0 + Math.floor(draw01(w) * (BOT_THINK1 - BOT_THINK0));
  if (d.tk < REFILL) return;
  const now = botScore(w, w.pv);
  const good = [];
  const pv = w.pv.slice();
  for (let c = 0; c < NN; c++) {
    if (!pv[c] || w.lk[c] > 0) continue;
    pv[c] = 3 - pv[c];
    const first = botScore(w, pv);
    let next = first;
    for (let e = 0; e < NN; e++) {
      if (e === c || !pv[e] || w.lk[e] > 0) continue;
      pv[e] = 3 - pv[e];
      next = Math.max(next, botScore(w, pv));
      pv[e] = 3 - pv[e];
    }
    pv[c] = 3 - pv[c];
    const gain = 2 * (first - now) + (next - first);
    if (gain > 0) good.push([gain, c]);
  }
  if (!good.length) return;
  good.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const pick = good.length > 1 && draw01(w) < BOT_SLIP ? good[1 + Math.floor(draw01(w) * (good.length - 1))] : good[0];
  const c = pick[1];
  d.tk -= REFILL;
  w.pv[c] = 3 - w.pv[c];
  w.lk[c] = LOCK;
  w.lb[c] = d.c;
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.sp = [];
}

// A round: a new board, the seats closed up in order so nobody faces an empty
// side, everybody's light back to where it starts.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.sp = [];
  w.sg = SPARK_GAP;
  bySeat(w).forEach((id, i) => {
    const d = w.p[id];
    d.s = i;
    d.L = START;
    d.tk = PURSE;
    d.by = -1;
    d.st = 0;
    d.sk = 0;
  });
  lay(w);
  fx(w, 'round');
}

function finish(w) {
  const res = bySeat(w).map((id) => {
    const d = w.p[id];
    return [id, d.L, d.wn, d.st, d.sk];
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
  w.sp = [];
  fx(w, 'end', 0, w.win);
}

// Whoever stands alone at the top of the light, or -1: draining them pays half
// again, so a runaway leader is everybody's target.
function leaderOf(w) {
  let top = -1, best = 0, tie = false;
  for (const id of bySeat(w)) {
    const L = w.p[id].L;
    if (L > best) { best = L; top = id; tie = false; }
    else if (L === best && best > 0) tie = true;
  }
  return tie ? -1 : top;
}

// How hard a beam drains this step: harder as the round wears on, and half as
// hard again in its last stretch.
function rateOf(w) {
  const gone = PLAY_STEPS - w.pt;
  const r = RATE0 + Math.floor(((RATE1 - RATE0) * gone) / PLAY_STEPS);
  return w.pt <= SURGE ? r + (r >> 1) : r;
}

// Every lamp's beam this step, in seat order: { id, exit, cells }.
function shine(w, pv) {
  return bySeat(w).map((id) => {
    const cells = [];
    const exit = trace(pv, SEATS[w.p[id].s][0], cells);
    return { id, exit, cells };
  });
}

function sparks(w, shot) {
  for (const s of w.sp) s[1] -= 1;
  w.sp = w.sp.filter((s) => s[1] > 0);
  w.sg -= 1;
  if (w.sg > 0) return;
  w.sg = w.pt <= SURGE ? SPARK_GAP_SURGE : SPARK_GAP;
  if (w.sp.length >= SPARK_MAX) return;
  // A spark comes up on an open cell that no beam crosses right now, so it is
  // a race to bend a beam to it rather than a gift to whoever was there.
  const lit = new Set();
  for (const b of shot) for (const c of b.cells) lit.add(c);
  const open = [];
  for (let c = 0; c < NN; c++) {
    if (w.pv[c] || lit.has(c) || w.sp.some((s) => s[0] === c)) continue;
    open.push(c);
  }
  if (!open.length) return;
  const c = open[Math.floor(draw01(w) * open.length)];
  w.sp.push([c, SPARK_LIFE]);
  fx(w, 'sparknew', c);
}

function step(w) {
  seatBot(w);
  const many = playersIn(w).length;
  if (w.ph === WAIT) {
    if (many >= 2) begin(w);
  } else if (many < 2) {
    toWait(w);
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; w.sg = SPARK_GAP; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === SURGE) fx(w, 'surge');
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  botThink(w);
  // A flip is told here rather than where the hand lands: hands are heard
  // between steps, and effects are made only while the agreed board steps.
  for (let i = 0; i < NN; i++) {
    if (w.lk[i] === LOCK) fx(w, 'flip', i, w.lb[i]);
    if (w.lk[i] > 0) {
      w.lk[i] -= 1;
      if (w.lk[i] === 0) w.lb[i] = -1;
    }
  }
  const ids = bySeat(w);
  for (const id of ids) if (w.p[id].tk < PURSE) w.p[id].tk += 1;

  // Which gem every beam lands on. Each beam leaves by one slot and each slot
  // is reached by one beam at most, so every gem is drained by one beam at a
  // time — its owner's own included.
  const shot = shine(w, w.pv);
  const gemOf = new Map();
  for (const id of ids) gemOf.set(SEATS[w.p[id].s][1], id);
  const was = new Map();
  for (const id of ids) { was.set(id, w.p[id].by); w.p[id].by = -1; }
  for (const b of shot) {
    const v = gemOf.get(b.exit);
    if (v !== undefined) w.p[v].by = b.id;
  }
  for (const id of ids) {
    const by = w.p[id].by;
    if (by !== was.get(id)) fx(w, by === -1 ? 'free' : 'hit', 0, id, by);
  }
  if (w.ph !== PLAY) return;

  const rate = rateOf(w);
  const top = leaderOf(w);
  for (const b of shot) {
    const v = gemOf.get(b.exit);
    if (v === undefined) continue;
    const d = w.p[v];
    if (v === b.id) { d.L -= Math.min(d.L, rate); continue; }
    const take = Math.min(d.L, v === top ? rate + (rate >> 1) : rate);
    d.L -= take;
    w.p[b.id].L += take;
    w.p[b.id].st += take;
  }
  for (const b of shot) {
    for (const c of b.cells) {
      const k = w.sp.findIndex((s) => s[0] === c);
      if (k < 0) continue;
      w.sp.splice(k, 1);
      w.p[b.id].L += SPARK;
      w.p[b.id].sk += 1;
      fx(w, 'spark', c, b.id);
    }
  }
  sparks(w, shot);
}

// A board handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BIG = 2147483647;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  const cells = (a, lo, hi) => Array.isArray(a) && a.length === NN && a.every((v) => int(v, lo, hi));
  if (!cells(raw.pv, 0, 2) || !cells(raw.lk, 0, LOCK) || !cells(raw.lb, -1, MAX_P - 1)) return null;
  if (!Array.isArray(raw.sp) || raw.sp.length > SPARK_MAX || !int(raw.sg, -BIG, BIG)) return null;
  const sp = [];
  for (const s of raw.sp) {
    if (!Array.isArray(s) || s.length !== 2 || !int(s[0], 0, NN - 1) || !int(s[1], 1, SPARK_LIFE)) return null;
    sp.push([s[0], s[1]]);
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
    if (!int(d.L, 0, 99999999) || !int(d.tk, 0, PURSE) || !int(d.q, 0, 999) || !int(d.by, -BIG, BIG)) return null;
    if (!int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG) || !int(d.wn, 0, 99999) || !int(d.st, 0, 99999999)) return null;
    if (!int(d.sk, 0, 99999)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
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
    rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, pv: raw.pv.slice(), lk: raw.lk.slice(), lb: raw.lb.slice(),
    sp, sg: raw.sg, p, res, win: raw.win,
  };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed board steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, c, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, c: c || 0, a: a === undefined ? 0 : a, b: b === undefined ? 0 : b });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a dim violet room, a slate board of tiles inside a darker ring,
// silver mirrors, and a bright colour for each player that is their beam's,
// their lamp's, their gem's and their chip's on the scoreboard.
const INK = {
  bgIn: '#2b2560', bgOut: '#110e2a', board: '#181b3d', tile: '#21265a', tileEdge: '#2b3170', rim: '#0c0e25',
  rimLine: '#3b4180', socket: '#262b5e', text: '#ffffff', muted: '#c9cdf2', dim: '#8e94c8', gold: '#ffd166',
  danger: '#ff5a6e', panel: 'rgba(13,15,38,0.93)', silver: '#eef1ff', silverDark: '#7d86bd', base: '#343a7a',
  spark: '#fff2a8',
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a5090;' +
  `background:#22265a;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, cs = 30, ox = 0, oy = 0, TOP = 56, BOT = 26, dpx = 1;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  dpx = dpr;
  TOP = VW < 420 ? 66 : 58;
  BOT = 26;
  const aw = VW - 12, ah = Math.max(60, VH - TOP - BOT - 4);
  cs = Math.max(8, Math.min(aw, ah) / (N + 2));
  ox = (VW - cs * (N + 2)) / 2;
  oy = TOP + (ah - cs * (N + 2)) / 2;
}
layout();
window.addEventListener('resize', layout);

// Board units: cell (x, y) has its middle at (x, y); the ring runs from -1 to N.
const PX = (u) => ox + (u + 1.5) * cs + shakeX;
const PY = (v) => oy + (v + 1.5) * cs + shakeY;
function flat() { ctx.setTransform(dpx, 0, 0, dpx, 0, 0); }

function slotXY(slot) {
  const side = Math.floor(slot / N), i = slot % N;
  if (side === 0) return [i, N];
  if (side === 1) return [i, -1];
  if (side === 2) return [-1, i];
  return [N, i];
}
// Where a beam leaving by a slot crosses the board's edge.
function rimXY(slot) {
  const side = Math.floor(slot / N), i = slot % N;
  if (side === 0) return [i, N - 0.5];
  if (side === 1) return [i, -0.5];
  if (side === 2) return [-0.5, i];
  return [N - 0.5, i];
}
const cellXY = (c) => [c % N, Math.floor(c / N)];

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
  flip(cell) {
    if (!ready('flip', 50)) return;
    const f = 700 + (cell % N) * 40 + Math.floor(cell / N) * 25;
    tone(f, 0.05, 'square', 0.05, 0.6);
    hiss(0.05, 0.08, 3200, 0, 2);
  },
  far() { if (ready('far', 60)) tone(520, 0.05, 'triangle', 0.04, 0.8); },
  deny() { if (ready('deny', 120)) tone(140, 0.12, 'sawtooth', 0.05, 0.8); },
  struck() {
    if (!ready('struck', 150)) return;
    tone(420, 0.3, 'sawtooth', 0.07, 0.4);
    hiss(0.25, 0.1, 900, 0, 0.8);
  },
  strike() {
    if (!ready('strike', 150)) return;
    tone(660, 0.12, 'triangle', 0.1, 1.5);
    tone(990, 0.2, 'sine', 0.07, 1.2, 0.06);
  },
  drain() { if (ready('drain', 380)) tone(240, 0.08, 'sine', 0.06, 0.7); },
  gain() { if (ready('gain', 420)) tone(1320, 0.06, 'sine', 0.035, 1.1); },
  free() { if (ready('free', 200)) tone(500, 0.18, 'sine', 0.06, 1.6); },
  spark(mine) {
    if (!ready('spark', 90)) return;
    const v = mine ? 0.09 : 0.04;
    [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, 0.16, 'triangle', v, 0, i * 0.045));
  },
  sparknew() { if (ready('sparknew', 300)) tone(1760, 0.25, 'sine', 0.025, 1.05); },
  beep() { if (ready('beep', 200)) tone(620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(700, 0.12, 'sine', 0.12, 2.0); tone(1400, 0.25, 'sine', 0.08, 1.0, 0.12); } },
  surge() {
    if (!ready('surge', 800)) return;
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
// fast screen and a slow one see the same spray. Positions are in board units.
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
const wobble = new Array(NN).fill(0);   // a mirror shaken by a flip refused
const gemShake = new Map();             // seat slot -> how hard its gem shakes
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
    for (let i = 0; i < NN; i++) wobble[i] *= 0.88;
    for (const [s, v] of gemShake) { if (v < 0.02) gemShake.delete(s); else gemShake.set(s, v * 0.9); }
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    flash *= 0.92;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
let drawFailed = false;
const colourOf = (t, id) => (t && t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const gemXY = (t, id) => slotXY(SEATS[t.p[id].s][1]);

function play(e, t) {
  const me = myId();
  if (e.kind === 'flip') {
    const [x, y] = cellXY(e.c);
    spray(x, y, 8, SEAT[e.a] || '#ffffff', 2.2, 0.08);
    ring(x, y, SEAT[e.a] || '#ffffff', 0.5);
    if (!t.p[me] || t.p[me].c !== e.a) sound.far();
  } else if (e.kind === 'hit') {
    if (!t.p[e.a]) return;
    const [x, y] = gemXY(t, e.a);
    const self = e.a === e.b;
    spray(x, y, 16, colourOf(t, e.b), 3, 0.1);
    ring(x, y, colourOf(t, e.b), 0.7);
    gemShake.set(SEATS[t.p[e.a].s][1], 1);
    if (e.a === me) {
      shake = Math.max(shake, 7);
      flash = 1;
      flashColour = '255,90,110';
      pop(x, y - 0.6, self ? 'your own beam!' : 'under fire!', INK.danger, 15);
      sound.struck();
    } else if (e.b === me) {
      pop(x, y - 0.6, 'draining ' + nickOf(e.a), SEAT[t.p[me] ? t.p[me].c : 0], 14);
      sound.strike();
    } else if (self) {
      pop(x, y - 0.6, 'self-burn!', colourOf(t, e.a), 13);
    }
  } else if (e.kind === 'free') {
    if (e.a === me) sound.free();
  } else if (e.kind === 'spark') {
    const [x, y] = cellXY(e.c);
    const mine = e.a === me;
    spray(x, y, 22, INK.spark, 3.2, 0.1);
    spray(x, y, 10, colourOf(t, e.a), 2.4, 0.09);
    ring(x, y, INK.gold, 0.8);
    pop(x, y - 0.3, '+' + SPARK / 100 + (mine ? '' : ' ' + nickOf(e.a)), mine ? INK.gold : colourOf(t, e.a), mine ? 20 : 13);
    if (mine) shake = Math.max(shake, 3);
    sound.spark(mine);
  } else if (e.kind === 'sparknew') {
    const [x, y] = cellXY(e.c);
    ring(x, y, INK.spark, 0.6);
    sound.sparknew();
  } else if (e.kind === 'beep') {
    sound.beep();
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'surge') {
    shake = Math.max(shake, 5);
    flash = 0.8;
    flashColour = '255,209,102';
    sound.surge();
  } else if (e.kind === 'end') {
    if (t.p[me]) sound.end(e.a === me);
  }
}

// The room: a violet glow behind the board, warming toward amber in the surge.
function drawBack(t, now) {
  flat();
  const surge = t && t.ph === PLAY && t.pt <= SURGE;
  const g = ctx.createRadialGradient(VW / 2, VH * 0.48, 10, VW / 2, VH * 0.48, Math.max(VW, VH) * 0.75);
  g.addColorStop(0, surge ? '#4a2a55' : INK.bgIn);
  g.addColorStop(1, INK.bgOut);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // Faint motes drifting on the page's clock, no part of the game.
  ctx.fillStyle = 'rgba(200,190,255,0.08)';
  for (let i = 0; i < 28; i++) {
    const x = ((i * 97.13 + now * 0.004 * (1 + (i % 3))) % (VW + 40)) - 20;
    const y = (i * 61.7 + Math.sin(now / 2400 + i) * 14) % VH;
    disc(x, y, 1 + (i % 3));
    ctx.fill();
  }
}

function drawFrame() {
  flat();
  const x0 = PX(-1) - cs / 2, y0 = PY(-1) - cs / 2, size = cs * (N + 2);
  ctx.fillStyle = INK.rim;
  roundRect(x0, y0, size, size, cs * 0.45);
  ctx.fill();
  ctx.strokeStyle = INK.rimLine;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = INK.board;
  roundRect(PX(0) - cs / 2 - 2, PY(0) - cs / 2 - 2, cs * N + 4, cs * N + 4, cs * 0.18);
  ctx.fill();
  const gap = Math.max(1, cs * 0.06);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      ctx.fillStyle = (x + y) % 2 ? INK.tile : INK.tileEdge;
      roundRect(PX(x) - cs / 2 + gap, PY(y) - cs / 2 + gap, cs - 2 * gap, cs - 2 * gap, cs * 0.12);
      ctx.fill();
    }
  }
  // Empty sockets round the ring, where a beam that misses every gem fizzles.
  ctx.fillStyle = INK.socket;
  for (let s = 0; s < 4 * N; s++) {
    const [x, y] = slotXY(s);
    disc(PX(x), PY(y), cs * 0.09);
    ctx.fill();
  }
}

// A beam's corners: its lamp, every mirror it turns on, and where it ends.
function corners(pv, slot, cells, exit, ends) {
  const pts = [slotXY(slot)];
  for (const c of cells) if (pv[c]) pts.push(cellXY(c));
  pts.push(ends.has(exit) ? slotXY(exit) : rimXY(exit));
  return pts;
}

function strokePath(pts) {
  ctx.beginPath();
  ctx.moveTo(PX(pts[0][0]), PY(pts[0][1]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(PX(pts[i][0]), PY(pts[i][1]));
}

function drawBeam(pts, colour, now, strength) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokePath(pts);
  ctx.strokeStyle = alpha(colour, 0.16 * strength);
  ctx.lineWidth = cs * 0.38;
  ctx.stroke();
  ctx.strokeStyle = alpha(colour, 0.5 * strength);
  ctx.lineWidth = cs * 0.14;
  ctx.stroke();
  ctx.strokeStyle = lighter(colour, 0.6);
  ctx.globalAlpha = 0.9 * strength;
  ctx.lineWidth = Math.max(1, cs * 0.05);
  ctx.stroke();
  // Light running along it, the way it flows.
  ctx.setLineDash([cs * 0.1, cs * 0.42]);
  ctx.lineDashOffset = -(now / 1000) * cs * 2.6;
  ctx.strokeStyle = '#ffffff';
  ctx.globalAlpha = 0.7 * strength;
  ctx.lineWidth = Math.max(1.2, cs * 0.07);
  ctx.stroke();
  ctx.restore();
}

function drawGhost(pts, colour, now) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([cs * 0.16, cs * 0.16]);
  ctx.lineDashOffset = -(now / 1000) * cs;
  strokePath(pts);
  ctx.strokeStyle = alpha(colour, 0.75);
  ctx.lineWidth = Math.max(1, cs * 0.05);
  ctx.stroke();
  ctx.restore();
}

// Mirrors are drawn turning: each one's angle eases toward where its state
// says, always a quarter turn the same way, so a flip is seen as a flip.
const angle = new Array(NN).fill(0);
const aim = new Array(NN).fill(0);
const lastPv = new Array(NN).fill(-1);
const grown = new Array(NN).fill(0);
let boardRd = -1;
function settleMirrors(g) {
  const fresh = g.rd !== boardRd;
  boardRd = g.rd;
  for (let i = 0; i < NN; i++) {
    const m = g.pv[i];
    if (fresh || lastPv[i] === -1 || (lastPv[i] === 0) !== (m === 0)) {
      aim[i] = angle[i] = m === 2 ? Math.PI / 4 : -Math.PI / 4;
      if (fresh) grown[i] = 0;
    } else if (m !== lastPv[i]) {
      aim[i] += Math.PI / 2;
    }
    lastPv[i] = m;
    angle[i] += (aim[i] - angle[i]) * per60(0.3);
    grown[i] += (1 - grown[i]) * per60(0.12);
  }
}

function drawMirrors(g, now) {
  for (let i = 0; i < NN; i++) {
    if (!g.pv[i]) continue;
    const [cx, cy] = cellXY(i);
    const x = PX(cx), y = PY(cy);
    const s = ease(Math.min(1, grown[i] * 1.3 + 0.05 * ((i * 7) % 5)));
    const wob = wobble[i] ? Math.sin(now / 25) * wobble[i] * 0.25 : 0;
    ctx.fillStyle = INK.base;
    disc(x, y, cs * 0.3 * s);
    ctx.fill();
    if (g.lk[i] > 0 && g.lb[i] >= 0) {
      // Whoever flipped it last holds it for a moment: their colour, running out.
      ctx.strokeStyle = SEAT[g.lb[i]];
      ctx.lineWidth = Math.max(1.5, cs * 0.07);
      ctx.beginPath();
      ctx.arc(x, y, cs * 0.36, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * g.lk[i]) / LOCK);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle[i] + wob);
    const len = cs * 0.86 * s, th = Math.max(2, cs * 0.13);
    const grad = ctx.createLinearGradient(0, -th / 2, 0, th / 2);
    grad.addColorStop(0, INK.silver);
    grad.addColorStop(1, INK.silverDark);
    ctx.fillStyle = grad;
    roundRect(-len / 2, -th / 2, len, th, th / 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-len / 2 + th / 2, -th / 2 + 1, len - th, Math.max(1, th * 0.22));
    ctx.restore();
  }
}

function drawSparks(g, now) {
  for (const [c, life] of g.sp) {
    const [cx, cy] = cellXY(c);
    const x = PX(cx), y = PY(cy);
    const fade = life < 2 * HZ ? 0.4 + 0.6 * Math.abs(Math.sin(now / 90)) : 1;
    const r = cs * (0.2 + 0.04 * Math.sin(now / 160 + c));
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(x, y, 0, x, y, cs * 0.5);
    halo.addColorStop(0, 'rgba(255,240,160,0.55)');
    halo.addColorStop(1, 'rgba(255,240,160,0)');
    ctx.fillStyle = halo;
    disc(x, y, cs * 0.5);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(x, y);
    ctx.rotate(now / 900 + c);
    ctx.fillStyle = INK.spark;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const rr = k % 2 ? r * 0.4 : r;
      const a = (k * Math.PI) / 4;
      if (k) ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else ctx.moveTo(rr, 0);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // How long it has left, as a thin ring.
    ctx.strokeStyle = 'rgba(255,242,168,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, cs * 0.38, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * life) / SPARK_LIFE);
    ctx.stroke();
  }
}

// Which way a slot faces into the board.
function inward(slot) {
  const side = Math.floor(slot / N);
  return side === 0 ? [0, -1] : side === 1 ? [0, 1] : side === 2 ? [1, 0] : [-1, 0];
}

function drawLamp(slot, colour, now, mine) {
  const [sx, sy] = slotXY(slot);
  const x = PX(sx), y = PY(sy), [dx, dy] = inward(slot);
  const s = cs * 0.34;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.fillStyle = darker(colour, 0.55);
  roundRect(-s, -s * 0.8, s * 1.6, s * 1.6, s * 0.35);
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.lineWidth = mine ? 2 : 1.2;
  ctx.stroke();
  ctx.fillStyle = lighter(colour, 0.35);
  disc(s * 0.35, 0, s * 0.5);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  disc(s * 0.42, -s * 0.12, s * 0.16);
  ctx.fill();
  ctx.restore();
}

function drawGem(slot, colour, now, under, mine) {
  const [sx, sy] = slotXY(slot);
  const sh = gemShake.get(slot) || 0;
  const jit = under ? cs * 0.04 : 0;
  const x = PX(sx) + (Math.random() - 0.5) * (jit + sh * cs * 0.1), y = PY(sy) + (Math.random() - 0.5) * (jit + sh * cs * 0.1);
  const r = cs * (0.33 + 0.02 * Math.sin(now / 300 + slot));
  if (under) {
    // Crackling where a beam bites: short jagged sparks in the attacker's colour.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(x, y, 0, x, y, cs * 0.75);
    halo.addColorStop(0, alpha(under, 0.6));
    halo.addColorStop(1, alpha(under, 0));
    ctx.fillStyle = halo;
    disc(x, y, cs * 0.75);
    ctx.fill();
    ctx.strokeStyle = lighter(under, 0.5);
    ctx.lineWidth = 1.3;
    for (let k = 0; k < 3; k++) {
      const a = Math.random() * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6);
      ctx.lineTo(x + Math.cos(a + 0.3) * r * 1.2, y + Math.sin(a + 0.3) * r * 1.2);
      ctx.lineTo(x + Math.cos(a - 0.1) * r * 1.6, y + Math.sin(a - 0.1) * r * 1.6);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.8, -r * 0.25);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.8, -r * 0.25);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.8, -r * 0.25);
  ctx.lineTo(0, -r * 0.05);
  ctx.lineTo(-r * 0.8, -r * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.05);
  ctx.lineTo(r * 0.8, -r * 0.25);
  ctx.lineTo(0, r);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = mine ? '#ffffff' : lighter(colour, 0.5);
  ctx.lineWidth = mine ? 1.8 : 1;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.8, -r * 0.25);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.8, -r * 0.25);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawCrown(x, y, size, now) {
  const bob = Math.sin(now / 260) * size * 0.08;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.fillStyle = INK.gold;
  ctx.beginPath();
  ctx.moveTo(-size, size * 0.45);
  ctx.lineTo(-size, -size * 0.25);
  ctx.lineTo(-size * 0.5, size * 0.1);
  ctx.lineTo(0, -size * 0.55);
  ctx.lineTo(size * 0.5, size * 0.1);
  ctx.lineTo(size, -size * 0.25);
  ctx.lineTo(size, size * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Light as shown eases toward the table's, so a drain reads as a number
// running down rather than a number jumping.
const shownL = new Map();
const sampled = new Map();   // id -> [light at the last sample, when]
function lightShown(id, L) {
  let v = shownL.get(id);
  if (v === undefined || Math.abs(v - L) > 3000) v = L;
  v += (L - v) * per60(0.18);
  shownL.set(id, v);
  return Math.round(v / 100);
}

function drawBases(t, g, under, now) {
  const me = myId();
  const top = t.ph === PLAY ? leaderOf(t) : -1;
  for (const id of bySeat(g)) {
    const d = g.p[id];
    const [lampS, gemS, labelS] = SEATS[d.s];
    const colour = SEAT[d.c];
    const mine = id === me;
    if (mine) {
      // A soft halo under your own base, so it is found at a glance.
      const [ax, ay] = slotXY(lampS), [bx, by] = slotXY(gemS);
      const mx = PX((ax + bx) / 2), my = PY((ay + by) / 2);
      const pulse = 0.5 + 0.5 * Math.sin(now / 350);
      ctx.fillStyle = alpha(colour, 0.12 + 0.1 * pulse);
      const horiz = ay === by;
      roundRect(mx - (horiz ? cs : cs * 0.5), my - (horiz ? cs * 0.5 : cs), horiz ? cs * 2 : cs, horiz ? cs : cs * 2, cs * 0.3);
      ctx.fill();
    }
    drawLamp(lampS, colour, now, mine);
    drawGem(gemS, colour, now, under.get(id), mine);
    const [lx, ly] = slotXY(labelS);
    const td = t.p[id];
    if (td) {
      const L = lightShown(id, td.L);
      fitText(String(L), PX(lx), PY(ly), Math.max(9, cs * 0.42), colour, cs * 0.95, 'center', 'middle');
      if (id === top) drawCrown(PX(lx), PY(ly) - cs * 0.42, cs * 0.17, now);
    }
  }
}

function drawBits() {
  flat();
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = Math.max(1, cs * 0.06 * (1 - k));
    disc(PX(r.x), PY(r.y), cs * r.r * ease(k));
    ctx.stroke();
  }
  for (const b of bits) {
    ctx.globalAlpha = 1 - b.life / b.max;
    ctx.fillStyle = b.colour;
    const s = b.size * cs;
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
    ctx.strokeStyle = 'rgba(10,10,30,0.7)';
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
  let status = '';
  if (t.ph === WAIT) status = 'waiting for a rival';
  else if (t.p[BOT_ID]) status = 'practice vs bot · ' + (t.ph === PLAY ? clock(t.pt) : t.ph === COUNT ? 'get ready' : 'over');
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) status = 'round ' + t.rd + ' · ' + clock(t.pt) + (t.pt <= SURGE ? ' · SURGE' : '');
  else status = 'round ' + t.rd + ' · over';
  text('glint', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('glint').width;
  fitText(status, 22 + tw, 22, titlePx, t.ph === PLAY && t.pt <= SURGE ? INK.gold : INK.text, VW - tw - 90, 'left');
  text(wireNote(), VW - 50, 33, 9, INK.dim, 'right');

  // The scoreboard: a chip each, in the player's colour, with their light.
  const ids = playersIn(t).sort((a, b) => t.p[a].s - t.p[b].s);
  const top = t.ph === PLAY ? leaderOf(t) : -1;
  if (ids.length) {
    const y = narrow ? 54 : 48;
    const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
    let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
    for (const id of ids) {
      const d = t.p[id], mine = id === me;
      ctx.fillStyle = mine ? 'rgba(255,255,255,0.16)' : 'rgba(8,8,30,0.45)';
      roundRect(x, y - 13, cw, 22, 11);
      ctx.fill();
      if (mine) { ctx.strokeStyle = SEAT[d.c]; ctx.lineWidth = 1.5; ctx.stroke(); }
      if (d.by !== -1 && t.ph === PLAY) {
        // Under fire: the chip's edge flickers in the colour of the beam.
        ctx.strokeStyle = alpha(colourOf(t, d.by), 0.5 + 0.5 * Math.abs(Math.sin(now / 80)));
        ctx.lineWidth = 2;
        roundRect(x, y - 13, cw, 22, 11);
        ctx.stroke();
      }
      ctx.fillStyle = SEAT[d.c];
      ctx.beginPath();
      ctx.moveTo(x + 11, y - 10);
      ctx.lineTo(x + 16, y - 4);
      ctx.lineTo(x + 11, y + 4);
      ctx.lineTo(x + 6, y - 4);
      ctx.closePath();
      ctx.fill();
      if (id === top) drawCrown(x + 11, y - 14, 4, now);
      const score = String(Math.round((shownL.has(id) ? shownL.get(id) : d.L) / 100)) + (d.wn ? ' ★' + d.wn : '');
      ctx.font = font(13);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 9, y + 3, 13, INK.text, 'right');
      if (cw - 34 - sw > 14) fitText(mine ? 'you' : nickOf(id), x + 21, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
      x += cw + gap;
    }
  }

  const how = coarse
    ? 'tap a mirror to flip it (slide off to cancel) · bend your beam into a rival gem, keep theirs off yours'
    : 'click a mirror to flip it (hover to preview) · arrows + space work too · bend your beam into a rival gem · M mutes';
  fitText(how, VW / 2, VH - 9, 12, INK.muted, VW - 20);
}

function panel(px, py, w, h) {
  ctx.fillStyle = INK.panel;
  roundRect(px - w / 2, py - h / 2, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawOverlay(t) {
  flat();
  const big = Math.max(18, Math.min(30, VW * 0.05));
  const me = myId();
  const cx = VW / 2, cy = PY((N - 1) / 2) - big;
  if (t.ph === WAIT) {
    const w = Math.min(VW - 32, 420), py = PY((N - 1) / 2);
    panel(cx, py, w, 96);
    fitText('waiting for a rival', cx, py - 16, 18, INK.text, w - 24);
    fitText('practise: flip mirrors and watch your beam bend', cx, py + 10, 13, INK.muted, w - 24);
    fitText('a round starts the moment somebody joins', cx, py + 32, 12, INK.dim, w - 24);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(10,10,30,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, cy + big);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    const w = Math.min(VW - 24, 470);
    panel(cx, cy + big * 2.2 + 6, w, 52);
    fitText('bend your beam into a rival gem to drain its light', cx, cy + big * 2.2, 15, INK.text, w - 20);
    fitText(t.p[BOT_ID] ? 'practice against the bot · a real round starts when somebody joins'
      : 'and flip their beams off yours · the leader pays half again', cx, cy + big * 2.2 + 21, 13, INK.muted, w - 20);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('shine!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= SURGE && t.pt > SURGE - 2 * HZ) {
    const k = (SURGE - t.pt) / (2 * HZ);
    ctx.globalAlpha = 1 - k;
    text('SURGE', cx, cy, big * 1.6, INK.gold, 'center');
    fitText('every beam drains half as hard again', cx, cy + big, 15, INK.text, VW - 40);
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 24, 340), h = 104 + rows.length * 22;
    ctx.globalAlpha = k;
    const py = Math.max(TOP + h / 2 + 4, Math.min(VH - BOT - h / 2 - 4, PY((N - 1) / 2))) + (1 - k) * 30;
    panel(cx, py, w, h);
    let head, hc = INK.text;
    if (t.win !== -1) { head = t.win === me ? 'you shine brightest!' : nickOf(t.win) + ' shines brightest'; hc = colourOf(t, t.win); }
    else head = 'nobody outshone the rest';
    const y0 = py - h / 2;
    fitText(head, cx, y0 + 32, 22, hc, w - 24);
    text('light', cx + w / 2 - 22, y0 + 54, 10, INK.dim, 'right');
    text('stolen', cx + w / 2 - 70, y0 + 54, 10, INK.dim, 'right');
    rows.forEach(([id, L, won, st, sk], i) => {
      const y = y0 + 74 + i * 22;
      ctx.fillStyle = t.p[id] ? colourOf(t, id) : INK.dim;
      disc(cx - w / 2 + 22, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (won ? '  ★' + won : ''), cx - w / 2 + 34, y, 14, id === me ? INK.text : INK.muted, w - 160, 'left');
      text(String(Math.round(st / 100)) + (sk ? ' +' + sk + '✦' : ''), cx + w / 2 - 70, y, 12, INK.dim, 'right');
      text(String(Math.round(L / 100)), cx + w / 2 - 22, y, 15, INK.text, 'right');
    });
    fitText('a new board in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Every beam on a board as drawn: { id, slot, cells, exit, pts }.
function beamsOf(g, pv) {
  const ends = new Set();
  for (const id of playersIn(g)) { ends.add(SEATS[g.p[id].s][0]); ends.add(SEATS[g.p[id].s][1]); }
  return bySeat(g).map((id) => {
    const slot = SEATS[g.p[id].s][0], cells = [];
    const exit = trace(pv, slot, cells);
    return { id, slot, cells, exit, pts: corners(pv, slot, cells, exit, ends) };
  });
}

function draw(now) {
  const b = agreedAt(now);
  drawBack(b ? b.to : null, now);
  if (!b) {
    drawFrame();
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the board…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a board this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  // The board is drawn as this copy will have it a trip from now, with its own
  // flips in it; the light and the clock as the room agrees on them.
  const m = mineAt(now);
  const g = m && m.to ? m.to : t;
  settleMirrors(g);
  const me = myId();

  drawFrame();
  drawSparks(g, now);
  const beams = beamsOf(g, g.pv);
  const gemAt = new Map();
  for (const id of playersIn(g)) gemAt.set(SEATS[g.p[id].s][1], id);
  const under = new Map();
  for (const bm of beams) {
    const v = gemAt.get(bm.exit);
    if (v !== undefined) under.set(v, SEAT[g.p[bm.id].c]);
  }
  flat();
  for (const bm of beams) drawBeam(bm.pts, SEAT[g.p[bm.id].c], now, bm.id === me ? 1 : 0.85);
  // A fizzle where a beam runs into the ring and finds nothing.
  for (const bm of beams) {
    if (gemAt.has(bm.exit)) continue;
    const [rx, ry] = rimXY(bm.exit);
    ctx.fillStyle = alpha(SEAT[g.p[bm.id].c], 0.5 + 0.3 * Math.sin(now / 60 + bm.id));
    disc(PX(rx), PY(ry), cs * 0.09);
    ctx.fill();
  }

  // What a flip would do, before it is made: every beam it would move, dashed.
  const look = hoverCell();
  if (look >= 0 && g.pv[look]) {
    const pv = g.pv.slice();
    pv[look] = 3 - pv[look];
    const after = beamsOf(g, pv);
    after.forEach((a, i) => {
      if (a.exit !== beams[i].exit || a.cells.length !== beams[i].cells.length) drawGhost(a.pts, SEAT[g.p[a.id].c], now);
    });
  }
  drawMirrors(g, now);
  drawBases(t, g, under, now);
  drawCursor(g, look, now);

  // Light that moved since the last look, as a number rising off its base.
  for (const id of playersIn(t)) {
    const L = t.p[id].L, s = sampled.get(id);
    if (!s || t.ph !== PLAY) { sampled.set(id, [L, now]); continue; }
    if (now - s[1] < 650) continue;
    const dl = Math.round((L - s[0]) / 100);
    sampled.set(id, [L, now]);
    if (!dl || !t.p[id] || !g.p[id]) continue;
    const [lx, ly] = slotXY(SEATS[g.p[id].s][2]);
    pop(lx, ly - 0.2, (dl > 0 ? '+' : '') + dl, dl > 0 ? colourOf(t, id) : INK.danger, 12);
    if (id === me) { if (dl < 0) sound.drain(); else sound.gain(); }
  }
  for (const id of sampled.keys()) if (!t.p[id]) { sampled.delete(id); shownL.delete(id); }

  drawBits();
  flat();
  if (t.p[me] && t.p[me].by !== -1 && t.ph === PLAY) {
    // Your gem is being drained: the edges of the screen pulse.
    flash = Math.max(flash, 0.35 + 0.15 * Math.sin(now / 120));
    flashColour = '255,90,110';
  }
  if (flash > 0.05) {
    const gr = ctx.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.35, VW / 2, VH / 2, Math.max(VW, VH) * 0.75);
    gr.addColorStop(0, `rgba(${flashColour},0)`);
    gr.addColorStop(1, `rgba(${flashColour},${0.3 * flash})`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, VW, VH);
  }
  drawHud(t, now);
  drawOverlay(t);
}

function drawCursor(g, look, now) {
  if (look < 0) return;
  const [cx, cy] = cellXY(look);
  const x = PX(cx), y = PY(cy);
  const me = myId();
  const colour = g.p[me] ? SEAT[g.p[me].c] : '#ffffff';
  ctx.strokeStyle = g.pv[look] ? colour : 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  roundRect(x - cs / 2 + 1, y - cs / 2 + 1, cs - 2, cs - 2, cs * 0.16);
  ctx.stroke();
  // Your next flip, filling in round the cell you point at.
  const wait = Math.max(0, readyAt - performance.now());
  if (wait > 0 && g.pv[look]) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, cs * 0.44, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - wait / UI_GAP));
    ctx.stroke();
  }
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: [the number of this flip, the cell]. The number goes up
// by one with every flip, so a flip is heard once however often the hand is
// said again. A flip is checked here against the board as drawn — a mirror
// there, not held by a fresh flip, and this page's own pace kept — so a tap
// that would be refused says so at once instead of going round the room.
let seq = 0;
let readyAt = 0;
let pointerCell = -1;      // the cell under the mouse or a finger, or -1
let keyCell = -1;          // the keyboard's cursor, or -1 while the pointer leads
let touch = null;

function hoverCell() {
  if (touch || pointerCell >= 0) return pointerCell;
  return keyCell;
}

function boardNow() {
  const m = world ? mineAt(performance.now()) : null;
  return m && m.to ? m.to : world;
}

function flip(cell) {
  const g = boardNow();
  if (!g || cell < 0 || cell >= NN || !g.pv[cell]) return;
  const now = performance.now();
  if (g.lk[cell] > 0 || now < readyAt) {
    wobble[cell] = 1;
    sound.deny();
    return;
  }
  readyAt = now + UI_GAP;
  seq = (seq + 1) % 1000;
  sound.flip(cell);
  setHand([seq, cell]);
}

function cellAt(clientX, clientY) {
  const r = cv.getBoundingClientRect();
  const fx = (clientX - r.left - ox) / cs - 1, fy = (clientY - r.top - oy) / cs - 1;
  const x = Math.floor(fx), y = Math.floor(fy);
  if (x < 0 || y < 0 || x >= N || y >= N) return -1;
  return y * N + x;
}

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  wake();
  if (e.pointerType === 'touch') {
    // A finger chooses by where it lifts: slide it over the mirrors to see what
    // each would do, lift on one to flip it, off the board to change your mind.
    coarse = true;
    if (touch) return;
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    touch = { id: e.pointerId };
    pointerCell = cellAt(e.clientX, e.clientY);
    keyCell = -1;
    return;
  }
  coarse = false;
  if (e.button !== 0) return;
  keyCell = -1;
  pointerCell = cellAt(e.clientX, e.clientY);
  flip(pointerCell);
});
cv.addEventListener('pointermove', (e) => {
  if (touch && e.pointerId === touch.id) pointerCell = cellAt(e.clientX, e.clientY);
  else if (e.pointerType !== 'touch') {
    pointerCell = cellAt(e.clientX, e.clientY);
    if (pointerCell >= 0) keyCell = -1;
  }
});
function lift(e) {
  if (!touch || e.pointerId !== touch.id) return;
  const c = e.type === 'pointercancel' ? -1 : cellAt(e.clientX, e.clientY);
  touch = null;
  pointerCell = -1;
  if (c >= 0) flip(c);
}
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
cv.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') pointerCell = -1; });

// Keys are read by where they sit, not what they type, so every layout plays.
const MOVES = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  const mv = MOVES[e.code];
  if (mv) {
    e.preventDefault();
    coarse = false;
    pointerCell = -1;
    if (keyCell < 0) keyCell = MID;
    else {
      const x = Math.max(0, Math.min(N - 1, (keyCell % N) + mv[0]));
      const y = Math.max(0, Math.min(N - 1, Math.floor(keyCell / N) + mv[1]));
      keyCell = y * N + x;
    }
  } else if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (keyCell < 0) keyCell = MID;
    else flip(keyCell);
  }
});
addEventListener('blur', () => { touch = null; pointerCell = -1; });

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

// Called by the kernel once it stands. The first hand flips nothing: it is how
// a player arrives and a base is lit for them.
function start() {
  setHand([seq, -1]);
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
