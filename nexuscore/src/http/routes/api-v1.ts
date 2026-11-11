import type { FastifyInstance, FastifyRequest } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  revokeUserSessions,
  parseCookie,
  SESSION_TTL_MS,
} from '../../protocol/security.js';
import { serverRootFor, resolveInsideRoot, PathOutsideRootError } from '../../protocol/paths.js';
import { allocatePort } from '../../protocol/ports.js';
import type { LocalAccount } from '../../store/account.js';
import { installPlanFor, installSpecOf, type InstallManager } from '../../install/manager.js';
import { writeServerProperties } from '../../install/minecraft.js';
import { registerFileRoutes } from './files.js';
import { getServerMeta, registerSettingsRoutes } from './settings.js';
import { registerLogFileRoutes } from './log-files.js';
import { registerScheduleRoutes } from './schedules.js';
import { Scheduler } from '../../schedules/scheduler.js';
import { PowerError, createPowerOps } from '../../ops/power.js';
import { findInstance } from '../../store/find.js';
import { BackupManager } from '../../backups/manager.js';
import { registerBackupRoutes } from './backups.js';
import { registerAdminRoutes } from './admin.js';
import { registerNetworkRoutes } from './network.js';
import { registerSystemRoutes } from './system.js';
import { GamingMode } from '../../gaming/manager.js';
import { registerUserRoutes } from './users.js';
import { registerHostRoutes } from './hosts.js';
import { registerAdminFileRoutes } from './admin-files.js';
import { registerIntegrationRoutes } from './integrations.js';
import { DiscordNotifier } from '../../notifications/discord.js';
import { getNetwork, publicHostOf } from '../../network.js';
import { runAs } from '../../store/identity.js';
import { accessPolicyFor, canSeeServer, flagsFor, type AccessPolicy } from '../authz.js';
import { getAccess, removeServerAccess, setOwner } from '../../store/access.js';
import { initialValue, isUserVariable, validateVariables } from '../../eggs/rules.js';
import { GameTester } from '../../testing/game-tester.js';
import { registerAccountRoutes } from './account.js';
import { registerExtraRoutes } from './extras.js';
import type { SlpResult } from '../../games/minecraft.js';
import { PlayerManager } from '../../players/manager.js';
import { registerPlayerRoutes } from './players.js';
import { loadEggs, type LoadedEgg } from '../../eggs/loader.js';
import {
  coverDirFor,
  coverFor,
  isValidChoice,
  readCustomCover,
  saveCustomCover,
  steamAppId,
  steamCover,
  type CoverChoice,
  type Fetcher,
} from '../covers.js';

/**
 * Was der Core fuer einen Server wirklich kann. Die Oberflaeche blendet Tabs und
 * Schaltflaechen nach diesen Rechten aus - ein Recht, das hier fehlt, versteckt die
 * Funktion. Neue Funktionen kommen erst dazu, wenn es die Routen dafuer gibt.
 */
/** Funktionsbereiche der Oberflaeche, die der Core unterstuetzt (siehe web/src/lib/features.ts). */
export const CORE_FEATURES: string[] = ['files', 'settings', 'logfiles', 'schedules', 'backups', 'players', 'admin', 'audit', 'account', 'configs', 'motd', 'testreport', 'hostlogs', 'network', 'integrations', 'adminfiles', 'hosts', 'users', 'gaming', 'limits'];

export const SERVER_PERMISSIONS = [
  'control.console',
  'control.command',
  'control.start',
  'control.stop',
  'control.restart',
  'control.kill',
  'file.read',
  'file.write',
  'file.delete',
  'settings.reinstall',
  'settings.rename',
  'startup.read',
  'startup.update',
  'allocation.read',
  'allocation.assign',
  'schedule.read',
  'schedule.update',
  'schedule.run',
  'backup.read',
  'backup.create',
  'backup.restore',
  'backup.delete',
  'backup.download',
  'player.read',
  'player.kick',
  'player.ban',
  'player.whitelist',
  'file.archive',
];

export function registerApiV1Routes(
  server: FastifyInstance,
  driver: HostDriver,
  bus: EventBus,
  registry: ServerRegistry,
  account: LocalAccount | null = null,
  installs: InstallManager | null = null,
  options: { fetchImpl?: Fetcher; scheduler?: boolean; ping?: (host: string, port: number) => Promise<SlpResult>; policy?: AccessPolicy } = {},
): void {
  // Ohne Angabe die vorsichtige Regel des Treibers
  const policy = options.policy ?? accessPolicyFor(driver.name);
  const coverDir = coverDirFor(registry.dir);
  const storedCover = (eggId: string) => registry.getSetting<CoverChoice>(`cover.${eggId}`);
  const coverOf = (egg: LoadedEgg) => coverFor(egg, storedCover(egg.id));
  /** Titelbild eines Servers: das seines Spiels, sonst ein Panel-Motiv. */
  const coverForServer = (c: ServerInstanceConfig, eggs: LoadedEgg[]) => {
    const egg = eggs.find((e) => e.id === c.game);
    return egg ? coverOf(egg) : coverFor({ id: c.game || c.id, name: c.game || c.name, raw: null });
  };

  /** Status fuer die Oberflaeche: die Installation geht vor dem Zustand des Treibers. */
  const statusOf = (c: ServerInstanceConfig, driverStatus: ServerStatus | undefined): string => {
    if (c.install?.state === 'installing') return 'installing';
    if (c.install?.state === 'failed') return 'install_failed';
    // Die Oberflaeche kennt den Wert "error" des Treibers nicht (ServerStatus in
    // web/src/lib/types.ts) - ein Prozess, der nicht starten konnte, gilt dort als abgestuerzt.
    if (driverStatus === 'error') return 'crashed';
    return driverStatus ?? 'offline';
  };

  /** Zustand vom Treiber - eine noch nicht installierte Instanz kennt er nicht. */
  const stateOf = async (id: string) => {
    try {
      return await driver.getServerState(id);
    } catch {
      return undefined;
    }
  };

  /** Variablen (Vorgaben aus dem Egg + Eingaben) und die Vorlage fuer server.properties. */
  const eggInstallData = async (
    eggId: string,
    given: Record<string, unknown> | undefined,
  ): Promise<{ variables: Record<string, string>; propertiesTemplate: Record<string, string> }> => {
    const egg = (await loadEggs()).find((e) => e.id === eggId);
    const variables: Record<string, string> = {};
    for (const v of egg?.raw.variables ?? []) variables[v.env_variable] = initialValue(v);
    for (const [key, value] of Object.entries(given ?? {})) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        variables[key] = String(value);
      }
    }
    const propertiesTemplate: Record<string, string> = {};
    for (const [key, value] of Object.entries(egg?.raw.config_files?.['server.properties']?.find ?? {})) {
      propertiesTemplate[key] = String(value);
    }
    return { variables, propertiesTemplate };
  };

  /** Ports eines Eggs (Spiel, Abfrage, ...) als freie Ports des Cores; der erste ist der schon vergebene Spielport. */
  const portRangeNow = () => {
    const n = getNetwork(registry);
    return { from: n.portFrom, to: n.portTo };
  };

  const eggPorts = async (raw: unknown, firstPort: number): Promise<ServerInstanceConfig['ports']> => {
    const spec = (raw ?? {}) as {
      primary?: { ref?: string; protocol?: string };
      secondary?: Array<{ ref?: string; protocol?: string }>;
    };
    const toProtocol = (p?: string): 'tcp' | 'udp' => (p === 'tcp' ? 'tcp' : 'udp');
    const wanted = [spec.primary, ...(spec.secondary ?? [])].filter((p): p is { ref?: string; protocol?: string } => Boolean(p));
    const result: ServerInstanceConfig['ports'] = [];
    for (const [index, p] of wanted.entries()) {
      const name = (p.ref ?? (index === 0 ? 'game' : `port${index}`)).toLowerCase();
      // Die schon belegten Ports und die eben gewaehlten zaehlen als vergeben
      const hostPort =
        index === 0
          ? firstPort
          : await allocatePort([...registry.list(), { ports: result.concat({ name: 'x', hostPort: firstPort, protocol: 'udp' }) } as ServerInstanceConfig], undefined, portRangeNow());
      result.push({ name, hostPort, protocol: toProtocol(p.protocol) });
    }
    return result.length ? result : [{ name: 'game', hostPort: firstPort, protocol: 'tcp' }];
  };

  const toActiveTask = (task: ReturnType<ServerRegistry['listTasks']>[number]) => {
    const c = task.serverId ? registry.get(task.serverId) : undefined;
    return {
      id: task.id,
      type: task.kind === 'install' ? 'install' : task.kind,
      serverId: task.serverId ?? '',
      serverName: c?.name ?? task.serverId ?? '',
      shortId: (task.serverId ?? '').slice(0, 8),
      title: task.kind === 'install' ? 'Installation' : task.kind,
      subtitle: task.message,
      step: task.message,
      progressPercent: Math.round(task.progress * 100),
      startedAt: task.createdAt,
    };
  };
  /** Cookie der Sitzung: nur fuer den Server lesbar, nie an fremde Seiten. */
  const sessionCookie = (token: string): string =>
    `nxp_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;

  const findServer = (idOrShortId: string): ServerInstanceConfig | undefined => findInstance(registry, idOrShortId);

  const discord = new DiscordNotifier({ registry, bus });
  const power = createPowerOps({ registry, driver, onStopRequested: (id) => discord.expectStop(id) });
  const gaming = new GamingMode({ registry, driver, power, bus });
  // Backups gibt es im Core noch nicht: dann lehnt der Planer solche Zeitplaene ab.
  const backups = new BackupManager({
    registry,
    isStopped: async (id) => {
      const state = await stateOf(id);
      return !state || state.status === 'offline' || state.status === 'error';
    },
    gameName: async (c) => (await loadEggs()).find((e) => e.id === c.game)?.name ?? c.game,
  });
  const players = new PlayerManager({ registry, driver, ...(options.ping ? { ping: options.ping } : {}) });
  const scheduler = new Scheduler(registry, {
    restart: async (id) => void (await power.restart(id)),
    command: (id, line) => power.command(id, line),
    backup: async (id, name) => {
      const { done } = await backups.create(id, { name, actor: 'core' });
      const result = await done;
      if (result.status === 'failed') throw new Error(result.error ?? 'Backup fehlgeschlagen');
    },
  });
  if (options.scheduler !== false) {
    scheduler.start();
    backups.start();
    players.start();
    discord.start();
    gaming.start();
    server.addHook('onClose', async () => {
      gaming.stop();
      discord.stop();
      scheduler.stop();
      backups.stop();
      players.stop();
    });
  }

  registerScheduleRoutes(server, { registry, find: findServer, scheduler });
  registerBackupRoutes(server, { find: findServer, backups });
  const tester = new GameTester({
    registry,
    driver,
    bus,
    installs,
    power,
    eggs: loadEggs,
    variablesFor: (eggId, given) => eggInstallData(eggId, given),
    portsFor: eggPorts,
    allocatePort: (existing) => allocatePort(existing, undefined, portRangeNow()),
    ...(options.ping ? { ping: options.ping } : {}),
  });
  registerAdminRoutes(server, { registry, driver, tester, account });
  registerIntegrationRoutes(server, { registry, discord });
  registerAdminFileRoutes(server, { registry });
  registerHostRoutes(server, { registry, driver, dataDir: registry.dir });
  registerUserRoutes(server, { registry, driver, account });
  registerSystemRoutes(server, { registry, driver, gaming });
  registerNetworkRoutes(server, { registry, driver, defaultRange: config.portRange });
  registerAccountRoutes(server, { registry, account });
  registerExtraRoutes(server, { registry, find: findServer, eggs: loadEggs });
  registerPlayerRoutes(server, { find: findServer, players });
  registerFileRoutes(server, { registry, find: findServer });
  registerSettingsRoutes(server, { registry, driver, find: findServer, installs, eggs: loadEggs, onServerDeleted: async (id) => { await backups.purgeServer(id); removeServerAccess(registry, id); } });
  registerLogFileRoutes(server, { registry, find: findServer, eggs: loadEggs });

  // 1. Authentifizierung & Sitzung
  // Block A4: refresh gibt nur dann ein Token heraus, wenn es schon eine
  // gueltige Sitzung gibt. Frueher bekam hier jeder ohne Anmeldung ein Token.
  server.post('/api/v1/auth/refresh', async (req, reply) => {
    const existingCookie = parseCookie(req.headers.cookie, 'nxp_session');
    if (!existingCookie || !isValidSessionToken(existingCookie)) {
      return reply.status(401).send({ error: 'Nicht angemeldet', code: 'unauthorized' });
    }
    return { accessToken: existingCookie };
  });

  // Block A4: echte Anmeldung mit dem lokalen Konto.
  server.post<{ Body: { login?: unknown; password?: unknown; totp?: unknown; recoveryCode?: unknown } | undefined }>(
    '/api/v1/auth/login',
    async (req, reply) => {
      if (!account) {
        return reply.status(403).send({ error: 'Anmeldung ist in diesem Modus nicht verfuegbar.' });
      }
      const login = typeof req.body?.login === 'string' ? req.body.login : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const origin = req.ip;

      const locked = account.lockedForSeconds(origin);
      if (locked > 0) {
        reply.header('Retry-After', String(locked));
        return reply.status(429).send({
          error: `Zu viele Fehlversuche. Bitte in ${Math.ceil(locked / 60)} Minuten erneut versuchen.`,
          code: 'too_many_attempts',
        });
      }

      const user = !login || !password || password.length > 1024 ? null : await account.verify(login, password, origin);
      if (!user) {
        logger.warn({ origin }, 'Fehlgeschlagene Anmeldung an der Standalone-Oberflaeche');
        registry.audit('auth.login_failed', null, 'standalone', { origin });
        return reply.status(401).send({ error: 'Benutzername oder Passwort falsch.', code: 'invalid_credentials' });
      }

      // Zwei-Faktor: das Passwort allein genuegt nicht. Ein fehlender Code ist kein Fehlversuch,
      // ein falscher schon - sonst waere der Code mit dem richtigen Passwort unbegrenzt zu erraten.
      if (user.totpEnabled) {
        const totp = typeof req.body?.totp === 'string' ? req.body.totp : undefined;
        const recoveryCode = typeof req.body?.recoveryCode === 'string' ? req.body.recoveryCode : undefined;
        if (!totp && !recoveryCode) {
          return reply.status(401).send({ error: 'Code aus der Authenticator-App erforderlich', code: 'totp_required' });
        }
        if (!(await account.checkSecondFactor(user.id, { totp, recoveryCode }))) {
          account.recordFailure(origin);
          registry.audit('auth.login_failed', null, 'standalone', { origin, reason: totp ? 'totp' : 'recovery_code' });
          return reply.status(401).send({ error: 'Code ungueltig oder schon benutzt', code: 'totp_invalid' });
        }
        if (recoveryCode) {
          runAs({ userId: user.id, username: user.username }, () =>
            registry.audit('auth.recovery_code_used', null, 'standalone', { left: account.recoveryLeft(user.id) }),
          );
        }
      }
      account.clearFailures(origin);
      await account.recordLogin(user.id);

      const token = createSessionToken({ userId: user.id, ip: req.ip, userAgent: req.headers['user-agent'] });
      runAs({ userId: user.id, username: user.username }, () => registry.audit('auth.login', null, 'standalone', { origin }));
      reply.header('Set-Cookie', sessionCookie(token));
      return { accessToken: token };
    },
  );

  // Eigenes Passwort aendern: altes Passwort noetig, danach gelten alle
  // anderen Sitzungen nicht mehr.
  server.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } | undefined }>(
    '/api/v1/auth/password',
    async (req, reply) => {
      if (!account) {
        return reply.status(403).send({ error: 'Anmeldung ist in diesem Modus nicht verfuegbar.' });
      }
      const actor = req.actor;
      if (!actor || actor.master) {
        return reply.status(403).send({ error: 'Das Zugriffstoken hat kein Benutzerkonto. Bitte als Benutzer anmelden.', code: 'forbidden' });
      }
      const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      const next = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      if (!(await account.checkPassword(actor.id, current, req.ip))) {
        return reply.status(401).send({ error: 'Das aktuelle Passwort stimmt nicht.', code: 'invalid_credentials' });
      }
      try {
        await account.setPassword(actor.id, next);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      // Nur die Sitzungen DIESES Benutzers enden - die der anderen laufen weiter
      revokeUserSessions(actor.id);
      registry.audit('auth.password_changed', null, 'standalone');
      const token = createSessionToken({ userId: actor.id, ip: req.ip, userAgent: req.headers['user-agent'] });
      reply.header('Set-Cookie', sessionCookie(token));
      return { ok: true, accessToken: token };
    },
  );

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
  // Bereiche der Oberflaeche, die der Core kann. Alles andere blendet die Oberflaeche aus,
  // statt "Nicht gefunden" zu zeigen. Kommt eine Funktion dazu, steht sie hier.
  server.get('/api/v1/about', async () => {
    return {
      name: 'NexusPanel Standalone (NexusCore)',
      version: '0.2.0',
      build: 'standalone-native',
      sftp: { enabled: false, port: 2022 },
      standalone: true,
      features: CORE_FEATURES,
      // Leere Listen, damit Seiten, die sie lesen, nicht abstuerzen.
      changelog: [],
      todo: [],
      devlog: [],
      docs: [],
    };
  });

  /** Rechte an einem Server, soweit der Core die Funktion hat - alles andere bleibt in der Oberflaeche verborgen. */
  const permissionsFor = (serverId: string, actor: NonNullable<FastifyRequest['actor']>): string[] =>
    flagsFor(registry, serverId, actor, policy).filter((f) => SERVER_PERMISSIONS.includes(f));
  const ownerNameOf = (serverId: string): string => {
    const ownerId = getAccess(registry, serverId).ownerId;
    return (ownerId ? account?.get(ownerId)?.username : undefined) ?? 'Admin';
  };
  /** "Eigener" Server: wer ihn loeschen darf (Besitzer oder Verwalter des Cores). */
  const isOwnerOf = (serverId: string, actor: NonNullable<FastifyRequest['actor']>): boolean =>
    actor.master || actor.role === 'admin' || getAccess(registry, serverId).ownerId === actor.id;

  /**
   * Gilt eine schon offene Verbindung noch? Eine WebSocket-Verbindung lebt lange: wird der Benutzer
   * gesperrt, geloescht oder meldet er sich ab, muss sie aufhoeren Daten zu bekommen.
   */
  const connectionStillValid = (req: FastifyRequest): boolean => {
    const actor = req.actor;
    if (!actor) return false;
    if (actor.master) return true;
    const user = account?.get(actor.id);
    if (!user || user.suspended) return false;
    // Dieselbe Reihenfolge wie bei der Anmeldung: Kopfzeile, ?token= (WebSocket), Cookie
    const query = (req.query as Record<string, unknown> | undefined)?.token;
    const token =
      req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() ??
      (typeof query === 'string' && query.length > 0 ? query : undefined) ??
      parseCookie(req.headers.cookie, 'nxp_session');
    return token !== undefined && isValidSessionToken(token);
  };

  server.get('/api/v1/dashboard', async (req) => {
    const actor = req.actor!;
    const configs = registry.list().filter((c) => canSeeServer(registry, c.id, actor));
    const visible = new Set(configs.map((c) => c.id));
    const states = (await driver.listServers()).filter((s) => visible.has(s.id));
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
      // Die Daten des Rechners sind Sache der Verwalter
      host: actor.role === 'user' ? null : {
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

    // Grenzen des Benutzers (Anzahl Server, Arbeitsspeicher) - Verwalter sind ausgenommen
    const creator = req.actor!;
    if (!creator.master && creator.role !== 'admin') {
      const limits = account?.get(creator.id);
      const mine = registry.list().filter((c) => getAccess(registry, c.id).ownerId === creator.id);
      if (limits && limits.serverLimit > 0 && mine.length >= limits.serverLimit) {
        return reply.status(403).send({ error: `Server-Limit erreicht (${limits.serverLimit}).`, code: 'limit_reached' });
      }
      const ramUsed = mine.reduce((sum, c) => sum + (c.maxMemoryMb ?? 2048), 0);
      if (limits && limits.ramLimitMb > 0 && ramUsed + (ramMb ?? 2048) > limits.ramLimitMb) {
        return reply.status(403).send({ error: `Arbeitsspeicher-Limit erreicht (${limits.ramLimitMb} MB).`, code: 'limit_reached' });
      }
    }

    // Generiere saubere ID
    const cleanId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `server-${Date.now().toString(36)}`;

    const id = registry.get(cleanId) ? `${cleanId}-${Date.now().toString(36).slice(-4)}` : cleanId;
    let serverDir: string;
    try {
      serverDir = await resolveInsideRoot(serverRootFor(registry.dir), id, 'id');
    } catch (err) {
      if (err instanceof PathOutsideRootError) return reply.status(400).send({ error: err.message });
      throw err;
    }
    await fs.mkdir(serverDir, { recursive: true });

    // Freien Port im konfigurierten Bereich suchen (Block A5)
    let port: number;
    try {
      port = await allocatePort(registry.list(), undefined, portRangeNow());
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }

    // Benutzer ohne Verwalterrolle: nur bekannte Spiele, nur die Variablen, die das Spiel vorsieht - und gueltig.
    // Sonst liesse sich ueber frei gewaehlte Werte (Umgebung, Startoptionen) Einfluss auf den Rechner nehmen.
    const adminLike = creator.master || creator.role === 'admin';
    const knownEgg = (await loadEggs()).find((e) => e.id === eggId);
    let givenVariables: Record<string, unknown> | undefined = variables;
    if (!adminLike) {
      if (!knownEgg) return reply.status(403).send({ error: 'Dieses Spiel gibt es nicht.', code: 'forbidden' });
      const defs = knownEgg.raw.variables ?? [];
      const allowed = new Set(defs.filter(isUserVariable).map((d) => d.env_variable));
      const picked = Object.fromEntries(
        Object.entries(variables ?? {})
          .filter(([key, value]) => allowed.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
          .map(([key, value]) => [key, String(value)]),
      );
      const start = Object.fromEntries(defs.map((d) => [d.env_variable, initialValue(d)]));
      const checked = validateVariables(defs, { ...start, ...picked });
      if (checked.errors.length > 0) {
        return reply.status(400).send({ error: 'Ungültige Werte', message: 'Ungültige Werte', code: 'invalid_variables', issues: checked.errors });
      }
      givenVariables = checked.values;
    }

    // Block B2: echte Installation statt Attrappe, wenn der Core dieses Egg kann.
    const installData = await eggInstallData(eggId, givenVariables);
    const egg = knownEgg;
    const plan = installs ? installPlanFor(eggId, egg?.raw, installData.variables) : null;
    if (!adminLike && !plan && !policy.userFileWrite) {
      // Ohne Installation bliebe nur eine Platzhalter-Startdatei - die legt auf diesem Rechner nur ein Verwalter an
      return reply.status(403).send({ error: 'Dieses Spiel kann der Core für Benutzer noch nicht installieren.', code: 'forbidden' });
    }
    if (installs && plan) {
      // Steam-Spiele brauchen mehr als einen Port (Spiel, Abfrage ...): jeden aus dem Bereich des Cores
      let ports: ServerInstanceConfig['ports'] = [{ name: 'game', hostPort: port, protocol: 'tcp' }];
      if (plan.kind === 'steamcmd' || plan.kind === 'download') {
        try {
          ports = await eggPorts(egg?.raw.ports, port);
        } catch (err) {
          return reply.status(409).send({ error: (err as Error).message });
        }
      }
      const installing: ServerInstanceConfig = {
        id,
        name,
        game: eggId,
        executable: '',
        args: [],
        workingDir: serverDir,
        maxMemoryMb: ramMb ?? 2048,
        maxCpuPercent: cpuPercent ?? 100,
        ports,
        install: { state: 'installing', kind: plan.kind, ...(plan.steam ? { steam: plan.steam } : {}), ...installData },
      };
      await registry.add(installing);
      if (!creator.master) setOwner(registry, id, creator.id);
      registry.audit('server.create', id, 'standalone', { name, game: eggId, port, install: plan.kind });
      const task = installs.start(id, { kind: plan.kind, ...(plan.steam ? { steam: plan.steam } : {}), ...installData });
      return reply.status(201).send({ server: { id, shortId: id.slice(0, 8) }, taskId: task.id });
    }

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
      // Frei gewaehlte Umgebungsvariablen (PATH, JAVA_TOOL_OPTIONS ...) nur vom Verwalter
      env: adminLike ? ((variables as Record<string, string> | undefined) ?? {}) : {},
    };

    await driver.registerServer(serverConfig);
    await registry.add(serverConfig);
    if (!creator.master) setOwner(registry, id, creator.id);
    registry.audit('server.create', id, 'standalone', { name, game: eggId, port });

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

  // Die Oberflaeche fragt das alle paar Sekunden ab - leer statt 404.
  server.get('/api/v1/notifications', async () => ({ items: [] }));
  server.post('/api/v1/presence/ping', async () => ({ ok: true }));
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
        cover: coverOf(e),
        coverChoice: storedCover(e.id)?.choice ?? 'auto',
        hasSteamCover: steamAppId(e.name, e.raw) !== null,
        // Ohne Installer (Docker, Mock) bleibt alles wie im Panel; sonst nur, was der Core selbst installieren kann
        installable: !installs || installPlanFor(e.id, e.raw, {}) !== null,
      })),
    };
  });

  // Titelbild eines Spiels. Der Browser schickt das Cookie der Sitzung mit,
  // ein <img> braucht keinen Bearer-Token.
  server.get<{ Params: { id: string } }>('/api/v1/eggs/:id/cover', async (req, reply) => {
    const egg = (await loadEggs()).find((e) => e.id === req.params.id);
    if (!egg) return reply.status(404).send({ error: 'Egg nicht gefunden' });

    const choice = storedCover(egg.id)?.choice ?? 'auto';

    if (choice === 'custom') {
      const custom = await readCustomCover(coverDir, egg.id);
      if (!custom) return reply.status(404).send({ error: 'Kein eigenes Bild vorhanden' });
      return reply.header('Cache-Control', 'private, max-age=86400').type(custom.type).send(custom.data);
    }

    const appId = choice === 'random' || choice.startsWith('branding:') ? null : steamAppId(egg.name, egg.raw);
    if (appId === null) return reply.status(404).send({ error: 'Dieses Spiel hat kein Steam-Bild' });
    const image = await steamCover(appId, coverDir, options.fetchImpl);
    if (!image) {
      // Nicht zwischenspeichern: beim naechsten Versuch ist Steam vielleicht wieder da.
      reply.header('Cache-Control', 'no-store');
      return reply.status(404).send({ error: 'Steam-Bild nicht erreichbar' });
    }
    return reply.header('Cache-Control', 'private, max-age=86400').type('image/jpeg').send(image);
  });

  // Admin: Titelbild waehlen (automatisch, Steam, Panel-Motiv) oder eigenes Bild hochladen.
  server.put<{ Params: { id: string }; Body: { choice?: unknown; upload?: unknown } | undefined }>(
    '/api/v1/admin/eggs/:id/cover',
    { bodyLimit: 3 * 1024 * 1024 },
    async (req, reply) => {
      const egg = (await loadEggs()).find((e) => e.id === req.params.id);
      if (!egg) return reply.status(404).send({ error: 'Egg nicht gefunden' });

      const body = req.body ?? {};
      const stamp = String(Date.now());
      try {
        if (typeof body.upload === 'string') {
          await saveCustomCover(coverDir, egg.id, body.upload);
          registry.setSetting(`cover.${egg.id}`, { choice: 'custom', v: stamp });
          registry.audit('egg.cover', null, 'standalone', { egg: egg.id, choice: 'custom' });
        } else if (typeof body.choice === 'string' && isValidChoice(body.choice)) {
          if (body.choice === 'steam' && steamAppId(egg.name, egg.raw) === null) {
            return reply.status(400).send({ error: 'Dieses Spiel hat kein Steam-Bild.' });
          }
          if (body.choice === 'custom' && !(await readCustomCover(coverDir, egg.id))) {
            return reply.status(400).send({ error: 'Es gibt noch kein eigenes Bild.' });
          }
          if (body.choice === 'auto') registry.deleteSetting(`cover.${egg.id}`);
          else registry.setSetting(`cover.${egg.id}`, { choice: body.choice, v: stamp });
          registry.audit('egg.cover', null, 'standalone', { egg: egg.id, choice: body.choice });
        } else {
          return reply.status(400).send({ error: 'Ungueltige Angabe' });
        }
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      return { ok: true };
    },
  );

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

  // 5. Hosts: siehe routes/hosts.ts

  server.get('/api/v1/steam/accounts', async () => {
    return { accounts: [] };
  });
}
