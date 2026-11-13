import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyPendingRestore, BACKUP_FOLDER, BackupError, CoreBackups } from '../src/backups/core-backup.js';
import { registerCoreBackupRoutes, runChecks } from '../src/http/routes/core-backups.js';
import { ServerRegistry } from '../src/store/registry.js';

let dir: string;
let registry: ServerRegistry;
let backups: CoreBackups;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-corebackup-'));
  registry = await ServerRegistry.open(dir);
  backups = new CoreBackups(registry);
  await fs.writeFile(path.join(dir, 'users.json'), JSON.stringify({ version: 1, users: [{ id: 'a' }] }));
  await fs.writeFile(path.join(dir, 'secret.key'), 'geheim-1\n');
});
afterEach(async () => {
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Sicherung des Cores', () => {
  it('sichert Datenbank (in sich stimmig), Benutzerkonten und Schlüssel mit Prüfsummen', async () => {
    registry.setSetting('beispiel', 42);
    const info = await backups.create('manuell');
    expect(info.id).toMatch(/^\d{8}-\d{6}-manuell$/);
    expect(info.files).toEqual(expect.arrayContaining(['core.db', 'users.json', 'secret.key', ]));
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    // Die gesicherte Datenbank ist eine echte, lesbare Datenbank mit dem Wert
    const snap = new DatabaseSync(path.join(dir, BACKUP_FOLDER, info.id, 'core.db'));
    expect(snap.prepare("SELECT count(*) AS n FROM settings WHERE key = 'beispiel'").get()).toEqual({ n: 1 });
    snap.close();
    expect(await backups.verify(info.id)).toEqual({ ok: true, problems: [] });
    expect((await backups.list()).map((b) => b.id)).toEqual([info.id]);
  });

  it('hebt nur die neuesten 10 auf, löscht gezielt und lehnt fremde Kennungen ab', async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await backups.create(`lauf ${i}`);
    }
    const all = await backups.list();
    expect(all).toHaveLength(10);
    expect(all[0]!.reason).toBe('lauf 11');
    await backups.remove(all[3]!.id);
    expect(await backups.list()).toHaveLength(9);
    await expect(backups.remove('../../etc')).rejects.toBeInstanceOf(BackupError);
    await expect(backups.stageRestore('..%2f..')).rejects.toBeInstanceOf(BackupError);
  });

  it('erkennt eine veränderte Sicherung und spielt sie nicht ein', async () => {
    const info = await backups.create('test');
    await fs.appendFile(path.join(dir, BACKUP_FOLDER, info.id, 'users.json'), 'manipuliert');
    expect((await backups.verify(info.id)).ok).toBe(false);
    await expect(backups.stageRestore(info.id)).rejects.toMatchObject({ code: 'backup_corrupt', statusCode: 409 });
  });
});

describe('Wiederherstellen beim Start', () => {
  it('spielt den alten Stand ein, sichert den jetzigen vorher und entfernt die Markierung', async () => {
    registry.setSetting('stand', 'alt');
    const info = await backups.create('vor-aenderung');
    registry.setSetting('stand', 'neu');
    await fs.writeFile(path.join(dir, 'users.json'), JSON.stringify({ version: 1, users: [] }));
    await fs.writeFile(path.join(dir, 'secret.key'), 'geheim-2\n');

    await backups.stageRestore(info.id);
    registry.close(); // der Core wird beendet, beim Start wird eingespielt
    const done = await applyPendingRestore(dir);
    expect(done?.id).toBe(info.id);
    expect(done?.safety).toMatch(/-vor-wiederherstellung$/);
    await expect(fs.stat(path.join(dir, 'restore-pending.json'))).rejects.toThrow();

    registry = await ServerRegistry.open(dir);
    expect(registry.getSetting<string>('stand')).toBe('alt');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'users.json'), 'utf8')).users).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, 'secret.key'), 'utf8')).toBe('geheim-1\n');

    // Der Stand vor der Wiederherstellung liegt als eigene, prüfbare Sicherung da - und enthält 'neu'
    const safety = new CoreBackups(registry);
    const list = await safety.list();
    const before = list.find((b) => b.id === done!.safety)!;
    expect(before).toBeTruthy();
    expect((await safety.verify(before.id)).ok).toBe(true);
    const old = new DatabaseSync(path.join(dir, BACKUP_FOLDER, before.id, 'core.db'));
    expect(old.prepare("SELECT value FROM settings WHERE key = 'stand'").get()).toEqual({ value: JSON.stringify('neu') });
    old.close();
  });

  it('ohne Markierung passiert nichts; eine kaputte Markierung lässt den Stand unberührt und verschwindet', async () => {
    expect(await applyPendingRestore(dir)).toBeNull();
    registry.setSetting('stand', 'bleibt');
    registry.close();
    await fs.writeFile(path.join(dir, 'restore-pending.json'), JSON.stringify({ id: '20200101-000000-gibtsnicht' }));
    await expect(applyPendingRestore(dir)).rejects.toThrow();
    await expect(fs.stat(path.join(dir, 'restore-pending.json'))).rejects.toThrow();
    registry = await ServerRegistry.open(dir);
    expect(registry.getSetting<string>('stand')).toBe('bleibt');
  });
});

describe('Routen und Prüfung', () => {
  it('sichern, auflisten, zurückspielen (mit Neustart), löschen', async () => {
    let restarted = 0;
    const app = Fastify();
    registerCoreBackupRoutes(app, { registry, backups, restart: () => void restarted++ });

    const made = (await app.inject({ method: 'POST', url: '/api/v1/admin/core-backups', payload: { reason: 'von Hand' } })).json();
    expect(made.ok).toBe(true);
    const id = made.backup.id as string;
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/core-backups' })).json()).toMatchObject({ backups: [{ id }], pendingRestore: false });

    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/core-backups/20200101-000000-nix/restore' })).statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: `/api/v1/admin/core-backups/${id}/restore` });
    expect(res.json()).toEqual({ ok: true, restarting: true });
    expect(restarted).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/core-backups' })).json().pendingRestore).toBe(true);
    await fs.rm(path.join(dir, 'restore-pending.json'));

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/core-backups/${id}` })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/core-backups/${id}` })).statusCode).toBe(404);
    await app.close();
  });

  it('die Prüfung meldet Datenbank, Datenordner, Konten und fehlende Sicherungen mit Hinweis', async () => {
    const checks = await runChecks(registry, backups, false);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName['Datenbank']!.ok).toBe(true);
    expect(byName['Datenordner']!.ok).toBe(true);
    expect(byName['Benutzerkonten']!.ok).toBe(true);
    expect(byName['Sicherungen']).toMatchObject({ ok: false, fix: expect.stringContaining('sichern') });

    await fs.writeFile(path.join(dir, 'users.json'), '{kaputt');
    expect((await runChecks(registry, backups, false)).find((c) => c.name === 'Benutzerkonten')).toMatchObject({ ok: false, fix: expect.stringContaining('Sicherung') });
    await backups.create('x');
    expect((await runChecks(registry, backups, true)).filter((c) => c.name === 'Sicherungen' || c.name === 'Wiederherstellung').map((c) => c.ok)).toEqual([true, false]);
  });
});
