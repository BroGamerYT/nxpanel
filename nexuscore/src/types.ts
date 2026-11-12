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

/** Wie ein Spiel im Docker-Treiber laeuft (aus dem Egg). Ohne diese Angabe gilt `executable` als Image-Name. */
export interface ContainerSpec {
  image: string;
  /** Pfad im Container, an dem der Server-Ordner eingehaengt wird (Egg: data_dir). */
  dataDir: string;
  /** Zusaetzliche Linux-Rechte (nur Erlaubnisliste, siehe eggs/capabilities.ts). */
  capAdd?: string[];
  /** Benutzer im Container, z. B. "1000:1000". */
  user?: string;
  entrypoint?: string[];
  /** /tmp als Arbeitsspeicher-Laufwerk, Groesse in MB (Egg: tmp). */
  tmpfsMb?: number;
  /** Signal statt Konsolenbefehl zum Beenden (Egg: stop.method, z. B. SIGTERM). */
  stopSignal?: string;
  /** Konfigurationsdateien des Eggs (config_files): werden vor jedem Start mit den aktuellen Werten gepatcht. */
  configFiles?: Record<string, { parser: string; find?: Record<string, unknown>; set?: Record<string, unknown> }>;
  /** Alle Ports des Eggs nach Namen (auch interne wie RCON) - fuer Platzhalter wie {{RCON_PORT}}. */
  refPorts?: Record<string, number>;
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
  /** Nur Docker-Treiber: Image, Datenpfad, Rechte. */
  container?: ContainerSpec;
  /** Stand der Installation - fehlt bei Instanzen, die der Core nicht selbst installiert hat. */
  install?: ServerInstallInfo;
}

/** Eine Konfigurationsdatei, die der Core vor jedem Start aus den Variablen schreibt (Egg: windows.files). */
export interface SteamFile {
  /** Relativ zum Server-Ordner. */
  path: string;
  format: 'json' | 'unreal-options' | 'ini' | 'xml' | 'yaml' | 'text';
  /** "VARIABLE=Wert": hat die Variable diesen Wert, wird die Datei nicht angefasst (z. B. eigene Konfiguration). */
  unless?: string;
  /** "unreal-options" und "ini": [Abschnitt]; bei "unreal-options" auch der Schluessel (z. B. OptionSettings). */
  section?: string;
  key?: string;
  /** Nur "xml": Name des Wurzelelements (auch fuer eine neu angelegte Datei). */
  root?: string;
  /** Nur "text": der ganze Inhalt der Datei als Vorlage (Zeilen mit Platzhaltern). Wird bei jedem Start neu geschrieben. */
  content?: string;
  /** Schluessel (bei json auch "a.b.c") -> Vorlage. Zahlen und Wahrheitswerte ueber $number / $boolean. */
  set: Record<string, string | { $number?: string; $boolean?: string }>;
}

/**
 * Ein Startargument: Text mit Platzhaltern, oder eine Gruppe, die nur gilt, wenn eine Bedingung stimmt
 * (`VAR` = gesetzt, `VAR=wert`, `VAR!=wert`) - fuer Paare wie `+sv_password <Wert>`, die ohne Wert wegfallen sollen.
 */
export type SteamArg = string | { when: string; args: string[] };

/** Ein Spiel, das aus einem Archiv des Herstellers kommt statt aus Steam (siehe install/sources.ts). */
export interface DownloadSpec {
  source: 'teamspeak3' | 'terraria' | 'bedrock';
  /** Liegt alles in genau einem Ordner im Archiv (z. B. "1458/"), wird dieser Ordner weggelassen. */
  stripTop?: boolean | undefined;
  /** Dateien, die bei einer Neuinstallation nicht ueberschrieben werden (relativ, mit /). */
  keep?: string[] | undefined;
  /** Ordner, die das Spiel erwartet (relativ zum Server-Ordner), z. B. "worlds". */
  mkdirs?: string[] | undefined;
}

/** Wie ein Steam-Spiel installiert und gestartet wird (Egg: windows). */
export interface SteamLaunch {
  /** Steam-App-ID - oder `download` fuer Spiele ausserhalb von Steam. */
  appId?: number | undefined;
  download?: DownloadSpec | undefined;
  branch?: string | undefined;
  /** Relativ zum Server-Ordner. */
  executable: string;
  /** Vorlagen mit Platzhaltern wie {{PORT_GAME}} und {{SERVER_NAME}}. */
  args: SteamArg[];
  stopTimeoutSeconds?: number | undefined;
  files?: SteamFile[] | undefined;
}

export interface ServerInstallInfo {
  state: 'installing' | 'done' | 'failed';
  kind: 'minecraft-paper' | 'minecraft-vanilla' | 'steamcmd' | 'download' | 'container';
  /** Nur bei kind = steamcmd. */
  steam?: SteamLaunch;
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
