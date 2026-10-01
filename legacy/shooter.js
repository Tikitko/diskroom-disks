/**
 * @disk     shooter
 * @author   diskroom
 * @version  4
 * @players  1-8
 * @about    A top-down arena shootout with cover. Run with the arrows or a left thumb, aim with the mouse or a right one, hold to fire; one machine runs the arena and everybody else sends it where they are pushing, where they are looking and when they pulled the trigger.
 * @tags     game, arcade, realtime, shooter, example
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/shooter.png
 */
// shooter.js — one machine runs the arena, everybody else sends where they are
// pushing, where they are looking and when they pulled the trigger.
//
// The host owns everything that can be argued about: where each fighter
// stands, where every shot is, who it hit and what that cost. A player's copy
// works nothing out and corrects nothing, for the same reason tag.js does not:
// a hit decided in one place cannot be seen two ways by the two people it
// happened to.
//
// A shot carries the angle it was fired at instead of picking one up at the
// host. That is what makes the crosshair honest — it turns at the rate of the
// screen and the shot leaves along the line you were looking down. What it
// does not buy is the muzzle: the shot leaves from where the host has you,
// which is half a round trip further on than the picture you aimed at.
//
// The wire: a snapshot of eight fighters and forty shots is about 1.2 KiB, and
// copied to seven other seats twenty times a second that is a third of what
// one player may send. The ceiling on shots in flight below is the wire's
// ceiling rather than the game's, which is why it is written next to it.

// ── the arena, in units every copy agrees on ───────────────────────────────
const FW = 1.6, FH = 1.0;
const R = 0.028;              // a fighter's radius
const SPEED = 0.52;           // how fast a fighter runs, field units a second
const BR = 0.009;             // a shot's radius
const BSPEED = 1.25;          // field units a second
const BLIFE = 1350;           // ms before a shot gives up
const COOLDOWN = 260;         // ms between shots, held by the host as well
const HP = 3;
const RESPAWN_MS = 1800;
const IMMUNE_MS = 1500;       // after standing back up
const MAX_SHOTS = 40;         // what fits in one snapshot, not what the gun allows
const KEEP_FIGHTERS = 3;      // bots fill the arena up to this many
const BOT_IDS = [-2, -3];     // never a real player id; the studio's own is -1
const BOT_SPEED = 0.42;
const BOT_TURN = 2.6;         // radians a second: a bot that has to aim is beatable
const BOT_RANGE = 0.42;       // the distance a bot tries to hold
const TICK = 50;              // ms between the host's pictures — 20 a second
const LAG = 60;               // ms behind: the cushion the drawing runs on
const STALE = 3000;           // ms of silence before a hand is treated as open
const HEARTBEAT = 1000;       // a held key still proves that its disk is alive
const PROBE_EVERY = 1000;     // ms between the host's round-trip measurements
const HOST_LAG_FALLBACK = 25; // ms until the first player answers a probe

// Cover, as [x, y, w, h]. The layout is symmetric under a half turn about the
// centre, so no spawn corner has a better wall than the one across from it.
const WALLS = [
  [0.35, 0.20, 0.10, 0.22],
  [0.35, 0.58, 0.10, 0.22],
  [1.15, 0.20, 0.10, 0.22],
  [1.15, 0.58, 0.10, 0.22],
  [0.72, 0.42, 0.16, 0.16],
];

const SPAWNS = [
  [0.12, 0.12], [0.80, 0.10], [1.48, 0.12], [0.12, 0.50],
  [1.48, 0.50], [0.12, 0.88], [0.80, 0.90], [1.48, 0.88],
];

const C = {
  bg: '#1c1c1c', line: '#2f2f2f', wall: '#262626', edge: '#3a3a3a',
  muted: '#8f8f8f', mine: '#a9c0a9', foe: '#d3a9a9', dim: '#4a4a4a',
};
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";
const ZERO = { dx: 0, dy: 0, a: 0 };

// ── the arena, as the host holds it ────────────────────────────────────────
const fighters = new Map();  // id -> { x, y, aim, hp, kills, ... }
const shots = [];            // { id, x, y, vx, vy, by, until }
const push = new Map();      // id -> { dx, dy, a } — that hand, as it last said
const seen = new Map();      // id -> when we last heard from them
let shotSeq = 0;

let myInput = { dx: 0, dy: 0, a: 0 };
let mySentAt = 0;
let myCoolAt = 0;
let hostPush = { dx: 0, dy: 0 };
let hostAim = 0;
const heldInputs = [];
const roundTrips = new Map();
let probedAt = 0;

// The round trip to the machine running the arena, measured by this copy: a
// ping it sends and the host echoes back. Not the platform's own badge — that
// one measures the way to the server, and what decides a firefight is the way
// to whoever is running it.
let hostId = null;
let pingMs = null;
let pingAt = 0;

// The last two pictures from the host. The drawing lives between them.
let prev = null, next = null, prevAt = 0, nextAt = 0;
let hostPrev = null, hostNext = null, hostPrevAt = 0, hostNextAt = 0;

let myHp = HP;
let hurtAt = -9999;
let downAt = -9999;

const myId = () => (room.me ? room.me.id : -1);
const boss = () => room.isHost || !room.me;
const isBot = (id) => id < -1;
let authority = room.isHost ? myId() : null;
const clampX = (x) => Math.max(R, Math.min(FW - R, x));
const clampY = (y) => Math.max(R, Math.min(FH - R, y));
const r3 = (v) => Math.round(v * 1000) / 1000;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function turnToward(from, to, most) {
  const d = wrap(to - from);
  return from + Math.max(-most, Math.min(most, d));
}

function hostLag(now) {
  if (!room.me || !room.players.some((player) => player.id !== myId())) return 0;
  const legs = [];
  for (const [id, sample] of roundTrips) {
    if (id !== myId() && now - sample.at < STALE) legs.push(sample.rtt / 2);
  }
  // The slowest active link is the only choice that cannot leave the host
  // shooting before one of the people they are shooting at.
  return Math.max(0, Math.min(250, legs.length ? Math.max(...legs) : HOST_LAG_FALLBACK));
}

// The host's own hand waits in this queue for the same cushion its players'
// hands spend on the wire. Without it the one machine running the arena would
// turn and fire a round trip earlier than anybody it is aiming at.
function releaseHeldInputs(now) {
  while (heldInputs.length && heldInputs[0].at <= now) {
    const item = heldInputs.shift();
    if (item.shot !== undefined) fire(myId(), item.shot, now);
    else {
      hostPush = { dx: item.dir.dx, dy: item.dir.dy };
      hostAim = item.dir.a;
    }
  }
}

function rememberHostWorld(now, world) {
  hostPrev = hostNext;
  hostPrevAt = hostNextAt;
  hostNext = world;
  hostNextAt = now + hostLag(now);
  if (!hostPrev) {
    hostPrev = world;
    hostPrevAt = hostNextAt - TICK;
  }
}

function nickOf(id) {
  if (isBot(id)) return 'bot' + (-id - 1);
  if (id === myId()) return room.me ? room.me.nick : 'you';
  const p = room.players.find((x) => x.id === id);
  return p ? p.nick : 'p' + id;
}

// ── geometry ───────────────────────────────────────────────────────────────
function inWall(x, y) {
  for (const w of WALLS) {
    if (x > w[0] && x < w[0] + w[2] && y > w[1] && y < w[1] + w[3]) return true;
  }
  return false;
}

// A circle pushed back out of whatever block it has walked into. Resolving the
// overlap rather than refusing the move is what lets a fighter slide along a
// wall instead of sticking to it the moment they touch one.
function unstick(f) {
  for (const w of WALLS) {
    const cx = Math.max(w[0], Math.min(f.x, w[0] + w[2]));
    const cy = Math.max(w[1], Math.min(f.y, w[1] + w[3]));
    const dx = f.x - cx, dy = f.y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= R) continue;
    if (d < 1e-6) {
      // Dead centre inside the block — no direction to push along, so it goes
      // out by the nearest face.
      const left = f.x - w[0], right = w[0] + w[2] - f.x;
      const up = f.y - w[1], down = w[1] + w[3] - f.y;
      const least = Math.min(left, right, up, down);
      if (least === left) f.x = w[0] - R;
      else if (least === right) f.x = w[0] + w[2] + R;
      else if (least === up) f.y = w[1] - R;
      else f.y = w[1] + w[3] + R;
      continue;
    }
    f.x = cx + (dx / d) * R;
    f.y = cy + (dy / d) * R;
  }
}

function clearLine(from, to) {
  const far = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(far / 0.025));
  for (let i = 1; i < steps; i++) {
    const k = i / steps;
    if (inWall(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k)) return false;
  }
  return true;
}

// ── the arena. Only the host ever runs any of this ─────────────────────────
function spawnSpot() {
  let best = SPAWNS[0], bestGap = -1;
  for (const s of SPAWNS) {
    let gap = 9;
    for (const f of fighters.values()) {
      if (f.hp > 0) gap = Math.min(gap, Math.hypot(f.x - s[0], f.y - s[1]));
    }
    if (gap > bestGap) { bestGap = gap; best = s; }
  }
  // A little scatter, so two people standing back up in the same second do not
  // land on the same square and shoot each other point blank.
  return {
    x: clampX(best[0] + (Math.random() - 0.5) * 0.05),
    y: clampY(best[1] + (Math.random() - 0.5) * 0.05),
  };
}

function newFighter(id, now) {
  const spot = spawnSpot();
  return {
    x: spot.x, y: spot.y, aim: 0, hp: HP, kills: 0,
    speed: isBot(id) ? BOT_SPEED : SPEED,
    // A bot runs slower than a person and shoots slower than one. Both are
    // handicaps a player can feel across the arena without reading any code,
    // which is what makes losing to one mean something.
    cool: isBot(id) ? COOLDOWN * 1.5 : COOLDOWN,
    coolAt: 0, immuneUntil: now + IMMUNE_MS, respawnAt: 0,
    strafe: 1, strafeAt: 0, wobble: 0, wobbleAt: 0,
  };
}

function revive(f, now) {
  const spot = spawnSpot();
  f.x = spot.x;
  f.y = spot.y;
  f.hp = HP;
  f.immuneUntil = now + IMMUNE_MS;
}

function roster(now) {
  const here = new Set(room.players.map((p) => p.id));
  here.add(myId());
  for (const id of [...fighters.keys()]) {
    if (!isBot(id) && !here.has(id)) {
      fighters.delete(id);
      push.delete(id);
    }
  }
  // Everybody in the room stands in the arena whether or not they have touched
  // a key: a player who has not moved yet is still a target.
  for (const id of here) if (!fighters.has(id)) fighters.set(id, newFighter(id, now));

  // Bots make up the numbers so that one person alone — in the studio, or
  // first into a room — has something to shoot at. They give way as people
  // arrive rather than staying on as extra guns.
  const wanted = Math.max(0, Math.min(BOT_IDS.length, KEEP_FIGHTERS - here.size));
  const bots = [...fighters.keys()].filter(isBot);
  while (bots.length > wanted) fighters.delete(bots.pop());
  for (const id of BOT_IDS) {
    if (bots.length >= wanted) break;
    if (fighters.has(id)) continue;
    fighters.set(id, newFighter(id, now));
    bots.push(id);
  }
}

// A bot is deliberately a simple one: it holds a distance, strafes, turns at a
// rate rather than snapping onto its target, and does not fire through a wall.
// What makes it beatable is the turn rate — a player who keeps moving is
// genuinely harder for it to hit than one who stands still.
function think(id, f, dt, now) {
  let target = null, nearest = 9;
  for (const [other, o] of fighters) {
    if (other === id || o.hp <= 0) continue;
    const d = Math.hypot(o.x - f.x, o.y - f.y);
    if (d < nearest) { nearest = d; target = o; }
  }
  if (!target) return ZERO;

  if (now >= f.wobbleAt) {
    f.wobble = (Math.random() - 0.5) * 0.22;
    f.wobbleAt = now + 500 + Math.random() * 700;
  }
  if (now >= f.strafeAt) {
    f.strafe = Math.random() < 0.5 ? -1 : 1;
    f.strafeAt = now + 600 + Math.random() * 900;
  }

  const want = Math.atan2(target.y - f.y, target.x - f.x);
  f.aim = turnToward(f.aim, want + f.wobble, BOT_TURN * dt);

  const closer = nearest > BOT_RANGE + 0.06 ? 1 : nearest < BOT_RANGE - 0.06 ? -1 : 0;
  const side = want + Math.PI / 2;
  if (Math.abs(wrap(f.aim - want)) < 0.10 && clearLine(f, target)) fire(id, f.aim, now);
  return {
    dx: Math.cos(want) * closer + Math.cos(side) * f.strafe * 0.9,
    dy: Math.sin(want) * closer + Math.sin(side) * f.strafe * 0.9,
  };
}

function fire(id, aim, now) {
  const f = fighters.get(id);
  if (!f || f.hp <= 0 || now < f.coolAt || !Number.isFinite(aim)) return;
  f.coolAt = now + (f.cool || COOLDOWN);
  f.aim = aim;
  const x = f.x + Math.cos(aim) * (R + BR + 0.006);
  const y = f.y + Math.sin(aim) * (R + BR + 0.006);
  // A muzzle inside a block eats the shot rather than putting one through the
  // far side of the wall the shooter is standing against.
  if (inWall(x, y)) return;
  shots.push({
    id: ++shotSeq, x, y,
    vx: Math.cos(aim) * BSPEED, vy: Math.sin(aim) * BSPEED,
    by: id, until: now + BLIFE,
  });
  // Over the ceiling the oldest shot goes: one that has nearly run out anyway
  // is a smaller lie on screen than a new one that never appears at all.
  while (shots.length > MAX_SHOTS) shots.shift();
}

function hit(id, f, by, now) {
  f.hp -= 1;
  if (f.hp > 0) return;
  f.hp = 0;
  f.respawnAt = now + RESPAWN_MS;
  const killer = fighters.get(by);
  if (killer && by !== id) killer.kills += 1;
}

function run(dt, now) {
  roster(now);

  for (const [id, f] of fighters) {
    if (f.hp <= 0) {
      if (now >= f.respawnAt) revive(f, now);
      continue;
    }
    let hand;
    if (isBot(id)) {
      hand = think(id, f, dt, now);
    } else if (id === myId()) {
      f.aim = hostAim;
      hand = hostPush;
    } else {
      const said = push.get(id);
      // A hand nobody has heard from in three seconds is treated as open, so a
      // player whose tab froze mid-run does not jog into a wall for ever.
      const fresh = said && now - (seen.get(id) || 0) < STALE;
      if (said) f.aim = said.a;
      hand = fresh ? said : ZERO;
    }
    const far = Math.hypot(hand.dx, hand.dy);
    if (far < 0.01) continue;
    f.x = clampX(f.x + (hand.dx / far) * f.speed * dt);
    f.y = clampY(f.y + (hand.dy / far) * f.speed * dt);
    unstick(f);
  }

  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    if (now >= s.until) { shots.splice(i, 1); continue; }
    // A shot crosses more than its own radius in one frame, so it is walked
    // there in pieces: a whole step would let it pass through a wall, or
    // through somebody, without ever being inside either.
    const pieces = Math.max(1, Math.ceil((BSPEED * dt) / (BR * 2)));
    let spent = false;
    for (let p = 0; p < pieces && !spent; p++) {
      s.x += (s.vx * dt) / pieces;
      s.y += (s.vy * dt) / pieces;
      if (s.x < 0 || s.x > FW || s.y < 0 || s.y > FH || inWall(s.x, s.y)) { spent = true; break; }
      for (const [id, f] of fighters) {
        if (id === s.by || f.hp <= 0 || now < f.immuneUntil) continue;
        if (Math.hypot(f.x - s.x, f.y - s.y) > R + BR) continue;
        hit(id, f, s.by, now);
        spent = true;
        break;
      }
    }
    if (spent) shots.splice(i, 1);
  }
}

// ── the wire ───────────────────────────────────────────────────────────────
function picture() {
  const f = [];
  const now = performance.now();
  for (const [id, x] of fighters) {
    // One number carries both states a fighter can be waiting in: how long
    // they are still untouchable, or — negative — how long until they are back.
    const state = x.hp > 0
      ? Math.max(0, Math.round(x.immuneUntil - now))
      : -Math.max(0, Math.round(x.respawnAt - now));
    f.push([id, r3(x.x), r3(x.y), r3(x.aim), x.hp, x.kills, state]);
  }
  const b = [];
  for (const s of shots) b.push([s.id, r3(s.x), r3(s.y), s.by]);
  return { t: 'w', f, b };
}

function worldOf(msg) {
  if (!Array.isArray(msg.f) || msg.f.length > 10) return false;
  if (!Array.isArray(msg.b) || msg.b.length > MAX_SHOTS) return false;

  const restored = new Map();
  const now = performance.now();
  for (const row of msg.f) {
    if (!Array.isArray(row) || row.length !== 7) return false;
    const [id, x, y, aim, hp, kills, state] = row;
    if (!Number.isInteger(id)) return false;
    if (![x, y, aim, hp, kills, state].every(Number.isFinite)) return false;
    // Everything a new host needs to go on from this picture has to be
    // rebuilt from it: the handicap a bot plays with, and the clocks the one
    // number `state` carries — untouchable for this long, or back in this
    // long. Left at a person's pace and at zero, a handover would hand the
    // bots a faster gun and bring every downed fighter back on the spot.
    const base = newFighter(id, now);
    restored.set(id, {
      ...base,
      x: clampX(x), y: clampY(y), aim, hp, kills, state,
      coolAt: 0,
      immuneUntil: state > 0 ? now + state : 0,
      respawnAt: state < 0 ? now - state : 0,
    });
  }

  const flying = [];
  for (const row of msg.b) {
    if (!Array.isArray(row) || row.length !== 4) return false;
    const [id, x, y, by] = row;
    if (!Number.isInteger(id) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    flying.push({ id, x, y, vx: 0, vy: 0, by, until: 0 });
  }

  fighters.clear();
  for (const [id, f] of restored) fighters.set(id, f);
  shots.length = 0;
  for (const s of flying) shots.push(s);
  return true;
}

// A number off the wire, or 0. `Number(x) || 0` lets Infinity through, and a
// single Infinity in a runner's step is a NaN in its position for good — after
// which every picture the host sends is refused by every copy that gets it.
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

room.on('message', (from, msg) => {
  if (!msg || typeof msg.t !== 'string') return;
  seen.set(from, performance.now());

  if (msg.t === 'in') {
    const dx = finite(msg.x), dy = finite(msg.y);
    const far = Math.hypot(dx, dy);
    const a = finite(msg.a);
    // Normalised here rather than trusted: the length of the vector is what
    // decides speed, and a copy of the disk that sent a longer one would
    // otherwise simply run faster than everybody else.
    push.set(from, far < 0.01 ? { dx: 0, dy: 0, a } : { dx: dx / far, dy: dy / far, a });
  } else if (msg.t === 'shot') {
    // The cooldown lives with the host, so a copy that sends triggers as fast
    // as the rate ceiling allows still fires at the same pace as everyone else.
    if (boss()) fire(from, finite(msg.a), performance.now());
  } else if (msg.t === 'probe') {
    room.send({ t: 'probeBack', at: msg.at }, { to: from });
  } else if (msg.t === 'probeBack' && boss()) {
    const rtt = performance.now() - Number(msg.at);
    if (Number.isFinite(rtt) && rtt >= 0) roundTrips.set(from, { rtt, at: performance.now() });
  } else if (msg.t === 'ping') {
    room.send({ t: 'pong', at: msg.at }, { to: from });
  } else if (msg.t === 'pong') {
    const rtt = performance.now() - Number(msg.at);
    if (!Number.isFinite(rtt) || rtt < 0) return;
    pingMs = pingMs === null ? rtt : pingMs * 0.7 + rtt * 0.3;
  } else if (msg.t === 'w' && !boss() && (authority === null || authority === from)) {
    if (!worldOf(msg)) return;
    authority = from;
    hostId = from;
    prev = next;
    prevAt = nextAt;
    next = msg;
    nextAt = performance.now();
    if (!prev) { prev = msg; prevAt = nextAt - TICK; }
    watchMyself(msg);
  } else if (msg.t === 'hello' && boss()) {
    room.send(picture(), { to: from });
  }
});

// Being hit is not a message of its own: it is my own health falling in the
// host's picture, which is the same fact and one the host cannot forget to say.
function watchMyself(world) {
  const mine = world.f.find((row) => row[0] === myId());
  if (!mine) return;
  const hp = mine[4];
  if (hp < myHp) hurtAt = performance.now();
  if (hp <= 0 && myHp > 0) downAt = performance.now();
  myHp = hp;
}

setInterval(() => {
  const now = performance.now();

  if (boss()) {
    const world = picture();
    rememberHostWorld(now, world);
    if (room.me) room.send(world);
    if (now - probedAt >= PROBE_EVERY) {
      probedAt = now;
      for (const player of room.players) {
        if (player.id !== myId()) room.send({ t: 'probe', at: Math.round(now) }, { to: player.id });
      }
    }
    const mine = fighters.get(myId());
    if (mine) {
      if (mine.hp < myHp) hurtAt = now;
      if (mine.hp <= 0 && myHp > 0) downAt = now;
      myHp = mine.hp;
    }
  }

  sayHand(now);

  if (!boss() && hostId !== null && now - pingAt > 1000) {
    pingAt = now;
    room.send({ t: 'ping', at: Math.round(now) }, { to: hostId });
  }
}, TICK);

// Direction and aim travel together, twenty times a second and only when one
// of them has actually moved. A hand held still costs a message a second — the
// heartbeat that tells the host this copy is still running.
function sayHand(now) {
  const hand = hands();
  const far = Math.hypot(hand.dx, hand.dy);
  const dir = far < 0.01 ? { dx: 0, dy: 0 } : { dx: hand.dx / far, dy: hand.dy / far };
  const moved = Math.hypot(dir.dx - myInput.dx, dir.dy - myInput.dy) > 0.08;
  const turned = Math.abs(wrap(myAim - myInput.a)) > 0.02;
  if (!moved && !turned && now - mySentAt < HEARTBEAT) return;

  myInput = { dx: dir.dx, dy: dir.dy, a: myAim };
  mySentAt = now;
  if (boss()) {
    heldInputs.push({ at: now + hostLag(now), dir: { ...myInput } });
  }
  if (room.me) room.send({ t: 'in', x: r3(myInput.dx), y: r3(myInput.dy), a: r3(myInput.a) });
}

function pullTrigger(now) {
  if (now < myCoolAt) return;
  myCoolAt = now + COOLDOWN;
  if (boss()) heldInputs.push({ at: now + hostLag(now), shot: myAim });
  else if (room.me) room.send({ t: 'shot', a: r3(myAim) });
}

room.on('join', (p) => console.log(p.nick + ' walked in'));

room.on('leave', (p) => {
  fighters.delete(p.id);
  push.delete(p.id);
  seen.delete(p.id);
  roundTrips.delete(p.id);
  console.log(p.nick + ' left');
});

room.on('hostchange', (h) => {
  heldInputs.length = 0;
  hostPush = { dx: 0, dy: 0 };
  hostPrev = hostNext = null;
  authority = h;
  hostId = h;
  // Whoever it is now inherits the last picture they were sent, and nothing is
  // asked of the room: agreeing on the arena would cost a pause worth more
  // than the arena is. What cannot be inherited is the shots in flight — a
  // snapshot carries where each one is and not where it was going, and a
  // direction invented here would send it somewhere it was never fired. They
  // are dropped instead, which costs a blink of empty air at a handover.
  if (boss()) shots.length = 0;
  else room.send({ t: 'hello' });
  console.log('the arena is now run by ' + nickOf(h));
});

// ── the screen ─────────────────────────────────────────────────────────────
// Which hand the screen writes its instructions for. A device that says its
// pointer is coarse is taken at its word to begin with, and the first finger
// that actually lands settles it. Nothing but the wording hangs on this: a
// thumb and a mouse reach the same `myAim` and the same trigger, and the wire
// cannot tell one from the other.
let coarse = matchMedia('(pointer: coarse)').matches;

// `-webkit-touch-callout` and the selection rules are not decoration: a
// finger held still on iOS Safari is a long press, and a long press there
// selects what is under it and puts a Copy / Look Up bar over the page —
// which takes the pointer away mid-gesture and ends the hold. A drag escapes
// it because the movement cancels the press, so a game played by dragging
// never meets this; one played by holding meets it every time.
document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${C.bg};touch-action:none;` +
  'cursor:crosshair;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;';

const cv = document.createElement('canvas');
cv.style.cssText = 'display:block;width:100%;height:100%';
document.body.appendChild(cv);
const ctx = cv.getContext('2d');

let sc = 1, ox = 0, oy = 0;
function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth || 640, h = cv.clientHeight || 400;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Letterboxed rather than stretched: it is the same arena for everyone, and
  // stretching it would make a shot depend on the shape of a window.
  sc = Math.min(w / FW, h / FH) * 0.92;
  ox = (w - FW * sc) / 2;
  oy = (h - FH * sc) / 2;
}
layout();
window.addEventListener('resize', layout);

const X = (x) => ox + x * sc;
const Y = (y) => oy + y * sc;

// Every screen, the host's included, draws the moment between two pictures.
function view(now) {
  const before = boss() ? hostPrev : prev;
  const after = boss() ? hostNext : next;
  const beforeAt = boss() ? hostPrevAt : prevAt;
  const afterAt = boss() ? hostNextAt : nextAt;

  const f = new Map(), b = new Map();
  if (!before || !after) {
    for (const [id, x] of fighters) {
      f.set(id, { x: x.x, y: x.y, aim: x.aim, hp: x.hp, kills: x.kills, state: 0 });
    }
    for (const s of shots) b.set(s.id, { x: s.x, y: s.y, by: s.by });
    return { f, b };
  }

  const span = Math.max(1, afterAt - beforeAt);
  const k = Math.max(0, Math.min(1, (now - LAG - beforeAt) / span));

  const wasF = new Map(before.f.map((row) => [row[0], row]));
  for (const [id, x, y, aim, hp, kills, state] of after.f) {
    const old = wasF.get(id);
    f.set(id, {
      x: old ? old[1] + (x - old[1]) * k : x,
      y: old ? old[2] + (y - old[2]) * k : y,
      aim: old ? old[3] + wrap(aim - old[3]) * k : aim,
      hp, kills, state,
    });
  }
  const wasB = new Map(before.b.map((row) => [row[0], row]));
  for (const [id, x, y, by] of after.b) {
    const old = wasB.get(id);
    b.set(id, { x: old ? old[1] + (x - old[1]) * k : x, y: old ? old[2] + (y - old[2]) * k : y, by });
  }
  return { f, b };
}

function fighterAt(r, id) {
  const mine = id === myId();
  const colour = mine ? C.mine : C.muted;

  if (r.hp <= 0) {                              // down: where they fell, faintly
    ctx.strokeStyle = C.dim;
    ctx.lineWidth = Math.max(1, sc * 0.006);
    const arm = R * sc * 0.8;
    ctx.beginPath();
    ctx.moveTo(X(r.x) - arm, Y(r.y) - arm); ctx.lineTo(X(r.x) + arm, Y(r.y) + arm);
    ctx.moveTo(X(r.x) + arm, Y(r.y) - arm); ctx.lineTo(X(r.x) - arm, Y(r.y) + arm);
    ctx.stroke();
    return;
  }

  ctx.strokeStyle = colour;                     // the barrel, along their aim
  ctx.lineWidth = Math.max(1.5, sc * 0.009);
  ctx.beginPath();
  ctx.moveTo(X(r.x), Y(r.y));
  ctx.lineTo(X(r.x + Math.cos(r.aim) * R * 1.9), Y(r.y + Math.sin(r.aim) * R * 1.9));
  ctx.stroke();

  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(X(r.x), Y(r.y), R * sc, 0, Math.PI * 2);
  ctx.fill();

  if (r.state > 0) {                            // still untouchable
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1, sc * 0.005);
    ctx.globalAlpha = 0.35 + 0.25 * Math.sin(performance.now() / 90);
    ctx.beginPath();
    ctx.arc(X(r.x), Y(r.y), R * sc * 1.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const pip = sc * 0.012;                       // what is left of them
  for (let i = 0; i < HP; i++) {
    ctx.fillStyle = i < r.hp ? colour : C.dim;
    ctx.fillRect(X(r.x) - pip * 2.5 + i * pip * 2.5, Y(r.y) - R * sc - pip * 2.6, pip * 1.6, pip * 1.2);
  }

  ctx.fillStyle = C.muted;
  ctx.font = `${Math.round(sc * 0.030)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText(nickOf(id), X(r.x), Y(r.y) + R * sc + sc * 0.052);
}

function draw(now, shown) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);

  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(X(0), Y(0), FW * sc, FH * sc);
  for (let x = 0.2; x < FW; x += 0.2) {
    ctx.beginPath(); ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(FH)); ctx.stroke();
  }
  for (let y = 0.2; y < FH; y += 0.2) {
    ctx.beginPath(); ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(FW), Y(y)); ctx.stroke();
  }
  for (const w of WALLS) {
    ctx.fillStyle = C.wall;
    ctx.fillRect(X(w[0]), Y(w[1]), w[2] * sc, w[3] * sc);
    ctx.strokeStyle = C.edge;
    ctx.strokeRect(X(w[0]), Y(w[1]), w[2] * sc, w[3] * sc);
  }

  for (const s of shown.b.values()) {
    // Yours and theirs are told apart by colour, because the only thing worth
    // reacting to in a second is which of the dots on screen is coming at you.
    ctx.fillStyle = s.by === myId() ? C.mine : C.foe;
    ctx.beginPath();
    ctx.arc(X(s.x), Y(s.y), Math.max(1.5, BR * sc), 0, Math.PI * 2);
    ctx.fill();
  }

  for (const [id, r] of shown.f) if (id !== myId()) fighterAt(r, id);
  const me = shown.f.get(myId());
  if (me) {
    fighterAt(me, myId());
    if (me.hp > 0) {
      ctx.strokeStyle = C.dim;                  // the line you are looking down
      ctx.lineWidth = 1;
      ctx.setLineDash([sc * 0.02, sc * 0.02]);
      ctx.beginPath();
      ctx.moveTo(X(me.x), Y(me.y));
      ctx.lineTo(X(me.x + Math.cos(myAim) * 0.9), Y(me.y + Math.sin(myAim) * 0.9));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  const board = [...shown.f.entries()].sort((a, b) => b[1].kills - a[1].kills || a[0] - b[0]);
  ctx.textAlign = 'left';
  ctx.font = `${Math.round(sc * 0.034)}px ${MONO}`;
  let at = X(0);
  for (const [id, r] of board) {
    const text = nickOf(id) + ' ' + r.kills;
    ctx.fillStyle = id === myId() ? C.mine : C.muted;
    ctx.fillText(text, at, Y(0) - sc * 0.03);
    at += ctx.measureText(text + '   ').width;
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = C.line;
  ctx.fillText(
    boss() ? 'you run the arena' : pingMs === null ? 'ping —' : 'ping ' + Math.round(pingMs) + ' ms',
    X(FW), Y(0) - sc * 0.03,
  );

  ctx.textAlign = 'center';
  ctx.font = `${Math.round(sc * 0.030)}px ${MONO}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(coarse
                 ? 'left thumb runs · right thumb aims and fires'
                 : 'arrows or wasd to run · mouse to aim · click or space to fire',
               X(FW / 2), Y(FH) + sc * 0.075);

  if (me && me.hp <= 0) {
    ctx.font = `${Math.round(sc * 0.06)}px ${MONO}`;
    ctx.fillStyle = C.foe;
    ctx.fillText('down — back in ' + (Math.max(0, -me.state) / 1000).toFixed(1) + ' s',
                 X(FW / 2), Y(FH / 2));
  }

  const since = now - hurtAt;
  if (since < 350) {
    ctx.strokeStyle = C.foe;
    ctx.lineWidth = Math.max(2, sc * 0.012) * (1 - since / 350);
    ctx.strokeRect(X(0), Y(0), FW * sc, FH * sc);
  }
}

// ── the hands ──────────────────────────────────────────────────────────────
// Arrows or wasd run, the mouse aims, and either the mouse or the space bar
// fires — so nothing here needs a pointer and a keyboard at once except aiming
// itself, which is the one thing a shooter cannot do without.
const keys = new Set();
let firing = false;
let mouse = null;               // where the pointer is, in field units
let myAim = 0;

function fromKeys() {
  let dx = 0, dy = 0;
  if (keys.has('ArrowLeft') || keys.has('a')) dx -= 1;
  if (keys.has('ArrowRight') || keys.has('d')) dx += 1;
  if (keys.has('ArrowUp') || keys.has('w')) dy -= 1;
  if (keys.has('ArrowDown') || keys.has('s')) dy += 1;
  return { dx, dy };
}

addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  if (e.key === ' ') firing = true;
});
addEventListener('keyup', (e) => {
  keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  if (e.key === ' ') firing = false;
});
addEventListener('blur', () => { keys.clear(); firing = false; runStick = aimStick = null; paintSticks(); });

addEventListener('mousemove', (e) => {
  const box = cv.getBoundingClientRect();
  mouse = { x: (e.clientX - box.left - ox) / sc, y: (e.clientY - box.top - oy) / sc };
  // A mouse that has moved is a hand back on the mouse. Without this the angle
  // the last thumb left behind would hold the crosshair for good on a machine
  // that has both.
  thumbAim = null;
});
addEventListener('mousedown', (e) => { if (e.button === 0) firing = true; });
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
addEventListener('contextmenu', (e) => e.preventDefault());

// ── the thumbs ─────────────────────────────────────────────────────────────
// A phone has no keys and no mouse, and the two things this game asks for at
// once — where you are running and where you are looking — are two thumbs.
// The screen is halved: a finger landing on the left runs, one landing on the
// right aims, and each stick is centred wherever its own thumb went down,
// because a hand holding a phone lands where it lands rather than on a pad
// painted into a corner.
//
// The aim stick fires while it is held over. That is not a shortcut for a
// third thumb: it is the same thing the mouse says, where a hand that has
// chosen a direction to look in has already chosen to shoot down it, and a
// held aim with no shot in it is a state neither hand above can express
// either. Letting go stops both, and a thumb resting inside the deadzone
// keeps the last angle without firing, so the crosshair does not swing to
// nothing every time a finger is lifted.
//
// Only touches are read here. A laptop with a touchscreen answers the coarse
// pointer query as loudly as a phone does, and on one of those every click in
// the arena would otherwise plant a stick under the mouse.
const DEAD = 8;      // px of slack: a thumb resting still is standing still
const REACHOUT = 46; // px from the centre at which a stick is all the way over
let runStick = null; // { pointerId, ox, oy, dx, dy }
let aimStick = null;
let thumbAim = null; // radians, or null while no thumb has chosen a direction

const pushed = (st) => (st ? Math.hypot(st.dx, st.dy) >= DEAD : false);
// A thumb overrides the keys rather than adding to them: pressing both at once
// is nobody's intention, and summing them can cancel to a standstill, which is
// the one answer neither hand asked for.
function hands() {
  return pushed(runStick) ? { dx: runStick.dx, dy: runStick.dy } : fromKeys();
}
const thumbFiring = () => pushed(aimStick);

// On the canvas and captured, which is not a detail: a disk is played inside a
// frame on a page that scrolls, and a drag that merely bubbles to `window` is
// still a drag the page above can decide is its own scroll and take away
// halfway through. `setPointerCapture` binds the rest of the gesture to this
// element the moment it starts, so every move and the release come here no
// matter what the page around the frame makes of them. It is what chapaev.js
// does, and it is why chapaev is playable on a phone.
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  coarse = true;   // a finger has landed, whatever the device claimed
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* older engines */ }
  const side = e.clientX < innerWidth / 2 ? 'run' : 'aim';
  const st = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0 };
  if (side === 'run' && !runStick) runStick = st;
  else if (side === 'aim' && !aimStick) aimStick = st;
  paintSticks();
});
cv.addEventListener('pointermove', (e) => {
  const st = runStick && e.pointerId === runStick.pointerId ? runStick
           : aimStick && e.pointerId === aimStick.pointerId ? aimStick : null;
  if (!st) return;
  st.dx = e.clientX - st.ox;
  st.dy = e.clientY - st.oy;
  // The arena is letterboxed by a single scale, so an angle on the glass is
  // the same angle in field units and needs no converting.
  if (st === aimStick && pushed(st)) thumbAim = Math.atan2(st.dy, st.dx);
  paintSticks();
});
// `pointercancel` as well as `pointerup`: a touch the browser takes away — a
// system gesture starting over the frame — never reports a release, and the
// gun would be left firing with nobody's thumb on it.
const lift = (e) => {
  if (runStick && e.pointerId === runStick.pointerId) runStick = null;
  if (aimStick && e.pointerId === aimStick.pointerId) aimStick = null;
  paintSticks();
};
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
// Heard on the window as well as on the canvas: a capture broken before it
// took hold sends the release somewhere else, and a stick left standing under
// no thumb refuses the next one.
addEventListener('pointerup', lift);
addEventListener('pointercancel', lift);

// The sticks are drawn in the page rather than on the canvas: the arena is the
// same picture for everybody in the room, and one screen's controls are not
// part of it.
function stickParts(colour) {
  const ring = document.createElement('div');
  ring.style.cssText =
    `position:fixed;display:none;width:${REACHOUT * 2}px;height:${REACHOUT * 2}px;` +
    `margin:${-REACHOUT}px 0 0 ${-REACHOUT}px;border-radius:50%;pointer-events:none;` +
    `border:1px solid ${C.line};background:rgba(143,143,143,0.06)`;
  const knob = document.createElement('div');
  knob.style.cssText =
    'position:fixed;display:none;width:26px;height:26px;margin:-13px 0 0 -13px;' +
    `border-radius:50%;pointer-events:none;opacity:.7;background:${colour}`;
  document.body.append(ring, knob);
  return { ring, knob };
}
const runParts = stickParts(C.mine);
const aimParts = stickParts(C.foe);

function paintStick(st, parts) {
  if (!st) { parts.ring.style.display = parts.knob.style.display = 'none'; return; }
  const far = Math.hypot(st.dx, st.dy);
  // The knob stops at the rim: past it the thumb is only saying the same
  // thing louder, and neither running nor aiming has a louder to be said in.
  const k = far > REACHOUT ? REACHOUT / far : 1;
  parts.ring.style.display = parts.knob.style.display = 'block';
  parts.ring.style.left = st.ox + 'px';
  parts.ring.style.top = st.oy + 'px';
  parts.knob.style.left = st.ox + st.dx * k + 'px';
  parts.knob.style.top = st.oy + st.dy * k + 'px';
}
function paintSticks() {
  paintStick(runStick, runParts);
  paintStick(aimStick, aimParts);
}

// ── the loop ───────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (boss()) {
    releaseHeldInputs(now);
    run(dt, now);
  }

  // The aim is taken against the fighter as drawn, not as the host last said,
  // so the crosshair does not swing about while you move — and since the shot
  // carries this angle with it, what you see is what is fired. One view a
  // frame: aiming and drawing have to be looking at the same moment anyway.
  const shown = view(now);
  const me = shown.f.get(myId());
  // A thumb names the angle outright; a mouse names a place to look at, and
  // the angle is taken to it from where the fighter is drawn.
  if (thumbAim !== null) myAim = thumbAim;
  else if (me && mouse) myAim = Math.atan2(mouse.y - me.y, mouse.x - me.x);

  if ((firing || thumbFiring()) && me && me.hp > 0) pullTrigger(now);

  draw(now, shown);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

room.send({ t: 'hello' });

console.log('shooter.js up · host:', boss());
