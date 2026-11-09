import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { verifyPassword, getDummyHash, needsRehash, hashPassword } from '../../auth/password.js';
import { signAccessToken, verifyAccessToken, ACCESS_TOKEN_TTL_S, REFRESH_TOKEN_TTL_S } from '../../auth/tokens.js';
import { createSession, rotateSession, revokeSessionFamily, revokeAllUserSessions, listActiveSessions } from '../../auth/sessions.js';
import { findUserForLogin, publicUser, setPassword, UserInputError, type UserRow } from '../../auth/users.js';
import { globalPermissions, SERVER_FLAGS, FLAG_LABELS, PRESETS } from '../../auth/permissions.js';
import { LIMITS, type RateLimiter } from '../../auth/ratelimit.js';
import { writeAudit } from '../../audit.js';
import { sql } from '../../db/index.js';
import { HttpError, requireAuth } from '../auth.js';
import {
  startTotpSetup, enableTotp, disableTotp, regenerateRecoveryCodes, checkSecondFactor, TwoFactorError,
} from '../../auth/twofactor.js';
import { getSteamOpenIdUrl, verifySteamOpenId, fetchSteamProfile } from '../../auth/steam-openid.js';

export const REFRESH_COOKIE = 'nxp_refresh';
const COOKIE_PATH = '/api/v1/auth';

/**
 * Zwei Arten von Clients:
 *   web - Refresh-Token NUR als httpOnly-Cookie. JavaScript im Browser
 *         kommt nicht heran, ein XSS-Fehler kann ihn also nicht stehlen.
 *   app - Desktop-/Handy-Apps haben keinen Cookie-Speicher; sie bekommen
 *         den Token im Body und legen ihn im Schluesselbund des Systems ab.
 */
export const loginBody = z.object({
  login: z.string().min(1).max(254),
  password: z.string().min(1).max(256),
  client: z.enum(['web', 'app']).default('web'),
  /** 6-stelliger Code aus der Authenticator-App, falls 2FA aktiv. */
  totp: z.string().max(10).optional(),
  /** Alternativ ein Wiederherstellungscode, wenn das Handy weg ist. */
  recoveryCode: z.string().max(40).optional(),
});

export const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional() }).default({});

export const meBody = z.object({
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Ungueltiger Sprachcode').optional(),
  avatar: z.string().max(1000).nullable().optional(),
  email: z.string().email('Ungueltige E-Mail-Adresse').optional(),
  username: z.string().regex(/^[a-zA-Z0-9_.-]{3,32}$/, 'Benutzername: 3-32 Zeichen, nur Buchstaben, Ziffern, _ . -').optional(),
});

export const passwordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

function meta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // Nach HTTPS richten, nicht nach NODE_ENV: im LAN ueber http://10.0.0.x
    // wuerde ein Secure-Cookie sonst still verworfen.
    secure: config.PANEL_URL.startsWith('https://'),
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_S,
  });
}

function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
}

export async function authRoutes(app: FastifyInstance, opts: { limiter: RateLimiter }) {
  const { limiter } = opts;

  app.post('/auth/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    const loginKey = `login:acct:${body.login.trim().toLowerCase()}`;
    const ipKey = `login:ip:${req.ip}`;

    // Nur FEHLversuche zaehlen. Wer sein Passwort kennt, soll sich auch
    // nach drei Tippfehlern sofort anmelden koennen.
    for (const [key, limit] of [[loginKey, LIMITS.loginAccount], [ipKey, LIMITS.loginIp]] as const) {
      const state = await limiter.isBlocked(key, limit);
      if (state.blocked) {
        reply.header('Retry-After', String(state.retryAfterS));
        throw new HttpError(429, `Zu viele Fehlversuche. Erneut in ${Math.ceil(state.retryAfterS / 60)} Min.`, 'rate_limited');
      }
    }

    const user = await findUserForLogin(body.login);
    // Immer einen Hash pruefen - sonst verraet die Antwortzeit, ob es das Konto gibt.
    const valid = await verifyPassword(user?.password_hash ?? (await getDummyHash()), body.password);

    if (!user || !valid) {
      await limiter.consume(loginKey, LIMITS.loginAccount);
      await limiter.consume(ipKey, LIMITS.loginIp);
      await writeAudit({
        userId: user?.id,
        actorName: body.login.slice(0, 64),
        action: 'auth.login_failed',
        ip: req.ip,
        metadata: { reason: user ? 'password' : 'unknown_user' },
      });
      throw new HttpError(401, 'Anmeldung fehlgeschlagen', 'invalid_credentials');
    }
    if (user.suspended) {
      await writeAudit({ userId: user.id, actorName: user.username, action: 'auth.login_suspended', ip: req.ip });
      throw new HttpError(403, 'Konto gesperrt', 'suspended');
    }
    let secondFactor: { via: string; remainingRecovery?: number } | null = null;
    if (user.totp_enabled) {
      if (!body.totp && !body.recoveryCode) {
        // Passwort stimmt, es fehlt nur der Code. Kein Fehlversuch - die
        // Oberflaeche zeigt jetzt das Code-Feld und schickt alles erneut.
        throw new HttpError(401, 'Code aus der Authenticator-App erforderlich', 'totp_required');
      }
      const f = await checkSecondFactor(user.id, { totp: body.totp, recoveryCode: body.recoveryCode });
      if (!f.ok) {
        await limiter.consume(loginKey, LIMITS.loginAccount);
        await limiter.consume(ipKey, LIMITS.loginIp);
        await writeAudit({ userId: user.id, actorName: user.username, action: 'auth.login_failed', ip: req.ip, metadata: { reason: body.totp ? 'totp' : 'recovery_code' } });
        throw new HttpError(401, 'Code ungueltig oder schon benutzt', 'totp_invalid');
      }
      secondFactor = { via: f.via, ...(f.remainingRecovery !== undefined ? { remainingRecovery: f.remainingRecovery } : {}) };
      if (f.via === 'recovery') {
        await writeAudit({ userId: user.id, actorName: user.username, action: 'auth.recovery_code_used', ip: req.ip, metadata: { remaining: f.remainingRecovery } });
      }
    }

    await limiter.reset(loginKey);
    if (needsRehash(user.password_hash)) {
      await sql`UPDATE users SET password_hash = ${await hashPassword(body.password)} WHERE id = ${user.id}`;
    }
    await sql`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`;

    const session = await createSession(user.id, meta(req));
    const accessToken = await signAccessToken({ sub: user.id, sid: session.sessionId });
    await writeAudit({ userId: user.id, actorName: user.username, action: 'auth.login', ip: req.ip, metadata: { client: body.client, secondFactor: secondFactor?.via ?? null } });

    if (body.client === 'web') setRefreshCookie(reply, session.refreshToken);
    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_S,
      ...(body.client === 'app' ? { refreshToken: session.refreshToken } : {}),
      user: publicUser(user),
      // Warnung fuer die Oberflaeche: nur noch wenige Wiederherstellungscodes uebrig
      ...(secondFactor?.remainingRecovery !== undefined ? { recoveryCodesLeft: secondFactor.remainingRecovery } : {}),
    };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const body = refreshBody.parse(req.body ?? {});
    const fromCookie = req.cookies[REFRESH_COOKIE];
    const token = body.refreshToken ?? fromCookie;
    if (!token) throw new HttpError(401, 'Kein Refresh-Token', 'no_refresh_token');

    const rl = await limiter.consume(`refresh:${req.ip}`, LIMITS.refresh);
    if (!rl.ok) throw new HttpError(429, 'Zu viele Anfragen', 'rate_limited');

    const result = await rotateSession(token, meta(req));
    if (!result.ok) {
      if (fromCookie && result.reason !== 'race') clearRefreshCookie(reply);
      const msg = result.reason === 'reused'
        ? 'Sitzung wurde aus Sicherheitsgruenden beendet - bitte neu anmelden'
        : 'Sitzung abgelaufen';
      throw new HttpError(401, msg, `refresh_${result.reason}`);
    }

    const accessToken = await signAccessToken({ sub: result.userId, sid: result.session.sessionId });
    if (!body.refreshToken) setRefreshCookie(reply, result.session.refreshToken);
    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_S,
      ...(body.refreshToken ? { refreshToken: result.session.refreshToken } : {}),
    };
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await revokeSessionFamily(req.actor!.sessionId, 'logout');
    clearRefreshCookie(reply);
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'auth.logout', ip: req.ip });
    return { ok: true };
  });

  app.post('/auth/logout-all', { preHandler: requireAuth }, async (req, reply) => {
    const count = await revokeAllUserSessions(req.actor!.id, 'logout_all');
    clearRefreshCookie(reply);
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'auth.logout_all', ip: req.ip, metadata: { count } });
    return { ok: true, revoked: count };
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const [u] = await sql<Parameters<typeof publicUser>[0][]>`
      SELECT id, email, username, role, can_create_servers, totp_enabled, locale, avatar, steam_id, steam_name FROM users WHERE id = ${req.actor!.id}`;
    return { user: publicUser(u!), permissions: globalPermissions(req.actor!) };
  });

  /** Eigene Profileinstellungen aktualisieren (Sprache, Avatar, Benutzername, E-Mail). */
  app.patch('/auth/me', { preHandler: requireAuth }, async (req) => {
    const body = meBody.parse(req.body);
    if (body.email !== undefined) {
      const emailLower = body.email.trim().toLowerCase();
      const [existing] = await sql`SELECT id FROM users WHERE lower(email) = ${emailLower} AND id != ${req.actor!.id}`;
      if (existing) throw new HttpError(400, 'E-Mail-Adresse wird bereits verwendet', 'email_taken');
      await sql`UPDATE users SET email = ${body.email.trim()} WHERE id = ${req.actor!.id}`;
    }
    if (body.username !== undefined) {
      const usernameLower = body.username.trim().toLowerCase();
      const [existing] = await sql`SELECT id FROM users WHERE lower(username) = ${usernameLower} AND id != ${req.actor!.id}`;
      if (existing) throw new HttpError(400, 'Benutzername wird bereits verwendet', 'username_taken');
      await sql`UPDATE users SET username = ${body.username.trim()} WHERE id = ${req.actor!.id}`;
    }
    if (body.locale !== undefined) {
      await sql`UPDATE users SET locale = ${body.locale} WHERE id = ${req.actor!.id}`;
    }
    if (body.avatar !== undefined) {
      await sql`UPDATE users SET avatar = ${body.avatar} WHERE id = ${req.actor!.id}`;
    }
    const [u] = await sql<Parameters<typeof publicUser>[0][]>`
      SELECT id, email, username, role, can_create_servers, totp_enabled, locale, avatar, steam_id, steam_name FROM users WHERE id = ${req.actor!.id}`;
    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'user.profile_update',
      ip: req.ip,
      metadata: { changed: Object.keys(body) },
    });
    return { ok: true, user: publicUser(u!) };
  });

  // ---------------------------------------------------------- Steam OpenID 2.0

  /** Zu Steam weiterleiten fuer Login oder Profil-Verknuepfung */
  app.get('/auth/steam/login', async (req, reply) => {
    const action = (req.query as { action?: string }).action === 'link' ? 'link' : 'login';
    let linkUserId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const res = await verifyAccessToken(authHeader.slice(7));
        if (res.ok) linkUserId = res.claims.sub;
      } catch {}
    }
    // Auch pruefen ob ueber Query-Token mitgegeben (z. B. wenn der Browser direkt per Link navigiert)
    const tokenQuery = (req.query as { token?: string }).token;
    if (!linkUserId && tokenQuery) {
      try {
        const res = await verifyAccessToken(tokenQuery);
        if (res.ok) linkUserId = res.claims.sub;
      } catch {}
    }

    const returnUrl = new URL(`${config.PANEL_URL}/api/v1/auth/steam/callback`);
    returnUrl.searchParams.set('action', action);
    if (linkUserId) returnUrl.searchParams.set('uid', linkUserId);

    const redirectUrl = getSteamOpenIdUrl(returnUrl.toString(), config.PANEL_URL);
    return reply.redirect(redirectUrl);
  });

  /** Rueckkehr von Steam: Signatur pruefen und anmelden oder verknuepfen */
  app.get('/auth/steam/callback', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const action = query.action;
    const uid = query.uid;

    const steamId = await verifySteamOpenId(query);
    if (!steamId) {
      return reply.redirect(action === 'link' ? '/account?error=steam_verify_failed' : '/login?error=steam_verify_failed');
    }

    const profile = await fetchSteamProfile(steamId);

    if (action === 'link') {
      const targetUserId = uid;
      if (!targetUserId) {
        return reply.redirect('/account?error=unauthenticated');
      }

      // Pruefen ob die SteamID bereits verknuepft ist
      const [existing] = await sql<{ id: string; username: string }[]>`
        SELECT id, username FROM users WHERE steam_id = ${steamId} AND id != ${targetUserId}
      `;
      if (existing) {
        return reply.redirect('/account?error=steam_already_linked');
      }

      await sql`
        UPDATE users
        SET steam_id = ${steamId},
            steam_name = ${profile?.personaName ?? null},
            avatar = COALESCE(avatar, ${profile?.avatarUrl ?? null})
        WHERE id = ${targetUserId}
      `;

      await writeAudit({
        userId: targetUserId,
        actorName: profile?.personaName ?? 'SteamUser',
        action: 'user.steam_linked',
        ip: req.ip,
        metadata: { steamId, personaName: profile?.personaName },
      });

      return reply.redirect('/account?steam=linked');
    }

    // action === 'login'
    const [user] = await sql<UserRow[]>`
      SELECT * FROM users WHERE steam_id = ${steamId} LIMIT 1
    `;

    if (!user) {
      return reply.redirect(`/login?error=steam_not_linked&steamId=${encodeURIComponent(steamId)}&name=${encodeURIComponent(profile?.personaName ?? '')}`);
    }

    if (user.suspended) {
      return reply.redirect('/login?error=suspended');
    }

    if (profile?.personaName || profile?.avatarUrl) {
      await sql`
        UPDATE users
        SET steam_name = COALESCE(${profile.personaName}, steam_name),
            avatar = COALESCE(avatar, ${profile.avatarUrl})
        WHERE id = ${user.id}
      `;
    }

    await sql`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`;
    const session = await createSession(user.id, meta(req));
    setRefreshCookie(reply, session.refreshToken);

    await writeAudit({
      userId: user.id,
      actorName: user.username,
      action: 'auth.steam_login',
      ip: req.ip,
      metadata: { steamId },
    });

    return reply.redirect('/?login=steam');
  });

  /** Steam-Verknuepfung trennen */
  app.post('/auth/steam/unlink', { preHandler: requireAuth }, async (req) => {
    await sql`UPDATE users SET steam_id = NULL, steam_name = NULL WHERE id = ${req.actor!.id}`;
    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'user.steam_unlinked',
      ip: req.ip,
    });
    return { ok: true };
  });

  /**
   * Impersonation beenden: Kehrt sicher zur urspruenglichen Admin-Sitzung zurueck.
   */
  app.post('/auth/impersonate/stop', async (req, reply) => {
    const { adminId } = z.object({ adminId: z.string().uuid() }).parse(req.body);
    const [admin] = await sql<UserRow[]>`SELECT * FROM users WHERE id = ${adminId} AND role = 'admin' AND NOT suspended`;
    if (!admin) throw new HttpError(403, 'Administrator-Konto nicht gefunden', 'forbidden');

    const session = await createSession(admin.id, meta(req));
    setRefreshCookie(reply, session.refreshToken);
    const accessToken = await signAccessToken({ sub: admin.id, sid: session.sessionId });

    await writeAudit({
      userId: admin.id,
      actorName: admin.username,
      action: 'admin.impersonate_stop',
      ip: req.ip,
    });

    return {
      accessToken,
      user: publicUser(admin),
      permissions: globalPermissions(admin as any),
    };
  });

  app.get('/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const sessions = await listActiveSessions(req.actor!.id);
    // Die aktuelle Sitzung markieren, damit die Oberflaeche "dieses Geraet" anzeigen kann.
    const [current] = await sql<{ family_id: string }[]>`SELECT family_id FROM sessions WHERE id = ${req.actor!.sessionId}`;
    return {
      sessions: sessions.map(({ family_id, ...s }) => ({ ...s, current: family_id === current?.family_id })),
    };
  });

  /** Ein einzelnes Geraet abmelden (z. B. das verlorene Handy). */
  app.delete<{ Params: { id: string } }>('/auth/sessions/:id', { preHandler: requireAuth }, async (req) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'Sitzung nicht gefunden', 'not_found');
    const [s] = await sql`SELECT 1 FROM sessions WHERE id = ${req.params.id} AND user_id = ${req.actor!.id}`;
    if (!s) throw new HttpError(404, 'Sitzung nicht gefunden', 'not_found');
    await revokeSessionFamily(req.params.id, 'revoked_by_user');
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'auth.session_revoked', ip: req.ip });
    return { ok: true };
  });

  app.post('/auth/password', { preHandler: requireAuth }, async (req, reply) => {
    const body = passwordBody.parse(req.body);
    const [u] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${req.actor!.id}`;
    if (!u || !(await verifyPassword(u.password_hash, body.currentPassword))) {
      throw new HttpError(400, 'Aktuelles Passwort ist falsch', 'invalid_password');
    }
    try {
      await setPassword(req.actor!.id, body.newPassword);
    } catch (err) {
      if (err instanceof UserInputError) throw new HttpError(400, err.message, 'invalid_input');
      throw err;
    }
    // Alle Sitzungen enden - auch diese. Der Client meldet sich neu an.
    await revokeAllUserSessions(req.actor!.id, 'password_changed');
    clearRefreshCookie(reply);
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'auth.password_changed', ip: req.ip });
    return { ok: true };
  });

  // ---------------------------------------------------------- Zwei-Faktor

  const confirmBody = z.object({
    password: z.string().min(1).max(256),
    totp: z.string().max(10).optional(),
    recoveryCode: z.string().max(40).optional(),
  });

  /** Abschalten und neue Codes verlangen Passwort UND zweiten Faktor - ein offener Browser allein reicht nicht. */
  async function confirmIdentity(userId: string, body: z.infer<typeof confirmBody>) {
    const [u] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${userId}`;
    if (!u || !(await verifyPassword(u.password_hash, body.password))) {
      throw new HttpError(400, 'Passwort ist falsch', 'invalid_password');
    }
    const f = await checkSecondFactor(userId, { totp: body.totp, recoveryCode: body.recoveryCode });
    if (!f.ok) throw new HttpError(400, 'Code ungueltig oder schon benutzt', 'totp_invalid');
  }

  function twoFactor<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err: unknown) => {
      if (err instanceof TwoFactorError) throw new HttpError(400, err.message, err.code);
      throw err;
    });
  }

  app.post('/auth/totp/setup', { preHandler: requireAuth }, async (req) => {
    const [u] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${req.actor!.id}`;
    return twoFactor(() => startTotpSetup(req.actor!.id, u!.email));
  });

  app.post('/auth/totp/enable', { preHandler: requireAuth }, async (req) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(req.body);
    const codes = await twoFactor(() => enableTotp(req.actor!.id, code));
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'auth.totp_enabled', ip: req.ip });
    return { enabled: true, recoveryCodes: codes };
  });

  app.post('/auth/totp/disable', { preHandler: requireAuth }, async (req) => {
    const body = confirmBody.parse(req.body);
    await confirmIdentity(req.actor!.id, body);
    await disableTotp(req.actor!.id);
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'auth.totp_disabled', ip: req.ip });
    return { enabled: false };
  });

  app.post('/auth/totp/recovery-codes', { preHandler: requireAuth }, async (req) => {
    const body = confirmBody.parse(req.body);
    const [u] = await sql<{ totp_enabled: boolean }[]>`SELECT totp_enabled FROM users WHERE id = ${req.actor!.id}`;
    if (!u?.totp_enabled) throw new HttpError(400, 'Zwei-Faktor ist nicht aktiv', 'totp_not_enabled');
    await confirmIdentity(req.actor!.id, body);
    const codes = await regenerateRecoveryCodes(req.actor!.id);
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'auth.recovery_codes_regenerated', ip: req.ip });
    return { recoveryCodes: codes };
  });

  /** Katalog der Rechte fuer die Oberflaeche - Flags, Beschriftungen, Presets. */
  app.get('/auth/permissions', { preHandler: requireAuth }, async () => ({
    flags: SERVER_FLAGS.map((f) => ({ flag: f, label: FLAG_LABELS[f] })),
    presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, flags: p.flags })),
  }));
}
