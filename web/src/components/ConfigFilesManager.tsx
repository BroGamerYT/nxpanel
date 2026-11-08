import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sliders, FileCode, Save, AlertCircle, Check, FileText, FolderCog, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, ErrorBox, Spinner } from './ui';
import { ConfigFormEditor } from './ConfigFormEditor';

interface ConfigItem {
  path: string;
  name: string;
  exists: boolean;
  group?: string;
}

interface ConfigFilesManagerProps {
  serverId: string;
  canWrite: boolean;
  stopped: boolean;
}

export function ConfigFilesManager({ serverId, canWrite, stopped }: ConfigFilesManagerProps) {
  const qc = useQueryClient();

  // 1. Liste der Konfigurationsdateien abrufen
  const {
    data: configData,
    isLoading: loadingList,
    error: listError,
  } = useQuery<{ configs: ConfigItem[] }>({
    queryKey: ['serverConfigs', serverId],
    queryFn: () => api<{ configs: ConfigItem[] }>(`/servers/${serverId}/configs`),
  });

  const configs = configData?.configs ?? [];
  const mainConfigs = useMemo(() => configs.filter((c) => !c.group || c.group === 'main'), [configs]);
  const modConfigs = useMemo(() => configs.filter((c) => c.group && c.group !== 'main'), [configs]);
  const modGroups = useMemo(() => [...new Set(modConfigs.map((c) => c.group!))], [modConfigs]);

  const [activePath, setActivePath] = useState<string>('');
  const [modFilterGroup, setModFilterGroup] = useState<string>('all');
  const [modSearch, setModSearch] = useState<string>('');
  const [showAllMods, setShowAllMods] = useState(false);
  const [viewMode, setViewMode] = useState<'form' | 'code'>('form');
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const filteredMods = useMemo(() => {
    const q = modSearch.trim().toLowerCase();
    return modConfigs.filter((c) => {
      if (modFilterGroup !== 'all' && c.group !== modFilterGroup) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q);
    });
  }, [modConfigs, modFilterGroup, modSearch]);

  // Sobald Config-Liste geladen ist, erste Datei vorauswaehlen
  useEffect(() => {
    if (configs.length > 0 && !activePath) {
      const firstExisting = configs.find((c) => c.exists) ?? configs[0];
      if (firstExisting) {
        setActivePath(firstExisting.path);
      }
    }
  }, [configs, activePath]);

  // 2. Inhalt der aktiven Datei laden
  const {
    data: fileData,
    isLoading: loadingContent,
    error: contentError,
  } = useQuery<{ content: string; size: number }>({
    queryKey: ['fileContent', serverId, activePath],
    queryFn: () =>
      api<{ content: string; size: number }>(
        `/servers/${serverId}/files/content?path=${encodeURIComponent(activePath)}`
      ),
    enabled: !!activePath,
    staleTime: 0,
  });

  useEffect(() => {
    if (fileData) {
      setContent(fileData.content);
      setInitialContent(fileData.content);
      setDirty(false);
      setErrorMsg(null);
    }
  }, [fileData]);

  useEffect(() => {
    if (contentError) {
      setErrorMsg((contentError as Error).message);
    }
  }, [contentError]);

  // 3. Speichern-Mutation
  const saveMut = useMutation({
    mutationFn: () =>
      api(`/servers/${serverId}/files/content`, {
        method: 'PUT',
        body: { path: activePath, content },
      }),
    onSuccess: () => {
      setInitialContent(content);
      setDirty(false);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2500);
      void qc.invalidateQueries({ queryKey: ['fileContent', serverId, activePath] });
      void qc.invalidateQueries({ queryKey: ['serverConfigs', serverId] });
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  // Vor Dateiewechsel auf ungespeicherte Aenderungen pruefen
  const handleSelectConfig = (path: string) => {
    if (dirty && !window.confirm(t('files.unsavedWarning'))) {
      return;
    }
    setActivePath(path);
  };

  if (loadingList) {
    return (
      <div className="py-12 flex justify-center">
        <Spinner />
      </div>
    );
  }

  if (listError) {
    return <ErrorBox>{(listError as Error).message}</ErrorBox>;
  }

  if (configs.length === 0) {
    return (
      <div className="rounded-lg border border-seam bg-rack-1/50 p-6 text-center text-dim text-sm">
        <FileText className="size-8 text-dim mx-auto mb-2 opacity-50" />
        <p>Für dieses Spiel wurden keine Standard-Konfigurationsdateien hinterlegt.</p>
        <p className="text-xs mt-1 text-dim/80">
          Du kannst alle Spieldateien wie gewohnt im Reiter „Dateien“ bearbeiten.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Hinweis zum Serverstopp */}
      {!stopped && (
        <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0" />
            <span>
              Tipp: Änderungen an Konfigurationsdateien greifen oft erst nach einem Server-Neustart.
            </span>
          </div>
        </div>
      )}

      {/* Haupt-Konfigurationsdateien Tabs */}
      {mainConfigs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-seam pb-3">
          {mainConfigs.map((cfg) => {
            const isActive = cfg.path === activePath;
            return (
              <button
                key={cfg.path}
                type="button"
                onClick={() => handleSelectConfig(cfg.path)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono transition border ${
                  isActive
                    ? 'bg-amber text-black border-amber font-semibold shadow'
                    : 'bg-rack-1/80 text-dim border-seam hover:text-ink hover:bg-rack-2'
                }`}
              >
                <FileCode className="size-3.5" />
                <span>{cfg.name}</span>
                {!cfg.exists && (
                  <span className="text-[10px] px-1 py-0.2 rounded bg-rack-2/70 text-dim">neu</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Mod- & Plugin-Konfigurationsordner (z. B. config/, defaultconfigs/, serverconfig/, BepInEx/config/) */}
      {modConfigs.length > 0 && (
        <div className="rounded-lg border border-seam bg-rack p-3 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-ink">
              <FolderCog className="size-4 text-amber" />
              <span>Mod- & Plugin-Konfigurationen ({modConfigs.length})</span>
            </div>
            {modGroups.length > 1 && (
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setModFilterGroup('all')}
                  className={`px-2 py-0.5 rounded text-[11px] font-mono transition ${
                    modFilterGroup === 'all'
                      ? 'bg-amber text-black font-semibold'
                      : 'bg-rack-2 text-dim hover:text-ink'
                  }`}
                >
                  Alle ({modConfigs.length})
                </button>
                {modGroups.map((grp) => {
                  const count = modConfigs.filter((c) => c.group === grp).length;
                  return (
                    <button
                      key={grp}
                      type="button"
                      onClick={() => setModFilterGroup(grp)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono transition ${
                        modFilterGroup === grp
                          ? 'bg-amber text-black font-semibold'
                          : 'bg-rack-2 text-dim hover:text-ink'
                      }`}
                    >
                      {grp}/ ({count})
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="relative">
            <Search className="size-3.5 text-dim absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={modSearch}
              onChange={(e) => setModSearch(e.target.value)}
              placeholder="Mod- oder Plugin-Config suchen (z. B. ftbchunks, mekanism, create, voicechat) …"
              className="w-full bg-rack-2 border border-seam rounded pl-8 pr-7 py-1.5 text-xs text-ink placeholder:text-dim/60 focus:outline-none focus:border-amber"
            />
            {modSearch && (
              <button
                type="button"
                onClick={() => setModSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-dim hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="max-h-44 overflow-y-auto flex flex-wrap gap-1.5 pt-0.5">
            {filteredMods.length === 0 ? (
              <span className="text-xs text-dim py-1">Keine passende Mod-Konfiguration gefunden.</span>
            ) : (
              <>
                {(showAllMods || modSearch.trim() ? filteredMods : filteredMods.slice(0, 150)).map((cfg) => {
                  const isActive = cfg.path === activePath;
                  return (
                    <button
                      key={cfg.path}
                      type="button"
                      onClick={() => handleSelectConfig(cfg.path)}
                      title={cfg.path}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono transition border ${
                        isActive
                          ? 'bg-amber text-black border-amber font-semibold shadow'
                          : 'bg-rack-2/70 text-dim border-seam hover:text-ink hover:bg-rack-2'
                      }`}
                    >
                      <FileCode className="size-3 shrink-0" />
                      <span className="truncate max-w-[260px]">
                        {modFilterGroup === 'all' && modGroups.length > 1 ? `${cfg.group}/${cfg.name}` : cfg.name}
                      </span>
                    </button>
                  );
                })}
                {!showAllMods && !modSearch.trim() && filteredMods.length > 150 && (
                  <button
                    type="button"
                    onClick={() => setShowAllMods(true)}
                    className="px-2.5 py-1 rounded text-xs font-medium bg-amber/15 text-amber border border-amber/30 hover:bg-amber/25"
                  >
                    + {filteredMods.length - 150} weitere anzeigen (oder oben suchen)
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Editor & Steuerungsleiste */}
      <div className="border border-seam rounded-xl overflow-hidden bg-rack-1 shadow-md flex flex-col min-h-[500px]">
        {/* Kopfzeile */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-seam bg-rack-2/40">
          <div className="flex items-center gap-2 min-w-0">
            <Sliders className="size-4 text-emerald-400 shrink-0" />
            <span className="font-mono text-xs text-ink truncate font-medium">{activePath}</span>
            {dirty && (
              <span className="size-2 rounded-full bg-amber shrink-0" title="Ungespeichert" />
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* Umschalter Formular / Code */}
            <div className="flex items-center bg-rack-2/80 p-0.5 rounded-lg border border-seam text-xs">
              <button
                type="button"
                onClick={() => setViewMode('form')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded transition ${
                  viewMode === 'form'
                    ? 'bg-amber text-black font-semibold shadow'
                    : 'text-dim hover:text-ink'
                }`}
              >
                <Sliders className="size-3" />
                Formular
              </button>
              <button
                type="button"
                onClick={() => setViewMode('code')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded transition ${
                  viewMode === 'code'
                    ? 'bg-amber text-black font-semibold shadow'
                    : 'text-dim hover:text-ink'
                }`}
              >
                <FileCode className="size-3" />
                Code
              </button>
            </div>

            {savedSuccess && (
              <span className="text-xs text-emerald-400 font-medium flex items-center gap-1 animate-pulse">
                <Check className="size-3.5" /> Gespeichert
              </span>
            )}

            {canWrite && (
              <Button
                variant="primary"
                className="h-8 text-xs px-3"
                onClick={() => saveMut.mutate()}
                disabled={!dirty || saveMut.isPending}
                busy={saveMut.isPending}
              >
                <Save className="size-3.5 mr-1" />
                Speichern
              </Button>
            )}
          </div>
        </div>

        {errorMsg && (
          <div className="p-3 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs">
            {errorMsg}
          </div>
        )}

        {/* Editor Bereich */}
        <div className="flex-1 flex flex-col bg-rack-1/60 overflow-hidden">
          {loadingContent ? (
            <div className="py-20 flex justify-center items-center">
              <Spinner />
            </div>
          ) : viewMode === 'form' ? (
            <ConfigFormEditor
              content={content}
              filename={activePath}
              disabled={!canWrite}
              onChange={(next) => {
                setContent(next);
                setDirty(next !== initialContent);
              }}
            />
          ) : (
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(e.target.value !== initialContent);
              }}
              disabled={!canWrite}
              placeholder="Dateiinhalt..."
              spellCheck={false}
              className="flex-1 w-full bg-black/40 p-4 font-mono text-xs sm:text-sm text-ink/90 leading-relaxed resize-none focus:outline-none min-h-[420px]"
            />
          )}
        </div>
      </div>
    </div>
  );
}
