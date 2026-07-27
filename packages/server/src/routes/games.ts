import type { FastifyInstance } from 'fastify';
import { deleteGame, listGames, toCsv, toMinimal } from '../db/games.js';

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { platform?: string; format?: string; minimal?: string } }>(
    '/games',
    async (req, reply) => {
      const games = listGames(req.query.platform);

      if (req.query.format === 'csv') {
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="vault-lookup.csv"')
          .send(toCsv(games));
      }

      // The shape plan §3 asks for.
      if (req.query.minimal === 'true') return toMinimal(games);

      return { games, count: games.length };
    },
  );

  app.delete<{ Params: { id: string } }>('/games/:id', async (req, reply) => {
    if (!deleteGame(Number(req.params.id))) return reply.code(404).send({ error: 'not_found' });
    return { deleted: true };
  });
}
