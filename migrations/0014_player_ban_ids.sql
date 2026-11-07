-- Spiele wie ARK oder Palworld bannen ueber eine ID (EOS/Steam), nicht ueber den Namen.
ALTER TABLE player_bans ADD COLUMN IF NOT EXISTS player_id TEXT;
