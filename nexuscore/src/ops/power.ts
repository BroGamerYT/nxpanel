import type { HostDriver } from '../drivers/interface.js';
import { logger } from '../logger.js';
import { isMinecraftKind, writeServerProperties } from '../install/minecraft.js';
import { prepareSteamStart } from '../install/steam-game.js';
import type { ServerRegistry } from '../store/registry.js';
import type { ServerInstanceConfig, ServerState } from '../types.js';

/**
 * Starten, Stoppen und Neustarten eines Servers - an einer Stelle.
 *
 * Die Oberflaeche (Power-Route) und der Planer (Zeitplaene) brauchen dasselbe:
 * vor dem Start muessen die Einstellungen beim Treiber ankommen und die
 * Spieldateien (server.properties) zur Konfiguration passen.
 */

export class PowerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PowerError';
  }
}

export interface PowerOps {
  start(serverId: string): Promise<ServerState>;
  stop(serverId: string): Promise<ServerState>;
  kill(serverId: string): Promise<ServerState>;
  restart(serverId: string): Promise<ServerState>;
  command(serverId: string, line: string): Promise<void>;
}

export function createPowerOps(deps: {
  registry: ServerRegistry;
  driver: HostDriver;
  /** Wird gerufen, bevor ein Stopp/Neustart/Kill ausgeloest wird (Benachrichtigungen unterscheiden so Stopp von Absturz). */
  onStopRequested?: (serverId: string) => void;
}): PowerOps {
  const { registry, driver } = deps;

  const need = (id: string): ServerInstanceConfig => {
    const c = registry.get(id);
    if (!c) throw new PowerError('Server nicht gefunden', 404, 'not_found');
    return c;
  };

  /** Alles, was vor einem Start stimmen muss. */
  async function prepare(id: string): Promise<void> {
    const c = need(id);
    if (c.install && c.install.state !== 'done') {
      throw new PowerError(
        c.install.state === 'installing'
          ? 'Der Server wird noch installiert.'
          : `Die Installation ist fehlgeschlagen: ${c.install.error ?? 'unbekannter Fehler'}. Bitte neu installieren.`,
        409,
        'not_installed',
      );
    }
    // Port und Einstellungen koennen sich seit der Installation geaendert haben.
    const install = c.install;
    if (install && isMinecraftKind(install.kind)) {
      await writeServerProperties({
        serverDir: c.workingDir,
        variables: install.variables ?? {},
        propertiesTemplate: install.propertiesTemplate ?? {},
        ramMb: c.maxMemoryMb ?? 2048,
        port: c.ports[0]?.hostPort ?? 25565,
        serverName: c.name,
      }).catch((err: unknown) => logger.warn({ err, serverId: id }, 'server.properties konnte nicht geschrieben werden'));
    }
    // Steam-Spiele: Argumente und Konfigurationsdateien aus den jetzigen Variablen und Ports neu bauen
    let current = c;
    if (c.install?.kind === 'steamcmd') {
      const args = await prepareSteamStart(c);
      current = { ...c, args };
      await registry.update(current);
    }
    // Was in den Einstellungen geaendert wurde, gilt ab hier auch beim Treiber.
    await driver.updateServer?.(current).catch(() => {});
  }

  return {
    async start(id) {
      await prepare(id);
      return driver.startServer(id);
    },
    async stop(id) {
      need(id);
      deps.onStopRequested?.(id);
      return driver.stopServer(id);
    },
    async kill(id) {
      need(id);
      deps.onStopRequested?.(id);
      return driver.killServer(id);
    },
    async restart(id) {
      need(id);
      deps.onStopRequested?.(id);
      // Ein schon gestoppter Server ist kein Fehler: dann wird nur gestartet.
      await driver.stopServer(id).catch(() => {});
      await prepare(id);
      return driver.startServer(id);
    },
    async command(id, line) {
      need(id);
      if (!driver.sendCommand) throw new PowerError('Dieser Treiber nimmt keine Befehle an.', 400, 'not_supported');
      await driver.sendCommand(id, line);
    },
  };
}
