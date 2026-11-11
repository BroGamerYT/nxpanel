import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { generateRecoveryCode, generateSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from './totp.js';

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
  email?: string | null;
  avatar?: string | null;
  locale?: string | null;
  /** Zwei-Faktor: Geheimnis (Base32) und zuletzt benutzter Zeitschritt gegen Wiederverwendung. */
  totp?: { secret: string; lastStep: number };
  /** Noch nicht bestaetigtes Geheimnis der Einrichtung. */
  totpPending?: string;
  /** SHA-256 der noch unbenutzten Wiederherstellungscodes. */
  recovery?: string[];
}

export const RECOVERY_CODE_COUNT = 10;

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code = 'invalid_request',
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

const hashCode = (code: string): string => crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

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
      // Profil und Zwei-Faktor bleiben, nur Name und Passwort kommen aus der Umgebung
      const previous = await fs
        .readFile(file, 'utf8')
        .then((s) => JSON.parse(s) as Partial<AccountFile>)
        .catch(() => ({}) as Partial<AccountFile>);
      const data: AccountFile = { ...previous, version: 1, username, passwordHash: await hashPassword(config.adminPassword) };
      await writeAccount(file, data);
      await fs.rm(path.join(dir, INITIAL_PASSWORD_FILE), { force: true });
      return new LocalAccount(dir, data);
    }

    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<AccountFile>;
      if (typeof parsed.username === 'string' && typeof parsed.passwordHash === 'string') {
        return new LocalAccount(dir, { ...parsed, version: 1, username: parsed.username, passwordHash: parsed.passwordHash });
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
      // Mit Zwei-Faktor zaehlt erst der Code: sonst loescht jedes richtige Passwort die Fehlversuche beim Code-Raten
      if (!this.totpEnabled) this.failures.delete(origin);
      await fs.rm(path.join(this.dir, INITIAL_PASSWORD_FILE), { force: true }).catch(() => {});
      return true;
    }

    const list = this.failures.get(origin) ?? [];
    list.push(Date.now());
    this.failures.set(origin, list);
    return false;
  }

  /** Zaehlt einen Fehlversuch (falsches Passwort oder falscher Code) fuer diese Herkunft. */
  recordFailure(origin: string): void {
    const list = this.failures.get(origin) ?? [];
    list.push(Date.now());
    this.failures.set(origin, list);
  }

  clearFailures(origin: string): void {
    this.failures.delete(origin);
  }

  // ------------------------------------------------------------------ Profil

  get totpEnabled(): boolean {
    return Boolean(this.data.totp);
  }

  profile(): { username: string; email: string | null; avatar: string | null; locale: string | null; totpEnabled: boolean } {
    return {
      username: this.data.username,
      email: this.data.email ?? null,
      avatar: this.data.avatar ?? null,
      locale: this.data.locale ?? null,
      totpEnabled: this.totpEnabled,
    };
  }

  private async save(): Promise<void> {
    await writeAccount(path.join(this.dir, ACCOUNT_FILE), this.data);
  }

  async updateProfile(patch: {
    username?: string | undefined;
    email?: string | null | undefined;
    avatar?: string | null | undefined;
    locale?: string | null | undefined;
  }): Promise<void> {
    const next = { ...this.data };
    if (patch.username !== undefined) {
      const name = patch.username.trim();
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(name)) throw new AccountError('Der Benutzername braucht 3 bis 32 Zeichen: Buchstaben, Ziffern, _ . -');
      next.username = name;
    }
    if (patch.email !== undefined) {
      const mail = patch.email?.trim() ?? '';
      if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new AccountError('Das ist keine gültige E-Mail-Adresse');
      if (mail.length > 200) throw new AccountError('Die E-Mail-Adresse ist zu lang');
      next.email = mail || null;
    }
    if (patch.avatar !== undefined) {
      const avatar = patch.avatar?.trim() ?? '';
      // eslint-disable-next-line no-control-regex
      if (avatar.length > 500 || /[\u0000-\u001f]/.test(avatar)) throw new AccountError('Ungültiges Profilbild');
      // Von aussen nur https: kein javascript: oder data: als Bildadresse
      if (avatar.includes(':') && !/^https:\/\//i.test(avatar)) throw new AccountError('Ein eigenes Profilbild muss eine https-Adresse sein');
      next.avatar = avatar || null;
    }
    if (patch.locale !== undefined) next.locale = patch.locale && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(patch.locale) ? patch.locale : null;
    this.data = next;
    await this.save();
  }

  // ------------------------------------------------------------------ Zwei-Faktor

  /** Schritt 1: Geheimnis erzeugen (noch nicht aktiv). */
  async startTotpSetup(): Promise<{ secret: string; otpauth: string }> {
    if (this.data.totp) throw new AccountError('Zwei-Faktor ist bereits aktiv', 'totp_already_enabled');
    const secret = generateSecret();
    this.data = { ...this.data, totpPending: secret };
    await this.save();
    return { secret, otpauth: otpauthUrl(secret, this.data.username) };
  }

  /** Schritt 2: der erste richtige Code schaltet scharf. @returns die Wiederherstellungscodes - einmalig */
  async enableTotp(code: string): Promise<string[]> {
    if (this.data.totp) throw new AccountError('Zwei-Faktor ist bereits aktiv', 'totp_already_enabled');
    const pending = this.data.totpPending;
    if (!pending) throw new AccountError('Erst die Einrichtung starten', 'totp_no_setup');
    const step = verifyTotp(pending, code, 0);
    if (step === null) throw new AccountError('Code stimmt nicht - Uhrzeit am Handy pruefen', 'totp_invalid');
    const { totpPending: _gone, ...rest } = this.data;
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    this.data = { ...rest, totp: { secret: pending, lastStep: step }, recovery: codes.map(hashCode) };
    await this.save();
    return codes;
  }

  /**
   * Prueft den zweiten Faktor. Ein Zeitschritt gilt nur einmal, ein Wiederherstellungscode
   * wird verbraucht - beides schon im Speicher, bevor geschrieben wird.
   */
  async checkSecondFactor(factor: { totp?: string | undefined; recoveryCode?: string | undefined }): Promise<boolean> {
    const totp = this.data.totp;
    if (!totp) return false;
    if (factor.totp) {
      const step = verifyTotp(totp.secret, factor.totp, totp.lastStep);
      if (step === null) return false;
      totp.lastStep = step;
      await this.save();
      return true;
    }
    if (factor.recoveryCode) {
      const hash = hashCode(factor.recoveryCode);
      const list = this.data.recovery ?? [];
      const at = list.findIndex((h) => h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
      if (at < 0) return false;
      this.data = { ...this.data, recovery: list.filter((_, i) => i !== at) };
      await this.save();
      return true;
    }
    return false;
  }

  get recoveryLeft(): number {
    return this.data.recovery?.length ?? 0;
  }

  /** Abschalten und neue Codes verlangen Passwort UND zweiten Faktor - ein offener Browser allein reicht nicht. */
  async confirmIdentity(password: string, factor: { totp?: string | undefined; recoveryCode?: string | undefined }, origin: string): Promise<void> {
    if (this.lockedForSeconds(origin) > 0) throw new AccountError('Zu viele Fehlversuche', 'too_many_attempts');
    if (!(await verifyPassword(password, this.data.passwordHash))) {
      this.recordFailure(origin);
      throw new AccountError('Passwort ist falsch', 'invalid_password');
    }
    if (!(await this.checkSecondFactor(factor))) {
      this.recordFailure(origin);
      throw new AccountError('Code ungueltig oder schon benutzt', 'totp_invalid');
    }
  }

  async disableTotp(): Promise<void> {
    const { totp: _t, totpPending: _p, recovery: _r, ...rest } = this.data;
    this.data = rest;
    await this.save();
  }

  async regenerateRecoveryCodes(): Promise<string[]> {
    if (!this.data.totp) throw new AccountError('Zwei-Faktor ist nicht aktiv', 'totp_not_enabled');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    this.data = { ...this.data, recovery: codes.map(hashCode) };
    await this.save();
    return codes;
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
