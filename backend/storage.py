"""SQLite persistence: time-series samples + named preset profiles.

A single connection guarded by a lock is plenty for one poller thread plus the
HTTP handlers, and keeps things simple on a Raspberry Pi.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time

from . import config

# Canonical metric key -> (decoded QPIGS field name, label, unit).  This is the
# source of truth for what we store and chart.
METRICS: dict[str, tuple[str, str, str]] = {
    "battery_voltage": ("Battery Voltage", "Battery Voltage", "V"),
    "battery_capacity": ("Battery Capacity", "Battery SOC", "%"),
    "battery_charge_current": ("Battery Charging Current", "Charge Current", "A"),
    "battery_discharge_current": ("Battery Discharge Current", "Discharge Current", "A"),
    "pv_input_power": ("PV Input Power", "PV Power", "W"),
    "pv_input_voltage": ("PV Input Voltage", "PV Voltage", "V"),
    "ac_output_active_power": ("AC Output Active Power", "Load Power", "W"),
    "ac_output_apparent_power": ("AC Output Apparent Power", "Apparent Power", "VA"),
    "ac_output_load": ("AC Output Load", "Load", "%"),
    "ac_output_voltage": ("AC Output Voltage", "Output Voltage", "V"),
    "ac_input_voltage": ("AC Input Voltage", "Grid Voltage", "V"),
    "heatsink_temp": ("Inverter Heat Sink Temperature", "Heat-sink Temp", "°C"),
}

METRIC_KEYS = list(METRICS.keys())

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def init() -> None:
    global _conn
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    cols = ", ".join(f"{k} REAL" for k in METRIC_KEYS)
    with _lock:
        _conn.execute(
            f"CREATE TABLE IF NOT EXISTS samples (ts REAL PRIMARY KEY, {cols})"
        )
        _conn.execute(
            """CREATE TABLE IF NOT EXISTS profiles (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT UNIQUE NOT NULL,
                   description TEXT,
                   settings TEXT NOT NULL,
                   created REAL NOT NULL,
                   updated REAL NOT NULL
               )"""
        )
        _conn.commit()


# ---------------------------------------------------------------------------
# Samples
# ---------------------------------------------------------------------------
def insert_sample(ts: float, values: dict[str, float]) -> None:
    cols = ["ts"] + METRIC_KEYS
    row = [ts] + [values.get(k) for k in METRIC_KEYS]
    placeholders = ", ".join(["?"] * len(cols))
    with _lock:
        _conn.execute(
            f"INSERT OR REPLACE INTO samples ({', '.join(cols)}) VALUES ({placeholders})",
            row,
        )
        _conn.commit()


def fetch_samples(since: float | None = None, limit: int = 5000) -> list[dict]:
    """Return samples newest-window, oldest-first, optionally downsampled to limit."""
    where = "WHERE ts >= ?" if since is not None else ""
    args: list = [since] if since is not None else []
    with _lock:
        total = _conn.execute(
            f"SELECT COUNT(*) AS c FROM samples {where}", args
        ).fetchone()["c"]
        # Downsample by stride so we never ship more than ~limit points.
        stride = max(1, (total // limit) + (1 if total % limit else 0)) if total else 1
        rows = _conn.execute(
            f"""SELECT * FROM (
                    SELECT *, ROW_NUMBER() OVER (ORDER BY ts) AS rn
                    FROM samples {where}
                ) WHERE rn %% {stride} = 0 ORDER BY ts""".replace("%%", "%"),
            args,
        ).fetchall()
    return [dict(r) for r in rows]


def prune(retention_days: int) -> int:
    cutoff = time.time() - retention_days * 86400
    with _lock:
        cur = _conn.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
        _conn.commit()
        return cur.rowcount


# ---------------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------------
def list_profiles() -> list[dict]:
    with _lock:
        rows = _conn.execute("SELECT * FROM profiles ORDER BY name").fetchall()
    return [_profile_row(r) for r in rows]


def get_profile(profile_id: int) -> dict | None:
    with _lock:
        r = _conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    return _profile_row(r) if r else None


def create_profile(name: str, description: str, settings: dict) -> dict:
    now = time.time()
    with _lock:
        cur = _conn.execute(
            "INSERT INTO profiles (name, description, settings, created, updated) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, description or "", json.dumps(settings), now, now),
        )
        _conn.commit()
        pid = cur.lastrowid
    return get_profile(pid)


def update_profile(profile_id: int, name=None, description=None, settings=None) -> dict | None:
    existing = get_profile(profile_id)
    if existing is None:
        return None
    name = existing["name"] if name is None else name
    description = existing["description"] if description is None else description
    settings = existing["settings"] if settings is None else settings
    with _lock:
        _conn.execute(
            "UPDATE profiles SET name=?, description=?, settings=?, updated=? WHERE id=?",
            (name, description, json.dumps(settings), time.time(), profile_id),
        )
        _conn.commit()
    return get_profile(profile_id)


def delete_profile(profile_id: int) -> bool:
    with _lock:
        cur = _conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
        _conn.commit()
        return cur.rowcount > 0


def _profile_row(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "description": r["description"],
        "settings": json.loads(r["settings"]),
        "created": r["created"],
        "updated": r["updated"],
    }
