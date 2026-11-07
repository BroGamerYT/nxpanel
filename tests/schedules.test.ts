import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { calculateNextRun, runPendingSchedules } from '../src/servers/schedules.js';

let app: FastifyInstance;
let adminToken: string;
let serverId: string;

beforeAll(async () => {
  await runMigrations();
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false });

  const admin = await createUser({
    username: 'sched-admin',
    email: 'sched-admin@test.local',
    password: 'password-123',
    role: 'admin',
    canCreateServers: true,
  });

  const resLogin = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'sched-admin', password: 'password-123', client: 'app' },
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
    VALUES ('Schedule Test Srv', 'sched01', ${admin.id}, ${node.id}, ${egg.id}, 'alpine', 'echo 1', 'offline', 1024, 2048)
    RETURNING id
  `;
  serverId = srv.id;
});

afterAll(async () => {
  await app?.close();
  await closeDatabase();
});

describe('Zeitplan-Logik (Schedules)', () => {
  it('berechnet nächste Ausführung korrekt für Intervalle und Uhrzeiten', () => {
    const now = new Date('2026-11-07T12:00:00Z');
    // 60 Minuten Intervall
    const nextInterval = calculateNextRun(null, 60, now);
    expect(nextInterval.getTime() - now.getTime()).toBe(60 * 60 * 1000);

    // Täglich 14:00 Uhr
    const nextToday = calculateNextRun('14:00', null, now);
    expect(nextToday.getHours()).toBe(14);
    expect(nextToday.getMinutes()).toBe(0);

    // Täglich 04:00 Uhr (liegt in der Vergangenheit -> morgen)
    const nextTomorrow = calculateNextRun('04:00', null, now);
    expect(nextTomorrow.getHours()).toBe(4);
    expect(nextTomorrow.getDate()).toBe(now.getDate() + 1);
  });

  it('verwaltet Zeitpläne über die API (CRUD & Ausführung)', async () => {
    // 1. Zeitplan anlegen
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/schedules`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Täglicher Neustart',
        action: 'restart',
        cron: '04:00',
        active: true,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const schedule = createRes.json().schedule;
    expect(schedule.name).toBe('Täglicher Neustart');
    expect(schedule.action).toBe('restart');
    expect(schedule.next_run_at).toBeTruthy();

    // 2. Auflisten
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/schedules`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().schedules.length).toBeGreaterThanOrEqual(1);

    // 3. Aktualisieren
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}/schedules/${schedule.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Neustart alle 12 Stunden',
        interval_minutes: 720,
      },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().schedule.name).toBe('Neustart alle 12 Stunden');
    expect(patchRes.json().schedule.interval_minutes).toBe(720);

    // 4. Manuell ausführen (Testlauf)
    const runRes = await app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/schedules/${schedule.id}/run`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(runRes.statusCode).toBe(200);

    // 5. Hintergrund-Runner auf fällige Zeitpläne testen
    await sql`UPDATE server_schedules SET next_run_at = now() - interval '1 minute' WHERE id = ${schedule.id}`;
    const ranCount = await runPendingSchedules();
    expect(ranCount).toBeGreaterThanOrEqual(1);

    // 6. Löschen
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/schedules/${schedule.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.statusCode).toBe(200);
  });
});
