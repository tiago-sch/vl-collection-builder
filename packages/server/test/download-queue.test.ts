/**
 * Queue state machine and transfer mechanics, against a real database and a
 * local HTTP server. No ROMs are downloaded: the fake server serves a few KB of
 * deterministic bytes, which is enough to exercise resume and verification.
 */
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
let db: typeof import('../src/db/client.js');
let queue: typeof import('../src/download/queue.js');
let worker: typeof import('../src/download/worker.js');

/** 64 KB of deterministic content. */
const CONTENT = Buffer.from(
  Array.from({ length: 64 * 1024 }, (_, i) => i % 251),
);
const CONTENT_SHA1 = createHash('sha1').update(CONTENT).digest('hex');

let server: Server;
let baseUrl: string;
/** Set by tests to make the server misbehave in specific ways. */
let mode: 'normal' | 'ignore-range' | 'corrupt' | 'truncate' = 'normal';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vault-dl-test-'));
  process.env.DATABASE_PATH = join(dir, 'test.db');
  process.env.DOWNLOADS_PATH = join(dir, 'downloads');
  process.env.MIN_FREE_DISK_MB = '0';
  process.env.DOWNLOADS_ENABLED = 'false'; // drive the worker by hand in tests

  db = await import('../src/db/client.js');
  queue = await import('../src/download/queue.js');
  worker = await import('../src/download/worker.js');
  await db.initDb(() => {});

  server = createServer((req, res) => {
    const body = mode === 'corrupt' ? Buffer.concat([CONTENT.subarray(0, 100)]) : CONTENT;
    const range = mode === 'ignore-range' ? null : req.headers.range;

    if (range) {
      const m = /bytes=(\d+)-/.exec(String(range));
      const start = m ? Number(m[1]) : 0;
      if (start >= body.length) {
        res.writeHead(416).end();
        return;
      }
      const slice = body.subarray(start);
      res.writeHead(206, {
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
        'content-disposition': 'attachment; filename="Test Game (USA).zip"',
      });
      res.end(slice);
      return;
    }

    if (mode === 'truncate') {
      // Declares the full length, delivers half, then drops the connection —
      // what an interrupted transfer actually looks like on the wire.
      res.writeHead(200, {
        'content-length': String(body.length),
        'content-disposition': 'attachment; filename="Test Game (USA).zip"',
      });
      res.write(body.subarray(0, body.length / 2));
      res.destroy();
      return;
    }

    res.writeHead(200, {
      'content-length': String(body.length),
      'content-disposition': 'attachment; filename="Test Game (USA).zip"',
    });
    res.end(body);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const sample = {
  vaultId: 8433,
  vaultUrl: 'https://vimm.net/vault/8433',
  title: 'Test Game',
  platform: 'ps2',
};

describe('queue', () => {
  it('enqueues and assigns a position', () => {
    const r = queue.enqueue(sample);
    expect(r.duplicate).toBe(false);
    expect(r.id).toBeGreaterThan(0);
  });

  it('refuses to double-queue something already in flight', () => {
    // The partial unique index is what makes this safe rather than a race.
    const again = queue.enqueue(sample);
    expect(again.duplicate).toBe(true);
  });

  it('claims the next queued item atomically', () => {
    const claimed = queue.claimNext();
    expect(claimed?.status).toBe('active');
    expect(queue.claimNext()).toBeNull(); // nothing else queued
  });

  it('resets interrupted transfers to queued on boot, keeping the .part', () => {
    // This is the crash-recovery contract: an interrupted 4 GB image should cost
    // seconds, not gigabytes.
    const recovered = queue.recoverInterrupted();
    expect(recovered.downloads).toBe(1);
    expect(queue.listDownloads('queued')).toHaveLength(1);
  });

  it('allows re-queueing once a download has failed', () => {
    const item = queue.listDownloads('queued')[0]!;
    queue.setStatus(item.id, 'error', 'boom');
    expect(queue.retry(item.id)).toBe(true);
    expect(queue.getDownload(item.id)?.status).toBe('queued');
    expect(queue.getDownload(item.id)?.attempts).toBe(0);
  });

  it('reports stats by status', () => {
    expect(queue.queueStats().queued).toBe(1);
  });
});

describe('safeJoin', () => {
  it('rejects traversal', () => {
    expect(() => worker.safeJoin('/downloads/ps2', '../../etc/passwd')).toThrow();
    expect(() => worker.safeJoin('/downloads/ps2', '/etc/passwd')).toThrow();
  });

  it('accepts an ordinary name', () => {
    expect(worker.safeJoin('/downloads/ps2', 'Okami (USA).zip')).toBe(
      '/downloads/ps2/Okami (USA).zip',
    );
  });
});

describe('transfer and verification', () => {
  const partOf = (name = 'Test Game (USA).zip'): string =>
    join(dir, 'downloads', 'ps2', `${name}.part`);

  it('downloads a whole file and verifies it against the published sha1', async () => {
    mode = 'normal';
    const id = queue.enqueue({ ...sample, vaultId: 1001 }).id!;
    queue.setMediaInfo(id, {
      mediaId: 983,
      disc: null,
      discTotal: null,
      fileName: 'Test Game (USA).zip',
      totalBytes: CONTENT.length,
      md5: null,
      sha1: CONTENT_SHA1,
      crc32: null,
    });

    const item = queue.getDownload(id)!;
    const part = await worker.transfer(item, `${baseUrl}/dl`, 'https://vimm.net/vault/1001');
    const final = await worker.finalize(item, part);

    expect(existsSync(part)).toBe(false); // renamed off .part
    expect(readFileSync(final).equals(CONTENT)).toBe(true);
  });

  it('resumes from a partial file instead of restarting', async () => {
    mode = 'normal';
    const id = queue.enqueue({ ...sample, vaultId: 1002 }).id!;
    queue.setMediaInfo(id, {
      mediaId: 984,
      disc: null,
      discTotal: null,
      fileName: 'Test Game (USA).zip',
      totalBytes: CONTENT.length,
      md5: null,
      sha1: CONTENT_SHA1,
      crc32: null,
    });

    // Simulate an interrupted transfer: first 20 KB already on disk.
    const part = partOf();
    writeFileSync(part, CONTENT.subarray(0, 20 * 1024));

    const item = queue.getDownload(id)!;
    const got = await worker.transfer(item, `${baseUrl}/dl`, 'https://vimm.net/vault/1002');
    const final = await worker.finalize(item, got);

    // The resumed file must be byte-identical, not 20 KB + a whole second copy.
    expect(readFileSync(final).equals(CONTENT)).toBe(true);
  });

  it('starts clean when the server ignores the Range header', async () => {
    mode = 'ignore-range';
    const id = queue.enqueue({ ...sample, vaultId: 1003 }).id!;
    queue.setMediaInfo(id, {
      mediaId: 985, disc: null, discTotal: null, fileName: 'Test Game (USA).zip',
      totalBytes: CONTENT.length, md5: null, sha1: CONTENT_SHA1, crc32: null,
    });
    writeFileSync(partOf(), CONTENT.subarray(0, 20 * 1024));

    const item = queue.getDownload(id)!;
    const got = await worker.transfer(item, `${baseUrl}/dl`, 'https://vimm.net/vault/1003');
    const final = await worker.finalize(item, got);

    // Appending a full body onto a 20 KB head would corrupt it; we truncate.
    expect(readFileSync(final).equals(CONTENT)).toBe(true);
    mode = 'normal';
  });

  it('discards a file that fails checksum verification', async () => {
    // A corrupt ROM that looks fine is worse than no ROM, so a failed check
    // deletes the bytes rather than leaving them to be "fixed" later.
    mode = 'corrupt';
    const id = queue.enqueue({ ...sample, vaultId: 1004 }).id!;
    queue.setMediaInfo(id, {
      mediaId: 986, disc: null, discTotal: null, fileName: 'Test Game (USA).zip',
      totalBytes: CONTENT.length, md5: null, sha1: CONTENT_SHA1, crc32: null,
    });

    const item = queue.getDownload(id)!;
    const got = await worker.transfer(item, `${baseUrl}/dl`, 'https://vimm.net/vault/1004');
    await expect(worker.finalize(item, got)).rejects.toThrow(/sha1 mismatch/);
    expect(existsSync(got)).toBe(false);
    mode = 'normal';
  });

  it('falls back to a byte-count check when no checksum is published', async () => {
    // Without a published checksum the only thing left to verify is that we got
    // as many bytes as the server said it would send. Note this compares against
    // Content-Length, NOT the vault page's `Zipped` field: that is rounded to KB
    // (1062 KB vs an actual 1,087,083 bytes) and would fail on every download.
    mode = 'truncate';
    const id = queue.enqueue({ ...sample, vaultId: 1005 }).id!;
    queue.setMediaInfo(id, {
      mediaId: 987, disc: null, discTotal: null, fileName: 'Test Game (USA).zip',
      totalBytes: CONTENT.length, md5: null, sha1: null, crc32: null,
    });

    const item = queue.getDownload(id)!;
    // A dropped connection surfaces as a stream error or a short file; either
    // way the item must not be finalized as if it succeeded.
    let failed = false;
    try {
      const got = await worker.transfer(item, `${baseUrl}/dl`, 'https://vimm.net/vault/1005');
      await worker.finalize(item, got);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    mode = 'normal';
  });
});
