import { logger } from '../logger.js';
import type { HostDriver } from '../drivers/interface.js';
import type { EventBus } from '../protocol/events.js';

/**
 * TPS (Ticks pro Sekunde) und Tickzeit eines Minecraft-Servers - ohne RCON, ueber die Serverkonsole:
 *  - Paper: Befehl `tps` ("TPS from last 1m, 5m, 15m: 20.0, 20.0, 19.9") und `mspt`
 *  - Vanilla (ab 1.20.3): Befehl `tick query` ("Average time per tick: 3.4ms (Target: 50.0ms)")
 *
 * Die Antwort kommt als Konsolenzeile. Gelesen wird im Hintergrund und hoechstens einmal je Minute, damit die
 * Konsole nicht zugemuellt wird; die Oberflaeche bekommt immer den letzten bekannten Wert.
 */

export type TpsKind = 'paper' | 'vanilla';
export type TpsResult = { tps: number; mspt: number | null; source: string } | { error: string };

/** Farbcodes (§a, ANSI) und Zeilenreste entfernen. */
export function plainLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;]*m/g, '').replace(/§[0-9a-fk-or]/gi, '').replace(/\[\d{1,3}(?:;\d{1,3})*m/g, '').trim();
}

const NUMBER = String.raw`\*?(\d+(?:\.\d+)?)`;

/** Paper: der Wert der letzten Minute; Werte ueber 20 sind Messrauschen und werden gekappt. */
export function parseTps(raw: string): number | null {
  const m = new RegExp(String.raw`TPS from last 1m, 5m, 15m:\s*${NUMBER},\s*${NUMBER},\s*${NUMBER}`, 'i').exec(plainLine(raw));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? Math.min(20, v) : null;
}

/** Paper: mittlere Tickzeit der letzten 5 Sekunden ("avg/min/max"). */
export function parseMspt(raw: string): number | null {
  const m = /from last 5s, 10s, 1m:\s*(?:[^\d\s]\S*\s+)?(\d+(?:\.\d+)?)\/\d+(?:\.\d+)?\/\d+(?:\.\d+)?/i.exec(plainLine(raw));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** Vanilla: mittlere Tickzeit in Millisekunden. */
export function parseTickQuery(raw: string): number | null {
  const m = /Average (?:time per tick|tick time):\s*(\d+(?:\.\d+)?)\s*ms/i.exec(plainLine(raw));
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

interface Entry {
  value: TpsResult | null;
  at: number;
  inFlight: boolean;
}

export interface TpsReaderDeps {
  driver: HostDriver;
  bus: EventBus;
  /** Wie lange auf die Antwort gewartet wird. */
  timeoutMs?: number;
  /** Mindestabstand zwischen zwei Abfragen derselben Instanz. */
  ttlMs?: number;
  now?: () => number;
}

export class TpsReader {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: TpsReaderDeps) {}

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? 4000;
  }
  private get ttlMs(): number {
    return this.deps.ttlMs ?? 60_000;
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Der letzte bekannte Wert (oder null) - sofort. Ist er veraltet, wird im Hintergrund neu gefragt.
   */
  get(serverId: string, kind: TpsKind): TpsResult | null {
    const e = this.entries.get(serverId) ?? { value: null, at: 0, inFlight: false };
    this.entries.set(serverId, e);
    if (!e.inFlight && this.now() - e.at >= this.ttlMs) {
      e.inFlight = true;
      e.at = this.now();
      void this.refresh(serverId, kind)
        .then((value) => {
          e.value = value;
        })
        .catch((err) => logger.debug({ err, serverId }, 'TPS-Abfrage fehlgeschlagen'))
        .finally(() => {
          e.inFlight = false;
          e.at = this.now();
        });
    }
    return e.value;
  }

  /** Beim Stoppen eines Servers: alter Wert gilt nicht mehr. */
  forget(serverId: string): void {
    this.entries.delete(serverId);
  }

  /** Eine Abfrage jetzt: Befehl senden, auf die Konsolenzeile warten. */
  async refresh(serverId: string, kind: TpsKind): Promise<TpsResult> {
    const { driver, bus } = this.deps;
    if (!driver.sendCommand) return { error: 'Dieser Treiber nimmt keine Konsolenbefehle an.' };

    let tps: number | null = null;
    let mspt: number | null = null;
    let tickMs: number | null = null;
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve) => (done = resolve));

    const off = bus.on((event) => {
      if (event.type !== 'console' || event.serverId !== serverId) return;
      if (kind === 'paper') {
        const t = parseTps(event.line);
        if (t !== null) tps = t;
        const m = parseMspt(event.line);
        if (m !== null) mspt = m;
        if (tps !== null) done();
      } else {
        const m = parseTickQuery(event.line);
        if (m !== null) {
          tickMs = m;
          done();
        }
      }
    });

    const timer = setTimeout(done, this.timeoutMs);
    try {
      await driver.sendCommand(serverId, kind === 'paper' ? 'tps' : 'tick query');
      // Paper nennt die Tickzeit in einem eigenen Befehl - kurz hinterher fragen
      if (kind === 'paper') await driver.sendCommand(serverId, 'mspt').catch(() => {});
      await finished;
      if (kind === 'paper' && tps !== null && mspt === null) await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      off();
    }

    if (kind === 'paper') {
      return tps !== null ? { tps, mspt, source: 'Paper (tps)' } : { error: 'Keine Antwort auf den Befehl „tps“.' };
    }
    if (tickMs === null) return { error: 'Keine Antwort auf „tick query“ (braucht Minecraft ab 1.20.3).' };
    return { tps: tickMs > 0 ? Math.min(20, Math.round((1000 / tickMs) * 10) / 10) : 20, mspt: tickMs, source: 'Vanilla (tick query)' };
  }
}
