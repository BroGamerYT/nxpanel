import { sql } from '../db/index.js';
import { encrypt, decrypt } from '../crypto.js';

export interface SteamAccountRow {
  id: string;
  account_name: string;
  encrypted_password: string | null;
  steam_id: string | null;
  guard_status: 'none' | 'needed' | 'ok' | 'failed';
  guard_type: 'none' | 'email' | 'app';
  guard_code: string | null;
  guard_prompt: string | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SteamAccountPublic {
  id: string;
  accountName: string;
  steamId: string | null;
  hasPassword: boolean;
  guardStatus: 'none' | 'needed' | 'ok' | 'failed';
  guardType: 'none' | 'email' | 'app';
  guardPrompt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function listSteamAccounts(): Promise<SteamAccountPublic[]> {
  const rows = await sql<SteamAccountRow[]>`
    SELECT id, account_name, encrypted_password, steam_id, guard_status, guard_type,
           guard_code, guard_prompt, last_used_at, created_at, updated_at
    FROM steam_accounts
    ORDER BY account_name ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    accountName: r.account_name,
    steamId: r.steam_id,
    hasPassword: Boolean(r.encrypted_password),
    guardStatus: r.guard_status,
    guardType: r.guard_type,
    guardPrompt: r.guard_prompt,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function saveSteamAccount(input: {
  accountName: string;
  password?: string | null | undefined;
  steamId?: string | null | undefined;
}): Promise<SteamAccountPublic> {
  const encPw = input.password ? encrypt(input.password) : null;
  const [row] = await sql<SteamAccountRow[]>`
    INSERT INTO steam_accounts (account_name, encrypted_password, steam_id, guard_status, updated_at)
    VALUES (${input.accountName}, ${encPw}, ${input.steamId ?? null}, 'none', now())
    ON CONFLICT (account_name) DO UPDATE SET
      encrypted_password = COALESCE(EXCLUDED.encrypted_password, steam_accounts.encrypted_password),
      steam_id = COALESCE(EXCLUDED.steam_id, steam_accounts.steam_id),
      updated_at = now()
    RETURNING id, account_name, encrypted_password, steam_id, guard_status, guard_type,
              guard_code, guard_prompt, last_used_at, created_at, updated_at
  `;
  return {
    id: row!.id,
    accountName: row!.account_name,
    steamId: row!.steam_id,
    hasPassword: Boolean(row!.encrypted_password),
    guardStatus: row!.guard_status,
    guardType: row!.guard_type,
    guardPrompt: row!.guard_prompt,
    lastUsedAt: row!.last_used_at?.toISOString() ?? null,
    createdAt: row!.created_at.toISOString(),
  };
}

export async function submitSteamGuard(id: string, code: string): Promise<SteamAccountPublic> {
  const [row] = await sql<SteamAccountRow[]>`
    UPDATE steam_accounts
    SET guard_code = ${code.trim().toUpperCase()},
        guard_status = 'ok',
        guard_prompt = NULL,
        updated_at = now()
    WHERE id = ${id}
    RETURNING id, account_name, encrypted_password, steam_id, guard_status, guard_type,
              guard_code, guard_prompt, last_used_at, created_at, updated_at
  `;
  if (!row) throw new Error('Steam-Konto nicht gefunden');
  return {
    id: row.id,
    accountName: row.account_name,
    steamId: row.steam_id,
    hasPassword: Boolean(row.encrypted_password),
    guardStatus: row.guard_status,
    guardType: row.guard_type,
    guardPrompt: row.guard_prompt,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function requestSteamGuard(accountName: string, prompt: string, type: 'email' | 'app' = 'app'): Promise<void> {
  await sql`
    UPDATE steam_accounts
    SET guard_status = 'needed',
        guard_type = ${type},
        guard_prompt = ${prompt},
        updated_at = now()
    WHERE account_name = ${accountName}
  `;
}

export async function deleteSteamAccount(id: string): Promise<boolean> {
  const res = await sql`DELETE FROM steam_accounts WHERE id = ${id} RETURNING id`;
  return res.length > 0;
}

export async function getSteamCredentials(accountName: string): Promise<{ username: string; password: string | null; guardCode: string | null } | null> {
  const [row] = await sql<SteamAccountRow[]>`
    SELECT id, account_name, encrypted_password, guard_code FROM steam_accounts WHERE account_name = ${accountName}
  `;
  if (!row) return null;
  const password = row.encrypted_password ? decrypt(row.encrypted_password) : null;
  return {
    username: row.account_name,
    password,
    guardCode: row.guard_code,
  };
}
