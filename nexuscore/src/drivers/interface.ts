import type { LogLine, ServerInstanceConfig, ServerState, ServerStats } from '../types.js';

/** Der Treiber meldet hier seine Konsolenzeilen - der HTTP-Layer verteilt sie. */
export type LogSink = (line: LogLine) => void;

/**
 * Gemeinsame Schnittstelle aller Treiber.
 *
 * Der Core kennt nur diese Schnittstelle: Windows nativ, Docker oder Mock sind
 * austauschbar, ohne dass HTTP-Schicht oder Event-Bus etwas davon wissen.
 */
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
  setLogSink(sink: LogSink): void;
  shutdown(): Promise<void>;
}
