import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { sql, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/auth/users.js';
import { createSftpServer } from '../src/servers/sftp.js';
import { createSftpPassword, listSftpPasswords, deleteSftpPassword } from '../src/auth/sftp-passwords.js';

const PW = 'ein-langes-passwort';
let port = 0;
let srv: ReturnType<typeof createSftpServer>;
let appPw = '';

function tryLogin(username: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = new ssh2.Client();
    c.on('ready', () => { c.end(); resolve(true); });
    c.on('error', () => resolve(false));
    c.connect({ host: '127.0.0.1', port, username, password, readyTimeout: 8000, tryKeyboard: false });
  });
}

beforeAll(async () => {
  await runMigrations();
  await sql`TRUNCATE users, sftp_passwords RESTART IDENTITY CASCADE`;
  const flushRedis = await import('ioredis');
  const r = new flushRedis.default(process.env.REDIS_URL!); await r.flushdb(); r.disconnect();
  await createUser({ username: 'ohne2fa', email: 'a@t.local', password: PW });
  const mit = await createUser({ username: 'mit2fa', email: 'b@t.local', password: PW });
  await sql`UPDATE users SET totp_enabled = true WHERE id = ${mit.id}`;
  appPw = (await createSftpPassword(mit.id, 'FileZilla')).password;
  srv = createSftpServer();
  await new Promise<void>((res) => srv!.listen(0, '127.0.0.1', () => res()));
  port = (srv!.address() as AddressInfo).port;
}, 30_000);
afterAll(async () => { srv?.close(); await closeDatabase(); });

describe('SFTP-Anmeldung', () => {
  it('ohne 2FA: Kontopasswort geht, falsches nicht', async () => {
    expect(await tryLogin('ohne2fa', PW)).toBe(true);
    expect(await tryLogin('ohne2fa', 'falsch-falsch')).toBe(false);
  }, 30_000);

  it('mit 2FA: Kontopasswort reicht NICHT, SFTP-Passwort schon', async () => {
    expect(await tryLogin('mit2fa', PW)).toBe(false);
    expect(await tryLogin('mit2fa', appPw)).toBe(true);
    const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE username = 'mit2fa'`;
    expect((await listSftpPasswords(u!.id))[0]!.lastUsedAt).not.toBeNull();
  }, 30_000);

  it('geloeschtes SFTP-Passwort ist sofort ungueltig', async () => {
    const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE username = 'mit2fa'`;
    const [p] = await listSftpPasswords(u!.id);
    expect(await deleteSftpPassword(u!.id, p!.id)).toBe(true);
    expect(await tryLogin('mit2fa', appPw)).toBe(false);
  }, 30_000);

  it('Passwort-Raten wird gesperrt (5 Fehlversuche je Konto)', async () => {
    for (let i = 0; i < 5; i++) await tryLogin('ohne2fa', `falsch-${i}-xxxx`);
    // jetzt ist sogar das richtige Passwort gesperrt
    expect(await tryLogin('ohne2fa', PW)).toBe(false);
  }, 60_000);
});
