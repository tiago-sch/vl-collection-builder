/**
 * On-demand extraction of files already in the library.
 *
 * `EXTRACT_POLICY=disc-only` correctly leaves cartridge ROMs zipped — RetroArch
 * and most emulators read them that way and the library is a fraction of the
 * size. But sometimes you want the raw file: a front-end that will not read
 * zips, a ROM hack to apply, a device that wants the bare cartridge dump.
 *
 * This re-runs the organizer with extraction forced, rather than being a bare
 * unzip, so the result still gets the naming template, the multi-file subfolder
 * rule, `.cue` rewriting and CHD conversion. Unzipping by hand and dropping the
 * files next to everything else is how a library stops being consistent.
 *
 * Serial by construction, like every other worker here: extraction is heavy I/O
 * and there is no reason for two to fight over the same disk.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { deleteFile, fileById, recordFiles } from '../db/library.js';
import { getPlatform } from '../sources/load.js';
import { describeError, errorContext } from '../util/errors.js';
import { isSupportedArchive } from './extract.js';
import { organize } from './pipeline.js';

export interface ExtractJobState {
  queued: number;
  done: number;
  failed: number;
  running: boolean;
  current: string | null;
  errors: { file: string; error: string }[];
}

const pending: number[] = [];
const state: ExtractJobState = {
  queued: 0,
  done: 0,
  failed: 0,
  running: false,
  current: null,
  errors: [],
};

export function getExtractState(): ExtractJobState {
  return { ...state, errors: [...state.errors] };
}

/** Which library files could usefully be extracted. */
export function isExtractable(kind: string | null, relPath: string): boolean {
  return kind === 'archive' && isSupportedArchive(relPath);
}

async function processOne(fileId: number): Promise<void> {
  const file = fileById(fileId);
  if (!file) throw new Error(`library file ${fileId} no longer exists`);
  if (!isExtractable(file.kind, file.relPath)) {
    throw new Error(`${file.relPath} is not a .zip or .7z that can be extracted`);
  }

  const abs = join(config.libraryPath, file.relPath);
  if (!existsSync(abs)) throw new Error(`${file.relPath} is recorded but missing from disk`);

  const platform = await getPlatform(file.platform);
  if (!platform) throw new Error(`unknown platform '${file.platform}'`);

  // Prefer the catalogue's metadata so the extracted file is named the same way
  // it would have been had it been extracted on arrival.
  const game = file.gameId
    ? (getDb()
        .prepare('SELECT name, region, version, vault_id FROM game WHERE id = ?')
        .get(file.gameId) as
        | { name: string; region: string | null; version: string | null; vault_id: number | null }
        | undefined)
    : undefined;

  // Falling back to the filename keeps files that arrived by raw vault URL
  // working — they have no game row to read from.
  const fallbackTitle = file.relPath.split('/').pop()!.replace(/\.(zip|7z)$/i, '');

  const result = await organize({
    downloadId: file.downloadId ?? 0,
    workKey: `lib-${file.id}`,
    forceExtract: true,
    gameId: file.gameId,
    platform,
    archivePath: abs,
    title: game?.name ?? fallbackTitle,
    region: game?.region ?? null,
    version: game?.version ?? null,
    vaultId: game?.vault_id ?? null,
    disc: null,
  });

  // The archive row is gone: organize consumed the file and produced new ones.
  // Recording first would leave a phantom row if this throws.
  deleteFile(file.id);
  recordFiles(
    result.files.map((f) => ({ relPath: f.relPath, bytes: f.bytes, kind: f.kind })),
    { downloadId: file.downloadId, gameId: file.gameId, platform: file.platform },
  );
}

async function loop(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    for (;;) {
      const id = pending.shift();
      if (id === undefined) return;

      const file = fileById(id);
      state.current = file?.relPath ?? `file ${id}`;
      try {
        await processOne(id);
        state.done += 1;
      } catch (err) {
        state.failed += 1;
        const detail = describeError(err);
        console.warn(`extract of library file ${id} failed: ${detail}`, errorContext(err));
        state.errors.push({ file: state.current, error: detail });
      } finally {
        state.queued = pending.length;
      }
    }
  } finally {
    state.running = false;
    state.current = null;
  }
}

/** Queue files for extraction. Returns how many were accepted. */
export function queueExtract(fileIds: number[]): { queued: number; skipped: string[] } {
  const skipped: string[] = [];
  let queued = 0;

  for (const id of fileIds) {
    const file = fileById(id);
    if (!file) {
      skipped.push(`file ${id} not found`);
      continue;
    }
    if (!isExtractable(file.kind, file.relPath)) {
      skipped.push(`${file.relPath} is not a .zip or .7z`);
      continue;
    }
    if (pending.includes(id)) continue;
    pending.push(id);
    queued += 1;
  }

  state.queued = pending.length;
  if (queued > 0) void loop();
  return { queued, skipped };
}

/** Clears the counters so a fresh run starts from zero in the UI. */
export function resetExtractState(): void {
  if (state.running) return;
  state.done = 0;
  state.failed = 0;
  state.errors = [];
}
