import { sql } from './db/index.js';
import { decrypt, encrypt } from './crypto.js';

/**
 * Panel-weite Einstellungen. Geheimes (API-Schluessel) verschluesselt,
 * kurz zwischengespeichert, damit nicht jede Suche die Datenbank fragt.
 */
const cache = new Map<string, { value: string | null; at: number }>();

export async function getSetting(key: string): Promise<string | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const [row] = await sql<{ value: string; encrypted: boolean }[]>`SELECT value, encrypted FROM panel_settings WHERE key = ${key}`;
  let value: string | null = null;
  if (row) {
    try { value = row.encrypted ? decrypt(row.value) : row.value; } catch { value = null; }
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function setSetting(key: string, value: string | null, opts: { secret?: boolean; actorId?: string | null } = {}): Promise<void> {
  cache.delete(key);
  if (value === null || value === '') {
    await sql`DELETE FROM panel_settings WHERE key = ${key}`;
    return;
  }
  const stored = opts.secret ? encrypt(value) : value;
  await sql`
    INSERT INTO panel_settings (key, value, encrypted, updated_by) VALUES (${key}, ${stored}, ${!!opts.secret}, ${opts.actorId ?? null})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted, updated_at = now(), updated_by = EXCLUDED.updated_by`;
}

export const CURSEFORGE_KEY = 'curseforge_api_key';
export const DISCORD_WEBHOOK_URL = 'discord_webhook_url';
export const DISCORD_NOTIFICATIONS_ENABLED = 'discord_notifications_enabled';
export const PLAYIT_SECRET_KEY = 'playit_secret_key';
