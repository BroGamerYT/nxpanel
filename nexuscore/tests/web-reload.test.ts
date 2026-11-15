import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseCoreVersion, shouldReload } from '../../web/src/lib/coreVersionCheck';

describe('Oberfläche lädt nach einem Core-Update neu', () => {
  it('liest die Core-Version aus /core/v1/info und lehnt alles andere ab', () => {
    expect(parseCoreVersion({ status: 'ok', core: { version: '0.3.18' } })).toBe('0.3.18');
    expect(parseCoreVersion({ status: 'ok', core: {} })).toBeNull();
    expect(parseCoreVersion({ core: { version: '' } })).toBeNull();
    expect(parseCoreVersion({ core: { version: 318 } })).toBeNull();
    expect(parseCoreVersion({ core: null })).toBeNull();
    expect(parseCoreVersion(null)).toBeNull();
    expect(parseCoreVersion('text')).toBeNull();
  });

  it('lädt nur bei bekannter und geänderter Version neu', () => {
    expect(shouldReload('0.3.17', '0.3.18')).toBe(true);
    expect(shouldReload('0.3.18', '0.3.18')).toBe(false);
    // Beim Neustart antwortet der Core kurz nicht: kein Neuladen, kein Absturz
    expect(shouldReload('0.3.17', null)).toBe(false);
    // Ohne Ausgangsstand (Panel ohne Core, erster Abruf fehlgeschlagen) nie neu laden
    expect(shouldReload(null, '0.3.18')).toBe(false);
    expect(shouldReload(null, null)).toBe(false);
  });

  it('die App nutzt es (auch auf der Anmeldeseite) und die Info-Route ist öffentlich', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'main.tsx'), 'utf8');
    expect(main).toContain("import { useReloadOnNewCore }");
    // Der Aufruf steht vor den frühen Rückgaben von App() (Anmeldeseite)
    expect(main.indexOf('useReloadOnNewCore();')).toBeGreaterThan(main.indexOf('function App()'));
    expect(main.indexOf('useReloadOnNewCore();')).toBeLessThan(main.indexOf('if (!me) return <Login />'));
    const security = fs.readFileSync(path.join(__dirname, '..', 'src', 'protocol', 'security.ts'), 'utf8');
    expect(security).toContain("p === '/core/v1/info'");
  });
});
