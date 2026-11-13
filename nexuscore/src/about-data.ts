import { getDoc } from './docs.js';

/**
 * Daten fuer "Hilfe & Doku": Was ist neu, Geplant und Entwickler-Log.
 * Sie kommen aus den Markdown-Dateien CHANGELOG.md, TODO.md und ENTWICKLUNGSLOG.md der docs-Ordner
 * (dieselben Dateien, die auch im Reiter "Dokumentation" stehen) - eine Datei pflegen, beides stimmt.
 */

export interface ChangelogEntry { version: string; date: string; title: string; sections: Array<{ title: string; items: string[] }> }
export interface TodoSection { title: string; items: Array<{ text: string; done: boolean; version?: string }> }
export interface DevlogEntry { date: string; time: string; text: string; files: string }

const lines = (md: string): string[] => md.replace(/\r\n/g, '\n').split('\n');

/** `## [1.2.3] – JJJJ-MM-TT – Titel`, darunter `### Neu` und `- Punkt`. */
export function parseChangelog(md: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  let sec: { title: string; items: string[] } | null = null;
  for (const raw of lines(md)) {
    const h = raw.match(/^##\s+\[([^\]]+)\]\s*(?:[–—-]\s*(\d{4}-\d{2}-\d{2}))?\s*(?:[–—-]\s*(.*))?$/);
    if (h) {
      cur = { version: h[1]!, date: h[2] ?? '', title: (h[3] ?? '').trim(), sections: [] };
      out.push(cur);
      sec = null;
      continue;
    }
    if (!cur) continue;
    const s = raw.match(/^###\s+(.+?)\s*$/);
    if (s) {
      sec = { title: s[1]!, items: [] };
      cur.sections.push(sec);
      continue;
    }
    const item = raw.match(/^\s*-\s+(.*\S)\s*$/);
    if (item) {
      // Ein Text direkt unter der Version (ohne ### ...) kommt in einen Abschnitt "Neu"
      if (!sec) {
        sec = { title: 'Neu', items: [] };
        cur.sections.push(sec);
      }
      sec.items.push(item[1]!);
    }
  }
  return out;
}

/** `## Titel`, darunter `- [ ] offen` / `- [x] erledigt (0.3.2)`. Eingerueckte Punkte zaehlen als eigene Zeilen. */
export function parseTodo(md: string): TodoSection[] {
  const out: TodoSection[] = [];
  let cur: TodoSection | null = null;
  for (const raw of lines(md)) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) {
      cur = { title: h[1]!, items: [] };
      out.push(cur);
      continue;
    }
    const m = raw.match(/^\s*-\s+\[( |x|X)\]\s+(.*\S)\s*$/);
    if (!m || !cur) continue;
    const done = m[1] !== ' ';
    let text = m[2]!;
    let version: string | undefined;
    const v = text.match(/\s*\((\d+\.\d+\.\d+)\)\s*$/);
    if (v) {
      version = v[1];
      text = text.slice(0, v.index).trim();
    }
    cur.items.push({ text, done, ...(version ? { version } : {}) });
  }
  return out.filter((s) => s.items.length > 0);
}

/** `## JJJJ-MM-TT`, darunter eine Tabelle `| Zeit | Was | Dateien |` (eine Zeile kann ueber mehrere Textzeilen gehen). */
export function parseDevlog(md: string): DevlogEntry[] {
  const out: DevlogEntry[] = [];
  let date = '';
  let row: string | null = null;
  const flush = (): void => {
    if (row === null) return;
    const body = row.replace(/^\|\s*/, '').replace(/\s*\|\s*$/, '');
    const first = body.indexOf('|');
    const last = body.lastIndexOf('|');
    if (first > 0 && last > first) {
      const time = body.slice(0, first).trim();
      const text = body.slice(first + 1, last).trim().replace(/\s*\n\s*"?\s*/g, ' ').replace(/^"|"$/g, '');
      const files = body.slice(last + 1).trim().replace(/`/g, '');
      if (/^\d{1,2}:\d{2}$/.test(time)) out.push({ date, time, text, files });
    }
    row = null;
  };
  for (const raw of lines(md)) {
    const h = raw.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    if (h) {
      flush();
      date = h[1]!;
      continue;
    }
    if (!date) continue;
    if (/^\|\s*\d{1,2}:\d{2}\s*\|/.test(raw)) {
      flush();
      row = raw;
    } else if (row !== null) {
      if (raw.trim() === '' || /^\|\s*---/.test(raw) || raw.startsWith('#')) flush();
      else row += `\n${raw}`;
    }
  }
  flush();
  return out;
}

export async function aboutData(): Promise<{ changelog: ChangelogEntry[]; todo: TodoSection[]; devlog: DevlogEntry[] }> {
  const read = async (name: string): Promise<string> => (await getDoc(name).catch(() => null))?.content ?? '';
  const [changelog, todo, devlog] = await Promise.all([read('CHANGELOG.md'), read('TODO.md'), read('ENTWICKLUNGSLOG.md')]);
  return { changelog: parseChangelog(changelog), todo: parseTodo(todo), devlog: parseDevlog(devlog) };
}
