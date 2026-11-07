import { useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Copy, Check, FileText, Code2, List } from 'lucide-react';

export interface TocHeading {
  id: string;
  text: string;
  level: number;
}

export interface MarkdownViewerProps {
  content: string;
  className?: string;
  showRawToggle?: boolean;
  showCopyButton?: boolean;
  onHeadingsExtracted?: (headings: TocHeading[]) => void;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function MarkdownViewer({
  content,
  className = '',
  showRawToggle = true,
  showCopyButton = true,
  onHeadingsExtracted,
}: MarkdownViewerProps) {
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered');
  const [copied, setCopied] = useState(false);

  // Inhaltsverzeichnis (TOC) & HTML generieren
  const { html, headings } = useMemo(() => {
    const extractedHeadings: TocHeading[] = [];
    const usedIds = new Set<string>();

    // Vorbereitung: Eigene Renderer-Logik für Headings mit IDs und Checkboxen
    const renderer = new marked.Renderer();

    renderer.heading = function ({ text, depth }: { text: string; depth: number }) {
      const cleanText = text.replace(/<[^>]+>/g, '');
      let baseId = slugify(cleanText) || `heading-${extractedHeadings.length}`;
      let finalId = baseId;
      let counter = 1;
      while (usedIds.has(finalId)) {
        finalId = `${baseId}-${counter++}`;
      }
      usedIds.add(finalId);

      extractedHeadings.push({
        id: finalId,
        text: cleanText,
        level: depth,
      });

      return `<h${depth} id="${finalId}" class="heading-anchor group flex items-baseline gap-2">
        <a href="#${finalId}" class="opacity-0 group-hover:opacity-60 text-amber hover:opacity-100 transition-opacity -ml-5 pr-1 select-none font-mono text-xs" title="Link zu diesem Abschnitt">#</a>
        <span>${text}</span>
      </h${depth}>`;
    };

    // Tabellen-Styling verbessern
    renderer.table = function (token) {
      // marked v18: ein Token mit Zellen; Zellen/Zeilen ueber die eigenen
      // Renderer-Funktionen bauen (wie marked selbst), nur der Rahmen ist eigen.
      const headerHtml = this.tablerow({ text: token.header.map((cell) => this.tablecell(cell)).join('') });
      const bodyHtml = token.rows
        .map((row) => this.tablerow({ text: row.map((cell) => this.tablecell(cell)).join('') }))
        .join('');
      return `<div class="overflow-x-auto my-4 rounded-lg border border-seam bg-rack/40">
        <table class="w-full text-left border-collapse text-xs">
          <thead class="bg-rack-2/70 border-b border-seam font-semibold text-ink">${headerHtml}</thead>
          <tbody class="divide-y divide-seam/40">${bodyHtml}</tbody>
        </table>
      </div>`;
    };

    renderer.checkbox = function ({ checked }: { checked: boolean }) {
      return checked
        ? `<span class="inline-block text-led-run font-bold mr-1.5 align-middle select-none">☑</span>`
        : `<span class="inline-block text-dim mr-1.5 align-middle select-none">☐</span>`;
    };

    try {
      const parsed = marked.parse(content, {
        gfm: true,
        breaks: true,
        renderer,
      }) as string;

      const sanitized = DOMPurify.sanitize(parsed, {
        ADD_ATTR: ['target', 'id', 'class'],
      });

      return { html: sanitized, headings: extractedHeadings };
    } catch {
      return { html: `<pre>${content}</pre>`, headings: [] };
    }
  }, [content]);

  // Headings an Callback weiterreichen wenn gewünscht
  useMemo(() => {
    if (onHeadingsExtracted) {
      onHeadingsExtracted(headings);
    }
  }, [headings, onHeadingsExtracted]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Steuerungsleiste (Vorschau / Quelltext / Kopieren) */}
      {(showRawToggle || showCopyButton) && (
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-seam/60 text-xs">
          <div className="flex items-center gap-1 bg-rack-2/60 p-0.5 rounded-lg border border-seam">
            {showRawToggle && (
              <>
                <button
                  type="button"
                  onClick={() => setViewMode('rendered')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    viewMode === 'rendered'
                      ? 'bg-amber text-black shadow-sm font-semibold'
                      : 'text-dim hover:text-ink'
                  }`}
                >
                  <FileText className="size-3.5" />
                  Formatierte Vorschau
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('raw')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    viewMode === 'raw'
                      ? 'bg-amber text-black shadow-sm font-semibold'
                      : 'text-dim hover:text-ink'
                  }`}
                >
                  <Code2 className="size-3.5" />
                  Quelltext (Markdown)
                </button>
              </>
            )}
          </div>

          {showCopyButton && (
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rack-2/80 hover:bg-rack-2 border border-seam text-xs text-ink hover:text-amber transition-colors"
              title="Markdown-Inhalt in die Zwischenablage kopieren"
            >
              {copied ? (
                <>
                  <Check className="size-3.5 text-led-run" />
                  <span className="text-led-run font-medium">Kopiert!</span>
                </>
              ) : (
                <>
                  <Copy className="size-3.5" />
                  <span>Kopieren</span>
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Inhalt: Entweder formatierter Markdown-Renderer oder Rohcode */}
      {viewMode === 'raw' ? (
        <div className="rounded-lg border border-seam bg-[#0d121a] p-4 overflow-x-auto">
          <pre className="font-mono text-xs text-ink/90 leading-relaxed whitespace-pre-wrap select-all">
            {content}
          </pre>
        </div>
      ) : (
        <div
          className="markdown-content text-ink/90 text-sm leading-relaxed space-y-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
