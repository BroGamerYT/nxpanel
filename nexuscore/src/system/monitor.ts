import os from 'os';
import { SystemMetrics } from '../types.js';

export function getSystemMetrics(): SystemMetrics {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type as keyof typeof cpu.times];
    }
    totalIdle += cpu.times.idle;
  }

  const idlePercent = totalTick > 0 ? (totalIdle / totalTick) : 1;
  const cpuUsage = Math.round((1 - idlePercent) * 100);

  return {
    cpuUsagePercent: cpuUsage,
    totalMemoryMb: Math.round(totalMem / (1024 * 1024)),
    usedMemoryMb: Math.round(usedMem / (1024 * 1024)),
    freeMemoryMb: Math.round(freeMem / (1024 * 1024)),
    diskTotalGb: 100, // Platzhalter für fs stats
    diskFreeGb: 50,
  };
}
