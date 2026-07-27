/**
 * First-run wizard state (plan §6.0).
 *
 * The wizard exists to make sure the region choice is *made*. Silently
 * defaulting to USA and quietly mismatching a Japan-focused collection is the
 * failure it prevents, so completing setup requires a non-empty region list.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { isSetupComplete, markSetupComplete, updateSettings } from '../db/settings.js';

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/setup/state', async () => {
    const rows = getDb()
      .prepare('SELECT DISTINCT platform FROM catalog_entry')
      .all() as unknown as Array<{ platform: string }>;

    return {
      completed: isSetupComplete(),
      syncedPlatforms: rows.map((r) => r.platform),
      suggestedRegionPreference: config.regionPreference,
    };
  });

  app.post<{
    Body: {
      platform?: string;
      regionPreference?: string[];
      strictRegion?: boolean;
      resolver?: string | null;
    };
  }>('/setup/complete', async (req, reply) => {
    const body = req.body ?? {};

    if (!Array.isArray(body.regionPreference) || body.regionPreference.length === 0) {
      return reply.code(400).send({
        error: 'region_preference_required',
        detail:
          'Pick at least one region. There is no default: a silent USA fallback would mismatch a Japan-focused collection without telling you.',
      });
    }

    updateSettings({
      regionPreference: body.regionPreference,
      strictRegion: body.strictRegion ?? false,
      resolverProvider: body.resolver ?? null,
    });
    markSetupComplete();

    return { completed: true };
  });

  /** Re-runnable from Settings (plan §6.0). */
  app.post('/setup/reset', async () => {
    getDb().prepare("DELETE FROM settings WHERE key = 'setup_completed_at'").run();
    return { completed: false };
  });
}
