import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';
process.env.NEXUSCORE_CORS_ORIGINS = 'https://panel.example.test';
process.env.NEXUSCORE_ALLOWED_HOSTS = 'mein-pc.fritz.box';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { isAllowedHost, isAllowedOrigin } = await import('../src/protocol/security.js');

const AUTH = { authorization: 'Bearer test-token-0123456789abcdefghij' };
const HOST = '127.0.0.1:8443';

let server: Awaited<ReturnType<typeof createCoreServer>>;
let driver: InstanceType<typeof MockDriver>;
let dataDir: string;
let sessionCookie: string;

const newServer = (id: string) => ({
  id,
  name: 'A2',
  game: 'test',
  executable: 'x.exe',
  args: [],
  workingDir: '.',
  ports: [],
});

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-a2-'));
  const registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry);

  // Sitzung der Standalone-Oberflaeche - so, wie sie der Browser als Cookie haelt.
  const login = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
    payload: { login: 'admin', password: 'nur-fuer-tests-0815' },
  });
  expect(login.statusCode).toBe(200);
  sessionCookie = `nxp_session=${login.json().accessToken}`;
});

afterAll(async () => {
  await server.close();
  await driver.shutdown();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe('Block A2 - Content-Type', () => {
  it('lehnt einen gefuellten text/plain-Body mit 415 ab (simple request einer fremden Seite)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers',
      headers: { ...AUTH, host: HOST, 'content-type': 'text/plain' },
      payload: JSON.stringify(newServer('a2-plain')),
    });
    expect(res.statusCode).toBe(415);
    const list = await server.inject({ method: 'GET', url: '/core/v1/servers', headers: AUTH });
    expect(JSON.stringify(list.json())).not.toContain('a2-plain');
  });

  it('lehnt einen gefuellten Formular-Body mit 415 ab', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers',
      headers: { ...AUTH, host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'id=a2-form&name=x',
    });
    expect(res.statusCode).toBe(415);
  });

  it('nimmt application/json weiter an', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers',
      headers: { ...AUTH, host: HOST, 'content-type': 'application/json' },
      payload: newServer('a2-json'),
    });
    expect(res.statusCode).toBeLessThan(300);
  });

  it('akzeptiert einen leeren Body mit fremdem Content-Type (PowerShell)', async () => {
    for (const type of ['application/x-www-form-urlencoded', 'text/plain']) {
      const res = await server.inject({
        method: 'POST',
        url: '/core/v1/servers/a2-json/kill',
        headers: { ...AUTH, host: HOST, 'content-type': type },
        payload: '',
      });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('Block A2 - Herkunft schreibender Anfragen', () => {
  it('weist eine fremde Herkunft mit 403 ab - auch mit gueltigem Token', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/a2-json/start',
      headers: { ...AUTH, host: HOST, origin: 'https://boese.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('weist die Herkunft "null" ab', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/a2-json/start',
      headers: { ...AUTH, host: HOST, origin: 'null' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('weist eine fremde Herkunft auch auf oeffentlichen Schreib-Routen ab', async () => {
    for (const url of ['/core/v1/pair', '/api/v1/auth/refresh', '/api/v1/auth/login']) {
      const res = await server.inject({
        method: 'POST',
        url,
        headers: { host: HOST, origin: 'https://boese.example', 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('laesst die eigene Oberflaeche durch (Herkunft = angesprochener Host)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/a2-json/start',
      headers: { ...AUTH, host: HOST, origin: `http://${HOST}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('laesst eine Herkunft aus NEXUSCORE_CORS_ORIGINS durch', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/a2-json/stop',
      headers: { ...AUTH, host: HOST, origin: 'https://panel.example.test' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('laesst das Panel ohne Herkunft durch, wenn es den Token im Header schickt', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/a2-json/start',
      headers: { ...AUTH, host: HOST },
    });
    expect(res.statusCode).toBe(200);
  });

  it('verlangt bei Anmeldung per Cookie eine Herkunft', async () => {
    const ohne = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/a2-json/stop',
      headers: { host: HOST, cookie: sessionCookie },
    });
    expect(ohne.statusCode).toBe(403);

    const fremd = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/a2-json/stop',
      headers: { host: HOST, cookie: sessionCookie, origin: 'https://boese.example' },
    });
    expect(fremd.statusCode).toBe(403);

    const eigen = await server.inject({
      method: 'POST',
      url: '/core/v1/servers/a2-json/stop',
      headers: { host: HOST, cookie: sessionCookie, origin: `http://${HOST}` },
    });
    expect(eigen.statusCode).toBe(200);
  });

  it('prueft lesende Anfragen nicht auf Herkunft', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/core/v1/servers',
      headers: { ...AUTH, host: HOST, origin: 'https://boese.example' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Block A2 - Hostname (DNS-Rebinding)', () => {
  it('lehnt einen fremden Hostnamen ab - auch auf oeffentlichen Routen', async () => {
    const info = await server.inject({
      method: 'GET',
      url: '/core/v1/info',
      headers: { host: 'boese.example:8443' },
    });
    expect(info.statusCode).toBe(403);

    const page = await server.inject({ method: 'GET', url: '/', headers: { host: 'boese.example' } });
    expect(page.statusCode).toBe(403);
  });

  it('erlaubt IP-Adressen, localhost und eingetragene Namen', async () => {
    for (const host of ['127.0.0.1:8443', 'localhost:8443', '192.168.1.50:8443', '[::1]:8443', 'mein-pc.fritz.box:8443']) {
      const res = await server.inject({ method: 'GET', url: '/core/v1/info', headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
  });

  it('isAllowedHost: Grenzfaelle', () => {
    expect(isAllowedHost(undefined)).toBe(true);
    expect(isAllowedHost('LOCALHOST')).toBe(true);
    expect(isAllowedHost('panel.example.test')).toBe(true); // aus CORS_ORIGINS
    expect(isAllowedHost('127.0.0.1.boese.example')).toBe(false);
    expect(isAllowedHost('localhost.boese.example')).toBe(false);
    expect(isAllowedHost('')).toBe(true);
  });

  it('isAllowedOrigin: Grenzfaelle', () => {
    expect(isAllowedOrigin(undefined, HOST, false)).toBe(true);
    expect(isAllowedOrigin(undefined, HOST, true)).toBe(false);
    expect(isAllowedOrigin(`http://${HOST}`, HOST, true)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:9999', HOST, false)).toBe(false); // anderer Port = andere Herkunft
    expect(isAllowedOrigin('file:///C:/x.html', HOST, false)).toBe(false);
    expect(isAllowedOrigin('https://panel.example.test', HOST, false)).toBe(true);
    expect(isAllowedOrigin('https://panel.example.test.boese.example', HOST, false)).toBe(false);
  });
});

describe('Block A2 - Sicherheits-Header', () => {
  it('setzt die Header auf API-Antworten', async () => {
    const res = await server.inject({ method: 'GET', url: '/core/v1/info', headers: { host: HOST } });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('setzt die Header auch auf Fehlerantworten', async () => {
    const res = await server.inject({ method: 'GET', url: '/core/v1/servers', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('liefert die Oberflaeche mit einer Content-Security-Policy aus', async () => {
    const res = await server.inject({ method: 'GET', url: '/', headers: { host: HOST, accept: 'text/html' } });
    // Ohne gebautes web/dist gibt es keine Oberflaeche - dann gibt es hier nichts zu pruefen.
    if (res.statusCode !== 200) return;
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
