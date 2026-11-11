import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { HostDriver } from '../../drivers/interface.js';
import type { EventBus } from '../../protocol/events.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';
import { PathOutsideRootError, resolveInsideRoot, serverRootFor } from '../../protocol/paths.js';
import { allocatePort } from '../../protocol/ports.js';

const newServerSchema = z.object({
  id: z.string().trim().min(2).max(32).regex(/^[a-z0-9_-]+$/i, 'Nur Buchstaben, Zahlen, Bindestrich und Unterstrich'),
  name: z.string().trim().min(1).max(64),
  game: z.string().trim().min(1).max(32),
  executable: z.string().trim().min(1).max(512),
  args: z.array(z.string().max(4096)).max(64).default([]),
  port: z.coerce.number().int().min(1).max(65535).optional(),
});

export function registerStandaloneRoutes(
  server: FastifyInstance,
  driver: HostDriver,
  bus: EventBus,
  registry: ServerRegistry,
): void {
  // Liste aller Server mit Live-Zustand & Metriken
  server.get('/api/panel/servers', async () => {
    const configs = registry.list();
    const states = await driver.listServers();
    const stateMap = new Map(states.map((s) => [s.id, s]));

    const result = await Promise.all(
      configs.map(async (c) => {
        const state = stateMap.get(c.id) ?? { id: c.id, status: 'offline' };
        let stats = null;
        if (state.status === 'running') {
          try {
            stats = await driver.getServerStats(c.id);
          } catch {
            // Stats optional
          }
        }
        return {
          ...c,
          state,
          stats,
        };
      }),
    );

    return { servers: result };
  });

  // Neuen Server erstellen
  server.post('/api/panel/servers', async (req, reply) => {
    const parse = newServerSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.status(400).send({
        error: 'Ungueltige Eingabe',
        message: parse.error.issues.map((i) => i.message).join(', '),
      });
    }

    const data = parse.data;
    if (registry.get(data.id)) {
      return reply.status(409).send({ error: `Server "${data.id}" existiert bereits.` });
    }

    // Block A3: Die Instanz liegt immer im Server-Verzeichnis, und das Programm
    // muss in ihrem eigenen Ordner liegen - freie Pfade aus dem Netz gibt es nicht.
    const serverRoot = serverRootFor(registry.dir);
    let serverDir: string;
    let executable: string;
    try {
      serverDir = await resolveInsideRoot(serverRoot, data.id, 'id');
      executable =
        driver.name === 'docker'
          ? data.executable
          : await resolveInsideRoot(serverRoot, data.executable, 'executable', serverDir);
    } catch (err) {
      if (err instanceof PathOutsideRootError) {
        return reply.status(400).send({ error: 'Ungueltiger Pfad', message: err.message });
      }
      throw err;
    }
    await fs.mkdir(serverDir, { recursive: true });

    let port: number;
    try {
      port = data.port ?? (await allocatePort(registry.list()));
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }

    const serverConfig: ServerInstanceConfig = {
      id: data.id,
      name: data.name,
      game: data.game,
      executable,
      args: data.args,
      workingDir: serverDir,
      ports: [{ name: 'game', hostPort: port, protocol: 'tcp' }],
    };

    try {
      await driver.registerServer(serverConfig);
      await registry.add(serverConfig);
      registry.audit('server.create', serverConfig.id, 'standalone', { name: serverConfig.name, game: serverConfig.game });
      return reply.status(201).send({ status: 'created', server: serverConfig });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // Server Starten
  server.post<{ Params: { id: string } }>('/api/panel/servers/:id/start', async (req, reply) => {
    if (!registry.get(req.params.id)) {
      return reply.status(404).send({ error: 'Server nicht gefunden', message: `Unbekannte ID "${req.params.id}".` });
    }
    try {
      const state = await driver.startServer(req.params.id);
      registry.audit('server.start', req.params.id, 'standalone');
      return { status: 'starting', state };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // Server Stoppen
  server.post<{ Params: { id: string } }>('/api/panel/servers/:id/stop', async (req, reply) => {
    if (!registry.get(req.params.id)) {
      return reply.status(404).send({ error: 'Server nicht gefunden', message: `Unbekannte ID "${req.params.id}".` });
    }
    try {
      const state = await driver.stopServer(req.params.id);
      registry.audit('server.stop', req.params.id, 'standalone');
      return { status: 'stopping', state };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // Server Konsolenbefehl senden
  server.post<{ Params: { id: string }; Body: { command: string } }>(
    '/api/panel/servers/:id/command',
    async (req, reply) => {
      if (!registry.get(req.params.id)) {
        return reply.status(404).send({ error: 'Server nicht gefunden', message: `Unbekannte ID "${req.params.id}".` });
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
    },
  );

  // Server Logs holen
  server.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/panel/servers/:id/logs',
    async (req, reply) => {
      if (!registry.get(req.params.id)) {
        return reply.status(404).send({ error: 'Server nicht gefunden', message: `Unbekannte ID "${req.params.id}".` });
      }
      const limit = Number.parseInt(req.query.limit ?? '200', 10);
      return { serverId: req.params.id, lines: bus.logsFor(req.params.id, limit) };
    },
  );
}
