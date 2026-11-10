import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/protocol/events.js';

describe('EventBus', () => {
  it('liefert Konsolenzeilen je Server aus dem Ringpuffer', () => {
    const bus = new EventBus();
    bus.emit({
      type: 'console',
      serverId: 'a',
      line: 'hallo',
      stream: 'stdout',
      ts: '2026-01-01T00:00:00.000Z',
    });
    bus.emit({
      type: 'console',
      serverId: 'b',
      line: 'weg',
      stream: 'stdout',
      ts: '2026-01-01T00:00:01.000Z',
    });
    expect(bus.logsFor('a').map((l) => l.line)).toEqual(['hallo']);
    expect(bus.logsFor('b')).toHaveLength(1);
  });

  it('liefert an Abonnenten und trennt sich beim Abmelden', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.on((e) => {
      if (e.type === 'console') seen.push(e.line);
    });
    bus.emit({ type: 'console', serverId: 'a', line: 'x', stream: 'stdout', ts: 't' });
    off();
    bus.emit({ type: 'console', serverId: 'a', line: 'y', stream: 'stdout', ts: 't' });
    expect(seen).toEqual(['x']);
  });

  it('begrenzt den Ringpuffer je Server', () => {
    const bus = new EventBus();
    for (let i = 0; i < 600; i += 1) {
      bus.emit({
        type: 'console',
        serverId: 'a',
        line: `Zeile ${i}`,
        stream: 'stdout',
        ts: 't',
      });
    }
    const lines = bus.logsFor('a');
    expect(lines).toHaveLength(500);
    expect(lines[lines.length - 1]?.line).toBe('Zeile 599');
  });
});
