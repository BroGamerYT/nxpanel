-- Bandbreiten-Limit pro Server (Upload/Download in KB/s).
-- NULL bedeutet: unbegrenzt (kein Limit).
ALTER TABLE servers
  ADD COLUMN bandwidth_download_kbps INTEGER,
  ADD COLUMN bandwidth_upload_kbps INTEGER;

-- Kommentar fuer Dokumentation (Postgres speichert das in pg_description)
COMMENT ON COLUMN servers.bandwidth_download_kbps IS 'Download-Bandbreiten-Limit in KB/s pro Server (NULL = unbegrenzt)';
COMMENT ON COLUMN servers.bandwidth_upload_kbps IS 'Upload-Bandbreiten-Limit in KB/s pro Server (NULL = unbegrenzt)';