import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StorageTargetError, StorageTargets, type TargetKind } from '../../store/storage-targets.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';

/**
 * Speicherziele fuer Backups - dieselben Routen wie im Panel (je Server, Recht backup.create) plus die der Administratoren
 * fuer globale Ziele. Ein Ziel "lokaler Pfad" schreibt irgendwohin auf diesem Rechner: nur Administratoren legen es an.
 */

const targetBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['s3', 'sftp', 'local_path']),
  config: z.record(z.unknown()),
  isDefault: z.boolean().optional(),
});

export interface StorageTargetRouteDeps {
  registry: ServerRegistry;
  targets: StorageTargets;
  find: (id: string) => ServerInstanceConfig | undefined;
}

export function registerStorageTargetRoutes(server: FastifyInstance, deps: StorageTargetRouteDeps): void {
  const { registry, targets, find } = deps;

  const fail = (reply: FastifyReply, status: number, message: string, code: string): FastifyReply => reply.status(status).send({ error: message, message, code });
  const isAdmin = (req: FastifyRequest): boolean => Boolean(req.actor?.master || req.actor?.role === 'admin');

  function guarded<T>(reply: FastifyReply, run: () => T): T | FastifyReply {
    try {
      return run();
    } catch (err) {
      if (err instanceof StorageTargetError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  }

  function create(req: FastifyRequest, reply: FastifyReply, serverId: string | null): FastifyReply | { ok: true; target: ReturnType<StorageTargets['create']> } {
    const body = targetBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    if (body.data.kind === 'local_path' && !isAdmin(req)) return fail(reply, 403, 'Ein lokaler Pfad darf nur ein Administrator als Speicherziel anlegen.', 'forbidden');
    return guarded(reply, () => {
      const target = targets.create({ serverId, name: body.data.name, kind: body.data.kind as TargetKind, config: body.data.config, isDefault: body.data.isDefault });
      registry.audit('storage_target.create', serverId, 'standalone', { targetId: target.id, name: target.name, kind: target.kind });
      reply.status(201);
      return { ok: true as const, target };
    });
  }

  async function test(req: FastifyRequest, reply: FastifyReply, id: string, scope: string | null): Promise<FastifyReply | { ok: boolean; message: string }> {
    const rec = targets.get(id);
    // Ein Server kommt an seine eigenen und an die globalen Ziele heran, nie an die eines anderen
    if (!rec || (rec.serverId !== null && rec.serverId !== scope) || (scope === null && rec.serverId !== null)) return fail(reply, 404, 'Speicherziel nicht gefunden', 'not_found');
    try {
      return await targets.test(id, { allowPrivate: isAdmin(req) });
    } catch (err) {
      if (err instanceof StorageTargetError) return fail(reply, err.statusCode, err.message, err.code);
      return fail(reply, 400, err instanceof Error ? err.message : String(err), 'test_error');
    }
  }

  // ------------------------------------------------------------- je Server

  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/storage-targets', async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    return { ok: true, targets: targets.list(c.id) };
  });

  server.post<{ Params: { id: string }; Body: unknown }>('/api/v1/servers/:id/storage-targets', async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    return create(req, reply, c.id);
  });

  server.delete<{ Params: { id: string; targetId: string } }>('/api/v1/servers/:id/storage-targets/:targetId', async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    // Nur die eigenen Ziele des Servers - ein globales Ziel loescht ein Administrator ueber seine Route
    if (!targets.delete(req.params.targetId, c.id)) return fail(reply, 404, 'Speicherziel nicht gefunden', 'not_found');
    registry.audit('storage_target.delete', c.id, 'standalone', { targetId: req.params.targetId });
    return { ok: true };
  });

  server.post<{ Params: { id: string; targetId: string } }>('/api/v1/servers/:id/storage-targets/:targetId/test', async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    return test(req, reply, req.params.targetId, c.id);
  });

  // --------------------------------------------------------------- global

  server.get('/api/v1/admin/storage-targets', async () => ({ ok: true, targets: targets.list(null) }));

  server.post<{ Body: unknown }>('/api/v1/admin/storage-targets', async (req, reply) => create(req, reply, null));

  server.delete<{ Params: { targetId: string } }>('/api/v1/admin/storage-targets/:targetId', async (req, reply) => {
    if (!targets.delete(req.params.targetId, null)) return fail(reply, 404, 'Speicherziel nicht gefunden', 'not_found');
    registry.audit('storage_target.delete', null, 'standalone', { targetId: req.params.targetId });
    return { ok: true };
  });

  server.post<{ Params: { targetId: string } }>('/api/v1/admin/storage-targets/:targetId/test', async (req, reply) => test(req, reply, req.params.targetId, null));
}
