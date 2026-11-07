import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireServer, requireAdmin, HttpError } from '../auth.js';
import { writeAudit } from '../../audit.js';
import {
  listStorageTargets,
  createStorageTarget,
  deleteStorageTarget,
  testStorageTarget,
} from '../../servers/storage-targets.js';

const targetBody = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(['s3', 'sftp', 'local_path']),
  config: z.record(z.unknown()),
  isDefault: z.boolean().optional(),
});

export async function storageTargetRoutes(app: FastifyInstance) {
  /** Speicherziele eines Servers (oder globale) abfragen */
  app.get<{ Params: { id: string } }>(
    '/servers/:id/storage-targets',
    { preHandler: requireServer('backup.create') },
    async (req) => {
      const { server } = req.target!;
      const targets = await listStorageTargets(server.id);
      return { ok: true, targets };
    }
  );

  /** Neues Speicherziel anlegen */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/servers/:id/storage-targets',
    { preHandler: requireServer('backup.create') },
    async (req, reply) => {
      const { server } = req.target!;
      const body = targetBody.parse(req.body);

      try {
        const target = await createStorageTarget({
          serverId: server.id,
          name: body.name,
          kind: body.kind,
          config: body.config,
          isDefault: body.isDefault,
        });

        await writeAudit({
          action: 'storage_target.create',
          userId: req.actor!.id,
          actorName: req.actor!.username,
          serverId: server.id,
          ip: req.ip,
          metadata: { targetId: target.id, name: target.name, kind: target.kind },
        });

        reply.status(201);
        return { ok: true, target };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'storage_target_error');
      }
    }
  );

  /** Speicherziel entfernen */
  app.delete<{ Params: { id: string; targetId: string } }>(
    '/servers/:id/storage-targets/:targetId',
    { preHandler: requireServer('backup.create') },
    async (req) => {
      const { server } = req.target!;
      await deleteStorageTarget(req.params.targetId, server.id);

      await writeAudit({
        action: 'storage_target.delete',
        userId: req.actor!.id,
        actorName: req.actor!.username,
        serverId: server.id,
        ip: req.ip,
        metadata: { targetId: req.params.targetId },
      });

      return { ok: true };
    }
  );

  /** Speicherziel Verbindungstest */
  app.post<{ Params: { id: string; targetId: string } }>(
    '/servers/:id/storage-targets/:targetId/test',
    { preHandler: requireServer('backup.create') },
    async (req) => {
      try {
        const result = await testStorageTarget(req.params.targetId);
        return { ok: result.ok, message: result.message };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'test_error');
      }
    }
  );

  /** Globale Panel-Speicherziele (nur Admins) */
  app.get(
    '/admin/storage-targets',
    { preHandler: requireAdmin() },
    async () => {
      const targets = await listStorageTargets(null);
      return { ok: true, targets };
    }
  );
}
