import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { loadEggs, resetEggCache } = await import('../src/eggs/loader.js');
const { installPlanFor } = await import('../src/install/manager.js');
const { installSteamGame, prepareSteamStart } = await import('../src/install/steam-game.js');
const { initialValue } = await import('../src/eggs/rules.js');

/**
 * Der Weg, auf dem im echten Testlauf 16 Spiele scheiterten (bedingte Startargumente): die ECHTE Installationsfunktion
 * mit einem nachgebauten SteamCMD, fuer jedes Steam-Spiel der Vorlagen - samt Neuaufbau der Argumente vor jedem Start.
 */

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-eggsinst-'));
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

resetEggCache();
const eggs = (await loadEggs()).filter((e) => e.raw.windows?.steam_app_id !== undefined);

/** Ein "SteamCMD", das die Dateien des Spiels samt Manifest anlegt. */
function fakeRunner(executable: string) {
  return async (_exe: string, args: string[], hooks: { onLine: (l: string) => void }): Promise<number> => {
    const dir = args[args.indexOf('+force_install_dir') + 1]!;
    const appId = args[args.indexOf('+app_update') + 1]!;
    await fs.mkdir(path.dirname(path.join(dir, executable)), { recursive: true });
    await fs.writeFile(path.join(dir, executable), 'MZ');
    await fs.mkdir(path.join(dir, 'steamapps'), { recursive: true });
    await fs.writeFile(path.join(dir, 'steamapps', `appmanifest_${appId}.acf`), `"AppState"\n{\n\t"appid"\t"${appId}"\n\t"buildid"\t"42"\n}\n`);
    hooks.onLine(`Success! App '${appId}' fully installed.`);
    return 0;
  };
}

describe('Installation jedes Steam-Spiels der Vorlagen (nachgebautes SteamCMD)', () => {
  it('es sind viele', () => {
    expect(eggs.length).toBeGreaterThanOrEqual(25);
  });

  describe.each(eggs.map((e) => [e.id, e] as const))('%s', (id, egg) => {
    it('installiert, baut Argumente und Dateien - und nach einem JSON-Rundlauf auch vor jedem Start', async () => {
      const variables: Record<string, string> = {};
      for (const v of egg.raw.variables ?? []) variables[v.env_variable] = initialValue(v);
      const plan = installPlanFor(id, egg.raw, variables);
      expect(plan?.kind).toBe('steamcmd');
      const steam = plan!.steam!;

      const ports = [egg.raw.ports as { primary?: { ref?: string }; secondary?: Array<{ ref?: string }> } | undefined]
        .flatMap((p) => [p?.primary, ...(p?.secondary ?? [])])
        .filter(Boolean)
        .map((p, i) => ({ name: (p?.ref ?? (i === 0 ? 'game' : `port${i}`)).toLowerCase(), hostPort: 31000 + i, protocol: 'udp' as const }));
      const serverDir = path.join(root, id);

      const result = await installSteamGame(
        {
          serverDir,
          runtimesDir: path.join(root, 'runtimes'),
          launch: steam,
          variables,
          ports: ports.length ? ports : [{ name: 'game', hostPort: 31000, protocol: 'udp' }],
          ramMb: 4096,
          serverName: 'Test Server',
        },
        { steamExe: 'steamcmd.exe', runner: fakeRunner(steam.executable) as never, platform: 'win32' },
      );

      expect(result.executable).toBe(path.join(serverDir, ...steam.executable.split('/')));
      expect(result.args.every((a) => typeof a === 'string' && a !== '')).toBe(true);
      expect(result.args.filter((a) => a.includes('{{'))).toEqual([]);

      // Alle Dateien, die der Core schreiben soll, gibt es und sind lesbar
      for (const f of steam.files ?? []) {
        const text = await fs.readFile(path.join(serverDir, f.path), 'utf8');
        expect(text.length, f.path).toBeGreaterThan(0);
        if (f.format === 'json') expect(() => JSON.parse(text), f.path).not.toThrow();
      }

      // Vor jedem Start werden Argumente und Dateien aus der gespeicherten Angabe neu gebaut (so liegt sie in der Datenbank)
      const stored = JSON.parse(JSON.stringify(steam));
      const again = await prepareSteamStart({
        id,
        name: 'Test Server',
        game: id,
        executable: result.executable,
        args: result.args,
        workingDir: serverDir,
        maxMemoryMb: 4096,
        ports: ports.length ? ports : [{ name: 'game', hostPort: 31000, protocol: 'udp' }],
        install: { state: 'done', kind: 'steamcmd', variables, steam: stored },
      } as never);
      expect(again).toEqual(result.args);
    });
  });
});
