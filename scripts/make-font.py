#!/usr/bin/env python3
"""
Génère src/font-data.json : police DejaVu Sans (licence libre Bitstream Vera / DejaVu) pré-rendue en niveaux
de gris pour le moteur d'images du bot (src/draw.js), sans aucune dépendance côté Node.
Usage (développement uniquement, nécessite Pillow et les polices DejaVu) :
    python3 scripts/make-font.py
"""
import base64, json, os, zlib
from PIL import Image, ImageDraw, ImageFont

FONTS = {
    'r': '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    'b': '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
}
SIZES = {'r': [13, 15, 18, 22], 'b': [15, 18, 22, 28, 40, 56]}
CHARS = ''.join(chr(c) for c in range(32, 127)) + 'éèêëàâäîïôöûùüçÉÈÊÀÂÎÔÛÇœŒ’‘“”«»…–—−·×→←↑↓€£°±≈≤≥▲▼●○■□✓✗★☆⏱¹²³½'
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'font-data.json')

data = {'license': 'DejaVu Sans — Bitstream Vera / DejaVu fonts license (libre)', 'fonts': {}}
for style, path in FONTS.items():
    for size in SIZES[style]:
        font = ImageFont.truetype(path, size)
        ascent, descent = font.getmetrics()
        glyphs = {}
        blob = bytearray()
        for ch in CHARS:
            try:
                left, top, right, bottom = font.getbbox(ch, anchor='la')
            except Exception:
                continue
            adv = font.getlength(ch)
            w, h = max(0, right - left), max(0, bottom - top)
            if w and h:
                img = Image.new('L', (w, h), 0)
                ImageDraw.Draw(img).text((-left, -top), ch, font=font, fill=255, anchor='la')
                px = img.tobytes()
            else:
                px = b''
            glyphs[ch] = [round(adv, 2), left, top, w, h, len(blob)]
            blob += px
        data['fonts'][f'{style}{size}'] = {
            'size': size, 'ascent': ascent, 'descent': descent, 'glyphs': glyphs,
            'atlas': base64.b64encode(zlib.compress(bytes(blob), 9)).decode('ascii'),
        }

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
print(f'{OUT} : {os.path.getsize(OUT) // 1024} Ko, polices {", ".join(data["fonts"])}')
