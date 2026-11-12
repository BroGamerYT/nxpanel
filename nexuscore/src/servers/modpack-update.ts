import type { BackupManager } from '../backups/manager.js';
import { clearPackCache } from '../games/modpacks.js';
import type { HostDriver } from '../drivers/interface.js';
import { logger } from '../logger.js';
import type { PowerOps } from '../ops/power.js';
import type { EventBus } from '../protocol/events.js';
import type { ServerRegistry } from '../store/registry.js';

/**
 * Modpack-Update mit einem Klick (wie im Panel):
 *   1. Server stoppen (falls er laeuft)
 *   2. Backup anlegen und abwarten - ohne fertiges Backup kein Update
 *   3. neue Version festsetzen (die Variable des Packs im Server)
 *   4. wieder starten, wenn er vorher lief
 * Das itzg-Image spielt die neue Pack-Version beim Start selbst ein; der Container wird bei jedem Start neu angelegt.
 */

export type UpdateStep = 'stopping' | 'backup' | 'updating' | 'starting' | 'done' | 'failed';
export interface UpdateState {
  step: UpdateStep;
  from: string | null;
  to: string;
  message?: string;
  backupId?: string;
  at: number;
}

export interface UpdateInput {
  serverId: string;
  versionVar: string;
  from: string | null;
  to: string;
  label: string;
  actor: string;
}

export interface ModpackUpdater {
  /** Laufender oder juengst beendeter Auftrag (Beendete verfallen nach 10 Minuten). */
  state(serverId: string): UpdateState | null;
  isUpdating(serverId: string): boolean;
  /** Startet im Hintergrund. Wirft, wenn schon eines laeuft. */
  start(input: UpdateInput): UpdateState;
  whenIdle(serverId?: string): Promise<void>;
}

export function createModpackUpdater(deps: {
  registry: ServerRegistry;
  driver: HostDriver;
  power: PowerOps;
  backups: BackupManager;
  bus: EventBus;
}): ModpackUpdater {
  const { registry, driver, power, backups, bus } = deps;
  const jobs = new Map<string, UpdateState>();
  const running = new Map<string, Promise<void>>();

  const say = (serverId: string, line: string, stream: 'stdout' | 'stderr' = 'stdout'): void =>
    bus.emit({ type: 'console', serverId, line: `[Modpack] ${line}`, stream, ts: new Date().toISOString() });

  const isUpdating = (id: string): boolean => {
    const s = jobs.get(id);
    return !!s && s.step !== 'done' && s.step !== 'failed';
  };

  async function statusOf(id: string): Promise<string> {
    try {
      return (await driver.getServerState(id)).status;
    } catch {
      return 'offline';
    }
  }

  async function waitOffline(id: string, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = await statusOf(id);
      if (s === 'offline' || s === 'error') return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  async function run(input: UpdateInput, state: UpdateState): Promise<void> {
    const { serverId } = input;
    const set = (step: UpdateStep, extra: Partial<UpdateState> = {}): void => {
      Object.assign(state, { step, at: Date.now(), ...extra });
    };
    const status = await statusOf(serverId);
    const wasRunning = status !== 'offline' && status !== 'error';
    try {
      registry.audit('modpack.update_start', serverId, 'core', { label: input.label, by: input.actor });
      say(serverId, `Update gestartet: ${input.label}`);
      if (wasRunning) {
        await power.stop(serverId);
        if (!(await waitOffline(serverId, 5 * 60_000))) throw new Error('Server ließ sich nicht stoppen');
      }

      set('backup');
      say(serverId, 'Backup wird angelegt');
      const { backup, done } = await backups.create(serverId, { name: `Vor Modpack-Update ${input.label}`.slice(0, 120), actor: 'core' });
      state.backupId = backup.id;
      const result = await done;
      if (result.status !== 'completed') throw new Error(`Backup nicht fertig (${result.status}) - Update abgebrochen, nichts geändert`);

      set('updating');
      const c = registry.get(serverId);
      if (!c) throw new Error('Server nicht gefunden');
      // Die Variable steht beim Docker-Server in der Umgebung, bei installierten Servern zusaetzlich in den Installationsvariablen
      const next = {
        ...c,
        env: { ...(c.env ?? {}), [input.versionVar]: input.to },
        ...(c.install ? { install: { ...c.install, variables: { ...(c.install.variables ?? {}), [input.versionVar]: input.to } } } : {}),
      };
      await registry.update(next);
      await driver.updateServer?.(next);
      clearPackCache();

      if (wasRunning) {
        set('starting');
        await power.start(serverId);
      }
      set('done', {
        message: wasRunning ? 'Aktualisiert und gestartet - der erste Start dauert, bis alle Mods geladen sind.' : 'Aktualisiert. Beim nächsten Start wird die neue Version eingespielt.',
      });
      say(serverId, `Modpack aktualisiert: ${input.label}`);
      registry.audit('modpack.update_done', serverId, 'core', { label: input.label });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, serverId }, 'Modpack-Update fehlgeschlagen');
      set('failed', { message });
      say(serverId, `Fehlgeschlagen: ${message}`, 'stderr');
      registry.audit('modpack.update_failed', serverId, 'core', { error: message.slice(0, 200) });
    }
  }

  return {
    state(serverId) {
      const s = jobs.get(serverId);
      if (s && (s.step === 'done' || s.step === 'failed') && Date.now() - s.at > 10 * 60_000) {
        jobs.delete(serverId);
        return null;
      }
      return s ?? null;
    },
    isUpdating,
    start(input) {
      if (isUpdating(input.serverId)) throw new Error('Für diesen Server läuft bereits ein Update');
      const state: UpdateState = { step: 'stopping', from: input.from, to: input.to, at: Date.now() };
      jobs.set(input.serverId, state);
      const job = run(input, state).finally(() => running.delete(input.serverId));
      running.set(input.serverId, job);
      job.catch(() => {});
      return state;
    },
    async whenIdle(serverId) {
      if (serverId) await running.get(serverId)?.catch(() => {});
      else await Promise.allSettled([...running.values()]);
    },
  };
}
