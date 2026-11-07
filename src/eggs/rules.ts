import { z, type ZodTypeAny } from 'zod';

/**
 * Egg-Variablen beschreiben ihre Pruefung als Zeichenkette im Stil von
 * Laravel, weil die Pterodactyl-Eggs das so tun:
 *
 *   "required|string|max:40"
 *   "nullable|numeric|between:1,100"
 *   "required|in:survival,creative,adventure"
 *
 * Aus dieser Zeile entsteht hier zweierlei: eine Pruefung fuers Backend und
 * die Angabe, welches Bedienelement die Oberflaeche zeigen soll. Damit
 * bekommt jedes neue Spiel ein brauchbares Formular, ohne dass dafuer Code
 * geschrieben wird.
 */

export type WidgetKind = 'text' | 'number' | 'slider' | 'toggle' | 'select' | 'password' | 'textarea';

export interface ParsedRules {
  required: boolean;
  nullable: boolean;
  type: 'string' | 'number' | 'boolean';
  min?: number;
  max?: number;
  options?: string[];
  pattern?: string;
  widget: WidgetKind;
  schema: ZodTypeAny;
}

export function parseRules(rules: string | null | undefined, envName = ''): ParsedRules {
  const parts = (rules ?? '')
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);

  const has = (name: string) => parts.some((p) => p === name || p.startsWith(`${name}:`));
  const arg = (name: string): string | undefined =>
    parts.find((p) => p.startsWith(`${name}:`))?.slice(name.length + 1);

  const required = has('required');
  const nullable = has('nullable') || !required;

  let type: ParsedRules['type'] = 'string';
  if (has('numeric') || has('integer')) type = 'number';
  if (has('boolean')) type = 'boolean';

  const options = arg('in')?.split(',').map((s) => s.trim()).filter(Boolean);
  const pattern = extractRegex(arg('regex'));

  let min = numberArg(arg('min'));
  let max = numberArg(arg('max'));
  const between = arg('between')?.split(',').map(Number);
  if (between?.length === 2 && Number.isFinite(between[0]) && Number.isFinite(between[1])) {
    min = between[0];
    max = between[1];
  }

  const widget = chooseWidget({ type, options, min, max, envName });

  return {
    required,
    nullable,
    type,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(options ? { options } : {}),
    ...(pattern ? { pattern } : {}),
    widget,
    schema: buildSchema({ required, type, options, min, max, pattern }),
  };
}

/**
 * Die Regel bestimmt das Bedienelement. Grundsatz aus dem Konzept:
 * wo die moeglichen Werte bekannt sind, gibt es kein Textfeld.
 */
function chooseWidget(o: {
  type: ParsedRules['type'];
  options?: string[] | undefined;
  min?: number | undefined;
  max?: number | undefined;
  envName: string;
}): WidgetKind {
  const name = o.envName.toUpperCase();
  if (/PASS|SECRET|TOKEN|KEY$/.test(name)) return 'password';
  if (o.options?.length) return 'select';
  if (o.type === 'boolean') return 'toggle';
  if (o.type === 'number') {
    const spanned = o.min !== undefined && o.max !== undefined;
    return spanned && o.max! - o.min! <= 1000 ? 'slider' : 'number';
  }
  if (o.max !== undefined && o.max > 200) return 'textarea';
  return 'text';
}

function buildSchema(o: {
  required: boolean;
  type: ParsedRules['type'];
  options?: string[] | undefined;
  min?: number | undefined;
  max?: number | undefined;
  pattern?: string | undefined;
}): ZodTypeAny {
  let schema: ZodTypeAny;

  if (o.options?.length) {
    schema = z.enum(o.options as [string, ...string[]]);
  } else if (o.type === 'number') {
    let n = z.coerce.number();
    if (o.min !== undefined) n = n.min(o.min);
    if (o.max !== undefined) n = n.max(o.max);
    schema = n;
  } else if (o.type === 'boolean') {
    schema = z.enum(['true', 'false', '0', '1']);
  } else {
    let s = z.string();
    if (o.min !== undefined) s = s.min(o.min);
    if (o.max !== undefined) s = s.max(o.max);
    if (o.pattern) {
      try {
        s = s.regex(new RegExp(o.pattern));
      } catch {
        /* Unuebersetzbare Muster werden ignoriert statt den Import zu kippen */
      }
    }
    schema = s;
  }

  return o.required ? schema : schema.optional();
}

function numberArg(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Laravel schreibt Muster als /.../ - die Schraegstriche muessen weg. */
function extractRegex(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = v.match(/^\/(.*)\/[a-z]*$/s);
  return m?.[1] ?? v;
}
