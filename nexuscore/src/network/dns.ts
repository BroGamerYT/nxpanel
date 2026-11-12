import type { ServerRegistry } from '../store/registry.js';
import type { SecretStore } from '../store/secrets.js';
import { getServerMeta } from '../http/routes/settings.js';

/**
 * Domain und DNS: der Core haelt die Adresse des Rechners beim DNS-Anbieter aktuell (A-Eintrag der Hauptdomain), legt je Server
 * mit Subdomain einen A-Eintrag an und fuer Spiele mit bekanntem Dienst (Minecraft, TeamSpeak, Terraria) einen SRV-Eintrag,
 * damit Spieler ohne Portnummer beitreten. Anbieter: Cloudflare, Hetzner, DuckDNS oder eine eigene Webhook-Adresse.
 *
 * Der API-Token liegt im verschluesselten Speicher und geht nie in eine Antwort. Netzzugriffe sind ersetzbar (Tests).
 */

export type DnsProviderKind = 'none' | 'cloudflare' | 'hetzner' | 'duckdns' | 'webhook';

export class DnsError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'dns_error') {
    super(message);
    this.name = 'DnsError';
  }
}

interface Stored {
  provider: DnsProviderKind;
  zoneId: string | null;
  rootDomain: string | null;
  autoSync: boolean;
  webhookUrl: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastIp: string | null;
}

export interface DnsConfigView extends Stored {
  /** Der Token selbst geht nie raus - nur ob einer da ist (und ob er sich noch lesen laesst). */
  apiToken: string | null;
  hasToken: boolean;
  tokenUnreadable?: true;
}

export interface SaveDnsInput {
  provider?: DnsProviderKind | undefined;
  apiToken?: string | null | undefined;
  zoneId?: string | null | undefined;
  rootDomain?: string | null | undefined;
  autoSync?: boolean | undefined;
  webhookUrl?: string | null | undefined;
}

export interface ServerSyncTarget {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  srvRecordEnabled: boolean;
  primaryPort: number;
  eggName: string;
  gameKind: string | null;
}

export interface SyncResult {
  ok: boolean;
  updated: number;
  ip: string;
  message: string;
}

export type DnsFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GameSrvMeta {
  service: string;
  proto: string;
  defaultPort: number;
}

/** Hat das Spiel einen Dienst, fuer den ein SRV-Eintrag sinnvoll ist? */
export function getGameSrvMeta(eggName: string, gameKind?: string | null): GameSrvMeta | null {
  const kind = (gameKind || '').toLowerCase();
  const name = eggName.toLowerCase();
  if (kind === 'minecraft' || /minecraft|paper|purpur|fabric|forge|spigot/.test(name)) return { service: '_minecraft', proto: '_tcp', defaultPort: 25565 };
  if (/teamspeak|ts3/.test(name)) return { service: '_ts3', proto: '_udp', defaultPort: 9987 };
  if (name.includes('terraria')) return { service: '_terraria', proto: '_tcp', defaultPort: 7777 };
  return null;
}

export const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const TOKEN_NAME = 'dns-token';
const SETTING = 'dns.config';
const EMPTY: Stored = { provider: 'none', zoneId: null, rootDomain: null, autoSync: false, webhookUrl: null, lastSyncAt: null, lastSyncStatus: null, lastIp: null };
const TTL = 300;

interface Rec {
  id: string;
  type: string;
  name: string;
  content?: string;
  value?: string;
  data?: { port?: number; target?: string };
}

export class DnsService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SyncResult> | null = null;

  constructor(
    private readonly registry: ServerRegistry,
    private readonly secrets: SecretStore,
    private readonly io: { fetch?: DnsFetch; publicIp?: () => Promise<string> } = {},
  ) {}

  private get http(): DnsFetch {
    return this.io.fetch ?? ((url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }));
  }

  private stored(): Stored {
    return { ...EMPTY, ...(this.registry.getSetting<Partial<Stored>>(SETTING) ?? {}) };
  }

  private patchStored(p: Partial<Stored>): void {
    this.registry.setSetting(SETTING, { ...this.stored(), ...p });
  }

  view(): DnsConfigView {
    const s = this.stored();
    const status = this.secrets.status(TOKEN_NAME);
    return { ...s, apiToken: status === 'ok' ? '••••••••' : null, hasToken: status === 'ok', ...(status === 'unreadable' ? { tokenUnreadable: true as const } : {}) };
  }

  save(input: SaveDnsInput): void {
    const p: Partial<Stored> = {};
    if (input.provider !== undefined) p.provider = input.provider;
    if (input.zoneId !== undefined) p.zoneId = input.zoneId?.trim() || null;
    if (input.rootDomain !== undefined) {
      const d = input.rootDomain?.trim().toLowerCase() || null;
      if (d && !DOMAIN_PATTERN.test(d)) throw new DnsError('Das ist keine gültige Domain (z. B. meinedomain.de).', 400, 'invalid_domain');
      p.rootDomain = d;
    }
    if (input.autoSync !== undefined) p.autoSync = input.autoSync;
    if (input.webhookUrl !== undefined) {
      const u = input.webhookUrl?.trim() || null;
      if (u) {
        let parsed: URL | null = null;
        try {
          parsed = new URL(u.replace('{ip}', '1.2.3.4').replace('{domain}', 'example.org'));
        } catch {
          parsed = null;
        }
        if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new DnsError('Die Webhook-Adresse muss mit http:// oder https:// beginnen.', 400, 'invalid_webhook');
      }
      p.webhookUrl = u;
    }
    if (input.apiToken !== undefined) {
      const t = input.apiToken?.trim();
      if (t) this.secrets.set(TOKEN_NAME, t);
      else this.secrets.delete(TOKEN_NAME);
    }
    this.patchStored(p);
  }

  /** Alle Server mit Subdomain, mit ihrem ersten Port. */
  targets(): ServerSyncTarget[] {
    const out: ServerSyncTarget[] = [];
    for (const c of this.registry.list()) {
      const meta = getServerMeta(this.registry, c.id);
      const port = c.ports[0]?.hostPort;
      if (!meta.subdomain || !port) continue;
      out.push({
        id: c.id,
        name: c.name,
        subdomain: meta.subdomain,
        customDomain: meta.customDomain ?? null,
        srvRecordEnabled: meta.srvRecordEnabled ?? true,
        primaryPort: port,
        eggName: c.game || '',
        gameKind: c.game?.toLowerCase().includes('minecraft') ? 'minecraft' : null,
      });
    }
    return out;
  }

  async publicIp(): Promise<string> {
    if (this.io.publicIp) return this.io.publicIp();
    const res = await this.http('https://api.ipify.org?format=json');
    if (!res.ok) throw new DnsError(`Die öffentliche Adresse ließ sich nicht ermitteln (HTTP ${res.status}).`);
    const ip = ((await res.json()) as { ip?: string }).ip?.trim();
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new DnsError('Die öffentliche Adresse ließ sich nicht ermitteln.');
    return ip;
  }

  // ------------------------------------------------------------------ Anbieter

  private token(override?: string): string {
    const t = override?.trim() || (this.secrets.status(TOKEN_NAME) === 'ok' ? this.secrets.get(TOKEN_NAME) : null);
    if (!t) throw new DnsError('Kein API-Token angegeben', 400, 'missing_token');
    return t;
  }

  private async cf<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => null)) as { success?: boolean; errors?: Array<{ message?: string }>; result?: T } | null;
    if (!res.ok || !data?.success) {
      const why = data?.errors?.map((e) => e.message).filter(Boolean).join('; ');
      throw new DnsError(`Cloudflare lehnt die Anfrage ab (HTTP ${res.status}${why ? `: ${why}` : ''}).`, 502, 'provider_error');
    }
    return data.result as T;
  }

  private async hz<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http(`https://dns.hetzner.com/api/v1${path}`, {
      method,
      headers: { 'Auth-API-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new DnsError(`Hetzner DNS lehnt die Anfrage ab (HTTP ${res.status}).`, 502, 'provider_error');
    return (await res.json().catch(() => ({}))) as T;
  }

  /** Prueft Token und Domain beim Anbieter. DuckDNS und Webhook kennen keinen Test ausser der Eingabe. */
  async test(input: { provider: Exclude<DnsProviderKind, 'none'>; apiToken?: string | undefined; rootDomain: string; zoneId?: string | undefined }): Promise<{ ok: boolean; zoneId?: string; domain: string; message: string }> {
    const domain = input.rootDomain.trim().toLowerCase();
    if (!DOMAIN_PATTERN.test(domain)) throw new DnsError('Das ist keine gültige Domain (z. B. meinedomain.de).', 400, 'invalid_domain');
    if (input.provider === 'cloudflare') {
      const token = this.token(input.apiToken);
      let zoneId = input.zoneId?.trim() || null;
      if (!zoneId) {
        const zones = await this.cf<Array<{ id: string }>>(token, 'GET', `/zones?name=${encodeURIComponent(domain)}`);
        if (!zones?.[0]) throw new DnsError(`Zone für Domain "${domain}" wurde in deinem Cloudflare-Account nicht gefunden.`, 404, 'zone_not_found');
        zoneId = zones[0].id;
      } else {
        await this.cf(token, 'GET', `/zones/${encodeURIComponent(zoneId)}`);
      }
      return { ok: true, zoneId, domain, message: `Verbindung zu Cloudflare Zone "${domain}" (${zoneId}) erfolgreich!` };
    }
    if (input.provider === 'hetzner') {
      const token = this.token(input.apiToken);
      let zoneId = input.zoneId?.trim() || null;
      if (!zoneId) {
        const data = await this.hz<{ zones?: Array<{ id: string; name: string }> }>(token, 'GET', '/zones');
        const found = data.zones?.find((z) => z.name.toLowerCase() === domain);
        if (!found) throw new DnsError(`Hetzner DNS-Zone für "${domain}" nicht gefunden.`, 404, 'zone_not_found');
        zoneId = found.id;
      }
      return { ok: true, zoneId, domain, message: `Verbindung zu Hetzner DNS Zone "${domain}" (${zoneId}) erfolgreich!` };
    }
    // Wie im Panel: hier laesst sich ohne eine Aenderung nichts pruefen - ehrlich sagen
    return { ok: true, domain, message: `Die Angaben für ${input.provider} sind formal in Ordnung. Ob sie stimmen, zeigt erst die Synchronisation.` };
  }

  // ----------------------------------------------------------------- Abgleich

  /** Einen Abgleich nach dem anderen: laeuft schon einer, bekommen alle Aufrufer dessen Ergebnis. */
  sync(): Promise<SyncResult> {
    if (!this.running) this.running = this.syncOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async syncOnce(): Promise<SyncResult> {
    const cfg = this.stored();
    if (cfg.provider === 'none') return { ok: true, updated: 0, ip: '', message: 'DNS-Synchronisation ist deaktiviert.' };
    try {
      const ip = await this.publicIp();
      const servers = this.targets();
      let updated = 0;
      if (cfg.provider === 'cloudflare') updated = await this.syncCloudflare(cfg, ip, servers);
      else if (cfg.provider === 'hetzner') updated = await this.syncHetzner(cfg, ip, servers);
      else if (cfg.provider === 'duckdns') updated = await this.syncDuck(cfg, ip);
      else updated = await this.syncWebhook(cfg, ip);
      this.patchStored({ lastSyncAt: new Date().toISOString(), lastSyncStatus: 'OK', lastIp: ip });
      return { ok: true, updated, ip, message: `Erfolgreich synchronisiert! Öffentliche IP: ${ip}, ${servers.length} Gameserver-Subdomain(s) aktiv.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.patchStored({ lastSyncAt: new Date().toISOString(), lastSyncStatus: `Fehler: ${msg}` });
      throw err;
    }
  }

  private async syncCloudflare(cfg: Stored, ip: string, servers: ServerSyncTarget[]): Promise<number> {
    const root = cfg.rootDomain;
    if (!root) throw new DnsError('Cloudflare API-Token und Root-Domain müssen hinterlegt sein.');
    const token = this.token();
    let zoneId = cfg.zoneId;
    if (!zoneId) {
      zoneId = (await this.test({ provider: 'cloudflare', rootDomain: root })).zoneId ?? null;
      this.patchStored({ zoneId });
    }
    const zone = encodeURIComponent(zoneId!);
    const records = (await this.cf<Rec[]>(token, 'GET', `/zones/${zone}/dns_records?per_page=1000`)) ?? [];
    let updated = 0;

    const upsert = async (existing: Rec | undefined, body: Record<string, unknown>, changed: boolean): Promise<void> => {
      if (!existing) await this.cf(token, 'POST', `/zones/${zone}/dns_records`, body);
      else if (changed) await this.cf(token, 'PUT', `/zones/${zone}/dns_records/${existing.id}`, body);
      else return;
      updated++;
    };
    const aBody = (name: string, comment: string) => ({ type: 'A', name, content: ip, ttl: TTL, proxied: false, comment });
    const find = (type: string, name: string) => records.find((r) => r.type === type && r.name.toLowerCase() === name.toLowerCase());

    const rootRec = find('A', root);
    await upsert(rootRec, aBody(root, 'NexusCore Host-IP (DDNS)'), rootRec?.content !== ip);

    for (const s of servers) {
      const fqdn = `${s.subdomain}.${root}`;
      const aRec = find('A', fqdn);
      await upsert(aRec, aBody(fqdn, `NexusCore: ${s.name} (${s.id})`), aRec?.content !== ip);
      const srv = s.srvRecordEnabled ? getGameSrvMeta(s.eggName, s.gameKind) : null;
      if (srv) {
        const rec = find('SRV', `${srv.service}.${srv.proto}.${fqdn}`);
        const body = {
          type: 'SRV',
          data: { service: srv.service, proto: srv.proto, name: s.subdomain, priority: 0, weight: 5, port: s.primaryPort, target: fqdn },
          ttl: TTL,
          comment: `NexusCore SRV: ${s.name} Port ${s.primaryPort}`,
        };
        // Aendert sich der Port, muss auch der SRV-Eintrag nachziehen
        await upsert(rec, body, rec?.data?.port !== s.primaryPort || rec?.data?.target?.toLowerCase() !== fqdn);
      }
    }
    return updated;
  }

  private async syncHetzner(cfg: Stored, ip: string, servers: ServerSyncTarget[]): Promise<number> {
    const root = cfg.rootDomain;
    if (!root) throw new DnsError('Hetzner API-Token und Root-Domain müssen hinterlegt sein.');
    const token = this.token();
    let zoneId = cfg.zoneId;
    if (!zoneId) {
      zoneId = (await this.test({ provider: 'hetzner', rootDomain: root })).zoneId ?? null;
      this.patchStored({ zoneId });
    }
    const records = (await this.hz<{ records?: Rec[] }>(token, 'GET', `/records?zone_id=${encodeURIComponent(zoneId!)}`)).records ?? [];
    let updated = 0;
    const upsert = async (existing: Rec | undefined, name: string, type: 'A' | 'SRV', value: string): Promise<void> => {
      const body = { zone_id: zoneId, type, name, value, ttl: TTL };
      if (!existing) await this.hz(token, 'POST', '/records', body);
      else if (existing.value !== value) await this.hz(token, 'PUT', `/records/${existing.id}`, body);
      else return;
      updated++;
    };
    const find = (type: string, name: string) => records.find((r) => r.type === type && r.name.toLowerCase() === name.toLowerCase());
    const rootRec = records.find((r) => r.type === 'A' && (r.name === '@' || r.name === ''));
    await upsert(rootRec, '@', 'A', ip);
    for (const s of servers) {
      await upsert(find('A', s.subdomain), s.subdomain, 'A', ip);
      const srv = s.srvRecordEnabled ? getGameSrvMeta(s.eggName, s.gameKind) : null;
      if (srv) {
        const name = `${srv.service}.${srv.proto}.${s.subdomain}`;
        await upsert(find('SRV', name), name, 'SRV', `0 5 ${s.primaryPort} ${s.subdomain}.${root}.`);
      }
    }
    return updated;
  }

  private async syncDuck(cfg: Stored, ip: string): Promise<number> {
    if (!cfg.rootDomain) throw new DnsError('DuckDNS Token und Domain müssen angegeben sein.');
    const token = this.token();
    const res = await this.http(`https://www.duckdns.org/update?domains=${encodeURIComponent(cfg.rootDomain.replace(/\.duckdns\.org$/, ''))}&token=${encodeURIComponent(token)}&ip=${encodeURIComponent(ip)}`);
    const text = (await res.text()).trim();
    if (!res.ok || !text.startsWith('OK')) throw new DnsError(`DuckDNS Fehler: ${text.slice(0, 100)}`, 502, 'provider_error');
    return 1;
  }

  private async syncWebhook(cfg: Stored, ip: string): Promise<number> {
    if (!cfg.webhookUrl) throw new DnsError('Webhook URL ist nicht konfiguriert.');
    const url = cfg.webhookUrl.replace('{ip}', encodeURIComponent(ip)).replace('{domain}', encodeURIComponent(cfg.rootDomain || ''));
    const res = await this.http(url);
    if (!res.ok) throw new DnsError(`Webhook Fehler: HTTP ${res.status}`, 502, 'provider_error');
    return 1;
  }

  // -------------------------------------------------------------- Hintergrund

  /** Alle 5 Minuten: hat sich die Adresse geaendert (und ist der automatische Abgleich an), wird abgeglichen. */
  start(intervalMs = 5 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const cfg = this.stored();
    if (cfg.provider === 'none' || !cfg.autoSync) return;
    const ip = await this.publicIp().catch(() => null);
    if (ip && ip !== cfg.lastIp) await this.sync().catch(() => {});
  }
}
