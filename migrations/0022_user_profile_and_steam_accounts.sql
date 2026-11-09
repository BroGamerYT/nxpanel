-- NexusPanel - Benutzerprofile und Multi-Steam-Accounts mit Team-Sharing
-- 1. Erweiterung der users-Tabelle fuer Avatar und Steam-Verknuepfung
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_name TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_steam_id_idx ON users (steam_id) WHERE steam_id IS NOT NULL;

-- 2. Erweiterung der steam_accounts-Tabelle fuer Mehrbenutzer & Team-Sharing
ALTER TABLE steam_accounts ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE steam_accounts ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
ALTER TABLE steam_accounts ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_steam_accounts_owner ON steam_accounts (owner_id);
CREATE INDEX IF NOT EXISTS idx_steam_accounts_shared ON steam_accounts (is_shared) WHERE is_shared = true;

-- Bestehende Konten (falls vorhanden) dem ersten Admin zuweisen
DO $$
DECLARE
  admin_id UUID;
BEGIN
  SELECT id INTO admin_id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1;
  IF admin_id IS NOT NULL THEN
    UPDATE steam_accounts SET owner_id = admin_id WHERE owner_id IS NULL;
  END IF;
END $$;
