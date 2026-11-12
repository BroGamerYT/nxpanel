import fs from 'node:fs/promises';
import path from 'node:path';
import { patchConfigFile, type ConfigFileSpec } from '../eggs/config-files.js';
import { substitute, type SubstitutionContext } from '../eggs/substitute.js';
import { resolveInsideRoot, PathOutsideRootError } from '../protocol/paths.js';

/**
 * Schreibt die Konfigurationsdateien des Eggs in den Server-Ordner, vor jedem Start (wie im Panel):
 * so stimmen Port und Name auch nach einer Aenderung der Einstellungen. Es wird nur geaendert, was das Egg nennt.
 *
 * Eggs kommen aus dem Internet: jeder Pfad muss im Server-Ordner bleiben (auch ueber Links), sonst wird er uebersprungen.
 */
export async function applyConfigFiles(
  root: string,
  specs: Record<string, { parser: string; find?: Record<string, unknown>; set?: Record<string, unknown> }> | undefined,
  ctx: SubstitutionContext,
  say: (line: string) => void,
): Promise<void> {
  if (!specs) return;
  for (const [rel, spec] of Object.entries(specs)) {
    let full: string;
    try {
      full = await resolveInsideRoot(root, rel, 'config_files');
    } catch (err) {
      if (err instanceof PathOutsideRootError) {
        say(`[Konfiguration] ${rel}: Pfad liegt außerhalb des Server-Ordners - übersprungen.`);
        continue;
      }
      throw err;
    }
    try {
      if (spec.parser === 'sqlite') {
        await patchSqlite(full, spec, ctx, rel, say);
        continue;
      }
      let original = '';
      try {
        original = await fs.readFile(full, 'utf8');
      } catch {
        /* noch nicht vorhanden: das Egg darf sie anlegen */
      }
      const result = patchConfigFile(original, spec as ConfigFileSpec, ctx);
      if (result.changed.length === 0 && result.added.length === 0) continue;
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, result.content, 'utf8');
      say(`[Konfiguration] ${rel} angepasst (${[...result.changed, ...result.added].join(', ')})`);
      if (result.skipped.length) say(`[Konfiguration] ${rel}: Schlüssel nicht gefunden: ${result.skipped.join(', ')}`);
    } catch (err) {
      // Eine kaputte Konfigurationsdatei darf den Start nicht verhindern
      say(`[Konfiguration] ${rel}: ${(err as Error).message}`);
    }
  }
}

/** Einstellungen in einer SQLite-Datenbank (z. B. TeamSpeak): Schluessel "tabelle.spalte". Gibt es die Datei noch nicht, legt der Server sie selbst an. */
async function patchSqlite(file: string, spec: { find?: Record<string, unknown>; set?: Record<string, unknown> }, ctx: SubstitutionContext, rel: string, say: (l: string) => void): Promise<void> {
  try {
    await fs.access(file);
  } catch {
    return;
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const [key, template] of Object.entries(spec.find ?? spec.set ?? {})) {
      const [table, column] = key.split('.');
      if (!table || !column || !ident.test(table) || !ident.test(column)) {
        say(`[Konfiguration] ${rel}: ungültiger Datenbank-Schlüssel "${key}"`);
        continue;
      }
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) continue;
      const value = substitute(typeof template === 'string' ? template : String(template ?? ''), ctx);
      const r = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" IS NOT ?`).run(value, value);
      if (Number(r.changes) > 0) say(`[Konfiguration] ${rel}: ${key} = ${value}`);
    }
  } finally {
    db.close();
  }
}
