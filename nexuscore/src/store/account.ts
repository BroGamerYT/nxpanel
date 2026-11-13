import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { generateRecoveryCode, generateSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from './totp.js';

/**
 * Benutzer des Standalone-Modus.
 *
 * Der erste Benutzer ist der Administrator; weitere legt dieser in der
 * Oberflaeche an. Gespeichert wird nur der scrypt-Hash, nie das Passwort.
 *
 * Datei `users.json` im Datenverzeichnis. Das fruehere einzelne Konto
 * (`account.json`) wird beim ersten Start uebernommen: gleicher Name, gleiches
 * Passwort, gleicher zweiter Faktor.
 */

const USERS_FILE = 'users.json';
const LEGACY_FILE = 'account.json';
const INITIAL_PASSWORD_FILE = 'ERSTES-PASSWORT.txt';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

const MAX_FAILED_LOGINS = 5;
const FAILED_WINDOW_MS = 10 * 60 * 1000;

export type Role = 'admin' | 'moderator' | 'user';
export const ROLES: readonly Role[] = ['admin', 'moderator', 'user'];

/** Ein Passkey (WebAuthn): nur der oeffentliche Schluessel liegt hier, das Geheimnis bleibt im Geraet. */
export interface PasskeyRecord {
  id: string;
  /** Kennung des Schluessels beim Geraet (base64url). */
  credentialId: string;
  /** Oeffentlicher Schluessel (base64url, COSE). */
  publicKey: string;
  /** Zaehler des Geraets gegen kopierte Schluessel. */
  counter: number;
  deviceName: string;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

/** Alles, was zu einem Benutzer gehoert - inklusive Geheimnisse. Verlaesst nie dieses Modul. */
interface SftpPasswordRecord {
  id: string;
  label: string;
  /** Format wie passwordHash. */
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SftpPasswordInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const MAX_SFTP_PASSWORDS = 10;

interface UserRecord {
  id: string;
  username: string;
  /** Format: scrypt$N$r$p$salt(hex)$hash(hex) */
  passwordHash: string;
  role: Role;
  canCreateServers: boolean;
  /** Zusaetzliche Modul-Rechte (admin.audit ...); null = keine. */
  globalPermissions: string[] | null;
  /** Erlaubte Spiele beim Anlegen; null = alle. */
  allowedEggs: string[] | null;
  suspended: boolean;
  serverLimit: number;
  ramLimitMb: number;
  diskLimitMb: number;
  email: string | null;
  avatar: string | null;
  locale: string | null;
  /** Zwei-Faktor: Geheimnis (Base32) und zuletzt benutzter Zeitschritt gegen Wiederverwendung. */
  totp?: { secret: string; lastStep: number };
  /** Noch nicht bestaetigtes Geheimnis der Einrichtung. */
  totpPending?: string;
  /** SHA-256 der noch unbenutzten Wiederherstellungscodes. */
  recovery?: string[];
  passkeys?: PasskeyRecord[];
  /** Eigene Passwoerter fuer SFTP (nur der Hash wird gespeichert). */
  sftpPasswords?: SftpPasswordRecord[];
  /** Verknuepftes Steam-Konto (SteamID64) fuer die Anmeldung mit Steam. */
  steamId?: string;
  steamName?: string;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UsersFile {
  version: 2;
  users: UserRecord[];
}

/** Ein Benutzer ohne Geheimnisse - das gibt der Speicher heraus. */
export interface AccountUser {
  id: string;
  username: string;
  role: Role;
  canCreateServers: boolean;
  globalPermissions: string[] | null;
  allowedEggs: string[] | null;
  suspended: boolean;
  serverLimit: number;
  ramLimitMb: number;
  diskLimitMb: number;
  email: string | null;
  avatar: string | null;
  locale: string | null;
  totpEnabled: boolean;
  steamId: string | null;
  steamName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export const RECOVERY_CODE_COUNT = 10;

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code = 'invalid_request',
    readonly statusCode = 400,
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

/**
 * Hashes aus dem Panel (argon2id, PHC-Format) pruefen die Anmeldung weiter - ohne zusaetzliche Bibliothek,
 * Node bringt argon2 selbst mit. Nach einer erfolgreichen Anmeldung gilt weiter der Hash des Panels; er wird nicht veraendert.
 */
/** argon2 steckt erst ab Node 24.7 im Lieferumfang; auf aelteren Versionen scheitern uebernommene Panel-Passwoerter (neue gehen). */
export const argon2Available = typeof (crypto as unknown as { argon2Sync?: unknown }).argon2Sync === 'function';

function verifyArgon2(password: string, stored: string): boolean {
  const m = /^\$(argon2id|argon2i|argon2d)\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[6]!, 'base64');
  if (expected.length < 16) return false;
  try {
    // Die Typen von Node kennen argon2Sync noch nicht (ab Node 24.7 vorhanden)
    const argon2Sync = (crypto as unknown as { argon2Sync: (alg: string, o: Record<string, unknown>) => Buffer }).argon2Sync;
    const actual = argon2Sync(m[1]!, {
      message: Buffer.from(password),
      nonce: Buffer.from(m[5]!, 'base64'),
      memory: Number(m[2]),
      passes: Number(m[3]),
      parallelism: Number(m[4]),
      tagLength: expected.length,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith('$argon2')) return verifyArgon2(password, stored);
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

export function generatePassword(): string {
  // 20 Zeichen aus einem Alphabet ohne leicht verwechselbare Zeichen.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (const byte of crypto.randomBytes(20)) out += alphabet[byte % alphabet.length];
  return out;
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validUsername(name: string): string {
  const n = name.trim();
  if (!USERNAME_RE.test(n)) throw new AccountError('Der Benutzername braucht 3 bis 32 Zeichen: Buchstaben, Ziffern, _ . -');
  return n;
}

function validEmail(mail: string | null | undefined): string | null {
  const m = mail?.trim() ?? '';
  if (!m) return null;
  if (!EMAIL_RE.test(m)) throw new AccountError('Das ist keine gültige E-Mail-Adresse');
  if (m.length > 200) throw new AccountError('Die E-Mail-Adresse ist zu lang');
  return m;
}

function validPassword(password: string): string {
  if (password.length < 10) throw new AccountError('Das Passwort braucht mindestens 10 Zeichen.');
  if (password.length > 1024) throw new AccountError('Das Passwort ist zu lang.');
  return password;
}

const view = (u: UserRecord): AccountUser => ({
  id: u.id,
  username: u.username,
  role: u.role,
  canCreateServers: u.canCreateServers,
  globalPermissions: u.globalPermissions,
  allowedEggs: u.allowedEggs,
  suspended: u.suspended,
  serverLimit: u.serverLimit,
  ramLimitMb: u.ramLimitMb,
  diskLimitMb: u.diskLimitMb,
  email: u.email,
  avatar: u.avatar,
  locale: u.locale,
  totpEnabled: Boolean(u.totp),
  steamId: u.steamId ?? null,
  steamName: u.steamName ?? null,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
});

function validSteamId(value: string): string {
  const id = value.trim();
  if (!/^\d{17}$/.test(id)) throw new AccountError('Die Steam-ID64 besteht aus 17 Ziffern', 'invalid_steam_id');
  return id;
}

/** Hash, gegen den bei unbekanntem Namen gerechnet wird - die Antwortzeit verraet so nicht, ob es den Namen gibt. */
let dummyHash: Promise<string> | undefined;

export interface NewUserInput {
  username: string;
  email?: string | null | undefined;
  password?: string | undefined;
  role?: Role | undefined;
  canCreateServers?: boolean | undefined;
  globalPermissions?: string[] | null | undefined;
  allowedEggs?: string[] | null | undefined;
  serverLimit?: number | undefined;
  ramLimitMb?: number | undefined;
  diskLimitMb?: number | undefined;
  /** SteamID64 des verknuepften Steam-Kontos (null = trennen). */
  steamId?: string | null | undefined;
}

export type UserAdminPatch = Partial<Omit<NewUserInput, 'password' | 'username'>> & {
  suspended?: boolean | undefined;
};

export class LocalAccount {
  /** Fehlversuche je Herkunft (IP) - nicht global, sonst sperrt ein Angreifer alle aus. */
  private readonly failures = new Map<string, number[]>();
  /** Schreibvorgaenge nacheinander: zwei gleichzeitige Aenderungen duerfen sich nicht ueberholen. */
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dir: string,
    private users: UserRecord[],
  ) {}

  /**
   * Oeffnet die Benutzer oder legt beim ersten Start den Administrator an.
   *
   * - `NEXUSCORE_ADMIN_PASSWORD` gesetzt: dieses Passwort gilt fuer den
   *   Benutzer `NEXUSCORE_ADMIN_USER` (wird bei jedem Start neu als Hash geschrieben).
   * - sonst beim ersten Start: zufaelliges Passwort, einmal im Fenster und in
   *   `ERSTES-PASSWORT.txt` im Datenverzeichnis, nach der ersten Anmeldung geloescht.
   */
  static async open(dir: string): Promise<LocalAccount> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, USERS_FILE);

    let users: UserRecord[] | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<UsersFile>;
      if (parsed.version === 2 && Array.isArray(parsed.users)) users = parsed.users.map(normalize).filter((u): u is UserRecord => u !== null);
      else throw new Error('Unbekanntes Format der Benutzerdatei');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Nie ueberschreiben: eine kaputte Datei kann noch alle Konten enthalten. Beiseite legen, dann neu anfangen.
        const aside = `${file}.kaputt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await fs.rename(file, aside).catch(() => {});
        logger.error({ file, aside }, 'Benutzerdatei nicht lesbar - beiseite gelegt, der Administrator wird neu angelegt');
      }
    }

    let created = false;
    if (!users || users.length === 0) {
      users = [];
      const legacy = await readLegacy(path.join(dir, LEGACY_FILE));
      if (legacy) {
        users.push(legacy);
        logger.info({ username: legacy.username }, 'Bisheriges Konto als Administrator übernommen');
      }
      created = true;
    }

    const account = new LocalAccount(dir, users);
    let hint: { username: string; password: string } | null = null;

    if (config.adminPassword) {
      const name = config.adminUser;
      const hash = await hashPassword(config.adminPassword);
      const existing = account.users.find((u) => u.username.toLowerCase() === name.toLowerCase());
      if (existing) {
        existing.passwordHash = hash;
        existing.role = 'admin';
        existing.suspended = false;
      } else {
        account.users.push(newRecord({ username: name, passwordHash: hash, role: 'admin' }));
      }
      await fs.rm(path.join(dir, INITIAL_PASSWORD_FILE), { force: true });
      created = true;
    } else if (account.users.length === 0) {
      const password = generatePassword();
      account.users.push(newRecord({ username: config.adminUser, passwordHash: await hashPassword(password), role: 'admin' }));
      hint = { username: config.adminUser, password };
      created = true;
    }

    if (created) {
      await account.save();
      // Das alte Konto ist uebernommen; die Datei bleibt als Sicherung, wird aber nicht mehr gelesen
      await fs.rename(path.join(dir, LEGACY_FILE), path.join(dir, `${LEGACY_FILE}.migriert`)).catch(() => {});
    }

    if (hint) {
      const hintFile = path.join(dir, INITIAL_PASSWORD_FILE);
      await fs.writeFile(
        hintFile,
        `NexusCore - erste Anmeldung\n\nBenutzer: ${hint.username}\nPasswort: ${hint.password}\n\nDiese Datei wird nach der ersten erfolgreichen Anmeldung geloescht.\nPasswort vergessen: users.json loeschen und den Core neu starten.\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      // Bewusst ueber console und nicht ueber den Logger: das Passwort soll
      // einmal im Fenster stehen, aber nicht als Feld in den Logdaten landen.
      if (!process.env.VITEST) {
        console.log(`\n  NexusCore - erste Anmeldung\n  Benutzer: ${hint.username}\n  Passwort: ${hint.password}\n  (steht auch in ${hintFile})\n`);
      }
      logger.info({ username: hint.username, hintFile }, 'Administrator angelegt - Passwort steht in der Hinweisdatei');
    }
    return account;
  }

  // ------------------------------------------------------------------ Lesen

  list(): AccountUser[] {
    return this.users.map(view);
  }

  get(id: string): AccountUser | undefined {
    const u = this.users.find((x) => x.id === id);
    return u ? view(u) : undefined;
  }

  count(): number {
    return this.users.length;
  }

  /** Aktive Administratoren - der letzte darf nie verschwinden. */
  private activeAdmins(): UserRecord[] {
    return this.users.filter((u) => u.role === 'admin' && !u.suspended);
  }

  private rec(id: string): UserRecord {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new AccountError('Benutzer nicht gefunden', 'not_found', 404);
    return u;
  }

  private bySteamId(steamId: string): UserRecord | undefined {
    return this.users.find((u) => u.steamId === steamId);
  }

  /** Wem gehoert dieses Steam-Konto? */
  findBySteamId(steamId: string): AccountUser | undefined {
    const u = this.bySteamId(steamId);
    return u ? view(u) : undefined;
  }

  /** Steam-Konto verknuepfen (oder mit null trennen); ein Steam-Konto gehoert hoechstens einem Benutzer. */
  async setSteam(userId: string, steam: { id: string; name: string | null; avatar?: string | null } | null): Promise<void> {
    const u = this.rec(userId);
    if (!steam) {
      delete u.steamId;
      delete u.steamName;
    } else {
      const steamId = validSteamId(steam.id);
      const other = this.bySteamId(steamId);
      if (other && other.id !== userId) throw new AccountError('Dieses Steam-Konto ist schon einem Benutzer zugewiesen', 'steam_already_linked', 409);
      u.steamId = steamId;
      if (steam.name) u.steamName = steam.name.replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
      else delete u.steamName;
      if (!u.avatar && steam.avatar && /^https:\/\//i.test(steam.avatar) && steam.avatar.length <= 500) u.avatar = steam.avatar;
    }
    await this.save();
  }

  /** Aktualisiert Namen/Bild eines verknuepften Steam-Kontos beim Anmelden. */
  async refreshSteamProfile(userId: string, name: string | null, avatar: string | null): Promise<void> {
    const u = this.rec(userId);
    if (name) u.steamName = name.replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
    if (!u.avatar && avatar && /^https:\/\//i.test(avatar) && avatar.length <= 500) u.avatar = avatar;
    await this.save();
  }

  /** Benutzer zu Name oder E-Mail (ohne Beachtung der Schreibweise). */
  findByLogin(login: string): AccountUser | undefined {
    const u = this.byLogin(login);
    return u ? view(u) : undefined;
  }

  private byLogin(login: string): UserRecord | undefined {
    const l = login.trim().toLowerCase();
    if (!l) return undefined;
    return this.users.find((u) => u.username.toLowerCase() === l || (u.email !== null && u.email.toLowerCase() === l));
  }

  // -------------------------------------------------------------- Anmeldung

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
   * Prueft Benutzername (oder E-Mail) und Passwort.
   *
   * Der Hash wird auch bei unbekanntem Namen berechnet, damit die Antwortzeit
   * nicht verraet, ob es den Namen gibt. Gesperrte Benutzer melden sich nicht an.
   */
  async verify(login: string, password: string, origin: string): Promise<AccountUser | null> {
    if (this.lockedForSeconds(origin) > 0) return null;

    const user = this.byLogin(login);
    dummyHash ??= hashPassword('kein-benutzer-gleichzeitige-rechenzeit');
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));

    if (user && passwordOk && !user.suspended) {
      // Mit Zwei-Faktor zaehlt erst der Code: sonst loescht jedes richtige Passwort die Fehlversuche beim Code-Raten
      if (!user.totp) this.failures.delete(origin);
      await fs.rm(path.join(this.dir, INITIAL_PASSWORD_FILE), { force: true }).catch(() => {});
      return view(user);
    }
    this.recordFailure(origin);
    return null;
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

  async recordLogin(id: string): Promise<void> {
    this.rec(id).lastLoginAt = new Date().toISOString();
    await this.save();
  }

  // ------------------------------------------------------------ Verwaltung

  async create(input: NewUserInput): Promise<{ user: AccountUser; password: string; generated: boolean }> {
    const username = validUsername(input.username);
    const email = validEmail(input.email);
    if (this.byLogin(username)) throw new AccountError('Dieser Benutzername ist schon vergeben', 'username_taken', 409);
    if (email && this.byLogin(email)) throw new AccountError('Diese E-Mail-Adresse wird schon verwendet', 'email_taken', 409);
    const generated = !input.password;
    const password = generated ? generatePassword() : validPassword(input.password!);
    const rec = newRecord({
      username,
      passwordHash: await hashPassword(password),
      role: input.role ?? 'user',
      email,
      ...(input.canCreateServers !== undefined ? { canCreateServers: input.canCreateServers } : {}),
      ...(input.globalPermissions !== undefined ? { globalPermissions: input.globalPermissions } : {}),
      ...(input.allowedEggs !== undefined ? { allowedEggs: input.allowedEggs } : {}),
      ...(input.serverLimit !== undefined ? { serverLimit: input.serverLimit } : {}),
      ...(input.ramLimitMb !== undefined ? { ramLimitMb: input.ramLimitMb } : {}),
      ...(input.diskLimitMb !== undefined ? { diskLimitMb: input.diskLimitMb } : {}),
    });
    if (input.steamId) {
      rec.steamId = validSteamId(input.steamId);
      if (this.bySteamId(rec.steamId)) throw new AccountError('Dieses Steam-Konto ist schon einem Benutzer zugewiesen', 'steam_already_linked', 409);
    }
    this.users.push(rec);
    await this.save();
    return { user: view(rec), password, generated };
  }

  /**
   * Ändert die Verwaltungsfelder. Der letzte aktive Administrator darf weder
   * herabgestuft noch gesperrt werden - sonst sperrt sich der Core selbst aus.
   */
  async update(id: string, patch: UserAdminPatch & { email?: string | null | undefined }): Promise<AccountUser> {
    const u = this.rec(id);
    const next: UserRecord = { ...u };
    if (patch.email !== undefined) {
      const email = validEmail(patch.email);
      const other = email ? this.byLogin(email) : undefined;
      if (other && other.id !== id) throw new AccountError('Diese E-Mail-Adresse wird schon verwendet', 'email_taken', 409);
      next.email = email;
    }
    if (patch.role !== undefined) next.role = patch.role;
    if (patch.canCreateServers !== undefined) next.canCreateServers = patch.canCreateServers;
    if (patch.globalPermissions !== undefined) next.globalPermissions = patch.globalPermissions;
    if (patch.allowedEggs !== undefined) next.allowedEggs = patch.allowedEggs;
    if (patch.suspended !== undefined) next.suspended = patch.suspended;
    if (patch.serverLimit !== undefined) next.serverLimit = patch.serverLimit;
    if (patch.ramLimitMb !== undefined) next.ramLimitMb = patch.ramLimitMb;
    if (patch.diskLimitMb !== undefined) next.diskLimitMb = patch.diskLimitMb;
    if (patch.steamId !== undefined) {
      if (patch.steamId) {
        const steamId = validSteamId(patch.steamId);
        const other = this.bySteamId(steamId);
        if (other && other.id !== id) throw new AccountError('Dieses Steam-Konto ist schon einem Benutzer zugewiesen', 'steam_already_linked', 409);
        if (steamId !== u.steamId) delete next.steamName;
        next.steamId = steamId;
      } else {
        delete next.steamId;
        delete next.steamName;
      }
    }

    const wasActiveAdmin = u.role === 'admin' && !u.suspended;
    const stillActiveAdmin = next.role === 'admin' && !next.suspended;
    if (wasActiveAdmin && !stillActiveAdmin && this.activeAdmins().length <= 1) {
      throw new AccountError('Das ist der letzte aktive Administrator - er kann nicht herabgestuft oder gesperrt werden.', 'last_admin', 409);
    }
    Object.assign(u, next);
    // Object.assign entfernt keine Felder: getrennte Steam-Verknuepfung ausdruecklich loeschen
    if (next.steamId === undefined) delete u.steamId;
    if (next.steamName === undefined) delete u.steamName;
    await this.save();
    return view(u);
  }

  async remove(id: string): Promise<void> {
    const u = this.rec(id);
    if (u.role === 'admin' && !u.suspended && this.activeAdmins().length <= 1) {
      throw new AccountError('Der letzte aktive Administrator kann nicht gelöscht werden.', 'last_admin', 409);
    }
    this.users = this.users.filter((x) => x.id !== id);
    await this.save();
  }

  /** Setzt ein Passwort fuer einen anderen Benutzer; ohne Angabe wird eines erzeugt. */
  async resetPassword(id: string, password?: string): Promise<{ password: string; generated: boolean }> {
    const u = this.rec(id);
    const generated = !password;
    const pw = generated ? generatePassword() : validPassword(password!);
    u.passwordHash = await hashPassword(pw);
    await this.save();
    return { password: pw, generated };
  }

  /** Schaltet den zweiten Faktor eines Benutzers ab (Support-Fall: Handy verloren). */
  async resetTotp(id: string): Promise<void> {
    const u = this.rec(id);
    delete u.totp;
    delete u.totpPending;
    delete u.recovery;
    await this.save();
  }

  // ------------------------------------------------------------------ Profil

  totpEnabled(id: string): boolean {
    return Boolean(this.rec(id).totp);
  }

  profile(id: string): AccountUser {
    return view(this.rec(id));
  }

  async updateProfile(
    id: string,
    patch: {
      username?: string | undefined;
      email?: string | null | undefined;
      avatar?: string | null | undefined;
      locale?: string | null | undefined;
    },
  ): Promise<void> {
    const u = this.rec(id);
    const next = { ...u };
    if (patch.username !== undefined) {
      const name = validUsername(patch.username);
      const other = this.byLogin(name);
      if (other && other.id !== id) throw new AccountError('Dieser Benutzername ist schon vergeben', 'username_taken', 409);
      next.username = name;
    }
    if (patch.email !== undefined) {
      const email = validEmail(patch.email);
      const other = email ? this.byLogin(email) : undefined;
      if (other && other.id !== id) throw new AccountError('Diese E-Mail-Adresse wird schon verwendet', 'email_taken', 409);
      next.email = email;
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
    Object.assign(u, next);
    await this.save();
  }

  // ------------------------------------------------------------------ Zwei-Faktor

  /** Schritt 1: Geheimnis erzeugen (noch nicht aktiv). */
  async startTotpSetup(id: string): Promise<{ secret: string; otpauth: string }> {
    const u = this.rec(id);
    if (u.totp) throw new AccountError('Zwei-Faktor ist bereits aktiv', 'totp_already_enabled');
    const secret = generateSecret();
    u.totpPending = secret;
    await this.save();
    return { secret, otpauth: otpauthUrl(secret, u.username) };
  }

  /** Schritt 2: der erste richtige Code schaltet scharf. @returns die Wiederherstellungscodes - einmalig */
  async enableTotp(id: string, code: string): Promise<string[]> {
    const u = this.rec(id);
    if (u.totp) throw new AccountError('Zwei-Faktor ist bereits aktiv', 'totp_already_enabled');
    const pending = u.totpPending;
    if (!pending) throw new AccountError('Erst die Einrichtung starten', 'totp_no_setup');
    const step = verifyTotp(pending, code, 0);
    if (step === null) throw new AccountError('Code stimmt nicht - Uhrzeit am Handy pruefen', 'totp_invalid');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    delete u.totpPending;
    u.totp = { secret: pending, lastStep: step };
    u.recovery = codes.map(hashCode);
    await this.save();
    return codes;
  }

  /**
   * Prueft den zweiten Faktor. Ein Zeitschritt gilt nur einmal, ein Wiederherstellungscode
   * wird verbraucht - beides schon im Speicher, bevor geschrieben wird.
   */
  async checkSecondFactor(id: string, factor: { totp?: string | undefined; recoveryCode?: string | undefined }): Promise<boolean> {
    const u = this.rec(id);
    const totp = u.totp;
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
      const list = u.recovery ?? [];
      const at = list.findIndex((h) => h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
      if (at < 0) return false;
      u.recovery = list.filter((_, i) => i !== at);
      await this.save();
      return true;
    }
    return false;
  }

  recoveryLeft(id: string): number {
    return this.rec(id).recovery?.length ?? 0;
  }

  /** Abschalten und neue Codes verlangen Passwort UND zweiten Faktor - ein offener Browser allein reicht nicht. */
  async confirmIdentity(
    id: string,
    password: string,
    factor: { totp?: string | undefined; recoveryCode?: string | undefined },
    origin: string,
  ): Promise<void> {
    if (this.lockedForSeconds(origin) > 0) throw new AccountError('Zu viele Fehlversuche', 'too_many_attempts', 429);
    if (!(await verifyPassword(password, this.rec(id).passwordHash))) {
      this.recordFailure(origin);
      throw new AccountError('Passwort ist falsch', 'invalid_password');
    }
    if (!(await this.checkSecondFactor(id, factor))) {
      this.recordFailure(origin);
      throw new AccountError('Code ungueltig oder schon benutzt', 'totp_invalid');
    }
  }

  async disableTotp(id: string): Promise<void> {
    await this.resetTotp(id);
  }

  async regenerateRecoveryCodes(id: string): Promise<string[]> {
    const u = this.rec(id);
    if (!u.totp) throw new AccountError('Zwei-Faktor ist nicht aktiv', 'totp_not_enabled');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    u.recovery = codes.map(hashCode);
    await this.save();
    return codes;
  }

  /** Prueft das Passwort eines Benutzers (z. B. vor dem Aendern). */
  async checkPassword(id: string, password: string, origin: string): Promise<boolean> {
    if (this.lockedForSeconds(origin) > 0) return false;
    const ok = await verifyPassword(password, this.rec(id).passwordHash);
    if (!ok) this.recordFailure(origin);
    return ok;
  }

  /** Setzt ein neues Passwort (mindestens 10 Zeichen). */
  async setPassword(id: string, password: string): Promise<void> {
    const u = this.rec(id);
    u.passwordHash = await hashPassword(validPassword(password));
    await this.save();
    await fs.rm(path.join(this.dir, INITIAL_PASSWORD_FILE), { force: true }).catch(() => {});
  }

  // ---------------------------------------------------------------- Passkeys

  passkeys(userId: string): PasskeyRecord[] {
    return (this.rec(userId).passkeys ?? []).map((p) => ({ ...p, transports: [...p.transports] }));
  }

  /** Wem gehoert dieser Schluessel? (Anmeldung ohne Benutzernamen.) */
  findPasskey(credentialId: string): { userId: string; passkey: PasskeyRecord } | null {
    for (const u of this.users) {
      const p = u.passkeys?.find((x) => x.credentialId === credentialId);
      if (p) return { userId: u.id, passkey: { ...p, transports: [...p.transports] } };
    }
    return null;
  }

  async addPasskey(userId: string, input: { credentialId: string; publicKey: string; counter: number; deviceName: string; transports: string[] }): Promise<PasskeyRecord> {
    const u = this.rec(userId);
    if (this.findPasskey(input.credentialId)) throw new AccountError('Dieser Passkey ist schon registriert', 'passkey_exists', 409);
    if ((u.passkeys?.length ?? 0) >= 20) throw new AccountError('Es sind höchstens 20 Passkeys je Konto möglich', 'too_many_passkeys');
    const rec: PasskeyRecord = {
      id: crypto.randomUUID(),
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: input.counter,
      deviceName: input.deviceName.replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || 'Passkey',
      transports: input.transports.slice(0, 8),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    u.passkeys = [...(u.passkeys ?? []), rec];
    await this.save();
    return { ...rec };
  }

  async removePasskey(userId: string, passkeyId: string): Promise<boolean> {
    const u = this.rec(userId);
    const before = u.passkeys?.length ?? 0;
    u.passkeys = (u.passkeys ?? []).filter((p) => p.id !== passkeyId);
    if (u.passkeys.length === before) return false;
    await this.save();
    return true;
  }

  async renamePasskey(userId: string, passkeyId: string, deviceName: string): Promise<PasskeyRecord | null> {
    const p = this.rec(userId).passkeys?.find((x) => x.id === passkeyId);
    if (!p) return null;
    p.deviceName = deviceName.replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || p.deviceName;
    await this.save();
    return { ...p, transports: [...p.transports] };
  }

  async touchPasskey(userId: string, passkeyId: string, counter: number): Promise<void> {
    const p = this.rec(userId).passkeys?.find((x) => x.id === passkeyId);
    if (!p) return;
    p.counter = counter;
    p.lastUsedAt = new Date().toISOString();
    await this.save();
  }

  // ------------------------------------------------------------------- SFTP

  sftpPasswords(userId: string): SftpPasswordInfo[] {
    return (this.rec(userId).sftpPasswords ?? []).map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt }));
  }

  /** Legt ein SFTP-Passwort an; im Klartext gibt es das nur hier, gespeichert wird der Hash. */
  async createSftpPassword(userId: string, label: string): Promise<{ info: SftpPasswordInfo; password: string }> {
    const u = this.rec(userId);
    const name = label.replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    if (!name) throw new AccountError('Bitte eine Bezeichnung angeben', 'invalid_request');
    if ((u.sftpPasswords?.length ?? 0) >= MAX_SFTP_PASSWORDS) {
      throw new AccountError(`Höchstens ${MAX_SFTP_PASSWORDS} SFTP-Passwörter je Konto`, 'too_many_sftp_passwords');
    }
    // 4 Gruppen a 6 Zeichen, gut abzutippen: abcdef-ghijkl-...
    const raw = crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, 'x').slice(0, 24).toLowerCase();
    const password = raw.match(/.{6}/g)!.join('-');
    const rec: SftpPasswordRecord = { id: crypto.randomUUID(), label: name, hash: await hashPassword(password), createdAt: new Date().toISOString(), lastUsedAt: null };
    u.sftpPasswords = [...(u.sftpPasswords ?? []), rec];
    await this.save();
    return { info: { id: rec.id, label: rec.label, createdAt: rec.createdAt, lastUsedAt: null }, password };
  }

  async deleteSftpPassword(userId: string, id: string): Promise<boolean> {
    const u = this.rec(userId);
    const before = u.sftpPasswords?.length ?? 0;
    u.sftpPasswords = (u.sftpPasswords ?? []).filter((p) => p.id !== id);
    if (u.sftpPasswords.length === before) return false;
    await this.save();
    return true;
  }

  /**
   * Anmeldung per SFTP. SFTP kann keinen zweiten Faktor abfragen: mit Zwei-Faktor-Schutz gilt NUR ein
   * eigenes SFTP-Passwort, nie das Kontopasswort - sonst waere der Schutz ueber SFTP zu umgehen.
   * Fehlversuche zaehlen auf dieselbe Sperre je Herkunft wie bei der Anmeldung im Browser.
   */
  async verifySftp(login: string, password: string, origin: string): Promise<AccountUser | null> {
    if (this.lockedForSeconds(origin) > 0) return null;
    const user = this.byLogin(login);
    dummyHash ??= hashPassword('kein-benutzer-gleichzeitige-rechenzeit');
    if (!user || user.suspended) {
      await verifyPassword(password, await dummyHash);
      this.recordFailure(origin);
      return null;
    }
    for (const p of user.sftpPasswords ?? []) {
      if (await verifyPassword(password, p.hash)) {
        p.lastUsedAt = new Date().toISOString();
        await this.save();
        this.failures.delete(origin);
        return view(user);
      }
    }
    if (user.totp || !(await verifyPassword(password, user.passwordHash))) {
      this.recordFailure(origin);
      return null;
    }
    this.failures.delete(origin);
    return view(user);
  }

  /** Ob ueberhaupt jemand einen Passkey hat - die Anmeldeseite zeigt den Knopf nur dann sinnvoll. */
  hasAnyPasskey(): boolean {
    return this.users.some((u) => (u.passkeys?.length ?? 0) > 0);
  }

  // --------------------------------------------------------------- Speichern

  /**
   * Uebernimmt Benutzer aus einem anderen System (Panel-Datenuebernahme): Kennungen, Passwort-Hashes, Passkeys bleiben erhalten.
   * Wer schon da ist (Name, E-Mail oder Steam-Konto), wird nicht ueberschrieben, sondern uebersprungen und gemeldet.
   * `dryRun`: nur pruefen und melden, nichts schreiben.
   */
  async importUsers(records: unknown[], dryRun = false): Promise<{ imported: string[]; skipped: Array<{ username: string; reason: string }> }> {
    const imported: string[] = [];
    const skipped: Array<{ username: string; reason: string }> = [];
    const added: UserRecord[] = [];
    for (const raw of records) {
      const rec = normalize(raw as Partial<UserRecord>);
      if (!rec) {
        skipped.push({ username: String((raw as { username?: unknown })?.username ?? '?'), reason: 'Unvollständiger Eintrag' });
        continue;
      }
      const all = [...this.users, ...added];
      if (all.some((u) => u.id === rec.id)) skipped.push({ username: rec.username, reason: 'Kennung schon vorhanden' });
      else if (all.some((u) => u.username.toLowerCase() === rec.username.toLowerCase())) skipped.push({ username: rec.username, reason: 'Benutzername schon vergeben' });
      else if (rec.email && all.some((u) => u.email?.toLowerCase() === rec.email!.toLowerCase())) skipped.push({ username: rec.username, reason: 'E-Mail-Adresse schon vergeben' });
      else if (rec.steamId && all.some((u) => u.steamId === rec.steamId)) skipped.push({ username: rec.username, reason: 'Steam-Konto schon zugewiesen' });
      else {
        added.push(rec);
        imported.push(rec.username);
      }
    }
    if (!dryRun && added.length) {
      this.users.push(...added);
      await this.save();
    }
    return { imported, skipped };
  }

  private save(): Promise<void> {
    const snapshot: UsersFile = { version: 2, users: this.users };
    const run = async (): Promise<void> => {
      const file = path.join(this.dir, USERS_FILE);
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, file);
    };
    const next = this.writing.then(run, run);
    this.writing = next.catch(() => {});
    return next;
  }
}

function newRecord(input: {
  username: string;
  passwordHash: string;
  role: Role;
  email?: string | null;
  canCreateServers?: boolean;
  globalPermissions?: string[] | null;
  allowedEggs?: string[] | null;
  serverLimit?: number;
  ramLimitMb?: number;
  diskLimitMb?: number;
}): UserRecord {
  return {
    id: crypto.randomUUID(),
    username: input.username,
    passwordHash: input.passwordHash,
    role: input.role,
    canCreateServers: input.canCreateServers ?? false,
    globalPermissions: input.globalPermissions ?? null,
    allowedEggs: input.allowedEggs ?? null,
    suspended: false,
    serverLimit: input.serverLimit ?? 0,
    ramLimitMb: input.ramLimitMb ?? 0,
    diskLimitMb: input.diskLimitMb ?? 0,
    email: input.email ?? null,
    avatar: null,
    locale: null,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
}

/** Liest einen Eintrag der Datei; unbrauchbare Eintraege werden verworfen statt den Start zu verhindern. */
function normalize(raw: Partial<UserRecord>): UserRecord | null {
  if (typeof raw.id !== 'string' || typeof raw.username !== 'string' || typeof raw.passwordHash !== 'string') return null;
  const role: Role = raw.role && ROLES.includes(raw.role) ? raw.role : 'user';
  return {
    id: raw.id,
    username: raw.username,
    passwordHash: raw.passwordHash,
    role,
    canCreateServers: raw.canCreateServers === true,
    globalPermissions: Array.isArray(raw.globalPermissions) ? raw.globalPermissions.filter((p) => typeof p === 'string') : null,
    allowedEggs: Array.isArray(raw.allowedEggs) ? raw.allowedEggs.filter((p) => typeof p === 'string') : null,
    suspended: raw.suspended === true,
    serverLimit: Number.isFinite(raw.serverLimit) ? Number(raw.serverLimit) : 0,
    ramLimitMb: Number.isFinite(raw.ramLimitMb) ? Number(raw.ramLimitMb) : 0,
    diskLimitMb: Number.isFinite(raw.diskLimitMb) ? Number(raw.diskLimitMb) : 0,
    email: typeof raw.email === 'string' ? raw.email : null,
    avatar: typeof raw.avatar === 'string' ? raw.avatar : null,
    locale: typeof raw.locale === 'string' ? raw.locale : null,
    ...(raw.totp && typeof raw.totp.secret === 'string' ? { totp: { secret: raw.totp.secret, lastStep: Number(raw.totp.lastStep) || 0 } } : {}),
    ...(typeof raw.totpPending === 'string' ? { totpPending: raw.totpPending } : {}),
    ...(Array.isArray(raw.recovery) ? { recovery: raw.recovery.filter((h) => typeof h === 'string') } : {}),
    ...(Array.isArray(raw.passkeys)
      ? {
          passkeys: raw.passkeys
            .filter((p): p is PasskeyRecord => Boolean(p) && typeof p.id === 'string' && typeof p.credentialId === 'string' && typeof p.publicKey === 'string')
            .map((p) => ({
              id: p.id,
              credentialId: p.credentialId,
              publicKey: p.publicKey,
              counter: Number.isFinite(p.counter) ? Number(p.counter) : 0,
              deviceName: typeof p.deviceName === 'string' ? p.deviceName.slice(0, 100) : 'Passkey',
              transports: Array.isArray(p.transports) ? p.transports.filter((x) => typeof x === 'string') : [],
              createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
              lastUsedAt: typeof p.lastUsedAt === 'string' ? p.lastUsedAt : null,
            })),
        }
      : {}),
    ...(Array.isArray(raw.sftpPasswords)
      ? {
          sftpPasswords: raw.sftpPasswords
            .filter((p): p is SftpPasswordRecord => Boolean(p) && typeof p.id === 'string' && typeof p.hash === 'string')
            .map((p) => ({
              id: p.id,
              label: typeof p.label === 'string' ? p.label.slice(0, 60) : 'SFTP',
              hash: p.hash,
              createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
              lastUsedAt: typeof p.lastUsedAt === 'string' ? p.lastUsedAt : null,
            })),
        }
      : {}),
    ...(typeof raw.steamId === 'string' && /^\d{17}$/.test(raw.steamId) ? { steamId: raw.steamId } : {}),
    ...(typeof raw.steamName === 'string' ? { steamName: raw.steamName.slice(0, 100) } : {}),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    lastLoginAt: typeof raw.lastLoginAt === 'string' ? raw.lastLoginAt : null,
  };
}

/** Das fruehere einzelne Konto (account.json) als Administrator. */
async function readLegacy(file: string): Promise<UserRecord | null> {
  try {
    const old = JSON.parse(await fs.readFile(file, 'utf8')) as {
      username?: string;
      passwordHash?: string;
      email?: string | null;
      avatar?: string | null;
      locale?: string | null;
      totp?: { secret: string; lastStep: number };
      totpPending?: string;
      recovery?: string[];
    };
    if (typeof old.username !== 'string' || typeof old.passwordHash !== 'string') return null;
    const rec = newRecord({ username: old.username, passwordHash: old.passwordHash, role: 'admin', email: old.email ?? null });
    rec.avatar = old.avatar ?? null;
    rec.locale = old.locale ?? null;
    if (old.totp) rec.totp = old.totp;
    if (old.totpPending) rec.totpPending = old.totpPending;
    if (old.recovery) rec.recovery = old.recovery;
    return rec;
  } catch {
    return null;
  }
}
