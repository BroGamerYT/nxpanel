-- Titelbild je Spiel: Wahl des Admins (siehe src/eggs/cover.ts).
-- NULL = automatisch (Steam-Bild oder Panel-Motiv).
ALTER TABLE eggs ADD COLUMN IF NOT EXISTS cover text;
ALTER TABLE eggs ADD COLUMN IF NOT EXISTS cover_version text;
