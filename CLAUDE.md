# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A from-scratch Linux driver for the Phomemo D30, a cheap BLE-only thermal
label maker whose official app is Android/iOS only. There is no vendor
Linux/USB support at all — everything here was reverse-engineered by
scanning the device directly and cross-referencing the result against
prior open-source work on the same printer. See `README.md` for status
and `docs/hardware.md` / `docs/ble.md` for the full writeup of how each
fact was established.

Device identity (hardcoded as `ADDRESS` at the top of each script):
BLE MAC `XX:XX:XX:XX:XX:XX`, BLE name `D30`. Currently only one 12mm×40mm
tape is on hand, so label dimensions are also hardcoded/CLI-argument
rather than auto-detected.

## Commands

```
python3 -m venv .venv
.venv/bin/pip install bleak pillow

# Dump the device's full GATT service/characteristic table
.venv/bin/python scripts/gatt_enum.py

# Read-only probe: reads ff01, subscribes to ff03 notifications, sends no writes
.venv/bin/python scripts/gatt_probe.py

# Render + pack a label and print it. Defaults to a dry run (prints byte
# sizes/header/footer, touches nothing); --live actually connects and
# prints (consumes a real label)
.venv/bin/python scripts/print_test.py "Some text" --length-mm 40
.venv/bin/python scripts/print_test.py "Some text" --length-mm 40 --live
```

There is no test suite, linter, or build step — this is exploratory
hardware reverse-engineering, not an application with CI.

### Before running any script against the physical device

Check `bluetoothctl info XX:XX:XX:XX:XX:XX | grep Connected` first. If it
says `Connected: yes` without you having connected anything, BlueZ has
auto-reconnected it in the background (see Gotchas below) and a fresh
scan will spuriously fail with "device not found". Run
`bluetoothctl disconnect XX:XX:XX:XX:XX:XX` before retrying.

## Architecture

**Transport**: pure BLE GATT, no OS-level Bluetooth pairing. The device
advertises a classic Serial Port Profile UUID and a Class-of-Device
value, which makes BlueZ's `Device1.Connect()` (i.e. plain
`bluetoothctl connect`) try — and fail — a classic BR/EDR connection
(`br-connection-not-supported`). The official app never does OS-level
pairing at all; it opens a direct GATT connection, which is what every
script here does via `bleak`. Don't try to "pair" this device through
system Bluetooth UI or `bluetoothctl connect` — it will not work and
isn't necessary.

**Relevant GATT layout** (service `0000ff00-...`):
- `ff02` (write / write-without-response) — the only channel print
  commands go out on
- `ff03` (notify) — status/ack bytes come back here (mostly `0101`
  per-chunk acks observed so far; meaning of other values like `02b600`
  and the final `1a0f0c` after a print isn't decoded yet)
- `ff01` (read) — present but not yet decoded

**Print protocol** is standard Epson ESC/POS "GS v 0" raster bit image,
not anything Phomemo-proprietary — confirmed byte-for-byte against
`odensc/phomemo-d30-web-bluetooth` (a Web Bluetooth implementation, which
can only ever speak GATT, never RFCOMM, ruling out any ambiguity about
transport). Full byte layout is in `docs/ble.md`; in short: a 10-byte
header (`ESC @` + `GS v 0` + little-endian width-in-bytes + little-endian
height-in-rows) → raw 1-bpp raster data (MSB-first, 1 = dark/print,
row-major) chunked at ~128 bytes/write → a 3-byte footer (`ESC d 0`).
Other reverse-engineerings of this same printer (`crabdancing/phomemo-d30`,
`polskafan/phomemo_d30`) transport these same bytes over classic RFCOMM
sockets instead of BLE GATT and additionally send an unexplained
proprietary "magic" init sequence (`1f 11 ..`) first; our unit doesn't
answer on RFCOMM at all, and the magic bytes appear unnecessary over
GATT (web-bluetooth implementation skips them and works).

**Image geometry**: canvas is built and packed at `(label_width_px=96,
label_length_px)`, i.e. 96px (12mm × 8 dots/mm) is the fixed dimension
matching the tape width, and label length is whatever the content needs.
`render_label()` in `print_test.py` draws sideways at
`(length_px, 96)` and rotates 90° at the end, purely so normal-orientation
text is easy to lay out with PIL before rotating into the printer's
actual raster order — the printer itself has no separate "orientation"
concept, it just wants `96px`-wide rows.

**Auto-fit sizing**: font size is *not* a fixed constant — it's computed
by measuring the text at a reference size and scaling to whichever of
width/height is more constraining (see `render_label()`). A fixed-size
approach was tried first and clipped longer strings; don't regress to
that.

## Gotchas

- **BlueZ auto-reconnects this device.** It's `Bonded`/`Trusted` and
  advertises an HID-class UUID, which makes BlueZ grab it the instant it
  starts advertising — racing (and sometimes beating) any discovery-based
  scan in these scripts, which then reports a false "not found". Fix by
  disconnecting first, or `bluetoothctl untrust <mac>` once to stop the
  auto-reconnect permanently (the device doesn't need OS trust for GATT
  to work).
- Photos/QR codes of the physical label are in `docs/images/`; the two
  webcam-captured ones are motion-blurred and kept only for reference —
  `IMG_9241.HEIC` (phone camera) is the sharp one everything was actually
  read from, including the QR-encoded MAC/serial.
- `enhanced/` and `.venv/` are gitignored scratch/generated output, not
  part of the actual project.
