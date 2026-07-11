"""Print-position calibration ruler for the D30.

Prints a label with millimeter ticks, numbered every 10mm, and solid
bars on all four edges. Comparing where those land on the physical
die-cut label tells you the printer's start-of-print offset (sign and
magnitude) in one label:

- distance from the label's physical left edge (reading orientation,
  numbers upright) to the "0" edge bar = horizontal offset
- a missing edge bar means that strip of the label is unreachable

This script deliberately does NOT apply d30.protocol.apply_start_offset —
it measures the raw print-start position. Note: that position varies
from print to print depending on where the previous label was torn off,
so there is no stable constant to calibrate; use the web UI's Offset
field + Calibrate button to dial in the current spool state instead.
The first measurement on this unit (2026-07-11) happened to be ~2mm.

Usage:
    .venv/bin/python scripts/calibrate_offset.py             # dry run: writes ruler.png
    .venv/bin/python scripts/calibrate_offset.py --live      # prints one label
    .venv/bin/python scripts/calibrate_offset.py --length-mm 40
"""
import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw, ImageFont

from d30.protocol import DOTS_PER_MM, TAPE_WIDTH_PX, pack_raster
from d30.transport import DEFAULT_ADDRESS, send_raster


def build_ruler(length_mm: int) -> Image.Image:
    w = length_mm * DOTS_PER_MM
    h = TAPE_WIDTH_PX
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)

    # Edge bars: 2px on every side. If one is missing on paper, that side
    # is outside the printable window.
    d.rectangle([0, 0, w - 1, 1], fill=0)          # top
    d.rectangle([0, h - 2, w - 1, h - 1], fill=0)  # bottom
    d.rectangle([0, 0, 1, h - 1], fill=0)          # left
    d.rectangle([w - 2, 0, w - 1, h - 1], fill=0)  # right

    # mm ticks from the left edge: 1mm short, 5mm medium, 10mm long
    for mm in range(0, length_mm + 1):
        x = min(mm * DOTS_PER_MM, w - 1)
        tick = 26 if mm % 10 == 0 else 16 if mm % 5 == 0 else 8
        d.line([x, 2, x, 2 + tick], fill=0)

    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", 22
        )
    except OSError:
        font = ImageFont.load_default()

    # numbers under the 10mm ticks; readable in canvas orientation so the
    # printed label's orientation is unambiguous
    for mm in range(0, length_mm + 1, 10):
        x = mm * DOTS_PER_MM
        label = str(mm)
        bbox = d.textbbox((0, 0), label, font=font)
        tw = bbox[2] - bbox[0]
        tx = min(max(2, x - tw // 2), w - tw - 3)
        d.text((tx, 40), label, fill=0, font=font)

    # arrow pointing left toward 0 so "left" is self-evident on paper
    d.text((8, 68), "<- left/0", fill=0, font=font)
    return img


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--length-mm", type=int, default=40)
    ap.add_argument("--address", default=DEFAULT_ADDRESS)
    ap.add_argument("--live", action="store_true", help="actually print (uses a label)")
    args = ap.parse_args()

    img = build_ruler(args.length_mm)
    out = Path(__file__).parent / "ruler.png"
    img.save(out)
    print(f"ruler image written to {out} ({img.width}x{img.height})")

    data = pack_raster(img.rotate(90, expand=True))
    print(f"packed {len(data)} bytes")
    if not args.live:
        print("dry run only (pass --live to print the calibration label)")
        return
    notes = await send_raster(data, address=args.address)
    print("printed; notifications:", [n.hex() for n in notes])


asyncio.run(main())
