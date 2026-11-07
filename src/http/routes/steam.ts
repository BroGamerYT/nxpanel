import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireAdmin, requireAuth } from '../auth.js';
import {
  listSteamAccounts,
  saveSteamAccount,
  submitSteamGuard,
  deleteSteamAccount,
} from '../../servers/steam.js';
import { writeAudit } from '../../audit.js';

const saveSchema = z.object({
  accountName: z.string().trim().min(2).max(100),
  password: z.string().min(1).optional(),
  steamId: z.string().trim().max(50).optional(),
});

const guardSchema = z.object({
  code: z.string().trim().min(4).max(10),
});

export async function steamRoutes(app: FastifyInstance) {
  // Liste aller Steam-Konten (ohne Passwort, aber mit Guard-Status)
  app.get('/steam/accounts', { preHandler: requireAuth }, async () => {
    const accounts = await listSteamAccounts();
    return { accounts };
  });

  // Steam-Konto anlegen oder aktualisieren (nur Admins)
  app.post('/steam/accounts', { preHandler: requireAdmin() }, async (req, reply) => {
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'Ungültige Angaben zum Steam-Konto', 'invalid_input');
    }
    const acc = await saveSteamAccount(parsed.data);
    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'steam.account_save',
      ip: req.ip,
      metadata: { accountName: acc.accountName },
    });
    reply.code(201);
    return { account: acc };
  });

  // Steam-Guard-Code eingeben
  app.post<{ Params: { id: string } }>('/steam/accounts/:id/guard', { preHandler: requireAuth }, async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      throw new HttpError(404, 'Konto nicht gefunden', 'not_found');
    }
    const parsed = guardSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'Steam-Guard-Code muss 4-10 Zeichen lang sein', 'invalid_input');
    }
    try {
      const acc = await submitSteamGuard(req.params.id, parsed.data.code);
      await writeAudit({
        userId: req.actor!.id,
        actorName: req.actor!.username,
        action: 'steam.guard_submit',
        ip: req.ip,
        metadata: { accountName: acc.accountName },
      });
      return { account: acc };
    } catch {
      throw new HttpError(404, 'Konto nicht gefunden', 'not_found');
    }
  });

  // Steam-Konto löschen (nur Admins)
  app.delete<{ Params: { id: string } }>('/steam/accounts/:id', { preHandler: requireAdmin() }, async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      throw new HttpError(404, 'Konto nicht gefunden', 'not_found');
    }
    const ok = await deleteSteamAccount(req.params.id);
    if (!ok) throw new HttpError(404, 'Konto nicht gefunden', 'not_found');
    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'steam.account_delete',
      ip: req.ip,
      metadata: { id: req.params.id },
    });
    return { ok: true };
  });
}
