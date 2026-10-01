/**
 * @disk     perms
 * @author   diskroom
 * @version  4
 * @players  1-8
 * @about    A test fixture, not an example. It reports what a room actually handed the disk: real nicknames, pointer lock, fullscreen, sound, gamepad.
 * @tags     fixture, permissions, diagnostic
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/perms.png
 */
// perms.js — a probe of what a room grants. A fixture, like evil.js, and not
// published as an example either.
//
// evil.js checks what is forbidden always. This disk checks the other half of
// the list a person sees before running somebody else's code — what a room
// hands a disk: real names, pointer lock, sound, gamepad, and fullscreen as the
// platform's and never the disk's. The set is the same in every room, so every
// line below is a promise on that list, and a line that comes out otherwise is
// that promise broken.

const results = [];

function record(name, got, detail) {
  results.push({ name, got, detail });
  console.log(name + ': ' + got + (detail ? ' — ' + detail : ''));
}

// ── identities ──────────────────────────────────────────────────────────────
//
// A disk sees the roster as the platform handed it over: the nicknames people
// picked for themselves, the same ones they see in the room.

const me = room.me;
record('me.nick', me ? me.nick : '(no me)');
record(
  'roster nicks',
  (room.players || []).map((p) => p.nick).join(', ') || '(empty)',
);

// ── fullscreen ──────────────────────────────────────────────────────────────

// The refusal must come every time: a disk can never take the whole screen.
// Fullscreen is the platform's, a button of its own, and what expands by it is
// the platform container together with its border and caption.

(async () => {
  try {
    await document.documentElement.requestFullscreen();
    record('fullscreen', 'TAKEN', 'the frame took over the viewport — this must never happen');
    document.exitFullscreen();
  } catch (e) {
    record('fullscreen', 'REFUSED', e.name);
  }

  // ── pointer lock ──────────────────────────────────────────────────────────
  //
  // The refusal has two different meanings here, and they must not be confused.
  // `SecurityError` is the sandbox's: the frame has lost its `allow-pointer-lock`
  // flag, and the promise on the list is broken.
  // `NotAllowedError` means the ban is lifted and only the browser's built-in
  // order remains — pointer lock requires a user gesture, and no room cancels
  // that.

  try {
    const asked = document.body.requestPointerLock();
    if (asked && typeof asked.then === 'function') {
      await asked;
      record('pointer lock', 'LOCKED');
      document.exitPointerLock();
    } else {
      await new Promise((done) => setTimeout(done, 500));
      const locked = document.pointerLockElement !== null;
      record('pointer lock', locked ? 'LOCKED' : 'NOT LOCKED', 'no exception thrown');
      if (locked) document.exitPointerLock();
    }
  } catch (e) {
    record(
      'pointer lock',
      e.name === 'SecurityError' ? 'BLOCKED BY SANDBOX' : 'ALLOWED, NEEDS A GESTURE',
      e.name,
    );
  }

  // ── sound ─────────────────────────────────────────────────────────────────
  //
  // What is checked is not autoplay but the very ability to synthesise sound:
  // CSP has nothing to do with Web Audio, and if the platform does not cut sound
  // off, a disk will make noise as soon as it gets any user gesture.

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001; // hearing it is not required, the fact is what matters
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    await ctx.resume().catch(() => {});
    record('audio', ctx.state === 'running' ? 'GRANTED' : 'SUSPENDED', 'state: ' + ctx.state);
    osc.stop();
    ctx.close();
  } catch (e) {
    record('audio', 'DENIED', e.name + ': ' + e.message);
  }

  // ── gamepad ───────────────────────────────────────────────────────────────
  //
  // A permissions policy rather than a sandbox flag, and the one whose default
  // allowlist is `*`: the frame keeps the feature even though it is
  // cross-origin and is given no `allow` attribute. The list of pads proves
  // nothing on a machine with none plugged in, so the policy is asked directly
  // — that is the fact the capability table rests on.

  try {
    const policy = document.featurePolicy || document.permissionsPolicy;
    const allowed = policy ? policy.allowsFeature('gamepad') : null;
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    record(
      'gamepad',
      allowed === null ? 'POLICY UNKNOWN' : allowed ? 'ALLOWED BY POLICY' : 'BLOCKED BY POLICY',
      (pads === null ? 'no getGamepads' : 'slots: ' + pads.length) +
        ', connected: ' +
        (pads ? pads.filter(Boolean).length : 0),
    );
  } catch (e) {
    record('gamepad', 'REFUSED', e.name);
  }

  room.send({ t: 'perms-report', results });
  console.log('DONE');
})();
