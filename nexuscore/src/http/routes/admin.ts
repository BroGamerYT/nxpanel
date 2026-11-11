import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HostDriver } from '../../drivers/interface.js';
import type { ServerRegistry } from '../../store/registry.js';
import { TesterError, type GameTester } from '../../testing/game-tester.js';

/**
 * Admin-Uebersicht und Audit-Log - dieselben Routen und Antworten wie im Panel
 * (Seiten "Admin" und "Audit"). Im Core gibt es einen lokalen Zugang, deshalb
 * kein Rechtesystem: wer angemeldet ist, ist Admin.
 */

export const CORE_VERSION = '0.2.0';

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(100),
  before: z.coerce.number().int().positive().optional(),
  action: z.string().max(64).optional(),
  search: z.string().max(128).optional(),
  serverId: z.string().max(100).optional(),
});

/** Die Oberflaeche kennt die Aktionen des Panels; der Core nennt manche anders. */
const ACTION_ALIASES: Record<string, string> = {
  'server.start': 'server.power.start',
  'server.stop': 'server.power.stop',
  'server.kill': 'server.power.kill',
  'server.restart': 'server.power.restart',
  'server.resources_update': 'server.resources',
};

const ACTOR_NAMES: Record<string, string> = { standalone: 'admin', core: 'NexusCore', panel: 'Panel' };

const testBody = z
  .object({
    mode: z.enum(['resume', 'fresh', 'retry-failed']).default('resume'),
    only: z.string().max(60).optional(),
    timeout: z.number().int().min(1).max(120).optional(),
    cpuPercent: z.number().int().min(0).max(3200).optional(),
    ramMb: z.number().int().min(2048).max(65536).optional(),
  })
  .optional();

export function registerAdminRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; driver: HostDriver; tester?: GameTester }): void {
  const { registry, driver, tester } = deps;

  server.get('/api/v1/admin/overview', async () => {
    const list = registry.list();
    let running = 0;
    for (const c of list) {
      const state = await driver.getServerState(c.id).catch(() => undefined);
      if (state?.status === 'running') running++;
    }
    return {
      version: CORE_VERSION,
      build: null,
      uptimeSeconds: Math.floor(process.uptime()),
      stats: {
        users: 1,
        serversTotal: list.length,
        serversRunning: running,
        containersTotal: 0,
        containersRunning: 0,
        auditToday: registry.auditStats().totalToday,
      },
    };
  });

  // ---------------------------------------------------------- Spiele-Testlauf

  if (tester) {
    server.get('/api/v1/admin/test-report', async () => tester.report());

    server.post<{ Body: unknown }>('/api/v1/admin/test-games', async (req, reply) => {
      const body = testBody.safeParse(req.body ?? undefined);
      if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'Ungültige Anfrage', code: 'invalid_request' });
      const options = body.data ?? { mode: 'resume' as const };
      try {
        const res = await tester.start(options);
        registry.audit('games.test_started', null, 'standalone', { mode: res.mode, ...(options.only ? { only: options.only } : {}) });
        return { ok: true, ...res };
      } catch (err) {
        if (err instanceof TesterError) return reply.status(err.statusCode).send({ error: err.message, message: err.message, code: err.code });
        throw err;
      }
    });

    server.post('/api/v1/admin/test-games/stop', async () => {
      await tester.stop();
      registry.audit('games.test_stopped', null, 'standalone');
      return { ok: true };
    });
  }

  server.get('/api/v1/admin/audit', async (req, reply) => {
    const q = auditQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: q.error.issues[0]?.message ?? 'Ungültige Anfrage', code: 'invalid_request' });
    const rows = registry.queryAudit({
      limit: q.data.limit,
      ...(q.data.before ? { before: q.data.before } : {}),
      ...(q.data.action ? { actionPrefix: q.data.action } : {}),
      ...(q.data.search ? { search: q.data.search } : {}),
      ...(q.data.serverId ? { serverId: q.data.serverId } : {}),
    });
    const names = new Map(registry.list().map((c) => [c.id, c.name]));
    const entries = rows.map((r) => ({
      id: r.id,
      created_at: r.ts,
      action: ACTION_ALIASES[r.action] ?? r.action,
      actor_name: ACTOR_NAMES[r.actor] ?? r.actor,
      user_id: null,
      server_id: r.serverId,
      // Gelöschte Server haben keinen Namen mehr - der Name steht dann im Eintrag, falls er mitgeschrieben wurde
      server_name: r.serverId ? (names.get(r.serverId) ?? (typeof r.detail?.['name'] === 'string' ? (r.detail['name'] as string) : null)) : null,
      metadata: r.detail ?? {},
      ip: null,
    }));
    return {
      entries,
      nextBefore: rows.length === q.data.limit ? rows[rows.length - 1]!.id : null,
      stats: registry.auditStats(),
    };
  });
}
