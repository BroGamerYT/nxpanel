import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Das Hilfsprogramm `nxjob.exe` (helper/nxjob, Rust): startet ein Spiel in einem Windows-Job-Object.
 * Damit endet das Spiel mit dem Core (keine Waisen) und Speicher/CPU lassen sich hart begrenzen.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Wo der Core nxjob.exe sucht: Umgebung, neben dem Programm (Paket), im Quellbaum (Entwicklung). */
export function jobHelperCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const list: string[] = [];
  if (env['NEXUSCORE_JOB_HELPER']) list.push(env['NEXUSCORE_JOB_HELPER']);
  list.push(path.join(path.dirname(process.execPath), 'nxjob.exe'));
  list.push(path.resolve(HERE, '../../helper/nxjob/target/release/nxjob.exe'));
  list.push(path.resolve(HERE, '../../helper/nxjob.exe'));
  return list;
}

/** Der Pfad zu nxjob.exe, oder null, wenn es ihn (noch) nicht gibt. */
export function findJobHelper(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== 'win32') return null;
  return jobHelperCandidates(env).find((p) => existsSync(p)) ?? null;
}

export interface JobLimits {
  /** Wurden Grenzen ueberhaupt gewuenscht? Ohne: nur das Aufraeumen beim Beenden. */
  enforce: boolean;
  memoryMb?: number | undefined;
  /** Prozent EINES Kerns (400 = vier Kerne), wie in der Oberflaeche. */
  cpuPercent?: number | undefined;
  /** Kerne des Rechners - die CPU-Grenze bezieht sich in Windows auf die gesamte Leistung. */
  cores: number;
}

/** Die Optionen fuer nxjob vor dem `--`. */
export function jobArgs(limits: JobLimits): string[] {
  if (!limits.enforce) return [];
  const args: string[] = [];
  if (limits.memoryMb !== undefined && Number.isFinite(limits.memoryMb) && limits.memoryMb >= 64) {
    args.push('--mem-mb', String(Math.floor(limits.memoryMb)));
  }
  if (limits.cpuPercent !== undefined && Number.isFinite(limits.cpuPercent) && limits.cpuPercent > 0) {
    const cores = Math.max(1, limits.cores);
    // Alle Kerne ausgeschoepft = keine Grenze noetig
    if (limits.cpuPercent < cores * 100) {
      const rate = Math.round((limits.cpuPercent / (cores * 100)) * 10_000);
      args.push('--cpu-rate', String(Math.min(10_000, Math.max(1, rate))));
    }
  }
  return args;
}

/** Aus Programm und Argumenten den Aufruf ueber den Helfer bauen. */
export function wrapLaunch(helper: string, executable: string, args: string[], limits: JobLimits): { command: string; args: string[] } {
  return { command: helper, args: [...jobArgs(limits), '--', executable, ...args] };
}
