import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { PlayerManager, PLAYER_NAME } = await import('../src/players/manager.js');
const { serverListPing } = await import('../src/games/minecraft.js');

let server: Awaited<ReturnType<typeof createCoreServer>>;
let registry: InstanceType<typeof ServerRegistry>;
let driver: InstanceType<typeof MockDriver>;
let dataDir: string;
let dir: string;
let auth: Record<string, string>;
const json = { 'content-type': 'application/json' };
const sent: string[] = [];

/** Der Mock braucht je eine Sekunde zum Starten und Stoppen - die Tests setzen den Zustand direkt. */
function force(id: string, status: 'running' | 'offline'): void {
  const entry = (driver as any).instances.get(id);
  for (const timer of entry.timers) clearTimeout(timer);
  entry.timers = [];
  entry.state.status = status;
}

const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers = auth) =>
  server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

/** Ein Minecraft-Server, der nur die Serverliste beantwortet. */
function fakeMinecraft(status: object): Promise<{ port: number; close: () => void }> {
  const varint = (n: number) => {
    const out: number[] = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return Buffer.from(out);
  };
  const frame = (p: Buffer) => Buffer.concat([varint(p.length), p]);
  const srv = net.createServer((sock) => {
    let step = 0;
    sock.on('data', (d) => {
      // 1. Paket Handshake+Status-Anfrage (kommen oft zusammen), danach das Ping-Paket
      if (step === 0) {
        step = 1;
        const text = Buffer.from(JSON.stringify(status));
        sock.write(frame(Buffer.concat([varint(0), varint(text.length), text])));
      } else if (step === 1 && d.length > 0) {
        step = 2;
        sock.write(frame(Buffer.concat([varint(1), Buffer.alloc(8)])));
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() })));
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-pl-'));
  dir = path.join(dataDir, 'servers', 'pl-1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'banned-players.json'), JSON.stringify([{ uuid: 'u-1', name: 'Griefer', created: '2026-11-10', source: 'Console', reason: 'Zerstört' }]));
  await fs.writeFile(path.join(dir, 'whitelist.json'), JSON.stringify([{ name: 'Alex' }, { name: 'Steve' }]));
  await fs.writeFile(path.join(dir, 'ops.json'), JSON.stringify([{ name: 'Admin', level: 4 }]));

  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  const original = driver.sendCommand.bind(driver);
  driver.sendCommand = async (id: string, cmd: string) => {
    await original(id, cmd);
    sent.push(cmd);
  };
  server = await createCoreServer(driver, new EventBus(), registry, {
    installs: null,
    ping: async () => ({ version: 'Paper 1.21', protocol: 767, players: { online: 2, max: 20, sample: ['Alex', 'Steve'] }, motd: 'Hallo', favicon: null, latencyMs: 12 }),
  });
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
  for (const [id, game, wd] of [['pl-1', 'minecraft-paper', dir], ['pl-other', 'rust', dir]] as const) {
    const config = { id, name: id, game, executable: 'x', args: [], workingDir: wd, ports: [{ hostPort: 25565, containerPort: 25565, protocol: 'tcp' as const }] };
    await registry.add(config);
    await driver.registerServer(config);
  }
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Server List Ping', () => {
  it('liest Version, Spieler, MOTD und Antwortzeit von einem echten Socket', async () => {
    const fake = await fakeMinecraft({ version: { name: 'Paper 1.21', protocol: 767 }, players: { online: 1, max: 10, sample: [{ name: 'Alex' }] }, description: { text: 'Willkommen', color: 'gold' } });
    try {
      const r = await serverListPing('127.0.0.1', fake.port, 2000);
      expect(r).toMatchObject({ version: 'Paper 1.21', players: { online: 1, max: 10, sample: ['Alex'] }, motd: '§6Willkommen' });
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      fake.close();
    }
  });

  it('meldet einen Fehler, wenn niemand antwortet', async () => {
    await expect(serverListPing('127.0.0.1', 1, 500)).rejects.toThrow();
  });
});

describe('Spieler-Routen', () => {
  it('Merkmal und Rechte sind sichtbar; ohne Anmeldung 401', async () => {
    expect(JSON.stringify((await call('GET', '/api/v1/servers/pl-1')).json())).toContain('player.ban');
    expect((await call('GET', '/api/v1/servers/pl-1/players/lists', undefined, {})).statusCode).toBe(401);
  });

  it('Listen kommen aus den Dateien, auch bei gestopptem Server', async () => {
    const res = (await call('GET', '/api/v1/servers/pl-1/players/lists')).json();
    expect(res.whitelist).toEqual(['Alex', 'Steve']);
    expect(res.ops).toEqual(['Admin']);
    expect(res.bans[0]).toMatchObject({ name: 'Griefer', id: 'u-1', reason: 'Zerstört', by: 'Console', until: null });
  });

  it('Live-Zustand: gestoppt nur "running: false", laufend mit Spielern und Möglichkeiten', async () => {
    expect((await call('GET', '/api/v1/servers/pl-1/game-status')).json()).toEqual({ kind: 'minecraft', running: false });
    force('pl-1', 'running');
    const live = (await call('GET', '/api/v1/servers/pl-1/game-status')).json();
    expect(live).toMatchObject({ running: true, kind: 'minecraft', rcon: true, max: 20, version: 'Paper 1.21', latencyMs: 12 });
    expect(live.people).toEqual([{ name: 'Alex' }, { name: 'Steve' }]);
    expect(live.actions).toEqual(expect.arrayContaining(['kick', 'ban', 'whitelist_add']));
  });

  it('Aktionen schicken die passenden Konsolenbefehle', async () => {
    sent.length = 0;
    const act = (body: object) => call('POST', '/api/v1/servers/pl-1/players/action', body);
    expect((await act({ action: 'kick', name: 'Alex', reason: 'AFK' })).statusCode).toBe(200);
    expect((await act({ action: 'ban', name: 'Steve', reason: 'Hacks' })).statusCode).toBe(200);
    expect((await act({ action: 'pardon', name: 'Steve' })).statusCode).toBe(200);
    expect((await act({ action: 'op', name: 'Alex' })).statusCode).toBe(200);
    expect((await act({ action: 'deop', name: 'Alex' })).statusCode).toBe(200);
    expect((await act({ action: 'whitelist_add', name: 'Neu_1' })).statusCode).toBe(200);
    expect((await act({ action: 'whitelist_remove', name: 'Neu_1' })).statusCode).toBe(200);
    expect(sent).toEqual(['kick Alex AFK', 'ban Steve Hacks', 'pardon Steve', 'op Alex', 'deop Alex', 'whitelist add Neu_1', 'whitelist remove Neu_1']);
    expect(registry.recentAudit({ serverId: 'pl-1' }).some((a) => a.action === 'player.ban')).toBe(true);
  });

  it('Befehls-Einschleusung scheitert: Namen und Gründe werden geprüft', async () => {
    sent.length = 0;
    const act = (body: object) => call('POST', '/api/v1/servers/pl-1/players/action', body);
    for (const name of ['Alex op Mallory', 'a', 'x;stop', 'Alex\nstop', 'ThisNameIsFarTooLongForMc', 'Ä_ö']) {
      expect((await act({ action: 'op', name })).statusCode, name).toBe(400);
    }
    expect((await act({ action: 'kick', name: 'Alex', reason: 'x\nstop' })).statusCode).toBe(400);
    expect((await act({ action: 'tp', name: 'Alex' })).statusCode).toBe(400);
    expect(sent).toEqual([]);
    expect(PLAYER_NAME.test('Alex_01')).toBe(true);
  });

  it('Aktionen brauchen einen laufenden Server', async () => {
    force('pl-1', 'offline');
    const res = await call('POST', '/api/v1/servers/pl-1/players/action', { action: 'kick', name: 'Alex' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('must_run');
  });

  it('andere Spiele und unbekannte Server', async () => {
    expect((await call('GET', '/api/v1/servers/pl-other/game-status')).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/servers/pl-other/players/lists')).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/servers/pl-other/players/action', { action: 'kick', name: 'Alex' })).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/servers/gibt-es-nicht/players/lists')).statusCode).toBe(404);
  });

  it('Listen folgen keiner Verknüpfung nach draußen', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-pl-out-'));
    await fs.writeFile(path.join(outside, 'secret.json'), JSON.stringify([{ name: 'Geheim' }]));
    const link = path.join(dir, 'ops.json');
    await fs.rm(link);
    try {
      await fs.symlink(path.join(outside, 'secret.json'), link);
    } catch {
      await fs.rm(outside, { recursive: true, force: true });
      return; // Windows ohne Symlink-Recht
    }
    const res = (await call('GET', '/api/v1/servers/pl-1/players/lists')).json();
    expect(res.ops).toEqual([]);
    await fs.rm(link);
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe('Bann auf Zeit', () => {
  it('wird nach Ablauf aufgehoben, solange der Server läuft', async () => {
    let now = new Date(2026, 10, 11, 10, 0, 0);
    const manager = new PlayerManager({ registry, driver, now: () => now });
    force('pl-1', 'running');
    sent.length = 0;
    await manager.act('pl-1', { action: 'ban', name: 'Zeitweise', minutes: 30 });
    expect((await manager.lists('pl-1')).bans.map((b) => b.name)).not.toContain('Zeitweise'); // der echte Server schreibt die Datei, der Mock nicht
    expect(await manager.tick()).toBe(0);
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await manager.tick()).toBe(1);
    expect(sent).toEqual(['ban Zeitweise', 'pardon Zeitweise']);
    expect(await manager.tick()).toBe(0);
  });

  it('bleibt vorgemerkt, wenn der Server aus ist', async () => {
    let now = new Date(2026, 10, 11, 10, 0, 0);
    const manager = new PlayerManager({ registry, driver, now: () => now });
    force('pl-1', 'running');
    await manager.act('pl-1', { action: 'ban', name: 'Spaeter', minutes: 5 });
    force('pl-1', 'offline');
    now = new Date(now.getTime() + 10 * 60_000);
    expect(await manager.tick()).toBe(0);
    force('pl-1', 'running');
    sent.length = 0;
    expect(await manager.tick()).toBe(1);
    expect(sent).toEqual(['pardon Spaeter']);
  });
});
