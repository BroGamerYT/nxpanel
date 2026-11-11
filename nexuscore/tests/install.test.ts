import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { downloadFile, fetchJson } = await import('../src/install/download.js');
const { patchProperties, substitute } = await import('../src/install/properties.js');
const { resolvePaperBuild, latestPaperVersion } = await import('../src/install/paper.js');
const { ensureJava } = await import('../src/install/java.js');
const { installMinecraftPaper, heapMb } = await import('../src/install/minecraft.js');
const { InstallManager, installKindFor } = await import('../src/install/manager.js');
const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');

type FetchLike = import('../src/install/download.js').FetchLike;

const sha = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

const JAR = Buffer.from('das-ist-ein-paper-jar '.repeat(2000));
const JAVA_ZIP = Buffer.from('das-ist-ein-java-archiv '.repeat(3000));

/** Nachbildung von PaperMC (Fill v3) und Adoptium - kein echter Netzwerkzugriff. */
function fakeNet(overrides: Record<string, () => Response> = {}): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const file = (data: Buffer) =>
    new Response(new Uint8Array(data), { status: 200, headers: { 'content-length': String(data.length) } });

  const build = (version: string, id: number, channel = 'STABLE') => ({
    id,
    channel,
    downloads: {
      'server:default': {
        name: `paper-${version}-${id}.jar`,
        checksums: { sha256: sha(JAR) },
        size: JAR.length,
        url: `https://fill-data.papermc.io/v1/objects/${sha(JAR)}/paper-${version}-${id}.jar`,
      },
    },
  });

  const routes: Record<string, () => Response> = {
    'https://fill.papermc.io/v3/projects/paper': () =>
      json({ versions: { '26.3': ['26.4-rc-1', '26.3', '26.3-rc-3'], '1.21': ['1.21.11', '1.21.10'] } }),
    'https://fill.papermc.io/v3/projects/paper/versions/26.3': () =>
      json({ version: { id: '26.3', java: { version: { minimum: 25 } } } }),
    'https://fill.papermc.io/v3/projects/paper/versions/26.3/builds/latest': () => json(build('26.3', 248)),
    'https://fill.papermc.io/v3/projects/paper/versions/1.21.11': () =>
      json({ version: { id: '1.21.11', java: { version: { minimum: 21 } } } }),
    'https://fill.papermc.io/v3/projects/paper/versions/1.21.11/builds/latest': () => json(build('1.21.11', 140, 'ALPHA')),
    'https://fill.papermc.io/v3/projects/paper/versions/1.21.11/builds': () =>
      json([build('1.21.11', 140, 'ALPHA'), build('1.21.11', 132), build('1.21.11', 131)]),
    'https://fill.papermc.io/v3/projects/paper/versions/9.9.9': () => json({ error: 'not found' }, 404),
    ...overrides,
  };

  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (routes[url]) return routes[url]!();
    if (url.startsWith('https://fill-data.papermc.io/')) return file(JAR);
    if (url.startsWith('https://api.adoptium.net/v3/assets/latest/')) {
      const major = url.split('/latest/')[1]!.split('/')[0];
      return json([
        {
          release_name: `jdk-${major}.0.5+8`,
          binary: {
            package: {
              name: `OpenJDK${major}U-jre.zip`,
              link: `https://github.com/adoptium/temurin${major}-binaries/releases/download/x/OpenJDK${major}U-jre.zip`,
              checksum: sha(JAVA_ZIP),
              size: JAVA_ZIP.length,
            },
          },
        },
      ]);
    }
    if (url.startsWith('https://github.com/adoptium/')) return file(JAVA_ZIP);
    return json({ error: 'unbekannt' }, 404);
  };
  return { fetchImpl, calls };
}

/** Ersetzt das Entpacken: legt die Struktur an, die Temurin im Archiv hat. */
const fakeExtract = async (_archive: string, destDir: string): Promise<void> => {
  const bin = path.join(destDir, 'jdk-test-jre', 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'java.exe' : 'java'), 'java');
};

const PROPERTIES_TEMPLATE = {
  'server-port': '{{SERVER_PORT}}',
  'max-players': '{{MAX_PLAYERS}}',
  motd: '{{MOTD}}',
  'level-type': '{{LEVEL_TYPE}}',
  'enable-rcon': 'true',
  'rcon.port': '{{RCON_PORT}}',
};

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-inst-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe('Block B2 - Download', () => {
  it('speichert nur bei passender Pruefsumme', async () => {
    const { fetchImpl } = fakeNet();
    const dest = path.join(tmp, 'a', 'server.jar');
    const opts = { allowedHosts: ['fill-data.papermc.io'], fetchImpl };

    await expect(
      downloadFile('https://fill-data.papermc.io/x.jar', dest, { ...opts, sha256: 'a'.repeat(64) }),
    ).rejects.toThrow(/Pruefsumme stimmt nicht/);
    expect(await fs.readdir(path.join(tmp, 'a'))).toEqual([]);

    const seen: number[] = [];
    const result = await downloadFile('https://fill-data.papermc.io/x.jar', dest, {
      ...opts,
      sha256: sha(JAR),
      onProgress: (done) => seen.push(done),
    });
    expect(result.bytes).toBe(JAR.length);
    expect(seen.at(-1)).toBe(JAR.length);
    expect((await fs.readFile(dest)).equals(JAR)).toBe(true);
    expect(await fs.readdir(path.join(tmp, 'a'))).toEqual(['server.jar']);
  });

  it('lehnt fremde Hosts, HTTP und fehlende Pruefsummen ab', async () => {
    const { fetchImpl, calls } = fakeNet();
    const dest = path.join(tmp, 'x.jar');
    const opts = { allowedHosts: ['fill-data.papermc.io'], fetchImpl, sha256: sha(JAR) };

    await expect(downloadFile('https://boese.example/x.jar', dest, opts)).rejects.toThrow(/nicht erlaubt/);
    await expect(downloadFile('http://fill-data.papermc.io/x.jar', dest, opts)).rejects.toThrow(/HTTPS/);
    await expect(
      downloadFile('https://fill-data.papermc.io/x.jar', dest, { ...opts, sha256: '' }),
    ).rejects.toThrow(/SHA-256/);
    await expect(fetchJson('https://boese.example/api', { allowedHosts: ['fill.papermc.io'], fetchImpl })).rejects.toThrow(
      /nicht erlaubt/,
    );
    expect(calls).toEqual([]);
  });

  it('bricht ab, wenn die Datei groesser ist als erlaubt', async () => {
    const { fetchImpl } = fakeNet();
    await expect(
      downloadFile('https://fill-data.papermc.io/x.jar', path.join(tmp, 'x.jar'), {
        allowedHosts: ['fill-data.papermc.io'],
        fetchImpl,
        sha256: sha(JAR),
        maxBytes: 100,
      }),
    ).rejects.toThrow(/groesser als erlaubt/);
    expect(await fs.readdir(tmp)).toEqual([]);
  });
});

describe('Block B2 - server.properties', () => {
  it('aendert nur genannte Schluessel und behaelt Kommentare und Reihenfolge', () => {
    const before = '#Minecraft server properties\r\n#Mon\r\nmotd=Alt\r\nserver-port=25565\r\npvp=true\r\n';
    const after = patchProperties(before, { 'server-port': '25570', motd: 'Neu', 'max-players': '8' });
    expect(after).toBe(
      '#Minecraft server properties\r\n#Mon\r\nmotd=Neu\r\nserver-port=25570\r\npvp=true\r\nmax-players=8\r\n',
    );
  });

  it('legt eine leere Datei an und maskiert Sonderzeichen', () => {
    expect(patchProperties('', { motd: 'Zeile1\nZeile2 \\o/' })).toBe('motd=Zeile1\\nZeile2 \\\\o/\n');
  });

  it('verwechselt aehnliche Schluessel nicht', () => {
    const after = patchProperties('rcon.port=1\nrconXport=2\nport=3\n', { 'rcon.port': '9' });
    expect(after).toBe('rcon.port=9\nrconXport=2\nport=3\n');
  });

  it('ersetzt Platzhalter in beiden Schreibweisen und leert unbekannte', () => {
    const values = { SERVER_PORT: '25570', MOTD: 'Hallo' };
    expect(substitute('{{SERVER_PORT}}', values)).toBe('25570');
    expect(substitute('{{ server.build.env.MOTD }}!', values)).toBe('Hallo!');
    expect(substitute('{{GIBT_ES_NICHT}}', values)).toBe('');
  });
});

describe('Block B2 - Paper-Version', () => {
  it('nimmt bei LATEST die neueste fertige Version, keinen Vorab-Build', async () => {
    const { fetchImpl } = fakeNet();
    expect(await latestPaperVersion({ fetchImpl })).toBe('26.3');
    const build = await resolvePaperBuild('LATEST', { fetchImpl });
    expect(build).toMatchObject({ version: '26.3', build: 248, javaMajor: 25, sha256: sha(JAR) });
  });

  it('faellt auf den letzten stabilen Build zurueck', async () => {
    const { fetchImpl } = fakeNet();
    expect(await resolvePaperBuild('1.21.11', { fetchImpl })).toMatchObject({ build: 132, channel: 'STABLE', javaMajor: 21 });
  });

  it('lehnt unbekannte und unsaubere Versionsangaben ab', async () => {
    const { fetchImpl, calls } = fakeNet();
    await expect(resolvePaperBuild('9.9.9', { fetchImpl })).rejects.toThrow(/kein Paper/);
    const before = calls.length;
    for (const boese of ['../../etc', '1.21/../x', '1.21?x=1', 'a b']) {
      await expect(resolvePaperBuild(boese, { fetchImpl })).rejects.toThrow(/Ungueltige Minecraft-Version/);
    }
    expect(calls.length).toBe(before);
  });
});

describe('Block B2 - Java-Laufzeit', () => {
  it('laedt Java einmal und verwendet es danach wieder', async () => {
    const { fetchImpl, calls } = fakeNet();
    const runtimes = path.join(tmp, 'runtimes');

    const first = await ensureJava(25, runtimes, { fetchImpl, extract: fakeExtract });
    expect(first).toMatchObject({ major: 25, release: 'jdk-25.0.5+8', downloaded: true });
    expect(first.executable.startsWith(path.join(runtimes, 'java-25'))).toBe(true);
    await fs.access(first.executable);
    // Keine Reste: nur der fertige Ordner.
    expect(await fs.readdir(runtimes)).toEqual(['java-25']);

    const callsAfterFirst = calls.length;
    const second = await ensureJava(25, runtimes, { fetchImpl, extract: fakeExtract });
    expect(second).toMatchObject({ downloaded: false, executable: first.executable });
    expect(calls.length).toBe(callsAfterFirst);
  });

  it('laedt bei zwei gleichzeitigen Installationen nur einmal', async () => {
    const { fetchImpl, calls } = fakeNet();
    const runtimes = path.join(tmp, 'runtimes');
    const [a, b] = await Promise.all([
      ensureJava(21, runtimes, { fetchImpl, extract: fakeExtract }),
      ensureJava(21, runtimes, { fetchImpl, extract: fakeExtract }),
    ]);
    expect(a.executable).toBe(b.executable);
    expect(calls.filter((c) => c.startsWith('https://github.com/')).length).toBe(1);
  });

  it('raeumt nach einem Fehler auf und meldet ihn', async () => {
    const { fetchImpl } = fakeNet();
    const runtimes = path.join(tmp, 'runtimes');
    await expect(
      ensureJava(25, runtimes, { fetchImpl, extract: async (_a, dest) => void (await fs.mkdir(dest, { recursive: true })) }),
    ).rejects.toThrow(/kein bin\/java/);
    expect(await fs.readdir(runtimes)).toEqual([]);
    await expect(ensureJava(3, runtimes, { fetchImpl })).rejects.toThrow(/Ungueltige Java-Version/);
  });
});

describe('Block B2 - Installation von Paper', () => {
  const input = () => ({
    serverDir: path.join(tmp, 'servers', 'mc'),
    runtimesDir: path.join(tmp, 'runtimes'),
    variables: { VERSION: 'LATEST', EULA: 'TRUE', MAX_PLAYERS: '12', MOTD: 'Mein Server', RCON_PASSWORD: '' },
    propertiesTemplate: PROPERTIES_TEMPLATE,
    ramMb: 4096,
    port: 25570,
    serverName: 'MC',
  });

  it('installiert vollstaendig und liefert das Startkommando', async () => {
    const { fetchImpl } = fakeNet();
    const steps: number[] = [];
    const result = await installMinecraftPaper(input(), {
      fetchImpl,
      extract: fakeExtract,
      onProgress: (fraction) => steps.push(fraction),
    });

    expect(result).toMatchObject({ version: '26.3', build: 248, javaMajor: 25, stopCommand: 'stop' });
    expect(result.args).toEqual([`-Xmx${heapMb(4096)}M`, '-Dfile.encoding=UTF-8', '-jar', 'server.jar', '--nogui']);
    expect(result.executable).toContain(path.join('runtimes', 'java-25'));

    const dir = input().serverDir;
    expect((await fs.readFile(path.join(dir, 'server.jar'))).equals(JAR)).toBe(true);
    expect(await fs.readFile(path.join(dir, 'eula.txt'), 'utf8')).toContain('eula=true');

    const properties = await fs.readFile(path.join(dir, 'server.properties'), 'utf8');
    expect(properties).toContain('server-port=25570');
    expect(properties).toContain('max-players=12');
    expect(properties).toContain('motd=Mein Server');
    // RCON regelt der Core selbst ab, leere Werte bleiben weg.
    expect(properties).toContain('enable-rcon=false');
    expect(properties).not.toContain('rcon.port');
    expect(properties).not.toContain('level-type');

    // Fortschritt laeuft nur vorwaerts und endet bei 1.
    expect(steps.at(-1)).toBe(1);
    expect(steps.every((value, i) => i === 0 || value >= steps[i - 1]!)).toBe(true);
  });

  it('laedt die Server-Datei nicht erneut, wenn sie unveraendert ist', async () => {
    const { fetchImpl, calls } = fakeNet();
    await installMinecraftPaper(input(), { fetchImpl, extract: fakeExtract });
    const before = calls.filter((c) => c.startsWith('https://fill-data.papermc.io/')).length;
    await installMinecraftPaper(input(), { fetchImpl, extract: fakeExtract });
    expect(calls.filter((c) => c.startsWith('https://fill-data.papermc.io/')).length).toBe(before);
  });

  it('installiert nicht ohne akzeptierte EULA', async () => {
    const { fetchImpl, calls } = fakeNet();
    await expect(
      installMinecraftPaper({ ...input(), variables: { VERSION: 'LATEST', EULA: 'FALSE' } }, { fetchImpl }),
    ).rejects.toThrow(/EULA/);
    expect(calls).toEqual([]);
  });

  it('gibt dem Heap Luft fuer die JVM', () => {
    expect(heapMb(4096)).toBe(3481);
    expect(heapMb(256)).toBe(512);
  });
});

describe('Block B2 - Installation als Aufgabe', () => {
  async function setup(net = fakeNet()) {
    const registry = await ServerRegistry.open(tmp);
    const driver = new MockDriver();
    await driver.initialize();
    const bus = new EventBus();
    const installs = new InstallManager(registry, driver, bus, {
      runtimesDir: path.join(tmp, 'runtimes'),
      fetchImpl: net.fetchImpl,
      extract: fakeExtract,
    });
    const server = await createCoreServer(driver, bus, registry, { installs });
    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { login: 'admin', password: 'nur-fuer-tests-0815' },
    });
    const headers = { authorization: `Bearer ${login.json().accessToken}`, 'content-type': 'application/json' };
    const close = async () => {
      await installs.whenIdle();
      await server.close();
      await driver.shutdown();
      registry.close();
    };
    return { registry, driver, bus, installs, server, headers, close };
  }

  it('die Spieleliste sagt, was der Core selbst installieren kann (und ohne Installer: alles)', async () => {
    const ctx = await setup();
    try {
      const eggs = (await ctx.server.inject({ method: 'GET', url: '/api/v1/eggs', headers: ctx.headers })).json().eggs as Array<{ id: string; installable: boolean }>;
      const byId = new Map(eggs.map((e) => [e.id, e.installable]));
      for (const id of ['minecraft-paper', 'palworld', 'valheim', 'terraria', 'teamspeak3', 'cs2']) expect(byId.get(id), id).toBe(true);
      for (const id of ['factorio', 'mumble', 'velocity']) expect(byId.get(id), id).toBe(false);
    } finally {
      await ctx.close();
    }
    // Ohne Installer (Docker, Mock) bleibt es wie im Panel: alles waehlbar
    const registry = await ServerRegistry.open(path.join(tmp, 'ohne-installer'));
    const driver = new MockDriver();
    await driver.initialize();
    const server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
    try {
      const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
      const eggs = (await server.inject({ method: 'GET', url: '/api/v1/eggs', headers: { authorization: `Bearer ${login.json().accessToken}` } })).json().eggs as Array<{ installable: boolean }>;
      expect(eggs.length).toBeGreaterThan(40);
      expect(eggs.every((e) => e.installable)).toBe(true);
    } finally {
      await server.close();
      registry.close();
    }
  });

  it('erkennt, was der Core installieren kann', () => {
    expect(installKindFor('minecraft-paper', {})).toBe('minecraft-paper');
    expect(installKindFor('minecraft-paper', { TYPE: 'paper' })).toBe('minecraft-paper');
    expect(installKindFor('minecraft-paper', { TYPE: 'FORGE' })).toBeNull();
    expect(installKindFor('palworld', {})).toBeNull();
  });

  it('legt an, installiert im Hintergrund und meldet die Instanz danach beim Treiber an', async () => {
    const ctx = await setup();
    try {
      const created = await ctx.server.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: ctx.headers,
        payload: { name: 'Mein Paper', eggId: 'minecraft-paper', ramMb: 4096, variables: { MAX_PLAYERS: '7' } },
      });
      expect(created.statusCode).toBe(201);
      const { server: made, taskId } = created.json();
      expect(taskId).toMatch(/^t_/);

      // Waehrend der Installation: Status "installing", Start wird abgelehnt.
      expect(ctx.registry.get(made.id)!.install!.state).toBe('installing');
      const early = await ctx.server.inject({
        method: 'POST',
        url: `/api/v1/servers/${made.id}/power`,
        headers: ctx.headers,
        payload: { action: 'start' },
      });
      expect(early.statusCode).toBe(409);

      await ctx.installs.whenIdle(made.id);

      const saved = ctx.registry.get(made.id)!;
      expect(saved.install).toMatchObject({ state: 'done', version: '26.3', build: 248 });
      expect(saved.stopCommand).toBe('stop');
      expect(saved.args).toContain('server.jar');
      expect(ctx.registry.getTask(taskId)).toMatchObject({ status: 'done', progress: 1 });
      expect(ctx.registry.listTasks({ active: true })).toEqual([]);

      const list = await ctx.server.inject({ method: 'GET', url: '/api/v1/servers', headers: ctx.headers });
      expect(list.json().servers[0]).toMatchObject({ id: made.id, status: 'offline' });

      const properties = await fs.readFile(path.join(saved.workingDir, 'server.properties'), 'utf8');
      expect(properties).toContain('max-players=7');

      // Jetzt kennt der Treiber die Instanz und startet sie.
      const start = await ctx.server.inject({
        method: 'POST',
        url: `/api/v1/servers/${made.id}/power`,
        headers: ctx.headers,
        payload: { action: 'start' },
      });
      expect(start.statusCode).toBe(200);
      expect(['starting', 'running']).toContain((await ctx.driver.getServerState(made.id)).status);

      const actions = ctx.registry.recentAudit({ serverId: made.id }).map((e) => e.action);
      expect(actions).toContain('server.install');
      expect(ctx.bus.logsFor(made.id, 100).some((l) => l.line.includes('[Installation]'))).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('zeigt eine laufende Installation als Aufgabe mit Fortschritt', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = fakeNet();
    const slow: FetchLike = async (url, init) => {
      if (url.startsWith('https://fill-data.papermc.io/')) await gate;
      return base.fetchImpl(url, init);
    };
    const ctx = await setup({ fetchImpl: slow, calls: base.calls });
    try {
      const created = await ctx.server.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: ctx.headers,
        payload: { name: 'Langsam', eggId: 'minecraft-paper' },
      });
      const id = created.json().server.id as string;

      // Warten, bis Java fertig ist und der Jar-Download haengt.
      for (let i = 0; i < 200 && !base.calls.some((c) => c.startsWith('https://fill-data.papermc.io/')); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const tasks = await ctx.server.inject({ method: 'GET', url: '/api/v1/tasks/active', headers: ctx.headers });
      expect(tasks.json().tasks).toHaveLength(1);
      expect(tasks.json().tasks[0]).toMatchObject({ type: 'install', serverId: id, serverName: 'Langsam' });
      expect(tasks.json().tasks[0].progressPercent).toBeGreaterThan(0);

      const list = await ctx.server.inject({ method: 'GET', url: '/api/v1/servers', headers: ctx.headers });
      expect(list.json().servers[0].status).toBe('installing');
      const detail = await ctx.server.inject({ method: 'GET', url: `/api/v1/servers/${id}`, headers: ctx.headers });
      expect(detail.json().server.status).toBe('installing');

      release();
      await ctx.installs.whenIdle(id);
      expect(ctx.registry.get(id)!.install!.state).toBe('done');
    } finally {
      release();
      await ctx.close();
    }
  });

  it('meldet eine fehlgeschlagene Installation und erlaubt die Neuinstallation', async () => {
    let broken = true;
    const base = fakeNet();
    const flaky: FetchLike = async (url, init) => {
      if (broken && url.startsWith('https://fill-data.papermc.io/')) {
        return new Response(new Uint8Array(Buffer.from('verfaelscht')), { status: 200 });
      }
      return base.fetchImpl(url, init);
    };
    const ctx = await setup({ fetchImpl: flaky, calls: base.calls });
    try {
      const created = await ctx.server.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: ctx.headers,
        payload: { name: 'Kaputt', eggId: 'minecraft-paper' },
      });
      const { server: made, taskId } = created.json();
      await ctx.installs.whenIdle(made.id);

      expect(ctx.registry.get(made.id)!.install).toMatchObject({ state: 'failed' });
      expect(ctx.registry.get(made.id)!.install!.error).toMatch(/Pruefsumme/);
      expect(ctx.registry.getTask(taskId)).toMatchObject({ status: 'failed' });
      const list = await ctx.server.inject({ method: 'GET', url: '/api/v1/servers', headers: ctx.headers });
      expect(list.json().servers[0].status).toBe('install_failed');
      // Die verfaelschte Datei liegt nicht im Server-Ordner.
      expect(await fs.readdir(ctx.registry.get(made.id)!.workingDir)).not.toContain('server.jar');

      const start = await ctx.server.inject({
        method: 'POST',
        url: `/api/v1/servers/${made.id}/power`,
        headers: ctx.headers,
        payload: { action: 'start' },
      });
      expect(start.statusCode).toBe(409);

      broken = false;
      const again = await ctx.server.inject({
        method: 'POST',
        url: `/api/v1/servers/${made.id}/reinstall`,
        headers: { authorization: ctx.headers.authorization },
      });
      expect(again.statusCode).toBe(200);
      await ctx.installs.whenIdle(made.id);
      expect(ctx.registry.get(made.id)!.install).toMatchObject({ state: 'done', version: '26.3' });
    } finally {
      await ctx.close();
    }
  });

  it('meldet einen Fehlerzustand des Treibers als abgestuerzt, nicht mit einem unbekannten Wert', async () => {
    const ctx = await setup();
    try {
      const created = await ctx.server.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: ctx.headers,
        payload: { name: 'Fehler', eggId: 'factorio' },
      });
      const id = created.json().server.id as string;
      // Der Treiber meldet "error", etwa wenn der Prozess nicht starten konnte.
      // Die Oberflaeche kennt diesen Wert nicht (ServerStatus in web/src/lib/types.ts).
      (await ctx.driver.getServerState(id)).status = 'error';

      const list = await ctx.server.inject({ method: 'GET', url: '/api/v1/servers', headers: ctx.headers });
      expect(list.json().servers[0].status).toBe('crashed');
      const detail = await ctx.server.inject({ method: 'GET', url: `/api/v1/servers/${id}`, headers: ctx.headers });
      expect(detail.json().server.status).toBe('crashed');
    } finally {
      await ctx.close();
    }
  });

  it('schickt einer offenen Server-Seite bei fehlgeschlagener Installation "install_failed"', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const failing: FetchLike = async () => {
      await gate;
      return new Response('{}', { status: 500 });
    };
    const ctx = await setup({ fetchImpl: failing, calls: [] });
    try {
      const created = await ctx.server.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: ctx.headers,
        payload: { name: 'Offene Seite', eggId: 'minecraft-paper' },
      });
      const id = created.json().server.id as string;

      // Die Server-Seite ist schon offen, waehrend die Installation noch laeuft.
      const address = await ctx.server.listen({ port: 0, host: '127.0.0.1' });
      const token = ctx.headers.authorization.replace('Bearer ', '');
      const ws = new WebSocket(`${address.replace(/^http/, 'ws')}/api/v1/servers/${id}/ws?token=${token}`);
      const seen: string[] = [];
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; status?: string };
        if ((message.type === 'hello' || message.type === 'status') && message.status) seen.push(message.status);
      };
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 100 && seen.length === 0; i++) await wait(50);
      expect(seen[0]).toBe('installing');

      release();
      await ctx.installs.whenIdle(id);
      for (let i = 0; i < 100 && seen.at(-1) !== 'install_failed'; i++) await wait(50);
      ws.close();

      // Der Wert des Treibers ("error") darf die Oberflaeche nie erreichen.
      expect(seen).not.toContain('error');
      expect(seen.at(-1)).toBe('install_failed');
    } finally {
      release();
      await ctx.close();
    }
  });

  it('laesst Eggs ohne windows-Block unveraendert als Platzhalter anlegen', async () => {
    const ctx = await setup();
    try {
      const created = await ctx.server.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: ctx.headers,
        payload: { name: 'Pal', eggId: 'factorio' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().taskId).toBeUndefined();
      expect(ctx.registry.get(created.json().server.id)!.install).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});
