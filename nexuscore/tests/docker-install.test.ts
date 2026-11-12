import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { DockerDriver } = await import('../src/drivers/docker-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { applyConfigFiles } = await import('../src/docker/config-apply.js');
const { FakeDocker } = await import('./helpers/fake-docker.js');
const { containerInstallPlan } = await import('../src/install/manager.js');
const { loadEggs } = await import('../src/eggs/loader.js');

const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', 'content-type': 'application/json' };

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
let docker: InstanceType<typeof FakeDocker>;
let driver: InstanceType<typeof DockerDriver>;
const bus = new EventBus();

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  server.inject({ method, url, headers: MASTER, ...(payload === undefined ? {} : { payload: payload as object }) });

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-dockerinstall-'));
  registry = await ServerRegistry.open(dir);
  docker = new FakeDocker();
  driver = new DockerDriver(docker);
  await driver.initialize();
  server = await createCoreServer(driver, bus, registry, { scheduler: false });
});
afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Installationsplan', () => {
  it('Eggs mit Installationsskript brauchen den Installer-Container, Minecraft (itzg) nicht', async () => {
    const eggs = await loadEggs();
    expect(containerInstallPlan(eggs.find((e) => e.id === 'minecraft-paper')?.raw)).toBeNull();
    const withScript = eggs.filter((e) => containerInstallPlan(e.raw));
    expect(withScript.length).toBeGreaterThan(15);
    expect(containerInstallPlan(undefined)).toBeNull();
  });

  it('der Spielekatalog meldet für Docker jedes Spiel mit Image als installierbar', async () => {
    const res = await call('GET', '/api/v1/eggs');
    const eggs = res.json().eggs as Array<{ id: string; installable: boolean }>;
    expect(eggs.length).toBeGreaterThan(30);
    expect(eggs.find((e) => e.id === 'garrys-mod')?.installable).toBe(true);
    expect(eggs.find((e) => e.id === 'minecraft-paper')?.installable).toBe(true);
  });
});

describe('Server mit Installationsskript (Docker)', () => {
  let id = '';

  it('legt an, führt das Skript im Installer-Container aus und meldet den Server danach beim Treiber an', async () => {
    docker.installer = { lines: ['[installer] SteamCMD lädt Garrys Mod', '[installer] fertig'], code: 0 };
    const created = await call('POST', '/api/v1/servers', { name: 'GMod Test', eggId: 'garrys-mod', ramMb: 2048 });
    expect(created.statusCode, created.body).toBe(201);
    id = created.json().server.id as string;
    expect(created.json().taskId).toBeTruthy();
    expect(registry.get(id)?.install).toMatchObject({ state: 'installing', kind: 'container' });
    // Solange installiert wird, kennt der Treiber den Server noch nicht
    const lines: string[] = [];
    bus.on((e) => {
      const ev = e as { type: string; serverId?: string; line?: string };
      if (ev.type === 'console' && ev.serverId === id && ev.line) lines.push(ev.line);
    });

    expect(await until(() => registry.get(id)?.install?.state === 'done')).toBe(true);
    // Die Ausgabe des Skripts steht in der Konsole des Servers
    expect(lines).toContain('[Installation] [installer] fertig');
    const installer = docker.created.find((o) => o.Labels?.['nexuscore.installer'] === id)!;
    expect(installer).toBeTruthy();
    expect(installer.Entrypoint).toEqual(['/bin/bash', '-c']);
    expect(installer.Image).toBe('ghcr.io/parkervcp/installers:debian');
    expect(installer.Env).toEqual(expect.arrayContaining(['SERVER_DIR=/mnt/server']));
    expect(installer.HostConfig.Mounts).toEqual([{ Type: 'bind', Source: path.join(dir, 'servers', id), Target: '/mnt/server' }]);
    expect(installer.HostConfig.CapDrop).toEqual(['ALL']);
    expect(installer.HostConfig.PidsLimit).toBe(512);
    // Platzhalter im Skript sind aufgelöst, es steht kein {{...}} mehr darin
    expect(installer.Cmd[0]).not.toMatch(/\{\{/);
    // Der Installer-Container ist wieder weg
    expect([...docker.containers.keys()].some((n) => n.startsWith('nxc-install-'))).toBe(false);
    // Danach ist der Server startbar
    const state = (await call('GET', `/api/v1/servers/${id}`)).json();
    expect(state.server.status).toBe('offline');
    const started = await call('POST', `/api/v1/servers/${id}/power`, { action: 'start' });
    expect(started.statusCode, started.body).toBeLessThan(300);
    const game = docker.containers.get(`nxc-${id}`)!;
    expect((game.options as any).Env).toEqual(expect.arrayContaining([expect.stringMatching(/^STARTUP=\.\/srcds_run /)]));
    expect(String((game.options as any).Env.find((e: string) => e.startsWith('STARTUP=')))).not.toMatch(/\{\{/);
    game.exit(0);
    await new Promise((r) => setTimeout(r, 30));
  });

  it('Neuinstallieren: nur bei gestopptem Server, läuft das Skript erneut', async () => {
    const before = docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === id).length;
    const res = await call('POST', `/api/v1/servers/${id}/reinstall`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(await until(() => registry.get(id)?.install?.state === 'done' && docker.created.filter((o) => o.Labels?.['nexuscore.installer'] === id).length === before + 1)).toBe(true);
  });

  it('ein fehlgeschlagenes Skript macht die Installation als fehlgeschlagen sichtbar - mit dem Code', async () => {
    docker.installer = { lines: ['[installer] Fehler: Platte voll'], code: 7 };
    const created = await call('POST', '/api/v1/servers', { name: 'GMod Kaputt', eggId: 'garrys-mod' });
    expect(created.statusCode, created.body).toBe(201);
    const bad = created.json().server.id as string;
    expect(await until(() => registry.get(bad)?.install?.state === 'failed')).toBe(true);
    expect(registry.get(bad)?.install?.error).toContain('Code 7');
    const task = registry.listTasks().find((t) => t.serverId === bad);
    expect(task?.status).toBe('failed');
    // Der Installer-Container wird auch bei Fehler entfernt
    expect([...docker.containers.keys()].some((n) => n.startsWith('nxc-install-'))).toBe(false);
    docker.installer = { lines: ['ok'], code: 0 };
  });
});

describe('Einstellungen eines Docker-Servers', () => {
  let id = '';
  beforeAll(async () => {
    const created = await call('POST', '/api/v1/servers', { name: 'MC Einstellungen', eggId: 'minecraft-paper', ramMb: 2048, variables: { EULA: 'TRUE' } });
    expect(created.statusCode, created.body).toBe(201);
    id = created.json().server.id as string;
  });

  it('Spiel-Einstellungen: Umgebung und Startkommando werden neu berechnet, Image lässt sich wählen', async () => {
    const info = (await call('GET', `/api/v1/servers/${id}/startup`)).json();
    expect(info.images.length).toBe(4);
    expect(info.images.filter((i: { current: boolean }) => i.current).length).toBe(1);

    const java17 = info.images.find((i: { image: string }) => i.image.endsWith(':java17'));
    const res = await call('PATCH', `/api/v1/servers/${id}/startup`, { variables: { MOTD: 'Hallo Welt', MAX_PLAYERS: '12' }, imageKey: java17.key });
    expect(res.statusCode, res.body).toBe(200);
    const saved = registry.get(id)!;
    expect(saved.container?.image).toMatch(/:java17$/);
    expect(saved.env).toMatchObject({ MOTD: 'Hallo Welt', MAX_PLAYERS: '12', SERVER_MEMORY: '2048', STARTUP: '/start' });
    expect((await call('GET', `/api/v1/servers/${id}/startup`)).json().images.find((i: { current: boolean }) => i.current).image).toMatch(/:java17$/);
    // Ein Image, das es für das Spiel nicht gibt
    expect((await call('PATCH', `/api/v1/servers/${id}/startup`, { imageKey: 'gibtsnicht' })).statusCode).toBe(400);
    // Beim nächsten Start gilt das neue Image
    await call('POST', `/api/v1/servers/${id}/power`, { action: 'start' });
    expect(docker.containers.get(`nxc-${id}`)!.options.Image).toMatch(/:java17$/);
    docker.containers.get(`nxc-${id}`)!.exit(0);
    await new Promise((r) => setTimeout(r, 30));
  });

  it('Speicher ändern: SERVER_MEMORY und der Container-Grenzwert folgen', async () => {
    const res = await call('PATCH', `/api/v1/servers/${id}/resources`, { ramMb: 4096 });
    expect(res.statusCode, res.body).toBe(200);
    expect(registry.get(id)!.env?.SERVER_MEMORY).toBe('4096');
    await call('POST', `/api/v1/servers/${id}/power`, { action: 'start' });
    expect((docker.containers.get(`nxc-${id}`)!.options as any).HostConfig.Memory).toBe(4096 * 1024 * 1024);
    docker.containers.get(`nxc-${id}`)!.exit(0);
    await new Promise((r) => setTimeout(r, 30));
  });

  it('Konfigurationsdatei des Eggs (server.properties) wird vor dem Start mit Port und Werten geschrieben', async () => {
    const file = path.join(dir, 'servers', id, 'server.properties');
    await fs.writeFile(file, '# vom Nutzer\nmotd=alt\nmeine-einstellung=bleibt\n');
    await call('POST', `/api/v1/servers/${id}/power`, { action: 'start' });
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain('# vom Nutzer'); // Kommentare bleiben
    expect(text).toContain('meine-einstellung=bleibt'); // fremde Schlüssel bleiben
    expect(text).toMatch(/motd=Hallo Welt/);
    expect(text).toMatch(/server-port=\d+/);
    docker.containers.get(`nxc-${id}`)!.exit(0);
    await new Promise((r) => setTimeout(r, 30));
  });
});

describe('Konfigurationsdateien: Sicherheit', () => {
  it('Pfade aus dem Egg bleiben im Server-Ordner - alles andere wird übersprungen', async () => {
    const root = path.join(dir, 'cfg-root');
    await fs.mkdir(root, { recursive: true });
    const outside = path.join(dir, 'ausserhalb.cfg');
    await fs.writeFile(outside, 'a=1\n');
    const said: string[] = [];
    const ctx = { variables: {}, ramMb: 1, ip: '0.0.0.0', port: 1, ports: {}, serverDir: '/data', serverName: 'x' };
    await applyConfigFiles(root, { '../ausserhalb.cfg': { parser: 'properties', find: { a: '2' } }, 'innen/ok.cfg': { parser: 'properties', find: { b: '3' } } }, ctx, (l) => said.push(l));
    expect(await fs.readFile(outside, 'utf8')).toBe('a=1\n');
    expect(await fs.readFile(path.join(root, 'innen', 'ok.cfg'), 'utf8')).toContain('b=3');
    expect(said.some((l) => l.includes('außerhalb'))).toBe(true);
  });

  it('ein kaputtes Datenbank-Setting oder eine unlesbare Datei verhindert den Start nicht', async () => {
    const root = path.join(dir, 'cfg-root2');
    await fs.mkdir(path.join(root, 'ordner.cfg'), { recursive: true }); // ein Ordner statt einer Datei
    const said: string[] = [];
    const ctx = { variables: {}, ramMb: 1, ip: '0.0.0.0', port: 1, ports: {}, serverDir: '/data', serverName: 'x' };
    await expect(applyConfigFiles(root, { 'ordner.cfg': { parser: 'properties', find: { a: '1' } } }, ctx, (l) => said.push(l))).resolves.toBeUndefined();
    expect(said.length).toBeGreaterThan(0);
  });
});
