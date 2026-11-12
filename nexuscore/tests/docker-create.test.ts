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
const { FakeDocker } = await import('./helpers/fake-docker.js');

const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', 'content-type': 'application/json' };

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
let docker: InstanceType<typeof FakeDocker>;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-dockercreate-'));
  registry = await ServerRegistry.open(dir);
  docker = new FakeDocker();
  const driver = new DockerDriver(docker);
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
});
afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Server anlegen mit Docker-Treiber', () => {
  it('legt aus dem Egg einen Container-Server an, startet ihn und nimmt ihn beim Löschen wieder weg', async () => {
    const created = await server.inject({ method: 'POST', url: '/api/v1/servers', headers: MASTER, payload: { name: 'Docker Test', eggId: 'minecraft-paper', ramMb: 2048, variables: { EULA: 'TRUE' } } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().server.id as string;

    const saved = registry.get(id)!;
    expect(saved.container?.image).toMatch(/^itzg\/minecraft-server:java/);
    expect(saved.container?.dataDir).toBe('/data');
    expect(saved.workingDir).toBe(path.join(dir, 'servers', id));
    expect(saved.env).toMatchObject({ EULA: 'TRUE', STARTUP: '/start' });
    expect(saved.ports.length).toBe(1); // RCON ist intern
    expect(saved.stopCommand).toBe('stop');

    const started = await server.inject({ method: 'POST', url: `/api/v1/servers/${id}/power`, headers: MASTER, payload: { action: 'start' } });
    expect(started.statusCode, started.body).toBeLessThan(300);
    const c = docker.containers.get(`nxc-${id}`)!;
    expect(c).toBeTruthy();
    expect((c.options as any).HostConfig.Mounts[0]).toEqual({ Type: 'bind', Source: path.join(dir, 'servers', id), Target: '/data' });

    const cmd = await server.inject({ method: 'POST', url: `/api/v1/servers/${id}/command`, headers: MASTER, payload: { command: 'say hi' } });
    expect(cmd.statusCode, cmd.body).toBeLessThan(300);
    expect(c.stdinWrites.at(-1)).toBe('say hi\n');

    c.exit(0);
    await new Promise((r) => setTimeout(r, 30));
    const del = await server.inject({ method: 'DELETE', url: `/api/v1/servers/${id}`, headers: MASTER, payload: {} });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect(docker.containers.has(`nxc-${id}`)).toBe(false);
  });

  it('unbekanntes Spiel: klare Antwort statt Platzhalter-Server', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/servers', headers: MASTER, payload: { name: 'X', eggId: 'gibtsnicht' } });
    expect(res.statusCode).toBe(404);
  });
});
