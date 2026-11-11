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

let server: Awaited<ReturnType<typeof createCoreServer>>;
let registry: InstanceType<typeof ServerRegistry>;
let dataDir: string;
let auth: Record<string, string>;
const json = { 'content-type': 'application/json' };
const get = (url: string, headers = auth) => server.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-hosts-'));
  registry = await ServerRegistry.open(dataDir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
  const config = { id: 'h-1', name: 'Host-Server', game: 'minecraft-paper', executable: 'x', args: [], workingDir: dataDir, ports: [] };
  await registry.add(config);
  await driver.registerServer(config);
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Hosts', () => {
  it('verlangt eine Anmeldung', async () => {
    expect((await get('/api/v1/admin/hosts', {})).statusCode).toBe(401);
    expect((await get('/api/v1/admin/hosts/local/servers', {})).statusCode).toBe(401);
  });

  it('zeigt diesen Rechner als einzigen Host', async () => {
    const hosts = (await get('/api/v1/admin/hosts')).json().hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ id: 'local', type: 'local', status: 'online', servers: 1, runtime: 'mock' });
    expect(hosts[0].ramTotalMb).toBeGreaterThan(0);
    expect(hosts[0].cpuPercent).toBeGreaterThanOrEqual(0);
    // kein Zugang zu fremden Hosts, keine Zugangsdaten
    expect(JSON.stringify(hosts)).not.toContain('token');
  });

  it('fragt den Status ab und nennt die Server', async () => {
    const check = await server.inject({ method: 'POST', url: '/api/v1/admin/hosts/local/check', headers: auth });
    expect(check.statusCode).toBe(200);
    expect(check.json().host.id).toBe('local');
    const servers = (await get('/api/v1/admin/hosts/local/servers')).json().servers;
    expect(servers).toEqual([expect.objectContaining({ id: 'h-1', name: 'Host-Server' })]);
  });

  it('kennt keine anderen Hosts', async () => {
    expect((await server.inject({ method: 'POST', url: '/api/v1/admin/hosts/anderer/check', headers: auth })).statusCode).toBe(404);
    expect((await get('/api/v1/admin/hosts/anderer/servers')).statusCode).toBe(404);
  });
});
