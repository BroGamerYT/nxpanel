import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { createPairingPin, currentPairingPin } from '../../protocol/security.js';
import { PathOutsideRootError, resolveInsideRoot, serverRootFor } from '../../protocol/paths.js';
import { FirewallError, type FirewallManager } from '../../system/firewall.js';
import { programOf } from '../../system/firewall-auto.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';

/**
 * Firewall-Freigaben je Spiel-Programm und Kopplungs-PIN fuer das Systray-Symbol (beides Admin).
 * Die Rechte stehen in authz.ts: Firewall mit dem Recht "admin.nodes", die PIN nur fuer Administratoren.
 */

export interface FirewallRouteDeps {
  registry: ServerRegistry;
  firewall: FirewallManager;
}

export function registerFirewallRoutes(server: FastifyInstance, deps: FirewallRouteDeps): void {
  const { registry, firewall } = deps;

  server.get('/api/v1/admin/firewall', async () => {
    const records = await firewall.records();
    const servers = [];
    for (const instance of registry.list()) {
      const program = await programOf(registry, instance);
      const rec = records.find((r) => r.serverId === instance.id);
      servers.push({
        serverId: instance.id,
        name: instance.name,
        program,
        rule: rec ? { name: rec.name, program: rec.program, createdAt: rec.createdAt, active: await firewall.exists(rec.name) } : null,
      });
    }
    return { available: firewall.available, ...(firewall.reason ? { reason: firewall.reason } : {}), servers };
  });

  server.post<{ Params: { id: string } }>('/api/v1/admin/firewall/:id', async (req, reply) => {
    const instance = registry.get(req.params.id);
    if (!instance) return reply.status(404).send({ error: 'Server nicht gefunden', code: 'not_found' });
    const program = await programOf(registry, instance);
    if (!program) {
      return reply.status(400).send({ error: 'Das Programm des Servers wurde nicht gefunden (oder liegt nicht im Server-Verzeichnis).', code: 'invalid_program' });
    }
    try {
      const rule = await firewall.open(instance.id, program);
      registry.audit('firewall.open', instance.id, 'standalone', { program });
      return { ok: true, rule };
    } catch (err) {
      if (err instanceof FirewallError) {
        const status = err.code === 'needs_admin' ? 403 : err.code === 'unsupported' ? 400 : 500;
        return reply.status(status).send({ error: err.message, message: err.message, code: err.code, ...(err.command ? { command: err.command } : {}) });
      }
      throw err;
    }
  });

  server.delete<{ Params: { id: string } }>('/api/v1/admin/firewall/:id', async (req, reply) => {
    const result = await firewall.closeServer(req.params.id);
    if (result.failed.length) {
      return reply.status(500).send({ error: 'Nicht alle Regeln liessen sich entfernen.', code: 'failed', ...result });
    }
    registry.audit('firewall.close', req.params.id, 'standalone', { removed: result.removed });
    return { ok: true, ...result };
  });

  // Kopplungs-PIN fuer das Systray-Symbol: gilt zehn Minuten, "neu" erzeugt sie sofort
  server.get('/api/v1/admin/pairing', async () => ({ pin: currentPairingPin(), validForSeconds: 600 }));
  server.post('/api/v1/admin/pairing/renew', async () => ({ pin: createPairingPin(), validForSeconds: 600 }));
}
