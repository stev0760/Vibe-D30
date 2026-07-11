#!/usr/bin/env python3
"""Passive probe: read ff01, subscribe to ff03 notifications, and just
listen for a few seconds without writing anything to ff02. No print
commands are guessed/sent here - this is read-only recon."""
import asyncio

from bleak import BleakClient, BleakScanner

NAME = "D30"  # pass a MAC via argv[1] to pin a unit
FF01 = "0000ff01-0000-1000-8000-00805f9b34fb"
FF03 = "0000ff03-0000-1000-8000-00805f9b34fb"
GENERIC_NAME = "00002a00-0000-1000-8000-00805f9b34fb"


def notify_handler(sender, data):
    print(f"[notify] {sender}: {data.hex()}")


async def main():
    import sys
    if len(sys.argv) > 1:
        device = await BleakScanner.find_device_by_address(sys.argv[1], timeout=15.0)
    else:
        device = await BleakScanner.find_device_by_name(NAME, timeout=15.0)
    if device is None:
        print("Device not found.")
        return

    async with BleakClient(device) as client:
        print(f"Connected: {client.is_connected}")

        try:
            name = await client.read_gatt_char(GENERIC_NAME)
            print(f"Device Name (2a00): {name!r}")
        except Exception as e:
            print(f"2a00 read failed: {e}")

        try:
            val = await client.read_gatt_char(FF01)
            print(f"ff01 raw: {val.hex()}  (len={len(val)})")
            print(f"ff01 ascii guess: {val!r}")
        except Exception as e:
            print(f"ff01 read failed: {e}")

        try:
            await client.start_notify(FF03, notify_handler)
            print("Subscribed to ff03 notifications, listening 8s (no writes sent)...")
            await asyncio.sleep(8)
            await client.stop_notify(FF03)
        except Exception as e:
            print(f"ff03 notify failed: {e}")


if __name__ == "__main__":
    asyncio.run(main())
