import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { loadRegistry } from '../sources/load.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Backs the Docker HEALTHCHECK. Touches the database so a broken volume shows up. */
  app.get('/health', async (_req, reply) => {
    try {
      getDb().prepare('SELECT 1').get();
    } catch (err) {
      return reply.code(503).send({ status: 'error', detail: (err as Error).message });
    }
    const { registry, warnings } = await loadRegistry();
    return {
      status: 'ok',
      platforms: registry.platforms.length,
      registryWarnings: warnings,
    };
  });
}
