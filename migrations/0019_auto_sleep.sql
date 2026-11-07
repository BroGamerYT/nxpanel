-- Auto-Sleep: Server bei Leerlauf automatisch stoppen, um Ressourcen zu schonen
ALTER TABLE servers ADD COLUMN IF NOT EXISTS auto_sleep_minutes INT NOT NULL DEFAULT 0;
