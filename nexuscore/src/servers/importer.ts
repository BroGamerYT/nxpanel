import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { platformFor } from '../platform/index.js';
import { extractZipMapped, listZipEntries } from '../files/archive.js';

/**
 * Daten aus einem fremden Backup uebernehmen (AMP, Pterodactyl, eigenes Zip) - dieselbe Idee wie im Panel.
 *
 * Der Core kennt die Ordnerstruktur von AMP nicht und soll sie auch nicht kennen. Jedes Egg sagt, WAS es braucht - etwa "einen
 * Ordner namens ShooterGame/Saved" - und der Import sucht diese Stelle im Archiv, egal wie tief sie liegt.
 *
 * Archive kommen von Nutzern: geschrieben wird nur ueber den geprueften Entpacker (nie aus dem Server-Ordner heraus, keine
 * Verknuepfungen, Schutz vor Archivbomben). Was ueberschrieben wird, legt der Import vorher beiseite.
 */
export interface ImportRule {
  /** Pfadstueck, nach dem im Archiv gesucht wird, z. B. "ShooterGame/Saved" oder "server.properties". */
  match: string;
  /** Ziel im Datenordner des Servers. */
  to: string;
  /** Unterordner, die nicht mitkommen (z. B. Logs). */
  exclude?: string[];
}

export interface ImportResult {
  files: number;
  bytes: number;
  matched: Record<string, number>;
  skipped: number;
  backupDir: string | null;
}

/** Ordner, die nie uebernommen werden: AMPs Papierkorb, Backups im Backup, Mac-Reste. */
const ALWAYS_SKIP = ['.trash', 'Backups', '__MACOSX'];

/** Ordner fuer Archive, die vor dem Import auf den Core geladen wurden (oder per scp hineinkopiert). */
export const importRoot = (): string => path.join(config.dataDir, 'imports');

function segments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
}

/**
 * Welche Regel passt auf diesen Archivpfad, und was bleibt dahinter uebrig?
 * Bei mehreren Treffern gewinnt der fruehere im Pfad - so landet "plugins/dynmap/world/..." beim Plugin-Ordner und nicht bei "world".
 */
export function matchEntry(entryPath: string, rules: ImportRule[]): { rule: ImportRule; rest: string[] } | null {
  const segs = segments(entryPath);
  if (segs.some((s) => ALWAYS_SKIP.includes(s))) return null;
  let best: { rule: ImportRule; rest: string[]; at: number } | null = null;
  for (const rule of rules) {
    const m = segments(rule.match);
    for (let i = 0; i + m.length <= segs.length; i++) {
      if (m.every((x, j) => segs[i + j] === x)) {
        if (!best || i < best.at) best = { rule, rest: segs.slice(i + m.length), at: i };
        break;
      }
    }
  }
  if (!best) return null;
  if (best.rule.exclude?.some((e) => best!.rest[0] === e)) return null;
  return { rule: best.rule, rest: best.rest };
}

/** Zielpfad sicher aufloesen - nichts darf aus dem Datenordner ausbrechen. */
export function safeTarget(root: string, to: string, rest: string[]): string | null {
  const base = path.resolve(root);
  const full = path.resolve(base, ...segments(to), ...rest);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function chownTree(dir: string, uid: number, gid: number): Promise<void> {
  await fs.chown(dir, uid, gid).catch(() => {});
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const p = path.join(dir, name);
    const st = await fs.lstat(p).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) await chownTree(p, uid, gid);
    else await fs.chown(p, uid, gid).catch(() => {});
  }
}

/** Was ein Import mit diesem Archiv uebernehmen wuerde - ohne etwas zu schreiben. */
export async function previewImport(archivePath: string, rules: ImportRule[]): Promise<{ files: number; bytes: number; matched: Record<string, number> }> {
  const out = { files: 0, bytes: 0, matched: {} as Record<string, number> };
  for (const e of await listZipEntries(archivePath)) {
    if (e.isDir || e.isSymlink) continue;
    const hit = matchEntry(e.name, rules);
    if (!hit) continue;
    out.files++;
    out.bytes += e.size;
    out.matched[hit.rule.match] = (out.matched[hit.rule.match] ?? 0) + 1;
  }
  return out;
}

export async function importArchive(
  serverDir: string,
  archivePath: string,
  rules: ImportRule[],
  owner: string | null,
  onProgress?: (msg: string) => void,
): Promise<ImportResult> {
  if (!rules.length) throw new Error('Dieses Spiel hat keine Import-Regeln');
  const root = path.resolve(serverDir);
  await fs.mkdir(root, { recursive: true });

  const preview = await previewImport(archivePath, rules);
  onProgress?.(`${preview.files} Dateien, ${(preview.bytes / 1024 / 1024).toFixed(0)} MB werden uebernommen`);

  // Was gleich ueberschrieben wird, vorher beiseite legen - ein Import, der die laufende Welt zerstoert, waere schlimmer als keiner.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(root, '.nexuscore', `vor-import-${stamp}`);
  const tops = new Map<string, string>();
  for (const e of await listZipEntries(archivePath)) {
    if (e.isDir) continue;
    const hit = matchEntry(e.name, rules);
    if (!hit) continue;
    const top = safeTarget(root, hit.rule.to, []);
    if (top && top !== root) tops.set(top, hit.rule.to);
  }
  let moved = false;
  for (const [top, to] of tops) {
    if (!(await exists(top))) continue;
    const dest = path.join(backupDir, ...segments(to));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(top, dest);
    moved = true;
  }

  const result = await extractZipMapped(archivePath, root, (name, isDir) => {
    if (isDir) return null;
    const hit = matchEntry(name, rules);
    return hit ? [...segments(hit.rule.to), ...hit.rest].join('/') : null;
  });
  if (owner && platformFor().id !== 'windows') {
    const [uid, gid] = owner.split(':').map(Number) as [number, number];
    if (Number.isInteger(uid) && Number.isInteger(gid)) await chownTree(root, uid, gid);
  }
  return {
    files: result.filesCount,
    bytes: preview.bytes,
    matched: preview.matched,
    skipped: result.skipped,
    backupDir: moved ? backupDir : null,
  };
}

/** Archive im Import-Ordner (per Upload oder scp/WinSCP hineinkopiert), neueste zuerst. */
export async function listImportFiles(): Promise<Array<{ name: string; bytes: number; modified: Date }>> {
  const dir = importRoot();
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const out: Array<{ name: string; bytes: number; modified: Date }> = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!/\.zip$/i.test(name)) continue;
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) out.push({ name, bytes: st.size, modified: st.mtime });
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
