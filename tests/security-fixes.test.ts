import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { verifySteamOpenId } from '../src/auth/steam-openid.js';
import { issueOneTimeToken, consumeOneTimeToken } from '../src/auth/one-time.js';

// Regressionstests fuer die Pruefung vom 10.11.2026.
let app: FastifyInstance;
const PW = 'ein-langes-passwort';
let adminId = '', userId = '', adminTok = '', userTok = '';

beforeAll(async () => { await runMigrations(); });
beforeEach(async () => {
  await sql`TRUNCATE users, sessions, audit_log RESTART IDENTITY CASCADE`;
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false });
  adminId = (await createUser({ username: 'chef', email: 'c@t.local', password: PW, role: 'admin' })).id;
  userId = (await createUser({ username: 'gast', email: 'g@t.local', password: PW })).id;
  const tok = async (u: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u, password: PW, client: 'app' } })).json().accessToken as string;
  adminTok = await tok('chef'); userTok = await tok('gast');
});
afterAll(async () => { await app?.close(); await closeDatabase(); });
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('Imitation beenden', () => {
  it('ohne Anmeldung gibt es KEINE Admin-Sitzung (frueher: Admin-ID genuegte)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/impersonate/stop', payload: { adminId } });
    expect(r.statusCode).toBe(401);
    expect(r.json().accessToken).toBeUndefined();
  });

  it('ein normaler Nutzer kann sich nicht zum Admin machen', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/impersonate/stop', headers: auth(userTok), payload: { returnToken: 'x'.repeat(40) } });
    expect(r.statusCode).toBe(403);
  });

  it('voller Ablauf: Admin imitiert, kehrt mit Rueckkehr-Token zurueck, Token nur einmal', async () => {
    const imp = (await app.inject({ method: 'POST', url: `/api/v1/admin/users/${userId}/impersonate`, headers: auth(adminTok) })).json();
    expect(imp.originalAdmin.returnToken).toBeTruthy();
    const back = await app.inject({ method: 'POST', url: '/api/v1/auth/impersonate/stop', headers: auth(imp.accessToken), payload: { returnToken: imp.originalAdmin.returnToken } });
    expect(back.statusCode).toBe(200);
    expect(back.json().user.id).toBe(adminId);
    // Imitations-Sitzung ist beendet, Token verbraucht
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(imp.accessToken) })).statusCode).toBe(401);
    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/impersonate/stop', headers: auth(back.json().accessToken), payload: { returnToken: imp.originalAdmin.returnToken } });
    expect(again.statusCode).toBe(403);
  });

  it('das Rueckkehr-Token eines anderen Nutzers hilft nicht', async () => {
    const other = (await createUser({ username: 'dritter', email: 'd@t.local', password: PW })).id;
    const imp = (await app.inject({ method: 'POST', url: `/api/v1/admin/users/${other}/impersonate`, headers: auth(adminTok) })).json();
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/impersonate/stop', headers: auth(userTok), payload: { returnToken: imp.originalAdmin.returnToken } });
    expect(r.statusCode).toBe(403);
  });
});

describe('Steam-Verknuepfung', () => {
  it('link-start braucht Anmeldung und liefert ein Einmal-Token statt Nutzer-ID', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/steam/link-start' })).statusCode).toBe(401);
    const r = (await app.inject({ method: 'POST', url: '/api/v1/auth/steam/link-start', headers: auth(userTok) })).json();
    expect(r.url).toMatch(/action=link&state=/);
    expect(r.url).not.toContain(userId);
  });

  it('Verknuepfen ohne state wird nicht zu Steam weitergeleitet', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/v1/auth/steam/login?action=link&uid=${adminId}` });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/account?error=unauthenticated');
  });

  it('OpenID-Antwort: falscher Endpunkt, fremde Rueckkehr-Adresse und Wiederholung werden abgewiesen', async () => {
    const base = {
      'openid.mode': 'id_res',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000000',
      'openid.return_to': 'https://evil.example/cb',
      'openid.response_nonce': `2026-11-10T10:00:00Zabc${Math.random()}`,
    };
    expect(await verifySteamOpenId({ ...base, 'openid.op_endpoint': 'https://evil.example/openid' }, 'https://panel/cb')).toBeNull();
    expect(await verifySteamOpenId(base, 'https://panel/cb')).toBeNull();
  });
});

describe('Einmal-Tokens', () => {
  it('genau einmal einloesbar, nur fuer die richtige Art', () => {
    const t = issueOneTimeToken('a', { x: 1 }, 60_000);
    expect(consumeOneTimeToken('b', t)).toBeNull();
    const t2 = issueOneTimeToken('a', { x: 2 }, 60_000);
    expect(consumeOneTimeToken<{ x: number }>('a', t2)).toEqual({ x: 2 });
    expect(consumeOneTimeToken('a', t2)).toBeNull();
  });
  it('abgelaufen ist abgelaufen', () => {
    const t = issueOneTimeToken('a', 1, -1);
    expect(consumeOneTimeToken('a', t)).toBeNull();
  });
});
