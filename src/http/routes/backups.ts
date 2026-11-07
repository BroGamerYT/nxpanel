import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
  setBackupLock,
  backupFilePath,
  verifyBackup,
  syncBackupToNas,
} from '../../servers/backups.js';
import { HttpError, requireServer } from '../auth.js';
import { sql } from '../../db/index.js';
import { writeAudit } from '../../audit.js';

export const createBackupBody = z.object({
  name: z.string().max(200).optional(),
  ignoredFiles: z.array(z.string().max(100)).max(50).optional().default([]),
});

export const patchBackupBody = z.object({
  locked: z.boolean(),
});

export const putBackupScheduleBody = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(720).default(24),
  retention: z.number().int().min(1).max(100).default(5),
  verify: z.boolean().default(true),
});

export async function backupRoutes(app: FastifyInstance) {
  /** Alle Backups eines Servers auflisten */
  app.get<{ Params: { id: string } }>(
    '/servers/:id/backups',
    { preHandler: requireServer('backup.read') },
    async (req) => {
      const { server } = req.target!;
      const backups = await listBackups(server.id);
      return { backups };
    }
  );

  /** Neues Backup anlegen */
  app.post<{ Params: { id: string }; Body: { name?: string; ignoredFiles?: string[] } }>(
    '/servers/:id/backups',
    { preHandler: requireServer('backup.create') },
    async (req) => {
      const { server } = req.target!;
      const body = createBackupBody.parse(req.body ?? {});
      try {
        const backup = await createBackup(
          server.id,
          { id: req.actor!.id, username: req.actor!.username },
          req.ip,
          body.name,
          body.ignoredFiles
        );
        return { ok: true, backup };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'backup_error');
      }
    }
  );

  /** Backup wiederherstellen */
  app.post<{ Params: { id: string; backupId: string } }>(
    '/servers/:id/backups/:backupId/restore',
    { preHandler: requireServer('backup.restore') },
    async (req) => {
      const { server } = req.target!;
      try {
        await restoreBackup(
          server.id,
          req.params.backupId,
          { id: req.actor!.id, username: req.actor!.username },
          req.ip
        );
        return { ok: true };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'restore_error');
      }
    }
  );

  /** Backup löschen */
  app.delete<{ Params: { id: string; backupId: string } }>(
    '/servers/:id/backups/:backupId',
    { preHandler: requireServer('backup.delete') },
    async (req) => {
      const { server } = req.target!;
      try {
        await deleteBackup(
          server.id,
          req.params.backupId,
          { id: req.actor!.id, username: req.actor!.username },
          req.ip
        );
        return { ok: true };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'delete_error');
      }
    }
  );

  /** Backup sperren / entsperren */
  app.patch<{ Params: { id: string; backupId: string }; Body: { locked: boolean } }>(
    '/servers/:id/backups/:backupId',
    { preHandler: requireServer('backup.create') },
    async (req) => {
      const { server } = req.target!;
      const body = patchBackupBody.parse(req.body);
      try {
        const backup = await setBackupLock(server.id, req.params.backupId, body.locked);
        return { ok: true, backup };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'lock_error');
      }
    }
  );

  /** Backup herunterladen */
  app.get<{ Params: { id: string; backupId: string } }>(
    '/servers/:id/backups/:backupId/download',
    { preHandler: requireServer('backup.download') },
    async (req, reply) => {
      const { server } = req.target!;
      const [backup] = await sql<{ filename: string }[]>`
        SELECT filename FROM backups WHERE id = ${req.params.backupId} AND server_id = ${server.id}
      `;
      if (!backup) throw new HttpError(404, 'Backup nicht gefunden', 'not_found');

      const path = backupFilePath(server.id, req.params.backupId);
      if (!existsSync(path)) throw new HttpError(404, 'Backup-Datei existiert nicht auf Festplatte', 'file_not_found');

      const st = await stat(path);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(backup.filename)}"`);
      reply.header('Content-Type', 'application/x-tar');
      reply.header('Content-Length', st.size);
      return reply.send(createReadStream(path));
    }
  );

  /** Backup auf UGREEN NAS synchronisieren */
  app.post<{ Params: { id: string; backupId: string } }>(
    '/servers/:id/backups/:backupId/sync-nas',
    { preHandler: requireServer('backup.create') },
    async (req) => {
      const { server } = req.target!;
      const success = await syncBackupToNas(server.id, req.params.backupId);
      if (!success) {
        throw new HttpError(400, 'Synchronisation zum UGREEN NAS fehlgeschlagen (NAS-Pfad nicht erreichbar)', 'sync_error');
      }
      return { ok: true };
    }
  );

  /** Backup verifizieren (Integritaet & Spieldaten pruefen) */
  app.post<{ Params: { id: string; backupId: string } }>(
    '/servers/:id/backups/:backupId/verify',
    { preHandler: requireServer('backup.read') },
    async (req) => {
      const { server } = req.target!;
      try {
        const result = await verifyBackup(
          server.id,
          req.params.backupId,
          req.actor ? { id: req.actor.id, username: req.actor.username } : undefined
        );
        return { ok: true, result };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'verify_error');
      }
    }
  );

  /** Auto-Backup-Zeitplan abrufen */
  app.get<{ Params: { id: string } }>(
    '/servers/:id/backup-schedule',
    { preHandler: requireServer('backup.read') },
    async (req) => {
      const { server } = req.target!;
      const [row] = await sql<{
        auto_backup_enabled: boolean;
        auto_backup_interval_hours: number;
        auto_backup_retention: number;
        auto_backup_verify: boolean;
        last_auto_backup_at: string | null;
      }[]>`
        SELECT auto_backup_enabled, auto_backup_interval_hours, auto_backup_retention,
               auto_backup_verify, last_auto_backup_at
        FROM servers
        WHERE id = ${server.id}
      `;
      if (!row) throw new HttpError(404, 'Server nicht gefunden', 'not_found');

      return {
        schedule: {
          enabled: row.auto_backup_enabled,
          intervalHours: row.auto_backup_interval_hours,
          retention: row.auto_backup_retention,
          verify: row.auto_backup_verify,
          lastAutoBackupAt: row.last_auto_backup_at,
        },
      };
    }
  );

  /** Auto-Backup-Zeitplan & Retention aktualisieren */
  app.put<{
    Params: { id: string };
    Body: { enabled: boolean; intervalHours?: number; retention?: number; verify?: boolean };
  }>(
    '/servers/:id/backup-schedule',
    { preHandler: requireServer('backup.create') },
    async (req) => {
      const { server } = req.target!;
      const body = putBackupScheduleBody.parse(req.body);

      await sql`
        UPDATE servers
        SET auto_backup_enabled = ${body.enabled},
            auto_backup_interval_hours = ${body.intervalHours},
            auto_backup_retention = ${body.retention},
            auto_backup_verify = ${body.verify}
        WHERE id = ${server.id}
      `;

      await writeAudit({
        action: 'backup.schedule_update',
        userId: req.actor!.id,
        actorName: req.actor!.username,
        serverId: server.id,
        ip: req.ip,
        metadata: body,
      });

      return { ok: true, schedule: body };
    }
  );
}
