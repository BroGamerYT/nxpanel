import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { importEggFromFile } from '../src/eggs/import.js';
import { ensureLocalNode } from '../src/servers/nodes.js';
import { substitute } from '../src/eggs/variables.js';
import { PRESETS } from '../src/auth/permissions.js';

let app: FastifyInstance;
const PW = 'ein-langes-passwort';
const rebuilt: string[] = [];
const updated: string[] = [];
let eggId = '', nodeId = '', owner = '', helfer = '', sid = '';

beforeAll(async () => { await runMigrations(); });
beforeEach(async () => {
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations, subusers, events, audit_log, sessions RESTART IDENTITY CASCADE`;
  rebuilt.length = 0; updated.length = 0;
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false,
    power: { start: async () => {}, stop: async () => {}, restart: async () => {}, kill: async () => {} },
    ops: { provision: async () => {}, remove: async () => {}, rebuild: async (_id, c) => { rebuilt.push(c.reason); }, updateResources: async (id) => { updated.push(id); } },
    consoleEngine: { tailLogs: async () => [], streamLogs: async () => () => {}, streamStats: async () => () => {}, sendToStdin: async () => {} } });
  const o = await createUser({ username: 'owner', email: 'o@t.local', password: PW, canCreateServers: true });
  const h = await createUser({ username: 'helfer', email: 'h@t.local', password: PW });
  nodeId = await ensureLocalNode();
  eggId = (await importEggFromFile('eggs/minecraft-paper.json')).eggId;
  const tok = async (u: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u, password: PW, client: 'app' } })).json().accessToken as string;
  owner = await tok('owner'); helfer = await tok('helfer');
  const r = await app.inject({ method: 'POST', url: '/api/v1/servers', headers: { authorization: `Bearer ${owner}` },
    payload: { name: 'S', eggId, ramMb: 4096, diskMb: 10000, variables: { EULA: 'TRUE', RCON_PASSWORD: 'geheim123' } } });
  sid = r.json().server.id;
  await sql`UPDATE servers SET status = 'offline', container_id = 'c1' WHERE id = ${sid}`;
  await sql`INSERT INTO subusers (server_id, user_id, permissions) VALUES (${sid}, ${h.id}, ${PRESETS.verwalter.flags as string[]})`;
  void o;
});
afterAll(async () => { await app?.close(); await closeDatabase(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('Platzhalter', () => {
  it('SERVER_MEMORY_HEAP laesst 15 % Luft fuer die JVM', () => {
    const ctx = { variables: {}, ramMb: 4096, ip: '0.0.0.0', port: 1, ports: {}, serverDir: '/data', serverName: 'x' };
    expect(substitute('{{SERVER_MEMORY_HEAP}}M', ctx)).toBe('3481M');
  });
});

describe('Spiel-Einstellungen', () => {
  it('liefert Werte, Geheimnisse nur als "gesetzt"', async () => {
    const r = (await app.inject({ method: 'GET', url: `/api/v1/servers/${sid}/startup`, headers: auth(owner) })).json();
    const rcon = r.variables.find((v: { env: string }) => v.env === 'RCON_PASSWORD');
    // Wer aendern darf, sieht den Wert (Auge-Symbol) ...
    expect(rcon.value).toBe('geheim123');
    expect(rcon.isSet).toBe(true);
    // ... reine Zuschauer nur "gesetzt"
    await sql`UPDATE subusers SET permissions = ${['startup.read']} WHERE server_id = ${sid}`;
    const z = (await app.inject({ method: 'GET', url: `/api/v1/servers/${sid}/startup`, headers: auth(helfer) })).json();
    const zr = z.variables.find((v: { env: string }) => v.env === 'RCON_PASSWORD');
    expect(zr.value).toBe('');
    expect(zr.isSet).toBe(true);
    expect(r.variables.find((v: { env: string }) => v.env === 'DIFFICULTY').value).toBe('normal');
    expect(r.images.find((i: { current: boolean }) => i.current).image).toContain('java25');
  });

  it('aendern nur gestoppt; danach Container neu, Geheimnis bleibt bei leerer Eingabe', async () => {
    await sql`UPDATE servers SET status = 'running' WHERE id = ${sid}`;
    const run = await app.inject({ method: 'PATCH', url: `/api/v1/servers/${sid}/startup`, headers: auth(owner), payload: { variables: { DIFFICULTY: 'hard' } } });
    expect(run.statusCode).toBe(409);
    expect(run.json().code).toBe('must_stop');
    await sql`UPDATE servers SET status = 'offline' WHERE id = ${sid}`;
    const ok = await app.inject({ method: 'PATCH', url: `/api/v1/servers/${sid}/startup`, headers: auth(owner),
      payload: { variables: { DIFFICULTY: 'hard', RCON_PASSWORD: '', MEMORY: '99G' } } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().changed).toEqual(['DIFFICULTY']);
    const [s] = await sql<{ variables: Record<string, string> }[]>`SELECT variables FROM servers WHERE id = ${sid}`;
    expect(s!.variables.DIFFICULTY).toBe('hard');
    expect(s!.variables.RCON_PASSWORD).toBe('geheim123');
    expect(s!.variables.MEMORY).not.toBe('99G'); // nicht editierbar
    expect(rebuilt[0]).toContain('DIFFICULTY');
  });

  it('ungueltige Werte: 400, nichts geaendert', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/api/v1/servers/${sid}/startup`, headers: auth(owner), payload: { variables: { MAX_PLAYERS: '9999' } } });
    expect(r.statusCode).toBe(400);
    expect(r.json().issues[0].variable).toBe('MAX_PLAYERS');
    expect(rebuilt).toEqual([]);
  });

  it('Image wechseln braucht startup.image - Verwalter hat es nicht', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/api/v1/servers/${sid}/startup`, headers: auth(helfer), payload: { imageKey: 'Java 21 (Minecraft 1.20.5 bis 1.21.x)' } });
    expect(r.statusCode).toBe(403);
    const ok = await app.inject({ method: 'PATCH', url: `/api/v1/servers/${sid}/startup`, headers: auth(owner), payload: { imageKey: 'Java 21 (Minecraft 1.20.5 bis 1.21.x)' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const [s] = await sql`SELECT docker_image FROM servers WHERE id = ${sid}`;
    expect(s!.docker_image).toContain('java21');
  });
});

describe('Leistung', () => {
  it('nur Besitzer/Admin; laufend live, Heap-Hinweis', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/servers/${sid}/resources`, headers: auth(helfer), payload: { ramMb: 8192 } })).statusCode).toBe(403);
    await sql`UPDATE servers SET status = 'running' WHERE id = ${sid}`;
    const r = (await app.inject({ method: 'PATCH', url: `/api/v1/servers/${sid}/resources`, headers: auth(owner), payload: { ramMb: 8192, cpuPercent: 400 } })).json();
    expect(r).toMatchObject({ ok: true, live: true, restartNeeded: true });
    expect(updated).toEqual([sid]);
  });

  it('gestoppt: neuer Container, damit der Heap stimmt; Budget wird geprueft', async () => {
    const r = (await app.inject({ method: 'PATCH', url: `/api/v1/servers/${sid}/resources`, headers: auth(owner), payload: { ramMb: 6144 } })).json();
    expect(r.restartNeeded).toBe(false);
    expect(rebuilt[0]).toContain('6144');
    await sql`UPDATE users SET ram_limit_mb = 7000 WHERE username = 'owner'`;
    const no = await app.inject({ method: 'PATCH', url: `/api/v1/servers/${sid}/resources`, headers: auth(owner), payload: { ramMb: 8192 } });
    expect(no.statusCode).toBe(409);
  });
});

describe('Ports', () => {
  it('neu vergeben holt den Server in den Bereich', async () => {
    await sql`UPDATE nodes SET port_from = 28000, port_to = 28999 WHERE id = ${nodeId}`;
    const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${sid}/reallocate`, headers: auth(owner) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().ports).toEqual([{ ref: 'game', port: 28000 }, { ref: 'rcon', port: 28010 }]);
    const [old] = await sql`SELECT server_id, blocked_until FROM allocations WHERE port = 25565`;
    expect(old!.server_id).toBeNull();
    expect(old!.blocked_until).not.toBeNull();
  });

  it('zusaetzlicher Port anlegen und entfernen, Pflichtport bleibt', async () => {
    await sql`UPDATE nodes SET port_from = 28000, port_to = 28999 WHERE id = ${nodeId}`;
    const add = await app.inject({ method: 'POST', url: `/api/v1/servers/${sid}/allocations`, headers: auth(owner), payload: { ref: 'dynmap', protocol: 'tcp' } });
    expect(add.statusCode, add.body).toBe(201);
    expect(add.json()).toMatchObject({ ref: 'dynmap', port: 28000, env: 'DYNMAP_PORT' });
    expect((await app.inject({ method: 'POST', url: `/api/v1/servers/${sid}/allocations`, headers: auth(owner), payload: { ref: 'dynmap' } })).statusCode).toBe(409);
    const ports = await sql<{ port: number; is_primary: boolean }[]>`SELECT port, is_primary FROM allocations WHERE server_id = ${sid} ORDER BY port`;
    expect(ports.filter((p) => p.is_primary)).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/servers/${sid}/allocations/25565`, headers: auth(owner) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/servers/${sid}/allocations/28000`, headers: auth(owner) })).statusCode).toBe(200);
    expect(rebuilt).toHaveLength(2);
  });
});
