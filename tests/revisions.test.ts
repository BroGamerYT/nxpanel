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
    username: 'rev-admin',
    email: 'rev-admin@test.local',
    password: 'password-123',
    role: 'admin',
    canCreateServers: true,
  });

  const resLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'rev-admin', password: 'password-123', client: 'app' },
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
    VALUES ('Revision Test Srv', 'revsrv01', ${admin.id}, ${node.id}, ${egg.id}, 'alpine', 'echo 1', 'offline', 1024, 2048)
    RETURNING id
  `;
  serverId = srv.id;
});

afterAll(async () => {
  await app?.close();
  await closeDatabase();
});

describe('Dateiversionierung und Revisionen', () => {
  it('erzeugt bei Änderungen Revisionen und ermöglicht Rollback', async () => {
    const testFile = 'server.properties';

    // 1. Version 1 speichern
    const saveV1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/files/content`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: testFile, content: 'motd=Erste Version\nmax-players=20' },
    });
    expect(saveV1.statusCode).toBe(200);

    // 2. Version 2 speichern
    const saveV2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/files/content`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: testFile, content: 'motd=Zweite Version\nmax-players=50' },
    });
    expect(saveV2.statusCode).toBe(200);

    // 3. Revisionsliste abrufen
    const revList = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files/revisions?path=${testFile}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(revList.statusCode).toBe(200);
    const revisions = revList.json().revisions;
    expect(revisions.length).toBeGreaterThanOrEqual(2);

    const oldestRev = revisions[revisions.length - 1];

    // 4. Einzelne Revision mit Inhalt abrufen
    const singleRev = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files/revisions/${oldestRev.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(singleRev.statusCode).toBe(200);
    expect(singleRev.json().revision.content).toContain('Erste Version');

    // 5. Rollback auf Version 1 durchführen
    const rollbackRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/files/revisions/${oldestRev.id}/rollback`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(rollbackRes.statusCode).toBe(200);

    // 6. Dateiinhalt prüfen -> muss wieder Version 1 sein!
    const readCurrent = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files/content?path=${testFile}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(readCurrent.statusCode).toBe(200);
    expect(readCurrent.json().content).toContain('Erste Version');
  });
});
