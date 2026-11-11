import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** So meldet sich der Core bei den Download-Servern - PaperMC verlangt einen erkennbaren Namen. */
export const USER_AGENT = 'NexusCore (https://github.com/BroGamerYT/nxpanel)';

export interface DownloadOptions {
  /**
   * Erwartete SHA-256-Pruefsumme (hex). Pflicht: ohne sie wird nichts gespeichert -
   * ausser der Aufrufer erlaubt es ausdruecklich mit `sha256: null` UND `allowUnpinned`
   * (nur fuer Quellen, die gar keine Pruefsumme veroeffentlichen, z. B. SteamCMD).
   * Die tatsaechliche Summe steht im Ergebnis und gehoert ins Protokoll.
   */
  sha256: string | null;
  /** Statt SHA-256: SHA-1, wenn die Quelle nur diese veroeffentlicht (Mojang). Zaehlt als Pflicht-Pruefsumme. */
  sha1?: string;
  allowUnpinned?: boolean;
  /** Nur diese Hosts duerfen angesprochen werden (ohne Port, klein geschrieben). */
  allowedHosts: readonly string[];
  /** Obergrenze, damit ein falscher Link nicht die Platte fuellt. */
  maxBytes?: number;
  onProgress?: (doneBytes: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function assertAllowed(url: string, allowedHosts: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Ungueltige Download-Adresse: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`Download nur ueber HTTPS erlaubt: ${url}`);
  if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error(`Download von ${parsed.hostname} ist nicht erlaubt.`);
  }
  return parsed;
}

/** Holt JSON von einer erlaubten HTTPS-Adresse. */
export async function fetchJson<T>(
  url: string,
  options: { allowedHosts: readonly string[]; signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<T> {
  assertAllowed(url, options.allowedHosts);
  const doFetch = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const response = await doFetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} antwortet mit HTTP ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Laedt eine Datei und prueft ihre SHA-256-Summe.
 *
 * Geschrieben wird in eine Temp-Datei neben dem Ziel; erst nach bestandener
 * Pruefung wird sie umbenannt. Eine abgebrochene oder verfaelschte Datei
 * liegt also nie unter dem endgueltigen Namen.
 */
export async function downloadFile(url: string, dest: string, options: DownloadOptions): Promise<{ bytes: number; sha256: string }> {
  assertAllowed(url, options.allowedHosts);
  const pinned = options.sha256 !== null || options.sha1 !== undefined;
  const badSum =
    (options.sha256 !== null && !/^[0-9a-f]{64}$/i.test(options.sha256)) ||
    (options.sha1 !== undefined && !/^[0-9a-f]{40}$/i.test(options.sha1));
  if (pinned ? badSum : options.allowUnpinned !== true) {
    throw new Error('Download ohne gueltige SHA-256-Pruefsumme abgelehnt.');
  }

  const doFetch = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const response = await doFetch(url, {
    headers: { 'user-agent': USER_AGENT },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download fehlgeschlagen: ${new URL(url).hostname} antwortet mit HTTP ${response.status}`);
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const header = Number(response.headers.get('content-length') ?? '');
  const total = Number.isFinite(header) && header > 0 ? header : null;
  if (total !== null && total > maxBytes) throw new Error('Download ist groesser als erlaubt.');

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${crypto.randomBytes(4).toString('hex')}`;
  const hash = crypto.createHash('sha256');
  const hash1 = crypto.createHash('sha1');
  const out = fs.createWriteStream(tmp);
  let done = 0;

  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      done += value.byteLength;
      if (done > maxBytes) throw new Error('Download ist groesser als erlaubt.');
      hash.update(value);
      hash1.update(value);
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', resolve));
      options.onProgress?.(done, total);
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });

    const actual = hash.digest('hex');
    if (options.sha1 !== undefined) {
      const actual1 = hash1.digest('hex');
      if (actual1.toLowerCase() !== options.sha1.toLowerCase()) {
        throw new Error(`Pruefsumme stimmt nicht (${path.basename(dest)}): erwartet ${options.sha1}, erhalten ${actual1}`);
      }
    }
    if (options.sha256 !== null && actual.toLowerCase() !== options.sha256.toLowerCase()) {
      throw new Error(`Pruefsumme stimmt nicht (${path.basename(dest)}): erwartet ${options.sha256}, erhalten ${actual}`);
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(tmp, dest);
    return { bytes: done, sha256: actual };
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** SHA-1 einer vorhandenen Datei, oder null wenn es sie nicht gibt. */
export async function sha1OfFile(file: string): Promise<string | null> {
  try {
    const hash = crypto.createHash('sha1');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** SHA-256 einer vorhandenen Datei, oder null wenn es sie nicht gibt. */
export async function sha256OfFile(file: string): Promise<string | null> {
  try {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
