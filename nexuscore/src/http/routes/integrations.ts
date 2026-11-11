import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DISCORD_WEBHOOK_PATTERN, type DiscordNotifier } from '../../notifications/discord.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Integrationen (Admin): Discord-Webhook. Playit.gg-Tunnel gibt es im Core noch
 * nicht - die Antwort sagt "nicht eingerichtet", die Oberflaeche blendet den
 * Bereich aus.
 */

const discordBody = z.object({
  url: z.string().trim().max(300).nullable().optional(),
  enabled: z.boolean().optional(),
});

export function registerIntegrationRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; discord: DiscordNotifier }): void {
  const { registry, discord } = deps;

  server.get('/api/v1/admin/integrations', async () => ({
    discord: discord.view(),
    playit: { configured: false, secretKey: '' },
  }));

  server.post('/api/v1/admin/integrations/discord', async (req, reply) => {
    const body = discordBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'Ungültige Anfrage', code: 'invalid_request' });
    const { url, enabled } = body.data;
    if (url && !DISCORD_WEBHOOK_PATTERN.test(url)) {
      return reply.status(400).send({ error: 'Das ist keine Discord-Webhook-Adresse (https://discord.com/api/webhooks/…).', code: 'invalid_webhook' });
    }
    discord.update({ ...(url !== undefined ? { url } : {}), ...(enabled !== undefined ? { enabled } : {}) });
    // Die Adresse ist ein Zugang: ins Protokoll nur, DASS sie geaendert wurde
    registry.audit('admin.discord_update', null, 'standalone', {
      ...(url !== undefined ? { webhook: url ? 'gesetzt' : 'entfernt' } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
    return { ok: true };
  });

  server.post('/api/v1/admin/integrations/discord/test', async (_req, reply) => {
    if (!discord.view().configured) return reply.status(400).send({ error: 'Es ist noch kein Discord-Webhook eingetragen.', code: 'webhook_missing' });
    const ok = await discord.sendTest('admin');
    if (!ok) return reply.status(400).send({ error: 'Discord-Webhook konnte nicht zugestellt werden. Bitte die Adresse überprüfen.', code: 'webhook_failed' });
    return { ok: true };
  });
}
