import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { HostDriver } from '../../drivers/interface.js';
import { getSystemMetrics } from '../../system/monitor.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Hosts (Admin). Ein Core ist selbst genau ein Host - dieser Rechner. Andere
 * Cores koppelt das Panel an sich, nicht umgekehrt; deshalb gibt es hier nur
 * Anzeige und Statusabfrage, kein Koppeln und Entfernen.
 */

const LOCAL_ID = 'local';

export function registerHostRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; driver: HostDriver; dataDir: string }): void {
  const { registry, driver, dataDir } = deps;

  async function hostRow() {
    const m = await getSystemMetrics(dataDir);
    return {
      id: LOCAL_ID,
      name: os.hostname(),
      type: 'local' as const,
      address: null,
      runtime: driver.name,
      status: 'online' as const,
      certFingerprint: null,
      lastSeenAt: new Date().toISOString(),
      ramTotalMb: m.totalMemoryMb,
      ramUsedMb: m.usedMemoryMb,
      diskTotalMb: Math.round(m.diskTotalGb * 1024),
      diskUsedMb: Math.round((m.diskTotalGb - m.diskFreeGb) * 1024),
      cpuPercent: m.cpuUsagePercent,
      servers: registry.list().length,
    };
  }

  server.get('/api/v1/admin/hosts', async () => ({ hosts: [await hostRow()] }));

  server.post<{ Params: { id: string } }>('/api/v1/admin/hosts/:id/check', async (req, reply) => {
    if (req.params.id !== LOCAL_ID) return reply.status(404).send({ error: 'Host nicht gefunden', code: 'not_found' });
    return { host: await hostRow() };
  });

  server.get<{ Params: { id: string } }>('/api/v1/admin/hosts/:id/servers', async (req, reply) => {
    if (req.params.id !== LOCAL_ID) return reply.status(404).send({ error: 'Host nicht gefunden', code: 'not_found' });
    const states = new Map((await driver.listServers().catch(() => [])).map((s) => [s.id, s.status]));
    return {
      servers: registry.list().map((c) => ({ id: c.id, name: c.name, game: c.game, status: states.get(c.id) ?? 'offline' })),
    };
  });
}
