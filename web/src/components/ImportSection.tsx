import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { uploadFile } from '../lib/upload';
import { t, tn } from '../lib/i18n';
import { formatMb } from '../lib/status';
import { Button, ErrorBox, Spinner } from './ui';

interface ImportInfo {
  supported: boolean; looksFor: string[]; notes: string | null; folder: string; running: boolean;
  files: Array<{ name: string; bytes: number; modified: string }>;
}

/**
 * Backup uebernehmen (z. B. aus AMP). Das Panel sucht im Archiv nur, was
 * dieses Spiel braucht - Welten, Spielstaende, Konfiguration - und laesst
 * den Rest liegen. Grosse Archive besser in den Import-Ordner kopieren.
 */
export function ImportSection({ serverId, stopped }: { serverId: string; stopped: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['import', serverId], queryFn: () => api<ImportInfo>(`/servers/${serverId}/import`), refetchInterval: 15_000 });
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const fromFolder = useMutation({
    mutationFn: (file: string) => api(`/servers/${serverId}/import`, { method: 'POST', body: { file } }),
    onSuccess: () => { setStarted(true); void qc.invalidateQueries({ queryKey: ['import', serverId] }); },
  });

  async function upload(file: File) {
    setUploadError(null);
    setProgress(0);
    const r = await uploadFile(`/servers/${serverId}/import/upload`, file, setProgress);
    setProgress(null);
    if (r.error) { setUploadError(r.error); return; }
    setStarted(true);
    void qc.invalidateQueries({ queryKey: ['import', serverId] });
  }

  if (isLoading || !data) return <Spinner />;
  if (!data.supported) return null;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-medium">{t('import.title')}</h2>
        <p className="text-sm text-dim mt-0.5">{tn('import.intro', { list: data.looksFor.join(', '), folder: <code className="font-mono text-[13px]">.panel</code> })}</p>
        {data.notes && <p className="text-sm text-dim mt-2">{data.notes}</p>}
      </div>

      {data.running && (
        <p className="rounded-md border border-led-install/40 bg-led-install/10 px-3 py-2 text-sm" role="status">
          {t('import.running')}
        </p>
      )}
      {started && !data.running && (
        <p className="text-sm text-led-run" role="status">{t('import.done')}</p>
      )}

      <div className="rounded-lg border border-seam p-4 space-y-3">
        <p className="text-sm"><span className="font-medium">{t('import.upload')}</span> <span className="text-dim">– {t('import.uploadHint')}</span></p>
        <input ref={fileInput} type="file" accept=".zip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        <div className="flex items-center gap-3">
          <Button disabled={!stopped || progress !== null || data.running} onClick={() => fileInput.current?.click()}>
            <Upload className="size-4" /> {t('import.choose')}
          </Button>
          {progress !== null && (
            <div className="flex-1 flex items-center gap-3" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-2 flex-1 rounded-full bg-rack-2 overflow-hidden"><div className="h-full bg-amber transition-all" style={{ width: `${progress}%` }} /></div>
              <span className="text-sm tabular-nums text-dim">{progress} %</span>
            </div>
          )}
        </div>
        {uploadError && <ErrorBox>{uploadError}</ErrorBox>}
      </div>

      <div className="rounded-lg border border-seam p-4 space-y-3">
        <p className="text-sm"><span className="font-medium">{t('import.folder')}</span> <span className="text-dim">– {tn('import.folderHint', { path: <code className="font-mono text-[13px]">{data.folder}</code> })}</span></p>
        {data.files.length === 0 ? <p className="text-sm text-dim">{t('import.folderEmpty')}</p> : (
          <ul className="divide-y divide-seam">
            {data.files.map((f) => (
              <li key={f.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate font-mono text-[13px]">{f.name}</span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="text-dim">{formatMb(Math.round(f.bytes / 1024 / 1024))}</span>
                  <Button disabled={!stopped || data.running || fromFolder.isPending} onClick={() => fromFolder.mutate(f.name)}>{t('import.apply')}</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {fromFolder.error && <ErrorBox>{(fromFolder.error as ApiError).message}</ErrorBox>}
      </div>
    </section>
  );
}
