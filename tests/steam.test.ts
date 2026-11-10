import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from '../src/db/index.js';
import { createUser } from '../src/auth/users.js';
import type { Actor } from '../src/auth/permissions.js';
import {
  saveSteamAccount,
  listSteamAccounts,
  requestSteamGuard,
  deleteSteamAccount,
  getSteamCredentials,
} from '../src/servers/steam.js';

// Steam-Konten gehoeren einem Nutzer (owner_id). Seit 0.23 bekommen alle
// Funktionen den handelnden Nutzer mit; Fremde sehen nur geteilte Konten.
let owner: Actor, other: Actor, admin: Actor;

describe('Steam-Kontenverwaltung', () => {
  beforeAll(async () => {
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await sql`TRUNCATE users, steam_accounts RESTART IDENTITY CASCADE`;
    const mk = async (username: string, role: 'admin' | 'user' = 'user'): Promise<Actor> => {
      const u = await createUser({ username, email: `${username}@t.local`, password: 'ein-langes-passwort', role });
      return { id: u.id, role, canCreateServers: true };
    };
    owner = await mk('besitzer');
    other = await mk('fremder');
    admin = await mk('chef', 'admin');
  });

  it('legt ein Konto an, speichert das Passwort verschluesselt und liefert es nur intern', async () => {
    const acc = await saveSteamAccount(owner, { accountName: 'test_bot_user', password: 'SuperSecretSteamPassword123!', steamId: '76561198000000000' });
    expect(acc.accountName).toBe('test_bot_user');
    expect(acc.hasPassword).toBe(true);
    expect(JSON.stringify(acc)).not.toContain('SuperSecret');

    const [row] = await sql<{ encrypted_password: string }[]>`SELECT encrypted_password FROM steam_accounts WHERE account_name = 'test_bot_user'`;
    expect(row!.encrypted_password).not.toContain('SuperSecret');

    const creds = await getSteamCredentials('test_bot_user');
    expect(creds?.password).toBe('SuperSecretSteamPassword123!');
  });

  it('private Konten sieht nur der Besitzer (und der Admin)', async () => {
    expect((await listSteamAccounts(owner)).map((a) => a.accountName)).toContain('test_bot_user');
    expect((await listSteamAccounts(admin)).map((a) => a.accountName)).toContain('test_bot_user');
    expect((await listSteamAccounts(other)).map((a) => a.accountName)).not.toContain('test_bot_user');
  });

  it('merkt sich eine Steam-Guard-Anforderung', async () => {
    await requestSteamGuard('test_bot_user', 'Bitte Code aus der Steam-App eingeben', 'app');
    const acc = (await listSteamAccounts(owner)).find((a) => a.accountName === 'test_bot_user')!;
    expect(acc.guardStatus).toBe('needed');
    expect(acc.guardPrompt).toContain('Steam-App');
  });

  it('nur Besitzer oder Admin duerfen loeschen', async () => {
    const acc = (await listSteamAccounts(owner)).find((a) => a.accountName === 'test_bot_user')!;
    await expect(deleteSteamAccount(other, acc.id)).rejects.toThrow(/Berechtigung/);
    expect(await deleteSteamAccount(owner, acc.id)).toBe(true);
    expect(await getSteamCredentials('test_bot_user')).toBeNull();
  });
});
