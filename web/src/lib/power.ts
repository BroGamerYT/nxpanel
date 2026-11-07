import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { t } from './i18n';

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';

export const POWER_LABEL: Record<PowerAction, string> = {
  get start() { return t('power.start'); },
  get stop() { return t('power.stop'); },
  get restart() { return t('power.restart'); },
  get kill() { return t('power.kill'); },
};

/** Power-Knopf: Anfrage schicken, Liste und Detail neu laden. Der echte Verlauf kommt live. */
export function usePower(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: PowerAction) => api(`/servers/${serverId}/power`, { method: 'POST', body: { action } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['server', serverId] });
    },
  });
}
