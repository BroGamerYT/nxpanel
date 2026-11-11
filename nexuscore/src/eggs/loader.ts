import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SteamArg } from '../types.js';

/**
 * Die mitgelieferten Spielvorlagen (Eggs) aus dem Ordner `eggs/`.
 *
 * Sie liegen als JSON im Repository und werden hier gelesen. Der Core hat
 * keine Egg-Tabelle wie das Panel - was ein Egg an Variablen und Ports
 * vorgibt, kommt direkt aus der Datei.
 */

export interface RawEggVariable {
  name: string;
  description?: string;
  env_variable: string;
  default_value?: string;
  /** Fehlt die Angabe, gilt "ja". */
  user_viewable?: boolean;
  /** Fehlt die Angabe, gilt "ja". */
  user_editable?: boolean;
  rules?: string;
  /** Geheimer Wert (Passwort): die Oberflaeche zeigt ein Passwortfeld. */
  secret?: boolean;
  /** "VARIABLE=Wert": das Feld erscheint nur, wenn die andere Variable diesen Wert hat. */
  requires?: string;
}

export interface RawEggFile {
  name: string;
  author?: string;
  nest?: string;
  docker_images?: Record<string, string>;
  startup?: string;
  console?: string;
  ports?: unknown;
  config_files?: Record<string, { parser?: string; find?: Record<string, unknown> } | undefined>;
  /**
   * Windows-Server ueber SteamCMD: App-ID, Programm, Startargumente, Konfigurationsdateien.
   * Fehlt der Block, kann der Core das Spiel nicht selbst installieren.
   */
  windows?: {
    steam_app_id: number;
    branch?: string;
    executable: string;
    args?: SteamArg[];
    stop?: { timeout_seconds?: number };
    files?: Array<{
      path: string;
      format: 'json' | 'unreal-options';
      unless?: string;
      section?: string;
      key?: string;
      set: Record<string, string | { $number?: string; $boolean?: string }>;
    }>;
  };
  /** Ordner mit Logdateien im Server-Ordner (Standard: logs). */
  log_dirs?: string[];
  /** Steam-Store-ID fuer das Titelbild. */
  cover?: { steam?: number };
  resources?: {
    base_ram_mb?: number;
    ram_per_player_mb?: number;
    min_cpu_percent?: number;
  };
  variables?: RawEggVariable[];
}

export interface LoadedEgg {
  id: string;
  name: string;
  category: string;
  author: string;
  images: Array<{ key: string; label: string; image: string; default: boolean }>;
  consoleMode: string;
  resources: NonNullable<RawEggFile['resources']>;
  servers: number;
  raw: RawEggFile;
}

/** Sucht das 'eggs'-Verzeichnis auf dem System. */
export function resolveEggsDir(): string | null {
  let base = process.cwd();
  try {
    base = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // Gebuendelt (.exe): der Ort der Datei ist nicht bekannt - die Kandidaten unten reichen dann.
  }

  const candidates = [
    path.resolve(process.cwd(), 'eggs'),
    path.resolve(process.cwd(), '..', 'eggs'),
    path.resolve(path.dirname(process.execPath), 'eggs'),
    path.resolve(path.dirname(process.execPath), '..', 'eggs'),
    path.resolve(path.dirname(process.execPath), '..', '..', 'eggs'),
    // nexuscore/src/eggs -> Wurzel des Repositories
    path.resolve(base, '..', '..', '..', 'eggs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function readEggs(): Promise<LoadedEgg[]> {
  const dir = resolveEggsDir();
  if (!dir) return [];

  try {
    const eggs: LoadedEgg[] = [];
    for (const file of await fs.readdir(dir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8')) as RawEggFile;
        const id = file.replace(/\.json$/, '');
        eggs.push({
          id,
          name: raw.name || id,
          category: raw.nest || 'Allgemein',
          author: raw.author || 'NexusPanel',
          images: Object.entries(raw.docker_images ?? {}).map(([label, image], idx) => ({
            key: label,
            label,
            image,
            default: idx === 0,
          })),
          consoleMode: raw.console || 'full',
          resources: raw.resources ?? { base_ram_mb: 1024, min_cpu_percent: 100 },
          servers: 0,
          raw,
        });
      } catch {
        // Einzelne fehlerhafte Egg-Datei ueberspringen
      }
    }
    return eggs;
  } catch {
    return [];
  }
}

let cache: { at: number; eggs: LoadedEgg[] } | null = null;

/** Die Spielvorlagen - 30 Sekunden zwischengespeichert, denn Liste, Titelbilder und Einstellungen fragen sie staendig ab. */
export async function loadEggs(): Promise<LoadedEgg[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.eggs;
  const eggs = await readEggs();
  if (eggs.length > 0) cache = { at: Date.now(), eggs };
  return eggs;
}

/** Nur fuer Tests: den Zwischenspeicher leeren. */
export function resetEggCache(): void {
  cache = null;
}
