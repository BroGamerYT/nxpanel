import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { relyingPartyOf } = await import('../src/auth/passkeys.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij' };
const PW = 'ein-sicheres-passwort-1';
const HOST = 'localhost';
const ORIGIN = 'http://localhost';

// ------------------------------------------------------- Software-Authenticator

const b64 = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string): Buffer => crypto.createHash('sha256').update(b).digest();

/** Minimaler CBOR-Schreiber fuer genau das, was WebAuthn braucht. */
const cbor = {
  head(major: number, n: number): Buffer {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  },
  text: (s: string) => Buffer.concat([cbor.head(3, Buffer.byteLength(s)), Buffer.from(s)]),
  bytes: (b: Buffer) => Buffer.concat([cbor.head(2, b.length), b]),
  int: (n: number) => (n >= 0 ? cbor.head(0, n) : cbor.head(1, -1 - n)),
  map: (pairs: Array<[Buffer, Buffer]>) => Buffer.concat([cbor.head(5, pairs.length), ...pairs.flat()]),
};

class Authenticator {
  readonly key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  readonly credId = crypto.randomBytes(32);
  counter = 0;

  private cose(): Buffer {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor.map([
      [cbor.int(1), cbor.int(2)],
      [cbor.int(3), cbor.int(-7)],
      [cbor.int(-1), cbor.int(1)],
      [cbor.int(-2), cbor.bytes(Buffer.from(jwk.x, 'base64url'))],
      [cbor.int(-3), cbor.bytes(Buffer.from(jwk.y, 'base64url'))],
    ]);
  }

  create(challenge: string, origin: string, rpID: string) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([sha256(rpID), Buffer.from([0x41]), counter, Buffer.alloc(16), credLen, this.credId, this.cose()]);
    const attestationObject = cbor.map([
      [cbor.text('fmt'), cbor.text('none')],
      [cbor.text('attStmt'), cbor.map([])],
      [cbor.text('authData'), cbor.bytes(authData)],
    ]);
    return {
      id: b64(this.credId),
      rawId: b64(this.credId),
      type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
    };
  }

  get(challenge: string, origin: string, rpID: string, options: { counter?: number; tamper?: boolean } = {}) {
    this.counter = options.counter ?? this.counter + 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([sha256(rpID), Buffer.from([0x05]), counter]);
    const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), { key: this.key.privateKey, dsaEncoding: 'der' });
    if (options.tamper) signature[signature.length - 1]! ^= 0xff;
    return {
      id: b64(this.credId),
      rawId: b64(this.credId),
      type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature) },
      clientExtensionResults: {},
    };
  }
}

// ------------------------------------------------------------------- Server

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;

type Headers = Record<string, string | undefined>;
/** `x-test-ip` ist kein echter Header, sondern die Herkunft (IP) der Testanfrage - die Sperre gilt je Herkunft. */
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: Headers, payload?: unknown) => {
  const { 'x-test-ip': ip, ...rest } = headers;
  return server.inject({
    method,
    url,
    headers: (payload === undefined ? rest : { ...rest, ...json }) as Record<string, string>,
    ...(ip ? { remoteAddress: ip } : {}),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
};
const web: Headers = { host: HOST, origin: ORIGIN };

async function makeUser(name: string): Promise<{ id: string; h: Headers }> {
  const created = await call('POST', '/api/v1/admin/users', MASTER, { username: name, password: PW });
  expect(created.statusCode, created.body).toBe(201);
  const login = await call('POST', '/api/v1/auth/login', { host: HOST, origin: ORIGIN }, { login: name, password: PW });
  return { id: created.json().user.id as string, h: { ...web, authorization: `Bearer ${login.json().accessToken}` } };
}

async function register(user: { h: Headers }, auth: InstanceType<typeof Authenticator>, name = 'Mein Laptop') {
  const opts = (await call('POST', '/api/v1/auth/passkeys/register-options', user.h)).json();
  const res = await call('POST', '/api/v1/auth/passkeys/register-verify', user.h, {
    challengeId: opts.challengeId,
    response: auth.create(opts.options.challenge, ORIGIN, HOST),
    deviceName: name,
  });
  return { res, opts };
}

async function loginOptions(username?: string, headers: Headers = web) {
  return call('POST', '/api/v1/auth/passkeys/login-options', headers, username === undefined ? {} : { username });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-pk-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Herkunft und Host', () => {
  it('Passkeys nur mit passendem Host und Herkunft - nie für IP-Adressen', () => {
    expect(relyingPartyOf({ host: 'localhost:8443', origin: 'http://localhost:8443' })).toEqual({ rpID: 'localhost', origin: 'http://localhost:8443' });
    expect(relyingPartyOf({ host: 'core.example.org', origin: 'https://core.example.org' })).toEqual({ rpID: 'core.example.org', origin: 'https://core.example.org' });
    expect(() => relyingPartyOf({ host: '127.0.0.1:8443', origin: 'http://127.0.0.1:8443' })).toThrow(/IP-Adresse/);
    expect(() => relyingPartyOf({ host: '[::1]:8443', origin: 'http://[::1]:8443' })).toThrow(/IP-Adresse/);
    expect(() => relyingPartyOf({ host: 'localhost', origin: 'http://evil.example' })).toThrow(/passt nicht/);
    expect(() => relyingPartyOf({ host: 'localhost', origin: 'http://localhost.evil.example' })).toThrow(/passt nicht/);
    expect(() => relyingPartyOf({ host: 'localhost' })).toThrow(/keine Herkunft/);
    expect(() => relyingPartyOf({ origin: 'http://localhost' })).toThrow(/keinen Host/);
    expect(() => relyingPartyOf({ host: 'localhost', origin: 'javascript:alert(1)' })).toThrow();
  });
});

describe('Passkeys registrieren und verwalten', () => {
  it('die Anmeldeseite erfährt, dass es Passkeys gibt', async () => {
    expect((await call('GET', '/api/v1/auth/methods', {})).json()).toMatchObject({ password: true, passkey: true });
    expect((await call('GET', '/api/v1/about', MASTER)).json().features).toContain('passkeys');
  });

  it('verlangt Anmeldung, ein Benutzerkonto und einen Namen statt einer IP', async () => {
    expect((await call('POST', '/api/v1/auth/passkeys/register-options', web)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/auth/passkeys', web)).statusCode).toBe(401);
    // Das Master-Token hat kein Konto
    expect((await call('POST', '/api/v1/auth/passkeys/register-options', { ...MASTER, ...web })).statusCode).toBe(403);
    const u = await makeUser('pk-ip');
    const res = await call('POST', '/api/v1/auth/passkeys/register-options', { ...u.h, host: '127.0.0.1:8443', origin: 'http://127.0.0.1:8443' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('passkey_needs_hostname');
    // Ohne Herkunft (kein Browser) geht es auch nicht
    const noOrigin = await call('POST', '/api/v1/auth/passkeys/register-options', { authorization: u.h.authorization, host: HOST });
    expect(noOrigin.json().code).toBe('passkey_no_origin');
  });

  it('registriert einen Passkey, listet, benennt um und löscht ihn', async () => {
    const u = await makeUser('pk-verwalten');
    const auth = new Authenticator();
    const { res } = await register(u, auth, 'Mein Laptop');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().passkey).toMatchObject({ device_name: 'Mein Laptop', last_used_at: null });
    // Nie der öffentliche Schlüssel oder die Zähler in der Antwort
    expect(res.body).not.toContain('publicKey');

    const list = (await call('GET', '/api/v1/auth/passkeys', u.h)).json().passkeys as Array<{ id: string; device_name: string }>;
    expect(list).toHaveLength(1);
    const id = list[0]!.id;
    expect((await call('PATCH', `/api/v1/auth/passkeys/${id}`, u.h, { deviceName: 'Handy\nneu' })).json().passkey.device_name).toBe('Handy neu');
    expect((await call('PATCH', '/api/v1/auth/passkeys/gibtsnicht', u.h, { deviceName: 'x' })).statusCode).toBe(404);

    // Derselbe Schlüssel nicht zweimal
    const again = await register(u, auth, 'Doppelt');
    expect(again.res.statusCode).toBe(409);
    // Ein anderer Benutzer sieht und löscht ihn nicht
    const other = await makeUser('pk-fremd');
    expect((await call('GET', '/api/v1/auth/passkeys', other.h)).json().passkeys).toEqual([]);
    expect((await call('DELETE', `/api/v1/auth/passkeys/${id}`, other.h)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/auth/passkeys/${id}`, u.h)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/auth/passkeys', u.h)).json().passkeys).toEqual([]);
  });

  it('lehnt falsche Challenge, falsche Herkunft und Fremdes ab', async () => {
    const u = await makeUser('pk-falsch');
    const auth = new Authenticator();
    const opts = (await call('POST', '/api/v1/auth/passkeys/register-options', u.h)).json();
    const ok = auth.create(opts.options.challenge, ORIGIN, HOST);
    // Unbekannte Challenge
    expect((await call('POST', '/api/v1/auth/passkeys/register-verify', u.h, { challengeId: 'x'.repeat(48), response: ok })).statusCode).toBe(400);
    // Antwort des Geräts auf eine andere Seite: Herkunft im Gerätedatensatz falsch
    const wrongOrigin = auth.create(opts.options.challenge, 'http://evil.example', HOST);
    expect((await call('POST', '/api/v1/auth/passkeys/register-verify', u.h, { challengeId: opts.challengeId, response: wrongOrigin })).statusCode).toBe(400);
    // Eine Challenge gilt genau einmal - auch nach einem Fehlversuch
    expect((await call('POST', '/api/v1/auth/passkeys/register-verify', u.h, { challengeId: opts.challengeId, response: ok })).statusCode).toBe(400);
    // Die Challenge eines anderen Benutzers geht nicht
    const mine = (await call('POST', '/api/v1/auth/passkeys/register-options', u.h)).json();
    const thief = await makeUser('pk-dieb');
    expect((await call('POST', '/api/v1/auth/passkeys/register-verify', thief.h, { challengeId: mine.challengeId, response: auth.create(mine.options.challenge, ORIGIN, HOST) })).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/auth/passkeys', u.h)).json().passkeys).toEqual([]);
  });
});

describe('Mit Passkey anmelden', () => {
  it('Anmeldung mit Benutzernamen: gibt eine echte Sitzung des richtigen Benutzers', async () => {
    const u = await makeUser('pk-login');
    const auth = new Authenticator();
    await register(u, auth);

    const opts = (await loginOptions('pk-login', { host: HOST, origin: ORIGIN })).json();
    expect(opts.options.allowCredentials).toEqual([expect.objectContaining({ id: b64(auth.credId) })]);
    const res = await call('POST', '/api/v1/auth/passkeys/login-verify', { host: HOST, origin: ORIGIN }, { challengeId: opts.challengeId, response: auth.get(opts.options.challenge, ORIGIN, HOST) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['set-cookie']).toMatch(/nxp_session=/);
    const me = (await call('GET', '/api/v1/auth/me', { authorization: `Bearer ${res.json().accessToken}` })).json();
    expect(me.user).toMatchObject({ id: u.id, username: 'pk-login' });
    // Im Protokoll unter dem Namen, mit dem Weg
    const audit = registry.queryAudit({ limit: 20, actionPrefix: 'auth.login' }).find((e) => e.actorName === 'pk-login');
    expect(audit?.detail).toMatchObject({ via: 'passkey' });
    // Letzter Gebrauch ist vermerkt
    expect((await call('GET', '/api/v1/auth/passkeys', u.h)).json().passkeys[0].last_used_at).not.toBeNull();
  });

  it('Anmeldung ohne Benutzernamen (Passkey im Gerät) findet das Konto selbst', async () => {
    const u = await makeUser('pk-ohnename');
    const auth = new Authenticator();
    await register(u, auth);
    const opts = (await loginOptions()).json();
    expect(opts.options.allowCredentials).toBeUndefined();
    const res = await call('POST', '/api/v1/auth/passkeys/login-verify', web, { challengeId: opts.challengeId, response: auth.get(opts.options.challenge, ORIGIN, HOST) });
    expect(res.statusCode, res.body).toBe(200);
    expect((await call('GET', '/api/v1/auth/me', { authorization: `Bearer ${res.json().accessToken}` })).json().user.id).toBe(u.id);
  });

  it('verrät nicht, ob es einen Benutzer oder Passkeys gibt: gleiche Form für Unbekannte', async () => {
    const real = await makeUser('pk-gibtsnicht-aber-ohne-passkey');
    const unknown = (await loginOptions('gibt-es-wirklich-nicht')).json();
    const without = (await loginOptions('pk-gibtsnicht-aber-ohne-passkey')).json();
    expect(unknown.options.allowCredentials).toHaveLength(1);
    expect(without.options.allowCredentials).toHaveLength(1);
    // Die Attrappe ist je Name stabil (sonst ließe sich Echtes von Falschem trennen) - und nie ein echter Schlüssel
    const again = (await loginOptions('gibt-es-wirklich-nicht')).json();
    expect(again.options.allowCredentials[0].id).toBe(unknown.options.allowCredentials[0].id);
    expect(unknown.options.allowCredentials[0].id).not.toBe(without.options.allowCredentials[0].id);
    expect(real.id).toBeTruthy();
  });

  it('weist Fälschungen, Wiederholung, fremde Schlüssel und falsche Herkunft ab', async () => {
    const u = await makeUser('pk-angriff');
    const auth = new Authenticator();
    await register(u, auth);
    // Jeder Schritt von einer neuen Herkunft: sechs Fehlversuche von einer würden - zu Recht - die Sperre auslösen
    let n = 0;
    const fresh = (): Headers => ({ host: HOST, origin: ORIGIN, 'x-test-ip': `198.51.100.${++n}` });
    const post = (challengeId: string, response: unknown, headers: Headers = fresh()) => call('POST', '/api/v1/auth/passkeys/login-verify', headers, { challengeId, response });

    // falsche Signatur
    let opts = (await loginOptions('pk-angriff', fresh())).json();
    expect((await post(opts.challengeId, auth.get(opts.options.challenge, ORIGIN, HOST, { tamper: true }))).statusCode).toBe(401);

    // Wiederholung: dieselbe Challenge zweimal
    opts = (await loginOptions('pk-angriff', fresh())).json();
    const good = auth.get(opts.options.challenge, ORIGIN, HOST);
    expect((await post(opts.challengeId, good)).statusCode).toBe(200);
    expect((await post(opts.challengeId, good)).statusCode).toBe(401);

    // Zähler zurückgesetzt (kopierter Schlüssel): derselbe Zähler noch einmal
    opts = (await loginOptions('pk-angriff', fresh())).json();
    const replay = auth.get(opts.options.challenge, ORIGIN, HOST, { counter: 1 });
    expect((await post(opts.challengeId, replay)).statusCode).toBe(401);

    // Signatur für eine fremde Seite (Phishing): Herkunft im Gerätedatensatz
    opts = (await loginOptions('pk-angriff', fresh())).json();
    expect((await post(opts.challengeId, auth.get(opts.options.challenge, 'http://evil.example', HOST))).statusCode).toBe(401);

    // Challenge unter anderem Host eingelöst
    opts = (await loginOptions('pk-angriff', fresh())).json();
    const elsewhere = await post(opts.challengeId, auth.get(opts.options.challenge, 'http://localhost:9999', HOST), { host: 'localhost:9999', origin: 'http://localhost:9999', 'x-test-ip': '198.51.100.99' });
    expect(elsewhere.statusCode).toBe(401);

    // Ein unbekannter Schlüssel
    opts = (await loginOptions('pk-angriff', fresh())).json();
    const stranger = new Authenticator();
    expect((await post(opts.challengeId, stranger.get(opts.options.challenge, ORIGIN, HOST))).statusCode).toBe(401);
  });

  it('der Passkey eines anderen Benutzers meldet nicht als der angefragte an', async () => {
    const web2 = { host: HOST, origin: ORIGIN, 'x-test-ip': '198.51.100.2' };
    const a = await makeUser('pk-a');
    const b = await makeUser('pk-b');
    const authA = new Authenticator();
    const authB = new Authenticator();
    await register(a, authA);
    await register(b, authB);
    const opts = (await loginOptions('pk-a', web2)).json();
    const res = await call('POST', '/api/v1/auth/passkeys/login-verify', web2, { challengeId: opts.challengeId, response: authB.get(opts.options.challenge, ORIGIN, HOST) });
    expect(res.statusCode).toBe(401);
  });

  it('gesperrte Benutzer und gelöschte Passkeys melden nicht mehr an', async () => {
    const web3 = { host: HOST, origin: ORIGIN, 'x-test-ip': '198.51.100.3' };
    const u = await makeUser('pk-gesperrt');
    const auth = new Authenticator();
    const { res } = await register(u, auth);
    const id = res.json().passkey.id as string;
    const post = async () => {
      const opts = (await loginOptions('pk-gesperrt', web3)).json();
      return call('POST', '/api/v1/auth/passkeys/login-verify', web3, { challengeId: opts.challengeId, response: auth.get(opts.options.challenge, ORIGIN, HOST) });
    };
    expect((await post()).statusCode).toBe(200);
    await call('PATCH', `/api/v1/admin/users/${u.id}`, MASTER, { suspended: true });
    expect((await post()).statusCode).toBe(401);
    await call('PATCH', `/api/v1/admin/users/${u.id}`, MASTER, { suspended: false });
    const fresh = (await call('POST', '/api/v1/auth/login', web, { login: 'pk-gesperrt', password: PW })).json().accessToken as string;
    expect((await call('DELETE', `/api/v1/auth/passkeys/${id}`, { ...web, authorization: `Bearer ${fresh}` })).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(401);
  });

  it('zu viele Fehlversuche sperren die Herkunft - wie beim Passwort', async () => {
    const u = await makeUser('pk-sperre');
    const auth = new Authenticator();
    await register(u, auth);
    const noisy: Headers = { host: HOST, origin: ORIGIN, 'x-test-ip': '203.0.113.9' };
    for (let i = 0; i < 5; i++) {
      const opts = (await loginOptions('pk-sperre', noisy)).json();
      await call('POST', '/api/v1/auth/passkeys/login-verify', noisy, { challengeId: opts.challengeId, response: auth.get(opts.options.challenge, ORIGIN, HOST, { tamper: true }) });
    }
    // Alle Fehlversuche kamen von derselben Herkunft (inject): jetzt ist sie gesperrt
    const blocked = await loginOptions('pk-sperre', noisy);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});
