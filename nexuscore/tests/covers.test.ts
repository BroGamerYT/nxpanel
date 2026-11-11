import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { BRANDING, brandingFor, coverFor, looksLikeImage, readCustomCover, saveCustomCover, steamAppId, steamCover } =
  await import('../src/http/covers.js');
const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');

type Fetcher = import('../src/http/covers.js').Fetcher;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('eigenes-bild')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('steam-titelbild-test')]);
const pngDataUrl = (data: Buffer = PNG) => `data:image/png;base64,${data.toString('base64')}`;

/** Ersatz fuer fetch: liefert ein "Steam-Bild", kann ausfallen oder woanders landen. */
function steam(options: { fail?: boolean; foreign?: boolean; body?: Buffer } = {}) {
  const calls: string[] = [];
  const state = { fail: options.fail ?? false };
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    if (state.fail) return new Response('nicht da', { status: 503 });
    const response = new Response(new Uint8Array(options.body ?? JPG), { status: 200 });
    if (options.foreign) Object.defineProperty(response, 'url', { value: 'https://boese.example/bild.jpg' });
    return response;
  };
  return { fetcher, calls, state };
}

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-cover-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

async function dir(name: string): Promise<string> {
  const d = path.join(tmp, name);
  await fs.mkdir(d, { recursive: true });
  return d;
}

describe('Titelbilder - Auswahl', () => {
  it('findet die Steam-ID im Egg, sonst ueber den Namen', () => {
    expect(steamAppId('Palworld', null)).toBe(1623730);
    expect(steamAppId('Irgendein Spiel', { cover: { steam: 12345 } })).toBe(12345);
    expect(steamAppId('Palworld', { cover: { steam: 777 } })).toBe(777);
    expect(steamAppId('Irgendein Spiel', {})).toBeNull();
    // Unsinn im Egg faellt auf den Namen zurueck
    expect(steamAppId('Palworld', { cover: { steam: 'abc' } })).toBe(1623730);
    expect(steamAppId('Irgendein Spiel', { cover: { steam: -5 } })).toBeNull();
  });

  it('waehlt je Einstellung Steam, Panel-Motiv oder eigenes Bild', () => {
    const egg = { id: 'palworld', name: 'Palworld', raw: null };
    expect(coverFor(egg)).toEqual({ src: '/api/v1/eggs/palworld/cover?v=1', fit: 'banner', source: 'steam' });
    expect(coverFor(egg, { choice: 'steam', v: '99' }).src).toBe('/api/v1/eggs/palworld/cover?v=99');
    expect(coverFor(egg, { choice: 'custom', v: '5' })).toMatchObject({ source: 'custom', src: '/api/v1/eggs/palworld/cover?v=5' });
    expect(coverFor(egg, { choice: 'random', v: '1' }).source).toBe('branding');
    expect(coverFor(egg, { choice: 'branding:themes/amber-classic/banner.png', v: '1' })).toEqual({
      src: '/branding/themes/amber-classic/banner.png',
      fit: 'banner',
      source: 'branding',
    });
    // Ein erfundenes Motiv ist nicht erlaubt
    expect(coverFor(egg, { choice: 'branding:../../geheim.png', v: '1' }).source).toBe('steam');
  });

  it('gibt Spielen ohne Steam-Bild immer dasselbe Panel-Motiv', () => {
    const egg = { id: 'mumble', name: 'Mumble', raw: null };
    const first = coverFor(egg);
    expect(first.source).toBe('branding');
    expect(coverFor(egg)).toEqual(first);
    expect((BRANDING as readonly string[]).includes(brandingFor('mumble'))).toBe(true);
    expect(first.src).toBe(`/branding/${brandingFor('mumble')}`);
  });
});

describe('Titelbilder - Steam holen', () => {
  it('holt das Bild einmal und legt es ab', async () => {
    const d = await dir('steam-ok');
    const { fetcher, calls } = steam();
    const first = await steamCover(900001, d, fetcher);
    expect(first?.equals(JPG)).toBe(true);
    expect(calls).toHaveLength(1);
    expect((await fs.readdir(d)).sort()).toEqual(['steam-900001.jpg']);

    const second = await steamCover(900001, d, fetcher);
    expect(second?.equals(JPG)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('merkt sich einen Fehlschlag und fragt nicht bei jeder Kachel neu an', async () => {
    const d = await dir('steam-down');
    const { fetcher, calls } = steam({ fail: true });
    expect(await steamCover(900002, d, fetcher)).toBeNull();
    // beide Adressen versucht
    expect(calls).toHaveLength(2);
    expect(await steamCover(900002, d, fetcher)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(await fs.readdir(d)).toEqual([]);
  });

  it('verwirft Antworten von fremden Hosts und Dateien, die keine Bilder sind', async () => {
    const foreign = steam({ foreign: true });
    expect(await steamCover(900003, await dir('steam-foreign'), foreign.fetcher)).toBeNull();

    const notImage = steam({ body: Buffer.from('<html>kein Bild, nur Text</html>') });
    const d = await dir('steam-html');
    expect(await steamCover(900004, d, notImage.fetcher)).toBeNull();
    expect(await fs.readdir(d)).toEqual([]);
  });

  it('holt nichts fuer eine ungueltige ID', async () => {
    const { fetcher, calls } = steam();
    for (const id of [0, -1, 1.5, Number.NaN]) expect(await steamCover(id, await dir('steam-id'), fetcher)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('Titelbilder - eigenes Bild', () => {
  it('speichert PNG, JPEG und WebP und liest sie wieder', async () => {
    const d = await dir('custom');
    await saveCustomCover(d, 'spiel', pngDataUrl());
    expect(await readCustomCover(d, 'spiel')).toMatchObject({ type: 'image/png' });
    expect((await readCustomCover(d, 'spiel'))!.data.equals(PNG)).toBe(true);

    // Ein neues Bild ersetzt das alte, auch bei anderem Format
    await saveCustomCover(d, 'spiel', `data:image/jpeg;base64,${JPG.toString('base64')}`);
    expect(await readCustomCover(d, 'spiel')).toMatchObject({ type: 'image/jpeg' });
    expect((await fs.readdir(d)).filter((f) => f.startsWith('spiel.'))).toEqual(['spiel.jpg']);
    expect(await readCustomCover(d, 'gibt-es-nicht')).toBeNull();
  });

  it('lehnt falsche Typen, Nicht-Bilder, zu grosse Dateien und unsaubere IDs ab', async () => {
    const d = await dir('custom-bad');
    await expect(saveCustomCover(d, 'spiel', 'data:image/svg+xml;base64,AAAA')).rejects.toThrow(/PNG, JPEG oder WebP/);
    await expect(saveCustomCover(d, 'spiel', pngDataUrl(Buffer.from('das ist kein bild, nur text')))).rejects.toThrow(/kein Bild/);
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2 * 1024 * 1024 + 10)]);
    await expect(saveCustomCover(d, 'spiel', pngDataUrl(big))).rejects.toThrow(/zu gross/);
    await expect(saveCustomCover(d, '../boese', pngDataUrl())).rejects.toThrow(/Ungueltige/);
    expect(await readCustomCover(d, '../boese')).toBeNull();
    expect(await fs.readdir(d)).toEqual([]);
    expect(looksLikeImage(PNG)).toBe(true);
    expect(looksLikeImage(Buffer.from('zu kurz'))).toBe(false);
  });
});

describe('Titelbilder - Routen', () => {
  let server: Awaited<ReturnType<typeof createCoreServer>>;
  let driver: InstanceType<typeof MockDriver>;
  let registry: InstanceType<typeof ServerRegistry>;
  let net: ReturnType<typeof steam>;
  let token: string;
  let auth: Record<string, string>;
  let cookie: Record<string, string>;

  beforeAll(async () => {
    const data = await dir('routes');
    registry = await ServerRegistry.open(data);
    driver = new MockDriver();
    await driver.initialize();
    net = steam();
    server = await createCoreServer(driver, new EventBus(), registry, { installs: null, fetchImpl: net.fetcher });
    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { login: 'admin', password: 'nur-fuer-tests-0815' },
    });
    token = login.json().accessToken as string;
    auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    cookie = { cookie: `nxp_session=${token}` };
  });

  afterAll(async () => {
    await server.close();
    await driver.shutdown();
    registry.close();
  });

  const eggs = async () =>
    (await server.inject({ method: 'GET', url: '/api/v1/eggs', headers: auth })).json().eggs as Array<{
      id: string;
      cover: { src: string; fit: string; source: string };
      coverChoice: string;
      hasSteamCover: boolean;
    }>;
  const egg = async (id: string) => (await eggs()).find((e) => e.id === id)!;
  const put = (id: string, payload: unknown, headers: Record<string, string> = auth) =>
    server.inject({ method: 'PUT', url: `/api/v1/admin/eggs/${id}/cover`, headers, payload: payload as object });

  it('liefert in der Spieleliste ein Titelbild je Spiel', async () => {
    const list = await eggs();
    const palworld = list.find((e) => e.id === 'palworld')!;
    expect(palworld).toMatchObject({
      cover: { src: '/api/v1/eggs/palworld/cover?v=1', fit: 'banner', source: 'steam' },
      coverChoice: 'auto',
      hasSteamCover: true,
    });

    // Steam-ID aus dem Egg selbst (nicht in der Namensliste)
    expect(list.find((e) => e.id === 'astroneer')).toMatchObject({ hasSteamCover: true, cover: { source: 'steam' } });
    // Ohne Steam-Bild: ein Panel-Motiv, das der Browser direkt laden kann
    const mumble = list.find((e) => e.id === 'mumble')!;
    expect(mumble.hasSteamCover).toBe(false);
    expect(mumble.cover).toMatchObject({ source: 'branding' });
    expect(mumble.cover.src.startsWith('/branding/')).toBe(true);

    // Fast alle mitgelieferten Spiele haben ein Steam-Bild
    expect(list.filter((e) => e.hasSteamCover).length).toBeGreaterThanOrEqual(29);
  });

  it('liefert das Steam-Bild ueber den Core aus und holt es nur einmal', async () => {
    const first = await server.inject({ method: 'GET', url: '/api/v1/eggs/palworld/cover?v=1', headers: auth });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.headers['cache-control']).toContain('max-age');
    expect(first.rawPayload.equals(JPG)).toBe(true);

    const callsBefore = net.calls.length;
    const again = await server.inject({ method: 'GET', url: '/api/v1/eggs/palworld/cover?v=1', headers: auth });
    expect(again.statusCode).toBe(200);
    expect(net.calls.length).toBe(callsBefore);
    // Der Browser holt das Bild nie selbst bei Steam
    expect(net.calls.every((c) => c.includes('steamstatic.com'))).toBe(true);
  });

  it('laedt das Bild auch mit dem Cookie der Sitzung (so macht es ein <img>)', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/eggs/palworld/cover?v=1', headers: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const anonymous = await server.inject({ method: 'GET', url: '/api/v1/eggs/palworld/cover?v=1' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('antwortet mit 404, wenn es kein Bild gibt oder Steam nicht erreichbar ist', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/v1/eggs/gibt-es-nicht/cover', headers: auth })).statusCode).toBe(404);
    const noSteam = await server.inject({ method: 'GET', url: '/api/v1/eggs/mumble/cover', headers: auth });
    expect(noSteam.statusCode).toBe(404);
    // Ein 404 darf nicht einen Tag lang im Browser haengen bleiben.
    expect(noSteam.headers['cache-control'] ?? '').not.toContain('max-age');

    net.state.fail = true;
    try {
      const down = await server.inject({ method: 'GET', url: '/api/v1/eggs/valheim/cover', headers: auth });
      expect(down.statusCode).toBe(404);
      // nicht zwischenspeichern, sonst bleibt das Bild nach einem Netzausfall weg
      expect(down.headers['cache-control']).toBe('no-store');
    } finally {
      net.state.fail = false;
    }
  });

  it('Admin: waehlt Panel-Motiv, Steam und eigenes Bild', async () => {
    expect((await put('terraria', { choice: 'random' })).statusCode).toBe(200);
    expect(await egg('terraria')).toMatchObject({ coverChoice: 'random', cover: { source: 'branding' } });
    expect((await server.inject({ method: 'GET', url: '/api/v1/eggs/terraria/cover', headers: auth })).statusCode).toBe(404);

    const before = (await egg('terraria')).cover.src;
    expect((await put('terraria', { choice: 'branding:themes/arctic-cyan/banner.png' })).statusCode).toBe(200);
    expect((await egg('terraria')).cover.src).toBe('/branding/themes/arctic-cyan/banner.png');
    expect(before).not.toBe('/branding/themes/arctic-cyan/banner.png');

    expect((await put('terraria', { choice: 'steam' })).statusCode).toBe(200);
    const steamNow = await egg('terraria');
    expect(steamNow).toMatchObject({ coverChoice: 'steam', cover: { source: 'steam' } });
    // neue Adresse, damit der Browser das alte Bild nicht behaelt
    expect(steamNow.cover.src).not.toBe('/api/v1/eggs/terraria/cover?v=1');

    expect((await put('terraria', { upload: pngDataUrl() })).statusCode).toBe(200);
    expect(await egg('terraria')).toMatchObject({ coverChoice: 'custom', cover: { source: 'custom' } });
    const custom = await server.inject({ method: 'GET', url: '/api/v1/eggs/terraria/cover', headers: auth });
    expect(custom.statusCode).toBe(200);
    expect(custom.headers['content-type']).toBe('image/png');
    expect(custom.rawPayload.equals(PNG)).toBe(true);

    // Zurueck auf automatisch: wieder das Steam-Bild
    expect((await put('terraria', { choice: 'auto' })).statusCode).toBe(200);
    expect(await egg('terraria')).toMatchObject({ coverChoice: 'auto', cover: { source: 'steam' } });

    const actions = registry.recentAudit({ limit: 50 }).filter((e) => e.action === 'egg.cover');
    expect(actions.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(actions)).not.toContain(PNG.toString('base64'));
  });

  it('Admin: weist Unsinn ab', async () => {
    expect((await put('mumble', { choice: 'steam' })).statusCode).toBe(400);
    expect((await put('mumble', { choice: 'custom' })).statusCode).toBe(400);
    expect((await put('mumble', { choice: 'explodieren' })).statusCode).toBe(400);
    expect((await put('mumble', { choice: 'branding:../../geheim.png' })).statusCode).toBe(400);
    expect((await put('mumble', {})).statusCode).toBe(400);
    expect((await put('mumble', { upload: pngDataUrl(Buffer.from('kein bild, nur text')) })).statusCode).toBe(400);
    expect((await put('gibt-es-nicht', { choice: 'random' })).statusCode).toBe(404);
    expect((await egg('mumble')).coverChoice).toBe('auto');
  });

  it('Admin: verlangt eine Anmeldung und eine eigene Herkunft', async () => {
    expect((await put('mumble', { choice: 'random' }, { 'content-type': 'application/json' })).statusCode).toBe(401);
    expect(
      (await put('mumble', { choice: 'random' }, { ...auth, origin: 'https://boese.example' })).statusCode,
    ).toBe(403);
    expect((await egg('mumble')).coverChoice).toBe('auto');
  });

  it('zeigt Servern das Titelbild ihres Spiels - ueber den Core, nicht direkt von Steam', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/servers',
      headers: auth,
      payload: { name: 'Fabrik', eggId: 'factorio' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().server.id as string;

    const list = await server.inject({ method: 'GET', url: '/api/v1/servers', headers: auth });
    const cover = list.json().servers.find((s: { id: string }) => s.id === id).cover;
    expect(cover).toMatchObject({ source: 'steam', fit: 'banner' });
    expect(cover.src).toBe('/api/v1/eggs/factorio/cover?v=1');

    const detail = await server.inject({ method: 'GET', url: `/api/v1/servers/${id}`, headers: auth });
    expect(detail.json().server.cover.src).toBe('/api/v1/eggs/factorio/cover?v=1');
  });
});
