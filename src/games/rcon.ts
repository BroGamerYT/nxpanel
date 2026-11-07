import { Socket } from 'node:net';

/**
 * Source-RCON (Minecraft, ARK, Valve-Spiele). Ein Paket:
 *   int32 Laenge | int32 Id | int32 Typ | Text | 0x00 0x00   (Little Endian)
 * Typ 3 = Anmeldung, 2 = Befehl, Antworten kommen als Typ 0 (bzw. 2 nach der Anmeldung).
 * Eine Verbindung wird offen gehalten und wiederverwendet: jede neue Verbindung
 * schreibt bei Minecraft eine Zeile ins Log ("RCON Client started").
 */
export class RconError extends Error {}

export class Rcon {
  private sock: Socket | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private waiting = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: string, private readonly port: number, private readonly password: string, private readonly timeoutMs = 5000) {}

  get connected() { return !!this.sock && !this.sock.destroyed; }

  private packet(id: number, type: number, body: string) {
    const b = Buffer.from(body, 'utf8');
    const p = Buffer.alloc(14 + b.length);
    p.writeInt32LE(10 + b.length, 0);
    p.writeInt32LE(id, 4);
    p.writeInt32LE(type, 8);
    b.copy(p, 12);
    return p;
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < len + 4) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.toString('utf8', 12, 4 + len - 2);
      this.buf = this.buf.subarray(len + 4);
      if (id === -1) {
        // Anmeldung abgelehnt: alle Wartenden scheitern.
        for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new RconError('RCON-Passwort falsch')); }
        this.waiting.clear();
        this.close();
        return;
      }
      // Nach der Anmeldung schickt Valve-RCON erst ein leeres Typ-0-Paket - das ignorieren.
      if (type === 0 && body === '' && this.waiting.get(id)?.timer && this.authId === id) continue;
      const w = this.waiting.get(id);
      if (w) { clearTimeout(w.timer); this.waiting.delete(id); w.resolve(body); }
    }
  }

  private authId = 0;

  private request(type: number, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new RconError('Nicht verbunden'));
      const id = this.nextId++;
      if (type === 3) this.authId = id;
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new RconError('RCON antwortet nicht')); }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.sock.write(this.packet(id, type, body));
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const s = new Socket();
      const timer = setTimeout(() => { s.destroy(); reject(new RconError('RCON nicht erreichbar')); }, this.timeoutMs);
      s.once('error', (e) => { clearTimeout(timer); reject(new RconError(`RCON nicht erreichbar: ${e.message}`)); });
      s.connect(this.port, this.host, () => { clearTimeout(timer); resolve(); });
      this.sock = s;
    });
    const s = this.sock!;
    s.removeAllListeners('error');
    s.on('data', (c: Buffer) => this.onData(c));
    s.on('error', () => this.close());
    s.on('close', () => { this.sock = null; for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new RconError('Verbindung getrennt')); } this.waiting.clear(); });
    await this.request(3, this.password);
  }

  /** Befehle nacheinander - RCON-Server vertragen keine parallelen Anfragen gut. */
  command(cmd: string): Promise<string> {
    const run = async () => { await this.connect(); return this.request(2, cmd); };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  close() { this.sock?.destroy(); this.sock = null; }
}
