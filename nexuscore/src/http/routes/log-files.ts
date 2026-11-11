import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { LoadedEgg } from '../../eggs/loader.js';
import { FileAccessError } from '../../files/files.js';
import { resolveInstanceDir } from '../../files/instance-dir.js';
import { cleanLogDirs, listLogs, openLogDownload, readLog, resolveLogFile } from '../../files/logs.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';

/**
 * Logdateien eines Servers - dieselben Routen und Antworten wie im Panel (Tab "Logdateien").
 * Nicht zu verwechseln mit `logs.ts`: das ist die Konsole aus dem Ringpuffer.
 */

export interface LogFileRouteDeps {
  registry: ServerRegistry;
  find: (idOrShortId: string) => ServerInstanceConfig | undefined;
  eggs: () => Promise<LoadedEgg[]>;
}

const fileQuery = z.object({
  path: z.string().min(1, 'Pfad darf nicht leer sein').max(300),
  lines: z.coerce.number().int().min(10).max(20_000).default(2000),
  download: z.enum(['1', 'true']).optional(),
});

function fail(reply: FastifyReply, status: number, message: string, code: string): FastifyReply {
  return reply.status(status).send({ error: message, message, code });
}

export function registerLogFileRoutes(server: FastifyInstance, deps: LogFileRouteDeps): void {
  const { registry, find, eggs } = deps;

  /** Server, Ordner und Log-Ordner zu einer Anfrage; bei Fehler ist die Antwort schon gesendet (null). */
  async function target(id: string, reply: FastifyReply) {
    const instance = find(id);
    if (!instance) {
      fail(reply, 404, 'Server nicht gefunden', 'not_found');
      return null;
    }
    const root = await resolveInstanceDir(registry, instance);
    if (!root) {
      fail(reply, 403, 'Dieser Server liegt nicht in einem eigenen Ordner unter dem Server-Verzeichnis - Zugriff gesperrt.', 'forbidden');
      return null;
    }
    const egg = (await eggs()).find((e) => e.id === instance.game);
    return { instance, root, dirs: cleanLogDirs(egg?.raw.log_dirs) };
  }

  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/logs', async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;
    return { files: await listLogs(t.root, t.dirs) };
  });

  server.get<{ Params: { id: string }; Querystring: unknown }>('/api/v1/servers/:id/logs/file', async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;
    const query = fileQuery.safeParse(req.query);
    if (!query.success) return fail(reply, 400, query.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');

    try {
      const full = await resolveLogFile(t.root, t.dirs, query.data.path);
      if (query.data.download) {
        const { stream, filename } = openLogDownload(full);
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
        return reply.send(stream);
      }
      return { path: query.data.path, ...(await readLog(full, query.data.lines)) };
    } catch (err) {
      if (err instanceof FileAccessError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  });
}
