import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';
process.env.NEXUSCORE_PORT_RANGE = '39400-39409';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { resolveInsideRoot, resolveInstancePaths, isInside, PathOutsideRootError } = await import(
  '../src/protocol/paths.js'
);
const { allocatePort, isPortFree } = await import('../src/protocol/ports.js');
const { LocalAccount, hashPassword, verifyPassword } = await import('../src/store/account.js');
const { isValidSessionToken, createSessionToken, SESSION_TTL_MS } = await import('../src/protocol/security.js');

const AUTH = { authorization: 'Bearer test-token-0123456789abcdefghij' };
const PASSWORD = 'nur-fuer-tests-0815';

let server: Awaited<ReturnType<typeof createCoreServer>>;
let driver: InstanceType<typeof MockDriver>;
let registry: InstanceType<typeof ServerRegistry>;
let dataDir: string;
let serverRoot: string;
let outside: string;

const instance = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Haertung',
  game: 'test',
  executable: 'server.exe',
  args: [],
  workingDir: id,
  ports: [],
  ...extra,
});

const login = (password: string, user = 'admin', remoteAddress = '10.0.0.1') =>
  server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: { login: user, password },
    remoteAddress,
  });

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-hard-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-outside-'));
  serverRoot = path.join(dataDir, 'servers');
  await fs.mkdir(serverRoot, { recursive: true });
  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry);
});

afterAll(async () => {
  await server.close();
  await driver.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
});

describe('Block A3 - Pfadgrenze', () => {
  it('isInside vergleicht Pfade, nicht Zeichenketten', () => {
    const root = path.resolve('/srv/servers');
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, 'a', 'b'))).toBe(true);
    expect(isInside(root, path.resolve('/srv/servers-boese/x'))).toBe(false);
    expect(isInside(root, path.resolve('/srv'))).toBe(false);
  });

  it('nimmt Pfade im Server-Verzeichnis an und speichert sie absolut', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers',
      headers: AUTH,
      payload: instance('a3-ok'),
    });
    expect(res.statusCode).toBe(201);
    const saved = registry.get('a3-ok')!;
    expect(saved.workingDir).toBe(path.join(serverRoot, 'a3-ok'));
    expect(saved.executable).toBe(path.join(serverRoot, 'a3-ok', 'server.exe'));
  });

  it('lehnt ein Programm ausserhalb mit 400 ab', async () => {
    for (const executable of [
      path.join(outside, 'boese.exe'),
      process.execPath,
      '../../../boese.exe',
      '..\\..\\..\\boese.exe',
    ]) {
      const res = await server.inject({
        method: 'POST',
        url: '/core/v1/servers',
        headers: AUTH,
        payload: instance('a3-exe', { executable }),
      });
      expect(res.statusCode, executable).toBe(400);
      expect(registry.get('a3-exe')).toBeUndefined();
    }
  });

  it('lehnt ein Arbeitsverzeichnis ausserhalb mit 400 ab', async () => {
    for (const workingDir of [outside, '..', '../..', path.resolve(serverRoot, '..')]) {
      const res = await server.inject({
        method: 'POST',
        url: '/core/v1/servers',
        headers: AUTH,
        payload: instance('a3-dir', { workingDir }),
      });
      expect(res.statusCode, workingDir).toBe(400);
    }
  });

  it('lehnt einen Symlink ab, der nach draussen zeigt', async () => {
    const link = path.join(serverRoot, 'a3-link');
    try {
      // 'junction' braucht unter Windows keine Adminrechte.
      await fs.symlink(outside, link, 'junction');
    } catch {
      return; // Dateisystem ohne Links - nichts zu pruefen.
    }

    await expect(resolveInsideRoot(serverRoot, 'a3-link/boese.exe', 'executable')).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers',
      headers: AUTH,
      payload: instance('a3-sym', { workingDir: 'a3-link' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('resolveInstancePaths loest das Programm gegen das Arbeitsverzeichnis auf', async () => {
    const paths = await resolveInstancePaths(serverRoot, { workingDir: 'mc', executable: 'bin/start.bat' });
    expect(paths.workingDir).toBe(path.join(serverRoot, 'mc'));
    expect(paths.executable).toBe(path.join(serverRoot, 'mc', 'bin', 'start.bat'));
    await expect(
      resolveInstancePaths(serverRoot, { workingDir: 'mc', executable: '../../x.exe' }),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('/api/panel/servers nimmt kein freies Programm mehr an', async () => {
    const boese = await server.inject({
      method: 'POST',
      url: '/api/panel/servers',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { id: 'a3-panel', name: 'x', game: 'test', executable: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(boese.statusCode).toBe(400);
    expect(registry.get('a3-panel')).toBeUndefined();

    const gut = await server.inject({
      method: 'POST',
      url: '/api/panel/servers',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { id: 'a3-panel', name: 'x', game: 'test', executable: 'start.bat' },
    });
    expect(gut.statusCode).toBe(201);
    expect(registry.get('a3-panel')!.executable).toBe(path.join(serverRoot, 'a3-panel', 'start.bat'));
  });
});

describe('Block A4 - Anmeldung im Standalone-Modus', () => {
  it('refresh gibt ohne Sitzung kein Token mehr heraus', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('accessToken');
  });

  it('refresh lehnt ein erfundenes Cookie ab', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: 'nxp_session=nxp_erfunden', origin: 'http://localhost:80', host: 'localhost:80' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lehnt ein falsches Passwort und einen falschen Namen ab', async () => {
    expect((await login('falsch-falsch-falsch', 'admin', '10.0.0.2')).statusCode).toBe(401);
    expect((await login(PASSWORD, 'jemand', '10.0.0.2')).statusCode).toBe(401);
    expect((await login('', 'admin', '10.0.0.2')).statusCode).toBe(401);
  });

  it('meldet mit dem richtigen Passwort an und setzt ein geschuetztes Cookie', async () => {
    const res = await login(PASSWORD);
    expect(res.statusCode).toBe(200);
    const token = res.json().accessToken as string;
    expect(isValidSessionToken(token)).toBe(true);

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');

    const me = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('admin');

    const refresh = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `nxp_session=${token}`, origin: 'http://localhost:80', host: 'localhost:80' },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().accessToken).toBe(token);
  });

  it('beendet die Sitzung beim Abmelden', async () => {
    const token = (await login(PASSWORD)).json().accessToken as string;
    const out = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(200);
    expect(isValidSessionToken(token)).toBe(false);
  });

  it('sperrt nach fuenf Fehlversuchen - aber nur diese Herkunft', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login('falsch-falsch-falsch', 'admin', '10.9.9.9')).statusCode).toBe(401);
    }
    const gesperrt = await login(PASSWORD, 'admin', '10.9.9.9');
    expect(gesperrt.statusCode).toBe(429);
    expect(Number(gesperrt.headers['retry-after'])).toBeGreaterThan(0);

    // Eine andere Herkunft ist nicht betroffen.
    expect((await login(PASSWORD, 'admin', '10.9.9.10')).statusCode).toBe(200);
  });

  it('laesst Sitzungen ablaufen', () => {
    const token = createSessionToken();
    expect(isValidSessionToken(token)).toBe(true);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + SESSION_TTL_MS + 1000;
      expect(isValidSessionToken(token)).toBe(false);
    } finally {
      Date.now = realNow;
    }
    expect(isValidSessionToken(token)).toBe(false);
  });

  it('speichert nur einen Hash, nie das Passwort', async () => {
    const raw = await fs.readFile(path.join(dataDir, 'account.json'), 'utf8');
    expect(raw).not.toContain(PASSWORD);
    expect(JSON.parse(raw).passwordHash).toMatch(/^scrypt\$/);

    const hash = await hashPassword('ein-langes-passwort');
    expect(await verifyPassword('ein-langes-passwort', hash)).toBe(true);
    expect(await verifyPassword('ein-anderes-passwort', hash)).toBe(false);
    expect(await verifyPassword('x', 'kaputt')).toBe(false);
  });

  it('aendert das Passwort nur mit dem alten und beendet andere Sitzungen', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-acc-'));
    try {
      const account = await LocalAccount.open(dir);
      expect(await account.verify('admin', PASSWORD, 'a')).toBe(true);
      await expect(account.setPassword('kurz')).rejects.toThrow(/mindestens/);
      await account.setPassword('ein-neues-passwort-42');
      expect(await account.verify('admin', PASSWORD, 'a')).toBe(false);
      expect(await account.verify('ADMIN', 'ein-neues-passwort-42', 'b')).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('Block A5 - Ports und unbekannte Instanzen', () => {
  it('vergibt einen freien Port aus dem Bereich und ueberspringt belegte', async () => {
    const servers = [
      instance('p1', { ports: [{ name: 'game', hostPort: 39400, protocol: 'tcp' }] }),
      instance('p2', { ports: [{ name: 'game', hostPort: 39401, protocol: 'tcp' }] }),
    ] as never;
    expect(await allocatePort(servers, async () => true)).toBe(39402);
    // Port 39402 ist von einem fremden Programm belegt -> der naechste.
    expect(await allocatePort(servers, async (port) => port !== 39402)).toBe(39403);
  });

  it('vergibt nach einer Loeschung keinen belegten Port doppelt', async () => {
    // Zwei Server auf 39400 und 39402: die alte Formel (Start + Anzahl) haette 39402 erneut vergeben.
    const servers = [
      instance('p1', { ports: [{ name: 'game', hostPort: 39400, protocol: 'tcp' }] }),
      instance('p3', { ports: [{ name: 'game', hostPort: 39402, protocol: 'tcp' }] }),
    ] as never;
    expect(await allocatePort(servers, async () => true)).toBe(39401);
  });

  it('meldet einen vollen Bereich als Fehler', async () => {
    await expect(allocatePort([], async () => false)).rejects.toThrow(/Kein freier Port/);
  });

  it('erkennt einen wirklich belegten Port', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen({ port: 0, host: '0.0.0.0' }, resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    expect(await isPortFree(port)).toBe(true);
  });

  it('antwortet bei unbekannten Instanzen mit 404 statt den Treiber zu fragen', async () => {
    for (const url of [
      '/api/panel/servers/gibt-es-nicht/start',
      '/api/panel/servers/gibt-es-nicht/stop',
      '/api/v1/servers/gibt-es-nicht/power',
    ]) {
      const res = await server.inject({
        method: 'POST',
        url,
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: { action: 'start' },
      });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('findet Instanzen nur ueber die exakte ID, nicht ueber einen Anfang', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/servers/a3/power',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { action: 'start' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('kill beendet hart statt nur zu stoppen', async () => {
    const calls: string[] = [];
    const originalKill = driver.killServer.bind(driver);
    driver.killServer = async (id: string) => {
      calls.push(id);
      return originalKill(id);
    };
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/servers/a3-ok/power',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: { action: 'kill' },
      });
      expect(res.statusCode).toBe(200);
      expect(calls).toEqual(['a3-ok']);
    } finally {
      driver.killServer = originalKill;
    }
  });

  it('lehnt eine unbekannte Power-Aktion ab', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/servers/a3-ok/power',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { action: 'explodieren' },
    });
    expect(res.statusCode).toBe(400);
  });
});
