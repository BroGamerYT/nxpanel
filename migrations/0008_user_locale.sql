-- Sprache der Oberflaeche je Nutzer. Freier Code ("de", "en", "pt-BR"):
-- welche Sprachen es gibt, entscheiden die Dateien in web/src/locales,
-- nicht die Datenbank - eine neue Sprache braucht keine Migration.
-- NULL = noch nie gewaehlt: dann gilt die Sprache des Browsers.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text
  CHECK (locale IS NULL OR locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
