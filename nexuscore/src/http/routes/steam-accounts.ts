import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SteamAccountError, steamActorOf, type SteamAccounts } from '../../steam/accounts.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Steam-Konten - dieselben Routen wie im Panel. Jeder angemeldete Benutzer verwaltet seine eigenen Konten und sieht die
 * freigegebenen; Administratoren sehen alle. Das Passwort geht nie in eine Antwort oder ins Protokoll.
 */

const saveBody = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().max(100).optional(),
  accountName: z.string().trim().min(2).max(100),
  password: z.string().min(1).max(200).optional(),
  steamId: z.string().trim().max(50).optional(),
  isShared: z.boolean().optional(),
});
const guardBody = z.object({ code: z.string().trim().min(4).max(10) });

export function registerSteamAccountRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; accounts: SteamAccounts }): void {
  const { registry, accounts } = deps;
  const fail = (reply: FastifyReply, status: number, message: string, code: string): FastifyReply => reply.status(status).send({ error: message, message, code });
  const actorOf = (req: FastifyRequest) => steamActorOf(req.actor);
  const guarded = async <T>(reply: FastifyReply, run: () => T | Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof SteamAccountError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  };
  const isUuid = (v: string): boolean => z.string().uuid().safeParse(v).success;

  server.get('/api/v1/steam/accounts', async (req) => ({ accounts: accounts.list(actorOf(req)) }));

  server.post<{ Body: unknown }>('/api/v1/steam/accounts', async (req, reply) => {
    const body = saveBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, 'Ungültige Angaben zum Steam-Konto', 'invalid_input');
    return guarded(reply, () => {
      const { account, created } = accounts.save(actorOf(req), body.data);
      registry.audit(created ? 'steam.account_save' : 'steam.account_update', null, 'standalone', { accountName: account.accountName, isShared: account.isShared, label: account.label, ...(body.data.password ? { password: 'gesetzt' } : {}) });
      reply.status(created ? 201 : 200);
      return { account };
    });
  });

  server.post<{ Params: { id: string } }>('/api/v1/steam/accounts/:id/test', async (req, reply) => {
    if (!isUuid(req.params.id)) return fail(reply, 404, 'Konto nicht gefunden', 'not_found');
    return guarded(reply, async () => {
      const result = await accounts.test(actorOf(req), req.params.id);
      registry.audit('steam.test_login', null, 'standalone', { accountName: result.account.accountName, status: result.status });
      return result;
    });
  });

  server.post<{ Params: { id: string }; Body: unknown }>('/api/v1/steam/accounts/:id/guard', async (req, reply) => {
    if (!isUuid(req.params.id)) return fail(reply, 404, 'Konto nicht gefunden', 'not_found');
    const body = guardBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, 'Steam-Guard-Code muss 4-10 Zeichen lang sein', 'invalid_input');
    return guarded(reply, async () => {
      const result = await accounts.test(actorOf(req), req.params.id, body.data.code);
      // Der Code selbst gehoert nicht ins Protokoll
      registry.audit('steam.guard_submit', null, 'standalone', { accountName: result.account.accountName, status: result.status });
      return result;
    });
  });

  server.delete<{ Params: { id: string } }>('/api/v1/steam/accounts/:id', async (req, reply) => {
    if (!isUuid(req.params.id)) return fail(reply, 404, 'Konto nicht gefunden', 'not_found');
    return guarded(reply, () => {
      accounts.delete(actorOf(req), req.params.id);
      registry.audit('steam.account_delete', null, 'standalone', { id: req.params.id });
      return { ok: true };
    });
  });
}
