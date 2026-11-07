import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button } from './ui';
import { History, RotateCcw, X, User, HardDrive, ArrowLeft } from 'lucide-react';

interface RevisionSummary {
  id: string;
  server_id: string;
  path: string;
  author_id: string | null;
  author_name: string;
  change_summary: string | null;
  bytes: number;
  created_at: string;
}

interface RevisionDetail extends RevisionSummary {
  content: string;
}

export function FileRevisionsModal({
  serverId,
  relPath,
  canWrite,
  onRollbackSuccess,
  onClose,
}: {
  serverId: string;
  relPath: string;
  canWrite: boolean;
  onRollbackSuccess: (restoredContent: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedRevId, setSelectedRevId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 1. Liste der Revisionen abrufen
  const { data, isLoading } = useQuery<{ ok: boolean; path: string; revisions: RevisionSummary[] }>({
    queryKey: ['fileRevisions', serverId, relPath],
    queryFn: () => api(`/servers/${serverId}/files/revisions?path=${encodeURIComponent(relPath)}`),
  });

  // 2. Einzelne Revision fuer die Vorschau abrufen
  const { data: detailData, isLoading: detailLoading } = useQuery<{ ok: boolean; revision: RevisionDetail }>({
    queryKey: ['fileRevisionDetail', serverId, selectedRevId],
    queryFn: () => api(`/servers/${serverId}/files/revisions/${selectedRevId}`),
    enabled: Boolean(selectedRevId),
  });

  // 3. Rollback Mutation
  const rollbackMut = useMutation({
    mutationFn: (revisionId: string) =>
      api<{ ok: boolean; path: string; restoredBytes: number }>(
        `/servers/${serverId}/files/revisions/${revisionId}/rollback`,
        { method: 'POST' }
      ),
    onSuccess: async () => {
      // Revisionsliste aktualisieren
      await queryClient.invalidateQueries({ queryKey: ['fileRevisions', serverId, relPath] });
      await queryClient.invalidateQueries({ queryKey: ['fileContent', serverId, relPath] });
      if (detailData?.revision?.content) {
        onRollbackSuccess(detailData.revision.content);
      }
      onClose();
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const revisions = data?.revisions ?? [];

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-3 sm:p-6 backdrop-blur-md">
      <div className="bg-rack-1 border border-seam rounded-xl shadow-2xl w-full max-w-4xl h-[75vh] flex flex-col overflow-hidden">
        {/* Kopfzeile */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-seam bg-rack-2/50 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <History className="size-4.5 text-emerald-400 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-ink">Versionshistorie</h3>
              <p className="text-xs text-dim font-mono truncate max-w-md">{relPath}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-dim hover:text-ink hover:bg-rack-2 transition-colors"
          >
            <X className="size-5" />
          </button>
        </div>

        {errorMsg && (
          <div className="px-5 py-2.5 bg-rose-500/10 border-b border-rose-500/20 text-rose-400 text-xs flex justify-between items-center">
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg(null)} className="hover:underline">
              Ausblenden
            </button>
          </div>
        )}

        {/* Inhalt */}
        <div className="flex-1 flex overflow-hidden">
          {/* Revisions-Liste links */}
          <div className="w-80 border-r border-seam overflow-y-auto bg-rack-0/40 p-3 space-y-2 shrink-0">
            {isLoading ? (
              <div className="text-center py-8 text-xs text-dim animate-pulse">Lade Versionen...</div>
            ) : revisions.length === 0 ? (
              <div className="text-center py-8 text-xs text-dim">
                Noch keine Revisionen für diese Datei gespeichert. Sie entstehen automatisch beim Speichern.
              </div>
            ) : (
              revisions.map((rev, index) => {
                const isSelected = selectedRevId === rev.id;
                const date = new Date(rev.created_at);
                const isLatest = index === 0;

                return (
                  <button
                    key={rev.id}
                    onClick={() => setSelectedRevId(rev.id)}
                    className={`w-full text-left p-3 rounded-lg border transition-all ${
                      isSelected
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-ink shadow-sm'
                        : 'bg-rack-1/60 border-seam hover:border-slate-700 text-dim hover:text-ink'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium text-ink flex items-center gap-1.5">
                        {date.toLocaleDateString('de-DE')}{' '}
                        <span className="text-dim text-[11px]">{date.toLocaleTimeString('de-DE')}</span>
                      </span>
                      {isLatest && (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[10px] font-bold">
                          Aktuell
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-dim mb-1">
                      <span className="flex items-center gap-1">
                        <User className="size-3" />
                        {rev.author_name}
                      </span>
                      <span className="flex items-center gap-1">
                        <HardDrive className="size-3" />
                        {(rev.bytes / 1024).toFixed(1)} KB
                      </span>
                    </div>
                    {rev.change_summary && (
                      <p className="text-[11px] text-slate-400 italic truncate">{rev.change_summary}</p>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Revisions-Vorschau rechts */}
          <div className="flex-1 flex flex-col bg-rack-1/30 overflow-hidden">
            {selectedRevId ? (
              detailLoading ? (
                <div className="flex-1 flex items-center justify-center text-xs text-dim animate-pulse">
                  Lade Inhalt der Version...
                </div>
              ) : detailData?.revision ? (
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-seam bg-rack-2/30 flex items-center justify-between shrink-0">
                    <div className="text-xs text-dim">
                      Stand vom{' '}
                      <span className="text-ink font-medium">
                        {new Date(detailData.revision.created_at).toLocaleString('de-DE')}
                      </span>{' '}
                      von <span className="text-ink">{detailData.revision.author_name}</span>
                    </div>

                    {canWrite && (
                      <Button
                        variant="primary"
                        className="h-7 text-xs px-2.5"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Möchtest du diese Datei wirklich auf den Stand vom ${new Date(
                                detailData.revision.created_at
                              ).toLocaleString('de-DE')} zurücksetzen? Der aktuelle Stand wird zuvor automatisch als Revision gesichert.`
                            )
                          ) {
                            rollbackMut.mutate(detailData.revision.id);
                          }
                        }}
                        disabled={rollbackMut.isPending}
                        busy={rollbackMut.isPending}
                      >
                        <RotateCcw className="size-3 mr-1" />
                        Diesen Stand wiederherstellen
                      </Button>
                    )}
                  </div>

                  <div className="flex-1 p-4 overflow-auto font-mono text-xs text-slate-300 bg-rack-0/70 select-text leading-relaxed">
                    <pre className="whitespace-pre-wrap">{detailData.revision.content}</pre>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-xs text-dim">
                  Version konnte nicht geladen werden.
                </div>
              )
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-dim space-y-2">
                <ArrowLeft className="size-6 text-slate-600 mb-1" />
                <p className="text-sm font-medium text-slate-400">Wähle links eine Version aus</p>
                <p className="text-xs max-w-sm">
                  Hier kannst du historische Stände der Konfigurationsdatei ansehen, vergleichen und mit einem Klick
                  wiederherstellen.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
