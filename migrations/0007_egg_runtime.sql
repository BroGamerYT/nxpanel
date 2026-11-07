-- NexusPanel - Laufzeit-Angaben aus dem Egg
-- run_as:       Benutzer im Container (uid:gid). Das Panel richtet den
--               Datenordner fuer genau diesen Benutzer ein - viele Images
--               (ARK, Enshrouded, TeamSpeak) laufen nicht als root und
--               koennten sonst nicht speichern.
-- stop_timeout: So lange darf ein Server zum Speichern brauchen, bevor er
--               hart beendet wird. ARK braucht dafuer deutlich mehr als 15 s.
ALTER TABLE eggs ADD COLUMN IF NOT EXISTS run_as TEXT;
ALTER TABLE eggs ADD COLUMN IF NOT EXISTS stop_timeout INT NOT NULL DEFAULT 30;
