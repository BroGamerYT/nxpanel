import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DISCORD_WEBHOOK_PATTERN, type DiscordNotifier } from '../../notifications/discord.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { SecretStore } from '../../store/secrets.js';

/**
 * Integrationen (Admin): Discord-Webhook und Playit.gg-Schluessel. Wie im Panel wird bei Playit nur der Secret Key
 * hinterlegt (verschluesselt); einen Tunnel startet der Core damit nicht selbst.
 */

const PLAYIT_SECRET = 'playit';
const playitBody = z.object({ secretKey: z.string().trim().max(200).nullable().optional() });

const discordBody = z.object({
  url: z.string().trim().max(300).nullable().optional(),
  enabled: z.boolean().optional(),
});

export function registerIntegrationRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; discord: DiscordNotifier; secrets: SecretStore }): void {
  const { registry, discord, secrets } = deps;

  server.get('/api/v1/admin/integrations', async () => {
    const status = secrets.status(PLAYIT_SECRET);
    const key = status === 'ok' ? secrets.get(PLAYIT_SECRET) : null;
    // Nur der Anfang zum Wiedererkennen; "unreadable": gespeichert, aber mit dem jetzigen Hauptschluessel nicht lesbar
    return {
      discord: discord.view(),
      playit: { configured: status === 'ok', secretKey: key ? `${key.slice(0, 4)}...` : '', ...(status === 'unreadable' ? { unreadable: true } : {}) },
    };
  });

  server.post('/api/v1/admin/integrations/playit', async (req, reply) => {
    const body = playitBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Schlüssel: höchstens 200 Zeichen', code: 'invalid_request' });
    const key = body.data.secretKey;
    if (key && !/^[A-Za-z0-9_.-]{8,200}$/.test(key)) return reply.status(400).send({ error: 'Das ist kein Playit-Schlüssel (nur Buchstaben, Ziffern, _ . -).', code: 'invalid_key' });
    if (key) secrets.set(PLAYIT_SECRET, key);
    else secrets.delete(PLAYIT_SECRET);
    registry.audit('admin.playit_update', null, 'standalone', { key: key ? 'gesetzt' : 'entfernt' });
    return { ok: true };
  });

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
