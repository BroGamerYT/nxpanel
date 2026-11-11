import { PathOutsideRootError, isInside, resolveInsideRoot, serverRootFor } from '../protocol/paths.js';
import type { ServerRegistry } from '../store/registry.js';
import type { ServerInstanceConfig } from '../types.js';

/**
 * Der Ordner eines Servers - nur, wenn er echt UNTER dem Server-Verzeichnis liegt.
 *
 * Instanzen ausserhalb (z. B. die Testinstanz im Projektordner) oder deren
 * Ordner das Server-Verzeichnis selbst ist, haben keinen Dateizugriff: sonst
 * waeren fremde Dateien oder die Ordner anderer Server erreichbar
 * (Konzept Abschnitt 3.3). Gilt fuer Dateien, Logdateien, Backups und Loeschen.
 *
 * @returns den Ordner oder null
 */
export async function resolveInstanceDir(registry: ServerRegistry, instance: ServerInstanceConfig): Promise<string | null> {
  const serverRoot = serverRootFor(registry.dir);
  try {
    const dir = await resolveInsideRoot(serverRoot, instance.workingDir, 'workingDir');
    return dir !== serverRoot && isInside(serverRoot, dir) ? dir : null;
  } catch (err) {
    if (err instanceof PathOutsideRootError) return null;
    throw err;
  }
}
