import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';

/** Fehler bei einem Pfad ausserhalb des Server-Verzeichnisses - ergibt in den Routen 400. */
export class PathOutsideRootError extends Error {
  readonly statusCode = 400;

  constructor(label: string) {
    super(`${label} liegt ausserhalb des Server-Verzeichnisses und wird abgelehnt.`);
    this.name = 'PathOutsideRootError';
  }
}

/**
 * Das Verzeichnis, in dem alle Instanzen liegen muessen (Block A3).
 *
 * NEXUSCORE_SERVER_ROOT, sonst `<Datenverzeichnis>/servers`. Das
 * Datenverzeichnis kommt von der Registry, damit Tests mit eigenem
 * Verzeichnis nicht in die echten Daten schreiben.
 */
export function serverRootFor(dataDir: string): string {
  return config.serverRoot ? path.resolve(config.serverRoot) : path.resolve(dataDir, 'servers');
}

/** true, wenn `target` gleich `root` ist oder darunter liegt. Vergleich ueber path.relative, nicht ueber Zeichenketten. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  // Unter Windows liefert path.relative fuer ein anderes Laufwerk einen absoluten Pfad.
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Loest Symlinks im vorhandenen Teil eines Pfades auf.
 *
 * Der Pfad muss noch nicht vollstaendig existieren (ein Server wird erst
 * angelegt): es wird der tiefste vorhandene Vorfahre aufgeloest und der Rest
 * wieder angehaengt. So faellt auch ein Link auf, der mitten im Pfad nach
 * draussen zeigt.
 */
async function realpathOfExisting(target: string): Promise<string> {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return rest.length > 0 ? path.join(real, ...rest.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Loest einen Pfad gegen `base` auf und stellt sicher, dass er im
 * Server-Verzeichnis liegt - vor und nach dem Aufloesen von Symlinks.
 *
 * @returns den absoluten Pfad (ohne Symlink-Aufloesung, damit der Nutzer
 *          denselben Pfad wiederfindet, den er eingetragen hat)
 */
export async function resolveInsideRoot(
  root: string,
  input: string,
  label: string,
  base: string = root,
): Promise<string> {
  if (input.includes('\0')) throw new PathOutsideRootError(label);

  // Unter Linux und macOS ist der Rueckstrich ein gewoehnliches Zeichen im
  // Dateinamen: "..\..\x.exe" waere dort EIN Name im Server-Verzeichnis und
  // "C:\Windows\cmd.exe" ebenso. Das Panel und die Eggs schicken aber auch
  // Windows-Schreibweisen - sie sollen auf jedem System dasselbe bedeuten.
  if (path.sep === '/') {
    if (/^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\')) throw new PathOutsideRootError(label);
    input = input.replace(/\\/g, '/');
  }

  const resolved = path.resolve(base, input);
  if (!isInside(root, resolved)) throw new PathOutsideRootError(label);

  // Das Server-Verzeichnis selbst darf ein Link sein (z. B. auf ein anderes
  // Laufwerk) - verglichen wird deshalb gegen seinen echten Ort.
  const realRoot = await realpathOfExisting(root);
  const realTarget = await realpathOfExisting(resolved);
  if (!isInside(realRoot, realTarget)) throw new PathOutsideRootError(label);

  return resolved;
}

/**
 * Prueft `workingDir` und `executable` einer Instanz (Block A3).
 *
 * `workingDir` wird gegen das Server-Verzeichnis aufgeloest, `executable`
 * gegen `workingDir`. Beide muessen im Server-Verzeichnis bleiben.
 */
export async function resolveInstancePaths(
  root: string,
  input: { executable: string; workingDir: string },
): Promise<{ executable: string; workingDir: string }> {
  const workingDir = await resolveInsideRoot(root, input.workingDir, 'workingDir');
  const executable = await resolveInsideRoot(root, input.executable, 'executable', workingDir);
  return { executable, workingDir };
}
