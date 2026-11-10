import type { FastifyInstance } from 'fastify';
import type { HostDriver } from '../../drivers/interface.js';
import type { EventBus } from '../../protocol/events.js';
import { serverExists } from './actions.js';

/**
 * Konsolenausgaben einer Instanz aus dem Ringpuffer des Event-Bus.
 *
 * Der Puffer haelt die letzten 500 Zeilen je Server - genug, um einen
 * Neustart oder einen Verbindungsabbruch im Panel zu ueberbruecken.
 */
export function registerLogRoutes(server: FastifyInstance, driver: HostDriver, bus: EventBus): void {
  server.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/core/v1/servers/:id/logs',
    async (req, reply) => {
      if (!(await serverExists(driver, req.params.id))) {
        return reply.status(404).send({
          error: 'Server nicht gefunden',
          message: `Unbekannte ID "${req.params.id}".`,
        });
      }

      const parsed = Number.parseInt(req.query.limit ?? '100', 10);
      const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100;

      return { serverId: req.params.id, lines: bus.logsFor(req.params.id, limit) };
    },
  );
}
