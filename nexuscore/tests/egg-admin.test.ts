import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Importierte Eggs landen im Datenordner - hier in einem eigenen, nie im Projekt
const dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'nx-eggadmin-data-'));
process.env.NEXUSCORE_DATA_DIR = dataDir;
process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { loadEggs, resetEggCache } = await import('../src/eggs/loader.js');
const { eggIdFor } = await import('../src/eggs/custom.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', ...json };
const PW = 'ein-sicheres-passwort-1';

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
const fetchCalls: Array<{ url: string; init?: { redirect?: string } }> = [];
let fetchAnswer: (url: string) => Response | Promise<Response> = () => new Response('nicht gesetzt', { status: 500 });

type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Headers = MASTER, payload?: unknown) =>
  // Ohne Inhalt kein JSON-Kopf: sonst lehnt Fastify die leere Anfrage ab
  server.inject({ method, url, headers: payload === undefined ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type')) : headers, ...(payload === undefined ? {} : { payload: payload as object }) });

/** Ein Egg im Format von Pterodactyl/Pelican - mit allem, was ein fremdes Egg falsch machen kann. */
const foreignEgg = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  author: 'jemand',
  startup: './spiel -port {{SERVER_PORT}} -mod {{UNBEKANNT}}',
  docker_images: { Debian: 'ghcr.io/parkervcp/yolks:debian' },
  variables: [{ name: 'Spieler', env_variable: 'MAX_PLAYERS', default_value: '10', rules: 'required|integer', user_viewable: true, user_editable: true }],
  capabilities: ['SYS_ADMIN', 'CHOWN'],
  data_dir: '/etc',
  run_as: 'root',
  scripts: { installation: { script: 'echo Installation', container: 'ghcr.io/parkervcp/installers:debian', entrypoint: 'bash' } },
  windows: { steam_app_id: 4000, executable: 'C:\\Windows\\System32\\cmd.exe' },
  ...extra,
});

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-eggadmin-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, {
    installs: null,
    scheduler: false,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, ...(init ? { init } : {}) });
      return fetchAnswer(url);
    },
  });
  resetEggCache();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Rechte', () => {
  it('nur Administratoren verwalten Spiele - ein Egg ist Programmcode', async () => {
    await call('POST', '/api/v1/admin/users', MASTER, { username: 'egg-user', password: PW });
    const login = await call('POST', '/api/v1/auth/login', json, { login: 'egg-user', password: PW });
    const user = { authorization: `Bearer ${login.json().accessToken}`, ...json };
    for (const [m, u, body] of [
      ['GET', '/api/v1/admin/eggs/catalog', undefined],
      ['POST', '/api/v1/admin/eggs', foreignEgg('X')],
      ['POST', '/api/v1/admin/eggs/import-url', { url: 'https://raw.githubusercontent.com/a/b/main/x.json' }],
      ['DELETE', '/api/v1/admin/eggs/irgendwas', undefined],
    ] as const) {
      expect((await call(m, u, user, body)).statusCode, `${m} ${u}`).toBe(403);
      expect((await call(m, u, { ...json }, body)).statusCode, `${m} ${u} ohne Anmeldung`).toBe(401);
    }
    expect((await call('POST', '/api/v1/admin/eggs', user, foreignEgg('Y'))).statusCode).toBe(403);
    expect(fetchCalls).toEqual([]);
  });
});

describe('Egg einspielen (Datei)', () => {
  it('nimmt ein fremdes Egg an, macht es sicher und meldet, was geändert wurde', async () => {
    const res = await call('POST', '/api/v1/admin/eggs', MASTER, foreignEgg('Mein Testspiel'));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ eggId: 'mein-testspiel', name: 'Mein Testspiel', variables: 1 });
    const warnings = (body.warnings as string[]).join('\n');
    expect(warnings).toContain('UNBEKANNT'); // Platzhalter ohne Variable
    expect(warnings).toContain('SYS_ADMIN'); // verweigertes Recht
    expect(warnings).toContain('/etc'); // abgelehnter Datenpfad
    expect(warnings).toContain('run_as'); // root nie
    expect(warnings).toContain('windows');

    // Gespeichert im Datenordner, mit den sicheren Werten
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'eggs', 'mein-testspiel.json'), 'utf8'));
    expect(saved.capabilities).toEqual(['CHOWN']);
    expect(saved.data_dir).toBe('/home/container');
    expect(saved.run_as).toBeUndefined();
    expect(saved.windows).toBeUndefined();
    expect(saved.scripts.installation.script).toBe('echo Installation');
    expect(saved.docker_images.Debian).toBe('ghcr.io/parkervcp/yolks:debian');

    // Es ist sofort im Katalog der Spiele
    const eggs = (await call('GET', '/api/v1/eggs')).json().eggs as Array<{ id: string; name: string; installable: boolean }>;
    expect(eggs.find((e) => e.id === 'mein-testspiel')).toMatchObject({ name: 'Mein Testspiel' });
    expect(registry.dir).not.toContain('eggs'); // nichts im Projektordner geschrieben
  });

  it('der Windows-Block eines Eggs wird nie übernommen - auch nicht in einem eigenen Format', async () => {
    const res = await call('POST', '/api/v1/admin/eggs', MASTER, foreignEgg('Mit Windows', { windows: { steam_app_id: 1, executable: 'x.exe', args: ['--boese'] } }));
    expect(res.statusCode).toBe(201);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'eggs', 'mit-windows.json'), 'utf8'));
    expect('windows' in saved).toBe(false);
    const loaded = (await loadEggs()).find((e) => e.id === 'mit-windows');
    expect(loaded?.raw.windows).toBeUndefined();
  });

  it('lehnt doppelte Namen ab - auch den eines mitgelieferten Spiels', async () => {
    expect((await call('POST', '/api/v1/admin/eggs', MASTER, foreignEgg('mein testspiel'))).statusCode).toBe(409); // Schreibweise egal
    const builtIn = (await loadEggs()).find((e) => !e.custom)!;
    const clash = await call('POST', '/api/v1/admin/eggs', MASTER, foreignEgg(builtIn.name));
    expect(clash.statusCode).toBe(409);
    // gleiche ID bei anderem Namen ("Mein-Testspiel!" -> mein-testspiel)
    expect((await call('POST', '/api/v1/admin/eggs', MASTER, foreignEgg('Mein-Testspiel!'))).statusCode).toBe(409);
  });

  it('lehnt unbrauchbare Eggs ab', async () => {
    expect((await call('POST', '/api/v1/admin/eggs', MASTER, foreignEgg('', {}))).json().code).toBe('invalid_egg');
    expect((await call('POST', '/api/v1/admin/eggs', MASTER, foreignEgg('Ohne Start', { startup: '' }))).json().message).toContain('Startkommando');
    expect((await call('POST', '/api/v1/admin/eggs', MASTER, foreignEgg('Ohne Image', { docker_images: {} }))).json().message).toContain('Docker-Image');
    expect((await call('POST', '/api/v1/admin/eggs', MASTER, [1, 2])).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/admin/eggs', { ...MASTER }, undefined)).statusCode).toBe(400);
    expect((await fs.readdir(path.join(dataDir, 'eggs'))).sort()).toEqual(['mein-testspiel.json', 'mit-windows.json']);
  });

  it('der Dateiname kommt nur aus dem Namen - nie aus einem Pfad', () => {
    expect(eggIdFor('../../Windows/System32/x')).toBe('windows-system32-x');
    expect(eggIdFor('Spiel Ümläut & Co.')).toBe('spiel-umlaut-co');
    expect(eggIdFor('???')).toBe('egg');
    expect(eggIdFor('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it('ein importiertes Egg überschreibt nie ein mitgeliefertes', async () => {
    const builtIn = (await loadEggs()).find((e) => !e.custom)!;
    await fs.writeFile(path.join(dataDir, 'eggs', `${builtIn.id}.json`), JSON.stringify(foreignEgg('Ersatz')));
    resetEggCache();
    const again = (await loadEggs()).find((e) => e.id === builtIn.id)!;
    expect(again.name).toBe(builtIn.name);
    expect(again.custom).toBe(false);
    await fs.rm(path.join(dataDir, 'eggs', `${builtIn.id}.json`));
    resetEggCache();
  });
});

describe('Egg von GitHub holen', () => {
  const okEgg = () => new Response(JSON.stringify(foreignEgg('Von GitHub')), { status: 200, headers: { 'content-type': 'application/json' } });

  it('lädt, bereitet auf und importiert; ein github.com-Link wird zum Rohlink; kein Weiterleiten', async () => {
    fetchAnswer = okEgg;
    fetchCalls.length = 0;
    const res = await call('POST', '/api/v1/admin/eggs/import-url', MASTER, { url: 'https://github.com/pelican-eggs/games-steamcmd/blob/main/valheim/egg-valheim.json', steamId: 892970, category: 'SteamCMD' });
    expect(res.statusCode, res.body).toBe(201);
    expect(fetchCalls[0]!.url).toBe('https://raw.githubusercontent.com/pelican-eggs/games-steamcmd/main/valheim/egg-valheim.json');
    expect(fetchCalls[0]!.init?.redirect).toBe('error');
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'eggs', 'von-github.json'), 'utf8'));
    expect(saved.cover).toEqual({ steam: 892970 });
    expect(saved.nest).toBeTruthy();
    expect(res.json().warnings.join('\n')).toContain('SYS_ADMIN');
    expect((await call('GET', '/api/v1/admin/audit?limit=50')).body).toContain('egg.import_url');
  });

  it('nur GitHub-JSON-Links über https - sonst wird nicht einmal angefragt', async () => {
    fetchCalls.length = 0;
    for (const url of ['https://evil.example/egg.json', 'http://raw.githubusercontent.com/a/b/main/x.json', 'https://raw.githubusercontent.com/a/b/main/x.txt', 'https://github.com.evil.example/a/b/blob/main/x.json', 'ftp://raw.githubusercontent.com/x.json']) {
      const res = await call('POST', '/api/v1/admin/eggs/import-url', MASTER, { url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code === 'invalid_url' || res.json().code === 'invalid_request', url).toBe(true);
    }
    expect(fetchCalls).toEqual([]);
  });

  it('Fehler beim Laden, kein JSON, zu groß: klare Meldung, nichts wird gespeichert', async () => {
    const before = (await fs.readdir(path.join(dataDir, 'eggs'))).length;
    const url = 'https://raw.githubusercontent.com/a/b/main/egg.json';
    fetchAnswer = () => new Response('nicht da', { status: 404 });
    expect((await call('POST', '/api/v1/admin/eggs/import-url', MASTER, { url })).json().code).toBe('download_failed');
    fetchAnswer = () => new Response('<html>keine json', { status: 200 });
    expect((await call('POST', '/api/v1/admin/eggs/import-url', MASTER, { url })).json().code).toBe('download_failed');
    fetchAnswer = () => new Response('{}', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } });
    expect((await call('POST', '/api/v1/admin/eggs/import-url', MASTER, { url })).json().message).toContain('zu groß');
    // ohne Laengenangabe, aber riesig
    fetchAnswer = () => new Response('{"name":"' + 'x'.repeat(2 * 1024 * 1024) + '"}', { status: 200 });
    expect((await call('POST', '/api/v1/admin/eggs/import-url', MASTER, { url })).json().message).toContain('zu groß');
    fetchAnswer = () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    expect((await call('POST', '/api/v1/admin/eggs/import-url', MASTER, { url })).json().code).toBe('download_failed');
    // JSON, aber kein brauchbares Egg
    fetchAnswer = () => new Response('{"name":"Leer"}', { status: 200 });
    expect((await call('POST', '/api/v1/admin/eggs/import-url', MASTER, { url })).json().code).toBe('invalid_egg');
    expect((await fs.readdir(path.join(dataDir, 'eggs'))).length).toBe(before);
  });

  it('ein schon vorhandenes Spiel: 409', async () => {
    fetchAnswer = okEgg;
    const res = await call('POST', '/api/v1/admin/eggs/import-url', MASTER, { url: 'https://raw.githubusercontent.com/a/b/main/egg.json' });
    expect(res.statusCode).toBe(409);
  });
});

describe('Egg löschen', () => {
  it('importierte Eggs gehen weg; mitgelieferte, unbekannte und benutzte nicht', async () => {
    const builtIn = (await loadEggs()).find((e) => !e.custom)!;
    const refused = await call('DELETE', `/api/v1/admin/eggs/${builtIn.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('built_in');
    expect((await call('DELETE', '/api/v1/admin/eggs/gibtsnicht')).statusCode).toBe(404);
    for (const evil of ['..%2f..%2fx', '%2e%2e', 'A_B', 'x'.repeat(200)]) {
      const status = (await call('DELETE', `/api/v1/admin/eggs/${evil}`)).statusCode;
      expect([400, 403, 404, 414], `${evil}: ${status}`).toContain(status);
    }

    // Benutzt: ein Server haelt das Egg fest
    const root = path.join(dir, 'servers', 'egg-use-1');
    await fs.mkdir(root, { recursive: true });
    await registry.add({ id: 'egg-use-1', name: 'Nutzer', game: 'mit-windows', executable: 'x', args: [], workingDir: root, ports: [] });
    const used = await call('DELETE', '/api/v1/admin/eggs/mit-windows');
    expect(used.statusCode).toBe(409);
    expect(used.json().code).toBe('in_use');
    await registry.remove('egg-use-1');

    const ok = await call('DELETE', '/api/v1/admin/eggs/mit-windows');
    expect(ok.statusCode, ok.body).toBe(200);
    await expect(fs.stat(path.join(dataDir, 'eggs', 'mit-windows.json'))).rejects.toThrow();
    expect((await loadEggs()).some((e) => e.id === 'mit-windows')).toBe(false);
    expect((await call('GET', '/api/v1/admin/audit?limit=50')).body).toContain('egg.delete');
    // danach lässt sich der Name wieder einspielen
    expect((await call('POST', '/api/v1/admin/eggs', MASTER, foreignEgg('Mit Windows'))).statusCode).toBe(201);
  });
});

describe('Katalog', () => {
  it('der kuratierte Katalog ist durchsuchbar und zeigt, was schon installiert ist', async () => {
    const res = await call('GET', '/api/v1/admin/eggs/catalog?category=all');
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ name: string; installed: boolean; category: string; rawUrl: string }>;
    expect(items.length).toBeGreaterThan(20);
    expect(items[0]).toMatchObject({ name: expect.any(String), category: expect.any(String), installed: expect.any(Boolean) });
    // Kategorie-Filter
    const minecraft = (await call('GET', '/api/v1/admin/eggs/catalog?category=Minecraft')).json().items as Array<{ category: string }>;
    expect(minecraft.every((i) => i.category.toLowerCase() === 'minecraft')).toBe(true);
  });

  it('die Suche im Internet ist erreichbar - fällt GitHub aus, bleibt der lokale Katalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('Netz weg'))));
    const res = await call('GET', '/api/v1/admin/eggs/catalog?q=valheim');
    expect(res.statusCode, res.body).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });
});
