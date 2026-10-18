# Cloudflare deployment

Production: https://paste.bea.sh

Account: `Bagheri.linuxmail@gmail.com's Account`

Worker: `bea-paste` (`https://bea-paste.bagheri.workers.dev`)

D1 database: `bea-paste` (`5f9c3b97-8860-46d1-941f-1be63b59b9f5`)

## Architecture

This is an additional serverless backend for the existing project. The original
Rust/RocksDB server and Docker builds remain available and share the same
`static/` frontend. Handlebars templates are precompiled at build time; the
Worker embeds the static assets, like the Rust binary does.

The UI uses the Behnam Bagheri Design System shared by bea.sh and Behnam's
other sites (blue accent, `data-product="blue"`). `static/ds/` is a vendored copy
of `ds/v1/` from the bea.sh repository, including its fonts, so the Iran mirror
works when bea.sh is unreachable; `scripts/sync-ds.sh` refreshes it and records
the source commit in `static/ds/VERSION`. Never edit those files: page rules go in
`static/style.css` (plain CSS with `--bb-` tokens, no build step), and missing
components go upstream to bea.sh. Pages load `tokens.css`, `base.css`,
`components.css`, then the site stylesheet, each with a content-hashed `?v=`.
The theme follows the OS until the visitor picks one with the toggle, which is
stored under `bb-theme` like on bea.sh.
There are no CDN dependencies: no Bootstrap, jQuery, or Font Awesome.

D1 holds paste metadata and base64 content chunks. Chunking preserves the
original 8 MiB body limit within D1's 2 MB row limit. Creation uses one transaction.
Reading a burn paste and removing its metadata/content use one transaction, so
only one concurrent reader can receive the content. `HEAD` does not burn a paste.
Expiry is checked during reads, and a cron job removes up to 1,000 expired pastes
every 15 minutes. Foreign keys cascade deletion to the content chunks.

The API supports `POST /`, `GET /:id`, `GET /raw/:id`, `GET /download/:id`,
`GET /new?id=:id`, `GET /static/:resource`, and `DELETE /:id`, plus agent
discovery (`/llms.txt`, `/openapi.json`, `/.well-known/api-catalog`, `/robots.txt`)
and an MCP server at `POST /mcp` (`agents.mjs`). Paste responses
disable caching. Client-side AES-GCM encryption, password prompts, highlighting,
clone/delete actions, and the system/light/dark theme switch run in vanilla JavaScript.

The Rust implementation's default TTL is zero (Never). paste.bea.sh sets
`DEFAULT_TTL` to 2592000 (30 days), so pastes created without `ttl` (from the
editor or the command line) expire after 30 days; `ttl=0` keeps one forever.
Query parameters accept `ttl` seconds and `burn`/`encrypted` booleans;
`0` and `1` are accepted for compatibility with the existing UI. Invalid parameter
values return 422. Bodies larger than 8 MiB return 413 instead of being truncated.
`ENABLE_MERMAID` and `UI_LINE_NUMBERS` can be enabled in the Wrangler vars.

## Admin area

`https://paste.bea.sh/admin` is a private dashboard, signed in through
Cloudflare Access like `ip.bea.sh/admin`. It has three tabs:

- **Pastes**: active pastes, newest first, with size, language, burn and
  encryption flags, expiry, creator IP and country, and whether they came from
  the web editor, the command line, or an AI agent over MCP. Search by ID prefix or exact IP, preview
  a paste (previews never consume burn-after-reading pastes), delete one paste,
  or delete every paste from an IP.
- **Statistics**: active pastes, storage used, distinct creator IPs, all-time
  creations, pastes per day (7, 30, or 90 days), top languages, and web versus
  command-line share. Daily counters live in `paste_stats` and survive expiry.
- **Settings**: default expiry, maximum expiry, maximum paste size (up to the
  8 MiB hard limit), maintenance mode (new pastes return 503 with a message;
  existing pastes stay readable), and an announcement banner. Settings are
  stored in D1 (`settings`), override `DEFAULT_TTL`, and apply within about
  10 seconds without a deploy.

The creating IP (`CF-Connecting-IP`), country, size, and client type are
stored with each paste and deleted with it. Pastes created before
`0002_admin.sql` have no creator data.

Every `/admin` path verifies the `Cf-Access-Jwt-Assertion` JWT (issuer,
audience, expiry, RS256 signature) and an administrator email allowlist
before reading storage, so a missing Access app or configuration fails closed
with 403. Writes must also come from the same origin. Responses are
`private, no-store`, `noindex`, and cannot be framed. Configuration, kept out
of the repository as Worker secrets:

```sh
npx wrangler secret put PASTE_ACCESS_ISSUER   # https://TEAM.cloudflareaccess.com
npx wrangler secret put PASTE_ACCESS_AUD      # the Access application's AUD tag
npx wrangler secret put PASTE_ADMIN_EMAILS    # comma-separated administrator emails
```

Deployments without Cloudflare Access can set `PASTE_ADMIN_TOKEN` (at least 32
characters) to sign in at `/admin/login` with a token instead; see the main
README. On paste.bea.sh it is not set, so only Access applies.

The Access application covers `paste.bea.sh/admin` and everything below it,
with an Allow policy for the administrator emails only. The admin area runs in
the Worker and in the container image (`server/index.mjs`, which serves this
same Worker with SQLite through `server/sqlite-d1.mjs`); the Rust server has no
admin routes.

## Build, test, and deploy

From this directory, with Node.js 22 or newer:

```sh
npm ci
npm test
```

Provide `CLOUDFLARE_API_TOKEN` in the environment using a token scoped to this
account with Workers Scripts Edit, D1 Edit, and the permissions needed for Worker
custom domains (Workers Routes and DNS Edit on `bea.sh`). Do not commit credentials.

```sh
npx wrangler d1 migrations apply bea-paste --remote   # before deploying new code
npx wrangler deploy
npm run smoke -- https://paste.bea.sh
```

`wrangler.jsonc` records the account, D1 binding, compatibility date, custom domain,
cron schedule, and vars. `npm run build` regenerates `dist/worker.mjs` from the
current frontend and Worker source. The lockfile pins build/test dependencies.

## Deployment evidence — October 14, 2026

The app was deployed with a fresh D1 database as requested; old RocksDB pastes
were not migrated. The old server was not modified. `paste.bea.sh` now uses a
Cloudflare-managed Worker custom-domain DNS record instead of its server CNAME.

Seven local integration tests passed, including the scheduled cleanup handler.
Live smoke tests passed on both
the Workers URL and production hostname: create/view/raw/clone/delete, concurrent
burn reads, expiry, an exact 8 MiB binary download, and encryption using the
existing frontend helpers. Verification fixtures were removed. The production
UI was inspected in the in-app browser with its existing controls and styling.

Cloudflare's MCP upload helper reported a version-readback mismatch after a
successful upload. The deployed script was then downloaded and compared byte
for byte with the local artifact. Its active version, etag, handlers, and D1
binding were independently read back before live verification continued.
`deployment.json` records the current deployment (version, artifact hash, migrations, admin Access app) and, under `initial_deployment`, the first deployment and the prior DNS.

## Rollback

Detach `paste.bea.sh` from Worker `bea-paste` in Cloudflare's Domains & Routes.
Then restore the previous proxied CNAME `paste.bea.sh -> vps1.bea.sh` with automatic
TTL, as saved in `deployment.json` under `initial_deployment.previous_dns`. This sends traffic to the previous server;
its current health must be checked before rollback. Keep D1 intact so new pastes
remain recoverable. They are not automatically imported into the Rust database.
