#!/usr/bin/env python3
"""make_icon.py: draws the tile icon (140 x 140, white on transparent): a seat with an arrow backwards and up."""
import os
from PIL import Image, ImageDraw
S = 4                                   # supersampling
W = 140 * S
im = Image.new('RGBA', (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
white = (255, 255, 255, 255)
def p(*xy): return [(x * S, y * S) for x, y in xy]
# backrest (leaning), cushion, base
d.polygon(p((52, 26), (66, 24), (78, 82), (63, 86)), fill=white)
d.rounded_rectangle([60 * S, 84 * S, 112 * S, 98 * S], radius=7 * S, fill=white)
d.ellipse([46 * S, 10 * S, 62 * S, 24 * S], fill=white)          # headrest
d.rectangle([80 * S, 98 * S, 88 * S, 112 * S], fill=white)
d.rounded_rectangle([60 * S, 112 * S, 112 * S, 118 * S], radius=3 * S, fill=white)
# arrow: back (left) and up
d.line(p((40, 106), (16, 106), (16, 84)), fill=white, width=7 * S, joint='curve')
d.polygon(p((16, 70), (6, 86), (26, 86)), fill=white)
out = os.path.join(os.path.dirname(__file__), '..', 'package', 'rhmiData', 'variantGroups', 'Common', 'images', 'easy_entry_icon.png')
im.resize((140, 140), Image.LANCZOS).save(out)
im.resize((140, 140), Image.LANCZOS).save(os.path.join(os.path.dirname(__file__), '..', 'icon.png'))
print('wrote', os.path.normpath(out))
