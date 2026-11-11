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
let driver: InstanceType<typeof MockDriver>;
let dataDir: string;
let auth: Record<string, string>;
const json = { 'content-type': 'application/json' };
const get = (url: string, headers = auth) => server.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-admin-'));
  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
  for (const id of ['ad-1', 'ad-2']) {
    const config = { id, name: `Server ${id}`, game: 'x', executable: 'x', args: [], workingDir: dataDir, ports: [] };
    await registry.add(config);
    await driver.registerServer(config);
  }
  registry.audit('server.start', 'ad-1', 'standalone');
  registry.audit('server.stop', 'ad-1', 'standalone');
  registry.audit('backup.create', 'ad-2', 'core', { name: 'Test', bytes: 10 });
  registry.audit('file.edit', 'ad-2', 'standalone', { path: 'a_b%c.txt' });
  registry.audit('server.delete', 'weg-1', 'standalone', { name: 'Gelöscht' });
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Admin-Übersicht', () => {
  it('liefert Version, Laufzeit und Zahlen im Format des Panels', async () => {
    const res = await get('/api/v1/admin/overview');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: expect.any(String),
      uptimeSeconds: expect.any(Number),
      stats: { users: 1, serversTotal: 2, serversRunning: 0, containersTotal: 0, containersRunning: 0, auditToday: expect.any(Number) },
    });
    expect(res.json().stats.auditToday).toBeGreaterThanOrEqual(5);
  });

  it('zählt laufende Server', async () => {
    const entry = (driver as any).instances.get('ad-1');
    for (const t of entry.timers) clearTimeout(t);
    entry.state.status = 'running';
    expect((await get('/api/v1/admin/overview')).json().stats.serversRunning).toBe(1);
    entry.state.status = 'offline';
  });

  it('Funktionsliste meldet admin und audit; ohne Anmeldung 401', async () => {
    expect((await get('/api/v1/about')).json().features).toEqual(expect.arrayContaining(['admin', 'audit']));
    expect((await get('/api/v1/admin/overview', {})).statusCode).toBe(401);
    expect((await get('/api/v1/admin/audit', {})).statusCode).toBe(401);
  });
});

describe('Audit-Log', () => {
  it('neueste zuerst, im Format des Panels; Aktionen mit Namen der Oberfläche', async () => {
    const res = (await get('/api/v1/admin/audit?limit=100')).json();
    const actions = res.entries.map((e: any) => e.action);
    expect(actions[0]).toBe('server.delete');
    expect(actions).toContain('server.power.start'); // im Core "server.start"
    expect(actions).toContain('server.power.stop');
    const backup = res.entries.find((e: any) => e.action === 'backup.create');
    expect(backup).toMatchObject({ actor_name: 'NexusCore', server_id: 'ad-2', server_name: 'Server ad-2', metadata: { name: 'Test', bytes: 10 }, ip: null, user_id: null });
    expect(typeof backup.id).toBe('number');
    expect(new Date(backup.created_at).getTime()).not.toBeNaN();
    expect(res.stats).toMatchObject({ totalAll: expect.any(Number), totalToday: expect.any(Number), uniqueActorsToday: expect.any(Number), uniqueServersToday: expect.any(Number) });
    expect(res.stats.totalAll).toBeGreaterThanOrEqual(5);
  });

  it('Name eines gelöschten Servers kommt aus dem Eintrag', async () => {
    const res = (await get('/api/v1/admin/audit')).json();
    expect(res.entries.find((e: any) => e.action === 'server.delete')).toMatchObject({ server_id: 'weg-1', server_name: 'Gelöscht' });
  });

  it('Filter nach Aktions-Präfix und Server', async () => {
    const files = (await get('/api/v1/admin/audit?action=file.')).json().entries;
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((e: any) => e.action.startsWith('file.'))).toBe(true);
    const ad1 = (await get('/api/v1/admin/audit?serverId=ad-1')).json().entries;
    expect(ad1.every((e: any) => e.server_id === 'ad-1')).toBe(true);
  });

  it('Suche findet Text in Aktion, Akteur und Details; % und _ sind keine Platzhalter', async () => {
    const byDetail = (await get('/api/v1/admin/audit?search=Gel%C3%B6scht')).json().entries;
    expect(byDetail.map((e: any) => e.action)).toContain('server.delete');
    const byActor = (await get('/api/v1/admin/audit?search=core')).json().entries;
    expect(byActor.some((e: any) => e.action === 'backup.create')).toBe(true);
    const literal = (await get('/api/v1/admin/audit?search=' + encodeURIComponent('b%c'))).json().entries;
    expect(literal.map((e: any) => e.action)).toEqual(['file.edit']);
    const wildcard = (await get('/api/v1/admin/audit?search=' + encodeURIComponent('a_b'))).json().entries;
    expect(wildcard.map((e: any) => e.action)).toEqual(['file.edit']);
    expect((await get('/api/v1/admin/audit?search=' + encodeURIComponent('%'))).json().entries.map((e: any) => e.action)).toEqual(['file.edit']);
  });

  it('Seiten: limit und before', async () => {
    const first = (await get('/api/v1/admin/audit?limit=2')).json();
    expect(first.entries).toHaveLength(2);
    expect(first.nextBefore).toBe(first.entries[1].id);
    const second = (await get(`/api/v1/admin/audit?limit=2&before=${first.nextBefore}`)).json();
    expect(second.entries[0].id).toBeLessThan(first.entries[1].id);
    const all = (await get('/api/v1/admin/audit?limit=2000')).json();
    expect(all.nextBefore).toBeNull();
  });

  it('ungültige Angaben ergeben 400', async () => {
    expect((await get('/api/v1/admin/audit?limit=0')).statusCode).toBe(400);
    expect((await get('/api/v1/admin/audit?limit=99999')).statusCode).toBe(400);
    expect((await get('/api/v1/admin/audit?before=abc')).statusCode).toBe(400);
  });

  it('liefert das Core-Protokoll als Host-Log, ohne Zugangsdaten', async () => {
    const { logger } = await import('../src/logger.js');
    logger.warn({ token: 'geheim-abc' }, 'Host-Log-Probe');
    const res = await get('/api/v1/admin/host-logs?lines=50&search=Host-Log-Probe');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.container).toBe('nexuscore');
    expect(body.logs.length).toBeGreaterThan(0);
    expect(body.logs[0].level).toBe('warn');
    expect(JSON.stringify(body)).not.toContain('geheim-abc');
    expect((await get('/api/v1/admin/host-logs?lines=5')).statusCode).toBe(400);
    expect((await get('/api/v1/admin/host-logs', {})).statusCode).toBe(401);
  });
});
