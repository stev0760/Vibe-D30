#!/usr/bin/env python3
"""Render text to a label and print it on the Phomemo D30 over BLE.

Protocol reverse-engineered by odensc/phomemo-d30-web-bluetooth,
crabdancing/phomemo-d30, and polskafan/phomemo_d30 (see docs/ble.md).
This talks directly to GATT service 0xff00 / characteristic 0xff02 -
no OS-level Bluetooth pairing required.

Defaults to --dry-run: generates and previews the packed bytes without
touching the printer. Pass --live to actually connect and print (uses a
real label).
"""
import argparse
import asyncio

from PIL import Image, ImageDraw, ImageFont

ADDRESS = "XX:XX:XX:XX:XX:XX"
SERVICE_UUID = "0000ff00-0000-1000-8000-00805f9b34fb"
WRITE_CHAR = "0000ff02-0000-1000-8000-00805f9b34fb"
NOTIFY_CHAR = "0000ff03-0000-1000-8000-00805f9b34fb"

DOTS_PER_MM = 8  # ~203 dpi, standard for this class of thermal head
LABEL_WIDTH_MM = 12  # D30's tape width
WIDTH_PX = LABEL_WIDTH_MM * DOTS_PER_MM  # 96px = 12 bytes/row
CHUNK_SIZE = 128


def render_label(text: str, length_mm: int, margin_px: int = 6) -> Image.Image:
    height_px = length_mm * DOTS_PER_MM
    # Canvas is drawn "unrolled": width_px is the tape's narrow dimension,
    # height_px is the length along the tape. Render sideways then rotate,
    # so normal-orientation text reads along the tape's length.
    canvas = Image.new("L", (height_px, WIDTH_PX), color=255)
    draw = ImageDraw.Draw(canvas)

    avail_w = height_px - 2 * margin_px
    avail_h = WIDTH_PX - 2 * margin_px

    # Auto-fit: measure at a reference size, then scale to fit both the
    # available width AND height (whichever is more constraining), rather
    # than guessing a fixed point size. A fixed fraction of WIDTH_PX alone
    # (the old approach) ignores text length and clips longer strings.
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
    y = (WIDTH_PX - th) / 2 - bbox[1]
    draw.text((x, y), text, fill=0, font=font)
    return canvas.rotate(90, expand=True)


def pack_raster(img: Image.Image) -> bytes:
    assert img.width == WIDTH_PX, f"expected width {WIDTH_PX}, got {img.width}"
    width_bytes = WIDTH_PX // 8
    out = bytearray()
    for y in range(img.height):
        for xb in range(width_bytes):
            byte = 0
            for bit in range(8):
                x = xb * 8 + bit
                pixel = img.getpixel((x, y))
                dark = 1 if pixel < 128 else 0
                byte |= dark << (7 - bit)
            out.append(byte)
    return bytes(out)


def build_packet(data: bytes) -> tuple[bytes, bytes]:
    width_bytes = WIDTH_PX // 8
    height_rows = len(data) // width_bytes
    header = bytes(
        [
            0x1B, 0x40,             # ESC @  - initialize
            0x1D, 0x76, 0x30, 0x00,  # GS v 0 m=0 - raster bit image
            width_bytes % 256, width_bytes // 256,
            height_rows % 256, height_rows // 256,
        ]
    )
    footer = bytes([0x1B, 0x64, 0x00])  # ESC d 0 - print & feed
    return header, footer


async def do_print(text: str, length_mm: int):
    from bleak import BleakClient, BleakScanner

    img = render_label(text, length_mm)
    data = pack_raster(img)
    header, footer = build_packet(data)

    # NOTE: this device is Bonded and (by default) Trusted in BlueZ, and it
    # advertises an HID-class UUID, which makes BlueZ auto-reconnect it the
    # instant it starts advertising. A connected peripheral stops
    # advertising, so a discovery scan can spuriously report "not found" if
    # BlueZ's auto-reconnect wins the race. If this happens repeatedly, run
    # `bluetoothctl untrust <mac>` once to stop the auto-reconnect (see
    # docs/ble.md).
    print(f"Scanning for {ADDRESS} ...")
    device = await BleakScanner.find_device_by_address(ADDRESS, timeout=15.0)
    if device is None:
        print("Device not found. Is it powered on / in range?")
        return

    async with BleakClient(device) as client:
        print(f"Connected: {client.is_connected}")

        def on_notify(_sender, payload):
            print(f"[notify] {payload.hex()}")

        try:
            await client.start_notify(NOTIFY_CHAR, on_notify)
        except Exception as e:
            print(f"(no notify subscription: {e})")

        print(f"Writing header: {header.hex()}")
        await client.write_gatt_char(WRITE_CHAR, header, response=True)

        for i in range(0, len(data), CHUNK_SIZE):
            chunk = data[i : i + CHUNK_SIZE]
            await client.write_gatt_char(WRITE_CHAR, chunk, response=True)
            print(f"Sent {min(i + CHUNK_SIZE, len(data))}/{len(data)} bytes")

        print(f"Writing footer: {footer.hex()}")
        await client.write_gatt_char(WRITE_CHAR, footer, response=True)

        await asyncio.sleep(2)  # give the printer a moment to ack/finish


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("text", help="Text to print on the label")
    parser.add_argument(
        "--length-mm", type=int, default=40, help="Label length in mm (default: 40)"
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Actually connect and print. Without this flag, only previews the packed data.",
    )
    args = parser.parse_args()

    img = render_label(args.text, args.length_mm)
    data = pack_raster(img)
    header, footer = build_packet(data)
    print(f"Label canvas: {img.width}x{img.height}px")
    print(f"Packed data: {len(data)} bytes")
    print(f"Header: {header.hex()}")
    print(f"Footer: {footer.hex()}")

    if not args.live:
        print("\nDry run only (pass --live to actually print).")
        return

    asyncio.run(do_print(args.text, args.length_mm))


if __name__ == "__main__":
    main()
