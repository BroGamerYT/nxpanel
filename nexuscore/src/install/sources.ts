import { fetchJson, type FetchLike } from './download.js';

/**
 * Download-Quellen fuer Spiele, die es nicht ueber Steam gibt.
 *
 * Die Vorlage nennt nur den NAMEN der Quelle; Adresse, erlaubte Hosts und Pruefsumme bestimmt der Core selbst.
 * Eine Vorlage (auch eine importierte) kann ihn so nie anweisen, irgendetwas von irgendwoher zu laden.
 *
 * Mit Pruefsumme, wo der Hersteller eine veroeffentlicht (TeamSpeak). Terraria und Bedrock veroeffentlichen keine:
 * dort gilt "erste Benutzung vertrauen" ueber HTTPS vom Hersteller - die tatsaechliche Summe steht im Protokoll und
 * laesst sich mit NEXUSCORE_<QUELLE>_SHA256 fest vorgeben.
 */

export type DownloadSource = 'teamspeak3' | 'terraria' | 'bedrock';
export const DOWNLOAD_SOURCES: readonly DownloadSource[] = ['teamspeak3', 'terraria', 'bedrock'];

export interface ResolvedDownload {
  url: string;
  version: string;
  /** null: der Hersteller veroeffentlicht keine Summe. */
  sha256: string | null;
  allowedHosts: string[];
  label: string;
}

export function isDownloadSource(v: unknown): v is DownloadSource {
  return typeof v === 'string' && (DOWNLOAD_SOURCES as readonly string[]).includes(v);
}

/** Feste Pruefsumme aus der Umgebung (NEXUSCORE_TERRARIA_SHA256 ...), falls gesetzt und gueltig. */
export function pinnedFromEnv(source: DownloadSource, env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[`NEXUSCORE_${source.toUpperCase()}_SHA256`]?.trim().toLowerCase();
  return v && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

const VERSION = /^[0-9][0-9A-Za-z.\-_]{0,40}$/;

export async function resolveSource(
  source: DownloadSource,
  hooks: { fetchImpl?: FetchLike; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedDownload> {
  const fetchOptions = {
    ...(hooks.fetchImpl ? { fetchImpl: hooks.fetchImpl } : {}),
    ...(hooks.signal ? { signal: hooks.signal } : {}),
  };
  const pin = pinnedFromEnv(source, hooks.env);

  switch (source) {
    case 'teamspeak3': {
      const data = await fetchJson<{ windows?: { x86_64?: { version?: string; checksum?: string; mirrors?: Record<string, string> } } }>(
        'https://www.teamspeak.com/versions/server.json',
        { allowedHosts: ['www.teamspeak.com'], ...fetchOptions },
      );
      const win = data.windows?.x86_64;
      const url = win?.mirrors?.['teamspeak.com'];
      if (!win?.version || !VERSION.test(win.version) || !url || !win.checksum || !/^[0-9a-f]{64}$/i.test(win.checksum)) {
        throw new Error('TeamSpeak liefert keine brauchbare Versionsangabe für den Windows-Server.');
      }
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:') throw new Error('TeamSpeak-Download nur über HTTPS erlaubt.');
      if (host !== 'files.teamspeak-services.com') throw new Error(`TeamSpeak-Download von unerwartetem Host ${host} abgelehnt.`);
      // Eine feste Summe aus der Umgebung gilt vor der des Herstellers - und muss dann stimmen
      return { url, version: win.version, sha256: pin ?? win.checksum.toLowerCase(), allowedHosts: [host], label: `TeamSpeak 3 Server ${win.version}` };
    }

    case 'terraria': {
      const names = await fetchJson<unknown>('https://terraria.org/api/get/dedicated-servers-names', {
        allowedHosts: ['terraria.org'],
        ...fetchOptions,
      });
      const best = (Array.isArray(names) ? names : [])
        .map((n) => (typeof n === 'string' ? /^terraria-server-(\d{3,6})\.zip$/.exec(n) : null))
        .filter((m): m is RegExpExecArray => m !== null)
        .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
      if (!best) throw new Error('terraria.org nennt keinen Dedicated Server zum Herunterladen.');
      return {
        url: `https://terraria.org/api/download/pc-dedicated-server/${best[0]}`,
        version: best[1]!,
        sha256: pin,
        allowedHosts: ['terraria.org'],
        label: `Terraria Server ${best[1]}`,
      };
    }

    case 'bedrock': {
      const data = await fetchJson<{ result?: { links?: Array<{ downloadType?: string; downloadUrl?: string }> } }>(
        'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links',
        { allowedHosts: ['net-secondary.web.minecraft-services.net'], ...fetchOptions },
      );
      const link = data.result?.links?.find((l) => l.downloadType === 'serverBedrockWindows')?.downloadUrl;
      const m = link ? /^https:\/\/www\.minecraft\.net\/bedrockdedicatedserver\/bin-win\/bedrock-server-([0-9.]+)\.zip$/.exec(link) : null;
      if (!link || !m) throw new Error('Mojang nennt keinen Bedrock-Server für Windows.');
      return { url: link, version: m[1]!, sha256: pin, allowedHosts: ['www.minecraft.net'], label: `Minecraft Bedrock Server ${m[1]}` };
    }
  }
}

