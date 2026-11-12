import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { canGrant, FLAG_LABELS, isServerFlag, PRESETS, SERVER_FLAGS, type PresetName } from '../../auth/permissions.js';
import type { LocalAccount } from '../../store/account.js';
import { getAccess, setSubuserFlags } from '../../store/access.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';
import { accessFor } from '../authz.js';

/**
 * Mitnutzer eines Servers - dieselben Routen und Antworten wie im Panel. Rechte entweder als Vorlage (Preset) oder als
 * einzelne Haken; man kann nur Rechte vergeben, die man selbst hat - und auch nur wegnehmen, die man selbst hat.
 * Das Konto muss schon existieren (Einladung per E-Mail gibt es nicht).
 *
 * Wer darf diese Routen aufrufen, steht in authz.ts (subuser.read/create/update; Entfernen und Austreten prueft die Route selbst).
 */

const presetNames = Object.keys(PRESETS) as [PresetName, ...PresetName[]];

const flagsInput = z
  .object({
    preset: z.enum(presetNames).optional(),
    permissions: z.array(z.string().max(64)).max(64).optional(),
  })
  .refine((b) => b.preset || b.permissions, 'preset oder permissions angeben');

const addBody = z.object({ user: z.string().min(1).max(254) }).and(flagsInput);

export interface SubuserDeps {
  registry: ServerRegistry;
  account: LocalAccount;
  find: (id: string) => ServerInstanceConfig | undefined;
}

export function registerSubuserRoutes(server: FastifyInstance, deps: SubuserDeps): void {
  const { registry, account, find } = deps;
  const base = '/api/v1/servers/:id/subusers';

  const fail = (reply: FastifyReply, status: number, message: string, code: string): FastifyReply => reply.status(status).send({ error: message, message, code });
  const invalid = (reply: FastifyReply, error: z.ZodError): FastifyReply => fail(reply, 400, error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');

  /** Preset als Grundlage; "permissions" ersetzt es vollstaendig, wenn angegeben. Unbekannte Rechte werden abgelehnt. */
  const resolveFlags = (b: { preset?: PresetName | undefined; permissions?: string[] | undefined }): { flags: string[] } | { error: string } => {
    const flags = b.permissions ?? [...PRESETS[b.preset!].flags];
    const unknown = flags.filter((f) => !isServerFlag(f));
    if (unknown.length) return { error: `Unbekannte Rechte: ${unknown.join(', ')}` };
    return { flags: [...new Set(flags)] };
  };

  server.get<{ Params: { id: string } }>(`${base}/permissions`, async () => ({ flags: SERVER_FLAGS, labels: FLAG_LABELS, presets: PRESETS }));

  server.get<{ Params: { id: string } }>(base, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const access = getAccess(registry, c.id);
    const subusers = Object.entries(access.subusers)
      .map(([userId, permissions]) => {
        const u = account.get(userId);
        return u ? { userId, username: u.username, email: u.email, permissions, since: access.since[userId] ?? null } : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => a.username.localeCompare(b.username));
    return { subusers };
  });

  server.post<{ Params: { id: string }; Body: unknown }>(base, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const body = addBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = req.actor!;
    const resolved = resolveFlags(body.data);
    if ('error' in resolved) return fail(reply, 400, resolved.error, 'invalid_input');
    const grant = canGrant(actor, accessFor(registry, c.id, actor), resolved.flags);
    if (!grant.ok) return fail(reply, 403, `Diese Rechte hast du selbst nicht: ${grant.denied.join(', ')}`, 'forbidden');

    const target = account.findByLogin(body.data.user);
    if (!target) return fail(reply, 404, 'Kein Konto mit diesem Namen oder dieser E-Mail', 'user_not_found');
    if (target.suspended) return fail(reply, 400, 'Dieses Konto ist gesperrt', 'invalid_input');
    const access = getAccess(registry, c.id);
    if (target.id === access.ownerId) return fail(reply, 400, 'Der Besitzer hat schon alle Rechte', 'invalid_input');
    if (target.role === 'admin') return fail(reply, 400, 'Ein Administrator hat schon alle Rechte', 'invalid_input');
    if (target.id in access.subusers) return fail(reply, 409, 'Ist schon Mitnutzer - Rechte stattdessen ändern', 'conflict');

    setSubuserFlags(registry, c.id, target.id, resolved.flags);
    registry.audit('subuser.create', c.id, 'standalone', { user: target.username, permissions: resolved.flags });
    reply.code(201);
    return { userId: target.id, username: target.username, permissions: resolved.flags };
  });

  server.patch<{ Params: { id: string; userId: string }; Body: unknown }>(`${base}/:userId`, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const body = flagsInput.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error);
    const actor = req.actor!;
    if (req.params.userId === actor.id) return fail(reply, 403, 'Eigene Rechte kann man nicht ändern', 'forbidden');
    const current = getAccess(registry, c.id).subusers[req.params.userId];
    if (!current) return fail(reply, 404, 'Mitnutzer nicht gefunden', 'not_found');

    const resolved = resolveFlags(body.data);
    if ('error' in resolved) return fail(reply, 400, resolved.error, 'invalid_input');
    // Auch was WEGGENOMMEN wird, muss man selbst haben - sonst koennte ein Operator einem Co-Admin Rechte entziehen,
    // die er gar nicht ueberblickt.
    const touched = [...new Set([...resolved.flags, ...current])].filter((f) => resolved.flags.includes(f) !== current.includes(f));
    const grant = canGrant(actor, accessFor(registry, c.id, actor), touched);
    if (!grant.ok) return fail(reply, 403, `Diese Rechte hast du selbst nicht: ${grant.denied.join(', ')}`, 'forbidden');

    setSubuserFlags(registry, c.id, req.params.userId, resolved.flags);
    registry.audit('subuser.update', c.id, 'standalone', { userId: req.params.userId, from: current, to: resolved.flags });
    return { permissions: resolved.flags };
  });

  /** Entfernen - oder selbst austreten (dafuer braucht man kein Recht). */
  server.delete<{ Params: { id: string; userId: string } }>(`${base}/:userId`, async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const actor = req.actor!;
    const self = req.params.userId === actor.id;
    if (!self && !canGrant(actor, accessFor(registry, c.id, actor), ['subuser.delete']).ok) {
      return fail(reply, 403, 'Fehlendes Recht: subuser.delete', 'forbidden');
    }
    if (!(req.params.userId in getAccess(registry, c.id).subusers)) return fail(reply, 404, 'Mitnutzer nicht gefunden', 'not_found');
    setSubuserFlags(registry, c.id, req.params.userId, null);
    registry.audit(self ? 'subuser.leave' : 'subuser.delete', c.id, 'standalone', { userId: req.params.userId });
    return { ok: true };
  });
}
