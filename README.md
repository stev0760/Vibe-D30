# Reversing the Phomemo D30 Mini Label Maker

Goal: get this cheap BLE thermal label printer working from Linux. The
official app is Android/iOS only and communicates over Bluetooth Low
Energy (not classic Bluetooth), which is why it never showed up in
`lsusb` (USB is charge-only) and never appeared as a normal "pairing"
target in a phone or desktop Bluetooth settings UI.

## Status

- [x] Identified hardware: Phomemo "Smart Mini Label Maker", Model
      **D30**, HVIN D30B (see [docs/hardware.md](docs/hardware.md))
- [x] Extracted BLE MAC address and serial number from the unit's
      support QR code
- [x] Connected over BLE from Linux with no classic pairing required
      and enumerated the full GATT table (see [docs/ble.md](docs/ble.md))
- [x] Confirmed working end-to-end print from Linux via BLE
      (`scripts/print_test.py --live` — see [docs/ble.md](docs/ble.md))
- [ ] Capture the official app's actual print traffic (Android HCI
      snoop log) to double check edge cases (barcodes, images, the
      unexplained `1f 11 ..` "magic" init bytes other implementations send)
- [ ] Turn `print_test.py` into a general-purpose Linux CLI tool
      (images/barcodes, not just auto-fit text)

## Layout

- `docs/hardware.md` — physical label, FCC ID, regulatory info
- `docs/ble.md` — BLE advertisement data and GATT service/characteristic map
- `docs/images/` — reference photos of the device label/QR code
- `scripts/` — probing and (eventually) protocol scripts
- `.venv/` — local Python virtualenv (bleak, etc. — not committed)

## Device identity

- Model: Phomemo D30 (HVIN D30B)
- BLE name: `D30`
- BLE MAC: `XX:XX:XX:XX:XX:XX`
- FCC ID: `2ASRB-D30C`
- Serial: `XXXXXXXXXXXXXXX`

## Setup

```
python3 -m venv .venv
.venv/bin/pip install bleak
.venv/bin/python scripts/gatt_enum.py
```
