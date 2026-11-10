import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStatus, getStatus } from '../src/servers/status.js';
import { importEgg } from '../src/eggs/import.js';

let serverId = '';

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await sql`TRUNCATE users, nodes, nests, eggs, egg_variables, servers, allocations,
                     subusers, events, audit_log, sessions RESTART IDENTITY CASCADE`;

  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, username, password_hash, role)
    VALUES ('t@local', 't', 'x', 'admin') RETURNING id`;
  const [node] = await sql<{ id: string }[]>`
    INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb)
    VALUES ('n', 'localhost', 8192, 100000) RETURNING id`;
  const [nest] = await sql<{ id: string }[]>`
    INSERT INTO nests (name) VALUES ('T') RETURNING id`;
  const [egg] = await sql<{ id: string }[]>`
    INSERT INTO eggs (nest_id, name, docker_images, startup, raw_egg)
    VALUES (${nest!.id}, 'E', ${sql.json({ d: 'alpine' })}, 'run', ${sql.json({})}) RETURNING id`;
  const [server] = await sql<{ id: string }[]>`
    INSERT INTO servers (short_id, owner_id, node_id, egg_id, name, docker_image, startup,
                         status, ram_mb, disk_mb)
    VALUES ('t1', ${user!.id}, ${node!.id}, ${egg!.id}, 'S', 'alpine', 'run', 'offline', 512, 1024)
    RETURNING id`;
  serverId = server!.id;
});

afterAll(async () => {
  await closeDatabase();
});

describe('Statusmaschine', () => {
  it('erlaubt den normalen Weg', async () => {
    expect(await setStatus(serverId, 'starting')).toBe(true);
    expect(await setStatus(serverId, 'running')).toBe(true);
    expect(await setStatus(serverId, 'stopping')).toBe(true);
    expect(await setStatus(serverId, 'offline')).toBe(true);
  });

  it('weist unmoegliche Spruenge ab', async () => {
    // offline -> stopping ergibt keinen Sinn. (offline -> running ist seit
    // 0.23 erlaubt: der Abgleich mit Docker meldet von aussen gestartete
    // Container, siehe supervisor.ts.)
    expect(await setStatus(serverId, 'stopping')).toBe(false);
    expect(await getStatus(serverId)).toBe('offline');
  });

  it('schreibt zu jedem Wechsel ein Ereignis', async () => {
    await setStatus(serverId, 'starting', { reason: 'Test' });
    const rows = await sql<{ kind: string; summary: string }[]>`
      SELECT kind, summary FROM events WHERE server_id = ${serverId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('status_change');
    expect(rows[0]!.summary).toContain('Test');
  });

  it('meldet einen Absturz als Fehler, nicht als Hinweis', async () => {
    await setStatus(serverId, 'starting');
    await setStatus(serverId, 'running');
    await setStatus(serverId, 'crashed', { reason: 'Exit 137' });
    const [row] = await sql<{ severity: string }[]>`
      SELECT severity FROM events WHERE server_id = ${serverId}
      ORDER BY id DESC LIMIT 1`;
    expect(row!.severity).toBe('error');
  });

  it('bleibt still, wenn sich nichts aendert', async () => {
    expect(await setStatus(serverId, 'offline')).toBe(true);
    const rows = await sql`SELECT 1 FROM events WHERE server_id = ${serverId}`;
    expect(rows).toHaveLength(0);
  });
});

describe('Egg-Import', () => {
  it('liest ein Pterodactyl-Egg und normalisiert es', async () => {
    const r = await importEgg({
      name: 'Paper',
      docker_images: { 'Java 21': 'ghcr.io/pterodactyl/yolks:java_21' },
      startup: 'java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
      config: { stop: 'stop' },
      variables: [
        { name: 'Jar', env_variable: 'SERVER_JARFILE', default_value: 'server.jar', rules: 'required|string' },
      ],
    });

    expect(r.variables).toBe(1);
    // Kein Platzhalter bleibt ungedeckt; der Hinweis auf das fehlende
    // Installationsskript ist gewollt und kein Fehler.
    expect(r.warnings.some((w) => w.includes('Platzhalter'))).toBe(false);
    expect(r.warnings.some((w) => w.includes('Installationsskript'))).toBe(true);

    const [egg] = await sql<{ stop_command: string; console_mode: string }[]>`
      SELECT stop_command, console_mode FROM eggs WHERE name = 'Paper'`;
    expect(egg!.stop_command).toBe('stop');
    expect(egg!.console_mode).toBe('full');
  });

  it('warnt bei Platzhaltern ohne Variable', async () => {
    const r = await importEgg({
      name: 'Kaputt',
      image: 'alpine',
      startup: 'run --key {{FEHLT_VOELLIG}}',
    });
    expect(r.warnings.some((w) => w.includes('FEHLT_VOELLIG'))).toBe(true);
  });

  it('uebernimmt console: readonly', async () => {
    await importEgg({ name: 'NurLesen', image: 'alpine', startup: 'run', console: 'readonly' });
    const [egg] = await sql<{ console_mode: string }[]>`
      SELECT console_mode FROM eggs WHERE name = 'NurLesen'`;
    expect(egg!.console_mode).toBe('readonly');
  });

  it('verweigert ein Egg ohne Startkommando', async () => {
    await expect(importEgg({ name: 'Leer', image: 'alpine' })).rejects.toThrow(/Startkommando/);
  });

  it('verweigert ein Egg ohne Image', async () => {
    await expect(importEgg({ name: 'Bildlos', startup: 'run' })).rejects.toThrow(/Image/);
  });

  it('bewahrt das Original in raw_egg', async () => {
    await importEgg({ name: 'Original', image: 'alpine', startup: 'run', author: 'wer' });
    const [row] = await sql<{ raw_egg: { author?: string } }[]>`
      SELECT raw_egg FROM eggs WHERE name = 'Original'`;
    expect(row!.raw_egg.author).toBe('wer');
  });
});

describe('Image-Vorgabe', () => {
  it('haelt die erste Angabe des Eggs fest, trotz JSONB-Sortierung', async () => {
    // JSONB sortiert Schluessel um: "Java 17" landet vor "Java 21".
    // Ohne default_image bekaeme der Server das falsche Image.
    await importEgg({
      name: 'Reihenfolge',
      docker_images: { 'Java 21': 'image:java21', 'Java 17': 'image:java17' },
      startup: 'run',
    });

    const [egg] = await sql<{ default_image: string; docker_images: Record<string, string> }[]>`
      SELECT default_image, docker_images FROM eggs WHERE name = 'Reihenfolge'`;

    expect(egg!.default_image).toBe('image:java21');
    // Zum Beweis, dass die Sortierung wirklich passiert:
    expect(Object.keys(egg!.docker_images)[0]).toBe('Java 17');
  });
});

describe('Rechte aus Eggs', () => {
  it('uebernimmt erlaubte Rechte und den Datenpfad', async () => {
    await importEgg({
      name: 'MitRechten', image: 'alpine', startup: 'run',
      capabilities: ['CHOWN', 'SETUID', 'SETGID'], data_dir: '/data',
    });
    const [egg] = await sql<{ capabilities: string[]; data_dir: string }[]>`
      SELECT capabilities, data_dir FROM eggs WHERE name = 'MitRechten'`;
    expect(egg!.capabilities).toEqual(['CHOWN', 'SETUID', 'SETGID']);
    expect(egg!.data_dir).toBe('/data');
  });

  it('verweigert gefaehrliche Rechte und sagt es', async () => {
    const r = await importEgg({
      name: 'Boese', image: 'alpine', startup: 'run',
      capabilities: ['SYS_ADMIN', 'CHOWN'], data_dir: '/etc',
    });
    const [egg] = await sql<{ capabilities: string[]; data_dir: string }[]>`
      SELECT capabilities, data_dir FROM eggs WHERE name = 'Boese'`;
    expect(egg!.capabilities).toEqual(['CHOWN']);
    expect(egg!.data_dir).toBe('/home/container');
    expect(r.warnings.some((w) => w.includes('SYS_ADMIN'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('/etc'))).toBe(true);
  });
});
