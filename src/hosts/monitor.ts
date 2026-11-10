import { log } from '../log.js';
import { refreshAllHosts } from './registry.js';

/** Wie oft der Status der Hosts abgefragt wird. */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * Hintergrund-Job, der die Hosts im Blick behält.
 *
 * Ohne diesen Job stuende in der Host-Liste ein Core als "unreachable", der
 * zwischendurch nur kurz nicht erreichbar war. Der Job fragt alle Core-Hosts
 * ab und schreibt Status und Auslastung in die Datenbank.
 *
 * Der Timer haengt den Prozess nicht fest - der Panel laeuft weiter, auch
 * wenn der Job gerade nichts zu tun hat.
 */
export function startHostMonitor(): () => void {
  const timer = setInterval(() => {
    void refreshAllHosts().catch((err: unknown) => {
      log.warn({ err }, 'Host-Abfrage fehlgeschlagen');
    });
  }, REFRESH_INTERVAL_MS);

  timer.unref();

  return () => clearInterval(timer);
}
