/**
 * @disk     kessler
 * @author   claude
 * @version  1
 * @players  2-8
 * @about    Gravity artillery in volleys around a small sun. Everyone aims in secret, then all shots fly at once and bend around the star. A miss never goes away: it stays in orbit as debris that can hit anyone, you included. Slide to dodge, or shoot the junk down.
 * @tags     game, party, physics, artillery, space
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/kessler.png
 */
// kessler.js — simultaneous gravity artillery, run by the host.
//
// Stations sit on a ring around a sun. Each volley everyone picks one thing in
// secret: a shot (pull back and let go) or a slide to the next slot on the
// ring. When the clock runs out or everybody has locked in, every shot leaves
// at once and the sky runs for three seconds. Shots curve around the sun;
// whatever has not hit a station, the sun or another shot when the volley ends
// stays where it is and keeps orbiting in every volley after. So the field
// fills up with everyone's misses, and planning a volley means reading the
// paths of the junk already up there as much as aiming at a rival.
//
// The host is the authority. A choice travels to the host alone, addressed,
// so nobody sees a rival's aim before the volley flies; the host checks it,
// runs the volley, and broadcasts the inputs and the result. Every copy then
// replays the same volley from the same starting table to draw it, using only
// + - * / and sqrt, so the replay matches the host's to the last bit; the
// host's table after the volley is adopted at the end either way, so a copy
// that drifted is put right. What this does not stop is a hostile host: the
// host's own copy sees every aim before the volley and decides the outcome,
// and nothing in a host-run game can take that away from it.

// ── rules ───────────────────────────────────────────────────────────────────

const Q = 10000;                 // positions and speeds travel as integers of 1/Q
const SLOTS = 12;                // places on the ring
const RING = 0.74;               // ring radius, world units (the field is radius 1)
const SHIP_R = 0.05;
const SUN_R = 0.085;
const ESC = 1.7;                 // beyond this a body has left for good
const GM = 0.42;                 // the sun's pull
const VMIN = 0.2, VMAX = 1.25;   // launch speed range
const STEPS = 180;               // steps in one volley's flight
const RATE = 60;                 // steps per second on screen
const SUB = 3;                   // substeps per step, for close passes
const HS = 1 / RATE / SUB;
const SHOT_R = 0.016, HEAVY_R = 0.027;
const OWN_GRACE = 36;            // steps a fresh shot cannot hit its own station
const MOVE_STEPS = 30;           // a slide takes this many steps
const MAXB = 48;                 // bodies kept in orbit; the oldest burn out first
const SHIELDS = 3;
const VOLLEYS = 10;
const PLAN_MS = 12000;
const FLY_MS = STEPS / RATE * 1000 + 900;
const DEAL_COOLDOWN = 2500;
const GRACE = 8000;              // how long a dropped connection has to come back
const MAX_SEATS = 8;
const BOT_NAMES = ['Drone Vega', 'Drone Lyra'];

// Slot positions from exact constants rather than Math.cos, so every browser
// places a station on the same bits.
const R3 = 0.8660254037844386;
const CS = [1, R3, 0.5, 0, -0.5, -R3, -1, -R3, -0.5, 0, 0.5, R3];
const SN = [0, 0.5, R3, 1, R3, 0.5, 0, -0.5, -R3, -1, -R3, -0.5];
const SX = CS.map((v) => v * RING);
const SY = SN.map((v) => v * RING);

// One colour per seat, in seat order.
const PAL = ['#ff6b6b', '#ffd25a', '#46e0a6', '#4fc3ff', '#b58cff', '#ff9a4d', '#ff6fc8', '#a5e25c'];
const C = {
  bg0: '#1a1f45', bg1: '#080a1c', panel: 'rgba(14,17,40,0.93)', line: '#2b3366',
  text: '#f1efe6', dim: '#a9afd2', faint: '#646b98',
  sun: '#ffcc66', sunCore: '#fff3c8', junk: '#9aa0bf', gold: '#ffcf5a', goldDeep: '#3b2c08', red: '#ff5d73',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ── the table ───────────────────────────────────────────────────────────────

// Every copy holds this; the host's copy is the truth.
//   g     game number, so anything about an old game is recognised as stale
//   ph    'wait' | 'plan' | 'fly' | 'over'
//   v     the volley, 1..VOLLEYS
//   s     seats: [id, slot, shields, score, colour, heavy, crown]
//   b     bodies in orbit, oldest first: [x, y, vx, vy, colour or -1, heavy]
//   rdy   ids locked in this volley
//   pr    1 for a practice table with drones
let S = { g: 0, ph: 'wait', v: 0, s: [], b: [], rdy: [], pr: 0 };
let endAt = 0;
let overAt = -1e9;

// The host's alone.
const choices = new Map();       // seat id -> { k, x, y }, never broadcast before the volley
const botAt = new Map();
let lastPub = 0;
let shortAt = 0;
const running = new Set();       // ids whose disk has said hello

// Mine.
let mine = null;                 // { g, v, k, x, y, lk, n }
let sentKey = '';
let sendTimer = null;
let lastSend = 0;

const nicks = new Map();

const solo = () => !room.me;
const myId = () => (room.me ? room.me.id : -1);
const amHost = () => !room.me || (room.host !== null && room.host.id === room.me.id);
const fromHost = (from) => room.host !== null && from === room.host.id;
const inRoom = (id) => room.players.some((p) => p.id === id);
const isBot = (id) => id < -1;
const present = (id) => (id < -1 ? true : id === -1 ? solo() : inRoom(id));
const runners = () => room.players.filter((p) => p.id === myId() || running.has(p.id) || seatOf(p.id)).map((p) => p.id);
const seatOf = (id) => S.s.find((r) => r[0] === id) || null;
const mySeat = () => seatOf(myId());

function nickOf(id) {
  if (id === -1) return 'You';
  if (isBot(id)) return BOT_NAMES[(-id - 2) % BOT_NAMES.length];
  const p = room.players.find((x) => x.id === id);
  if (p) { nicks.set(id, p.nick); return p.nick; }
  return nicks.get(id) || 'Player';
}
const colorOfC = (c) => (c >= 0 && c < PAL.length ? PAL[c] : C.junk);
function colorOf(id) { const r = seatOf(id); return r ? colorOfC(r[4]) : C.dim; }

// ── the sky ─────────────────────────────────────────────────────────────────
// One volley, start to finish. Pure: the same table, inputs and list of who
// is here give the same result on every machine. No Math.random, no clock, no
// trigonometry inside: only + - * / and sqrt, which every browser rounds alike.

function smooth(t) { return t * t * (3 - 2 * t); }

function shipAt(st, s) {
  if (st.to === st.slot || s >= MOVE_STEPS) return [SX[st.to], SY[st.to]];
  const e = smooth(s / MOVE_STEPS);
  let x = SX[st.slot] + (SX[st.to] - SX[st.slot]) * e;
  let y = SY[st.slot] + (SY[st.to] - SY[st.slot]) * e;
  const k = RING / Math.sqrt(x * x + y * y);
  return [x * k, y * k];
}

// Where a free body goes with nothing in its way: for the dotted paths, the
// aim preview and the drones. Never part of the volley itself.
function path(x, y, vx, vy, steps, every) {
  const out = [];
  for (let s = 1; s <= steps; s++) {
    for (let k = 0; k < SUB; k++) {
      let d2 = x * x + y * y;
      if (d2 < 0.0025) d2 = 0.0025;
      const g = GM / (d2 * Math.sqrt(d2));
      vx -= x * g * HS; vy -= y * g * HS;
      x += vx * HS; y += vy * HS;
    }
    const d2 = x * x + y * y;
    if (d2 < SUN_R * SUN_R || d2 > ESC * ESC) { out.push(x, y); break; }
    if (s % every === 0) out.push(x, y);
  }
  return out;
}

// inputs: [[id, kind, x, y]] with kind 'f' fire (x, y the launch velocity in
// 1/Q), 'l' slide to slot + 1, 'r' slide to slot - 1. live: the seat ids
// taking part. With `rec`, every step's positions are kept for drawing.
function simulate(T, inputs, live, rec) {
  const mult = T.v >= VOLLEYS - 1 ? 2 : 1;
  const seats = T.s.map((r) => ({
    id: r[0], slot: r[1], to: r[1], sh: r[2], sc: r[3], c: r[4], hv: r[5], cr: r[6],
    here: live.includes(r[0]) && r[2] > 0, dead: -1, px: 0, py: 0,
  }));
  const inp = new Map();
  for (const i of inputs) inp.set(i[0], i);
  const ev = [];

  // Slides first: a slot taken by a station, or wanted by two, stays put.
  const want = new Map();
  for (const st of seats) {
    const i = inp.get(st.id);
    if (!st.here || !i || (i[1] !== 'l' && i[1] !== 'r')) continue;
    want.set(st.id, (st.slot + (i[1] === 'l' ? 1 : SLOTS - 1)) % SLOTS);
  }
  for (const st of seats) {
    if (!want.has(st.id)) continue;
    const t = want.get(st.id);
    const taken = seats.some((o) => o !== st && o.here && o.slot === t);
    const rival = seats.some((o) => o !== st && want.get(o.id) === t);
    if (!taken && !rival) st.to = t;
  }

  const B = T.b.map((r) => ({ x: r[0] / Q, y: r[1] / Q, vx: r[2] / Q, vy: r[3] / Q, c: r[4], h: r[5], r: r[5] ? HEAVY_R : SHOT_R, t: 1e9, on: true }));
  const shots = [];
  for (const st of seats) {
    const i = inp.get(st.id);
    if (!st.here || !i || i[1] !== 'f') continue;
    const vx = i[2] / Q, vy = i[3] / Q;
    const m = Math.sqrt(vx * vx + vy * vy);
    if (!(m > 0)) continue;
    const r = st.hv ? HEAVY_R : SHOT_R;
    const off = SHIP_R + r + 0.012;
    shots.push({ x: SX[st.slot] + vx / m * off, y: SY[st.slot] + vy / m * off, vx, vy, c: st.c, h: st.hv ? 1 : 0, r, t: 0, on: true });
  }
  // The sky holds so much: the oldest junk burns out to make room.
  while (B.length + shots.length > MAXB && B.length) {
    const o = B.shift();
    ev.push({ s: 0, k: 'fizz', x: o.x, y: o.y });
  }
  for (const sh of shots) B.push(sh);

  const cap = B.length + 3 * seats.length;
  const frames = rec ? [] : null;
  const snap = () => {
    const f = new Float32Array(cap * 3);
    for (let i = 0; i < B.length; i++) { f[i * 3] = B[i].x; f[i * 3 + 1] = B[i].y; f[i * 3 + 2] = B[i].on ? 1 : 0; }
    frames.push(f);
  };
  if (rec) snap();

  const byC = (c) => seats.find((o) => o.c === c) || null;
  function hit(st, b, s) {
    st.sh -= 1;
    const own = b.c >= 0 ? byC(b.c) : null;
    let p = 0;
    if (own && own !== st) {
      p = mult + (st.cr ? mult : 0);
      if (st.sh <= 0) p += 2 * mult;
      own.sc += p;
    }
    ev.push({ s, k: st.sh <= 0 ? 'ko' : 'hit', id: st.id, o: own ? own.id : null, p, x: st.px, y: st.py });
    if (st.sh > 0) return;
    st.dead = s;
    // A station that breaks up becomes three more pieces of junk.
    const ux = st.px / RING, uy = st.py / RING;
    const dirs = [[-uy * 0.62, ux * 0.62], [uy * 0.62, -ux * 0.62], [ux * 0.34 - uy * 0.2, uy * 0.34 + ux * 0.2]];
    for (const d of dirs) {
      const m = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
      B.push({ x: st.px + d[0] / m * 0.07, y: st.py + d[1] / m * 0.07, vx: d[0], vy: d[1], c: -1, h: 0, r: SHOT_R, t: 0, on: true });
    }
  }

  for (let s = 1; s <= STEPS; s++) {
    for (const st of seats) { const p = shipAt(st, s); st.px = p[0]; st.py = p[1]; }
    for (let k = 0; k < SUB; k++) {
      for (const b of B) {
        if (!b.on) continue;
        let d2 = b.x * b.x + b.y * b.y;
        if (d2 < 0.0025) d2 = 0.0025;
        const g = GM / (d2 * Math.sqrt(d2));
        b.vx -= b.x * g * HS; b.vy -= b.y * g * HS;
        b.x += b.vx * HS; b.y += b.vy * HS;
      }
      for (const b of B) {
        if (!b.on) continue;
        const d2 = b.x * b.x + b.y * b.y;
        if (d2 < SUN_R * SUN_R) { b.on = false; ev.push({ s, k: 'sun', x: b.x, y: b.y }); continue; }
        if (d2 > ESC * ESC) { b.on = false; continue; }
        for (const st of seats) {
          if (!st.here || st.dead >= 0) continue;
          if (b.c === st.c && b.t < OWN_GRACE) continue;
          const dx = b.x - st.px, dy = b.y - st.py, rr = SHIP_R + b.r;
          if (dx * dx + dy * dy < rr * rr) { b.on = false; hit(st, b, s); break; }
        }
      }
      for (let i = 0; i < B.length; i++) {
        const a = B[i];
        if (!a.on) continue;
        for (let j = i + 1; j < B.length; j++) {
          const b = B[j];
          if (!b.on) continue;
          const dx = a.x - b.x, dy = a.y - b.y, rr = a.r + b.r;
          if (dx * dx + dy * dy >= rr * rr) continue;
          // A heavy shot ploughs through light junk; equals take each other out.
          if (a.h && !b.h) b.on = false;
          else if (b.h && !a.h) a.on = false;
          else { a.on = false; b.on = false; }
          ev.push({ s, k: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          if (!a.on) break;
        }
      }
    }
    for (const b of B) if (b.on) b.t++;
    if (rec) snap();
  }

  const out = [];
  for (const b of B) {
    if (!b.on) continue;
    out.push([Math.round(b.x * Q), Math.round(b.y * Q), Math.round(b.vx * Q), Math.round(b.vy * Q), b.c, b.h]);
  }
  return {
    s: seats.map((st) => [st.id, st.to, Math.max(0, st.sh), st.sc, st.c, st.hv, st.cr]),
    b: out,
    ev,
    frames,
    meta: B.map((b) => ({ c: b.c, h: b.h, r: b.r })),
    moves: seats.map((st) => ({ id: st.id, slot: st.slot, to: st.to, dead: st.dead, here: st.here })),
  };
}

// A fingerprint of the table a volley starts from, so a copy holding a
// different one knows not to replay it and waits for the result instead.
function tableHash(T) {
  let h = 2166136261;
  const mix = (n) => { h = Math.imul(h ^ (n | 0), 16777619); };
  for (const r of T.s) for (const n of r) mix(n);
  for (const r of T.b) for (const n of r) mix(n);
  return h >>> 0;
}

// ── the host ────────────────────────────────────────────────────────────────

const canDeal = (now) => S.ph === 'wait' || (S.ph === 'over' && now - overAt >= DEAL_COOLDOWN);

function freeSlot(taken) {
  let best = -1, bestD = -1;
  for (let k = 0; k < SLOTS; k++) {
    if (taken.includes(k)) continue;
    let d = SLOTS;
    for (const t of taken) { const g = Math.abs(t - k); d = Math.min(d, g, SLOTS - g); }
    if (d > bestD) { bestD = d; best = k; }
  }
  return best;
}

function hostDeal() {
  const now = performance.now();
  if (!amHost() || !canDeal(now)) return;
  let ids = solo() ? [-1] : runners().slice(0, MAX_SEATS);
  let pr = 0;
  // One person is a practice table: the host is dealt two drones.
  if (ids.length < 2) { ids = ids.concat([-2, -3]); pr = 1; }
  const n = ids.length;
  S = {
    g: S.g + 1, ph: 'plan', v: 1, b: [], rdy: [], pr,
    s: ids.map((id, i) => [id, Math.round(i * SLOTS / n) % SLOTS, SHIELDS, 0, i, 0, 0]),
  };
  shortAt = 0;
  startPlan(now);
}

function marks() {
  const live = S.s.filter((r) => present(r[0]));
  if (!live.length) return;
  let hi = -1e9, lo = 1e9;
  for (const r of live) { hi = Math.max(hi, r[3]); lo = Math.min(lo, r[3]); }
  const top = live.filter((r) => r[3] === hi).length;
  for (const r of S.s) {
    r[6] = hi > 0 && top === 1 && r[3] === hi ? 1 : 0;   // the leader wears a crown worth a bonus
    r[5] = lo < hi && r[3] === lo ? 1 : 0;                // the trailing seats fire heavy shots
  }
}

function startPlan(now) {
  // Stations broken last volley come back whole.
  for (const r of S.s) if (r[2] <= 0) r[2] = SHIELDS;
  // Somebody who started the disk mid-game takes a free slot and a colour.
  const ids = solo() ? [] : room.players.map((p) => p.id).filter((id) => (id === myId() || running.has(id)) && !seatOf(id));
  for (const id of ids) {
    if (S.s.length >= MAX_SEATS) break;
    const used = S.s.map((r) => r[4]);
    let c = 0;
    while (used.includes(c)) c++;
    const slot = freeSlot(S.s.filter((r) => present(r[0])).map((r) => r[1]));
    if (slot < 0 || c >= PAL.length) break;
    S.s.push([id, slot, SHIELDS, 0, c, 0, 0]);
  }
  // A seat that came back may find its slot taken while it was away.
  const held = [];
  for (const r of S.s) {
    if (!present(r[0])) continue;
    if (held.includes(r[1])) { const f = freeSlot(held); if (f >= 0) r[1] = f; }
    held.push(r[1]);
  }
  marks();
  S.ph = 'plan';
  S.rdy = [];
  choices.clear();
  botAt.clear();
  for (const r of S.s) if (isBot(r[0])) botAt.set(r[0], now + 1500 + Math.random() * 4500);
  endAt = now + PLAN_MS;
  publish(now);
}

function hostChoose(id, k, x, y, lk, now) {
  if (S.ph !== 'plan') return;
  const r = seatOf(id);
  if (!r || !present(id) || S.rdy.includes(id)) return;
  if (k === 'f') {
    const m = Math.sqrt(x * x + y * y);
    if (!(m > 1e-6)) return;
    const t = Math.min(VMAX, Math.max(VMIN, m)) / m;
    choices.set(id, { k, x: Math.round(x * t * Q), y: Math.round(y * t * Q) });
  } else if (k === 'l' || k === 'r') {
    choices.set(id, { k, x: 0, y: 0 });
  } else {
    choices.delete(id);
  }
  if (lk) {
    S.rdy.push(id);
    if (!solo()) room.send({ t: 'rdy', g: S.g, v: S.v, ids: S.rdy });
    observe(now);
  }
}

// A drone looks a volley ahead: it slides away from junk about to cross its
// slot, and otherwise tries a handful of shots and keeps the one that passes
// nearest a rival, with a little error so it can be beaten.
function botChoose(id, now) {
  const r = seatOf(id);
  if (!r) return;
  const x0 = SX[r[1]], y0 = SY[r[1]];
  let danger = false;
  for (const b of S.b) {
    const p = path(b[0] / Q, b[1] / Q, b[2] / Q, b[3] / Q, STEPS, 2);
    for (let i = 0; i < p.length; i += 2) {
      const dx = p[i] - x0, dy = p[i + 1] - y0;
      if (dx * dx + dy * dy < (SHIP_R * 1.5) ** 2) { danger = true; break; }
    }
    if (danger) break;
  }
  if (danger && Math.random() < 0.75) {
    const taken = S.s.filter((o) => o !== r && present(o[0])).map((o) => o[1]);
    const l = (r[1] + 1) % SLOTS, rr = (r[1] + SLOTS - 1) % SLOTS;
    const opts = [];
    if (!taken.includes(l)) opts.push('l');
    if (!taken.includes(rr)) opts.push('r');
    if (opts.length) { hostChoose(id, opts[Math.floor(Math.random() * opts.length)], 0, 0, true, now); return; }
  }
  const foes = S.s.filter((o) => o !== r && present(o[0]));
  let best = null, bestD = 1e9;
  for (let n = 0; n < 26; n++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 0.45 + Math.random() * 0.7;
    const vx = Math.cos(a) * sp, vy = Math.sin(a) * sp;
    if (vx * x0 + vy * y0 > 0.2 * sp) continue;   // not straight out into space
    const p = path(x0 + vx / sp * 0.08, y0 + vy / sp * 0.08, vx, vy, STEPS, 2);
    let d = 1e9;
    for (let i = 0; i < p.length; i += 2) {
      for (const f of foes) {
        const dx = p[i] - SX[f[1]], dy = p[i + 1] - SY[f[1]];
        d = Math.min(d, dx * dx + dy * dy);
      }
    }
    if (d < bestD) { bestD = d; best = [vx, vy]; }
  }
  if (!best) { hostChoose(id, 'n', 0, 0, true, now); return; }
  const e = 1 + (Math.random() - 0.5) * 0.12;
  const turn = (Math.random() - 0.5) * 0.1;
  hostChoose(id, 'f', (best[0] - best[1] * turn) * e, (best[1] + best[0] * turn) * e, true, now);
}

function fire(now) {
  const live = S.s.filter((r) => present(r[0])).map((r) => r[0]);
  const inputs = [];
  for (const r of S.s) {
    const c = choices.get(r[0]);
    if (c && live.includes(r[0])) inputs.push([r[0], c.k, c.x, c.y]);
  }
  const go = { t: 'go', g: S.g, v: S.v, h: tableHash(S), in: inputs, live };
  if (!solo()) room.send(go);
  playVolley(go, now);
  const res = simulate(S, inputs, live, false);
  S = { g: S.g, ph: 'fly', v: S.v, s: res.s, b: res.b, rdy: [], pr: S.pr };
  choices.clear();
  botAt.clear();
  endAt = now + FLY_MS;
  publish(now);
}

function finish(now) {
  S.ph = 'over';
  S.rdy = [];
  choices.clear();
  botAt.clear();
  endAt = now;
  overAt = now;
  publish(now);
}

function tooFew(now) {
  const live = S.s.filter((r) => present(r[0]));
  if (live.length >= 2 && live.some((r) => !isBot(r[0]))) { shortAt = 0; return false; }
  if (!shortAt) shortAt = now;
  return now - shortAt > GRACE;
}

function hostTick() {
  if (!amHost()) return;
  const now = performance.now();
  if (S.ph === 'plan') {
    for (const [id, at] of botAt) {
      if (now < at) continue;
      botAt.delete(id);
      botChoose(id, now);
    }
    if (tooFew(now)) { finish(now); return; }
    const live = S.s.filter((r) => present(r[0]));
    if (now >= endAt || live.every((r) => S.rdy.includes(r[0]))) { fire(now); return; }
  } else if (S.ph === 'fly' && now >= endAt) {
    if (S.v >= VOLLEYS || tooFew(now)) finish(now);
    else { S.v += 1; startPlan(now); }
    return;
  }
  // A heartbeat, so one lost broadcast is never the only thing that carried a
  // change, and a latecomer's clock is put right.
  if (S.g > 0 && now - lastPub > 3000) publish(now);
}

function wire(now) {
  return { t: 'st', g: S.g, ph: S.ph, v: S.v, s: S.s, b: S.b, rdy: S.rdy, pr: S.pr, ms: Math.max(0, Math.round(endAt - now)) };
}

function publish(now) {
  lastPub = now;
  if (!solo()) room.send(wire(now));
  observe(now);
}

// ── receiving ───────────────────────────────────────────────────────────────

// Anything off the wire is a claim and is read as one: the right shape,
// integers in range, lists of bounded length. Anything else is dropped whole.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID_MIN = -3, ID_MAX = 2147483647;
const isId = (v) => int(v, ID_MIN, ID_MAX);

function tableOf(m) {
  if (!int(m.g, 1, 1e9) || !['plan', 'fly', 'over'].includes(m.ph) || !int(m.v, 1, VOLLEYS)) return null;
  if (!Array.isArray(m.s) || m.s.length < 1 || m.s.length > MAX_SEATS) return null;
  const s = [];
  for (const r of m.s) {
    if (!Array.isArray(r) || r.length !== 7) return null;
    if (!isId(r[0]) || !int(r[1], 0, SLOTS - 1) || !int(r[2], 0, SHIELDS) || !int(r[3], -1e6, 1e6)) return null;
    if (!int(r[4], 0, PAL.length - 1) || !int(r[5], 0, 1) || !int(r[6], 0, 1)) return null;
    if (s.some((o) => o[0] === r[0] || o[4] === r[4])) return null;
    s.push(r.slice());
  }
  if (!Array.isArray(m.b) || m.b.length > MAXB) return null;
  const b = [];
  const lim = Math.round(ESC * Q) + 1, vlim = 20 * Q;
  for (const r of m.b) {
    if (!Array.isArray(r) || r.length !== 6) return null;
    if (!int(r[0], -lim, lim) || !int(r[1], -lim, lim) || !int(r[2], -vlim, vlim) || !int(r[3], -vlim, vlim)) return null;
    if (!int(r[4], -1, PAL.length - 1) || !int(r[5], 0, 1)) return null;
    b.push(r.slice());
  }
  if (!Array.isArray(m.rdy) || m.rdy.length > MAX_SEATS || !m.rdy.every((id) => s.some((r) => r[0] === id))) return null;
  if (!int(m.pr, 0, 1) || typeof m.ms !== 'number' || !Number.isFinite(m.ms)) return null;
  return { T: { g: m.g, ph: m.ph, v: m.v, s, b, rdy: m.rdy.slice(), pr: m.pr }, ms: Math.min(Math.max(m.ms, 0), PLAN_MS + FLY_MS) };
}

function goOf(m) {
  if (!int(m.g, 1, 1e9) || !int(m.v, 1, VOLLEYS) || !int(m.h, 0, 4294967295)) return null;
  if (!Array.isArray(m.live) || m.live.length > MAX_SEATS || !m.live.every(isId)) return null;
  if (!Array.isArray(m.in) || m.in.length > MAX_SEATS) return null;
  const inputs = [];
  const vlim = Math.ceil(VMAX * Q) + 1;
  for (const i of m.in) {
    if (!Array.isArray(i) || i.length !== 4 || !isId(i[0]) || !['f', 'l', 'r'].includes(i[1])) return null;
    if (!int(i[2], -vlim, vlim) || !int(i[3], -vlim, vlim)) return null;
    inputs.push([i[0], i[1], i[2], i[3]]);
  }
  return { g: m.g, v: m.v, h: m.h, in: inputs, live: m.live.slice() };
}

// Every sender gets a bucket: ten messages a second, twenty at once. An honest
// copy sends a few a volley; one that floods is dropped before any of its
// messages is read, so it cannot stall the table for the rest.
const buckets = new Map();
function allow(from, now) {
  let b = buckets.get(from);
  if (!b) { b = { tok: 20, at: now }; buckets.set(from, b); }
  b.tok = Math.min(20, b.tok + (now - b.at) * 0.01);
  b.at = now;
  if (b.tok < 1) return false;
  b.tok -= 1;
  return true;
}

room.on('message', (from, msg) => {
  try {
    const now = performance.now();
    if (!Number.isInteger(from) || !allow(from, now)) return;
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    switch (msg.t) {
      // A disk that has just started says so to everyone, so every copy knows
      // who can be seated; the host answers that one seat with the table.
      case 'hello':
        if (!inRoom(from)) break;
        running.add(from);
        if (!amHost()) break;
        room.send({ t: 'run', ids: runners() }, { to: from });
        if (S.g > 0) room.send(wire(now), { to: from });
        break;
      // Who else has the disk running, so a lobby that started late lists them.
      case 'run':
        if (amHost() || !fromHost(from) || !Array.isArray(msg.ids) || msg.ids.length > 8) break;
        for (const id of msg.ids) if (Number.isInteger(id) && inRoom(id)) running.add(id);
        break;
      case 'aim': {
        if (!amHost() || from === myId() || msg.g !== S.g || msg.v !== S.v) break;
        if (!['f', 'l', 'r', 'n'].includes(msg.k) || typeof msg.lk !== 'boolean') break;
        const x = msg.k === 'f' ? msg.x : 0, y = msg.k === 'f' ? msg.y : 0;
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) break;
        if (Math.abs(x) > 10 || Math.abs(y) > 10) break;
        running.add(from);
        hostChoose(from, msg.k, x, y, msg.lk, now);
        break;
      }
      case 'start':
        if (amHost() && inRoom(from)) { running.add(from); hostDeal(); }
        break;
      case 'st': {
        if (amHost() || !fromHost(from)) break;
        const t = tableOf(msg);
        if (!t) break;
        S = t.T;
        endAt = now + t.ms;
        observe(now);
        break;
      }
      case 'rdy':
        if (amHost() || !fromHost(from) || msg.g !== S.g || msg.v !== S.v || S.ph !== 'plan') break;
        if (!Array.isArray(msg.ids) || msg.ids.length > MAX_SEATS || !msg.ids.every((id) => seatOf(id))) break;
        S.rdy = msg.ids.slice();
        observe(now);
        break;
      case 'go': {
        if (amHost() || !fromHost(from)) break;
        const go = goOf(msg);
        if (go) playVolley(go, now);
        break;
      }
    }
  } catch (e) {
    // A message that breaks this handler is the sender's problem, never the table's.
  }
});

room.on('join', (p) => { nicks.set(p.id, p.nick); });

// A seat that drops comes back under the same id with its disk still
// running, and says nothing new; so `running` is never pruned on a leave.
// Whoever is not in the room is filtered out wherever it is read.
room.on('leave', (p) => {
  nicks.set(p.id, p.nick);
  buckets.delete(p.id);
});

room.on('hostchange', () => {
  sentKey = '';
  // The new host may have started after me and never heard my hello.
  if (!amHost() && room.host) room.send({ t: 'hello' }, { to: room.host.id });
  if (!amHost() || S.g === 0) return;
  // The choices went to the old host and left with it. The volley on the
  // table is chosen again on a fresh clock; every copy that had chosen sends
  // its choice again when it sees the new host's table.
  const now = performance.now();
  choices.clear();
  botAt.clear();
  if (S.ph === 'plan') {
    S.rdy = [];
    endAt = now + PLAN_MS;
    for (const r of S.s) if (isBot(r[0])) botAt.set(r[0], now + 1500 + Math.random() * 3000);
    if (mine && mine.g === S.g && mine.v === S.v) hostChoose(myId(), mine.k, mine.x, mine.y, mine.lk, now);
  } else if (S.ph === 'fly') {
    endAt = Math.min(endAt, now + 1500);
  }
  publish(now);
});

// ── my moves ────────────────────────────────────────────────────────────────

const canChoose = () => S.ph === 'plan' && !anim && !!mySeat() && !S.rdy.includes(myId()) &&
  !(mine && mine.g === S.g && mine.v === S.v && mine.lk);

function sendMine() {
  if (sendTimer) return;
  // At most four a second, the last choice always going out: somebody
  // re-aiming quickly is never cut off by the host's bucket.
  const wait = Math.max(0, lastSend + 250 - performance.now());
  sendTimer = setTimeout(() => {
    sendTimer = null;
    lastSend = performance.now();
    if (!mine || mine.g !== S.g || mine.v !== S.v || !room.host || amHost()) return;
    room.send({ t: 'aim', g: mine.g, v: mine.v, k: mine.k, x: mine.x, y: mine.y, lk: mine.lk }, { to: room.host.id });
    sentKey = room.host.id + ':' + mine.g + ':' + mine.v + ':' + mine.n;
  }, wait);
}

function choose(k, x, y, lk) {
  if (!canChoose()) return;
  const n = mine && mine.g === S.g && mine.v === S.v ? mine.n + 1 : 1;
  mine = { g: S.g, v: S.v, k, x, y, lk, n };
  if (amHost()) hostChoose(myId(), k, x, y, lk, performance.now());
  else sendMine();
}

function lockIn() {
  if (!canChoose()) return;
  audio();
  const m = mine && mine.g === S.g && mine.v === S.v ? mine : { k: 'n', x: 0, y: 0 };
  choose(m.k, m.x, m.y, true);
  sfx.lock();
}

function slide(k) {
  if (!canChoose()) return;
  audio();
  // A slot another station holds is no place to slide to.
  const r = mySeat();
  const to = (r[1] + (k === 'l' ? 1 : SLOTS - 1)) % SLOTS;
  if (S.s.some((o) => o !== r && present(o[0]) && o[1] === to)) { sfx.no(); return; }
  if (mine && mine.g === S.g && mine.v === S.v && mine.k === k) choose('n', 0, 0, false);
  else choose(k, 0, 0, false);
  sfx.slide();
}

function startGame() {
  const now = performance.now();
  if (!canDeal(now)) return;
  audio();
  sfx.click();
  if (amHost()) hostDeal();
  else if (room.host) room.send({ t: 'start' }, { to: room.host.id });
}

// ── what happened, for effects ──────────────────────────────────────────────

let seenKey = '';
let seenRdy = new Set();
let planAt = -1e9;
let preview = [];                // dotted paths of the junk for the volley ahead
let anim = null;                 // the volley being drawn

function observe(now) {
  const key = S.g + ':' + S.v + ':' + S.ph;
  if (key !== seenKey) {
    const was = seenKey;
    seenKey = key;
    if (S.ph === 'plan') {
      planAt = now;
      preview = S.b.map((r) => ({ c: r[4], h: r[5], p: path(r[0] / Q, r[1] / Q, r[2] / Q, r[3] / Q, STEPS, 3) }));
      if (was) sfx.plan();
    }
    if (S.ph === 'over') { overAt = now; if (was) setTimeout(celebrate, anim ? Math.max(0, anim.end - now) : 0); }
    seenRdy = new Set();
  }
  if (mine && (mine.g !== S.g || mine.v !== S.v)) mine = null;
  if (S.ph === 'plan' && S.rdy.some((id) => id !== myId() && !seenRdy.has(id))) sfx.tick();
  seenRdy = new Set(S.rdy);
  // A new host never saw my choice: send it again, once per host and change.
  if (!amHost() && S.ph === 'plan' && mine && room.host && !S.rdy.includes(myId())) {
    if (sentKey !== room.host.id + ':' + mine.g + ':' + mine.v + ':' + mine.n) sendMine();
  }
}

// The volley is replayed here from the table it started from. A copy that
// holds some other table does not guess: it shows the host's result when it
// lands.
function playVolley(go, now) {
  if (go.g !== S.g || go.v !== S.v || tableHash(S) !== go.h) return;
  const pre = { g: S.g, v: S.v, s: S.s.map((r) => r.slice()), b: S.b, rdy: [], pr: S.pr };
  const res = simulate(pre, go.in, go.live, true);
  const evs = res.ev.slice().sort((a, b) => a.s - b.s);
  anim = { pre, res, evs, ei: 0, start: now, end: now + STEPS / RATE * 1000, live: go.live };
  if (go.in.some((i) => i[1] === 'f')) sfx.launch(go.in.filter((i) => i[1] === 'f').length);
  for (const i of go.in) {
    const r = pre.s.find((x) => x[0] === i[0]);
    if (r && i[1] === 'f') { const p = toScreen(SX[r[1]], SY[r[1]]); burst(p[0], p[1], colorOfC(r[4]), 8, 90); }
  }
}

// ── sound ───────────────────────────────────────────────────────────────────

let ac = null;
let muted = false;
function audio() {
  try {
    if (!ac) {
      const A = window.AudioContext || window.webkitAudioContext;
      if (A) ac = new A();
    }
    if (ac && ac.state === 'suspended') ac.resume();
  } catch (e) { ac = null; }
}
function tone(f, d, type, v, f2, delay) {
  if (muted || !ac) return;
  try {
    const t = ac.currentTime + (delay || 0);
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v || 0.08, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t);
    o.stop(t + d + 0.03);
  } catch (e) { /* a sound is never worth an error */ }
}
const sfx = {
  click: () => tone(700, 0.06, 'triangle', 0.06),
  no: () => tone(180, 0.12, 'square', 0.04, 140),
  lock: () => { tone(520, 0.07, 'square', 0.035); tone(780, 0.09, 'triangle', 0.05, null, 0.06); },
  slide: () => tone(330, 0.14, 'sine', 0.06, 495),
  aim: () => tone(880, 0.04, 'sine', 0.03),
  tick: () => tone(1250, 0.03, 'square', 0.025),
  plan: () => tone(260, 0.18, 'triangle', 0.05, 390),
  launch: (n) => { for (let i = 0; i < Math.min(n, 4); i++) tone(180 + i * 30, 0.32, 'sawtooth', 0.035, 900, i * 0.025); },
  clash: () => tone(1500, 0.08, 'square', 0.03, 600),
  sun: () => tone(120, 0.2, 'sawtooth', 0.03, 60),
  hit: () => { tone(160, 0.22, 'square', 0.07, 60); tone(90, 0.3, 'sine', 0.09, 40); },
  ko: () => { tone(110, 0.5, 'sawtooth', 0.08, 35); tone(70, 0.6, 'square', 0.06, 30, 0.04); },
  score: () => tone(990, 0.1, 'triangle', 0.05, 1480),
  fanfare: () => [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.06, null, i * 0.11)),
};

// ── the screen ──────────────────────────────────────────────────────────────

document.documentElement.style.cssText = 'height:100%;background:' + C.bg1;
document.body.style.cssText =
  'margin:0;height:100%;overflow:hidden;background:' + C.bg1 + ';touch-action:none;' +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none';
const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

let W = 640, H = 400, DPR = 1;
let wide = false;
let L = { cx: 320, cy: 200, R: 150 };       // the field on screen
function layout() {
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  W = cv.clientWidth || window.innerWidth || 640;
  H = cv.clientHeight || window.innerHeight || 400;
  cv.width = Math.round(W * DPR);
  cv.height = Math.round(H * DPR);
  makeStars();
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); };
const back = (t) => { t = clamp(t, 0, 1); const k = 1.7; return 1 + (k + 1) * (t - 1) ** 3 + k * (t - 1) ** 2; };

function rr(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function font(size, weight) { ctx.font = (weight || 600) + ' ' + Math.round(size) + 'px ' + FONT; }
function text(s, x, y, size, color, align, weight, maxW) {
  font(size, weight);
  if (maxW) {
    const w = ctx.measureText(s).width;
    if (w > maxW) font(Math.max(8, size * maxW / w), weight);
  }
  ctx.fillStyle = color;
  ctx.textAlign = align || 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}
function clip(s, size, maxW, weight) {
  font(size, weight || 600);
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

// The view turns so my own station sits at the bottom of the field, where a
// thumb can pull back from it. Drawing only: the sky itself never turns.
let view = 0, viewTo = 0;
const slotAngle = (k) => k * Math.PI * 2 / SLOTS;
function toScreen(x, y) {
  const c = Math.cos(-view), s = Math.sin(-view);
  return [L.cx + (x * c - y * s) * L.R, L.cy + (x * s + y * c) * L.R];
}
function toWorldVec(dx, dy) {
  const c = Math.cos(view), s = Math.sin(view);
  return [(dx * c - dy * s) / L.R, (dx * s + dy * c) / L.R];
}

// ── effects ─────────────────────────────────────────────────────────────────

const parts = [];
const pops = [];
const rings = [];
let shake = 0;
let flash = 0;

function burst(x, y, color, n, speed) {
  for (let i = 0; i < n && parts.length < 400; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random() * 0.9);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: 1.1 + Math.random() * 1.1, color, r: 1.5 + Math.random() * 2.2 });
  }
}
function pop(x, y, s, color) { pops.push({ x, y, s, color, t: 0 }); }
function ring(x, y, color, size) { rings.push({ x, y, color, size, t: 0 }); }

function stepFx(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.vx *= 1 - 2 * dt;
    p.vy *= 1 - 2 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= p.decay * dt;
    if (p.life <= 0) parts.splice(i, 1);
  }
  for (let i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; if (pops[i].t > 1.4) pops.splice(i, 1); }
  for (let i = rings.length - 1; i >= 0; i--) { rings[i].t += dt; if (rings[i].t > 0.7) rings.splice(i, 1); }
  shake = Math.max(0, shake - 28 * dt);
  flash = Math.max(0, flash - 2.5 * dt);
}

function celebrate() {
  sfx.fanfare();
  const top = standings()[0];
  const color = top ? colorOf(top[0]) : C.gold;
  for (let i = 0; i < 5; i++) burst(W * (0.15 + 0.7 * Math.random()), H * (0.25 + 0.4 * Math.random()), i % 2 ? color : C.gold, 26, 240);
}

// Effects of a volley come from its replay, as the replay passes each step.
function fxEvent(e, pre) {
  const p = toScreen(e.x, e.y);
  if (e.k === 'clash') { burst(p[0], p[1], '#ffffff', 10, 120); ring(p[0], p[1], '#ffffff', 16); sfx.clash(); }
  else if (e.k === 'sun') { burst(p[0], p[1], C.sun, 8, 70); sfx.sun(); }
  else if (e.k === 'fizz') { burst(p[0], p[1], C.junk, 6, 40); }
  else if (e.k === 'hit' || e.k === 'ko') {
    const r = pre.s.find((x) => x[0] === e.id);
    const col = r ? colorOfC(r[4]) : C.junk;
    burst(p[0], p[1], col, e.k === 'ko' ? 40 : 18, e.k === 'ko' ? 220 : 140);
    burst(p[0], p[1], '#ffffff', 8, 100);
    ring(p[0], p[1], col, e.k === 'ko' ? 46 : 28);
    if (e.k === 'ko') sfx.ko(); else sfx.hit();
    const meHit = e.id === myId();
    shake = Math.max(shake, meHit ? 12 : e.k === 'ko' ? 7 : 4);
    if (meHit) flash = 1;
    if (e.p > 0 && e.o !== null) {
      pop(p[0], p[1] - 26, '+' + e.p + (e.k === 'ko' ? ' KO' : ''), colorOf(e.o));
      setTimeout(sfx.score, 120);
    } else if (e.k === 'ko') {
      pop(p[0], p[1] - 26, 'KO', C.junk);
    }
  }
}

// ── stars ───────────────────────────────────────────────────────────────────

let stars = [];
function makeStars() {
  stars = [];
  const n = Math.round(W * H / 2600);
  let seed = 1234567;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) stars.push({ x: rnd() * W, y: rnd() * H, r: rnd() * 1.3 + 0.3, a: rnd() * 0.6 + 0.2, p: rnd() * 6.28 });
}

// ── layout of the screen ────────────────────────────────────────────────────

const PAD = 12;
let btns = [];
let press = '';
let aim = null;                  // { x0, y0, x, y } while pulling back

function hudGeom() {
  wide = W > H * 1.25 && W >= 560;
  const n = Math.max(1, S.s.length);
  if (wide) {
    const side = Math.min(190, W * 0.24);
    const top = 50, bottom = 40;
    const R = Math.max(40, Math.min((W - 2 * side - 2 * PAD) / 2, (H - top - bottom) / 2) - 4);
    // Eight seats still fit down the side of a short screen.
    const chipH = Math.max(24, Math.min(40, (H - top - 8) / n - 6));
    return { side, top, bottom, chipH, cols: 1, R, cx: W / 2, cy: top + (H - top - bottom) / 2 };
  }
  const cols = Math.max(2, Math.min(4, Math.floor((W - 2 * PAD) / 112)));
  const rows = Math.ceil(n / cols);
  const chipH = 34;
  const top = 46 + rows * (chipH + 6) + 4;
  const bottom = 92;
  const R = Math.max(40, Math.min((W - 2 * PAD) / 2, (H - top - bottom) / 2) - 4);
  return { side: 0, top, bottom, chipH, cols, R, cx: W / 2, cy: top + (H - top - bottom) / 2 };
}

// ── drawing ─────────────────────────────────────────────────────────────────

function drawBackground(now) {
  const g = ctx.createRadialGradient(L.cx, L.cy, L.R * 0.1, L.cx, L.cy, Math.max(W, H) * 0.8);
  g.addColorStop(0, C.bg0);
  g.addColorStop(1, C.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (const s of stars) {
    ctx.globalAlpha = s.a * (0.7 + 0.3 * Math.sin(now / 900 + s.p));
    ctx.fillStyle = '#dfe4ff';
    ctx.fillRect(s.x, s.y, s.r, s.r);
  }
  ctx.globalAlpha = 1;
}

function drawSun(now) {
  const r = SUN_R * L.R;
  const pulse = 1 + 0.05 * Math.sin(now / 500);
  const g = ctx.createRadialGradient(L.cx, L.cy, r * 0.2, L.cx, L.cy, r * 3.6 * pulse);
  g.addColorStop(0, 'rgba(255,214,120,0.55)');
  g.addColorStop(0.35, 'rgba(255,150,70,0.18)');
  g.addColorStop(1, 'rgba(255,120,60,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(L.cx, L.cy, r * 3.6 * pulse, 0, 6.2832); ctx.fill();
  const c = ctx.createRadialGradient(L.cx - r * 0.3, L.cy - r * 0.3, r * 0.1, L.cx, L.cy, r);
  c.addColorStop(0, C.sunCore);
  c.addColorStop(1, C.sun);
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(L.cx, L.cy, r, 0, 6.2832); ctx.fill();
}

function drawRing() {
  ctx.strokeStyle = 'rgba(160,170,230,0.13)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 6]);
  ctx.beginPath(); ctx.arc(L.cx, L.cy, RING * L.R, 0, 6.2832); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(160,170,230,0.22)';
  for (let k = 0; k < SLOTS; k++) {
    const p = toScreen(SX[k], SY[k]);
    ctx.beginPath(); ctx.arc(p[0], p[1], 2, 0, 6.2832); ctx.fill();
  }
  // The edge of the field: past it a body is gone for good.
  ctx.strokeStyle = 'rgba(160,170,230,0.08)';
  ctx.beginPath(); ctx.arc(L.cx, L.cy, L.R, 0, 6.2832); ctx.stroke();
}

function drawStation(x, y, color, o) {
  const r = SHIP_R * L.R;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  const sc = o.scale || 1;
  ctx.scale(sc, sc);
  if (o.glow) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
  // Shield pips as arcs around the hull.
  const sh = o.sh === undefined ? SHIELDS : o.sh;
  ctx.lineWidth = Math.max(2, r * 0.18);
  ctx.lineCap = 'round';
  for (let i = 0; i < SHIELDS; i++) {
    const a0 = -Math.PI / 2 + i * (Math.PI * 2 / SHIELDS) + 0.25;
    const a1 = a0 + Math.PI * 2 / SHIELDS - 0.5;
    ctx.strokeStyle = i < sh ? alpha(color, 0.9) : 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.arc(0, 0, r * 1.45, a0, a1); ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = o.hurt ? '#ffffff' : color;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.2832); ctx.fill();
  ctx.fillStyle = 'rgba(8,10,28,0.55)';
  ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, 6.2832); ctx.fill();
  if (o.heavy) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, 6.2832); ctx.stroke();
  }
  ctx.restore();
  if (o.crown) drawCrown(x, y - r * 2.3 * (o.scale || 1), r * 0.9);
}

function drawCrown(x, y, s) {
  ctx.fillStyle = C.gold;
  ctx.beginPath();
  ctx.moveTo(x - s, y + s * 0.5);
  ctx.lineTo(x - s, y - s * 0.4);
  ctx.lineTo(x - s * 0.5, y + s * 0.05);
  ctx.lineTo(x, y - s * 0.6);
  ctx.lineTo(x + s * 0.5, y + s * 0.05);
  ctx.lineTo(x + s, y - s * 0.4);
  ctx.lineTo(x + s, y + s * 0.5);
  ctx.closePath();
  ctx.fill();
}

function drawBody(x, y, c, h, a) {
  const r = Math.max(2.2, (h ? HEAVY_R : SHOT_R) * L.R);
  const col = colorOfC(c);
  ctx.globalAlpha = a;
  ctx.fillStyle = alpha(col, 0.25);
  ctx.beginPath(); ctx.arc(x, y, r * 2, 0, 6.2832); ctx.fill();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
  if (h) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2; ctx.stroke(); }
  ctx.globalAlpha = 1;
}

function drawPath(p, color, a0, width, dash) {
  if (p.length < 4) return;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);
  const n = p.length / 2;
  const seg = 6;
  for (let s = 0; s < seg; s++) {
    const i0 = Math.floor(s * n / seg), i1 = Math.min(n - 1, Math.floor((s + 1) * n / seg));
    if (i1 <= i0) continue;
    ctx.strokeStyle = alpha(color, a0 * (1 - s / seg));
    ctx.beginPath();
    let q = toScreen(p[i0 * 2], p[i0 * 2 + 1]);
    ctx.moveTo(q[0], q[1]);
    for (let i = i0 + 1; i <= i1; i++) { q = toScreen(p[i * 2], p[i * 2 + 1]); ctx.lineTo(q[0], q[1]); }
    ctx.stroke();
  }
  if (dash) ctx.setLineDash([]);
}

// The table as it stands, between volleys.
function drawTable(now) {
  const planning = S.ph === 'plan';
  if (planning) for (const pv of preview) drawPath(pv.p, colorOfC(pv.c), 0.32, pv.h ? 2 : 1.2, [2, 4]);
  for (const b of S.b) {
    const p = toScreen(b[0] / Q, b[1] / Q);
    drawBody(p[0], p[1], b[4], b[5], 1);
  }
  const me = mySeat();
  let ghost = null;
  for (const r of S.s) {
    // A station that broke up is gone until the next volley rebuilds it.
    if (!present(r[0]) || r[2] <= 0) continue;
    const p = toScreen(SX[r[1]], SY[r[1]]);
    const isMe = r[0] === myId();
    const born = back((now - planAt) / 450);
    drawStation(p[0], p[1], colorOfC(r[4]), {
      sh: r[2], heavy: r[5] === 1, crown: r[6] === 1, glow: isMe,
      scale: planning ? 0.6 + 0.4 * born : 1,
    });
    if (planning && S.rdy.includes(r[0])) {
      ctx.strokeStyle = alpha(colorOfC(r[4]), 0.6);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p[0], p[1], SHIP_R * L.R * 2.1, 0, 6.2832); ctx.stroke();
    }
    if (isMe && planning && mine && mine.g === S.g && mine.v === S.v && (mine.k === 'l' || mine.k === 'r')) {
      ghost = { k: (r[1] + (mine.k === 'l' ? 1 : SLOTS - 1)) % SLOTS, c: r[4] };
    }
  }
  if (ghost) {
    const p = toScreen(SX[ghost.k], SY[ghost.k]);
    drawStation(p[0], p[1], colorOfC(ghost.c), { alpha: 0.35 + 0.15 * Math.sin(now / 160), sh: 0 });
  }
  // My aim: the first stretch of where the shot will go if nothing is in the way.
  if (planning && me) {
    let v = null;
    if (aim) v = aimVec();
    else if (mine && mine.g === S.g && mine.v === S.v && mine.k === 'f') v = [mine.x, mine.y];
    if (v) {
      const m = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
      const x0 = SX[me[1]] + v[0] / m * 0.08, y0 = SY[me[1]] + v[1] / m * 0.08;
      const p = path(x0, y0, v[0], v[1], 80, 2);
      p.unshift(x0, y0);
      drawPath(p, colorOfC(me[4]), aim ? 0.95 : 0.7, me[5] ? 3.5 : 2.5, [6, 5]);
    }
  }
}

// A volley in flight, drawn from its replay between the recorded steps.
function drawVolley(now) {
  const a = anim;
  const f = clamp((now - a.start) / 1000 * RATE, 0, STEPS);
  const i0 = Math.floor(f), i1 = Math.min(STEPS, i0 + 1), u = f - i0;
  while (a.ei < a.evs.length && a.evs[a.ei].s <= f) fxEvent(a.evs[a.ei++], a.pre);
  const F = a.res.frames;
  const fa = F[i0], fb = F[i1];
  const n = a.res.meta.length;
  // Trails first, from a few steps back.
  for (let i = 0; i < n; i++) {
    const m = a.res.meta[i];
    const col = colorOfC(m.c);
    ctx.lineWidth = m.h ? 2.4 : 1.6;
    ctx.lineCap = 'round';
    let prev = null;
    for (let k = 12; k >= 0; k -= 2) {
      const j = i0 - k;
      if (j < 0) continue;
      const fr = F[j];
      if (!fr[i * 3 + 2]) { prev = null; continue; }
      const q = toScreen(fr[i * 3], fr[i * 3 + 1]);
      if (prev) {
        ctx.strokeStyle = alpha(col, 0.5 * (1 - k / 14));
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      }
      prev = q;
    }
  }
  for (let i = 0; i < n; i++) {
    if (!fa[i * 3 + 2]) continue;
    let x = fa[i * 3], y = fa[i * 3 + 1];
    if (fb[i * 3 + 2]) { x += (fb[i * 3] - x) * u; y += (fb[i * 3 + 1] - y) * u; }
    const p = toScreen(x, y);
    drawBody(p[0], p[1], a.res.meta[i].c, a.res.meta[i].h, 1);
  }
  // Stations, sliding where they slid, gone where they broke.
  for (const mv of a.res.moves) {
    if (!mv.here) continue;
    const r = a.pre.s.find((x) => x[0] === mv.id);
    if (!r) continue;
    const st = { slot: mv.slot, to: mv.to };
    const pa = shipAt(st, f);
    const p = toScreen(pa[0], pa[1]);
    let sh = r[2];
    let hurt = false;
    for (const e of a.evs) {
      if ((e.k === 'hit' || e.k === 'ko') && e.id === mv.id && e.s <= f) { sh--; if (f - e.s < 6) hurt = true; }
    }
    if (mv.dead >= 0 && f >= mv.dead) continue;
    drawStation(p[0], p[1], colorOfC(r[4]), { sh: Math.max(0, sh), heavy: r[5] === 1, crown: r[6] === 1, glow: mv.id === myId(), hurt });
  }
}

function drawFx() {
  for (const r of rings) {
    const t = r.t / 0.7;
    ctx.strokeStyle = alpha(r.color, 0.8 * (1 - t));
    ctx.lineWidth = 2.5 * (1 - t) + 0.5;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.size * easeOut(t) + 4, 0, 6.2832); ctx.stroke();
  }
  for (const p of parts) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const p of pops) {
    const t = p.t / 1.4;
    ctx.globalAlpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
    const s = back(p.t / 0.3);
    text(p.s, p.x, p.y - 26 * easeOut(t), 18 * s, p.color, 'center', 800);
  }
  ctx.globalAlpha = 1;
}

function button(id, label, x, y, w, h, enabled, style) {
  const pressed = press === id;
  ctx.save();
  ctx.globalAlpha = enabled ? 1 : 0.4;
  rr(x, y + (pressed ? 2 : 0), w, h, h / 2);
  if (style === 'primary') ctx.fillStyle = C.gold;
  else if (style === 'on') ctx.fillStyle = 'rgba(255,207,90,0.22)';
  else ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fill();
  if (style !== 'primary') { ctx.strokeStyle = style === 'on' ? C.gold : C.line; ctx.lineWidth = 1.5; ctx.stroke(); }
  text(label, x + w / 2, y + h / 2 + (pressed ? 2 : 0), Math.min(17, h * 0.4), style === 'primary' ? C.goldDeep : C.text, 'center', 800, w - 18);
  ctx.restore();
  if (enabled) btns.push({ id, x, y, w, h });
}

function drawMute() {
  const s = 30, x = W - PAD - s, y = 8;
  ctx.save();
  rr(x, y, s, s, s / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fill();
  ctx.fillStyle = muted ? C.faint : C.dim;
  ctx.beginPath();
  ctx.moveTo(x + 8, y + 12); ctx.lineTo(x + 12, y + 12); ctx.lineTo(x + 17, y + 8);
  ctx.lineTo(x + 17, y + 22); ctx.lineTo(x + 12, y + 18); ctx.lineTo(x + 8, y + 18);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = muted ? C.red : C.dim;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (muted) { ctx.moveTo(x + 19, y + 11); ctx.lineTo(x + 25, y + 19); ctx.moveTo(x + 25, y + 11); ctx.lineTo(x + 19, y + 19); }
  else { ctx.arc(x + 17, y + 15, 5, -0.9, 0.9); ctx.moveTo(x + 23.5, y + 9.5); ctx.arc(x + 17, y + 15, 8.5, -0.85, 0.85); }
  ctx.stroke();
  ctx.restore();
  btns.push({ id: 'mute', x: x - 6, y: y - 6, w: s + 12, h: s + 12 });
}

function standings() {
  return S.s.slice().sort((a, b) => b[3] - a[3] || a[4] - b[4]);
}

// Scores during a volley count up as its hits land.
function liveScore(r, now) {
  if (!anim || now >= anim.end) return r[3];
  const pre = anim.pre.s.find((x) => x[0] === r[0]);
  if (!pre) return r[3];
  const f = (now - anim.start) / 1000 * RATE;
  let sc = pre[3];
  for (const e of anim.evs) if ((e.k === 'hit' || e.k === 'ko') && e.o === r[0] && e.s <= f) sc += e.p;
  return sc;
}

function drawChip(r, x, y, w, h, now) {
  const col = colorOfC(r[4]);
  const here = present(r[0]);
  ctx.save();
  ctx.globalAlpha = here ? 1 : 0.4;
  rr(x, y, w, h, 9);
  ctx.fillStyle = r[0] === myId() ? alpha(col, 0.2) : 'rgba(255,255,255,0.05)';
  ctx.fill();
  if (S.ph === 'plan' && S.rdy.includes(r[0])) { ctx.strokeStyle = alpha(col, 0.8); ctx.lineWidth = 1.5; ctx.stroke(); }
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(x + 13, y + h / 2, 6, 0, 6.2832); ctx.fill();
  const sc = String(liveScore(r, now));
  font(15, 800);
  const sw = ctx.measureText(sc).width;
  const nameW = w - 30 - sw - 14 - (r[6] ? 16 : 0) - (r[5] ? 14 : 0);
  text(clip(nickOf(r[0]), 13, Math.max(10, nameW)), x + 25, y + h / 2, 13, C.text, 'left', 600);
  let ix = x + w - 10 - sw - 6;
  if (r[6]) { drawCrown(ix - 7, y + h / 2, 6); ix -= 16; }
  if (r[5]) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(ix - 5, y + h / 2, 4.5, 0, 6.2832); ctx.stroke(); }
  text(sc, x + w - 10, y + h / 2, 15, C.text, 'right', 800);
  ctx.restore();
}

function drawHud(now, G) {
  // Volley and clock along the top.
  const plan = S.ph === 'plan';
  const v = S.v;
  let label = '';
  if (S.ph === 'plan') label = 'VOLLEY ' + v + ' / ' + VOLLEYS;
  else if (S.ph === 'fly') label = 'VOLLEY ' + v + ' IN FLIGHT';
  if (label) text(label, PAD, 23, 14, C.dim, 'left', 800);
  if (S.v >= VOLLEYS - 1 && (S.ph === 'plan' || S.ph === 'fly')) {
    font(14, 800);
    const lw = ctx.measureText(label).width;
    const bx = PAD + lw + 10;
    rr(bx, 13, 74, 20, 10);
    ctx.fillStyle = alpha(C.gold, 0.2 + 0.1 * Math.sin(now / 200));
    ctx.fill();
    text('DOUBLE', bx + 37, 23.5, 12, C.gold, 'center', 800);
  }
  if (plan) {
    const left = Math.max(0, endAt - now);
    const t = left / PLAN_MS;
    const bw = W - 2 * PAD - 44;
    rr(PAD, 38, bw, 4, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();
    rr(PAD, 38, Math.max(4, bw * t), 4, 2);
    ctx.fillStyle = left < 3000 ? C.red : C.gold;
    ctx.fill();
    const secs = Math.ceil(left / 1000);
    text(String(secs), W - PAD - 42 - 4, 23, 14, left < 3000 ? C.red : C.text, 'right', 800);
    if (secs !== lastSec) { lastSec = secs; if (secs <= 3 && secs > 0) sfx.tick(); }
  }
  // Seats.
  const list = S.s.slice().sort((a, b) => liveScore(b, now) - liveScore(a, now) || a[4] - b[4]);
  if (G.side) {
    const w = G.side - PAD - 6;
    list.forEach((r, i) => drawChip(r, PAD, G.top + i * (G.chipH + 6), w, G.chipH, now));
  } else {
    const cols = G.cols;
    const w = (W - 2 * PAD - (cols - 1) * 6) / cols;
    list.forEach((r, i) => drawChip(r, PAD + (i % cols) * (w + 6), 48 + Math.floor(i / cols) * (G.chipH + 6), w, G.chipH, now));
  }
}
let lastSec = 0;

function hint() {
  if (S.ph === 'plan') {
    if (!mySeat()) return 'You join at the next volley.';
    if (S.rdy.includes(myId())) return 'Locked in. Waiting for the others.';
    return 'Pull back and let go to aim. Or slide to dodge. Then lock in.';
  }
  if (S.ph === 'fly') return 'Every miss stays up there.';
  return '';
}

function drawControls(now, G) {
  const h = hint();
  const me = mySeat();
  const can = canChoose();
  const cur = mine && mine.g === S.g && mine.v === S.v ? mine.k : 'n';
  if (G.side) {
    const x = W - G.side + 6, w = G.side - PAD - 6;
    if (S.ph === 'plan' && me) {
      let y = G.top;
      button('l', '◀ Slide', x, y, w, 44, can, cur === 'l' ? 'on' : '');
      button('r', 'Slide ▶', x, y + 52, w, 44, can, cur === 'r' ? 'on' : '');
      button('lock', S.rdy.includes(myId()) ? 'Locked' : 'Lock in', x, y + 104, w, 50, can, 'primary');
      const what = cur === 'f' ? 'Shot set' : cur === 'l' || cur === 'r' ? 'Sliding' : 'Holding';
      text(what, x + w / 2, y + 172, 13, C.dim, 'center', 600);
    }
    if (h) text(h, W / 2, H - 20, 13, C.dim, 'center', 600, W - 2 * G.side);
  } else {
    if (h) text(h, W / 2, H - G.bottom + 16, 13, C.dim, 'center', 600, W - 2 * PAD);
    if (S.ph === 'plan' && me) {
      const y = H - G.bottom + 34, bh = 46;
      const gap = 8;
      const total = Math.min(W - 2 * PAD, 440);
      const sw = (total - 2 * gap) * 0.3, lw = total - 2 * gap - 2 * sw;
      const x0 = (W - total) / 2;
      button('l', '◀ Slide', x0, y, sw, bh, can, cur === 'l' ? 'on' : '');
      button('lock', S.rdy.includes(myId()) ? 'Locked' : cur === 'f' ? 'Lock shot' : cur === 'n' ? 'Hold' : 'Lock slide', x0 + sw + gap, y, lw, bh, can, 'primary');
      button('r', 'Slide ▶', x0 + sw + gap + lw + gap, y, sw, bh, can, cur === 'r' ? 'on' : '');
    }
  }
}

function panel(w, h) {
  const x = (W - w) / 2, y = (H - h) / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 24;
  rr(x, y, w, h, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.restore();
  rr(x, y, w, h, 18);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  return { x, y };
}

function drawLobby(now) {
  // A slow demo sky behind the card: cosmetic, timed by the clock, not a game.
  for (let i = 0; i < 9; i++) {
    const rad = 0.3 + 0.07 * i;
    const w = Math.sqrt(GM / (rad * rad * rad)) * 0.35;
    const a = now / 1000 * w * (i % 2 ? 1 : -1) + i * 1.7;
    const p = toScreen(Math.cos(a) * rad, Math.sin(a) * rad);
    drawBody(p[0], p[1], i % 3 === 0 ? -1 : i % PAL.length, 0, 0.75);
  }
  const w = Math.min(W - 2 * PAD, 400);
  const list = solo() ? [-1] : runners();
  const h = Math.min(H - 2 * PAD, 300 + Math.ceil(list.length / 2) * 24);
  const { x, y } = panel(w, h);
  text('KESSLER', x + w / 2, y + 40, 30, C.text, 'center', 900);
  text('Every miss stays in orbit.', x + w / 2, y + 70, 14, C.gold, 'center', 700);
  const lines = [
    'Everyone aims in secret, then all shots fly at once',
    'and bend around the sun. Hit a station: points.',
    'Miss, and your shot is junk that hits anyone, you too.',
    'Slide along the ring to dodge, or shoot junk down.',
  ];
  lines.forEach((s, i) => text(s, x + w / 2, y + 102 + i * 20, 13, C.dim, 'center', 500, w - 28));
  const top = y + 192;
  text(list.length < 2 ? 'Waiting for players: invite someone to this room' : 'Ready to launch', x + w / 2, top, 12, C.faint, 'center', 700, w - 28);
  list.forEach((id, i) => {
    const cx = x + w / 2 + (i % 2 ? 10 : -w / 2 + 28), cy = top + 24 + Math.floor(i / 2) * 24;
    ctx.fillStyle = PAL[i % PAL.length];
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 6.2832); ctx.fill();
    text(clip(nickOf(id), 13, w / 2 - 50), cx + 12, cy, 13, C.text, 'left', 600);
  });
  button('start', list.length < 2 ? 'Practice vs drones' : 'Launch', x + 24, y + h - 64, w - 48, 46, canDeal(now), 'primary');
}

function drawOver(now) {
  const list = standings();
  const w = Math.min(W - 2 * PAD, 380);
  const h = Math.min(H - 2 * PAD, 170 + list.length * 30);
  const { x, y } = panel(w, h);
  const top = list[0];
  const ties = top ? list.filter((r) => r[3] === top[3]) : [];
  if (ties.length > 1) text('A tie at the top', x + w / 2, y + 36, 22, C.gold, 'center', 900);
  else if (top) text(clip(nickOf(top[0]), 24, w - 120, 900) + ' wins', x + w / 2, y + 36, 24, colorOfC(top[4]), 'center', 900, w - 40);
  if (S.pr) text('Practice round', x + w / 2, y + 62, 12, C.faint, 'center', 700);
  list.forEach((r, i) => {
    const ry = y + 86 + i * 30;
    ctx.fillStyle = colorOfC(r[4]);
    ctx.beginPath(); ctx.arc(x + 32, ry, 6, 0, 6.2832); ctx.fill();
    text(clip(nickOf(r[0]), 15, w - 130), x + 46, ry, 15, C.text, 'left', 600);
    text(String(r[3]), x + w - 30, ry, 16, C.text, 'right', 800);
  });
  const ready = canDeal(now);
  button('start', ready ? 'Again' : 'Again in a moment', x + 24, y + h - 62, w - 48, 44, ready, 'primary');
}

let lastFrame = performance.now();
function frame() {
  requestAnimationFrame(frame);
  try {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    // Start every frame from a clean transform, so a frame that failed half
    // way never leaves its shake behind for the next.
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalAlpha = 1;
    if ((cv.clientWidth && cv.clientWidth !== W) || (cv.clientHeight && cv.clientHeight !== H)) layout();
    if (anim && now >= anim.end + 200) anim = null;
    stepFx(dt);
    const G = hudGeom();
    L = { cx: G.cx, cy: G.cy, R: G.R };
    const me = mySeat();
    viewTo = me && S.ph !== 'fly' && !anim ? slotAngle(me[1]) - Math.PI / 2 : viewTo;
    let d = viewTo - view;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    view += d * Math.min(1, dt * 5);
    btns = [];
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    drawBackground(now);
    drawRing();
    drawSun(now);
    if (S.ph === 'wait') {
      ctx.restore();
      drawLobby(now);
    } else {
      if (anim) drawVolley(now);
      else drawTable(now);
      drawFx();
      ctx.restore();
      if (flash > 0) { ctx.fillStyle = 'rgba(255,90,110,' + (0.25 * flash) + ')'; ctx.fillRect(0, 0, W, H); }
      drawHud(now, G);
      if (S.ph === 'over' && !anim) drawOver(now);
      else drawControls(now, G);
      if (aim && S.ph === 'plan') drawPower();
    }
    drawMute();
  } catch (e) {
    // A frame that fails is skipped; the next one draws from the same table.
  }
}

// ── input ───────────────────────────────────────────────────────────────────

// Pulling back from anywhere aims: the shot leaves the other way, faster the
// further the pull. A full pull is a fraction of the field, so a phone held
// upright has room for it.
const PULL = () => Math.max(60, L.R * 0.6);
function aimVec() {
  const dx = aim.x0 - aim.x, dy = aim.y0 - aim.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return null;
  const k = Math.min(1, len / PULL());
  const sp = VMIN + (VMAX - VMIN) * k;
  const w = toWorldVec(dx / len, dy / len);
  const m = Math.sqrt(w[0] * w[0] + w[1] * w[1]);
  return [w[0] / m * sp, w[1] / m * sp];
}

function drawPower() {
  const dx = aim.x0 - aim.x, dy = aim.y0 - aim.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const k = Math.min(1, len / PULL());
  const me = mySeat();
  const col = me ? colorOfC(me[4]) : C.gold;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(aim.x0, aim.y0); ctx.lineTo(aim.x, aim.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(aim.x, aim.y, 7, 0, 6.2832); ctx.fill();
  text(Math.round(k * 100) + '%', aim.x, aim.y - 20, 13, C.text, 'center', 800);
}

function pt(e) {
  const r = cv.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
function hitBtn(x, y) {
  for (let i = btns.length - 1; i >= 0; i--) {
    const b = btns[i];
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
  }
  return '';
}

function act(id) {
  if (id === 'mute') { muted = !muted; audio(); if (!muted) sfx.click(); return; }
  if (id === 'start') startGame();
  else if (id === 'lock') lockIn();
  else if (id === 'l' || id === 'r') slide(id);
}

let pid = null;
cv.addEventListener('pointerdown', (e) => {
  try {
    audio();
    const [x, y] = pt(e);
    const b = hitBtn(x, y);
    if (b) { press = b; pid = e.pointerId; return; }
    if (!canChoose() || anim) return;
    pid = e.pointerId;
    try { cv.setPointerCapture(e.pointerId); } catch (er) { /* not every browser lets a frame capture */ }
    aim = { x0: x, y0: y, x, y, k: 0 };
  } catch (er) { /* input never breaks the frame */ }
});
cv.addEventListener('pointermove', (e) => {
  if (e.pointerId !== pid || !aim) return;
  const [x, y] = pt(e);
  aim.x = x; aim.y = y;
  const k = Math.floor(Math.min(1, Math.hypot(aim.x0 - x, aim.y0 - y) / PULL()) * 10);
  if (k !== aim.k) { aim.k = k; sfx.aim(); }
});
function release(e, cancel) {
  if (e.pointerId !== pid) return;
  pid = null;
  if (press) {
    const [x, y] = pt(e);
    const id = press;
    press = '';
    if (!cancel && hitBtn(x, y) === id) act(id);
    return;
  }
  if (!aim) return;
  const v = cancel ? null : aimVec();
  const len = Math.hypot(aim.x0 - aim.x, aim.y0 - aim.y);
  aim = null;
  // A short tap is not an aim: it keeps whatever was chosen before.
  if (!v || len < 14 || !canChoose()) return;
  choose('f', v[0], v[1], false);
  sfx.slide();
}
cv.addEventListener('pointerup', (e) => release(e, false));
cv.addEventListener('pointercancel', (e) => release(e, true));

window.addEventListener('keydown', (e) => {
  try {
    const k = e.key;
    if (k === 'm' || k === 'M') { act('mute'); return; }
    audio();
    if (S.ph === 'wait' || S.ph === 'over') { if (k === 'Enter' || k === ' ') startGame(); return; }
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') slide('l');
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') slide('r');
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); lockIn(); }
  } catch (er) { /* input never breaks the frame */ }
});

// ── start ───────────────────────────────────────────────────────────────────

layout();
window.addEventListener('resize', layout);
setInterval(() => { try { hostTick(); } catch (e) { /* the next tick tries again */ } }, 100);
requestAnimationFrame(frame);
// Say we are here; whoever holds the table hands it over. On a test run there
// is no room and this goes nowhere.
if (room.me) running.add(room.me.id);
room.send({ t: 'hello' });
