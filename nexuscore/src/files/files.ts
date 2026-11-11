import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PathOutsideRootError, isInside, resolveInsideRoot } from '../protocol/paths.js';

/**
 * Dateizugriff auf einen Server-Ordner (Block B4).
 *
 * Nach dem Vorbild von `src/servers/files.ts` im Panel, bewusst nachgebaut
 * statt geteilt (der Core darf `src/` des Panels nicht importieren). Jeder
 * Pfad wird gegen den Ordner des Servers geprueft - vor und nach dem
 * Aufloesen von Symlinks (`resolveInsideRoot`, Block A3).
 */

export type FileErrorCode =
  | 'invalid_path'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'not_a_file'
  | 'not_a_directory'
  | 'invalid_name';

/** Ein Fehler, den der Nutzer lesen soll - die Route macht daraus eine Antwort mit passendem Statuscode. */
export class FileAccessError extends Error {
  constructor(
    message: string,
    readonly code: FileErrorCode,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'FileAccessError';
  }
}

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  is_symlink: boolean;
  size: number;
  modified_at: string;
  mode: string;
}

/** Groesse, bis zu der der Editor Dateien oeffnet. */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

/** Geraetenamen von Windows: eine Datei "nul" oder "con.txt" waere dort ein Geraet, keine Datei. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Prueft einen einzelnen Namen (Datei oder Ordner).
 *
 * Unter Windows sind Geraetenamen, ":" (Alternative Datenstroeme: "a.txt:x"
 * versteckt Daten in einer Datei), Sonderzeichen sowie ein Punkt oder
 * Leerzeichen am Ende nicht erlaubt - Windows wuerde den Namen still
 * umdeuten. Ueberall verboten: leer, "." und "..", Steuerzeichen.
 */
export function assertSafeName(name: string, platform: NodeJS.Platform = process.platform): void {
  // eslint-disable-next-line no-control-regex
  if (name === '' || name === '.' || name === '..' || /[\u0000-\u001f]/.test(name)) {
    throw new FileAccessError('Ungültiger Name', 'invalid_name', 400);
  }
  if (platform === 'win32') {
    if (WINDOWS_DEVICE.test(name) || /[:<>"|?*]/.test(name) || /[. ]$/.test(name)) {
      throw new FileAccessError(
        `„${name}“ ist unter Windows kein zulässiger Name (reservierter Name, Sonderzeichen oder Punkt/Leerzeichen am Ende)`,
        'invalid_name',
        400,
      );
    }
  }
}

/** Vereinheitlicht eine Pfadangabe der Oberflaeche zu "a/b/c" und prueft jeden Namen darin. */
export function cleanRelative(input: string, platform: NodeJS.Platform = process.platform): string {
  if (input.includes('\0')) throw new FileAccessError('Null-Bytes im Pfad sind nicht zulässig', 'invalid_path', 400);
  const rel = input.replace(/\\/g, '/').replace(/^\/+/, '');
  for (const segment of rel.split('/')) {
    // "." und ".." loest die Pfadpruefung auf; leere Teile (a//b) sind harmlos.
    if (segment === '' || segment === '.' || segment === '..') continue;
    assertSafeName(segment, platform);
  }
  return rel;
}

const toRel = (root: string, full: string): string => path.relative(root, full).replace(/\\/g, '/');

/**
 * Loest eine Angabe der Oberflaeche gegen den Server-Ordner auf.
 * Liegt das Ergebnis ausserhalb (auch ueber einen Symlink), gibt es 400.
 */
export async function resolveEntry(root: string, input: string): Promise<string> {
  const rel = cleanRelative(input);
  try {
    return await resolveInsideRoot(root, rel === '' ? '.' : rel, 'Pfad');
  } catch (err) {
    if (err instanceof PathOutsideRootError) {
      throw new FileAccessError('Zugriff außerhalb des Serververzeichnisses verweigert', 'invalid_path', 400);
    }
    throw err;
  }
}

export async function listDirectory(root: string, relPath = ''): Promise<{ current: string; entries: FileEntry[] }> {
  const dir = await resolveEntry(root, relPath);
  const info = await stat(dir);
  if (!info.isDirectory()) {
    throw new FileAccessError(`Pfad "${relPath}" ist kein Verzeichnis`, 'not_a_directory', 400);
  }

  const current = toRel(root, dir);
  const entries: FileEntry[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    try {
      const own = await lstat(child);
      const isSymlink = own.isSymbolicLink();
      let isDirectory = entry.isDirectory();
      let size = own.size;
      if (isSymlink) {
        try {
          const target = await stat(child);
          isDirectory = target.isDirectory();
          size = target.size;
        } catch {
          // Gebrochener Verweis: als Datei zeigen
        }
      }
      entries.push({
        name: entry.name,
        path: current ? `${current}/${entry.name}` : entry.name,
        is_directory: isDirectory,
        is_symlink: isSymlink,
        size: isDirectory ? 0 : size,
        modified_at: own.mtime.toISOString(),
        mode: (own.mode & 0o777).toString(8).padStart(3, '0'),
      });
    } catch {
      // Verschwindet eine Datei waehrenddessen, wird sie uebersprungen.
    }
  }

  // Ordner zuerst, dann alphabetisch mit Zahlen in natuerlicher Reihenfolge
  entries.sort((a, b) =>
    a.is_directory !== b.is_directory
      ? a.is_directory
        ? -1
        : 1
      : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
  return { current, entries };
}

export async function readFileContent(
  root: string,
  relPath: string,
  maxBytes = MAX_EDIT_BYTES,
): Promise<{ content: string; size: number }> {
  const file = await resolveEntry(root, relPath);
  const info = await stat(file);
  if (info.isDirectory()) throw new FileAccessError('Verzeichnisse können nicht als Text geöffnet werden', 'not_a_file', 400);
  if (info.size > maxBytes) {
    throw new FileAccessError(
      `Datei ist mit ${(info.size / 1024 / 1024).toFixed(1)} MB zu groß für den Editor (maximal ${Math.round(maxBytes / 1024 / 1024)} MB)`,
      'too_large',
      413,
    );
  }
  return { content: await readFile(file, 'utf-8'), size: info.size };
}

/** Der Ordner des Servers selbst ist nie Ziel einer Aenderung. */
function assertNotRoot(root: string, full: string, what: string): void {
  if (path.resolve(full) === path.resolve(root)) {
    throw new FileAccessError(`${what} betrifft den Ordner des Servers selbst und ist nicht erlaubt`, 'invalid_path', 400);
  }
}

export async function writeFileContent(root: string, relPath: string, content: string): Promise<void> {
  const file = await resolveEntry(root, relPath);
  assertNotRoot(root, file, 'Schreiben');
  try {
    if ((await stat(file)).isDirectory()) {
      throw new FileAccessError('An dieser Stelle gibt es einen Ordner, keine Datei', 'not_a_file', 400);
    }
  } catch (err) {
    if (err instanceof FileAccessError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf-8');
}

export async function createDirectory(root: string, relPath: string): Promise<void> {
  const dir = await resolveEntry(root, relPath);
  assertNotRoot(root, dir, 'Anlegen');
  await mkdir(dir, { recursive: true });
}

export async function renamePath(root: string, fromRel: string, toRel_: string): Promise<void> {
  const from = await resolveEntry(root, fromRel);
  const to = await resolveEntry(root, toRel_);
  assertNotRoot(root, from, 'Umbenennen');
  assertNotRoot(root, to, 'Umbenennen');

  await lstat(from).catch(() => {
    throw new FileAccessError(`„${fromRel}“ existiert nicht`, 'not_found', 404);
  });
  if (
    await lstat(to).then(
      () => true,
      () => false,
    )
  ) {
    throw new FileAccessError(`„${toRel_}“ existiert bereits`, 'conflict', 409);
  }
  // Ein Ordner kann nicht in sich selbst verschoben werden.
  if (isInside(from, to)) {
    throw new FileAccessError('Ein Ordner kann nicht in sich selbst verschoben werden', 'invalid_path', 400);
  }
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
}

export async function deletePath(root: string, relPath: string): Promise<void> {
  const target = await resolveEntry(root, relPath);
  assertNotRoot(root, target, 'Löschen');
  // `rm` folgt keinen Symlinks: ein Verweis wird entfernt, nicht sein Ziel.
  await rm(target, { recursive: true, force: true });
}

export async function openDownload(
  root: string,
  relPath: string,
): Promise<{ stream: NodeJS.ReadableStream; filename: string; size: number }> {
  const file = await resolveEntry(root, relPath);
  const info = await stat(file);
  if (info.isDirectory()) {
    throw new FileAccessError('Verzeichnisse können nicht direkt als Einzeldatei heruntergeladen werden', 'not_a_file', 400);
  }
  return { stream: createReadStream(file), filename: path.basename(file), size: info.size };
}

/** Zielpfad fuer einen Upload: Ordner + Dateiname, jeder Teil geprueft. */
export async function resolveUploadTarget(root: string, dirRel: string, filename: string | undefined): Promise<string> {
  // Ein Teil der Anfrage ohne Dateinamen ist keine Datei.
  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new FileAccessError('Ungültiger Dateiname', 'invalid_name', 400);
  }
  // Nur der Dateiname, nie ein Pfad - auch kein Windows-Pfad auf Linux.
  const name = path.win32.basename(path.posix.basename(filename.replace(/[\0\r\n]/g, '')));
  assertSafeName(name);
  const dir = await resolveEntry(root, dirRel);
  const target = await resolveEntry(root, `${toRel(root, dir)}/${name}`);
  assertNotRoot(root, target, 'Hochladen');
  try {
    if ((await stat(target)).isDirectory()) {
      throw new FileAccessError('An dieser Stelle gibt es einen Ordner mit demselben Namen', 'conflict', 409);
    }
  } catch (err) {
    if (err instanceof FileAccessError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return target;
}
