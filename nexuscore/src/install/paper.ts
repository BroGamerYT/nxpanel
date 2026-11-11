import { fetchJson, type FetchLike } from './download.js';

/**
 * Paper ueber die PaperMC-Schnittstelle "Fill" (v3).
 *
 * Die alte Schnittstelle api.papermc.io/v2 ist abgeschaltet (HTTP 410).
 * Fill liefert je Build die Datei mit SHA-256 und je Version die noetige
 * Java-Hauptversion.
 */

export const PAPER_HOSTS = ['fill.papermc.io', 'fill-data.papermc.io'] as const;
const API = 'https://fill.papermc.io/v3/projects/paper';

interface FillProject {
  versions: Record<string, string[]>;
}

interface FillVersion {
  version: { id: string; java?: { version?: { minimum?: number } } };
}

interface FillBuild {
  id: number;
  channel: string;
  downloads: Record<string, { name: string; checksums: { sha256: string }; size: number; url: string } | undefined>;
}

export interface PaperBuild {
  /** Minecraft-Version, z. B. 1.21.11 oder 26.3 */
  version: string;
  build: number;
  channel: string;
  /** Mindestens noetige Java-Hauptversion. */
  javaMajor: number;
  fileName: string;
  url: string;
  sha256: string;
  size: number;
}

export interface ResolveOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

/** Nur fertige Versionen: 1.21.11 oder 26.3 - kein -rc, -pre, snapshot. */
const RELEASE = /^\d+(\.\d+)+$/;

/** Was der Nutzer als Version eingeben darf - landet in einer Adresse. */
const VERSION_INPUT = /^[0-9A-Za-z][0-9A-Za-z.\-]{0,31}$/;

function common(options: ResolveOptions) {
  return {
    allowedHosts: PAPER_HOSTS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
}

/** Die neueste fertige Minecraft-Version, fuer die es Paper gibt. */
export async function latestPaperVersion(options: ResolveOptions = {}): Promise<string> {
  const project = await fetchJson<FillProject>(API, common(options));
  // Die Gruppen kommen neueste zuerst, innerhalb der Gruppe ebenso.
  for (const versions of Object.values(project.versions ?? {})) {
    const release = versions.find((v) => RELEASE.test(v));
    if (release) return release;
  }
  throw new Error('PaperMC nennt keine fertige Version.');
}

/**
 * Loest eine Versionsangabe ("LATEST" oder z. B. "1.21.11") in einen
 * konkreten Build mit Download-Adresse und Pruefsumme auf.
 */
export async function resolvePaperBuild(requested: string, options: ResolveOptions = {}): Promise<PaperBuild> {
  const wanted = requested.trim();
  let version: string;
  if (wanted === '' || wanted.toUpperCase() === 'LATEST') {
    version = await latestPaperVersion(options);
  } else {
    if (!VERSION_INPUT.test(wanted)) throw new Error(`Ungueltige Minecraft-Version: ${requested}`);
    version = wanted;
  }

  let info: FillVersion;
  try {
    info = await fetchJson<FillVersion>(`${API}/versions/${encodeURIComponent(version)}`, common(options));
  } catch (err) {
    throw new Error(
      `Fuer Minecraft ${version} gibt es kein Paper (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  let build = await fetchJson<FillBuild>(`${API}/versions/${encodeURIComponent(version)}/builds/latest`, common(options));
  if (build.channel !== 'STABLE') {
    // Lieber der letzte stabile Build als ein Vorab-Build.
    const builds = await fetchJson<FillBuild[]>(`${API}/versions/${encodeURIComponent(version)}/builds`, common(options));
    build = builds.find((b) => b.channel === 'STABLE') ?? build;
  }

  const file = build.downloads['server:default'];
  if (!file) throw new Error(`Paper ${version} Build ${build.id} hat keine Server-Datei.`);

  return {
    version,
    build: build.id,
    channel: build.channel,
    javaMajor: info.version.java?.version?.minimum ?? 21,
    fileName: file.name,
    url: file.url,
    sha256: file.checksums.sha256,
    size: file.size,
  };
}
