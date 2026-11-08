import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { randomBytes } from 'node:crypto';
import { sql } from '../../db/index.js';
import { log } from '../../log.js';
import { eventBus, type LiveEvent } from '../../events.js';
import { writeAudit } from '../../audit.js';
import { loadAuthContext } from '../../auth/users.js';
import { can } from '../../auth/permissions.js';
import { loadServerForActor } from '../../servers/access.js';
import type { ContainerStats } from '../../docker/client.js';
import { requireServer } from '../auth.js';
import { followFile, logFilePath, tailFile } from '../../servers/logfile.js';
import { statsCollector } from '../../servers/stats.js';

/**
 * Live-Verbindung zu einem Server: Konsole, Statuswechsel, Auslastung.
 *
 * Anmeldung in zwei Schritten (wie im Konzept): der Client holt sich mit
 * seinem normalen Token ein Einmal-Ticket (60 s, an Nutzer und Server
 * gebunden) und oeffnet damit den WebSocket. Browser koennen beim
 * WebSocket-Aufbau keinen Authorization-Header setzen; der Zugangstoken
 * selbst soll aber nicht in URLs und damit in Proxy-Logs landen.
 */

/** Was die Konsole von Docker braucht - fuer Tests austauschbar. */
export interface ConsoleEngine {
  tailLogs(containerId: string, lines: number): Promise<string[]>;
  streamLogs(containerId: string, onLine: (l: string) => void, onEnd?: () => void): Promise<() => void>;
  streamStats(containerId: string, onStats: (s: ContainerStats) => void): Promise<() => void>;
  sendToStdin(containerId: string, text: string): Promise<void>;
}

interface Ticket { userId: string; sessionId: string; serverId: string; expires: number }
const tickets = new Map<string, Ticket>();
const TICKET_TTL_MS = 60_000;

const HISTORY_LINES = 200;
const FLUSH_MS = 100;
const MAX_BATCH = 500;
const STATS_EVERY_MS = 2_000;
const RECHECK_MS = 30_000;
const COMMAND_LIMIT = { max: 20, windowMs: 10_000 };

export type ServerMessage =
  | { type: 'hello'; status: string; consoleMode: string; canCommand: boolean; name: string }
  | { type: 'log'; lines: string[]; history?: boolean; dropped?: number }
  | { type: 'status'; status: string }
  | { type: 'event'; event: Omit<LiveEvent, 'serverId'> }
  | { type: 'stats'; stats: ContainerStats; ts: number }
  | { type: 'error'; message: string; code?: string };

export async function consoleRoutes(app: FastifyInstance, opts: { engine: ConsoleEngine }) {
  const { engine } = opts;

  app.post<{ Params: { id: string } }>('/servers/:id/ws-ticket', { preHandler: requireServer('control.console') }, async (req) => {
    sweep();
    const ticket = randomBytes(24).toString('base64url');
    tickets.set(ticket, { userId: req.actor!.id, sessionId: req.actor!.sessionId, serverId: req.target!.server.id, expires: Date.now() + TICKET_TTL_MS });
    return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
  });

  app.get<{ Params: { id: string }; Querystring: { ticket?: string } }>('/servers/:id/ws', { websocket: true }, async (socket, req) => {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const fail = (code: number, message: string) => {
      send({ type: 'error', message });
      socket.close(code, message.slice(0, 120));
    };
    // IP beim Aufbau merken - spaeter haengt am Request kein Socket mehr.
    let ip: string | undefined;
    try { ip = req.ip; } catch { ip = undefined; }
    // Einen Takt warten: wer sofort schliesst, bevor der Client fertig
    // verbunden ist, liefert ihm weder Fehlermeldung noch Close-Code.
    await new Promise((r) => setImmediate(r));

    // ---- Ticket einloesen (einmalig)
    const t = req.query.ticket ? tickets.get(req.query.ticket) : undefined;
    if (req.query.ticket) tickets.delete(req.query.ticket);
    if (!t || t.expires < Date.now()) return fail(4401, 'Ticket ungueltig oder abgelaufen');

    const actor = await loadAuthContext(t.userId, t.sessionId);
    if (!actor) return fail(4401, 'Sitzung beendet');
    const target = await loadServerForActor(req.params.id, actor);
    if (!target || target.server.id !== t.serverId || !can(actor, target.access, 'control.console')) {
      return fail(4403, 'Kein Zugriff');
    }

    const serverId = target.server.id;
    const [egg] = await sql<{ console_mode: string; log_file: string | null }[]>`
      SELECT console_mode, raw_egg->>'log_file' AS log_file FROM eggs WHERE id = ${target.server.egg_id}`;
    // Eigene Logdatei des Spiels (ARK) zusaetzlich mitlesen - dort stehen die eigentlichen Meldungen.
    const gameLog = egg?.log_file ? logFilePath(target.server.short_id, egg.log_file) : null;
    let stopFile: (() => void) | null = null;
    const consoleMode = egg?.console_mode ?? 'full';
    let status = target.server.status;
    let access = target.access;

    send({
      type: 'hello', status, consoleMode, name: target.server.name,
      canCommand: consoleMode === 'full' && can(actor, access, 'control.command'),
    });

    // ---- Log: Verlauf, dann live, gebuendelt
    let pending: string[] = [];
    let dropped = 0;
    let stopLogs: (() => void) | null = null;
    let stopStats: (() => void) | null = null;
    let lastStats = 0;
    let closed = false;

    const flushTimer = setInterval(() => {
      if (!pending.length && !dropped) return;
      send({ type: 'log', lines: pending, ...(dropped ? { dropped } : {}) });
      pending = [];
      dropped = 0;
    }, FLUSH_MS);

    const pushLine = (l: string) => {
      pending.push(l);
      // Flutet ein Server die Ausgabe, lieber Zeilen auslassen (und es sagen)
      // als den Browser einfrieren.
      if (pending.length > MAX_BATCH * 4) {
        const cut = pending.length - MAX_BATCH;
        pending = pending.slice(cut);
        dropped += cut;
      }
    };

    async function containerId() {
      const [r] = await sql<{ container_id: string | null }[]>`SELECT container_id FROM servers WHERE id = ${serverId}`;
      return r?.container_id ?? null;
    }

    async function attachLogs(withHistory: boolean) {
      stopLogs?.();
      stopLogs = null;
      const cid = await containerId();
      if (!cid || closed) return;
      try {
        if (withHistory) {
          const history = await engine.tailLogs(cid, HISTORY_LINES);
          if (history.length) send({ type: 'log', lines: history, history: true });
        }
        stopLogs = await engine.streamLogs(cid, pushLine, () => { stopLogs = null; });
      } catch (err) {
        log.debug({ err, serverId }, 'Log-Strom nicht verfuegbar');
      }
      if (gameLog && !stopFile) {
        if (withHistory) {
          const old = await tailFile(gameLog, HISTORY_LINES);
          if (old.length) send({ type: 'log', lines: old, history: true });
        }
        stopFile = followFile(gameLog, pushLine);
      }
    }

    async function attachStats() {
      stopStats?.();
      stopStats = null;
      const cached = statsCollector.snapshot().get(serverId);
      if (cached && !closed) {
        send({
          type: 'stats',
          stats: {
            cpuPercent: cached.cpuPercent,
            memMb: cached.memMb,
            memLimitMb: cached.memLimitMb,
            netRxBytes: 0,
            netTxBytes: 0,
          },
          ts: cached.at,
        });
      }
      const cid = await containerId();
      if (!cid || closed) return;
      try {
        stopStats = await engine.streamStats(cid, (s) => {
          const now = Date.now();
          if (now - lastStats < STATS_EVERY_MS) return;
          lastStats = now;
          send({ type: 'stats', stats: s, ts: now });
        });
      } catch (err) {
        log.debug({ err, serverId }, 'Statistik nicht verfuegbar');
      }
    }

    await attachLogs(true);
    if (status === 'running' || status === 'starting') await attachStats();

    // ---- Zeitachse und Statuswechsel live
    const onEvent = (e: LiveEvent) => {
      if (e.serverId !== serverId) return;
      const { serverId: _s, ...rest } = e;
      send({ type: 'event', event: rest });
      if (e.kind === 'status_change' && typeof e.payload?.to === 'string') {
        const to = e.payload.to;
        status = to as typeof status;
        send({ type: 'status', status: to });
        // Neuer Containerlauf = neuer Log-Strom; der alte endete mit dem Prozess.
        if (to === 'starting' || to === 'installing') void attachLogs(false);
        if (to === 'starting' || to === 'running') void attachStats();
        if (to === 'offline' || to === 'crashed') { stopStats?.(); stopStats = null; }
      }
    };
    eventBus.on('event', onEvent);

    // ---- Rechte regelmaessig nachpruefen: Entzug wirkt auch auf offene Verbindungen
    const recheck = setInterval(async () => {
      const a = await loadAuthContext(t.userId, t.sessionId);
      const tg = a ? await loadServerForActor(serverId, a) : null;
      if (!a || !tg || !can(a, tg.access, 'control.console')) return fail(4403, 'Zugriff entzogen');
      access = tg.access;
    }, RECHECK_MS);

    // ---- Befehle vom Client
    let cmdWindow = { start: Date.now(), count: 0 };
    socket.on('message', async (raw: Buffer) => {
      let msg: { type?: string; data?: unknown };
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return send({ type: 'error', message: 'Ungueltige Nachricht' }); }
      if (msg.type !== 'command') return;

      const cmd = typeof msg.data === 'string' ? msg.data.replace(/[\r\n]+/g, ' ').trim() : '';
      if (!cmd || cmd.length > 1024) return send({ type: 'error', message: 'Befehl leer oder zu lang', code: 'invalid_command' });
      if (consoleMode !== 'full') return send({ type: 'error', message: 'Dieses Spiel nimmt keine Konsolenbefehle an', code: 'console_readonly' });

      // Frisch pruefen - Rechte koennen sich seit dem Verbindungsaufbau geaendert haben.
      const a = await loadAuthContext(t.userId, t.sessionId);
      const tg = a ? await loadServerForActor(serverId, a) : null;
      if (!a || !tg || !can(a, tg.access, 'control.command')) return send({ type: 'error', message: 'Fehlendes Recht: control.command', code: 'forbidden' });
      if (tg.server.status !== 'running' && tg.server.status !== 'starting') {
        return send({ type: 'error', message: 'Server laeuft nicht', code: 'not_running' });
      }

      const now = Date.now();
      if (now - cmdWindow.start > COMMAND_LIMIT.windowMs) cmdWindow = { start: now, count: 0 };
      if (++cmdWindow.count > COMMAND_LIMIT.max) return send({ type: 'error', message: 'Zu viele Befehle - kurz warten', code: 'rate_limited' });

      try {
        await engine.sendToStdin(tg.server.container_id!, cmd);
        // Echo, damit man in der Konsole sieht, wer was eingegeben hat.
        pushLine(`> ${cmd}`);
        await writeAudit({ userId: a.id, serverId, actorName: a.username, action: 'server.command', ip, metadata: { command: cmd } });
      } catch (err) {
        send({ type: 'error', message: `Befehl nicht zugestellt: ${err instanceof Error ? err.message : err}` });
      }
    });

    socket.on('close', () => {
      closed = true;
      stopFile?.();
      clearInterval(flushTimer);
      clearInterval(recheck);
      eventBus.off('event', onEvent);
      stopLogs?.();
      stopStats?.();
    });
  });
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
}

