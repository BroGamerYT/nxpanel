import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import type { HostDriver, LogSink } from './interface.js';
import type { ServerInstanceConfig, ServerState, ServerStats } from '../types.js';

const execFileAsync = promisify(execFile);

interface ProcessEntry {
  config: ServerInstanceConfig;
  state: ServerState;
  process?: ChildProcess;
  stdoutRest: string;
  stderrRest: string;
  lastCpuSample?: { totalSeconds: number; at: number };
  /** Der Start ist gescheitert - dann bleibt der Zustand "error", auch wenn der Prozess danach endet. */
  failed: boolean;
}

/**
 * Puffer fuer Zeilen aus einem Datenstrom.
 *
 * Prozesse schreiben nicht zeilenweise, sondern in Brocken. Der Rest einer
 * unvollstaendigen Zeile wandert deshalb in den naechsten Chunk.
 */
class LineBuffer {
  private rest = '';

  push(chunk: string): string[] {
    this.rest += chunk;
    const parts = this.rest.split(/\r?\n/);
    this.rest = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }

  flush(): string | null {
    const rest = this.rest;
    this.rest = '';
    return rest.length > 0 ? rest : null;
  }
}

/**
 * Windows-nativer Treiber.
 *
 * Startet den Gameserver als echten Prozess, streamt stdout/stderr zeilenweise
 * in den Event-Bus und raeumt beim Stopp den kompletten Prozessbaum auf.
 *
 * Wichtig: Unter Windows gibt es kein SIGTERM. `child.kill('SIGTERM')` beendet
 * den Prozess so hart wie SIGKILL. Deshalb wird `taskkill` benutzt: ohne `/F`
 * versucht Windows zuerst ordentlich zu schliessen, mit `/F` wird der Baum
 * erzwungen beendet. Ein echter "sanfter" Stopp (z. B. ueber die Konsole des
 * Spiels) ist derzeit nicht moeglich und wird nirgends vorgetaeuscht.
 */
export class WindowsNativeDriver implements HostDriver {
  readonly name = 'windows-native';
  private readonly instances = new Map<string, ProcessEntry>();
  private logSink: LogSink = () => {};

  async initialize(): Promise<void> {
    if (process.platform !== 'win32') {
      console.warn(
        '[WindowsNativeDriver] Nicht auf Windows gestartet - hier werden keine Prozesse gestartet.',
      );
      return;
    }
    console.log(
      '[WindowsNativeDriver] Initialisiert (Windows Host, nativer Prozess-Runner).',
    );
  }

  setLogSink(sink: LogSink): void {
    this.logSink = sink;
  }

  async registerServer(config: ServerInstanceConfig): Promise<ServerState> {
    if (this.instances.has(config.id)) {
      throw new Error(`Server "${config.id}" existiert bereits.`);
    }
    const state: ServerState = { id: config.id, status: 'offline' };
    this.instances.set(config.id, {
      config,
      state,
      stdoutRest: '',
      stderrRest: '',
      failed: false,
    });
    return state;
  }

  async startServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);

    if (entry.state.status === 'running' || entry.state.status === 'starting') {
      return entry.state;
    }
    if (process.platform !== 'win32') {
      throw new Error(
        'Der WindowsNativeDriver kann nur unter Windows laufen - bitte NEXUSCORE_RUNTIME=docker oder mock setzen.',
      );
    }

    entry.state.status = 'starting';
    this.emit(
      serverId,
      `[WindowsNative] Starte ${entry.config.executable} ${entry.config.args.join(' ')}`,
    );

    let child: ChildProcess;
    try {
      child = spawn(entry.config.executable, entry.config.args, {
        cwd: entry.config.workingDir || process.cwd(),
        env: { ...process.env, ...(entry.config.env ?? {}) },
        // Kein shell: sonst wuerde die Kommandozeile zerlegt und ein Argument
        // mit Leerzeichen oder Anfuehrungszeichen koennte Code ausfuehren.
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      entry.state.status = 'error';
      this.emit(serverId, `[FEHLER] Prozessstart fehlgeschlagen: ${(err as Error).message}`);
      throw err;
    }

    entry.process = child;
    entry.stdoutRest = '';
    entry.stderrRest = '';
    entry.failed = false;
    entry.state.status = 'running';
    entry.state.startedAt = new Date().toISOString();
    if (child.pid !== undefined) entry.state.pid = child.pid;

    const stdoutBuffer = new LineBuffer();
    const stderrBuffer = new LineBuffer();

    child.stdout?.on('data', (data: Buffer) => {
      for (const line of stdoutBuffer.push(data.toString())) {
        this.emit(serverId, line);
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      for (const line of stderrBuffer.push(data.toString())) {
        this.emit(serverId, `[STDERR] ${line}`, 'stderr');
      }
    });

    child.on('close', (code, signal) => {
      const restOut = stdoutBuffer.flush();
      if (restOut) this.emit(serverId, restOut);
      const restErr = stderrBuffer.flush();
      if (restErr) this.emit(serverId, `[STDERR] ${restErr}`, 'stderr');

      // Ein gescheiterter Start bleibt "error" - das close-EVENT darf den
      // Fehlerzustand nicht wieder ueberschreiben.
      if (!entry.failed) {
        entry.state.status = 'offline';
      }
      if (code !== null && code !== undefined) entry.state.exitCode = code;
      entry.state.exitedAt = new Date().toISOString();
      delete entry.state.pid;
      delete entry.process;
      delete entry.lastCpuSample;
      this.emit(
        serverId,
        `[WindowsNative] Prozess beendet (Code ${code ?? 'unbekannt'}${signal ? `, Signal ${signal}` : ''})`,
      );
    });

    child.on('error', (err) => {
      entry.failed = true;
      entry.state.status = 'error';
      this.emit(serverId, `[FEHLER] Prozessstart fehlgeschlagen: ${err.message}`);
    });

    return entry.state;
  }

  async stopServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    const pid = entry.state.pid;

    if (pid === undefined) {
      entry.state.status = 'offline';
      return entry.state;
    }

    entry.state.status = 'stopping';
    this.emit(serverId, `[WindowsNative] Beende Prozessbaum ${pid} (taskkill /T)...`);
    await this.taskkill(pid, false);

    return entry.state;
  }

  async killServer(serverId: string): Promise<ServerState> {
    const entry = this.require(serverId);
    const pid = entry.state.pid;

    if (pid === undefined) {
      entry.state.status = 'offline';
      return entry.state;
    }

    this.emit(serverId, `[WindowsNative] Breche Prozessbaum ${pid} ab (taskkill /T /F)...`);
    await this.taskkill(pid, true);

    entry.state.status = 'offline';
    delete entry.state.pid;
    delete entry.process;
    return entry.state;
  }

  async getServerState(serverId: string): Promise<ServerState> {
    return this.require(serverId).state;
  }

  async getServerStats(serverId: string): Promise<ServerStats> {
    const entry = this.require(serverId);
    const running = entry.state.status === 'running';
    const pid = entry.state.pid;
    const startedAt = entry.state.startedAt;

    if (!running || pid === undefined) {
      return {
        serverId,
        status: entry.state.status,
        cpuPercent: 0,
        memoryMb: 0,
        uptimeSeconds: 0,
      };
    }
    const sample = await this.readProcessSample(pid);
    const now = Date.now();
    let cpuPercent = 0;

    if (sample) {
      const previous = entry.lastCpuSample;
      if (previous) {
        const seconds = (now - previous.at) / 1000;
        const delta = sample.totalSeconds - previous.totalSeconds;
        if (seconds > 0 && delta >= 0) {
          // Prozent des gesamten Systems, so wie der Task-Manager anzeigt.
          const cores = Math.max(1, os.cpus().length);
          cpuPercent = Math.round(((delta / seconds / cores) * 100) * 10) / 10;
        }
      }
      entry.lastCpuSample = { totalSeconds: sample.totalSeconds, at: now };
    }

    return {
      serverId,
      status: entry.state.status,
      pid,
      cpuPercent,
      memoryMb: sample ? Math.round(sample.workingSetBytes / (1024 * 1024)) : 0,
      uptimeSeconds: startedAt
        ? Math.floor((Date.now() - Date.parse(startedAt)) / 1000)
        : 0,
      ...(startedAt ? { startedAt } : {}),
    };
  }

  async listServers(): Promise<ServerState[]> {
    return Array.from(this.instances.values()).map((e) => e.state);
  }

  async shutdown(): Promise<void> {
    for (const entry of this.instances.values()) {
      const pid = entry.state.pid;
      if (pid !== undefined) {
        await this.taskkill(pid, true);
      }
    }
  }

  private require(serverId: string): ProcessEntry {
    const entry = this.instances.get(serverId);
    if (!entry) throw new Error(`Server "${serverId}" ist nicht registriert.`);
    return entry;
  }

  private emit(serverId: string, line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.logSink({ serverId, line, stream, ts: new Date().toISOString() });
  }

  /**
   * Beendet einen Prozess samt Kindprozessen.
   *
   * `taskkill /T` raeumt den ganzen Baum ab - ein Gameserver startet oft
   * Hilfsprozesse, die sonst als Waisen zurueckbleiben.
   */
  private async taskkill(pid: number, force: boolean): Promise<void> {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    try {
      await execFileAsync('taskkill', args, { windowsHide: true });
    } catch (err) {
      // Prozess schon weg - kein Fehler, das ist der Normalfall nach einem Stopp.
      const code = (err as { code?: number }).code;
      if (code !== 128 && code !== 1) {
        this.emit(String(pid), `[WindowsNative] taskkill fehlgeschlagen: ${(err as Error).message}`);
      }
    }
  }

  async sendCommand(serverId: string, command: string): Promise<void> {
    const entry = this.require(serverId);
    if (!entry.process || entry.state.status !== 'running') {
      throw new Error(`Server "${serverId}" laeuft nicht.`);
    }
    if (entry.process.stdin && !entry.process.stdin.destroyed) {
      entry.process.stdin.write(command + '\n');
      this.emit(serverId, `> ${command}`);
    }
  }

  /**
   * Liest Working Set und kumulierte Prozesszeit aus Windows.
   *
   * Get-Process liefert beide Werte ohne Zusaetze; der Aufruf dauert je nach
   * System ein paar Millisekunden und wird deshalb nur auf Anfrage gemacht.
   */
  private async readProcessSample(
    pid: number,
  ): Promise<{ workingSetBytes: number; totalSeconds: number } | null> {
    const script =
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
      `if ($p) { [pscustomobject]@{ ws = $p.WorkingSet64; cpu = $p.TotalProcessorTime.TotalSeconds } | ConvertTo-Json -Compress }`;
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 5000 },
      );
      const raw = stdout.trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { ws?: number; cpu?: number };
      return {
        workingSetBytes: Number(parsed.ws ?? 0),
        totalSeconds: Number(parsed.cpu ?? 0),
      };
    } catch {
      return null;
    }
  }
}
