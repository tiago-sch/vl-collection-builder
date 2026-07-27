import type { FastifyInstance } from 'fastify';
import { loadRegistry } from '../sources/load.js';

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platforms', async () => {
    const { registry } = await loadRegistry();
    return { platforms: registry.platforms };
  });
}
