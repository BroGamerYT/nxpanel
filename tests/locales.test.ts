import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Sprachdateien der Oberflaeche pruefen. Englisch ist die Referenz: jede
 * andere Datei darf nur Schluessel enthalten, die es dort gibt, und muss
 * dieselben Platzhalter verwenden. Deutsch muss vollstaendig sein.
 */
const DIR = 'web/src/locales';
type Tree = { [k: string]: string | Tree };
function flat(t: Tree, p = '', o: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(t)) {
    const key = p ? `${p}.${k}` : k;
    if (typeof v === 'string') o[key] = v; else flat(v, key, o);
  }
  return o;
}
const load = (f: string) => flat(JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Tree);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const en = load('en.json');

describe('Sprachdateien', () => {
  it('Englisch und Deutsch sind da', () => {
    expect(files).toContain('en.json');
    expect(files).toContain('de.json');
  });

  for (const f of files) {
    it(`${f}: Name, Code, keine fremden Schluessel, gleiche Platzhalter`, () => {
      expect(f).toMatch(/^[a-z]{2,3}(-[A-Z]{2})?\.json$/);
      const l = load(f);
      expect(l['_meta.name']).toBeTruthy();
      const unknown = Object.keys(l).filter((k) => !(k in en));
      expect(unknown, 'Schluessel, die es in en.json nicht gibt').toEqual([]);
      const wrong = Object.keys(l).filter((k) => !k.startsWith('_meta') && placeholders(l[k]!).join() !== placeholders(en[k]!).join());
      expect(wrong, 'Platzhalter weichen von en.json ab').toEqual([]);
    });
  }

  it('Deutsch ist vollstaendig', () => {
    const de = load('de.json');
    expect(Object.keys(en).filter((k) => !(k in de))).toEqual([]);
  });
});
