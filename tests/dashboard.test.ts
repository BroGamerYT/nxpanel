import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { importEggFromFile } from '../src/eggs/import.js';
import { ensureLocalNode } from '../src/servers/nodes.js';
import { StatsCollector, type LiveStats } from '../src/servers/stats-collector.js';
import type { ContainerStats } from '../src/docker/client.js';

let app: FastifyInstance;
const PW = 'ein-langes-passwort';
const live = new Map<string, LiveStats>();
const disk = new Map<string, number>();
let owner = '', admin = '', sidA = '', sidB = '';

beforeAll(async () => { await runMigrations(); });
beforeEach(async () => {
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations, subusers, events, audit_log, sessions RESTART IDENTITY CASCADE`;
  live.clear();
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false, stats: { snapshot: () => live },
    disk: { serverMb: () => disk, docker: () => ({ imagesMb: 5000, containersMb: 10, volumesMb: 0, buildCacheMb: 300 }), measuredAt: () => 1 },
    power: { start: async () => {}, stop: async () => {}, restart: async () => {}, kill: async () => {} },
    ops: { provision: async () => {}, remove: async () => {}, rebuild: async () => {}, updateResources: async () => {} },
    consoleEngine: { tailLogs: async () => [], streamLogs: async () => () => {}, streamStats: async () => () => {}, sendToStdin: async () => {} } });
  await createUser({ username: 'owner', email: 'o@t.local', password: PW, canCreateServers: true });
  await createUser({ username: 'admin', email: 'a@t.local', password: PW, role: 'admin' });
  await ensureLocalNode();
  const egg = (await importEggFromFile('eggs/teamspeak6.json')).eggId;
  const tok = async (u: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u, password: PW, client: 'app' } })).json().accessToken as string;
  owner = await tok('owner'); admin = await tok('admin');
  const mk = async (t: string, name: string) => (await app.inject({ method: 'POST', url: '/api/v1/servers', headers: { authorization: `Bearer ${t}` },
    payload: { name, eggId: egg, ramMb: 1024, diskMb: 2048, cpuPercent: 100, variables: {} } })).json().server.id as string;
  sidA = await mk(owner, 'A'); sidB = await mk(admin, 'B');
  await sql`UPDATE servers SET status = 'running'`;
  disk.clear(); disk.set(sidA, 1500); disk.set(sidB, 500);
  live.set(sidA, { cpuPercent: 12.5, memMb: 300, memLimitMb: 1024, rxRate: 1000, txRate: 2000, at: Date.now() });
  live.set(sidB, { cpuPercent: 50, memMb: 700, memLimitMb: 1024, rxRate: 10, txRate: 20, at: Date.now() });
});
afterAll(async () => { await app?.close(); await closeDatabase(); });

describe('Dashboard', () => {
  it('Nutzer: nur eigene Server, keine Host-Daten', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: { authorization: `Bearer ${owner}` } })).json();
    expect(r.host).toBeNull();
    expect(r.totals).toMatchObject({ servers: 1, running: 1, ramAssignedMb: 1024, ramUsedMb: 300, cpuPercent: 12.5, rxRate: 1000, txRate: 2000 });
    expect(Object.keys(r.perServer)).toEqual([sidA]);
    expect(r.diskUsed).toEqual({ [sidA]: 1500 });
    expect(r.totals.diskUsedMb).toBe(1500);
  });
  it('Admin: alles plus Grundleistung', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: { authorization: `Bearer ${admin}` } })).json();
    expect(r.totals).toMatchObject({ servers: 2, ramUsedMb: 1000, cpuPercent: 62.5 });
    expect(r.host.cpuCores).toBeGreaterThan(0);
    expect(r.host.ramTotalMb).toBeGreaterThan(r.host.ramUsedMb);
    expect(r.host.assigned).toEqual({ ramMb: 2048, cpuPercent: 200, diskMb: 4096, servers: 2 });
    expect(r.host.storage).toMatchObject({ gameDataMb: 2000, docker: { imagesMb: 5000 } });
  });
});

describe('Speicher-Limit', () => {
  it('Start ueber dem Limit wird abgelehnt, Aufraeumen nur fuer Admins', async () => {
    const { diskCollector } = await import('../src/servers/stats.js');
    await sql`UPDATE servers SET status = 'offline' WHERE id = ${sidA}`;
    (diskCollector as unknown as { sizes: Map<string, number> }).sizes.set(sidA, 999_999);
    const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${sidA}/power`, headers: { authorization: `Bearer ${owner}` }, payload: { action: 'start' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('disk_full');
    (diskCollector as unknown as { sizes: Map<string, number> }).sizes.delete(sidA);
    const ok = await app.inject({ method: 'POST', url: `/api/v1/servers/${sidA}/power`, headers: { authorization: `Bearer ${owner}` }, payload: { action: 'start' } });
    expect(ok.statusCode).toBe(202);
    const prune = await app.inject({ method: 'POST', url: '/api/v1/admin/docker/prune', headers: { authorization: `Bearer ${owner}` }, payload: {} });
    expect(prune.statusCode).toBe(403);
  });
});

describe('Ordnergroesse', () => {
  it('misst einen Ordner', async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { dirSizeMb } = await import('../src/servers/disk-collector.js');
    const d = await mkdtemp(join(tmpdir(), 'nxp-du-'));
    await mkdir(join(d, 'a'));
    await writeFile(join(d, 'a', 'big'), Buffer.alloc(3 * 1024 * 1024, 1));
    expect(await dirSizeMb(d)).toBeGreaterThanOrEqual(3);
  });
});

describe('Statistik-Sammler', () => {
  it('meldet laufende Container an, rechnet Netzrate, meldet gestoppte ab', async () => {
    const subs = new Map<string, (s: ContainerStats) => void>();
    const stopped: string[] = [];
    const c = new StatsCollector(async (cid, cb) => { subs.set(cid, cb); return () => stopped.push(cid); });
    await sql`UPDATE servers SET container_id = 'c-' || name`;
    await c.sync();
    await new Promise((r) => setTimeout(r, 10));
    expect([...subs.keys()].sort()).toEqual(['c-A', 'c-B']);
    const base = { cpuPercent: 5, memMb: 100, memLimitMb: 1024, netRxBytes: 0, netTxBytes: 0 };
    subs.get('c-A')!(base);
    expect(c.snapshot().get(sidA)).toMatchObject({ cpuPercent: 5, rxRate: 0 });
    // Verlauf: ein Punkt je 10 s, bleibt nach dem Stoppen erhalten
    subs.get('c-A')!({ ...base, cpuPercent: 7 });
    expect(c.history(sidA)).toHaveLength(1);
    expect(c.history(sidA)[0]).toMatchObject({ cpu: 5, mem: 100 });
    await sql`UPDATE servers SET status = 'offline' WHERE id = ${sidB}`;
    await c.sync();
    expect(stopped).toEqual(['c-B']);
    c.stop();
  });
});
