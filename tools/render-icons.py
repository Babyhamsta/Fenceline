#!/usr/bin/env python
"""Rasterize the Fenceline icon to PNG sizes for the extension manifest.

Pure Pillow; mirrors the geometry of extension/icons/fenceline-icon.svg
exactly (viewBox 0..230) and supersamples for crisp anti-aliased edges.
No SVG parser required.

Run: python tools/render-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ICON_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"
VB = 230          # SVG viewBox is 0..230
SS = 16           # supersample factor
SIZES = (16, 32, 48, 128)

INK = (32, 48, 58, 255)       # #20303A
RUST = (182, 69, 44, 255)     # #B6452C
PAPER = (246, 243, 236, 255)  # #F6F3EC


def draw_icon(px: int) -> Image.Image:
    """Render the icon into a px-by-px transparent RGBA image."""
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = px / VB  # viewBox units -> pixels

    def S(v: float) -> float:
        return v * s

    r = S(22)
    # Picket 1 (x0..50): left corners rounded. corners = (TL, TR, BR, BL).
    d.rounded_rectangle([S(0), S(0), S(50), S(230)], radius=r,
                        corners=(True, False, False, True), fill=INK)
    # Pickets 2 and 3: square.
    d.rectangle([S(62), S(0), S(110), S(230)], fill=INK)
    d.rectangle([S(120), S(0), S(168), S(230)], fill=INK)
    # Picket 4 (x180..230): right corners rounded.
    d.rounded_rectangle([S(180), S(0), S(230), S(230)], radius=r,
                        corners=(False, True, True, False), fill=INK)
    # Rust horizontal band (y96..134).
    d.rectangle([S(0), S(96), S(230), S(134)], fill=RUST)
    # Blocked badge: paper ring, rust disc, paper dash.
    d.ellipse([S(115 - 66), S(115 - 66), S(115 + 66), S(115 + 66)], fill=PAPER)
    d.ellipse([S(115 - 52), S(115 - 52), S(115 + 52), S(115 + 52)], fill=RUST)
    d.rounded_rectangle([S(87), S(108.5), S(87 + 56), S(108.5 + 13)],
                        radius=S(6.5), fill=PAPER)
    return img


def main() -> None:
    for size in SIZES:
        big = draw_icon(size * SS)
        out = big.resize((size, size), Image.LANCZOS)
        path = ICON_DIR / f"icon{size}.png"
        out.save(path)
        with Image.open(path) as chk:
            assert chk.size == (size, size), f"{path} wrong size {chk.size}"
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
