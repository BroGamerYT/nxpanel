import type { FastifyInstance } from 'fastify';
import { sql } from '../../db/index.js';
import { listServersForActor } from '../../servers/access.js';
import type { StatsSource } from '../../servers/stats-collector.js';
import type { DiskSource } from '../../servers/disk-collector.js';
import { hostInfo } from '../../host.js';
import { requireAuth, requireServer } from '../auth.js';

/**
 * Uebersicht fuer die Startseite: Gesamtlast aller sichtbaren Server und -
 * nur fuer Admins - die Grundleistung der Maschine. Wird alle paar Sekunden
 * abgefragt; die Werte kommen aus dem Speicher des Statistik-Sammlers, die
 * Anfrage selbst fragt Docker nicht.
 */
export async function dashboardRoutes(app: FastifyInstance, opts: { stats: StatsSource; disk: DiskSource }) {
  /** Verlauf der letzten Stunde je Server: CPU, RAM, Download, Upload. */
  app.get<{ Params: { id: string } }>('/servers/:id/history', { preHandler: requireServer() }, async (req) => {
    return { step: 10, points: opts.stats.history?.(req.target!.server.id) ?? [] };
  });

  /** Wichtige Ereignisse (Abstuerze, Warnungen, Updates, Speicherwarnungen) fuer die Benachrichtigungsglocke im Panel. */
  app.get('/notifications', { preHandler: requireAuth }, async (req) => {
    const actor = req.actor!;
    const servers = await listServersForActor(actor);
    if (servers.length === 0) return { items: [] };
    const serverIds = servers.map((s) => s.id);
    const serverMap = new Map(servers.map((s) => [s.id, { name: s.name, shortId: s.shortId }]));

    const rows = await sql<{
      id: number;
      server_id: string;
      ts: Date;
      kind: string;
      severity: 'info' | 'warn' | 'error';
      summary: string;
      payload: Record<string, unknown> | null;
    }[]>`
      SELECT id::int AS id, server_id, ts, kind, severity, summary, payload
      FROM events
      WHERE server_id IN ${sql(serverIds)}
        AND (
          severity IN ('warn', 'error')
          OR kind IN ('crash', 'restart_skipped', 'disk_warning', 'install_done', 'install_failed', 'modpack_update', 'backup_done')
        )
      ORDER BY id DESC
      LIMIT 25
    `;

    return {
      items: rows.map((r) => {
        const srv = serverMap.get(r.server_id);
        return {
          id: r.id,
          serverId: r.server_id,
          serverName: srv?.name ?? r.server_id.slice(0, 8),
          shortId: srv?.shortId ?? r.server_id.slice(0, 8),
          ts: r.ts,
          kind: r.kind,
          severity: r.severity,
          summary: r.summary,
          payload: r.payload,
        };
      }),
    };
  });

  app.get('/dashboard', { preHandler: requireAuth }, async (req) => {
    const actor = req.actor!;
    const servers = await listServersForActor(actor);
    const live = opts.stats.snapshot();
    const disk = opts.disk.serverMb();

    const perServer: Record<string, { cpuPercent: number; memMb: number; rxRate: number; txRate: number }> = {};
    /** Belegter Speicher je Server - auch fuer gestoppte. Fehlt, solange noch nicht gemessen. */
    const diskUsed: Record<string, number> = {};
    const totals = { servers: servers.length, running: 0, ramAssignedMb: 0, cpuAssignedPercent: 0, diskAssignedMb: 0,
      ramUsedMb: 0, cpuPercent: 0, rxRate: 0, txRate: 0, diskUsedMb: 0 };
    for (const s of servers) {
      const d = disk.get(s.id);
      if (d !== undefined) { diskUsed[s.id] = d; totals.diskUsedMb += d; }
      totals.ramAssignedMb += s.ramMb;
      totals.cpuAssignedPercent += s.cpuPercent;
      totals.diskAssignedMb += s.diskMb;
      if (s.status === 'running') totals.running++;
      const l = live.get(s.id);
      if (l) {
        perServer[s.id] = { cpuPercent: l.cpuPercent, memMb: l.memMb, rxRate: l.rxRate, txRate: l.txRate };
        totals.ramUsedMb += l.memMb;
        totals.cpuPercent += l.cpuPercent;
        totals.rxRate += l.rxRate;
        totals.txRate += l.txRate;
      }
    }
    totals.cpuPercent = Math.round(totals.cpuPercent * 10) / 10;

    let host = null;
    if (actor.role === 'admin') {
      // Zugeteilt ueber ALLE Server, nicht nur die sichtbaren - fuer die Frage "passt noch einer drauf?"
      const [all] = await sql<{ ram: number; cpu: number; disk: number; n: number }[]>`
        SELECT coalesce(sum(ram_mb), 0)::int AS ram, coalesce(sum(cpu_percent), 0)::int AS cpu,
               coalesce(sum(disk_mb), 0)::int AS disk, count(*)::int AS n FROM servers`;
      let gameDataMb = 0;
      for (const v of disk.values()) gameDataMb += v;
      host = {
        ...(await hostInfo()),
        assigned: { ramMb: all!.ram, cpuPercent: all!.cpu, diskMb: all!.disk, servers: all!.n },
        // Was den Speicher fuellt: Spieldaten (Ordner der Server) und Docker selbst.
        storage: { gameDataMb, docker: opts.disk.docker(), measuredAt: opts.disk.measuredAt() },
      };
    }
    return { totals, perServer, diskUsed, host };
  });
}
