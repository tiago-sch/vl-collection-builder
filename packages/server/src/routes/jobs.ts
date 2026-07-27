import type { FastifyInstance } from 'fastify';
import type { JobItemStatus } from '@vl-collection-builder/shared';
import { resolvePlatform } from '../sources/load.js';
import { countEntries } from '../db/catalog.js';
import {
  commitJob,
  createJob,
  getCounts,
  getJob,
  listItems,
  listJobs,
  resolveJobItem,
} from '../jobs/service.js';

interface CreateBody {
  platform: string;
  names: string[];
  name?: string;
  regionPreference?: string[];
  strictRegion?: boolean;
}

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get('/jobs', async () => ({ jobs: listJobs() }));

  app.post<{ Body: CreateBody }>('/jobs', async (req, reply) => {
    const body = req.body;
    if (!body?.platform || !Array.isArray(body.names)) {
      return reply.code(400).send({ error: 'platform and names[] are required' });
    }

    const platform = await resolvePlatform(body.platform);
    if (!platform) return reply.code(404).send({ error: 'unknown_platform' });

    // Matching against an empty mirror would send every item to review and look
    // like a matching failure rather than a missing catalogue.
    if (countEntries(platform.slug) === 0) {
      return reply.code(409).send({
        error: 'catalog_empty',
        detail: `no catalogue for ${platform.slug} — run a sync first`,
      });
    }

    try {
      const job = await createJob({
        platform: platform.slug,
        names: body.names,
        name: body.name ?? null,
        regionPreference: body.regionPreference ?? null,
        strictRegion: body.strictRegion ?? null,
      });
      return { job, counts: getCounts(job.id) };
    } catch (err) {
      return reply.code(400).send({ error: 'job_failed', detail: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    const job = getJob(Number(req.params.id));
    if (!job) return reply.code(404).send({ error: 'not_found' });
    return { job, counts: getCounts(job.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { status?: JobItemStatus } }>(
    '/jobs/:id/items',
    async (req, reply) => {
      const job = getJob(Number(req.params.id));
      if (!job) return reply.code(404).send({ error: 'not_found' });
      return { items: listItems(job.id, req.query.status) };
    },
  );

  app.post<{
    Params: { id: string; itemId: string };
    Body: { entryId?: number; manualUrl?: string; skip?: boolean };
  }>('/jobs/:id/items/:itemId/resolve', async (req, reply) => {
    const jobId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const body = req.body ?? {};

    const action =
      body.skip === true
        ? ({ skip: true } as const)
        : typeof body.entryId === 'number'
          ? ({ entryId: body.entryId } as const)
          : typeof body.manualUrl === 'string'
            ? ({ manualUrl: body.manualUrl } as const)
            : null;

    if (!action) {
      return reply.code(400).send({ error: 'supply one of entryId, manualUrl or skip' });
    }

    try {
      const item = resolveJobItem(jobId, itemId, action);
      if (!item) return reply.code(404).send({ error: 'not_found' });
      return { item, counts: getCounts(jobId) };
    } catch (err) {
      return reply.code(400).send({ error: 'resolve_failed', detail: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/commit', async (req, reply) => {
    const jobId = Number(req.params.id);
    if (!getJob(jobId)) return reply.code(404).send({ error: 'not_found' });
    try {
      return { result: commitJob(jobId), counts: getCounts(jobId) };
    } catch (err) {
      return reply.code(400).send({ error: 'commit_failed', detail: (err as Error).message });
    }
  });
}
