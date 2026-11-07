# Translating NexusPanel

Every file in this folder is one language. To add yours:

1. Copy `en.json` (English is the reference) and name the copy after the
   language code: `fr.json`, `es.json`, `pt-BR.json` …
2. Set `_meta.name` to the language's own name (`"Français"`), `_meta.intl`
   to the locale used for dates and numbers (`"fr-FR"`) and add yourself to
   `_meta.translators`.
3. Translate the **values**, never the keys. Keep placeholders such as
   `{name}` or `{count}` exactly as they are – you may move them within the
   sentence.
4. Rebuild the panel. The language appears in the language picker
   automatically – no code changes needed.

Details:

- **Missing texts are fine.** Any key you leave out falls back to English, so
  a translation can grow step by step. Keys that don't exist in `en.json` are
  rejected by the test suite (usually a typo).
- **Singular and plural:** keys ending in `_one` and `_other` are picked by
  `{count}` (`1 core` / `2 cores`). Provide both.
- **Placeholders for markup:** some sentences contain e.g. `{file}` or
  `{path}`; the panel inserts formatted code there. Keep them.
- `npm test` in the project root checks every language file: valid JSON, no
  unknown keys, same placeholders as English.

Not translated yet (still German): game templates (eggs), messages in the
server timeline, the changelog and the planning list.

---

**Deutsch, kurz:** `en.json` kopieren, nach dem Sprachcode benennen,
Werte übersetzen, Schlüssel und `{Platzhalter}` stehen lassen. Fehlt ein Text,
erscheint der englische. Deutsch (`de.json`) ist vollständig und wird bei
jeder Änderung mitgepflegt.
