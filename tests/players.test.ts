import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:net';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { importEggFromFile } from '../src/eggs/import.js';
import { ensureLocalNode } from '../src/servers/nodes.js';
import { config } from '../src/config.js';
import { parseList, dropRcon } from '../src/games/status.js';
import { liftDueBans } from '../src/games/ban-expiry.js';

let app: FastifyInstance;
const PW = 'ein-langes-passwort';
let owner = '', sid = '', short = '';
let rcon: Server; let rconPort = 0;
const received: string[] = [];

/** Kleiner RCON-Server, der Minecraft spielt. */
function fakeRcon(): Promise<void> {
  return new Promise((res) => {
    rcon = createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 4 && buf.length >= buf.readInt32LE(0) + 4) {
          const len = buf.readInt32LE(0), id = buf.readInt32LE(4), type = buf.readInt32LE(8);
          const body = buf.toString('utf8', 12, 4 + len - 2);
          buf = buf.subarray(len + 4);
          const reply = (t: number, text: string) => { const b = Buffer.from(text); const p = Buffer.alloc(14 + b.length);
            p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(type === 3 && body !== 'rcon-geheim' ? -1 : id, 4); p.writeInt32LE(t, 8); b.copy(p, 12); s.write(p); };
          if (type === 3) { reply(2, ''); continue; }
          received.push(body);
          if (body === 'ListPlayers') reply(0, '0. BroGamerYT, 0002a1b2c3d4e5f60718293a4b5c6d7e\n');
          else if (body === 'list') reply(0, 'There are 2 of a max of 20 players online: BroGamerYT, Simon_99');
          else if (body === 'tps') reply(0, '§6TPS from last 1m, 5m, 15m: §a19.5, 20.0, 20.0');
          else reply(0, `ok ${body}`);
        }
      });
    }).listen(0, '127.0.0.1', () => { rconPort = (rcon.address() as { port: number }).port; res(); });
  });
}

beforeAll(async () => { await runMigrations(); await fakeRcon(); });
beforeEach(async () => {
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations, subusers, events, audit_log, sessions, player_bans RESTART IDENTITY CASCADE`;
  received.length = 0;
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false,
    power: { start: async () => {}, stop: async () => {}, restart: async () => {}, kill: async () => {} },
    ops: { provision: async () => {}, remove: async () => {}, rebuild: async () => {}, updateResources: async () => {} },
    consoleEngine: { tailLogs: async () => [], streamLogs: async () => () => {}, streamStats: async () => () => {}, sendToStdin: async () => {} } });
  await createUser({ username: 'owner', email: 'o@t.local', password: PW, canCreateServers: true });
  await ensureLocalNode();
  const egg = (await importEggFromFile('eggs/minecraft-paper.json')).eggId;
  owner = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'owner', password: PW, client: 'app' } })).json().accessToken;
  const r = await app.inject({ method: 'POST', url: '/api/v1/servers', headers: { authorization: `Bearer ${owner}` },
    payload: { name: 'MC', eggId: egg, ramMb: 2048, diskMb: 4096, variables: { EULA: 'TRUE', RCON_PASSWORD: 'rcon-geheim' } } });
  sid = r.json().server.id; short = r.json().server.shortId;
  dropRcon(sid);
  await sql`UPDATE servers SET status = 'running' WHERE id = ${sid}`;
  await sql`UPDATE allocations SET port = ${rconPort} WHERE server_id = ${sid} AND ref = 'rcon'`;
});
afterAll(async () => { rcon.close(); await app?.close(); await closeDatabase(); });

const auth = () => ({ authorization: `Bearer ${owner}` });

describe('Spielerliste', () => {
  it('liest "list" in allen ueblichen Formen', () => {
    expect(parseList('There are 2 of a max of 20 players online: BroGamerYT, Simon_99')).toEqual(['BroGamerYT', 'Simon_99']);
    expect(parseList('There are 0 of a max of 20 players online: ')).toEqual([]);
    expect(parseList('§6There are §c1§6 out of maximum §c20§6 players online.\n§6default§r: BroGamerYT')).toEqual(['BroGamerYT']);
    expect(parseList('Unknown command')).toBeNull();
  });
});

describe('Live-Status und Spielerverwaltung', () => {
  it('Status: TPS und alle Spieler ueber RCON', async () => {
    const r = (await app.inject({ method: 'GET', url: `/api/v1/servers/${sid}/game-status`, headers: auth() })).json();
    expect(r.running).toBe(true);
    expect(r.tps.tps).toBe(19.5);
    expect(r.players).toEqual(['BroGamerYT', 'Simon_99']);
    expect(r.rcon).toBe(true);
  });

  it('kicken, Zeitbann, Ablauf hebt den Bann auf; Injektion abgewiesen', async () => {
    const kick = await app.inject({ method: 'POST', url: `/api/v1/servers/${sid}/players/action`, headers: auth(), payload: { action: 'kick', name: 'Simon_99', reason: 'AFK' } });
    expect(kick.statusCode, kick.body).toBe(200);
    expect(received).toContain('kick Simon_99 AFK');
    const ban = await app.inject({ method: 'POST', url: `/api/v1/servers/${sid}/players/action`, headers: auth(), payload: { action: 'ban', name: 'Simon_99', reason: 'Griefing', minutes: 60 } });
    expect(ban.statusCode).toBe(200);
    expect(received).toContain('ban Simon_99 Griefing');
    await sql`UPDATE player_bans SET until = now() - interval '1 minute'`;
    expect(await liftDueBans()).toBe(1);
    expect(received).toContain('pardon Simon_99');
    const bad = await app.inject({ method: 'POST', url: `/api/v1/servers/${sid}/players/action`, headers: auth(), payload: { action: 'kick', name: 'x; stop' } });
    expect(bad.statusCode).toBe(400);
    const nl = await app.inject({ method: 'POST', url: `/api/v1/servers/${sid}/players/action`, headers: auth(), payload: { action: 'kick', name: 'Steve', reason: 'a\nstop' } });
    expect(nl.statusCode).toBe(400);
  });

  it('Listen aus den Dateien, auch gestoppt', async () => {
    const dir = join(config.VOLUME_ROOT, short);
    await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'banned-players.json'), JSON.stringify([{ name: 'Griefer', reason: 'TNT', created: '2026-11-07 01:00:00 +0100', source: 'BroGamerYT' }]));
    await writeFile(join(dir, 'whitelist.json'), JSON.stringify([{ uuid: 'x', name: 'BroGamerYT' }]));
    await writeFile(join(dir, 'ops.json'), JSON.stringify([{ uuid: 'x', name: 'BroGamerYT', level: 4 }]));
    await sql`UPDATE servers SET status = 'offline' WHERE id = ${sid}`;
    const r = (await app.inject({ method: 'GET', url: `/api/v1/servers/${sid}/players/lists`, headers: auth() })).json();
    expect(r.bans[0]).toMatchObject({ name: 'Griefer', reason: 'TNT', by: 'BroGamerYT' });
    expect(r.whitelist).toEqual(['BroGamerYT']);
    expect(r.ops).toEqual(['BroGamerYT']);
    const act = await app.inject({ method: 'POST', url: `/api/v1/servers/${sid}/players/action`, headers: auth(), payload: { action: 'kick', name: 'Steve' } });
    expect(act.statusCode).toBe(409);
  });
});

describe('ARK: Spieler ueber RCON und EOS-ID', () => {
  it('Liste, Zeitbann mit ID, Ablauf', async () => {
    const ark = (await importEggFromFile('eggs/ark-survival-ascended.json')).eggId;
    const r = await app.inject({ method: 'POST', url: '/api/v1/servers', headers: auth(),
      payload: { name: 'ARK', eggId: ark, ramMb: 4096, diskMb: 20000, variables: { ADMIN_PASSWORD: 'rcon-geheim', SESSION_NAME: 'Test' } } });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().server.id as string;
    dropRcon(id);
    await sql`UPDATE servers SET status = 'running' WHERE id = ${id}`;
    await sql`UPDATE allocations SET port = 1030 WHERE server_id = ${sid} AND ref = 'rcon'`;
    await sql`UPDATE allocations SET port = ${rconPort} WHERE server_id = ${id} AND ref = 'rcon'`;
    const st = (await app.inject({ method: 'GET', url: `/api/v1/servers/${id}/game-status`, headers: auth() })).json();
    expect(st.people).toEqual([{ name: 'BroGamerYT', id: '0002a1b2c3d4e5f60718293a4b5c6d7e' }]);
    expect(st.actions).toContain('ban');
    const ban = await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/players/action`, headers: auth(),
      payload: { action: 'ban', name: 'BroGamerYT', id: '0002a1b2c3d4e5f60718293a4b5c6d7e', reason: 'Test', minutes: 60 } });
    expect(ban.statusCode, ban.body).toBe(200);
    expect(received).toContain('BanPlayer 0002a1b2c3d4e5f60718293a4b5c6d7e');
    const lists = (await app.inject({ method: 'GET', url: `/api/v1/servers/${id}/players/lists`, headers: auth() })).json();
    expect(lists.bans[0]).toMatchObject({ name: 'BroGamerYT', id: '0002a1b2c3d4e5f60718293a4b5c6d7e', reason: 'Test' });
    const op = await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/players/action`, headers: auth(), payload: { action: 'op', name: 'x', id: 'abcdef' } });
    expect(op.statusCode).toBe(400);
    await sql`UPDATE player_bans SET until = now() - interval '1 minute'`;
    expect(await liftDueBans()).toBe(1);
    expect(received).toContain('UnbanPlayer 0002a1b2c3d4e5f60718293a4b5c6d7e');
  });
});
