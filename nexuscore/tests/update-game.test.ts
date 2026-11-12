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
const { FakeDocker } = await import('./helpers/fake-docker.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', ...json };
const PW = 'ein-sicheres-passwort-1';

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
let docker: InstanceType<typeof FakeDocker>;
const bus = new EventBus();
const consoleLines: string[] = [];

type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Headers = MASTER, payload?: unknown) =>
  server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Die jüngste Aufgabe dieser Art (die Liste ist nicht nach Alter sortiert). */
const taskOf = (id: string, kind = 'update') =>
  registry
    .listTasks()
    .filter((t) => t.serverId === id && t.kind === kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const finished = async (id: string) => until(() => ['done', 'failed'].includes(taskOf(id)?.status ?? ''));

async function createMinecraft(name: string): Promise<string> {
  const res = await call('POST', '/api/v1/servers', MASTER, { name, eggId: 'minecraft-paper', ramMb: 2048, variables: { EULA: 'TRUE' } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().server.id as string;
}

/** Der "Server" im Container versteht den Stop-Befehl und beendet sich. */
const stopsOnCommand = (id: string) => {
  const c = docker.containers.get(`nxc-${id}`);
  if (c) c.exitOnStdin = 'stop';
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-update-'));
  registry = await ServerRegistry.open(dir);
  docker = new FakeDocker();
  const driver = new DockerDriver(docker);
  await driver.initialize();
  bus.on((e) => {
    const ev = e as { type: string; line?: string };
    if (ev.type === 'console' && ev.line?.startsWith('[Update]')) consoleLines.push(ev.line);
  });
  server = await createCoreServer(driver, bus, registry, { scheduler: false });
});
afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('1-Klick-Update (Docker)', () => {
  it('Image-Server ohne Installation: stoppen, neuestes Image holen, wieder starten', async () => {
    const id = await createMinecraft('Update Eins');
    await call('POST', `/api/v1/servers/${id}/power`, MASTER, { action: 'start' });
    stopsOnCommand(id);
    const first = docker.containers.get(`nxc-${id}`)!;
    const pullsBefore = docker.pulled.length;

    const res = await call('POST', `/api/v1/servers/${id}/update-game`, MASTER, { backup: false });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true, taskId: expect.any(String) });
    expect(await finished(id)).toBe(true);
    expect(taskOf(id)).toMatchObject({ status: 'done', progress: 1 });

    // geordnet gestoppt (Stop-Befehl, kein harter Abbruch), Image neu geholt, neuer Container läuft
    expect(first.stdinWrites).toContain('stop\n');
    expect(docker.pulled.length).toBe(pullsBefore + 1);
    const now = docker.containers.get(`nxc-${id}`)!;
    expect(now).not.toBe(first);
    expect(now.running).toBe(true);
    expect(consoleLines.some((l) => l.includes('Update abgeschlossen'))).toBe(true);
    expect((await call('GET', '/api/v1/admin/audit?limit=100')).body).toContain('server.update_game');
    now.exit(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('war der Server aus, bleibt er aus - ohne startAfter; mit startAfter startet er', async () => {
    const id = await createMinecraft('Update Zwei');
    expect((await call('POST', `/api/v1/servers/${id}/update-game`, MASTER, { backup: false, startAfter: false })).statusCode).toBe(202);
    expect(await finished(id)).toBe(true);
    expect(docker.containers.get(`nxc-${id}`)).toBeUndefined();

    expect((await call('POST', `/api/v1/servers/${id}/update-game`, MASTER, { backup: false })).statusCode).toBe(202);
    expect(await until(() => docker.containers.get(`nxc-${id}`)?.running === true)).toBe(true);
    docker.containers.get(`nxc-${id}`)!.exit(0);
  });

  it('mit Sicherheits-Backup: das Backup entsteht vor dem Update', async () => {
    const id = await createMinecraft('Update Backup');
    await fs.writeFile(path.join(dir, 'servers', id, 'welt.txt'), 'wichtig');
    expect((await call('POST', `/api/v1/servers/${id}/update-game`, MASTER, {})).statusCode).toBe(202); // Standard: mit Backup
    expect(await finished(id)).toBe(true);
    expect(taskOf(id)?.status).toBe('done');
    const list = (await call('GET', `/api/v1/servers/${id}/backups`)).json();
    const names = (list.backups as Array<{ name: string }>).map((b) => b.name);
    expect(names.some((n) => n.includes('Vor Server-Update'))).toBe(true);
    docker.containers.get(`nxc-${id}`)?.exit(0);
  });

  it('ohne Netz: das vorhandene Image wird benutzt, das Update läuft trotzdem durch', async () => {
    const id = await createMinecraft('Update Offline');
    docker.pullFails = true;
    try {
      expect((await call('POST', `/api/v1/servers/${id}/update-game`, MASTER, { backup: false, startAfter: false })).statusCode).toBe(202);
      expect(await finished(id)).toBe(true);
      expect(taskOf(id)?.status).toBe('done');
      expect(consoleLines.some((l) => l.includes('vorhandene wird benutzt'))).toBe(true);
    } finally {
      docker.pullFails = false;
    }
  });

  it('Spiel mit Installationsskript: das Skript läuft erneut; scheitert es, steht der Fehler da', async () => {
    docker.installer = { lines: ['[installer] fertig'], code: 0 };
    const created = await call('POST', '/api/v1/servers', MASTER, { name: 'Update GMod', eggId: 'garrys-mod', ramMb: 2048 });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().server.id as string;
    expect(await until(() => registry.get(id)?.install?.state === 'done')).toBe(true);
    const runs = () => docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === id).length;
    expect(runs()).toBe(1);

    expect((await call('POST', `/api/v1/servers/${id}/update-game`, MASTER, { backup: false, startAfter: false })).statusCode).toBe(202);
    expect(await finished(id)).toBe(true);
    expect(runs()).toBe(2);
    expect(taskOf(id)?.status).toBe('done');
    expect(registry.get(id)?.install?.state).toBe('done');

    // jetzt scheitert das Skript
    docker.installer = { lines: ['[installer] Platte voll'], code: 7 };
    expect((await call('POST', `/api/v1/servers/${id}/update-game`, MASTER, { backup: false, startAfter: false })).statusCode).toBe(202);
    expect(await until(() => taskOf(id)?.status === 'failed')).toBe(true);
    expect(taskOf(id)?.message).toContain('Code 7');
    expect((await call('GET', '/api/v1/admin/audit?limit=100')).body).toContain('server.update_game_failed');
    docker.installer = { lines: ['ok'], code: 0 };
  });

  it('abgelehnt: unbekannter Server, Server ohne Installation durch den Core, laufendes Update, ungültige Angabe', async () => {
    expect((await call('POST', '/api/v1/servers/gibtsnicht/update-game', MASTER, {})).statusCode).toBe(404);
    const plain = path.join(dir, 'servers', 'plain-1');
    await fs.mkdir(plain, { recursive: true });
    await registry.add({ id: 'plain-1', name: 'Alt', game: 'x', executable: 'x', args: [], workingDir: plain, ports: [] });
    const na = await call('POST', '/api/v1/servers/plain-1/update-game', MASTER, {});
    expect(na.statusCode).toBe(400);
    expect(na.json().code).toBe('not_supported');
    const id = await createMinecraft('Update Besetzt');
    expect((await call('POST', `/api/v1/servers/${id}/update-game`, MASTER, { backup: 'ja' })).statusCode).toBe(400);
    const first = call('POST', `/api/v1/servers/${id}/update-game`, MASTER, { backup: false, startAfter: false });
    const second = call('POST', `/api/v1/servers/${id}/update-game`, MASTER, { backup: false, startAfter: false });
    const codes = (await Promise.all([first, second])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 409]);
    await finished(id);
  });

  it('Rechte: das Backup vorab braucht backup.create - ohne Backup reicht control.restart', async () => {
    const id = await createMinecraft('Update Rechte');
    const mk = await call('POST', '/api/v1/admin/users', MASTER, { username: 'upd-user', password: PW });
    const userId = mk.json().user.id as string;
    await call('PUT', `/api/v1/admin/users/${userId}/servers/${id}`, MASTER, { permissions: ['control.restart'] });
    const login = await call('POST', '/api/v1/auth/login', json, { login: 'upd-user', password: PW });
    const user = { authorization: `Bearer ${login.json().accessToken}`, ...json };
    const withBackup = await call('POST', `/api/v1/servers/${id}/update-game`, user, { backup: true });
    expect(withBackup.statusCode, withBackup.body).toBe(403);
    expect(withBackup.json().message ?? withBackup.json().error).toContain('backup.create');
    expect((await call('POST', `/api/v1/servers/${id}/update-game`, user, { backup: false, startAfter: false })).statusCode).toBe(202);
    await finished(id);
    // ein Fremder kommt gar nicht erst heran
    await call('POST', '/api/v1/admin/users', MASTER, { username: 'upd-fremd', password: PW });
    const other = await call('POST', '/api/v1/auth/login', json, { login: 'upd-fremd', password: PW });
    expect((await call('POST', `/api/v1/servers/${id}/update-game`, { authorization: `Bearer ${other.json().accessToken}`, ...json }, {})).statusCode).toBe(404);
  });

  it('die Oberfläche erfährt, dass es Updates gibt - nur mit dem Docker- oder Installationsweg', async () => {
    expect((await call('GET', '/api/v1/about')).json().features).toContain('updates');
    const mock = new MockDriver();
    await mock.initialize();
    expect(typeof (mock as unknown as { pullImage?: unknown }).pullImage).toBe('undefined');
  });
});
