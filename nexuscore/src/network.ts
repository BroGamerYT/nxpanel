import { config } from './config/index.js';
import type { ServerRegistry } from './store/registry.js';

/**
 * Netzwerk-Einstellungen des Cores: oeffentliche Adresse (so verbinden Spieler)
 * und der Port-Bereich fuer neue Server. Gespeichert in den Einstellungen der
 * Datenbank; ohne Eintrag gilt `NEXUSCORE_PORT_RANGE` und 127.0.0.1.
 */
export interface NetworkSettings {
  publicHost: string | null;
  portFrom: number;
  portTo: number;
}

const KEY = 'network';

interface Stored {
  publicHost?: string | null;
  portFrom?: number | null;
  portTo?: number | null;
}

export function getNetwork(registry: ServerRegistry): NetworkSettings {
  const s = registry.getSetting<Stored>(KEY) ?? {};
  return {
    publicHost: s.publicHost ?? null,
    portFrom: s.portFrom ?? config.portRange.from,
    portTo: s.portTo ?? config.portRange.to,
  };
}

export function setNetwork(registry: ServerRegistry, patch: Stored): NetworkSettings {
  const cur = registry.getSetting<Stored>(KEY) ?? {};
  registry.setSetting(KEY, { ...cur, ...patch });
  return getNetwork(registry);
}

/** Adresse fuer die Oberflaeche: ohne Einstellung die lokale. */
export function publicHostOf(registry: ServerRegistry): string {
  return getNetwork(registry).publicHost ?? '127.0.0.1';
}

/** Hostname oder IPv4: Buchstaben, Ziffern, Punkte, Bindestriche - nie Pfade, Ports oder Schemata. */
export const HOST_PATTERN = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
