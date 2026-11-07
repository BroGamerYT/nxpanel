import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { t } from './i18n';
import type { ServerStatus, Stats, TimelineEvent } from './types';

type Msg =
  | { type: 'hello'; status: ServerStatus; consoleMode: string; canCommand: boolean; name: string }
  | { type: 'log'; lines: string[]; history?: boolean; dropped?: number }
  | { type: 'status'; status: ServerStatus }
  | { type: 'event'; event: TimelineEvent }
  | { type: 'stats'; stats: Stats; ts: number }
  | { type: 'error'; message: string; code?: string };

export interface StatPoint extends Stats { ts: number }

const MAX_POINTS = 90; // 3 Minuten bei einem Wert alle 2 s

/**
 * Live-Verbindung zu einem Server. Baut sich nach Abbruch selbst wieder auf
 * (1 s, 2 s, 4 s … bis 30 s) - etwa wenn das Panel per deploy.bat neu startet.
 */
export function useLive(serverId: string, onLines: (lines: string[], meta: { history?: boolean; dropped?: number }) => void) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [canCommand, setCanCommand] = useState(false);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<StatPoint[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onLinesRef = useRef(onLines);
  onLinesRef.current = onLines;

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function connect() {
      try {
        const { ticket } = await api<{ ticket: string }>(`/servers/${serverId}/ws-ticket`, { method: 'POST' });
        if (stopped) return;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/api/v1/servers/${serverId}/ws?ticket=${encodeURIComponent(ticket)}`);
        wsRef.current = ws;
        ws.onopen = () => { attempt = 0; setConnected(true); };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data as string) as Msg;
          switch (m.type) {
            case 'hello': setStatus(m.status); setCanCommand(m.canCommand); setLastError(null); break;
            case 'log': onLinesRef.current(m.lines, { ...(m.history ? { history: true } : {}), ...(m.dropped ? { dropped: m.dropped } : {}) }); break;
            case 'status': setStatus(m.status); break;
            case 'event': setEvents((ev) => [m.event, ...ev].slice(0, 50)); break;
            case 'stats': setStats((s) => [...s, { ...m.stats, ts: m.ts }].slice(-MAX_POINTS)); break;
            case 'error': setLastError(m.message); break;
          }
        };
        ws.onclose = (e) => {
          setConnected(false);
          wsRef.current = null;
          if (stopped) return;
          if (e.code === 4403) { setLastError(t('live.noAccess')); return; }
          schedule();
        };
      } catch {
        schedule();
      }
    }
    function schedule() {
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      timer = setTimeout(() => void connect(), delay);
    }

    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [serverId]);

  const sendCommand = useCallback((cmd: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    wsRef.current.send(JSON.stringify({ type: 'command', data: cmd }));
    return true;
  }, []);

  return { status, canCommand, connected, stats, events, lastError, sendCommand, clearError: () => setLastError(null) };
}
