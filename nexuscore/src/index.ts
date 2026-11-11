import os from 'node:os';
import { config } from './config/index.js';
import { logger } from './logger.js';
import { MockDriver } from './drivers/mock-driver.js';
import { WindowsNativeDriver } from './drivers/windows-native.js';
import { DockerDriver } from './drivers/docker-driver.js';
import type { HostDriver } from './drivers/interface.js';
import { createCoreServer } from './http/server.js';
import { EventBus } from './protocol/events.js';
import { currentPairingPin, tokenFingerprint } from './protocol/security.js';
import { ServerRegistry, RegistryCorruptError } from './store/registry.js';
import { DatabaseCorruptError } from './store/database.js';
import type { ServerInstanceConfig } from './types.js';
import { getSystemMetrics } from './system/monitor.js';

const STATE_POLL_MS = 2000;
const METRICS_PUSH_MS = 5000;

function pickDriver(): HostDriver {
  if (config.runtime === 'windows-native') return new WindowsNativeDriver();
  if (config.runtime === 'docker') return new DockerDriver();
  return new MockDriver();
}

/**
 * Beobachtet die Instanzen und meldet Zustandswechsel.
 *
 * So werden auch Prozesse erfasst, die von ausserhalb beendet werden - ein
 * Gameserver, der sich selbst beendet, darf im Panel nicht als "laeuft"
 * stehen bleiben.
 */
function startStateWatcher(driver: HostDriver, bus: EventBus): NodeJS.Timeout {
  const known = new Map<string, string>();

  const timer = setInterval(() => {
    void (async () => {
      try {
        const states = await driver.listServers();
        for (const state of states) {
          const signature = `${state.status}:${state.pid ?? '-'}`;
          if (known.get(state.id) === signature) continue;
          known.set(state.id, signature);
          bus.emit({ type: 'state', serverId: state.id, state, ts: new Date().toISOString() });
        }
      } catch (err) {
        logger.error({ err }, 'Zustandsabfrage fehlgeschlagen');
      }
    })();
  }, STATE_POLL_MS);

  timer.unref();
  return timer;
}

async function main(): Promise<void> {
  logger.info(
    {
      runtime: config.runtime,
      mode: config.mode,
      platform: process.platform,
      host: config.host,
      port: config.port,
      dataDir: config.dataDir,
    },
    'NexusCore Host Daemon startet',
  );

  const bus = new EventBus();
  const driver = pickDriver();
  await driver.initialize();

  // Konsolenausgaben des Treibers in den Event-Bus leiten.
  driver.setLogSink((line) => {
    bus.emit({ type: 'console', ...line });
  });

  // Registry oeffnen und gespeicherte Instanzen uebernehmen.
  const registry = await ServerRegistry.open(config.dataDir);
  // Grenzen fuer Speicher und CPU: nur auf Wunsch des Administrators (Admin -> Hosts), gilt ab dem naechsten Start
  if (driver instanceof WindowsNativeDriver) driver.setLimitsPolicy(() => registry.getSetting<boolean>('limits.enforce') === true);
  const interrupted = registry.failInterruptedTasks();
  if (interrupted > 0) {
    logger.warn({ interrupted }, 'Aufgaben vom letzten Lauf als unterbrochen markiert');
  }
  registry.audit('core.start', null, 'core', { runtime: config.runtime, mode: config.mode });
  for (const server of registry.list()) {
    // Nicht fertig installierte Instanzen kann der Treiber nicht starten. Eine
    // Installation, die beim letzten Lauf mittendrin war, gilt als fehlgeschlagen.
    if (server.install && server.install.state !== 'done') {
      if (server.install.state === 'installing') {
        await registry.update({
          ...server,
          install: { ...server.install, state: 'failed', error: 'Durch Neustart des Cores unterbrochen' },
        });
        logger.warn({ serverId: server.id }, 'Installation war unterbrochen - bitte neu installieren');
      }
      continue;
    }
    try {
      await driver.registerServer(server);
      logger.info({ serverId: server.id }, 'Instanz aus Registry uebernommen');
    } catch (err) {
      logger.error({ err, serverId: server.id }, 'Instanz konnte nicht uebernommen werden');
    }
  }

  // Im Testmodus gibt es immer eine Beispiel-Instanz, damit /core/v1/servers
  // nicht leer ist und der Smoke-Test etwas zum Starten hat.
  if (config.mode === 'test' && !registry.get('test-minecraft-01')) {
    // Ein Objekt fuer Treiber und Registry - frueher wurden zwei getrennt
    // aufgebaute Kopien registriert.
    const testInstance: ServerInstanceConfig = {
      id: 'test-minecraft-01',
      name: 'Test Minecraft Server (Local)',
      game: 'minecraft',
      executable: process.execPath,
      args: ['-e', 'console.log("NexusCore Testserver laeuft."); setInterval(() => {}, 1000)'],
      workingDir: process.cwd(),
      ports: [{ name: 'game', hostPort: 25565, protocol: 'tcp' }],
    };
    await registry.add(testInstance);
    await driver.registerServer(testInstance);
  }

  const server = await createCoreServer(driver, bus, registry);
  const address = await server.listen({ port: config.port, host: config.host });

  const stateTimer = startStateWatcher(driver, bus);
  const metricsTimer = setInterval(() => {
    void (async () => {
      try {
        const metrics = await getSystemMetrics(config.dataDir);
        bus.emit({ type: 'metrics', metrics, ts: new Date().toISOString() });
      } catch (err) {
        logger.error({ err }, 'Metriken konnten nicht gelesen werden');
      }
    })();
  }, METRICS_PUSH_MS);
  metricsTimer.unref();

  logger.info(
    {
      url: address,
      pin: currentPairingPin(),
      tokenFingerprint: tokenFingerprint(),
      host: os.hostname(),
    },
    'NexusCore laeuft',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'NexusCore wird beendet');

    clearInterval(stateTimer);
    clearInterval(metricsTimer);

    try {
      await server.close();
      await driver.shutdown();
      registry.audit('core.stop', null, 'core', { signal });
      registry.close();
    } catch (err) {
      logger.error({ err }, 'Fehler beim Beenden');
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  if (err instanceof RegistryCorruptError || err instanceof DatabaseCorruptError) {
    // Laut und eindeutig: hier geht es um die Liste aller Server.
    console.error(`\n  ${err.message}\n`);
  }
  logger.error({ err }, 'NexusCore konnte nicht starten');
  process.exit(1);
});
