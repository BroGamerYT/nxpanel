import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from '../src/db/index.js';
import {
  saveSteamAccount,
  listSteamAccounts,
  submitSteamGuard,
  requestSteamGuard,
  deleteSteamAccount,
  getSteamCredentials,
} from '../src/servers/steam.js';

describe('Steam-Kontenverwaltung', () => {
  beforeAll(async () => {
    // Migrationen sicherstellen
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
  });

  it('kann ein Konto anlegen, verschlüsselt speichern und abfragen', async () => {
    const acc = await saveSteamAccount({
      accountName: 'test_bot_user',
      password: 'SuperSecretSteamPassword123!',
      steamId: '76561198000000000',
    });

    expect(acc.accountName).toBe('test_bot_user');
    expect(acc.hasPassword).toBe(true);
    expect(acc.guardStatus).toBe('none');

    const creds = await getSteamCredentials('test_bot_user');
    expect(creds).not.toBeNull();
    expect(creds?.username).toBe('test_bot_user');
    expect(creds?.password).toBe('SuperSecretSteamPassword123!');

    const list = await listSteamAccounts();
    const found = list.find((a) => a.accountName === 'test_bot_user');
    expect(found).toBeDefined();
    expect(found?.steamId).toBe('76561198000000000');
  });

  it('unterstützt Guard-Anforderung und Code-Eingabe', async () => {
    await requestSteamGuard('test_bot_user', 'Bitte Code aus der Steam-App eingeben', 'app');

    let list = await listSteamAccounts();
    let acc = list.find((a) => a.accountName === 'test_bot_user')!;
    expect(acc.guardStatus).toBe('needed');
    expect(acc.guardPrompt).toContain('Steam-App');

    await submitSteamGuard(acc.id, 'abc12');

    const creds = await getSteamCredentials('test_bot_user');
    expect(creds?.guardCode).toBe('ABC12');

    list = await listSteamAccounts();
    acc = list.find((a) => a.accountName === 'test_bot_user')!;
    expect(acc.guardStatus).toBe('ok');
    expect(acc.guardPrompt).toBeNull();
  });

  it('kann ein Konto löschen', async () => {
    const list = await listSteamAccounts();
    const acc = list.find((a) => a.accountName === 'test_bot_user')!;
    const ok = await deleteSteamAccount(acc.id);
    expect(ok).toBe(true);

    const creds = await getSteamCredentials('test_bot_user');
    expect(creds).toBeNull();
  });
});
