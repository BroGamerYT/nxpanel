import { describe, it, expect } from 'vitest';
import { substitute, missingPlaceholders, validateVariables } from '../src/eggs/variables.js';

const ctx = {
  variables: { SERVER_JARFILE: 'paper.jar', MAX_PLAYERS: '20' },
  ramMb: 4096,
  ip: '0.0.0.0',
  port: 25566,
  ports: { rcon: 25576 },
  serverDir: '/home/container',
  serverName: 'Testserver',
};

describe('Platzhalter ersetzen', () => {
  it('ersetzt einfache Platzhalter', () => {
    expect(substitute('java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}', ctx))
      .toBe('java -Xmx4096M -jar paper.jar');
  });

  it('versteht die Pterodactyl-Schreibweise', () => {
    expect(substitute('{{server.build.env.MAX_PLAYERS}}', ctx)).toBe('20');
    expect(substitute('{{server.build.default.port}}', ctx)).toBe('25566');
    expect(substitute('{{server.build.memory}}', ctx)).toBe('4096');
  });

  it('kennt Nebenports ueber ihre Bezeichnung', () => {
    expect(substitute('rcon.port={{RCON_PORT}}', ctx)).toBe('rcon.port=25576');
  });

  it('leert unbekannte Platzhalter, statt sie stehen zu lassen', () => {
    // Ein uebrig gebliebenes {{FOO}} im Startkommando faellt erst im
    // Spiel-Log auf - dann aber sehr unangenehm.
    expect(substitute('start {{GIBTS_NICHT}} ende', ctx)).toBe('start  ende');
  });

  it('vertraegt Leerzeichen in der Klammer', () => {
    expect(substitute('{{ SERVER_NAME }}', ctx)).toBe('Testserver');
  });

  it('findet Platzhalter ohne passende Variable', () => {
    const known = new Set(['SERVER_MEMORY']);
    expect(missingPlaceholders('{{SERVER_MEMORY}} {{FEHLT}}', known)).toEqual(['FEHLT']);
  });
});

describe('Variablen pruefen', () => {
  const defs = [
    { env_variable: 'MAX_PLAYERS', default_value: '20', rules: 'required|numeric|between:1,100', user_editable: true },
    { env_variable: 'GAMEMODE', default_value: 'survival', rules: 'required|in:survival,creative', user_editable: true },
    { env_variable: 'INTERN', default_value: 'fest', rules: 'required|string', user_editable: false },
  ];

  it('nimmt die Vorgabe, wenn nichts gesetzt ist', () => {
    const r = validateVariables(defs, {});
    expect(r.errors).toHaveLength(0);
    expect(r.values.MAX_PLAYERS).toBe('20');
  });

  it('meldet ungueltige Werte, statt sie durchzulassen', () => {
    const r = validateVariables(defs, { MAX_PLAYERS: '500' });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.variable).toBe('MAX_PLAYERS');
  });

  it('ignoriert Eingaben zu nicht editierbaren Variablen', () => {
    // Sonst koennte ein Nutzer ueber die API Werte setzen, die das Formular
    // gar nicht anbietet - etwa solche, die ins Startkommando wandern.
    const r = validateVariables(defs, { INTERN: 'manipuliert' });
    expect(r.values.INTERN).toBe('fest');
  });

  it('weist unbekannte Auswahlwerte ab', () => {
    const r = validateVariables(defs, { GAMEMODE: 'hardcore' });
    expect(r.errors.map((e) => e.variable)).toContain('GAMEMODE');
  });
});
