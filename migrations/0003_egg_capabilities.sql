-- Manche Images brauchen einzelne Linux-Rechte zurueck, die das Panel jedem
-- Spielcontainer grundsaetzlich entzieht (CapDrop ALL). Das itzg-Minecraft-
-- Image etwa startet als root, uebergibt die Daten an Benutzer 1000 und
-- wechselt dann dorthin - ohne CHOWN, SETUID und SETGID endet es sofort mit
-- Exit-Code 1.
--
-- Ausserdem erwarten Images ihre Daten an unterschiedlichen Orten:
-- Pterodactyl-Images unter /home/container, itzg unter /data.
--
-- Welche Rechte erlaubt sind, entscheidet NICHT das Egg, sondern die feste
-- Liste in src/eggs/capabilities.ts.

ALTER TABLE eggs ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE eggs ADD COLUMN IF NOT EXISTS data_dir TEXT NOT NULL DEFAULT '/home/container';
