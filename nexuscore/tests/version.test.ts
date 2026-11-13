import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CORE_VERSION } from '../src/version.js';

const root = path.resolve(__dirname, '..');

describe('Versionsnummer', () => {
  it('src/version.ts und package.json nennen dieselbe Version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(CORE_VERSION);
  });

  it('der neueste Eintrag im Changelog gehört zur aktuellen Version', async () => {
    const { parseChangelog } = await import('../src/about-data.js');
    const md = fs.readFileSync(path.join(root, 'docs', 'CHANGELOG.md'), 'utf8');
    expect(parseChangelog(md)[0]?.version).toBe(CORE_VERSION);
  });

  it('die Oberfläche lässt sich als App installieren (Manifest, Symbole) und der Installer legt eine App-Verknüpfung an', () => {
    const web = path.resolve(root, '..', 'web');
    const manifest = JSON.parse(fs.readFileSync(path.join(web, 'public', 'manifest.webmanifest'), 'utf8')) as { display: string; start_url: string; icons: Array<{ src: string; sizes: string }> };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['256x256', '512x512']));
    for (const icon of manifest.icons) expect(fs.existsSync(path.join(web, 'public', icon.src)), icon.src).toBe(true);
    expect(fs.readFileSync(path.join(web, 'index.html'), 'utf8')).toContain('rel="manifest"');
    const wxs = fs.readFileSync(path.join(root, 'deploy', 'windows', 'NexusCore.wxs'), 'utf8');
    expect(wxs).toContain('--app=http://127.0.0.1:8443');
    // Symbol auf dem Desktop und im Startmenue, eigenes Icon statt dem von Edge
    expect(wxs).toContain('NexusCoreDesktopShortcut');
    expect(wxs).toContain('ARPPRODUCTICON');
    expect(fs.statSync(path.join(root, 'deploy', 'windows', 'nexuscore.ico')).size).toBeGreaterThan(1000);
  });

  it('das Core-Release auf GitHub: Tag core-vX.Y.Z baut den MSI mit dem Bau-Skript', () => {
    const wf = fs.readFileSync(path.join(root, '..', '.github', 'workflows', 'core-release.yml'), 'utf8');
    expect(wf).toContain("- 'core-v*'");
    expect(wf).toContain('build-windows-package.ps1');
    expect(wf).toContain('NexusCore-Setup.msi');
  });

  it('die Sandbox-Startdatei liegt bei den Skripten', () => {
    const bat = fs.readFileSync(path.join(root, 'scripts', 'sandbox-test.bat'), 'utf8');
    expect(bat).toContain('WindowsSandbox.exe');
    expect(bat).toContain('NexusCore-Setup.msi');
    expect(fs.readFileSync(path.join(root, 'scripts', 'sandbox', 'start.cmd'), 'utf8')).toContain('/l*v');
  });

  it('der MSI-Bau nimmt die Version aus package.json statt einer festen Zahl', () => {
    const wxs = fs.readFileSync(path.join(root, 'deploy', 'windows', 'NexusCore.wxs'), 'utf8');
    expect(wxs).toContain('Version="$(CoreVersion)"');
    // Oberflaeche, Spielvorlagen und Doku muessen im Installer liegen - der Core sucht sie neben nexuscore.exe
    for (const dir of ['WebFolder', 'EggsFolder', 'DocsFolder']) expect(wxs).toContain(`Directory="${dir}"`);
    const script = fs.readFileSync(path.join(root, 'scripts', 'build-windows-package.ps1'), 'utf8');
    expect(script).toContain('-d CoreVersion=');
    // Ordner mit \ am Ende vor dem Anfuehrungszeichen verdoppeln, sonst zerlegt Windows die Befehlszeile des Dienstes falsch
    expect(wxs).toContain('--workdir &quot;[INSTALLFOLDER]\\&quot;');
    // Im gebuendelten Code (Node SEA) gibt es kein import.meta.url - ohne diesen Ersatz stuerzt die nexuscore.exe beim Start ab
    expect(script).toContain('--define:import.meta.url=__IMPORT_META_URL');
    expect(fs.readFileSync(path.join(root, 'scripts', 'sea-shim.js'), 'utf8')).toContain('__IMPORT_META_URL');
  });
});
