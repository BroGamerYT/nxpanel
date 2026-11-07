import { describe, it, expect } from 'vitest';
import yazl from 'yazl';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { analyzeArchive, readIni, readProperties, compareVersions, readNbt, type EggForDetect } from '../src/servers/detect.js';

async function makeZip(entries: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nxp-det-'));
  const path = join(dir, 'b.zip');
  const zip = new yazl.ZipFile();
  for (const [n, c] of Object.entries(entries)) zip.addBuffer(Buffer.isBuffer(c) ? c : Buffer.from(c), n);
  zip.end();
  await new Promise<void>((res) => zip.outputStream.pipe(createWriteStream(path)).on('close', () => res()));
  return path;
}

/** Winziges level.dat: { "": { Data: { Version: { Name: "1.21.4" }, LevelName: "world" } } } */
function levelDat(version: string): Buffer {
  const s = (t: string) => { const b = Buffer.from(t); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const tag = (type: number, name: string, payload: Buffer) => Buffer.concat([Buffer.from([type]), s(name), payload]);
  const compound = (...children: Buffer[]) => Buffer.concat([...children, Buffer.from([0])]);
  const int = Buffer.alloc(4); int.writeInt32BE(3955);
  const nbt = tag(10, '', compound(tag(10, 'Data', compound(
    tag(3, 'DataVersion', int),
    tag(11, 'Pos', Buffer.from([0, 0, 0, 1, 0, 0, 0, 7])),
    tag(10, 'Version', compound(tag(8, 'Name', s(version)), tag(1, 'Snapshot', Buffer.from([0])))),
    tag(8, 'LevelName', s('world')),
  ))));
  return gzipSync(nbt);
}

function egg(file: string): EggForDetect {
  const e = JSON.parse(readFileSync(join('eggs', file), 'utf8'));
  return { id: file, name: e.name, rules: e.import.rules, detect: e.import.detect ?? null };
}
const EGGS = ['minecraft-paper.json', 'ark-survival-ascended.json', 'enshrouded.json', 'teamspeak6.json'].map(egg);
const v = (c: { variables: Array<{ env: string; value: string }> }, k: string) => c.variables.find((x) => x.env === k);

describe('Leser', () => {
  it('ini mit Punkten im Abschnitt, properties mit Unicode', () => {
    const ini = '[SessionSettings]\r\nSessionName=Simons Insel\r\n[/Script/Engine.GameSession]\r\nMaxPlayers=20\r\n';
    expect(readIni(ini, 'SessionSettings', 'SessionName')).toBe('Simons Insel');
    expect(readIni(ini, '/Script/Engine.GameSession', 'MaxPlayers')).toBe('20');
    expect(readIni(ini, 'ServerSettings', 'ServerAdminPassword')).toBeNull();
    expect(readProperties('#x\nmotd=\\u00A7aHallo Welt\nmax-players=12\n', 'motd')).toBe('§aHallo Welt');
  });
  it('Versionen sortieren', () => {
    expect(['1.21.9', '1.21.10', '26.3', '1.8'].sort(compareVersions)).toEqual(['1.8', '1.21.9', '1.21.10', '26.3']);
  });
  it('NBT', () => {
    const { gunzipSync } = require('node:zlib') as typeof import('node:zlib');
    const d = readNbt(gunzipSync(levelDat('26.3')));
    expect((d.Data as { Version: { Name: string } }).Version.Name).toBe('26.3');
  });
});

describe('Backup erkennen', () => {
  it('AMP-Minecraft: Spiel, Version aus level.dat, Typ, MOTD', async () => {
    const zip = await makeZip({
      'M263Vanilla01/Minecraft/world/level.dat': levelDat('26.3'),
      'M263Vanilla01/Minecraft/world/region/r.0.0.mca': 'x'.repeat(1000),
      'M263Vanilla01/Minecraft/server.properties': 'motd=Germany LanGame\ndifficulty=2\nmax-players=10\n',
      'M263Vanilla01/Minecraft/eula.txt': 'eula=true',
      'M263Vanilla01/Minecraft/minecraft_server.jar': 'jar',
      'M263Vanilla01/Minecraft/.trash/world/level.dat': levelDat('1.8'),
    });
    const a = await analyzeArchive(zip, EGGS);
    expect(a.confident).toBe(true);
    const c = a.candidates[0]!;
    expect(c.name).toBe('Minecraft Java');
    expect(v(c, 'VERSION')?.value).toBe('26.3');
    expect(v(c, 'TYPE')?.value).toBe('VANILLA');
    expect(v(c, 'MOTD')?.value).toBe('Germany LanGame');
    expect(v(c, 'DIFFICULTY')?.value).toBe('normal');
    expect(c.importBytes).toBeGreaterThan(1000);
  });

  it('Paper ohne level.dat: Version aus dem Jar-Namen', async () => {
    const zip = await makeZip({
      'srv/paper-1.21.4-232.jar': 'j', 'srv/paper-1.21.1-100.jar': 'j',
      'srv/config/paper-global.yml': 'x', 'srv/server.properties': 'motd=A', 'srv/world/region/r.mca': 'r',
    });
    const c = (await analyzeArchive(zip, EGGS)).candidates[0]!;
    expect(v(c, 'TYPE')?.value).toBe('PAPER');
    expect(v(c, 'VERSION')).toMatchObject({ value: '1.21.4', options: ['1.21.4', '1.21.1'] });
  });

  it('ARK: Karte, Name, Passwort - mehrere Karten werden zur Auswahl', async () => {
    const zip = await makeZip({
      'Simon27012701/ark-sa/2430930/ShooterGame/Saved/SavedArks/TheIsland_WP/TheIsland_WP.ark': 'x'.repeat(5000),
      'Simon27012701/ark-sa/2430930/ShooterGame/Saved/SavedArks/ScorchedEarth_WP/ScorchedEarth_WP.ark': 'x'.repeat(100),
      'Simon27012701/ark-sa/2430930/ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini':
        '[ServerSettings]\nServerAdminPassword=geheim1234\n[SessionSettings]\nSessionName=Simons ARK\n',
      'Simon27012701/ark-sa/2430930/ShooterGame/Saved/Logs/x.log': 'log',
    });
    const a = await analyzeArchive(zip, EGGS);
    const c = a.candidates[0]!;
    expect(c.name).toBe('ARK: Survival Ascended');
    expect(a.confident).toBe(true);
    expect(v(c, 'MAP')).toMatchObject({ value: 'TheIsland_WP', options: ['TheIsland_WP', 'ScorchedEarth_WP'] });
    expect(v(c, 'SESSION_NAME')?.value).toBe('Simons ARK');
    expect(v(c, 'ADMIN_PASSWORD')?.value).toBe('geheim1234');
  });

  it('Enshrouded und TeamSpeak', async () => {
    const ens = await makeZip({
      'ThornServer01/enshrouded/2278520/enshrouded_server.json': JSON.stringify({ name: 'Thorn', slotCount: 8 }),
      'ThornServer01/enshrouded/2278520/savegame/3ad85aea': 's',
    });
    const e = (await analyzeArchive(ens, EGGS)).candidates[0]!;
    expect(e.name).toBe('Enshrouded');
    expect(v(e, 'SERVER_NAME')?.value).toBe('Thorn');
    expect(v(e, 'SERVER_SLOTS')?.value).toBe('8');
    expect(v(e, 'EXTERNAL_CONFIG')?.value).toBe('1');

    const ts = await makeZip({ 'GLGTS601/ts6/server/tsserver.sqlitedb': 'db', 'GLGTS601/ts6/server/files/virtualserver_1/a': 'f' });
    const t = await analyzeArchive(ts, EGGS);
    expect(t.candidates[0]!.name).toBe('TeamSpeak 6');
    expect(t.confident).toBe(true);
  });

  it('nicht eindeutig: nur ein "world"-Ordner -> unsicher, Nutzer waehlt', async () => {
    const zip = await makeZip({ 'irgendwas/world/region/r.mca': 'r' });
    const a = await analyzeArchive(zip, EGGS);
    expect(a.confident).toBe(false);
    expect(a.candidates.map((c) => c.name)).toContain('Minecraft Java');
  });

  it('fremdes Archiv: keine Kandidaten', async () => {
    const a = await analyzeArchive(await makeZip({ 'urlaub/foto.jpg': 'x' }), EGGS);
    expect(a.candidates).toEqual([]);
    expect(a.confident).toBe(false);
  });
});
