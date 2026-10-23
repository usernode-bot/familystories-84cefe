# FamilyStories

One shared timeline for the whole family. Anyone with a Homeroom account can
add a memory, with a title, the story and the day it happened; every relative
reads them in the order the moments happened, oldest first, grouped under the
year.

Built on Homeroom: people sign in through the platform (the app never asks for
a login of its own), guests can read the timeline, and nothing is stored
anywhere else.

## How it works

- **The timeline** is the app's only screen (`public/index.html`). It shows
  each memory's date, title, story and who added it. Memories are grouped by
  year and ordered by the day they happened, oldest first.
- **Adding a memory** opens a short form with three required fields: what
  happened, when it happened, and the story. The date must be a real day, not
  in the future and not before 1 January 1800. The server checks every rule
  the form checks.
- **Guests** (visitors without a Homeroom account) can read the whole
  timeline. Tapping "Mulai cerita pertama" asks them to make an account
  first.
- **The first screen** explains the app: a purpose headline, the empty
  state with three example memories under a "Contoh" label, and the three
  short steps (Tulis, Tambah foto, Undang keluarga). The examples go away
  as soon as the timeline has a story in it.

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
| `created_at` | when it was added; breaks ties on the same day |

The table is marked `COMMENT ON TABLE memories IS 'staging:private'`: the
staging preview gets the schema but none of the real family's rows.

### API

- `GET /api/memories` answers `{ memories, signedIn }`, oldest first, up to
  2,000 memories. Members and guests can read it.
- `POST /api/memories` saves one memory for the signed-in member and answers
  `201 { memory }`. Validation failures answer `400` with a plain message.
- `POST /usernode/user-deletion` and `GET /usernode/user-export` are the
  platform's account-data requests, verified with the platform token: they
  delete or export the memories of the person whose account is closing.

### Staging seed

On boot, and only when `USERNODE_ENV=staging`, three obviously fake memories
(titled "Staging demo: ...") are inserted with fixed ids, so the preview
shows a filled timeline. They are idempotent and never touch real rows.
Opening the preview at `/?demo=1` asks `GET /api/memories?demo=1` to leave
those seeded rows out (staging only), so the empty first screen can be seen.

## Running locally

```sh
npm ci
DATABASE_URL=postgres://... npm start
```

`npm run build` compiles `styles/tailwind-input.css` to `public/tailwind.css`;
the Docker image does that on every build.
