import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { PasskeyService, relyingPartyOf } from '../../auth/passkeys.js';
import { AccountError, type AccountUser, type LocalAccount } from '../../store/account.js';
import { runAs } from '../../store/identity.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Passkeys - dieselben Routen und Antworten wie im Panel. Registrieren und Verwalten braucht eine Anmeldung,
 * "login-options" und "login-verify" sind oeffentlich (siehe isPublicRoute).
 */

export interface PasskeyRouteDeps {
  registry: ServerRegistry;
  account: LocalAccount;
  service: PasskeyService;
  /** Stellt eine Sitzung aus (Cookie und Token) - dieselbe wie bei der Anmeldung mit Passwort. */
  issueSession: (req: FastifyRequest, reply: FastifyReply, user: AccountUser) => Promise<{ accessToken: string }>;
}

function fail(reply: FastifyReply, status: number, message: string, code: string): FastifyReply {
  return reply.status(status).send({ error: message, message, code });
}

const view = (p: { id: string; deviceName: string; createdAt: string; lastUsedAt: string | null }) => ({
  id: p.id,
  device_name: p.deviceName,
  created_at: p.createdAt,
  last_used_at: p.lastUsedAt,
});

export function registerPasskeyRoutes(server: FastifyInstance, deps: PasskeyRouteDeps): void {
  const { registry, account, service, issueSession } = deps;

  /** Das Konto der Anfrage - das Master-Token hat keines. */
  const own = (req: FastifyRequest, reply: FastifyReply): AccountUser | null => {
    const actor = req.actor;
    const user = actor && !actor.master ? account.get(actor.id) : undefined;
    if (!user) {
      fail(reply, 403, 'Das Zugriffstoken hat kein Benutzerkonto. Bitte als Benutzer anmelden.', 'forbidden');
      return null;
    }
    return user;
  };

  const guarded = async <T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AccountError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  };

  server.post('/api/v1/auth/passkeys/register-options', async (req, reply) => {
    const user = own(req, reply);
    if (!user) return reply;
    return guarded(reply, async () => service.registrationOptions(user, relyingPartyOf({ host: req.headers.host, origin: req.headers.origin })));
  });

  server.post<{ Body: unknown }>('/api/v1/auth/passkeys/register-verify', async (req, reply) => {
    const user = own(req, reply);
    if (!user) return reply;
    const body = z.object({ challengeId: z.string().min(10).max(100), response: z.unknown(), deviceName: z.string().max(100).optional() }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    return guarded(reply, async () => {
      const passkey = await service.verifyRegistration(
        user,
        body.data.challengeId,
        body.data.response as RegistrationResponseJSON,
        body.data.deviceName ?? 'Sicherheitsschlüssel / Passkey',
        relyingPartyOf({ host: req.headers.host, origin: req.headers.origin }),
      );
      registry.audit('user.passkey_registered', null, 'standalone', { passkeyId: passkey.id, deviceName: passkey.deviceName });
      return { ok: true, passkey: view(passkey) };
    });
  });

  server.get('/api/v1/auth/passkeys', async (req, reply) => {
    const user = own(req, reply);
    if (!user) return reply;
    return { passkeys: account.passkeys(user.id).map(view).sort((a, b) => b.created_at.localeCompare(a.created_at)) };
  });

  server.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/auth/passkeys/:id', async (req, reply) => {
    const user = own(req, reply);
    if (!user) return reply;
    const body = z.object({ deviceName: z.string().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    const updated = await account.renamePasskey(user.id, req.params.id, body.data.deviceName);
    if (!updated) return fail(reply, 404, 'Passkey nicht gefunden', 'not_found');
    return { ok: true, passkey: view(updated) };
  });

  server.delete<{ Params: { id: string } }>('/api/v1/auth/passkeys/:id', async (req, reply) => {
    const user = own(req, reply);
    if (!user) return reply;
    if (!(await account.removePasskey(user.id, req.params.id))) return fail(reply, 404, 'Passkey nicht gefunden', 'not_found');
    registry.audit('user.passkey_deleted', null, 'standalone', { passkeyId: req.params.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- oeffentlich

  server.post<{ Body: unknown }>('/api/v1/auth/passkeys/login-options', async (req, reply) => {
    const body = z.object({ username: z.string().max(254).optional() }).safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    const locked = account.lockedForSeconds(req.ip);
    if (locked > 0) {
      reply.header('Retry-After', String(locked));
      return fail(reply, 429, `Zu viele Fehlversuche. Bitte in ${Math.ceil(locked / 60)} Minuten erneut versuchen.`, 'too_many_attempts');
    }
    return guarded(reply, () =>
      service.authenticationOptions(body.data.username, relyingPartyOf({ host: req.headers.host, origin: req.headers.origin }), (login) => account.findByLogin(login)),
    );
  });

  server.post<{ Body: unknown }>('/api/v1/auth/passkeys/login-verify', async (req, reply) => {
    const body = z.object({ challengeId: z.string().min(10).max(100), response: z.unknown(), client: z.string().optional() }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    const locked = account.lockedForSeconds(req.ip);
    if (locked > 0) {
      reply.header('Retry-After', String(locked));
      return fail(reply, 429, `Zu viele Fehlversuche. Bitte in ${Math.ceil(locked / 60)} Minuten erneut versuchen.`, 'too_many_attempts');
    }
    try {
      const { userId, passkey } = await service.verifyAuthentication(
        body.data.challengeId,
        body.data.response as AuthenticationResponseJSON,
        relyingPartyOf({ host: req.headers.host, origin: req.headers.origin }),
      );
      const user = account.get(userId);
      if (!user || user.suspended) {
        account.recordFailure(req.ip);
        registry.audit('auth.login_failed', null, 'standalone', { origin: req.ip, reason: 'passkey_suspended' });
        return fail(reply, 401, 'Anmeldung mit Passkey fehlgeschlagen', 'passkey_failed');
      }
      await account.recordLogin(user.id);
      runAs({ userId: user.id, username: user.username }, () =>
        registry.audit('auth.login', null, 'standalone', { origin: req.ip, via: 'passkey', deviceName: passkey.deviceName }),
      );
      return await issueSession(req, reply, user);
    } catch (err) {
      if (err instanceof AccountError) {
        // Ein Fehlschlag zaehlt wie ein falsches Passwort (gleiche Sperre je Herkunft)
        if (err.code !== 'passkey_no_host' && err.code !== 'passkey_needs_hostname') account.recordFailure(req.ip);
        registry.audit('auth.login_failed', null, 'standalone', { origin: req.ip, reason: 'passkey' });
        return fail(reply, err.statusCode === 400 ? 401 : err.statusCode, err.message, err.code);
      }
      throw err;
    }
  });
}
