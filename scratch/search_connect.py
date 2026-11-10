import re

with open('/var/lib/panel/volumes/ca7b24f0/game/x64/FarmingSimulator2025Game.exe', 'rb') as f:
    data = f.read()

for m in re.finditer(b'Failed to connect[^\x00]{0,50}', data):
    print(m.start(), m.group())
