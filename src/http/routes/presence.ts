import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { recordPresence, getActivePresences, getPresencesForServer } from '../../presence.js';
import { sql } from '../../db/index.js';

const pingBody = z.object({
  path: z.string().max(500).default('/'),
  serverId: z.string().uuid().optional(),
  locationLabel: z.string().max(100).optional(),
});

export async function presenceRoutes(app: FastifyInstance) {
  /**
   * Heartbeat-Ping aus dem Frontend: meldet, wo sich der angemeldete
   * Nutzer gerade im Panel aufhaelt.
   */
  app.post('/presence/ping', { preHandler: requireAuth }, async (req) => {
    const body = pingBody.parse(req.body ?? {});
    const actor = req.actor!;

    const [u] = await sql<{ avatar: string | null }[]>`SELECT avatar FROM users WHERE id = ${actor.id}`;

    const p = await recordPresence({
      userId: actor.id,
      username: actor.username,
      role: actor.role,
      avatar: u?.avatar ?? null,
      path: body.path,
      serverId: body.serverId,
      locationLabel: body.locationLabel,
      ip: req.ip,
    });

    return { ok: true, presence: p };
  });

  /**
   * Liste aller aktuell aktiven Benutzer im Panel.
   * Admins sehen alle; normale Nutzer sehen nur Nutzer auf geteilten Servern.
   */
  app.get('/presence', { preHandler: requireAuth }, async (req) => {
    const actor = req.actor!;
    const all = getActivePresences();

    if (actor.role === 'admin') {
      return { online: all, total: all.length };
    }

    // Fuer normale Nutzer: nur Server filtern, auf die man Zugriff hat
    const myServers = await sql<{ id: string }[]>`
      SELECT id FROM servers WHERE owner_id = ${actor.id}
      UNION
      SELECT server_id FROM subusers WHERE user_id = ${actor.id}
    `;
    const allowedServerIds = new Set(myServers.map((s) => s.id));

    const visible = all.filter((p) => p.serverId && allowedServerIds.has(p.serverId));
    return { online: visible, total: visible.length };
  });

  /** Wer betrachtet gerade diese Server-Instanz? */
  app.get<{ Params: { id: string } }>('/servers/:id/presence', { preHandler: requireAuth }, async (req) => {
    const serverId = req.params.id;
    const list = getPresencesForServer(serverId);
    return { users: list, count: list.length };
  });
}
