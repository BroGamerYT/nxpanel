import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { isServerIcon } = await import('../src/http/routes/extras.js');

let server: Awaited<ReturnType<typeof createCoreServer>>;
let registry: InstanceType<typeof ServerRegistry>;
let driver: InstanceType<typeof MockDriver>;
let dataDir: string;
let outside: string;
let auth: Record<string, string>;
const json = { 'content-type': 'application/json' };

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers = auth) =>
  server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

/** Ein gültiges PNG mit beliebiger Größe (nur Kopf und leere Daten - reicht für die Prüfung der Maße). */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-extras-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-extras-out-'));
  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };

  const dir = path.join(dataDir, 'servers', 'ex-1');
  await fs.mkdir(path.join(dir, 'config', 'mods', 'cache'), { recursive: true });
  await fs.mkdir(path.join(dir, 'plugins', 'Essentials'), { recursive: true });
  await fs.writeFile(path.join(dir, 'server.properties'), 'motd=x\n');
  await fs.writeFile(path.join(dir, 'config', 'a.toml'), 'x=1');
  await fs.writeFile(path.join(dir, 'config', 'bild.png'), 'kein config');
  await fs.writeFile(path.join(dir, 'config', 'mods', 'b.json'), '{}');
  await fs.writeFile(path.join(dir, 'config', 'mods', 'cache', 'c.json'), '{}');
  await fs.writeFile(path.join(dir, 'plugins', 'Essentials', 'config.yml'), 'a: 1');
  await fs.writeFile(path.join(dir, 'plugins', 'Essentials', '.versteckt.yml'), 'a: 1');
  await fs.writeFile(path.join(outside, 'geheim.cfg'), 'nicht fuer dich');
  for (const [id, wd, game] of [['ex-1', dir, 'minecraft-paper'], ['ex-pal', path.join(dataDir, 'servers', 'ex-pal'), 'palworld'], ['ex-aussen', outside, 'minecraft-paper']] as const) {
    await fs.mkdir(wd, { recursive: true });
    const config = { id, name: `Server ${id}`, game, executable: 'x', args: [], workingDir: wd, ports: [] };
    await registry.add(config);
    await driver.registerServer(config);
  }
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('Konfigurationsdateien', () => {
  it('Funktionen gemeldet; ohne Anmeldung 401', async () => {
    expect((await call('GET', '/api/v1/about')).json().features).toEqual(expect.arrayContaining(['configs', 'motd']));
    expect((await call('GET', '/api/v1/servers/ex-1/configs', undefined, {})).statusCode).toBe(401);
  });

  it('listet vorhandene Hauptdateien und Mod-Konfigurationen, ohne Fremdes', async () => {
    const list = (await call('GET', '/api/v1/servers/ex-1/configs')).json().configs as Array<{ path: string; name: string; exists: boolean; group: string }>;
    const byPath = new Map(list.map((c) => [c.path, c]));
    expect(byPath.get('server.properties')).toMatchObject({ exists: true, group: 'main', name: 'server.properties' });
    expect(byPath.get('config/a.toml')).toMatchObject({ group: 'config', name: 'a.toml' });
    expect(byPath.get('config/mods/b.json')).toMatchObject({ name: 'mods/b.json' });
    expect(byPath.get('plugins/Essentials/config.yml')).toMatchObject({ group: 'plugins' });
    expect(byPath.has('config/bild.png')).toBe(false); // keine Konfigurationsendung
    expect(byPath.has('config/mods/cache/c.json')).toBe(false); // Cache-Ordner übersprungen
    expect(byPath.has('plugins/Essentials/.versteckt.yml')).toBe(false);
    expect(byPath.has('bukkit.yml')).toBe(false); // nicht vorhanden und nicht vom Egg verlangt
  });

  it('Dateien, die das Egg verlangt, erscheinen auch ohne Datei (zum Anlegen)', async () => {
    const list = (await call('GET', '/api/v1/servers/ex-pal/configs')).json().configs as Array<{ path: string; exists: boolean }>;
    expect(list.find((c) => c.path === 'Pal/Saved/Config/WindowsServer/PalWorldSettings.ini')).toMatchObject({ exists: false });
  });

  it('Server außerhalb des Server-Verzeichnisses und unbekannte Server', async () => {
    expect((await call('GET', '/api/v1/servers/ex-aussen/configs')).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/servers/gibt-es-nicht/configs')).statusCode).toBe(404);
  });

  it('eine Verknüpfung als Konfigurationsdatei wird nicht gelistet', async () => {
    const dir = path.join(dataDir, 'servers', 'ex-1');
    try {
      await fs.symlink(path.join(outside, 'geheim.cfg'), path.join(dir, 'bukkit.yml'));
    } catch {
      return; // keine Symlinks erlaubt
    }
    const list = (await call('GET', '/api/v1/servers/ex-1/configs')).json().configs as Array<{ path: string }>;
    expect(list.some((c) => c.path === 'bukkit.yml')).toBe(false);
    await fs.rm(path.join(dir, 'bukkit.yml'));
  });
});

describe('Server-Icon', () => {
  it('Maße werden geprüft', () => {
    expect(isServerIcon(png(64, 64))).toBe(true);
    expect(isServerIcon(png(32, 64))).toBe(false);
    expect(isServerIcon(png(65, 64))).toBe(false);
    expect(isServerIcon(Buffer.from('GIF89a-kein-png-und-viel-zu-kurz-aber-lang-genug-fuer-24'))).toBe(false);
  });

  it('setzen, lesen, löschen', async () => {
    expect((await call('GET', '/api/v1/servers/ex-1/mc/icon')).statusCode).toBe(404);
    const data = png(64, 64);
    const put = await call('PUT', '/api/v1/servers/ex-1/mc/icon', { png: `data:image/png;base64,${data.toString('base64')}` });
    expect(put.statusCode, put.body).toBe(200);
    const got = await call('GET', '/api/v1/servers/ex-1/mc/icon');
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.rawPayload.equals(data)).toBe(true);
    expect((await call('DELETE', '/api/v1/servers/ex-1/mc/icon')).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/servers/ex-1/mc/icon')).statusCode).toBe(404);
  });

  it('falsche Bilder und Server außerhalb werden abgelehnt', async () => {
    const put = (id: string, b: Buffer) => call('PUT', `/api/v1/servers/${id}/mc/icon`, { png: b.toString('base64') });
    expect((await put('ex-1', png(100, 100))).statusCode).toBe(400);
    expect((await put('ex-1', Buffer.from('x'.repeat(100)))).statusCode).toBe(400);
    expect((await call('PUT', '/api/v1/servers/ex-1/mc/icon', {})).statusCode).toBe(400);
    expect((await put('ex-aussen', png(64, 64))).statusCode).toBe(403);
    await expect(fs.stat(path.join(outside, 'server-icon.png'))).rejects.toThrow();
  });

  it('schreibt nicht durch eine Verknüpfung nach draußen', async () => {
    const dir = path.join(dataDir, 'servers', 'ex-1');
    const target = path.join(outside, 'ziel.png');
    await fs.writeFile(target, 'unveraendert');
    try {
      await fs.symlink(target, path.join(dir, 'server-icon.png'));
    } catch {
      return; // keine Symlinks erlaubt
    }
    const res = await call('PUT', '/api/v1/servers/ex-1/mc/icon', { png: png(64, 64).toString('base64') });
    expect(res.statusCode).toBe(200);
    expect(await fs.readFile(target, 'utf8')).toBe('unveraendert');
    await fs.rm(path.join(dir, 'server-icon.png'));
  });
});

describe('Modpack und Aktivität', () => {
  it('Modpack-Zustand ist leer statt 404', async () => {
    const res = await call('GET', '/api/v1/servers/ex-1/modpack');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: null, job: null, updateAvailable: false });
    expect((await call('GET', '/api/v1/servers/gibt-es-nicht/modpack')).statusCode).toBe(404);
  });

  it('Aktivitätsfeed: Server-Ereignisse mit Namen und Schwere, ohne Dateien und Anmeldungen', async () => {
    registry.audit('server.start', 'ex-1', 'standalone');
    registry.audit('file.edit', 'ex-1', 'standalone', { path: 'a' });
    registry.audit('backup.failed', 'ex-1', 'core', { error: 'Platte voll' });
    registry.audit('schedule.run', 'ex-1', 'core', { name: 'Nachts', ok: false });
    registry.audit('server.delete', 'weg-1', 'standalone', { name: 'Altes' });
    const res = (await call('GET', '/api/v1/dashboard/activity')).json();
    const kinds = res.items.map((i: any) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['server_started', 'backup_failed', 'schedule_failed', 'server_deleted']));
    expect(res.items.some((i: any) => i.summary.startsWith('Datei'))).toBe(false);
    expect(res.items.every((i: any) => !String(i.kind).startsWith('auth'))).toBe(true);
    const failed = res.items.find((i: any) => i.kind === 'backup_failed');
    expect(failed).toMatchObject({ severity: 'error', serverId: 'ex-1', serverName: 'Server ex-1', shortId: 'ex-1', summary: 'Backup fehlgeschlagen: Platte voll' });
    expect(res.items.find((i: any) => i.kind === 'server_deleted')).toMatchObject({ serverName: 'Altes', severity: 'warn' });
    expect(res.items[0].id).toBeGreaterThan(res.items[1].id); // neueste zuerst
    expect((await call('GET', '/api/v1/dashboard/activity', undefined, {})).statusCode).toBe(401);
  });
});
