/**
 * Gesamttest: legt einen echten Minecraft-Server an und startet ihn.
 *
 *   npm run mc -- create
 *   npm run mc -- start
 *   npm run mc -- status
 *   npm run mc -- stop
 *   npm run mc -- remove
 */
import 'dotenv/config';
import { sql, closeDatabase, waitForDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { log } from '../log.js';
import { importEggFromFile } from '../eggs/import.js';
import { createServer, deleteServer, ValidationError } from '../servers/create.js';
import { startServer, stopServer } from '../servers/lifecycle.js';
import { listPorts } from '../servers/repo.js';
import { engine } from '../docker/client.js';

const NAME = 'Minecraft Test';

async function ensureEgg(): Promise<string> {
  const [found] = await sql<{ id: string }[]>`SELECT id FROM eggs WHERE name = 'Minecraft Java'`;
  if (found) return found.id;
  const r = await importEggFromFile('eggs/minecraft-paper.json');
  console.log(`Egg importiert: ${r.name} (${r.variables} Variablen)`);
  for (const w of r.warnings) console.log('  Hinweis:', w);
  return r.eggId;
}

async function ensureBase() {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, username, password_hash, role, can_create_servers)
    VALUES ('dev@local', 'dev', 'nicht-gesetzt', 'admin', true)
    ON CONFLICT (email) DO UPDATE SET role = 'admin' RETURNING id`;
  let [node] = await sql<{ id: string }[]>`SELECT id FROM nodes LIMIT 1`;
  if (!node) {
    [node] = await sql<{ id: string }[]>`
      INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb)
      VALUES ('local', 'localhost', 32768, 200000) RETURNING id`;
  }
  return { userId: user!.id, nodeId: node!.id };
}

async function find() {
  const [s] = await sql<{ id: string; short_id: string; status: string; name: string }[]>`
    SELECT id, short_id, status, name FROM servers WHERE name = ${NAME}`;
  return s;
}

async function main() {
  await waitForDatabase();
  // Auch die Werkzeuge migrieren selbst. Sonst bricht nach jeder neuen
  // Migration das erste CLI-Kommando mit "column does not exist" ab, obwohl
  // nur das Panel noch nicht gestartet wurde.
  await runMigrations();
  const cmd = process.argv[2];

  if (cmd === 'create') {
    if (await find()) { console.log('Gibt es schon. Erst: npm run mc -- remove'); await closeDatabase(); return; }
    const eggId = await ensureEgg();
    const { userId, nodeId } = await ensureBase();

    console.log('Lege Server an - das Image ist gross, der erste Lauf dauert.');
    try {
      const s = await createServer({
        ownerId: userId, nodeId, eggId, name: NAME,
        ramMb: 2048, diskMb: 8192, cpuPercent: 200,
        variables: { MAX_PLAYERS: '10', MOTD: 'NexusPanel laeuft', DIFFICULTY: 'normal' },
      });
      const ports = await listPorts(s.id);
      console.log(`\nAngelegt: ${s.name}  (${s.short_id})`);
      for (const p of ports) console.log(`  ${p.ref ?? 'port'}: ${p.port}/${p.protocol}`);
      console.log('\nStarten mit: npm run mc -- start');
    } catch (err) {
      if (err instanceof ValidationError) {
        console.error('Ungueltige Werte:');
        for (const i of err.issues) console.error(`  ${i.variable}: ${i.message}`);
      } else throw err;
    }
  }

  else if (cmd === 'start') {
    const s = await find(); if (!s) return console.log('Kein Server.');
    console.log('Starte - beim ersten Mal laedt Paper noch herunter.');
    await startServer(s.id);
    const ports = await listPorts(s.id);
    const game = ports.find((p) => p.ref === 'game');
    console.log(`\nVerbinden mit: <IP>:${game?.port}`);
  }

  else if (cmd === 'stop') {
    const s = await find(); if (!s) return console.log('Kein Server.');
    await stopServer(s.id, { stopCommand: 'stop', graceSeconds: 30 });
    console.log('Gestoppt.');
  }

  else if (cmd === 'status') {
    const s = await find(); if (!s) return console.log('Kein Server.');
    const state = await engine.inspect((await sql<{ container_id: string }[]>`
      SELECT container_id FROM servers WHERE id = ${s.id}`)[0]!.container_id);
    const ports = await listPorts(s.id);
    console.log('Status    :', s.status);
    console.log('Container :', state ? (state.running ? 'laeuft' : `beendet (${state.exitCode})`) : 'weg');
    console.log('Ports     :', ports.map((p) => `${p.ref}=${p.port}`).join('  '));
    const events = await sql<{ ts: Date; kind: string; summary: string }[]>`
      SELECT ts, kind, summary FROM events WHERE server_id = ${s.id} ORDER BY id DESC LIMIT 10`;
    console.log('\nZeitachse:');
    for (const e of events.reverse()) {
      console.log(`  ${e.ts.toISOString().slice(11, 19)}  ${e.kind.padEnd(16)} ${e.summary}`);
    }

    const [crash] = await sql<{ payload: { lastLines?: string[] } | null }[]>`
      SELECT payload FROM events WHERE server_id = ${s.id} AND kind = 'crash'
      ORDER BY id DESC LIMIT 1`;
    const lines = crash?.payload?.lastLines ?? [];
    if (lines.length > 0) {
      console.log('\nLetzter Absturz - die Ausgabe davor:');
      for (const l of lines.slice(-15)) console.log('  | ' + l);
    }
  }

  else if (cmd === 'remove') {
    const s = await find(); if (!s) return console.log('Kein Server.');
    await deleteServer(s.id);
    console.log('Entfernt.');
  }

  else console.log('create | start | stop | status | remove');

  await closeDatabase();
  process.exit(0);
}

main().catch((err) => { log.error({ err }, 'Fehlgeschlagen'); process.exit(1); });
