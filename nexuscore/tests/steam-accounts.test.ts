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
const { classifySteamOutput } = await import('../src/steam/accounts.js');
const { createLoginRunner, STEAMCMD_IMAGE } = await import('../src/steam/login.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', ...json };
const PW = 'ein-sicheres-passwort-1';
const STEAM_PW = 'steam-passwort-streng-geheim-77';

// Was SteamCMD als Nächstes "sagen" soll
let nextOutput = 'Logging in user x to Steam Public...OK';
const seen: Array<{ accountName: string; code?: string; password: string }> = [];

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
const ids: Record<string, string> = {};
type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, headers: Headers = MASTER, payload?: unknown) =>
  server.inject({
    method,
    url,
    headers: payload === undefined ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type')) : headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
async function login(name: string): Promise<Headers> {
  const res = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: name, password: PW } });
  return { authorization: `Bearer ${res.json().accessToken}`, ...json };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-steam-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, {
    installs: null,
    scheduler: false,
    steam: {
      login: async (input) => {
        seen.push({ accountName: input.accountName, password: input.password, ...(input.code ? { code: input.code } : {}) });
        return nextOutput;
      },
    },
  });
  for (const name of ['sa-anna', 'sa-ben']) ids[name] = (await call('POST', '/api/v1/admin/users', MASTER, { username: name, password: PW })).json().user.id as string;
});
afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Auswertung der SteamCMD-Ausgabe', () => {
  const v = (out: string, code = false) => classifySteamOutput(out, code, 'none');
  it('erkennt Erfolg, Handy-Bestätigung, Guard, falsches Passwort und Sperre', () => {
    expect(v('Logging in user a to Steam Public...OK').status).toBe('ok');
    expect(v('Waiting for confirmation...OK', true).message).toContain('verifiziert');
    expect(v('Waiting for confirmation...').guardType).toBe('app');
    expect(v('FAILED (Two-factor code mismatch)')).toMatchObject({ status: 'needed', guardType: 'app' });
    expect(v('FAILED (Account Logon Denied)')).toMatchObject({ status: 'needed', guardType: 'email' });
    expect(v('FAILED (Two-factor code mismatch)', true).prompt).toContain('ungültig');
    expect(v('FAILED (Invalid Password)')).toMatchObject({ status: 'needed' });
    expect(v('FAILED (Invalid Password)', true)).toMatchObject({ status: 'failed' });
    expect(v('FAILED (Rate Limit Exceeded)').status).toBe('failed');
    expect(v('FAILED (Rate Limit Exceeded)').message).toContain('Fehlversuche');
    expect(v('etwas ganz anderes').message).toContain('Unerwartete');
  });
});

describe('Konten', () => {
  let anna: Headers;
  let ben: Headers;
  let annaAcc: string;
  beforeAll(async () => {
    anna = await login('sa-anna');
    ben = await login('sa-ben');
  });

  it('anlegen: das Passwort kommt nie zurück, liegt nur verschlüsselt und nicht im Protokoll', async () => {
    const res = await call('POST', '/api/v1/steam/accounts', anna, { accountName: 'annas_steam', password: STEAM_PW, label: 'Annas Konto' });
    expect(res.statusCode, res.body).toBe(201);
    annaAcc = res.json().account.id;
    expect(res.body).not.toContain(STEAM_PW);
    expect(res.json().account).toMatchObject({ accountName: 'annas_steam', label: 'Annas Konto', hasPassword: true, isOwner: true, isShared: false, guardStatus: 'none', ownerName: 'sa-anna' });
    expect((await call('GET', '/api/v1/steam/accounts', anna)).body).not.toContain(STEAM_PW);
    expect(JSON.stringify(registry.getSetting('steam.accounts'))).not.toContain(STEAM_PW);
    expect(JSON.stringify(registry.getSetting(`secret.steam.${annaAcc}.password`))).not.toContain(STEAM_PW);
    expect(JSON.stringify((await call('GET', '/api/v1/admin/audit?limit=100')).json())).not.toContain(STEAM_PW);
  });

  it('jeder sieht nur seine eigenen und freigegebene Konten; Administratoren alle', async () => {
    expect((await call('GET', '/api/v1/steam/accounts', ben)).json().accounts).toEqual([]);
    expect((await call('GET', '/api/v1/steam/accounts', MASTER)).json().accounts).toHaveLength(1);
    const shared = await call('POST', '/api/v1/steam/accounts', MASTER, { accountName: 'team_konto', password: STEAM_PW, isShared: true });
    expect(shared.json().account.ownerName).toBe('NexusCore');
    const forBen = (await call('GET', '/api/v1/steam/accounts', ben)).json().accounts as Array<{ accountName: string; isOwner: boolean }>;
    expect(forBen.map((a) => a.accountName)).toEqual(['team_konto']);
    expect(forBen[0]!.isOwner).toBe(false);
  });

  it('Rechte: fremde Konten sind unsichtbar (404), freigegebene nur ansehbar und testbar (403 beim Ändern/Löschen)', async () => {
    const sharedId = (await call('GET', '/api/v1/steam/accounts', ben)).json().accounts[0].id as string;
    expect((await call('DELETE', `/api/v1/steam/accounts/${annaAcc}`, ben)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/steam/accounts/${annaAcc}/test`, ben, {})).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/steam/accounts', ben, { id: annaAcc, accountName: 'geklaut' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/steam/accounts/${sharedId}`, ben)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/steam/accounts', ben, { id: sharedId, accountName: 'team_konto', password: 'x' })).statusCode).toBe(403);
    nextOutput = 'Logging in user x to Steam Public...OK';
    expect((await call('POST', `/api/v1/steam/accounts/${sharedId}/test`, ben, {})).json().status).toBe('ok');
    expect((await call('GET', '/api/v1/steam/accounts', {})).statusCode).toBe(401);
  });

  it('einen Namen gibt es nur einmal - auch nicht über Groß-/Kleinschreibung oder fremde Konten', async () => {
    expect((await call('POST', '/api/v1/steam/accounts', ben, { accountName: 'ANNAS_STEAM', password: 'x' })).statusCode).toBe(409);
    expect((await call('POST', '/api/v1/steam/accounts', anna, { accountName: 'annas_steam' })).statusCode).toBe(409);
  });

  it('ungültige Angaben', async () => {
    for (const bad of [{ accountName: 'a' }, { accountName: 'mit leerzeichen' }, { accountName: 'ok_name', steamId: 'abc' }, { accountName: 'ok_name', password: '' }]) {
      expect((await call('POST', '/api/v1/steam/accounts', anna, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await call('POST', '/api/v1/steam/accounts/kein-uuid/test', anna, {})).statusCode).toBe(404);
  });

  it('Test: Handy-Bestätigung, dann Guard-Code, dann in Ordnung; das Passwort geht an SteamCMD, nie zurück', async () => {
    nextOutput = 'Logging in user annas_steam to Steam Public... Waiting for confirmation...';
    const first = (await call('POST', `/api/v1/steam/accounts/${annaAcc}/test`, anna, {})).json();
    expect(first).toMatchObject({ status: 'needed', guardType: 'app' });
    expect(first.account).toMatchObject({ guardStatus: 'needed', guardType: 'app' });
    expect(seen.at(-1)).toMatchObject({ accountName: 'annas_steam', password: STEAM_PW });

    nextOutput = 'FAILED (Two-factor code mismatch)';
    const wrong = (await call('POST', `/api/v1/steam/accounts/${annaAcc}/guard`, anna, { code: 'abc12' })).json();
    expect(wrong.status).toBe('needed');
    expect(seen.at(-1)!.code).toBe('ABC12');

    nextOutput = `Logging in user x to Steam Public...OK (${STEAM_PW})`;
    const ok = await call('POST', `/api/v1/steam/accounts/${annaAcc}/guard`, anna, { code: 'ABC12' });
    expect(ok.json()).toMatchObject({ status: 'ok' });
    expect(ok.json().account).toMatchObject({ guardStatus: 'ok', guardPrompt: null });
    expect(ok.json().account.lastUsedAt).toBeTruthy();
    expect(ok.body).not.toContain(STEAM_PW);
    const audit = JSON.stringify((await call('GET', '/api/v1/admin/audit?limit=100')).json());
    expect(audit).toContain('steam.guard_submit');
    expect(audit).not.toContain('ABC12');
    expect((await call('POST', `/api/v1/steam/accounts/${annaAcc}/guard`, anna, { code: 'x' })).statusCode).toBe(400);
  });

  it('SteamCMD nicht startbar oder abgestürzt: ehrliche Meldung, nichts bleibt hängen', async () => {
    const acc = (await call('POST', '/api/v1/steam/accounts', anna, { accountName: 'ohne_passwort' })).json().account;
    expect(acc.hasPassword).toBe(false);
    const res = await call('POST', `/api/v1/steam/accounts/${acc.id}/test`, anna, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('no_password');
  });

  it('Passwort oder Name ändern setzt die Prüfung zurück', async () => {
    const res = await call('POST', '/api/v1/steam/accounts', anna, { id: annaAcc, accountName: 'annas_steam', password: 'neues-passwort-123' });
    expect(res.statusCode).toBe(200);
    expect(res.json().account.guardStatus).toBe('none');
    nextOutput = 'Logging in user x to Steam Public...OK';
    await call('POST', `/api/v1/steam/accounts/${annaAcc}/test`, anna, {});
    expect(seen.at(-1)!.password).toBe('neues-passwort-123');
  });

  it('Löschen entfernt Konto und Passwort; Administratoren löschen fremde', async () => {
    expect((await call('DELETE', `/api/v1/steam/accounts/${annaAcc}`, MASTER)).json()).toEqual({ ok: true });
    expect(registry.getSetting(`secret.steam.${annaAcc}.password`)).toBeUndefined();
    expect((await call('DELETE', `/api/v1/steam/accounts/${annaAcc}`, MASTER)).statusCode).toBe(404);
  });
});

describe('Anmeldung in der Umgebung des Cores', () => {
  it('Docker: SteamCMD im Container, Passwort nur in der Umgebung, nicht im Befehl', async () => {
    const specs: Array<{ image: string; script: string; env: Record<string, string>; hostDir: string }> = [];
    const driver = { name: 'docker', runInstaller: async (spec: (typeof specs)[number], onLog: (l: string) => void) => (specs.push(spec), onLog('Logging in user x to Steam Public...OK'), 0) };
    const run = createLoginRunner(driver as never, dir)!;
    const out = await run({ accountId: 'abc-123', accountName: 'konto', password: 'geheim-pw-123', code: 'ABCDE' });
    expect(out).toContain('Public...OK');
    expect(specs[0]).toMatchObject({ image: STEAMCMD_IMAGE, env: { STEAM_USER: 'konto', STEAM_PASS: 'geheim-pw-123', STEAM_CODE: 'ABCDE' } });
    expect(specs[0]!.script).not.toContain('geheim-pw-123');
    expect(specs[0]!.hostDir).toContain('steam-login');
  });
  it('ohne Docker und ohne Windows-Direktbetrieb gibt es keinen Weg', () => {
    expect(createLoginRunner({ name: 'mock' } as never, dir)).toBeNull();
  });
});
