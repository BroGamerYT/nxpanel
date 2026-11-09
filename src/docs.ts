import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ROOT } from './version.js';

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

// Bekannte Dokumente mit maßgeschneiderten Metadaten und Sortierpriorität
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
  if (match && match[1]) {
    return match[1].replace(/[*`_]/g, '').trim();
  }
  return fallback;
}

function extractFirstParagraph(content: string, fallback: string): string {
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|') || trimmed.startsWith('---') || trimmed.startsWith('>')) {
      continue;
    }
    return trimmed.slice(0, 160) + (trimmed.length > 160 ? '…' : '');
  }
  return fallback;
}

export async function listDocs(): Promise<DocMeta[]> {
  const results: DocMeta[] = [];
  const scanned = new Set<string>();

  const scanDir = async (dirRel: string) => {
    const fullDir = join(APP_ROOT, dirRel);
    try {
      const entries = await readdir(fullDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md') || entry.name.toLowerCase() === 'vm-infos.md') continue;
        const filename = entry.name;
        if (scanned.has(filename)) continue;
        scanned.add(filename);

        const relPath = dirRel ? `${dirRel}/${filename}` : filename;
        const fullPath = join(fullDir, filename);

        try {
          const st = await stat(fullPath);
          const raw = await readFile(fullPath, 'utf8');
          const known = KNOWN_DOCS[filename];

          const slug = known?.slug ?? slugify(filename);
          const title = known?.title ?? extractFirstHeading(raw, filename.replace(/\.md$/i, ''));
          const description = known?.description ?? extractFirstParagraph(raw, 'Dokumentation für NexusPanel');
          const category = known?.category ?? (dirRel === 'docs' ? 'concept' : 'general');
          const categoryLabel = known?.categoryLabel ?? (dirRel === 'docs' ? 'Dokumentation' : 'Allgemein');
          const lineCount = raw.split(/\r?\n/).length;

          results.push({
            slug,
            filename,
            relativePath: relPath,
            title,
            category,
            categoryLabel,
            description,
            size: st.size,
            sizeFormatted: formatSize(st.size),
            lineCount,
            updatedAt: st.mtime.toISOString(),
          });
        } catch {
          // Datei überspringen falls nicht lesbar
        }
      }
    } catch {
      // Ordner überspringen falls nicht vorhanden
    }
  };

  // Zuerst docs/, dann Root
  await scanDir('docs');
  await scanDir('');

  // Sortieren nach definierter Reihenfolge, unbekannte alphabetisch
  results.sort((a, b) => {
    const orderA = KNOWN_DOCS[a.filename]?.order ?? 999;
    const orderB = KNOWN_DOCS[b.filename]?.order ?? 999;
    if (orderA !== orderB) return orderA - orderB;
    return a.title.localeCompare(b.title);
  });

  return results;
}

export async function getDoc(slugOrName: string): Promise<DocDetail | null> {
  const list = await listDocs();
  const target = slugOrName.toLowerCase();

  const found = list.find(
    (d) =>
      d.slug.toLowerCase() === target ||
      d.filename.toLowerCase() === target ||
      d.filename.toLowerCase() === `${target}.md` ||
      slugify(d.filename) === target,
  );

  if (!found) return null;

  try {
    const fullPath = join(APP_ROOT, found.relativePath);
    const content = await readFile(fullPath, 'utf8');
    return {
      ...found,
      content,
    };
  } catch {
    return null;
  }
}
