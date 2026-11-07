import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Check } from 'lucide-react';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import type { AllocationRow, NodeInfo } from '../lib/types';
import { Button, ErrorBox, Field, Input, Led, Spinner } from '../components/ui';
import { t, tn, fmtDateTime } from '../lib/i18n';

/**
 * Netzwerk (nur Admins): oeffentliche Adresse und Port-Bereich festlegen,
 * alle vergebenen Ports sehen - und die fertigen Regeln fuer den
 * Proxmox-Host zum Kopieren, passend zum eingestellten Bereich.
 */
export function Network() {
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: () => api<{ nodes: NodeInfo[] }>('/admin/nodes') });
  const allocs = useQuery({ queryKey: ['allocations'], queryFn: () => api<{ allocations: AllocationRow[] }>('/admin/allocations'), refetchInterval: 10_000 });
  const node = nodes.data?.nodes[0];

  return (
    <div className="max-w-5xl space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('network.title')}</h1>
        <p className="text-dim text-sm mt-1">{t('network.intro')}</p>
      </header>
      {nodes.isLoading && <Spinner />}
      {node && <NodeSettings node={node} />}
      {node && <ProxmoxRules node={node} />}
      <NetCheck />
      <section className="space-y-3">
        <h2 className="font-medium">{t('network.allocated')}</h2>
        {allocs.isLoading ? <Spinner /> : <AllocationTable rows={allocs.data?.allocations ?? []} host={node?.publicHost ?? null} />}
      </section>
    </div>
  );
}

function NodeSettings({ node }: { node: NodeInfo }) {
  const qc = useQueryClient();
  const [host, setHost] = useState(node.publicHost ?? '');
  const [from, setFrom] = useState(node.portFrom?.toString() ?? '');
  const [to, setTo] = useState(node.portTo?.toString() ?? '');
  useEffect(() => { setHost(node.publicHost ?? ''); setFrom(node.portFrom?.toString() ?? ''); setTo(node.portTo?.toString() ?? ''); }, [node]);

  const save = useMutation({
    mutationFn: () => api<{ outside: Array<{ name: string; port: number }> }>(`/admin/nodes/${node.id}`, {
      method: 'PATCH',
      body: {
        publicHost: host.trim() || null,
        portFrom: from ? Number(from) : null,
        portTo: to ? Number(to) : null,
      },
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['nodes'] }); void qc.invalidateQueries({ queryKey: ['allocations'] }); void qc.invalidateQueries({ queryKey: ['servers'] }); },
  });
  const size = from && to ? Number(to) - Number(from) + 1 : 0;

  return (
    <section className="space-y-5 rounded-lg border border-seam bg-rack p-5">
      <h2 className="font-medium">{t('network.publicAccess')}</h2>
      <Field label={t('network.publicHost')} htmlFor="host" hint={t('network.publicHostHint')}>
        <Input id="host" value={host} onChange={(e) => setHost(e.target.value)} placeholder={t('network.publicHostPlaceholder')} />
      </Field>
      <div className="grid sm:grid-cols-2 gap-5">
        <Field label={t('network.portFrom')} htmlFor="from">
          <Input id="from" type="number" min={1024} max={65535} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="28000" />
        </Field>
        <Field label={t('network.portTo')} htmlFor="to" hint={size > 0 ? t('network.rangeSize', { size, servers: Math.floor(size / 2) }) : undefined}>
          <Input id="to" type="number" min={1024} max={65535} value={to} onChange={(e) => setTo(e.target.value)} placeholder="28999" />
        </Field>
      </div>
      <p className="text-sm text-dim">{t('network.rangeNote')}</p>
      {save.error && <ErrorBox>{(save.error as Error).message}</ErrorBox>}
      {save.data && save.data.outside.length > 0 && (
        <div className="rounded-md border border-led-start/40 bg-led-start/10 px-3 py-2 text-sm">
          {t('network.outside')}{' '}
          {save.data.outside.map((o) => `${o.name} (${o.port})`).join(', ')}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="primary" busy={save.isPending} disabled={(from === '') !== (to === '')} onClick={() => save.mutate()}>{t('common.save')}</Button>
      </div>
    </section>
  );
}

interface CheckResult { key: 'dns' | 'https' | 'publicIp' | 'clock'; ok: boolean | null; value: string | null; detail: string | null }

/** Verbindungstest - vor allem fuer ARK (Epic Online Services). */
function NetCheck() {
  const check = useMutation({ mutationFn: () => api<{ results: CheckResult[] }>('/admin/network/check') });
  const text = (r: CheckResult) => {
    switch (r.key) {
      case 'dns': return r.ok ? t('netcheck.dnsOk', { ip: r.value ?? '' }) : t('netcheck.dnsFail', { error: r.detail ?? '' });
      case 'https': return r.ok ? t('netcheck.httpsOk', { status: r.value ?? '' }) : t('netcheck.httpsFail', { error: r.detail ?? '' });
      case 'publicIp': return r.value === null ? t('netcheck.ipFail', { error: r.detail ?? '' })
        : r.ok === false ? t('netcheck.ipMismatch', { ip: r.value, configured: r.detail ?? '' })
        : r.ok ? t('netcheck.ipOk', { ip: r.value }) : t('netcheck.ipUnknown', { ip: r.value });
      case 'clock': return r.value === null ? t('netcheck.clockUnknown') : r.ok ? t('netcheck.clockOk', { s: r.value }) : t('netcheck.clockFail', { s: r.value });
    }
  };
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-medium">{t('netcheck.title')}</h2>
          <p className="text-sm text-dim mt-1">{t('netcheck.intro')}</p>
        </div>
        <Button className="shrink-0" busy={check.isPending} onClick={() => check.mutate()}>{t('netcheck.run')}</Button>
      </div>
      {check.error && <ErrorBox>{(check.error as Error).message}</ErrorBox>}
      {check.data && (
        <ul className="rounded-lg border border-seam divide-y divide-seam text-sm">
          {check.data.results.map((r) => (
            <li key={r.key} className="flex gap-3 px-4 py-2.5">
              <span className={`mt-1.5 size-2.5 rounded-full shrink-0 ${r.ok === true ? 'bg-led-run' : r.ok === false ? 'bg-led-crash' : 'bg-led-stop'}`} aria-hidden />
              <span><span className="block font-medium">{t(`netcheck.${r.key}`)}</span><span className="block text-dim">{text(r)}</span></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProxmoxRules({ node }: { node: NodeInfo }) {
  const [copied, setCopied] = useState(false);
  if (!node.portFrom || !node.portTo) return null;
  const pub = node.publicHost && /^\d+\.\d+\.\d+\.\d+$/.test(node.publicHost) ? node.publicHost : 'DEINE.OEFFENTLICHE.IP';
  // Ziel = die interne IP der Panel-VM. Kennt die Seite sie nicht (Aufruf ueber Domain oder localhost), Platzhalter.
  const target = /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) && !location.hostname.startsWith('127.') ? location.hostname : 'IP.DER.PANEL.VM';
  const range = `${node.portFrom}:${node.portTo}`;
  const lines = [
    `    # NexusPanel: Spielports ${node.portFrom}-${node.portTo} an die Panel-VM`,
    ...(['tcp', 'udp'] as const).flatMap((p) => [
      `    post-up iptables -t nat -A PREROUTING -d ${pub} -p ${p} --dport ${range} -j DNAT --to-destination ${target}`,
      `    post-up iptables -A FORWARD -d ${target} -p ${p} --dport ${range} -j ACCEPT`,
      `    post-down iptables -t nat -D PREROUTING -d ${pub} -p ${p} --dport ${range} -j DNAT --to-destination ${target} 2>/dev/null || true`,
      `    post-down iptables -D FORWARD -d ${target} -p ${p} --dport ${range} -j ACCEPT 2>/dev/null || true`,
    ]),
  ].join('\n');
  // Sofort wirksam, ohne ifreload: ifreload fuehrt ALLE post-up-Zeilen erneut
  // aus und wuerde bestehende Regeln (z. B. fuer AMP) doppelt anlegen.
  const now = lines.split('\n').filter((l) => l.includes('post-up')).map((l) => l.replace(/^\s*post-up\s+/, '')).join('\n');

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="font-medium">{t('network.rulesTitle')}</h2>
          <p className="text-sm text-dim mt-1">{tn('network.rulesHint', { file: <code className="font-mono text-[13px]">/etc/network/interfaces</code> })}</p>
        </div>
        <Button onClick={async () => { setCopied(await copyText(lines)); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? <Check className="size-4 text-led-run" /> : <Copy className="size-4" />} {t('common.copy')}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-seam bg-[#0F141C] p-4 text-[12.5px] leading-relaxed font-mono text-ink/90">{lines}</pre>
      <p className="text-sm text-dim">{tn('network.rulesNow', { cmd: <code className="font-mono text-[13px]">ifreload</code> })}</p>
      <CopyBlock text={now} />
      {pub === 'DEINE.OEFFENTLICHE.IP' && <p className="text-sm text-dim">{t('network.enterIp')}</p>}
    </section>
  );
}

function AllocationTable({ rows, host }: { rows: AllocationRow[]; host: string | null }) {
  if (!rows.length) return <p className="text-sm text-dim">{t('network.noPorts')}</p>;
  return (
    <div className="rounded-lg border border-seam overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-rack text-dim text-left">
          <tr>
            <th className="font-medium px-4 py-2.5">{t('network.col.port')}</th>
            <th className="font-medium px-4 py-2.5">{t('network.col.purpose')}</th>
            <th className="font-medium px-4 py-2.5">{t('network.col.server')}</th>
            <th className="font-medium px-4 py-2.5 hidden md:table-cell">{t('servers.col.owner')}</th>
            <th className="font-medium px-4 py-2.5 hidden md:table-cell">{t('network.col.outside')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-seam">
          {rows.map((r) => (
            <tr key={`${r.port}-${r.protocol}`}>
              <td className="px-4 py-2.5 font-mono text-[13px]">{r.port}<span className="text-dim">/{r.protocol}</span></td>
              <td className="px-4 py-2.5 text-dim">{r.ref === 'game' ? t('network.refGame') : r.ref === 'rcon' ? 'RCON' : r.ref ?? '–'}</td>
              <td className="px-4 py-2.5">
                {r.server ? (
                  <Link to={`/server/${r.server.shortId}`} className="inline-flex items-center gap-2 hover:text-amber"><Led status={r.server.status} />{r.server.name}</Link>
                ) : <span className="text-dim">{t('network.freeFrom', { time: fmtDateTime(r.cooldownUntil!, { timeStyle: 'short' }) })}</span>}
              </td>
              <td className="px-4 py-2.5 text-dim hidden md:table-cell">{r.server?.owner ?? '–'}</td>
              <td className="px-4 py-2.5 hidden md:table-cell">
                {r.inRange
                  ? <span className="font-mono text-[13px]">{host ? `${host}:${r.port}` : t('common.yes')}</span>
                  : <span className="text-led-start">{t('network.outsideRange')}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-seam bg-[#0F141C] p-4 pr-28 text-[12.5px] leading-relaxed font-mono text-ink/90">{text}</pre>
      <Button className="absolute right-3 top-3" onClick={async () => { setCopied(await copyText(text)); setTimeout(() => setCopied(false), 1500); }}>
        {copied ? <Check className="size-4 text-led-run" /> : <Copy className="size-4" />} {t('common.copy')}
      </Button>
    </div>
  );
}
