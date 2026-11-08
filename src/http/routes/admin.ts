import type { FastifyInstance } from 'fastify';
import { networkCheck } from '../../netcheck.js';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, requireAdmin } from '../auth.js';
import { createUser, publicUser, UserInputError } from '../../auth/users.js';
import { revokeAllUserSessions } from '../../auth/sessions.js';
import { disableTotp } from '../../auth/twofactor.js';
import { writeAudit } from '../../audit.js';
import { isServerFlag, SERVER_FLAGS } from '../../auth/permissions.js';
import { getSetting, setSetting, DISCORD_WEBHOOK_URL, DISCORD_NOTIFICATIONS_ENABLED, PLAYIT_SECRET_KEY } from '../../settings.js';
import { sendDiscordWebhook } from '../../notifications/discord.js';
import {
  getTestReportsDir,
  getTestState,
  isTestRunning,
  startTestRunner,
  stopTestRunner,
} from '../../servers/test-runner.js';

export const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(100),
  before: z.coerce.number().int().positive().optional(),
  action: z.string().max(64).optional(),
  search: z.string().max(128).optional(),
  userId: z.string().uuid().optional(),
  serverId: z.string().uuid().optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  /** Globales Audit-Log. Filter nach Aktion (Praefix, z. B. "auth."), Suche, Nutzer und Server. */
  app.get('/admin/audit', { preHandler: requireAdmin() }, async (req) => {
    const q = auditQuery.parse(req.query);
    const rows = await sql<{
      id: string; created_at: Date; action: string; actor_name: string | null; user_id: string | null;
      server_id: string | null; server_name: string | null; metadata: unknown; ip: string | null;
    }[]>`
      SELECT a.id, a.created_at, a.action, a.actor_name, a.user_id, a.server_id, s.name AS server_name,
             a.metadata, host(a.ip) AS ip
      FROM audit_log a LEFT JOIN servers s ON s.id = a.server_id
      WHERE true
        ${q.before ? sql`AND a.id < ${q.before}` : sql``}
        ${q.action ? sql`AND a.action LIKE ${q.action.replace(/[%_]/g, '') + '%'}` : sql``}
        ${q.userId ? sql`AND a.user_id = ${q.userId}` : sql``}
        ${q.serverId ? sql`AND a.server_id = ${q.serverId}` : sql``}
        ${q.search ? sql`AND (
          a.action ILIKE ${'%' + q.search + '%'} OR
          a.actor_name ILIKE ${'%' + q.search + '%'} OR
          s.name ILIKE ${'%' + q.search + '%'} OR
          a.metadata::text ILIKE ${'%' + q.search + '%'}
        )` : sql``}
      ORDER BY a.id DESC LIMIT ${q.limit}
    `;

    // Statistiken fuer das Dashboard
    const [[statsToday], [statsTotal]] = await Promise.all([
      sql<{ total_today: number; unique_actors: number; unique_servers: number }[]>`
        SELECT
          COUNT(*)::int AS total_today,
          COUNT(DISTINCT actor_name)::int AS unique_actors,
          COUNT(DISTINCT server_id)::int AS unique_servers
        FROM audit_log
        WHERE created_at >= current_date
      `,
      sql<{ total_all: number }[]>`
        SELECT COUNT(*)::int AS total_all FROM audit_log
      `,
    ]);

    return {
      entries: rows.map((r) => ({ ...r, id: Number(r.id) })),
      nextBefore: rows.length === q.limit ? Number(rows[rows.length - 1]!.id) : null,
      stats: {
        totalToday: statsToday?.total_today ?? 0,
        totalAll: statsTotal?.total_all ?? 0,
        uniqueActorsToday: statsToday?.unique_actors ?? 0,
        uniqueServersToday: statsToday?.unique_servers ?? 0,
      },
    };
  });

  /** Spiele-Testbericht und Status abfragen */
  app.get('/admin/test-report', { preHandler: requireAdmin() }, async () => {
    let jsonReport: unknown = null;
    let markdownReport: string | null = null;
    let logTail: string | null = null;

    const reportsDir = getTestReportsDir();

    try {
      const jsonContent = await readFile(join(reportsDir, 'game-install-results.json'), 'utf8');
      jsonReport = JSON.parse(jsonContent);
    } catch {}

    try {
      markdownReport = await readFile(join(reportsDir, 'GAME-INSTALL-TESTS.md'), 'utf8');
    } catch {}

    try {
      const logContent = await readFile(join(reportsDir, 'test-games.log'), 'utf8');
      logTail = logContent.split('\n').filter(Boolean).slice(-40).join('\n');
    } catch {}

    const state = await getTestState();

    return {
      isRunning: isTestRunning() || state.status === 'running',
      startedAt: state.startedAt,
      currentEgg: state.currentEgg,
      currentEggIndex: state.currentEggIndex,
      totalEggs: state.totalEggs,
      status: state.status,
      mode: state.mode,
      cpuPercent: state.cpuPercent,
      ramMb: state.ramMb,
      jsonReport,
      markdownReport,
      logTail,
    };
  });

  const testGamesBody = z.object({
    mode: z.enum(['resume', 'fresh', 'retry-failed']).default('resume'),
    only: z.string().optional(),
    timeout: z.number().int().min(1).max(120).optional(),
    cpuPercent: z.number().int().min(0).max(3200).optional(),
    ramMb: z.number().int().min(2048).max(65536).optional(),
  }).optional();

  /** Testlauf im Hintergrund starten oder fortsetzen */
  app.post('/admin/test-games', { preHandler: requireAdmin() }, async (req) => {
    if (isTestRunning()) {
      throw new HttpError(409, 'Ein Testlauf läuft bereits im Hintergrund', 'conflict');
    }

    const body = testGamesBody.parse(req.body) ?? { mode: 'resume' };

    const res = await startTestRunner({
      mode: body.mode,
      only: body.only,
      timeout: body.timeout,
      cpuPercent: body.cpuPercent,
      ramMb: body.ramMb,
    });

    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'games.test_started',
      metadata: { mode: body.mode, cpuPercent: body.cpuPercent, ramMb: body.ramMb },
      ip: req.ip,
    });

    return { ok: true, startedAt: res.startedAt, mode: body.mode };
  });

  /** Testlauf anhalten */
  app.post('/admin/test-games/stop', { preHandler: requireAdmin() }, async (req) => {
    await stopTestRunner();

    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'games.test_stopped',
      ip: req.ip,
    });

    return { ok: true };
  });
}

// ------------------------------------------------------------------ Nutzer

export const newUserBody = z.object({
  username: z.string().min(3).max(32),
  email: z.string().email().max(254),
  password: z.string().max(256).optional(),
  role: z.enum(['admin', 'moderator', 'user']).default('user'),
  canCreateServers: z.boolean().default(false),
  allowedEggs: z.array(z.string().min(1)).nullable().optional(),
});

export const patchUserBody = z.object({
  role: z.enum(['admin', 'moderator', 'user']).optional(),
  canCreateServers: z.boolean().optional(),
  suspended: z.boolean().optional(),
  serverLimit: z.number().int().min(0).max(10_000).optional(),
  ramLimitMb: z.number().int().min(0).optional(),
  diskLimitMb: z.number().int().min(0).optional(),
  allowedEggs: z.array(z.string().min(1)).nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nichts zu aendern');

export async function adminUserRoutes(app: FastifyInstance) {
  app.get('/admin/users', { preHandler: requireAdmin() }, async () => {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT u.id, u.username, u.email, u.role, u.can_create_servers AS "canCreateServers", u.suspended,
             u.totp_enabled AS "totpEnabled", u.server_limit AS "serverLimit", u.ram_limit_mb AS "ramLimitMb",
             u.disk_limit_mb AS "diskLimitMb", u.allowed_eggs AS "allowedEggs", u.created_at AS "createdAt", u.last_login_at AS "lastLoginAt",
             (SELECT count(*)::int FROM servers s WHERE s.owner_id = u.id) AS servers,
             (SELECT coalesce(sum(s.ram_mb), 0)::int FROM servers s WHERE s.owner_id = u.id) AS "ramUsedMb"
      FROM users u ORDER BY u.created_at`;
    return { users: rows };
  });

  app.post('/admin/users', { preHandler: requireAdmin() }, async (req, reply) => {
    const body = newUserBody.parse(req.body);
    const generated = !body.password;
    const password = body.password ?? randomBytes(18).toString('base64url');
    let u;
    try {
      u = await createUser({
        username: body.username,
        email: body.email,
        password,
        role: body.role,
        canCreateServers: body.canCreateServers,
        allowedEggs: body.allowedEggs,
      });
    } catch (err) {
      if (err instanceof UserInputError) throw new HttpError(400, err.message, 'invalid_input');
      throw err;
    }
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'user.create', ip: req.ip,
      metadata: { username: u.username, role: u.role } });
    reply.code(201);
    return { user: publicUser(u), ...(generated ? { password } : {}) };
  });

  app.patch<{ Params: { id: string } }>('/admin/users/:id', { preHandler: requireAdmin() }, async (req) => {
    const body = patchUserBody.parse(req.body);
    const id = uuidParam(req.params.id);
    const [u] = await sql<{ id: string; username: string; role: string }[]>`SELECT id, username, role FROM users WHERE id = ${id}`;
    if (!u) throw new HttpError(404, 'Nutzer nicht gefunden', 'not_found');

    // Aussperren verhindern: der letzte aktive Admin bleibt Admin und aktiv.
    const losesAdmin = u.role === 'admin' && ((body.role && body.role !== 'admin') || body.suspended === true);
    if (losesAdmin) {
      const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT suspended AND id <> ${id}`;
      if (n!.n === 0) throw new HttpError(409, 'Das ist der letzte Admin - erst einen anderen ernennen', 'last_admin');
    }

    await sql`
      UPDATE users SET
        role = ${body.role ?? sql`role`},
        can_create_servers = ${body.canCreateServers ?? sql`can_create_servers`},
        suspended = ${body.suspended ?? sql`suspended`},
        server_limit = ${body.serverLimit ?? sql`server_limit`},
        ram_limit_mb = ${body.ramLimitMb ?? sql`ram_limit_mb`},
        disk_limit_mb = ${body.diskLimitMb ?? sql`disk_limit_mb`},
        allowed_eggs = ${body.allowedEggs !== undefined ? (body.allowedEggs ? sql.json(body.allowedEggs) : null) : sql`allowed_eggs`}
      WHERE id = ${id}`;
    if (body.suspended) await revokeAllUserSessions(id, 'suspended');
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'user.update', ip: req.ip,
      metadata: { target: u.username, ...body } });
    return { ok: true };
  });

  /** Handy weg und keine Wiederherstellungscodes mehr: Admin schaltet 2FA ab. */
  app.post<{ Params: { id: string } }>('/admin/users/:id/reset-2fa', { preHandler: requireAdmin() }, async (req) => {
    const id = uuidParam(req.params.id);
    const [u] = await sql<{ username: string }[]>`SELECT username FROM users WHERE id = ${id}`;
    if (!u) throw new HttpError(404, 'Nutzer nicht gefunden', 'not_found');
    await disableTotp(id);
    await revokeAllUserSessions(id, '2fa_reset');
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'user.reset_2fa', ip: req.ip, metadata: { target: u.username } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/admin/users/:id', { preHandler: requireAdmin() }, async (req) => {
    const id = uuidParam(req.params.id);
    if (id === req.actor!.id) throw new HttpError(409, 'Das eigene Konto loescht man nicht hier', 'self');
    const [u] = await sql<{ username: string; servers: number }[]>`
      SELECT username, (SELECT count(*)::int FROM servers s WHERE s.owner_id = users.id) AS servers FROM users WHERE id = ${id}`;
    if (!u) throw new HttpError(404, 'Nutzer nicht gefunden', 'not_found');
    if (u.servers > 0) throw new HttpError(409, `Besitzt noch ${u.servers} Server - erst uebertragen oder loeschen`, 'in_use');
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'user.delete', ip: req.ip, metadata: { target: u.username } });
    await sql`DELETE FROM users WHERE id = ${id}`;
    return { ok: true };
  });

  /** Server und Zugriffsrechte fuer einen bestimmten Nutzer auflisten (AMP-Stil Zuweisung) */
  app.get<{ Params: { id: string } }>('/admin/users/:id/servers', { preHandler: requireAdmin() }, async (req) => {
    const userId = uuidParam(req.params.id);
    const [user] = await sql<{ id: string; username: string }[]>`SELECT id, username FROM users WHERE id = ${userId}`;
    if (!user) throw new HttpError(404, 'Nutzer nicht gefunden', 'not_found');

    const rows = await sql<{
      id: string; short_id: string; name: string; status: string;
      egg_name: string; owner_id: string; owner_name: string;
      subuser_permissions: string[] | null;
    }[]>`
      SELECT s.id, s.short_id, s.name, s.status, e.name AS egg_name,
             s.owner_id, u.username AS owner_name, su.permissions AS subuser_permissions
      FROM servers s
      JOIN eggs e ON e.id = s.egg_id
      JOIN users u ON u.id = s.owner_id
      LEFT JOIN subusers su ON su.server_id = s.id AND su.user_id = ${userId}
      ORDER BY s.name
    `;

    return {
      servers: rows.map((r) => {
        const isOwner = r.owner_id === userId;
        return {
          id: r.id,
          shortId: r.short_id,
          name: r.name,
          status: r.status,
          eggName: r.egg_name,
          ownerId: r.owner_id,
          ownerName: r.owner_name,
          isOwner,
          isSubuser: !isOwner && r.subuser_permissions !== null,
          permissions: isOwner ? [...SERVER_FLAGS] : (r.subuser_permissions ?? []),
        };
      }),
    };
  });

  /** Einem Nutzer Zugriff / Rechte an einem Server zuweisen oder entziehen (AMP-Stil) */
  app.put<{ Params: { id: string; serverId: string }; Body: { isOwner?: boolean; permissions?: string[] } }>(
    '/admin/users/:id/servers/:serverId',
    { preHandler: requireAdmin() },
    async (req) => {
      const userId = uuidParam(req.params.id);
      const serverId = uuidParam(req.params.serverId);
      const body = req.body ?? {};

      const [user] = await sql<{ id: string; username: string; suspended: boolean }[]>`SELECT id, username, suspended FROM users WHERE id = ${userId}`;
      if (!user) throw new HttpError(404, 'Nutzer nicht gefunden', 'not_found');

      const [server] = await sql<{ id: string; name: string; short_id: string; owner_id: string }[]>`SELECT id, name, short_id, owner_id FROM servers WHERE id = ${serverId}`;
      if (!server) throw new HttpError(404, 'Server nicht gefunden', 'not_found');

      if (body.isOwner === true) {
        if (user.suspended) throw new HttpError(409, 'Gesperrten Nutzern kann kein Server übertragen werden', 'suspended');
        await sql`UPDATE servers SET owner_id = ${userId} WHERE id = ${serverId}`;
        await sql`DELETE FROM subusers WHERE server_id = ${serverId} AND user_id = ${userId}`;
        await writeAudit({
          userId: req.actor!.id,
          actorName: req.actor!.username,
          serverId,
          action: 'server.transfer_owner',
          ip: req.ip,
          metadata: { newOwner: user.username, previousOwner: server.owner_id },
        });
        return { ok: true, isOwner: true, permissions: [...SERVER_FLAGS] };
      }

      if (server.owner_id === userId) {
        throw new HttpError(409, 'Dieser Nutzer ist Hauptbesitzer. Um ihn zum Mitnutzer zu machen, übertrage den Server erst einem anderen Besitzer.', 'is_owner');
      }

      const flags = (body.permissions ?? []).filter(isServerFlag);

      if (flags.length === 0) {
        // Kein Zugriff / entfernen
        await sql`DELETE FROM subusers WHERE server_id = ${serverId} AND user_id = ${userId}`;
        await writeAudit({
          userId: req.actor!.id,
          actorName: req.actor!.username,
          serverId,
          action: 'subuser.delete',
          ip: req.ip,
          metadata: { user: user.username, via: 'admin_assign' },
        });
        return { ok: true, isOwner: false, isSubuser: false, permissions: [] };
      }

      // Als Subuser mit den angegebenen Rechten eintragen / updaten
      await sql`
        INSERT INTO subusers (server_id, user_id, permissions, invited_by)
        VALUES (${serverId}, ${userId}, ${flags}, ${req.actor!.id})
        ON CONFLICT (server_id, user_id)
        DO UPDATE SET permissions = EXCLUDED.permissions
      `;

      await writeAudit({
        userId: req.actor!.id,
        actorName: req.actor!.username,
        serverId,
        action: 'subuser.update',
        ip: req.ip,
        metadata: { user: user.username, permissions: flags, via: 'admin_assign' },
      });

      return { ok: true, isOwner: false, isSubuser: true, permissions: flags };
    }
  );

  app.get('/admin/nodes', { preHandler: requireAdmin() }, async () => {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT n.id, n.name, n.fqdn, n.ram_total_mb AS "ramTotalMb", n.disk_total_mb AS "diskTotalMb",
             n.public_host AS "publicHost", n.port_from AS "portFrom", n.port_to AS "portTo",
             (SELECT coalesce(sum(s.ram_mb), 0)::int FROM servers s WHERE s.node_id = n.id) AS "ramAssignedMb",
             (SELECT count(*)::int FROM servers s WHERE s.node_id = n.id) AS servers
      FROM nodes n ORDER BY n.created_at`;
    return { nodes: rows };
  });
}

export const patchNodeBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  /** Domain oder IP, unter der Spieler die Server erreichen - ohne Port. null = Adresse des Panels. */
  publicHost: z.string().trim().max(253)
    .regex(/^[a-zA-Z0-9.-]+$|^[0-9a-fA-F:]+$/, 'Nur Domain oder IP, ohne Port und ohne http://')
    .nullable().optional(),
  portFrom: z.number().int().min(1024).max(65535).nullable().optional(),
  portTo: z.number().int().min(1024).max(65535).nullable().optional(),
}).refine((b) => (b.portFrom === undefined) === (b.portTo === undefined), 'portFrom und portTo nur zusammen')
  .refine((b) => (b.portFrom === null) === (b.portTo === null), 'Bereich entweder ganz setzen oder ganz leeren')
  .refine((b) => b.portFrom == null || b.portTo == null || b.portTo >= b.portFrom, 'Ende muss nach dem Anfang liegen')
  .refine((b) => b.portFrom == null || b.portTo == null || b.portTo - b.portFrom <= 10_000, 'Hoechstens 10.000 Ports');

export const pruneBody = z.object({ images: z.boolean().default(true), buildCache: z.boolean().default(true) });

export async function adminNetworkRoutes(app: FastifyInstance) {
  /** Docker aufraeumen: ungenutzte Images, Build-Cache. Spielserver und ihre Daten bleiben unberuehrt. */
  app.post('/admin/docker/prune', { preHandler: requireAdmin() }, async (req) => {
    const body = pruneBody.parse(req.body ?? {});
    const { engine } = await import('../../docker/client.js');
    const r = await engine.prune(body);
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'docker.prune', ip: req.ip, metadata: { ...body, ...r } });
    const { diskCollector } = await import('../../servers/stats.js');
    void diskCollector.measureAll();
    return r;
  });

  /** Verbindungstest: DNS, HTTPS zu Epic, ausgehende Adresse, Uhrzeit. */
  app.get('/admin/network/check', { preHandler: requireAdmin() }, async () => {
    const [n] = await sql<{ public_host: string | null }[]>`SELECT public_host FROM nodes ORDER BY created_at LIMIT 1`;
    return { results: await networkCheck(n?.public_host ?? null) };
  });

  app.patch<{ Params: { id: string } }>('/admin/nodes/:id', { preHandler: requireAdmin() }, async (req) => {
    const id = uuidParam(req.params.id);
    const body = patchNodeBody.parse(req.body);
    const [n] = await sql`SELECT 1 FROM nodes WHERE id = ${id}`;
    if (!n) throw new HttpError(404, 'Host nicht gefunden', 'not_found');
    await sql`
      UPDATE nodes SET
        name = ${body.name ?? sql`name`},
        public_host = ${body.publicHost === undefined ? sql`public_host` : body.publicHost || null},
        port_from = ${body.portFrom === undefined ? sql`port_from` : body.portFrom},
        port_to = ${body.portTo === undefined ? sql`port_to` : body.portTo}
      WHERE id = ${id}`;
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'node.update', ip: req.ip, metadata: body });
    // Server, deren Ports ausserhalb des neuen Bereichs liegen, behalten sie
    // (Umzug waere ein Eingriff in laufende Server) - die Antwort nennt sie.
    const outside = await sql<{ name: string; port: number }[]>`
      SELECT s.name, a.port FROM allocations a JOIN servers s ON s.id = a.server_id JOIN nodes n ON n.id = a.node_id
      WHERE a.node_id = ${id} AND n.port_from IS NOT NULL AND (a.port < n.port_from OR a.port > n.port_to)
      ORDER BY a.port`;
    return { ok: true, outside };
  });

  /** Alle vergebenen und gesperrten Ports - die Netzwerk-Uebersicht. */
  app.get('/admin/allocations', { preHandler: requireAdmin() }, async () => {
    const rows = await sql<{ port: number; protocol: string; ref: string | null; is_primary: boolean; blocked_until: Date | null;
      server_id: string | null; short_id: string | null; server_name: string | null; status: string | null; owner: string | null;
      node: string; public_host: string | null; port_from: number | null; port_to: number | null }[]>`
      SELECT a.port, a.protocol, a.ref, a.is_primary, a.blocked_until, a.server_id, s.short_id, s.name AS server_name, s.status,
             u.username AS owner, n.name AS node, n.public_host, n.port_from, n.port_to
      FROM allocations a
      JOIN nodes n ON n.id = a.node_id
      LEFT JOIN servers s ON s.id = a.server_id
      LEFT JOIN users u ON u.id = s.owner_id
      WHERE a.server_id IS NOT NULL OR a.blocked_until > now()
      ORDER BY a.port`;
    return {
      allocations: rows.map((r) => ({
        port: r.port, protocol: r.protocol, ref: r.ref, primary: r.is_primary,
        server: r.server_id ? { id: r.server_id, shortId: r.short_id, name: r.server_name, status: r.status, owner: r.owner } : null,
        cooldownUntil: r.server_id ? null : r.blocked_until,
        node: r.node,
        inRange: r.port_from === null || (r.port >= r.port_from && r.port <= (r.port_to ?? r.port)),
      })),
    };
  });

  /** Integrationen (Discord Webhooks & Tunneling) abrufen */
  app.get('/admin/integrations', { preHandler: requireAdmin() }, async () => {
    const discordUrl = await getSetting(DISCORD_WEBHOOK_URL);
    const discordEnabled = (await getSetting(DISCORD_NOTIFICATIONS_ENABLED)) !== 'false';
    const playitKey = await getSetting(PLAYIT_SECRET_KEY);

    return {
      discord: {
        configured: !!discordUrl,
        url: discordUrl ? `${discordUrl.slice(0, 38)}...` : '',
        enabled: discordEnabled,
      },
      playit: {
        configured: !!playitKey,
        secretKey: playitKey ? `${playitKey.slice(0, 8)}...` : '',
      },
    };
  });

  /** Discord-Webhook aktualisieren */
  app.post('/admin/integrations/discord', { preHandler: requireAdmin() }, async (req) => {
    const body = z.object({
      url: z.string().trim().url().nullable().optional(),
      enabled: z.boolean().optional(),
    }).parse(req.body);

    if (body.url !== undefined) {
      await setSetting(DISCORD_WEBHOOK_URL, body.url, { secret: true, actorId: req.actor!.id });
    }
    if (body.enabled !== undefined) {
      await setSetting(DISCORD_NOTIFICATIONS_ENABLED, body.enabled ? 'true' : 'false', { actorId: req.actor!.id });
    }
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'admin.discord_update', ip: req.ip });
    return { ok: true };
  });

  /** Testnachricht an Discord schicken */
  app.post('/admin/integrations/discord/test', { preHandler: requireAdmin() }, async (req) => {
    const success = await sendDiscordWebhook({
      title: '🎉 Verbindungstest erfolgreich!',
      description: `Der Discord-Webhook von **NexusPanel** funktioniert einwandfrei.\n\n*Ausgelöst von Administrator:* **${req.actor!.username}**`,
      color: 0x10b981,
      fields: [
        { name: 'System', value: 'NexusPanel Webhook Integration', inline: true },
        { name: 'Status', value: 'Bereit & Aktiv', inline: true },
      ],
    });
    if (!success) {
      throw new HttpError(400, 'Discord-Webhook konnte nicht zugestellt werden. Bitte URL überprüfen.', 'webhook_failed');
    }
    return { ok: true };
  });

  /** Playit.gg Tunnel Secret Key konfigurieren */
  app.post('/admin/integrations/playit', { preHandler: requireAdmin() }, async (req) => {
    const body = z.object({
      secretKey: z.string().trim().nullable().optional(),
    }).parse(req.body);

    await setSetting(PLAYIT_SECRET_KEY, body.secretKey ?? null, { secret: true, actorId: req.actor!.id });
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'admin.playit_update', ip: req.ip });
    return { ok: true };
  });
}

function uuidParam(v: string): string {
  if (!z.string().uuid().safeParse(v).success) throw new HttpError(404, 'Nicht gefunden', 'not_found');
  return v;
}
