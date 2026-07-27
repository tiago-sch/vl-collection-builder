/** Data access for organized library files (plan §9.5). */
import type { LibraryFile } from '@vault-lookup/shared';
import { getDb, nowIso } from './client.js';

interface Row {
  id: number;
  download_id: number | null;
  game_id: number | null;
  platform: string;
  rel_path: string;
  bytes: number | null;
  kind: string | null;
  created_at: string;
}

const toFile = (r: Row): LibraryFile => ({
  id: r.id,
  downloadId: r.download_id,
  gameId: r.game_id,
  platform: r.platform,
  relPath: r.rel_path,
  bytes: r.bytes,
  kind: r.kind,
  createdAt: r.created_at,
});

export function recordFiles(
  files: Array<{ relPath: string; bytes: number; kind: string }>,
  ctx: { downloadId: number | null; gameId: number | null; platform: string },
): void {
  const stmt = getDb().prepare(
    `INSERT INTO library_file (download_id, game_id, platform, rel_path, bytes, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (platform, rel_path) DO UPDATE SET
       download_id = excluded.download_id,
       game_id     = excluded.game_id,
       bytes       = excluded.bytes,
       kind        = excluded.kind`,
  );
  const ts = nowIso();
  for (const f of files) {
    stmt.run(ctx.downloadId, ctx.gameId, ctx.platform, f.relPath, f.bytes, f.kind, ts);
  }
}

export function filesForGame(gameId: number): LibraryFile[] {
  const rows = getDb()
    .prepare('SELECT * FROM library_file WHERE game_id = ? ORDER BY rel_path')
    .all(gameId) as unknown as Row[];
  return rows.map(toFile);
}

export function allFiles(platform?: string): LibraryFile[] {
  const stmt = platform
    ? getDb().prepare('SELECT * FROM library_file WHERE platform = ? ORDER BY rel_path')
    : getDb().prepare('SELECT * FROM library_file ORDER BY platform, rel_path');
  const rows = (platform ? stmt.all(platform) : stmt.all()) as unknown as Row[];
  return rows.map(toFile);
}

/** vault_ids whose files are actually present, for the review queue's badges. */
export function gameIdsWithFiles(): Set<number> {
  const rows = getDb()
    .prepare('SELECT DISTINCT game_id FROM library_file WHERE game_id IS NOT NULL')
    .all() as unknown as Array<{ game_id: number }>;
  return new Set(rows.map((r) => r.game_id));
}

export function deleteFilesForDownload(downloadId: number): void {
  getDb().prepare('DELETE FROM library_file WHERE download_id = ?').run(downloadId);
}
