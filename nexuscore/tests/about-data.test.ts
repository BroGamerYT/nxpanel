import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseChangelog, parseDevlog, parseTodo, aboutData } from '../src/about-data.js';

describe('Hilfe: Was ist neu, Geplant, Entwickler-Log', () => {
  it('liest den Changelog: Version, Datum, Titel, Abschnitte, Punkte', () => {
    const r = parseChangelog('# Änderungen\n\n## [0.3.2] – 2026-11-13 – Sven\n\n### Behoben\n- Eins\n- Zwei\n\n### Offen\n- Drei\n\n## [0.2.0] – 2026-11-10 – Erster\nText\n- Direkt\n');
    expect(r.map((e) => e.version)).toEqual(['0.3.2', '0.2.0']);
    expect(r[0]).toMatchObject({ date: '2026-11-13', title: 'Sven' });
    expect(r[0]!.sections).toEqual([{ title: 'Behoben', items: ['Eins', 'Zwei'] }, { title: 'Offen', items: ['Drei'] }]);
    expect(r[1]!.sections[0]).toEqual({ title: 'Neu', items: ['Direkt'] });
  });

  it('liest die Aufgaben: offen/erledigt, Version am Ende, leere Abschnitte fallen weg', () => {
    const r = parseTodo('# T\n\n## A\n\n- [x] Fertig (0.3.0)\n- [ ] Offen\n  - [ ] Eingerückt\n\n## Leer\n\nNur Text\n');
    expect(r).toEqual([{ title: 'A', items: [{ text: 'Fertig', done: true, version: '0.3.0' }, { text: 'Offen', done: false }, { text: 'Eingerückt', done: false }] }]);
  });

  it('liest das Entwicklungslog, auch Zeilen über mehrere Textzeilen', () => {
    const r = parseDevlog('# Log\n\n## 2026-11-12\n\n| Zeit | Was | Dateien |\n| --- | --- | --- |\n| 20:10 | **Eins** mit | Pipe-freiem Text | `a.ts`, `b.ts` |\n| 19:00 | Zwei | `c.ts` |\n\n## 2026-11-11\n\n| 09:00 | Drei erste Zeile |\n       "zweite Zeile | `d.ts` |\n');
    expect(r.map((e) => `${e.date} ${e.time}`)).toEqual(['2026-11-12 20:10', '2026-11-12 19:00', '2026-11-11 09:00']);
    expect(r[1]).toMatchObject({ text: 'Zwei', files: 'c.ts' });
    expect(r[2]!.text).toContain('Drei erste Zeile');
    expect(r[2]!.text).toContain('zweite Zeile');
  });

  it('das echte Entwicklungslog des Projekts ergibt viele Einträge mit Text', () => {
    const file = path.resolve(__dirname, '..', '..', 'docs', 'ENTWICKLUNGSLOG.md');
    if (!fs.existsSync(file)) return;
    const r = parseDevlog(fs.readFileSync(file, 'utf8'));
    expect(r.length).toBeGreaterThan(20);
    expect(r.every((e) => e.text.length > 5 && e.date.length === 10)).toBe(true);
  });

  it('aboutData liest die Dateien der docs-Ordner (Core-Changelog und Core-Aufgaben liegen im Projekt)', async () => {
    const d = await aboutData();
    expect(d.changelog[0]?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(d.todo.some((s) => s.items.some((i) => !i.done))).toBe(true);
  });
});
