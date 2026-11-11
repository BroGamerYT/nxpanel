import type { ServerRegistry } from './registry.js';
import type { ServerInstanceConfig } from '../types.js';

/**
 * Sucht einen Server: exakte ID, oder die ersten acht Zeichen, wenn sie eindeutig sind.
 * Ein blosser Anfang ("mc" findet "mc-test") zaehlt nicht.
 */
export function findInstance(registry: ServerRegistry, idOrShortId: string): ServerInstanceConfig | undefined {
  const list = registry.list();
  const exact = list.find((s) => s.id === idOrShortId);
  if (exact) return exact;
  if (idOrShortId.length === 8) {
    const byShort = list.filter((s) => s.id.slice(0, 8) === idOrShortId);
    if (byShort.length === 1) return byShort[0];
  }
  return undefined;
}
