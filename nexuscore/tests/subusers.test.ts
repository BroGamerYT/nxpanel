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
const { PRESETS, SERVER_FLAGS } = await import('../src/auth/permissions.js');

const json = { 'content-type': 'application/json' };
const PW = 'ein-sicheres-passwort-1';

type Headers = Record<string, string>;
let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
let admin: Headers;
const ids: Record<string, string> = {};
const auth: Record<string, Headers> = {};

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Headers = {}, payload?: unknown) =>
  server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function login(name: string, password: string): Promise<Headers> {
  const res = await call('POST', '/api/v1/auth/login', {}, { login: name, password });
  expect(res.statusCode, `Anmeldung ${name}: ${res.body}`).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

const S = '/api/v1/servers/su-1';
const lacking = SERVER_FLAGS.filter((f) => !(PRESETS['co-admin'].flags as readonly string[]).includes(f));

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-subusers-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
  admin = await login('admin', 'nur-fuer-tests-0815');
  const root = path.join(dir, 'servers', 'su-1');
  await fs.mkdir(root, { recursive: true });
  await registry.add({ id: 'su-1', name: 'Gemeinsam', game: 'x', executable: 'x', args: [], workingDir: root, ports: [] });
  for (const name of ['su-owner', 'su-co', 'su-view', 'su-op', 'su-extra', 'su-fremd']) {
    const res = await call('POST', '/api/v1/admin/users', admin, { username: name, password: PW });
    expect(res.statusCode, res.body).toBe(201);
    ids[name] = res.json().user.id as string;
    auth[name] = await login(name, PW);
  }
  expect((await call('PUT', `/api/v1/admin/users/${ids['su-owner']}/servers/su-1`, admin, { isOwner: true })).statusCode).toBe(200);
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Mitnutzer', () => {
  it('der Rechte-Katalog ist für jeden mit Leserecht abrufbar', async () => {
    const res = (await call('GET', `${S}/subusers/permissions`, auth['su-owner']!)).json();
    expect(res.flags).toEqual([...SERVER_FLAGS]);
    expect(res.presets['co-admin'].label).toBe('Co-Admin');
    expect(res.labels['subuser.read']).toBeTruthy();
    // Ohne Anmeldung und ohne Zugang zum Server: nichts
    expect((await call('GET', `${S}/subusers/permissions`)).statusCode).toBe(401);
    expect((await call('GET', `${S}/subusers/permissions`, auth['su-fremd']!)).statusCode).toBe(404);
  });

  it('der Besitzer lädt ein: Vorlage oder einzelne Haken; die Liste zeigt Name, Rechte und seit wann', async () => {
    const owner = auth['su-owner']!;
    expect((await call('GET', `${S}/subusers`, owner)).json()).toEqual({ subusers: [] });
    const co = await call('POST', `${S}/subusers`, owner, { user: 'su-co', preset: 'co-admin' });
    expect(co.statusCode, co.body).toBe(201);
    expect(co.json()).toMatchObject({ userId: ids['su-co'], username: 'su-co' });
    const view = await call('POST', `${S}/subusers`, owner, { user: 'SU-VIEW', permissions: ['control.console', 'file.read'] }); // ohne Beachtung der Schreibweise
    expect(view.statusCode, view.body).toBe(201);
    expect(view.json().permissions).toEqual(['control.console', 'file.read']);

    const list = (await call('GET', `${S}/subusers`, owner)).json().subusers as Array<{ username: string; permissions: string[]; since: string }>;
    expect(list.map((s) => s.username)).toEqual(['su-co', 'su-view']);
    expect(Number.isNaN(Date.parse(list[0]!.since))).toBe(false);
    expect(list[0]!.permissions).toEqual([...PRESETS['co-admin'].flags]);
  });

  it('der Mitnutzer sieht den Server jetzt - mit genau seinen Rechten', async () => {
    const list = (await call('GET', '/api/v1/servers', auth['su-view']!)).json().servers as Array<{ id: string; permissions: string[] }>;
    const mine = list.find((s) => s.id === 'su-1');
    expect(mine).toBeTruthy();
    expect(mine!.permissions).toEqual(expect.arrayContaining(['control.console', 'file.read']));
    expect(mine!.permissions).not.toContain('control.start');
    expect((await call('GET', `${S}/files`, auth['su-view']!)).statusCode).toBe(200);
    expect((await call('POST', `${S}/power`, auth['su-view']!, { action: 'start' })).statusCode).toBe(403);
    // Der Mitnutzer-Tab bleibt ihm verborgen: kein Recht, die Liste zu sehen
    expect((await call('GET', `${S}/subusers`, auth['su-view']!)).statusCode).toBe(403);
  });

  it('abgelehnt: doppelt, Besitzer, Administrator, unbekanntes Konto, unbekannte Rechte, leere Angabe', async () => {
    const owner = auth['su-owner']!;
    expect((await call('POST', `${S}/subusers`, owner, { user: 'su-co', preset: 'operator' })).statusCode).toBe(409);
    expect((await call('POST', `${S}/subusers`, owner, { user: 'su-owner', preset: 'operator' })).statusCode).toBe(400);
    expect((await call('POST', `${S}/subusers`, owner, { user: 'admin', preset: 'operator' })).statusCode).toBe(400);
    expect((await call('POST', `${S}/subusers`, owner, { user: 'gibtsnicht', preset: 'operator' })).json().code).toBe('user_not_found');
    expect((await call('POST', `${S}/subusers`, owner, { user: 'su-extra', permissions: ['control.console', 'erfunden.recht'] })).statusCode).toBe(400);
    expect((await call('POST', `${S}/subusers`, owner, { user: 'su-extra' })).statusCode).toBe(400);
    expect((await call('POST', `${S}/subusers`, owner, { user: 'su-extra', preset: 'gibtsnicht' })).statusCode).toBe(400);
    expect((await call('GET', `${S}/subusers`, owner)).json().subusers).toHaveLength(2);
  });

  it('wer kein Recht zum Einladen hat, darf es nicht - und kein anderer Server ist erreichbar', async () => {
    expect((await call('POST', `${S}/subusers`, auth['su-view']!, { user: 'su-extra', preset: 'zuschauer' })).statusCode).toBe(403);
    expect((await call('POST', `${S}/subusers`, auth['su-fremd']!, { user: 'su-extra', preset: 'zuschauer' })).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/servers/gibtsnicht/subusers', admin, { user: 'su-extra', preset: 'zuschauer' })).statusCode).toBe(404);
  });

  it('ein Co-Admin darf nur Rechte vergeben, die er selbst hat', async () => {
    expect(lacking.length).toBeGreaterThan(0);
    const co = auth['su-co']!;
    const over = await call('POST', `${S}/subusers`, co, { user: 'su-extra', permissions: ['control.console', lacking[0]!] });
    expect(over.statusCode).toBe(403);
    expect(over.json().message).toContain(lacking[0]);
    expect((await call('POST', `${S}/subusers`, co, { user: 'su-extra', preset: 'operator' })).statusCode).toBe(201);
    expect((await call('GET', `${S}/subusers`, co)).json().subusers).toHaveLength(3);
  });

  it('Rechte ändern: nicht die eigenen, und auch Weggenommenes muss man selbst haben', async () => {
    const co = auth['su-co']!;
    expect((await call('PATCH', `${S}/subusers/${ids['su-co']}`, co, { preset: 'zuschauer' })).statusCode).toBe(403); // eigene
    // Der Administrator gibt su-op ein Recht, das der Co-Admin nicht hat
    expect((await call('POST', `${S}/subusers`, admin, { user: 'su-op', permissions: ['control.console', lacking[0]!] })).statusCode).toBe(201);
    const take = await call('PATCH', `${S}/subusers/${ids['su-op']}`, co, { permissions: ['control.console'] });
    expect(take.statusCode, take.body).toBe(403);
    // Was der Co-Admin überblickt, darf er ändern
    const ok = await call('PATCH', `${S}/subusers/${ids['su-view']}`, co, { permissions: ['control.console', 'file.read', 'file.write'] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().permissions).toEqual(['control.console', 'file.read', 'file.write']);
    expect((await call('PATCH', `${S}/subusers/${ids['su-fremd']}`, co, { preset: 'operator' })).statusCode).toBe(404);
    expect((await call('PATCH', `${S}/subusers/${ids['su-view']}`, co, {})).statusCode).toBe(400);
    // seit wann bleibt beim Ändern gleich
    const before = (await call('GET', `${S}/subusers`, admin)).json().subusers.find((s: { username: string }) => s.username === 'su-view').since;
    await call('PATCH', `${S}/subusers/${ids['su-view']}`, admin, { permissions: ['control.console'] });
    const after = (await call('GET', `${S}/subusers`, admin)).json().subusers.find((s: { username: string }) => s.username === 'su-view').since;
    expect(after).toBe(before);
  });

  it('Rechte gelten sofort: nach dem Ändern, ohne neue Anmeldung', async () => {
    const view = auth['su-view']!;
    expect((await call('GET', `${S}/files`, view)).statusCode).toBe(403); // file.read wurde eben weggenommen
    await call('PATCH', `${S}/subusers/${ids['su-view']}`, admin, { permissions: ['control.console', 'file.read'] });
    expect((await call('GET', `${S}/files`, view)).statusCode).toBe(200);
  });

  it('entfernen: wer das Recht hat; jeder darf selbst austreten - danach ist der Server unsichtbar', async () => {
    const view = auth['su-view']!;
    expect((await call('DELETE', `${S}/subusers/${ids['su-extra']}`, view)).statusCode).toBe(403); // fremder Mitnutzer, kein Recht
    expect((await call('DELETE', `${S}/subusers/${ids['su-extra']}`, auth['su-co']!)).statusCode).toBe(200);
    expect((await call('DELETE', `${S}/subusers/${ids['su-extra']}`, auth['su-co']!)).statusCode).toBe(404);
    // Austreten braucht kein Recht
    expect((await call('DELETE', `${S}/subusers/${ids['su-view']}`, view)).statusCode).toBe(200);
    expect((await call('GET', `${S}`, view)).statusCode).toBe(404);
    const list = (await call('GET', '/api/v1/servers', view)).json().servers as Array<{ id: string }>;
    expect(list.find((s) => s.id === 'su-1')).toBeUndefined();
  });

  it('wird ein Benutzer gelöscht, verfallen seine Rechte', async () => {
    expect((await call('DELETE', `/api/v1/admin/users/${ids['su-op']}`, admin)).statusCode).toBeLessThan(300);
    const names = (await call('GET', `${S}/subusers`, admin)).json().subusers.map((s: { username: string }) => s.username);
    expect(names).toEqual(['su-co']);
  });

  it('alles steht im Audit-Protokoll', async () => {
    const audit = (await call('GET', '/api/v1/admin/audit?limit=200', admin)).body;
    for (const action of ['subuser.create', 'subuser.update', 'subuser.delete', 'subuser.leave']) expect(audit, action).toContain(action);
  });

  it('die Oberfläche erfährt, dass es Mitnutzer gibt', async () => {
    expect((await call('GET', '/api/v1/about', admin)).json().features).toContain('subusers');
    const perms = (await call('GET', '/api/v1/servers', auth['su-owner']!)).json().servers[0].permissions as string[];
    expect(perms).toEqual(expect.arrayContaining(['subuser.read', 'subuser.create', 'subuser.update', 'subuser.delete']));
  });
});
