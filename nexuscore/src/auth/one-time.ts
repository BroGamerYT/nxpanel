import { randomBytes, createHash } from 'node:crypto';

/**
 * Kurzlebige Einmal-Tokens im Speicher (z. B. Rueckkehr aus der
 * Nutzer-Imitation, Steam-Verknuepfung). Gespeichert wird nur der Hash.
 * Nach einem Panel-Neustart sind offene Tokens weg - das ist gewollt
 * (dann einfach neu anmelden bzw. neu starten).
 */
type Entry = { kind: string; data: unknown; expires: number };
const store = new Map<string, Entry>();

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

function sweep(now = Date.now()) {
  for (const [k, v] of store) if (v.expires <= now) store.delete(k);
}

export function issueOneTimeToken<T>(kind: string, data: T, ttlMs: number): string {
  sweep();
  const token = randomBytes(32).toString('base64url');
  store.set(hash(token), { kind, data, expires: Date.now() + ttlMs });
  return token;
}

/** Liefert die Daten genau einmal; falsche Art, abgelaufen oder unbekannt -> null. */
export function consumeOneTimeToken<T>(kind: string, token: string | undefined | null): T | null {
  if (!token || token.length > 200) return null;
  const key = hash(token);
  const e = store.get(key);
  if (!e || e.kind !== kind) return null;
  store.delete(key);
  if (e.expires <= Date.now()) return null;
  return e.data as T;
}

/** Merkt sich einen Wert fuer ttlMs; true, wenn er schon einmal gesehen wurde (Replay). */
export function seenBefore(kind: string, value: string, ttlMs: number): boolean {
  sweep();
  const key = `seen:${kind}:${hash(value)}`;
  if (store.has(key)) return true;
  store.set(key, { kind: 'seen', data: null, expires: Date.now() + ttlMs });
  return false;
}
