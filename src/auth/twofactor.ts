import type { Sql, TransactionSql } from 'postgres';
import { sql } from '../db/index.js';
import { encrypt, decrypt } from '../crypto.js';
import { hashToken } from './tokens.js';
import {
  generateSecret, verifyTotp, otpauthUrl, generateRecoveryCode, normalizeRecoveryCode,
} from './totp.js';

export const RECOVERY_CODE_COUNT = 10;

export class TwoFactorError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** Schritt 1: Geheimnis erzeugen, verschluesselt als "ausstehend" ablegen. */
export async function startTotpSetup(userId: string, account: string) {
  const [u] = await sql<{ totp_enabled: boolean }[]>`SELECT totp_enabled FROM users WHERE id = ${userId}`;
  if (u?.totp_enabled) throw new TwoFactorError('Zwei-Faktor ist bereits aktiv', 'totp_already_enabled');
  const secret = generateSecret();
  await sql`UPDATE users SET totp_pending_secret = ${encrypt(secret)} WHERE id = ${userId}`;
  return { secret, otpauthUrl: otpauthUrl(secret, account) };
}

/** Schritt 2: erster richtiger Code schaltet scharf und liefert die Wiederherstellungscodes - einmalig. */
export async function enableTotp(userId: string, code: string): Promise<string[]> {
  const [u] = await sql<{ totp_pending_secret: string | null; totp_enabled: boolean }[]>`
    SELECT totp_pending_secret, totp_enabled FROM users WHERE id = ${userId}`;
  if (u?.totp_enabled) throw new TwoFactorError('Zwei-Faktor ist bereits aktiv', 'totp_already_enabled');
  if (!u?.totp_pending_secret) throw new TwoFactorError('Erst die Einrichtung starten', 'totp_no_setup');

  const secret = decrypt(u.totp_pending_secret);
  const step = verifyTotp(secret, code, 0);
  if (step === null) throw new TwoFactorError('Code stimmt nicht - Uhrzeit am Handy pruefen', 'totp_invalid');

  return sql.begin(async (tx) => {
    await tx`
      UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
                       totp_enabled = true, totp_last_step = ${step}
      WHERE id = ${userId}`;
    return replaceRecoveryCodes(userId, tx);
  });
}

async function replaceRecoveryCodes(userId: string, tx: Sql | TransactionSql): Promise<string[]> {
  const db = tx as Sql;
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await db`DELETE FROM recovery_codes WHERE user_id = ${userId}`;
  await db`INSERT INTO recovery_codes ${db(codes.map((c) => ({ user_id: userId, code_hash: hashToken(normalizeRecoveryCode(c)) })))}`;
  return codes;
}

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  return sql.begin((tx) => replaceRecoveryCodes(userId, tx));
}

export async function disableTotp(userId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = 0 WHERE id = ${userId}`;
    await tx`DELETE FROM recovery_codes WHERE user_id = ${userId}`;
  });
}

export interface SecondFactor {
  totp?: string | undefined;
  recoveryCode?: string | undefined;
}

export type SecondFactorResult = { ok: true; via: 'totp' | 'recovery'; remainingRecovery?: number } | { ok: false };

/**
 * Prueft den zweiten Faktor. Beides ist atomar: der Zeitschritt wird nur
 * hochgesetzt, wenn er noch kleiner ist, ein Wiederherstellungscode nur
 * verbraucht, wenn er noch frei ist. Zwei gleichzeitige Anmeldungen mit
 * demselben Code kommen also nicht beide durch.
 */
export async function checkSecondFactor(userId: string, f: SecondFactor): Promise<SecondFactorResult> {
  if (f.totp) {
    const [u] = await sql<{ totp_secret: string | null; totp_last_step: string }[]>`
      SELECT totp_secret, totp_last_step FROM users WHERE id = ${userId}`;
    if (!u?.totp_secret) return { ok: false };
    const step = verifyTotp(decrypt(u.totp_secret), f.totp, Number(u.totp_last_step));
    if (step === null) return { ok: false };
    const updated = await sql`
      UPDATE users SET totp_last_step = ${step} WHERE id = ${userId} AND totp_last_step < ${step} RETURNING id`;
    return updated.length ? { ok: true, via: 'totp' } : { ok: false };
  }
  if (f.recoveryCode) {
    const hash = hashToken(normalizeRecoveryCode(f.recoveryCode));
    const used = await sql`
      UPDATE recovery_codes SET used_at = now()
      WHERE user_id = ${userId} AND code_hash = ${hash} AND used_at IS NULL RETURNING id`;
    if (!used.length) return { ok: false };
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = ${userId} AND used_at IS NULL`;
    return { ok: true, via: 'recovery', remainingRecovery: r?.n ?? 0 };
  }
  return { ok: false };
}
