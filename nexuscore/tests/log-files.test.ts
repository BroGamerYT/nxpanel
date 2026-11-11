import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { tailFile, cleanLogDirs } = await import('../src/files/logs.js');

let server: Awaited<ReturnType<typeof createCoreServer>>;
let driver: InstanceType<typeof MockDriver>;
let registry: InstanceType<typeof ServerRegistry>;
let dataDir: string;
let outside: string;
let auth: Record<string, string>;
let dir: string;

const api = (url: string, headers: Record<string, string> = auth) => server.inject({ method: 'GET', url, headers });
const q = (p: string) => `?path=${encodeURIComponent(p)}`;

async function add(id: string, workingDir: string, game = 'minecraft-paper'): Promise<void> {
  const config = { id, name: id, game, executable: 'x', args: [], workingDir, ports: [] };
  await registry.add(config);
  await driver.registerServer(config);
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-logs-'));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-logs-outside-'));
  await fs.writeFile(path.join(outside, 'geheim.log'), 'nicht fuer dich');

  dir = path.join(dataDir, 'servers', 'lg-1');
  await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'server.properties'), 'motd=geheim\n');
  await fs.writeFile(path.join(dir, 'logs', 'latest.log'), Array.from({ length: 50 }, (_, i) => `[12:00:${String(i).padStart(2, '0')}] Zeile ${i}`).join('\n'));
  await fs.writeFile(path.join(dir, 'logs', '2026-11-10-1.log.gz'), gzipSync('[alt] erste\n[alt] zweite\n'));
  await fs.writeFile(path.join(dir, 'logs', 'notizen.md'), 'kein Log');
  // Aelter als latest.log
  await fs.utimes(path.join(dir, 'logs', '2026-11-10-1.log.gz'), new Date('2026-11-10T10:00:00Z'), new Date('2026-11-10T10:00:00Z'));

  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
  const login = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: { login: 'admin', password: 'nur-fuer-tests-0815' },
  });
  auth = { authorization: `Bearer ${login.json().accessToken}` };

  await add('lg-1', dir);
  await add('lg-aussen', outside);
});

afterAll(async () => {
  await server.close();
  await driver.shutdown();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
});

describe('Logdateien', () => {
  it('listet nur Logdateien, neueste zuerst', async () => {
    const res = await api('/api/v1/servers/lg-1/logs');
    expect(res.statusCode).toBe(200);
    const files = res.json().files as Array<{ path: string; name: string; bytes: number; modified: string }>;
    expect(files.map((f) => f.path)).toEqual(['logs/latest.log', 'logs/2026-11-10-1.log.gz']);
    expect(files[0]).toMatchObject({ name: 'latest.log' });
    expect(files[0]!.bytes).toBeGreaterThan(100);
    expect(files[0]!.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('liest die letzten Zeilen einer Datei', async () => {
    const res = await api(`/api/v1/servers/lg-1/logs/file${q('logs/latest.log')}&lines=10`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lines).toHaveLength(10);
    expect(body.lines.at(-1)).toBe('[12:00:49] Zeile 49');
    expect(body.truncated).toBe(true);
    expect(body.path).toBe('logs/latest.log');

    const all = (await api(`/api/v1/servers/lg-1/logs/file${q('logs/latest.log')}`)).json();
    expect(all.lines).toHaveLength(50);
    expect(all.truncated).toBe(false);
  });

  it('entpackt .gz-Dateien fuer die Anzeige', async () => {
    const res = await api(`/api/v1/servers/lg-1/logs/file${q('logs/2026-11-10-1.log.gz')}`);
    expect(res.json().lines).toEqual(['[alt] erste', '[alt] zweite']);
  });

  it('laedt eine Datei herunter', async () => {
    const res = await api(`/api/v1/servers/lg-1/logs/file${q('logs/latest.log')}&download=1`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="latest.log"');
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.body).toContain('Zeile 0');
  });

  it('liefert andere Dateien im Server-Ordner nicht aus', async () => {
    for (const bad of ['server.properties', 'logs/notizen.md', 'logs', 'logs/gibt-es-nicht.log', '.']) {
      expect((await api(`/api/v1/servers/lg-1/logs/file${q(bad)}`)).statusCode, bad).toBe(404);
    }
  });

  it('lehnt Pfade ausserhalb ab', async () => {
    for (const bad of ['../geheim.log', '../../x.log', '..\\..\\geheim.log', 'logs/../../geheim.log', `logs/a${'\0'}.log`, 'C:\\Windows\\debug.log']) {
      const res = await api(`/api/v1/servers/lg-1/logs/file${q(bad)}`);
      expect(res.statusCode, JSON.stringify(bad)).toBe(404);
    }
  });

  it('folgt keinem Verweis nach draussen', async () => {
    const link = path.join(dir, 'logs', 'verweis.log');
    try {
      await fs.symlink(path.join(outside, 'geheim.log'), link, 'file');
    } catch {
      try {
        await fs.symlink(outside, path.join(dir, 'logs', 'ordner'), 'junction');
      } catch {
        return; // Dateisystem ohne Verweise
      }
      const viaDir = await api(`/api/v1/servers/lg-1/logs/file${q('logs/ordner/geheim.log')}`);
      expect(viaDir.statusCode).toBe(404);
      await fs.rm(path.join(dir, 'logs', 'ordner'), { recursive: false, force: true }).catch(() => {});
      return;
    }
    const listed = (await api('/api/v1/servers/lg-1/logs')).json().files.map((f: { name: string }) => f.name);
    expect(listed).not.toContain('verweis.log');
    expect((await api(`/api/v1/servers/lg-1/logs/file${q('logs/verweis.log')}`)).statusCode).toBe(404);
    await fs.rm(link, { force: true }).catch(() => {});
  });

  it('prueft die Anfrage und sperrt Server ausserhalb des Server-Verzeichnisses', async () => {
    expect((await api('/api/v1/servers/lg-1/logs/file')).statusCode).toBe(400);
    expect((await api(`/api/v1/servers/lg-1/logs/file${q('logs/latest.log')}&lines=2`)).statusCode).toBe(400);
    expect((await api('/api/v1/servers/gibt-es-nicht/logs')).statusCode).toBe(404);
    const blocked = await api('/api/v1/servers/lg-aussen/logs');
    expect(blocked.statusCode).toBe(403);
    expect((await api(`/api/v1/servers/lg-aussen/logs/file${q('geheim.log')}`)).statusCode).toBe(403);
  });

  it('verlangt eine Anmeldung', async () => {
    expect((await api('/api/v1/servers/lg-1/logs', {})).statusCode).toBe(401);
    expect((await api(`/api/v1/servers/lg-1/logs/file${q('logs/latest.log')}`, {})).statusCode).toBe(401);
  });

  it('nimmt nur einfache Ordner aus dem Egg und kuerzt grosse Dateien vorn', async () => {
    expect(cleanLogDirs(undefined)).toEqual(['logs']);
    expect(cleanLogDirs(['a', 5, '', 'x'.repeat(300), 'b'])).toEqual(['a', 'b']);
    expect(cleanLogDirs([])).toEqual(['logs']);

    const big = path.join(dataDir, 'gross.log');
    await fs.writeFile(big, `${'x'.repeat(300)}\n`.repeat(30));
    // 2000 Byte sind rund sechs Zeilen, die angeschnittene erste faellt weg
    const lines = await tailFile(big, 5, 2000);
    expect(lines).toHaveLength(5);
    expect(lines.every((l) => l === 'x'.repeat(300))).toBe(true);
    expect(await tailFile(path.join(dataDir, 'gibt-es-nicht.log'), 5)).toEqual([]);
  });
});
