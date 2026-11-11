import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Wer hat die laufende Anfrage ausgeloest? Die Anmeldung setzt es einmal pro
 * Anfrage; das Audit-Log liest es beim Schreiben. So muss keine der vielen
 * Stellen, die protokollieren, den Benutzer durchreichen.
 */
export interface Identity {
  userId: string;
  username: string;
}

const storage = new AsyncLocalStorage<Identity | null>();

/** Gilt fuer den Rest dieser asynchronen Kette (also den Rest der Anfrage). */
export function setIdentity(identity: Identity | null): void {
  storage.enterWith(identity);
}

export function currentIdentity(): Identity | null {
  return storage.getStore() ?? null;
}

/** Fuer Aufrufer ausserhalb einer Anfrage (Tests, Hintergrunddienste). */
export function runAs<T>(identity: Identity | null, fn: () => T): T {
  return storage.run(identity, fn);
}
