import { sql } from '../db/index.js';
import { log } from '../log.js';
import { getSetting, setSetting } from '../settings.js';

export type DnsProviderKind = 'none' | 'cloudflare' | 'hetzner' | 'duckdns' | 'webhook';

export const SETTING_DNS_PROVIDER = 'dns_provider';
export const SETTING_DNS_API_TOKEN = 'dns_api_token';
export const SETTING_DNS_ZONE_ID = 'dns_zone_id';
export const SETTING_DNS_ROOT_DOMAIN = 'dns_root_domain';
export const SETTING_DNS_AUTO_SYNC = 'dns_auto_sync';
export const SETTING_DNS_LAST_SYNC_AT = 'dns_last_sync_at';
export const SETTING_DNS_LAST_SYNC_STATUS = 'dns_last_sync_status';
export const SETTING_DNS_LAST_IP = 'dns_last_ip';
export const SETTING_DNS_WEBHOOK_URL = 'dns_webhook_url';

export interface DnsConfig {
  provider: DnsProviderKind;
  apiToken: string | null;
  zoneId: string | null;
  rootDomain: string | null;
  autoSync: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastIp: string | null;
  webhookUrl: string | null;
}

export interface SaveDnsInput {
  provider?: DnsProviderKind | undefined;
  apiToken?: string | null | undefined;
  zoneId?: string | null | undefined;
  rootDomain?: string | null | undefined;
  autoSync?: boolean | undefined;
  webhookUrl?: string | null | undefined;
}

export interface GameSrvMeta {
  service: string; // e.g. '_minecraft'
  proto: string;   // e.g. '_tcp' or '_udp'
  defaultPort: number;
}

/** Ermittelt, ob für das Spiel ein automatischer SRV-Record möglich/sinnvoll ist. */
export function getGameSrvMeta(eggName: string, gameKind?: string | null): GameSrvMeta | null {
  const kind = (gameKind || '').toLowerCase();
  const name = eggName.toLowerCase();

  if (kind === 'minecraft' || name.includes('minecraft') || name.includes('paper') || name.includes('purpur') || name.includes('fabric') || name.includes('forge') || name.includes('spigot')) {
    return { service: '_minecraft', proto: '_tcp', defaultPort: 25565 };
  }
  if (name.includes('teamspeak') || name.includes('ts3')) {
    return { service: '_ts3', proto: '_udp', defaultPort: 9987 };
  }
  if (name.includes('terraria')) {
    return { service: '_terraria', proto: '_tcp', defaultPort: 7777 };
  }
  return null;
}

/** Aktuelle DNS-Konfiguration aus der Datenbank abrufen. */
export async function getDnsConfig(): Promise<DnsConfig> {
  const provider = ((await getSetting(SETTING_DNS_PROVIDER)) as DnsProviderKind) || 'none';
  const apiToken = await getSetting(SETTING_DNS_API_TOKEN);
  const zoneId = await getSetting(SETTING_DNS_ZONE_ID);
  const rootDomain = await getSetting(SETTING_DNS_ROOT_DOMAIN);
  const autoSync = (await getSetting(SETTING_DNS_AUTO_SYNC)) === 'true';
  const lastSyncAt = await getSetting(SETTING_DNS_LAST_SYNC_AT);
  const lastSyncStatus = await getSetting(SETTING_DNS_LAST_SYNC_STATUS);
  const lastIp = await getSetting(SETTING_DNS_LAST_IP);
  const webhookUrl = await getSetting(SETTING_DNS_WEBHOOK_URL);

  return {
    provider,
    apiToken,
    zoneId,
    rootDomain,
    autoSync,
    lastSyncAt,
    lastSyncStatus,
    lastIp,
    webhookUrl,
  };
}

/** DNS-Konfiguration speichern. */
export async function saveDnsConfig(cfg: SaveDnsInput, actorId?: string | null): Promise<void> {
  const aid = actorId ?? null;
  if (cfg.provider !== undefined) await setSetting(SETTING_DNS_PROVIDER, cfg.provider, { actorId: aid });
  if (cfg.apiToken !== undefined) await setSetting(SETTING_DNS_API_TOKEN, cfg.apiToken, { secret: true, actorId: aid });
  if (cfg.zoneId !== undefined) await setSetting(SETTING_DNS_ZONE_ID, cfg.zoneId?.trim() || null, { actorId: aid });
  if (cfg.rootDomain !== undefined) await setSetting(SETTING_DNS_ROOT_DOMAIN, cfg.rootDomain?.trim().toLowerCase() || null, { actorId: aid });
  if (cfg.autoSync !== undefined) await setSetting(SETTING_DNS_AUTO_SYNC, cfg.autoSync ? 'true' : 'false', { actorId: aid });
  if (cfg.webhookUrl !== undefined) await setSetting(SETTING_DNS_WEBHOOK_URL, cfg.webhookUrl?.trim() || null, { actorId: aid });
}

/** Öffentliche IP-Adresse des Hosts ermitteln. */
export async function resolvePublicIp(timeoutMs = 5000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { ip: string };
    if (!data.ip) throw new Error('Leere IP-Antwort von ipify');
    return data.ip.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- Cloudflare
export async function testCloudflare(apiToken: string, rootDomain: string, zoneId?: string | null): Promise<{ ok: boolean; zoneId: string; domain: string; message: string }> {
  let targetZoneId = zoneId?.trim() || null;

  if (!targetZoneId) {
    const listRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(rootDomain)}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!listRes.ok) {
      const errText = await listRes.text();
      throw new Error(`Cloudflare API-Fehler (${listRes.status}): ${errText}`);
    }
    const listData = (await listRes.json()) as { success: boolean; errors?: Array<{ message: string }>; result?: Array<{ id: string; name: string }> };
    if (!listData.success || !listData.result || listData.result.length === 0) {
      throw new Error(`Zone für Domain "${rootDomain}" wurde in deinem Cloudflare-Account nicht gefunden.`);
    }
    targetZoneId = listData.result[0]!.id;
  }

  const zoneRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${targetZoneId}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!zoneRes.ok) {
    throw new Error(`Cloudflare Zone ${targetZoneId} konnte nicht abgerufen werden.`);
  }

  return {
    ok: true,
    zoneId: targetZoneId,
    domain: rootDomain,
    message: `Verbindung zu Cloudflare Zone "${rootDomain}" (${targetZoneId}) erfolgreich!`,
  };
}

// ---------------------------------------------------------------- Hetzner DNS
export async function testHetzner(apiToken: string, rootDomain: string, zoneId?: string | null): Promise<{ ok: boolean; zoneId: string; domain: string; message: string }> {
  let targetZoneId = zoneId?.trim() || null;

  if (!targetZoneId) {
    const res = await fetch('https://dns.hetzner.com/api/v1/zones', {
      headers: { 'Auth-API-Token': apiToken },
    });
    if (!res.ok) {
      throw new Error(`Hetzner DNS API-Fehler (${res.status})`);
    }
    const data = (await res.json()) as { zones: Array<{ id: string; name: string }> };
    const found = data.zones.find((z) => z.name.toLowerCase() === rootDomain.toLowerCase());
    if (!found) {
      throw new Error(`Hetzner DNS-Zone für "${rootDomain}" nicht gefunden.`);
    }
    targetZoneId = found.id;
  }

  return {
    ok: true,
    zoneId: targetZoneId,
    domain: rootDomain,
    message: `Verbindung zu Hetzner DNS Zone "${rootDomain}" (${targetZoneId}) erfolgreich!`,
  };
}

export interface ServerSyncTarget {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  srvRecordEnabled: boolean;
  primaryPort: number;
  eggName: string;
  gameKind: string | null;
}

/** Alle Server für Synchronisation auslesen */
export async function listServerSyncTargets(): Promise<ServerSyncTarget[]> {
  const rows = await sql<Array<{
    id: string;
    name: string;
    subdomain: string | null;
    custom_domain: string | null;
    srv_record_enabled: boolean;
    primary_port: number | null;
    egg_name: string;
    game_kind: string | null;
  }>>`
    SELECT s.id, s.name, s.subdomain, s.custom_domain, s.srv_record_enabled,
           (SELECT port FROM allocations a WHERE a.server_id = s.id AND a.is_primary LIMIT 1) as primary_port,
           e.name as egg_name,
           (e.raw_egg->>'game_kind')::text as game_kind
    FROM servers s
    JOIN eggs e ON e.id = s.egg_id
    WHERE s.subdomain IS NOT NULL AND s.subdomain != ''
  `;

  return rows
    .filter((r) => r.subdomain && r.primary_port)
    .map((r) => ({
      id: r.id,
      name: r.name,
      subdomain: r.subdomain!.trim().toLowerCase(),
      customDomain: r.custom_domain?.trim() || null,
      srvRecordEnabled: r.srv_record_enabled ?? true,
      primaryPort: r.primary_port!,
      eggName: r.egg_name,
      gameKind: r.game_kind,
    }));
}

/** Führt die vollständige DNS-Synchronisation für alle konfigurierten Subdomains und SRV-Records durch. */
export async function syncAllDns(): Promise<{ ok: boolean; updated: number; ip: string; message: string }> {
  const cfg = await getDnsConfig();
  if (cfg.provider === 'none') {
    return { ok: true, updated: 0, ip: '', message: 'DNS-Synchronisation ist deaktiviert.' };
  }

  const publicIp = await resolvePublicIp();
  const servers = await listServerSyncTargets();
  let updatedCount = 0;

  try {
    if (cfg.provider === 'cloudflare') {
      if (!cfg.apiToken || !cfg.rootDomain) {
        throw new Error('Cloudflare API-Token und Root-Domain müssen hinterlegt sein.');
      }
      let zoneId = cfg.zoneId;
      if (!zoneId) {
        const test = await testCloudflare(cfg.apiToken, cfg.rootDomain);
        zoneId = test.zoneId;
        await setSetting(SETTING_DNS_ZONE_ID, zoneId);
      }

      // Bestehende Records abfragen
      const recRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?per_page=100`, {
        headers: { Authorization: `Bearer ${cfg.apiToken}` },
      });
      const recData = (await recRes.json()) as { success: boolean; result: Array<{ id: string; type: string; name: string; content: string; data?: unknown }> };
      const records = recData.result || [];

      // 1. Root-Domain A-Record
      const rootRec = records.find((r) => r.type === 'A' && r.name.toLowerCase() === cfg.rootDomain!.toLowerCase());
      if (!rootRec) {
        await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'A',
            name: cfg.rootDomain,
            content: publicIp,
            ttl: 300,
            proxied: false,
            comment: 'NexusPanel Host IP (DDNS)',
          }),
        });
        updatedCount++;
      } else if (rootRec.content !== publicIp) {
        await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${rootRec.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'A',
            name: cfg.rootDomain,
            content: publicIp,
            ttl: 300,
            proxied: false,
            comment: 'NexusPanel Host IP (DDNS)',
          }),
        });
        updatedCount++;
      }

      // 2. Je Gameserver: A-Record und optionaler SRV-Record
      for (const s of servers) {
        const fqdn = `${s.subdomain}.${cfg.rootDomain}`;
        const aRec = records.find((r) => r.type === 'A' && r.name.toLowerCase() === fqdn.toLowerCase());

        if (!aRec) {
          await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'A',
              name: fqdn,
              content: publicIp,
              ttl: 300,
              proxied: false,
              comment: `NexusPanel: ${s.name} (${s.id})`,
            }),
          });
          updatedCount++;
        } else if (aRec.content !== publicIp) {
          await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${aRec.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'A',
              name: fqdn,
              content: publicIp,
              ttl: 300,
              proxied: false,
              comment: `NexusPanel: ${s.name} (${s.id})`,
            }),
          });
          updatedCount++;
        }

        // SRV Record (z. B. _minecraft._tcp.<subdomain>.<rootDomain>)
        const srvMeta = s.srvRecordEnabled ? getGameSrvMeta(s.eggName, s.gameKind) : null;
        if (srvMeta) {
          const srvFullName = `${srvMeta.service}.${srvMeta.proto}.${fqdn}`.toLowerCase();
          const srvRec = records.find((r) => r.type === 'SRV' && r.name.toLowerCase() === srvFullName);

          const srvData = {
            service: srvMeta.service,
            proto: srvMeta.proto,
            name: s.subdomain,
            priority: 0,
            weight: 5,
            port: s.primaryPort,
            target: fqdn,
          };

          if (!srvRec) {
            await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'SRV',
                data: srvData,
                ttl: 300,
                comment: `NexusPanel SRV: ${s.name} Port ${s.primaryPort}`,
              }),
            });
            updatedCount++;
          }
        }
      }
    } else if (cfg.provider === 'hetzner') {
      if (!cfg.apiToken || !cfg.rootDomain) {
        throw new Error('Hetzner API-Token und Root-Domain müssen hinterlegt sein.');
      }
      let zoneId = cfg.zoneId;
      if (!zoneId) {
        const test = await testHetzner(cfg.apiToken, cfg.rootDomain);
        zoneId = test.zoneId;
        await setSetting(SETTING_DNS_ZONE_ID, zoneId);
      }

      const recRes = await fetch(`https://dns.hetzner.com/api/v1/records?zone_id=${zoneId}`, {
        headers: { 'Auth-API-Token': cfg.apiToken },
      });
      const recData = (await recRes.json()) as { records: Array<{ id: string; type: string; name: string; value: string }> };
      const records = recData.records || [];

      // Root A-Record
      const rootRec = records.find((r) => r.type === 'A' && (r.name === '@' || r.name === ''));
      if (!rootRec) {
        await fetch('https://dns.hetzner.com/api/v1/records', {
          method: 'POST',
          headers: { 'Auth-API-Token': cfg.apiToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ zone_id: zoneId, type: 'A', name: '@', value: publicIp, ttl: 300 }),
        });
        updatedCount++;
      } else if (rootRec.value !== publicIp) {
        await fetch(`https://dns.hetzner.com/api/v1/records/${rootRec.id}`, {
          method: 'PUT',
          headers: { 'Auth-API-Token': cfg.apiToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ zone_id: zoneId, type: 'A', name: '@', value: publicIp, ttl: 300 }),
        });
        updatedCount++;
      }

      // Je Gameserver: A-Record & optionaler SRV-Record
      for (const s of servers) {
        const aRec = records.find((r) => r.type === 'A' && r.name.toLowerCase() === s.subdomain);
        if (!aRec) {
          await fetch('https://dns.hetzner.com/api/v1/records', {
            method: 'POST',
            headers: { 'Auth-API-Token': cfg.apiToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ zone_id: zoneId, type: 'A', name: s.subdomain, value: publicIp, ttl: 300 }),
          });
          updatedCount++;
        } else if (aRec.value !== publicIp) {
          await fetch(`https://dns.hetzner.com/api/v1/records/${aRec.id}`, {
            method: 'PUT',
            headers: { 'Auth-API-Token': cfg.apiToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ zone_id: zoneId, type: 'A', name: s.subdomain, value: publicIp, ttl: 300 }),
          });
          updatedCount++;
        }

        const srvMeta = s.srvRecordEnabled ? getGameSrvMeta(s.eggName, s.gameKind) : null;
        if (srvMeta) {
          const srvName = `${srvMeta.service}.${srvMeta.proto}.${s.subdomain}`;
          const targetFqdn = `${s.subdomain}.${cfg.rootDomain}.`;
          const srvVal = `0 5 ${s.primaryPort} ${targetFqdn}`;
          const srvRec = records.find((r) => r.type === 'SRV' && r.name.toLowerCase() === srvName.toLowerCase());

          if (!srvRec) {
            await fetch('https://dns.hetzner.com/api/v1/records', {
              method: 'POST',
              headers: { 'Auth-API-Token': cfg.apiToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ zone_id: zoneId, type: 'SRV', name: srvName, value: srvVal, ttl: 300 }),
            });
            updatedCount++;
          }
        }
      }
    } else if (cfg.provider === 'duckdns') {
      if (!cfg.apiToken || !cfg.rootDomain) {
        throw new Error('DuckDNS Token und Domain müssen angegeben sein.');
      }
      const duckRes = await fetch(`https://www.duckdns.org/update?domains=${encodeURIComponent(cfg.rootDomain)}&token=${encodeURIComponent(cfg.apiToken)}&ip=${encodeURIComponent(publicIp)}`);
      const duckText = await duckRes.text();
      if (!duckText.includes('OK')) {
        throw new Error(`DuckDNS Fehler: ${duckText}`);
      }
      updatedCount++;
    } else if (cfg.provider === 'webhook') {
      if (!cfg.webhookUrl) throw new Error('Webhook URL ist nicht konfiguriert.');
      const url = cfg.webhookUrl
        .replace('{ip}', encodeURIComponent(publicIp))
        .replace('{domain}', encodeURIComponent(cfg.rootDomain || ''));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Webhook Fehler: HTTP ${res.status}`);
      updatedCount++;
    }

    const nowIso = new Date().toISOString();
    await setSetting(SETTING_DNS_LAST_SYNC_AT, nowIso);
    await setSetting(SETTING_DNS_LAST_SYNC_STATUS, 'OK');
    await setSetting(SETTING_DNS_LAST_IP, publicIp);

    return {
      ok: true,
      updated: updatedCount,
      ip: publicIp,
      message: `Erfolgreich synchronisiert! Öffentliche IP: ${publicIp}, ${servers.length} Gameserver-Subdomain(s) aktiv.`,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'DNS Synchronisation fehlgeschlagen');
    await setSetting(SETTING_DNS_LAST_SYNC_AT, new Date().toISOString());
    await setSetting(SETTING_DNS_LAST_SYNC_STATUS, `Fehler: ${errMsg}`);
    throw err;
  }
}

let syncTimer: NodeJS.Timeout | null = null;

/** Startet den automatischen Hintergrund-DDNS-Sync alle 5 Minuten */
export function startDdnsBackgroundService(): void {
  if (syncTimer) return;
  syncTimer = setInterval(async () => {
    try {
      const cfg = await getDnsConfig();
      if (cfg.provider !== 'none' && cfg.autoSync) {
        const curIp = await resolvePublicIp().catch(() => null);
        if (curIp && curIp !== cfg.lastIp) {
          log.info({ oldIp: cfg.lastIp, newIp: curIp }, 'Öffentliche IP geändert – starte automatischen DDNS-Sync');
          await syncAllDns();
        }
      }
    } catch (err) {
      log.warn({ err }, 'Automatischer DDNS-Sync-Lauf fehlgeschlagen');
    }
  }, 5 * 60 * 1000);
}
