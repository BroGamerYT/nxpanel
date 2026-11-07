import { sql } from '../db/index.js';
import { log } from '../log.js';
import { writeEvent } from '../events.js';
import type { ServerRecord } from '../types.js';
import { querySpec, rconCommand } from './status.js';
import { ADAPTERS } from './adapters.js';

/**
 * Zeitbanns aufheben. Laeuft jede Minute; ist der Server gerade aus,
 * wird es beim naechsten Durchlauf nach dem Start nachgeholt.
 */
export async function liftDueBans(): Promise<number> {
  const due = await sql<{ id: string; player: string; player_id: string | null; server_id: string }[]>`
    SELECT b.id, b.player, b.player_id, b.server_id FROM player_bans b JOIN servers s ON s.id = b.server_id
    WHERE b.lifted_at IS NULL AND b.until IS NOT NULL AND b.until <= now() AND s.status = 'running'`;
  let n = 0;
  for (const b of due) {
    const [server] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${b.server_id}`;
    const spec = server ? await querySpec(server.egg_id) : null;
    if (!server || !spec) continue;
    try {
      const adapter = spec.kind !== 'minecraft' ? ADAPTERS[spec.kind] : null;
      if (adapter && !b.player_id) continue;
      await rconCommand(server, spec, adapter ? adapter.command('pardon', b.player_id!) : `pardon ${b.player}`);
      await sql`UPDATE player_bans SET lifted_at = now() WHERE id = ${b.id}`;
      await writeEvent({ serverId: server.id, kind: 'player_unbanned', summary: `Zeitbann für ${b.player} abgelaufen – aufgehoben` });
      n++;
    } catch (err) {
      log.debug({ err, server: server.id }, 'Bann aufheben: RCON nicht erreichbar, naechster Versuch in einer Minute');
    }
  }
  return n;
}

let timer: NodeJS.Timeout | null = null;
export function startBanExpiry() {
  if (timer) return;
  timer = setInterval(() => { void liftDueBans().catch((err: unknown) => log.warn({ err }, 'Bann-Ablauf fehlgeschlagen')); }, 60_000);
  timer.unref();
}
export function stopBanExpiry() { if (timer) clearInterval(timer); timer = null; }
