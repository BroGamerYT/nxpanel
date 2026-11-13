import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CORE_VERSION } from '../version.js';

/**
 * Sicherung des Cores selbst (nicht der Spielserver - die haben ihre eigenen Backups): Datenbank (Server, Einstellungen, Benutzer-Rechte,
 * Audit), Benutzerkonten, Schluessel der Geheimnisse und Firewall-Regeln. Klein und schnell, deshalb vor jedem Update automatisch.
 *
 * Wiederherstellen geht nur beim Start des Cores (die Datenbank ist im Betrieb offen): die Route merkt die Wiederherstellung vor
 * (`restore-pending.json`), startet den Core neu, und `applyPendingRestore` spielt sie ein, bevor die Datenbank geoeffnet wird.
 * Der alte Stand wird vorher selbst als Sicherung abgelegt.
 */

export const BACKUP_FOLDER = 'core-backups';
const DB_NAME = 'core.db';
/** Dateien und Ordner im Datenordner, die zum Zustand des Cores gehoeren (ohne Datenbank, die kommt per Momentaufnahme). */
const STATE_FILES = ['users.json', 'secret.key', 'firewall-rules.json'];
const STATE_DIRS = ['steam-login'];
const KEEP = 10;
const ID = /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/;

export interface CoreBackupInfo {
  id: string;
  createdAt: string;
  reason: string;
  version: string;
  sizeBytes: number;
  files: string[];
}

interface Manifest extends CoreBackupInfo {
  sums: Record<string, string>;
}

export class BackupError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'backup_error') {
    super(message);
  }
}

const slug = (reason: string): string => reason.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'manuell';
const stamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function listFilesRecursive(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFilesRecursive(full, base)));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

/** Was die Sicherung vom Core braucht: den Datenordner und eine Momentaufnahme der Datenbank (die ServerRegistry kann beides). */
export interface BackupSource {
  readonly dir: string;
  snapshot(file: string): void;
}

export class CoreBackups {
  readonly root: string;

  constructor(private readonly source: BackupSource) {
    this.root = path.join(source.dir, BACKUP_FOLDER);
  }

  /** Legt eine Sicherung an. `reason`: kurzer Anlass ("manuell", "vor Update 0.3.9"). */
  async create(reason = 'manuell'): Promise<CoreBackupInfo> {
    const id = `${stamp()}-${slug(reason)}`;
    const tmp = path.join(this.root, `.${id}.tmp`);
    const target = path.join(this.root, id);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    try {
      // Datenbank: eine in sich stimmige Momentaufnahme, auch wenn der Core gerade schreibt
      this.source.snapshot(path.join(tmp, DB_NAME));
      for (const name of STATE_FILES) {
        const from = path.join(this.source.dir, name);
        if (existsSync(from)) await copyFile(from, path.join(tmp, name));
      }
      for (const name of STATE_DIRS) {
        const from = path.join(this.source.dir, name);
        if (existsSync(from)) await cp(from, path.join(tmp, name), { recursive: true });
      }
      const manifest = await sealFolder(tmp, id, reason);
      await rename(tmp, target);
      await this.prune();
      return this.info(manifest);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw new BackupError(`Sicherung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, 500, 'backup_failed');
    }
  }

  private info(m: Manifest): CoreBackupInfo {
    return { id: m.id, createdAt: m.createdAt, reason: m.reason, version: m.version, sizeBytes: m.sizeBytes, files: m.files };
  }

  private async readManifest(id: string): Promise<Manifest | null> {
    if (!ID.test(id)) return null;
    try {
      return JSON.parse(await readFile(path.join(this.root, id, 'manifest.json'), 'utf8')) as Manifest;
    } catch {
      return null;
    }
  }

  async list(): Promise<CoreBackupInfo[]> {
    if (!existsSync(this.root)) return [];
    const out: CoreBackupInfo[] = [];
    for (const e of await readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const m = await this.readManifest(e.name);
      if (m) out.push(this.info(m));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async remove(id: string): Promise<void> {
    if (!(await this.readManifest(id))) throw new BackupError('Diese Sicherung gibt es nicht.', 404, 'not_found');
    await rm(path.join(this.root, id), { recursive: true, force: true });
  }

  /** Stimmen alle Dateien der Sicherung mit den gemerkten Pruefsummen ueberein? */
  async verify(id: string): Promise<{ ok: boolean; problems: string[] }> {
    const m = await this.readManifest(id);
    if (!m) return { ok: false, problems: ['Sicherung nicht gefunden'] };
    return verifyFolder(path.join(this.root, id), m);
  }

  /** Merkt die Wiederherstellung vor; eingespielt wird sie beim naechsten Start des Cores. */
  async stageRestore(id: string): Promise<void> {
    const v = await this.verify(id);
    if (!v.ok) throw new BackupError(`Die Sicherung ist beschädigt: ${v.problems.join('; ')}`, 409, 'backup_corrupt');
    await writeFile(path.join(this.source.dir, PENDING), JSON.stringify({ id, at: new Date().toISOString() }), 'utf8');
  }

  private async prune(): Promise<void> {
    const all = await this.list();
    for (const old of all.slice(KEEP)) await rm(path.join(this.root, old.id), { recursive: true, force: true });
  }
}

const PENDING = 'restore-pending.json';

/** Schreibt die Liste der Dateien mit Pruefsummen (manifest.json) in den Ordner einer Sicherung. */
async function sealFolder(dir: string, id: string, reason: string): Promise<Manifest> {
  const files = (await listFilesRecursive(dir)).filter((f) => f !== 'manifest.json').sort();
  const sums: Record<string, string> = {};
  let sizeBytes = 0;
  for (const f of files) {
    sums[f] = await sha256(path.join(dir, f));
    sizeBytes += (await stat(path.join(dir, f))).size;
  }
  const manifest: Manifest = { id, createdAt: new Date().toISOString(), reason, version: CORE_VERSION, sizeBytes, files, sums };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function verifyFolder(dir: string, m: Manifest): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  for (const f of m.files) {
    const file = path.join(dir, f);
    if (!existsSync(file)) {
      problems.push(`${f} fehlt`);
      continue;
    }
    if ((await sha256(file)) !== m.sums[f]) problems.push(`${f} ist verändert`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Beim Start, VOR dem Oeffnen der Datenbank: eine vorgemerkte Wiederherstellung einspielen.
 * Gibt die Sicherung zurueck, die eingespielt wurde (oder null). Schlaegt etwas fehl, bleibt der alte Stand unberuehrt.
 */
export async function applyPendingRestore(dataDir: string): Promise<{ id: string; safety: string } | null> {
  const marker = path.join(dataDir, PENDING);
  if (!existsSync(marker)) return null;
  let id = '';
  try {
    id = (JSON.parse(await readFile(marker, 'utf8')) as { id?: string }).id ?? '';
  } catch {
    /* kaputte Markierung: unten entfernt */
  }
  const dir = path.join(dataDir, BACKUP_FOLDER, id);
  try {
    if (!ID.test(id) || !existsSync(path.join(dir, 'manifest.json'))) throw new Error('Sicherung nicht gefunden');
    const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    const v = await verifyFolder(dir, m);
    if (!v.ok) throw new Error(v.problems.join('; '));

    // Den jetzigen Stand sichern (Datenbank samt Journal ist hier noch zu - einfach kopieren)
    const safety = `${stamp()}-vor-wiederherstellung`;
    const safetyDir = path.join(dataDir, BACKUP_FOLDER, safety);
    await mkdir(safetyDir, { recursive: true });
    const oldDb = path.join(dataDir, DB_NAME);
    if (existsSync(oldDb)) {
      try {
        const old = new DatabaseSync(oldDb);
        try {
          old.exec(`VACUUM INTO '${path.join(safetyDir, DB_NAME).replace(/'/g, "''")}'`);
        } finally {
          old.close();
        }
      } catch {
        // Datenbank unlesbar (vielleicht der Grund fuer die Wiederherstellung): die Rohdateien aufheben
        for (const name of [DB_NAME, `${DB_NAME}-wal`]) {
          if (existsSync(path.join(dataDir, name))) await copyFile(path.join(dataDir, name), path.join(safetyDir, `${name}.roh`));
        }
      }
    }
    for (const name of STATE_FILES) {
      if (existsSync(path.join(dataDir, name))) await copyFile(path.join(dataDir, name), path.join(safetyDir, name));
    }
    for (const name of STATE_DIRS) {
      if (existsSync(path.join(dataDir, name))) await cp(path.join(dataDir, name), path.join(safetyDir, name), { recursive: true });
    }
    await sealFolder(safetyDir, safety, 'vor Wiederherstellung');

    // Einspielen: Datenbank ersetzen (altes Journal weg), Dateien und Ordner ueberschreiben
    await rm(path.join(dataDir, `${DB_NAME}-wal`), { force: true });
    await rm(path.join(dataDir, `${DB_NAME}-shm`), { force: true });
    await copyFile(path.join(dir, DB_NAME), path.join(dataDir, DB_NAME));
    for (const name of STATE_FILES) {
      const from = path.join(dir, name);
      if (existsSync(from)) await copyFile(from, path.join(dataDir, name));
    }
    for (const name of STATE_DIRS) {
      const from = path.join(dir, name);
      if (existsSync(from)) await cp(from, path.join(dataDir, name), { recursive: true, force: true });
    }
    return { id, safety };
  } finally {
    // Die Markierung immer entfernen - sonst wuerde ein Fehler bei jedem Start wiederholt
    await rm(marker, { force: true });
  }
}
