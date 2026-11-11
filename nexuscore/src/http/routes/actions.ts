import type { FastifyInstance } from 'fastify';
import type { HostDriver } from '../../drivers/interface.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Starten, Stoppen und erzwungenes Beenden einer Instanz.
 *
 * Alle drei Routen antworten mit dem neuen Zustand der Instanz. Unbekannte
 * IDs ergeben 404, Fehler des Treibers 400.
 */
export function registerActionRoutes(
  server: FastifyInstance,
  driver: HostDriver,
  registry?: ServerRegistry,
): void {
  server.post<{ Params: { id: string } }>('/core/v1/servers/:id/start', async (req, reply) => {
    if (!(await serverExists(driver, req.params.id))) {
      return reply.status(404).send({
        error: 'Server nicht gefunden',
        message: `Unbekannte ID "${req.params.id}".`,
      });
    }
    try {
      const state = await driver.startServer(req.params.id);
      registry?.audit('server.start', req.params.id, 'panel');
      return { status: 'starting', state };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  server.post<{ Params: { id: string } }>('/core/v1/servers/:id/stop', async (req, reply) => {
    if (!(await serverExists(driver, req.params.id))) {
      return reply.status(404).send({
        error: 'Server nicht gefunden',
        message: `Unbekannte ID "${req.params.id}".`,
      });
    }
    try {
      const state = await driver.stopServer(req.params.id);
      registry?.audit('server.stop', req.params.id, 'panel');
      return { status: 'stopping', state };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  server.post<{ Params: { id: string } }>('/core/v1/servers/:id/kill', async (req, reply) => {
    if (!(await serverExists(driver, req.params.id))) {
      return reply.status(404).send({
        error: 'Server nicht gefunden',
        message: `Unbekannte ID "${req.params.id}".`,
      });
    }
    try {
      const state = await driver.killServer(req.params.id);
      registry?.audit('server.kill', req.params.id, 'panel');
      return { status: 'killed', state };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  server.post<{ Params: { id: string } }>('/core/v1/servers/:id/command', async (req, reply) => {
    if (!(await serverExists(driver, req.params.id))) {
      return reply.status(404).send({
        error: 'Server nicht gefunden',
        message: `Unbekannte ID "${req.params.id}".`,
      });
    }
    const command = (req.body as { command?: string } | undefined)?.command?.trim();
    if (!command) {
      return reply.status(400).send({ error: 'Kein Befehl angegeben.' });
    }
    try {
      if (driver.sendCommand) {
        await driver.sendCommand(req.params.id, command);
      }
      return { status: 'sent', command };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}

/** Prueft, ob die Instanz existiert. */
export async function serverExists(driver: HostDriver, id: string): Promise<boolean> {
  try {
    await driver.getServerState(id);
    return true;
  } catch {
    return false;
  }
}
