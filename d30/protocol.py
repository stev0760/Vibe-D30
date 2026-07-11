"""Byte-level print protocol: standard Epson ESC/POS "GS v 0" raster image.

Confirmed working against a real D30 (see docs/ble.md). The printer wants:
header -> raw 1-bpp raster rows (width_bytes per row, MSB first, 1 = dark)
-> footer, all written to GATT characteristic ff02.
"""

from PIL import Image

DOTS_PER_MM = 8  # ~203 dpi, standard for this class of thermal head
TAPE_WIDTH_MM = 12  # the D30's tape; parameterized so other sizes can follow
TAPE_WIDTH_PX = TAPE_WIDTH_MM * DOTS_PER_MM  # 96px = 12 bytes/row
CHUNK_SIZE = 128  # bytes per BLE write; transport-friendliness, not protocol

# The firmware starts its print pass ~2mm late relative to the die-cut
# label's leading edge, so unshifted output lands 2mm toward the label's
# left (reading orientation) with the leftmost content cut off. Measured
# with scripts/calibrate_offset.py on 12x40mm die-cut tape (2026-07-11);
# the label has spare room on the right, so compensating is lossless.
PRINT_START_OFFSET_MM = 2.0


def apply_start_offset(
    img: Image.Image, offset_mm: float = PRINT_START_OFFSET_MM
) -> Image.Image:
    """Pad blank columns on the left of a landscape label image.

    Print-time compensation for the firmware's late print start: content
    shifts right on the physical label; the extra feed at the end of the
    pass lands in the die-cut gap. Editors/previews should NOT apply this —
    it maps the designed label onto the physical one.
    """
    px = round(offset_mm * DOTS_PER_MM)
    if px <= 0:
        return img
    out = Image.new("L", (img.width + px, img.height), 255)
    out.paste(img.convert("L"), (px, 0))
    return out


def pack_raster(img: Image.Image, width_px: int = TAPE_WIDTH_PX) -> bytes:
    """Pack a PIL image (mode-agnostic, thresholded at 128) into 1-bpp rows.

    The image's width must equal the tape width in pixels; its height is the
    label length in rows (i.e. already rotated into tape raster order).
    """
    assert img.width == width_px, f"expected width {width_px}, got {img.width}"
    if img.mode != "L":
        img = img.convert("L")
    width_bytes = width_px // 8
    out = bytearray()
    for y in range(img.height):
        for xb in range(width_bytes):
            byte = 0
            for bit in range(8):
                x = xb * 8 + bit
                dark = 1 if img.getpixel((x, y)) < 128 else 0
                byte |= dark << (7 - bit)
            out.append(byte)
    return bytes(out)


def build_packet(data: bytes, width_px: int = TAPE_WIDTH_PX) -> tuple[bytes, bytes]:
    """Return (header, footer) framing for packed raster `data`."""
    width_bytes = width_px // 8
    height_rows = len(data) // width_bytes
    header = bytes(
        [
            0x1B, 0x40,              # ESC @  - initialize
            0x1D, 0x76, 0x30, 0x00,  # GS v 0 m=0 - raster bit image
            width_bytes % 256, width_bytes // 256,
            height_rows % 256, height_rows // 256,
        ]
    )
    footer = bytes([0x1B, 0x64, 0x00])  # ESC d 0 - print & feed
    return header, footer
