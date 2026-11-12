import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerRegistry } from './registry.js';

/**
 * Speicher fuer Zugangsdaten (API-Schluessel, Passwoerter von Diensten): verschluesselt, nie im Klartext in der Datenbank.
 *
 * AES-256-GCM mit einem Hauptschluessel, der NICHT in der Datenbank steht: entweder in der Umgebung (`NEXUSCORE_SECRET_KEY`,
 * 64 Hex-Zeichen oder 32 Byte als Base64) oder in der Datei `secret.key` im Datenordner (wird beim ersten Gebrauch angelegt,
 * nur fuer den Dienstbenutzer lesbar). Der Name des Geheimnisses ist an den Geschaeftsvorgang gebunden (AAD): ein Chiffretext
 * laesst sich nicht unter einem anderen Namen einschleusen, und jede Veraenderung faellt auf.
 *
 * Was das schuetzt: eine kopierte Datenbank oder ein Backup davon verraet keine Schluessel. Was nicht: wer auf diesem Rechner
 * den Datenordner samt `secret.key` lesen kann, kann alles lesen - dafuer den Schluessel in der Umgebung halten.
 * Geht der Schluessel verloren, sind die Geheimnisse unlesbar (`status` meldet es) und muessen neu eingegeben werden.
 */

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

export type SecretStatus = 'ok' | 'missing' | 'unreadable';

interface Stored {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const settingKey = (name: string): string => `secret.${name}`;

/** Hauptschluessel aus einer Angabe: 64 Hex-Zeichen oder 32 Byte als Base64. */
export function parseMasterKey(value: string): Buffer {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  const b = Buffer.from(v, 'base64');
  if (b.length === 32 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return b;
  throw new SecretKeyError('NEXUSCORE_SECRET_KEY muss 64 Hex-Zeichen oder 32 Byte als Base64 sein (z. B. mit "openssl rand -hex 32").');
}

export class SecretStore {
  private cached: Buffer | null = null;

  constructor(
    private readonly registry: ServerRegistry,
    private readonly options: { envKey?: string | undefined; keyFile?: string } = {},
  ) {}

  private get keyFile(): string {
    return this.options.keyFile ?? path.join(this.registry.dir, 'secret.key');
  }

  /** Der Hauptschluessel: Umgebung vor Datei; fehlt beides, wird eine Datei angelegt (nur lesbar fuer den Besitzer). */
  private masterKey(): Buffer {
    if (this.cached) return this.cached;
    const env = this.options.envKey?.trim();
    if (env) return (this.cached = parseMasterKey(env));
    const file = this.keyFile;
    if (fs.existsSync(file)) return (this.cached = parseMasterKey(fs.readFileSync(file, 'utf8')));
    const fresh = crypto.randomBytes(32);
    try {
      fs.writeFileSync(file, `${fresh.toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      // Ein anderer Prozess war schneller: dessen Schluessel gilt
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return (this.cached = parseMasterKey(fs.readFileSync(file, 'utf8')));
      throw err;
    }
    return (this.cached = fresh);
  }

  private check(name: string): void {
    if (!NAME.test(name)) throw new Error(`Ungültiger Name für ein Geheimnis: ${name}`);
  }

  set(name: string, value: string): void {
    this.check(name);
    if (!value) throw new Error('Ein leeres Geheimnis wird nicht gespeichert');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey(), iv);
    cipher.setAAD(Buffer.from(name));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const stored: Stored = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    this.registry.setSetting(settingKey(name), stored);
  }

  /** Der Klartext - oder null, wenn es das Geheimnis nicht gibt oder es mit diesem Schluessel nicht lesbar ist. */
  get(name: string): string | null {
    this.check(name);
    const stored = this.registry.getSetting<Partial<Stored>>(settingKey(name));
    if (!stored || stored.v !== 1 || !stored.iv || !stored.tag || !stored.data) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey(), Buffer.from(stored.iv, 'base64'));
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8');
    } catch (err) {
      if (err instanceof SecretKeyError) throw err;
      return null; // falscher Schluessel oder veraendert
    }
  }

  status(name: string): SecretStatus {
    this.check(name);
    if (this.registry.getSetting(settingKey(name)) === undefined || this.registry.getSetting(settingKey(name)) === null) return 'missing';
    return this.get(name) === null ? 'unreadable' : 'ok';
  }

  has(name: string): boolean {
    return this.status(name) === 'ok';
  }

  delete(name: string): void {
    this.check(name);
    this.registry.deleteSetting(settingKey(name));
  }

  /**
   * Ein frueher im Klartext gespeicherter Wert wird verschluesselt und der Klartext geloescht (beim Start).
   * @returns true, wenn etwas umgezogen ist
   */
  migrateFromPlain(plainSettingKey: string, name: string): boolean {
    const plain = this.registry.getSetting<string>(plainSettingKey);
    if (typeof plain !== 'string' || !plain) return false;
    if (this.status(name) !== 'ok') this.set(name, plain);
    this.registry.deleteSetting(plainSettingKey);
    return true;
  }
}
