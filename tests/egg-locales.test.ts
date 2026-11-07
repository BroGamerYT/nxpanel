import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanHints } from '../src/http/routes/servers.js';

describe('Egg Mehrsprachigkeit und Hints', () => {
  const eggDir = 'eggs';
  const files = readdirSync(eggDir).filter((f) => f.endsWith('.json'));

  it('alle Egg-Dateien sind valides JSON', () => {
    for (const file of files) {
      const content = readFileSync(join(eggDir, file), 'utf8');
      expect(() => JSON.parse(content)).not.toThrow();
    }
  });

  it('Variablen unterstützen name_locales und description_locales', () => {
    for (const file of files) {
      const content = JSON.parse(readFileSync(join(eggDir, file), 'utf8')) as {
        variables?: Array<{ name: string; name_locales?: Record<string, string>; description_locales?: Record<string, string> }>;
      };
      for (const v of content.variables ?? []) {
        if (v.name_locales) {
          expect(v.name_locales.de).toBeDefined();
          expect(v.name_locales.en).toBeDefined();
        }
      }
    }
  });

  it('cleanHints behält text_locales bei', () => {
    const raw = [
      {
        match: 'test pattern',
        flags: 'i',
        level: 'warn',
        text: 'Deutscher Hinweis',
        text_locales: { de: 'Deutscher Hinweis', en: 'English hint' },
      },
    ];
    const cleaned = cleanHints(raw);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.text_locales).toEqual({ de: 'Deutscher Hinweis', en: 'English hint' });
  });
});
