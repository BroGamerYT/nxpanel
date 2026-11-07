import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import yazl from 'yazl';
import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { importEggFromFile } from '../src/eggs/import.js';
import { ensureLocalNode } from '../src/servers/nodes.js';
import { IMPORT_ROOT } from '../src/servers/importer.js';
import { config } from '../src/config.js';

let app: FastifyInstance;
const PW = 'ein-langes-passwort';
let mcEgg = '', tsEgg = '', owner = '', other = '', admin = '';
let provisioned: string[] = [];

async function zipBuffer(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [n, c] of Object.entries(entries)) zip.addBuffer(Buffer.from(c), n);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
function multipart(name: string, data: Buffer) {
  const b = '----nxp' + Date.now();
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/zip\r\n\r\n`),
    data, Buffer.from(`\r\n--${b}--\r\n`)]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => { await runMigrations(); });
beforeEach(async () => {
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations, subusers, events, audit_log, sessions RESTART IDENTITY CASCADE`;
  await rm(IMPORT_ROOT, { recursive: true, force: true });
  provisioned = [];
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false,
    power: { start: async () => {}, stop: async () => {}, restart: async () => {}, kill: async () => {} },
    ops: {
      // Wie die echte Bereitstellung: am Ende steht der Server auf offline.
      provision: async (id) => { provisioned.push(id); await sql`UPDATE servers SET status = 'offline' WHERE id = ${id}`; },
      remove: async () => {}, rebuild: async () => {}, updateResources: async () => {},
    },
    consoleEngine: { tailLogs: async () => [], streamLogs: async () => () => {}, streamStats: async () => () => {}, sendToStdin: async () => {} } });
  await createUser({ username: 'owner', email: 'o@t.local', password: PW, canCreateServers: true });
  await createUser({ username: 'other', email: 'x@t.local', password: PW, canCreateServers: true });
  await createUser({ username: 'admin', email: 'a@t.local', password: PW, role: 'admin' });
  await ensureLocalNode();
  mcEgg = (await importEggFromFile('eggs/minecraft-paper.json', 'Mitgeliefert')).eggId;
  tsEgg = (await importEggFromFile('eggs/teamspeak6.json', 'Mitgeliefert')).eggId;
  const tok = async (u: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u, password: PW, client: 'app' } })).json().accessToken as string;
  owner = await tok('owner'); other = await tok('other'); admin = await tok('admin');
});
afterAll(async () => { await app?.close(); await closeDatabase(); });

async function waitFor(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error('Zeitueberschreitung');
}

describe('Neuer Server aus Backup', () => {
  it('hochladen, erkennen, anlegen - Daten landen im Server, Upload wird aufgeraeumt', async () => {
    const zip = await zipBuffer({
      'GLGTS601/ts6/server/tsserver.sqlitedb': 'DB', 'GLGTS601/ts6/server/files/virtualserver_1/x': 'F', 'GLGTS601/AMPConfig.conf': 'x',
    });
    const mp = multipart('GLGTS601 backup.zip', zip);
    const up = await app.inject({ method: 'POST', url: '/api/v1/imports/upload', payload: mp.payload, headers: { ...auth(owner), ...mp.headers } });
    expect(up.statusCode, up.body).toBe(201);
    const file = up.json().file as string;
    expect(file).toMatch(/^upload-u[0-9a-f]{8}-\d+-/);

    const an = await app.inject({ method: 'POST', url: '/api/v1/imports/analyze', headers: auth(owner), payload: { file } });
    expect(an.statusCode, an.body).toBe(200);
    expect(an.json().confident).toBe(true);
    expect(an.json().candidates[0].eggId).toBe(tsEgg);

    // Fremde Uploads sind unsichtbar
    expect((await app.inject({ method: 'POST', url: '/api/v1/imports/analyze', headers: auth(other), payload: { file } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/imports', headers: auth(other) })).json().files).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/imports', headers: auth(owner) })).json().files).toHaveLength(1);

    const cr = await app.inject({ method: 'POST', url: '/api/v1/servers', headers: auth(owner),
      payload: { name: 'TS', eggId: tsEgg, ramMb: 512, diskMb: 2048, variables: {}, importFile: file } });
    expect(cr.statusCode, cr.body).toBe(201);
    const id = cr.json().server.id as string;
    const short = cr.json().server.shortId as string;

    await waitFor(async () => (await sql`SELECT 1 FROM events WHERE server_id = ${id} AND kind IN ('import_done','import_failed')`).length > 0);
    await waitFor(async () => (await sql<{ status: string }[]>`SELECT status FROM servers WHERE id = ${id}`)[0]!.status === 'offline');
    expect(provisioned).toEqual([id]);
    expect(await readFile(join(config.VOLUME_ROOT, short, 'tsserver.sqlitedb'), 'utf8')).toBe('DB');
    expect(await readFile(join(config.VOLUME_ROOT, short, 'files', 'virtualserver_1', 'x'), 'utf8')).toBe('F');
    expect(await stat(join(IMPORT_ROOT, file)).catch(() => null)).toBeNull();
    const kinds = (await sql<{ kind: string }[]>`SELECT kind FROM events WHERE server_id = ${id} ORDER BY id`).map((r) => r.kind);
    expect(kinds).toContain('import_start');
    expect(kinds).toContain('import_done');
  });

  it('Datei im Import-Ordner: nur Admin, und sie bleibt liegen', async () => {
    await mkdir(IMPORT_ROOT, { recursive: true });
    await writeFile(join(IMPORT_ROOT, 'ark.zip'), await zipBuffer({ 'world/level.dat': 'x', 'server.properties': 'motd=a' }));
    expect((await app.inject({ method: 'POST', url: '/api/v1/imports/analyze', headers: auth(owner), payload: { file: 'ark.zip' } })).statusCode).toBe(404);
    const cr = await app.inject({ method: 'POST', url: '/api/v1/servers', headers: auth(admin),
      payload: { name: 'MC', eggId: mcEgg, ramMb: 2048, diskMb: 4096, variables: { EULA: 'TRUE' }, importFile: '../ark.zip' } });
    expect(cr.statusCode, cr.body).toBe(201);
    const id = cr.json().server.id as string;
    await waitFor(async () => (await sql`SELECT 1 FROM events WHERE server_id = ${id} AND kind = 'import_done'`).length > 0);
    expect(await stat(join(IMPORT_ROOT, 'ark.zip'))).toBeTruthy();
  });

  it('kaputte Angaben: kein Server entsteht', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/servers', headers: auth(owner),
      payload: { name: 'X', eggId: mcEgg, ramMb: 2048, diskMb: 4096, variables: { EULA: 'TRUE' }, importFile: 'gibtsnicht.zip' } });
    expect(r.statusCode).toBe(404);
    expect(await sql`SELECT 1 FROM servers`).toHaveLength(0);
    const mb = multipart('x.txt', Buffer.from('a'));
    const bad = await app.inject({ method: 'POST', url: '/api/v1/imports/upload', headers: { ...auth(owner), ...mb.headers }, payload: mb.payload });
    expect(bad.statusCode).toBe(400);
  });
});
