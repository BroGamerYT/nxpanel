import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { codeAt, currentStep } = await import('../src/store/totp.js');
const { revokeAllSessionTokens } = await import('../src/protocol/security.js');

const PASSWORD = 'nur-fuer-tests-0815';
const json = { 'content-type': 'application/json' };

interface Ctx {
  server: Awaited<ReturnType<typeof createCoreServer>>;
  registry: InstanceType<typeof ServerRegistry>;
  dir: string;
  token: string;
  call: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token?: string | null) => ReturnType<Awaited<ReturnType<typeof createCoreServer>>['inject']>;
  login: (body?: object) => ReturnType<Awaited<ReturnType<typeof createCoreServer>>['inject']>;
}

const open: Ctx[] = [];

async function boot(): Promise<Ctx> {
  revokeAllSessionTokens(); // Sitzungen liegen im Speicher des Prozesses - jeder Test beginnt leer
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-acct-'));
  const registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  const server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
  const login = (body: object = {}) =>
    server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: PASSWORD, ...body } });
  const first = await login();
  const token = first.json().accessToken as string;
  const call: Ctx['call'] = (method, url, payload, tok = token) =>
    server.inject({
      method,
      url,
      headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(payload === undefined ? {} : json) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const ctx = { server, registry, dir, token, call, login };
  open.push(ctx);
  return ctx;
}

afterEach(async () => {
  for (const c of open.splice(0)) {
    await c.server.close();
    c.registry.close();
    await fs.rm(c.dir, { recursive: true, force: true });
  }
});

/** TOTP einschalten wie in der Oberfläche; liefert Geheimnis und Wiederherstellungscodes. */
async function enableTotp(c: Ctx): Promise<{ secret: string; codes: string[]; step: number }> {
  const setup = (await c.call('POST', '/api/v1/auth/totp/setup')).json();
  // Der QR-Code kommt aus dem Core selbst, passend zur otpauth-Adresse
  expect(setup.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(setup.otpauth).toContain(`secret=${setup.secret}`);
  const step = currentStep();
  const res = await c.call('POST', '/api/v1/auth/totp/enable', { code: codeAt(setup.secret, step) });
  expect(res.statusCode, res.body).toBe(200);
  return { secret: setup.secret, codes: res.json().recoveryCodes, step };
}

describe('Anmeldewege und Profil', () => {
  it('die Anmeldewege sind ohne Anmeldung lesbar: Passwort und Passkey, kein Steam', async () => {
    const c = await boot();
    const res = await c.call('GET', '/api/v1/auth/methods', undefined, null);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ password: true, passkey: true, steam: false });
  });

  it('Konto: Funktion gemeldet, Profil lesen und ändern', async () => {
    const c = await boot();
    expect((await c.call('GET', '/api/v1/about')).json().features).toContain('account');
    const me = (await c.call('GET', '/api/v1/auth/me')).json();
    expect(me.user).toMatchObject({ username: 'admin', role: 'admin', email: null, avatar: null, totpEnabled: false, steamId: null });

    const patch = await c.call('PATCH', '/api/v1/auth/me', { email: 'ich@example.org', avatar: 'https://example.org/a.png', locale: 'en' });
    expect(patch.statusCode, patch.body).toBe(200);
    const after = (await c.call('GET', '/api/v1/auth/me')).json().user;
    expect(after).toMatchObject({ email: 'ich@example.org', avatar: 'https://example.org/a.png', locale: 'en' });
    // bleibt nach einem Neustart erhalten
    expect(JSON.parse(await fs.readFile(path.join(c.dir, 'users.json'), 'utf8')).users[0]).toMatchObject({ email: 'ich@example.org' });
    // leer = entfernen
    await c.call('PATCH', '/api/v1/auth/me', { email: null, avatar: '' });
    expect((await c.call('GET', '/api/v1/auth/me')).json().user).toMatchObject({ email: null, avatar: null });
  });

  it('lehnt ungültige Angaben ab - auch Bildadressen, die Code ausführen könnten', async () => {
    const c = await boot();
    const patch = (body: object) => c.call('PATCH', '/api/v1/auth/me', body);
    expect((await patch({ email: 'kein-mail' })).statusCode).toBe(400);
    expect((await patch({ avatar: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await patch({ avatar: 'data:image/svg+xml,<svg onload=alert(1)>' })).statusCode).toBe(400);
    expect((await patch({ avatar: 'http://example.org/a.png' })).statusCode).toBe(400);
    expect((await patch({ avatar: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await patch({ username: 'a' })).statusCode).toBe(400);
    expect((await patch({ username: 'mit leerzeichen' })).statusCode).toBe(400);
    expect((await patch({ unbekannt: 1 })).statusCode).toBe(400);
    expect((await patch({ avatar: 'preset-fuchs' })).statusCode).toBe(200); // Bild aus der Auswahl der Oberfläche
  });

  it('neuer Benutzername gilt für die nächste Anmeldung', async () => {
    const c = await boot();
    expect((await c.call('PATCH', '/api/v1/auth/me', { username: 'chef' })).statusCode).toBe(200);
    expect((await c.login()).statusCode).toBe(401);
    expect((await c.login({ login: 'chef' })).statusCode).toBe(200);
  });

  it('ohne Anmeldung kein Zugriff', async () => {
    const c = await boot();
    for (const [m, u] of [['GET', '/api/v1/auth/me'], ['PATCH', '/api/v1/auth/me'], ['POST', '/api/v1/auth/totp/setup'], ['GET', '/api/v1/auth/sessions'], ['POST', '/api/v1/auth/logout-all']] as const) {
      expect((await c.call(m, u, m === 'PATCH' ? {} : undefined, null)).statusCode, `${m} ${u}`).toBe(401);
    }
  });
});

describe('Zwei-Faktor', () => {
  it('Einrichten: erst Geheimnis, dann Code bestätigen, dann Wiederherstellungscodes (einmalig)', async () => {
    const c = await boot();
    const setup = (await c.call('POST', '/api/v1/auth/totp/setup')).json();
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauth).toMatch(/^otpauth:\/\/totp\/NexusCore%3Aadmin\?/);
    // Falscher Code schaltet nicht ein
    const bad = await c.call('POST', '/api/v1/auth/totp/enable', { code: '000000' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('totp_invalid');
    expect((await c.call('GET', '/api/v1/auth/me')).json().user.totpEnabled).toBe(false);

    const ok = await c.call('POST', '/api/v1/auth/totp/enable', { code: codeAt(setup.secret, currentStep()) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodes).toHaveLength(10);
    expect(ok.json().recoveryCodes[0]).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect((await c.call('GET', '/api/v1/auth/me')).json().user.totpEnabled).toBe(true);
    // Doppelt einrichten geht nicht
    expect((await c.call('POST', '/api/v1/auth/totp/setup')).statusCode).toBe(400);
    // Die Datei enthält keine Klartext-Wiederherstellungscodes
    const file = await fs.readFile(path.join(c.dir, 'users.json'), 'utf8');
    for (const code of ok.json().recoveryCodes) expect(file).not.toContain(code);
  });

  it('ohne vorheriges Einrichten lässt sich nichts einschalten', async () => {
    const c = await boot();
    const res = await c.call('POST', '/api/v1/auth/totp/enable', { code: '123456' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('totp_no_setup');
  });

  it('Anmeldung verlangt danach den Code; ein Code gilt nur einmal', async () => {
    const c = await boot();
    const { secret, step } = await enableTotp(c);

    const missing = await c.login();
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe('totp_required');
    expect(missing.headers['set-cookie']).toBeUndefined();

    // Der Code, mit dem eingeschaltet wurde, ist verbraucht (kein Wiederverwenden eines mitgelesenen Codes)
    const replay = await c.login({ totp: codeAt(secret, step) });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('totp_invalid');

    const next = codeAt(secret, step + 1);
    const ok = await c.login({ totp: next });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().accessToken).toMatch(/^nxp_/);
    // derselbe Code ein zweites Mal: abgelehnt
    expect((await c.login({ totp: next })).statusCode).toBe(401);
  });

  it('falsches Passwort verrät nichts über den zweiten Faktor', async () => {
    const c = await boot();
    await enableTotp(c);
    const res = await c.login({ password: 'falsch-falsch-123' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('invalid_credentials');
  });

  it('Wiederherstellungscode: funktioniert genau einmal', async () => {
    const c = await boot();
    const { codes } = await enableTotp(c);
    const ok = await c.login({ recoveryCode: codes[0]!.toUpperCase().replace(/-/g, ' ') }); // Schreibweise egal
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await c.login({ recoveryCode: codes[0]! })).statusCode).toBe(401);
    expect((await c.login({ recoveryCode: codes[1]! })).statusCode).toBe(200);
    expect(c.registry.recentAudit().some((a) => a.action === 'auth.recovery_code_used')).toBe(true);
  });

  it('Code erraten wird gesperrt - auch mit richtigem Passwort', async () => {
    const c = await boot();
    const { secret, step } = await enableTotp(c);
    for (let i = 0; i < 5; i++) expect((await c.login({ totp: '000000' })).statusCode).toBe(401);
    const locked = await c.login({ totp: codeAt(secret, step + 1) });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe('too_many_attempts');
  });

  it('Abschalten und neue Codes verlangen Passwort UND Code', async () => {
    const c = await boot();
    const { secret, step, codes } = await enableTotp(c);

    expect((await c.call('POST', '/api/v1/auth/totp/disable', { password: PASSWORD })).statusCode).toBe(400);
    const wrongPw = await c.call('POST', '/api/v1/auth/totp/disable', { password: 'falsch-falsch-123', totp: codeAt(secret, step + 1) });
    expect(wrongPw.json().code).toBe('invalid_password');
    expect((await c.call('GET', '/api/v1/auth/me')).json().user.totpEnabled).toBe(true);

    // neue Codes: die alten gelten danach nicht mehr
    const regen = await c.call('POST', '/api/v1/auth/totp/recovery-codes', { password: PASSWORD, recoveryCode: codes[2] });
    expect(regen.statusCode, regen.body).toBe(200);
    expect(regen.json().recoveryCodes).toHaveLength(10);
    expect((await c.login({ recoveryCode: codes[3]! })).statusCode).toBe(401);
    expect((await c.login({ recoveryCode: regen.json().recoveryCodes[0] })).statusCode).toBe(200);

    const off = await c.call('POST', '/api/v1/auth/totp/disable', { password: PASSWORD, totp: codeAt(secret, step + 1) });
    expect(off.statusCode, off.body).toBe(200);
    expect((await c.call('GET', '/api/v1/auth/me')).json().user.totpEnabled).toBe(false);
    expect((await c.login()).statusCode).toBe(200); // wieder nur Passwort
    // Ohne aktiven Zwei-Faktor gibt es nichts abzuschalten
    expect((await c.call('POST', '/api/v1/auth/totp/disable', { password: PASSWORD, totp: '123456' })).statusCode).toBe(400);
  });

  it('bleibt nach einem Neustart des Cores aktiv, auch mit gesetztem Passwort in der Umgebung', async () => {
    const c = await boot();
    const { secret, step } = await enableTotp(c);
    const driver = new MockDriver();
    await driver.initialize();
    const registry2 = await ServerRegistry.open(c.dir);
    const server2 = await createCoreServer(driver, new EventBus(), registry2, { installs: null });
    try {
      const res = await server2.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: PASSWORD } });
      expect(res.json().code).toBe('totp_required');
      const ok = await server2.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: PASSWORD, totp: codeAt(secret, step + 1) } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await server2.close();
      registry2.close();
    }
  });

  it('Passwort ändern lässt den Zwei-Faktor bestehen', async () => {
    const c = await boot();
    await enableTotp(c);
    const res = await c.call('POST', '/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'ein-ganz-neues-passwort-1' });
    expect(res.statusCode).toBe(200);
    expect((await c.call('GET', '/api/v1/auth/me', undefined, res.json().accessToken)).json().user.totpEnabled).toBe(true);
  });
});

describe('Sitzungen', () => {
  it('listet Sitzungen mit Kennung statt Token, die eigene markiert', async () => {
    const c = await boot();
    const second = (await c.login()).json().accessToken as string;
    const list = (await c.call('GET', '/api/v1/auth/sessions')).json().sessions as Array<Record<string, any>>;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ current: true, ip: expect.any(String) });
    expect(list[0]!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(list)).not.toContain(c.token);
    expect(JSON.stringify(list)).not.toContain(second);
    expect(list.filter((s) => s.current)).toHaveLength(1);
  });

  it('eine fremde Sitzung beenden: deren Token gilt nicht mehr, das eigene schon', async () => {
    const c = await boot();
    const other = (await c.login()).json().accessToken as string;
    expect((await c.call('GET', '/api/v1/auth/me', undefined, other)).statusCode).toBe(200);
    const sessions = (await c.call('GET', '/api/v1/auth/sessions')).json().sessions as Array<Record<string, any>>;
    const theirs = sessions.find((s) => !s.current)!;
    expect((await c.call('DELETE', `/api/v1/auth/sessions/${theirs.id}`)).statusCode).toBe(200);
    expect((await c.call('GET', '/api/v1/auth/me', undefined, other)).statusCode).toBe(401);
    expect((await c.call('GET', '/api/v1/auth/me')).statusCode).toBe(200);
    expect((await c.call('DELETE', `/api/v1/auth/sessions/${theirs.id}`)).statusCode).toBe(404);
    expect((await c.call('DELETE', '/api/v1/auth/sessions/nicht-gueltig')).statusCode).toBe(404);
  });

  it('die eigene Sitzung beenden meldet ab', async () => {
    const c = await boot();
    const mine = ((await c.call('GET', '/api/v1/auth/sessions')).json().sessions as Array<Record<string, any>>).find((s) => s.current)!;
    expect((await c.call('DELETE', `/api/v1/auth/sessions/${mine.id}`)).statusCode).toBe(200);
    expect((await c.call('GET', '/api/v1/auth/me')).statusCode).toBe(401);
  });

  it('"Alle beenden" lässt die eigene Sitzung bestehen', async () => {
    const c = await boot();
    const a = (await c.login()).json().accessToken as string;
    const b = (await c.login()).json().accessToken as string;
    const res = await c.call('POST', '/api/v1/auth/logout-all');
    expect(res.json()).toEqual({ ok: true, revoked: 2 });
    expect((await c.call('GET', '/api/v1/auth/me', undefined, a)).statusCode).toBe(401);
    expect((await c.call('GET', '/api/v1/auth/me', undefined, b)).statusCode).toBe(401);
    expect((await c.call('GET', '/api/v1/auth/me')).statusCode).toBe(200);
    expect(((await c.call('GET', '/api/v1/auth/sessions')).json().sessions as unknown[]).length).toBe(1);
  });
});
