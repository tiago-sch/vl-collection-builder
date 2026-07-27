# Vault Lookup

Paste a list of game names, pick a platform, get back the Vimm's Lair Vault page URL for each
one. Ambiguous matches are confirmed by you in a keyboard-driven review queue; confirmed results
are saved to a local SQLite database and exportable as JSON or CSV.

Self-hosted, single container, single port, no external services. An LLM is optional and off by
default.

> **Status:** phases 1–7 of [the plan](vault-lookup-plan.md) are built — the full lookup tool.
> Downloading (phase 9) and library organizing (phase 10) are **not** built. If you want a
> downloader today, use [gamarr](https://github.com/JeremiahM37/gamarr) or
> [vl-downloader](https://github.com/Raiper34/vl-downloader).

## What it is not

It is not a downloader. It catalogues public page URLs and stops there.

## Quick start

```bash
docker compose up -d
```

Then open <http://127.0.0.1:8080> and follow the first-run wizard. It will ask you to pick a
platform, sync its catalogue (a few minutes), and choose your region preference.

For local development:

```bash
npm install && npm run build && npm start
```

## How matching works

The whole platform catalogue is mirrored locally once, then your list is matched against the
local copy. For a 200-game list that is ~75 requests instead of 200+, and it means full fuzzy
scoring across every title rather than whatever the site's search happens to return.

Each name runs down a cascade, and each tier only sees what the tier above could not settle:

| Tier | Method | Cost |
|---|---|---|
| 0 | Learned or static alias | free, instant |
| 1 | Exact match after normalisation | free, instant |
| 2 | Fuzzy score above the threshold **with a margin** | free, instant |
| 3 | Optional LLM | not built yet (phase 8) |
| 4 | You | your attention |

**The margin rule is what makes this safe.** Two regional variants of the same game both score
~0.99, so the gap between them is ~0, so tier 2 refuses to auto-accept and passes the item down.
Over-eager matching is the expensive failure: a wrong row in your library looks exactly like a
right one.

**Every confirmation is remembered.** Confirming `dragon quest viii` in the review queue writes a
learned alias, so the same input resolves instantly and for free next time. The tool needs your
attention less the more you use it.

### Region is a policy, not a guess

Region preference is an ordered list you set explicitly. It is applied deterministically after
title scoring, never delegated to fuzzy matching:

- The region bonus is **always smaller than the tier-2 margin**, so region preference breaks ties
  between equally good title matches but can never promote a worse one. The UI clamps this for
  you — that is why a large "region bonus" in Settings shows a ceiling.
- When candidates differ *only* by region and your preferred region is present, it is taken
  automatically. This is the single biggest reduction in review volume.
- When your preferred region is **absent**, the item goes to review rather than quietly handing
  you a Japanese release.
- `Strict` excludes non-preferred regions from candidates entirely.

Settable globally, per import, and per item.

**The first-run wizard will not let you skip this**, and there is no silent default. Defaulting to
USA and quietly mismatching a Japan-focused collection is the kind of failure you would not notice
for fifty games.

## Configuration

Every variable, with its default. `.env.example` is an executable mirror of this table.

### Paths

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_PATH` | `./data/vault.db` | **Keep this on local disk.** SQLite's locking is unreliable over NFS/CIFS and the documented failure mode is silent corruption, not a clean error. Use a named Docker volume, never a NAS path. |
| `WEB_ROOT` | *(empty)* | Built React client. Empty in dev, where Vite serves the client and proxies `/api`. |

### Server

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `127.0.0.1` | Loopback so a stray `docker run` doesn't publish to your LAN. The Dockerfile sets `0.0.0.0` because published ports need it; the compose file binds to `127.0.0.1` on the host side instead. Put it behind a reverse proxy for remote access. |
| `LOG_LEVEL` | `info` | |

### Crawler

| Variable | Default | Notes |
|---|---|---|
| `CRAWL_DELAY_MS` | `1200` | One request per this many ms, single concurrency. A full PS2 sync is ~75 requests, so about 7 minutes once a month. |
| `USER_AGENT` | `vault-lookup/0.1 (personal catalogue tool)` | Honest and self-identifying. A browser UA is a last resort, not a default. |
| `REQUEST_TIMEOUT_MS` | `30000` | |
| `CRAWL_MAX_RETRIES` | `3` | |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | Consecutive failures before the source is skipped entirely. |
| `CIRCUIT_RESET_MS` | `300000` | How long until it retries. |

### Source registry

| Variable | Default | Notes |
|---|---|---|
| `SOURCES_PATH` | *(empty)* | Override the embedded platform registry from a file. |
| `SOURCES_URL` | *(empty)* | Or from a URL. |

Resolution order is `SOURCES_PATH` → `SOURCES_URL` → embedded defaults. A bad override warns and
falls back rather than blocking boot, so a typo in a mounted file cannot take the container down.

### Setup

| Variable | Default | Notes |
|---|---|---|
| `REGION_PREFERENCE` | *(empty)* | e.g. `USA,Europe,Japan`. Pre-fills the wizard. Empty means the wizard asks and will not proceed until you choose. |
| `SETUP_SKIP` | `false` | `true` **and** a non-empty `REGION_PREFERENCE` completes setup unattended. On its own it does nothing, because guessing the region is the failure being prevented. |

### Resolver (phase 8, not built)

| Variable | Default | Notes |
|---|---|---|
| `RESOLVER` | *(empty)* | `gemini` \| `openai` \| `ollama` |
| `GEMINI_API_KEY` | *(empty)* | Absent means tier 3 is skipped entirely and more items reach review. Nothing else changes. |
| `RESOLVER_MODEL` | *(empty)* | |
| `RESOLVER_MAX_ITEMS` | `50` | Hard cap per import, as a cost guard. |

## Notes on the source site

Three things about Vimm's Lair shaped this implementation. They are documented because they are
invisible until they bite, and two of them fail *silently*.

**1. The listing view is filtered by default.** Four regions checked, newest version only, first
disc only, no prototypes/demos/unlicensed/bonus discs. A crawler that accepts those defaults
mirrors 1,831 PS2 games instead of 11,420 — and 1,826 of them are USA, which would quietly make
region preference meaningless for anyone with a non-US collection. The filter form is `method=GET`,
so the fix is a parameter set; it lives in `listFilters` in the source registry.

**2. Listings are paginated at 200 rows per page.** Stopping at the first page of each letter
looks like a successful sync and gives you part of the catalogue.

**3. Every listing row carries a hidden honeypot link.** Each row is preceded by
`<a href="/vault/999999" style="display:none">9</a>`. A naive `/vault/(\d+)` scan collects it
first, yielding one bogus entry per row all colliding on the same fake ID. Both parser strategies
strip `display:none` anchors and reject that ID.

`robots.txt` permits crawling. We identify ourselves honestly, crawl serially with a delay, and
open a circuit breaker rather than hammering a failing server.

## Development

```bash
npm install
npm test              # 64 tests
npm run typecheck
npm run dev           # server on :8080
npm run dev:web       # client on :5173, proxies /api
```

Everything this project assumes about the site's HTML lives in
[`catalog/parser.ts`](packages/server/src/catalog/parser.ts), tested against saved fixtures in
`packages/server/test/fixtures/`. When the markup changes, that file and its fixtures are the only
things that need updating.

The parser runs two strategies and keeps whichever recovered more games: a cheerio table parse
(which gets the region/version/language/rating columns the review UI needs) and a raw-anchor regex
fallback (which survives layout churn but loses the columns, and says so). Comparing them catches
*partial* breakage — strip the `<tr>` elements and the HTML parser coalesces every cell into one
implied row, so a naive "did it return anything?" check would happily sync one game per page.

## Credits

Built on prior work — see [§14 of the plan](vault-lookup-plan.md) for the full accounting.

- **[gamarr](https://github.com/JeremiahM37/gamarr)** (JeremiahM37) — the platform slug → system
  map for 18 consoles, the runtime-loadable source registry with embedded fallback, and the
  circuit-breaker health model. Its disabled TLS verification is deliberately *not* copied.
- **[vl-downloader](https://github.com/Raiper34/vl-downloader)** (Raiper34, MIT) — the download
  queue and progress model that phase 9 will build on. Its author asks that the tool not be
  modified for bulk or simultaneous downloading; when downloads are built here they will be
  serial by construction, with no concurrency setting.
- **[Vimm's Lair](https://vimm.net/)** — the data source.

## Licence

MIT — see [LICENSE](LICENSE).

Whether you have the right to any given ROM is yours to determine.
