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
const { classify } = await import('../src/http/authz.js');
const { LocalAccount } = await import('../src/store/account.js');
const { PRESETS } = await import('../src/auth/permissions.js');
const { hashPassword } = await import('../src/store/account.js');

const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij' };
const json = { 'content-type': 'application/json' };
const PW = 'ein-sicheres-passwort-1';

let dataDir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
let admin: Record<string, string>;
const ids: Record<string, string> = {};

type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Headers, payload?: unknown) =>
  server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function login(name: string, password = PW): Promise<Headers> {
  const res = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: name, password } });
  expect(res.statusCode, `Anmeldung ${name}: ${res.body}`).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

async function makeUser(name: string, extra: object = {}): Promise<{ id: string; h: Headers }> {
  const res = await call('POST', '/api/v1/admin/users', admin, { username: name, password: PW, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().user.id as string, h: await login(name) };
}

async function addServer(id: string, name: string): Promise<void> {
  const config = { id, name, game: 'minecraft-paper', executable: 'x', args: [], workingDir: path.join(dataDir, 'servers', id), ports: [{ name: 'game', hostPort: 25000 + Object.keys(ids).length, protocol: 'tcp' as const }] };
  await fs.mkdir(config.workingDir, { recursive: true });
  await registry.add(config);
  ids[name] = id;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-users-'));
  registry = await ServerRegistry.open(dataDir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
  admin = await login('admin', 'nur-fuer-tests-0815');
  await addServer('alpha-server-1', 'alpha');
  await addServer('beta-server-22', 'beta');
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Rechtetabelle', () => {
  const routes = () => (server as unknown as { routeTable: Array<{ method: string; url: string }> }).routeTable.filter((r) => r.method !== 'HEAD');
  const PUBLIC = new Set(['/core/v1/info', '/core/v1/pair', '/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/methods', '*', '/*']);

  it('hat für jede Route eine ausdrückliche Regel (neue Routen sind nie zufällig offen)', () => {
    const open = routes().filter((r) => !PUBLIC.has(r.url) && !classify(r.method, r.url).explicit).map((r) => `${r.method} ${r.url}`);
    expect(open).toEqual([]);
    expect(routes().length).toBeGreaterThan(100);
  });

  it('gibt einem normalen Benutzer auf JEDER Admin-Route 403', async () => {
    const user = await makeUser('normaler');
    const checked: string[] = [];
    for (const r of routes()) {
      const need = classify(r.method, r.url).need;
      if (need.kind !== 'admin' && need.kind !== 'perm') continue;
      if (PUBLIC.has(r.url) || r.url === '/core/v1/stream' || r.url.endsWith('/ws')) continue; // oeffentlich bzw. WebSocket (eigener Test)
      const url = r.url.replace(/:\w+/g, 'x');
      const res = await call(r.method as 'GET', url, user.h, r.method === 'GET' ? undefined : {});
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      checked.push(`${r.method} ${r.url}`);
    }
    expect(checked.length).toBeGreaterThan(40);
  });

  it('ein Modul-Recht öffnet genau dieses Modul - nicht die Benutzerverwaltung', async () => {
    const auditor = await makeUser('pruefer', { globalPermissions: ['admin.audit'] });
    expect((await call('GET', '/api/v1/admin/audit', auditor.h)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/admin/integrations', auditor.h)).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/admin/users', auditor.h)).statusCode).toBe(403);
    const me = (await call('GET', '/api/v1/auth/me', auditor.h)).json();
    expect(me.permissions['admin.audit']).toBe(true);
    expect(me.permissions['admin.users']).toBe(false);
  });

  it('das Master-Token bleibt Verwalter, ist aber kein Benutzer', async () => {
    expect((await call('GET', '/api/v1/admin/users', MASTER)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/auth/me', MASTER)).json().user.username).toBe('NexusCore');
    expect((await call('PATCH', '/api/v1/auth/me', MASTER, { locale: 'en' })).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/auth/password', MASTER, { currentPassword: 'x', newPassword: 'y'.repeat(12) })).statusCode).toBe(403);
  });
});

describe('Server und Sichtbarkeit', () => {
  it('ein Benutzer ohne Zuweisung sieht keinen Server - weder in der Liste noch per ID noch per Kurz-ID', async () => {
    const u = await makeUser('ohnezugriff');
    expect((await call('GET', '/api/v1/servers', u.h)).json().servers).toEqual([]);
    for (const id of [ids['alpha']!, ids['alpha']!.slice(0, 8)]) {
      for (const [method, suffix] of [
        ['GET', ''], ['GET', '/files'], ['GET', '/files/content?path=a.txt'], ['GET', '/backups'], ['GET', '/schedules'],
        ['GET', '/startup'], ['GET', '/logs'], ['POST', '/command'], ['POST', '/power'], ['DELETE', ''], ['PATCH', ''],
      ] as const) {
        const res = await call(method, `/api/v1/servers/${id}${suffix}`, u.h, method === 'GET' ? undefined : { action: 'start', command: 'stop' });
        expect(res.statusCode, `${method} ${suffix} (${id})`).toBe(404);
      }
    }
    const dash = (await call('GET', '/api/v1/dashboard', u.h)).json();
    expect(dash.totals.servers).toBe(0);
    expect(dash.host).toBeNull();
    expect((await call('GET', '/api/v1/dashboard/activity', u.h)).json().items).toEqual([]);
  });

  it('Mitnutzer: nur die zugewiesenen Rechte gelten - 403 für den Rest, 404 für andere Server', async () => {
    const u = await makeUser('operator1');
    // Operator-Voreinstellung auf "alpha"
    const set = await call('PUT', `/api/v1/admin/users/${u.id}/servers/${ids['alpha']}`, admin, { permissions: [...PRESETS.operator.flags] });
    expect(set.statusCode, set.body).toBe(200);

    const list = (await call('GET', '/api/v1/servers', u.h)).json().servers as Array<{ name: string; permissions: string[]; isOwner: boolean }>;
    expect(list.map((s) => s.name)).toEqual(['alpha']);
    expect(list[0]!.isOwner).toBe(false);
    expect(list[0]!.permissions).toContain('control.start');
    expect(list[0]!.permissions).not.toContain('file.write');

    const a = ids['alpha']!;
    expect((await call('GET', `/api/v1/servers/${a}`, u.h)).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/servers/${a.slice(0, 8)}`, u.h)).statusCode).toBe(200);
    // Ein Operator darf starten und stoppen, aber nicht abwürgen
    expect((await call('POST', `/api/v1/servers/${a}/power`, u.h, { action: 'kill' })).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/servers/${a}/power`, u.h, { action: 'unbekannt' })).statusCode).toBe(403);
    expect([200, 409]).toContain((await call('POST', `/api/v1/servers/${a}/power`, u.h, { action: 'start' })).statusCode);
    // Keine Dateien schreiben, löschen, packen; lesen auch nicht (nicht im Preset)
    expect((await call('PUT', `/api/v1/servers/${a}/files/content`, u.h, { path: 'x.txt', content: 'x' })).statusCode).toBe(403);
    expect((await call('DELETE', `/api/v1/servers/${a}/files`, u.h, { path: 'x.txt' })).statusCode).toBe(403);
    expect((await call('GET', `/api/v1/servers/${a}/files`, u.h)).statusCode).toBe(403);
    // Kein Löschen, Umbenennen, Neuinstallieren, Rechenleistung
    expect((await call('DELETE', `/api/v1/servers/${a}`, u.h)).statusCode).toBe(403);
    expect((await call('PATCH', `/api/v1/servers/${a}`, u.h, { name: 'neu' })).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/servers/${a}/reinstall`, u.h, {})).statusCode).toBe(403);
    expect((await call('PATCH', `/api/v1/servers/${a}/resources`, u.h, { ramMb: 99999 })).statusCode).toBe(403);
    // Spieler: kicken ja (Operator), "op" nie
    expect((await call('POST', `/api/v1/servers/${a}/players/action`, u.h, { action: 'op', name: 'Steve' })).statusCode).toBe(403);
    // Der andere Server bleibt unsichtbar
    expect((await call('GET', `/api/v1/servers/${ids['beta']}`, u.h)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/servers/${ids['beta']}/power`, u.h, { action: 'start' })).statusCode).toBe(404);
  });

  it('Zuschauer darf mitlesen, aber keine Befehle senden', async () => {
    const u = await makeUser('zuschauer1');
    await call('PUT', `/api/v1/admin/users/${u.id}/servers/${ids['alpha']}`, admin, { permissions: [...PRESETS.zuschauer.flags] });
    const a = ids['alpha']!;
    expect((await call('GET', `/api/v1/servers/${a}/backups`, u.h)).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/servers/${a}/command`, u.h, { command: 'stop' })).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/servers/${a}/power`, u.h, { action: 'start' })).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/servers/${a}/backups`, u.h, {})).statusCode).toBe(403);
  });

  it('Besitzer hat alle Rechte am eigenen Server und darf ihn löschen', async () => {
    const u = await makeUser('besitzer1', { canCreateServers: true });
    await addServer('gamma-server-3', 'gamma');
    expect((await call('PUT', `/api/v1/admin/users/${u.id}/servers/${ids['gamma']}`, admin, { isOwner: true })).statusCode).toBe(200);
    const g = ids['gamma']!;
    expect((await call('GET', `/api/v1/servers/${g}/files`, u.h)).statusCode).toBe(200);
    expect((await call('PUT', `/api/v1/servers/${g}/files/content`, u.h, { path: 'a.txt', content: 'hallo' })).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/servers/${g}`, u.h)).json().server.ownerId).toBe(u.id);
    expect((await call('GET', '/api/v1/servers', u.h)).json().servers[0].isOwner).toBe(true);
    // Eigene Rechenleistung bleibt Sache der Verwalter
    expect((await call('PATCH', `/api/v1/servers/${g}/resources`, u.h, { ramMb: 8192 })).statusCode).toBe(403);
    expect((await call('DELETE', `/api/v1/servers/${g}`, u.h)).statusCode).toBeLessThan(300);
    // Danach gibt es keine Rechte mehr an der ID
    expect((await call('GET', '/api/v1/admin/users', admin)).json().users.find((x: { id: string }) => x.id === u.id).servers).toBe(0);
  });

  it('Server anlegen: nur mit Recht, Besitzer ist der Ersteller, Grenzen gelten', async () => {
    const nope = await makeUser('darfnicht');
    expect((await call('POST', '/api/v1/servers', nope.h, { name: 'x', eggId: 'minecraft-paper' })).statusCode).toBe(403);

    const maker = await makeUser('ersteller', { canCreateServers: true });
    expect((await call('PATCH', `/api/v1/admin/users/${maker.id}`, admin, { serverLimit: 1 })).statusCode).toBe(200);
    const first = await call('POST', '/api/v1/servers', maker.h, { name: 'Mein Server', eggId: 'custom-egg' });
    expect(first.statusCode, first.body).toBe(201);
    const mine = (await call('GET', '/api/v1/servers', maker.h)).json().servers as Array<{ name: string; isOwner: boolean }>;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'Mein Server', isOwner: true });
    // Zweiter Server: Limit erreicht
    const second = await call('POST', '/api/v1/servers', maker.h, { name: 'Noch einer', eggId: 'custom-egg' });
    expect(second.statusCode).toBe(403);
    expect(second.json().code).toBe('limit_reached');
    // Andere sehen ihn nicht
    const other = await makeUser('fremder');
    expect((await call('GET', '/api/v1/servers', other.h)).json().servers).toEqual([]);
  });
});

describe('Benutzerverwaltung', () => {
  it('legt Benutzer an, erzeugt Passwörter einmalig und lehnt Doppelte ab', async () => {
    const gen = await call('POST', '/api/v1/admin/users', admin, { username: 'erzeugt', role: 'user' });
    expect(gen.statusCode).toBe(201);
    const pw = gen.json().password as string;
    expect(pw.length).toBeGreaterThanOrEqual(20);
    await login('erzeugt', pw);
    // Das Passwort steht nirgends sonst: weder in der Liste noch im Audit-Log noch in users.json
    expect(JSON.stringify((await call('GET', '/api/v1/admin/users', admin)).json())).not.toContain(pw);
    expect(JSON.stringify((await call('GET', '/api/v1/admin/audit', admin)).json())).not.toContain(pw);
    expect(await fs.readFile(path.join(dataDir, 'users.json'), 'utf8')).not.toContain(pw);

    expect((await call('POST', '/api/v1/admin/users', admin, { username: 'ERZEUGT', password: PW })).statusCode).toBe(409);
    expect((await call('POST', '/api/v1/admin/users', admin, { username: 'ab', password: PW })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/admin/users', admin, { username: 'kurzespw', password: 'kurz' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/admin/users', admin, { username: 'doppelmail', email: 'a@example.org', password: PW })).statusCode).toBe(201);
    expect((await call('POST', '/api/v1/admin/users', admin, { username: 'doppelmail2', email: 'A@example.org', password: PW })).statusCode).toBe(409);
  });

  it('Anmeldung mit E-Mail geht; unbekannter Name und falsches Passwort sind nicht unterscheidbar', async () => {
    await login('a@example.org');
    const wrong = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'doppelmail', password: 'falsch-falsch-1' } });
    const unknown = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'gibtsnicht', password: 'falsch-falsch-1' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('Sperren beendet sofort alle Sitzungen des Benutzers - und nur seine', async () => {
    const victim = await makeUser('wirdgesperrt');
    const bystander = await makeUser('unbeteiligt');
    expect((await call('GET', '/api/v1/auth/me', victim.h)).statusCode).toBe(200);
    expect((await call('PATCH', `/api/v1/admin/users/${victim.id}`, admin, { suspended: true })).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/auth/me', victim.h)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/servers', victim.h)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/auth/me', bystander.h)).statusCode).toBe(200);
    // Gesperrt kann sich nicht neu anmelden, entsperrt schon
    expect((await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'wirdgesperrt', password: PW } })).statusCode).toBe(401);
    await call('PATCH', `/api/v1/admin/users/${victim.id}`, admin, { suspended: false });
    await login('wirdgesperrt');
  });

  it('Passwortwechsel beendet nur die Sitzungen dieses Benutzers', async () => {
    const a = await makeUser('wechsler');
    const b = await makeUser('bleibt');
    const second = await login('wechsler');
    const res = await call('POST', '/api/v1/auth/password', a.h, { currentPassword: PW, newPassword: 'ganz-neues-passwort-9' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await call('GET', '/api/v1/auth/me', a.h)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/auth/me', second)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/auth/me', b.h)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/auth/me', admin)).statusCode).toBe(200);
    await login('wechsler', 'ganz-neues-passwort-9');
  });

  it('Sitzungen sind je Benutzer getrennt', async () => {
    const a = await makeUser('sitzung-a');
    const b = await makeUser('sitzung-b');
    const mine = (await call('GET', '/api/v1/auth/sessions', a.h)).json().sessions as Array<{ id: string; current: boolean }>;
    expect(mine).toHaveLength(1);
    const theirs = (await call('GET', '/api/v1/auth/sessions', b.h)).json().sessions as Array<{ id: string }>;
    // Eine fremde Sitzung zu beenden gelingt nicht
    expect((await call('DELETE', `/api/v1/auth/sessions/${theirs[0]!.id}`, a.h)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/auth/me', b.h)).statusCode).toBe(200);
    // "Überall abmelden" trifft nur die eigenen anderen
    await call('POST', '/api/v1/auth/logout-all', a.h);
    expect((await call('GET', '/api/v1/auth/me', b.h)).statusCode).toBe(200);
  });

  it('der letzte Administrator bleibt - Herabstufen, Sperren und Löschen werden abgelehnt', async () => {
    const list = (await call('GET', '/api/v1/admin/users', admin)).json().users as Array<{ id: string; username: string; role: string }>;
    const root = list.find((u) => u.username === 'admin')!;
    const demote = await call('PATCH', `/api/v1/admin/users/${root.id}`, admin, { role: 'user' });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().code).toBe('last_admin');
    expect((await call('PATCH', `/api/v1/admin/users/${root.id}`, admin, { suspended: true })).statusCode).toBe(409);
    // Das eigene Konto löscht man hier nicht
    expect((await call('DELETE', `/api/v1/admin/users/${root.id}`, admin)).statusCode).toBe(409);
    // Mit einem zweiten Administrator darf der erste herabgestuft werden - dann aber nicht der zweite
    const second = await makeUser('admin2', { role: 'admin' });
    expect((await call('PATCH', `/api/v1/admin/users/${root.id}`, second.h, { role: 'moderator' })).statusCode).toBe(200);
    expect((await call('PATCH', `/api/v1/admin/users/${second.id}`, second.h, { role: 'user' })).statusCode).toBe(409);
    await call('PATCH', `/api/v1/admin/users/${root.id}`, second.h, { role: 'admin' });
  });

  it('ein Benutzer mit Servern lässt sich nicht löschen; danach werden Rechte entzogen', async () => {
    const u = await makeUser('loeschkandidat');
    await addServer('delta-server-4', 'delta');
    await call('PUT', `/api/v1/admin/users/${u.id}/servers/${ids['delta']}`, admin, { isOwner: true });
    const blocked = await call('DELETE', `/api/v1/admin/users/${u.id}`, admin);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('in_use');
    await call('PUT', `/api/v1/admin/users/${(await makeUser('erbe')).id}/servers/${ids['delta']}`, admin, { isOwner: true });
    expect((await call('DELETE', `/api/v1/admin/users/${u.id}`, admin)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/auth/me', u.h)).statusCode).toBe(401);
  });

  it('Passwort zurücksetzen und 2FA abschalten beenden die Sitzungen des Betroffenen', async () => {
    const u = await makeUser('zuruecksetzen');
    const reset = await call('POST', `/api/v1/admin/users/${u.id}/reset-password`, admin, {});
    expect(reset.statusCode).toBe(200);
    expect(reset.json().generated).toBe(true);
    expect((await call('GET', '/api/v1/auth/me', u.h)).statusCode).toBe(401);
    await login('zuruecksetzen', reset.json().password);
  });

  it('das Protokoll nennt, wer es war', async () => {
    const u = await makeUser('protokolliert', { canCreateServers: true });
    await call('POST', '/api/v1/servers', u.h, { name: 'Von Mir', eggId: 'custom-egg' });
    const entries = (await call('GET', '/api/v1/admin/audit?limit=200', admin)).json().entries as Array<{ action: string; actor_name: string; user_id: string | null }>;
    const create = entries.find((e) => e.action === 'server.create' && e.actor_name === 'protokolliert');
    expect(create, 'Eintrag vom Benutzer').toBeTruthy();
    expect(create!.user_id).toBe(u.id);
    expect(entries.find((e) => e.action === 'user.create' && e.actor_name === 'admin')).toBeTruthy();
  });

  it('Sicherheitsprotokoll: Anmeldung steht unter dem Namen des Benutzers', async () => {
    const entries = (await call('GET', '/api/v1/admin/audit?limit=500&action=auth.login', admin)).json().entries as Array<{ action: string; actor_name: string }>;
    expect(entries.some((e) => e.action === 'auth.login' && e.actor_name === 'normaler')).toBe(true);
  });
});

describe('Übernahme des bisherigen Kontos', () => {
  it('ein vorhandenes account.json (mit Passwort und 2FA) wird zum Administrator', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-mig-'));
    const saved = process.env['NEXUSCORE_ADMIN_PASSWORD'];
    try {
      const hash = await hashPassword('altes-passwort-123');
      await fs.writeFile(
        path.join(dir, 'account.json'),
        JSON.stringify({ version: 1, username: 'chefin', passwordHash: hash, email: 'chefin@example.org', totp: { secret: 'JBSWY3DPEHPK3PXP', lastStep: 5 }, recovery: ['abc'] }),
      );
      // Ohne Umgebungspasswort, wie im echten Betrieb
      const { config } = await import('../src/config/index.js');
      (config as { adminPassword: string }).adminPassword = '';
      const account = await LocalAccount.open(dir);
      const user = await account.verify('chefin', 'altes-passwort-123', 'x');
      expect(user).toMatchObject({ username: 'chefin', role: 'admin', email: 'chefin@example.org', totpEnabled: true });
      expect(account.count()).toBe(1);
      // Die alte Datei bleibt als Sicherung, wird aber nicht mehr gelesen
      await expect(fs.stat(path.join(dir, 'account.json.migriert'))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(dir, 'account.json'))).rejects.toThrow();
      // Zweiter Start liest users.json
      const again = await LocalAccount.open(dir);
      expect(again.count()).toBe(1);
      expect(await again.verify('chefin', 'altes-passwort-123', 'y')).not.toBeNull();
    } finally {
      (await import('../src/config/index.js')).config.adminPassword = saved ?? '';
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('WebSocket', () => {
  it('Konsole: Zuschauer sieht, aber seine Befehle werden abgelehnt; Fremde kommen nicht hinein', async () => {
    const viewer = await makeUser('ws-zuschauer');
    const stranger = await makeUser('ws-fremder');
    await call('PUT', `/api/v1/admin/users/${viewer.id}/servers/${ids['alpha']}`, admin, { permissions: [...PRESETS.zuschauer.flags] });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = address.replace(/^http/, 'ws');
    const tokenOf = (h: Headers) => h['authorization']!.replace('Bearer ', '');
    const open = (id: string, token: string) =>
      new Promise<{ messages: Array<Record<string, unknown>>; ws: WebSocket; closed: Promise<number> }>((resolve) => {
        const ws = new WebSocket(`${wsUrl}/api/v1/servers/${id}/ws?token=${token}`);
        const messages: Array<Record<string, unknown>> = [];
        const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
        ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
        ws.onopen = () => resolve({ messages, ws, closed });
        ws.onerror = () => resolve({ messages, ws, closed });
      });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const v = await open(ids['alpha']!, tokenOf(viewer.h));
    for (let i = 0; i < 40 && v.messages.length === 0; i++) await wait(50);
    expect(v.messages[0]).toMatchObject({ type: 'hello', canCommand: false });
    v.ws.send(JSON.stringify({ type: 'command', data: 'stop' }));
    for (let i = 0; i < 40 && !v.messages.some((m) => m['type'] === 'error'); i++) await wait(50);
    expect(v.messages.find((m) => m['type'] === 'error')).toMatchObject({ code: 'forbidden' });
    v.ws.close();

    // Ein Fremder kommt gar nicht erst zur Konsole
    const s = await open(ids['alpha']!, tokenOf(stranger.h));
    const code = await Promise.race([s.closed, wait(2000).then(() => -1)]);
    expect(s.messages.some((m) => m['type'] === 'hello')).toBe(false);
    expect(code).not.toBe(-1);
  }, 20_000);
});
