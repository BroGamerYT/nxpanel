import { describe, it, expect } from 'vitest';
import { normalizeForeignEgg } from '../src/eggs/import.js';
import { patchConfigFile } from '../src/eggs/config-files.js';
import { substitute } from '../src/eggs/variables.js';

const ctx = (variables: Record<string, string>, ports: Record<string, number> = {}) =>
  ({ variables, ramMb: 4096, ip: '0.0.0.0', port: 28000, ports, serverDir: '/home/container', serverName: 'S' });

describe('Fremde Eggs (Pterodactyl/Pelican)', () => {
  it('liest JSON-Text in config, done als Text-Muster, startup_commands, yml', () => {
    const { raw, notes } = normalizeForeignEgg({
      name: 'X', startup_commands: { Default: './run --port={{SERVER_PORT}}' },
      docker_images: { 'Java 21': 'ghcr.io/pelican-eggs/yolks:java_21' },
      config: { files: '{"config.yml":{"parser":"yml","find":{"port":"{{server.build.default.port}}"}}}',
        startup: '{"done":["Done (", "Server started."]}', logs: '{}', stop: 'stop' },
      image: 'https://example.org/bild.png',
    });
    expect(raw.startup).toBe('./run --port={{SERVER_PORT}}');
    expect((raw.config!.files as Record<string, { parser: string }>)['config.yml']!.parser).toBe('yaml');
    expect(raw.ready_check).toEqual({ kind: 'done', regex: 'Done \\(|Server started\\.', timeout_seconds: 900 });
    expect(new RegExp((raw.ready_check as { regex: string }).regex).test('[12:00] Done (3.2s)! For help')).toBe(true);
    expect(raw.run_as).toBe('1000:1000');
    expect(raw.image).toBeUndefined();
    expect(notes.length).toBe(1);
  });

  it('Port-Variablen werden zu vergebenen Zusatzports, RCON intern', () => {
    const { raw, notes } = normalizeForeignEgg({ name: 'Q', startup: 'x', docker_images: { a: 'ghcr.io/parkervcp/steamcmd:debian' },
      variables: [{ name: 'Query Port', env_variable: 'QUERY_PORT', default_value: '27016', rules: 'required|numeric' },
                  { name: 'RCON', env_variable: 'RCON_PORT', default_value: 27020 },
                  { name: 'Max', env_variable: 'MAX_PLAYERS', default_value: '10' }] });
    expect(raw.ports).toEqual({ primary: { ref: 'game', name: 'Spiel', protocol: 'both' }, secondary: [
      { ref: 'query', name: 'Query Port', protocol: 'both', optional: true },
      { ref: 'rcon', name: 'RCON', protocol: 'both', optional: true, internal: true }] });
    expect(raw.variables![0]).toMatchObject({ default_value: '{{QUERY_PORT}}', user_editable: false });
    expect(raw.variables![2]!.default_value).toBe('10');
    expect(notes.some((n) => n.includes('QUERY_PORT'))).toBe(true);
  });

  it('eigene Images bekommen kein run_as', () => {
    const { raw } = normalizeForeignEgg({ name: 'Y', startup: 'x', docker_images: { a: 'itzg/minecraft-server' } });
    expect(raw.run_as).toBeUndefined();
  });

  it('Parser "file" ersetzt Zeilen, die mit dem Suchtext beginnen', () => {
    const r = patchConfigFile('# Kommentar\nport=1\nname=alt\n', { parser: 'file', find: { 'port=': 'port={{SERVER_PORT}}', 'fehlt=': 'fehlt=1' } }, ctx({}));
    expect(r.content).toBe('# Kommentar\nport=28000\nname=alt\n');
    expect(r.changed).toEqual(['port=']);
    expect(r.skipped).toEqual(['fehlt=']);
  });
});

describe('Platzhalter in Variablen', () => {
  it('Port-Vorlage mit gleichem Namen bekommt den echten Port', () => {
    expect(substitute('{{STEAM_PORT}}', ctx({ STEAM_PORT: '{{STEAM_PORT}}' }, { steam: 27015 }))).toBe('27015');
  });
  it('Vorlagen in Variablen werden aufgeloest, Nutzerwerte gehen vor', () => {
    expect(substitute('-Xmx{{MEMORY}}', ctx({ MEMORY: '{{SERVER_MEMORY_HEAP}}M' }))).toBe('-Xmx3481M');
    expect(substitute('{{SERVER_NAME}}', ctx({ SERVER_NAME: 'Mein Valheim' }))).toBe('Mein Valheim');
  });
});

describe('Fremdes Egg end to end', () => {
  it('importieren, Server anlegen: Zusatzports vergeben, Werte aufgeloest, Konfig gepatcht', async () => {
    const { sql, closeDatabase } = await import('../src/db/index.js');
    const { runMigrations } = await import('../src/db/migrate.js');
    const { importEggFromFile } = await import('../src/eggs/import.js');
    const { ensureLocalNode } = await import('../src/servers/nodes.js');
    const { createUser } = await import('../src/auth/users.js');
    const { buildServer } = await import('../src/http/server.js');
    const { MemoryStore } = await import('../src/auth/ratelimit.js');
    await runMigrations();
    await sql`DELETE FROM servers WHERE name = 'Pelican-Test'`;
    await sql`DELETE FROM eggs WHERE name = 'Beispielspiel (Pelican)'`;
    await sql`DELETE FROM users WHERE username = 'pel-admin'`;
    const app = await buildServer({ rateLimitStore: new MemoryStore(), logger: false,
      power: { start: async () => {}, stop: async () => {}, restart: async () => {}, kill: async () => {} },
      ops: { provision: async () => {}, remove: async () => {}, rebuild: async () => {}, updateResources: async () => {} } });
    try {
      await createUser({ username: 'pel-admin', email: 'pel@t.local', password: 'password-123', role: 'admin', canCreateServers: true });
      await ensureLocalNode();
      const r = await importEggFromFile('tests/fixtures/pelican-sample.json', 'Test');
      const tok = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'pel-admin', password: 'password-123', client: 'app' } })).json().accessToken;
      const res = await app.inject({ method: 'POST', url: '/api/v1/servers', headers: { authorization: `Bearer ${tok}` },
        payload: { name: 'Pelican-Test', eggId: r.eggId, ramMb: 2048, diskMb: 5000, variables: { SRV_NAME: 'Mein Server' } } });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().server.id;
      const allocs = await sql<{ port: number; ref: string }[]>`SELECT port, ref FROM allocations WHERE server_id = ${id}`;
      const ports = Object.fromEntries(allocs.map((a) => [a.ref, a.port]));
      expect(Object.keys(ports).sort()).toEqual(['game', 'query', 'rcon']);
      const [srv] = await sql<{ variables: Record<string, string>; startup: string }[]>`SELECT variables, startup FROM servers WHERE id = ${id}`;
      const c = ctx(srv!.variables, ports);
      expect(substitute('{{QUERY_PORT}}', c)).toBe(String(ports.query));
      const patched = patchConfigFile('port=1\nqueryport=2\n', { parser: 'file', find: { 'port=': 'port={{server.build.default.port}}', 'queryport=': 'queryport={{server.build.env.QUERY_PORT}}' } }, { ...c, port: ports.game! });
      expect(patched.content).toBe(`port=${ports.game}\nqueryport=${ports.query}\n`);
      const [egg] = await sql<{ ready_check: { regex: string }; run_as: string; config_files: Record<string, unknown> }[]>`SELECT ready_check, run_as, config_files FROM eggs WHERE id = ${r.eggId}`;
      expect(egg!.run_as).toBe('1000:1000');
      expect(egg!.ready_check.regex).toBe('Server is ready \\(');
      expect(Object.keys(egg!.config_files)).toEqual(['server.cfg']);
    } finally {
      await app.close();
      await closeDatabase();
    }
  });
});
