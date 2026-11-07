/**
 * API-Zugriff. Der Zugangstoken lebt nur im Arbeitsspeicher (nicht im
 * localStorage, wo ihn jedes eingeschleuste Skript lesen koennte). Nach
 * einem Neuladen holt die Seite sich ueber das httpOnly-Cookie einen neuen.
 */
import { getLocale, has, t } from './i18n';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public issues?: Array<{ path?: string; variable?: string; message: string }>) {
    super(message);
  }
}

/**
 * Die API antwortet mit deutschem Text und einem festen Code. In anderen
 * Sprachen zeigt die Oberflaeche den uebersetzten Text zum Code (errors.*),
 * auf Deutsch den Originaltext - der ist oft genauer (nennt Namen, Zahlen).
 */
function errorMessage(code: string | undefined, fallback: string) {
  return code && getLocale() !== 'de' && has(`errors.${code}`) ? t(`errors.${code}`) : fallback;
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(loggedIn: boolean) => void>();

/** Fuer Uploads mit Fortschritt (XMLHttpRequest statt fetch). */
export function currentToken() { return accessToken; }

export function setAccessToken(t: string | null) {
  accessToken = t;
  for (const l of listeners) l(t !== null);
}
export function onAuthChange(fn: (loggedIn: boolean) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Genau ein Refresh gleichzeitig - parallele Anfragen warten auf denselben. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(async (r) => {
      if (!r.ok) { setAccessToken(null); return false; }
      setAccessToken((await r.json()).accessToken);
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  if (res.status === 401 && retry && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    if (await refreshSession()) return api<T>(path, init, false);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(data?.code, data?.error ?? t('common.errorCode', { code: res.status })), data?.code, data?.issues);
  }
  return data as T;
}

/**
 * Bild aus der API als Objekt-URL. Ein <img src="/api/..."> schickt keinen
 * Bearer-Token mit und bekaeme 401 - deshalb erst per fetch holen.
 * null = gibt es nicht (404). Die URL muss der Aufrufer wieder freigeben.
 */
export async function apiBlobUrl(path: string, retry = true): Promise<string | null> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  if (res.status === 401 && retry && (await refreshSession())) return apiBlobUrl(path, false);
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}
