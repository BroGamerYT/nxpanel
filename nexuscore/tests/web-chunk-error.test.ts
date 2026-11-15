import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isChunkLoadError } from '../../web/src/lib/chunkError';

describe('Seitenfehler machen die Oberfläche nicht mehr leer', () => {
  it('erkennt Ladefehler nachgeladener Seitendateien in den gängigen Browsern', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Hosts-abc.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 12 failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('die Shell fängt Fehler der Seiten ab', () => {
    const shell = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'components', 'Shell.tsx'), 'utf8');
    expect(shell).toContain('<PageErrorBoundary>');
    expect(shell.indexOf('<PageErrorBoundary>')).toBeLessThan(shell.indexOf('<Outlet />'));
  });
});
