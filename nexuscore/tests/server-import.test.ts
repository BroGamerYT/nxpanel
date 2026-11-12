import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'nx-import-data-'));
process.env.NEXUSCORE_DATA_DIR = dataDir;
process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { createZip } = await import('../src/files/archive.js');
const { importArchive, matchEntry, safeTarget, importRoot } = await import('../src/servers/importer.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', ...json };
const PW = 'ein-sicheres-passwort-1';

type Headers = Record<string, string>;
interface Core {
  dir: string;
  registry: InstanceType<typeof ServerRegistry>;
  server: Awaited<ReturnType<typeof createCoreServer>>;
  lines: string[];
}
const cores: Core[] = [];

async function boot(driverName?: string): Promise<Core> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-import-'));
  const registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  if (driverName) Object.defineProperty(driver, 'name', { value: driverName });
  await driver.initialize();
  const bus = new EventBus();
  const lines: string[] = [];
  bus.on((e) => {
    const ev = e as { type: string; line?: string };
    if (ev.type === 'console' && ev.line?.startsWith('[Import]')) lines.push(ev.line);
  });
  const server = await createCoreServer(driver, bus, registry, { installs: null, scheduler: false });
  const core = { dir, registry, server, lines };
  cores.push(core);
  return core;
}
afterAll(async () => {
  for (const c of cores) {
    await c.server.close();
    c.registry.close();
    await fs.rm(c.dir, { recursive: true, force: true });
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

const caller = (c: Core) => (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Headers = MASTER, payload?: unknown) =>
  c.server.inject({
    method,
    url,
    headers: payload === undefined ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type')) : headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function login(c: Core, name: string, password: string): Promise<Headers> {
  const res = await c.server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: name, password } });
  return { authorization: `Bearer ${res.json().accessToken}`, ...json };
}

async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Ein Minecraft-Backup (wie AMP es packt: alles in einem Unterordner, dazu Papierkorb und Backups). */
async function makeBackup(name: string, extra: Record<string, string> = {}): Promise<string> {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-import-src-'));
  const files: Record<string, string> = {
    'Minecraft/server.properties': 'motd=Aus dem Backup\nserver-port=25565\n',
    'Minecraft/eula.txt': 'eula=true\n',
    'Minecraft/world/level.dat': 'x',
    'Minecraft/world/region/r.0.0.mca': 'welt',
    'Minecraft/plugins/dynmap/world/tile.png': 'plugin-karte',
    'Minecraft/logs/latest.log': 'log',
    'Minecraft/.trash/alt.txt': 'weg',
    'Minecraft/Backups/alt.zip': 'weg',
    ...extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(src, rel)), { recursive: true });
    await fs.writeFile(path.join(src, rel), content);
  }
  await createZip(src, ['Minecraft'], `${name}.zip`);
  await fs.mkdir(importRoot(), { recursive: true });
  await fs.copyFile(path.join(src, `${name}.zip`), path.join(importRoot(), `${name}.zip`));
  await fs.rm(src, { recursive: true, force: true });
  return `${name}.zip`;
}

function multipart(filename: string, content: Buffer): { payload: Buffer; contentType: string } {
  const boundary = '----nxtest' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function addMinecraft(c: Core, id: string, ownerId?: string): Promise<string> {
  const root = path.join(c.dir, 'servers', id);
  await fs.mkdir(root, { recursive: true });
  await c.registry.add({ id, name: id, game: 'minecraft-paper', executable: 'x', args: [], workingDir: root, ports: [] });
  if (ownerId) await caller(c)('PUT', `/api/v1/admin/users/${ownerId}/servers/${id}`, MASTER, { isOwner: true });
  return root;
}

// ------------------------------------------------------------------------------------------------------------------

describe('Importregeln (rein)', () => {
  const rules = [
    { match: 'world', to: 'world' },
    { match: 'plugins', to: 'plugins', exclude: ['cache'] },
    { match: 'server.properties', to: 'server.properties' },
  ];
  it('findet die Stelle im Archiv, egal wie tief; der frühere Treffer im Pfad gewinnt', () => {
    expect(matchEntry('Minecraft/world/region/r.mca', rules)).toMatchObject({ rule: { to: 'world' }, rest: ['region', 'r.mca'] });
    expect(matchEntry('a/b/server.properties', rules)?.rest).toEqual([]);
    // "plugins/dynmap/world/..." gehört zu plugins, nicht zu world
    expect(matchEntry('Minecraft/plugins/dynmap/world/tile.png', rules)).toMatchObject({ rule: { to: 'plugins' }, rest: ['dynmap', 'world', 'tile.png'] });
    expect(matchEntry('Minecraft/logs/latest.log', rules)).toBeNull();
  });
  it('Papierkorb, Backups im Backup und Mac-Reste kommen nie mit; ausgeschlossene Ordner auch nicht', () => {
    for (const p of ['x/.trash/world/a', 'x/Backups/world/a', '__MACOSX/world/a']) expect(matchEntry(p, rules), p).toBeNull();
    expect(matchEntry('p/plugins/cache/a.bin', rules)).toBeNull();
    expect(matchEntry('p/plugins/dynmap/a.bin', rules)).not.toBeNull();
  });
  it('das Ziel bricht nie aus dem Datenordner aus', () => {
    const root = path.resolve(os.tmpdir(), 'srv');
    expect(safeTarget(root, 'world', ['a.txt'])).toBe(path.join(root, 'world', 'a.txt'));
    expect(safeTarget(root, '../draussen', ['a.txt'])).toBeNull();
    expect(safeTarget(root, 'world', ['..', '..', 'x'])).toBeNull();
  });
});

describe('Import in einen vorhandenen Server', () => {
  let c: Core;
  let call: ReturnType<typeof caller>;
  let owner: Headers;
  let ownerId: string;
  let stranger: Headers;
  let root: string;

  beforeAll(async () => {
    c = await boot();
    call = caller(c);
    const o = await call('POST', '/api/v1/admin/users', MASTER, { username: 'imp-owner', password: PW, canCreateServers: true });
    ownerId = o.json().user.id as string;
    await call('POST', '/api/v1/admin/users', MASTER, { username: 'imp-fremd', password: PW, canCreateServers: true });
    owner = await login(c, 'imp-owner', PW);
    stranger = await login(c, 'imp-fremd', PW);
    root = await addMinecraft(c, 'imp-1', ownerId);
  });

  it('übernimmt Welt und Einstellungen, legt das Alte beiseite, lässt Müll und Logs weg', async () => {
    await fs.mkdir(path.join(root, 'world'), { recursive: true });
    await fs.writeFile(path.join(root, 'world', 'alt.txt'), 'meine alte Welt');
    // Ein Besitzer darf nur seine eigenen Uploads nehmen (Dateien per scp hineinkopiert darf nur ein Administrator)
    const file = await makeBackup(`upload-u${ownerId.slice(0, 8)}-amp-backup-1`);
    const info = (await call('GET', '/api/v1/servers/imp-1/import', owner)).json();
    expect(info.supported).toBe(true);
    expect(info.looksFor).toEqual(expect.arrayContaining(['world', 'server.properties']));

    const res = await call('POST', '/api/v1/servers/imp-1/import', owner, { file });
    expect(res.statusCode, res.body).toBe(202);
    expect(await until(() => c.lines.some((l) => l.includes('Fertig')))).toBe(true);

    expect(await fs.readFile(path.join(root, 'world', 'region', 'r.0.0.mca'), 'utf8')).toBe('welt');
    expect(await fs.readFile(path.join(root, 'server.properties'), 'utf8')).toContain('Aus dem Backup');
    expect(await fs.readFile(path.join(root, 'plugins', 'dynmap', 'world', 'tile.png'), 'utf8')).toBe('plugin-karte');
    // Logs, Papierkorb und Backups-im-Backup kommen nicht mit
    await expect(fs.stat(path.join(root, 'logs'))).rejects.toThrow();
    await expect(fs.stat(path.join(root, '.trash'))).rejects.toThrow();
    // Die alte Welt liegt in .nexuscore/vor-import-...
    const aside = await fs.readdir(path.join(root, '.nexuscore'));
    expect(aside).toHaveLength(1);
    expect(await fs.readFile(path.join(root, '.nexuscore', aside[0]!, 'world', 'alt.txt'), 'utf8')).toBe('meine alte Welt');
    // Das Archiv aus dem Import-Ordner bleibt (nur Hochgeladenes wird danach gelöscht)
    expect((await fs.stat(path.join(importRoot(), file))).isFile()).toBe(true);
    expect((await call('GET', '/api/v1/admin/audit?limit=50')).body).toContain('server.import_done');
  });

  it('ein Besitzer nimmt keine per scp hineinkopierte Datei - nur Administratoren und eigene Uploads', async () => {
    const copied = await makeBackup('hineinkopiert-1');
    expect((await call('POST', '/api/v1/servers/imp-1/import', owner, { file: copied })).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/servers/imp-1/import', owner)).json().files.map((f: { name: string }) => f.name)).not.toContain(copied);
    expect((await call('GET', '/api/v1/servers/imp-1/import', MASTER)).json().files.map((f: { name: string }) => f.name)).toContain(copied);
  });

  it('nur Administrator und Besitzer; ein Fremder sieht den Server nicht', async () => {
    const file = await makeBackup('amp-backup-2');
    expect((await call('POST', '/api/v1/servers/imp-1/import', stranger, { file })).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/servers/imp-1/import', stranger)).statusCode).toBe(404);
    // Mitnutzer mit allen Dateirechten: trotzdem kein Import (ersetzt Spielstände)
    const co = await call('POST', '/api/v1/admin/users', MASTER, { username: 'imp-co', password: PW });
    expect(co.statusCode).toBe(201);
    await call('POST', '/api/v1/servers/imp-1/subusers', MASTER, { user: 'imp-co', preset: 'co-admin' });
    const coAuth = await login(c, 'imp-co', PW);
    expect((await call('POST', '/api/v1/servers/imp-1/import', coAuth, { file })).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/servers/gibtsnicht/import', MASTER, { file })).statusCode).toBe(404);
  });

  it('nur im gestoppten Zustand, und nur eine .zip aus dem Import-Ordner', async () => {
    const file = await makeBackup('amp-backup-3');
    await call('POST', '/api/v1/servers/imp-1/power', MASTER, { action: 'start' });
    const running = await call('POST', '/api/v1/servers/imp-1/import', owner, { file });
    expect(running.statusCode).toBe(409);
    expect(running.json().code).toBe('must_stop');
    await call('POST', '/api/v1/servers/imp-1/power', MASTER, { action: 'kill' });
    await until(async () => (await call('GET', '/api/v1/servers/imp-1', MASTER)).json().server.status === 'offline');

    expect((await call('POST', '/api/v1/servers/imp-1/import', owner, { file: 'passwd' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/servers/imp-1/import', owner, { file: '../../etc/x.zip' })).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/servers/imp-1/import', owner, { file: 'gibtsnicht.zip' })).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/servers/imp-1/import', owner, {})).statusCode).toBe(400);
  });

  it('ein Archiv ohne Passendes: klare Meldung, nichts geändert', async () => {
    const before = await fs.readdir(root);
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-import-leer-'));
    await fs.writeFile(path.join(src, 'egal.txt'), 'x');
    const leerName = `upload-u${ownerId.slice(0, 8)}-leer.zip`;
    await createZip(src, ['egal.txt'], 'leer.zip');
    await fs.mkdir(importRoot(), { recursive: true });
    await fs.copyFile(path.join(src, 'leer.zip'), path.join(importRoot(), leerName));
    await fs.rm(src, { recursive: true, force: true });
    c.lines.length = 0;
    expect((await call('POST', '/api/v1/servers/imp-1/import', owner, { file: leerName })).statusCode).toBe(202);
    expect(await until(() => c.lines.some((l) => l.includes('Nichts Passendes')))).toBe(true);
    expect((await fs.readdir(root)).sort()).toEqual(before.sort());
  });

  it('Hochladen und gleich importieren: die Datei ist danach weg', async () => {
    const zip = await fs.readFile(path.join(importRoot(), await makeBackup('amp-backup-4')));
    const m = multipart('mein backup.zip', zip);
    c.lines.length = 0;
    const res = await c.server.inject({ method: 'POST', url: '/api/v1/servers/imp-1/import/upload', headers: { authorization: owner.authorization!, 'content-type': m.contentType }, payload: m.payload });
    expect(res.statusCode, res.body).toBe(202);
    expect(await until(() => c.lines.some((l) => l.includes('Fertig')))).toBe(true);
    // Das Löschen folgt kurz nach der Meldung "Fertig"
    expect(await until(async () => (await fs.readdir(importRoot())).every((n) => !n.startsWith('upload-imp-1')))).toBe(true);
    // keine .zip: abgelehnt
    const bad = multipart('x.exe', Buffer.from('MZ'));
    expect((await c.server.inject({ method: 'POST', url: '/api/v1/servers/imp-1/import/upload', headers: { authorization: owner.authorization!, 'content-type': bad.contentType }, payload: bad.payload })).statusCode).toBe(400);
  });
});

describe('Archive vor dem Anlegen: hochladen, ansehen, löschen', () => {
  let c: Core;
  let call: ReturnType<typeof caller>;
  let alice: Headers;
  let bob: Headers;

  beforeAll(async () => {
    c = await boot();
    call = caller(c);
    for (const n of ['imp-alice', 'imp-bob']) await call('POST', '/api/v1/admin/users', MASTER, { username: n, password: PW, canCreateServers: true });
    await call('POST', '/api/v1/admin/users', MASTER, { username: 'imp-normal', password: PW });
    alice = await login(c, 'imp-alice', PW);
    bob = await login(c, 'imp-bob', PW);
  });

  it('wer keine Server anlegen darf, kommt nicht heran', async () => {
    const normal = await login(c, 'imp-normal', PW);
    expect((await call('GET', '/api/v1/imports', normal)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/imports/analyze', normal, { file: 'x.zip' })).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/imports', { ...json })).statusCode).toBe(401);
  });

  it('hochladen, ansehen: das Spiel wird erkannt; jeder sieht nur seine eigenen Uploads', async () => {
    const zip = await fs.readFile(path.join(importRoot(), await makeBackup('amp-backup-5')));
    const m = multipart('Mein Server.zip', zip);
    const up = await c.server.inject({ method: 'POST', url: '/api/v1/imports/upload', headers: { authorization: alice.authorization!, 'content-type': m.contentType }, payload: m.payload });
    expect(up.statusCode, up.body).toBe(201);
    const file = up.json().file as string;
    expect(file).toMatch(/^upload-u[0-9a-f]{8}-\d+-Mein_Server\.zip$/);

    expect((await call('GET', '/api/v1/imports', alice)).json().files.map((f: { name: string }) => f.name)).toContain(file);
    // Bob sieht die Datei nicht und kann sie weder ansehen noch löschen
    expect((await call('GET', '/api/v1/imports', bob)).json().files.map((f: { name: string }) => f.name)).not.toContain(file);
    expect((await call('POST', '/api/v1/imports/analyze', bob, { file })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/imports/${file}`, bob)).statusCode).toBe(404);

    const analysis = await call('POST', '/api/v1/imports/analyze', alice, { file });
    expect(analysis.statusCode, analysis.body).toBe(200);
    const a = analysis.json();
    expect(a.bytes).toBeGreaterThan(0);
    expect(a.candidates[0]).toMatchObject({ eggId: 'minecraft-paper' });
    expect(a.candidates[0].matched).toEqual(expect.arrayContaining(['world', 'server.properties']));

    expect((await call('DELETE', `/api/v1/imports/${file}`, alice)).json()).toEqual({ ok: true });
    expect((await call('GET', '/api/v1/imports', alice)).json().files.map((f: { name: string }) => f.name)).not.toContain(file);
  });

  it('kein Zip oder ein kaputtes Archiv: klare Antwort', async () => {
    const bad = multipart('x.txt', Buffer.from('kein zip'));
    expect((await c.server.inject({ method: 'POST', url: '/api/v1/imports/upload', headers: { authorization: alice.authorization!, 'content-type': bad.contentType }, payload: bad.payload })).statusCode).toBe(400);
    const broken = multipart('kaputt.zip', Buffer.from('PK\u0003\u0004 aber kein Archiv'));
    const up = await c.server.inject({ method: 'POST', url: '/api/v1/imports/upload', headers: { authorization: alice.authorization!, 'content-type': broken.contentType }, payload: broken.payload });
    const res = await call('POST', '/api/v1/imports/analyze', alice, { file: up.json().file });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('bad_archive');
  });

  it('Server anlegen und die Daten gleich übernehmen', async () => {
    const zip = await fs.readFile(path.join(importRoot(), await makeBackup('amp-backup-6')));
    const m = multipart('neu.zip', zip);
    const up = await c.server.inject({ method: 'POST', url: '/api/v1/imports/upload', headers: { authorization: alice.authorization!, 'content-type': m.contentType }, payload: m.payload });
    const file = up.json().file as string;
    c.lines.length = 0;
    const created = await call('POST', '/api/v1/servers', alice, { name: 'Aus Backup', eggId: 'minecraft-paper', ramMb: 2048, variables: { EULA: 'TRUE' }, importFile: file });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().server.id as string;
    expect(await until(() => c.lines.some((l) => l.includes('Fertig')))).toBe(true);
    const root = path.join(c.dir, 'servers', id);
    expect(await fs.readFile(path.join(root, 'world', 'region', 'r.0.0.mca'), 'utf8')).toBe('welt');
    // hochgeladen = nach dem Import gelöscht
    expect(await until(async () => !(await fs.stat(path.join(importRoot(), file)).catch(() => null)))).toBe(true);
    // fremde oder unbekannte Datei beim Anlegen: abgelehnt, nichts angelegt
    const before = c.registry.list().length;
    expect((await call('POST', '/api/v1/servers', bob, { name: 'Klau', eggId: 'minecraft-paper', importFile: 'amp-backup-6.zip' })).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/servers', alice, { name: 'Weg', eggId: 'minecraft-paper', importFile: 'gibtsnicht.zip' })).statusCode).toBe(404);
    expect(c.registry.list().length).toBe(before);
  });
});

describe('Auf einem Rechner, wo Dateien ändern nur Administratoren dürfen (direkte Prozesse)', () => {
  it('ein Besitzer darf dort nicht importieren - ein Import schriebe Dateien in den Server-Ordner', async () => {
    const c = await boot('windows-native');
    const call = caller(c);
    const o = await call('POST', '/api/v1/admin/users', MASTER, { username: 'nat-owner', password: PW, canCreateServers: true });
    const owner = await login(c, 'nat-owner', PW);
    await addMinecraft(c, 'nat-1', o.json().user.id as string);
    const file = await makeBackup('amp-backup-7');
    const res = await call('POST', '/api/v1/servers/nat-1/import', owner, { file });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('Administrator');
    // Der Administrator darf
    expect((await call('POST', '/api/v1/servers/nat-1/import', MASTER, { file })).statusCode).toBe(202);
    // Beim Anlegen: ebenso
    const created = await call('POST', '/api/v1/servers', owner, { name: 'X', eggId: 'minecraft-paper', importFile: file });
    expect(created.statusCode).toBe(403);
  });
});

describe('Importieren selbst (Entpacker)', () => {
  it('liefert die Zahlen und legt ein vorhandenes Ziel beiseite', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-import-unit-'));
    await fs.mkdir(path.join(src, 'x', 'world'), { recursive: true });
    await fs.writeFile(path.join(src, 'x', 'world', 'a.dat'), '1');
    await fs.writeFile(path.join(src, 'x', 'world', 'b.dat'), '22');
    await createZip(src, ['x'], 'u.zip');
    const made = { path: path.join(src, 'u.zip') };
    const server = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-import-unit-srv-'));
    await fs.mkdir(path.join(server, 'world'), { recursive: true });
    await fs.writeFile(path.join(server, 'world', 'alt.dat'), 'alt');
    const r = await importArchive(server, made.path, [{ match: 'world', to: 'world' }], null);
    expect(r).toMatchObject({ files: 2, bytes: 3, matched: { world: 2 } });
    expect(r.backupDir).toBeTruthy();
    expect(await fs.readdir(path.join(server, 'world'))).toEqual(expect.arrayContaining(['a.dat', 'b.dat']));
    expect(await fs.readdir(path.join(server, 'world'))).not.toContain('alt.dat');
    await expect(importArchive(server, made.path, [], null)).rejects.toThrow(/keine Import-Regeln/);
    await fs.rm(src, { recursive: true, force: true });
    await fs.rm(server, { recursive: true, force: true });
  });
});
