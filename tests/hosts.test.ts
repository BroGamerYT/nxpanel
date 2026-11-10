import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { ensureLocalNode } from '../src/servers/nodes.js';
import { CoreHost, tokenFingerprint } from '../src/hosts/core-host.js';
import { listHosts, resolveHost, createCoreHost } from '../src/hosts/registry.js';

const PW = 'ein-langes-passwort';
const CORE_TOKEN = 'core-token-0123456789abcdefghij';

/**
 * Ein kleiner NexusCore-Nachbau: dieselben Routen, dieselbe Authentifizierung.
 *
 * So wird der Client gegen das echte Protokoll geprueft, ohne einen echten
 * Core zu brauchen.
 */
interface FakeCore {
  url: string;
  close(): Promise<void>;
  failAuth: boolean;
}

async function startFakeCore(): Promise<FakeCore> {
  const state = { failAuth: false };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/core/v1/info') {
      send(200, {
        status: 'ok',
        host: { name: 'fake-core', platform: 'win32', arch: 'x64', runtime: 'windows-native', version: '0.2.0' },
        metrics: {
          cpuUsagePercent: 12.5,
          totalMemoryMb: 32768,
          usedMemoryMb: 8192,
          diskTotalGb: 500,
          diskFreeGb: 250,
        },
      });
      return;
    }

    if (url.pathname === '/core/v1/pair') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { pin?: string };
        if (parsed.pin === 'RICHTIG') {
          send(200, { status: 'paired', core: { tokenFingerprint: tokenFingerprint(CORE_TOKEN) } });
        } else {
          send(400, { error: 'Kopplung fehlgeschlagen', message: 'Ungueltige PIN.' });
        }
      });
      return;
    }

    if (state.failAuth || token !== CORE_TOKEN) {
      send(401, { error: 'Nicht autorisiert', message: 'Ungueltiger Authentifizierungs-Token.' });
      return;
    }

    if (url.pathname === '/core/v1/servers') {
      send(200, { servers: [{ id: 'core-1', status: 'running' }] });
      return;
    }
    if (url.pathname === '/core/v1/servers/core-1/start') {
      send(200, { status: 'starting', state: { id: 'core-1', status: 'starting' } });
      return;
    }
    if (url.pathname === '/core/v1/servers/core-1/stats') {
      send(200, { stats: { serverId: 'core-1', status: 'running', cpuPercent: 3.5, memoryMb: 1024, uptimeSeconds: 90 } });
      return;
    }
    if (url.pathname === '/core/v1/servers/core-1/logs') {
      send(200, { serverId: 'core-1', lines: [{ ts: '2026-01-01T00:00:00.000Z', line: 'hallo', stream: 'stdout' }] });
      return;
    }
    send(404, { error: 'Nicht gefunden' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    get failAuth() {
      return state.failAuth;
    },
    set failAuth(v: boolean) {
      state.failAuth = v;
    },
  };
}

let app: FastifyInstance;
let admin = '';
let user = '';
let nodeId = '';
let core: FakeCore;

beforeAll(async () => {
  await runMigrations();
  core = await startFakeCore();
});

beforeEach(async () => {
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations, subusers, events, audit_log, sessions RESTART IDENTITY CASCADE`;
  app = await buildServer({
    rateLimitStore: new MemoryStore(),
    logger: false,
    power: { start: async () => {}, stop: async () => {}, restart: async () => {}, kill: async () => {} },
    ops: { provision: async () => {}, remove: async () => {}, rebuild: async () => {}, updateResources: async () => {} },
    consoleEngine: { tailLogs: async () => [], streamLogs: async () => () => {}, streamStats: async () => () => {}, sendToStdin: async () => {} },
  });
  await createUser({ username: 'admin', email: 'a@t.local', password: PW, role: 'admin' });
  await createUser({ username: 'nutzer', email: 'n@t.local', password: PW, canCreateServers: true });
  nodeId = await ensureLocalNode();
  const tok = async (u: string) =>
    (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u, password: PW, client: 'app' } })).json()
      .accessToken as string;
  admin = await tok('admin');
  user = await tok('nutzer');
});

afterAll(async () => {
  await app?.close();
  await core?.close();
  await closeDatabase();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('CoreHost-Client', () => {
  it('liest Info, Server, Statistik und Logs', async () => {
    const host = new CoreHost('host-1', core.url, CORE_TOKEN, 'windows-native');

    const info = await host.info();
    expect(info.name).toBe('fake-core');
    expect(info.runtime).toBe('windows-native');
    expect(info.metrics?.ramUsedMb).toBe(8192);

    const servers = await host.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe('core-1');

    const stats = await host.stats('core-1');
    expect(stats.memoryMb).toBe(1024);
    expect(stats.uptimeSeconds).toBe(90);

    const logs = await host.logs('core-1');
    expect(logs[0]?.line).toBe('hallo');
  });

  it('schickt den Token bei jeder Anfrage mit', async () => {
    const host = new CoreHost('host-1', core.url, CORE_TOKEN);
    await expect(host.listServers()).resolves.toHaveLength(1);
  });

  it('meldet ein falsches Token als Fehler', async () => {
    const host = new CoreHost('host-1', core.url, 'falsches-token');
    await expect(host.listServers()).rejects.toThrow(/401/);
  });

  it('meldet einen nicht erreichbaren Core', async () => {
    const host = new CoreHost('host-1', 'http://127.0.0.1:1', CORE_TOKEN);
    await expect(host.listServers()).rejects.toThrow(/nicht erreichbar/);
  });

  it('steuert eine Instanz', async () => {
    const host = new CoreHost('host-1', core.url, CORE_TOKEN);
    await expect(host.power('core-1', 'start')).resolves.toBeUndefined();
  });
});

describe('Core-Host anlegen', () => {
  it('speichert den Host, wenn das Token passt', async () => {
    const host = await createCoreHost({ name: 'Spiel-PC', address: core.url, token: CORE_TOKEN });
    expect(host.type).toBe('core');
    expect(host.status).toBe('online');
    expect(host.address).toBe(core.url);

    const hosts = await listHosts();
    expect(hosts.filter((h) => h.type === 'core')).toHaveLength(1);
  });

  it('speichert das Token verschluesselt - nie im Klartext', async () => {
    await createCoreHost({ name: 'Spiel-PC', address: core.url, token: CORE_TOKEN });
    const [row] = await sql<{ token_encrypted: string }[]>`SELECT token_encrypted FROM nodes WHERE type = 'core'`;
    expect(row?.token_encrypted).toBeTruthy();
    expect(row?.token_encrypted).not.toContain(CORE_TOKEN);
    expect(row?.token_encrypted.startsWith('v1:')).toBe(true);
  });

  it('lehnt ein falsches Token ab und speichert nichts', async () => {
    await expect(
      createCoreHost({ name: 'Falsch', address: core.url, token: 'falsches-token' }),
    ).rejects.toThrow(/Token|401/i);

    const hosts = await listHosts();
    expect(hosts.filter((h) => h.type === 'core')).toHaveLength(0);
  });

  it('verlangt bei gesetzter PIN ein passendes Token', async () => {
    await expect(
      createCoreHost({ name: 'Falsche PIN', address: core.url, token: CORE_TOKEN, pin: 'FALSCH' }),
    ).rejects.toThrow(/PIN/i);

    const host = await createCoreHost({ name: 'Mit PIN', address: core.url, token: CORE_TOKEN, pin: 'RICHTIG' });
    expect(host.type).toBe('core');
  });

  it('liefert beim Aufloesen ein CoreHost mit richtigem Token', async () => {
    const created = await createCoreHost({ name: 'Spiel-PC', address: core.url, token: CORE_TOKEN });
    const host = await resolveHost(created.id);
    expect(host).toBeInstanceOf(CoreHost);
    await expect(host!.listServers()).resolves.toHaveLength(1);
  });
});

describe('Host-API', () => {
  it('listet Hosts (lokal und Core)', async () => {
    await createCoreHost({ name: 'Spiel-PC', address: core.url, token: CORE_TOKEN });
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/hosts', headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const hosts = res.json().hosts as { type: string; name: string }[];
    expect(hosts.find((h) => h.type === 'local')).toBeDefined();
    expect(hosts.find((h) => h.type === 'core')?.name).toBe('Spiel-PC');
  });

  it('legt einen Core-Host ueber die API an', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/hosts',
      headers: auth(admin),
      payload: { name: 'Spiel-PC', address: core.url, token: CORE_TOKEN },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().host.type).toBe('core');
  });

  it('verlangt Admin-Rechte', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/hosts',
      headers: auth(user),
      payload: { name: 'Spiel-PC', address: core.url, token: CORE_TOKEN },
    });
    expect(res.statusCode).toBe(403);
  });

  it('verlangt einen Token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/hosts' });
    expect(res.statusCode).toBe(401);
  });

  it('meldet ein falsches Token als Fehler statt als 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/hosts',
      headers: auth(admin),
      payload: { name: 'Falsch', address: core.url, token: 'falsches-token' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('entfernt einen Core-Host wieder', async () => {
    const created = await createCoreHost({ name: 'Spiel-PC', address: core.url, token: CORE_TOKEN });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/admin/hosts/${created.id}`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);

    const hosts = await listHosts();
    expect(hosts.filter((h) => h.type === 'core')).toHaveLength(0);
  });

  it('laesst den lokalen Host unangetastet', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/admin/hosts/${nodeId}`, headers: auth(admin) });
    expect(res.statusCode).toBe(400);

    const hosts = await listHosts();
    expect(hosts.some((h) => h.id === nodeId)).toBe(true);
  });
});
