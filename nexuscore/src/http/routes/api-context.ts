import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HostDriver } from '../../drivers/interface.js';
import type { EventBus } from '../../protocol/events.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { LocalAccount } from '../../store/account.js';
import type { InstallManager } from '../../install/manager.js';
import type { ServerInstanceConfig, ServerState, ServerStatus } from '../../types.js';
import type { LoadedEgg } from '../../eggs/loader.js';
import type { SlpResult } from '../../games/minecraft.js';
import type { BackupManager } from '../../backups/manager.js';
import type { SecretStore } from '../../store/secrets.js';
import type { ImportService } from '../../servers/import-service.js';
import type { FirewallManager } from '../../system/firewall.js';
import type { AccessPolicy } from '../authz.js';
import type { createPowerOps } from '../../ops/power.js';
import type { CoverChoice, Fetcher, coverFor } from '../covers.js';

/** Optionen, mit denen Tests und der Start den Core einrichten. */
export interface ApiOptions {
  fetchImpl?: Fetcher;
  scheduler?: boolean;
  ping?: (host: string, port: number) => Promise<SlpResult>;
  policy?: AccessPolicy;
  firewall?: FirewallManager;
  /** Tests: Netzzugriff und oeffentliche Adresse des DNS-Abgleichs ersetzen. */
  steam?: { login?: import('../../steam/accounts.js').SteamLoginRunner };
  dns?: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; publicIp?: () => Promise<string> };
}

/** Eine laufende Aufgabe, wie die Oberflaeche sie anzeigt. */
export interface ActiveTask {
  id: string;
  type: string;
  serverId: string;
  serverName: string;
  shortId: string;
  title: string;
  subtitle: string;
  step: string;
  progressPercent: number;
  startedAt: string;
}

/**
 * Was die Route-Module gemeinsam brauchen: die Bausteine des Cores und ein paar Hilfsfunktionen.
 * `registerApiV1Routes` baut das einmal; jedes Modul (session, servers, server-create, ...) bekommt es als Ganzes.
 */
export interface ApiContext {
  server: FastifyInstance;
  driver: HostDriver;
  bus: EventBus;
  registry: ServerRegistry;
  account: LocalAccount | null;
  installs: InstallManager | null;
  options: ApiOptions;
  policy: AccessPolicy;
  power: ReturnType<typeof createPowerOps>;
  firewall: FirewallManager;
  backups: BackupManager;
  imports: ImportService;
  secrets: SecretStore;
  steamAccounts: import('../../steam/accounts.js').SteamAccounts;

  /** Server nach ID oder Kurz-ID. */
  findServer: (idOrShortId: string) => ServerInstanceConfig | undefined;
  /** Zustand vom Treiber - eine noch nicht installierte Instanz kennt er nicht. */
  stateOf: (id: string) => Promise<ServerState | undefined>;
  /** Status fuer die Oberflaeche: die Installation geht vor dem Zustand des Treibers. */
  statusOf: (c: ServerInstanceConfig, driverStatus: ServerStatus | undefined) => string;
  /** Variablen (Vorgaben aus dem Egg + Eingaben) und die Vorlage fuer server.properties. */
  eggInstallData: (eggId: string, given: Record<string, unknown> | undefined) => Promise<{ variables: Record<string, string>; propertiesTemplate: Record<string, string> }>;
  /** Ports eines Eggs als freie Ports des Cores; der erste ist der schon vergebene Spielport. */
  eggPorts: (raw: unknown, firstPort: number) => Promise<ServerInstanceConfig['ports']>;
  portRangeNow: () => { from: number; to: number };

  coverDir: string;
  storedCover: (eggId: string) => CoverChoice | null | undefined;
  coverOf: (egg: LoadedEgg) => ReturnType<typeof coverFor>;
  coverForServer: (c: ServerInstanceConfig, eggs: LoadedEgg[]) => ReturnType<typeof coverFor>;

  toActiveTask: (task: ReturnType<ServerRegistry['listTasks']>[number]) => ActiveTask;
  /** Cookie der Sitzung: nur fuer den Server lesbar, nie an fremde Seiten. */
  sessionCookie: (token: string) => string;

  /** Rechte an einem Server, soweit der Core die Funktion hat. */
  permissionsFor: (serverId: string, actor: NonNullable<FastifyRequest['actor']>) => string[];
  ownerNameOf: (serverId: string) => string;
  isOwnerOf: (serverId: string, actor: NonNullable<FastifyRequest['actor']>) => boolean;
  /** Gilt eine schon offene Verbindung (WebSocket) noch? */
  connectionStillValid: (req: FastifyRequest) => boolean;
}
