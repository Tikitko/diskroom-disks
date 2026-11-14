/**
 * @disk     silk
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Spiders in a moonlit garden. Crawl from stem to stem to spin silk, and flies stick to your strands, but whoever reaches a stuck fly first eats it. Bite a rival's strand to cut it, guard your catch, and feast in the dusk swarm.
 * @tags     game, party, realtime, arcade, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/silk.png
 */
// silk.js — a garden of spiders where the room's order is the referee.
//
// Every copy holds every spider, where it stands and how fast it crawls,
// every strand of silk and whose it is, and every fly in the air or stuck in
// a web, and changes it only on what comes back round the room, so every copy
// applies the same hands in the same order and holds the same garden. Nobody
// sends where they are, what they spun or what they ate: a hand is which way
// a spider crawls and a counter that moves on by one for every bite, and
// everything else is the same arithmetic on the same whole numbers on every
// machine. A page with a console open can play its own hand however it likes,
// at its own top speed, and bite no oftener than the cooldown allows.
//
// While a player is alone, a bot plays with them. It is part of the table like
// any player, and its moves are a function of the table alone, so it plays the
// same on every copy and says nothing over the wire. When a second player
// arrives, practice runs on for three seconds under a note that says so, and
// the bot leaves before the round is laid out: it never takes part in one.
//
// Your own spider does not wait for the trip: it is drawn from the agreed
// table played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// The rules count in whole numbers only — the garden is 2400 units across, a
// speed is units a step — and use nothing but `+ - * /`, comparisons,
// `Math.floor`, `Math.trunc`, `Math.min`, `Math.max`, `Math.abs`, `Math.sqrt`
// and `Math.imul`, whose results the language fixes to the last bit. Every
// product of two coordinates and a third stays far below 2^53, where a double
// still holds a whole number exactly. Trigonometry appears only in the
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

// The whole part of a square root. `Math.sqrt` is rounded correctly by the
// language's own definition, so this is the same number on every machine.
const isqrt = (n) => (n <= 0 ? 0 : Math.floor(Math.sqrt(n)));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

// The square of how far a point stands from the segment a-b, rounded down.
function segDist2(px, py, ax, ay, bx, by) {
  const sx = bx - ax, sy = by - ay, len2 = sx * sx + sy * sy;
  const dot = (px - ax) * sx + (py - ay) * sy;
  if (len2 === 0 || dot <= 0) return dist2(px, py, ax, ay);
  if (dot >= len2) return dist2(px, py, bx, by);
  const cross = (px - ax) * sy - (py - ay) * sx;
  return Math.floor((cross * cross) / len2);
}

// Where the path p-q first crosses the segment a-b, as [numerator,
// denominator] of how far along p-q, and the point itself — or null. The
// denominator is made positive, so two crossings compare by cross-multiplying.
function crossing(px, py, qx, qy, ax, ay, bx, by) {
  const rx = qx - px, ry = qy - py, sx = bx - ax, sy = by - ay;
  let den = rx * sy - ry * sx;
  if (den === 0) return null;
  let tn = (ax - px) * sy - (ay - py) * sx;
  let un = (ax - px) * ry - (ay - py) * rx;
  if (den < 0) { den = -den; tn = -tn; un = -un; }
  if (tn < 0 || tn > den || un < 0 || un > den) return null;
  return [tn, den, ax + Math.trunc((sx * un) / den), ay + Math.trunc((sy * un) / den)];
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the garden a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own spider a trip ahead, with your hand in it

// The garden, seen from above: a bed of moss with stems standing in it. A
// spider that touches a stem ties its silk there; crawling on to another stem
// pays the silk out behind it and ties a strand between the two.
const W = 2400, H = 1800;
const NA = 15;                 // stems in a garden
const NA_MIN = 8;              // the fewest a garden may be laid with
const EDGE = 170;              // the least a stem stands from the edge
const SPACE = 380;             // the least two stems stand apart
const STEM_R = 46;             // how close a spider comes to a stem to touch it
const SR = 34;                 // a spider's radius
const RUN = 20;                // top crawling speed on bare moss
const RUN_SILK = 29;           // the same along one of your own strands
const RUN_STICKY = 11;         // the same caught on a rival's strand
const RUN_BEHIND = 3;          // more, at every speed, for whoever trails the leader
const ACC = 4;                 // how fast a speed changes, a step
const ON_SILK = 30;            // how close to a strand a spider is on it
const MAX_LEN = 1100;          // the longest line of silk a spider can pay out
const MAX_OWN = 7;             // strands one spider keeps; the oldest goes for the next
const MAX_S = 64;
const BITE_R = 74;             // how close to a strand a bite reaches
const BITE_CD = 45;            // steps between two bites that cut
const BITE_CD_BEHIND = 28;     // the same, for whoever trails the leader
const EAT_R = 62;              // how close to a stuck fly a spider comes to eat it

// Flies: they drift in from the edges and wander; one that crosses a strand
// sticks to it at the crossing until somebody eats it, the strand is cut, or
// it struggles free. A moth now and then is worth three.
const FLY_V = 9, MOTH_V = 13;
const FLY_LIFE = 24 * HZ;      // steps a fly wanders before it leaves
const MOTH_LIFE = 15 * HZ;
const HOLD = 8 * HZ;           // steps a stuck fly takes to struggle free
const HOLD_MOTH = 6 * HZ;
const FREE_COOL = 30;          // steps a fly just free passes through silk
const FLY_GAP = 18;            // steps between two flies drifting in
const MOTH_EVERY = 12 * HZ;
const MAX_F = 24;
const HANDS_PER_STEP = 4;      // past this, a sender's hands in one step are not heard
const MAX_P = 8;
const BIG = 2147483647;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const JOIN_STEPS = 3 * HZ;     // practice runs on this long after a second player arrives
const PLAY_STEPS = 90 * HZ;
const END_STEPS = 6 * HZ;
const RUSH_AT = 70 * HZ;       // steps into a round when the dusk swarm comes and every fly counts double

// The table. Plain data only: it is fingerprinted and handed over as JSON, and
// the copy a newcomer reads back must print exactly like the one it came from,
// so every player is made by one function with its fields in one order.
//   an: the stems, [x, y]; sn: the next strand's number; s: the strands, each
//   [number, stem, stem, owner], the lower stem first; fn: the next fly's
//   number; f: the flies, each [number, x, y, vx, vy, stuck, age, hold,
//   strand, moth, cool, turn]; ng, nm: steps until the next fly and the next
//   moth; res: the last round's [id, points, eaten, stolen, rounds won] rows;
//   win: its winner
function freshTable(seed) {
  const t = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, an: [], sn: 0, s: [], fn: 0, f: [], ng: 0, nm: MOTH_EVERY, p: {}, res: null, win: -1 };
  t.an = layStems(t);
  return t;
}

const FIELDS = ['c', 's', 'x', 'y', 'vx', 'vy', 'mx', 'my', 'bq', 'bb', 'cd', 'fa', 'rp', 'eat', 'stl', 'wn', 'bw', 'bt',
  'hs', 'hc'];
//   c: colour; s: seat; x, y: where it stands, in units; vx, vy: speed; mx,
//   my: the way the hand crawls, out of 1000; bq: the bite counter as last
//   heard; bb: a bite to take this step; cd: steps until a bite cuts again; fa:
//   the stem its silk is tied to, -1 for none; rp: points this round; eat,
//   stl: flies eaten and of those stolen from a rival's web; wn: rounds won;
//   bw, bt: the bot's pause and the stem it heads for; hs, hc: hands this step.
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

function newPlayer(w, bq) {
  return player({
    c: freeOf(w, 'c'), s: freeOf(w, 's'), x: W / 2, y: H / 2, vx: 0, vy: 0, mx: 0, my: 0, bq, bb: 0, cd: 0, fa: -1,
    rp: 0, eat: 0, stl: 0, wn: 0, bw: 0, bt: -1, hs: w.n, hc: 0,
  });
}

// A new garden: stems scattered over the moss, none too near the edge or each
// other. A garden too crowded to take them all is laid with fewer.
function layStems(w) {
  const an = [];
  for (let tries = 0; tries < 600 && an.length < NA; tries++) {
    const x = EDGE + pick(w, W - 2 * EDGE), y = EDGE + pick(w, H - 2 * EDGE);
    if (an.every(([ax, ay]) => dist2(ax, ay, x, y) >= SPACE * SPACE)) an.push([x, y]);
  }
  return an;
}

// A spider put down on a stem, still, its silk tied there.
function place(w, d, k) {
  d.x = w.an[k][0];
  d.y = w.an[k][1];
  d.vx = d.vy = d.bb = 0;
  d.fa = k;
  d.bt = -1;
  d.bw = 0;
}

// The stem furthest from every other spider: where a newcomer starts.
function farStem(w, id) {
  let best = 0, score = -1;
  w.an.forEach(([x, y], k) => {
    let near = BIG;
    for (const o of playersIn(w)) {
      if (o === id) continue;
      near = Math.min(near, dist2(w.p[o].x, w.p[o].y, x, y));
    }
    if (near > score) { score = near; best = k; }
  });
  return best;
}

const strandAt = (w, sid) => w.s.find((q) => q[0] === sid) || null;
const ends = (w, q) => [w.an[q[1]][0], w.an[q[1]][1], w.an[q[2]][0], w.an[q[2]][1]];

// The one leader, as every copy works it out: the most points this round, when
// somebody has some and nobody matches them. -9999 when there is none.
const NOBODY = -9999;
function leaderOf(w) {
  let top = 0, who = NOBODY, tie = false;
  for (const id of playersIn(w)) {
    const r = w.p[id].rp;
    if (r > top) { top = r; who = id; tie = false; } else if (r === top && r > 0) tie = true;
  }
  return tie ? NOBODY : who;
}
const trails = (w, id) => w.ph === PLAY && playersIn(w).some((o) => w.p[o].rp > w.p[id].rp);
const rush = (w) => w.ph === PLAY && PLAY_STEPS - w.pt >= RUSH_AT;

// A crawl off the wire is brought inside the circle of the stick, so no hand
// crawls faster on a diagonal than straight ahead. The length it is divided by
// is rounded up, so what comes out is inside the circle and never on its rim.
function steer(d, mx, my) {
  const m2 = mx * mx + my * my;
  if (m2 > 1000000) {
    const m = isqrt(m2) + 1;
    mx = Math.trunc((mx * 1000) / m);
    my = Math.trunc((my * 1000) / m);
  }
  d.mx = mx;
  d.my = my;
}

// A hand, at its place in the room's order: [the way crawled, x and y out of
// 1000; the bite counter]. A bite is asked for once, when its counter changes;
// the same hand said again to keep a player at the table asks for nothing.
// Being heard is how a player arrives: on the stem furthest from everybody.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (playersIn(w).length >= MAX_P) return;
    d = w.p[id] = newPlayer(w, input[2]);
    place(w, d, farStem(w, id));
    steer(d, input[0], input[1]);
    return;
  }
  // A flood of hands in one step is cut off where no thumb could reach, on
  // every copy alike.
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  if (d.hc > HANDS_PER_STEP) return;
  steer(d, input[0], input[1]);
  if (input[2] !== d.bq) { d.bq = input[2]; d.bb = 1; }
}

// A hand off the wire, made safe: three integers in their ranges, or nothing.
function inputOf(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [x, y, b] = raw;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(b)) return null;
  if (x < -1000 || x > 1000 || y < -1000 || y > 1000 || b < 0 || b > 999) return null;
  return [x, y, b];
}

// Somebody gone takes their web with them, and whatever it held flies off.
function leave(w, id) {
  delete w.p[id];
  for (const q of w.s.filter((q) => q[3] === id)) cut(w, q, false);
}

// A strand gone: every fly stuck to it is loose again, and passes through
// silk for a moment so it does not stick to the next one at once.
function cut(w, q, shown) {
  const i = w.s.indexOf(q);
  if (i < 0) return;
  w.s.splice(i, 1);
  for (const f of w.f) {
    if (f[5] === 1 && f[8] === q[0]) { f[5] = 0; f[7] = 0; f[8] = 0; f[10] = FREE_COOL; f[11] = 0; }
  }
  if (shown) {
    const [ax, ay, bx, by] = ends(w, q);
    fx(w, 'cut', Math.trunc((ax + bx) / 2), Math.trunc((ay + by) / 2), 0, q[3]);
  }
}

// ── the practice bot ───────────────────────────────────────────────────────
// An id no room hands out: the platform's ids are positive and a copy outside a
// room is -1. The kernel never drops an id below zero for being silent.
const BOT_ID = -100;
const BOT_EVERY = 3;           // steps between the bot's decisions
const BOT_IDLE = 0.05;         // how often it stops a moment rather than decide
const BOT_BITE = 0.2;          // how often it bites a rival strand within reach
const BOT_SMELL = 900;         // how far off it notices a stuck fly
const humans = (w) => playersIn(w).filter((id) => id !== BOT_ID);

// The bot plays while the table waits for a round, and goes the moment a
// round is laid out.
function seatBot(w) {
  const want = w.ph === WAIT && humans(w).length >= 1;
  if (want && !w.p[BOT_ID] && playersIn(w).length < MAX_P) {
    const d = (w.p[BOT_ID] = newPlayer(w, 0));
    place(w, d, farStem(w, BOT_ID));
  } else if (!want && w.p[BOT_ID]) leave(w, BOT_ID);
}

// It goes for the nearest stuck fly it can smell, its own a little before a
// rival's; with none about, it spins: from the stem its silk is tied to on to
// one in reach that it has no strand to yet. Now and then it bites a rival
// strand it is standing near, and now and then it stops to think.
function botThink(w) {
  const d = w.p[BOT_ID];
  if (!d) return;
  if (d.bw > 0) { d.bw -= 1; d.mx = d.my = 0; return; }
  if (w.n % BOT_EVERY !== 0) return;
  if (draw01(w) < BOT_IDLE) { d.bw = 6 + pick(w, 14); d.mx = d.my = 0; return; }
  if (d.cd === 0 && draw01(w) < BOT_BITE && nearestRival(w, BOT_ID, d.x, d.y, BITE_R - 10) !== null) d.bb = 1;
  let tx = -1, ty = -1, best = BOT_SMELL;
  for (const f of w.f) {
    if (f[5] !== 1) continue;
    const q = strandAt(w, f[8]);
    const far = Math.abs(f[1] - d.x) + Math.abs(f[2] - d.y) - (q && q[3] === BOT_ID ? 250 : 0);
    if (far < best) { best = far; tx = f[1]; ty = f[2]; }
  }
  if (tx < 0) {
    if (d.fa < 0) {
      // Untied: back to the nearest stem.
      let near = BIG;
      w.an.forEach(([x, y], k) => { const e = dist2(x, y, d.x, d.y); if (e < near) { near = e; d.bt = k; } });
    } else if (d.bt < 0 || d.bt === d.fa) {
      let cost = BIG;
      d.bt = -1;
      w.an.forEach(([x, y], k) => {
        if (k === d.fa) return;
        const e = isqrt(dist2(x, y, w.an[d.fa][0], w.an[d.fa][1]));
        if (e > MAX_LEN - 120) return;
        const lo = Math.min(k, d.fa), hi = Math.max(k, d.fa);
        if (w.s.some((q) => q[1] === lo && q[2] === hi && q[3] === BOT_ID)) return;
        const c = e + pick(w, 500);
        if (c < cost) { cost = c; d.bt = k; }
      });
      if (d.bt < 0) d.bt = pick(w, w.an.length);
    }
    tx = w.an[d.bt][0];
    ty = w.an[d.bt][1];
  }
  const dx = tx - d.x, dy = ty - d.y, m = isqrt(dx * dx + dy * dy);
  if (m < 8) { d.mx = d.my = 0; return; }
  steer(d, Math.trunc((dx * 1000) / m), Math.trunc((dy * 1000) / m));
}

// ── a step ─────────────────────────────────────────────────────────────────
// The seats close up in order, and each spider starts on a stem as far from
// the ones already placed as the garden has.
function lineUp(w) {
  const ids = bySeat(w);
  const taken = [];
  for (const id of ids) {
    let best = 0, score = -1;
    w.an.forEach(([x, y], k) => {
      let near = BIG;
      for (const j of taken) near = Math.min(near, dist2(w.an[j][0], w.an[j][1], x, y));
      if (!taken.length) near = BIG - dist2(x, y, 0, 0);
      if (near > score) { score = near; best = k; }
    });
    taken.push(best);
    place(w, w.p[id], best);
  }
}

function clearGarden(w) {
  w.s = [];
  w.f = [];
  w.ng = 0;
  w.nm = MOTH_EVERY;
}

function toWait(w) {
  w.ph = WAIT;
  w.pt = 0;
  w.res = null;
  w.win = -1;
  clearGarden(w);
  for (const id of playersIn(w)) { const d = w.p[id]; d.rp = d.eat = d.stl = d.cd = 0; }
  lineUp(w);
}

// A round: a fresh garden, the seats closed up in order, everybody on a stem
// of their own.
function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  w.win = -1;
  w.an = layStems(w);
  clearGarden(w);
  const ids = bySeat(w);
  ids.forEach((id, i) => { w.p[id].s = i; });
  for (const id of ids) { const d = w.p[id]; d.rp = d.eat = d.stl = d.cd = 0; }
  lineUp(w);
  fx(w, 'round', 0, 0, 0);
}

// The whistle: the round to whoever has the most points, the more flies
// stolen between two who match, and nobody if that matches too.
function finish(w) {
  const ids = bySeat(w);
  const rank = (a, b) => w.p[b].rp - w.p[a].rp || w.p[b].stl - w.p[a].stl;
  const order = ids.slice().sort((a, b) => rank(a, b) || a - b);
  const top = order[0];
  w.win = ids.length > 1 && (order.length < 2 || rank(top, order[1]) !== 0) ? top : -1;
  if (w.win !== -1) w.p[w.win].wn += 1;
  w.res = order.map((id) => [id, w.p[id].rp, w.p[id].eat, w.p[id].stl, w.p[id].wn]);
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
      if (PLAY_STEPS - w.pt === RUSH_AT) fx(w, 'rush', 0, 0, 0);
      if (w.pt <= 0) { finish(w); return; }
    } else if (w.pt <= 0) {
      begin(w);
    }
  }
  // Nobody moves while a round is counted in or its result is up.
  if (w.ph === COUNT || w.ph === END) {
    for (const id of playersIn(w)) {
      const d = w.p[id];
      d.bb = 0;
      d.vx = d.vy = 0;
    }
    return;
  }
  hunt(w);
}

function hunt(w) {
  botThink(w);
  const ids = bySeat(w);
  for (const id of ids) {
    const d = w.p[id];
    crawl(w, d, id);
    if (d.cd > 0) d.cd -= 1;
  }
  for (const id of ids) {
    const d = w.p[id];
    if (d.bb) bite(w, d, id);
    d.bb = 0;
  }
  flies(w);
  feast(w, ids);
}

// How fast a spider may crawl where it stands: fast along its own silk, slow
// caught in a rival's, and a little faster everywhere for whoever trails.
function topSpeed(w, d, id) {
  let own = false, sticky = false;
  for (const q of w.s) {
    const [ax, ay, bx, by] = ends(w, q);
    if (segDist2(d.x, d.y, ax, ay, bx, by) >= ON_SILK * ON_SILK) continue;
    if (q[3] === id) own = true; else sticky = true;
  }
  const v = sticky ? RUN_STICKY : own ? RUN_SILK : RUN;
  return v + (trails(w, id) ? RUN_BEHIND : 0);
}

const toward = (v, target) => (v < target ? Math.min(target, v + ACC) : Math.max(target, v - ACC));

// The hand's way becomes a speed, closed a little every step. Then the stems:
// touching one ties the silk there, and ties a strand to the last one if the
// silk was tied elsewhere; paying out more silk than a spider has snaps it.
function crawl(w, d, id) {
  const v = topSpeed(w, d, id);
  d.vx = toward(d.vx, Math.trunc((d.mx * v) / 1000));
  d.vy = toward(d.vy, Math.trunc((d.my * v) / 1000));
  d.x = clamp(d.x + d.vx, SR, W - SR);
  d.y = clamp(d.y + d.vy, SR, H - SR);
  let k = -1, near = STEM_R * STEM_R + 1;
  w.an.forEach(([x, y], j) => { const e = dist2(x, y, d.x, d.y); if (e < near) { near = e; k = j; } });
  if (k >= 0) {
    if (d.fa !== k) {
      if (d.fa >= 0) spin(w, d.fa, k, id);
      else fx(w, 'tie', w.an[k][0], w.an[k][1], 0, id);
      d.fa = k;
    }
  } else if (d.fa >= 0 && dist2(d.x, d.y, w.an[d.fa][0], w.an[d.fa][1]) > MAX_LEN * MAX_LEN) {
    fx(w, 'snap', d.x, d.y, 0, id);
    d.fa = -1;
  }
}

// A strand tied between two stems. One a rival already has there is spun over
// and becomes yours, with whatever it holds; past MAX_OWN, the oldest of your
// own goes to make room.
function spin(w, a, b, id) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const was = w.s.find((q) => q[1] === lo && q[2] === hi);
  const mx = Math.trunc((w.an[lo][0] + w.an[hi][0]) / 2), my = Math.trunc((w.an[lo][1] + w.an[hi][1]) / 2);
  if (was && was[3] === id) return;
  const own = w.s.filter((q) => q[3] === id);
  if (own.length >= MAX_OWN) cut(w, own[0], true);
  if (was) {
    // Spun over: it moves to the end of the line, the newest of yours.
    w.s.splice(w.s.indexOf(was), 1);
    fx(w, 'over', mx, my, 0, id, was[3]);
    was[3] = id;
    w.s.push(was);
    return;
  }
  if (w.s.length >= MAX_S) return;
  w.sn = (w.sn + 1) % 100000;
  w.s.push([w.sn, lo, hi, id]);
  fx(w, 'spin', mx, my, 0, id);
}

// The rival strand nearest a point within reach, or null. A rival's own silk
// line, still paying out, counts as a strand from its stem to its spider.
function nearestRival(w, id, x, y, reach) {
  let best = reach * reach, hit = null;
  for (const q of w.s) {
    if (q[3] === id) continue;
    const [ax, ay, bx, by] = ends(w, q);
    const e = segDist2(x, y, ax, ay, bx, by);
    if (e < best) { best = e; hit = q; }
  }
  for (const o of playersIn(w)) {
    const e_ = w.p[o];
    if (o === id || e_.fa < 0) continue;
    const e = segDist2(x, y, w.an[e_.fa][0], w.an[e_.fa][1], e_.x, e_.y);
    if (e < best) { best = e; hit = o; }
  }
  return hit;
}

// A bite cuts the nearest rival strand in reach, or snaps a rival's line as
// it pays out; a bite at nothing costs nothing. The cooldown starts only when
// something is cut.
function bite(w, d, id) {
  if (d.cd > 0) return;
  const hit = nearestRival(w, id, d.x, d.y, BITE_R);
  if (hit === null) { fx(w, 'miss', d.x, d.y, 0, id); return; }
  if (typeof hit === 'number') {
    const o = w.p[hit];
    fx(w, 'snap', o.x, o.y, 1, hit, id);
    o.fa = -1;
  } else cut(w, hit, true);
  d.cd = trails(w, id) ? BITE_CD_BEHIND : BITE_CD;
  fx(w, 'bite', d.x, d.y, 0, id);
}

// How many flies the garden holds at once: more with more spiders, and more
// again in the dusk swarm.
function flyCount(w) {
  const n = w.ph === WAIT ? 6 : clamp(3 + 2 * playersIn(w).length, 6, 16);
  return Math.min(MAX_F, n + (rush(w) ? 5 : 0));
}

// A fly drifting in from one edge, headed into the garden.
function spawn(w, moth) {
  const side = pick(w, 4), along = pick(w, 1000);
  const x = side === 0 ? 10 : side === 1 ? W - 10 : 120 + Math.trunc(((W - 240) * along) / 1000);
  const y = side === 2 ? 10 : side === 3 ? H - 10 : 120 + Math.trunc(((H - 240) * along) / 1000);
  w.fn = (w.fn + 1) % 100000;
  const f = [w.fn, x, y, 0, 0, 0, 0, 0, 0, moth ? 1 : 0, 0, 0];
  aim(w, f, W / 2 - x + pick(w, 1200) - 600, H / 2 - y + pick(w, 900) - 450);
  w.f.push(f);
}

// A fly's heading, at its own speed, the way (dx, dy) points.
function aim(w, f, dx, dy) {
  const m = isqrt(dx * dx + dy * dy), v = f[9] ? MOTH_V : FLY_V;
  if (m === 0) { f[3] = v; f[4] = 0; } else { f[3] = Math.trunc((dx * v) / m); f[4] = Math.trunc((dy * v) / m); }
  f[11] = 20 + pick(w, 45);
}

// Every fly moves: a free one wanders, turning every second or two and
// bouncing off the edges, and sticks to the first strand its path crosses; a
// stuck one struggles, and comes loose when its time is up.
function flies(w) {
  if (w.ng > 0) w.ng -= 1;
  if (w.nm > 0) w.nm -= 1;
  const plain = w.f.filter((f) => f[9] === 0).length;
  if (w.ng === 0 && plain < flyCount(w) && w.f.length < MAX_F) { spawn(w, false); w.ng = FLY_GAP; }
  if (w.nm === 0 && !w.f.some((f) => f[9] === 1) && w.f.length < MAX_F) { spawn(w, true); w.nm = MOTH_EVERY; }
  const gone = new Set();
  for (const f of w.f) {
    if (f[5] === 1) {
      f[7] -= 1;
      if (f[7] <= 0) {
        f[5] = 0; f[8] = 0; f[10] = FREE_COOL; f[11] = 0;
        fx(w, 'free', f[1], f[2], f[9]);
      }
      continue;
    }
    f[6] += 1;
    if (f[10] > 0) f[10] -= 1;
    if (f[6] > (f[9] ? MOTH_LIFE : FLY_LIFE) && (f[1] < 40 || f[1] > W - 40 || f[2] < 40 || f[2] > H - 40 || f[6] > 2 * FLY_LIFE)) {
      gone.add(f[0]);
      continue;
    }
    if (--f[11] <= 0) {
      // An old fly heads for the nearest edge; a young one anywhere.
      if (f[6] > (f[9] ? MOTH_LIFE : FLY_LIFE)) aim(w, f, f[1] < W / 2 ? -1000 : 1000, f[2] < H / 2 ? -600 : 600);
      else aim(w, f, pick(w, 2001) - 1000 + Math.trunc((W / 2 - f[1]) / 3), pick(w, 2001) - 1000 + Math.trunc((H / 2 - f[2]) / 3));
    }
    const old = f[6] > (f[9] ? MOTH_LIFE : FLY_LIFE);
    let nx = f[1] + f[3], ny = f[2] + f[4];
    if (!old) {
      if (nx < 30 || nx > W - 30) { f[3] = -f[3]; nx = clamp(nx, 30, W - 30); }
      if (ny < 30 || ny > H - 30) { f[4] = -f[4]; ny = clamp(ny, 30, H - 30); }
    } else {
      nx = clamp(nx, 0, W);
      ny = clamp(ny, 0, H);
    }
    if (f[10] === 0) {
      let hit = null;
      for (const q of w.s) {
        const [ax, ay, bx, by] = ends(w, q);
        const c = crossing(f[1], f[2], nx, ny, ax, ay, bx, by);
        if (c && (!hit || c[0] * hit[1] < hit[0] * c[1])) { hit = c; hit.q = q; }
      }
      if (hit) {
        f[1] = hit[2]; f[2] = hit[3]; f[3] = f[4] = 0;
        f[5] = 1; f[7] = f[9] ? HOLD_MOTH : HOLD; f[8] = hit.q[0];
        fx(w, 'catch', f[1], f[2], f[9], hit.q[3]);
        continue;
      }
    }
    f[1] = nx;
    f[2] = ny;
  }
  if (gone.size) w.f = w.f.filter((f) => !gone.has(f[0]));
}

// A spider that reaches a stuck fly eats it, the nearest of them first and
// the first in seat order between two as near: a point, three for a moth,
// twice that in the dusk swarm, and one more stolen out of the leader's web.
function feast(w, ids) {
  const gone = new Set();
  const lead = leaderOf(w);
  for (const f of w.f) {
    if (f[5] !== 1) continue;
    let who = null, best = EAT_R * EAT_R;
    for (const id of ids) {
      const d = w.p[id], e = dist2(d.x, d.y, f[1], f[2]);
      if (e < best) { best = e; who = id; }
    }
    if (who === null) continue;
    const q = strandAt(w, f[8]);
    const owner = q ? q[3] : who, stole = owner !== who;
    const v = (f[9] ? 3 : 1) * (rush(w) ? 2 : 1) + (stole && owner === lead ? 1 : 0);
    const d = w.p[who];
    d.rp += v;
    d.eat += 1;
    if (stole) d.stl += 1;
    gone.add(f[0]);
    fx(w, 'eat', f[1], f[2], v, who, stole ? owner : who);
  }
  if (gone.size) w.f = w.f.filter((f) => !gone.has(f[0]));
}

// A table handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !int(raw.rd, 0, BIG)) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !int(raw.pt, 0, PLAY_STEPS)) return null;
  if (!Array.isArray(raw.an) || raw.an.length < NA_MIN || raw.an.length > NA) return null;
  const an = [];
  for (const a of raw.an) {
    if (!Array.isArray(a) || a.length !== 2 || !int(a[0], EDGE, W - EDGE) || !int(a[1], EDGE, H - EDGE)) return null;
    an.push([a[0], a[1]]);
  }
  const NS = an.length;
  if (!int(raw.sn, 0, 99999) || !int(raw.fn, 0, 99999) || !int(raw.ng, 0, FLY_GAP) || !int(raw.nm, 0, MOTH_EVERY)) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_P) return null;
  const p = {};
  const colours = new Set(), seats = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!int(d.c, 0, MAX_P - 1) || colours.has(d.c) || !int(d.s, 0, MAX_P - 1) || seats.has(d.s)) return null;
    if (!int(d.x, SR, W - SR) || !int(d.y, SR, H - SR)) return null;
    const top = RUN_SILK + RUN_BEHIND;
    if (!int(d.vx, -top, top) || !int(d.vy, -top, top)) return null;
    if (!int(d.mx, -1000, 1000) || !int(d.my, -1000, 1000) || d.mx * d.mx + d.my * d.my > 1000000) return null;
    if (!int(d.bq, 0, 999) || !int(d.bb, 0, 1) || !int(d.cd, 0, BITE_CD) || !int(d.fa, -1, NS - 1)) return null;
    if (!int(d.rp, 0, 99999) || !int(d.eat, 0, 99999) || !int(d.stl, 0, 99999) || !int(d.wn, 0, 99999)) return null;
    if (!int(d.bw, 0, 99) || !int(d.bt, -1, NS - 1) || !int(d.hs, -BIG, BIG) || !int(d.hc, 0, BIG)) return null;
    colours.add(d.c);
    seats.add(d.s);
    p[id] = player(d);
  }
  if (!Array.isArray(raw.s) || raw.s.length > MAX_S) return null;
  const s = [];
  const snums = new Set(), pairs = new Set();
  for (const q of raw.s) {
    if (!Array.isArray(q) || q.length !== 4) return null;
    const [n, a, b, own] = q;
    if (!int(n, 0, 99999) || snums.has(n) || !int(a, 0, NS - 1) || !int(b, a + 1, NS - 1) || !int(own, -BIG, BIG)) return null;
    if (pairs.has(a * 100 + b)) return null;
    snums.add(n);
    pairs.add(a * 100 + b);
    s.push([n, a, b, own]);
  }
  if (!Array.isArray(raw.f) || raw.f.length > MAX_F) return null;
  const f = [];
  const fnums = new Set();
  for (const q of raw.f) {
    if (!Array.isArray(q) || q.length !== 12) return null;
    const [n, x, y, vx, vy, st, age, hold, sid, moth, cool, turn] = q;
    if (!int(n, 0, 99999) || fnums.has(n) || !int(x, 0, W) || !int(y, 0, H)) return null;
    if (!int(vx, -MOTH_V, MOTH_V) || !int(vy, -MOTH_V, MOTH_V) || !int(st, 0, 1) || !int(age, 0, 2 * FLY_LIFE + 1)) return null;
    if (!int(hold, 0, HOLD) || !int(sid, 0, 99999) || !int(moth, 0, 1) || !int(cool, 0, FREE_COOL) || !int(turn, -1, 99)) return null;
    if (st === 1 && !snums.has(sid)) return null;
    fnums.add(n);
    f.push(q.slice());
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
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, an, sn: raw.sn, s, fn: raw.fn, f, ng: raw.ng, nm: raw.nm, p, res, win: raw.win };
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
// One palette: a garden under the moon. Deep moss with dew on it, pale stems
// with a glowing bud on top, silk drawn in its spinner's colour with a silver
// sheen, fireflies for flies and a gold moth, and every spider a bright jewel
// of its own.
const INK = {
  page: '#0b1622', glow: '#1b3040', text: '#ffffff', muted: '#cfe3df', dim: '#86a3a3', gold: '#ffd166',
  mossTop: '#173a35', mossBot: '#0c231f', stem: '#d9e8c4', stemDark: '#5d7a54', bud: '#f4fbe6',
  panel: 'rgba(9,20,26,0.93)', fly: '#fff3a0', flyGlow: '#ffe55c', moth: '#ffb347',
};
const SEAT = ['#ff4f7b', '#3fa9ff', '#ffb020', '#9cff3a', '#e25cff', '#20e3ff', '#ff7a2e', '#b7a6ff'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #3d6a66;' +
  `background:#16323a;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
const NOTE_ROOM = 60;
const SIDE = 160;              // the least a column beside the garden needs for the scoreboard
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

// The whole garden is always on screen, as large as the frame lets it be. A
// frame wider than the garden puts the status, the scoreboard, your silk and
// the line of controls in the columns either side of it, so the garden takes
// the whole height. A narrower one stacks them in strips above and below it,
// with NOTE_ROOM under it for the practice note and, in a round, for your
// silk and bite — stems stand along the bottom edge too, so nothing covers
// it. Whichever of the two draws the garden bigger is the one used.
function fit() {
  const ah = Math.max(60, VH - TOP - BOT - 4 - NOTE_ROOM);
  const tall = Math.min((VW - 8) / W, ah / H), side = Math.min((VH - 12) / H, (VW - 2 * SIDE) / W);
  wide = side > tall;
  sc = Math.max(0.02, wide ? side : tall);
  ox = (VW - sc * W) / 2;
  oy = wide ? (VH - sc * H) / 2 : TOP + (ah - sc * H) / 2;
  colW = wide ? ox : 0;
  fieldTop = oy;
  fieldBot = oy + sc * H;
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
function mix(a, b, k) {
  const p = rgb(a), q = rgb(b);
  return `rgb(${Math.round(p[0] + (q[0] - p[0]) * k)},${Math.round(p[1] + (q[1] - p[1]) * k)},${Math.round(p[2] + (q[2] - p[2]) * k)})`;
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
  spin(mine) { if (ready('spin', 60)) { tone(mine ? 660 : 520, 0.25, 'triangle', mine ? 0.08 : 0.04, 1.5); tone(mine ? 990 : 780, 0.18, 'sine', 0.03, 1.2, 0.03); } },
  tie() { if (ready('tie', 80)) tone(880, 0.06, 'sine', 0.04, 1.3); },
  over(mine) { if (ready('over', 100)) { tone(mine ? 520 : 300, 0.3, 'sawtooth', 0.04, 1.6); tone(mine ? 780 : 240, 0.2, 'triangle', 0.05, 1, 0.08); } },
  snap(mine) { if (ready('snap', 80)) { puff(0.12, mine ? 0.12 : 0.05, 3200, 0, 3); tone(1200, 0.08, 'square', mine ? 0.04 : 0.015, 0.4); } },
  cut(near) { if (ready('cut', 60)) { puff(0.1, 0.03 + 0.07 * near, 3800, 0, 4); tone(1500, 0.06, 'triangle', 0.02 + 0.04 * near, 0.5); } },
  bite() { if (ready('bite', 80)) { puff(0.05, 0.08, 5200, 0, 2); tone(400, 0.05, 'square', 0.03, 0.6); } },
  miss() { if (ready('miss', 120)) tone(300, 0.05, 'sine', 0.03, 0.8); },
  caught(mine, moth) {
    if (!ready('caught', 70)) return;
    tone(moth ? 140 : 190, 0.25, 'sawtooth', mine ? 0.05 : 0.018, 1.08);
    if (mine) tone(moth ? 700 : 880, 0.12, 'triangle', 0.06, 1, 0.06);
  },
  eat(near, mine, stole) {
    if (!ready('eat', 50)) return;
    puff(0.12, 0.05 + 0.1 * near, 900, 0, 0.9);
    if (mine) (stole ? [587, 784, 1175] : [659, 880]).forEach((f, i) => tone(f, 0.1, 'triangle', 0.08, 0, 0.04 + i * 0.05));
  },
  robbed() { if (ready('robbed', 200)) [494, 392].forEach((f, i) => tone(f, 0.16, 'triangle', 0.07, 0, i * 0.1)); },
  free() { if (ready('free', 120)) tone(260, 0.18, 'sawtooth', 0.02, 1.8); },
  rush() { if (ready('rush', 400)) [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'square', 0.04, 1, i * 0.09)); },
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
// fast screen and a slow one see the same spray. Positions are garden units.
const bits = [];      // { x, y, vx, vy, g, life, max, size, colour }
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
const glints = [];    // { sid, life, max }: a shimmer running along a strand just spun
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, g) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.9);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: g || 0, life: 0, max: 18 + Math.random() * 22, size, colour });
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
    for (let i = pops.length - 1; i >= 0; i--) if (++pops[i].life >= pops[i].max) pops.splice(i, 1);
    for (let i = rings.length - 1; i >= 0; i--) if (++rings[i].life >= rings[i].max) rings.splice(i, 1);
    for (let i = glints.length - 1; i >= 0; i--) if (++glints[i].life >= glints[i].max) glints.splice(i, 1);
    shake *= 0.85;
    if (shake < 0.2) shake = 0;
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const looks = new Map();      // id -> { ang, gait, chomp, seen }
let drawFailed = false;

const colourOf = (t, id) => (t.p[id] ? SEAT[t.p[id].c] : '#dddddd');
const lookOf = (id, now) => {
  let l = looks.get(id);
  if (!l) looks.set(id, (l = { ang: Math.PI / 2, gait: 0, chomp: 0, seen: now }));
  l.seen = now;
  return l;
};

function play(e, t) {
  const me = myId();
  const md = t.p[me];
  const near = md ? Math.max(0, 1 - (Math.abs(md.x - e.x) + Math.abs(md.y - e.y)) / 1800) : 0.3;
  if (e.kind === 'spin') {
    const q = t.s.find((s) => s[3] === e.a && Math.trunc((t.an[s[1]][0] + t.an[s[2]][0]) / 2) === e.x &&
      Math.trunc((t.an[s[1]][1] + t.an[s[2]][1]) / 2) === e.y);
    if (q) glints.push({ sid: q[0], life: 0, max: 40 });
    spray(e.x, e.y, 8, mix(colourOf(t, e.a), '#ffffff', 0.5), 300, 7, 0);
    if (e.a === me) pop(e.x, e.y - 30, 'spun!', colourOf(t, e.a), 13);
    if (e.a === me || near > 0.5) sound.spin(e.a === me);
  } else if (e.kind === 'tie') {
    ring(e.x, e.y, colourOf(t, e.a), 70);
    if (e.a === me) sound.tie();
  } else if (e.kind === 'over') {
    ring(e.x, e.y, colourOf(t, e.a), 160);
    spray(e.x, e.y, 12, colourOf(t, e.a), 450, 8, 0);
    pop(e.x, e.y - 30, 'overspun!', colourOf(t, e.a), e.a === me || e.b === me ? 16 : 13);
    if (e.a === me || e.b === me) sound.over(e.a === me);
  } else if (e.kind === 'snap') {
    ring(e.x, e.y, '#ffffff', 90);
    spray(e.x, e.y, 10, '#e8f4ff', 400, 6, 0);
    if (e.a === me) { pop(e.x, e.y - 50, e.z ? 'bitten!' : 'snap!', INK.text, 15); shake = Math.max(shake, 4); }
    else if (e.b === me) pop(e.x, e.y - 50, 'snip!', colourOf(t, e.b), 15);
    sound.snap(e.a === me || e.b === me);
  } else if (e.kind === 'cut') {
    spray(e.x, e.y, 14, '#e8f4ff', 520, 6, 0);
    spray(e.x, e.y, 6, colourOf(t, e.a), 380, 8, 0);
    pop(e.x, e.y - 20, 'snip!', '#ffffff', e.a === me ? 16 : 13);
    if (e.a === me) shake = Math.max(shake, 5);
    sound.cut(e.a === me ? 1 : near);
  } else if (e.kind === 'bite') {
    const l = looks.get(e.a);
    if (l) l.chomp = 1;
    if (e.a === me) sound.bite();
  } else if (e.kind === 'miss') {
    const l = looks.get(e.a);
    if (l) l.chomp = 0.6;
    if (e.a === me) sound.miss();
  } else if (e.kind === 'catch') {
    ring(e.x, e.y, colourOf(t, e.a), e.z ? 150 : 100);
    spray(e.x, e.y, 6, e.z ? INK.moth : INK.flyGlow, 300, 6, 0);
    if (e.a === me) pop(e.x, e.y - 40, e.z ? 'moth!' : 'caught!', colourOf(t, e.a), 14);
    sound.caught(e.a === me, e.z === 1);
  } else if (e.kind === 'eat') {
    const c = colourOf(t, e.a), stole = e.a !== e.b;
    spray(e.x, e.y, 18, INK.flyGlow, 600, 9, 0);
    spray(e.x, e.y, 10, c, 450, 10, 0);
    ring(e.x, e.y, c, 140);
    pop(e.x, e.y - 30, '+' + e.z, c, e.a === me ? 20 : 15);
    if (stole) pop(e.x, e.y + 40, 'stolen!', '#ffffff', e.b === me || e.a === me ? 15 : 12);
    if (e.b === me && stole) { shake = Math.max(shake, 8); sound.robbed(); }
    else { if (e.a === me) shake = Math.max(shake, 4); sound.eat(near, e.a === me, stole); }
    const l = looks.get(e.a);
    if (l) l.chomp = 1;
  } else if (e.kind === 'free') {
    spray(e.x, e.y, 8, '#ffffff', 300, 5, 0);
    if (near > 0.6) sound.free();
  } else if (e.kind === 'rush') {
    pop(W / 2, H / 2, 'dusk swarm · flies count double!', INK.gold, 22);
    shake = Math.max(shake, 5);
    sound.rush();
  } else if (e.kind === 'beep') {
    sound.beep(false);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    sound.end(e.a === me);
  }
}

function drawBack(now) {
  flat();
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, INK.glow);
  g.addColorStop(1, INK.page);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  // Far-off fireflies drifting over the whole frame.
  for (let i = 0; i < 26; i++) {
    const x = ((i * 97.3 + Math.sin(now / 1700 + i) * 30 + now / (60 + i * 7)) % VW + VW) % VW;
    const y = ((i * 53.9 + Math.cos(now / 1300 + i * 2.1) * 20) % VH + VH) % VH;
    const a = 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(now / 400 + i * 1.7));
    ctx.fillStyle = `rgba(255,229,92,${a.toFixed(3)})`;
    disc(x, y, 1.2 + (i % 3) * 0.6);
    ctx.fill();
  }
}

// The garden: a bed of moss with tufts and dew, the moon's glow in a corner,
// and the stems standing in it. The stem your silk is tied to wears your
// colour, and a faint ring round it shows how far your silk reaches.
function drawGarden(t, now) {
  flat();
  const x0 = SX(0), y0 = SY(0), w = W * sc, h = H * sc;
  ctx.fillStyle = 'rgba(2,8,12,0.45)';
  roundRect(x0 - 3, y0 + 3, w + 10, h + 8, 12);
  ctx.fill();
  ctx.fillStyle = '#0a1a1c';
  roundRect(x0 - 5, y0 - 5, w + 10, h + 10, 12);
  ctx.fill();
  ctx.save();
  roundRect(x0, y0, w, h, 8);
  ctx.clip();
  const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
  g.addColorStop(0, INK.mossTop);
  g.addColorStop(1, INK.mossBot);
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, h);
  const moon = ctx.createRadialGradient(x0 + w * 0.85, y0 + h * 0.12, 0, x0 + w * 0.85, y0 + h * 0.12, w * 0.6);
  moon.addColorStop(0, 'rgba(200,230,255,0.13)');
  moon.addColorStop(1, 'rgba(200,230,255,0)');
  ctx.fillStyle = moon;
  ctx.fillRect(x0, y0, w, h);
  if (rush(t)) {
    ctx.fillStyle = `rgba(255,140,90,${(0.06 + 0.03 * Math.sin(now / 200)).toFixed(3)})`;
    ctx.fillRect(x0, y0, w, h);
  }
  // Tufts of moss and drops of dew, laid by their index so they hold still.
  for (let i = 0; i < 90; i++) {
    const tx = ((i * 0.6180339 + 0.13) % 1) * W, ty = ((i * 0.3819660 * 7 + 0.27) % 1) * H;
    const r = (22 + (i % 5) * 9) * sc;
    ctx.fillStyle = i % 3 ? 'rgba(80,140,100,0.13)' : 'rgba(10,30,24,0.35)';
    disc(SX(tx), SY(ty), r);
    ctx.fill();
    if (i % 4 === 0) {
      const a = 0.25 + 0.25 * Math.sin(now / 700 + i);
      ctx.fillStyle = `rgba(220,245,255,${a.toFixed(3)})`;
      disc(SX(tx + 30), SY(ty - 20), Math.max(0.8, 5 * sc));
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawStems(t, now, mine) {
  flat();
  const r = Math.max(3, 22 * sc);
  if (mine && mine.fa >= 0 && t.an[mine.fa] && t.ph !== END) {
    const [x, y] = t.an[mine.fa];
    ctx.strokeStyle = alpha(SEAT[mine.c], 0.18);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    disc(SX(x), SY(y), MAX_LEN * sc);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  t.an.forEach(([x, y], k) => {
    const sx = SX(x), sy = SY(y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    disc(sx + r * 0.25, sy + r * 0.35, r * 1.05);
    ctx.fill();
    ctx.fillStyle = INK.stemDark;
    disc(sx, sy, r);
    ctx.fill();
    const tied = mine && mine.fa === k;
    const reach = mine && mine.fa >= 0 && !tied && t.an[mine.fa] &&
      dist2(x, y, t.an[mine.fa][0], t.an[mine.fa][1]) <= MAX_LEN * MAX_LEN;
    ctx.fillStyle = tied ? SEAT[mine.c] : reach ? mix(INK.stem, '#ffffff', 0.3) : INK.stem;
    disc(sx, sy, r * 0.72);
    ctx.fill();
    const glow = 0.5 + 0.5 * Math.sin(now / 600 + k * 1.3);
    ctx.fillStyle = `rgba(244,251,230,${(0.5 + 0.4 * glow).toFixed(3)})`;
    disc(sx - r * 0.18, sy - r * 0.2, r * 0.28);
    ctx.fill();
    if (tied) {
      ctx.strokeStyle = SEAT[mine.c];
      ctx.lineWidth = 2;
      disc(sx, sy, r * (1.35 + 0.15 * Math.sin(now / 160)));
      ctx.stroke();
    }
  });
}

// A strand: silk in its spinner's colour with a silver thread down the middle,
// trembling while a fly struggles in it, and a shimmer running along it when
// it is new.
function drawStrands(t, now) {
  flat();
  const shaking = new Map();
  for (const f of t.f) if (f[5] === 1) shaking.set(f[8], f);
  const lw = Math.max(1.4, 8 * sc);
  for (const q of t.s) {
    const [ax, ay, bx, by] = ends(t, q);
    const c = colourOf(t, q[3]);
    let mx = (ax + bx) / 2, my = (ay + by) / 2;
    const f = shaking.get(q[0]);
    if (f) {
      const len = Math.max(1, Math.hypot(bx - ax, by - ay)), k = Math.sin(now / 35 + q[0]) * 10;
      mx = f[1] + (-(by - ay) / len) * k;
      my = f[2] + ((bx - ax) / len) * k;
    }
    ctx.strokeStyle = alpha(c, 0.85);
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(SX(ax), SY(ay));
    if (f) { ctx.lineTo(SX(mx), SY(my)); ctx.lineTo(SX(bx), SY(by)); } else ctx.lineTo(SX(bx), SY(by));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(240,250,255,0.55)';
    ctx.lineWidth = Math.max(0.8, lw * 0.3);
    ctx.stroke();
  }
  for (const gl of glints) {
    const q = t.s.find((s) => s[0] === gl.sid);
    if (!q) continue;
    const [ax, ay, bx, by] = ends(t, q);
    const k = ease(gl.life / gl.max);
    ctx.globalAlpha = 1 - gl.life / gl.max;
    ctx.fillStyle = '#ffffff';
    for (const s of [k, 1 - k]) {
      disc(SX(lerp(ax, bx, s)), SY(lerp(ay, by, s)), Math.max(2, 14 * sc));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// The silk a spider is paying out: a fine dashed line from its stem, which
// turns red and blinks as it runs out.
function drawLine(t, d, x, y, now) {
  if (d.fa < 0 || !t.an[d.fa] || t.ph === END) return;
  const [ax, ay] = t.an[d.fa];
  const far = Math.hypot(x - ax, y - ay);
  if (far < STEM_R) return;
  const short = far > MAX_LEN * 0.8;
  ctx.strokeStyle = short && Math.floor(now / 120) % 2 ? 'rgba(255,90,90,0.9)' : alpha(SEAT[d.c], 0.75);
  ctx.lineWidth = Math.max(1, 5 * sc);
  ctx.setLineDash([Math.max(3, 18 * sc), Math.max(2, 12 * sc)]);
  ctx.beginPath();
  ctx.moveTo(SX(ax), SY(ay));
  ctx.lineTo(SX(x), SY(y));
  ctx.stroke();
  ctx.setLineDash([]);
}

// A fly: a firefly with a glow and buzzing wings, a moth bigger and gold.
// Stuck, it is wrapped in silk and shakes, with what is left of its struggle
// as an arc in the colour of the web that holds it.
function drawFly(f, x, y, t, now) {
  const moth = f[9] === 1, sx = SX(x), sy = SY(y);
  const r = (moth ? 30 : 18) * sc;
  const stuck = f[5] === 1;
  const jit = stuck ? Math.sin(now / 25 + f[0]) * 2 : 0;
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3.2);
  glow.addColorStop(0, alpha(moth ? INK.moth : INK.flyGlow, stuck ? 0.35 : 0.5));
  glow.addColorStop(1, alpha(moth ? INK.moth : INK.flyGlow, 0));
  ctx.fillStyle = glow;
  disc(sx, sy, r * 3.2);
  ctx.fill();
  const flap = stuck ? 0.3 + 0.2 * Math.sin(now / 30 + f[0]) : 0.5 + 0.5 * Math.sin(now / (moth ? 45 : 18) + f[0]);
  const ang = stuck ? 0 : Math.atan2(f[4], f[3]);
  ctx.save();
  ctx.translate(sx + jit, sy);
  ctx.rotate(ang);
  ctx.fillStyle = moth ? 'rgba(255,200,120,0.85)' : 'rgba(230,245,255,0.7)';
  for (const k of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, k * r * (0.5 + 0.4 * flap), r * (moth ? 0.9 : 0.7), r * (moth ? 0.6 : 0.4) * (0.4 + flap), k * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (moth) {
    ctx.fillStyle = '#7a3b10';
    for (const k of [-1, 1]) { disc(-r * 0.25, k * r * (0.6 + 0.4 * flap), r * 0.18); ctx.fill(); }
  }
  ctx.fillStyle = moth ? '#5a2c0a' : '#2a3020';
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.75, r * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = moth ? INK.gold : INK.fly;
  disc(-r * 0.45, 0, r * 0.36);
  ctx.fill();
  ctx.restore();
  if (!stuck) return;
  ctx.strokeStyle = 'rgba(240,250,255,0.8)';
  ctx.lineWidth = Math.max(1, 3 * sc);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.ellipse(sx + jit, sy, r * 0.9, r * 0.5, 0.6 * i - 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }
  const q = strandAt(t, f[8]);
  const left = f[7] / (moth ? HOLD_MOTH : HOLD);
  if (q) {
    ctx.strokeStyle = colourOf(t, q[3]);
    ctx.lineWidth = Math.max(1.5, 5 * sc);
    ctx.beginPath();
    ctx.arc(sx, sy, r * 1.6 + 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.stroke();
  }
  if (left < 0.25 && Math.floor(now / 110) % 2) {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    disc(sx, sy, r * 2.1);
    ctx.stroke();
  }
}

// A spider: a round body in its seat's colour with a paler mark, a head with
// two bright eyes, and eight legs that step as it crawls; fangs that snap
// when it bites or eats, a crown on the leader, its name above it.
function drawSpider(id, sx, sy, d, colour, me, t, now) {
  const l = lookOf(id, now);
  const sp = Math.hypot(d.vx, d.vy);
  if (sp > 1.5) {
    const want = Math.atan2(d.vy, d.vx);
    let da = want - l.ang;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    l.ang += da * per60(0.3);
  }
  l.gait += frameDt * sp * 0.9;
  l.chomp *= Math.pow(0.86, frameDt * 60);
  const s = SR * sc;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(sx + s * 0.2, sy + s * 0.4, s * 1.5, s * 1.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(l.ang);
  // Legs: four a side, each a hip, a knee and a foot, stepping in turn.
  ctx.strokeStyle = mix(colour, '#000000', 0.45);
  ctx.lineWidth = Math.max(1.2, s * 0.16);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const swing = Math.sin(l.gait + i * 1.6 + (side > 0 ? Math.PI : 0)) * (sp > 1.5 ? 0.25 : 0.04);
      const a = -1.05 + i * 0.7 + swing, reach = s * 1.75;
      const hx = s * 0.1, hy = side * s * 0.3;
      const kx = hx + Math.sin(a) * reach * 0.45, ky = hy + side * (Math.cos(a) * reach * 0.45 + s * 0.35);
      const fx_ = hx + Math.sin(a) * reach, fy = hy + side * Math.cos(a) * reach * 0.85;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(kx, ky);
      ctx.lineTo(fx_, fy);
      ctx.stroke();
    }
  }
  // Body and head.
  const g = ctx.createRadialGradient(-s * 0.6, -s * 0.3, s * 0.1, -s * 0.45, 0, s * 1.1);
  g.addColorStop(0, mix(colour, '#ffffff', 0.35));
  g.addColorStop(1, mix(colour, '#000000', 0.25));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(-s * 0.45, 0, s * 0.95, s * 0.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.ellipse(-s * 0.55, 0, s * 0.35, s * 0.14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-s * 0.75, 0, s * 0.12, s * 0.32, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = mix(colour, '#000000', 0.12);
  disc(s * 0.55, 0, s * 0.5);
  ctx.fill();
  // Fangs, open as it bites.
  const open = 0.15 + l.chomp * 0.6;
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = Math.max(1, s * 0.12);
  for (const k of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * 0.95, k * s * 0.15);
    ctx.lineTo(s * 1.25, k * s * (0.15 + open * 0.5));
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  for (const k of [-1, 1]) { disc(s * 0.75, k * s * 0.2, s * 0.15); ctx.fill(); }
  ctx.fillStyle = '#0b1622';
  for (const k of [-1, 1]) { disc(s * 0.8, k * s * 0.2, s * 0.08); ctx.fill(); }
  ctx.restore();
  let top = sy - s * 1.6;
  if (leaderOf(t) === id) {
    const cs = Math.max(5, s * 0.45), cy = top - cs * 0.2;
    ctx.fillStyle = INK.gold;
    ctx.beginPath();
    ctx.moveTo(sx - cs, cy);
    ctx.lineTo(sx - cs, cy - cs * 0.9);
    ctx.lineTo(sx - cs * 0.5, cy - cs * 0.4);
    ctx.lineTo(sx, cy - cs * 1.1);
    ctx.lineTo(sx + cs * 0.5, cy - cs * 0.4);
    ctx.lineTo(sx + cs, cy - cs * 0.9);
    ctx.lineTo(sx + cs, cy);
    ctx.closePath();
    ctx.fill();
    top = cy - cs * 1.1 - 3;
  }
  const px = Math.max(9, Math.min(13, 6 + s * 0.2));
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(9,20,26,0.85)';
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
    ctx.font = font(p.px * scale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(9,20,26,0.85)';
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
    if (rush(t)) { status += ' · dusk swarm'; colour = Math.floor(now / 400) % 2 ? INK.gold : INK.text; }
  } else status = 'round ' + t.rd + ' · over';
  text('silk', 12, 22, titlePx, '#d9f0ff', 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('silk').width;
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
      const score = String(d.rp);
      ctx.font = font(12);
      const sw = ctx.measureText(score).width;
      text(score, x + cw - 8, y + 3, 12, id === lead ? INK.gold : INK.text, 'right');
      const wins = t.ph !== WAIT && d.wn ? '★' + d.wn : '';
      ctx.font = font(10);
      const ww = wins ? ctx.measureText(wins).width + 5 : 0;
      if (wins && cw > 56) text(wins, x + cw - 12 - sw, y + 2, 10, '#eef1ff', 'right');
      if (cw > 64) fitText(mine ? 'you' : nickOf(id), x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw - ww, 'left');
      if (wide) y += 22 + gap; else x += cw + gap;
    }
  }

  // The one line that says how to play: across the foot of a narrow frame, and
  // broken into lines at the foot of the right-hand column of a wide one.
  const how = coarse
    ? 'drag to crawl · touch stems to spin silk · tap to bite a rival strand · eat stuck flies'
    : 'arrows/WASD crawl · touch stems to spin silk · space, X or click bites · M mutes';
  if (!wide) { fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20); return; }
  const lines = wrap(how, 12, colW - 24);
  lines.forEach((s, i) => text(s, VW - 12, VH - 12 - (lines.length - 1 - i) * 17, 12, INK.muted, 'right'));
}

// Your silk and your bite while a round is on: in the strip under the garden,
// or halfway down the right-hand column of a wide one.
function drawMine(t) {
  const d = t.p[myId()];
  if (!d || t.ph === WAIT) return;
  flat();
  const y = wide ? VH / 2 : Math.min(fieldBot + NOTE_ROOM / 2 - 4, VH - BOT - 18);
  const mid = wide ? VW - colW / 2 : VW / 2, room_ = wide ? colW - 24 : VW - 24;
  const own = t.s.filter((q) => q[3] === myId()).length;
  const pip = 13;
  ctx.font = font(12);
  const lw = ctx.measureText('silk').width, bw = ctx.measureText('bite').width;
  const bar = 44;
  const total = lw + 8 + MAX_OWN * pip + 18 + bw + 8 + bar;
  const k = Math.min(1, room_ / total);
  let x = mid - (total * k) / 2;
  text('silk', x, y + 4, 12, INK.dim, 'left');
  x += (lw + 8 + pip / 2) * k;
  for (let i = 0; i < MAX_OWN; i++) {
    disc(x + i * pip * k, y, 4.5 * k);
    ctx.fillStyle = i < own ? SEAT[d.c] : 'rgba(255,255,255,0.1)';
    ctx.fill();
  }
  x += (MAX_OWN * pip - pip / 2 + 18) * k;
  text('bite', x, y + 4, 12, d.cd === 0 ? INK.text : INK.dim, 'left');
  x += (bw + 8) * k;
  const top = trails(t, myId()) ? BITE_CD_BEHIND : BITE_CD;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(x, y - 4, bar * k, 8, 4);
  ctx.fill();
  ctx.fillStyle = d.cd === 0 ? SEAT[d.c] : INK.dim;
  roundRect(x, y - 4, Math.max(8, bar * k * (1 - Math.min(1, d.cd / top))), 8, 4);
  ctx.fill();
  if (trails(t, myId())) fitText('behind: you crawl faster and bite sooner', mid, y + 22, 11, INK.dim, room_);
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
    const tip = two ? null : 'crawl from stem to stem to spin silk, then eat the flies it catches before the bot does';
    if (wide) practiceNote(now, VW, head, tip, [], VH - 8);
    else practiceNote(now, VW, head, tip, [[TOP, fieldTop - 4], [fieldBot + 4, VH - BOT]], Math.min(fieldBot + NOTE_ROOM, VH - BOT) - 6);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(9,20,26,0.6)';
    ctx.font = font(big * 2.6 * s);
    ctx.textAlign = 'center';
    ctx.strokeText(String(n), cx, mid + big);
    text(String(n), cx, mid + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    panel(cx, mid + big * 2.1, Math.min(VW - 32, 360), 30);
    fitText('spin silk · flies stick to it · whoever gets there first eats', cx, mid + big * 2.1 + 5, 14, INK.text, Math.min(VW - 48, 340));
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(9,20,26,0.6)';
    ctx.font = font(big * (2 + k));
    ctx.textAlign = 'center';
    ctx.strokeText('spin!', cx, mid + big * 0.5);
    text('spin!', cx, mid + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === PLAY && t.pt <= 5 * HZ) {
    const n = Math.ceil(t.pt / HZ);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(9,20,26,0.6)';
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
    if (t.win === -1) head = 'a draw · nobody came out on top';
    else head = t.win === me ? 'you feasted the most!' : nickOf(t.win) + ' feasted the most';
    const y0 = mid + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 21, t.win !== -1 && t.p[t.win] ? colourOf(t, t.win) : INK.text, w - 24);
    text('eaten', cx + w / 2 - 110, y0 + 52, 10, INK.dim, 'right');
    text('stolen', cx + w / 2 - 62, y0 + 52, 10, INK.dim, 'right');
    text('points', cx + w / 2 - 18, y0 + 52, 10, INK.dim, 'right');
    rows.forEach(([id, rp, eat, stl, wins], i) => {
      const y = y0 + 72 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      disc(cx - w / 2 + 24, y - 4, 5);
      ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (wins ? '  ★' + wins : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 190, 'left');
      text(String(eat), cx + w / 2 - 110, y, 13, '#eef1ff', 'right');
      text(String(stl), cx + w / 2 - 62, y, 13, '#eef1ff', 'right');
      text(String(rp), cx + w / 2 - 18, y, 14, INK.gold, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 12, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Where a spider is as drawn: between two steps, and never slid across a
// jump — a spider put on a stem for a new round.
function bodyAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a || Math.abs(a.x - z.x) + Math.abs(a.y - z.y) > 300) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

// Your own spider is drawn from the guess a trip ahead, which is remade on
// every tick from a table where the room may have put a hand a step away from
// where the guess had it. So the spider drawn is pulled toward the guess a
// little every frame rather than put on it, and a guess far off — a table
// taken afresh, a spider put on a stem for a new round — puts it there at
// once. Only the drawing is smoothed: the garden, and every rule in it, are
// untouched.
const PULL = 0.5;
let shown = null;        // [x, y] in units: where your spider is drawn

function settle(x, y) {
  if (!shown || Math.abs(x - shown[0]) + Math.abs(y - shown[1]) > 240) return (shown = [x, y]);
  const k = per60(PULL);
  shown[0] += (x - shown[0]) * k;
  shown[1] += (y - shown[1]) * k;
  return shown;
}

function draw(now) {
  fit();
  drawBack(now);
  const b = agreedAt(now);
  if (!b) {
    flat();
    panel(VW / 2, VH / 2, Math.min(VW - 32, 300), 60);
    text('catching up with the garden…', VW / 2, VH / 2 + 5, 15, INK.text, 'center');
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
  // Your own spider as the guess has it, while the guess has you at all.
  const m = mineAt(now);
  let mine = null, mx = 0, my = 0;
  if (t.p[me]) {
    const own = m && m.to.p[me] ? m : b;
    const p = bodyAt(own, me);
    [mx, my] = settle(p[0], p[1]);
    mine = p[2];
  } else {
    shown = null;
  }
  drawGarden(t, now);
  drawStrands(t, now);
  drawStems(t, now, mine);
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const p = bodyAt(b, id);
    drawLine(t, p[2], p[0], p[1], now);
  }
  if (mine) drawLine(t, mine, mx, my, now);
  // Flies between their two steps; a new one where it is.
  const before = new Map(b.from.f.map((q) => [q[0], q]));
  for (const q of t.f) {
    const a = before.get(q[0]);
    let x = q[1], y = q[2];
    if (a && a[5] === q[5] && Math.abs(a[1] - q[1]) + Math.abs(a[2] - q[2]) < 200) { x = lerp(a[1], q[1], b.k); y = lerp(a[2], q[2], b.k); }
    drawFly(q, x, y, t, now);
  }
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const p = bodyAt(b, id);
    drawSpider(id, SX(p[0]), SY(p[1]), p[2], SEAT[p[2].c], false, t, now);
  }
  if (mine) drawSpider(me, SX(mx), SY(my), mine, SEAT[mine.c], true, t, now);
  for (const [id, look] of looks) if (now - look.seen > 1000) looks.delete(id);
  drawBits();
  drawHud(t, now);
  drawMine(t);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: the way crawled, and how many bites so far. A change of
// way goes out no oftener than STEER_EVERY, because a thumb changes it on
// every move the screen reports and the clock's ticks share the same seat's
// ceiling on messages; a bite goes out at once.
const STEER_EVERY = 80;
let bitesAsked = 0;
let saidAt = -1e9;
let lastSaid = null;
const keys = new Set();
const LEFT = ['ArrowLeft', 'KeyA'], RIGHT = ['ArrowRight', 'KeyD'], UP = ['ArrowUp', 'KeyW'], DOWN = ['ArrowDown', 'KeyS'];
const BITE = ['Space', 'KeyX', 'KeyJ', 'KeyK', 'Enter'];

// A thumb or a mouse: a stick from wherever it lands, the crawl as steep as
// the drag is long, full at REACH; a tap bites — a drag rather than a press,
// because iOS keeps a long press inside a frame for itself. A second finger
// down while the first steers bites too, and so does a right click.
const DEAD = 10;
const REACH = 46;
let stick = null;        // { id, ox, oy, dx, dy, at, moved }

function handNow() {
  let mx = 0, my = 0;
  if (stick) {
    const far = Math.hypot(stick.dx, stick.dy);
    if (far > DEAD) {
      const k = Math.min(1, (far - DEAD) / (REACH - DEAD)) / far;
      mx = Math.round(stick.dx * k * 1000);
      my = Math.round(stick.dy * k * 1000);
    }
  }
  const kx = (RIGHT.some((c) => keys.has(c)) ? 1 : 0) - (LEFT.some((c) => keys.has(c)) ? 1 : 0);
  const ky = (DOWN.some((c) => keys.has(c)) ? 1 : 0) - (UP.some((c) => keys.has(c)) ? 1 : 0);
  if (kx || ky) {
    const k = kx && ky ? 707 : 1000;
    mx = kx * k;
    my = ky * k;
  }
  return [clamp(mx, -1000, 1000), clamp(my, -1000, 1000)];
}

function sayHand(now, force) {
  const [mx, my] = handNow();
  const h = [mx, my, bitesAsked], s = lastSaid;
  if (s && h[0] === s[0] && h[1] === s[1] && h[2] === s[2]) return;
  if (!force && s && h[2] === s[2] && now - saidAt < STEER_EVERY) return;
  lastSaid = h;
  saidAt = now;
  setHand(h);
}

// A bite: heard at once, and taken a trip later on every copy alike, if the
// table says the cooldown is over.
function biteNow() {
  wake();
  if (!world) return;
  bitesAsked = (bitesAsked + 1) % 1000;
  sayHand(performance.now(), true);
}

addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (BITE.includes(e.code)) { e.preventDefault(); if (!e.repeat) biteNow(); return; }
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
  if (e.button === 2) { biteNow(); return; }
  if (stick) { biteNow(); return; }
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
  if (tap) biteNow();
}
cv.addEventListener('pointerup', liftPointer);
cv.addEventListener('pointercancel', liftPointer);
addEventListener('pointerup', liftPointer);
addEventListener('pointercancel', liftPointer);

const stickRing = document.createElement('div');
stickRing.style.cssText =
  `position:fixed;display:none;width:${REACH * 2}px;height:${REACH * 2}px;` +
  `margin:${-REACH}px 0 0 ${-REACH}px;border-radius:50%;pointer-events:none;` +
  'border:1px solid rgba(255,255,255,0.35);background:rgba(255,255,255,0.06)';
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  'border-radius:50%;pointer-events:none;background:#ffffff;opacity:.55';
document.body.append(stickRing, knob);

function paintStick() {
  if (!stick || !coarse) { stickRing.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(stick.dx, stick.dy);
  const k = far > REACH ? REACH / far : 1;
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
// a player arrives in the garden.
function start() {
  setHand([0, 0, bitesAsked]);
  lastSaid = [0, 0, bitesAsked];
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
