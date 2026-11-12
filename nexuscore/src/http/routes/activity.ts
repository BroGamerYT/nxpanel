import { canSeeServer } from '../authz.js';
import type { ApiContext } from './api-context.js';

/**
 * Aufgaben, Aktivität und Platzhalter-Routen, die die Oberfläche abfragt.
 */
export function registerActivityRoutes(ctx: ApiContext): void {
  const { server, registry, backups, findServer, toActiveTask } = ctx;

  // Die Oberflaeche fragt das alle paar Sekunden ab - leer statt 404.
  server.get('/api/v1/notifications', async () => ({ items: [] }));
  server.post('/api/v1/presence/ping', async () => ({ ok: true }));
  // Wer ist gerade online? Der Core merkt sich das nicht: leere Liste, wie die Oberflaeche sie erwartet
  server.get('/api/v1/presence', async () => ({ online: [], total: 0 }));
  // Netzwerkverlauf: der Core zeichnet ihn nicht auf. Ohne Punkte zeigt die Oberflaeche nichts an.
  server.get('/api/v1/servers/:id/history', async () => ({ step: 10_000, points: [] }));

  // Dummy-Zusatz-Routen für ServerPage
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/presence', async () => {
    return { online: false, players: [] };
  });
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/events', async () => {
    return { events: [] };
  });
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/activity', async () => {
    return { activity: [] };
  });
  server.get('/api/v1/tasks/active', async (req) => {
    const actor = req.actor!;
    const all = [...registry.listTasks({ active: true }).map(toActiveTask), ...backups.activeTasks()];
    // Aufgaben ohne Server (Core-weit) sehen nur Verwalter
    return { tasks: all.filter((t) => (t.serverId ? canSeeServer(registry, t.serverId, actor) : actor.master || actor.role !== 'user')) };
  });

  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/tasks/active', async (req, reply) => {
    const c = findServer(req.params.id);
    if (!c) return reply.status(404).send({ error: 'Server nicht gefunden', code: 'not_found' });
    return { tasks: [...registry.listTasks({ active: true, serverId: c.id }).map(toActiveTask), ...backups.activeTasks(c.id)] };
  });

  // 5. Hosts: siehe routes/hosts.ts

}
