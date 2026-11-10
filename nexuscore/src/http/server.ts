import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { validateRequestToken } from '../protocol/security.js';
import type { EventBus } from '../protocol/events.js';
import type { HostDriver } from '../drivers/interface.js';
import type { ServerRegistry } from '../store/registry.js';
import type { CoreEvent, LogLine } from '../types.js';
import { registerInfoRoutes } from './routes/info.js';
import { registerPairRoutes } from './routes/pair.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerStandaloneRoutes } from './routes/standalone.js';
import { registerApiV1Routes } from './routes/api-v1.js';
import { registerWebRoutes } from './routes/web.js';

/** Endpunkte, die ohne Token erreichbar sind. */
const PUBLIC_ROUTES = new Set([
  'GET /',
  'GET /favicon.ico',
  'GET /core/v1/info',
  'POST /core/v1/pair',
]);

export async function createCoreServer(
  driver: HostDriver,
  bus: EventBus,
  registry: ServerRegistry,
): Promise<FastifyInstance> {
  // Fastify loggt nicht selbst: der Core bringt seinen eigenen pino-Logger
  // mit, damit Request-Log und Anwendungslog dasselbe Format und dieselbe
  // Redaction haben.
  const server = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
  });

  server.addHook('onResponse', async (req, reply) => {
    logger.info(
      { method: req.method, url: req.url, status: reply.statusCode },
      'HTTP-Anfrage',
    );
  });

  // CORS nur, wenn wirklich Origins eingetragen sind. Ohne Eintrag bleibt der
  // Core eine reine lokal erreichbare Schnittstelle.
  if (config.corsOrigins.length > 0) {
    await server.register(cors, {
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'OPTIONS'],
    });
  }

  await server.register(websocket);

  /**
   * Sammel-Parser fuer unbekannte Content-Types.
   *
   * Windows PowerShell schickt bei POST ohne Body einen
   * 'application/x-www-form-urlencoded'-Header mit. Ohne diesen Parser
   * antwortet Fastify mit 415, obwohl die Route gar keinen Body braucht.
   * Leerer oder unparsbarer Inhalt wird deshalb als "kein Body" behandelt.
   */
  server.addContentTypeParser(
    '*',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (typeof body !== 'string' || body.trim().length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch {
        done(null, undefined);
      }
    },
  );

  /**
   * Authentifizierung fuer alles ausser den oeffentlichen Endpunkten.
   *
   * Der Token darf als Header oder - beim WebSocket - als Query-Parameter
   * kommen, weil der Browser beim WebSocket keine Header setzen kann.
   */
  server.addHook('onRequest', async (req, reply) => {
    const path = (req.url.split('?')[0] ?? '').replace(/\/$/, '') || '/';
    // Nur /core/v1-Routen sind token-geschuetzt. Alles fuer das Web-Frontend (/api/v1, Assets, SPA) ist frei
    if (!path.startsWith('/core/')) {
      return;
    }
    if (PUBLIC_ROUTES.has(`${req.method} ${path}`)) {
      return;
    }

    const queryToken = (req.query as Record<string, unknown> | undefined)?.token;
    const header =
      req.headers.authorization ??
      (typeof queryToken === 'string' && queryToken.length > 0
        ? `Bearer ${queryToken}`
        : undefined);

    const auth = validateRequestToken(header);
    if (!auth.valid) {
      return reply.status(401).send({
        error: 'Nicht autorisiert',
        message: auth.reason ?? 'Ungueltiger Token.',
      });
    }
  });

  server.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    // Fastify-Fehler (leerer JSON-Body, ungueltige Route, ...) tragen ihren
    // Statuscode bereits - der darf nicht zu 500 werden.
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) {
      logger.error({ err }, 'Fehler in der HTTP-Schicht');
    } else {
      logger.warn({ err: err.message, statusCode }, 'Anfrage abgelehnt');
    }
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Interner Serverfehler' : 'Ungueltige Anfrage',
      message: err.message,
    });
  });

  await registerWebRoutes(server);
  registerStandaloneRoutes(server, driver, bus, registry);
  registerApiV1Routes(server, driver, bus, registry);
  registerInfoRoutes(server);
  registerPairRoutes(server);
  registerServerRoutes(server, driver, registry);
  registerActionRoutes(server, driver);
  registerStatsRoutes(server, driver);
  registerLogRoutes(server, driver, bus);

  /**
   * Echtzeit-Stream fuer Konsolenausgaben, Zustandswechsel und Metriken.
   *
   * Mit `?serverId=<id>` bekommt der Client nur die Ereignisse dieser einen
   * Instanz, ohne Filter alle. Der Token kommt aus dem Header oder aus
   * `?token=` - WebSocket-Clients im Browser koennen keine Header setzen.
   */
  server.get('/core/v1/stream', { websocket: true }, (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const serverId = url.searchParams.get('serverId');

    socket.send(
      JSON.stringify({
        type: 'connected',
        serverId: serverId ?? '*',
        ts: new Date().toISOString(),
      }),
    );

    // Nachlauf: ein Client, der sich spaeter verbindet, sieht die letzten
    // Zeilen der laufenden Instanzen - sonst waeren die Ausgaben zwischen
    // Prozessstart und Verbindungsaufbau verloren.
    const backlog: LogLine[] = serverId
      ? bus.logsFor(serverId, 50)
      : bus
          .recent(50)
          .filter((event): event is Extract<CoreEvent, { type: 'console' }> =>
            event.type === 'console',
          )
          .map((event) => ({
            serverId: event.serverId,
            line: event.line,
            stream: event.stream,
            ts: event.ts,
          }));

    for (const entry of backlog) {
      socket.send(
        JSON.stringify({
          type: 'console',
          serverId: entry.serverId,
          line: entry.line,
          stream: entry.stream,
          ts: entry.ts,
        }),
      );
    }

    const off = bus.on((event) => {
      if (serverId) {
        // Bei einem Filter kommen nur console- und state-Ereignisse des
        // gewaehlten Servers - Host-Metriken sind dann Rauschen.
        if (event.type === 'metrics') return;
        if (event.serverId !== serverId) return;
      }
      socket.send(JSON.stringify(event));
    });

    const cleanup = () => {
      off();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  return server;
}
