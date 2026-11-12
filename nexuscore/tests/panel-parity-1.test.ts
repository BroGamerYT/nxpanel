import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { DockerDriver } = await import('../src/drivers/docker-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { FakeDocker } = await import('./helpers/fake-docker.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij' };
const PW = 'ein-sicheres-passwort-1';

type Headers = Record<string, string>;
interface Ctx {
  dir: string;
  registry: InstanceType<typeof ServerRegistry>;
  server: Awaited<ReturnType<typeof createCoreServer>>;
}
const made: Ctx[] = [];

async function boot(driver: InstanceType<typeof MockDriver> | InstanceType<typeof DockerDriver>): Promise<Ctx> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-parity1-'));
  const registry = await ServerRegistry.open(dir);
  await driver.initialize();
  const server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
  const ctx = { dir, registry, server };
  made.push(ctx);
  return ctx;
}
afterAll(async () => {
  for (const c of made) {
    await c.server.close();
    c.registry.close();
    await fs.rm(c.dir, { recursive: true, force: true });
  }
});

const caller = (c: Ctx) => (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Headers = {}, payload?: unknown) =>
  c.server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function login(c: Ctx, name: string, password: string): Promise<Headers> {
  const res = await caller(c)('POST', '/api/v1/auth/login', {}, { login: name, password });
  expect(res.statusCode, `Anmeldung ${name}: ${res.body}`).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

// ---------------------------------------------------------------------------------------------------------------

describe('Gesundheit', () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await boot(new MockDriver());
  });

  it('healthz und readyz sind ohne Anmeldung erreichbar und verraten nur Ja/Nein', async () => {
    const call = caller(c);
    expect((await call('GET', '/api/v1/healthz')).json()).toEqual({ status: 'ok' });
    const ready = await call('GET', '/api/v1/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', checks: { database: true, runtime: true } });
  });

  it('readyz meldet 503, wenn der Treiber nicht antwortet', async () => {
    const driver = new MockDriver();
    (driver as unknown as { healthy: () => Promise<boolean> }).healthy = async () => false;
    const down = await boot(driver);
    const res = await caller(down)('GET', '/api/v1/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { database: true, runtime: false } });
  });

  it('der Docker-Treiber prüft den Daemon bei jeder Anfrage - auch wenn er erst später startet', async () => {
    const fake = new FakeDocker();
    fake.pingFails = true;
    const driver = new DockerDriver(fake);
    const dc = await boot(driver);
    expect((await caller(dc)('GET', '/api/v1/readyz')).statusCode).toBe(503);
    fake.pingFails = false;
    expect((await caller(dc)('GET', '/api/v1/readyz')).statusCode).toBe(200);
  });
});

describe('Kleinigkeiten der Oberfläche', () => {
  let c: Ctx;
  let admin: Headers;
  let user: Headers;
  beforeAll(async () => {
    c = await boot(new MockDriver());
    admin = await login(c, 'admin', 'nur-fuer-tests-0815');
    const call = caller(c);
    await call('POST', '/api/v1/admin/users', admin, { username: 'pk1-user', password: PW });
    user = await login(c, 'pk1-user', PW);
  });

  it('verlangen eine Anmeldung', async () => {
    const call = caller(c);
    for (const url of ['/api/v1/presence', '/api/v1/auth/permissions', '/api/v1/eggs/branding', '/api/v1/docs', '/api/v1/docs/installation']) {
      expect((await call('GET', url)).statusCode, url).toBe(401);
    }
  });

  it('presence: der Core merkt sich nichts, die Oberfläche bekommt eine leere Liste', async () => {
    expect((await caller(c)('GET', '/api/v1/presence', user)).json()).toEqual({ online: [], total: 0 });
  });

  it('auth/permissions: alle Rechte mit Namen und die Vorlagen', async () => {
    const res = (await caller(c)('GET', '/api/v1/auth/permissions', user)).json();
    expect(res.flags.length).toBeGreaterThan(20);
    expect(res.flags[0]).toEqual({ flag: expect.any(String), label: expect.any(String) });
    expect(res.presets.map((p: { key: string }) => p.key)).toEqual(expect.arrayContaining(['zuschauer', 'operator']));
    expect(res.presets[0]).toMatchObject({ key: expect.any(String), label: expect.any(String), flags: expect.any(Array) });
  });

  it('eggs/branding: die Motive für den Bild-Dialog', async () => {
    const res = (await caller(c)('GET', '/api/v1/eggs/branding', user)).json();
    expect(res.branding.length).toBeGreaterThan(0);
    for (const p of res.branding) expect(p).toMatch(/^\/branding\//);
  });

  it('allocations: Ports des Servers lesen - nur mit Recht, sonst 404/403', async () => {
    const call = caller(c);
    const dir = path.join(c.dir, 'servers', 'al-1');
    await fs.mkdir(dir, { recursive: true });
    await c.registry.add({ id: 'al-1', name: 'Ports', game: 'x', executable: 'x', args: [], workingDir: dir, ports: [{ name: 'game', hostPort: 25570, protocol: 'tcp' }, { name: 'query', hostPort: 25571, protocol: 'udp' }] });
    const res = await call('GET', '/api/v1/servers/al-1/allocations', admin);
    expect(res.json()).toEqual({
      allocations: [
        { port: 25570, protocol: 'tcp', ref: 'game', is_primary: true },
        { port: 25571, protocol: 'udp', ref: 'query', is_primary: false },
      ],
    });
    // Ein Benutzer ohne Zugang sieht den Server nicht einmal
    expect((await call('GET', '/api/v1/servers/al-1/allocations', user)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/servers/gibtsnicht/allocations', admin)).statusCode).toBe(404);
  });

  it('Hilfe: Dokumente auflisten und lesen - nie ein beliebiger Pfad', async () => {
    const call = caller(c);
    const list = (await call('GET', '/api/v1/docs', user)).json().docs as Array<{ slug: string; title: string }>;
    expect(list.map((d) => d.slug)).toEqual(expect.arrayContaining(['installation', 'linux-vm-test']));
    const doc = (await call('GET', '/api/v1/docs/installation', user)).json();
    expect(doc.title).toMatch(/Installation/);
    expect(doc.content).toContain('Windows');
    // auch ueber den Dateinamen, ohne Beachtung der Schreibweise
    expect((await call('GET', '/api/v1/docs/INSTALLATION.md', user)).json().slug).toBe('installation');
    for (const evil of ['..%2f..%2fpackage.json', '..', '.env', 'gibtsnicht', '%2e%2e%2fsrc%2findex.ts']) {
      // 404 (kein solches Dokument) oder 403 (der Pfad wird vor dem Aufruf zu einer Verwalter-Route aufgeloest) - nie Inhalt
      const status = (await call('GET', `/api/v1/docs/${evil}`, user)).statusCode;
      expect([403, 404], `${evil}: ${status}`).toContain(status);
    }
    // die Liste steht auch in /about (Hilfe-Seite)
    const about = (await call('GET', '/api/v1/about', user)).json();
    expect(about.docs.length).toBe(list.length);
    expect(about.features).toContain('help');
  });
});

describe('Docker aufräumen', () => {
  it('räumt nur Images des Cores auf, die kein Container braucht - fremde Images bleiben', async () => {
    const fake = new FakeDocker();
    const driver = new DockerDriver(fake);
    // Das Spiel-Image und das Installer-Image des Cores, ein benutztes und ein fremdes Image
    for (const [name, size] of [
      ['itzg/minecraft-server:java21', 1_300_000_000],
      ['ghcr.io/parkervcp/installers:debian', 200_000_000],
      ['itzg/minecraft-server:java17', 1_200_000_000],
      ['postgres:16-alpine', 400_000_000],
    ] as const) {
      fake.images.add(name);
      fake.imageSizes.set(name, size);
    }
    fake.inUse.add('itzg/minecraft-server:java17');
    const c = await boot(driver);
    const call = caller(c);
    const admin = await login(c, 'admin', 'nur-fuer-tests-0815');

    const res = await call('POST', '/api/v1/admin/docker/prune', admin, { images: true, buildCache: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ imagesDeleted: 2, reclaimedMb: Math.round(1_500_000_000 / 1048576) });
    expect([...fake.images].sort()).toEqual(['itzg/minecraft-server:java17', 'postgres:16-alpine']);
    expect((await call('GET', '/api/v1/admin/audit?limit=50', admin)).body).toContain('docker.prune');
    // ohne Images nichts tun
    expect((await call('POST', '/api/v1/admin/docker/prune', admin, { images: false })).json()).toEqual({ imagesDeleted: 0, reclaimedMb: 0 });
  });

  it('nur für Administratoren und nur mit dem Docker-Treiber', async () => {
    const c = await boot(new MockDriver());
    const call = caller(c);
    const admin = await login(c, 'admin', 'nur-fuer-tests-0815');
    await call('POST', '/api/v1/admin/users', admin, { username: 'pr-user', password: PW });
    const user = await login(c, 'pr-user', PW);
    expect((await call('POST', '/api/v1/admin/docker/prune', user, {})).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/admin/docker/prune', {}, {})).statusCode).toBe(401);
    const res = await call('POST', '/api/v1/admin/docker/prune', admin, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('not_supported');
  });

  it('ohne erreichbaren Docker-Daemon: klare Antwort statt Absturz', async () => {
    const fake = new FakeDocker();
    fake.pingFails = true;
    const c = await boot(new DockerDriver(fake));
    const admin = await login(c, 'admin', 'nur-fuer-tests-0815');
    const res = await caller(c)('POST', '/api/v1/admin/docker/prune', admin, {});
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('docker_unavailable');
  });
});

describe('Benutzer imitieren', () => {
  let c: Ctx;
  let call: ReturnType<typeof caller>;
  let admin: Headers;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    c = await boot(new MockDriver());
    call = caller(c);
    admin = await login(c, 'admin', 'nur-fuer-tests-0815');
    for (const name of ['im-user', 'im-fremd', 'im-gesperrt', 'im-admin2']) {
      const res = await call('POST', '/api/v1/admin/users', admin, { username: name, password: PW, ...(name === 'im-admin2' ? { role: 'admin' } : {}) });
      expect(res.statusCode, res.body).toBe(201);
      ids[name] = res.json().user.id as string;
    }
    await call('PATCH', `/api/v1/admin/users/${ids['im-gesperrt']}`, admin, { suspended: true });
  });

  it('der Administrator sieht als Benutzer, kommt mit dem Rückkehr-Token zurück - jedes Token gilt einmal', async () => {
    const res = await call('POST', `/api/v1/admin/users/${ids['im-user']}/impersonate`, admin, {});
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({ username: 'im-user', role: 'user' });
    expect(body.originalAdmin).toMatchObject({ username: 'admin', returnToken: expect.any(String) });
    expect(res.headers['set-cookie']).toContain('nxp_session=');
    const asUser = { authorization: `Bearer ${body.accessToken}` };
    expect((await call('GET', '/api/v1/auth/me', asUser)).json().user.username).toBe('im-user');
    // Als Benutzer gelten die Rechte des Benutzers, nicht die des Administrators
    expect((await call('GET', '/api/v1/admin/users', asUser)).statusCode).toBe(403);

    // Zurück: nur als genau dieser Benutzer und mit dem Token
    expect((await call('POST', '/api/v1/auth/impersonate/stop', asUser, { returnToken: 'x'.repeat(40) })).statusCode).toBe(403);
    const back = await call('POST', '/api/v1/auth/impersonate/stop', asUser, { returnToken: body.originalAdmin.returnToken });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().user.username).toBe('admin');
    expect(back.json().permissions).toBeTruthy();
    const asAdmin = { authorization: `Bearer ${back.json().accessToken}` };
    expect((await call('GET', '/api/v1/admin/users', asAdmin)).statusCode).toBe(200);
    // Die Imitations-Sitzung ist beendet, das Token verbraucht
    expect((await call('GET', '/api/v1/auth/me', asUser)).statusCode).toBe(401);
    expect((await call('POST', '/api/v1/auth/impersonate/stop', asAdmin, { returnToken: body.originalAdmin.returnToken })).statusCode).toBe(403);
  });

  it('ein anderer Benutzer kann das Rückkehr-Token nicht einlösen (früher: Hintertür zum Admin-Konto)', async () => {
    const res = await call('POST', `/api/v1/admin/users/${ids['im-user']}/impersonate`, admin, {});
    const token = res.json().originalAdmin.returnToken as string;
    const other = await login(c, 'im-fremd', PW);
    const stolen = await call('POST', '/api/v1/auth/impersonate/stop', other, { returnToken: token });
    expect(stolen.statusCode).toBe(403);
    // Das Token ist trotzdem verbraucht - ein Fehlversuch öffnet nichts
    const asUser = { authorization: `Bearer ${res.json().accessToken}` };
    expect((await call('POST', '/api/v1/auth/impersonate/stop', asUser, { returnToken: token })).statusCode).toBe(403);
  });

  it('abgelehnt: gesperrte Benutzer, das eigene Konto, unbekannte, ohne Konto (Zugriffstoken des Cores), ohne Recht', async () => {
    expect((await call('POST', `/api/v1/admin/users/${ids['im-gesperrt']}/impersonate`, admin, {})).statusCode).toBe(403);
    const me = (await call('GET', '/api/v1/auth/me', admin)).json().user.id;
    expect((await call('POST', `/api/v1/admin/users/${me}/impersonate`, admin, {})).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/admin/users/gibtsnicht/impersonate', admin, {})).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/admin/users/${ids['im-user']}/impersonate`, MASTER, {})).json().code).toBe('needs_account');
    const user = await login(c, 'im-user', PW);
    expect((await call('POST', `/api/v1/admin/users/${ids['im-fremd']}/impersonate`, user, {})).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/admin/users/${ids['im-user']}/impersonate`, {}, {})).statusCode).toBe(401);
  });

  it('Rückkehr scheitert, wenn der Administrator inzwischen gesperrt wurde', async () => {
    const adminB = await login(c, 'im-admin2', PW);
    const res = await call('POST', `/api/v1/admin/users/${ids['im-user']}/impersonate`, adminB, {});
    expect(res.statusCode, res.body).toBe(200);
    await call('PATCH', `/api/v1/admin/users/${ids['im-admin2']}`, admin, { suspended: true });
    const asUser = { authorization: `Bearer ${res.json().accessToken}` };
    expect((await call('POST', '/api/v1/auth/impersonate/stop', asUser, { returnToken: res.json().originalAdmin.returnToken })).statusCode).toBe(403);
  });

  it('beides steht im Audit-Protokoll - mit dem Namen des Administrators', async () => {
    const audit = (await call('GET', '/api/v1/admin/audit?limit=200', admin)).body;
    expect(audit).toContain('admin.impersonate_user');
    expect(audit).toContain('admin.impersonate_stop');
    expect(audit).toContain('im-user');
    // Kein Token im Protokoll
    expect(audit).not.toMatch(/returnToken/i);
  });
});
