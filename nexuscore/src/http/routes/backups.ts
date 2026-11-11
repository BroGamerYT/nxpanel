import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BackupError, type BackupManager } from '../../backups/manager.js';
import type { ServerInstanceConfig } from '../../types.js';

/** Backups eines Servers - dieselben Routen und Antworten wie im Panel (Tab "Backups"). */

export interface BackupRouteDeps {
  find: (idOrShortId: string) => ServerInstanceConfig | undefined;
  backups: BackupManager;
}

const createBody = z.object({
  name: z.string().max(200).optional(),
  ignoredFiles: z.array(z.string().max(100)).max(50).optional().default([]),
});
const patchBody = z.object({ locked: z.boolean() });
const scheduleBody = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(720).default(24),
  retention: z.number().int().min(1).max(100).default(5),
  verify: z.boolean().default(true),
});

function fail(reply: FastifyReply, status: number, message: string, code: string): FastifyReply {
  return reply.status(status).send({ error: message, message, code });
}

export function registerBackupRoutes(server: FastifyInstance, deps: BackupRouteDeps): void {
  const { find, backups } = deps;
  const base = '/api/v1/servers/:id';

  /** Fuehrt eine Aktion aus und uebersetzt BackupError in eine saubere Antwort. */
  async function guarded<T>(id: string, reply: FastifyReply, run: (serverId: string) => Promise<T> | T): Promise<T | FastifyReply> {
    const c = find(id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    try {
      return await run(c.id);
    } catch (err) {
      if (err instanceof BackupError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  }

  server.get<{ Params: { id: string } }>(`${base}/backups`, async (req, reply) =>
    guarded(req.params.id, reply, (id) => ({ backups: backups.list(id) })),
  );

  server.post<{ Params: { id: string }; Body: unknown }>(`${base}/backups`, async (req, reply) => {
    const body = createBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    return guarded(req.params.id, reply, async (id) => {
      const { backup } = await backups.create(id, { name: body.data.name, ignoredFiles: body.data.ignoredFiles });
      return { ok: true, backup: { ...backup, nas_stored: false } };
    });
  });

  server.post<{ Params: { id: string; backupId: string } }>(`${base}/backups/:backupId/restore`, async (req, reply) =>
    guarded(req.params.id, reply, async (id) => {
      await backups.restore(id, req.params.backupId);
      return { ok: true };
    }),
  );

  server.delete<{ Params: { id: string; backupId: string } }>(`${base}/backups/:backupId`, async (req, reply) =>
    guarded(req.params.id, reply, async (id) => {
      await backups.remove(id, req.params.backupId);
      return { ok: true };
    }),
  );

  server.patch<{ Params: { id: string; backupId: string }; Body: unknown }>(`${base}/backups/:backupId`, async (req, reply) => {
    const body = patchBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'locked (true oder false) fehlt', 'invalid_request');
    return guarded(req.params.id, reply, (id) => ({ ok: true, backup: backups.setLock(id, req.params.backupId, body.data.locked) }));
  });

  server.post<{ Params: { id: string; backupId: string } }>(`${base}/backups/:backupId/verify`, async (req, reply) =>
    guarded(req.params.id, reply, async (id) => ({ ok: true, result: await backups.verify(id, req.params.backupId) })),
  );

  server.get<{ Params: { id: string; backupId: string } }>(`${base}/backups/:backupId/download`, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const row = backups.list(c.id).find((b) => b.id === req.params.backupId);
    if (!row || row.status !== 'completed') return fail(reply, 404, 'Backup nicht gefunden', 'not_found');
    const file = backups.filePath(c.id, row.id);
    if (!existsSync(file)) return fail(reply, 404, 'Die Backup-Datei fehlt auf der Festplatte', 'file_not_found');
    const st = await stat(file);
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(row.filename)}"`);
    reply.header('Content-Type', 'application/gzip');
    reply.header('Content-Length', st.size);
    return reply.send(createReadStream(file));
  });

  // Das UGREEN-NAS gibt es im Core nicht - ehrlich ablehnen statt so tun.
  server.post<{ Params: { id: string; backupId: string } }>(`${base}/backups/:backupId/sync-nas`, async (_req, reply) =>
    fail(reply, 400, 'NAS-Synchronisation gibt es im Core nicht.', 'not_supported'),
  );

  server.get<{ Params: { id: string } }>(`${base}/backup-schedule`, async (req, reply) =>
    guarded(req.params.id, reply, (id) => ({ schedule: backups.getSchedule(id) })),
  );

  server.put<{ Params: { id: string }; Body: unknown }>(`${base}/backup-schedule`, async (req, reply) => {
    const body = scheduleBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    return guarded(req.params.id, reply, (id) => ({ ok: true, schedule: backups.putSchedule(id, body.data) }));
  });
}
