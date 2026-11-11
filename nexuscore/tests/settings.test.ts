import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';
process.env.NEXUSCORE_PORT_RANGE = '39600-39699';

const { registerSettingsRoutes, getServerMeta } = await import('../src/http/routes/settings.js');
const { loadEggs } = await import('../src/eggs/loader.js');
const { parseRules, validateVariables, isSecretVariable } = await import('../src/eggs/rules.js');
const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { ServerRegistry } = await import('../src/store/registry.js');

type ServerInstanceConfig = import('../src/types.js').ServerInstanceConfig;

const PAPER_VARIABLES = {
  VERSION: 'LATEST',
  TYPE: 'PAPER',
  EULA: 'TRUE',
  MAX_PLAYERS: '20',
  MOTD: 'Hallo',
  DIFFICULTY: 'normal',
  RCON_PASSWORD: 'geheim-passwort',
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-set-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-set-outside-'));
  await fs.writeFile(path.join(outside, 'geheim.txt'), 'nicht anfassen');
  const serverRoot = path.join(dataDir, 'servers');
  await fs.mkdir(serverRoot, { recursive: true });

  const registry = await ServerRegistry.open(dataDir);
  const driver = new MockDriver();
  await driver.initialize();

  const busy = new Set<number>();
  const installs = { isInstalling: () => false, start: vi.fn(() => ({ id: 't_1' })) };
  const app = Fastify();
  registerSettingsRoutes(app, {
    registry,
    driver,
    find: (id) => registry.get(id),
    installs: installs as never,
    eggs: loadEggs,
    isPortFree: async (port) => !busy.has(port),
  });
  await app.ready();

  cleanups.push(async () => {
    await app.close();
    await driver.shutdown();
    registry.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  });

  /** Ein installierter Paper-Server im Server-Verzeichnis. */
  async function paper(id = 'set-1', port = 39600): Promise<ServerInstanceConfig> {
    const dir = path.join(serverRoot, id);
    await fs.mkdir(path.join(dir, 'world'), { recursive: true });
    await fs.writeFile(path.join(dir, 'server.properties'), 'motd=Hallo\n');
    const config: ServerInstanceConfig = {
      id,
      name: `Server ${id}`,
      game: 'minecraft-paper',
      executable: 'java',
      args: ['-Xmx3481M', '-jar', 'server.jar', '--nogui'],
      workingDir: dir,
      maxMemoryMb: 4096,
      maxCpuPercent: 200,
      ports: [{ name: 'game', hostPort: port, protocol: 'tcp' }],
      install: {
        state: 'done',
        kind: 'minecraft-paper',
        version: '1.21.11',
        variables: { ...PAPER_VARIABLES },
        propertiesTemplate: {},
      },
    };
    await registry.add(config);
    await driver.registerServer(config);
    return config;
  }

  /** Ein Platzhalter-Server (Spiel, das der Core noch nicht installiert). */
  async function placeholder(id = 'set-pal', port = 39650): Promise<ServerInstanceConfig> {
    const dir = path.join(serverRoot, id);
    await fs.mkdir(dir, { recursive: true });
    const config: ServerInstanceConfig = {
      id,
      name: id,
      game: 'palworld',
      executable: path.join(dir, 'start.bat'),
      args: [],
      workingDir: dir,
      ports: [{ name: 'game', hostPort: port, protocol: 'udp' }],
      env: {},
    };
    await registry.add(config);
    await driver.registerServer(config);
    return config;
  }

  const call = (method: 'GET' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });

  return { app, registry, driver, busy, installs, dataDir, outside, serverRoot, paper, placeholder, call };
}

describe('Einstellungen - Regeln der Eingabefelder', () => {
  it('liest Regeln im Laravel-Stil und waehlt das Bedienelement', () => {
    expect(parseRules('required|in:a,b', 'TYPE')).toMatchObject({ widget: 'select', options: ['a', 'b'], required: true });
    expect(parseRules('required|numeric|between:1,200', 'MAX_PLAYERS')).toMatchObject({ widget: 'slider', min: 1, max: 200, type: 'number' });
    expect(parseRules('nullable|string|min:8', 'RCON_PASSWORD').widget).toBe('password');
    expect(parseRules('required|boolean', 'PVP').widget).toBe('toggle');
    expect(parseRules('nullable|string|max:500', 'TEXT').widget).toBe('textarea');
  });

  it('prueft Werte und meldet lesbare Fehler', () => {
    const defs = [
      { env_variable: 'MAX_PLAYERS', rules: 'required|numeric|between:1,200', default_value: '20' },
      { env_variable: 'DIFFICULTY', rules: 'required|in:peaceful,easy,normal,hard', default_value: 'normal' },
      { env_variable: 'NAME', rules: 'required|string', default_value: '' },
      { env_variable: 'MEMORY', rules: 'nullable|string', default_value: '{{SERVER_MEMORY_HEAP}}M', user_editable: false },
    ];
    const ok = validateVariables(defs, { MAX_PLAYERS: '30', NAME: 'x' });
    expect(ok.errors).toEqual([]);
    expect(ok.values).toEqual({ MAX_PLAYERS: '30', DIFFICULTY: 'normal', NAME: 'x', MEMORY: '{{SERVER_MEMORY_HEAP}}M' });

    const bad = validateVariables(defs, { MAX_PLAYERS: '500', DIFFICULTY: 'unmoeglich' });
    const byVar = Object.fromEntries(bad.errors.map((e) => [e.variable, e.message]));
    expect(byVar.MAX_PLAYERS).toBeDefined();
    expect(byVar.DIFFICULTY).toBe('Erlaubt: peaceful, easy, normal, hard');
    expect(byVar.NAME).toBe('Pflichtfeld');
    expect(validateVariables(defs, { MAX_PLAYERS: 'abc', NAME: 'x' }).errors[0]?.message).toBe('Bitte eine Zahl zwischen 1 und 200 eingeben');
  });

  it('erkennt geheime Werte am Feld und am Namen', () => {
    expect(isSecretVariable({ name: 'x', env_variable: 'CF_API_KEY', secret: true })).toBe(true);
    expect(isSecretVariable({ name: 'x', env_variable: 'ADMIN_PASSWORD' })).toBe(true);
    expect(isSecretVariable({ name: 'x', env_variable: 'MOTD' })).toBe(false);
  });
});

describe('Einstellungen - Allgemein', () => {
  it('benennt um, merkt Tags und Favorit und lehnt Unsinn ab', async () => {
    const t = await setup();
    await t.paper();

    expect((await t.call('PATCH', '/api/v1/servers/set-1', { name: '  Mein Survival  ' })).statusCode).toBe(200);
    expect(t.registry.get('set-1')!.name).toBe('Mein Survival');

    await t.call('PATCH', '/api/v1/servers/set-1', { tags: ['pvp', 'pvp', ' koop '], isFavorite: true });
    expect(getServerMeta(t.registry, 'set-1')).toEqual({ tags: ['pvp', 'koop'], isFavorite: true });
    // Der Name blieb dabei unberuehrt
    expect(t.registry.get('set-1')!.name).toBe('Mein Survival');

    expect((await t.call('PATCH', '/api/v1/servers/set-1', { name: '   ' })).statusCode).toBe(400);
    expect((await t.call('PATCH', '/api/v1/servers/set-1', { name: 'x'.repeat(65) })).statusCode).toBe(400);
    expect((await t.call('PATCH', '/api/v1/servers/gibt-es-nicht', { name: 'x' })).statusCode).toBe(404);
    expect(t.registry.recentAudit({ serverId: 'set-1' }).some((e) => e.action === 'server.update')).toBe(true);
  });

  it('lehnt ab, was der Core noch nicht kann, statt es still zu speichern', async () => {
    const t = await setup();
    await t.paper();
    const restart = await t.call('PATCH', '/api/v1/servers/set-1', { autoRestart: true });
    expect(restart.statusCode).toBe(400);
    expect(restart.json().code).toBe('not_supported');
    expect((await t.call('PATCH', '/api/v1/servers/set-1', { autoSleepMinutes: 30 })).statusCode).toBe(400);
    // Ausschalten ist immer erlaubt
    expect((await t.call('PATCH', '/api/v1/servers/set-1', { autoRestart: false, autoSleepMinutes: 0 })).statusCode).toBe(200);
  });
});

describe('Einstellungen - Server loeschen', () => {
  it('loescht Server und Dateien', async () => {
    const t = await setup();
    const c = await t.paper();
    await t.call('PATCH', '/api/v1/servers/set-1', { isFavorite: true });

    const res = await t.call('DELETE', '/api/v1/servers/set-1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, filesDeleted: true });
    expect(t.registry.get('set-1')).toBeUndefined();
    await expect(fs.access(c.workingDir)).rejects.toThrow();
    expect(getServerMeta(t.registry, 'set-1')).toEqual({});
    const audit = t.registry.recentAudit({ serverId: 'set-1' }).find((e) => e.action === 'server.delete');
    expect(audit?.detail).toMatchObject({ name: 'Server set-1', force: false });
  });

  it('beendet einen laufenden Server nur mit force', async () => {
    const t = await setup();
    const c = await t.paper();
    await t.driver.startServer('set-1');

    const refused = await t.call('DELETE', '/api/v1/servers/set-1');
    expect(refused.statusCode).toBe(409);
    expect(t.registry.get('set-1')).toBeDefined();
    await expect(fs.access(c.workingDir)).resolves.toBeUndefined();

    const forced = await t.call('DELETE', '/api/v1/servers/set-1?force=true');
    expect(forced.statusCode).toBe(200);
    expect(t.registry.get('set-1')).toBeUndefined();
    // Der Treiber kennt den Server nicht mehr (er wurde beendet und abgemeldet)
    await expect(t.driver.getServerState('set-1')).rejects.toThrow();
  });

  it('laesst fremde Dateien in Ruhe: Verknuepfungen im Ordner werden nicht verfolgt', async () => {
    const t = await setup();
    const c = await t.paper();
    try {
      await fs.symlink(t.outside, path.join(c.workingDir, 'world', 'verweis'), 'junction');
    } catch {
      return; // Dateisystem ohne Verweise
    }
    expect((await t.call('DELETE', '/api/v1/servers/set-1')).statusCode).toBe(200);
    await expect(fs.access(c.workingDir)).rejects.toThrow();
    expect(await fs.readFile(path.join(t.outside, 'geheim.txt'), 'utf8')).toBe('nicht anfassen');
  });

  it('fasst Dateien ausserhalb des Server-Verzeichnisses nie an', async () => {
    const t = await setup();
    const config: ServerInstanceConfig = {
      id: 'set-aussen',
      name: 'Aussen',
      game: 'x',
      executable: 'x',
      args: [],
      workingDir: t.outside,
      ports: [],
    };
    await t.registry.add(config);
    await t.driver.registerServer(config);

    const res = await t.call('DELETE', '/api/v1/servers/set-aussen');
    expect(res.statusCode).toBe(200);
    expect(res.json().filesDeleted).toBe(false);
    expect(t.registry.get('set-aussen')).toBeUndefined();
    expect(await fs.readFile(path.join(t.outside, 'geheim.txt'), 'utf8')).toBe('nicht anfassen');
  });

  it('fasst auch das Server-Verzeichnis selbst nicht an', async () => {
    const t = await setup();
    const config: ServerInstanceConfig = {
      id: 'set-wurzel',
      name: 'Wurzel',
      game: 'x',
      executable: 'x',
      args: [],
      workingDir: t.serverRoot,
      ports: [],
    };
    await t.registry.add(config);
    await t.driver.registerServer(config);
    await t.paper('set-nachbar');

    const res = await t.call('DELETE', '/api/v1/servers/set-wurzel');
    expect(res.json().filesDeleted).toBe(false);
    // Der Nachbar und das Verzeichnis sind unversehrt
    await expect(fs.access(path.join(t.serverRoot, 'set-nachbar', 'server.properties'))).resolves.toBeUndefined();
  });

  it('meldet unbekannte Server und laufende Installationen', async () => {
    const t = await setup();
    expect((await t.call('DELETE', '/api/v1/servers/gibt-es-nicht')).statusCode).toBe(404);

    const c = await t.paper();
    await t.registry.update({ ...c, install: { ...c.install!, state: 'installing' } });
    const busy = await t.call('DELETE', '/api/v1/servers/set-1?force=true');
    expect(busy.statusCode).toBe(409);
    expect(t.registry.get('set-1')).toBeDefined();
  });
});

describe('Einstellungen - Ressourcen', () => {
  it('uebernimmt RAM und zieht den Java-Heap mit', async () => {
    const t = await setup();
    await t.paper();

    const res = await t.call('PATCH', '/api/v1/servers/set-1/resources', {
      ramMb: 8192,
      cpuPercent: 400,
      diskMb: 20480,
      bandwidthDownloadKbps: 2048,
      bandwidthUploadKbps: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, live: false, restartNeeded: false });

    const saved = t.registry.get('set-1')!;
    expect(saved).toMatchObject({ maxMemoryMb: 8192, maxCpuPercent: 400 });
    // 85 % von 8192 MB, wie beim Installieren
    expect(saved.args).toEqual(['-Xmx6963M', '-jar', 'server.jar', '--nogui']);
    expect(getServerMeta(t.registry, 'set-1')).toMatchObject({ diskMb: 20480, bandwidthDownloadKbps: 2048, bandwidthUploadKbps: null });
  });

  it('sagt, dass ein Neustart noetig ist, wenn der Server laeuft', async () => {
    const t = await setup();
    await t.paper();
    await t.driver.startServer('set-1');
    const res = await t.call('PATCH', '/api/v1/servers/set-1/resources', { ramMb: 6144 });
    expect(res.json().restartNeeded).toBe(true);
    expect(t.registry.get('set-1')!.maxMemoryMb).toBe(6144);

    // Nur die CPU zu aendern braucht keinen Neustart
    expect((await t.call('PATCH', '/api/v1/servers/set-1/resources', { cpuPercent: 300 })).json().restartNeeded).toBe(false);
  });

  it('lehnt unsinnige Werte ab', async () => {
    const t = await setup();
    await t.paper();
    for (const body of [{ ramMb: 64 }, { ramMb: 1.5 }, { cpuPercent: 5 }, { diskMb: 10 }, { bandwidthDownloadKbps: 0 }, {}, { ramMb: 'viel' }]) {
      expect((await t.call('PATCH', '/api/v1/servers/set-1/resources', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(t.registry.get('set-1')!.maxMemoryMb).toBe(4096);
  });
});

describe('Einstellungen - Spiel-Einstellungen', () => {
  it('liefert das Formular aus dem Egg mit den gesetzten Werten', async () => {
    const t = await setup();
    await t.paper();
    const res = await t.call('GET', '/api/v1/servers/set-1/startup');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.images).toEqual([]);

    const byEnv = Object.fromEntries(body.variables.map((v: { env: string }) => [v.env, v]));
    expect(byEnv.TYPE).toMatchObject({ value: 'PAPER', widget: 'select', required: true, editable: true });
    expect(byEnv.TYPE.options).toContain('FABRIC');
    expect(byEnv.MAX_PLAYERS).toMatchObject({ value: '20', type: 'number', min: 1, max: 200, widget: 'slider' });
    expect(byEnv.RCON_PASSWORD).toMatchObject({ secret: true, widget: 'password', value: 'geheim-passwort', isSet: true, default: null });
    // Abhaengige Felder tragen ihre Bedingung mit
    expect(byEnv.MODRINTH_MODPACK.requires).toBe('TYPE=MODRINTH');
    // Vom Egg selbst gesetzte Werte (z. B. der Java-Heap) gehoeren nicht ins Formular
    expect(byEnv.MEMORY).toBeUndefined();
  });

  it('speichert geaenderte Werte und merkt, welche', async () => {
    const t = await setup();
    await t.paper();
    const res = await t.call('PATCH', '/api/v1/servers/set-1/startup', {
      variables: { MAX_PLAYERS: '30', MOTD: 'Neu', DIFFICULTY: 'hard', GIBT_ES_NICHT: 'x', MEMORY: '1M' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, reinstall: false });
    // Genau die drei geaenderten Felder - nicht die, die nur ihre Vorgabe bekommen haben
    expect([...res.json().changed].sort()).toEqual(['DIFFICULTY', 'MAX_PLAYERS', 'MOTD']);

    const vars = t.registry.get('set-1')!.install!.variables!;
    expect(vars).toMatchObject({ MAX_PLAYERS: '30', MOTD: 'Neu', DIFFICULTY: 'hard', TYPE: 'PAPER' });
    // Unbekanntes und vom Egg gesetztes wird nicht uebernommen
    expect(vars.GIBT_ES_NICHT).toBeUndefined();
    expect(vars.MEMORY).not.toBe('1M');

    // Ins Protokoll gehoeren die Namen der Felder, nie die Werte
    const audit = t.registry.recentAudit({ serverId: 'set-1' }).find((e) => e.action === 'server.startup_update');
    expect(JSON.stringify(audit)).not.toContain('Neu');
  });

  it('laesst ein leeres Geheimnis unveraendert und setzt ein neues', async () => {
    const t = await setup();
    await t.paper();
    await t.call('PATCH', '/api/v1/servers/set-1/startup', { variables: { RCON_PASSWORD: '' } });
    expect(t.registry.get('set-1')!.install!.variables!.RCON_PASSWORD).toBe('geheim-passwort');
    await t.call('PATCH', '/api/v1/servers/set-1/startup', { variables: { RCON_PASSWORD: 'ein-neues-passwort' } });
    expect(t.registry.get('set-1')!.install!.variables!.RCON_PASSWORD).toBe('ein-neues-passwort');
  });

  it('weist ungueltige Werte mit dem Feldnamen ab und aendert nichts', async () => {
    const t = await setup();
    await t.paper();
    const res = await t.call('PATCH', '/api/v1/servers/set-1/startup', { variables: { MAX_PLAYERS: '500', DIFFICULTY: 'unmoeglich' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_variables');
    const issues = Object.fromEntries(res.json().issues.map((i: { variable: string; message: string }) => [i.variable, i.message]));
    expect(Object.keys(issues).sort()).toEqual(['DIFFICULTY', 'MAX_PLAYERS']);
    expect(t.registry.get('set-1')!.install!.variables).toMatchObject({ MAX_PLAYERS: '20', DIFFICULTY: 'normal' });
  });

  it('geht nur im gestoppten Zustand und ohne Container-Image', async () => {
    const t = await setup();
    await t.paper();
    expect((await t.call('PATCH', '/api/v1/servers/set-1/startup', { imageKey: 'Java 21' })).statusCode).toBe(400);
    expect((await t.call('PATCH', '/api/v1/servers/set-1/startup', {})).statusCode).toBe(400);

    await t.driver.startServer('set-1');
    const running = await t.call('PATCH', '/api/v1/servers/set-1/startup', { variables: { MOTD: 'Neu' } });
    expect(running.statusCode).toBe(409);
    expect(running.json().code).toBe('must_stop');
  });

  it('installiert Paper neu, wenn sich die Spielversion aendert', async () => {
    const t = await setup();
    await t.paper();
    const res = await t.call('PATCH', '/api/v1/servers/set-1/startup', { variables: { VERSION: '1.20.4' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: ['VERSION'], reinstall: true });
    expect(t.registry.get('set-1')!.install!.state).toBe('installing');
    expect(t.installs.start).toHaveBeenCalledTimes(1);
    expect(t.installs.start).toHaveBeenCalledWith('set-1', expect.objectContaining({ kind: 'minecraft-paper', variables: expect.objectContaining({ VERSION: '1.20.4' }) }));

    // Nur ein Motto aendern braucht keine Neuinstallation
    const t2 = await setup();
    await t2.paper();
    expect((await t2.call('PATCH', '/api/v1/servers/set-1/startup', { variables: { MOTD: 'x' } })).json().reinstall).toBe(false);
    expect(t2.installs.start).not.toHaveBeenCalled();
  });

  it('nimmt keinen anderen Servertyp als Paper und Vanilla an', async () => {
    const t = await setup();
    await t.paper();
    const res = await t.call('PATCH', '/api/v1/servers/set-1/startup', { variables: { TYPE: 'FORGE' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toEqual([{ variable: 'TYPE', message: 'Der Core installiert derzeit nur Paper und Vanilla.' }]);
    expect(t.registry.get('set-1')!.install!.variables!.TYPE).toBe('PAPER');
    expect(t.installs.start).not.toHaveBeenCalled();
  });

  it('speichert bei Spielen ohne Installation in env', async () => {
    const t = await setup();
    await t.placeholder();
    const form = (await t.call('GET', '/api/v1/servers/set-pal/startup')).json();
    expect(form.variables.length).toBeGreaterThan(0);
    const first = form.variables.find((v: { type: string; editable: boolean }) => v.type === 'string' && v.editable);
    expect(first).toBeDefined();

    const res = await t.call('PATCH', '/api/v1/servers/set-pal/startup', { variables: { [first.env]: 'Meine Welt' } });
    expect(res.statusCode).toBe(200);
    expect(t.registry.get('set-pal')!.env![first.env]).toBe('Meine Welt');
    expect(t.registry.get('set-pal')!.install).toBeUndefined();
  });
});

describe('Einstellungen - Ports', () => {
  it('legt zusaetzliche Ports an: automatisch, fest und fuer TCP und UDP zugleich', async () => {
    const t = await setup();
    await t.paper();

    const auto = await t.call('POST', '/api/v1/servers/set-1/allocations', { ref: 'dynmap' });
    expect(auto.statusCode).toBe(201);
    expect(auto.json()).toMatchObject({ ref: 'dynmap', port: 39601, protocol: 'tcp', env: 'DYNMAP_PORT' });

    const fixed = await t.call('POST', '/api/v1/servers/set-1/allocations', { port: 39650, ref: 'voice', protocol: 'both' });
    expect(fixed.statusCode).toBe(201);
    expect(t.registry.get('set-1')!.ports).toEqual([
      { name: 'game', hostPort: 39600, protocol: 'tcp' },
      { name: 'dynmap', hostPort: 39601, protocol: 'tcp' },
      { name: 'voice', hostPort: 39650, protocol: 'tcp' },
      { name: 'voice', hostPort: 39650, protocol: 'udp' },
    ]);
  });

  it('lehnt belegte Ports, doppelte Kennungen und Unsinn ab', async () => {
    const t = await setup();
    await t.paper();
    await t.paper('set-2', 39610);
    t.busy.add(39620);

    const other = await t.call('POST', '/api/v1/servers/set-1/allocations', { port: 39610 });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toMatch(/anderen Server/);
    const busy = await t.call('POST', '/api/v1/servers/set-1/allocations', { port: 39620 });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/benutzt/);
    expect((await t.call('POST', '/api/v1/servers/set-1/allocations', { port: 39600 })).statusCode).toBe(409);
    await t.call('POST', '/api/v1/servers/set-1/allocations', { ref: 'web' });
    expect((await t.call('POST', '/api/v1/servers/set-1/allocations', { ref: 'web' })).statusCode).toBe(409);

    for (const body of [{ port: 80 }, { port: 70000 }, { ref: 'Gross Schrift!' }, { ref: '1abc' }, { protocol: 'sctp' }]) {
      expect((await t.call('POST', '/api/v1/servers/set-1/allocations', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(t.registry.get('set-1')!.ports).toHaveLength(2);
  });

  it('aendert Port, Protokoll und Kennung und behaelt die Reihenfolge', async () => {
    const t = await setup();
    await t.paper();
    await t.call('POST', '/api/v1/servers/set-1/allocations', { port: 39640, ref: 'dynmap' });

    expect((await t.call('PATCH', '/api/v1/servers/set-1/allocations/39600', { newPort: 39660 })).statusCode).toBe(200);
    expect(t.registry.get('set-1')!.ports[0]).toEqual({ name: 'game', hostPort: 39660, protocol: 'tcp' });

    expect((await t.call('PATCH', '/api/v1/servers/set-1/allocations/39640', { protocol: 'both', ref: 'karte' })).statusCode).toBe(200);
    expect(t.registry.get('set-1')!.ports.slice(1)).toEqual([
      { name: 'karte', hostPort: 39640, protocol: 'tcp' },
      { name: 'karte', hostPort: 39640, protocol: 'udp' },
    ]);

    expect((await t.call('PATCH', '/api/v1/servers/set-1/allocations/39999', { newPort: 39670 })).statusCode).toBe(404);
    expect((await t.call('PATCH', '/api/v1/servers/set-1/allocations/39640', { newPort: 39660 })).statusCode).toBe(409);
    t.busy.add(39680);
    expect((await t.call('PATCH', '/api/v1/servers/set-1/allocations/39640', { newPort: 39680 })).statusCode).toBe(409);
  });

  it('loescht zusaetzliche Ports, aber nie den Hauptport', async () => {
    const t = await setup();
    await t.paper();
    await t.call('POST', '/api/v1/servers/set-1/allocations', { port: 39640, ref: 'dynmap' });

    expect((await t.call('DELETE', '/api/v1/servers/set-1/allocations/39600')).statusCode).toBe(400);
    expect((await t.call('DELETE', '/api/v1/servers/set-1/allocations/39999')).statusCode).toBe(404);
    expect((await t.call('DELETE', '/api/v1/servers/set-1/allocations/39640')).statusCode).toBe(200);
    expect(t.registry.get('set-1')!.ports).toEqual([{ name: 'game', hostPort: 39600, protocol: 'tcp' }]);
  });

  it('vergibt alle Ports neu, mit gleicher Reihenfolge und Namen', async () => {
    const t = await setup();
    await t.paper('set-1', 39690);
    await t.call('POST', '/api/v1/servers/set-1/allocations', { port: 39691, ref: 'rcon' });
    await t.paper('set-2', 39600);
    t.busy.add(39601);

    const res = await t.call('POST', '/api/v1/servers/set-1/reallocate');
    expect(res.statusCode).toBe(200);
    // 39600 gehoert dem anderen Server, 39601 ist auf dem Rechner belegt
    expect(res.json().ports).toEqual([
      { ref: 'game', port: 39602 },
      { ref: 'rcon', port: 39603 },
    ]);
    expect(t.registry.get('set-1')!.ports.map((p) => p.name)).toEqual(['game', 'rcon']);
    // der andere Server blieb unberuehrt
    expect(t.registry.get('set-2')!.ports[0]!.hostPort).toBe(39600);
  });

  it('meldet, wenn kein Port mehr frei ist, und laesst alles beim Alten', async () => {
    const t = await setup();
    await t.paper();
    const before = t.registry.get('set-1')!.ports;
    const noneFree = Fastify();
    // Alle Ports des Bereichs belegen
    for (let p = 39600; p <= 39699; p++) t.busy.add(p);
    await noneFree.close();
    const res = await t.call('POST', '/api/v1/servers/set-1/reallocate');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('no_free_port');
    expect(t.registry.get('set-1')!.ports).toEqual(before);
  });

  it('aendert Ports nur im gestoppten Zustand', async () => {
    const t = await setup();
    await t.paper();
    await t.driver.startServer('set-1');
    for (const [method, url, body] of [
      ['POST', '/api/v1/servers/set-1/allocations', { ref: 'x' }],
      ['PATCH', '/api/v1/servers/set-1/allocations/39600', { newPort: 39620 }],
      ['DELETE', '/api/v1/servers/set-1/allocations/39600', undefined],
      ['POST', '/api/v1/servers/set-1/reallocate', undefined],
    ] as const) {
      const res = await t.call(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json().code).toBe('must_stop');
    }
    expect(t.registry.get('set-1')!.ports).toEqual([{ name: 'game', hostPort: 39600, protocol: 'tcp' }]);
  });
});
