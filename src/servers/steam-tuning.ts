/**
 * Schnellere SteamCMD-Downloads.
 *
 * SteamCMD laedt unter Linux per HTTP/2 von nur wenigen Content-Servern.
 * Das bremst auf schnellen Leitungen oft auf wenige MB/s (bekannter Fehler,
 * github.com/ValveSoftware/steam-for-linux/issues/10248). Abhilfe sind drei
 * Steam-Einstellungen ("Convars"): HTTP/2 aus, frueher weitere Verbindungen
 * aufmachen, mehr Server zu Beginn anfragen.
 *
 * Das Panel setzt sie auf zwei Wegen, ohne die Eggs anzufassen:
 * 1. Jeder SteamCMD-Aufruf im Installationsskript bekommt sie als
 *    Startparameter (`+@name wert` versteht SteamCMD vor `+login`).
 * 2. Nach der Installation liegt eine `steam_dev.cfg` neben steamcmd.sh -
 *    fuer die Aktualisierung beim Serverstart, die das Image selbst macht.
 */

export const STEAM_CONVARS: ReadonlyArray<readonly [string, string]> = [
  ['@nClientDownloadEnableHTTP2PlatformLinux', '0'],
  ['@fDownloadRateImprovementToAddAnotherConnection', '1.0'],
  ['@cMaxInitialDownloadSources', '15'],
];

const ARGS = STEAM_CONVARS.map(([k, v]) => `+${k} ${v}`).join(' ');

/**
 * Haengt die Convars an jeden SteamCMD-Aufruf im Skript. Erkannt wird
 * `steamcmd` bzw. `steamcmd.sh`, auf das (ggf. nach Zeilenfortsetzung mit
 * Backslash) ein `+befehl` folgt. Pfade wie `cd /mnt/server/steamcmd`
 * bleiben unberuehrt. Skripte, die die Einstellung schon setzen, auch.
 */
export function tuneSteamCmd(script: string): { script: string; calls: number } {
  if (script.includes('nClientDownloadEnableHTTP2')) return { script, calls: 0 };
  let calls = 0;
  const out = script.replace(/(\bsteamcmd(?:\.sh)?)(?=[ \t]+(?:\\\r?\n[ \t]*)?\+)/g, (m) => {
    calls += 1;
    return `${m} ${ARGS}`;
  });
  return { script: out, calls };
}

/**
 * Shell-Zeilen, die eine steam_dev.cfg in jedes gefundene SteamCMD-Verzeichnis
 * unter /mnt/server legen (hoechstens zwei Ebenen tief). Laeuft im EXIT-trap,
 * also auch, wenn das Skript vorzeitig endet. Fehler werden geschluckt.
 */
export function steamDevCfgShell(): string {
  const lines = STEAM_CONVARS.map(([k, v]) => `${k} ${v}`).join('\\n');
  return `for d in $(find /mnt/server -maxdepth 3 -name steamcmd.sh -exec dirname {} \\; 2>/dev/null); do printf '${lines}\\n' > "$d/steam_dev.cfg" 2>/dev/null; done`;
}
