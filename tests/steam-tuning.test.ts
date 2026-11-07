import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { steamDevCfgShell, tuneSteamCmd } from '../src/servers/steam-tuning.js';

describe('SteamCMD-Beschleunigung', () => {
  it('haengt die Einstellungen an typische Aufrufe', () => {
    const s = [
      './steamcmd.sh +force_install_dir /mnt/server +login anonymous +app_update 294420 validate +quit',
      'steamcmd +login anonymous +quit',
      '/mnt/server/steamcmd/steamcmd.sh \\',
      '  +login anonymous +quit',
    ].join('\n');
    const r = tuneSteamCmd(s);
    expect(r.calls).toBe(3);
    expect(r.script.split('+@nClientDownloadEnableHTTP2PlatformLinux 0').length - 1).toBe(3);
    // Reihenfolge: Einstellungen stehen vor +login
    expect(r.script.indexOf('@cMaxInitialDownloadSources')).toBeLessThan(r.script.indexOf('+force_install_dir'));
  });

  it('laesst Pfade, Downloads und schon angepasste Skripte in Ruhe', () => {
    const s = 'mkdir -p /mnt/server/steamcmd\ncd /mnt/server/steamcmd\ncurl -sSL -o steamcmd.tar.gz https://x/steamcmd_linux.tar.gz';
    expect(tuneSteamCmd(s)).toEqual({ script: s, calls: 0 });
    const done = './steamcmd.sh +@nClientDownloadEnableHTTP2PlatformLinux 0 +login anonymous';
    expect(tuneSteamCmd(done).calls).toBe(0);
  });

  // Echte Linux-Shell noetig (find, Pfade) - unter Windows laeuft das nur im Container.
  it.skipIf(process.platform === 'win32')('legt steam_dev.cfg neben jede steamcmd.sh (bash und sh)', () => {
    for (const sh of ['bash', 'sh']) {
      const root = mkdtempSync(join(tmpdir(), 'nxp-steam-'));
      mkdirSync(join(root, 'steamcmd'));
      writeFileSync(join(root, 'steamcmd', 'steamcmd.sh'), '');
      const cmd = steamDevCfgShell().replaceAll('/mnt/server', root);
      execFileSync(sh, ['-c', cmd]);
      const cfg = join(root, 'steamcmd', 'steam_dev.cfg');
      expect(existsSync(cfg)).toBe(true);
      expect(readFileSync(cfg, 'utf8')).toBe(
        '@nClientDownloadEnableHTTP2PlatformLinux 0\n@fDownloadRateImprovementToAddAnotherConnection 1.0\n@cMaxInitialDownloadSources 15\n',
      );
    }
  });
});
