import os from 'node:os';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { HostDriver } from '../../drivers/interface.js';
import { getSystemMetrics } from '../../system/monitor.js';
import type { ServerRegistry } from '../../store/registry.js';
import { HostError, type RemoteHosts } from '../../hosts/remote.js';

/**
 * Hosts (Admin). Dieser Rechner ist immer der Host "local". Andere Cores lassen sich koppeln (Adresse + Token): dann
 * zeigt dieser Core ihren Status und ihre Server und kann dort Server anlegen, starten, stoppen und beenden - mehr nicht.
 * Ohne Kopplung ist jeder Core eigenstaendig.
 */

const LOCAL_ID = 'local';

const createBody = z.object({
  name: z.string().trim().min(1).max(64),
  address: z.string().trim().min(1).max(300),
  token: z.string().min(1).max(512),
  pin: z.string().trim().max(32).optional(),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  address: z.string().trim().min(1).max(300).optional(),
  token: z.string().min(1).max(512).optional(),
});
const powerBody = z.object({ action: z.enum(['start', 'stop', 'kill']) });
const serverBody = z.object({
  name: z.string().trim().min(1).max(64),
  eggId: z.string().trim().min(1).max(100),
  ramMb: z.number().int().min(64).max(1_048_576).optional(),
  cpuPercent: z.number().int().min(1).max(10_000).optional(),
  variables: z.record(z.string()).optional(),
  imageKey: z.string().trim().max(100).optional(),
});

export function registerHostRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; driver: HostDriver; dataDir: string; remote: RemoteHosts }): void {
  const { registry, driver, dataDir, remote } = deps;
  const fail = (reply: FastifyReply, status: number, message: string, code: string): FastifyReply => reply.status(status).send({ error: message, message, code });
  const guarded = async <T>(reply: FastifyReply, run: () => T | Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof HostError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  };
  const isLocal = (id: string): boolean => id === LOCAL_ID;
  const notFound = (reply: FastifyReply): FastifyReply => fail(reply, 404, 'Host nicht gefunden', 'not_found');
  const localOnly = (reply: FastifyReply): FastifyReply => fail(reply, 400, 'Das ist dieser Rechner - dafür gelten die normalen Server-Routen.', 'local_host');

  async function hostRow() {
    const m = await getSystemMetrics(dataDir);
    return {
      id: LOCAL_ID,
      name: os.hostname(),
      type: 'local' as const,
      address: `Dieser Rechner (${driver.name})`,
      runtime: driver.name,
      status: 'online' as const,
      certFingerprint: null,
      lastSeenAt: new Date().toISOString(),
      ramTotalMb: m.totalMemoryMb,
      ramUsedMb: m.usedMemoryMb,
      diskTotalMb: Math.round(m.diskTotalGb * 1024),
      diskUsedMb: Math.round((m.diskTotalGb - m.diskFreeGb) * 1024),
      cpuPercent: m.cpuUsagePercent,
      servers: registry.list().length,
    };
  }

  server.get('/api/v1/admin/hosts', async () => ({ hosts: [await hostRow(), ...remote.list()] }));

  server.post<{ Body: unknown }>('/api/v1/admin/hosts', async (req, reply) => {
    const body = createBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    return guarded(reply, async () => {
      const host = await remote.create(body.data);
      registry.audit('host.create', null, 'standalone', { name: host.name, address: host.address });
      return { host };
    });
  });

  server.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/admin/hosts/:id', async (req, reply) => {
    if (isLocal(req.params.id)) return fail(reply, 400, 'Der lokale Host kann nicht geändert werden', 'local_host');
    const body = patchBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    return guarded(reply, async () => {
      const host = await remote.update(req.params.id, body.data);
      registry.audit('host.update', null, 'standalone', { hostId: host.id, ...(body.data.name !== undefined ? { name: body.data.name } : {}), ...(body.data.token !== undefined ? { token: 'geändert' } : {}) });
      return { host };
    });
  });

  server.delete<{ Params: { id: string } }>('/api/v1/admin/hosts/:id', async (req, reply) => {
    if (isLocal(req.params.id)) return fail(reply, 400, 'Der lokale Host kann nicht entfernt werden', 'local_host');
    return guarded(reply, () => {
      remote.delete(req.params.id);
      registry.audit('host.delete', null, 'standalone', { hostId: req.params.id });
      return { ok: true };
    });
  });

  server.post<{ Params: { id: string } }>('/api/v1/admin/hosts/:id/check', async (req, reply) => {
    if (isLocal(req.params.id)) return { host: await hostRow() };
    return guarded(reply, async () => ({ host: await remote.refresh(req.params.id) }));
  });

  server.get<{ Params: { id: string } }>('/api/v1/admin/hosts/:id/servers', async (req, reply) => {
    if (isLocal(req.params.id)) {
      const states = new Map((await driver.listServers().catch(() => [])).map((s) => [s.id, s.status]));
      return { servers: registry.list().map((c) => ({ id: c.id, name: c.name, game: c.game, status: states.get(c.id) ?? 'offline' })) };
    }
    return guarded(reply, async () => ({ servers: await remote.servers(req.params.id) }));
  });

  // ---- Auf einem gekoppelten Core: Server anlegen, starten, stoppen, beenden

  server.post<{ Params: { id: string }; Body: unknown }>('/api/v1/admin/hosts/:id/servers', async (req, reply) => {
    if (isLocal(req.params.id)) return localOnly(reply);
    if (!remote.has(req.params.id)) return notFound(reply);
    const body = serverBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    return guarded(reply, async () => {
      const res = await remote.createServer(req.params.id, body.data);
      registry.audit('host.server_create', null, 'standalone', { hostId: req.params.id, name: body.data.name, eggId: body.data.eggId });
      reply.status(201);
      return { ok: true, ...res };
    });
  });

  server.post<{ Params: { id: string; serverId: string }; Body: unknown }>('/api/v1/admin/hosts/:id/servers/:serverId/power', async (req, reply) => {
    if (isLocal(req.params.id)) return localOnly(reply);
    if (!remote.has(req.params.id)) return notFound(reply);
    const body = powerBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, 'Aktion: start, stop oder kill', 'invalid_request');
    return guarded(reply, async () => {
      await remote.power(req.params.id, req.params.serverId, body.data.action);
      registry.audit('host.server_power', null, 'standalone', { hostId: req.params.id, serverId: req.params.serverId, action: body.data.action });
      return { ok: true };
    });
  });
}
