/**
 * @disk     quiz
 * @author   diskroom
 * @version  4
 * @players  2-8
 * @about    A live quiz. The quizmaster types a question and its answers, the room picks one, and every answer travels to the quizmaster alone until they reveal which one was right.
 * @tags     game, party, trivia, example
 * @image    https://storage.tikitko.dev/diskroom/disks/thumbnails/quiz.png
 */
// quiz.js — the disk that shows what an addressed message is for.
//
// The quizmaster is whoever the platform currently calls the host. They write
// the question here in the frame and put it on the air; every answer comes back
// with `room.send(..., { to })` and lands on that one seat. What arrives about
// the quiz — a question, a reveal, a mark, a catch-up — counts only when the
// room says the host sent it, so a player with a console open cannot put a
// question of their own on the air or rewrite the board. A neighbour never
// learns what you picked — not because this interface hides it, but because the
// server carries the message to one socket and to no other.
//
// Each copy counts the addressed messages that reach it and, of those, how many
// were somebody else's business. That second number is the check the disk keeps
// on the platform, in front of the person playing: it must stay at zero.
//
// The authority is the disk's own choice, not the platform's doing. Here it is
// the plainest one there is — the quizmaster holds the right answer and marks
// what comes in — and it carries the plainest consequence: nothing stops a
// quizmaster from marking their friend generously. There is no anti-cheat here
// and none is claimed.

// A question, its answers and the board all travel in one payload, and the
// ceiling is 4 KiB. These caps leave a round an order of magnitude below it; a
// text field with no cap at all is how a disk meets `RangeError` in front of a
// room.
const OPTIONS = 4;   // answer slots the composer offers
const Q_MAX = 160;   // characters of a question that go on the wire
const A_MAX = 48;    // ... and of one answer
const POINTS = 100;  // for a correct answer

// The platform's own colour tokens, copied by hand. A disk is a page of its own
// with no reach into the stylesheet around it, so looking like diskroom is a
// choice this file makes rather than something it inherits.
const C = {
  bg: '#1c1c1c', sunken: '#1f1f1f', surface: '#242424', border: '#2f2f2f',
  text: '#f5f5f5', dim: '#ededed', muted: '#8f8f8f', faint: '#6e6e6e',
  ok: '#a9c0a9', bad: '#d3a9a9',
};
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

// ── state. Entirely ours: the platform knows none of it ─────────────────────

let round = null;       // { n, q, a } — what the whole room knows
let secret = null;      // the right answer; the quizmaster's alone until revealed
let revealed = null;    // the right answer once it is public
let mine = null;        // what I picked this round
let mark = null;        // true / false — what the quizmaster said back, to me alone
let lastN = 0;          // the last question number seen, so a new quizmaster continues it
const picks = new Map();   // player id -> answer. Only the quizmaster fills this in
const scores = new Map();  // player id -> points
let addressed = 0;      // messages that arrived with a `to` on them
let leaked = 0;         // of those, the ones that were none of our business

// `room.me` and `room.host` are null in the studio, where there is no room to
// be in. The disk runs there as its own quizmaster, so the whole flow can be
// tried before it ever meets a second person.
const myId = () => (room.me ? room.me.id : -1);
const master = () => !room.me || (room.host !== null && room.host.id === room.me.id);
const fromHost = (from) => room.host !== null && from === room.host.id;

// ── the screen ──────────────────────────────────────────────────────────────

function el(tag, css, text) {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A thumb is a blunter instrument than a mouse pointer, and a phone browser
// zooms the whole page when a field smaller than 16px is focused — which on a
// screen with `overflow:hidden` leaves the quizmaster typing into a composer
// half of which is now off the side. Both are answered by measurements rather
// than by a second layout, so there is one screen here and not two.
const COARSE = matchMedia('(pointer: coarse)').matches;
const TAP = COARSE ? 44 : 0;        // px: the smallest a finger can be asked to hit
const FIELD_SIZE = COARSE ? 16 : 14;

document.body.style.cssText =
  `margin:0;height:100vh;overflow:hidden;background:${C.bg};color:${C.dim};` +
  `font:14px/1.45 ${FONT}`;

// The column scrolls rather than clipping. A composer with four answer slots
// and a board under it is taller than a phone held upright, and taller still
// with the keyboard up; clipped, the button that puts the question on the air
// is simply not on the screen and nothing says where it went.
const root = el('div',
  'box-sizing:border-box;height:100%;padding:16px;display:flex;flex-direction:column;gap:12px;' +
  'overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain');
document.body.appendChild(root);

const head = el('div',
  `display:flex;justify-content:space-between;gap:12px;font:11px ${MONO};color:${C.muted}`);
const role = el('span');
const counter = el('span');
head.append(role, counter);
root.appendChild(head);

const FIELD =
  `box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid ${C.border};` +
  `border-radius:3px;background:${C.sunken};color:${C.text};font:inherit;outline:none;` +
  `font-size:${FIELD_SIZE}px;min-height:${TAP}px`;

function button(label, primary) {
  return el('button', 'padding:10px 14px;font:inherit;border-radius:3px;cursor:pointer;' +
    `min-height:${TAP}px;` +
    (primary
      ? `border:0;background:${C.dim};color:${C.bg}`
      : `border:1px solid ${C.border};background:${C.surface};color:${C.dim}`), label);
}

// The composer is built once and kept, not rebuilt on every render: a roster
// change repaints this screen, and a field recreated under the quizmaster's
// hands loses what they were halfway through typing.
const composer = el('div', 'display:flex;flex-direction:column;gap:8px');
const qField = el('input', FIELD + ';font-size:16px');   // never smaller: see COARSE above
qField.maxLength = Q_MAX;
qField.placeholder = 'Ask the room something';
composer.appendChild(qField);

const slots = [];
for (let i = 0; i < OPTIONS; i += 1) {
  const row = el('div', 'display:flex;align-items:center;gap:8px');
  const right = el('input');
  right.type = 'radio';
  right.name = 'right';
  right.title = 'the right answer';
  const dot = COARSE ? 22 : 15;
  right.style.cssText = `accent-color:${C.dim};width:${dot}px;height:${dot}px;flex:none;cursor:pointer`;
  const text = el('input', FIELD);
  text.maxLength = A_MAX;
  text.placeholder = 'Answer ' + (i + 1) + (i < 2 ? '' : ' (optional)');
  row.append(right, text);
  composer.appendChild(row);
  slots.push({ right, text });
}

const ask = button('Put it on the air', true);
const hint = el('div', `font:11px ${MONO};color:${C.faint}`);
composer.append(ask, hint);

const view = el('div', 'display:flex;flex-direction:column;gap:10px;min-height:0');
const questionText = el('div', `font-size:17px;color:${C.text}`);
// Two columns, and one where two do not fit: an answer runs to 48 characters,
// and half the width of a phone held upright is about four words to the line.
// The rule is asked again when it changes rather than read once, because
// turning a phone on its side changes the answer and nothing else on this
// screen would repaint it.
const optionGrid = el('div', 'display:grid;gap:8px');
const narrow = matchMedia('(max-width: 420px)');
const layOutOptions = () => {
  optionGrid.style.gridTemplateColumns = narrow.matches ? '1fr' : '1fr 1fr';
};
narrow.addEventListener('change', layOutOptions);
layOutOptions();
const status = el('div', `min-height:18px;font:12px ${MONO};color:${C.muted}`);
const actions = el('div', 'display:flex;gap:8px');
view.append(questionText, optionGrid, status, actions);

const board = el('div',
  'margin-top:auto;flex:none;display:flex;flex-direction:column;gap:4px;font-size:13px');
const leakLine = el('div', `font:11px ${MONO};color:${C.faint}`);
root.append(board, leakLine);

const revealBtn = button('Reveal the answer', true);
const nextBtn = button('New question', false);
revealBtn.onclick = () => reveal();
nextBtn.onclick = () => compose();

// ── the composer ────────────────────────────────────────────────────────────

// What is typed, as it would go on the wire. Blank slots are dropped, so a
// two-answer question is an ordinary one — and dropping them renumbers the
// right answer, which is why it is recomputed here rather than taken from the
// slot it was marked in.
function draft() {
  const q = qField.value.trim().slice(0, Q_MAX);
  const answers = [];
  let correct = -1;
  slots.forEach((slot) => {
    const text = slot.text.value.trim().slice(0, A_MAX);
    if (!text) return;
    if (slot.right.checked) correct = answers.length;
    answers.push(text);
  });
  return { q, answers, correct };
}

function refreshComposer() {
  const d = draft();
  const ready = d.q.length > 0 && d.answers.length >= 2 && d.correct >= 0;
  ask.disabled = !ready;
  ask.style.opacity = ready ? '1' : '0.45';
  ask.style.cursor = ready ? 'pointer' : 'default';
  hint.textContent = !d.q
    ? 'Type a question.'
    : d.answers.length < 2
      ? 'Fill in at least two answers.'
      : d.correct < 0
        ? 'Mark the right answer with the dot beside it.'
        : 'The room gets the question and the answers. The right one stays here.';
}

qField.oninput = refreshComposer;
slots.forEach((slot) => {
  slot.text.oninput = refreshComposer;
  slot.right.onchange = refreshComposer;
});

ask.onclick = () => {
  const d = draft();
  if (!d.q || d.answers.length < 2 || d.correct < 0) return;
  lastN += 1;
  round = { n: lastN, q: d.q, a: d.answers };
  secret = d.correct;
  revealed = null;
  mine = null;
  mark = null;
  picks.clear();
  // The question and the answers go to the room; which of them is right does
  // not. It sits in `secret` until the reveal, so there is nothing on the wire
  // for a curious disk on the other end to read ahead of everyone else.
  room.send({ t: 'q', n: round.n, q: round.q, a: round.a });
  render();
};

function compose() {
  round = null;
  secret = null;
  revealed = null;
  mine = null;
  mark = null;
  picks.clear();
  qField.value = '';
  slots.forEach((slot) => {
    slot.text.value = '';
    slot.right.checked = false;
  });
  refreshComposer();
  render();
}

// ── moves ───────────────────────────────────────────────────────────────────

function answer(i) {
  if (!round || mine !== null || master() || room.host === null) return;
  mine = i;
  // Addressed: this reaches the quizmaster's seat and no other. The neighbours
  // do not see it on the wire, so there is nothing for them to peek at.
  room.send({ t: 'a', n: round.n, i }, { to: room.host.id });
  render();
}

function reveal() {
  if (!master() || !round || secret === null || revealed !== null) return;
  revealed = secret;
  // Now, and only now, the room learns the answer — and the board with it. The
  // scores were kept here while the marks went out one seat at a time, so this
  // broadcast is also what carries them across a change of quizmaster.
  room.send({ t: 'reveal', n: round.n, right: revealed, scores: Array.from(scores) });
  render();
}

function sendState(to) {
  room.send({
    t: 'state',
    n: round.n,
    q: round.q,
    a: round.a,
    right: revealed,              // null while the answer is still ours alone
    scores: Array.from(scores),
  }, { to });
}

// ── receiving ───────────────────────────────────────────────────────────────

// A round, and a board, as they arrive from somebody else. Nothing off the wire
// is taken to be the shape this disk sent: every seat runs these same bytes, but
// a frame with a console open in it does not have to, and a malformed message
// must cost this seat a bad round rather than a dead screen.
function roundOf(msg) {
  return {
    n: Number(msg.n) || 0,
    q: String(msg.q ?? '').slice(0, Q_MAX),
    a: Array.isArray(msg.a)
      ? msg.a.slice(0, OPTIONS).map((text) => String(text).slice(0, A_MAX))
      : [],
  };
}

// An answer index is only an answer if it names one of the answers on screen: a
// number past the end would otherwise be drawn as `undefined` in the line that
// says what the right one was.
function rightOf(msg, of) {
  return Number.isInteger(msg.right) && msg.right >= 0 && msg.right < of.a.length
    ? msg.right
    : null;
}

function adoptScores(list) {
  scores.clear();
  if (!Array.isArray(list)) return;
  list.forEach((pair) => {
    if (Array.isArray(pair)) scores.set(pair[0], Number(pair[1]) || 0);
  });
}

room.on('message', (from, msg) => {
  if (!msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    // Somebody's disk has just started and is asking where the quiz is. Only
    // the quizmaster answers, and privately.
    case 'hello':
      if (master() && round) sendState(from);
      break;

    // The question, from the quizmaster and nobody else.
    case 'q':
      if (!fromHost(from)) break;
      round = roundOf(msg);
      lastN = Math.max(lastN, round.n);
      secret = null;
      revealed = null;
      mine = null;
      mark = null;
      picks.clear();
      break;

    // A catch-up for a disk that started mid-quiz. It arrived addressed, so it
    // is counted below with the rest — but it is nobody's secret, and it is not
    // a leak wherever it lands.
    case 'state':
      addressed += 1;
      if (!fromHost(from)) break;
      round = roundOf(msg);
      lastN = Math.max(lastN, round.n);
      revealed = rightOf(msg, round);
      adoptScores(msg.scores);
      break;

    case 'a': {
      addressed += 1;
      if (!master()) {
        // An answer that reached anyone but the quizmaster is the platform
        // failing at the one thing this disk rests on. It is said out loud
        // rather than counted quietly.
        leaked += 1;
        console.warn('LEAK: an answer addressed to the quizmaster reached us');
        break;
      }
      if (!round || msg.n !== round.n || picks.has(from)) break;
      const right = msg.i === secret;
      picks.set(from, msg.i);
      if (right) scores.set(from, (scores.get(from) || 0) + POINTS);
      // The mark goes back the way it came: the one who answered learns how
      // they did, and the room learns nothing until the reveal.
      room.send({ t: 'mark', n: round.n, right }, { to: from });
      break;
    }

    case 'mark':
      addressed += 1;
      if (!fromHost(from)) break;
      // Messages from one sender keep their order, so the mark for our answer
      // always arrives before that quizmaster's next question. A mark that does
      // not match the round we are on, or that answers nothing we sent, was
      // meant for somebody else.
      if (mine === null || !round || msg.n !== round.n) {
        leaked += 1;
        console.warn('LEAK: a mark meant for another player reached us');
        break;
      }
      mark = !!msg.right;
      break;

    case 'reveal':
      if (!fromHost(from) || !round || msg.n !== round.n) break;
      revealed = rightOf(msg, round);
      adoptScores(msg.scores);
      break;
  }
  render();
});

// A person walking in is not a disk starting up: they press "Run disk" when
// they like, and anything sent before that is dropped. So the catch-up is
// hung on their disk's own 'hello' above, and this handler only repaints the
// board.
room.on('join', () => render());

room.on('leave', (player) => {
  picks.delete(player.id);
  render();
});

room.on('hostchange', () => {
  // The question in the air cannot be marked or revealed any more — the right
  // answer never left the previous quizmaster — so it comes off every screen:
  // left up, an answer to it would go to the new quizmaster, who has no such
  // question, and wait for a mark that never comes. The board survives: it was
  // broadcast with every reveal.
  if (master()) console.log('the quiz is ours now, starting a fresh question');
  compose();
});

// ── drawing ─────────────────────────────────────────────────────────────────

function optionTile(text, i) {
  const chosen = mine === i;
  // The quizmaster sees the right answer from the start; everyone else sees it
  // once it has been revealed.
  const known = revealed !== null ? revealed : master() ? secret : null;
  const isRight = known === i;
  const clickable = !master() && mine === null;
  const tile = el(clickable ? 'button' : 'div',
    'box-sizing:border-box;text-align:left;padding:10px 12px;border-radius:3px;font:inherit;' +
    `min-height:${TAP}px;` +
    `border:1px solid ${isRight ? C.ok : chosen ? C.dim : C.border};background:${C.surface};` +
    `color:${isRight ? C.ok : chosen && revealed !== null ? C.bad : C.dim};` +
    'cursor:' + (clickable ? 'pointer' : 'default'));
  const taken = master() ? Array.from(picks.values()).filter((v) => v === i).length : 0;
  tile.textContent = taken ? text + '  ·  ' + taken : text;
  if (clickable) tile.onclick = () => answer(i);
  return tile;
}

function render() {
  const composing = master() && !round;
  // The half that is not in use is taken out of the page rather than hidden in
  // it: a seat with no question to ask has no business carrying the composer's
  // fields and its button around, invisible and clickable by anything that
  // walks the DOM.
  const stage = composing ? composer : view;
  const idle = composing ? view : composer;
  if (idle.isConnected) idle.remove();
  if (!stage.isConnected) root.insertBefore(stage, board);

  role.textContent = master()
    ? 'you are the quizmaster'
    : round
      ? 'answer before the quizmaster reveals it'
      : 'waiting for a question';
  counter.textContent = round ? 'question ' + round.n : master() ? 'nothing on the air' : '';

  questionText.textContent = round ? round.q : 'Waiting for the quizmaster…';

  optionGrid.textContent = '';
  if (round) round.a.forEach((text, i) => optionGrid.appendChild(optionTile(text, i)));

  if (master()) {
    const audience = room.players.filter((p) => p.id !== myId()).length;
    status.style.color = C.muted;
    status.textContent = !round
      ? ''
      : revealed !== null
        ? 'the answer is out, and the board went with it'
        : picks.size + ' of ' + audience + ' answered · only you can see who picked what';
  } else if (mark === null) {
    status.style.color = C.muted;
    status.textContent = !round
      ? ''
      : mine === null
        ? 'pick one — your answer goes to the quizmaster alone'
        : 'answer sent to the quizmaster';
  } else {
    status.style.color = mark ? C.ok : C.bad;
    status.textContent = mark
      ? 'correct'
      : revealed !== null
        ? 'wrong — it was: ' + round.a[revealed]
        : 'wrong';
  }

  actions.textContent = '';
  if (master() && round) actions.appendChild(revealed === null ? revealBtn : nextBtn);

  board.textContent = '';
  if (room.players.length) {
    room.players.forEach((p) => {
      const row = el('div', 'display:flex;justify-content:space-between;gap:12px');
      row.append(
        el('span', `color:${p.id === myId() ? C.text : C.muted}`,
          p.nick + (p.id === myId() ? ' (you)' : '')),
        el('span', `font:12px ${MONO};color:${C.muted}`, String(scores.get(p.id) || 0)),
      );
      board.appendChild(row);
    });
  } else {
    board.appendChild(el('div', `font:12px ${MONO};color:${C.faint}`,
      'no room around this disk — the board fills in a real one'));
  }

  leakLine.textContent =
    'addressed messages received: ' + addressed + ' · leaked from others: ' + leaked;
}

// ── start ───────────────────────────────────────────────────────────────────

refreshComposer();
render();

// Nothing is replayed for anyone, so a disk that has just started asks the room
// where the quiz is. The quizmaster answers privately; in the studio there is
// nobody to answer, and the composer is on screen already.
room.send({ t: 'hello' });

console.log('quiz.js up · quizmaster:', master());
