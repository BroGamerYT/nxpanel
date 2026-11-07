-- Phase 5 Vollendung: Zeitplaene (Schedules) & Dateiversionierung (Revisionen)

-- 1. Zeitplaene fuer Server (Neustart, Backup, Befehl)
CREATE TABLE IF NOT EXISTS server_schedules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id         UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('restart', 'backup', 'command')),
  payload           TEXT, -- z. B. Konsolenbefehl ("say Serverneustart in 5 Min", "save-all")
  cron              TEXT, -- optionaler Cron-String (z. B. "0 4 * * *")
  interval_minutes  INT,  -- Intervall in Minuten (z. B. 60, 360, 720, 1440)
  active            BOOLEAN NOT NULL DEFAULT true,
  last_run_at       TIMESTAMPTZ,
  next_run_at       TIMESTAMPTZ,
  last_status       TEXT DEFAULT 'pending' CHECK (last_status IN ('pending', 'success', 'failed')),
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS server_schedules_server_idx ON server_schedules (server_id);
CREATE INDEX IF NOT EXISTS server_schedules_active_idx ON server_schedules (active, next_run_at);

-- 2. Dateiversionierung (Revisionshistorie fuer Konfigurationen und Spieldateien)
CREATE TABLE IF NOT EXISTS file_revisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  content         TEXT NOT NULL,
  author_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  author_name     TEXT NOT NULL DEFAULT 'System',
  change_summary  TEXT,
  bytes           BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS file_revisions_lookup_idx ON file_revisions (server_id, path, created_at DESC);
