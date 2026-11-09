import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { config, isProduction } from '../config.js';
import { log } from '../log.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes, type PowerHandlers, type ServerOps } from './routes/servers.js';
import { adminRoutes, adminUserRoutes, adminNetworkRoutes } from './routes/admin.js';
import { subuserRoutes } from './routes/subusers.js';
import { modpackRoutes } from './routes/modpacks.js';
import { eggRoutes } from './routes/eggs.js';
import { serverSettingsRoutes } from './routes/server-settings.js';
import { importRoutes } from './routes/import.js';
import { consoleRoutes, type ConsoleEngine } from './routes/console.js';
import { authPlugin, HttpError, requireAuth } from './auth.js';
import { registerOpenApi } from './openapi.js';
import { registerWeb } from './web.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { logRoutes } from './routes/logs.js';
import { gameRoutes } from './routes/game.js';
import { steamRoutes } from './routes/steam.js';
import { fileRoutes } from './routes/files.js';
import { adminFileRoutes } from './routes/admin-files.js';
import { backupRoutes } from './routes/backups.js';
import { taskRoutes } from './routes/tasks.js';
import { scheduleRoutes } from './routes/schedules.js';
import { storageTargetRoutes } from './routes/storage-targets.js';
import { statsCollector, diskCollector } from '../servers/stats.js';
import type { DiskSource } from '../servers/disk-collector.js';
import type { StatsSource } from '../servers/stats-collector.js';
import { PANEL_VERSION, BUILD, loadAbout } from '../version.js';
import { listDocs, getDoc } from '../docs.js';


export const API_VERSION = PANEL_VERSION;
import { RateLimiter, createRedisStore, type RateLimitStore } from '../auth/ratelimit.js';

export interface BuildOptions {
  /** Fuer Tests: Arbeitsspeicher statt Redis. */
  rateLimitStore?: RateLimitStore;
  /** Fuer Tests: Power-Aktionen ohne Docker. */
  power?: PowerHandlers;
  /** Fuer Tests: Anlegen und Loeschen ohne Docker. */
  ops?: ServerOps;
  /** Fuer Tests: Konsole ohne Docker. */
  consoleEngine?: ConsoleEngine;
  /** Live-Auslastung aller Server (Dashboard). Ohne Angabe: der globale Sammler. */
  stats?: StatsSource;
  /** Belegter Speicher je Server und von Docker. */
  disk?: DiskSource;
  logger?: boolean;
}

async function defaultOps(): Promise<ServerOps> {
  const c = await import('../servers/create.js');
  return {
    provision: async (id, ctx) => { await c.provisionServer(id, { actorId: ctx.actorId }); },
    remove: (id, ctx) => c.deleteServer(id, ctx.actorId),
    rebuild: (id, ctx) => c.rebuildContainer(id, ctx),
    updateResources: async (id) => {
      const { engine } = await import('../docker/client.js');
      const [s] = await (await import('../db/index.js')).sql<{ container_id: string | null; ram_mb: number; swap_mb: number; cpu_percent: number }[]>`
        SELECT container_id, ram_mb, swap_mb, cpu_percent FROM servers WHERE id = ${id}`;
      if (s?.container_id) await engine.updateResources(s.container_id, { ramMb: s.ram_mb, swapMb: s.swap_mb, cpuPercent: s.cpu_percent });
    },
  };
}

async function defaultPower(): Promise<PowerHandlers> {
  // Erst hier laden: so zieht ein Test ohne Docker den Docker-Client gar nicht erst an.
  const lc = await import('../servers/lifecycle.js');
  return {
    start: (id, ctx) => lc.startServer(id, ctx),
    stop: (id, ctx) => lc.stopServer(id, ctx),
    restart: (id, ctx) => lc.restartServer(id, ctx),
    kill: (id, ctx) => lc.killServer(id, ctx),
  };
}

export async function buildServer(opts: BuildOptions = {}) {
  const app = Fastify({
    ...(opts.logger === false ? { logger: false } : { loggerInstance: log }),
    trustProxy: true, // laeuft hinter Caddy - echte Client-IP aus dem Header
    bodyLimit: 2 * 1024 * 1024,
  });

  const limiter = new RateLimiter(opts.rateLimitStore ?? createRedisStore(config.REDIS_URL));
  const power = opts.power ?? (await defaultPower());
  const ops = opts.ops ?? (await defaultOps());
  const consoleEngine = opts.consoleEngine ?? (await import('../docker/client.js')).engine;

  // Der Fehlerbehandler muss VOR den Routen stehen: Fastify kapselt Plugins,
  // spaeter gesetzte Handler gelten nur fuer spaeter registrierte Routen.
  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'Ungueltige Eingabe',
        code: 'invalid_input',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'Unbehandelter Fehler');
    return reply.code(status).send({
      error: status >= 500 && isProduction ? 'Interner Fehler' : err.message,
      code: status >= 500 ? 'internal' : (err as FastifyError).code,
    });
  });

  // Sicherheits-Header fuer Internet.nl, OWASP und moderne Browser-Standards
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: https:; frame-ancestors 'self';",
    );
  });

  // RFC 9116 security.txt fuer Sicherheitsforscher & Internet.nl
  const securityTxt = `Contact: mailto:security@brogameryt.de\nPreferred-Languages: de, en\nCanonical: https://nxp.brogameryt.de/.well-known/security.txt\nPolicy: https://nxp.brogameryt.de/hilfe\nExpires: 2027-12-31T23:59:59.000Z\n`;
  app.get('/.well-known/security.txt', async (_req, reply) => {
    return reply.type('text/plain; charset=utf-8').send(securityTxt);
  });
  app.get('/security.txt', async (_req, reply) => {
    return reply.type('text/plain; charset=utf-8').send(securityTxt);
  });

  await app.register(cors, {
    origin: isProduction ? config.PANEL_URL : true,
    credentials: true,
  });
  await app.register(cookie);
  await registerOpenApi(app as unknown as FastifyInstance, API_VERSION);
  await app.register(authPlugin);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  // Backups koennen viele GB gross sein - gestreamt auf die Platte, nie in den Speicher.
  await app.register(multipart, { limits: { fileSize: 64 * 1024 ** 3, files: 1 } });

  // Health ohne Praefix, API ab Tag eins versioniert.
  await app.register(healthRoutes);
  await app.register(
    async (api) => {
      api.get('/', async () => ({ name: 'NexusPanel', version: API_VERSION, build: BUILD.build }));
      // Version, Aenderungen und Planung - fuer "Was ist neu" in der Oberflaeche.
      api.get('/about', { preHandler: requireAuth }, async () => loadAbout());
      // Dokumentation: Alle Markdown-Dateien auflisten und abrufen
      api.get('/docs', { preHandler: requireAuth }, async () => ({ docs: await listDocs() }));
      api.get<{ Params: { slug: string } }>('/docs/:slug', { preHandler: requireAuth }, async (req, reply) => {
        const doc = await getDoc(req.params.slug);
        if (!doc) return reply.status(404).send({ error: 'Dokument nicht gefunden', code: 'not_found' });
        return doc;
      });
      await api.register(authRoutes, { limiter });
      await api.register(serverRoutes, { limiter, power, ops });
      await api.register(subuserRoutes);
      await api.register(serverSettingsRoutes, { ops, limiter });
      await api.register(importRoutes);
      await api.register(consoleRoutes, { engine: consoleEngine });
      await api.register(logRoutes);
      await api.register(gameRoutes);
      await api.register(steamRoutes);
      await api.register(fileRoutes);
      await api.register(adminFileRoutes);
      await api.register(backupRoutes);
      await api.register(taskRoutes);
      await api.register(scheduleRoutes);
      await api.register(storageTargetRoutes);
      await api.register(dashboardRoutes, { stats: opts.stats ?? statsCollector, disk: opts.disk ?? diskCollector });
      await api.register(eggRoutes);
      await api.register(modpackRoutes);
      await api.register(adminRoutes);
      await api.register(adminUserRoutes);
      await api.register(adminNetworkRoutes);
    },
    { prefix: '/api/v1' },
  );
  await registerWeb(app as unknown as FastifyInstance);

  return app;
}
