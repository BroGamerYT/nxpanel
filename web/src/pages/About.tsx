import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  Circle,
  HelpCircle,
  Sparkles,
  GitCommit,
  Clock,
  Search,
  BookOpen,
  Terminal,
  Cpu,
  HardDrive,
  Shield,
  Layers,
  ArrowRight,
  Zap,
  RotateCcw,
  Square,
  Play,
  FileCode,
  Archive,
  ExternalLink,
  FileText,
} from 'lucide-react';
import { api } from '../lib/api';
import { ErrorBox, Spinner, Led } from '../components/ui';
import { markVersionSeen, type About as AboutData, type DevlogEntry } from '../lib/version';
import { t, intlLocale } from '../lib/i18n';
import { Tooltip, InfoTip } from '../components/Tooltip';
import { DocsViewer } from '../components/DocsViewer';

/** `code` aus den Markdown-Dateien als Code darstellen, sonst reiner Text. */
function Text({ s }: { s: string }) {
  return (
    <>
      {s.split(/(`[^`]+`)/).map((p, i) =>
        p.startsWith('`') && p.endsWith('`') && p.length > 2 ? (
          <code key={i} className="font-mono text-[13px] bg-rack-2 border border-seam/60 rounded px-1 text-amber">
            {p.slice(1, -1)}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}

type TabKey = 'doku' | 'hilfe' | 'neu' | 'devlog' | 'geplant' | 'system';

function fmtDate(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return iso.length === 10
    ? d.toLocaleDateString(intlLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
    : d.toLocaleString(intlLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function About() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab') as TabKey | null;
  const isDocsPath = typeof window !== 'undefined' && window.location.pathname.startsWith('/docs');
  const isDefaultHelp = typeof window !== 'undefined' && window.location.pathname.startsWith('/hilfe');
  const [tab, setTabState] = useState<TabKey>(urlTab || (isDocsPath ? 'doku' : isDefaultHelp ? 'hilfe' : 'neu'));
  const [devlogSearch, setDevlogSearch] = useState('');
  const activeDoc = searchParams.get('doc') || 'architektur';

  const setTab = (newTab: TabKey) => {
    setTabState(newTab);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      return next;
    });
  };

  const selectDoc = (slug: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'doku');
      next.set('doc', slug);
      return next;
    });
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['about'],
    queryFn: () => api<AboutData>('/about'),
  });

  useEffect(() => {
    if (data) markVersionSeen(data.version);
  }, [data]);

  const filteredDevlog = useMemo(() => {
    if (!data?.devlog) return [];
    if (!devlogSearch.trim()) return data.devlog;
    const q = devlogSearch.toLowerCase();
    return data.devlog.filter(
      (e) =>
        e.text.toLowerCase().includes(q) ||
        e.date.toLowerCase().includes(q) ||
        e.time.toLowerCase().includes(q) ||
        e.files.toLowerCase().includes(q),
    );
  }, [data?.devlog, devlogSearch]);

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorBox>{(error as Error)?.message ?? t('common.notLoaded')}</ErrorBox>;

  const openCount = data.todo.reduce((n, s) => n + s.items.filter((i) => !i.done).length, 0);

  const TABS: Array<{ id: TabKey; label: string; icon: typeof HelpCircle; badge?: string | number }> = [
    { id: 'doku', label: 'Dokumentation (.md)', icon: FileText, badge: data.docs?.length },
    { id: 'hilfe', label: 'Hilfe & FAQ', icon: BookOpen },
    { id: 'neu', label: t('about.tabNew'), icon: Sparkles },
    { id: 'devlog', label: 'Entwickler-Log', icon: GitCommit, badge: data.devlog?.length },
    { id: 'geplant', label: t('about.tabPlanned'), icon: Clock, badge: openCount },
    { id: 'system', label: 'System & API', icon: Layers },
  ];

  return (
    <div className="max-w-5xl space-y-6">
      {/* Header mit NexusPanel Branding */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-seam pb-4">
        <div className="flex items-center gap-3.5">
          <img src="/logo.svg" alt="NexusPanel Logo" className="size-10 drop-shadow" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              NexusPanel <span className="font-mono text-amber text-lg">v{data.version}</span>
              {data.build && <span className="text-xs font-mono text-dim px-2 py-0.5 rounded bg-rack-2 border border-seam">Build {data.build}</span>}
            </h1>
            <p className="text-xs text-dim mt-0.5">
              {data.dev ? t('about.dev') : t('about.built', { build: data.build ?? '', date: fmtDate(data.builtAt) ?? '' })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <a
            href="https://ko-fi.com/brogameryt"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5E5B]/15 border border-[#FF5E5B]/40 text-xs font-medium text-[#FF5E5B] hover:bg-[#FF5E5B]/25 transition-colors"
            title="Projekt auf Ko-fi unterstützen"
          >
            ☕ Ko-fi
            <ExternalLink className="size-3" />
          </a>

          {/* Schnellsuche-Hinweis mit Tooltip */}
          <Tooltip content="Drücke jederzeit Strg+K auf der Tastatur, um die universelle Schnellsuche zu öffnen.">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rack-2/60 border border-seam text-xs text-dim">
              <span>Schnellsuche:</span>
              <kbd className="px-1.5 py-0.5 rounded bg-rack border border-seam font-mono text-ink">Strg K</kbd>
            </div>
          </Tooltip>
        </div>
      </div>

      {/* GitHub Update Benachrichtigung */}
      {data.update?.hasUpdate && (
        <div className="rounded-lg border border-amber/40 bg-amber/10 p-4 text-sm flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="font-semibold text-amber flex items-center gap-2">
              <span className="size-2 rounded-full bg-amber animate-pulse" />
              {t('about.updateTitle', { version: data.update.latestVersion ?? '' })}
            </div>
            <p className="text-ink/80 text-xs">
              {data.update.releaseName || t('about.updateDesc')}
            </p>
          </div>
          {data.update.releaseUrl && (
            <a
              href={data.update.releaseUrl}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-md bg-amber text-black font-medium text-xs hover:bg-amber/90 transition-colors inline-flex items-center gap-1"
            >
              {t('about.viewOnGithub')} &rarr;
            </a>
          )}
        </div>
      )}

      {/* Tabs */}
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-seam">
        {TABS.map(({ id, label, icon: Icon, badge }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 h-10 -mb-px border-b-2 text-sm font-medium transition-colors ${
              tab === id ? 'border-amber text-ink' : 'border-transparent text-dim hover:text-ink hover:border-seam'
            }`}
          >
            <Icon className="size-4" />
            <span>{label}</span>
            {badge !== undefined && (
              <span className="ml-1 text-[11px] font-mono px-1.5 py-0.2 rounded-full bg-rack-2 text-dim border border-seam">
                {badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* TAB 0: DOKUMENTATION (.md) */}
      {tab === 'doku' && (
        <div className="animate-in fade-in duration-150">
          <DocsViewer
            docs={data.docs ?? []}
            activeSlug={activeDoc}
            onSelectDoc={selectDoc}
          />
        </div>
      )}

      {/* TAB 1: HILFE & ANLEITUNGEN */}
      {tab === 'hilfe' && (
        <div className="space-y-8 animate-in fade-in duration-150">
          {/* Quick-Cards: Status & Symbole */}
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
              <BookOpen className="size-4 text-amber" />
              Status & Zustände verstehen
              <InfoTip text="Fahre mit der Maus über die Badges oder Buttons, um Erklärungen direkt als Tooltip zu sehen." />
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <Tooltip side="top" content="Server läuft stabil, akzeptiert Spieler-Verbindungen und ist vollständig spielbereit.">
                <div className="rounded-lg border border-seam bg-rack p-3 space-y-1.5 cursor-help hover:border-amber/50 transition-colors">
                  <div className="flex items-center gap-2 font-medium text-ink">
                    <Led status="running" /> Online (Läuft)
                  </div>
                  <p className="text-dim text-[11px]">Server ist betriebsbereit. Alle Ports sind freigegeben und erreichbar.</p>
                </div>
              </Tooltip>

              <Tooltip side="top" content="Server wird gestartet oder stoppt gerade sauber. Bitte keine harten Unterbrechungen vornehmen.">
                <div className="rounded-lg border border-seam bg-rack p-3 space-y-1.5 cursor-help hover:border-amber/50 transition-colors">
                  <div className="flex items-center gap-2 font-medium text-ink">
                    <Led status="starting" /> Startet / Stoppt
                  </div>
                  <p className="text-dim text-[11px]">SteamCMD-Prüfung oder Welt-Initialisierung aktiv. Gedulde dich kurz.</p>
                </div>
              </Tooltip>

              <Tooltip side="top" content="Server ist gestoppt. Er verbraucht 0% CPU und 0 MB RAM. Spieldaten sind sicher gespeichert.">
                <div className="rounded-lg border border-seam bg-rack p-3 space-y-1.5 cursor-help hover:border-amber/50 transition-colors">
                  <div className="flex items-center gap-2 font-medium text-ink">
                    <Led status="offline" /> Offline (Gestoppt)
                  </div>
                  <p className="text-dim text-[11px]">Kein laufender Docker-Container. Kann jederzeit neu gestartet werden.</p>
                </div>
              </Tooltip>

              <Tooltip side="top" content="Der Prozess hat sich unerwartet beendet. Prüfe die Konsole und die Zeitachse auf Fehler.">
                <div className="rounded-lg border border-seam bg-rack p-3 space-y-1.5 cursor-help hover:border-led-crash/50 transition-colors">
                  <div className="flex items-center gap-2 font-medium text-ink">
                    <Led status="crashed" /> Fehler / Crash
                  </div>
                  <p className="text-dim text-[11px]">Startfehler, Out-of-Memory oder defekte Config. Siehe Logdateien.</p>
                </div>
              </Tooltip>
            </div>
          </section>

          {/* Steuerung & Buttons */}
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
              <Zap className="size-4 text-amber" />
              Server-Aktionen & Steuerung
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="rounded-lg border border-seam bg-rack p-4 space-y-2">
                <div className="flex items-center gap-2 text-ink font-medium">
                  <Play className="size-4 text-emerald-400" />
                  <span>Starten & Aktualisieren</span>
                </div>
                <p className="text-dim leading-relaxed">
                  Startet den Docker-Container und führt automatische Updates von SteamCMD oder Minecraft-Jars durch. Wenn ein Modpack-Update bereitsteht, leuchtet der Aktualisieren-Button auf.
                </p>
              </div>

              <div className="rounded-lg border border-seam bg-rack p-4 space-y-2">
                <div className="flex items-center gap-2 text-ink font-medium">
                  <Square className="size-4 text-dim" />
                  <span>Sauberes Stoppen (Graceful Stop)</span>
                </div>
                <p className="text-dim leading-relaxed">
                  Sendet den nativen Stopp-Befehl (z. B. <code className="text-amber">stop</code> bei Minecraft) an die Konsole. Der Server speichert alle Chunks, Welten und Spielerdaten sauber ab.
                </p>
              </div>

              <div className="rounded-lg border border-seam bg-rack p-4 space-y-2">
                <div className="flex items-center gap-2 text-ink font-medium">
                  <RotateCcw className="size-4 text-sky-400" />
                  <span>Neu starten</span>
                </div>
                <p className="text-dim leading-relaxed">
                  Fährt den Server sauber herunter, wartet bis alle Daten geschrieben sind und startet ihn anschließend automatisch neu.
                </p>
              </div>

              <div className="rounded-lg border border-led-crash/30 bg-led-crash/5 p-4 space-y-2">
                <div className="flex items-center gap-2 text-led-crash font-medium">
                  <Zap className="size-4 text-led-crash" />
                  <span>Abwürgen (Kill / SIGKILL)</span>
                </div>
                <p className="text-dim leading-relaxed">
                  <strong className="text-led-crash font-medium">Notfall-Funktion:</strong> Beendet den Container sofort per SIGKILL ohne Wartezeit. Nur verwenden, wenn der Server eingefroren ist und nicht mehr reagiert.
                </p>
              </div>
            </div>
          </section>

          {/* Ressourcen & Auslastung */}
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
              <Cpu className="size-4 text-amber" />
              Ressourcen & Einheiten verstehen
            </h2>
            <div className="rounded-lg border border-seam bg-rack p-4 text-xs space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <span className="font-semibold text-ink flex items-center gap-1">
                    CPU (z. B. 400 %)
                    <InfoTip text="100% entspricht genau 1 voll ausgelasteten CPU-Kern (Thread). 400% = 4 Kerne." />
                  </span>
                  <p className="text-dim leading-relaxed">
                    Linux und Docker messen CPU-Last pro Kern: 100% bedeutet 1 voller Kern. 400% bedeutet, dass der Server bis zu 4 volle vCPU-Kerne nutzen darf.
                  </p>
                </div>

                <div className="space-y-1">
                  <span className="font-semibold text-ink flex items-center gap-1">
                    Arbeitsspeicher (RAM)
                    <InfoTip text="Der zugewiesene RAM wird vom Host reserviert und durch Linux cgroups begrenzt." />
                  </span>
                  <p className="text-dim leading-relaxed">
                    Zeigt den aktuellen Speicherverbrauch im Vergleich zum Maximum. Erreicht ein Server dauerhaft 100%, kann der Linux Out-Of-Memory-Killer zuschlagen.
                  </p>
                </div>

                <div className="space-y-1">
                  <span className="font-semibold text-ink flex items-center gap-1">
                    Speicherplatz (Disk)
                    <InfoTip text="Größe des Server-Datenordners auf der SSD der VM." />
                  </span>
                  <p className="text-dim leading-relaxed">
                    Belegter Speicherplatz für Welten, Mods, Logs und Spielstände. Überschreitet der Server das Limit, wird das Starten zur Sicherheit verhindert.
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Anleitungen: Backups & Dateimanager */}
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
              <Archive className="size-4 text-amber" />
              Wichtige Funktionen & Anleitungen
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="rounded-lg border border-seam bg-rack p-4 space-y-2">
                <div className="flex items-center gap-2 text-ink font-semibold">
                  <Archive className="size-4 text-amber" />
                  <span>Backups & UGREEN NAS Sicherung</span>
                </div>
                <p className="text-dim leading-relaxed">
                  Backups nutzen moderne <strong className="text-ink">Zstandard-Kompression (.tar.zst)</strong> mit SHA-256 Prüfsummen. Sie werden auf Knopfdruck oder über Zeitpläne vollautomatisch erstellt und auf das heimische UGREEN NAS gespiegelt. Bei einer Wiederherstellung holt sich das Panel die Daten bei Bedarf direkt vom NAS!
                </p>
              </div>

              <div className="rounded-lg border border-seam bg-rack p-4 space-y-2">
                <div className="flex items-center gap-2 text-ink font-semibold">
                  <FileCode className="size-4 text-sky-400" />
                  <span>Dateimanager & Revisions-Historie</span>
                </div>
                <p className="text-dim leading-relaxed">
                  Im Reiter <strong className="text-ink">Dateien</strong> können Konfigurationsdateien bearbeitet werden. Bei jeder Änderung erstellt NexusPanel automatisch einen internen Revisions-Snapshot (bis zu 25 Versionen). Bei Fehlkonfigurationen kannst du mit einem Klick auf eine frühere Version zurückspringen!
                </p>
              </div>

              <div className="rounded-lg border border-seam bg-rack p-4 space-y-2">
                <div className="flex items-center gap-2 text-ink font-semibold">
                  <Clock className="size-4 text-amber" />
                  <span>Automatische Zeitpläne (Schedules)</span>
                </div>
                <p className="text-dim leading-relaxed">
                  Unter <strong className="text-ink">Zeitpläne</strong> kannst du automatische Server-Aktionen einrichten: Regelmäßige Server-Neustarts um 04:00 Uhr morgens, tägliche Backups oder Konsolenbefehle (wie z. B. Nachrichtensendungen im Chat).
                </p>
              </div>

              <div className="rounded-lg border border-seam bg-rack p-4 space-y-2">
                <div className="flex items-center gap-2 text-ink font-semibold">
                  <Shield className="size-4 text-emerald-400" />
                  <span>Mitnutzer & Rechteverwaltung</span>
                </div>
                <p className="text-dim leading-relaxed">
                  Unter <strong className="text-ink">Mitnutzer</strong> kannst du Freunde oder Moderatoren einladen. Wähle aus fertigen Rollen-Presets (Zuschauer, Operator, Verwalter, Co-Admin) oder bestimme feingranular, wer Konsole lesen, Befehle senden oder Backups erstellen darf.
                </p>
              </div>
            </div>
          </section>

          {/* Tastaturkürzel */}
          <section className="rounded-lg border border-seam bg-rack-2/40 p-4 text-xs space-y-2">
            <h3 className="font-semibold text-ink flex items-center gap-2">
              <Terminal className="size-4 text-amber" />
              Tastaturkürzel & Schnelltasten
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-dim">
              <div className="flex items-center justify-between gap-2 p-2 rounded bg-rack border border-seam/60">
                <span>Globale Suche / Command Palette</span>
                <kbd className="px-2 py-0.5 rounded bg-rack-2 border border-seam font-mono text-ink text-[11px]">Strg K</kbd>
              </div>
              <div className="flex items-center justify-between gap-2 p-2 rounded bg-rack border border-seam/60">
                <span>Cache leeren & Panel neu laden</span>
                <kbd className="px-2 py-0.5 rounded bg-rack-2 border border-seam font-mono text-ink text-[11px]">Strg F5</kbd>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* TAB 2: CHANGELOG (WAS IST NEU) */}
      {tab === 'neu' && (
        <ol className="space-y-8 animate-in fade-in duration-150">
          {data.changelog.map((c) => (
            <li key={c.version} className="space-y-3">
              <h2 className="flex flex-wrap items-baseline gap-x-3">
                <span className={`font-mono font-semibold ${c.version === data.version ? 'text-amber' : 'text-ink'}`}>
                  v{c.version}
                </span>
                {c.title && <span className="font-medium text-ink">{c.title}</span>}
                {c.date && <span className="text-sm text-dim">{fmtDate(c.date)}</span>}
                {c.version === data.version && (
                  <span className="text-xs rounded-full bg-led-run/15 text-led-run px-2 py-0.5">
                    {t('about.current')}
                  </span>
                )}
              </h2>
              {c.sections.map((s) => (
                <div key={s.title}>
                  <h3 className="text-xs uppercase tracking-wide text-dim mb-1.5">{s.title}</h3>
                  <ul className="space-y-1.5 text-sm list-disc pl-5 marker:text-dim text-ink/90">
                    {s.items.map((i) => (
                      <li key={i}>
                        <Text s={i} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}

      {/* TAB 3: ENTWICKLER-LOG */}
      {tab === 'devlog' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-rack-2/40 border border-seam p-3 rounded-lg">
            <div className="text-xs text-dim">
              Detailliertes Protokoll aller implementierten Features, Optimierungen und Fixes.
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="size-3.5 text-dim absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={devlogSearch}
                onChange={(e) => setDevlogSearch(e.target.value)}
                placeholder="Log durchsuchen (z. B. RCON, Backup) …"
                className="w-full h-8 pl-8 pr-3 text-xs rounded-md bg-rack border border-seam text-ink placeholder:text-dim/60 focus:outline-none focus:border-amber"
              />
            </div>
          </div>

          {filteredDevlog.length === 0 ? (
            <div className="p-8 text-center text-sm text-dim">Keine passenden Einträge gefunden.</div>
          ) : (
            <div className="space-y-4">
              {filteredDevlog.map((entry, idx) => (
                <div
                  key={`${entry.date}-${entry.time}-${idx}`}
                  className="rounded-lg border border-seam bg-rack p-4 space-y-2 transition-all hover:border-seam/80"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 font-mono">
                      <span className="font-semibold text-amber">{entry.date}</span>
                      <span className="text-dim">·</span>
                      <span className="text-ink bg-rack-2 px-1.5 py-0.5 rounded border border-seam">{entry.time} Uhr</span>
                    </div>
                  </div>
                  <div className="text-sm text-ink/90 leading-relaxed">
                    <Text s={entry.text} />
                  </div>
                  {entry.files && (
                    <div className="pt-2 border-t border-seam/60 text-xs flex flex-wrap items-center gap-1.5 text-dim">
                      <span className="font-medium">Dateien:</span>
                      <span className="font-mono text-[11px] text-amber/80 break-all">{entry.files}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: GEPLANT & ROADMAP */}
      {tab === 'geplant' && (
        <div className="space-y-7 animate-in fade-in duration-150">
          {data.todo.map((s) => (
            <section key={s.title}>
              <h2 className="font-medium text-ink mb-2">{s.title}</h2>
              <ul className="rounded-lg border border-seam divide-y divide-seam text-sm bg-rack">
                {s.items.map((i) => (
                  <li key={i.text} className="flex items-start gap-3 px-4 py-2.5">
                    {i.done ? (
                      <CheckCircle2 className="size-4 text-led-run shrink-0 mt-0.5" aria-label={t('about.done')} />
                    ) : (
                      <Circle className="size-4 text-dim shrink-0 mt-0.5" aria-label={t('about.todo')} />
                    )}
                    <span className={`flex-1 ${i.done ? 'text-dim line-through opacity-70' : 'text-ink'}`}>
                      <Text s={i.text} />
                    </span>
                    {i.version && <span className="font-mono text-xs text-dim">{i.version}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* TAB 5: SYSTEM & API ARCHITEKTUR */}
      {tab === 'system' && (
        <div className="space-y-6 animate-in fade-in duration-150 text-sm">
          <div className="rounded-lg border border-seam bg-rack p-5 space-y-4">
            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
              <Layers className="size-4 text-amber" />
              NexusPanel Kern & Architektur
            </h2>
            <p className="text-dim text-xs leading-relaxed">
              NexusPanel wurde als leichtgewichtige, hochperformante Management-Plattform konzipiert. Alle Spiele laufen in isolierten, sicheren OCI-Docker-Containern mit automatisiertem Port- und Ressourcen-Management.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-md bg-rack-2/60 border border-seam space-y-1">
                <span className="font-semibold text-ink">Backend & Schnittstellen</span>
                <p className="text-dim">Node.js mit Fastify & TypeScript. Volle REST-API mit OpenAPI 3.1 & interaktivem Scalar API-Browser.</p>
              </div>
              <div className="p-3 rounded-md bg-rack-2/60 border border-seam space-y-1">
                <span className="font-semibold text-ink">Datenbank & Cache</span>
                <p className="text-dim">PostgreSQL 16 für persistente Instanzen, Berechtigungen und Zeitpläne; Redis 7 für Caching und Live-Events.</p>
              </div>
              <div className="p-3 rounded-md bg-rack-2/60 border border-seam space-y-1">
                <span className="font-semibold text-ink">Container-Laufzeit</span>
                <p className="text-dim">Docker Engine mit cgroups v2 für CPU- & RAM-Limits und iptables für Portweiterleitungen.</p>
              </div>
              <div className="p-3 rounded-md bg-rack-2/60 border border-seam space-y-1">
                <span className="font-semibold text-ink">Backup-Engine</span>
                <p className="text-dim">Streaming Zstandard (zstd) mit SHA-256 Prüfsummen und nativer NAS-Spiegelung.</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-seam bg-rack p-5 space-y-3">
            <h3 className="font-semibold text-ink flex items-center gap-2">
              <Terminal className="size-4 text-amber" />
              Entwickler-Schnittstelle (REST API & Dokumentation)
            </h3>
            <p className="text-dim text-xs leading-relaxed">
              Für Automatisierungsskripte, Bots oder Integrationen steht eine vollständige OpenAPI-Schnittstelle zur Verfügung:
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                href="/docs"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-rack-2 border border-seam text-xs text-ink hover:text-amber hover:border-amber/50 transition-colors"
              >
                <BookOpen className="size-3.5" />
                Interaktive Scalar API Dokumentation öffnen
                <ExternalLink className="size-3 ml-1" />
              </a>
              <a
                href="/api/v1/openapi.json"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-rack-2 border border-seam text-xs text-ink hover:text-amber hover:border-amber/50 transition-colors"
              >
                <FileCode className="size-3.5" />
                OpenAPI 3.1 JSON Spezifikation
                <ExternalLink className="size-3 ml-1" />
              </a>
            </div>
          </div>

          <div className="rounded-lg border border-seam bg-rack p-5 space-y-3">
            <h3 className="font-semibold text-ink flex items-center gap-2">
              <Sparkles className="size-4 text-amber" />
              Entwicklung, Test-Hardware & Unterstützung
            </h3>
            <p className="text-dim text-xs leading-relaxed">
              NexusPanel wird von <strong>BroGamerYT</strong> entwickelt und auf Bare-Metal- und Proxmox-Hardware getestet – mit tatkräftiger KI-Unterstützung durch <strong>Claude</strong> und <strong>Google Antigravity</strong> im Pair-Programming, während Konzeption, Architektur und Handarbeit im Live-Betrieb in eigener Hand liegen.
            </p>
            <div className="pt-1">
              <a
                href="https://ko-fi.com/brogameryt"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md bg-[#FF5E5B]/15 border border-[#FF5E5B]/40 text-xs font-medium text-[#FF5E5B] hover:bg-[#FF5E5B]/25 transition-colors"
              >
                ☕ NexusPanel auf Ko-fi unterstützen (ko-fi.com/brogameryt)
                <ExternalLink className="size-3.5" />
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
