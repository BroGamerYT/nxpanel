import { sql } from '../db/index.js';
import { hashToken, newRefreshToken, REFRESH_TOKEN_TTL_S } from './tokens.js';
import { writeAudit } from '../audit.js';

/**
 * Sitzungen mit Refresh-Token-Rotation:
 *
 *  - Jeder Refresh verbraucht den alten Token und erzeugt einen neuen in
 *    derselben "Familie".
 *  - Taucht ein bereits verbrauchter Token erneut auf, hat ihn jemand
 *    kopiert. Dann wird die ganze Familie beendet - Angreifer UND echter
 *    Nutzer muessen sich neu anmelden, aber der Angreifer ist draussen.
 *  - Kleine Ausnahme: zwei Browser-Tabs, die im selben Moment erneuern.
 *    Innerhalb von GRACE_MS nach der Rotation gilt ein Wiederholer als
 *    harmlos und bekommt nur ein 401, ohne die Familie zu beenden.
 */
const GRACE_MS = 15_000;

/**
 * Rotierte Glieder zaehlen beim Beenden mit: ihr Access-Token darf bis zu
 * 15 Minuten weiterleben (loadAuthContext laesst 'rotated' zu). Wer sich
 * abmeldet, will aber, dass AUCH dieser Token sofort tot ist.
 */
const STILL_VALID = sql`(revoked_at IS NULL OR revoke_reason = 'rotated')`;

export interface SessionMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function createSession(userId: string, meta: SessionMeta, familyId?: string): Promise<IssuedSession> {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, refresh_token, user_agent, ip, expires_at, family_id)
    VALUES (${userId}, ${hashToken(refreshToken)}, ${meta.userAgent?.slice(0, 300) ?? null},
            ${meta.ip ?? null}, ${expiresAt}, ${familyId ?? sql`gen_random_uuid()`})
    RETURNING id
  `;
  return { sessionId: row!.id, refreshToken, expiresAt };
}

export type RotateResult =
  | { ok: true; userId: string; session: IssuedSession }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' | 'race' | 'suspended' };

interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_at: Date | null;
  replaced_by: string | null;
  created_at: Date;
  suspended: boolean;
  password_changed_at: Date;
}

export async function rotateSession(refreshToken: string, meta: SessionMeta): Promise<RotateResult> {
  return sql.begin(async (tx) => {
    // FOR UPDATE: zwei gleichzeitige Refreshes mit demselben Token werden
    // nacheinander abgearbeitet - nur einer bekommt einen neuen Token.
    const [s] = await tx<SessionRow[]>`
      SELECT s.id, s.user_id, s.family_id, s.expires_at, s.revoked_at, s.rotated_at, s.replaced_by, s.created_at,
             u.suspended, u.password_changed_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token = ${hashToken(refreshToken)}
      FOR UPDATE OF s
    `;
    if (!s) return { ok: false, reason: 'unknown' } as const;

    if (s.rotated_at) {
      if (Date.now() - s.rotated_at.getTime() < GRACE_MS) {
        if (s.replaced_by) {
          const [rep] = await tx<{ id: string; user_id: string; expires_at: Date }[]>`
            SELECT id, user_id, expires_at FROM sessions
            WHERE id = ${s.replaced_by} AND (revoked_at IS NULL OR revoke_reason = 'rotated')
          `;
          if (rep && rep.expires_at.getTime() > Date.now()) {
            return {
              ok: true,
              userId: rep.user_id,
              session: { sessionId: rep.id, refreshToken: '', expiresAt: rep.expires_at },
            } as const;
          }
        }
        return { ok: false, reason: 'race' } as const;
      }
      await tx`
        UPDATE sessions SET revoked_at = now(), revoke_reason = 'reuse_detected'
        WHERE family_id = ${s.family_id} AND ${STILL_VALID}
      `;
      await writeAudit({
        userId: s.user_id,
        action: 'auth.refresh_reuse',
        metadata: { familyId: s.family_id },
        ip: meta.ip,
      }, tx);
      return { ok: false, reason: 'reused' } as const;
    }
    if (s.revoked_at) return { ok: false, reason: 'revoked' } as const;
    if (s.expires_at.getTime() < Date.now()) return { ok: false, reason: 'expired' } as const;
    if (s.suspended) return { ok: false, reason: 'suspended' } as const;
    if (s.password_changed_at > s.created_at) return { ok: false, reason: 'revoked' } as const;

    const next = newRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000);
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO sessions (user_id, refresh_token, user_agent, ip, expires_at, family_id)
      VALUES (${s.user_id}, ${hashToken(next)}, ${meta.userAgent?.slice(0, 300) ?? null},
              ${meta.ip ?? null}, ${expiresAt}, ${s.family_id})
      RETURNING id
    `;
    // Die alte Sitzung bleibt als "rotiert" stehen - nur so laesst sich
    // eine spaetere Wiederverwendung ueberhaupt erkennen.
    await tx`
      UPDATE sessions
      SET rotated_at = now(), replaced_by = ${created!.id}, revoked_at = now(), revoke_reason = 'rotated'
      WHERE id = ${s.id}
    `;
    return {
      ok: true,
      userId: s.user_id,
      session: { sessionId: created!.id, refreshToken: next, expiresAt },
    } as const;
  });
}

/** Abmelden: die ganze Familie beenden, nicht nur das aktuelle Glied. */
export async function revokeSessionFamily(sessionId: string, reason = 'logout'): Promise<void> {
  await sql`
    UPDATE sessions SET revoked_at = now(), revoke_reason = ${reason}
    WHERE family_id = (SELECT family_id FROM sessions WHERE id = ${sessionId})
      AND ${STILL_VALID}
  `;
}

export async function revokeAllUserSessions(userId: string, reason: string): Promise<number> {
  const rows = await sql`
    UPDATE sessions SET revoked_at = now(), revoke_reason = ${reason}
    WHERE user_id = ${userId} AND ${STILL_VALID}
    RETURNING id
  `;
  return rows.length;
}

export interface ActiveSession {
  id: string;
  family_id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
}

export async function listActiveSessions(userId: string): Promise<ActiveSession[]> {
  return sql<ActiveSession[]>`
    SELECT id, family_id, user_agent, host(ip) AS ip, created_at, last_used_at, expires_at
    FROM sessions
    WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now()
    ORDER BY created_at DESC
  `;
}
