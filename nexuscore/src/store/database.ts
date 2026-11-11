import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Lokale Datenbank des Cores (`core.db`, Block B1).
 *
 * SQLite ueber `node:sqlite` - in Node eingebaut, also keine native
 * Abhaengigkeit und nichts, was das Paket als einzelne .exe erschwert.
 *
 * Die Migrationen stehen bewusst im Code und nicht als .sql-Dateien: die
 * gepackte .exe hat kein Verzeichnis, aus dem sie Dateien nachladen koennte.
 */

export interface Migration {
  /** Fortlaufende Nummer. Einmal ausgeliefert, nie wieder aendern - nur neue anhaengen. */
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: `
      CREATE TABLE instances (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        game        TEXT NOT NULL,
        config      TEXT NOT NULL,              -- ServerInstanceConfig als JSON
        position    INTEGER NOT NULL,           -- Reihenfolge des Anlegens
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,              -- JSON
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT NOT NULL,
        action      TEXT NOT NULL,              -- z. B. server.create, server.start
        server_id   TEXT,
        actor       TEXT NOT NULL,              -- panel | standalone | core
        detail      TEXT                        -- JSON, nie Geheimnisse
      );
      CREATE INDEX audit_server_ts ON audit (server_id, ts);

      CREATE TABLE tasks (
        id          TEXT PRIMARY KEY,
        server_id   TEXT,
        kind        TEXT NOT NULL,              -- install | backup | update ...
        status      TEXT NOT NULL,              -- queued | running | done | failed | cancelled
        progress    REAL NOT NULL DEFAULT 0,    -- 0..1
        message     TEXT NOT NULL DEFAULT '',
        result      TEXT,                       -- JSON
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX tasks_status ON tasks (status, updated_at);
    `,
  },
  {
    id: 2,
    name: 'schedules',
    sql: `
      CREATE TABLE schedules (
        id               TEXT PRIMARY KEY,
        server_id        TEXT NOT NULL,
        name             TEXT NOT NULL,
        action           TEXT NOT NULL,              -- restart | backup | command
        payload          TEXT,                       -- Befehl bei action = command
        cron             TEXT,                       -- "HH:MM" oder 5 Felder
        interval_minutes INTEGER,
        active           INTEGER NOT NULL DEFAULT 1,
        last_run_at      TEXT,
        next_run_at      TEXT,
        last_status      TEXT NOT NULL DEFAULT 'pending',
        last_error       TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX schedules_server ON schedules (server_id);
      CREATE INDEX schedules_due ON schedules (active, next_run_at);
    `,
  },
];

/** Die Datenbankdatei ist beschaedigt - der Core darf damit nicht weiterlaufen. */
export class DatabaseCorruptError extends Error {
  constructor(
    readonly file: string,
    readonly backup: string,
    reason: string,
  ) {
    super(
      `Die Datenbank ${file} ist beschaedigt (${reason}). Sie wurde nach ${backup} gesichert. ` +
        'Datei pruefen und zurueckkopieren, oder den Core neu starten, um mit leerer Datenbank zu beginnen.',
    );
    this.name = 'DatabaseCorruptError';
  }
}

/** Zeitstempel fuer Dateinamen von Sicherungen. */
export function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Fuehrt alle noch fehlenden Migrationen aus - jede in einer eigenen
 * Transaktion, damit eine halbe Migration nichts hinterlaesst.
 *
 * @returns die Nummern der neu ausgefuehrten Migrationen
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    )`);

  const done = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((row) => Number(row.id)),
  );
  const newest = migrations.reduce((max, m) => Math.max(max, m.id), 0);
  for (const id of done) {
    if (id > newest) {
      throw new Error(
        `Die Datenbank ist neuer als dieser Core (Migration ${id}, bekannt bis ${newest}). Bitte den Core aktualisieren.`,
      );
    }
  }

  const applied: number[] = [];
  const record = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (done.has(migration.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `Migration ${migration.id} (${migration.name}) fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    applied.push(migration.id);
  }
  return applied;
}

/**
 * Oeffnet `core.db` im Datenverzeichnis und bringt das Schema auf Stand.
 *
 * Ist die Datei keine gueltige Datenbank, wird sie als
 * `core.db.korrupt-<zeitstempel>` weggesichert und der Start bricht ab -
 * dieselbe Regel wie frueher bei der servers.json.
 */
export async function openDatabase(dir: string): Promise<{ db: DatabaseSync; file: string }> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'core.db');

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file);
    // WAL: Leser blockieren den Schreiber nicht, und ein Absturz mitten im
    // Schreiben hinterlaesst keine halbe Datei.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const verdict = check ? String(Object.values(check)[0]) : 'keine Antwort';
    if (verdict !== 'ok') throw new Error(verdict);
    runMigrations(db);
    return { db, file };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      db?.close();
    } catch {
      /* schon zu */
    }
    // Nur echte Dateischaeden wegsichern - ein Programmfehler in einer
    // Migration oder eine zu neue Datenbank darf die Daten nicht verschieben.
    if (!/not a database|malformed|corrupt|file is encrypted/i.test(reason)) throw err;

    const backup = `${file}.korrupt-${backupStamp()}`;
    await fs.rename(file, backup);
    for (const suffix of ['-wal', '-shm']) {
      await fs.rm(`${file}${suffix}`, { force: true }).catch(() => {});
    }
    throw new DatabaseCorruptError(file, backup, reason);
  }
}
