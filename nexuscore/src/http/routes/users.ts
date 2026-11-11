import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { GLOBAL_PERMISSIONS, SERVER_FLAGS, isServerFlag } from '../../auth/permissions.js';
import type { HostDriver } from '../../drivers/interface.js';
import { revokeUserSessions } from '../../protocol/security.js';
import { AccountError, type AccountUser, type LocalAccount } from '../../store/account.js';
import { getAccess, removeUserAccess, serversOfUser, setOwner, setSubuserFlags } from '../../store/access.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Benutzerverwaltung (Admin) - dieselben Routen und Antworten wie im Panel
 * (Seite "Benutzer & Rechte"). Nur Administratoren: wer Benutzer verwalten darf,
 * koennte sich sonst selbst zum Administrator machen.
 */

const GLOBAL_SET = new Set<string>(GLOBAL_PERMISSIONS);

const globalPerms = z
  .array(z.string().min(1))
  .max(50)
  .transform((list) => [...new Set(list.filter((p) => GLOBAL_SET.has(p)))]);

const newUserBody = z.object({
  username: z.string().min(3).max(32),
  email: z.string().max(254).nullable().optional(),
  password: z.string().max(256).optional(),
  steamId: z.string().max(32).nullable().optional(),
  role: z.enum(['admin', 'moderator', 'user']).default('user'),
  canCreateServers: z.boolean().default(false),
  globalPermissions: globalPerms.optional(),
  allowedEggs: z.array(z.string().min(1)).nullable().optional(),
});

const patchUserBody = z
  .object({
    email: z.string().max(254).nullable().optional(),
    role: z.enum(['admin', 'moderator', 'user']).optional(),
    steamId: z.string().max(32).nullable().optional(),
    canCreateServers: z.boolean().optional(),
    globalPermissions: globalPerms.optional(),
    suspended: z.boolean().optional(),
    serverLimit: z.number().int().min(0).max(10_000).optional(),
    ramLimitMb: z.number().int().min(0).optional(),
    diskLimitMb: z.number().int().min(0).optional(),
    allowedEggs: z.array(z.string().min(1)).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nichts zu aendern');

const assignBody = z.object({
  isOwner: z.boolean().optional(),
  permissions: z.array(z.string()).max(100).optional(),
});

function fail(reply: FastifyReply, status: number, message: string, code: string): FastifyReply {
  return reply.status(status).send({ error: message, message, code });
}

export function registerUserRoutes(
  server: FastifyInstance,
  deps: { registry: ServerRegistry; driver: HostDriver; account: LocalAccount | null },
): void {
  const { registry, driver, account } = deps;
  if (!account) return;

  const guarded = async <T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AccountError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  };

  /** Die Zeile der Benutzerliste: Konto plus, was ihm gehoert. */
  const row = (u: AccountUser) => {
    const owned = serversOfUser(registry, u.id).filter((s) => s.isOwner);
    const ramUsedMb = owned.reduce((sum, s) => sum + (registry.get(s.serverId)?.maxMemoryMb ?? 0), 0);
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      canCreateServers: u.canCreateServers,
      globalPermissions: u.globalPermissions,
      suspended: u.suspended,
      totpEnabled: u.totpEnabled,
      serverLimit: u.serverLimit,
      ramLimitMb: u.ramLimitMb,
      diskLimitMb: u.diskLimitMb,
      allowedEggs: u.allowedEggs,
      steamId: u.steamId,
      steamName: u.steamName,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      lastSeenAt: null,
      online: false,
      presence: null,
      servers: owned.length,
      ramUsedMb,
    };
  };

  const target = (id: string, reply: FastifyReply): AccountUser | null => {
    const u = account.get(id);
    if (!u) {
      fail(reply, 404, 'Nutzer nicht gefunden', 'not_found');
      return null;
    }
    return u;
  };

  server.get('/api/v1/admin/users', async () => ({ users: account.list().map(row) }));

  server.post<{ Body: unknown }>('/api/v1/admin/users', async (req, reply) => {
    const body = newUserBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    const b = body.data;
    return guarded(reply, async () => {
      const { user, password, generated } = await account.create({
        username: b.username,
        email: b.email ?? null,
        ...(b.password ? { password: b.password } : {}),
        role: b.role,
        canCreateServers: b.canCreateServers || (b.globalPermissions?.includes('server.create') ?? false),
        ...(b.globalPermissions !== undefined ? { globalPermissions: b.globalPermissions } : {}),
        ...(b.allowedEggs !== undefined ? { allowedEggs: b.allowedEggs } : {}),
        ...(b.steamId ? { steamId: b.steamId } : {}),
      });
      registry.audit('user.create', null, 'standalone', { username: user.username, role: user.role });
      reply.code(201);
      // Das erzeugte Passwort wird genau einmal zurueckgegeben - weder gespeichert noch protokolliert
      return { user: row(user), ...(generated ? { password } : {}) };
    });
  });

  server.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/admin/users/:id', async (req, reply) => {
    const u = target(req.params.id, reply);
    if (!u) return reply;
    const body = patchUserBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    const b = body.data;
    return guarded(reply, async () => {
      const canCreate =
        b.canCreateServers !== undefined ? b.canCreateServers : b.globalPermissions ? b.globalPermissions.includes('server.create') : undefined;
      await account.update(u.id, {
        ...(b.email !== undefined ? { email: b.email } : {}),
        ...(b.role !== undefined ? { role: b.role } : {}),
        ...(canCreate !== undefined ? { canCreateServers: canCreate } : {}),
        ...(b.globalPermissions !== undefined ? { globalPermissions: b.globalPermissions } : {}),
        ...(b.suspended !== undefined ? { suspended: b.suspended } : {}),
        ...(b.serverLimit !== undefined ? { serverLimit: b.serverLimit } : {}),
        ...(b.ramLimitMb !== undefined ? { ramLimitMb: b.ramLimitMb } : {}),
        ...(b.diskLimitMb !== undefined ? { diskLimitMb: b.diskLimitMb } : {}),
        ...(b.allowedEggs !== undefined ? { allowedEggs: b.allowedEggs } : {}),
        ...(b.steamId !== undefined ? { steamId: b.steamId } : {}),
      });
      // Gesperrt heisst: sofort raus, auch aus offenen Sitzungen
      if (b.suspended) revokeUserSessions(u.id);
      registry.audit('user.update', null, 'standalone', { target: u.username, ...b });
      return { ok: true };
    });
  });

  server.post<{ Params: { id: string }; Body: unknown }>('/api/v1/admin/users/:id/reset-password', async (req, reply) => {
    const u = target(req.params.id, reply);
    if (!u) return reply;
    const body = z.object({ password: z.string().max(256).optional() }).safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    const given = body.data.password?.trim();
    return guarded(reply, async () => {
      const res = await account.resetPassword(u.id, given || undefined);
      revokeUserSessions(u.id);
      registry.audit('user.password_reset', null, 'standalone', { target: u.username, generated: res.generated });
      return { ok: true, password: res.password, generated: res.generated, username: u.username };
    });
  });

  server.post<{ Params: { id: string } }>('/api/v1/admin/users/:id/reset-2fa', async (req, reply) => {
    const u = target(req.params.id, reply);
    if (!u) return reply;
    await account.resetTotp(u.id);
    revokeUserSessions(u.id);
    registry.audit('user.reset_2fa', null, 'standalone', { target: u.username });
    return { ok: true };
  });

  server.delete<{ Params: { id: string } }>('/api/v1/admin/users/:id', async (req, reply) => {
    const u = target(req.params.id, reply);
    if (!u) return reply;
    if (u.id === req.actor?.id) return fail(reply, 409, 'Das eigene Konto loescht man nicht hier', 'self');
    const owned = serversOfUser(registry, u.id).filter((s) => s.isOwner).length;
    if (owned > 0) return fail(reply, 409, `Besitzt noch ${owned} Server - erst uebertragen oder loeschen`, 'in_use');
    return guarded(reply, async () => {
      await account.remove(u.id);
      revokeUserSessions(u.id);
      removeUserAccess(registry, u.id);
      registry.audit('user.delete', null, 'standalone', { target: u.username });
      return { ok: true };
    });
  });

  // ------------------------------------------------- Server eines Benutzers

  server.get<{ Params: { id: string } }>('/api/v1/admin/users/:id/servers', async (req, reply) => {
    const u = target(req.params.id, reply);
    if (!u) return reply;
    const states = new Map((await driver.listServers().catch(() => [])).map((s) => [s.id, s.status]));
    return {
      servers: registry.list().map((c) => {
        const access = getAccess(registry, c.id);
        const isOwner = access.ownerId === u.id;
        const flags = access.subusers[u.id];
        return {
          id: c.id,
          shortId: c.id.slice(0, 8),
          name: c.name,
          status: states.get(c.id) ?? 'offline',
          eggName: c.game || 'Eigener Gameserver',
          ownerId: access.ownerId ?? '',
          ownerName: (access.ownerId ? account.get(access.ownerId)?.username : undefined) ?? 'Admin',
          isOwner,
          isSubuser: !isOwner && flags !== undefined,
          permissions: isOwner ? [...SERVER_FLAGS] : (flags ?? []),
        };
      }),
    };
  });

  /** Einem Benutzer Zugriff an einem Server geben, aendern oder entziehen. */
  server.put<{ Params: { id: string; serverId: string }; Body: unknown }>('/api/v1/admin/users/:id/servers/:serverId', async (req, reply) => {
    const u = target(req.params.id, reply);
    if (!u) return reply;
    const c = registry.get(req.params.serverId) ?? registry.list().find((x) => x.id.startsWith(req.params.serverId) && req.params.serverId.length === 8);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const body = assignBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');

    if (body.data.isOwner === true) {
      if (u.suspended) return fail(reply, 409, 'Gesperrten Nutzern kann kein Server übertragen werden', 'suspended');
      const previous = getAccess(registry, c.id).ownerId;
      setOwner(registry, c.id, u.id);
      setSubuserFlags(registry, c.id, u.id, null);
      registry.audit('server.transfer_owner', c.id, 'standalone', { newOwner: u.username, previousOwner: previous });
      return { ok: true, isOwner: true, permissions: [...SERVER_FLAGS] };
    }

    if (getAccess(registry, c.id).ownerId === u.id) {
      return fail(reply, 409, 'Dieser Nutzer ist Hauptbesitzer. Um ihn zum Mitnutzer zu machen, übertrage den Server erst einem anderen Besitzer.', 'is_owner');
    }

    const flags = [...new Set((body.data.permissions ?? []).filter(isServerFlag))];
    if (flags.length === 0) {
      setSubuserFlags(registry, c.id, u.id, null);
      registry.audit('subuser.delete', c.id, 'standalone', { user: u.username, via: 'admin_assign' });
      return { ok: true, isOwner: false, isSubuser: false, permissions: [] };
    }
    setSubuserFlags(registry, c.id, u.id, flags);
    registry.audit('subuser.update', c.id, 'standalone', { user: u.username, permissions: flags, via: 'admin_assign' });
    return { ok: true, isOwner: false, isSubuser: true, permissions: flags };
  });
}
