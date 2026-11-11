import net from 'node:net';
import { config } from '../config/index.js';
import type { ServerInstanceConfig } from '../types.js';

/** Prueft mit einem echten Bindungsversuch, ob ein TCP-Port frei ist. */
export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Sucht einen freien Port im konfigurierten Bereich (Block A5).
 *
 * Frueher wurde `25565 + Anzahl der Server` vergeben - nach einer Loeschung
 * traf das einen schon belegten Port. Jetzt zaehlen die Ports aller
 * registrierten Instanzen als belegt, und der Kandidat wird zusaetzlich
 * wirklich gebunden, damit auch fremde Programme auffallen.
 */
export async function allocatePort(
  servers: ServerInstanceConfig[],
  probe: (port: number) => Promise<boolean> = isPortFree,
  range: { from: number; to: number } = config.portRange,
): Promise<number> {
  const taken = new Set<number>();
  for (const server of servers) {
    for (const port of server.ports) taken.add(port.hostPort);
  }

  const { from, to } = range;
  for (let port = from; port <= to; port++) {
    if (taken.has(port)) continue;
    if (await probe(port)) return port;
  }
  throw new Error(`Kein freier Port im Bereich ${from}-${to}. Bereich mit NEXUSCORE_PORT_RANGE vergroessern.`);
}
