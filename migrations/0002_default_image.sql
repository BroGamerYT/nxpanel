-- Postgres speichert JSONB normalisiert und sortiert die Schluessel dabei um.
-- Die Reihenfolge aus dem Egg geht also verloren: aus
--   { "Java 21": ..., "Java 17": ... }
-- wird beim Lesen "Java 17" zuerst. Welches Image als Vorgabe gilt, waere
-- damit Zufall. Deshalb wird es beim Import ausdruecklich festgehalten.
--
-- IF NOT EXISTS mit Absicht: eine Migration muss sich wiederholen lassen,
-- ohne zu brechen. Wurde sie von Hand eingespielt oder brach ein Lauf
-- zwischen Anwenden und Vermerken ab, steht der Betreiber sonst vor einer
-- Datenbank, die sich nicht mehr aktualisieren laesst.

ALTER TABLE eggs ADD COLUMN IF NOT EXISTS default_image TEXT;

-- Bestehende Eggs bekommen einen Wert, damit nichts auf NULL steht.
-- Welcher es ist, laesst sich nachtraeglich nicht mehr bestimmen - die
-- Reihenfolge ist ja bereits verloren. Wer die richtige Vorgabe braucht,
-- importiert das Egg neu: npm run egg -- reimport <datei>
UPDATE eggs
SET default_image = (SELECT value FROM jsonb_each_text(docker_images) LIMIT 1)
WHERE default_image IS NULL;
