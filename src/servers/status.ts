import { sql } from '../db/index.js';
import { log } from '../log.js';
import { writeEvent } from '../events.js';
import type { ServerStatus } from '../types.js';

/**
 * Erlaubte Uebergaenge. Alles andere ist ein Fehler im Ablauf und wird
 * geloggt statt still durchgewunken - sonst steht irgendwann ein Server auf
 * "running", obwohl sein Container nie gestartet wurde.
 */
const allowed: Record<ServerStatus, ServerStatus[]> = {
  installing:     ['offline', 'install_failed', 'suspended'],
  install_failed: ['installing', 'suspended'],
  offline:        ['starting', 'running', 'installing', 'suspended'],
  starting:       ['running', 'offline', 'crashed', 'stopping'],
  running:        ['stopping', 'crashed', 'offline'],
  stopping:       ['offline', 'crashed'],
  crashed:        ['starting', 'running', 'offline', 'installing', 'suspended'],
  suspended:      ['offline'],
};

export interface TransitionOptions {
  reason?: string | undefined;
  actorId?: string | null | undefined;
  payload?: Record<string, unknown> | undefined;
}

/**
 * Der EINZIGE Weg, den Status eines Servers zu aendern.
 * Nie direkt per UPDATE - sonst fehlt das Ereignis in der Zeitachse.
 */
export async function setStatus(
  serverId: string,
  next: ServerStatus,
  opts: TransitionOptions = {},
): Promise<boolean> {
  const [row] = await sql<{ status: ServerStatus; name: string }[]>`
    SELECT status, name FROM servers WHERE id = ${serverId}
  `;

  if (!row) {
    log.warn({ serverId }, 'Statuswechsel fuer unbekannten Server');
    return false;
  }

  const current = row.status;
  if (current === next) return true;

  if (!allowed[current].includes(next)) {
    log.warn({ serverId, current, next }, 'Unzulaessiger Statuswechsel abgelehnt');
    return false;
  }

  await sql`UPDATE servers SET status = ${next} WHERE id = ${serverId}`;

  log.info({ serverId, name: row.name, from: current, to: next, reason: opts.reason }, 'Status');

  await writeEvent({
    serverId,
    kind: 'status_change',
    severity: next === 'crashed' || next === 'install_failed' ? 'error' : 'info',
    actorId: opts.actorId ?? null,
    summary: opts.reason ? `${current} → ${next}: ${opts.reason}` : `${current} → ${next}`,
    code: 'status_change',
    params: { from: current, to: next, reason: opts.reason ?? '' },
    payload: { from: current, to: next, reason: opts.reason, ...opts.payload },
  });

  // TODO Phase 4: hier zusaetzlich ueber WebSocket an die Oberflaeche melden.
  return true;
}

export async function getStatus(serverId: string): Promise<ServerStatus | null> {
  const [row] = await sql<{ status: ServerStatus }[]>`
    SELECT status FROM servers WHERE id = ${serverId}
  `;
  return row?.status ?? null;
}
