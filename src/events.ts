import type { JSONValue } from 'postgres';
import { sql } from './db/index.js';
import { EventEmitter } from 'node:events';
import { log } from './log.js';

/**
 * Prozessinterner Verteiler: jede geschriebene Zeile der Zeitachse geht
 * auch hier hinaus. Die Live-Verbindungen der Oberflaeche haengen daran -
 * so sieht man einen Absturz sofort, ohne die Datenbank abzufragen.
 */
export interface LiveEvent {
  id: number;
  serverId: string | null;
  ts: Date;
  kind: string;
  severity: EventSeverity;
  summary: string;
  payload: Record<string, unknown> | null;
}
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(0);

export type EventSeverity = 'info' | 'warn' | 'error';

export interface EventInput {
  serverId?: string | null | undefined;
  kind: string;
  severity?: EventSeverity | undefined;
  actorId?: string | null | undefined;
  summary: string;
  code?: string | undefined;
  params?: Record<string, unknown> | undefined;
  payload?: Record<string, unknown> | undefined;
  logFile?: string | null | undefined;
  logOffset?: number | null | undefined;
}

/**
 * Jede Zustandsaenderung landet hier. Die Zeitachse im Panel liest spaeter
 * ausschliesslich aus dieser Tabelle - deshalb bekommt auch das, was NICHT
 * passiert ist, ein Ereignis (siehe restart_skipped).
 *
 * Fehler beim Schreiben duerfen den Betrieb nie aufhalten: ein verlorenes
 * Ereignis ist aergerlich, ein haengender Serverstart ist schlimmer.
 */
export async function writeEvent(e: EventInput): Promise<void> {
  try {
    const payload = {
      ...(e.payload ?? {}),
      ...(e.code ? { code: e.code } : {}),
      ...(e.params ? { params: e.params } : {}),
    };
    const hasPayload = Object.keys(payload).length > 0;

    const [row] = await sql<{ id: string; ts: Date }[]>`
      INSERT INTO events (server_id, kind, severity, actor_id, summary, payload, log_file, log_offset)
      VALUES (
        ${e.serverId ?? null}, ${e.kind}, ${e.severity ?? 'info'}, ${e.actorId ?? null},
        ${e.summary}, ${hasPayload ? sql.json(payload as JSONValue) : null},
        ${e.logFile ?? null}, ${e.logOffset ?? null}
      )
      RETURNING id, ts
    `;
    const live: LiveEvent = {
      id: Number(row!.id), serverId: e.serverId ?? null, ts: row!.ts, kind: e.kind,
      severity: e.severity ?? 'info', summary: e.summary, payload: hasPayload ? payload : null,
    };
    eventBus.emit('event', live);
  } catch (err) {
    log.error({ err, kind: e.kind }, 'Ereignis konnte nicht geschrieben werden');
  }
}
