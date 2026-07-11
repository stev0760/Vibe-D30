# Vibe-D30

A from-scratch Linux driver **and WYSIWYG label editor** for the Phomemo
D30, a cheap BLE-only thermal label maker whose official app is
Android/iOS only. Reverse-engineered by scanning the device directly
(see [docs/hardware.md](docs/hardware.md) and [docs/ble.md](docs/ble.md))
and cross-referencing prior open-source work on the same printer —
then vibe-coded into a full label-making app for it.

The printer speaks plain Epson ESC/POS "GS v 0" raster over BLE GATT —
no OS-level Bluetooth pairing at all, which is why it never "pairs" from
any system Bluetooth UI (and why USB shows nothing in `lsusb`: the port
is charge-only). The BlueZ story is more cursed than that one sentence
suggests; [docs/ble.md](docs/ble.md) has the full bearer-selection saga.

## The web editor

```
.venv/bin/uvicorn server.app:app --port 8330
# then open http://127.0.0.1:8330
```

- Freeform label canvas: drag/resize/nudge elements, fit-to-view zoom,
  honest print preview (the strip below the canvas is the true 1-bpp
  render — pixel for pixel what prints)
- **Text** in any installed system font (enumerated via fontconfig,
  loaded into the browser with the FontFace API), auto-fit sizing,
  bold/italic (synthesized in-canvas, so WYSIWYG holds)
- **Images** with Floyd–Steinberg dithering or thresholding
- **Icons**: 1995 searchable Lucide icons, vendored
- **Print-start offset control + calibration**: where the pass starts
  depends on where the previous label was torn off, so the print bar
  has an offset field and a Calibrate button that prints a mm ruler —
  the residual error at the 0 mark is exactly the correction to enter
- Copies, fixed/auto label length, dry-run toggle, document persists in
  localStorage

Set `D30_DRY_RUN=1` on the server to force all prints to dry-run during
development; `D30_ADDRESS=<mac>` to target a different unit.

## The CLI

```
.venv/bin/python -m d30 "Hello World!" --length-mm 40         # dry run
.venv/bin/python -m d30 "Hello World!" --length-mm 40 --live  # print
```

## Setup

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

To run the UI regression sweep (`scripts/ui_check.py`) you additionally
need Playwright: `.venv/bin/pip install playwright && .venv/bin/playwright
install chromium`, then run it against a `D30_DRY_RUN=1` server.

## Status

- [x] Hardware identified: Phomemo D30 (HVIN D30B), FCC ID 2ASRB-D30C
- [x] BLE MAC + serial extracted from the unit's support QR code
- [x] GATT layout mapped; print protocol confirmed against prior art
      and verified on the physical printer
- [x] BlueZ bearer-selection failure modes diagnosed and worked around
      in the transport (docs/ble.md)
- [x] `d30/` Python package: protocol, BLE transport, PIL rendering, CLI
- [x] Local web app: FastAPI server + WYSIWYG editor (text/images/icons)
- [x] Print-start offset control with in-UI ruler calibration
- [ ] QR / barcode elements
- [ ] Template manager (beyond localStorage)
- [ ] Other tape sizes (width is parameterized, only 12mm tested)
- [ ] Decode remaining protocol unknowns (`ff01` contents, notify bytes
      `02b600` / `1a0f0c`) — Android HCI snoop capture planned

## Layout

- `d30/` — Python package: `protocol.py` (ESC/POS framing + raster
  packing + offset compensation), `transport.py` (BLE GATT via bleak,
  BlueZ-gotcha handling), `render.py` (PIL auto-fit text), `cli.py`
- `server/app.py` — FastAPI: serves the editor, enumerates/serves system
  fonts, packs client PNGs and prints them
- `web/` — the editor (buildless vanilla ES modules + canvas)
- `docs/` — hardware/BLE reverse-engineering writeups
- `scripts/` — recon + calibration tools, UI regression sweep

## Device identity

Developed against a Phomemo D30 (HVIN D30B, FCC ID `2ASRB-D30C`,
IC `29002-D30A`), BLE name `D30`. The driver discovers the printer by
that name; pin a specific unit with `--address` / `D30_ADDRESS` (your
unit's MAC is in its support QR code — see
[docs/device-label.md](docs/device-label.md)).

## License & prior art

Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)) — inherited
from [odensc/phomemo-d30-web-bluetooth](https://github.com/odensc/phomemo-d30-web-bluetooth),
the implementation this project's protocol understanding was verified
against. Also consulted:
[polskafan/phomemo_d30](https://github.com/polskafan/phomemo_d30) (MIT)
and [crabdancing/phomemo-d30](https://github.com/crabdancing/phomemo-d30)
(AGPL-3.0, documentation only). Vendored [Lucide](https://lucide.dev)
icons are ISC-licensed (see `web/LUCIDE-LICENSE.txt`).
