import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveEntry } from '../files/files.js';
import { serverRootFor } from '../protocol/paths.js';
import type { ServerRegistry } from '../store/registry.js';

/**
 * Ordner, die der Admin-Dateimanager zeigt: die Spieldaten aller Server und
 * die Backups. Bewusst NICHT der ganze Datenordner - dort liegen die Datenbank
 * mit Konto, Sitzungen und Einstellungen.
 */
export interface AdminFileRoot {
  id: string;
  label: string;
  path: string;
  available: boolean;
  readOnly: boolean;
}

export function adminFileRoots(registry: ServerRegistry): AdminFileRoot[] {
  const servers = serverRootFor(registry.dir);
  const backups = path.join(registry.dir, 'backups');
  return [
    { id: 'spieldaten', label: 'Spieldaten', path: servers, available: existsSync(servers), readOnly: false },
    // Backups gehoeren dem Backup-Manager (Pruefsummen, Sperren): Dateien daneben zu aendern wuerde ihn verwirren
    { id: 'backups', label: 'Backups', path: backups, available: existsSync(backups), readOnly: true },
  ];
}

export function findAdminRoot(registry: ServerRegistry, id: string): AdminFileRoot | undefined {
  return adminFileRoots(registry).find((r) => r.id === id);
}

/** Server-Ordner unter den Spieldaten mit dem Namen des Servers beschriften. */
export function serverFolderLabels(registry: ServerRegistry, root: AdminFileRoot, relPath: string): Record<string, string> {
  if (root.id !== 'spieldaten' || relPath.replace(/^[\/]+|[\/]+$/g, '') !== '') return {};
  const out: Record<string, string> = {};
  for (const c of registry.list()) {
    const rel = path.relative(root.path, path.resolve(c.workingDir));
    const first = rel.split(path.sep)[0];
    if (first && first !== '..' && !path.isAbsolute(rel)) out[first] = c.game ? `${c.name} · ${c.game}` : c.name;
  }
  return out;
}

export const ORPHAN_LABEL = 'kein Server mehr – Rest eines gelöschten Servers';

/** Beschriftet Eintraege; ein Ordner ohne Server gilt als verwaist. */
export function applyLabels<T extends { name: string; is_directory: boolean }>(
  entries: T[],
  labels: Record<string, string>,
  markOrphans: boolean,
): (T & { label?: string; orphan?: boolean })[] {
  if (!markOrphans) return entries;
  return entries.map((e) => {
    if (labels[e.name]) return { ...e, label: labels[e.name] };
    if (e.is_directory && !e.name.startsWith('.')) return { ...e, label: ORPHAN_LABEL, orphan: true };
    return e;
  });
}

/**
 * Groesse der Unterordner (wie "du -d 1"), groesste zuerst. Zaehlt selbst,
 * folgt keinen Verknuepfungen und bricht nach `timeoutMs` ab.
 */
export async function folderUsage(
  root: string,
  relPath: string,
  timeoutMs = 60_000,
): Promise<{ path: string; entries: Array<{ name: string; path: string; bytes: number }>; partial: boolean }> {
  const full = await resolveEntry(root, relPath);
  const rel = path.relative(root, full).split(path.sep).join('/');
  const deadline = Date.now() + timeoutMs;
  let partial = false;
  const sizeOf = async (p: string): Promise<number> => {
    if (Date.now() > deadline) {
      partial = true;
      return 0;
    }
    const st = await lstat(p).catch(() => null);
    if (!st || st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    let sum = 0;
    for (const e of await readdir(p).catch(() => [] as string[])) sum += await sizeOf(path.join(p, e));
    return sum;
  };
  const entries: Array<{ name: string; path: string; bytes: number }> = [];
  for (const e of await readdir(full, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    entries.push({ name: e.name, path: rel ? `${rel}/${e.name}` : e.name, bytes: await sizeOf(path.join(full, e.name)) });
  }
  entries.sort((a, b) => b.bytes - a.bytes);
  return { path: rel, entries, partial };
}
