import fs from 'node:fs/promises';
import path from 'node:path';
import type { HostDriver } from '../drivers/interface.js';
import type { LoadedEgg } from '../eggs/loader.js';
import { resolveInsideRoot, serverRootFor } from '../protocol/paths.js';
import type { EventBus } from '../protocol/events.js';
import { serverListPing, type SlpResult } from '../games/minecraft.js';
import { installPlanFor, type InstallManager } from '../install/manager.js';
import { logger } from '../logger.js';
import type { PowerOps } from '../ops/power.js';
import type { ServerRegistry } from '../store/registry.js';
import type { ServerInstanceConfig } from '../types.js';

/**
 * Spiele-Testlauf (Seite "Spiele-Testbericht"): fuer jedes Spiel, das der Core
 * selbst installieren kann, einen Wegwerf-Server anlegen, installieren,
 * starten, auf "bereit" warten, stoppen und wieder loeschen. Das Ergebnis
 * steht als JSON, Markdown und Log im Datenverzeichnis - gedacht fuer einen
 * Lauf ueber Nacht.
 *
 * Der Testserver heisst `selftest-<spiel>` und wird nach jedem Spiel samt
 * Dateien geloescht (ein Steam-Spiel hat mehrere GB). Fuer Minecraft setzt der
 * Testlauf die EULA fuer diesen Wegwerf-Server - er ist vom Nutzer gestartet
 * und verschwindet wieder.
 */

export type TestStatus = 'SUCCESS' | 'INSTALL_FAILED' | 'START_CRASHED' | 'TIMEOUT';
export type TestMode = 'resume' | 'fresh' | 'retry-failed';

export interface TestResult {
  eggId: string;
  eggName: string;
  status: TestStatus;
  installDurationSec: number;
  runtimeDurationSec: number;
  errorSummary: string | null;
  logExcerpt: string;
  testedAt: string;
}

export interface TestCase {
  /** Kennung im Bericht, z. B. "palworld" oder "minecraft-vanilla". */
  id: string;
  name: string;
  eggId: string;
  variables: Record<string, string>;
  /** Wann gilt das Spiel als bereit? */
  ready: 'minecraft-ping' | 'stays-running';
}

export interface TesterDeps {
  registry: ServerRegistry;
  driver: HostDriver;
  bus: EventBus;
  /** null = der Treiber kann nicht installieren (nur Windows). */
  installs: InstallManager | null;
  power: PowerOps;
  eggs: () => Promise<LoadedEgg[]>;
  variablesFor: (eggId: string, given?: Record<string, string>) => Promise<{ variables: Record<string, string>; propertiesTemplate: Record<string, string> }>;
  portsFor: (raw: unknown, firstPort: number) => Promise<ServerInstanceConfig['ports']>;
  allocatePort: (existing: ServerInstanceConfig[]) => Promise<number>;
  ping?: (host: string, port: number) => Promise<SlpResult>;
  /** Fuer Tests: eigene Faelle statt der echten. */
  cases?: () => Promise<TestCase[]>;
  sleep?: (ms: number) => Promise<void>;
  /** Abstand der Zustandsabfragen (Tests: klein). */
  pollMs?: number;
  /** So lange muss ein Spiel ohne Absturz laufen, damit es als bereit gilt ("stays-running"). */
  settleMs?: number;
}

export interface StartOptions {
  mode?: TestMode;
  only?: string | undefined;
  /** Minuten, die ein Spiel zum Starten haben darf. */
  timeout?: number | undefined;
  cpuPercent?: number | undefined;
  ramMb?: number | undefined;
}

interface State {
  status: 'idle' | 'running' | 'done' | 'stopped' | 'interrupted';
  startedAt: string | null;
  mode: TestMode | null;
  currentEgg: string | null;
  currentEggIndex: number;
  totalEggs: number;
  cpuPercent: number | null;
  ramMb: number | null;
}

const IDLE: State = { status: 'idle', startedAt: null, mode: null, currentEgg: null, currentEggIndex: 0, totalEggs: 0, cpuPercent: null, ramMb: null };
const PREFIX = 'selftest-';

export class TesterError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'test_error',
  ) {
    super(message);
    this.name = 'TesterError';
  }
}

export class GameTester {
  readonly reportsDir: string;
  private state: State = { ...IDLE };
  private running: Promise<void> | null = null;
  private stopRequested = false;
  /** Reihenfolge der Spiele im Bericht (stabil, auch wenn nur einzelne neu laufen). */
  private order: string[] = [];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ping: (host: string, port: number) => Promise<SlpResult>;

  constructor(private readonly deps: TesterDeps) {
    this.reportsDir = path.join(deps.registry.dir, 'test-reports');
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ping = deps.ping ?? ((host, port) => serverListPing(host, port));
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  /** Wartet auf das Ende des Laufs (Tests, Beenden des Cores). */
  async whenDone(): Promise<void> {
    await this.running?.catch(() => {});
  }

  // ------------------------------------------------------------ Faelle

  /** Alle Spiele, die der Core installieren kann. */
  async cases(): Promise<TestCase[]> {
    if (this.deps.cases) return this.deps.cases();
    const out: TestCase[] = [];
    for (const egg of await this.deps.eggs()) {
      if (egg.id === 'minecraft-paper') {
        out.push({ id: 'minecraft-paper', name: 'Minecraft Paper', eggId: egg.id, variables: { TYPE: 'PAPER', EULA: 'TRUE' }, ready: 'minecraft-ping' });
        out.push({ id: 'minecraft-vanilla', name: 'Minecraft Vanilla', eggId: egg.id, variables: { TYPE: 'VANILLA', EULA: 'TRUE' }, ready: 'minecraft-ping' });
        continue;
      }
      if (installPlanFor(egg.id, egg.raw, {})) out.push({ id: egg.id, name: egg.name, eggId: egg.id, variables: {}, ready: 'stays-running' });
    }
    return out;
  }

  // ------------------------------------------------------------ Berichte

  private file(name: string): string {
    return path.join(this.reportsDir, name);
  }

  private async log(line: string): Promise<void> {
    const text = `[${new Date().toLocaleString('de-DE')}] ${line}\n`;
    await fs.mkdir(this.reportsDir, { recursive: true });
    await fs.appendFile(this.file('test-games.log'), text, 'utf8').catch(() => {});
    logger.info({ testRun: true }, line);
  }

  private async readResults(): Promise<TestResult[]> {
    try {
      return (JSON.parse(await fs.readFile(this.file('game-install-results.json'), 'utf8')) as { results?: TestResult[] }).results ?? [];
    } catch {
      return [];
    }
  }

  private async writeResults(unsorted: TestResult[], total: number): Promise<void> {
    const rank = (r: TestResult) => {
      const i = this.order.indexOf(r.eggId);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const results = [...unsorted].sort((a, b) => rank(a) - rank(b));
    const success = results.filter((r) => r.status === 'SUCCESS').length;
    await fs.mkdir(this.reportsDir, { recursive: true });
    await fs.writeFile(
      this.file('game-install-results.json'),
      JSON.stringify({ updated: new Date().toISOString(), total, success, failed: results.length - success, results }, null, 2),
      'utf8',
    );
    const rows = results.map((r) => `| ${r.eggName} | ${r.status === 'SUCCESS' ? 'OK' : r.status} | ${r.installDurationSec} s | ${r.runtimeDurationSec} s | ${(r.errorSummary ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ')} |`);
    await fs.writeFile(
      this.file('game-install-results.md'),
      `# Spiele-Testbericht\n\nStand: ${new Date().toLocaleString('de-DE')} - ${success} von ${results.length} getesteten Spielen bestanden (${total} insgesamt).\n\n| Spiel | Ergebnis | Installation | Laufzeit | Hinweis |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`,
      'utf8',
    );
  }

  private async saveState(patch: Partial<State>): Promise<void> {
    this.state = { ...this.state, ...patch };
    await fs.mkdir(this.reportsDir, { recursive: true });
    await fs.writeFile(this.file('state.json'), JSON.stringify(this.state, null, 2), 'utf8').catch(() => {});
  }

  /** Antwort fuer die Oberflaeche. */
  async report(): Promise<Record<string, unknown>> {
    let state = this.state;
    if (!this.running) {
      // Ein Lauf, der beim Beenden des Cores noch "running" war, ist unterbrochen
      try {
        const saved = JSON.parse(await fs.readFile(this.file('state.json'), 'utf8')) as State;
        state = saved.status === 'running' ? { ...saved, status: 'interrupted' } : saved;
      } catch {
        state = this.state;
      }
    }
    const jsonReport = await fs.readFile(this.file('game-install-results.json'), 'utf8').then((s) => JSON.parse(s) as unknown, () => null);
    const markdownReport = await fs.readFile(this.file('game-install-results.md'), 'utf8').catch(() => null);
    const logTail = await fs
      .readFile(this.file('test-games.log'), 'utf8')
      .then((s) => s.split('\n').filter(Boolean).slice(-40).join('\n'))
      .catch(() => null);
    return {
      isRunning: this.isRunning(),
      startedAt: state.startedAt,
      currentEgg: this.isRunning() ? state.currentEgg : null,
      currentEggIndex: state.currentEggIndex,
      totalEggs: state.totalEggs,
      status: state.status,
      mode: state.mode,
      cpuPercent: state.cpuPercent,
      ramMb: state.ramMb,
      jsonReport,
      markdownReport,
      logTail,
    };
  }

  // ------------------------------------------------------------ Lauf

  async start(options: StartOptions = {}): Promise<{ startedAt: string; mode: TestMode }> {
    if (this.running) throw new TesterError('Ein Testlauf läuft bereits', 409, 'conflict');
    if (!this.deps.installs) {
      throw new TesterError('Der Testlauf installiert Spiele und braucht deshalb den Windows-Treiber.', 409, 'not_supported');
    }
    const mode = options.mode ?? 'resume';
    const all = await this.cases();
    const wanted = options.only ? all.filter((c) => c.id === options.only) : all;
    if (wanted.length === 0) throw new TesterError(options.only ? `Unbekanntes Spiel: ${options.only}` : 'Es gibt keine Spiele zum Testen.', 400, 'invalid_request');

    const previous = mode === 'fresh' ? [] : await this.readResults();
    const done = new Set(previous.filter((r) => (mode === 'retry-failed' ? r.status === 'SUCCESS' : true)).map((r) => r.eggId));
    const todo = wanted.filter((c) => !done.has(c.id));
    this.order = all.map((c) => c.id);

    const startedAt = new Date().toISOString();
    this.stopRequested = false;
    await this.saveState({ status: 'running', startedAt, mode, currentEgg: null, currentEggIndex: 0, totalEggs: wanted.length, cpuPercent: options.cpuPercent ?? null, ramMb: options.ramMb ?? null });
    this.running = this.run(todo, wanted.length, previous, options).finally(() => {
      this.running = null;
    });
    this.running.catch(() => {});
    return { startedAt, mode };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopRequested = true;
    await this.log('Anhalten angefordert - wirkt, sobald der laufende Schritt beendet ist');
  }

  private async run(todo: TestCase[], total: number, previous: TestResult[], options: StartOptions): Promise<void> {
    const results = previous.filter((r) => !todo.some((c) => c.id === r.eggId));
    try {
      await this.log(`Testlauf startet: ${todo.length} von ${total} Spielen (${this.state.mode})`);
      await this.cleanupLeftovers();
      let index = total - todo.length;
      for (const testCase of todo) {
        if (this.stopRequested) break;
        index++;
        await this.saveState({ currentEgg: testCase.name, currentEggIndex: index });
        await this.log(`--- ${testCase.name} (${index} von ${total})`);
        const result = await this.runCase(testCase, options);
        await this.log(`${testCase.name}: ${result.status}${result.errorSummary ? ` - ${result.errorSummary}` : ''}`);
        const at = results.findIndex((r) => r.eggId === result.eggId);
        if (at >= 0) results[at] = result;
        else results.push(result);
        await this.writeResults(results, total);
      }
      await this.saveState({ status: this.stopRequested ? 'stopped' : 'done', currentEgg: null });
      await this.log(this.stopRequested ? 'Testlauf angehalten' : 'Testlauf beendet');
    } catch (err) {
      await this.log(`Testlauf abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
      await this.saveState({ status: 'stopped', currentEgg: null });
    }
  }

  /** Reste eines frueheren, abgebrochenen Laufs entfernen. */
  private async cleanupLeftovers(): Promise<void> {
    for (const c of this.deps.registry.list()) if (c.id.startsWith(PREFIX)) await this.discard(c.id);
  }

  private async discard(id: string): Promise<void> {
    const { registry, driver } = this.deps;
    const c = registry.get(id);
    if (!c) return;
    await driver.killServer(id).catch(() => {});
    await driver.unregisterServer?.(id).catch(() => {});
    // Nur unter dem Server-Verzeichnis loeschen, nur Testserver
    const dir = await resolveInsideRoot(serverRootFor(registry.dir), c.workingDir, 'workingDir').catch(() => null);
    if (dir && id.startsWith(PREFIX)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch(() => {});
    await registry.remove(id);
  }

  private excerpt(serverId: string): string {
    return this.deps.bus
      .logsFor(serverId, 40)
      .map((l) => l.line)
      .join('\n')
      .slice(-4000);
  }

  private async runCase(testCase: TestCase, options: StartOptions): Promise<TestResult> {
    const { registry, driver, installs, power } = this.deps;
    const id = `${PREFIX}${testCase.id}`.slice(0, 60);
    const base = { eggId: testCase.id, eggName: testCase.name, testedAt: new Date().toISOString() };
    const fail = (status: TestStatus, summary: string, install: number, runtime: number): TestResult => ({
      ...base,
      status,
      installDurationSec: install,
      runtimeDurationSec: runtime,
      errorSummary: summary,
      logExcerpt: this.excerpt(id),
    });
    let installSec = 0;
    let runtimeSec = 0;

    try {
      await this.discard(id); // falls etwas uebrig ist
      const egg = (await this.deps.eggs()).find((e) => e.id === testCase.eggId);
      const data = await this.deps.variablesFor(testCase.eggId, testCase.variables);
      const plan = installPlanFor(testCase.eggId, egg?.raw, data.variables);
      if (!plan || !installs) return fail('INSTALL_FAILED', 'Der Core kann dieses Spiel nicht installieren.', 0, 0);

      const serverDir = await resolveInsideRoot(serverRootFor(registry.dir), id, 'id');
      await fs.mkdir(serverDir, { recursive: true });
      const firstPort = await this.deps.allocatePort(registry.list());
      const ports = plan.kind === 'steamcmd' || plan.kind === 'download' ? await this.deps.portsFor(egg?.raw.ports, firstPort) : [{ name: 'game', hostPort: firstPort, protocol: 'tcp' as const }];
      await registry.add({
        id,
        name: `Test ${testCase.name}`,
        game: testCase.eggId,
        executable: '',
        args: [],
        workingDir: serverDir,
        maxMemoryMb: options.ramMb ?? 4096,
        maxCpuPercent: options.cpuPercent ?? 100,
        ports,
        install: { state: 'installing', kind: plan.kind, ...(plan.steam ? { steam: plan.steam } : {}), ...data },
      });

      // 1) Installation
      const t0 = Date.now();
      installs.start(id, { kind: plan.kind, ...(plan.steam ? { steam: plan.steam } : {}), ...data });
      await installs.whenIdle(id);
      installSec = Math.round((Date.now() - t0) / 1000);
      const installed = registry.get(id);
      if (installed?.install?.state !== 'done') {
        return fail('INSTALL_FAILED', installed?.install?.error ?? 'Installation fehlgeschlagen', installSec, 0);
      }
      if (this.stopRequested) return fail('INSTALL_FAILED', 'Angehalten', installSec, 0);

      // 2) Start und Bereitschaft
      const t1 = Date.now();
      await power.start(id);
      const timeoutMs = (options.timeout ?? 20) * 60_000;
      const settleMs = this.deps.settleMs ?? 60_000;
      const poll = this.deps.pollMs ?? 3000;
      const port = installed.ports[0]?.hostPort ?? firstPort;
      let outcome: TestResult | null = null;
      let runningSince: number | null = null;
      while (!outcome) {
        await this.sleep(poll);
        const elapsed = Date.now() - t1;
        const state = await driver.getServerState(id).catch(() => undefined);
        if (this.stopRequested) {
          outcome = fail('TIMEOUT', 'Angehalten', installSec, Math.round(elapsed / 1000));
        } else if (!state || state.status === 'error' || state.status === 'offline') {
          outcome = fail('START_CRASHED', `Der Server ist beendet${state?.exitCode !== undefined ? ` (Code ${state.exitCode})` : ''}`, installSec, Math.round(elapsed / 1000));
        } else if (state.status === 'running') {
          runningSince ??= Date.now();
          const ready =
            testCase.ready === 'minecraft-ping'
              ? await this.ping('127.0.0.1', port).then(() => true, () => false)
              : Date.now() - runningSince >= settleMs;
          if (ready) {
            runtimeSec = Math.round((Date.now() - t1) / 1000);
            outcome = { ...base, status: 'SUCCESS', installDurationSec: installSec, runtimeDurationSec: runtimeSec, errorSummary: null, logExcerpt: this.excerpt(id) };
          }
        }
        if (!outcome && elapsed > timeoutMs) {
          outcome = fail('TIMEOUT', `Nach ${options.timeout ?? 20} Minuten nicht bereit`, installSec, Math.round(elapsed / 1000));
        }
      }
      // 3) Stoppen (das Ergebnis steht fest, auch wenn das Stoppen holpert)
      await power.stop(id).catch(() => {});
      for (let i = 0; i < 20; i++) {
        const s = await driver.getServerState(id).catch(() => undefined);
        if (!s || s.status === 'offline' || s.status === 'error') break;
        await this.sleep(Math.min(poll, 1500));
      }
      return outcome;
    } catch (err) {
      return fail('INSTALL_FAILED', err instanceof Error ? err.message : String(err), installSec, runtimeSec);
    } finally {
      await this.discard(id);
    }
  }
}
