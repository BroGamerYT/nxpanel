-- Favoriten & Tags je Server fuer schnelle Gruppierung, Suche und Befehlspalette (Strg+K)
ALTER TABLE servers ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT false;
