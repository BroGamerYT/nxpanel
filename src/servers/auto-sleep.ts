import { sql } from '../db/index.js';
import { log } from '../log.js';
import { gameStatus, querySpec } from '../games/status.js';
import { stopServer } from './lifecycle.js';
import { engine } from '../docker/client.js';
import { listPorts } from './repo.js';
import { startWakeProxy, stopAllWakeProxies } from './wake-proxy.js';
import { writeEvent } from '../events.js';
import { writeAudit } from '../audit.js';
import { notifyServerStatus } from '../notifications/discord.js';
import type { ServerRecord } from '../types.js';

/**
 * Intelligenter Energiespar- und Ruhemodus (2-Stufen-System):
 *
 * Stufe 1 (CPU-Eco-Modus nach 3 Min. Leerlauf):
 *   Ist kein Spieler online, drosselt das Panel den Container dynamisch auf 15% CPU.
 *   Sobald ein Spieler joint, springt die CPU sofort in Millisekunden wieder auf 100%!
 *
 * Stufe 2 (Tiefschlaf & Wake-on-Join nach z. B. 30 Min. Leerlauf):
 *   Ist für die konfigurierte Zeitspanne niemand gejoint, fährt das Panel den Server
 *   herunter und gibt 100% RAM (12-16 GB) und CPU auf der VM frei.
 *   Für Minecraft-Server startet automatisch ein leichter Wake-Proxy auf dem Port:
 *   Sobald ein Spieler in Minecraft verbindet, startet der Server vollautomatisch!
 */

// serverId -> Zeitstempel (ms), ab dem der Server durchgehend leer war
const emptySinceMap = new Map<string, number>();

// Server, die aktuell im CPU-Eco-Modus (gedrosselt) laufen
const ecoServers = new Set<string>();

let checkInterval: NodeJS.Timeout | null = null;
let isChecking = false;

function getPlayerCount(st: Awaited<ReturnType<typeof gameStatus>>): number {
  if (Array.isArray(st.people) && st.people.length > 0) return st.people.length;
  if (Array.isArray(st.players) && st.players.length > 0) return st.players.length;
  if (st.ping && 'players' in st.ping && typeof st.ping.players?.online === 'number') {
    return st.ping.players.online;
  }
  return 0;
}

export async function checkAutoSleep(): Promise<void> {
  if (isChecking) return;
  isChecking = true;

  try {
    const servers = await sql<ServerRecord[]>`
      SELECT * FROM servers
      WHERE status = 'running' AND auto_sleep_minutes > 0
    `;

    const activeServerIds = new Set(servers.map((s) => s.id));
    for (const id of Array.from(emptySinceMap.keys())) {
      if (!activeServerIds.has(id)) {
        emptySinceMap.delete(id);
        ecoServers.delete(id);
      }
    }

    const now = Date.now();

    for (const server of servers) {
      try {
        const spec = await querySpec(server.egg_id);
        if (!spec) continue;

        const st = await gameStatus(server, spec);
        const count = getPlayerCount(st);

        if (count > 0) {
          // Spieler online -> Leerlauf-Timer zurücksetzen
          emptySinceMap.delete(server.id);

          // Falls der Server gedrosselt war -> sofort wieder auf 100% CPU hochfahren!
          if (ecoServers.has(server.id)) {
            ecoServers.delete(server.id);
            if (server.container_id) {
              await engine.updateResources(server.container_id, {
                ramMb: server.ram_mb,
                swapMb: server.swap_mb,
                cpuPercent: server.cpu_percent,
              }).catch(() => {});
              log.info({ server: server.name }, 'Spieler beigetreten: Volle CPU-Leistung (100%) wiederhergestellt');
            }
          }
          continue;
        }

        // 0 Spieler online
        const firstEmptyAt = emptySinceMap.get(server.id) ?? now;
        if (!emptySinceMap.has(server.id)) {
          emptySinceMap.set(server.id, now);
        }

        const idleMinutes = (now - firstEmptyAt) / (60 * 1000);

        // Stufe 1: Eco-Modus nach 3 Minuten Leerlauf aktivieren (CPU auf 15% drosseln)
        if (idleMinutes >= 3 && !ecoServers.has(server.id)) {
          ecoServers.add(server.id);
          if (server.container_id) {
            const ecoCpu = Math.max(15, Math.floor(server.cpu_percent * 0.15));
            await engine.updateResources(server.container_id, {
              ramMb: server.ram_mb,
              swapMb: server.swap_mb,
              cpuPercent: ecoCpu,
            }).catch(() => {});
            log.info({ server: server.name, ecoCpu }, 'Eco-Modus aktiv: CPU auf Sparflamme gedrosselt');
          }
        }

        // Stufe 2: Tiefschlaf nach Ablauf der eingestellten Zeit
        if (idleMinutes >= server.auto_sleep_minutes) {
          log.info(
            { serverId: server.id, server: server.name, idleMinutes: Math.round(idleMinutes), limit: server.auto_sleep_minutes },
            'Auto-Sleep: Fahre Server wegen Inaktivität in Tiefschlaf herunter',
          );

          emptySinceMap.delete(server.id);
          ecoServers.delete(server.id);

          await writeEvent({
            serverId: server.id,
            kind: 'server_auto_sleep',
            summary: `Ruhemodus aktiviert: Server nach ${server.auto_sleep_minutes} Minuten Leerlauf automatisch gestoppt`,
          });

          await writeAudit({
            serverId: server.id,
            action: 'server.auto_sleep',
            actorName: 'system',
            metadata: { idleMinutes: Math.round(idleMinutes), autoSleepMinutes: server.auto_sleep_minutes },
          });

          void notifyServerStatus('auto_sleep', server.name, `Server nach ${server.auto_sleep_minutes} Minuten ohne Spieler in den Ruhemodus versetzt (spart 100% RAM & CPU).`);

          await stopServer(server.id, {
            actorId: null,
          }).catch((err) => {
            log.error({ err, serverId: server.id }, 'Fehler beim Stoppen im Auto-Sleep');
          });

          // Wake-Proxy für Minecraft aktivieren
          if (spec.kind === 'minecraft') {
            const ports = await listPorts(server.id);
            const primary = ports.find((p) => p.is_primary)?.port;
            if (primary) {
              setTimeout(() => {
                startWakeProxy(server.id, primary, server.name);
              }, 4000);
            }
          }
        }
      } catch (err) {
        log.debug({ err, serverId: server.id }, 'Fehler beim Prüfen von Auto-Sleep');
      }
    }
  } catch (err) {
    log.error({ err }, 'Unerwarteter Fehler im Auto-Sleep-Prüfzyklus');
  } finally {
    isChecking = false;
  }
}

export function startAutoSleep(): void {
  if (checkInterval) return;
  log.info('Auto-Sleep & Eco-Wächter gestartet (Prüfung alle 60 s)');
  checkInterval = setInterval(() => {
    void checkAutoSleep();
  }, 60_000);
  checkInterval.unref();

  // Bestehende schlafende Minecraft-Server mit Wake-Proxy ausstatten
  void (async () => {
    try {
      const sleeping = await sql<{ id: string; name: string }[]>`
        SELECT s.id, s.name FROM servers s
        JOIN eggs e ON e.id = s.egg_id
        WHERE s.status = 'offline' AND s.auto_sleep_minutes > 0 AND e.raw_egg->'query'->>'kind' = 'minecraft'
      `;
      for (const s of sleeping) {
        const ports = await listPorts(s.id);
        const primary = ports.find((p) => p.is_primary)?.port;
        if (primary) {
          startWakeProxy(s.id, primary, s.name);
        }
      }
    } catch {}
  })();
}

export function stopAutoSleep(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  emptySinceMap.clear();
  ecoServers.clear();
  stopAllWakeProxies();
}
