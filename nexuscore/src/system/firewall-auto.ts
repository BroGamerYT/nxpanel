import fs from 'node:fs/promises';
import { PathOutsideRootError, resolveInsideRoot, serverRootFor } from '../protocol/paths.js';
import type { EventBus } from '../protocol/events.js';
import type { ServerRegistry } from '../store/registry.js';
import type { ServerInstanceConfig } from '../types.js';
import { logger } from '../logger.js';
import { FirewallError, type FirewallManager } from './firewall.js';

/**
 * Vollstaendiger Pfad des Programms eines Servers - nur, wenn es im Server-Verzeichnis liegt und es die Datei gibt.
 * (Ein Egg oder eine Konfiguration darf nie eine Freigabe fuer ein fremdes Programm auf dem Rechner verlangen.)
 */
export async function programOf(registry: ServerRegistry, instance: ServerInstanceConfig): Promise<string | null> {
  try {
    const root = serverRootFor(registry.dir);
    const workingDir = await resolveInsideRoot(root, instance.workingDir, 'workingDir');
    const exe = await resolveInsideRoot(root, instance.executable, 'executable', workingDir);
    return (await fs.stat(exe)).isFile() ? exe : null;
  } catch (err) {
    if (err instanceof PathOutsideRootError || (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export type EnsureResult = 'created' | 'present' | 'skipped' | 'needs_admin' | 'failed';

/**
 * Freigabe automatisch halten (Windows, Spiele als direkte Prozesse):
 *  - vor jedem Start: gibt es die Regel fuer das Programm des Servers? Wenn nicht (oder anderes Programm nach einer
 *    Neuinstallation, oder von Hand geloescht), wird sie angelegt - sonst fragt Windows beim ersten Start "Zugriff erlauben?",
 *    oder blockiert als Dienst ohne Bildschirm still,
 *  - beim Start des Cores: Regeln fuer Server, die es nicht mehr gibt, werden entfernt (auch wenn der Server geloescht wurde,
 *    waehrend der Core aus war, oder das Entfernen damals scheiterte),
 *  - beim Loeschen eines Servers entfernt das die Loeschroute (`onServerDeleted`).
 *
 * Ohne Administratorrechte versucht der Core es nicht zu umgehen: er schreibt einmal je Server den genauen Befehl in die Konsole.
 * Ein Fehler hier verhindert nie den Start des Servers.
 */
export class FirewallAuto {
  private readonly warned = new Set<string>();

  constructor(
    private readonly deps: {
      registry: ServerRegistry;
      firewall: FirewallManager;
      bus: EventBus;
      /** Aus (NEXUSCORE_FIREWALL_AUTO=false) oder ein Treiber, der keine Programme des Rechners startet: nichts anlegen. */
      enabled: boolean;
    },
  ) {}

  private say(serverId: string, line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.deps.bus.emit({ type: 'console', serverId, line: `[Firewall] ${line}`, stream, ts: new Date().toISOString() });
  }

  async ensure(serverId: string): Promise<EnsureResult> {
    const { registry, firewall, enabled } = this.deps;
    if (!enabled || !firewall.available) return 'skipped';
    const instance = registry.get(serverId);
    if (!instance) return 'skipped';
    try {
      const program = await programOf(registry, instance);
      if (!program) return 'skipped';
      const rec = (await firewall.records()).find((r) => r.serverId === serverId);
      if (rec && rec.program === program && (await firewall.exists(rec.name))) return 'present';
      // Anderes Programm als beim letzten Mal (Neuinstallation): die alte Regel geht weg, damit nichts Altes offen bleibt
      if (rec && rec.program !== program) await firewall.closeServer(serverId);
      await firewall.open(serverId, program);
      registry.audit('firewall.auto_open', serverId, 'core', { program });
      this.say(serverId, 'Freigabe in der Windows-Firewall angelegt - Windows fragt nicht nach.');
      this.warned.delete(serverId);
      return 'created';
    } catch (err) {
      if (err instanceof FirewallError) {
        if (!this.warned.has(serverId)) {
          this.warned.add(serverId);
          this.say(
            serverId,
            err.code === 'needs_admin'
              ? `Keine Administratorrechte: die Freigabe konnte nicht angelegt werden, Windows fragt beim ersten Start nach. Als Administrator ausführen: ${err.command ?? ''}`.trim()
              : `Freigabe nicht angelegt: ${err.message}`,
            'stderr',
          );
        }
        return err.code === 'needs_admin' ? 'needs_admin' : 'failed';
      }
      logger.warn({ err, serverId }, 'Firewall-Freigabe fehlgeschlagen');
      return 'failed';
    }
  }

  /** Beim Start des Cores: Regeln fuer nicht mehr vorhandene Server entfernen. */
  async reconcile(): Promise<{ removed: string[]; failed: string[] }> {
    const { registry, firewall } = this.deps;
    const result = { removed: [] as string[], failed: [] as string[] };
    if (!firewall.available) return result;
    const known = new Set(registry.list().map((c) => c.id));
    const orphans = [...new Set((await firewall.records()).filter((r) => !known.has(r.serverId)).map((r) => r.serverId))];
    for (const id of orphans) {
      try {
        const res = await firewall.closeServer(id);
        result.removed.push(...res.removed);
        result.failed.push(...res.failed.map((f) => f.name));
      } catch (err) {
        logger.warn({ err, serverId: id }, 'Verwaiste Firewall-Regel konnte nicht entfernt werden');
        result.failed.push(id);
      }
    }
    if (result.removed.length) registry.audit('firewall.cleanup', null, 'core', { removed: result.removed });
    if (result.failed.length) logger.warn({ failed: result.failed }, 'Verwaiste Firewall-Regeln blieben stehen (Administratorrechte?)');
    return result;
  }
}
