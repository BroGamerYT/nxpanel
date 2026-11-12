import { PassThrough, Writable } from 'node:stream';
import type { ContainerLike, DockerLike, DockerStats } from '../../src/drivers/docker-driver.js';

// ------------------------------------------------------------ Docker-Attrappe

export class FakeContainer implements ContainerLike {
  readonly id: string;
  running = true;
  readonly stdinWrites: string[] = [];
  readonly calls: string[] = [];
  readonly logStream = new PassThrough();
  private resolveWait!: (v: { StatusCode: number }) => void;
  private readonly waitPromise = new Promise<{ StatusCode: number }>((r) => (this.resolveWait = r));
  /** Wie reagiert der "Server" auf den Stop-Befehl? */
  exitOnStdin: string | null = null;

  constructor(readonly name: string, readonly options: Record<string, unknown>, private readonly onRemove: () => void) {
    this.id = `id-${name}`;
  }
  onStart: (() => void) | null = null;
  async start() {
    this.calls.push('start');
    this.onStart?.();
  }
  async stop(o?: { t?: number }) {
    this.calls.push(`stop:${o?.t}`);
    this.exit(143);
  }
  async kill(o?: { signal?: string }) {
    this.calls.push(`kill:${o?.signal}`);
    if (o?.signal === 'SIGKILL' || o?.signal === 'SIGTERM' || o?.signal === 'SIGINT') this.exit(137);
  }
  async remove() {
    this.calls.push('remove');
    this.onRemove();
  }
  async inspect() {
    return { State: { Running: this.running, Pid: 4242, StartedAt: '2026-11-12T10:00:00Z', ExitCode: 0 } };
  }
  wait() {
    return this.waitPromise;
  }
  async attach() {
    const self = this;
    return new Writable({
      write(chunk: Buffer, _e, cb) {
        const text = chunk.toString();
        self.stdinWrites.push(text);
        if (self.exitOnStdin && text.trim() === self.exitOnStdin) self.exit(0);
        cb();
      },
    }) as unknown as NodeJS.ReadWriteStream;
  }
  logs(_o: object, cb: (err: Error | null, s?: NodeJS.ReadableStream) => void) {
    cb(null, this.logStream);
  }
  async stats(): Promise<DockerStats> {
    return {
      cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 600 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
    };
  }
  async update(o: object) {
    this.calls.push(`update:${JSON.stringify(o)}`);
  }
  exit(code: number) {
    this.running = false;
    this.logStream.end();
    this.resolveWait({ StatusCode: code });
  }
}

export class FakeDocker implements DockerLike {
  containers = new Map<string, FakeContainer>();
  images = new Set<string>();
  networks = new Set<string>();
  pulled: string[] = [];
  pingFails = false;
  /** Alle Optionen, mit denen Container angelegt wurden (auch die schon entfernten Installer). */
  created: Array<Record<string, any>> = [];
  /** Ausgabe und Beendigungscode des Installationsskripts. */
  installer = { lines: ['[installer] lade Dateien', '[installer] fertig'], code: 0 };
  readonly modem = {
    followProgress: (stream: NodeJS.ReadableStream, done: (e: Error | null) => void, onProgress?: (ev: { status?: string; id?: string }) => void) => {
      onProgress?.({ id: 'abc123', status: 'Downloading' });
      stream.on('end', () => done(null));
      (stream as PassThrough).resume();
    },
    demuxStream: (stream: NodeJS.ReadableStream, out: NodeJS.WritableStream) => {
      stream.pipe(out);
    },
  };
  async ping() {
    if (this.pingFails) throw new Error('connect ENOENT /var/run/docker.sock');
  }
  async listNetworks() {
    return [...this.networks].map((Name) => ({ Name }));
  }
  async createNetwork(o: { Name: string }) {
    this.networks.add(o.Name);
  }
  getImage(name: string) {
    return { inspect: async () => (this.images.has(name) ? {} : Promise.reject(new Error('no such image'))) };
  }
  pull(image: string, cb: (e: Error | null, s?: NodeJS.ReadableStream) => void) {
    this.pulled.push(image);
    const s = new PassThrough();
    cb(null, s);
    setImmediate(() => {
      this.images.add(image);
      s.end();
    });
  }
  async createContainer(o: Record<string, unknown>) {
    const name = o.name as string;
    const c = new FakeContainer(name, o, () => this.containers.delete(name));
    this.created.push(o);
    if ((o.Labels as Record<string, string> | undefined)?.['nexuscore.installer']) {
      c.onStart = () =>
        setImmediate(() => {
          for (const l of this.installer.lines) c.logStream.write(`${l}
`);
          c.exit(this.installer.code);
        });
    }
    this.containers.set(name, c);
    return c;
  }
  getContainer(id: string) {
    return this.containers.get(id) ?? [...this.containers.values()].find((c) => c.id === id) ?? new FakeContainer(id, {}, () => {});
  }
  async listContainers() {
    return [...this.containers.values()].filter((c) => c.running).map((c) => ({ Id: c.id, Names: [`/${c.name}`], State: 'running', Labels: (c.options.Labels ?? {}) as Record<string, string> }));
  }
}

