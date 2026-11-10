import os from 'node:os';
import fs from 'node:fs/promises';
import type { SystemMetrics } from '../types.js';

/**
 * Host-Metriken fuer den Core.
 *
 * Die Werte werden nicht geraten: RAM kommt aus /proc/meminfo (Linux) bzw.
 * os.freemem(), die Festplatte aus statfs des Datenverzeichnisses. Die
 * CPU-Last ergibt sich aus der Differenz zweier Abtastungen - ein einzelner
 * Blick auf os.cpus() liefert nur kumulierte Werte seit dem Start.
 */

let previousCpu: { idle: number; total: number } | null = null;

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

async function cpuPercent(): Promise<number> {
  let before = previousCpu;
  if (!before) {
    before = cpuTimes();
    // Der erste Aufruf misst kurz selbst, sonst waere die Last immer 0.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const now = cpuTimes();
  previousCpu = now;

  const dt = now.total - before.total;
  if (dt <= 0) return 0;
  return Math.round(((1 - (now.idle - before.idle) / dt) * 100) * 10) / 10;
}

/**
 * Belegter RAM = MemTotal - MemAvailable.
 *
 * Seiten-Cache zaehlt nicht als belegt, sonst stuende jede Maschine dauerhaft
 * bei 95 %. Unter Windows gibt es keine /proc/meminfo - dort greift os.freemem().
 */
async function memory(): Promise<{ totalMb: number; usedMb: number; freeMb: number }> {
  try {
    const text = await fs.readFile('/proc/meminfo', 'utf8');
    const kb = (key: string) => {
      const match = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
      return match ? Number(match[1]) : 0;
    };
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    if (total > 0) {
      const used = total - available;
      return {
        totalMb: Math.round(total / 1024),
        usedMb: Math.round(used / 1024),
        freeMb: Math.round(available / 1024),
      };
    }
  } catch {
    // Kein Linux - auf os.freemem() zurueckfallen.
  }

  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalMb: Math.round(total / (1024 * 1024)),
    usedMb: Math.round((total - free) / (1024 * 1024)),
    freeMb: Math.round(free / (1024 * 1024)),
  };
}

async function disk(dir: string): Promise<{ totalGb: number; freeGb: number }> {
  try {
    const stats = await fs.statfs(dir);
    const blockSize = Number(stats.bsize);
    const total = Number(stats.blocks) * blockSize;
    const free = Number(stats.bavail) * blockSize;
    return {
      totalGb: Math.round((total / 1024 ** 3) * 10) / 10,
      freeGb: Math.round((free / 1024 ** 3) * 10) / 10,
    };
  } catch {
    return { totalGb: 0, freeGb: 0 };
  }
}

export async function getSystemMetrics(dataDir: string = process.cwd()): Promise<SystemMetrics> {
  const [cpu, mem, diskInfo] = await Promise.all([cpuPercent(), memory(), disk(dataDir)]);

  return {
    cpuUsagePercent: cpu,
    totalMemoryMb: mem.totalMb,
    usedMemoryMb: mem.usedMb,
    freeMemoryMb: mem.freeMb,
    diskTotalGb: diskInfo.totalGb,
    diskFreeGb: diskInfo.freeGb,
  };
}
