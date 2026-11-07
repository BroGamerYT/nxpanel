import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { canGrant, PRESETS, isServerFlag, SERVER_FLAGS, FLAG_LABELS, type PresetName } from '../../auth/permissions.js';
import { findUserForLogin } from '../../auth/users.js';
import { writeAudit } from '../../audit.js';
import { HttpError, requireServer } from '../auth.js';

/**
 * Mitnutzer eines Servers. Rechte entweder als Preset oder als einzelne
 * Flags - genau "Preset waehlen, dann Haken setzen oder wegnehmen".
 * Einladung per E-Mail an noch nicht registrierte Personen kommt in Phase 6;
 * bis dahin muss das Konto schon existieren.
 */
const presetNames = Object.keys(PRESETS) as [PresetName, ...PresetName[]];

export const flagsInput = z.object({
  preset: z.enum(presetNames).optional(),
  permissions: z.array(z.string().max(64)).max(64).optional(),
}).refine((b) => b.preset || b.permissions, 'preset oder permissions angeben');

export const addBody = z.object({ user: z.string().min(1).max(254) }).and(flagsInput);

function resolveFlags(b: { preset?: PresetName | undefined; permissions?: string[] | undefined }): string[] {
  // Preset als Grundlage, permissions ersetzen es vollstaendig, wenn angegeben.
  const flags = b.permissions ?? [...PRESETS[b.preset!].flags];
  const unknown = flags.filter((f) => !isServerFlag(f));
  if (unknown.length) throw new HttpError(400, `Unbekannte Rechte: ${unknown.join(', ')}`, 'invalid_input');
  return [...new Set(flags)];
}

export async function subuserRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/servers/:id/subusers/permissions', { preHandler: requireServer('subuser.read') }, async () => {
    return {
      flags: SERVER_FLAGS,
      labels: FLAG_LABELS,
      presets: PRESETS,
    };
  });

  app.get<{ Params: { id: string } }>('/servers/:id/subusers', { preHandler: requireServer('subuser.read') }, async (req) => {
    const rows = await sql<{ user_id: string; username: string; email: string; permissions: string[]; created_at: Date }[]>`
      SELECT su.user_id, u.username, u.email, su.permissions, su.created_at
      FROM subusers su JOIN users u ON u.id = su.user_id
      WHERE su.server_id = ${req.target!.server.id} ORDER BY u.username`;
    return { subusers: rows.map((r) => ({ userId: r.user_id, username: r.username, email: r.email, permissions: r.permissions, since: r.created_at })) };
  });

  app.post<{ Params: { id: string } }>('/servers/:id/subusers', { preHandler: requireServer('subuser.create') }, async (req, reply) => {
    const body = addBody.parse(req.body);
    const { server, access } = req.target!;
    const actor = req.actor!;
    const flags = resolveFlags(body);
    const grant = canGrant(actor, access, flags);
    if (!grant.ok) throw new HttpError(403, `Diese Rechte hast du selbst nicht: ${grant.denied.join(', ')}`, 'forbidden');

    const target = await findUserForLogin(body.user);
    if (!target) throw new HttpError(404, 'Kein Konto mit diesem Namen oder dieser E-Mail', 'user_not_found');
    if (target.id === server.owner_id) throw new HttpError(400, 'Der Besitzer hat schon alle Rechte', 'invalid_input');
    const [exists] = await sql`SELECT 1 FROM subusers WHERE server_id = ${server.id} AND user_id = ${target.id}`;
    if (exists) throw new HttpError(409, 'Ist schon Mitnutzer - Rechte stattdessen aendern', 'conflict');

    await sql`INSERT INTO subusers (server_id, user_id, permissions, invited_by)
              VALUES (${server.id}, ${target.id}, ${flags}, ${actor.id})`;
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'subuser.create', ip: req.ip,
      metadata: { user: target.username, permissions: flags } });
    reply.code(201);
    return { userId: target.id, username: target.username, permissions: flags };
  });

  app.patch<{ Params: { id: string; userId: string } }>('/servers/:id/subusers/:userId', { preHandler: requireServer('subuser.update') }, async (req) => {
    const body = flagsInput.parse(req.body);
    const { server, access } = req.target!;
    const actor = req.actor!;
    if (req.params.userId === actor.id) throw new HttpError(403, 'Eigene Rechte kann man nicht aendern', 'forbidden');
    const [current] = await sql<{ permissions: string[] }[]>`
      SELECT permissions FROM subusers WHERE server_id = ${server.id} AND user_id = ${req.params.userId}`;
    if (!current) throw new HttpError(404, 'Mitnutzer nicht gefunden', 'not_found');

    const flags = resolveFlags(body);
    // Auch was WEGGENOMMEN wird, muss man selbst haben - sonst koennte ein
    // Operator einem Co-Admin Rechte entziehen, die er gar nicht ueberblickt.
    const touched = [...new Set([...flags, ...current.permissions])].filter((f) => flags.includes(f) !== current.permissions.includes(f));
    const grant = canGrant(actor, access, touched);
    if (!grant.ok) throw new HttpError(403, `Diese Rechte hast du selbst nicht: ${grant.denied.join(', ')}`, 'forbidden');

    await sql`UPDATE subusers SET permissions = ${flags} WHERE server_id = ${server.id} AND user_id = ${req.params.userId}`;
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'subuser.update', ip: req.ip,
      metadata: { userId: req.params.userId, from: current.permissions, to: flags } });
    return { permissions: flags };
  });

  /** Entfernen - oder selbst austreten (dafuer braucht man kein Recht). */
  app.delete<{ Params: { id: string; userId: string } }>('/servers/:id/subusers/:userId', { preHandler: requireServer() }, async (req) => {
    const { server, access } = req.target!;
    const actor = req.actor!;
    const self = req.params.userId === actor.id;
    if (!self && !canGrant(actor, access, ['subuser.delete']).ok) {
      throw new HttpError(403, 'Fehlendes Recht: subuser.delete', 'forbidden');
    }
    const removed = await sql`DELETE FROM subusers WHERE server_id = ${server.id} AND user_id = ${req.params.userId} RETURNING user_id`;
    if (!removed.length) throw new HttpError(404, 'Mitnutzer nicht gefunden', 'not_found');
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: self ? 'subuser.leave' : 'subuser.delete', ip: req.ip,
      metadata: { userId: req.params.userId } });
    return { ok: true };
  });
}
