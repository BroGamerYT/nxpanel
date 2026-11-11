import path from 'node:path';
import type { HostDriver } from '../drivers/interface.js';
import { logger } from '../logger.js';
import type { EventBus } from '../protocol/events.js';
import type { ServerRegistry, TaskRecord } from '../store/registry.js';
import type { ServerInstanceConfig } from '../types.js';
import type { FetchLike } from './download.js';
import type { EnsureJavaOptions } from './java.js';
import { installMinecraftPaper } from './minecraft.js';

/**
 * Fuehrt Installationen als Aufgaben im Hintergrund aus (Block B2).
 *
 * Die Route antwortet sofort; der Fortschritt steht in der Aufgaben-Tabelle
 * (fuer den Balken der Oberflaeche) und als Zeilen in der Konsole der
 * Instanz. Erst nach erfolgreicher Installation wird die Instanz beim
 * Treiber angemeldet - vorher gibt es nichts, was er starten koennte.
 */

export interface InstallSpec {
  kind: 'minecraft-paper';
  variables: Record<string, string>;
  propertiesTemplate: Record<string, string>;
}

export interface InstallManagerOptions {
  /** Ordner fuer Laufzeiten des Cores (Java). */
  runtimesDir: string;
  fetchImpl?: FetchLike;
  extract?: EnsureJavaOptions['extract'];
}

/** Welche Installationsart zu einem Egg gehoert - null = der Core kann es (noch) nicht installieren. */
export function installKindFor(eggId: string, variables: Record<string, string>): InstallSpec['kind'] | null {
  if (eggId !== 'minecraft-paper') return null;
  const type = (variables.TYPE ?? 'PAPER').trim().toUpperCase();
  return type === 'PAPER' ? 'minecraft-paper' : null;
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
      const result = await installMinecraftPaper(
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

      const installed: ServerInstanceConfig = {
        ...config,
        executable: result.executable,
        args: result.args,
        stopCommand: result.stopCommand,
        stopTimeoutSeconds: 30,
        install: {
          state: 'done',
          kind: spec.kind,
          version: result.version,
          build: result.build,
          java: result.javaRelease,
          variables: spec.variables,
          propertiesTemplate: spec.propertiesTemplate,
        },
      };
      await this.registry.update(installed);
      // Nach einer Neuinstallation kennt der Treiber die Instanz schon.
      if (this.driver.updateServer) await this.driver.updateServer(installed);
      else await this.driver.registerServer(installed);

      this.registry.updateTask(taskId, {
        status: 'done',
        progress: 1,
        message: `Paper ${result.version} (Build ${result.build}) installiert`,
        result: { version: result.version, build: result.build, java: result.javaRelease },
      });
      this.registry.audit('server.install', serverId, 'core', {
        kind: spec.kind,
        version: result.version,
        build: result.build,
        java: result.javaRelease,
      });
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
