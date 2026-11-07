import { sql } from '../db/index.js';
import { log } from '../log.js';
import type { ContainerStats } from '../docker/client.js';

/**
 * Laufende Auslastung aller Server an einem Ort.
 *
 * Fuer die Gesamtlast im Dashboard braucht es die Werte aller laufenden
 * Container gleichzeitig - einzeln abfragen dauert pro Container rund eine
 * Sekunde. Deshalb haelt der Sammler je laufendem Container einen
 * Docker-Statistik-Strom offen und merkt sich den letzten Wert. Aus zwei
 * Werten ergibt sich auch die Netzwerk-Rate (Bytes pro Sekunde).
 */
export interface LiveStats {
  cpuPercent: number;
  memMb: number;
  memLimitMb: number;
  /** Empfangen / gesendet in Bytes pro Sekunde, gemittelt ueber die letzten Sekunden. */
  rxRate: number;
  txRate: number;
  at: number;
}

export interface StatsSource {
  snapshot(): Map<string, LiveStats>;
  /** Verlauf der letzten Stunde (alle 10 s ein Punkt), leer fuer unbekannte Server. */
  history?(serverId: string): HistoryPoint[];
}

export interface HistoryPoint { t: number; cpu: number; mem: number; rx: number; tx: number }
const HISTORY_STEP_MS = 10_000;
const HISTORY_POINTS = 360;

type Streamer = (containerId: string, onStats: (s: ContainerStats) => void) => Promise<() => void>;

interface Entry {
  containerId: string;
  stop: (() => void) | null;
  last: LiveStats | null;
  prev: { rx: number; tx: number; at: number } | null;
}

export class StatsCollector implements StatsSource {
  private entries = new Map<string, Entry>();
  /** Bleibt auch nach dem Stoppen erhalten - so sieht man, was vor einem Absturz los war. */
  private hist = new Map<string, HistoryPoint[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly stream: Streamer, private readonly intervalMs = 10_000) {}

  start() {
    if (this.timer) return;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const e of this.entries.values()) e.stop?.();
    this.entries.clear();
  }

  /** Neue laufende Container anmelden, gestoppte abmelden. */
  async sync() {
    try {
      const rows = await sql<{ id: string; container_id: string }[]>`
        SELECT id, container_id FROM servers
        WHERE status IN ('running', 'starting', 'stopping') AND container_id IS NOT NULL`;
      const want = new Map(rows.map((r) => [r.id, r.container_id]));
      for (const [id, e] of this.entries) {
        if (want.get(id) !== e.containerId) { e.stop?.(); this.entries.delete(id); }
      }
      for (const [id, cid] of want) {
        if (this.entries.has(id)) continue;
        const entry: Entry = { containerId: cid, stop: null, last: null, prev: null };
        this.entries.set(id, entry);
        this.stream(cid, (s) => this.update(entry, s, id))
          .then((stop) => { if (this.entries.get(id) === entry) entry.stop = stop; else stop(); })
          .catch((err: unknown) => { log.debug({ err, id }, 'Statistik-Strom nicht moeglich'); this.entries.delete(id); });
      }
    } catch (err) {
      log.warn({ err }, 'Statistik-Abgleich fehlgeschlagen');
    }
  }

  private update(e: Entry, s: ContainerStats, serverId?: string) {
    const now = Date.now();
    let rxRate = e.last?.rxRate ?? 0;
    let txRate = e.last?.txRate ?? 0;
    // Rate ueber mindestens 3 s - einzelne Docker-Werte schwanken stark.
    if (!e.prev) e.prev = { rx: s.netRxBytes, tx: s.netTxBytes, at: now };
    else if (now - e.prev.at >= 3000) {
      const dt = (now - e.prev.at) / 1000;
      // Zaehler kann beim Neustart des Containers zuruecksetzen.
      rxRate = s.netRxBytes >= e.prev.rx ? (s.netRxBytes - e.prev.rx) / dt : 0;
      txRate = s.netTxBytes >= e.prev.tx ? (s.netTxBytes - e.prev.tx) / dt : 0;
      e.prev = { rx: s.netRxBytes, tx: s.netTxBytes, at: now };
    }
    e.last = { cpuPercent: s.cpuPercent, memMb: s.memMb, memLimitMb: s.memLimitMb, rxRate: Math.round(rxRate), txRate: Math.round(txRate), at: now };
    if (serverId) {
      const h = this.hist.get(serverId) ?? [];
      if (!h.length || now - h[h.length - 1]!.t >= HISTORY_STEP_MS) {
        h.push({ t: now, cpu: e.last.cpuPercent, mem: e.last.memMb, rx: e.last.rxRate, tx: e.last.txRate });
        if (h.length > HISTORY_POINTS) h.splice(0, h.length - HISTORY_POINTS);
        this.hist.set(serverId, h);
      }
    }
  }

  history(serverId: string): HistoryPoint[] {
    const since = Date.now() - HISTORY_POINTS * HISTORY_STEP_MS;
    return (this.hist.get(serverId) ?? []).filter((p) => p.t >= since);
  }

  snapshot(): Map<string, LiveStats> {
    const out = new Map<string, LiveStats>();
    const fresh = Date.now() - 15_000;
    for (const [id, e] of this.entries) if (e.last && e.last.at > fresh) out.set(id, e.last);
    return out;
  }
}

/** Ohne Docker (Tests, Entwicklung): leer. */
export const emptyStats: StatsSource = { snapshot: () => new Map() };
