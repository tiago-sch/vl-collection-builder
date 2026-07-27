-- Phases 9-10: the download queue and the organized library.

CREATE TABLE download (
  id             INTEGER PRIMARY KEY,
  game_id        INTEGER REFERENCES game(id) ON DELETE SET NULL,
  vault_id       INTEGER NOT NULL,
  vault_url      TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  platform       TEXT    NOT NULL,
  -- queued | active | paused | completed | error | cancelled
  -- plus the organizer's half of the lifecycle (plan §9.5):
  -- downloaded | organizing | organized | organize_error
  status         TEXT    NOT NULL DEFAULT 'queued',
  position       INTEGER NOT NULL DEFAULT 0,

  -- Media metadata, read from the vault page's embedded JSON.
  media_id       INTEGER,
  -- Which disc, for multi-disc releases. 1-based, from SortOrder.
  disc           INTEGER,
  disc_total     INTEGER,

  file_name      TEXT,
  dest_path      TEXT,
  total_bytes    INTEGER NOT NULL DEFAULT 0,
  received_bytes INTEGER NOT NULL DEFAULT 0,

  -- Checksums published on the vault page. Verifying against these is far
  -- stronger than the byte-count check the plan specified, and it is what makes
  -- Range resume safe to trust (see download/vimm.ts on the range quirk).
  expect_md5     TEXT,
  expect_sha1    TEXT,
  expect_crc32   TEXT,

  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  queued_at      TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);

-- The plan wrote this as an inline `UNIQUE (vault_id, status) WHERE ...`, which
-- SQLite rejects — a table constraint cannot carry a WHERE clause. A partial
-- unique index is the valid form and has the intended effect: one in-flight
-- download per media item, while completed and cancelled rows may accumulate.
CREATE UNIQUE INDEX idx_download_inflight
  ON download (vault_id, COALESCE(media_id, -1))
  WHERE status IN ('queued', 'active', 'paused', 'downloaded', 'organizing');

CREATE INDEX idx_download_queue ON download (status, position);

-- Every file the organizer produced, so the library can show what is on disk
-- and a re-path migration can move things without re-downloading (plan §9.2b).
CREATE TABLE library_file (
  id           INTEGER PRIMARY KEY,
  download_id  INTEGER REFERENCES download(id) ON DELETE SET NULL,
  game_id      INTEGER REFERENCES game(id) ON DELETE SET NULL,
  platform     TEXT    NOT NULL,
  rel_path     TEXT    NOT NULL,        -- relative to LIBRARY_PATH
  bytes        INTEGER,
  kind         TEXT,                    -- rom | iso | chd | cue | bin | m3u | archive
  created_at   TEXT    NOT NULL,
  UNIQUE (platform, rel_path)
);
CREATE INDEX idx_library_file_game ON library_file (game_id);
