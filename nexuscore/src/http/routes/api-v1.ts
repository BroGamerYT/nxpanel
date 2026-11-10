import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HostDriver } from '../../drivers/interface.js';
import type { EventBus } from '../../protocol/events.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig, ServerStatus } from '../../types.js';
import { config } from '../../config/index.js';
import { logger } from '../../logger.js';
import {
  createSessionToken,
  isValidSessionToken,
  revokeSessionToken,
  parseCookie,
} from '../../protocol/security.js';

export const ALL_SERVER_PERMISSIONS = [
  'control.console',
  'control.command',
  'control.start',
  'control.stop',
  'control.restart',
  'control.kill',
  'file.read',
  'file.write',
  'file.delete',
  'file.archive',
  'file.sftp',
  'backup.read',
  'backup.create',
  'backup.restore',
  'backup.delete',
  'backup.download',
  'allocation.read',
  'allocation.assign',
  'startup.read',
  'startup.update',
  'startup.image',
  'schedule.read',
  'schedule.update',
  'schedule.run',
  'player.read',
  'player.kick',
  'player.ban',
  'player.whitelist',
  'subuser.read',
  'subuser.create',
  'subuser.update',
  'subuser.delete',
  'settings.rename',
  'settings.reinstall',
  'activity.read',
  'player.ip_read',
];

const KNOWN_STEAM: Record<string, number> = {
  '7 Days to Die': 251570,
  'ARK: Survival Ascended': 2399830,
  'Core Keeper': 1621690,
  'Counter-Strike 2': 730,
  'Enshrouded': 1203620,
  'Factorio': 427520,
  'Farming Simulator 25': 2300320,
  'Palworld': 1623730,
  'Rust': 252490,
  'Satisfactory': 526870,
  'Sons of the Forest': 1326470,
  'V Rising': 1604030,
  'Valheim': 892970,
};

function coverForEgg(name: string, id: string): { src: string; fit: 'banner' | 'icon'; source: 'steam' | 'branding' } {
  const appId = KNOWN_STEAM[name] || KNOWN_STEAM[id];
  if (appId) {
    return {
      src: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
      fit: 'banner',
      source: 'steam',
    };
  }
  return {
    src: '/branding/themes/amber-classic/banner.png',
    fit: 'banner',
    source: 'branding',
  };
}

interface RawEggFile {
  name: string;
  author?: string;
  nest?: string;
  docker_images?: Record<string, string>;
  startup?: string;
  console?: string;
  ports?: unknown;
  resources?: {
    base_ram_mb?: number;
    ram_per_player_mb?: number;
    min_cpu_percent?: number;
  };
  variables?: Array<{
    name: string;
    description?: string;
    env_variable: string;
    default_value?: string;
    user_viewable?: boolean;
    user_editable?: boolean;
    rules?: string;
  }>;
}

/**
 * Sucht das 'eggs'-Verzeichnis auf dem System.
 */
function resolveEggsDir(): string | null {
  let base = process.cwd();
  try {
    base = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // Fallback
  }

  const candidates = [
    path.resolve(process.cwd(), 'eggs'),
    path.resolve(process.cwd(), '..', 'eggs'),
    path.resolve(path.dirname(process.execPath), 'eggs'),
    path.resolve(path.dirname(process.execPath), '..', 'eggs'),
    path.resolve(path.dirname(process.execPath), '..', '..', 'eggs'),
    path.resolve(base, '..', '..', '..', '..', 'eggs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Liest alle Game-Eggs aus dem 'eggs'-Ordner ein.
 */
async function loadEggs() {
  const dir = resolveEggsDir();
  if (!dir) return [];

  try {
    const files = await fs.readdir(dir);
    const eggs = [];
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      try {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        const raw = JSON.parse(content) as RawEggFile;
        const id = file.replace(/\.json$/, '');
        const images = Object.entries(raw.docker_images ?? {}).map(([label, image], idx) => ({
          key: label,
          label,
          image,
          default: idx === 0,
        }));

        eggs.push({
          id,
          name: raw.name || id,
          category: raw.nest || 'Allgemein',
          author: raw.author || 'NexusPanel',
          images,
          consoleMode: raw.console || 'full',
          resources: raw.resources ?? { base_ram_mb: 1024, min_cpu_percent: 100 },
          servers: 0,
          raw,
        });
      } catch {
        // Einzelne fehlerhafte Egg-Datei überspringen
      }
    }
    return eggs;
  } catch {
    return [];
  }
}

export function registerApiV1Routes(
  server: FastifyInstance,
  driver: HostDriver,
  bus: EventBus,
  registry: ServerRegistry,
): void {
  function findServer(idOrShortId: string): ServerInstanceConfig | undefined {
    const list = registry.list();
    const exact = list.find((s) => s.id === idOrShortId);
    if (exact) return exact;
    if (idOrShortId.length === 8) {
      const byShort = list.filter((s) => s.id.slice(0, 8) === idOrShortId);
      if (byShort.length === 1) return byShort[0];
    }
    return undefined;
  }

  // 1. Authentifizierung & Sitzung
  server.post('/api/v1/auth/refresh', async (req, reply) => {
    const existingCookie = parseCookie(req.headers.cookie, 'nxp_session');
    const token = existingCookie && isValidSessionToken(existingCookie)
      ? existingCookie
      : createSessionToken();

    reply.header('Set-Cookie', `nxp_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
    return { accessToken: token };
  });

  server.get('/api/v1/auth/me', async () => {
    return {
      user: {
        id: 'standalone-admin',
        username: 'Admin',
        email: 'admin@localhost',
        role: 'admin',
        locale: 'de',
      },
      permissions: {
        'server.create': true,
        'server.view_all': true,
        'admin.nodes': true,
        'admin.users': true,
        'admin.audit': true,
        'admin.hosts': true,
        'admin.eggs': true,
        'admin.files': true,
        'admin.integrations': true,
        'admin.test_report': true,
      },
    };
  });

  server.patch('/api/v1/auth/me', async () => {
    return { ok: true };
  });

  server.post('/api/v1/auth/login', async (_req, reply) => {
    const token = createSessionToken();
    reply.header('Set-Cookie', `nxp_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
    return { accessToken: token };
  });

  server.post('/api/v1/auth/logout', async (req, reply) => {
    const existingCookie = parseCookie(req.headers.cookie, 'nxp_session');
    if (existingCookie) {
      revokeSessionToken(existingCookie);
    }
    const authHeader = req.headers.authorization;
    if (authHeader) {
      revokeSessionToken(authHeader.replace(/^Bearer\s+/i, '').trim());
    }
    reply.header('Set-Cookie', 'nxp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });

  // 2. Info & Systemstatus
  server.get('/api/v1/about', async () => {
    return {
      name: 'NexusPanel Standalone (NexusCore)',
      version: '0.2.0',
      build: 'standalone-native',
      sftp: { enabled: false, port: 2022 },
    };
  });

  server.get('/api/v1/dashboard', async () => {
    const configs = registry.list();
    const states = await driver.listServers();
    const runningCount = states.filter((s) => s.status === 'running').length;

    let totalRamMb = 0;
    const perServer: Record<string, { cpuPercent: number; memMb: number; rxRate: number; txRate: number }> = {};
    const diskUsed: Record<string, number> = {};

    for (const s of states) {
      if (s.status === 'running') {
        try {
          const stats = await driver.getServerStats(s.id);
          perServer[s.id] = {
            cpuPercent: stats.cpuPercent,
            memMb: stats.memoryMb,
            rxRate: 0,
            txRate: 0,
          };
          totalRamMb += stats.memoryMb;
        } catch {
          perServer[s.id] = { cpuPercent: 0, memMb: 0, rxRate: 0, txRate: 0 };
        }
      }
      diskUsed[s.id] = 1024; // MB Dummy
    }

    const hostRamTotalMb = Math.round(os.totalmem() / (1024 * 1024));
    const hostRamUsedMb = Math.round((os.totalmem() - os.freemem()) / (1024 * 1024));
    const hostCores = os.cpus().length;

    return {
      totals: {
        servers: configs.length,
        running: runningCount,
        ramAssignedMb: configs.reduce((acc, c) => acc + (c.maxMemoryMb ?? 2048), 0),
        cpuAssignedPercent: configs.reduce((acc, c) => acc + (c.maxCpuPercent ?? 100), 0),
        diskAssignedMb: configs.length * 10240,
        ramUsedMb: totalRamMb,
        cpuPercent: 5,
        rxRate: 0,
        txRate: 0,
        diskUsedMb: configs.length * 1024,
      },
      perServer,
      diskUsed,
      host: {
        hostname: os.hostname(),
        cpuModel: os.cpus()[0]?.model ?? 'Desktop Processor',
        cpuCores: hostCores,
        cpuPercent: 5,
        load: [0, 0, 0],
        ramTotalMb: hostRamTotalMb,
        ramUsedMb: hostRamUsedMb,
        diskTotalMb: 500000,
        diskUsedMb: 120000,
        uptimeS: Math.round(os.uptime()),
        assigned: {
          ramMb: configs.reduce((acc, c) => acc + (c.maxMemoryMb ?? 2048), 0),
          cpuPercent: configs.length * 100,
          diskMb: configs.length * 10240,
          servers: configs.length,
        },
        storage: {
          gameDataMb: configs.length * 1024,
          measuredAt: Date.now(),
          docker: null,
        },
      },
    };
  });

  // 3. Server-Verwaltung (1:1 Typkompatibilität zu ServerListItem)
  server.get('/api/v1/servers', async () => {
    const configs = registry.list();
    const states = await driver.listServers();
    const stateMap = new Map(states.map((s) => [s.id, s]));

    const servers = configs.map((c) => {
      const state = stateMap.get(c.id);
      const status: ServerStatus = state ? state.status : 'offline';
      return {
        id: c.id,
        shortId: c.id.slice(0, 8),
        name: c.name,
        status,
        ownerName: 'Admin',
        eggName: c.game || 'Eigener Gameserver',
        eggId: c.game || 'custom',
        ramMb: c.maxMemoryMb ?? 2048,
        cpuPercent: c.maxCpuPercent ?? 100,
        diskMb: 10240,
        suspended: false,
        primaryPort: c.ports[0]?.hostPort ?? 25565,
        publicHost: '127.0.0.1',
        isOwner: true,
        permissions: ALL_SERVER_PERMISSIONS,
        startedAt: state?.startedAt ?? null,
        tags: [c.game || 'game'],
        isFavorite: false,
        cover: coverForEgg(c.game || c.name, c.game || c.id),
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

  // Server Details
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id', async (req, reply) => {
    const c = findServer(req.params.id);
    if (!c) {
      return reply.status(404).send({ error: 'Server nicht gefunden', code: 'not_found' });
    }

    const state = await driver.getServerState(c.id);

    return {
      server: {
        id: c.id,
        shortId: c.id.slice(0, 8),
        name: c.name,
        status: state?.status ?? 'offline',
        ownerId: 'standalone-admin',
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
          diskMb: 10240,
          bandwidthDownloadKbps: null,
          bandwidthUploadKbps: null,
        },
        diskUsedMb: 1024,
        autoRestart: false,
        suspended: false,
        publicHost: '127.0.0.1',
        cover: coverForEgg(c.game || c.name, c.game || c.id),
        ports: c.ports.map((p, idx) => ({
          port: p.hostPort,
          protocol: p.protocol,
          ref: p.name || null,
          is_primary: idx === 0,
        })),
        startup: `${c.executable} ${c.args.join(' ')}`,
        variables: c.env || {},
      },
      permissions: ALL_SERVER_PERMISSIONS,
    };
  });

  // Server anlegen (POST /api/v1/servers)
  server.post<{
    Body: {
      name: string;
      eggId: string;
      ramMb?: number;
      cpuPercent?: number;
      diskMb?: number;
      variables?: Record<string, string>;
    };
  }>('/api/v1/servers', async (req, reply) => {
    const { name, eggId, ramMb, cpuPercent, variables } = req.body;
    if (!name || !eggId) {
      return reply.status(400).send({ error: 'Name und Game sind erforderlich.' });
    }

    // Generiere saubere ID
    const cleanId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `server-${Date.now().toString(36)}`;

    const id = registry.get(cleanId) ? `${cleanId}-${Date.now().toString(36).slice(-4)}` : cleanId;
    const serverDir = path.resolve(config.dataDir, 'servers', id);
    await fs.mkdir(serverDir, { recursive: true });

    // Port ermitteln
    const port = 25565 + registry.list().length;

    // Erstelle Standardausführung oder Script
    const isWindows = process.platform === 'win32';
    const scriptName = isWindows ? 'start.bat' : 'start.sh';
    const scriptPath = path.join(serverDir, scriptName);

    if (!existsSync(scriptPath)) {
      const scriptContent = isWindows
        ? `@echo off\necho [NexusPanel] Starte Server '${name}' (Egg: ${eggId})...\necho [NexusPanel] Server bereit auf Port ${port}!\n:loop\nping -n 5 127.0.0.1 >nul\ngoto loop\n`
        : `#!/bin/sh\necho "[NexusPanel] Starte Server '${name}' (Egg: ${eggId})..."\necho "[NexusPanel] Server bereit auf Port ${port}!"\nwhile true; do sleep 5; done\n`;
      await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });
    }

    const serverConfig: ServerInstanceConfig = {
      id,
      name,
      game: eggId,
      executable: scriptPath,
      args: [],
      workingDir: serverDir,
      maxMemoryMb: ramMb ?? 2048,
      maxCpuPercent: cpuPercent ?? 100,
      ports: [{ name: 'game', hostPort: port, protocol: 'tcp' }],
      env: variables || {},
    };

    await driver.registerServer(serverConfig);
    await registry.add(serverConfig);

    bus.emit({
      type: 'state',
      serverId: id,
      state: { id, status: 'offline' },
      ts: new Date().toISOString(),
    });

    return reply.status(201).send({
      server: {
        id,
        shortId: id.slice(0, 8),
      },
    });
  });

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

      try {
        if (action === 'start') {
          await driver.startServer(id);
        } else if (action === 'stop' || action === 'kill') {
          await driver.stopServer(id);
        } else if (action === 'restart') {
          await driver.stopServer(id).catch(() => {});
          await driver.startServer(id);
        }
        return { ok: true, status: action };
      } catch (err) {
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

  // Ticket für Server Live WebSocket
  server.post<{ Params: { id: string } }>('/api/v1/servers/:id/ws-ticket', async (req) => {
    return { ticket: `ws-ticket-${req.params.id}` };
  });

  // Server Live WebSocket
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/ws', { websocket: true }, (socket, req) => {
    const c = findServer(req.params.id);
    const id = c ? c.id : req.params.id;

    void (async () => {
      const state = await driver.getServerState(id);
      socket.send(
        JSON.stringify({
          type: 'hello',
          status: state?.status ?? 'offline',
          consoleMode: 'full',
          canCommand: true,
          name: c?.name ?? id,
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
        if (event.type === 'state') {
          socket.send(JSON.stringify({ type: 'status', status: event.state.status }));
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
            stats: {
              cpuPercent: stats.cpuPercent,
              ramMb: stats.memoryMb,
              diskMb: 1024,
              rxBytes: 0,
              txBytes: 0,
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
  server.get('/api/v1/live/ws', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'hello' }));

    const unsubscribe = bus.on((event) => {
      const serverId = 'serverId' in event ? event.serverId : null;
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
  server.get('/api/v1/tasks/active', async () => {
    return { tasks: [] };
  });

  // 4. Spielekatalog (Eggs)
  server.get('/api/v1/eggs', async () => {
    const eggs = await loadEggs();
    return {
      eggs: eggs.map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        author: e.author,
        images: e.images,
        consoleMode: e.consoleMode,
        resources: e.resources,
        servers: 0,
      })),
    };
  });

  server.get<{ Params: { id: string } }>('/api/v1/eggs/:id', async (req, reply) => {
    const eggs = await loadEggs();
    const egg = eggs.find((e) => e.id === req.params.id);
    if (!egg) {
      return reply.status(404).send({ error: 'Egg nicht gefunden' });
    }

    const variables = (egg.raw.variables ?? []).map((v) => ({
      env: v.env_variable,
      label: v.name,
      description: v.description || null,
      default: v.default_value || '',
      secret: false,
      editable: v.user_editable ?? true,
      requires: null,
      widget: 'text',
      required: false,
      type: 'string',
    }));

    return {
      egg: {
        ...egg,
        variables,
        ports: egg.raw.ports ?? {},
      },
    };
  });

  // 5. Cluster & Hosts
  server.get('/api/v1/admin/hosts', async () => {
    return {
      hosts: [
        {
          id: 'host-local',
          name: os.hostname(),
          ip: '127.0.0.1',
          cores: os.cpus().length,
          ramTotalMb: Math.round(os.totalmem() / (1024 * 1024)),
          diskTotalGb: 500,
          status: 'online',
          isLocal: true,
          serverCount: registry.list().length,
        },
      ],
    };
  });

  server.get('/api/v1/steam/accounts', async () => {
    return { accounts: [] };
  });
}
