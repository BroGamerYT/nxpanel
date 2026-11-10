import type { FastifyInstance } from 'fastify';
import type { HostDriver } from '../../drivers/interface.js';
import { serverExists } from './actions.js';

/** Aktuelle Leistungswerte einer Instanz: CPU, RAM, Laufzeit. */
export function registerStatsRoutes(server: FastifyInstance, driver: HostDriver): void {
  server.get<{ Params: { id: string } }>('/core/v1/servers/:id/stats', async (req, reply) => {
    if (!(await serverExists(driver, req.params.id))) {
      return reply.status(404).send({
        error: 'Server nicht gefunden',
        message: `Unbekannte ID "${req.params.id}".`,
      });
    }

    try {
      const stats = await driver.getServerStats(req.params.id);
      return { stats };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}
