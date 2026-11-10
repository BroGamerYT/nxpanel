import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createCoreServer } from '../src/http/server.js';
import { MockDriver } from '../src/drivers/mock-driver.js';
import { EventBus } from '../src/protocol/events.js';
import { ServerRegistry } from '../src/store/registry.js';
import type { FastifyInstance } from 'fastify';

describe('1:1 Frontend Integration & Standalone API v1', () => {
  let server: FastifyInstance;
  let driver: MockDriver;
  let bus: EventBus;
  let registry: ServerRegistry;
  let tmpDir: string;

  let authHeaders: { authorization: string };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-front-'));
    bus = new EventBus();
    driver = new MockDriver();
    registry = await ServerRegistry.open(tmpDir);
    server = await createCoreServer(driver, bus, registry);

    const refreshRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    const { accessToken } = refreshRes.json();
    authHeaders = { authorization: `Bearer ${accessToken}` };
  });

  afterEach(async () => {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('liefert die echte HTML-Weboberflaeche auf GET / aus', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<div id="root"></div>');
  });

  it('unterstuetzt SPA-Routing (Fallback auf index.html bei /neu)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/neu',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="root"></div>');
  });

  it('blockiert nicht authentifizierte Anfragen auf /api/v1/auth/me mit 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });
    expect(res.statusCode).toBe(401);
  });

  it('authentifiziert den Standalone-Admin ueber /api/v1/auth/me mit Token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.user.role).toBe('admin');
    expect(json.permissions['server.create']).toBe(true);
    expect(json.permissions['admin.hosts']).toBe(true);
  });

  it('liefert das Dashboard mit Host-Daten und Server-Zusammenfassung', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/dashboard',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.totals).toBeDefined();
    expect(json.host).toBeDefined();
    expect(json.host.cpuCores).toBeGreaterThan(0);
    expect(json.host.ramTotalMb).toBeGreaterThan(0);
  });

  it('erstellt, listet und steuert Gameserver ueber /api/v1/servers', async () => {
    // 1. Server erstellen
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: authHeaders,
      payload: {
        name: 'Mein Test Minecraft Server',
        eggId: 'minecraft-paper',
        ramMb: 4096,
        cpuPercent: 200,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.server.id).toBeDefined();

    const serverId = created.server.id;

    // 2. Server auflisten
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: authHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list.servers.length).toBe(1);
    expect(list.servers[0].id).toBe(serverId);
    expect(list.servers[0].eggName).toBe('minecraft-paper');
    expect(list.servers[0].permissions).toContain('control.console');
    expect(list.servers[0].permissions).toContain('control.start');

    // 3. Server Power Action
    const powerRes = await server.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/power`,
      headers: authHeaders,
      payload: { action: 'start' },
    });
    expect(powerRes.statusCode).toBe(200);

    // 4. Server Details abrufen
    const detailRes = await server.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}`,
      headers: authHeaders,
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json();
    expect(detail.server.id).toBe(serverId);
    expect(detail.server.limits.ramMb).toBe(4096);
    expect(detail.permissions).toContain('control.console');
    expect(detail.permissions).toContain('file.read');
  });

  it('liefert den Spielekatalog ueber /api/v1/eggs', async () => {
    const eggsRes = await server.inject({
      method: 'GET',
      url: '/api/v1/eggs',
      headers: authHeaders,
    });
    expect(eggsRes.statusCode).toBe(200);
    const eggs = eggsRes.json();
    expect(Array.isArray(eggs.eggs)).toBe(true);
    expect(eggs.eggs.length).toBeGreaterThan(0);
    const mc = eggs.eggs.find((e: { id: string }) => e.id.includes('minecraft'));
    expect(mc).toBeDefined();
  });
});
