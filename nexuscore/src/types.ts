/**
 * Protokoll-Typen fuer die Schnittstelle zwischen NexusPanel und NexusCore.
 *
 * Diese Datei ist die gemeinsame Wahrheit: HTTP-Schicht, Treiber und Event-Bus
 * sprechen ausschliesslich mit diesen Typen. Aendert sich das Protokoll, aendert
 * sich zuerst diese Datei.
 */

export type HostRuntime = 'windows-native' | 'docker' | 'mock';

export interface HostInfo {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  arch: string;
  runtime: HostRuntime;
  version: string;
  uptimeSeconds: number;
}

export interface SystemMetrics {
  cpuUsagePercent: number;
  totalMemoryMb: number;
  usedMemoryMb: number;
  freeMemoryMb: number;
  diskTotalGb: number;
  diskFreeGb: number;
}

export interface ServerPort {
  name: string;
  hostPort: number;
  containerPort?: number;
  protocol: 'tcp' | 'udp';
}

export interface ServerInstanceConfig {
  id: string;
  name: string;
  game: string;
  executable: string;
  args: string[];
  workingDir: string;
  maxMemoryMb?: number;
  maxCpuPercent?: number;
  ports: ServerPort[];
  env?: Record<string, string>;
}

export type ServerStatus = 'offline' | 'starting' | 'running' | 'stopping' | 'error';

export interface ServerState {
  id: string;
  status: ServerStatus;
  pid?: number;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number;
  memoryMb?: number;
  cpuPercent?: number;
}

export interface ServerStats {
  serverId: string;
  status: ServerStatus;
  pid?: number;
  cpuPercent: number;
  memoryMb: number;
  uptimeSeconds: number;
  startedAt?: string;
}

export interface LogLine {
  serverId: string;
  line: string;
  stream: 'stdout' | 'stderr';
  ts: string;
}

/** Alle Ereignisse, die ueber den WebSocket-Stream ausgeliefert werden. */
export type CoreEvent =
  | { type: 'console'; serverId: string; line: string; stream: 'stdout' | 'stderr'; ts: string }
  | { type: 'state'; serverId: string; state: ServerState; ts: string }
  | { type: 'metrics'; metrics: SystemMetrics; ts: string };
