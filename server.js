const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// A voice note is short on purpose: the platform's file storage takes images
// only, so the recording lives in this app's own database. Two minutes of
// compressed speech is a few hundred KB.
const AUDIO_MAX_MS = 120000;
const AUDIO_MAX_BYTES = 4 * 1024 * 1024;
const AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/x-m4a',
]);

// A photo is a URL from the platform's file storage. Nothing but an http(s)
// URL or a platform-relative file path is stored, so a memory can never carry
// a `javascript:` or `data:` payload that another relative's browser would
// run.
function photoUrlOrNull(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || url.length > 2048) return null;
  if (/^https?:\/\/\S+$/i.test(url)) return url;
  if (/^\/app-files\/[A-Za-z0-9._-]+$/.test(url)) return url;
  return null;
}

// The members a memory is tagged with. Free text (Grandpa, Mum, Aku), because
// these are family roles rather than Homeroom accounts.
function peopleOrError(input) {
  if (input === undefined || input === null) return { people: [] };
  if (!Array.isArray(input)) {
    return { error: 'people_invalid', message: 'Anggota keluarga tidak bisa dibaca.' };
  }
  const people = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (name.length > 40) {
      return { error: 'person_too_long', message: 'Setiap nama maksimal 40 karakter.' };
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(name);
    if (people.length > 8) {
      return { error: 'too_many_people', message: 'Tandai paling banyak 8 orang pada satu kenangan.' };
    }
  }
  return { people };
}

// Memories are family stories: personal information, so the table is
// `staging:private` (schema on staging, no production rows). Created on boot,
// idempotently, before the app starts listening.
//
// `memory_audio` holds a memory's voice note. The platform's file storage
// accepts images only, so a short recording is kept here instead: capped at
// two minutes and a few hundred KB, marked private like the memories
// themselves.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id          BIGSERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      happened_on DATE NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS date_precision TEXT NOT NULL DEFAULT 'day';
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS people TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS photo_url TEXT;
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS photo_id TEXT;
    DO $$ BEGIN
      ALTER TABLE memories ADD CONSTRAINT memories_date_precision_check
        CHECK (date_precision IN ('day', 'year'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS memories_happened_on_idx
      ON memories (happened_on, created_at, id);
    COMMENT ON TABLE memories IS 'staging:private';

    CREATE TABLE IF NOT EXISTS memory_audio (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      memory_id    BIGINT UNIQUE REFERENCES memories(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      duration_ms  INTEGER NOT NULL,
      bytes        BYTEA NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS memory_audio_user_idx ON memory_audio (user_id);
    COMMENT ON TABLE memory_audio IS 'staging:private';
  `);

  // A recording that was uploaded but never attached to a memory (the person
  // changed their mind, or the save failed) is dropped a day later.
  await pool.query(
    `DELETE FROM memory_audio WHERE memory_id IS NULL AND created_at < now() - interval '1 day'`
  );

  if (IS_STAGING) {
    // Obviously fake rows so the staging preview shows a filled timeline.
    // Fixed ids far above the BIGSERIAL sequence, so they never collide with
    // a real memory; nothing in the app reads them to decide anything.
    // Photos are inline placeholder images: platform-stored files are not
    // copied into staging.
    const demoPhoto =
      'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%20640%20360%27%3E%3Cdefs%3E%3ClinearGradient%20id=%27g%27%20x1=%270%27%20y1=%270%27%20x2=%270%27%20y2=%271%27%3E%3Cstop%20offset=%270%27%20stop-color=%27%23f0e2c4%27/%3E%3Cstop%20offset=%271%27%20stop-color=%27%23c2a274%27/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect%20width=%27640%27%20height=%27360%27%20fill=%27url(%23g)%27/%3E%3Ccircle%20cx=%27490%27%20cy=%2792%27%20r=%2742%27%20fill=%27%23fff8e6%27%20opacity=%270.8%27/%3E%3Cpath%20d=%27M0%20296%20L150%20206%20L300%20276%20L450%20196%20L640%20296%20L640%20360%20L0%20360%20Z%27%20fill=%27%23614a32%27%20opacity=%270.5%27/%3E%3C/svg%3E';

    await pool.query(
      `INSERT INTO memories (id, user_id, username, title, body, happened_on, date_precision, people, photo_url, created_at) VALUES
        (900001, 'staging-demo-1', 'staging-demo-user', 'Staging demo: Nenek membuka toko roti',
         E'Cerita contoh untuk pratinjau staging. Tokonya hanya punya satu oven, dan bel di atas pintu berbunyi setiap kali ada yang masuk.',
         '1962-04-14', 'day', ARRAY['Grandma', 'Grandpa'], $1, '2026-01-01T09:00:00Z'),
        (900002, 'staging-demo-2', 'staging-demo-cousin', 'Staging demo: Keluarga pindah ke pesisir',
         E'Cerita contoh untuk pratinjau staging. Semua barang masuk satu mobil, dan kucing ikut duduk di kursi depan sepanjang jalan.',
         '1978-08-02', 'day', ARRAY['Mum', 'Uncle Ray'], $1, '2026-01-01T09:01:00Z'),
        (900003, 'staging-demo-3', 'staging-demo-aunt', 'Staging demo: Reuni pertama di taman',
         E'Cerita contoh untuk pratinjau staging. Empat puluh orang, tiga meja piknik disatukan, dan kue berbentuk rumah lama.',
         '1995-01-01', 'year', ARRAY['Grandma', 'Mum'], NULL, '2026-01-01T09:02:00Z')
      ON CONFLICT (id) DO NOTHING`,
      [demoPhoto]
    );

    // A two-second placeholder tone for the first demo memory, so the voice
    // player is reviewable in the preview without anyone recording.
    await pool.query(
      `INSERT INTO memory_audio (id, user_id, memory_id, content_type, duration_ms, bytes, created_at)
       VALUES ('stagingdemoaudio000000000000000001', 'staging-demo-1', 900001, 'audio/wav', 2000, $1, '2026-01-01T09:00:00Z')
       ON CONFLICT (id) DO NOTHING`,
      [demoVoiceWav()]
    );
  }
}

// A short, quiet tone as a mono 8-bit WAV. Only ever used for the staging
// demo, so the audio player and its length label can be seen in a preview.
function demoVoiceWav() {
  const rate = 8000;
  const seconds = 2;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate, 28);
  buffer.writeUInt16LE(1, 32); // block align
  buffer.writeUInt16LE(8, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const fade = Math.max(0, Math.min(1, t * 6, (seconds - t) * 6));
    const value = Math.sin(2 * Math.PI * 440 * t) * 0.18 * fade;
    buffer[44 + i] = Math.round(128 + value * 127);
  }
  return buffer;
}

// The two requests the platform sends when a person deletes their account or
// asks for a copy of their data. They carry no sign-in token: a platform
// token in `x-usernode-platform-token`, with `pur` naming the job.
function platformClaims(req, pur) {
  const token = req.headers['x-usernode-platform-token'];
  if (!token || !JWT_PUBLIC_KEY || !APP_AUDIENCE) return null;
  try {
    const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
      algorithms: ['RS256'],
      issuer: 'usernode',
      audience: APP_AUDIENCE,
    });
    return claims && claims.pur === pur ? claims : null;
  } catch { return null; }
}

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Account data: mounted before the sign-in middleware, because the platform
// sends them server to server with no person's browser involved.
app.post('/usernode/user-deletion', async (req, res) => {
  const claims = platformClaims(req, 'user-deletion');
  if (!claims) return res.sendStatus(403);
  try {
    await pool.query('DELETE FROM memory_audio WHERE user_id = $1', [String(claims.id)]);
    await pool.query('DELETE FROM memories WHERE user_id = $1', [String(claims.id)]);
    return res.sendStatus(204);
  } catch (err) {
    console.error('user-deletion failed:', err);
    return res.sendStatus(500);
  }
});

app.get('/usernode/user-export', async (req, res) => {
  const claims = platformClaims(req, 'user-export');
  if (!claims) return res.sendStatus(403);
  try {
    const result = await pool.query(
      `SELECT id, username, title, body, to_char(happened_on, 'YYYY-MM-DD') AS happened_on,
              date_precision, people, photo_url, created_at
         FROM memories WHERE user_id = $1 ORDER BY happened_on ASC, created_at ASC, id ASC`,
      [String(claims.id)]
    );
    const audio = await pool.query(
      `SELECT id, memory_id, content_type, duration_ms, created_at, encode(bytes, 'base64') AS bytes_base64
         FROM memory_audio WHERE user_id = $1 ORDER BY created_at ASC`,
      [String(claims.id)]
    );
    return res.json({
      userId: String(claims.id),
      tables: { memories: result.rows, memory_audio: audio.rows },
    });
  } catch (err) {
    console.error('user-export failed:', err);
    return res.sendStatus(500);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// One shared family timeline, oldest memory first. Guests may read it; only a
// signed-in member may add to it. The recording itself never travels in this
// list: `audio_duration_ms` is enough to draw its player.
app.get('/api/memories', async (req, res) => {
  try {
    // The staging seed fills the preview's timeline. `?demo=1` (staging only)
    // leaves those seeded rows out, so the empty first screen, with its
    // example cards, can be reviewed and checked there. Production has no
    // seeded rows, so this branch never runs on the live app.
    const demo = IS_STAGING && req.query.demo === '1';
    const result = await pool.query(
      `SELECT m.id, m.username, m.title, m.body,
              to_char(m.happened_on, 'YYYY-MM-DD') AS happened_on,
              m.date_precision, m.people, m.photo_url, m.created_at,
              a.duration_ms AS audio_duration_ms
         FROM memories m
         LEFT JOIN memory_audio a ON a.memory_id = m.id
        ${demo ? 'WHERE m.id NOT IN (900001, 900002, 900003)' : ''}
        ORDER BY m.happened_on ASC, m.created_at ASC, m.id ASC
        LIMIT 2000`
    );
    return res.json({ memories: result.rows, signedIn: !!req.user });
  } catch (err) {
    console.error('memories list failed:', err);
    return res.status(500).json({ error: 'load_failed' });
  }
});

// The server stays the authority on every rule the form also checks.
function validateMemory(input, now) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  const date = typeof input.happened_on === 'string' ? input.happened_on.trim() : '';
  // 'year' means the family knows the year but not the day; the stored day is
  // then 1 January of that year, and the timeline shows just the year.
  const precision = input.date_precision === 'year' ? 'year' : 'day';

  if (!title) return { error: 'title_required', message: 'Beri cerita ini judul.' };
  if (title.length > 120) return { error: 'title_too_long', message: 'Judul maksimal 120 karakter.' };
  // The story is optional: a title and a year are enough for a memory.
  if (body.length > 5000) return { error: 'story_too_long', message: 'Cerita maksimal 5.000 karakter.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'date_invalid', message: 'Isi tahun kejadiannya.' };
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day);
  const rebuilt = new Date(ms);
  if (rebuilt.getUTCFullYear() !== year || rebuilt.getUTCMonth() !== month - 1 || rebuilt.getUTCDate() !== day) {
    return { error: 'date_invalid', message: 'Tanggal itu tidak ada. Periksa kembali.' };
  }
  if (precision === 'year' && (month !== 1 || day !== 1)) {
    return { error: 'date_invalid', message: 'Kenangan yang hanya berisi tahun disimpan mulai 1 Januari. Periksa tahunnya.' };
  }
  if (ms < Date.UTC(1800, 0, 1)) {
    return { error: 'date_too_early', message: 'Tanggal tidak boleh sebelum 1 Januari 1800.' };
  }
  // One day of slack past the UTC date, so people ahead of UTC can still
  // enter their own today.
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (ms > todayUtc + 86400000) {
    return { error: 'date_in_future', message: 'Tanggal tidak boleh di masa depan.' };
  }
  const people = peopleOrError(input.people);
  if (people.error) return people;
  return {
    title,
    body,
    happened_on: date,
    date_precision: precision,
    people: people.people,
  };
}

// A recording, before it belongs to a memory: `usernode.uploadFile` takes
// images only, so the browser posts the audio here first and then names the
// returned id when it saves the memory.
app.post(
  '/api/memories/audio',
  express.raw({ type: () => true, limit: '4mb' }),
  async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'account_required', action: 'record a voice note' });
    }
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(contentType)) {
      return res.status(415).json({
        error: 'audio_type',
        message: 'Format rekaman itu tidak didukung. Coba lagi di browser lain.',
      });
    }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (bytes.length < 128) {
      return res.status(400).json({ error: 'audio_empty', message: 'Rekaman itu kosong. Coba lagi.' });
    }
    if (bytes.length > AUDIO_MAX_BYTES) {
      return res.status(413).json({ error: 'audio_too_large', message: 'Rekamannya terlalu panjang. Maksimal dua menit.' });
    }
    const asked = Number(req.query.duration_ms);
    const durationMs = Number.isFinite(asked) ? Math.max(0, Math.min(AUDIO_MAX_MS, Math.round(asked))) : 0;
    try {
      const id = crypto.randomBytes(16).toString('hex');
      await pool.query(
        `INSERT INTO memory_audio (id, user_id, content_type, duration_ms, bytes)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, String(req.user.id), contentType, durationMs, bytes]
      );
      return res.status(201).json({ id, duration_ms: durationMs });
    } catch (err) {
      console.error('audio save failed:', err);
      return res.status(500).json({ error: 'save_failed' });
    }
  }
);

// The recording itself. Guests may listen, like they may read the story, and
// it never changes once saved, so it can be cached for good.
app.get('/api/memories/:id/audio', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  try {
    const result = await pool.query(
      'SELECT content_type, bytes FROM memory_audio WHERE memory_id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.sendStatus(404);
    const buffer = Buffer.from(result.rows[0].bytes);
    res.set('Content-Type', result.rows[0].content_type);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Accept-Ranges', 'bytes');

    // A player seeks with a Range request; answer it so scrubbing works.
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (match) {
      let start = match[1] === '' ? null : Number(match[1]);
      let end = match[2] === '' ? null : Number(match[2]);
      if (start === null && end !== null) {
        start = Math.max(0, buffer.length - end);
        end = buffer.length - 1;
      } else if (start !== null && end === null) {
        end = buffer.length - 1;
      }
      if (start === null || start >= buffer.length || start > end) {
        res.set('Content-Range', `bytes */${buffer.length}`);
        return res.status(416).end();
      }
      end = Math.min(end, buffer.length - 1);
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
      res.set('Content-Length', String(end - start + 1));
      return res.end(buffer.subarray(start, end + 1));
    }

    res.set('Content-Length', String(buffer.length));
    return res.end(buffer);
  } catch (err) {
    console.error('audio fetch failed:', err);
    return res.status(500).json({ error: 'load_failed' });
  }
});

app.post('/api/memories', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'account_required', action: 'add a memory' });
  }
  const input = req.body && typeof req.body === 'object' ? req.body : {};
  const valid = validateMemory(input, req.now);
  if (valid.error) return res.status(400).json(valid);

  const photoUrl = photoUrlOrNull(input.photo_url);
  if (input.photo_url && !photoUrl) {
    return res.status(400).json({ error: 'photo_invalid', message: 'Foto itu tidak bisa dilampirkan. Coba pilih lagi.' });
  }
  const photoId = typeof input.photo_id === 'string' && input.photo_id.length <= 64 ? input.photo_id : null;
  const audioId = typeof input.audio_id === 'string' && /^[a-f0-9]{32}$/.test(input.audio_id)
    ? input.audio_id : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let audioDuration = null;
    if (audioId) {
      const held = await client.query(
        `SELECT duration_ms FROM memory_audio
          WHERE id = $1 AND user_id = $2 AND memory_id IS NULL FOR UPDATE`,
        [audioId, String(req.user.id)]
      );
      if (!held.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'audio_invalid',
          message: 'Rekaman suara tidak bisa dilampirkan. Coba rekam lagi.',
        });
      }
      audioDuration = held.rows[0].duration_ms;
    }

    const result = await client.query(
      `INSERT INTO memories
         (user_id, username, title, body, happened_on, date_precision, people, photo_url, photo_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, username, title, body, to_char(happened_on, 'YYYY-MM-DD') AS happened_on,
                 date_precision, people, photo_url, created_at`,
      [
        String(req.user.id),
        String(req.user.username || 'someone'),
        valid.title,
        valid.body,
        valid.happened_on,
        valid.date_precision,
        valid.people,
        photoUrl,
        photoUrl ? photoId : null,
        req.now,
      ]
    );

    const memory = result.rows[0];
    if (audioId) {
      await client.query('UPDATE memory_audio SET memory_id = $1 WHERE id = $2', [memory.id, audioId]);
      memory.audio_duration_ms = audioDuration;
    }
    await client.query('COMMIT');
    return res.status(201).json({ memory });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('memory save failed:', err);
    return res.status(500).json({ error: 'save_failed' });
  } finally {
    client.release();
  }
});

// A recording past the size limit, or a malformed JSON body, answers with a
// plain message the form can show instead of a stack trace.
app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'audio_too_large',
      message: 'Rekamannya terlalu panjang. Maksimal dua menit.',
    });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'body_invalid', message: 'Kiriman tidak sampai. Coba lagi.' });
  }
  console.error('request failed:', err);
  return res.status(500).json({ error: 'server_error' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/familystories-84cefe/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/familystories-84cefe/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The app now holds database connections: stop taking requests, let them
  // drain, close the pool, then exit.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close(async () => {
      try { await pool.end(); } catch {}
      process.exit(0);
    });
    setTimeout(async () => {
      try { await pool.end(); } catch {}
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
