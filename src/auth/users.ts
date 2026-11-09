import { sql } from '../db/index.js';
import { hashPassword, checkPasswordPolicy } from './password.js';
import type { Actor, Role } from './permissions.js';

export interface UserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  role: Role;
  can_create_servers: boolean;
  allowed_eggs: string[] | null;
  totp_enabled: boolean;
  suspended: boolean;
  avatar?: string | null;
  steam_id?: string | null;
  steam_name?: string | null;
  created_at: Date;
  last_login_at: Date | null;
}

/** Oeffentliche Sicht auf einen Nutzer - nie Hash oder TOTP-Geheimnis herausgeben. */
export function publicUser(u: Pick<UserRow, 'id' | 'email' | 'username' | 'role' | 'can_create_servers' | 'totp_enabled'> & {
  locale?: string | null;
  allowed_eggs?: string[] | null;
  avatar?: string | null;
  steam_id?: string | null;
  steam_name?: string | null;
}) {
  return {
    locale: u.locale ?? null,
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    canCreateServers: u.can_create_servers,
    allowedEggs: u.allowed_eggs ?? null,
    totpEnabled: u.totp_enabled,
    avatar: u.avatar ?? null,
    steamId: u.steam_id ?? null,
    steamName: u.steam_name ?? null,
  };
}

export async function findUserForLogin(login: string): Promise<UserRow | null> {
  const l = login.trim().toLowerCase();
  const [u] = await sql<UserRow[]>`
    SELECT * FROM users WHERE lower(email) = ${l} OR lower(username) = ${l} LIMIT 1
  `;
  return u ?? null;
}

export class UserInputError extends Error {}

export interface NewUser {
  email: string;
  username: string;
  password: string;
  role?: Role | undefined;
  canCreateServers?: boolean | undefined;
  allowedEggs?: string[] | null | undefined;
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export async function createUser(n: NewUser): Promise<UserRow> {
  if (!USERNAME_RE.test(n.username)) throw new UserInputError('Benutzername: 3-32 Zeichen, nur Buchstaben, Ziffern, _ . -');
  if (!EMAIL_RE.test(n.email)) throw new UserInputError('E-Mail-Adresse ungueltig');
  const policy = checkPasswordPolicy(n.password);
  if (policy) throw new UserInputError(policy);

  const [dupe] = await sql`
    SELECT 1 FROM users WHERE lower(email) = ${n.email.toLowerCase()} OR lower(username) = ${n.username.toLowerCase()}
  `;
  if (dupe) throw new UserInputError('E-Mail oder Benutzername ist schon vergeben');

  const hash = await hashPassword(n.password);
  const [u] = await sql<UserRow[]>`
    INSERT INTO users (email, username, password_hash, role, can_create_servers, allowed_eggs)
    VALUES (${n.email.trim()}, ${n.username.trim()}, ${hash}, ${n.role ?? 'user'},
            ${n.canCreateServers ?? n.role === 'admin'},
            ${n.allowedEggs ? sql.json(n.allowedEggs) : null})
    RETURNING *
  `;
  return u!;
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const policy = checkPasswordPolicy(password);
  if (policy) throw new UserInputError(policy);
  const hash = await hashPassword(password);
  // password_changed_at sorgt dafuer, dass alle aelteren Sitzungen ungueltig werden.
  await sql`UPDATE users SET password_hash = ${hash}, password_changed_at = now() WHERE id = ${userId}`;
}

export interface AuthContext extends Actor {
  username: string;
  sessionId: string;
}

/**
 * Wird bei JEDER authentifizierten Anfrage aufgerufen: Sitzung noch aktiv,
 * Nutzer nicht gesperrt, Rolle aktuell. Eine einzige Abfrage ueber den
 * Primaerschluessel - billig genug, und Rechteentzug wirkt sofort.
 */
export async function loadAuthContext(userId: string, sessionId: string): Promise<AuthContext | null> {
  const [row] = await sql<{ id: string; username: string; role: Role; can_create_servers: boolean; allowed_eggs: string[] | null }[]>`
    SELECT u.id, u.username, u.role, u.can_create_servers, u.allowed_eggs
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sessionId} AND u.id = ${userId}
      AND u.suspended = false
      AND s.expires_at > now()
      AND (s.revoked_at IS NULL OR s.revoke_reason = 'rotated')
      AND s.created_at >= u.password_changed_at
  `;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    canCreateServers: row.can_create_servers,
    allowedEggs: row.allowed_eggs ?? null,
    sessionId,
  };
}
