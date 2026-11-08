import { describe, it, expect } from 'vitest';
import { formatUptime, formatUptimeCompact } from '../web/src/lib/status.js';

describe('Instanz-Laufzeit (Uptime)', () => {
  it('gibt null fuer ungueltige oder leere Werte zurueck', () => {
    expect(formatUptime(null)).toBeNull();
    expect(formatUptime(undefined)).toBeNull();
    expect(formatUptime('')).toBeNull();
    expect(formatUptime('ungueltig')).toBeNull();
  });

  it('formatiert Sekunden, Minuten, Stunden und Tage lesbar', () => {
    const now = 1700000000000;
    // 45 Sekunden
    expect(formatUptime(new Date(now - 45_000).toISOString(), now)).toBe('45 Sek');
    // 12 Minuten
    expect(formatUptime(new Date(now - 12 * 60_000).toISOString(), now)).toBe('12 Min');
    // 4 Stunden 15 Minuten
    expect(formatUptime(new Date(now - (4 * 3600_000 + 15 * 60_000)).toISOString(), now)).toBe('4 Std 15 Min');
    // 2 Tage 5 Stunden
    expect(formatUptime(new Date(now - (2 * 86400_000 + 5 * 3600_000)).toISOString(), now)).toBe('2 T 5 Std');
  });

  it('formatiert kompakte Laufzeit korrekt', () => {
    const now = 1700000000000;
    expect(formatUptimeCompact(new Date(now - 45_000).toISOString(), now)).toBe('45s');
    expect(formatUptimeCompact(new Date(now - 12 * 60_000).toISOString(), now)).toBe('12m');
    expect(formatUptimeCompact(new Date(now - (4 * 3600_000 + 15 * 60_000)).toISOString(), now)).toBe('4h 15m');
    expect(formatUptimeCompact(new Date(now - (2 * 86400_000 + 5 * 3600_000)).toISOString(), now)).toBe('2d 5h');
  });
});
