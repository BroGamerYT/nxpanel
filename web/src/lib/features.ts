import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { About } from './version';

/**
 * Welche Bereiche die Gegenstelle kann.
 *
 * Der eigenstaendige NexusCore meldet unter /about eine Liste `features` und
 * kann bei weitem nicht alles, was das Panel kann. Die Oberflaeche blendet
 * dann Menuepunkte, Tabs und Seiten aus, die es dort nicht gibt, statt
 * "Nicht gefunden" zu zeigen.
 *
 * Fehlt die Angabe (das Panel), ist alles verfuegbar - fuer das Panel aendert
 * sich nichts.
 *
 * Bereiche: files, backups, schedules, players, subusers, logfiles, settings,
 * timeline, updates (je Server) sowie admin, help, account (ganze Seiten).
 */
export function useFeatures(): { standalone: boolean; has: (feature: string) => boolean } {
  const { data } = useQuery({ queryKey: ['about'], queryFn: () => api<About>('/about'), staleTime: 5 * 60_000 });
  return useMemo(() => {
    const list = data?.features;
    return {
      standalone: Boolean(data?.standalone),
      has: (feature: string) => !list || list.includes(feature),
    };
  }, [data]);
}
