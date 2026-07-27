/**
 * The organize worker (plan §9.5).
 *
 * Runs in the same serial pipeline as downloads: CHD conversion is CPU-bound and
 * does heavy I/O, so letting it run concurrently with a transfer would have them
 * competing for the same disk and link. One thing at a time, throughout.
 */
import type { DownloadItem } from '@vl-collection-builder/shared';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { recordFiles } from '../db/library.js';
import { getPlatform } from '../sources/load.js';
import { getDownload, listDownloads, setStatus } from '../download/queue.js';
import { cleanWorkDir, organize } from './pipeline.js';

let running = false;
let stopped = false;

export function isOrganizing(): boolean {
  return running;
}

async function processOne(item: DownloadItem): Promise<void> {
  if (!item.destPath) throw new Error('no downloaded file recorded for this item');

  const platform = await getPlatform(item.platform);
  if (!platform) throw new Error(`unknown platform '${item.platform}'`);

  // Prefer the catalogue's metadata: it is what the naming template is built
  // around, and it was captured at match time rather than guessed from a file.
  const meta = getDb()
    .prepare('SELECT name, region, version FROM game WHERE id = ?')
    .get(item.gameId ?? -1) as
    | { name: string; region: string | null; version: string | null }
    | undefined;

  const result = await organize({
    downloadId: item.id,
    gameId: item.gameId,
    platform,
    archivePath: item.destPath,
    title: meta?.name ?? item.title,
    region: meta?.region ?? null,
    version: meta?.version ?? null,
    vaultId: item.vaultId,
    disc: item.disc,
  });

  recordFiles(
    result.files.map((f) => ({ relPath: f.relPath, bytes: f.bytes, kind: f.kind })),
    { downloadId: item.id, gameId: item.gameId, platform: item.platform },
  );

  setStatus(item.id, 'organized', result.warnings.length ? result.warnings.join(' · ') : null);
}

async function loop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (stopped) return;
      const next = listDownloads('downloaded')[0];
      if (!next) return;

      setStatus(next.id, 'organizing');
      try {
        const fresh = getDownload(next.id);
        if (!fresh) continue;
        await processOne(fresh);
      } catch (err) {
        // Retryable by design: the staging archive is retained, so re-running
        // costs no bandwidth (plan §9.5).
        setStatus(next.id, 'organize_error', (err as Error).message);
      }
    }
  } finally {
    running = false;
  }
}

export function kickOrganizer(): void {
  if (!config.organizeEnabled || running || stopped) return;
  void loop();
}

export async function startOrganizer(log: (m: string) => void = console.log): Promise<void> {
  if (!config.organizeEnabled) {
    log('organizer: disabled (ORGANIZE_ENABLED=false) — downloads stop at the staging directory');
    return;
  }
  const cleaned = await cleanWorkDir();
  if (cleaned === -1) {
    log(
      'organizer: WORK_PATH is not a safe scratch directory (it is, or contains, LIBRARY_PATH or DOWNLOADS_PATH). Startup cleanup was SKIPPED to avoid deleting your library — point WORK_PATH at a subdirectory such as {LIBRARY_PATH}/.tmp.',
    );
  } else if (cleaned > 0) {
    log(`organizer: removed ${cleaned} orphaned work director(ies) left by an interrupted run`);
  }
  stopped = false;
  kickOrganizer();
}

export function stopOrganizer(): void {
  stopped = true;
}

/** Re-organize an already-downloaded item without re-downloading (plan §9.5). */
export function requeueForOrganize(id: number): boolean {
  const item = getDownload(id);
  if (!item) return false;
  if (!item.destPath) return false;
  setStatus(id, 'downloaded');
  kickOrganizer();
  return true;
}
