const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

// ── Platform account-data routes ─────────────────────────────────────────
// The platform calls these server-to-server when someone asks for a copy of
// their data or deletes their Homeroom account. They present a platform token
// in `x-usernode-platform-token`, never a user sign-in token, so they are
// mounted BEFORE the auth middleware below. The person is read only from the
// verified token: there is no body and no username lookup.
function platformClaims(req, purpose) {
  const token = req.headers['x-usernode-platform-token'];
  if (!token || !JWT_PUBLIC_KEY || !APP_AUDIENCE) return null;
  try {
    const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
      algorithms: ['RS256'],
      issuer: 'usernode',
      audience: APP_AUDIENCE,
    });
    return claims && claims.pur === purpose ? claims : null;
  } catch {
    return null;
  }
}

// Deleting the account deletes the memories it added. Idempotent: a retry
// finds nothing and still answers 204.
app.post('/usernode/user-deletion', async (req, res) => {
  const claims = platformClaims(req, 'user-deletion');
  if (!claims) return res.status(403).json({ error: 'forbidden' });
  try {
    await pool.query('DELETE FROM memories WHERE user_id = $1', [String(claims.id)]);
    res.status(204).end();
  } catch (err) {
    console.error('user-deletion failed:', err);
    res.status(500).json({ error: 'delete_failed' });
  }
});

// A copy of the person's own memories, for Homeroom's data export.
app.get('/usernode/user-export', async (req, res) => {
  const claims = platformClaims(req, 'user-export');
  if (!claims) return res.status(403).json({ error: 'forbidden' });
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, username, title, body,
              to_char(happened_on, 'YYYY-MM-DD') AS happened_on, created_at
         FROM memories WHERE user_id = $1 ORDER BY happened_on ASC, created_at ASC, id ASC`,
      [String(claims.id)]
    );
    res.json({ userId: String(claims.id), tables: { memories: rows } });
  } catch (err) {
    console.error('user-export failed:', err);
    res.status(500).json({ error: 'export_failed' });
  }
});

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

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
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

let shuttingDown = false;
app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Memories ──────────────────────────────────────────────────────────────
// One shared timeline for the whole family. The day is selected as text so
// `pg` never turns it into a JS Date and shifts it by the server's time zone.
const MEMORY_COLUMNS = `id, username, title, body,
  to_char(happened_on, 'YYYY-MM-DD') AS happened_on, created_at`;

app.get('/api/memories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${MEMORY_COLUMNS}
         FROM memories
        ORDER BY happened_on ASC, created_at ASC, id ASC
        LIMIT 2000`
    );
    // A guest may read the timeline. `signedIn` tells the page whether
    // tapping "Add a memory" should ask for an account instead.
    res.json({ memories: rows, signedIn: !!req.user });
  } catch (err) {
    console.error('GET /api/memories failed:', err);
    res.status(500).json({ error: 'load_failed' });
  }
});

// A real calendar day, or null. Rebuilding with Date.UTC and comparing the
// parts rejects 2023-02-30 and 2024-13-01 rather than rolling them over.
function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parts = value.split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (
    date.getUTCFullYear() !== parts[0] ||
    date.getUTCMonth() !== parts[1] - 1 ||
    date.getUTCDate() !== parts[2]
  ) {
    return null;
  }
  return date;
}

const MIN_DAY = Date.UTC(1800, 0, 1);

app.post('/api/memories', async (req, res) => {
  // The edge already refuses a guest's write, but a guest that reaches this
  // route in another deployment still gets the bridge's account sheet.
  if (!req.user) {
    return res.status(401).json({ error: 'account_required', action: 'add a memory' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const story = typeof body.body === 'string' ? body.body.trim() : '';
  const happenedOn = body.happened_on;

  if (!title) return res.status(400).json({ error: 'title_required', message: 'Add what happened.' });
  if (title.length > 120) {
    return res.status(400).json({ error: 'title_too_long', message: 'What happened can be up to 120 characters.' });
  }
  if (!story) return res.status(400).json({ error: 'story_required', message: 'Add the story.' });
  if (story.length > 5000) {
    return res.status(400).json({ error: 'story_too_long', message: 'The story can be up to 5,000 characters.' });
  }

  const day = parseDay(happenedOn);
  if (!day) {
    return res.status(400).json({ error: 'date_invalid', message: 'Enter a real calendar date.' });
  }
  if (day.getTime() < MIN_DAY) {
    return res.status(400).json({ error: 'date_too_early', message: "The date can't be before 1 January 1800." });
  }
  // Tomorrow in UTC is allowed, so someone in a time zone ahead of UTC can
  // still enter their own today.
  const now = req.now;
  const latest = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  if (day.getTime() > latest) {
    return res.status(400).json({ error: 'date_in_future', message: "The date can't be in the future." });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO memories (user_id, username, title, body, happened_on, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${MEMORY_COLUMNS}`,
      [String(req.user.id), req.user.username || 'A relative', title, story, happenedOn, req.now]
    );
    res.status(201).json({ memory: rows[0] });
  } catch (err) {
    console.error('POST /api/memories failed:', err);
    res.status(500).json({ error: 'save_failed' });
  }
});

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

// Create what the app needs, idempotently. A failed migration rejects, so
// start() logs and exits; the platform restarts the container.
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
    )`);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS memories_happened_on_idx ON memories (happened_on, created_at, id)'
  );
  await pool.query("COMMENT ON TABLE memories IS 'staging:private'");

  // Staging gets a few obviously invented memories so the filled timeline can
  // be seen. Fixed ids far above the sequence, and never the visitor's.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO memories (id, user_id, username, title, body, happened_on, created_at)
      VALUES
        (900001, 'staging-demo-1', 'staging-demo-user',
         'Staging demo: Grandma opens her bakery',
         'A made-up memory for the staging preview. The shop had one oven and a bell over the door that rang every time somebody came in.',
         '1962-04-14', '2026-01-01T09:00:00Z'),
        (900002, 'staging-demo-2', 'staging-demo-cousin',
         'Staging demo: The family moves to the coast',
         'A made-up memory for the staging preview. Everything fit in one van, and the cat rode the whole way on the front seat.',
         '1978-08-02', '2026-01-01T09:05:00Z'),
        (900003, 'staging-demo-3', 'staging-demo-aunt',
         'Staging demo: First reunion in the park',
         'A made-up memory for the staging preview. Forty people, three picnic tables pushed together and a cake shaped like the old house.',
         '1995-07-22', '2026-01-01T09:10:00Z')
      ON CONFLICT (id) DO NOTHING`);
  }
}

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The app now holds database connections, so a shutdown drains them.
  const SHUTDOWN_GRACE_MS = 3000;
  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    shuttingDown = true;
    server.close();
    setTimeout(async () => {
      try {
        await pool.end();
      } catch {}
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
