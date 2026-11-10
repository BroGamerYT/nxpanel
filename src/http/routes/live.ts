import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { eventBus, type LiveEvent } from '../../events.js';
import { loadAuthContext } from '../../auth/users.js';
import { requireAuth } from '../auth.js';
import { listServersForActor } from '../../servers/access.js';

/**
 * Panelweiter Live-Strom über WebSocket.
 *
 * Anders als der Konsolen-Strom je Server (`servers/:id/ws`) hängt dieser
 * an einem einzigen Verteiler und meldet Ereignisse ALLER Server. Die
 * Serverliste muss dadurch nicht alle 5 s nachfragen, sondern bekommt
 * Statuswechsel sofort mit. Die Oberfläche invalidiert bei Eingang die
 * React-Query-Caches – so bleibt das Polling als Sicherheitsnetz, aber
 * deutlich seltener.
 *
 * Anmeldung wie bei der Konsole: mit dem normalen Token ein Einmal-Ticket
 * holen (60 s), dann damit den WebSocket öffnen. Der Zugangstoken selbst
 * landet nie in einer URL.
 */
interface Ticket { userId: string; sessionId: string; expires: number }
const tickets = new Map<string, Ticket>();
const TICKET_TTL_MS = 60_000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
}

export async function liveRoutes(app: FastifyInstance) {
  /** Einmal-Ticket für den globalen Live-Strom. */
  app.post('/live/ws-ticket', { preHandler: requireAuth }, async (req) => {
    sweep();
    const ticket = randomBytes(24).toString('base64url');
    tickets.set(ticket, {
      userId: req.actor!.id,
      sessionId: req.actor!.sessionId,
      expires: Date.now() + TICKET_TTL_MS,
    });
    return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
  });

  /** Der panelweite Live-Strom. Meldet Ereignisse aller Server. */
  app.get<{ Querystring: { ticket?: string } }>('/live/ws', { websocket: true }, async (socket, req) => {
    const send = (m: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const fail = (code: number, message: string) => {
      send({ type: 'error', message });
      socket.close(code, message.slice(0, 120));
    };

    const t = req.query.ticket ? tickets.get(req.query.ticket) : undefined;
    if (req.query.ticket) tickets.delete(req.query.ticket);
    if (!t || t.expires < Date.now()) return fail(4401, 'Ticket ungueltig oder abgelaufen');

    const actor = await loadAuthContext(t.userId, t.sessionId);
    if (!actor) return fail(4401, 'Sitzung beendet');

    send({ type: 'hello' });

    // Nur Ereignisse von Servern, die dieser Nutzer sehen darf. Ohne Filter
    // bekam jeder angemeldete Nutzer Namen und Meldungen ALLER Server.
    const visibleIds = async (a: NonNullable<typeof actor>) =>
      new Set((await listServersForActor(a)).map((s) => s.id));
    let visible = await visibleIds(actor);

    const onEvent = (e: LiveEvent) => {
      // Panelweite Meldungen (ohne Server) nur fuer Admins/Moderatoren
      if (e.serverId ? !visible.has(e.serverId) : actor.role === 'user') return;
      send({
        type: 'event',
        event: {
          id: e.id,
          serverId: e.serverId,
          kind: e.kind,
          severity: e.severity,
          summary: e.summary,
          ts: e.ts,
        },
      });
    };
    eventBus.on('event', onEvent);

    // Rechte periodisch nachprüfen: ein Rechteentzug beendet auch offene Verbindungen.
    const recheck = setInterval(async () => {
      const fresh = await loadAuthContext(t.userId, t.sessionId);
      if (!fresh) { socket.close(4401, 'Sitzung beendet'); return; }
      visible = await visibleIds(fresh).catch(() => visible);
    }, 30_000);

    socket.on('close', () => {
      eventBus.off('event', onEvent);
      clearInterval(recheck);
    });
  });
}