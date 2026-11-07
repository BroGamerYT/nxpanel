import yauzl from 'yauzl';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, chown, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

/**
 * Daten aus einem fremden Backup uebernehmen (AMP, Pterodactyl, eigenes Zip).
 *
 * Das Panel kennt die Ordnerstruktur von AMP nicht und soll sie auch nicht
 * kennen. Stattdessen sagt jedes Egg, WAS es braucht - etwa "einen Ordner
 * namens ShooterGame/Saved" - und der Import sucht diese Stelle im Archiv,
 * egal wie tief sie liegt. So funktioniert derselbe Mechanismus fuer AMP-
 * Backups, Pterodactyl-Backups und selbst gepackte Zips.
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

/** Ordner, die nie uebernommen werden: AMPs Papierkorb, Backups im Backup, Logs. */
const ALWAYS_SKIP = ['.trash', 'Backups', '__MACOSX'];

export const IMPORT_ROOT = join(dirname(config.VOLUME_ROOT), 'imports');

function segments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
}

/**
 * Welche Regel passt auf diesen Archivpfad, und was bleibt dahinter uebrig?
 * Bei mehreren Treffern gewinnt der fruehere im Pfad - so landet
 * "plugins/dynmap/world/..." beim Plugin-Ordner und nicht bei "world".
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
  // Wurzel ebenfalls aufloesen: unter Windows wird aus "/data/srv" sonst
  // "C:\data\srv", und der Vergleich schlaegt bei jedem Pfad fehl.
  const base = resolve(root);
  const full = resolve(base, ...segments(to), ...rest);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

export async function importArchive(
  shortId: string,
  archivePath: string,
  rules: ImportRule[],
  owner: string | null,
  onProgress?: (msg: string) => void,
): Promise<ImportResult> {
  if (!rules.length) throw new Error('Dieses Spiel hat keine Import-Regeln');
  const root = resolve(config.VOLUME_ROOT, shortId);
  await mkdir(root, { recursive: true });

  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true, decodeStrings: true }, (err, z) => (err || !z ? rej(err ?? new Error('Archiv nicht lesbar')) : res(z))));

  // Was gleich ueberschrieben wird, vorher beiseite legen - ein Import, der
  // die laufende Welt zerstoert, waere schlimmer als gar keiner.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(root, '.panel', `vor-import-${stamp}`);
  const movedAside = new Set<string>();
  let anyMoved = false;

  const result: ImportResult = { files: 0, bytes: 0, matched: {}, skipped: 0, backupDir: null };
  const [uid, gid] = owner ? (owner.split(':').map(Number) as [number, number]) : [undefined, undefined];

  await new Promise<void>((resolveAll, rejectAll) => {
    zip.on('error', rejectAll);
    zip.on('end', () => resolveAll());
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const isDir = entry.fileName.endsWith('/');
        const hit = matchEntry(entry.fileName, rules);
        if (!hit || isDir) {
          if (!isDir) result.skipped++;
          zip.readEntry();
          return;
        }
        const target = safeTarget(root, hit.rule.to, hit.rest);
        if (!target) { result.skipped++; zip.readEntry(); return; }

        const top = safeTarget(root, hit.rule.to, [])!;
        if (!movedAside.has(top)) {
          movedAside.add(top);
          if (await exists(top)) {
            const dest = join(backupDir, hit.rule.to);
            await mkdir(dirname(dest), { recursive: true });
            await rename(top, dest);
            anyMoved = true;
          }
        }

        await mkdir(dirname(target), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
          zip.openReadStream(entry, (err, s) => (err || !s ? rej(err ?? new Error('Eintrag nicht lesbar')) : res(s))));
        await pipeline(stream, createWriteStream(target));
        result.files++;
        result.bytes += entry.uncompressedSize;
        result.matched[hit.rule.match] = (result.matched[hit.rule.match] ?? 0) + 1;
        if (result.files % 500 === 0) onProgress?.(`${result.files} Dateien, ${(result.bytes / 1024 / 1024).toFixed(0)} MB`);
        zip.readEntry();
      })().catch(rejectAll);
    });
    zip.readEntry();
  });

  if (anyMoved) result.backupDir = backupDir;
  if (uid !== undefined && gid !== undefined) await chownTree(root, uid, gid);
  return result;
}

async function exists(p: string) {
  try { await stat(p); return true; } catch { return false; }
}

async function chownTree(dir: string, uid: number, gid: number): Promise<void> {
  await chown(dir, uid, gid).catch(() => {});
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, name);
    const st = await lstat(p).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) await chownTree(p, uid, gid);
    else await chown(p, uid, gid).catch(() => {});
  }
}

/** Archive, die schon im Import-Ordner auf dem Server liegen (per scp/WinSCP hineinkopiert). */
export async function listImportFiles(): Promise<Array<{ name: string; bytes: number; modified: Date }>> {
  await mkdir(IMPORT_ROOT, { recursive: true }).catch(() => {});
  const out: Array<{ name: string; bytes: number; modified: Date }> = [];
  for (const name of await readdir(IMPORT_ROOT).catch(() => [] as string[])) {
    if (!/\.zip$/i.test(name)) continue;
    const st = await stat(join(IMPORT_ROOT, name)).catch(() => null);
    if (st?.isFile()) out.push({ name, bytes: st.size, modified: st.mtime });
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
