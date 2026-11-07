import { Redis } from 'ioredis';
import { log } from '../log.js';

/**
 * Feste Zeitfenster pro Schluessel ("login:ip:1.2.3.4", "power:<user>:<server>").
 * Zwei Speicher:
 *   - Redis: ueberlebt Neustarts und gilt fuer alle Panel-Prozesse.
 *   - Arbeitsspeicher: fuer Tests und als Rueckfall, falls Redis weg ist.
 *     Ein Ratelimit, das bei Redis-Ausfall den Login blockiert, waere
 *     schlimmer als eines, das kurzzeitig nur pro Prozess zaehlt.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
  /** Aktueller Stand ohne zu zaehlen. */
  get(key: string): Promise<{ count: number; resetMs: number }>;
  reset(key: string): Promise<void>;
}

export class MemoryStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; until: number }>();

  async hit(key: string, windowMs: number) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.until <= now) {
      b = { count: 0, until: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    if (this.buckets.size > 50_000) this.sweep(now);
    return { count: b.count, resetMs: b.until - now };
  }

  async get(key: string) {
    const b = this.buckets.get(key);
    const now = Date.now();
    if (!b || b.until <= now) return { count: 0, resetMs: 0 };
    return { count: b.count, resetMs: b.until - now };
  }

  async reset(key: string) {
    this.buckets.delete(key);
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (b.until <= now) this.buckets.delete(k);
  }
}

export class RedisStore implements RateLimitStore {
  private fallback = new MemoryStore();
  private warned = false;

  constructor(private redis: Redis) {}

  async hit(key: string, windowMs: number) {
    try {
      const k = `nxp:rl:${key}`;
      const res = await this.redis.multi().incr(k).pttl(k).exec();
      const count = Number(res?.[0]?.[1] ?? 1);
      let ttl = Number(res?.[1]?.[1] ?? -1);
      if (ttl < 0) {
        await this.redis.pexpire(k, windowMs);
        ttl = windowMs;
      }
      this.warned = false;
      return { count, resetMs: ttl };
    } catch (err) {
      if (!this.warned) log.warn({ err }, 'Redis fuer Ratelimit nicht erreichbar - zaehle im Arbeitsspeicher');
      this.warned = true;
      return this.fallback.hit(key, windowMs);
    }
  }

  async get(key: string) {
    try {
      const k = `nxp:rl:${key}`;
      const res = await this.redis.multi().get(k).pttl(k).exec();
      const count = Number(res?.[0]?.[1] ?? 0) || 0;
      const ttl = Number(res?.[1]?.[1] ?? 0);
      return { count, resetMs: ttl > 0 ? ttl : 0 };
    } catch {
      return this.fallback.get(key);
    }
  }

  async reset(key: string) {
    try {
      await this.redis.del(`nxp:rl:${key}`);
    } catch {
      /* egal */
    }
    await this.fallback.reset(key);
  }
}

export interface Limit {
  max: number;
  windowMs: number;
}

/** Die Grenzen an einer Stelle - so sind sie spaeter leicht einstellbar. */
export const LIMITS = {
  /** Fehlversuche pro Konto: 5 in 15 Minuten. */
  loginAccount: { max: 5, windowMs: 15 * 60_000 },
  /** Fehlversuche pro IP (viele Konten durchprobieren): 20 in 15 Minuten. */
  loginIp: { max: 20, windowMs: 15 * 60_000 },
  refresh: { max: 60, windowMs: 60_000 },
  /** Power-Aktionen pro Nutzer und Server. */
  power: { max: 10, windowMs: 60_000 },
} satisfies Record<string, Limit>;

export class RateLimiter {
  constructor(private store: RateLimitStore) {}

  /** Zaehlt einen Versuch. ok=false, wenn die Grenze ueberschritten ist. */
  async consume(key: string, limit: Limit) {
    const { count, resetMs } = await this.store.hit(key, limit.windowMs);
    return { ok: count <= limit.max, remaining: Math.max(0, limit.max - count), retryAfterS: Math.ceil(resetMs / 1000) };
  }

  /** Ist die Grenze schon erreicht? Zaehlt nicht mit (fuer "nur Fehlversuche zaehlen"). */
  async isBlocked(key: string, limit: Limit) {
    const { count, resetMs } = await this.store.get(key);
    return { blocked: count >= limit.max, retryAfterS: Math.ceil(resetMs / 1000) };
  }

  async reset(key: string) {
    await this.store.reset(key);
  }
}

export function createRedisStore(url: string): RedisStore {
  const redis = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (n) => Math.min(n * 500, 5_000),
  });
  redis.on('error', () => {
    /* wird im Store behandelt */
  });
  return new RedisStore(redis);
}
