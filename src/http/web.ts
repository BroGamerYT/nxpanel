import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';

/**
 * Liefert die Weboberflaeche aus (web/dist). Alles, was keine Datei und
 * keine API ist, bekommt index.html - die Oberflaeche routet selbst
 * (/server/abc123 soll auch nach einem Neuladen funktionieren).
 */
export async function registerWeb(app: FastifyInstance, dir = process.env.WEB_DIR ?? join(process.cwd(), 'web', 'dist')) {
  if (!existsSync(join(dir, 'index.html'))) {
    log.warn({ dir }, 'Weboberflaeche nicht gebaut - nur die API ist erreichbar (cd web && npm run build)');
    return;
  }
  await app.register(fastifyStatic, {
    root: dir,
    // wildcard: Dateien werden bei jeder Anfrage gesucht, nicht nur die beim Start vorhandenen
    // (sonst liefert ein neuer Build bis zum Neustart 404).
    wildcard: true,
    // Dateinamen mit Hash aendern sich bei jedem Build -> darf lange gecacht werden.
    setHeaders: (res, path) => {
      res.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (req.method !== 'GET' || path.startsWith('/api/') || path === '/healthz' || path === '/readyz' || /\.[a-z0-9]+$/i.test(path)) {
      return reply.code(404).send({ error: 'Nicht gefunden', code: 'not_found' });
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}
