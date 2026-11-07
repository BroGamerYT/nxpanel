import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { volumePath } from '../src/docker/client.js';
import {
  generateBackupName,
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  setBackupLock,
  backupFilePath,
  verifyBackup,
  rotateBackups,
} from '../src/servers/backups.js';
import { writeFileContent, readFileContent } from '../src/servers/files.js';

let app: FastifyInstance;
let adminId: string;
let adminToken: string;
let viewerToken: string;
let serverId: string;
let serverShortId: string;
let viewerId: string;
const PW = 'backup-test-pw-123';

beforeAll(async () => {
  await runMigrations();
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false });

  const admin = await createUser({
    username: 'backup-admin',
    email: 'backup-admin@example.com',
    password: PW,
    role: 'admin',
    canCreateServers: true,
  });
  adminId = admin.id;
  const viewer = await createUser({
    username: 'backup-viewer',
    email: 'backup-viewer@example.com',
    password: PW,
    role: 'user',
    canCreateServers: false,
  });
  viewerId = viewer.id;

  const resAdmin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'backup-admin', password: PW, client: 'app' },
  });
  adminToken = resAdmin.json().accessToken;

  const resViewer = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'backup-viewer', password: PW, client: 'app' },
  });
  viewerToken = resViewer.json().accessToken;

  // Node & Egg
  let [node] = await sql<{ id: string }[]>`SELECT id FROM nodes LIMIT 1`;
  if (!node) {
    [node] = await sql<{ id: string }[]>`
      INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb)
      VALUES ('Localhost', '127.0.0.1', 16384, 100000)
      RETURNING id
    `;
  }

  // Die Pruefung erwartet Minecraft-Dateien (server.properties, level.dat) -
  // also gezielt ein Minecraft-Egg nehmen, nicht irgendeines aus anderen Tests.
  let [egg] = await sql<{ id: string }[]>`SELECT id FROM eggs WHERE name ILIKE '%minecraft%' ORDER BY name LIMIT 1`;
  if (!egg) {
    const [nest] = await sql<{ id: string }[]>`INSERT INTO nests (name) VALUES ('Test Nest') RETURNING id`;
    [egg] = await sql<{ id: string }[]>`
      INSERT INTO eggs (nest_id, name, author, docker_images, startup, raw_egg)
      VALUES (${nest.id}, 'Minecraft Java (Test)', 'test', '{"default": "ghcr.io/test:latest"}', 'echo 1', '{}')
      RETURNING id
    `;
  }

  // Server anlegen
  const [srv] = await sql<{ id: string; short_id: string }[]>`
    INSERT INTO servers (name, short_id, owner_id, node_id, egg_id, docker_image, startup, status, ram_mb, disk_mb, variables)
    VALUES ('Survival World', 'bkupsrv1', ${admin.id}, ${node.id}, ${egg.id}, 'alpine', 'echo 1', 'offline', 1024, 5000, '{"MINECRAFT_VERSION": "1.21.1"}')
    RETURNING id, short_id
  `;
  serverId = srv.id;
  serverShortId = srv.short_id;

  // Viewer ohne backup.* Flags
  await sql`
    INSERT INTO subusers (server_id, user_id, permissions)
    VALUES (${serverId}, ${viewerId}, ${['control.console']})
  `;
});

afterAll(async () => {
  if (serverShortId) {
    await rm(volumePath(serverShortId), { recursive: true, force: true }).catch(() => {});
  }
  await sql`DELETE FROM backups WHERE server_id = ${serverId}`.catch(() => {});
  await sql`DELETE FROM servers WHERE id = ${serverId}`.catch(() => {});
  await sql`DELETE FROM users WHERE username IN ('backup-admin', 'backup-viewer')`.catch(() => {});
  await app.close();
  await closeDatabase();
});

beforeEach(async () => {
  const root = volumePath(serverShortId);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o750 });
});

describe('Backup Namensgebung & Format', () => {
  it('erzeugt Namen mit Name, Spiel, Version, Datum und Zeit', () => {
    const fixedDate = new Date('2026-11-07T14:30:15Z');
    const b = generateBackupName('Mein Server', 'Minecraft Paper', '1.21.1', fixedDate);

    expect(b.name).toContain('Mein-Server_Minecraft-Paper_(1.21.1)_');
    expect(b.filename).toMatch(/^Mein-Server_Minecraft-Paper_\(1\.21\.1\)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.zst$/);
  });

  it('funktioniert auch ohne Versionsangabe', () => {
    const fixedDate = new Date('2026-11-07T14:30:15Z');
    const b = generateBackupName('Vanilla Server', 'Minecraft', null, fixedDate);

    expect(b.name).toContain('Vanilla-Server_Minecraft_');
    expect(b.filename).toMatch(/^Vanilla-Server_Minecraft_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.zst$/);
  });
});

describe('Backup Erstellung, Sperre, Wiederherstellung & Löschen', () => {
  it('kann Backup erstellen, sperren, entsperren und wiederherstellen', async () => {
    await writeFileContent(serverShortId, 'world.dat', 'Block data 123');

    // Backup anlegen
    const b = await createBackup(
      serverId,
      { id: adminId, username: 'backup-admin' },
      '127.0.0.1'
    );

    expect(b.server_id).toBe(serverId);
    expect(b.name).toContain('Survival-World');
    expect(b.filename).toContain('.tar.zst');

    // Kurz warten bis Hintergrundprozess fertig komprimiert hat
    let retries = 20;
    let finished = false;
    while (retries-- > 0) {
      const list = await listBackups(serverId);
      const found = list.find((x) => x.id === b.id);
      if (found && found.status === 'completed') {
        finished = true;
        expect(Number(found.bytes)).toBeGreaterThan(0);
        expect(found.checksum).toHaveLength(64);
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(finished).toBe(true);

    // Sperre setzen
    await setBackupLock(serverId, b.id, true);

    // Löschen versuchen -> muss fehlschlagen, da gesperrt
    await expect(deleteBackup(serverId, b.id, { id: adminId, username: 'backup-admin' }, '127.0.0.1')).rejects.toThrow(
      'Gesperrte Backups können nicht gelöscht werden'
    );

    // Datei im Serverordner manipulieren/löschen
    await rm(join(volumePath(serverShortId), 'world.dat'));
    expect(existsSync(join(volumePath(serverShortId), 'world.dat'))).toBe(false);

    // Backup wiederherstellen
    await restoreBackup(serverId, b.id, { id: adminId, username: 'backup-admin' }, '127.0.0.1');

    // Datei muss wieder da sein
    expect(existsSync(join(volumePath(serverShortId), 'world.dat'))).toBe(true);
    const content = await readFileContent(serverShortId, 'world.dat');
    expect(content.content).toBe('Block data 123');

    // Entsperren und löschen
    await setBackupLock(serverId, b.id, false);
    await deleteBackup(serverId, b.id, { id: adminId, username: 'backup-admin' }, '127.0.0.1');

    const remaining = await listBackups(serverId);
    expect(remaining.find((x) => x.id === b.id)).toBeUndefined();
    expect(existsSync(backupFilePath(serverId, b.id))).toBe(false);
  });
});

describe('Backup REST-API (/api/v1/servers/:id/backups)', () => {
  it('verweigert Nutzern ohne backup.read das Lesen von Backups', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/backups`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('erlaubt Admin das Anlegen und Abrufen über die API', async () => {
    await writeFileContent(serverShortId, 'config.yml', 'enable: true');

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/backups`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Mein Test Backup' },
    });

    expect(createRes.statusCode).toBe(200);
    const backupId = createRes.json().backup.id;

    // Abrufen
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/backups`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().backups.length).toBeGreaterThanOrEqual(1);

    // Warten auf Abschluss
    for (let i = 0; i < 20; i++) {
      const check = await app.inject({
        method: 'GET',
        url: `/api/v1/servers/${serverId}/backups`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const b = check.json().backups.find((x: { id: string }) => x.id === backupId);
      if (b && b.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Sperre per PATCH ändern
    const lockRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}/backups/${backupId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { locked: true },
    });
    expect(lockRes.statusCode).toBe(200);
    expect(lockRes.json().backup.locked).toBe(true);

    // Download testen
    const dlRes = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/backups/${backupId}/download`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers['content-disposition']).toContain('tar.zst');

    // Entsperren & Löschen
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}/backups/${backupId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { locked: false },
    });

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/backups/${backupId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.statusCode).toBe(200);
  });

  it('prüft Backups auf Integrität und Spiel-Dateien (Verifizierung)', async () => {
    // Spieldaten erzeugen
    await writeFileContent(serverShortId, 'server.properties', 'gamemode=survival\nmotd=Nexus');
    await writeFileContent(serverShortId, 'world/level.dat', 'test-level-content');

    const backup = await createBackup(
      serverId,
      { id: adminId, username: 'admin' },
      '127.0.0.1',
      'Validierungs-Test'
    );

    // Warten bis fertig
    let completed = false;
    for (let i = 0; i < 30; i++) {
      const list = await listBackups(serverId);
      const b = list.find((x) => x.id === backup.id);
      if (b && b.status === 'completed') {
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(completed).toBe(true);

    // Verifizierung über API
    const verifyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/backups/${backup.id}/verify`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json();
    expect(body.ok).toBe(true);
    expect(body.result.status).toBe('valid');
    expect(body.result.sha256Match).toBe(true);
    expect(body.result.archiveIntact).toBe(true);
    expect(body.result.filesCount).toBeGreaterThan(0);
    expect(body.result.criticalFilesFound).toContain('server.properties');

    // Aufräumen
    await deleteBackup(serverId, backup.id, { id: adminId, username: 'admin' }, '127.0.0.1');
  }, 15000);

  it('verwaltet Auto-Backup Zeitpläne und rotiert nach Aufbewahrungslimit', async () => {
    // Schedule abrufen
    const getSched = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/backup-schedule`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(getSched.statusCode).toBe(200);
    expect(getSched.json().schedule).toHaveProperty('enabled');

    // Schedule setzen
    const putSched = await app.inject({
      method: 'PUT',
      url: `/api/v1/servers/${serverId}/backup-schedule`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        enabled: true,
        intervalHours: 12,
        retention: 2,
        verify: true,
      },
    });
    expect(putSched.statusCode).toBe(200);
    expect(putSched.json().schedule.intervalHours).toBe(12);
    expect(putSched.json().schedule.retention).toBe(2);

    // 3 Backups simulieren und Retention testen
    const [b1] = await sql<{ id: string }[]>`
      INSERT INTO backups (server_id, name, filename, status, locked, created_at)
      VALUES (${serverId}, 'Old 1', 'old1.tar.zst', 'completed', false, now() - interval '3 hours')
      RETURNING id
    `;
    const [b2] = await sql<{ id: string }[]>`
      INSERT INTO backups (server_id, name, filename, status, locked, created_at)
      VALUES (${serverId}, 'Old 2', 'old2.tar.zst', 'completed', false, now() - interval '2 hours')
      RETURNING id
    `;
    const [b3] = await sql<{ id: string }[]>`
      INSERT INTO backups (server_id, name, filename, status, locked, created_at)
      VALUES (${serverId}, 'New 3', 'new3.tar.zst', 'completed', false, now() - interval '1 hour')
      RETURNING id
    `;

    // Retention: Limit = 2 -> das älteste (b1) muss gelöscht werden
    const rotation = await rotateBackups(serverId, 2);
    expect(rotation.deletedCount).toBe(1);
    expect(rotation.deletedIds).toContain(b1.id);

    // Aufräumen
    await sql`DELETE FROM backups WHERE id IN (${b1.id}, ${b2.id}, ${b3.id})`;
  });
});
