import { HostDriver } from './interface.js';
import { ServerInstanceConfig, ServerState } from '../types.js';

export class DockerDriver implements HostDriver {
  readonly name = 'docker';
  private servers = new Map<string, { config: ServerInstanceConfig; state: ServerState }>();

  async initialize(): Promise<void> {
    console.log('[DockerDriver] Initialisiert für Containerized Engine (Linux / Proxmox / NexusPanel OS).');
  }

  async registerServer(config: ServerInstanceConfig): Promise<ServerState> {
    const state: ServerState = { id: config.id, status: 'offline' };
    this.servers.set(config.id, { config, state });
    return state;
  }

  async startServer(serverId: string): Promise<ServerState> {
    const item = this.servers.get(serverId);
    if (!item) throw new Error(`Server ${serverId} nicht gefunden.`);
    item.state.status = 'running';
    item.state.startedAt = new Date().toISOString();
    return item.state;
  }

  async stopServer(serverId: string): Promise<ServerState> {
    const item = this.servers.get(serverId);
    if (!item) throw new Error(`Server ${serverId} nicht gefunden.`);
    item.state.status = 'offline';
    return item.state;
  }

  async killServer(serverId: string): Promise<ServerState> {
    const item = this.servers.get(serverId);
    if (!item) throw new Error(`Server ${serverId} nicht gefunden.`);
    item.state.status = 'offline';
    return item.state;
  }

  async getServerState(serverId: string): Promise<ServerState> {
    const item = this.servers.get(serverId);
    if (!item) throw new Error(`Server ${serverId} nicht gefunden.`);
    return item.state;
  }

  async listServers(): Promise<ServerState[]> {
    return Array.from(this.servers.values()).map(s => s.state);
  }

  onLog(_serverId: string, _callback: (logLine: string) => void): void {
    // Docker Log Handler Stub
  }
}
