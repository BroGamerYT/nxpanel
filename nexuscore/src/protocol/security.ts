import crypto from 'node:crypto';
import { config } from '../config/index.js';

const PIN_TTL_MS = 10 * 60 * 1000;
const MAX_PAIR_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface AuthValidationResult {
  valid: boolean;
  reason?: string;
}

let activePin = config.pairingPin.toUpperCase();
let pinCreatedAt = Date.now();
const attempts: number[] = [];

/**
 * Zeit-sicherer Vergleich zweier Zeichenketten.
 *
 * crypto.timingSafeEqual wirft bei unterschiedlicher Laenge, deshalb werden
 * unterschiedlich lange Eingaben ueber einen Hash verglichen - dann ist die
 * Antwort unabhaengig von der Laenge des Geheimnisses.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/** Kurzer Fingerabdruck des Tokens - erlaubt Zuordnung, ohne das Geheimnis zu zeigen. */
export function tokenFingerprint(): string {
  if (!config.token) return 'nicht gesetzt';
  return crypto.createHash('sha256').update(config.token).digest('hex').slice(0, 12);
}

export function validateRequestToken(headerToken?: string): AuthValidationResult {
  if (!config.token) {
    if (config.allowInsecureAuth) {
      return { valid: true };
    }
    return {
      valid: false,
      reason: 'Server hat kein Token gesetzt (NEXUSCORE_TOKEN).',
    };
  }

  if (!headerToken) {
    return { valid: false, reason: 'Fehlender Authentifizierungs-Token.' };
  }

  const token = headerToken.replace(/^Bearer\s+/i, '').trim();
  if (timingSafeEqualString(token, config.token)) {
    return { valid: true };
  }

  return { valid: false, reason: 'Ungültiger Authentifizierungs-Token.' };
}

/** Erzeugt eine neue Kopplungs-PIN und setzt ihre Gueltigkeitsfrist neu. */
export function createPairingPin(): string {
  const bytes = crypto.randomBytes(6);
  let pin = '';
  for (const byte of bytes) {
    pin += PIN_ALPHABET[byte % PIN_ALPHABET.length];
  }
  activePin = `${pin.slice(0, 3)}-${pin.slice(3)}`;
  pinCreatedAt = Date.now();
  return activePin;
}

/** Aktuelle PIN; abgelaufene PINs werden neu erzeugt. */
export function currentPairingPin(): string {
  if (!activePin || Date.now() - pinCreatedAt > PIN_TTL_MS) {
    return createPairingPin();
  }
  return activePin;
}

/**
 * Prueft eine Kopplungs-PIN.
 *
 * Fehlversuche werden gezaehlt und blockieren nach fuenf Versuchen fuer
 * zehn Minuten. Nach einer erfolgreichen Kopplung wird die PIN verbraucht
 * und eine neue erzeugt.
 */
export function validatePairingPin(pin: string): boolean {
  const now = Date.now();
  while (attempts.length > 0 && now - attempts[0]! > ATTEMPT_WINDOW_MS) {
    attempts.shift();
  }
  if (attempts.length >= MAX_PAIR_ATTEMPTS) {
    return false;
  }

  const normalized = (pin ?? '').trim().toUpperCase();
  if (!normalized) {
    return false;
  }

  const ok = timingSafeEqualString(normalized, currentPairingPin());
  attempts.push(now);

  if (ok) {
    attempts.length = 0;
    createPairingPin();
  }
  return ok;
}

export function pairingAttemptsRemaining(): number {
  return Math.max(0, MAX_PAIR_ATTEMPTS - attempts.length);
}
