# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Name resolution.** Paste a list of game names, get Vault URLs. The whole
  platform catalogue is mirrored locally, then matched against in memory.
- **Four-tier matching cascade** — learned alias, exact, fuzzy with a margin
  rule, then you. Each tier only sees what the tier above could not settle, and
  every tier is local: no API keys, no network calls beyond the source site.
- **Region as policy.** An ordered preference list applied deterministically,
  with a bonus mathematically capped below the tier-2 margin so it breaks ties
  but never promotes a worse title match. Settable globally, per import and per
  item; the first-run wizard requires an explicit choice.
- **Learned aliases.** Every review confirmation is remembered, so repeat inputs
  resolve instantly and for free.
- **Download queue.** Serial by construction, with `.part` resume, checksum
  verification against the values published on the vault page, crash recovery,
  and SSE progress.
- **Library organizer.** Zip-slip-safe extraction, No-Intro naming, `.cue`/`.gdi`
  rewriting, CHD conversion with verify-before-delete, `.m3u` playlists for
  multi-disc sets, and an atomic move into the library.
- **Startup preflight** verifying every configured path is writable, reporting
  free space, and warning if the database looks like it is on a network mount.
- `npm run eval` — replays confirmed matches through the matcher to measure
  match quality against real ground truth.
- Docker image with `chdman` included; three independently mountable volumes.
- **Nintendo 3DS** platform (slug `n3ds`, Batocera folder `3ds`).

### Fixed

- Syncing a platform with an empty letter section (3DS has no "Q" titles)
  failed with `HTTP 404`. Vimm answers 404 for such a section instead of an
  empty page; it is now treated as empty and no longer counts toward the
  circuit breaker.

- Catalogue sync died with `HTTP 429` about twenty pages in. Vimm now
  rate-limits listing requests to roughly 20 per minute per IP and answers
  with `Retry-After: 60`; the fetcher retried in 2.4s, 4.8s and 9.6s, all
  inside the ban, then gave up. The default crawl delay is now 4s (about 10
  requests/minute) and a 429 is waited out for the advertised window, with the
  wait shown in the sync progress.

- Listing pages parsed with no region, version or rating after Vimm rewrote the
  honeypot style as `display:  none` (two spaces); the table strategy now
  matches the style with a regex, and versioned `/vault/<id>?v=1.0` rows are
  accepted.

### Notes on the source site

Behaviour discovered while building, all of which fails *silently* if ignored:

- Listing pages are **filtered by default** — four regions, newest version only,
  first disc only. Mirroring without overriding the filters returns 1,831 PS2
  games instead of 11,420, and 1,826 of them are USA.
- Listings **paginate at 200 rows**.
- Disc platforms are served as **`.7z`**, not `.zip`. An organizer that handles
  only zip copies them through untouched — no extraction, no CHD conversion.
- Every listing row carries a **hidden honeypot link** to `/vault/999999`.
- The download form declares `method="POST"` but is **submitted as GET**.
- **Range requests starting at offset 0 return the last bytes of the file**, not
  the first.
- The download host rejects non-browser User-Agents with `400`.

