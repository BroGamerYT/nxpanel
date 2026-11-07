import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:net';
import { parseReadyCheck, matchesDone, tryConnect, waitForPort } from '../src/eggs/ready.js';

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

function listen(port: number): Promise<void> {
  return new Promise((res) => {
    const s = createServer();
    servers.push(s);
    s.listen(port, '127.0.0.1', () => res());
  });
}

describe('Bereitschaft aus dem Egg lesen', () => {
  it('nimmt den Porttest, wenn das Egg ihn vorgibt', () => {
    const c = parseReadyCheck({ kind: 'tcp_port', port_ref: 'web', timeout_seconds: 900 }, null, { web: 8080 });
    expect(c).toEqual({ kind: 'tcp_port', port: 8080, timeoutSeconds: 900 });
  });

  it('faellt auf den Done-Regex zurueck', () => {
    const c = parseReadyCheck(null, '\\)! For help, type', {});
    expect(c.kind).toBe('done');
  });

  it('meldet keine Bereitschaft, wenn das Egg nichts vorgibt', () => {
    expect(parseReadyCheck(null, null, {}).kind).toBe('none');
  });

  it('ignoriert einen Porttest ohne aufloesbaren Port', () => {
    expect(parseReadyCheck({ kind: 'tcp_port', port_ref: 'gibtsnicht' }, null, {}).kind).toBe('none');
  });
});

describe('Done-Regex', () => {
  it('erkennt Minecrafts Startmeldung', () => {
    const line = '[12:04:31] [Server thread/INFO]: Done (3.241s)! For help, type "help"';
    expect(matchesDone(line, '\\)! For help, type')).toBe(true);
  });

  it('schlaegt bei anderen Zeilen nicht an', () => {
    expect(matchesDone('[12:04:20] Loading libraries', '\\)! For help, type')).toBe(false);
  });

  it('vertraegt ein kaputtes Muster, ohne zu werfen', () => {
    expect(matchesDone('irgendwas', '([unvollstaendig')).toBe(false);
  });
});

describe('Porttest', () => {
  it('erkennt einen offenen Port', async () => {
    await listen(45871);
    expect(await tryConnect('127.0.0.1', 45871)).toBe(true);
  });

  it('erkennt einen geschlossenen Port', async () => {
    expect(await tryConnect('127.0.0.1', 45999, 500)).toBe(false);
  });

  it('gibt nach Ablauf der Frist auf', async () => {
    const start = Date.now();
    const ok = await waitForPort('127.0.0.1', 45998, 1, 200);
    expect(ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it('meldet Erfolg, sobald der Port auftaucht', async () => {
    const p = waitForPort('127.0.0.1', 45872, 10, 200);
    setTimeout(() => void listen(45872), 400);
    expect(await p).toBe(true);
  });
});

describe('Porttest bei totem Container', () => {
  it('gibt sofort auf, statt bis zum Zeitablauf zu warten', async () => {
    const start = Date.now();
    const ok = await waitForPort('127.0.0.1', 45997, 30, 100, async () => false);
    expect(ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

