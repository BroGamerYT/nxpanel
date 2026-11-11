import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij' };
const PW = 'ein-sicheres-passwort-1';
const HOST = 'localhost:8443';

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;

type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Headers, payload?: unknown) =>
  server.inject({
    method,
    url,
    headers: payload === undefined ? headers : { ...headers, ...json },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function makeUser(name: string, extra: Record<string, unknown> = {}) {
  const created = await call('POST', '/api/v1/admin/users', MASTER, { username: name, password: PW, ...extra });
  expect(created.statusCode, created.body).toBe(201);
  const login = await call('POST', '/api/v1/auth/login', { host: HOST }, { login: name, password: PW });
  return { id: created.json().user.id as string, h: { host: HOST, authorization: `Bearer ${login.json().accessToken}` } };
}

let nonce = 0;
/** Die Antwort, die Steam an den Browser schickt: eine Adresse mit allen openid-Feldern. */
function steamReturn(steamId: string, returnTo: string, opts: { endpoint?: string; nonceValue?: string } = {}): string {
  const u = new URL(returnTo);
  const p = u.searchParams;
  p.set('openid.ns', 'http://specs.openid.net/auth/2.0');
  p.set('openid.mode', 'id_res');
  p.set('openid.op_endpoint', opts.endpoint ?? 'https://steamcommunity.com/openid/login');
  p.set('openid.claimed_id', `https://steamcommunity.com/openid/id/${steamId}`);
  p.set('openid.identity', `https://steamcommunity.com/openid/id/${steamId}`);
  p.set('openid.return_to', returnTo);
  p.set('openid.response_nonce', opts.nonceValue ?? `2026-11-12T10:00:00Z${steamId}-${++nonce}`);
  p.set('openid.assoc_handle', '1234567890');
  p.set('openid.signed', 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle');
  p.set('openid.sig', 'abc=');
  return `${u.pathname}${u.search}`;
}

/** Steam-Attrappe: bestaetigt die Antwort (oder nicht) und liefert das Profil. */
function fakeSteam(valid: boolean, name = 'Spieler Eins') {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/openid/login')) return new Response(valid ? 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n' : 'is_valid:false\n');
      return new Response(`<profile><steamID><![CDATA[${name}]]></steamID><avatarFull><![CDATA[https://avatars.steamstatic.com/x_full.jpg]]></avatarFull></profile>`);
    }),
  );
  return calls;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-steam-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const RETURN = `http://${HOST}/api/v1/auth/steam/callback`;

describe('Anmeldung mit Steam', () => {
  it('die Anmeldeseite erfährt, dass Steam geht', async () => {
    expect((await call('GET', '/api/v1/auth/methods', {})).json()).toMatchObject({ steam: true });
    expect((await call('GET', '/api/v1/about', MASTER)).json().features).toContain('steam');
  });

  it('leitet zu Steam weiter - mit Rückkehr-Adresse und Bereich dieses Cores', async () => {
    const res = await call('GET', '/api/v1/auth/steam/login', { host: HOST });
    expect(res.statusCode).toBe(302);
    const to = new URL(res.headers.location as string);
    expect(to.origin + to.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(to.searchParams.get('openid.return_to')).toBe(`${RETURN}?action=login`);
    expect(to.searchParams.get('openid.realm')).toBe(`http://${HOST}`);
    // Verknüpfen ohne Einmal-Token geht nicht
    const link = await call('GET', '/api/v1/auth/steam/login?action=link', { host: HOST });
    expect(link.headers.location).toBe('/account?error=unauthenticated');
  });

  it('verknüpft ein Steam-Konto mit dem angemeldeten Benutzer und meldet danach damit an', async () => {
    const u = await makeUser('st-spieler');
    fakeSteam(true);
    const start = (await call('POST', '/api/v1/auth/steam/link-start', u.h, {})).json();
    expect(start.url).toMatch(/^\/api\/v1\/auth\/steam\/login\?action=link&state=/);
    const redirect = await call('GET', start.url, { host: HOST });
    const returnTo = new URL(redirect.headers.location as string).searchParams.get('openid.return_to')!;

    const back = await call('GET', steamReturn('76561198000000001', returnTo), { host: HOST });
    expect(back.headers.location).toBe('/account?steam=linked');
    const me = (await call('GET', '/api/v1/auth/me', u.h)).json().user;
    expect(me).toMatchObject({ steamId: '76561198000000001', steamName: 'Spieler Eins' });
    expect(me.avatar).toBe('https://avatars.steamstatic.com/x_full.jpg');
    // In der Benutzerverwaltung sieht der Admin es auch
    const list = (await call('GET', '/api/v1/admin/users', MASTER)).json();
    const row = (list.users ?? list).find((x: { username: string }) => x.username === 'st-spieler');
    expect(row.steamId).toBe('76561198000000001');

    // Anmelden: Cookie und Weiterleitung auf die Startseite
    const login = await call('GET', steamReturn('76561198000000001', `${RETURN}?action=login`), { host: HOST });
    expect(login.headers.location).toBe('/?login=steam');
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('nxp_session=');
    expect(cookie).toContain('HttpOnly');
    const who = await call('GET', '/api/v1/auth/me', { host: HOST, cookie: cookie.split(';')[0]! });
    expect(who.json().user.username).toBe('st-spieler');
  });

  it('das Einmal-Token gilt nur einmal und ist an den Benutzer gebunden', async () => {
    const u = await makeUser('st-einmal');
    fakeSteam(true);
    const start = (await call('POST', '/api/v1/auth/steam/link-start', u.h, {})).json();
    const returnTo = new URL((await call('GET', start.url, { host: HOST })).headers.location as string).searchParams.get('openid.return_to')!;
    expect((await call('GET', steamReturn('76561198000000002', returnTo), { host: HOST })).headers.location).toBe('/account?steam=linked');
    // Wiederholen mit demselben Token: kein Zugriff mehr
    expect((await call('GET', steamReturn('76561198000000003', returnTo), { host: HOST })).headers.location).toBe('/account?error=unauthenticated');
    expect((await call('GET', '/api/v1/auth/me', u.h)).json().user.steamId).toBe('76561198000000002');
    // Ohne Anmeldung kein Token; das Master-Token hat kein Konto
    expect((await call('POST', '/api/v1/auth/steam/link-start', { host: HOST }, {})).statusCode).toBe(401);
    expect((await call('POST', '/api/v1/auth/steam/link-start', { ...MASTER, host: HOST }, {})).statusCode).toBe(403);
  });

  it('ein Steam-Konto gehört nur einem Benutzer', async () => {
    const a = await makeUser('st-a');
    const b = await makeUser('st-b');
    fakeSteam(true);
    for (const [u, expected] of [[a, '/account?steam=linked'], [b, '/account?error=steam_already_linked']] as const) {
      const start = (await call('POST', '/api/v1/auth/steam/link-start', u.h, {})).json();
      const returnTo = new URL((await call('GET', start.url, { host: HOST })).headers.location as string).searchParams.get('openid.return_to')!;
      expect((await call('GET', steamReturn('76561198000000004', returnTo), { host: HOST })).headers.location).toBe(expected);
    }
    expect((await call('GET', '/api/v1/auth/me', b.h)).json().user.steamId).toBeNull();
  });

  it('trennt die Verknüpfung; danach kommt niemand mehr damit hinein', async () => {
    const u = await makeUser('st-trennen', { steamId: '76561198000000005' });
    fakeSteam(true);
    expect((await call('GET', '/api/v1/auth/me', u.h)).json().user.steamId).toBe('76561198000000005');
    expect((await call('POST', '/api/v1/auth/steam/unlink', u.h, {})).json()).toEqual({ ok: true });
    expect((await call('GET', '/api/v1/auth/me', u.h)).json().user.steamId).toBeNull();
    const res = await call('GET', steamReturn('76561198000000005', `${RETURN}?action=login`), { host: HOST });
    expect(res.headers.location).toMatch(/^\/login\?error=steam_not_linked&steamId=76561198000000005/);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('ein unbekanntes Steam-Konto bekommt keine Sitzung - nur die ID für den Administrator', async () => {
    fakeSteam(true, 'Fremder');
    const res = await call('GET', steamReturn('76561198999999999', `${RETURN}?action=login`), { host: HOST });
    expect(res.headers.location).toBe('/login?error=steam_not_linked&steamId=76561198999999999&name=Fremder');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('gesperrte Benutzer kommen nicht hinein', async () => {
    const u = await makeUser('st-gesperrt', { steamId: '76561198000000006' });
    expect((await call('PATCH', `/api/v1/admin/users/${u.id}`, MASTER, { suspended: true })).statusCode).toBe(200);
    fakeSteam(true);
    const res = await call('GET', steamReturn('76561198000000006', `${RETURN}?action=login`), { host: HOST });
    expect(res.headers.location).toBe('/login?error=suspended');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('weist Fälschungen ab: Steam sagt nein, falscher Anbieter, fremde Rückkehr-Adresse, Wiedereinspielen', async () => {
    await makeUser('st-opfer', { steamId: '76561198000000007' });
    const denied = '/login?error=steam_verify_failed';
    const login = async (url: string) => (await call('GET', url, { host: HOST })).headers.location;

    fakeSteam(false);
    expect(await login(steamReturn('76561198000000007', `${RETURN}?action=login`))).toBe(denied);

    const calls = fakeSteam(true);
    // Antwort eines anderen "Steam"
    expect(await login(steamReturn('76561198000000007', `${RETURN}?action=login`, { endpoint: 'https://evil.example/openid/login' }))).toBe(denied);
    // Antwort, die für eine andere Seite ausgestellt wurde
    expect(await login(steamReturn('76561198000000007', 'http://other.example/api/v1/auth/steam/callback?action=login'))).toBe(denied);
    // ohne openid-Felder
    expect(await login('/api/v1/auth/steam/callback?action=login')).toBe(denied);
    // Alle diese Fälle kommen gar nicht erst bis zu Steam
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);

    // Wiedereinspielen: dieselbe Antwort ein zweites Mal
    const replay = steamReturn('76561198000000007', `${RETURN}?action=login`, { nonceValue: 'fester-nonce-1' });
    expect(await login(replay)).toBe('/?login=steam');
    expect(await login(replay)).toBe(denied);
  });

  it('der Administrator kann die SteamID64 setzen und entfernen - ungültige werden abgelehnt', async () => {
    const u = await makeUser('st-admin-setzt');
    const set = await call('PATCH', `/api/v1/admin/users/${u.id}`, MASTER, { steamId: '76561198000000008' });
    expect(set.statusCode, set.body).toBe(200);
    expect((await call('GET', '/api/v1/auth/me', u.h)).json().user.steamId).toBe('76561198000000008');
    expect((await call('PATCH', `/api/v1/admin/users/${u.id}`, MASTER, { steamId: 'abc' })).statusCode).toBe(400);
    const other = await makeUser('st-admin-doppelt');
    expect((await call('PATCH', `/api/v1/admin/users/${other.id}`, MASTER, { steamId: '76561198000000008' })).statusCode).toBe(409);
    expect((await call('PATCH', `/api/v1/admin/users/${u.id}`, MASTER, { steamId: null })).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/auth/me', u.h)).json().user.steamId).toBeNull();
  });
});
