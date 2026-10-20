# FamilyStories

FamilyStories is a shared family timeline. Each relative adds a memory — what
happened, the story and the date the moment happened — and the app shows
everyone's memories together in the order they happened, oldest first,
grouped under a yellow year marker.

## Reading and adding

Anyone who can open the app can read the whole timeline, and a visitor
without a Homeroom account (a guest) can read it too. Adding a memory needs a
Homeroom account: tapping **Add a memory** as a guest asks for one first.

Each memory shows the date it happened, its title, the story (line breaks
kept) and **Added by** with the username of the person who added it. The
three fields are all required, and the date must be a real day between
1 January 1800 and today. Memories cannot be edited or deleted in this
version.

## Data

One table, created on boot by `migrate()` in `server.js`:

```sql
memories (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT,          -- the Homeroom id, so deletion and export find the rows
  username    TEXT,          -- shown as "Added by"
  title       TEXT,
  body        TEXT,
  happened_on DATE,          -- a calendar day, no time zone
  created_at  TIMESTAMPTZ    -- req.now at the time it was added
)
```

`happened_on` is always selected as text (`to_char(happened_on, 'YYYY-MM-DD')`)
so `pg` never turns it into a JavaScript `Date` and shifts the day by the
server's time zone. The table is marked `staging:private`, so a staging copy
gets the schema without production rows.

On staging the app seeds three obviously invented memories, each titled
"Staging demo: …", so a filled timeline can be seen. Real memories are never
copied into staging.

### API

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/memories` | members and guests | The timeline, oldest first, plus `signedIn` |
| `POST /api/memories` | members | Validates `title`, `body` and `happened_on`, then adds a memory |
| `POST /usernode/user-deletion` | platform only | Deletes the person's memories by `user_id` (idempotent) |
| `GET /usernode/user-export` | platform only | Returns the person's memories as `{ userId, tables: { memories } }` |

## Running locally

The app needs `DATABASE_URL` (Postgres) and, on staging, `USERNODE_ENV=staging`:

```sh
npm ci
DATABASE_URL=postgres://… npm run build   # compiles public/tailwind.css
DATABASE_URL=postgres://… USERNODE_ENV=staging node server.js
```

The server creates the table and index on boot. `GET /health` answers 200
while it is serving and 503 while it is shutting down.
