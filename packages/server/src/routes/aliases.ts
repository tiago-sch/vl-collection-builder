import type { FastifyInstance } from 'fastify';
import { deleteLearnedAlias, listLearnedAliases } from '../matching/aliases.js';

export async function aliasRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { platform?: string } }>('/aliases', async (req) => ({
    aliases: listLearnedAliases(req.query.platform),
  }));

  /** Deletable, for when you confirm the wrong thing (plan §5). */
  app.delete<{ Params: { id: string } }>('/aliases/:id', async (req, reply) => {
    if (!deleteLearnedAlias(Number(req.params.id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { deleted: true };
  });
}
