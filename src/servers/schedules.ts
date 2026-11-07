import { sql } from '../db/index.js';
import { log } from '../log.js';
import { writeEvent } from '../events.js';
import { createBackup } from './backups.js';
import { restartServer } from './lifecycle.js';
import { engine } from '../docker/client.js';

export interface ScheduleRow {
  id: string;
  server_id: string;
  name: string;
  action: 'restart' | 'backup' | 'command';
  payload: string | null;
  cron: string | null;
  interval_minutes: number | null;
  active: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: 'pending' | 'success' | 'failed';
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Berechnet den naechsten Ausfuehrungszeitpunkt
 */
export function calculateNextRun(
  cron?: string | null,
  intervalMinutes?: number | null,
  from = new Date()
): Date {
  // 1. Intervall in Minuten
  if (intervalMinutes && intervalMinutes > 0) {
    return new Date(from.getTime() + intervalMinutes * 60 * 1000);
  }

  // 2. Cron-Format "Minute Stunde * * *" oder "H:M"
  if (cron) {
    const trimmed = cron.trim();
    // Format "HH:MM" (z.B. "04:00")
    const hmMatch = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (hmMatch) {
      const h = parseInt(hmMatch[1]!, 10);
      const m = parseInt(hmMatch[2]!, 10);
      const next = new Date(from);
      next.setHours(h, m, 0, 0);
      if (next.getTime() <= from.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }

    // Standard 5-Teil-Cron "M H * * *" (z. B. "0 4 * * *")
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const mPart = parts[0]!;
      const hPart = parts[1]!;
      const targetM = mPart === '*' ? from.getMinutes() + 1 : parseInt(mPart, 10);
      const targetH = hPart === '*' ? from.getHours() : parseInt(hPart, 10);

      const next = new Date(from);
      next.setHours(targetH, targetM, 0, 0);
      if (next.getTime() <= from.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      return next;
    }
  }

  // Standard: in 24 Stunden
  return new Date(from.getTime() + 24 * 3600 * 1000);
}

/**
 * Zeitplaene eines Servers abfragen
 */
export async function listSchedules(serverId: string): Promise<ScheduleRow[]> {
  return await sql<ScheduleRow[]>`
    SELECT * FROM server_schedules
    WHERE server_id = ${serverId}
    ORDER BY created_at ASC
  `;
}

/**
 * Neuen Zeitplan anlegen
 */
export async function createSchedule(
  serverId: string,
  input: {
    name: string;
    action: 'restart' | 'backup' | 'command';
    payload?: string | null | undefined;
    cron?: string | null | undefined;
    interval_minutes?: number | null | undefined;
    active?: boolean | undefined;
  }
): Promise<ScheduleRow> {
  const nextRun = calculateNextRun(input.cron, input.interval_minutes);
  const [row] = await sql<ScheduleRow[]>`
    INSERT INTO server_schedules (
      server_id, name, action, payload, cron, interval_minutes, active, next_run_at
    ) VALUES (
      ${serverId}, ${input.name}, ${input.action}, ${input.payload ?? null},
      ${input.cron ?? null}, ${input.interval_minutes ?? null}, ${input.active ?? true},
      ${nextRun.toISOString()}
    )
    RETURNING *
  `;
  return row!;
}

/**
 * Zeitplan aktualisieren
 */
export async function updateSchedule(
  serverId: string,
  scheduleId: string,
  input: {
    name?: string | undefined;
    action?: 'restart' | 'backup' | 'command' | undefined;
    payload?: string | null | undefined;
    cron?: string | null | undefined;
    interval_minutes?: number | null | undefined;
    active?: boolean | undefined;
  }
): Promise<ScheduleRow> {
  const [cur] = await sql<ScheduleRow[]>`
    SELECT * FROM server_schedules WHERE id = ${scheduleId} AND server_id = ${serverId}
  `;
  if (!cur) throw new Error('Zeitplan nicht gefunden');

  const name = input.name ?? cur.name;
  const action = input.action ?? cur.action;
  const payload = input.payload !== undefined ? input.payload : cur.payload;
  const cron = input.cron !== undefined ? input.cron : cur.cron;
  const interval = input.interval_minutes !== undefined ? input.interval_minutes : cur.interval_minutes;
  const active = input.active !== undefined ? input.active : cur.active;

  const nextRun = active ? calculateNextRun(cron, interval) : null;

  const [updated] = await sql<ScheduleRow[]>`
    UPDATE server_schedules
    SET name = ${name},
        action = ${action},
        payload = ${payload},
        cron = ${cron},
        interval_minutes = ${interval},
        active = ${active},
        next_run_at = ${nextRun ? nextRun.toISOString() : null},
        updated_at = now()
    WHERE id = ${scheduleId} AND server_id = ${serverId}
    RETURNING *
  `;
  return updated!;
}

/**
 * Zeitplan loeschen
 */
export async function deleteSchedule(serverId: string, scheduleId: string): Promise<void> {
  await sql`
    DELETE FROM server_schedules WHERE id = ${scheduleId} AND server_id = ${serverId}
  `;
}

/**
 * Fuehrt einen einzelnen Zeitplan aus
 */
export async function executeSchedule(
  scheduleId: string,
  manual = false
): Promise<{ ok: boolean; action: string; error?: string | undefined }> {
  const [sched] = await sql<ScheduleRow[]>`
    SELECT * FROM server_schedules WHERE id = ${scheduleId}
  `;
  if (!sched) throw new Error('Zeitplan nicht gefunden');

  const [srv] = await sql<{
    id: string;
    name: string;
    short_id: string;
    container_id: string | null;
    status: string;
  }[]>`
    SELECT id, name, short_id, container_id, status FROM servers WHERE id = ${sched.server_id}
  `;
  if (!srv) throw new Error('Zugehöriger Server existiert nicht mehr');

  log.info({ scheduleId, name: sched.name, action: sched.action, serverId: srv.id, manual }, 'Führe Zeitplan aus');

  const SYSTEM_ACTOR = { id: '00000000-0000-0000-0000-000000000000', username: 'System (Zeitplan)' };
  let errorMsg: string | null = null;

  try {
    switch (sched.action) {
      case 'restart':
        await restartServer(srv.id);
        break;

      case 'backup':
        await createBackup(
          srv.id,
          SYSTEM_ACTOR,
          '127.0.0.1',
          `${sched.name} (Geplant)`,
          []
        );
        break;

      case 'command':
        if (srv.status !== 'running' && srv.status !== 'starting') {
          throw new Error('Server ist nicht online – Befehl konnte nicht an Konsole gesendet werden');
        }
        if (!srv.container_id) {
          throw new Error('Kein aktiver Docker-Container vorhanden');
        }
        if (!sched.payload || !sched.payload.trim()) {
          throw new Error('Kein Befehl hinterlegt');
        }
        await engine.sendToStdin(srv.container_id, sched.payload.trim());
        break;

      default:
        throw new Error(`Unbekannte Aktion "${sched.action}"`);
    }

    await writeEvent({
      serverId: srv.id,
      kind: 'schedule_executed',
      severity: 'info',
      summary: `Zeitplan "${sched.name}" (${sched.action}) erfolgreich ausgeführt`,
      payload: { scheduleId, action: sched.action, manual },
    });
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    log.error({ err, scheduleId, name: sched.name }, 'Fehler bei Ausführung des Zeitplans');

    await writeEvent({
      serverId: srv.id,
      kind: 'schedule_failed',
      severity: 'warn',
      summary: `Zeitplan "${sched.name}" fehlgeschlagen: ${errorMsg}`,
      payload: { scheduleId, action: sched.action, error: errorMsg, manual },
    });
  }

  // Nächsten Lauf berechnen
  const nextRun = sched.active ? calculateNextRun(sched.cron, sched.interval_minutes) : null;

  await sql`
    UPDATE server_schedules
    SET last_run_at = now(),
        last_status = ${errorMsg ? 'failed' : 'success'},
        last_error = ${errorMsg},
        next_run_at = ${nextRun ? nextRun.toISOString() : null},
        updated_at = now()
    WHERE id = ${scheduleId}
  `;

  return { ok: !errorMsg, action: sched.action, error: errorMsg ?? undefined };
}

/**
 * Hintergrund-Runner fuer faellige Zeitplaene
 */
export async function runPendingSchedules(): Promise<number> {
  const now = new Date().toISOString();
  const due = await sql<{ id: string }[]>`
    SELECT id FROM server_schedules
    WHERE active = true
      AND (next_run_at IS NULL OR next_run_at <= ${now}::timestamptz)
    ORDER BY next_run_at ASC NULLS FIRST
    LIMIT 20
  `;

  let ran = 0;
  for (const s of due) {
    try {
      await executeSchedule(s.id);
      ran++;
    } catch (err) {
      log.error({ err, scheduleId: s.id }, 'Fehler beim Abarbeiten faelliger Zeitplaene');
    }
  }
  return ran;
}

let scheduleTimer: NodeJS.Timeout | null = null;

export function startScheduleWorker(intervalMs = 60_000): void {
  if (scheduleTimer) return;
  scheduleTimer = setInterval(() => {
    void runPendingSchedules();
  }, intervalMs);
  log.info({ intervalMs }, 'Zeitplan-Worker (Schedules) gestartet');
}

export function stopScheduleWorker(): void {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
}
