import { SignJWT, jwtVerify, errors } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = 'nxpanel';
const AUDIENCE = 'nxpanel-api';

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
}

/**
 * Kurzlebiger Zugangstoken. Er enthaelt bewusst KEINE Rolle und keine
 * Rechte: die werden bei jeder Anfrage frisch aus der Datenbank gelesen.
 * Wird jemand gesperrt oder herabgestuft, wirkt das sofort - nicht erst
 * nach Ablauf des Tokens.
 */
export async function signAccessToken(c: AccessClaims): Promise<string> {
  return new SignJWT({ sid: c.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(c.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_S}s`)
    .sign(secret);
}

export type VerifyResult =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: 'expired' | 'invalid' };

export async function verifyAccessToken(token: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, claims: { sub: payload.sub, sid: payload.sid } };
  } catch (err) {
    if (err instanceof errors.JWTExpired) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

/** Refresh-Token: 32 Zufallsbytes, kein JWT - er hat nur in der DB eine Bedeutung. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
