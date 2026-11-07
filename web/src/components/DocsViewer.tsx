import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FileText,
  Search,
  Layers,
  Gamepad2,
  Compass,
  GitCommit,
  Info,
  Server,
  Shield,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  List,
  Download,
  Check,
  Copy,
  Hash,
  Clock,
  HardDrive,
  FileCode,
  ArrowRight,
} from 'lucide-react';
import { api } from '../lib/api';
import { Spinner, ErrorBox } from './ui';
import { MarkdownViewer, type TocHeading } from './MarkdownViewer';
import type { DocMeta, DocDetail } from '../lib/version';

interface DocsViewerProps {
  docs: DocMeta[];
  activeSlug: string;
  onSelectDoc: (slug: string) => void;
}

function getCategoryIcon(category: string) {
  switch (category) {
    case 'architecture':
      return Layers;
    case 'eggs':
      return Gamepad2;
    case 'concept':
      return Compass;
    case 'logs':
      return GitCommit;
    case 'general':
      return BookOpen;
    default:
      return FileText;
  }
}

export function DocsViewer({ docs, activeSlug, onSelectDoc }: DocsViewerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [showToc, setShowToc] = useState(false);

  // Aktives Dokument ermitteln (Fallback auf erstes)
  const currentMeta = useMemo(() => {
    return docs.find((d) => d.slug === activeSlug) || docs[0] || null;
  }, [docs, activeSlug]);

  const currentSlug = currentMeta?.slug ?? '';

  // Dokumenteninhalt laden
  const {
    data: docDetail,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['doc', currentSlug],
    queryFn: () => api<DocDetail>(`/docs/${currentSlug}`),
    enabled: !!currentSlug,
  });

  // Filterkategorien berechnen
  const categories = useMemo(() => {
    const map = new Map<string, { id: string; label: string; count: number }>();
    for (const d of docs) {
      const existing = map.get(d.category);
      if (existing) {
        existing.count++;
      } else {
        map.set(d.category, { id: d.category, label: d.categoryLabel, count: 1 });
      }
    }
    return Array.from(map.values());
  }, [docs]);

  // Dokumentenliste filtern
  const filteredDocs = useMemo(() => {
    let result = docs;
    if (selectedCategory !== 'all') {
      result = result.filter((d) => d.category === selectedCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.filename.toLowerCase().includes(q) ||
          d.description.toLowerCase().includes(q) ||
          d.categoryLabel.toLowerCase().includes(q),
      );
    }
    return result;
  }, [docs, selectedCategory, searchQuery]);

  // Vorheriges / Nächstes Dokument
  const currentIndex = docs.findIndex((d) => d.slug === currentSlug);
  const prevDoc = currentIndex > 0 ? docs[currentIndex - 1] : null;
  const nextDoc = currentIndex < docs.length - 1 ? docs[currentIndex + 1] : null;

  const handleDownload = () => {
    if (!docDetail?.content) return;
    const blob = new Blob([docDetail.content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentMeta?.filename || `${currentSlug}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const IconComponent = currentMeta ? getCategoryIcon(currentMeta.category) : FileText;

  return (
    <div className="space-y-6">
      {/* Steuerungsleiste: Kategorien & Suchfilter */}
      <div className="space-y-3 bg-rack rounded-xl border border-seam p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BookOpen className="size-5 text-amber" />
            <div>
              <h2 className="text-sm font-semibold text-ink">Dokumentations-Bibliothek</h2>
              <p className="text-xs text-dim">
                Alle System-, Architektur- und Konzept-Dokumente (.md) im Volltext durchsuchen und umschalten.
              </p>
            </div>
          </div>

          {/* Suchfeld */}
          <div className="relative w-full sm:w-72">
            <Search className="size-3.5 text-dim absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Dokumente durchsuchen …"
              className="w-full h-8 pl-8 pr-3 text-xs rounded-lg bg-rack-2 border border-seam text-ink placeholder:text-dim/60 focus:outline-none focus:border-amber transition-colors"
            />
          </div>
        </div>

        {/* Kategorie-Pills */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-seam/60 text-xs">
          <button
            type="button"
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              selectedCategory === 'all'
                ? 'bg-amber text-black font-semibold'
                : 'bg-rack-2/60 text-dim hover:text-ink hover:bg-rack-2 border border-seam'
            }`}
          >
            Alle ({docs.length})
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedCategory(c.id)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                selectedCategory === c.id
                  ? 'bg-amber text-black font-semibold'
                  : 'bg-rack-2/60 text-dim hover:text-ink hover:bg-rack-2 border border-seam'
              }`}
            >
              {c.label} ({c.count})
            </button>
          ))}
        </div>
      </div>

      {/* Dokumenten-Kacheln zum Switchen */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {filteredDocs.map((doc) => {
          const ItemIcon = getCategoryIcon(doc.category);
          const isSelected = doc.slug === currentSlug;
          return (
            <button
              key={doc.slug}
              type="button"
              onClick={() => onSelectDoc(doc.slug)}
              className={`text-left p-3 rounded-lg border transition-all flex flex-col justify-between gap-2 ${
                isSelected
                  ? 'bg-amber/10 border-amber ring-1 ring-amber/50 shadow-sm'
                  : 'bg-rack/60 hover:bg-rack border-seam hover:border-seam/90'
              }`}
            >
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ItemIcon className={`size-4 ${isSelected ? 'text-amber' : 'text-dim'}`} />
                    <span className={`text-xs font-semibold line-clamp-1 ${isSelected ? 'text-amber' : 'text-ink'}`}>
                      {doc.title}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-rack-2 border border-seam text-dim">
                    {doc.sizeFormatted}
                  </span>
                </div>
                <p className="text-[11px] text-dim line-clamp-2 leading-relaxed">
                  {doc.description}
                </p>
              </div>

              <div className="pt-1.5 border-t border-seam/40 flex items-center justify-between text-[10px] text-dim font-mono">
                <span className="truncate max-w-[170px]" title={doc.relativePath}>
                  {doc.filename}
                </span>
                <span>{doc.lineCount} Z.</span>
              </div>
            </button>
          );
        })}
      </div>

      {filteredDocs.length === 0 && (
        <div className="p-8 text-center text-sm text-dim bg-rack rounded-lg border border-seam">
          Keine Dokumente gefunden für "{searchQuery}".
        </div>
      )}

      {/* Aktives Dokument Ansicht */}
      {currentMeta && (
        <div className="rounded-xl border border-seam bg-rack overflow-hidden shadow-lg animate-in fade-in duration-150">
          {/* Dokument-Kopfzeile */}
          <div className="p-5 border-b border-seam bg-rack-2/40 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-rack-2 border border-seam text-amber shrink-0 mt-0.5">
                  <IconComponent className="size-5" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-lg font-bold text-ink">{currentMeta.title}</h1>
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-rack border border-seam text-amber">
                      {currentMeta.filename}
                    </span>
                  </div>
                  <p className="text-xs text-dim mt-1 leading-relaxed max-w-2xl">
                    {currentMeta.description}
                  </p>
                </div>
              </div>

              {/* Dokument-Aktionen */}
              <div className="flex items-center gap-2 shrink-0">
                {headings.length > 0 && (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowToc(!showToc)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                        showToc
                          ? 'bg-amber text-black border-amber'
                          : 'bg-rack-2 hover:bg-rack border-seam text-ink'
                      }`}
                      title="Inhaltsverzeichnis anzeigen"
                    >
                      <List className="size-3.5" />
                      <span>Inhalt ({headings.length})</span>
                    </button>

                    {/* Inhaltsverzeichnis Dropdown-Menü */}
                    {showToc && (
                      <div className="absolute right-0 top-full mt-2 w-72 max-h-80 overflow-y-auto z-30 p-2 rounded-xl bg-night border border-seam shadow-2xl space-y-1">
                        <div className="px-2 py-1 text-[11px] font-semibold text-dim uppercase tracking-wider border-b border-seam/60 mb-1">
                          Inhaltsverzeichnis
                        </div>
                        {headings.map((h) => (
                          <a
                            key={h.id}
                            href={`#${h.id}`}
                            onClick={() => setShowToc(false)}
                            className={`block px-2 py-1 rounded text-xs transition-colors hover:bg-rack-2 hover:text-amber truncate ${
                              h.level === 1
                                ? 'font-semibold text-ink'
                                : h.level === 2
                                ? 'pl-4 text-ink/80'
                                : 'pl-6 text-dim'
                            }`}
                          >
                            {h.text}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleDownload}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rack-2 hover:bg-rack border border-seam text-xs text-ink hover:text-amber transition-colors"
                  title="Markdown-Datei (.md) herunterladen"
                >
                  <Download className="size-3.5" />
                  <span className="hidden sm:inline">Download</span>
                </button>
              </div>
            </div>

            {/* Metadaten-Leiste */}
            <div className="flex flex-wrap items-center gap-4 text-xs text-dim font-mono pt-2 border-t border-seam/40">
              <span className="flex items-center gap-1.5">
                <FileCode className="size-3.5 text-amber" />
                <span>Pfad: {currentMeta.relativePath}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <HardDrive className="size-3.5 text-amber" />
                <span>Größe: {currentMeta.sizeFormatted}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <List className="size-3.5 text-amber" />
                <span>Zeilen: {currentMeta.lineCount}</span>
              </span>
            </div>
          </div>

          {/* Dokumenten-Inhalt */}
          <div className="p-6">
            {isLoading && (
              <div className="py-16 grid place-items-center">
                <Spinner />
              </div>
            )}

            {error && (
              <ErrorBox>
                Fehler beim Laden des Dokuments: {(error as Error)?.message}
              </ErrorBox>
            )}

            {docDetail && (
              <MarkdownViewer
                content={docDetail.content}
                onHeadingsExtracted={setHeadings}
                showRawToggle={true}
                showCopyButton={true}
              />
            )}
          </div>

          {/* Footer mit Schnellnavigation zum nächsten/vorherigen Dokument */}
          <div className="p-4 border-t border-seam bg-rack-2/40 flex flex-wrap items-center justify-between gap-3">
            {prevDoc ? (
              <button
                type="button"
                onClick={() => onSelectDoc(prevDoc.slug)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rack hover:bg-rack-2 border border-seam text-xs text-ink hover:text-amber transition-colors text-left"
              >
                <ChevronLeft className="size-4 shrink-0" />
                <div>
                  <div className="text-[10px] text-dim">Vorheriges Dokument</div>
                  <div className="font-medium truncate max-w-[160px] sm:max-w-xs">{prevDoc.title}</div>
                </div>
              </button>
            ) : (
              <div />
            )}

            {nextDoc && (
              <button
                type="button"
                onClick={() => onSelectDoc(nextDoc.slug)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rack hover:bg-rack-2 border border-seam text-xs text-ink hover:text-amber transition-colors text-right ml-auto"
              >
                <div>
                  <div className="text-[10px] text-dim">Nächstes Dokument</div>
                  <div className="font-medium truncate max-w-[160px] sm:max-w-xs">{nextDoc.title}</div>
                </div>
                <ChevronRight className="size-4 shrink-0" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
