/**
 * Kleines Werkzeug zum Ausprobieren von Phase 1 ohne Oberflaeche.
 *
 *   npm run dev:server -- create   Legt einen Testserver samt Container an
 *   npm run dev:server -- start
 *   npm run dev:server -- stop
 *   npm run dev:server -- status
 *   npm run dev:server -- remove
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { sql, closeDatabase, waitForDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { engine } from '../docker/client.js';
import { log } from '../log.js';
import { startServer, stopServer, killServer } from '../servers/lifecycle.js';
import { findServerByShortId, setContainerId } from '../servers/repo.js';
import { setStatus } from '../servers/status.js';

const SHORT_ID = 'devtest1';
const IMAGE = 'alpine:3.20';

async function ensureBaseRows() {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, username, password_hash, role, can_create_servers)
    VALUES ('dev@local', 'dev', 'nicht-gesetzt', 'admin', true)
    ON CONFLICT (email) DO UPDATE SET username = EXCLUDED.username
    RETURNING id
  `;
  const [node] = await sql<{ id: string }[]>`
    INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb)
    SELECT 'local', 'localhost', 8192, 100000
    WHERE NOT EXISTS (SELECT 1 FROM nodes)
    RETURNING id
  `;
  const nodeId = node?.id ?? (await sql<{ id: string }[]>`SELECT id FROM nodes LIMIT 1`)[0]!.id;

  const [nest] = await sql<{ id: string }[]>`
    INSERT INTO nests (name, description)
    SELECT 'Test', 'Nur zum Ausprobieren'
    WHERE NOT EXISTS (SELECT 1 FROM nests WHERE name = 'Test')
    RETURNING id
  `;
  const nestId = nest?.id ?? (await sql<{ id: string }[]>`SELECT id FROM nests WHERE name = 'Test'`)[0]!.id;

  const [egg] = await sql<{ id: string }[]>`
    INSERT INTO eggs (nest_id, name, docker_images, startup, stop_command, console_mode, raw_egg)
    SELECT ${nestId}, 'Alpine Dauerlaeufer', ${sql.json({ default: IMAGE })},
           'sh -c "while true; do echo tick; sleep 5; done"', '^C', 'full', ${sql.json({})}
    WHERE NOT EXISTS (SELECT 1 FROM eggs WHERE name = 'Alpine Dauerlaeufer')
    RETURNING id
  `;
  const eggId = egg?.id ?? (await sql<{ id: string }[]>`SELECT id FROM eggs WHERE name = 'Alpine Dauerlaeufer'`)[0]!.id;

  return { userId: user!.id, nodeId, eggId };
}

async function create() {
  const existing = await findServerByShortId(SHORT_ID);

  // Fortsetzen statt blockieren: bricht das Anlegen mittendrin ab (etwa weil
  // das Image fehlte), soll ein erneuter Aufruf den Rest erledigen.
  if (existing?.container_id) {
    console.log('Testserver besteht bereits:', existing.id);
    return;
  }
  if (existing) {
    console.log('Unvollstaendige Anlage gefunden, setze fort ...');
    const containerId = await engine.create({
      shortId: SHORT_ID,
      serverId: existing.id,
      ownerId: existing.owner_id,
      image: IMAGE,
      env: { SERVER_NAME: 'Testserver' },
      entrypoint: ['/bin/sh', '-c'],
      command: ['while true; do echo tick; sleep 5; done'],
      ramMb: 256, swapMb: 0, cpuPercent: 50, ioWeight: 500, ports: [],
    });
    await setContainerId(existing.id, containerId);
    await setStatus(existing.id, 'offline', { reason: 'Installation abgeschlossen' });
    console.log('Fertig:', existing.id, '->', containerId.slice(0, 12));
    return;
  }

  const { userId, nodeId, eggId } = await ensureBaseRows();

  const [server] = await sql<{ id: string }[]>`
    INSERT INTO servers (short_id, owner_id, node_id, egg_id, name, docker_image, startup,
                         status, ram_mb, disk_mb)
    VALUES (${SHORT_ID}, ${userId}, ${nodeId}, ${eggId}, 'Testserver', ${IMAGE},
            'sh -c "while true; do echo tick; sleep 5; done"', 'installing', 256, 1024)
    RETURNING id
  `;

  const containerId = await engine.create({
    shortId: SHORT_ID,
    serverId: server!.id,
    ownerId: userId,
    image: IMAGE,
    env: { SERVER_NAME: 'Testserver' },
    entrypoint: ['/bin/sh', '-c'],
    command: ['while true; do echo tick; sleep 5; done'],
    ramMb: 256,
    swapMb: 0,
    cpuPercent: 50,
    ioWeight: 500,
    ports: [],
  });

  await setContainerId(server!.id, containerId);
  await setStatus(server!.id, 'offline', { reason: 'Installation abgeschlossen' });
  console.log('Angelegt:', server!.id, '->', containerId.slice(0, 12));
}

async function withServer(fn: (id: string) => Promise<void>) {
  const server = await findServerByShortId(SHORT_ID);
  if (!server) {
    console.error('Kein Testserver. Erst: npm run dev:server -- create');
    return;
  }
  await fn(server.id);
}

async function main() {
  await waitForDatabase();
  // Auch die Werkzeuge migrieren selbst. Sonst bricht nach jeder neuen
  // Migration das erste CLI-Kommando mit "column does not exist" ab, obwohl
  // nur das Panel noch nicht gestartet wurde.
  await runMigrations();
  const cmd = process.argv[2];

  switch (cmd) {
    case 'create': await create(); break;
    case 'start':  await withServer(startServer); break;
    case 'stop':   await withServer((id) => stopServer(id, { graceSeconds: 10 })); break;
    case 'kill':   await withServer(killServer); break;
    case 'status': {
      const s = await findServerByShortId(SHORT_ID);
      if (!s) { console.log('Kein Testserver.'); break; }
      const state = s.container_id ? await engine.inspect(s.container_id) : null;
      const [recent] = await sql<{ count: string }[]>`
        SELECT count(*) FROM events
        WHERE server_id = ${s.id} AND kind = 'crash' AND ts > now() - interval '10 minutes'
      `;
      console.log('Datenbank :', s.status,
                  '| Abstuerze gesamt:', s.crash_count,
                  '| letzte 10 Min:', recent?.count ?? 0, 'von 5');
      console.log('Container :', state ? (state.running ? 'laeuft' : `beendet (${state.exitCode})`) : 'nicht vorhanden');
      const events = await sql<{ ts: Date; kind: string; summary: string }[]>`
        SELECT ts, kind, summary FROM events WHERE server_id = ${s.id} ORDER BY ts DESC LIMIT 8
      `;
      console.log('\nLetzte Ereignisse:');
      for (const e of events.reverse()) {
        console.log(`  ${e.ts.toISOString().slice(11, 19)}  ${e.kind.padEnd(16)} ${e.summary}`);
      }
      break;
    }
    case 'remove': {
      const s = await findServerByShortId(SHORT_ID);
      if (!s) { console.log('Kein Testserver.'); break; }
      if (s.container_id) await engine.remove(s.container_id, true).catch(() => {});
      await engine.removeVolume(SHORT_ID);
      await sql`DELETE FROM servers WHERE id = ${s.id}`;
      console.log('Entfernt.');
      break;
    }
    default:
      console.log('create | start | stop | kill | status | remove');
  }

  await closeDatabase();
  process.exit(0);
}

main().catch((err) => { log.error({ err }, 'Fehlgeschlagen'); process.exit(1); });
