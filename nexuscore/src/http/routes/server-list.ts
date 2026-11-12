import { getServerMeta } from './settings.js';
import { publicHostOf } from '../../network.js';
import { canSeeServer } from '../authz.js';
import { getAccess } from '../../store/access.js';
import { loadEggs } from '../../eggs/loader.js';
import type { ApiContext } from './api-context.js';

/**
 * Serverliste und Serverdetails.
 */
export function registerServerReadRoutes(ctx: ApiContext): void {
  const { server, driver, registry, findServer, stateOf, statusOf, coverForServer, permissionsFor, ownerNameOf, isOwnerOf } = ctx;

  // 3. Server-Verwaltung (1:1 Typkompatibilität zu ServerListItem)
  server.get('/api/v1/servers', async (req) => {
    const actor = req.actor!;
    const configs = registry.list().filter((c) => canSeeServer(registry, c.id, actor));
    const states = await driver.listServers();
    const stateMap = new Map(states.map((s) => [s.id, s]));

    const eggs = await loadEggs();
    const servers = configs.map((c) => {
      const state = stateMap.get(c.id);
      const status = statusOf(c, state?.status);
      const meta = getServerMeta(registry, c.id);
      return {
        id: c.id,
        shortId: c.id.slice(0, 8),
        name: c.name,
        status,
        ownerName: ownerNameOf(c.id),
        eggName: c.game || 'Eigener Gameserver',
        eggId: c.game || 'custom',
        ramMb: c.maxMemoryMb ?? 2048,
        cpuPercent: c.maxCpuPercent ?? 100,
        diskMb: meta.diskMb ?? 10240,
        suspended: false,
        primaryPort: c.ports[0]?.hostPort ?? 25565,
        publicHost: publicHostOf(registry),
        isOwner: isOwnerOf(c.id, actor),
        permissions: permissionsFor(c.id, actor),
        startedAt: state?.startedAt ?? null,
        tags: meta.tags ?? [c.game || 'game'],
        subdomain: meta.subdomain ?? null,
        customDomain: meta.customDomain ?? null,
        srvRecordEnabled: meta.srvRecordEnabled ?? true,
        isFavorite: meta.isFavorite ?? false,
        cover: coverForServer(c, eggs),
        ports: c.ports.map((p, idx) => ({
          port: p.hostPort,
          protocol: p.protocol,
          ref: p.name || null,
          is_primary: idx === 0,
        })),
      };
    });

    return { servers };
  });

  // Zuteilungen (Ports) des Servers
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/allocations', async (req, reply) => {
    const c = findServer(req.params.id);
    if (!c) return reply.status(404).send({ error: 'Server nicht gefunden', code: 'not_found' });
    return { allocations: c.ports.map((p, idx) => ({ port: p.hostPort, protocol: p.protocol, ref: p.name || null, is_primary: idx === 0 })) };
  });

  // Server Details
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id', async (req, reply) => {
    const c = findServer(req.params.id);
    if (!c) {
      return reply.status(404).send({ error: 'Server nicht gefunden', code: 'not_found' });
    }

    const state = await stateOf(c.id);
    const meta = getServerMeta(registry, c.id);

    return {
      server: {
        id: c.id,
        shortId: c.id.slice(0, 8),
        name: c.name,
        status: statusOf(c, state?.status),
        ownerId: getAccess(registry, c.id).ownerId ?? 'standalone-admin',
        startedAt: state?.startedAt ?? null,
        egg: {
          id: c.game,
          name: c.game,
          consoleMode: 'full',
          webInterface: null,
          hints: [],
          gameKind: c.game?.toLowerCase().includes('minecraft') ? 'minecraft' : null,
        },
        limits: {
          ramMb: c.maxMemoryMb ?? 2048,
          swapMb: 0,
          cpuPercent: c.maxCpuPercent ?? 100,
          diskMb: meta.diskMb ?? 10240,
          bandwidthDownloadKbps: meta.bandwidthDownloadKbps ?? null,
          bandwidthUploadKbps: meta.bandwidthUploadKbps ?? null,
        },
        diskUsedMb: 1024,
        autoRestart: false,
        autoSleepMinutes: 0,
        tags: meta.tags ?? [],
        isFavorite: meta.isFavorite ?? false,
        subdomain: meta.subdomain ?? null,
        customDomain: meta.customDomain ?? null,
        srvRecordEnabled: meta.srvRecordEnabled ?? true,
        suspended: false,
        publicHost: publicHostOf(registry),
        cover: coverForServer(c, await loadEggs()),
        ports: c.ports.map((p, idx) => ({
          port: p.hostPort,
          protocol: p.protocol,
          ref: p.name || null,
          is_primary: idx === 0,
        })),
        startup: `${c.executable} ${c.args.join(' ')}`,
        variables: { ...(c.env ?? {}), ...(c.install?.variables ?? {}) },
      },
      permissions: permissionsFor(c.id, req.actor!),
    };
  });
}
