import { describe, expect, it } from 'vitest';

describe('Konfiguration', () => {
  it('verwendet sichere Standardwerte', async () => {
    const mod = await import('../src/config/index.js');
    expect(mod.config.host).toBe('127.0.0.1');
    expect(mod.config.port).toBe(8443);
    expect(mod.config.mode).toBe('test');
  });

  it('legt das Datenverzeichnis im Projekt ab', async () => {
    const mod = await import('../src/config/index.js');
    expect(mod.config.dataDir.replace(/\\/g, '/')).toContain('/nexuscore/data');
  });
});
