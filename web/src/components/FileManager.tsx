import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Folder,
  FolderPlus,
  File,
  FileText,
  FileCode,
  FileArchive,
  Upload,
  Download,
  Trash,
  Pencil,
  RefreshCw,
  X,
  Save,
  Plus,
  Search,
  ChevronRight,
  Archive,
  History,
  Sparkles,
  Code2,
  Eye,
  Sliders,
  HardDrive,
  Copy,
  Check,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { FileRevisionsModal } from './FileRevisionsModal';
import { MarkdownViewer } from './MarkdownViewer';
import { ConfigFormEditor } from './ConfigFormEditor';
import { api, currentToken, refreshSession } from '../lib/api';
import { t } from '../lib/i18n';
import type { FileEntry, DirectoryListing } from '../lib/types';
import { Button, ErrorBox, Spinner } from './ui';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function getFileIcon(name: string, isDir: boolean) {
  if (isDir) {
    return <Folder className="size-4.5 text-amber shrink-0" />;
  }
  const lower = name.toLowerCase();
  if (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar.zst')
  ) {
    return <FileArchive className="size-4.5 text-purple-400 shrink-0" />;
  }
  if (
    lower.endsWith('.json') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.properties') ||
    lower.endsWith('.cfg') ||
    lower.endsWith('.toml') ||
    lower.endsWith('.ini') ||
    lower.endsWith('.xml') ||
    lower.endsWith('.sh') ||
    lower.endsWith('.bat')
  ) {
    return <FileCode className="size-4.5 text-emerald-400 shrink-0" />;
  }
  if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.md')) {
    return <FileText className="size-4.5 text-blue-400 shrink-0" />;
  }
  return <File className="size-4.5 text-dim shrink-0" />;
}

export function FileManager({
  serverId,
  serverShortId,
  permissions,
  apiBase,
}: {
  serverId: string;
  serverShortId?: string;
  permissions: string[];
  /** Andere Datei-API, z. B. /admin/files/panel-daten (Admin-Dateimanager). Ohne: Dateien des Servers. */
  apiBase?: string;
}) {
  const { me } = useAuth();
  const filesBase = apiBase ?? `/servers/${serverId}/files`;
  const qc = useQueryClient();
  const [currentPath, setCurrentPath] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dialog-Zustände
  const [showSftpModal, setShowSftpModal] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFileModal, setShowNewFileModal] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const canRead = permissions.includes('file.read');
  const canWrite = permissions.includes('file.write');
  const canDelete = permissions.includes('file.delete');
  const canArchive = permissions.includes('file.archive');

  // Ordnerinhalt laden
  const { data, isLoading, error, refetch, isFetching } = useQuery<DirectoryListing>({
    queryKey: ['files', serverId, currentPath],
    queryFn: () =>
      api<DirectoryListing>(
        `${filesBase}?path=${encodeURIComponent(currentPath)}`
      ),
    enabled: canRead,
  });

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['files', serverId, currentPath] });
  }, [qc, serverId, currentPath]);

  // Breadcrumbs
  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    return currentPath.split('/').filter(Boolean);
  }, [currentPath]);

  const navigateTo = (path: string) => {
    setCurrentPath(path.replace(/^\/+/, '').replace(/\/+$/, ''));
    setFilterQuery('');
  };

  const navigateBreadcrumb = (index: number) => {
    if (index === -1) {
      navigateTo('');
    } else {
      const parts = breadcrumbs.slice(0, index + 1);
      navigateTo(parts.join('/'));
    }
  };

  // Gefilterte Einträge
  const entries = useMemo(() => {
    const list = data?.entries || [];
    if (!filterQuery.trim()) return list;
    const q = filterQuery.toLowerCase();
    return list.filter((e) => e.name.toLowerCase().includes(q));
  }, [data, filterQuery]);

  // Datei-Aktionen Mutations
  const createFolderMut = useMutation({
    mutationFn: (name: string) =>
      api(`${filesBase}/directory`, {
        method: 'POST',
        body: { path: currentPath ? `${currentPath}/${name}` : name },
      }),
    onSuccess: () => {
      setShowNewFolderModal(false);
      setNewFolderName('');
      invalidate();
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const renameMut = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api(`${filesBase}/rename`, {
        method: 'POST',
        body: { from, to },
      }),
    onSuccess: () => {
      setRenameTarget(null);
      setRenameValue('');
      invalidate();
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: (path: string) =>
      api(`${filesBase}`, {
        method: 'DELETE',
        body: { path },
      }),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const decompressMut = useMutation({
    mutationFn: (path: string) =>
      api(`${filesBase}/decompress`, {
        method: 'POST',
        body: { path, destination: currentPath },
      }),
    onSuccess: () => invalidate(),
    onError: (err) => setErrorMsg((err as Error).message),
  });

  // Datei-Upload per FormData
  const handleUploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !canWrite) return;
    setUploading(true);
    setErrorMsg(null);

    try {
      await refreshSession();
      const token = currentToken();

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file) continue;
        const fd = new FormData();
        fd.append('file', file);

        const res = await fetch(
          `/api/v1${filesBase}/upload?path=${encodeURIComponent(
            currentPath
          )}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
          }
        );

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || `Upload fehlgeschlagen für ${file.name}`);
        }
      }
      invalidate();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Datei herunterladen
  const handleDownload = async (path: string, filename: string) => {
    try {
      await refreshSession();
      const res = await fetch(
        `/api/v1${filesBase}/download?path=${encodeURIComponent(path)}`,
        { headers: { Authorization: `Bearer ${currentToken()}` } }
      );
      if (!res.ok) throw new Error('Download fehlgeschlagen');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  // Drag & Drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files) {
      void handleUploadFiles(e.dataTransfer.files);
    }
  };

  if (!canRead) {
    return <p className="text-sm text-dim">Keine Leseberechtigung für das Dateisystem.</p>;
  }

  return (
    <div
      className="space-y-4 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Upload Drag Overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-rack-1/90 border-2 border-dashed border-amber z-20 flex flex-col items-center justify-center rounded-lg pointer-events-none p-6">
          <Upload className="size-12 text-amber animate-bounce mb-3" />
          <p className="text-lg font-medium text-ink">{t('files.dropzone')}</p>
        </div>
      )}

      {/* Editor Modal */}
      {editingFile && (
        <FileEditorModal
          serverId={serverId}
          filesBase={filesBase}
          revisions={!apiBase}
          relPath={editingFile}
          canWrite={canWrite}
          onClose={() => {
            setEditingFile(null);
            invalidate();
          }}
        />
      )}

      {errorMsg && (
        <div className="relative">
          <ErrorBox>{errorMsg}</ErrorBox>
          <button onClick={() => setErrorMsg(null)} className="absolute right-3 top-2.5 text-dim hover:text-ink text-xs">✕</button>
        </div>
      )}
      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {/* Kopfbereich: Pfad & Aktionen */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        {/* Breadcrumb-Navigation */}
        <div className="flex items-center gap-1.5 text-sm overflow-x-auto max-w-full py-1">
          <button
            onClick={() => navigateBreadcrumb(-1)}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-rack-2/70 text-dim hover:text-ink font-mono text-xs"
          >
            /
          </button>
          {breadcrumbs.map((part, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <ChevronRight className="size-3.5 text-dim/60 shrink-0" />
              <button
                onClick={() => navigateBreadcrumb(idx)}
                className={`px-2 py-1 rounded hover:bg-rack-2/70 font-mono text-xs truncate max-w-40 ${
                  idx === breadcrumbs.length - 1
                    ? 'text-ink font-semibold bg-rack-2/40'
                    : 'text-dim hover:text-ink'
                }`}
              >
                {part}
              </button>
            </div>
          ))}
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="p-1 rounded text-dim hover:text-ink hover:bg-rack-2/70 ml-1"
            title="Neu laden"
          >
            <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Aktionsleiste */}
        <div className="flex items-center gap-2 shrink-0">
          {!apiBase && (
            <Button
              variant="quiet"
              className="h-8 text-xs px-2.5 text-amber hover:text-amber"
              onClick={() => setShowSftpModal(true)}
              title="SFTP-Zugangsdaten anzeigen"
            >
              <HardDrive className="size-3.5 mr-1.5" />
              SFTP
            </Button>
          )}
          {canWrite && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => void handleUploadFiles(e.target.files)}
              />
              <Button
                variant="quiet"
                className="h-8 text-xs px-2.5"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                <Upload className="size-3.5 mr-1.5" />
                {uploading ? t('files.uploading') : t('files.upload')}
              </Button>
              <Button
                variant="quiet"
                className="h-8 text-xs px-2.5"
                onClick={() => setShowNewFolderModal(true)}
              >
                <FolderPlus className="size-3.5 mr-1.5" />
                {t('files.newFolder')}
              </Button>
              <Button
                variant="primary"
                className="h-8 text-xs px-2.5"
                onClick={() => setShowNewFileModal(true)}
              >
                <Plus className="size-3.5 mr-1.5" />
                {t('files.newFile')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Filter / Suchleiste */}
      <div className="relative">
        <Search className="size-4 text-dim absolute left-3 top-2.5 pointer-events-none" />
        <input
          type="text"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder={t('files.search')}
          className="w-full bg-rack-1 border border-seam rounded-md pl-9 pr-3 py-1.5 text-sm text-ink placeholder:text-dim/60 focus:outline-none focus:border-amber"
        />
        {filterQuery && (
          <button
            onClick={() => setFilterQuery('')}
            className="absolute right-3 top-2.5 text-dim hover:text-ink"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Dateiliste */}
      <div className="border border-seam rounded-lg overflow-hidden bg-rack-1/50">
        {isLoading ? (
          <div className="py-12 flex justify-center">
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <div className="py-12 text-center text-dim text-sm">{t('files.empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-rack-2/40 border-b border-seam text-xs text-dim font-medium uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-4">{t('files.name')}</th>
                  <th className="py-2.5 px-4 w-28 text-right">{t('files.size')}</th>
                  <th className="py-2.5 px-4 w-44 hidden sm:table-cell text-right">
                    {t('files.modified')}
                  </th>
                  <th className="py-2.5 px-4 w-32 text-right">{t('files.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-seam">
                {entries.map((entry) => {
                  const isArchive =
                    !entry.is_directory &&
                    /\.(zip|tar|tar\.gz|tgz|tar\.zst)$/i.test(entry.name);
                  return (
                    <tr
                      key={entry.path}
                      className="hover:bg-rack-2/30 transition-colors group"
                    >
                      {/* Name */}
                      <td className="py-2 px-4 flex items-center gap-2.5">
                        {getFileIcon(entry.name, entry.is_directory)}
                        {entry.is_directory ? (
                          <button
                            onClick={() => navigateTo(entry.path)}
                            className="font-mono text-sm text-ink hover:text-amber font-medium truncate text-left"
                          >
                            {entry.name}
                            {entry.label && <span className={`ml-2 font-sans font-normal text-xs ${entry.orphan ? 'text-dim italic' : 'text-amber/90'}`}>{entry.label}</span>}
                          </button>
                        ) : (
                          <button
                            onClick={() => setEditingFile(entry.path)}
                            className="font-mono text-sm text-ink/90 hover:text-amber truncate text-left"
                          >
                            {entry.name}
                          </button>
                        )}
                      </td>

                      {/* Größe */}
                      <td className="py-2 px-4 text-xs font-mono text-dim text-right tabular-nums">
                        {entry.is_directory ? '-' : formatBytes(entry.size)}
                      </td>

                      {/* Geändert */}
                      <td className="py-2 px-4 text-xs text-dim text-right hidden sm:table-cell whitespace-nowrap">
                        {formatDate(entry.modified_at)}
                      </td>

                      {/* Aktionen */}
                      <td className="py-2 px-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {!entry.is_directory && (
                            <button
                              onClick={() => handleDownload(entry.path, entry.name)}
                              title={t('files.download')}
                              className="p-1 rounded text-dim hover:text-ink hover:bg-rack-2/60"
                            >
                              <Download className="size-4" />
                            </button>
                          )}
                          {isArchive && canArchive && (
                            <button
                              onClick={() => decompressMut.mutate(entry.path)}
                              title={t('files.decompress')}
                              disabled={decompressMut.isPending}
                              className="p-1 rounded text-dim hover:text-purple-400 hover:bg-rack-2/60"
                            >
                              <Archive className="size-4" />
                            </button>
                          )}
                          {canWrite && (
                            <button
                              onClick={() => {
                                setRenameTarget(entry);
                                setRenameValue(entry.name);
                              }}
                              title={t('files.rename')}
                              className="p-1 rounded text-dim hover:text-ink hover:bg-rack-2/60"
                            >
                              <Pencil className="size-4" />
                            </button>
                          )}
                          {canDelete && (
                            <button
                              onClick={() => setDeleteTarget(entry)}
                              title={t('files.delete')}
                              className="p-1 rounded text-dim hover:text-red-400 hover:bg-rack-2/60"
                            >
                              <Trash className="size-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: Neuer Ordner */}
      {showNewFolderModal && (
        <SimpleInputModal
          title={t('files.newFolder')}
          label={t('files.newFolderPrompt')}
          value={newFolderName}
          onChange={setNewFolderName}
          onSubmit={() => createFolderMut.mutate(newFolderName)}
          onClose={() => setShowNewFolderModal(false)}
          busy={createFolderMut.isPending}
        />
      )}

      {/* Modal: Neue Datei */}
      {showNewFileModal && (
        <SimpleInputModal
          title={t('files.newFile')}
          label={t('files.newFilePrompt')}
          value={newFileName}
          onChange={setNewFileName}
          onSubmit={() => {
            const path = currentPath ? `${currentPath}/${newFileName}` : newFileName;
            setShowNewFileModal(false);
            setNewFileName('');
            setEditingFile(path);
          }}
          onClose={() => setShowNewFileModal(false)}
        />
      )}

      {/* Modal: Umbenennen */}
      {renameTarget && (
        <SimpleInputModal
          title={t('files.rename')}
          label={t('files.renamePrompt', { name: renameTarget.name })}
          value={renameValue}
          onChange={setRenameValue}
          onSubmit={() => {
            const parent = currentPath;
            const to = parent ? `${parent}/${renameValue}` : renameValue;
            renameMut.mutate({ from: renameTarget.path, to });
          }}
          onClose={() => setRenameTarget(null)}
          busy={renameMut.isPending}
        />
      )}

      {/* Modal: Löschen Bestätigung */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-rack-1 border border-seam rounded-lg p-5 max-w-md w-full shadow-xl space-y-4">
            <h3 className="text-base font-semibold text-ink">{t('files.delete')}</h3>
            <p className="text-sm text-dim">
              {t('files.deleteConfirm', { name: deleteTarget.name })}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="quiet" className="h-8 text-xs px-3" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                className="h-8 text-xs px-3"
                onClick={() => deleteMut.mutate(deleteTarget.path)}
                busy={deleteMut.isPending}
              >
                {t('files.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* SFTP Zugangsdaten Modal */}
      {showSftpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg bg-rack border border-seam rounded-2xl p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-ink flex items-center gap-2">
                <HardDrive className="size-5 text-amber" />
                SFTP-Zugangsdaten
              </h3>
              <button
                type="button"
                onClick={() => setShowSftpModal(false)}
                className="text-dim hover:text-ink text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-dim leading-relaxed">
              Verbinde dich mit jedem SFTP-Client (z. B. FileZilla, WinSCP, Cyberduck oder VSCode), um Dateien schnell per Drag & Drop hoch- und herunterzuladen.
            </p>

            <div className="space-y-3 font-mono text-xs">
              <div className="p-3 rounded-xl bg-rack-2 border border-seam flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-dim uppercase tracking-wider font-sans font-semibold">SFTP Host / Server</div>
                  <div className="text-ink font-semibold mt-0.5">{window.location.hostname}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(window.location.hostname);
                    setCopiedField('host');
                    setTimeout(() => setCopiedField(null), 2000);
                  }}
                  className="p-1.5 rounded hover:bg-rack text-dim hover:text-ink"
                  title="Host kopieren"
                >
                  {copiedField === 'host' ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-rack-2 border border-seam flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-dim uppercase tracking-wider font-sans font-semibold">Port</div>
                    <div className="text-ink font-semibold mt-0.5">2022</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText('2022');
                      setCopiedField('port');
                      setTimeout(() => setCopiedField(null), 2000);
                    }}
                    className="p-1.5 rounded hover:bg-rack text-dim hover:text-ink"
                    title="Port kopieren"
                  >
                    {copiedField === 'port' ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                  </button>
                </div>

                <div className="p-3 rounded-xl bg-rack-2 border border-seam flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-dim uppercase tracking-wider font-sans font-semibold">Passwort</div>
                    <div className="text-ink font-sans text-xs mt-0.5">Dein NexusPanel Passwort</div>
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-rack-2 border border-seam flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-dim uppercase tracking-wider font-sans font-semibold">Benutzername</div>
                  <div className="text-ink font-semibold mt-0.5">
                    {me?.user.username}.{serverShortId || serverId}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const u = `${me?.user.username}.${serverShortId || serverId}`;
                    navigator.clipboard.writeText(u);
                    setCopiedField('user');
                    setTimeout(() => setCopiedField(null), 2000);
                  }}
                  className="p-1.5 rounded hover:bg-rack text-dim hover:text-ink"
                  title="Benutzername kopieren"
                >
                  {copiedField === 'user' ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                </button>
              </div>

              <div className="p-3 rounded-xl bg-rack-2 border border-seam flex items-center justify-between">
                <div className="truncate mr-2">
                  <div className="text-[10px] text-dim uppercase tracking-wider font-sans font-semibold">SFTP-Adresse (1-Klick FileZilla)</div>
                  <div className="text-amber truncate text-[11px] mt-0.5">
                    sftp://{me?.user.username}.{serverShortId || serverId}@{window.location.hostname}:2022/
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const url = `sftp://${me?.user.username}.${serverShortId || serverId}@${window.location.hostname}:2022/`;
                    navigator.clipboard.writeText(url);
                    setCopiedField('url');
                    setTimeout(() => setCopiedField(null), 2000);
                  }}
                  className="p-1.5 rounded hover:bg-rack text-dim hover:text-ink shrink-0"
                  title="Komplette URL kopieren"
                >
                  {copiedField === 'url' ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                </button>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button variant="primary" onClick={() => setShowSftpModal(false)}>
                Schließen
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getFileLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['json'].includes(ext)) return 'JSON';
  if (['yml', 'yaml'].includes(ext)) return 'YAML';
  if (['properties', 'env'].includes(ext)) return 'PROPERTIES';
  if (['ini', 'cfg', 'conf'].includes(ext)) return 'INI';
  if (['toml'].includes(ext)) return 'TOML';
  if (['xml'].includes(ext)) return 'XML';
  if (['lua'].includes(ext)) return 'LUA';
  if (['sh', 'bash'].includes(ext)) return 'SHELL';
  if (['bat', 'cmd'].includes(ext)) return 'BATCH';
  if (['js', 'ts', 'jsx', 'tsx'].includes(ext)) return 'JAVASCRIPT';
  return 'TEXT';
}

/**
 * Text-/Config-Datei Editor Modal (Code-Editor mit Zeilennummern, Syntaxerkennung & Suche)
 */
function FileEditorModal({
  serverId,
  filesBase,
  revisions = true,
  relPath,
  canWrite,
  onClose,
}: {
  serverId: string;
  filesBase: string;
  /** Versionshistorie gibt es nur fuer Server-Dateien */
  revisions?: boolean;
  relPath: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showRevisions, setShowRevisions] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const isMarkdown = relPath.toLowerCase().endsWith('.md');
  const [mdPreview, setMdPreview] = useState(false);

  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lang = getFileLanguage(relPath);
  const isConfigFile = ['TOML', 'INI', 'PROPERTIES', 'YAML', 'JSON'].includes(lang);
  const [viewMode, setViewMode] = useState<'form' | 'code'>(() =>
    ['TOML', 'INI', 'PROPERTIES', 'YAML'].includes(getFileLanguage(relPath)) ? 'form' : 'code'
  );
  const lines = useMemo(() => content.split('\n'), [content]);
  const lineCount = lines.length;

  // Synchrones Scrollen zwischen Zeilennummern und Textarea
  const handleScroll = () => {
    if (lineNumbersRef.current && textareaRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const updateCursorPosition = (target: HTMLTextAreaElement) => {
    const textBefore = target.value.substring(0, target.selectionStart);
    const line = textBefore.split('\n').length;
    const col = textBefore.length - textBefore.lastIndexOf('\n');
    setCursorPos({ line, col });
  };

  // Datei laden
  const { data: fileData, isLoading, error } = useQuery<{ content: string; size: number }>({
    queryKey: ['fileContent', serverId, relPath],
    queryFn: () =>
      api<{ content: string; size: number }>(
        `${filesBase}/content?path=${encodeURIComponent(relPath)}`
      ),
    staleTime: 0,
  });

  useEffect(() => {
    if (fileData) {
      setContent(fileData.content);
      setInitialContent(fileData.content);
      setDirty(false);
    }
  }, [fileData]);

  useEffect(() => {
    if (error) {
      setErrorMsg((error as Error).message);
    }
  }, [error]);

  const saveMut = useMutation({
    mutationFn: () =>
      api(`${filesBase}/content`, {
        method: 'PUT',
        body: { path: relPath, content },
      }),
    onSuccess: () => {
      setInitialContent(content);
      setDirty(false);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const handleClose = () => {
    if (dirty && !window.confirm(t('files.unsavedWarning'))) {
      return;
    }
    onClose();
  };

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(content);
      const formatted = JSON.stringify(parsed, null, 2);
      setContent(formatted);
      setDirty(formatted !== initialContent);
    } catch {
      setErrorMsg('Ungültiges JSON – Formatierung nicht möglich');
      setTimeout(() => setErrorMsg(null), 3000);
    }
  };

  // Keyboard Shortcuts: Ctrl+S, Ctrl+F, Tab
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (canWrite && dirty) {
        saveMut.mutate();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      setShowSearch((prev) => !prev);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const val = target.value;
      const nextVal = val.substring(0, start) + '  ' + val.substring(end);
      setContent(nextVal);
      setDirty(true);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
        updateCursorPosition(target);
      });
    }
  };

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return 0;
    const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return (content.match(regex) || []).length;
  }, [content, searchQuery]);

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-3 sm:p-6 backdrop-blur-sm">
      <div className="bg-rack-1 border border-seam rounded-xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
        {/* Editor Kopfzeile */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-seam bg-rack-2/40 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode className="size-4 text-emerald-400 shrink-0" />
            <span className="font-mono text-sm text-ink font-medium truncate">
              {relPath}
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-rack-2 text-dim border border-seam uppercase">
              {lang}
            </span>
            {dirty && <span className="size-2 rounded-full bg-amber shrink-0" title="Ungespeichert" />}
          </div>

          <div className="flex items-center gap-1.5">
            {savedSuccess && (
              <span className="text-xs text-emerald-400 font-medium animate-pulse mr-1">
                {t('files.saved')}
              </span>
            )}
            {isConfigFile && (
              <div className="flex items-center bg-rack-1 p-0.5 rounded-md border border-seam mr-1">
                <button
                  type="button"
                  onClick={() => setViewMode('form')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition ${
                    viewMode === 'form'
                      ? 'bg-amber text-black shadow-sm'
                      : 'text-dim hover:text-ink'
                  }`}
                  title="Komfortable Formular-Ansicht mit Schaltern und Eingabefeldern"
                >
                  <Sliders className="size-3.5" />
                  Formular
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('code')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition ${
                    viewMode === 'code'
                      ? 'bg-amber text-black shadow-sm'
                      : 'text-dim hover:text-ink'
                  }`}
                  title="Direkter Text- & Code-Editor"
                >
                  <Code2 className="size-3.5" />
                  Code
                </button>
              </div>
            )}
            {lang === 'JSON' && viewMode === 'code' && (
              <Button
                variant="quiet"
                className="h-7 text-xs px-2"
                onClick={handleFormatJson}
                title="JSON automatisch formatieren & einrücken"
              >
                <Sparkles className="size-3.5 mr-1 text-amber" />
                Formatieren
              </Button>
            )}
            {isMarkdown && (
              <Button
                variant="quiet"
                className={`h-7 text-xs px-2 ${mdPreview ? 'bg-amber text-black font-semibold' : ''}`}
                onClick={() => setMdPreview(!mdPreview)}
                title="Formatierte Markdown-Vorschau umschalten"
              >
                <Eye className="size-3.5 mr-1" />
                {mdPreview ? 'Editor' : 'Vorschau'}
              </Button>
            )}
            {viewMode === 'code' && (
              <Button
                variant="quiet"
                className={`h-7 text-xs px-2 ${showSearch ? 'bg-amber/15 text-amber border-amber/30' : ''}`}
                onClick={() => setShowSearch(!showSearch)}
                title="Suchen (Strg + F)"
              >
                <Search className="size-3.5 mr-1" />
                Suchen
              </Button>
            )}
            {revisions && (
            <Button
              variant="quiet"
              className="h-7 text-xs px-2"
              onClick={() => setShowRevisions(true)}
              title="Versionshistorie & Stände vergleichen"
            >
              <History className="size-3.5 mr-1" />
              Revisionen
            </Button>
            )}
            {canWrite && (
              <Button
                variant="primary"
                className="h-7 text-xs px-3"
                onClick={() => saveMut.mutate()}
                disabled={!dirty || saveMut.isPending}
                busy={saveMut.isPending}
              >
                <Save className="size-3.5 mr-1" />
                {t('files.save')}
              </Button>
            )}
            <button
              onClick={handleClose}
              className="p-1 rounded text-dim hover:text-ink hover:bg-rack-2/80 ml-1"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Suchleiste */}
        {showSearch && (
          <div className="px-4 py-2 border-b border-seam bg-rack-2/70 flex items-center gap-2">
            <Search className="size-4 text-dim shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="In Datei suchen..."
              className="flex-1 bg-rack-1 border border-seam rounded px-2.5 py-1 text-xs text-ink focus:border-amber focus:outline-none"
              autoFocus
            />
            {searchQuery && (
              <span className="text-xs text-dim whitespace-nowrap">
                {searchMatches} Treffer
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowSearch(false)}
              className="p-1 text-dim hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {errorMsg && (
          <div className="p-3 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs">
            {errorMsg}
          </div>
        )}

        {/* Editor Body mit synchronisierten Zeilennummern oder Formular-Editor */}
        <div className="flex-1 relative bg-[#090b0e] overflow-hidden flex">
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Spinner />
            </div>
          ) : isConfigFile && viewMode === 'form' ? (
            <ConfigFormEditor
              content={content}
              filename={relPath}
              onChange={(next) => {
                setContent(next);
                setDirty(next !== initialContent);
              }}
              disabled={!canWrite}
            />
          ) : mdPreview ? (
            <div className="flex-1 p-6 overflow-y-auto bg-night/70">
              <MarkdownViewer content={content} showRawToggle={false} showCopyButton={true} />
            </div>
          ) : (
            <>
              {/* Zeilennummern */}
              <div
                ref={lineNumbersRef}
                className="w-12 py-3 pr-2 text-right select-none font-mono text-xs text-dim/40 bg-[#0c0e12] border-r border-seam/60 overflow-hidden leading-relaxed shrink-0"
              >
                {Array.from({ length: lineCount }).map((_, i) => (
                  <div
                    key={i}
                    className={cursorPos.line === i + 1 ? 'text-amber font-semibold' : ''}
                  >
                    {i + 1}
                  </div>
                ))}
              </div>

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(e.target.value !== initialContent);
                  updateCursorPosition(e.target);
                }}
                onKeyDown={handleKeyDown}
                onKeyUp={(e) => updateCursorPosition(e.currentTarget)}
                onClick={(e) => updateCursorPosition(e.currentTarget)}
                onScroll={handleScroll}
                disabled={!canWrite}
                placeholder="Dateiinhalt..."
                spellCheck={false}
                className="flex-1 w-full bg-transparent p-3 font-mono text-xs sm:text-sm text-ink/90 leading-relaxed resize-none focus:outline-none overflow-y-auto whitespace-pre tab-2"
              />
            </>
          )}
        </div>

        {/* Statusleiste am unteren Rand */}
        <div className="px-4 py-1.5 border-t border-seam bg-rack-2/60 flex items-center justify-between text-xs text-dim font-mono shrink-0">
          <div className="flex items-center gap-3">
            <span>Zeile {cursorPos.line}, Spalte {cursorPos.col}</span>
            <span>•</span>
            <span>{lineCount} Zeilen</span>
            <span>•</span>
            <span>{content.length} Zeichen</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline">Strg+S Speichern • Strg+F Suchen • Tab Einrücken</span>
            <span className="px-1.5 py-0.5 rounded bg-rack text-ink/80 text-[10px] uppercase border border-seam/60">
              {lang}
            </span>
            <span>UTF-8</span>
          </div>
        </div>

        {showRevisions && (
          <FileRevisionsModal
            serverId={serverId}
            relPath={relPath}
            canWrite={canWrite}
            onRollbackSuccess={(restored) => {
              setContent(restored);
              setInitialContent(restored);
              setDirty(false);
            }}
            onClose={() => setShowRevisions(false)}
          />
        )}
      </div>
    </div>
  );
}

function SimpleInputModal({
  title,
  label,
  value,
  onChange,
  onSubmit,
  onClose,
  busy,
}: {
  title: string;
  label: string;
  value: string;
  onChange: (val: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-rack-1 border border-seam rounded-lg p-5 max-w-sm w-full shadow-xl space-y-4">
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        <div>
          <label className="text-xs text-dim block mb-1.5">{label}</label>
          <input
            type="text"
            value={value}
            autoFocus
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) onSubmit();
              if (e.key === 'Escape') onClose();
            }}
            className="w-full bg-rack-2 border border-seam rounded px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-amber font-mono"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="quiet" className="h-8 text-xs px-3" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            className="h-8 text-xs px-3"
            onClick={onSubmit}
            disabled={!value.trim()}
            busy={busy}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
