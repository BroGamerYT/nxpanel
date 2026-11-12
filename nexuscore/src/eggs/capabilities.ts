/**
 * Linux-Capabilities, die ein Egg fuer seinen Container anfordern darf.
 *
 * Grundsatz: Jeder Spielcontainer startet mit CapDrop ALL. Manche Images
 * brauchen aber einzelne Rechte zurueck - etwa das itzg-Minecraft-Image, das
 * als root startet, die Daten an Benutzer 1000 uebergibt (CHOWN) und dann
 * per gosu dorthin wechselt (SETUID, SETGID).
 *
 * Eggs kommen aus dem Internet. Deshalb gilt eine feste Erlaubnisliste:
 * Was hier nicht steht, wird verworfen - egal, was im Egg steht. Rechte wie
 * SYS_ADMIN, NET_ADMIN oder SYS_PTRACE wuerden einen Ausbruch aus dem
 * Container deutlich erleichtern und haben in einem Spielserver nichts
 * verloren.
 */

export const ALLOWED_CAPABILITIES = new Set([
  'CHOWN',            // Dateibesitzer aendern - fuer die Uebergabe an den Spielbenutzer
  'SETUID',           // Benutzer wechseln - gosu, su-exec
  'SETGID',           // Gruppe wechseln - gosu, su-exec
  'DAC_OVERRIDE',     // Dateirechte beim Einrichten uebergehen
  'FOWNER',           // Rechte an fremden Dateien setzen
  'KILL',             // Kindprozesse beenden, etwa bei Wrapper-Skripten
  'NET_BIND_SERVICE', // Ports unter 1024 - fuer Spiele, die darauf bestehen
]);

export interface CapabilityResult {
  granted: string[];
  rejected: string[];
}

export function filterCapabilities(requested: unknown): CapabilityResult {
  if (!Array.isArray(requested)) return { granted: [], rejected: [] };

  const granted: string[] = [];
  const rejected: string[] = [];

  for (const raw of requested) {
    if (typeof raw !== 'string') continue;
    const cap = raw.trim().toUpperCase().replace(/^CAP_/, '');
    if (ALLOWED_CAPABILITIES.has(cap)) {
      if (!granted.includes(cap)) granted.push(cap);
    } else {
      rejected.push(cap);
    }
  }

  return { granted, rejected };
}

/** Datenpfad im Container. Nur absolute, harmlose Pfade. */
export function sanitizeDataPath(path: unknown): string {
  const fallback = '/home/container';
  if (typeof path !== 'string') return fallback;
  const p = path.trim();
  if (!p.startsWith('/') || p.includes('..') || p === '/') return fallback;
  // Systempfade waeren ein Weg, Dateien des Images zu ueberschreiben.
  if (/^\/(bin|boot|dev|etc|lib|lib64|proc|root|sbin|sys|usr)(\/|$)/.test(p)) return fallback;
  return p.replace(/\/+$/, '');
}
