import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { FileAccessError, assertSafeName, resolveEntry } from './files.js';

/**
 * Packen und Entpacken fuer den Dateimanager - ohne fremde Programme und ohne
 * neue Abhaengigkeit: .zip (lesen und schreiben) sowie .tar, .tar.gz, .tgz (lesen).
 *
 * Archive kommen von Nutzern. Beim Entpacken gilt deshalb:
 *  - Eintraege mit absolutem Pfad, "..", unzulaessigem Namen oder als Verknuepfung
 *    werden uebersprungen und gezaehlt ("skipped") - nie geschrieben.
 *  - Es wird nie durch eine vorhandene Verknuepfung im Zielordner geschrieben.
 *  - Anzahl der Eintraege und entpackte Gesamtgroesse sind begrenzt (Archivbomben);
 *    bei Zip zaehlt die tatsaechlich entpackte Menge, nicht die Angabe im Archiv.
 */

export interface ArchiveLimits {
  entries: number;
  bytes: number;
}
export const DEFAULT_LIMITS: ArchiveLimits = { entries: 100_000, bytes: 10 * 1024 ** 3 };

export interface ExtractResult {
  filesCount: number;
  skipped: number;
}

const bad = (message: string, status = 400) => new FileAccessError(message, 'invalid_path', status);

/** Ein Eintrag aus einem Archiv, sicher aufgeloest - oder null, wenn er nicht geschrieben werden darf. */
class Sink {
  filesCount = 0;
  skipped = 0;
  private entries = 0;
  private bytes = 0;

  constructor(
    private readonly target: string,
    private readonly limits: ArchiveLimits,
  ) {}

  count(): void {
    if (++this.entries > this.limits.entries) throw bad('Das Archiv enthält zu viele Einträge und wird nicht entpackt');
  }

  addBytes(n: number): void {
    this.bytes += n;
    if (this.bytes > this.limits.bytes) throw bad('Das entpackte Archiv wäre zu groß (Schutz vor Archivbomben)');
  }

  /** Zielpfad eines Eintrags; legt fehlende Ordner an. null = ueberspringen. */
  async resolve(rawName: string, isDir: boolean): Promise<string | null> {
    const name = rawName.replace(/\\/g, '/');
    if (/^([/]|[A-Za-z]:)/.test(name)) return this.skip();
    const segments = name.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.length === 0 || segments.includes('..')) return this.skip();
    try {
      for (const s of segments) assertSafeName(s);
    } catch {
      return this.skip();
    }

    // Jedes Teilstueck des Weges: nie durch eine Verknuepfung, nie durch eine Datei.
    let current = this.target;
    const dirs = isDir ? segments : segments.slice(0, -1);
    for (const segment of dirs) {
      current = path.join(current, segment);
      const info = await fs.lstat(current).catch(() => null);
      if (!info) await fs.mkdir(current);
      else if (!info.isDirectory()) return this.skip();
    }
    if (isDir) return current;

    const file = path.join(current, segments[segments.length - 1]!);
    const info = await fs.lstat(file).catch(() => null);
    if (info && !info.isFile()) return this.skip(); // Verknuepfung oder Ordner an dieser Stelle
    return file;
  }

  skip(): null {
    this.skipped++;
    return null;
  }
}

// ---------------------------------------------------------------- ZIP lesen

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compSize: number;
  size: number;
  offset: number;
  isSymlink: boolean;
}

async function readZipDirectory(handle: fs.FileHandle, fileSize: number): Promise<ZipEntry[]> {
  const tailLen = Math.min(fileSize, 65_557);
  const tail = Buffer.alloc(tailLen);
  await handle.read(tail, 0, tailLen, fileSize - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('Das ist kein gültiges Zip-Archiv');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw bad('Zip64-Archive (über 4 GB) werden nicht unterstützt');
  if (cdOffset + cdSize > fileSize) throw bad('Das Zip-Archiv ist beschädigt');

  const cd = Buffer.alloc(cdSize);
  await handle.read(cd, 0, cdSize, cdOffset);
  const entries: ZipEntry[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50) throw bad('Das Zip-Archiv ist beschädigt');
    const flags = cd.readUInt16LE(pos + 8);
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    const madeBy = cd.readUInt16LE(pos + 4);
    const extAttr = cd.readUInt32LE(pos + 38);
    const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', pos + 46, pos + 46 + nameLen);
    entries.push({
      name,
      method: cd.readUInt16LE(pos + 10),
      flags,
      crc: cd.readUInt32LE(pos + 16),
      compSize: cd.readUInt32LE(pos + 20),
      size: cd.readUInt32LE(pos + 24),
      offset: cd.readUInt32LE(pos + 42),
      isSymlink: madeBy >> 8 === 3 && ((extAttr >>> 16) & 0o170000) === 0o120000,
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function extractZip(archive: string, target: string, limits: ArchiveLimits = DEFAULT_LIMITS): Promise<ExtractResult> {
  const sink = new Sink(target, limits);
  const handle = await fs.open(archive, 'r');
  try {
    const size = (await handle.stat()).size;
    const entries = await readZipDirectory(handle, size);
    for (const e of entries) {
      sink.count();
      const isDir = e.name.endsWith('/');
      if (e.isSymlink || (e.flags & 1) !== 0 || (e.method !== 0 && e.method !== 8)) {
        sink.skip(); // Verknuepfung, verschluesselt oder unbekannte Kompression
        continue;
      }
      const dest = await sink.resolve(e.name, isDir);
      if (!dest || isDir) continue;

      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, e.offset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw bad('Das Zip-Archiv ist beschädigt');
      const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + e.compSize > size) throw bad('Das Zip-Archiv ist beschädigt');

      let crc = 0;
      let written = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          // Mehr als angegeben ist eine Archivbombe oder ein kaputtes Archiv
          if (written > e.size) return cb(bad(`„${e.name}“ ist größer als im Archiv angegeben`));
          try {
            sink.addBytes(chunk.length);
          } catch (err) {
            return cb(err as Error);
          }
          crc = zlib.crc32(chunk, crc);
          cb(null, chunk);
        },
      });
      const source = createReadStream(archive, { start, end: start + Math.max(e.compSize, 1) - 1 });
      const out = createWriteStream(dest, { flags: 'w' });
      try {
        if (e.compSize === 0 && e.size === 0) {
          out.end();
          await new Promise<void>((res, rej) => out.on('finish', res).on('error', rej));
        } else if (e.method === 8) await pipeline(source, zlib.createInflateRaw(), guard, out);
        else await pipeline(source, guard, out);
        if (written !== e.size || (crc >>> 0) !== e.crc) throw bad(`„${e.name}“ ist beschädigt (Prüfsumme stimmt nicht)`);
      } catch (err) {
        await fs.rm(dest, { force: true }).catch(() => {});
        throw err;
      }
      sink.filesCount++;
    }
  } finally {
    await handle.close();
  }
  return { filesCount: sink.filesCount, skipped: sink.skipped };
}

// ---------------------------------------------------------------- TAR lesen

/** Liest einen Byte-Strom stueckweise: genau n Bytes oder ein Strom in eine Datei. */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  private readonly it: AsyncIterator<Buffer>;

  constructor(stream: AsyncIterable<Buffer>) {
    this.it = stream[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.it.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, next.value]) : next.value;
    return true;
  }

  /** @returns die Bytes oder null, wenn der Strom vorher endet */
  async exact(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) if (!(await this.fill())) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Gibt n Bytes in Stuecken an `onChunk` weiter (ohne alles im Speicher zu halten). */
  async stream(n: number, onChunk: (chunk: Buffer) => Promise<void>): Promise<boolean> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.fill())) return false;
      const take = Math.min(left, this.buf.length);
      const piece = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
      await onChunk(piece);
    }
    return true;
  }
}

const octal = (b: Buffer): number => {
  const text = b.toString('latin1').replace(/\0.*$/s, '').trim();
  return text === '' ? 0 : parseInt(text, 8);
};

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space < 0) break;
    const len = parseInt(body.toString('latin1', pos, space), 10);
    if (!Number.isFinite(len) || len <= 0 || pos + len > body.length) break;
    const record = body.toString('utf8', space + 1, pos + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

export async function extractTar(archive: string, target: string, limits: ArchiveLimits = DEFAULT_LIMITS): Promise<ExtractResult> {
  const sink = new Sink(target, limits);
  const head = Buffer.alloc(2);
  const fh = await fs.open(archive, 'r');
  try {
    await fh.read(head, 0, 2, 0);
  } finally {
    await fh.close();
  }
  const raw = createReadStream(archive);
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  const source: AsyncIterable<Buffer> = gz ? raw.pipe(zlib.createGunzip()) : raw;
  raw.on('error', () => {});
  const reader = new ByteReader(source);

  let nextName: string | null = null;
  let nextSize: number | null = null;
  try {
    for (;;) {
      const header = await reader.exact(512);
      if (!header) break;
      if (header.every((b) => b === 0)) break;

      // Pruefsumme: Summe aller Bytes, das Pruefsummenfeld zaehlt als Leerzeichen
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
      if (sum !== octal(header.subarray(148, 156))) throw bad('Das ist kein gültiges Tar-Archiv');

      const type = String.fromCharCode(header[156] || 0x30);
      let size = nextSize ?? octal(header.subarray(124, 136));
      if (header[124]! & 0x80) throw bad('Tar-Einträge über 8 GB werden nicht unterstützt');
      const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
      const base = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
      let name = nextName ?? (prefix && header.toString('latin1', 257, 262) === 'ustar' ? `${prefix}/${base}` : base);
      const padded = Math.ceil(size / 512) * 512;

      if (type === 'x' || type === 'L' || type === 'g' || type === 'K') {
        if (size > 1024 * 1024) throw bad('Das Tar-Archiv ist beschädigt');
        const body = await reader.exact(padded);
        if (!body) throw bad('Das Tar-Archiv ist unvollständig');
        const text = body.subarray(0, size);
        if (type === 'x') {
          const pax = parsePax(text);
          if (pax['path']) nextName = pax['path'];
          if (pax['size']) nextSize = Number(pax['size']);
        } else if (type === 'L') {
          nextName = text.toString('utf8').replace(/\0.*$/s, '');
        }
        continue;
      }
      nextName = null;
      nextSize = null;
      size = Math.max(0, size);
      sink.count();

      const isDir = type === '5' || name.endsWith('/');
      const isFile = type === '0' || type === '7';
      if (!isDir && !isFile) {
        // Verknuepfungen, Geraete, Pipes: nie anlegen
        sink.skip();
        if (!(await reader.stream(padded, async () => {}))) throw bad('Das Tar-Archiv ist unvollständig');
        continue;
      }
      name = name.replace(/^\.\//, '');
      const dest = await sink.resolve(name, isDir);
      if (!dest || isDir) {
        if (!(await reader.stream(padded, async () => {}))) throw bad('Das Tar-Archiv ist unvollständig');
        continue;
      }

      const out = createWriteStream(dest, { flags: 'w' });
      let remaining = size;
      let failed: Error | null = null;
      out.on('error', (e) => (failed = e));
      const ok = await reader.stream(padded, async (chunk) => {
        // Der Fuellbereich bis zur 512er-Grenze gehoert nicht zur Datei
        const useful = chunk.subarray(0, Math.min(chunk.length, remaining));
        remaining -= useful.length;
        if (useful.length) {
          sink.addBytes(useful.length);
          if (!out.write(useful)) await new Promise<void>((res) => out.once('drain', res));
        }
      }).catch(async (err) => {
        out.destroy();
        await fs.rm(dest, { force: true }).catch(() => {});
        throw err;
      });
      await new Promise<void>((res) => out.end(res));
      if (failed || !ok) {
        await fs.rm(dest, { force: true }).catch(() => {});
        throw failed ?? bad('Das Tar-Archiv ist unvollständig');
      }
      sink.filesCount++;
    }
  } finally {
    raw.destroy();
  }
  return { filesCount: sink.filesCount, skipped: sink.skipped };
}

/** Entpackt je nach Endung. @throws FileAccessError bei unbekanntem Format */
export async function extractArchive(archive: string, target: string, limits?: ArchiveLimits): Promise<ExtractResult> {
  const lower = archive.toLowerCase();
  if (lower.endsWith('.zip')) return extractZip(archive, target, limits);
  if (lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return extractTar(archive, target, limits);
  if (lower.endsWith('.tar.zst')) throw bad('.tar.zst kann der Core nicht entpacken - bitte als .zip oder .tar.gz packen');
  throw bad(`Nicht unterstütztes Archivformat: ${path.basename(archive)}`);
}

// ---------------------------------------------------------------- ZIP schreiben

interface PackEntry {
  full: string;
  name: string;
  isDir: boolean;
  mtime: Date;
}

const MAX_ZIP_ENTRIES = 65_534;
const MAX_ZIP_BYTES = 0xfffffffe;

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function collect(full: string, name: string, out: PackEntry[], skip: Set<string>): Promise<void> {
  const info = await fs.lstat(full);
  // Verknuepfungen nie mitpacken, auch nicht den internen Ordner .panel
  if (info.isSymbolicLink() || skip.has(path.resolve(full)) || path.basename(full) === '.panel') return;
  if (info.isDirectory()) {
    out.push({ full, name: `${name}/`, isDir: true, mtime: info.mtime });
    for (const item of await fs.readdir(full)) {
      await collect(path.join(full, item), `${name}/${item}`, out, skip);
    }
  } else if (info.isFile()) {
    out.push({ full, name, isDir: false, mtime: info.mtime });
  }
  if (out.length > MAX_ZIP_ENTRIES) throw bad('Zu viele Dateien für ein Zip-Archiv');
}

/**
 * Packt Dateien und Ordner (relativ zum Server-Ordner) in ein Zip.
 * Das Ziel darf nicht existieren; geschrieben wird erst in eine `.part`-Datei.
 */
export async function createZip(root: string, sources: string[], destination: string): Promise<{ path: string; size: number }> {
  const destRel = /\.zip$/i.test(destination) ? destination : `${destination}.zip`;
  const dest = await resolveEntry(root, destRel);
  if (path.resolve(dest) === path.resolve(root)) throw bad('Ungültiger Zielname');
  if (existsSync(dest)) throw new FileAccessError(`Archiv „${destRel}“ existiert bereits`, 'conflict', 409);
  const part = `${dest}.part`;

  const skip = new Set([path.resolve(dest), path.resolve(part)]);
  const entries: PackEntry[] = [];
  for (const src of sources) {
    const full = await resolveEntry(root, src);
    if (!existsSync(full)) continue;
    const name = path.resolve(full) === path.resolve(root) ? path.basename(root) : path.basename(full);
    await collect(full, name, entries, skip);
  }
  if (entries.length === 0) throw bad('Es gibt nichts zu packen');

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const out = createWriteStream(part, { flags: 'wx' });
  let failed: Error | null = null;
  out.on('error', (e) => (failed = e));
  let position = 0;
  const write = async (b: Buffer): Promise<void> => {
    if (failed) throw failed;
    position += b.length;
    if (position > MAX_ZIP_BYTES) throw bad('Das Zip-Archiv würde über 4 GB groß (Zip64 wird nicht unterstützt)');
    if (!out.write(b)) await new Promise<void>((res) => out.once('drain', res));
  };

  const central: Buffer[] = [];
  try {
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const { time, date } = dosTime(e.mtime);
      const offset = position;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(e.isDir ? 0x800 : 0x808, 6); // UTF-8; bei Dateien folgen Groesse und Summe nach den Daten
      local.writeUInt16LE(e.isDir ? 0 : 8, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(nameBuf.length, 26);
      await write(Buffer.concat([local, nameBuf]));

      let crc = 0;
      let size = 0;
      let comp = 0;
      if (!e.isDir) {
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            crc = zlib.crc32(chunk, crc);
            size += chunk.length;
            cb(null, chunk);
          },
        });
        const deflate = createReadStream(e.full).pipe(counter).pipe(zlib.createDeflateRaw());
        for await (const chunk of deflate as AsyncIterable<Buffer>) {
          comp += chunk.length;
          await write(chunk);
        }
        const desc = Buffer.alloc(16);
        desc.writeUInt32LE(0x08074b50, 0);
        desc.writeUInt32LE(crc >>> 0, 4);
        desc.writeUInt32LE(comp, 8);
        desc.writeUInt32LE(size, 12);
        await write(desc);
      }

      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(0x031e, 4); // Unix, Version 3.0
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(e.isDir ? 0x800 : 0x808, 8);
      cen.writeUInt16LE(e.isDir ? 0 : 8, 10);
      cen.writeUInt16LE(time, 12);
      cen.writeUInt16LE(date, 14);
      cen.writeUInt32LE(crc >>> 0, 16);
      cen.writeUInt32LE(comp, 20);
      cen.writeUInt32LE(size, 24);
      cen.writeUInt16LE(nameBuf.length, 28);
      cen.writeUInt32LE(((e.isDir ? 0o040755 : 0o100644) << 16) >>> 0, 38);
      cen.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([cen, nameBuf]));
    }

    const cdOffset = position;
    const cd = Buffer.concat(central);
    await write(cd);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(cdOffset, 16);
    await write(end);
    await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
    await fs.rename(part, dest);
  } catch (err) {
    out.destroy();
    await fs.rm(part, { force: true }).catch(() => {});
    throw err;
  }
  const rel = path.relative(root, dest).replace(/\\/g, '/');
  return { path: rel, size: (await fs.stat(dest)).size };
}
