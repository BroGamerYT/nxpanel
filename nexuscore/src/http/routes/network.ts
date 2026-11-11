import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HostDriver } from '../../drivers/interface.js';
import { getNetwork, HOST_PATTERN, setNetwork } from '../../network.js';
import { networkCheck } from '../../network-check.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Netzwerk (Admin): oeffentliche Adresse, Port-Bereich, vergebene Ports und
 * Verbindungstest - dieselben Routen wie im Panel. Der Core hat genau einen
 * Host ("local").
 */

const patchBody = z.object({
  publicHost: z.string().trim().max(253).nullable().optional(),
  portFrom: z.number().int().min(1024).max(65535).nullable().optional(),
  portTo: z.number().int().min(1024).max(65535).nullable().optional(),
});

export interface NetworkRouteDeps {
  registry: ServerRegistry;
  driver: HostDriver;
  /** Ersetzbar fuer Tests (kein Netz). */
  check?: typeof networkCheck;
  defaultRange: { from: number; to: number };
}

export function registerNetworkRoutes(server: FastifyInstance, deps: NetworkRouteDeps): void {
  const { registry, driver, defaultRange } = deps;
  const check = deps.check ?? networkCheck;

  const nodeOf = () => {
    const n = getNetwork(registry);
    const list = registry.list();
    return {
      id: 'local',
      name: os.hostname(),
      fqdn: os.hostname(),
      ramTotalMb: Math.round(os.totalmem() / (1024 * 1024)),
      diskTotalMb: 0,
      ramAssignedMb: list.reduce((sum, c) => sum + (c.maxMemoryMb ?? 0), 0),
      servers: list.length,
      publicHost: n.publicHost,
      portFrom: n.portFrom,
      portTo: n.portTo,
    };
  };

  server.get('/api/v1/admin/nodes', async () => ({ nodes: [nodeOf()] }));

  server.patch<{ Params: { id: string } }>('/api/v1/admin/nodes/:id', async (req, reply) => {
    if (req.params.id !== 'local') return reply.status(404).send({ error: 'Host nicht gefunden', code: 'not_found' });
    const body = patchBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'Ungültige Anfrage', code: 'invalid_request' });
    const { publicHost, portFrom, portTo } = body.data;

    if (publicHost && !HOST_PATTERN.test(publicHost)) {
      return reply.status(400).send({ error: 'Ungültige Adresse: erlaubt sind Hostname oder IP ohne Port und ohne http://', code: 'invalid_host' });
    }
    // Bereich nur ganz oder gar nicht; beide leer = zurueck auf den Standard
    if ((portFrom === undefined) !== (portTo === undefined) || (portFrom === null) !== (portTo === null)) {
      return reply.status(400).send({ error: 'Port-Bereich: bitte „von“ und „bis“ angeben (oder beide leeren)', code: 'invalid_range' });
    }
    if (portFrom != null && portTo != null && portFrom > portTo) {
      return reply.status(400).send({ error: '„Von“ darf nicht größer sein als „bis“', code: 'invalid_range' });
    }

    setNetwork(registry, {
      ...(publicHost !== undefined ? { publicHost: publicHost || null } : {}),
      ...(portFrom !== undefined ? { portFrom: portFrom ?? defaultRange.from, portTo: portTo ?? defaultRange.to } : {}),
    });
    registry.audit('network.update', null, 'standalone', {
      ...(publicHost !== undefined ? { publicHost } : {}),
      ...(portFrom !== undefined ? { portFrom, portTo } : {}),
    });

    // Server ausserhalb des neuen Bereichs behalten ihre Ports - die Antwort nennt sie.
    const n = getNetwork(registry);
    const outside: Array<{ name: string; port: number }> = [];
    for (const c of registry.list()) {
      for (const p of c.ports) if (p.hostPort < n.portFrom || p.hostPort > n.portTo) outside.push({ name: c.name, port: p.hostPort });
    }
    outside.sort((a, b) => a.port - b.port);
    return { ok: true, outside };
  });

  server.get('/api/v1/admin/allocations', async () => {
    const n = getNetwork(registry);
    const states = new Map((await driver.listServers().catch(() => [])).map((s) => [s.id, s.status]));
    const rows = registry.list().flatMap((c) =>
      c.ports.map((p, idx) => ({
        port: p.hostPort,
        protocol: p.protocol,
        ref: p.name || null,
        primary: idx === 0,
        server: { id: c.id, shortId: c.id.slice(0, 8), name: c.name, status: states.get(c.id) ?? 'stopped', owner: 'admin' },
        cooldownUntil: null,
        node: os.hostname(),
        inRange: p.hostPort >= n.portFrom && p.hostPort <= n.portTo,
      })),
    );
    rows.sort((a, b) => a.port - b.port);
    return { allocations: rows };
  });

  server.get('/api/v1/admin/network/check', async () => ({ results: await check(getNetwork(registry).publicHost) }));
}
