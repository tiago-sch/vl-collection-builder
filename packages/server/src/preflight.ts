/**
 * Startup preflight (plan §9.6b, point 4).
 *
 * Verifies each configured path exists and is writable, reports free space, and
 * warns loudly if the database looks like it is on a network mount. Failing at
 * startup with a clear message beats failing after a 4 GB download — which is
 * exactly how the permissions case presents itself otherwise.
 */
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config, workPath } from './config.js';
import { freeDiskMb, isWritable } from './util/disk.js';
import { loadRegistry } from './sources/load.js';
import { parseFolderMap, validateFolderMap } from './organize/naming.js';
import { isSafeWorkDir } from './organize/pipeline.js';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

/**
 * Filesystem type numbers for the network filesystems SQLite cannot be trusted
 * on. Its locking depends on POSIX advisory locks, which are unreliable or
 * silently broken over NFS and CIFS; the documented failure mode is
 * `database disk image is malformed` — corruption, not a clean error.
 */
const NETWORK_FS_TYPES = new Map<number, string>([
  [0x6969, 'NFS'],
  [0xff534d42, 'CIFS/SMB'],
  [0x517b, 'SMB'],
  [0x73757245, 'CODA'],
  [0x01021997, 'V9FS'],
  [0xfe534d42, 'SMB2'],
]);

async function networkFsName(path: string): Promise<string | null> {
  try {
    const s = await statfs(path);
    return NETWORK_FS_TYPES.get(Number(s.type)) ?? null;
  } catch {
    return null;
  }
}

export async function preflight(): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // --- database ------------------------------------------------------------
  const dbDir = dirname(config.databasePath);
  if (!(await isWritable(dbDir))) {
    errors.push(
      `DATABASE_PATH directory is not writable: ${dbDir}. On a NAS this is usually PUID/PGID not matching the owner of the mount.`,
    );
  }
  const dbFs = await networkFsName(dbDir);
  if (dbFs) {
    // Deliberately loud. A user moving the database onto their share to "keep
    // everything together" is a reasonable-looking action with a bad outcome,
    // and the failure is silent corruption rather than a startup error.
    warnings.push(
      `DATABASE_PATH is on a ${dbFs} network mount (${dbDir}). SQLite's locking is unreliable there and the documented failure mode is silent corruption. Move it to a local named volume and back up by exporting instead.`,
    );
  }

  // --- downloads and library ----------------------------------------------
  if (config.downloadsEnabled) {
    if (!(await isWritable(config.downloadsPath))) {
      errors.push(`DOWNLOADS_PATH is not writable: ${config.downloadsPath}`);
    } else {
      const free = await freeDiskMb(config.downloadsPath);
      info.push(
        `downloads: ${config.downloadsPath}${free === null ? '' : ` (${(free / 1024).toFixed(1)} GB free)`}`,
      );
    }
  }

  if (config.organizeEnabled) {
    if (!(await isWritable(config.libraryPath))) {
      errors.push(`LIBRARY_PATH is not writable: ${config.libraryPath}`);
    } else {
      const free = await freeDiskMb(config.libraryPath);
      info.push(
        `library: ${config.libraryPath}${free === null ? '' : ` (${(free / 1024).toFixed(1)} GB free)`}`,
      );
    }

    const work = workPath();
    if (!(await isWritable(work))) {
      errors.push(`WORK_PATH is not writable: ${work}`);
    }

    // The work directory is emptied on every boot. If it is not a strict
    // subdirectory of the library or downloads root, that would delete real
    // data — so refuse to start rather than do it once and be asked why.
    if (!isSafeWorkDir(work, config.libraryPath, config.downloadsPath)) {
      errors.push(
        `WORK_PATH (${work}) is not a safe scratch directory: it is, or contains, LIBRARY_PATH (${config.libraryPath}) or DOWNLOADS_PATH (${config.downloadsPath}). This directory is emptied on every start, so using it would delete your library. Point it at a subdirectory such as ${config.libraryPath}/.tmp.`,
      );
    }

    // A work dir on a different filesystem turns the final atomic rename into a
    // cross-device copy. Supported, but the trade-off should be explicit.
    const workFs = await networkFsName(work);
    const libFs = await networkFsName(config.libraryPath);
    if (workFs !== libFs) {
      warnings.push(
        `WORK_PATH (${work}) and LIBRARY_PATH (${config.libraryPath}) look like different filesystems, so the final move will be a copy rather than an instant rename. That is a supported trade-off — it can be faster on a slow NAS link — but it is worth knowing.`,
      );
    }
  }

  // --- platform folder map -------------------------------------------------
  const { registry, warnings: registryWarnings } = await loadRegistry();
  warnings.push(...registryWarnings);
  warnings.push(
    ...validateFolderMap(
      parseFolderMap(config.platformFolderMap),
      registry.platforms.map((p) => p.slug),
    ),
  );

  // --- policy values -------------------------------------------------------
  if (!['disc-only', 'always', 'never'].includes(config.extractPolicy)) {
    warnings.push(`EXTRACT_POLICY='${config.extractPolicy}' is not recognised; treating it as disc-only`);
  }
  if (!['disc-only', 'never'].includes(config.chdPolicy)) {
    warnings.push(`CHD_POLICY='${config.chdPolicy}' is not recognised; treating it as disc-only`);
  }

  return { ok: errors.length === 0, errors, warnings, info };
}
