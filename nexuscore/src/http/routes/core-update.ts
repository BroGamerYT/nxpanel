import path from 'node:path';
import { z } from 'zod';
import { recentLogLines } from '../../logger.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { CoreUpdater, UpdateError, type FetchLike } from '../../update/core-update.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Core-Update (nur Administratoren): `GET /api/v1/admin/core-update` zeigt die laufende und die neueste Version von GitHub,
 * `POST /api/v1/admin/core-update/install` laedt den Installer, prueft ihn und startet ihn (unter Windows).
 */
export function registerCoreUpdateRoutes(
  server: FastifyInstance,
  deps: { registry: ServerRegistry; repo: string; enabled: boolean; fetchImpl?: FetchLike; beforeInstall?: () => Promise<void>; updater?: CoreUpdater },
): CoreUpdater {
  const { registry } = deps;
  const updater =
    deps.updater ??
    new CoreUpdater({
      repo: deps.repo,
      enabled: deps.enabled,
      dir: path.join(registry.dir, 'updates'),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.beforeInstall ? { beforeInstall: deps.beforeInstall } : {}),
      audit: (action, detail) => registry.audit(action, null, 'standalone', detail),
    });
  const fail = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof UpdateError) return reply.status(err.statusCode).send({ error: err.message, message: err.message, code: err.code });
    throw err;
  };

  server.get<{ Querystring: { refresh?: string } }>('/api/v1/admin/core-update', async (req) => updater.status(req.query.refresh === '1'));

  const logsQuery = z.object({ source: z.enum(['update', 'installer', 'core', 'audit']), lines: z.coerce.number().int().min(10).max(1000).default(200) });
  /** Die Protokolle zum Update (feste Quellen, kein frei waehlbarer Pfad). */
  server.get('/api/v1/admin/core-update/logs', async (req, reply) => {
    const q = logsQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: q.error.issues[0]?.message ?? 'Ungültige Anfrage', code: 'invalid_request' });
    const { source, lines } = q.data;
    let out: string[];
    if (source === 'update' || source === 'installer') out = await updater.logs(source, lines);
    else if (source === 'core') {
      const own = (l: string) => l.includes('/api/v1/admin/core-update');
      out = recentLogLines(lines * 2).filter((l) => !own(l)).slice(-lines).map((l) => {
        try {
          const j = JSON.parse(l) as { time?: number; msg?: string; err?: { message?: string } };
          return `${j.time ? new Date(j.time).toISOString() : ''} ${j.msg ?? l}${j.err?.message ? ` - ${j.err.message}` : ''}`.trim();
        } catch {
          return l;
        }
      });
    } else {
      out = registry.queryAudit({ limit: lines }).reverse().map((e) => `${e.ts} ${e.action} ${e.actorName ?? e.actor}${e.detail ? ' ' + JSON.stringify(e.detail) : ''}`);
    }
    return { source, lines: out };
  });

  server.post('/api/v1/admin/core-update/install', async (_req, reply) => {
    try {
      return { ok: true, ...(await updater.install()) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  return updater;
}
