import { ServerInstanceConfig, ServerState } from '../types.js';

export interface HostDriver {
  readonly name: string;
  initialize(): Promise<void>;
  registerServer(config: ServerInstanceConfig): Promise<ServerState>;
  startServer(serverId: string): Promise<ServerState>;
  stopServer(serverId: string): Promise<ServerState>;
  killServer(serverId: string): Promise<ServerState>;
  getServerState(serverId: string): Promise<ServerState>;
  listServers(): Promise<ServerState[]>;
  onLog(serverId: string, callback: (logLine: string) => void): void;
}
