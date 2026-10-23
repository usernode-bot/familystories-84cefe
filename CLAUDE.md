# FamilyStories — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The screen this app currently ships — the "Starter template" hero with
the app's thumbnail tile and the plain-English note on how the app gets
built (by asking Homeroom bot) — is placeholder content from the
Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content. So is
the bridge `<script>`. The design kit is not placeholder either: build the
real app with it, and fill in "## Design" below.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About FamilyStories

Turn family voices into stories and a family tree

FamilyStories is one shared timeline for the whole family: anyone with a
Homeroom account can add a memory (a title, the story, the year it happened,
and optionally the exact day, a photo, a voice note and the family members
who were there), and every relative reads them in the order the moments
happened, oldest first, grouped under the year. A row of chips filters the
timeline to one family member.

- Memories live in the `memories` table (created on boot in `server.js`),
  marked `staging:private`. `happened_on` is a calendar day with no time
  zone and is always selected with `to_char(...)` so `pg` never turns it
  into a JS `Date` and shifts the day. `date_precision` is `day`, or `year`
  when the family only knows the year (the stored day is then 1 January and
  the timeline shows "Some time in 1962").
- `people` is a `TEXT[]` of family-role names typed by hand (Grandpa, Mum,
  Aku). They are not Homeroom accounts, so never look them up in the user
  directory.
- Photos go through the platform's file storage (`usernode.uploadFile`,
  `visibility: 'public'`, matching the guest-readable timeline) after being
  downscaled in the page; only `photo_url` / `photo_id` are stored.
- A voice note lives in `memory_audio`, also `staging:private`: the platform's
  storage takes images only, so a recording (two minutes at most) is kept in
  the app's own database and served from `GET /api/memories/:id/audio`.
  Pending recordings that were never attached to a memory are deleted a day
  later on boot.
- `GET /api/memories` is readable by guests; `POST /api/memories` needs a
  signed-in member. Guests who tap "Add a memory" are asked for an account
  first, through `usernode.askForAccount`.
- Staging seeds three obviously fake memories ("Staging demo: ..."), with
  placeholder photos and a generated two-second tone, on boot and only when
  `USERNODE_ENV=staging`.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** accent: ink blue (`--accent`, like the ink on an old family
  letter) for the primary button and the timeline dots; brand yellow
  (`--marker` / `--on-marker`) for the year markers; neutrals: warm greys
  (`--ground`, `--surface`, `--raised`, `--fg`, `--muted`, `--line`).
- **Signature element:** the timeline itself, a line down the page with a
  yellow year tab and an ink dot at each memory, so the family reads its
  story in the order it happened. A memory's photo is a wide card under its
  date; its voice note is the browser's own player under a "Voice note · 1:12"
  line; the people tagged on it are quiet pills.
- **Filter row:** a sideways-scrolling row of chips above the timeline.
  "Everyone" is the accent-filled one when active; the rest are outlined.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  (change their sizes in `tailwind.config.js` if you must, not their number).
  Titles and stories use `font-serif`; dates, labels and buttons stay in the
  default sans.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`,
`timeline`, `filter-bar` / `filter-chip`, `person-tag`, `memory-photo`,
`memory-voice`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

The add-memory form is presented by the native UI kit
(`unNative.presentModal`), so it rides above the on-screen keyboard and
scrolls inside the card; its Cancel and Save sit at the top. Where the kit
is not available the same form opens inline as a card. The kit's own
colours are pointed at this app's tokens in `styles/tailwind-input.css`
(`--un-accent`, `--un-sheet-bg`, ...).

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. 5.0"), never a bare value that could pass for one
  already entered.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

_(optional — e.g. "all currency values stored as integer cents, not
floats"; "the `posts` table is append-only"; "avoid adding new
dependencies"; etc.)_
