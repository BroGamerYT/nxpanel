import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Globe,
  Send,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Key,
  Radio,
  FileCode2,
  Sparkles,
  Info,
  ChevronLeft,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorBox, Field, Input, Spinner } from '../components/ui';

interface IntegrationsData {
  discord: {
    configured: boolean;
    url: string;
    enabled: boolean;
  };
  playit: {
    configured: boolean;
    secretKey: string;
  };
}

export function Integrations() {
  const queryClient = useQueryClient();
  const [discordUrl, setDiscordUrl] = useState('');
  const [playitKey, setPlayitKey] = useState('');
  const [testSuccess, setTestSuccess] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<IntegrationsData>({
    queryKey: ['admin-integrations'],
    queryFn: () => api<IntegrationsData>('/admin/integrations'),
  });

  const saveDiscord = useMutation({
    mutationFn: (body: { url?: string; enabled?: boolean }) =>
      api('/admin/integrations/discord', { method: 'POST', body }),
    onSuccess: () => {
      setDiscordUrl('');
      void queryClient.invalidateQueries({ queryKey: ['admin-integrations'] });
    },
  });

  const testDiscord = useMutation({
    mutationFn: () => api('/admin/integrations/discord/test', { method: 'POST' }),
    onSuccess: () => {
      setTestError(null);
      setTestSuccess('Testnachricht erfolgreich an Discord gesendet!');
      setTimeout(() => setTestSuccess(null), 4000);
    },
    onError: (err) => {
      setTestSuccess(null);
      setTestError((err as Error).message);
    },
  });

  const savePlayit = useMutation({
    mutationFn: (body: { secretKey?: string }) =>
      api('/admin/integrations/playit', { method: 'POST', body }),
    onSuccess: () => {
      setPlayitKey('');
      void queryClient.invalidateQueries({ queryKey: ['admin-integrations'] });
    },
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox>{(error as Error).message}</ErrorBox>;

  return (
    <div className="max-w-4xl space-y-8">
      <Link
        to="/admin"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-dim hover:text-amber transition-colors"
      >
        <ChevronLeft className="size-4" />
        Zurück zum Admin-Hub
      </Link>

      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-ink">Integrationen & Erweiterungen</h1>
        <p className="text-sm text-dim mt-1">
          Verbinde NexusPanel mit externen Diensten wie Discord-Webhooks, Tunneling für Spieler ohne Portweiterleitung und interaktiver API-Dokumentation (Scalar).
        </p>
      </div>

      {/* Sektion 1: Discord Webhooks */}
      <section className="rounded-xl border border-seam bg-rack p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-seam pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[#5865F2]/10 text-[#5865F2] border border-[#5865F2]/20">
              <Bell className="size-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink">Discord Webhook-Benachrichtigungen</h2>
              <p className="text-xs text-dim">
                Automatische Benachrichtigungen bei Server-Start, Stopp, Abstürzen, Auto-Sleep und Backups.
              </p>
            </div>
          </div>
          <span
            className={`text-xs font-mono px-2.5 py-1 rounded-full border ${
              data?.discord.configured
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-dim/10 text-dim border-seam'
            }`}
          >
            {data?.discord.configured ? 'Eingerichtet' : 'Nicht konfiguriert'}
          </span>
        </div>

        <div className="space-y-4 max-w-xl">
          <Field
            label="Discord Webhook-URL"
            htmlFor="discord-url"
            hint={
              data?.discord.configured
                ? `Aktuell gesetzt: ${data.discord.url} (Neuen Link eingeben zum Ändern)`
                : 'Erstelle in Discord unter Kanaleinstellungen -> Integrationen -> Webhooks einen neuen Webhook.'
            }
          >
            <div className="flex gap-2">
              <Input
                id="discord-url"
                type="password"
                placeholder="https://discord.com/api/webhooks/..."
                value={discordUrl}
                onChange={(e) => setDiscordUrl(e.target.value)}
                autoComplete="off"
              />
              <Button
                variant="primary"
                onClick={() => saveDiscord.mutate({ url: discordUrl })}
                disabled={!discordUrl.trim() || saveDiscord.isPending}
                busy={saveDiscord.isPending}
              >
                Speichern
              </Button>
            </div>
          </Field>

          {data?.discord.configured && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <label className="flex items-center gap-2.5 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={data.discord.enabled}
                  onChange={(e) => saveDiscord.mutate({ enabled: e.target.checked })}
                  className="accent-amber size-4"
                />
                <span className="text-ink font-medium">Benachrichtigungen aktiv</span>
              </label>

              <Button
                variant="quiet"
                className="text-xs h-8"
                onClick={() => testDiscord.mutate()}
                disabled={testDiscord.isPending}
                busy={testDiscord.isPending}
              >
                <Send className="size-3.5 mr-1.5" />
                Testnachricht senden
              </Button>
            </div>
          )}

          {testSuccess && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
              <CheckCircle2 className="size-4 shrink-0" />
              <span>{testSuccess}</span>
            </div>
          )}
          {testError && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              <AlertTriangle className="size-4 shrink-0" />
              <span>{testError}</span>
            </div>
          )}
        </div>
      </section>

      {/* Sektion 2: Integriertes Tunneling (Playit.gg) */}
      <section className="rounded-xl border border-seam bg-rack p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-seam pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Globe className="size-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink">Integriertes Tunneling (Playit.gg)</h2>
              <p className="text-xs text-dim">
                Ermöglicht Spielern den Beitritt über das Internet – ohne Portweiterleitung im Router oder IPv4/DS-Lite-Probleme.
              </p>
            </div>
          </div>
          <span
            className={`text-xs font-mono px-2.5 py-1 rounded-full border ${
              data?.playit.configured
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-dim/10 text-dim border-seam'
            }`}
          >
            {data?.playit.configured ? 'Aktiv' : 'Optional'}
          </span>
        </div>

        <div className="space-y-4 max-w-xl">
          <div className="p-3.5 rounded-lg bg-rack-2/60 border border-seam text-xs text-dim space-y-2">
            <div className="flex items-center gap-2 text-ink font-medium">
              <Info className="size-4 text-amber" />
              <span>Wie funktioniert das Tunneling?</span>
            </div>
            <p>
              Playit.gg leitet Spielerverbindungen (TCP & UDP) über ein weltweites Anycast-Netzwerk direkt an deinen Server weiter. Freunde können über eine kostenlose Domain (z. B. <code className="text-amber">meinserver.ply.gg:12345</code>) beitreten, selbst wenn dein Internetanschluss keine öffentliche IPv4 hat.
            </p>
            <a
              href="https://playit.gg"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-amber hover:underline pt-1"
            >
              Playit.gg Account & Secret Key erstellen <ExternalLink className="size-3" />
            </a>
          </div>

          <Field
            label="Playit.gg Secret Key"
            htmlFor="playit-key"
            hint={
              data?.playit.configured
                ? `Aktuell gesetzt: ${data.playit.secretKey}`
                : 'Trage deinen Secret Key von playit.gg ein, um Tunnel-Verbindungen zu aktivieren.'
            }
          >
            <div className="flex gap-2">
              <Input
                id="playit-key"
                type="password"
                placeholder="Secret Key einfügen..."
                value={playitKey}
                onChange={(e) => setPlayitKey(e.target.value)}
                autoComplete="off"
              />
              <Button
                variant="primary"
                onClick={() => savePlayit.mutate({ secretKey: playitKey })}
                disabled={!playitKey.trim() || savePlayit.isPending}
                busy={savePlayit.isPending}
              >
                Speichern
              </Button>
            </div>
          </Field>
        </div>
      </section>

      {/* Sektion 3: Scalar API-Browser */}
      <section className="rounded-xl border border-seam bg-rack p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-seam pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <FileCode2 className="size-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink">Scalar API-Browser & Dokumentation</h2>
              <p className="text-xs text-dim">
                Moderne, interaktive REST-API Dokumentation (wie in AMP 3) für Entwickler, Bots und Integrationen.
              </p>
            </div>
          </div>
          <span className="text-xs font-mono px-2.5 py-1 rounded-full border bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
            OpenAPI 3.1
          </span>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-1">
          <p className="text-xs text-dim max-w-md">
            Über die integrierte Scalar-Oberfläche kannst du alle NexusPanel-Endpunkte interaktiv testen, API-Keys ausprobieren und eigene Discord-Bots oder Skripte anbinden.
          </p>
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rack-2 hover:bg-seam border border-seam text-sm font-medium text-ink transition-colors"
          >
            <span>Scalar API öffnen</span>
            <ExternalLink className="size-4 text-amber" />
          </a>
        </div>
      </section>
    </div>
  );
}
