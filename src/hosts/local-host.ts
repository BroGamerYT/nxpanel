import { hostname, platform, arch } from 'node:os';
import { sql } from '../db/index.js';
import { engine } from '../docker/client.js';
import { hostInfo } from '../host.js';
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

/**
 * Der lokale Host: der Rechner, auf dem das Panel selbst laeuft.
 *
 * LocalHost ist ein reiner Adapter auf den heutigen Docker-Code. Er aendert
 * an dem Verhalten nichts - er macht nur sichtbar, dass der Weg zum Host
 * immer gleich aussieht, egal ob "local" oder "core" dahintersteckt.
 */
export class LocalHost implements Host {
  readonly type: HostType = 'local';

  constructor(
    readonly id: string,
    readonly runtime: HostRuntime = 'docker',
  ) {}

  async info(): Promise<HostInfo> {
    const [row] = await sql<{ name: string }[]>`SELECT name FROM nodes WHERE id = ${this.id}`;
    const live = await hostInfo();
    return {
      name: row?.name ?? hostname(),
      platform: platform(),
      arch: arch(),
      runtime: this.runtime,
      version: 'lokal',
      metrics: {
        cpuPercent: live.cpuPercent ?? 0,
        ramTotalMb: live.ramTotalMb,
        ramUsedMb: live.ramUsedMb,
        diskTotalMb: live.diskTotalMb,
        diskUsedMb: live.diskUsedMb,
      },
    };
  }

  async listServers(): Promise<HostServer[]> {
    const rows = await sql<{ id: string; name: string; status: string }[]>`
      SELECT id, name, status FROM servers WHERE node_id = ${this.id} ORDER BY created_at`;
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status }));
  }

  async power(serverId: string, action: PowerAction): Promise<void> {
    const containerId = await this.containerId(serverId);
    if (!containerId) throw new Error(`Server ${serverId} hat keinen Container`);

    if (action === 'start') {
      await engine.start(containerId);
      return;
    }
    if (action === 'stop') {
      await engine.stopGraceful(containerId, 30);
      return;
    }
    await engine.kill(containerId);
  }

  async stats(serverId: string): Promise<HostServerStats> {
    const [row] = await sql<{ status: string; container_id: string | null; started_at: Date | null }[]>`
      SELECT status, container_id, started_at FROM servers WHERE id = ${serverId}`;
    if (!row) throw new Error(`Server ${serverId} nicht gefunden`);

    const live = await this.oneShotStats(row.container_id);
    const uptimeSeconds = row.started_at
      ? Math.floor((Date.now() - new Date(row.started_at).getTime()) / 1000)
      : 0;

    return {
      serverId,
      status: row.status,
      cpuPercent: live.cpuPercent,
      memoryMb: live.memMb,
      uptimeSeconds: Math.max(0, uptimeSeconds),
    };
  }

  async logs(serverId: string, limit = 100): Promise<HostLogLine[]> {
    const containerId = await this.containerId(serverId);
    if (!containerId) return [];
    const lines = await engine.tailLogs(containerId, limit);
    return lines.map((line) => ({ ts: new Date().toISOString(), line, stream: 'stdout' }));
  }

  private async containerId(serverId: string): Promise<string | null> {
    const [row] = await sql<{ container_id: string | null }[]>`
      SELECT container_id FROM servers WHERE id = ${serverId} AND node_id = ${this.id}`;
    return row?.container_id ?? null;
  }

  /**
   * Ein einzelner Wert aus dem Statistik-Stream.
   *
   * Der Stream liefert laufend Werte; fuer eine einzelne Abfrage wird der
   * erste Wert genommen und die Anmeldung wieder abgemeldet.
   */
  private oneShotStats(containerId: string | null): Promise<{ cpuPercent: number; memMb: number }> {
    if (!containerId) return Promise.resolve({ cpuPercent: 0, memMb: 0 });
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: { cpuPercent: number; memMb: number }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stop?.();
        resolve(value);
      };
      const timer = setTimeout(() => finish({ cpuPercent: 0, memMb: 0 }), 3000);
      let stop: (() => void) | null = null;
      void engine
        .streamStats(containerId, (s) => {
          finish({ cpuPercent: s.cpuPercent ?? 0, memMb: s.memMb ?? 0 });
        })
        .then((s) => {
          stop = s;
          if (done) s();
        })
        .catch(() => finish({ cpuPercent: 0, memMb: 0 }));
    });
  }
}
