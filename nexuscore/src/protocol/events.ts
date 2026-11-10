import { EventEmitter } from 'node:events';
import type { CoreEvent, LogLine } from '../types.js';

const MAX_LOGS_PER_SERVER = 500;

/**
 * Der Event-Bus ist die einzige Wahrheit fuer alles, was passiert.
 *
 * Treiber melden Konsolenzeilen und Zustandswechsel hier, der HTTP-Layer
 * verteilt sie an die WebSocket-Clients. Dadurch muss der Treiber nichts
 * ueber WebSockets wissen - und der WebSocket-Layer muss keine Treiber kennen.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly logs = new Map<string, LogLine[]>();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: CoreEvent): void {
    if (event.type === 'console') {
      const list = this.logs.get(event.serverId) ?? [];
      list.push({
        serverId: event.serverId,
        line: event.line,
        stream: event.stream,
        ts: event.ts,
      });
      while (list.length > MAX_LOGS_PER_SERVER) list.shift();
      this.logs.set(event.serverId, list);
    }
    this.emitter.emit('event', event);
  }

  /** Abonniert alle Ereignisse. Die Rueckgabe meldet wieder ab. */
  on(handler: (event: CoreEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => {
      this.emitter.off('event', handler);
    };
  }

  /** Konsolenzeilen eines Servers aus dem Ringpuffer, juengste zuerst ausgegeben. */
  logsFor(serverId: string, limit = MAX_LOGS_PER_SERVER): LogLine[] {
    const list = this.logs.get(serverId) ?? [];
    return list.slice(-limit);
  }

  recent(limit = 100): CoreEvent[] {
    const all: CoreEvent[] = [];
    for (const list of this.logs.values()) {
      for (const entry of list) {
        all.push({
          type: 'console',
          serverId: entry.serverId,
          line: entry.line,
          stream: entry.stream,
          ts: entry.ts,
        });
      }
    }
    return all.slice(-limit);
  }
}

export const events = new EventBus();
