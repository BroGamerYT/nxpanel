import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tarBinary as platformTarBinary } from '../platform/index.js';
import { resolveInstanceDir } from '../files/instance-dir.js';
import { logger } from '../logger.js';
import type { BackupRow, BackupVerification, ServerRegistry } from '../store/registry.js';
import type { ServerInstanceConfig } from '../types.js';

/**
 * Backups (Block B4): der Ordner eines Servers wird als `.tar.gz` gepackt,
 * mit SHA-256 versehen und auf Wunsch geprueft. Gepackt wird mit dem `tar`
 * des Systems (Windows 10+ bringt eines mit) - keine neue Abhaengigkeit.
 *
 * Das Panel nimmt `.tar.zst`; gzip koennen alle `tar`-Programme, zstd nicht
 * jedes. Fuer spaetere Deltas (Konzept 5.1) bleibt das Format austauschbar:
 * die Endung steht pro Backup in `filename`.
 */

export class BackupError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'backup_error',
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupSchedule {
  enabled: boolean;
  intervalHours: number;
  retention: number;
  verify: boolean;
  lastAutoBackupAt: string | null;
}

interface StoredSchedule extends BackupSchedule {
  /** Ab wann gerechnet wird, solange es noch kein automatisches Backup gab. */
  anchorAt?: string;
}

export const DEFAULT_SCHEDULE: BackupSchedule = { enabled: false, intervalHours: 24, retention: 5, verify: true, lastAutoBackupAt: null };

export interface BackupDeps {
  registry: ServerRegistry;
  /** Steht der Server? Nur dann darf wiederhergestellt werden. */
  isStopped: (serverId: string) => Promise<boolean>;
  /** Anzeigename des Spiels fuer Dateinamen und die Pruefung der Spieldateien. */
  gameName: (instance: ServerInstanceConfig) => Promise<string>;
  /** Ablageort; Standard `<Datenverzeichnis>/backups`. */
  root?: string;
  now?: () => Date;
}

export interface ActiveBackupTask {
  id: string;
  type: 'backup';
  serverId: string;
  serverName: string;
  shortId: string;
  title: string;
  subtitle: string;
  step: string;
  progressPercent: number;
  bytesWritten: number;
  totalBytes: number;
  startedAt: string;
}

interface Progress {
  phase: string;
  percent: number;
  bytes: number;
  total: number;
  startedAt: string;
  name: string;
  serverId: string;
}

export function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function generateBackupName(serverName: string, game: string, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
  return `${sanitizeFileName(serverName) || 'Server'}_${sanitizeFileName(game) || 'Game'}_${stamp}`;
}

/** Wo die Spieldaten eines Spiels liegen muessen, damit ein Backup als brauchbar gilt. */
export function criticalFilesFor(game: string): string[] {
  const g = game.toLowerCase();
  if (g.includes('minecraft') || g.includes('paper')) return ['level.dat', 'server.properties'];
  if (g.includes('ark')) return ['GameUserSettings.ini', 'SavedArks'];
  if (g.includes('palworld')) return ['PalWorldSettings.ini', 'Level.sav'];
  if (g.includes('enshrouded')) return ['enshrouded_server.json', 'savegame'];
  if (g.includes('rust')) return ['server.cfg', '.sav'];
  if (g.includes('valheim')) return ['.db', '.fwl'];
  if (g.includes('counter-strike') || g.includes('cs2')) return ['server.cfg'];
  if (g.includes('teamspeak')) return ['sqlitedb'];
  return [];
}

/** Wie das tar des Systems das Archiv entpacken soll: gzip oder zstd (Panel-Backups). */
export function compression(archive: string): string[] {
  return /\.zst$/i.test(archive) ? ['--zstd'] : ['-z'];
}

/** Das tar des Systems; unter Windows das mitgelieferte, damit nicht ein fremdes aus dem PATH greift. */
function tarBinary(): string {
  return platformTarBinary();
}

interface TarResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runTar(args: string[], cwd: string): Promise<TarResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(tarBinary(), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      // Ein Spielserver kann Millionen Dateien haben - die Liste nicht unbegrenzt im Speicher halten
      if (stdout.length > 64 * 1024 * 1024) proc.kill();
    });
    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 16_000) stderr += d.toString();
    });
    proc.on('error', (err) => reject(new BackupError(`tar ist nicht verfügbar: ${err.message}`)));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function dirBytes(dir: string, limit = 200_000): Promise<number> {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < limit) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > limit) break;
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) total += (await fs.stat(full).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

const ALWAYS_EXCLUDED = ['.panel', '*.log.gz', 'session.lock'];
const FILE_CHANGED = /file changed as we read it|changed as we read/i;

export class BackupManager {
  readonly root: string;
  private readonly now: () => Date;
  private readonly progress = new Map<string, Progress>();
  private readonly busy = new Set<string>(); // server ids
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: BackupDeps) {
    this.root = deps.root ?? path.join(deps.registry.dir, 'backups');
    this.now = deps.now ?? (() => new Date());
  }

  // ------------------------------------------------------------ Pfade

  /** Neue Backups sind .tar.gz; aus dem Panel uebernommene bleiben .tar.zst (die Endung steht in `filename`). */
  private archiveName(id: string): string {
    return /\.tar\.zst$/i.test(this.deps.registry.getBackup(id)?.filename ?? '') ? `${id}.tar.zst` : `${id}.tar.gz`;
  }

  private serverDir(serverId: string): string {
    return path.join(this.root, serverId);
  }

  filePath(serverId: string, backupId: string): string {
    return path.join(this.serverDir(serverId), this.archiveName(backupId));
  }

  private async sourceDir(instance: ServerInstanceConfig): Promise<string> {
    const dir = await resolveInstanceDir(this.deps.registry, instance);
    if (!dir) throw new BackupError('Dieser Server liegt nicht im Server-Verzeichnis des Cores - Backups sind dafür gesperrt.', 403, 'forbidden');
    return dir;
  }

  private need(serverId: string): ServerInstanceConfig {
    const c = this.deps.registry.get(serverId);
    if (!c) throw new BackupError('Server nicht gefunden', 404, 'not_found');
    return c;
  }

  private owned(serverId: string, backupId: string): BackupRow {
    const row = this.deps.registry.getBackup(backupId);
    if (!row || row.server_id !== serverId) throw new BackupError('Backup nicht gefunden', 404, 'not_found');
    return row;
  }

  // ------------------------------------------------------------ Lesen

  list(serverId: string): Array<BackupRow & { nas_stored: boolean }> {
    return this.deps.registry.listBackups(serverId).map((b) => ({ ...b, nas_stored: false }));
  }

  /** Laufende Backups als Aufgaben fuer die Oberflaeche (Fortschrittsanzeige). */
  activeTasks(serverId?: string): ActiveBackupTask[] {
    const out: ActiveBackupTask[] = [];
    for (const [id, p] of this.progress) {
      if (serverId && p.serverId !== serverId) continue;
      const c = this.deps.registry.get(p.serverId);
      out.push({
        id: `backup-${id}`,
        type: 'backup',
        serverId: p.serverId,
        serverName: c?.name ?? p.serverId,
        shortId: p.serverId.slice(0, 8),
        title: 'Backup',
        subtitle: p.name,
        step: p.phase,
        progressPercent: Math.round(p.percent),
        bytesWritten: p.bytes,
        totalBytes: p.total,
        startedAt: p.startedAt,
      });
    }
    return out;
  }

  isBusy(serverId: string): boolean {
    return this.busy.has(serverId);
  }

  // ------------------------------------------------------------ Anlegen

  /**
   * Startet ein Backup im Hintergrund. `done` endet, wenn es fertig oder fehlgeschlagen ist
   * (wirft nie) - der Zeitplan wartet darauf, die Oberflaeche fragt nur den Zustand ab.
   */
  async create(
    serverId: string,
    options: { name?: string | undefined; ignoredFiles?: string[] | undefined; actor?: 'standalone' | 'core'; auto?: boolean } = {},
  ): Promise<{ backup: BackupRow; done: Promise<BackupRow> }> {
    const c = this.need(serverId);
    const src = await this.sourceDir(c);
    if (this.busy.has(serverId)) throw new BackupError('Für diesen Server läuft bereits ein Backup oder eine Wiederherstellung', 409, 'busy');

    const game = await this.deps.gameName(c);
    const generated = generateBackupName(c.name, game, this.now());
    const name = options.name?.trim() || generated;
    const clean = sanitizeFileName(name);
    const id = crypto.randomUUID();
    const ignored = (options.ignoredFiles ?? []).map((s) => s.trim()).filter(Boolean);
    const row: BackupRow = {
      id,
      server_id: serverId,
      name,
      filename: `${clean || generated}.tar.gz`,
      bytes: 0,
      checksum: null,
      locked: false,
      status: 'running',
      error: null,
      ignored_files: ignored.length ? ignored : null,
      verification_status: 'unverified',
      verified_at: null,
      verification_details: null,
      created_at: this.now().toISOString(),
      completed_at: null,
    };
    this.deps.registry.saveBackup(row);
    this.busy.add(serverId);
    const done = this.runCreate(row, c, src, ignored, options.actor ?? 'standalone');
    return { backup: row, done };
  }

  private async runCreate(row: BackupRow, c: ServerInstanceConfig, src: string, ignored: string[], actor: 'standalone' | 'core'): Promise<BackupRow> {
    const { registry } = this.deps;
    const target = this.filePath(row.server_id, row.id);
    const part = `${target}.part`;
    const state: Progress = { phase: 'Packe Dateien', percent: 3, bytes: 0, total: 0, startedAt: row.created_at, name: row.name, serverId: row.server_id };
    this.progress.set(row.id, state);
    let sampler: NodeJS.Timeout | null = null;

    try {
      await fs.mkdir(this.serverDir(row.server_id), { recursive: true });
      state.total = await dirBytes(src);
      const expected = Math.max(state.total * 0.5, 5 * 1024 * 1024);
      sampler = setInterval(() => {
        fs.stat(part)
          .then((st) => {
            state.bytes = st.size;
            state.percent = Math.min(65, 3 + (st.size / expected) * 62);
          })
          .catch(() => {});
      }, 700);

      const args = ['-czf', path.basename(part)];
      for (const pattern of [...ALWAYS_EXCLUDED, ...ignored]) args.push(`--exclude=${pattern}`);
      args.push('-C', src, '.');
      const result = await runTar(args, this.serverDir(row.server_id));
      // Aendert sich eine Datei waehrend des Lesens (laufender Server), meldet GNU tar Code 1 - das Archiv ist brauchbar.
      const tolerated = result.code === 1 && FILE_CHANGED.test(result.stderr) && existsSync(part);
      if (result.code !== 0 && !tolerated) {
        throw new BackupError(`Packen fehlgeschlagen (tar Code ${result.code}): ${result.stderr.trim() || 'keine Meldung'}`);
      }
      await fs.rename(part, target);

      state.phase = 'Prüfsumme';
      state.percent = 70;
      const size = (await fs.stat(target)).size;
      state.bytes = size;
      const checksum = await sha256(target);

      // Erst nach der Pruefung gilt es als fertig - sonst sieht die Oberflaeche ein ungeprueftes Backup als abgeschlossen.
      let current: BackupRow = { ...row, bytes: size, checksum };
      registry.saveBackup(current);

      const schedule = this.getSchedule(row.server_id);
      if (schedule.verify) {
        state.phase = 'Prüfe Archiv';
        state.percent = 90;
        const before = current;
        current = await this.verifyRow(before, c).catch((err) => {
          logger.warn({ err, backupId: row.id }, 'Prüfung nach dem Backup fehlgeschlagen');
          return before;
        });
      }
      const completed: BackupRow = { ...current, status: 'completed', completed_at: this.now().toISOString() };
      registry.saveBackup(completed);
      registry.audit('backup.create', row.server_id, actor, { backupId: row.id, name: row.name, bytes: size });
      if (schedule.enabled) await this.rotate(row.server_id, schedule.retention).catch((err) => logger.warn({ err }, 'Aufbewahrungsregel fehlgeschlagen'));
      return completed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, backupId: row.id }, 'Backup fehlgeschlagen');
      await fs.rm(part, { force: true }).catch(() => {});
      await fs.rm(target, { force: true }).catch(() => {});
      const failed: BackupRow = { ...row, status: 'failed', error: message, completed_at: this.now().toISOString() };
      registry.saveBackup(failed);
      registry.audit('backup.failed', row.server_id, actor, { backupId: row.id, error: message });
      return failed;
    } finally {
      if (sampler) clearInterval(sampler);
      this.busy.delete(row.server_id);
      // Kurz stehen lassen, damit die Oberflaeche das Ende noch sieht
      setTimeout(() => this.progress.delete(row.id), 3000).unref();
    }
  }

  // ------------------------------------------------------------ Pruefen

  async verify(serverId: string, backupId: string): Promise<BackupVerification> {
    const c = this.need(serverId);
    const row = this.owned(serverId, backupId);
    if (row.status !== 'completed') throw new BackupError('Nur abgeschlossene Backups können geprüft werden');
    const updated = await this.verifyRow(row, c);
    return updated.verification_details!;
  }

  private async verifyRow(row: BackupRow, c: ServerInstanceConfig): Promise<BackupRow> {
    const archive = this.filePath(row.server_id, row.id);
    const verifiedAt = this.now().toISOString();
    const finish = (details: Omit<BackupVerification, 'verifiedAt'>): BackupRow => {
      const full: BackupVerification = { ...details, verifiedAt };
      const updated: BackupRow = { ...row, verification_status: full.status, verified_at: verifiedAt, verification_details: full };
      this.deps.registry.saveBackup(updated);
      return updated;
    };
    const bad = (error: string, sha256Match: boolean, archiveIntact = false) =>
      finish({ status: 'corrupted', sha256Match, archiveIntact, filesCount: 0, criticalFilesFound: [], error });

    if (!existsSync(archive)) return bad('Archivdatei existiert nicht auf der Festplatte', false);
    let hash: string;
    try {
      hash = await sha256(archive);
    } catch (err) {
      return bad(`Hash-Berechnung fehlgeschlagen: ${(err as Error).message}`, false);
    }
    if (row.checksum && hash !== row.checksum) {
      return bad('SHA-256 Prüfsummen-Abweichung! Das Archiv wurde nachträglich verändert oder ist fehlerhaft.', false);
    }

    const listing = await runTar([...compression(archive), '-tf', path.basename(archive)], path.dirname(archive)).catch((err: Error) => ({ code: -1, stdout: '', stderr: err.message }));
    if (listing.code !== 0) return bad(`Archiv lässt sich nicht lesen: ${listing.stderr.trim() || `tar Code ${listing.code}`}`, true);
    const files = listing.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (files.length === 0) return bad('Das Archiv enthält keine Dateien', true);

    const expected = criticalFilesFor(await this.deps.gameName(c));
    const found = expected.filter((e) => files.some((f) => f.toLowerCase().includes(e.toLowerCase())));
    const missing = expected.filter((e) => !found.includes(e));
    this.deps.registry.audit('backup.verify', row.server_id, 'core', { backupId: row.id, files: files.length, ok: true });
    return finish({
      status: 'valid',
      sha256Match: true,
      archiveIntact: true,
      filesCount: files.length,
      criticalFilesFound: found,
      ...(missing.length ? { missingCriticalFiles: missing } : {}),
    });
  }

  // ------------------------------------------------------------ Wiederherstellen

  async restore(serverId: string, backupId: string): Promise<void> {
    const c = this.need(serverId);
    const row = this.owned(serverId, backupId);
    const dest = await this.sourceDir(c);
    if (row.status !== 'completed') throw new BackupError('Nur erfolgreich abgeschlossene Backups können wiederhergestellt werden');
    if (!(await this.deps.isStopped(serverId))) throw new BackupError('Der Server läuft - vor dem Wiederherstellen bitte stoppen', 409, 'invalid_state');
    if (this.busy.has(serverId)) throw new BackupError('Für diesen Server läuft bereits ein Backup oder eine Wiederherstellung', 409, 'busy');
    const archive = this.filePath(serverId, backupId);
    if (!existsSync(archive)) throw new BackupError('Die Backup-Datei fehlt auf der Festplatte');

    this.busy.add(serverId);
    this.deps.registry.saveBackup({ ...row, status: 'restoring' });
    try {
      // Ein fremdes Archiv darf nichts ausserhalb des Serverordners schreiben: Namen und Verknuepfungen pruefen.
      const names = await runTar([...compression(archive), '-tf', path.basename(archive)], path.dirname(archive));
      if (names.code !== 0) throw new BackupError(`Archiv lässt sich nicht lesen: ${names.stderr.trim()}`);
      for (const name of names.stdout.split(/\r?\n/).filter(Boolean)) {
        if (/^([\\/]|[A-Za-z]:)/.test(name) || name.split(/[\\/]/).includes('..')) {
          throw new BackupError(`Das Archiv enthält einen unsicheren Pfad ("${name}") und wird nicht entpackt.`);
        }
      }
      const verbose = await runTar([...compression(archive), '-tvf', path.basename(archive)], path.dirname(archive));
      if (verbose.stdout.split(/\r?\n/).some((l) => /^[lh]/.test(l))) {
        throw new BackupError('Das Archiv enthält Verknüpfungen und wird aus Sicherheitsgründen nicht entpackt.');
      }

      await fs.mkdir(dest, { recursive: true });
      const result = await runTar([...compression(archive), '-xf', path.basename(archive), '-C', dest, '--no-same-owner'], path.dirname(archive));
      if (result.code !== 0) throw new BackupError(`Entpacken fehlgeschlagen (tar Code ${result.code}): ${result.stderr.trim()}`);
      this.deps.registry.saveBackup({ ...row, status: 'completed' });
      this.deps.registry.audit('backup.restore', serverId, 'standalone', { backupId, name: row.name });
    } catch (err) {
      this.deps.registry.saveBackup({ ...row, status: 'completed' });
      throw err;
    } finally {
      this.busy.delete(serverId);
    }
  }

  // ------------------------------------------------------------ Sperren, Loeschen, Aufbewahren

  setLock(serverId: string, backupId: string, locked: boolean): BackupRow {
    const row = { ...this.owned(serverId, backupId), locked };
    this.deps.registry.saveBackup(row);
    this.deps.registry.audit(locked ? 'backup.lock' : 'backup.unlock', serverId, 'standalone', { backupId });
    return row;
  }

  async remove(serverId: string, backupId: string): Promise<void> {
    const row = this.owned(serverId, backupId);
    if (row.locked) throw new BackupError('Gesperrte Backups können nicht gelöscht werden. Vorher die Sperre aufheben.');
    if (row.status === 'running' || row.status === 'restoring') throw new BackupError('Das Backup wird gerade benutzt', 409, 'busy');
    await fs.rm(this.filePath(serverId, backupId), { force: true });
    this.deps.registry.deleteBackup(backupId);
    this.deps.registry.audit('backup.delete', serverId, 'standalone', { backupId, name: row.name });
  }

  /** Haelt nur die neuesten `keep` ungesperrten, fertigen Backups. */
  async rotate(serverId: string, keep: number): Promise<string[]> {
    if (keep <= 0) return [];
    const candidates = this.deps.registry.listBackups(serverId).filter((b) => b.status === 'completed' && !b.locked);
    const removed: string[] = [];
    for (const b of candidates.slice(keep)) {
      await fs.rm(this.filePath(serverId, b.id), { force: true });
      this.deps.registry.deleteBackup(b.id);
      removed.push(b.id);
    }
    if (removed.length) this.deps.registry.audit('backup.rotate', serverId, 'core', { removed: removed.length, keep });
    return removed;
  }

  /** Beim Loeschen eines Servers: seine Backups gehen mit (die Zeilen loescht die Registry). */
  async purgeServer(serverId: string): Promise<void> {
    await fs.rm(this.serverDir(serverId), { recursive: true, force: true }).catch(() => {});
  }

  // ------------------------------------------------------------ Automatik

  getSchedule(serverId: string): BackupSchedule {
    const stored = this.deps.registry.getSetting<StoredSchedule>(`server.${serverId}.backup_schedule`);
    if (!stored) return { ...DEFAULT_SCHEDULE };
    const { anchorAt: _anchor, ...rest } = stored;
    return { ...DEFAULT_SCHEDULE, ...rest };
  }

  putSchedule(serverId: string, input: { enabled: boolean; intervalHours: number; retention: number; verify: boolean }): BackupSchedule {
    this.need(serverId);
    const key = `server.${serverId}.backup_schedule`;
    const old = this.deps.registry.getSetting<StoredSchedule>(key);
    const stored: StoredSchedule = {
      ...input,
      lastAutoBackupAt: old?.lastAutoBackupAt ?? null,
      // Wer einschaltet, bekommt das erste Backup nach einem Intervall - nicht sofort
      anchorAt: old?.enabled && old.anchorAt ? old.anchorAt : this.now().toISOString(),
    };
    this.deps.registry.setSetting(key, stored);
    this.deps.registry.audit('backup.schedule_update', serverId, 'standalone', { ...input });
    return this.getSchedule(serverId);
  }

  /** Ein Durchgang der Automatik. @returns Anzahl gestarteter Backups */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let started = 0;
    try {
      const now = this.now().getTime();
      for (const c of this.deps.registry.list()) {
        const stored = this.deps.registry.getSetting<StoredSchedule>(`server.${c.id}.backup_schedule`);
        if (!stored?.enabled || this.busy.has(c.id)) continue;
        const base = new Date(stored.lastAutoBackupAt ?? stored.anchorAt ?? now).getTime();
        if (now - base < stored.intervalHours * 3600_000) continue;
        this.deps.registry.setSetting(`server.${c.id}.backup_schedule`, { ...stored, lastAutoBackupAt: new Date(now).toISOString() });
        try {
          const { done } = await this.create(c.id, { name: `${generateBackupName(c.name, await this.deps.gameName(c), this.now())}_auto`, actor: 'core', auto: true });
          started++;
          void done;
        } catch (err) {
          logger.warn({ err, serverId: c.id }, 'Automatisches Backup nicht gestartet');
        }
      }
    } finally {
      this.ticking = false;
    }
    return started;
  }

  /** Nach einem Neustart laeuft nichts mehr von frueher: unterbrochene Backups aufraeumen. */
  async recoverInterrupted(): Promise<void> {
    for (const b of this.deps.registry.backupsWithStatus('running')) {
      await fs.rm(`${this.filePath(b.server_id, b.id)}.part`, { force: true }).catch(() => {});
      await fs.rm(this.filePath(b.server_id, b.id), { force: true }).catch(() => {});
      this.deps.registry.saveBackup({ ...b, status: 'failed', error: 'Durch Neustart des Cores unterbrochen', completed_at: this.now().toISOString() });
    }
    for (const b of this.deps.registry.backupsWithStatus('restoring')) {
      this.deps.registry.saveBackup({ ...b, status: 'completed', error: 'Eine Wiederherstellung wurde durch einen Neustart unterbrochen - Dateien prüfen' });
    }
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    void this.recoverInterrupted();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
