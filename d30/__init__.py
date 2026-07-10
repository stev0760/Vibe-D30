"""Userspace Phomemo D30 label printer driver (BLE GATT, no pairing).

Protocol details and reverse-engineering notes live in docs/ble.md.
"""

from .protocol import (
    CHUNK_SIZE,
    DOTS_PER_MM,
    TAPE_WIDTH_MM,
    TAPE_WIDTH_PX,
    build_packet,
    pack_raster,
)
from .transport import DEFAULT_ADDRESS, send_raster

__all__ = [
    "CHUNK_SIZE",
    "DOTS_PER_MM",
    "TAPE_WIDTH_MM",
    "TAPE_WIDTH_PX",
    "build_packet",
    "pack_raster",
    "DEFAULT_ADDRESS",
    "send_raster",
]
