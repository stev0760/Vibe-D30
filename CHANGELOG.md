# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Semantic versioning: `d30.__version__` as single source of truth, surfaced
  via `FastAPI(version=)`, the `/api/printer/status` response, the editor's
  header status line, and `python -m d30 --version`.

## [0.9.0] - 2026-07-17

Everything to date — the working v1 core, reverse-engineered from scratch:

### Added
- Phomemo D30 protocol reverse-engineering: BLE-only GATT transport
  (service `ff00`, write `ff02`, notify `ff03`), ESC/POS "GS v 0" raster
  protocol confirmed byte-for-byte against prior art; full writeup in
  `docs/ble.md` and `docs/hardware.md`.
- `d30/` Python package: framing + 1-bpp packing (`protocol.py`), bleak
  scan/connect/chunked-write transport with BlueZ bearer-selection
  workarounds (`transport.py`), PIL text rendering (`render.py`), CLI
  (`python -m d30`, dry-run by default).
- Local web app: FastAPI server (`server/app.py`) + buildless WYSIWYG label
  editor (`web/`) — text (system fonts via fontconfig, auto-fit sizing, faux
  bold/italic), images (Floyd–Steinberg dither / threshold), 1995 vendored
  Lucide icons; honest pixel-exact 1-bpp print preview; the client renders,
  the server packs and prints.
- Print-start offset control with in-UI mm-ruler calibration, persisted as
  device calibration (`d30cal`) separate from the document.
- Playwright regression sweep (`scripts/ui_check.py`) covering every v1
  feature including exact dry-run print header bytes.

[Unreleased]: https://github.com/stev0760/Vibe-D30/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/stev0760/Vibe-D30/releases/tag/v0.9.0
