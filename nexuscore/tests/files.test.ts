import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';
// Klein, damit sich der Schutz vor zu grossen Uploads mit wenig Daten pruefen laesst.
process.env.NEXUSCORE_MAX_UPLOAD_MB = '1';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { assertSafeName, cleanRelative, FileAccessError } = await import('../src/files/files.js');

let server: Awaited<ReturnType<typeof createCoreServer>>;
let driver: InstanceType<typeof MockDriver>;
let registry: InstanceType<typeof ServerRegistry>;
let base: string;
let token: string;
let dataDir: string;
let serverRoot: string;
let outside: string;

const dirOf = (id: string) => path.join(serverRoot, id);

async function addInstance(id: string, workingDir: string): Promise<void> {
  const config = {
    id,
    name: id,
    game: 'test',
    executable: path.join(workingDir, 'x.exe'),
    args: [],
    workingDir,
    ports: [],
  };
  await registry.add(config);
  await driver.registerServer(config);
}

interface Reply {
  status: number;
  json: Record<string, any>;
  headers: Headers;
  body: Buffer;
}

async function call(method: string, url: string, options: { body?: unknown; auth?: boolean; origin?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.auth !== false) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.origin) headers.origin = options.origin;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const body = Buffer.from(await res.arrayBuffer());
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    /* kein JSON, z. B. ein Download */
  }
  return { status: res.status, json, headers: res.headers, body };
}

const files = (id: string) => `/api/v1/servers/${id}/files`;
const q = (p: string) => `?path=${encodeURIComponent(p)}`;

async function upload(id: string, dir: string, filename: string, data: Buffer | string): Promise<Reply> {
  const form = new FormData();
  form.append('file', new Blob([data]), filename);
  const res = await fetch(`${base}${files(id)}/upload${q(dir)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = Buffer.from(await res.arrayBuffer());
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    /* leer */
  }
  return { status: res.status, json, headers: res.headers, body };
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-files-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-files-outside-'));
  serverRoot = path.join(dataDir, 'servers');
  await fs.mkdir(serverRoot, { recursive: true });
  await fs.writeFile(path.join(outside, 'geheim.txt'), 'nicht fuer dich');

  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
  base = (await server.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'nur-fuer-tests-0815' }),
  });
  token = ((await login.json()) as { accessToken: string }).accessToken;

  // Ein Server im eigenen Ordner, einer ausserhalb, einer im Server-Verzeichnis selbst.
  await fs.mkdir(path.join(dirOf('fs-1'), 'mods'), { recursive: true });
  await fs.writeFile(path.join(dirOf('fs-1'), 'server.properties'), 'motd=Hallo\n');
  await fs.writeFile(path.join(dirOf('fs-1'), 'readme.txt'), 'Hallo Welt');
  await addInstance('fs-1', dirOf('fs-1'));
  await addInstance('fs-outside', outside);
  await addInstance('fs-root', serverRoot);
});

afterAll(async () => {
  await server.close();
  await driver.shutdown();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
});

describe('Dateien - Auflisten, Lesen, Schreiben', () => {
  it('listet Ordner zuerst und liefert dieselben Felder wie das Panel', async () => {
    const res = await call('GET', files('fs-1'));
    expect(res.status).toBe(200);
    expect(res.json.current).toBe('');
    const names = res.json.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(['mods', 'readme.txt', 'server.properties']);
    expect(res.json.entries[0]).toMatchObject({
      name: 'mods',
      path: 'mods',
      is_directory: true,
      is_symlink: false,
      size: 0,
    });
    expect(res.json.entries[1]).toMatchObject({ is_directory: false, size: 10, path: 'readme.txt' });
    expect(res.json.entries[1].modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.json.entries[1].mode).toMatch(/^[0-7]{3}$/);
  });

  it('liest und schreibt Text, auch mit Umlauten und in neuen Ordnern', async () => {
    const read = await call('GET', `${files('fs-1')}/content${q('readme.txt')}`);
    expect(read.json).toEqual({ path: 'readme.txt', content: 'Hallo Welt', size: 10 });

    const text = 'Grüße aus Köln ✓\nZeile 2\n';
    const write = await call('PUT', `${files('fs-1')}/content`, { body: { path: 'config/neu/test.txt', content: text } });
    expect(write.status).toBe(200);
    expect(write.json).toEqual({ ok: true, path: 'config/neu/test.txt' });
    expect(await fs.readFile(path.join(dirOf('fs-1'), 'config', 'neu', 'test.txt'), 'utf8')).toBe(text);

    const nested = await call('GET', `${files('fs-1')}${q('config/neu')}`);
    expect(nested.json.current).toBe('config/neu');
    expect(nested.json.entries[0].path).toBe('config/neu/test.txt');
  });

  it('speichert grosse Texte (ueber der 1-MB-Grenze fuer normale Anfragen)', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const write = await call('PUT', `${files('fs-1')}/content`, { body: { path: 'gross.txt', content: big } });
    expect(write.status).toBe(200);
    expect((await fs.stat(path.join(dirOf('fs-1'), 'gross.txt'))).size).toBe(big.length);
  });

  it('oeffnet keine Dateien ueber 5 MB im Editor und keine Ordner als Text', async () => {
    await fs.writeFile(path.join(dirOf('fs-1'), 'riesig.bin'), Buffer.alloc(5 * 1024 * 1024 + 10));
    const huge = await call('GET', `${files('fs-1')}/content${q('riesig.bin')}`);
    expect(huge.status).toBe(413);
    expect(huge.json.code).toBe('too_large');

    expect((await call('GET', `${files('fs-1')}/content${q('mods')}`)).status).toBe(400);
    expect((await call('PUT', `${files('fs-1')}/content`, { body: { path: 'mods', content: 'x' } })).status).toBe(400);
  });

  it('meldet fehlende Dateien und falsche Eingaben verstaendlich', async () => {
    expect((await call('GET', `${files('fs-1')}/content${q('gibt-es-nicht.txt')}`)).status).toBe(404);
    expect((await call('GET', `${files('fs-1')}${q('gibt-es-nicht')}`)).status).toBe(404);
    expect((await call('GET', `${files('fs-1')}${q('readme.txt')}`)).status).toBe(400);
    const noPath = await call('GET', `${files('fs-1')}/content`);
    expect(noPath.status).toBe(400);
    expect(noPath.json.error).toMatch(/Pfad/);
    expect((await call('PUT', `${files('fs-1')}/content`, { body: { path: 'a.txt' } })).status).toBe(400);
    expect((await call('GET', `${files('gibt-es-nicht')}`)).status).toBe(404);
  });
});

describe('Dateien - Anlegen, Umbenennen, Loeschen, Herunterladen', () => {
  it('legt Ordner an, benennt um und verschiebt', async () => {
    expect((await call('POST', `${files('fs-1')}/directory`, { body: { path: 'plugins/unter' } })).status).toBe(200);
    expect((await fs.stat(path.join(dirOf('fs-1'), 'plugins', 'unter'))).isDirectory()).toBe(true);

    await fs.writeFile(path.join(dirOf('fs-1'), 'alt.txt'), 'inhalt');
    const rename = await call('POST', `${files('fs-1')}/rename`, { body: { from: 'alt.txt', to: 'plugins/neu.txt' } });
    expect(rename.status).toBe(200);
    expect(await fs.readFile(path.join(dirOf('fs-1'), 'plugins', 'neu.txt'), 'utf8')).toBe('inhalt');
    expect(await exists(path.join(dirOf('fs-1'), 'alt.txt'))).toBe(false);
  });

  it('ueberschreibt beim Umbenennen nichts und verschiebt keinen Ordner in sich selbst', async () => {
    await fs.writeFile(path.join(dirOf('fs-1'), 'a1.txt'), 'A');
    await fs.writeFile(path.join(dirOf('fs-1'), 'a2.txt'), 'B');
    const clash = await call('POST', `${files('fs-1')}/rename`, { body: { from: 'a1.txt', to: 'a2.txt' } });
    expect(clash.status).toBe(409);
    expect(await fs.readFile(path.join(dirOf('fs-1'), 'a2.txt'), 'utf8')).toBe('B');

    expect((await call('POST', `${files('fs-1')}/rename`, { body: { from: 'fehlt.txt', to: 'x.txt' } })).status).toBe(404);
    expect((await call('POST', `${files('fs-1')}/rename`, { body: { from: 'plugins', to: 'plugins/unter/plugins' } })).status).toBe(400);
  });

  it('loescht Dateien und Ordner, aber nie den Ordner des Servers', async () => {
    await fs.mkdir(path.join(dirOf('fs-1'), 'weg', 'tief'), { recursive: true });
    await fs.writeFile(path.join(dirOf('fs-1'), 'weg', 'tief', 'x.txt'), 'x');
    expect((await call('DELETE', files('fs-1'), { body: { path: 'weg' } })).status).toBe(200);
    expect(await exists(path.join(dirOf('fs-1'), 'weg'))).toBe(false);
    // schon weg: kein Fehler
    expect((await call('DELETE', files('fs-1'), { body: { path: 'weg' } })).status).toBe(200);

    for (const root of ['.', './', 'mods/..', 'mods/../']) {
      const res = await call('DELETE', files('fs-1'), { body: { path: root } });
      expect(res.status, root).toBe(400);
    }
    expect(await exists(path.join(dirOf('fs-1'), 'server.properties'))).toBe(true);
  });

  it('laedt Dateien herunter, Ordner nicht', async () => {
    const res = await call('GET', `${files('fs-1')}/download${q('readme.txt')}`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('Hallo Welt');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="readme.txt"');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await call('GET', `${files('fs-1')}/download${q('mods')}`)).status).toBe(400);
    expect((await call('GET', `${files('fs-1')}/download${q('fehlt.txt')}`)).status).toBe(404);
  });

  it('liefert eine leere Versionsliste statt eines Fehlers', async () => {
    const res = await call('GET', `${files('fs-1')}/revisions${q('server.properties')}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, path: 'server.properties', revisions: [] });
  });
});

describe('Dateien - Pfadgrenze', () => {
  const attacks = ['..', '../geheim.txt', '../../etc/passwd', 'mods/../../geheim.txt', '..\\..\\geheim.txt', 'mods\\..\\..\\x'];

  it('lehnt Pfade ausserhalb des Server-Ordners bei jeder Aktion ab', async () => {
    for (const attack of attacks) {
      expect((await call('GET', `${files('fs-1')}${q(attack)}`)).status, `list ${attack}`).toBe(400);
      expect((await call('GET', `${files('fs-1')}/content${q(attack)}`)).status, `read ${attack}`).toBe(400);
      expect((await call('PUT', `${files('fs-1')}/content`, { body: { path: attack, content: 'x' } })).status, `write ${attack}`).toBe(400);
      expect((await call('POST', `${files('fs-1')}/directory`, { body: { path: attack } })).status, `mkdir ${attack}`).toBe(400);
      expect((await call('POST', `${files('fs-1')}/rename`, { body: { from: 'readme.txt', to: attack } })).status, `rename-to ${attack}`).toBe(400);
      expect((await call('POST', `${files('fs-1')}/rename`, { body: { from: attack, to: 'x.txt' } })).status, `rename-from ${attack}`).toBe(400);
      expect((await call('DELETE', files('fs-1'), { body: { path: attack } })).status, `delete ${attack}`).toBe(400);
      expect((await call('GET', `${files('fs-1')}/download${q(attack)}`)).status, `download ${attack}`).toBe(400);
    }
    expect(await fs.readFile(path.join(outside, 'geheim.txt'), 'utf8')).toBe('nicht fuer dich');
    expect((await fs.readdir(outside)).sort()).toEqual(['geheim.txt']);
  });

  it('lehnt absolute Pfade, Laufwerke und Null-Bytes ab', async () => {
    for (const attack of ['C:\\Windows\\win.ini', 'C:/Windows/win.ini', `a${'\0'}b`]) {
      const res = await call('GET', `${files('fs-1')}/content${q(attack)}`);
      expect(res.status, JSON.stringify(attack)).toBe(400);
    }
    // Ein fuehrender Schraegstrich (auch doppelt, wie bei einem Netzwerkpfad) meint den Ordner
    // des Servers, nicht das Wurzelverzeichnis der Platte: das gibt es dort nicht -> 404.
    const res = await call('GET', `${files('fs-1')}/content${q('/readme.txt')}`);
    expect(res.json.content).toBe('Hallo Welt');
    for (const probe of ['/etc/passwd', '\\\\server\\share\\x', '//server/share/x']) {
      expect((await call('GET', `${files('fs-1')}/content${q(probe)}`)).status, probe).toBe(404);
    }
  });

  it('folgt keinem Symlink, der aus dem Server-Ordner hinauszeigt', async () => {
    const link = path.join(dirOf('fs-1'), 'verweis');
    try {
      // 'junction' braucht unter Windows keine Adminrechte; unter Linux ist es ein gewoehnlicher Symlink.
      await fs.symlink(outside, link, 'junction');
    } catch {
      return; // Dateisystem ohne Verweise
    }
    expect((await call('GET', `${files('fs-1')}${q('verweis')}`)).status).toBe(400);
    expect((await call('GET', `${files('fs-1')}/content${q('verweis/geheim.txt')}`)).status).toBe(400);
    expect((await call('GET', `${files('fs-1')}/download${q('verweis/geheim.txt')}`)).status).toBe(400);
    expect((await call('PUT', `${files('fs-1')}/content`, { body: { path: 'verweis/neu.txt', content: 'x' } })).status).toBe(400);
    expect((await call('POST', `${files('fs-1')}/directory`, { body: { path: 'verweis/neu' } })).status).toBe(400);
    expect((await call('POST', `${files('fs-1')}/rename`, { body: { from: 'readme.txt', to: 'verweis/readme.txt' } })).status).toBe(400);
    expect((await call('DELETE', files('fs-1'), { body: { path: 'verweis/geheim.txt' } })).status).toBe(400);
    expect((await upload('fs-1', 'verweis', 'neu.txt', 'x')).status).toBe(400);

    expect((await fs.readdir(outside)).sort()).toEqual(['geheim.txt']);
    expect(await fs.readFile(path.join(outside, 'geheim.txt'), 'utf8')).toBe('nicht fuer dich');
    // Das Auflisten des Ordners zeigt den Verweis, aber er laesst sich nicht oeffnen.
    const list = await call('GET', files('fs-1'));
    expect(list.json.entries.find((e: { name: string }) => e.name === 'verweis')).toMatchObject({ is_symlink: true });
    await fs.rm(link, { recursive: false, force: true }).catch(() => {});
  });

  it('loescht einen Ordner mit einem Verweis nach draussen, ohne dem Verweis zu folgen', async () => {
    // Der gefaehrlichste Fall: kein Zugriff DURCH den Verweis, sondern ein rekursives Loeschen
    // des Ordners, in dem er liegt. Folgt das Loeschen dem Verweis, verschwinden Dateien
    // ausserhalb des Server-Ordners.
    const folder = path.join(dirOf('fs-1'), 'ordner');
    await fs.mkdir(path.join(folder, 'unter'), { recursive: true });
    await fs.writeFile(path.join(folder, 'eigene.txt'), 'x');
    try {
      await fs.symlink(outside, path.join(folder, 'unter', 'verweis'), 'junction');
    } catch {
      return; // Dateisystem ohne Verweise
    }

    const res = await call('DELETE', files('fs-1'), { body: { path: 'ordner' } });
    expect(res.status).toBe(200);
    expect(await exists(folder)).toBe(false);
    // Das Ziel des Verweises ist unberuehrt
    expect(await fs.readFile(path.join(outside, 'geheim.txt'), 'utf8')).toBe('nicht fuer dich');
    expect((await fs.readdir(outside)).sort()).toEqual(['geheim.txt']);
  });

  it('sperrt Server ausserhalb des Server-Verzeichnisses und den Ordner aller Server', async () => {
    for (const id of ['fs-outside', 'fs-root']) {
      const list = await call('GET', files(id));
      expect(list.status, id).toBe(403);
      expect(list.json.code).toBe('forbidden');
      expect((await call('GET', `${files(id)}/content${q('geheim.txt')}`)).status, id).toBe(403);
      expect((await call('PUT', `${files(id)}/content`, { body: { path: 'x.txt', content: 'x' } })).status, id).toBe(403);
      expect((await upload(id, '', 'x.txt', 'x')).status, id).toBe(403);
    }
    expect(await exists(path.join(outside, 'x.txt'))).toBe(false);
    expect(await exists(path.join(serverRoot, 'x.txt'))).toBe(false);
  });

  it('prueft Namen: Steuerzeichen und, fuer Windows, Geraetenamen und Datenstroeme', () => {
    for (const bad of ['', '.', '..', 'a\nb', 'a\u0001b']) {
      expect(() => assertSafeName(bad, 'linux'), JSON.stringify(bad)).toThrow(FileAccessError);
    }
    expect(() => assertSafeName('config.yml', 'linux')).not.toThrow();
    expect(() => assertSafeName('nul', 'linux')).not.toThrow();

    for (const bad of ['nul', 'NUL.txt', 'con', 'COM1', 'lpt9.log', 'a.txt:versteckt', 'datei.', 'name ', 'a?b', 'a*b', 'a|b', 'a<b']) {
      expect(() => assertSafeName(bad, 'win32'), bad).toThrow(FileAccessError);
    }
    for (const good of ['server.jar', 'console.log', 'communication.txt', 'Welt 1', 'a-b_c.d']) {
      expect(() => assertSafeName(good, 'win32'), good).not.toThrow();
    }
    expect(() => cleanRelative('mods/nul/x.jar', 'win32')).toThrow(FileAccessError);
    expect(cleanRelative('/mods\\sub//x.jar', 'win32')).toBe('mods/sub//x.jar');
  });

  it.skipIf(process.platform !== 'win32')('lehnt unter Windows Geraetenamen und Datenstroeme ueber die Schnittstelle ab', async () => {
    for (const bad of ['nul', 'con.txt', 'a.txt:versteckt', 'punkt.']) {
      expect((await call('PUT', `${files('fs-1')}/content`, { body: { path: bad, content: 'x' } })).status, bad).toBe(400);
      expect((await call('POST', `${files('fs-1')}/directory`, { body: { path: bad } })).status, bad).toBe(400);
      expect((await upload('fs-1', '', bad, 'x')).status, bad).toBe(400);
    }
  });
});

describe('Dateien - Hochladen', () => {
  it('speichert eine Datei im gewaehlten Ordner und laesst keine Reste', async () => {
    const res = await upload('fs-1', 'mods', 'mein-plugin.jar', Buffer.from('PK-daten'));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, path: 'mods/mein-plugin.jar' });
    expect((await fs.readFile(path.join(dirOf('fs-1'), 'mods', 'mein-plugin.jar'))).toString()).toBe('PK-daten');
    expect((await fs.readdir(path.join(dirOf('fs-1'), 'mods'))).sort()).toEqual(['mein-plugin.jar']);

    // erneut: ersetzt die Datei
    expect((await upload('fs-1', 'mods', 'mein-plugin.jar', 'neu')).status).toBe(200);
    expect((await fs.readFile(path.join(dirOf('fs-1'), 'mods', 'mein-plugin.jar'))).toString()).toBe('neu');
  });

  it('nimmt aus dem Dateinamen nur den Namen: Pfadteile fuehren nirgendwohin', async () => {
    const first = await upload('fs-1', '', '../../evil.txt', 'x');
    expect(first.status).toBe(200);
    expect(first.json.path).toBe('evil.txt');
    const second = await upload('fs-1', '', '..\\..\\evil2.txt', 'x');
    expect(second.status).toBe(200);
    expect(second.json.path).toBe('evil2.txt');

    expect(await exists(path.join(dirOf('fs-1'), 'evil.txt'))).toBe(true);
    expect(await exists(path.join(dirOf('fs-1'), 'evil2.txt'))).toBe(true);
    expect(await exists(path.join(serverRoot, 'evil.txt'))).toBe(false);
    expect(await exists(path.join(dataDir, 'evil.txt'))).toBe(false);
    expect(await exists(path.join(path.dirname(dataDir), 'evil.txt'))).toBe(false);
  });

  it('lehnt unbrauchbare Namen, Ordner als Ziel und fehlende Dateien ab', async () => {
    expect((await upload('fs-1', '', '..', 'x')).status).toBe(400);
    expect((await upload('fs-1', '', '', 'x')).status).toBe(400);
    const clash = await upload('fs-1', '', 'mods', 'x');
    expect(clash.status).toBe(409);
    expect((await fs.stat(path.join(dirOf('fs-1'), 'mods'))).isDirectory()).toBe(true);
    expect((await upload('fs-1', 'gibt-es-nicht', 'a.txt', 'x')).status).toBe(404);

    const none = await fetch(`${base}${files('fs-1')}/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: new FormData(),
    });
    expect(none.status).toBe(400);
  });

  it('bricht zu grosse Uploads ab und hinterlaesst keine Datei', async () => {
    const before = (await fs.readdir(dirOf('fs-1'))).sort();
    const res = await upload('fs-1', '', 'zu-gross.bin', Buffer.alloc(1024 * 1024 + 4096, 1));
    expect(res.status).toBe(413);
    expect(res.json.code).toBe('too_large');
    expect((await fs.readdir(dirOf('fs-1'))).sort()).toEqual(before);
  });
});

describe('Dateien - Zugriff und Protokoll', () => {
  it('verlangt eine Anmeldung', async () => {
    for (const [method, url] of [
      ['GET', files('fs-1')],
      ['GET', `${files('fs-1')}/content${q('readme.txt')}`],
      ['GET', `${files('fs-1')}/download${q('readme.txt')}`],
    ] as const) {
      expect((await call(method, url, { auth: false })).status, `${method} ${url}`).toBe(401);
    }
    expect((await call('DELETE', files('fs-1'), { auth: false, body: { path: 'readme.txt' } })).status).toBe(401);
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    expect((await fetch(`${base}${files('fs-1')}/upload`, { method: 'POST', body: form })).status).toBe(401);
    expect(await exists(path.join(dirOf('fs-1'), 'x.txt'))).toBe(false);
  });

  it('lehnt schreibende Anfragen aus fremden Webseiten ab', async () => {
    const origin = 'https://boese.example';
    expect((await call('PUT', `${files('fs-1')}/content`, { origin, body: { path: 'x.txt', content: 'x' } })).status).toBe(403);
    expect((await call('DELETE', files('fs-1'), { origin, body: { path: 'readme.txt' } })).status).toBe(403);
    expect((await call('POST', `${files('fs-1')}/rename`, { origin, body: { from: 'readme.txt', to: 'weg.txt' } })).status).toBe(403);

    const form = new FormData();
    form.append('file', new Blob(['x']), 'fremd.txt');
    const upload403 = await fetch(`${base}${files('fs-1')}/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin },
      body: form,
    });
    expect(upload403.status).toBe(403);
    expect(await exists(path.join(dirOf('fs-1'), 'fremd.txt'))).toBe(false);
    expect(await exists(path.join(dirOf('fs-1'), 'readme.txt'))).toBe(true);
  });

  it('haelt Aenderungen im Protokoll fest - ohne Dateiinhalt', async () => {
    await call('PUT', `${files('fs-1')}/content`, { body: { path: 'audit.txt', content: 'GEHEIMER-INHALT-123' } });
    const actions = registry.recentAudit({ serverId: 'fs-1', limit: 200 });
    const names = actions.map((e) => e.action);
    for (const expected of ['file.edit', 'file.mkdir', 'file.rename', 'file.delete', 'file.upload']) {
      expect(names, expected).toContain(expected);
    }
    expect(JSON.stringify(actions)).not.toContain('GEHEIMER-INHALT-123');
    expect(actions.find((e) => e.action === 'file.edit')?.detail).toMatchObject({ bytes: expect.any(Number) });
  });
});

describe('Funktionsliste des Cores', () => {
  it('meldet, dass er Standalone ist und welche Bereiche er kann', async () => {
    const res = await call('GET', '/api/v1/about');
    expect(res.status).toBe(200);
    expect(res.json.standalone).toBe(true);
    expect(res.json.features).toEqual(expect.arrayContaining(['files', 'settings', 'logfiles', 'schedules', 'backups', 'players']));
    // Nichts davon, was es im Core noch nicht gibt
    for (const missing of ['subusers', 'admin', 'help', 'timeline', 'configs', 'domain']) {
      expect(res.json.features, missing).not.toContain(missing);
    }
    // Seiten, die diese Listen lesen, duerfen nicht abstuerzen
    for (const list of ['changelog', 'todo', 'devlog', 'docs']) expect(res.json[list]).toEqual([]);
  });

  it('meldet je Server nur Rechte, fuer die es Routen gibt', async () => {
    const list = await call('GET', '/api/v1/servers');
    const permissions: string[] = list.json.servers.find((s: { id: string }) => s.id === 'fs-1').permissions;
    for (const wanted of ['control.console', 'control.start', 'file.read', 'file.write', 'file.delete', 'settings.rename', 'startup.read', 'startup.update', 'allocation.read', 'allocation.assign']) {
      expect(permissions, wanted).toContain(wanted);
    }
    // Ohne diese Rechte blendet die Oberflaeche Tabs und Schaltflaechen aus
    for (const missing of ['file.archive', 'file.sftp', 'subuser.read', 'startup.image']) {
      expect(permissions, missing).not.toContain(missing);
    }
  });

  it('beantwortet Benachrichtigungen und Praesenz leer statt mit 404', async () => {
    expect((await call('GET', '/api/v1/notifications')).json).toEqual({ items: [] });
    const ping = await call('POST', '/api/v1/presence/ping', { body: { path: '/' } });
    expect(ping.status).toBe(200);
  });
});
