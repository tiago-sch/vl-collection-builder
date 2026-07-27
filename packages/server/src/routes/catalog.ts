import type { FastifyInstance } from 'fastify';
import { loadRegistry, resolvePlatform } from '../sources/load.js';
import { getSyncState } from '../db/catalog.js';
import { getSettings } from '../db/settings.js';
import { isSyncing, liveSearch, syncPlatform } from '../catalog/sync.js';
import { getHealth, resetHealth } from '../catalog/health.js';
import { SOURCE_NAME } from '../catalog/fetcher.js';

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/catalog/status', async () => {
    const { registry } = await loadRegistry();
    const { staleAfterDays } = getSettings();
    return {
      platforms: registry.platforms.map((p) => ({
        ...getSyncState(p.slug, staleAfterDays),
        label: p.label,
        syncing: isSyncing(p.slug),
      })),
      health: getHealth(SOURCE_NAME),
      staleAfterDays,
    };
  });

  /**
   * Streams progress as SSE. The crawl is slow by design (one request per
   * CRAWL_DELAY_MS), so a plain request/response would just time out.
   */
  app.post<{ Params: { platform: string } }>('/catalog/sync/:platform', async (req, reply) => {
    const platform = await resolvePlatform(req.params.platform);
    if (!platform) return reply.code(404).send({ error: 'unknown_platform' });
    if (isSyncing(platform.slug)) return reply.code(409).send({ error: 'sync_already_running' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Stop the crawl if the client goes away mid-sync.
    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());

    try {
      const result = await syncPlatform(platform, {
        signal: controller.signal,
        onProgress: (p) => send('progress', p),
      });
      send('done', result);
    } catch (err) {
      send('error', { error: (err as Error).message });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  /** Non-streaming variant, for scripts and curl. */
  app.post<{ Params: { platform: string } }>('/catalog/sync-sync/:platform', async (req, reply) => {
    const platform = await resolvePlatform(req.params.platform);
    if (!platform) return reply.code(404).send({ error: 'unknown_platform' });
    if (isSyncing(platform.slug)) return reply.code(409).send({ error: 'sync_already_running' });
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

  app.post('/catalog/health/reset', async () => {
    resetHealth(SOURCE_NAME);
    return { health: getHealth(SOURCE_NAME) };
  });
}
