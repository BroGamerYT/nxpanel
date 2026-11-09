import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import {
  stat,
  lstat,
  readdir,
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  realpath,
} from 'node:fs/promises';
import { resolve, dirname, basename, join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { volumePath } from '../docker/client.js';

/**
 * Wurzel fuer Dateioperationen: die Kurz-ID eines Servers (dessen Volume)
 * oder ein fester Ordner, z. B. fuer den Admin-Dateimanager.
 */
export type FileRoot = string | { root: string };

export class FilePathSecurityError extends Error {
  constructor(message = 'Ungültiger oder unzulässiger Pfad') {
    super(message);
    this.name = 'FilePathSecurityError';
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

/**
 * Normalisiert und sichert Pfade ab:
 * Verhindert Directory Traversal (../, null bytes, Symlink-Ausbrüche aus dem Server-Volume).
 */
export async function safePath(shortId: FileRoot, relPath: string): Promise<{ root: string; fullPath: string; relPath: string }> {
  const root = resolve(typeof shortId === 'string' ? volumePath(shortId) : shortId.root);

  // Null-Bytes abfangen
  if (relPath.includes('\0')) {
    throw new FilePathSecurityError('Null-Bytes im Pfad sind nicht zulässig');
  }

  // Windows-Backslashes normalisieren, fuehrende Slashes trimmen
  const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidate = resolve(root, cleanRel);

  // Einfache Prefix-Pruefung vorab
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new FilePathSecurityError('Zugriff außerhalb des Serververzeichnisses verweigert');
  }

  // Sicherstellen, dass das Wurzelverzeichnis auf der Festplatte existiert
  if (!existsSync(root)) {
    // Server-Volumes legt das Panel bei Bedarf an, feste Ordner (Admin) nicht.
    if (typeof shortId !== 'string') throw new FilePathSecurityError('Ordner ist nicht vorhanden oder nicht eingebunden');
    await mkdir(root, { recursive: true, mode: 0o750 });
  }

  const rootReal = await realpath(root);

  // Symlink-Traversal-Pruefung:
  // Wenn der Pfad existiert, muss sein realpath innerhalb von rootReal liegen.
  if (existsSync(candidate)) {
    const candidateReal = await realpath(candidate);
    if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + sep)) {
      throw new FilePathSecurityError('Symlink verweist außerhalb des Serververzeichnisses');
    }
    return {
      root: rootReal,
      fullPath: candidateReal,
      relPath: relative(rootReal, candidateReal).replace(/\\/g, '/'),
    };
  }

  // Wenn der Pfad noch nicht existiert (z. B. beim Anlegen neuer Dateien/Ordner):
  // Den naechstgelegenen existierenden Elternordner pruefen.
  let cur = dirname(candidate);
  while (!existsSync(cur) && cur !== root && cur.startsWith(root + sep)) {
    cur = dirname(cur);
  }

  if (existsSync(cur)) {
    const curReal = await realpath(cur);
    if (curReal !== rootReal && !curReal.startsWith(rootReal + sep)) {
      throw new FilePathSecurityError('Übergeordneter Ordner verweist außerhalb des Serververzeichnisses');
    }
  }

  const normalizedRel = relative(rootReal, candidate).replace(/\\/g, '/');
  return {
    root: rootReal,
    fullPath: candidate,
    relPath: normalizedRel,
  };
}

/**
 * Ordnerinhalt auflisten
 */
export async function listDirectory(shortId: FileRoot, relPath = ''): Promise<{ current: string; entries: FileEntry[] }> {
  const { fullPath, relPath: resolvedRel } = await safePath(shortId, relPath);

  const st = await stat(fullPath);
  if (!st.isDirectory()) {
    throw new Error(`Pfad "${relPath}" ist kein Verzeichnis`);
  }

  const dirEntries = await readdir(fullPath, { withFileTypes: true });
  const entries: FileEntry[] = [];

  for (const entry of dirEntries) {
    // Interne Panel-Metadatenordner ausblenden
    if (entry.name === '.panel') continue;

    const childRel = resolvedRel ? `${resolvedRel}/${entry.name}` : entry.name;
    const childFull = join(fullPath, entry.name);

    try {
      const childStat = await lstat(childFull);
      const isSymlink = childStat.isSymbolicLink();
      let isDir = entry.isDirectory();
      let size = childStat.size;

      if (isSymlink) {
        try {
          const targetStat = await stat(childFull);
          isDir = targetStat.isDirectory();
          size = targetStat.size;
        } catch {
          // Gebrochener Symlink
        }
      }

      entries.push({
        name: entry.name,
        path: childRel,
        is_directory: isDir,
        is_symlink: isSymlink,
        size: isDir ? 0 : size,
        modified_at: childStat.mtime.toISOString(),
        mode: (childStat.mode & 0o777).toString(8).padStart(3, '0'),
      });
    } catch {
      // Wenn eine Datei waehrenddessen verschwindet, ueberspringen
    }
  }

  // Sortierung: Verzeichnisse zuerst, dann alphabetisch
  entries.sort((a, b) => {
    if (a.is_directory !== b.is_directory) {
      return a.is_directory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return {
    current: resolvedRel,
    entries,
  };
}

/**
 * Dateiinhalt als Text lesen
 */
export async function readFileContent(
  shortId: FileRoot,
  relPath: string,
  maxBytes = 5 * 1024 * 1024
): Promise<{ content: string; size: number }> {
  const { fullPath } = await safePath(shortId, relPath);

  const st = await stat(fullPath);
  if (st.isDirectory()) {
    throw new Error('Verzeichnisse können nicht als Text geöffnet werden');
  }

  if (st.size > maxBytes) {
    throw new Error(`Datei ist mit ${(st.size / 1024 / 1024).toFixed(1)} MB zu groß für den Editor (maximal 5 MB)`);
  }

  const content = await readFile(fullPath, 'utf-8');
  return { content, size: st.size };
}

/**
 * Dateiinhalt schreiben
 */
export async function writeFileContent(shortId: FileRoot, relPath: string, content: string): Promise<void> {
  const { fullPath } = await safePath(shortId, relPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

/**
 * Neuen Ordner anlegen
 */
export async function createDirectory(shortId: FileRoot, relPath: string): Promise<void> {
  const { fullPath } = await safePath(shortId, relPath);
  await mkdir(fullPath, { recursive: true });
}

/**
 * Datei oder Ordner umbenennen / verschieben
 */
export async function renamePath(shortId: FileRoot, fromRel: string, toRel: string): Promise<void> {
  const src = await safePath(shortId, fromRel);
  const dst = await safePath(shortId, toRel);

  if (!existsSync(src.fullPath)) {
    throw new Error(`Ausgangsdatei "${fromRel}" existiert nicht`);
  }
  if (existsSync(dst.fullPath)) {
    throw new Error(`Zieldatei oder -ordner "${toRel}" existiert bereits`);
  }

  await mkdir(dirname(dst.fullPath), { recursive: true });
  await rename(src.fullPath, dst.fullPath);
}

/**
 * Datei oder Verzeichnis löschen
 */
export async function deletePath(shortId: FileRoot, relPath: string): Promise<void> {
  const { root, fullPath } = await safePath(shortId, relPath);

  if (fullPath === root) {
    throw new FilePathSecurityError('Das Wurzelverzeichnis des Servers kann nicht gelöscht werden');
  }

  if (!existsSync(fullPath)) {
    return;
  }

  await rm(fullPath, { recursive: true, force: true });
}

/**
 * Stream für Dateidownload
 */
export async function getDownloadStream(
  shortId: FileRoot,
  relPath: string
): Promise<{ stream: NodeJS.ReadableStream; filename: string; size: number }> {
  const { fullPath } = await safePath(shortId, relPath);

  const st = await stat(fullPath);
  if (st.isDirectory()) {
    throw new Error('Verzeichnisse können nicht direkt als Einzeldatei heruntergeladen werden');
  }

  return {
    stream: createReadStream(fullPath),
    filename: basename(fullPath),
    size: st.size,
  };
}

/**
 * Dateien/Ordner als Zip-Archiv komprimieren
 */
export async function compressToZip(
  shortId: FileRoot,
  sourceRels: string[],
  archiveRelPath: string
): Promise<{ path: string; size: number }> {
  const { root: _root } = await safePath(shortId, '');
  const { fullPath: archiveFull, relPath: archiveRel } = await safePath(shortId, archiveRelPath);

  if (existsSync(archiveFull)) {
    throw new Error(`Archiv "${archiveRelPath}" existiert bereits`);
  }

  await mkdir(dirname(archiveFull), { recursive: true });

  const zipfile = new yazl.ZipFile();
  const outStream = createWriteStream(archiveFull);

  async function addRecursive(full: string, zipPrefix: string) {
    const st = await stat(full);
    if (st.isDirectory()) {
      zipfile.addEmptyDirectory(zipPrefix);
      const items = await readdir(full);
      for (const item of items) {
        if (item === '.panel') continue;
        await addRecursive(join(full, item), zipPrefix ? `${zipPrefix}/${item}` : item);
      }
    } else {
      zipfile.addFile(full, zipPrefix);
    }
  }

  for (const src of sourceRels) {
    const s = await safePath(shortId, src);
    if (!existsSync(s.fullPath)) continue;
    const name = basename(s.fullPath);
    await addRecursive(s.fullPath, name);
  }

  zipfile.end();

  await new Promise<void>((res, rej) => {
    zipfile.outputStream.pipe(outStream).on('close', res).on('error', rej);
  });

  const st = await stat(archiveFull);
  return { path: archiveRel, size: st.size };
}

/**
 * Archiv entpacken (unterstützt .zip sowie .tar / .tar.gz / .tar.zst)
 */
export async function decompressArchive(
  shortId: FileRoot,
  archiveRelPath: string,
  targetRelDir = ''
): Promise<{ filesCount: number }> {
  const { root } = await safePath(shortId, '');
  const { fullPath: archiveFull } = await safePath(shortId, archiveRelPath);
  const { fullPath: targetFull } = await safePath(shortId, targetRelDir);

  if (!existsSync(archiveFull)) {
    throw new Error(`Archiv "${archiveRelPath}" existiert nicht`);
  }

  await mkdir(targetFull, { recursive: true });

  const lowerName = archiveRelPath.toLowerCase();

  if (lowerName.endsWith('.zip')) {
    return extractZip(archiveFull, targetFull, root);
  }

  if (
    lowerName.endsWith('.tar') ||
    lowerName.endsWith('.tar.gz') ||
    lowerName.endsWith('.tgz') ||
    lowerName.endsWith('.tar.zst')
  ) {
    return extractTar(archiveFull, targetFull);
  }

  throw new Error(`Nicht unterstütztes Archivformat: ${archiveRelPath}`);
}

async function extractZip(archivePath: string, targetDir: string, _rootDir: string): Promise<{ filesCount: number }> {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true, decodeStrings: true }, (err, z) =>
      err || !z ? rej(err ?? new Error('Zip konnte nicht geöffnet werden')) : res(z)
    );
  });

  let filesCount = 0;

  return new Promise((res, rej) => {
    zip.on('error', rej);
    zip.on('close', () => res({ filesCount }));

    zip.on('entry', (entry: yauzl.Entry) => {
      // Zip Slip Schutz: Dateiname darf nicht aus targetDir ausbrechen
      const entryName = entry.fileName.replace(/\\/g, '/');
      const destPath = resolve(targetDir, entryName);

      if (destPath !== targetDir && !destPath.startsWith(targetDir + sep)) {
        // Unsicheren Eintrag überspringen
        zip.readEntry();
        return;
      }

      if (entryName.endsWith('/')) {
        mkdir(destPath, { recursive: true })
          .then(() => zip.readEntry())
          .catch(rej);
      } else {
        mkdir(dirname(destPath), { recursive: true })
          .then(() => {
            zip.openReadStream(entry, (err, readStream) => {
              if (err || !readStream) {
                rej(err ?? new Error('Fehler beim Lesen des Eintrags'));
                return;
              }
              const writeStream = createWriteStream(destPath);
              readStream.pipe(writeStream);
              writeStream.on('finish', () => {
                filesCount++;
                zip.readEntry();
              });
              writeStream.on('error', rej);
            });
          })
          .catch(rej);
      }
    });

    zip.readEntry();
  });
}

async function extractTar(archivePath: string, targetDir: string): Promise<{ filesCount: number }> {
  return new Promise((res, rej) => {
    // bsdtar / tar mit Schutz gegen Pfadausbrüche
    const tarArgs = ['-xf', archivePath, '-C', targetDir];
    const proc = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        res({ filesCount: 1 });
      } else {
        rej(new Error(`Tar-Entpacken fehlgeschlagen (Code ${code}): ${stderr}`));
      }
    });

    proc.on('error', rej);
  });
}
