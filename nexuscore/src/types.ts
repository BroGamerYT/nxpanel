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

export interface ServerInstanceConfig {
  id: string;
  name: string;
  game: string;
  executable: string;
  args: string[];
  workingDir: string;
  maxMemoryMb?: number;
  maxCpuPercent?: number;
  ports: { name: string; hostPort: number; containerPort?: number; protocol: 'tcp' | 'udp' }[];
  env?: Record<string, string>;
}

export type ServerStatus = 'offline' | 'starting' | 'running' | 'stopping' | 'error';

export interface ServerState {
  id: string;
  status: ServerStatus;
  pid?: number;
  startedAt?: string;
  memoryMb?: number;
  cpuPercent?: number;
}
