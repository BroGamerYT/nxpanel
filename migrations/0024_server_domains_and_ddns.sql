-- Migration 0024: Server-Subdomains, eigene Domains und SRV-Records
ALTER TABLE servers ADD COLUMN IF NOT EXISTS subdomain TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS custom_domain TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS srv_record_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_subdomain ON servers (lower(subdomain)) WHERE subdomain IS NOT NULL;
