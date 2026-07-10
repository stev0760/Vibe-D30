"""PIL-based label rendering for the CLI (the web editor renders client-side)."""

from PIL import Image, ImageDraw, ImageFont

from .protocol import DOTS_PER_MM, TAPE_WIDTH_PX


def render_label(
    text: str,
    length_mm: int,
    width_px: int = TAPE_WIDTH_PX,
    margin_px: int = 6,
) -> Image.Image:
    """Render auto-fit text into tape raster order (width_px wide rows).

    The canvas is drawn "unrolled" (length along x, tape width along y) so
    normal-orientation text is easy to lay out, then rotated 90 degrees into
    the printer's raster order at the end.
    """
    height_px = length_mm * DOTS_PER_MM
    canvas = Image.new("L", (height_px, width_px), color=255)
    draw = ImageDraw.Draw(canvas)

    avail_w = height_px - 2 * margin_px
    avail_h = width_px - 2 * margin_px

    # Auto-fit: measure at a reference size, then scale to fit both the
    # available width AND height (whichever is more constraining). A fixed
    # point size clips longer strings.
    ref_size = 100
    try:
        ref_font = ImageFont.truetype("DejaVuSans-Bold.ttf", size=ref_size)
    except OSError:
        ref_font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), text, font=ref_font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    scale = min(avail_w / tw, avail_h / th)
    font_size = max(1, int(ref_size * scale))

    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", size=font_size)
    except OSError:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (height_px - tw) / 2 - bbox[0]
    y = (width_px - th) / 2 - bbox[1]
    draw.text((x, y), text, fill=0, font=font)
    return canvas.rotate(90, expand=True)
