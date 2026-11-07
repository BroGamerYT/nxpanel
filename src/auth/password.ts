import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Argon2id mit den OWASP-Mindestwerten (19 MiB, 2 Durchlaeufe).
 * Die Parameter stehen im Hash selbst - werden sie spaeter erhoeht,
 * bleiben alte Hashes pruefbar und werden beim naechsten Login erneuert.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    // Kaputter oder fremder Hash: nie werfen, einfach "falsch".
    return false;
  }
}

/** Muss der Hash mit aktuellen Parametern neu erzeugt werden? */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith(`$argon2id$v=19$m=${OPTIONS.memoryCost},t=${OPTIONS.timeCost},p=${OPTIONS.parallelism}$`);
}

/**
 * Ein fester Hash, gegen den geprueft wird, wenn es den Nutzer gar nicht gibt.
 * So dauert "falscher Name" genauso lange wie "falsches Passwort" und
 * verraet nicht, welche Konten existieren.
 */
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('nxpanel-dummy-password-never-valid');
  return dummyHash;
}

export function checkPasswordPolicy(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) return `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben`;
  if (plain.length > 256) return 'Passwort ist zu lang (max. 256 Zeichen)';
  return null;
}
