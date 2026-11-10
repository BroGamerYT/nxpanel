import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { config } from '../src/config.js';
import { adminFileRoots } from '../src/admin/file-roots.js';

let app: FastifyInstance;
const PW = 'ein-langes-passwort';
let admin = '', user = '';
const panelRoot = dirname(resolve(config.VOLUME_ROOT));
const testDir = join(resolve(config.VOLUME_ROOT), 'admin-files-test');

beforeAll(async () => { await runMigrations(); });
beforeEach(async () => {
  await sql`TRUNCATE users, sessions, audit_log RESTART IDENTITY CASCADE`;
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false });
  await createUser({ username: 'chef', email: 'c@t.local', password: PW, role: 'admin' });
  await createUser({ username: 'gast', email: 'g@t.local', password: PW });
  const tok = async (u: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u, password: PW, client: 'app' } })).json().accessToken as string;
  admin = await tok('chef'); user = await tok('gast');
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(join(testDir, 'gross'), { recursive: true });
  writeFileSync(join(testDir, 'gross', 'daten.bin'), Buffer.alloc(300 * 1024));
  writeFileSync(join(testDir, 'notiz.txt'), 'hallo');
});
afterAll(async () => { rmSync(testDir, { recursive: true, force: true }); await app?.close(); await closeDatabase(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const rel = `volumes/admin-files-test`;

describe('Admin-Dateimanager', () => {
  it('Ordnerliste: Panel-Ordner, NAS, eigene Zusatzordner, nie "/"', () => {
    const r = adminFileRoots({ VOLUME_ROOT: '/var/lib/panel/volumes', BACKUP_ROOT: '/var/lib/panel/backups', NAS_BACKUP_ROOT: '/mnt/nas/np', ADMIN_FILE_ROOTS: 'Installation=/opt/nxpanel;Alles=/' });
    // resolve(): unter Windows wird daraus C:\\var\\lib\\panel usw.
    expect(r.map((x) => [x.id, x.path])).toEqual([
      ['panel-daten', resolve('/var/lib/panel')], ['nas-backups', resolve('/mnt/nas/np')], ['installation', resolve('/opt/nxpanel')],
    ]);
  });

  it('nur fuer Admins', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/files', headers: auth(user) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/files/panel-daten', headers: auth(user) })).statusCode).toBe(403);
  });

  it('listet, liest, schreibt und protokolliert', async () => {
    const roots = (await app.inject({ method: 'GET', url: '/api/v1/admin/files', headers: auth(admin) })).json().roots;
    expect(roots[0]).toMatchObject({ id: 'panel-daten', path: panelRoot, available: true });

    const ls = (await app.inject({ method: 'GET', url: `/api/v1/admin/files/panel-daten?path=${rel}`, headers: auth(admin) })).json();
    expect(ls.entries.map((e: { name: string }) => e.name).sort()).toEqual(['gross', 'notiz.txt']);

    const c = (await app.inject({ method: 'GET', url: `/api/v1/admin/files/panel-daten/content?path=${rel}/notiz.txt`, headers: auth(admin) })).json();
    expect(c.content).toBe('hallo');

    const w = await app.inject({ method: 'PUT', url: '/api/v1/admin/files/panel-daten/content', headers: auth(admin), payload: { path: `${rel}/notiz.txt`, content: 'neu' } });
    expect(w.statusCode).toBe(200);
    const [a] = await sql<{ action: string; metadata: { root: string; path: string } }[]>`SELECT action, metadata FROM audit_log WHERE action = 'admin.file.edit'`;
    expect(a?.metadata).toMatchObject({ root: 'panel-daten', path: `${rel}/notiz.txt` });
  });

  it('kein Ausbruch aus dem Ordner (.. und Symlinks)', async () => {
    const up = await app.inject({ method: 'GET', url: '/api/v1/admin/files/panel-daten/content?path=../../../etc/passwd', headers: auth(admin) });
    expect(up.statusCode).toBe(400);
    // 'junction' klappt unter Windows auch ohne Admin-Rechte; Ziel ausserhalb des Panel-Ordners
    if (!existsSync(join(testDir, 'raus'))) symlinkSync(tmpdir(), join(testDir, 'raus'), 'junction');
    const sl = await app.inject({ method: 'GET', url: `/api/v1/admin/files/panel-daten?path=${rel}/raus`, headers: auth(admin) });
    expect(sl.statusCode).toBe(400);
  });

  it('nicht eingebundene Ordner melden 404, unbekannte auch', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/files/gibtsnicht', headers: auth(admin) })).statusCode).toBe(404);
  });

  it('Speicherbelegung: groesste Ordner zuerst', async () => {
    const u = (await app.inject({ method: 'GET', url: `/api/v1/admin/files/panel-daten/usage?path=${rel}`, headers: auth(admin) })).json();
    expect(u.entries[0]).toMatchObject({ name: 'gross', path: `${rel}/gross` });
    expect(u.entries[0].bytes).toBeGreaterThanOrEqual(300 * 1024);
  });
});

describe('Server-Ordner beschriften', () => {
  it('Servername dran, verwaiste Ordner markiert, sonst nichts', async () => {
    const { applyVolumeLabels, ORPHAN_LABEL } = await import('../src/admin/file-roots.js');
    const r = applyVolumeLabels([{ name: 'aaaa1111' }, { name: 'bbbb2222' }, { name: 'notizen' }], { aaaa1111: 'Survival · Minecraft Java' });
    expect(r).toEqual([
      { name: 'aaaa1111', label: 'Survival · Minecraft Java' },
      { name: 'bbbb2222', label: ORPHAN_LABEL, orphan: true },
      { name: 'notizen' },
    ]);
    expect(applyVolumeLabels([{ name: 'bbbb2222' }], {})).toEqual([{ name: 'bbbb2222' }]);
  });
});
