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
  /** Das Master-Token (Panel, Skripte) - kein Benutzer, volle Rechte. */
  master?: boolean;
  /** Der Benutzer, dem die Sitzung gehoert. */
  userId?: string;
}

let activePin = config.pairingPin.toUpperCase();
let pinCreatedAt = Date.now();
const attempts: number[] = [];

/** Eine Sitzung der Standalone-Oberflaeche gilt 7 Tage, danach ist eine neue Anmeldung noetig. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Eine angemeldete Sitzung der Standalone-Oberflaeche. */
interface SessionInfo {
  /** Wem die Sitzung gehoert. Ohne Benutzer gibt sie keinerlei Rechte. */
  userId: string | null;
  expires: number;
  createdAt: number;
  lastUsedAt: number;
  ip: string | null;
  userAgent: string | null;
}

/** Aktive Sitzungs-Tokens fuer den Standalone-Modus: Token -> Angaben. Nur im Speicher: ein Neustart beendet alle. */
const activeSessions = new Map<string, SessionInfo>();

export function createSessionToken(meta: { userId?: string | undefined; ip?: string | undefined; userAgent?: string | undefined } = {}): string {
  const token = `nxp_${crypto.randomBytes(24).toString('hex')}`;
  const now = Date.now();
  activeSessions.set(token, {
    userId: meta.userId ?? null,
    expires: now + SESSION_TTL_MS,
    createdAt: now,
    lastUsedAt: now,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : null,
  });
  return token;
}

export function registerSessionToken(token: string, userId: string | null = null): void {
  const now = Date.now();
  activeSessions.set(token, { userId, expires: now + SESSION_TTL_MS, createdAt: now, lastUsedAt: now, ip: null, userAgent: null });
}

/** Der Benutzer einer Sitzung (null: unbekannt oder Sitzung ungueltig). */
export function sessionUserId(token: string): string | null {
  return activeSessions.get(token)?.userId ?? null;
}

/** Beendet alle Sitzungen eines Benutzers (ausser `keepToken`) - Passwortwechsel, Sperre, Loeschung. @returns Anzahl */
export function revokeUserSessions(userId: string, keepToken?: string): number {
  let count = 0;
  for (const [token, info] of [...activeSessions]) {
    if (info.userId === userId && token !== keepToken) {
      activeSessions.delete(token);
      count++;
    }
  }
  return count;
}

export function revokeSessionToken(token: string): void {
  activeSessions.delete(token);
}

/** Beendet alle Sitzungen - z. B. nach einem Passwortwechsel. */
export function revokeAllSessionTokens(): void {
  activeSessions.clear();
}

export function isValidSessionToken(token: string): boolean {
  const info = activeSessions.get(token);
  if (info === undefined) return false;
  if (info.expires <= Date.now()) {
    activeSessions.delete(token);
    return false;
  }
  info.lastUsedAt = Date.now();
  return true;
}

/** Oeffentliche Kennung einer Sitzung - nicht das Token selbst, das darf nie in einer Liste stehen. */
function sessionId(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export interface SessionListEntry {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

/** Alle gueltigen Sitzungen, die aktuelle zuerst markiert, sonst neueste zuerst. */
export function listSessions(currentToken?: string, userId?: string): SessionListEntry[] {
  const now = Date.now();
  const out: SessionListEntry[] = [];
  for (const [token, info] of activeSessions) {
    if (info.expires <= now) continue;
    if (userId !== undefined && info.userId !== userId) continue;
    out.push({
      id: sessionId(token),
      user_agent: info.userAgent,
      ip: info.ip,
      created_at: new Date(info.createdAt).toISOString(),
      last_used_at: new Date(info.lastUsedAt).toISOString(),
      current: token === currentToken,
    });
  }
  return out.sort((a, b) => Number(b.current) - Number(a.current) || b.created_at.localeCompare(a.created_at));
}

/** Beendet eine Sitzung nach ihrer Kennung. @returns false, wenn es sie nicht gibt */
export function revokeSessionById(id: string, userId?: string): boolean {
  for (const [token, info] of activeSessions) {
    if (userId !== undefined && info.userId !== userId) continue;
    if (sessionId(token) === id) {
      activeSessions.delete(token);
      return true;
    }
  }
  return false;
}

/** Beendet alle Sitzungen ausser der angegebenen. @returns Anzahl */
export function revokeOtherSessions(keepToken?: string, userId?: string): number {
  let count = 0;
  for (const [token, info] of [...activeSessions]) {
    if (userId !== undefined && info.userId !== userId) continue;
    if (token !== keepToken) {
      activeSessions.delete(token);
      count++;
    }
  }
  return count;
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
  // Anmeldung mit Passkey: die Challenge vor und die Pruefung nach der Anmeldung
  if (m === 'POST' && (p === '/api/v1/auth/passkeys/login-options' || p === '/api/v1/auth/passkeys/login-verify')) return true;
  // Welche Anmeldewege es gibt - die Anmeldeseite fragt das vor der Anmeldung
  if (m === 'GET' && p === '/api/v1/auth/methods') return true;

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
    return { valid: true, master: true };
  }

  // 2. Pruefung gegen aktive Sitzungs-Tokens (Standalone-Modus)
  if (isValidSessionToken(token)) {
    const userId = sessionUserId(token);
    return { valid: true, ...(userId ? { userId } : {}) };
  }

  // 3. Im Testmodus nur wenn NEXUSCORE_ALLOW_INSECURE_AUTH explizit aktiv
  if (!config.token && config.allowInsecureAuth) {
    return { valid: true, master: true };
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

// ---------------------------------------------------------------------------
// Block A2 - Schutz gegen Zugriffe aus fremden Webseiten (CSRF, DNS-Rebinding)
// ---------------------------------------------------------------------------

/** Methoden, die etwas veraendern - nur fuer sie wird die Herkunft geprueft. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

/** Hostname ohne Port aus einem Host-Header ("[::1]:8443" -> "::1"). */
function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  const colon = value.lastIndexOf(':');
  // Mehr als ein Doppelpunkt ohne Klammern: nackte IPv6-Adresse ohne Port.
  if (colon > 0 && value.indexOf(':') === colon) return value.slice(0, colon);
  return value;
}

function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(':') && /^[0-9a-f:.]+$/.test(hostname);
}

/**
 * Schutz gegen DNS-Rebinding.
 *
 * Beim Rebinding zeigt ein fremder Domainname ploetzlich auf 127.0.0.1 oder
 * eine LAN-Adresse; der Browser schickt dann den fremden Namen im Host-Header.
 * Erlaubt sind deshalb nur IP-Adressen (eine IP laesst sich nicht umbiegen),
 * localhost, die konfigurierte Adresse und die Namen aus
 * NEXUSCORE_ALLOWED_HOSTS und NEXUSCORE_CORS_ORIGINS.
 *
 * Ein fehlender Host-Header kommt nur von Nicht-Browsern und bleibt erlaubt.
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (isIpLiteral(hostname)) return true;
  if (hostname === config.host.toLowerCase()) return true;
  if (config.allowedHosts.includes(hostname)) return true;
  return config.corsOrigins.some((origin) => {
    try {
      return new URL(origin).hostname.toLowerCase() === hostname;
    } catch {
      return false;
    }
  });
}

/**
 * Prueft die Herkunft einer schreibenden Anfrage.
 *
 * - Herkunft gesetzt: sie muss dieselbe sein wie der angesprochene Host
 *   (die eigene Oberflaeche) oder in NEXUSCORE_CORS_ORIGINS stehen.
 * - Herkunft fehlt: das ist kein Browser (Panel, PowerShell, curl). Erlaubt,
 *   solange die Anmeldung nicht aus einem Cookie stammt - ein Cookie schickt
 *   nur ein Browser mit, und der nennt bei schreibenden Anfragen immer eine
 *   Herkunft.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  authFromCookie: boolean,
): boolean {
  if (origin === undefined || origin === '') return !authFromCookie;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // "null" (sandboxed iframe, file://) und kaputte Werte
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // Ueber URL vergleichen, damit ein ausgeschriebener Standardport
  // ("localhost:80" bei http) dieselbe Herkunft bleibt.
  if (hostHeader) {
    try {
      if (new URL(`${parsed.protocol}//${hostHeader.trim()}`).host === parsed.host) return true;
    } catch {
      /* kaputter Host-Header: keine eigene Herkunft */
    }
  }

  const normalized = parsed.origin.toLowerCase();
  return config.corsOrigins.some((allowed) => {
    try {
      return new URL(allowed).origin.toLowerCase() === normalized;
    } catch {
      return false;
    }
  });
}

/** Sicherheits-Header fuer jede Antwort. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
};

/**
 * Content-Security-Policy fuer die ausgelieferte Oberflaeche.
 *
 * Skripte nur aus der eigenen Quelle - die gebaute Oberflaeche hat keine
 * Inline-Skripte. Stile brauchen 'unsafe-inline' (React setzt style-Attribute,
 * xterm ebenso). Bilder duerfen von aussen kommen (Steam-Avatare, Titelbilder).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
