import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireServer, HttpError } from '../auth.js';
import { sql } from '../../db/index.js';
import { can, type ServerFlag } from '../../auth/permissions.js';
import { writeAudit } from '../../audit.js';
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  executeSchedule,
} from '../../servers/schedules.js';

const scheduleBody = z.object({
  name: z.string().min(1).max(100),
  action: z.enum(['restart', 'backup', 'command']),
  payload: z.string().max(1024).nullable().optional(),
  cron: z.string().max(100).nullable().optional(),
  interval_minutes: z.number().int().min(1).max(43200).nullable().optional(), // bis 30 Tage
  active: z.boolean().optional(),
});

const patchScheduleBody = scheduleBody.partial();

/**
 * Ein Zeitplan handelt im Namen dessen, der ihn anlegt oder ausloest. Wer nur
 * schedule.update hat, darf darueber nicht an Rechte kommen, die ihm fehlen:
 * ein "command"-Zeitplan waere sonst eine Konsole ohne control.command.
 */
const ACTION_FLAG: Record<'restart' | 'backup' | 'command', ServerFlag> = {
  restart: 'control.restart',
  backup: 'backup.create',
  command: 'control.command',
};

function requireActionFlag(req: FastifyRequest, action: keyof typeof ACTION_FLAG) {
  const flag = ACTION_FLAG[action];
  if (!can(req.actor!, req.target!.access, flag)) {
    throw new HttpError(403, `Fehlendes Recht: ${flag} (noetig fuer Zeitplaene mit der Aktion "${action}")`, 'forbidden');
  }
}

/** Zeitplan nur, wenn er zu DIESEM Server gehoert - sonst koennte man fremde per ID ausloesen. */
async function scheduleOf(serverId: string, scheduleId: string): Promise<{ action: keyof typeof ACTION_FLAG }> {
  if (!z.string().uuid().safeParse(scheduleId).success) throw new HttpError(404, 'Zeitplan nicht gefunden', 'not_found');
  const [row] = await sql<{ action: keyof typeof ACTION_FLAG }[]>`
    SELECT action FROM server_schedules WHERE id = ${scheduleId} AND server_id = ${serverId}`;
  if (!row) throw new HttpError(404, 'Zeitplan nicht gefunden', 'not_found');
  return row;
}

export async function scheduleRoutes(app: FastifyInstance) {
  /** Zeitplaene eines Servers auflisten */
  app.get<{ Params: { id: string } }>(
    '/servers/:id/schedules',
    { preHandler: requireServer('schedule.read') },
    async (req) => {
      const { server } = req.target!;
      const schedules = await listSchedules(server.id);
      return { ok: true, schedules };
    }
  );

  /** Neuen Zeitplan anlegen */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/servers/:id/schedules',
    { preHandler: requireServer('schedule.update') },
    async (req, reply) => {
      const { server } = req.target!;
      const body = scheduleBody.parse(req.body);
      requireActionFlag(req, body.action);

      try {
        const schedule = await createSchedule(server.id, body);

        await writeAudit({
          action: 'schedule.create',
          userId: req.actor!.id,
          actorName: req.actor!.username,
          serverId: server.id,
          ip: req.ip,
          metadata: { scheduleId: schedule.id, name: schedule.name, action: schedule.action },
        });

        reply.status(201);
        return { ok: true, schedule };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'schedule_error');
      }
    }
  );

  /** Zeitplan aktualisieren */
  app.patch<{ Params: { id: string; scheduleId: string }; Body: unknown }>(
    '/servers/:id/schedules/:scheduleId',
    { preHandler: requireServer('schedule.update') },
    async (req) => {
      const { server } = req.target!;
      const body = patchScheduleBody.parse(req.body);
      const existing = await scheduleOf(server.id, req.params.scheduleId);
      requireActionFlag(req, existing.action);
      if (body.action) requireActionFlag(req, body.action);

      try {
        const schedule = await updateSchedule(server.id, req.params.scheduleId, body);

        await writeAudit({
          action: 'schedule.update',
          userId: req.actor!.id,
          actorName: req.actor!.username,
          serverId: server.id,
          ip: req.ip,
          metadata: { scheduleId: schedule.id, name: schedule.name, action: schedule.action },
        });

        return { ok: true, schedule };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'schedule_error');
      }
    }
  );

  /** Zeitplan loeschen */
  app.delete<{ Params: { id: string; scheduleId: string } }>(
    '/servers/:id/schedules/:scheduleId',
    { preHandler: requireServer('schedule.update') },
    async (req) => {
      const { server } = req.target!;
      await deleteSchedule(server.id, req.params.scheduleId);

      await writeAudit({
        action: 'schedule.delete',
        userId: req.actor!.id,
        actorName: req.actor!.username,
        serverId: server.id,
        ip: req.ip,
        metadata: { scheduleId: req.params.scheduleId },
      });

      return { ok: true };
    }
  );

  /** Zeitplan sofort ausfuehren (Manuell / Testlauf) */
  app.post<{ Params: { id: string; scheduleId: string } }>(
    '/servers/:id/schedules/:scheduleId/run',
    { preHandler: requireServer('schedule.run') },
    async (req) => {
      const { server } = req.target!;
      const existing = await scheduleOf(server.id, req.params.scheduleId);
      requireActionFlag(req, existing.action);
      const res = await executeSchedule(req.params.scheduleId, true);

      await writeAudit({
        action: 'schedule.run',
        userId: req.actor!.id,
        actorName: req.actor!.username,
        serverId: server.id,
        ip: req.ip,
        metadata: { scheduleId: req.params.scheduleId, result: res },
      });

      return { ok: res.ok, result: res };
    }
  );
}
