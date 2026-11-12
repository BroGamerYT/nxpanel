import path from 'node:path';
import type { HostDriver } from '../drivers/interface.js';
import { logger } from '../logger.js';
import type { EventBus } from '../protocol/events.js';
import type { ServerRegistry, TaskRecord } from '../store/registry.js';
import type { ServerInstallInfo, ServerInstanceConfig, SteamLaunch } from '../types.js';
import type { RawEggFile } from '../eggs/loader.js';
import type { FetchLike } from './download.js';
import type { EnsureJavaOptions } from './java.js';
import { installDownloadGame } from './download-game.js';
import { installMinecraft } from './minecraft.js';
import { isDownloadSource } from './sources.js';
import { installSteamGame } from './steam-game.js';
import { loadEggs } from '../eggs/loader.js';
import { substitute } from '../eggs/substitute.js';
import { ConfigError } from './config-error.js';
import type { SteamRunner } from './steamcmd.js';

/**
 * Fuehrt Installationen als Aufgaben im Hintergrund aus (Block B2).
 *
 * Die Route antwortet sofort; der Fortschritt steht in der Aufgaben-Tabelle
 * (fuer den Balken der Oberflaeche) und als Zeilen in der Konsole der
 * Instanz. Erst nach erfolgreicher Installation wird die Instanz beim
 * Treiber angemeldet - vorher gibt es nichts, was er starten koennte.
 */

export interface InstallSpec {
  kind: 'minecraft-paper' | 'minecraft-vanilla' | 'steamcmd' | 'download' | 'container';
  variables: Record<string, string>;
  propertiesTemplate: Record<string, string>;
  /** Nur bei kind = steamcmd oder download: App-ID bzw. Quelle, Programm, Argumente, Dateien. */
  steam?: SteamLaunch;
}

/** Die Angaben einer frueheren Installation - fuer Neuinstallation und Aenderung der Version. */
export function installSpecOf(info: ServerInstallInfo): InstallSpec {
  return {
    kind: info.kind,
    variables: info.variables ?? {},
    propertiesTemplate: info.propertiesTemplate ?? {},
    ...(info.steam ? { steam: info.steam } : {}),
  };
}

export interface InstallManagerOptions {
  /** Ordner fuer Laufzeiten des Cores (Java). */
  runtimesDir: string;
  fetchImpl?: FetchLike;
  extract?: EnsureJavaOptions['extract'];
  /** Nur fuer Tests: ersetzt SteamCMD. */
  steamRunner?: SteamRunner;
  steamExe?: string;
}

/** Welche Installationsart zu einem Egg gehoert - null = der Core kann es (noch) nicht installieren. */
export function installKindFor(eggId: string, variables: Record<string, string>): InstallSpec['kind'] | null {
  if (eggId !== 'minecraft-paper') return null;
  const type = (variables.TYPE ?? 'PAPER').trim().toUpperCase();
  if (type === 'PAPER') return 'minecraft-paper';
  return type === 'VANILLA' ? 'minecraft-vanilla' : null;
}

/**
 * Wie der Core ein Spiel installiert: Paper ueber seine eigene Logik, Spiele mit
 * `windows`-Block im Egg ueber SteamCMD. null = der Core kann es (noch) nicht.
 */
export function installPlanFor(
  eggId: string,
  raw: RawEggFile | undefined,
  variables: Record<string, string>,
): { kind: InstallSpec['kind']; steam?: SteamLaunch } | null {
  const paper = installKindFor(eggId, variables);
  if (paper) return { kind: paper };
  const w = raw?.windows;
  if (!w) return null;
  // Aus einem Archiv des Herstellers statt aus Steam - nur eine Quelle, die der Core selbst kennt
  if (w.download !== undefined) {
    if (!isDownloadSource(w.download.source)) return null;
    return {
      kind: 'download',
      steam: {
        download: { source: w.download.source, stripTop: w.download.stripTop, keep: w.download.keep, mkdirs: w.download.mkdirs },
        executable: w.executable,
        args: w.args ?? [],
        stopTimeoutSeconds: w.stop?.timeout_seconds,
        files: w.files,
      },
    };
  }
  if (!Number.isInteger(w.steam_app_id)) return null;
  return {
    kind: 'steamcmd',
    steam: {
      appId: w.steam_app_id,
      branch: w.branch,
      executable: w.executable,
      args: w.args ?? [],
      stopTimeoutSeconds: w.stop?.timeout_seconds,
      files: w.files,
    },
  };
}

/**
 * Docker-Treiber: hat das Egg ein Installationsskript, laeuft es in einem Installer-Container (wie im Panel).
 * Eggs ohne Skript (das Image richtet sich beim ersten Start selbst ein, z. B. Minecraft) brauchen keine Installation.
 */
export function containerInstallPlan(raw: RawEggFile | undefined): { kind: 'container' } | null {
  const script = raw?.scripts?.installation?.script;
  return typeof script === 'string' && script.trim() ? { kind: 'container' } : null;
}

interface InstallOutcome {
  executable: string;
  args: string[];
  stopCommand?: string;
  stopTimeoutSeconds: number;
  info: Partial<ServerInstallInfo>;
  message: string;
  result: Record<string, unknown>;
}

export class InstallManager {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: ServerRegistry,
    private readonly driver: HostDriver,
    private readonly bus: EventBus,
    private readonly options: InstallManagerOptions,
  ) {}

  isInstalling(serverId: string): boolean {
    return this.running.has(serverId);
  }

  /** Wartet auf das Ende einer laufenden Installation (fuer Tests und das Beenden). */
  async whenIdle(serverId?: string): Promise<void> {
    if (serverId) await this.running.get(serverId)?.catch(() => {});
    else await Promise.allSettled([...this.running.values()]);
  }

  /**
   * Startet die Installation einer bereits registrierten Instanz.
   *
   * @returns die angelegte Aufgabe
   */
  start(serverId: string, spec: InstallSpec): TaskRecord {
    const config = this.registry.get(serverId);
    if (!config) throw new Error(`Server "${serverId}" nicht gefunden.`);
    if (this.running.has(serverId)) throw new Error(`Server "${serverId}" wird bereits installiert.`);

    const task = this.registry.createTask('install', serverId, 'Installation wartet');
    const job = this.run(config, spec, task.id).finally(() => this.running.delete(serverId));
    this.running.set(serverId, job);
    // Fehler sind in run() behandelt - hier nur verhindern, dass Node einen
    // unbehandelten Abbruch meldet.
    job.catch(() => {});
    return task;
  }

  private say(serverId: string, line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.bus.emit({ type: 'console', serverId, line: `[Installation] ${line}`, stream, ts: new Date().toISOString() });
  }

  /** Installationsskript des Eggs im Installer-Container ausfuehren. */
  private async installContainer(config: ServerInstanceConfig, spec: InstallSpec, progress: (f: number, m: string) => void, serverId: string): Promise<InstallOutcome> {
    if (!this.driver.runInstaller) throw new ConfigError('Dieser Treiber kann keine Installer-Container starten.');
    const egg = (await loadEggs()).find((e) => e.id === config.game);
    const inst = egg?.raw.scripts?.installation;
    if (!egg || !inst?.script?.trim()) throw new ConfigError('Das Spiel hat kein Installationsskript.');
    const image = inst.container ?? config.container?.image;
    if (!image) throw new ConfigError('Das Spiel nennt kein Image für die Installation.');
    const refPorts = config.container?.refPorts ?? {};
    const port = Number(config.env?.SERVER_PORT) || config.ports[0]?.hostPort || 0;
    const ctx = { variables: spec.variables, ramMb: config.maxMemoryMb ?? 0, ip: '0.0.0.0', port, ports: refPorts, serverDir: '/mnt/server', serverName: config.name };
    // Variablen, die selbst Platzhalter enthalten, werden vorab aufgeloest (wie im Panel)
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(spec.variables).map(([k, v]) => [k, substitute(v, ctx)])),
      SERVER_MEMORY: String(config.maxMemoryMb ?? 0),
      SERVER_IP: '0.0.0.0',
      SERVER_PORT: String(port),
      SERVER_NAME: config.name,
    };
    let script = substitute(inst.script.replace(/\r\n?/g, '\n'), ctx);
    // Laeuft der Server spaeter als normaler Benutzer (run_as), bekommt er die Dateien, die der Installer als root anlegte
    const user = config.container?.user;
    if (user && /^\d+:\d+$/.test(user)) script = `trap 'chown -R ${user} /mnt/server 2>/dev/null || true' EXIT\n${script}`;
    const shell = /(?:^|\/)ash$/.test((inst.entrypoint ?? '').trim()) ? 'ash' : 'bash';

    progress(0.05, `Installationsskript läuft (${image})`);
    const started = Date.now();
    let lines = 0;
    const code = await this.driver.runInstaller({ serverId, image, shell, script, env, hostDir: config.workingDir }, (line) => {
      lines++;
      this.say(serverId, line);
      // Fortschritt ist unbekannt: langsam gegen 90 % kriechen, damit die Oberflaeche nicht stehen bleibt
      progress(Math.min(0.9, 0.05 + lines / 400), `Installationsskript läuft (${lines} Zeilen)`);
    });
    if (code !== 0) throw new Error(`Das Installationsskript endete mit Code ${code}.`);
    const seconds = Math.round((Date.now() - started) / 1000);
    return {
      executable: config.executable,
      args: config.args,
      stopTimeoutSeconds: config.stopTimeoutSeconds ?? 30,
      info: {},
      message: `Installation abgeschlossen (${seconds} s)`,
      result: { seconds, lines },
    };
  }

  private async installPaper(config: ServerInstanceConfig, spec: InstallSpec, progress: (f: number, m: string) => void): Promise<InstallOutcome> {
    const result = await installMinecraft(
      spec.kind === 'minecraft-vanilla' ? 'VANILLA' : 'PAPER',
      {
        serverDir: config.workingDir,
        runtimesDir: this.options.runtimesDir,
        variables: spec.variables,
        propertiesTemplate: spec.propertiesTemplate,
        ramMb: config.maxMemoryMb ?? 2048,
        port: config.ports[0]?.hostPort ?? 25565,
        serverName: config.name,
      },
      {
        onProgress: progress,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.extract ? { extract: this.options.extract } : {}),
      },
    );
    return {
      executable: result.executable,
      args: result.args,
      stopCommand: result.stopCommand,
      stopTimeoutSeconds: 30,
      info: { version: result.version, ...(result.build !== null ? { build: result.build } : {}), java: result.javaRelease },
      message: `${spec.kind === 'minecraft-vanilla' ? 'Vanilla' : 'Paper'} ${result.version}${result.build !== null ? ` (Build ${result.build})` : ''} installiert`,
      result: { version: result.version, build: result.build, java: result.javaRelease },
    };
  }

  private async installSteam(
    config: ServerInstanceConfig,
    spec: InstallSpec,
    progress: (f: number, m: string) => void,
    serverId: string,
  ): Promise<InstallOutcome> {
    if (!spec.steam) throw new Error('Für dieses Spiel fehlen die Windows-Angaben im Egg.');
    const result = await installSteamGame(
      {
        serverDir: config.workingDir,
        runtimesDir: this.options.runtimesDir,
        launch: spec.steam,
        variables: spec.variables,
        ports: config.ports,
        ramMb: config.maxMemoryMb ?? 2048,
        serverName: config.name,
      },
      {
        onProgress: progress,
        // SteamCMD ist gespraechig - nur in die Konsole der Instanz, nicht in den Aufgaben-Balken
        onLine: (line) => this.say(serverId, line),
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.steamRunner ? { runner: this.options.steamRunner } : {}),
        ...(this.options.steamExe ? { steamExe: this.options.steamExe } : {}),
      },
    );
    return {
      executable: result.executable,
      args: result.args,
      stopTimeoutSeconds: spec.steam.stopTimeoutSeconds ?? 60,
      info: { ...(result.buildId ? { version: result.buildId } : {}) },
      message: `Spiel installiert${result.buildId ? ` (Build ${result.buildId})` : ''}`,
      result: { appId: spec.steam.appId ?? null, ...(result.buildId ? { build: result.buildId } : {}) },
    };
  }

  private async installDownload(
    config: ServerInstanceConfig,
    spec: InstallSpec,
    progress: (f: number, m: string) => void,
    serverId: string,
  ): Promise<InstallOutcome> {
    if (!spec.steam?.download) throw new Error('Für dieses Spiel fehlen die Download-Angaben im Egg.');
    const result = await installDownloadGame(
      {
        serverDir: config.workingDir,
        runtimesDir: this.options.runtimesDir,
        launch: spec.steam,
        variables: spec.variables,
        ports: config.ports,
        ramMb: config.maxMemoryMb ?? 2048,
        serverName: config.name,
      },
      {
        onProgress: progress,
        onLine: (line) => this.say(serverId, line),
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      },
    );
    return {
      executable: result.executable,
      args: result.args,
      stopTimeoutSeconds: spec.steam.stopTimeoutSeconds ?? 30,
      info: { version: result.version },
      message: `Spiel installiert (Version ${result.version})`,
      result: { source: spec.steam.download.source, version: result.version, sha256: result.sha256 },
    };
  }

  private async run(config: ServerInstanceConfig, spec: InstallSpec, taskId: string): Promise<void> {
    const serverId = config.id;
    let lastWrite = 0;
    let lastFraction = -1;
    let lastSpoken = '';

    const progress = (fraction: number, message: string): void => {
      // Die Datenbank nicht mit jedem Netzwerkpaket beschreiben.
      const now = Date.now();
      if (fraction >= 1 || now - lastWrite >= 400 || fraction - lastFraction >= 0.02) {
        lastWrite = now;
        lastFraction = fraction;
        this.registry.updateTask(taskId, { status: 'running', progress: fraction, message });
      }
      // In der Konsole nur Schritte, keine Megabyte-Zaehler: "Lade Paper: 12 von 55 MB" -> "Lade Paper".
      const spoken = message.replace(/:\s*\d+ von \d+ MB$/, '');
      if (spoken !== lastSpoken) {
        lastSpoken = spoken;
        this.say(serverId, message);
      }
    };

    try {
      this.registry.updateTask(taskId, { status: 'running', message: 'Installation startet' });
      const outcome =
        spec.kind === 'steamcmd'
          ? await this.installSteam(config, spec, progress, serverId)
          : spec.kind === 'download'
            ? await this.installDownload(config, spec, progress, serverId)
            : spec.kind === 'container'
              ? await this.installContainer(config, spec, progress, serverId)
              : await this.installPaper(config, spec, progress);

      const installed: ServerInstanceConfig = {
        ...config,
        executable: outcome.executable,
        args: outcome.args,
        ...(outcome.stopCommand ? { stopCommand: outcome.stopCommand } : {}),
        stopTimeoutSeconds: outcome.stopTimeoutSeconds,
        install: {
          state: 'done',
          kind: spec.kind,
          ...outcome.info,
          variables: spec.variables,
          propertiesTemplate: spec.propertiesTemplate,
          ...(spec.steam ? { steam: spec.steam } : {}),
        },
      };
      await this.registry.update(installed);
      // Nach einer Neuinstallation kennt der Treiber die Instanz schon.
      if (this.driver.updateServer) await this.driver.updateServer(installed);
      else await this.driver.registerServer(installed);

      this.registry.updateTask(taskId, {
        status: 'done',
        progress: 1,
        message: outcome.message,
        result: outcome.result,
      });
      this.registry.audit('server.install', serverId, 'core', { kind: spec.kind, ...outcome.result });
      this.bus.emit({ type: 'state', serverId, state: { id: serverId, status: 'offline' }, ts: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, serverId }, 'Installation fehlgeschlagen');
      this.say(serverId, `Fehlgeschlagen: ${message}`, 'stderr');

      const current = this.registry.get(serverId);
      if (current) {
        await this.registry
          .update({
            ...current,
            install: {
              state: 'failed',
              kind: spec.kind,
              error: message,
              variables: spec.variables,
              propertiesTemplate: spec.propertiesTemplate,
              ...(spec.steam ? { steam: spec.steam } : {}),
            },
          })
          .catch(() => {});
      }
      this.registry.updateTask(taskId, { status: 'failed', message });
      this.registry.audit('server.install_failed', serverId, 'core', { kind: spec.kind, error: message });
      this.bus.emit({ type: 'state', serverId, state: { id: serverId, status: 'error' }, ts: new Date().toISOString() });
    }
  }
}

/** Ordner fuer Laufzeiten des Cores: neben dem Server-Verzeichnis, nicht darin. */
export function runtimesDirFor(dataDir: string): string {
  return path.resolve(dataDir, 'runtimes');
}
