/**
 * The organize pipeline (plan §9.5).
 *
 *   precheck space -> extract to WORK_PATH -> rename per template
 *   -> rewrite .cue/.gdi references -> convert to CHD (verify, then discard
 *   source) -> generate .m3u -> atomic rename into the library -> record files
 *
 * Crash safety falls out of the atomic move: a crash mid-extract leaves an
 * orphaned work directory and an `organizing` row, both cleaned up on boot with
 * the staging archive still present, so nothing is re-downloaded.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { Platform } from '@vl-collection-builder/shared';
import { config, workPath } from '../config.js';
import { loadRegistry } from '../sources/load.js';
import { freeDiskMb } from '../util/disk.js';
import { convertToChd, shouldConvert, type ChdPolicy } from './chd.js';
import { isSidecar, rewriteSidecar, type RenameMap } from './cue.js';
import {
  extractZip,
  isAuxiliaryFile,
  isSupportedArchive,
  shouldExtract,
  uncompressedSize,
  type ExtractPolicy,
} from './extract.js';
import { buildM3u, discNumber, playlistCandidates } from './m3u.js';
import { parseFolderMap, platformFolder, renderTemplate, sanitizeSegment } from './naming.js';

export interface OrganizeInput {
  downloadId: number;
  /**
   * Overrides EXTRACT_POLICY for this one item. Used by "unzip" on an already
   * organized file: the policy correctly leaves cartridge ROMs zipped, but the
   * point of the button is to ask for the exception.
   */
  forceExtract?: boolean;
  /** Work-directory key. Defaults to the download id; library jobs pass their own. */
  workKey?: string;
  /** SHA1 of the ROM as published on the vault page, if known. */
  expectSha1?: string | null;
  expectMd5?: string | null;
  gameId: number | null;
  platform: Platform;
  archivePath: string;
  title: string;
  region: string | null;
  version: string | null;
  vaultId: number | null;
  disc: number | null;
}

export interface OrganizedFile {
  absPath: string;
  relPath: string;
  bytes: number;
  kind: string;
}

export interface OrganizeResult {
  files: OrganizedFile[];
  destDir: string;
  warnings: string[];
  chdConverted: boolean;
}

function kindOf(fileName: string): string {
  const ext = extname(fileName).toLowerCase().replace('.', '');
  if (ext === 'chd') return 'chd';
  if (['iso', 'img'].includes(ext)) return 'iso';
  if (['cue', 'gdi', 'ccd', 'sub'].includes(ext)) return 'cue';
  if (ext === 'bin') return 'bin';
  if (ext === 'm3u') return 'm3u';
  if (['zip', '7z', 'rar'].includes(ext)) return 'archive';
  return 'rom';
}

async function hashFile(path: string, algo: 'md5' | 'sha1'): Promise<string> {
  const hash = createHash(algo);
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Organize one downloaded archive into the library.
 *
 * Everything happens under a per-item work directory and is moved into place at
 * the very end, so the library never contains a partial result.
 */
export async function organize(input: OrganizeInput): Promise<OrganizeResult> {
  const { registry } = await loadRegistry();
  const warnings: string[] = [];

  const folderMap = parseFolderMap(config.platformFolderMap);
  const { folder } = platformFolder(
    input.platform.slug,
    config.platformFolderStyle,
    folderMap,
    registry,
  );

  const baseName = renderTemplate(config.namingTemplate, {
    title: input.title,
    region: input.region,
    version: input.version,
    platform: input.platform.slug,
    vaultId: input.vaultId,
    disc: input.disc,
  });

  const work = join(workPath(), input.workKey ?? String(input.downloadId));
  const libraryRoot = join(config.libraryPath, folder);

  // Clean any leftovers from a previous interrupted attempt.
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  try {
    const archiveIsZip = isSupportedArchive(input.archivePath);
    const extract =
      input.forceExtract === true ||
      shouldExtract(config.extractPolicy as ExtractPolicy, input.platform.discBased);

    // --- 1. space precheck -------------------------------------------------
    // Extraction needs archive + extracted size available at the same time;
    // disc images roughly double.
    if (extract && archiveIsZip) {
      const needBytes = await uncompressedSize(input.archivePath);
      const needMb = Math.ceil(needBytes / (1024 * 1024)) + config.organizeMinFreeDiskMb;
      const free = await freeDiskMb(workPath());
      if (free !== null && free < needMb) {
        throw new Error(
          `not enough space to organize: ${free} MB free, ${needMb} MB needed (extracted size + headroom)`,
        );
      }
    }

    // --- 2. extract or copy ------------------------------------------------
    let workFiles: string[] = [];
    if (extract && archiveIsZip) {
      const result = await extractZip(input.archivePath, work);
      workFiles = result.files;
    } else {
      if (extract && !archiveIsZip) {
        warnings.push(
          `${basename(input.archivePath)} is not a .zip; copied across without extracting (7z/rar would need p7zip in the image)`,
        );
      }
      const target = join(work, sanitizeSegment(basename(input.archivePath)));
      await copyFile(input.archivePath, target);
      workFiles = [target];
    }

    if (workFiles.length === 0) throw new Error('the archive produced no files');

    // --- 2b. drop what is not game content ---------------------------------
    // Every Vimm archive ships a `Vimm's Lair.txt`. Keeping it would rename a
    // readme after the game, and — because the archive then looks multi-file —
    // push every single-ROM download into its own subfolder.
    const auxiliary = workFiles.filter((f) => isAuxiliaryFile(basename(f)));
    for (const f of auxiliary) await unlink(f).catch(() => undefined);
    workFiles = workFiles.filter((f) => !isAuxiliaryFile(basename(f)));
    if (workFiles.length === 0) throw new Error('the archive contained no game files');

    // --- 2c. verify the extracted ROM --------------------------------------
    // The published checksums describe the ROM, not the archive, so they can
    // only be checked once the ROM exists on its own. Cartridge systems are
    // deliberately left zipped (EXTRACT_POLICY=disc-only), and hashing the
    // archive there would compare a .zip against the ROM's checksum and fail
    // every time. Those downloads are verified by CRC32 at download time
    // instead — see download/worker.ts.
    const extractedForVerification = extract && archiveIsZip;
    if (extractedForVerification && (input.expectSha1 || input.expectMd5) && workFiles.length === 1) {
      const algo = input.expectSha1 ? 'sha1' : 'md5';
      const want = (input.expectSha1 ?? input.expectMd5)!.toLowerCase();
      const got = await hashFile(workFiles[0]!, algo);
      if (got !== want) {
        throw new Error(
          `${algo} mismatch on the extracted ROM (expected ${want}, got ${got}) — the download is corrupt; retry it`,
        );
      }
    }

    // --- 3. rename per template, and rewrite sidecars ----------------------
    //
    // Multi-TRACK is not multi-DISC, and conflating them destroys the image.
    // A CD rip is commonly `Track 01.bin` + `Track 02.bin` + one `.cue`: those
    // are two tracks of ONE disc, so naming both after the game collapses them
    // onto a single filename and the second silently overwrites the first.
    // Files are disambiguated per extension group:
    //   - a disc marker in the name  -> `(Disc N)`
    //   - several files sharing an extension -> `(Track N)`
    //   - otherwise the bare template name
    const renames: RenameMap = {};
    const byExtension = new Map<string, string[]>();
    for (const file of workFiles) {
      const ext = extname(basename(file)).toLowerCase();
      byExtension.set(ext, [...(byExtension.get(ext) ?? []), basename(file)]);
    }

    for (const file of workFiles) {
      const oldName = basename(file);
      const ext = extname(oldName);
      const group = (byExtension.get(ext.toLowerCase()) ?? []).slice().sort();

      // A disc marker in the extracted filename wins over the queue row: the
      // archive is the authority on which disc this actually is.
      const disc = discNumber(oldName) ?? (group.length > 1 ? null : input.disc);

      let suffix = '';
      if (disc !== null) {
        suffix = ` (Disc ${disc})`;
      } else if (group.length > 1) {
        // Prefer the track number the ripper wrote; fall back to position so the
        // result is still stable and unique.
        const fromName = /track\s*0*(\d+)/i.exec(oldName)?.[1];
        const track = fromName ? Number(fromName) : group.indexOf(oldName) + 1;
        suffix = ` (Track ${track})`;
      }

      const newName = `${sanitizeSegment(`${baseName}${suffix}`)}${ext}`;
      if (newName !== oldName) renames[oldName] = newName;
    }

    // Renaming two files onto one name would destroy data. If it somehow still
    // collides, stop rather than overwrite.
    const targets = new Set<string>();
    for (const newName of Object.values(renames)) {
      if (targets.has(newName)) {
        throw new Error(
          `naming collision: two files would both become '${newName}' — refusing to overwrite`,
        );
      }
      targets.add(newName);
    }

    for (const [oldName, newName] of Object.entries(renames)) {
      await rename(join(work, oldName), join(work, newName)).catch(() => undefined);
    }

    // Rewrite BEFORE anything else reads these files. A .cue pointing at a
    // renamed .bin is the failure mode with no error message.
    if (config.rewriteCuePaths) {
      const current = await readdir(work);
      for (const name of current.filter(isSidecar)) {
        const path = join(work, name);
        const { readFile } = await import('node:fs/promises');
        const body = await readFile(path, 'utf8');
        const rewritten = rewriteSidecar(name, body, renames);
        if (rewritten !== body) await writeFile(path, rewritten, 'utf8');
      }
    }

    // --- 4. CHD conversion -------------------------------------------------
    let chdConverted = false;
    if (shouldConvert(config.chdPolicy as ChdPolicy, input.platform.discBased)) {
      const current = await readdir(work);
      // Prefer the cue as input: it describes the whole track layout.
      const inputs = current.filter((f) => /\.(cue|gdi)$/i.test(f));
      const isos = current.filter((f) => /\.(iso|img)$/i.test(f));
      const targets = inputs.length > 0 ? inputs : isos;

      for (const name of targets) {
        const src = join(work, name);
        const out = join(work, `${name.replace(/\.[^.]+$/, '')}.chd`);
        const result = await convertToChd(src, out, { keepSource: config.chdKeepSource });

        if (!result.ok) {
          // Never a hard failure: fall back to the plain extracted layout.
          warnings.push(`CHD conversion skipped for ${name}: ${result.reason}`);
          continue;
        }
        chdConverted = true;

        if (!config.chdKeepSource) {
          // Only now, after verify passed, is the source removed.
          const consumed = new Set<string>([name]);
          if (/\.(cue|gdi)$/i.test(name)) {
            const { readFile } = await import('node:fs/promises');
            const body = await readFile(src, 'utf8').catch(() => '');
            for (const ref of body.matchAll(/"([^"]+)"/g)) consumed.add(ref[1]!);
          }
          for (const f of consumed) await unlink(join(work, f)).catch(() => undefined);
        }
      }
    }

    // --- 5. m3u for multi-disc sets ---------------------------------------
    const afterConvert = await readdir(work);
    const playlist = playlistCandidates(afterConvert);
    if (config.generateM3u && playlist.length > 1) {
      await writeFile(join(work, `${baseName}.m3u`), buildM3u(playlist), 'utf8');
    }

    // --- 6. atomic move into the library ----------------------------------
    const finalFiles = await readdir(work);
    // Multi-file games get their own folder; single-file games stay flat.
    const useSubfolder = finalFiles.length > 1;
    const destDir = useSubfolder ? join(libraryRoot, baseName) : libraryRoot;

    await mkdir(libraryRoot, { recursive: true });

    if (useSubfolder) {
      await rm(destDir, { recursive: true, force: true });
      // Same filesystem by default (WORK_PATH lives inside LIBRARY_PATH), so
      // this is an instant rename rather than a copy.
      await rename(work, destDir).catch(async (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // Cross-device: WORK_PATH was moved to local disk, so copy instead.
        warnings.push(
          'WORK_PATH is on a different filesystem from LIBRARY_PATH, so the final move is a copy rather than a rename',
        );
        await mkdir(destDir, { recursive: true });
        for (const f of finalFiles) await copyFile(join(work, f), join(destDir, f));
        await rm(work, { recursive: true, force: true });
      });
    } else {
      await mkdir(destDir, { recursive: true });
      for (const f of finalFiles) {
        await rename(join(work, f), join(destDir, f)).catch(async (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          await copyFile(join(work, f), join(destDir, f));
        });
      }
      await rm(work, { recursive: true, force: true });
    }

    // --- 7. record what landed --------------------------------------------
    const produced = await readdir(destDir);
    const relevant = useSubfolder ? produced : produced.filter((f) => finalFiles.includes(f));
    const files: OrganizedFile[] = [];
    for (const name of relevant) {
      const abs = join(destDir, name);
      files.push({
        absPath: abs,
        relPath: abs.slice(resolve(config.libraryPath).length + 1),
        bytes: await sizeOf(abs),
        kind: kindOf(name),
      });
    }

    // --- 8. staging cleanup ------------------------------------------------
    if (!config.keepArchive) {
      await unlink(input.archivePath).catch(() => undefined);
    }

    return { files, destDir, warnings, chdConverted };
  } catch (err) {
    // Leave staging alone: the archive is still there, so a retry costs nothing
    // in bandwidth.
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Is this work directory safe to empty at boot?
 *
 * `cleanWorkDir` deletes everything inside WORK_PATH, which is correct for a
 * scratch directory and catastrophic for anything else. A single misconfigured
 * `WORK_PATH=/library` would erase an entire ROM library on the next restart,
 * silently and with no way back.
 *
 * So the directory must be a strict subdirectory of the library or downloads
 * root — never equal to one of them, and never a parent of one.
 */
export function isSafeWorkDir(work: string, library: string, downloads: string): boolean {
  const w = resolve(work);
  const protectedRoots = [resolve(library), resolve(downloads)];

  for (const root of protectedRoots) {
    if (w === root) return false;
    // A work dir ABOVE a protected root would take it with it.
    if (root.startsWith(w + sep)) return false;
  }
  // Refuse anything suspiciously close to the filesystem root.
  if (w === sep || w.split(sep).filter(Boolean).length < 2) return false;

  return true;
}

/**
 * Remove orphaned work directories left by a crash (plan §9.5).
 *
 * Refuses to run if WORK_PATH is not a safe scratch location — see
 * `isSafeWorkDir`. Returns -1 in that case so the caller can warn loudly rather
 * than silently skipping cleanup.
 */
export async function cleanWorkDir(): Promise<number> {
  const root = workPath();
  if (!isSafeWorkDir(root, config.libraryPath, config.downloadsPath)) return -1;

  try {
    const entries = await readdir(root);
    for (const e of entries) await rm(join(root, e), { recursive: true, force: true });
    return entries.length;
  } catch {
    return 0;
  }
}
