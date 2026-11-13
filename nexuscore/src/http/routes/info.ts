import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { config } from '../../config/index.js';
import { tokenFingerprint } from '../../protocol/security.js';
import { getSystemMetrics } from '../../system/monitor.js';

import { CORE_VERSION } from '../../version.js';

export { CORE_VERSION };

/**
 * Host-Status.
 *
 * Oeffentlich, damit das Panel einen erreichbaren Core erkennt, ohne schon
 * gekoppelt zu sein. Der Token wird dabei nie ausgegeben - nur sein
 * Fingerabdruck, damit der Admin sieht, welcher Token hinterlegt ist.
 */
export function registerInfoRoutes(server: FastifyInstance): void {
  server.get('/core/v1/info', async () => {
    const metrics = await getSystemMetrics(config.dataDir);

    return {
      status: 'ok',
      host: {
        id: `host-${os.hostname().toLowerCase()}`,
        name: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        runtime: config.runtime,
        version: CORE_VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
      },
      metrics,
      core: {
        version: CORE_VERSION,
        runtime: config.runtime,
        mode: config.mode,
        dataDir: config.dataDir,
        tokenFingerprint: tokenFingerprint(),
      },
    };
  });
}
