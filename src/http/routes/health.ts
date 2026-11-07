import type { FastifyInstance } from 'fastify';
import { checkDatabase } from '../../db/index.js';
import { engine } from '../../docker/client.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Schlank: beantwortet nur, ob der Prozess lebt.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Ausfuehrlich: prueft die Abhaengigkeiten. Fuer Monitoring gedacht.
  app.get('/readyz', async (_req, reply) => {
    const [db, docker] = await Promise.all([checkDatabase(), engine.ping()]);
    const ready = db && docker;

    reply.code(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'degraded',
      checks: { database: db, docker },
    };
  });
}
