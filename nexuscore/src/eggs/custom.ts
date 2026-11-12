import fs from 'node:fs/promises';
import path from 'node:path';
import { customEggsDir, loadEggs, resetEggCache } from './loader.js';
import type { PreparedEgg } from './import.js';

/**
 * Importierte Eggs liegen als JSON-Dateien im Ordner `eggs` des Datenordners - neben den mitgelieferten, nie darin.
 * Die ID ist der Dateiname (aus dem Namen gebildet). Mitgelieferte Eggs lassen sich nicht ueberschreiben oder loeschen.
 */

export class CustomEggError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CustomEggError';
  }
}

export const SAFE_EGG_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function eggIdFor(name: string): string {
  const id = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return id || 'egg';
}

/** Legt ein geprueftes Egg ab. Gleicher Name oder gleiche ID wie ein vorhandenes (auch mitgeliefertes): abgelehnt. */
export async function saveCustomEgg(prepared: PreparedEgg): Promise<string> {
  const id = eggIdFor(prepared.name);
  const existing = await loadEggs();
  if (existing.some((e) => e.id === id || e.name.toLowerCase() === prepared.name.toLowerCase())) {
    throw new CustomEggError(`Ein Spiel mit dem Namen "${prepared.name}" ist bereits installiert`, 409, 'conflict');
  }
  const dir = customEggsDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  // wx: nie eine vorhandene Datei ueberschreiben
  try {
    await fs.writeFile(file, JSON.stringify(prepared.egg, null, 2), { flag: 'wx', encoding: 'utf8' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new CustomEggError(`Ein Spiel mit dem Namen "${prepared.name}" ist bereits installiert`, 409, 'conflict');
    throw err;
  }
  resetEggCache();
  return id;
}

/** Loescht ein importiertes Egg. `inUse` = Anzahl der Server, die es benutzen. */
export async function deleteCustomEgg(id: string, inUse: number): Promise<string> {
  if (!SAFE_EGG_ID.test(id)) throw new CustomEggError('Egg nicht gefunden', 404, 'not_found');
  const egg = (await loadEggs()).find((e) => e.id === id);
  if (!egg) throw new CustomEggError('Egg nicht gefunden', 404, 'not_found');
  if (!egg.custom) throw new CustomEggError('Dieses Spiel wird mit dem Core ausgeliefert und lässt sich nicht löschen - nur importierte Spiele.', 409, 'built_in');
  if (inUse > 0) throw new CustomEggError(`Wird noch von ${inUse} Server(n) genutzt`, 409, 'in_use');
  await fs.unlink(path.join(customEggsDir(), `${id}.json`));
  resetEggCache();
  return egg.name;
}
