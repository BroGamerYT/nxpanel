import { cpus, loadavg, totalmem, freemem, uptime, hostname } from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { config } from './config.js';

/**
 * Grundleistung der Maschine, auf der das Panel laeuft (die VM).
 *
 * Im Container sieht Node dieselben Kerne und denselben Speicher wie der
 * Host, weil /proc/meminfo und /proc/stat nicht virtualisiert sind - genau
 * das, was hier gezeigt werden soll. Belegter RAM = MemTotal - MemAvailable:
 * Seiten-Cache zaehlt nicht als belegt, sonst stuende jede VM bei 100 %.
 */
export interface HostInfo {
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  cpuPercent: number | null;
  load: [number, number, number];
  ramTotalMb: number;
  ramUsedMb: number;
  diskTotalMb: number;
  diskUsedMb: number;
  uptimeS: number;
}

let prevCpu: { idle: number; total: number } | null = null;

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** CPU-Last seit dem letzten Aufruf. Der erste Aufruf misst kurz selbst. */
async function cpuPercent(): Promise<number | null> {
  let before = prevCpu;
  if (!before) {
    before = cpuTimes();
    await new Promise((r) => setTimeout(r, 250));
  }
  const now = cpuTimes();
  prevCpu = now;
  const dt = now.total - before.total;
  if (dt <= 0) return null;
  return Math.round((1 - (now.idle - before.idle) / dt) * 1000) / 10;
}

async function memory(): Promise<{ total: number; used: number }> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
    const total = kb('MemTotal'), avail = kb('MemAvailable');
    if (total > 0) return { total: Math.round(total / 1024), used: Math.round((total - avail) / 1024) };
  } catch { /* kein Linux */ }
  return { total: Math.round(totalmem() / 1048576), used: Math.round((totalmem() - freemem()) / 1048576) };
}

export async function hostInfo(): Promise<HostInfo> {
  const [cpu, mem, disk] = await Promise.all([
    cpuPercent(),
    memory(),
    statfs(config.VOLUME_ROOT).catch(() => statfs('/')).catch(() => null),
  ]);
  const list = cpus();
  const l = loadavg();
  const blocks = disk ? Number(disk.blocks) * Number(disk.bsize) : 0;
  const avail = disk ? Number(disk.bavail) * Number(disk.bsize) : 0;
  return {
    hostname: hostname(),
    cpuModel: list[0]?.model.trim() ?? '',
    cpuCores: list.length,
    cpuPercent: cpu,
    load: [Math.round(l[0]! * 100) / 100, Math.round(l[1]! * 100) / 100, Math.round(l[2]! * 100) / 100],
    ramTotalMb: mem.total,
    ramUsedMb: mem.used,
    diskTotalMb: Math.round(blocks / 1048576),
    diskUsedMb: Math.round((blocks - avail) / 1048576),
    uptimeS: Math.round(uptime()),
  };
}
