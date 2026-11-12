import { logger } from '../../logger.js';
import { createSessionToken, isValidSessionToken, revokeSessionToken, revokeUserSessions, parseCookie } from '../../protocol/security.js';
import { runAs } from '../../store/identity.js';
import type { ApiContext } from './api-context.js';

/**
 * Anmeldung und Sitzung: Token erneuern, anmelden, Passwort ändern, abmelden.
 */
export function registerSessionRoutes(ctx: ApiContext): void {
  const { server, registry, account, sessionCookie } = ctx;

  // 1. Authentifizierung & Sitzung
  // Block A4: refresh gibt nur dann ein Token heraus, wenn es schon eine
  // gueltige Sitzung gibt. Frueher bekam hier jeder ohne Anmeldung ein Token.
  server.post('/api/v1/auth/refresh', async (req, reply) => {
    const existingCookie = parseCookie(req.headers.cookie, 'nxp_session');
    if (!existingCookie || !isValidSessionToken(existingCookie)) {
      return reply.status(401).send({ error: 'Nicht angemeldet', code: 'unauthorized' });
    }
    return { accessToken: existingCookie };
  });

  // Block A4: echte Anmeldung mit dem lokalen Konto.
  server.post<{ Body: { login?: unknown; password?: unknown; totp?: unknown; recoveryCode?: unknown } | undefined }>(
    '/api/v1/auth/login',
    async (req, reply) => {
      if (!account) {
        return reply.status(403).send({ error: 'Anmeldung ist in diesem Modus nicht verfuegbar.' });
      }
      const login = typeof req.body?.login === 'string' ? req.body.login : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const origin = req.ip;

      const locked = account.lockedForSeconds(origin);
      if (locked > 0) {
        reply.header('Retry-After', String(locked));
        return reply.status(429).send({
          error: `Zu viele Fehlversuche. Bitte in ${Math.ceil(locked / 60)} Minuten erneut versuchen.`,
          code: 'too_many_attempts',
        });
      }

      const user = !login || !password || password.length > 1024 ? null : await account.verify(login, password, origin);
      if (!user) {
        logger.warn({ origin }, 'Fehlgeschlagene Anmeldung an der Standalone-Oberflaeche');
        registry.audit('auth.login_failed', null, 'standalone', { origin });
        return reply.status(401).send({ error: 'Benutzername oder Passwort falsch.', code: 'invalid_credentials' });
      }

      // Zwei-Faktor: das Passwort allein genuegt nicht. Ein fehlender Code ist kein Fehlversuch,
      // ein falscher schon - sonst waere der Code mit dem richtigen Passwort unbegrenzt zu erraten.
      if (user.totpEnabled) {
        const totp = typeof req.body?.totp === 'string' ? req.body.totp : undefined;
        const recoveryCode = typeof req.body?.recoveryCode === 'string' ? req.body.recoveryCode : undefined;
        if (!totp && !recoveryCode) {
          return reply.status(401).send({ error: 'Code aus der Authenticator-App erforderlich', code: 'totp_required' });
        }
        if (!(await account.checkSecondFactor(user.id, { totp, recoveryCode }))) {
          account.recordFailure(origin);
          registry.audit('auth.login_failed', null, 'standalone', { origin, reason: totp ? 'totp' : 'recovery_code' });
          return reply.status(401).send({ error: 'Code ungueltig oder schon benutzt', code: 'totp_invalid' });
        }
        if (recoveryCode) {
          runAs({ userId: user.id, username: user.username }, () =>
            registry.audit('auth.recovery_code_used', null, 'standalone', { left: account.recoveryLeft(user.id) }),
          );
        }
      }
      account.clearFailures(origin);
      await account.recordLogin(user.id);

      const token = createSessionToken({ userId: user.id, ip: req.ip, userAgent: req.headers['user-agent'] });
      runAs({ userId: user.id, username: user.username }, () => registry.audit('auth.login', null, 'standalone', { origin }));
      reply.header('Set-Cookie', sessionCookie(token));
      return { accessToken: token };
    },
  );

  // Eigenes Passwort aendern: altes Passwort noetig, danach gelten alle
  // anderen Sitzungen nicht mehr.
  server.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } | undefined }>(
    '/api/v1/auth/password',
    async (req, reply) => {
      if (!account) {
        return reply.status(403).send({ error: 'Anmeldung ist in diesem Modus nicht verfuegbar.' });
      }
      const actor = req.actor;
      if (!actor || actor.master) {
        return reply.status(403).send({ error: 'Das Zugriffstoken hat kein Benutzerkonto. Bitte als Benutzer anmelden.', code: 'forbidden' });
      }
      const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      const next = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      if (!(await account.checkPassword(actor.id, current, req.ip))) {
        return reply.status(401).send({ error: 'Das aktuelle Passwort stimmt nicht.', code: 'invalid_credentials' });
      }
      try {
        await account.setPassword(actor.id, next);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      // Nur die Sitzungen DIESES Benutzers enden - die der anderen laufen weiter
      revokeUserSessions(actor.id);
      registry.audit('auth.password_changed', null, 'standalone');
      const token = createSessionToken({ userId: actor.id, ip: req.ip, userAgent: req.headers['user-agent'] });
      reply.header('Set-Cookie', sessionCookie(token));
      return { ok: true, accessToken: token };
    },
  );

  server.post('/api/v1/auth/logout', async (req, reply) => {
    const existingCookie = parseCookie(req.headers.cookie, 'nxp_session');
    if (existingCookie) {
      revokeSessionToken(existingCookie);
    }
    const authHeader = req.headers.authorization;
    if (authHeader) {
      revokeSessionToken(authHeader.replace(/^Bearer\s+/i, '').trim());
    }
    reply.header('Set-Cookie', 'nxp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });
}
