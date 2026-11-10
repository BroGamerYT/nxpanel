/**
 * Gemeinsame Typen der Host-Schicht.
 *
 * Ein Host ist entweder der, auf dem das Panel selbst laeuft (local), oder
 * ein gekoppelter NexusCore (core). Beide muessen dem Panel dieselben
 * Auskunft geben koennen - sonst haengt der Rest des Panels an der konkreten
 * Art des Hosts.
 */

export type HostType = 'local' | 'core';

export type HostRuntime = 'docker' | 'podman' | 'windows-native' | 'mock';

export type HostStatus = 'online' | 'offline' | 'unreachable' | 'unknown';

export type PowerAction = 'start' | 'stop' | 'kill';

/** Ein Host, wie er in der Datenbank steht. */
export interface HostRow {
  id: string;
  name: string;
  type: HostType;
  address: string | null;
  runtime: HostRuntime;
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

/** Auskunft ueber den Host selbst (Name, Plattform, Version). */
export interface HostInfo {
  name: string;
  platform: string;
  arch: string;
  runtime: string;
  version: string;
  /** Aktuelle Auslastung des Hosts, wenn der Host sie melden kann. */
  metrics?: {
    cpuPercent: number;
    ramTotalMb: number;
    ramUsedMb: number;
    diskTotalMb: number;
    diskUsedMb: number;
  };
}

/** Eine Instanz auf dem Host. */
export interface HostServer {
  id: string;
  name: string;
  status: string;
}

export interface HostServerStats {
  serverId: string;
  status: string;
  cpuPercent: number;
  memoryMb: number;
  uptimeSeconds: number;
}

export interface HostLogLine {
  ts: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

/**
 * Das, was das Panel von jedem Host braucht.
 *
 * Der Umfang ist bewusst klein: Dateien, Backups und Spielabfragen liegen auf
 * dem Host und kommen mit dem Host-Ausbau in M5 dazu.
 */
export interface Host {
  readonly id: string;
  readonly type: HostType;
  readonly runtime: HostRuntime;
  info(): Promise<HostInfo>;
  listServers(): Promise<HostServer[]>;
  power(serverId: string, action: PowerAction): Promise<void>;
  stats(serverId: string): Promise<HostServerStats>;
  logs(serverId: string, limit?: number): Promise<HostLogLine[]>;
}
