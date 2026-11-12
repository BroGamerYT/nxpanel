import { logger } from '../logger.js';
import type { EventBus } from '../protocol/events.js';
import type { ServerRegistry } from '../store/registry.js';
import { getServerMeta } from '../http/routes/settings.js';

/**
 * Automatischer Neustart nach einem Absturz (wie im Panel).
 *
 * Meldet der Treiber, dass ein Server in den Zustand "error" gegangen ist (unerwartet beendet oder nicht gestartet - ein
 * gewollter Stopp ergibt "offline"), startet der Core ihn nach kurzer Pause neu - wenn der Besitzer es fuer diesen Server
 * eingeschaltet hat. Damit eine Absturzschleife nicht ewig laeuft: nach MAX_CRASHES Abstuerzen innerhalb von WINDOW_MS bleibt
 * der Server aus ("nicht startbar"), bis jemand ihn von Hand startet.
 */

export const AUTO_RESTART_DELAY_MS = 5_000;
export const MAX_CRASHES = 5;
export const WINDOW_MS = 10 * 60_000;

export interface AutoRestartOptions {
  registry: ServerRegistry;
  bus: EventBus;
  start: (serverId: string) => Promise<unknown>;
  /** Ist der Server in dem Moment noch (oder wieder) im Zustand "error"? */
  isCrashed: (serverId: string) => Promise<boolean>;
  delayMs?: number;
  now?: () => number;
}

export class AutoRestart {
  private off: (() => void) | null = null;
  private readonly crashes = new Map<string, number[]>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly settled = new Set<Promise<void>>();

  constructor(private readonly o: AutoRestartOptions) {}

  start(): void {
    if (this.off) return;
    this.off = this.o.bus.on((e) => {
      if (e.type === 'state' && e.state.status === 'error') this.onCrash(e.serverId, e.state.exitCode);
    });
  }

  stop(): void {
    this.off?.();
    this.off = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** Fuer Tests: wartet, bis alle gerade laufenden Neustartversuche fertig sind. */
  async whenIdle(): Promise<void> {
    while (this.settled.size) await Promise.allSettled([...this.settled]);
  }

  private onCrash(serverId: string, exitCode: number | undefined): void {
    const { registry } = this.o;
    const config = registry.get(serverId);
    // Nicht fertig installiert: der Fehlerzustand gehoert zur Installation, nicht zu einem Absturz
    if (!config || (config.install && config.install.state !== 'done')) return;
    if (!getServerMeta(registry, serverId).autoRestart) return;
    if (this.pending.has(serverId)) return;

    const now = (this.o.now ?? Date.now)();
    const recent = [...(this.crashes.get(serverId) ?? []).filter((t) => now - t < WINDOW_MS), now];
    this.crashes.set(serverId, recent);
    registry.audit('server.crash', serverId, 'core', { exitCode: exitCode ?? null, crashes: recent.length, limit: MAX_CRASHES });

    if (recent.length > MAX_CRASHES) {
      registry.audit('server.crash_loop', serverId, 'core', { crashes: recent.length, windowMinutes: WINDOW_MS / 60_000 });
      logger.error({ serverId, crashes: recent.length }, 'Absturzschleife - kein automatischer Neustart mehr, bis der Server von Hand gestartet wird');
      this.crashes.delete(serverId);
      return;
    }

    const timer = setTimeout(() => {
      this.pending.delete(serverId);
      const run = (async () => {
        // Inzwischen gestartet, gestoppt oder geloescht: nichts tun
        if (!registry.get(serverId) || !getServerMeta(registry, serverId).autoRestart || !(await this.o.isCrashed(serverId))) return;
        registry.audit('server.auto_restart', serverId, 'core', { attempt: recent.length, limit: MAX_CRASHES });
        try {
          await this.o.start(serverId);
        } catch (err) {
          logger.warn({ err, serverId }, 'Automatischer Neustart fehlgeschlagen');
          registry.audit('server.auto_restart_failed', serverId, 'core', { error: err instanceof Error ? err.message : String(err) });
          // Der Zustand bleibt "error" und der Treiber meldet ihn deshalb nicht noch einmal: ein misslungener Start zaehlt selbst als Absturz
          this.onCrash(serverId, undefined);
        }
      })().finally(() => this.settled.delete(run));
      this.settled.add(run);
    }, this.o.delayMs ?? AUTO_RESTART_DELAY_MS);
    timer.unref();
    this.pending.set(serverId, timer);
  }
}
