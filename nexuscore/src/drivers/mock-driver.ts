import { HostDriver } from './interface.js';
import { ServerInstanceConfig, ServerState } from '../types.js';

export class MockDriver implements HostDriver {
  readonly name = 'mock';
  private servers = new Map<string, { config: ServerInstanceConfig; state: ServerState }>();
  private logCallbacks = new Map<string, ((line: string) => void)[]>();

  async initialize(): Promise<void> {
    console.log('[NexusCore MockDriver] Initialisiert.');
  }

  async registerServer(config: ServerInstanceConfig): Promise<ServerState> {
    const state: ServerState = { id: config.id, status: 'offline' };
    this.servers.set(config.id, { config, state });
    return state;
  }

  async startServer(serverId: string): Promise<ServerState> {
    const item = this.servers.get(serverId);
    if (!item) throw new Error(`Server ${serverId} nicht gefunden.`);

    item.state.status = 'starting';
    this.emitLog(serverId, `[Mock] Starte Server ${item.config.name} (${item.config.executable})...`);

    setTimeout(() => {
      item.state.status = 'running';
      item.state.pid = Math.floor(Math.random() * 10000) + 1000;
      item.state.startedAt = new Date().toISOString();
      item.state.cpuPercent = 5;
      item.state.memoryMb = 512;
      this.emitLog(serverId, `[Mock] Server ${item.config.name} erfolgreich gestartet (PID ${item.state.pid}).`);
    }, 1000);

    return item.state;
  }

  async stopServer(serverId: string): Promise<ServerState> {
    const item = this.servers.get(serverId);
    if (!item) throw new Error(`Server ${serverId} nicht gefunden.`);

    item.state.status = 'stopping';
    this.emitLog(serverId, `[Mock] Stoppe Server ${item.config.name}...`);

    setTimeout(() => {
      item.state.status = 'offline';
      item.state.pid = undefined;
      item.state.startedAt = undefined;
      item.state.cpuPercent = 0;
      item.state.memoryMb = 0;
      this.emitLog(serverId, `[Mock] Server ${item.config.name} heruntergefahren.`);
    }, 1000);

    return item.state;
  }

  async killServer(serverId: string): Promise<ServerState> {
    const item = this.servers.get(serverId);
    if (!item) throw new Error(`Server ${serverId} nicht gefunden.`);

    item.state.status = 'offline';
    item.state.pid = undefined;
    item.state.cpuPercent = 0;
    item.state.memoryMb = 0;
    this.emitLog(serverId, `[Mock] Server ${item.config.name} (Force-Kill).`);
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

  onLog(serverId: string, callback: (logLine: string) => void): void {
    const list = this.logCallbacks.get(serverId) || [];
    list.push(callback);
    this.logCallbacks.set(serverId, list);
  }

  private emitLog(serverId: string, line: string): void {
    const list = this.logCallbacks.get(serverId) || [];
    for (const cb of list) {
      cb(line);
    }
  }
}
