import os from 'node:os';
import { CORE_VERSION } from '../../version.js';
import { config } from '../../config/index.js';
import { describePlatform } from '../../platform/index.js';
import { canSeeServer } from '../authz.js';
import { CORE_FEATURES } from './api-constants.js';
import { listDocs } from '../../docs.js';
import { aboutData } from '../../about-data.js';
import type { ApiContext } from './api-context.js';

/**
 * Überblick: Core-Info (about) und Dashboard.
 */
export function registerOverviewRoutes(ctx: ApiContext): void {
  const { server, driver, registry, account, firewall } = ctx;

  // 2. Info & Systemstatus
  // Bereiche der Oberflaeche, die der Core kann. Alles andere blendet die Oberflaeche aus,
  // statt "Nicht gefunden" zu zeigen. Kommt eine Funktion dazu, steht sie hier.
  server.get('/api/v1/about', async () => {
    return {
      name: 'NexusPanel Standalone (NexusCore)',
      version: CORE_VERSION,
      build: 'standalone-native',
      sftp: { enabled: config.sftpEnabled && account !== null, port: config.sftpPort },
      // Welches System, welche Treiber, was es hier gibt (Firewall, Dienst) - die Oberflaeche blendet Unmoegliches aus
      platform: describePlatform(config.runtime),
      standalone: true,
      features: CORE_FEATURES.filter((f) => f !== 'firewall' || firewall.available),
      // "Was ist neu", "Geplant" und "Entwickler-Log" aus den Markdown-Dateien der docs-Ordner
      ...(await aboutData()),
      // Hilfe-Seite: die Dokumente aus den docs-Ordnern
      docs: await listDocs(),
    };
  });

  server.get('/api/v1/dashboard', async (req) => {
    const actor = req.actor!;
    const configs = registry.list().filter((c) => canSeeServer(registry, c.id, actor));
    const visible = new Set(configs.map((c) => c.id));
    const states = (await driver.listServers()).filter((s) => visible.has(s.id));
    const runningCount = states.filter((s) => s.status === 'running').length;

    let totalRamMb = 0;
    const perServer: Record<string, { cpuPercent: number; memMb: number; rxRate: number; txRate: number }> = {};
    const diskUsed: Record<string, number> = {};

    // Alle laufenden Server gleichzeitig messen (je Messung dauert mit Docker 1-2 s)
    await Promise.all(
      states.map(async (s) => {
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
      }),
    );

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
}
