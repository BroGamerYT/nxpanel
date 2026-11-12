import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { normalizeAddress, fingerprintOf } = await import('../src/hosts/remote.js');
const { tokenFingerprint } = await import('../src/protocol/security.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', ...json };
const PW = 'ein-sicheres-passwort-1';

// ------------------------------------------------------------------ ein "anderer Core"

let remoteToken = 'remote-token-0123456789abcdef-gross';
const remote = {
  app: null as FastifyInstance | null,
  port: 0,
  claimsOwnFingerprint: false,
  servers: [{ id: 'mc-1', name: 'Mein Minecraft', eggName: 'minecraft-paper', status: 'offline' }] as Array<{ id: string; name: string; eggName: string; status: string }>,
  seen: [] as string[],
  created: [] as unknown[],
};
async function startRemote(port = 0): Promise<void> {
  const app = Fastify({ logger: false });
  const authed = (req: { headers: { authorization?: string } }): boolean => req.headers.authorization === `Bearer ${remoteToken}`;
  app.get('/core/v1/info', async () => ({
    host: { name: 'REMOTE-PC', runtime: 'docker', platform: 'linux' },
    metrics: { cpuUsagePercent: 12.345, totalMemoryMb: 16000, usedMemoryMb: 4000, diskTotalGb: 500, diskFreeGb: 300 },
    core: { tokenFingerprint: remote.claimsOwnFingerprint ? tokenFingerprint() : fingerprintOf(remoteToken) },
  }));
  app.post('/core/v1/pair', async (req, reply) => ((req.body as { pin?: string })?.pin === '123456' ? { core: { tokenFingerprint: fingerprintOf(remoteToken) } } : reply.status(400).send({ message: 'Ungueltige PIN.' })));
  app.get('/core/v1/servers', async (req, reply) => (authed(req) ? { servers: remote.servers.map((s) => ({ id: s.id, status: s.status })) } : reply.status(401).send({ error: 'Nicht angemeldet' })));
  app.get('/api/v1/servers', async (req, reply) => (authed(req) ? { servers: remote.servers } : reply.status(401).send({ error: 'Nicht angemeldet' })));
  app.post('/api/v1/servers', async (req, reply) => {
    if (!authed(req)) return reply.status(401).send({ error: 'Nicht angemeldet' });
    remote.created.push(req.body);
    const name = (req.body as { name: string }).name;
    remote.servers.push({ id: name.toLowerCase().replace(/\W+/g, '-'), name, eggName: 'x', status: 'installing' });
    return reply.status(201).send({ server: { id: name.toLowerCase().replace(/\W+/g, '-') }, taskId: 'task-1' });
  });
  app.post<{ Params: { id: string; action: string } }>('/core/v1/servers/:id/:action', async (req, reply) => {
    if (!authed(req)) return reply.status(401).send({ error: 'Nicht angemeldet' });
    const s = remote.servers.find((x) => x.id === req.params.id);
    if (!s) return reply.status(404).send({ message: 'Server nicht gefunden' });
    remote.seen.push(`${req.params.id}:${req.params.action}`);
    s.status = req.params.action === 'start' ? 'running' : 'offline';
    return { status: s.status };
  });
  await app.listen({ port, host: '127.0.0.1' });
  remote.app = app;
  remote.port = (app.server.address() as { port: number }).port;
}
const stopRemote = async (): Promise<void> => {
  await remote.app?.close();
  remote.app = null;
};
const url = (): string => `http://127.0.0.1:${remote.port}`;

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', u: string, headers: Headers = MASTER, payload?: unknown) =>
  server.inject({
    method,
    url: u,
    headers: payload === undefined ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type')) : headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

beforeAll(async () => {
  await startRemote();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-hostsremote-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
});
afterAll(async () => {
  await stopRemote();
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Adresse', () => {
  it('nur Rechner und Port, nur http(s), ohne Zugangsdaten', () => {
    expect(normalizeAddress('http://192.168.1.5:8443/')).toBe('http://192.168.1.5:8443');
    expect(normalizeAddress(' https://core.example.org ')).toBe('https://core.example.org');
    for (const bad of ['ftp://x.example.org', 'http://u:p@x.example.org', 'http://x.example.org/pfad', 'http://x.example.org?a=1', 'kein url']) expect(() => normalizeAddress(bad), bad).toThrow();
  });
});

describe('Koppeln', () => {
  it('ohne Kopplung gibt es nur diesen Rechner', async () => {
    const hosts = (await call('GET', '/api/v1/admin/hosts')).json().hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0].type).toBe('local');
  });

  it('abgelehnt: falsches Token, falsche PIN, Token passt nicht zur PIN, ungültige Adresse, niemand zu Hause, dieser Core selbst', async () => {
    const body = { name: 'Zweiter', address: url(), token: 'falsches-token-0123456789' };
    const wrong = await call('POST', '/api/v1/admin/hosts', MASTER, body);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().message).toContain('lehnt das Token ab');
    expect(wrong.body).not.toContain('falsches-token');
    expect((await call('POST', '/api/v1/admin/hosts', MASTER, { ...body, token: remoteToken, pin: '000000' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/admin/hosts', MASTER, { ...body, token: 'anderes-token-0123456789', pin: '123456' })).json().code).toBe('token_mismatch');
    expect((await call('POST', '/api/v1/admin/hosts', MASTER, { ...body, token: remoteToken, address: 'ftp://x.example.org' })).statusCode).toBe(400);
    const dead = await call('POST', '/api/v1/admin/hosts', MASTER, { ...body, token: remoteToken, address: 'http://127.0.0.1:1' });
    expect(dead.statusCode).toBe(502);
    remote.claimsOwnFingerprint = true;
    expect((await call('POST', '/api/v1/admin/hosts', MASTER, { ...body, token: remoteToken })).json().code).toBe('self');
    remote.claimsOwnFingerprint = false;
    expect((await call('GET', '/api/v1/admin/hosts')).json().hosts).toHaveLength(1);
  });

  it('koppelt (mit PIN): Name, Laufzeit und Auslastung kommen vom anderen Core; das Token steht nirgends im Klartext', async () => {
    const res = await call('POST', '/api/v1/admin/hosts', MASTER, { name: 'Zweiter', address: `${url()}/`, token: remoteToken, pin: '123456' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().host).toMatchObject({ type: 'core', name: 'Zweiter', address: url(), runtime: 'docker', status: 'online', ramTotalMb: 16000, ramUsedMb: 4000, diskTotalMb: 512000, diskUsedMb: 204800, cpuPercent: 12.35 });
    expect(res.body).not.toContain(remoteToken);
    expect((await call('GET', '/api/v1/admin/hosts')).body).not.toContain(remoteToken);
    expect(JSON.stringify(registry.getSetting('hosts.list'))).not.toContain(remoteToken);
    expect(JSON.stringify(registry.getSetting(`secret.host.${res.json().host.id}.token`))).not.toContain(remoteToken);
    expect(JSON.stringify((await call('GET', '/api/v1/admin/audit?limit=100')).json())).not.toContain(remoteToken);
    expect((await call('GET', '/api/v1/admin/hosts')).json().hosts).toHaveLength(2);
  });

  it('doppelt: gleicher Name oder gleiche Adresse', async () => {
    expect((await call('POST', '/api/v1/admin/hosts', MASTER, { name: 'zweiter', address: 'http://127.0.0.1:2', token: remoteToken })).statusCode).toBe(409);
    expect((await call('POST', '/api/v1/admin/hosts', MASTER, { name: 'Anderer', address: url(), token: remoteToken })).statusCode).toBe(409);
  });

  it('nur Administratoren', async () => {
    await call('POST', '/api/v1/admin/users', MASTER, { username: 'hr-user', password: PW });
    const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'hr-user', password: PW } });
    const user = { authorization: `Bearer ${login.json().accessToken}`, ...json };
    expect((await call('POST', '/api/v1/admin/hosts', user, { name: 'X', address: url(), token: remoteToken })).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/admin/hosts', user)).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/admin/hosts', {})).statusCode).toBe(401);
  });
});

describe('Auf dem gekoppelten Core', () => {
  let id = '';
  beforeAll(async () => {
    id = (await call('GET', '/api/v1/admin/hosts')).json().hosts.find((h: { type: string }) => h.type === 'core').id;
  });

  it('zeigt dessen Server', async () => {
    const res = (await call('GET', `/api/v1/admin/hosts/${id}/servers`)).json();
    expect(res.servers).toEqual([{ id: 'mc-1', name: 'Mein Minecraft', game: 'minecraft-paper', status: 'offline' }]);
    expect((await call('GET', '/api/v1/admin/hosts')).json().hosts.find((h: { id: string }) => h.id === id).servers).toBe(1);
  });

  it('startet, stoppt und beendet dort einen Server - mit dem Token des anderen Cores', async () => {
    expect((await call('POST', `/api/v1/admin/hosts/${id}/servers/mc-1/power`, MASTER, { action: 'start' })).json()).toEqual({ ok: true });
    expect((await call('GET', `/api/v1/admin/hosts/${id}/servers`)).json().servers[0].status).toBe('running');
    await call('POST', `/api/v1/admin/hosts/${id}/servers/mc-1/power`, MASTER, { action: 'stop' });
    await call('POST', `/api/v1/admin/hosts/${id}/servers/mc-1/power`, MASTER, { action: 'kill' });
    expect(remote.seen).toEqual(['mc-1:start', 'mc-1:stop', 'mc-1:kill']);
    expect((await call('POST', `/api/v1/admin/hosts/${id}/servers/gibtsnicht/power`, MASTER, { action: 'start' })).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/admin/hosts/${id}/servers/mc-1/power`, MASTER, { action: 'delete' })).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/admin/audit?limit=100')).body).toContain('host.server_power');
  });

  it('legt dort einen Server aus einem Spiel an', async () => {
    const res = await call('POST', `/api/v1/admin/hosts/${id}/servers`, MASTER, { name: 'Neuer Server', eggId: 'minecraft-paper', ramMb: 4096 });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, server: { id: 'neuer-server' }, taskId: 'task-1' });
    expect(remote.created).toEqual([{ name: 'Neuer Server', eggId: 'minecraft-paper', ramMb: 4096 }]);
    expect((await call('POST', `/api/v1/admin/hosts/${id}/servers`, MASTER, { name: '', eggId: 'x' })).statusCode).toBe(400);
  });

  it('der eigene Rechner und unbekannte Hosts gehen hier nicht', async () => {
    expect((await call('POST', '/api/v1/admin/hosts/local/servers/x/power', MASTER, { action: 'start' })).json().code).toBe('local_host');
    expect((await call('POST', '/api/v1/admin/hosts/local/servers', MASTER, { name: 'X', eggId: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/admin/hosts/gibtsnicht/servers/x/power', MASTER, { action: 'start' })).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/admin/hosts/gibtsnicht/servers')).statusCode).toBe(404);
  });

  it('Status: nicht erreichbar, wenn der andere Core aus ist - und wieder online, wenn er zurück ist', async () => {
    expect((await call('POST', `/api/v1/admin/hosts/${id}/check`)).json().host.status).toBe('online');
    const port = remote.port;
    await stopRemote();
    const down = await call('POST', `/api/v1/admin/hosts/${id}/check`);
    expect(down.json().host.status).toBe('unreachable');
    expect((await call('GET', '/api/v1/admin/hosts')).json().hosts).toHaveLength(2); // bleibt in der Liste
    expect((await call('POST', `/api/v1/admin/hosts/${id}/servers/mc-1/power`, MASTER, { action: 'start' })).statusCode).toBe(502);
    await startRemote(port);
    expect((await call('POST', `/api/v1/admin/hosts/${id}/check`)).json().host.status).toBe('online');
  });

  it('hat der andere Core sein Token gewechselt, ist er nicht mehr "online"; Token neu eintragen hilft', async () => {
    const old = remoteToken;
    remoteToken = 'neues-token-0123456789abcdef-gross';
    expect((await call('POST', `/api/v1/admin/hosts/${id}/check`)).json().host.status).toBe('unreachable');
    expect((await call('PATCH', `/api/v1/admin/hosts/${id}`, MASTER, { token: old })).statusCode).toBe(400);
    const fixed = await call('PATCH', `/api/v1/admin/hosts/${id}`, MASTER, { token: remoteToken });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(fixed.body).not.toContain(remoteToken);
    expect(fixed.json().host.status).toBe('online');
  });

  it('ändern: Name; eine Adresse, die nicht antwortet, wird nicht gespeichert', async () => {
    expect((await call('PATCH', `/api/v1/admin/hosts/${id}`, MASTER, { name: 'Umbenannt' })).json().host.name).toBe('Umbenannt');
    expect((await call('PATCH', `/api/v1/admin/hosts/${id}`, MASTER, { address: 'http://127.0.0.1:1' })).statusCode).toBe(502);
    expect((await call('GET', '/api/v1/admin/hosts')).json().hosts.find((h: { id: string }) => h.id === id).address).toBe(url());
    expect((await call('PATCH', '/api/v1/admin/hosts/local', MASTER, { name: 'X' })).statusCode).toBe(400);
  });

  it('entkoppeln: Eintrag und Token sind weg; der lokale Host bleibt', async () => {
    expect((await call('DELETE', '/api/v1/admin/hosts/local')).statusCode).toBe(400);
    expect((await call('DELETE', `/api/v1/admin/hosts/${id}`)).json()).toEqual({ ok: true });
    expect(registry.getSetting(`secret.host.${id}.token`)).toBeUndefined();
    expect((await call('GET', '/api/v1/admin/hosts')).json().hosts).toHaveLength(1);
    expect((await call('DELETE', `/api/v1/admin/hosts/${id}`)).statusCode).toBe(404);
    expect(JSON.stringify((await call('GET', '/api/v1/admin/audit?limit=100')).json())).toContain('host.delete');
  });
});
