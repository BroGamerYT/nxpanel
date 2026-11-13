import path from 'node:path';
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

  server.post('/api/v1/admin/core-update/install', async (_req, reply) => {
    try {
      return { ok: true, ...(await updater.install()) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  return updater;
}
