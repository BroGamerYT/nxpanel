import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Plus, Trash2, Copy, Check, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Input, ErrorBox, Spinner } from './ui';

interface SftpPw { id: string; label: string; createdAt: string; lastUsedAt: string | null }

/**
 * Eigene SFTP-Passwoerter. SFTP kann keinen zweiten Faktor abfragen: Mit
 * Zwei-Faktor-Schutz geht SFTP nur damit, ohne 2FA zusaetzlich zum
 * Kontopasswort (z. B. eins je Programm, einzeln widerrufbar).
 */
export function SftpPasswords() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<{ label: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const list = useQuery({ queryKey: ['sftpPasswords'], queryFn: () => api<{ passwords: SftpPw[] }>('/auth/sftp-passwords') });
  const create = useMutation({
    mutationFn: () => api<{ password: SftpPw; secret: string }>('/auth/sftp-passwords', { method: 'POST', body: { label: label.trim() } }),
    onSuccess: (r) => { setFresh({ label: r.password.label, secret: r.secret }); setLabel(''); setCopied(false); void qc.invalidateQueries({ queryKey: ['sftpPasswords'] }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/auth/sftp-passwords/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sftpPasswords'] }),
  });
  const twoFa = Boolean(me?.user.totpEnabled);

  return (
    <div className="p-6 rounded-2xl border border-seam bg-rack space-y-4 md:col-span-2">
      <div>
        <h2 className="text-lg font-bold text-ink flex items-center gap-2"><HardDrive className="size-5 text-amber" aria-hidden />SFTP-Passwörter</h2>
        <p className="text-xs text-dim mt-1">
          Für Programme wie FileZilla oder WinSCP. {twoFa
            ? <strong className="text-amber">Dein Konto hat Zwei-Faktor-Schutz – per SFTP geht die Anmeldung deshalb nur mit einem dieser Passwörter, nicht mit deinem Kontopasswort.</strong>
            : 'Ohne Zwei-Faktor-Schutz geht auch dein Kontopasswort; ein eigenes Passwort je Programm lässt sich aber einzeln widerrufen.'}
        </p>
      </div>

      {fresh && (
        <div className="rounded-xl border border-amber/50 bg-amber/10 p-4 space-y-2">
          <p className="text-xs flex items-center gap-1.5"><AlertTriangle className="size-4 text-amber" aria-hidden />Neues Passwort für „{fresh.label}“ – es wird <strong>nur jetzt</strong> angezeigt:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm bg-rack-2 border border-seam rounded px-3 py-2 select-all">{fresh.secret}</code>
            <Button type="button" variant="quiet" onClick={() => { void navigator.clipboard.writeText(fresh.secret); setCopied(true); }} title="Kopieren">
              {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <Button type="button" variant="quiet" className="text-xs" onClick={() => setFresh(null)}>Gespeichert, ausblenden</Button>
        </div>
      )}

      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (label.trim()) create.mutate(); }}>
        <Input className="flex-1 min-w-48" placeholder="Name, z. B. FileZilla am PC" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Name des SFTP-Passworts" />
        <Button type="submit" variant="primary" busy={create.isPending} disabled={!label.trim()}><Plus className="size-4" />Passwort erzeugen</Button>
      </form>
      {create.error && <ErrorBox>{(create.error as Error).message}</ErrorBox>}

      {list.isLoading ? <Spinner /> : (list.data?.passwords.length ?? 0) === 0 ? (
        <p className="text-xs text-dim">Noch keine SFTP-Passwörter.</p>
      ) : (
        <ul className="divide-y divide-seam border border-seam rounded-xl overflow-hidden">
          {list.data!.passwords.map((p) => (
            <li key={p.id} className="p-3 flex items-center justify-between gap-3 text-xs">
              <div>
                <div className="font-semibold text-ink">{p.label}</div>
                <div className="text-dim">Erstellt {new Date(p.createdAt).toLocaleDateString('de-DE')}{p.lastUsedAt ? ` · zuletzt genutzt ${new Date(p.lastUsedAt).toLocaleString('de-DE')}` : ' · noch nie genutzt'}</div>
              </div>
              <Button type="button" variant="quiet" className="text-rose-400" busy={del.isPending}
                onClick={() => { if (confirm(`SFTP-Passwort „${p.label}“ löschen? Programme damit verlieren sofort den Zugang.`)) del.mutate(p.id); }}
                aria-label={`${p.label} löschen`}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
