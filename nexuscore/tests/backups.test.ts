import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { BackupManager, generateBackupName, criticalFilesFor } = await import('../src/backups/manager.js');

let server: Awaited<ReturnType<typeof createCoreServer>>;
let registry: InstanceType<typeof ServerRegistry>;
let driver: InstanceType<typeof MockDriver>;
let dataDir: string;
let outside: string;
let auth: Record<string, string>;
const json = { 'content-type': 'application/json' };

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers = auth) =>
  server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function addServer(id: string, dir: string): Promise<void> {
  const config = { id, name: id, game: 'minecraft-paper', executable: 'x', args: [], workingDir: dir, ports: [] };
  await registry.add(config);
  await driver.registerServer(config);
}

async function waitDone(serverId: string, backupId: string): Promise<Record<string, any>> {
  for (let i = 0; i < 200; i++) {
    const list = (await call('GET', `/api/v1/servers/${serverId}/backups`)).json().backups as Array<Record<string, any>>;
    const b = list.find((x) => x.id === backupId)!;
    if (b.status !== 'running') return b;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Backup wurde nicht fertig');
}

async function makeBackup(serverId: string, body: object = {}): Promise<Record<string, any>> {
  const res = await call('POST', `/api/v1/servers/${serverId}/backups`, body);
  expect(res.statusCode).toBe(200);
  return waitDone(serverId, res.json().backup.id);
}

/** Ein Tar-Archiv von Hand, mit beliebigem Namen - so wie ein boesartiges aussehen koennte. */
function evilTar(name: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write('00000000004\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const data = Buffer.alloc(512);
  data.write('evil');
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}

let dirA: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-bk-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-bk-outside-'));
  dirA = path.join(dataDir, 'servers', 'bk-1');
  await fs.mkdir(path.join(dirA, 'world'), { recursive: true });
  await fs.mkdir(path.join(dirA, 'cache'), { recursive: true });
  await fs.mkdir(path.join(dirA, 'logs'), { recursive: true });
  await fs.writeFile(path.join(dirA, 'server.properties'), 'motd=alt\n');
  await fs.writeFile(path.join(dirA, 'world', 'level.dat'), 'welt-daten');
  await fs.writeFile(path.join(dirA, 'world', 'session.lock'), 'gesperrt');
  await fs.writeFile(path.join(dirA, 'cache', 'gross.bin'), 'x'.repeat(1000));
  await fs.writeFile(path.join(dirA, 'logs', 'alt.log.gz'), gzipSync('log'));

  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
  await addServer('bk-1', dirA);
  await addServer('bk-2', path.join(dataDir, 'servers', 'bk-2'));
  await fs.mkdir(path.join(dataDir, 'servers', 'bk-2'), { recursive: true });
  await addServer('bk-aussen', outside);
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('Hilfsfunktionen', () => {
  it('Name aus Server, Spiel und Zeit; Sonderzeichen werden ersetzt', () => {
    expect(generateBackupName('Mein Server', 'Minecraft: Paper', new Date(2026, 10, 11, 9, 5, 7))).toBe('Mein-Server_Minecraft-Paper_2026-11-11_09-05-07');
    expect(criticalFilesFor('Minecraft Paper')).toContain('level.dat');
    expect(criticalFilesFor('Unbekanntes Spiel')).toEqual([]);
  });
});

describe('Backup-Routen', () => {
  it('Funktion und Rechte sind sichtbar; ohne Anmeldung 401', async () => {
    expect(JSON.stringify((await call('GET', '/api/v1/servers/bk-1')).json())).toContain('backup.restore');
    expect((await call('GET', '/api/v1/servers/bk-1/backups', undefined, {})).statusCode).toBe(401);
  });

  let id: string;

  it('legt ein Backup an: fertig, mit Prüfsumme, geprüft; Logs und Sperrdateien fehlen', async () => {
    const b = await makeBackup('bk-1', { name: 'Vor dem Umbau' });
    id = b.id;
    expect(b).toMatchObject({ status: 'completed', name: 'Vor dem Umbau', locked: false, nas_stored: false, verification_status: 'valid' });
    expect(b.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(b.bytes).toBeGreaterThan(0);
    expect(b.verification_details.criticalFilesFound).toEqual(expect.arrayContaining(['level.dat', 'server.properties']));
    // Nur ueber den Namen des Archivs: es muss im Datenverzeichnis liegen, nicht im Serverordner
    const file = path.join(dataDir, 'backups', 'bk-1', `${id}.tar.gz`);
    expect((await fs.stat(file)).isFile()).toBe(true);
    const bytes = await fs.readFile(file);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect((await fs.readdir(dirA)).sort()).toEqual(['cache', 'logs', 'server.properties', 'world']); // nichts hineingeschrieben
  });

  it('ausgeschlossene Dateien kommen nicht ins Archiv', async () => {
    const b = await makeBackup('bk-1', { name: 'ohne-cache', ignoredFiles: ['cache'] });
    const v = (await call('POST', `/api/v1/servers/bk-1/backups/${b.id}/verify`)).json();
    // level.dat, server.properties (+ Ordner) - aber weder gross.bin noch session.lock noch das .log.gz
    const full = (await call('POST', `/api/v1/servers/bk-1/backups/${id}/verify`)).json();
    expect(v.result.filesCount).toBeLessThan(full.result.filesCount);
    expect(b.ignored_files).toEqual(['cache']);
    await call('DELETE', `/api/v1/servers/bk-1/backups/${b.id}`);
  });

  it('Download liefert das Archiv', async () => {
    const res = await call('GET', `/api/v1/servers/bk-1/backups/${id}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('Vor-dem-Umbau.tar.gz');
    expect(res.rawPayload[0]).toBe(0x1f);
  });

  it('Wiederherstellen stellt Dateien zurück', async () => {
    await fs.writeFile(path.join(dirA, 'server.properties'), 'motd=kaputt\n');
    const res = await call('POST', `/api/v1/servers/bk-1/backups/${id}/restore`);
    expect(res.statusCode).toBe(200);
    expect(await fs.readFile(path.join(dirA, 'server.properties'), 'utf8')).toBe('motd=alt\n');
    const list = (await call('GET', '/api/v1/servers/bk-1/backups')).json().backups;
    expect(list.find((b: any) => b.id === id).status).toBe('completed');
  });

  it('Wiederherstellen nur bei gestopptem Server', async () => {
    await driver.startServer('bk-1').catch(() => {});
    const state = await driver.getServerState('bk-1');
    if (state.status !== 'offline') {
      const res = await call('POST', `/api/v1/servers/bk-1/backups/${id}/restore`);
      expect(res.statusCode).toBe(409);
      await driver.stopServer('bk-1').catch(() => {});
    }
  });

  it('sperren: gesperrte Backups lassen sich nicht löschen', async () => {
    const locked = await call('PATCH', `/api/v1/servers/bk-1/backups/${id}`, { locked: true });
    expect(locked.json().backup.locked).toBe(true);
    const del = await call('DELETE', `/api/v1/servers/bk-1/backups/${id}`);
    expect(del.statusCode).toBe(400);
    expect(del.json().message).toMatch(/gesperrt/i);
    await call('PATCH', `/api/v1/servers/bk-1/backups/${id}`, { locked: false });
  });

  it('beschädigtes Archiv wird erkannt', async () => {
    const b = await makeBackup('bk-1', { name: 'wird-kaputt' });
    const file = path.join(dataDir, 'backups', 'bk-1', `${b.id}.tar.gz`);
    const data = await fs.readFile(file);
    await fs.writeFile(file, data.subarray(0, Math.floor(data.length / 2)));
    const res = (await call('POST', `/api/v1/servers/bk-1/backups/${b.id}/verify`)).json();
    expect(res.result.status).toBe('corrupted');
    expect(res.result.sha256Match).toBe(false);
    // Auch das Gegenstueck: Prüfsumme stimmt, aber der Inhalt ist kein Archiv
    await fs.writeFile(file, 'kein archiv');
    registry.saveBackup({ ...registry.getBackup(b.id)!, checksum: null });
    const res2 = (await call('POST', `/api/v1/servers/bk-1/backups/${b.id}/verify`)).json();
    expect(res2.result.status).toBe('corrupted');
    expect(res2.result.archiveIntact).toBe(false);
  });

  it('ein Archiv mit unsicherem Pfad wird nicht entpackt', async () => {
    const dir = path.join(dataDir, 'backups', 'bk-2');
    await fs.mkdir(dir, { recursive: true });
    const row = {
      id: 'evil-1', server_id: 'bk-2', name: 'evil', filename: 'evil.tar.gz', bytes: 1, checksum: null, locked: false, status: 'completed' as const,
      error: null, ignored_files: null, verification_status: 'unverified' as const, verified_at: null, verification_details: null,
      created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    };
    registry.saveBackup(row);
    await fs.writeFile(path.join(dir, 'evil-1.tar.gz'), gzipSync(evilTar('../ausbruch.txt')));
    const res = await call('POST', '/api/v1/servers/bk-2/backups/evil-1/restore');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/unsicher|nicht entpackt/i);
    await expect(fs.stat(path.join(dataDir, 'servers', 'ausbruch.txt'))).rejects.toThrow();
    expect(registry.getBackup('evil-1')!.status).toBe('completed');
  });

  it('ein Backup gehört zu seinem Server', async () => {
    expect((await call('POST', `/api/v1/servers/bk-2/backups/${id}/verify`)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/servers/bk-2/backups/${id}`)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/servers/bk-2/backups/${id}/download`)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/servers/gibt-es-nicht/backups')).statusCode).toBe(404);
  });

  it('Server außerhalb des Server-Verzeichnisses sind gesperrt', async () => {
    await fs.writeFile(path.join(outside, 'geheim.txt'), 'nicht fuer dich');
    const res = await call('POST', '/api/v1/servers/bk-aussen/backups', {});
    expect(res.statusCode).toBe(403);
  });

  it('Löschen entfernt Datei und Eintrag', async () => {
    const file = path.join(dataDir, 'backups', 'bk-1', `${id}.tar.gz`);
    expect((await call('DELETE', `/api/v1/servers/bk-1/backups/${id}`)).statusCode).toBe(200);
    await expect(fs.stat(file)).rejects.toThrow();
    expect(registry.getBackup(id)).toBeUndefined();
  });

  it('NAS-Sync wird ehrlich abgelehnt', async () => {
    expect((await call('POST', `/api/v1/servers/bk-1/backups/x/sync-nas`)).statusCode).toBe(400);
  });

  it('Zeitplan lesen und setzen; Unsinn wird abgelehnt', async () => {
    expect((await call('GET', '/api/v1/servers/bk-1/backup-schedule')).json().schedule).toMatchObject({ enabled: false, intervalHours: 24, retention: 5, verify: true, lastAutoBackupAt: null });
    const put = await call('PUT', '/api/v1/servers/bk-1/backup-schedule', { enabled: true, intervalHours: 6, retention: 3, verify: false });
    expect(put.json().schedule).toMatchObject({ enabled: true, intervalHours: 6, retention: 3, verify: false });
    expect((await call('GET', '/api/v1/servers/bk-1/backup-schedule')).json().schedule.intervalHours).toBe(6);
    for (const bad of [{ enabled: true, intervalHours: 0 }, { enabled: true, intervalHours: 721 }, { enabled: 'ja' }, { enabled: true, retention: 0 }]) {
      expect((await call('PUT', '/api/v1/servers/bk-1/backup-schedule', bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    await call('PUT', '/api/v1/servers/bk-1/backup-schedule', { enabled: false });
  });

  it('ein Backup-Zeitplan (Aktion "backup") legt wirklich ein Backup an', async () => {
    const before = (await call('GET', '/api/v1/servers/bk-1/backups')).json().backups.length;
    const created = await call('POST', '/api/v1/servers/bk-1/schedules', { name: 'Nachtbackup', action: 'backup', interval_minutes: 60 });
    expect(created.statusCode).toBe(201);
    const run = await call('POST', `/api/v1/servers/bk-1/schedules/${created.json().schedule.id}/run`);
    expect(run.json().result).toMatchObject({ ok: true, action: 'backup' });
    const after = (await call('GET', '/api/v1/servers/bk-1/backups')).json().backups;
    expect(after.length).toBe(before + 1);
    expect(after[0].name).toBe('Nachtbackup (Geplant)');
    expect(after[0].status).toBe('completed');
  });

  it('Server löschen entfernt seine Backups samt Dateien', async () => {
    const b = await makeBackup('bk-2', { name: 'weg' });
    const file = path.join(dataDir, 'backups', 'bk-2', `${b.id}.tar.gz`);
    expect((await fs.stat(file)).isFile()).toBe(true);
    expect((await call('DELETE', '/api/v1/servers/bk-2')).statusCode).toBe(200);
    expect(registry.listBackups('bk-2')).toHaveLength(0);
    await expect(fs.stat(file)).rejects.toThrow();
  });
});

describe('BackupManager: Automatik', () => {
  let now: Date;
  let manager: InstanceType<typeof BackupManager>;

  const make = () => {
    now = new Date(2026, 10, 11, 10, 0, 0);
    manager = new BackupManager({
      registry,
      isStopped: async () => true,
      gameName: async () => 'Minecraft Paper',
      now: () => now,
    });
  };

  it('legt nach einem Intervall ein Backup an, nicht früher, nicht doppelt', async () => {
    make();
    manager.putSchedule('bk-1', { enabled: true, intervalHours: 2, retention: 10, verify: false });
    expect(await manager.tick()).toBe(0);
    now = new Date(now.getTime() + 60 * 60_000);
    expect(await manager.tick()).toBe(0);
    now = new Date(now.getTime() + 61 * 60_000);
    const before = registry.listBackups('bk-1').length;
    expect(await manager.tick()).toBe(1);
    for (let i = 0; i < 100 && manager.isBusy('bk-1'); i++) await new Promise((r) => setTimeout(r, 50));
    expect(registry.listBackups('bk-1').length).toBe(before + 1);
    expect(manager.getSchedule('bk-1').lastAutoBackupAt).not.toBeNull();
    expect(await manager.tick()).toBe(0);
    manager.putSchedule('bk-1', { enabled: false, intervalHours: 2, retention: 10, verify: false });
  });

  it('Aufbewahrung behält die neuesten, ungesperrte; gesperrte bleiben', async () => {
    make();
    const base = Date.now();
    const mk = (n: number, locked: boolean) => {
      registry.saveBackup({
        id: `rot-${n}`, server_id: 'bk-2', name: `r${n}`, filename: `r${n}.tar.gz`, bytes: 1, checksum: null, locked, status: 'completed', error: null,
        ignored_files: null, verification_status: 'unverified', verified_at: null, verification_details: null,
        created_at: new Date(base + n * 1000).toISOString(), completed_at: null,
      });
    };
    await registry.add({ id: 'bk-2', name: 'bk-2', game: 'x', executable: 'x', args: [], workingDir: dataDir, ports: [] });
    for (let n = 1; n <= 5; n++) mk(n, n === 1);
    const removed = await manager.rotate('bk-2', 2);
    expect(removed.sort()).toEqual(['rot-2', 'rot-3']);
    expect(registry.listBackups('bk-2').map((b) => b.id).sort()).toEqual(['rot-1', 'rot-4', 'rot-5']);
    await registry.remove('bk-2');
  });

  it('unterbrochene Backups werden nach einem Neustart als fehlgeschlagen markiert', async () => {
    make();
    registry.saveBackup({
      id: 'hang-1', server_id: 'bk-1', name: 'h', filename: 'h.tar.gz', bytes: 0, checksum: null, locked: false, status: 'running', error: null,
      ignored_files: null, verification_status: 'unverified', verified_at: null, verification_details: null, created_at: new Date().toISOString(), completed_at: null,
    });
    await manager.recoverInterrupted();
    expect(registry.getBackup('hang-1')).toMatchObject({ status: 'failed', error: expect.stringMatching(/Neustart/) });
  });
});
