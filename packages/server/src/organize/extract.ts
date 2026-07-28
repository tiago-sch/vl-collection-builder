/**
 * Archive extraction (plan §9.3, §9.4).
 *
 * ## Zip-slip
 *
 * An archive entry named `../../etc/something` escapes the extraction directory
 * in a naive implementation. Every entry path is resolved and verified to sit
 * inside the destination **before a single byte is written**, and an archive
 * containing any traversal entry is rejected whole rather than partially
 * extracted — a half-extracted malicious archive is still a compromised system.
 */
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import yauzl from 'yauzl';

const run = promisify(execFile);

export interface ExtractResult {
  files: string[];
  totalBytes: number;
}

export class UnsafeArchiveError extends Error {
  constructor(entry: string) {
    super(`archive rejected: entry '${entry}' would escape the extraction directory`);
    this.name = 'UnsafeArchiveError';
  }
}

/**
 * Is this entry path safe to write under `destRoot`?
 *
 * Exported because it is the security-critical predicate and deserves its own
 * tests independent of any actual archive.
 */
export function isSafeEntryPath(destRoot: string, entryPath: string): boolean {
  if (!entryPath || entryPath.startsWith('/') || /^[a-z]:[/\\]/i.test(entryPath)) return false;
  // Backslashes are legal in zip entry names on some writers and are separators
  // on Windows; normalise before deciding.
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.split('/').some((seg) => seg === '..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(entryPath)) return false;

  const root = resolve(destRoot);
  const full = resolve(root, normalized);
  return full === root || full.startsWith(root + sep);
}

/** One entry's metadata, read from the zip index without decompressing. */
export interface ZipEntryInfo {
  fileName: string;
  /** Stored CRC32, lower-case hex — comparable to Vimm's published GoodHash. */
  crc32: string;
  uncompressedSize: number;
}

/**
 * Read the zip index.
 *
 * The central directory carries each entry's CRC32, so the archive's contents
 * can be identified against a published checksum without decompressing a single
 * byte — which matters when the payload is a 4 GB disc image.
 */
export function zipEntries(zipPath: string): Promise<ZipEntryInfo[]> {
  return new Promise((res, rej) => {
    const out: ZipEntryInfo[] = [];
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return rej(err ?? new Error('could not open archive'));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith('/')) {
          out.push({
            fileName: entry.fileName,
            crc32: (entry.crc32 >>> 0).toString(16).padStart(8, '0'),
            uncompressedSize: entry.uncompressedSize,
          });
        }
        zip.readEntry();
      });
      zip.on('end', () => res(out));
      zip.on('error', rej);
      zip.readEntry();
    });
  });
}

/**
 * Files Vimm bundles alongside the ROM that are not game content.
 *
 * Every archive ships a `Vimm's Lair.txt`. Treating it as content would rename
 * it after the game, push every single-ROM download into a per-game subfolder
 * because the archive now looks multi-file, and record it in the library.
 */
export function isAuxiliaryFile(fileName: string): boolean {
  return /\.(txt|nfo|diz|url|sfv|md5|sha1|htm|html)$/i.test(fileName);
}

/** List entry names without extracting, so an archive can be vetted first. */
export function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((res, rej) => {
    const names: string[] = [];
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return rej(err ?? new Error('could not open archive'));
      zip.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => res(names));
      zip.on('error', rej);
      zip.readEntry();
    });
  });
}

/**
 * Extract a zip into `destDir`.
 *
 * Streams entry by entry, so a multi-gigabyte disc image never has to fit in
 * memory. The whole archive is vetted for traversal before extraction begins.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<ExtractResult> {
  // Vet first: reject the archive wholesale rather than partially extracting it.
  const entries = await listZipEntries(zipPath);
  for (const name of entries) {
    if (name.endsWith('/')) continue; // directory entry
    if (!isSafeEntryPath(destDir, name)) throw new UnsafeArchiveError(name);
  }

  await mkdir(destDir, { recursive: true });

  return await new Promise<ExtractResult>((res, rej) => {
    const files: string[] = [];
    let totalBytes = 0;

    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return rej(err ?? new Error('could not open archive'));

      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        // Checked above, but re-checked here so the guarantee holds even if this
        // function is ever called without the vetting pass.
        if (!isSafeEntryPath(destDir, entry.fileName)) {
          zip.close();
          rej(new UnsafeArchiveError(entry.fileName));
          return;
        }

        const outPath = resolve(destDir, entry.fileName.replace(/\\/g, '/'));
        zip.openReadStream(entry, (readErr, stream) => {
          if (readErr || !stream) {
            zip.close();
            rej(readErr ?? new Error(`could not read '${entry.fileName}'`));
            return;
          }
          void (async () => {
            try {
              await mkdir(dirname(outPath), { recursive: true });
              await pipeline(stream, createWriteStream(outPath));
              files.push(outPath);
              totalBytes += entry.uncompressedSize;
              zip.readEntry();
            } catch (writeErr) {
              zip.close();
              rej(writeErr);
            }
          })();
        });
      });

      zip.on('end', () => res({ files, totalBytes }));
      zip.on('error', rej);
      zip.readEntry();
    });
  });
}

/** Total uncompressed size, for the free-space precheck before extracting. */
export function uncompressedSize(zipPath: string): Promise<number> {
  return new Promise((res, rej) => {
    let total = 0;
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return rej(err ?? new Error('could not open archive'));
      zip.on('entry', (entry: yauzl.Entry) => {
        total += entry.uncompressedSize;
        zip.readEntry();
      });
      zip.on('end', () => res(total));
      zip.on('error', rej);
      zip.readEntry();
    });
  });
}

export type ExtractPolicy = 'disc-only' | 'always' | 'never';

/**
 * Should this platform's archives be extracted? (plan §9.3)
 *
 * Unzipping everything is the obvious default and it is wrong: RetroArch and
 * most cartridge emulators read zipped ROMs natively, so a zipped SNES library
 * is a fraction of the size and works identically. Disc images must be
 * extracted, because no emulator mounts a 4 GB ISO from inside a zip.
 */
export function shouldExtract(policy: ExtractPolicy, discBased: boolean): boolean {
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  return discBased;
}

export function isArchive(fileName: string): boolean {
  return /\.(zip|7z|rar)$/i.test(fileName);
}

export function is7z(fileName: string): boolean {
  return /\.7z$/i.test(fileName);
}

/**
 * Archives the organizer can actually open.
 *
 * Vimm serves disc platforms as .7z — 169 of 170 files in a real PS2 library —
 * so treating only .zip as supported meant every PS2 download was copied
 * through untouched: no extraction, no CHD conversion, and a library of raw
 * archives no emulator can read.
 */
export function isSupportedArchive(fileName: string): boolean {
  return /\.(zip|7z)$/i.test(fileName);
}

let sevenZipChecked: string | null | undefined;

/** Locate the 7z binary once. p7zip-full installs it as `7z`. */
export async function sevenZipBinary(): Promise<string | null> {
  if (sevenZipChecked !== undefined) return sevenZipChecked;
  for (const candidate of ['7z', '7za', '7zz']) {
    try {
      await run(candidate, ['i'], { timeout: 10_000 });
      sevenZipChecked = candidate;
      return candidate;
    } catch (err) {
      // Ran but exited non-zero still means it exists.
      if ((err as { code?: string }).code !== 'ENOENT') {
        sevenZipChecked = candidate;
        return candidate;
      }
    }
  }
  sevenZipChecked = null;
  return null;
}

/**
 * Read a 7z index via `7z l -slt`, which prints one block per entry.
 *
 * Same contract as zipEntries: names and CRCs without extracting, so a 2 GB
 * archive can be vetted and identified cheaply.
 */
export async function sevenZipEntries(archivePath: string): Promise<ZipEntryInfo[]> {
  const bin = await sevenZipBinary();
  if (!bin) throw new Error('7z is not installed in this image');

  const { stdout } = await run(bin, ['l', '-slt', '-ba', '--', archivePath], {
    maxBuffer: 32 * 1024 * 1024,
  });

  const entries: ZipEntryInfo[] = [];
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const path = /^Path = (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    const attributes = /^Attributes = (.+)$/m.exec(block)?.[1] ?? '';
    if (/^D/.test(attributes) || attributes.includes('D_')) continue; // directory
    entries.push({
      fileName: path,
      crc32: (/^CRC = ([0-9A-Fa-f]+)$/m.exec(block)?.[1] ?? '').toLowerCase().padStart(8, '0'),
      uncompressedSize: Number(/^Size = (\d+)$/m.exec(block)?.[1] ?? 0),
    });
  }
  return entries;
}

/** Extract a .7z, vetting every entry path first, exactly as extractZip does. */
export async function extract7z(archivePath: string, destDir: string): Promise<ExtractResult> {
  const bin = await sevenZipBinary();
  if (!bin) throw new Error('7z is not installed in this image');

  const entries = await sevenZipEntries(archivePath);
  for (const e of entries) {
    if (!isSafeEntryPath(destDir, e.fileName)) throw new UnsafeArchiveError(e.fileName);
  }

  await mkdir(destDir, { recursive: true });
  // `x` preserves paths; `e` would flatten them and collide multi-track discs.
  await run(bin, ['x', '-y', `-o${destDir}`, '--', archivePath], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 0,
  });

  // Trust the filesystem over the listing: what landed is what matters.
  const files: string[] = [];
  let totalBytes = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) await walk(full);
      else {
        files.push(full);
        totalBytes += st.size;
      }
    }
  };
  await walk(destDir);
  return { files, totalBytes };
}

/** Read any supported archive's index. */
export async function archiveEntries(archivePath: string): Promise<ZipEntryInfo[]> {
  return is7z(archivePath) ? sevenZipEntries(archivePath) : zipEntries(archivePath);
}

/** Extract any supported archive. */
export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<ExtractResult> {
  return is7z(archivePath) ? extract7z(archivePath, destDir) : extractZip(archivePath, destDir);
}

/** Total uncompressed size of any supported archive, for the space precheck. */
export async function archiveUncompressedSize(archivePath: string): Promise<number> {
  if (!is7z(archivePath)) return uncompressedSize(archivePath);
  const entries = await sevenZipEntries(archivePath);
  return entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
}
