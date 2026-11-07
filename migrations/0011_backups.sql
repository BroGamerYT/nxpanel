-- Phase 5: Backups
CREATE TABLE backups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  filename      TEXT NOT NULL,
  bytes         BIGINT NOT NULL DEFAULT 0,
  checksum      TEXT,
  locked        BOOLEAN NOT NULL DEFAULT false,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'completed', 'failed', 'restoring')),
  error         TEXT,
  ignored_files TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX ON backups (server_id, created_at DESC);
