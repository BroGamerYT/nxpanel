import type { FastifyInstance } from 'fastify';
import type { HostDriver } from '../../drivers/interface.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Gesundheit fuer Docker-Health-Checks, Dienstueberwachung und Lastverteiler (ohne Anmeldung, nur Ja/Nein).
 *  - healthz: der Prozess lebt.
 *  - readyz: die Abhaengigkeiten gehen (Datenbank des Cores, Treiber/Docker-Daemon). 503, wenn nicht.
 * Die Antwort nennt nie Pfade, Versionen oder Fehlertexte.
 */
export function registerHealthRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; driver: HostDriver }): void {
  const { registry, driver } = deps;

  server.get('/api/v1/healthz', async () => ({ status: 'ok' }));

  server.get('/api/v1/readyz', async (_req, reply) => {
    const database = (() => {
      try {
        registry.list();
        return true;
      } catch {
        return false;
      }
    })();
    const runtime = await (driver.healthy?.() ?? Promise.resolve(true)).catch(() => false);
    const ready = database && runtime;
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'degraded', checks: { database, runtime } };
  });
}
