/**
 * @disk     flock
 * @author   claude
 * @version  2
 * @players  2-8
 * @about    Sheepdog trials for a crowd. Run your dog to drive the flock into your pen, bark to scatter a rival's, and guard what you hold: sheep trust their own dog and flee every other. Whatever stands in your pen at the horn is your score.
 * @tags     game, party, realtime, herding, lockstep
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/flock.png
 */
// flock.js — sheepdog trials where the room's order is the referee.
//
// Every copy holds the whole meadow — every dog, every sheep — and moves it
// only on what comes back round the room, so every copy applies the same hands
// in the same order and holds the same meadow. Nobody sends where a sheep is,
// or whose pen it stands in, or a score: a hand is a direction and a bark
// counter, and everything else is the same arithmetic on the same numbers on
// every machine. A page with a console open can steer its own dog however it
// likes, at the dog's own speed, and bark no oftener than anybody else.
//
// Your own dog does not wait for the trip: it is drawn from the agreed meadow
// played forward by the trip, with your hand already in it.
//
// The kernel at the bottom is the same in every lockstep disk. What sits above
// it is the game, and its rules have to come out the same on every machine to
// the last bit: no clocks, no `Math.random`, no function a browser may round
// its own way inside a step.

// ═══════════════════ arithmetic that comes out the same everywhere ═══════════════════
// `+ - * /`, `Math.sqrt`, `Math.floor`, `Math.round`, `Math.abs`, `Math.min`,
// `Math.max` and `Math.imul` are fixed by the language to the last bit; the
// rules use nothing else. Trigonometry appears only in the drawing, which is
// nobody's business but the screen's.

// A random number every copy draws alike: the state lives in the table and
// travels with it, and only integer operations touch it.
function draw01(w) {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ═══════════════════ the game ═══════════════════
const HZ = 30;                 // steps of the meadow a second
const STEPS_PER_TICK = 2;      // steps one tick of the clock carries
const PREDICT = true;          // draw your own dog a trip ahead, with your hand in it
const DT = 1 / HZ;

const FW = 1.6, FH = 1.0;      // the meadow, in units every copy agrees on
const DOG_R = 0.03;
const SHEEP_R = 0.021;
const GOLD_R = 0.027;
const DOG_V = 0.5;             // a dog outruns a sheep, so it can get round one
const SHEEP_V = 0.38;
const GOLD_V = 0.44;
const BOOST_V = 0.74;          // a sheep just barked at
const FLEE_R = 0.25, FLEE_A = 3.0;
const SEP_R = 0.055, SEP_A = 3.2;
const FLOCK_R = 0.2, COH_A = 1.1, ALI_A = 1.4;
const DAMP = 0.93;
const BARK_CD = Math.round(3.5 * HZ);   // steps between two barks of one dog
const BARK_R = 0.3;
const SHOVE_R = 0.19;          // how near a rival dog has to stand to be shoved by a bark
const HANDS_PER_STEP = 8;      // past this, a sender's hand in one step steers but cannot bark or seat
const MAX_DOGS = 8;
const MAX_SHEEP = 40;

const WAIT = 0, COUNT = 1, PLAY = 2, END = 3;
const COUNT_STEPS = 3 * HZ;
const PLAY_STEPS = 75 * HZ;
const END_STEPS = 7 * HZ;
const GOLD_AT = 25 * HZ;       // steps left in a round when the golden ram walks in

// The pens: a quarter of a disc in a corner, half of one on an edge, all of the
// same area. Filled in this order, so two players stand in opposite corners.
const CR = 0.2, ER = CR / Math.sqrt(2);
const PENS = [
  [0, 0, CR], [FW, FH, CR], [FW, 0, CR], [0, FH, CR],
  [FW / 2, 0, ER], [FW / 2, FH, ER], [0, FH / 2, ER], [FW, FH / 2, ER],
];
// The point inside a pen its sheep drift to when nothing frightens them.
const HEART = PENS.map(([ax, ay, r]) => {
  const dx = FW / 2 - ax, dy = FH / 2 - ay, d = Math.sqrt(dx * dx + dy * dy);
  return [ax + (dx / d) * r * 0.5, ay + (dy / d) * r * 0.5];
});

function penAt(x, y) {
  for (let k = 0; k < PENS.length; k++) {
    const [ax, ay, r] = PENS[k];
    const dx = x - ax, dy = y - ay;
    if (dx * dx + dy * dy < r * r) return k;
  }
  return -1;
}

// The meadow. Plain data only: it is fingerprinted and handed over as JSON.
//   p:  player id -> a dog { x, y, dx, dy, k: pen, bs: bark counter as last
//       heard, lb: step of the last bark, bq: a bark to make this step,
//       sx, sy: a shove from somebody's bark, hs/hc: hands heard this step,
//       w: rounds won }
//   s:  sheep, each [x, y, vx, vy, gold, boost steps, the pen it stands in]
function freshTable(seed) {
  const w = { rng: seed | 0, ph: WAIT, pt: 0, rd: 0, p: {}, s: [], res: null };
  scatter(w, 14);
  return w;
}

function scatter(w, count) {
  w.s = [];
  for (let i = 0; i < count; i++) {
    const x = FW / 2 + (draw01(w) - 0.5) * 0.5;
    const y = FH / 2 + (draw01(w) - 0.5) * 0.36;
    w.s.push([x, y, 0, 0, 0, 0, -1]);
  }
}

const playersIn = (w) => Object.keys(w.p).map(Number);

function freePen(w) {
  const taken = new Set(Object.values(w.p).map((d) => d.k));
  for (let k = 0; k < PENS.length; k++) if (!taken.has(k)) return k;
  return -1;
}

function owners(w) {
  const own = new Array(PENS.length).fill(null);
  for (const id of Object.keys(w.p)) if (w.p[id].k >= 0) own[w.p[id].k] = Number(id);
  return own;
}

// What every pen holds right now, a golden ram counting three.
function tally(w) {
  const per = new Array(PENS.length).fill(0);
  for (const s of w.s) if (s[6] >= 0) per[s[6]] += s[4] ? 3 : 1;
  return per;
}

// A hand, at its place in the room's order: [dx, dy, barks] — a direction in
// thousandths and a counter that moves on by one for every bark. Being heard is
// how a dog arrives, just inside its own pen.
function hand(w, id, input) {
  let d = w.p[id];
  if (!d) {
    if (Object.keys(w.p).length >= MAX_DOGS) return;
    const k = freePen(w);
    const [hx, hy] = k >= 0 ? HEART[k] : [FW / 2, FH / 2];
    d = w.p[id] = { x: hx, y: hy, dx: 0, dy: 0, k, bs: input[2], lb: -BARK_CD, bq: 0, sx: 0, sy: 0, hs: w.n, hc: 0, w: 0 };
  }
  if (d.hs !== w.n) { d.hs = w.n; d.hc = 0; }
  d.hc += 1;
  d.dx = input[0];
  d.dy = input[1];
  if (input[2] !== d.bs) {
    d.bs = input[2];
    // A bark is a request; whether it happens is the meadow's cooldown, the
    // same on every copy, and a flood of hands in one step buys none.
    if (d.hc <= HANDS_PER_STEP && w.n - d.lb >= BARK_CD) { d.lb = w.n; d.bq = 1; }
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

function begin(w) {
  w.ph = COUNT;
  w.pt = COUNT_STEPS;
  w.rd += 1;
  w.res = null;
  scatter(w, Math.min(MAX_SHEEP - 1, 12 + 2 * playersIn(w).length));
  fx(w, 'round');
}

function finish(w) {
  const per = tally(w);
  const res = [];
  for (const id of playersIn(w)) {
    const k = w.p[id].k;
    res.push([id, k >= 0 ? per[k] : 0]);
  }
  res.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const top = res.length ? res[0][1] : 0;
  if (top > 0) for (const [id, sc] of res) if (sc === top) w.p[id].w += 1;
  w.res = res;
  w.ph = END;
  w.pt = END_STEPS;
  fx(w, 'end', 0, 0, top > 0 ? res.filter((r) => r[1] === top).length : 0);
}

// The golden ram walks in on the far side from whoever leads, so the one in
// front has the longest way to it.
function bringGold(w) {
  const own = owners(w), per = tally(w);
  let best = -1, lead = -1;
  for (let k = 0; k < PENS.length; k++) if (own[k] !== null && per[k] > best) { best = per[k]; lead = k; }
  let x = FW / 2, y = FH / 2;
  if (lead >= 0 && best > 0) {
    x = (FW - PENS[lead][0]) * 0.55 + FW / 2 * 0.45;
    y = (FH - PENS[lead][1]) * 0.55 + FH / 2 * 0.45;
  }
  w.s.push([x, y, 0, 0, 1, 0, -1]);
  fx(w, 'gold', x, y);
}

// One step of the meadow: a function of the meadow alone.
function step(w) {
  const many = playersIn(w).length;
  if (w.ph === WAIT) {
    if (many >= 2) begin(w);
  } else if (many < 2) {
    w.ph = WAIT;
    w.pt = 0;
  } else {
    w.pt -= 1;
    if (w.ph === COUNT) {
      if (w.pt > 0 && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) { w.ph = PLAY; w.pt = PLAY_STEPS; fx(w, 'go'); }
    } else if (w.ph === PLAY) {
      if (w.pt === GOLD_AT) bringGold(w);
      if (w.pt > 0 && w.pt <= 10 * HZ && w.pt % HZ === 0) fx(w, 'beep', 0, 0, w.pt / HZ);
      if (w.pt <= 0) finish(w);
    } else if (w.pt <= 0) {
      begin(w);
    }
  }

  const ids = playersIn(w);
  const dogs = ids.map((id) => w.p[id]);

  // Dogs run where their hands point, at one speed, and a shove fades.
  for (const d of dogs) {
    const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy);
    let vx = d.sx, vy = d.sy;
    if (len > 60) { vx += (d.dx / len) * DOG_V; vy += (d.dy / len) * DOG_V; }
    d.x = Math.max(DOG_R, Math.min(FW - DOG_R, d.x + vx * DT));
    d.y = Math.max(DOG_R, Math.min(FH - DOG_R, d.y + vy * DT));
    d.sx *= 0.84; d.sy *= 0.84;
    if (Math.abs(d.sx) < 0.002) d.sx = 0;
    if (Math.abs(d.sy) < 0.002) d.sy = 0;
  }
  // Dogs are solid to each other: a dog standing in its pen's mouth is a gate.
  for (let i = 0; i < dogs.length; i++) for (let j = i + 1; j < dogs.length; j++) {
    const a = dogs[i], b = dogs[j];
    const dx = b.x - a.x, dy = b.y - a.y, dd = dx * dx + dy * dy;
    if (dd >= 4 * DOG_R * DOG_R) continue;
    // Two dogs on one spot are parted along the meadow's width.
    const dist = dd < 1e-12 ? 0 : Math.sqrt(dd);
    const nx = dist ? dx / dist : 1, ny = dist ? dy / dist : 0, push = (2 * DOG_R - dist) / 2;
    a.x = Math.max(DOG_R, Math.min(FW - DOG_R, a.x - nx * push));
    a.y = Math.max(DOG_R, Math.min(FH - DOG_R, a.y - ny * push));
    b.x = Math.max(DOG_R, Math.min(FW - DOG_R, b.x + nx * push));
    b.y = Math.max(DOG_R, Math.min(FH - DOG_R, b.y + ny * push));
  }

  const own = owners(w);
  const sheep = w.s;

  // Barks: every sheep near enough bolts away, but those standing in the
  // barker's own pen; a rival dog near enough is shoved off its spot.
  for (let i = 0; i < dogs.length; i++) {
    const d = dogs[i];
    if (!d.bq) continue;
    d.bq = 0;
    fx(w, 'bark', d.x, d.y, ids[i]);
    for (const s of sheep) {
      if (s[6] >= 0 && own[s[6]] === ids[i]) continue;
      const dx = s[0] - d.x, dy = s[1] - d.y, dd = dx * dx + dy * dy;
      if (dd >= BARK_R * BARK_R) continue;
      const dist = Math.sqrt(dd) || 1e-6, f = 0.5 + 0.6 * (1 - dist / BARK_R);
      s[2] += (dx / dist) * f;
      s[3] += (dy / dist) * f;
      s[5] = 24;
    }
    for (let j = 0; j < dogs.length; j++) {
      if (j === i) continue;
      const o = dogs[j];
      const dx = o.x - d.x, dy = o.y - d.y, dd = dx * dx + dy * dy;
      if (dd >= SHOVE_R * SHOVE_R) continue;
      const dist = Math.sqrt(dd) || 1e-6, f = 1.3 * (1 - dist / SHOVE_R);
      o.sx += (dx / dist) * f;
      o.sy += (dy / dist) * f;
      fx(w, 'shoved', o.x, o.y, ids[j]);
    }
  }

  // The sheep. Forces first, for all of them against the same positions, then
  // the moves, so no sheep's order in the list changes what it does.
  const acc = [];
  for (let i = 0; i < sheep.length; i++) {
    const s = sheep[i];
    let ax = 0, ay = 0, scared = false;
    const pen = s[6], home = pen >= 0 ? own[pen] : null;
    for (let j = 0; j < dogs.length; j++) {
      // A sheep in a pen trusts the dog that pen belongs to.
      if (home !== null && home === ids[j]) continue;
      const d = dogs[j];
      const dx = s[0] - d.x, dy = s[1] - d.y, dd = dx * dx + dy * dy;
      const reach = s[4] ? FLEE_R * 1.2 : FLEE_R;
      if (dd >= reach * reach) continue;
      const dist = Math.sqrt(dd) || 1e-6, f = 1 - dist / reach;
      ax += (dx / dist) * f * FLEE_A;
      ay += (dy / dist) * f * FLEE_A;
      scared = true;
    }
    let cx = 0, cy = 0, vx = 0, vy = 0, near = 0;
    for (let j = 0; j < sheep.length; j++) {
      if (j === i) continue;
      const o = sheep[j];
      const dx = s[0] - o[0], dy = s[1] - o[1], dd = dx * dx + dy * dy;
      if (dd >= FLOCK_R * FLOCK_R) continue;
      if (dd < SEP_R * SEP_R) {
        const dist = Math.sqrt(dd) || 1e-6, f = 1 - dist / SEP_R;
        ax += (dx / dist) * f * SEP_A;
        ay += (dy / dist) * f * SEP_A;
      }
      cx += o[0]; cy += o[1]; vx += o[2]; vy += o[3]; near += 1;
    }
    if (near) {
      ax += (cx / near - s[0]) * COH_A + (vx / near - s[2]) * ALI_A * (scared ? 1 : 0.4);
      ay += (cy / near - s[1]) * COH_A + (vy / near - s[3]) * ALI_A * (scared ? 1 : 0.4);
    }
    if (home !== null && !scared) {
      const [hx, hy] = HEART[pen];
      ax += (hx - s[0]) * 1.2;
      ay += (hy - s[1]) * 1.2;
    }
    if (!scared && s[5] === 0 && draw01(w) < 0.02) {
      ax += (draw01(w) - 0.5) * 7;
      ay += (draw01(w) - 0.5) * 7;
    }
    acc.push([ax, ay, home !== null && !scared]);
  }
  for (let i = 0; i < sheep.length; i++) {
    const s = sheep[i], [ax, ay, settled] = acc[i];
    const r = s[4] ? GOLD_R : SHEEP_R;
    s[2] = (s[2] + ax * DT) * (settled ? 0.86 : DAMP);
    s[3] = (s[3] + ay * DT) * (settled ? 0.86 : DAMP);
    const top = s[5] > 0 ? BOOST_V : s[4] ? GOLD_V : SHEEP_V;
    const v = Math.sqrt(s[2] * s[2] + s[3] * s[3]);
    if (v > top) { s[2] = (s[2] / v) * top; s[3] = (s[3] / v) * top; }
    if (s[5] > 0) s[5] -= 1;
    s[0] += s[2] * DT;
    s[1] += s[3] * DT;
    // No sheep stands inside a dog.
    for (const d of dogs) {
      const dx = s[0] - d.x, dy = s[1] - d.y, dd = dx * dx + dy * dy, m = DOG_R + r;
      if (dd >= m * m) continue;
      const dist = Math.sqrt(dd) || 1e-6;
      s[0] = d.x + (dx / dist) * m;
      s[1] = d.y + (dy / dist) * m;
    }
    if (s[0] < r) { s[0] = r; s[2] = 0; } else if (s[0] > FW - r) { s[0] = FW - r; s[2] = 0; }
    if (s[1] < r) { s[1] = r; s[3] = 0; } else if (s[1] > FH - r) { s[1] = FH - r; s[3] = 0; }
    let k = penAt(s[0], s[1]);
    // A sheep leaves a pen a little past its fence, so one grazing on the line
    // does not count in and out on every step.
    if (k === -1 && s[6] >= 0) {
      const [ax, ay, pr] = PENS[s[6]], ex = s[0] - ax, ey = s[1] - ay;
      if (ex * ex + ey * ey < pr * pr * 1.12) k = s[6];
    }
    if (k !== s[6]) {
      if (s[6] >= 0 && own[s[6]] !== null) fx(w, 'out', s[0], s[1], s[6], s[4]);
      if (k >= 0 && own[k] !== null) fx(w, 'in', s[0], s[1], k, s[4]);
      s[6] = k;
    }
  }
}

// A meadow handed over by somebody else is their claim, and is read as one:
// every field of the shape it must have, in its range, and nothing else.
const isId = (k) => /^-?\d{1,12}$/.test(k);
const num = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

function tableOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.rng) || !Number.isInteger(raw.rd) || raw.rd < 0) return null;
  if (![WAIT, COUNT, PLAY, END].includes(raw.ph) || !Number.isInteger(raw.pt) || raw.pt < 0 || raw.pt > PLAY_STEPS) return null;
  if (!raw.p || typeof raw.p !== 'object' || Array.isArray(raw.p)) return null;
  const ids = Object.keys(raw.p);
  if (ids.length > MAX_DOGS) return null;
  const p = {};
  const pens = new Set();
  for (const id of ids) {
    const d = raw.p[id];
    if (!isId(id) || !d || typeof d !== 'object') return null;
    if (!num(d.x, 0, FW) || !num(d.y, 0, FH) || !num(d.sx, -20, 20) || !num(d.sy, -20, 20)) return null;
    if (inputOf([d.dx, d.dy, d.bs]) === null) return null;
    if (!Number.isInteger(d.k) || d.k < -1 || d.k >= PENS.length || (d.k >= 0 && pens.has(d.k))) return null;
    pens.add(d.k);
    for (const key of ['lb', 'hs', 'hc', 'w']) if (!Number.isInteger(d[key])) return null;
    if (d.bq !== 0 && d.bq !== 1) return null;
    p[id] = { x: d.x, y: d.y, dx: d.dx, dy: d.dy, k: d.k, bs: d.bs, lb: d.lb, bq: d.bq, sx: d.sx, sy: d.sy, hs: d.hs, hc: d.hc, w: d.w };
  }
  if (!Array.isArray(raw.s) || raw.s.length > MAX_SHEEP) return null;
  const s = [];
  for (const v of raw.s) {
    if (!Array.isArray(v) || v.length !== 7) return null;
    if (!num(v[0], 0, FW) || !num(v[1], 0, FH) || !num(v[2], -3, 3) || !num(v[3], -3, 3)) return null;
    if ((v[4] !== 0 && v[4] !== 1) || !Number.isInteger(v[5]) || v[5] < 0 || v[5] > 24) return null;
    if (!Number.isInteger(v[6]) || v[6] < -1 || v[6] >= PENS.length) return null;
    s.push(v.slice());
  }
  let res = null;
  if (raw.res !== null) {
    if (!Array.isArray(raw.res) || raw.res.length > MAX_DOGS) return null;
    res = [];
    for (const r of raw.res) {
      if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || !Number.isInteger(r[1])) return null;
      res.push([r[0], r[1]]);
    }
  }
  return { rng: raw.rng, ph: raw.ph, pt: raw.pt, rd: raw.rd, p, s, res };
}

// ── effects ────────────────────────────────────────────────────────────────
// Made only while the agreed meadow steps, and kept with the step that made
// them until the drawing gets there: a guess replayed ten times makes none.
const fxq = [];
function fx(w, kind, x, y, a, b) {
  if (!live) return;
  fxq.push({ n: w.n, kind, x: x || 0, y: y || 0, a: a || 0, b: b || 0 });
  if (fxq.length > 300) fxq.splice(0, fxq.length - 300);
}

// ═══════════════════ the screen ═══════════════════
// One palette: a meadow, cream sheep, warm fences, and a colour for each pen
// that is also the colour of the dog that owns it.
const INK = {
  page: '#1d2b1a', grass: '#4f8a3a', stripe: '#4a8336', edge: '#3c6c2e',
  wool: '#f4efe2', woolShade: '#d9d1bf', face: '#33302c', gold: '#ffcc4d', goldShade: '#d9a62e',
  fence: '#9a7650', fenceDark: '#6e5236', text: '#f6f3ea', muted: '#b9c4ad', dim: '#8ea283',
  panel: 'rgba(22,33,19,0.88)', danger: '#ff7a6b',
};
const SEAT = ['#ff8a4c', '#4cb8ff', '#ffd84c', '#c77dff', '#ff5fa2', '#3ee0c6', '#ff4f4f', '#8f9bff'];
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
  'position:fixed;right:8px;top:8px;width:34px;height:30px;border-radius:8px;border:1px solid #4a5f40;' +
  `background:#26381f;color:${INK.text};font:600 14px system-ui,sans-serif;cursor:pointer;padding:0;z-index:2`;
muteBtn.textContent = '♪';
muteBtn.title = 'sound on/off (M)';
document.body.appendChild(muteBtn);

let coarse = matchMedia('(pointer: coarse)').matches;
let VW = 640, VH = 400, sc = 1, ox = 0, oy = 0, rot = false, TOP = 56, BOT = 28;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  VW = cv.clientWidth || 640;
  VH = cv.clientHeight || 400;
  cv.width = Math.round(VW * dpr);
  cv.height = Math.round(VH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  TOP = VW < 420 ? 64 : 56;
  BOT = 28;
  const aw = VW - 16, ah = VH - TOP - BOT;
  // A tall screen gets the meadow turned on its side, so a phone held upright
  // sees it large rather than as a strip.
  rot = ah > aw * 1.15;
  const fw = rot ? FH : FW, fh = rot ? FW : FH;
  sc = Math.max(10, Math.min(aw / fw, ah / fh));
  ox = (VW - fw * sc) / 2;
  oy = TOP + (ah - fh * sc) / 2;
  dpx = dpr;
}
let dpx = 1;
layout();
window.addEventListener('resize', layout);

// The meadow to the screen and back. Turned, the meadow's width runs down the
// screen.
const SX = (x, y) => (rot ? ox + (FH - y) * sc : ox + x * sc);
const SY = (x, y) => (rot ? oy + x * sc : oy + y * sc);
function toField(sx, sy) { return rot ? [sy, -sx] : [sx, sy]; }
function inField() {
  ctx.setTransform(dpx, 0, 0, dpx, 0, 0);
  ctx.translate(ox + shakeX, oy + shakeY);
  ctx.scale(sc, sc);
  if (rot) { ctx.translate(FH, 0); ctx.rotate(Math.PI / 2); }
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
  text(s, x, y, wd > most ? Math.max(8, px * most / wd) : px, colour, align);
}

// Easing per frame, scaled to the frame's length so a fast screen and a slow
// one settle at the same pace.
let frameDt = 1 / 60, lastFrame = 0;
const per60 = (k) => 1 - Math.pow(1 - k, frameDt * 60);
const ease = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
const lerp = (a, b, k) => a + (b - a) * k;
function angleTo(cur, want, k) {
  let d = want - cur;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return cur + d * k;
}

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
function puff(dur, vol, freq, delay) {
  if (!noise) {
    noise = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.4), actx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = actx.currentTime + (delay || 0);
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  src.buffer = noise;
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 1.2;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(actx.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}
const sound = {
  bark(near) {
    if (!ready('bark', 60)) return;
    const v = near ? 0.22 : 0.09;
    tone(330, 0.09, 'sawtooth', v * 0.5, 0.55);
    puff(0.08, v, 900);
    tone(300, 0.08, 'sawtooth', v * 0.45, 0.5, 0.12);
    puff(0.07, v * 0.8, 800, 0.12);
  },
  bleat() {
    if (!ready('bleat', 160)) return;
    const t = actx.currentTime, o = actx.createOscillator(), lfo = actx.createOscillator();
    const lg = actx.createGain(), g = actx.createGain();
    o.type = 'triangle';
    o.frequency.value = 520 + Math.random() * 120;
    lfo.frequency.value = 22;
    lg.gain.value = 26;
    lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g); g.connect(actx.destination);
    o.start(t); lfo.start(t); o.stop(t + 0.35); lfo.stop(t + 0.35);
  },
  gain(gold) {
    if (!ready('gain', 50)) return;
    tone(660, 0.1, 'triangle', 0.12);
    tone(990, 0.14, 'triangle', 0.1, 0, 0.06);
    if (gold) tone(1320, 0.2, 'sine', 0.1, 0, 0.13);
  },
  loss() { if (ready('loss', 50)) tone(440, 0.18, 'triangle', 0.11, 0.6); },
  beep(hi) { if (ready('beep', 200)) tone(hi ? 880 : 620, 0.12, 'sine', 0.12); },
  go() { if (ready('go', 300)) { tone(700, 0.12, 'sine', 0.12, 2.0); tone(1400, 0.25, 'sine', 0.08, 1.0, 0.12); } },
  gold() { if (ready('goldsfx', 300)) [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.18, 'triangle', 0.09, 0, i * 0.07)); },
  horn(won) {
    if (!ready('horn', 500)) return;
    [392, 494, 587].forEach((f) => tone(f, 0.7, 'sawtooth', 0.04, won ? 1.0 : 0.94));
    if (won) [784, 988, 1175].forEach((f, i) => tone(f, 0.22, 'triangle', 0.08, 0, 0.35 + i * 0.09));
  },
  thud() { if (ready('thud', 120)) { tone(140, 0.14, 'sine', 0.16, 0.5); puff(0.06, 0.08, 300); } },
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
// fast screen and a slow one see the same dust.
const bits = [];      // { x, y, vx, vy, life, max, size, colour, kind } in meadow units
const pops = [];      // { x, y, s, colour, life, max, px }
const rings = [];     // { x, y, colour, life, max, r }
let shakeX = 0, shakeY = 0, shake = 0;
const BIT_HZ = 60;
let bitsClock = 0;
function spray(x, y, count, colour, speed, size, kind) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
    bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 20 + Math.random() * 20, size, colour, kind: kind || 0 });
  }
  if (bits.length > 500) bits.splice(0, bits.length - 500);
}
function pop(x, y, s, colour, px, lift) { pops.push({ x, y, s, colour, life: 0, max: 50, px: px || 16, lift: lift || 14 }); }
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
    shake *= 0.86;
    if (shake < 0.2) shake = 0;
    for (const look of dogLook.values()) {
      if (!look.running || Math.random() > 0.2) continue;
      bits.push({ x: look.x - Math.cos(look.a) * DOG_R, y: look.y - Math.sin(look.a) * DOG_R,
        vx: (Math.random() - 0.5) * 0.08, vy: (Math.random() - 0.5) * 0.08, life: 0, max: 18,
        size: 0.007, colour: 'rgba(220,210,170,0.55)', kind: 0 });
    }
  }
  shakeX = shake ? (Math.random() - 0.5) * shake : 0;
  shakeY = shake ? (Math.random() - 0.5) * shake : 0;
}

// ── what is drawn ──────────────────────────────────────────────────────────
const sheepLook = [];   // per sheep: { a: heading, hop }
const dogLook = new Map();  // id -> { a, squash, dust }
let roundShown = -1, roundAt = 0;
let myBarkAt = -1e9;
let drawFailed = false;
const BARK_MS = (BARK_CD / HZ) * 1000 + 150;

function mySeat(t) {
  const d = t.p[myId()];
  return d ? d.k : -1;
}

function play(e, t) {
  const me = myId();
  const mine = mySeat(t);
  if (e.kind === 'bark') {
    if (e.a === me) return;     // your own was heard and seen the moment you pressed
    const colour = colourOf(t, e.a);
    ring(e.x, e.y, colour, BARK_R);
    pop(e.x, e.y, 'woof', colour, 15, 26);
    const md = me !== -1 && t.p[me] ? t.p[me] : null;
    const near = md && (md.x - e.x) ** 2 + (md.y - e.y) ** 2 < BARK_R * BARK_R;
    if (near) shake = Math.max(shake, 5);
    sound.bark(near);
  } else if (e.kind === 'shoved') {
    spray(e.x, e.y, 8, '#e9e2cf', 0.5, 0.008);
    const look = dogLook.get(e.a);
    if (look) look.squash = 1;
    if (e.a === me) { shake = Math.max(shake, 7); sound.thud(); }
  } else if (e.kind === 'in') {
    const colour = SEAT[e.a];
    pop(e.x, e.y, e.b ? '+3' : '+1', colour, e.b ? 22 : 17);
    spray(e.x, e.y, e.b ? 14 : 6, e.b ? INK.gold : colour, 0.35, 0.007);
    if (e.a === mine) sound.gain(e.b);
    else sound.bleat();
  } else if (e.kind === 'out') {
    const colour = SEAT[e.a];
    pop(e.x, e.y, e.b ? '−3' : '−1', colour, 15);
    spray(e.x, e.y, 5, INK.woolShade, 0.3, 0.007);
    if (e.a === mine) { shake = Math.max(shake, 4); sound.loss(); }
  } else if (e.kind === 'gold') {
    spray(e.x, e.y, 26, INK.gold, 0.7, 0.01, 1);
    ring(e.x, e.y, INK.gold, 0.22);
    pop(e.x, e.y, 'golden ram!', INK.gold, 18, 30);
    sound.gold();
  } else if (e.kind === 'beep') {
    sound.beep(e.a <= 3);
  } else if (e.kind === 'go') {
    sound.go();
  } else if (e.kind === 'end') {
    const won = t.res && t.res.length && t.res[0][1] > 0 && t.res.some((r) => r[0] === me && r[1] === t.res[0][1]);
    sound.horn(won);
  }
}

function colourOf(t, id) {
  const d = t.p[id];
  return d && d.k >= 0 ? SEAT[d.k] : '#dddddd';
}

function drawMeadow() {
  inField();
  ctx.fillStyle = INK.edge;
  roundRect(-0.025, -0.025, FW + 0.05, FH + 0.05, 0.04);
  ctx.fill();
  ctx.fillStyle = INK.grass;
  ctx.fillRect(0, 0, FW, FH);
  ctx.fillStyle = INK.stripe;
  for (let x = 0; x < FW; x += 0.2) ctx.fillRect(x, 0, 0.1, FH);
  // A few tufts, fixed by their place so they never move.
  ctx.fillStyle = 'rgba(30,60,20,0.35)';
  for (let i = 0; i < 46; i++) {
    const x = ((i * 0.6180339) % 1) * FW, y = ((i * 0.7548776 + 0.3) % 1) * FH;
    ctx.beginPath();
    ctx.ellipse(x, y, 0.012, 0.005, 0, 0, Math.PI * 2);
    ctx.fill();
  }
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

// The arc of a pen inside the meadow, as angles.
function penArc(k) {
  const [ax, ay] = PENS[k];
  if (ax === 0 && ay === 0) return [0, Math.PI / 2];
  if (ax === FW && ay === 0) return [Math.PI / 2, Math.PI];
  if (ax === FW && ay === FH) return [Math.PI, Math.PI * 1.5];
  if (ax === 0 && ay === FH) return [Math.PI * 1.5, Math.PI * 2];
  if (ay === 0) return [0, Math.PI];
  if (ay === FH) return [Math.PI, Math.PI * 2];
  if (ax === 0) return [-Math.PI / 2, Math.PI / 2];
  return [Math.PI / 2, Math.PI * 1.5];
}

function drawPens(t, own, per, now) {
  inField();
  const mine = mySeat(t);
  for (let k = 0; k < PENS.length; k++) {
    if (own[k] === null) continue;
    const [ax, ay, r] = PENS[k];
    const [a0, a1] = penArc(k);
    ctx.fillStyle = SEAT[k] + (k === mine ? '40' : '2a');
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.arc(ax, ay, r, a0, a1);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = INK.fenceDark;
    ctx.lineWidth = 0.009;
    ctx.beginPath();
    ctx.arc(ax, ay, r, a0, a1);
    ctx.stroke();
    ctx.strokeStyle = INK.fence;
    ctx.lineWidth = 0.005;
    ctx.beginPath();
    ctx.arc(ax, ay, r - 0.004, a0, a1);
    ctx.stroke();
    const posts = 7;
    for (let i = 0; i <= posts; i++) {
      const a = a0 + ((a1 - a0) * i) / posts;
      ctx.fillStyle = i % 2 ? INK.fence : INK.fenceDark;
      ctx.beginPath();
      ctx.arc(ax + Math.cos(a) * r, ay + Math.sin(a) * r, 0.008, 0, Math.PI * 2);
      ctx.fill();
    }
    if (k === mine) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 300);
      ctx.strokeStyle = SEAT[k];
      ctx.globalAlpha = 0.35 + 0.35 * pulse;
      ctx.lineWidth = 0.004;
      ctx.beginPath();
      ctx.arc(ax, ay, r + 0.012, a0, a1);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  flat();
  for (let k = 0; k < PENS.length; k++) {
    if (own[k] === null) continue;
    const [hx, hy] = HEART[k];
    const n = per[k];
    const px = Math.max(14, sc * 0.075);
    ctx.globalAlpha = 0.9;
    text(String(n), SX(hx, hy), SY(hx, hy) + px * 0.35, px, SEAT[k], 'center');
    ctx.globalAlpha = 1;
  }
}

function sheepAt(b, i) {
  const a = b.from.s[i], z = b.to.s[i];
  if (!a || b.from.rd !== b.to.rd) return z;
  return [lerp(a[0], z[0], b.k), lerp(a[1], z[1], b.k), z[2], z[3], z[4], z[5], z[6]];
}

function drawSheep(t, b, now) {
  const list = t.s;
  if (sheepLook.length > list.length) sheepLook.length = list.length;
  // A round that has just begun lets its flock land rather than appear.
  if (t.rd !== roundShown) { roundShown = t.rd; roundAt = now; }
  const grow = ease(Math.min(1, (now - roundAt) / 450));
  inField();
  for (let i = 0; i < list.length; i++) {
    const s = sheepAt(b, i);
    const look = sheepLook[i] || (sheepLook[i] = { a: Math.random() * 6.28, hop: Math.random() * 6.28, x: s[0], y: s[1] });
    const speed = Math.sqrt(s[2] * s[2] + s[3] * s[3]);
    if (speed > 0.03) look.a = angleTo(look.a, Math.atan2(s[3], s[2]), per60(0.18));
    look.hop += speed * frameDt * 54;
    const r = (s[4] ? GOLD_R : SHEEP_R) * grow;
    const lift = Math.abs(Math.sin(look.hop)) * Math.min(1, speed * 4) * r * 0.35;
    const stretch = 1 + Math.min(0.25, speed * 0.4);
    ctx.save();
    ctx.translate(s[0], s[1]);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(0.003, 0.006, r * 1.15, r * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(0, -lift);
    ctx.rotate(look.a);
    ctx.scale(stretch, 1 / stretch);
    const wool = s[4] ? INK.gold : INK.wool, shade = s[4] ? INK.goldShade : INK.woolShade;
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(-r * 0.25, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = wool;
    for (const [px, py, pr] of [[-r * 0.55, -r * 0.35, 0.62], [-r * 0.55, r * 0.35, 0.62], [0, -r * 0.4, 0.6], [0, r * 0.4, 0.6], [-r * 0.2, 0, 0.75]]) {
      ctx.beginPath();
      ctx.arc(px, py, r * pr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = INK.face;
    ctx.beginPath();
    ctx.ellipse(r * 0.78, 0, r * 0.42, r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    if (s[4]) {
      ctx.strokeStyle = INK.goldShade;
      ctx.lineWidth = r * 0.22;
      ctx.beginPath(); ctx.arc(r * 0.55, -r * 0.42, r * 0.22, 0, Math.PI * 1.6); ctx.stroke();
      ctx.beginPath(); ctx.arc(r * 0.55, r * 0.42, r * 0.22, -Math.PI * 1.6, 0); ctx.stroke();
    }
    ctx.restore();
    if (s[4]) {
      // The ram glints, so it is found at a glance.
      const g = 0.5 + 0.5 * Math.sin(now / 160 + i);
      ctx.strokeStyle = 'rgba(255,220,110,' + (0.25 + 0.35 * g).toFixed(2) + ')';
      ctx.lineWidth = 0.004;
      ctx.beginPath();
      ctx.arc(s[0], s[1] - lift, r * 1.7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function dogAt(b, id) {
  const a = b.from.p[id], z = b.to.p[id];
  if (!z) return null;
  if (!a) return [z.x, z.y, z];
  return [lerp(a.x, z.x, b.k), lerp(a.y, z.y, b.k), z];
}

function drawDog(id, pos, colour, me, now) {
  const [x, y, d] = pos;
  let look = dogLook.get(id);
  if (!look) dogLook.set(id, (look = { a: 0, squash: 0, x, y, dust: 0 }));
  const mx = x - look.x, my = y - look.y;
  look.x = x; look.y = y;
  const moving = Math.sqrt(d.dx * d.dx + d.dy * d.dy) > 60;
  if (moving) look.a = angleTo(look.a, Math.atan2(d.dy, d.dx), per60(0.25));
  // Dust is kicked up on the bits' own clock, from where the dog is now.
  look.running = moving && (mx * mx + my * my) > 1e-8;
  look.seen = now;
  look.squash *= 1 - per60(0.14);
  const sq = 1 + look.squash * 0.3;
  inField();
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(0.004, 0.008, DOG_R * 1.1, DOG_R * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  if (me) {
    // Your dog wears a ring that fills while the next bark gets ready.
    const k = Math.max(0, Math.min(1, (now - myBarkAt) / BARK_MS));
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 0.006;
    ctx.beginPath(); ctx.arc(0, 0, DOG_R * 1.75, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = k >= 1 ? '#ffffff' : colour;
    ctx.beginPath(); ctx.arc(0, 0, DOG_R * 1.75, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke();
  }
  ctx.rotate(look.a);
  ctx.scale(sq, 1 / sq);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.ellipse(-DOG_R * 0.2, 0, DOG_R * 1.05, DOG_R * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath(); ctx.ellipse(-DOG_R * 1.1, 0, DOG_R * 0.35, DOG_R * 0.14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.arc(DOG_R * 0.6, 0, DOG_R * 0.62, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(DOG_R * 0.45, -DOG_R * 0.55, DOG_R * 0.3, DOG_R * 0.18, -0.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(DOG_R * 0.45, DOG_R * 0.55, DOG_R * 0.3, DOG_R * 0.18, 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff7e8';
  ctx.beginPath(); ctx.ellipse(DOG_R * 1.02, 0, DOG_R * 0.3, DOG_R * 0.26, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath(); ctx.arc(DOG_R * 1.25, 0, DOG_R * 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.004;
    ctx.beginPath(); ctx.arc(x, y, DOG_R * 1.25, 0, Math.PI * 2); ctx.stroke();
  }
  flat();
  const px = Math.max(10, Math.min(14, sc * 0.03));
  text(me ? 'you' : nickOf(id), SX(x, y), SY(x, y) - DOG_R * sc * 1.9, px, me ? '#ffffff' : colour, 'center');
}

function drawBits() {
  inField();
  for (const b of bits) {
    const k = b.life / b.max;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = b.colour;
    ctx.beginPath();
    if (b.kind === 1) {
      const s = b.size * (1 - k * 0.5);
      ctx.moveTo(b.x, b.y - s * 1.6); ctx.lineTo(b.x + s * 0.5, b.y); ctx.lineTo(b.x, b.y + s * 1.6); ctx.lineTo(b.x - s * 0.5, b.y);
    } else {
      ctx.arc(b.x, b.y, b.size * (0.6 + k), 0, Math.PI * 2);
    }
    ctx.fill();
  }
  for (const r of rings) {
    const k = r.life / r.max;
    ctx.globalAlpha = (1 - k) * 0.7;
    ctx.strokeStyle = r.colour;
    ctx.lineWidth = 0.01 * (1 - k) + 0.002;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r * ease(k), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  flat();
  for (const p of pops) {
    const k = p.life / p.max;
    const rise = p.lift + ease(k) * 26;
    const scale = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, (k - 0.15));
    ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    ctx.font = font(p.px * scale);
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(20,30,16,0.75)';
    const X = SX(p.x, p.y), Y = SY(p.x, p.y) - rise;
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

function drawHud(t, own, per, now) {
  flat();
  const me = myId();
  const narrow = VW < 420;
  const titlePx = narrow ? 15 : 17;
  // The status line: the phase, and the time left in it.
  let status = '', colour = INK.text;
  if (t.ph === WAIT) status = 'waiting for another shepherd';
  else if (t.ph === COUNT) status = 'round ' + t.rd + ' · get ready';
  else if (t.ph === PLAY) {
    status = 'round ' + t.rd + ' · ' + clock(t.pt);
    if (t.pt <= 10 * HZ) colour = (Math.floor(now / 250) % 2) ? INK.danger : INK.text;
  } else status = 'round ' + t.rd + ' · over';
  text('flock', 12, 22, titlePx, INK.gold, 'left');
  ctx.font = font(titlePx);
  const tw = ctx.measureText('flock').width;
  fitText(status, 22 + tw, 22, titlePx, colour, VW - tw - 90, 'left');
  ctx.font = font(10);
  text(wireNote(), VW - 50, 22, 10, INK.dim, 'right');

  // The scoreboard: one chip a dog, in its pen's colour, with what its pen holds.
  const ids = playersIn(t).filter((id) => t.p[id].k >= 0).sort((a, b) => t.p[a].k - t.p[b].k);
  if (!ids.length) return;
  const y = narrow ? 46 : 44;
  const gap = 6, cw = Math.min(150, (VW - 24 - gap * (ids.length - 1)) / ids.length);
  let x = (VW - (cw * ids.length + gap * (ids.length - 1))) / 2;
  for (const id of ids) {
    const k = t.p[id].k, mine = id === me;
    ctx.fillStyle = mine ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.25)';
    roundRect(x, y - 13, cw, 22, 11);
    ctx.fill();
    if (mine) { ctx.strokeStyle = SEAT[k]; ctx.lineWidth = 1.5; ctx.stroke(); }
    ctx.fillStyle = SEAT[k];
    ctx.beginPath(); ctx.arc(x + 11, y - 2, 5, 0, Math.PI * 2); ctx.fill();
    const score = String(per[k]);
    ctx.font = font(13);
    const sw = ctx.measureText(score).width;
    text(score, x + cw - 9, y + 3, 13, INK.text, 'right');
    const wins = t.p[id].w ? ' ★' + t.p[id].w : '';
    if (cw > 50) fitText((mine ? 'you' : nickOf(id)) + wins, x + 20, y + 3, 12, mine ? INK.text : INK.muted, cw - 34 - sw, 'left');
    x += cw + gap;
  }

  // The one line that says how to play.
  const how = coarse
    ? 'drag to run · tap to bark · herd sheep into your pen'
    : 'arrows/WASD or hold the mouse to run · space or click to bark · M mutes';
  fitText(how, VW / 2, VH - 10, 12, INK.muted, VW - 20);
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
  const fx0 = SX(0, 0), fx1 = SX(FW, FH);
  const cx = (fx0 + fx1) / 2, cy = (SY(0, 0) + SY(FW, FH)) / 2;
  const big = Math.max(18, Math.min(30, VW * 0.05));
  if (t.ph === WAIT) {
    // Kept to the top of the meadow, so the flock in the middle stays in view.
    const w = Math.min(VW - 32, 360), py = Math.min(SY(0, 0), SY(FW, FH)) + 58;
    panel(cx, py, w, 92);
    fitText('waiting for another shepherd', cx, py - 14, 18, INK.text, w - 24);
    fitText('meanwhile, practise: steer sheep into your pen', cx, py + 12, 13, INK.muted, w - 24);
    fitText('a round starts the moment a second dog joins', cx, py + 32, 12, INK.dim, w - 24);
  } else if (t.ph === COUNT) {
    const left = t.pt / HZ, n = Math.ceil(left), k = n - left;
    const s = 1.4 - 0.4 * ease(Math.min(1, k * 2.5));
    ctx.globalAlpha = 1 - Math.max(0, (k - 0.75) * 4);
    text(String(n), cx, cy + big, big * 2.6 * s, '#ffffff', 'center');
    ctx.globalAlpha = 1;
    fitText('pen the most sheep by the horn', cx, cy + big * 2.2, 15, INK.text, VW - 40);
  } else if (t.ph === PLAY && t.pt > PLAY_STEPS - HZ) {
    const k = (PLAY_STEPS - t.pt) / HZ;
    ctx.globalAlpha = 1 - k;
    text('go!', cx, cy + big * 0.5, big * (2 + k), '#ffffff', 'center');
    ctx.globalAlpha = 1;
  } else if (t.ph === END && t.res) {
    const k = ease(Math.min(1, (END_STEPS - t.pt) / (HZ * 0.4)));
    const rows = t.res.slice(0, 8);
    const w = Math.min(VW - 32, 320), h = 96 + rows.length * 22;
    ctx.globalAlpha = k;
    panel(cx, cy + (1 - k) * 30, w, h);
    const top = rows.length ? rows[0][1] : 0;
    const winners = rows.filter((r) => r[1] === top && top > 0).map((r) => r[0]);
    const me = myId();
    let head;
    if (!winners.length) head = 'nobody penned a sheep';
    else if (winners.length > 1) head = winners.includes(me) ? 'you share the win' : 'a shared win';
    else head = winners[0] === me ? 'you win!' : nickOf(winners[0]) + ' wins';
    const y0 = cy + (1 - k) * 30 - h / 2;
    fitText(head, cx, y0 + 34, 22, winners.length ? colourOf(t, winners[0]) : INK.text, w - 24);
    rows.forEach(([id, score], i) => {
      const y = y0 + 62 + i * 22;
      const c = t.p[id] ? colourOf(t, id) : INK.dim;
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(cx - w / 2 + 24, y - 4, 5, 0, Math.PI * 2); ctx.fill();
      fitText((id === me ? 'you' : nickOf(id)) + (i === 0 && top > 0 ? '  ★' : ''), cx - w / 2 + 36, y, 14, id === me ? INK.text : INK.muted, w - 100, 'left');
      text(String(score), cx + w / 2 - 22, y, 15, INK.text, 'right');
    });
    fitText('next round in ' + Math.ceil(t.pt / HZ), cx, y0 + h - 14, 12, INK.dim, w - 24);
    ctx.globalAlpha = 1;
  }
}

// Your own dog is drawn from a guess a trip ahead, and a guess is remade every
// time a tick lands. After a sharp turn the room may apply the turn a step
// earlier or later than the guess assumed, and the remade guess then stands a
// step or two away from the last one — drawn as it is, the dog twitches back
// and forth on every turn. So the dog drawn follows the guess's own motion up
// to the speed a dog can run, and closes any jump beyond that over a few
// frames instead of in one. Only the drawing is smoothed; the meadow is not.
let shownGuess = null;   // { x, y, tx, ty }: where your dog is drawn, and the guess last frame
function settle(tx, ty) {
  const g = shownGuess;
  if (!g || (tx - g.x) ** 2 + (ty - g.y) ** 2 > 0.2 * 0.2) {
    shownGuess = { x: tx, y: ty, tx, ty };
    return [tx, ty];
  }
  let mx = tx - g.tx, my = ty - g.ty;
  const most = DOG_V * 1.15 * frameDt, far = Math.hypot(mx, my);
  if (far > most) { mx *= most / far; my *= most / far; }
  g.x += mx; g.y += my;
  const k = per60(0.2);
  g.x += (tx - g.x) * k;
  g.y += (ty - g.y) * k;
  g.tx = tx; g.ty = ty;
  return [g.x, g.y];
}

function draw(now) {
  flat();
  ctx.fillStyle = INK.page;
  ctx.fillRect(0, 0, VW, VH);
  const b = agreedAt(now);
  drawMeadow();
  if (!b) {
    flat();
    const cx = VW / 2, cy = VH / 2;
    panel(cx, cy, Math.min(VW - 32, 300), 60);
    text('catching up with the meadow…', cx, cy + 5, 15, INK.text, 'center');
    return;
  }
  const t = b.to;
  const nShown = b.from.n + (b.to.n - b.from.n) * b.k;
  for (let i = 0; i < fxq.length;) {
    // One far ahead of the drawing belongs to a meadow this copy has since
    // dropped for the room's.
    if (fxq[i].n > nShown + 600) fxq.splice(i, 1);
    else if (fxq[i].n <= nShown + 0.5) play(fxq.splice(i, 1)[0], t);
    else i++;
  }
  const own = owners(t), per = tally(t);
  drawPens(t, own, per, now);
  drawSheep(t, b, now);
  const me = myId();
  const m = mineAt(now);
  for (const id of playersIn(t)) {
    if (id === me) continue;
    const pos = dogAt(b, id);
    if (pos) drawDog(id, pos, colourOf(t, id), false, now);
  }
  for (const [id, look] of dogLook) if (now - look.seen > 1000) dogLook.delete(id);
  const mine = m && m.to.p[me] ? dogAt(m, me) : null;
  if (mine) {
    myPos = settle(mine[0], mine[1]);
    drawDog(me, [myPos[0], myPos[1], mine[2]], colourOf(m.to, me), true, now);
  } else myPos = shownGuess = null;
  drawBits();
  drawHud(t, own, per, now);
  drawOverlay(t, now);
}

// ═══════════════════ the hands ═══════════════════
// What the hand says: a direction in thousandths, and how many barks so far.
// Setting off and stopping go out at once; a change of direction while running
// goes out no oftener than TURN_EVERY, because a thumb moving in a circle
// changes it on every move the screen reports and the clock's ticks share the
// same seat's ceiling on messages.
const TURN_EVERY = 66;
let wanted = [0, 0];
let lastSaid = [0, 0];
let saidAt = -1e9;
let barks = 0;
let myPos = null;

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
  setHand([d[0], d[1], barks]);
}

// A bark is asked for no sooner than the meadow will allow it, so it is never
// spent on a cooldown; you hear and see it at once, and the meadow carries it
// out a trip later on every copy alike.
function bark() {
  wake();
  const now = performance.now();
  if (now - myBarkAt < BARK_MS || !world) return;
  myBarkAt = now;
  barks = (barks + 1) % 64;
  lastSaid = wanted;
  saidAt = now;
  setHand([wanted[0], wanted[1], barks]);
  if (myPos) {
    const d = world.p[myId()];
    const colour = d && d.k >= 0 ? SEAT[d.k] : '#ffffff';
    ring(myPos[0], myPos[1], colour, BARK_R);
    pop(myPos[0], myPos[1], 'woof!', colour, 17, 26);
    const look = dogLook.get(myId());
    if (look) look.squash = 1;
  }
  sound.bark(true);
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
  return toField(dx, dy);
}
addEventListener('keydown', (e) => {
  wake();
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'Space' || e.code === 'KeyE' || e.code === 'Enter') {
    e.preventDefault();
    if (!e.repeat) bark();
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

// A thumb: a stick from wherever it lands, and a tap barks — a drag rather
// than a press, because iOS keeps a long press inside a frame for itself. A
// second finger down while the first runs barks too.
// A mouse: hold the button and the dog runs to the pointer; a click barks.
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
    if (stick) { bark(); return; }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
    paintStick(0, 0);
    return;
  }
  coarse = false;
  if (e.button === 2) { bark(); return; }
  if (e.button !== 0) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  mouse = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, at: performance.now(), moved: false };
});
cv.addEventListener('pointermove', (e) => {
  if (stick && e.pointerId === stick.id) {
    const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    paintStick(dx, dy);
    const still = Math.hypot(dx, dy) < DEAD;
    if (!still) stick.moved = true;
    shove(...(still ? [0, 0] : toField(dx, dy)));
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
    if (tap) bark();
  } else if (mouse && e.pointerId === mouse.id) {
    const click = !mouse.moved && performance.now() - mouse.at < 220;
    mouse = null;
    shove(...fromKeys());
    if (click) bark();
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

// The mouse steers toward the pointer from where your dog is drawn.
function steerToMouse() {
  if (!mouse || !myPos) return;
  const r = cv.getBoundingClientRect();
  const dx = mouse.x - r.left - SX(myPos[0], myPos[1]);
  const dy = mouse.y - r.top - SY(myPos[0], myPos[1]);
  if (Math.hypot(dx, dy) < 10) shove(0, 0);
  else shove(...toField(dx, dy));
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
// a dog arrives on the meadow.
function start() {
  setHand([0, 0, barks]);
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
