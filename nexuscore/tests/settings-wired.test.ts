import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';
process.env.NEXUSCORE_PORT_RANGE = '39700-39799';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');

type ServerInstanceConfig = import('../src/types.js').ServerInstanceConfig;

let server: Awaited<ReturnType<typeof createCoreServer>>;
let driver: InstanceType<typeof MockDriver>;
let registry: InstanceType<typeof ServerRegistry>;
let dataDir: string;
let auth: Record<string, string>;

// Wie die Oberflaeche: nur mit Inhalt kommt ein JSON-Kopf mit - sonst lehnt Fastify die leere Anfrage ab.
const api = (method: 'GET' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = auth) =>
  server.inject({
    method,
    url,
    headers: payload === undefined ? Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'content-type')) : headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

async function add(id: string, port: number): Promise<ServerInstanceConfig> {
  const dir = path.join(dataDir, 'servers', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'eintrag.txt'), 'x');
  const config: ServerInstanceConfig = {
    id,
    name: `Server ${id}`,
    game: 'minecraft-paper',
    executable: 'java',
    args: ['-Xmx3481M', '-jar', 'server.jar', '--nogui'],
    workingDir: dir,
    maxMemoryMb: 4096,
    maxCpuPercent: 200,
    ports: [{ name: 'game', hostPort: port, protocol: 'tcp' }],
    install: { state: 'done', kind: 'minecraft-paper', version: '1.21.11', variables: { TYPE: 'PAPER', VERSION: 'LATEST', EULA: 'TRUE' }, propertiesTemplate: {} },
  };
  await registry.add(config);
  await driver.registerServer(config);
  return config;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-wired-'));
  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
  const login = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: { login: 'admin', password: 'nur-fuer-tests-0815' },
  });
  auth = { authorization: `Bearer ${login.json().accessToken}`, 'content-type': 'application/json' };
});

afterAll(async () => {
  await server.close();
  await driver.shutdown();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe('Einstellungen im ganzen Core', () => {
  it('meldet den Bereich "settings" und die dazugehoerigen Rechte', async () => {
    await add('w-1', 39700);
    const about = (await api('GET', '/api/v1/about')).json();
    expect(about.features).toContain('settings');
    const list = (await api('GET', '/api/v1/servers')).json();
    const entry = list.servers.find((s: { id: string }) => s.id === 'w-1');
    for (const wanted of ['settings.rename', 'startup.read', 'startup.update', 'allocation.read', 'allocation.assign']) {
      expect(entry.permissions, wanted).toContain(wanted);
    }
  });

  it('zeigt Umbenennen, Tags, Favorit und Grenzen in Liste und Detail', async () => {
    await add('w-2', 39710);
    expect((await api('PATCH', '/api/v1/servers/w-2', { name: 'Neuer Name', tags: ['pvp'], isFavorite: true })).statusCode).toBe(200);
    expect(
      (await api('PATCH', '/api/v1/servers/w-2/resources', { ramMb: 6144, cpuPercent: 300, diskMb: 20480, bandwidthDownloadKbps: 4096 })).statusCode,
    ).toBe(200);

    const list = (await api('GET', '/api/v1/servers')).json().servers.find((s: { id: string }) => s.id === 'w-2');
    expect(list).toMatchObject({ name: 'Neuer Name', tags: ['pvp'], isFavorite: true, ramMb: 6144, cpuPercent: 300, diskMb: 20480 });

    const detail = (await api('GET', '/api/v1/servers/w-2')).json().server;
    expect(detail.limits).toMatchObject({ ramMb: 6144, cpuPercent: 300, diskMb: 20480, bandwidthDownloadKbps: 4096, bandwidthUploadKbps: null });
    expect(detail).toMatchObject({ name: 'Neuer Name', tags: ['pvp'], isFavorite: true, autoRestart: false, autoSleepMinutes: 0 });
    // Die Spiel-Einstellungen stehen im Detail (der RCON-Kasten liest sie)
    expect(detail.variables).toMatchObject({ TYPE: 'PAPER', EULA: 'TRUE' });
  });

  it('loescht einen Server samt Ordner und meldet ihn beim Treiber ab', async () => {
    const c = await add('w-3', 39720);
    expect((await driver.listServers()).some((s) => s.id === 'w-3')).toBe(true);

    const res = await api('DELETE', '/api/v1/servers/w-3');
    expect(res.statusCode).toBe(200);
    expect((await driver.listServers()).some((s) => s.id === 'w-3')).toBe(false);
    expect((await api('GET', '/api/v1/servers')).json().servers.some((s: { id: string }) => s.id === 'w-3')).toBe(false);
    await expect(fs.access(c.workingDir)).rejects.toThrow();
    expect((await api('GET', '/api/v1/servers/w-3')).statusCode).toBe(404);

    // Der Name ist danach frei fuer einen neuen Server
    await add('w-3', 39720);
    expect((await api('GET', '/api/v1/servers/w-3')).statusCode).toBe(200);
  });

  it('gibt dem Treiber beim Start die neuen Ports und den neuen Speicher', async () => {
    await add('w-4', 39730);
    expect((await api('POST', '/api/v1/servers/w-4/allocations', { port: 39731, ref: 'karte' })).statusCode).toBe(201);
    expect((await api('PATCH', '/api/v1/servers/w-4/allocations/39730', { newPort: 39735 })).statusCode).toBe(200);
    expect((await api('PATCH', '/api/v1/servers/w-4/resources', { ramMb: 8192 })).statusCode).toBe(200);

    const spy = vi.spyOn(driver, 'updateServer');
    expect((await api('POST', '/api/v1/servers/w-4/power', { action: 'start' })).statusCode).toBe(200);
    const last = spy.mock.calls.at(-1)![0];
    expect(last.id).toBe('w-4');
    expect(last.ports.map((p) => p.hostPort)).toEqual([39735, 39731]);
    expect(last.maxMemoryMb).toBe(8192);
    expect(last.args).toContain('-Xmx6963M');
    spy.mockRestore();
  });

  it('schreibt die geaenderten Ports vor dem Start in die server.properties', async () => {
    const c = await add('w-5', 39740);
    await api('PATCH', '/api/v1/servers/w-5/allocations/39740', { newPort: 39745 });
    await api('POST', '/api/v1/servers/w-5/power', { action: 'start' });
    const properties = await fs.readFile(path.join(c.workingDir, 'server.properties'), 'utf8');
    expect(properties).toContain('server-port=39745');
  });

  it('verlangt eine Anmeldung und eine eigene Herkunft', async () => {
    await add('w-6', 39750);
    const none = { 'content-type': 'application/json' };
    expect((await api('PATCH', '/api/v1/servers/w-6', { name: 'x' }, none)).statusCode).toBe(401);
    expect((await api('DELETE', '/api/v1/servers/w-6', undefined, none)).statusCode).toBe(401);
    expect((await api('GET', '/api/v1/servers/w-6/startup', undefined, none)).statusCode).toBe(401);
    expect((await api('POST', '/api/v1/servers/w-6/reallocate', undefined, none)).statusCode).toBe(401);

    const foreign = { ...auth, origin: 'https://boese.example' };
    expect((await api('DELETE', '/api/v1/servers/w-6', undefined, foreign)).statusCode).toBe(403);
    expect((await api('PATCH', '/api/v1/servers/w-6/resources', { ramMb: 1024 }, foreign)).statusCode).toBe(403);
    expect(registry.get('w-6')).toBeDefined();
    expect(registry.get('w-6')!.maxMemoryMb).toBe(4096);
  });

  it('haelt Aenderungen im Protokoll fest', async () => {
    await add('w-7', 39760);
    await api('PATCH', '/api/v1/servers/w-7', { name: 'Anders' });
    await api('PATCH', '/api/v1/servers/w-7/resources', { ramMb: 5120 });
    await api('POST', '/api/v1/servers/w-7/allocations', { ref: 'extra' });
    const actions = registry.recentAudit({ serverId: 'w-7' }).map((e) => e.action);
    for (const expected of ['server.update', 'server.resources_update', 'server.port_add']) expect(actions, expected).toContain(expected);
  });
});
