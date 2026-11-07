import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillGeneratedValues, GENERATE_PASSWORD, isGeneratedDefault } from '../src/eggs/variables.js';
import { warnIfLowDisk } from '../src/servers/install.js';

const dir = join(process.cwd(), 'eggs');
const eggs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({
  file: f,
  egg: JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
    name: string;
    variables?: { env_variable: string; default_value?: string | null; rules?: string | string[] | null }[];
    hints?: { match: string; flags?: string }[];
  },
}));

describe('Mitgelieferte Eggs', () => {
  it.each(eggs)('$file: keine doppelten Variablen', ({ egg }) => {
    const names = (egg.variables ?? []).map((v) => v.env_variable);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  // Felder, die der Nutzer selbst eintragen muss (Konten, Lizenzen, Tokens).
  // Ports bekommen ihre Vorgabe erst beim Import ({{X_PORT}}).
  const USER_INPUT = new Set(['STEAM_USER', 'STEAM_PASS', 'SLG_USER', 'SLG_PW', 'PUBLIC_IP', 'OWNER_NAME', 'OWNER_GUID',
    'SERVER_TOKEN', 'FS_LICENSE_KEY', 'STEAM_ACC', 'GSLT']);
  it.each(eggs)('$file: Pflichtfelder haben eine Vorgabe (sonst scheitert das Anlegen)', ({ egg }) => {
    const broken = (egg.variables ?? []).filter((v) => {
      const rules = Array.isArray(v.rules) ? v.rules.join('|') : (v.rules ?? '');
      if (!/(^|\|)required(\||$)/.test(rules)) return false;
      if (USER_INPUT.has(v.env_variable) || /_PORT$/.test(v.env_variable)) return false;
      return !(v.default_value ?? '').toString().trim();
    });
    expect(broken.map((v) => v.env_variable)).toEqual([]);
  });

  it.each(eggs)('$file: Hinweis-Muster sind gueltige Regex', ({ egg }) => {
    for (const h of egg.hints ?? []) expect(() => new RegExp(h.match, h.flags ?? '')).not.toThrow();
  });
});

describe('Erzeugte Passwoerter', () => {
  const defs = [
    { env_variable: 'ADMINPASSWORD', default_value: GENERATE_PASSWORD },
    { env_variable: 'NAME', default_value: 'x' },
  ];
  it('fuellt leere und als Platzhalter gesendete Felder', () => {
    let n = 0;
    const r = fillGeneratedValues(defs, { ADMINPASSWORD: '' }, () => `pw${++n}`);
    expect(r.values.ADMINPASSWORD).toBe('pw1');
    expect(r.generated).toEqual(['ADMINPASSWORD']);
    expect(fillGeneratedValues(defs, { ADMINPASSWORD: GENERATE_PASSWORD }, () => 'z').values.ADMINPASSWORD).toBe('z');
  });
  it('laesst eigene Werte stehen', () => {
    const r = fillGeneratedValues(defs, { ADMINPASSWORD: 'meins123' }, () => 'z');
    expect(r.values.ADMINPASSWORD).toBe('meins123');
    expect(r.generated).toEqual([]);
  });
  it('erkennt den Platzhalter', () => {
    expect(isGeneratedDefault(' {{GENERATE_PASSWORD}} ')).toBe(true);
    expect(isGeneratedDefault('geheim')).toBe(false);
  });
});

describe('Speicherplatz-Warnung', () => {
  it('warnt nur, wenn weniger frei ist als zugeteilt', async () => {
    const lines: string[] = [];
    const free = await warnIfLowDisk(1, (l) => lines.push(l), process.cwd());
    expect(free).toBeGreaterThan(1);
    expect(lines).toEqual([]);
    await warnIfLowDisk(1024 * 1024 * 1024, (l) => lines.push(l), process.cwd());
    expect(lines[0]).toMatch(/WARNUNG/);
  });
});
