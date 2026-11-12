import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadEggs } from '../eggs/loader.js';
import { resolveInstanceDir } from '../files/instance-dir.js';
import type { InstallManager } from '../install/manager.js';
import { logger } from '../logger.js';
import type { EventBus } from '../protocol/events.js';
import type { ServerRegistry } from '../store/registry.js';
import type { DetectSpec, EggForDetect } from './detect.js';
import { importArchive, type ImportRule } from './importer.js';

/**
 * Import laufen lassen (fuer einen vorhandenen Server und direkt nach dem Anlegen): Regeln aus dem Egg, ein Import je Server
 * gleichzeitig, Ausgabe in der Konsole des Servers, Audit-Eintraege. Waehrenddessen laesst sich der Server nicht starten
 * (`isImporting`, abgefragt vor dem Start).
 */

export const ruleSchema = z
  .array(z.object({ match: z.string().min(1).max(200), to: z.string().min(1).max(200), exclude: z.array(z.string().max(100)).max(20).optional() }))
  .max(50);

export interface PendingImport {
  path: string;
  name: string;
  /** Hochgeladene Dateien werden nach dem Import geloescht, hineinkopierte bleiben liegen. */
  removeAfter: boolean;
}

export class ImportService {
  private readonly running = new Set<string>();

  constructor(
    private readonly deps: {
      registry: ServerRegistry;
      bus: EventBus;
      installs: InstallManager | null;
    },
  ) {}

  isImporting(serverId: string): boolean {
    return this.running.has(serverId);
  }

  private say(serverId: string, line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.deps.bus.emit({ type: 'console', serverId, line: `[Import] ${line}`, stream, ts: new Date().toISOString() });
  }

  /** Regeln und Besitzer (run_as) eines Spiels. */
  async loadRules(eggId: string): Promise<{ rules: ImportRule[]; owner: string | null; notes: string | null }> {
    const egg = (await loadEggs()).find((e) => e.id === eggId);
    const imp = (egg?.raw as { import?: { rules?: unknown; notes?: unknown } } | undefined)?.import;
    const parsed = ruleSchema.safeParse(imp?.rules ?? []);
    const owner = typeof egg?.raw.run_as === 'string' && /^\d{1,7}:\d{1,7}$/.test(egg.raw.run_as) ? egg.raw.run_as : null;
    return { rules: parsed.success ? (parsed.data as ImportRule[]) : [], owner, notes: typeof imp?.notes === 'string' ? imp.notes : null };
  }

  /** Alle Spiele mit ihren Import-Regeln und Erkennungsmerkmalen (fuer die Analyse eines Archivs). */
  async eggsForDetect(): Promise<EggForDetect[]> {
    return (await loadEggs()).map((e) => {
      const imp = (e.raw as { import?: { rules?: unknown; detect?: unknown } }).import;
      const parsed = ruleSchema.safeParse(imp?.rules ?? []);
      return { id: e.id, name: e.name, rules: parsed.success ? (parsed.data as ImportRule[]) : [], detect: (imp?.detect as DetectSpec | null | undefined) ?? null };
    });
  }

  /**
   * Import starten (im Hintergrund). Wirft nie: Fehler stehen in der Konsole des Servers und im Audit-Protokoll.
   * @returns false, wenn schon ein Import fuer diesen Server laeuft
   */
  start(serverId: string, file: PendingImport, actor: string): boolean {
    if (this.running.has(serverId)) return false;
    this.running.add(serverId);
    void this.run(serverId, file, actor).finally(() => this.running.delete(serverId));
    return true;
  }

  private async run(serverId: string, file: PendingImport, actor: string): Promise<void> {
    const { registry } = this.deps;
    try {
      const c = registry.get(serverId);
      if (!c) throw new Error('Server nicht gefunden');
      const { rules, owner } = await this.loadRules(c.game);
      if (!rules.length) throw new Error('Für dieses Spiel gibt es noch keine Import-Regeln');
      const dir = await resolveInstanceDir(registry, c);
      if (!dir) throw new Error('Der Server-Ordner ist nicht erreichbar');
      this.say(serverId, `Daten aus ${file.name} werden übernommen`);
      registry.audit('server.import_start', serverId, 'core', { file: file.name, by: actor });
      const r = await importArchive(dir, file.path, rules, owner, (m) => this.say(serverId, m));
      const parts = Object.entries(r.matched).map(([k, n]) => `${k}: ${n}`).join(', ');
      this.say(
        serverId,
        r.files === 0
          ? `Nichts Passendes gefunden (gesucht: ${rules.map((x) => x.match).join(', ')})`
          : `Fertig: ${r.files} Dateien, ${(r.bytes / 1024 / 1024).toFixed(0)} MB (${parts})${r.backupDir ? ' - vorherige Daten liegen in .nexuscore/' : ''}`,
        r.files === 0 ? 'stderr' : 'stdout',
      );
      registry.audit('server.import_done', serverId, 'core', { file: file.name, files: r.files, bytes: r.bytes, skipped: r.skipped });
      if (file.removeAfter) await fs.rm(file.path, { force: true }).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, serverId }, 'Import fehlgeschlagen');
      this.say(serverId, `Fehlgeschlagen: ${message}. Die Datei bleibt liegen - unter Einstellungen erneut versuchen.`, 'stderr');
      registry.audit('server.import_failed', serverId, 'core', { file: file.name, error: message.slice(0, 200) });
    }
  }

  /** Nach dem Anlegen: erst die Installation abwarten (falls es eine gibt), dann importieren. */
  afterCreate(serverId: string, file: PendingImport, actor: string): void {
    const { installs, registry } = this.deps;
    this.running.add(serverId); // der Server ist bis zum Ende des Imports nicht startbar
    void (async () => {
      try {
        if (installs) await installs.whenIdle(serverId);
        const c = registry.get(serverId);
        if (c?.install && c.install.state !== 'done') {
          this.say(serverId, 'Import übersprungen: die Installation ist nicht abgeschlossen. Später unter Einstellungen nachholen.', 'stderr');
          return;
        }
        await this.run(serverId, file, actor);
      } finally {
        this.running.delete(serverId);
      }
    })();
  }
}

export const uploadPrefix = (userId: string): string => `upload-u${userId.slice(0, 8)}-`;

/** Wem gehoert eine Datei im Import-Ordner? Administratoren alles (per scp hineinkopiert), alle anderen nur Eigenes. */
export function mayUseImportFile(actor: { id: string; role: string; master?: boolean }, name: string): boolean {
  return actor.master === true || actor.role === 'admin' || path.basename(name).startsWith(uploadPrefix(actor.id));
}
