-- Zeitlich begrenzte Banns. Minecraft selbst kennt nur dauerhafte Banns;
-- das Panel merkt sich das Ende und hebt den Bann dann per RCON auf.
CREATE TABLE IF NOT EXISTS player_bans (
  id          BIGSERIAL PRIMARY KEY,
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  player      TEXT NOT NULL,
  reason      TEXT,
  until       TIMESTAMPTZ,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS player_bans_due ON player_bans (until) WHERE lifted_at IS NULL AND until IS NOT NULL;
