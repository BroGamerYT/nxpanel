/**
 * Erkennt, dass der Core nach einem Update neu gestartet ist und die Seite veraltet ist.
 * Reine Funktionen ohne Abhaengigkeiten, damit sie sich testen lassen (siehe nexuscore/tests/web-reload.test.ts).
 */

/** Die Core-Version aus der Antwort von /core/v1/info; null, wenn die Antwort nicht passt (z. B. beim Panel ohne Core). */
export function parseCoreVersion(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const core = (body as { core?: unknown }).core;
  if (typeof core !== 'object' || core === null) return null;
  const version = (core as { version?: unknown }).version;
  return typeof version === 'string' && version.length > 0 ? version : null;
}

/** Neu laden nur, wenn beide Versionen bekannt sind und sich unterscheiden (beim Neustart antwortet der Core kurz gar nicht). */
export function shouldReload(baseline: string | null, current: string | null): boolean {
  return baseline !== null && current !== null && baseline !== current;
}
