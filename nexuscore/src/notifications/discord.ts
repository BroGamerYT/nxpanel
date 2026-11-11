import { logger } from '../logger.js';
import type { EventBus } from '../protocol/events.js';
import type { ServerRegistry } from '../store/registry.js';
import type { ServerStatus } from '../types.js';

/**
 * Discord-Benachrichtigungen (Admin -> Integrationen): Server gestartet,
 * gestoppt, abgestuerzt und Backups. Der Webhook ist ein Zugang und wird der
 * Oberflaeche nie im Klartext zurueckgegeben.
 */

const KEY = 'integrations.discord';

/**
 * Nur echte Discord-Webhooks: der Core ruft die Adresse selbst auf, eine
 * beliebige URL waere ein Weg, Anfragen ins lokale Netz zu schicken.
 */
export const DISCORD_WEBHOOK_PATTERN = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

interface Stored {
  url?: string | null;
  enabled?: boolean;
}

export interface DiscordPayload {
  title: string;
  description: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

const COOLDOWN_MS = 3000;
/** Ein Stopp, den wir selbst ausgeloest haben, gilt so lange als erwartet. */
const EXPECTED_STOP_MS = 10 * 60_000;

export class DiscordNotifier {
  private readonly lastStatus = new Map<string, ServerStatus>();
  private readonly expectedStop = new Map<string, number>();
  private readonly lastSent = new Map<string, number>();
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly deps: {
      registry: ServerRegistry;
      bus: EventBus;
      fetcher?: Fetcher;
    },
  ) {}

  // ----------------------------------------------------------- Einstellungen

  private stored(): Stored {
    return this.deps.registry.getSetting<Stored>(KEY) ?? {};
  }

  view(): { configured: boolean; url: string; enabled: boolean } {
    const s = this.stored();
    return {
      configured: Boolean(s.url),
      // Nur der Anfang - die Kennung hinten ist das Geheimnis
      url: s.url ? `${s.url.slice(0, 38)}...` : '',
      enabled: s.enabled !== false,
    };
  }

  update(patch: { url?: string | null; enabled?: boolean }): void {
    const cur = this.stored();
    this.deps.registry.setSetting(KEY, {
      ...cur,
      ...(patch.url !== undefined ? { url: patch.url || null } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
  }

  // ------------------------------------------------------------------ Senden

  /** true = zugestellt. Ohne Webhook oder bei ausgeschalteten Meldungen: false. */
  async send(payload: DiscordPayload, options: { force?: boolean } = {}): Promise<boolean> {
    const s = this.stored();
    if (!s.url || !DISCORD_WEBHOOK_PATTERN.test(s.url)) return false;
    if (s.enabled === false && !options.force) return false;
    const body = JSON.stringify({
      username: 'NexusCore',
      embeds: [
        {
          title: payload.title.slice(0, 250),
          description: payload.description.slice(0, 2000),
          color: payload.color,
          ...(payload.fields ? { fields: payload.fields } : {}),
          timestamp: new Date().toISOString(),
          footer: { text: 'NexusCore Benachrichtigungen' },
        },
      ],
      // Nie Erwaehnungen ausloesen, auch wenn ein Servername "@everyone" enthaelt
      allowed_mentions: { parse: [] },
    });
    try {
      const doFetch = this.deps.fetcher ?? ((u, i) => fetch(u, i));
      const res = await doFetch(s.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Discord-Meldung konnte nicht gesendet werden');
      return false;
    }
  }

  sendTest(by: string): Promise<boolean> {
    return this.send(
      {
        title: '🎉 Verbindungstest erfolgreich!',
        description: `Der Discord-Webhook von **NexusCore** funktioniert.\n\nAusgelöst von: **${by}**`,
        color: 0x10b981,
        fields: [
          { name: 'System', value: 'NexusCore', inline: true },
          { name: 'Status', value: 'Bereit', inline: true },
        ],
      },
      { force: true },
    );
  }

  private notify(serverId: string, kind: string, payload: DiscordPayload): void {
    const key = `${serverId}:${kind}`;
    const now = Date.now();
    if (now - (this.lastSent.get(key) ?? 0) < COOLDOWN_MS) return;
    this.lastSent.set(key, now);
    void this.send(payload);
  }

  // ------------------------------------------------------------ Ereignisse

  /** Ein Stopp, den der Core selbst ausloest - kein Absturz. */
  expectStop(serverId: string): void {
    this.expectedStop.set(serverId, Date.now());
  }

  private nameOf(serverId: string): string | undefined {
    return this.deps.registry.get(serverId)?.name;
  }

  private onState(serverId: string, status: ServerStatus, exitCode: number | undefined): void {
    const prev = this.lastStatus.get(serverId);
    this.lastStatus.set(serverId, status);
    const name = this.nameOf(serverId);
    // Gibt es den Server nicht mehr (geloescht) oder ist es ein Testserver, bleibt es still
    if (!name || serverId.startsWith('selftest-')) return;

    if (status === 'running' && prev !== 'running') {
      this.notify(serverId, 'start', { title: `🟢 Server gestartet: ${name}`, description: `Der Server **${name}** läuft.`, color: 0x10b981 });
      return;
    }
    if ((status === 'offline' || status === 'error') && (prev === 'running' || prev === 'starting' || prev === 'stopping')) {
      const asked = this.expectedStop.get(serverId);
      const expected = asked !== undefined && Date.now() - asked < EXPECTED_STOP_MS;
      if (expected) {
        this.expectedStop.delete(serverId);
        if (prev !== 'starting') {
          this.notify(serverId, 'stop', { title: `⏹️ Server gestoppt: ${name}`, description: `Der Server **${name}** wurde gestoppt.`, color: 0x64748b });
        }
        return;
      }
      this.notify(serverId, 'crash', {
        title: `🚨 Server abgestürzt: ${name}`,
        description: `Der Server **${name}** wurde unerwartet beendet${exitCode !== undefined ? ` (Exit-Code ${exitCode})` : ''}.`,
        color: 0xef4444,
      });
    }
  }

  /** Beginnt zu lauschen. Doppeltes Aufrufen ist harmlos. */
  start(): void {
    if (this.offs.length) return;
    this.offs.push(
      this.deps.bus.on((event) => {
        if (event.type === 'state') this.onState(event.serverId, event.state.status, event.state.exitCode);
      }),
      this.deps.registry.onAudit((e) => {
        if (e.action === 'server.stop' || e.action === 'server.kill' || e.action === 'server.restart') {
          if (e.serverId) this.expectStop(e.serverId);
          return;
        }
        const name = e.serverId ? this.nameOf(e.serverId) : undefined;
        if (!e.serverId || !name || e.serverId.startsWith('selftest-')) return;
        if (e.action === 'backup.create') {
          const bytes = typeof e.detail?.['bytes'] === 'number' ? (e.detail['bytes'] as number) : undefined;
          this.notify(e.serverId, 'backup', {
            title: `💾 Backup erstellt: ${name}`,
            description: `Von **${name}** wurde ein Backup erstellt${bytes !== undefined ? ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)` : ''}.`,
            color: 0x8b5cf6,
          });
        } else if (e.action === 'backup.failed') {
          this.notify(e.serverId, 'backup-failed', { title: `⚠️ Backup fehlgeschlagen: ${name}`, description: `Das Backup von **${name}** ist fehlgeschlagen.`, color: 0xf59e0b });
        }
      }),
    );
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }
}
