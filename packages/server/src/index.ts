/**
 * Fastify bootstrap: one process, one port. The built React client is served as
 * static files by this same instance, so a deployment is one container and one
 * URL (plan §2).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { initDb, closeDb } from './db/client.js';
import { loadRegistry } from './sources/load.js';
import { registerRoutes } from './routes/index.js';
import { startWorker, stopWorker } from './download/worker.js';
import { startOrganizer, stopOrganizer } from './organize/worker.js';
import { preflight } from './preflight.js';

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 4 * 1024 * 1024, // a pasted list of a few thousand names
  });

  // Before touching the database. Opening it is the FIRST thing that fails when
  // a path is not writable, and it fails with a bare `unable to open database
  // file` — which is exactly the message the preflight exists to replace.
  const checks = await preflight();
  for (const i of checks.info) app.log.info(i);
  for (const w of checks.warnings) app.log.warn(w);
  for (const e of checks.errors) app.log.error(e);
  if (!checks.ok) {
    app.log.error('startup preflight failed — fix the paths above and restart');
    process.exit(1);
  }

  const { migrationsRun, path } = await initDb((m) => app.log.info(m));
  app.log.info(`database ready at ${path}`);
  if (migrationsRun.length) app.log.info(`applied migrations: ${migrationsRun.join(', ')}`);

  const { registry, warnings } = await loadRegistry();
  for (const w of warnings) app.log.warn(w);
  app.log.info(`source registry loaded: ${registry.platforms.length} platforms, base ${registry.baseUrl}`);

  await registerRoutes(app);

  // Crash recovery runs here: anything left mid-transfer goes back to the queue
  // with its .part intact, so an interrupted 4 GB image costs seconds, not GB.
  startWorker((m) => app.log.info(m));
  await startOrganizer((m) => app.log.info(m));

  // Static client. WEB_ROOT is empty in dev, where Vite serves the client itself
  // and proxies /api back here.
  const webRoot = config.webRoot ? resolve(config.webRoot) : '';
  if (webRoot && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    // SPA fallback: any non-/api path that isn't a real file renders index.html
    // so client-side routes survive a reload.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
    app.log.info(`serving web client from ${webRoot}`);
  } else if (config.webRoot) {
    app.log.warn(`WEB_ROOT=${config.webRoot} does not exist — API only`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    stopWorker();
    stopOrganizer();
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error('failed to start:', err);
  process.exit(1);
});
