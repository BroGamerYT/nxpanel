import type { HostDriver, LogSink } from './interface.js';
import type { ServerInstanceConfig, ServerState, ServerStats } from '../types.js';

interface MockEntry {
  config: ServerInstanceConfig;
  state: ServerState;
  timers: NodeJS.Timeout[];
}

/**
 * Treiber fuer risikofreies Testen auf Entwickler-Rechnern.
 *
 * Der Mock simuliert Prozessverhalten inklusive Zustandswechsel und
 * Logausgabe, startet aber nichts auf dem Rechner.
 */
export class MockDriver implements HostDriver {
  readonly name = 'mock';
  private readonly instances = new Map<string, MockEntry>();
  private logSink: LogSink = () => {};

  async initialize(): Promise<void> {
    console.log('[MockDriver] Initialisiert - simulierte Instanzen, keine Systemaenderungen.');
  }

  setLogSink(sink: LogSink): void {
    this.logSink = sink;
  }

  async registerServer(config: ServerInstanceConfig): Promise<ServerState> {
    if (this.instances.has(config.id)) {
      throw new Error(`Server "${config.id}" existiert bereits.`);
    }
    const state: ServerState = { id: config.id, status: 'offline' };
    this.instances.set(config.id, { config, state, timers: [] });
    return state;
  }

  async startServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    if (entry.state.status === 'running' || entry.state.status === 'starting') {
      return entry.state;
    }

    entry.state.status = 'starting';
    this.emit(entry.config.id, `[Mock] Starte Server ${entry.config.name} (${entry.config.executable})...`);

    const timer = setTimeout(() => {
      entry.state.status = 'running';
      entry.state.pid = 1000 + Math.floor(Math.random() * 9000);
      entry.state.startedAt = new Date().toISOString();
      entry.state.cpuPercent = 5;
      entry.state.memoryMb = 512;
      this.emit(
        entry.config.id,
        `[Mock] Server ${entry.config.name} erfolgreich gestartet (PID ${entry.state.pid}).`,
      );
    }, 1000);
    timer.unref();
    entry.timers.push(timer);

    return entry.state;
  }

  async stopServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    entry.state.status = 'stopping';
    this.emit(entry.config.id, `[Mock] Stoppe Server ${entry.config.name}...`);

    const timer = setTimeout(() => {
      entry.state.status = 'offline';
      delete entry.state.pid;
      delete entry.state.startedAt;
      entry.state.cpuPercent = 0;
      entry.state.memoryMb = 0;
      this.emit(entry.config.id, `[Mock] Server ${entry.config.name} heruntergefahren.`);
    }, 1000);
    timer.unref();
    entry.timers.push(timer);

    return entry.state;
  }

  async killServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    entry.state.status = 'offline';
    delete entry.state.pid;
    delete entry.state.startedAt;
    entry.state.cpuPercent = 0;
    entry.state.memoryMb = 0;
    this.emit(entry.config.id, `[Mock] Server ${entry.config.name} (Force-Kill).`);
    return entry.state;
  }

  async getServerState(serverId: string): Promise<ServerState> {
    return this.require(serverId).state;
  }

  async getServerStats(serverId: string): Promise<ServerStats> {
    const entry = this.require(serverId);
    const running = entry.state.status === 'running';
    const startedAt = entry.state.startedAt ? Date.parse(entry.state.startedAt) : undefined;
    return {
      serverId,
      status: entry.state.status,
      ...(entry.state.pid !== undefined ? { pid: entry.state.pid } : {}),
      cpuPercent: running ? (entry.state.cpuPercent ?? 5) : 0,
      memoryMb: running ? (entry.state.memoryMb ?? 512) : 0,
      uptimeSeconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
      ...(entry.state.startedAt ? { startedAt: entry.state.startedAt } : {}),
    };
  }

  async listServers(): Promise<ServerState[]> {
    return Array.from(this.instances.values()).map((e) => e.state);
  }

  async sendCommand(serverId: string, command: string): Promise<void> {
    const entry = this.require(serverId);
    if (entry.state.status !== 'running') {
      throw new Error(`Server "${serverId}" laeuft nicht.`);
    }
    this.emit(serverId, `> ${command}`);
  }

  async shutdown(): Promise<void> {
    for (const entry of this.instances.values()) {
      for (const timer of entry.timers) clearTimeout(timer);
      entry.timers = [];
    }
  }

  private require(serverId: string): MockEntry {
    const entry = this.instances.get(serverId);
    if (!entry) throw new Error(`Server "${serverId}" ist nicht registriert.`);
    return entry;
  }

  private emit(serverId: string, line: string): void {
    this.logSink({ serverId, line, stream: 'stdout', ts: new Date().toISOString() });
  }
}
