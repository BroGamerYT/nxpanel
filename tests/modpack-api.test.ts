import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { getSetting, setSetting } from '../src/settings.js';

let app: FastifyInstance;
let adminT: string; let userT: string;
let srvPaper: string; let srvPack: string;

async function login(name: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: 'password-123', client: 'app' } });
  return r.json().accessToken as string;
}
const h = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  await runMigrations();
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false });
  await sql`DELETE FROM servers WHERE short_id IN ('mpa0001', 'mpb0001')`;
  await sql`DELETE FROM users WHERE username IN ('mp-admin', 'mp-user')`;
  const admin = await createUser({ username: 'mp-admin', email: 'mp-admin@test.local', password: 'password-123', role: 'admin', canCreateServers: true });
  const user = await createUser({ username: 'mp-user', email: 'mp-user@test.local', password: 'password-123', role: 'user', canCreateServers: false });
  adminT = await login('mp-admin'); userT = await login('mp-user');
  let [node] = await sql<{ id: string }[]>`SELECT id FROM nodes LIMIT 1`;
  if (!node) [node] = await sql<{ id: string }[]>`INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb) VALUES ('Local', '127.0.0.1', 8192, 50000) RETURNING id`;
  let [egg] = await sql<{ id: string }[]>`SELECT id FROM eggs LIMIT 1`;
  if (!egg) {
    const [nest] = await sql<{ id: string }[]>`INSERT INTO nests (name) VALUES ('MP Nest') RETURNING id`;
    [egg] = await sql<{ id: string }[]>`INSERT INTO eggs (nest_id, name, author, docker_images, startup) VALUES (${nest!.id}, 'MP Egg', 'test', '{"default": "alpine"}', 'echo 1') RETURNING id`;
  }
  const mk = async (short: string, vars: Record<string, string>) => (await sql<{ id: string }[]>`
    INSERT INTO servers (name, short_id, owner_id, node_id, egg_id, docker_image, startup, status, ram_mb, disk_mb, variables)
    VALUES (${short}, ${short}, ${admin.id}, ${node!.id}, ${egg!.id}, 'alpine', 'echo 1', 'offline', 1024, 2048, ${sql.json(vars)}) RETURNING id`)[0]!.id;
  srvPaper = await mk('mpa0001', { TYPE: 'PAPER' });
  srvPack = await mk('mpb0001', { TYPE: 'FTBA', FTB_MODPACK_ID: '125', FTB_MODPACK_VERSION_ID: '1' });
  // Mitnutzer darf Einstellungen aendern, aber keine Backups anlegen
  await sql`INSERT INTO subusers (server_id, user_id, permissions) VALUES (${srvPack}, ${user.id}, ${['startup.read', 'startup.update']})`;
});

afterAll(async () => { await setSetting('curseforge_api_key', null); await app?.close(); await closeDatabase(); });

describe('Modpack-API', () => {
  it('Schluessel verschluesselt gespeichert, nie im Klartext', async () => {
    await setSetting('curseforge_api_key', 'geheimer-test-schluessel-1234', { secret: true });
    const [row] = await sql<{ value: string; encrypted: boolean }[]>`SELECT value, encrypted FROM panel_settings WHERE key = 'curseforge_api_key'`;
    expect(row!.encrypted).toBe(true);
    expect(row!.value).not.toContain('geheimer');
    expect(await getSetting('curseforge_api_key')).toBe('geheimer-test-schluessel-1234');
    const r = await app.inject({ method: 'GET', url: '/api/v1/modpacks/curseforge', headers: h(userT) });
    expect(r.json()).toEqual({ configured: true });
    expect(r.body).not.toContain('geheimer');
    await setSetting('curseforge_api_key', null);
  });

  it('nur Admins setzen den Schluessel', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/v1/admin/modpacks/curseforge', headers: h(userT), payload: { apiKey: 'x'.repeat(40) } });
    expect(r.statusCode).toBe(403);
  });

  it('Server ohne Modpack meldet keins, Update geht nicht', async () => {
    const st = await app.inject({ method: 'GET', url: `/api/v1/servers/${srvPaper}/modpack`, headers: h(adminT) });
    expect(st.json()).toEqual({ pack: null });
    const up = await app.inject({ method: 'POST', url: `/api/v1/servers/${srvPaper}/modpack/update`, headers: h(adminT), payload: {} });
    expect(up.statusCode).toBe(400);
  });

  it('Update nur mit Backup-Recht', async () => {
    const up = await app.inject({ method: 'POST', url: `/api/v1/servers/${srvPack}/modpack/update`, headers: h(userT), payload: {} });
    expect(up.statusCode).toBe(403);
    expect(up.json().error).toContain('backup.create');
  });

  it('Suche braucht mindestens zwei Zeichen', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/modpacks/search?q=a', headers: h(userT) });
    expect(r.statusCode).toBe(400);
  });
});
