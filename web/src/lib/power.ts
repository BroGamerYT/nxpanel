import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { t } from './i18n';
import type { ServerListItem, ServerStatus } from './types';
import { useToast } from './toast';

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

/** Power-Knopf: Optimistischer Statuswechsel, dann API, dann Rollback bei Fehler. */
export function usePower(serverId: string) {
  const qc = useQueryClient();
  const { success, error } = useToast();
  return useMutation({
    mutationFn: (action: PowerAction) => api(`/servers/${serverId}/power`, { method: 'POST', body: { action } }),
    onMutate: async (action) => {
      // Alle abfragen für diese Server-ID abbrechen
      await qc.cancelQueries({ queryKey: ['server', serverId] });
      await qc.cancelQueries({ queryKey: ['servers'] });

      // Aktuelle Werte sichern für Rollback
      const previousServer = qc.getQueryData<{ server: ServerListItem } | null>(['server', serverId]);
      const previousServers = qc.getQueryData<{ servers: ServerListItem[] } | null>(['servers']);

      // Optimistisch den Status setzen
      const next = NEXT_STATUS[action];
      qc.setQueryData<{ server: ServerListItem } | null>(['server', serverId], (old) =>
        old ? { server: { ...old.server, status: next } } : old
      );
      qc.setQueryData<{ servers: ServerListItem[] } | null>(['servers'], (old) =>
        old ? { servers: old.servers.map((s) => s.id === serverId ? { ...s, status: next } : s) } : old
      );

      return { previousServer, previousServers, action };
    },
    onError: (err, variables, context) => {
      // Rollback auf vorherigen Stand
      qc.setQueryData(['server', serverId], context?.previousServer);
      qc.setQueryData(['servers'], context?.previousServers);
      error(
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
