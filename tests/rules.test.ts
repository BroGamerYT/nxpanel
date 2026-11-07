import { describe, it, expect } from 'vitest';
import { parseRules } from '../src/eggs/rules.js';

describe('Egg-Regeln in Bedienelemente uebersetzen', () => {
  it('macht aus in: ein Dropdown', () => {
    const r = parseRules('required|in:survival,creative,adventure', 'GAMEMODE');
    expect(r.widget).toBe('select');
    expect(r.options).toEqual(['survival', 'creative', 'adventure']);
    expect(r.required).toBe(true);
  });

  it('macht aus boolean einen Schalter', () => {
    expect(parseRules('required|boolean', 'PVP').widget).toBe('toggle');
  });

  it('macht aus between einen Schieberegler', () => {
    const r = parseRules('required|numeric|between:1,100', 'MAX_PLAYERS');
    expect(r.widget).toBe('slider');
    expect(r.min).toBe(1);
    expect(r.max).toBe(100);
  });

  it('erkennt Geheimnisse am Namen', () => {
    expect(parseRules('required|string', 'RCON_PASSWORD').widget).toBe('password');
    expect(parseRules('nullable|string', 'STEAM_PASS').widget).toBe('password');
    expect(parseRules('required|string', 'FS_LICENSE_KEY').widget).toBe('password');
  });

  it('bleibt bei Text, wenn nichts bekannt ist', () => {
    expect(parseRules(null, 'SERVER_NAME').widget).toBe('text');
  });

  it('prueft Werte gegen die Regel', () => {
    const r = parseRules('required|numeric|between:1,100', 'MAX_PLAYERS');
    expect(r.schema.safeParse('50').success).toBe(true);
    expect(r.schema.safeParse('500').success).toBe(false);
    expect(r.schema.safeParse('abc').success).toBe(false);
  });

  it('versteht Laravel-Regex mit Schraegstrichen', () => {
    const r = parseRules('required|regex:/^([\\w\\d._-]+)(\\.jar)$/', 'SERVER_JARFILE');
    expect(r.schema.safeParse('server.jar').success).toBe(true);
    expect(r.schema.safeParse('server.exe').success).toBe(false);
  });

  it('laesst optionale Felder leer durch', () => {
    const r = parseRules('nullable|string', 'MOTD');
    expect(r.required).toBe(false);
    expect(r.schema.safeParse(undefined).success).toBe(true);
  });
});
