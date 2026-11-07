import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseChangelog, parseTodo, parseDevlog, PANEL_VERSION, BUILD } from '../src/version.js';

describe('Version', () => {
  it('kommt aus package.json und steht oben im CHANGELOG', () => {
    expect(PANEL_VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
    expect(JSON.parse(readFileSync('web/package.json', 'utf8')).version).toBe(PANEL_VERSION);
    const cl = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'));
    expect(cl[0]!.version).toBe(PANEL_VERSION);
    expect(cl[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cl[0]!.sections[0]!.items.length).toBeGreaterThan(0);
    // Jede Version nur einmal, absteigend
    const vs = cl.map((c) => c.version);
    expect(new Set(vs).size).toBe(vs.length);
    expect(BUILD.version).toBe(PANEL_VERSION);
  });
  it('Changelog-Format', () => {
    const c = parseChangelog('# X\n\n    ## [9.9.9] – 2000-01-01 – Beispiel\n## [1.2.3] – 2026-01-02 – Titel\n### Neu\n- a\n  weiter\n- b\n### Behoben\n- c\n## 1.2.2\n- d\n');
    expect(c).toEqual([
      { version: '1.2.3', date: '2026-01-02', title: 'Titel', sections: [{ title: 'Neu', items: ['a weiter', 'b'] }, { title: 'Behoben', items: ['c'] }] },
      { version: '1.2.2', date: null, title: null, sections: [{ title: 'Änderungen', items: ['d'] }] },
    ]);
  });
  it('TODO-Format', () => {
    const t = parseTodo('# TODO\n\n## Als Nächstes\n- [ ] a\n- [x] b (0.5.0)\n## Leer\n');
    expect(t).toEqual([{ title: 'Als Nächstes', items: [{ text: 'a', done: false, version: null }, { text: 'b', done: true, version: '0.5.0' }] }]);
    expect(parseTodo(readFileSync('docs/TODO.md', 'utf8')).length).toBeGreaterThan(3);
  });
  it('Devlog-Format', () => {
    const raw = '# Log\n\n## 2026-11-07\n\n| Zeit | Was | Dateien |\n| --- | --- | --- |\n| 12:00 | **Test-Feature** gebaut | `file.ts` |\n';
    const entries = parseDevlog(raw);
    expect(entries).toEqual([
      { date: '2026-11-07', time: '12:00', text: '**Test-Feature** gebaut', files: '`file.ts`' },
    ]);
    expect(parseDevlog(readFileSync('docs/ENTWICKLUNGSLOG.md', 'utf8')).length).toBeGreaterThan(5);
  });
});
