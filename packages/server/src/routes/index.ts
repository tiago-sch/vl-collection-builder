import type { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { platformRoutes } from './platforms.js';
import { catalogRoutes } from './catalog.js';
import { setupRoutes } from './setup.js';
import { settingsRoutes } from './settings.js';
import { jobRoutes } from './jobs.js';
import { gameRoutes } from './games.js';
import { aliasRoutes } from './aliases.js';
import { downloadRoutes } from './downloads.js';
import { libraryRoutes } from './library.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (api) => {
      await healthRoutes(api);
      await platformRoutes(api);
      await catalogRoutes(api);
      await setupRoutes(api);
      await settingsRoutes(api);
      await jobRoutes(api);
      await gameRoutes(api);
      await aliasRoutes(api);
      await downloadRoutes(api);
      await libraryRoutes(api);
    },
    { prefix: '/api' },
  );
}
