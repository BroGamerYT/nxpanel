export type ServerStatus =
  | 'installing'
  | 'install_failed'
  | 'offline'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'suspended';

export type ConsoleMode = 'full' | 'readonly' | 'none';

export interface ServerRecord {
  id: string;
  short_id: string;
  owner_id: string;
  node_id: string;
  egg_id: string;
  name: string;
  docker_image: string;
  startup: string;
  container_id: string | null;
  status: ServerStatus;
  ram_mb: number;
  swap_mb: number;
  cpu_percent: number;
  disk_mb: number;
  io_weight: number;
  variables: Record<string, string>;
  auto_restart: boolean;
  auto_sleep_minutes: number;
  crash_count: number;
  suspended: boolean;
  tags?: string[];
  is_favorite?: boolean;
  started_at?: Date | null;
}

export interface PortBinding {
  containerPort: number;
  hostPort: number;
  protocol: 'tcp' | 'udp';
}
