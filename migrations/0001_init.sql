-- NexusPanel - Grundschema
-- Alle Zeitstempel sind TIMESTAMPTZ und werden intern in UTC gehalten.
-- Umgerechnet wird erst in der Oberflaeche.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- Nutzer
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user'
                CHECK (role IN ('admin', 'moderator', 'user')),
  can_create_servers BOOLEAN NOT NULL DEFAULT false,
  totp_secret   TEXT,
  totp_enabled  BOOLEAN NOT NULL DEFAULT false,
  suspended     BOOLEAN NOT NULL DEFAULT false,
  server_limit  INT NOT NULL DEFAULT 0,
  ram_limit_mb  INT NOT NULL DEFAULT 0,
  disk_limit_mb INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT UNIQUE NOT NULL,
  user_agent    TEXT,
  ip            INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id, expires_at DESC);

-- ----------------------------------------------------------------- Hosts
CREATE TABLE nodes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  fqdn          TEXT NOT NULL,
  docker_socket TEXT NOT NULL DEFAULT '/var/run/docker.sock',
  daemon_token  TEXT,
  ram_total_mb  INT NOT NULL,
  disk_total_mb INT NOT NULL,
  public_ip     INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------- Vorlagen
CREATE TABLE nests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT
);

CREATE TABLE eggs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nest_id        UUID NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  author         TEXT,
  docker_images  JSONB NOT NULL,
  startup        TEXT NOT NULL,
  stop_command   TEXT NOT NULL DEFAULT '^C',
  console_mode   TEXT NOT NULL DEFAULT 'full'
                 CHECK (console_mode IN ('full', 'readonly', 'none')),
  web_interface  JSONB,
  ready_check    JSONB,
  config_files   JSONB,
  config_startup JSONB,
  watchers       JSONB,
  ports          JSONB,
  resources      JSONB,
  install_script TEXT,
  install_image  TEXT,
  features       JSONB,
  raw_egg        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE egg_variables (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  egg_id        UUID NOT NULL REFERENCES eggs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  env_variable  TEXT NOT NULL,
  default_value TEXT,
  rules         TEXT,
  requires      TEXT,
  is_secret     BOOLEAN NOT NULL DEFAULT false,
  user_viewable BOOLEAN NOT NULL DEFAULT true,
  user_editable BOOLEAN NOT NULL DEFAULT true,
  sort_order    INT NOT NULL DEFAULT 0,
  UNIQUE (egg_id, env_variable)
);

-- ------------------------------------------------------------- Instanzen
CREATE TABLE servers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id     TEXT UNIQUE NOT NULL,
  owner_id     UUID NOT NULL REFERENCES users(id),
  node_id      UUID NOT NULL REFERENCES nodes(id),
  egg_id       UUID NOT NULL REFERENCES eggs(id),
  name         TEXT NOT NULL,
  description  TEXT,
  docker_image TEXT NOT NULL,
  startup      TEXT NOT NULL,
  container_id TEXT,
  status       TEXT NOT NULL DEFAULT 'installing'
               CHECK (status IN ('installing', 'install_failed', 'offline', 'starting',
                                 'running', 'stopping', 'crashed', 'suspended')),
  ram_mb       INT NOT NULL,
  swap_mb      INT NOT NULL DEFAULT 0,
  cpu_percent  INT NOT NULL DEFAULT 100,
  disk_mb      INT NOT NULL,
  io_weight    INT NOT NULL DEFAULT 500,
  variables    JSONB NOT NULL DEFAULT '{}',
  auto_restart BOOLEAN NOT NULL DEFAULT true,
  crash_count  INT NOT NULL DEFAULT 0,
  suspended    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_at TIMESTAMPTZ
);
CREATE INDEX ON servers (owner_id);
CREATE INDEX ON servers (node_id, status);

CREATE TABLE allocations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id    UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ip         INET NOT NULL,
  port       INT NOT NULL CHECK (port BETWEEN 1 AND 65535),
  protocol   TEXT NOT NULL DEFAULT 'both' CHECK (protocol IN ('tcp', 'udp', 'both')),
  server_id  UUID REFERENCES servers(id) ON DELETE SET NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  ref        TEXT,
  notes      TEXT,
  blocked_until TIMESTAMPTZ,
  UNIQUE (node_id, ip, port, protocol)
);
CREATE INDEX ON allocations (server_id);
CREATE INDEX ON allocations (node_id, server_id, port);

-- ------------------------------------------------------- Geteilter Zugriff
CREATE TABLE subusers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  invited_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, user_id)
);
CREATE INDEX ON subusers (user_id);

-- ------------------------------------------------------------- Ereignisse
-- Von Tag eins dabei: eine Zeitachse laesst sich nicht rueckwirkend fuellen.
CREATE TABLE events (
  id         BIGSERIAL PRIMARY KEY,
  server_id  UUID REFERENCES servers(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'error')),
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  summary    TEXT NOT NULL,
  payload    JSONB,
  log_file   TEXT,
  log_offset BIGINT
);
CREATE INDEX ON events (server_id, ts DESC);
CREATE INDEX ON events (server_id, kind, ts DESC);

-- Audit-Log ueberlebt geloeschte Server und Nutzer: SET NULL, nie CASCADE.
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  server_id  UUID REFERENCES servers(id) ON DELETE SET NULL,
  actor_name TEXT,
  action     TEXT NOT NULL,
  metadata   JSONB,
  ip         INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (server_id, created_at DESC);
CREATE INDEX ON audit_log (user_id, created_at DESC);
