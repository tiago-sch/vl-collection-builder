import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadRegistry, resolvePlatform } from '../sources/load.js';
import { getSyncState } from '../db/catalog.js';
import { getSettings } from '../db/settings.js';
import { liveSearch } from '../catalog/sync.js';
import { cancelSync, getRun, isSyncing, startSync, subscribe } from '../catalog/manager.js';
import { getHealth, resetHealth } from '../catalog/health.js';
import { SOURCE_NAME } from '../catalog/fetcher.js';

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/catalog/status', async () => {
    const { registry } = await loadRegistry();
    const { staleAfterDays } = getSettings();
    return {
      platforms: registry.platforms.map((p) => {
        const run = getRun(p.slug);
        return {
          ...getSyncState(p.slug, staleAfterDays),
          label: p.label,
          syncing: isSyncing(p.slug),
          // Live progress travels with the status, so a page loaded mid-crawl
          // shows where things stand before any stream connects.
          progress: run && run.finishedAt === null ? run.progress : null,
        };
      }),
      health: getHealth(SOURCE_NAME),
      staleAfterDays,
    };
  });

  /**
   * Start a sync (or attach to one already running) and stream its progress.
   *
   * Disconnecting only detaches this watcher — the crawl keeps going. That is
   * the point: a refresh or a tab change used to abort a multi-minute crawl
   * partway through, because the job was owned by the request.
   */
  app.post<{ Params: { platform: string } }>('/catalog/sync/:platform', async (req, reply) => {
    const platform = await resolvePlatform(req.params.platform);
    if (!platform) return reply.code(404).send({ error: 'unknown_platform' });

    startSync(platform);
    return await streamRun(platform.slug, req, reply);
  });

  /** Attach to a running sync without starting one — used after a reload. */
  app.get<{ Params: { platform: string } }>('/catalog/sync/:platform/stream', async (req, reply) => {
    const platform = await resolvePlatform(req.params.platform);
    if (!platform) return reply.code(404).send({ error: 'unknown_platform' });
    return await streamRun(platform.slug, req, reply);
  });

  app.post<{ Params: { platform: string } }>('/catalog/sync/:platform/cancel', async (req, reply) => {
    const platform = await resolvePlatform(req.params.platform);
    if (!platform) return reply.code(404).send({ error: 'unknown_platform' });
    return { cancelled: cancelSync(platform.slug) };
  });

  /** Non-streaming variant, for scripts and curl. */
  app.post<{ Params: { platform: string } }>('/catalog/sync-sync/:platform', async (req, reply) => {
    const platform = await resolvePlatform(req.params.platform);
    if (!platform) return reply.code(404).send({ error: 'unknown_platform' });
    if (isSyncing(platform.slug)) return reply.code(409).send({ error: 'sync_already_running' });
    const { syncPlatform } = await import('../catalog/sync.js');
    try {
      return await syncPlatform(platform);
    } catch (err) {
      return reply.code(502).send({ error: 'sync_failed', detail: (err as Error).message });
    }
  });

  /** Live site search — the escape hatch for titles missing from a stale mirror. */
  app.get<{ Params: { platform: string }; Querystring: { q?: string } }>(
    '/catalog/search/:platform',
    async (req, reply) => {
      const platform = await resolvePlatform(req.params.platform);
      if (!platform) return reply.code(404).send({ error: 'unknown_platform' });
      const q = (req.query.q ?? '').trim();
      if (!q) return reply.code(400).send({ error: 'missing_query' });

      const { registry } = await loadRegistry();
      try {
        const result = await liveSearch(platform, q);
        return {
          query: q,
          columnsMissing: result.columnsMissing,
          results: result.entries.map((e) => ({
            ...e,
            url: `${registry.baseUrl}/vault/${e.vaultId}`,
          })),
        };
      } catch (err) {
        return reply.code(502).send({ error: 'search_failed', detail: (err as Error).message });
      }
    },
  );

  /** Shared SSE plumbing for both the start and attach routes. */
  async function streamRun(
    slug: string,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const run = getRun(slug);
    if (!run) {
      send('idle', { platform: slug });
      reply.raw.end();
      return reply;
    }

    // Replay current state immediately, so a reconnecting client is not left
    // staring at nothing until the next section boundary — which can be a
    // minute away.
    send('progress', run.progress);
    if (run.finishedAt) {
      send(run.error ? 'error' : 'done', run.error ? { error: run.error } : run.result);
      reply.raw.end();
      return reply;
    }

    const off = subscribe(slug, (p) => {
      send('progress', p);
      if (p.status !== 'running') {
        const finished = getRun(slug);
        send(p.status === 'error' ? 'error' : 'done', finished?.error ? { error: finished.error } : finished?.result);
      }
    });
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);

    req.raw.on('close', () => {
      // Detach only. The crawl is not ours to cancel.
      off();
      clearInterval(ping);
      reply.raw.end();
    });

    return reply;
  }

  app.post('/catalog/health/reset', async () => {
    resetHealth(SOURCE_NAME);
    return { health: getHealth(SOURCE_NAME) };
  });
}
