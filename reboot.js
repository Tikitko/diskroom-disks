/**
 * @disk     reboot
 * @author   diskroom
 * @version  1
 * @players  1-8
 * @about    A test fixture, not an example. It replaces its own frame with the frame document again, which the policy allows, to check that the platform does not feed the loop that makes.
 * @tags     fixture, sandbox, security
 */
// reboot.js — the navigation the policy is supposed to allow.
//
// `frame-src` on the platform page names the sandbox origin, so a disk setting
// its `location` to an address on that origin is not refused: it gets the frame
// document again, with a fresh shim in it. There is nothing to close here —
// closing it would mean naming no origin at all and having no frame.
//
// What must not happen is the round trip. A shim that comes up announces
// itself ready, and were the platform to answer that with the disk's source
// the way it answers the first one, this file would run again and navigate
// again: a loop in the browser of every participant, asking the server for the
// document each time round, and looking alive throughout because the shim goes
// on beating. So the platform boots a mounted frame once and says in the disk
// console why it will not do it twice (`crates/web/src/frame.rs`).
//
// `scripts/frame_nav_e2e.mjs` counts the frame's navigations: one to mount it,
// one from here, and no third.

let ticks = 0;
setInterval(() => console.log('still running, tick ' + ++ticks), 300);

setTimeout(() => {
  console.log('replacing our own frame with ' + location.pathname);
  location.href = location.pathname + '?again=' + Date.now();
}, 700);
