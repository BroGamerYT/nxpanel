import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { DockerDriver } = await import('../src/drivers/docker-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { InstallManager } = await import('../src/install/manager.js');
const { GameTester } = await import('../src/testing/game-tester.js');
const { createPowerOps } = await import('../src/ops/power.js');
const { loadEggs } = await import('../src/eggs/loader.js');
const { initialValue } = await import('../src/eggs/rules.js');
const { FakeDocker } = await import('./helpers/fake-docker.js');

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let docker: InstanceType<typeof FakeDocker>;
let driver: InstanceType<typeof DockerDriver>;
let tester: InstanceType<typeof GameTester>;
let nextPort = 29000;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-gtdocker-'));
  registry = await ServerRegistry.open(dir);
  docker = new FakeDocker();
  driver = new DockerDriver(docker);
  await driver.initialize();
  const bus = new EventBus();
  const installs = new InstallManager(registry, driver, bus, { runtimesDir: path.join(dir, 'runtimes'), steamRetryDelayMs: 0 });
  tester = new GameTester({
    registry,
    driver,
    bus,
    installs,
    power: createPowerOps({ registry, driver }),
    eggs: loadEggs,
    variablesFor: async (eggId, given) => {
      const egg = (await loadEggs()).find((e) => e.id === eggId);
      const variables: Record<string, string> = {};
      for (const v of egg?.raw.variables ?? []) variables[v.env_variable] = initialValue(v);
      Object.assign(variables, given ?? {});
      return { variables, propertiesTemplate: {} };
    },
    portsFor: async (raw, first) => {
      const spec = (raw ?? {}) as { primary?: { ref?: string; protocol?: string }; secondary?: Array<{ ref?: string; protocol?: string }> };
      return [spec.primary, ...(spec.secondary ?? [])]
        .filter(<T>(p: T | undefined): p is T => Boolean(p))
        .map((p, i) => ({ name: (p.ref ?? `port${i}`).toLowerCase(), hostPort: first + i, protocol: p.protocol === 'tcp' ? ('tcp' as const) : ('udp' as const) }));
    },
    allocatePort: async () => {
      nextPort += 10;
      return nextPort;
    },
    ping: async () => ({ online: true }) as never,
    sleep: async (ms) => void (await new Promise((r) => setTimeout(r, Math.min(ms, 20)))),
    pollMs: 20,
    settleMs: 120,
  });
});
afterAll(async () => {
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

type Row = { eggId: string; status: string; errorSummary: string | null };
const results = async (): Promise<Row[]> => (((await tester.report()).jsonReport as { results?: Row[] } | null)?.results ?? []);
const selftests = () => [...docker.containers.keys()].filter((n) => n.includes('selftest-'));

describe('Spiele-Testlauf mit Docker', () => {
  it('testet jedes Spiel mit Image als Container - nicht nur die Windows-Spiele', async () => {
    const cases = await tester.cases();
    const ids = cases.map((c) => c.id);
    expect(cases.length).toBeGreaterThan(30);
    expect(ids).toEqual(expect.arrayContaining(['minecraft-paper', 'minecraft-vanilla', 'teamspeak6', 'garrys-mod', 'ark-survival-ascended']));
  });

  it('Spiel ohne Installationsskript (TeamSpeak): Container starten, bereit, stoppen, alles wieder weg', async () => {
    await tester.start({ only: 'teamspeak6', mode: 'fresh' });
    await tester.whenDone();
    expect((await results()).find((r) => r.eggId === 'teamspeak6')).toMatchObject({ status: 'SUCCESS' });
    expect(selftests()).toEqual([]);
    expect(registry.list().filter((c) => c.id.startsWith('selftest-'))).toEqual([]);
    expect(docker.created.some((o) => o.name === 'nxc-selftest-teamspeak6' && o.Image === 'teamspeaksystems/teamspeak6-server:latest')).toBe(true);
  });

  it('Spiel mit Installationsskript (Garry\'s Mod): erst der Installer-Container, dann der Start', async () => {
    docker.installer = { lines: ['[installer] fertig'], code: 0 };
    await tester.start({ only: 'the-bus', mode: 'fresh' });
    await tester.whenDone();
    expect((await results()).find((r) => r.eggId === 'the-bus')).toMatchObject({ status: 'SUCCESS' });
    expect(docker.created.some((o) => o.Labels?.['nexuscore.installer'] === 'selftest-the-bus')).toBe(true);
    expect(selftests()).toEqual([]);
  });

  it('ein fehlgeschlagenes Installationsskript steht mit dem Code im Bericht', async () => {
    docker.installer = { lines: ['[installer] Platte voll'], code: 7 };
    await tester.start({ only: 'the-bus', mode: 'fresh' });
    await tester.whenDone();
    const r = (await results()).find((x) => x.eggId === 'the-bus')!;
    expect(r.status).toBe('INSTALL_FAILED');
    expect(r.errorSummary).toContain('Code 7');
    expect(registry.list().filter((c) => c.id.startsWith('selftest-'))).toEqual([]);
  });

  it('Steam lehnt vorübergehend ab (Code 0 trotz Fehler): drei Versuche, dann klare Meldung statt leerem Ordner', async () => {
    docker.installer = { lines: ["ERROR! Failed to install app '4020' (Missing configuration)", 'Installation completed...'], code: 0 };
    const before = docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === 'selftest-the-bus').length;
    await tester.start({ only: 'the-bus', mode: 'fresh' });
    await tester.whenDone();
    const r = (await results()).find((x) => x.eggId === 'the-bus')!;
    expect(r.status).toBe('INSTALL_FAILED');
    expect(r.errorSummary).toContain('Steam konnte App 4020 nicht installieren');
    expect(docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === 'selftest-the-bus').length - before).toBe(3);
  });

  it('ein dauerhafter Steam-Fehler (Invalid platform) wird nicht wiederholt', async () => {
    docker.installer = { lines: ["ERROR! Failed to install app '222860' (Invalid platform)"], code: 0 };
    const before = docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === 'selftest-the-bus').length;
    await tester.start({ only: 'the-bus', mode: 'fresh' });
    await tester.whenDone();
    const r = (await results()).find((x) => x.eggId === 'the-bus')!;
    expect(r.status).toBe('INSTALL_FAILED');
    expect(r.errorSummary).toContain('Invalid platform');
    expect(docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === 'selftest-the-bus').length - before).toBe(1);
  });

  it('Minecraft (Paper/Vanilla): Container mit Typ und Ping als Bereitschaft', async () => {
    // Der Server beendet sich, wenn der Stopp-Befehl auf seiner Konsole ankommt (wie ein echter Minecraft-Server)
    const stopper = setInterval(() => {
      for (const c of docker.containers.values()) if ((c as unknown as { stdinWrites: string[] }).stdinWrites.some((l) => l.startsWith('stop'))) (c as unknown as { exit: (n: number) => void }).exit(0);
    }, 10);
    await tester.start({ only: 'minecraft-vanilla', mode: 'fresh' });
    await tester.whenDone();
    clearInterval(stopper);
    expect((await results()).find((r) => r.eggId === 'minecraft-vanilla')).toMatchObject({ status: 'SUCCESS' });
    const created = docker.created.find((o) => o.name === 'nxc-selftest-minecraft-vanilla')!;
    expect(created.Env).toEqual(expect.arrayContaining(['TYPE=VANILLA', 'EULA=TRUE']));
  });
});

describe('Ungültiges Image', () => {
  it('ein Server ohne Image-Namen scheitert mit klarer Meldung statt den Core zu beenden', async () => {
    await driver.registerServer({ id: 'kein-image', name: 'Kein Image', game: 'x', executable: '', args: [], workingDir: path.join(dir, 'kein-image'), ports: [], container: { image: '', dataDir: '/data' } });
    await expect(driver.startServer('kein-image')).rejects.toThrow(/kein Docker-Image/);
    for (const bad of ['', ' ', 'images', 'UPPER CASE', 'a'.repeat(300)]) {
      await driver.registerServer({ id: `bad-${bad.length}`, name: 'x', game: 'x', executable: '', args: [], workingDir: path.join(dir, 'x'), ports: [], container: { image: bad, dataDir: '/data' } });
      if (bad === 'images') continue; // ein gueltiger Name (Image "images" gibt es halt nicht)
      await expect(driver.startServer(`bad-${bad.length}`)).rejects.toThrow();
    }
  });
});
