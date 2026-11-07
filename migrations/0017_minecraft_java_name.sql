-- "Minecraft Paper" kann laengst alle Java-Servertypen (Vanilla, Fabric, Forge,
-- NeoForge, Purpur ...). Der Name fuehrte in die Irre: umbenennen.
-- Mitgelieferte Eggs werden ueber den Namen erkannt - deshalb hier und nicht
-- nur in der Egg-Datei, sonst gaebe es nach dem Update zwei Minecraft-Eggs.
UPDATE eggs SET name = 'Minecraft Java'
WHERE name = 'Minecraft Paper'
  AND NOT EXISTS (SELECT 1 FROM eggs WHERE name = 'Minecraft Java');

-- Erlaubte Spiele, die das Egg beim Namen nennen, mitziehen.
UPDATE users
SET allowed_eggs = (
  SELECT jsonb_agg(CASE WHEN x = '"Minecraft Paper"'::jsonb THEN '"Minecraft Java"'::jsonb ELSE x END)
  FROM jsonb_array_elements(allowed_eggs) AS x
)
WHERE jsonb_typeof(allowed_eggs) = 'array' AND allowed_eggs @> '["Minecraft Paper"]'::jsonb;
