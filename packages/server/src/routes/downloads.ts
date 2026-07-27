import type { FastifyInstance } from 'fastify';
import type { DownloadStatus } from '@vault-lookup/shared';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { freeDiskMb } from '../util/disk.js';
import {
  enqueue,
  getDownload,
  listDownloads,
  queueStats,
  remove,
  reorder,
  retry,
  setStatus,
} from '../download/queue.js';
import { isDownloading, kick, onProgress } from '../download/worker.js';

export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: DownloadStatus } }>('/downloads', async (req) => {
    const items = listDownloads(req.query.status);
    return {
      items,
      active: items.find((i) => i.status === 'active') ?? null,
      stats: queueStats(),
      downloading: isDownloading(),
      enabled: config.downloadsEnabled,
      freeDiskMb: await freeDiskMb(config.downloadsPath),
      downloadsPath: config.downloadsPath,
      /**
       * Surfaced so the UI can state it plainly rather than leaving the absence
       * of a concurrency control looking like an oversight (plan §8.0, §13.3).
       */
      concurrency: 1,
      interDownloadDelayMs: config.interDownloadDelayMs,
    };
  });

  /** Enqueue by game id, or by raw vault URL. */
  app.post<{ Body: { gameIds?: number[]; vaultUrls?: string[] } }>(
    '/downloads',
    async (req, reply) => {
      const body = req.body ?? {};
      const queued: number[] = [];
      const duplicates: number[] = [];
      const errors: string[] = [];

      for (const gameId of body.gameIds ?? []) {
        const row = getDb()
          .prepare('SELECT id, platform, name, vault_url, vault_id FROM game WHERE id = ?')
          .get(gameId) as
          | { id: number; platform: string; name: string; vault_url: string; vault_id: number | null }
          | undefined;
        if (!row) {
          errors.push(`game ${gameId} not found`);
          continue;
        }
        if (row.vault_id === null) {
          errors.push(`game ${gameId} has no vault id (added by manual URL)`);
          continue;
        }
        const r = enqueue({
          gameId: row.id,
          vaultId: row.vault_id,
          vaultUrl: row.vault_url,
          title: row.name,
          platform: row.platform,
        });
        if (r.duplicate) duplicates.push(gameId);
        else if (r.id !== null) queued.push(r.id);
      }

      for (const url of body.vaultUrls ?? []) {
        const m = /\/vault\/(\d+)/.exec(url);
        if (!m) {
          errors.push(`not a vault URL: ${url}`);
          continue;
        }
        const vaultId = Number(m[1]);
        const entry = getDb()
          .prepare('SELECT platform, title FROM catalog_entry WHERE vault_id = ? LIMIT 1')
          .get(vaultId) as { platform: string; title: string } | undefined;
        const r = enqueue({
          vaultId,
          vaultUrl: `https://vimm.net/vault/${vaultId}`,
          title: entry?.title ?? `vault/${vaultId}`,
          platform: entry?.platform ?? 'unknown',
        });
        if (r.duplicate) duplicates.push(vaultId);
        else if (r.id !== null) queued.push(r.id);
      }

      if (queued.length === 0 && duplicates.length === 0 && errors.length > 0) {
        return reply.code(400).send({ error: 'nothing_queued', detail: errors.join('; ') });
      }

      kick();
      return { queued, duplicates, errors };
    },
  );

  /** SSE progress. One transport for both this and catalogue sync. */
  app.get('/downloads/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('hello', { stats: queueStats() });
    const off = onProgress((p) => send('progress', p));
    // Keeps proxies from closing an idle stream between large files.
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);

    req.raw.on('close', () => {
      off();
      clearInterval(ping);
      reply.raw.end();
    });

    return reply;
  });

  app.patch<{ Params: { id: string }; Body: { position?: number; status?: DownloadStatus } }>(
    '/downloads/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      const item = getDownload(id);
      if (!item) return reply.code(404).send({ error: 'not_found' });

      if (typeof req.body?.position === 'number') reorder(id, req.body.position);

      if (req.body?.status === 'paused') {
        if (item.status !== 'queued') {
          return reply.code(409).send({
            error: 'cannot_pause',
            detail: 'only a queued item can be paused; cancel the active one instead',
          });
        }
        setStatus(id, 'paused');
      } else if (req.body?.status === 'queued') {
        setStatus(id, 'queued');
        kick();
      }

      return { item: getDownload(id) };
    },
  );

  app.post<{ Params: { id: string } }>('/downloads/:id/retry', async (req, reply) => {
    if (!retry(Number(req.params.id))) {
      return reply.code(409).send({ error: 'not_retryable' });
    }
    kick();
    return { item: getDownload(Number(req.params.id)) };
  });

  app.delete<{ Params: { id: string }; Querystring: { deletePart?: string } }>(
    '/downloads/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      const item = getDownload(id);
      if (!item) return reply.code(404).send({ error: 'not_found' });

      if (item.status === 'active') {
        // The worker checks status between files; marking it cancelled stops it
        // being retried, and the .part is left for a future resume.
        setStatus(id, 'cancelled');
        return { cancelled: true, note: 'the in-flight transfer will stop after the current file' };
      }

      if (req.query.deletePart === 'true' && item.destPath) {
        const { unlink } = await import('node:fs/promises');
        await unlink(`${item.destPath}.part`).catch(() => undefined);
      }
      remove(id);
      return { deleted: true };
    },
  );
}
