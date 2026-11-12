import type { HostDriver } from '../drivers/interface.js';
import type { BackupManager } from '../backups/manager.js';
import type { InstallManager } from '../install/manager.js';
import { installSpecOf } from '../install/manager.js';
import { logger } from '../logger.js';
import type { EventBus } from '../protocol/events.js';
import type { ServerRegistry, TaskRecord } from '../store/registry.js';
import type { PowerOps } from './power.js';

/**
 * 1-Klick-Update eines Servers (wie im Panel):
 *  1. laeuft er, wird er geordnet gestoppt,
 *  2. optional ein Sicherheits-Backup - scheitert es, wird NICHT aktualisiert,
 *  3. Docker: neuestes Image holen; Spiele mit Installationsskript (SteamCMD) fuehren es erneut aus.
 *     Windows (direkte Prozesse): Installation noch einmal (SteamCMD "app_update" laedt nur Geaendertes),
 *  4. wieder starten, wenn er lief oder `startAfter` gilt.
 *
 * Welten und Einstellungen bleiben liegen. Der Fortschritt steht als Aufgabe (Balken der Oberflaeche) und in der Konsole.
 */

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'UpdateError';
  }
}

export interface UpdateOptions {
  backup: boolean;
  startAfter: boolean;
}

export interface GameUpdater {
  /** Prueft, ob ein Update jetzt geht, und startet es im Hintergrund. */
  start(serverId: string, options: UpdateOptions): Promise<TaskRecord>;
  isUpdating(serverId: string): boolean;
  whenIdle(serverId?: string): Promise<void>;
}

export function createGameUpdater(deps: {
  registry: ServerRegistry;
  driver: HostDriver;
  power: PowerOps;
  installs: InstallManager | null;
  backups: BackupManager;
  bus: EventBus;
}): GameUpdater {
  const { registry, driver, power, installs, backups, bus } = deps;
  const running = new Map<string, Promise<void>>();

  const say = (serverId: string, line: string, stream: 'stdout' | 'stderr' = 'stdout'): void =>
    bus.emit({ type: 'console', serverId, line: `[Update] ${line}`, stream, ts: new Date().toISOString() });

  async function stateOf(id: string) {
    try {
      return await driver.getServerState(id);
    } catch {
      return undefined;
    }
  }

  async function waitOffline(id: string, ms = 180_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = await stateOf(id);
      if (!s || s.status === 'offline' || s.status === 'error') return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Der Server hat nicht rechtzeitig gestoppt.');
  }

  async function run(serverId: string, options: UpdateOptions, wasRunning: boolean, taskId: string): Promise<void> {
    const step = (progress: number, message: string): void => {
      registry.updateTask(taskId, { status: 'running', progress, message });
      say(serverId, message);
    };
    try {
      const c = registry.get(serverId);
      if (!c) throw new Error('Server nicht gefunden.');

      if (wasRunning) {
        step(0.05, 'Server wird gestoppt');
        await power.stop(serverId);
        await waitOffline(serverId);
      }

      if (options.backup) {
        step(0.15, 'Sicherheits-Backup wird angelegt');
        const { done } = await backups.create(serverId, { name: 'Vor Server-Update', actor: 'core' });
        const result = await done;
        if (result.status !== 'completed') throw new Error(`Sicherheits-Backup fehlgeschlagen (${result.status}) - Update abgebrochen`);
      }

      if (driver.pullImage && c.container) {
        step(0.3, `Neuestes Image wird geholt (${c.container.image})`);
        // Ist der Server nicht erreichbar (kein Netz), gilt das vorhandene Image - wie im Panel
        await driver.pullImage(c.container.image, (line) => say(serverId, line)).catch((err: unknown) => {
          say(serverId, `Image konnte nicht geholt werden, das vorhandene wird benutzt: ${(err as Error).message}`, 'stderr');
        });
      }

      // Spiele mit Installation (Installationsskript, SteamCMD, Paper ...): erneut ausfuehren
      if (c.install && installs) {
        step(0.5, 'Spieldateien werden aktualisiert');
        await registry.update({ ...c, install: { ...c.install, state: 'installing' } });
        installs.start(serverId, installSpecOf(c.install));
        await installs.whenIdle(serverId);
        const after = registry.get(serverId);
        if (after?.install?.state !== 'done') throw new Error(`Aktualisierung fehlgeschlagen: ${after?.install?.error ?? 'unbekannter Fehler'}`);
      }

      if (options.startAfter || wasRunning) {
        step(0.95, 'Server wird gestartet');
        await power.start(serverId);
      }
      registry.updateTask(taskId, { status: 'done', progress: 1, message: 'Update abgeschlossen' });
      say(serverId, 'Update abgeschlossen');
      registry.audit('server.update_game_done', serverId, 'core', { backup: options.backup });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, serverId }, 'Update fehlgeschlagen');
      say(serverId, `Fehlgeschlagen: ${message}`, 'stderr');
      registry.updateTask(taskId, { status: 'failed', message });
      registry.audit('server.update_game_failed', serverId, 'core', { error: message.slice(0, 200) });
    }
  }

  return {
    isUpdating: (id) => running.has(id),

    async whenIdle(serverId) {
      if (serverId) await running.get(serverId)?.catch(() => {});
      else await Promise.allSettled([...running.values()]);
    },

    async start(serverId, options) {
      const c = registry.get(serverId);
      if (!c) throw new UpdateError('Server nicht gefunden', 404, 'not_found');
      if (running.has(serverId) || installs?.isInstalling(serverId) || c.install?.state === 'installing') {
        throw new UpdateError('Der Server wird gerade installiert oder aktualisiert.', 409, 'busy');
      }
      if (!c.container && !c.install) {
        throw new UpdateError('Dieser Server wurde nicht vom Core installiert - es gibt nichts zu aktualisieren.', 400, 'not_supported');
      }
      const state = await stateOf(serverId);
      if (state?.status === 'stopping' || state?.status === 'starting') {
        throw new UpdateError(`Update ist im Zustand "${state.status}" nicht möglich.`, 409, 'invalid_state');
      }
      const wasRunning = state?.status === 'running';
      const task = registry.createTask('update', serverId, 'Update wartet');
      const job = run(serverId, options, wasRunning, task.id).finally(() => running.delete(serverId));
      running.set(serverId, job);
      job.catch(() => {});
      return task;
    },
  };
}
