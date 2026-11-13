"""Baut deploy/windows/nexuscore.ico aus den PNG-Symbolen des Projekts (web/public/branding).

Aufruf (aus dem Ordner nexuscore):  python scripts/make-icon.py
Die .ico enthaelt die PNG-Bilder unveraendert (ab Windows Vista erlaubt), es braucht keine Zusatzprogramme.
"""
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
BRANDING = os.path.normpath(os.path.join(HERE, '..', '..', 'web', 'public', 'branding'))
OUT = os.path.normpath(os.path.join(HERE, '..', 'deploy', 'windows', 'nexuscore.ico'))
SIZES = [32, 64, 128, 256]

images = []
for size in SIZES:
    with open(os.path.join(BRANDING, f'icon-{size}.png'), 'rb') as f:
        data = f.read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', f'icon-{size}.png ist kein PNG'
    w, h = struct.unpack('>II', data[16:24])
    assert (w, h) == (size, size), f'icon-{size}.png hat {w}x{h}'
    images.append((size, data))

header = struct.pack('<HHH', 0, 1, len(images))
offset = 6 + 16 * len(images)
entries = b''
blobs = b''
for size, data in images:
    dim = 0 if size >= 256 else size  # 0 bedeutet 256
    entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
    blobs += data
    offset += len(data)

with open(OUT, 'wb') as f:
    f.write(header + entries + blobs)
print(f'{OUT}: {len(images)} Groessen, {os.path.getsize(OUT)} Bytes')
