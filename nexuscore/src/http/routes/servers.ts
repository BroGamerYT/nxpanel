import type { FastifyInstance } from 'fastify';
import type { HostDriver } from '../../drivers/interface.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';
import { serverConfigSchema } from './schema.js';

/**
 * Serververwaltung: Liste und Registrierung.
 *
 * Die Registrierung schreibt in die Registry des Cores - ein Neustart des
 * Daemons verliert die Instanzen dadurch nicht. Der Treiber bekommt dieselbe
 * Konfiguration und haelt den Laufzeitzustand.
 */
export function registerServerRoutes(
  server: FastifyInstance,
  driver: HostDriver,
  registry: ServerRegistry,
): void {
  server.get('/core/v1/servers', async () => {
    const states = await driver.listServers();
    return { servers: states };
  });

  server.post<{ Body: unknown }>('/core/v1/servers', async (req, reply) => {
    const parsed = serverConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Ungueltige Server-Konfiguration',
        message: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; '),
      });
    }

    const config = parsed.data as ServerInstanceConfig;

    if (registry.get(config.id)) {
      return reply.status(409).send({
        error: 'Server existiert bereits',
        message: `Server "${config.id}" existiert bereits.`,
      });
    }

    // Erst persistent speichern, dann in den Treiber aufnehmen. Schlaegt der
    // Treiber fehl, wird der Registry-Eintrag wieder zurueckgenommen.
    try {
      await registry.add(config);
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }

    try {
      const state = await driver.registerServer(config);
      return reply.status(201).send({ status: 'created', state });
    } catch (err) {
      await registry.remove(config.id);
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}
