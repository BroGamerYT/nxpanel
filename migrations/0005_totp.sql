-- NexusPanel - Zwei-Faktor-Anmeldung (Phase 3b)

-- Geheimnis waehrend der Einrichtung: erst nach dem ersten richtigen Code
-- wird es zum echten totp_secret. So sperrt sich niemand aus, der die
-- Einrichtung abbricht.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
-- Zuletzt benutzter Zeitschritt: derselbe Code geht nur einmal durch.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes (user_id);
