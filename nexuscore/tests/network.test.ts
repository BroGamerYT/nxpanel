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
const { allocatePort } = await import('../src/protocol/ports.js');

let server: Awaited<ReturnType<typeof createCoreServer>>;
let registry: InstanceType<typeof ServerRegistry>;
let dataDir: string;
let auth: Record<string, string>;
const json = { 'content-type': 'application/json' };
const get = (url: string, headers = auth) => server.inject({ method: 'GET', url, headers });
const patch = (payload: unknown) => server.inject({ method: 'PATCH', url: '/api/v1/admin/nodes/local', headers: { ...auth, ...json }, payload: payload as object });

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-net-'));
  registry = await ServerRegistry.open(dataDir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
  const config = { id: 'net-server-1', name: 'Netz-Server', game: 'x', executable: 'x', args: [], workingDir: dataDir, ports: [{ name: 'game', hostPort: 25565, protocol: 'tcp' as const }] };
  await registry.add(config);
  await driver.registerServer(config);
});

afterAll(async () => {
  await server.close();
  registry.close?.();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Netzwerk', () => {
  it('verlangt eine Anmeldung', async () => {
    expect((await get('/api/v1/admin/nodes', {})).statusCode).toBe(401);
    expect((await get('/api/v1/admin/allocations', {})).statusCode).toBe(401);
  });

  it('zeigt den lokalen Host mit Standard-Bereich', async () => {
    const res = await get('/api/v1/admin/nodes');
    expect(res.statusCode).toBe(200);
    const node = res.json().nodes[0];
    expect(node.id).toBe('local');
    expect(node.publicHost).toBeNull();
    expect(node.portFrom).toBeLessThanOrEqual(node.portTo);
    expect(node.servers).toBe(1);
  });

  it('speichert Adresse und Bereich und nennt Server außerhalb', async () => {
    const res = await patch({ publicHost: 'mc.example.de', portFrom: 28000, portTo: 28099 });
    expect(res.statusCode).toBe(200);
    expect(res.json().outside).toEqual([{ name: 'Netz-Server', port: 25565 }]);
    const node = (await get('/api/v1/admin/nodes')).json().nodes[0];
    expect(node).toMatchObject({ publicHost: 'mc.example.de', portFrom: 28000, portTo: 28099 });
    // wirkt auf die Server-Liste
    const list = (await get('/api/v1/servers')).json().servers;
    expect(list[0].publicHost).toBe('mc.example.de');
    // und auf die Port-Vergabe
    const port = await allocatePort(registry.list(), async () => true, { from: node.portFrom, to: node.portTo });
    expect(port).toBe(28000);
  });

  it('zeigt vergebene Ports mit Hinweis auf den Bereich', async () => {
    const rows = (await get('/api/v1/admin/allocations')).json().allocations;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ port: 25565, ref: 'game', primary: true, inRange: false });
    expect(rows[0].server).toMatchObject({ name: 'Netz-Server', shortId: 'net-serv' });
  });

  it('lehnt ungültige Eingaben ab', async () => {
    expect((await patch({ publicHost: 'http://evil.example/x' })).statusCode).toBe(400);
    expect((await patch({ publicHost: 'a b' })).statusCode).toBe(400);
    expect((await patch({ publicHost: 'host:25565' })).statusCode).toBe(400);
    expect((await patch({ portFrom: 28000 })).statusCode).toBe(400);
    expect((await patch({ portFrom: 29000, portTo: 28000 })).statusCode).toBe(400);
    expect((await patch({ portFrom: 80, portTo: 90 })).statusCode).toBe(400);
    expect((await patch({ portFrom: 28000, portTo: null })).statusCode).toBe(400);
    expect((await server.inject({ method: 'PATCH', url: '/api/v1/admin/nodes/anderer', headers: { ...auth, ...json }, payload: {} })).statusCode).toBe(404);
  });

  it('setzt Adresse und Bereich zurück', async () => {
    expect((await patch({ publicHost: null, portFrom: null, portTo: null })).statusCode).toBe(200);
    const node = (await get('/api/v1/admin/nodes')).json().nodes[0];
    expect(node.publicHost).toBeNull();
    expect(node.portFrom).not.toBe(28000);
  });
});
