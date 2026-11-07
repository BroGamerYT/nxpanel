import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';

/** Zeitplaene duerfen keine Rechte ausweiten und keine fremden Zeitplaene ausloesen. */
let app: FastifyInstance;
let helperToken: string;
let serverA: string;
let foreignSchedule: string;
let ownCommandSchedule: string;

async function login(name: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: 'password-123', client: 'app' } });
  return r.json().accessToken as string;
}

beforeAll(async () => {
  await runMigrations();
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false });
  // Reste eines frueheren Laufs weg (die Tests teilen sich die Datenbank)
  await sql`DELETE FROM servers WHERE short_id IN ('spa0001', 'spb0001')`;
  await sql`DELETE FROM users WHERE username IN ('sp-owner', 'sp-helper')`;
  const owner = await createUser({ username: 'sp-owner', email: 'sp-owner@test.local', password: 'password-123', role: 'user', canCreateServers: true });
  const helper = await createUser({ username: 'sp-helper', email: 'sp-helper@test.local', password: 'password-123', role: 'user', canCreateServers: false });
  helperToken = await login('sp-helper');

  let [node] = await sql<{ id: string }[]>`SELECT id FROM nodes LIMIT 1`;
  if (!node) [node] = await sql<{ id: string }[]>`INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb) VALUES ('Local', '127.0.0.1', 8192, 50000) RETURNING id`;
  let [egg] = await sql<{ id: string }[]>`SELECT id FROM eggs LIMIT 1`;
  if (!egg) {
    const [nest] = await sql<{ id: string }[]>`INSERT INTO nests (name) VALUES ('SP Nest') RETURNING id`;
    [egg] = await sql<{ id: string }[]>`INSERT INTO eggs (nest_id, name, author, docker_images, startup) VALUES (${nest!.id}, 'SP Egg', 'test', '{"default": "alpine"}', 'echo 1') RETURNING id`;
  }
  const mk = async (short: string) => (await sql<{ id: string }[]>`
    INSERT INTO servers (name, short_id, owner_id, node_id, egg_id, docker_image, startup, status, ram_mb, disk_mb)
    VALUES (${short}, ${short}, ${owner.id}, ${node!.id}, ${egg!.id}, 'alpine', 'echo 1', 'offline', 1024, 2048) RETURNING id`)[0]!.id;
  serverA = await mk('spa0001');
  const serverB = await mk('spb0001');

  // Helfer darf auf A nur Zeitplaene pflegen und ausloesen - keine Konsole, kein Neustart, kein Backup.
  await sql`INSERT INTO subusers (server_id, user_id, permissions) VALUES (${serverA}, ${helper.id}, ${['schedule.read', 'schedule.update', 'schedule.run']})`;
  ownCommandSchedule = (await sql<{ id: string }[]>`
    INSERT INTO server_schedules (server_id, name, action, payload, interval_minutes, active)
    VALUES (${serverA}, 'vom Besitzer', 'command', 'say hi', 60, false) RETURNING id`)[0]!.id;
  foreignSchedule = (await sql<{ id: string }[]>`
    INSERT INTO server_schedules (server_id, name, action, payload, interval_minutes, active)
    VALUES (${serverB}, 'fremd', 'restart', null, 60, false) RETURNING id`)[0]!.id;
});

afterAll(async () => {
  await app?.close();
  await closeDatabase();
});

const auth = () => ({ authorization: `Bearer ${helperToken}` });

describe('Zeitplan-Rechte', () => {
  it('kein command-Zeitplan ohne control.command', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverA}/schedules`, headers: auth(),
      payload: { name: 'hintertuer', action: 'command', payload: 'op sp-helper', interval_minutes: 60 } });
    expect(r.statusCode).toBe(403);
  });

  it('kein Neustart- oder Backup-Zeitplan ohne die Rechte dafuer', async () => {
    for (const action of ['restart', 'backup']) {
      const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverA}/schedules`, headers: auth(),
        payload: { name: action, action, interval_minutes: 60 } });
      expect(r.statusCode).toBe(403);
    }
  });

  it('fremden command-Zeitplan weder aendern noch ausloesen', async () => {
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/servers/${serverA}/schedules/${ownCommandSchedule}`, headers: auth(),
      payload: { payload: 'op sp-helper' } });
    expect(patch.statusCode).toBe(403);
    const run = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverA}/schedules/${ownCommandSchedule}/run`, headers: auth() });
    expect(run.statusCode).toBe(403);
  });

  it('Zeitplan eines anderen Servers nicht ueber die eigene Server-ID ausloesbar', async () => {
    await sql`UPDATE subusers SET permissions = ${['schedule.read', 'schedule.update', 'schedule.run', 'control.restart']} WHERE server_id = ${serverA}`;
    const run = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverA}/schedules/${foreignSchedule}/run`, headers: auth() });
    expect(run.statusCode).toBe(404);
  });

  it('mit dem passenden Recht geht es', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverA}/schedules`, headers: auth(),
      payload: { name: 'nachts neu', action: 'restart', cron: '04:00' } });
    expect(r.statusCode).toBe(201);
  });
});
