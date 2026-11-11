import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';

/**
 * Titelbilder der Spiele (Kacheln beim Anlegen und in der Serverliste).
 *
 * Bewusst klein nachgebaut nach `src/eggs/cover.ts` im Panel: der Core darf
 * `src/` des Panels nicht importieren (eigenes Paket, eigene .exe). Aendert
 * sich dort etwas, muss es hier mit - bis es ein gemeinsames Paket gibt.
 *
 * Woher das Bild kommt, entscheidet die Wahl in den Einstellungen (`cover.<egg>`):
 *   auto (Standard)   Steam-Bild, wenn das Spiel eines hat, sonst ein Panel-Motiv
 *   steam             immer das Steam-Bild
 *   random            ein Panel-Motiv, fest je Spiel gewuerfelt
 *   branding:<pfad>   genau dieses Panel-Motiv
 *   custom            hochgeladenes eigenes Bild
 *
 * Steam-Bilder holt der Core einmal und legt sie ab. Der Browser fragt nie
 * selbst bei Steam an - keine Drittanfragen, keine Probleme mit der CSP.
 */

/** Panel-Motive aus web/public/branding. */
export const BRANDING = [
  'banner.png',
  'icon-256.png',
  ...['amber-classic', 'arctic-cyan', 'crimson-forge', 'cyber-emerald', 'plasma-violet', 'stealth-mono'].flatMap(
    (theme) => [`themes/${theme}/banner.png`, `themes/${theme}/icon-256.png`],
  ),
] as const;

/** Steam-Store-IDs der mitgelieferten Spiele - fuer Eggs ohne eigenes "cover". */
const KNOWN_STEAM: Record<string, number> = {
  '7 Days to Die': 251570,
  'ARK: Survival Ascended': 2399830,
  'Core Keeper': 1621690,
  'Counter-Strike 2': 730,
  Enshrouded: 1203620,
  Factorio: 427520,
  'Farming Simulator 25': 2300320,
  Palworld: 1623730,
  Rust: 252490,
  Satisfactory: 526870,
  'Sons of the Forest': 1326470,
  'V Rising': 1604030,
  Valheim: 892970,
};

export interface CoverInfo {
  /** URL fuers <img>. */
  src: string;
  /** 'banner' fuellt die Kachel, 'icon' steht mittig auf dunklem Grund. */
  fit: 'banner' | 'icon';
  source: 'steam' | 'custom' | 'branding';
}

/** Gespeicherte Wahl eines Admins. `v` macht die Bild-Adresse nach einem Wechsel neu. */
export interface CoverChoice {
  choice: string;
  v: string;
}

/** Nur Namen und Rueckgabe von fetch, die der Core braucht - so laesst sich in Tests ein Ersatz einsetzen. */
export type Fetcher = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: 'follow' | 'error' | 'manual' },
) => Promise<Response>;

export function steamAppId(name: string, raw: unknown): number | null {
  const own = (raw as { cover?: { steam?: unknown } } | null)?.cover?.steam;
  if (typeof own === 'number' && Number.isInteger(own) && own > 0) return own;
  return KNOWN_STEAM[name] ?? null;
}

/** Feste "Zufallswahl": derselbe Server bekommt immer dasselbe Motiv. */
export function brandingFor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return BRANDING[hash % BRANDING.length]!;
}

function brandingCover(file: string): CoverInfo {
  return { src: `/branding/${file}`, fit: file.includes('banner') ? 'banner' : 'icon', source: 'branding' };
}

export function isValidChoice(choice: string): boolean {
  if (['auto', 'steam', 'random', 'custom'].includes(choice)) return true;
  return choice.startsWith('branding:') && (BRANDING as readonly string[]).includes(choice.slice(9));
}

/** Was die Oberflaeche fuer ein Spiel anzeigt. */
export function coverFor(egg: { id: string; name: string; raw: unknown }, stored?: CoverChoice): CoverInfo {
  const choice = stored?.choice ?? 'auto';
  const v = encodeURIComponent(stored?.v ?? '1');
  const url = `/api/v1/eggs/${encodeURIComponent(egg.id)}/cover?v=${v}`;
  if (choice === 'custom') return { src: url, fit: 'banner', source: 'custom' };
  if (choice.startsWith('branding:') && isValidChoice(choice)) return brandingCover(choice.slice(9));
  if (choice !== 'random' && steamAppId(egg.name, egg.raw) !== null) return { src: url, fit: 'banner', source: 'steam' };
  return brandingCover(brandingFor(egg.id));
}

// ------------------------------------------------------------ Dateien

/** Ablage der Bilder: neben der Datenbank, nicht bei den Servern. */
export function coverDirFor(dataDir: string): string {
  return path.join(dataDir, 'covers');
}

/** Spiel-IDs landen in Dateinamen - nur einfache Zeichen. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const MAX_BYTES = 2 * 1024 * 1024;

export async function readCustomCover(dir: string, eggId: string): Promise<{ data: Buffer; type: string } | null> {
  if (!SAFE_ID.test(eggId)) return null;
  for (const [ext, type] of [
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ] as const) {
    const data = await readFile(path.join(dir, `${eggId}.${ext}`)).catch(() => null);
    if (data) return { data, type };
  }
  return null;
}

/** Nimmt eine data:-URL (png/jpeg/webp) und legt sie als Datei ab. */
export async function saveCustomCover(dir: string, eggId: string, dataUrl: string): Promise<void> {
  if (!SAFE_ID.test(eggId)) throw new Error('Ungueltige Spiel-ID');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Nur PNG, JPEG oder WebP');
  const buffer = Buffer.from(match[2]!, 'base64');
  if (buffer.length > MAX_BYTES) throw new Error('Bild zu gross (max. 2 MB)');
  if (!looksLikeImage(buffer)) throw new Error('Datei ist kein Bild');

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]!;
  await mkdir(dir, { recursive: true });
  await removeCustomCover(dir, eggId);
  const tmp = path.join(dir, `${eggId}.${ext}.tmp`);
  await writeFile(tmp, buffer, { mode: 0o644 });
  await rename(tmp, path.join(dir, `${eggId}.${ext}`));
}

export async function removeCustomCover(dir: string, eggId: string): Promise<void> {
  if (!SAFE_ID.test(eggId)) return;
  for (const ext of ['png', 'jpg', 'webp']) await unlink(path.join(dir, `${eggId}.${ext}`)).catch(() => {});
}

/** Magische Bytes pruefen - der Dateityp im Header allein beweist nichts. */
export function looksLikeImage(b: Buffer): boolean {
  if (b.length < 12) return false;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const webp = b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  return png || jpg || webp;
}

// ------------------------------------------------------------ Steam

const STEAM_HOSTS = ['cdn.cloudflare.steamstatic.com', 'shared.akamai.steamstatic.com'] as const;

const steamUrls = (id: number): string[] => [
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`,
  `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
];

const inflight = new Map<string, Promise<Buffer | null>>();
/** Fehlschlaege kurz merken, damit nicht jede Kachel erneut bei Steam anklopft. */
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 10 * 60_000;

/**
 * Holt das Steam-Titelbild (460x215) einmal und legt es ab.
 *
 * Die Adresse entsteht nur aus einer Zahl und festen Hosts. Landet eine
 * Weiterleitung bei einem anderen Host, wird die Antwort verworfen.
 */
export async function steamCover(appId: number, dir: string, fetcher: Fetcher = fetch as Fetcher): Promise<Buffer | null> {
  if (!Number.isInteger(appId) || appId <= 0) return null;
  const file = path.join(dir, `steam-${appId}.jpg`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return cached;

  const key = `${dir}|${appId}`;
  if (Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_MS) return null;

  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      for (const url of steamUrls(appId)) {
        try {
          const response = await fetcher(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
          if (!response.ok) continue;
          if (response.url && !(STEAM_HOSTS as readonly string[]).includes(new URL(response.url).hostname)) continue;
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > MAX_BYTES || !looksLikeImage(buffer)) continue;
          await mkdir(dir, { recursive: true });
          await writeFile(file, buffer, { mode: 0o644 });
          return buffer;
        } catch (err) {
          logger.debug({ err, url }, 'Steam-Bild nicht ladbar');
        }
      }
      failedAt.set(key, Date.now());
      logger.warn({ appId }, 'Steam-Titelbild nicht erreichbar - Panel-Motiv wird gezeigt');
      return null;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}
