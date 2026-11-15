/** Erkennt, dass eine nachgeladene Seitendatei nicht geladen werden konnte (nach einem Update gibt es den alten Dateinamen nicht mehr). */
export function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk .* failed|ChunkLoadError/i.test(msg);
}
