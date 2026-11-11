import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Scheduler } from '../../schedules/scheduler.js';
import { ScheduleError } from '../../schedules/timing.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';

/** Zeitplaene eines Servers - dieselben Routen und Antworten wie im Panel (Tab "Zeitpläne"). */

export interface ScheduleRouteDeps {
  registry: ServerRegistry;
  find: (idOrShortId: string) => ServerInstanceConfig | undefined;
  scheduler: Scheduler;
}

const scheduleBody = z.object({
  name: z.string().min(1).max(100),
  action: z.enum(['restart', 'backup', 'command']),
  payload: z.string().max(1024).nullable().optional(),
  cron: z.string().max(100).nullable().optional(),
  interval_minutes: z.number().int().min(1).max(43_200).nullable().optional(), // bis 30 Tage
  active: z.boolean().optional(),
});
const patchBody = scheduleBody.partial();

const UUID = z.string().uuid();

function fail(reply: FastifyReply, status: number, message: string, code: string): FastifyReply {
  return reply.status(status).send({ error: message, message, code });
}

export function registerScheduleRoutes(server: FastifyInstance, deps: ScheduleRouteDeps): void {
  const { registry, find, scheduler } = deps;
  const base = '/api/v1/servers/:id/schedules';

  /** Zeitplan nur, wenn er zu DIESEM Server gehoert - sonst koennte man fremde per ID ausloesen. */
  const owned = (serverId: string, scheduleId: string) => {
    if (!UUID.safeParse(scheduleId).success) return null;
    const row = registry.getSchedule(scheduleId);
    return row && row.server_id === serverId ? row : null;
  };

  const handle = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof ScheduleError) return fail(reply, 400, err.message, err.code);
    throw err;
  };

  server.get<{ Params: { id: string } }>(base, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    return { ok: true, schedules: scheduler.list(c.id) };
  });

  server.post<{ Params: { id: string }; Body: unknown }>(base, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const body = scheduleBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    try {
      const schedule = scheduler.create(c.id, body.data);
      registry.audit('schedule.create', c.id, 'standalone', { scheduleId: schedule.id, name: schedule.name, action: schedule.action });
      return reply.status(201).send({ ok: true, schedule });
    } catch (err) {
      return handle(reply, err);
    }
  });

  server.patch<{ Params: { id: string; scheduleId: string }; Body: unknown }>(`${base}/:scheduleId`, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    if (!owned(c.id, req.params.scheduleId)) return fail(reply, 404, 'Zeitplan nicht gefunden', 'not_found');
    const body = patchBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    try {
      const schedule = scheduler.update(c.id, req.params.scheduleId, body.data);
      registry.audit('schedule.update', c.id, 'standalone', { scheduleId: schedule.id, name: schedule.name, action: schedule.action });
      return { ok: true, schedule };
    } catch (err) {
      return handle(reply, err);
    }
  });

  server.delete<{ Params: { id: string; scheduleId: string } }>(`${base}/:scheduleId`, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    if (!owned(c.id, req.params.scheduleId)) return fail(reply, 404, 'Zeitplan nicht gefunden', 'not_found');
    scheduler.remove(c.id, req.params.scheduleId);
    registry.audit('schedule.delete', c.id, 'standalone', { scheduleId: req.params.scheduleId });
    return { ok: true };
  });

  // Sofort ausfuehren (Testlauf). Das Ergebnis, auch ein Fehler, steht in der Antwort.
  server.post<{ Params: { id: string; scheduleId: string } }>(`${base}/:scheduleId/run`, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    if (!owned(c.id, req.params.scheduleId)) return fail(reply, 404, 'Zeitplan nicht gefunden', 'not_found');
    try {
      const result = await scheduler.run(req.params.scheduleId, true);
      return { ok: result.ok, result };
    } catch (err) {
      return handle(reply, err);
    }
  });
}
