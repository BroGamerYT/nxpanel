import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { clearPackCache, packOf } = await import('../src/games/modpacks.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', ...json };
const PW = 'ein-sicheres-passwort-1';
const KEY = 'a'.repeat(32);

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
const urls: string[] = [];
let modrinthDown = false;
let cfAccepts = true;

type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Headers = MASTER, payload?: unknown) =>
  server.inject({
    method,
    url,
    headers: payload === undefined ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type')) : headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

/** Modrinth und CurseForge als Attrappe - es geht nichts ins Netz. */
function fakeNet(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://api.curseforge.com')) return cfAccepts ? ok({ data: [], pagination: {} }) : new Response('forbidden', { status: 403 });
      if (modrinthDown) return new Response('down', { status: 503 });
      if (url.includes('/v2/search')) {
        return ok({
          hits: [{ project_id: 'p1', slug: 'cool-pack', title: 'Cool Pack', description: 'Ein Pack', downloads: 1000, versions: ['1.20.1', '1.21'], categories: ['fabric'], display_categories: ['fabric'], latest_version: 'v2' }],
        });
      }
      if (url.includes('/project/cool-pack/version')) {
        return ok([
          { id: 'v2', name: 'Zwei', version_number: '2.0', version_type: 'release', game_versions: ['1.21'], date_published: '2026-02-01T00:00:00Z' },
          { id: 'v1', name: 'Eins', version_number: '1.0', version_type: 'release', game_versions: ['1.20.1'], date_published: '2025-01-01T00:00:00Z' },
          { id: 'b1', name: 'Beta', version_number: '3.0-beta', version_type: 'beta', game_versions: ['1.21'], date_published: '2026-03-01T00:00:00Z' },
        ]);
      }
      return new Response('nicht da', { status: 404 });
    }),
  );
}

async function login(name: string): Promise<Headers> {
  const res = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: name, password: PW } });
  return { authorization: `Bearer ${res.json().accessToken}`, ...json };
}

async function createPackServer(name: string, version = 'v1'): Promise<string> {
  const res = await call('POST', '/api/v1/servers', MASTER, { name, eggId: 'minecraft-paper', ramMb: 2048, variables: { EULA: 'TRUE', TYPE: 'MODRINTH', MODRINTH_MODPACK: 'cool-pack', MODRINTH_VERSION: version } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().server.id as string;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-modpacks-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearPackCache();
  modrinthDown = false;
  cfAccepts = true;
});
afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Pack erkennen (rein)', () => {
  it('erkennt Modrinth, CurseForge und FTB an den Variablen - eigene Dateien nicht', () => {
    expect(packOf({ TYPE: 'MODRINTH', MODRINTH_MODPACK: 'cool-pack', MODRINTH_VERSION: 'v1' })).toEqual({ source: 'modrinth', ref: 'cool-pack', versionVar: 'MODRINTH_VERSION', version: 'v1' });
    expect(packOf({ TYPE: 'MODRINTH', MODRINTH_MODPACK: 'https://modrinth.com/modpack/cool-pack' })?.ref).toBe('cool-pack');
    expect(packOf({ TYPE: 'MODRINTH', MODRINTH_MODPACK: 'eigenes.mrpack' })).toBeNull();
    expect(packOf({ TYPE: 'AUTO_CURSEFORGE', CF_SLUG: 'all-the-mods', CF_FILE_ID: '123' })).toMatchObject({ source: 'curseforge', versionVar: 'CF_FILE_ID' });
    expect(packOf({ TYPE: 'FTBA', FTB_MODPACK_ID: '42' })).toMatchObject({ source: 'ftb' });
    expect(packOf({ TYPE: 'PAPER' })).toBeNull();
  });
});

describe('Suche und Schlüssel', () => {
  it('verlangt eine Anmeldung; der Suchbegriff muss 2 bis 80 Zeichen haben', async () => {
    fakeNet();
    expect((await call('GET', '/api/v1/modpacks/search?q=cool', {})).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/modpacks/curseforge', {})).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/modpacks/search?q=a')).statusCode).toBe(400);
    expect((await call('GET', `/api/v1/modpacks/search?q=${'x'.repeat(81)}`)).statusCode).toBe(400);
  });

  it('sucht auf Modrinth und liefert je Treffer den fertigen Vorschlag für das Minecraft-Spiel', async () => {
    fakeNet();
    const res = (await call('GET', '/api/v1/modpacks/search?q=cool&source=modrinth')).json();
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({ source: 'modrinth', ref: 'cool-pack', name: 'Cool Pack', loaders: ['fabric'] });
    expect(res.hits[0].preset.values).toEqual({ TYPE: 'MODRINTH', MODRINTH_MODPACK: 'cool-pack', MODRINTH_VERSION: 'v2' });
    expect(res.hits[0].preset.java).toBeGreaterThanOrEqual(17);
    // Ohne Schlüssel wird CurseForge gar nicht erst gefragt
    expect(res.curseforge).toBe('no_key');
    expect(urls.some((u) => u.includes('api.curseforge.com'))).toBe(false);
  });

  it('fällt Modrinth aus, kommt eine Meldung statt eines Absturzes', async () => {
    fakeNet();
    modrinthDown = true;
    const res = await call('GET', '/api/v1/modpacks/search?q=cool&source=modrinth');
    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toEqual([]);
    expect(res.json().errors.modrinth).toBeTruthy();
  });

  it('CurseForge-Schlüssel: nur Administratoren, wird geprüft, geht nie in eine Antwort oder ins Protokoll', async () => {
    fakeNet();
    await call('POST', '/api/v1/admin/users', MASTER, { username: 'mp-user', password: PW });
    const user = await login('mp-user');
    expect((await call('PUT', '/api/v1/admin/modpacks/curseforge', user, { apiKey: KEY })).statusCode).toBe(403);
    expect((await call('DELETE', '/api/v1/admin/modpacks/curseforge', user)).statusCode).toBe(403);
    expect((await call('PUT', '/api/v1/admin/modpacks/curseforge', MASTER, { apiKey: 'kurz' })).statusCode).toBe(400);
    const pat = await call('PUT', '/api/v1/admin/modpacks/curseforge', MASTER, { apiKey: `cfc_pat_${'b'.repeat(30)}` });
    expect(pat.statusCode).toBe(400);
    expect(pat.json().message).toContain('Profile-Token');
    cfAccepts = false;
    expect((await call('PUT', '/api/v1/admin/modpacks/curseforge', MASTER, { apiKey: KEY })).json().message).toContain('lehnt');
    expect((await call('GET', '/api/v1/modpacks/curseforge', user)).json()).toEqual({ configured: false });

    cfAccepts = true;
    expect((await call('PUT', '/api/v1/admin/modpacks/curseforge', MASTER, { apiKey: KEY })).json()).toEqual({ ok: true });
    const status = await call('GET', '/api/v1/modpacks/curseforge', user);
    expect(status.json()).toEqual({ configured: true });
    expect(status.body).not.toContain(KEY);
    const audit = (await call('GET', '/api/v1/admin/audit?limit=100')).body;
    expect(audit).toContain('settings.curseforge');
    expect(audit).not.toContain(KEY);
    // Mit Schlüssel fragt die Suche CurseForge mit
    urls.length = 0;
    await call('GET', '/api/v1/modpacks/search?q=cool&source=curseforge');
    expect(urls.some((u) => u.includes('api.curseforge.com'))).toBe(true);

    expect((await call('DELETE', '/api/v1/admin/modpacks/curseforge')).json()).toEqual({ ok: true });
    expect((await call('GET', '/api/v1/modpacks/curseforge', user)).json()).toEqual({ configured: false });
  });
});

describe('Stand eines Servers', () => {
  it('ohne Pack: leer; mit Pack: aktuelle und neueste Version; ein Fehler beim Abfragen kippt die Seite nicht', async () => {
    fakeNet();
    const plain = await call('POST', '/api/v1/servers', MASTER, { name: 'Ohne Pack', eggId: 'minecraft-paper', variables: { EULA: 'TRUE' } });
    expect((await call('GET', `/api/v1/servers/${plain.json().server.id}/modpack`)).json()).toEqual({ pack: null });
    expect((await call('GET', '/api/v1/servers/gibtsnicht/modpack')).statusCode).toBe(404);

    const id = await createPackServer('Mit Pack');
    const st = (await call('GET', `/api/v1/servers/${id}/modpack`)).json();
    expect(st).toMatchObject({ source: 'modrinth', ref: 'cool-pack', updateAvailable: true, mcChange: true, unpinned: false });
    expect(st.current).toMatchObject({ id: 'v1', name: '1.0' });
    expect(st.latest).toMatchObject({ id: 'v2', name: '2.0' }); // die Beta zählt nicht
    expect(st.job).toBeNull();

    clearPackCache();
    modrinthDown = true;
    const broken = await call('GET', `/api/v1/servers/${id}/modpack`);
    expect(broken.statusCode).toBe(200);
    expect(broken.json()).toMatchObject({ source: 'modrinth', ref: 'cool-pack', error: expect.any(String) });
  });
});

describe('1-Klick-Update', () => {
  it('stoppt, sichert, setzt die neue Version und startet wieder', async () => {
    fakeNet();
    const id = await createPackServer('Update Pack');
    await call('POST', `/api/v1/servers/${id}/power`, MASTER, { action: 'start' });
    const res = await call('POST', `/api/v1/servers/${id}/modpack/update`, MASTER, {});
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().job).toMatchObject({ from: 'v1', to: 'v2' });

    const finished = async () => {
      const job = (await call('GET', `/api/v1/servers/${id}/modpack`)).json().job as { step: string; message?: string } | null;
      return job?.step === 'done' || job?.step === 'failed';
    };
    const end = Date.now() + 15_000;
    while (Date.now() < end && !(await finished())) await new Promise((r) => setTimeout(r, 50));
    const job = (await call('GET', `/api/v1/servers/${id}/modpack`)).json().job;
    expect(job.step, job.message).toBe('done');

    // Neue Version festgesetzt, Backup vorher angelegt, Server läuft wieder
    expect(registry.get(id)?.env?.MODRINTH_VERSION).toBe('v2');
    const backups = (await call('GET', `/api/v1/servers/${id}/backups`)).json().backups as Array<{ name: string }>;
    expect(backups.some((b) => b.name.includes('Vor Modpack-Update'))).toBe(true);
    const upAgain = Date.now() + 5000;
    let state = '';
    while (Date.now() < upAgain && state !== 'running') {
      state = (await call('GET', `/api/v1/servers/${id}`)).json().server.status as string;
      if (state !== 'running') await new Promise((r) => setTimeout(r, 50));
    }
    expect(state).toBe('running');
    const audit = (await call('GET', '/api/v1/admin/audit?limit=100')).body;
    for (const a of ['modpack.update', 'modpack.update_done']) expect(audit, a).toContain(a);
    await call('POST', `/api/v1/servers/${id}/power`, MASTER, { action: 'kill' });
  });

  it('abgelehnt: gleiche Version, Server ohne Pack, ohne Backup-Recht, unbekannt, zweites Update gleichzeitig', async () => {
    fakeNet();
    const id = await createPackServer('Update Regeln', 'v2');
    const same = await call('POST', `/api/v1/servers/${id}/modpack/update`, MASTER, {});
    expect(same.statusCode).toBe(409);
    expect(same.json().message).toContain('schon installiert');

    const plain = await call('POST', '/api/v1/servers', MASTER, { name: 'Update Ohne', eggId: 'minecraft-paper', variables: { EULA: 'TRUE' } });
    expect((await call('POST', `/api/v1/servers/${plain.json().server.id}/modpack/update`, MASTER, {})).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/servers/gibtsnicht/modpack/update', MASTER, {})).statusCode).toBe(404);

    // Ein Mitnutzer darf Einstellungen ändern, aber ohne backup.create kein Update
    const mk = await call('POST', '/api/v1/admin/users', MASTER, { username: 'mp-op', password: PW });
    await call('PUT', `/api/v1/admin/users/${mk.json().user.id}/servers/${id}`, MASTER, { permissions: ['startup.update', 'startup.read'] });
    const op = await login('mp-op');
    const denied = await call('POST', `/api/v1/servers/${id}/modpack/update`, op, {});
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toContain('backup.create');

    // Version v1 -> v2 zweimal sofort: das zweite wird abgewiesen
    const old = await createPackServer('Update Doppelt', 'v1');
    const [a, b] = await Promise.all([call('POST', `/api/v1/servers/${old}/modpack/update`, MASTER, {}), call('POST', `/api/v1/servers/${old}/modpack/update`, MASTER, {})]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    // das laufende Update zu Ende laufen lassen, bevor der Core abgebaut wird
    const wait = Date.now() + 15_000;
    for (;;) {
      const step = ((await call('GET', `/api/v1/servers/${old}/modpack`)).json().job as { step: string } | null)?.step;
      if (step === 'done' || step === 'failed' || Date.now() > wait) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
