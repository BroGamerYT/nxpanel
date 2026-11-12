import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { FirewallManager, FirewallError, ruleName, addRuleArgs, commandText } = await import('../src/system/firewall.js');
const { watchServiceStdin } = await import('../src/system/service-mode.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij' };
const PW = 'ein-sicheres-passwort-1';

// ------------------------------------------------------------ Firewall (Attrappe statt netsh)

interface Fake {
  calls: string[][];
  rules: Set<string>;
  deny: boolean;
}
function fakeNetsh(): { fake: Fake; run: (args: string[]) => Promise<{ code: number; out: string }> } {
  const fake: Fake = { calls: [], rules: new Set(), deny: false };
  return {
    fake,
    run: async (args) => {
      fake.calls.push(args);
      const name = args.find((a) => a.startsWith('name='))?.slice(5) ?? '';
      const verb = args[2];
      if (verb === 'add') {
        if (fake.deny) return { code: 1, out: 'Der angeforderte Vorgang erfordert erhoehte Rechte (als Administrator ausfuehren).' };
        fake.rules.add(name);
        return { code: 0, out: 'Ok.' };
      }
      if (verb === 'delete') return fake.rules.delete(name) ? { code: 0, out: 'Ok.' } : { code: 1, out: 'Keine Regeln stimmen ueberein.' };
      if (verb === 'show') return fake.rules.has(name) ? { code: 0, out: 'Regelname: x' } : { code: 1, out: 'Keine Regeln stimmen ueberein.' };
      return { code: 1, out: 'unbekannt' };
    },
  };
}

describe('Firewall-Regeln', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-fw-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('benennt Regeln je Server und Programm und hält Sonderzeichen heraus', () => {
    expect(ruleName('alpha-1', 'C:\\Spiele\\alpha\\PalServer.exe')).toBe('NexusCore alpha-1 PalServer.exe');
    expect(ruleName('a"b&c', 'C:/x/y z.exe')).toBe('NexusCore a_b_c y z.exe');
    const args = addRuleArgs('NexusCore a x.exe', 'C:\\Pfad mit Leerzeichen\\x.exe');
    // Ein Argument je Angabe: nichts wird durch eine Shell geschickt
    expect(args).toContain('program=C:\\Pfad mit Leerzeichen\\x.exe');
    expect(args).toEqual(expect.arrayContaining(['dir=in', 'action=allow', 'enable=yes']));
    expect(commandText(args)).toContain('"program=C:\\Pfad mit Leerzeichen\\x.exe"');
  });

  it('legt die Regel an, merkt sie sich, ersetzt statt zu verdoppeln und räumt wieder auf', async () => {
    const { fake, run } = fakeNetsh();
    const fw = new FirewallManager(path.join(dir, 'a.json'), run, 'win32');
    const rec = await fw.open('s1', 'C:\\Server\\s1\\spiel.exe');
    expect(rec.name).toBe('NexusCore s1 spiel.exe');
    expect([...fake.rules]).toEqual(['NexusCore s1 spiel.exe']);
    await fw.open('s1', 'C:\\Server\\s1\\spiel.exe');
    expect(fake.rules.size).toBe(1);
    expect((await fw.records()).map((r) => r.name)).toEqual(['NexusCore s1 spiel.exe']);
    expect(await fw.exists(rec.name)).toBe(true);

    expect(await fw.closeServer('s1')).toEqual({ removed: ['NexusCore s1 spiel.exe'], failed: [] });
    expect(fake.rules.size).toBe(0);
    expect(await fw.records()).toEqual([]);
    // Zweites Mal: nichts mehr da, kein Fehler
    expect(await fw.closeServer('s1')).toEqual({ removed: [], failed: [] });
  });

  it('fasst andere Regeln nie an: gelöscht wird nur, was der Core selbst angelegt hat', async () => {
    const { fake, run } = fakeNetsh();
    fake.rules.add('Fremde Regel');
    const fw = new FirewallManager(path.join(dir, 'b.json'), run, 'win32');
    await fw.open('s2', 'C:\\Server\\s2\\x.exe');
    await fw.closeServer('s2');
    await fw.closeServer('gibtsnicht');
    expect([...fake.rules]).toEqual(['Fremde Regel']);
    expect(fake.calls.filter((c) => c[2] === 'delete').every((c) => c.some((a) => a.startsWith('name=NexusCore ')))).toBe(true);
  });

  it('ohne Administratorrechte: klare Meldung mit dem Befehl, nichts wird gemerkt', async () => {
    const { fake, run } = fakeNetsh();
    fake.deny = true;
    const fw = new FirewallManager(path.join(dir, 'c.json'), run, 'win32');
    const err = await fw.open('s3', 'C:\\Server\\s3\\x.exe').catch((e) => e);
    expect(err).toBeInstanceOf(FirewallError);
    expect(err.code).toBe('needs_admin');
    expect(err.command).toMatch(/^netsh advfirewall firewall add rule /);
    expect(await fw.records()).toEqual([]);
  });

  it('lehnt relative und gefährliche Programmpfade ab; auf anderen Systemen gibt es nichts zu tun', async () => {
    const { fake, run } = fakeNetsh();
    const fw = new FirewallManager(path.join(dir, 'd.json'), run, 'win32');
    for (const bad of ['spiel.exe', '..\\x.exe', 'C:\\a"b.exe', 'C:\\a\nb.exe']) {
      await expect(fw.open('s4', bad), bad).rejects.toMatchObject({ code: 'invalid_program' });
    }
    expect(fake.calls).toEqual([]);
    const linux = new FirewallManager(path.join(dir, 'e.json'), run, 'linux');
    expect(linux.available).toBe(false);
    await expect(linux.open('s5', 'C:\\x.exe')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('eine Regel, die sich nicht löschen lässt, bleibt in der Merkliste (geht nicht still verloren)', async () => {
    const fake = fakeNetsh();
    const fw = new FirewallManager(path.join(dir, 'f.json'), async (args) => (args[2] === 'delete' ? { code: 1, out: 'Zugriff verweigert' } : fake.run(args)), 'win32');
    await fw.open('s6', 'C:\\Server\\s6\\x.exe');
    const res = await fw.closeServer('s6');
    expect(res.removed).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(await fw.records()).toHaveLength(1);
  });
});

// ------------------------------------------------------------ Routen

describe('Firewall- und PIN-Routen', () => {
  let dir: string;
  let registry: InstanceType<typeof ServerRegistry>;
  let server: Awaited<ReturnType<typeof createCoreServer>>;
  let fw: InstanceType<typeof FirewallManager>;
  let net: ReturnType<typeof fakeNetsh>;
  let admin: Record<string, string>;
  let user: Record<string, string>;

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string>) => server.inject({ method, url, headers: { ...headers, ...json }, ...(method === 'GET' ? {} : { payload: {} }) });
  const login = async (name: string, password: string) => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: name, password } });
    return { authorization: `Bearer ${res.json().accessToken}` };
  };

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-fwr-'));
    registry = await ServerRegistry.open(dir);
    net = fakeNetsh();
    fw = new FirewallManager(path.join(dir, 'firewall-rules.json'), net.run, 'win32');
    const driver = new MockDriver();
    await driver.initialize();
    server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false, firewall: fw });
    admin = await login('admin', 'nur-fuer-tests-0815');
    const created = await call('POST', '/api/v1/admin/users', admin);
    expect(created.statusCode).toBe(400); // ohne Inhalt; nur der Weg zum normalen Benutzer unten
    const mk = await server.inject({ method: 'POST', url: '/api/v1/admin/users', headers: { ...admin, ...json }, payload: { username: 'fw-user', password: PW } });
    expect(mk.statusCode).toBe(201);
    user = await login('fw-user', PW);
    const root = path.join(dir, 'servers', 'fw-1');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'spiel.exe'), 'x');
    await registry.add({ id: 'fw-1', name: 'Mit Programm', game: 'x', executable: path.join(root, 'spiel.exe'), args: [], workingDir: root, ports: [] });
    const root2 = path.join(dir, 'servers', 'fw-2');
    await fs.mkdir(root2, { recursive: true });
    await registry.add({ id: 'fw-2', name: 'Ohne Programm', game: 'x', executable: path.join(root2, 'fehlt.exe'), args: [], workingDir: root2, ports: [] });
  });
  afterAll(async () => {
    await server.close();
    registry.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('nur wer das Recht hat, sieht und ändert Freigaben; die PIN gibt es nur für Administratoren', async () => {
    for (const [m, u] of [['GET', '/api/v1/admin/firewall'], ['POST', '/api/v1/admin/firewall/fw-1'], ['DELETE', '/api/v1/admin/firewall/fw-1'], ['GET', '/api/v1/admin/pairing'], ['POST', '/api/v1/admin/pairing/renew']] as const) {
      expect((await call(m, u, user)).statusCode, `${m} ${u}`).toBe(403);
      expect((await server.inject({ method: m, url: u })).statusCode, `${m} ${u} ohne Anmeldung`).toBe(401);
    }
    expect(net.fake.calls).toEqual([]);
  });

  it('gibt ein Programm frei, zeigt den Stand und nimmt die Freigabe zurück', async () => {
    const list = (await call('GET', '/api/v1/admin/firewall', MASTER)).json();
    expect(list.available).toBe(true);
    expect(list.servers.find((s: { serverId: string }) => s.serverId === 'fw-1')).toMatchObject({ program: expect.stringContaining('spiel.exe'), rule: null });
    expect(list.servers.find((s: { serverId: string }) => s.serverId === 'fw-2').program).toBeNull();

    const open = await call('POST', '/api/v1/admin/firewall/fw-1', MASTER);
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json().rule.name).toBe('NexusCore fw-1 spiel.exe');
    const after = (await call('GET', '/api/v1/admin/firewall', MASTER)).json();
    expect(after.servers.find((s: { serverId: string }) => s.serverId === 'fw-1').rule).toMatchObject({ active: true });

    expect((await call('DELETE', '/api/v1/admin/firewall/fw-1', MASTER)).json()).toMatchObject({ ok: true, removed: ['NexusCore fw-1 spiel.exe'] });
    expect(net.fake.rules.size).toBe(0);
    const audit = (await call('GET', '/api/v1/admin/audit?limit=100', MASTER)).body;
    expect(audit).toContain('firewall.open');
    expect(audit).toContain('firewall.close');
  });

  it('Programm fehlt, Server unbekannt, keine Administratorrechte: jeweils eine klare Antwort', async () => {
    expect((await call('POST', '/api/v1/admin/firewall/fw-2', MASTER)).json().code).toBe('invalid_program');
    expect((await call('POST', '/api/v1/admin/firewall/gibtsnicht', MASTER)).statusCode).toBe(404);
    net.fake.deny = true;
    const denied = await call('POST', '/api/v1/admin/firewall/fw-1', MASTER);
    net.fake.deny = false;
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'needs_admin', command: expect.stringContaining('netsh advfirewall firewall add rule') });
  });

  it('die Freigabe verschwindet mit dem Server', async () => {
    await call('POST', '/api/v1/admin/firewall/fw-1', MASTER);
    expect(net.fake.rules.size).toBe(1);
    const del = await server.inject({ method: 'DELETE', url: '/api/v1/servers/fw-1', headers: { ...MASTER, ...json }, payload: {} });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect(net.fake.rules.size).toBe(0);
  });

  it('Kopplungs-PIN: lesen, neu erzeugen; die neue ersetzt die alte', async () => {
    const a = (await call('GET', '/api/v1/admin/pairing', admin)).json();
    expect(a.pin).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect((await call('GET', '/api/v1/admin/pairing', admin)).json().pin).toBe(a.pin);
    const b = (await call('POST', '/api/v1/admin/pairing/renew', admin)).json();
    expect(b.pin).not.toBe(a.pin);
    expect((await call('GET', '/api/v1/admin/pairing', MASTER)).json().pin).toBe(b.pin);
  });

  it('die Oberfläche erfährt, dass es Firewall-Freigaben gibt', async () => {
    expect((await call('GET', '/api/v1/about', MASTER)).json().features).toContain('firewall');
  });
});

// ------------------------------------------------------------ Dienstbetrieb

describe('Dienstbetrieb im Core', () => {
  it('Rohr zu heißt "sauber beenden" - genau einmal', async () => {
    const stream = new PassThrough();
    let stops = 0;
    watchServiceStdin(stream, () => stops++);
    stream.write('Unsinn, wird verworfen');
    await new Promise((r) => setTimeout(r, 20));
    expect(stops).toBe(0);
    stream.end();
    await new Promise((r) => setTimeout(r, 50));
    stream.emit('close');
    expect(stops).toBe(1);
  });
});

// ------------------------------------------------------------ nxsvc (echte Prozesse)

const NXSVC = path.resolve(import.meta.dirname, '..', 'helper', 'nxsvc', 'target', 'release', 'nxsvc.exe');
let hasHelper = false;
try {
  await fs.access(NXSVC);
  hasHelper = process.platform === 'win32';
} catch {
  /* nicht gebaut */
}

describe.skipIf(!hasHelper)('nxsvc - Dienst-Hülle (Überwachung ohne Dienststeuerung)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-svc-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Startet nxsvc im run-Modus; stdin bleibt offen, bis stop() es schliesst. */
  function start(extra: string[], script: string) {
    const log = path.join(dir, `log-${Math.random().toString(36).slice(2)}.txt`);
    const child = spawn(NXSVC, ['run', '--log', log, '--stop-on-stdin-eof', ...extra, '--', process.execPath, '-e', script], { stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return {
      log,
      exited,
      stop: () => child.stdin!.end(),
      kill: () => child.kill(),
      text: async () => fs.readFile(log, 'utf8').catch(() => ''),
    };
  }
  const until = async (check: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  it('startet das Programm mit NEXUSCORE_SERVICE=1; beim Beenden bekommt es "Rohr zu" und endet sauber', async () => {
    const marker = path.join(dir, 'marker1.txt');
    const s = start([], `
      require('fs').writeFileSync(${JSON.stringify(marker)}, 'start:' + process.env.NEXUSCORE_SERVICE);
      process.stdin.resume();
      process.stdin.on('end', () => { require('fs').appendFileSync(${JSON.stringify(marker)}, ' sauber'); process.exit(0); });
    `);
    expect(await until(async () => (await fs.readFile(marker, 'utf8').catch(() => '')).startsWith('start:1'))).toBe(true);
    s.stop();
    expect(await s.exited).toBe(0);
    expect(await fs.readFile(marker, 'utf8')).toBe('start:1 sauber');
    const log = await s.text();
    expect(log).toContain('Programm gestartet');
    expect(log).toContain('gebeten, sauber zu enden');
    expect(log).not.toContain('hart beendet');
  }, 30_000);

  it('startet nach einem Absturz neu - und nur so lange, bis der Dienst beendet wird', async () => {
    const counter = path.join(dir, 'zaehler.txt');
    const s = start([], `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x'); process.exit(7);`);
    // Erster Neustart nach 2 Sekunden, zweiter nach weiteren 4
    expect(await until(async () => (await fs.readFile(counter, 'utf8').catch(() => '')).length >= 2, 20_000)).toBe(true);
    s.stop();
    expect(await s.exited).toBe(0);
    const runs = (await fs.readFile(counter, 'utf8')).length;
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fs.readFile(counter, 'utf8')).length).toBe(runs);
    const log = await s.text();
    expect(log).toMatch(/Programm hat sich beendet/);
    expect(log).toMatch(/Neustart in 2 s/);
  }, 40_000);

  it('ein Programm, das nicht endet, wird nach der Frist hart beendet', async () => {
    const marker = path.join(dir, 'marker3.txt');
    const s = start(['--grace', '1'], `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
    expect(await until(async () => (await fs.readFile(marker, 'utf8').catch(() => '')).length > 0)).toBe(true);
    const pid = Number(await fs.readFile(marker, 'utf8'));
    const t0 = Date.now();
    s.stop();
    expect(await s.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect((await s.text())).toContain('hart beendet');
    expect(() => process.kill(pid, 0)).toThrow(); // der Prozess ist weg
  }, 30_000);

  it('ein Programm, das es nicht gibt, bringt die Hülle nicht zum Absturz (sie versucht es weiter)', async () => {
    const log = path.join(dir, 'log-fehlt.txt');
    const child = spawn(NXSVC, ['run', '--log', log, '--stop-on-stdin-eof', '--', path.join(dir, 'gibtsnicht.exe')], { stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    expect(await until(async () => (await fs.readFile(log, 'utf8').catch(() => '')).includes('konnte nicht gestartet werden'))).toBe(true);
    child.stdin.end();
    expect(await exited).toBe(0);
  }, 30_000);

  it('falsche Aufrufe werden mit Hinweis abgewiesen', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const c = spawn(NXSVC, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        c.stderr!.on('data', (d) => (err += d));
        c.on('exit', (code) => resolve({ code, err }));
      });
    expect((await run([])).code).toBe(2);
    expect((await run(['run'])).err).toContain('Programm');
    expect((await run(['run', '--grace', '0', '--', 'x'])).err).toContain('--grace');
    expect((await run(['dienst', '--', 'x'])).code).toBe(2);
    // "service" ausserhalb der Dienststeuerung: klare Meldung statt Hängen
    const svc = await run(['service', '--', 'x']);
    expect(svc.code).toBe(5);
    expect(svc.err).toContain('Dienststeuerung');
  }, 30_000);
});
