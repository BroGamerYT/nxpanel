import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { PRESETS } from '../src/auth/permissions.js';
import type { PowerHandlers } from '../src/http/routes/servers.js';

let app: FastifyInstance;
const calls: string[] = [];
const power: PowerHandlers = {
  start: async (id) => { calls.push(`start:${id}`); },
  stop: async (id) => { calls.push(`stop:${id}`); },
  restart: async (id) => { calls.push(`restart:${id}`); },
  kill: async () => { throw new Error('Docker sagt nein'); },
};

const PW = 'ein-langes-passwort';
let serverId = '';
let ids: Record<string, string> = {};

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations,
                     subusers, events, audit_log, sessions RESTART IDENTITY CASCADE`;
  calls.length = 0;
  // Frische App je Test = frischer Ratelimit-Speicher
  app = await buildServer({ rateLimitStore: new MemoryStore(), power, logger: false });

  ids = {};
  for (const [name, role] of [['admin', 'admin'], ['owner', 'user'], ['viewer', 'user'], ['oper', 'user'], ['fremd', 'user'], ['mod', 'moderator']] as const) {
    const u = await createUser({ username: name, email: `${name}@test.local`, password: PW, role });
    ids[name] = u.id;
  }
  const [node] = await sql<{ id: string }[]>`
    INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb) VALUES ('n', 'localhost', 8192, 100000) RETURNING id`;
  const [nest] = await sql<{ id: string }[]>`INSERT INTO nests (name) VALUES ('T') RETURNING id`;
  const [egg] = await sql<{ id: string }[]>`
    INSERT INTO eggs (nest_id, name, docker_images, startup, raw_egg)
    VALUES (${nest!.id}, 'Minecraft', ${sql.json({ d: 'alpine' })}, 'run', ${sql.json({})}) RETURNING id`;
  const [server] = await sql<{ id: string }[]>`
    INSERT INTO servers (short_id, owner_id, node_id, egg_id, name, docker_image, startup, status, ram_mb, disk_mb)
    VALUES ('abc123', ${ids.owner!}, ${node!.id}, ${egg!.id}, 'Survival', 'alpine', 'run', 'offline', 4096, 10000)
    RETURNING id`;
  serverId = server!.id;
  await sql`INSERT INTO subusers (server_id, user_id, permissions) VALUES
    (${serverId}, ${ids.viewer!}, ${PRESETS.zuschauer.flags as string[]}),
    (${serverId}, ${ids.oper!}, ${PRESETS.operator.flags as string[]})`;
  await sql`INSERT INTO events (server_id, kind, severity, summary, payload)
            VALUES (${serverId}, 'crash', 'error', 'Absturz (Exit 1)', ${sql.json({ lastLines: ['boom'] })})`;
});

afterAll(async () => {
  await app?.close();
  await closeDatabase();
});

async function login(username: string, client: 'web' | 'app' = 'web') {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: username, password: PW, client } });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  const cookie = res.cookies.find((c) => c.name === 'nxp_refresh');
  return { token: body.accessToken as string, refresh: (body.refreshToken ?? cookie?.value) as string, cookie, body };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('Anmeldung', () => {
  it('mit Benutzername oder E-Mail, gross/klein egal', async () => {
    const a = await login('Owner');
    expect(a.body.user.username).toBe('owner');
    expect(a.body.user).not.toHaveProperty('password_hash');
    expect(a.cookie?.httpOnly).toBe(true);
    expect(a.cookie?.path).toBe('/api/v1/auth');
    expect(a.body).not.toHaveProperty('refreshToken'); // web: nur Cookie
    await login('OWNER@test.local');
  });

  it('falsches Passwort und unbekannter Nutzer sehen gleich aus', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'owner', password: 'falsch-falsch' } });
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'niemand', password: 'falsch-falsch' } });
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r1.json()).toEqual(r2.json());
    const [n] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.login_failed'`;
    expect(n!.n).toBe(2);
  });

  it('nach 5 Fehlversuchen gesperrt - auch mit richtigem Passwort', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'owner', password: 'falsch-falsch' } });
      expect(r.statusCode).toBe(401);
    }
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'owner', password: PW } });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    // anderes Konto ist nicht betroffen
    await login('viewer');
  });

  it('erfolgreiche Anmeldung setzt den Fehlerzaehler zurueck', async () => {
    for (let i = 0; i < 4; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'owner', password: 'falsch-falsch' } });
    }
    await login('owner');
    for (let i = 0; i < 4; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'owner', password: 'falsch-falsch' } });
    }
    await login('owner');
  });

  it('gesperrtes Konto kommt nicht rein, und bestehende Tokens sterben sofort', async () => {
    const a = await login('owner');
    await sql`UPDATE users SET suspended = true WHERE id = ${ids.owner!}`;
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(a.token) });
    expect(me.statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'owner', password: PW } });
    expect(r.statusCode).toBe(403);
  });

  it('ohne oder mit kaputtem Token: 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth('a.b.c') })).statusCode).toBe(401);
  });

  it('ungueltige Eingabe: 400 mit Feldangabe', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: '' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('invalid_input');
  });

  it('/auth/me liefert globale Rechte', async () => {
    const o = await login('owner');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(o.token) })).json();
    expect(me.permissions['server.create']).toBe(false);
    expect(me.permissions['admin.users']).toBe(false);
    const a = await login('admin');
    const me2 = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(a.token) })).json();
    expect(me2.permissions['server.create']).toBe(true);
    expect(me2.permissions['admin.users']).toBe(true);
  });
});

describe('Refresh-Rotation', () => {
  it('Cookie: neuer Token, alter ist verbraucht', async () => {
    const a = await login('owner');
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { nxp_refresh: a.refresh } });
    expect(r.statusCode).toBe(200);
    const next = r.cookies.find((c) => c.name === 'nxp_refresh')!.value;
    expect(next).not.toBe(a.refresh);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(r.json().accessToken) });
    expect(me.statusCode).toBe(200);
    // Refresh-Token liegt nur als Hash in der DB
    const [row] = await sql`SELECT count(*)::int AS n FROM sessions WHERE refresh_token = ${next}`;
    expect(row!.n).toBe(0);
  });

  it('App: Token im Body hin und zurueck', async () => {
    const a = await login('owner', 'app');
    expect(a.body.refreshToken).toBeTruthy();
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: a.refresh } });
    expect(r.statusCode).toBe(200);
    expect(r.json().refreshToken).toBeTruthy();
  });

  it('Wiederverwendung eines alten Tokens beendet die ganze Familie', async () => {
    const a = await login('owner', 'app');
    const r1 = (await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: a.refresh } })).json();
    // Gnadenfrist fuer gleichzeitige Tabs ueberspringen
    await sql`UPDATE sessions SET rotated_at = now() - interval '1 minute' WHERE rotated_at IS NOT NULL`;

    const stolen = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: a.refresh } });
    expect(stolen.statusCode).toBe(401);
    expect(stolen.json().code).toBe('refresh_reused');

    // Auch der rechtmaessige neue Token ist jetzt tot, ebenso der Access-Token
    const legit = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: r1.refreshToken } });
    expect(legit.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(r1.accessToken) })).statusCode).toBe(401);
    const [n] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.refresh_reuse'`;
    expect(n!.n).toBe(1);
  });

  it('zwei Tabs gleichzeitig: kein Rauswurf', async () => {
    const a = await login('owner', 'app');
    const r1 = (await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: a.refresh } })).json();
    // Zweiter Tab mit dem alten Token innerhalb der Schonfrist: bekommt ein
    // Access-Token fuer die neue Sitzung, aber kein (leeres!) Refresh-Token.
    const race = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: a.refresh } });
    expect(race.statusCode).toBe(200);
    expect(race.json().accessToken).toBeTruthy();
    expect(race.json().refreshToken).toBeUndefined();
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: r1.refreshToken } });
    expect(ok.statusCode).toBe(200);
  });

  it('Wettlauf im Browser: der langsamere Tab loescht den frischen Cookie nicht', async () => {
    const l = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'owner', password: PW, client: 'web' } });
    const cookie = String(l.headers['set-cookie']).match(/nxp_refresh=([^;]+)/)![1];
    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { nxp_refresh: cookie! } });
    expect(first.statusCode).toBe(200);
    expect(String(first.headers['set-cookie'])).toMatch(/nxp_refresh=[^;]{20,}/);
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { nxp_refresh: cookie! } });
    expect(second.statusCode).toBe(200);
    expect(second.headers['set-cookie']).toBeUndefined();
  });

  it('Abmelden toetet Access- und Refresh-Token, auch aeltere rotierte', async () => {
    const a = await login('owner', 'app');
    const r1 = (await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: a.refresh } })).json();
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth(r1.accessToken) });
    expect(out.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(r1.accessToken) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(a.token) })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: r1.refreshToken } });
    expect(r.statusCode).toBe(401);
  });

  it('Abmelden betrifft nur das eine Geraet; logout-all alle', async () => {
    const pc = await login('owner');
    const phone = await login('owner', 'app');
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth(pc.token) });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(phone.token) })).statusCode).toBe(200);
    const s = (await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: auth(phone.token) })).json();
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].current).toBe(true);
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout-all', headers: auth(phone.token) });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(phone.token) })).statusCode).toBe(401);
  });

  it('Passwortwechsel beendet alle Sitzungen, neues Passwort gilt', async () => {
    const a = await login('owner');
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: auth(a.token), payload: { currentPassword: 'falsch', newPassword: 'neues-passwort-123' } });
    expect(bad.statusCode).toBe(400);
    const short = await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: auth(a.token), payload: { currentPassword: PW, newPassword: 'kurz' } });
    expect(short.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: auth(a.token), payload: { currentPassword: PW, newPassword: 'neues-passwort-123' } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(a.token) })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'owner', password: 'neues-passwort-123' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('Server-API und Rechte', () => {
  it('Liste: jeder sieht nur, was er darf', async () => {
    const list = async (u: string) => (await app.inject({ method: 'GET', url: '/api/v1/servers', headers: auth((await login(u)).token) })).json().servers;
    expect(await list('owner')).toHaveLength(1);
    expect(await list('viewer')).toHaveLength(1);
    expect(await list('fremd')).toHaveLength(0);
    expect(await list('mod')).toHaveLength(1);
    expect(await list('admin')).toHaveLength(1);
    const v = (await list('viewer'))[0];
    expect(v.permissions).toContain('control.console');
    expect(v.permissions).not.toContain('control.start');
    expect(v.isOwner).toBe(false);
  });

  it('Fremder bekommt 404, nicht 403 - per UUID und short_id', async () => {
    const t = (await login('fremd')).token;
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}`, headers: auth(t) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/servers/abc123', headers: auth(t) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/servers/gibtsnicht', headers: auth(t) })).statusCode).toBe(404);
  });

  it('Detail blendet aus, was das Recht nicht hergibt', async () => {
    await sql`UPDATE subusers SET permissions = '{control.console}' WHERE user_id = ${ids.viewer!}`;
    const t = (await login('viewer')).token;
    const d = (await app.inject({ method: 'GET', url: '/api/v1/servers/abc123', headers: auth(t) })).json();
    expect(d.server.name).toBe('Survival');
    expect(d.server).not.toHaveProperty('ports');
    expect(d.server).not.toHaveProperty('startup');
    const o = (await app.inject({ method: 'GET', url: '/api/v1/servers/abc123', headers: auth((await login('owner')).token) })).json();
    expect(o.server).toHaveProperty('ports');
    expect(o.server).toHaveProperty('startup');
  });

  it('Power: Zuschauer 403, Operator 202 und Audit-Eintrag', async () => {
    const v = (await login('viewer')).token;
    const denied = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverId}/power`, headers: auth(v), payload: { action: 'start' } });
    expect(denied.statusCode).toBe(403);
    expect(calls).toHaveLength(0);

    const o = (await login('oper')).token;
    const ok = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverId}/power`, headers: auth(o), payload: { action: 'start' } });
    expect(ok.statusCode).toBe(202);
    expect(calls).toEqual([`start:${serverId}`]);
    const [a] = await sql`SELECT actor_name, action FROM audit_log WHERE action LIKE 'server.power.%'`;
    expect(a).toMatchObject({ actor_name: 'oper', action: 'server.power.start' });
  });

  it('Power: Operator darf nicht killen (nicht im Preset)', async () => {
    await sql`UPDATE servers SET status = 'running' WHERE id = ${serverId}`;
    const o = (await login('oper')).token;
    const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverId}/power`, headers: auth(o), payload: { action: 'kill' } });
    expect(r.statusCode).toBe(403);
  });

  it('Power: falscher Zustand gibt 409 mit klarer Meldung', async () => {
    const o = (await login('owner')).token;
    const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverId}/power`, headers: auth(o), payload: { action: 'stop' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('offline');
  });

  it('Power: Fehler im Hintergrund landet als Ereignis', async () => {
    await sql`UPDATE servers SET status = 'running' WHERE id = ${serverId}`;
    const o = (await login('owner')).token;
    const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverId}/power`, headers: auth(o), payload: { action: 'kill' } });
    expect(r.statusCode).toBe(202);
    await new Promise((res) => setTimeout(res, 100));
    const [e] = await sql`SELECT summary FROM events WHERE kind = 'power_failed'`;
    expect(e!.summary).toContain('Docker sagt nein');
  });

  it('Power: mehr als 10 pro Minute ergibt 429', async () => {
    const o = (await login('owner')).token;
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverId}/power`, headers: auth(o), payload: { action: 'restart' } });
      last = r.statusCode;
      if (i < 10) expect(r.statusCode).toBe(202);
    }
    expect(last).toBe(429);
  });

  it('Ereignisse: Zuschauer sieht Zeitachse ohne Absturzdetails nicht ohne Konsole', async () => {
    const v = (await login('viewer')).token;
    const ev = (await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/events`, headers: auth(v) })).json();
    expect(ev.events[0].kind).toBe('crash');
    expect(ev.events[0].payload).toEqual({ lastLines: ['boom'] });
    await sql`UPDATE subusers SET permissions = '{allocation.read}' WHERE user_id = ${ids.viewer!}`;
    const r = await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/events`, headers: auth(v) });
    expect(r.statusCode).toBe(403);
  });

  it('Aktivitaet: IP nur fuer Besitzer und Admin', async () => {
    const o = (await login('owner')).token;
    await app.inject({ method: 'POST', url: `/api/v1/servers/${serverId}/power`, headers: auth(o), payload: { action: 'start' } });
    const own = (await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/activity`, headers: auth(o) })).json();
    expect(own.activity[0]).toHaveProperty('ip');
    await sql`UPDATE subusers SET permissions = '{activity.read}' WHERE user_id = ${ids.viewer!}`;
    const v = (await login('viewer')).token;
    const sub = (await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/activity`, headers: auth(v) })).json();
    expect(sub.activity[0]).not.toHaveProperty('ip');
  });

  it('Rechteentzug wirkt sofort, ohne neue Anmeldung', async () => {
    const o = (await login('oper')).token;
    await sql`DELETE FROM subusers WHERE user_id = ${ids.oper!}`;
    const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverId}/power`, headers: auth(o), payload: { action: 'start' } });
    expect(r.statusCode).toBe(404);
  });

  it('Admin-Audit nur fuer Admins, mit Praefix-Filter', async () => {
    await login('owner');
    const u = (await login('mod')).token;
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: auth(u) })).statusCode).toBe(403);
    const a = (await login('admin')).token;
    const r = (await app.inject({ method: 'GET', url: '/api/v1/admin/audit?action=auth.login', headers: auth(a) })).json();
    expect(r.entries.length).toBeGreaterThanOrEqual(3);
    expect(r.entries.every((e: { action: string }) => e.action.startsWith('auth.login'))).toBe(true);
  });
});
