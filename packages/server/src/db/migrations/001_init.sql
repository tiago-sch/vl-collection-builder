-- Phases 1-7: catalogue mirror, matching, jobs and the saved library.
-- Download and organizer tables arrive in phases 8-9 as later migrations.

-- ---------------------------------------------------------------------------
-- Mirror of the remote catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE catalog_entry (
  id             INTEGER PRIMARY KEY,
  platform       TEXT    NOT NULL,          -- our slug: 'ps2'
  vault_id       INTEGER NOT NULL,
  title          TEXT    NOT NULL,
  title_norm     TEXT    NOT NULL,
  -- Primary region (first flag on the row).
  region         TEXT,
  -- Full flag list as a JSON array. Multi-region rows are real: the PS2 'S'
  -- listing has entries flagged USA+Canada, so a scalar column would lose data.
  regions        TEXT    NOT NULL DEFAULT '[]',
  version        TEXT,
  languages      TEXT,
  rating         REAL,
  url            TEXT    NOT NULL,
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL,
  UNIQUE (platform, vault_id)
);
CREATE INDEX idx_catalog_norm ON catalog_entry (platform, title_norm);
CREATE INDEX idx_catalog_platform ON catalog_entry (platform);

-- ---------------------------------------------------------------------------
-- Global config. setup_completed_at absent => first-run wizard is forced.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE catalog_sync (
  platform       TEXT PRIMARY KEY,
  last_synced_at TEXT,
  entry_count    INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'idle',  -- idle | running | error
  error          TEXT
);

-- Circuit-breaker state per source, adopted from gamarr (plan §1.1).
CREATE TABLE source_health (
  source           TEXT PRIMARY KEY,
  score            REAL    NOT NULL DEFAULT 100,
  failure_streak   INTEGER NOT NULL DEFAULT 0,
  circuit_open     INTEGER NOT NULL DEFAULT 0,
  circuit_opened_at TEXT,
  retry_after      TEXT,
  last_error       TEXT,
  total_requests   INTEGER NOT NULL DEFAULT 0,
  total_failures   INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Import runs
-- ---------------------------------------------------------------------------
CREATE TABLE job (
  id                INTEGER PRIMARY KEY,
  platform          TEXT NOT NULL,
  name              TEXT,
  region_preference TEXT,                   -- JSON array; null = global default
  strict_region     INTEGER NOT NULL DEFAULT 0,
  resolver_used     TEXT,                  -- dropped by 003; kept so the
                                          --   migration chain stays valid
  created_at        TEXT NOT NULL,
  status            TEXT NOT NULL           -- resolving | needs_review | complete
);
CREATE INDEX idx_job_created ON job (created_at DESC);

CREATE TABLE job_item (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  input_name    TEXT    NOT NULL,
  input_norm    TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  resolved_tier INTEGER,                    -- renumbered by 003
  chosen_entry  INTEGER REFERENCES catalog_entry(id) ON DELETE SET NULL,
  manual_url    TEXT,
  confidence    REAL,
  resolved_at   TEXT
);
CREATE INDEX idx_job_item_job ON job_item (job_id, position);
CREATE INDEX idx_job_item_status ON job_item (job_id, status);

CREATE TABLE match_candidate (
  id          INTEGER PRIMARY KEY,
  job_item_id INTEGER NOT NULL REFERENCES job_item(id) ON DELETE CASCADE,
  entry_id    INTEGER NOT NULL REFERENCES catalog_entry(id) ON DELETE CASCADE,
  score       REAL    NOT NULL,             -- after region bonus
  base_score  REAL    NOT NULL,             -- before region bonus, for debugging
  rank        INTEGER NOT NULL,
  llm_note    TEXT                          -- dropped by 003
);
CREATE INDEX idx_candidate_item ON match_candidate (job_item_id, rank);

-- ---------------------------------------------------------------------------
-- The deliverable. Denormalized on purpose: survives a catalogue re-sync.
-- ---------------------------------------------------------------------------
CREATE TABLE game (
  id            INTEGER PRIMARY KEY,
  platform      TEXT NOT NULL,
  name          TEXT NOT NULL,              -- canonical Vault title
  input_name    TEXT,                       -- what you originally typed
  vault_url     TEXT NOT NULL,
  vault_id      INTEGER,
  region        TEXT,
  version       TEXT,
  source_job    INTEGER REFERENCES job(id) ON DELETE SET NULL,
  resolved_tier INTEGER,
  added_at      TEXT NOT NULL,
  UNIQUE (platform, vault_id)
);
CREATE INDEX idx_game_platform ON game (platform, name);

-- Every review confirmation is ground truth. Storing it makes the tool need the
-- expensive tiers less over time, and doubles as the eval set (plan §4.3, §4.4).
CREATE TABLE learned_alias (
  id           INTEGER PRIMARY KEY,
  platform     TEXT    NOT NULL,
  input_norm   TEXT    NOT NULL,
  entry_id     INTEGER NOT NULL REFERENCES catalog_entry(id) ON DELETE CASCADE,
  vault_id     INTEGER NOT NULL,            -- survives a catalogue re-sync
  source       TEXT    NOT NULL,            -- user | static
  confirmed_at TEXT    NOT NULL,
  UNIQUE (platform, input_norm)
);
