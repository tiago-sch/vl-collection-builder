import type { FastifyInstance } from 'fastify';
import { getSettings, updateSettings, type SettingsPatch } from '../db/settings.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', async () => {
    const settings = getSettings();
    return {
      settings,
      /**
       * Surfaced so Settings can explain why a large region bonus has no effect:
       * it is clamped below the tier-2 margin by design (plan §4.2).
       */
      regionBonusCeiling: Math.max(0, settings.fuzzyMargin - 0.005),
    };
  });

  app.put<{ Body: SettingsPatch }>('/settings', async (req, reply) => {
    const body = req.body ?? {};

    if (body.regionPreference !== undefined) {
      if (!Array.isArray(body.regionPreference) || body.regionPreference.some((r) => typeof r !== 'string')) {
        return reply.code(400).send({ error: 'regionPreference must be an array of strings' });
      }
      if (body.regionPreference.length === 0) {
        // Plan §4.2: there is deliberately no silent default, so an empty list
        // is a configuration error rather than "match anything".
        return reply.code(400).send({ error: 'regionPreference cannot be empty' });
      }
    }

    for (const key of ['fuzzyThreshold', 'fuzzyMargin', 'regionBonus'] as const) {
      const v = body[key];
      if (v !== undefined && (typeof v !== 'number' || v < 0 || v > 1)) {
        return reply.code(400).send({ error: `${key} must be a number between 0 and 1` });
      }
    }

    return { settings: updateSettings(body) };
  });
}
