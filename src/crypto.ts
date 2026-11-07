import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.js';

/**
 * Verschluesselung fuer Geheimnisse in der Datenbank (TOTP, spaeter
 * Steam-Passwoerter und Backup-Zugaenge). AES-256-GCM mit dem Schluessel
 * aus ENCRYPTION_KEY. Ein Datenbank-Dump allein verraet damit nichts.
 *
 * Format "v1:<iv>:<tag>:<daten>" (base64url) - die Versionsnummer erlaubt
 * spaeter einen Schluesselwechsel, ohne alte Werte unlesbar zu machen.
 */
const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join(':');
}

export function decrypt(stored: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unbekanntes Verschluesselungsformat');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
