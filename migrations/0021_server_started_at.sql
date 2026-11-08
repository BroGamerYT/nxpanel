-- Laufzeit von Server-Instanzen festhalten
ALTER TABLE servers ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- Laufende Server initial mit der aktuellen Zeit vorbefuellen;
-- reconcile() gleicht sie beim Start mit den echten Docker-Containern ab.
UPDATE servers SET started_at = NOW() WHERE status = 'running' AND started_at IS NULL;
