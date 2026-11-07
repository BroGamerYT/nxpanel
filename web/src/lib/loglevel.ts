export type Level = 'error' | 'warn' | 'info';

// eslint-disable-next-line no-control-regex
export const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const plain = (s: string) => s.replace(ANSI, '');

/**
 * Fehler und Warnungen erkennen - spieluebergreifend nach den ueblichen
 * Mustern (Minecraft "[Server thread/ERROR]", Java-Exceptions, Linux-
 * Meldungen wie "No space left on device", Proton/Wine "err:").
 * Java-Stacktrace-Zeilen ("at a.b.C(...)") zaehlen nicht einzeln, sonst
 * stuenden nach einer Exception 40 "Fehler" in der Liste.
 */
export function classify(raw: string): Level {
  const s = plain(raw);
  if (/^\s+at [\w.$<>]+\(/.test(s) || /^\s*\.\.\. \d+ more/.test(s)) return 'info';
  if (/\b(ERROR|SEVERE|FATAL|CRITICAL|PANIC)\b|Exception\b|\bError:|\berr:|no space left|permission denied|segmentation fault|out of memory|cannot (write|open|allocate|connect)|failed to\b|\bcrash(ed)?\b/i.test(s)) return 'error';
  if (/\b(WARN|WARNING)\b|\bwarn:|deprecated|can't keep up|running behind|timed out/i.test(s)) return 'warn';
  return 'info';
}

