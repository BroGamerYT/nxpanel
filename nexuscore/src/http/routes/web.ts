import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logger.js';

function getDirname(): string {
  try {
    return typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Findet das 'web/dist'-Verzeichnis über verschiedene typische Pfade
 * (Entwicklung, kompiliertes SEA-Binary, Workspace).
 */
export function resolveWebDir(): string | null {
  const base = getDirname();
  const candidates = [
    process.env.WEB_DIR,
    path.resolve(process.cwd(), 'web', 'dist'),
    path.resolve(process.cwd(), '..', 'web', 'dist'),
    path.resolve(process.cwd(), 'dist', 'web'),
    path.resolve(path.dirname(process.execPath), 'web', 'dist'),
    path.resolve(path.dirname(process.execPath), 'web'),
    path.resolve(path.dirname(process.execPath), '..', 'web', 'dist'),
    path.resolve(path.dirname(process.execPath), '..', '..', 'web', 'dist'),
    path.resolve(base, '..', '..', '..', '..', 'web', 'dist'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Registriert das Ausliefern der echten React-Weboberflaeche (web/dist).
 * SPA-Routing: Jede URL, die keine API-Route und keine physische Datei ist,
 * bekommt die 'index.html' serviert.
 */
export async function registerWebRoutes(server: FastifyInstance): Promise<void> {
  const webDir = resolveWebDir();

  if (!webDir) {
    logger.warn('web/dist nicht gefunden - Web-Frontend steht im Browser nicht zur Verfügung');
    return;
  }

  logger.info({ webDir }, 'Liefere 1:1 React-Frontend aus web/dist aus');

  await server.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    wildcard: true,
    index: 'index.html',
    setHeaders: (res, filePath) => {
      if (filePath.includes('/assets/')) {
        res.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.header('Cache-Control', 'no-cache');
      }
    },
  });

  // SPA Fallback Handler
  server.setNotFoundHandler((req, reply) => {
    const rawPath = req.url.split('?')[0] ?? '';
    // API- und Core-Routen sowie Dateien mit Dateiendung nicht als HTML beantworten
    if (
      req.method !== 'GET' ||
      rawPath.startsWith('/api/') ||
      rawPath.startsWith('/core/') ||
      /\.[a-z0-9]+$/i.test(rawPath)
    ) {
      return reply.status(404).send({ error: 'Nicht gefunden', code: 'not_found' });
    }

    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}
