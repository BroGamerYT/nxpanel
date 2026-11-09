-- Speichert den exakten Zeitpunkt der letzten Panel-Aktivitaet
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
