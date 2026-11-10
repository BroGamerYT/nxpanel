import { describe, it, expect } from 'vitest';
import { patchConfigFile } from '../src/eggs/config-files.js';

const ctx = {
  variables: { MOTD: 'Willkommen', MAX_PLAYERS: '20' },
  ramMb: 4096, ip: '0.0.0.0', port: 25566,
  ports: { rcon: 25576 }, serverDir: '/home/container', serverName: 'Test',
};

describe('server.properties', () => {
  const original = [
    '#Minecraft server properties',
    '#Mon Nov 05 2026',
    'server-port=25565',
    'motd=A Minecraft Server',
    'spawn-protection=16',
  ].join('\n');

  it('aendert nur die genannten Schluessel', () => {
    const r = patchConfigFile(original, {
      parser: 'properties',
      find: { 'server-port': '{{SERVER_PORT}}', motd: '{{MOTD}}' },
    }, ctx);

    expect(r.content).toContain('server-port=25566');
    expect(r.content).toContain('motd=Willkommen');
    expect(r.changed.sort()).toEqual(['motd', 'server-port']);
  });

  it('laesst Kommentare und unbeteiligte Zeilen unberuehrt', () => {
    // Ein Patcher, der die Datei neu schreibt, zerstoert die Anpassungen
    // des Nutzers - deshalb ist das die wichtigste Zusicherung hier.
    const r = patchConfigFile(original, {
      parser: 'properties', find: { 'server-port': '{{SERVER_PORT}}' },
    }, ctx);

    expect(r.content).toContain('#Minecraft server properties');
    expect(r.content).toContain('#Mon Nov 05 2026');
    expect(r.content).toContain('spawn-protection=16');
  });

  it('haengt fehlende Schluessel an', () => {
    const r = patchConfigFile(original, {
      parser: 'properties', find: { 'enable-rcon': 'true' },
    }, ctx);
    expect(r.added).toEqual(['enable-rcon']);
    expect(r.content).toContain('enable-rcon=true');
  });

  it('meldet nichts, wenn der Wert schon stimmt', () => {
    const r = patchConfigFile(original, {
      parser: 'properties', find: { 'spawn-protection': '16' },
    }, ctx);
    expect(r.changed).toHaveLength(0);
  });

  it('unterstuetzt auch "set" statt "find" ohne Fehler', () => {
    const r = patchConfigFile('server-port=25565', {
      parser: 'properties',
      set: { 'server-port': '{{SERVER_PORT}}' },
    } as any, ctx);
    expect(r.content).toContain('server-port=25566');
    expect(r.changed).toEqual(['server-port']);
  });
});

describe('INI mit Abschnitten', () => {
  const original = [
    '[ServerSettings]',
    'ServerName=Alter Name',
    'MaxPlayers=10',
    '',
    '[SessionSettings]',
    'Port=7777',
  ].join('\n');

  it('adressiert Schluessel ueber den Abschnitt', () => {
    const r = patchConfigFile(original, {
      parser: 'ini',
      find: { 'ServerSettings.MaxPlayers': '{{MAX_PLAYERS}}', 'SessionSettings.Port': '{{SERVER_PORT}}' },
    }, ctx);

    expect(r.content).toContain('MaxPlayers=20');
    expect(r.content).toContain('Port=25566');
    expect(r.content).toContain('ServerName=Alter Name');
  });

  it('verwechselt gleichnamige Schluessel in anderen Abschnitten nicht', () => {
    const doppelt = '[A]\nPort=1\n\n[B]\nPort=2';
    const r = patchConfigFile(doppelt, { parser: 'ini', find: { 'B.Port': '9999' } }, ctx);
    expect(r.content).toBe('[A]\nPort=1\n\n[B]\nPort=9999');
  });

  it('unterstuetzt eckige Klammern fuer Abschnitte wie bei Unreal Engine', () => {
    const ini = [
      '[/Script/Astro.AstroServerSettings]',
      'PublicIP=0.0.0.0',
      'OwnerName=AlterName',
    ].join('\n');
    const r = patchConfigFile(ini, {
      parser: 'ini',
      find: {
        '[/Script/Astro.AstroServerSettings].PublicIP': '127.0.0.1',
        '[/Script/Astro.AstroServerSettings].OwnerName': 'Test',
      },
    }, ctx);
    expect(r.content).toContain('PublicIP=127.0.0.1');
    expect(r.content).toContain('OwnerName=Test');
    expect(r.changed.sort()).toEqual(['[/Script/Astro.AstroServerSettings].OwnerName', '[/Script/Astro.AstroServerSettings].PublicIP']);
  });

  it('haengt neue Schluessel an existierende und neue Abschnitte an', () => {
    const ini = [
      '[ServerSettings]',
      'ServerName=Test',
    ].join('\n');
    const r = patchConfigFile(ini, {
      parser: 'ini',
      find: {
        'ServerSettings.MaxPlayers': '{{MAX_PLAYERS}}',
        '[NewSection].NewKey': 'NewVal',
      },
    }, ctx);
    expect(r.content).toContain('[ServerSettings]\nServerName=Test\nMaxPlayers=20');
    expect(r.content).toContain('[NewSection]\nNewKey=NewVal');
    expect(r.added.sort()).toEqual(['ServerSettings.MaxPlayers', '[NewSection].NewKey']);
  });

  it('erstellt vollstaendige INI-Struktur bei leerer Ausgangsdatei', () => {
    const r = patchConfigFile('', {
      parser: 'ini',
      find: {
        '[/Script/Astro.AstroServerSettings].PublicIP': '127.0.0.1',
        '[/Script/Astro.AstroServerSettings].ServerName': '{{MOTD}}',
      },
    }, ctx);
    expect(r.content).toBe('[/Script/Astro.AstroServerSettings]\nPublicIP=127.0.0.1\nServerName=Willkommen');
    expect(r.added.length).toBe(2);
  });
});

describe('YAML', () => {
  const original = [
    '# Paper-Konfiguration',
    'settings:',
    '  bungeecord: false',
    '  max-players: 20',
    'messages:',
    '  kick: Tschuess',
  ].join('\n');

  it('erreicht verschachtelte Schluessel ueber den Pfad', () => {
    const r = patchConfigFile(original, {
      parser: 'yaml', find: { 'settings.bungeecord': 'true' },
    }, ctx);
    expect(r.content).toContain('  bungeecord: true');
    expect(r.content).toContain('  max-players: 20');
    expect(r.content).toContain('# Paper-Konfiguration');
  });

  it('meldet Pfade, die es nicht gibt, statt sie anzulegen', () => {
    const r = patchConfigFile(original, {
      parser: 'yaml', find: { 'gibt.es.nicht': 'x' },
    }, ctx);
    expect(r.skipped).toEqual(['gibt.es.nicht']);
  });
});

describe('XML', () => {
  const original = '<?xml version="1.0"?>\n<gameserver>\n  <game_port>7777</game_port>\n  <webserver port="8080" />\n</gameserver>';

  it('ersetzt den Inhalt eines Elements', () => {
    const r = patchConfigFile(original, {
      parser: 'xml', find: { game_port: '{{SERVER_PORT}}' },
    }, ctx);
    expect(r.content).toContain('<game_port>25566</game_port>');
  });

  it('ersetzt auch Attributwerte', () => {
    const r = patchConfigFile(original, {
      parser: 'xml', find: { 'webserver.port': '9090' },
    }, ctx);
    expect(r.content).toContain('port="9090"');
  });
});

describe('JSON', () => {
  it('setzt verschachtelte Werte und erkennt Zahlen', () => {
    const r = patchConfigFile('{\n  "server": { "port": 1234, "name": "alt" }\n}', {
      parser: 'json', find: { 'server.port': '{{SERVER_PORT}}', 'server.name': '{{SERVER_NAME}}' },
    }, ctx);
    const parsed = JSON.parse(r.content) as { server: { port: number; name: string } };
    expect(parsed.server.port).toBe(25566);
    expect(parsed.server.name).toBe('Test');
  });

  it('laesst kaputtes JSON unangetastet', () => {
    const r = patchConfigFile('{ kaputt', { parser: 'json', find: { a: 'b' } }, ctx);
    expect(r.content).toBe('{ kaputt');
    expect(r.skipped).toEqual(['a']);
  });
});
