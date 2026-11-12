import fs from 'node:fs/promises';
import path from 'node:path';
import type { HostDriver } from '../drivers/interface.js';
import { defaultRunner, ensureSteamCmd } from '../install/steamcmd.js';
import { runtimesDirFor } from '../install/manager.js';
import type { SteamLoginRunner } from './accounts.js';

/**
 * Die Steam-Anmeldung eines Kontos mit SteamCMD pruefen - dort, wo der Core ohnehin Spiele laedt:
 *  - Docker-Treiber: SteamCMD im Container (Image steamcmd/steamcmd, wird beim ersten Mal geladen); Passwort nur in der
 *    Umgebung des Containers, nicht in der Befehlszeile. Der Ordner pro Konto bleibt erhalten, damit Steam Guard sich
 *    die bestaetigte Anmeldung merkt.
 *  - Windows-Direktbetrieb: das SteamCMD des Cores. SteamCMD kennt nur die Befehlszeile; das Passwort steht dort fuer die
 *    Dauer des Tests (ein paar Sekunden) fuer andere Benutzer dieses Rechners sichtbar.
 * Sonst gibt es keinen Weg - dann meldet der Aufrufer es.
 */

export const STEAMCMD_IMAGE = 'steamcmd/steamcmd:latest';
const TIMEOUT_MS = 90_000;

export function createLoginRunner(driver: HostDriver, dataDir: string): SteamLoginRunner | null {
  const keep = (accountId: string): string => path.join(dataDir, 'steam-login', accountId.replace(/[^a-zA-Z0-9-]/g, ''));

  if (typeof driver.runInstaller === 'function') {
    const runInstaller = driver.runInstaller.bind(driver);
    return async ({ accountId, accountName, password, code }) => {
      const hostDir = keep(accountId);
      const lines: string[] = [];
      const run = runInstaller(
        {
          serverId: `steam-${accountId.slice(0, 8)}`,
          image: STEAMCMD_IMAGE,
          shell: 'bash',
          // HOME im gemounteten Ordner: dort legt SteamCMD die Anmeldung ab
          script: 'export HOME=/mnt/server/home; mkdir -p "$HOME"; steamcmd +@NoPromptForPassword 1 +login "$STEAM_USER" "$STEAM_PASS" ${STEAM_CODE:+"$STEAM_CODE"} +quit',
          env: { STEAM_USER: accountName, STEAM_PASS: password, ...(code ? { STEAM_CODE: code } : {}) },
          hostDir,
        },
        (line) => lines.push(line),
      );
      await Promise.race([run, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Zeitüberschreitung beim Test')), TIMEOUT_MS).unref())]);
      return lines.join('\n');
    };
  }

  if (driver.name === 'windows-native') {
    return async ({ accountName, password, code }) => {
      const exe = await ensureSteamCmd({ runtimesDir: runtimesDirFor(dataDir) });
      await fs.mkdir(path.dirname(exe), { recursive: true });
      const lines: string[] = [];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
      timer.unref();
      try {
        await defaultRunner(exe, ['+login', accountName, password, ...(code ? [code] : []), '+quit'], { onLine: (l) => lines.push(l), signal: abort.signal });
      } finally {
        clearTimeout(timer);
      }
      return lines.join('\n');
    };
  }
  return null;
}
