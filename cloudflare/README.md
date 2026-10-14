# Cloudflare deployment

Production: https://paste.bea.sh

Account: `Bagheri.linuxmail@gmail.com's Account`

Worker: `bea-paste` (`https://bea-paste.bagheri.workers.dev`)

D1 database: `bea-paste` (`5f9c3b97-8860-46d1-941f-1be63b59b9f5`)

## Architecture

This is an additional serverless backend for the existing project. The original
Rust/RocksDB server and Docker builds remain available. The Worker uses the
existing `static/index.html`, CSS, JavaScript, favicon, and Prism assets without
changing their source files. Handlebars templates are precompiled at build time;
the Worker embeds the static assets, like the Rust binary does.

D1 holds paste metadata and base64 content chunks. Chunking preserves the
original 8 MiB body limit within D1's 2 MB row limit. Creation uses one transaction.
Reading a burn paste and removing its metadata/content use one transaction, so
only one concurrent reader can receive the content. `HEAD` does not burn a paste.
Expiry is checked during reads, and a cron job removes up to 1,000 expired pastes
every 15 minutes. Foreign keys cascade deletion to the content chunks.

The API supports `POST /`, `GET /:id`, `GET /raw/:id`, `GET /download/:id`,
`GET /new?id=:id`, `GET /static/:resource`, and `DELETE /:id`. Paste responses
disable caching. Client-side AES-GCM encryption, password prompts, highlighting,
clone/delete actions, and dark mode use the existing frontend code.

The Rust implementation's default TTL is zero (Never), which is also the Worker
default. Query parameters accept `ttl` seconds and `burn`/`encrypted` booleans;
`0` and `1` are accepted for compatibility with the existing UI. Invalid parameter
values return 422. Bodies larger than 8 MiB return 413 instead of being truncated.
`ENABLE_MERMAID` and `UI_LINE_NUMBERS` can be enabled in the Wrangler vars.

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
npx wrangler d1 migrations apply bea-paste --remote
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
`deployment.json` records the deployment identity, artifact hash, and prior DNS.

## Rollback

Detach `paste.bea.sh` from Worker `bea-paste` in Cloudflare's Domains & Routes.
Then restore the previous proxied CNAME `paste.bea.sh -> vps1.bea.sh` with automatic
TTL, as saved in `deployment.json`. This sends traffic to the previous server;
its current health must be checked before rollback. Keep D1 intact so new pastes
remain recoverable. They are not automatically imported into the Rust database.
