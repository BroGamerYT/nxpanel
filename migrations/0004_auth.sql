-- NexusPanel - Anmeldung und Sitzungen (Phase 3)
-- Idempotent geschrieben: laeuft auch, wenn Teile schon von Hand angelegt wurden.

-- Refresh-Tokens werden nur noch als SHA-256-Hash gespeichert. Wer die
-- Datenbank liest, kann damit keine Sitzung uebernehmen.
-- Bestehende Klartext-Sitzungen gibt es noch keine (Phase 3 ist die erste,
-- die Sitzungen anlegt) - zur Sicherheit werden sie trotzdem beendet.
UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS family_id    UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS replaced_by  UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS rotated_at   TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoke_reason TEXT;

UPDATE sessions SET family_id = id WHERE family_id IS NULL;
ALTER TABLE sessions ALTER COLUMN family_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions (family_id);

-- Anmeldenamen sind ohne Gross-/Kleinschreibung eindeutig.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx    ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

-- Wann wurde das Passwort zuletzt geaendert? Aeltere Sitzungen werden dann ungueltig.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, created_at DESC);
