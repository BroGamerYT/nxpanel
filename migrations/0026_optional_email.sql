-- E-Mail-Adresse fuer Benutzer optional machen
-- PostgreSQL UNIQUE Constraints erlauben standardmaessig mehrere NULL-Werte.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
