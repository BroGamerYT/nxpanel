import { describe, it, expect } from 'vitest';
import { rconPasswordMissing } from '../src/servers/create.js';

describe('RCON-Passwort', () => {
  it('fehlt bei leerem oder fehlendem Wert', () => {
    expect(rconPasswordMissing('RCON_PASSWORD', { RCON_PASSWORD: '' })).toBe(true);
    expect(rconPasswordMissing('RCON_PASSWORD', { RCON_PASSWORD: '   ' })).toBe(true);
    expect(rconPasswordMissing('RCON_PASSWORD', {})).toBe(true);
  });
  it('bleibt, wenn gesetzt oder das Spiel kein RCON abfragt', () => {
    expect(rconPasswordMissing('RCON_PASSWORD', { RCON_PASSWORD: 'geheim123' })).toBe(false);
    expect(rconPasswordMissing(null, {})).toBe(false);
  });
});
