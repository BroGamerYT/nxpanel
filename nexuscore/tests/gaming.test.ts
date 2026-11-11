import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { createPowerOps } = await import('../src/ops/power.js');
const { GamingMode, consoleMessage, GamingError } = await import('../src/gaming/manager.js');

/** Ein Mock, der Prioritaeten und Konsolenbefehle merkt - und Start/Stopp sofort ausfuehrt. */
class FakeDriver extends MockDriver {
  priorities = new Map<string, string>();
  commands: Array<{ id: string; command: string }> = [];
  stopped: string[] = [];
  started: string[] = [];

  async setPriority(id: string, level: 'normal' | 'low'): Promise<number> {
    this.priorities.set(id, level);
    return 1;
  }
  async sendCommand(id: string, command: string): Promise<void> {
    this.commands.push({ id, command });
  }
  async stopServer(id: string) {
    this.stopped.push(id);
    const s = await this.getServerState(id);
    s.status = 'offline';
    return s;
  }
  async startServer(id: string) {
    this.started.push(id);
    const s = await this.getServerState(id);
    s.status = 'running';
    return s;
  }
}

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let driver: FakeDriver;
let bus: InstanceType<typeof EventBus>;

const add = async (id: string, status: 'running' | 'offline') => {
  const config = { id, name: id, game: 'minecraft-paper', executable: 'x', args: [], workingDir: dir, ports: [] };
  await registry.add(config);
  await driver.registerServer(config);
  (await driver.getServerState(id)).status = status;
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-gaming-'));
  registry = await ServerRegistry.open(dir);
  driver = new FakeDriver();
  await driver.initialize();
  bus = new EventBus();
});

afterAll(async () => {
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const make = (sleep?: (ms: number, signal: AbortSignal) => Promise<void>) =>
  new GamingMode({ registry, driver, power: createPowerOps({ registry, driver }), bus, ...(sleep ? { sleep } : {}) });
const instant = async () => {};

describe('Konsolenmeldung', () => {
  it('ist eine Zeile ohne Steuerzeichen und ohne führenden Schrägstrich (sonst wäre es ein Befehl)', () => {
    expect(consoleMessage('Hallo\nop Steve\r\n')).toBe('Hallo op Steve');
    expect(consoleMessage('/stop')).toBe('stop');
    expect(consoleMessage('  //  !kick')).toBe('kick');
    expect(consoleMessage('a'.repeat(500))).toHaveLength(200);
    expect(consoleMessage('\u0000\u001b[31mrot')).toBe('[31mrot');
  });
});

describe('Gaming-Modus: drosseln', () => {
  it('senkt die Priorität der laufenden Instanzen und stellt sie danach zurück', async () => {
    await add('t-run', 'running');
    await add('t-off', 'offline');
    const g = make();
    const state = await g.activate({ mode: 'throttle' });
    expect(state).toMatchObject({ active: true, mode: 'throttle', phase: 'on' });
    expect(state.affected).toEqual(['t-run']);
    expect(driver.priorities.get('t-run')).toBe('low');
    expect(driver.priorities.has('t-off')).toBe(false);
    expect(g.state().active).toBe(true);
    // Doppelt einschalten geht nicht
    await expect(g.activate({ mode: 'throttle' })).rejects.toThrow(/schon an/);
    const off = await g.deactivate();
    expect(off.restarted).toEqual([]);
    expect(driver.priorities.get('t-run')).toBe('normal');
    expect(g.state()).toMatchObject({ active: false, phase: 'off' });
    await expect(g.deactivate()).rejects.toThrow(/nicht an/);
  });

  it('eine später gestartete Instanz wird auch gedrosselt', async () => {
    const g = make();
    g.start();
    await g.activate({ mode: 'throttle' });
    driver.priorities.delete('t-off');
    bus.emit({ type: 'state', serverId: 't-off', state: { id: 't-off', status: 'running' }, ts: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 1800));
    expect(driver.priorities.get('t-off')).toBe('low');
    g.stop();
    await g.deactivate();
  });

  it('der Zustand bleibt über einen Neustart des Cores erhalten', async () => {
    await make().activate({ mode: 'throttle' });
    expect(make().state()).toMatchObject({ active: true, mode: 'throttle' });
    await make().deactivate();
  });
});

describe('Gaming-Modus: stoppen mit Vorwarnung', () => {
  it('warnt die Spieler in der Konsole, stoppt, und startet beim Beenden genau diese wieder', async () => {
    driver.commands.length = 0;
    driver.stopped.length = 0;
    driver.started.length = 0;
    (await driver.getServerState('t-run')).status = 'running';
    (await driver.getServerState('t-off')).status = 'offline';
    const g = make(instant);
    const state = await g.activate({ mode: 'stop', warnSeconds: 60 });
    expect(state).toMatchObject({ active: true, mode: 'stop', warnSeconds: 60 });
    expect(state.affected).toEqual(['t-run']);
    await g.whenIdle();
    // zwei Warnungen (am Anfang und 10 Sekunden vor dem Stopp), dann der Stopp
    const says = driver.commands.filter((c) => c.id === 't-run');
    expect(says).toHaveLength(2);
    expect(says[0]!.command).toMatch(/^say .*60 Sekunden/);
    expect(says[1]!.command).toMatch(/^say .*10 Sekunden/);
    expect(driver.stopped).toEqual(['t-run']);
    expect(g.state().phase).toBe('on');

    const off = await g.deactivate();
    expect(off.restarted).toEqual(['t-run']);
    expect(driver.started).toEqual(['t-run']);
    expect(driver.started).not.toContain('t-off');
  });

  it('ohne Vorwarnung wird sofort gestoppt, ohne etwas zu sagen', async () => {
    driver.commands.length = 0;
    driver.stopped.length = 0;
    (await driver.getServerState('t-run')).status = 'running';
    const g = make(instant);
    await g.activate({ mode: 'stop', warnSeconds: 0 });
    await g.whenIdle();
    expect(driver.commands).toEqual([]);
    expect(driver.stopped).toEqual(['t-run']);
    await g.deactivate();
  });

  it('wer die Vorwarnung abbricht, stoppt nichts', async () => {
    driver.stopped.length = 0;
    driver.started.length = 0;
    (await driver.getServerState('t-run')).status = 'running';
    // Wartet, bis abgebrochen wird
    const g = make((_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve())));
    const state = await g.activate({ mode: 'stop', warnSeconds: 120 });
    expect(state.phase).toBe('warning');
    expect(state.stopsAt).not.toBeNull();
    const off = await g.deactivate();
    expect(driver.stopped).toEqual([]);
    // Es lief ja weiter - also nichts neu zu starten
    expect(off.restarted).toEqual([]);
    expect(driver.started).toEqual([]);
  });

  it('wer die Vorwarnung abbricht, entwarnt die Spieler', async () => {
    driver.commands.length = 0;
    driver.stopped.length = 0;
    (await driver.getServerState('t-run')).status = 'running';
    const g = make();
    await g.activate({ mode: 'stop', warnSeconds: 90 });
    await g.deactivate();
    expect(driver.stopped).toEqual([]);
    const says = driver.commands.filter((c) => c.command.startsWith('say')).map((c) => c.command);
    expect(says[0]).toMatch(/90 Sekunden/);
    expect(says[says.length - 1]).toBe('say Entwarnung: Der Server bleibt online.');
  });

  it('Warnzeit wird auf fünf Minuten begrenzt, eine eigene Meldung wird bereinigt', async () => {
    driver.commands.length = 0;
    (await driver.getServerState('t-run')).status = 'running';
    const g = make(instant);
    const state = await g.activate({ mode: 'stop', warnSeconds: 99_999, message: '/op Steve\nAchtung' });
    expect(state.warnSeconds).toBe(300);
    await g.whenIdle();
    expect(driver.commands[0]!.command).toBe('say op Steve Achtung');
    await g.deactivate();
  });
});

describe('Gaming-Modus: Routen', () => {
  let server: Awaited<ReturnType<typeof createCoreServer>>;
  let reg2: InstanceType<typeof ServerRegistry>;
  let drv2: FakeDriver;
  let admin: Record<string, string>;
  let user: Record<string, string>;
  let root: string;
  const json = { 'content-type': 'application/json' };

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-gaming2-'));
    reg2 = await ServerRegistry.open(root);
    drv2 = new FakeDriver();
    await drv2.initialize();
    server = await createCoreServer(drv2, new EventBus(), reg2, { installs: null, scheduler: false });
    const login = async (name: string, password: string) =>
      ({ authorization: `Bearer ${(await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: name, password } })).json().accessToken}` });
    admin = await login('admin', 'nur-fuer-tests-0815');
    await server.inject({ method: 'POST', url: '/api/v1/admin/users', headers: { ...admin, ...json }, payload: { username: 'normal', password: 'ein-sicheres-passwort-1' } });
    user = await login('normal', 'ein-sicheres-passwort-1');
  });

  afterAll(async () => {
    await server.close();
    reg2.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: unknown) =>
    server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

  it('nur wer Hosts verwalten darf', async () => {
    expect((await call('GET', '/api/v1/admin/gaming-mode', {})).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/admin/gaming-mode', user)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/admin/gaming-mode', user, { active: true })).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/admin/limits', user)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/admin/limits', user, { enforce: true })).statusCode).toBe(403);
  });

  it('schaltet ein und aus und lehnt Unsinn ab', async () => {
    expect((await call('GET', '/api/v1/admin/gaming-mode', admin)).json()).toMatchObject({ active: false, canThrottle: true, maxWarnSeconds: 300 });
    expect((await call('POST', '/api/v1/admin/gaming-mode', admin, { active: true, mode: 'unbekannt' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/admin/gaming-mode', admin, { active: true, mode: 'stop', warnSeconds: 301 })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/admin/gaming-mode', admin, { active: false })).statusCode).toBe(409);
    const on = await call('POST', '/api/v1/admin/gaming-mode', admin, { active: true, mode: 'throttle' });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ ok: true, active: true, mode: 'throttle' });
    expect((await call('POST', '/api/v1/admin/gaming-mode', admin, { active: true })).statusCode).toBe(409);
    expect((await call('POST', '/api/v1/admin/gaming-mode', admin, { active: false })).json()).toMatchObject({ ok: true, active: false });
    const audit = JSON.stringify((await call('GET', '/api/v1/admin/audit?action=gaming', admin)).json());
    expect(audit).toContain('gaming.on');
    expect(audit).toContain('gaming.off');
  });

  it('ein Treiber ohne Prioritäts-Funktion kann nicht drosseln', async () => {
    const plain = new MockDriver();
    await plain.initialize();
    const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-gaming3-'));
    const r = await ServerRegistry.open(root2);
    const s = await createCoreServer(plain, new EventBus(), r, { installs: null, scheduler: false });
    try {
      const login = await s.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
      const h = { authorization: `Bearer ${login.json().accessToken}`, ...json };
      expect((await s.inject({ method: 'GET', url: '/api/v1/admin/gaming-mode', headers: h })).json().canThrottle).toBe(false);
      const res = await s.inject({ method: 'POST', url: '/api/v1/admin/gaming-mode', headers: h, payload: { active: true, mode: 'throttle' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('not_supported');
    } finally {
      await s.close();
      r.close();
      await fs.rm(root2, { recursive: true, force: true });
    }
  });

  it('Grenzen: Schalter wird gespeichert und gilt ab dem nächsten Start', async () => {
    expect((await call('GET', '/api/v1/admin/limits', admin)).json()).toMatchObject({ enforce: false, supported: false, driver: 'mock' });
    const on = await call('POST', '/api/v1/admin/limits', admin, { enforce: true });
    expect(on.json()).toMatchObject({ ok: true, enforce: true, appliesFrom: 'next_start' });
    expect((await call('GET', '/api/v1/admin/limits', admin)).json().enforce).toBe(true);
    expect(reg2.getSetting('limits.enforce')).toBe(true);
    expect((await call('POST', '/api/v1/admin/limits', admin, { enforce: 'ja' })).statusCode).toBe(400);
    await call('POST', '/api/v1/admin/limits', admin, { enforce: false });
  });
});

describe('Fehlerklasse', () => {
  it('GamingError trägt Status und Code', () => {
    const e = new GamingError('x', 409, 'abc');
    expect(e).toMatchObject({ statusCode: 409, code: 'abc' });
  });
});
