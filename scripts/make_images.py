"""Generate the social preview image and app icons (run once; outputs are committed).

Usage: python scripts/make_images.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "weather_app" / "static" / "img"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def globe(size: int) -> Image.Image:
    """A stylised Earth with a warm El Niño band along the equator."""
    s = size * 4  # draw large, then downsample for smooth edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, s - 1, s - 1], fill=255)

    ocean = Image.new("RGBA", (s, s))
    d = ImageDraw.Draw(ocean)
    for y in range(s):  # deep blue to lighter blue
        t = y / s
        d.line([(0, y), (s, y)], fill=(int(20 + 30 * t), int(70 + 60 * t), int(150 + 50 * t), 255))
    # Warm anomaly band: red/orange, strongest in the east (right).
    band = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    for x in range(s):
        k = x / s
        bd.line([(x, s * 0.43), (x, s * 0.57)], fill=(235, int(110 - 60 * k), 60, int(90 + 150 * k)))
    band = band.filter(ImageFilter.GaussianBlur(s * 0.02))
    ocean.alpha_composite(band)
    # Continents hint (Americas on the right edge).
    ImageDraw.Draw(ocean).ellipse([s * 0.78, s * 0.12, s * 1.1, s * 0.48], fill=(70, 130, 70, 255))
    ImageDraw.Draw(ocean).ellipse([s * 0.82, s * 0.55, s * 1.05, s * 0.95], fill=(70, 130, 70, 255))
    # Soft shading toward the edge.
    shade = Image.new("L", (s, s), 0)
    ImageDraw.Draw(shade).ellipse([s * 0.08, s * 0.05, s * 0.92, s * 0.9], fill=255)
    shade = shade.filter(ImageFilter.GaussianBlur(s * 0.12))
    dark = Image.new("RGBA", (s, s), (0, 5, 20, 160))
    dark.putalpha(Image.eval(shade, lambda v: 160 - v * 160 // 255))
    ocean.alpha_composite(dark)

    img.paste(ocean, (0, 0), mask)
    return img.resize((size, size), Image.LANCZOS)


def icon(size: int, path: Path, pad: float = 0.08) -> None:
    bg = Image.new("RGBA", (size, size), (11, 14, 22, 255))
    g = globe(int(size * (1 - 2 * pad)))
    bg.alpha_composite(g, (int(size * pad), int(size * pad)))
    bg.convert("RGB").save(path, optimize=True)


def social(path: Path) -> None:
    w, h = 1200, 630
    img = Image.new("RGBA", (w, h), (8, 12, 22, 255))
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([700, 40, 1260, 600], fill=(40, 90, 200, 90))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(60)))
    img.alpha_composite(globe(440), (750, 95))
    d = ImageDraw.Draw(img)
    d.text((70, 150), "El Niño Tracker", font=ImageFont.truetype(BOLD, 72), fill=(255, 255, 255))
    d.text((72, 260), "Live El Niño status, Pacific sea", font=ImageFont.truetype(REGULAR, 36), fill=(205, 215, 230))
    d.text((72, 306), "temperatures, world news & videos", font=ImageFont.truetype(REGULAR, 36), fill=(205, 215, 230))
    d.rounded_rectangle([72, 400, 520, 456], radius=28, fill=(217, 58, 58))
    d.text((98, 410), "NOAA data · live satellites", font=ImageFont.truetype(BOLD, 28), fill=(255, 255, 255))
    d.text((72, 540), "Free · updated every 30 minutes", font=ImageFont.truetype(REGULAR, 26), fill=(150, 165, 185))
    img.convert("RGB").save(path, optimize=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    social(OUT / "og-image.png")
    icon(192, OUT / "icon-192.png")
    icon(512, OUT / "icon-512.png")
    icon(180, OUT / "apple-touch-icon.png", pad=0.06)
    icon(48, OUT / "favicon-48.png", pad=0.02)
    print("written to", OUT)
