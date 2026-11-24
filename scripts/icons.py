"""Render the PWA icons from the mark (src/ui/Logo.tsx): python3 -I scripts/icons.py. Re-run after changing the mark."""
from PIL import Image, ImageDraw

BG = (10, 13, 17)
INK = (236, 232, 225)
ACCENT = (140, 158, 255)


def mark(size: int, safe: float) -> Image.Image:
    """safe = fraction of the canvas the mark may use (maskable icons keep it inside the 80% safe zone)."""
    s = 4  # supersample, then downscale for clean edges
    W = size * s
    im = Image.new("RGBA", (W, W), BG + (255,))
    d = ImageDraw.Draw(im)
    u = W * safe / 24  # one unit of the 24-unit SVG grid
    o = (W - 24 * u) / 2
    P = lambda x, y: (o + x * u, o + y * u)
    # ring
    r = 9.25 * u
    cx, cy = P(12, 12)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=tuple(int(c * 0.32 + b * 0.68) for c, b in zip(INK, BG)), width=max(1, int(1.5 * u)))
    # level line
    d.line([P(4, 12), P(20, 12)], fill=tuple(int(c * 0.9 + b * 0.1) for c, b in zip(INK, BG)), width=max(1, int(1.6 * u)))
    # chevron (orders converging)
    d.line([P(8, 8.25), P(12, 12), P(8, 15.75)], fill=tuple(int(c * 0.55 + b * 0.45) for c, b in zip(INK, BG)), width=max(1, int(1.4 * u)), joint="curve")
    # the decision: accent dot on the line
    dr = 2.25 * u
    ax, ay = P(16.5, 12)
    d.ellipse([ax - dr, ay - dr, ax + dr, ay + dr], fill=ACCENT)
    return im.resize((size, size), Image.LANCZOS)


def rounded(im: Image.Image, radius: float) -> Image.Image:
    m = Image.new("L", im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius=int(im.size[0] * radius), fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.paste(im, (0, 0), m)
    return out


out = "public/icons"
mark(192, 0.78).save(f"{out}/icon-192.png")
mark(512, 0.78).save(f"{out}/icon-512.png")
mark(512, 0.58).save(f"{out}/maskable-512.png")  # inside the 80% safe circle
mark(180, 0.72).convert("RGB").save(f"{out}/apple-touch-icon.png")  # iOS rounds it itself
rounded(mark(64, 0.86), 0.22).resize((32, 32), Image.LANCZOS).save("public/favicon.ico", sizes=[(32, 32)])
print("icons written")
