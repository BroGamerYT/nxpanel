import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  buildContainerOptions,
  containerName,
  DockerDriver,
  grantedCaps,
} from '../src/drivers/docker-driver.js';
import { buildDockerInstance, EggContainerError } from '../src/docker/egg-container.js';
import { FakeDocker } from './helpers/fake-docker.js';
import { loadEggs, resetEggCache } from '../src/eggs/loader.js';
import type { LogLine, ServerInstanceConfig } from '../src/types.js';

// Ein echter, beschreibbarer Ordner: der Treiber legt den Datenordner an (auf Linux ohne Rechte scheitert ein Pfad wie /srv/...)
const WORK = path.join(os.tmpdir(), 'nx-docker-driver-test', 'mc-1');

const base = (extra: Partial<ServerInstanceConfig> = {}): ServerInstanceConfig => ({
  id: 'mc-1',
  name: 'Minecraft',
  game: 'minecraft-paper',
  executable: 'itzg/minecraft-server:java21',
  args: [],
  workingDir: WORK,
  maxMemoryMb: 2048,
  maxCpuPercent: 200,
  ports: [{ name: 'game', hostPort: 25565, containerPort: 25565, protocol: 'tcp' }],
  env: { EULA: 'TRUE' },
  container: { image: 'itzg/minecraft-server:java21', dataDir: '/data', capAdd: ['CHOWN'] },
  ...extra,
});

async function wait(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------ Container-Optionen

describe('Container-Optionen (wie im Panel)', () => {
  it('Ordner als Bind-Mount, harte Grenzen, kein Docker-Neustart, Konsole über stdin', () => {
    const o = buildContainerOptions(base(), { network: 'nexuscore-games' }) as Record<string, any>;
    expect(o.name).toBe('nxc-mc-1');
    expect(o.Image).toBe('itzg/minecraft-server:java21');
    expect(o.WorkingDir).toBeUndefined(); // wie im Panel: das Arbeitsverzeichnis des Images gilt
    expect(o.OpenStdin).toBe(true);
    expect(o.Env).toEqual(['EULA=TRUE']);
    expect(o.Cmd).toBeUndefined();
    expect(o.HostConfig.Mounts).toEqual([{ Type: 'bind', Source: WORK, Target: '/data' }]);
    expect(o.HostConfig.Memory).toBe(2048 * 1024 * 1024);
    expect(o.HostConfig.MemorySwap).toBe(o.HostConfig.Memory); // kein Swap
    expect(o.HostConfig.CpuQuota).toBe(200_000);
    expect(o.HostConfig.PidsLimit).toBe(512);
    expect(o.HostConfig.RestartPolicy).toEqual({ Name: 'no' });
    expect(o.HostConfig.NetworkMode).toBe('nexuscore-games');
    expect(o.HostConfig.PortBindings).toEqual({ '25565/tcp': [{ HostPort: '25565' }] });
    expect(o.HostConfig.LogConfig.Config['max-size']).toBe('10m');
    expect(o.Labels).toEqual({ 'nexuscore.server': 'mc-1' });
  });

  it('alle Linux-Rechte weg, nur die Erlaubnisliste kommt zurück - was das Egg sonst verlangt, wird verworfen', () => {
    const o = buildContainerOptions(base({ container: { image: 'x', dataDir: '/data', capAdd: ['SYS_ADMIN', 'cap_net_admin', 'SYS_PTRACE', 'CHOWN'] } })) as Record<string, any>;
    expect(o.HostConfig.CapDrop).toEqual(['ALL']);
    expect(o.HostConfig.CapAdd).toEqual(expect.arrayContaining(['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'NET_BIND_SERVICE']));
    for (const bad of ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE']) expect(o.HostConfig.CapAdd).not.toContain(bad);
    expect(grantedCaps(['sys_module'])).not.toContain('SYS_MODULE');
  });

  it('Benutzer, Einstiegspunkt, /tmp im Arbeitsspeicher und UDP-Port', () => {
    const o = buildContainerOptions(
      base({ ports: [{ name: 'game', hostPort: 8211, containerPort: 8211, protocol: 'udp' }], container: { image: 'x', dataDir: '/home/container', user: '1000:1000', entrypoint: ['/bin/sh', '-c'], tmpfsMb: 256 } }),
    ) as Record<string, any>;
    expect(o.User).toBe('1000:1000');
    expect(o.Entrypoint).toEqual(['/bin/sh', '-c']);
    expect(o.HostConfig.Tmpfs).toEqual({ '/tmp': 'rw,size=256m' });
    expect(o.HostConfig.PortBindings).toEqual({ '8211/udp': [{ HostPort: '8211' }] });
  });

  it('ohne Grenzen und ohne Datenordner keine leeren Angaben; ältere Instanzen: executable ist das Image', () => {
    const o = buildContainerOptions({ id: 'alt 1', name: 'a', game: 'x', executable: 'nginx', args: ['-g', 'daemon off;'], workingDir: '', ports: [] }) as Record<string, any>;
    expect(o.name).toBe(containerName('alt 1'));
    expect(o.name).toBe('nxc-alt-1');
    expect(o.Image).toBe('nginx');
    expect(o.Cmd).toEqual(['-g', 'daemon off;']);
    expect(o.HostConfig.Memory).toBeUndefined();
    expect(o.HostConfig.CpuQuota).toBeUndefined();
    expect(o.HostConfig.Mounts).toBeUndefined();
  });
});

// ------------------------------------------------------------ Egg -> Container

describe('Egg zu Docker-Server', () => {
  it('Minecraft: Image, Variablen mit Platzhaltern, RCON bleibt intern', async () => {
    resetEggCache();
    const egg = (await loadEggs()).find((e) => e.id === 'minecraft-paper');
    expect(egg).toBeTruthy();
    const c = buildDockerInstance({
      id: 'mc-1',
      name: 'Mein Server',
      egg: egg!,
      serverDir: '/srv/mc-1',
      ramMb: 3072,
      cpuPercent: 200,
      variables: { EULA: 'TRUE', MOTD: 'Server {{SERVER_NAME}} auf {{SERVER_PORT}}', CF_API_KEY: '', MEMORY: '{{SERVER_MEMORY_HEAP}}M' },
      ports: [
        { name: 'game', hostPort: 25570, protocol: 'tcp' },
        { name: 'rcon', hostPort: 25580, protocol: 'tcp' },
      ],
    });
    expect(c.container?.image).toMatch(/^itzg\/minecraft-server:java/);
    expect(c.container?.dataDir).toBe('/data');
    // Nur der Spielport wird am Host freigegeben
    expect(c.ports).toEqual([{ name: 'game', hostPort: 25570, containerPort: 25570, protocol: 'tcp' }]);
    expect(c.env).toMatchObject({ EULA: 'TRUE', MOTD: 'Server Mein Server auf 25570', MEMORY: '2611M', SERVER_PORT: '25570', SERVER_MEMORY: '3072' });
    expect(c.env?.STARTUP).toBe('/start');
    expect(c.env).not.toHaveProperty('CF_API_KEY'); // leere optionale Variable bleibt weg
    expect(c.stopCommand).toBe('stop');
    expect(c.maxMemoryMb).toBe(3072);
    // Rechte nur aus der Erlaubnisliste
    expect(c.container?.capAdd).toEqual(['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER']);
  });

  it('Stop-Signal und Frist aus dem Egg; ein Port mit "both" bekommt TCP und UDP', async () => {
    const eggs = await loadEggs();
    const withSignal = eggs.find((e) => typeof e.raw.stop === 'object' && e.raw.stop?.method === 'SIGTERM' && e.raw.docker_images);
    expect(withSignal).toBeTruthy();
    const c = buildDockerInstance({ id: 's', name: 's', egg: withSignal!, serverDir: '/srv/s', ramMb: 1024, cpuPercent: 100, variables: {}, ports: [{ name: 'game', hostPort: 30000, protocol: 'udp' }] });
    expect(c.container?.stopSignal).toBe('SIGTERM');
    expect(c.stopTimeoutSeconds).toBeGreaterThanOrEqual(5);
    expect(c.stopCommand).toBeUndefined();

    const fake = { ...eggs[0]!, raw: { ...eggs[0]!.raw, ports: { primary: { ref: 'game', protocol: 'both' } } } };
    const both = buildDockerInstance({ id: 'b', name: 'b', egg: fake, serverDir: '/srv/b', ramMb: 512, cpuPercent: 50, variables: {}, ports: [{ name: 'game', hostPort: 31000, protocol: 'udp' }] });
    expect(both.ports.map((p) => p.protocol).sort()).toEqual(['tcp', 'udp']);
  });

  it('unbekanntes Image und unsichere Pfade werden nicht übernommen', async () => {
    const egg = (await loadEggs()).find((e) => e.id === 'minecraft-paper')!;
    const input = { id: 'x', name: 'x', egg, serverDir: '/srv/x', ramMb: 1024, cpuPercent: 100, variables: {}, ports: [{ name: 'game', hostPort: 25565, protocol: 'tcp' as const }] };
    expect(() => buildDockerInstance({ ...input, imageKey: 'gibtsnicht' })).toThrow(EggContainerError);
    const noImage = { ...egg, images: [] };
    expect(() => buildDockerInstance({ ...input, egg: noImage })).toThrow(/kein Docker-Image/);
    const evil = { ...egg, raw: { ...egg.raw, data_dir: '/etc', capabilities: ['SYS_ADMIN', 'CHOWN'] } };
    const c = buildDockerInstance({ ...input, egg: evil });
    expect(c.container?.dataDir).toBe('/home/container'); // Systempfade fallen auf den Standard zurück
    expect(c.container?.capAdd).toEqual(['CHOWN']);
  });
});

// ------------------------------------------------------------ Treiber mit Attrappe

describe('DockerDriver', () => {
  async function setup(extra: Partial<ServerInstanceConfig> = {}) {
    const docker = new FakeDocker();
    const driver = new DockerDriver(docker);
    const lines: LogLine[] = [];
    driver.setLogSink((l) => lines.push(l));
    await driver.initialize();
    await driver.registerServer(base(extra));
    return { docker, driver, lines };
  }

  it('startet: Image holen, Netz anlegen, Container mit den Grenzen, Konsole und Ausgabe', async () => {
    const { docker, driver, lines } = await setup();
    const state = await driver.startServer('mc-1');
    expect(state.status).toBe('running');
    expect(state.pid).toBe(4242);
    expect(docker.pulled).toEqual(['itzg/minecraft-server:java21']);
    expect(docker.networks.has('nexuscore-games')).toBe(true);
    const c = docker.containers.get('nxc-mc-1')!;
    expect((c.options as any).HostConfig.NetworkMode).toBe('nexuscore-games');
    expect(c.calls).toContain('start');
    // Ausgabe kommt zeilenweise an, auch über Blockgrenzen hinweg
    c.logStream.write('[Server] Done');
    c.logStream.write(' (3.2s)!\n[Server] Zweite Zeile\r\n');
    await wait();
    expect(lines.map((l) => l.line)).toEqual(expect.arrayContaining(['[Server] Done (3.2s)!', '[Server] Zweite Zeile']));
    // Konsole
    await driver.sendCommand('mc-1', 'say hallo\nop evil');
    expect(c.stdinWrites.join('')).toBe('say hallo op evil\n'); // keine eingeschmuggelte zweite Zeile
    // Zweiter Start tut nichts
    expect((await driver.startServer('mc-1')).status).toBe('running');
    expect(docker.containers.size).toBe(1);
  });

  it('lädt ein vorhandenes Image nicht erneut', async () => {
    const { docker, driver } = await setup();
    docker.images.add('itzg/minecraft-server:java21');
    await driver.startServer('mc-1');
    expect(docker.pulled).toEqual([]);
  });

  it('beendet mit dem Stop-Befehl des Spiels und meldet "offline", nicht "Absturz"', async () => {
    const { docker, driver } = await setup({ stopCommand: 'stop', stopTimeoutSeconds: 5 });
    await driver.startServer('mc-1');
    docker.containers.get('nxc-mc-1')!.exitOnStdin = 'stop';
    const state = await driver.stopServer('mc-1');
    expect(state.status).toBe('offline');
    expect(docker.containers.get('nxc-mc-1')!.stdinWrites).toEqual(['stop\n']);
    expect(docker.containers.get('nxc-mc-1')!.calls.some((c) => c.startsWith('stop:'))).toBe(false); // nicht hart
  });

  it('beendet mit dem Signal des Eggs', async () => {
    const { docker, driver } = await setup({ container: { image: 'i', dataDir: '/data', stopSignal: 'SIGTERM' }, stopTimeoutSeconds: 5 });
    await driver.startServer('mc-1');
    expect((await driver.stopServer('mc-1')).status).toBe('offline');
    expect(docker.containers.get('nxc-mc-1')!.calls).toContain('kill:SIGTERM');
  });

  it('wenn das Spiel nicht endet, beendet Docker es nach der Frist', async () => {
    const { docker, driver, lines } = await setup({ stopCommand: 'stop', stopTimeoutSeconds: 0.05 as unknown as number });
    await driver.startServer('mc-1');
    const state = await driver.stopServer('mc-1');
    expect(state.status).toBe('offline');
    expect(docker.containers.get('nxc-mc-1')!.calls).toContain('stop:10');
    expect(lines.some((l) => l.line.includes('nicht geendet'))).toBe(true);
  });

  it('Abbruch (kill) und Absturz: ein Ende mit Fehlercode ohne Stop-Wunsch ist "error"', async () => {
    const a = await setup();
    await a.driver.startServer('mc-1');
    expect((await a.driver.killServer('mc-1')).status).toBe('offline');

    const b = await setup();
    await b.driver.startServer('mc-1');
    b.docker.containers.get('nxc-mc-1')!.exit(1);
    await wait();
    const state = await b.driver.getServerState('mc-1');
    expect(state.status).toBe('error');
    expect(state.exitCode).toBe(1);
    expect(state.exitedAt).toBeTruthy();
    // sauberes Ende von selbst (Code 0) ist kein Absturz
    const c = await setup();
    await c.driver.startServer('mc-1');
    c.docker.containers.get('nxc-mc-1')!.exit(0);
    await wait();
    expect((await c.driver.getServerState('mc-1')).status).toBe('offline');
    // Nach einem Absturz lässt sich wieder starten (alter Container wird ersetzt)
    expect((await b.driver.startServer('mc-1')).status).toBe('running');
  });

  it('Kennzahlen: CPU, Speicher ohne Seitencache, Laufzeit', async () => {
    const { driver } = await setup();
    await driver.startServer('mc-1');
    const stats = await driver.getServerStats('mc-1');
    expect(stats.cpuPercent).toBe(80); // (200/1000) * 4 Kerne
    expect(stats.memoryMb).toBe(500);
    expect(stats.status).toBe('running');
  });

  it('Kennzahlen: gleichzeitige Anfragen teilen sich eine Messung, frische Werte kommen aus dem Zwischenspeicher', async () => {
    const { docker, driver } = await setup();
    await driver.startServer('mc-1');
    const container = docker.containers.get('nxc-mc-1')!;
    let calls = 0;
    const real = container.stats.bind(container);
    container.stats = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return real();
    };
    const [a, b, c] = await Promise.all([driver.getServerStats('mc-1'), driver.getServerStats('mc-1'), driver.getServerStats('mc-1')]);
    expect(calls).toBe(1);
    expect([a.cpuPercent, b.cpuPercent, c.cpuPercent]).toEqual([80, 80, 80]);
    await driver.getServerStats('mc-1'); // unter 2 s alt: keine neue Messung
    expect(calls).toBe(1);
  });

  it('Gaming-Modus: weniger CPU-Anteil und wieder normal', async () => {
    const { docker, driver } = await setup();
    expect(await driver.setPriority!('mc-1', 'low')).toBe(0); // läuft nicht: nichts zu tun
    await driver.startServer('mc-1');
    expect(await driver.setPriority!('mc-1', 'low')).toBe(1);
    await driver.setPriority!('mc-1', 'normal');
    const calls = docker.containers.get('nxc-mc-1')!.calls.filter((c) => c.startsWith('update:'));
    expect(calls).toEqual(['update:{"CpuShares":128}', 'update:{"CpuShares":1024}']);
  });

  it('übernimmt nach einem Neustart des Cores einen noch laufenden Container', async () => {
    const docker = new FakeDocker();
    const first = new DockerDriver(docker);
    await first.initialize();
    await first.registerServer(base());
    await first.startServer('mc-1');

    const second = new DockerDriver(docker); // neuer Core-Prozess, derselbe Docker
    await second.initialize();
    const state = await second.registerServer(base());
    expect(state.status).toBe('running');
    expect(state.startedAt).toBe('2026-11-12T10:00:00Z');
    await second.sendCommand('mc-1', 'list');
    await wait();
    expect(docker.containers.get('nxc-mc-1')!.stdinWrites.at(-1)).toBe('list\n');
    expect(docker.containers.size).toBe(1);
  });

  it('melden ab räumt den Container weg, ein laufender Server bleibt geschützt', async () => {
    const { docker, driver } = await setup();
    await driver.startServer('mc-1');
    await expect(driver.unregisterServer!('mc-1')).rejects.toThrow(/laufend/);
    await driver.killServer('mc-1');
    await driver.unregisterServer!('mc-1');
    expect(docker.containers.size).toBe(0);
    await expect(driver.startServer('mc-1')).rejects.toThrow(/nicht registriert/);
  });

  it('ohne Docker-Daemon: klare Meldung, Core läuft weiter', async () => {
    const docker = new FakeDocker();
    docker.pingFails = true;
    const driver = new DockerDriver(docker);
    await driver.initialize();
    await driver.registerServer(base());
    await expect(driver.startServer('mc-1')).rejects.toThrow(/Kein Docker-Daemon/);
    expect((await driver.listServers())[0]!.status).toBe('offline');
  });

  it('Befehle gehen nur an einen laufenden Server; beim Beenden des Cores stoppen alle laufenden', async () => {
    const { docker, driver } = await setup({ stopSignal: undefined, stopCommand: 'stop', stopTimeoutSeconds: 5 } as Partial<ServerInstanceConfig>);
    await expect(driver.sendCommand('mc-1', 'x')).rejects.toThrow(/laeuft nicht/);
    await driver.startServer('mc-1');
    docker.containers.get('nxc-mc-1')!.exitOnStdin = 'stop';
    await driver.shutdown();
    expect((await driver.getServerState('mc-1')).status).toBe('offline');
  });
});
