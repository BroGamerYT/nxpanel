import { installSpecOf } from '../../install/manager.js';
import { PowerError } from '../../ops/power.js';
import type { ApiContext } from './api-context.js';

/**
 * Server steuern: Start, Stopp, Neustart, Abbruch, Konsolenbefehl, Neuinstallation.
 */
export function registerServerPowerRoutes(ctx: ApiContext): void {
  const { server, driver, registry, installs, power, findServer, stateOf } = ctx;

  // Server Power Actions (start, stop, restart, kill)
  server.post<{ Params: { id: string }; Body: { action: 'start' | 'stop' | 'restart' | 'kill' } }>(
    '/api/v1/servers/:id/power',
    async (req, reply) => {
      const c = findServer(req.params.id);
      if (!c) {
        return reply.status(404).send({ error: 'Server nicht gefunden', code: 'not_found' });
      }
      const id = c.id;
      const { action } = req.body;

      if (action !== 'start' && action !== 'stop' && action !== 'kill' && action !== 'restart') {
        return reply.status(400).send({ error: 'Unbekannte Aktion', code: 'invalid_action' });
      }
      if (c.install && c.install.state !== 'done') {
        return reply.status(409).send({
          error:
            c.install.state === 'installing'
              ? 'Der Server wird noch installiert.'
              : `Die Installation ist fehlgeschlagen: ${c.install.error ?? 'unbekannter Fehler'}. Bitte neu installieren.`,
          code: 'not_installed',
        });
      }

      try {
        await power[action](id);
        registry.audit(`server.${action}`, id, 'standalone');
        return { ok: true, status: action };
      } catch (err) {
        if (err instanceof PowerError) return reply.status(err.statusCode).send({ error: err.message, code: err.code });
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // Server Command
  server.post<{ Params: { id: string }; Body: { command: string } }>(
    '/api/v1/servers/:id/command',
    async (req, reply) => {
      const c = findServer(req.params.id);
      if (!c) {
        return reply.status(404).send({ error: 'Server nicht gefunden', code: 'not_found' });
      }
      const id = c.id;
      const { command } = req.body;
      try {
        if ('sendCommand' in driver && typeof driver.sendCommand === 'function') {
          await driver.sendCommand(id, command);
          return { ok: true };
        }
        return reply.status(400).send({ error: 'Treiber unterstützt keine Befehle' });
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // Neuinstallation: laedt Spiel und Java erneut, Welt und Einstellungen bleiben liegen.
  server.post<{ Params: { id: string } }>('/api/v1/servers/:id/reinstall', async (req, reply) => {
    const c = findServer(req.params.id);
    if (!c) return reply.status(404).send({ error: 'Server nicht gefunden', code: 'not_found' });
    if (!installs || !c.install) {
      return reply.status(400).send({ error: 'Dieser Server wurde nicht vom Core installiert.', code: 'not_installable' });
    }
    if (installs.isInstalling(c.id)) {
      return reply.status(409).send({ error: 'Der Server wird bereits installiert.', code: 'installing' });
    }
    const state = await stateOf(c.id);
    if (state && state.status !== 'offline' && state.status !== 'error') {
      return reply.status(409).send({ error: 'Bitte den Server zuerst stoppen.', code: 'running' });
    }
    const spec = installSpecOf(c.install);
    await registry.update({ ...c, install: { ...c.install, state: 'installing' } });
    registry.audit('server.reinstall', c.id, 'standalone');
    const task = installs.start(c.id, spec);
    return { ok: true, taskId: task.id };
  });
}
