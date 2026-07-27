/** SQLite-backed download queue (plan §8.2). */
import type { DownloadItem, DownloadStatus } from '@vault-lookup/shared';
import { getDb, nowIso, transaction } from '../db/client.js';

interface DownloadRow {
  id: number;
  game_id: number | null;
  vault_id: number;
  vault_url: string;
  title: string;
  platform: string;
  status: DownloadStatus;
  position: number;
  media_id: number | null;
  disc: number | null;
  disc_total: number | null;
  file_name: string | null;
  dest_path: string | null;
  total_bytes: number;
  received_bytes: number;
  expect_md5: string | null;
  expect_sha1: string | null;
  expect_crc32: string | null;
  attempts: number;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toItem(r: DownloadRow): DownloadItem {
  return {
    id: r.id,
    gameId: r.game_id,
    vaultId: r.vault_id,
    vaultUrl: r.vault_url,
    title: r.title,
    platform: r.platform,
    status: r.status,
    position: r.position,
    mediaId: r.media_id,
    disc: r.disc,
    discTotal: r.disc_total,
    fileName: r.file_name,
    destPath: r.dest_path,
    totalBytes: r.total_bytes,
    receivedBytes: r.received_bytes,
    attempts: r.attempts,
    error: r.error,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export interface EnqueueInput {
  gameId?: number | null;
  vaultId: number;
  vaultUrl: string;
  title: string;
  platform: string;
}

/**
 * Add to the queue.
 *
 * The partial unique index on (vault_id, media_id) for in-flight statuses means
 * re-queueing something already downloading is a no-op rather than a duplicate.
 * media_id is unknown until the worker reads the vault page, so it starts null.
 */
export function enqueue(input: EnqueueInput): { id: number | null; duplicate: boolean } {
  const existing = getDb()
    .prepare(
      `SELECT id FROM download
        WHERE vault_id = ?
          AND status IN ('queued','active','paused','downloaded','organizing')`,
    )
    .get(input.vaultId) as { id: number } | undefined;

  if (existing) return { id: existing.id, duplicate: true };

  const next = getDb()
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM download WHERE status = 'queued'")
    .get() as { p: number };

  const info = getDb()
    .prepare(
      `INSERT INTO download (game_id, vault_id, vault_url, title, platform, status, position, queued_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      input.gameId ?? null,
      input.vaultId,
      input.vaultUrl,
      input.title,
      input.platform,
      next.p,
      nowIso(),
    );

  return { id: Number(info.lastInsertRowid), duplicate: false };
}

export function listDownloads(status?: DownloadStatus): DownloadItem[] {
  const stmt = status
    ? getDb().prepare('SELECT * FROM download WHERE status = ? ORDER BY position, id')
    : getDb().prepare('SELECT * FROM download ORDER BY position, id');
  const rows = (status ? stmt.all(status) : stmt.all()) as unknown as DownloadRow[];
  return rows.map(toItem);
}

export function getDownload(id: number): DownloadItem | null {
  const row = getDb().prepare('SELECT * FROM download WHERE id = ?').get(id) as
    | DownloadRow
    | undefined;
  return row ? toItem(row) : null;
}

/**
 * Claim the next queued item inside a transaction.
 *
 * Only one worker exists, but claiming atomically keeps the invariant true even
 * if that ever changes, and makes crash recovery unambiguous.
 */
export function claimNext(): DownloadItem | null {
  return transaction(() => {
    const row = getDb()
      .prepare("SELECT * FROM download WHERE status = 'queued' ORDER BY position, id LIMIT 1")
      .get() as DownloadRow | undefined;
    if (!row) return null;

    getDb()
      .prepare("UPDATE download SET status = 'active', started_at = ? WHERE id = ?")
      .run(nowIso(), row.id);

    return toItem({ ...row, status: 'active' });
  });
}

export function setStatus(id: number, status: DownloadStatus, error?: string | null): void {
  const finished = ['completed', 'error', 'cancelled', 'organized'].includes(status);
  getDb()
    .prepare(
      `UPDATE download SET status = ?, error = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`,
    )
    .run(status, error ?? null, finished ? nowIso() : null, id);
}

/** Record what the vault page told us, before any bytes are transferred. */
export function setMediaInfo(
  id: number,
  info: {
    mediaId: number;
    disc: number | null;
    discTotal: number | null;
    fileName: string | null;
    totalBytes: number;
    md5: string | null;
    sha1: string | null;
    crc32: string | null;
  },
): void {
  getDb()
    .prepare(
      `UPDATE download SET media_id = ?, disc = ?, disc_total = ?, file_name = ?,
              total_bytes = ?, expect_md5 = ?, expect_sha1 = ?, expect_crc32 = ?
        WHERE id = ?`,
    )
    .run(
      info.mediaId,
      info.disc,
      info.discTotal,
      info.fileName,
      info.totalBytes,
      info.md5,
      info.sha1,
      info.crc32,
      id,
    );
}

export function expectedChecksums(id: number): { md5: string | null; sha1: string | null } {
  const row = getDb()
    .prepare('SELECT expect_md5, expect_sha1 FROM download WHERE id = ?')
    .get(id) as { expect_md5: string | null; expect_sha1: string | null } | undefined;
  return { md5: row?.expect_md5 ?? null, sha1: row?.expect_sha1 ?? null };
}

/** Throttled by the worker to roughly once a second, not once per chunk. */
export function setProgress(id: number, receivedBytes: number, totalBytes?: number): void {
  if (totalBytes !== undefined) {
    getDb()
      .prepare('UPDATE download SET received_bytes = ?, total_bytes = ? WHERE id = ?')
      .run(receivedBytes, totalBytes, id);
  } else {
    getDb().prepare('UPDATE download SET received_bytes = ? WHERE id = ?').run(receivedBytes, id);
  }
}

export function setDestination(id: number, fileName: string, destPath: string): void {
  getDb()
    .prepare('UPDATE download SET file_name = ?, dest_path = ? WHERE id = ?')
    .run(fileName, destPath, id);
}

export function bumpAttempts(id: number): number {
  getDb().prepare('UPDATE download SET attempts = attempts + 1 WHERE id = ?').run(id);
  const row = getDb().prepare('SELECT attempts FROM download WHERE id = ?').get(id) as {
    attempts: number;
  };
  return row.attempts;
}

export function reorder(id: number, position: number): void {
  getDb().prepare('UPDATE download SET position = ? WHERE id = ?').run(position, id);
}

export function retry(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE download SET status = 'queued', attempts = 0, error = NULL, finished_at = NULL
        WHERE id = ? AND status IN ('error','cancelled','organize_error')`,
    )
    .run(id);
  return Number(info.changes) > 0;
}

export function remove(id: number): boolean {
  return Number(getDb().prepare('DELETE FROM download WHERE id = ?').run(id).changes) > 0;
}

/**
 * Crash recovery, run at boot (plan §8.2).
 *
 * Anything left `active` was interrupted mid-transfer, so it goes back to
 * `queued`. The `.part` file survives, so the next attempt resumes rather than
 * restarting — interrupting a 4 GB image should not cost you 4 GB. Rows stuck
 * in `organizing` are reset the same way for the organizer to redo.
 */
export function recoverInterrupted(): { downloads: number; organizing: number } {
  const d = getDb()
    .prepare("UPDATE download SET status = 'queued', started_at = NULL WHERE status = 'active'")
    .run();
  const o = getDb()
    .prepare("UPDATE download SET status = 'downloaded' WHERE status = 'organizing'")
    .run();
  return { downloads: Number(d.changes), organizing: Number(o.changes) };
}

export function queueStats(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM download GROUP BY status')
    .all() as unknown as Array<{ status: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}
