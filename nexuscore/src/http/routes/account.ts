import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { globalPermissions } from '../../auth/permissions.js';
import {
  listSessions,
  parseCookie,
  revokeOtherSessions,
  revokeSessionById,
  revokeSessionToken,
} from '../../protocol/security.js';
import { AccountError, type LocalAccount } from '../../store/account.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { RequestActor } from '../authz.js';

/**
 * Konto des angemeldeten Benutzers - dieselben Routen und Antworten wie im Panel
 * (Seite "Konto"): Profil, Zwei-Faktor, Sitzungen. Passwort aendern und Anmelden
 * liegen in api-v1.ts, weil sie die Sitzungen beruehren.
 *
 * Jeder Benutzer sieht und aendert nur sein eigenes Konto. Passkeys und
 * Steam-Anmeldung kennt der Core nicht.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Wer die Anfrage stellt - gesetzt von der Anmeldung in server.ts. */
    actor?: RequestActor;
  }
}

export interface AccountRouteDeps {
  registry: ServerRegistry;
  account: LocalAccount | null;
}

const profileBody = z
  .object({
    username: z.string().max(64).optional(),
    email: z.string().max(300).nullable().optional(),
    avatar: z.string().max(600).nullable().optional(),
    locale: z.string().max(10).nullable().optional(),
  })
  .strict();

const confirmBody = z.object({
  password: z.string().min(1).max(1024),
  totp: z.string().max(10).optional(),
  recoveryCode: z.string().max(40).optional(),
});

function fail(reply: FastifyReply, status: number, message: string, code: string): FastifyReply {
  return reply.status(status).send({ error: message, message, code });
}

/** Das Token dieser Anfrage - Kopfzeile oder Cookie. */
export function currentToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header) return header.replace(/^Bearer\s+/i, '').trim();
  return parseCookie(req.headers.cookie, 'nxp_session');
}

export function registerAccountRoutes(server: FastifyInstance, deps: AccountRouteDeps): void {
  const { registry, account } = deps;

  /**
   * Das Konto der Anfrage. Das Master-Token (Panel, Skripte) ist kein Benutzer
   * und hat deshalb kein Konto, das es aendern koennte.
   */
  const own = (req: FastifyRequest, reply: FastifyReply): { account: LocalAccount; id: string } | null => {
    if (!account) {
      fail(reply, 403, 'Anmeldung ist in diesem Modus nicht verfuegbar.', 'forbidden');
      return null;
    }
    const actor = req.actor;
    if (!actor || actor.master) {
      fail(reply, 403, 'Das Zugriffstoken hat kein Benutzerkonto. Bitte als Benutzer anmelden.', 'forbidden');
      return null;
    }
    return { account, id: actor.id };
  };

  /** AccountError -> saubere Antwort. */
  const guarded = async <T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AccountError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  };

  // Vor der Anmeldung: welche Wege gibt es? Die Anmeldeseite blendet sonst nicht Vorhandenes aus.
  server.get('/api/v1/auth/methods', async () => ({ password: true, passkey: false, steam: false }));

  server.get('/api/v1/auth/me', async (req, reply) => {
    const actor = req.actor;
    if (!actor) return fail(reply, 401, 'Nicht angemeldet', 'unauthorized');
    const p = !actor.master && account ? account.get(actor.id) : undefined;
    return {
      user: {
        id: actor.id,
        username: p?.username ?? actor.username,
        email: p?.email ?? null,
        role: actor.role,
        locale: p?.locale ?? 'de',
        canCreateServers: actor.role === 'admin' || actor.canCreateServers,
        totpEnabled: p?.totpEnabled ?? false,
        avatar: p?.avatar ?? null,
        steamId: null,
        steamName: null,
      },
      permissions: globalPermissions(actor),
    };
  });

  server.patch<{ Body: unknown }>('/api/v1/auth/me', async (req, reply) => {
    const me = own(req, reply);
    if (!me) return reply;
    const body = profileBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    return guarded(reply, async () => {
      await me.account.updateProfile(me.id, body.data);
      registry.audit('auth.profile_update', null, 'standalone', { fields: Object.keys(body.data) });
      return { ok: true };
    });
  });

  // ---------------------------------------------------------- Zwei-Faktor

  server.post('/api/v1/auth/totp/setup', async (req, reply) => {
    const me = own(req, reply);
    if (!me) return reply;
    return guarded(reply, () => me.account.startTotpSetup(me.id));
  });

  server.post<{ Body: unknown }>('/api/v1/auth/totp/enable', async (req, reply) => {
    const me = own(req, reply);
    if (!me) return reply;
    const body = z.object({ code: z.string().min(6).max(10) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Der Code aus der Authenticator-App fehlt', 'invalid_request');
    return guarded(reply, async () => {
      const codes = await me.account.enableTotp(me.id, body.data.code);
      registry.audit('auth.totp_enabled', null, 'standalone');
      return { enabled: true, recoveryCodes: codes };
    });
  });

  server.post<{ Body: unknown }>('/api/v1/auth/totp/disable', async (req, reply) => {
    const me = own(req, reply);
    if (!me) return reply;
    const body = confirmBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Passwort und Code sind nötig', 'invalid_request');
    return guarded(reply, async () => {
      if (!me.account.totpEnabled(me.id)) throw new AccountError('Zwei-Faktor ist nicht aktiv', 'totp_not_enabled');
      await me.account.confirmIdentity(me.id, body.data.password, body.data, req.ip);
      await me.account.disableTotp(me.id);
      registry.audit('auth.totp_disabled', null, 'standalone');
      return { enabled: false };
    });
  });

  server.post<{ Body: unknown }>('/api/v1/auth/totp/recovery-codes', async (req, reply) => {
    const me = own(req, reply);
    if (!me) return reply;
    const body = confirmBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Passwort und Code sind nötig', 'invalid_request');
    return guarded(reply, async () => {
      if (!me.account.totpEnabled(me.id)) throw new AccountError('Zwei-Faktor ist nicht aktiv', 'totp_not_enabled');
      await me.account.confirmIdentity(me.id, body.data.password, body.data, req.ip);
      const codes = await me.account.regenerateRecoveryCodes(me.id);
      registry.audit('auth.recovery_codes_regenerated', null, 'standalone');
      return { recoveryCodes: codes };
    });
  });

  // ---------------------------------------------------------- Sitzungen
  // Jeder sieht und beendet nur seine eigenen - die Kennung einer fremden Sitzung ist wie nicht vorhanden.

  server.get('/api/v1/auth/sessions', async (req, reply) => {
    const me = own(req, reply);
    if (!me) return reply;
    return { sessions: listSessions(currentToken(req), me.id) };
  });

  server.delete<{ Params: { id: string } }>('/api/v1/auth/sessions/:id', async (req, reply) => {
    const me = own(req, reply);
    if (!me) return reply;
    if (!/^[0-9a-f]{16}$/.test(req.params.id)) return fail(reply, 404, 'Sitzung nicht gefunden', 'not_found');
    const current = currentToken(req);
    const mine = current ? listSessions(current, me.id).find((s) => s.current)?.id : undefined;
    if (!revokeSessionById(req.params.id, me.id)) return fail(reply, 404, 'Sitzung nicht gefunden', 'not_found');
    registry.audit('auth.session_revoked', null, 'standalone', { own: req.params.id === mine });
    if (req.params.id === mine && current) revokeSessionToken(current);
    return { ok: true };
  });

  server.post('/api/v1/auth/logout-all', async (req, reply) => {
    const me = own(req, reply);
    if (!me) return reply;
    const revoked = revokeOtherSessions(currentToken(req), me.id);
    registry.audit('auth.logout_all', null, 'standalone', { count: revoked });
    return { ok: true, revoked };
  });
}
