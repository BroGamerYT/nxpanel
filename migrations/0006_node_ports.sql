-- NexusPanel - Oeffentliche Adresse und Port-Bereich je Host
-- Ist ein Bereich gesetzt, vergibt das Panel ALLE Spielports daraus,
-- unabhaengig vom Wunschbereich im Egg. So reicht auf dem Router bzw.
-- Proxmox-Host eine einzige Weiterleitung fuer den ganzen Bereich.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS public_host TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS port_from INT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS port_to INT;

DO $$ BEGIN
  ALTER TABLE nodes ADD CONSTRAINT nodes_port_range_chk
    CHECK ((port_from IS NULL AND port_to IS NULL)
        OR (port_from BETWEEN 1024 AND 65535 AND port_to BETWEEN port_from AND 65535));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
