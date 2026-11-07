import { parseRules } from './rules.js';

/**
 * Ersetzt Platzhalter im Startkommando und in Konfigurationsdateien.
 *
 * Unterstuetzt beide Schreibweisen, die in freier Wildbahn vorkommen:
 *   {{SERVER_MEMORY}}
 *   {{server.build.env.SERVER_MEMORY}}
 *   {{server.build.default.port}}
 */
export interface SubstitutionContext {
  variables: Record<string, string>;
  ramMb: number;
  ip: string;
  port: number;
  ports: Record<string, number>;
  serverDir: string;
  serverName: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export function substitute(template: string, ctx: SubstitutionContext): string {
  const builtin: Record<string, string> = {
    SERVER_MEMORY: String(ctx.ramMb),
    // Fuer Java-Spiele: Heap mit Luft fuer den JVM-Eigenbedarf. Wer den Heap
    // auf das volle Containerlimit setzt, wird vom Kernel beendet (OOM).
    SERVER_MEMORY_HEAP: String(Math.max(256, Math.floor(ctx.ramMb * 0.85))),
    SERVER_IP: ctx.ip,
    SERVER_PORT: String(ctx.port),
    SERVER_DIR: ctx.serverDir,
    SERVER_NAME: ctx.serverName,
    ...Object.fromEntries(Object.entries(ctx.ports).map(([ref, p]) => [`${ref.toUpperCase()}_PORT`, String(p)])),
  };

  // Variablen, die selbst Platzhalter enthalten (z. B. STEAM_PORT =
  // "{{STEAM_PORT}}" oder MEMORY = "{{SERVER_MEMORY_HEAP}}M"), sind Vorlagen,
  // keine fertigen Werte. Sie werden einmal gegen die festen Werte aufgeloest.
  // Vorher gewann die Vorlage gegen den echten Port, und im Container stand
  // woertlich "{{STEAM_PORT}}".
  const plain: Record<string, string> = {};
  const templates: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.variables)) (typeof v === 'string' && v.includes('{{') ? templates : plain)[k] = v;
  const base = { ...builtin, ...plain };
  const resolved = Object.fromEntries(Object.entries(templates).map(([k, v]) => [k, v.replace(PLACEHOLDER, (_m, raw: string) => base[normalizeKey(raw)] ?? '')]));
  const all = { ...base, ...resolved };

  return template.replace(PLACEHOLDER, (_match, rawKey: string) => {
    const key = normalizeKey(rawKey);
    const value = all[key];

    // Unbekannte Platzhalter werden geleert, nie stehen gelassen.
    // Ein uebrig gebliebenes {{FOO}} im Startkommando ist ein Fehler, den
    // man erst im Spiel-Log sieht - dann aber sehr unangenehm.
    return value ?? '';
  });
}

/** Findet alle Platzhalter, die kein Wert deckt. Fuer die Pruefung beim Import. */
export function missingPlaceholders(template: string, known: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    const key = normalizeKey(m[1]!);
    if (!known.has(key)) found.add(key);
  }
  return [...found];
}

function normalizeKey(raw: string): string {
  return raw
    .replace(/^server\.build\.env\./, '')
    .replace(/^server\.build\.default\.port$/, 'SERVER_PORT')
    .replace(/^server\.build\.default\.ip$/, 'SERVER_IP')
    .replace(/^server\.build\.memory$/, 'SERVER_MEMORY')
    .replace(/^env\./, '');
}

/**
 * Prueft die vom Nutzer gesetzten Werte gegen die Regeln des Eggs und
 * ergaenzt fehlende durch ihre Vorgabe.
 */
export interface VariableDefinition {
  env_variable: string;
  default_value: string | null;
  rules: string | null;
  user_editable: boolean;
}

export interface ValidationResult {
  values: Record<string, string>;
  errors: { variable: string; message: string }[];
}

export function validateVariables(
  defs: VariableDefinition[],
  input: Record<string, string>,
): ValidationResult {
  const values: Record<string, string> = {};
  const errors: ValidationResult['errors'] = [];

  for (const def of defs) {
    const raw = def.user_editable ? input[def.env_variable] : undefined;
    const value = raw ?? def.default_value ?? '';
    const parsed = parseRules(def.rules, def.env_variable);

    if (value === '' && !parsed.required) {
      values[def.env_variable] = '';
      continue;
    }

    const result = parsed.schema.safeParse(value === '' ? undefined : value);
    if (!result.success) {
      errors.push({
        variable: def.env_variable,
        message: result.error.issues[0]?.message ?? 'ungueltiger Wert',
      });
      continue;
    }

    values[def.env_variable] = String(result.data ?? '');
  }

  return { values, errors };
}

/**
 * Vorgabewert "{{GENERATE_PASSWORD}}": Das Panel erzeugt beim Anlegen ein
 * zufaelliges Passwort, wenn der Nutzer das Feld leer laesst. So koennen Eggs
 * Pflicht-Passwoerter haben (z. B. Admin-Passwort), ohne dass ein
 * unsicherer fester Wert im Egg steht oder das Anlegen scheitert.
 */
export const GENERATE_PASSWORD = '{{GENERATE_PASSWORD}}';

export function isGeneratedDefault(defaultValue: string | null | undefined): boolean {
  return (defaultValue ?? '').trim() === GENERATE_PASSWORD;
}

/** Fuellt leere (oder noch als Platzhalter gesendete) Felder mit "{{GENERATE_PASSWORD}}"-Vorgabe. */
export function fillGeneratedValues(
  defs: ReadonlyArray<{ env_variable: string; default_value: string | null }>,
  input: Record<string, string>,
  random: () => string,
): { values: Record<string, string>; generated: string[] } {
  const values = { ...input };
  const generated: string[] = [];
  for (const d of defs) {
    if (!isGeneratedDefault(d.default_value)) continue;
    const cur = (values[d.env_variable] ?? '').trim();
    if (cur === '' || cur === GENERATE_PASSWORD) {
      values[d.env_variable] = random();
      generated.push(d.env_variable);
    }
  }
  return { values, generated };
}
