import { describe, it, expect } from 'vitest';
import { MemoryStore, RateLimiter, createRedisStore } from '../src/auth/ratelimit.js';

const limit = { max: 3, windowMs: 200 };

describe('Ratelimit im Arbeitsspeicher', () => {
  it('sperrt nach max Versuchen und gibt nach dem Fenster wieder frei', async () => {
    const rl = new RateLimiter(new MemoryStore());
    for (let i = 0; i < 3; i++) expect((await rl.consume('k', limit)).ok).toBe(true);
    expect((await rl.consume('k', limit)).ok).toBe(false);
    expect((await rl.isBlocked('k', limit)).blocked).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect((await rl.isBlocked('k', limit)).blocked).toBe(false);
    expect((await rl.consume('k', limit)).ok).toBe(true);
  });

  it('isBlocked zaehlt nicht mit, reset setzt zurueck', async () => {
    const rl = new RateLimiter(new MemoryStore());
    for (let i = 0; i < 10; i++) await rl.isBlocked('a', limit);
    expect((await rl.consume('a', limit)).remaining).toBe(2);
    await rl.consume('a', limit);
    await rl.consume('a', limit);
    expect((await rl.isBlocked('a', limit)).blocked).toBe(true);
    await rl.reset('a');
    expect((await rl.isBlocked('a', limit)).blocked).toBe(false);
  });
});

describe('Ratelimit mit Redis', () => {
  it('zaehlt in Redis (oder faellt sauber auf Arbeitsspeicher zurueck)', async () => {
    const rl = new RateLimiter(createRedisStore(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0'));
    const key = `test:${Date.now()}`;
    for (let i = 0; i < 3; i++) expect((await rl.consume(key, limit)).ok).toBe(true);
    expect((await rl.consume(key, limit)).ok).toBe(false);
    expect((await rl.isBlocked(key, limit)).blocked).toBe(true);
    await rl.reset(key);
    expect((await rl.isBlocked(key, limit)).blocked).toBe(false);
  });

  it('Redis nicht erreichbar: kein Absturz, Rueckfall auf Arbeitsspeicher', async () => {
    const rl = new RateLimiter(createRedisStore('redis://127.0.0.1:1/0'));
    for (let i = 0; i < 3; i++) expect((await rl.consume('x', limit)).ok).toBe(true);
    expect((await rl.consume('x', limit)).ok).toBe(false);
  });
});
