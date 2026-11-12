import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeOneTimeToken, issueOneTimeToken } from '../../auth/one-time.js';
import { globalPermissions } from '../../auth/permissions.js';
import { createSessionToken, revokeSessionToken } from '../../protocol/security.js';
import type { AccountUser, LocalAccount } from '../../store/account.js';
import { runAs } from '../../store/identity.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { RequestActor } from '../authz.js';
import { currentToken } from './account.js';

/**
 * Als anderer Benutzer ansehen (Imitation) - dieselben Routen und Antworten wie im Panel.
 *
 * Ein Administrator bekommt eine Sitzung des Zielbenutzers und ein Einmal-Token fuer den Rueckweg. Zurueck geht es nur
 * als genau dieser imitierte Benutzer UND mit dem Token (frueher reichte im Panel die Admin-ID: eine Hintertuer).
 * Beides steht im Audit-Protokoll mit dem Namen des Administrators.
 */

const RETURN_TTL_MS = 12 * 3600_000;

const publicUser = (u: AccountUser) => ({
  id: u.id,
  username: u.username,
  email: u.email,
  role: u.role,
  locale: u.locale ?? 'de',
  canCreateServers: u.role === 'admin' || u.canCreateServers,
  totpEnabled: u.totpEnabled,
  avatar: u.avatar,
  steamId: u.steamId,
  steamName: u.steamName,
});

const actorOf = (u: AccountUser): RequestActor => ({
  id: u.id,
  username: u.username,
  role: u.role,
  canCreateServers: u.canCreateServers,
  allowedEggs: u.allowedEggs,
  globalPermissions: u.globalPermissions,
  master: false,
});

export interface ImpersonateDeps {
  registry: ServerRegistry;
  account: LocalAccount;
  sessionCookie: (token: string) => string;
}

export function registerImpersonateRoutes(server: FastifyInstance, deps: ImpersonateDeps): void {
  const { registry, account, sessionCookie } = deps;

  const fail = (reply: FastifyReply, status: number, message: string, code: string): FastifyReply => reply.status(status).send({ error: message, message, code });
  const sessionFor = (req: FastifyRequest, reply: FastifyReply, user: AccountUser): string => {
    const token = createSessionToken({ userId: user.id, ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.header('Set-Cookie', sessionCookie(token));
    return token;
  };

  server.post<{ Params: { id: string } }>('/api/v1/admin/users/:id/impersonate', async (req, reply) => {
    const admin = req.actor && !req.actor.master ? account.get(req.actor.id) : undefined;
    if (!admin) return fail(reply, 400, 'Mit dem Zugriffstoken des Cores geht das nicht - bitte als Administrator-Konto anmelden.', 'needs_account');
    const target = account.get(req.params.id);
    if (!target) return fail(reply, 404, 'Nutzer nicht gefunden', 'not_found');
    if (target.suspended) return fail(reply, 403, 'Gesperrte Benutzer können nicht imitiert werden', 'suspended');
    if (target.id === admin.id) return fail(reply, 400, 'Das ist dein eigenes Konto.', 'invalid_request');

    const accessToken = sessionFor(req, reply, target);
    registry.audit('admin.impersonate_user', null, 'standalone', { targetUserId: target.id, targetUsername: target.username });
    const returnToken = issueOneTimeToken('impersonate', { adminId: admin.id, targetId: target.id }, RETURN_TTL_MS);
    return { accessToken, user: publicUser(target), originalAdmin: { id: admin.id, username: admin.username, returnToken } };
  });

  server.post<{ Body: unknown }>('/api/v1/auth/impersonate/stop', async (req, reply) => {
    const actor = req.actor;
    const body = z.object({ returnToken: z.string().min(20).max(200) }).safeParse(req.body);
    if (!actor || actor.master || !body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    const t = consumeOneTimeToken<{ adminId: string; targetId: string }>('impersonate', body.data.returnToken);
    // Nur mit dem Rueckkehr-Token UND als genau der imitierte Benutzer
    if (!t || t.targetId !== actor.id) return fail(reply, 403, 'Rückkehr nicht möglich – bitte neu anmelden', 'forbidden');
    const admin = account.get(t.adminId);
    if (!admin || admin.role !== 'admin' || admin.suspended) return fail(reply, 403, 'Administrator-Konto nicht gefunden', 'forbidden');

    // Die Imitations-Sitzung beenden, dann zur Sitzung des Administrators
    const current = currentToken(req);
    if (current) revokeSessionToken(current);
    const accessToken = sessionFor(req, reply, admin);
    runAs({ userId: admin.id, username: admin.username }, () => registry.audit('admin.impersonate_stop', null, 'standalone', { targetUserId: t.targetId }));
    return { accessToken, user: publicUser(admin), permissions: globalPermissions(actorOf(admin)) };
  });
}
