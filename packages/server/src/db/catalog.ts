/** Data access for the mirrored catalogue. */
import type { CatalogEntry, CatalogSyncState, ParsedEntry, SyncStatus } from '@vl-collection-builder/shared';
import { getDb, nowIso, transaction } from './client.js';
import { normalizeTitle } from '../matching/normalize.js';

interface CatalogRow {
  id: number;
  platform: string;
  vault_id: number;
  title: string;
  title_norm: string;
  region: string | null;
  regions: string;
  version: string | null;
  languages: string | null;
  rating: number | null;
  url: string;
  first_seen_at: string;
  last_seen_at: string;
}

function toEntry(row: CatalogRow): CatalogEntry {
  let regions: string[] = [];
  try {
    const parsed = JSON.parse(row.regions);
    if (Array.isArray(parsed)) regions = parsed.filter((r): r is string => typeof r === 'string');
  } catch {
    regions = [];
  }
  return {
    id: row.id,
    platform: row.platform,
    vaultId: row.vault_id,
    title: row.title,
    titleNorm: row.title_norm,
    region: row.region,
    regions,
    version: row.version,
    languages: row.languages,
    rating: row.rating,
    url: row.url,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Upsert a page of parsed entries.
 *
 * last_seen_at is refreshed on every sync so a future prune can spot entries the
 * site has dropped; first_seen_at is preserved.
 */
export function upsertEntries(
  platform: string,
  baseUrl: string,
  entries: ParsedEntry[],
): { inserted: number; updated: number } {
  if (entries.length === 0) return { inserted: 0, updated: 0 };

  const db = getDb();
  const ts = nowIso();

  const existing = db.prepare('SELECT vault_id FROM catalog_entry WHERE platform = ? AND vault_id = ?');
  const insert = db.prepare(
    `INSERT INTO catalog_entry
       (platform, vault_id, title, title_norm, region, regions, version, languages, rating, url, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (platform, vault_id) DO UPDATE SET
       title      = excluded.title,
       title_norm = excluded.title_norm,
       region     = excluded.region,
       regions    = excluded.regions,
       version    = excluded.version,
       languages  = excluded.languages,
       rating     = excluded.rating,
       url        = excluded.url,
       last_seen_at = excluded.last_seen_at`,
  );

  let inserted = 0;
  let updated = 0;

  transaction(() => {
    for (const e of entries) {
      const isNew = existing.get(platform, e.vaultId) === undefined;
      insert.run(
        platform,
        e.vaultId,
        e.title,
        normalizeTitle(e.title),
        e.regions[0] ?? null,
        JSON.stringify(e.regions),
        e.version,
        e.languages,
        e.rating,
        `${baseUrl}/vault/${e.vaultId}`,
        ts,
        ts,
      );
      if (isNew) inserted += 1;
      else updated += 1;
    }
  });

  return { inserted, updated };
}

export function countEntries(platform: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM catalog_entry WHERE platform = ?')
    .get(platform) as { n: number };
  return row.n;
}

/** The whole platform catalogue, for in-memory scoring (11.8k rows is fine). */
export function allEntries(platform: string): CatalogEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM catalog_entry WHERE platform = ?')
    .all(platform) as unknown as CatalogRow[];
  return rows.map(toEntry);
}

export function entriesByNorm(platform: string, titleNorm: string): CatalogEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM catalog_entry WHERE platform = ? AND title_norm = ?')
    .all(platform, titleNorm) as unknown as CatalogRow[];
  return rows.map(toEntry);
}

export function entryById(id: number): CatalogEntry | null {
  const row = getDb().prepare('SELECT * FROM catalog_entry WHERE id = ?').get(id) as
    | CatalogRow
    | undefined;
  return row ? toEntry(row) : null;
}

export function entryByVaultId(platform: string, vaultId: number): CatalogEntry | null {
  const row = getDb()
    .prepare('SELECT * FROM catalog_entry WHERE platform = ? AND vault_id = ?')
    .get(platform, vaultId) as CatalogRow | undefined;
  return row ? toEntry(row) : null;
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

export function setSyncStatus(platform: string, status: SyncStatus, error?: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO catalog_sync (platform, status, error) VALUES (?, ?, ?)
       ON CONFLICT(platform) DO UPDATE SET status = excluded.status, error = excluded.error`,
    )
    .run(platform, status, error ?? null);
}

export function completeSync(platform: string, entryCount: number): void {
  getDb()
    .prepare(
      `INSERT INTO catalog_sync (platform, last_synced_at, entry_count, status, error)
       VALUES (?, ?, ?, 'idle', NULL)
       ON CONFLICT(platform) DO UPDATE SET
         last_synced_at = excluded.last_synced_at,
         entry_count    = excluded.entry_count,
         status         = 'idle',
         error          = NULL`,
    )
    .run(platform, nowIso(), entryCount);
}

export function getSyncState(platform: string, staleAfterDays: number): CatalogSyncState {
  const row = getDb().prepare('SELECT * FROM catalog_sync WHERE platform = ?').get(platform) as
    | {
        platform: string;
        last_synced_at: string | null;
        entry_count: number;
        status: SyncStatus;
        error: string | null;
      }
    | undefined;

  const lastSyncedAt = row?.last_synced_at ?? null;
  const ageDays =
    lastSyncedAt === null
      ? null
      : (Date.now() - Date.parse(lastSyncedAt)) / (1000 * 60 * 60 * 24);

  return {
    platform,
    lastSyncedAt,
    // Counted live rather than read from the cache, which is only written on a
    // successful completion. A cancelled or failed sync still persists every
    // page it did fetch, and reporting 0 for ~800 real rows is just wrong.
    entryCount: countEntries(platform),
    status: row?.status ?? 'idle',
    error: row?.error ?? null,
    ageDays,
    stale: ageDays === null || ageDays > staleAfterDays,
  };
}
