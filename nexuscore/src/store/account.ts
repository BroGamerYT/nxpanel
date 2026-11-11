import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

/**
 * Das eine lokale Konto des Standalone-Modus (Block A4).
 *
 * Der Core kennt bewusst keine Benutzerverwaltung - die gehoert ins Panel.
 * Im Standalone-Modus braucht die Oberflaeche aber eine echte Anmeldung,
 * sonst kann sich jeder im Netz ein Zugangstoken holen.
 *
 * Gespeichert wird nur der scrypt-Hash, nie das Passwort.
 */

const ACCOUNT_FILE = 'account.json';
const INITIAL_PASSWORD_FILE = 'ERSTES-PASSWORT.txt';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

const MAX_FAILED_LOGINS = 5;
const FAILED_WINDOW_MS = 10 * 60 * 1000;

interface AccountFile {
  version: 1;
  username: string;
  /** Format: scrypt$N$r$p$salt(hex)$hash(hex) */
  passwordHash: string;
}

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, length, { N: n, r, p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'hex');
  const expected = Buffer.from(parts[5]!, 'hex');
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) return false;
  const actual = await scrypt(password, salt, n, r, p, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function generatePassword(): string {
  // 20 Zeichen aus einem Alphabet ohne leicht verwechselbare Zeichen.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const byte of crypto.randomBytes(20)) out += alphabet[byte % alphabet.length];
  return out;
}

export class LocalAccount {
  /** Fehlversuche je Herkunft (IP) - nicht global, sonst sperrt ein Angreifer alle aus. */
  private readonly failures = new Map<string, number[]>();

  private constructor(
    private readonly dir: string,
    private data: AccountFile,
  ) {}

  get username(): string {
    return this.data.username;
  }

  /**
   * Oeffnet das Konto oder legt es beim ersten Start an.
   *
   * - `NEXUSCORE_ADMIN_PASSWORD` gesetzt: dieses Passwort gilt (und wird bei
   *   jedem Start neu als Hash geschrieben).
   * - sonst beim ersten Start: zufaelliges Passwort, einmal im Log und in
   *   `ERSTES-PASSWORT.txt` im Datenverzeichnis. Die Datei wird nach der
   *   ersten erfolgreichen Anmeldung geloescht.
   */
  static async open(dir: string): Promise<LocalAccount> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, ACCOUNT_FILE);
    const username = config.adminUser;

    if (config.adminPassword) {
      const data: AccountFile = { version: 1, username, passwordHash: await hashPassword(config.adminPassword) };
      await writeAccount(file, data);
      await fs.rm(path.join(dir, INITIAL_PASSWORD_FILE), { force: true });
      return new LocalAccount(dir, data);
    }

    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<AccountFile>;
      if (typeof parsed.username === 'string' && typeof parsed.passwordHash === 'string') {
        return new LocalAccount(dir, { version: 1, username: parsed.username, passwordHash: parsed.passwordHash });
      }
      logger.warn({ file }, 'Kontodatei unvollstaendig - lege das lokale Konto neu an');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ file }, 'Kontodatei nicht lesbar - lege das lokale Konto neu an');
      }
    }

    const password = generatePassword();
    const data: AccountFile = { version: 1, username, passwordHash: await hashPassword(password) };
    await writeAccount(file, data);

    const hintFile = path.join(dir, INITIAL_PASSWORD_FILE);
    await fs.writeFile(
      hintFile,
      `NexusCore - erste Anmeldung\n\nBenutzer: ${username}\nPasswort: ${password}\n\nDiese Datei wird nach der ersten erfolgreichen Anmeldung geloescht.\nPasswort vergessen: account.json loeschen und den Core neu starten.\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    // Bewusst ueber console und nicht ueber den Logger: das Passwort soll
    // einmal im Fenster stehen, aber nicht als Feld in den Logdaten landen.
    if (!process.env.VITEST) {
      console.log(`\n  NexusCore - erste Anmeldung\n  Benutzer: ${username}\n  Passwort: ${password}\n  (steht auch in ${hintFile})\n`);
    }
    logger.info({ username, hintFile }, 'Lokales Konto angelegt - Passwort steht in der Hinweisdatei');
    return new LocalAccount(dir, data);
  }

  /** Verbleibende Sperrzeit in Sekunden, 0 = nicht gesperrt. */
  lockedForSeconds(origin: string): number {
    const now = Date.now();
    const recent = (this.failures.get(origin) ?? []).filter((t) => now - t < FAILED_WINDOW_MS);
    if (recent.length === 0) this.failures.delete(origin);
    else this.failures.set(origin, recent);
    if (recent.length < MAX_FAILED_LOGINS) return 0;
    return Math.ceil((recent[0]! + FAILED_WINDOW_MS - now) / 1000);
  }

  /**
   * Prueft Benutzername und Passwort.
   *
   * Der Hash wird auch bei falschem Benutzernamen berechnet, damit die
   * Antwortzeit nicht verraet, ob es den Namen gibt.
   */
  async verify(username: string, password: string, origin: string): Promise<boolean> {
    if (this.lockedForSeconds(origin) > 0) return false;

    const passwordOk = await verifyPassword(password, this.data.passwordHash);
    const nameOk = username.trim().toLowerCase() === this.data.username.toLowerCase();

    if (passwordOk && nameOk) {
      this.failures.delete(origin);
      await fs.rm(path.join(this.dir, INITIAL_PASSWORD_FILE), { force: true }).catch(() => {});
      return true;
    }

    const list = this.failures.get(origin) ?? [];
    list.push(Date.now());
    this.failures.set(origin, list);
    return false;
  }

  /** Setzt ein neues Passwort (mindestens 10 Zeichen). */
  async setPassword(password: string): Promise<void> {
    if (password.length < 10) throw new Error('Das Passwort braucht mindestens 10 Zeichen.');
    this.data = { ...this.data, passwordHash: await hashPassword(password) };
    await writeAccount(path.join(this.dir, ACCOUNT_FILE), this.data);
    await fs.rm(path.join(this.dir, INITIAL_PASSWORD_FILE), { force: true }).catch(() => {});
  }
}

async function writeAccount(file: string, data: AccountFile): Promise<void> {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}
