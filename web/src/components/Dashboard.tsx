import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Server, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/i18n';
import { formatMb, formatRate } from '../lib/status';
import type { DashboardData } from '../lib/types';
import { t } from '../lib/i18n';
import { Tooltip, InfoTip } from './Tooltip';

/**
 * Kopf der Startseite: Gesamtlast aller sichtbaren Server, fuer Admins
 * zusaetzlich die Grundleistung der Maschine. Balken statt Graphen: die
 * Frage hier ist "wie voll ist es", nicht "wie war es vor zehn Minuten".
 */
export function Dashboard({ data }: { data: DashboardData }) {
  const { totals, host } = data;
  return (
    <div className="space-y-4 mb-6">
      {host && <HostCard host={host} />}
      <section aria-label={t('dash.totals')} className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        <Stat icon={Server} label={t('dash.running')} value={`${totals.running} / ${totals.servers}`}
          tip="Laufende Gameserver im Verhältnis zu allen angelegten Servern." />
        <Stat icon={Cpu} label={t('dash.cpuAll')} value={`${totals.cpuPercent.toFixed(0)} %`}
          sub={t('dash.cpuAssigned', { cores: (totals.cpuAssignedPercent / 100).toLocaleString() })}
          tip="Gesamte CPU-Last aller aktiven Server. 100% entspricht 1 voll ausgelastetem Kern." />
        <Stat icon={MemoryStick} label={t('dash.ramAll')} value={formatMb(totals.ramUsedMb)}
          sub={t('dash.ofAssigned', { value: formatMb(totals.ramAssignedMb) })}
          pct={totals.ramAssignedMb ? totals.ramUsedMb / totals.ramAssignedMb : undefined}
          tip="Gesamter RAM-Verbrauch aller laufenden Container im Verhältnis zum zugewiesenen Limit." />
        <Stat icon={HardDrive} label={t('dash.diskAll')} value={formatMb(totals.diskUsedMb)}
          sub={t('dash.ofAssigned', { value: formatMb(totals.diskAssignedMb) })}
          pct={totals.diskAssignedMb ? totals.diskUsedMb / totals.diskAssignedMb : undefined}
          tip="Speicherplatzverbrauch der Datenordner aller Server auf der SSD." />
        <Stat icon={ArrowDown} label={t('dash.network')}
          value={<span className="inline-flex items-center gap-3"><span className="inline-flex items-center gap-1"><ArrowDown className="size-3.5 text-led-install" aria-label={t('dash.down')} />{formatRate(totals.rxRate)}</span><span className="inline-flex items-center gap-1"><ArrowUp className="size-3.5 text-amber" aria-label={t('dash.up')} />{formatRate(totals.txRate)}</span></span>}
          tip="Live-Übertragungsrate über das Netzwerk: Eingehend (Download) und Ausgehend (Upload)." />
      </section>
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub, pct, tip }: { icon: typeof Cpu; label: string; value: React.ReactNode; sub?: string; pct?: number | undefined; tip?: string }) {
  return (
    <div className="rounded-lg border border-seam bg-rack px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-dim">
        <Icon className="size-3.5" aria-hidden />
        <span>{label}</span>
        {tip && <InfoTip text={tip} side="top" />}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {pct !== undefined && <Bar pct={pct} className="mt-2" />}
      {sub && <div className="mt-1 text-xs text-dim">{sub}</div>}
    </div>
  );
}

export function Bar({ pct, className = '', tone }: { pct: number; className?: string; tone?: string }) {
  const p = Math.max(0, Math.min(1, pct));
  const color = tone ?? (p > 0.9 ? 'bg-led-crash' : p > 0.75 ? 'bg-led-start' : 'bg-led-run');
  return (
    <div className={`h-1.5 rounded-full bg-rack-2 overflow-hidden ${className}`} role="meter" aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${color} transition-[width] duration-700`} style={{ width: `${p * 100}%` }} />
    </div>
  );
}

function uptime(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return d > 0 ? t('dash.uptimeDays', { d, h }) : t('dash.uptimeHours', { h, m: Math.floor((s % 3600) / 60) });
}

function HostCard({ host }: { host: NonNullable<DashboardData['host']> }) {
  const over = host.assigned.ramMb > host.ramTotalMb;
  return (
    <section className="rounded-lg border border-seam bg-rack p-4 space-y-4" aria-label={t('dash.host')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">{t('dash.host')} <span className="font-mono text-sm text-dim">{host.hostname}</span></h2>
        <p className="text-xs text-dim">{host.cpuModel} · {t('dash.uptime', { time: uptime(host.uptimeS) })}</p>
      </div>
      <div className="grid md:grid-cols-3 gap-5">
        <Meter icon={Cpu} label={t('dash.cpu')}
          value={host.cpuPercent === null ? '–' : `${host.cpuPercent.toFixed(0)} %`}
          pct={(host.cpuPercent ?? 0) / 100}
          tip="Gesamtauslastung aller CPU-Kerne des Debian Linux Hosts (inkl. System & Docker)."
          lines={[t('res.cores', { count: host.cpuCores }) + ` · ${t('dash.load')} ${host.load.join(' / ')}`,
            t('dash.assignedCores', { cores: (host.assigned.cpuPercent / 100).toLocaleString(), total: host.cpuCores })]} />
        <Meter icon={MemoryStick} label={t('res.ram')}
          value={`${formatMb(host.ramUsedMb)} / ${formatMb(host.ramTotalMb)}`}
          pct={host.ramUsedMb / host.ramTotalMb}
          tip="Physikalischer RAM-Verbrauch der gesamten VM im Vergleich zum Gesamtspeicher."
          lines={[t('dash.assignedServers', { value: formatMb(host.assigned.ramMb), count: host.assigned.servers })]}
          warn={over ? t('dash.overcommit') : undefined} />
        <Meter icon={HardDrive} label={t('res.disk')}
          value={`${formatMb(host.diskUsedMb)} / ${formatMb(host.diskTotalMb)}`}
          pct={host.diskTotalMb ? host.diskUsedMb / host.diskTotalMb : 0}
          tip="Belegung der SSD-Root-Partition der VM durch Spielserver, Docker-Images und Cache."
          lines={storageLines(host)}
          action={host.storage.docker ? <PruneButton /> : undefined} />
      </div>
    </section>
  );
}

/** Was den Speicher fuellt: Spieldaten und Docker (Images, Container, Build-Cache). */
function storageLines(host: NonNullable<DashboardData['host']>) {
  const s = host.storage;
  const lines = [t('dash.gameData', { value: formatMb(s.gameDataMb), assigned: formatMb(host.assigned.diskMb) })];
  if (s.docker) {
    lines.push(t('dash.docker', { images: formatMb(s.docker.imagesMb), containers: formatMb(s.docker.containersMb + s.docker.volumesMb), cache: formatMb(s.docker.buildCacheMb) }));
  }
  lines.push(s.measuredAt ? t('dash.measured', { time: fmtDateTime(s.measuredAt, { timeStyle: 'short' }) }) : t('disk.notMeasured'));
  return lines;
}

/** Ungenutzte Docker-Images und Build-Cache loeschen - mit Rueckfrage, Spielserver bleiben unberuehrt. */
function PruneButton() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const prune = useMutation({
    mutationFn: () => api<{ imagesDeleted: number; reclaimedMb: number }>('/admin/docker/prune', { method: 'POST', body: { images: true, buildCache: true } }),
    onSuccess: () => { setConfirm(false); setTimeout(() => void qc.invalidateQueries({ queryKey: ['dashboard'] }), 3000); },
  });
  return (
    <div className="mt-2 space-y-1">
      <button type="button" disabled={prune.isPending} onClick={() => (confirm ? prune.mutate() : setConfirm(true))} onBlur={() => setConfirm(false)}
        className={`text-xs inline-flex items-center gap-1.5 rounded-md border px-2 h-7 ${confirm ? 'border-led-crash/60 text-led-crash' : 'border-seam text-dim hover:text-ink'}`}>
        <Trash2 className="size-3.5" aria-hidden />{prune.isPending ? t('dash.pruning') : confirm ? t('dash.pruneConfirm') : t('dash.prune')}
      </button>
      {prune.data && <p className="text-xs text-led-run">{t('dash.pruned', { mb: prune.data.reclaimedMb, count: prune.data.imagesDeleted })}</p>}
      {prune.error && <p className="text-xs text-led-crash">{(prune.error as Error).message}</p>}
    </div>
  );
}

function Meter({ icon: Icon, label, value, pct, lines, warn, action, tip }: { icon: typeof Cpu; label: string; value: string; pct: number; lines: string[]; warn?: string | undefined; action?: React.ReactNode; tip?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 text-dim">
          <Icon className="size-3.5" aria-hidden />
          <span>{label}</span>
          {tip && <InfoTip text={tip} side="top" />}
        </span>
        <span className="tabular-nums font-medium">{value}</span>
      </div>
      <Bar pct={pct} className="mt-2" />
      {lines.map((l) => <p key={l} className="mt-1 text-xs text-dim">{l}</p>)}
      {warn && <p className="mt-1 text-xs text-led-start">{warn}</p>}
      {action}
    </div>
  );
}
