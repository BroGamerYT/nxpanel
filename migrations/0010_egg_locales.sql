-- Mehrsprachige Spielvorlagen (Eggs): Feldnamen und Beschreibungen je Sprache.
-- Ermoeglicht "name_locales": { "de": "...", "en": "..." } und
-- "description_locales": { "de": "...", "en": "..." } in Egg-Definitionen.
ALTER TABLE egg_variables ADD COLUMN IF NOT EXISTS name_locales JSONB;
ALTER TABLE egg_variables ADD COLUMN IF NOT EXISTS description_locales JSONB;
