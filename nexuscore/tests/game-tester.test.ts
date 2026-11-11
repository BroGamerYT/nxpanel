import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { InstallManager } = await import('../src/install/manager.js');
const { GameTester, TesterError } = await import('../src/testing/game-tester.js');
const { createPowerOps } = await import('../src/ops/power.js');
const { loadEggs } = await import('../src/eggs/loader.js');

type SteamRunner = import('../src/install/steamcmd.js').SteamRunner;
type Tester = InstanceType<typeof GameTester>;

interface Ctx {
  dir: string;
  registry: InstanceType<typeof ServerRegistry>;
  driver: InstanceType<typeof MockDriver>;
  tester: Tester;
  files: Record<string, string>;
  failures: string[];
  sleepHook: { fn: (() => void) | null };
}

const open: Ctx[] = [];

async function setup(opts: { settleMs?: number; cases?: Array<{ id: string; name: string; eggId: string }>; installs?: boolean } = {}): Promise<Ctx> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-gt-'));
  const registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  const bus = new EventBus();
  const files: Record<string, string> = { 'PalServer.exe': 'MZ', 'enshrouded_server.exe': 'MZ' };
  const failures: string[] = [];
  const sleepHook: Ctx['sleepHook'] = { fn: null };

  const runner: SteamRunner = async (_exe, args, hooks) => {
    const failure = failures.shift();
    if (failure !== undefined) {
      hooks.onLine(`ERROR! Failed to install app '1' (${failure})`);
      return 8;
    }
    const target = args[args.indexOf('+force_install_dir') + 1]!;
    for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(target, f), c);
    hooks.onLine("Success! App '1' fully installed.");
    return 0;
  };
  const installs = opts.installs === false ? null : new InstallManager(registry, driver, bus, { runtimesDir: path.join(dir, 'runtimes'), steamRunner: runner, steamExe: 'C:/fake/steamcmd.exe' });
  let nextPort = 26000;
  const tester = new GameTester({
    registry,
    driver,
    bus,
    installs,
    power: createPowerOps({ registry, driver }),
    eggs: loadEggs,
    variablesFor: async () => ({ variables: { SERVER_NAME: 'Test', SERVER_SLOTS: '16', MAX_PLAYERS: '8' }, propertiesTemplate: {} }),
    portsFor: async (_raw, first) => ['game', 'query', 'steam', 'rcon'].map((name, i) => ({ name, hostPort: first + i * 100, protocol: 'udp' as const })),
    allocatePort: async () => nextPort++,
    cases: async () => (opts.cases ?? [{ id: 'palworld', name: 'Palworld', eggId: 'palworld' }]).map((c) => ({ ...c, variables: {}, ready: 'stays-running' as const })),
    sleep: async (ms) => {
      sleepHook.fn?.();
      await new Promise((r) => setTimeout(r, Math.min(ms, 50)));
    },
    pollMs: 50,
    settleMs: opts.settleMs ?? 200,
  });
  const ctx = { dir, registry, driver, tester, files, failures, sleepHook };
  open.push(ctx);
  return ctx;
}

afterEach(async () => {
  for (const c of open.splice(0)) {
    await c.tester.whenDone();
    c.registry.close();
    await fs.rm(c.dir, { recursive: true, force: true });
  }
});

const report = async (t: Tester) => (await t.report()) as any;

async function waitDone(t: Tester): Promise<void> {
  await t.whenDone();
}

describe('Spiele-Testlauf', () => {
  it('Erfolg: installiert, startet, wartet, stoppt und räumt auf; Bericht in JSON, Markdown und Log', async () => {
    const c = await setup();
    const res = await c.tester.start({ mode: 'fresh', ramMb: 4096 });
    expect(res.mode).toBe('fresh');
    expect(c.tester.isRunning()).toBe(true);
    await waitDone(c.tester);

    const r = await report(c.tester);
    expect(r.isRunning).toBe(false);
    expect(r.status).toBe('done');
    expect(r.jsonReport).toMatchObject({ total: 1, success: 1, failed: 0 });
    expect(r.jsonReport.results[0]).toMatchObject({ eggId: 'palworld', eggName: 'Palworld', status: 'SUCCESS', errorSummary: null });
    expect(r.jsonReport.results[0].runtimeDurationSec).toBeGreaterThanOrEqual(0);
    expect(r.markdownReport).toContain('| Palworld | OK |');
    expect(r.logTail).toContain('Palworld: SUCCESS');
    // Aufgeräumt: kein Testserver, kein Ordner
    expect(c.registry.list().filter((s) => s.id.startsWith('selftest-'))).toEqual([]);
    expect(await fs.readdir(path.join(c.dir, 'servers'))).toEqual([]);
    for (const f of ['game-install-results.json', 'game-install-results.md', 'test-games.log', 'state.json']) {
      expect((await fs.stat(path.join(c.dir, 'test-reports', f))).isFile()).toBe(true);
    }
  });

  it('Installation scheitert: INSTALL_FAILED mit Meldung und Auszug, trotzdem aufgeräumt', async () => {
    const c = await setup();
    c.failures.push('No subscription');
    await c.tester.start({ mode: 'fresh' });
    await waitDone(c.tester);
    const item = (await report(c.tester)).jsonReport.results[0];
    expect(item.status).toBe('INSTALL_FAILED');
    expect(item.errorSummary).toMatch(/No subscription/);
    expect(item.logExcerpt).toContain('Installation');
    expect(c.registry.list()).toEqual([]);
    expect(await fs.readdir(path.join(c.dir, 'servers'))).toEqual([]);
  });

  it('fehlt das Programm nach der Installation, ist das ein Installationsfehler', async () => {
    const c = await setup();
    for (const k of Object.keys(c.files)) delete c.files[k];
    await c.tester.start({ mode: 'fresh' });
    await waitDone(c.tester);
    expect((await report(c.tester)).jsonReport.results[0]).toMatchObject({ status: 'INSTALL_FAILED' });
  });

  it('Absturz beim Start: START_CRASHED', async () => {
    const c = await setup({ settleMs: 60_000 });
    c.sleepHook.fn = () => {
      const entry = (c.driver as any).instances.get('selftest-palworld');
      if (entry?.state.status === 'running') {
        for (const t of entry.timers) clearTimeout(t);
        entry.state.status = 'error';
        entry.state.exitCode = 3;
      }
    };
    await c.tester.start({ mode: 'fresh' });
    await waitDone(c.tester);
    const item = (await report(c.tester)).jsonReport.results[0];
    expect(item.status).toBe('START_CRASHED');
    expect(item.errorSummary).toMatch(/Code 3/);
    expect(c.registry.list()).toEqual([]);
  });

  it('Zeitüberschreitung: TIMEOUT, wenn das Spiel nie bereit wird', async () => {
    const c = await setup({ settleMs: 600_000 });
    await c.tester.start({ mode: 'fresh', timeout: 0.03 });
    await waitDone(c.tester);
    expect((await report(c.tester)).jsonReport.results[0]).toMatchObject({ status: 'TIMEOUT', errorSummary: expect.stringMatching(/nicht bereit/) });
    expect(c.registry.list()).toEqual([]);
  });

  it('Modi: resume überspringt Fertiges, retry-failed wiederholt nur Gescheitertes, fresh macht alles neu', async () => {
    const c = await setup({ cases: [{ id: 'palworld', name: 'Palworld', eggId: 'palworld' }, { id: 'enshrouded', name: 'Enshrouded', eggId: 'enshrouded' }] });
    c.failures.push('No subscription'); // das erste Spiel scheitert (dauerhafter Fehler: kein zweiter Versuch)
    await c.tester.start({ mode: 'fresh' });
    await waitDone(c.tester);
    let r = await report(c.tester);
    expect(r.jsonReport.results.map((x: any) => [x.eggId, x.status])).toEqual([['palworld', 'INSTALL_FAILED'], ['enshrouded', 'SUCCESS']]);
    const firstTime = r.jsonReport.results[1].testedAt;

    // resume: beide haben schon ein Ergebnis -> nichts zu tun
    await c.tester.start({ mode: 'resume' });
    await waitDone(c.tester);
    r = await report(c.tester);
    expect(r.jsonReport.results[1].testedAt).toBe(firstTime);
    expect(r.jsonReport.results[0].status).toBe('INSTALL_FAILED');

    // retry-failed: nur das gescheiterte, jetzt klappt es
    await c.tester.start({ mode: 'retry-failed' });
    await waitDone(c.tester);
    r = await report(c.tester);
    expect(r.jsonReport.results.map((x: any) => x.status)).toEqual(['SUCCESS', 'SUCCESS']);
    expect(r.jsonReport.results[1].testedAt).toBe(firstTime);

    // only: nur ein Spiel
    await c.tester.start({ mode: 'fresh', only: 'enshrouded' });
    await waitDone(c.tester);
    r = await report(c.tester);
    expect(r.jsonReport.results).toHaveLength(1);
    expect(r.jsonReport.results[0].eggId).toBe('enshrouded');
  });

  it('Fehlerfälle beim Starten: läuft schon, kein Windows-Treiber, unbekanntes Spiel', async () => {
    const c = await setup();
    await c.tester.start({ mode: 'fresh' });
    await expect(c.tester.start({ mode: 'fresh' })).rejects.toMatchObject({ statusCode: 409 });
    await waitDone(c.tester);
    await expect(c.tester.start({ only: 'gibt-es-nicht' })).rejects.toBeInstanceOf(TesterError);

    const noInstall = await setup({ installs: false });
    await expect(noInstall.tester.start()).rejects.toMatchObject({ statusCode: 409, code: 'not_supported' });
  });

  it('Anhalten: das laufende Spiel wird fertig, die übrigen entfallen', async () => {
    const c = await setup({ cases: [{ id: 'palworld', name: 'Palworld', eggId: 'palworld' }, { id: 'enshrouded', name: 'Enshrouded', eggId: 'enshrouded' }] });
    c.sleepHook.fn = () => {
      if (!c.tester['stopRequested']) void c.tester.stop();
    };
    await c.tester.start({ mode: 'fresh' });
    await waitDone(c.tester);
    const r = await report(c.tester);
    expect(r.status).toBe('stopped');
    expect(r.jsonReport.results.length).toBeLessThan(2);
    expect(c.registry.list()).toEqual([]);
    expect(r.logTail).toContain('Anhalten angefordert');
  });

  it('Reste eines abgebrochenen Laufs werden beim Start entfernt, fremde Server nie', async () => {
    const c = await setup();
    const leftover = path.join(c.dir, 'servers', 'selftest-alt');
    const mine = path.join(c.dir, 'servers', 'mein-server');
    await fs.mkdir(leftover, { recursive: true });
    await fs.mkdir(mine, { recursive: true });
    await fs.writeFile(path.join(mine, 'welt.dat'), 'wichtig');
    for (const [id, wd] of [['selftest-alt', leftover], ['mein-server', mine]] as const) {
      const config = { id, name: id, game: 'x', executable: 'x', args: [], workingDir: wd, ports: [] };
      await c.registry.add(config);
      await c.driver.registerServer(config);
    }
    await c.tester.start({ mode: 'fresh' });
    await waitDone(c.tester);
    expect(c.registry.get('selftest-alt')).toBeUndefined();
    await expect(fs.stat(leftover)).rejects.toThrow();
    expect(c.registry.get('mein-server')).toBeDefined();
    expect(await fs.readFile(path.join(mine, 'welt.dat'), 'utf8')).toBe('wichtig');
  });

  it('ein früher unterbrochener Lauf erscheint als "interrupted"', async () => {
    const c = await setup();
    await fs.mkdir(path.join(c.dir, 'test-reports'), { recursive: true });
    await fs.writeFile(path.join(c.dir, 'test-reports', 'state.json'), JSON.stringify({ status: 'running', startedAt: '2026-11-11T20:00:00Z', mode: 'fresh', currentEgg: 'Palworld', currentEggIndex: 1, totalEggs: 3, cpuPercent: null, ramMb: null }));
    const r = await report(c.tester);
    expect(r).toMatchObject({ isRunning: false, status: 'interrupted', totalEggs: 3 });
  });
});

describe('Testlauf-Routen', () => {
  it('Bericht lesbar, Funktion gemeldet; ohne Windows-Treiber lehnt der Start ehrlich ab', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-gt-routes-'));
    const registry = await ServerRegistry.open(dir);
    const driver = new MockDriver();
    await driver.initialize();
    const server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
    try {
      const json = { 'content-type': 'application/json' };
      const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
      const auth = { authorization: `Bearer ${login.json().accessToken}` };
      expect((await server.inject({ method: 'GET', url: '/api/v1/about', headers: auth })).json().features).toContain('testreport');

      const rep = await server.inject({ method: 'GET', url: '/api/v1/admin/test-report', headers: auth });
      expect(rep.statusCode).toBe(200);
      expect(rep.json()).toMatchObject({ isRunning: false, status: 'idle', jsonReport: null, markdownReport: null });

      const start = await server.inject({ method: 'POST', url: '/api/v1/admin/test-games', headers: { ...auth, ...json }, payload: { mode: 'resume', ramMb: 4096, timeout: 20, cpuPercent: 100 } });
      expect(start.statusCode).toBe(409);
      expect(start.json().code).toBe('not_supported');
      expect((await server.inject({ method: 'POST', url: '/api/v1/admin/test-games', headers: { ...auth, ...json }, payload: { ramMb: 10 } })).statusCode).toBe(400);
      expect((await server.inject({ method: 'POST', url: '/api/v1/admin/test-games/stop', headers: auth })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/api/v1/admin/test-report' })).statusCode).toBe(401);
    } finally {
      await server.close();
      registry.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
