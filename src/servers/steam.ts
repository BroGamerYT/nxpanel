import { sql } from '../db/index.js';
import { encrypt, decrypt } from '../crypto.js';
import { engine } from '../docker/client.js';
import type { Actor } from '../auth/permissions.js';

export interface SteamAccountRow {
  id: string;
  owner_id: string | null;
  label: string | null;
  is_shared: boolean;
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
  owner_name?: string | null;
}

export interface SteamAccountPublic {
  id: string;
  ownerId: string | null;
  ownerName: string | null;
  isOwner: boolean;
  isShared: boolean;
  label: string;
  accountName: string;
  steamId: string | null;
  hasPassword: boolean;
  guardStatus: 'none' | 'needed' | 'ok' | 'failed';
  guardType: 'none' | 'email' | 'app';
  guardPrompt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function listSteamAccounts(actor: Actor): Promise<SteamAccountPublic[]> {
  const isAdmin = actor.role === 'admin';
  const rows = await sql<SteamAccountRow[]>`
    SELECT s.id, s.owner_id, s.label, s.is_shared, s.account_name, s.encrypted_password,
           s.steam_id, s.guard_status, s.guard_type, s.guard_code, s.guard_prompt,
           s.last_used_at, s.created_at, s.updated_at,
           u.username AS owner_name
    FROM steam_accounts s
    LEFT JOIN users u ON u.id = s.owner_id
    ${isAdmin ? sql`` : sql`WHERE s.owner_id = ${actor.id} OR s.is_shared = true`}
    ORDER BY s.is_shared ASC, s.created_at DESC
  `;

  return rows.map((r) => {
    const isOwner = isAdmin || r.owner_id === actor.id;
    return {
      id: r.id,
      ownerId: r.owner_id,
      ownerName: r.owner_name ?? (r.owner_id ? 'Unbekannt' : 'System'),
      isOwner,
      isShared: Boolean(r.is_shared),
      label: r.label || r.account_name,
      accountName: r.account_name,
      steamId: r.steam_id,
      hasPassword: Boolean(r.encrypted_password),
      guardStatus: r.guard_status,
      guardType: r.guard_type,
      guardPrompt: r.guard_prompt,
      lastUsedAt: r.last_used_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    };
  });
}

export async function saveSteamAccount(
  actor: Actor & { username?: string },
  input: {
    id?: string | undefined;
    label?: string | undefined;
    accountName: string;
    password?: string | null | undefined;
    steamId?: string | null | undefined;
    isShared?: boolean | undefined;
  },
): Promise<SteamAccountPublic> {
  const encPw = input.password ? encrypt(input.password) : null;
  const isShared = Boolean(input.isShared);
  const label = input.label?.trim() || input.accountName.trim();

  let row: SteamAccountRow | undefined;

  if (input.id) {
    // Vorhandenes Konto aktualisieren - Pruefen ob Berechtigung vorliegt
    const [existing] = await sql<SteamAccountRow[]>`SELECT * FROM steam_accounts WHERE id = ${input.id}`;
    if (!existing) throw new Error('Steam-Konto nicht gefunden');
    if (actor.role !== 'admin' && existing.owner_id !== actor.id) {
      throw new Error('Keine Berechtigung, dieses Steam-Konto zu bearbeiten');
    }

    [row] = await sql<SteamAccountRow[]>`
      UPDATE steam_accounts
      SET label = ${label},
          account_name = ${input.accountName.trim()},
          encrypted_password = COALESCE(${encPw}, encrypted_password),
          steam_id = COALESCE(${input.steamId ?? null}, steam_id),
          is_shared = ${isShared},
          updated_at = now()
      WHERE id = ${input.id}
      RETURNING *
    `;
  } else {
    // Neues Konto hinzufuegen
    [row] = await sql<SteamAccountRow[]>`
      INSERT INTO steam_accounts (owner_id, label, account_name, encrypted_password, steam_id, is_shared, guard_status, updated_at)
      VALUES (${actor.id}, ${label}, ${input.accountName.trim()}, ${encPw}, ${input.steamId ?? null}, ${isShared}, 'none', now())
      ON CONFLICT (account_name) DO UPDATE SET
        label = EXCLUDED.label,
        encrypted_password = COALESCE(EXCLUDED.encrypted_password, steam_accounts.encrypted_password),
        steam_id = COALESCE(EXCLUDED.steam_id, steam_accounts.steam_id),
        is_shared = EXCLUDED.is_shared,
        updated_at = now()
      RETURNING *
    `;
  }

  if (!row) throw new Error('Fehler beim Speichern des Steam-Kontos');

  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: actor.username ?? 'Benutzer',
    isOwner: true,
    isShared: Boolean(row.is_shared),
    label: row.label || row.account_name,
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

export async function testSteamAccount(
  actor: Actor & { username?: string },
  id: string,
  guardCode?: string,
): Promise<{
  status: 'ok' | 'needed' | 'failed';
  guardType?: 'none' | 'email' | 'app';
  message: string;
  account: SteamAccountPublic;
}> {
  const [existing] = await sql<SteamAccountRow[]>`SELECT * FROM steam_accounts WHERE id = ${id}`;
  if (!existing) throw new Error('Steam-Konto nicht gefunden');
  if (actor.role !== 'admin' && existing.owner_id !== actor.id && !existing.is_shared) {
    throw new Error('Keine Berechtigung fuer dieses Steam-Konto');
  }

  if (!existing.encrypted_password) {
    throw new Error('Kein Passwort fuer dieses Steam-Konto hinterlegt');
  }

  const password = decrypt(existing.encrypted_password);
  const codeToTry = guardCode?.trim().toUpperCase() || existing.guard_code || undefined;

  const cmd = ['+login', existing.account_name, password];
  if (codeToTry) {
    cmd.push(codeToTry);
  }
  cmd.push('+quit');

  let output = '';
  try {
    const res = await engine.runOneOff('steamcmd/steamcmd:latest', cmd, 35000);
    output = res.output;
  } catch (err: any) {
    return {
      status: 'failed',
      message: `Testlauf fehlgeschlagen: ${err?.message || 'Verbindungsfehler zu Steam'}`,
      account: (await listSteamAccounts(actor)).find((a) => a.id === id)!,
    };
  }

  const out = output.toLowerCase();

  // 1. Falsches Passwort
  if (out.includes('invalid password') || out.includes('error (invalid password)')) {
    await sql`
      UPDATE steam_accounts
      SET guard_status = 'failed',
          guard_prompt = 'Passwort oder Benutzername falsch',
          updated_at = now()
      WHERE id = ${id}
    `;
    const updated = (await listSteamAccounts(actor)).find((a) => a.id === id)!;
    return {
      status: 'failed',
      message: 'Steam-Passwort oder Benutzername ist falsch (Invalid Password).',
      account: updated,
    };
  }

  // 2. Steam Guard Code war falsch oder abgelaufen
  if (codeToTry && (out.includes('twofactorcodemismatch') || out.includes('invalid code') || out.includes('code mismatch'))) {
    await sql`
      UPDATE steam_accounts
      SET guard_status = 'needed',
          guard_type = 'app',
          guard_prompt = 'Der eingegebene Steam-Guard-Code war ungültig oder abgelaufen',
          updated_at = now()
      WHERE id = ${id}
    `;
    const updated = (await listSteamAccounts(actor)).find((a) => a.id === id)!;
    return {
      status: 'needed',
      guardType: 'app',
      message: 'Der Steam-Guard-Code war ungültig oder abgelaufen. Bitte generiere einen neuen Code in der Steam-App.',
      account: updated,
    };
  }

  // 3. Steam Guard wird benötigt
  const needsGuard =
    out.includes('twofactorcodemismatch') ||
    out.includes('accountlogondenied') ||
    out.includes('steam guard') ||
    out.includes('two-factor code') ||
    out.includes('mobile authenticator');

  const loginSuccess =
    out.includes('waiting for user info...ok') ||
    out.includes('waiting for license info...ok') ||
    (out.includes('logging in user') && out.includes('...ok'));

  if (needsGuard && !loginSuccess) {
    const isApp = out.includes('mobile') || out.includes('twofactor') || out.includes('authenticator');
    const guardType: 'app' | 'email' = isApp ? 'app' : 'email';
    const prompt = isApp
      ? 'Steam Guard Mobile Authenticator Code erforderlich'
      : 'Steam Guard Bestätigungscode per E-Mail gesendet';

    await sql`
      UPDATE steam_accounts
      SET guard_status = 'needed',
          guard_type = ${guardType},
          guard_prompt = ${prompt},
          updated_at = now()
      WHERE id = ${id}
    `;
    const updated = (await listSteamAccounts(actor)).find((a) => a.id === id)!;
    return {
      status: 'needed',
      guardType,
      message: isApp
        ? 'Steam Guard ist aktiv! Bitte gib den Code aus deiner Steam-App ein.'
        : 'Steam Guard ist aktiv! Ein Bestätigungscode wurde per E-Mail gesendet.',
      account: updated,
    };
  }

  // 4. Erfolgreich eingeloggt
  if (loginSuccess) {
    await sql`
      UPDATE steam_accounts
      SET guard_status = 'ok',
          guard_code = ${codeToTry ?? null},
          guard_prompt = NULL,
          last_used_at = now(),
          updated_at = now()
      WHERE id = ${id}
    `;
    const updated = (await listSteamAccounts(actor)).find((a) => a.id === id)!;
    return {
      status: 'ok',
      message: 'Steam-Verbindung erfolgreich hergestellt und verifiziert!',
      account: updated,
    };
  }

  // 5. Rate Limit
  if (out.includes('ratelimitexceeded')) {
    return {
      status: 'failed',
      message: 'Steam meldet zu viele Fehlversuche (RateLimitExceeded). Bitte kurz warten.',
      account: (await listSteamAccounts(actor)).find((a) => a.id === id)!,
    };
  }

  // Fallback
  return {
    status: 'failed',
    message: `Unerwartete Steam-Antwort: ${output.slice(0, 150)}`,
    account: (await listSteamAccounts(actor)).find((a) => a.id === id)!,
  };
}

export async function submitSteamGuard(
  actor: Actor & { username?: string },
  id: string,
  code: string,
): Promise<{
  status: 'ok' | 'needed' | 'failed';
  guardType?: 'none' | 'email' | 'app';
  message: string;
  account: SteamAccountPublic;
}> {
  return testSteamAccount(actor, id, code);
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

export async function deleteSteamAccount(actor: Actor, id: string): Promise<boolean> {
  const [existing] = await sql<SteamAccountRow[]>`SELECT owner_id FROM steam_accounts WHERE id = ${id}`;
  if (!existing) return false;
  if (actor.role !== 'admin' && existing.owner_id !== actor.id) {
    throw new Error('Keine Berechtigung zum Löschen dieses Steam-Kontos');
  }

  const res = await sql`DELETE FROM steam_accounts WHERE id = ${id} RETURNING id`;
  return res.length > 0;
}

export async function getSteamCredentials(accountNameOrId: string): Promise<{ username: string; password: string | null; guardCode: string | null } | null> {
  const [row] = await sql<SteamAccountRow[]>`
    SELECT id, account_name, encrypted_password, guard_code FROM steam_accounts
    WHERE account_name = ${accountNameOrId} OR id::text = ${accountNameOrId}
    LIMIT 1
  `;
  if (!row) return null;
  const password = row.encrypted_password ? decrypt(row.encrypted_password) : null;
  return {
    username: row.account_name,
    password,
    guardCode: row.guard_code,
  };
}
