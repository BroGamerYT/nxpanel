import type { FastifyInstance } from 'fastify';
import { statSync, existsSync } from 'node:fs';
import { sql } from '../../db/index.js';
import { backupFilePath } from '../../servers/backups.js';
import { diskCollector } from '../../servers/stats.js';
import { isUpdating, updateState } from '../../servers/modpack-update.js';
import { requireAuth } from '../auth.js';
import { activeGameUpdates } from './servers.js';

export interface ActiveTask {
  id: string;
  type: 'backup' | 'game_update' | 'modpack_update' | 'install' | 'starting' | 'stopping';
  serverId: string;
  serverName: string;
  shortId: string;
  title: string;
  subtitle?: string | undefined;
  progressPercent?: number | undefined;
  bytesWritten?: number | undefined;
  totalBytes?: number | undefined;
  step?: string | undefined;
  startedAt: string;
}

export async function taskRoutes(app: FastifyInstance) {
  /** Alle aktuell laufenden Hintergrundaufgaben des Panels abfragen */
  app.get('/tasks/active', { preHandler: requireAuth }, async (req) => {
    const actor = req.actor!;
    const isAdmin = actor.role === 'admin';

    // 1. Laufende Backups
    const runningBackups = await sql<{
      id: string;
      server_id: string;
      name: string;
      created_at: Date;
      server_name: string;
      short_id: string;
      owner_id: string;
    }[]>`
      SELECT b.id, b.server_id, b.name, b.created_at, s.name AS server_name, s.short_id, s.owner_id
      FROM backups b
      JOIN servers s ON s.id = b.server_id
      WHERE b.status = 'running'
      ORDER BY b.created_at DESC
    `;

    // 2. Installierende oder startende Server
    const transitionServers = await sql<{
      id: string;
      name: string;
      short_id: string;
      status: string;
      created_at: Date;
      owner_id: string;
    }[]>`
      SELECT id, name, short_id, status, created_at, owner_id
      FROM servers
      WHERE status IN ('installing', 'starting', 'stopping')
      ORDER BY created_at DESC
    `;

    const tasks: ActiveTask[] = [];

    // Backups verarbeiten
    for (const b of runningBackups) {
      if (!isAdmin && b.owner_id !== actor.id) continue;

      let bytesWritten = 0;
      try {
        const p = backupFilePath(b.server_id, b.id);
        if (existsSync(p)) {
          bytesWritten = statSync(p).size;
        }
      } catch {}

      const serverMb = diskCollector.serverMb().get(b.server_id) ?? 0;
      const totalBytes = serverMb * 1024 * 1024;
      // Zstd komprimiert Spiele meist um das 2- bis 2.5-fache (ca. 45% Zielgroesse)
      const targetCompressed = Math.max(totalBytes * 0.45, 10 * 1024 * 1024);
      const progressPercent = totalBytes > 0
        ? Math.min(99, Math.max(5, Math.round((bytesWritten / targetCompressed) * 100)))
        : undefined;

      // Pruefen ob dieses Backup zu einem 1-Klick-Game-Update gehoert
      const gameUpdate = activeGameUpdates.get(b.server_id);
      const isPreUpdateBackup = gameUpdate && gameUpdate.step === 'backup';

      tasks.push({
        id: `backup-${b.id}`,
        type: 'backup',
        serverId: b.server_id,
        serverName: b.server_name,
        shortId: b.short_id,
        title: isPreUpdateBackup
          ? `Sicherheits-Backup vor Update`
          : `Backup „${b.name}“`,
        subtitle: bytesWritten > 0
          ? `${(bytesWritten / (1024 * 1024)).toFixed(1)} MB geschrieben${totalBytes > 0 ? ` (von ~${(totalBytes / (1024 * 1024)).toFixed(0)} MB Daten)` : ''}`
          : 'Archivierung wird vorbereitet...',
        progressPercent,
        bytesWritten,
        totalBytes,
        startedAt: b.created_at.toISOString(),
      });
    }

    // 1-Klick-Game-Updates verarbeiten
    for (const [serverId, gu] of activeGameUpdates.entries()) {
      if (gu.step === 'done' || gu.step === 'failed') continue;
      // Wenn der Backup-Schritt laeuft, haben wir ihn oben bereits praezise mit Bytes erfasst
      if (gu.step === 'backup') continue;

      const [s] = await sql<{ name: string; short_id: string; owner_id: string }[]>`
        SELECT name, short_id, owner_id FROM servers WHERE id = ${serverId}
      `;
      if (!s || (!isAdmin && s.owner_id !== actor.id)) continue;

      const stepLabels: Record<string, string> = {
        stopping: 'Server wird geordnet gestoppt...',
        pulling: 'Neuestes Image wird geladen (Docker Pull)...',
        rebuilding: 'Container wird neu aufgebaut...',
        starting: 'Server fährt wieder hoch...',
      };

      tasks.push({
        id: `game-update-${serverId}`,
        type: 'game_update',
        serverId,
        serverName: s.name,
        shortId: s.short_id,
        title: '1-Klick-Update läuft',
        subtitle: stepLabels[gu.step] ?? gu.step,
        step: gu.step,
        startedAt: new Date(gu.startedAt).toISOString(),
      });
    }

    // Modpack-Updates
    const allServers = await sql<{ id: string; name: string; short_id: string; owner_id: string }[]>`
      SELECT id, name, short_id, owner_id FROM servers
    `;
    for (const s of allServers) {
      if (!isAdmin && s.owner_id !== actor.id) continue;
      if (isUpdating(s.id)) {
        const state = updateState(s.id);
        if (state && state.step !== 'done' && state.step !== 'failed') {
          // Falls im Backup-Schritt, nicht doppelt listen
          if (state.step === 'backup' && tasks.some((t) => t.serverId === s.id && t.type === 'backup')) {
            continue;
          }
          tasks.push({
            id: `modpack-${s.id}`,
            type: 'modpack_update',
            serverId: s.id,
            serverName: s.name,
            shortId: s.short_id,
            title: 'Modpack-Update läuft',
            subtitle: `Schritt: ${state.step}`,
            step: state.step,
            startedAt: new Date(state.at).toISOString(),
          });
        }
      }
    }

    // Server-Transitionen (Installation, Start, Stopp)
    for (const s of transitionServers) {
      if (!isAdmin && s.owner_id !== actor.id) continue;
      // Nicht doppelt listen wenn bereits als Game-Update erfasst
      if (tasks.some((t) => t.serverId === s.id)) continue;

      if (s.status === 'installing') {
        tasks.push({
          id: `install-${s.id}`,
          type: 'install',
          serverId: s.id,
          serverName: s.name,
          shortId: s.short_id,
          title: 'Server-Installation läuft',
          subtitle: 'Spieldateien und Container werden eingerichtet...',
          startedAt: s.created_at.toISOString(),
        });
      } else if (s.status === 'starting') {
        tasks.push({
          id: `start-${s.id}`,
          type: 'starting',
          serverId: s.id,
          serverName: s.name,
          shortId: s.short_id,
          title: 'Server startet...',
          subtitle: 'Warten auf Spielbereitschaft (Ready-Check)',
          startedAt: new Date().toISOString(),
        });
      }
    }

    return { tasks };
  });

  /** Aufgaben fuer einen konkreten Server abfragen */
  app.get<{ Params: { id: string } }>('/servers/:id/tasks/active', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params;
    // Greift dieselbe Logik ab, gefiltert nach serverId
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks/active',
      headers: { authorization: req.headers.authorization as string },
    });
    const parsed = JSON.parse(res.body) as { tasks: ActiveTask[] };
    return { tasks: parsed.tasks.filter((t) => t.serverId === id) };
  });
}
