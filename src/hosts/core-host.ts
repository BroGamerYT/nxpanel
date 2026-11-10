import { createHash } from 'node:crypto';
import { log } from '../log.js';
import type {
  Host,
  HostInfo,
  HostLogLine,
  HostRuntime,
  HostServer,
  HostServerStats,
  HostType,
  PowerAction,
} from './types.js';

/** Zeitlimit fuer eine Anfrage an den Core. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Der NexusCore antwortet auf /core/v1/pair mit dem Fingerabdruck seines Tokens. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Ein gekoppelter NexusCore.
 *
 * Der Core spricht das Protokoll /core/v1 (siehe nexuscore/CORE_PROTOCOL.md).
 * Authentifiziert wird mit dem Bearer-Token des Cores - es liegt verschluesselt
 * in der Datenbank und wird nur hier entschluesselt.
 */
export class CoreHost implements Host {
  readonly type: HostType = 'core';

  constructor(
    readonly id: string,
    readonly address: string,
    readonly token: string,
    readonly runtime: HostRuntime = 'docker',
  ) {}

  async info(): Promise<HostInfo> {
    const body = await this.request<{
      host: { name: string; platform: string; arch: string; runtime: string; version: string };
      metrics?: {
        cpuUsagePercent?: number;
        totalMemoryMb?: number;
        usedMemoryMb?: number;
        diskTotalGb?: number;
        diskFreeGb?: number;
      };
    }>('/core/v1/info');
    const metrics = body.metrics;
    return {
      name: body.host.name,
      platform: body.host.platform,
      arch: body.host.arch,
      runtime: body.host.runtime,
      version: body.host.version,
      ...(metrics
        ? {
            metrics: {
              cpuPercent: metrics.cpuUsagePercent ?? 0,
              ramTotalMb: Math.round(metrics.totalMemoryMb ?? 0),
              ramUsedMb: Math.round(metrics.usedMemoryMb ?? 0),
              diskTotalMb: Math.round((metrics.diskTotalGb ?? 0) * 1024),
              diskUsedMb: Math.round(((metrics.diskTotalGb ?? 0) - (metrics.diskFreeGb ?? 0)) * 1024),
            },
          }
        : {}),
    };
  }

  async listServers(): Promise<HostServer[]> {
    const body = await this.request<{ servers: { id: string; status: string }[] }>('/core/v1/servers');
    return body.servers.map((s) => ({ id: s.id, name: s.id, status: s.status }));
  }

  async power(serverId: string, action: PowerAction): Promise<void> {
    await this.request(`/core/v1/servers/${encodeURIComponent(serverId)}/${action}`, { method: 'POST' });
  }

  async stats(serverId: string): Promise<HostServerStats> {
    const body = await this.request<{ stats: HostServerStats }>(
      `/core/v1/servers/${encodeURIComponent(serverId)}/stats`,
    );
    return body.stats;
  }

  async logs(serverId: string, limit = 100): Promise<HostLogLine[]> {
    const body = await this.request<{ lines: { ts: string; line: string; stream: 'stdout' | 'stderr' }[] }>(
      `/core/v1/servers/${encodeURIComponent(serverId)}/logs?limit=${limit}`,
    );
    return body.lines;
  }

  /**
   * Eine Anfrage an den Core.
   *
   * Fehler des Cores werden als lesbare Meldung weitergereicht - im Log steht
   * nie das Token.
   */
  private async request<T>(path: string, init: { method?: string } = {}): Promise<T> {
    const url = `${this.address.replace(/\/+$/, '')}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ err, url }, 'NexusCore nicht erreichbar');
      throw new Error(`NexusCore nicht erreichbar (${reason})`);
    }

    if (!response.ok) {
      const detail = await readError(response);
      throw new Error(`NexusCore antwortet mit ${response.status}${detail ? `: ${detail}` : ''}`);
    }

    return (await response.json()) as T;
  }
}

/** Liest die Fehlermeldung aus einer Antwort des Cores. */
async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? '';
  } catch {
    return '';
  }
}
