import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { t } from './i18n';
import type { ServerDetail, ServerListItem, ServerStatus } from './types';
import { toast } from './toast';

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';

export const POWER_LABEL: Record<PowerAction, string> = {
  get start() { return t('power.start'); },
  get stop() { return t('power.stop'); },
  get restart() { return t('power.restart'); },
  get kill() { return t('power.kill'); },
};

const NEXT_STATUS: Record<PowerAction, ServerStatus> = {
  start: 'starting',
  stop: 'stopping',
  restart: 'stopping',
  kill: 'stopping',
};

/**
 * Power-Knopf: Optimistischer Statuswechsel, dann API, dann Rollback bei Fehler.
 * Dadurch fühlt sich Start/Stopp sofort an, statt auf die Server-Antwort zu warten.
 */
export function usePower(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: PowerAction) => api(`/servers/${serverId}/power`, { method: 'POST', body: { action } }),
    onMutate: async (action) => {
      // Laufende Abfragen abbrechen, damit sie das optimistische Update nicht überschreiben
      await qc.cancelQueries({ queryKey: ['server', serverId] });
      await qc.cancelQueries({ queryKey: ['servers'] });

      // Aktuellen Stand für Rollback sichern
      const previousServer = qc.getQueryData<ServerDetail>(['server', serverId]);
      const previousServers = qc.getQueryData<{ servers: ServerListItem[] }>(['servers']);

      // Optimistisch den Status setzen
      const next = NEXT_STATUS[action];
      if (previousServer) {
        qc.setQueryData<ServerDetail>(['server', serverId], {
          ...previousServer,
          server: { ...previousServer.server, status: next },
        });
      }
      qc.setQueryData<{ servers: ServerListItem[] }>(['servers'], (old) =>
        old ? { ...old, servers: old.servers.map((s) => s.id === serverId ? { ...s, status: next } : s) } : old
      );

      return { previousServer, previousServers };
    },
    onError: (err, variables, context) => {
      // Rollback auf vorherigen Stand
      qc.setQueryData(['server', serverId], context?.previousServer);
      qc.setQueryData(['servers'], context?.previousServers);
      toast.error(
        t('power.errorTitle', { action: POWER_LABEL[variables] }),
        err instanceof Error ? err.message : t('common.errorCode', { code: 'unknown' })
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['server', serverId] });
    },
  });
}
