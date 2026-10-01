/**
 * @disk     ragdoll_clash
 * @author   Bugord
 * @version  24
 * @players  1-8
 * @about    A ragdoll brawl. Push your whole body with the arrow keys or a thumb, tumble into your opponent, and knock their damage up until they come apart.
 * @tags     fighting, physics, ragdoll, pvp
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/ragdoll_clash.png
 */
// Version 24 fixes the speed: the fight used to run a step per drawn frame,
// so it went slower on a frame that took longer and faster on a screen that
// drew more of them. The steps are counted off a clock now. See the main loop.
//
// Version 20 changes what this looks like and nothing else: the arena fills
// whatever the frame gives it, and the colours are diskroom's own. The physics,
// the damage, the host's snapshots and every message on the wire are v19's,
// untouched — the fight is the same fight in every part that decides it.
//
// The world stays 960x540, because that is what the physics and the wire are
// written in. Only the drawing is stretched onto the frame, and the lettering
// is put back at the screen's own scale so it is not stretched with it.

// ───────────────────────── setup / screen ─────────────────────────
// `-webkit-touch-callout` and the selection rules are not decoration: a
// finger held still on iOS Safari is a long press, and a long press there
// selects what is under it and puts a Copy / Look Up bar over the page —
// which takes the pointer away mid-gesture and ends the hold. A drag escapes
// it because the movement cancels the press, so a game played by dragging
// never meets this; one played by holding meets it every time.
document.body.style.cssText =
  'margin:0;height:100vh;overflow:hidden;background:#1c1c1c;touch-action:none;' +
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;' +
  "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif";

// Which hand the arena writes its instructions for. A device that says its
// pointer is coarse is taken at its word to begin with, and the first finger
// that actually lands settles it. Nothing but the wording hangs on this: a
// thumb and the arrow keys both reach `setHeld()`, and the wire cannot tell
// one from the other.
let coarse = matchMedia('(pointer: coarse)').matches;

const LW = 960, LH = 540;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100%;height:100%;background:#1f1f1f';
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');

// diskroom's own tokens, copied by hand: a disk is a page of its own and
// inherits none of the stylesheet around it.
const INK = { line: '#3a3a3a', floor: '#242424', text: '#ededed',
              muted: '#8f8f8f', warn: '#d6c493', blood: '150,110,110' };
const FONT = "ui-monospace, 'SF Mono', Menlo, monospace";

let SX = 1, SY = 1, DPR = 1;
function fit() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
  canvas.width = Math.round(w * DPR);
  canvas.height = Math.round(h * DPR);
  SX = w / LW;
  SY = h / LH;
  ctx.setTransform(SX * DPR, 0, 0, SY * DPR, 0, 0);
}
addEventListener('resize', fit); fit();

// Lettering, drawn at the screen's own scale from a place in the world, so that
// stretching the arena does not stretch the words with it.
// A font for `label` no wider than the frame is. Measured at the screen's own
// scale, which is where `label` draws.
function fitted(text, size) {
  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.font = size + 'px ' + FONT;
  const wide = ctx.measureText(text).width;
  ctx.restore();
  const room = Math.max(1, (canvas.clientWidth || LW) - 16);
  return (wide > room ? Math.max(8, Math.floor((size * room) / wide)) : size) + 'px ' + FONT;
}

function label(text, wx, wy, font, colour, align) {
  ctx.save();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = align || 'center';
  ctx.fillText(text, wx * SX, wy * SY);
  ctx.restore();
}

const ARENA = { l: 40, r: LW - 40, t: 40, b: LH - 60 };

// ───────────────────────── ragdoll model ─────────────────────────
const HEAD=0, CHEST=1, PELVIS=2, LELB=3, LHAND=4, RELB=5, RHAND=6, LKNE=7, LFOOT=8, RKNE=9, RFOOT=10;
const POSE = [
  [0,-47],[0,-27],[0,0],[-20,-20],[-30,-3.3],[20,-20],[30,-3.3],[-10,26.7],[-10,53.3],[10,26.7],[10,53.3]
];
const RADIUS = [8.7,6.7,6.7, 4.7,4.7, 4.7,4.7, 4.7,4.7, 4.7,4.7];
const MASS   = [1.3,1.6,1.6, .9,.7, .9,.7, .9,.7, .9,.7];
const BONES  = [[HEAD,CHEST],[CHEST,PELVIS],[CHEST,LELB],[LELB,LHAND],[CHEST,RELB],[RELB,RHAND],
                [PELVIS,LKNE],[LKNE,LFOOT],[PELVIS,RKNE],[RKNE,RFOOT]];

const GRAV = 0.004, DAMP = 0.997, WALLBOUNCE = 0.35, MAXV = 15;
const CONSTRAINT_ITERS = 3, IMPACT_THRESH = 0.4, MAX_DAMAGE = 100;
const COMBO_WINDOW = 1100, COMBO_STEP = 0.35, COMBO_MAX = 3.5;
const THRUST = 0.2; // applied to the head every step while a direction is held
const RESPAWN_DELAY = 3000;
// Eight fighters that stay apart from one another while staying in the
// platform's key: the same muted greens, roses and sands as the rest of it.
const PALETTE = [[245,245,245],[142,142,142],[211,169,169],[169,186,211],
                 [169,192,169],[214,196,147],[196,169,211],[211,169,196]];

// One-sided "can't fold closer than this" constraints across two-bone spans —
// a cheap stand-in for joint angle limits so elbows/knees/neck can't collapse
// the limb flat onto itself and the body keeps some shape instead of going
// spaghetti. 0.55 means the pair can't get closer than 55% of its fully
// extended (pose) distance.
const ANGLE_PAIRS = [[HEAD, PELVIS, 0.6], [CHEST, LHAND, 0.55], [CHEST, RHAND, 0.55],
                      [PELVIS, LFOOT, 0.55], [PELVIS, RFOOT, 0.55], [LELB, RELB, 0.7],
                      [CHEST, LKNE, 0.78], [CHEST, RKNE, 0.78],
                      [LKNE, RKNE, 0.85], [LFOOT, RFOOT, 0.85]];

function makeRagdoll(cx, cy) {
  const particles = POSE.map((o, i) => ({ x: cx + o[0], y: cy + o[1], px: cx + o[0], py: cy + o[1], r: RADIUS[i], m: MASS[i], heat: 0 }));
  const bones = BONES.map(([a, b]) => [a, b, Math.hypot(particles[a].x - particles[b].x, particles[a].y - particles[b].y)]);
  const angleLimits = ANGLE_PAIRS.map(([a, b, f]) =>
    [a, b, Math.hypot(particles[a].x - particles[b].x, particles[a].y - particles[b].y) * f]);
  return { particles, bones, angleLimits, totalDamage: 0, exploded: false, explodedAt: 0, seq: 0 };
}

function resetRagdoll(rd, cx, cy) {
  const fresh = makeRagdoll(cx, cy);
  rd.particles = fresh.particles; rd.bones = fresh.bones; rd.angleLimits = fresh.angleLimits;
  rd.totalDamage = 0; rd.exploded = false; rd.explodedAt = 0; rd.seq++;
}

function integrate(rd) {
  for (const p of rd.particles) {
    let vx = (p.x - p.px) * DAMP, vy = (p.y - p.py) * DAMP;
    const sp = Math.hypot(vx, vy);
    if (sp > MAXV) { vx = vx / sp * MAXV; vy = vy / sp * MAXV; }
    p.px = p.x; p.py = p.y;
    p.x += vx; p.y += vy + GRAV;
  }
}

function wallCollide(p) {
  if (p.x < ARENA.l + p.r) { p.x = ARENA.l + p.r; p.px = p.x + (p.x - p.px) * WALLBOUNCE; }
  if (p.x > ARENA.r - p.r) { p.x = ARENA.r - p.r; p.px = p.x + (p.x - p.px) * WALLBOUNCE; }
  if (p.y < ARENA.t + p.r) { p.y = ARENA.t + p.r; p.py = p.y + (p.y - p.py) * WALLBOUNCE; }
  if (p.y > ARENA.b - p.r) { p.y = ARENA.b - p.r; p.py = p.y + (p.y - p.py) * WALLBOUNCE; }
}

function constrainBones(rd) {
  for (let k = 0; k < CONSTRAINT_ITERS; k++) {
    for (const [a, b, rest] of rd.bones) {
      const A = rd.particles[a], B = rd.particles[b];
      let dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      const diff = (d - rest) / d * 0.5;
      A.x += dx * diff; A.y += dy * diff;
      B.x -= dx * diff; B.y -= dy * diff;
    }
    for (const [a, b, minDist] of rd.angleLimits) {
      const A = rd.particles[a], B = rd.particles[b];
      let dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      if (d < minDist) {
        const diff = (d - minDist) / d * 0.5;
        A.x += dx * diff; A.y += dy * diff;
        B.x -= dx * diff; B.y -= dy * diff;
      }
    }
    for (const p of rd.particles) wallCollide(p);
  }
}

function applyForce(rd, dir, mag) {
  const v = dir === 'up' ? [0, -mag] : dir === 'down' ? [0, mag] :
            dir === 'left' ? [-mag, 0] : [mag, 0];
  const p = rd.particles[HEAD];
  p.px -= v[0]; p.py -= v[1];
}

// Cosmetic only — every client detects the same impacts locally from its own
// physics, so blood is spawned client-side and never sent over the network.
let blood = [];
function spawnBlood(x, y, nx, ny, energy) {
  const n = Math.min(10, 3 + Math.round(energy * 0.8));
  for (let i = 0; i < n; i++) {
    const spread = (Math.random() - 0.5) * 1.6;
    const speed = 1.5 + Math.random() * 3 + energy * 0.15;
    const ang = Math.atan2(ny, nx) + spread;
    blood.push({
      x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      r: 1.5 + Math.random() * 2, life: 1, decay: 0.012 + Math.random() * 0.01,
    });
  }
  if (blood.length > 260) blood.splice(0, blood.length - 260);
}

function updateBlood() {
  for (const d of blood) {
    d.x += d.vx; d.y += d.vy;
    d.vx *= 0.96; d.vy = d.vy * 0.96 + 0.03; // faint drag + faint settle, matches the water-like arena
    d.life -= d.decay;
  }
  blood = blood.filter(d => d.life > 0);
}

function drawBlood() {
  for (const d of blood) {
    ctx.fillStyle = `rgba(${INK.blood},${Math.max(0, d.life).toFixed(2)})`;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.fill();
  }
}

function collideRagdolls(A, B, isHost, dealDamage) {
  A.particles.forEach((a, ai) => {
    B.particles.forEach((b, bi) => {
      const minD = a.r + b.r;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      let overlapping = dist > 0 && dist < minD;

      if (!overlapping) {
        // The final positions this frame don't overlap, but a fast, small
        // limb can fly clean through the opponent within a single frame and
        // never register at all — sample a few points along each particle's
        // path this frame and catch the crossing instead.
        const STEPS = 4;
        for (let s = 1; s < STEPS; s++) {
          const t = s / STEPS;
          const ax = a.px + (a.x - a.px) * t, ay = a.py + (a.y - a.py) * t;
          const bx = b.px + (b.x - b.px) * t, by = b.py + (b.y - b.py) * t;
          const sdx = bx - ax, sdy = by - ay, sdist = Math.hypot(sdx, sdy);
          if (sdist > 0 && sdist < minD) { overlapping = true; dx = sdx; dy = sdy; dist = sdist; break; }
        }
      }
      if (!overlapping) return;

      const nx = dx / dist, ny = dy / dist;
      const invA = 1 / a.m, invB = 1 / b.m, sum = invA + invB;
      // Positions may already have separated again by the time we detect a
      // swept-through hit, so only push apart if there's real overlap left.
      const finalDx = b.x - a.x, finalDy = b.y - a.y, finalDist = Math.hypot(finalDx, finalDy);
      const overlap = Math.max(minD - finalDist, 0);
      if (overlap > 0) {
        a.x -= nx * overlap * (invA / sum); a.y -= ny * overlap * (invA / sum);
        b.x += nx * overlap * (invB / sum); b.y += ny * overlap * (invB / sum);
      }
      const avx = a.x - a.px, avy = a.y - a.py, bvx = b.x - b.px, bvy = b.y - b.py;
      const closing = -((avx - bvx) * nx + (avy - bvy) * ny);
      if (closing > IMPACT_THRESH) {
        const rest = 0.4;
        const jn = -(1 + rest) * closing / sum;
        a.px += nx * jn * invA; a.py += ny * jn * invA;
        b.px -= nx * jn * invB; b.py -= ny * jn * invB;
        const energy = closing * (a.m + b.m) * 0.5;
        a.heat = Math.min(1, a.heat + energy * 0.018);
        b.heat = Math.min(1, b.heat + energy * 0.018);
        spawnBlood((a.x + b.x) / 2, (a.y + b.y) / 2, nx, ny, energy);
        // Only the side that got hit takes damage — the limb doing the
        // swinging doesn't hurt its own owner, so throwing a punch never
        // costs you health. A genuine head-on-head collision is the one
        // exception: both sides get hurt at once. Who's "swinging" is judged
        // by each particle's own contribution to closing the gap along the
        // hit normal — not raw speed, since a limb that's merely spinning
        // fast (e.g. still tumbling from an earlier hit) isn't necessarily
        // the one closing in on this specific contact.
        if (isHost) {
          const bothHead = ai === HEAD && bi === HEAD;
          const aApproach = avx * nx + avy * ny;
          const bApproach = -(bvx * nx + bvy * ny);
          const hits = bothHead
            ? [['A', true], ['B', true]]
            : aApproach >= bApproach
              ? [['B', bi === HEAD]]  // a is doing the closing — a is the striker
              : [['A', ai === HEAD]]; // b is doing the closing — b is the striker
          dealDamage(hits, energy);
        }
      }
    });
  });
}

// ───────────────────────── roster / spawning ─────────────────────────
// One ragdoll per connected player, spawned/removed as people join or leave.
// In the studio (no room) we fall back to a single local id so movement can
// still be tested alone.
const fighters = new Map(); // id -> { rd, colorIdx, nick }
const heldState = new Map(); // id -> Set of currently-held directions (mine and everyone else's)
const G = { combo: 1, comboUntil: 0 };

function getHeld(id) {
  if (!heldState.has(id)) heldState.set(id, new Set());
  return heldState.get(id);
}

const BOT_ID = 'bot'; // practice dummy, local-only — never part of the real roster or the network

function myId() { return room.me ? room.me.id : -1; }
function nickOf(id) {
  if (id === BOT_ID) return 'Dummy';
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find(pp => pp.id === id);
  return p ? p.nick : '???';
}

function currentRosterIds() {
  const ids = room.me ? room.players.map(p => p.id) : [-1];
  if (room.me && !ids.includes(myId())) ids.push(myId());
  return ids.sort((a, b) => a - b);
}

function spawnPos(index, total) {
  const n = Math.max(total, 1);
  const x = ARENA.l + (index + 1) * (ARENA.r - ARENA.l) / (n + 1);
  return [x, ARENA.b - 80];
}

function ensureRoster() {
  const ids = currentRosterIds();
  ids.forEach((id, i) => {
    if (!fighters.has(id)) {
      const [x, y] = spawnPos(i, ids.length);
      fighters.set(id, { rd: makeRagdoll(x, y), colorIdx: i, nick: nickOf(id) });
    } else {
      fighters.get(id).colorIdx = i; // keep colours stable-ish as roster shifts
    }
  });
  for (const id of Array.from(fighters.keys())) {
    if (!ids.includes(id) && id !== BOT_ID) fighters.delete(id);
  }
  for (const id of Array.from(heldState.keys())) {
    if (!ids.includes(id) && id !== BOT_ID) heldState.delete(id);
  }
}

// A simple practice dummy that flies around in random directions, active only
// while no real opponent has joined. It's purely local — never added to the
// network roster or the host's sync snapshot — so it just vanishes for you
// the moment a second real player shows up, without anyone else ever seeing it.
const botAI = { nextChange: 0 };
function syncBot() {
  const realCount = currentRosterIds().length;
  if (realCount < 2 && !fighters.has(BOT_ID)) {
    const [x, y] = spawnPos(1, 2);
    fighters.set(BOT_ID, { rd: makeRagdoll(x, y), colorIdx: 1, nick: 'Dummy' });
    getHeld(BOT_ID);
    botAI.nextChange = 0;
  } else if (realCount >= 2 && fighters.has(BOT_ID)) {
    fighters.delete(BOT_ID);
    heldState.delete(BOT_ID);
  }
}

function updateBot(now) {
  if (!fighters.has(BOT_ID)) return;
  if (now < botAI.nextChange) return;
  const s = getHeld(BOT_ID);
  s.clear();
  const r = Math.random();
  if (r > 0.15) { // mostly keep flying, occasionally drift with no thrust
    if (Math.random() < 0.55) s.add(Math.random() < 0.5 ? 'left' : 'right');
    if (Math.random() < 0.55 || s.size === 0) s.add(Math.random() < 0.5 ? 'up' : 'down');
  }
  botAI.nextChange = now + 300 + Math.random() * 600;
}

function refreshRoster() { ensureRoster(); syncBot(); }
refreshRoster();

const CRIT_MULT = 1.8;
const DAMAGE_MULT = 1.6; // global knob — scales every hit; turn down if fights end too fast
const SINGLE_HIT_CAP = 20; // out of MAX_DAMAGE — a lone hit, however fast, can't be a one-shot
const HIT_COOLDOWN_MS = 220; // minimum gap between two damage events for the same pair of fighters
const pairCooldown = new Map(); // "idA|idB" -> timestamp of the last damage event between them
function dealDamage(rd, energy, crit) {
  const dmg = Math.min(energy * 1.4 * DAMAGE_MULT * G.combo * (crit ? CRIT_MULT : 1), SINGLE_HIT_CAP);
  rd.totalDamage += dmg;
  G.combo = Math.min(COMBO_MAX, G.combo + COMBO_STEP);
  G.comboUntil = performance.now() + COMBO_WINDOW;
  if (rd.totalDamage >= MAX_DAMAGE && !rd.exploded) explode(rd);
}

function explode(rd) {
  rd.exploded = true;
  rd.explodedAt = performance.now();
  const cx = rd.particles[PELVIS].x, cy = rd.particles[PELVIS].y;
  for (const p of rd.particles) {
    const ang = Math.atan2(p.y - cy, p.x - cx) + (Math.random() - 0.5);
    const spd = 4 + Math.random() * 6;
    p.px = p.x - Math.cos(ang) * spd;
    p.py = p.y - Math.sin(ang) * spd;
  }
}

// ───────────────────────── networking ─────────────────────────
room.send({ t: 'hello' });

room.on('join', refreshRoster);
room.on('leave', refreshRoster);
room.on('hostchange', (host) => {
  if (room.me && host === room.me.id) console.log('now hosting the fight');
});

room.on('message', (from, msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'hello') {
    if (room.isHost) room.send({ t: 'sync', full: true, ...snapshot() }, { to: from });
    return;
  }
  if (msg.t === 'hold') {
    // Whose key it is comes from the room, not from the message: a copy can
    // write any id it likes there.
    if (!DIRS.includes(msg.dir)) return;
    const s = getHeld(from);
    if (msg.on) s.add(msg.dir); else s.delete(msg.dir);
    return;
  }
  if (msg.t === 'held') {
    // The whole hand, said again every so often. A single `hold` is one
    // message, and any one message may be lost: a key-up lost that way would
    // otherwise leave the fighter pushed in that direction until the very same
    // key went down and up again.
    const s = getHeld(from);
    s.clear();
    DIRS.forEach((d, i) => { if (Number(msg.hd) & (1 << i)) s.add(d); });
    return;
  }
  if (msg.t === 'sync') {
    applySnapshot(msg, msg.full);
    return;
  }
});

const DIRS = ['up', 'down', 'left', 'right'];
function heldBitmask(id) {
  const s = getHeld(id);
  let m = 0;
  DIRS.forEach((d, i) => { if (s.has(d)) m |= 1 << i; });
  return m;
}

function snapshot() {
  const list = [];
  for (const [id, f] of fighters) {
    if (id === BOT_ID) continue; // local-only, never networked
    list.push({
      id, colorIdx: f.colorIdx, seq: f.rd.seq, hd: heldBitmask(id),
      dmg: Math.round(f.rd.totalDamage * 10) / 10, ex: f.rd.exploded,
      pt: f.rd.particles.map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10,
                                    Math.round((p.x - p.px) * 10) / 10, Math.round((p.y - p.py) * 10) / 10,
                                    Math.round(p.heat * 100) / 100]),
    });
  }
  // What is left of the combo, not when it ends: the moment it ends is a
  // reading of this frame's clock, and every frame's clock starts at a
  // different time.
  const comboLeft = Math.max(0, Math.round(G.comboUntil - performance.now()));
  return { combo: Math.round(G.combo * 100) / 100, comboLeft, list };
}

const seenSeq = new Map();
function applySnapshot(s, hard) {
  G.combo = s.combo;
  G.comboUntil = performance.now() + Math.max(0, Number(s.comboLeft) || 0);
  for (const entry of s.list) {
    // Only somebody who is in the room gets a body. A picture the host drew
    // before it heard of a departure can arrive after this copy did, and a
    // fighter made for it here would stand in the arena as a ghost until the
    // next join or leave cleared it.
    if (entry.id !== myId() && !room.players.some((p) => p.id === entry.id)) continue;
    let f = fighters.get(entry.id);
    if (!f) {
      f = { rd: makeRagdoll(entry.pt[PELVIS][0], entry.pt[PELVIS][1]), colorIdx: entry.colorIdx, nick: nickOf(entry.id) };
      fighters.set(entry.id, f);
    }
    f.colorIdx = entry.colorIdx;
    if (entry.id !== myId()) {
      const s = getHeld(entry.id);
      s.clear();
      DIRS.forEach((d, i) => { if (entry.hd & (1 << i)) s.add(d); });
    }
    const forceHard = hard || seenSeq.get(entry.id) !== entry.seq;
    seenSeq.set(entry.id, entry.seq);
    f.rd.seq = entry.seq;
    f.rd.totalDamage = entry.dmg; f.rd.exploded = entry.ex;
    entry.pt.forEach((d, i) => { f.rd.particles[i].heat = Math.max(f.rd.particles[i].heat, d[4]); });
    if (forceHard) {
      // A real teleport (late join or a respawn) — snap instantly, no smoothing.
      entry.pt.forEach((d, i) => {
        const p = f.rd.particles[i];
        p.x = d[0]; p.y = d[1]; p.px = d[0] - d[2]; p.py = d[1] - d[3];
      });
      f.rd.netTarget = null;
    } else {
      // Store the host's truth as a target and drift toward it gradually,
      // every local frame, instead of yanking the position on each sync
      // arrival — a periodic hard correction reads as jerking/snapping
      // whenever the local prediction has drifted, especially in a chaotic
      // physics fight; a continuous gentle pull is smooth instead.
      f.rd.netTarget = entry.pt;
    }
  }
}

setInterval(() => { if (room.isHost && room.me) room.send({ t: 'sync', full: false, ...snapshot() }); }, 90);
setInterval(() => { if (!room.isHost && room.me) room.send({ t: 'held', hd: heldBitmask(myId()) }); }, 1000);

// ───────────────────────── input ─────────────────────────
const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
                 w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };

function setHeld(dir, on) {
  const s = getHeld(myId());
  if (s.has(dir) === on) return; // no change, ignore key-repeat autorepeat spam
  if (on) s.add(dir); else s.delete(dir);
  room.send({ t: 'hold', id: myId(), dir, on });
}
addEventListener('keydown', (e) => { const dir = KEYMAP[e.key]; if (dir) setHeld(dir, true); });
addEventListener('keyup',   (e) => { const dir = KEYMAP[e.key]; if (dir) setHeld(dir, false); });
addEventListener('blur', () => { stick = null; paintStick(); letGo(); });

// ── thumb ─────────────────────────────────────────────────────────────
// A phone has no arrow keys, so the four of them are held with a thumb: the
// touch that goes down is the centre of a stick, and how far it has been
// dragged off that centre is which of the four are pressed. Both axes can be
// past the threshold at once, which is the same corner two arrow keys held
// together give — the impulses this game is played on are the diagonals, and
// a stick that could only send one at a time would take them away.
//
// The stick is wherever the thumb lands rather than painted into a corner,
// because a hand holding a phone lands where it lands. What it produces is
// `setHeld` and nothing else, so a fighter pushed by a thumb is a fighter
// pushed by the keys as far as the wire is concerned.
//
// Only touches are read. A laptop with a touchscreen answers the coarse
// pointer query as loudly as a phone does, and on one of those every click in
// the arena would otherwise plant a stick under the mouse.
const OVER = 14;     // px off centre before an axis counts as held
const REACHOUT = 46; // px at which the stick is all the way over
let stick = null;    // { pointerId, ox, oy, dx, dy }

function letGo() { for (const dir of Array.from(getHeld(myId()))) setHeld(dir, false); }

function fromStick() {
  const dx = stick ? stick.dx : 0, dy = stick ? stick.dy : 0;
  setHeld('left', dx <= -OVER);
  setHeld('right', dx >= OVER);
  setHeld('up', dy <= -OVER);
  setHeld('down', dy >= OVER);
}

// On the canvas and captured, which is not a detail: a disk is played inside a
// frame on a page that scrolls, and a drag that merely bubbles to `window` is
// still a drag the page above can decide is its own scroll and take away
// halfway through. `setPointerCapture` binds the rest of the gesture to this
// element the moment it starts, so every move and the release come here no
// matter what the page around the frame makes of them. It is what chapaev.js
// does, and it is why chapaev is playable on a phone.
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || stick) return;
  coarse = true;   // a finger has landed, whatever the device claimed
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  stick = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
  paintStick();
});
canvas.addEventListener('pointermove', (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  stick.dx = e.clientX - stick.ox;
  stick.dy = e.clientY - stick.oy;
  fromStick();
  paintStick();
});
// `pointercancel` as well as `pointerup`: a touch the browser takes away — a
// system gesture starting over the frame — never reports a release, and the
// ragdoll would be left shoved in a direction nobody is holding any more.
const lift = (e) => {
  if (!stick || e.pointerId !== stick.pointerId) return;
  stick = null;
  fromStick();
  paintStick();
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);
// Heard on the window as well as on the canvas: a capture broken before it
// took hold sends the release somewhere else, and a stick left standing under
// no thumb refuses the next one.
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

// Drawn in the page rather than on the canvas: the arena is stretched onto
// the frame and the fight in it is the same picture for everyone in the room,
// so one screen's controls have no place in either.
const ring = document.createElement('div');
ring.style.cssText =
  `position:fixed;display:none;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
  `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;pointer-events:none;` +
  `border:1px solid ${INK.line};background:rgba(143,143,143,0.06)`;
const knob = document.createElement('div');
knob.style.cssText =
  'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
  `border-radius:50%;pointer-events:none;opacity:.7;background:${INK.text}`;
document.body.append(ring, knob);

function paintStick() {
  if (!stick) { ring.style.display = knob.style.display = 'none'; return; }
  const far = Math.hypot(stick.dx, stick.dy);
  // The knob stops at the rim: past it the thumb is only saying the same
  // direction louder, and an impulse has no louder to be said in.
  const k = far > REACHOUT ? REACHOUT / far : 1;
  ring.style.display = knob.style.display = 'block';
  ring.style.left = stick.ox + 'px';
  ring.style.top = stick.oy + 'px';
  knob.style.left = stick.ox + stick.dx * k + 'px';
  knob.style.top = stick.oy + stick.dy * k + 'px';
}

// ───────────────────────── main loop ─────────────────────────
// The physics is Verlet and Verlet has no dt in it: every constant above — the
// gravity, the damping, the thrust, the blood's drag — is written as "per
// step", and a step used to be a frame. So the fight ran at whatever speed the
// screen happened to draw at: right at 60Hz, half again slower on a busy
// frame, twice too fast on a 120Hz phone. The steps are now counted off a
// clock instead, always TICK apart, and the frame only says how many of them
// are owed. Nothing about a step changed — the same numbers in the same order
// — only how often one is taken.
const TICK = 1000 / 60; // the length a step has always silently stood for
// Frames that arrive very late — a backgrounded tab, a long stall — are not
// paid back in full: past this many steps in one frame the missed time is
// dropped and the fight simply runs slow. Eight keeps a screen as poor as
// 7fps honest, and refuses the alternative: a second of arrears is sixty
// steps in one frame, which lands the next frame later still, and a sim that
// answers a slow frame by making the next one slower never gets out of debt.
const MAX_CATCHUP = 8;
let clock = performance.now(), owed = 0;

function step() {
  const now = performance.now();
  owed = Math.min(owed + (now - clock), TICK * MAX_CATCHUP);
  clock = now;
  updateBot(now);
  // Each step is given the moment it actually lands on, not the frame's, so
  // that the cooldowns and respawn timers read the same whether the steps come
  // one to a frame or five.
  while (owed >= TICK) { owed -= TICK; tick(now - owed); }
  draw();
  requestAnimationFrame(step);
}

function tick(now) {
  if (now > G.comboUntil) G.combo = 1;
  updateBlood();

  for (const [id, f] of fighters) {
    if (!f.rd.exploded) {
      for (const dir of getHeld(id)) applyForce(f.rd, dir, THRUST);
    }
    integrate(f.rd);
    if (!f.rd.exploded) constrainBones(f.rd);
    else for (const p of f.rd.particles) wallCollide(p);
    if (!room.isHost && f.rd.netTarget) {
      const pull = 0.09;
      f.rd.netTarget.forEach((d, i) => {
        const p = f.rd.particles[i];
        const curVx = p.x - p.px, curVy = p.y - p.py;
        p.x += (d[0] - p.x) * pull; p.y += (d[1] - p.y) * pull;
        const newVx = curVx + (d[2] - curVx) * pull, newVy = curVy + (d[3] - curVy) * pull;
        p.px = p.x - newVx; p.py = p.y - newVy;
      });
    }
    const localAuthority = id === BOT_ID || room.isHost;
    if (localAuthority && f.rd.exploded && now - f.rd.explodedAt > RESPAWN_DELAY) {
      const [x, y] = spawnPos(f.colorIdx, fighters.size);
      resetRagdoll(f.rd, x, y);
    }
  }

  const ids = Array.from(fighters.keys());
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const A = fighters.get(ids[i]).rd, B = fighters.get(ids[j]).rd;
    if (A.exploded || B.exploded) continue;
    // the bot isn't networked, so any pair involving it is authoritative locally
    const authority = ids[i] === BOT_ID || ids[j] === BOT_ID ? true : room.isHost;
    const cdKey = ids[i] + '|' + ids[j];
    collideRagdolls(A, B, authority, (hits, e) => {
      // One damage event per fighter pair per cooldown window — without this,
      // staying pressed together (ramming your head in and holding it there)
      // fires a fresh hit almost every frame and stacks combo multiplier fast
      // enough to kill in a fraction of a second.
      if (now - (pairCooldown.get(cdKey) || 0) < HIT_COOLDOWN_MS) return;
      pairCooldown.set(cdKey, now);
      for (const [victim, crit] of hits) dealDamage(victim === 'A' ? A : B, e, crit);
    });
  }
}
requestAnimationFrame(step);

// ───────────────────────── rendering ─────────────────────────
function teamColor(base) {
  return `rgb(${base[0]},${base[1]},${base[2]})`;
}

// Health readout, shown only at the palms: full HP is the fighter's own
// colour, 0 HP is red, interpolated smoothly. The rest of the body stays a
// flat team colour and no longer reddens from individual hits.
function wristColor(base, frac) {
  const r = base[0] + (225 - base[0]) * frac;
  const g = base[1] + (40 - base[1]) * frac;
  const b = base[2] + (40 - base[2]) * frac;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function drawRagdoll(rd, base) {
  const dmgFrac = Math.min(1, rd.totalDamage / MAX_DAMAGE);
  if (!rd.exploded) {
    ctx.strokeStyle = teamColor(base);
    ctx.lineWidth = 7; ctx.lineCap = 'round';
    for (const [a, b] of rd.bones) {
      const A = rd.particles[a], B = rd.particles[b];
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    }
  }
  rd.particles.forEach((p, i) => {
    ctx.fillStyle = (i === LHAND || i === RHAND) ? wristColor(base, dmgFrac) : teamColor(base);
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(28,28,28,.55)'; ctx.stroke();
  });
}

function draw() {
  ctx.clearRect(0, 0, LW, LH);
  ctx.strokeStyle = INK.line; ctx.lineWidth = 4;
  ctx.strokeRect(ARENA.l, ARENA.t, ARENA.r - ARENA.l, ARENA.b - ARENA.t);
  ctx.fillStyle = INK.floor;
  ctx.fillRect(ARENA.l, ARENA.b, ARENA.r - ARENA.l, LH - ARENA.b);
  drawBlood();

  for (const [id, f] of fighters) {
    drawRagdoll(f.rd, PALETTE[f.colorIdx % PALETTE.length]);
    label(nickOf(id) + ' · ' + Math.round(f.rd.totalDamage),
          f.rd.particles[HEAD].x, f.rd.particles[HEAD].y - 26, '12px ' + FONT, INK.text);
  }

  if (G.combo > 1.05) {
    label('COMBO x' + G.combo.toFixed(1), LW / 2, 34, '600 18px ' + FONT, INK.warn);
  }

  if (currentRosterIds().length < 2) {
    label('no real opponent yet — practicing against the dummy',
          LW / 2, LH / 2 - 100, '15px ' + FONT, INK.muted);
  }

  // Sized to fit the glass rather than to a fixed twelve pixels. The lettering
  // is drawn at the screen's own scale, so on a phone held upright a line of a
  // dozen words is wider than the frame and both ends of it are off the edge —
  // including the half that says which way to push.
  const how = coarse
    ? 'drag anywhere — impulse your whole ragdoll, tumble into your opponent'
    : 'WASD / arrow keys — impulse your whole ragdoll, tumble into your opponent';
  label(how, LW / 2, LH - 16, fitted(how, 12), INK.muted);
}
