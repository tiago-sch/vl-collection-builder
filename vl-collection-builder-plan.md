# VL Collection Builder — Project Plan

A self-hosted web app: paste a list of game names, pick a platform, and it resolves each title to its Vimm's Lair Vault page URL. Ambiguous matches are confirmed by you in the UI. Confirmed results are stored in a local SQLite database.

**Stack:** Node.js + TypeScript · Fastify · `node:sqlite` · React + Vite · Docker (single image, single port) · optional Gemini resolver
**Scope of this document:** plan only — no code written yet.
**Built on:** [gamarr](https://github.com/JeremiahM37/gamarr) (indexer, platform registry, health model) and [vl-downloader](https://github.com/Raiper34/vl-downloader) (download queue) — full credits in §14.

---

## 1. Findings from Vimm's Lair (verified)

These shaped the design, so they're worth stating up front.

| Fact | Detail |
|---|---|
| `robots.txt` | `User-agent: * / Disallow:` — crawling is permitted site-wide. Politeness is still on us. |
| Platform vault index | `https://vimm.net/vault/PS2` — landing page with A–Z + `#` navigation |
| Alphabetical listing | `https://vimm.net/vault/?p=list&system=PS2&section=S` — HTML table, ~150–400 rows/letter |
| Search | `https://vimm.net/vault/?p=list&system=PS2&q=silent+hill` — same table shape |
| Listing columns | Title · Region (flag icon) · Version · Languages · Rating |
| Game page URL | `https://vimm.net/vault/{numericId}` — **no platform segment, no slug** |
| Manual URL | `https://vimm.net/manual/{numericId}` (same id) |
| Catalogue size | PS2 alone: ~11,800 entries |

**The single most important consequence:** since the listing pages expose everything in ~27 requests per platform, we should **mirror the whole platform catalogue locally once**, then match against the local copy. This is the core architectural decision.

### 1.1 What gamarr's Vimm indexer taught us

gamarr (Go, self-hosted "arr for games") has a working Vimm source driver in `internal/search/vimm.go` plus a sources registry in `internal/sources/`. Reading it validated the URL shapes above and produced four concrete changes:

**Confirmed — no change needed**

- Base URL `https://vimm.net/vault/` with `p=list`, `q=`, `system=` is exactly the interface we planned against.
- One code path serves *all* platforms; only the `system` value changes.

**Changed decision #1 — externalize the platform registry.**
gamarr keeps its source config in an embedded JSON file, loadable at runtime from a file path or URL, falling back to the embedded defaults if either fails. That's better than my hardcoded `platforms.ts`: when Vimm renames a system or adds a console, it's a config edit and a restart, not a rebuild. Adopt it, including the "never fail to boot over a bad registry" fallback chain. Their verified slug → `system` map, which we can start from:

```
nes→NES  snes→SNES  n64→N64  ngc→GameCube  wii→Wii
gb→GB  gbc→GBC  gba→GBA  nds→DS
genesis→Genesis  saturn→Saturn  dc→Dreamcast
psx→PS1  ps2→PS2  ps3→PS3  psp→PSP
xbox→Xbox  xbox360→Xbox360
```

This resolves open question #1 — 18 platforms, already verified in production by someone else.

**Changed decision #2 — parse with a regex *fallback*, not as the primary.**
gamarr extracts results with a single regex over the raw HTML matching `/vault/{id}` anchors and their text. It's admirably resilient — no DOM assumptions, survives most layout churn — but it discards region, version, languages and rating, which are precisely the columns our review UI needs to tell four editions of Resident Evil 4 apart. So: **cheerio table parse as primary** (gets the columns), **anchor-regex as fallback** (if the table selector yields zero rows, still return titles + ids, flag the entry as `columns_missing`, and warn in the UI). Best of both.

**Changed decision #3 — adopt circuit-breaker health tracking.**
gamarr tracks a 0–100 health score per source, opening a circuit after a streak of consecutive failures and skipping the source until a retry window elapses. That's more useful than the plain exponential backoff I proposed, and it gives Settings something real to display. Adopt for the crawler, sized for our much lower request volume.

**Also noted**

- gamarr caps search results at 20 rows — a strong hint that Vimm's search response is itself truncated. Our A–Z mirror sidesteps this entirely, which is good independent validation of §1's core decision.
- In unfiltered (no `system`) searches, Vimm appends the platform in parentheses to result titles, e.g. `Okami (PS2)`. Our normalizer must strip a trailing `(SYSTEM)` token, or every unfiltered match scores badly.
- gamarr sends a browser-like Chrome User-Agent. We'll start with an honest self-identifying UA; keep the browser UA documented as a fallback only if the honest one gets blocked.
- gamarr disables TLS certificate verification on its Vimm client. **Do not copy this.** If we hit a certificate problem, diagnose it rather than switching off verification.
- gamarr implements the actual file download (parsing the download form, `mediaId`, and the `download{N}.vimm.net` endpoints). Explicitly **out of scope** for us — we catalogue page URLs and stop there. If you ever want downloads, gamarr already does that job and is the better tool to reach for.

### Why local mirror instead of live search per game

| | Live search per game | Local mirror (chosen) |
|---|---|---|
| Requests for a 200-game list | 200+ | ~27 (once), then 0 |
| Matching quality | Limited to whatever the site's search returns | Full fuzzy scoring across all ~11.8k titles |
| Offline / re-runs | Impossible | Instant |
| Region duplicates | Hard to see | All variants visible side by side for confirmation |
| Cost | Hammering someone else's server | One polite crawl, refreshed monthly |

Refresh policy: on demand, plus a staleness warning in the UI after 30 days.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────┐
│ Docker container  (node:22-bookworm-slim, :8080)│
│                                                 │
│  Fastify server                                 │
│   ├── /api/*        JSON API                    │
│   ├── /*            static React SPA (built)    │
│   │                                             │
│   ├── catalog/      crawler + HTML parser       │
│   ├── matching/     normalize + score           │
│   └── db/           better-sqlite3 + migrations │
│                                                 │
└──────────────────┬──────────────────────────────┘
                   │ volume mount
              /data/vault.db
```

Single process, single port, no external services. The React app is built at image-build time and served as static files by the same Fastify instance — so there is one container and one URL.

### Repository layout

```
vl-collection-builder/
├── docker-compose.yml
├── Dockerfile
├── package.json                  # npm workspaces
├── .env.example
├── packages/
│   ├── shared/                   # types shared by server + web
│   │   └── src/types.ts          # Platform, CatalogEntry, JobItem, Candidate…
│   ├── server/
│   │   ├── src/
│   │   │   ├── index.ts          # Fastify bootstrap
│   │   │   ├── config.ts
│   │   │   ├── db/
│   │   │   │   ├── client.ts
│   │   │   │   └── migrations/001_init.sql …
│   │   │   ├── sources/
│   │   │   │   ├── defaults.json # base URL + slug→system map (embedded)
│   │   │   │   └── load.ts       # file path → URL → embedded fallback chain
│   │   │   ├── catalog/
│   │   │   │   ├── fetcher.ts    # throttled HTTP + retry + circuit breaker
│   │   │   │   ├── health.ts     # per-source score, failure streak, circuit
│   │   │   │   ├── parser.ts     # cheerio table → CatalogEntry[]; regex fallback
│   │   │   │   └── sync.ts       # crawl A–Z, upsert, mark stale
│   │   │   ├── matching/
│   │   │   │   ├── normalize.ts
│   │   │   │   ├── score.ts
│   │   │   │   ├── region.ts     # preference list → bonus + strict filter
│   │   │   │   ├── aliases.ts    # static + learned alias lookup
│   │   │   │   └── resolve.ts    # tier cascade + status decision
│   │   │   ├── resolver/         # optional LLM tier — absent key = no-op
│   │   │   │   ├── types.ts      # Resolver interface
│   │   │   │   ├── gemini.ts
│   │   │   │   ├── ollama.ts
│   │   │   │   └── cache.ts
│   │   │   ├── jobs/service.ts
│   │   │   ├── download/
│   │   │   │   ├── vimm.ts       # vault page → form action + mediaId + Referer
│   │   │   │   ├── worker.ts     # serial claim → stream → verify → rename
│   │   │   │   └── queue.ts      # SQLite-backed queue ops, reorder, recovery
│   │   │   └── routes/           # catalog.ts, jobs.ts, games.ts, downloads.ts, settings.ts, export.ts
│   │   ├── data/aliases.json     # static alias table, hand-reviewed
│   │   ├── scripts/eval.ts       # replay learned_alias, resolver on vs off
│   │   └── test/fixtures/        # saved listing HTML for parser tests
│   └── web/
│       └── src/
│           ├── pages/  Import · Review · Library · Settings
│           ├── components/
│           └── api/client.ts
```

Keeping *every* assumption about Vimm's HTML inside `catalog/parser.ts` is deliberate: when the site's markup changes, exactly one file plus its fixtures need updating.

---

## 3. Data model (SQLite)

```sql
-- Mirror of the remote catalogue
CREATE TABLE catalog_entry (
  id             INTEGER PRIMARY KEY,
  platform       TEXT    NOT NULL,        -- 'PS2'
  vault_id       INTEGER NOT NULL,        -- 8433
  title          TEXT    NOT NULL,
  title_norm     TEXT    NOT NULL,        -- normalized form, indexed
  region         TEXT,                    -- 'USA', 'Japan', 'Europe'…
  version        TEXT,
  languages      TEXT,
  rating         REAL,
  url            TEXT    NOT NULL,        -- https://vimm.net/vault/8433
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL,
  UNIQUE (platform, vault_id)
);
CREATE INDEX idx_catalog_norm ON catalog_entry (platform, title_norm);

-- Global config, single row keyed by name
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,           -- region_preference, strict_region,
  value      TEXT NOT NULL,              --   thresholds, resolver_provider…
  updated_at TEXT NOT NULL
);
-- setup_completed_at absent → first-run wizard is forced (§6.0)

CREATE TABLE catalog_sync (
  platform       TEXT PRIMARY KEY,
  last_synced_at TEXT,
  entry_count    INTEGER,
  status         TEXT,                    -- idle | running | error
  error          TEXT
);

-- One import run
CREATE TABLE job (
  id                INTEGER PRIMARY KEY,
  platform          TEXT NOT NULL,
  name              TEXT,
  region_preference TEXT,                -- JSON array; null = use global default
  resolver_used     TEXT,                -- null | 'gemini' | 'ollama' …
  created_at        TEXT NOT NULL,
  status            TEXT NOT NULL        -- resolving | needs_review | complete
);

-- One input game name
CREATE TABLE job_item (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,        -- preserves input order
  input_name    TEXT    NOT NULL,
  status        TEXT    NOT NULL,        -- pending|auto_matched|needs_review|confirmed|not_found|skipped
  resolved_tier INTEGER,                 -- 0 alias | 1 exact | 2 fuzzy | 3 llm | 4 human
  chosen_entry  INTEGER REFERENCES catalog_entry(id),
  manual_url    TEXT,                    -- escape hatch: paste a URL yourself
  confidence    REAL,
  resolved_at   TEXT
);

-- Scored options shown in the review UI
CREATE TABLE match_candidate (
  id           INTEGER PRIMARY KEY,
  job_item_id  INTEGER NOT NULL REFERENCES job_item(id) ON DELETE CASCADE,
  entry_id     INTEGER NOT NULL REFERENCES catalog_entry(id),
  score        REAL NOT NULL,            -- after region bonus
  base_score   REAL NOT NULL,            -- before region bonus, for debugging
  rank         INTEGER NOT NULL,
  llm_note     TEXT                      -- one-line justification if tier 3 ranked it
);

-- The deliverable: the saved list
CREATE TABLE game (
  id          INTEGER PRIMARY KEY,
  platform    TEXT NOT NULL,
  name        TEXT NOT NULL,             -- canonical Vault title
  input_name  TEXT,                      -- what you originally typed
  vault_url   TEXT NOT NULL,
  vault_id    INTEGER,
  region      TEXT,
  version     TEXT,
  source_job  INTEGER REFERENCES job(id),
  added_at    TEXT NOT NULL,
  UNIQUE (platform, vault_id)
);
```

`game` is intentionally denormalized and self-sufficient — it survives a catalogue re-sync and serializes directly to the shape you asked for:

```json
[
  { "name": "Silent Hill 2", "vaultLink": "https://vimm.net/vault/8433" },
  { "name": "Okami",         "vaultLink": "https://vimm.net/vault/9262" }
]
```

Exposed at `GET /api/games?platform=PS2&format=json`. Full-fidelity rows (region, version, ids) are available on the same endpoint without the `minimal` flag.

---

## 4. Matching pipeline

**Normalization** (`title_norm`), applied identically to catalogue titles and your input:

1. Unicode NFKD → strip diacritics → lowercase
2. Roman numerals → arabic (`IV` → `4`) — critical for `Final Fantasy X` vs `Final Fantasy 10`
3. `&` → `and`; `+` → `plus`
4. Strip trailing parenthetical/bracketed region, platform and disc markers — `(USA)`, `(PS2)`, `[Disc 1]` (the platform suffix appears on unfiltered Vimm search results, per §1.1)
5. Strip leading articles (`the`, `a`) and all non-alphanumeric characters
6. Collapse whitespace; keep a token array for set comparison

**Scoring** — a blend, computed against every catalogue entry for the platform (11.8k × 200 comparisons is trivially fast in memory):

- exact `title_norm` equality → `1.0`
- otherwise `0.6 × Dice–Sørensen bigram similarity + 0.4 × token-set overlap`
- small bonus when the input is a strict prefix of the candidate (handles subtitles: `Silent Hill 2` → `Silent Hill 2: Restless Dreams`)
- region preference bonus — see §4.2

### 4.1 Resolution tiers

Matching runs as a cascade. Each tier only sees what the tier above couldn't settle, which is what keeps the expensive tier cheap.

| Tier | Method | Typical share of a list | Cost |
|---|---|---|---|
| 0 | Learned alias hit (§4.3) | grows over time | free, instant |
| 1 | Exact `title_norm` match | ~70% | free, instant |
| 2 | Fuzzy score ≥ 0.95 with margin ≥ 0.08 | ~15% | free, instant |
| 3 | **LLM resolver** (§4.4) — optional | ~10–15% | one batched API call |
| 4 | Human review queue | whatever's left | your attention |

Thresholds live in `config.ts` and are tunable from Settings. The margin rule in tier 2 is what makes this behave sensibly: two regional variants of the same game both score ~0.99, so the margin is ~0, so it declines to auto-accept and passes the item down.

**Live-search fallback:** for items that reach tier 4 as `not_found`, offer a one-click live site search (`&q=…`) — covers titles absent from the mirror because it went stale.

### 4.2 Region handling

Region is a **policy**, not a guess — so it is never delegated to fuzzy scoring or to the LLM. It's an ordered preference list, applied deterministically.

```
regionPreference: ["USA", "Europe", "Japan", "Australia", "Korea", "Asia"]
```

Rules:

- A candidate's score gets a small bonus by its position in the list (first = largest). The bonus is deliberately smaller than the tier-2 margin threshold, so **region preference breaks ties but never promotes a worse title match**.
- If, after scoring, the top candidates differ *only* by region and the preferred region is present, auto-accept it — this is the single biggest reduction in review-queue volume, and it's safe because you set the policy explicitly.
- If the preferred region is absent, fall through to review rather than silently taking a Japanese release.
- `strictRegion` toggle: when on, non-preferred regions are excluded from candidates entirely instead of merely deprioritized.

**Three places you can set it**, narrowest wins:

1. Global default — Settings
2. Per-import override — a region picker on the Import screen, so one list can be "Japan-only imports" without changing your default
3. Per-item — the review card lets you pick any region for that one game

Persisted as `settings.region_preference` (JSON array) globally and `job.region_preference` per import, so re-running an old job reproduces its original behaviour.

**First run asks.** There is no silent default. On first boot the app has an empty database and must sync a catalogue anyway, so it already owes you one setup screen — region preference goes there rather than being buried in Settings you'd never visit. `REGION_PREFERENCE` in the environment pre-fills the picker (and, if `SETUP_SKIP=true`, accepts it unattended for scripted deploys), but with neither set the app will not proceed until you choose. Silently defaulting to USA and quietly mismatching a Japan-focused collection is the kind of failure you wouldn't notice for fifty games.

### 4.3 Alias tables

Two sources, both consulted at tier 0, both plain local data:

**Static aliases** — `sources/aliases.json`, committed to the repo. Covers the well-known regional renames and abbreviations that pure string matching scores at ~0:

```
Biohazard 4        → Resident Evil 4
Rockman X          → Mega Man X
Dragon Quest (SNES)→ Dragon Warrior
mgs3, gta sa, ff10, smt nocturne, re4 …
```

Generated once, offline, reviewed by hand, then committed. Zero runtime dependency, works with no API key, deterministic.

**Learned aliases** — every confirmation you make in the review queue is ground truth, so store it:

```sql
CREATE TABLE learned_alias (
  id           INTEGER PRIMARY KEY,
  platform     TEXT NOT NULL,
  input_norm   TEXT NOT NULL,
  entry_id     INTEGER NOT NULL REFERENCES catalog_entry(id),
  vault_id     INTEGER NOT NULL,   -- survives catalogue re-sync
  source       TEXT NOT NULL,      -- user | static | llm
  confirmed_at TEXT NOT NULL,
  UNIQUE (platform, input_norm)
);
```

The effect compounds: the tool needs the LLM less every time you use it, and after a few imports your own vocabulary is covered better than any generic alias list could. This table is also the evaluation set — see §4.5.

### 4.4 Optional LLM resolver (Gemini)

**Enabled only when `GEMINI_API_KEY` is set.** Absent, everything works; more items simply reach the review queue. This must never become a hard dependency for a self-hosted tool.

Tier 3 runs two passes, both of which produce output that is **validated against the local mirror before it can touch the database**:

**Pass A — alias expansion.** Send the unresolved input names (batched, all in one request) and ask for known alternate titles: regional renames, romanizations, expanded abbreviations. The model returns *strings only*. Each string is re-run through the normal local matcher. If a returned alias matches nothing in the catalogue, nothing happens.

**Pass B — constrained re-ranking.** For items still ambiguous, send the input plus the top 8 local candidates including region and version, and ask for a selection **by index** with a one-line justification. Any response whose index is outside the supplied set is rejected outright.

**The non-negotiable constraint:** the model never emits a URL, a vault ID, or a title that becomes a stored value. It proposes search strings, or it picks from a list you gave it. A model will happily invent `vimm.net/vault/8891` for a game that does not exist, and it will look entirely plausible in your database. This architecture makes that structurally impossible rather than merely unlikely.

Implementation notes:

- Gemini's [structured output](https://ai.google.dev/gemini-api/docs/structured-output) enforces a response JSON schema — use it; don't parse free text.
- Flash tier, one or two batched calls per import — cost is a rounding error at this volume ([pricing](https://ai.google.dev/gemini-api/docs/pricing)).
- Cache by `(platform, input_norm)` in `resolver_cache` with a TTL, so re-running a list costs nothing.
- Behind a `Resolver` interface (`expandAliases`, `rerank`) with `GeminiResolver`, `OpenAIResolver`, `OllamaResolver` implementations. Self-hosters will want the local option.
- Log every call to `resolver_call` (input, tier, model, accepted/rejected, latency) so §4.5 has data.
- Never send the whole catalogue in the prompt — only the input names and the shortlist.

```sql
CREATE TABLE resolver_cache (
  platform    TEXT NOT NULL,
  input_norm  TEXT NOT NULL,
  response    TEXT NOT NULL,       -- JSON
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (platform, input_norm, model)
);
```

### 4.5 Measuring whether the LLM earns its place

`learned_alias` accumulates human-confirmed pairs — a real labelled set, produced as a side effect of ordinary use. A `npm run eval` script replays it through the matcher with the resolver on and off and reports resolution rate, wrong-match rate, and cost per import.

Most "should I add AI here?" questions never get an answer because nobody has ground truth. This design generates it for free. If the resolver turns out to add two percentage points, turn it off and save the key.

---

## 5. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/platforms` | Supported platform slugs |
| `GET` | `/api/catalog/status` | Per-platform sync state, entry count, age |
| `POST` | `/api/catalog/sync` | Start/refresh a platform crawl (SSE progress) |
| `POST` | `/api/jobs` | `{ platform, names[], regionPreference?, useResolver? }` → creates job, runs the tier cascade |
| `GET` | `/api/jobs/:id` | Job + counts by status **and by resolved tier** |
| `GET` | `/api/jobs/:id/items` | Items, filterable by status, with candidates |
| `POST` | `/api/jobs/:id/items/:itemId/resolve` | `{ entryId }` \| `{ manualUrl }` \| `{ skip: true }` — also writes `learned_alias` |
| `POST` | `/api/jobs/:id/commit` | Write confirmed items into `game` |
| `GET` | `/api/games` | The saved list (`?format=json\|csv`, `?minimal=true`) |
| `DELETE` | `/api/games/:id` | Remove an entry |
| `GET` | `/api/setup/state` | `{ completed: bool }` — drives the first-run redirect |
| `POST` | `/api/setup/complete` | `{ platform, regionPreference[], strictRegion, resolver? }` |
| `GET`/`PUT` | `/api/settings` | Region preference, thresholds, resolver on/off |
| `GET` | `/api/resolver/status` | Configured provider, key present, cache hit rate, spend |
| `GET` | `/api/aliases` | Learned aliases — viewable, deletable when you mis-confirm |

---

## 6. UI

Four screens plus a one-time wizard, deliberately plain.

### 6.0 First-run wizard

Forced whenever `settings.setup_completed_at` is absent — every route redirects to it. Three steps, and step 2 has no skip:

```
┌───────────────────────────────────────────────────────────┐
│  Step 2 of 3 — Which regions do you prefer?               │
│                                                            │
│  Drag to rank. Matching prefers higher entries when the    │
│  same game exists in several regions.                      │
│                                                            │
│    ⠿ 1  USA                                          [×]  │
│    ⠿ 2  Europe                                       [×]  │
│    ⠿ 3  Japan                                        [×]  │
│    + add region…                                          │
│                                                            │
│  ☐ Strict — never match outside these regions             │
│                                                            │
│  Preview:  "Resident Evil 4"  →  USA v1.00                │
│                                       [ Back ]  [ Next ]  │
└───────────────────────────────────────────────────────────┘
```

1. **Pick a platform** and start its first catalogue sync (runs in the background through steps 2–3, so the wait costs nothing)
2. **Region preference** — the picker above, no default pre-selected beyond what `REGION_PREFERENCE` supplies, `Next` disabled until at least one region is chosen
3. **Optional resolver** — paste a Gemini key or skip; explicitly labelled *optional*, with a line explaining the tool works fully without it

Writes `settings.setup_completed_at` on finish. Everything set here is editable later in Settings; the wizard exists to make sure the choice is *made*, not to lock it in. Re-runnable from Settings.

**Unattended installs:** `SETUP_SKIP=true` plus `REGION_PREFERENCE` completes the wizard non-interactively. Without it, a fresh container serves the wizard rather than guessing.

### 6.1 Screens

**Import** — platform dropdown, **region picker**, big textarea (one game per line, paste from anywhere), a preview count, and a warning banner if the catalogue for that platform has never been synced or is >30 days old.

The region picker is a drag-to-reorder list pre-filled from your global default, plus a "strict — exclude other regions" checkbox and an AI-assist toggle (shown only when a resolver key is configured):

```
┌───────────────────────────────────────────────────────────┐
│  Platform  [ PS2  ▾ ]                                     │
│  Region preference    ⠿ USA   ⠿ Europe   ⠿ Japan   [+]    │
│  ☐ Strict — never match outside these regions             │
│  ☑ Use AI for unresolved titles   (Gemini · ~12 items)    │
└───────────────────────────────────────────────────────────┘
```

**Review** — the heart of it. A keyboard-driven queue, one item per card:

```
┌───────────────────────────────────────────────────────────┐
│  "biohazard 4"                            3 of 11 to review│
│  ✦ AI: likely the Japanese title for Resident Evil 4       │
├───────────────────────────────────────────────────────────┤
│ ▸ 1  Resident Evil 4        USA    v1.00   0.98   [Enter] │
│      ⓘ Already in library — added 12 Mar, file on disk    │
│   2  Resident Evil 4        Europe v1.01   0.94   [2]     │
│   3  Biohazard 4            Japan  v1.00   0.91   [3]     │
├───────────────────────────────────────────────────────────┤
│  [S] skip  [U] paste URL  [F] search site  [R] region ▾   │
└───────────────────────────────────────────────────────────┘
```

Number keys select, Enter confirms, arrows move, `R` overrides region for this one item. AI suggestions are labelled and shown as *advice next to the local candidates* — never as a pre-made decision, and never as a row you can't verify. Confirming writes a `learned_alias`, so "biohazard 4" resolves instantly and for free next time.

**Duplicate detection.** Every candidate is checked against `game` and `library_file` by `vault_id` as the queue is built, and annotated inline:

| Badge | Meaning | Behaviour on confirm |
|---|---|---|
| `ⓘ Already in library — file on disk` | In `game` *and* `library_file` exists | Confirm button becomes **Confirm anyway**; a second keypress is required |
| `ⓘ In library, file missing` | In `game`, no file found | Offers **Re-download** — the common case after you've moved or pruned storage |
| `ⓘ Queued for download` | Active `download` row exists | Won't double-enqueue |

The point is that the badge is attached to the *candidate*, not the item. If your input matches one game you already own and one you don't, you can see which is which without leaving the queue. Items whose only plausible match is already in the library are collapsed by default behind a "12 already owned" summary row — the review queue should show you decisions, not confirmations of things already settled.

`GET /api/jobs/:id/items` returns a `libraryState` field per candidate so the client renders this without a second round-trip.

**Library** — the saved `game` table: searchable, sortable, per-row link out to the Vault page, a tier badge showing how each row was resolved, bulk delete, export JSON/CSV.

**Settings** — catalogue sync per platform, default region preference, matching thresholds, crawl delay, resolver provider + key + cache stats, and a browsable/editable learned-alias list.

---

## 7. Docker

**Revised driver choice.** gamarr deliberately uses a pure-Go SQLite with zero CGO so it ships as one static binary with no native build step. Node has the same escape hatch now: **`node:sqlite`**, built into Node 22+ and stable in Node 24, with a synchronous API very close to `better-sqlite3`'s. Using it removes `python3 make g++` from the build, cuts image size, and eliminates the cross-architecture native-binary problem outright. Recommended primary; `better-sqlite3` stays the fallback if we hit a missing API (its `.backup()` and user-defined-function support are richer).

Multi-stage build:

- **Stage 1** `node:24-bookworm-slim` → install workspace deps, build `web` (Vite) and `server` (tsc), then `npm prune --omit=dev`
- **Stage 2** `node:24-bookworm-slim` → copy `dist/` + pruned `node_modules`, run as non-root `node` user
- `EXPOSE 8080`, `VOLUME /data`, `HEALTHCHECK` against `/api/health`
- Migrations run automatically on boot

```yaml
services:
  vl-collection-builder:
    build: .
    ports: ["8080:8080"]
    volumes: ["./data:/data"]
    environment:
      DATABASE_PATH: /data/vault.db
      CRAWL_DELAY_MS: "1200"
      USER_AGENT: "vl-collection-builder/1.0 (personal catalogue tool)"
      SOURCES_PATH: ""        # optional: override the embedded source registry
      SOURCES_URL: ""         # optional: fetch registry from a URL
      REGION_PREFERENCE: ""   # pre-fills the first-run picker; empty → wizard asks
      SETUP_SKIP: "false"     # true + REGION_PREFERENCE → non-interactive setup
      RESOLVER: ""            # "" (off) | gemini | openai | ollama
      GEMINI_API_KEY: ""      # absent → tier 3 skipped entirely
      RESOLVER_MODEL: ""      # optional pin; defaults to a Flash-tier model
      RESOLVER_MAX_ITEMS: "50"  # hard cap per import, cost guard
    restart: unless-stopped
```

With `node:sqlite` there is no native addon, so the image is architecture-portable — the Apple-Silicon-to-x86 caveat that would apply to `better-sqlite3` disappears.

---

## 8. Download queue

### 8.0 Two constraints that set the design

Both came from the sources we're building on, and both point the same way.

**Vimm's operator has stated the rule directly.** Asked on the site's own message board whether concurrent downloads were possible, the operator's answer was that you can only download one game at a time ([thread](https://vimm.net/bbs/?Post=20768)). Parallel downloads aren't an unspecified grey area here — they're the thing the person running the server said no to.

**vl-downloader's author asks the same thing, in the README of the code we're basing this on.** That project is deliberately one-at-a-time, and its README asks readers not to modify it to download large numbers of ROMs at once, and not to be aggressive toward the site. You asked me to credit these projects as our foundation (§14) — and crediting a project while shipping the one modification its author explicitly asked people not to make doesn't hold together.

**Decision: downloads are serial, permanently. There is no concurrency setting.**

This is deliberately not a configurable knob. A `DOWNLOAD_CONCURRENCY` variable would be a standing invitation to raise it, and the two constraints above aren't preferences we're accommodating — they're the stated rule of the server operator and the explicit request of the author whose code this is built on. A setting that only exists to be turned up to a value we've agreed is wrong is worse than no setting: it moves the decision from the plan, where it's reasoned about once, into an env file where it gets changed without context.

One worker. One file at a time. `INTER_DOWNLOAD_DELAY_MS` (default 3000) spaces successive files.

Everything else asked for — persistent queue, progress, resumability, reordering, Docker-configurable paths — is below and unaffected. And the serial worker is *why* the rest of this design gets to be simple: no lock contention, no partial-file races, no connection-pool tuning, no competing writes to the same `.part`.

### 8.1 What vl-downloader contributes

[vl-downloader](https://github.com/Raiper34/vl-downloader) (NestJS + Angular, MIT) is the closest prior art. What it gets right and we adopt:

| Its approach | Our take |
|---|---|
| Queue entity with `status` (Queued/Downloading/Completed/Error) + `totalBytes`/`receivedBytes` | Adopt wholesale — it's the right progress model |
| BullMQ + Redis for the job queue | **Reject.** Redis means a second container; we're single-image. An in-process serial worker with SQLite-persisted state gives identical behaviour at concurrency 1 |
| WebSocket push for live progress | Adopt, as SSE — we already use SSE for catalogue sync, so one transport for both |
| TypeORM + SQLite for persistence | Same idea, via `node:sqlite` (§7) |
| Downloads dir as a mounted volume | Adopt: `/downloads` |

The download mechanism itself — the vault page carries a form whose action points at a numbered download host, with a `mediaId` field, and the request needs a matching `Referer` — is visible in both vl-downloader and gamarr's `downloadVimmGame`. We reimplement it in `download/vimm.ts`, isolated the same way `catalog/parser.ts` is, because it's equally exposed to site changes.

### 8.2 Queue model

```sql
CREATE TABLE download (
  id             INTEGER PRIMARY KEY,
  game_id        INTEGER REFERENCES game(id) ON DELETE SET NULL,
  vault_id       INTEGER NOT NULL,
  vault_url      TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  platform       TEXT    NOT NULL,
  status         TEXT    NOT NULL,   -- queued|active|paused|completed|error|cancelled
  position       INTEGER NOT NULL,   -- manual ordering
  file_name      TEXT,               -- from Content-Disposition, sanitized
  dest_path      TEXT,
  total_bytes    INTEGER DEFAULT 0,
  received_bytes INTEGER DEFAULT 0,
  attempts       INTEGER DEFAULT 0,
  error          TEXT,
  queued_at      TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,
  UNIQUE (vault_id, status) WHERE status IN ('queued','active')  -- no double-queueing
);
CREATE INDEX idx_download_queue ON download (status, position);
```

**Worker loop** (`download/worker.ts`) — a single async loop, started at boot:

1. Claim the lowest-`position` `queued` row inside a transaction, set `active`
2. Fetch the vault page → extract form action + `mediaId`
3. `GET` with `Referer` set, honouring `Range` if a `.part` file exists
4. Stream to `{dest}/{platform}/{file}.part`, updating `received_bytes` every ~1s (throttled writes, not per-chunk)
5. On completion: verify byte count against `Content-Length`, atomically rename off `.part`, mark `completed`
6. On failure: `attempts++`, exponential backoff, `error` after 3 tries
7. Sleep `INTER_DOWNLOAD_DELAY_MS` (default 3000) before claiming the next — deliberate politeness between files

**Crash recovery:** on boot, any row left `active` is reset to `queued`; its `.part` file survives, so a `Range` request resumes rather than restarts. Interrupting a 4 GB PS2 image shouldn't cost you the 4 GB.

**Safety:** filenames sanitized against traversal (gamarr rejects unsafe names outright — same here); a size cap and free-disk precheck before starting; refuse to overwrite an existing completed file unless `overwrite` is set.

### 8.3 Integration with the library

The queue is fed *from* the catalogue, which is the whole point of having built §4 first: select rows in the Library, "Add to downloads", and the queue receives real verified vault URLs rather than anything guessed.

A **Downloads** screen joins the four existing ones: active item with a progress bar and rate, drag-to-reorder queue, pause/resume/cancel/retry, completed and failed lists, and free-disk display.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/downloads` | `{ gameIds[] }` or `{ vaultUrls[] }` → enqueue |
| `GET` | `/api/downloads` | Queue + active item, filterable |
| `GET` | `/api/downloads/stream` | SSE — progress ticks |
| `PATCH` | `/api/downloads/:id` | `{ position }` \| `{ status: 'paused'\|'queued' }` |
| `POST` | `/api/downloads/:id/retry` | Reset attempts, requeue |
| `DELETE` | `/api/downloads/:id` | Cancel; optionally delete the `.part` |

### 8.4 Docker configuration

```yaml
services:
  vl-collection-builder:
    build: .
    ports: ["8080:8080"]
    volumes:
      - ./data:/data              # SQLite
      - ./downloads:/downloads    # ROM output
    environment:
      DOWNLOADS_PATH: /downloads
      INTER_DOWNLOAD_DELAY_MS: "3000" # pause between files
      DOWNLOAD_RETRY_LIMIT: "3"
      DOWNLOAD_TIMEOUT_MS: "0"        # 0 = no timeout; ROMs are large
      MIN_FREE_DISK_MB: "2048"
    restart: unless-stopped
```

Note the absence of a concurrency variable — see §8.0. The worker is a single loop by construction, not a pool sized to `1`.

Full path configuration is in §9.5 — downloads and library are two separate, independently mountable volumes.

---

## 9. Post-processing & library layout

Downloading is only half the job. A folder of `Silent.Hill.2.zip` files is not something an emulator can use. This stage turns raw downloads into a browsable, scraper-friendly library.

### 9.1 Two directories, two jobs

```
/downloads          ← staging. Raw archives exactly as served. Disposable.
  ps2/
    Silent Hill 2 (USA).zip

/library            ← the organized output. This is what you point emulators at.
  ps2/
    Silent Hill 2 (USA).iso
  psx/
    Final Fantasy VII (USA)/
      Final Fantasy VII (USA) (Disc 1).cue
      Final Fantasy VII (USA) (Disc 1).bin
      Final Fantasy VII (USA) (Disc 2).cue
      Final Fantasy VII (USA) (Disc 2).bin
      Final Fantasy VII (USA).m3u
  snes/
    Chrono Trigger (USA).zip        ← left zipped on purpose, see §9.3
```

Keeping them separate matters: staging can live on a fast scratch disk and be pruned, while the library sits on bulk storage and is the thing you back up. It also makes the whole stage re-runnable — if you change your naming template, re-organize from staging without re-downloading anything.

### 9.2 Naming: follow the existing standard

Don't invent a convention. The scraper ecosystem (EmulationStation, Skraper, RetroArch playlists, LaunchBox) matches against **No-Intro / Redump style**:

```
Title (Region) (Version).ext
```

We already have all three fields from the catalogue — title, region, version — which is a quiet payoff from having built §4 first: the metadata needed for correct naming was captured at match time, not guessed from a filename afterwards.

Configurable via template:

```
NAMING_TEMPLATE: "{title} ({region})"
```

Available tokens: `{title}` `{region}` `{version}` `{platform}` `{vaultId}` `{disc}`. Illegal filesystem characters are replaced, not stripped, so `Ratchet & Clank: Up Your Arsenal` stays readable.

### 9.2b Platform folder naming — `PLATFORM_FOLDER_STYLE`

Front-ends auto-detect systems by folder name, and they don't agree with each other. A mismatch isn't a data error — the files are fine — but the front-end shows an empty system and the games look missing. So this is fully Docker-configurable, with verified presets shipped in the source registry (§1.1).

**Built-in presets**, verified against the [ES-DE directory reference](https://github.com/retrogamecorps/ES-DE-Directories) and the [Batocera systems wiki](https://wiki.batocera.org/systems):

| Our slug | `slug` *(default)* | `esde` | `batocera` |
|---|---|---|---|
| `nes` `snes` `n64` `gb` `gbc` `gba` `nds` `wii` `saturn` `psx` `ps2` `ps3` `psp` | *identical across all three* | | |
| `ngc` | `ngc` | `gc` | `gamecube` |
| `dc` | `dc` | `dreamcast` | `dreamcast` |
| `genesis` | `genesis` | `genesis` ¹ | `megadrive` |
| `xbox` | `xbox` | — ² | `xbox` |
| `xbox360` | `xbox360` | — ² | `xbox360` ³ |

¹ ES-DE ships **both** `genesis` and `megadrive` as separate systems, split by region. The preset uses `genesis`; override if your set is PAL/JP.
² Not shipped by ES-DE — needs a custom system definition on the front-end side regardless of what we name the folder.
³ Not verified against current Batocera docs; confirm before relying on it.

**`retroarch`** is accepted and maps to `slug`. RetroArch builds playlists by scanning content and matching against DATs rather than trusting folder names, so the folder name genuinely doesn't matter there — the preset exists so the setting isn't a lie, not because it does anything.

**Per-platform overrides** — `PLATFORM_FOLDER_MAP` layers on top of any preset, so you never need to fork a whole map to fix one entry:

```yaml
PLATFORM_FOLDER_STYLE: "esde"
PLATFORM_FOLDER_MAP: "genesis=megadrive,xbox=microsoft-xbox"
```

Precedence: `PLATFORM_FOLDER_MAP` entry → preset → raw slug.

**Validated at boot** against the platform registry. An unknown slug on the left-hand side (a typo like `gamecube=gc`, where our slug is `ngc`) is logged, surfaced as a warning banner in Settings, and ignored — it doesn't crash the container, but it also doesn't silently mis-file 400 games without telling you.

**Changing it later doesn't strand your library.** Because `library_file` records every path, switching style triggers an offered **re-path migration**: existing folders are renamed in place, database rows updated, nothing re-extracted or re-downloaded. It's a directory rename, so it takes seconds even for a large library. Declining leaves everything where it is; the setting then applies only to new additions.

### 9.3 Extraction policy — not always the right move

Unzipping everything is the obvious default and it's wrong.

RetroArch and most cartridge-system emulators read zipped ROMs natively. A zipped SNES library is a fraction of the size and works identically. Disc images, by contrast, *must* be extracted — no emulator mounts a 4 GB ISO from inside a zip.

So `EXTRACT_POLICY` defaults to `disc-only`:

| Value | Behaviour |
|---|---|
| `disc-only` *(default)* | Extract PS1/PS2/PSP/GC/Wii/Saturn/Dreamcast; leave cartridge systems zipped |
| `always` | Extract everything |
| `never` | Copy archives across, renamed only |

Classification comes from a `discBased: true` flag added to the platform registry.

### 9.4 The three things that actually break

Everything above is bookkeeping. These are the parts worth building carefully.

**`.cue` files reference `.bin` filenames by name.** Rename `Track 01.bin` to match your template and the `.cue` silently points at a file that no longer exists — the game won't boot, and nothing errors at extract time. So: after renaming a `.bin`/`.img` set, **parse and rewrite the `.cue`** to match. Same for `.gdi` (Dreamcast) and `.ccd`/`.sub` sets. This is the single most common way homemade organizers corrupt a library.

**Multi-disc games need an `.m3u`.** The convention emulators expect is one folder per game containing each disc, plus a plain-text `.m3u` listing the disc images in order. That's what lets an emulator swap discs mid-game. We can detect multi-disc sets reliably because the catalogue titles carry the disc marker, so `GENERATE_M3U: "true"` writes it automatically. Multi-file games get their own subfolder; single-file games stay flat — mixing the two is what makes a library annoying to browse.

**Zip-slip.** An archive entry named `../../etc/something` will escape the extraction directory in a naive implementation. Every entry path is resolved and verified to sit inside the destination before a single byte is written, and any archive containing a traversal entry is rejected wholesale rather than partially extracted.

### 9.5 Pipeline mechanics

A download's lifecycle gains a second half:

```
queued → active → downloaded → organizing → converting → organized
                                    ↓            ↓
                              organize_error   (falls back to extracted
                            (retryable, archive  layout + warning, not
                                retained)         a hard failure)
```

Steps, per item:

1. Precheck free space — extraction needs **archive size + extracted size** available simultaneously; disc images roughly double
2. Extract to a temp dir under `WORK_PATH` (default `/library/.tmp/{id}`, i.e. on the library volume) — never the container's own `/tmp`, or the final move becomes a slow cross-device copy instead of an instant rename. Deliberately relocatable for NAS setups; see §9.6b
3. Rename entries per template; rewrite `.cue`/`.gdi` references
4. Convert to `.chd` if eligible, verify, then discard the source (§9.5b)
5. Generate `.m3u` if multi-disc
6. Atomic `rename()` of the temp dir into its final location
7. Delete the staging archive if `KEEP_ARCHIVE=false`
8. Record every produced file in `library_file`

```sql
CREATE TABLE library_file (
  id           INTEGER PRIMARY KEY,
  download_id  INTEGER REFERENCES download(id) ON DELETE SET NULL,
  game_id      INTEGER REFERENCES game(id) ON DELETE SET NULL,
  platform     TEXT NOT NULL,
  rel_path     TEXT NOT NULL,        -- relative to LIBRARY_PATH
  bytes        INTEGER,
  kind         TEXT,                 -- rom | iso | cue | bin | m3u | archive
  created_at   TEXT NOT NULL,
  UNIQUE (platform, rel_path)
);
```

Crash safety falls out of step 5: a crash mid-extract leaves an orphaned `.tmp/{id}` directory and an `organizing` row. On boot, both are cleaned up and the item is requeued for organizing — the archive is still in staging, so nothing is re-downloaded.

**Re-organize without re-downloading:** `POST /api/downloads/:id/reorganize`, or bulk from Settings after changing the template. This is the payoff of keeping staging separate, and it's why `KEEP_ARCHIVE=true` is a reasonable choice if you have the disk.

**Container dependencies:** `.zip` is handled by a streaming Node library, no binary needed. `.7z`/`.rar` would need `p7zip-full` (~12 MB) if Vimm ever serves them. `mame-tools` (~30–40 MB) is included for `chdman` — see §9.5b.

### 9.5b CHD conversion

**Included, on by default for disc platforms.** `chdman` (from the MAME toolchain) packs `.bin`/`.cue` and `.iso` into a single compressed `.chd`, typically 40–60% smaller with no data loss, and it's read natively by the major disc emulators. For a PS2 or PS1 library this is the difference between 400 GB and roughly 200.

It also makes most of §9.4 disappear: a `.chd` is *one file*, so there are no `.bin` references to rewrite and no multi-file subfolder to manage. The cue-rewriting logic still ships — it's needed for anything CHD can't take, and for `CHD_POLICY: never` — but the default path stops depending on it.

```
CHD_POLICY: "disc-only"   # disc-only (default) | never
CHD_KEEP_SOURCE: "false"  # true = keep the extracted .bin/.cue alongside
```

Mechanics:

- Runs as a step between rename and atomic-move, inside the temp dir — so a failed conversion never leaves a half-written `.chd` in the library
- `chdman createcd` for `.cue`/`.gdi` sets, `chdman createdvd` for DVD-based images (PS2, GC, Wii)
- **Verify before discarding**: `chdman verify` on the output, and only then delete the source. An unverified conversion that silently truncated is worse than no conversion
- CPU-bound and slow — minutes per disc. Runs in the same serial pipeline, so it never competes with a download for bandwidth or with itself for cores
- Multi-disc sets convert per-disc; the `.m3u` then lists `.chd` files instead of `.cue` files
- Anything `chdman` rejects falls back to the plain extracted layout with a warning on the item, not a hard failure

**Cost:** `mame-tools` in the runtime image, roughly 30–40 MB. Given it can halve a multi-hundred-gigabyte library, that trade is not close.

### 9.6 Docker configuration

```yaml
services:
  vl-collection-builder:
    build: .
    ports: ["8080:8080"]
    volumes:
      - ./data:/data                     # SQLite database
      - /mnt/scratch/downloads:/downloads # staging — fast disk, disposable
      - /mnt/nas/roms:/library            # organized output — bulk storage
    environment:
      # --- paths (all three independently mountable) ---
      DATABASE_PATH: /data/vault.db
      DOWNLOADS_PATH: /downloads
      LIBRARY_PATH: /library

      # --- organizing ---
      ORGANIZE_ENABLED: "true"
      EXTRACT_POLICY: "disc-only"        # disc-only | always | never
      KEEP_ARCHIVE: "false"              # true = re-organize without re-downloading
      NAMING_TEMPLATE: "{title} ({region})"

      # --- platform folder naming (§9.2b) ---
      PLATFORM_FOLDER_STYLE: "slug"      # slug | esde | batocera | retroarch
      PLATFORM_FOLDER_MAP: ""            # per-platform overrides, layered on the preset
                                         #   e.g. "genesis=megadrive,ngc=gc"
      GENERATE_M3U: "true"
      REWRITE_CUE_PATHS: "true"
      CHD_POLICY: "disc-only"            # disc-only | never
      CHD_KEEP_SOURCE: "false"
      WORK_PATH: "/library/.tmp"         # extract/convert scratch — see §9.6b for NAS
      MIN_FREE_DISK_MB: "4096"           # headroom for extract + convert
      PUID: "1000"                       # match the owner of your mounts
      PGID: "1000"
      UMASK: "022"
    restart: unless-stopped
```

Point `LIBRARY_PATH` at an NFS/SMB mount and the organized library lands straight on your NAS. `ORGANIZE_ENABLED: "false"` reduces the tool to a plain downloader.

### 9.6b Deploying on a NAS via Portainer

Yes — all three paths are independent, and nothing has to live at the root of your mount.

There are two ways to point them at subfolders of a NAS share, and the choice matters more than it looks.

**Recommended — subpath bind mounts.** Map the specific NAS subfolders on the host side, so the container never sees the rest of the share:

```yaml
services:
  vl-collection-builder:
    image: vl-collection-builder:latest
    container_name: vl-collection-builder
    ports: ["127.0.0.1:8080:8080"]
    volumes:
      - vlcb-data:/data                    # named volume — LOCAL, see below
      - /mnt/media/roms/.staging:/downloads       # NAS subfolder
      - /mnt/media/roms/library:/library          # NAS subfolder
    environment:
      DATABASE_PATH: /data/vault.db
      DOWNLOADS_PATH: /downloads
      LIBRARY_PATH: /library
      WORK_PATH: /library/.tmp
      PUID: "1000"
      PGID: "1000"
      UMASK: "022"
    restart: unless-stopped

volumes:
  vlcb-data:
```

The alternative — mounting `/mnt/media:/media` whole and setting `DOWNLOADS_PATH=/media/roms/.staging` — also works and is fully supported. It's just strictly more exposure: a path bug then has your entire NAS in reach rather than one folder.

**Four things that specifically bite on a NAS.** These are the difference between this working first try and an evening of debugging.

**1. Keep the SQLite database off the network share.** This is the one that causes real damage. SQLite's locking depends on POSIX advisory locks, which are unreliable or silently broken over NFS and CIFS — the documented failure mode is `database disk image is malformed`, i.e. corruption, not a clean error. [SQLite's own guidance](https://www.sqlite.org/faq.html) warns against network filesystems, and it's a recurring [real-world](https://access.redhat.com/solutions/120733) failure. So `/data` is a **named Docker volume on local disk**, never a NAS path. It's small — tens of MB for a full multi-platform catalogue — so there's no storage argument for putting it on the NAS. Back it up by exporting, not by relocating it.

**2. Permissions — the most common Portainer + NAS failure.** The container runs as non-root, and NAS mounts usually enforce a specific uid/gid. `PUID`/`PGID` set the runtime user; on the host, `id -u` and `id -g` for the account that owns the share give you the values. Symptom if wrong: `EACCES` on the first write, after a download has already completed. The startup check in point 4 catches this before you find out the slow way.

**3. `WORK_PATH` is now configurable, and on a NAS you may want to move it.** By default the extract/convert scratch directory sits inside `LIBRARY_PATH` so the final step is an instant `rename()` rather than a copy. But CHD conversion is CPU-bound and does heavy random I/O — running that against SMB can be dramatically slower than doing it on local disk and copying the finished file over. If your NAS link is the bottleneck, mount a local scratch volume and set `WORK_PATH` to it. The trade-off is explicit: local work dir means the final move is a cross-device copy instead of a rename. Both are supported; `WORK_PATH` inside the library volume remains the default because it's the safer general case.

**4. Startup preflight.** On boot the container verifies each configured path exists, is writable by the runtime user, reports free space, and warns loudly if `DATABASE_PATH` looks like a network mount. Failing at startup with a clear message beats failing after a 4 GB download.

**Portainer specifics:** bind-mount paths resolve on the **Docker host**, not inside the Portainer container — if `/mnt/media` is mounted on the host, use that path directly and ignore how Portainer's own filesystem looks. Deploy as a Stack by pasting the compose above. If the NAS mounts *after* Docker starts on boot, add a `depends_on` for a mount-check service or set the NAS mount as a systemd requirement, otherwise Docker may create an empty `/mnt/media/roms` directory on local disk and cheerfully download into it.

### 9.7 UI

The **Downloads** screen gains an organize column showing the post-processing state and the final library path. The **Library** screen gains a "Files" expander per game listing what's on disk with sizes, a badge for anything whose files have gone missing, and a per-row "Re-organize" action. Settings gets a template editor with a **live preview** rendering three example titles — including a multi-disc one — so you can see what a change does before applying it to 400 games.

---

## 10. Build order

| Phase | Deliverable | Why this order |
|---|---|---|
| 1 | Repo scaffold, Docker, health endpoint, migrations, sources registry | Get the container running before there's anything in it |
| 2 | `parser.ts` (table + regex fallback) + fixture tests against saved HTML | Highest-risk unknown; validate before building on it |
| 3 | `fetcher.ts` + `health.ts` + `sync.ts`, `/api/catalog/*` | Fill the mirror; verify ~11.8k PS2 rows land |
| 4 | `normalize.ts` + `score.ts` + `region.ts` + unit tests on a hand-built tricky-titles set | Tune thresholds and region bonus against known-hard cases, headless |
| 5 | Static `aliases.json` + `learned_alias` + tier cascade | Free accuracy first — establishes the baseline the LLM must beat |
| 6 | Jobs API + `game` table + export | Full pipeline works via curl |
| 7 | React UI: first-run wizard → Import (with region picker) → Review → Library | Only now, on a proven backend |
| 8 | **Optional resolver: `Resolver` interface + `gemini.ts` + cache** | Behind a flag, measured against phase 5's baseline |
| 9 | **Download queue: `download/vimm.ts` + `worker.ts` + Downloads screen** | Consumes verified links, so it needs everything above to exist first |
| 10 | **Organizer: extract → rename → `.cue` rewrite → CHD convert → `.m3u` → atomic move** | Separate from downloading, and re-runnable against staging — so it can be iterated on without touching the network |
| 11 | Settings, SSE progress, `eval.ts`, polish | — |
| 12 | **Docs: README, `.env.example`, `docs/`, `THIRD_PARTY_LICENSES.md`** | Final pass — but the config table and decision rationales are written *during* each phase, not reconstructed here (§13.6) |

Phase 4's test set should be written before the scorer: `Final Fantasy X`, `Resident Evil 4`, `Okami`, `Shin Megami Tensei: Nocturne`, `Katamari Damacy`, `Devil May Cry 3` (vanilla vs Special Edition), `Silent Hill 2` (Greatest Hits vs original) — these are where naive matching breaks.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Vimm's HTML changes | All parsing in one file; fixture tests fail loudly; **regex fallback keeps titles + ids flowing even if the table layout breaks**, degrading rather than failing |
| Rate limiting / IP block | 1.2s delay, single concurrency, honest User-Agent, circuit breaker (§1.1), resumable sync; browser UA documented as last resort |
| Catalogue goes stale | `last_synced_at` surfaced in UI; live-search fallback for misses |
| Regional duplicates picked wrong | Ordered preference list applied deterministically; bonus is smaller than the tier-2 margin, so it breaks ties but never outranks a better title match; per-job and per-item override |
| **LLM invents a game or a URL** | Structurally prevented: the model emits search strings or an index into a list we supplied. Every output is validated against the local mirror before it can be stored. It never produces a URL or vault ID |
| **LLM becomes a hard dependency** | Tier 3 is skipped entirely when no key is set; phases 1–7 ship a fully working tool without it |
| **Runaway API cost** | `RESOLVER_MAX_ITEMS` cap per import, batched requests, response cache keyed on `(platform, input_norm, model)`, spend surfaced in Settings |
| LLM is quietly useless | `eval.ts` replays the confirmed set with the resolver on and off; if the delta is negligible, turn it off |
| Large download interrupted | `.part` files + HTTP `Range` resume; `active` rows reset to `queued` on boot, so a crash costs seconds, not gigabytes |
| Disk fills mid-download | `MIN_FREE_DISK_MB` precheck before each item; queue pauses rather than writing a truncated file |
| Path traversal via `Content-Disposition` | Filenames sanitized and rejected outright if unsafe, mirroring gamarr's handling |
| Being a bad guest to the source site | Serial worker, 3s inter-file delay, honest User-Agent, circuit breaker shared with the crawler (§1.1) |
| **Renaming silently breaks a disc image** | `.cue`/`.gdi` internal references are rewritten to match new filenames (§9.4) — the failure mode is a game that won't boot with no error at extract time, so this is tested against a real multi-track set |
| **Zip-slip during extraction** | Every archive entry path resolved and verified inside the destination before writing; traversal entries reject the whole archive |
| Extraction fills the disk | Precheck requires archive + extracted size free; disc images roughly double during the operation |
| Crash mid-extract corrupts the library | Extract to `.tmp` on the library volume, atomic `rename()` into place; orphaned temp dirs cleaned and requeued on boot |
| Wrong naming template applied to 400 games | Live preview in Settings before applying; `KEEP_ARCHIVE=true` makes re-organizing free |
| **CHD conversion silently truncates** | `chdman verify` on every output *before* the source is deleted; failed verify keeps the source and flags the item |
| CHD conversion fails on an odd image | Falls back to the plain extracted layout with a per-item warning — never a hard failure |
| Re-downloading something already owned | Duplicate badges on every review candidate (§6.1); owned-only items collapsed behind a summary row |
| **SQLite corrupted on a network share** | `DATABASE_PATH` is a local named volume by design; boot warns if it resolves to a network mount (§9.6b) |
| NAS permission mismatch | `PUID`/`PGID`/`UMASK`, plus a startup writability preflight on every configured path — fails at boot, not after a 4 GB download |
| NAS not mounted when Docker starts | Documented: Docker will happily create the directory on local disk and download into it — mount-order guard noted in §9.6b |
| Native module / arch mismatch | **Eliminated** by `node:sqlite` |
| Vimm renames a system / adds a console | Runtime-loadable source registry — config edit, no rebuild |
| Platform markup differs per console | 18 slugs inherited from gamarr's working driver; still spot-check two non-PS2 platforms in Phase 3 |

---

## 12. Open questions

1. ~~Which platforms beyond PS2?~~ **Resolved** — 18 slugs adopted from gamarr's registry (§1.1). Ship them all; PS2 is just the default selection.
2. ~~Region default~~ **Resolved** — first-class ordered preference with global, per-job and per-item scope (§4.2), asked explicitly in the first-run wizard (§6.0) with no silent fallback.
3. ~~Duplicate handling on re-import~~ **Resolved** — inline "already in library" badges on each candidate, with the three states and confirm-anyway behaviour in §6.1.
4. ~~Auth~~ **Resolved** — none. The server binds to `127.0.0.1` by default so a stray `docker run` doesn't expose it to the LAN; put it behind a reverse proxy if you ever want remote access.
5. ~~Concurrency default~~ **Resolved** — serial by construction, no setting (§8.0).
6. ~~Post-download handling~~ **Resolved** — full organize stage into a separate, independently mounted library volume (§9).
7. ~~`.chd` conversion~~ **Resolved** — included, on by default for disc platforms, `mame-tools` in the image (§9.5b).
8. ~~Front-end target~~ **Resolved** — no longer a question that needs an answer up front. `PLATFORM_FOLDER_STYLE` ships verified `esde` and `batocera` presets plus a `PLATFORM_FOLDER_MAP` override, all set in `docker-compose.yml`, and switching later triggers an in-place re-path migration rather than a re-download (§9.2b). Default stays `slug`; set it to match whatever you end up running.

---

*No open questions remain. The plan is ready to build against.*

---

## 13. Documentation deliverables

Docs are a shipped artifact, not an afterthought — a self-hosted tool that someone deploys once and returns to in six months lives or dies on its README. The plan is the design record; the README is the operator's manual, and they are not the same document.

### 13.1 `README.md` structure

```
1  What it is                  — three sentences + a screenshot of the Review screen
2  What it is not              — not a downloader-first tool; links to gamarr
3  Quick start                 — one compose block, up and running in under a minute
4  Configuration reference     — every env var, in a table (§13.2)
5  Deployment
     5.1 Docker / docker compose
     5.2 NAS + Portainer         ← §9.6b, near-verbatim
6  How matching works          — tier cascade, aliases, why review exists
7  Library layout              — naming, folder styles, CHD, worked examples
8  Why downloads are serial    — §8.0, stated plainly (§13.3)
9  Troubleshooting             — §13.4
10 Credits & licences          — §14
```

**Sections 5.2, 8 and 9 are the ones that matter most** and are the easiest to skimp on. Everything else a reader can infer from the UI.

### 13.2 Configuration reference

One table, every variable, four columns: **Variable · Default · Description · Notes**. Rules for it:

- Every variable in `docker-compose.yml` appears here — a setting that exists but isn't documented is a bug report waiting to happen
- Grouped by concern: paths, catalogue, matching, resolver, downloads, organizing, permissions
- The "Notes" column carries the non-obvious consequence, not a restatement of the name. `WORK_PATH` gets *"on a NAS, moving this to local disk speeds up CHD conversion but makes the final move a copy instead of a rename"*, not *"the work path"*
- `.env.example` ships as an executable mirror of this table, with the same comments inline

### 13.3 Document the decisions, not just the settings

Two things need a stated *why*, or they'll be undone by the next person to read the code — possibly you, having forgotten:

**Why there's no concurrency setting.** §8.0 goes into the README close to verbatim: the site operator's stated one-at-a-time rule, vl-downloader's author's request, and the reasoning that a knob existing only to be turned up is worse than no knob. Without this, the absence reads as an oversight and someone adds it back in a PR. With it, the absence is a decision.

**Why the database can't live on the NAS.** The failure is silent corruption, not a startup error, so a user moving `DATABASE_PATH` to their share to "keep everything together" is a completely reasonable-looking action with a bad outcome. This gets a callout box in the deployment section, not a footnote.

Same treatment, more briefly, for extract-policy defaulting to `disc-only` and for the LLM never emitting URLs.

### 13.4 Troubleshooting

Written as symptom → cause → fix, because that's how someone arrives at it:

| Symptom | Likely cause |
|---|---|
| `EACCES` after a download completes | `PUID`/`PGID` don't match the mount owner (§9.6b) |
| Front-end shows an empty system | `PLATFORM_FOLDER_STYLE` mismatch (§9.2b) |
| Games downloaded to local disk, NAS empty | NAS mounted after Docker started (§9.6b) |
| `database disk image is malformed` | `DATABASE_PATH` on a network share (§9.6b) |
| Game won't boot after organizing | `.cue` rewriting — the case §9.4 exists to prevent; file a bug with the cue |
| Catalogue sync returns zero rows | Vimm markup changed; parser fixtures need updating (§1.1) |
| Everything lands in review | Catalogue stale, or region preference matches nothing |

### 13.5 Other documents

| File | Contents |
|---|---|
| `.env.example` | Every variable, commented, safe defaults |
| `THIRD_PARTY_LICENSES.md` | MIT texts for vl-downloader and any bundled dependency requiring attribution |
| `docs/naming.md` | Template tokens, folder-style preset tables, worked before/after examples |
| `docs/development.md` | Local setup, running the parser fixture tests, adding a platform |
| `CHANGELOG.md` | Keep a Changelog format from the first release |

### 13.6 Build-order placement

Documentation is **phase 12**, but written incrementally: each phase updates the config table and any decision it settles, while the phase is fresh. Deferring all of it to the end is how the "why" gets lost — by then the reasoning is reconstructed rather than recorded.

---

## 14. References

This project builds directly on three sources. Each is credited in the README, and each MIT-licensed project's licence is reproduced in `THIRD_PARTY_LICENSES.md`.

### [gamarr](https://github.com/JeremiahM37/gamarr) — JeremiahM37

Self-hosted game/ROM management platform in Go. **Used for:** the platform slug → Vimm `system` map (18 consoles, §1.1), the runtime-loadable source registry pattern with embedded fallback, the circuit-breaker source-health model, the anchor-regex parse as our fallback path, and the shape of the Vimm download form flow. **Deliberately not copied:** its disabled TLS verification.

### [vl-downloader](https://github.com/Raiper34/vl-downloader) — Raiper34 (MIT)

Self-hosted Vimm's Lair ROM downloader, NestJS + Angular. **Used for:** the download queue entity and status model, byte-level progress tracking, live progress push, and the mounted-downloads-volume deployment shape (§8.1). **Diverged:** we replace BullMQ + Redis with an in-process SQLite-backed worker to stay single-container.

> The author's README asks that the tool not be modified for bulk or simultaneous downloading, and that users not be aggressive toward the site. §8.0 explains how this plan honours that.

### [Vimm's Lair](https://vimm.net/) — the data source

Not a dependency but the thing this entire project points at. `robots.txt` permits crawling; the operator has [stated](https://vimm.net/bbs/?Post=20768) that downloads are one at a time. Our crawl budget is ~27 requests per platform per month, downloads are serial with a delay between files, and we identify ourselves honestly in the User-Agent.

---

*Scope note: this tool catalogues public page URLs and, in phase 9, retrieves files from them one at a time. Whether you have the right to any given ROM is yours to determine — vl-downloader's author makes the same request of his users, and it's a fair one.*
