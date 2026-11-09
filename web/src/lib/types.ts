export type ServerStatus = 'installing' | 'install_failed' | 'offline' | 'starting' | 'running' | 'stopping' | 'crashed' | 'suspended';

export interface User {
  id: string; email: string; username: string; role: 'admin' | 'moderator' | 'user'; locale?: string | null;
  canCreateServers: boolean; totpEnabled: boolean; allowedEggs?: string[] | null;
  avatar?: string | null; steamId?: string | null; steamName?: string | null;
}

export interface SteamAccount {
  id: string;
  ownerId: string | null;
  ownerName: string | null;
  isOwner: boolean;
  isShared: boolean;
  label: string;
  accountName: string;
  steamId: string | null;
  hasPassword: boolean;
  guardStatus: 'none' | 'needed' | 'ok' | 'failed';
  guardType: 'none' | 'email' | 'app';
  guardPrompt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface UserSession {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string | null;
  current?: boolean;
}

export interface Me { user: User; permissions: Record<string, boolean> }

export interface ServerListItem {
  id: string; shortId: string; name: string; status: ServerStatus; ownerName: string; eggName: string; eggId?: string; cover?: CoverInfo;
  ramMb: number; cpuPercent: number; diskMb: number; autoRestart?: boolean; crashCount?: number; unstartable?: boolean;
  suspended: boolean; primaryPort: number | null; publicHost: string | null;
  isOwner: boolean; permissions: string[];
  startedAt?: string | null;
  gameVersion?: string | null;
  serverType?: string | null;
  modpackName?: string | null;
  modpackVersion?: string | null;
  tags?: string[];
  isFavorite?: boolean;
}

export interface ServerDetail {
  server: {
    id: string; shortId: string; name: string; status: ServerStatus; ownerId: string;
    startedAt?: string | null;
    egg: { id: string; name: string; consoleMode: 'full' | 'readonly' | 'none'; webInterface: unknown; hints?: ConsoleHint[]; gameKind?: string | null } | null;
    limits: { ramMb: number; swapMb: number; cpuPercent: number; diskMb: number };
    diskUsedMb?: number | null;
    containerLayerMb?: number | null;
    autoRestart: boolean; crashCount?: number; unstartable?: boolean; autoSleepMinutes?: number; suspended: boolean; publicHost: string | null;
    ports?: Array<{ port: number; protocol: string; ref: string | null; is_primary: boolean }>;
    image?: string; startup?: string;
    rcon?: { port: number; password?: string | null } | null;
    gameVersion?: string | null;
    serverType?: string | null;
    modpackName?: string | null;
    modpackVersion?: string | null;
    tags?: string[];
    isFavorite?: boolean;
    variables?: Record<string, string>;
  };
  permissions: string[];
}

export interface TimelineEvent {
  id: number; ts: string; kind: string; severity: 'info' | 'warn' | 'error'; summary: string; actor?: string | null; payload?: unknown;
}

export interface ServerActivityItem {
  id: number; ts: string; action: string; actor?: string | null; metadata?: Record<string, unknown> | null; ip?: string | null;
}

export interface Stats { cpuPercent: number; memMb: number; memLimitMb: number; netRxBytes: number; netTxBytes: number }

export interface CoverInfo { src: string; fit: 'banner' | 'icon'; source: 'steam' | 'custom' | 'branding' }

export interface EggSummary {
  id: string; name: string; category: string; author: string | null;
  cover?: CoverInfo; coverChoice?: string; hasSteamCover?: boolean;
  images: Array<{ key: string; label: string; image: string; default: boolean }>;
  consoleMode: string; resources: { base_ram_mb?: number; ram_per_player_mb?: number; min_cpu_percent?: number } | null;
}

export interface EggVariable {
  env: string; label: string; description: string | null; default: string | null; secret: boolean; editable: boolean;
  labelLocales?: Record<string, string>; descriptionLocales?: Record<string, string>;
  requires: string | null; widget: 'text' | 'number' | 'slider' | 'toggle' | 'select' | 'password' | 'textarea';
  required: boolean; type: string; options?: string[]; min?: number; max?: number; pattern?: string;
}

export interface EggDetail extends EggSummary { variables: EggVariable[]; ports: unknown }

export interface SteamAccount {
  id: string;
  accountName: string;
  steamId: string | null;
  hasPassword: boolean;
  guardStatus: 'none' | 'needed' | 'ok' | 'failed';
  guardType: 'none' | 'email' | 'app';
  guardPrompt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  is_symlink: boolean;
  size: number;
  modified_at: string;
  mode: string;
  /** Lesbarer Name, z. B. Servername fuer einen Volume-Ordner (Admin-Dateimanager) */
  label?: string;
  /** Ordner ohne zugehoerigen Server (Rest eines geloeschten Servers) */
  orphan?: boolean;
}

export interface DirectoryListing {
  current: string;
  entries: FileEntry[];
}

export interface BackupVerificationDetails {
  status: 'valid' | 'corrupted';
  sha256Match: boolean;
  archiveIntact: boolean;
  filesCount: number;
  criticalFilesFound: string[];
  missingCriticalFiles?: string[];
  error?: string;
  verifiedAt: string;
}

export interface BackupItem {
  id: string;
  server_id: string;
  name: string;
  filename: string;
  bytes: number;
  checksum: string | null;
  locked: boolean;
  status: 'running' | 'completed' | 'failed' | 'restoring';
  error: string | null;
  ignored_files: string[] | null;
  verification_status?: 'unverified' | 'valid' | 'corrupted';
  verified_at?: string | null;
  verification_details?: BackupVerificationDetails | null;
  nas_stored?: boolean;
  created_at: string;
  completed_at: string | null;
}

export interface BackupSchedule {
  enabled: boolean;
  intervalHours: number;
  retention: number;
  verify: boolean;
  lastAutoBackupAt: string | null;
}



export interface NodeInfo {
  id: string; name: string; fqdn: string; ramTotalMb: number; diskTotalMb: number; ramAssignedMb: number; servers: number;
  publicHost: string | null; portFrom: number | null; portTo: number | null;
}

export interface AllocationRow {
  port: number; protocol: 'tcp' | 'udp' | 'both'; ref: string | null; primary: boolean;
  server: { id: string; shortId: string; name: string; status: ServerStatus; owner: string } | null;
  cooldownUntil: string | null; node: string; inRange: boolean;
}

export interface ServerLive { cpuPercent: number; memMb: number; rxRate: number; txRate: number }
export interface DashboardData {
  totals: { servers: number; running: number; ramAssignedMb: number; cpuAssignedPercent: number; diskAssignedMb: number;
    ramUsedMb: number; cpuPercent: number; rxRate: number; txRate: number; diskUsedMb: number };
  perServer: Record<string, ServerLive>;
  diskUsed: Record<string, number>;
  host: null | {
    hostname: string; cpuModel: string; cpuCores: number; cpuPercent: number | null; load: [number, number, number];
    ramTotalMb: number; ramUsedMb: number; diskTotalMb: number; diskUsedMb: number; uptimeS: number;
    assigned: { ramMb: number; cpuPercent: number; diskMb: number; servers: number };
    storage: { gameDataMb: number; measuredAt: number | null; docker: null | { imagesMb: number; containersMb: number; volumesMb: number; buildCacheMb: number } };
  };
}

/** Hinweis aus dem Egg: passt eine Konsolenzeile, steht die Erklaerung in der Fehlerliste. */
export interface ConsoleHint { match: string; flags: string; level: 'ok' | 'warn' | 'error' | 'ignore'; text: string; text_locales?: Record<string, string> }

export interface SubuserItem {
  userId: string;
  username: string;
  email: string;
  permissions: string[];
  since: string;
}

export interface PermissionsCatalog {
  flags: string[];
  labels: Record<string, string>;
  presets: Record<string, { label: string; flags: string[] }>;
}

export interface AdminUserItem {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'moderator' | 'user';
  canCreateServers: boolean;
  suspended: boolean;
  totpEnabled: boolean;
  serverLimit: number;
  ramLimitMb: number;
  diskLimitMb: number;
  allowedEggs: string[] | null;
  createdAt: string;
  lastLoginAt: string | null;
  servers: number;
  ramUsedMb: number;
}

export interface AdminUserServerItem {
  id: string;
  shortId: string;
  name: string;
  status: ServerStatus;
  eggName: string;
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
  isSubuser: boolean;
  permissions: string[];
}

export interface AuditEntry {
  id: number;
  created_at: string;
  action: string;
  actor_name: string | null;
  user_id: string | null;
  server_id: string | null;
  server_name: string | null;
  metadata: unknown;
  ip: string | null;
}

export interface ActiveTask {
  id: string;
  type: 'backup' | 'game_update' | 'modpack_update' | 'install' | 'starting' | 'stopping';
  serverId: string;
  serverName: string;
  shortId: string;
  title: string;
  subtitle?: string;
  progressPercent?: number;
  bytesWritten?: number;
  totalBytes?: number;
  step?: string;
  startedAt: string;
}

export interface GameTestItem {
  eggId: string;
  eggName: string;
  status: 'SUCCESS' | 'INSTALL_FAILED' | 'START_CRASHED' | 'TIMEOUT';
  installDurationSec: number;
  runtimeDurationSec: number;
  errorSummary: string | null;
  logExcerpt: string;
  testedAt: string;
}

export interface GameTestReportData {
  isRunning: boolean;
  startedAt?: string | null;
  currentEgg?: string | null;
  currentEggIndex?: number;
  totalEggs?: number;
  status?: string;
  mode?: string;
  cpuPercent?: number | null;
  ramMb?: number | null;
  jsonReport?: {
    updated: string;
    total: number;
    success: number;
    failed: number;
    results: GameTestItem[];
  } | null;
  markdownReport?: string | null;
  logTail?: string | null;
}
