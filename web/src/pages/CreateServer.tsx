import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, FileArchive, Image as ImageIcon, LayoutGrid, List as ListIcon, Package, Search } from 'lucide-react';
import { api, ApiError, currentToken, refreshSession } from '../lib/api';
import { formatMb } from '../lib/status';
import type { EggDetail, EggSummary, EggVariable, SteamAccount } from '../lib/types';
import { Button, ErrorBox, Field, Input, Select, Spinner } from '../components/ui';
import { VariableField, visible } from '../components/VariableField';
import { FromBackup, sourceLabel, type BackupPreset } from '../components/FromBackup';
import { t, tn } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { CoverPicker, GameCover } from '../components/GameCover';
import { ModpackSearch, type ModpackChoice } from '../components/ModpackSearch';
import { EggImport } from '../components/EggImport';

/**
 * Neuer Server in drei Schritten. Das Formular kennt kein einziges Spiel:
 * jedes Feld kommt aus den Variablen des Eggs - "in:a,b,c" wird ein
 * Dropdown, "between:1,200" ein Zahlenfeld mit Grenzen.
 */
const STEPS = ['create.step.game', 'create.step.resources', 'create.step.settings'] as const;

type Source = 'new' | 'backup' | 'modpack';

export function CreateServer() {
  const [step, setStep] = useState(0);
  const [eggId, setEggId] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('new');
  const [preset, setPreset] = useState<BackupPreset | null>(null);
  const [pack, setPack] = useState<ModpackChoice | null>(null);
  const eggs = useQuery({ queryKey: ['eggs'], queryFn: () => api<{ eggs: EggSummary[] }>('/eggs') });
  // Modpacks laufen ueber das Minecraft-Java-Egg (frueher "Minecraft Paper")
  const mcEgg = eggs.data?.eggs.find((e) => e.name === 'Minecraft Java') ?? eggs.data?.eggs.find((e) => e.name === 'Minecraft Paper');

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">{t('servers.create')}</h1>
      <ol className="flex gap-6 text-sm mb-8 mt-4" aria-label={t('create.progress')}>
        {STEPS.map((s, i) => (
          <li key={s} className={`flex items-center gap-2 ${i === step ? 'text-ink' : i < step ? 'text-dim' : 'text-dim/60'}`} aria-current={i === step ? 'step' : undefined}>
            <span className={`grid place-items-center size-6 rounded-full text-xs font-semibold ${i === step ? 'bg-amber text-amber-ink' : i < step ? 'bg-led-run/20 text-led-run' : 'bg-rack-2 text-dim'}`}>{i + 1}</span>
            {i === 0 && source === 'backup' ? t('create.step.backup') : i === 0 && source === 'modpack' ? t('create.step.modpack') : t(s)}
          </li>
        ))}
      </ol>
      {/* Bleibt eingehaengt: "Zurueck zum Backup" soll Upload und Analyse nicht verlieren. */}
      <div hidden={step !== 0}>
        <>
          <div role="tablist" aria-label={t('create.sourceLabel')} className="flex gap-1 border-b border-seam mb-6">
            {([['new', 'create.tab.new', Search], ['modpack', 'create.tab.modpack', Package], ['backup', 'create.tab.backup', FileArchive]] as const).map(([key, label, Icon]) => (
              <button key={key} role="tab" type="button" aria-selected={source === key}
                onClick={() => setSource(key)}
                className={`inline-flex items-center gap-2 px-4 h-10 -mb-px border-b-2 text-sm ${source === key ? 'border-amber text-ink' : 'border-transparent text-dim hover:text-ink'}`}>
                <Icon className="size-4" aria-hidden /> {t(label)}
              </button>
            ))}
          </div>
          {source === 'new'
            ? <PickGame selected={eggId} onPick={(id) => { setPreset(null); setPack(null); setEggId(id); setStep(1); }} />
            : null}
          {source === 'modpack' && (mcEgg
            ? <ModpackSearch onPick={(c) => { setPreset(null); setPack(c); setEggId(mcEgg.id); setStep(1); }} />
            : eggs.isLoading ? <Spinner /> : <ErrorBox>{t('pack.noEgg')}</ErrorBox>)}
          <div hidden={source !== 'backup'}>
            <FromBackup onReady={(p) => { setPack(null); setPreset(p); setEggId(p.eggId); setStep(1); }} />
          </div>
        </>
      </div>
      {step > 0 && eggId && <Configure key={`${eggId}-${preset?.file ?? ''}-${pack?.label ?? ''}`} eggId={eggId} step={step} setStep={setStep} preset={preset} pack={pack} />}
    </div>
  );
}

type PickView = 'list' | 'tiles';
const PICK_VIEW_KEY = 'nxp.gameView';
function loadPickView(): PickView {
  try { return localStorage.getItem(PICK_VIEW_KEY) === 'list' ? 'list' : 'tiles'; } catch { return 'tiles'; }
}

function PickGame({ selected, onPick }: { selected: string | null; onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [view, setView] = useState<PickView>(loadPickView);
  const [editCover, setEditCover] = useState<EggSummary | null>(null);
  const { me } = useAuth();
  const isAdmin = me?.user.role === 'admin';
  const { data, isLoading, error } = useQuery({ queryKey: ['eggs'], queryFn: () => api<{ eggs: EggSummary[] }>('/eggs') });
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox>{(error as Error).message}</ErrorBox>;
  const pick = (v: PickView) => { setView(v); try { localStorage.setItem(PICK_VIEW_KEY, v); } catch { /* egal */ } };
  const eggs = (data?.eggs ?? []).filter((e) => !q || `${e.name} ${e.category}`.toLowerCase().includes(q.toLowerCase()));
  const byCat = new Map<string, EggSummary[]>();
  for (const e of eggs) byCat.set(e.category, [...(byCat.get(e.category) ?? []), e]);
  const groups = [...byCat.entries()];
  const meta = (e: EggSummary) => (
    <>
      {e.resources?.base_ram_mb ? t('create.ramFrom', { ram: formatMb(e.resources.base_ram_mb) }) : t('create.ramAsNeeded')}
      {e.consoleMode !== 'full' && ` · ${t('create.consoleReadonly')}`}
    </>
  );
  const coverButton = (e: EggSummary, className: string) => isAdmin && (
    <button type="button" onClick={() => setEditCover(e)} title={t('cover.change')} aria-label={`${t('cover.change')}: ${e.name}`}
      className={`grid place-items-center rounded-md bg-black/55 text-white/85 hover:text-amber hover:bg-black/75 ${className}`}>
      <ImageIcon className="size-4" aria-hidden />
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="size-4 text-dim absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
          <Input autoFocus aria-label={t('create.searchGame')} placeholder={t('create.searchGamePlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <div role="group" aria-label={t('servers.view')} className="flex rounded-md border border-seam overflow-hidden shrink-0">
          {([['tiles', LayoutGrid, 'create.viewTiles'], ['list', ListIcon, 'create.viewList']] as const).map(([v, Icon, label]) => (
            <button key={v} type="button" onClick={() => pick(v)} aria-pressed={view === v} title={t(label)} aria-label={t(label)}
              className={`grid place-items-center w-10 h-10 ${view === v ? 'bg-rack-2 text-amber' : 'text-dim hover:text-ink'}`}>
              <Icon className="size-4" aria-hidden />
            </button>
          ))}
        </div>
      </div>
      {isAdmin && <EggImport />}
      {groups.length === 0 && <p className="text-dim text-sm">{t('create.noGame')}</p>}
      {groups.map(([cat, list]) => (
        <section key={cat}>
          <h2 className="text-sm text-dim mb-2">{cat}</h2>
          {view === 'tiles' ? (
            <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {list.map((e) => (
                <li key={e.id} className="relative group">
                  <button onClick={() => onPick(e.id)}
                    className={`block w-full text-left rounded-lg border overflow-hidden bg-rack hover:border-amber/60 ${selected === e.id ? 'border-amber' : 'border-seam'}`}>
                    <GameCover cover={e.cover} seed={e.id} />
                    <span className="block px-3 py-2">
                      <span className="block font-medium truncate group-hover:text-amber">{e.name}</span>
                      <span className="block text-xs text-dim truncate">{meta(e)}</span>
                    </span>
                  </button>
                  {coverButton(e, 'absolute top-1.5 right-1.5 size-8 opacity-0 group-hover:opacity-100 focus:opacity-100')}
                </li>
              ))}
            </ul>
          ) : (
            <ul className="divide-y divide-seam rounded-lg border border-seam overflow-hidden">
              {list.map((e) => (
                <li key={e.id} className="flex items-center">
                  <button
                    onClick={() => onPick(e.id)}
                    className={`flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-rack flex items-center gap-4 ${selected === e.id ? 'bg-rack' : ''}`}
                  >
                    <GameCover cover={e.cover} seed={e.id} className="w-24 rounded shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium truncate">{e.name}</span>
                      <span className="block text-sm text-dim truncate">{meta(e)}</span>
                    </span>
                    <span className="text-sm text-amber shrink-0">{t('common.choose')}</span>
                  </button>
                  {coverButton(e, 'size-9 mr-2 bg-transparent text-dim hover:bg-rack-2')}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {editCover && (
        <CoverPicker eggId={editCover.id} eggName={editCover.name} choice={editCover.coverChoice ?? 'auto'} hasSteam={!!editCover.hasSteamCover}
          onClose={() => setEditCover(null)} />
      )}
    </div>
  );
}

function Configure({ eggId, step, setStep, preset, pack }: { eggId: string; step: number; setStep: (n: number) => void; preset: BackupPreset | null; pack: ModpackChoice | null }) {
  const { data, isLoading } = useQuery({ queryKey: ['egg', eggId], queryFn: () => api<{ egg: EggDetail }>(`/eggs/${eggId}`) });
  if (isLoading || !data) return <Spinner />;
  return <Form egg={data.egg} step={step} setStep={setStep} preset={preset} pack={pack} />;
}

/** Name fuer den neuen Server: was im Backup als Servername stand, sonst der Spielname. */
const NAME_VARS = ['SESSION_NAME', 'SERVER_NAME', 'MOTD'];
function initialName(egg: EggDetail, preset: BackupPreset | null) {
  for (const k of NAME_VARS) {
    const v = preset?.values[k]?.replace(/§./g, '').trim();
    if (v) return v.slice(0, 64);
  }
  return egg.name;
}

const DISK_OPTIONS = [5, 10, 20, 40, 60, 100, 200];

function suggestedRam(egg: EggDetail, vars: Record<string, string>) {
  const r = egg.resources;
  if (!r?.base_ram_mb) return 2048;
  const players = Number(vars.MAX_PLAYERS ?? vars.MAX_PLAYER ?? 0) || 0;
  const raw = r.base_ram_mb + players * (r.ram_per_player_mb ?? 0);
  return Math.ceil(raw / 512) * 512;
}

/** Pack-Datei hochladen - der Datenordner entsteht erst mit dem Container, daher ein paar Versuche. */
async function uploadPack(serverId: string, file: File) {
  for (let attempt = 0; attempt < 15; attempt++) {
    await refreshSession();
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/v1/servers/${serverId}/files/upload?path=`, { method: 'POST', headers: { Authorization: `Bearer ${currentToken()}` }, body: fd });
    if (res.ok) return;
    if (res.status === 403 || res.status === 413) throw new Error(t('pack.uploadFailed', { code: res.status }));
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(t('pack.uploadFailed', { code: 'timeout' }));
}

function Form({ egg, step, setStep, preset, pack }: { egg: EggDetail; step: number; setStep: (n: number) => void; preset: BackupPreset | null; pack: ModpackChoice | null }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const editable = egg.variables.filter((v) => v.editable);
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((v) => [v.env, preset?.values[v.env] ?? pack?.values[v.env] ?? v.default ?? ''])));
  const [name, setName] = useState(() => pack?.name ?? initialName(egg, preset));
  const ramHint = Math.max(suggestedRam(egg, vals), pack?.ramMb ?? 0);
  const [ramMb, setRamMb] = useState(ramHint);
  const [cpu, setCpu] = useState(Math.max(egg.resources?.min_cpu_percent ?? 100, 200));
  const minDisk = preset?.minDiskGb ?? 0;
  const [diskGb, setDiskGb] = useState(() => DISK_OPTIONS.find((d) => d >= Math.max(20, minDisk)) ?? Math.max(20, minDisk));
  const diskOptions = useMemo(() => [...new Set([...DISK_OPTIONS, diskGb])].sort((a, b) => a - b), [diskGb]);
  const defaultImage = egg.images.find((i) => i.default)?.key ?? egg.images[0]?.key ?? '';
  // Modpack: Java passend zur Minecraft-Version des Packs
  const [imageKey, setImageKey] = useState(() => (pack && egg.images.find((i) => i.image.includes(`java${pack.java}`))?.key) || defaultImage);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Steam-Konto nur bei Spielen pruefen & anbieten, die es wirklich erfordern
  const requiresSteam = egg.variables.some((v) => v.env === 'STEAM_USER' || v.env === 'STEAM_PASS');
  const [selectedSteamAccountId, setSelectedSteamAccountId] = useState<string>('');

  const { data: steamData } = useQuery<{ accounts: SteamAccount[] }>({
    queryKey: ['steam-accounts'],
    queryFn: () => api('/steam/accounts'),
    enabled: requiresSteam,
  });

  const create = useMutation({
    mutationFn: () => api<{ server: { id: string; shortId: string } }>('/servers', {
      method: 'POST',
      body: {
        name, eggId: egg.id, ramMb, cpuPercent: cpu, diskMb: diskGb * 1024,
        ...(imageKey !== defaultImage ? { imageKey } : {}),
        ...(preset ? { importFile: preset.file } : {}),
        ...(selectedSteamAccountId ? { steamAccountId: selectedSteamAccountId } : {}),
        variables: Object.fromEntries(Object.entries(vals).filter(([k]) => {
          const v = editable.find((e) => e.env === k);
          return v && visible(v, vals) && !(v.secret && vals[k] === '');
        })),
      },
    }),
    onSuccess: async (r) => {
      void qc.invalidateQueries({ queryKey: ['servers'] });
      if (pack?.file) {
        try { await uploadPack(r.server.id, pack.file); } catch (err) { setUploadErr((err as Error).message); return; }
      }
      navigate(`/server/${r.server.shortId}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.issues) {
        setFieldErrors(Object.fromEntries(e.issues.map((i) => [i.variable ?? i.path ?? '', i.message])));
        setStep(2);
      }
    },
  });

  const ramOptions = useMemo(() => {
    const opts = [1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768];
    return [...new Set([...opts, ramHint])].sort((a, b) => a - b);
  }, [ramHint]);

  if (step === 1) {
    return (
      <div className="space-y-6">
        <BackTo onClick={() => setStep(0)} label={preset ? t('create.backToBackup') : pack ? t('pack.backToSearch') : t('create.otherGame', { game: egg.name })} />
        {preset && <BackupBanner preset={preset} egg={egg} />}
        {pack && (
          <div className="rounded-lg border border-amber/40 bg-amber/10 px-4 py-3 text-sm">
            <p>{tn('pack.banner', { pack: <span className="font-medium">{pack.label}</span> })}</p>
            <p className="text-dim">{pack.file ? t('pack.bannerFile') : t('pack.bannerText')}</p>
          </div>
        )}
        <Field label={t('settings.name')} htmlFor="name" hint={t('create.nameHint')}>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
        </Field>
        <Field label={t('res.ram')} htmlFor="ram" hint={egg.resources?.base_ram_mb ? t('create.ramHint', { ram: formatMb(ramHint) }) : undefined}>
          <Select id="ram" value={ramMb} onChange={(e) => setRamMb(Number(e.target.value))}>
            {ramOptions.map((r) => <option key={r} value={r}>{formatMb(r)}{r === ramHint ? ` (${t('create.recommended')})` : ''}</option>)}
          </Select>
        </Field>
        <div className="grid sm:grid-cols-2 gap-6">
          <Field label={t('res.cpu')} htmlFor="cpu" hint={t('create.cpuHint')}>
            <Select id="cpu" value={cpu} onChange={(e) => setCpu(Number(e.target.value))}>
              {[100, 200, 300, 400, 600, 800].map((c) => <option key={c} value={c}>{t('res.cores', { count: c / 100 })} ({c} %)</option>)}
            </Select>
          </Field>
          <Field label={t('res.disk')} htmlFor="disk" hint={minDisk ? t('create.diskMin', { gb: minDisk }) : undefined}
            error={minDisk && diskGb < minDisk ? t('create.diskTooSmall') : undefined}>
            <Select id="disk" value={diskGb} onChange={(e) => setDiskGb(Number(e.target.value))}>
              {diskOptions.map((d) => <option key={d} value={d}>{d} GB{d < minDisk ? ` (${t('create.tooSmall')})` : ''}</option>)}
            </Select>
          </Field>
        </div>
        {egg.images.length > 1 && (
          <Field label={t('settings.runtime')} htmlFor="image" hint={t('create.runtimeHint')}>
            <Select id="image" value={imageKey} onChange={(e) => setImageKey(e.target.value)}>
              {egg.images.map((i) => <option key={i.key} value={i.key}>{i.label}{i.default ? ` (${t('common.default')})` : ''}</option>)}
            </Select>
          </Field>
        )}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!name.trim()} onClick={() => setStep(2)}>{t('create.toSettings')}</Button>
        </div>
      </div>
    );
  }

  const shown = editable.filter((v) => visible(v, vals));
  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); setFieldErrors({}); create.mutate(); }}>
      <BackTo onClick={() => setStep(1)} label={t('create.backToResources')} />
      {preset && <p className="text-sm text-dim">{t('create.prefilled')}</p>}

      {/* Steam-Konto Auswahl (NUR wenn das Spiel explizit einen lizenzierten Steam-Account verlangt) */}
      {requiresSteam && (
        <div className="p-4 rounded-xl border border-[#2a475e] bg-[#171a21]/90 space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="size-8 rounded-lg bg-[#1b2838] border border-[#2a475e] flex items-center justify-center shrink-0">
              <svg className="size-4 text-[#66c0f4]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a10 10 0 0 0-10 10c0 4.7 3.2 8.6 7.6 9.7l2.5-3.6a3.5 3.5 0 0 1-1.6-2.9 3.5 3.5 0 0 1 .4-1.6L7.4 11.2a4.8 4.8 0 0 1-4.8-4.8 4.8 4.8 0 0 1 4.8-4.8 4.8 4.8 0 0 1 4.8 4.8c0 .2 0 .4-.1.6l2.4 3.5a3.5 3.5 0 0 1 1.6-.4 3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5 3.5 3.5 0 0 1-2.9-1.5l-3.7 2.5A10 10 0 0 0 12 22a10 10 0 0 0 10-10A10 10 0 0 0 12 2z" />
              </svg>
            </div>
            <div>
              <div className="text-xs font-bold text-white">Steam-Konto erforderlich</div>
              <div className="text-[11px] text-slate-400">
                Für {egg.name} verlangt Valve einen lizenzierten Steam-Account. Wähle ein eigenes oder geteiltes Konto.
              </div>
            </div>
          </div>

          {steamData?.accounts && steamData.accounts.length > 0 ? (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-slate-300">Steam-Account auswählen</label>
              <select
                value={selectedSteamAccountId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedSteamAccountId(id);
                  const acc = steamData.accounts.find((a) => a.id === id);
                  if (acc) {
                    setVals((p) => ({ ...p, STEAM_USER: acc.accountName }));
                  }
                }}
                className="w-full h-10 rounded-md bg-rack-2 border border-seam px-3 text-ink text-xs focus:border-amber focus:outline-none"
              >
                <option value="">– Bitte Steam-Konto auswählen –</option>
                {steamData.accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.label} ({acc.accountName}) {acc.isShared ? (acc.isOwner ? '· Team-Freigabe' : `· Geteilt von ${acc.ownerName}`) : '· Privat'}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-amber/15 border border-amber/40 text-amber text-xs flex items-center justify-between gap-3">
              <span>Kein Steam-Konto hinterlegt. Bitte füge in deinen Profileinstellungen ein Konto hinzu.</span>
              <a href="/account" target="_blank" rel="noreferrer" className="underline font-semibold shrink-0">
                Zu den Steam-Einstellungen →
              </a>
            </div>
          )}
        </div>
      )}

      {shown.length === 0 && <p className="text-dim text-sm">{t('create.noFields')}</p>}
      {shown.map((v) => (
        <div key={v.env}>
          <VariableField v={v} value={vals[v.env] ?? ''} error={fieldErrors[v.env]}
            onChange={(val) => setVals((p) => ({ ...p, [v.env]: val }))} />
          {preset?.sources[v.env] && (
            <p className="text-xs text-led-install mt-1">{vals[v.env] === preset.values[v.env] ? t('create.fromBackup', { source: sourceLabel(preset.sources[v.env]!) }) : t('create.changedFromBackup', { value: v.secret ? '••••' : preset.values[v.env] ?? '' })}</p>
          )}
        </div>
      ))}
      {create.error && !(create.error instanceof ApiError && create.error.issues) && <ErrorBox>{(create.error as Error).message}</ErrorBox>}
      {uploadErr && <ErrorBox>{uploadErr}</ErrorBox>}
      <div className="flex items-center justify-between gap-4 border-t border-seam pt-5">
        <p className="text-sm text-dim">{formatMb(ramMb)} RAM · {t('res.cores', { count: cpu / 100 })} · {diskGb} GB</p>
        <Button type="submit" variant="primary" busy={create.isPending}>{preset ? t('create.submitImport') : t('create.submit')}</Button>
      </div>
    </form>
  );
}

function BackupBanner({ preset, egg }: { preset: BackupPreset; egg: EggDetail }) {
  return (
    <div className="rounded-lg border border-led-install/40 bg-led-install/10 px-4 py-3 text-sm">
      <p>{tn('create.bannerFrom', { game: <span className="font-medium">{egg.name}</span>, file: <span className="font-mono">{preset.label}</span> })}</p>
      <p className="text-dim">{t('create.bannerText', { status: t('status.installing') })}</p>
    </div>
  );
}

function BackTo({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-sm text-dim hover:text-ink">
      <ChevronLeft className="size-4" /> {label}
    </button>
  );
}
