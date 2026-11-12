import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { DnsError, DnsService, SUBDOMAIN_PATTERN } from '../../network/dns.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';
import { getServerMeta, saveServerMeta } from './settings.js';

/**
 * Domain und DNS - dieselben Routen wie im Panel: Einstellungen, Test und Abgleich fuer Administratoren
 * (Recht "Netzwerk"), Subdomain je Server (Recht allocation.assign). Der API-Token geht nie in eine Antwort.
 */

const provider = z.enum(['none', 'cloudflare', 'hetzner', 'duckdns', 'webhook']);

const patchBody = z.object({
  provider: provider.optional(),
  apiToken: z.string().trim().max(500).nullable().optional(),
  zoneId: z.string().trim().max(100).nullable().optional(),
  rootDomain: z.string().trim().toLowerCase().max(253).nullable().optional(),
  autoSync: z.boolean().optional(),
  webhookUrl: z.string().trim().max(500).nullable().optional(),
});

const testBody = z.object({
  provider: z.enum(['cloudflare', 'hetzner', 'duckdns', 'webhook']),
  apiToken: z.string().trim().max(500).optional(),
  rootDomain: z.string().trim().toLowerCase().max(253),
  zoneId: z.string().trim().max(100).optional(),
});

const domainBody = z.object({
  subdomain: z.string().trim().toLowerCase().regex(SUBDOMAIN_PATTERN, 'Ungültige Subdomain (nur a-z, 0-9 und Bindestrich, bis 32 Zeichen)').nullable().optional(),
  customDomain: z.string().trim().toLowerCase().max(128).nullable().optional(),
  srvRecordEnabled: z.boolean().optional(),
});

export interface DnsRouteDeps {
  registry: ServerRegistry;
  dns: DnsService;
  find: (id: string) => ServerInstanceConfig | undefined;
}

export function registerDnsRoutes(server: FastifyInstance, deps: DnsRouteDeps): void {
  const { registry, dns, find } = deps;
  const fail = (reply: FastifyReply, status: number, message: string, code: string): FastifyReply => reply.status(status).send({ error: message, message, code });
  const handle = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof DnsError) return fail(reply, err.statusCode, err.message, err.code);
    return fail(reply, 502, err instanceof Error ? err.message : String(err), 'dns_error');
  };

  server.get('/api/v1/admin/network/dns', async () => ({ config: dns.view(), targets: dns.targets() }));

  server.patch<{ Body: unknown }>('/api/v1/admin/network/dns', async (req, reply) => {
    const body = patchBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    try {
      dns.save(body.data);
    } catch (err) {
      return handle(reply, err);
    }
    // Ins Protokoll nur, WAS sich geaendert hat - nie der Token
    registry.audit('dns.update', null, 'standalone', { provider: body.data.provider, domain: body.data.rootDomain, ...(body.data.apiToken !== undefined ? { token: body.data.apiToken ? 'gesetzt' : 'entfernt' } : {}) });
    return { ok: true };
  });

  server.post<{ Body: unknown }>('/api/v1/admin/network/dns/test', async (req, reply) => {
    const body = testBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, 'Anbieter und Domain angeben', 'invalid_request');
    try {
      return await dns.test(body.data);
    } catch (err) {
      return handle(reply, err);
    }
  });

  server.post('/api/v1/admin/network/dns/sync', async (_req, reply) => {
    try {
      const res = await dns.sync();
      registry.audit('dns.sync', null, 'standalone', { updated: res.updated, ip: res.ip });
      return res;
    } catch (err) {
      return handle(reply, err);
    }
  });

  server.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/servers/:id/domain', async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const body = domainBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    const sub = body.data.subdomain === undefined ? undefined : body.data.subdomain || null;
    const custom = body.data.customDomain === undefined ? undefined : body.data.customDomain || null;
    if (sub) {
      const taken = registry.list().some((o) => o.id !== c.id && getServerMeta(registry, o.id).subdomain === sub);
      if (taken) return fail(reply, 409, `Die Subdomain "${sub}" ist bereits für einen anderen Server vergeben`, 'subdomain_taken');
    }
    const meta = getServerMeta(registry, c.id);
    const next = {
      ...(sub !== undefined ? { subdomain: sub } : {}),
      ...(custom !== undefined ? { customDomain: custom } : {}),
      ...(body.data.srvRecordEnabled !== undefined ? { srvRecordEnabled: body.data.srvRecordEnabled } : {}),
    };
    saveServerMeta(registry, c.id, next);
    registry.audit('server.domain_update', c.id, 'standalone', { subdomain: sub, customDomain: custom, srvRecordEnabled: body.data.srvRecordEnabled });
    // Im Hintergrund abgleichen; ein Fehler steht danach im Stand des Abgleichs
    void dns.sync().catch(() => {});
    return {
      ok: true,
      subdomain: sub !== undefined ? sub : meta.subdomain ?? null,
      customDomain: custom !== undefined ? custom : meta.customDomain ?? null,
      srvRecordEnabled: body.data.srvRecordEnabled ?? meta.srvRecordEnabled ?? true,
    };
  });
}
