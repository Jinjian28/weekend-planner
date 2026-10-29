"""App icon: indigo night sky, orange setting sun, white mountain ridges (full-bleed; iOS rounds corners)."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)
S = 2048  # supersampled


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def gradient(c1, c2):
    strip = Image.new("RGB", (1, 256))
    for y in range(256):
        strip.putpixel((0, y), lerp(c1, c2, y / 255))
    g = strip.resize((S * 2, S * 2), Image.BICUBIC).rotate(35, resample=Image.BICUBIC)
    return g.crop((S // 2, S // 2, S // 2 + S, S // 2 + S)).convert("RGBA")


base = gradient((30, 27, 75), (79, 70, 229))
layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(layer)
sx, sy, sr = int(S * 0.64), int(S * 0.40), int(S * 0.12)
d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=(251, 146, 60, 255))
d.polygon([(0, int(S * 0.72)), (int(S * 0.26), int(S * 0.50)), (int(S * 0.44), int(S * 0.64)), (int(S * 0.70), int(S * 0.44)), (S, int(S * 0.70)), (S, S), (0, S)], fill=(255, 255, 255, 110))
d.polygon([(0, int(S * 0.86)), (int(S * 0.32), int(S * 0.58)), (int(S * 0.52), int(S * 0.76)), (int(S * 0.74), int(S * 0.62)), (S, int(S * 0.84)), (S, S), (0, S)], fill=(255, 255, 255, 255))
final = Image.alpha_composite(base, layer).convert("RGB")

for name, size in [("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)]:
    im = final.resize((size, size), Image.LANCZOS)
    im = im.quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.FLOYDSTEINBERG)
    im.save(os.path.join(OUT, name), optimize=True)
print("icons ok:", sorted(os.listdir(OUT)))
