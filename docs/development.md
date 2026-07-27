# Development

## Setup

```bash
npm install
npm run build
npm test
```

Node 22.5+ is required for the built-in `node:sqlite`. Development is done on
Node 26; the Docker image uses Node 24.

## Running locally

Two processes in development — Vite serves the client and proxies `/api` to
Fastify:

```bash
npm run dev
```

```bash
npm run dev:web
```

Then open <http://localhost:5173>. In production both come from the same origin,
served by the same Fastify instance, so there is no proxy involved.

To run the production layout locally:

```bash
npm run build && WEB_ROOT=$(pwd)/packages/web/dist npm start
```

## Layout

```
packages/
  shared/   types crossing the /api boundary — imports from neither side
  server/   Fastify, SQLite, crawler, matching, downloads, organizer
  web/      React client
```

Two files concentrate everything this project assumes about the source site:

- **`server/src/catalog/parser.ts`** — listing markup
- **`server/src/download/vimm.ts`** — the download flow

When the site changes, those two files and their fixtures are what need updating.
Both have extensive header comments explaining the non-obvious behaviour they
work around; read those before changing them.

## Tests

```bash
npm test
npm run test:watch
npm run typecheck
```

130 tests, no network access required. Fixtures in
`packages/server/test/fixtures/` are real saved pages from the source site.

Two tests shell out to `zip`, which is present on macOS and most Linux
distributions but **not** in the slim Docker image. Tests are meant to be run on
a development machine, not inside the container.

### Refreshing fixtures

If the site's markup changes, re-capture with a polite single request:

```bash
curl -sS --compressed -A "vl-collection-builder/0.1 (personal catalogue tool)" \
  -o packages/server/test/fixtures/ps2-list-S.html \
  "https://vimm.net/vault/?p=list&system=PS2&section=S"
```

Then run the tests and fix what breaks. The fixtures are the specification.

## Evaluating match quality

```bash
npm run eval
```

Replays every confirmed match from `learned_alias` through the matcher **with
that item's own alias removed**, so it measures how matching behaved the first
time rather than reading back the answer key. Reports resolution rate, wrong-match
rate and a tier breakdown.

The evaluation set is built from your own review confirmations, so it fills up as
you use the tool. This is what makes "is the optional AI resolver worth a key?" an
answerable question rather than a matter of taste.

## Adding a platform

Platforms live in `packages/server/src/sources/defaults.json`. Add an entry with
`slug`, `system` (the value Vimm expects in its `system` query parameter), `label`
and `discBased`, then restart.

You do not need to rebuild to change this in production: point `SOURCES_PATH` at
a mounted file, or `SOURCES_URL` at a URL. A malformed override warns and falls
back to the embedded copy rather than blocking boot.

## Database

Migrations are plain SQL in `packages/server/src/db/migrations/`, applied in
filename order at boot and recorded in `schema_migration`. They are forward-only;
each runs in a transaction, so a failure leaves no half-applied schema.

To add one, create the next numbered file. Do not edit an applied migration —
existing databases will not re-run it.

## Things worth knowing before you change them

These are all documented in the source, but they are the ones that cost time to
rediscover:

- **Listing pages are filtered by default.** Without the `listFilters` parameter
  set, a PS2 sync returns 1,831 rows instead of 11,420, and nearly all of them
  are USA.
- **Listings paginate at 200 rows.** Ignoring `hasNextPage` gives you a partial
  catalogue that looks complete.
- **Every listing row carries a hidden honeypot link** to `/vault/999999`. A
  naive anchor scan collects it first.
- **The download form says POST but is submitted as GET.**
- **Range requests starting at offset 0 return the wrong bytes** — the tail of
  the file, not the head. Never send a Range header at offset 0.
- **`chdman` exits non-zero even when it works**, including for `--version`.
  Detect it by its output, not its exit status.
- **Multi-track is not multi-disc.** Naming every file in a CD rip after the game
  collapses the tracks onto one filename.

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. **test** — `npm ci`, build, typecheck, and the full test suite on Node 24.
2. **image** — builds `linux/amd64` and `linux/arm64` and pushes to GHCR. Pull
   requests build but do not push.

The image job finishes with a smoke test: it runs the built image, waits for
`/api/health`, and asserts that `chdman` is present and that unattended setup
applied. Both are things that fail *silently* rather than loudly — a missing
chdman just skips CHD conversion with a per-item warning.

### Why the build stage pins `--platform=$BUILDPLATFORM`

The build runs natively on the runner's architecture instead of under QEMU. That
is only safe because there are no native addons — `node:sqlite` is built in, and
every runtime dependency is pure JavaScript, so the compiled output and the
pruned `node_modules` are architecture-independent. If a native dependency is
ever added, this must change or arm64 images will ship amd64 binaries.

### `.dockerignore` gotcha

`.dockerignore` does **not** match basenames at any depth the way `.gitignore`
does: a bare `*.tsbuildinfo` matches only the context root. Every pattern needs
its `**/` twin.

This one is not loud. A stale `packages/*/tsconfig.tsbuildinfo` copied in from a
developer's machine makes `tsc -b` believe the build is already up to date, so it
emits nothing and the image ships without `dist`.

## Container user

The image runs as uid/gid 1000 (`node`). There is no `PUID`/`PGID` entrypoint —
that convention needs a root entrypoint that drops privileges, and advertising
the variables without implementing them would fail silently on the first write.
Use Docker's `user:` directive to run as a different uid.

## Not built

Phase 8 of the plan — the optional LLM resolver — is not implemented. Tier 3 is
skipped, which is the same path taken when no API key is configured, so nothing
is stubbed or faked. `eval.ts` is ready to measure it when it lands.
