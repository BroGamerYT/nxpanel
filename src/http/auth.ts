import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { verifyAccessToken } from '../auth/tokens.js';
import { loadAuthContext, type AuthContext } from '../auth/users.js';
import { can, hasGlobalPermission, type ServerFlag, type GlobalPermission } from '../auth/permissions.js';
import { loadServerForActor, type ServerWithAccess } from '../servers/access.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: AuthContext | null;
    target: ServerWithAccess | null;
  }
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}

/**
 * Liest den Bearer-Token und haengt den Nutzer an die Anfrage.
 * Ohne gueltigen Token bleibt req.actor null - ob das erlaubt ist,
 * entscheidet die Route ueber requireAuth.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('actor', null);
  app.decorateRequest('target', null);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const result = await verifyAccessToken(header.slice(7).trim());
    if (!result.ok) {
      // Abgelaufen bekommt einen eigenen Code: die Oberflaeche erneuert dann still.
      if (result.reason === 'expired') (req as { tokenExpired?: boolean }).tokenExpired = true;
      return;
    }
    req.actor = await loadAuthContext(result.claims.sub, result.claims.sid);
  });
});

export async function requireAuth(req: FastifyRequest): Promise<void> {
  if (!req.actor) {
    const expired = (req as { tokenExpired?: boolean }).tokenExpired;
    throw new HttpError(401, expired ? 'Token abgelaufen' : 'Nicht angemeldet', expired ? 'token_expired' : 'unauthenticated');
  }
}

export function requireAdmin() {
  return async (req: FastifyRequest) => {
    await requireAuth(req);
    if (req.actor!.role !== 'admin') throw new HttpError(403, 'Nur fuer Administratoren', 'forbidden');
  };
}

export function requireGlobalPermission(perm: GlobalPermission) {
  return async (req: FastifyRequest) => {
    await requireAuth(req);
    if (!hasGlobalPermission(req.actor!, perm)) {
      throw new HttpError(403, `Fehlende Berechtigung: ${perm}`, 'forbidden');
    }
  };
}

/**
 * Fuer Routen unter /servers/:id. Laedt den Server, prueft Sichtbarkeit
 * (sonst 404) und das verlangte Flag (sonst 403). Danach steht der Server
 * in req.target - die Route muss ihn nicht noch einmal laden.
 */
export function requireServer(flag?: ServerFlag) {
  return async (req: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
    await requireAuth(req);
    const target = await loadServerForActor(req.params.id, req.actor!);
    if (!target) throw new HttpError(404, 'Server nicht gefunden', 'not_found');
    if (flag && !can(req.actor!, target.access, flag)) {
      throw new HttpError(403, `Fehlendes Recht: ${flag}`, 'forbidden');
    }
    req.target = target;
  };
}
