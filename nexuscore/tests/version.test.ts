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

  it('der MSI-Bau nimmt die Version aus package.json statt einer festen Zahl', () => {
    const wxs = fs.readFileSync(path.join(root, 'deploy', 'windows', 'NexusCore.wxs'), 'utf8');
    expect(wxs).toContain('Version="$(CoreVersion)"');
    const script = fs.readFileSync(path.join(root, 'scripts', 'build-windows-package.ps1'), 'utf8');
    expect(script).toContain('-d CoreVersion=');
  });
});
