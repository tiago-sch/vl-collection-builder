/**
 * The download worker (plan §8.0, §8.2).
 *
 * ## One at a time, permanently
 *
 * This is a single async loop. It is not a pool sized to one, and there is no
 * concurrency setting anywhere in this project — that absence is a decision, not
 * an oversight:
 *
 *   - Vimm's operator, asked directly on the site's own message board whether
 *     concurrent downloads were possible, said you can only download one game at
 *     a time (https://vimm.net/bbs/?Post=20768).
 *   - vl-downloader, whose queue model this is built on, is deliberately
 *     one-at-a-time, and its README asks readers not to modify it for bulk
 *     downloading. Crediting that project while shipping the one change its
 *     author asked people not to make would not hold together.
 *
 * A `DOWNLOAD_CONCURRENCY` variable would be a standing invitation to raise it
 * to a value we have already agreed is wrong, moving the decision out of the
 * plan and into an env file where it gets changed without context.
 *
 * The serial design is also *why* the rest of this is simple: no lock
 * contention, no partial-file races, no competing writes to the same `.part`.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { DownloadItem, DownloadProgress } from '@vl-collection-builder/shared';
import { config } from '../config.js';
import { fetchPage } from '../catalog/fetcher.js';
import { freeDiskMb } from '../util/disk.js';
import { describeError, errorContext } from '../util/errors.js';
import {
  bumpAttempts,
  claimNext,
  getDownload,
  recoverInterrupted,
  setDestination,
  setMediaInfo,
  setProgress,
  setStatus,
} from './queue.js';
import { isAuxiliaryFile, zipEntries } from '../organize/extract.js';
import {
  DEFAULT_DOWNLOAD_USER_AGENT,
  downloadHeaders,
  downloadUrl,
  fileNameFromDisposition,
  parseVaultPage,
  sanitizeFileName,
} from './vimm.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

type Listener = (p: DownloadProgress) => void;
const listeners = new Set<Listener>();

export function onProgress(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(p: DownloadProgress): void {
  for (const fn of listeners) {
    try {
      fn(p);
    } catch {
      /* a broken SSE client must not stop the download */
    }
  }
}

export function downloadUserAgent(): string {
  return config.downloadUserAgent || DEFAULT_DOWNLOAD_USER_AGENT;
}

/** Resolve a name inside a root, refusing anything that escapes it. */
export function safeJoin(root: string, name: string): string {
  const clean = sanitizeFileName(name);
  if (!clean) throw new Error(`unsafe filename: ${JSON.stringify(name)}`);
  const full = resolve(root, clean);
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    throw new Error(`filename escapes the destination directory: ${JSON.stringify(name)}`);
  }
  return full;
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/**
 * Fetch the vault page and record what we will be downloading.
 *
 * The page carries the filename, expected size and checksums, so this happens
 * before any bytes move and makes the disk precheck exact.
 */
async function prepare(item: DownloadItem): Promise<{ url: string; referer: string }> {
  const html = await fetchPage(item.vaultUrl);
  const page = parseVaultPage(html);

  for (const w of page.warnings) {
    // Not fatal, but it means we are downloading with less verification.
    console.warn(`download ${item.id}: ${w}`);
  }

  if (page.unavailable) throw new DownloadError('the vault page says this download is unavailable', false);
  if (!page.downloadHost) throw new DownloadError('no download host found on the vault page', false);
  if (page.media.length === 0) throw new DownloadError('no media found on the vault page', false);

  // A multi-disc release exposes several media entries. This row downloads the
  // disc it was queued for, defaulting to the first.
  const index = item.disc ? item.disc - 1 : 0;
  const media = page.media[index] ?? page.media[0]!;

  setMediaInfo(item.id, {
    mediaId: media.mediaId,
    disc: page.media.length > 1 ? media.sortOrder : null,
    discTotal: page.media.length > 1 ? page.media.length : null,
    fileName: media.fileName,
    totalBytes: media.expectedBytes ?? 0,
    md5: media.md5,
    sha1: media.sha1,
    crc32: media.crc32,
  });

  return { url: downloadUrl(page.downloadHost, media.mediaId), referer: item.vaultUrl };
}

/** Stream one file to disk, resuming a `.part` if one is there. Exported for tests. */
export async function transfer(item: DownloadItem, url: string, referer: string): Promise<string> {
  const destDir = join(config.downloadsPath, item.platform);
  await mkdir(destDir, { recursive: true });

  // Provisional name; the real one comes from Content-Disposition.
  const provisional = item.fileName ?? `vault-${item.vaultId}${item.mediaId ? `-${item.mediaId}` : ''}`;
  let partPath = `${safeJoin(destDir, provisional)}.part`;

  const offset = await sizeOf(partPath);

  // Never Range from 0 — the server returns the tail of the file for ranges
  // starting at zero, which would silently corrupt the download. See vimm.ts.
  const res = await fetch(url, {
    headers: downloadHeaders({ referer, userAgent: downloadUserAgent(), offset }),
    redirect: 'follow',
    signal: config.downloadTimeoutMs > 0 ? AbortSignal.timeout(config.downloadTimeoutMs) : undefined,
  });

  if (res.status === 416) {
    // Range not satisfiable: the .part is at or past the end. Start over rather
    // than guess — a stale .part is cheap to re-fetch, a corrupt ROM is not.
    await unlink(partPath).catch(() => undefined);
    throw new DownloadError('stale partial file discarded; will restart', true);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new DownloadError(`HTTP ${res.status} from the download host`, retryable);
  }
  if (!res.body) throw new DownloadError('empty response body', true);

  const resuming = offset > 0 && res.status === 206;
  if (offset > 0 && res.status === 200) {
    // Server ignored our Range and is sending the whole file: start clean.
    await unlink(partPath).catch(() => undefined);
  }

  // Prefer the server's filename now that we have it.
  const disposition = fileNameFromDisposition(res.headers.get('content-disposition'));
  if (disposition) {
    const better = `${safeJoin(destDir, disposition)}.part`;
    if (better !== partPath) {
      if (resuming) {
        // Keep writing to the file we already have bytes in.
        setDestination(item.id, disposition, better.replace(/\.part$/, ''));
      } else {
        partPath = better;
      }
    }
    setDestination(item.id, disposition, partPath.replace(/\.part$/, ''));
  }

  const contentLength = Number(res.headers.get('content-length') ?? '0');
  const total = resuming ? offset + contentLength : contentLength || item.totalBytes;
  setProgress(item.id, resuming ? offset : 0, total);

  let received = resuming ? offset : 0;
  let lastTick = Date.now();
  let lastBytes = received;

  const out = createWriteStream(partPath, { flags: resuming ? 'a' : 'w' });
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);

  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    // Throttle to ~1s: a per-chunk write would hammer SQLite for no benefit.
    if (now - lastTick >= 1000) {
      const rate = ((received - lastBytes) * 1000) / (now - lastTick);
      setProgress(item.id, received);
      emit({
        id: item.id,
        status: 'active',
        receivedBytes: received,
        totalBytes: total,
        rate,
        title: item.title,
        fileName: disposition ?? item.fileName,
      });
      lastTick = now;
      lastBytes = received;
    }
  });

  await pipeline(body, out);
  setProgress(item.id, received);

  return partPath;
}

/**
 * Verify, then move into place.
 *
 * ## What the published checksums actually describe
 *
 * The vault page's `GoodSha1` / `GoodMd5` / `GoodHash` are the checksums of the
 * **ROM inside the archive**, not of the archive we download. Verified against
 * a real download:
 *
 *     downloaded 3 Ninjas Kick Back (USA).zip   sha1 921dfd75...
 *     3 Ninjas Kick Back (USA).sfc inside it    sha1 b619576a...  == GoodSha1
 *
 * Hashing the .zip and comparing it to GoodSha1 therefore fails every single
 * time. The checks are now split to match where the data actually lives:
 *
 *   - here, at download time: the byte count against Content-Length, which is
 *     what catches a truncated transfer, plus the archive's stored CRC32 against
 *     GoodHash, which confirms we fetched the right ROM. The CRC comes from the
 *     zip index, so this costs no decompression even for a 4 GB image.
 *   - at organize time: the extracted ROM's SHA1 against GoodSha1, done while
 *     the bytes are already being read.
 */
export async function finalize(item: DownloadItem, partPath: string): Promise<string> {
  const finalPath = partPath.replace(/\.part$/, '');
  const actualSize = await sizeOf(partPath);

  // --- truncation -----------------------------------------------------------
  const fresh = getDownload(item.id);
  const expected = fresh?.totalBytes ?? 0;
  if (expected > 0 && actualSize !== expected) {
    await unlink(partPath).catch(() => undefined);
    throw new DownloadError(
      `size mismatch (expected ${expected} bytes, got ${actualSize}) — the partial file was discarded`,
      true,
    );
  }

  // --- identity, via the zip index -----------------------------------------
  const expectCrc = fresh?.expectCrc32 ?? null;
  if (expectCrc && /\.zip$/i.test(finalPath)) {
    try {
      const entries = await zipEntries(partPath);
      const content = entries.filter((e) => !isAuxiliaryFile(e.fileName));
      // Only assert when the archive holds exactly one game file. Multi-track
      // discs publish one checksum for a set of several, and guessing which it
      // refers to would produce false failures on valid downloads.
      if (content.length === 1) {
        const got = content[0]!.crc32.toLowerCase();
        if (got !== expectCrc.toLowerCase()) {
          await unlink(partPath).catch(() => undefined);
          throw new DownloadError(
            `content mismatch: the archive contains a file with CRC32 ${got}, but this release publishes ${expectCrc} — the partial file was discarded`,
            true,
          );
        }
      }
    } catch (err) {
      if (err instanceof DownloadError) throw err;
      // A zip we cannot index is suspicious but not proof of corruption; the
      // organizer will fail loudly on it rather than us guessing here.
      console.warn(`download ${item.id}: could not read the archive index (${(err as Error).message})`);
    }
  }

  await mkdir(dirname(finalPath), { recursive: true });
  await rename(partPath, finalPath);
  return finalPath;
}

async function processOne(item: DownloadItem): Promise<void> {
  const { url, referer } = await prepare(item);

  const fresh = getDownload(item.id) ?? item;
  const needMb = Math.ceil((fresh.totalBytes || 0) / (1024 * 1024)) + config.minFreeDiskMb;
  const freeMb = await freeDiskMb(config.downloadsPath);
  if (freeMb !== null && freeMb < needMb) {
    throw new DownloadError(
      `not enough free space: ${freeMb} MB available, ${needMb} MB required (file + MIN_FREE_DISK_MB)`,
      false,
    );
  }

  const partPath = await transfer(fresh, url, referer);
  const finalPath = await finalize(fresh, partPath);

  setDestination(item.id, finalPath.split(sep).pop()!, finalPath);
  // 'downloaded', not 'completed': the organizer owns the second half of the
  // lifecycle. With organizing off, the routes present this as done.
  setStatus(item.id, config.organizeEnabled ? 'downloaded' : 'completed');

  // Hand off to the organizer, which runs in the same serial pipeline.
  if (config.organizeEnabled) {
    const { kickOrganizer } = await import('../organize/worker.js');
    kickOrganizer();
  }

  const done = getDownload(item.id);
  emit({
    id: item.id,
    status: done?.status ?? 'completed',
    receivedBytes: done?.receivedBytes ?? 0,
    totalBytes: done?.totalBytes ?? 0,
    rate: 0,
    title: item.title,
    fileName: done?.fileName ?? null,
  });
}

let running = false;
let stopped = false;

/** True while a transfer is in flight. */
export function isDownloading(): boolean {
  return running;
}

async function loop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (stopped) return;
      const item = claimNext();
      if (!item) return;

      try {
        await processOne(item);
      } catch (err) {
        const e = err as DownloadError;
        const attempts = bumpAttempts(item.id);
        const retryable = e instanceof DownloadError ? e.retryable : true;

        // `fetch failed` on its own says nothing. describeError unwraps the
        // cause chain so the recorded message names the actual failure.
        const detail = describeError(err);
        console.warn(
          `download ${item.id} (${item.title}) failed on attempt ${attempts}: ${detail}`,
          errorContext(err),
        );

        if (retryable && attempts < config.downloadRetryLimit) {
          setStatus(item.id, 'queued', detail);
          await sleep(Math.min(60_000, config.interDownloadDelayMs * 2 ** attempts));
        } else {
          setStatus(item.id, 'error', detail);
          emit({
            id: item.id,
            status: 'error',
            receivedBytes: 0,
            totalBytes: 0,
            rate: 0,
            title: item.title,
            fileName: null,
          });
        }
      }

      // Deliberate politeness between files, independent of retry backoff.
      if (!stopped) await sleep(config.interDownloadDelayMs);
    }
  } finally {
    running = false;
  }
}

/** Nudge the worker. Safe to call whenever something is enqueued. */
export function kick(): void {
  if (!config.downloadsEnabled || running || stopped) return;
  void loop();
}

export function startWorker(log: (m: string) => void = console.log): void {
  const recovered = recoverInterrupted();
  if (recovered.downloads > 0) {
    log(
      `download worker: reset ${recovered.downloads} interrupted transfer(s) to queued — .part files are kept, so they resume rather than restart`,
    );
  }
  if (recovered.organizing > 0) {
    log(`download worker: reset ${recovered.organizing} interrupted organize step(s)`);
  }
  if (!config.downloadsEnabled) {
    log('download worker: disabled (DOWNLOADS_ENABLED=false)');
    return;
  }
  stopped = false;
  kick();
}

export function stopWorker(): void {
  stopped = true;
}
