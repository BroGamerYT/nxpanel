import { randomBytes } from 'node:crypto';
import { sql } from '../db/index.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * SFTP-Passwoerter: zufaellig erzeugt, nur einmal im Klartext angezeigt,
 * gespeichert als Hash. Fuer Konten mit Zwei-Faktor-Schutz der einzige Weg
 * per SFTP; ohne 2FA zusaetzlich zum normalen Passwort nutzbar.
 */
export const MAX_SFTP_PASSWORDS = 10;

export interface SftpPasswordInfo { id: string; label: string; createdAt: string; lastUsedAt: string | null }

export async function listSftpPasswords(userId: string): Promise<SftpPasswordInfo[]> {
  const rows = await sql<{ id: string; label: string; created_at: Date; last_used_at: Date | null }[]>`
    SELECT id, label, created_at, last_used_at FROM sftp_passwords WHERE user_id = ${userId} ORDER BY created_at`;
  return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null }));
}

/** Legt ein neues Passwort an und liefert es EINMAL im Klartext zurueck. */
export async function createSftpPassword(userId: string, label: string): Promise<{ info: SftpPasswordInfo; password: string }> {
  const [cnt] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sftp_passwords WHERE user_id = ${userId}`;
  if ((cnt?.n ?? 0) >= MAX_SFTP_PASSWORDS) throw new Error(`Höchstens ${MAX_SFTP_PASSWORDS} SFTP-Passwörter je Konto`);
  // 4 Gruppen a 6 Zeichen, gut abzutippen: abcdef-ghijkl-...
  const raw = randomBytes(18).toString('base64url').replace(/[-_]/g, 'x').slice(0, 24).toLowerCase();
  const password = raw.match(/.{6}/g)!.join('-');
  const [row] = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO sftp_passwords (user_id, label, password_hash)
    VALUES (${userId}, ${label}, ${await hashPassword(password)}) RETURNING id, created_at`;
  return { info: { id: row!.id, label, createdAt: row!.created_at.toISOString(), lastUsedAt: null }, password };
}

export async function deleteSftpPassword(userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = await sql`DELETE FROM sftp_passwords WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  return r.length > 0;
}

/** Prueft das Passwort gegen alle SFTP-Passwoerter des Kontos; merkt sich die Nutzung. */
export async function verifySftpPassword(userId: string, password: string): Promise<boolean> {
  const rows = await sql<{ id: string; password_hash: string }[]>`
    SELECT id, password_hash FROM sftp_passwords WHERE user_id = ${userId}`;
  for (const r of rows) {
    if (await verifyPassword(r.password_hash, password)) {
      await sql`UPDATE sftp_passwords SET last_used_at = now() WHERE id = ${r.id}`;
      return true;
    }
  }
  return false;
}
