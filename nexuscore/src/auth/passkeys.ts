import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AccountError, type AccountUser, type LocalAccount, type PasskeyRecord } from '../store/account.js';

/**
 * Passkeys (WebAuthn): Anmeldung mit Fingerabdruck, Gesicht oder Sicherheitsschluessel statt Passwort.
 *
 * Der Core speichert nur den OEFFENTLICHEN Schluessel. Pruefen laesst er die Herkunft streng: der Browser sagt,
 * von welcher Seite die Anmeldung kam (`Origin`), und die muss genau die Adresse sein, unter der der Core
 * angesprochen wurde - eine fremde Seite kann so keine Anmeldung auf diesen Core anstossen.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = 'NexusCore';

interface StoredChallenge {
  challenge: string;
  userId?: string | undefined;
  rpID: string;
  origin: string;
  expires: number;
}

export interface RelyingParty {
  rpID: string;
  origin: string;
}

const isIp = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/**
 * Wer ist die "Seite" der Anmeldung? Der Host der Anfrage - und die Herkunft des Browsers muss dazu passen.
 * Passkeys gibt es nur fuer Namen (auch localhost), nicht fuer IP-Adressen: so ist es im Standard festgelegt.
 */
export function relyingPartyOf(headers: { host?: string | undefined; origin?: string | undefined }): RelyingParty {
  const host = (headers.host ?? '').trim().toLowerCase();
  if (!host) throw new AccountError('Die Anfrage nennt keinen Host.', 'passkey_no_host');
  let hostname = host;
  if (host.startsWith('[')) hostname = host.slice(1, host.indexOf(']'));
  else if (host.indexOf(':') === host.lastIndexOf(':') && host.includes(':')) hostname = host.slice(0, host.lastIndexOf(':'));
  if (!hostname || isIp(hostname)) {
    throw new AccountError('Passkeys brauchen einen Namen statt einer IP-Adresse, zum Beispiel http://localhost:8443 oder deine Domain.', 'passkey_needs_hostname');
  }
  const originHeader = headers.origin?.trim();
  if (!originHeader) throw new AccountError('Die Anfrage nennt keine Herkunft.', 'passkey_no_origin');
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    throw new AccountError('Ungültige Herkunft der Anfrage.', 'passkey_bad_origin');
  }
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.host.toLowerCase() !== host) {
    throw new AccountError('Die Herkunft passt nicht zum angesprochenen Host.', 'passkey_bad_origin');
  }
  return { rpID: hostname, origin: origin.origin };
}

export class PasskeyService {
  private readonly challenges = new Map<string, StoredChallenge>();
  /** Fuer Attrappen-Schluessel: gilt nur in diesem Prozess, muss nicht bleiben. */
  private readonly decoySecret = crypto.randomBytes(32);

  constructor(private readonly account: LocalAccount) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.challenges) if (v.expires < now) this.challenges.delete(k);
  }

  private remember(challenge: string, rp: RelyingParty, userId?: string): string {
    const id = crypto.randomBytes(24).toString('hex');
    this.challenges.set(id, { challenge, userId, rpID: rp.rpID, origin: rp.origin, expires: Date.now() + CHALLENGE_TTL_MS });
    return id;
  }

  /** Eine Challenge gilt genau einmal und nur fuer denselben Host. */
  private take(id: string, rp: RelyingParty): StoredChallenge {
    const stored = this.challenges.get(id);
    this.challenges.delete(id);
    if (!stored || stored.expires < Date.now() || stored.rpID !== rp.rpID || stored.origin !== rp.origin) {
      throw new AccountError('Sicherheits-Challenge ungültig oder abgelaufen', 'passkey_challenge');
    }
    return stored;
  }

  // ------------------------------------------------------------ Registrieren

  async registrationOptions(user: AccountUser, rp: RelyingParty) {
    const existing = this.account.passkeys(user.id);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.rpID,
      userID: new TextEncoder().encode(user.id),
      userName: user.username,
      userDisplayName: user.username,
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransport[] })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    return { challengeId: this.remember(options.challenge, rp, user.id), options };
  }

  async verifyRegistration(user: AccountUser, challengeId: string, response: RegistrationResponseJSON, deviceName: string, rp: RelyingParty): Promise<PasskeyRecord> {
    const stored = this.take(challengeId, rp);
    if (stored.userId !== user.id) throw new AccountError('Sicherheits-Challenge ungültig oder abgelaufen', 'passkey_challenge');
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: stored.origin,
        expectedRPID: stored.rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      throw new AccountError(err instanceof Error ? err.message : 'Passkey-Verifizierung fehlgeschlagen', 'passkey_failed');
    }
    if (!verification.verified || !verification.registrationInfo) throw new AccountError('Passkey-Verifizierung fehlgeschlagen', 'passkey_failed');
    const { credential } = verification.registrationInfo;
    return this.account.addPasskey(user.id, {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      deviceName,
      transports: (response.response.transports ?? []).map(String),
    });
  }

  // --------------------------------------------------------------- Anmelden

  /** Fuer einen Namen, den es nicht gibt (oder ohne Passkey), kommt eine gleich aussehende Attrappe zurueck. */
  private decoyCredential(login: string): { id: string } {
    return { id: crypto.createHmac('sha256', this.decoySecret).update(login.trim().toLowerCase()).digest('base64url') };
  }

  async authenticationOptions(login: string | undefined, rp: RelyingParty, find: (login: string) => AccountUser | undefined) {
    let allowCredentials: Array<{ id: string; transports?: AuthenticatorTransport[] }> | undefined;
    let userId: string | undefined;
    if (login?.trim()) {
      const user = find(login);
      const list = user && !user.suspended ? this.account.passkeys(user.id) : [];
      userId = list.length ? user!.id : undefined;
      allowCredentials = list.length
        ? list.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransport[] }))
        : [this.decoyCredential(login)];
    }
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: 'preferred',
      ...(allowCredentials ? { allowCredentials } : {}),
    });
    return { challengeId: this.remember(options.challenge, rp, userId), options };
  }

  async verifyAuthentication(challengeId: string, response: AuthenticationResponseJSON, rp: RelyingParty): Promise<{ userId: string; passkey: PasskeyRecord }> {
    const stored = this.take(challengeId, rp);
    const found = this.account.findPasskey(response.id);
    if (!found) throw new AccountError('Passkey nicht registriert', 'passkey_unknown', 401);
    if (stored.userId && stored.userId !== found.userId) throw new AccountError('Passkey gehört nicht zu diesem Benutzerkonto', 'passkey_unknown', 401);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin: stored.origin,
        expectedRPID: stored.rpID,
        credential: {
          id: found.passkey.credentialId,
          publicKey: new Uint8Array(Buffer.from(found.passkey.publicKey, 'base64url')),
          counter: found.passkey.counter,
          transports: found.passkey.transports as AuthenticatorTransport[],
        },
        requireUserVerification: false,
      });
    } catch (err) {
      throw new AccountError(err instanceof Error ? err.message : 'Anmeldung mit Passkey fehlgeschlagen', 'passkey_failed', 401);
    }
    if (!verification.verified) throw new AccountError('Anmeldung mit Passkey fehlgeschlagen', 'passkey_failed', 401);
    await this.account.touchPasskey(found.userId, found.passkey.id, verification.authenticationInfo.newCounter);
    return { userId: found.userId, passkey: found.passkey };
  }
}
