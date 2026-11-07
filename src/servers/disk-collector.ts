import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { config } from '../config.js';
import type { DockerDiskUsage } from '../docker/client.js';
import { writeEvent } from '../events.js';

const exec = promisify(execFile);

/**
 * Wie voll ist es? Belegter Platz je Server (sein Datenordner) und was
 * Docker selbst belegt.
 *
 * Einen 15-GB-ARK-Ordner zu vermessen dauert Sekunden - deshalb laeuft das
 * nicht bei jeder Anfrage, sondern alle paar Minuten nacheinander im
 * Hintergrund. Die Anzeige ist also bis zu einige Minuten alt; nach einem
 * Import oder einer Installation laesst sich ein Server gezielt neu messen.
 */
export interface DiskSource {
  serverMb(): Map<string, number>;
  docker(): DockerDiskUsage | null;
  measuredAt(): number | null;
}

/** Groesse eines Ordners in MB. du ist schnell; ohne du (Windows) zaehlt Node selbst. */
export async function dirSizeMb(path: string): Promise<number> {
  try {
    const { stdout } = await exec('du', ['-sk', path], { timeout: 180_000 });
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    if (Number.isFinite(kb)) return Math.round(kb / 1024);
  } catch { /* weiter mit Node */ }
  let bytes = 0;
  const walk = async (p: string) => {
    for (const name of await readdir(p).catch(() => [] as string[])) {
      const f = join(p, name);
      const st = await lstat(f).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(f); else bytes += st.size;
    }
  };
  await walk(path);
  return Math.round(bytes / 1048576);
}

export class DiskCollector implements DiskSource {
  private sizes = new Map<string, number>();
  private dockerUsage: DockerDiskUsage | null = null;
  private at: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dockerDf: (() => Promise<DockerDiskUsage>) | null, private readonly intervalMs = 5 * 60_000) {}

  start() {
    if (this.timer) return;
    // Kurz nach dem Start, nicht sofort - dann ist der Rest schon hochgefahren.
    setTimeout(() => void this.measureAll(), 15_000).unref();
    this.timer = setInterval(() => void this.measureAll(), this.intervalMs);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async measureAll() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await sql<{ id: string; short_id: string; disk_mb: number }[]>`SELECT id, short_id, disk_mb FROM servers`;
      const seen = new Set<string>();
      for (const r of rows) {
        seen.add(r.id);
        const mb = await dirSizeMb(resolve(config.VOLUME_ROOT, r.short_id));
        this.sizes.set(r.id, mb);
        await this.warnIfFull(r.id, mb, r.disk_mb);
      }
      for (const id of this.sizes.keys()) if (!seen.has(id)) this.sizes.delete(id);
      if (this.dockerDf) this.dockerUsage = await this.dockerDf().catch((err: unknown) => { log.debug({ err }, 'docker df fehlgeschlagen'); return this.dockerUsage; });
      this.at = Date.now();
    } catch (err) {
      log.warn({ err }, 'Speichermessung fehlgeschlagen');
    } finally {
      this.running = false;
    }
  }

  /**
   * Bei 90 % und bei 100 % je einmal Bescheid geben (Zeitachse) - nicht bei
   * jeder Messung. Faellt der Wert wieder darunter, darf es erneut melden.
   */
  private level = new Map<string, 0 | 90 | 100>();
  private async warnIfFull(serverId: string, usedMb: number, limitMb: number) {
    if (!limitMb) return;
    const pct = usedMb / limitMb;
    const lvl: 0 | 90 | 100 = pct >= 1 ? 100 : pct >= 0.9 ? 90 : 0;
    const prev = this.level.get(serverId) ?? 0;
    this.level.set(serverId, lvl);
    if (lvl <= prev) return;
    const used = Math.round(usedMb / 102.4) / 10, limit = Math.round(limitMb / 102.4) / 10;
    await writeEvent({
      serverId, kind: 'disk_warning', severity: lvl === 100 ? 'error' : 'warn',
      summary: lvl === 100
        ? `Speicher voll: ${used} GB von ${limit} GB belegt. Der Server startet erst wieder, wenn Platz frei ist oder mehr zugeteilt wird.`
        : `Speicher fast voll: ${used} GB von ${limit} GB belegt (über 90 %).`,
      payload: { usedMb, limitMb },
    }).catch(() => {});
  }

  /** Einen Server sofort neu messen (nach Import, Installation, Loeschen). */
  async measure(serverId: string, shortId: string) {
    this.sizes.set(serverId, await dirSizeMb(resolve(config.VOLUME_ROOT, shortId)));
  }

  serverMb() { return this.sizes; }
  docker() { return this.dockerUsage; }
  measuredAt() { return this.at; }
}

export const emptyDisk: DiskSource = { serverMb: () => new Map(), docker: () => null, measuredAt: () => null };
