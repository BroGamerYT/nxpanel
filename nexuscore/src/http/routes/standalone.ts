import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { HostDriver } from '../../drivers/interface.js';
import type { EventBus } from '../../protocol/events.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';
import { config } from '../../config/index.js';

const newServerSchema = z.object({
  id: z.string().trim().min(2).max(32).regex(/^[a-z0-9_-]+$/i, 'Nur Buchstaben, Zahlen, Bindestrich und Unterstrich'),
  name: z.string().trim().min(1).max(64),
  game: z.string().trim().min(1).max(32),
  executable: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  port: z.coerce.number().int().min(1).max(65535).default(25565),
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

    // Server-Verzeichnis im dataDir anlegen
    const serverDir = path.resolve(config.dataDir, 'servers', data.id);
    await fs.mkdir(serverDir, { recursive: true });

    const serverConfig: ServerInstanceConfig = {
      id: data.id,
      name: data.name,
      game: data.game,
      executable: data.executable,
      args: data.args,
      workingDir: serverDir,
      ports: [{ name: 'game', hostPort: data.port, protocol: 'tcp' }],
    };

    try {
      await driver.registerServer(serverConfig);
      await registry.add(serverConfig);
      return reply.status(201).send({ status: 'created', server: serverConfig });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // Server Starten
  server.post<{ Params: { id: string } }>('/api/panel/servers/:id/start', async (req, reply) => {
    try {
      const state = await driver.startServer(req.params.id);
      return { status: 'starting', state };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // Server Stoppen
  server.post<{ Params: { id: string } }>('/api/panel/servers/:id/stop', async (req, reply) => {
    try {
      const state = await driver.stopServer(req.params.id);
      return { status: 'stopping', state };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // Server Konsolenbefehl senden
  server.post<{ Params: { id: string }; Body: { command: string } }>(
    '/api/panel/servers/:id/command',
    async (req, reply) => {
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
    async (req) => {
      const limit = Number.parseInt(req.query.limit ?? '200', 10);
      return { serverId: req.params.id, lines: bus.logsFor(req.params.id, limit) };
    },
  );
}
