import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Key, Trash2, Plus, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { SteamAccount } from '../lib/types';
import { Button, ErrorBox, Field, Input, Spinner } from './ui';
import { t } from '../lib/i18n';
import { useAuth } from '../lib/auth';

export function SteamAccounts() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const isAdmin = me?.permissions['admin.nodes'] || me?.user.role === 'admin';

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [steamId, setSteamId] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [guardTarget, setGuardTarget] = useState<string | null>(null);
  const [guardCode, setGuardCode] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['steam-accounts'],
    queryFn: () => api<{ accounts: SteamAccount[] }>('/steam/accounts'),
  });

  const saveMut = useMutation({
    mutationFn: (body: { accountName: string; password?: string; steamId?: string }) =>
      api('/steam/accounts', { method: 'POST', body }),
    onSuccess: () => {
      setName('');
      setPassword('');
      setSteamId('');
      setShowAdd(false);
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ['steam-accounts'] });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : t('steam.saveFailed')),
  });

  const guardMut = useMutation({
    mutationFn: ({ id, code }: { id: string; code: string }) =>
      api(`/steam/accounts/${id}/guard`, { method: 'POST', body: { code } }),
    onSuccess: () => {
      setGuardTarget(null);
      setGuardCode('');
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ['steam-accounts'] });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : t('steam.guardFailed')),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api(`/steam/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ['steam-accounts'] });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : t('steam.deleteFailed')),
  });

  function submitAdd(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    saveMut.mutate({
      accountName: name.trim(),
      password: password || undefined,
      steamId: steamId.trim() || undefined,
    });
  }

  function submitGuard(e: FormEvent, id: string) {
    e.preventDefault();
    if (!guardCode.trim()) return;
    guardMut.mutate({ id, code: guardCode.trim() });
  }

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox>{(error as Error)?.message ?? t('common.notLoaded')}</ErrorBox>;

  const accounts = data?.accounts ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <Key className="size-5 text-amber" />
            {t('steam.title')}
          </h2>
          <p className="text-sm text-dim mt-0.5">{t('steam.desc')}</p>
        </div>
        {isAdmin && !showAdd && (
          <Button onClick={() => setShowAdd(true)} className="flex items-center gap-2">
            <Plus className="size-4" /> {t('steam.addBtn')}
          </Button>
        )}
      </div>

      {actionError && <ErrorBox>{actionError}</ErrorBox>}

      {showAdd && (
        <form onSubmit={submitAdd} className="rounded-lg border border-seam bg-rack-2 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-sm text-ink">{t('steam.newAccountTitle')}</h3>
            <button type="button" onClick={() => setShowAdd(false)} className="text-xs text-dim hover:text-ink">
              {t('common.cancel')}
            </button>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label={t('steam.accountName')} htmlFor="steam-name" hint={t('steam.accountNameHint')}>
              <Input id="steam-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="z. B. gameserver_bot" />
            </Field>
            <Field label={t('steam.password')} htmlFor="steam-pw" hint={t('steam.passwordHint')}>
              <Input id="steam-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>
          </div>
          <Field label={t('steam.steamIdOptional')} htmlFor="steam-id" hint={t('steam.steamIdHint')}>
            <Input id="steam-id" value={steamId} onChange={(e) => setSteamId(e.target.value)} placeholder="76561198..." />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setShowAdd(false)} className="bg-rack border border-seam text-dim hover:text-ink">
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saveMut.isPending}>
              {saveMut.isPending ? t('common.saving') : t('steam.saveBtn')}
            </Button>
          </div>
        </form>
      )}

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-seam p-8 text-center text-dim text-sm">
          {t('steam.noAccounts')}
        </div>
      ) : (
        <div className="grid gap-3">
          {accounts.map((acc) => (
            <div key={acc.id} className="rounded-lg border border-seam bg-rack p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2.5">
                    <span className="font-semibold text-ink text-base font-mono">{acc.accountName}</span>
                    {acc.hasPassword && (
                      <span className="text-xs px-2 py-0.5 rounded bg-rack-2 text-dim border border-seam">
                        {t('steam.hasPassword')}
                      </span>
                    )}
                    {acc.guardStatus === 'ok' ? (
                      <span className="inline-flex items-center gap-1 text-xs text-led-run bg-led-run/15 px-2 py-0.5 rounded-full">
                        <CheckCircle2 className="size-3.5" /> {t('steam.guardOk')}
                      </span>
                    ) : acc.guardStatus === 'needed' ? (
                      <span className="inline-flex items-center gap-1 text-xs text-amber bg-amber/15 px-2 py-0.5 rounded-full animate-pulse">
                        <AlertCircle className="size-3.5" /> {t('steam.guardNeeded')}
                      </span>
                    ) : (
                      <span className="text-xs text-dim">{t('steam.guardNone')}</span>
                    )}
                  </div>
                  {acc.steamId && <div className="text-xs text-dim font-mono">SteamID: {acc.steamId}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      setGuardTarget(guardTarget === acc.id ? null : acc.id);
                      setGuardCode('');
                    }}
                    className="text-xs px-3 h-8 flex items-center gap-1.5 bg-rack-2 border border-seam text-ink hover:border-amber"
                  >
                    <Shield className="size-3.5 text-amber" />
                    {t('steam.enterGuardBtn')}
                  </Button>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(t('steam.confirmDelete', { name: acc.accountName }))) {
                          delMut.mutate(acc.id);
                        }
                      }}
                      className="size-8 rounded flex items-center justify-center text-dim hover:text-led-crash hover:bg-rack-2 transition-colors"
                      title={t('common.delete')}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              </div>

              {guardTarget === acc.id && (
                <form
                  onSubmit={(e) => submitGuard(e, acc.id)}
                  className="pt-3 border-t border-seam/60 flex flex-wrap items-center gap-3"
                >
                  <div className="text-xs text-dim max-w-sm">
                    {acc.guardPrompt || t('steam.guardPromptDefault')}
                  </div>
                  <div className="flex items-center gap-2 ml-auto">
                    <Input
                      value={guardCode}
                      onChange={(e) => setGuardCode(e.target.value.toUpperCase())}
                      placeholder="z. B. 2P4HX"
                      maxLength={10}
                      className="w-32 uppercase font-mono tracking-widest text-center"
                      autoFocus
                      required
                    />
                    <Button type="submit" disabled={guardMut.isPending} className="text-xs h-9">
                      {guardMut.isPending ? t('common.saving') : t('steam.submitGuardBtn')}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
