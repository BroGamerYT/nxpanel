import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib, { gzipSync } from 'node:zlib';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { extractZip, extractTar, extractArchive, createZip } = await import('../src/files/archive.js');

interface ZEntry {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  flags?: number;
  madeBy?: number;
  extAttr?: number;
  crc?: number;
  size?: number;
}

/** Ein Zip von Hand - damit auch kaputte und boesartige Archive moeglich sind. */
function buildZip(entries: ZEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const crc = e.crc ?? zlib.crc32(data);
    const size = e.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(e.madeBy ?? 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(e.flags ?? 0x800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE((e.extAttr ?? 0) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, name]));
    const chunk = Buffer.concat([local, name, body]);
    parts.push(chunk);
    offset += chunk.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

interface TEntry {
  name: string;
  data?: string;
  type?: string;
  link?: string;
}

/** Ein Tar von Hand (ustar). */
function buildTar(entries: TEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name.slice(0, 100), 0, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    if (e.link) h.write(e.link, 157, 'utf8');
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

let tmp: string;
let n = 0;
const fresh = async (): Promise<string> => {
  const d = path.join(tmp, `t${++n}`);
  await fs.mkdir(d, { recursive: true });
  return d;
};
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-arc-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('Zip entpacken', () => {
  it('liest gespeicherte und komprimierte Dateien, Ordner und Umlaute', async () => {
    const dir = await fresh();
    const zip = path.join(dir, 'a.zip');
    await fs.writeFile(zip, buildZip([
      { name: 'ordner/', method: 0 },
      { name: 'ordner/a.txt', data: Buffer.from('Hallo '.repeat(500)) },
      { name: 'roh.txt', data: Buffer.from('roh'), method: 0 },
      { name: 'Größe/ü.txt', data: Buffer.from('ü') },
      { name: 'leer.txt', data: Buffer.alloc(0), method: 0 },
    ]));
    const out = path.join(dir, 'out');
    await fs.mkdir(out);
    const res = await extractZip(zip, out);
    expect(res).toEqual({ filesCount: 4, skipped: 0 });
    expect(await fs.readFile(path.join(out, 'ordner', 'a.txt'), 'utf8')).toBe('Hallo '.repeat(500));
    expect(await fs.readFile(path.join(out, 'roh.txt'), 'utf8')).toBe('roh');
    expect(await fs.readFile(path.join(out, 'Größe', 'ü.txt'), 'utf8')).toBe('ü');
    expect((await fs.stat(path.join(out, 'leer.txt'))).size).toBe(0);
  });

  it('überspringt Pfad-Ausbrüche, absolute Pfade, Verknüpfungen und verschlüsselte Einträge', async () => {
    const dir = await fresh();
    const zip = path.join(dir, 'evil.zip');
    await fs.writeFile(zip, buildZip([
      { name: '../ausbruch.txt', data: Buffer.from('x') },
      { name: 'a/../../ausbruch2.txt', data: Buffer.from('x') },
      { name: '/abs.txt', data: Buffer.from('x') },
      { name: 'C:\\win.txt', data: Buffer.from('x') },
      { name: 'a\\..\\..\\b.txt', data: Buffer.from('x') },
      { name: 'link', data: Buffer.from('/etc/passwd'), madeBy: 0x031e, extAttr: 0o120777 << 16 },
      { name: 'geheim.txt', data: Buffer.from('x'), flags: 0x801 },
      { name: 'ok.txt', data: Buffer.from('gut') },
    ]));
    const out = path.join(dir, 'ziel');
    await fs.mkdir(out);
    const res = await extractZip(zip, out);
    expect(res.filesCount).toBe(1);
    expect(res.skipped).toBe(7);
    expect(await fs.readdir(out)).toEqual(['ok.txt']);
    expect(await exists(path.join(dir, 'ausbruch.txt'))).toBe(false);
    expect(await exists(path.join(dir, 'ausbruch2.txt'))).toBe(false);
  });

  it('Windows-Namen (Geräte, Datenströme) werden übersprungen', async () => {
    if (process.platform !== 'win32') return;
    const dir = await fresh();
    const zip = path.join(dir, 'win.zip');
    await fs.writeFile(zip, buildZip([{ name: 'nul', data: Buffer.from('x') }, { name: 'a.txt:strom', data: Buffer.from('x') }, { name: 'ok.txt', data: Buffer.from('x') }]));
    const out = path.join(dir, 'o');
    await fs.mkdir(out);
    expect(await extractZip(zip, out)).toEqual({ filesCount: 1, skipped: 2 });
  });

  it('schreibt nicht durch eine vorhandene Verknüpfung nach draußen', async () => {
    const dir = await fresh();
    const outside = path.join(dir, 'draussen');
    const out = path.join(dir, 'ziel');
    await fs.mkdir(outside);
    await fs.mkdir(out);
    try {
      await fs.symlink(outside, path.join(out, 'link'), 'junction');
    } catch {
      return; // keine Verknuepfungen erlaubt
    }
    const zip = path.join(dir, 'l.zip');
    await fs.writeFile(zip, buildZip([{ name: 'link/boese.txt', data: Buffer.from('x') }, { name: 'ok.txt', data: Buffer.from('x') }]));
    const res = await extractZip(zip, out);
    expect(res.filesCount).toBe(1);
    expect(await exists(path.join(outside, 'boese.txt'))).toBe(false);
  });

  it('erkennt beschädigte Einträge (Prüfsumme) und lässt keine halbe Datei zurück', async () => {
    const dir = await fresh();
    const zip = path.join(dir, 'crc.zip');
    await fs.writeFile(zip, buildZip([{ name: 'kaputt.txt', data: Buffer.from('daten'), crc: 123 }]));
    const out = path.join(dir, 'o');
    await fs.mkdir(out);
    await expect(extractZip(zip, out)).rejects.toThrow(/beschädigt/);
    expect(await exists(path.join(out, 'kaputt.txt'))).toBe(false);
  });

  it('Archivbombe: tatsächlich mehr Daten als angegeben wird abgebrochen', async () => {
    const dir = await fresh();
    const zip = path.join(dir, 'bombe.zip');
    await fs.writeFile(zip, buildZip([{ name: 'gross.bin', data: Buffer.alloc(1_000_000, 1), size: 100 }]));
    const out = path.join(dir, 'o');
    await fs.mkdir(out);
    await expect(extractZip(zip, out)).rejects.toThrow(/größer/);
    expect(await exists(path.join(out, 'gross.bin'))).toBe(false);
  });

  it('Grenzen: zu viele Einträge, zu viele Bytes', async () => {
    const dir = await fresh();
    const zip = path.join(dir, 'g.zip');
    await fs.writeFile(zip, buildZip([{ name: 'a', data: Buffer.alloc(600) }, { name: 'b', data: Buffer.alloc(600) }, { name: 'c', data: Buffer.alloc(1) }]));
    const out = path.join(dir, 'o');
    await fs.mkdir(out);
    await expect(extractZip(zip, out, { entries: 2, bytes: 1e9 })).rejects.toThrow(/zu viele/);
    await expect(extractZip(zip, out, { entries: 10, bytes: 1000 })).rejects.toThrow(/zu groß/);
  });

  it('kein Zip: klare Meldung', async () => {
    const dir = await fresh();
    const f = path.join(dir, 'x.zip');
    await fs.writeFile(f, 'das ist kein zip');
    await expect(extractZip(f, dir)).rejects.toThrow(/Zip/);
  });
});

describe('Tar entpacken', () => {
  it('liest .tar und .tar.gz, auch von Hand gebaute', async () => {
    const dir = await fresh();
    const tar = buildTar([{ name: 'ordner/', type: '5' }, { name: 'ordner/a.txt', data: 'Hallo' }, { name: 'b.txt', data: 'x'.repeat(1500) }]);
    await fs.writeFile(path.join(dir, 'a.tar'), tar);
    await fs.writeFile(path.join(dir, 'a.tar.gz'), gzipSync(tar));
    await fs.writeFile(path.join(dir, 'a.tgz'), gzipSync(tar));
    for (const name of ['a.tar', 'a.tar.gz', 'a.tgz']) {
      const out = path.join(dir, `out-${name}`);
      await fs.mkdir(out);
      expect(await extractArchive(path.join(dir, name), out)).toEqual({ filesCount: 2, skipped: 0 });
      expect(await fs.readFile(path.join(out, 'ordner', 'a.txt'), 'utf8')).toBe('Hallo');
      expect((await fs.readFile(path.join(out, 'b.txt'), 'utf8')).length).toBe(1500);
    }
  });

  it('liest ein Archiv, das das System-tar gepackt hat (lange Namen, Ordner)', async () => {
    const dir = await fresh();
    const src = path.join(dir, 'src');
    const longDir = path.join(src, 'sehr'.repeat(30), 'tief');
    await fs.mkdir(longDir, { recursive: true });
    await fs.writeFile(path.join(longDir, 'datei.txt'), 'langer Pfad');
    await fs.writeFile(path.join(src, 'klein.txt'), 'klein');
    const archive = path.join(dir, 'sys.tar.gz');
    const r = spawnSync(process.platform === 'win32' ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-czf', 'sys.tar.gz', '-C', 'src', '.'], { cwd: dir });
    if (r.status !== 0) return; // kein tar vorhanden
    const out = path.join(dir, 'out');
    await fs.mkdir(out);
    const res = await extractTar(archive, out);
    expect(res.filesCount).toBe(2);
    expect(await fs.readFile(path.join(out, 'sehr'.repeat(30), 'tief', 'datei.txt'), 'utf8')).toBe('langer Pfad');
  });

  it('überspringt Ausbrüche, absolute Pfade und Verknüpfungen', async () => {
    const dir = await fresh();
    const tar = buildTar([
      { name: '../ausbruch.txt', data: 'x' },
      { name: '/abs.txt', data: 'x' },
      { name: 'link', type: '2', link: '/etc/passwd' },
      { name: 'hart', type: '1', link: 'ok.txt' },
      { name: 'ok.txt', data: 'gut' },
    ]);
    await fs.writeFile(path.join(dir, 'e.tar'), tar);
    const out = path.join(dir, 'ziel');
    await fs.mkdir(out);
    const res = await extractTar(path.join(dir, 'e.tar'), out);
    expect(res).toEqual({ filesCount: 1, skipped: 4 });
    expect(await fs.readdir(out)).toEqual(['ok.txt']);
    expect(await exists(path.join(dir, 'ausbruch.txt'))).toBe(false);
  });

  it('beschädigtes oder unvollständiges Tar wird gemeldet', async () => {
    const dir = await fresh();
    const tar = buildTar([{ name: 'a.txt', data: 'x'.repeat(5000) }]);
    await fs.writeFile(path.join(dir, 'kurz.tar'), tar.subarray(0, 1500));
    await fs.writeFile(path.join(dir, 'muell.tar'), Buffer.alloc(2048, 7));
    const out = path.join(dir, 'o');
    await fs.mkdir(out);
    await expect(extractTar(path.join(dir, 'kurz.tar'), out)).rejects.toThrow(/unvollständig/);
    await expect(extractTar(path.join(dir, 'muell.tar'), out)).rejects.toThrow(/gültiges Tar/);
    expect(await exists(path.join(out, 'a.txt'))).toBe(false);
  });

  it('unbekannte Formate und .tar.zst werden klar abgelehnt', async () => {
    const dir = await fresh();
    await expect(extractArchive(path.join(dir, 'a.rar'), dir)).rejects.toThrow(/Nicht unterstützt/);
    await expect(extractArchive(path.join(dir, 'a.tar.zst'), dir)).rejects.toThrow(/zst/);
  });
});

describe('Zip packen', () => {
  it('Rundlauf: gepackt und wieder entpackt ist alles gleich; Verknüpfungen und .panel fehlen', async () => {
    const root = await fresh();
    await fs.mkdir(path.join(root, 'welt', 'region'), { recursive: true });
    await fs.mkdir(path.join(root, 'leer'));
    await fs.mkdir(path.join(root, '.panel'));
    await fs.writeFile(path.join(root, 'welt', 'level.dat'), Buffer.alloc(100_000, 3));
    await fs.writeFile(path.join(root, 'welt', 'region', 'r.0.0.mca'), 'region');
    await fs.writeFile(path.join(root, 'notiz.txt'), 'Grüße');
    await fs.writeFile(path.join(root, '.panel', 'geheim'), 'x');

    const res = await createZip(root, ['welt', 'notiz.txt', 'leer', '.panel'], 'sicherung');
    expect(res.path).toBe('sicherung.zip');
    expect(res.size).toBeGreaterThan(0);

    const out = await fresh();
    const back = await extractZip(path.join(root, 'sicherung.zip'), out);
    expect(back.skipped).toBe(0);
    expect(back.filesCount).toBe(3);
    expect((await fs.readFile(path.join(out, 'welt', 'level.dat'))).equals(Buffer.alloc(100_000, 3))).toBe(true);
    expect(await fs.readFile(path.join(out, 'notiz.txt'), 'utf8')).toBe('Grüße');
    expect(await exists(path.join(out, 'leer'))).toBe(true);
    expect(await exists(path.join(out, '.panel'))).toBe(false);
  });

  it('packt das Archiv nicht in sich selbst und lässt keine .part-Datei liegen', async () => {
    const root = await fresh();
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
    const res = await createZip(root, ['.'], 'alles.zip');
    expect(res.path).toBe('alles.zip');
    expect((await fs.readdir(root)).sort()).toEqual(['a.txt', 'alles.zip']);
    const out = await fresh();
    const back = await extractZip(path.join(root, 'alles.zip'), out);
    expect(await exists(path.join(out, path.basename(root), 'alles.zip'))).toBe(false);
    expect(back.filesCount).toBe(1);
  });

  it('bestehendes Ziel, nichts zu packen, Pfad außerhalb', async () => {
    const root = await fresh();
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
    await createZip(root, ['a.txt'], 'x.zip');
    await expect(createZip(root, ['a.txt'], 'x.zip')).rejects.toThrow(/existiert bereits/);
    await expect(createZip(root, ['gibt-es-nicht'], 'y.zip')).rejects.toThrow(/nichts zu packen/i);
    await expect(createZip(root, ['../'], 'z.zip')).rejects.toThrow();
    await expect(createZip(root, ['a.txt'], '../draussen.zip')).rejects.toThrow();
  });
});

describe('Datei-Routen', () => {
  let server: Awaited<ReturnType<typeof createCoreServer>>;
  let registry: InstanceType<typeof ServerRegistry>;
  let driver: InstanceType<typeof MockDriver>;
  let dataDir: string;
  let auth: Record<string, string>;
  const json = { 'content-type': 'application/json' };
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers = auth) =>
    server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-arc-routes-'));
    registry = await ServerRegistry.open(dataDir);
    driver = new MockDriver();
    await driver.initialize();
    server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
    const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
    auth = { authorization: `Bearer ${login.json().accessToken}` };
    for (const id of ['ar-1', 'ar-2']) {
      const dir = path.join(dataDir, 'servers', id);
      await fs.mkdir(dir, { recursive: true });
      const config = { id, name: id, game: 'x', executable: 'x', args: [], workingDir: dir, ports: [] };
      await registry.add(config);
      await driver.registerServer(config);
    }
    await fs.writeFile(path.join(dataDir, 'servers', 'ar-1', 'server.properties'), 'motd=alt\n');
  });
  afterAll(async () => {
    await server.close();
    registry.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('Recht file.archive ist sichtbar; ohne Anmeldung 401', async () => {
    expect(JSON.stringify((await call('GET', '/api/v1/servers/ar-1')).json())).toContain('file.archive');
    expect((await call('POST', '/api/v1/servers/ar-1/files/compress', { paths: ['a'], destination: 'x' }, {})).statusCode).toBe(401);
  });

  it('packen und entpacken über die Routen', async () => {
    const put = (p: string, content: string) => call('PUT', '/api/v1/servers/ar-1/files/content', { path: p, content });
    expect((await put('mods/a.txt', 'eins')).statusCode).toBe(200);
    expect((await put('mods/b.txt', 'zwei')).statusCode).toBe(200);
    const packed = await call('POST', '/api/v1/servers/ar-1/files/compress', { paths: ['mods'], destination: 'mods-sicherung' });
    expect(packed.statusCode).toBe(200);
    expect(packed.json()).toMatchObject({ ok: true, path: 'mods-sicherung.zip' });
    expect((await call('POST', '/api/v1/servers/ar-1/files/compress', { paths: ['mods'], destination: 'mods-sicherung' })).statusCode).toBe(409);

    const unpacked = await call('POST', '/api/v1/servers/ar-1/files/decompress', { path: 'mods-sicherung.zip', destination: 'entpackt' });
    expect(unpacked.statusCode).toBe(200);
    expect(unpacked.json()).toMatchObject({ ok: true, filesCount: 2, skipped: 0 });
    expect(await fs.readFile(path.join(dataDir, 'servers', 'ar-1', 'entpackt', 'mods', 'a.txt'), 'utf8')).toBe('eins');
  });

  it('Fehlerfälle: fehlendes Archiv, falsches Format, Pfad nach draußen, unbekannter Server', async () => {
    const dec = (body: object, id = 'ar-1') => call('POST', `/api/v1/servers/${id}/files/decompress`, body);
    expect((await dec({ path: 'gibt-es-nicht.zip' })).statusCode).toBe(404);
    await fs.writeFile(path.join(dataDir, 'servers', 'ar-1', 'x.rar'), 'x');
    expect((await dec({ path: 'x.rar' })).statusCode).toBe(400);
    expect((await dec({ path: '../ar-2/server.properties' })).statusCode).toBe(400);
    expect((await dec({ path: 'mods-sicherung.zip', destination: '../ar-2' })).statusCode).toBe(400);
    expect((await dec({ path: 'x.zip' }, 'gibt-es-nicht')).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/servers/ar-1/files/compress', { paths: [], destination: 'x' })).statusCode).toBe(400);
  });

  it('Versionsverlauf: jedes Speichern im Editor wird festgehalten, Rollback stellt her', async () => {
    const put = (content: string) => call('PUT', '/api/v1/servers/ar-1/files/content', { path: 'server.properties', content });
    await put('motd=eins\n');
    await put('motd=zwei\n');
    const list = (await call('GET', '/api/v1/servers/ar-1/files/revisions?path=server.properties')).json();
    expect(list.ok).toBe(true);
    expect(list.revisions).toHaveLength(2);
    expect(list.revisions[0]).toMatchObject({ change_summary: 'Im Editor gespeichert', author_name: 'admin', bytes: 10 });
    expect(list.revisions[0].content).toBeUndefined(); // die Liste bringt keinen Inhalt mit

    const first = list.revisions[1].id as string;
    const detail = (await call('GET', `/api/v1/servers/ar-1/files/revisions/${first}`)).json();
    expect(detail.revision.content).toBe('motd=eins\n');

    const rb = await call('POST', `/api/v1/servers/ar-1/files/revisions/${first}/rollback`);
    expect(rb.json()).toMatchObject({ ok: true, path: 'server.properties', restoredBytes: 10 });
    expect(await fs.readFile(path.join(dataDir, 'servers', 'ar-1', 'server.properties'), 'utf8')).toBe('motd=eins\n');
    const after = (await call('GET', '/api/v1/servers/ar-1/files/revisions?path=server.properties')).json().revisions;
    expect(after.length).toBe(4); // + Stand vor dem Rollback + der Rollback selbst
    expect(after.some((r: any) => /vor Rollback/.test(r.change_summary))).toBe(true);
  });

  it('Versionen gehören zum Server und zur Datei; höchstens 25 je Datei', async () => {
    const list = (await call('GET', '/api/v1/servers/ar-1/files/revisions?path=server.properties')).json().revisions;
    const id = list[0].id as string;
    expect((await call('GET', `/api/v1/servers/ar-2/files/revisions/${id}`)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/servers/ar-2/files/revisions/${id}/rollback`)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/servers/ar-2/files/revisions?path=server.properties')).json().revisions).toEqual([]);
    expect((await call('GET', '/api/v1/servers/ar-1/files/revisions')).statusCode).toBe(400);

    for (let i = 0; i < 30; i++) await call('PUT', '/api/v1/servers/ar-1/files/content', { path: 'viel.txt', content: `stand ${i}` });
    const many = (await call('GET', '/api/v1/servers/ar-1/files/revisions?path=viel.txt')).json().revisions;
    expect(many).toHaveLength(25);
    expect(many[0].bytes).toBe('stand 29'.length); // die neuesten bleiben
  });
});
