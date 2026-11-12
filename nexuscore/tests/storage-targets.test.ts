import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { isPrivateAddress, assertPublicHost, parseTargetConfig, StorageTargetError } = await import('../src/store/storage-targets.js');

const json = { 'content-type': 'application/json' };
const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij', ...json };
const PW = 'ein-sicheres-passwort-1';
const BOX_PW = 'box-passwort-geheim-4711';
const S3_SECRET = 'wJalrXUtnFEMI-geheimer-s3-schluessel';

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
const ids: Record<string, string> = {};

type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Headers = MASTER, payload?: unknown) =>
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

// ------------------------------------------------------------ ein winziger SFTP-Server zum Testen

function startBox(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;
  const box = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'box' && ctx.password === BOX_PW ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () =>
      client.on('session', (accept) =>
        accept().on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          sftp.on('OPENDIR', (id: number) => sftp.handle(id, Buffer.from('h')));
          sftp.on('READDIR', (id: number) => sftp.status(id, ssh2.utils.sftp.STATUS_CODE.EOF));
          sftp.on('CLOSE', (id: number) => sftp.status(id, ssh2.utils.sftp.STATUS_CODE.OK));
        }),
      ),
    );
    client.on('error', () => {});
  });
  return new Promise((resolve) =>
    box.listen(port, '127.0.0.1', () => {
      const addr = box.address() as { port: number };
      resolve({ port: addr.port, close: () => new Promise<void>((r) => box.close(() => r())) });
    }),
  );
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-storage-'));
  registry = await ServerRegistry.open(dir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
  for (const [name, serverId] of [['st-owner', 'st-1'], ['st-fremd', 'st-2'], ['st-ohne', 'st-1']] as const) {
    const res = await call('POST', '/api/v1/admin/users', MASTER, { username: name, password: PW });
    ids[name] = res.json().user.id as string;
    void serverId;
  }
  for (const id of ['st-1', 'st-2']) {
    const root = path.join(dir, 'servers', id);
    await fs.mkdir(root, { recursive: true });
    await registry.add({ id, name: id, game: 'x', executable: 'x', args: [], workingDir: root, ports: [] });
  }
  await call('PUT', `/api/v1/admin/users/${ids['st-owner']}/servers/st-1`, MASTER, { isOwner: true });
  await call('PUT', `/api/v1/admin/users/${ids['st-fremd']}/servers/st-2`, MASTER, { isOwner: true });
  await call('PUT', `/api/v1/admin/users/${ids['st-ohne']}/servers/st-1`, MASTER, { permissions: ['control.console'] });
});
afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const sftpBody = (port: number, extra: Record<string, unknown> = {}) => ({ name: `box-${port}-${Math.random().toString(16).slice(2, 6)}`, kind: 'sftp', config: { host: '127.0.0.1', port, username: 'box', password: BOX_PW, ...extra } });

describe('Angaben prüfen (rein)', () => {
  it('trennt Geheimes von Nicht-Geheimem und lehnt Unbrauchbares ab', () => {
    const ok = parseTargetConfig('sftp', { host: 'box.example.org', username: 'u', password: 'p' });
    expect(ok.plain).toEqual({ host: 'box.example.org', username: 'u' });
    expect(ok.secrets).toEqual({ password: 'p' });
    const bad: Array<[Parameters<typeof parseTargetConfig>[0], Record<string, unknown>, RegExp]> = [
      ['sftp', { host: 'b', username: 'u' }, /Passwort oder privater/],
      ['sftp', { host: 'b b', username: 'u', password: 'p' }, /Ungültiger/],
      ['sftp', { host: 'b', username: 'u', password: 'p', unbekannt: 1 }, /unbekannt|Unrecognized/i],
      ['s3', { bucket: 'ab', accessKeyId: 'a', secretAccessKey: 's' }, /bucket/i],
      ['s3', { bucket: 'mein-bucket', accessKeyId: 'a', secretAccessKey: 's', endpoint: 'http://minio.example.org' }, /https/],
      ['local_path', { path: 'relativ/pfad' }, /absolut|vollständig/],
      ['local_path', {}, /path/],
    ];
    for (const [kind, config, re] of bad) expect(() => parseTargetConfig(kind, config), JSON.stringify(config)).toThrow(re);
  });

  it('erkennt Adressen im eigenen Netz', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(a), a).toBe(false);
  });

  it('prüft, wohin eine Adresse zeigt: Name im eigenen Netz, unbekannter Name', async () => {
    const lookup = (map: Record<string, string[]>) => (async (h: string) => (map[h] ?? []).map((address) => ({ address, family: 4 }))) as never;
    await expect(assertPublicHost('privat.example.org', lookup({ 'privat.example.org': ['192.168.0.5'] }))).rejects.toThrow(/Administrator/);
    await expect(assertPublicHost('mix.example.org', lookup({ 'mix.example.org': ['8.8.8.8', '10.0.0.1'] }))).rejects.toThrow(/Administrator/); // ein privater Treffer genügt
    await expect(assertPublicHost('oeffentlich.example.org', lookup({ 'oeffentlich.example.org': ['93.184.216.34'] }))).resolves.toBeUndefined();
    await expect(assertPublicHost('gibtsnicht.example.org', lookup({}))).rejects.toBeInstanceOf(StorageTargetError);
    await expect(assertPublicHost('127.0.0.1')).rejects.toThrow(/Administrator/);
  });
});

describe('Speicherziele eines Servers', () => {
  let owner: Headers;
  beforeAll(async () => {
    owner = await login('st-owner');
  });

  it('der Besitzer legt Ziele an; die Antwort nennt nie ein Passwort oder einen Schlüssel', async () => {
    const sftp = await call('POST', '/api/v1/servers/st-1/storage-targets', owner, sftpBody(2222));
    expect(sftp.statusCode, sftp.body).toBe(201);
    expect(sftp.body).not.toContain(BOX_PW);
    expect(sftp.json().target).toMatchObject({ kind: 'sftp', server_id: 'st-1', secrets: ['password'], config: { host: '127.0.0.1', port: 2222, username: 'box' } });
    expect(sftp.json().target.config.password).toBeUndefined();

    const s3 = await call('POST', '/api/v1/servers/st-1/storage-targets', owner, { name: 'Wolke', kind: 's3', config: { bucket: 'mein-bucket', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: S3_SECRET, region: 'eu-central-1' }, isDefault: true });
    expect(s3.statusCode, s3.body).toBe(201);
    expect(s3.body).not.toContain(S3_SECRET);
    expect(s3.json().target.secrets).toEqual(['secretAccessKey']);

    const list = await call('GET', '/api/v1/servers/st-1/storage-targets', owner);
    expect(list.body).not.toContain(BOX_PW);
    expect(list.body).not.toContain(S3_SECRET);
    const targets = list.json().targets as Array<{ name: string; is_default: boolean }>;
    expect(targets).toHaveLength(2);
    expect(targets[0]!.name).toBe('Wolke'); // der Standard zuerst
    expect(targets[0]!.is_default).toBe(true);
  });

  it('Geheimes liegt nur verschlüsselt in der Datenbank', () => {
    const stored = JSON.stringify(registry.getSetting('storage.targets'));
    expect(stored).not.toContain(BOX_PW);
    expect(stored).not.toContain(S3_SECRET);
    const raw = [...Array(1)].map(() => JSON.stringify(registry.getSetting(`secret.storage.${(registry.getSetting<Array<{ id: string; kind: string }>>('storage.targets') ?? []).find((t) => t.kind === 's3')!.id}.secretaccesskey`)));
    expect(raw[0]).toMatch(/"v":1/);
    expect(raw[0]).not.toContain(S3_SECRET);
  });

  it('Rechte: wer kein Backup anlegen darf, kommt nicht heran; jeder Server nur an das Seine; ein lokaler Pfad nur für Administratoren', async () => {
    const without = await login('st-ohne');
    const stranger = await login('st-fremd');
    expect((await call('GET', '/api/v1/servers/st-1/storage-targets', without)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/servers/st-1/storage-targets', without, sftpBody(2222))).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/servers/st-1/storage-targets', stranger)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/servers/st-1/storage-targets', {})).statusCode).toBe(401);
    // st-2 sieht die Ziele von st-1 nicht
    expect((await call('GET', '/api/v1/servers/st-2/storage-targets', stranger)).json().targets).toEqual([]);

    const local = await call('POST', '/api/v1/servers/st-1/storage-targets', owner, { name: 'Lokal', kind: 'local_path', config: { path: os.tmpdir() } });
    expect(local.statusCode).toBe(403);
    expect((await call('POST', '/api/v1/servers/st-1/storage-targets', MASTER, { name: 'Lokal', kind: 'local_path', config: { path: os.tmpdir() } })).statusCode).toBe(201);
  });

  it('abgelehnt: ungültige Angaben, doppelter Name, unbekannte Art', async () => {
    expect((await call('POST', '/api/v1/servers/st-1/storage-targets', owner, { name: 'X', kind: 's3', config: { bucket: 'zu' } })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/servers/st-1/storage-targets', owner, { name: 'X', kind: 'ftp', config: {} })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/servers/st-1/storage-targets', owner, { kind: 'sftp', config: {} })).statusCode).toBe(400);
    const dup = await call('POST', '/api/v1/servers/st-1/storage-targets', owner, { name: 'wolke', kind: 's3', config: { bucket: 'anderer-bucket', accessKeyId: 'a', secretAccessKey: 's' } });
    expect(dup.statusCode).toBe(409);
  });

  it('Standard: höchstens einer je Server', async () => {
    const before = (await call('GET', '/api/v1/servers/st-1/storage-targets', owner)).json().targets as Array<{ is_default: boolean }>;
    expect(before.filter((t) => t.is_default)).toHaveLength(1);
    await call('POST', '/api/v1/servers/st-1/storage-targets', owner, { name: 'Neuer Standard', kind: 's3', config: { bucket: 'standard-bucket', accessKeyId: 'a', secretAccessKey: 's' }, isDefault: true });
    const after = (await call('GET', '/api/v1/servers/st-1/storage-targets', owner)).json().targets as Array<{ name: string; is_default: boolean }>;
    expect(after.filter((t) => t.is_default).map((t) => t.name)).toEqual(['Neuer Standard']);
  });
});

describe('Verbindungstest', () => {
  let owner: Headers;
  beforeAll(async () => {
    owner = await login('st-owner');
  });

  it('lokaler Pfad: beschreibbar oder nicht - ohne Reste', async () => {
    const good = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-storage-local-'));
    const a = await call('POST', '/api/v1/servers/st-2/storage-targets', MASTER, { name: 'Lokal ok', kind: 'local_path', config: { path: good } });
    const res = await call('POST', `/api/v1/servers/st-2/storage-targets/${a.json().target.id}/test`, MASTER, {});
    expect(res.json()).toMatchObject({ ok: true });
    expect(await fs.readdir(good)).toEqual([]); // die Testdatei ist wieder weg
    const b = await call('POST', '/api/v1/servers/st-2/storage-targets', MASTER, { name: 'Lokal weg', kind: 'local_path', config: { path: path.join(good, 'gibtsnicht') } });
    expect((await call('POST', `/api/v1/servers/st-2/storage-targets/${b.json().target.id}/test`, MASTER, {})).json().ok).toBe(false);
    await fs.rm(good, { recursive: true, force: true });
  });

  it('S3: der Test sagt ehrlich, dass keine Verbindung aufgebaut wurde', async () => {
    const t = (await call('GET', '/api/v1/servers/st-1/storage-targets', owner)).json().targets.find((x: { kind: string }) => x.kind === 's3');
    const res = (await call('POST', `/api/v1/servers/st-1/storage-targets/${t.id}/test`, owner, {})).json();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('nicht aufgebaut');
  });

  it('SFTP: meldet sich wirklich an (richtig, falsch, kein Server) und merkt sich den Host-Schlüssel', async () => {
    const box = await startBox();
    try {
      const good = (await call('POST', '/api/v1/servers/st-1/storage-targets', MASTER, sftpBody(box.port))).json().target;
      const ok = await call('POST', `/api/v1/servers/st-1/storage-targets/${good.id}/test`, MASTER, {});
      expect(ok.json().ok, ok.body).toBe(true);
      expect(ok.json().message).toMatch(/SHA256:/);
      expect(ok.body).not.toContain(BOX_PW);
      // Noch einmal mit demselben Schlüssel: weiter in Ordnung
      expect((await call('POST', `/api/v1/servers/st-1/storage-targets/${good.id}/test`, MASTER, {})).json().ok).toBe(true);

      const wrong = (await call('POST', '/api/v1/servers/st-1/storage-targets', MASTER, sftpBody(box.port, { password: 'zzz-nicht-das-passwort' }))).json().target;
      const denied = (await call('POST', `/api/v1/servers/st-1/storage-targets/${wrong.id}/test`, MASTER, {})).json();
      expect(denied.ok).toBe(false);
      expect(denied.message).toContain('Anmeldung abgelehnt');
      expect(JSON.stringify(denied)).not.toContain('zzz-nicht-das-passwort');
    } finally {
      await box.close();
    }
    const dead = (await call('POST', '/api/v1/servers/st-1/storage-targets', MASTER, sftpBody(1))).json().target;
    const none = (await call('POST', `/api/v1/servers/st-1/storage-targets/${dead.id}/test`, MASTER, {})).json();
    expect(none.ok).toBe(false);
    expect(none.message).toContain('Keine Verbindung');
  });

  it('wechselt der Host-Schlüssel, wird nicht angemeldet (Schutz vor einem untergeschobenen Rechner)', async () => {
    const first = await startBox();
    const target = (await call('POST', '/api/v1/servers/st-1/storage-targets', MASTER, sftpBody(first.port))).json().target;
    expect((await call('POST', `/api/v1/servers/st-1/storage-targets/${target.id}/test`, MASTER, {})).json().ok).toBe(true);
    await first.close();
    const second = await startBox(first.port); // gleicher Port, anderer Schlüssel
    try {
      const res = (await call('POST', `/api/v1/servers/st-1/storage-targets/${target.id}/test`, MASTER, {})).json();
      expect(res.ok).toBe(false);
      expect(res.message).toContain('Host-Schlüssel hat sich geändert');
    } finally {
      await second.close();
    }
  });

  it('Nicht-Administratoren erreichen mit dem Test nichts im eigenen Netz', async () => {
    const box = await startBox();
    try {
      const t = (await call('POST', '/api/v1/servers/st-1/storage-targets', owner, sftpBody(box.port))).json().target;
      const res = await call('POST', `/api/v1/servers/st-1/storage-targets/${t.id}/test`, owner, {});
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('Administrator');
    } finally {
      await box.close();
    }
  });

  it('ein Ziel eines anderen Servers lässt sich nicht testen', async () => {
    const t = (await call('GET', '/api/v1/servers/st-1/storage-targets', MASTER)).json().targets[0];
    expect((await call('POST', `/api/v1/servers/st-2/storage-targets/${t.id}/test`, MASTER, {})).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/servers/st-1/storage-targets/gibtsnicht/test', MASTER, {})).statusCode).toBe(404);
  });
});

describe('Löschen und globale Ziele', () => {
  it('Löschen entfernt auch die Zugangsdaten; ein Ziel eines anderen Servers lässt sich nicht löschen', async () => {
    const owner = await login('st-owner');
    const t = (await call('POST', '/api/v1/servers/st-1/storage-targets', owner, { name: 'Zum Löschen', kind: 's3', config: { bucket: 'loesch-bucket', accessKeyId: 'a', secretAccessKey: 'geheim-loeschen-123' } })).json().target;
    expect(registry.getSetting(`secret.storage.${t.id}.secretaccesskey`)).toBeDefined();
    expect((await call('DELETE', `/api/v1/servers/st-2/storage-targets/${t.id}`, MASTER)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/servers/st-1/storage-targets/${t.id}`, owner)).json()).toEqual({ ok: true });
    expect(registry.getSetting(`secret.storage.${t.id}.secretaccesskey`)).toBeUndefined();
    expect((await call('DELETE', `/api/v1/servers/st-1/storage-targets/${t.id}`, owner)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/admin/audit?limit=100')).body).toContain('storage_target.delete');
  });

  it('globale Ziele: nur Administratoren; Server sehen sie, löschen sie aber nicht', async () => {
    const owner = await login('st-owner');
    expect((await call('GET', '/api/v1/admin/storage-targets', owner)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/admin/storage-targets', owner, { name: 'G', kind: 's3', config: { bucket: 'global-bucket', accessKeyId: 'a', secretAccessKey: 's' } })).statusCode).toBe(403);
    const g = await call('POST', '/api/v1/admin/storage-targets', MASTER, { name: 'Global', kind: 's3', config: { bucket: 'global-bucket', accessKeyId: 'a', secretAccessKey: 'geheim-global-123' } });
    expect(g.statusCode, g.body).toBe(201);
    expect(g.json().target.server_id).toBeNull();
    expect((await call('GET', '/api/v1/admin/storage-targets', MASTER)).json().targets.map((t: { name: string }) => t.name)).toEqual(['Global']);
    expect((await call('GET', '/api/v1/servers/st-1/storage-targets', owner)).json().targets.map((t: { name: string }) => t.name)).toContain('Global');
    expect((await call('DELETE', `/api/v1/servers/st-1/storage-targets/${g.json().target.id}`, owner)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/admin/storage-targets/${g.json().target.id}`, MASTER)).json()).toEqual({ ok: true });
  });

  it('wird ein Server gelöscht, gehen seine Ziele und deren Zugangsdaten mit', async () => {
    const root = path.join(dir, 'servers', 'st-3');
    await fs.mkdir(root, { recursive: true });
    await registry.add({ id: 'st-3', name: 'Weg', game: 'x', executable: 'x', args: [], workingDir: root, ports: [] });
    const t = (await call('POST', '/api/v1/servers/st-3/storage-targets', MASTER, { name: 'Mit Server', kind: 's3', config: { bucket: 'server-bucket', accessKeyId: 'a', secretAccessKey: 'geheim-server-123' } })).json().target;
    expect((await call('DELETE', '/api/v1/servers/st-3', MASTER, undefined)).statusCode).toBeLessThan(300);
    expect(registry.getSetting(`secret.storage.${t.id}.secretaccesskey`)).toBeUndefined();
    expect((registry.getSetting<Array<{ serverId: string }>>('storage.targets') ?? []).some((x) => x.serverId === 'st-3')).toBe(false);
  });
});
