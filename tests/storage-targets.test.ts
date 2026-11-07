import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';

let app: FastifyInstance;
let adminToken: string;
let serverId: string;

beforeAll(async () => {
  await runMigrations();
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false });

  const admin = await createUser({
    username: 'target-admin',
    email: 'target-admin@test.local',
    password: 'password-123',
    role: 'admin',
    canCreateServers: true,
  });

  const resLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'target-admin', password: 'password-123', client: 'app' },
  });
  adminToken = resLogin.json().accessToken;

  let [node] = await sql<{ id: string }[]>`SELECT id FROM nodes LIMIT 1`;
  if (!node) {
    [node] = await sql<{ id: string }[]>`
      INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb) VALUES ('Local', '127.0.0.1', 8192, 50000) RETURNING id
    `;
  }
  let [egg] = await sql<{ id: string }[]>`SELECT id FROM eggs LIMIT 1`;
  if (!egg) {
    const [nest] = await sql<{ id: string }[]>`INSERT INTO nests (name) VALUES ('Test Nest') RETURNING id`;
    [egg] = await sql<{ id: string }[]>`
      INSERT INTO eggs (nest_id, name, author, docker_images, startup) VALUES (${nest.id}, 'Test Egg', 'test', '{"default": "alpine"}', 'echo 1') RETURNING id
    `;
  }

  const [srv] = await sql<{ id: string }[]>`
    INSERT INTO servers (name, short_id, owner_id, node_id, egg_id, docker_image, startup, status, ram_mb, disk_mb)
    VALUES ('Target Test Srv', 'tgtsrv01', ${admin.id}, ${node.id}, ${egg.id}, 'alpine', 'echo 1', 'offline', 1024, 2048)
    RETURNING id
  `;
  serverId = srv.id;
});

afterAll(async () => {
  await app?.close();
  await closeDatabase();
});

describe('Speicherziele (Storage Targets)', () => {
  it('verwaltet Speicherziele über die API (CRUD & Test)', async () => {
    // 1. Hetzner Storage Box via SFTP anlegen
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/storage-targets`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Hetzner Storage Box (u503096)',
        kind: 'sftp',
        config: {
          host: 'u503096.your-storagebox.de',
          port: 22,
          username: 'u503096',
          basePath: '/backups/nexuspanel',
        },
        isDefault: true,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const target = createRes.json().target;
    expect(target.name).toBe('Hetzner Storage Box (u503096)');
    expect(target.kind).toBe('sftp');

    // 2. Auflisten
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/storage-targets`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().targets.length).toBeGreaterThanOrEqual(1);

    // 3. Verbindungstest
    const testRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/storage-targets/${target.id}/test`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().ok).toBe(true);

    // 4. Löschen
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/storage-targets/${target.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.statusCode).toBe(200);
  });
});
