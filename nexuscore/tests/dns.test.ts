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
const { getGameSrvMeta } = await import('../src/network/dns.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', ...json };
const PW = 'ein-sicheres-passwort-1';
const TOKEN = 'cf-token-geheim-0123456789abcdef';

// ------------------------------------------------------------------ ein Cloudflare zum Anfassen

interface CfRec { id: string; type: string; name: string; content?: string; data?: { port?: number; target?: string } }
const cf = { zones: { 'example.org': 'zone-1' } as Record<string, string>, records: [] as CfRec[], calls: [] as string[], failWrites: false, seq: 0, seenAuth: [] as string[] };
let ip = '203.0.113.7';

const fakeFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const u = new URL(url);
  const method = init.method ?? 'GET';
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'api.cloudflare.com') {
    cf.seenAuth.push(String((init.headers as Record<string, string>)?.Authorization));
    cf.calls.push(`${method} ${u.pathname.replace('/client/v4', '')}`);
    if ((init.headers as Record<string, string>).Authorization !== `Bearer ${TOKEN}`) return reply(403, { success: false, errors: [{ message: 'Invalid token' }] });
    const p = u.pathname.replace('/client/v4', '');
    if (method === 'GET' && p === '/zones') {
      const id = cf.zones[u.searchParams.get('name') ?? ''];
      return reply(200, { success: true, result: id ? [{ id }] : [] });
    }
    const zone = /^\/zones\/([^/]+)(\/dns_records(?:\/([^/]+))?)?$/.exec(p);
    if (!zone) return reply(404, { success: false, errors: [{ message: 'no route' }] });
    if (!Object.values(cf.zones).includes(zone[1]!)) return reply(404, { success: false, errors: [{ message: 'zone' }] });
    if (!zone[2]) return reply(200, { success: true, result: { id: zone[1] } });
    if (method === 'GET') return reply(200, { success: true, result: cf.records });
    if (cf.failWrites) return reply(400, { success: false, errors: [{ message: 'Record kaputt' }] });
    const body = JSON.parse(String(init.body)) as CfRec & { data?: { service: string; proto: string; name: string; port: number; target: string } };
    const name = body.type === 'SRV' ? `${body.data!.service}.${body.data!.proto}.${body.data!.name}.example.org` : body.name;
    if (method === 'POST') cf.records.push({ ...body, name, id: `r${++cf.seq}` });
    else if (method === 'PUT') cf.records = cf.records.map((r) => (r.id === zone[3] ? { ...body, name, id: r.id } : r));
    return reply(200, { success: true, result: {} });
  }
  if (u.hostname === 'www.duckdns.org') return new Response(u.searchParams.get('token') === TOKEN ? 'OK' : 'KO', { status: 200 });
  if (u.hostname === 'hook.example.org') return new Response('', { status: u.searchParams.get('ip') === ip ? 200 : 500 });
  return reply(500, {});
};

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
const ids: Record<string, string> = {};

type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Headers = MASTER, payload?: unknown) =>
  server.inject({
    method,
    url,
    headers: payload === undefined ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type')) : headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
async function login(name: string): Promise<Headers> {
  const res = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: name, password: PW } });
  return { authorization: `Bearer ${res.json().accessToken}`, ...json };
}
const addServer = async (id: string, game: string, port: number) => {
  const root = path.join(dir, 'servers', id);
  await fs.mkdir(root, { recursive: true });
  await registry.add({ id, name: `Server ${id}`, game, executable: 'x', args: [], workingDir: root, ports: [{ name: 'game', hostPort: port, protocol: 'tcp' }] });
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-dns-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false, dns: { fetch: fakeFetch, publicIp: async () => ip } });
  for (const name of ['dn-owner', 'dn-ohne']) ids[name] = (await call('POST', '/api/v1/admin/users', MASTER, { username: name, password: PW })).json().user.id as string;
  await addServer('dn-1', 'minecraft-paper', 25565);
  await addServer('dn-2', 'valheim', 2456);
  await call('PUT', `/api/v1/admin/users/${ids['dn-owner']}/servers/dn-1`, MASTER, { isOwner: true });
  await call('PUT', `/api/v1/admin/users/${ids['dn-ohne']}/servers/dn-1`, MASTER, { permissions: ['control.console'] });
});
afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('SRV-Dienst je Spiel', () => {
  it('kennt Minecraft, TeamSpeak und Terraria, sonst nichts', () => {
    expect(getGameSrvMeta('minecraft-paper')?.service).toBe('_minecraft');
    expect(getGameSrvMeta('Terraria')?.proto).toBe('_tcp');
    expect(getGameSrvMeta('TeamSpeak 3')?.proto).toBe('_udp');
    expect(getGameSrvMeta('valheim')).toBeNull();
  });
});

describe('Einstellungen', () => {
  it('starten leer; der Token wird verschlüsselt gespeichert und nie ausgegeben', async () => {
    expect((await call('GET', '/api/v1/admin/network/dns')).json().config).toMatchObject({ provider: 'none', hasToken: false, apiToken: null });
    const res = await call('PATCH', '/api/v1/admin/network/dns', MASTER, { provider: 'cloudflare', rootDomain: 'Example.org', apiToken: TOKEN, autoSync: true });
    expect(res.statusCode, res.body).toBe(200);
    const view = await call('GET', '/api/v1/admin/network/dns');
    expect(view.body).not.toContain(TOKEN);
    expect(view.json().config).toMatchObject({ provider: 'cloudflare', rootDomain: 'example.org', hasToken: true, autoSync: true });
    expect(JSON.stringify(registry.getSetting('dns.config'))).not.toContain(TOKEN);
    expect(JSON.stringify(registry.getSetting('secret.dns-token'))).not.toContain(TOKEN);
    expect(JSON.stringify((await call('GET', '/api/v1/admin/audit?limit=50')).json())).not.toContain(TOKEN);
  });

  it('lehnt eine ungültige Domain und Webhook-Adresse ab', async () => {
    expect((await call('PATCH', '/api/v1/admin/network/dns', MASTER, { rootDomain: 'kein domain' })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/v1/admin/network/dns', MASTER, { webhookUrl: 'ftp://x.example.org' })).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/admin/network/dns')).json().config.rootDomain).toBe('example.org');
  });

  it('nur wer das Netzwerk verwalten darf', async () => {
    const owner = await login('dn-owner');
    for (const [m, u] of [['GET', '/api/v1/admin/network/dns'], ['PATCH', '/api/v1/admin/network/dns'], ['POST', '/api/v1/admin/network/dns/sync'], ['POST', '/api/v1/admin/network/dns/test']] as const) {
      expect((await call(m, u, owner, m === 'GET' ? undefined : {})).statusCode, `${m} ${u}`).toBe(403);
    }
    expect((await call('GET', '/api/v1/admin/network/dns', {})).statusCode).toBe(401);
  });
});

describe('Test beim Anbieter', () => {
  it('Cloudflare: findet die Zone, meldet falschen Token und unbekannte Domain', async () => {
    const ok = (await call('POST', '/api/v1/admin/network/dns/test', MASTER, { provider: 'cloudflare', rootDomain: 'example.org' })).json();
    expect(ok).toMatchObject({ ok: true, zoneId: 'zone-1' });
    const bad = await call('POST', '/api/v1/admin/network/dns/test', MASTER, { provider: 'cloudflare', rootDomain: 'example.org', apiToken: 'falscher-token-1234567890' });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().message).toContain('Invalid token');
    expect(bad.body).not.toContain('falscher-token');
    const none = await call('POST', '/api/v1/admin/network/dns/test', MASTER, { provider: 'cloudflare', rootDomain: 'unbekannt.example.net' });
    expect(none.statusCode).toBe(404);
  });
  it('DuckDNS und Webhook: ehrlich, dass nur die Angaben geprüft sind', async () => {
    const r = (await call('POST', '/api/v1/admin/network/dns/test', MASTER, { provider: 'webhook', rootDomain: 'example.org' })).json();
    expect(r.message).toContain('formal');
  });
});

describe('Abgleich mit Cloudflare', () => {
  it('legt Haupt-A, Server-A und SRV an - und beim zweiten Mal nichts mehr', async () => {
    await call('PATCH', '/api/v1/servers/dn-1/domain', MASTER, { subdomain: 'survival' });
    await call('PATCH', '/api/v1/servers/dn-2/domain', MASTER, { subdomain: 'tal' });
    await new Promise((r) => setTimeout(r, 50));
    cf.records = [];
    cf.calls = [];
    const res = await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ip: '203.0.113.7' });
    const names = cf.records.map((r) => `${r.type} ${r.name}`).sort();
    expect(names).toEqual(['A example.org', 'A survival.example.org', 'A tal.example.org', 'SRV _minecraft._tcp.survival.example.org']);
    expect(cf.records.find((r) => r.type === 'SRV')!.data).toMatchObject({ port: 25565, target: 'survival.example.org' });
    expect(res.json().updated).toBe(4);

    cf.calls = [];
    expect((await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {})).json().updated).toBe(0);
    expect(cf.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
    expect((await call('GET', '/api/v1/admin/network/dns')).json().config).toMatchObject({ lastSyncStatus: 'OK', lastIp: '203.0.113.7' });
  });

  it('neue Adresse: A-Einträge werden aktualisiert; geänderter Port zieht den SRV-Eintrag nach', async () => {
    ip = '198.51.100.9';
    const reg = registry.list().find((c) => c.id === 'dn-1')!;
    await registry.update({ ...reg, ports: [{ ...reg.ports[0]!, hostPort: 25570 }] });
    const res = (await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {})).json();
    expect(res.updated).toBe(4); // 3 A-Einträge + 1 SRV
    expect(cf.records.filter((r) => r.type === 'A').every((r) => r.content === '198.51.100.9')).toBe(true);
    expect(cf.records.find((r) => r.type === 'SRV')!.data!.port).toBe(25570);
  });

  it('SRV aus: kein SRV-Eintrag; ein Fehler des Anbieters wird gemeldet und gemerkt', async () => {
    await call('PATCH', '/api/v1/servers/dn-1/domain', MASTER, { srvRecordEnabled: false });
    cf.failWrites = true;
    ip = '192.0.2.44';
    const res = await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('Record kaputt');
    expect((await call('GET', '/api/v1/admin/network/dns')).json().config.lastSyncStatus).toContain('Record kaputt');
    cf.failWrites = false;
    expect((await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {})).statusCode).toBe(200);
  });

  it('ohne Anbieter wird nichts getan', async () => {
    await call('PATCH', '/api/v1/admin/network/dns', MASTER, { provider: 'none' });
    cf.calls = [];
    expect((await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {})).json().message).toContain('deaktiviert');
    expect(cf.calls).toEqual([]);
  });
});

describe('DuckDNS und Webhook', () => {
  it('DuckDNS: meldet die Adresse; falscher Token wird erkannt', async () => {
    await call('PATCH', '/api/v1/admin/network/dns', MASTER, { provider: 'duckdns', rootDomain: 'meinhof.duckdns.org' });
    expect((await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {})).statusCode).toBe(200);
    await call('PATCH', '/api/v1/admin/network/dns', MASTER, { apiToken: 'anderer-token-1234567890' });
    const res = await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('DuckDNS');
    await call('PATCH', '/api/v1/admin/network/dns', MASTER, { apiToken: TOKEN });
  });
  it('Webhook: {ip} und {domain} werden eingesetzt', async () => {
    await call('PATCH', '/api/v1/admin/network/dns', MASTER, { provider: 'webhook', rootDomain: 'example.org', webhookUrl: 'https://hook.example.org/u?ip={ip}&d={domain}' });
    expect((await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {})).statusCode).toBe(200);
    await call('PATCH', '/api/v1/admin/network/dns', MASTER, { webhookUrl: 'https://hook.example.org/u?ip=falsch' });
    expect((await call('POST', '/api/v1/admin/network/dns/sync', MASTER, {})).statusCode).toBe(502);
  });
});

describe('Subdomain je Server', () => {
  let owner: Headers;
  beforeAll(async () => {
    await call('PATCH', '/api/v1/admin/network/dns', MASTER, { provider: 'none' }); // Hintergrundabgleich aus
    owner = await login('dn-owner');
  });

  it('der Besitzer setzt sie; Liste und Details zeigen sie', async () => {
    const res = await call('PATCH', '/api/v1/servers/dn-1/domain', owner, { subdomain: 'Haupt', srvRecordEnabled: true });
    expect(res.json()).toMatchObject({ ok: true, subdomain: 'haupt', srvRecordEnabled: true });
    expect((await call('GET', '/api/v1/servers/dn-1', owner)).json().server).toMatchObject({ subdomain: 'haupt', srvRecordEnabled: true });
    expect((await call('GET', '/api/v1/servers', owner)).json().servers.find((s: { id: string }) => s.id === 'dn-1')).toMatchObject({ subdomain: 'haupt' });
  });

  it('doppelt vergeben, ungültig, ohne Recht, fremder Server, leeren', async () => {
    expect((await call('PATCH', '/api/v1/servers/dn-1/domain', MASTER, { subdomain: 'tal' })).statusCode).toBe(409);
    for (const bad of ['-x', 'a b', 'x'.repeat(40), 'a.b']) expect((await call('PATCH', '/api/v1/servers/dn-1/domain', owner, { subdomain: bad })).statusCode, bad).toBe(400);
    expect((await call('PATCH', '/api/v1/servers/dn-1/domain', await login('dn-ohne'), { subdomain: 'neu' })).statusCode).toBe(403);
    expect((await call('PATCH', '/api/v1/servers/dn-2/domain', owner, { subdomain: 'neu' })).statusCode).toBe(404);
    expect((await call('PATCH', '/api/v1/servers/dn-1/domain', owner, { subdomain: null })).json().subdomain).toBeNull();
    expect((await call('GET', '/api/v1/servers/dn-1', owner)).json().server.subdomain).toBeNull();
  });
});
