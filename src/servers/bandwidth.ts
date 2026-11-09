/**
 * Rate-Limiter fuer Datei-Downloads und -Uploads.
 *
 * Der Transform-Stream drosselt den Datenstrom auf maximal `maxKbps`
 * Kilobyte pro Sekunde. Ist `maxKbps` null oder 0, wird der Stream
 * unverändert durchgereicht (unbegrenzt).
 *
 * Funktionsweise: Ein einfacher Token-Bucket. Alle 100ms werden
 * `maxKbps / 10` KB an Token nachgeladen. Jedes Byte verbraucht ein
 * Token. Wenn keine Token verfuegbar sind, wartet der Stream, bis
 * neue nachgeladen wurden.
 */
import { Transform } from 'node:stream';

export class BandwidthLimiter extends Transform {
  private maxKbps: number | null;
  private tokens = 0;
  private lastRefill = Date.now();
  private waiting = false;
  private refillTimer: NodeJS.Timeout | null = null;

  constructor(maxKbps: number | null) {
    super();
    this.maxKbps = maxKbps;
  }

  private refill(): void {
    if (!this.maxKbps || this.maxKbps <= 0) return;
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    // Nachfüllrate: maxKbps KB pro Sekunde -> pro Millisekunde
    const add = (this.maxKbps * elapsed) / 1000;
    this.tokens = Math.min(this.maxKbps, this.tokens + add);
    this.lastRefill = now;
    if (this.waiting && this.tokens > 0) {
      this.waiting = false;
      this.resume();
    }
  }

  private startRefillTimer(): void {
    if (this.refillTimer) return;
    this.refillTimer = setInterval(() => this.refill(), 100);
    this.refillTimer.unref?.();
  }

  private stopRefillTimer(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
  }

  override _transform(chunk: Buffer, _enc: string, callback: (err?: Error | null, data?: Buffer) => void): void {
    // Kein Limit -> durchreichen
    if (!this.maxKbps || this.maxKbps <= 0) {
      this.push(chunk);
      callback();
      return;
    }

    this.startRefillTimer();
    this.refill();

    const needed = chunk.length / 1024; // KB
    if (this.tokens >= needed) {
      // Genug Token -> sofort senden
      this.tokens -= needed;
      this.push(chunk);
      callback();
    } else {
      // Nicht genug Token -> Chunk aufteilen und warten
      const canSend = Math.floor(this.tokens * 1024);
      if (canSend > 0) {
        this.push(chunk.subarray(0, canSend));
        this.tokens = 0;
      }
      this.waiting = true;
      // Warten bis naechste Refill-Runde neue Token bringt
      setTimeout(() => {
        this.refill();
        const remaining = chunk.subarray(canSend);
        if (remaining.length > 0) {
          this._transform(remaining, _enc, callback);
        } else {
          callback();
        }
      }, 100);
    }
  }

  override _flush(callback: (err?: Error | null) => void): void {
    this.stopRefillTimer();
    callback();
  }

  /** Erzeugt einen Pass-Through Stream, wenn kein Limit gesetzt ist. */
  static create(maxKbps: number | null): BandwidthLimiter {
    return new BandwidthLimiter(maxKbps);
  }
}

/**
 * Prueft, ob fuer den Server ein Download-Limit gesetzt ist und liefert
 * den entsprechenden Stream. Ohne Limit wird der Original-Stream zurueckgegeben.
 */
export function applyDownloadLimit(
  stream: NodeJS.ReadableStream,
  maxKbps: number | null,
): NodeJS.ReadableStream {
  if (!maxKbps || maxKbps <= 0) return stream;
  return stream.pipe(new BandwidthLimiter(maxKbps));
}

/**
 * Prueft, ob fuer den Server ein Upload-Limit gesetzt ist und liefert
 * den entsprechenden Stream. Ohne Limit wird der Original-Stream zurueckgegeben.
 */
export function applyUploadLimit(
  stream: NodeJS.ReadableStream,
  maxKbps: number | null,
): NodeJS.ReadableStream {
  if (!maxKbps || maxKbps <= 0) return stream;
  return stream.pipe(new BandwidthLimiter(maxKbps));
}