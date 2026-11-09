import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireAuth } from '../auth.js';
import {
  listSteamAccounts,
  saveSteamAccount,
  testSteamAccount,
  submitSteamGuard,
  deleteSteamAccount,
} from '../../servers/steam.js';
import { writeAudit } from '../../audit.js';

const saveSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().max(100).optional(),
  accountName: z.string().trim().min(2).max(100),
  password: z.string().min(1).optional(),
  steamId: z.string().trim().max(50).optional(),
  isShared: z.boolean().optional(),
});

const guardSchema = z.object({
  code: z.string().trim().min(4).max(10),
});

export async function steamRoutes(app: FastifyInstance) {
  // Liste aller Steam-Konten (eigene + vom Team freigegebene, ohne Klartextpasswort)
  app.get('/steam/accounts', { preHandler: requireAuth }, async (req) => {
    const accounts = await listSteamAccounts(req.actor!);
    return { accounts };
  });

  // Steam-Konto anlegen oder eigenes/geteiltes aktualisieren
  app.post('/steam/accounts', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'Ungültige Angaben zum Steam-Konto', 'invalid_input');
    }
    try {
      const acc = await saveSteamAccount(req.actor!, parsed.data);
      await writeAudit({
        userId: req.actor!.id,
        actorName: req.actor!.username,
        action: parsed.data.id ? 'steam.account_update' : 'steam.account_save',
        ip: req.ip,
        metadata: { accountName: acc.accountName, isShared: acc.isShared, label: acc.label },
      });
      reply.code(201);
      return { account: acc };
    } catch (err) {
      throw new HttpError(400, (err as Error).message, 'save_failed');
    }
  });

  // Verbindung & Steam Guard testen
  app.post<{ Params: { id: string } }>('/steam/accounts/:id/test', { preHandler: requireAuth }, async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      throw new HttpError(404, 'Konto nicht gefunden', 'not_found');
    }
    try {
      const result = await testSteamAccount(req.actor!, req.params.id);
      await writeAudit({
        userId: req.actor!.id,
        actorName: req.actor!.username,
        action: 'steam.test_login',
        ip: req.ip,
        metadata: { accountName: result.account.accountName, status: result.status },
      });
      return result;
    } catch (err) {
      throw new HttpError(400, (err as Error).message, 'test_failed');
    }
  });

  // Steam-Guard-Code eingeben und prüfen
  app.post<{ Params: { id: string } }>('/steam/accounts/:id/guard', { preHandler: requireAuth }, async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      throw new HttpError(404, 'Konto nicht gefunden', 'not_found');
    }
    const parsed = guardSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'Steam-Guard-Code muss 4-10 Zeichen lang sein', 'invalid_input');
    }
    try {
      const result = await submitSteamGuard(req.actor!, req.params.id, parsed.data.code);
      await writeAudit({
        userId: req.actor!.id,
        actorName: req.actor!.username,
        action: 'steam.guard_submit',
        ip: req.ip,
        metadata: { accountName: result.account.accountName, status: result.status },
      });
      return result;
    } catch (err) {
      throw new HttpError(400, (err as Error).message, 'guard_failed');
    }
  });

  // Steam-Konto löschen (nur Eigentümer oder Admins)
  app.delete<{ Params: { id: string } }>('/steam/accounts/:id', { preHandler: requireAuth }, async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      throw new HttpError(404, 'Konto nicht gefunden', 'not_found');
    }
    try {
      const ok = await deleteSteamAccount(req.actor!, req.params.id);
      if (!ok) throw new HttpError(404, 'Konto nicht gefunden', 'not_found');
      await writeAudit({
        userId: req.actor!.id,
        actorName: req.actor!.username,
        action: 'steam.account_delete',
        ip: req.ip,
        metadata: { id: req.params.id },
      });
      return { ok: true };
    } catch (err) {
      throw new HttpError(403, (err as Error).message, 'delete_forbidden');
    }
  });
}
