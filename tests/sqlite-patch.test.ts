import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { applyConfigFiles } from '../src/servers/create.js';
import { config } from '../src/config.js';
import type { ServerRecord } from '../src/types.js';

describe('Datenbank-Patch (TeamSpeak)', () => {
  it('setzt den Sprach-Port in der Datenbank auf den vergebenen', async () => {
    const short = 'sqltest1';
    const dir = join(config.VOLUME_ROOT, short);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'tsserver.sqlitedb');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE servers (server_id INTEGER, server_port INTEGER)');
    db.exec('INSERT INTO servers VALUES (1, 9988)');
    db.close();

    await applyConfigFiles({ short_id: short } as ServerRecord,
      { 'tsserver.sqlitedb': { parser: 'sqlite', find: { 'servers.server_port': '{{SERVER_PORT}}', 'gibts.nicht': '1' } } },
      { variables: {}, ramMb: 512, ip: '0.0.0.0', port: 28000, ports: {}, serverDir: '', serverName: 'ts' });

    const check = new DatabaseSync(file);
    expect(check.prepare('SELECT server_port FROM servers').get()).toEqual({ server_port: 28000 });
    check.close();
  });
});
