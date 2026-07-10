"""BLE transport for the D30: direct GATT, no OS-level pairing.

The device advertises misleading classic-Bluetooth bits; only GATT works.
See docs/ble.md for the full story, including the BlueZ auto-reconnect
race this module works around by disconnecting any stale BlueZ-owned
connection before scanning.
"""

import asyncio
import subprocess
import sys

from bleak import BleakClient, BleakScanner

from .protocol import CHUNK_SIZE, TAPE_WIDTH_PX, build_packet

DEFAULT_ADDRESS = "XX:XX:XX:XX:XX:XX"
SERVICE_UUID = "0000ff00-0000-1000-8000-00805f9b34fb"
WRITE_CHAR = "0000ff02-0000-1000-8000-00805f9b34fb"
NOTIFY_CHAR = "0000ff03-0000-1000-8000-00805f9b34fb"


class PrinterNotFound(Exception):
    pass


def _ensure_disconnected(address: str) -> None:
    """Best-effort: free the device from a stale BlueZ-owned connection.

    BlueZ auto-reconnects this device (bonded + HID-class UUID) the moment
    it advertises, which stops it advertising and starves our scan. A
    connected-then-freed device resumes advertising within a beacon or two.
    """
    if not sys.platform.startswith("linux"):
        return
    try:
        subprocess.run(
            ["bluetoothctl", "disconnect", address],
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


async def send_raster(
    data: bytes,
    width_px: int = TAPE_WIDTH_PX,
    address: str = DEFAULT_ADDRESS,
    copies: int = 1,
    scan_timeout: float = 15.0,
    progress=None,
) -> list[bytes]:
    """Print packed 1-bpp raster `data`; return notify payloads observed.

    `progress`, if given, is called as progress(sent_bytes, total_bytes)
    after each chunk.
    """
    header, footer = build_packet(data, width_px)
    notifications: list[bytes] = []

    _ensure_disconnected(address)

    device = await BleakScanner.find_device_by_address(address, timeout=scan_timeout)
    if device is None:
        raise PrinterNotFound(
            f"{address} not found. Is the printer on and in range? "
            "If bluetoothctl shows it Connected, see docs/ble.md."
        )

    async with BleakClient(device) as client:
        def on_notify(_sender, payload: bytearray):
            notifications.append(bytes(payload))

        try:
            await client.start_notify(NOTIFY_CHAR, on_notify)
        except Exception:
            pass  # notifications are informative, not required to print

        for _ in range(copies):
            await client.write_gatt_char(WRITE_CHAR, header, response=True)
            for i in range(0, len(data), CHUNK_SIZE):
                await client.write_gatt_char(
                    WRITE_CHAR, data[i : i + CHUNK_SIZE], response=True
                )
                if progress:
                    progress(min(i + CHUNK_SIZE, len(data)), len(data))
            await client.write_gatt_char(WRITE_CHAR, footer, response=True)

        await asyncio.sleep(2)  # let the printer finish/ack before dropping BLE

    return notifications
