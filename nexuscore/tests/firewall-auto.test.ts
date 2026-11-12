import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { FirewallManager } = await import('../src/system/firewall.js');
const { FirewallAuto } = await import('../src/system/firewall-auto.js');

const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', 'content-type': 'application/json' };

/** netsh-Attrappe: merkt sich Regeln; "deny" tut so, als gaebe es keine Administratorrechte. */
function fakeNetsh() {
  const state = { calls: [] as string[][], rules: new Set<string>(), deny: false };
  const run = async (args: string[]) => {
    state.calls.push(args);
    const name = args.find((a) => a.startsWith('name='))?.slice(5) ?? '';
    const verb = args[2];
    if (verb === 'add') {
      if (state.deny) return { code: 1, out: 'Der angeforderte Vorgang erfordert erhoehte Rechte (als Administrator ausfuehren).' };
      state.rules.add(name);
      return { code: 0, out: 'Ok.' };
    }
    if (verb === 'delete') return state.rules.delete(name) ? { code: 0, out: 'Ok.' } : { code: 1, out: 'Keine Regeln stimmen ueberein.' };
    if (verb === 'show') return state.rules.has(name) ? { code: 0, out: 'x' } : { code: 1, out: 'Keine Regeln stimmen ueberein.' };
    return { code: 1, out: '?' };
  };
  return { state, run };
}

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let bus: InstanceType<typeof EventBus>;
let lines: string[];

async function addServer(id: string, exe = 'spiel.exe'): Promise<string> {
  const root = path.join(dir, 'servers', id);
  await fs.mkdir(root, { recursive: true });
  const program = path.join(root, exe);
  await fs.writeFile(program, 'x');
  await registry.add({ id, name: id, game: 'x', executable: program, args: [], workingDir: root, ports: [] });
  return program;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-fwauto-'));
  registry = await ServerRegistry.open(dir);
});
afterAll(async () => {
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  bus = new EventBus();
  lines = [];
  bus.on((e) => {
    const ev = e as { type: string; line?: string };
    if (ev.type === 'console' && ev.line) lines.push(ev.line);
  });
});

function setup(file: string, enabled = true) {
  const net = fakeNetsh();
  const firewall = new FirewallManager(path.join(dir, file), net.run, 'win32');
  const auto = new FirewallAuto({ registry, firewall, bus, enabled });
  return { net, firewall, auto };
}

describe('Freigabe automatisch halten', () => {
  it('legt die Regel vor dem ersten Start an, danach nicht noch einmal', async () => {
    await addServer('fa-1');
    const { net, auto } = setup('a.json');
    expect(await auto.ensure('fa-1')).toBe('created');
    expect([...net.state.rules]).toEqual(['NexusCore fa-1 spiel.exe']);
    expect(lines.some((l) => l.includes('Freigabe in der Windows-Firewall angelegt'))).toBe(true);
    const adds = net.state.calls.filter((c) => c[2] === 'add').length;
    expect(await auto.ensure('fa-1')).toBe('present');
    expect(net.state.calls.filter((c) => c[2] === 'add').length).toBe(adds); // nichts doppelt angelegt
  });

  it('legt sie wieder an, wenn sie von Hand gelöscht wurde', async () => {
    await addServer('fa-2');
    const { net, auto } = setup('b.json');
    await auto.ensure('fa-2');
    net.state.rules.clear();
    expect(await auto.ensure('fa-2')).toBe('created');
    expect(net.state.rules.size).toBe(1);
  });

  it('nach einer Neuinstallation mit anderem Programm: die alte Regel geht weg', async () => {
    const first = await addServer('fa-3', 'alt.exe');
    const { net, firewall, auto } = setup('c.json');
    await auto.ensure('fa-3');
    expect([...net.state.rules]).toEqual(['NexusCore fa-3 alt.exe']);
    const neu = path.join(path.dirname(first), 'neu.exe');
    await fs.writeFile(neu, 'x');
    await registry.update({ ...registry.get('fa-3')!, executable: neu });
    expect(await auto.ensure('fa-3')).toBe('created');
    expect([...net.state.rules]).toEqual(['NexusCore fa-3 neu.exe']);
    expect((await firewall.records()).map((r) => r.program)).toEqual([neu]);
  });

  it('ohne Administratorrechte: keine Freigabe, der Befehl steht einmal in der Konsole - der Start bleibt möglich', async () => {
    await addServer('fa-4');
    const { net, auto } = setup('d.json');
    net.state.deny = true;
    expect(await auto.ensure('fa-4')).toBe('needs_admin');
    expect(await auto.ensure('fa-4')).toBe('needs_admin');
    const warnings = lines.filter((l) => l.includes('Administratorrechte'));
    expect(warnings).toHaveLength(1); // nicht bei jedem Start
    expect(warnings[0]).toContain('netsh advfirewall firewall add rule');
    expect(net.state.rules.size).toBe(0);
  });

  it('abgeschaltet oder kein Programm des Servers: nichts passiert', async () => {
    await addServer('fa-5');
    const off = setup('e.json', false);
    expect(await off.auto.ensure('fa-5')).toBe('skipped');
    expect(off.net.state.calls).toEqual([]);

    const on = setup('f.json');
    expect(await on.auto.ensure('gibtsnicht')).toBe('skipped');
    await registry.add({ id: 'fa-6', name: 'ohne', game: 'x', executable: path.join(dir, 'servers', 'fa-6', 'fehlt.exe'), args: [], workingDir: path.join(dir, 'servers', 'fa-6'), ports: [] });
    expect(await on.auto.ensure('fa-6')).toBe('skipped');
    // ein Programm ausserhalb des Server-Ordners bekommt nie eine Freigabe
    const outside = path.join(dir, 'fremd.exe');
    await fs.writeFile(outside, 'x');
    await registry.add({ id: 'fa-7', name: 'fremd', game: 'x', executable: outside, args: [], workingDir: path.join(dir, 'servers', 'fa-7'), ports: [] });
    expect(await on.auto.ensure('fa-7')).toBe('skipped');
    expect(on.net.state.calls).toEqual([]);
  });

  it('unter Linux und macOS gibt es nichts zu tun', async () => {
    await addServer('fa-8');
    const net = fakeNetsh();
    const auto = new FirewallAuto({ registry, firewall: new FirewallManager(path.join(dir, 'g.json'), net.run, 'linux'), bus, enabled: true });
    expect(await auto.ensure('fa-8')).toBe('skipped');
    expect(net.state.calls).toEqual([]);
  });
});

describe('Regeln für Server, die es nicht mehr gibt', () => {
  it('werden beim Start des Cores entfernt - fremde Regeln und vorhandene Server bleiben', async () => {
    await addServer('fo-bleibt');
    await addServer('fo-weg');
    const { net, firewall, auto } = setup('h.json');
    net.state.rules.add('Fremde Regel');
    await auto.ensure('fo-bleibt');
    await auto.ensure('fo-weg');
    expect(net.state.rules.size).toBe(3);
    // Der Server wird gelöscht, während der Core aus war (oder das Entfernen scheiterte)
    await registry.remove('fo-weg');
    const res = await auto.reconcile();
    expect(res.removed).toEqual(['NexusCore fo-weg spiel.exe']);
    expect([...net.state.rules].sort()).toEqual(['Fremde Regel', 'NexusCore fo-bleibt spiel.exe']);
    expect((await firewall.records()).map((r) => r.serverId)).toEqual(['fo-bleibt']);
    expect((await auto.reconcile()).removed).toEqual([]); // zweites Mal: nichts mehr da
  });

  it('eine Regel, die sich nicht entfernen lässt, bleibt in der Merkliste und wird beim nächsten Start erneut versucht', async () => {
    await addServer('fo-hart');
    const net = fakeNetsh();
    let blocked = true;
    const run = (args: string[]) => (args[2] === 'delete' && blocked ? Promise.resolve({ code: 1, out: 'Zugriff verweigert' }) : net.run(args));
    const firewall = new FirewallManager(path.join(dir, 'i.json'), run, 'win32');
    const auto = new FirewallAuto({ registry, firewall, bus, enabled: true });
    await auto.ensure('fo-hart');
    await registry.remove('fo-hart');
    const first = await auto.reconcile();
    expect(first.removed).toEqual([]);
    expect(first.failed).toHaveLength(1);
    expect(await firewall.records()).toHaveLength(1);
    blocked = false;
    expect((await auto.reconcile()).removed).toEqual(['NexusCore fo-hart spiel.exe']);
    expect(await firewall.records()).toEqual([]);
  });
});

describe('Im Core: vor jedem Start und beim Löschen', () => {
  let server: Awaited<ReturnType<typeof createCoreServer>>;
  let net: ReturnType<typeof fakeNetsh>;
  let coreDir: string;
  let coreRegistry: InstanceType<typeof ServerRegistry>;

  beforeAll(async () => {
    coreDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-fwauto-core-'));
    coreRegistry = await ServerRegistry.open(coreDir);
    const driver = new MockDriver();
    // So tun, als waere es der direkte Prozess-Treiber von Windows
    Object.defineProperty(driver, 'name', { value: 'windows-native' });
    await driver.initialize();
    net = fakeNetsh();
    server = await createCoreServer(driver, new EventBus(), coreRegistry, {
      installs: null,
      scheduler: false,
      firewall: new FirewallManager(path.join(coreDir, 'firewall-rules.json'), net.run, 'win32'),
    });
    const root = path.join(coreDir, 'servers', 'core-1');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'spiel.exe'), 'x');
    await coreRegistry.add({ id: 'core-1', name: 'Im Core', game: 'x', executable: path.join(root, 'spiel.exe'), args: [], workingDir: root, ports: [] });
  });
  afterAll(async () => {
    await server.close();
    coreRegistry.close();
    await fs.rm(coreDir, { recursive: true, force: true });
  });

  it('Start legt die Regel an, Löschen des Servers entfernt sie', async () => {
    expect(net.state.rules.size).toBe(0);
    const start = await server.inject({ method: 'POST', url: '/api/v1/servers/core-1/power', headers: MASTER, payload: { action: 'start' } });
    expect(start.statusCode, start.body).toBeLessThan(300);
    expect([...net.state.rules]).toEqual(['NexusCore core-1 spiel.exe']);
    await server.inject({ method: 'POST', url: '/api/v1/servers/core-1/power', headers: MASTER, payload: { action: 'kill' } });
    const del = await server.inject({ method: 'DELETE', url: '/api/v1/servers/core-1', headers: MASTER, payload: {} });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect(net.state.rules.size).toBe(0);
  });
});
