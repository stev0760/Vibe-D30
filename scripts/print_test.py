#!/usr/bin/env python3
"""Deprecated: the logic documented in docs/ble.md now lives in the d30/
package. Use `python -m d30 "text" [--live]` instead. This wrapper just
forwards so old invocations keep working."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from d30.cli import main  # noqa: E402

raise SystemExit(main())
