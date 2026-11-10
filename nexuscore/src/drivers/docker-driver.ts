import Docker from 'dockerode';
import { StringDecoder } from 'node:string_decoder';
import type { HostDriver, LogSink } from './interface.js';
import type { ServerInstanceConfig, ServerState, ServerStats } from '../types.js';

interface ContainerEntry {
  config: ServerInstanceConfig;
  state: ServerState;
  containerId?: string;
}

/**
 * Baut die Argumente fuer `docker run` aus einer Server-Konfiguration.
 *
 * Exportiert, damit die Zuordnung ohne laufenden Docker-Daemon testbar ist.
 */
export function buildCreateOptions(config: ServerInstanceConfig): string[] {
  const args: string[] = ['run', '-d', '--name', config.id, '--restart', 'unless-stopped'];

  for (const port of config.ports) {
    const containerPort = port.containerPort ?? port.hostPort;
    args.push('-p', `${port.hostPort}:${containerPort}/${port.protocol}`);
  }

  for (const [key, value] of Object.entries(config.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }

  args.push('-w', config.workingDir || '/');
  args.push(config.executable, ...config.args);
  return args;
}

/**
 * Container-Treiber fuer Linux, Proxmox, Docker Desktop und NexusPanel OS.
 *
 * Der Treiber spricht direkt mit dem lokalen Docker-Daemon ueber den
 * Docker-Socket - es werden keine Zugangsdaten und keine Cloud-APIs benutzt.
 * Ist kein Daemon erreichbar, startet der Core trotzdem; die Instanzen
 * laufen dann eben nicht.
 */
export class DockerDriver implements HostDriver {
  readonly name = 'docker';
  private readonly instances = new Map<string, ContainerEntry>();
  private readonly docker = new Docker();
  private logSink: LogSink = () => {};
  private dockerAvailable = false;

  async initialize(): Promise<void> {
    try {
      await this.docker.ping();
      this.dockerAvailable = true;
      console.log('[DockerDriver] Docker-Daemon erreichbar.');
    } catch (err) {
      this.dockerAvailable = false;
      console.warn(
        `[DockerDriver] Kein Docker-Daemon erreichbar (${(err as Error).message}). Instanzen koennen nicht gestartet werden.`,
      );
    }
  }

  setLogSink(sink: LogSink): void {
    this.logSink = sink;
  }

  async registerServer(config: ServerInstanceConfig): Promise<ServerState> {
    const state: ServerState = { id: config.id, status: 'offline' };
    this.instances.set(config.id, { config, state });
    return state;
  }

  async startServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    if (!this.dockerAvailable) {
      throw new Error('Kein Docker-Daemon erreichbar - der Container kann nicht gestartet werden.');
    }
    if (entry.state.status === 'running' || entry.state.status === 'starting') {
      return entry.state;
    }

    entry.state.status = 'starting';
    this.emit(serverId, `[Docker] Starte Container ${entry.config.id}...`);

    try {
      const container = await this.docker.createContainer({
        name: entry.config.id,
        Image: entry.config.executable,
        Cmd: entry.config.args,
        WorkingDir: entry.config.workingDir || undefined,
        Env: Object.entries(entry.config.env ?? {}).map(([k, v]) => `${k}=${v}`),
        HostConfig: {
          PortBindings: Object.fromEntries(
            entry.config.ports.map((port) => {
              const containerPort = `${port.containerPort ?? port.hostPort}/${port.protocol}`;
              return [
                containerPort,
                [{ HostPort: String(port.hostPort) }],
              ];
            }),
          ),
          RestartPolicy: { Name: 'unless-stopped' },
        },
      });

      entry.containerId = container.id;
      await container.start();
      entry.state.status = 'running';
      entry.state.startedAt = new Date().toISOString();

      this.streamLogs(entry);
    } catch (err) {
      entry.state.status = 'error';
      this.emit(serverId, `[FEHLER] Containerstart fehlgeschlagen: ${(err as Error).message}`);
      throw err;
    }

    return entry.state;
  }

  async stopServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    if (!entry.containerId) {
      entry.state.status = 'offline';
      return entry.state;
    }
    entry.state.status = 'stopping';
    this.emit(serverId, '[Docker] Stoppe Container...');
    try {
      const container = this.docker.getContainer(entry.containerId);
      await container.stop({ t: 10 });
    } catch (err) {
      this.emit(serverId, `[FEHLER] Stoppen fehlgeschlagen: ${(err as Error).message}`);
    }
    entry.state.status = 'offline';
    delete entry.state.pid;
    delete entry.containerId;
    return entry.state;
  }

  async killServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    if (!entry.containerId) {
      entry.state.status = 'offline';
      return entry.state;
    }
    this.emit(serverId, '[Docker] Breche Container ab...');
    try {
      const container = this.docker.getContainer(entry.containerId);
      await container.kill();
    } catch (err) {
      this.emit(serverId, `[FEHLER] Abbruch fehlgeschlagen: ${(err as Error).message}`);
    }
    entry.state.status = 'offline';
    delete entry.state.pid;
    delete entry.containerId;
    return entry.state;
  }

  async getServerState(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    if (!entry.containerId) return entry.state;

    try {
      const info = await this.docker.getContainer(entry.containerId).inspect();
      entry.state.status = info.State.Running ? 'running' : 'offline';
      if (info.State.Running) {
        entry.state.pid = info.State.Pid;
      } else {
        delete entry.state.pid;
      }
    } catch {
      // Container existiert nicht mehr (z. B. entfernt).
      entry.state.status = 'offline';
      delete entry.state.pid;
    }
    return entry.state;
  }

  async getServerStats(serverId: string): Promise<ServerStats> {
    const entry = this.require(serverId);
    const state = await this.getServerState(serverId);
    const startedAt = entry.state.startedAt;

    if (!entry.containerId || state.status !== 'running') {
      return {
        serverId,
        status: state.status,
        cpuPercent: 0,
        memoryMb: 0,
        uptimeSeconds: 0,
      };
    }

    try {
      const stats = await this.docker.getContainer(entry.containerId).stats({ stream: false });
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta =
        stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const cores = stats.cpu_stats.online_cpus ?? 1;
      const cpuPercent =
        systemDelta > 0 && cpuDelta > 0
          ? Math.round(((cpuDelta / systemDelta) * cores * 100) * 10) / 10
          : 0;

      return {
        serverId,
        status: state.status,
        ...(state.pid !== undefined ? { pid: state.pid } : {}),
        cpuPercent,
        memoryMb: Math.round((stats.memory_stats.usage ?? 0) / (1024 * 1024)),
        uptimeSeconds: startedAt
          ? Math.floor((Date.now() - Date.parse(startedAt)) / 1000)
          : 0,
        ...(startedAt ? { startedAt } : {}),
      };
    } catch {
      return {
        serverId,
        status: state.status,
        cpuPercent: 0,
        memoryMb: 0,
        uptimeSeconds: startedAt
          ? Math.floor((Date.now() - Date.parse(startedAt)) / 1000)
          : 0,
      };
    }
  }

  async listServers(): Promise<ServerState[]> {
    return Array.from(this.instances.values()).map((e) => e.state);
  }

  async shutdown(): Promise<void> {
    for (const entry of this.instances.values()) {
      if (entry.containerId) {
        try {
          await this.docker.getContainer(entry.containerId).stop({ t: 5 });
        } catch {
          // Container schon gestoppt.
        }
      }
    }
  }

  private require(serverId: string): ContainerEntry {
    const entry = this.instances.get(serverId);
    if (!entry) throw new Error(`Server "${serverId}" ist nicht registriert.`);
    return entry;
  }

  private emit(serverId: string, line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.logSink({ serverId, line, stream, ts: new Date().toISOString() });
  }

  /** Streamt die Container-Logs zeilenweise in den Event-Bus. */
  private streamLogs(entry: ContainerEntry): void {
    const containerId = entry.containerId;
    if (!containerId) return;

    const container = this.docker.getContainer(containerId);

    // Die Callback-Form liefert einen Node-Stream (und keinen Web-Stream),
    // deshalb wird sie hier bewusst der Promise-Form vorgezogen.
    container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
      if (err || !stream) {
        this.emit(entry.config.id, `[Docker] Logs nicht lesbar: ${err?.message ?? 'unbekannt'}`);
        return;
      }

      const decoder = new StringDecoder('utf8');
      let rest = '';

      stream.on('data', (chunk: Buffer | string) => {
        rest += decoder.write(chunk);
        const parts = rest.split(/\r?\n/);
        rest = parts.pop() ?? '';
        for (const line of parts) {
          if (line.trim().length > 0) this.emit(entry.config.id, line);
        }
      });

      stream.on('end', () => {
        entry.state.status = 'offline';
        this.emit(entry.config.id, '[Docker] Container beendet.');
      });

      stream.on('error', () => {
        // Stream-Fehler (z. B. Container entfernt) sind kein Absturz des Cores.
      });
    });
  }
}
