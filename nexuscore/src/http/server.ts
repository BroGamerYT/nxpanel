import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import {
  validateRequestToken,
  normalizeRequestPath,
  isPublicRoute,
  parseCookie,
  isAllowedHost,
  isAllowedOrigin,
  isWriteMethod,
  SECURITY_HEADERS,
  CONTENT_SECURITY_POLICY,
} from '../protocol/security.js';
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
import { LocalAccount } from '../store/account.js';

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
   * Nur JSON wird als Body angenommen (Block A2).
   *
   * JSON parst Fastify selbst. Jeder andere Content-Type wird nur mit leerem
   * Body akzeptiert: Windows PowerShell schickt bei POST ohne Body einen
   * 'application/x-www-form-urlencoded'-Header mit, und solche Routen
   * brauchen gar keinen Body.
   *
   * Ein gefuellter Body mit fremdem Typ wird mit 415 abgelehnt. Frueher wurde
   * er als JSON gelesen - damit konnte jede Webseite per "simple request"
   * ('text/plain', kein Preflight) Befehle an den Core schicken.
   */
  const emptyBodyOnly = (
    _req: unknown,
    body: string | Buffer,
    done: (err: (Error & { statusCode?: number }) | null, body?: unknown) => void,
  ): void => {
    if (body.toString().trim().length === 0) {
      done(null, undefined);
      return;
    }
    const err: Error & { statusCode?: number } = new Error(
      'Nur application/json wird als Inhalt angenommen.',
    );
    err.statusCode = 415;
    done(err);
  };
  // text/plain hat in Fastify einen eingebauten Parser - der muss ersetzt werden.
  server.removeContentTypeParser('text/plain');
  server.addContentTypeParser('text/plain', { parseAs: 'string' }, emptyBodyOnly);
  server.addContentTypeParser('*', { parseAs: 'string' }, emptyBodyOnly);

  /** Sicherheits-Header auf jeder Antwort, CSP auf der ausgelieferten Oberflaeche. */
  server.addHook('onSend', async (_req, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.includes('text/html') && !reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    }
  });

  /**
   * Authentifizierung fuer alles ausser den oeffentlichen Endpunkten.
   *
   * Der Token darf als Header oder - beim WebSocket - als Query-Parameter
   * kommen, weil der Browser beim WebSocket keine Header setzen kann.
   */
  server.addHook('onRequest', async (req, reply) => {
    const normPath = normalizeRequestPath(req.url);

    // 0. DNS-Rebinding: nur bekannte Hostnamen (Block A2). Gilt auch fuer
    //    oeffentliche Routen, sonst liesse sich die Oberflaeche unter einem
    //    fremden Namen laden.
    if (!isAllowedHost(req.headers.host)) {
      return reply.status(403).send({
        error: 'Verboten',
        message: 'Unbekannter Hostname. Zusaetzliche Namen in NEXUSCORE_ALLOWED_HOSTS eintragen.',
      });
    }

    const write = isWriteMethod(req.method);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const cookieToken = parseCookie(req.headers.cookie, 'nxp_session');

    // 1. Oeffentliche Routen duerfen ohne Authentifizierung durch - schreibende
    //    aber nur mit eigener oder fehlender Herkunft (Block A2).
    if (isPublicRoute(req.method, normPath)) {
      if (write && !isAllowedOrigin(origin, req.headers.host, cookieToken !== undefined)) {
        return reply.status(403).send({
          error: 'Verboten',
          message: 'Anfrage von fremder Herkunft abgelehnt.',
        });
      }
      return;
    }

    // 2. Im Knoten-Modus (NEXUSCORE_ROLE=node) sind Panel-APIs (/api/*) generell verboten
    if (
      config.role === 'node' &&
      (normPath.startsWith('/api/v1') || normPath.startsWith('/api/panel'))
    ) {
      return reply.status(403).send({
        error: 'Verboten',
        message: 'Im Knoten-Modus (NEXUSCORE_ROLE=node) sind Panel-APIs deaktiviert.',
      });
    }

    // 3. Token ermitteln: Header > Query (WebSockets) > Cookie (Standalone UI)
    const queryToken = (req.query as Record<string, unknown> | undefined)?.token;

    const header =
      req.headers.authorization ??
      (typeof queryToken === 'string' && queryToken.length > 0
        ? `Bearer ${queryToken}`
        : cookieToken
          ? `Bearer ${cookieToken}`
          : undefined);

    // 4. Schreibende Anfragen: Herkunft pruefen (CSRF, Block A2). Kommt die
    //    Anmeldung nur aus dem Cookie, ist eine fehlende Herkunft nicht erlaubt.
    const authFromCookie =
      req.headers.authorization === undefined &&
      !(typeof queryToken === 'string' && queryToken.length > 0) &&
      cookieToken !== undefined;
    if (write && !isAllowedOrigin(origin, req.headers.host, authFromCookie)) {
      return reply.status(403).send({
        error: 'Verboten',
        message: 'Anfrage von fremder Herkunft abgelehnt.',
      });
    }

    const auth = validateRequestToken(header);
    if (!auth.valid) {
      return reply.status(401).send({
        error: 'Nicht autorisiert',
        message: auth.reason ?? 'Ungueltiger oder fehlender Token.',
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
  // Das lokale Konto gibt es nur im Standalone-Modus - im Knoten-Modus
  // steuert ausschliesslich das Panel ueber /core/v1.
  const account = config.role === 'standalone' ? await LocalAccount.open(registry.dir) : null;

  registerStandaloneRoutes(server, driver, bus, registry);
  registerApiV1Routes(server, driver, bus, registry, account);
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
