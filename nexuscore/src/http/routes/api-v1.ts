import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import type { HostDriver } from '../../drivers/interface.js';
import type { EventBus } from '../../protocol/events.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig, ServerStatus } from '../../types.js';
import { config } from '../../config/index.js';
import { logger } from '../../logger.js';
import { createSessionToken, isValidSessionToken, parseCookie, SESSION_TTL_MS } from '../../protocol/security.js';
import { allocatePort } from '../../protocol/ports.js';
import type { AccountUser, LocalAccount } from '../../store/account.js';
import type { InstallManager } from '../../install/manager.js';
import { registerFileRoutes } from './files.js';
import { registerSettingsRoutes } from './settings.js';
import { registerLogFileRoutes } from './log-files.js';
import { registerScheduleRoutes } from './schedules.js';
import { Scheduler } from '../../schedules/scheduler.js';
import { createPowerOps } from '../../ops/power.js';
import { findInstance } from '../../store/find.js';
import { BackupManager } from '../../backups/manager.js';
import { registerBackupRoutes } from './backups.js';
import { registerAdminRoutes } from './admin.js';
import { registerNetworkRoutes } from './network.js';
import { registerPasskeyRoutes } from './passkeys.js';
import { registerSteamLoginRoutes } from './steam-login.js';
import { registerSftpPasswordRoutes } from './sftp-passwords.js';
import { registerFirewallRoutes } from './firewall.js';
import { FirewallManager } from '../../system/firewall.js';
import { FirewallAuto } from '../../system/firewall-auto.js';
import { PasskeyService } from '../../auth/passkeys.js';
import { registerSystemRoutes } from './system.js';
import { GamingMode } from '../../gaming/manager.js';
import { registerUserRoutes } from './users.js';
import { registerHostRoutes } from './hosts.js';
import { registerAdminFileRoutes } from './admin-files.js';
import { registerIntegrationRoutes } from './integrations.js';
import { DiscordNotifier } from '../../notifications/discord.js';
import { getNetwork } from '../../network.js';
import { accessPolicyFor, flagsFor, type AccessPolicy } from '../authz.js';
import { getAccess, removeServerAccess } from '../../store/access.js';
import { initialValue } from '../../eggs/rules.js';
import { GameTester } from '../../testing/game-tester.js';
import { registerAccountRoutes } from './account.js';
import { registerExtraRoutes } from './extras.js';
import type { SlpResult } from '../../games/minecraft.js';
import { PlayerManager } from '../../players/manager.js';
import { registerPlayerRoutes } from './players.js';
import { loadEggs, type LoadedEgg } from '../../eggs/loader.js';
import { coverDirFor, coverFor, type CoverChoice, type Fetcher } from '../covers.js';
import type { ApiContext, ApiOptions } from './api-context.js';
import { SERVER_PERMISSIONS } from './api-constants.js';
import { registerSessionRoutes } from './session.js';
import { registerOverviewRoutes } from './overview.js';
import { registerServerReadRoutes } from './server-list.js';
import { registerServerCreateRoutes } from './server-create.js';
import { registerServerPowerRoutes } from './server-power.js';
import { registerLiveRoutes } from './live.js';
import { registerActivityRoutes } from './activity.js';
import { registerEggRoutes } from './eggs.js';
import { registerHealthRoutes } from './health.js';
import { registerDocsRoutes } from './docs.js';
import { registerEggAdminRoutes } from './egg-admin.js';
import { registerImportRoutes } from './imports.js';
import { registerModpackRoutes } from './modpacks.js';
import { registerStorageTargetRoutes } from './storage-targets.js';
import { registerDnsRoutes } from './dns.js';
import { AutoRestart } from '../../ops/auto-restart.js';
import { RemoteHosts } from '../../hosts/remote.js';
import { tokenFingerprint } from '../../protocol/security.js';
import { registerSteamAccountRoutes } from './steam-accounts.js';
import { SteamAccounts } from '../../steam/accounts.js';
import { createLoginRunner } from '../../steam/login.js';
import { DnsService } from '../../network/dns.js';
import { StorageTargets } from '../../store/storage-targets.js';
import { SecretStore } from '../../store/secrets.js';
import { createModpackUpdater } from '../../servers/modpack-update.js';
import { ImportService } from '../../servers/import-service.js';
import { registerDockerRoutes } from './docker.js';
import { registerImpersonateRoutes } from './impersonate.js';
import { registerSubuserRoutes } from './subusers.js';

// Die Konstanten stehen in api-constants.ts; hier weiter ausgeliefert, damit Importe unveraendert bleiben.
export { CORE_FEATURES, SERVER_PERMISSIONS } from './api-constants.js';

export function registerApiV1Routes(
  server: FastifyInstance,
  driver: HostDriver,
  bus: EventBus,
  registry: ServerRegistry,
  account: LocalAccount | null = null,
  installs: InstallManager | null = null,
  options: ApiOptions = {},
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
  const firewall = options.firewall ?? new FirewallManager(path.join(registry.dir, 'firewall-rules.json'));
  // Freigabe in der Windows-Firewall automatisch halten - nur fuer Spiele, die als Prozess dieses Rechners laufen (nicht in Docker)
  const firewallAuto = new FirewallAuto({ registry, firewall, bus, enabled: config.firewallAuto && driver.name === 'windows-native' });
  // Zugangsdaten (API-Schluessel ...) verschluesselt ablegen; Klartext aus aelteren Staenden wird umgezogen
  const secrets = new SecretStore(registry, { envKey: config.secretKey });
  if (secrets.migrateFromPlain('modpacks.curseforgeKey', 'curseforge')) logger.info('CurseForge-Schlüssel verschlüsselt');
  const storageTargets = new StorageTargets(registry, secrets);
  const steamAccounts = new SteamAccounts(registry, secrets, () => options.steam?.login ?? createLoginRunner(driver, registry.dir));
  // Installationen holen Name und Passwort des Kontos selbst (die Konfiguration des Servers speichert nur die Kennung)
  installs?.setSteamLogin((accountId) => steamAccounts.credentials({ id: null, username: 'core', admin: true }, accountId));
  const remoteHosts = new RemoteHosts(registry, secrets, { ...(options.hosts?.fetch ? { fetch: options.hosts.fetch } : {}), ownFingerprint: tokenFingerprint });
  const dns = new DnsService(registry, secrets, options.dns ?? {});
  const imports = new ImportService({ registry, bus, installs });
  const power = createPowerOps({
    registry,
    driver,
    onStopRequested: (id) => discord.expectStop(id),
    beforeStart: (id) => firewallAuto.ensure(id),
    busy: (id) => (imports.isImporting(id) ? 'Es läuft gerade ein Import.' : null),
  });
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
  const players = new PlayerManager({ registry, driver, bus, ...(options.ping ? { ping: options.ping } : {}) });
  const autoRestart = new AutoRestart({
    registry,
    bus,
    start: (id) => power.start(id),
    isCrashed: async (id) => (await stateOf(id))?.status === 'error',
  });
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
    // Regeln fuer Server, die es nicht mehr gibt, aufraeumen
    void firewallAuto.reconcile().catch((err: unknown) => logger.warn({ err }, 'Aufraeumen der Firewall-Regeln fehlgeschlagen'));
    scheduler.start();
    backups.start();
    players.start();
    discord.start();
    dns.start();
    autoRestart.start();
    remoteHosts.start();
    gaming.start();
    server.addHook('onClose', async () => {
      gaming.stop();
      discord.stop();
      dns.stop();
      autoRestart.stop();
      remoteHosts.stop();
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
  registerIntegrationRoutes(server, { registry, discord, secrets });
  registerAdminFileRoutes(server, { registry });
  registerHostRoutes(server, { registry, driver, dataDir: registry.dir, remote: remoteHosts });
  registerFirewallRoutes(server, { registry, firewall });
  registerUserRoutes(server, { registry, driver, account });
  registerSystemRoutes(server, { registry, driver, gaming });
  registerNetworkRoutes(server, { registry, driver, defaultRange: config.portRange });
  registerAccountRoutes(server, { registry, account });
  if (account) {
    const issueSession = async (req: FastifyRequest, reply: FastifyReply, user: AccountUser) => {
      const token = createSessionToken({ userId: user.id, ip: req.ip, userAgent: req.headers['user-agent'] });
      reply.header('Set-Cookie', sessionCookie(token));
      return { accessToken: token };
    };
    registerPasskeyRoutes(server, { registry, account, service: new PasskeyService(account), issueSession });
    registerSteamLoginRoutes(server, { registry, account, issueSession });
    registerSftpPasswordRoutes(server, { registry, account });
  }
  registerExtraRoutes(server, { registry, find: findServer, eggs: loadEggs });
  registerPlayerRoutes(server, { find: findServer, players });
  registerFileRoutes(server, { registry, find: findServer });
  registerSettingsRoutes(server, { registry, driver, find: findServer, installs, eggs: loadEggs, onServerDeleted: async (id) => { await backups.purgeServer(id); removeServerAccess(registry, id); storageTargets.deleteForServer(id); await firewall.closeServer(id).catch(() => {}); } });
  registerLogFileRoutes(server, { registry, find: findServer, eggs: loadEggs });

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

  const ctx: ApiContext = {
    server,
    driver,
    bus,
    registry,
    account,
    installs,
    options,
    policy,
    power,
    firewall,
    backups,
    imports,
    secrets,
    steamAccounts,
    findServer,
    stateOf,
    statusOf,
    eggInstallData,
    eggPorts,
    portRangeNow,
    coverDir,
    storedCover,
    coverOf,
    coverForServer,
    toActiveTask,
    sessionCookie,
    permissionsFor,
    ownerNameOf,
    isOwnerOf,
    connectionStillValid,
  };

  registerSessionRoutes(ctx);
  registerOverviewRoutes(ctx);
  registerServerReadRoutes(ctx);
  registerServerCreateRoutes(ctx);
  registerServerPowerRoutes(ctx);
  registerLiveRoutes(ctx);
  registerActivityRoutes(ctx);
  registerEggRoutes(ctx);
  registerHealthRoutes(server, { registry, driver });
  registerDocsRoutes(server);
  registerEggAdminRoutes(server, { registry, fetchImpl: options.fetchImpl });
  registerImportRoutes(server, { registry, imports, policy, find: findServer, stateOf, isOwnerOf });
  const modpacks = createModpackUpdater({ registry, driver, power, backups, bus });
  registerModpackRoutes(server, { registry, secrets, updater: modpacks, policy, find: findServer });
  registerStorageTargetRoutes(server, { registry, targets: storageTargets, find: findServer });
  registerDnsRoutes(server, { registry, dns, find: findServer });
  registerSteamAccountRoutes(server, { registry, accounts: steamAccounts });
  registerDockerRoutes(server, { registry, driver });
  if (account) {
    registerImpersonateRoutes(server, { registry, account, sessionCookie });
    registerSubuserRoutes(server, { registry, account, find: findServer });
  }
}
