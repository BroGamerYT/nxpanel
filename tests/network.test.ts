import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { importEggFromFile } from '../src/eggs/import.js';
import { ensureLocalNode } from '../src/servers/nodes.js';
import { findPortGroup, type EggPorts } from '../src/servers/allocations.js';

const mc: EggPorts = {
  primary: { ref: 'game', start: 25565, end: 25664, protocol: 'tcp' },
  secondary: [{ ref: 'rcon', offset: 10, protocol: 'tcp', optional: true }],
};

describe('Port-Bereich des Hosts', () => {
  it('ersetzt den Wunschbereich des Eggs', () => {
    const g = findPortGroup(mc, new Set(), () => true, { from: 28000, to: 28999 });
    expect(g!.map((a) => a.port)).toEqual([28000, 28010]);
  });
  it('nimmt den niedrigsten freien Port im Bereich', () => {
    const g = findPortGroup(mc, new Set([28000, 28001]), () => true, { from: 28000, to: 28999 });
    expect(g![0]!.port).toBe(28002);
  });
  it('Nebenport ausserhalb des Bereichs: optional wird weggelassen, Pflicht verhindert die Gruppe', () => {
    const g = findPortGroup(mc, new Set(), () => true, { from: 28995, to: 28999 });
    expect(g!.map((a) => a.port)).toEqual([28995]);
    const strict: EggPorts = { primary: mc.primary, secondary: [{ ref: 'query', offset: 10, protocol: 'udp' }] };
    expect(findPortGroup(strict, new Set(), () => true, { from: 28995, to: 28999 })).toBeNull();
  });
  it('Nebenport ohne Versatz wird im Bereich gesucht', () => {
    const spec: EggPorts = { primary: { ref: 'game', start: 7777, end: 7800, protocol: 'udp' }, secondary: [{ ref: 'query', start: 27015, end: 27050, protocol: 'udp' }] };
    const g = findPortGroup(spec, new Set(), () => true, { from: 28000, to: 28999 });
    expect(g!.map((a) => a.port)).toEqual([28000, 28001]);
  });
});

let app: FastifyInstance;
const PW = 'ein-langes-passwort';
let eggId = '';
let nodeId = '';
let admin = '';
let user = '';

beforeAll(async () => { await runMigrations(); });
beforeEach(async () => {
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations, subusers, events, audit_log, sessions RESTART IDENTITY CASCADE`;
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false,
    power: { start: async () => {}, stop: async () => {}, restart: async () => {}, kill: async () => {} },
    ops: { provision: async () => {}, remove: async () => {}, rebuild: async () => {}, updateResources: async () => {} },
    consoleEngine: { tailLogs: async () => [], streamLogs: async () => () => {}, streamStats: async () => () => {}, sendToStdin: async () => {} } });
  await createUser({ username: 'admin', email: 'a@t.local', password: PW, role: 'admin' });
  await createUser({ username: 'nutzer', email: 'n@t.local', password: PW, canCreateServers: true });
  nodeId = await ensureLocalNode();
  eggId = (await importEggFromFile('eggs/minecraft-paper.json')).eggId;
  const tok = async (u: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u, password: PW, client: 'app' } })).json().accessToken as string;
  admin = await tok('admin');
  user = await tok('nutzer');
});
afterAll(async () => { await app?.close(); await closeDatabase(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const create = (t: string, name: string) => app.inject({ method: 'POST', url: '/api/v1/servers', headers: auth(t),
  payload: { name, eggId, ramMb: 2048, diskMb: 5000, variables: { EULA: 'TRUE' } } });

describe('Netzwerk-API', () => {
  it('Bereich setzen: neue Server bekommen Ports daraus, oeffentliche Adresse wird geliefert', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/api/v1/admin/nodes/${nodeId}`, headers: auth(admin),
      payload: { publicHost: 'mc.brogameryt.de', portFrom: 28000, portTo: 28999 } });
    expect(r.statusCode, r.body).toBe(200);
    const a = (await create(user, 'Eins')).json().server.shortId;
    await create(user, 'Zwei');
    const d = (await app.inject({ method: 'GET', url: `/api/v1/servers/${a}`, headers: auth(user) })).json();
    expect(d.server.publicHost).toBe('mc.brogameryt.de');
    expect(d.server.ports.map((p: { port: number }) => p.port)).toEqual([28000, 28010]);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/servers', headers: auth(user) })).json().servers;
    expect(list.map((s: { primaryPort: number }) => s.primaryPort).sort()).toEqual([28000, 28001]);
    expect(list[0].publicHost).toBe('mc.brogameryt.de');
  });

  it('Uebersicht zeigt alle Ports, ausserhalb des Bereichs markiert', async () => {
    await create(user, 'Alt'); // noch ohne Bereich -> 25565
    const r = (await app.inject({ method: 'PATCH', url: `/api/v1/admin/nodes/${nodeId}`, headers: auth(admin),
      payload: { portFrom: 28000, portTo: 28999 } })).json();
    expect(r.outside.map((o: { port: number }) => o.port)).toContain(25565);
    const al = (await app.inject({ method: 'GET', url: '/api/v1/admin/allocations', headers: auth(admin) })).json().allocations;
    const game = al.find((a: { port: number }) => a.port === 25565);
    expect(game.inRange).toBe(false);
    expect(game.server.name).toBe('Alt');
    // Adresse ausserhalb des Bereichs wird nicht als oeffentlich ausgegeben
    await app.inject({ method: 'PATCH', url: `/api/v1/admin/nodes/${nodeId}`, headers: auth(admin), payload: { publicHost: '193.34.69.60' } });
    const list = (await app.inject({ method: 'GET', url: '/api/v1/servers', headers: auth(user) })).json().servers;
    expect(list[0].publicHost).toBeNull();
  });

  it('Bereich voll: klare Meldung, nichts angelegt', async () => {
    await app.inject({ method: 'PATCH', url: `/api/v1/admin/nodes/${nodeId}`, headers: auth(admin), payload: { portFrom: 28000, portTo: 28010 } });
    // Minecraft braucht Spiel- und RCON-Port (+10) - passt genau einmal
    expect((await create(user, 'A')).statusCode).toBe(201);
    const r = await create(user, 'B');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('28000-28010');
  });

  it('Eingaben werden geprueft, nur Admins', async () => {
    const bad = async (payload: object) => (await app.inject({ method: 'PATCH', url: `/api/v1/admin/nodes/${nodeId}`, headers: auth(admin), payload })).statusCode;
    expect(await bad({ portFrom: 28000 })).toBe(400);
    expect(await bad({ portFrom: 29000, portTo: 28000 })).toBe(400);
    expect(await bad({ portFrom: 80, portTo: 100 })).toBe(400);
    expect(await bad({ publicHost: 'http://x.de:25565' })).toBe(400);
    expect(await bad({ portFrom: null, portTo: null, publicHost: null })).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/allocations', headers: auth(user) })).statusCode).toBe(403);
  });
});
