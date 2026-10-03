# AGENTS.md

How a game disk for this repository is picked, built, checked and drawn — for
whoever writes the next one, by hand or as the routine that writes one game a
run. It is the owner's file: a run that writes a game reads it and never edits
or deletes it.

The platform's own rules are not repeated here, because two copies of a rule
are two rules the moment one of them is edited. They live in the diskroom
repository, and this file only points at them:

- `AGENTS.md` — the sandbox, the lockstep kernel, the push order between this
  repository and the platform's submodule pointer;
- `crates/web/public/skill.md` — the disk format, the `room` API, the header,
  the checklist before handing a disk over;
- `.claude/skills/diskroom-operator/references/review.md` — what the operator
  checks before verifying a disk, and what gets one taken down.

Read all three in full before writing anything, and read a few games here as
references: host-run `quiz.js`, `scribble.js`, `hang.js`, `outbid.js`,
`liars_dice.js`; lockstep `pong.js`, `tag.js`, `shooter.js`, `blade_dome.js`,
`updraft.js`, `glint.js`.

## Picking a game

- Not already here (the `@disk` names in `*.js`), not on the shelf (the names
  in the operator's list — names are all you take from the shelf), and not
  rejected (the list at the end of this file). That covers a renamed copy and
  the same core loop under another theme: when an idea is close to a
  rejected entry, pick another.
- A new mechanic, not a reskin. Two players or more, rounds of a few minutes.
- Worth playing, not a tech demo: no bare clones of tic-tac-toe,
  rock-paper-scissors, click races or "move a square".
- Before writing code, write down the hook in one sentence, the real decision
  players make every few seconds, what creates tension (escalation, a
  shrinking arena, a timer, risk and reward), what keeps a losing player in
  the game (a comeback), and why people would press "again". When any of these
  has no answer, pick another idea.

## Architecture

- **Lockstep**, for realtime games: carry the shared kernel exactly as the
  platform's AGENTS.md describes, run `./scripts/lockstep/splice.py` and then
  `--check`, give the disk a hand of its own in `scripts/lockstep/sim.mjs` and
  `scripts/lockstep_e2e.mjs`, and make `node scripts/lockstep/sim.mjs` pass.
  Never edit the kernel itself; if splice touched any other disk, revert that.
  Inside a step: no clocks, no `Math.random`, no function a browser may round
  its own way.
- **Host-run**, for turn-based, party and hidden-information games: the host
  decides and broadcasts, and a table is accepted only `fromHost(from)`.

## The file

`<snake_name>.js`, with the header exactly as skill.md gives it. A disk Claude
writes says `@author claude`; a new disk is `@version 1`, and every change to
one moves it on by one. `@tags` never says `fixture` or `toy`. The picture is
`@image https://storage.tikitko.dev/diskroom/disks/thumbnails/<snake_name>.png`
— uploaded by hand later, so nobody fetches or checks it. Under 256 KB, no
imports, no `eval` or `new Function`, no external URL in the code.

## Playing alone

Every game starts the same way for a player with nobody else in the room, and
it is part of the game, not an afterthought:

- **A bot plays with them at once.** No lobby button, no countdown to bots.
  - Lockstep: the bot is a player in the table with an id no room hands out
    (`-100`; a copy outside a room is `-1`), seated only while the table
    waits for a round, moved by the step from the table alone, so it plays
    the same on every copy and says nothing over the wire. It is beatable:
    it decides every few steps, and now and then it hesitates.
  - Host-run: the host deals a practice table with bots straight away, and
    the next one when it is over. With other people already in the room it
    first waits a few seconds for their disks to say hello, so nobody sees a
    practice table flash up.
- **The bot never takes part in a real round.**
- **Somebody joins: practice ends three seconds on.** Every copy shows
  `<nick> joined · practice ends in N` (the newcomer sees
  `you joined <nick> · …`); lockstep keeps the count in the table, host-run
  sends the milliseconds left with the table. Then the bot leaves — before the
  round is laid out, so seats close up without it — and the real round starts.
- **The practice note.** One block of code, byte for byte the same in every
  game: the section headed `the practice note` (`practiceNote`). Copy it
  unchanged from a disk that has it; never restyle it per game. It says
  `practice with the bot · a round starts when someone joins` (host-run:
  `practice with bots · a game starts when someone joins`) and one tip line
  for this game, and folds to its first line after six seconds or the first
  key or touch. It goes into an empty strip beside the field when one fits,
  otherwise at the foot of the screen above the line of controls — never over
  the top of the screen. When the field leaves no strip and its bottom row
  matters, keep `NOTE_ROOM = 60` free under the field for it, as `glint.js`,
  `flock.js` and `wind_up.js` do.
- The status line says `practice` while it lasts.

## Look and feel

Players should enjoy it in the first ten seconds.

- A deliberate look: one coherent palette, each player a distinct colour tied
  to their seat, clean shapes, readable type, a background that is not plain
  black. It fits the frame at any size and devicePixelRatio, phone portrait
  included; nothing cropped or blurry.
- Motion: drawn between simulation steps, eased in and out; nothing
  teleports. Physics advances in fixed steps counted off a clock, never one
  step per frame.
- Feedback for every action: hit flashes, small bursts of particles, a little
  shake or squash on impact, score pops. Short sounds synthesized with
  WebAudio (no files), started from a gesture, with a mute toggle.
- Clarity: a one-line how-to on screen, whose turn, time left and scores
  always visible, a round-end screen naming the winner, a clear way into the
  next round.
- Touch controls are drags only, bound to the canvas with
  `setPointerCapture` — iOS keeps a long press inside the frame for itself —
  plus mouse and keyboard.
- All of it cheap: within the size limit, and no network message for an
  effect; effects come from the table as it changes.

## Hostile clients

Any other player may run a modified copy from the console and send anything
at any rate. Give the disk the strongest protection its architecture allows
without hurting honest play:

- Identity comes from `from`, never from a field in the payload.
- Every incoming message is checked on receipt: a known `t` only, types
  checked, numbers finite and clamped to their range, strings and arrays
  capped, ids current players. Anything else is dropped silently; the handler
  never throws (its body is in try/catch) and never kicks for one bad
  message. In lockstep, inputs are made safe inside the step, so every copy
  drops or clamps the same input alike and no two tables diverge.
- Inputs, not outcomes: no message declares a score, a hit, a win or an
  impossible position. Turn order, legal moves, speed and cooldowns are
  enforced where the game has them.
- A per-sender rate limit, so one flooder cannot stall the game for everyone.
- Tolerances wide enough for real latency: an honest player who lags is never
  rejected or rubber-banded.
- Text from peers is never rendered as HTML (`fillText` / `textContent`).
- Hidden information (hands, answers, roles) goes only to whoever may see it,
  with `{ to }` — never broadcast and hidden in the UI.
- What cannot be prevented (a hostile host in a host-run game, a client
  reading its own copy of a lockstep table) is said plainly in the report.

## Before handing it over

Re-read the whole file against review.md and skill.md's checklist: nothing
that would be grounds for a takedown or for withholding verification; no
network, no storage tricks, no dishonest UI; none of the bugs that break
rooms — `room.me` null when solo, a late joiner not seeing the same game, the
host leaving mid-turn, more than 20 sends a second, a handshake that loops.
Then re-read it as a player: is the hook there, does it look and feel as
above, does playing alone work as above? Fix what you find.
`node --check <file>` must pass. Nothing runs the disk but the lockstep sim.

## The thumbnail

`thumbnails/<snake_name>.png`, 182×96, in the style of the ones already there
(open two or three first): a dark background, a thin rounded frame, flat
colours, a still frame of this game that makes somebody want to click it.
Drawn with a throwaway script, which is not committed; the PNG is not
uploaded anywhere — the owner does that by hand.

## Rejected games

Written for this repository and rejected by its owner; their code is gone.
Do not write any of them again — that covers a renamed copy, and a game that
keeps the same core loop under a different theme. To reject another, the
owner deletes its disk and picture (and its hands in the platform repository)
and adds an entry here.

### cave_in

A push-your-luck mine crawl for 2-8 players, run by the host. A card is
flipped each turn. Gems are split among the players still in the mine, and
each player secretly picks to dig deeper or run home with their haul. The
second hazard of the same kind buries everyone who stayed. (Incan Gold /
Diamant.)

### lantern_lake

A night-fishing deduction game for 2-8 players, run by the host. Fish are
hidden on a grid. Each round everyone casts into a cell at once. A cast
privately tells its caster how far away the nearest fish is, while everyone
sees where each player cast. Two lines in the same cell tangle and the fish
escapes.

### lighthouse

An asymmetric realtime game in lockstep for 2-8 players. One player keeps
the lighthouse and sweeps its beam across a bay. Everyone else rows crates to
the coves and hides in the shadows of rocks. A boat the beam stays on is
caught, and players take turns at the lamp.

### bento

A drafting game for 2-8 players, run by the host. Everyone is dealt a hidden
tray of dishes, takes one at once, puts it into an empty compartment of their
own three-by-three box and passes the rest on. Every dish scores by where it
sits: salmon apart, tempura in clumps, pickles in corners, tamago in lines,
rice beside different dishes, mochi saved for the end. Whoever trails gets a
middle compartment that counts double. (Sushi Go with a grid.)

### grapple

A realtime climb in lockstep for 2-8 players. Everyone swings up a volcano
shaft on a grappling hook while the lava rises: grab a crystal, let go at the
top of the swing to fly to the next one. Crystals crack if you hang on too
long, and a hard swing into a rival knocks them off their rope and steals a
gem.
