import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PLAYER_ACTIONS, PlayerError, type PlayerAction, type PlayerManager } from '../../players/manager.js';
import type { ServerInstanceConfig } from '../../types.js';

/** Spieler und Live-Zustand - dieselben Routen und Antworten wie im Panel (Tab "Spieler"). */

export interface PlayerRouteDeps {
  find: (idOrShortId: string) => ServerInstanceConfig | undefined;
  players: PlayerManager;
}

const actionBody = z.object({
  action: z.enum(PLAYER_ACTIONS as [PlayerAction, ...PlayerAction[]]),
  name: z.string().min(1).max(64).regex(/^[^\r\n]*$/),
  id: z.string().max(100).optional(),
  // Kein Zeilenumbruch: der Text landet in einem Konsolenbefehl.
  reason: z.string().max(200).regex(/^[^\r\n]*$/).optional(),
  minutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
});

function fail(reply: FastifyReply, status: number, message: string, code: string): FastifyReply {
  return reply.status(status).send({ error: message, message, code });
}

export function registerPlayerRoutes(server: FastifyInstance, deps: PlayerRouteDeps): void {
  const { find, players } = deps;
  const base = '/api/v1/servers/:id';

  async function guarded<T>(id: string, reply: FastifyReply, run: (serverId: string) => Promise<T>): Promise<T | FastifyReply> {
    const c = find(id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    try {
      return await run(c.id);
    } catch (err) {
      if (err instanceof PlayerError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  }

  server.get<{ Params: { id: string } }>(`${base}/game-status`, async (req, reply) =>
    guarded(req.params.id, reply, (id) => players.status(id)),
  );

  server.get<{ Params: { id: string } }>(`${base}/players/lists`, async (req, reply) =>
    guarded(req.params.id, reply, (id) => players.lists(id)),
  );

  server.post<{ Params: { id: string }; Body: unknown }>(`${base}/players/action`, async (req, reply) => {
    const body = actionBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    return guarded(req.params.id, reply, async (id) => ({ ok: true, ...(await players.act(id, body.data)) }));
  });
}
