import crypto from 'node:crypto';
import type { ServerRegistry } from '../store/registry.js';
import type { SecretStore } from '../store/secrets.js';

/**
 * Gekoppelte Cores. Jeder Core laeuft allein, solange nichts gekoppelt ist. Wird ein anderer Core gekoppelt, kann dieser
 * Core dort nur: Status und Auslastung abfragen, Server anzeigen, anlegen, starten, stoppen und beenden. Dateien, Konsole
 * und Backups bleiben auf dem jeweiligen Rechner (dort in dessen eigener Oberflaeche).
 *
 * Die Kopplung braucht die Adresse und das Token des anderen Cores (NEXUSCORE_TOKEN dort); das Token liegt im
 * verschluesselten Speicher und geht nie in eine Antwort oder ins Protokoll.
 */

export class HostError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'host_error') {
    super(message);
    this.name = 'HostError';
  }
}

export type HostStatus = 'online' | 'offline' | 'unreachable' | 'unknown';
export type HostFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type PowerAction = 'start' | 'stop' | 'kill';

export interface HostRowView {
  id: string;
  name: string;
  type: 'local' | 'core';
  address: string | null;
  runtime: string;
  status: HostStatus;
  certFingerprint: string | null;
  lastSeenAt: string | null;
  ramTotalMb: number;
  ramUsedMb: number;
  diskTotalMb: number;
  diskUsedMb: number;
  cpuPercent: number;
  servers: number;
}

interface Rec {
  id: string;
  name: string;
  address: string;
  runtime: string;
  status: HostStatus;
  lastSeenAt: string | null;
  ramTotalMb: number;
  ramUsedMb: number;
  diskTotalMb: number;
  diskUsedMb: number;
  cpuPercent: number;
  servers: number;
  createdAt: string;
}

export interface RemoteServer {
  id: string;
  name: string;
  game: string;
  status: string;
}

interface Info {
  host?: { name?: string; runtime?: string };
  metrics?: { cpuUsagePercent?: number; totalMemoryMb?: number; usedMemoryMb?: number; diskTotalGb?: number; diskFreeGb?: number };
  core?: { tokenFingerprint?: string };
}

const SETTING = 'hosts.list';
const secretName = (id: string): string => `host.${id}.token`;
const TIMEOUT_MS = 8_000;

export const fingerprintOf = (token: string): string => crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);

/** Adresse eines Cores: nur http(s), ohne Zugangsdaten und Pfad. */
export function normalizeAddress(address: string): string {
  let u: URL;
  try {
    u = new URL(address.trim());
  } catch {
    throw new HostError('Adresse muss eine URL sein, z. B. http://192.168.1.50:8443', 400, 'invalid_address');
  }
  if (!/^https?:$/.test(u.protocol)) throw new HostError('Die Adresse muss mit http:// oder https:// beginnen.', 400, 'invalid_address');
  if (u.username || u.password) throw new HostError('Zugangsdaten gehören nicht in die Adresse - das Token wird getrennt eingetragen.', 400, 'invalid_address');
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new HostError('Die Adresse besteht nur aus Rechner und Port, z. B. http://192.168.1.50:8443', 400, 'invalid_address');
  return u.origin;
}

export class RemoteHosts {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: ServerRegistry,
    private readonly secrets: SecretStore,
    private readonly io: { fetch?: HostFetch; ownFingerprint?: () => string } = {},
  ) {}

  private get http(): HostFetch {
    return this.io.fetch ?? ((url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) }));
  }

  private all(): Rec[] {
    return this.registry.getSetting<Rec[]>(SETTING) ?? [];
  }
  private put(list: Rec[]): void {
    this.registry.setSetting(SETTING, list);
  }
  private view(r: Rec): HostRowView {
    return { id: r.id, name: r.name, type: 'core', address: r.address, runtime: r.runtime, status: r.status, certFingerprint: null, lastSeenAt: r.lastSeenAt, ramTotalMb: r.ramTotalMb, ramUsedMb: r.ramUsedMb, diskTotalMb: r.diskTotalMb, diskUsedMb: r.diskUsedMb, cpuPercent: r.cpuPercent, servers: r.servers };
  }
  private require(id: string): Rec {
    const r = this.all().find((x) => x.id === id);
    if (!r) throw new HostError('Host nicht gefunden', 404, 'not_found');
    return r;
  }
  private tokenOf(id: string): string {
    const t = this.secrets.status(secretName(id)) === 'ok' ? this.secrets.get(secretName(id)) : null;
    if (!t) throw new HostError('Das Token dieses Hosts ist nicht lesbar - bitte neu eintragen.', 400, 'token_unreadable');
    return t;
  }

  list(): HostRowView[] {
    return this.all().map((r) => this.view(r));
  }
  has(id: string): boolean {
    return this.all().some((r) => r.id === id);
  }

  // ----------------------------------------------------------- Zugriff auf den anderen Core

  private async request<T>(address: string, token: string | null, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.http(`${address}${path}`, {
        method: init.method ?? 'GET',
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err) {
      throw new HostError(`Der Core ist nicht erreichbar (${err instanceof Error ? err.message : String(err)})`, 502, 'unreachable');
    }
    const body = (await res.json().catch(() => null)) as (T & { message?: string; error?: string }) | null;
    if (res.status === 401 || res.status === 403) throw new HostError('Der Core lehnt das Token ab', 400, 'token_rejected');
    if (!res.ok) throw new HostError(`Der Core antwortet mit ${res.status}${body?.message || body?.error ? `: ${body.message ?? body.error}` : ''}`, res.status === 404 ? 404 : res.status < 500 ? 400 : 502, 'remote_error');
    return body as T;
  }

  /** Prueft Adresse und Token gegen den echten Core und liefert dessen Angaben. */
  private async verify(address: string, token: string, pin?: string): Promise<Pick<Rec, 'runtime' | 'ramTotalMb' | 'ramUsedMb' | 'diskTotalMb' | 'diskUsedMb' | 'cpuPercent'>> {
    // Mit PIN: der andere Core nennt den Fingerabdruck seines Tokens, der muss zu dem eingegebenen passen
    if (pin) {
      const pair = await this.request<{ core?: { tokenFingerprint?: string } }>(address, null, '/core/v1/pair', { method: 'POST', body: { pin } });
      if (pair.core?.tokenFingerprint !== fingerprintOf(token)) throw new HostError('Das Token passt nicht zu diesem Core - bitte das NEXUSCORE_TOKEN des Cores eintragen.', 400, 'token_mismatch');
    }
    // Immer: ein erfolgreicher Zugriff auf eine geschuetzte Route bestaetigt das Token
    await this.request(address, token, '/core/v1/servers');
    const info = await this.request<Info>(address, null, '/core/v1/info').catch(() => ({}) as Info);
    const own = this.io.ownFingerprint?.();
    if (own && info.core?.tokenFingerprint && info.core.tokenFingerprint === own) throw new HostError('Das ist dieser Core selbst - bitte die Adresse eines anderen Rechners angeben.', 400, 'self');
    return this.metricsOf(info);
  }

  private metricsOf(info: Info): Pick<Rec, 'runtime' | 'ramTotalMb' | 'ramUsedMb' | 'diskTotalMb' | 'diskUsedMb' | 'cpuPercent'> {
    const m = info.metrics ?? {};
    return {
      runtime: info.host?.runtime ?? 'docker',
      ramTotalMb: Math.round(m.totalMemoryMb ?? 0),
      ramUsedMb: Math.round(m.usedMemoryMb ?? 0),
      diskTotalMb: Math.round((m.diskTotalGb ?? 0) * 1024),
      diskUsedMb: Math.round(((m.diskTotalGb ?? 0) - (m.diskFreeGb ?? 0)) * 1024),
      cpuPercent: Math.round((m.cpuUsagePercent ?? 0) * 100) / 100,
    };
  }

  // ------------------------------------------------------------------ Verwaltung

  async create(input: { name: string; address: string; token: string; pin?: string | undefined }): Promise<HostRowView> {
    const address = normalizeAddress(input.address);
    const list = this.all();
    if (list.some((r) => r.name.toLowerCase() === input.name.toLowerCase())) throw new HostError('Ein Host mit diesem Namen gibt es schon.', 409, 'name_taken');
    if (list.some((r) => r.address === address)) throw new HostError('Dieser Core ist schon gekoppelt.', 409, 'address_taken');
    const v = await this.verify(address, input.token, input.pin);
    const rec: Rec = { id: crypto.randomUUID(), name: input.name, address, ...v, status: 'online', lastSeenAt: new Date().toISOString(), servers: 0, createdAt: new Date().toISOString() };
    this.secrets.set(secretName(rec.id), input.token);
    this.put([...list, rec]);
    return this.view(rec);
  }

  async update(id: string, input: { name?: string | undefined; address?: string | undefined; token?: string | undefined }): Promise<HostRowView> {
    const rec = this.require(id);
    const list = this.all();
    if (input.name && list.some((r) => r.id !== id && r.name.toLowerCase() === input.name!.toLowerCase())) throw new HostError('Ein Host mit diesem Namen gibt es schon.', 409, 'name_taken');
    const address = input.address ? normalizeAddress(input.address) : rec.address;
    if (list.some((r) => r.id !== id && r.address === address)) throw new HostError('Dieser Core ist schon gekoppelt.', 409, 'address_taken');
    const token = input.token ?? this.tokenOf(id);
    let next: Rec = { ...rec, name: input.name ?? rec.name, address };
    // Adresse oder Token geaendert: erneut pruefen, ein nicht erreichbarer Host wird nicht gespeichert
    if (input.address !== undefined || input.token !== undefined) {
      next = { ...next, ...(await this.verify(address, token)), status: 'online', lastSeenAt: new Date().toISOString() };
      if (input.token) this.secrets.set(secretName(id), input.token);
    }
    this.put(list.map((r) => (r.id === id ? next : r)));
    return this.view(next);
  }

  delete(id: string): void {
    this.require(id);
    this.secrets.delete(secretName(id));
    this.put(this.all().filter((r) => r.id !== id));
  }

  /** Status neu abfragen. Antwortet der Core nicht, gilt er als nicht erreichbar - er verschwindet nicht aus der Liste. */
  async refresh(id: string): Promise<HostRowView> {
    const rec = this.require(id);
    let next: Rec;
    try {
      const info = await this.request<Info>(rec.address, null, '/core/v1/info');
      // Ein Core, der das Token nicht mehr akzeptiert, ist nicht "online" im Sinn dieses Cores
      await this.request(rec.address, this.tokenOf(id), '/core/v1/servers');
      next = { ...rec, ...this.metricsOf(info), status: 'online', lastSeenAt: new Date().toISOString() };
    } catch {
      next = { ...rec, status: 'unreachable' };
    }
    this.put(this.all().map((r) => (r.id === id ? next : r)));
    return this.view(next);
  }

  async refreshAll(): Promise<void> {
    for (const r of this.all()) await this.refresh(r.id).catch(() => {});
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshAll(), intervalMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------- Server auf dem anderen Core

  async servers(id: string): Promise<RemoteServer[]> {
    const rec = this.require(id);
    const token = this.tokenOf(id);
    let list: RemoteServer[];
    try {
      const body = await this.request<{ servers?: Array<{ id: string; name?: string; eggName?: string; status: string }> }>(rec.address, token, '/api/v1/servers');
      list = (body.servers ?? []).map((s) => ({ id: s.id, name: s.name ?? s.id, game: s.eggName ?? '', status: s.status }));
    } catch (err) {
      // Aeltere Cores kennen nur das Kernprotokoll
      if (!(err instanceof HostError) || err.code !== 'remote_error') throw err;
      const body = await this.request<{ servers?: Array<{ id: string; status: string }> }>(rec.address, token, '/core/v1/servers');
      list = (body.servers ?? []).map((s) => ({ id: s.id, name: s.id, game: '', status: s.status }));
    }
    this.put(this.all().map((r) => (r.id === id ? { ...r, servers: list.length } : r)));
    return list;
  }

  async power(id: string, serverId: string, action: PowerAction): Promise<void> {
    const rec = this.require(id);
    await this.request(rec.address, this.tokenOf(id), `/core/v1/servers/${encodeURIComponent(serverId)}/${action}`, { method: 'POST' });
  }

  /** Legt auf dem anderen Core einen Server aus einem Spiel (Egg) an - dort laeuft die Installation. */
  async createServer(id: string, body: { name: string; eggId: string; ramMb?: number | undefined; cpuPercent?: number | undefined; variables?: Record<string, string> | undefined; imageKey?: string | undefined }): Promise<{ server?: { id: string }; taskId?: string }> {
    const rec = this.require(id);
    const res = await this.request<{ server?: { id: string }; taskId?: string }>(rec.address, this.tokenOf(id), '/api/v1/servers', { method: 'POST', body });
    this.put(this.all().map((r) => (r.id === id ? { ...r, servers: r.servers + 1 } : r)));
    return res;
  }
}
