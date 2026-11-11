import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HostDriver } from '../../drivers/interface.js';
import { GamingError, MAX_WARN_SECONDS, type GamingMode } from '../../gaming/manager.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Gaming-Modus und Ressourcen-Grenzen (Admin, Bereich Hosts).
 */

const gamingBody = z.object({
  active: z.boolean(),
  mode: z.enum(['throttle', 'stop']).default('throttle'),
  warnSeconds: z.number().int().min(0).max(MAX_WARN_SECONDS).default(0),
  message: z.string().max(200).optional(),
});

const limitsBody = z.object({ enforce: z.boolean() });

export const LIMITS_KEY = 'limits.enforce';

export function registerSystemRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; driver: HostDriver; gaming: GamingMode }): void {
  const { registry, driver, gaming } = deps;

  server.get('/api/v1/admin/gaming-mode', async () => ({
    ...gaming.state(),
    // Drosseln braucht einen Treiber, der die Prioritaet aendern kann
    canThrottle: typeof driver.setPriority === 'function',
    maxWarnSeconds: MAX_WARN_SECONDS,
  }));

  server.post<{ Body: unknown }>('/api/v1/admin/gaming-mode', async (req, reply) => {
    const body = gamingBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'Ungültige Anfrage', code: 'invalid_request' });
    try {
      if (!body.data.active) return { ok: true, ...(await gaming.deactivate()) };
      if (body.data.mode === 'throttle' && typeof driver.setPriority !== 'function') {
        return reply.status(400).send({ error: 'Dieser Treiber kann die Priorität nicht ändern.', code: 'not_supported' });
      }
      return {
        ok: true,
        ...(await gaming.activate({
          mode: body.data.mode,
          warnSeconds: body.data.warnSeconds,
          ...(body.data.message ? { message: body.data.message } : {}),
        })),
      };
    } catch (err) {
      if (err instanceof GamingError) return reply.status(err.statusCode).send({ error: err.message, message: err.message, code: err.code });
      throw err;
    }
  });

  server.get('/api/v1/admin/limits', async () => ({
    enforce: registry.getSetting<boolean>(LIMITS_KEY) === true,
    // Grenzen setzt das Hilfsprogramm nxjob.exe - nur unter Windows, nur wenn es gebaut ist
    supported: driver.name === 'windows-native' && (driver as { hasJobHelper?: boolean }).hasJobHelper === true,
    driver: driver.name,
  }));

  server.post<{ Body: unknown }>('/api/v1/admin/limits', async (req, reply) => {
    const body = limitsBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Ungültige Anfrage', code: 'invalid_request' });
    registry.setSetting(LIMITS_KEY, body.data.enforce);
    registry.audit('limits.update', null, 'standalone', { enforce: body.data.enforce });
    return { ok: true, enforce: body.data.enforce, appliesFrom: 'next_start' };
  });
}
