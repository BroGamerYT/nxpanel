-- Phase 6: Mehrbenutzer- und Rechtesystem
-- allowed_eggs: JSON-Array von Egg-Namen/IDs, die der Benutzer anlegen darf. NULL = alle erlaubt.
ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_eggs JSONB DEFAULT NULL;
