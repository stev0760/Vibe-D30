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

# The print pass starts ~2mm late relative to the die-cut label's leading
# edge, so unshifted output lands toward the label's left (reading
# orientation) with the leftmost content cut off. The exact amount varies
# with spool tension and where the label edge sits, so this is only a
# default — the web UI exposes a per-print offset (persisted client-side)
# and prints a calibration ruler to dial it in. Baseline measured with
# scripts/calibrate_offset.py on 12x40mm die-cut tape (2026-07-11).
PRINT_START_OFFSET_MM = 2.0


def apply_start_offset(
    img: Image.Image, offset_mm: float = PRINT_START_OFFSET_MM
) -> Image.Image:
    """Shift a landscape label image right (pad) or left (crop) by offset_mm.

    Print-time compensation for the print-start position: positive offsets
    pad blank columns on the left, shifting content toward the label's
    right; negative offsets crop, shifting it left. Editors/previews should
    NOT apply this — it maps the designed label onto the physical one.
    """
    px = round(offset_mm * DOTS_PER_MM)
    if px == 0:
        return img
    if px > 0:
        out = Image.new("L", (img.width + px, img.height), 255)
        out.paste(img.convert("L"), (px, 0))
        return out
    return img.crop((min(-px, img.width - 1), 0, img.width, img.height))


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
