import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  listSessions,
  parseCookie,
  revokeOtherSessions,
  revokeSessionById,
  revokeSessionToken,
} from '../../protocol/security.js';
import { AccountError, type LocalAccount } from '../../store/account.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Konto der Standalone-Oberflaeche - dieselben Routen und Antworten wie im Panel
 * (Seite "Konto"): Profil, Zwei-Faktor, Sitzungen. Passwort aendern und Anmelden
 * liegen in api-v1.ts, weil sie die Sitzungen beruehren.
 *
 * Es gibt im Core genau ein Konto. Passkeys und Steam-Anmeldung kennt er nicht.
 */

export interface AccountRouteDeps {
  registry: ServerRegistry;
  account: LocalAccount | null;
}

const GLOBAL_PERMISSIONS = {
  'server.create': true,
  'server.view_all': true,
  'admin.nodes': true,
  'admin.users': true,
  'admin.audit': true,
  'admin.hosts': true,
  'admin.eggs': true,
  'admin.files': true,
  'admin.integrations': true,
  'admin.test_report': true,
};

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

  const noAccount = (reply: FastifyReply) => fail(reply, 403, 'Anmeldung ist in diesem Modus nicht verfuegbar.', 'forbidden');

  /** AccountError -> saubere Antwort. */
  const guarded = async <T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AccountError) return fail(reply, err.code === 'too_many_attempts' ? 429 : 400, err.message, err.code);
      throw err;
    }
  };

  // Vor der Anmeldung: welche Wege gibt es? Die Anmeldeseite blendet sonst nicht Vorhandenes aus.
  server.get('/api/v1/auth/methods', async () => ({ password: true, passkey: false, steam: false }));

  server.get('/api/v1/auth/me', async () => {
    const p = account?.profile();
    return {
      user: {
        id: 'standalone-admin',
        username: p?.username ?? 'Admin',
        email: p?.email ?? null,
        role: 'admin',
        locale: p?.locale ?? 'de',
        canCreateServers: true,
        totpEnabled: p?.totpEnabled ?? false,
        avatar: p?.avatar ?? null,
        steamId: null,
        steamName: null,
      },
      permissions: GLOBAL_PERMISSIONS,
    };
  });

  server.patch<{ Body: unknown }>('/api/v1/auth/me', async (req, reply) => {
    if (!account) return noAccount(reply);
    const body = profileBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    return guarded(reply, async () => {
      await account.updateProfile(body.data);
      registry.audit('auth.profile_update', null, 'standalone', { fields: Object.keys(body.data) });
      return { ok: true };
    });
  });

  // ---------------------------------------------------------- Zwei-Faktor

  server.post('/api/v1/auth/totp/setup', async (_req, reply) => {
    if (!account) return noAccount(reply);
    return guarded(reply, () => account.startTotpSetup());
  });

  server.post<{ Body: unknown }>('/api/v1/auth/totp/enable', async (req, reply) => {
    if (!account) return noAccount(reply);
    const body = z.object({ code: z.string().min(6).max(10) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Der Code aus der Authenticator-App fehlt', 'invalid_request');
    return guarded(reply, async () => {
      const codes = await account.enableTotp(body.data.code);
      registry.audit('auth.totp_enabled', null, 'standalone');
      return { enabled: true, recoveryCodes: codes };
    });
  });

  server.post<{ Body: unknown }>('/api/v1/auth/totp/disable', async (req, reply) => {
    if (!account) return noAccount(reply);
    const body = confirmBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Passwort und Code sind nötig', 'invalid_request');
    return guarded(reply, async () => {
      if (!account.totpEnabled) throw new AccountError('Zwei-Faktor ist nicht aktiv', 'totp_not_enabled');
      await account.confirmIdentity(body.data.password, body.data, req.ip);
      await account.disableTotp();
      registry.audit('auth.totp_disabled', null, 'standalone');
      return { enabled: false };
    });
  });

  server.post<{ Body: unknown }>('/api/v1/auth/totp/recovery-codes', async (req, reply) => {
    if (!account) return noAccount(reply);
    const body = confirmBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Passwort und Code sind nötig', 'invalid_request');
    return guarded(reply, async () => {
      if (!account.totpEnabled) throw new AccountError('Zwei-Faktor ist nicht aktiv', 'totp_not_enabled');
      await account.confirmIdentity(body.data.password, body.data, req.ip);
      const codes = await account.regenerateRecoveryCodes();
      registry.audit('auth.recovery_codes_regenerated', null, 'standalone');
      return { recoveryCodes: codes };
    });
  });

  // ---------------------------------------------------------- Sitzungen

  server.get('/api/v1/auth/sessions', async (req) => ({ sessions: listSessions(currentToken(req)) }));

  server.delete<{ Params: { id: string } }>('/api/v1/auth/sessions/:id', async (req, reply) => {
    if (!/^[0-9a-f]{16}$/.test(req.params.id)) return fail(reply, 404, 'Sitzung nicht gefunden', 'not_found');
    const current = currentToken(req);
    const mine = current ? listSessions(current).find((s) => s.current)?.id : undefined;
    if (!revokeSessionById(req.params.id)) return fail(reply, 404, 'Sitzung nicht gefunden', 'not_found');
    registry.audit('auth.session_revoked', null, 'standalone', { own: req.params.id === mine });
    if (req.params.id === mine && current) revokeSessionToken(current);
    return { ok: true };
  });

  server.post('/api/v1/auth/logout-all', async (req) => {
    const revoked = revokeOtherSessions(currentToken(req));
    registry.audit('auth.logout_all', null, 'standalone', { count: revoked });
    return { ok: true, revoked };
  });
}
