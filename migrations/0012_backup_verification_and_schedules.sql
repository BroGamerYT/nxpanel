-- Phase 5: Backup-Verifizierung, Zeitplaene & Aufbewahrung (Retention)

-- 1. Pruefstatus und Verifizierungsdetails an Backups ergaenzen
ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'valid', 'corrupted')),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_details JSONB;

-- 2. Automatische Backup-Zeitplaene und Retention an Servern hinterlegen
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS auto_backup_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_backup_interval_hours INT NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS auto_backup_retention INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS auto_backup_verify BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_auto_backup_at TIMESTAMPTZ;

-- 3. Speicherziele fuer Cloud- und Netzwerk-Backups (S3, SFTP / Hetzner Storage Box / NAS)
CREATE TABLE IF NOT EXISTS storage_targets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     UUID REFERENCES servers(id) ON DELETE CASCADE, -- NULL = Globaler Panel-Speicher
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('s3', 'sftp', 'local_path')),
  config        JSONB NOT NULL, -- Verschluesselte bzw. gesicherte Zugangsdaten (Host, Port, Bucket, Credentials)
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_targets_server_idx ON storage_targets (server_id);
