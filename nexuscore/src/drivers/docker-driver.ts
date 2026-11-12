import Docker from 'dockerode';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import type { HostDriver, LogSink } from './interface.js';
import type { ContainerSpec, ServerInstanceConfig, ServerState, ServerStats } from '../types.js';
import { ALLOWED_CAPABILITIES } from '../eggs/capabilities.js';
import { logger } from '../logger.js';
import { applyConfigFiles } from '../docker/config-apply.js';
import type { InstallerSpec } from './interface.js';

/**
 * Container-Treiber fuer Linux, Proxmox, Docker Desktop und NexusPanel OS.
 *
 * Gleiche Regeln wie das Panel fuer seine Spielcontainer:
 *  - der Server-Ordner liegt als Bind-Mount im Container (Dateimanager, Backups und SFTP arbeiten auf demselben Ordner),
 *  - harte Grenzen fuer Arbeitsspeicher, CPU und Prozesse, alle Linux-Rechte weg bis auf eine kleine Erlaubnisliste,
 *  - eigenes Spielnetz, Konsole ueber stdin, Neustarts steuert der Core (nicht Docker),
 *  - Beenden mit dem Stop-Befehl des Spiels (oder einem Signal), erst danach hart.
 *
 * Der Treiber spricht nur mit dem lokalen Docker-Daemon; ist keiner erreichbar, startet der Core trotzdem.
 */

export const GAME_NETWORK = 'nexuscore-games';
export const SERVER_LABEL = 'nexuscore.server';

/** Rechte, die jedes Spiel-Image fuer den Benutzerwechsel und Dateirechte braucht (wie im Panel). */
export const DEFAULT_SAFE_CAPS = ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'NET_BIND_SERVICE'];

const DEFAULT_STOP_SECONDS = 30;

// ------------------------------------------------------------ schmale Docker-Schnittstelle (testbar)

export interface ContainerLike {
  id?: string;
  start(): Promise<unknown>;
  stop(opts?: { t?: number }): Promise<unknown>;
  kill(opts?: { signal?: string }): Promise<unknown>;
  remove(opts?: { force?: boolean }): Promise<unknown>;
  inspect(): Promise<{ State: { Running: boolean; Pid?: number; StartedAt?: string; ExitCode?: number; OOMKilled?: boolean } }>;
  wait(): Promise<{ StatusCode: number }>;
  attach(opts: object): Promise<NodeJS.ReadWriteStream>;
  logs(opts: object, cb: (err: Error | null, stream?: NodeJS.ReadableStream) => void): void;
  stats(opts: { stream: false }): Promise<DockerStats>;
  update(opts: object): Promise<unknown>;
}

export interface DockerStats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number };
  memory_stats: { usage?: number; stats?: { inactive_file?: number; cache?: number } };
}

export interface DockerLike {
  ping(): Promise<unknown>;
  listNetworks(opts?: object): Promise<Array<{ Name: string }>>;
  createNetwork(opts: object): Promise<unknown>;
  getImage(name: string): { inspect(): Promise<unknown> };
  pull(image: string, cb: (err: Error | null, stream?: NodeJS.ReadableStream) => void): void;
  modem: {
    followProgress(stream: NodeJS.ReadableStream, done: (err: Error | null) => void, onProgress?: (ev: { status?: string; id?: string }) => void): void;
    demuxStream(stream: NodeJS.ReadableStream, out: NodeJS.WritableStream, err: NodeJS.WritableStream): void;
  };
  createContainer(opts: object): Promise<ContainerLike>;
  getContainer(id: string): ContainerLike;
  listContainers(opts: object): Promise<Array<{ Id: string; Names: string[]; State: string; Labels: Record<string, string> }>>;
}

// ------------------------------------------------------------------ Container bauen

export function containerName(serverId: string): string {
  return `nxc-${serverId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

/** Die Angaben des Spiels; Instanzen ohne `container` (aeltere Eintraege) behandeln `executable` als Image-Name. */
export function specOf(config: ServerInstanceConfig): ContainerSpec {
  return config.container ?? { image: config.executable, dataDir: '' };
}

/** Nur Rechte aus der Erlaubnisliste - egal, was das Egg verlangt. */
export function grantedCaps(extra: readonly string[] | undefined): string[] {
  const wanted = (extra ?? []).map((c) => c.trim().toUpperCase().replace(/^CAP_/, '')).filter((c) => ALLOWED_CAPABILITIES.has(c));
  return [...new Set([...DEFAULT_SAFE_CAPS, ...wanted])];
}

/**
 * Optionen fuer `createContainer`. Exportiert, damit sich die Zuordnung ohne laufenden Docker-Daemon pruefen laesst.
 */
export function buildContainerOptions(config: ServerInstanceConfig, opts: { network?: string | null } = {}): Record<string, unknown> {
  const spec = specOf(config);
  const exposed: Record<string, Record<string, never>> = {};
  const bindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const port of config.ports) {
    const key = `${port.containerPort ?? port.hostPort}/${port.protocol}`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: String(port.hostPort) }];
  }

  const memory = config.maxMemoryMb ? config.maxMemoryMb * 1024 * 1024 : 0;
  const cpu = config.maxCpuPercent ?? 0;
  const mounts = spec.dataDir && config.workingDir ? [{ Type: 'bind', Source: config.workingDir, Target: spec.dataDir }] : [];

  return {
    name: containerName(config.id),
    Image: spec.image,
    ...(spec.user ? { User: spec.user } : {}),
    ...(spec.entrypoint?.length ? { Entrypoint: spec.entrypoint } : {}),
    // Beim Image-Namen-Betrieb (ohne Egg) kommen die Startargumente aus der Konfiguration
    ...(config.container ? {} : config.args.length ? { Cmd: config.args } : {}),
    Env: Object.entries(config.env ?? {}).map(([k, v]) => `${k}=${v}`),
    WorkingDir: spec.dataDir || undefined,
    // Konsole: der Core schreibt Befehle ueber stdin
    OpenStdin: true,
    StdinOnce: false,
    Tty: false,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    ExposedPorts: exposed,
    Labels: { [SERVER_LABEL]: config.id },
    HostConfig: {
      ...(memory ? { Memory: memory, MemoryReservation: Math.floor(memory * 0.8), MemorySwap: memory } : {}),
      ...(cpu ? { CpuQuota: Math.round(cpu * 1000), CpuPeriod: 100_000 } : {}),
      PidsLimit: 512,
      ...(opts.network ? { NetworkMode: opts.network } : {}),
      PortBindings: bindings,
      ...(mounts.length ? { Mounts: mounts } : {}),
      // Neustarts steuert der Core, nicht Docker - sonst laufen Auto-Neustart und Absturzerkennung gegeneinander
      RestartPolicy: { Name: 'no' },
      CapDrop: ['ALL'],
      CapAdd: grantedCaps(spec.capAdd),
      ...(spec.tmpfsMb ? { Tmpfs: { '/tmp': `rw,size=${spec.tmpfsMb}m` } } : {}),
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  };
}

/** Zeilen aus Bytebloecken - ein halbes Zeichen oder eine halbe Zeile bleibt bis zum naechsten Block liegen. */
function lineWriter(onLine: (line: string) => void): Writable {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      rest += decoder.write(chunk);
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const line of parts) if (line.trim().length > 0) onLine(line);
      cb();
    },
    final(cb) {
      if (rest.trim()) onLine(rest);
      cb();
    },
  });
}

interface Entry {
  config: ServerInstanceConfig;
  state: ServerState;
  container?: ContainerLike;
  stdin?: NodeJS.WritableStream;
  stopRequested: boolean;
  /** Wird erfuellt, wenn der laufende Container beendet ist. */
  exited?: Promise<void>;
}

export class DockerDriver implements HostDriver {
  readonly name = 'docker';
  private readonly instances = new Map<string, Entry>();
  private readonly docker: DockerLike;
  private logSink: LogSink = () => {};
  private dockerAvailable = false;
  private network: string | null = null;
  /** Beim Start gefundene, schon laufende Container (Core-Neustart): id -> Container. */
  private readonly adopted = new Map<string, ContainerLike>();

  constructor(docker?: DockerLike) {
    this.docker = docker ?? (new Docker() as unknown as DockerLike);
  }

  async initialize(): Promise<void> {
    try {
      await this.docker.ping();
      this.dockerAvailable = true;
      logger.info('Docker-Daemon erreichbar');
    } catch (err) {
      this.dockerAvailable = false;
      logger.warn({ err: (err as Error).message }, 'Kein Docker-Daemon erreichbar - Instanzen koennen nicht gestartet werden');
      return;
    }
    await this.ensureNetwork();
    // Container, die bei einem Neustart des Cores weiterliefen, wieder aufnehmen (statt sie zu verlieren)
    try {
      const list = await this.docker.listContainers({ all: false, filters: { label: [SERVER_LABEL] } });
      for (const c of list) {
        const id = c.Labels[SERVER_LABEL];
        if (id && c.State === 'running') this.adopted.set(id, this.docker.getContainer(c.Id));
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Laufende Container konnten nicht gelesen werden');
    }
  }

  setLogSink(sink: LogSink): void {
    this.logSink = sink;
  }

  private async ensureNetwork(): Promise<void> {
    try {
      const nets = await this.docker.listNetworks({ filters: { name: [GAME_NETWORK] } });
      if (!nets.some((n) => n.Name === GAME_NETWORK)) await this.docker.createNetwork({ Name: GAME_NETWORK, Driver: 'bridge', CheckDuplicate: true });
      this.network = GAME_NETWORK;
    } catch (err) {
      // Ohne eigenes Netz laeuft es im Standardnetz weiter - schlechter getrennt, aber nicht kaputt
      this.network = null;
      logger.warn({ err: (err as Error).message }, 'Spielnetz nicht verfuegbar - Standardnetz wird benutzt');
    }
  }

  async registerServer(config: ServerInstanceConfig): Promise<ServerState> {
    const state: ServerState = { id: config.id, status: 'offline' };
    const entry: Entry = { config, state, stopRequested: false };
    this.instances.set(config.id, entry);
    const adopted = this.adopted.get(config.id);
    if (adopted) {
      this.adopted.delete(config.id);
      try {
        const info = await adopted.inspect();
        if (info.State.Running) {
          entry.container = adopted;
          state.status = 'running';
          if (info.State.StartedAt) state.startedAt = info.State.StartedAt;
          if (info.State.Pid) state.pid = info.State.Pid;
          this.emit(config.id, '[Docker] Laufender Container uebernommen.');
          this.attach(entry, adopted, new Date());
        }
      } catch {
        /* weg: bleibt offline */
      }
    }
    return state;
  }

  async updateServer(config: ServerInstanceConfig): Promise<ServerState> {
    const entry = this.instances.get(config.id);
    // Noch nicht angemeldet (z. B. nach der Installation): anmelden
    if (!entry) return this.registerServer(config);
    if (entry.container) throw new Error('Ein laufender Server kann nicht umkonfiguriert werden.');
    entry.config = config;
    return entry.state;
  }

  async unregisterServer(serverId: string): Promise<void> {
    const entry = this.instances.get(serverId);
    if (!entry) return;
    if (entry.container) throw new Error('Ein laufender Server kann nicht abgemeldet werden.');
    if (this.dockerAvailable) await this.docker.getContainer(containerName(serverId)).remove({ force: true }).catch(() => {});
    this.instances.delete(serverId);
  }

  // ---------------------------------------------------------------- Start

  private async ensureImage(image: string, serverId: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      /* nicht da: holen */
    }
    this.emit(serverId, `[Docker] Lade Image ${image} ...`);
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('Kein Datenstrom vom Docker-Daemon'));
        let last = 0;
        this.docker.modem.followProgress(
          stream,
          (e) => (e ? reject(e) : resolve()),
          (ev) => {
            // Nicht jede Fortschrittszeile melden: je Schicht und Zustand genuegt, hoechstens alle 2 Sekunden
            if (!ev.status || Date.now() - last < 2000) return;
            last = Date.now();
            this.emit(serverId, `[Docker] ${ev.id ? `${ev.id}: ` : ''}${ev.status}`);
          },
        );
      });
    });
    this.emit(serverId, '[Docker] Image geladen.');
  }

  /** Datenordner anlegen; mit run_as (z. B. 1000:1000) und Root-Rechten dem Benutzer uebergeben. */
  private async prepareDataDir(config: ServerInstanceConfig, serverId: string): Promise<void> {
    const spec = specOf(config);
    if (!spec.dataDir || !config.workingDir) return;
    await fs.mkdir(config.workingDir, { recursive: true });
    if (spec.user && process.platform !== 'win32') {
      const [uid, gid] = spec.user.split(':').map(Number);
      if (Number.isInteger(uid) && Number.isInteger(gid)) {
        try {
          await fs.chown(config.workingDir, uid!, gid!);
        } catch {
          this.emit(serverId, `[Docker] Hinweis: der Datenordner gehoert nicht ${spec.user} - laeuft der Core nicht als root, muss der Ordner dafuer beschreibbar sein.`);
        }
      }
    }
  }

  /** Konfigurationsdateien des Eggs mit den aktuellen Werten schreiben (vor jedem Start, wie im Panel). */
  private async writeConfigFiles(config: ServerInstanceConfig, serverId: string): Promise<void> {
    const spec = specOf(config);
    if (!spec.configFiles || !config.workingDir) return;
    const env = config.env ?? {};
    await applyConfigFiles(
      config.workingDir,
      spec.configFiles,
      { variables: env, ramMb: config.maxMemoryMb ?? 0, ip: '0.0.0.0', port: Number(env.SERVER_PORT) || config.ports[0]?.hostPort || 0, ports: spec.refPorts ?? {}, serverDir: spec.dataDir, serverName: config.name },
      (line) => this.emit(serverId, line),
    );
  }

  /**
   * Installation in einem eigenen Container (Installationsskript des Eggs): der Server-Ordner liegt unter
   * /mnt/server, der Container bekommt so wenig Rechte wie moeglich. Rueckgabe: Beendigungscode des Skripts.
   */
  async runInstaller(spec: InstallerSpec, onLog: (line: string) => void): Promise<number> {
    if (!this.dockerAvailable) throw new Error('Kein Docker-Daemon erreichbar - die Installation kann nicht laufen.');
    await fs.mkdir(spec.hostDir, { recursive: true });
    await this.ensureImage(spec.image, spec.serverId);
    const name = `nxc-install-${spec.serverId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
    await this.docker.getContainer(name).remove({ force: true }).catch(() => {});
    const container = await this.docker.createContainer({
      name,
      Image: spec.image,
      Entrypoint: [spec.shell === 'ash' ? '/bin/ash' : spec.shell === 'sh' ? '/bin/sh' : '/bin/bash', '-c'],
      Cmd: [spec.script],
      Env: [...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`), 'SERVER_DIR=/mnt/server'],
      WorkingDir: '/mnt/server',
      Tty: false,
      Labels: { 'nexuscore.installer': spec.serverId },
      HostConfig: {
        Mounts: [{ Type: 'bind', Source: spec.hostDir, Target: '/mnt/server' }],
        // Der Installer laedt fremde Dateien: so wenig Rechte wie moeglich
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'],
        PidsLimit: 512,
        Memory: 2048 * 1024 * 1024,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } },
      },
    });
    try {
      const done = new Promise<void>((resolve) => {
        container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
          if (err || !stream) return resolve();
          const out = lineWriter(onLog);
          const errOut = lineWriter(onLog);
          this.docker.modem.demuxStream(stream, out, errOut);
          stream.on('end', () => resolve());
          stream.on('error', () => resolve());
        });
      });
      await container.start();
      const result = await container.wait();
      // Die letzten Zeilen des Logs noch abwarten (hoechstens kurz)
      await Promise.race([done, new Promise<void>((r) => setTimeout(r, 2000))]);
      return result.StatusCode;
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  async startServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    if (!this.dockerAvailable) throw new Error('Kein Docker-Daemon erreichbar - der Container kann nicht gestartet werden.');
    if (entry.state.status === 'running' || entry.state.status === 'starting') return entry.state;
    const { config } = entry;
    if (!specOf(config).image) throw new Error('Dieser Server hat kein Docker-Image.');

    entry.state.status = 'starting';
    entry.stopRequested = false;
    delete entry.state.exitCode;
    delete entry.state.exitedAt;
    this.emit(serverId, `[Docker] Starte ${containerName(serverId)} (${specOf(config).image}) ...`);
    try {
      await this.ensureImage(specOf(config).image, serverId);
      await this.prepareDataDir(config, serverId);
      await this.writeConfigFiles(config, serverId);
      // Ein uebrig gebliebener, beendeter Container gleichen Namens wuerde das Anlegen blockieren
      await this.docker.getContainer(containerName(serverId)).remove({ force: true }).catch(() => {});
      const container = await this.docker.createContainer(buildContainerOptions(config, { network: this.network }));
      entry.container = container;
      await container.start();
      const startedAt = new Date();
      entry.state.status = 'running';
      entry.state.startedAt = startedAt.toISOString();
      try {
        const info = await container.inspect();
        if (info.State.Pid) entry.state.pid = info.State.Pid;
      } catch {
        /* Pid ist nur eine Zugabe */
      }
      this.attach(entry, container, startedAt);
    } catch (err) {
      entry.state.status = 'error';
      delete entry.container;
      this.emit(serverId, `[FEHLER] Containerstart fehlgeschlagen: ${(err as Error).message}`, 'stderr');
      throw err;
    }
    return entry.state;
  }

  /** Beobachtet das Ende, liest die Ausgabe und haengt die Konsole (stdin) an. */
  private attach(entry: Entry, container: ContainerLike, since: Date): void {
    const id = entry.config.id;
    entry.exited = new Promise<void>((resolve) => {
      container
        .wait()
        .then(({ StatusCode }) => this.onExit(entry, container, StatusCode))
        .catch(() => this.onExit(entry, container, undefined))
        .finally(resolve);
    });

    container.logs({ follow: true, stdout: true, stderr: true, since: Math.floor(since.getTime() / 1000) - 1 }, (err, stream) => {
      if (err || !stream) return this.emit(id, `[Docker] Ausgabe nicht lesbar: ${err?.message ?? 'unbekannt'}`, 'stderr');
      // Ohne Tty liefert Docker Standardausgabe und Fehlerausgabe gemischt in Bloecken - auseinandernehmen
      this.docker.modem.demuxStream(stream, lineWriter((l) => this.emit(id, l)), lineWriter((l) => this.emit(id, l, 'stderr')));
      stream.on('error', () => {});
    });

    container
      .attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true })
      .then((s) => {
        if (entry.container === container) entry.stdin = s;
      })
      .catch(() => this.emit(id, '[Docker] Konsole (stdin) nicht erreichbar - Befehle gehen nicht.', 'stderr'));
  }

  private onExit(entry: Entry, container: ContainerLike, code: number | undefined): void {
    if (entry.container !== container) return; // ein aelterer Container, schon ersetzt
    const id = entry.config.id;
    entry.stdin?.end?.();
    delete entry.stdin;
    delete entry.container;
    delete entry.state.pid;
    entry.state.exitedAt = new Date().toISOString();
    if (code !== undefined) entry.state.exitCode = code;
    // Gewollt beendet (oder sauber mit Code 0) ist offline; alles andere ein Absturz
    entry.state.status = entry.stopRequested || code === 0 ? 'offline' : 'error';
    this.emit(id, `[Docker] Container beendet${code !== undefined ? ` (Code ${code})` : ''}.`);
  }

  // ---------------------------------------------------------------- Beenden

  private async waitExit(entry: Entry, ms: number): Promise<boolean> {
    if (!entry.exited) return true;
    return Promise.race([entry.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  }

  async stopServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    const container = entry.container;
    if (!container) {
      if (entry.state.status !== 'error') entry.state.status = 'offline';
      return entry.state;
    }
    entry.stopRequested = true;
    entry.state.status = 'stopping';
    const seconds = entry.config.stopTimeoutSeconds ?? DEFAULT_STOP_SECONDS;
    const spec = specOf(entry.config);
    try {
      if (spec.stopSignal) {
        this.emit(serverId, `[Docker] Sende ${spec.stopSignal} ...`);
        await container.kill({ signal: spec.stopSignal });
      } else if (entry.config.stopCommand && entry.stdin) {
        this.emit(serverId, `[Docker] Sende Stop-Befehl "${entry.config.stopCommand}" ...`);
        entry.stdin.write(`${entry.config.stopCommand}\n`);
      }
      if (!(await this.waitExit(entry, seconds * 1000))) {
        this.emit(serverId, `[Docker] Server hat nach ${seconds} s nicht geendet - Docker beendet ihn.`);
        await container.stop({ t: 10 }).catch(() => {});
        await this.waitExit(entry, 20_000);
      }
    } catch (err) {
      this.emit(serverId, `[FEHLER] Stoppen fehlgeschlagen: ${(err as Error).message}`, 'stderr');
    }
    if (entry.container === container) {
      // Das Ende wurde nicht gemeldet (Daemon weg?): trotzdem als beendet fuehren, sonst haengt der Server auf "stopping"
      delete entry.container;
      entry.state.status = 'offline';
      delete entry.state.pid;
    }
    return entry.state;
  }

  async killServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    const container = entry.container;
    if (!container) return entry.state;
    entry.stopRequested = true;
    this.emit(serverId, '[Docker] Breche Container ab ...');
    try {
      await container.kill({ signal: 'SIGKILL' });
      await this.waitExit(entry, 15_000);
    } catch (err) {
      this.emit(serverId, `[FEHLER] Abbruch fehlgeschlagen: ${(err as Error).message}`, 'stderr');
    }
    if (entry.container === container) {
      delete entry.container;
      entry.state.status = 'offline';
      delete entry.state.pid;
    }
    return entry.state;
  }

  async sendCommand(serverId: string, command: string): Promise<void> {
    const entry = this.require(serverId);
    if (!entry.container || !entry.stdin) throw new Error('Der Server laeuft nicht oder die Konsole ist nicht erreichbar.');
    const line = command.replace(/[\r\n]+/g, ' ').trim();
    await new Promise<void>((resolve, reject) => entry.stdin!.write(`${line}\n`, (err) => (err ? reject(err) : resolve())));
  }

  /** Gaming-Modus: weniger CPU-Anteil gegenueber anderen Programmen (Docker "CpuShares", Standard 1024). */
  async setPriority(serverId: string, level: 'normal' | 'low'): Promise<number> {
    const entry = this.require(serverId);
    if (!entry.container) return 0;
    await entry.container.update({ CpuShares: level === 'low' ? 128 : 1024 });
    return 1;
  }

  // ---------------------------------------------------------------- Abfragen

  async getServerState(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    if (entry.container && this.dockerAvailable) {
      try {
        const info = await entry.container.inspect();
        if (!info.State.Running && entry.state.status === 'running') {
          // Das Ende kommt gleich ueber wait(); hier nicht vorgreifen
        } else if (info.State.Pid) {
          entry.state.pid = info.State.Pid;
        }
      } catch {
        /* Container weg: wait() meldet es */
      }
    }
    return entry.state;
  }

  async getServerStats(serverId: string): Promise<ServerStats> {
    const entry = this.require(serverId);
    const state = await this.getServerState(serverId);
    const startedAt = entry.state.startedAt;
    const uptimeSeconds = startedAt && state.status === 'running' ? Math.floor((Date.now() - Date.parse(startedAt)) / 1000) : 0;
    const idle: ServerStats = { serverId, status: state.status, cpuPercent: 0, memoryMb: 0, uptimeSeconds, ...(startedAt ? { startedAt } : {}) };
    if (!entry.container || state.status !== 'running') return { ...idle, uptimeSeconds: 0 };
    try {
      const s = await entry.container.stats({ stream: false });
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const systemDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
      const cores = s.cpu_stats.online_cpus ?? 1;
      const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? Math.round((cpuDelta / systemDelta) * cores * 1000) / 10 : 0;
      // Wie "docker stats": Seitencache (inaktive Dateien) zaehlt nicht als belegter Speicher
      const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
      const memoryMb = Math.max(0, Math.round(((s.memory_stats.usage ?? 0) - cache) / (1024 * 1024)));
      return { ...idle, ...(state.pid !== undefined ? { pid: state.pid } : {}), cpuPercent, memoryMb };
    } catch {
      return idle;
    }
  }

  async listServers(): Promise<ServerState[]> {
    return Array.from(this.instances.values()).map((e) => e.state);
  }

  async shutdown(): Promise<void> {
    // Spiele sauber beenden, bevor der Core endet - gleichzeitig, damit es nicht Server mal Wartezeit dauert
    await Promise.all(Array.from(this.instances.values()).filter((e) => e.container).map((e) => this.stopServer(e.config.id).catch(() => undefined)));
  }

  // ---------------------------------------------------------------- Hilfen

  private require(serverId: string): Entry {
    const entry = this.instances.get(serverId);
    if (!entry) throw new Error(`Server "${serverId}" ist nicht registriert.`);
    return entry;
  }

  private emit(serverId: string, line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.logSink({ serverId, line, stream, ts: new Date().toISOString() });
  }
}
