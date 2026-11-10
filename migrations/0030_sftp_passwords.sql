-- Eigene SFTP-Passwoerter (App-Passwoerter). SFTP kann keinen zweiten Faktor
-- abfragen; Konten mit Zwei-Faktor-Schutz melden sich per SFTP deshalb nur
-- mit einem solchen Passwort an. Gespeichert wird nur der Hash.
CREATE TABLE IF NOT EXISTS sftp_passwords (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sftp_passwords_user ON sftp_passwords(user_id);
