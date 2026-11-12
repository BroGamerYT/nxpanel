import type { LogLine, ServerInstanceConfig, ServerState, ServerStats } from '../types.js';

/** Der Treiber meldet hier seine Konsolenzeilen - der HTTP-Layer verteilt sie. */
export type LogSink = (line: LogLine) => void;

/**
 * Gemeinsame Schnittstelle aller Treiber.
 *
 * Der Core kennt nur diese Schnittstelle: Windows nativ, Docker oder Mock sind
 * austauschbar, ohne dass HTTP-Schicht oder Event-Bus etwas davon wissen.
 */
/** Installationsskript in einem Wegwerf-Container (nur Docker-Treiber). */
export interface InstallerSpec {
  serverId: string;
  image: string;
  shell: 'bash' | 'ash' | 'sh';
  script: string;
  env: Record<string, string>;
  /** Server-Ordner auf dem Host; im Container unter /mnt/server. */
  hostDir: string;
}

export interface HostDriver {
  readonly name: string;
  initialize(): Promise<void>;
  registerServer(config: ServerInstanceConfig): Promise<ServerState>;
  /** Ersetzt die Konfiguration einer angemeldeten, nicht laufenden Instanz (z. B. nach einer Neuinstallation). */
  updateServer?(config: ServerInstanceConfig): Promise<ServerState>;
  /** Meldet eine nicht laufende Instanz ab (nach dem Loeschen eines Servers). */
  unregisterServer?(serverId: string): Promise<void>;
  startServer(serverId: string): Promise<ServerState>;
  stopServer(serverId: string): Promise<ServerState>;
  killServer(serverId: string): Promise<ServerState>;
  getServerState(serverId: string): Promise<ServerState>;
  getServerStats(serverId: string): Promise<ServerStats>;
  listServers(): Promise<ServerState[]>;
  sendCommand?(serverId: string, command: string): Promise<void>;
  /** Laeuft die Instanz mit niedriger oder normaler Prioritaet (Gaming-Modus)? Ganzer Prozessbaum. */
  setPriority?(serverId: string, level: 'normal' | 'low'): Promise<number>;
  /** Das neueste Image holen, auch wenn es schon da ist (Update). */
  pullImage?(image: string, onLog?: (line: string) => void): Promise<void>;
  /** Antwortet der Treiber (Docker-Daemon erreichbar)? Fuer /readyz. */
  healthy?(): Promise<boolean>;
  /** Nicht mehr benutzte Images aufraeumen - nur die uebergebenen (die des Cores), nie fremde. */
  prune?(ownedImages: readonly string[]): Promise<{ imagesDeleted: number; reclaimedMb: number }>;
  /** Installationsskript des Eggs in einem Container ausfuehren; Rueckgabe: Beendigungscode. */
  runInstaller?(spec: InstallerSpec, onLog: (line: string) => void): Promise<number>;
  setLogSink(sink: LogSink): void;
  shutdown(): Promise<void>;
}
