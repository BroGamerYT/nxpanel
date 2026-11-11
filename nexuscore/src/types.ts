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
  /**
   * Befehl, der den Server sauber beendet (z. B. "stop" bei Minecraft). Er
   * geht an stdin; erst wenn er nicht wirkt, wird der Prozess beendet.
   */
  stopCommand?: string;
  /** Wie lange auf das saubere Ende gewartet wird. Standard 30 Sekunden. */
  stopTimeoutSeconds?: number;
  /** Stand der Installation - fehlt bei Instanzen, die der Core nicht selbst installiert hat. */
  install?: ServerInstallInfo;
}

export interface ServerInstallInfo {
  state: 'installing' | 'done' | 'failed';
  kind: 'minecraft-paper';
  version?: string;
  build?: number;
  java?: string;
  error?: string;
  /** Variablen und Vorlage der Installation - fuer Neuinstallation und das Schreiben der Konfiguration vor dem Start. */
  variables?: Record<string, string>;
  propertiesTemplate?: Record<string, string>;
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
