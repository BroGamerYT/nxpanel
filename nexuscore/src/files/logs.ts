import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PathOutsideRootError, isInside, resolveInsideRoot } from '../protocol/paths.js';
import { FileAccessError } from './files.js';

/**
 * Logdateien eines Servers (Block B4).
 *
 * Die Ordner nennt das Egg (`log_dirs`), sonst gilt "logs" im Server-Ordner.
 * Neueste zuerst - meist will man genau die Datei vom letzten Absturz.
 * Nachgebaut nach `src/http/routes/logs.ts` im Panel (der Core darf `src/`
 * des Panels nicht importieren).
 */

export const DEFAULT_LOG_DIRS = ['logs'];
const LOG_EXT = /\.(log|txt|gz)$/i;
const MAX_GZ_BYTES = 20 * 1024 * 1024;

export interface LogFileInfo {
  path: string;
  name: string;
  bytes: number;
  modified: Date;
}

/** Nur einfache Ordnernamen aus dem Egg - kein Pfad, der aus dem Server-Ordner fuehrt. */
export function cleanLogDirs(dirs: unknown): string[] {
  const list = Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string' && d.length > 0 && d.length < 200) : [];
  return list.length > 0 ? list : DEFAULT_LOG_DIRS;
}

const toRel = (root: string, full: string): string => path.relative(root, full).split(path.sep).join('/');

/** Ein Ordner im Server-Ordner, oder null (ausserhalb, Verweis nach draussen). */
async function safeDir(root: string, dir: string): Promise<string | null> {
  try {
    return await resolveInsideRoot(root, dir.replace(/\\/g, '/').replace(/^\/+/, '') || '.', 'Logordner');
  } catch (err) {
    if (err instanceof PathOutsideRootError) return null;
    throw err;
  }
}

export async function listLogs(root: string, dirs: string[]): Promise<LogFileInfo[]> {
  const out: LogFileInfo[] = [];
  for (const d of dirs) {
    const dir = await safeDir(root, d);
    if (!dir || dir === root) continue;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!LOG_EXT.test(name)) continue;
      const full = path.join(dir, name);
      // Ein Verweis auf eine Datei ausserhalb gehoert nicht in die Liste.
      const real = await resolveInsideRoot(root, toRel(root, full), 'Logdatei').catch(() => null);
      if (!real) continue;
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) continue;
      out.push({ path: toRel(root, full), name, bytes: info.size, modified: info.mtime });
    }
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, 200);
}

/** Die letzten n Zeilen einer Datei, ohne sie ganz zu lesen. */
export async function tailFile(file: string, n: number, maxBytes = 256 * 1024): Promise<string[]> {
  try {
    const info = await stat(file);
    const handle = await open(file, 'r');
    try {
      const length = Math.min(info.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      const lines = buffer
        .toString('utf8')
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .filter((l) => l.length);
      if (length < info.size) lines.shift(); // die erste Zeile ist angeschnitten
      return lines.slice(-n);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

/** Loest eine Logdatei auf - nur Dateien aus den Log-Ordnern, nie etwas anderes im Server-Ordner. */
export async function resolveLogFile(root: string, dirs: string[], relPath: string): Promise<string> {
  const notFound = new FileAccessError('Logdatei nicht gefunden', 'not_found', 404);
  if (relPath.includes('\0')) throw notFound;

  let full: string;
  try {
    full = await resolveInsideRoot(root, relPath.replace(/\\/g, '/').replace(/^\/+/, ''), 'Logdatei');
  } catch (err) {
    if (err instanceof PathOutsideRootError) throw notFound;
    throw err;
  }
  if (!LOG_EXT.test(full)) throw notFound;

  let inLogDir = false;
  for (const d of dirs) {
    const dir = await safeDir(root, d);
    if (dir && dir !== root && isInside(dir, full) && full !== dir) inLogDir = true;
  }
  if (!inLogDir) throw notFound;

  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw notFound;
  return full;
}

export async function readLog(
  full: string,
  maxLines: number,
): Promise<{ bytes: number; modified: Date; lines: string[]; truncated: boolean }> {
  const info = await stat(full);
  let lines: string[];
  if (/\.gz$/i.test(full)) {
    if (info.size > MAX_GZ_BYTES) {
      throw new FileAccessError('Archiv zu groß für die Anzeige - bitte herunterladen', 'too_large', 413);
    }
    lines = gunzipSync(await readFile(full))
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => l.length)
      .slice(-maxLines);
  } else {
    lines = await tailFile(full, maxLines, 4 * 1024 * 1024);
  }
  return { bytes: info.size, modified: info.mtime, lines, truncated: lines.length >= maxLines };
}

export const openLogDownload = (full: string) => ({ stream: createReadStream(full), filename: path.basename(full) });
