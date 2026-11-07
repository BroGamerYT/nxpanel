import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { sql, closeDatabase } from '../src/db/index.js';
import { volumePath } from '../src/docker/client.js';
import { rm, mkdir } from 'node:fs/promises';
import { writeFileContent } from '../src/servers/files.js';

let app: FastifyInstance;
let adminToken: string;
let viewerToken: string;
let serverId: string;
let serverShortId: string;
let viewerId: string;
const PW = 'ein-sicheres-passwort-123';

beforeAll(async () => {
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false });

  // Nutzer über createUser anlegen
  const admin = await createUser({ username: 'file-admin', email: 'file-admin@example.com', password: PW, role: 'admin', canCreateServers: true });
  const viewer = await createUser({ username: 'file-viewer', email: 'file-viewer@example.com', password: PW, role: 'user', canCreateServers: false });
  viewerId = viewer.id;

  const resAdmin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'file-admin', password: PW, client: 'app' },
  });
  adminToken = resAdmin.json().accessToken;

  const resViewer = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'file-viewer', password: PW, client: 'app' },
  });
  viewerToken = resViewer.json().accessToken;

  // Vorhandenen Node & Egg nutzen
  let [node] = await sql<{ id: string }[]>`SELECT id FROM nodes LIMIT 1`;
  if (!node) {
    [node] = await sql<{ id: string }[]>`
      INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb)
      VALUES ('Localhost', '127.0.0.1', 16384, 100000)
      RETURNING id
    `;
  }

  let [egg] = await sql<{ id: string }[]>`SELECT id FROM eggs LIMIT 1`;
  if (!egg) {
    const [nest] = await sql<{ id: string }[]>`INSERT INTO nests (name) VALUES ('Test Nest') RETURNING id`;
    [egg] = await sql<{ id: string }[]>`
      INSERT INTO eggs (nest_id, name, author, docker_images, startup)
      VALUES (${nest.id}, 'Files Egg', 'test', '{"default": "ghcr.io/test:latest"}', 'echo 1')
      RETURNING id
    `;
  }

  // Server anlegen
  const [srv] = await sql<{ id: string; short_id: string }[]>`
    INSERT INTO servers (name, short_id, owner_id, node_id, egg_id, docker_image, startup, status, ram_mb, disk_mb)
    VALUES ('File Test Server', 'filesrv1', ${admin.id}, ${node.id}, ${egg.id}, 'alpine', 'echo 1', 'offline', 1024, 5000)
    RETURNING id, short_id
  `;
  serverId = srv.id;
  serverShortId = srv.short_id;

  // Viewer als Subuser mit nur control.console (kein file.*)
  await sql`
    INSERT INTO subusers (server_id, user_id, permissions)
    VALUES (${serverId}, ${viewerId}, ${['control.console']})
  `;
});

afterAll(async () => {
  if (serverShortId) {
    await rm(volumePath(serverShortId), { recursive: true, force: true }).catch(() => {});
  }
  await sql`DELETE FROM servers WHERE id = ${serverId}`.catch(() => {});
  await sql`DELETE FROM users WHERE username IN ('file-admin', 'file-viewer')`.catch(() => {});
  await sql`DELETE FROM eggs WHERE name = 'Files Egg'`.catch(() => {});
  await app.close();
  await closeDatabase();
});

beforeEach(async () => {
  const root = volumePath(serverShortId);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o750 });
});

describe('Dateimanager REST-API (/api/v1/servers/:id/files)', () => {
  it('verweigert Nutzern ohne file.read das Lesen von Dateien', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('erlaubt Admin das Auflisten von Ordnern', async () => {
    await writeFileContent(serverShortId, 'server.cfg', 'hostname "Test"');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].name).toBe('server.cfg');
  });

  it('kann Dateiinhalt lesen und speichern', async () => {
    // Speichern
    const saveRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/files/content`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: 'config.json', content: '{"port": 25565}' },
    });
    expect(saveRes.statusCode).toBe(200);

    // Lesen
    const readRes = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files/content?path=config.json`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(readRes.statusCode).toBe(200);
    const readBody = readRes.json();
    expect(readBody.content).toBe('{"port": 25565}');
  });

  it('kann Ordner anlegen, umbenennen und loeschen', async () => {
    // Ordner anlegen
    const dirRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/files/directory`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: 'plugins' },
    });
    expect(dirRes.statusCode).toBe(200);

    // Umbenennen
    const renameRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/files/rename`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { from: 'plugins', to: 'mods' },
    });
    expect(renameRes.statusCode).toBe(200);

    // Loeschen
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/files`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: 'mods' },
    });
    expect(delRes.statusCode).toBe(200);
  });

  it('faengt Directory-Traversal in der API sauber mit Status 400 ab', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files/content?path=../../etc/passwd`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_path');
  });

  it('unterstuetzt Dateidownload', async () => {
    await writeFileContent(serverShortId, 'download-me.txt', 'downloadable content');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/files/download?path=download-me.txt`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('download-me.txt');
    expect(res.body).toBe('downloadable content');
  });

  it('unterstuetzt Packen und Entpacken ueber die API', async () => {
    await writeFileContent(serverShortId, 'test1.txt', 'Content 1');
    await writeFileContent(serverShortId, 'test2.txt', 'Content 2');

    // Packen
    const zipRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/files/compress`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { paths: ['test1.txt', 'test2.txt'], destination: 'archive.zip' },
    });
    expect(zipRes.statusCode).toBe(200);
    expect(zipRes.json().path).toBe('archive.zip');

    // Entpacken
    const unzipRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/files/decompress`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: 'archive.zip', destination: 'extracted' },
    });
    expect(unzipRes.statusCode).toBe(200);
  });
});
