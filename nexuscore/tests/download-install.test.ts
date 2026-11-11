import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { resolveSource, pinnedFromEnv, isDownloadSource } = await import('../src/install/sources.js');
const { installDownloadGame } = await import('../src/install/download-game.js');
const { createZip } = await import('../src/files/archive.js');

type Fetch = (url: string) => Promise<Response>;
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

describe('Download-Quellen', () => {
  const ts3 = (extra: object = {}) => ({
    windows: {
      x86_64: {
        version: '3.13.9',
        checksum: 'a'.repeat(64),
        mirrors: { 'teamspeak.com': 'https://files.teamspeak-services.com/releases/server/3.13.9/teamspeak3-server_win64-3.13.9.zip' },
        ...extra,
      },
    },
  });

  it('TeamSpeak: Adresse und Prüfsumme des Herstellers', async () => {
    const r = await resolveSource('teamspeak3', { fetchImpl: (async () => json(ts3())) as Fetch });
    expect(r).toMatchObject({ version: '3.13.9', sha256: 'a'.repeat(64), allowedHosts: ['files.teamspeak-services.com'] });
    expect(r.url).toContain('win64-3.13.9.zip');
  });

  it('TeamSpeak: fremder Host, kaputte Summe oder Version werden abgelehnt', async () => {
    const run = (body: unknown) => resolveSource('teamspeak3', { fetchImpl: (async () => json(body)) as Fetch });
    await expect(run(ts3({ mirrors: { 'teamspeak.com': 'https://evil.example/ts.zip' } }))).rejects.toThrow(/Host/);
    await expect(run(ts3({ mirrors: { 'teamspeak.com': 'http://files.teamspeak-services.com/x.zip' } }))).rejects.toThrow();
    await expect(run(ts3({ checksum: 'zz' }))).rejects.toThrow(/brauchbare/);
    await expect(run(ts3({ version: '../../x' }))).rejects.toThrow(/brauchbare/);
    await expect(run({})).rejects.toThrow();
  });

  it('eine feste Summe aus der Umgebung geht der des Herstellers vor', async () => {
    const env = { NEXUSCORE_TEAMSPEAK3_SHA256: 'B'.repeat(64) };
    const r = await resolveSource('teamspeak3', { fetchImpl: (async () => json(ts3())) as Fetch, env });
    expect(r.sha256).toBe('b'.repeat(64));
    expect(pinnedFromEnv('terraria', { NEXUSCORE_TERRARIA_SHA256: 'kaputt' })).toBeNull();
  });

  it('Terraria: die höchste Version, ohne Prüfsumme (der Hersteller veröffentlicht keine)', async () => {
    const r = await resolveSource('terraria', {
      fetchImpl: (async () => json(['terraria-server-1449.zip', 'terraria-server-1458.zip', 'terraria-server-1458.zip', 'x.zip', '../terraria-server-9999.zip'])) as Fetch,
    });
    expect(r).toMatchObject({ version: '1458', sha256: null, allowedHosts: ['terraria.org'] });
    expect(r.url).toBe('https://terraria.org/api/download/pc-dedicated-server/terraria-server-1458.zip');
    await expect(resolveSource('terraria', { fetchImpl: (async () => json([])) as Fetch })).rejects.toThrow();
  });

  it('Bedrock: nur der Windows-Link von minecraft.net', async () => {
    const link = (url: string) => ({ result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: 'https://x/l.zip' }, { downloadType: 'serverBedrockWindows', downloadUrl: url }] } });
    const ok = await resolveSource('bedrock', { fetchImpl: (async () => json(link('https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.63.1.zip'))) as Fetch });
    expect(ok).toMatchObject({ version: '1.26.63.1', sha256: null, allowedHosts: ['www.minecraft.net'] });
    await expect(resolveSource('bedrock', { fetchImpl: (async () => json(link('https://evil.example/bedrockdedicatedserver/bin-win/bedrock-server-1.0.zip'))) as Fetch })).rejects.toThrow(/Bedrock/);
    await expect(resolveSource('bedrock', { fetchImpl: (async () => json({})) as Fetch })).rejects.toThrow();
  });

  it('kennt nur seine drei Quellen', () => {
    for (const s of ['teamspeak3', 'terraria', 'bedrock']) expect(isDownloadSource(s)).toBe(true);
    for (const s of ['https://evil.example/x.zip', '', 'steam', undefined, 5]) expect(isDownloadSource(s)).toBe(false);
  });
});

describe('Installation aus einem Archiv', () => {
  let dir: string;
  let zip: Buffer;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-dl-'));
    // Wie das Terraria-Archiv: ein Versionsordner mit Windows und Linux darin
    const src = path.join(dir, 'build');
    await fs.mkdir(path.join(src, '1458', 'Windows'), { recursive: true });
    await fs.mkdir(path.join(src, '1458', 'Linux'), { recursive: true });
    await fs.writeFile(path.join(src, '1458', 'Windows', 'TerrariaServer.exe'), 'MZ-windows');
    await fs.writeFile(path.join(src, '1458', 'Linux', 'TerrariaServer'), 'ELF');
    await fs.writeFile(path.join(src, '1458', 'server.properties'), 'standard=1\n');
    await createZip(src, ['1458'], 'archiv.zip');
    zip = await fs.readFile(path.join(src, 'archiv.zip'));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const fetcher = (archive: Buffer, calls: string[] = []): Fetch => async (url) => {
    calls.push(url);
    if (url.endsWith('dedicated-servers-names')) return json(['terraria-server-1458.zip']);
    return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
  };

  const launch = (over: object = {}) => ({
    download: { source: 'terraria' as const, stripTop: true, mkdirs: ['worlds'], keep: ['server.properties'] },
    executable: 'Windows/TerrariaServer.exe',
    args: ['-port', '{{PORT_GAME}}', { when: 'PASSWORD', args: ['-password', '{{PASSWORD}}'] }, '-world', 'worlds/{{WORLDNAME}}.wld'],
    ...over,
  });

  async function install(serverDir: string, over: { launch?: object; fetch?: Fetch; variables?: Record<string, string> } = {}) {
    const lines: string[] = [];
    const steps: string[] = [];
    const result = await installDownloadGame(
      {
        serverDir,
        runtimesDir: path.join(dir, 'runtimes'),
        launch: launch(over.launch) as never,
        variables: over.variables ?? { WORLDNAME: 'Welt1', PASSWORD: '' },
        ports: [{ name: 'game', hostPort: 28000, protocol: 'tcp' }],
        ramMb: 2048,
        serverName: 'Test',
      },
      { fetchImpl: over.fetch ?? fetcher(zip), onLine: (l) => lines.push(l), onProgress: (_f, m) => steps.push(m) },
    );
    return { result, lines, steps };
  }

  it('lädt, packt aus ohne den Versionsordner, legt Ordner an und baut die Argumente', async () => {
    const serverDir = path.join(dir, 'server1');
    const { result, lines, steps } = await install(serverDir);
    expect(await fs.readFile(path.join(serverDir, 'Windows', 'TerrariaServer.exe'), 'utf8')).toBe('MZ-windows');
    expect((await fs.stat(path.join(serverDir, 'worlds'))).isDirectory()).toBe(true);
    expect(result.executable).toBe(path.join(serverDir, 'Windows', 'TerrariaServer.exe'));
    expect(result.args).toEqual(['-port', '28000', '-world', 'worlds/Welt1.wld']);
    expect(result.version).toBe('1458');
    expect(result.sha256).toBe(sha256(zip));
    // Ohne Prüfsumme des Herstellers steht die tatsächliche im Protokoll
    expect(lines.join('\n')).toContain(sha256(zip));
    expect(lines.join('\n')).toContain('keine Prüfsumme');
    expect(steps.some((s) => s.startsWith('Lade Terraria Server 1458'))).toBe(true);
    // Der Hilfsordner ist weg
    expect((await fs.readdir(serverDir)).filter((n) => n.startsWith('.nx-extract'))).toEqual([]);
  });

  it('Neuinstallation: Dateien aus "keep" und fremde Dateien bleiben, Programme werden ersetzt', async () => {
    const serverDir = path.join(dir, 'server2');
    await install(serverDir);
    await fs.writeFile(path.join(serverDir, 'server.properties'), 'meine=einstellung\n');
    await fs.writeFile(path.join(serverDir, 'worlds', 'Welt1.wld'), 'WELT');
    await fs.writeFile(path.join(serverDir, 'Windows', 'TerrariaServer.exe'), 'ALT');
    await install(serverDir);
    expect(await fs.readFile(path.join(serverDir, 'server.properties'), 'utf8')).toBe('meine=einstellung\n');
    expect(await fs.readFile(path.join(serverDir, 'worlds', 'Welt1.wld'), 'utf8')).toBe('WELT');
    expect(await fs.readFile(path.join(serverDir, 'Windows', 'TerrariaServer.exe'), 'utf8')).toBe('MZ-windows');
  });

  it('eine feste Summe, die nicht stimmt, bricht ab und packt nichts aus', async () => {
    const serverDir = path.join(dir, 'server3');
    await expect(
      installDownloadGame(
        { serverDir, runtimesDir: path.join(dir, 'runtimes3'), launch: launch() as never, variables: { WORLDNAME: 'W' }, ports: [{ name: 'game', hostPort: 1, protocol: 'tcp' }], ramMb: 1, serverName: 'x' },
        { fetchImpl: fetcher(zip), env: { NEXUSCORE_TERRARIA_SHA256: '0'.repeat(64) } },
      ),
    ).rejects.toThrow(/Pr(ü|ue)fsumme stimmt nicht/);
    await expect(fs.stat(path.join(serverDir, 'Windows'))).rejects.toThrow();
  });

  it('fehlt das Programm, nennt die Meldung die gefundenen', async () => {
    const serverDir = path.join(dir, 'server4');
    await expect(install(serverDir, { launch: { executable: 'Falsch/Name.exe' } })).rejects.toThrow(/Gefundene Programme: Windows\/TerrariaServer\.exe/);
  });

  it('lässt weder Programm noch Ordner aus dem Server-Ordner hinausweisen', async () => {
    await expect(install(path.join(dir, 'server5'), { launch: { executable: '../../draussen.exe' } })).rejects.toThrow(/außerhalb/);
    await expect(install(path.join(dir, 'server6'), { launch: { download: { source: 'terraria', stripTop: true, mkdirs: ['../draussen'] } } })).rejects.toThrow(/außerhalb/);
    await expect(fs.stat(path.join(dir, 'draussen'))).rejects.toThrow();
  });

  it('ohne Quelle in der Vorlage gibt es keine Installation', async () => {
    await expect(
      installDownloadGame(
        { serverDir: path.join(dir, 's7'), runtimesDir: dir, launch: { executable: 'a.exe', args: [] } as never, variables: {}, ports: [], ramMb: 1, serverName: 'x' },
        {},
      ),
    ).rejects.toThrow(/Download-Angaben/);
  });
});

describe('über den Installationsmanager mit der echten Terraria-Vorlage', () => {
  it('legt Programm und Argumente an und meldet "fertig"', async () => {
    const { InstallManager, installPlanFor } = await import('../src/install/manager.js');
    const { ServerRegistry } = await import('../src/store/registry.js');
    const { MockDriver } = await import('../src/drivers/mock-driver.js');
    const { EventBus } = await import('../src/protocol/events.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-dlm-'));
    const registry = await ServerRegistry.open(root);
    try {
      const src = path.join(root, 'build');
      await fs.mkdir(path.join(src, '1458', 'Windows'), { recursive: true });
      await fs.writeFile(path.join(src, '1458', 'Windows', 'TerrariaServer.exe'), 'MZ');
      await createZip(src, ['1458'], 'a.zip');
      const archive = await fs.readFile(path.join(src, 'a.zip'));
      const eggFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eggs/terraria.json');
      const egg = JSON.parse(await fs.readFile(eggFile, 'utf8'));
      const variables = Object.fromEntries(egg.variables.map((v: { env_variable: string; default_value?: string }) => [v.env_variable, v.default_value ?? '']));
      const plan = installPlanFor('terraria', egg, variables)!;
      expect(plan.kind).toBe('download');

      const driver = new MockDriver();
      await driver.initialize();
      const dirServer = path.join(root, 'servers', 'terra');
      await fs.mkdir(dirServer, { recursive: true });
      await registry.add({
        id: 'terra', name: 'Terra', game: 'terraria', executable: '', args: [], workingDir: dirServer,
        ports: [{ name: 'game', hostPort: 28001, protocol: 'tcp' }], install: { state: 'installing', kind: 'download', variables },
      });
      const manager = new InstallManager(registry, driver, new EventBus(), {
        runtimesDir: path.join(root, 'runtimes'),
        fetchImpl: (async (url: string) =>
          url.endsWith('dedicated-servers-names') ? json(['terraria-server-1458.zip']) : new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } })) as never,
      });
      manager.start('terra', { kind: 'download', variables, propertiesTemplate: {}, steam: plan.steam! });
      await manager.whenIdle('terra');

      const done = registry.get('terra')!;
      expect(done.install?.state, done.install?.error).toBe('done');
      expect(done.install?.kind).toBe('download');
      expect(done.executable).toBe(path.join(dirServer, 'Windows', 'TerrariaServer.exe'));
      expect(done.args).toEqual(expect.arrayContaining(['-port', '28001', '-world', 'worlds/Welt1.wld', '-autocreate', '2']));
      expect(done.args.join(' ')).not.toContain('-password'); // leeres Passwort: kein Argument
      const task = registry.listTasks({ serverId: 'terra' })[0]!;
      expect(task.status).toBe('done');
      expect(task.result).toMatchObject({ source: 'terraria', version: '1458', sha256: sha256(archive) });
    } finally {
      registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
