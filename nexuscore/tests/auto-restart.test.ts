import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { AutoRestart, MAX_CRASHES, WINDOW_MS } = await import('../src/ops/auto-restart.js');
const { saveServerMeta } = await import('../src/http/routes/settings.js');

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
const bus = new EventBus();
let started: string[] = [];
let crashed = true;
let failStart = false;
let clock = 1_000_000;

const crash = (id: string, exitCode = 137): void => bus.emit({ type: 'state', serverId: id, state: { id, status: 'error', exitCode }, ts: new Date().toISOString() });
const actions = (id: string): string[] => registry.recentAudit({ serverId: id }).map((a) => a.action);

const restart = new (AutoRestart as new (o: ConstructorParameters<typeof AutoRestart>[0]) => InstanceType<typeof AutoRestart>)({
  get registry() {
    return registry;
  },
  bus,
  start: async (id: string) => {
    if (failStart) throw new Error('Start geht nicht');
    started.push(id);
  },
  isCrashed: async () => crashed,
  delayMs: 10,
  now: () => clock,
} as never);

const add = async (id: string, install?: { state: 'installing' | 'done' }) =>
  registry.add({ id, name: id, game: 'x', executable: 'x', args: [], workingDir: path.join(dir, id), ports: [], ...(install ? { install: { state: install.state, kind: 'container' as const } } : {}) });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-autorestart-'));
  registry = await ServerRegistry.open(dir);
  restart.start();
});
afterAll(async () => {
  restart.stop();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  started = [];
  crashed = true;
  failStart = false;
  clock += 2 * WINDOW_MS; // alte Abstuerze der vorigen Tests zaehlen nicht
});

describe('Automatischer Neustart nach Absturz', () => {
  it('ausgeschaltet (Standard): nichts passiert', async () => {
    await add('ar-off');
    crash('ar-off');
    await new Promise((r) => setTimeout(r, 40));
    await restart.whenIdle();
    expect(started).toEqual([]);
    expect(actions('ar-off')).not.toContain('server.crash');
  });

  it('eingeschaltet: startet nach kurzer Pause neu und protokolliert Absturz und Neustart', async () => {
    await add('ar-on');
    saveServerMeta(registry, 'ar-on', { autoRestart: true });
    crash('ar-on', 139);
    expect(started).toEqual([]); // erst nach der Pause
    await new Promise((r) => setTimeout(r, 60));
    await restart.whenIdle();
    expect(started).toEqual(['ar-on']);
    const a = registry.recentAudit({ serverId: 'ar-on' });
    expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(['server.crash', 'server.auto_restart']));
    expect(JSON.stringify(a.find((x) => x.action === 'server.crash'))).toContain('139');
  });

  it('mehrere Meldungen während der Pause ergeben nur einen Neustart', async () => {
    await add('ar-dup');
    saveServerMeta(registry, 'ar-dup', { autoRestart: true });
    crash('ar-dup');
    crash('ar-dup');
    crash('ar-dup');
    await new Promise((r) => setTimeout(r, 60));
    await restart.whenIdle();
    expect(started).toEqual(['ar-dup']);
  });

  it('wurde der Server inzwischen von Hand gestartet oder gestoppt, wird nichts getan', async () => {
    await add('ar-manual');
    saveServerMeta(registry, 'ar-manual', { autoRestart: true });
    crashed = false;
    crash('ar-manual');
    await new Promise((r) => setTimeout(r, 60));
    await restart.whenIdle();
    expect(started).toEqual([]);
  });

  it('Absturzschleife: nach 5 Abstürzen in 10 Minuten bleibt der Server aus', async () => {
    await add('ar-loop');
    saveServerMeta(registry, 'ar-loop', { autoRestart: true });
    for (let i = 0; i < MAX_CRASHES; i++) {
      crash('ar-loop');
      await new Promise((r) => setTimeout(r, 40));
      await restart.whenIdle();
      clock += 1000;
    }
    expect(started).toHaveLength(MAX_CRASHES);
    crash('ar-loop'); // der sechste
    await new Promise((r) => setTimeout(r, 40));
    await restart.whenIdle();
    expect(started).toHaveLength(MAX_CRASHES);
    expect(actions('ar-loop')).toContain('server.crash_loop');
    // Von Hand wieder gestartet und später erneut abgestürzt: der Zähler fängt neu an
    crash('ar-loop');
    await new Promise((r) => setTimeout(r, 40));
    await restart.whenIdle();
    expect(started).toHaveLength(MAX_CRASHES + 1);
  });

  it('Abstürze außerhalb des Zeitfensters zählen nicht', async () => {
    await add('ar-window');
    saveServerMeta(registry, 'ar-window', { autoRestart: true });
    for (let i = 0; i < MAX_CRASHES + 3; i++) {
      crash('ar-window');
      await new Promise((r) => setTimeout(r, 30));
      await restart.whenIdle();
      clock += WINDOW_MS + 1; // jedes Mal weit auseinander
    }
    expect(started).toHaveLength(MAX_CRASHES + 3);
    expect(actions('ar-window')).not.toContain('server.crash_loop');
  });

  it('ein Fehler beim Starten wird protokolliert, zählt als Absturz und endet nach der Grenze - ohne zu werfen', async () => {
    await add('ar-fail');
    saveServerMeta(registry, 'ar-fail', { autoRestart: true });
    failStart = true;
    crash('ar-fail');
    await new Promise((r) => setTimeout(r, 400));
    await restart.whenIdle();
    expect(actions('ar-fail')).toContain('server.auto_restart_failed');
    expect(actions('ar-fail')).toContain('server.crash_loop');
    expect(registry.recentAudit({ serverId: 'ar-fail' }).filter((a) => a.action === 'server.auto_restart_failed')).toHaveLength(MAX_CRASHES);
  });

  it('nicht fertig installiert oder gelöscht: kein Neustart', async () => {
    await add('ar-inst', { state: 'installing' });
    saveServerMeta(registry, 'ar-inst', { autoRestart: true });
    crash('ar-inst');
    crash('gibt-es-nicht');
    await new Promise((r) => setTimeout(r, 40));
    await restart.whenIdle();
    expect(started).toEqual([]);
  });
});

describe('Einstellung über die Schnittstelle', () => {
  let server: Awaited<ReturnType<typeof createCoreServer>>;
  let reg2: InstanceType<typeof ServerRegistry>;
  let dir2: string;
  const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', 'content-type': 'application/json' };
  beforeAll(async () => {
    dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-autorestart2-'));
    reg2 = await ServerRegistry.open(dir2);
    const driver = new MockDriver();
    await driver.initialize();
    server = await createCoreServer(driver, new EventBus(), reg2, { installs: null, scheduler: false });
  });
  afterAll(async () => {
    await server.close();
    reg2.close();
    await fs.rm(dir2, { recursive: true, force: true });
  });

  it('neu angelegte Server starten nach einem Absturz von selbst neu - abschaltbar und wieder einschaltbar', async () => {
    const created = await server.inject({ method: 'POST', url: '/api/v1/servers', headers: MASTER, payload: { name: 'Neu Server', eggId: 'minecraft-paper' } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().server.id as string;
    const detail = async () => (await server.inject({ method: 'GET', url: `/api/v1/servers/${id}`, headers: { authorization: MASTER.authorization } })).json().server.autoRestart;
    expect(await detail()).toBe(true);
    expect((await server.inject({ method: 'PATCH', url: `/api/v1/servers/${id}`, headers: MASTER, payload: { autoRestart: false } })).statusCode).toBe(200);
    expect(await detail()).toBe(false);
    expect((await server.inject({ method: 'PATCH', url: `/api/v1/servers/${id}`, headers: MASTER, payload: { autoRestart: true } })).statusCode).toBe(200);
    expect(await detail()).toBe(true);
  });
});
