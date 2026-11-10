import crypto from 'node:crypto';
import path from 'node:path';
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

/** Aktive Sitzungs-Tokens fuer den Standalone-Modus */
const activeSessions = new Set<string>();

export function createSessionToken(): string {
  const token = `nxp_${crypto.randomBytes(24).toString('hex')}`;
  activeSessions.add(token);
  return token;
}

export function registerSessionToken(token: string): void {
  activeSessions.add(token);
}

export function revokeSessionToken(token: string): void {
  activeSessions.delete(token);
}

export function isValidSessionToken(token: string): boolean {
  return activeSessions.has(token);
}

/**
 * Liest ein benanntes Cookie aus dem Cookie-Header.
 */
export function parseCookie(cookieHeader?: string, name = 'nxp_session'): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  const val = match?.[1];
  return val !== undefined ? decodeURIComponent(val) : undefined;
}

/**
 * Normalisiert einen Anfrage-Pfad:
 * - Entfernt Query-Strings
 * - Dekodiert URL-Encoding (auch mehrfach: %252e%252e -> %2e%2e -> ..)
 * - Ersetzt Backslashes durch Forward Slashes
 * - Löst Dot-Segments (..) und doppelte Slashes auf
 * - Liefert einen sicheren POSIX-Pfad
 */
export function normalizeRequestPath(rawUrl: string): string {
  try {
    let p = rawUrl.split('?')[0] ?? '';
    // Mehrfache Dekodierung abfangen (%252e -> %2e -> .)
    for (let i = 0; i < 3; i++) {
      try {
        const next = decodeURIComponent(p);
        if (next === p) break;
        p = next;
      } catch {
        break;
      }
    }
    p = p.replace(/\\/g, '/').trim();
    const normalized = path.posix.normalize(p).replace(/\/+$/, '');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  } catch {
    return '/_invalid_path_';
  }
}

/**
 * Prueft, ob ein Aufruf ohne Authentifizierung zulaessig ist.
 * Standardmaessig ist ALLES geschuetzt, nur gelistete Routen duerfen durch.
 */
export function isPublicRoute(method: string, normalizedPath: string): boolean {
  const m = method.toUpperCase();
  const p = normalizedPath.toLowerCase();

  // Spezifische oeffentliche Core- und Auth-Endpunkte
  if (m === 'GET' && p === '/core/v1/info') return true;
  if (m === 'POST' && p === '/core/v1/pair') return true;
  if (m === 'POST' && p === '/api/v1/auth/login') return true;
  if (m === 'POST' && p === '/api/v1/auth/refresh') return true;

  // Statische Web-Assets & SPA-Frontend
  if (m === 'GET') {
    if (p === '/' || p === '/favicon.ico' || p === '/favicon.svg') return true;
    if (p.startsWith('/assets/') || p.startsWith('/branding/')) return true;
    // Jede GET-Anfrage ohne /api/ oder /core/ liefert die Weboberflaeche
    if (!p.startsWith('/api/') && !p.startsWith('/core/')) return true;
  }

  return false;
}

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
  if (!headerToken) {
    return { valid: false, reason: 'Fehlender Authentifizierungs-Token.' };
  }

  const token = headerToken.replace(/^Bearer\s+/i, '').trim();

  // 1. Pruefung gegen konfiguriertes Master-Token (NEXUSCORE_TOKEN)
  if (config.token && timingSafeEqualString(token, config.token)) {
    return { valid: true };
  }

  // 2. Pruefung gegen aktive Sitzungs-Tokens (Standalone-Modus)
  if (activeSessions.has(token)) {
    return { valid: true };
  }

  // 3. Im Testmodus nur wenn NEXUSCORE_ALLOW_INSECURE_AUTH explizit aktiv
  if (!config.token && config.allowInsecureAuth) {
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
