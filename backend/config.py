"""Runtime configuration, all overridable via environment variables.

Defaults target a Raspberry Pi with an MPP Solar inverter on a USB-HID
connection (``/dev/hidraw0``).  For development on a machine with no inverter
attached set ``MPPF_PORT=test`` to use the mppsolar TestIO canned responses.
"""
import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Device / protocol
# ---------------------------------------------------------------------------
# /dev/hidraw0  -> USB HID raw (the real Pi connection)
# test          -> mppsolar TestIO (canned responses, for development)
PORT = os.environ.get("MPPF_PORT", "/dev/hidraw0")
PROTOCOL = os.environ.get("MPPF_PROTOCOL", "PI30")
BAUD = int(os.environ.get("MPPF_BAUD", "2400"))
DEVICE_NAME = os.environ.get("MPPF_DEVICE_NAME", "inverter")

# ---------------------------------------------------------------------------
# Polling cadence (seconds).  The inverter link is a single, slow, half-duplex
# channel, so we keep one server-side poller (never one-per-client) and stagger
# the slower queries.  QPIGS gives the live numbers; QMOD the operating mode;
# QPIWS the warning flags.
# ---------------------------------------------------------------------------
POLL_INTERVAL = float(os.environ.get("MPPF_POLL_INTERVAL", "5"))      # QPIGS
MODE_EVERY = int(os.environ.get("MPPF_MODE_EVERY", "3"))              # QMOD: every N polls
WARNINGS_EVERY = int(os.environ.get("MPPF_WARNINGS_EVERY", "6"))      # QPIWS: every N polls

# Minimum gap enforced between *any* two device transactions, and the pause
# inserted between consecutive setter commands when applying settings.  These
# keep us from hammering the inverter's controller.
MIN_COMMAND_GAP = float(os.environ.get("MPPF_MIN_COMMAND_GAP", "0.2"))
APPLY_COMMAND_GAP = float(os.environ.get("MPPF_APPLY_COMMAND_GAP", "0.4"))

# Number of attempts for a single device transaction before giving up.
COMMAND_RETRIES = int(os.environ.get("MPPF_COMMAND_RETRIES", "2"))

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
DATA_DIR = Path(os.environ.get("MPPF_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = Path(os.environ.get("MPPF_DB_PATH", DATA_DIR / "mppsolar.db"))
# How long to keep time-series samples (days).
HISTORY_RETENTION_DAYS = int(os.environ.get("MPPF_HISTORY_RETENTION_DAYS", "14"))

# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------
HOST = os.environ.get("MPPF_HOST", "0.0.0.0")
PORT_HTTP = int(os.environ.get("MPPF_HTTP_PORT", "8080"))

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
