import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ServerRegistry, RegistryCorruptError } from '../src/store/registry.js';
import { DatabaseCorruptError, MIGRATIONS, openDatabase, runMigrations } from '../src/store/database.js';

const sample = (id: string, port = 25565) => ({
  id,
  name: `Server ${id}`,
  game: 'minecraft',
  executable: 'start.bat',
  args: ['--nogui'],
  workingDir: id,
  maxMemoryMb: 4096,
  ports: [{ name: 'game', hostPort: port, protocol: 'tcp' as const }],
  env: { EULA: 'true' },
});

const open: InstanceType<typeof ServerRegistry>[] = [];
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-db-'));
  dirs.push(dir);
  return dir;
}

async function openRegistry(dir: string): Promise<InstanceType<typeof ServerRegistry>> {
  const registry = await ServerRegistry.open(dir);
  open.push(registry);
  return registry;
}

afterEach(async () => {
  for (const registry of open.splice(0)) registry.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('Block B1 - Datenbank und Migrationen', () => {
  it('legt core.db mit allen Tabellen an', async () => {
    const dir = await tempDir();
    await openRegistry(dir);
    expect((await fs.readdir(dir)).some((f) => f === 'core.db')).toBe(true);

    const db = new DatabaseSync(path.join(dir, 'core.db'));
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (t) => t.name,
      );
      for (const table of ['instances', 'settings', 'audit', 'tasks', 'schema_migrations']) {
        expect(tables, table).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it('fuehrt jede Migration genau einmal aus', () => {
    const db = new DatabaseSync(':memory:');
    try {
      expect(runMigrations(db)).toEqual(MIGRATIONS.map((m) => m.id));
      expect(runMigrations(db)).toEqual([]);

      const extra = [...MIGRATIONS, { id: 99, name: 'test', sql: 'CREATE TABLE extra (a TEXT)' }];
      expect(runMigrations(db, extra)).toEqual([99]);
      expect(runMigrations(db, extra)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rollt eine fehlerhafte Migration vollstaendig zurueck', () => {
    const db = new DatabaseSync(':memory:');
    try {
      runMigrations(db);
      const kaputt = [
        ...MIGRATIONS,
        { id: 50, name: 'kaputt', sql: 'CREATE TABLE halb (a TEXT); CREATE TABLE instances (x TEXT);' },
      ];
      expect(() => runMigrations(db, kaputt)).toThrow(/Migration 50 \(kaputt\) fehlgeschlagen/);
      const halb = db.prepare("SELECT name FROM sqlite_master WHERE name = 'halb'").get();
      expect(halb).toBeUndefined();
      expect(db.prepare('SELECT count(*) AS n FROM schema_migrations WHERE id = 50').get()).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('startet nicht mit einer Datenbank, die neuer ist als der Core', () => {
    const db = new DatabaseSync(':memory:');
    try {
      runMigrations(db, [...MIGRATIONS, { id: 99, name: 'zukunft', sql: 'CREATE TABLE z (a TEXT)' }]);
      expect(() => runMigrations(db)).toThrow(/neuer als dieser Core/);
    } finally {
      db.close();
    }
  });

  it('sichert eine kaputte core.db weg und bricht ab', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'core.db'), 'das ist keine datenbank, sondern nur text '.repeat(40));

    await expect(openDatabase(dir)).rejects.toBeInstanceOf(DatabaseCorruptError);

    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith('core.db.korrupt-'))).toBe(true);
    expect(files).not.toContain('core.db');
    // Ein bewusster Neustart beginnt mit leerer Datenbank.
    expect((await openRegistry(dir)).list()).toEqual([]);
  });
});

describe('Block B1 - Instanzen', () => {
  it('speichert Instanzen vollstaendig und in der Reihenfolge des Anlegens', async () => {
    const dir = await tempDir();
    const registry = await openRegistry(dir);
    await registry.add(sample('zeta', 25565));
    await registry.add(sample('alpha', 25566));
    registry.close();

    const again = await openRegistry(dir);
    expect(again.list().map((s) => s.id)).toEqual(['zeta', 'alpha']);
    expect(again.get('zeta')).toEqual(sample('zeta', 25565));
  });

  it('aendert und entfernt Instanzen dauerhaft', async () => {
    const dir = await tempDir();
    const registry = await openRegistry(dir);
    await registry.add(sample('a'));
    await registry.add(sample('b', 25566));

    await registry.update({ ...sample('a'), name: 'Umbenannt', maxMemoryMb: 8192 });
    await expect(registry.update(sample('gibt-es-nicht'))).rejects.toThrow(/nicht gefunden/);
    expect(await registry.remove('b')).toBe(true);
    expect(await registry.remove('b')).toBe(false);
    registry.close();

    const again = await openRegistry(dir);
    expect(again.list().map((s) => s.id)).toEqual(['a']);
    expect(again.get('a')).toMatchObject({ name: 'Umbenannt', maxMemoryMb: 8192 });
  });

  it('laesst bei doppelter ID alles beim Alten', async () => {
    const dir = await tempDir();
    const registry = await openRegistry(dir);
    await registry.add(sample('a'));
    await expect(registry.add({ ...sample('a'), name: 'Zweiter' })).rejects.toThrow(/existiert/);
    expect(registry.get('a')!.name).toBe('Server a');
  });
});

describe('Block B1 - Umzug aus servers.json', () => {
  it('uebernimmt die alte Datei und behaelt sie als .migriert', async () => {
    const dir = await tempDir();
    const legacy = { version: 1, servers: [sample('alt-1', 25565), sample('alt-2', 25566)] };
    await fs.writeFile(path.join(dir, 'servers.json'), JSON.stringify(legacy));

    const registry = await openRegistry(dir);
    expect(registry.list().map((s) => s.id)).toEqual(['alt-1', 'alt-2']);
    expect(registry.get('alt-2')).toEqual(sample('alt-2', 25566));

    const files = await fs.readdir(dir);
    expect(files).not.toContain('servers.json');
    expect(files).toContain('servers.json.migriert');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'servers.json.migriert'), 'utf8'))).toEqual(legacy);
    expect(registry.recentAudit()[0]).toMatchObject({ action: 'registry.migrated', detail: { instances: 2 } });
    registry.close();

    // Zweiter Start: nichts doppelt, die Daten kommen aus der Datenbank.
    const again = await openRegistry(dir);
    expect(again.list()).toHaveLength(2);
  });

  it('ueberschreibt vorhandene Daten nicht mit einer liegengebliebenen servers.json', async () => {
    const dir = await tempDir();
    const registry = await openRegistry(dir);
    await registry.add(sample('neu'));
    registry.close();

    await fs.writeFile(path.join(dir, 'servers.json'), JSON.stringify({ version: 1, servers: [sample('uralt')] }));
    const again = await openRegistry(dir);
    expect(again.list().map((s) => s.id)).toEqual(['neu']);
    expect(await fs.readdir(dir)).toContain('servers.json.migriert');
  });

  it('bricht bei beschaedigter servers.json ab und laesst die Datenbank leer', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'servers.json'), '{ kaputt');
    await expect(ServerRegistry.open(dir)).rejects.toBeInstanceOf(RegistryCorruptError);
    expect((await fs.readdir(dir)).some((f) => f.startsWith('servers.json.korrupt-'))).toBe(true);
    expect((await openRegistry(dir)).list()).toEqual([]);
  });
});

describe('Block B1 - Einstellungen, Audit, Aufgaben', () => {
  it('speichert Einstellungen als beliebige JSON-Werte', async () => {
    const dir = await tempDir();
    const registry = await openRegistry(dir);
    expect(registry.getSetting('gaming.mode')).toBeUndefined();
    registry.setSetting('gaming.mode', { enabled: true, cpuPercent: 40 });
    registry.setSetting('gaming.mode', { enabled: false, cpuPercent: 40 });
    registry.setSetting('zahl', 0);
    registry.close();

    const again = await openRegistry(dir);
    expect(again.getSetting('gaming.mode')).toEqual({ enabled: false, cpuPercent: 40 });
    expect(again.getSetting<number>('zahl')).toBe(0);
    again.deleteSetting('zahl');
    expect(again.getSetting('zahl')).toBeUndefined();
  });

  it('schreibt Audit-Eintraege, neueste zuerst, ohne Geheimnisse', async () => {
    const dir = await tempDir();
    const registry = await openRegistry(dir);
    registry.audit('server.create', 'a', 'panel', { name: 'A' });
    registry.audit('server.start', 'a', 'standalone');
    registry.audit('server.start', 'b', 'panel', { password: 'geheim', rconToken: 'x', port: 25565 });

    const all = registry.recentAudit();
    expect(all.map((e) => e.action)).toEqual(['server.start', 'server.start', 'server.create']);
    expect(all[0]!.detail).toEqual({ password: '[entfernt]', rconToken: '[entfernt]', port: 25565 });
    expect(registry.recentAudit({ serverId: 'a' })).toHaveLength(2);
    expect(registry.recentAudit({ limit: 1 })).toHaveLength(1);

    const raw = await fs.readFile(path.join(dir, 'core.db'));
    expect(raw.includes(Buffer.from('geheim'))).toBe(false);
  });

  it('fuehrt Aufgaben mit Fortschritt und markiert unterbrochene nach einem Neustart', async () => {
    const dir = await tempDir();
    const registry = await openRegistry(dir);
    const install = registry.createTask('install', 'a', 'SteamCMD wird geladen');
    const backup = registry.createTask('backup', 'a');
    expect(install).toMatchObject({ status: 'queued', progress: 0, serverId: 'a' });

    registry.updateTask(install.id, { status: 'running', progress: 0.42, message: 'Lade 3,1 von 7,4 GB' });
    registry.updateTask(backup.id, { status: 'done', progress: 5, result: { file: 'a.tar.zst' } });
    expect(registry.getTask(install.id)).toMatchObject({ status: 'running', progress: 0.42 });
    expect(registry.getTask(backup.id)).toMatchObject({ status: 'done', progress: 1, result: { file: 'a.tar.zst' } });
    expect(registry.listTasks({ active: true }).map((t) => t.id)).toEqual([install.id]);
    expect(registry.updateTask('gibt-es-nicht', { progress: 1 })).toBeUndefined();
    registry.close();

    const again = await openRegistry(dir);
    expect(again.failInterruptedTasks()).toBe(1);
    expect(again.getTask(install.id)).toMatchObject({ status: 'failed' });
    expect(again.getTask(backup.id)).toMatchObject({ status: 'done' });
    expect(again.listTasks({ active: true })).toEqual([]);
  });
});
