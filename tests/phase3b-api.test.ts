import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { codeAt, currentStep, base32Decode, base32Encode, verifyTotp } from '../src/auth/totp.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { importEggFromFile } from '../src/eggs/import.js';
import { ensureLocalNode } from '../src/servers/nodes.js';
import { documentedRoutes } from '../src/http/openapi.js';
import type { PowerHandlers, ServerOps } from '../src/http/routes/servers.js';

let app: FastifyInstance;
const PW = 'ein-langes-passwort';
const ids: Record<string, string> = {};
let eggId = '';
const provisioned: string[] = [];
const removed: string[] = [];

const power: PowerHandlers = { start: async () => {}, stop: async () => {}, restart: async () => {}, kill: async () => {} };
const ops: ServerOps = {
  provision: async (id) => { provisioned.push(id); },
  remove: async (id) => { removed.push(id); await sql`DELETE FROM servers WHERE id = ${id}`; },
  rebuild: async () => {},
  updateResources: async () => {},
};

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await app?.close();
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations, subusers, events,
                     audit_log, sessions, recovery_codes RESTART IDENTITY CASCADE`;
  provisioned.length = 0;
  removed.length = 0;
  app = await buildServer({ rateLimitStore: new MemoryStore(), power, ops, logger: false });
  for (const [name, role, create] of [['admin', 'admin', true], ['owner', 'user', true], ['helfer', 'user', false], ['gast', 'user', false]] as const) {
    ids[name] = (await createUser({ username: name, email: `${name}@test.local`, password: PW, role, canCreateServers: create })).id;
  }
  await ensureLocalNode();
  eggId = (await importEggFromFile('eggs/minecraft-paper.json')).eggId;
});

afterAll(async () => {
  await app?.close();
  await closeDatabase();
});

async function login(username: string, extra: Record<string, string> = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: username, password: PW, client: 'app', ...extra } });
  return res;
}
async function token(username: string) {
  const r = await login(username);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().accessToken as string;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function createMc(t: string, extra: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/v1/servers', headers: auth(t),
    payload: { name: 'Survival', eggId, ramMb: 4096, diskMb: 20000, variables: { EULA: 'TRUE' }, ...extra } });
}

describe('TOTP-Grundlagen', () => {
  it('RFC-6238-Testvektor (SHA-1, 59 s -> 287082)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(codeAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('erlaubt einen Schritt Abweichung, aber keinen Code doppelt', () => {
    const s = base32Encode(Buffer.from('abcdefghijabcdefghij'));
    const now = Date.now();
    const step = currentStep(now);
    expect(verifyTotp(s, codeAt(s, step - 1), 0, now)).toBe(step - 1);
    expect(verifyTotp(s, codeAt(s, step - 2), 0, now)).toBeNull();
    expect(verifyTotp(s, codeAt(s, step), step, now)).toBeNull();
  });

  it('Verschluesselung: rund und manipulationssicher', () => {
    const c = encrypt('geheim');
    expect(c).not.toContain('geheim');
    expect(decrypt(c)).toBe('geheim');
    const parts = c.split(':');
    parts[3] = Buffer.from('xxxxxx').toString('base64url');
    expect(() => decrypt(parts.join(':'))).toThrow();
  });
});

describe('Zwei-Faktor-Anmeldung', () => {
  async function enable(t: string) {
    const setup = (await app.inject({ method: 'POST', url: '/api/v1/auth/totp/setup', headers: auth(t) })).json();
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/NexusPanel/);
    const step = currentStep();
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/enable', headers: auth(t), payload: { code: codeAt(setup.secret, step) } });
    expect(r.statusCode, r.body).toBe(200);
    return { secret: setup.secret as string, step, codes: r.json().recoveryCodes as string[] };
  }

  it('Einrichtung, Login mit Code, kein Code doppelt, Wiederherstellungscode einmal', async () => {
    const t = await token('owner');
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/setup', headers: auth(t) });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/enable', headers: auth(t), payload: { code: '000000' } });
    expect(wrong.statusCode).toBe(200);
    expect(bad.statusCode).toBe(400);

    const { secret, step, codes } = await enable(t);
    expect(codes).toHaveLength(10);
    const [secretRow] = await sql`SELECT totp_secret FROM users WHERE id = ${ids.owner!}`;
    expect(secretRow!.totp_secret).not.toContain(secret); // verschluesselt gespeichert

    const noCode = await login('owner');
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().code).toBe('totp_required');

    const replay = await login('owner', { totp: codeAt(secret, step) });
    expect(replay.json().code).toBe('totp_invalid');

    const ok = await login('owner', { totp: codeAt(secret, step + 1) });
    expect(ok.statusCode, ok.body).toBe(200);

    const rec = await login('owner', { recoveryCode: codes[0]!.toUpperCase() });
    expect(rec.statusCode).toBe(200);
    expect(rec.json().recoveryCodesLeft).toBe(9);
    expect((await login('owner', { recoveryCode: codes[0]! })).statusCode).toBe(401);
  });

  it('Abschalten braucht Passwort und zweiten Faktor', async () => {
    const t = await token('owner');
    const { codes } = await enable(t);
    const noPw = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/disable', headers: auth(t), payload: { password: 'falsch', recoveryCode: codes[1] } });
    expect(noPw.statusCode).toBe(400);
    const noCode = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/disable', headers: auth(t), payload: { password: PW } });
    expect(noCode.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/disable', headers: auth(t), payload: { password: PW, recoveryCode: codes[1] } });
    expect(ok.statusCode).toBe(200);
    expect((await login('owner')).statusCode).toBe(200);
  });

  it('Admin kann 2FA zuruecksetzen, Sitzungen enden', async () => {
    const t = await token('owner');
    await enable(t);
    const a = await token('admin');
    const r = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${ids.owner}/reset-2fa`, headers: auth(a) });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(t) })).statusCode).toBe(401);
    expect((await login('owner')).statusCode).toBe(200);
  });
});

describe('Spielekatalog', () => {
  it('liefert Formularbeschreibung mit Dropdowns', async () => {
    const t = await token('gast');
    const list = (await app.inject({ method: 'GET', url: '/api/v1/eggs', headers: auth(t) })).json();
    expect(list.eggs[0].name).toBe('Minecraft Java');
    expect(list.eggs[0].images[0].default).toBe(true);
    expect(list.eggs[0].images[0].image).toContain('java25');

    const d = (await app.inject({ method: 'GET', url: `/api/v1/eggs/${eggId}`, headers: auth(t) })).json();
    const diff = d.egg.variables.find((v: { env: string }) => v.env === 'DIFFICULTY');
    expect(diff.widget).toBe('select');
    expect(diff.options).toContain('hard');
    const rcon = d.egg.variables.find((v: { env: string }) => v.env === 'RCON_PASSWORD');
    if (rcon?.secret) expect(rcon.default).toBeNull();
  });

  it('Egg-Import nur fuer Admins', async () => {
    const egg = { name: 'Test-Egg', startup: './run', docker_images: { Standard: 'alpine:3.20' } };
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/eggs', headers: auth(await token('owner')), payload: egg })).statusCode).toBe(403);
    const a = await token('admin');
    const r = await app.inject({ method: 'POST', url: '/api/v1/admin/eggs', headers: auth(a), payload: egg });
    expect(r.statusCode, r.body).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/eggs', headers: auth(a), payload: egg })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/eggs/${r.json().eggId}`, headers: auth(a) })).statusCode).toBe(200);
  });
});

describe('Server anlegen, aendern, loeschen', () => {
  it('ohne server.create: 403', async () => {
    const r = await createMc(await token('gast'));
    expect(r.statusCode).toBe(403);
  });

  it('mit Recht: 201, Status installing, Port vergeben, Bereitstellung angestossen, Ersteller ist Besitzer', async () => {
    const t = await token('owner');
    const r = await createMc(t);
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().server.id;
    expect(r.json().server.status).toBe('installing');
    expect(provisioned).toEqual([id]);
    const d = (await app.inject({ method: 'GET', url: `/api/v1/servers/${id}`, headers: auth(t) })).json();
    expect(d.server.ownerId).toBe(ids.owner);
    expect(d.server.ports[0].port).toBe(25565);
    const [ev] = await sql`SELECT kind FROM events WHERE server_id = ${id} AND kind = 'server_created'`;
    expect(ev).toBeTruthy();
    // Zweiter Minecraft-Server bekommt den naechsten Port
    const r2 = await createMc(t, { name: 'Creative' });
    const d2 = (await app.inject({ method: 'GET', url: `/api/v1/servers/${r2.json().server.id}`, headers: auth(t) })).json();
    expect(d2.server.ports[0].port).toBe(25566);
  });

  it('ungueltige Variablen: 400 mit Feldliste, nichts angelegt', async () => {
    const r = await createMc(await token('owner'), { variables: { DIFFICULTY: 'unmoeglich' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('invalid_variables');
    expect(r.json().issues[0].variable).toBe('DIFFICULTY');
    const [n] = await sql`SELECT count(*)::int AS n FROM servers`;
    expect(n!.n).toBe(0);
    const [p] = await sql`SELECT count(*)::int AS n FROM allocations WHERE server_id IS NOT NULL`;
    expect(p!.n).toBe(0);
  });

  it('Budget: RAM-Grenze greift', async () => {
    await sql`UPDATE users SET ram_limit_mb = 6000 WHERE id = ${ids.owner!}`;
    const t = await token('owner');
    expect((await createMc(t)).statusCode).toBe(201);
    const r = await createMc(t, { name: 'Zweiter' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('limit_ram');
  });

  it('Admin legt fuer andere an, Nutzer nicht', async () => {
    const o = await createMc(await token('owner'), { ownerId: ids.gast });
    expect(o.statusCode).toBe(403);
    const a = await createMc(await token('admin'), { ownerId: ids.gast });
    expect(a.statusCode).toBe(201);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/servers', headers: auth(await token('gast')) })).json();
    expect(list.servers).toHaveLength(1);
  });

  it('Umbenennen braucht settings.rename; Loeschen nur Besitzer/Admin und nicht im Betrieb', async () => {
    const t = await token('owner');
    const id = (await createMc(t)).json().server.id;
    await sql`INSERT INTO subusers (server_id, user_id, permissions) VALUES (${id}, ${ids.helfer!}, '{control.console}')`;
    const h = await token('helfer');
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/servers/${id}`, headers: auth(h), payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/servers/${id}`, headers: auth(t), payload: { name: 'Neu' } })).statusCode).toBe(200);
    const [s] = await sql`SELECT name FROM servers WHERE id = ${id}`;
    expect(s!.name).toBe('Neu');

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/servers/${id}`, headers: auth(h) })).statusCode).toBe(403);
    await sql`UPDATE servers SET status = 'running' WHERE id = ${id}`;
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/servers/${id}`, headers: auth(t) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/servers/${id}?force=true`, headers: auth(t) })).statusCode).toBe(200);
    expect(removed).toEqual([id]);
    const [a] = await sql`SELECT server_id, metadata FROM audit_log WHERE action = 'server.delete'`;
    expect(a!.server_id).toBeNull(); // Server weg, Eintrag bleibt
    expect(a!.metadata.name).toBe('Neu');
  });
});

describe('Mitnutzer', () => {
  let id = '';
  beforeEach(async () => {
    id = (await createMc(await token('owner'))).json().server.id;
  });

  it('Besitzer laedt per Preset ein, Doppelte und Besitzer abgelehnt', async () => {
    const t = await token('owner');
    const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/subusers`, headers: auth(t), payload: { user: 'helfer@test.local', preset: 'operator' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().permissions).toContain('control.start');
    expect((await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/subusers`, headers: auth(t), payload: { user: 'helfer', preset: 'zuschauer' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/subusers`, headers: auth(t), payload: { user: 'owner', preset: 'zuschauer' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/subusers`, headers: auth(t), payload: { user: 'niemand', preset: 'zuschauer' } })).statusCode).toBe(404);
    const list = (await app.inject({ method: 'GET', url: `/api/v1/servers/${id}/subusers`, headers: auth(t) })).json();
    expect(list.subusers[0].username).toBe('helfer');
  });

  it('Co-Admin kann einladen, aber nichts vergeben, was er nicht hat', async () => {
    const t = await token('owner');
    await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/subusers`, headers: auth(t), payload: { user: 'helfer', preset: 'co-admin' } });
    const h = await token('helfer');
    const tooMuch = await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/subusers`, headers: auth(h), payload: { user: 'gast', permissions: ['control.console', 'control.kill'] } });
    expect(tooMuch.statusCode).toBe(403);
    expect(tooMuch.json().error).toContain('control.kill');
    const ok = await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/subusers`, headers: auth(h), payload: { user: 'gast', preset: 'operator' } });
    expect(ok.statusCode).toBe(201);
    // eigene Rechte aendern: nein
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/servers/${id}/subusers/${ids.helfer}`, headers: auth(h), payload: { preset: 'verwalter' } })).statusCode).toBe(403);
    // unbekanntes Flag
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/servers/${id}/subusers/${ids.gast}`, headers: auth(h), payload: { permissions: ['quatsch'] } })).statusCode).toBe(400);
  });

  it('Mitnutzer kann selbst austreten, Zuschauer kann andere nicht entfernen', async () => {
    const t = await token('owner');
    await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/subusers`, headers: auth(t), payload: { user: 'helfer', preset: 'zuschauer' } });
    await app.inject({ method: 'POST', url: `/api/v1/servers/${id}/subusers`, headers: auth(t), payload: { user: 'gast', preset: 'zuschauer' } });
    const h = await token('helfer');
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/servers/${id}/subusers/${ids.gast}`, headers: auth(h) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/servers/${id}/subusers/${ids.helfer}`, headers: auth(h) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${id}`, headers: auth(h) })).statusCode).toBe(404);
  });
});

describe('Nutzerverwaltung', () => {
  it('Admin legt Nutzer an, Passwort wird erzeugt und einmal gezeigt', async () => {
    const a = await token('admin');
    const r = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: auth(a), payload: { username: 'neu', email: 'neu@test.local' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().password).toHaveLength(24);
    const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'neu', password: r.json().password } });
    expect(l.statusCode).toBe(200);
  });

  it('letzter Admin kann sich nicht aussperren', async () => {
    const a = await token('admin');
    const r = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${ids.admin}`, headers: auth(a), payload: { role: 'user' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('last_admin');
  });

  it('Sperren beendet Sitzungen; Nutzer mit Servern nicht loeschbar', async () => {
    const o = await token('owner');
    await createMc(o);
    const a = await token('admin');
    await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${ids.owner}`, headers: auth(a), payload: { suspended: true } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(o) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${ids.owner}`, headers: auth(a) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${ids.gast}`, headers: auth(a) })).statusCode).toBe(200);
    const users = (await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: auth(a) })).json().users;
    expect(users.find((u: { username: string }) => u.username === 'owner').ramUsedMb).toBe(4096);
  });

  it('Nicht-Admins kommen nicht an die Nutzerverwaltung', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: auth(await token('owner')) })).statusCode).toBe(403);
  });
});

describe('API-Dokumentation', () => {
  it('jede Route ist dokumentiert', async () => {
    await app.ready();
    const spec = app.swagger() as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set(documentedRoutes());
    const missing: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const m of Object.keys(methods)) {
        const key = `${m.toUpperCase()} ${path}`;
        if (m !== 'head' && !documented.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('/api/docs ist erreichbar und enthaelt Eingabeschemas', async () => {
    const ui = await app.inject({ method: 'GET', url: '/api/docs' });
    expect([200, 302]).toContain(ui.statusCode);
    const spec = (await app.inject({ method: 'GET', url: '/api/docs/json' })).json();
    const create = spec.paths['/api/v1/servers'].post;
    expect(create.tags).toEqual(['Server']);
    expect(create.requestBody.content['application/json'].schema.required).toContain('eggId');
    expect(create.security).toEqual([{ bearer: [] }]);
    expect(spec.paths['/api/v1/auth/login'].post.security).toBeUndefined();
  });
});
