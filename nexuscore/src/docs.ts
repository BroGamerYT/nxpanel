import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Dokumentation fuer die Hilfe-Seite: alle Markdown-Dateien aus den Ordnern `docs` (neben dem Core und im Repository)
 * und die README des Cores. Gelesen wird nur, was die Auflistung selbst gefunden hat - nie ein Pfad aus der Anfrage.
 */

export interface DocMeta {
  slug: string;
  filename: string;
  relativePath: string;
  title: string;
  category: string;
  categoryLabel: string;
  description: string;
  size: number;
  sizeFormatted: string;
  lineCount: number;
  updatedAt: string;
}

export interface DocDetail extends DocMeta {
  content: string;
}

// Bekannte Dokumente mit massgeschneiderten Metadaten und Sortierprioritaet
const KNOWN_DOCS: Record<
  string,
  {
    order: number;
    title: string;
    category: string;
    categoryLabel: string;
    description: string;
    slug?: string;
  }
> = {
  'INSTALLATION.md': {
    order: 2,
    title: 'Installation auf Windows, Linux und macOS',
    category: 'general',
    categoryLabel: 'Allgemein & System',
    description: 'Ein Core für alle Systeme: Treiber, Dienst und Einrichten je Betriebssystem.',
    slug: 'installation',
  },
  'LINUX-VM-TEST.md': {
    order: 3,
    title: 'NexusCore auf einer Linux-VM testen',
    category: 'general',
    categoryLabel: 'Allgemein & System',
    description: 'Schritt für Schritt: einrichten, Selbsttest, mit dem Panel koppeln, Fehlerbilder.',
    slug: 'linux-vm-test',
  },
  'ABNAHME-PANEL-CORE.md': {
    order: 6,
    title: 'Abnahme: Panel gegen NexusCore',
    category: 'concept',
    categoryLabel: 'Konzepte & Planung',
    description: 'Welche Panel-Funktionen der Core schon kann, was fehlt und in welcher Reihenfolge es kommt.',
    slug: 'abnahme-panel-core',
  },
  'ARCHITEKTUR.md': {
    order: 1,
    title: 'Gesamtarchitektur & NexusCore',
    category: 'architecture',
    categoryLabel: 'Architektur & Technik',
    description: 'Systemüberblick, NexusCore (Rust), OCI-Docker/Podman, Windows nativ & mTLS-Kopplung.',
    slug: 'architektur',
  },
  'EGG-KATALOG.md': {
    order: 2,
    title: 'Egg-Katalog & Spielvorlagen',
    category: 'eggs',
    categoryLabel: 'Spiele & Vorlagen',
    description: '263 analysierte Spieleggs, Ports, Startmuster, Parser, Installer & Kompatibilität.',
    slug: 'egg-katalog',
  },
  'KONZEPT-APPS.md': {
    order: 3,
    title: 'Apps, Agent & Installer Konzept',
    category: 'architecture',
    categoryLabel: 'Architektur & Technik',
    description: 'Tauri-2-Apps (Desktop & Mobil), NexusCore-Agent & Windows-Setup-Assistent.',
    slug: 'konzept-apps',
  },
  'Game-Server-Panel - Konzept & Roadmap.md': {
    order: 4,
    title: 'Gesamtkonzept & Master-Roadmap',
    category: 'concept',
    categoryLabel: 'Konzepte & Planung',
    description: 'Das ursprüngliche Gesamtkonzept, Architektur-Entscheidungen und Meilensteine.',
    slug: 'konzept-roadmap',
  },
  'Game-Server-Panel – Konzept & Roadmap.md': {
    order: 4,
    title: 'Gesamtkonzept & Master-Roadmap',
    category: 'concept',
    categoryLabel: 'Konzepte & Planung',
    description: 'Das ursprüngliche Gesamtkonzept, Architektur-Entscheidungen und Meilensteine.',
    slug: 'konzept-roadmap',
  },
  'GAME-INSTALL-TESTS.md': {
    order: 5,
    title: 'Automatisierte Spiele-Tests',
    category: 'eggs',
    categoryLabel: 'Spiele & Vorlagen',
    description: 'Ergebnisse der automatisierten Installations- und Stabilitäts-Tests aller Game-Eggs.',
    slug: 'game-install-tests',
  },
  'TODO.md': {
    order: 6,
    title: 'Geplante Aufgaben & Roadmap',
    category: 'concept',
    categoryLabel: 'Konzepte & Planung',
    description: 'Offene Meilensteine M1–M8, geplante Optimierungen und Kriterien für Version 1.0.',
    slug: 'todo',
  },
  'ENTWICKLUNGSLOG.md': {
    order: 7,
    title: 'Entwickler-Protokoll (Devlog)',
    category: 'logs',
    categoryLabel: 'Verlauf & Logs',
    description: 'Vollständiges chronologisches Protokoll aller implementierten Features und Fixes.',
    slug: 'entwicklungslog',
  },
  'CHANGELOG.md': {
    order: 8,
    title: 'Versionshistorie (Changelog)',
    category: 'logs',
    categoryLabel: 'Verlauf & Logs',
    description: 'Offizielle Release-Notes, Versionen und Neuerungen seit Release 0.1.0.',
    slug: 'changelog',
  },
  'README.md': {
    order: 9,
    title: 'NexusPanel Übersicht & Quickstart',
    category: 'general',
    categoryLabel: 'Allgemein & System',
    description: 'Projektüberblick, Systemvoraussetzungen, Schnellstart und Technologie-Stack.',
    slug: 'readme',
  },
  'SECURITY.md': {
    order: 10,
    title: 'Sicherheitsrichtlinie & Schutz',
    category: 'general',
    categoryLabel: 'Allgemein & System',
    description: 'Sicherheitsarchitektur, Isolation, Container-Härtung und Schwachstellenmeldung.',
    slug: 'security',
  },
  'CONTRIBUTING.md': {
    order: 11,
    title: 'Leitfaden für Mitwirkende',
    category: 'general',
    categoryLabel: 'Allgemein & System',
    description: 'Entwicklungsrichtlinien, Code-Style, Branching und Test-Anforderungen.',
    slug: 'contributing',
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractFirstHeading(content: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1] ? match[1].replace(/[*`_]/g, '').trim() : fallback;
}

function extractFirstParagraph(content: string, fallback: string): string {
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|') || trimmed.startsWith('---') || trimmed.startsWith('>') || trimmed.startsWith('```')) continue;
    return trimmed.slice(0, 160) + (trimmed.length > 160 ? '…' : '');
  }
  return fallback;
}

interface Found {
  meta: DocMeta;
  fullPath: string;
}

/** Wo gesucht wird: Ordner `docs` im Arbeitsverzeichnis des Cores und eine Ebene darueber (Repository), dazu die README des Cores. */
function sources(): Array<{ dir: string; rel: string; onlyReadme: boolean }> {
  const cwd = process.cwd();
  return [
    { dir: join(cwd, 'docs'), rel: 'docs', onlyReadme: false },
    { dir: join(cwd, '..', 'docs'), rel: 'docs', onlyReadme: false },
    { dir: cwd, rel: '', onlyReadme: true },
  ].filter((s) => existsSync(s.dir));
}

async function findAll(): Promise<Found[]> {
  const results: Found[] = [];
  const seen = new Set<string>();
  for (const src of sources()) {
    let entries;
    try {
      entries = await readdir(src.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (!entry.isFile() || !lower.endsWith('.md') || lower === 'vm-infos.md') continue;
      if (src.onlyReadme && lower !== 'readme.md') continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      const fullPath = join(src.dir, entry.name);
      try {
        const st = await stat(fullPath);
        const raw = await readFile(fullPath, 'utf8');
        const known = KNOWN_DOCS[entry.name];
        results.push({
          fullPath,
          meta: {
            slug: known?.slug ?? slugify(entry.name),
            filename: entry.name,
            relativePath: src.rel ? `${src.rel}/${entry.name}` : entry.name,
            title: known?.title ?? extractFirstHeading(raw, entry.name.replace(/\.md$/i, '')),
            category: known?.category ?? (src.rel === 'docs' ? 'concept' : 'general'),
            categoryLabel: known?.categoryLabel ?? (src.rel === 'docs' ? 'Dokumentation' : 'Allgemein'),
            description: known?.description ?? extractFirstParagraph(raw, 'Dokumentation für NexusCore'),
            size: st.size,
            sizeFormatted: formatSize(st.size),
            lineCount: raw.split(/\r?\n/).length,
            updatedAt: st.mtime.toISOString(),
          },
        });
      } catch {
        // nicht lesbar: ueberspringen
      }
    }
  }
  // Nach definierter Reihenfolge, unbekannte alphabetisch
  results.sort((a, b) => {
    const oa = KNOWN_DOCS[a.meta.filename]?.order ?? 999;
    const ob = KNOWN_DOCS[b.meta.filename]?.order ?? 999;
    return oa !== ob ? oa - ob : a.meta.title.localeCompare(b.meta.title);
  });
  return results;
}

export async function listDocs(): Promise<DocMeta[]> {
  return (await findAll()).map((f) => f.meta);
}

export async function getDoc(slugOrName: string): Promise<DocDetail | null> {
  const target = slugOrName.toLowerCase();
  const found = (await findAll()).find(
    (f) => f.meta.slug.toLowerCase() === target || f.meta.filename.toLowerCase() === target || f.meta.filename.toLowerCase() === `${target}.md` || slugify(f.meta.filename) === target,
  );
  if (!found) return null;
  try {
    return { ...found.meta, content: await readFile(found.fullPath, 'utf8') };
  } catch {
    return null;
  }
}
