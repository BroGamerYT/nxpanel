import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { AlertTriangle, ArrowDownToLine, CheckCircle2, CircleX, Lightbulb, Search, X } from 'lucide-react';
import type { ConsoleHint } from '../lib/types';
import { t as tr, fmtDateTime, getLocale } from '../lib/i18n';
import { classify, plain, type Level } from '../lib/loglevel';

export interface ConsoleHandle {
  write: (lines: string[], meta?: { history?: boolean; dropped?: number }) => void;
}

type Filter = 'all' | 'warn' | 'error';
interface Line { text: string; level: Level; ts: number; n: number; ok?: boolean }
interface Problem { n: number; text: string; level: 'error' | 'warn' | 'ok'; ts: number; hint?: string }

const COLOR: Record<Level, string> = {
  error: '\x1b[38;2;255;107;111m',
  warn: '\x1b[38;2;242;201;76m',
  info: '',
};
const MAX_LINES = 5000;

/** Zeile fuers Terminal: eigene Eingaben bernsteinfarben, Fehler rot, Warnungen gelb - aber nur, wenn das Spiel nicht selbst faerbt. */
function render(l: Line, needle: string): string {
  let s = l.text;
  if (s.startsWith('> ')) return `\x1b[38;2;242;169;59m${s}\x1b[0m`;
  if (l.ok && !needle) return `\x1b[38;2;60;203;140m${plain(s)}\x1b[0m`;
  const hasOwnColor = s !== plain(s);
  if (needle) {
    // Treffer hervorheben (auf dem farblosen Text, sonst zerreisst es ANSI-Folgen)
    const p = plain(s);
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = p.replace(re, (m) => `\x1b[30;48;2;242;169;59m${m}\x1b[0m${COLOR[l.level]}`);
    return `${COLOR[l.level]}${s}\x1b[0m`;
  }
  return hasOwnColor || l.level === 'info' ? s : `${COLOR[l.level]}${s}\x1b[0m`;
}

/**
 * Konsole mit xterm.js: ANSI-Farben, Verlauf, Kopieren wie im Terminal.
 * Dazu: Suche/Filter (nur passende Zeilen, nur Warnungen, nur Fehler) und
 * rechts eine Liste aller erkannten Fehler und Warnungen - ein Klick
 * springt zur Stelle. Eingaben gehen ueber die API, nie direkt ins Terminal.
 */
export function Console({ ref, canCommand, readonlyReason, onCommand, hints = [] }: {
  ref: Ref<ConsoleHandle>;
  canCommand: boolean;
  readonlyReason?: string | undefined;
  onCommand: (cmd: string) => boolean;
  /** Muster aus dem Egg mit Erklaerung - erscheinen in der Fehlerliste. */
  hints?: ConsoleHint[];
}) {
  const compiled = useRef<Array<{ re: RegExp; h: ConsoleHint }>>([]);
  compiled.current = useMemo(() => hints.flatMap((h) => { try { return [{ re: new RegExp(h.match, h.flags), h }]; } catch { return []; } }), [hints]);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  const [input, setInput] = useState('');
  const history = useRef<string[]>([]);
  const histPos = useRef(-1);

  const lines = useRef<Line[]>([]);
  const counter = useRef(0);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const view = useRef({ query: '', filter: 'all' as Filter });
  view.current = { query, filter };

  const matches = (l: Line) => {
    const { query: q, filter: f } = view.current;
    if (f === 'error' && l.level !== 'error') return false;
    if (f === 'warn' && l.level === 'info') return false;
    return !q || plain(l.text).toLowerCase().includes(q.toLowerCase());
  };

  useEffect(() => {
    const t = new Terminal({
      convertEol: true,
      disableStdin: true,
      scrollback: MAX_LINES,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
      theme: {
        background: '#0F141C',
        foreground: '#D6DCE6',
        selectionBackground: '#F2A93B55',
        black: '#1B2230', brightBlack: '#56627A',
        red: '#E5484D', brightRed: '#FF6B6F',
        green: '#3CCB8C', brightGreen: '#6BE3AE',
        yellow: '#F2C94C', brightYellow: '#FFE08A',
        blue: '#5B9DF5', brightBlue: '#8DBBFF',
        magenta: '#C792EA', brightMagenta: '#DDB6F5',
        cyan: '#4FC7D9', brightCyan: '#86E1EE',
        white: '#D6DCE6', brightWhite: '#FFFFFF',
      },
    });
    const fit = new FitAddon();
    const s = new SearchAddon();
    t.loadAddon(fit);
    t.loadAddon(s);
    t.open(host.current!);
    fit.fit();
    term.current = t;
    search.current = s;
    t.onScroll(() => {
      const b = t.buffer.active;
      setFollow(b.viewportY >= b.baseY);
    });
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* unsichtbar */ } });
    ro.observe(host.current!);
    return () => { ro.disconnect(); t.dispose(); term.current = null; };
  }, []);

  /** Terminal komplett neu fuellen - nach Aendern von Suche oder Filter. */
  function redraw() {
    const t = term.current;
    if (!t) return;
    t.reset();
    const shown = lines.current.filter(matches);
    const { query: q, filter: f } = view.current;
    if (q || f !== 'all') {
      t.write(`\x1b[2m── ${tr('console.filtered', { shown: shown.length, total: lines.current.length })} ──\x1b[0m\r\n`);
    }
    t.write(shown.map((l) => render(l, q)).join('\r\n') + (shown.length ? '\r\n' : ''));
    t.scrollToBottom();
    setFollow(true);
  }

  useEffect(() => { redraw(); }, [query, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    write(incoming, meta) {
      const t = term.current;
      if (!t) return;
      const now = Date.now();
      if (meta?.history) t.write(`\x1b[2m── ${tr('console.history')} ──\x1b[0m\r\n`);
      if (meta?.dropped) t.write(`\x1b[33m… ${tr('console.dropped', { count: meta.dropped })}\x1b[0m\r\n`);
      const fresh: Problem[] = [];
      let out = '';
      for (const text of incoming) {
        const own = text.startsWith('> ');
        const hint = own ? undefined : compiled.current.find((c) => c.re.test(plain(text)))?.h;
        const level: Level = own ? 'info' : hint ? (hint.level === 'ok' || hint.level === 'ignore' ? 'info' : hint.level) : classify(text);
        const l: Line = { text, level, ts: now, n: ++counter.current, ok: hint?.level === 'ok' };
        lines.current.push(l);
        if (hint && hint.level !== 'ignore') {
          const lang = getLocale();
          const hintText = (hint.text_locales && hint.text_locales[lang]) ? hint.text_locales[lang] : hint.text;
          fresh.push({ n: l.n, text: plain(text).trim(), level: hint.level, ts: now, hint: hintText });
        } else if (level !== 'info') fresh.push({ n: l.n, text: plain(text).trim(), level, ts: now });
        if (matches(l)) out += render(l, view.current.query) + '\r\n';
      }
      if (lines.current.length > MAX_LINES) lines.current.splice(0, lines.current.length - MAX_LINES);
      if (out) t.write(out);
      if (fresh.length) setProblems((p) => [...p, ...fresh].slice(-200));
      if (followRef.current) t.scrollToBottom();
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  function send() {
    const cmd = input.trim();
    if (!cmd) return;
    if (onCommand(cmd)) {
      history.current = [cmd, ...history.current.filter((h) => h !== cmd)].slice(0, 100);
      histPos.current = -1;
      setInput('');
      setFollow(true);
      term.current?.scrollToBottom();
    }
  }

  /** Zur Stelle springen: Filter weg, dann die Zeile im Terminal suchen und markieren. */
  function jumpTo(p: Problem) {
    const needle = p.text.slice(0, 80);
    const go = () => {
      setFollow(false);
      search.current?.findPrevious(needle, { caseSensitive: true, decorations: { activeMatchBackground: '#F2A93B', matchBackground: '#F2A93B55', activeMatchColorOverviewRuler: '#F2A93B', matchOverviewRuler: '#F2A93B88' } });
    };
    if (query || filter !== 'all') {
      setQuery(''); setFilter('all');
      setTimeout(go, 50);
    } else go();
  }

  const counts = useMemo(() => ({
    error: problems.filter((p) => p.level === 'error').length,
    warn: problems.filter((p) => p.level === 'warn').length,
  }), [problems]);

  const chip = (f: Filter, label: string, n?: number) => (
    <button type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
      className={`h-7 px-2.5 rounded-md text-xs inline-flex items-center gap-1.5 border ${filter === f ? 'border-amber text-ink bg-rack-2' : 'border-seam text-dim hover:text-ink'}`}>
      {label}{n !== undefined && n > 0 && <span className="tabular-nums">{n}</span>}
    </button>
  );

  return (
    <div className="grid lg:grid-cols-[1fr_18rem] gap-3">
      <div className="flex flex-col rounded-lg border border-seam bg-[#0F141C] overflow-hidden min-w-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-seam bg-rack px-3 py-2">
          <div className="relative flex-1 min-w-40">
            <Search className="size-3.5 text-dim absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={tr('console.search')} placeholder={tr('console.searchPlaceholder')}
              className="w-full h-7 rounded-md bg-rack-2 border border-seam pl-8 pr-7 text-xs text-ink placeholder:text-dim/70 focus:border-amber focus:outline-none" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label={tr('console.clearSearch')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-dim hover:text-ink"><X className="size-3.5" /></button>}
          </div>
          <div className="flex gap-1" role="group" aria-label={tr('console.filter')}>
            {chip('all', tr('console.filterAll'))}
            {chip('warn', tr('console.filterWarn'), counts.warn + counts.error)}
            {chip('error', tr('console.filterError'), counts.error)}
          </div>
        </div>
        <div className="relative">
          <div ref={host} className="h-[52vh] min-h-72" />
          {!follow && (
            <button
              onClick={() => { term.current?.clearSelection(); search.current?.clearDecorations(); term.current?.scrollToBottom(); setFollow(true); }}
              className="absolute right-4 bottom-3 inline-flex items-center gap-1.5 rounded-md bg-rack-2 border border-seam px-2.5 h-8 text-xs text-ink hover:border-amber"
            >
              <ArrowDownToLine className="size-3.5" /> {tr('console.toEnd')}
            </button>
          )}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex items-center gap-2 border-t border-seam px-3 py-2 bg-rack">
          <span className="font-mono text-amber select-none" aria-hidden>›</span>
          <input
            aria-label={tr('console.inputLabel')}
            value={input}
            disabled={!canCommand}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' && history.current.length) {
                e.preventDefault();
                histPos.current = Math.min(histPos.current + 1, history.current.length - 1);
                setInput(history.current[histPos.current] ?? '');
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                histPos.current = Math.max(histPos.current - 1, -1);
                setInput(histPos.current < 0 ? '' : history.current[histPos.current] ?? '');
              }
            }}
            placeholder={canCommand ? tr('console.placeholder') : readonlyReason ?? tr('console.readonly')}
            className="flex-1 bg-transparent font-mono text-[13px] text-ink placeholder:text-dim/70 focus:outline-none disabled:cursor-not-allowed"
            autoComplete="off"
            spellCheck={false}
          />
        </form>
      </div>

      <aside className="rounded-lg border border-seam bg-rack flex flex-col min-h-0 lg:h-[calc(52vh+5.5rem)] lg:min-h-[22rem]" aria-label={tr('console.problems')}>
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-seam">
          <h3 className="text-sm font-medium">{tr('console.problems')}</h3>
          <span className="flex items-center gap-2 text-xs tabular-nums">
            <span className="inline-flex items-center gap-1 text-led-crash"><CircleX className="size-3.5" aria-hidden />{counts.error}</span>
            <span className="inline-flex items-center gap-1 text-led-start"><AlertTriangle className="size-3.5" aria-hidden />{counts.warn}</span>
            {problems.length > 0 && <button type="button" onClick={() => setProblems([])} className="text-dim hover:text-ink ml-1">{tr('console.clear')}</button>}
          </span>
        </div>
        {problems.length === 0 ? (
          <p className="text-xs text-dim px-3 py-4">{tr('console.noProblems')}</p>
        ) : (
          <ol className="flex-1 overflow-auto divide-y divide-seam">
            {[...problems].reverse().map((p) => (
              <li key={p.n}>
                <button type="button" onClick={() => jumpTo(p)} className="w-full text-left px-3 py-2 hover:bg-rack-2 flex gap-2">
                  {p.level === 'error'
                    ? <CircleX className="size-3.5 text-led-crash shrink-0 mt-0.5" aria-label={tr('console.filterError')} />
                    : p.level === 'warn'
                      ? <AlertTriangle className="size-3.5 text-led-start shrink-0 mt-0.5" aria-label={tr('console.filterWarn')} />
                      : <CheckCircle2 className="size-3.5 text-led-run shrink-0 mt-0.5" aria-label={tr('console.ok')} />}
                  <span className="min-w-0">
                    <span className="block font-mono text-[11.5px] leading-snug text-ink break-words line-clamp-3">{p.text}</span>
                    {p.hint && <span className="mt-1 flex gap-1.5 text-xs text-ink/90 leading-snug"><Lightbulb className="size-3.5 text-amber shrink-0 mt-px" aria-hidden />{p.hint}</span>}
                    <span className="block text-[11px] text-dim mt-0.5">{fmtDateTime(p.ts, { timeStyle: 'medium' })}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}
