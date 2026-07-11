#!/usr/bin/env python3
"""Connect to the D30 over BLE and dump its full GATT table."""
import asyncio
import sys

from bleak import BleakClient, BleakScanner

NAME = "D30"  # pass a MAC via argv[1] to pin a unit


async def main():
    print(f"Scanning for {NAME} ...")
    import sys
    if len(sys.argv) > 1:
        device = await BleakScanner.find_device_by_address(sys.argv[1], timeout=15.0)
    else:
        device = await BleakScanner.find_device_by_name(NAME, timeout=15.0)
    if device is None:
        print("Device not found during scan. Is it powered on / in range?")
        sys.exit(1)
    print(f"Found: {device}")

    async with BleakClient(device) as client:
        print(f"Connected: {client.is_connected}")
        for service in client.services:
            print(f"\n[Service] {service.uuid} ({service.description})")
            for char in service.characteristics:
                props = ",".join(char.properties)
                print(f"  [Char] {char.uuid} handle={char.handle} props={props} ({char.description})")
                for desc in char.descriptors:
                    print(f"    [Desc] {desc.uuid} handle={desc.handle}")


if __name__ == "__main__":
    asyncio.run(main())
