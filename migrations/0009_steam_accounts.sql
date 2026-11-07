-- Dampf ablassen: Steam-Konten zentral im Panel hinterlegen.
-- Passwoerter liegen AES-256-GCM verschluesselt in der Datenbank (src/crypto.ts),
-- genau wie TOTP-Geheimnisse.
CREATE TABLE IF NOT EXISTS steam_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_name TEXT NOT NULL UNIQUE,
  encrypted_password TEXT,
  steam_id TEXT,
  guard_status TEXT NOT NULL DEFAULT 'none' CHECK (guard_status IN ('none', 'needed', 'ok', 'failed')),
  guard_type TEXT NOT NULL DEFAULT 'none' CHECK (guard_type IN ('none', 'email', 'app')),
  guard_code TEXT,
  guard_prompt TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_steam_accounts_name ON steam_accounts (account_name);
