import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { internalRefs } from '../src/servers/allocations.js';

describe('Interne Ports', () => {
  it('nur als intern markierte Nebenports bleiben drinnen', () => {
    expect([...internalRefs({ primary: { ref: 'game', protocol: 'tcp' }, secondary: [
      { ref: 'rcon', protocol: 'tcp', internal: true }, { ref: 'query', protocol: 'udp' },
    ] })]).toEqual(['rcon']);
    expect(internalRefs(null).size).toBe(0);
  });
  it('RCON von Minecraft, ARK und Palworld geht nicht ins Internet', () => {
    for (const f of ['minecraft-paper', 'ark-survival-ascended', 'palworld']) {
      const egg = JSON.parse(readFileSync(`eggs/${f}.json`, 'utf8'));
      expect(internalRefs(egg.ports).has('rcon'), f).toBe(true);
    }
  });
});
