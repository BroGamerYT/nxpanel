import { createConnection } from 'node:net';
import { log } from '../log.js';

/**
 * Wann gilt ein Server als bereit?
 *
 * Zwei Wege, weil kein einzelner fuer alle Spiele reicht:
 *
 *   done   Ein Muster im Log, etwa Minecrafts 'Done (3.241s)!'.
 *          Genau, aber nur bei Spielen, die so etwas schreiben.
 *
 *   port   Der Spiel- oder Weboberflaechen-Port nimmt Verbindungen an.
 *          Noetig bei Spielen wie Farming Simulator, die ihre Bereitschaft
 *          nie ins Log schreiben. Ohne diesen Weg stuende das Panel dort
 *          ewig auf 'starting'.
 */

export type ReadyCheck =
  | { kind: 'done'; regex: string; timeoutSeconds?: number }
  | { kind: 'tcp_port'; port: number; timeoutSeconds?: number }
  | { kind: 'none' };

export interface ReadySpec {
  kind?: string;
  regex?: string;
  port?: number;
  port_ref?: string;
  timeout_seconds?: number;
}

export function parseReadyCheck(
  spec: ReadySpec | null | undefined,
  doneRegex: string | null | undefined,
  ports: Record<string, number>,
): ReadyCheck {
  if (spec?.kind === 'tcp_port') {
    const port = spec.port ?? (spec.port_ref ? ports[spec.port_ref] : undefined);
    if (port) {
      return { kind: 'tcp_port', port, ...(spec.timeout_seconds ? { timeoutSeconds: spec.timeout_seconds } : {}) };
    }
    log.warn({ spec }, 'Porttest im Egg ohne gueltigen Port');
  }

  if (spec?.kind === 'done' && spec.regex) {
    return { kind: 'done', regex: spec.regex, ...(spec.timeout_seconds ? { timeoutSeconds: spec.timeout_seconds } : {}) };
  }

  if (doneRegex) return { kind: 'done', regex: doneRegex };

  return { kind: 'none' };
}

/** Prueft eine einzelne Logzeile gegen das Bereitschaftsmuster. */
export function matchesDone(line: string, regex: string): boolean {
  try {
    return new RegExp(regex).test(line);
  } catch {
    // Ein unuebersetzbares Muster darf den Start nicht aufhalten; das Egg
    // wird dann eben nie 'running' melden und laeuft in den Zeitablauf.
    return false;
  }
}

/** Wartet darauf, dass ein Port Verbindungen annimmt. */
export async function waitForPort(
  host: string,
  port: number,
  timeoutSeconds = 300,
  intervalMs = 2000,
  stillAlive?: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    if (await tryConnect(host, port, 2000)) return true;
    // Ist der Container tot, kommt der Port nie - nicht bis zum Ende warten.
    if (stillAlive && !(await stillAlive())) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export function tryConnect(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}
