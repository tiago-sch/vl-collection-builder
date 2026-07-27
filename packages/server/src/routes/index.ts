import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { platformRoutes } from './platforms.js';

/**
 * Route modules are registered here as each build phase lands, so the server
 * always boots against exactly what exists.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (api) => {
      await healthRoutes(api);
      await platformRoutes(api);
    },
    { prefix: '/api' },
  );
}
