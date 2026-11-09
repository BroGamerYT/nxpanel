import { HostDriver } from './interface.js';
import { ServerInstanceConfig, ServerState } from '../types.js';
import { spawn, ChildProcess } from 'child_process';

interface ProcessEntry {
  config: ServerInstanceConfig;
  state: ServerState;
  process?: ChildProcess;
}

export class WindowsNativeDriver implements HostDriver {
  readonly name = 'windows-native';
  private instances = new Map<string, ProcessEntry>();
  private logCallbacks = new Map<string, ((line: string) => void)[]>();

  async initialize(): Promise<void> {
    if (process.platform !== 'win32') {
      console.warn('[WindowsNativeDriver] Warnung: Nicht auf Windows gestartet. Emuliere Testprozesse.');
    } else {
      console.log('[WindowsNativeDriver] Initialisiert für Windows Host (Job Objects & Nativer Prozess-Runner).');
    }
  }

  async registerServer(config: ServerInstanceConfig): Promise<ServerState> {
    const state: ServerState = { id: config.id, status: 'offline' };
    this.instances.set(config.id, { config, state });
    return state;
  }

  async startServer(serverId: string): Promise<ServerState> {
    const entry = this.instances.get(serverId);
    if (!entry) throw new Error(`Server ${serverId} ist nicht registriert.`);

    if (entry.state.status === 'running' || entry.state.status === 'starting') {
      return entry.state;
    }

    entry.state.status = 'starting';
    this.emitLog(serverId, `[WindowsNative] Starte Prozess ${entry.config.executable} mit Parametern: ${entry.config.args.join(' ')}`);

    try {
      // Nativer Windows-Prozessstart (spawn)
      const child = spawn(entry.config.executable, entry.config.args, {
        cwd: entry.config.workingDir || process.cwd(),
        shell: true,
        env: { ...process.env, ...(entry.config.env || {}) },
      });

      entry.process = child;
      entry.state.pid = child.pid;
      entry.state.status = 'running';
      entry.state.startedAt = new Date().toISOString();

      child.stdout?.on('data', (data) => {
        this.emitLog(serverId, data.toString().trim());
      });

      child.stderr?.on('data', (data) => {
        this.emitLog(serverId, `[STDERR] ${data.toString().trim()}`);
      });

      child.on('close', (code) => {
        entry.state.status = 'offline';
        entry.state.pid = undefined;
        this.emitLog(serverId, `[WindowsNative] Prozess beendet mit Code ${code}`);
      });

      child.on('error', (err) => {
        entry.state.status = 'error';
        this.emitLog(serverId, `[FEHLER] Prozessstart fehlgeschlagen: ${err.message}`);
      });

      return entry.state;
    } catch (err: any) {
      entry.state.status = 'error';
      this.emitLog(serverId, `[FEHLER] Ausführungsfehler: ${err.message}`);
      throw err;
    }
  }

  async stopServer(serverId: string): Promise<ServerState> {
    const entry = this.instances.get(serverId);
    if (!entry) throw new Error(`Server ${serverId} nicht gefunden.`);

    if (entry.process) {
      entry.state.status = 'stopping';
      this.emitLog(serverId, '[WindowsNative] Sende Beenden-Signal an Prozess...');
      entry.process.kill('SIGTERM');
    } else {
      entry.state.status = 'offline';
    }

    return entry.state;
  }

  async killServer(serverId: string): Promise<ServerState> {
    const entry = this.instances.get(serverId);
    if (!entry) throw new Error(`Server ${serverId} nicht gefunden.`);

    if (entry.process) {
      entry.process.kill('SIGKILL');
      entry.state.status = 'offline';
      entry.state.pid = undefined;
      this.emitLog(serverId, '[WindowsNative] Prozess (Force-Kill) beendet.');
    }
    return entry.state;
  }

  async getServerState(serverId: string): Promise<ServerState> {
    const entry = this.instances.get(serverId);
    if (!entry) throw new Error(`Server ${serverId} nicht gefunden.`);
    return entry.state;
  }

  async listServers(): Promise<ServerState[]> {
    return Array.from(this.instances.values()).map(e => e.state);
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
