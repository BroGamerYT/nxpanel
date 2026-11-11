import { fetchJson, type FetchLike } from './download.js';

/**
 * Minecraft Vanilla ueber die Schnittstelle von Mojang (piston-meta).
 *
 * Die Versionsliste nennt je Version die Adresse ihrer Beschreibung; diese
 * enthaelt die Server-Datei mit SHA-1 und die noetige Java-Hauptversion.
 * Mojang veroeffentlicht nur SHA-1 - das genuegt als Pflicht-Pruefsumme,
 * weil Liste und Datei von Mojang ueber HTTPS kommen.
 */

export const VANILLA_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com'] as const;
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

interface Manifest {
  latest: { release: string; snapshot?: string };
  versions: Array<{ id: string; type: string; url: string }>;
}

interface VersionInfo {
  downloads?: { server?: { sha1: string; size: number; url: string } };
  javaVersion?: { majorVersion?: number };
}

export interface VanillaBuild {
  version: string;
  javaMajor: number;
  url: string;
  sha1: string;
  size: number;
}

export interface VanillaOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

/** Was der Nutzer als Version eingeben darf - muss in der Liste stehen, landet also in keiner Adresse. */
const VERSION_INPUT = /^[0-9A-Za-z][0-9A-Za-z.\-_ ]{0,39}$/;

function common(options: VanillaOptions) {
  return {
    allowedHosts: VANILLA_HOSTS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
}

/** Loest "LATEST" oder eine Versionsnummer in Server-Datei, SHA-1 und Java-Version auf. */
export async function resolveVanillaBuild(requested: string, options: VanillaOptions = {}): Promise<VanillaBuild> {
  const wanted = requested.trim();
  const manifest = await fetchJson<Manifest>(MANIFEST, common(options));

  let id: string;
  if (wanted === '' || wanted.toUpperCase() === 'LATEST') {
    id = manifest.latest.release;
  } else {
    if (!VERSION_INPUT.test(wanted)) throw new Error(`Ungueltige Minecraft-Version: ${requested}`);
    id = wanted;
  }

  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`Mojang kennt die Minecraft-Version ${id} nicht.`);

  const info = await fetchJson<VersionInfo>(entry.url, common(options));
  const server = info.downloads?.server;
  if (!server) throw new Error(`Fuer Minecraft ${id} gibt es keinen Server-Download.`);
  if (!/^[0-9a-f]{40}$/i.test(server.sha1)) throw new Error(`Mojang nennt fuer ${id} keine gueltige Pruefsumme.`);

  return {
    version: id,
    // Sehr alte Versionen nennen keine Java-Version: dort lief Java 8
    javaMajor: info.javaVersion?.majorVersion ?? 8,
    url: server.url,
    sha1: server.sha1.toLowerCase(),
    size: server.size,
  };
}
