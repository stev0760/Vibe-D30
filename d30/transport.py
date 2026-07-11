"""BLE transport for the D30: direct GATT, no OS-level pairing.

The device advertises misleading classic-Bluetooth bits; only GATT works.
See docs/ble.md for the full story, including the BlueZ auto-reconnect
race this module works around by disconnecting any stale BlueZ-owned
connection before scanning.
"""

import asyncio

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakDBusError

from .protocol import CHUNK_SIZE, TAPE_WIDTH_PX, build_packet

DEFAULT_ADDRESS = "XX:XX:XX:XX:XX:XX"
SERVICE_UUID = "0000ff00-0000-1000-8000-00805f9b34fb"
WRITE_CHAR = "0000ff02-0000-1000-8000-00805f9b34fb"
NOTIFY_CHAR = "0000ff03-0000-1000-8000-00805f9b34fb"

# BlueZ picks this D-Bus error when Device1.Connect() chooses the classic
# BR/EDR bearer — which this LE-only printer doesn't have. It happens when
# the stored device record steers bearer selection wrong (derived classic
# link key, LastUsedBearer=bredr); see docs/ble.md "bearer selection".
_BREDR_ERROR = "br-connection-not-supported"


class PrinterNotFound(Exception):
    pass


async def _connect(address: str, scan_timeout: float) -> BleakClient:
    """Find the printer and return a connected client.

    Never disconnect the device from BlueZ first: if BlueZ auto-connected it
    (bonded + trusted), that LE link is a *good* thing — bleak attaches to it
    directly, sidestepping BlueZ's broken bearer selection for this device
    (a fresh Connect() may try classic BR/EDR and fail; the printer is
    LE-only). bleak's scanner returns BlueZ-cached devices too, so the
    printer is found even while connected and not advertising.

    On the BR/EDR bearer error, wait and retry: BlueZ's own auto-connect
    usually grabs the LE link within a few seconds of the device advertising,
    and attaching to an existing link always works.
    """
    last_error: Exception | None = None
    for attempt in range(3):
        device = await BleakScanner.find_device_by_address(address, timeout=scan_timeout)
        if device is None:
            raise PrinterNotFound(
                f"{address} not found. Is the printer awake and in range? "
                "It sleeps after a few idle minutes — press its power button."
            )
        client = BleakClient(device)
        try:
            await client.connect()
            return client
        except BleakDBusError as e:
            if _BREDR_ERROR not in str(e):
                raise
            last_error = e
            await asyncio.sleep(3)  # let BlueZ auto-connect win, then attach
    raise PrinterNotFound(
        f"{address} found, but BlueZ keeps trying the classic Bluetooth "
        f"bearer this LE-only printer doesn't have ({_BREDR_ERROR}). "
        "Fix the stored device record: see docs/ble.md 'bearer selection'."
    ) from last_error


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

    client = await _connect(address, scan_timeout)
    try:
        def on_notify(_sender, payload: bytearray):
            notifications.append(bytes(payload))

        # Notifications are informative, not required to print. The timeout
        # matters: with a desktop authorization dialog pending for this
        # device, the CCCD write blocks indefinitely (see docs/ble.md).
        try:
            await asyncio.wait_for(client.start_notify(NOTIFY_CHAR, on_notify), 5)
        except Exception:
            pass

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
    finally:
        await client.disconnect()

    return notifications
