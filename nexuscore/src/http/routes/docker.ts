import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HostDriver } from '../../drivers/interface.js';
import { loadEggs } from '../../eggs/loader.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Docker aufraeumen (nur Administratoren, nur Docker-Treiber): entfernt Images aus den Eggs, die kein Container mehr braucht.
 * Anders als im Panel nur die Images des Cores - nie fremde Images auf diesem Rechner. Spielserver und Daten bleiben unberuehrt.
 */
export function registerDockerRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; driver: HostDriver }): void {
  const { registry, driver } = deps;
  const body = z.object({ images: z.boolean().default(true), buildCache: z.boolean().default(true) });

  server.post<{ Body: unknown }>('/api/v1/admin/docker/prune', async (req, reply) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Ungültige Anfrage', code: 'invalid_request' });
    if (!driver.prune) return reply.status(400).send({ error: 'Aufräumen gibt es nur mit dem Docker-Treiber.', code: 'not_supported' });
    // Der Core baut nichts selbst: es gibt keinen Build-Cache aufzuräumen ("buildCache" wird angenommen und ignoriert)
    if (!parsed.data.images) return { imagesDeleted: 0, reclaimedMb: 0 };
    const owned = new Set<string>();
    for (const egg of await loadEggs()) {
      for (const image of Object.values(egg.raw.docker_images ?? {})) owned.add(image);
      const installer = egg.raw.scripts?.installation?.container;
      if (installer) owned.add(installer);
    }
    try {
      const result = await driver.prune([...owned]);
      registry.audit('docker.prune', null, 'standalone', { ...parsed.data, ...result });
      return result;
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message, code: 'docker_unavailable' });
    }
  });
}
