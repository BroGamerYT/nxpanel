import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import { sql } from '../db/index.js';
import { config } from '../config.js';
import type { UserRow } from './users.js';

export interface PasskeyRecord {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  device_name: string;
  transports: string[];
  created_at: Date;
  last_used_at: Date | null;
}

interface StoredChallenge {
  challenge: string;
  userId?: string | undefined;
  expires: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challenges = new Map<string, StoredChallenge>();

function sweepChallenges() {
  const now = Date.now();
  for (const [k, v] of challenges.entries()) {
    if (v.expires < now) challenges.delete(k);
  }
}
setInterval(sweepChallenges, 60_000).unref();

export function getRpInfo(hostHeader?: string) {
  let hostname = 'localhost';
  try {
    if (hostHeader) {
      hostname = hostHeader.split(':')[0] || 'localhost';
    } else {
      hostname = new URL(config.PANEL_URL).hostname;
    }
  } catch {
    hostname = 'localhost';
  }
  return {
    rpName: 'NexusPanel',
    rpID: hostname,
  };
}

export function getExpectedOrigins(hostHeader?: string): string[] {
  const origins = new Set<string>();
  try {
    origins.add(config.PANEL_URL.replace(/\/$/, ''));
  } catch {}
  if (hostHeader) {
    origins.add(`https://${hostHeader}`);
    origins.add(`http://${hostHeader}`);
  }
  origins.add('http://localhost:8080');
  origins.add('http://127.0.0.1:8080');
  origins.add('http://localhost:5173');
  return Array.from(origins);
}

export async function createPasskeyRegistrationOptions(user: UserRow, hostHeader?: string) {
  const { rpName, rpID } = getRpInfo(hostHeader);
  const existing = await sql<{ credential_id: string; transports: string[] }[]>`
    SELECT credential_id, transports FROM passkeys WHERE user_id = ${user.id}
  `;

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.username,
    userDisplayName: user.steam_name || user.username,
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({
      id: p.credential_id,
      transports: p.transports as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const challengeId = randomBytes(24).toString('hex');
  challenges.set(challengeId, {
    challenge: options.challenge,
    userId: user.id,
    expires: Date.now() + CHALLENGE_TTL_MS,
  });

  return { challengeId, options };
}

export async function verifyPasskeyRegistrationResult(
  user: UserRow,
  challengeId: string,
  response: RegistrationResponseJSON,
  deviceName: string,
  hostHeader?: string
) {
  const stored = challenges.get(challengeId);
  if (!stored || stored.userId !== user.id || stored.expires < Date.now()) {
    throw new Error('Sicherheits-Challenge ungültig oder abgelaufen');
  }
  challenges.delete(challengeId);

  const { rpID } = getRpInfo(hostHeader);
  const expectedOrigin = getExpectedOrigins(hostHeader);

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Passkey-Verifizierung fehlgeschlagen');
  }

  const { credential } = verification.registrationInfo;
  const transports = response.response.transports || [];

  const [row] = await sql<PasskeyRecord[]>`
    INSERT INTO passkeys (user_id, credential_id, public_key, counter, device_name, transports)
    VALUES (
      ${user.id},
      ${credential.id},
      ${Buffer.from(credential.publicKey)},
      ${credential.counter},
      ${deviceName.slice(0, 100) || 'Sicherheitsschlüssel / Passkey'},
      ${transports}
    )
    RETURNING id, credential_id, device_name, created_at
  `;

  return row!;
}

export async function createPasskeyAuthenticationOptions(username?: string, hostHeader?: string) {
  const { rpID } = getRpInfo(hostHeader);
  let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] | undefined;

  let targetUserId: string | undefined;
  if (username) {
    const [u] = await sql<{ id: string }[]>`
      SELECT id FROM users
      WHERE lower(username) = lower(${username.trim()})
         OR (email IS NOT NULL AND lower(email) = lower(${username.trim()}))
    `;
    if (u) {
      targetUserId = u.id;
      const passkeys = await sql<{ credential_id: string; transports: string[] }[]>`
        SELECT credential_id, transports FROM passkeys WHERE user_id = ${u.id}
      `;
      if (passkeys.length > 0) {
        allowCredentials = passkeys.map((p) => ({
          id: p.credential_id,
          transports: p.transports as AuthenticatorTransport[],
        }));
      }
    }
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    ...(allowCredentials ? { allowCredentials } : {}),
  });

  const challengeId = randomBytes(24).toString('hex');
  challenges.set(challengeId, {
    challenge: options.challenge,
    userId: targetUserId,
    expires: Date.now() + CHALLENGE_TTL_MS,
  });

  return { challengeId, options };
}

export async function verifyPasskeyAuthenticationResult(
  challengeId: string,
  response: AuthenticationResponseJSON,
  hostHeader?: string
) {
  const stored = challenges.get(challengeId);
  if (!stored || stored.expires < Date.now()) {
    throw new Error('Sicherheits-Challenge ungültig oder abgelaufen');
  }
  challenges.delete(challengeId);

  const [pk] = await sql<PasskeyRecord[]>`
    SELECT * FROM passkeys WHERE credential_id = ${response.id}
  `;
  if (!pk) {
    throw new Error('Passkey nicht registriert');
  }

  if (stored.userId && stored.userId !== pk.user_id) {
    throw new Error('Passkey gehört nicht zu diesem Benutzerkonto');
  }

  const [user] = await sql<UserRow[]>`
    SELECT * FROM users WHERE id = ${pk.user_id}
  `;
  if (!user) {
    throw new Error('Benutzer nicht gefunden');
  }

  const { rpID } = getRpInfo(hostHeader);
  const expectedOrigin = getExpectedOrigins(hostHeader);

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: stored.challenge,
    expectedOrigin,
    expectedRPID: rpID,
    credential: {
      id: pk.credential_id,
      publicKey: new Uint8Array(pk.public_key),
      counter: Number(pk.counter),
      transports: pk.transports as AuthenticatorTransport[],
    },
    requireUserVerification: false,
  });

  if (!verification.verified) {
    throw new Error('Authentifizierung mit Passkey fehlgeschlagen');
  }

  const newCounter = verification.authenticationInfo.newCounter;
  await sql`
    UPDATE passkeys
    SET counter = ${newCounter}, last_used_at = now()
    WHERE id = ${pk.id}
  `;

  return { user, passkey: pk };
}

export async function listPasskeysForUser(userId: string) {
  return sql<Array<{ id: string; device_name: string; created_at: Date; last_used_at: Date | null }>>`
    SELECT id, device_name, created_at, last_used_at
    FROM passkeys
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
}

export async function deletePasskeyForUser(userId: string, passkeyId: string) {
  const res = await sql`
    DELETE FROM passkeys WHERE id = ${passkeyId} AND user_id = ${userId}
    RETURNING id
  `;
  return res.length > 0;
}

export async function renamePasskeyForUser(userId: string, passkeyId: string, deviceName: string) {
  const res = await sql`
    UPDATE passkeys
    SET device_name = ${deviceName.slice(0, 100)}
    WHERE id = ${passkeyId} AND user_id = ${userId}
    RETURNING id, device_name
  `;
  return res[0] ?? null;
}
