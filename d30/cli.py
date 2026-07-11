"""CLI: render text and print it on the D30. Dry-run by default."""

import argparse
import asyncio

from .protocol import build_packet, pack_raster
from .render import render_label
from .transport import DEFAULT_ADDRESS, DEVICE_NAME, PrinterNotFound, send_raster


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="d30",
        description="Print a text label on a Phomemo D30 over BLE.",
    )
    parser.add_argument("text", help="Text to print on the label")
    parser.add_argument(
        "--length-mm", type=int, default=40, help="Label length in mm (default: 40)"
    )
    parser.add_argument(
        "--address",
        default=DEFAULT_ADDRESS,
        help=f"Printer BLE MAC address (default: discover by name {DEVICE_NAME!r})",
    )
    parser.add_argument("--copies", type=int, default=1)
    parser.add_argument(
        "--offset-mm",
        type=float,
        default=None,
        help="Print-start offset in mm (default: calibrated constant; "
        "positive shifts content toward the label's right)",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Actually connect and print. Default is a dry run.",
    )
    args = parser.parse_args(argv)

    img = render_label(args.text, args.length_mm, offset_mm=args.offset_mm)
    data = pack_raster(img)
    header, footer = build_packet(data)
    print(f"Label canvas: {img.width}x{img.height}px")
    print(f"Packed data: {len(data)} bytes")
    print(f"Header: {header.hex()}")
    print(f"Footer: {footer.hex()}")

    if not args.live:
        print("\nDry run only (pass --live to actually print).")
        return 0

    def progress(sent, total):
        print(f"Sent {sent}/{total} bytes")

    try:
        notes = asyncio.run(
            send_raster(
                data,
                address=args.address,
                copies=args.copies,
                progress=progress,
            )
        )
    except PrinterNotFound as e:
        print(e)
        return 1
    print(f"Notifications: {[n.hex() for n in notes]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
