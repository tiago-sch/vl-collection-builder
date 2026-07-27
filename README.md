# VL Collection Builder

Paste a list of game names, pick a platform, and get back the Vimm's Lair Vault
page URL for each one. Ambiguous matches are confirmed by you in a
keyboard-driven review queue. Confirmed results are saved locally, exportable as
JSON or CSV, and can optionally be downloaded and organized into an
emulator-ready library.

Self-hosted, single container, single port, no external services. No API keys,
no cloud, nothing to sign up for.

The review queue, with a real ambiguous case — nine names in, eight resolved
automatically, one worth your attention:

```
 Review                                              [ Back to import ]
 8 of 9 settled · 1 left to review

 ( 2 alias )( 6 exact )( 0 fuzzy )( 0 you )        [ Save 8 to library ]
 ─────────────────────────────────────────────────────────────────────
 "Dragon Quest VIII"                                            1 of 1

 ▸ 1  Dragon Quest VIII Premium Eizou Disc            0.81  [ Confirm ]
      Asia/Japan · v1.01 · vault/67886
   2  Dragon Quest VIII: Journey of the Cursed King   0.79
      USA · v1.0 · 8.5 · vault/8203
   3  Dragon Quest VIII: Journey of the Cursed King   0.79
      USA · v1.01 · vault/67100
   4  Dragon Quest VIII: Sora to Umi to Daichi to …   0.68
      Asia/Japan · v1.02 · 8.5 · vault/68335
 ─────────────────────────────────────────────────────────────────────
 [1]–[9] select · [↑↓] move · [Enter] confirm · [S] skip · [U] paste URL
```

Note what the scores show: the Japanese bonus disc edges out the game you
actually want, 0.81 to 0.79, purely because its title is shorter. String
similarity cannot know better — but the margin between them is 0.02, well under
the threshold, so it refuses to auto-accept and asks. That is the design working.

## What it is

A **name resolver first**, a downloader second. The hard part of building a
collection is not fetching files; it is working out that `gta sa`, `biohazard 4`
and `Dragon Quest VIII` mean specific pages, and noticing when a title exists in
six regional variants that all look equally plausible.

## Quick start

```bash
docker compose up -d
```

Open <http://127.0.0.1:8080> and follow the first-run wizard: pick a platform,
sync its catalogue, and choose your region preference.

Local development:

```bash
npm install && npm run build && npm start
```

## How matching works

The whole platform catalogue is mirrored locally once, then your list is matched
against the local copy. For a 200-game list that is ~75 requests instead of 200+,
and it means full fuzzy scoring across every title rather than whatever the
site's search happens to return.

Each name runs down a cascade, and each tier only sees what the tier above could
not settle:

| Tier | Method | Cost |
|---|---|---|
| 0 | Learned or static alias | free, instant |
| 1 | Exact match after normalisation | free, instant |
| 2 | Fuzzy score above the threshold **with a margin** | free, instant |
| 3 | You | your attention |

**The margin rule is what makes this safe.** Two regional variants of one game
both score ~0.99, so the gap between them is ~0, so tier 2 refuses to
auto-accept and passes the item down. Over-eager matching is the expensive
failure: a wrong row in your library looks exactly like a right one, and you
would not notice for fifty games.

**Every confirmation is remembered.** Confirming `dragon quest viii` writes a
learned alias, so the same input resolves instantly next time. The tool needs
your attention less the more you use it — and the accumulated pairs are a real
labelled set, which `npm run eval` replays to measure whether a change to
matching actually helped.

### Region is a policy, not a guess

Region preference is an ordered list you set explicitly, applied
deterministically after title scoring and never delegated to fuzzy matching:

- The region bonus is **always smaller than the tier-2 margin**, so it breaks
  ties between equally good title matches but can never promote a worse one. The
  server clamps this — that is why a large "region bonus" in Settings shows a
  ceiling.
- When candidates differ *only* by region and your preferred region is present,
  it is taken automatically. This is the single biggest reduction in review
  volume.
- When your preferred region is **absent**, the item goes to review rather than
  quietly handing you a Japanese release.
- `Strict` excludes non-preferred regions from candidates entirely.

Settable globally, per import, and per item. **The first-run wizard will not let
you skip it**, and there is no silent default — defaulting to USA and quietly
mismatching a Japan-focused collection is the failure that screen exists to
prevent.

## Why downloads are serial

**There is no concurrency setting, and that absence is a decision.**

- Vimm's operator, asked directly on the site's own message board whether
  concurrent downloads were possible, [said you can only download one game at a
  time](https://vimm.net/bbs/?Post=20768).
- [vl-downloader](https://github.com/Raiper34/vl-downloader), whose queue model
  this is built on, is deliberately one-at-a-time, and its README asks readers
  not to modify it for bulk downloading. Crediting that project while shipping
  the one change its author asked people not to make would not hold together.

A `DOWNLOAD_CONCURRENCY` variable would be a standing invitation to raise it to a
value we have already agreed is wrong — it would move the decision out of this
document and into an env file where it gets changed without context. The worker
is a single loop by construction, not a pool sized to one.

`INTER_DOWNLOAD_DELAY_MS` (default 3s) spaces successive files. The serial design
is also *why* the rest is simple: no lock contention, no partial-file races, no
competing writes to the same `.part`.

## Library layout

Two directories, two jobs:

```
/downloads          staging. Raw archives as served. Disposable.
  ps2/
    Silent Hill 2 (USA).zip

/library            the organized output. Point emulators here.
  ps2/
    Silent Hill 2 (USA).chd
  psx/
    Final Fantasy VII (USA)/
      Final Fantasy VII (USA) (Disc 1).chd
      Final Fantasy VII (USA) (Disc 2).chd
      Final Fantasy VII (USA).m3u
  snes/
    Chrono Trigger (USA).zip        left zipped on purpose
```

Keeping them separate matters: staging can live on a fast scratch disk and be
pruned, while the library sits on bulk storage and is what you back up. It also
makes organizing re-runnable — change your naming template and re-organize from
staging without re-downloading.

**Cartridge ROMs stay zipped.** RetroArch and most cartridge emulators read
zipped ROMs natively, so a zipped SNES library is a fraction of the size and
works identically. Disc images must be extracted — no emulator mounts a 4 GB ISO
from inside a zip. That is what `EXTRACT_POLICY=disc-only` means.

**Disc images become `.chd`.** Typically 40–60% smaller with no data loss, read
natively by the major emulators. `chdman verify` runs on every output *before*
the source is deleted. See [docs/naming.md](docs/naming.md) for the full naming
rules, multi-disc handling and folder-style presets.

## Configuration

Every variable, with its default. [`.env.example`](.env.example) is an executable
mirror of this table.

### Paths

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_PATH` | `/data/vault.db` | **Keep on local disk.** See the callout below. |
| `DOWNLOADS_PATH` | `/downloads` | Staging. Disposable; can be a fast scratch disk. |
| `LIBRARY_PATH` | `/library` | Organized output. Can be a NAS mount. |
| `WORK_PATH` | `{LIBRARY_PATH}/.tmp` | Extract/convert scratch. Inside the library volume so the final move is an instant rename rather than a copy. On a slow NAS link, moving this to local disk can be faster overall — the trade-off is that the final move becomes a cross-device copy. |
| `WEB_ROOT` | *(set in image)* | Built client. Empty in dev, where Vite serves it. |

> **Do not put the database on a NAS.**
>
> SQLite's locking depends on POSIX advisory locks, which are unreliable or
> silently broken over NFS and CIFS. The documented failure mode is
> `database disk image is malformed` — **corruption, not a clean error**. Moving
> `DATABASE_PATH` onto your share to "keep everything together" is a completely
> reasonable-looking action with a bad outcome. It is small (tens of MB for a
> full multi-platform catalogue), so there is no storage argument for it. Back it
> up by exporting, not by relocating it. The container warns at startup if the
> path looks like a network mount.

### Server

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `127.0.0.1` | Loopback, so a stray `docker run` does not publish to your LAN. The image sets `0.0.0.0` because published ports need it; the compose file binds `127.0.0.1` on the host side instead. Put it behind a reverse proxy for remote access. |
| `LOG_LEVEL` | `info` | |

### Crawler

| Variable | Default | Notes |
|---|---|---|
| `CRAWL_DELAY_MS` | `1200` | One request per this many ms, single concurrency. A full PS2 sync is ~75 requests — about 7 minutes, once a month. |
| `USER_AGENT` | `vl-collection-builder/0.1 (personal catalogue tool)` | Honest and self-identifying. Used for all crawling. |
| `REQUEST_TIMEOUT_MS` | `30000` | |
| `CRAWL_MAX_RETRIES` | `3` | |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | Consecutive failures before the source is skipped entirely, so a site that is down produces one clear error instead of hundreds of timeouts. |
| `CIRCUIT_RESET_MS` | `300000` | How long until it retries. |

### Source registry

| Variable | Default | Notes |
|---|---|---|
| `SOURCES_PATH` | *(empty)* | Override the embedded platform registry from a file. |
| `SOURCES_URL` | *(empty)* | Or from a URL. |

Resolution order is `SOURCES_PATH` → `SOURCES_URL` → embedded defaults. A bad
override warns and falls back rather than blocking boot, so a typo in a mounted
file cannot take the container down.

### Setup

| Variable | Default | Notes |
|---|---|---|
| `REGION_PREFERENCE` | *(empty)* | e.g. `USA,Europe,Japan`. Pre-fills the wizard. Empty means the wizard asks and will not proceed until you choose. |
| `SETUP_SKIP` | `false` | `true` **and** a non-empty `REGION_PREFERENCE` completes setup unattended. On its own it does nothing, because guessing the region is the failure being prevented. |

### Downloads

| Variable | Default | Notes |
|---|---|---|
| `DOWNLOADS_ENABLED` | `true` | Set false to run as a pure lookup tool. |
| `INTER_DOWNLOAD_DELAY_MS` | `3000` | Deliberate pause between files. |
| `DOWNLOAD_RETRY_LIMIT` | `3` | |
| `DOWNLOAD_TIMEOUT_MS` | `0` | 0 = no timeout. ROMs are large. |
| `MIN_FREE_DISK_MB` | `2048` | Headroom required before starting a file. |
| `DOWNLOAD_USER_AGENT` | *(built-in browser UA)* | The download host rejects our honest crawler UA with `400`, even with a complete set of standard headers — the UA itself is the trigger. Crawling keeps the honest UA; only this endpoint uses a browser one. Set your own here if you prefer. |

Note the absence of a concurrency variable — see [Why downloads are
serial](#why-downloads-are-serial).

### Organizing

| Variable | Default | Notes |
|---|---|---|
| `ORGANIZE_ENABLED` | `true` | False reduces the tool to a plain downloader; files stop at staging. |
| `EXTRACT_POLICY` | `disc-only` | `disc-only` \| `always` \| `never`. Cartridge ROMs work fine zipped and are far smaller that way. |
| `KEEP_ARCHIVE` | `false` | True keeps staging archives, making re-organizing free. Worth it if you have the disk. |
| `NAMING_TEMPLATE` | `{title} ({region})` | See [docs/naming.md](docs/naming.md). Settings has a live preview. |
| `PLATFORM_FOLDER_STYLE` | `slug` | `slug` \| `esde` \| `batocera` \| `retroarch`. A mismatch is not a data error — the front-end just shows an empty system and the games look missing. |
| `PLATFORM_FOLDER_MAP` | *(empty)* | Per-platform overrides, e.g. `genesis=megadrive`. Layers on top of the preset. Unknown slugs are warned about and ignored. |
| `GENERATE_M3U` | `true` | Playlists for multi-disc sets, so emulators can swap discs. |
| `REWRITE_CUE_PATHS` | `true` | Rewrites `.cue`/`.gdi` internal references after renaming. Without it, renamed disc images silently fail to boot. |
| `CHD_POLICY` | `disc-only` | `disc-only` \| `never`. |
| `CHD_KEEP_SOURCE` | `false` | True keeps the extracted `.bin`/`.cue` alongside the `.chd`. |
| `ORGANIZE_MIN_FREE_DISK_MB` | `4096` | Extraction needs archive + extracted size at once; disc images roughly double. |

## Deployment

### Docker Compose

The shipped [`docker-compose.yml`](docker-compose.yml) mounts three volumes and
binds to loopback. Adjust the paths and run `docker compose up -d`.

### Portainer

CI publishes a multi-arch image to GHCR on every push to `main`, so Portainer
pulls a prebuilt image rather than building from source:

```
ghcr.io/tiago-sch/vl-collection-builder:latest
```

Built for `linux/amd64` and `linux/arm64`, so it runs on a normal server and on a
Synology or Raspberry Pi alike.

Paste [`docker-compose.portainer.yml`](docker-compose.portainer.yml) into
Portainer as a Stack (**Stacks → Add stack → Web editor**) and adjust the two NAS
paths and the `user:` line.

> **Before the first deploy:** a newly created GHCR package is **private**, and
> the pull will fail with `denied`. Either make it public once, under
> *Packages → vl-collection-builder → Package settings → Change visibility*, or
> add a registry in Portainer using a GitHub personal access token with the
> `read:packages` scope.

Available tags: `latest` (main), `sha-<short>` for a specific commit, and
`v1.2.3` / `v1.2` if you push a version tag.

### Upgrading

**Redeploying a new image does not touch your data.** The database, downloads and
library all live in volumes; the image contains only code. Verified by writing a
library entry and a learned alias, replacing the image, and confirming the
library, aliases, completed setup and region preference all survived.

Schema changes are handled by forward-only migrations applied automatically at
boot. They add; they do not drop.

Three things *will* lose data, and none of them are the upgrade itself:

- **Renaming the stack.** Compose namespaces named volumes by project name, so
  a stack named `vl-collection-builder` and one named `vlcb` produce
  `vl-collection-builder_vlcb-data` and `vlcb_vlcb-data` — two different
  volumes. Redeploying under a new stack name gives you an empty
  database that looks exactly like data loss. Keep the stack name stable.
- **`docker compose down -v`**, or ticking the volume-removal option when
  deleting a stack in Portainer. The `-v` is the whole difference.
- **Rolling back to an older image after a newer migration has run.** Migrations
  are forward-only; older code will not understand a newer schema. Export your
  library first if you plan to downgrade.

To update in Portainer: **Stacks → your stack → Update the stack**, with
*Re-pull image* ticked. To update with compose:

```bash
docker compose pull && docker compose up -d
```

If you build locally rather than pulling, `up -d` alone will **not** pick up code
changes — it only recreates when the compose file changes. Rebuild explicitly:

```bash
docker compose up -d --build
```

One transitional note for the v0.1 rename: `container_name` changed from
`vault-lookup` to `vl-collection-builder`, which leaves the old container behind
as an orphan still holding port 8080. Clear it once with
`docker compose up -d --build --remove-orphans`. Your data is unaffected — it is
in the volume, not the container.

Back up by exporting from the Library screen, or by copying the database out:

```bash
docker cp vl-collection-builder:/data/vault.db ./vault-backup.db
```

### NAS paths

All three paths are independent, and nothing has to live at the root of your
share.

**Recommended — subpath bind mounts.** Map the specific NAS subfolders on the
host side, so the container never sees the rest of the share:

```yaml
services:
  vl-collection-builder:
    image: vl-collection-builder:latest
    container_name: vl-collection-builder
    ports: ["127.0.0.1:8080:8080"]
    volumes:
      - vlcb-data:/data                # named volume — LOCAL, see below
      - /mnt/media/roms/.staging:/downloads    # NAS subfolder
      - /mnt/media/roms/library:/library       # NAS subfolder
    environment:
      DATABASE_PATH: /data/vault.db
      DOWNLOADS_PATH: /downloads
      LIBRARY_PATH: /library
      WORK_PATH: /library/.tmp
    # The image runs as uid/gid 1000 (the `node` user). If your share is owned
    # by a different uid, set it here rather than with PUID/PGID — this image
    # has no entrypoint that would apply those.
    user: "1000:1000"
    restart: unless-stopped

volumes:
  vlcb-data:
```

Mounting `/mnt/media:/media` whole and setting `DOWNLOADS_PATH=/media/roms/.staging`
also works and is supported. It is just strictly more exposure: a path bug then
has your entire NAS in reach rather than one folder.

**Four things that specifically bite on a NAS:**

1. **Keep the database off the share.** See the callout above — this is the one
   that causes real damage, and it is silent.
2. **Permissions.** The container runs as non-root — uid/gid **1000**, the
   `node` user. NAS mounts usually enforce a specific owner, so if yours is not
   1000, set Docker's `user:` directive to match: run `id -u` and `id -g` on the
   host for the account that owns the share.

   This image deliberately does **not** implement `PUID`/`PGID`. Those are a
   linuxserver.io convention requiring a root entrypoint that drops privileges,
   and setting them here would be silently ignored — which is worse than not
   offering them. Use `user:` instead.

   The symptom if this is wrong is `EACCES` on the first write, *after* a
   download has already completed, which is why the startup preflight checks
   writability before anything runs.
3. **`WORK_PATH` on a slow link.** CHD conversion is CPU-bound with heavy random
   I/O; running it against SMB can be dramatically slower than doing it locally
   and copying the result. If your NAS link is the bottleneck, mount a local
   scratch volume and point `WORK_PATH` at it. The trade-off is explicit: the
   final move becomes a cross-device copy instead of an instant rename. The
   startup preflight tells you which you are getting.
4. **Startup preflight.** On boot the container verifies each configured path
   exists and is writable, reports free space, and warns if `DATABASE_PATH` looks
   like a network mount. Failing at startup beats failing after a 4 GB download.

**Portainer specifics:** bind-mount paths resolve on the **Docker host**, not
inside the Portainer container — if `/mnt/media` is mounted on the host, use that
path directly. Deploy as a Stack by pasting the compose above. If the NAS mounts
*after* Docker starts on boot, add a mount-check dependency; otherwise Docker
will create an empty `/mnt/media/roms` on local disk and cheerfully download into
it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `EACCES` after a download completes | The container's uid (1000) does not own the mount — set Docker's `user:` directive |
| Front-end shows an empty system | `PLATFORM_FOLDER_STYLE` mismatch — see [docs/naming.md](docs/naming.md) |
| Games downloaded to local disk, NAS empty | NAS mounted after Docker started |
| `database disk image is malformed` | `DATABASE_PATH` on a network share |
| Game will not boot after organizing | A `.cue` pointing at a renamed file. This is what `REWRITE_CUE_PATHS` exists to prevent — please file a bug with the cue |
| Catalogue sync returns zero rows | Site markup changed; parser fixtures need updating |
| Catalogue synced but only ~1,800 games, all USA | The listing filters are not being applied — check `listFilters` in the source registry |
| Everything lands in review | Catalogue stale, or your region preference matches nothing |
| Downloads fail with `400` | The download host requires a browser User-Agent; check `DOWNLOAD_USER_AGENT` |
| CHD conversion always skipped | `chdman` missing from the image — Settings shows its status |

## Notes on the source site

Four behaviours shaped this implementation. They are documented because they are
invisible until they bite, and all of them fail *silently*.

**1. The listing view is filtered by default** — four regions checked, newest
version only, first disc only, no prototypes/demos/unlicensed/bonus. A crawler
that accepts those defaults mirrors 1,831 PS2 games instead of 11,420, and 1,826
of them are USA, which would quietly make region preference meaningless for
anyone with a non-US collection. The filter form is `method=GET`, so the fix is a
parameter set; it lives in `listFilters` in the source registry.

**2. Listings paginate at 200 rows.** Stopping at the first page of each letter
looks like a successful sync and gives you part of the catalogue.

**3. Every listing row carries a hidden honeypot link** —
`<a href="/vault/999999" style="display:none">9</a>`. A naive `/vault/(\d+)` scan
collects it first, yielding one bogus entry per row all colliding on the same
fake ID.

**4. Range requests starting at offset 0 return the wrong bytes** — the tail of
the file rather than the head, while `bytes=100-109` is correct. A resume that
sent `Range: bytes=0-` for an empty `.part` would silently produce a corrupt
archive. Downloads are additionally verified against the MD5/SHA1 published on
the vault page, so a bad transfer is caught rather than stored.

`robots.txt` permits crawling. We identify ourselves honestly for crawling, crawl
serially with a delay, download one file at a time, and open a circuit breaker
rather than hammering a failing server.

## Development

See [docs/development.md](docs/development.md).

```bash
npm test          # 134 tests, no network required
npm run typecheck
npm run eval      # measure match quality against your own confirmations
```

## Credits

Built on prior work — see [§14 of the plan](vl-collection-builder-plan.md) and
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

- **[gamarr](https://github.com/JeremiahM37/gamarr)** (JeremiahM37) — the
  platform slug → system map for 18 consoles, the runtime-loadable source
  registry with embedded fallback, and the circuit-breaker health model. Its
  disabled TLS verification is deliberately *not* copied.
- **[vl-downloader](https://github.com/Raiper34/vl-downloader)** (Raiper34, MIT)
  — the download queue and progress model. Its author asks that the tool not be
  modified for bulk downloading; downloads here are serial by construction.
- **[Vimm's Lair](https://vimm.net/)** — the data source.

## Licence

MIT — see [LICENSE](LICENSE).

Whether you have the right to any given ROM is yours to determine.
