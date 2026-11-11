/**
 * Konfigurationsdateien in INI, XML und YAML: einzelne Werte setzen, den Rest der Datei unveraendert lassen.
 *
 * Bewusst keine vollstaendigen Parser: Spiele liefern ihre Standarddatei mit Kommentaren und eigener Reihenfolge
 * mit, und die soll nach dem Setzen von Name, Port und Passwort noch genauso aussehen. Deshalb wird nur die
 * betroffene Zeile ersetzt oder - fehlt sie - an der richtigen Stelle eingefuegt.
 *
 * Alle Werte sind schon aufgeloeste Texte. Zeilenumbrueche in Werten werden zu Leerzeichen: ein Servername
 * darf nie eine neue Zeile (und damit eine neue Einstellung) einschleusen.
 */

export type ConfigValue = string | number | boolean;

const oneLine = (v: ConfigValue): string => String(v).replace(/[\r\n]+/g, ' ');

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

// -------------------------------------------------------------------- INI

/**
 * `[Abschnitt]` und `Schluessel=Wert`. Ohne `section` gilt der Teil vor dem ersten Abschnitt.
 * Schluessel werden ohne Beachtung der Gross-/Kleinschreibung gefunden, die Schreibweise der Datei bleibt.
 */
export function patchIniFile(existing: string | null, section: string | undefined, set: Record<string, ConfigValue>): string {
  const eol = eolOf(existing ?? '');
  const lines = existing ? existing.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const isHeader = (l: string) => /^\s*\[[^\]]*\]\s*$/.test(l);
  const headerName = (l: string) => l.trim().slice(1, -1).trim().toLowerCase();

  // Bereich der Zeilen, in dem die Schluessel stehen: [from, to)
  let from = 0;
  let to = lines.length;
  let found = false;
  if (section === undefined || section === '') {
    const firstHeader = lines.findIndex(isHeader);
    to = firstHeader >= 0 ? firstHeader : lines.length;
    found = true;
  } else {
    const at = lines.findIndex((l) => isHeader(l) && headerName(l) === section.trim().toLowerCase());
    if (at >= 0) {
      from = at + 1;
      const next = lines.findIndex((l, i) => i > at && isHeader(l));
      to = next >= 0 ? next : lines.length;
      found = true;
    }
  }

  if (!found) {
    if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('');
    lines.push(`[${section!.trim()}]`);
    from = lines.length;
    to = lines.length;
  }

  for (const [key, raw] of Object.entries(set)) {
    const cleanKey = key.replace(/[\r\n=]/g, '');
    const value = oneLine(raw);
    const matches = (l: string) => {
      const m = /^\s*([^=;#\[][^=]*?)\s*=/.exec(l);
      return m !== null && m[1]!.toLowerCase() === cleanKey.toLowerCase();
    };
    let at = -1;
    for (let i = from; i < to; i++) {
      if (matches(lines[i]!)) {
        at = i;
        break;
      }
    }
    if (at >= 0) {
      const original = /^\s*([^=]*?)\s*=/.exec(lines[at]!)![1]!;
      lines[at] = `${original}=${value}`;
    } else {
      // Vor die leeren Zeilen am Ende des Bereichs
      let insertAt = to;
      while (insertAt > from && lines[insertAt - 1]!.trim() === '') insertAt--;
      lines.splice(insertAt, 0, `${cleanKey}=${value}`);
      to++;
    }
  }
  return lines.join(eol) + eol;
}

// -------------------------------------------------------------------- XML

const xmlEscape = (v: ConfigValue): string =>
  oneLine(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const NAME_OK = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/**
 * Schluessel:
 *  - `@attribut`        Attribut des Wurzelelements (`<serversettings port="27015">`)
 *  - `element`          Text eines Elements (`<ServerName>…</ServerName>`)
 *  - `element:Name`     Element mit `name="Name"`, Wert im Attribut `value` (`<property name="ServerPort" value="26900"/>`)
 * Fehlt etwas, kommt es vor das Ende des Wurzelelements. Ohne Datei wird `<root/>` angelegt.
 */
export function patchXmlFile(existing: string | null, root: string, set: Record<string, ConfigValue>): string {
  if (!NAME_OK.test(root)) throw new Error(`Ungültiger Elementname „${root}“.`);
  let text = existing && existing.trim() !== '' ? existing : `<?xml version="1.0" encoding="utf-8"?>\n<${root}>\n</${root}>\n`;
  const eol = eolOf(text);

  for (const [key, raw] of Object.entries(set)) {
    const value = xmlEscape(raw);

    if (key.startsWith('@')) {
      const attr = key.slice(1);
      if (!NAME_OK.test(attr)) throw new Error(`Ungültiger Attributname „${attr}“.`);
      const tag = new RegExp(`<${escapeRe(root)}(\\s[^>]*?)?(/?)>`);
      const m = tag.exec(text);
      if (!m) throw new Error(`Wurzelelement <${root}> nicht gefunden.`);
      const attrs = m[1] ?? '';
      const has = new RegExp(`(\\s${escapeRe(attr)}\\s*=\\s*)("[^"]*"|'[^']*')`);
      const nextAttrs = has.test(attrs) ? attrs.replace(has, (_s, pre: string) => `${pre}"${value}"`) : `${attrs} ${attr}="${value}"`;
      text = text.slice(0, m.index) + `<${root}${nextAttrs}${m[2]}>` + text.slice(m.index + m[0].length);
      continue;
    }

    const [element, name] = key.split(':') as [string, string | undefined];
    if (!NAME_OK.test(element!) || (name !== undefined && /["<>&\r\n]/.test(name))) throw new Error(`Ungültiger Schlüssel „${key}“.`);

    if (name !== undefined) {
      // <element name="Name" value="…"> in beliebiger Attributreihenfolge
      const el = new RegExp(`<${escapeRe(element!)}(\\s[^>]*?\\sname\\s*=\\s*"${escapeRe(name)}"[^>]*?|\\sname\\s*=\\s*"${escapeRe(name)}"[^>]*?)(/?)>`);
      const m = el.exec(text);
      if (m) {
        const attrs = m[1]!;
        const has = /(\svalue\s*=\s*)("[^"]*"|'[^']*')/;
        const next = has.test(attrs) ? attrs.replace(has, (_s, pre: string) => `${pre}"${value}"`) : `${attrs} value="${value}"`;
        text = text.slice(0, m.index) + `<${element}${next}${m[2]}>` + text.slice(m.index + m[0].length);
        continue;
      }
      text = insertBeforeRootEnd(text, root, `<${element} name="${name}" value="${value}" />`, eol);
      continue;
    }

    const el = new RegExp(`(<${escapeRe(element!)}(?:\\s[^>]*)?>)([^<]*)(</${escapeRe(element!)}>)`);
    if (el.test(text)) text = text.replace(el, (_s, open: string, _old: string, close: string) => `${open}${value}${close}`);
    else text = insertBeforeRootEnd(text, root, `<${element}>${value}</${element}>`, eol);
  }
  return text;
}

function insertBeforeRootEnd(text: string, root: string, fragment: string, eol: string): string {
  const close = new RegExp(`</${escapeRe(root)}>\\s*$`);
  const m = close.exec(text);
  if (m) return text.slice(0, m.index) + `  ${fragment}${eol}` + text.slice(m.index);
  // <root ... /> ohne Inhalt: aufklappen
  const selfClosing = new RegExp(`<${escapeRe(root)}((?:\\s[^>]*?)?)\\s*/>`);
  const s = selfClosing.exec(text);
  if (s) return text.slice(0, s.index) + `<${root}${s[1]}>${eol}  ${fragment}${eol}</${root}>` + text.slice(s.index + s[0].length);
  throw new Error(`Wurzelelement <${root}> nicht gefunden.`);
}

// -------------------------------------------------------------------- YAML

export interface YamlRaw {
  /** Zahlen und Wahrheitswerte stehen ohne Anfuehrungszeichen, Text immer in doppelten. */
  raw: boolean;
  value: ConfigValue;
}

const yamlScalar = (v: YamlRaw): string => (v.raw ? oneLine(v.value) : JSON.stringify(oneLine(v.value)));

/**
 * Schluessel wie `ServerConfig.Srv_Name` (Einrueckung = Ebene). Es werden nur Skalare gesetzt; Kommentare, Listen
 * und alles andere bleiben. Fehlt der Schluessel, kommt er ans Ende seines Blocks, fehlt der Block, ans Dateiende.
 */
export function patchYamlFile(existing: string | null, set: Record<string, YamlRaw>): string {
  const eol = eolOf(existing ?? '');
  const lines = existing ? existing.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const indentOf = (l: string) => l.length - l.trimStart().length;
  const isContent = (l: string) => l.trim() !== '' && !l.trimStart().startsWith('#');
  const keyOf = (l: string): string | null => {
    const m = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s:#][^:#]*?))\s*:(?:\s|$)/.exec(l);
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
  };

  for (const [dotted, value] of Object.entries(set)) {
    const path = dotted.split('.').filter(Boolean);
    if (path.length === 0 || path.some((p) => /[\r\n]/.test(p))) throw new Error(`Ungültiger Schlüssel „${dotted}“.`);

    // Von oben nach unten: Block des Elternschluessels suchen
    let from = 0;
    let to = lines.length;
    let parentIndent = -1;
    let depth = 0;
    for (; depth < path.length - 1; depth++) {
      // Nur direkte Kinder zaehlen: ein tiefer verschachtelter Eintrag mit demselben Namen ist ein anderer
      const direct = childIndentOf(lines, from, to, parentIndent, isContent, indentOf);
      let at = -1;
      if (direct !== null) {
        for (let i = from; i < to; i++) {
          if (isContent(lines[i]!) && indentOf(lines[i]!) === direct && keyOf(lines[i]!) === path[depth]) {
            at = i;
            break;
          }
        }
      }
      if (at < 0) break;
      const myIndent = indentOf(lines[at]!);
      let end = at + 1;
      while (end < to && (!isContent(lines[end]!) || indentOf(lines[end]!) > myIndent)) end++;
      from = at + 1;
      to = end;
      parentIndent = myIndent;
    }

    // Fehlende Zwischenebenen anlegen (ans Ende des Elternblocks bzw. der Datei)
    if (depth < path.length - 1) {
      let insertAt = to;
      while (insertAt > from && lines[insertAt - 1]!.trim() === '') insertAt--;
      const step = parentIndent < 0 ? 0 : (childIndentOf(lines, from, to, parentIndent, isContent, indentOf) ?? parentIndent + 2);
      const add: string[] = [];
      for (let d = depth; d < path.length - 1; d++) add.push(`${' '.repeat(step + (d - depth) * 2)}${path[d]}:`);
      add.push(`${' '.repeat(step + (path.length - 1 - depth) * 2)}${path[path.length - 1]}: ${yamlScalar(value)}`);
      lines.splice(insertAt, 0, ...add);
      continue;
    }

    // Letzter Schluessel im Block [from, to)
    const childIndent = childIndentOf(lines, from, to, parentIndent, isContent, indentOf);
    let at = -1;
    for (let i = from; i < to; i++) {
      if (isContent(lines[i]!) && keyOf(lines[i]!) === path[path.length - 1] && (childIndent === null || indentOf(lines[i]!) === childIndent)) {
        at = i;
        break;
      }
    }
    if (at >= 0) {
      const pad = ' '.repeat(indentOf(lines[at]!));
      lines[at] = `${pad}${path[path.length - 1]}: ${yamlScalar(value)}`;
    } else {
      let insertAt = to;
      while (insertAt > from && lines[insertAt - 1]!.trim() === '') insertAt--;
      const pad = ' '.repeat(childIndent ?? (parentIndent < 0 ? 0 : parentIndent + 2));
      lines.splice(insertAt, 0, `${pad}${path[path.length - 1]}: ${yamlScalar(value)}`);
    }
  }
  return lines.join(eol) + eol;
}

/** Einrueckung der direkten Kinder eines Blocks (die der ersten Inhaltszeile); null, wenn es keine gibt. */
function childIndentOf(
  lines: string[],
  from: number,
  to: number,
  parentIndent: number,
  isContent: (l: string) => boolean,
  indentOf: (l: string) => number,
): number | null {
  for (let i = from; i < to; i++) {
    if (isContent(lines[i]!) && indentOf(lines[i]!) > parentIndent) return indentOf(lines[i]!);
  }
  return null;
}
