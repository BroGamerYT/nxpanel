import { getSetting, DISCORD_WEBHOOK_URL, DISCORD_NOTIFICATIONS_ENABLED } from '../settings.js';
import { log } from '../log.js';

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordNotificationPayload {
  title: string;
  description: string;
  color: number;
  fields?: DiscordEmbedField[];
}

export async function sendDiscordWebhook(payload: DiscordNotificationPayload): Promise<boolean> {
  const url = await getSetting(DISCORD_WEBHOOK_URL);
  if (!url || !url.trim().startsWith('http')) return false;

  const enabled = await getSetting(DISCORD_NOTIFICATIONS_ENABLED);
  if (enabled === 'false' || enabled === '0') return false;

  const body = {
    username: 'NexusPanel',
    avatar_url: 'https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/server.png',
    embeds: [
      {
        title: payload.title,
        description: payload.description,
        color: payload.color,
        fields: payload.fields,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'NexusPanel Notification System',
        },
      },
    ],
  };

  try {
    const res = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    log.warn({ err }, 'Discord-Webhook konnte nicht gesendet werden');
    return false;
  }
}

export async function notifyServerStatus(
  event: 'start' | 'stop' | 'crash' | 'auto_sleep' | 'wake_on_join' | 'backup',
  serverName: string,
  details?: string,
): Promise<void> {
  const titles: Record<string, { title: string; color: number; icon: string }> = {
    start: { title: `🟢 Server gestartet: ${serverName}`, color: 0x10b981, icon: '🟢' },
    stop: { title: `⏹️ Server gestoppt: ${serverName}`, color: 0x64748b, icon: '⏹️' },
    crash: { title: `🚨 Server abgestürzt: ${serverName}`, color: 0xef4444, icon: '🚨' },
    auto_sleep: { title: `🌙 Ruhemodus aktiviert: ${serverName}`, color: 0x38bdf8, icon: '🌙' },
    wake_on_join: { title: `⚡ Server aufgeweckt: ${serverName}`, color: 0xf59e0b, icon: '⚡' },
    backup: { title: `💾 Backup erstellt: ${serverName}`, color: 0x8b5cf6, icon: '💾' },
  };

  const meta = titles[event] ?? { title: `Server-Ereignis: ${serverName}`, color: 0x94a3b8, icon: 'ℹ️' };

  await sendDiscordWebhook({
    title: meta.title,
    description: details || `Der Server **${serverName}** hat den Status geändert.`,
    color: meta.color,
  }).catch(() => {});
}
