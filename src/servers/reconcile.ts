import { sql } from '../db/index.js';
import { engine } from '../docker/client.js';
import { log } from '../log.js';
import { setStatus } from './status.js';
import { activeTransitions } from './lifecycle.js';
import type { ServerRecord, ServerStatus } from '../types.js';

/**
 * Beim Start des Panels: was die Datenbank glaubt, mit dem abgleichen, was
 * auf dem Host tatsaechlich laeuft.
 *
 * Ohne diesen Schritt zeigt das Panel nach jedem Neustart falsche Zustaende -
 * Server stehen auf "running", obwohl der Host zwischendurch neu gestartet
 * wurde und kein Container mehr laeuft.
 */
export async function reconcile(): Promise<void> {
  const servers = await sql<ServerRecord[]>`
    SELECT * FROM servers WHERE status <> 'installing'
  `;

  if (servers.length === 0) {
    log.info('Abgleich: keine Server angelegt');
    return;
  }

  const containers = await engine.listPanelContainers();
  const byServerId = new Map(containers.map((c) => [c.serverId, c]));

  let corrected = 0;

  for (const server of servers) {
    const container = byServerId.get(server.id);

    if (!container) {
      // Kein Container mehr da - etwa nach einem docker system prune.
      if (server.status !== 'offline' && server.status !== 'suspended') {
        await setStatus(server.id, 'offline', { reason: 'Abgleich: kein Container gefunden' });
        corrected++;
      }
      if (server.container_id) {
        await sql`UPDATE servers SET container_id = NULL WHERE id = ${server.id}`;
      }
      continue;
    }

    // Container-ID in der Datenbank nachziehen, falls sie abweicht.
    if (server.container_id !== container.id) {
      await sql`UPDATE servers SET container_id = ${container.id} WHERE id = ${server.id}`;
    }

    const actual: ServerStatus = container.state === 'running' ? 'running' : 'offline';

    // Ein abgestuerzter Server, dessen Container steht, IST abgestuerzt -
    // nicht einfach offline. Den Unterschied zu verwischen versteckt genau
    // die Information, die man beim Nachsehen braucht.
    if (server.status === 'crashed' && actual === 'offline') continue;

    // Waehrend das Panel selbst aktiv startet, stoppt oder installiert, nicht
    // dazwischenfunken. Ist kein Start/Stopp im laufenden Panel-Prozess aktiv
    // (z. B. nach einem Panel-Neustart waehrend des Starts), Status sofort nachziehen!
    if (server.status === 'installing') continue;
    if ((server.status === 'starting' || server.status === 'stopping') && activeTransitions.has(server.id)) continue;

    if (server.status !== actual && server.status !== 'suspended') {
      await setStatus(server.id, actual, { reason: `Abgleich: Container ist ${container.state}` });
      corrected++;
    }

    // Bei laufenden Containern die exakte Startzeit aus Docker abgleichen
    if (actual === 'running') {
      try {
        const inspect = await engine.inspect(container.id);
        if (inspect?.startedAt) {
          const startedAt = new Date(inspect.startedAt);
          await sql`UPDATE servers SET started_at = ${startedAt} WHERE id = ${server.id} AND (started_at IS NULL OR started_at > ${startedAt})`;
        }
      } catch {}
    }

  }

  log.info(
    { servers: servers.length, container: containers.length, korrigiert: corrected },
    'Abgleich abgeschlossen',
  );
}
