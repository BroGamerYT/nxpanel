import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { api } from '../lib/api';
import { formatRate } from '../lib/status';
import { t } from '../lib/i18n';

interface Point { t: number; cpu: number; mem: number; rx: number; tx: number }

/**
 * Netzwerk der letzten Stunde: Download (blau) und Upload (bernstein) als
 * zwei Linien, daneben die aktuelle Rate. Der Verlauf liegt im Panel und
 * bleibt nach dem Stoppen eine Stunde sichtbar - praktisch nach Abstuerzen.
 */
export function NetHistory({ serverId }: { serverId: string }) {
  const { data } = useQuery({ queryKey: ['history', serverId], queryFn: () => api<{ step: number; points: Point[] }>(`/servers/${serverId}/history`), refetchInterval: 10_000 });
  const pts = data?.points ?? [];
  if (pts.length < 2) return null;
  const w = 220, h = 36;
  const top = Math.max(1, ...pts.map((p) => Math.max(p.rx, p.tx)));
  const t0 = pts[0]!.t, t1 = pts[pts.length - 1]!.t;
  const line = (key: 'rx' | 'tx') => pts.map((p) => `${((p.t - t0) / Math.max(1, t1 - t0)) * w},${h - (p[key] / top) * (h - 3) - 1.5}`).join(' ');
  const last = pts[pts.length - 1]!;
  const minutes = Math.round((t1 - t0) / 60_000);
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="min-w-0">
        <div className="text-xs text-dim">{t('net.title', { minutes })}</div>
        <div className="text-sm font-medium tabular-nums flex gap-3">
          <span className="inline-flex items-center gap-1"><ArrowDown className="size-3.5 text-led-install" aria-label={t('dash.down')} />{formatRate(last.rx)}</span>
          <span className="inline-flex items-center gap-1"><ArrowUp className="size-3.5 text-amber" aria-label={t('dash.up')} />{formatRate(last.tx)}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-40 sm:w-56 shrink-0" role="img" aria-label={t('net.chart', { max: formatRate(top) })}>
        <title>{t('net.chart', { max: formatRate(top) })}</title>
        <line x1="0" x2={w} y1={h - 1} y2={h - 1} stroke="#2C3749" />
        <polyline points={line('rx')} fill="none" stroke="#5B9DF5" strokeWidth="1.5" strokeLinejoin="round" />
        <polyline points={line('tx')} fill="none" stroke="#F2A93B" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
