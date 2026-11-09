import { substitute, type SubstitutionContext } from './variables.js';

/**
 * Patcht die Konfigurationsdateien eines Servers vor dem Start.
 *
 * Eggs beschreiben das so:
 *   {
 *     "server.properties": {
 *       "parser": "properties",
 *       "find": { "server-port": "{{SERVER_PORT}}", "motd": "{{MOTD}}" }
 *     }
 *   }
 *
 * Grundsatz: Es wird nur geaendert, was das Egg nennt. Alles andere bleibt
 * Zeichen fuer Zeichen stehen - auch Kommentare und Reihenfolge. Ein Patcher,
 * der die Datei neu schreibt, zerstoert die Anpassungen des Nutzers.
 */

export type ParserKind = 'properties' | 'yaml' | 'yml' | 'ini' | 'json' | 'xml' | 'file' | 'sqlite';

export interface ConfigFileSpec {
  parser: ParserKind;
  find: Record<string, unknown>;
  protected?: string[];
}

export interface PatchResult {
  content: string;
  changed: string[];
  added: string[];
  skipped: string[];
}

export function patchConfigFile(
  original: string,
  spec: ConfigFileSpec,
  ctx: SubstitutionContext,
): PatchResult {
  const values: Record<string, string> = {};
  for (const [key, template] of Object.entries(spec.find)) {
    values[key] = substitute(typeof template === 'string' ? template : String(template ?? ''), ctx);
  }

  switch (spec.parser) {
    case 'properties':
      return patchProperties(original, values);
    case 'ini':
      return patchIni(original, values);
    case 'yaml':
    case 'yml':
      return patchYaml(original, values);
    case 'file':
      return patchLines(original, values);
    case 'json':
      return patchJson(original, values);
    case 'xml':
      return patchXml(original, values);
    default:
      return { content: original, changed: [], added: [], skipped: Object.keys(values) };
  }
}

/**
 * Pterodactyl-Parser "file": Jede Zeile, die mit dem Suchtext beginnt, wird
 * komplett durch den Wert ersetzt. Nichts wird angehaengt - so verhaelt sich
 * auch Wings, und fremde Dateien bleiben sonst unberuehrt.
 */
function patchLines(original: string, values: Record<string, string>): PatchResult {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const changed = new Set<string>();
  const out = original.split(/\r?\n/).map((line) => {
    for (const [find, replacement] of Object.entries(values)) {
      if (find && line.startsWith(find)) {
        if (line !== replacement) changed.add(find);
        return replacement;
      }
    }
    return line;
  });
  const skipped = Object.keys(values).filter((k) => !out.some((l) => l === values[k]) && !changed.has(k));
  return { content: out.join(eol), changed: [...changed], added: [], skipped };
}

/** server.properties bei Minecraft: schluessel=wert, Kommentare mit # */
function patchProperties(original: string, values: Record<string, string>): PatchResult {
  const lines = original.split(/\r?\n/);
  const changed: string[] = [];
  const seen = new Set<string>();

  const out = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z0-9._-]+)(\s*=\s*)(.*)$/);
    if (!m) return line;
    const key = m[2]!;
    if (!(key in values)) return line;
    seen.add(key);
    const next = values[key]!;
    if (m[4] === next) return line;
    changed.push(key);
    return `${m[1]}${key}${m[3]}${next}`;
  });

  const added: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      out.push(`${key}=${value}`);
      added.push(key);
    }
  }

  return { content: out.join('\n'), changed, added, skipped: [] };
}

/** INI mit Abschnitten: [Abschnitt] dann schluessel=wert. Schluessel als "Abschnitt.schluessel". */
function patchIni(original: string, values: Record<string, string>): PatchResult {
  const lines = original.split(/\r?\n/);
  const changed: string[] = [];
  const seen = new Set<string>();
  let section = '';

  const out = lines.map((line) => {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      section = sec[1]!;
      return line;
    }
    const m = line.match(/^(\s*)([A-Za-z0-9._-]+)(\s*=\s*)(.*)$/);
    if (!m) return line;
    const bare = m[2]!;
    const full = section ? `${section}.${bare}` : bare;
    const key = full in values ? full : bare in values ? bare : null;
    if (!key) return line;
    seen.add(key);
    const next = values[key]!;
    if (m[4] === next) return line;
    changed.push(key);
    return `${m[1]}${bare}${m[3]}${next}`;
  });

  const added: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      // Neue Schluessel in einem Abschnitt anzulegen waere Raten - lieber melden.
      if (key.includes('.')) { added.push(key); continue; }
      out.push(`${key}=${value}`);
      added.push(key);
    }
  }

  return { content: out.join('\n'), changed, added, skipped: [] };
}

/**
 * YAML: nur flache und einfach verschachtelte Schluessel, adressiert als a.b.c.
 * Bewusst kein vollstaendiger YAML-Parser - der wuerde beim Zurueckschreiben
 * Kommentare und Formatierung verlieren.
 */
function patchYaml(original: string, values: Record<string, string>): PatchResult {
  const lines = original.split(/\r?\n/);
  const changed: string[] = [];
  const seen = new Set<string>();
  const path: { indent: number; key: string }[] = [];

  const out = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z0-9._-]+)(:\s*)(.*)$/);
    if (!m) return line;

    const indent = m[1]!.length;
    while (path.length > 0 && path[path.length - 1]!.indent >= indent) path.pop();
    path.push({ indent, key: m[2]! });

    const full = path.map((p) => p.key).join('.');
    if (!(full in values)) return line;

    seen.add(full);
    const next = values[full]!;
    if (m[4]!.trim() === next) return line;
    changed.push(full);
    return `${m[1]}${m[2]}${m[3]}${next}`;
  });

  const skipped = Object.keys(values).filter((k) => !seen.has(k));
  return { content: out.join('\n'), changed, added: [], skipped };
}

/** JSON: verschachtelte Schluessel als a.b.c, Einrueckung bleibt bei zwei Leerzeichen. */
function patchJson(original: string, values: Record<string, string>): PatchResult {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(original) as Record<string, unknown>;
  } catch {
    return { content: original, changed: [], added: [], skipped: Object.keys(values) };
  }

  const changed: string[] = [];
  for (const [path, value] of Object.entries(values)) {
    const parts = path.split('.');
    let node: Record<string, unknown> = data;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1]!;
    const parsed = value === 'true' ? true : value === 'false' ? false
      : /^-?\d+$/.test(value) ? Number(value) : value;
    if (node[last] !== parsed) {
      node[last] = parsed;
      changed.push(path);
    }
  }

  return { content: JSON.stringify(data, null, 2), changed, added: [], skipped: [] };
}

/** XML: ersetzt den Textinhalt eines Elements, adressiert als a.b.c. */
function patchXml(original: string, values: Record<string, string>): PatchResult {
  let content = original;
  const changed: string[] = [];
  const skipped: string[] = [];

  for (const [path, value] of Object.entries(values)) {
    const tag = path.split('.').pop()!;
    const re = new RegExp(`(<${tag}(?:\\s[^>]*)?>)([^<]*)(</${tag}>)`);
    if (re.test(content)) {
      content = content.replace(re, (_m, open: string, old: string, close: string) => {
        if (old !== value) changed.push(path);
        return `${open}${value}${close}`;
      });
      continue;
    }
    // Attribut-Schreibweise: <tag attr="wert">
    const attr = path.split('.').slice(-2);
    if (attr.length === 2) {
      const attrRe = new RegExp(`(<${attr[0]}\\b[^>]*\\b${attr[1]}=")([^"]*)(")`);
      if (attrRe.test(content)) {
        content = content.replace(attrRe, (_m, a: string, old: string, c: string) => {
          if (old !== value) changed.push(path);
          return `${a}${value}${c}`;
        });
        continue;
      }
    }
    skipped.push(path);
  }

  return { content, changed, added: [], skipped };
}
