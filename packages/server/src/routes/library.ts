import type { FastifyInstance } from 'fastify';
import { config, workPath } from '../config.js';
import { allFiles, filesForGame } from '../db/library.js';
import { loadRegistry } from '../sources/load.js';
import { chdmanAvailable } from '../organize/chd.js';
import {
  parseFolderMap,
  platformFolder,
  renderTemplate,
  validateFolderMap,
} from '../organize/naming.js';
import { isOrganizing, requeueForOrganize } from '../organize/worker.js';
import {
  getExtractState,
  isExtractable,
  queueExtract,
  resetExtractState,
} from '../organize/extractJob.js';
import { freeDiskMb } from '../util/disk.js';

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { platform?: string } }>('/library/files', async (req) => ({
    files: allFiles(req.query.platform).map((f) => ({
      ...f,
      // Lets the UI offer "unzip" only where it would actually do something.
      extractable: isExtractable(f.kind, f.relPath),
    })),
  }));

  /**
   * Extract archives already in the library.
   *
   * Runs the full organizer with extraction forced rather than a bare unzip, so
   * the result still gets the naming template, subfolder rule and CHD step.
   * Returns immediately — a disc image takes minutes, and the job reports via
   * /library/extract/status.
   */
  app.post<{ Body: { fileIds?: number[]; gameIds?: number[] } }>(
    '/library/extract',
    async (req, reply) => {
      const body = req.body ?? {};
      const ids = new Set<number>(body.fileIds ?? []);

      for (const gameId of body.gameIds ?? []) {
        for (const f of filesForGame(gameId)) {
          if (isExtractable(f.kind, f.relPath)) ids.add(f.id);
        }
      }

      if (ids.size === 0) {
        return reply.code(400).send({
          error: 'nothing_extractable',
          detail: 'none of those files are archives that can be extracted',
        });
      }

      resetExtractState();
      const result = queueExtract([...ids]);
      return { ...result, state: getExtractState() };
    },
  );

  app.get('/library/extract/status', async () => getExtractState());

  app.get<{ Params: { id: string } }>('/library/files/game/:id', async (req) => ({
    files: filesForGame(Number(req.params.id)),
  }));

  /** Organizer configuration and health, for Settings. */
  app.get('/library/status', async () => {
    const { registry } = await loadRegistry();
    const map = parseFolderMap(config.platformFolderMap);

    return {
      enabled: config.organizeEnabled,
      organizing: isOrganizing(),
      libraryPath: config.libraryPath,
      workPath: workPath(),
      namingTemplate: config.namingTemplate,
      extractPolicy: config.extractPolicy,
      chdPolicy: config.chdPolicy,
      chdmanAvailable: await chdmanAvailable(),
      platformFolderStyle: config.platformFolderStyle,
      freeDiskMb: await freeDiskMb(config.libraryPath),
      // Surfaced as a banner rather than crashing the container: an unknown slug
      // must not silently mis-file 400 games, but it must not stop boot either.
      folderMapWarnings: validateFolderMap(
        map,
        registry.platforms.map((p) => p.slug),
      ),
      folders: registry.platforms.map((p) => ({
        slug: p.slug,
        folder: platformFolder(p.slug, config.platformFolderStyle, map, registry).folder,
      })),
    };
  });

  /**
   * Live preview of a naming template (plan §9.7).
   *
   * Renders three worked examples including a multi-disc one, so you can see
   * what a change does before applying it to 400 games.
   */
  app.get<{ Querystring: { template?: string } }>('/library/preview', async (req) => {
    const template = req.query.template ?? config.namingTemplate;
    const samples = [
      { title: 'Silent Hill 2', region: 'USA', version: '2.01', platform: 'ps2', vaultId: 9250, disc: null },
      { title: 'Okami', region: null, version: '1.01', platform: 'ps2', vaultId: 8993, disc: null },
      { title: 'Final Fantasy VII', region: 'USA', version: '1.1', platform: 'psx', vaultId: 1234, disc: 2 },
    ];
    return {
      template,
      examples: samples.map((s) => ({
        input: s,
        rendered: renderTemplate(template, s),
      })),
    };
  });

  /** Re-organize without re-downloading — the payoff of KEEP_ARCHIVE (plan §9.5). */
  app.post<{ Params: { id: string } }>('/downloads/:id/reorganize', async (req, reply) => {
    const result = requeueForOrganize(Number(req.params.id));
    if (!result.ok) {
      return reply.code(409).send({ error: 'cannot_reorganize', detail: result.reason });
    }
    return { queued: true };
  });
}
