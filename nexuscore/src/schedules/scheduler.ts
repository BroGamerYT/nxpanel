import crypto from 'node:crypto';
import { logger } from '../logger.js';
import type { ScheduleRow, ServerRegistry } from '../store/registry.js';
import { ScheduleError, nextRun, validateTiming } from './timing.js';

/**
 * Zeitplaene (Block B4): Neustart, Backup oder Konsolenbefehl zu festen
 * Uhrzeiten oder in Intervallen. Ein Hintergrund-Takt fuehrt faellige Plaene
 * aus - auch ohne Panel, denn der Core laeuft eigenstaendig.
 */

export type ScheduleAction = 'restart' | 'backup' | 'command';

export interface ScheduleInput {
  name: string;
  action: ScheduleAction;
  payload?: string | null | undefined;
  cron?: string | null | undefined;
  interval_minutes?: number | null | undefined;
  active?: boolean | undefined;
}

export interface ScheduleActions {
  restart(serverId: string): Promise<void>;
  command(serverId: string, line: string): Promise<void>;
  /** Fehlt (noch), werden Backup-Zeitplaene abgelehnt statt still nichts zu tun. */
  backup?(serverId: string, name: string): Promise<void>;
}

export interface RunResult {
  ok: boolean;
  action: string;
  error?: string;
}

/**
 * War der Core laenger aus (oder der PC aus), steht ein Plan weit in der
 * Vergangenheit. Ein Neustart-Plan darf dann nicht Stunden spaeter
 * ploetzlich zuschlagen: er wird uebersprungen und neu eingeplant.
 */
export const MISSED_GRACE_MS = 15 * 60_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly running = new Set<string>();

  constructor(
    private readonly registry: ServerRegistry,
    private readonly actions: ScheduleActions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(action: ScheduleAction): boolean {
    return action !== 'backup' || this.actions.backup !== undefined;
  }

  private assertValid(input: { action: ScheduleAction; payload?: string | null | undefined; cron?: string | null | undefined; interval_minutes?: number | null | undefined }): void {
    validateTiming(input.cron, input.interval_minutes);
    if (!this.supports(input.action)) throw new ScheduleError('Backups gibt es im Core noch nicht - dieser Zeitplan kann nicht angelegt werden.');
    if (input.action === 'command' && !(input.payload ?? '').trim()) throw new ScheduleError('Für einen Befehls-Zeitplan wird ein Befehl gebraucht');
  }

  list(serverId: string): ScheduleRow[] {
    return this.registry.listSchedules(serverId);
  }

  create(serverId: string, input: ScheduleInput): ScheduleRow {
    this.assertValid(input);
    const now = this.now();
    const active = input.active ?? true;
    const row: ScheduleRow = {
      id: crypto.randomUUID(),
      server_id: serverId,
      name: input.name,
      action: input.action,
      payload: input.action === 'command' ? (input.payload ?? '').trim() : null,
      cron: input.cron?.trim() || null,
      interval_minutes: input.interval_minutes ?? null,
      active,
      last_run_at: null,
      next_run_at: active ? nextRun(input.cron, input.interval_minutes, now).toISOString() : null,
      last_status: 'pending',
      last_error: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.registry.saveSchedule(row);
    return row;
  }

  update(serverId: string, id: string, patch: { [K in keyof ScheduleInput]?: ScheduleInput[K] | undefined }): ScheduleRow {
    const current = this.registry.getSchedule(id);
    if (!current || current.server_id !== serverId) throw new ScheduleError('Zeitplan nicht gefunden');

    const action = patch.action ?? current.action;
    // Wechselt die Art der Zeitangabe, gilt die neue allein: ein Intervall ersetzt die Uhrzeit und umgekehrt.
    const timingChanged = patch.cron !== undefined || patch.interval_minutes !== undefined;
    const cron = timingChanged ? (patch.cron ?? null) : current.cron;
    const interval = timingChanged ? (patch.interval_minutes ?? null) : current.interval_minutes;
    const payload = patch.payload !== undefined ? patch.payload : current.payload;
    const active = patch.active ?? current.active;
    this.assertValid({ action, payload, cron, interval_minutes: interval });

    const now = this.now();
    const row: ScheduleRow = {
      ...current,
      name: patch.name ?? current.name,
      action,
      payload: action === 'command' ? (payload ?? '').trim() : null,
      cron: cron?.trim() || null,
      interval_minutes: interval,
      active,
      next_run_at: active ? nextRun(cron, interval, now).toISOString() : null,
      updated_at: now.toISOString(),
    };
    this.registry.saveSchedule(row);
    return row;
  }

  remove(serverId: string, id: string): void {
    const current = this.registry.getSchedule(id);
    if (current && current.server_id === serverId) this.registry.deleteSchedule(id);
  }

  /** Fuehrt einen Plan jetzt aus. `manual`: vom Nutzer ausgeloest (Testlauf), nicht vom Takt. */
  async run(id: string, manual = false): Promise<RunResult> {
    const row = this.registry.getSchedule(id);
    if (!row) throw new ScheduleError('Zeitplan nicht gefunden');
    if (this.running.has(id)) return { ok: false, action: row.action, error: 'Der Zeitplan läuft gerade noch' };

    this.running.add(id);
    let error: string | null = null;
    try {
      logger.info({ scheduleId: id, name: row.name, action: row.action, serverId: row.server_id, manual }, 'Führe Zeitplan aus');
      if (row.action === 'restart') await this.actions.restart(row.server_id);
      else if (row.action === 'command') await this.actions.command(row.server_id, row.payload ?? '');
      else if (this.actions.backup) await this.actions.backup(row.server_id, `${row.name} (Geplant)`);
      else throw new Error('Backups gibt es im Core noch nicht');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.warn({ err, scheduleId: id }, 'Zeitplan fehlgeschlagen');
    } finally {
      this.running.delete(id);
    }

    const now = this.now();
    let next: string | null = null;
    try {
      next = row.active ? nextRun(row.cron, row.interval_minutes, now).toISOString() : null;
    } catch {
      next = null;
    }
    this.registry.saveSchedule({
      ...row,
      last_run_at: now.toISOString(),
      last_status: error ? 'failed' : 'success',
      last_error: error,
      next_run_at: next,
      updated_at: now.toISOString(),
    });
    this.registry.audit('schedule.run', row.server_id, 'core', { scheduleId: id, name: row.name, action: row.action, ok: !error, manual, ...(error ? { error } : {}) });
    return { ok: !error, action: row.action, ...(error ? { error } : {}) };
  }

  /** Ein Durchgang: faellige Plaene ausfuehren, verpasste ueberspringen. @returns Anzahl ausgefuehrter */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let ran = 0;
    try {
      const now = this.now();
      for (const row of this.registry.dueSchedules(now.toISOString(), 20)) {
        const due = row.next_run_at ? new Date(row.next_run_at).getTime() : null;
        if (due === null || now.getTime() - due > MISSED_GRACE_MS) {
          // Verpasst (Core war aus) oder ohne Termin: nicht nachholen, neu einplanen.
          if (due !== null) {
            this.registry.audit('schedule.skipped', row.server_id, 'core', { scheduleId: row.id, name: row.name, dueAt: row.next_run_at });
          }
          try {
            this.registry.saveSchedule({ ...row, next_run_at: nextRun(row.cron, row.interval_minutes, now).toISOString(), updated_at: now.toISOString() });
          } catch {
            this.registry.saveSchedule({ ...row, active: false, next_run_at: null, last_status: 'failed', last_error: 'Zeitangabe ungültig', updated_at: now.toISOString() });
          }
          continue;
        }
        await this.run(row.id);
        ran++;
      }
    } catch (err) {
      logger.error({ err }, 'Fehler beim Abarbeiten fälliger Zeitpläne');
    } finally {
      this.ticking = false;
    }
    return ran;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    logger.info({ intervalMs }, 'Zeitplan-Takt gestartet');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
