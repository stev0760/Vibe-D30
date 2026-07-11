# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A from-scratch Linux driver **and local web app (WYSIWYG label editor)**
for the Phomemo D30, a cheap BLE-only thermal label maker whose official
app is Android/iOS only. There is no vendor Linux/USB support at all —
everything here was reverse-engineered by scanning the device directly
and cross-referencing the result against prior open-source work on the
same printer. See `README.md` for status and `docs/hardware.md` /
`docs/ble.md` for the full writeup of how each fact was established.

Device identity (default in `d30/transport.py`, overridable via
`D30_ADDRESS` for the server / `--address` for the CLI): BLE MAC
`XX:XX:XX:XX:XX:XX`, BLE name `D30`. Currently only one 12mm×40mm
die-cut tape is on hand; tape width is parameterized in
`d30/protocol.py` but only 96px/12mm is tested.

## Commands

```
python3 -m venv .venv
.venv/bin/pip install bleak pillow fastapi uvicorn

# Web editor (http://127.0.0.1:8330). D30_DRY_RUN=1 forces every print
# request to dry-run — use it for all UI development.
D30_DRY_RUN=1 .venv/bin/uvicorn server.app:app --port 8330

# CLI. Dry run by default; --live actually prints (consumes a label).
.venv/bin/python -m d30 "Some text" --length-mm 40
.venv/bin/python -m d30 "Some text" --length-mm 40 --live

# Recon scripts (GATT table dump / read-only probe)
.venv/bin/python scripts/gatt_enum.py
.venv/bin/python scripts/gatt_probe.py
```

There is no linter or build step (the web frontend is buildless vanilla
ES modules). The one test is `scripts/ui_check.py`: a Playwright
regression sweep (`.venv/bin/pip install playwright`, chromium already
downloaded) that drives the editor headlessly against a `D30_DRY_RUN=1`
server on port 8330 and checks every v1 feature including dry-run print
header bytes — run it after any UI change (note: it clears the editor's
saved localStorage document). For ad-hoc UI verification, drive the
editor the same way and screenshot the preview strip + check `pageerror`
events; see the honest-preview note under Architecture.

### Before touching the physical device

Do NOT `bluetoothctl disconnect` or `untrust` the printer — the device
should stay bonded + trusted, and BlueZ's auto-connected LE link is the
*preferred* path (see Gotchas; earlier revisions of this file said the
opposite and that advice broke printing for a day). The `d30` transport
attaches to the existing link when there is one and handles the
cold-connect bearer problem with retries. The printer sleeps after a few
idle minutes and stops advertising — if it's not found, it needs its
power button pressed, not more Bluetooth commands. A live print consumes
a physical label; always dry-run first and ask the user before burning
one.

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

**Code layout**: `d30/` is the Python library — `protocol.py` (framing +
1-bpp packing, tape width parameterized), `transport.py` (bleak
scan/connect/chunked-write; best-effort `bluetoothctl disconnect` first,
see Gotchas), `render.py` (PIL text rendering for the CLI), `cli.py`
(`python -m d30`). `server/app.py` (FastAPI) serves `web/` and the API;
`scripts/` keeps the original recon tools. `scripts/print_test.py` is a
deprecated forwarding wrapper kept so docs/ble.md history stays valid.

**Image geometry**: everything is packed at `(label_width_px=96,
label_length_px)`, i.e. 96px (12mm × 8 dots/mm) is the fixed dimension
matching the tape width, and label length is whatever the content needs.
Both render paths draw "unrolled" landscape at `(length_px, 96)` and
rotate 90° at the end — normal-orientation layout first, then into the
printer's raster order. The printer has no "orientation" concept, it
just wants 96px-wide rows.

**Print-start offset**: the print pass starts ~2mm late relative to the
die-cut label's leading edge, so uncompensated output lands toward the
label's left with that much cut off — and the exact amount varies with
spool tension / where the label edge sits, so it's user-tunable. Both
print paths run the landscape image through `apply_start_offset`
(`d30/protocol.py`; positive pads left = shifts content right, negative
crops) right before rotation; extra feed lands in the die-cut gap. The
web UI has an Offset field in the print bar (sent per print, persisted
in localStorage `d30cal` — device calibration, deliberately not part of
the document) and a Calibrate button that prints a client-rendered mm
ruler *with the current offset applied*: when dialed in, the 0 mark
sits on the label's left edge, and any residual error is exactly the
correction to add. Fallbacks: `PRINT_START_OFFSET_MM = 2.0` default,
`D30_OFFSET_MM` server env, `--offset-mm` CLI flag,
`scripts/calibrate_offset.py` (uncompensated ruler, for baseline
measurement). The editor/preview never applies the offset — it maps the
design onto the physical label.

**The client renders; the server packs and prints.** The web editor's
HTML canvas is the single source of truth for pixels: at print time the
browser renders the label at true 1x, forces it to 1-bpp, and POSTs a
PNG to `/api/print`; the server only rotates/packs it (same `d30`
functions as the CLI) and sends BLE. There is deliberately NO
server-side re-render of editor documents — one renderer, no preview
drift. The preview strip in the UI is that same 1x 1-bpp canvas scaled
up pixelated; it is pixel-for-pixel what prints, and it has caught every
layout bug so far — trust it over the pretty zoomed editing canvas.

**Fonts**: browsers can't enumerate system fonts, so the server lists
them via `fc-list` (`/api/fonts`) and serves the binaries
(`/api/fonts/{id}/file`); the client loads each picked font with the
FontFace API under its server id as the family name.

**Auto-fit sizing**: font size is *not* a fixed constant — measured at a
reference size and scaled to the more constraining of height/width
(`render.py` for the CLI; `autoFitFontPx` + the userMoved/centering
logic in `web/js/editor.js` for the editor). Fixed-size approaches
clipped real prints twice (too long for the label; pinned to an edge so
the label's rounded die-cut corner clipped the ink) — don't regress.
Keep at least the 1mm (`AUTO_MARGIN_PX = 8`) safe margin.

**Image/icon elements** carry a cached pre-dithered pure-B/W bitmap at
their current size (`ensureImageBitmap`), so the print canvas's global
threshold pass leaves them untouched — dithering shown in the preview is
exactly what prints. Icons are image elements whose source is an SVG
data-URL (vendored Lucide set in `web/icons.json`), re-rasterized crisply
by the browser at any size.

## Gotchas

- **BlueZ auto-connects this device — that's the good path.** It's
  bonded + trusted and advertises an HID-class UUID, so BlueZ grabs it
  over LE the moment it advertises. Attaching to that existing link
  always works; a *cold* `Device1.Connect()` may pick the classic BR/EDR
  bearer this LE-only printer doesn't have and fail with
  `br-connection-not-supported` (poisoned dual-bearer record — full
  story + storage-level fix in docs/ble.md "bearer selection").
  Never disconnect/untrust/remove the device to "clean up"; that
  destroys the working configuration. `d30/transport.py` `_connect`
  encodes all of this (attach, retry-on-bearer-error).
- **Desktop "D30 is requesting access" authorization prompts (KDE/GNOME)
  must be answered "trust and authorize".** While one sits unanswered,
  the device's pending security request wedges the ATT queue — notify
  subscriptions hang forever and prints appear stuck.
- **The printer sleeps after a few idle minutes** and stops advertising;
  scans then legitimately find nothing. Press its power button — don't
  debug Bluetooth.
- Photos/QR codes of the physical label are in `docs/images/`; the two
  webcam-captured ones are motion-blurred and kept only for reference —
  `IMG_9241.HEIC` (phone camera) is the sharp one everything was actually
  read from, including the QR-encoded MAC/serial.
- `enhanced/` and `.venv/` are gitignored scratch/generated output, not
  part of the actual project.
