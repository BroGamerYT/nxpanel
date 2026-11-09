-- Granulare Modul- und Panel-Rechte fuer Benutzer
ALTER TABLE users ADD COLUMN IF NOT EXISTS global_permissions TEXT[] NOT NULL DEFAULT '{}';
