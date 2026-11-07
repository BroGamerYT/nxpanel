import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sliders, FileCode, Save, RefreshCw, AlertCircle, Check, FileText } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, ErrorBox, Spinner } from './ui';
import { ConfigFormEditor } from './ConfigFormEditor';

interface ConfigItem {
  path: string;
  name: string;
  exists: boolean;
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
    refetch: refetchList,
  } = useQuery<{ configs: ConfigItem[] }>({
    queryKey: ['serverConfigs', serverId],
    queryFn: () => api<{ configs: ConfigItem[] }>(`/servers/${serverId}/configs`),
  });

  const configs = configData?.configs ?? [];
  const [activePath, setActivePath] = useState<string>('');
  const [viewMode, setViewMode] = useState<'form' | 'code'>('form');
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
    refetch: refetchContent,
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

      {/* Dateiauswahl Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-seam pb-3">
        {configs.map((cfg) => {
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
