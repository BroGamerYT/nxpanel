import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Titelbilder der Spiele (Kacheln im Erstellen-Dialog und in der Serverliste).
 *
 * Woher das Bild kommt, entscheidet die Wahl des Admins (eggs.cover):
 *   null / 'auto'     Steam-Bild, wenn das Spiel eines hat, sonst ein Panel-Motiv
 *   'steam'           immer das Steam-Bild
 *   'random'          ein Panel-Motiv (Banner oder Symbol), fest je Egg gewuerfelt
 *   'branding:<pfad>' genau dieses Panel-Motiv
 *   'custom'          hochgeladenes eigenes Bild
 *
 * Steam-Bilder holt der Server einmal und legt sie ab. Der Browser fragt nie
 * selbst bei Steam an - keine Drittanfragen und keine Probleme mit der CSP.
 */

/** Panel-Motive aus web/public/branding. */
export const BRANDING = [
  'banner.png', 'icon-256.png',
  ...['amber-classic', 'arctic-cyan', 'crimson-forge', 'cyber-emerald', 'plasma-violet', 'stealth-mono']
    .flatMap((t) => [`themes/${t}/banner.png`, `themes/${t}/icon-256.png`]),
] as const;

/** Steam-Store-IDs der mitgelieferten Spiele - fuer Eggs ohne eigenes "cover". */
const KNOWN_STEAM: Record<string, number> = {
  '7 Days to Die': 251570,
  'ARK: Survival Ascended': 2399830,
  'Core Keeper': 1621690,
  'Counter-Strike 2': 730,
  'Enshrouded': 1203620,
  'Factorio': 427520,
  'Farming Simulator 25': 2300320,
  'Palworld': 1623730,
  'Rust': 252490,
  'Satisfactory': 526870,
  'Sons of the Forest': 1326470,
  'V Rising': 1604030,
  'Valheim': 892970,
};

export interface CoverInfo {
  /** URL fuers <img>. */
  src: string;
  /** 'banner' fuellt die Kachel, 'icon' steht mittig auf dunklem Grund. */
  fit: 'banner' | 'icon';
  source: 'steam' | 'custom' | 'branding';
}

export function steamAppId(name: string, raw: unknown): number | null {
  const c = (raw as { cover?: { steam?: unknown } } | null)?.cover?.steam;
  if (typeof c === 'number' && Number.isInteger(c) && c > 0) return c;
  return KNOWN_STEAM[name] ?? null;
}

/** Feste "Zufallswahl": derselbe Server bekommt immer dasselbe Motiv. */
export function brandingFor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BRANDING[h % BRANDING.length]!;
}

function brandingCover(path: string): CoverInfo {
  return { src: `/branding/${path}`, fit: path.includes('banner') ? 'banner' : 'icon', source: 'branding' };
}

export function isValidChoice(choice: string): boolean {
  if (['auto', 'steam', 'random', 'custom'].includes(choice)) return true;
  return choice.startsWith('branding:') && (BRANDING as readonly string[]).includes(choice.slice(9));
}

/** Was die Oberflaeche fuer ein Egg anzeigt. `v` macht die URL nach einem Wechsel neu. */
export function coverFor(egg: { id: string; name: string; raw: unknown; choice: string | null; version?: string | null }): CoverInfo {
  const choice = egg.choice ?? 'auto';
  const v = encodeURIComponent(egg.version ?? '1');
  if (choice === 'custom') return { src: `/api/v1/eggs/${egg.id}/cover?v=${v}`, fit: 'banner', source: 'custom' };
  if (choice.startsWith('branding:') && isValidChoice(choice)) return brandingCover(choice.slice(9));
  if (choice !== 'random' && steamAppId(egg.name, egg.raw)) return { src: `/api/v1/eggs/${egg.id}/cover?v=${v}`, fit: 'banner', source: 'steam' };
  return brandingCover(brandingFor(egg.id));
}

// ------------------------------------------------------------ Dateien

export function coverDir() {
  return join(resolve(config.VOLUME_ROOT), '.egg-covers');
}

export async function readCustomCover(eggId: string): Promise<{ data: Buffer; type: string } | null> {
  for (const [ext, type] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
    const data = await readFile(join(coverDir(), `${eggId}.${ext}`)).catch(() => null);
    if (data) return { data, type };
  }
  return null;
}

const MAX_BYTES = 2 * 1024 * 1024;

/** Nimmt eine data:-URL (png/jpeg/webp) und legt sie als Datei ab. */
export async function saveCustomCover(eggId: string, dataUrl: string): Promise<void> {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error('Nur PNG, JPEG oder WebP');
  const buf = Buffer.from(m[2]!, 'base64');
  if (buf.length > MAX_BYTES) throw new Error('Bild zu gross (max. 2 MB)');
  if (!looksLikeImage(buf)) throw new Error('Datei ist kein Bild');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1]!;
  await mkdir(coverDir(), { recursive: true });
  await removeCustomCover(eggId);
  const tmp = join(coverDir(), `${eggId}.${ext}.tmp`);
  await writeFile(tmp, buf, { mode: 0o644 });
  await rename(tmp, join(coverDir(), `${eggId}.${ext}`));
}

export async function removeCustomCover(eggId: string): Promise<void> {
  for (const ext of ['png', 'jpg', 'webp']) await unlink(join(coverDir(), `${eggId}.${ext}`)).catch(() => {});
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

const STEAM_URLS = (id: number) => [
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`,
  `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
];
const inflight = new Map<number, Promise<Buffer | null>>();
/** Fehlschlaege kurz merken, damit nicht jede Kachel erneut bei Steam anklopft. */
const failedAt = new Map<number, number>();

export async function steamCover(appId: number, fetcher: typeof fetch = fetch): Promise<Buffer | null> {
  const file = join(coverDir(), `steam-${appId}.jpg`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return cached;
  if (Date.now() - (failedAt.get(appId) ?? 0) < 10 * 60_000) return null;

  let p = inflight.get(appId);
  if (!p) {
    p = (async () => {
      for (const url of STEAM_URLS(appId)) {
        try {
          const res = await fetcher(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > MAX_BYTES || !looksLikeImage(buf)) continue;
          await mkdir(coverDir(), { recursive: true });
          await writeFile(file, buf, { mode: 0o644 });
          return buf;
        } catch (err) {
          log.debug({ err, url }, 'Steam-Bild nicht ladbar');
        }
      }
      failedAt.set(appId, Date.now());
      log.warn({ appId }, 'Steam-Titelbild nicht erreichbar - Panel-Motiv wird gezeigt');
      return null;
    })().finally(() => inflight.delete(appId));
    inflight.set(appId, p);
  }
  return p;
}
