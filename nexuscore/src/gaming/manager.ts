import { logger } from '../logger.js';
import type { HostDriver } from '../drivers/interface.js';
import type { PowerOps } from '../ops/power.js';
import type { EventBus } from '../protocol/events.js';
import type { ServerRegistry } from '../store/registry.js';

/**
 * Gaming-Modus: der Rechner gehoert fuer eine Weile dem Spiel am Rechner, nicht den Servern.
 *
 *  - `throttle`: laufende Instanzen bekommen niedrige Prioritaet (auch spaeter gestartete), Spieler merken nichts.
 *  - `stop`: Vorwarnung an die Spieler ueber die Serverkonsole, dann werden die Instanzen gestoppt; beim
 *    Beenden des Modus starten genau die wieder, die vorher liefen.
 */

export type GamingModeKind = 'throttle' | 'stop';

export interface GamingState {
  active: boolean;
  mode: GamingModeKind;
  /** warning = Vorwarnung laeuft, active = Modus gilt. */
  phase: 'off' | 'warning' | 'on';
  since: string | null;
  /** Bei "warning": wann die Instanzen gestoppt werden. */
  stopsAt: string | null;
  warnSeconds: number;
  /** Instanzen, auf die der Modus wirkt (gedrosselt oder gestoppt, beim Beenden wieder gestartet). */
  affected: string[];
}

export class GamingError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
    readonly code = 'invalid_state',
  ) {
    super(message);
    this.name = 'GamingError';
  }
}

const KEY = 'gaming_mode';
export const MAX_WARN_SECONDS = 300;
const OFF: GamingState = { active: false, mode: 'throttle', phase: 'off', since: null, stopsAt: null, warnSeconds: 0, affected: [] };

/** Eine Zeile fuer die Spielkonsole: ohne Zeilenumbrueche, Steuerzeichen und fuehrenden Schraegstrich (sonst ein Befehl). */
export function consoleMessage(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/^[\s/!.]+/, '').trim().slice(0, 200);
  return clean;
}

export interface GamingDeps {
  registry: ServerRegistry;
  driver: HostDriver;
  power: PowerOps;
  bus: EventBus;
  /** Ersetzbar fuer Tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    // Schon abgebrochen, bevor gewartet wird: nicht auf ein Signal warten, das nicht mehr kommt
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export class GamingMode {
  private abort: AbortController | null = null;
  private job: Promise<void> = Promise.resolve();
  private off: (() => void) | null = null;

  constructor(private readonly deps: GamingDeps) {}

  private get now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  state(): GamingState {
    const raw = this.deps.registry.getSetting<Partial<GamingState>>(KEY);
    if (!raw || raw.active !== true) return { ...OFF };
    return {
      active: true,
      mode: raw.mode === 'stop' ? 'stop' : 'throttle',
      phase: raw.phase === 'warning' ? 'warning' : 'on',
      since: raw.since ?? null,
      stopsAt: raw.stopsAt ?? null,
      warnSeconds: raw.warnSeconds ?? 0,
      affected: Array.isArray(raw.affected) ? raw.affected.filter((x): x is string => typeof x === 'string') : [],
    };
  }

  private save(state: GamingState): void {
    if (!state.active) this.deps.registry.deleteSetting(KEY);
    else this.deps.registry.setSetting(KEY, state);
  }

  /** Wartet auf einen laufenden Ablauf (Tests, Beenden). */
  async whenIdle(): Promise<void> {
    await this.job.catch(() => {});
  }

  /** Beginnt, auf neu gestartete Instanzen zu achten (im Modus "throttle" bekommen sie niedrige Prioritaet). */
  start(): void {
    if (this.off) return;
    this.off = this.deps.bus.on((event) => {
      if (event.type !== 'state' || event.state.status !== 'running') return;
      const s = this.state();
      if (!s.active || s.mode !== 'throttle') return;
      // Das Spiel braucht einen Moment, bis sein Prozessbaum steht
      setTimeout(() => {
        void this.deps.driver.setPriority?.(event.serverId, 'low').catch(() => {});
      }, 1500).unref();
    });
  }

  stop(): void {
    this.abort?.abort();
    this.off?.();
    this.off = null;
  }

  private async runningIds(): Promise<string[]> {
    const states = await this.deps.driver.listServers();
    const known = new Set(this.deps.registry.list().map((c) => c.id));
    return states.filter((s) => s.status === 'running' && known.has(s.id)).map((s) => s.id);
  }

  async activate(options: { mode: GamingModeKind; warnSeconds?: number; message?: string }): Promise<GamingState> {
    if (this.state().active) throw new GamingError('Der Gaming-Modus ist schon an.', 409, 'already_active');
    const warnSeconds = Math.min(MAX_WARN_SECONDS, Math.max(0, Math.floor(options.warnSeconds ?? 0)));
    const since = this.now;
    const ids = await this.runningIds();

    if (options.mode === 'throttle') {
      const done: string[] = [];
      for (const id of ids) {
        try {
          await this.deps.driver.setPriority?.(id, 'low');
          done.push(id);
        } catch (err) {
          logger.warn({ err, serverId: id }, 'Prioritaet konnte nicht gesenkt werden');
        }
      }
      const state: GamingState = { active: true, mode: 'throttle', phase: 'on', since: since.toISOString(), stopsAt: null, warnSeconds: 0, affected: done };
      this.save(state);
      this.deps.registry.audit('gaming.on', null, 'standalone', { mode: 'throttle', servers: done.length });
      return state;
    }

    const stopsAt = new Date(since.getTime() + warnSeconds * 1000);
    const state: GamingState = {
      active: true,
      mode: 'stop',
      phase: warnSeconds > 0 && ids.length > 0 ? 'warning' : 'on',
      since: since.toISOString(),
      stopsAt: warnSeconds > 0 ? stopsAt.toISOString() : null,
      warnSeconds,
      affected: ids,
    };
    this.save(state);
    this.deps.registry.audit('gaming.on', null, 'standalone', { mode: 'stop', servers: ids.length, warnSeconds });
    const ctl = new AbortController();
    this.abort = ctl;
    this.job = this.runStop(ids, warnSeconds, options.message, ctl.signal).catch((err) => {
      logger.error({ err }, 'Gaming-Modus: Stoppen fehlgeschlagen');
    });
    return state;
  }

  private async say(ids: string[], text: string): Promise<void> {
    const message = consoleMessage(text);
    if (!message) return;
    for (const id of ids) {
      try {
        await this.deps.driver.sendCommand?.(id, `say ${message}`);
      } catch {
        // Spiel ohne Konsole oder schon beendet - die Warnung ist ein Zusatz
      }
    }
  }

  private async runStop(ids: string[], warnSeconds: number, custom: string | undefined, signal: AbortSignal): Promise<void> {
    const inner = this.deps.sleep ?? realSleep;
    // Auch ein ersetzter Warte-Baustein darf nie auf ein schon abgebrochenes Signal warten
    const sleep = (ms: number, s: AbortSignal): Promise<void> => (s.aborted ? Promise.resolve() : inner(ms, s));
    if (signal.aborted) return;
    if (warnSeconds > 0 && ids.length > 0) {
      const text = custom ?? `Der Server wird in ${warnSeconds} Sekunden für ein anderes Spiel gestoppt und danach wieder gestartet.`;
      await this.say(ids, text);
      // Eine zweite, letzte Warnung 10 Sekunden vor dem Stopp
      if (warnSeconds > 20) {
        await sleep((warnSeconds - 10) * 1000, signal);
        if (signal.aborted) return;
        await this.say(ids, custom ?? 'Der Server wird in 10 Sekunden gestoppt.');
        await sleep(10_000, signal);
      } else {
        await sleep(warnSeconds * 1000, signal);
      }
      if (signal.aborted) return;
    }
    for (const id of ids) {
      if (signal.aborted) return;
      try {
        await this.deps.power.stop(id);
      } catch (err) {
        logger.warn({ err, serverId: id }, 'Gaming-Modus: Instanz liess sich nicht stoppen');
      }
    }
    const s = this.state();
    if (s.active) this.save({ ...s, phase: 'on', stopsAt: null });
  }

  async deactivate(): Promise<GamingState & { restarted: string[]; failed: string[] }> {
    const s = this.state();
    if (!s.active) throw new GamingError('Der Gaming-Modus ist nicht an.', 409, 'not_active');
    // Eine laufende Vorwarnung abbrechen: dann wird gar nichts gestoppt - und die Spieler erfahren es
    this.abort?.abort();
    await this.whenIdle();
    this.abort = null;
    if (s.mode === 'stop' && s.phase === 'warning') await this.say(s.affected, 'Entwarnung: Der Server bleibt online.');

    const restarted: string[] = [];
    const failed: string[] = [];
    if (s.mode === 'throttle') {
      for (const id of await this.runningIds()) await this.deps.driver.setPriority?.(id, 'normal').catch(() => 0);
    } else {
      for (const id of s.affected) {
        // Nur starten, was wirklich gestoppt wurde (war die Vorwarnung noch nicht um, lief es ja weiter)
        const state = await this.deps.driver.getServerState(id).catch(() => null);
        if (!state || state.status === 'running' || state.status === 'starting') continue;
        if (!this.deps.registry.get(id)) continue;
        try {
          await this.deps.power.start(id);
          restarted.push(id);
        } catch (err) {
          logger.warn({ err, serverId: id }, 'Gaming-Modus: Instanz liess sich nicht wieder starten');
          failed.push(id);
        }
      }
    }
    this.save({ ...OFF });
    this.deps.registry.audit('gaming.off', null, 'standalone', { mode: s.mode, restarted: restarted.length, failed: failed.length });
    return { ...OFF, restarted, failed };
  }
}
