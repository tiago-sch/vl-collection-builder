/** Data access for the saved library — the deliverable. */
import type { CatalogEntry, Game, MinimalGame, ResolvedTier } from '@vault-lookup/shared';
import { getDb, nowIso } from './client.js';

interface GameRow {
  id: number;
  platform: string;
  name: string;
  input_name: string | null;
  vault_url: string;
  vault_id: number | null;
  region: string | null;
  version: string | null;
  source_job: number | null;
  resolved_tier: number | null;
  added_at: string;
}

function toGame(r: GameRow): Game {
  return {
    id: r.id,
    platform: r.platform,
    name: r.name,
    inputName: r.input_name,
    vaultUrl: r.vault_url,
    vaultId: r.vault_id,
    region: r.region,
    version: r.version,
    sourceJob: r.source_job,
    resolvedTier: (r.resolved_tier as ResolvedTier) ?? null,
    addedAt: r.added_at,
  };
}

export interface AddGameInput {
  platform: string;
  entry?: CatalogEntry | null;
  manualUrl?: string | null;
  inputName: string;
  sourceJob: number | null;
  resolvedTier: ResolvedTier | null;
}

/**
 * Insert a confirmed game. UNIQUE (platform, vault_id) makes re-committing an
 * import idempotent rather than duplicating rows.
 */
export function addGame(input: AddGameInput): 'inserted' | 'existing' {
  const { entry, manualUrl } = input;
  const name = entry?.title ?? input.inputName;
  const url = entry?.url ?? manualUrl;
  if (!url) throw new Error('a game needs either a catalogue entry or a manual URL');

  const info = getDb()
    .prepare(
      `INSERT INTO game
         (platform, name, input_name, vault_url, vault_id, region, version, source_job, resolved_tier, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (platform, vault_id) DO NOTHING`,
    )
    .run(
      input.platform,
      name,
      input.inputName,
      url,
      entry?.vaultId ?? null,
      entry?.region ?? null,
      entry?.version ?? null,
      input.sourceJob,
      input.resolvedTier,
      nowIso(),
    );

  return Number(info.changes) > 0 ? 'inserted' : 'existing';
}

export function listGames(platform?: string): Game[] {
  const sql = platform
    ? 'SELECT * FROM game WHERE platform = ? ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM game ORDER BY platform, name COLLATE NOCASE';
  const stmt = getDb().prepare(sql);
  const rows = (platform ? stmt.all(platform) : stmt.all()) as unknown as GameRow[];
  return rows.map(toGame);
}

/** The shape asked for in plan §3. */
export function toMinimal(games: Game[]): MinimalGame[] {
  return games.map((g) => ({ name: g.name, vaultLink: g.vaultUrl }));
}

export function toCsv(games: Game[]): string {
  const escape = (v: string | number | null): string => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'platform,name,input_name,vault_url,vault_id,region,version,resolved_tier,added_at';
  const lines = games.map((g) =>
    [
      g.platform, g.name, g.inputName, g.vaultUrl, g.vaultId,
      g.region, g.version, g.resolvedTier, g.addedAt,
    ]
      .map(escape)
      .join(','),
  );
  return [header, ...lines].join('\n');
}

export function deleteGame(id: number): boolean {
  return Number(getDb().prepare('DELETE FROM game WHERE id = ?').run(id).changes) > 0;
}

/** vault_ids already in the library, for the review queue's duplicate badges. */
export function ownedVaultIds(platform: string): Set<number> {
  const rows = getDb()
    .prepare('SELECT vault_id FROM game WHERE platform = ? AND vault_id IS NOT NULL')
    .all(platform) as unknown as Array<{ vault_id: number }>;
  return new Set(rows.map((r) => r.vault_id));
}
