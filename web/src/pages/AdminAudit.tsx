import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Input, Spinner } from '../components/ui';
import type { AuditEntry } from '../lib/types';
import { History, Search, Shield, Filter, ArrowRight } from 'lucide-react';

export function AdminAudit() {
  const [actionFilter, setActionFilter] = useState('');
  const [limit, setLimit] = useState(100);

  const { data, isLoading, refetch } = useQuery<{ entries: AuditEntry[]; nextBefore: number | null }>({
    queryKey: ['admin-audit', actionFilter, limit],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('limit', String(limit));
      if (actionFilter.trim()) p.set('action', actionFilter.trim());
      return api(`/admin/audit?${p.toString()}`);
    },
  });

  const entries = data?.entries ?? [];

  return (
    <div className="max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-5 rounded-xl border border-seam bg-rack">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2 text-ink">
            <History className="size-6 text-amber" />
            Audit-Protokoll
          </h1>
          <p className="text-sm text-dim mt-1">
            Chronologisches Sicherheitsprotokoll aller Aktionen (Wer hat wann welchen Server geändert, gestartet oder gelöscht).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="quiet" onClick={() => refetch()}>
            Aktualisieren
          </Button>
        </div>
      </div>

      {/* Filterleiste */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="size-4 absolute left-3.5 top-3 text-dim" />
          <Input
            placeholder="Aktion filtern (z. B. server., subuser., user., schedule.)..."
            className="pl-10"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={actionFilter === 'server.' ? 'primary' : 'quiet'}
            onClick={() => setActionFilter(actionFilter === 'server.' ? '' : 'server.')}
          >
            Server
          </Button>
          <Button
            variant={actionFilter === 'subuser.' ? 'primary' : 'quiet'}
            onClick={() => setActionFilter(actionFilter === 'subuser.' ? '' : 'subuser.')}
          >
            Mitnutzer
          </Button>
          <Button
            variant={actionFilter === 'user.' ? 'primary' : 'quiet'}
            onClick={() => setActionFilter(actionFilter === 'user.' ? '' : 'user.')}
          >
            Benutzer
          </Button>
        </div>
      </div>

      {/* Audit Liste */}
      {isLoading ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <div className="p-8 text-center rounded-xl border border-dashed border-seam text-dim">
          <Shield className="size-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Keine Protokolleinträge gefunden.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-seam bg-rack">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-seam bg-rack-2/40 text-dim text-xs font-medium uppercase tracking-wider">
                <th className="px-5 py-3.5">Zeitpunkt</th>
                <th className="px-5 py-3.5">Akteur</th>
                <th className="px-5 py-3.5">Aktion</th>
                <th className="px-5 py-3.5">Server</th>
                <th className="px-5 py-3.5">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-seam">
              {entries.map((entry) => {
                const date = new Date(entry.created_at).toLocaleString('de-DE');
                const metaStr = entry.metadata ? JSON.stringify(entry.metadata) : null;

                return (
                  <tr key={entry.id} className="hover:bg-rack-2/30 transition-colors">
                    <td className="px-5 py-3 text-xs text-dim whitespace-nowrap">
                      {date}
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-ink flex items-center gap-2">
                        <span className="size-6 rounded-full bg-amber/15 text-amber text-[10px] font-bold flex items-center justify-center">
                          {(entry.actor_name ?? 'Sys').slice(0, 2).toUpperCase()}
                        </span>
                        <span>{entry.actor_name ?? 'System'}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className="inline-block px-2 py-0.5 rounded text-xs font-mono bg-rack-2 border border-seam text-amber">
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-dim">
                      {entry.server_name ?? (entry.server_id ? entry.server_id.slice(0, 8) : '–')}
                    </td>
                    <td className="px-5 py-3 text-xs text-dim max-w-xs truncate font-mono">
                      {metaStr ?? '–'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
