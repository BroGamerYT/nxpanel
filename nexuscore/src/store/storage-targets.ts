import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import ssh2 from 'ssh2';
import { z } from 'zod';
import type { ServerRegistry } from './registry.js';
import type { SecretStore } from './secrets.js';

/**
 * Speicherziele fuer Backups (S3, SFTP / Storage Box, lokaler Pfad) - dieselben Routen und Antworten wie im Panel.
 *
 * Zugangsdaten (Passwoerter, Schluessel) liegen verschluesselt im Geheimnis-Speicher, nie in der Liste und nie in einer Antwort
 * (die Antwort nennt nur, WELCHE Felder gesetzt sind). Der Verbindungstest ist echt: lokaler Pfad (schreibbar?) und SFTP
 * (anmelden, Ordner lesen, Host-Schluessel beim ersten Mal merken und danach pruefen). Bei S3 prueft der Test nur die Angaben,
 * es gibt noch keine echte Anfrage. Dass Backups auf ein Ziel hochgeladen werden, ist noch nicht gebaut (im Panel auch nicht).
 *
 * Der Test fragt im Auftrag eines Benutzers einen frei waehlbaren Rechner an: Nicht-Administratoren duerfen dabei keine Adressen
 * im eigenen Netz erreichen (Schutz davor, den Core als Sprungbrett ins Heimnetz zu benutzen).
 */

export type TargetKind = 's3' | 'sftp' | 'local_path';

export class StorageTargetError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'storage_target_error',
  ) {
    super(message);
    this.name = 'StorageTargetError';
  }
}

interface Rec {
  id: string;
  serverId: string | null;
  name: string;
  kind: TargetKind;
  config: Record<string, unknown>;
  isDefault: boolean;
  hostKeyFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TargetView {
  id: string;
  server_id: string | null;
  name: string;
  kind: TargetKind;
  /** Nur die nicht geheimen Angaben. */
  config: Record<string, unknown>;
  /** Welche geheimen Felder gesetzt sind (nie ihre Werte). */
  secrets: string[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

const SETTING = 'storage.targets';
const SECRET_FIELDS: Record<TargetKind, readonly string[]> = { s3: ['secretAccessKey'], sftp: ['password', 'privateKey', 'passphrase'], local_path: [] };

const str = (max: number) => z.string().trim().min(1).max(max);
const hostName = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:_-]+$/, 'Ungültiger Rechnername');

const SCHEMAS = {
  local_path: z.object({ path: str(500) }).strict(),
  s3: z
    .object({
      endpoint: z.string().trim().url().max(300).optional(),
      region: str(40).optional(),
      bucket: z.string().trim().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, 'Ungültiger Bucket-Name'),
      accessKeyId: str(128),
      secretAccessKey: str(256),
      prefix: z.string().trim().max(200).optional(),
      forcePathStyle: z.boolean().optional(),
    })
    .strict(),
  sftp: z
    .object({
      host: hostName,
      port: z.number().int().min(1).max(65535).optional(),
      username: str(100),
      password: str(512).optional(),
      privateKey: str(8000).optional(),
      passphrase: str(512).optional(),
      path: z.string().trim().max(500).optional(),
    })
    .strict(),
} as const;

/** Prueft die Angaben eines Ziels und trennt Geheimes von Nicht-Geheimem. */
export function parseTargetConfig(kind: TargetKind, raw: Record<string, unknown>): { plain: Record<string, unknown>; secrets: Record<string, string> } {
  const parsed = SCHEMAS[kind].safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StorageTargetError(`${issue?.path.join('.') || 'Angaben'}: ${issue?.message ?? 'ungültig'}`);
  }
  const data = parsed.data as Record<string, unknown>;
  if (kind === 'local_path' && !path.isAbsolute(String(data.path))) throw new StorageTargetError('path: der Pfad muss vollständig sein (absolut)');
  if (kind === 's3' && data.endpoint && new URL(String(data.endpoint)).protocol !== 'https:') throw new StorageTargetError('endpoint: nur https');
  if (kind === 'sftp' && !data.password && !data.privateKey) throw new StorageTargetError('Passwort oder privater Schlüssel fehlt');
  const plain: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_FIELDS[kind].includes(k)) secrets[k] = String(v);
    else plain[k] = v;
  }
  return { plain, secrets };
}

/** Liegt die Adresse im eigenen Netz (Loopback, privat, Link-Local)? */
export function isPrivateAddress(address: string): boolean {
  const v6 = address.toLowerCase();
  if (net.isIPv6(v6)) {
    if (v6 === '::1' || v6 === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x))) return true; // unklar = nicht erlaubt
  const [a, b] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function assertPublicHost(host: string, resolve: typeof dns.lookup = dns.lookup): Promise<void> {
  const addresses = net.isIP(host) ? [{ address: host }] : await (resolve as typeof dns.lookup)(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new StorageTargetError('Der Rechner ist nicht erreichbar (Name unbekannt)', 400, 'host_unreachable');
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new StorageTargetError('Adressen im eigenen Netz darf nur ein Administrator testen.', 403, 'forbidden');
  }
}

export class StorageTargets {
  constructor(
    private readonly registry: ServerRegistry,
    private readonly secrets: SecretStore,
  ) {}

  private all(): Rec[] {
    const list = this.registry.getSetting<Rec[]>(SETTING);
    return Array.isArray(list) ? list : [];
  }

  private save(list: Rec[]): void {
    this.registry.setSetting(SETTING, list);
  }

  private view(r: Rec): TargetView {
    return {
      id: r.id,
      server_id: r.serverId,
      name: r.name,
      kind: r.kind,
      config: r.config,
      secrets: SECRET_FIELDS[r.kind].filter((f) => this.secrets.has(`storage.${r.id}.${f.toLowerCase()}`)),
      is_default: r.isDefault,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  }

  /** Eines Servers (mit den globalen) oder nur die globalen (serverId = null). */
  list(serverId: string | null): TargetView[] {
    return this.all()
      .filter((r) => (serverId ? r.serverId === serverId || r.serverId === null : r.serverId === null))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
      .map((r) => this.view(r));
  }

  get(id: string): Rec | undefined {
    return this.all().find((r) => r.id === id);
  }

  create(input: { serverId: string | null; name: string; kind: TargetKind; config: Record<string, unknown>; isDefault?: boolean | undefined }): TargetView {
    const { plain, secrets } = parseTargetConfig(input.kind, input.config);
    const all = this.all();
    const name = input.name.trim();
    if (all.some((r) => r.serverId === input.serverId && r.name.toLowerCase() === name.toLowerCase())) {
      throw new StorageTargetError(`Ein Speicherziel "${name}" gibt es hier schon`, 409, 'conflict');
    }
    const now = new Date().toISOString();
    const rec: Rec = { id: crypto.randomUUID(), serverId: input.serverId, name, kind: input.kind, config: plain, isDefault: Boolean(input.isDefault), createdAt: now, updatedAt: now };
    for (const [field, value] of Object.entries(secrets)) this.secrets.set(`storage.${rec.id}.${field.toLowerCase()}`, value);
    // Hoechstens ein Standard je Bereich
    const next = all.map((r) => (rec.isDefault && r.serverId === rec.serverId ? { ...r, isDefault: false } : r));
    this.save([...next, rec]);
    return this.view(rec);
  }

  /** @param scope der Server, dessen Ziel geloescht wird; null = ein globales */
  delete(id: string, scope: string | null): boolean {
    const all = this.all();
    const rec = all.find((r) => r.id === id && r.serverId === scope);
    if (!rec) return false;
    for (const f of SECRET_FIELDS[rec.kind]) this.secrets.delete(`storage.${rec.id}.${f.toLowerCase()}`);
    this.save(all.filter((r) => r.id !== id));
    return true;
  }

  /** Alle Ziele eines geloeschten Servers entfernen. */
  deleteForServer(serverId: string): number {
    const ids = this.all().filter((r) => r.serverId === serverId).map((r) => r.id);
    for (const id of ids) this.delete(id, serverId);
    return ids.length;
  }

  async test(id: string, opts: { allowPrivate: boolean; resolve?: typeof dns.lookup }): Promise<{ ok: boolean; message: string }> {
    const rec = this.get(id);
    if (!rec) throw new StorageTargetError('Speicherziel nicht gefunden', 404, 'not_found');

    if (rec.kind === 'local_path') {
      const dir = String(rec.config.path);
      try {
        const probe = path.join(dir, `.nexuscore-test-${crypto.randomBytes(4).toString('hex')}`);
        await fs.writeFile(probe, 'test', { flag: 'wx' });
        await fs.rm(probe, { force: true });
        return { ok: true, message: `Lokaler Pfad "${dir}" ist zugänglich und beschreibbar` };
      } catch {
        return { ok: false, message: `Lokaler Pfad "${dir}" existiert nicht oder ist nicht beschreibbar` };
      }
    }

    if (rec.kind === 's3') {
      // Noch keine echte Anfrage: nur die Angaben (Bucket, Endpunkt, Schluessel) sind geprueft
      const where = rec.config.endpoint ? String(rec.config.endpoint) : 'AWS S3';
      const ok = this.secrets.has(`storage.${rec.id}.secretaccesskey`);
      return ok
        ? { ok: true, message: `S3-Angaben vollständig (${where}, Bucket ${String(rec.config.bucket)}) - eine Verbindung wurde nicht aufgebaut` }
        : { ok: false, message: 'Der geheime Schlüssel ist nicht lesbar - bitte das Ziel neu anlegen' };
    }

    // SFTP: echt anmelden und den Ordner lesen
    const host = String(rec.config.host);
    if (!opts.allowPrivate) await assertPublicHost(host, opts.resolve);
    const password = this.secrets.get(`storage.${rec.id}.password`) ?? undefined;
    const privateKey = this.secrets.get(`storage.${rec.id}.privatekey`) ?? undefined;
    const passphrase = this.secrets.get(`storage.${rec.id}.passphrase`) ?? undefined;
    if (!password && !privateKey) return { ok: false, message: 'Die Zugangsdaten sind nicht lesbar - bitte das Ziel neu anlegen' };

    let seen: string | undefined;
    const fail = (message: string) => ({ ok: false, message });
    return new Promise((resolve) => {
      const client = new ssh2.Client();
      const finish = (r: { ok: boolean; message: string }): void => {
        client.end();
        resolve(r);
      };
      client
        .on('ready', () => {
          // Beim ersten Erfolg den Host-Schluessel merken; spaeter muss er derselbe sein
          if (seen && !rec.hostKeyFingerprint) {
            const pinned = seen;
            const all = this.all().map((r): Rec => (r.id === rec.id ? { ...r, hostKeyFingerprint: pinned } : r));
            this.save(all);
          }
          client.sftp((err, sftp) => {
            if (err) return finish(fail(`SFTP nicht verfügbar: ${err.message}`));
            sftp.readdir(String(rec.config.path || '.'), (e) =>
              e ? finish(fail(`Der Ordner "${String(rec.config.path || '.')}" ist nicht lesbar`)) : finish({ ok: true, message: `SFTP erreichbar (${String(rec.config.username)}@${host}), Host-Schlüssel ${seen ?? ''}`.trim() }),
            );
          });
        })
        .on('error', (err: Error & { level?: string }) => {
          const m = err.level === 'client-authentication' ? 'Anmeldung abgelehnt (Benutzer oder Passwort/Schlüssel falsch)' : `Keine Verbindung: ${err.message}`;
          resolve(fail(m));
        })
        .connect({
          host,
          port: Number(rec.config.port ?? 22),
          username: String(rec.config.username),
          ...(password ? { password } : {}),
          ...(privateKey ? { privateKey, ...(passphrase ? { passphrase } : {}) } : {}),
          readyTimeout: 10_000,
          hostVerifier: (key: Buffer) => {
            seen = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
            if (rec.hostKeyFingerprint && rec.hostKeyFingerprint !== seen) {
              resolve(fail(`Der Host-Schlüssel hat sich geändert (erwartet ${rec.hostKeyFingerprint}, jetzt ${seen}) - nicht anmelden. Ziel neu anlegen, wenn der Wechsel gewollt ist.`));
              return false;
            }
            return true;
          },
        });
    });
  }
}
