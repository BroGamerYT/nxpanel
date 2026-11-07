import { useQuery } from '@tanstack/react-query';
import { Gauge, Users, Wifi } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

export interface GameStatusData {
  running: boolean;
  ping?: { version: string | null; players: { online: number; max: number; sample: string[] }; motd: string; favicon: string | null; latencyMs: number } | { error: string } | null;
  tps?: { tps: number; mspt: number | null; source: string } | { error: string } | null;
  players?: string[] | null;
  rcon?: boolean;
  kind?: string;
  people?: Array<{ name: string; id?: string }>;
  actions?: string[];
  max?: number | null;
  version?: string | null;
  latencyMs?: number | null;
  map?: string | null;
}

export function useGameStatus(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['game-status', serverId], enabled,
    queryFn: () => api<GameStatusData>(`/servers/${serverId}/game-status`),
    refetchInterval: 10_000, retry: false,
  });
}

const ok = <T extends object>(x: T | { error: string } | null | undefined): x is T => !!x && !('error' in x);

/** Kopfzeile: Spieler, TPS, Antwortzeit - direkt aus dem Spiel, fuer jeden Minecraft-Typ. */
export function GameLive({ data }: { data: GameStatusData | undefined }) {
  if (!data?.running) return null;
  const ping = ok(data.ping) ? data.ping : null;
  const tps = ok(data.tps) ? data.tps : null;
  const online = data.people?.length ?? data.players?.length ?? ping?.players.online;
  const max = data.max ?? ping?.players.max;
  const latency = ping?.latencyMs ?? data.latencyMs ?? null;
  const isMc = data.kind === undefined || data.kind === 'minecraft';
  const tone = !tps ? 'text-dim' : tps.tps >= 19 ? 'text-led-run' : tps.tps >= 15 ? 'text-led-start' : 'text-led-crash';
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      <span className="inline-flex items-center gap-1.5" title={(data.people?.map((p) => p.name) ?? data.players)?.join(', ') || ping?.players.sample.join(', ') || undefined}>
        <Users className="size-3.5 text-dim" aria-hidden /><span className="text-dim">{t('game.players')}</span>
        <span className="font-medium tabular-nums">{online ?? '–'}{max ? ` / ${max}` : ''}</span>
      </span>
      {isMc && <span className="inline-flex items-center gap-1.5" title={tps ? `${tps.source}${tps.mspt !== null ? ` · ${tps.mspt} ms/Tick` : ''}` : data.tps && 'error' in data.tps ? data.tps.error : undefined}>
        <Gauge className="size-3.5 text-dim" aria-hidden /><span className="text-dim">TPS</span>
        <span className={`font-medium tabular-nums ${tone}`}>{tps ? tps.tps.toFixed(1) : '–'}</span>
        {tps?.mspt != null && <span className="text-xs text-dim tabular-nums">({tps.mspt.toFixed(1)} ms)</span>}
      </span>}
      <span className="inline-flex items-center gap-1.5" title={data.ping && 'error' in data.ping ? data.ping.error : undefined}>
        <Wifi className="size-3.5 text-dim" aria-hidden /><span className="text-dim">{t('game.ping')}</span>
        <span className="font-medium tabular-nums">{latency !== null ? `${latency} ms` : '–'}</span>
      </span>
      {(ping?.version ?? data.version) && <span className="text-dim">{ping?.version ?? data.version}</span>}
      {data.map && <span className="text-dim">{data.map}</span>}
    </div>
  );
}
