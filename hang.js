/**
 * @disk     hang
 * @author   diskroom
 * @version  2
 * @players  1-8
 * @about    A test fixture, not an example. It stops the event loop on purpose, so the platform has something real to call NOT RESPONDING.
 * @tags     fixture, diagnostic
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/hang.png
 */
// hang.js — the fixture for a disk that stops answering.
//
// It is not published as an example: what it does is exactly what a disk must
// not do, and the point is what the platform does about it.
//
// The browser gives no CPU or memory metrics, so the only sign that "the disk
// is stuck" is a silent heartbeat. This disk gets stuck on purpose: the platform
// must notice it, show "not responding" and let itself kill it with the button.
//
// The frame's separate origin is load-bearing here: with site isolation only
// the disk's process hangs, and the interface with the "Kill script" button
// stays alive.

console.log('hang.js: about to spin forever');

// Let the message get out before the thread stops for good.
setTimeout(function () {
  while (true) {}
}, 200);
