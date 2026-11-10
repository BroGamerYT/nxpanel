-- Host-Schicht (M1): die nodes-Tabelle wird zum Host.
--
-- Der Plan in docs/ARCHITEKTUR.md (Abschnitt 3) nennt die Tabelle "hosts".
-- Das Panel fuehrt sie seit jeher als "nodes" - deshalb wird sie hier
-- erweitert statt eine zweite, parallele Tabelle anzulegen. Zwei Tabellen
-- fuer denselben Begriff wuerden jede Zuordnung doppelt buchen.
--
-- Bestandsdaten bleiben unangetastet: type ist per Default 'local', der
-- vorhandene lokale Node funktioniert danach genau wie vorher.

ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'local'
    CHECK (type IN ('local', 'core')),
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS runtime TEXT NOT NULL DEFAULT 'docker'
    CHECK (runtime IN ('docker', 'podman', 'windows-native', 'mock')),
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'online'
    CHECK (status IN ('online', 'offline', 'unreachable', 'unknown')),
  ADD COLUMN IF NOT EXISTS cert_fingerprint TEXT,
  -- Das Token des Cores verschluesselt (AES-256-GCM, src/crypto.ts).
  -- Niemals im Klartext, niemals in einer API-Antwort, niemals im Log.
  ADD COLUMN IF NOT EXISTS token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ram_used_mb INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disk_used_mb INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cpu_percent NUMERIC(5, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS nodes_type_idx ON nodes (type);

-- Welche Laufzeit ein Server nutzt (docker, podman, windows-native).
-- Heute laufen alle Server ueber Docker; der Wert wird bei einem Server
-- auf einem Windows-Core auf 'windows-native' gesetzt.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS runtime TEXT NOT NULL DEFAULT 'docker'
    CHECK (runtime IN ('docker', 'podman', 'windows-native', 'mock'));
