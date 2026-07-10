"""Local web app for the D30: serves the editor UI and the print API.

Run:  .venv/bin/uvicorn server.app:app --port 8330
Env:  D30_DRY_RUN=1 forces every print request to dry-run (dev mode),
      D30_ADDRESS overrides the printer MAC.

The browser does all label rendering (see web/); this server only
enumerates/serves fonts, packs the client's PNG into printer raster
bytes, and talks BLE via the d30 package.
"""

import asyncio
import base64
import io
import os
import re
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from d30.protocol import TAPE_WIDTH_PX, build_packet, pack_raster  # noqa: E402
from d30.transport import DEFAULT_ADDRESS, PrinterNotFound, send_raster  # noqa: E402

from PIL import Image  # noqa: E402

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
ADDRESS = os.environ.get("D30_ADDRESS", DEFAULT_ADDRESS)
FORCE_DRY_RUN = os.environ.get("D30_DRY_RUN", "") not in ("", "0")

FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".woff", ".woff2"}
FONT_MEDIA_TYPES = {
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".ttc": "font/collection",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

app = FastAPI(title="D30 Labeler")

_print_lock = asyncio.Lock()
_last_print: dict = {"ok": None, "detail": "no prints yet"}


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _enumerate_fonts() -> dict[str, dict]:
    """id -> {family, style, file} from fontconfig, browser-loadable only."""
    try:
        out = subprocess.run(
            ["fc-list", "--format", "%{family[0]}\t%{style[0]}\t%{file}\n"],
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    fonts: dict[str, dict] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        family, style, file = parts
        path = Path(file)
        if path.suffix.lower() not in FONT_EXTENSIONS:
            continue
        font_id = _slugify(f"{family} {style}")
        if not font_id or font_id in fonts:
            continue
        fonts[font_id] = {"family": family, "style": style, "file": str(path)}
    return fonts


FONTS = _enumerate_fonts()


class PrintRequest(BaseModel):
    png: str  # base64, landscape length x 96
    copies: int = 1
    dryRun: bool = False


@app.get("/api/fonts")
def list_fonts():
    return [
        {"id": fid, "family": f["family"], "style": f["style"]}
        for fid, f in sorted(FONTS.items(), key=lambda kv: (kv[1]["family"], kv[1]["style"]))
    ]


@app.get("/api/fonts/{font_id}/file")
def font_file(font_id: str):
    font = FONTS.get(font_id)
    if font is None:
        raise HTTPException(404, "unknown font id")
    path = Path(font["file"])
    media = FONT_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media)


@app.get("/api/printer/status")
def printer_status():
    connected = None
    if sys.platform.startswith("linux"):
        try:
            out = subprocess.run(
                ["bluetoothctl", "info", ADDRESS],
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout
            connected = "Connected: yes" in out
        except (OSError, subprocess.TimeoutExpired):
            pass
    return {
        "address": ADDRESS,
        "bluezConnected": connected,
        "forceDryRun": FORCE_DRY_RUN,
        "lastPrint": _last_print,
    }


@app.post("/api/print")
async def print_label(req: PrintRequest):
    global _last_print
    try:
        raw = base64.b64decode(req.png)
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception:
        raise HTTPException(400, "invalid PNG payload")

    if img.height != TAPE_WIDTH_PX:
        raise HTTPException(
            400, f"expected a {TAPE_WIDTH_PX}px-tall landscape image, got {img.width}x{img.height}"
        )
    copies = max(1, min(req.copies, 10))

    # Same transform as the CLI path: unrolled landscape -> tape raster order.
    raster_img = img.convert("L").rotate(90, expand=True)
    data = pack_raster(raster_img)
    header, footer = build_packet(data)

    result = {
        "widthPx": img.width,
        "heightPx": img.height,
        "packedBytes": len(data),
        "header": header.hex(),
        "footer": footer.hex(),
        "copies": copies,
    }

    if req.dryRun or FORCE_DRY_RUN:
        result["dryRun"] = True
        return result

    async with _print_lock:
        try:
            notes = await send_raster(data, address=ADDRESS, copies=copies)
        except PrinterNotFound as e:
            _last_print = {"ok": False, "detail": str(e)}
            raise HTTPException(503, str(e))
        except Exception as e:
            _last_print = {"ok": False, "detail": f"{type(e).__name__}: {e}"}
            raise HTTPException(500, f"print failed: {e}")

    result["notifications"] = [n.hex() for n in notes]
    _last_print = {"ok": True, "detail": f"printed {copies}x, {len(data)} bytes"}
    return result


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8330)
