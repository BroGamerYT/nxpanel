import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildServer } from '../src/http/server.js';
import { MemoryStore } from '../src/auth/ratelimit.js';
import { createUser } from '../src/auth/users.js';
import { setStatus } from '../src/servers/status.js';
import { computeStats } from '../src/docker/client.js';
import type { ConsoleEngine } from '../src/http/routes/console.js';

let app: FastifyInstance;
const PW = 'ein-langes-passwort';
const ids: Record<string, string> = {};
let serverId = '';
const stdin: string[] = [];
let emitLine: ((l: string) => void) | null = null;
let emitStats: ((s: { cpuPercent: number; memMb: number; memLimitMb: number; netRxBytes: number; netTxBytes: number }) => void) | null = null;

const engine: ConsoleEngine = {
  tailLogs: async () => ['[Server] Zeile 1', '[Server] Zeile 2'],
  streamLogs: async (_id, onLine) => { emitLine = onLine; return () => { emitLine = null; }; },
  streamStats: async (_id, on) => { emitStats = on; return () => { emitStats = null; }; },
  sendToStdin: async (_id, text) => { stdin.push(text); },
};

beforeAll(async () => { await runMigrations(); });

beforeEach(async () => {
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations, subusers, events, audit_log, sessions RESTART IDENTITY CASCADE`;
  stdin.length = 0;
  app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false, consoleEngine: engine,
    power: { start: async () => {}, stop: async () => {}, restart: async () => {}, kill: async () => {} },
    ops: { provision: async () => {}, remove: async () => {}, rebuild: async () => {}, updateResources: async () => {} } });
  await app.ready(); // injectWS startet die App nicht selbst
  for (const n of ['owner', 'zuschauer', 'fremd']) ids[n] = (await createUser({ username: n, email: `${n}@t.local`, password: PW })).id;
  const [node] = await sql<{ id: string }[]>`INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb) VALUES ('n','l',1,1) RETURNING id`;
  const [nest] = await sql<{ id: string }[]>`INSERT INTO nests (name) VALUES ('T') RETURNING id`;
  const [egg] = await sql<{ id: string }[]>`INSERT INTO eggs (nest_id, name, docker_images, startup, raw_egg) VALUES (${nest!.id}, 'E', ${sql.json({ d: 'x' })}, 'run', ${sql.json({})}) RETURNING id`;
  const [s] = await sql<{ id: string }[]>`
    INSERT INTO servers (short_id, owner_id, node_id, egg_id, name, docker_image, startup, status, ram_mb, disk_mb, container_id)
    VALUES ('c1', ${ids.owner!}, ${node!.id}, ${egg!.id}, 'Konsole', 'x', 'run', 'running', 1024, 1024, 'cont123') RETURNING id`;
  serverId = s!.id;
  await sql`INSERT INTO subusers (server_id, user_id, permissions) VALUES (${serverId}, ${ids.zuschauer!}, '{control.console}')`;
});

afterAll(async () => { await app?.close(); await closeDatabase(); });

async function token(u: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: u, password: PW, client: 'app' } });
  return r.json().accessToken as string;
}
async function ticket(u: string) {
  const r = await app.inject({ method: 'POST', url: `/api/v1/servers/${serverId}/ws-ticket`, headers: { authorization: `Bearer ${await token(u)}` } });
  return { status: r.statusCode, ticket: r.json().ticket as string };
}

/** Oeffnet die Verbindung und sammelt alle Nachrichten. */
async function connect(t: string) {
  const msgs: Array<Record<string, unknown>> = [];
  let resolveClosed: (c: number) => void = () => {};
  const closed = new Promise<number>((res) => { resolveClosed = res; });
  const wsP: Promise<WebSocket> = app.injectWS(`/api/v1/servers/${serverId}/ws?ticket=${t}`, {}, {
    onInit: (w: WebSocket) => {
      w.on('message', (d: Buffer) => msgs.push(JSON.parse(d.toString())));
      w.on('close', (code: number) => resolveClosed(code));
    },
  } as never);
  // Schliesst der Server sofort, kann injectWS haengen bleiben - dann reicht der Close-Code.
  const ws = await Promise.race([wsP, closed.then(() => ({ terminate() {}, send() {} }) as unknown as WebSocket)]);
  return { ws, msgs, closed };
}
const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('Zeitablauf'); await new Promise((r) => setTimeout(r, 20)); }
};

describe('Auslastung umrechnen', () => {
  it('rechnet wie docker stats und zieht den Cache ab', () => {
    const s = computeStats({
      cpu_stats: { cpu_usage: { total_usage: 2_000 }, system_cpu_usage: 20_000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
      memory_stats: { usage: 600 * 1024 * 1024, limit: 2048 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 5 } },
    });
    expect(s).toEqual({ cpuPercent: 40, memMb: 500, memLimitMb: 2048, netRxBytes: 10, netTxBytes: 5 });
  });
});

describe('Live-Konsole', () => {
  it('Fremde bekommen kein Ticket', async () => {
    expect((await ticket('fremd')).status).toBe(404);
  });

  it('hello, Verlauf, Live-Zeilen gebuendelt, Statistik, Statuswechsel', async () => {
    const { ticket: t } = await ticket('owner');
    const { ws, msgs } = await connect(t);
    await until(() => msgs.some((m) => m.type === 'log' && m.history));
    expect(msgs[0]).toMatchObject({ type: 'hello', status: 'running', canCommand: true, name: 'Konsole' });
    expect(msgs.find((m) => m.history)!.lines).toEqual(['[Server] Zeile 1', '[Server] Zeile 2']);

    emitLine!('live a'); emitLine!('live b');
    await until(() => msgs.some((m) => m.type === 'log' && !m.history));
    expect(msgs.filter((m) => m.type === 'log' && !m.history).flatMap((m) => m.lines as string[])).toEqual(['live a', 'live b']);

    emitStats!({ cpuPercent: 55, memMb: 900, memLimitMb: 1024, netRxBytes: 1, netTxBytes: 1 });
    await until(() => msgs.some((m) => m.type === 'stats'));

    await setStatus(serverId, 'stopping', { reason: 'test' });
    await until(() => msgs.some((m) => m.type === 'status' && m.status === 'stopping'));
    expect(msgs.some((m) => m.type === 'event')).toBe(true);
    ws.terminate();
  });

  it('Ticket gilt nur einmal', async () => {
    const { ticket: t } = await ticket('owner');
    const a = await connect(t);
    await until(() => a.msgs.length > 0);
    const b = await connect(t);
    expect(await b.closed).toBe(4401);
    a.ws.terminate();
  });

  it('Befehl mit Recht geht an stdin, wird protokolliert und als Echo gezeigt', async () => {
    const { ticket: t } = await ticket('owner');
    const { ws, msgs } = await connect(t);
    await until(() => msgs.length > 0);
    ws.send(JSON.stringify({ type: 'command', data: 'say hallo\nop boese' }));
    await until(() => stdin.length > 0);
    expect(stdin).toEqual(['say hallo op boese']); // Zeilenumbrueche koennen keinen zweiten Befehl einschmuggeln
    await until(() => msgs.some((m) => m.type === 'log' && (m.lines as string[]).includes('> say hallo op boese')));
    let a: { metadata: { command: string } } | undefined;
    async function poll() { [a] = await sql<{ metadata: { command: string } }[]>`SELECT metadata FROM audit_log WHERE action = 'server.command'`; }
    for (let i = 0; i < 50 && !a; i++) { await poll(); if (!a) await new Promise((r) => setTimeout(r, 20)); }
    const all = await sql`SELECT action FROM audit_log`; expect(all.map((r) => r.action)).toContain('server.command');
    expect(a!.metadata.command).toBe('say hallo op boese');
    ws.terminate();
  });

  it('Zuschauer darf mitlesen, aber keine Befehle senden', async () => {
    const { ticket: t } = await ticket('zuschauer');
    const { ws, msgs } = await connect(t);
    await until(() => msgs.length > 0);
    expect(msgs[0]).toMatchObject({ type: 'hello', canCommand: false });
    ws.send(JSON.stringify({ type: 'command', data: 'stop' }));
    await until(() => msgs.some((m) => m.type === 'error'));
    expect(msgs.find((m) => m.type === 'error')!.code).toBe('forbidden');
    expect(stdin).toEqual([]);
    ws.terminate();
  });

  it('Befehle an gestoppten Server werden abgelehnt', async () => {
    await sql`UPDATE servers SET status = 'offline' WHERE id = ${serverId}`;
    const { ticket: t } = await ticket('owner');
    const { ws, msgs } = await connect(t);
    await until(() => msgs.length > 0);
    ws.send(JSON.stringify({ type: 'command', data: 'list' }));
    await until(() => msgs.some((m) => m.type === 'error'));
    expect(msgs.find((m) => m.type === 'error')!.code).toBe('not_running');
    ws.terminate();
  });
  it('ohne Ticket: Abbruch mit 4401', async () => {
    const { closed, msgs } = await connect('falsch');
    const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 1500))]);
    expect(msgs[0]!.type).toBe('error');
    expect(code).toBe(4401);
  });

});
