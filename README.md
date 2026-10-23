# FamilyStories

One shared timeline for the whole family. Anyone with a Homeroom account can
add a memory: what happened, the year it happened (and the exact day when
they know it), the story, an optional photo, an optional voice note, and the
family members who were there. Every relative reads them in the order the
moments happened, oldest first, grouped under the year, and can filter the
timeline to one person.

Built on Homeroom: people sign in through the platform (the app never asks for
a login of its own), guests can read the timeline, and nothing is stored
anywhere else.

## How it works

- **The timeline** is the app's only screen (`public/index.html`). Each entry
  shows its date (or just the year), its photo, the title, the story, the
  people tagged on it, its voice note, and who added it. Memories are grouped
  under a yellow year marker and ordered by the day they happened, oldest
  first.
- **Filters.** A row of chips above the timeline holds "Everyone" plus every
  family member named on a memory; tapping one narrows the timeline to that
  person.
- **Adding a memory** opens the native UI kit's modal with: what happened, the
  year, an optional exact day, the story, an optional photo, an optional voice
  note and the family members who were there. The server checks every rule the
  form checks.
- **Photos** are downscaled in the page and uploaded through the platform's
  file storage (`usernode.uploadFile`); only the returned URL is stored. Where
  there is no platform shell the form says photos are unavailable and the
  story can still be saved.
- **Voice notes** are recorded with the microphone (the capability is declared
  in `dapp.json`), capped at two minutes, and uploaded to the app itself,
  because the platform's file storage accepts images only.
- **Guests** (visitors without a Homeroom account) can read the whole
  timeline, including its photos and voice notes. Tapping "Add a memory" asks
  them to make an account first.

## Data

The `memories` table is created on boot in `server.js`:

| Column | Meaning |
| --- | --- |
| `id` | `BIGSERIAL` primary key |
| `user_id` | the Homeroom id of whoever added it |
| `username` | their username at the time, shown as "Added by" |
| `title` | up to 120 characters |
| `body` | the story, up to 5,000 characters |
| `happened_on` | the calendar day it happened (`DATE`, no time zone) |
| `date_precision` | `day`, or `year` when only the year is known (then the day is 1 January) |
| `people` | the family members tagged on it (`TEXT[]`, up to 8 names) |
| `photo_url` | the platform-stored photo URL, or null |
| `photo_id` | the platform's file id, so the photo can be deleted with the memory |
| `created_at` | when it was added; breaks ties on the same day |

A voice note lives in `memory_audio`: one row per recording, keyed by a random
id, attached to a memory once the memory is saved (`memory_id`, `ON DELETE
CASCADE`). It holds the audio bytes, its content type and its length in
milliseconds, and is capped at two minutes.

Both tables are marked `COMMENT ON TABLE ... IS 'staging:private'`: the staging
preview gets the schema but none of the real family's rows.

### API

- `GET /api/memories` answers `{ memories, signedIn }`, oldest first, up to
  2,000 memories. Each row carries `audio_duration_ms` (null when there is no
  recording); the audio itself is never inlined. Members and guests can read.
- `POST /api/memories` saves one memory for the signed-in member and answers
  `201 { memory }`. It accepts `photo_url`, `photo_id`, `people`, `date_precision`
  and `audio_id`. Validation failures answer `400` with a plain message.
- `POST /api/memories/audio?duration_ms=N` takes the raw recording (an `audio/*`
  body, 4 MB at most) and answers `201 { id, duration_ms }`. The id is then
  passed to `POST /api/memories`, which attaches it in the same transaction.
- `GET /api/memories/:id/audio` serves the recording with range support, so the
  player can seek. Guests can listen, like they can read the story.
- `POST /usernode/user-deletion` and `GET /usernode/user-export` are the
  platform's account-data requests, verified with the platform token: they
  delete, or export, the person's memories and recordings.

### Staging seed

On boot, and only when `USERNODE_ENV=staging`, three obviously fake memories
(titled "Staging demo: ...") are inserted with fixed ids, so the preview shows
a filled timeline with photos, family-member filters and a voice note. Photos
are inline placeholder images (platform-stored files are not copied into
staging) and the voice note is a generated two-second tone. They are
idempotent and never touch real rows.

## Running locally

```sh
npm ci
DATABASE_URL=postgres://... npm start
```

`npm run build` compiles `styles/tailwind-input.css` to `public/tailwind.css`;
the Docker image does that on every build.
