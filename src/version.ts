import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listDocs, type DocMeta } from './docs.js';

/**
 * Versionsangaben des Panels.
 *
 * Einzige Quelle fuer die Versionsnummer ist package.json. Was beim Bauen
 * dazukommt (laufende Build-Nummer, Zeitpunkt), schreibt der Updater in
 * build-info.json. Fehlt die Datei - etwa beim Entwickeln -, steht dort "dev".
 *
 * src/version.ts und dist/version.js liegen beide eine Ebene unter dem
 * Projektordner, deshalb funktioniert derselbe relative Pfad in beiden Faellen.
 */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(join(APP_ROOT, file), 'utf8').replace(/^\uFEFF/, '')) as T; } catch { return null; }
}

const pkg = readJson<{ version: string }>('package.json');
const build = readJson<{ version?: string; build?: number; builtAt?: string }>('build-info.json');

export const PANEL_VERSION = pkg?.version ?? '0.0.0';

export interface BuildInfo { version: string; build: number | null; builtAt: string | null; dev: boolean }

export const BUILD: BuildInfo = {
  version: PANEL_VERSION,
  build: typeof build?.build === 'number' ? build.build : null,
  builtAt: build?.builtAt ?? null,
  dev: !build,
};

export interface ChangelogEntry { version: string; date: string | null; title: string | null; sections: Array<{ title: string; items: string[] }> }

/**
 * CHANGELOG.md lesen. Erwartetes Format:
 *   ## [0.5.0] – 2026-11-06 – Kurzer Titel
 *   ### Neu
 *   - Punkt
 */
export function parseChangelog(text: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const head = /^##\s+\[?(\d+\.\d+\.\d+[^\]\s]*)\]?(?:\s+[–-]\s+(\d{4}-\d{2}-\d{2}))?(?:\s+[–-]\s+(.+))?$/.exec(line);
    if (head) {
      cur = { version: head[1]!, date: head[2] ?? null, title: head[3]?.trim() ?? null, sections: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const sec = /^###\s+(.+)$/.exec(line);
    if (sec) { cur.sections.push({ title: sec[1]!.trim(), items: [] }); continue; }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) {
      if (!cur.sections.length) cur.sections.push({ title: 'Änderungen', items: [] });
      cur.sections[cur.sections.length - 1]!.items.push(item[1]!.trim());
    } else if (/^\s{2,}\S/.test(raw) && cur.sections.length) {
      // Fortsetzungszeile eines Punktes
      const items = cur.sections[cur.sections.length - 1]!.items;
      if (items.length) items[items.length - 1] += ' ' + raw.trim();
    }
  }
  return out;
}

export interface TodoSection { title: string; items: Array<{ text: string; done: boolean; version: string | null }> }

export interface DevlogEntry {
  date: string;
  time: string;
  text: string;
  files: string;
}

/** docs/ENTWICKLUNGSLOG.md: Markdown-Tabellen je Tag mit | Zeit | Was | Dateien |. */
export function parseDevlog(text: string): DevlogEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: DevlogEntry[] = [];
  let currentDate = '';

  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(line);
    if (heading) {
      currentDate = heading[1]!;
      continue;
    }
    if (line.startsWith('|') && !line.includes('---') && !line.includes('Zeit')) {
      const parts = line.split('|').map((s) => s.trim());
      // format: ['', '05:25', 'Was...', 'Dateien...', '']
      if (parts.length >= 4 && parts[1]) {
        entries.push({
          date: currentDate,
          time: parts[1],
          text: parts[2] ?? '',
          files: parts[3] ?? '',
        });
      }
    }
  }
  return entries;
}

/** docs/TODO.md: Abschnitte "## ..." mit "- [ ]" / "- [x] ... (0.5.0)". */
export function parseTodo(text: string): TodoSection[] {
  const out: TodoSection[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const head = /^##\s+(.+)$/.exec(raw.trim());
    if (head) { out.push({ title: head[1]!.trim(), items: [] }); continue; }
    const item = /^[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(raw.trim());
    if (item && out.length) {
      let text = item[2]!.trim();
      const v = /\s+\((\d+\.\d+\.\d+)\)$/.exec(text);
      if (v) text = text.slice(0, v.index);
      out[out.length - 1]!.items.push({ text, done: item[1] !== ' ', version: v?.[1] ?? null });
    }
  }
  return out.filter((s) => s.items.length);
}

export interface GitHubUpdateInfo {
  hasUpdate: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
}

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [aMaj = 0, aMin = 0, aPatch = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPatch = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPatch - bPatch;
}

let cachedUpdate: { info: GitHubUpdateInfo; expiresAt: number } | null = null;

export async function checkGitHubUpdate(repo = process.env.GITHUB_REPO || 'dominik/nxpanel'): Promise<GitHubUpdateInfo> {
  const now = Date.now();
  if (cachedUpdate && cachedUpdate.expiresAt > now) {
    return cachedUpdate.info;
  }
  const fallback: GitHubUpdateInfo = {
    hasUpdate: false,
    latestVersion: null,
    releaseUrl: null,
    releaseName: null,
    publishedAt: null,
  };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'NexusPanel-UpdateCheck', Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      cachedUpdate = { info: fallback, expiresAt: now + 60 * 60 * 1000 };
      return fallback;
    }
    const data = (await res.json()) as { tag_name?: string; html_url?: string; name?: string; published_at?: string };
    const latestTag = data.tag_name ?? '';
    const cleanLatest = latestTag.replace(/^v/, '');
    const cleanCurrent = PANEL_VERSION.replace(/^v/, '');
    const hasUpdate = cleanLatest ? compareVersions(cleanLatest, cleanCurrent) > 0 : false;
    const info: GitHubUpdateInfo = {
      hasUpdate,
      latestVersion: cleanLatest || null,
      releaseUrl: data.html_url ?? null,
      releaseName: data.name ?? null,
      publishedAt: data.published_at ?? null,
    };
    cachedUpdate = { info, expiresAt: now + 60 * 60 * 1000 };
    return info;
  } catch {
    cachedUpdate = { info: fallback, expiresAt: now + 15 * 60 * 1000 };
    return fallback;
  }
}

export async function loadAbout() {
  const [cl, todo, devlog, update, docs] = await Promise.all([
    readFile(join(APP_ROOT, 'CHANGELOG.md'), 'utf8').catch(() => ''),
    readFile(join(APP_ROOT, 'docs', 'TODO.md'), 'utf8').catch(() => ''),
    readFile(join(APP_ROOT, 'docs', 'ENTWICKLUNGSLOG.md'), 'utf8').catch(() => ''),
    checkGitHubUpdate(),
    listDocs().catch(() => [] as DocMeta[]),
  ]);
  return { ...BUILD, update, changelog: parseChangelog(cl), todo: parseTodo(todo), devlog: parseDevlog(devlog), docs };
}
