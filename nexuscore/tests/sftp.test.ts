import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2, { type SFTPWrapper } from 'ssh2';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { codeAt, currentStep } = await import('../src/store/totp.js');

const json = { 'content-type': 'application/json' };
const PW = 'ein-sicheres-passwort-1';

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
let admin: Record<string, string>;
let port: number;
let fingerprint: string;
let alphaDir: string;
let betaDir: string;

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

// ---------------------------------------------------------------- SFTP-Client

interface Session {
  sftp: SFTPWrapper;
  close: () => void;
}

function connect(username: string, password: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    client
      .on('ready', () =>
        client.sftp((err, sftp) => {
          if (err) {
            client.end();
            return reject(err);
          }
          resolve({ sftp, close: () => client.end() });
        }),
      )
      .on('error', reject)
      .connect({
        host: '127.0.0.1',
        port,
        username,
        password,
        readyTimeout: 8000,
        // Der Fingerabdruck, den der Core ausgibt, muss der des Schluessels sein
        hostVerifier: (key: Buffer) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === fingerprint,
      });
  });
}

const p = <T>(run: (cb: (err: Error | null | undefined, value: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => run((err, value) => (err ? reject(err) : resolve(value))));

const ops = (s: SFTPWrapper) => ({
  list: (d: string) => p<Array<{ filename: string }>>((cb) => s.readdir(d, cb)).then((l) => l.map((e) => e.filename).sort()),
  read: (f: string) => p<Buffer>((cb) => s.readFile(f, cb)).then((b) => b.toString()),
  write: (f: string, data: string) => p<void>((cb) => s.writeFile(f, data, (e) => cb(e, undefined))),
  mkdir: (d: string) => p<void>((cb) => s.mkdir(d, (e) => cb(e, undefined))),
  rmdir: (d: string) => p<void>((cb) => s.rmdir(d, (e) => cb(e, undefined))),
  unlink: (f: string) => p<void>((cb) => s.unlink(f, (e) => cb(e, undefined))),
  rename: (a: string, b: string) => p<void>((cb) => s.rename(a, b, (e) => cb(e, undefined))),
  stat: (f: string) => p<{ size: number; isDirectory(): boolean }>((cb) => s.stat(f, cb)),
});

const withSession = async (user: string, pw: string, run: (o: ReturnType<typeof ops>) => Promise<void>): Promise<void> => {
  const s = await connect(user, pw);
  try {
    await run(ops(s.sftp));
  } finally {
    s.close();
  }
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-sftp-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  // So tun, als waere es der native Treiber: nur Administratoren schreiben Dateien
  Object.defineProperty(driver, 'name', { value: 'windows-native' });
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false, sftp: { host: '127.0.0.1', port: 0 } });
  const svc = (server as unknown as { sftp: { port: number; fingerprint: string } }).sftp;
  port = svc.port;
  fingerprint = svc.fingerprint;
  admin = await login('admin', 'nur-fuer-tests-0815');
  alphaDir = path.join(dir, 'servers', 'alpha');
  betaDir = path.join(dir, 'servers', 'beta');
  for (const [id, name, d] of [['alpha-server-1', 'alpha', alphaDir], ['beta-server-22', 'beta', betaDir]] as const) {
    await fs.mkdir(d, { recursive: true });
    await registry.add({ id, name, game: 'minecraft-paper', executable: 'x', args: [], workingDir: d, ports: [] });
  }
  await fs.writeFile(path.join(alphaDir, 'server.properties'), 'motd=Hallo');
  await fs.writeFile(path.join(betaDir, 'geheim.txt'), 'nur beta');
  await fs.writeFile(path.join(dir, 'ausserhalb.txt'), 'nicht erreichbar');
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('SFTP: Anmeldung', () => {
  it('der Fingerabdruck ist stabil und gehört zum Schlüssel (Host-Schlüssel bleibt über Neustarts)', async () => {
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const s = await connect('admin', 'nur-fuer-tests-0815'); // hostVerifier prueft den Fingerabdruck
    s.close();
    expect((await fs.stat(path.join(dir, 'sftp_host_key.pem'))).isFile()).toBe(true);
  });

  it('falsches Passwort und unbekannter Benutzer kommen nicht hinein', async () => {
    await expect(connect('admin', 'falsch')).rejects.toThrow();
    await expect(connect('gibtsnicht', 'egal')).rejects.toThrow();
    // Schlüssel-Anmeldung gibt es nicht
    await expect(connect('admin', '')).rejects.toThrow();
  });

  it('der Administrator sieht alle Server mit ihrer Kurzkennung und kann sie öffnen', async () => {
    await withSession('admin', 'nur-fuer-tests-0815', async (o) => {
      expect(await o.list('/')).toEqual(['alpha-se', 'beta-ser']);
      expect(await o.list('/alpha-se')).toEqual(['server.properties']);
      // Auch mit dem Namen des Servers
      expect(await o.read('/alpha/server.properties')).toBe('motd=Hallo');
    });
  });

  it('"benutzer.kurzid" sperrt die Verbindung in diesen einen Server', async () => {
    await withSession('admin.alpha-se', 'nur-fuer-tests-0815', async (o) => {
      expect(await o.list('/')).toEqual(['server.properties']);
      expect(await o.read('/server.properties')).toBe('motd=Hallo');
      // der andere Server ist nicht einmal sichtbar
      await expect(o.read('/beta-ser/geheim.txt')).rejects.toThrow();
      await expect(o.list('/beta-ser')).rejects.toThrow();
    });
    // Ein Server, den es nicht gibt: schon die Anmeldung wird abgewiesen
    await expect(connect('admin.gibtsnicht', 'nur-fuer-tests-0815')).rejects.toThrow();
  });
});

describe('SFTP: Dateien', () => {
  it('der Administrator legt Dateien und Ordner an, benennt um, liest und löscht', async () => {
    await withSession('admin.alpha-se', 'nur-fuer-tests-0815', async (o) => {
      await o.mkdir('/plugins');
      await o.write('/plugins/a.txt', 'Inhalt A');
      expect(await fs.readFile(path.join(alphaDir, 'plugins', 'a.txt'), 'utf8')).toBe('Inhalt A');
      expect((await o.stat('/plugins/a.txt')).size).toBe(8);
      expect((await o.stat('/plugins')).isDirectory()).toBe(true);
      await o.rename('/plugins/a.txt', '/plugins/b.txt');
      expect(await o.list('/plugins')).toEqual(['b.txt']);
      expect(await o.read('/plugins/b.txt')).toBe('Inhalt A');
      await o.unlink('/plugins/b.txt');
      await o.rmdir('/plugins');
      expect(await o.list('/')).toEqual(['server.properties']);
      await expect(o.read('/plugins/b.txt')).rejects.toThrow();
    });
  });

  it('große Dateien gehen in Stücken durch', async () => {
    const big = 'x'.repeat(300_000) + 'ENDE';
    await withSession('admin.alpha-se', 'nur-fuer-tests-0815', async (o) => {
      await o.write('/gross.bin', big);
      expect((await o.stat('/gross.bin')).size).toBe(big.length);
      expect(await o.read('/gross.bin')).toBe(big);
      await o.unlink('/gross.bin');
    });
  });

  it('nichts führt aus dem Server-Ordner heraus - weder Schreiben noch Lesen noch Löschen', async () => {
    await withSession('admin.alpha-se', 'nur-fuer-tests-0815', async (o) => {
      for (const evil of ['/../ausserhalb.txt', '/../../ausserhalb.txt', '/..\\ausserhalb.txt', '/../beta/geheim.txt', 'C:\\Windows\\win.ini', '/a/../../ausserhalb.txt']) {
        await expect(o.read(evil), `lesen ${evil}`).rejects.toThrow();
        await expect(o.write(evil, 'boese'), `schreiben ${evil}`).rejects.toThrow();
        await expect(o.unlink(evil), `loeschen ${evil}`).rejects.toThrow();
        await expect(o.rename('/server.properties', evil), `umbenennen ${evil}`).rejects.toThrow();
      }
      // Den Server-Ordner selbst darf man weder löschen noch umbenennen
      await expect(o.rmdir('/')).rejects.toThrow();
      await expect(o.rename('/', '/x')).rejects.toThrow();
      await expect(o.rename('/server.properties', '/')).rejects.toThrow();
    });
    expect(await fs.readFile(path.join(dir, 'ausserhalb.txt'), 'utf8')).toBe('nicht erreichbar');
    expect(await fs.readFile(path.join(betaDir, 'geheim.txt'), 'utf8')).toBe('nur beta');
    expect(await fs.readdir(alphaDir)).toEqual(['server.properties']);
  });

  it('ein Link, der aus dem Ordner zeigt, führt nirgendwohin', async () => {
    const link = path.join(alphaDir, 'zeiger');
    try {
      await fs.symlink(dir, link, 'junction');
    } catch {
      return; // ohne Recht zum Anlegen von Links nicht pruefbar
    }
    try {
      await withSession('admin.alpha-se', 'nur-fuer-tests-0815', async (o) => {
        await expect(o.list('/zeiger')).rejects.toThrow();
        await expect(o.read('/zeiger/ausserhalb.txt')).rejects.toThrow();
        await expect(o.write('/zeiger/neu.txt', 'x')).rejects.toThrow();
      });
      await expect(fs.stat(path.join(dir, 'neu.txt'))).rejects.toThrow();
    } finally {
      await fs.rm(link, { force: true, recursive: false }).catch(() => {});
    }
  });

  it('Windows-Sondernamen werden abgelehnt (Geräte, Alternative Datenströme)', async () => {
    if (process.platform !== 'win32') return;
    await withSession('admin.alpha-se', 'nur-fuer-tests-0815', async (o) => {
      for (const name of ['/CON', '/nul.txt', '/a.txt:versteckt', '/ende.']) await expect(o.write(name, 'x'), name).rejects.toThrow();
    });
  });
});

describe('SFTP: Rechte', () => {
  it('ein Besitzer sieht nur seine Server und darf auf dem nativen Treiber nur lesen', async () => {
    const owner = await makeUser('sftp-besitzer');
    expect((await call('PUT', `/api/v1/admin/users/${owner.id}/servers/alpha-server-1`, admin, { isOwner: true })).statusCode).toBe(200);
    await withSession('sftp-besitzer', PW, async (o) => {
      expect(await o.list('/')).toEqual(['alpha-se']);
      expect(await o.read('/alpha-se/server.properties')).toBe('motd=Hallo');
      await expect(o.write('/alpha-se/start.bat', 'calc.exe')).rejects.toThrow(/permission|denied/i);
      await expect(o.mkdir('/alpha-se/neu')).rejects.toThrow();
      await expect(o.write('/alpha-se/server.properties', 'ueberschrieben')).rejects.toThrow();
      await expect(o.read('/beta-ser/geheim.txt')).rejects.toThrow();
    });
    expect(await fs.readFile(path.join(alphaDir, 'server.properties'), 'utf8')).toBe('motd=Hallo');
    expect(await fs.readdir(alphaDir)).toEqual(['server.properties']);
    // Wer den Server nicht besitzt, kann ihn auch nicht per Kurzkennung wählen
    await expect(connect('sftp-besitzer.beta-ser', PW)).rejects.toThrow();
  });

  it('ein Benutzer ohne Server sieht eine leere Übersicht', async () => {
    await makeUser('sftp-leer');
    await withSession('sftp-leer', PW, async (o) => expect(await o.list('/')).toEqual([]));
  });

  it('ein Besitzer darf löschen (das ist kein Programmcode), aber nicht schreiben', async () => {
    const helper = await makeUser('sftp-loescher');
    await call('PUT', `/api/v1/admin/users/${helper.id}/servers/alpha-server-1`, admin, { isOwner: true });
    await fs.writeFile(path.join(alphaDir, 'weg.txt'), 'x');
    await withSession('sftp-loescher', PW, async (o) => {
      await o.unlink('/alpha-se/weg.txt'); // Besitzer: file.delete ist erlaubt (kein Programmcode)
    });
    await expect(fs.stat(path.join(alphaDir, 'weg.txt'))).rejects.toThrow();
  });

  it('wer gesperrt wird, verliert den Zugriff sofort - auch in einer offenen Verbindung', async () => {
    const u = await makeUser('sftp-gesperrt');
    await call('PUT', `/api/v1/admin/users/${u.id}/servers/alpha-server-1`, admin, { isOwner: true });
    await withSession('sftp-gesperrt', PW, async (o) => {
      expect(await o.list('/')).toEqual(['alpha-se']);
      expect((await call('PATCH', `/api/v1/admin/users/${u.id}`, admin, { suspended: true })).statusCode).toBe(200);
      await expect(o.list('/alpha-se')).rejects.toThrow();
      await expect(o.read('/alpha-se/server.properties')).rejects.toThrow();
    });
    await expect(connect('sftp-gesperrt', PW)).rejects.toThrow();
  });

  it('Audit-Protokoll: Anmeldung und Schreiben stehen drin, Passwörter nicht', async () => {
    const res = await call('GET', '/api/v1/admin/audit?limit=200', admin);
    const text = res.body;
    expect(text).toContain('sftp.login');
    expect(text).toContain('sftp.write');
    expect(text).not.toContain('nur-fuer-tests-0815');
    expect(text).not.toContain(PW);
  });
});

describe('SFTP: eigene Passwörter und Zwei-Faktor', () => {
  it('SFTP-Passwörter: anlegen (einmal sichtbar), listen, benutzen, löschen', async () => {
    const u = await makeUser('sftp-pw');
    await call('PUT', `/api/v1/admin/users/${u.id}/servers/alpha-server-1`, admin, { isOwner: true });
    expect((await call('GET', '/api/v1/auth/sftp-passwords', u.h)).json()).toEqual({ passwords: [] });
    const made = (await call('POST', '/api/v1/auth/sftp-passwords', u.h, { label: 'Laptop' })).json();
    expect(made.secret).toMatch(/^([a-z0-9]{6}-){3}[a-z0-9]{6}$/);
    expect(made.password).toMatchObject({ label: 'Laptop', lastUsedAt: null });
    const list = await call('GET', '/api/v1/auth/sftp-passwords', u.h);
    expect(list.body).not.toContain(made.secret);
    expect(list.json().passwords).toHaveLength(1);
    await withSession('sftp-pw', made.secret, async (o) => expect(await o.list('/')).toEqual(['alpha-se']));
    expect((await call('GET', '/api/v1/auth/sftp-passwords', u.h)).json().passwords[0].lastUsedAt).not.toBeNull();
    // Ohne Zwei-Faktor geht das Kontopasswort weiterhin
    await withSession('sftp-pw', PW, async (o) => expect(await o.list('/')).toEqual(['alpha-se']));
    expect((await call('DELETE', `/api/v1/auth/sftp-passwords/${made.password.id}`, u.h)).json()).toEqual({ ok: true });
    expect((await call('DELETE', `/api/v1/auth/sftp-passwords/${made.password.id}`, u.h)).statusCode).toBe(404);
    await expect(connect('sftp-pw', made.secret)).rejects.toThrow();
    // Bezeichnung ist Pflicht; das Master-Token hat kein Konto; ein anderer Benutzer sieht fremde nicht
    expect((await call('POST', '/api/v1/auth/sftp-passwords', u.h, { label: '' })).statusCode).toBe(400);
    expect((await call('GET', '/api/v1/auth/sftp-passwords', { authorization: 'Bearer test-token-0123456789abcdefghij' })).statusCode).toBe(403);
  });

  it('höchstens zehn Passwörter je Konto', async () => {
    const u = await makeUser('sftp-viele');
    for (let i = 0; i < 10; i++) expect((await call('POST', '/api/v1/auth/sftp-passwords', u.h, { label: `p${i}` })).statusCode).toBe(200);
    expect((await call('POST', '/api/v1/auth/sftp-passwords', u.h, { label: 'zu viel' })).statusCode).toBe(400);
  });

  it('mit Zwei-Faktor gilt NUR ein SFTP-Passwort - das Kontopasswort ginge am Code vorbei', async () => {
    const u = await makeUser('sftp-2fa');
    await call('PUT', `/api/v1/admin/users/${u.id}/servers/alpha-server-1`, admin, { isOwner: true });
    const setup = (await call('POST', '/api/v1/auth/totp/setup', u.h)).json();
    const enabled = await call('POST', '/api/v1/auth/totp/enable', u.h, { code: codeAt(setup.secret, currentStep()) });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const made = (await call('POST', '/api/v1/auth/sftp-passwords', u.h, { label: 'WinSCP' })).json();
    await expect(connect('sftp-2fa', PW)).rejects.toThrow();
    await withSession('sftp-2fa', made.secret, async (o) => expect(await o.list('/')).toEqual(['alpha-se']));
  });
});

describe('SFTP: Schalter und Sperre', () => {
  it('die Oberfläche erfährt Port und Funktion', async () => {
    const about = (await call('GET', '/api/v1/about', admin)).json();
    expect(about.features).toContain('sftp');
    expect(about.sftp.port).toBeTypeOf('number');
  });

  it('zu viele Fehlversuche sperren die Herkunft - auch für das richtige Passwort', async () => {
    for (let i = 0; i < 6; i++) await connect('admin', `falsch-${i}`).catch(() => {});
    await expect(connect('admin', 'nur-fuer-tests-0815')).rejects.toThrow();
  });
});
