import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { serverRootFor } = await import('../src/protocol/paths.js');

let dataDir: string;
let serversDir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
let auth: Record<string, string>;
const json = { 'content-type': 'application/json' };
const get = (url: string, headers = auth) => server.inject({ method: 'GET', url, headers });
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload: unknown) =>
  server.inject({ method, url, headers: { ...auth, ...json }, payload: payload as object });
const F = '/api/v1/admin/files';

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-af-'));
  serversDir = serverRootFor(dataDir);
  await fs.mkdir(path.join(serversDir, 'alpha'), { recursive: true });
  await fs.mkdir(path.join(serversDir, 'rest-eines-alten'), { recursive: true });
  await fs.writeFile(path.join(serversDir, 'alpha', 'server.properties'), 'motd=Hallo\n');
  await fs.writeFile(path.join(serversDir, 'rest-eines-alten', 'daten.bin'), Buffer.alloc(2048));
  await fs.mkdir(path.join(dataDir, 'backups'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'backups', 'b1.tar.gz'), 'x');
  await fs.writeFile(path.join(dataDir, 'geheim.txt'), 'nicht fuer den Dateimanager');
  registry = await ServerRegistry.open(dataDir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
  await registry.add({ id: 'af-1', name: 'Alpha-Server', game: 'minecraft-paper', executable: 'x', args: [], workingDir: path.join(serversDir, 'alpha'), ports: [] });
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Admin-Dateimanager', () => {
  it('verlangt eine Anmeldung', async () => {
    expect((await get(F, {})).statusCode).toBe(401);
    expect((await get(`${F}/spieldaten`, {})).statusCode).toBe(401);
  });

  it('zeigt nur Spieldaten und Backups (nicht den Datenordner)', async () => {
    const roots = (await get(F)).json().roots;
    expect(roots.map((r: { id: string }) => r.id)).toEqual(['spieldaten', 'backups']);
    expect(roots.find((r: { id: string }) => r.id === 'backups').readOnly).toBe(true);
    expect(roots.find((r: { id: string }) => r.id === 'spieldaten').readOnly).toBe(false);
    expect((await get(`${F}/daten`)).statusCode).toBe(404);
  });

  it('beschriftet Server-Ordner und erkennt verwaiste', async () => {
    const entries = (await get(`${F}/spieldaten`)).json().entries as Array<{ name: string; label?: string; orphan?: boolean }>;
    expect(entries.find((e) => e.name === 'alpha')).toMatchObject({ label: 'Alpha-Server · minecraft-paper' });
    expect(entries.find((e) => e.name === 'rest-eines-alten')).toMatchObject({ orphan: true });
    // Eine Ebene tiefer keine Beschriftung
    const inner = (await get(`${F}/spieldaten?path=alpha`)).json().entries as Array<{ label?: string }>;
    expect(inner.every((e) => e.label === undefined)).toBe(true);
  });

  it('liest, speichert, legt an, benennt um und löscht', async () => {
    expect((await get(`${F}/spieldaten/content?path=alpha/server.properties`)).json().content).toContain('motd=Hallo');
    expect((await send('PUT', `${F}/spieldaten/content`, { path: 'alpha/server.properties', content: 'motd=Neu\n' })).statusCode).toBe(200);
    expect(await fs.readFile(path.join(serversDir, 'alpha', 'server.properties'), 'utf8')).toBe('motd=Neu\n');
    expect((await send('POST', `${F}/spieldaten/directory`, { path: 'alpha/plugins' })).statusCode).toBe(200);
    expect((await send('POST', `${F}/spieldaten/rename`, { from: 'alpha/plugins', to: 'alpha/mods' })).statusCode).toBe(200);
    expect((await send('DELETE', `${F}/spieldaten`, { path: 'alpha/mods' })).statusCode).toBe(200);
    await expect(fs.stat(path.join(serversDir, 'alpha', 'mods'))).rejects.toThrow();
    const audit = JSON.stringify((await get('/api/v1/admin/audit?action=admin.file')).json());
    for (const a of ['admin.file.edit', 'admin.file.mkdir', 'admin.file.rename', 'admin.file.delete']) expect(audit).toContain(a);
  });

  it('packt und entpackt', async () => {
    expect((await send('POST', `${F}/spieldaten/compress`, { paths: ['alpha/server.properties'], destination: 'alpha/sicherung.zip' })).statusCode).toBe(200);
    await fs.rm(path.join(serversDir, 'alpha', 'server.properties'));
    const res = await send('POST', `${F}/spieldaten/decompress`, { path: 'alpha/sicherung.zip', destination: 'alpha' });
    expect(res.statusCode).toBe(200);
    expect(await fs.readFile(path.join(serversDir, 'alpha', 'server.properties'), 'utf8')).toBe('motd=Neu\n');
  });

  it('schützt Backups: lesen ja, ändern nein', async () => {
    expect((await get(`${F}/backups`)).json().entries.map((e: { name: string }) => e.name)).toContain('b1.tar.gz');
    for (const [method, url, payload] of [
      ['PUT', `${F}/backups/content`, { path: 'b1.tar.gz', content: 'x' }],
      ['POST', `${F}/backups/directory`, { path: 'neu' }],
      ['POST', `${F}/backups/rename`, { from: 'b1.tar.gz', to: 'b2.tar.gz' }],
      ['DELETE', `${F}/backups`, { path: 'b1.tar.gz' }],
    ] as const) {
      const res = await send(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().code).toBe('read_only');
    }
    await expect(fs.stat(path.join(dataDir, 'backups', 'b1.tar.gz'))).resolves.toBeTruthy();
  });

  it('lässt niemanden aus dem Ordner ausbrechen', async () => {
    for (const bad of ['../geheim.txt', '..%2Fgeheim.txt', 'alpha/../../geheim.txt', '/etc/passwd', 'C:\\Windows\\win.ini']) {
      const res = await get(`${F}/spieldaten/content?path=${bad}`);
      expect(res.statusCode, bad).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain('nicht fuer den Dateimanager');
    }
    expect((await send('DELETE', `${F}/spieldaten`, { path: '../geheim.txt' })).statusCode).toBeGreaterThanOrEqual(400);
    await expect(fs.stat(path.join(dataDir, 'geheim.txt'))).resolves.toBeTruthy();
  });

  it('misst die Größe der Ordner, größte zuerst', async () => {
    const res = (await get(`${F}/spieldaten/usage`)).json();
    expect(res.partial).toBe(false);
    expect(res.entries[0]).toMatchObject({ name: 'rest-eines-alten', bytes: 2048, orphan: true });
    expect(res.entries.find((e: { name: string }) => e.name === 'alpha').label).toContain('Alpha-Server');
  });
});
