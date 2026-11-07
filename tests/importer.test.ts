import { describe, it, expect, beforeEach } from 'vitest';
import yazl from 'yazl';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { matchEntry, safeTarget, importArchive } from '../src/servers/importer.js';
import { config } from '../src/config.js';

async function makeZip(entries: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nxp-zip-'));
  const path = join(dir, 'backup.zip');
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
  zip.end();
  await new Promise<void>((res) => zip.outputStream.pipe(createWriteStream(path)).on('close', () => res()));
  return path;
}

const mc = [
  { match: 'world', to: 'world' }, { match: 'server.properties', to: 'server.properties' }, { match: 'plugins', to: 'plugins' },
];
const ark = [{ match: 'ShooterGame/Saved', to: 'ShooterGame/Saved', exclude: ['Logs'] }];

describe('Regeln', () => {
  it('findet die Stelle, egal wie tief sie im Archiv liegt', () => {
    expect(matchEntry('M263Vanilla01/Minecraft/world/region/r.0.0.mca', mc)!.rest).toEqual(['region', 'r.0.0.mca']);
    expect(matchEntry('Simon/ark-sa/2430930/ShooterGame/Saved/SavedArks/TheIsland_WP/x.ark', ark)!.rest)
      .toEqual(['SavedArks', 'TheIsland_WP', 'x.ark']);
  });
  it('frueherer Treffer gewinnt: Plugin-Ordner mit eigenem "world" bleibt beim Plugin', () => {
    const h = matchEntry('Minecraft/plugins/dynmap/world/tiles.png', mc)!;
    expect(h.rule.match).toBe('plugins');
    expect(h.rest).toEqual(['dynmap', 'world', 'tiles.png']);
  });
  it('AMP-Papierkorb, Backups und ausgeschlossene Ordner werden uebersprungen', () => {
    expect(matchEntry('Minecraft/.trash/world/level.dat', mc)).toBeNull();
    expect(matchEntry('Backups/old/world/level.dat', mc)).toBeNull();
    expect(matchEntry('ShooterGame/Saved/Logs/a.log', ark)).toBeNull();
  });
  it('kein Ausbruch aus dem Datenordner', () => {
    expect(safeTarget('/data/srv', 'world', ['..', '..', 'etc', 'passwd'])).toBeNull();
    expect(safeTarget('/data/srv', 'world', ['region', 'r.mca'])).toBe(resolve('/data/srv', 'world', 'region', 'r.mca'));
  });
});

describe('Import aus Archiv', () => {
  const short = 'imptest1';
  const root = join(config.VOLUME_ROOT, short);
  beforeEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('uebernimmt nur Passendes und legt Vorhandenes beiseite', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(root, 'world'), { recursive: true });
    await writeFile(join(root, 'world', 'level.dat'), 'ALT');

    const zip = await makeZip({
      'M263Vanilla01/Minecraft/world/level.dat': 'NEU',
      'M263Vanilla01/Minecraft/world/region/r.0.0.mca': 'region',
      'M263Vanilla01/Minecraft/server.properties': 'motd=AMP',
      'M263Vanilla01/Minecraft/.trash/world/level.dat': 'MUELL',
      'M263Vanilla01/Minecraft/paper.jar': 'jar',
      'M263Vanilla01/AMPConfig.conf': 'x',
    });
    const r = await importArchive(short, zip, mc, null);
    expect(r.files).toBe(3);
    expect(r.matched).toEqual({ world: 2, 'server.properties': 1 });
    expect(await readFile(join(root, 'world', 'level.dat'), 'utf8')).toBe('NEU');
    expect(await readFile(join(root, 'server.properties'), 'utf8')).toBe('motd=AMP');
    expect(r.backupDir).toBeTruthy();
    expect(await readFile(join(r.backupDir!, 'world', 'level.dat'), 'utf8')).toBe('ALT');
    expect((await readdir(root)).sort()).toEqual(['.panel', 'server.properties', 'world']);
  });

  it('ohne Treffer: nichts geschrieben', async () => {
    const zip = await makeZip({ 'foo/bar.txt': 'x' });
    const r = await importArchive(short, zip, ark, null);
    expect(r.files).toBe(0);
    expect(r.skipped).toBe(1);
  });
});
