import { canSeeServer, flagsFor } from '../authz.js';
import type { ApiContext } from './api-context.js';

/**
 * Live-Verbindungen (WebSocket) je Server und global, mit Einmal-Ticket.
 */
export function registerLiveRoutes(ctx: ApiContext): void {
  const { server, driver, bus, registry, policy, findServer, stateOf, statusOf, connectionStillValid } = ctx;

  // Ticket für Server Live WebSocket
  server.post<{ Params: { id: string } }>('/api/v1/servers/:id/ws-ticket', async (req) => {
    return { ticket: `ws-ticket-${req.params.id}` };
  });

  // Server Live WebSocket
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/ws', { websocket: true }, (socket, req) => {
    const c = findServer(req.params.id);
    if (!c) {
      socket.send(JSON.stringify({ type: 'error', code: 'not_found', message: 'Server nicht gefunden' }));
      socket.close(1008, 'Server nicht gefunden');
      return;
    }
    const id = c.id;
    const wsActor = req.actor!;
    const mayCommand = (): boolean => connectionStillValid(req) && flagsFor(registry, id, wsActor, policy).includes('control.command');

    void (async () => {
      const state = await stateOf(id);
      socket.send(
        JSON.stringify({
          type: 'hello',
          status: statusOf(c, state?.status),
          consoleMode: 'full',
          canCommand: mayCommand(),
          name: c.name,
          startedAt: state?.startedAt ?? null,
        }),
      );

      // Sende historische Logs
      const logs = bus.logsFor(id, 50);
      if (logs.length > 0) {
        socket.send(JSON.stringify({ type: 'log', lines: logs.map((l) => l.line), history: true }));
      }
    })();

    // Event Bus Listener
    const unsubscribe = bus.on((event) => {
      if ('serverId' in event && event.serverId === id) {
        if (!connectionStillValid(req) || !flagsFor(registry, id, wsActor, policy).includes('control.console')) {
          socket.close(1008, 'Keine Berechtigung mehr');
          return;
        }
        if (event.type === 'state') {
          // Wie in Liste und Detail: Installation und Fehlerzustand in Werte uebersetzen,
          // die die Oberflaeche kennt. Der Stand der Installation steht in der Registry.
          const status = statusOf(registry.get(id) ?? c, event.state.status);
          socket.send(JSON.stringify({ type: 'status', status }));
        } else if (event.type === 'console') {
          socket.send(JSON.stringify({ type: 'log', lines: [event.line] }));
        }
      }
    });

    // Stats-Intervall (alle 2s)
    const statsTimer = setInterval(async () => {
      try {
        const stats = await driver.getServerStats(id);
        socket.send(
          JSON.stringify({
            type: 'stats',
            // Genau die Felder, die die Oberflaeche liest (ContainerStats im Panel,
            // `Stats` in web/src/lib/types.ts). Mit anderen Namen steht dort
            // "undefined MB". Der Netzwerkverkehr je Prozess wird nicht gemessen.
            stats: {
              cpuPercent: stats.cpuPercent,
              memMb: stats.memoryMb,
              memLimitMb: c.maxMemoryMb ?? 2048,
              netRxBytes: 0,
              netTxBytes: 0,
            },
            ts: Date.now(),
          }),
        );
      } catch {
        // Ignorieren falls offline
      }
    }, 2000);

    // Eingehende Befehle aus der Konsole
    socket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'command' && msg.data) {
          if (!mayCommand()) {
            socket.send(JSON.stringify({ type: 'error', code: 'forbidden', message: 'Dafür fehlt dir die Berechtigung.' }));
            return;
          }
          if ('sendCommand' in driver && typeof driver.sendCommand === 'function') {
            await driver.sendCommand(id, msg.data);
          }
        }
      } catch {
        // Ignorieren
      }
    });

    socket.on('close', () => {
      clearInterval(statsTimer);
      unsubscribe();
    });
  });

  // Ticket für Global Live WebSocket
  server.post('/api/v1/live/ws-ticket', async () => {
    return { ticket: 'global-live-ticket' };
  });

  // Global Live WebSocket
  server.get('/api/v1/live/ws', { websocket: true }, (socket, req) => {
    socket.send(JSON.stringify({ type: 'hello' }));
    const liveActor = req.actor!;

    const unsubscribe = bus.on((event) => {
      const serverId = 'serverId' in event ? event.serverId : null;
      if (!connectionStillValid(req)) {
        socket.close(1008, 'Sitzung beendet');
        return;
      }
      // Ereignisse eines Servers bekommt nur, wer ihn sehen darf
      if (serverId && !canSeeServer(registry, serverId, liveActor)) return;
      if (!serverId && !liveActor.master && liveActor.role === 'user') return;
      socket.send(
        JSON.stringify({
          type: 'event',
          event: {
            id: Date.now(),
            serverId,
            kind: event.type,
            severity: 'info',
            summary: `Ereignis: ${event.type}`,
            ts: new Date().toISOString(),
          },
        }),
      );
    });

    socket.on('close', () => {
      unsubscribe();
    });
  });
}
