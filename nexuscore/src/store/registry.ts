import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ServerInstanceConfig } from '../types.js';
import { backupStamp, openDatabase } from './database.js';

interface LegacyRegistryFile {
  version: number;
  servers: ServerInstanceConfig[];
}

/** Die alte servers.json ist beschaedigt - der Core darf damit nicht weiterlaufen. */
export class RegistryCorruptError extends Error {
  constructor(
    readonly file: string,
    readonly backup: string,
    reason: string,
  ) {
    super(
      `Die Registry ${file} ist beschaedigt (${reason}). Sie wurde nach ${backup} gesichert. ` +
        'Datei pruefen und zurueckkopieren, oder den Core neu starten, um mit leerer Registry zu beginnen.',
    );
    this.name = 'RegistryCorruptError';
  }
}

export type AuditActor = 'panel' | 'standalone' | 'core';

export interface AuditEntry {
  id: number;
  ts: string;
  action: string;
  serverId: string | null;
  actor: AuditActor;
  detail: Record<string, unknown> | null;
}

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskRecord {
  id: string;
  serverId: string | null;
  kind: string;
  status: TaskStatus;
  /** 0..1 */
  progress: number;
  message: string;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Felder, die nie in Audit-Details landen duerfen. */
const SECRET_KEYS = /pass|token|secret|pin|key|cookie|authorization/i;

function withoutSecrets(detail: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    clean[key] = SECRET_KEYS.test(key) ? '[entfernt]' : value;
  }
  return clean;
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Persistenz des Cores: Instanzen, Einstellungen, Audit und Aufgaben.
 *
 * Seit Block B1 liegt alles in SQLite (`core.db`) statt in `servers.json`.
 * Eine vorhandene `servers.json` wird beim ersten Start uebernommen und
 * bleibt als `servers.json.migriert` liegen.
 *
 * Die Instanzen stehen zusaetzlich im Speicher: der Core liest sie staendig
 * (jede Anfrage), schreibt sie aber selten. Geschrieben wird zuerst in die
 * Datenbank, erst danach in den Speicher - schlaegt das Schreiben fehl,
 * bleibt beides beim alten Stand.
 */
export class ServerRegistry {
  private readonly servers = new Map<string, ServerInstanceConfig>();
  private closed = false;

  private constructor(
    /** Datenverzeichnis des Cores. */
    readonly dir: string,
    /** Pfad der Datenbankdatei. */
    readonly file: string,
    private readonly db: DatabaseSync,
  ) {}

  static async open(dir: string): Promise<ServerRegistry> {
    const { db, file } = await openDatabase(dir);
    const registry = new ServerRegistry(dir, file, db);

    try {
      registry.load();
      await registry.importLegacyFile();
    } catch (err) {
      registry.close();
      throw err;
    }
    return registry;
  }

  private load(): void {
    const rows = this.db.prepare('SELECT id, config FROM instances ORDER BY position, id').all() as {
      id: string;
      config: string;
    }[];
    for (const row of rows) {
      const config = parseJson<ServerInstanceConfig>(row.config);
      if (config && typeof config.id === 'string') this.servers.set(config.id, config);
    }
  }

  /**
   * Uebernimmt eine alte `servers.json` (bis Core 0.2).
   *
   * Nur wenn die Datenbank noch keine Instanzen hat - sonst wuerde ein
   * liegengebliebenes Altfile neuere Daten ueberschreiben. Nach der
   * Uebernahme heisst die Datei `servers.json.migriert`.
   */
  private async importLegacyFile(): Promise<void> {
    const legacy = path.join(this.dir, 'servers.json');
    let raw: string;
    try {
      raw = await fs.readFile(legacy, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    let reason: string | null = null;
    let servers: ServerInstanceConfig[] = [];
    try {
      const parsed = JSON.parse(raw) as Partial<LegacyRegistryFile> | null;
      if (!parsed || !Array.isArray(parsed.servers)) reason = 'Feld "servers" fehlt';
      else servers = parsed.servers.filter((s) => s && typeof s.id === 'string');
    } catch (err) {
      reason = err instanceof Error ? err.message : 'kein gueltiges JSON';
    }

    if (reason !== null) {
      const backup = `${legacy}.korrupt-${backupStamp()}`;
      await fs.rename(legacy, backup);
      throw new RegistryCorruptError(legacy, backup, reason);
    }

    if (this.servers.size === 0 && servers.length > 0) {
      this.db.exec('BEGIN');
      try {
        for (const server of servers) this.insert(server);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      for (const server of servers) this.servers.set(server.id, server);
      this.audit('registry.migrated', null, 'core', { from: 'servers.json', instances: servers.length });
    }

    // Vorhandenes .migriert nicht ueberschreiben - das waere die aeltere Sicherung.
    let target = `${legacy}.migriert`;
    try {
      await fs.access(target);
      target = `${target}-${backupStamp()}`;
    } catch {
      /* frei */
    }
    await fs.rename(legacy, target);
  }

  private insert(config: ServerInstanceConfig): void {
    const now = new Date().toISOString();
    const next = this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM instances').get() as {
      next: number;
    };
    this.db
      .prepare(
        'INSERT INTO instances (id, name, game, config, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(config.id, config.name, config.game, JSON.stringify(config), Number(next.next), now, now);
  }

  // ------------------------------------------------------------------ Instanzen

  list(): ServerInstanceConfig[] {
    return Array.from(this.servers.values());
  }

  get(id: string): ServerInstanceConfig | undefined {
    return this.servers.get(id);
  }

  async add(config: ServerInstanceConfig): Promise<void> {
    if (this.servers.has(config.id)) {
      throw new Error(`Server "${config.id}" existiert bereits.`);
    }
    this.insert(config);
    this.servers.set(config.id, config);
  }

  /** Aendert eine vorhandene Instanz. */
  async update(config: ServerInstanceConfig): Promise<void> {
    if (!this.servers.has(config.id)) {
      throw new Error(`Server "${config.id}" nicht gefunden.`);
    }
    this.db
      .prepare('UPDATE instances SET name = ?, game = ?, config = ?, updated_at = ? WHERE id = ?')
      .run(config.name, config.game, JSON.stringify(config), new Date().toISOString(), config.id);
    this.servers.set(config.id, config);
  }

  async remove(id: string): Promise<boolean> {
    if (!this.servers.has(id)) return false;
    this.db.prepare('DELETE FROM instances WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM schedules WHERE server_id = ?').run(id);
    this.db.prepare('DELETE FROM backups WHERE server_id = ?').run(id);
    this.db.prepare('DELETE FROM file_revisions WHERE server_id = ?').run(id);
    this.servers.delete(id);
    return true;
  }

  // ------------------------------------------------------------------ Dateiversionen

  /** Speichert einen Stand einer Datei; behaelt die neuesten `keep` je Datei. */
  saveRevision(r: FileRevisionRow, keep = 25): void {
    this.db
      .prepare(
        'INSERT INTO file_revisions (id, server_id, path, content, author_name, change_summary, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.id, r.server_id, r.path, r.content, r.author_name, r.change_summary, r.bytes, r.created_at);
    this.db
      .prepare(
        `DELETE FROM file_revisions WHERE server_id = ? AND path = ? AND id NOT IN (
           SELECT id FROM file_revisions WHERE server_id = ? AND path = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(r.server_id, r.path, r.server_id, r.path, keep);
  }

  /** Neueste zuerst, ohne den Inhalt. */
  listRevisions(serverId: string, filePath: string): Array<Omit<FileRevisionRow, 'content'>> {
    return this.db
      .prepare(
        'SELECT id, server_id, path, author_name, change_summary, bytes, created_at FROM file_revisions WHERE server_id = ? AND path = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(serverId, filePath) as unknown as Array<Omit<FileRevisionRow, 'content'>>;
  }

  getRevision(serverId: string, id: string): FileRevisionRow | undefined {
    return this.db.prepare('SELECT * FROM file_revisions WHERE id = ? AND server_id = ?').get(id, serverId) as FileRevisionRow | undefined;
  }

  // ------------------------------------------------------------------ Backups

  listBackups(serverId: string): BackupRow[] {
    return (this.db.prepare('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC, id').all(serverId) as unknown as RawBackup[]).map(toBackup);
  }

  getBackup(id: string): BackupRow | undefined {
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as RawBackup | undefined;
    return row ? toBackup(row) : undefined;
  }

  /** Alle Backups mit diesem Zustand (nach einem Neustart: unterbrochene). */
  backupsWithStatus(status: BackupRow['status']): BackupRow[] {
    return (this.db.prepare('SELECT * FROM backups WHERE status = ?').all(status) as unknown as RawBackup[]).map(toBackup);
  }

  saveBackup(b: BackupRow): void {
    this.db
      .prepare(
        `INSERT INTO backups (id, server_id, name, filename, bytes, checksum, locked, status, error, ignored_files, verification_status, verified_at, verification_details, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, filename = excluded.filename, bytes = excluded.bytes, checksum = excluded.checksum,
           locked = excluded.locked, status = excluded.status, error = excluded.error, ignored_files = excluded.ignored_files,
           verification_status = excluded.verification_status, verified_at = excluded.verified_at,
           verification_details = excluded.verification_details, completed_at = excluded.completed_at`,
      )
      .run(
        b.id,
        b.server_id,
        b.name,
        b.filename,
        b.bytes,
        b.checksum,
        b.locked ? 1 : 0,
        b.status,
        b.error,
        b.ignored_files ? JSON.stringify(b.ignored_files) : null,
        b.verification_status,
        b.verified_at,
        b.verification_details ? JSON.stringify(b.verification_details) : null,
        b.created_at,
        b.completed_at,
      );
  }

  deleteBackup(id: string): void {
    this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------------ Zeitplaene

  listSchedules(serverId: string): ScheduleRow[] {
    return (this.db.prepare('SELECT * FROM schedules WHERE server_id = ? ORDER BY created_at, id').all(serverId) as unknown as RawSchedule[]).map(toSchedule);
  }

  getSchedule(id: string): ScheduleRow | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as RawSchedule | undefined;
    return row ? toSchedule(row) : undefined;
  }

  /** Legt an oder ueberschreibt (nach ID). */
  saveSchedule(s: ScheduleRow): void {
    this.db
      .prepare(
        `INSERT INTO schedules (id, server_id, name, action, payload, cron, interval_minutes, active, last_run_at, next_run_at, last_status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, action = excluded.action, payload = excluded.payload, cron = excluded.cron,
           interval_minutes = excluded.interval_minutes, active = excluded.active, last_run_at = excluded.last_run_at,
           next_run_at = excluded.next_run_at, last_status = excluded.last_status, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(s.id, s.server_id, s.name, s.action, s.payload, s.cron, s.interval_minutes, s.active ? 1 : 0, s.last_run_at, s.next_run_at, s.last_status, s.last_error, s.created_at, s.updated_at);
  }

  deleteSchedule(id: string): void {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  /** Aktive Plaene, deren Termin erreicht ist (aelteste zuerst). */
  dueSchedules(nowIso: string, limit = 20): ScheduleRow[] {
    return (
      this.db
        .prepare('SELECT * FROM schedules WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?')
        .all(nowIso, limit) as unknown as RawSchedule[]
    ).map(toSchedule);
  }

  /**
   * Frueher schrieb das die servers.json. Mit SQLite ist jede Aenderung
   * sofort gespeichert - die Methode bleibt fuer bestehende Aufrufer und
   * raeumt nur den WAL-Puffer in die Hauptdatei.
   */
  async save(): Promise<void> {
    if (this.closed) return;
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  /** Schliesst die Datenbank. Danach darf die Registry nicht mehr benutzt werden. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* beim Beenden nicht mehr wichtig */
    }
    this.db.close();
  }

  // ------------------------------------------------------------------ Einstellungen

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    const value = row ? parseJson<T>(row.value) : null;
    return value === null ? undefined : value;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  // ------------------------------------------------------------------ Audit

  /**
   * Schreibt einen Audit-Eintrag: was der Core ausgefuehrt hat.
   *
   * Wer es ausgeloest hat, weiss das Panel - der Core kennt nur den Weg
   * (`panel` ueber /core/v1, `standalone` ueber die eigene Oberflaeche,
   * `core` fuer eigene Vorgaenge). Felder, die nach Geheimnis aussehen,
   * werden entfernt.
   */
  audit(action: string, serverId: string | null, actor: AuditActor, detail?: Record<string, unknown>): void {
    if (this.closed) return;
    this.db
      .prepare('INSERT INTO audit (ts, action, server_id, actor, detail) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), action, serverId, actor, detail ? JSON.stringify(withoutSecrets(detail)) : null);
  }

  /** Neueste Eintraege zuerst. */
  recentAudit(options: { serverId?: string; limit?: number } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 1000);
    const rows = (
      options.serverId
        ? this.db
            .prepare('SELECT * FROM audit WHERE server_id = ? ORDER BY id DESC LIMIT ?')
            .all(options.serverId, limit)
        : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    ) as { id: number; ts: string; action: string; server_id: string | null; actor: AuditActor; detail: string | null }[];
    return rows.map((row) => ({
      id: Number(row.id),
      ts: row.ts,
      action: row.action,
      serverId: row.server_id,
      actor: row.actor,
      detail: parseJson<Record<string, unknown>>(row.detail),
    }));
  }

  // ------------------------------------------------------------------ Aufgaben

  /** Legt eine lange Aufgabe an (Installation, Backup, Update). */
  createTask(kind: string, serverId: string | null = null, message = ''): TaskRecord {
    const now = new Date().toISOString();
    const id = `t_${crypto.randomBytes(8).toString('hex')}`;
    this.db
      .prepare(
        `INSERT INTO tasks (id, server_id, kind, status, progress, message, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(id, serverId, kind, message, now, now);
    return this.getTask(id)!;
  }

  updateTask(
    id: string,
    patch: { status?: TaskStatus; progress?: number; message?: string; result?: Record<string, unknown> | null },
  ): TaskRecord | undefined {
    const current = this.getTask(id);
    if (!current) return undefined;
    const progress = patch.progress === undefined ? current.progress : Math.min(1, Math.max(0, patch.progress));
    const result = patch.result === undefined ? current.result : patch.result;
    this.db
      .prepare('UPDATE tasks SET status = ?, progress = ?, message = ?, result = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.status ?? current.status,
        progress,
        patch.message ?? current.message,
        result ? JSON.stringify(result) : null,
        new Date().toISOString(),
        id,
      );
    return this.getTask(id);
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  /** Aufgaben, neueste zuerst. `active` = nur wartende und laufende. */
  listTasks(options: { active?: boolean; serverId?: string; limit?: number } = {}): TaskRecord[] {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 1000);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.active) where.push("status IN ('queued', 'running')");
    if (options.serverId) {
      where.push('server_id = ?');
      params.push(options.serverId);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, limit) as unknown as TaskRow[]).map(toTask);
  }

  /**
   * Nach einem Neustart laeuft keine der alten Aufgaben mehr - ohne diesen
   * Schritt staenden sie fuer immer auf "laeuft".
   *
   * @returns Anzahl der abgebrochenen Aufgaben
   */
  failInterruptedTasks(): number {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', message = 'Durch Neustart des Cores unterbrochen', updated_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(new Date().toISOString());
    return Number(result.changes);
  }
}

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
  last_status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

type RawSchedule = Omit<ScheduleRow, 'active' | 'interval_minutes'> & { active: number; interval_minutes: number | null };

function toSchedule(row: RawSchedule): ScheduleRow {
  return { ...row, active: Number(row.active) === 1, interval_minutes: row.interval_minutes === null ? null : Number(row.interval_minutes) };
}

export interface FileRevisionRow {
  id: string;
  server_id: string;
  path: string;
  content: string;
  author_name: string;
  change_summary: string | null;
  bytes: number;
  created_at: string;
}

export interface BackupVerification {
  status: 'valid' | 'corrupted';
  sha256Match: boolean;
  archiveIntact: boolean;
  filesCount: number;
  criticalFilesFound: string[];
  missingCriticalFiles?: string[];
  error?: string;
  verifiedAt: string;
}

export interface BackupRow {
  id: string;
  server_id: string;
  name: string;
  filename: string;
  bytes: number;
  checksum: string | null;
  locked: boolean;
  status: 'running' | 'completed' | 'failed' | 'restoring';
  error: string | null;
  ignored_files: string[] | null;
  verification_status: 'unverified' | 'valid' | 'corrupted';
  verified_at: string | null;
  verification_details: BackupVerification | null;
  created_at: string;
  completed_at: string | null;
}

type RawBackup = Omit<BackupRow, 'locked' | 'ignored_files' | 'verification_details' | 'bytes'> & {
  locked: number;
  bytes: number;
  ignored_files: string | null;
  verification_details: string | null;
};

function toBackup(row: RawBackup): BackupRow {
  return {
    ...row,
    bytes: Number(row.bytes),
    locked: Number(row.locked) === 1,
    ignored_files: parseJson<string[]>(row.ignored_files),
    verification_details: parseJson<BackupVerification>(row.verification_details),
  };
}

interface TaskRow {
  id: string;
  server_id: string | null;
  kind: string;
  status: TaskStatus;
  progress: number;
  message: string;
  result: string | null;
  created_at: string;
  updated_at: string;
}

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    kind: row.kind,
    status: row.status,
    progress: Number(row.progress),
    message: row.message,
    result: parseJson<Record<string, unknown>>(row.result),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
