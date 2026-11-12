import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { DockerDriver } = await import('../src/drivers/docker-driver.js');
const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { InstallManager } = await import('../src/install/manager.js');
const { FakeDocker } = await import('./helpers/fake-docker.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', ...json };
const PW = 'ein-sicheres-passwort-1';
const STEAM_PW = 'konto-passwort-ganz-geheim-42';

type Headers = Record<string, string>;
async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

interface Env {
  dir: string;
  registry: InstanceType<typeof ServerRegistry>;
  server: Awaited<ReturnType<typeof createCoreServer>>;
  call: (method: 'GET' | 'POST' | 'DELETE', url: string, headers?: Headers, payload?: unknown) => ReturnType<Awaited<ReturnType<typeof createCoreServer>>['inject']>;
  login: (name: string) => Promise<Headers>;
  lines: string[];
}
async function setup(kind: 'docker' | 'windows', extra: { docker?: InstanceType<typeof FakeDocker>; runner?: ConstructorParameters<typeof InstallManager>[3]['steamRunner'] }): Promise<Env> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `nx-steaminst-${kind}-`));
  const registry = await ServerRegistry.open(dir);
  const bus = new EventBus();
  const driver = kind === 'docker' ? new DockerDriver(extra.docker!) : new MockDriver();
  await driver.initialize();
  const installs = kind === 'windows' ? new InstallManager(registry, driver, bus, { runtimesDir: path.join(dir, 'runtimes'), steamRunner: extra.runner!, steamExe: 'C:/fake/steamcmd.exe' }) : undefined;
  const server = await createCoreServer(driver, bus, registry, { scheduler: false, ...(installs ? { installs } : {}) });
  const call: Env['call'] = (method, url, headers = MASTER, payload) =>
    server.inject({ method, url, headers: payload === undefined ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type')) : headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const login = async (name: string): Promise<Headers> => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: name, password: PW } });
    return { authorization: `Bearer ${res.json().accessToken}`, ...json };
  };
  const lines: string[] = [];
  bus.on((e) => {
    const ev = e as { type: string; line?: string };
    if (ev.type === 'console' && ev.line) lines.push(ev.line);
  });
  return { dir, registry, server, call, login, lines };
}
const teardown = async (e: Env): Promise<void> => {
  await e.server.close();
  e.registry.close();
  await fs.rm(e.dir, { recursive: true, force: true });
};

describe('Steam-Konto beim Anlegen (Docker, Installer-Container)', () => {
  let e: Env;
  let docker: InstanceType<typeof FakeDocker>;
  let acc = '';
  let anna: Headers;
  beforeAll(async () => {
    docker = new FakeDocker();
    e = await setup('docker', { docker });
    await e.call('POST', '/api/v1/admin/users', MASTER, { username: 'si-anna', password: PW, canCreateServers: true });
    await e.call('POST', '/api/v1/admin/users', MASTER, { username: 'si-ben', password: PW, canCreateServers: true });
    anna = await e.login('si-anna');
    acc = (await e.call('POST', '/api/v1/steam/accounts', anna, { accountName: 'annas_konto', password: STEAM_PW })).json().account.id;
  });
  afterAll(() => teardown(e));

  it('das Konto geht nur in die Umgebung des Installers - nicht in die Konfiguration, Antworten oder die Konsole', async () => {
    docker.installer = { lines: ['[installer] login mit konto', `[installer] Passwort war ${STEAM_PW}`], code: 0 };
    const res = await e.call('POST', '/api/v1/servers', anna, { name: 'Mit Konto', eggId: 'garrys-mod', steamAccountId: acc });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().server.id as string;
    expect(await until(() => e.registry.get(id)?.install?.state === 'done')).toBe(true);
    const installer = docker.created.find((o) => o.Labels?.['nexuscore.installer'] === id)!;
    expect(installer.Env).toEqual(expect.arrayContaining(['STEAM_USER=annas_konto', `STEAM_PASS=${STEAM_PW}`]));
    expect(e.registry.get(id)?.install?.steamAccountId).toBe(acc);
    expect(JSON.stringify(e.registry.get(id))).not.toContain(STEAM_PW);
    expect((await e.call('GET', `/api/v1/servers/${id}`, anna)).body).not.toContain(STEAM_PW);
    expect(e.lines.join('\n')).not.toContain(STEAM_PW);
    expect(e.lines.join('\n')).toContain('Passwort war ***');
    // Auch nicht im Container, in dem das Spiel später läuft
    await e.call('POST', `/api/v1/servers/${id}/power`, anna, { action: 'start' });
    expect(JSON.stringify(docker.created.find((o) => o.name === `nxc-${id}`) ?? {})).not.toContain(STEAM_PW);

    // Neuinstallieren benutzt das Konto weiter
    const before = docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === id).length;
    await e.call('POST', `/api/v1/servers/${id}/power`, anna, { action: 'kill' });
    await new Promise((r) => setTimeout(r, 50));
    expect((await e.call('POST', `/api/v1/servers/${id}/reinstall`, anna, {})).statusCode).toBeLessThan(300);
    expect(await until(() => docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === id).length === before + 1)).toBe(true);
    expect(docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === id).at(-1)!.Env).toEqual(expect.arrayContaining([`STEAM_PASS=${STEAM_PW}`]));
  });

  it('ohne Konto bleibt der Installer ohne Zugangsdaten', async () => {
    const res = await e.call('POST', '/api/v1/servers', anna, { name: 'Anonym', eggId: 'garrys-mod' });
    const id = res.json().server.id as string;
    expect(await until(() => e.registry.get(id)?.install?.state === 'done')).toBe(true);
    const env = docker.created.find((o) => o.Labels?.['nexuscore.installer'] === id)!.Env as string[];
    expect(env.some((v) => v.startsWith('STEAM_PASS='))).toBe(false);
    expect(e.registry.get(id)?.install?.steamAccountId).toBeUndefined();
  });

  it('ein fremdes, unbekanntes oder passwortloses Konto wird abgelehnt - bevor etwas angelegt wird', async () => {
    const ben = await e.login('si-ben');
    const count = e.registry.list().length;
    for (const [who, id] of [[ben, acc], [anna, '00000000-0000-4000-8000-000000000000'], [anna, 'quatsch']] as const) {
      const res = await e.call('POST', '/api/v1/servers', who, { name: 'Abgelehnt', eggId: 'garrys-mod', steamAccountId: id });
      expect(res.statusCode, id).toBe(400);
      expect(res.json().code).toBe('invalid_steam_account');
    }
    const noPw = (await e.call('POST', '/api/v1/steam/accounts', anna, { accountName: 'ohne_pw' })).json().account.id as string;
    expect((await e.call('POST', '/api/v1/servers', anna, { name: 'Abgelehnt', eggId: 'garrys-mod', steamAccountId: noPw })).statusCode).toBe(400);
    expect(e.registry.list().length).toBe(count);
  });

  it('ein freigegebenes Konto darf jeder wählen', async () => {
    const shared = (await e.call('POST', '/api/v1/steam/accounts', MASTER, { accountName: 'team', password: 'team-passwort-123', isShared: true })).json().account.id as string;
    const ben = await e.login('si-ben');
    const res = await e.call('POST', '/api/v1/servers', ben, { name: 'Team Server', eggId: 'garrys-mod', steamAccountId: shared });
    expect(res.statusCode, res.body).toBe(201);
    expect(await until(() => e.registry.get(res.json().server.id)?.install?.state === 'done')).toBe(true);
  });

  it('wurde das Konto gelöscht, scheitert eine spätere Installation mit klarer Meldung', async () => {
    const own = (await e.call('POST', '/api/v1/steam/accounts', anna, { accountName: 'wegwerf', password: 'wegwerf-passwort-1' })).json().account.id as string;
    const res = await e.call('POST', '/api/v1/servers', anna, { name: 'Konto Weg', eggId: 'garrys-mod', steamAccountId: own });
    const id = res.json().server.id as string;
    expect(await until(() => e.registry.get(id)?.install?.state === 'done')).toBe(true);
    await e.call('DELETE', `/api/v1/steam/accounts/${own}`, anna);
    await e.call('POST', `/api/v1/servers/${id}/reinstall`, anna, {});
    expect(await until(() => e.registry.get(id)?.install?.state === 'failed')).toBe(true);
    expect(e.registry.get(id)?.install?.error).toContain('Steam-Konto');
  });
});

describe('Steam-Konto beim Anlegen (Windows, SteamCMD)', () => {
  let e: Env;
  const runs: string[][] = [];
  const lines: string[] = [];
  beforeAll(async () => {
    e = await setup('windows', {
      runner: async (_exe, args, hooks) => {
        runs.push(args);
        const dir = args[args.indexOf('+force_install_dir') + 1]!;
        const appId = args[args.indexOf('+app_update') + 1]!;
        hooks.onLine(`Logging in user '${args[args.indexOf('+login') + 1]}' password ${args[args.indexOf('+login') + 2]}`);
        await fs.mkdir(path.join(dir, 'steamapps'), { recursive: true });
        await fs.writeFile(path.join(dir, 'PalServer.exe'), 'MZ');
        await fs.writeFile(path.join(dir, 'steamapps', `appmanifest_${appId}.acf`), `"AppState"\n{\n\t"buildid"\t"99"\n}\n`);
        hooks.onLine(`Success! App '${appId}' fully installed.`);
        return 0;
      },
    });
    void lines;
  });
  afterAll(() => teardown(e));

  it('SteamCMD meldet sich mit dem Konto an statt anonym; das Passwort steht nirgends gespeichert und nicht in der Konsole', async () => {
    const acc = (await e.call('POST', '/api/v1/steam/accounts', MASTER, { accountName: 'pal_konto', password: STEAM_PW })).json().account.id as string;
    const res = await e.call('POST', '/api/v1/servers', MASTER, { name: 'Pal Konto', eggId: 'palworld', ramMb: 8192, steamAccountId: acc });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().server.id as string;
    expect(await until(() => e.registry.get(id)?.install?.state === 'done')).toBe(true);
    const login = runs.at(-1)!;
    expect(login.slice(login.indexOf('+login') + 1, login.indexOf('+login') + 3)).toEqual(['pal_konto', STEAM_PW]);
    expect(JSON.stringify(e.registry.get(id))).not.toContain(STEAM_PW);
    expect(e.lines.join('\n')).toContain('password ***');
    expect(e.lines.join('\n')).not.toContain(STEAM_PW);
  });

  it('ohne Konto bleibt es anonym', async () => {
    const res = await e.call('POST', '/api/v1/servers', MASTER, { name: 'Pal Anonym', eggId: 'palworld', ramMb: 8192 });
    expect(await until(() => e.registry.get(res.json().server.id)?.install?.state === 'done')).toBe(true);
    const login = runs.at(-1)!;
    expect(login[login.indexOf('+login') + 1]).toBe('anonymous');
  });
});
