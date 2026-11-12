/**
 * Ersetzt Platzhalter im Startkommando und in Umgebungsvariablen (wie im Panel).
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

function normalizeKey(raw: string): string {
  return raw
    .replace(/^server\.build\.env\./, '')
    .replace(/^server\.environment\./, '')
    .replace(/^server\.build\.default\.port$/, 'SERVER_PORT')
    .replace(/^server\.allocations\.default\.port$/, 'SERVER_PORT')
    .replace(/^server\.build\.default\.ip$/, 'SERVER_IP')
    .replace(/^server\.allocations\.default\.ip$/, 'SERVER_IP')
    .replace(/^server\.build\.memory$/, 'SERVER_MEMORY')
    .replace(/^env\./, '');
}

export function substitute(template: string | unknown, ctx: SubstitutionContext): string {
  if (typeof template !== 'string') return String(template ?? '');

  const builtin: Record<string, string> = {
    SERVER_MEMORY: String(ctx.ramMb),
    // Fuer Java-Spiele: Heap mit Luft fuer den JVM-Eigenbedarf. Wer den Heap auf das volle Limit setzt, wird vom Kernel beendet.
    SERVER_MEMORY_HEAP: String(Math.max(256, Math.floor(ctx.ramMb * 0.85))),
    SERVER_IP: ctx.ip,
    SERVER_PORT: String(ctx.port),
    SERVER_DIR: ctx.serverDir,
    SERVER_NAME: ctx.serverName,
    ...Object.fromEntries(Object.entries(ctx.ports).flatMap(([ref, p]) => [[`${ref.toUpperCase()}_PORT`, String(p)], [`PORT_${ref.toUpperCase()}`, String(p)]])),
  };

  // Variablen, die selbst Platzhalter enthalten (STEAM_PORT = "{{STEAM_PORT}}", MEMORY = "{{SERVER_MEMORY_HEAP}}M"), sind
  // Vorlagen, keine fertigen Werte: sie werden einmal gegen die festen Werte aufgeloest.
  const plain: Record<string, string> = {};
  const templates: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.variables)) (typeof v === 'string' && v.includes('{{') ? templates : plain)[k] = v;
  const base = { ...builtin, ...plain };
  const resolved = Object.fromEntries(Object.entries(templates).map(([k, v]) => [k, v.replace(PLACEHOLDER, (_m, raw: string) => base[normalizeKey(raw)] ?? '')]));
  const all = { ...base, ...resolved };

  // Unbekannte Platzhalter werden geleert, nie stehen gelassen.
  return template.replace(PLACEHOLDER, (_match, rawKey: string) => all[normalizeKey(rawKey)] ?? '');
}
