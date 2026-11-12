import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildDockerInstance } from '../docker/egg-container.js';
import { initialValue } from '../eggs/rules.js';
import type { LoadedEgg } from '../eggs/loader.js';
import { containerInstallPlan } from '../install/manager.js';
import { setNetwork } from '../network.js';
import { isServerFlag } from '../auth/permissions.js';
import { saveServerMeta } from '../http/routes/settings.js';
import { Scheduler } from '../schedules/scheduler.js';
import type { LocalAccount } from '../store/account.js';
import { setOwner, setSubuserFlags } from '../store/access.js';
import type { ServerRegistry } from '../store/registry.js';
import type { SecretStore } from '../store/secrets.js';
import type { SteamAccounts } from '../steam/accounts.js';
import { DnsService } from '../network/dns.js';
import type { ServerPort } from '../types.js';

/**
 * Datenuebernahme aus dem Panel (Postgres) in den Core.
 *
 * Eingabe ist ein Export der Panel-Tabellen als JSON (`scripts/export-panel.sh`, laeuft auf dem Panel-Rechner). Verschluesselte
 * Felder (TOTP, Steam-Passwoerter, CurseForge-Schluessel ...) bleiben im Export verschluesselt; sie werden hier mit dem
 * ENCRYPTION_KEY des Panels gelesen und sofort mit dem Schluessel des Cores neu verschluesselt.
 *
 * Die Spieldaten werden nicht kopiert: der Core nimmt den Ordner des Panels (`<volumes>/<short_id>`) als Server-Ordner.
 * Der Panel-Container muss vorher gestoppt und entfernt sein - er und der Core teilen sich sonst Ordner und Ports.
 *
 * Trockenlauf (`dryRun`) rechnet alles durch und schreibt nichts. Wer schon da ist, wird nie ueberschrieben, sondern gemeldet.
 */

type Row = Record<string, unknown>;

export interface PanelExport {
  users?: Row[];
  servers?: Row[];
  eggs?: Row[];
  allocations?: Row[];
  subusers?: Row[];
  steam_accounts?: Row[];
  panel_settings?: Row[];
  passkeys?: Row[];
  sftp_passwords?: Row[];
  recovery_codes?: Row[];
  nodes?: Row[];
  server_schedules?: Row[];
  backups?: Row[];
  storage_targets?: Row[];
  player_bans?: Row[];
}

export interface ImportLine {
  level: 'ok' | 'warn' | 'error';
  area: string;
  message: string;
}

export interface ImportReport {
  dryRun: boolean;
  lines: ImportLine[];
  counts: Record<string, number>;
  errors: number;
  warnings: number;
}

export interface ImportDeps {
  registry: ServerRegistry;
  account: LocalAccount;
  secrets: SecretStore;
  steamAccounts: SteamAccounts;
  eggs: LoadedEgg[];
}

export interface ImportOptions {
  dryRun: boolean;
  /** ENCRYPTION_KEY des Panels (64 Hex-Zeichen). Ohne ihn bleiben verschluesselte Felder unberuehrt. */
  panelKey?: string | undefined;
  /** Ordner mit den Server-Ordnern des Panels (`<short_id>`), Standard /var/lib/panel/volumes. */
  volumesDir: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Panel-Format "v1:<iv>:<tag>:<daten>" (base64url), AES-256-GCM. */
export function decryptPanelSecret(stored: string, keyHex: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('Der Panel-Schlüssel muss aus 64 Hex-Zeichen bestehen.');
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unbekanntes Verschlüsselungsformat');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** bytea aus json_agg: "\\x<hex>" */
function byteaToBase64Url(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const hex = v.startsWith('\\x') ? v.slice(2) : v;
  return /^[0-9a-fA-F]*$/.test(hex) && hex.length > 0 ? Buffer.from(hex, 'hex').toString('base64url') : null;
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function importPanelData(data: PanelExport, deps: ImportDeps, opts: ImportOptions): Promise<ImportReport> {
  const { registry, account, secrets, steamAccounts, eggs } = deps;
  const lines: ImportLine[] = [];
  const counts: Record<string, number> = {};
  const say = (level: ImportLine['level'], area: string, message: string): void => void lines.push({ level, area, message });
  const decrypt = (value: unknown, what: string): string | null => {
    const s = str(value);
    if (!s) return null;
    if (!opts.panelKey) {
      say('warn', what, 'Verschlüsseltes Feld nicht übernommen (kein Panel-Schlüssel angegeben).');
      return null;
    }
    try {
      return decryptPanelSecret(s, opts.panelKey);
    } catch {
      say('error', what, 'Mit dem angegebenen Panel-Schlüssel nicht lesbar.');
      return null;
    }
  };

  const userRows = data.users ?? [];
  const userName = new Map(userRows.map((u) => [String(u.id), String(u.username)]));

  // ------------------------------------------------------------------ Benutzer
  const passkeysOf = (userId: unknown) =>
    (data.passkeys ?? [])
      .filter((p) => p.user_id === userId)
      .map((p) => ({
        id: String(p.id),
        credentialId: String(p.credential_id),
        publicKey: byteaToBase64Url(p.public_key) ?? '',
        counter: num(p.counter),
        deviceName: str(p.device_name) ?? 'Passkey',
        transports: arr(p.transports),
        createdAt: iso(p.created_at) ?? new Date().toISOString(),
        lastUsedAt: iso(p.last_used_at),
      }))
      .filter((p) => p.publicKey !== '');
  const records = userRows.map((u) => {
    const totpSecret = u.totp_enabled === true ? decrypt(u.totp_secret, `Benutzer ${u.username}: Zwei-Faktor`) : null;
    if (u.totp_enabled === true && !totpSecret) say('warn', 'Benutzer', `${u.username}: Zwei-Faktor wird nicht übernommen - der Benutzer richtet ihn neu ein.`);
    const gp = arr(u.global_permissions);
    return {
      id: String(u.id),
      username: String(u.username),
      passwordHash: String(u.password_hash),
      role: u.role,
      canCreateServers: u.can_create_servers === true,
      globalPermissions: gp.length ? gp : null,
      allowedEggs: Array.isArray(u.allowed_eggs) ? arr(u.allowed_eggs) : null,
      suspended: u.suspended === true,
      serverLimit: num(u.server_limit),
      ramLimitMb: num(u.ram_limit_mb),
      diskLimitMb: num(u.disk_limit_mb),
      email: str(u.email),
      avatar: str(u.avatar),
      locale: str(u.locale),
      ...(totpSecret ? { totp: { secret: totpSecret, lastStep: num(u.totp_last_step) } } : {}),
      passkeys: passkeysOf(u.id),
      ...(str(u.steam_id) ? { steamId: str(u.steam_id)! } : {}),
      ...(str(u.steam_name) ? { steamName: str(u.steam_name)! } : {}),
      createdAt: iso(u.created_at) ?? new Date().toISOString(),
      lastLoginAt: iso(u.last_login_at),
    };
  });
  const users = await account.importUsers(records, opts.dryRun);
  counts.users = users.imported.length;
  for (const name of users.imported) say('ok', 'Benutzer', `${name} übernommen (Passwort, Rolle und Rechte bleiben).`);
  for (const s of users.skipped) say('warn', 'Benutzer', `${s.username} übersprungen: ${s.reason}.`);
  if ((data.recovery_codes ?? []).length) say('warn', 'Benutzer', `${data.recovery_codes!.length} Wiederherstellungscodes werden nicht übernommen - Zwei-Faktor-Benutzer erzeugen neue.`);
  if ((data.sftp_passwords ?? []).length) say('warn', 'SFTP', `${data.sftp_passwords!.length} SFTP-Passwörter werden nicht übernommen - bitte neu anlegen.`);

  // ------------------------------------------------------------------ Netzwerk
  const node = (data.nodes ?? []).find((n) => n.type === 'local') ?? (data.nodes ?? [])[0];
  if (node) {
    const patch = { ...(str(node.public_host) ? { publicHost: str(node.public_host)! } : {}), ...(node.port_from != null && node.port_to != null ? { portFrom: num(node.port_from), portTo: num(node.port_to) } : {}) };
    if (Object.keys(patch).length) {
      if (!opts.dryRun) setNetwork(registry, patch);
      say('ok', 'Netzwerk', `Öffentliche Adresse ${patch.publicHost ?? '(unverändert)'}, Port-Bereich ${patch.portFrom ?? '?'}-${patch.portTo ?? '?'}.`);
    }
  }
  for (const n of (data.nodes ?? []).filter((x) => x.type === 'core')) say('warn', 'Hosts', `Gekoppelter Core "${n.name}" nicht übernommen - im Core neu koppeln (Adresse und Token).`);

  // ------------------------------------------------------------ Einstellungen
  for (const s of data.panel_settings ?? []) {
    const key = String(s.key);
    const value = s.encrypted === true ? decrypt(s.value, `Einstellung ${key}`) : str(s.value);
    if (value === null) continue;
    if (key === 'curseforge_api_key') {
      if (!opts.dryRun) secrets.set('curseforge', value);
      say('ok', 'Einstellungen', 'CurseForge-Schlüssel übernommen (neu verschlüsselt).');
    } else if (key === 'playit_secret_key') {
      if (!opts.dryRun) secrets.set('playit', value);
      say('ok', 'Einstellungen', 'Playit-Schlüssel übernommen.');
    } else if (key === 'discord_webhook_url') {
      if (!opts.dryRun) registry.setSetting('integrations.discord', { ...(registry.getSetting<object>('integrations.discord') ?? {}), url: value });
      say('ok', 'Einstellungen', 'Discord-Webhook übernommen.');
    } else if (key === 'discord_notifications_enabled') {
      if (!opts.dryRun) registry.setSetting('integrations.discord', { ...(registry.getSetting<object>('integrations.discord') ?? {}), enabled: value !== 'false' });
    } else if (key.startsWith('dns_')) {
      // gesammelt unten
    } else {
      say('warn', 'Einstellungen', `Einstellung "${key}" kennt der Core nicht - nicht übernommen.`);
    }
  }
  const setting = (k: string): string | null => {
    const row = (data.panel_settings ?? []).find((s) => s.key === k);
    if (!row) return null;
    return row.encrypted === true ? decrypt(row.value, `Einstellung ${k}`) : str(row.value);
  };
  const dnsProvider = setting('dns_provider');
  if (dnsProvider && dnsProvider !== 'none') {
    if (!opts.dryRun) {
      new DnsService(registry, secrets).save({
        provider: dnsProvider as 'cloudflare',
        apiToken: setting('dns_api_token'),
        zoneId: setting('dns_zone_id'),
        rootDomain: setting('dns_root_domain'),
        autoSync: setting('dns_auto_sync') === 'true',
        webhookUrl: setting('dns_webhook_url'),
      });
    }
    say('ok', 'Einstellungen', `DNS (${dnsProvider}) übernommen.`);
  }

  // -------------------------------------------------------------- Steam-Konten
  for (const a of data.steam_accounts ?? []) {
    const password = decrypt(a.encrypted_password, `Steam-Konto ${a.account_name}`);
    const res = steamAccounts.importRecord(
      {
        id: String(a.id),
        ownerId: str(a.owner_id),
        ownerName: userName.get(String(a.owner_id)) ?? 'Unbekannt',
        label: str(a.label) ?? String(a.account_name),
        accountName: String(a.account_name),
        steamId: str(a.steam_id),
        isShared: a.is_shared === true,
        lastUsedAt: iso(a.last_used_at),
        createdAt: iso(a.created_at) ?? new Date().toISOString(),
        password,
      },
      opts.dryRun,
    );
    if (res === 'ok') {
      counts.steamAccounts = (counts.steamAccounts ?? 0) + 1;
      say('ok', 'Steam-Konten', `${a.account_name} übernommen${password ? '' : ' (ohne Passwort)'} - einmal "Testen" drücken, die bestätigte Anmeldung (Steam Guard) gilt im Core noch nicht.`);
    } else say('warn', 'Steam-Konten', `${a.account_name} übersprungen: ${res}.`);
  }

  // ------------------------------------------------------------------- Server
  const eggById = new Map((data.eggs ?? []).map((e) => [String(e.id), e]));
  const volumes = path.resolve(opts.volumesDir);
  for (const s of data.servers ?? []) {
    const short = String(s.short_id);
    const label = `${s.name} (${short})`;
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(short)) {
      say('error', 'Server', `${label}: ungültige Kennung.`);
      continue;
    }
    if (registry.get(short)) {
      say('warn', 'Server', `${label}: gibt es im Core schon - übersprungen.`);
      continue;
    }
    const panelEgg = eggById.get(String(s.egg_id));
    const egg = eggs.find((e) => e.name.toLowerCase() === String(panelEgg?.name ?? '').toLowerCase());
    if (!egg) {
      say('error', 'Server', `${label}: Das Spiel "${panelEgg?.name ?? '?'}" kennt der Core nicht - zuerst das Ei (Egg) importieren, dann erneut.`);
      continue;
    }
    // Ports: in der Reihenfolge des Eggs (Hauptport zuerst), Rest hinten
    const allocs = (data.allocations ?? []).filter((a) => a.server_id === s.id);
    const spec = (egg.raw.ports ?? {}) as { primary?: { ref?: string }; secondary?: Array<{ ref?: string }> };
    const order = [spec.primary?.ref, ...(spec.secondary ?? []).map((p) => p.ref)].map((r) => (r ?? '').toLowerCase());
    const used = new Set<unknown>();
    const ports: ServerPort[] = [];
    for (const ref of order) {
      const a = allocs.find((x) => !used.has(x) && String(x.ref ?? '').toLowerCase() === ref);
      if (a) {
        used.add(a);
        ports.push({ name: ref, hostPort: num(a.port), protocol: a.protocol === 'tcp' ? 'tcp' : 'udp' });
      }
    }
    for (const a of allocs.filter((x) => !used.has(x))) {
      say('warn', 'Server', `${label}: Port ${a.port} (${a.ref ?? 'ohne Name'}) gehört nicht zu den Ports des Spiels im Core - nicht übernommen.`);
    }
    if (!ports.length) {
      say('error', 'Server', `${label}: keine Ports zugeteilt.`);
      continue;
    }
    // Image, Variablen
    const image = egg.images.find((i) => i.image === s.docker_image);
    if (!image) say('warn', 'Server', `${label}: Image ${s.docker_image} kennt das Spiel im Core nicht - das Standard-Image wird benutzt.`);
    const variables: Record<string, string> = {};
    for (const v of egg.raw.variables ?? []) variables[v.env_variable] = initialValue(v);
    for (const [k, v] of Object.entries((s.variables ?? {}) as Record<string, unknown>)) if (v !== null && typeof v !== 'object') variables[k] = String(v);
    if (str(s.startup) && egg.raw.startup && String(s.startup).trim() !== String(egg.raw.startup).trim()) {
      say('warn', 'Server', `${label}: Das Startkommando weicht vom Spiel im Core ab - es gilt das des Cores.`);
    }
    // Ordner
    const serverDir = path.join(volumes, short);
    const dirOk = await fs.stat(serverDir).then((st) => st.isDirectory(), () => false);
    if (!dirOk) say('warn', 'Server', `${label}: Ordner ${serverDir} nicht gefunden - ohne ihn startet der Server leer.`);

    const instance = buildDockerInstance({
      id: short,
      name: String(s.name),
      egg,
      serverDir,
      ramMb: num(s.ram_mb, 2048),
      cpuPercent: num(s.cpu_percent, 100),
      variables,
      ports,
      ...(image ? { imageKey: image.key } : {}),
    });
    const withInstall = containerInstallPlan(egg.raw) ? { ...instance, install: { state: 'done' as const, kind: 'container' as const, variables } } : instance;
    if (!opts.dryRun) {
      await registry.add(withInstall);
      saveServerMeta(registry, short, {
        tags: arr(s.tags),
        isFavorite: s.is_favorite === true,
        autoRestart: s.auto_restart === true,
        diskMb: num(s.disk_mb, 10240),
        ...(s.bandwidth_download_kbps != null ? { bandwidthDownloadKbps: num(s.bandwidth_download_kbps) } : {}),
        ...(s.bandwidth_upload_kbps != null ? { bandwidthUploadKbps: num(s.bandwidth_upload_kbps) } : {}),
        ...(str(s.subdomain) ? { subdomain: str(s.subdomain)! } : {}),
        ...(str(s.custom_domain) ? { customDomain: str(s.custom_domain)! } : {}),
        srvRecordEnabled: s.srv_record_enabled !== false,
      });
      registry.audit('server.import_panel', short, 'standalone', { name: String(s.name), egg: egg.id });
    }
    // Besitzer und Mitnutzer
    // (Der Benutzer kann im Core schon unter anderer Kennung existiert haben - darum immer ueber den Namen suchen.)
    const coreUserOf = (panelUserId: unknown) => account.list().find((u) => u.username.toLowerCase() === String(userName.get(String(panelUserId)) ?? '').toLowerCase());
    const owner = coreUserOf(s.owner_id);
    if (owner) {
      if (!opts.dryRun) setOwner(registry, short, owner.id);
    } else if (!opts.dryRun || !userName.has(String(s.owner_id))) {
      say('warn', 'Server', `${label}: Besitzer nicht gefunden - der Server gehört niemandem (nur Administratoren sehen ihn).`);
    }
    for (const su of (data.subusers ?? []).filter((x) => x.server_id === s.id)) {
      const target = coreUserOf(su.user_id);
      const flags = arr(su.permissions).filter(isServerFlag);
      if (target) {
        if (!opts.dryRun) setSubuserFlags(registry, short, target.id, flags);
        say('ok', 'Mitnutzer', `${target.username} auf ${label} (${flags.length} Rechte).`);
      } else if (!opts.dryRun) say('warn', 'Mitnutzer', `${userName.get(String(su.user_id)) ?? su.user_id} auf ${label}: Benutzer nicht gefunden.`);
    }
    // Zeitplaene
    for (const sc of (data.server_schedules ?? []).filter((x) => x.server_id === s.id)) {
      if (!opts.dryRun) {
        const scheduler = new Scheduler(registry, { restart: async () => {}, command: async () => {}, backup: async () => {} });
        scheduler.create(short, { name: String(sc.name), action: sc.action as 'restart', payload: str(sc.payload), cron: str(sc.cron), interval_minutes: sc.interval_minutes == null ? null : num(sc.interval_minutes), active: sc.active !== false });
      }
      counts.schedules = (counts.schedules ?? 0) + 1;
      say('ok', 'Zeitpläne', `${sc.name} auf ${label}.`);
    }
    // Was der Core (noch) nicht kann
    if (num(s.auto_sleep_minutes) > 0) say('warn', 'Server', `${label}: Auto-Sleep gibt es im Core noch nicht.`);
    if (s.auto_backup_enabled === true) say('warn', 'Server', `${label}: Automatische Backups bitte als Zeitplan im Core neu einrichten.`);
    counts.servers = (counts.servers ?? 0) + 1;
    say('ok', 'Server', `${label}: ${egg.name}, ${ports.map((p) => `${p.name}:${p.hostPort}`).join(' ')}, Ordner ${serverDir}${s.status === 'running' ? ' - läuft im Panel noch, muss dort zuerst gestoppt werden' : ''}.`);
  }
  if ((data.backups ?? []).length) say('warn', 'Backups', `${data.backups!.length} Backups werden noch nicht übernommen (Dateien bleiben unter dem Backup-Ordner des Panels liegen).`);
  if ((data.storage_targets ?? []).length) say('warn', 'Speicherziele', `${data.storage_targets!.length} Speicherziele nicht übernommen - im Core neu anlegen.`);
  if ((data.player_bans ?? []).length) say('warn', 'Spieler', `${data.player_bans!.length} Spielersperren nicht übernommen.`);

  return { dryRun: opts.dryRun, lines, counts, errors: lines.filter((l) => l.level === 'error').length, warnings: lines.filter((l) => l.level === 'warn').length };
}
