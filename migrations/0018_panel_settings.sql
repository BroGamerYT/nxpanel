-- Panel-weite Einstellungen (z. B. CurseForge-API-Schluessel fuer die Modpack-Suche).
-- Geheime Werte liegen verschluesselt (src/crypto.ts), nie im Klartext.
CREATE TABLE IF NOT EXISTS panel_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  encrypted   boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
