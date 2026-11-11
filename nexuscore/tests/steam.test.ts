import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { InstallManager, installPlanFor } = await import('../src/install/manager.js');
const { ensureSteamCmd, installSteamApp, readBuildId } = await import('../src/install/steamcmd.js');
const { patchJsonFile, patchUnrealOptions, splitOptions, steamValues, resolveArgs, prepareSteamStart } = await import('../src/install/steam-game.js');
const { createZip } = await import('../src/files/archive.js');
const { loadEggs } = await import('../src/eggs/loader.js');
const { createPowerOps } = await import('../src/ops/power.js');

type SteamRunner = import('../src/install/steamcmd.js').SteamRunner;

let tmp: string;
let n = 0;
const fresh = async () => {
  const d = path.join(tmp, `t${++n}`);
  await fs.mkdir(d, { recursive: true });
  return d;
};

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-steam-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Ein steamcmd.zip, das nur eine (leere) steamcmd.exe enthält. */
async function fakeSteamZip(): Promise<Buffer> {
  const src = await fresh();
  await fs.writeFile(path.join(src, 'steamcmd.exe'), 'MZ-fake');
  await createZip(src, ['steamcmd.exe'], 'steamcmd.zip');
  return fs.readFile(path.join(src, 'steamcmd.zip'));
}

const zipFetch = (zip: Buffer, calls: string[] = []) =>
  (async (url: string) => {
    calls.push(url);
    return new Response(new Uint8Array(zip), { status: 200, headers: { 'content-length': String(zip.length) } });
  }) as import('../src/install/download.js').FetchLike;

/** Ein "SteamCMD", das Zeilen wie das echte ausgibt und das Spiel samt Manifest anlegt. */
function fakeApp(opts: { files?: Record<string, string>; fail?: string[]; build?: string } = {}): { runner: SteamRunner; runs: string[][] } {
  const runs: string[][] = [];
  const runner: SteamRunner = async (_exe, args, hooks) => {
    runs.push(args);
    const failure = opts.fail?.shift();
    if (failure !== undefined) {
      hooks.onLine(`ERROR! Failed to install app '1' (${failure})`);
      return 8;
    }
    const dir = args[args.indexOf('+force_install_dir') + 1]!;
    const appId = args[args.indexOf('+app_update') + 1]!;
    hooks.onLine('Update state (0x61) downloading, progress: 10.00 (100 / 1000)');
    hooks.onLine('Update state (0x61) downloading, progress: 55.50 (555 / 1000)');
    hooks.onLine('Update state (0x81) verifying update, progress: 50.00 (500 / 1000)');
    for (const [file, content] of Object.entries(opts.files ?? {})) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), content);
    }
    await fs.mkdir(path.join(dir, 'steamapps'), { recursive: true });
    await fs.writeFile(path.join(dir, 'steamapps', `appmanifest_${appId}.acf`), `"AppState"\n{\n\t"appid"\t"${appId}"\n\t"buildid"\t"${opts.build ?? '1234567'}"\n}\n`);
    hooks.onLine(`Success! App '${appId}' fully installed.`);
    return 0;
  };
  return { runner, runs };
}

describe('SteamCMD einrichten', () => {
  it('lädt, entpackt, startet einmal und merkt sich die Prüfsumme; beim zweiten Mal nichts mehr', async () => {
    const dir = await fresh();
    const zip = await fakeSteamZip();
    const calls: string[] = [];
    const ran: string[][] = [];
    const exe = await ensureSteamCmd({
      runtimesDir: dir,
      platform: 'win32',
      fetchImpl: zipFetch(zip, calls),
      runner: async (_e, args) => (ran.push(args), 0),
    });
    expect(exe).toBe(path.join(dir, 'steamcmd', 'steamcmd.exe'));
    expect(calls).toEqual(['https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip']);
    expect(ran).toEqual([['+quit']]);
    const marker = JSON.parse(await fs.readFile(path.join(dir, 'steamcmd', 'nexuscore.json'), 'utf8'));
    expect(marker.sha256).toBe(crypto.createHash('sha256').update(zip).digest('hex'));
    // zweites Mal: nichts laden, nichts starten
    await ensureSteamCmd({ runtimesDir: dir, platform: 'win32', fetchImpl: zipFetch(zip, calls), runner: async (_e, a) => (ran.push(a), 0) });
    expect(calls).toHaveLength(1);
    expect(ran).toHaveLength(1);
    expect(await fs.readdir(dir)).toEqual(['steamcmd']); // keine Download-Reste
  });

  it('wiederholt den Selbst-Update-Lauf bei Code 7 und gibt danach auf', async () => {
    const zip = await fakeSteamZip();
    let attempts = 0;
    const exe = await ensureSteamCmd({ runtimesDir: await fresh(), platform: 'win32', fetchImpl: zipFetch(zip), runner: async () => (++attempts < 3 ? 7 : 0) });
    expect(attempts).toBe(3);
    expect(exe).toMatch(/steamcmd\.exe$/);
    attempts = 0;
    await expect(ensureSteamCmd({ runtimesDir: await fresh(), platform: 'win32', fetchImpl: zipFetch(zip), runner: async () => (attempts++, 7) })).rejects.toThrow(/Code 7/);
    expect(attempts).toBe(3);
  });

  it('erzwingt eine vorgegebene Prüfsumme', async () => {
    const zip = await fakeSteamZip();
    const dir = await fresh();
    await expect(ensureSteamCmd({ runtimesDir: dir, platform: 'win32', fetchImpl: zipFetch(zip), runner: async () => 0, expectedSha256: 'a'.repeat(64) })).rejects.toThrow(/Pruefsumme/);
    await expect(fs.stat(path.join(dir, 'steamcmd', 'nexuscore.json'))).rejects.toThrow();
    const good = crypto.createHash('sha256').update(zip).digest('hex');
    await expect(ensureSteamCmd({ runtimesDir: await fresh(), platform: 'win32', fetchImpl: zipFetch(zip), runner: async () => 0, expectedSha256: good })).resolves.toMatch(/steamcmd\.exe$/);
  });

  it('nur unter Windows', async () => {
    await expect(ensureSteamCmd({ runtimesDir: await fresh(), platform: 'linux' })).rejects.toThrow(/Windows/);
  });

  it('ein Paket ohne steamcmd.exe wird abgelehnt', async () => {
    const src = await fresh();
    await fs.writeFile(path.join(src, 'anderes.txt'), 'x');
    await createZip(src, ['anderes.txt'], 'x.zip');
    const zip = await fs.readFile(path.join(src, 'x.zip'));
    await expect(ensureSteamCmd({ runtimesDir: await fresh(), platform: 'win32', fetchImpl: zipFetch(zip), runner: async () => 0 })).rejects.toThrow(/steamcmd\.exe/);
  });
});

describe('Spiel laden', () => {
  it('Befehlszeile, Fortschritt und Build-Nummer', async () => {
    const dir = await fresh();
    const { runner, runs } = fakeApp({ build: '99' });
    const progress: Array<[number, string]> = [];
    const res = await installSteamApp({ exe: 'steamcmd.exe', installDir: dir, appId: 2394010, runner, onProgress: (f, m) => progress.push([f, m]) });
    expect(res.buildId).toBe('99');
    expect(runs[0]).toEqual(['+force_install_dir', dir, '+login', 'anonymous', '+app_update', '2394010', 'validate', '+quit']);
    expect(progress.map(([, m]) => m)).toEqual(expect.arrayContaining(['Lade Spieldateien: 10 %', 'Lade Spieldateien: 55 %', 'Prüfe Spieldateien: 50 %', 'Spieldateien installiert']));
    const fractions = progress.map(([f]) => f);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions); // nie rückwärts
    expect(Math.min(...fractions)).toBeGreaterThanOrEqual(0.1);
    expect(Math.max(...fractions)).toBeLessThanOrEqual(0.95);
  });

  it('Beta-Zweig wird übergeben, "public" nicht', async () => {
    const a = fakeApp();
    await installSteamApp({ exe: 'x', installDir: await fresh(), appId: 5, branch: 'experimental', runner: a.runner });
    expect(a.runs[0]).toContain('-beta');
    expect(a.runs[0]).toContain('experimental');
    const b = fakeApp();
    await installSteamApp({ exe: 'x', installDir: await fresh(), appId: 5, branch: 'public', runner: b.runner });
    expect(b.runs[0]).not.toContain('-beta');
  });

  it('wiederholt bei Zufallsfehlern, nicht bei dauerhaften', async () => {
    const flaky = fakeApp({ fail: ['Missing configuration', 'Timeout'] });
    await expect(installSteamApp({ exe: 'x', installDir: await fresh(), appId: 5, runner: flaky.runner })).resolves.toBeDefined();
    expect(flaky.runs).toHaveLength(3);

    const permanent = fakeApp({ fail: ['No subscription', 'No subscription'] });
    await expect(installSteamApp({ exe: 'x', installDir: await fresh(), appId: 5, runner: permanent.runner })).rejects.toThrow(/No subscription/);
    expect(permanent.runs).toHaveLength(1);

    const always = fakeApp({ fail: ['Timeout', 'Timeout', 'Timeout', 'Timeout'] });
    await expect(installSteamApp({ exe: 'x', installDir: await fresh(), appId: 5, runner: always.runner, retries: 1 })).rejects.toThrow(/Timeout/);
    expect(always.runs).toHaveLength(2);
  });

  it('ohne Erfolgsmeldung gilt es als Fehler, auch bei Code 0', async () => {
    const runner: SteamRunner = async () => 0;
    await expect(installSteamApp({ exe: 'x', installDir: await fresh(), appId: 5, runner, retries: 0 })).rejects.toThrow(/ohne Erfolgsmeldung/);
  });

  it('prüft App-ID und Ordner', async () => {
    const { runner } = fakeApp();
    await expect(installSteamApp({ exe: 'x', installDir: await fresh(), appId: 0, runner })).rejects.toThrow(/App-ID/);
    await expect(installSteamApp({ exe: 'x', installDir: await fresh(), appId: 1.5, runner })).rejects.toThrow(/App-ID/);
    await expect(installSteamApp({ exe: 'x', installDir: 'C:/a" +quit "b', appId: 5, runner })).rejects.toThrow(/Installationsordner/);
    expect(await readBuildId(await fresh(), 5)).toBeNull();
  });
});

describe('Konfigurationsdateien', () => {
  const values = { SERVER_NAME: 'Mein "Server"', SERVER_SLOTS: '8', PORT_GAME: '28001', PASSWORD: '', FLAG: 'ja' };

  it('JSON: setzt Schlüssel, behält andere, Zahlen und Wahrheitswerte, verschachtelt', () => {
    const out = JSON.parse(
      patchJsonFile(
        JSON.stringify({ name: 'alt', behalten: 1, tief: { auch: true } }),
        { name: '{{SERVER_NAME}}', slotCount: { $number: '{{SERVER_SLOTS}}' }, 'tief.neu': { $boolean: '{{FLAG}}' }, gamePort: { $number: '{{PORT_GAME}}' } },
        values,
      ),
    );
    expect(out).toEqual({ name: 'Mein "Server"', behalten: 1, slotCount: 8, gamePort: 28001, tief: { auch: true, neu: true } });
  });

  it('JSON: kaputte Datei wird neu angelegt, keine Zahl ist ein Fehler, Prototyp-Schlüssel wirken nicht', () => {
    expect(JSON.parse(patchJsonFile('{kaputt', { a: '1' }, values))).toEqual({ a: '1' });
    expect(() => patchJsonFile(null, { a: { $number: '{{PASSWORD}}' } }, values)).toThrow(/Zahl/);
    patchJsonFile(null, { '__proto__.polluted': 'x', 'constructor.prototype.polluted': 'x' }, values);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('Unreal-Optionen: legt Abschnitt an, ändert nur genannte, behält Kommas in Texten', () => {
    const fresh1 = patchUnrealOptions(null, '/Script/Pal.PalGameWorldSettings', 'OptionSettings', { ServerName: '"{{SERVER_NAME}}"', ServerPlayerMaxNum: '{{SERVER_SLOTS}}', PublicPort: '{{PORT_GAME}}' }, { ...values, SERVER_NAME: 'A, B' });
    expect(fresh1).toBe('[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(ServerName="A, B",ServerPlayerMaxNum=8,PublicPort=28001)\n');

    const existing = '; Kommentar\r\n[/Script/Pal.PalGameWorldSettings]\r\nOptionSettings=(Difficulty=None,ServerName="alt, mit Komma",ExpRate=2.000000,Nested=(a=1,b=2))\r\n[Anderes]\r\nx=1\r\n';
    const out = patchUnrealOptions(existing, '/Script/Pal.PalGameWorldSettings', 'OptionSettings', { ServerName: '"neu"', RCONPort: '{{PORT_GAME}}' }, values);
    expect(out).toBe('; Kommentar\r\n[/Script/Pal.PalGameWorldSettings]\r\nOptionSettings=(Difficulty=None,ServerName="neu",ExpRate=2.000000,Nested=(a=1,b=2),RCONPort=28001)\r\n[Anderes]\r\nx=1\r\n');
    expect(splitOptions('A=1,B="x,y",C=(D=1,E=(F=2,G=3)),H=z')).toEqual([['A', '1'], ['B', '"x,y"'], ['C', '(D=1,E=(F=2,G=3))'], ['H', 'z']]);
  });

  it('Werte: Ports aus den Zuteilungen, beide Schreibweisen; leere Argumente fallen weg', () => {
    const v = steamValues({ name: 'S', maxMemoryMb: 4096, ports: [{ name: 'game', hostPort: 28001, protocol: 'udp' }, { name: 'rcon', hostPort: 28003, protocol: 'tcp' }] }, { max_players: '16' });
    expect(v).toMatchObject({ PORT_GAME: '28001', GAME_PORT: '28001', PORT_RCON: '28003', RCON_PORT: '28003', SERVER_PORT: '28001', MAX_PLAYERS: '16', MAX_MEMORY_MB: '4096', SERVER_NAME: 'S' });
    expect(resolveArgs(['-port={{PORT_GAME}}', '{{NICHT_DA}}', '-x'], v)).toEqual(['-port=28001', '-x']);
  });
});

describe('Egg-Angaben', () => {
  it('Palworld und Enshrouded haben einen windows-Block, der Plan wird daraus gebaut', async () => {
    const eggs = await loadEggs();
    const pal = eggs.find((e) => e.id === 'palworld')!;
    const plan = installPlanFor('palworld', pal.raw, {});
    expect(plan).toMatchObject({ kind: 'steamcmd', steam: { appId: 2394010, executable: 'PalServer.exe' } });
    expect(plan!.steam!.files![0]!.set['ServerName']).toBe('"{{SERVER_NAME}}"');
    expect(installPlanFor('enshrouded', eggs.find((e) => e.id === 'enshrouded')!.raw, {})).toMatchObject({ kind: 'steamcmd', steam: { appId: 2278520 } });
    expect(installPlanFor('minecraft-paper', undefined, {})).toEqual({ kind: 'minecraft-paper' });
    expect(installPlanFor('rust', eggs.find((e) => e.id === 'rust')!.raw, {})).toBeNull(); // noch kein windows-Block
  });
});

describe('Installation über den ganzen Core', () => {
  let server: Awaited<ReturnType<typeof createCoreServer>>;
  let registry: InstanceType<typeof ServerRegistry>;
  let driver: InstanceType<typeof MockDriver>;
  let installs: InstanceType<typeof InstallManager>;
  let dataDir: string;
  let headers: Record<string, string>;
  const app = fakeApp({ files: { 'PalServer.exe': 'MZ', 'enshrouded_server.exe': 'MZ' } });

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-steam-core-'));
    registry = await ServerRegistry.open(dataDir);
    driver = new MockDriver();
    await driver.initialize();
    const bus = new EventBus();
    installs = new InstallManager(registry, driver, bus, { runtimesDir: path.join(dataDir, 'runtimes'), steamRunner: app.runner, steamExe: 'C:/fake/steamcmd.exe' });
    server = await createCoreServer(driver, bus, registry, { installs });
    const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
    headers = { authorization: `Bearer ${login.json().accessToken}`, 'content-type': 'application/json' };
  });
  afterAll(async () => {
    await server.close();
    registry.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('Palworld: Ports aus dem Egg, Installation, Einstellungen geschrieben, Startargumente gesetzt', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/servers', headers, payload: { name: 'Pal Test', eggId: 'palworld', ramMb: 8192, variables: { SERVER_NAME: 'Mein Pal', MAX_PLAYERS: '12' } } });
    expect(res.statusCode).toBe(201);
    const id = res.json().server.id as string;
    await installs.whenIdle(id);

    const c = registry.get(id)!;
    expect(c.install).toMatchObject({ state: 'done', kind: 'steamcmd', version: '1234567' });
    // game, query und rcon: drei verschiedene Ports aus dem Bereich des Cores
    expect(c.ports.map((p) => p.name)).toEqual(['game', 'query', 'rcon']);
    expect(new Set(c.ports.map((p) => p.hostPort)).size).toBe(3);
    expect(c.ports[0]!.protocol).toBe('udp');
    const game = c.ports[0]!.hostPort;
    expect(c.executable).toBe(path.join(c.workingDir, 'PalServer.exe'));
    expect(c.args).toEqual([`-port=${game}`, `-publicport=${game}`, '-players=12', '-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS']);
    expect(c.stopTimeoutSeconds).toBe(60);

    const ini = await fs.readFile(path.join(c.workingDir, 'Pal/Saved/Config/WindowsServer/PalWorldSettings.ini'), 'utf8');
    expect(ini).toContain('[/Script/Pal.PalGameWorldSettings]');
    expect(ini).toContain('ServerName="Mein Pal"');
    expect(ini).toContain('ServerPlayerMaxNum=12');
    expect(ini).toContain(`PublicPort=${game}`);
    expect(ini).toContain(`RCONPort=${c.ports[2]!.hostPort}`);

    const task = registry.listTasks({ serverId: id })[0]!;
    expect(task).toMatchObject({ status: 'done', progress: 1 });
    expect(registry.recentAudit({ serverId: id }).some((a) => a.action === 'server.install')).toBe(true);
  });

  it('Start: Einstellungen und Argumente werden aus den jetzigen Werten neu gebaut', async () => {
    const id = registry.list().find((s) => s.game === 'palworld')!.id;
    const before = registry.get(id)!;
    // Wunsch geändert: Spielername und Port
    await registry.update({ ...before, ports: before.ports.map((p) => (p.name === 'game' ? { ...p, hostPort: 29999 } : p)), install: { ...before.install!, variables: { ...before.install!.variables, SERVER_NAME: 'Neuer Name', MAX_PLAYERS: '4' } } });
    const power = createPowerOps({ registry, driver });
    await power.start(id);
    const after = registry.get(id)!;
    expect(after.args).toContain('-port=29999');
    expect(after.args).toContain('-players=4');
    const ini = await fs.readFile(path.join(after.workingDir, 'Pal/Saved/Config/WindowsServer/PalWorldSettings.ini'), 'utf8');
    expect(ini).toContain('ServerName="Neuer Name"');
    expect(ini).toContain('PublicPort=29999');
    // Direkt aufrufbar: liefert dasselbe
    expect(await prepareSteamStart(after)).toEqual(after.args);
  });

  it('Enshrouded: JSON-Datei mit Zahlen; eigene Konfiguration (EXTERNAL_CONFIG=1) bleibt unangetastet', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/servers', headers, payload: { name: 'Ens Test', eggId: 'enshrouded', variables: { SERVER_NAME: 'Ens', SERVER_SLOTS: '8' } } });
    const id = res.json().server.id as string;
    await installs.whenIdle(id);
    const c = registry.get(id)!;
    const json = JSON.parse(await fs.readFile(path.join(c.workingDir, 'enshrouded_server.json'), 'utf8'));
    expect(json).toMatchObject({ name: 'Ens', slotCount: 8, gamePort: c.ports[0]!.hostPort, queryPort: c.ports[1]!.hostPort, ip: '0.0.0.0' });
    expect(typeof json.gamePort).toBe('number');

    await fs.writeFile(path.join(c.workingDir, 'enshrouded_server.json'), '{"eigene":"Einstellung"}');
    await registry.update({ ...c, install: { ...c.install!, variables: { ...c.install!.variables, EXTERNAL_CONFIG: '1' } } });
    await createPowerOps({ registry, driver }).start(id);
    expect(await fs.readFile(path.join(c.workingDir, 'enshrouded_server.json'), 'utf8')).toBe('{"eigene":"Einstellung"}');
  });

  it('Neuinstallation läuft über dieselben Angaben, Welt und Einstellungen bleiben', async () => {
    const id = registry.list().find((s) => s.game === 'palworld')!.id;
    const c = registry.get(id)!;
    await fs.mkdir(path.join(c.workingDir, 'Pal/Saved/SaveGames'), { recursive: true });
    await fs.writeFile(path.join(c.workingDir, 'Pal/Saved/SaveGames/welt.sav'), 'meine welt');
    await driver.stopServer(id).catch(() => {});
    const entry = (driver as any).instances.get(id);
    for (const t of entry.timers) clearTimeout(t);
    entry.state.status = 'offline';
    const res = await server.inject({ method: 'POST', url: `/api/v1/servers/${id}/reinstall`, headers: { authorization: headers.authorization! } });
    expect(res.statusCode, res.body).toBe(200);
    await installs.whenIdle(id);
    expect(registry.get(id)!.install).toMatchObject({ state: 'done', kind: 'steamcmd' });
    expect(registry.get(id)!.install!.steam!.appId).toBe(2394010);
    expect(await fs.readFile(path.join(c.workingDir, 'Pal/Saved/SaveGames/welt.sav'), 'utf8')).toBe('meine welt');
  });

  it('Fehlschlag: Server steht auf "install_failed", die Angaben bleiben fürs Wiederholen', async () => {
    const failing = fakeApp({ fail: ['No subscription'] });
    const registry2 = registry;
    const m = new InstallManager(registry2, driver, new EventBus(), { runtimesDir: path.join(dataDir, 'runtimes'), steamRunner: failing.runner, steamExe: 'C:/fake/steamcmd.exe' });
    const dir = path.join(dataDir, 'servers', 'fehl-1');
    await fs.mkdir(dir, { recursive: true });
    const plan = installPlanFor('palworld', (await loadEggs()).find((e) => e.id === 'palworld')!.raw, {})!;
    await registry.add({ id: 'fehl-1', name: 'Fehl', game: 'palworld', executable: '', args: [], workingDir: dir, ports: [{ name: 'game', hostPort: 28500, protocol: 'udp' }], install: { state: 'installing', kind: 'steamcmd', steam: plan.steam!, variables: {}, propertiesTemplate: {} } });
    m.start('fehl-1', { kind: 'steamcmd', steam: plan.steam!, variables: {}, propertiesTemplate: {} });
    await m.whenIdle('fehl-1');
    const c = registry.get('fehl-1')!;
    expect(c.install).toMatchObject({ state: 'failed', kind: 'steamcmd', error: expect.stringMatching(/No subscription/) });
    expect(c.install!.steam!.appId).toBe(2394010);
    // Starten ist gesperrt
    await expect(createPowerOps({ registry, driver }).start('fehl-1')).rejects.toThrow(/fehlgeschlagen/);
  });

  it('fehlt das Programm nach der Installation, ist das ein klarer Fehler', async () => {
    const nothing = fakeApp({ files: {} });
    const m = new InstallManager(registry, driver, new EventBus(), { runtimesDir: path.join(dataDir, 'runtimes'), steamRunner: nothing.runner, steamExe: 'C:/fake/steamcmd.exe' });
    const dir = path.join(dataDir, 'servers', 'leer-1');
    await fs.mkdir(dir, { recursive: true });
    const plan = installPlanFor('palworld', (await loadEggs()).find((e) => e.id === 'palworld')!.raw, {})!;
    await registry.add({ id: 'leer-1', name: 'Leer', game: 'palworld', executable: '', args: [], workingDir: dir, ports: [{ name: 'game', hostPort: 28501, protocol: 'udp' }], install: { state: 'installing', kind: 'steamcmd', steam: plan.steam!, variables: {}, propertiesTemplate: {} } });
    m.start('leer-1', { kind: 'steamcmd', steam: plan.steam!, variables: {}, propertiesTemplate: {} });
    await m.whenIdle('leer-1');
    expect(registry.get('leer-1')!.install).toMatchObject({ state: 'failed', error: expect.stringMatching(/PalServer\.exe/) });
  });
});

describe('Unreal-Optionen ohne Wert', () => {
  it('leere Werte werden nicht geschrieben, vorhandene bleiben', () => {
    const out = patchUnrealOptions('[S]\nOptionSettings=(A=1,B=2)\n', 'S', 'OptionSettings', { A: '{{FEHLT}}', C: '{{FEHLT}}', D: '4' }, {});
    expect(out).toBe('[S]\nOptionSettings=(A=1,B=2,D=4)\n');
  });
});

describe('Fortschritt aus dem Manifest', () => {
  it('zeigt den Fortschritt, auch wenn SteamCMD erst am Ende schreibt', async () => {
    const dir = await fresh();
    const runner: SteamRunner = async (_exe, args, hooks) => {
      const d = args[args.indexOf('+force_install_dir') + 1]!;
      await fs.mkdir(path.join(d, 'steamapps'), { recursive: true });
      const acf = path.join(d, 'steamapps', 'appmanifest_7.acf');
      for (const done of [100, 500, 900]) {
        await fs.writeFile(acf, `"AppState"\n{\n\t"BytesToDownload"\t"1000"\n\t"BytesDownloaded"\t"${done}"\n}\n`);
        await new Promise((r) => setTimeout(r, 60));
      }
      await fs.writeFile(acf, '"AppState"\n{\n\t"buildid"\t"5"\n}\n');
      hooks.onLine("Success! App '7' fully installed.");
      return 0;
    };
    const seen: Array<[number, string]> = [];
    await installSteamApp({ exe: 'x', installDir: dir, appId: 7, runner, pollMs: 20, onProgress: (f, m) => seen.push([f, m]) });
    const loading = seen.filter(([, m]) => /Lade Spieldateien/.test(m));
    expect(loading.length).toBeGreaterThanOrEqual(2);
    expect(loading.some(([, m]) => m.includes('50 %'))).toBe(true);
    const fractions = seen.map(([f]) => f);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
  });
});

describe('Alte leere Optionen', () => {
  it('Reste wie "Name=," aus früheren Ständen werden entfernt', () => {
    const out = patchUnrealOptions('[S]\nOptionSettings=(A=1,Leer=,B=2)\n', 'S', 'OptionSettings', { C: '3' }, {});
    expect(out).toBe('[S]\nOptionSettings=(A=1,B=2,C=3)\n');
  });
});
