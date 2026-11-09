import Docker from 'dockerode';
import { platform, hostname } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdir, chown, chmod, rm } from 'node:fs/promises';
import { config, containerDns } from '../config.js';
import { log } from '../log.js';
import type { PortBinding } from '../types.js';

/**
 * Alles, was das Panel mit Containern tut, geht durch dieses Interface.
 * Kein Handler spricht je direkt mit dockerode.
 *
 * Der Grund steht im Konzept unter "Nicht nachtraeglich aenderbar":
 * sobald ein zweiter Host dazukommt, tritt an diese Stelle ein Daemon,
 * ohne dass die uebrige Anwendung sich aendert.
 */
export interface ContainerEngine {
  ping(): Promise<boolean>;
  version(): Promise<string>;
  listPanelContainers(): Promise<PanelContainer[]>;
  hasImage(image: string): Promise<boolean>;
  pullImage(image: string, onProgress?: (line: string) => void): Promise<void>;
  removeImage(image: string): Promise<void>;
  create(spec: ContainerSpec): Promise<string>;
  start(containerId: string): Promise<void>;
  stopGraceful(containerId: string, timeoutSeconds: number): Promise<void>;
  kill(containerId: string): Promise<void>;
  remove(containerId: string, force?: boolean): Promise<void>;
  inspect(containerId: string): Promise<ContainerState | null>;
  sendToStdin(containerId: string, text: string): Promise<void>;
  waitForExit(containerId: string): Promise<number>;
  subscribeEvents(handler: (e: DockerEvent) => void): Promise<() => void>;
  runInstaller(spec: InstallerSpec, onLog: (line: string) => void): Promise<number>;
  streamLogs(containerId: string, onLine: (line: string) => void, onEnd?: () => void): Promise<() => void>;
  tailLogs(containerId: string, lines: number): Promise<string[]>;
  listPublishedPorts(): Promise<Set<number>>;
  /** Eigenes Netz fuer Spielcontainer anlegen und das Panel (falls selbst im Container) dazuholen. */
  ensureGameNetwork(): Promise<void>;
  /** Container ins Spielnetz haengen (fuer aeltere Container, die noch im Standardnetz stecken). */
  joinGameNetwork(containerId: string): Promise<void>;
  /** IP des Containers im Spielnetz - fuer Porttest und spaeter RCON. */
  gameNetworkIp(containerId: string): Promise<string | null>;
  /** RAM und CPU eines Containers aendern - geht auch im laufenden Betrieb. */
  updateResources(containerId: string, r: { ramMb: number; swapMb: number; cpuPercent: number }): Promise<void>;
  /** Auslastung live, etwa jede Sekunde ein Wert. Gibt eine Abmeldefunktion zurueck. */
  streamStats(containerId: string, onStats: (s: ContainerStats) => void): Promise<() => void>;
  ensureVolume(shortId: string, owner?: string | null): Promise<void>;
  removeVolume(shortId: string): Promise<void>;
  /** Wie viel Platz belegt Docker selbst (Images, Container-Schichten, Volumes, Build-Cache)? */
  diskUsage(): Promise<DockerDiskUsage>;
  /** Ungenutzte Images und Build-Cache loeschen. Container (auch gestoppte Spielserver) bleiben. */
  prune(opts: { images: boolean; buildCache: boolean }): Promise<{ imagesDeleted: number; reclaimedMb: number }>;
  /** Labels eines Containers, null wenn es ihn nicht gibt. */
  labels(containerId: string): Promise<Record<string, string> | null>;
  /** Fuehrt einen einmaligen Befehl in einem temporaeren Container aus und faengt die Ausgabe ab. */
  runOneOff(image: string, cmd: string[], timeoutMs?: number): Promise<{ exitCode: number; output: string }>;
}

export interface DockerDiskUsage {
  imagesMb: number;
  containersMb: number;
  volumesMb: number;
  buildCacheMb: number;
  /** Schreibschicht (SizeRw) je Server-ID in MB – gross = Spieldaten ausserhalb des Datenordners. */
  serverContainerMb?: Record<string, number>;
}

export interface ContainerStats {
  /** Prozent eines Kerns, 200 = zwei volle Kerne */
  cpuPercent: number;
  memMb: number;
  memLimitMb: number;
  netRxBytes: number;
  netTxBytes: number;
}

/** Docker-Rohwerte in Prozent und MB umrechnen - wie "docker stats" es tut. */
export function computeStats(raw: {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number; cache?: number } };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}): ContainerStats {
  const cpuDelta = (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = raw.cpu_stats?.online_cpus ?? 1;
  const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
  // Seiten-Cache abziehen, sonst zeigt jeder Server nach einer Weile "voll" an.
  const cache = raw.memory_stats?.stats?.inactive_file ?? raw.memory_stats?.stats?.cache ?? 0;
  const mem = Math.max(0, (raw.memory_stats?.usage ?? 0) - cache);
  let rx = 0, tx = 0;
  for (const n of Object.values(raw.networks ?? {})) { rx += n.rx_bytes ?? 0; tx += n.tx_bytes ?? 0; }
  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memMb: Math.round(mem / 1024 / 1024),
    memLimitMb: Math.round((raw.memory_stats?.limit ?? 0) / 1024 / 1024),
    netRxBytes: rx,
    netTxBytes: tx,
  };
}

export interface PanelContainer {
  id: string;
  serverId: string;
  name: string;
  state: string;
  status: string;
}

export interface DockerEvent {
  action: string;          // start | die | stop | kill | oom | destroy
  containerId: string;
  serverId: string;
  exitCode: number | null;
  attributes: Record<string, string>;
}

export interface ContainerState {
  id: string;
  running: boolean;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  oomKilled: boolean;
}

export interface InstallerSpec {
  shortId: string;
  image: string;
  script: string;
  env: Record<string, string>;
  /** Shell fuer das Skript: Pterodactyl-Eggs auf Alpine nutzen "ash" (dort gibt es kein bash). */
  shell?: 'bash' | 'ash' | 'sh';
}

export interface ContainerSpec {
  shortId: string;
  serverId: string;
  ownerId: string;
  image: string;
  env: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  ramMb: number;
  swapMb: number;
  cpuPercent: number;
  ioWeight: number;
  ports: PortBinding[];
  /** Bereits gegen die Erlaubnisliste gefiltert. */
  capAdd?: string[];
  /** Wo das Image seine Daten erwartet. */
  dataDir?: string;
  /** uid:gid, als die der Container laeuft; der Datenordner gehoert diesem Benutzer. */
  user?: string | null;
  /** /tmp im Container: kleine RAM-Disk (Vorgabe) oder normaler Plattenplatz. */
  tmp?: TmpSpec;
}

/**
 * /tmp ist standardmaessig eine RAM-Disk mit 256 MB - schnell, und nach dem
 * Stoppen weg. Spiele, die ueber Proton laufen, laden aber Proton selbst
 * (500+ MB) nach /tmp. Fuer sie sagt das Egg "tmp": "disk", dann liegt /tmp
 * auf der Platte im Container.
 */
export type TmpSpec = { mode: 'tmpfs'; sizeMb: number } | { mode: 'disk' };
export const DEFAULT_TMP: TmpSpec = { mode: 'disk' };

/**
 * Kennung der Laufzeit-Einstellungen, die sich nur beim Anlegen des
 * Containers setzen lassen. Steht als Label am Container; weicht sie vom
 * Egg ab, legt das Panel den Container vor dem naechsten Start neu an.
 */
export function runtimeKey(tmp: TmpSpec = DEFAULT_TMP) {
  return tmp.mode === 'disk' ? 'tmp=disk' : `tmp=tmpfs:${tmp.sizeMb}`;
}
export const RUNTIME_LABEL = 'panel.runtime';

function tmpfsOption(tmp: TmpSpec) {
  return tmp.mode === 'tmpfs' ? { Tmpfs: { '/tmp': `rw,exec,nosuid,size=${tmp.sizeMb}m` } } : {};
}

const PANEL_LABEL = 'panel.server_id';
/**
 * Alle Spielcontainer haengen in einem eigenen Netz. Das Panel tritt diesem
 * Netz bei, wenn es selbst im Container laeuft - sonst koennte es die
 * Spiele gar nicht direkt erreichen (Docker trennt Netze voneinander).
 * Noetig fuer den Bereitschafts-Porttest und spaeter fuer RCON.
 */
export const GAME_NETWORK = 'nxp-games';
const isWindows = platform() === 'win32';

/**
 * Spieldaten liegen unter Linux als Bind-Mount auf dem Host - nur so koennen
 * Dateimanager und Backups direkt darauf zugreifen.
 *
 * Unter Windows geht das nicht: der Daemon laeuft in WSL2 und kennt
 * C:\-Pfade nicht. Dort wird ein benanntes Volume genutzt. Das ist fuer die
 * Entwicklung voellig ausreichend; der Betrieb laeuft ohnehin auf Linux.
 */
function volumeName(shortId: string): string {
  return `nxp_${shortId}`;
}

function volumePath(shortId: string): string {
  return resolve(config.VOLUME_ROOT, shortId);
}

/**
 * Sichere Standard-Capabilities für Game-Server-Container.
 * Standardmäßig werden nur unprivilegierte Fähigkeiten gewährt, die typische Spiele-
 * Images zwingend für Berechtigungs-Management (root -> steam/factorio user), Dateirechte
 * und Prozesssignale benötigen.
 * Gefährliche Capabilities (SYS_ADMIN, NET_ADMIN, SYS_PTRACE, etc.) bleiben strikt verboten.
 */
export const DEFAULT_SAFE_CAPS = [
  'CHOWN',
  'SETUID',
  'SETGID',
  'DAC_OVERRIDE',
  'FOWNER',
  'KILL',
  'NET_BIND_SERVICE',
];

class LocalDockerEngine implements ContainerEngine {
  private readonly docker: Docker;

  constructor() {
    this.docker = new Docker({ socketPath: config.DOCKER_SOCKET });
  }

  async labels(containerId: string): Promise<Record<string, string> | null> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return (info.Config?.Labels as Record<string, string> | undefined) ?? {};
    } catch { return null; }
  }

  async prune(opts: { images: boolean; buildCache: boolean }): Promise<{ imagesDeleted: number; reclaimedMb: number }> {
    let bytes = 0, images = 0;
    if (opts.images) {
      // dangling=false: auch getaggte Images, solange kein Container sie nutzt.
      const r = (await this.docker.pruneImages({ filters: { dangling: { false: true } } })) as { ImagesDeleted?: unknown[]; SpaceReclaimed?: number };
      images = r.ImagesDeleted?.length ?? 0;
      bytes += r.SpaceReclaimed ?? 0;
    }
    if (opts.buildCache) {
      const r = (await (this.docker as unknown as { pruneBuilder: (o?: object) => Promise<{ SpaceReclaimed?: number }> }).pruneBuilder()) ?? {};
      bytes += r.SpaceReclaimed ?? 0;
    }
    return { imagesDeleted: images, reclaimedMb: Math.round(bytes / 1048576) };
  }

  async diskUsage(): Promise<DockerDiskUsage> {
    // /system/df ist teuer (Docker rechnet alle Schichten nach) - der Aufrufer cacht.
    const df = (await this.docker.df()) as {
      LayersSize?: number;
      Containers?: Array<{ SizeRw?: number; Labels?: Record<string, string> }>;
      Volumes?: Array<{ UsageData?: { Size?: number } }>;
      BuildCache?: Array<{ Size?: number }>;
    };
    const mb = (b: number) => Math.round(b / 1048576);
    const sum = (xs: Array<number | undefined> | undefined) => (xs ?? []).reduce<number>((a, b) => a + Math.max(0, b ?? 0), 0);
    const serverContainerMb: Record<string, number> = {};
    for (const c of df.Containers ?? []) {
      const sid = c.Labels?.[PANEL_LABEL];
      if (sid && typeof c.SizeRw === 'number' && c.SizeRw >= 0) {
        serverContainerMb[sid] = mb(c.SizeRw);
      }
    }
    return {
      imagesMb: mb(df.LayersSize ?? 0),
      containersMb: mb(sum(df.Containers?.map((c) => c.SizeRw))),
      volumesMb: mb(sum(df.Volumes?.map((v) => v.UsageData?.Size))),
      buildCacheMb: mb(sum(df.BuildCache?.map((b) => b.Size))),
      serverContainerMb,
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch (err) {
      log.error({ err, socket: config.DOCKER_SOCKET }, 'Docker nicht erreichbar');
      return false;
    }
  }

  async version(): Promise<string> {
    return (await this.docker.version()).Version;
  }

  async listPanelContainers(): Promise<PanelContainer[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [PANEL_LABEL] },
    });

    return containers.map((c) => ({
      id: c.Id,
      serverId: c.Labels[PANEL_LABEL] ?? '',
      name: c.Names[0]?.replace(/^\//, '') ?? '',
      state: c.State,
      status: c.Status,
    }));
  }

  async ensureVolume(shortId: string, owner?: string | null): Promise<void> {
    if (isWindows) {
      await this.docker.createVolume({ Name: volumeName(shortId), Labels: { 'panel.short_id': shortId } });
      return;
    }
    const dir = volumePath(shortId);
    await mkdir(dir, { recursive: true, mode: 0o777 });
    await chmod(dir, 0o777).catch(() => {});
    if (owner) {
      // Nur der oberste Ordner: was darin liegt, legt das Spiel selbst als
      // dieser Benutzer an. Importierte Daten bringt das Import-Skript mit
      // passendem Besitzer mit.
      const [uid, gid] = owner.split(':').map(Number) as [number, number];
      await chown(dir, uid, gid).catch((err: unknown) => log.warn({ err, dir, owner }, 'Besitzer des Datenordners nicht setzbar'));
    }
  }

  async removeVolume(shortId: string): Promise<void> {
    if (isWindows) {
      try {
        await this.docker.getVolume(volumeName(shortId)).remove({ force: true });
      } catch (err) {
        log.warn({ err, shortId }, 'Volume konnte nicht entfernt werden');
      }
      return;
    }
    const dir = volumePath(shortId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn({ err, shortId, dir }, 'Datenordner konnte nicht entfernt werden');
    }
  }

  async removeImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).remove({ force: false });
    } catch (err) {
      log.debug({ err, image }, 'Image konnte nicht entfernt werden oder wird noch genutzt');
    }
  }

  async hasImage(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Docker zieht ein fehlendes Image beim Anlegen eines Containers NICHT
   * selbst nach - die API antwortet schlicht mit 404. Das Panel muss den
   * Download also selbst anstossen und den Fortschritt melden, sonst steht
   * der Nutzer vor einer Installation, die minutenlang nichts sagt.
   */
  async pullImage(image: string, onProgress?: (line: string) => void): Promise<void> {
    log.info({ image }, 'Image wird geladen');
    const stream = await this.docker.pull(image);

    await new Promise<void>((resolve, reject) => {
      // Ein Image hat Dutzende Schichten, jede meldet mehrfach pro Sekunde.
      // Ungefiltert sind das fuer ein einziges Image mehrere hundert Zeilen -
      // im Panel spaeter eine Wand aus Text, in der niemand etwas findet.
      // Deshalb: je Schicht nur Statuswechsel, und nur die, die etwas sagen.
      const seen = new Map<string, string>();
      const interessant = new Set(['Pull complete', 'Already exists', 'Download complete']);
      let fertig = 0;

      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (event: { status?: string; id?: string }) => {
          const status = event.status ?? '';
          const layer = event.id ?? '';
          if (!status) return;

          // Zusammenfassungen ohne Schicht-ID immer durchlassen.
          if (!layer) {
            onProgress?.(status);
            return;
          }

          if (seen.get(layer) === status) return;
          seen.set(layer, status);

          if (status === 'Pull complete' || status === 'Already exists') {
            fertig++;
            onProgress?.(`${fertig} von ${seen.size} Schichten bereit`);
          } else if (interessant.has(status)) {
            // bewusst still
          }
        },
      );
    });

    log.info({ image }, 'Image bereit');
  }

  async create(spec: ContainerSpec): Promise<string> {
    if (!(await this.hasImage(spec.image))) {
      await this.pullImage(spec.image, (line) => log.info({ image: spec.image }, line));
    }

    await this.ensureVolume(spec.shortId, spec.user ?? null);
    await this.ensureGameNetwork().catch((err: unknown) => log.warn({ err }, 'Spielnetz nicht verfuegbar'));

    const exposed: Record<string, Record<string, never>> = {};
    const bindings: Record<string, { HostPort: string }[]> = {};
    for (const p of spec.ports) {
      const key = `${p.containerPort}/${p.protocol}`;
      exposed[key] = {};
      bindings[key] = [{ HostPort: String(p.hostPort) }];
    }

    const memoryBytes = spec.ramMb * 1024 * 1024;
    const containerName = `nxp-${spec.shortId}`;

    // Falls ein verwaister Container gleichen Namens noch existiert (z. B. wenn container_id in DB NULL war), vorab wegraeumen.
    await this.docker.getContainer(containerName).remove({ force: true }).catch(() => {});

    const container = await this.docker.createContainer({
      name: containerName,
      Image: spec.image,
      ...(spec.user ? { User: spec.user } : {}),
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      ...(spec.command ? { Cmd: spec.command } : {}),
      ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
      OpenStdin: true,
      StdinOnce: false,
      Tty: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      ExposedPorts: exposed,
      Labels: {
        [RUNTIME_LABEL]: runtimeKey(spec.tmp),
        [PANEL_LABEL]: spec.serverId,
        'panel.owner': spec.ownerId,
        'panel.short_id': spec.shortId,
      },
      HostConfig: {
        Memory: memoryBytes,
        MemoryReservation: Math.floor(memoryBytes * 0.8),
        MemorySwap: memoryBytes + spec.swapMb * 1024 * 1024,
        CpuQuota: spec.cpuPercent * 1000,
        CpuPeriod: 100_000,
        // Nur setzen, wenn der Host es kann - siehe ENABLE_IO_WEIGHT.
        ...(config.ENABLE_IO_WEIGHT ? { BlkioWeight: spec.ioWeight } : {}),
        PidsLimit: 512,
        NetworkMode: GAME_NETWORK,
        PortBindings: bindings,
        Mounts: [
          isWindows
            ? { Type: 'volume' as const, Source: volumeName(spec.shortId), Target: spec.dataDir ?? '/home/container' }
            : { Type: 'bind' as const, Source: volumePath(spec.shortId), Target: spec.dataDir ?? '/home/container' },
        ],
        // Neustarts steuert das Panel, nicht Docker - sonst laufen Auto-Restart
        // und Absturzzaehler gegeneinander.
        RestartPolicy: { Name: 'no' },
        CapDrop: ['ALL'],
        CapAdd: Array.from(new Set([...DEFAULT_SAFE_CAPS, ...(spec.capAdd ?? [])])),
        // Kein fest eingetragener DNS: Docker nutzt sonst den Resolver des
        // Hosts, und genau der funktioniert im jeweiligen Netz.
        ...(containerDns.length > 0 ? { Dns: containerDns } : {}),
        ...(tmpfsOption(spec.tmp ?? DEFAULT_TMP)),
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      },
    });

    log.info({ shortId: spec.shortId, containerId: container.id.slice(0, 12) }, 'Container angelegt');
    return container.id;
  }

  /**
   * Fuehrt das Installationsskript eines Eggs in einem EIGENEN Container aus.
   *
   * Getrennt vom Spielcontainer, weil die Installation andere Werkzeuge
   * braucht (curl, unzip, steamcmd) als das spaetere Spiel - und weil ein
   * Fehlschlag dann keinen halb eingerichteten Spielcontainer hinterlaesst.
   * Gemountet wird nur das Datenverzeichnis des Servers.
   */
  async runInstaller(spec: InstallerSpec, onLog: (line: string) => void): Promise<number> {
    await this.ensureVolume(spec.shortId);

    if (!(await this.hasImage(spec.image))) {
      await this.pullImage(spec.image, onLog);
    }

    const name = `nxp-install-${spec.shortId}`;
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch {
      /* Rueckstand eines abgebrochenen Laufs - darf fehlen */
    }

    const container = await this.docker.createContainer({
      name,
      Image: spec.image,
      Entrypoint: [spec.shell === 'ash' ? '/bin/ash' : spec.shell === 'sh' ? '/bin/sh' : '/bin/bash', '-c'],
      Cmd: [spec.script],
      Env: [
        ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        'SERVER_DIR=/mnt/server',
      ],
      WorkingDir: '/mnt/server',
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      Labels: { 'panel.installer': spec.shortId },
      HostConfig: {
        Mounts: [
          isWindows
            ? { Type: 'volume' as const, Source: volumeName(spec.shortId), Target: '/mnt/server' }
            : { Type: 'bind' as const, Source: volumePath(spec.shortId), Target: '/mnt/server' },
        ],
        // Der Installer laedt fremde Dateien herunter - er bekommt so wenig
        // Rechte wie moeglich und keinen Zugriff auf das interne Netz.
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'],
        PidsLimit: 512,
        Memory: 2048 * 1024 * 1024,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } },
      },
    });

    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      // Docker rahmt jede Ausgabe mit acht Byte Kopfdaten ein, wenn kein TTY
      // genutzt wird. Die muessen weg, sonst stehen Steuerzeichen im Log.
      buffer += stripFrames(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLog(line);
    });

    await container.start();
    const result = await container.wait();
    if (buffer.trim()) onLog(buffer);

    await container.remove({ force: true }).catch(() => {});
    return result.StatusCode as number;
  }

  async runOneOff(image: string, cmd: string[], timeoutMs = 35000): Promise<{ exitCode: number; output: string }> {
    if (!(await this.hasImage(image))) {
      await this.pullImage(image);
    }
    const container = await this.docker.createContainer({
      Image: image,
      Cmd: cmd,
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        AutoRemove: false,
        NetworkMode: 'bridge',
        Memory: 1024 * 1024 * 1024,
      },
    });

    let output = '';
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    stream.on('data', (chunk: Buffer) => {
      output += stripFrames(chunk);
    });

    await container.start();

    let exitCode = -1;
    let timer: NodeJS.Timeout | undefined;
    try {
      const waitPromise = container.wait();
      const timeoutPromise = new Promise<{ StatusCode: number }>((_, reject) => {
        timer = setTimeout(() => {
          container.kill().catch(() => {});
          reject(new Error('Container execution timed out'));
        }, timeoutMs);
      });
      const res = await Promise.race([waitPromise, timeoutPromise]);
      exitCode = res.StatusCode;
    } catch {
      exitCode = -1;
    } finally {
      if (timer) clearTimeout(timer);
      await container.remove({ force: true }).catch(() => {});
    }

    return { exitCode, output };
  }

  /**
   * Alle Ports, die irgendein Container auf dem Host belegt - auch solche,
   * die nicht vom Panel stammen. Wichtig, weil der Bindungstest in
   * allocations.ts nichts taugt, sobald das Panel selbst in einem Container
   * laeuft: dort prueft er nur den Netzwerkraum des Panel-Containers, in dem
   * jeder Port frei aussieht.
   */
  async ensureGameNetwork(): Promise<void> {
    const nets = await this.docker.listNetworks({ filters: { name: [GAME_NETWORK] } });
    if (!nets.some((n) => n.Name === GAME_NETWORK)) {
      await this.docker.createNetwork({ Name: GAME_NETWORK, Driver: 'bridge', Labels: { 'panel.network': 'games' } });
      log.info({ network: GAME_NETWORK }, 'Spielnetz angelegt');
    }
    if (!existsSync('/.dockerenv')) return;
    // Das Panel selbst beitreten lassen. Der Containername steht in der Compose-Datei.
    for (const self of ['nxp-panel', hostname()]) {
      try {
        const info = await this.docker.getContainer(self).inspect();
        if (info.NetworkSettings.Networks?.[GAME_NETWORK]) return;
        await this.docker.getNetwork(GAME_NETWORK).connect({ Container: info.Id });
        log.info('Panel dem Spielnetz beigetreten');
        return;
      } catch {
        /* naechsten Namen probieren */
      }
    }
    log.warn('Panel konnte dem Spielnetz nicht beitreten - Porttests koennten haengen');
  }

  async joinGameNetwork(containerId: string): Promise<void> {
    const info = await this.docker.getContainer(containerId).inspect();
    if (info.NetworkSettings.Networks?.[GAME_NETWORK]) return;
    await this.docker.getNetwork(GAME_NETWORK).connect({ Container: containerId }).catch((err: unknown) => {
      log.warn({ err, containerId }, 'Container konnte dem Spielnetz nicht beitreten');
    });
  }

  async gameNetworkIp(containerId: string): Promise<string | null> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return info.NetworkSettings.Networks?.[GAME_NETWORK]?.IPAddress || null;
    } catch {
      return null;
    }
  }

  async updateResources(containerId: string, r: { ramMb: number; swapMb: number; cpuPercent: number }): Promise<void> {
    const mem = r.ramMb * 1024 * 1024;
    await this.docker.getContainer(containerId).update({
      Memory: mem,
      MemoryReservation: Math.floor(mem * 0.8),
      MemorySwap: mem + r.swapMb * 1024 * 1024,
      CpuQuota: r.cpuPercent * 1000,
      CpuPeriod: 100_000,
    });
  }

  async streamStats(containerId: string, onStats: (s: ContainerStats) => void): Promise<() => void> {
    const stream = (await this.docker.getContainer(containerId).stats({ stream: true })) as unknown as NodeJS.ReadableStream;
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { onStats(computeStats(JSON.parse(line))); } catch { /* halbe Zeile - naechste kommt */ }
      }
    });
    stream.on('error', () => {});
    return () => (stream as { destroy?: () => void }).destroy?.();
  }

  async listPublishedPorts(): Promise<Set<number>> {
    const ports = new Set<number>();
    const containers = await this.docker.listContainers({ all: true });
    for (const c of containers) {
      for (const p of c.Ports ?? []) {
        if (p.PublicPort) ports.add(p.PublicPort);
      }
    }
    return ports;
  }

  /** Die letzten Zeilen eines - auch beendeten - Containers. */
  async tailLogs(containerId: string, lines: number): Promise<string[]> {
    try {
      const raw = (await this.docker.getContainer(containerId).logs({
        stdout: true, stderr: true, tail: lines, follow: false,
      })) as unknown as Buffer;
      return stripFrames(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)))
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0);
    } catch {
      return [];
    }
  }

  /** Haengt sich an die laufende Ausgabe eines Containers. */
  async streamLogs(
    containerId: string,
    onLine: (line: string) => void,
    onEnd?: () => void,
  ): Promise<() => void> {
    const stream = (await this.docker.getContainer(containerId).logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 0,
    })) as unknown as NodeJS.ReadableStream;

    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += stripFrames(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    });
    // Endet der Strom, ist der Container weg - wer auf eine bestimmte Zeile
    // wartet, muss das erfahren, sonst wartet er bis zum Zeitablauf.
    stream.on('end', () => onEnd?.());
    stream.on('close', () => onEnd?.());
    stream.on('error', (err: unknown) => {
      log.debug({ err, containerId }, 'Log-Stream beendet');
      onEnd?.();
    });

    return () => (stream as { destroy?: () => void }).destroy?.();
  }

  async start(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).start();
  }

  async stopGraceful(containerId: string, timeoutSeconds: number): Promise<void> {
    await this.docker.getContainer(containerId).stop({ t: timeoutSeconds });
  }

  async kill(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).kill({ signal: 'SIGKILL' });
  }

  async remove(containerId: string, force = false): Promise<void> {
    await this.docker.getContainer(containerId).remove({ force, v: false });
  }

  async inspect(containerId: string): Promise<ContainerState | null> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return {
        id: info.Id,
        running: info.State.Running,
        exitCode: info.State.ExitCode,
        startedAt: info.State.StartedAt,
        finishedAt: info.State.FinishedAt,
        oomKilled: info.State.OOMKilled,
      };
    } catch {
      return null; // Container existiert nicht mehr
    }
  }

  /** Schreibt einen Befehl in die Serverkonsole, inklusive Zeilenumbruch. */
  async sendToStdin(containerId: string, text: string): Promise<void> {
    const stream = await this.docker.getContainer(containerId).attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    });
    await new Promise<void>((res, rej) => {
      stream.write(text.endsWith('\n') ? text : `${text}\n`, (err) => (err ? rej(err) : res()));
    });
    stream.end();
  }

  /**
   * Ein einziger Ereignisstrom fuer ALLE Panel-Container.
   *
   * Der frueher genutzte Weg - pro Container ein eigener wait() - hat zwei
   * Schwaechen: er endet, sobald der Panel-Prozess neu startet, und bei
   * jedem Neustart eines Servers muss ein neuer Beobachter gesetzt werden.
   * Wird dabei einer vergessen, bleibt ein Absturz unbemerkt und der Status
   * steht dauerhaft falsch. Der Ereignisstrom kennt dieses Problem nicht:
   * er meldet jedes Start- und Endereignis, unabhaengig davon, wer den
   * Container gestartet hat.
   */
  async subscribeEvents(handler: (e: DockerEvent) => void): Promise<() => void> {
    let stopped = false;
    let current: NodeJS.ReadableStream | null = null;

    const connect = async (): Promise<void> => {
      if (stopped) return;
      try {
        const stream = (await this.docker.getEvents({
          filters: { type: ['container'], label: [PANEL_LABEL] },
        })) as NodeJS.ReadableStream;
        current = stream;

        let buffer = '';
        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const raw = JSON.parse(line) as {
                Action?: string;
                id?: string;
                Actor?: { Attributes?: Record<string, string> };
              };
              const attrs = raw.Actor?.Attributes ?? {};
              const exit = attrs['exitCode'];
              handler({
                action: (raw.Action ?? '').split(':')[0] ?? '',
                containerId: raw.id ?? '',
                serverId: attrs[PANEL_LABEL] ?? '',
                exitCode: exit === undefined ? null : Number(exit),
                attributes: attrs,
              });
            } catch {
              /* unvollstaendige Zeile ignorieren */
            }
          }
        });

        stream.on('error', (err: Error) => {
          log.warn({ err }, 'Docker-Ereignisstrom abgebrochen');
          retry();
        });
        stream.on('end', () => {
          if (!stopped) retry();
        });

        log.info('Docker-Ereignisstrom verbunden');
      } catch (err) {
        log.error({ err }, 'Docker-Ereignisstrom konnte nicht geoeffnet werden');
        retry();
      }
    };

    const retry = () => {
      if (stopped) return;
      setTimeout(() => void connect(), 3000);
    };

    await connect();

    return () => {
      stopped = true;
      (current as { destroy?: () => void } | null)?.destroy?.();
    };
  }

  async waitForExit(containerId: string): Promise<number> {
    const result = await this.docker.getContainer(containerId).wait();
    return result.StatusCode as number;
  }
}

/**
 * Entfernt die 8-Byte-Rahmen, mit denen Docker stdout und stderr trennt,
 * wenn der Container ohne TTY laeuft.
 */
function stripFrames(chunk: Buffer): string {
  let out = '';
  let i = 0;
  while (i < chunk.length) {
    if (chunk.length - i >= 8 && (chunk[i] === 1 || chunk[i] === 2) &&
        chunk[i + 1] === 0 && chunk[i + 2] === 0 && chunk[i + 3] === 0) {
      const len = chunk.readUInt32BE(i + 4);
      out += chunk.subarray(i + 8, i + 8 + len).toString('utf8');
      i += 8 + len;
    } else {
      out += chunk.subarray(i).toString('utf8');
      break;
    }
  }
  return out;
}

export const engine: ContainerEngine = new LocalDockerEngine();
export { isWindows, volumeName, volumePath };
