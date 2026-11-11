import { describe, expect, it } from 'vitest';

const { patchIniFile, patchXmlFile, patchYamlFile } = await import('../src/install/config-formats.js');
const { renderConfig } = await import('../src/install/steam-game.js');

describe('INI', () => {
  const file = ['; Kommentar', 'Top=1', '', '[SERVER]', 'NAME=Alt', 'password = geheim', '', '[CAR_0]', 'MODEL=x', ''].join('\n');

  it('ersetzt Werte im Abschnitt, lässt Kommentare, Reste und andere Abschnitte', () => {
    const out = patchIniFile(file, 'SERVER', { name: 'Neu', PASSWORD: 'x' });
    expect(out).toBe(['; Kommentar', 'Top=1', '', '[SERVER]', 'NAME=Neu', 'password=x', '', '[CAR_0]', 'MODEL=x', ''].join('\n'));
  });

  it('fügt fehlende Schlüssel am Ende des Abschnitts ein (vor den Leerzeilen)', () => {
    const out = patchIniFile(file, 'SERVER', { HTTP_PORT: 8081 });
    expect(out).toContain('password = geheim\nHTTP_PORT=8081\n\n[CAR_0]');
  });

  it('legt einen fehlenden Abschnitt an und eine fehlende Datei', () => {
    expect(patchIniFile(file, 'NEU', { A: 'b' })).toMatch(/MODEL=x\n\n\[NEU\]\nA=b\n$/);
    expect(patchIniFile(null, 'URL', { Port: 8777 })).toBe('[URL]\nPort=8777\n');
  });

  it('ohne Abschnitt gilt der Teil vor dem ersten Abschnitt', () => {
    const out = patchIniFile(file, undefined, { Top: 2, Neu: 'ja' });
    expect(out.split('\n').slice(0, 5)).toEqual(['; Kommentar', 'Top=2', 'Neu=ja', '', '[SERVER]']);
  });

  it('behält Windows-Zeilenenden', () => {
    const out = patchIniFile('[A]\r\nx=1\r\n', 'A', { x: 2 });
    expect(out).toBe('[A]\r\nx=2\r\n');
  });

  it('schleust über einen Wert keine neue Zeile oder Einstellung ein', () => {
    const out = patchIniFile('[S]\nname=a\n', 'S', { name: 'Server\nADMIN=1\r\n[X]' });
    expect(out.split('\n').filter((l) => l.startsWith('ADMIN'))).toEqual([]);
    expect(out.split('\n')).toHaveLength(3);
    // und nicht über den Schlüssel
    const key = patchIniFile('[S]\n', 'S', { 'a\nb=c': 'x' });
    expect(key).toBe('[S]\nab c=x\n'.replace('ab c', 'abc'));
  });

  it('ein auskommentierter Schlüssel zählt nicht', () => {
    expect(patchIniFile('[S]\n;name=alt\n', 'S', { name: 'neu' })).toBe('[S]\n;name=alt\nname=neu\n');
  });
});

describe('XML', () => {
  it('setzt Attribute des Wurzelelements, ersetzt vorhandene und fügt neue hinzu', () => {
    const src = '<?xml version="1.0"?>\n<serversettings name="Alt" port="1" />\n';
    const out = patchXmlFile(src, 'serversettings', { '@name': 'Neu', '@port': 27015, '@maxplayers': 16 });
    expect(out).toContain('name="Neu"');
    expect(out).toContain('port="27015"');
    expect(out).toContain('maxplayers="16"');
    expect(out.startsWith('<?xml version="1.0"?>')).toBe(true);
    expect(out.match(/name=/g)).toHaveLength(1);
  });

  it('legt die Datei an, wenn es sie nicht gibt', () => {
    const out = patchXmlFile(null, 'serversettings', { '@port': 27015, '@name': 'A' });
    expect(out).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>\n<serversettings[^>]*port="27015"/);
  });

  it('property:Name setzt value, fügt sonst ein Element ein', () => {
    const src = '<ServerSettings>\n  <property name="ServerName" value="Alt"/>\n  <property value="26900" name="ServerPort"/>\n</ServerSettings>\n';
    const out = patchXmlFile(src, 'ServerSettings', { 'property:ServerName': 'Neu', 'property:ServerPort': 12345, 'property:Neu': 'ja' });
    expect(out).toContain('<property name="ServerName" value="Neu"/>');
    expect(out).toContain('<property value="12345" name="ServerPort"/>');
    expect(out).toMatch(/<property name="Neu" value="ja" \/>\n<\/ServerSettings>/);
  });

  it('Elementtext wird ersetzt oder eingefügt', () => {
    const src = '<Config>\n  <ServerName>Alt</ServerName>\n</Config>\n';
    const out = patchXmlFile(src, 'Config', { ServerName: 'Neu', MaxPlayers: 8 });
    expect(out).toContain('<ServerName>Neu</ServerName>');
    expect(out).toContain('<MaxPlayers>8</MaxPlayers>');
  });

  it('klappt ein leeres Wurzelelement auf', () => {
    expect(patchXmlFile('<Config/>', 'Config', { A: 'b' })).toBe('<Config>\n  <A>b</A>\n</Config>');
  });

  it('maskiert Sonderzeichen: ein Wert kann kein Element und kein Attribut einschleusen', () => {
    const out = patchXmlFile('<c a="x"/>', 'c', { '@a': 'q" evil="1' , T: '<script>&</script>' });
    expect(out).toContain('a="q&quot; evil=&quot;1"');
    expect(out).toContain('<T>&lt;script&gt;&amp;&lt;/script&gt;</T>');
    expect(out).not.toContain('evil="1"');
    expect(out).not.toContain('<script>');
  });

  it('lehnt ungültige Namen ab', () => {
    expect(() => patchXmlFile(null, 'a b', {})).toThrow();
    expect(() => patchXmlFile('<c/>', 'c', { '@a b': 'x' })).toThrow();
    expect(() => patchXmlFile('<c/>', 'c', { 'x y': 'x' })).toThrow();
    expect(() => patchXmlFile('<c/>', 'c', { 'property:a"b': 'x' })).toThrow();
    expect(() => patchXmlFile('<andere/>', 'c', { '@a': 'x' })).toThrow(/Wurzelelement/);
  });
});

describe('YAML', () => {
  const src = [
    '# Server',
    'ServerConfig:',
    '  Srv_Port: 30000   # Port',
    '  Srv_Name: "Alt"',
    '  Nested:',
    '    Srv_Name: "innen"',
    '',
    'Other:',
    '  Srv_Name: "fremd"',
    '',
  ].join('\n');
  const text = (value: string) => ({ raw: false, value });
  const raw = (value: string | number | boolean) => ({ raw: true, value });

  it('ersetzt nur den Schlüssel auf der richtigen Ebene und lässt Kommentare stehen', () => {
    const out = patchYamlFile(src, { 'ServerConfig.Srv_Name': text('Neu'), 'ServerConfig.Srv_Port': raw(31000) });
    expect(out).toContain('  Srv_Name: "Neu"');
    expect(out).toContain('  Srv_Port: 31000\n');
    // gleichnamige tiefere und fremde Einträge bleiben
    expect(out).toContain('    Srv_Name: "innen"');
    expect(out).toContain('  Srv_Name: "fremd"');
    expect(out.startsWith('# Server\n')).toBe(true);
  });

  it('fügt fehlende Schlüssel ans Ende ihres Blocks ein, mit der Einrückung des Blocks', () => {
    const out = patchYamlFile(src, { 'ServerConfig.Tel_Enabled': raw(true) });
    expect(out).toContain('    Srv_Name: "innen"\n  Tel_Enabled: true\n\nOther:');
  });

  it('legt fehlende Blöcke an - auch in einer leeren Datei', () => {
    expect(patchYamlFile(null, { 'A.B.C': raw(1) })).toBe('A:\n  B:\n    C: 1\n');
    const out = patchYamlFile(src, { 'Neu.X': text('y') });
    expect(out.endsWith('Neu:\n  X: "y"\n')).toBe(true);
  });

  it('schreibt Text immer in Anführungszeichen: Doppelpunkte, # und Zeilenumbrüche bleiben Text', () => {
    const out = patchYamlFile('a: 1\n', { a: text('x: y # z\nb: 2'), b: text('true') });
    expect(out).toBe('a: "x: y # z b: 2"\nb: "true"\n');
    expect(patchYamlFile('a: 1\n', { a: text('mit "Anführungszeichen"') })).toBe('a: "mit \\"Anführungszeichen\\""\n');
  });

  it('behält Windows-Zeilenenden', () => {
    expect(patchYamlFile('a: 1\r\nb: 2\r\n', { a: raw(3) })).toBe('a: 3\r\nb: 2\r\n');
  });
});

describe('Vorlagen mit den neuen Formaten', () => {
  const values = { SERVER_NAME: 'Mein Server', PORT: '27015', PW: '' };

  it('ini, xml und yaml laufen über denselben Weg wie json', () => {
    const ini = renderConfig({ path: 'a.ini', format: 'ini', section: 'SERVER', set: { NAME: '{{SERVER_NAME}}', HTTP: { $number: '{{PORT}}' }, PASSWORD: '{{PW}}' } }, null, values);
    expect(ini).toBe('[SERVER]\nNAME=Mein Server\nHTTP=27015\nPASSWORD=\n');
    const xml = renderConfig({ path: 'a.xml', format: 'xml', root: 'serversettings', set: { '@name': '{{SERVER_NAME}}', '@port': { $number: '{{PORT}}' } } }, null, values);
    expect(xml).toContain('name="Mein Server"');
    expect(xml).toContain('port="27015"');
    const yaml = renderConfig({ path: 'a.yaml', format: 'yaml', set: { 'S.Name': '{{SERVER_NAME}}', 'S.Port': { $number: '{{PORT}}' } } }, null, values);
    expect(yaml).toBe('S:\n  Name: "Mein Server"\n  Port: 27015\n');
  });

  it('eine leere Zahl ist ein Fehler, keine stille Null', () => {
    expect(() => renderConfig({ path: 'a.ini', format: 'ini', set: { P: { $number: '{{PW}}' } } }, null, values)).toThrow(/keine Zahl/);
  });
});
