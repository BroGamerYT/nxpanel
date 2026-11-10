import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');

const TOKEN = 'test-token-0123456789abcdefghij';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let server: Awaited<ReturnType<typeof createCoreServer>>;
let driver: InstanceType<typeof MockDriver>;
let bus: InstanceType<typeof EventBus>;
let registry: InstanceType<typeof ServerRegistry>;
let dataDir: string;

const serverConfig = {
  id: 'r-1',
  name: 'Route Test',
  game: 'test',
  executable: 'x.exe',
  args: [],
  workingDir: '.',
  ports: [],
};

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-routes-'));
  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  bus = new EventBus();
  server = await createCoreServer(driver, bus, registry);
  await server.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await server.close();
  await driver.shutdown();
});

describe('HTTP-Routen', () => {
  it('/core/v1/info ist oeffentlich', async () => {
    const res = await server.inject({ method: 'GET', url: '/core/v1/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.host.platform).toBe(process.platform);
    expect(body.core.tokenFingerprint).not.toContain(TOKEN);
  });

  it('geschuetzte Routen verlangen einen Token', async () => {
    const res = await server.inject({ method: 'GET', url: '/core/v1/servers' });
    expect(res.statusCode).toBe(401);
  });

  it('lehnt einen falschen Token ab', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/core/v1/servers',
      headers: { authorization: 'Bearer falscher-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('registriert einen Server und lehnt Duplikate ab', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/core/v1/servers',
      headers: AUTH,
      payload: serverConfig,
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await server.inject({
      method: 'POST',
      url: '/core/v1/servers',
      headers: AUTH,
      payload: serverConfig,
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('schreibt die Registrierung in die Registry', async () => {
    await server.inject({
      method: 'POST',
      url: '/core/v1/servers',
      headers: AUTH,
      payload: { ...serverConfig, id: 'r-persist' },
    });

    expect(registry.get('r-persist')?.name).toBe('Route Test');

    // Die Registry muss den Neustart ueberleben.
    const reloaded = await ServerRegistry.open(dataDir);
    expect(reloaded.get('r-persist')).toBeDefined();
  });

  it('weist ungueltige Konfigurationen ab', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers',
      headers: AUTH,
      payload: { id: 'mit leerzeichen', name: '', game: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('liefert die Serverliste', async () => {
    const res = await server.inject({ method: 'GET', url: '/core/v1/servers', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().servers as { id: string }[]).map((s) => s.id);
    expect(ids).toContain('r-1');
  });

  it('startet, liefert Stats und stoppt wieder', async () => {
    const start = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/r-1/start',
      headers: AUTH,
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().status).toBe('starting');

    const stats = await server.inject({
      method: 'GET',
      url: '/core/v1/servers/r-1/stats',
      headers: AUTH,
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().stats.serverId).toBe('r-1');

    const stop = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/r-1/stop',
      headers: AUTH,
    });
    expect(stop.statusCode).toBe(200);
  });

  it('antwortet bei unbekannten Instanzen mit 404', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/gibtsnicht/start',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
  });

  it('akzeptiert POST ohne Body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/r-1/kill',
      headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
  });

  it('liefert den Log-Ringpuffer', async () => {
    bus.emit({
      type: 'console',
      serverId: 'r-1',
      line: 'Testzeile',
      stream: 'stdout',
      ts: new Date().toISOString(),
    });

    const res = await server.inject({
      method: 'GET',
      url: '/core/v1/servers/r-1/logs',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines[0].line).toBe('Testzeile');
  });

  it('/core/v1/pair lehnt eine falsche PIN ab', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/pair',
      payload: { pin: 'ZZZ-ZZZ' },
    });
    expect(res.statusCode).toBe(400);
  });
});
