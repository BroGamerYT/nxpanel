import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../log.js';

export interface TestRunnerState {
  status: 'idle' | 'running' | 'finished' | 'stopped' | 'crashed';
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  currentEgg: string | null;
  currentEggIndex: number;
  totalEggs: number;
  mode: 'resume' | 'fresh' | 'retry-failed';
  cpuPercent?: number | null;
  ramMb?: number | null;
  pid: number | null;
}

const DEFAULT_STATE: TestRunnerState = {
  status: 'idle',
  startedAt: null,
  updatedAt: null,
  finishedAt: null,
  currentEgg: null,
  currentEggIndex: 0,
  totalEggs: 0,
  mode: 'resume',
  cpuPercent: null,
  ramMb: null,
  pid: null,
};

let activeTestProcess: ChildProcess | null = null;
let activeLogStream: ReturnType<typeof createWriteStream> | null = null;

/**
 * Liefert den Pfad zum persistenten Testberichte-Verzeichnis.
 * Auf der VM ist /var/lib/panel ein Host-Mount und übersteht Deployments und Container-Neustarts.
 * In der lokalen Entwicklungsumgebung wird der Ordner docs/ im Projekt genutzt.
 */
export function getTestReportsDir(): string {
  if (existsSync('/var/lib/panel')) {
    const dir = join('/var/lib/panel', 'test-reports');
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {}
    }
    return dir;
  }
  const docs = join(process.cwd(), 'docs');
  if (!existsSync(docs)) {
    try {
      mkdirSync(docs, { recursive: true });
    } catch {}
  }
  return docs;
}

/** Liest den aktuellen Zustand des Test-Runners aus test-state.json */
export async function getTestState(): Promise<TestRunnerState> {
  const statePath = join(getTestReportsDir(), 'test-state.json');
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TestRunnerState>;
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Aktualisiert test-state.json */
export async function saveTestState(update: Partial<TestRunnerState>): Promise<TestRunnerState> {
  const current = await getTestState();
  const next: TestRunnerState = {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  const dir = getTestReportsDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
  await writeFile(join(dir, 'test-state.json'), JSON.stringify(next, null, 2), 'utf8').catch(() => {});
  return next;
}

/** Prüft, ob ein Test-Prozess aktuell aktiv läuft */
export function isTestRunning(): boolean {
  return !!(activeTestProcess && activeTestProcess.exitCode === null && !activeTestProcess.killed);
}

export interface StartTestOptions {
  mode?: 'resume' | 'fresh' | 'retry-failed' | undefined;
  only?: string | undefined;
  timeout?: number | undefined;
  cpuPercent?: number | undefined;
  ramMb?: number | undefined;
}

/**
 * Startet den automatischen Test-Runner im Hintergrund.
 */
export async function startTestRunner(opts: StartTestOptions = {}): Promise<{ ok: boolean; startedAt: string }> {
  if (isTestRunning()) {
    throw new Error('Ein Testlauf läuft bereits im Hintergrund.');
  }

  const mode = opts.mode ?? 'resume';
  const reportsDir = getTestReportsDir();
  await mkdir(reportsDir, { recursive: true }).catch(() => {});

  const logPath = join(reportsDir, 'test-games.log');
  // Bei mode === 'fresh' Log leeren, sonst mit Separator anhängen
  const flags = mode === 'fresh' ? 'w' : 'a';
  activeLogStream = createWriteStream(logPath, { flags });

  if (mode !== 'fresh') {
    activeLogStream.write(`\n\n=== [TEST-RUNNER WIEDERAUFGENOMMEN: ${new Date().toISOString()} | Modus: ${mode}] ===\n\n`);
  }

  const prodScript = join(process.cwd(), 'dist', 'cli', 'test-all-games.js');
  const isProd = existsSync(prodScript);
  const cmd = isProd ? process.execPath : (process.platform === 'win32' ? 'npx.cmd' : 'npx');

  const cliArgs: string[] = isProd
    ? [prodScript, `--mode=${mode}`]
    : ['tsx', 'src/cli/test-all-games.ts', `--mode=${mode}`];

  if (opts.only) cliArgs.push(`--only=${opts.only}`);
  if (opts.timeout) cliArgs.push(`--timeout=${opts.timeout}`);
  if (opts.cpuPercent !== undefined) cliArgs.push(`--cpu=${opts.cpuPercent}`);
  if (opts.ramMb !== undefined) cliArgs.push(`--ram=${opts.ramMb}`);

  const startedAt = new Date().toISOString();

  activeTestProcess = spawn(cmd, cliArgs, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = activeTestProcess.pid ?? null;

  await saveTestState({
    status: 'running',
    startedAt,
    finishedAt: null,
    mode,
    cpuPercent: opts.cpuPercent ?? null,
    ramMb: opts.ramMb ?? null,
    pid,
  });

  activeTestProcess.stdout?.pipe(activeLogStream, { end: false });
  activeTestProcess.stderr?.pipe(activeLogStream, { end: false });

  activeTestProcess.on('exit', async (code) => {
    activeLogStream?.end();
    activeLogStream = null;
    activeTestProcess = null;

    const finalStatus = code === 0 ? 'finished' : 'stopped';
    await saveTestState({
      status: finalStatus,
      finishedAt: new Date().toISOString(),
      pid: null,
    });
    log.info({ code, finalStatus }, '[Spiele-Tests] Test-Runner-Prozess beendet');
  });

  activeTestProcess.on('error', async (err) => {
    log.error({ err }, '[Spiele-Tests] Fehler im Test-Runner-Prozess');
    activeLogStream?.end();
    activeLogStream = null;
    activeTestProcess = null;
    await saveTestState({
      status: 'crashed',
      finishedAt: new Date().toISOString(),
      pid: null,
    });
  });

  log.info({ mode, pid, logPath }, '[Spiele-Tests] Test-Runner erfolgreich gestartet');
  return { ok: true, startedAt };
}

/** Stoppt einen laufenden Testlauf */
export async function stopTestRunner(): Promise<{ ok: boolean }> {
  if (activeTestProcess && activeTestProcess.exitCode === null && !activeTestProcess.killed) {
    activeTestProcess.kill('SIGTERM');
    // Nach 5s forciertes SIGKILL, falls er hängt
    setTimeout(() => {
      if (activeTestProcess && !activeTestProcess.killed) {
        activeTestProcess.kill('SIGKILL');
      }
    }, 5000);
  }

  await saveTestState({
    status: 'stopped',
    finishedAt: new Date().toISOString(),
    pid: null,
  });

  return { ok: true };
}

/**
 * Wird beim Panel-Start (src/index.ts) aufgerufen:
 * Prüft, ob vor dem Neustart/Deploy ein Testlauf lief und setzt ihn nahtlos fort!
 */
export async function resumeTestRunnerIfInterrupted(): Promise<void> {
  try {
    const state = await getTestState();
    if (state.status === 'running') {
      log.info(
        { currentEgg: state.currentEgg, currentEggIndex: state.currentEggIndex },
        '[Spiele-Tests] Unterbrochener Testlauf nach Neustart/Deploy erkannt! Setze Tests im Hintergrund fort...',
      );
      // Kurze Pause damit DB und Docker vollständig bereit sind
      setTimeout(async () => {
        try {
          if (!isTestRunning()) {
            await startTestRunner({
              mode: 'resume',
              cpuPercent: state.cpuPercent ?? undefined,
              ramMb: state.ramMb ?? undefined,
            });
          }
        } catch (err) {
          log.warn({ err }, '[Spiele-Tests] Automatische Wiederaufnahme fehlgeschlagen');
        }
      }, 5000);
    }
  } catch (err) {
    log.warn({ err }, '[Spiele-Tests] Fehler beim Prüfen auf unterbrochenen Testlauf');
  }
}
