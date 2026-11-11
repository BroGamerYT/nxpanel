/**
 * Kleiner Patcher fuer `.properties`-Dateien (server.properties).
 *
 * Aendert nur die genannten Schluessel und laesst Kommentare, Reihenfolge und
 * alle anderen Zeilen unangetastet. Fehlende Schluessel werden angehaengt.
 *
 * Bewusst klein nachgebaut statt aus dem Panel uebernommen: der Core darf
 * `src/` des Panels nicht importieren (eigenes Paket, eigene .exe). Das
 * Panel hat in `src/eggs/config-files.ts` die grosse Fassung fuer INI, YAML,
 * JSON und XML - ein gemeinsames Paket dafuer steht noch aus.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** `{{SERVER_PORT}}` und `{{server.build.env.SERVER_PORT}}` meinen dasselbe. */
function normalizeKey(raw: string): string {
  const parts = raw.split('.');
  return (parts[parts.length - 1] ?? raw).toUpperCase();
}

/**
 * Ersetzt Platzhalter. Unbekannte werden geleert, nie stehen gelassen -
 * dieselbe Regel wie im Panel (`src/eggs/variables.ts`).
 */
export function substitute(template: string, values: Record<string, string>): string {
  const upper: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) upper[key.toUpperCase()] = value;
  return template.replace(PLACEHOLDER, (_match, raw: string) => upper[normalizeKey(raw)] ?? '');
}

/** Maskiert, was in einer .properties-Datei eine Sonderbedeutung hat. */
function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n');
}

function keyPattern(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*[=:]`);
}

export function patchProperties(text: string, values: Record<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  // Eine Datei endet ueblicherweise mit einem Zeilenumbruch - der leere Rest ist keine Zeile.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const pending = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') || trimmed.startsWith('!')) return line;
    for (const [key, value] of pending) {
      if (keyPattern(key).test(line)) {
        pending.delete(key);
        return `${key}=${escapeValue(value)}`;
      }
    }
    return line;
  });

  for (const [key, value] of pending) out.push(`${key}=${escapeValue(value)}`);
  return out.join(eol) + eol;
}
