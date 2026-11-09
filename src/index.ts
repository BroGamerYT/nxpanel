import { config } from './config.js';
import { log } from './log.js';
import { buildServer } from './http/server.js';
import { ensureLocalNode, seedBundledEggs } from './servers/nodes.js';
import { runMigrations } from './db/migrate.js';
import { closeDatabase, waitForDatabase, DatabaseUnreachableError } from './db/index.js';
import { engine } from './docker/client.js';
import { reconcile } from './servers/reconcile.js';
import { startSupervisor, stopSupervisor } from './servers/supervisor.js';
import { startBanExpiry, stopBanExpiry } from './games/ban-expiry.js';
import { statsCollector, diskCollector } from './servers/stats.js';
import { startBackupScheduler, stopBackupScheduler } from './servers/backup-scheduler.js';
import { startScheduleWorker, stopScheduleWorker } from './servers/schedules.js';
import { startAutoSleep, stopAutoSleep } from './servers/auto-sleep.js';
import { startDdnsBackgroundService } from './network/dns.js';
import { resumeTestRunnerIfInterrupted, stopTestRunner } from './servers/test-runner.js';

function hint(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const bar = '-'.repeat(width);
  console.error(`\n${bar}`);
  for (const l of lines) console.error(` ${l}`);
  console.error(`${bar}\n`);
}

async function main(): Promise<void> {
  log.info({ env: config.NODE_ENV }, 'NexusPanel startet');

  await waitForDatabase();
  await runMigrations();

  if (await engine.ping()) {
    log.info({ version: await engine.version() }, 'Docker verbunden');
    await engine.ensureGameNetwork().catch((err: unknown) => log.warn({ err }, 'Spielnetz nicht einrichtbar'));
    await reconcile();
    await startSupervisor();
    statsCollector.start();
    startBanExpiry();
  } else {
    log.warn('Docker nicht erreichbar - Serververwaltung bleibt vorerst aus');
    log.warn(`Erwartet unter: ${config.DOCKER_SOCKET}`);
  }

  // Ohne Host-Eintrag kann niemand einen Server anlegen.
  await ensureLocalNode();

  // Speicher messen geht auch ohne Docker (Datenordner der Server).
  diskCollector.start();
  startBackupScheduler();
  startScheduleWorker();
  startAutoSleep();
  startDdnsBackgroundService();

  const app = await buildServer();
  await app.listen({ port: config.PANEL_PORT, host: '0.0.0.0' });
  log.info(`Panel laeuft auf ${config.PANEL_URL}`);

  // Mitgelieferte Eggs im Hintergrund abgleichen, damit /healthz beim Deploy sofort antwortet
  void seedBundledEggs()
    .then(() => resumeTestRunnerIfInterrupted())
    .catch((err) => log.warn({ err }, 'Hintergrund-Initialisierung der Eggs fehlgeschlagen'));

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'Beende');
      // Falls offene Browser-WebSockets app.close() aufhalten, nach 1.5s sauber beenden
      setTimeout(() => process.exit(0), 1500).unref();
      void stopTestRunner();
      stopSupervisor();
      statsCollector.stop();
      stopBanExpiry();
      diskCollector.stop();
      stopBackupScheduler();
      stopScheduleWorker();
      stopAutoSleep();
      void app
        .close()
        .then(closeDatabase)
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

process.on('uncaughtException', (err) => {
  log.error({ err }, 'Unbehandelte Ausnahme abgefangen (Prozess läuft weiter)');
});
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unbehandelte Promise-Ablehnung abgefangen (Prozess läuft weiter)');
});

main().catch((err) => {
  if (err instanceof DatabaseUnreachableError) {
    log.error(err.message);
    hint([
      'Postgres laeuft nicht.',
      '',
      'Unter Windows braucht es dafuer Docker Desktop:',
      '  winget install -e --id Docker.DockerDesktop',
      '',
      'Danach Docker Desktop starten und warten, bis das Symbol ruhig ist.',
      'Dann:  npm run db:up',
    ]);
  } else {
    log.error({ err }, 'Start fehlgeschlagen');
  }
  process.exit(1);
});
