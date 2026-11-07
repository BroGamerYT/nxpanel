import type { JSONValue, Sql, TransactionSql } from 'postgres';
import { sql } from './db/index.js';
import { log } from './log.js';

export interface AuditInput {
  userId?: string | null | undefined;
  serverId?: string | null | undefined;
  /** Name zum Zeitpunkt der Aktion - bleibt lesbar, auch wenn der Nutzer geloescht wird. */
  actorName?: string | null | undefined;
  action: string;
  metadata?: Record<string, unknown> | undefined;
  ip?: string | null | undefined;
}

/**
 * Wer hat wann was getan. Getrennt von events: events beschreiben, was mit
 * einem Server passiert ist (auch ohne Menschen), audit_log haelt fest,
 * welcher Mensch etwas ausgeloest hat - inklusive fehlgeschlagener Logins.
 *
 * Wie writeEvent: Fehler werden geloggt, aber nie geworfen - ausser die
 * Zeile wird innerhalb einer Transaktion geschrieben, dann soll sie mit
 * der Transaktion stehen oder fallen.
 */
export async function writeAudit(a: AuditInput, tx?: Sql | TransactionSql): Promise<void> {
  const db = (tx ?? sql) as Sql;
  const run = () => db`
    INSERT INTO audit_log (user_id, server_id, actor_name, action, metadata, ip)
    VALUES (${a.userId ?? null}, ${a.serverId ?? null}, ${a.actorName ?? null}, ${a.action},
            ${a.metadata ? sql.json(a.metadata as JSONValue) : null}, ${a.ip ?? null})
  `;
  if (tx) {
    await run();
    return;
  }
  try {
    await run();
  } catch (err) {
    log.error({ err, action: a.action }, 'Audit-Eintrag konnte nicht geschrieben werden');
  }
}
