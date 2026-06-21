"""Inverter manager: the single owner of the device connection.

The inverter speaks over one slow, half-duplex link (USB-HID on /dev/hidraw0).
Only ONE transaction may be in flight at a time, so *every* device access -
the background poller and any settings change - is funnelled through one
asyncio lock backed by a single-worker thread executor.  Consequences:

* There is exactly one server-side poller regardless of how many browsers are
  connected (clients receive samples over a WebSocket fan-out, they never poll
  the inverter themselves).
* Applying settings takes the lock for the whole batch, which naturally pauses
  polling until the batch + verification read completes.  Between individual
  setter commands we also insert a deliberate gap so we never machine-gun the
  controller.
"""
from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor

from . import catalog, config, storage

log = logging.getLogger("inverter")


class InverterManager:
    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="inverter")
        self._lock = asyncio.Lock()
        self._last_txn = 0.0
        self._device = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._poll_task: asyncio.Task | None = None

        # shared live state (read by HTTP handlers, written by the poller)
        self.live: dict = {
            "ts": None,
            "connected": False,
            "mode": None,
            "values": {},
            "flags": {},
            "warnings": [],
            "last_error": None,
        }
        self.settings_view: list[dict] = []
        self.settings_read_at: float | None = None

        # apply jobs + websocket subscribers
        self.jobs: dict[str, dict] = {}
        self._job_seq = 0
        self._subscribers: set[asyncio.Queue] = set()

    # -- lifecycle ----------------------------------------------------------
    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._build_device()
        self._poll_task = asyncio.create_task(self._poll_loop(), name="poll-loop")

    async def stop(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _build_device(self) -> None:
        from mppsolar.helpers import get_device_class

        device_class = get_device_class("mppsolar")
        self._device = device_class(
            name=config.DEVICE_NAME,
            port=config.PORT,
            protocol=config.PROTOCOL,
            baud=config.BAUD,
            porttype=None,
        )
        log.info("device created on %s (%s)", config.PORT, config.PROTOCOL)

    # -- low level device access -------------------------------------------
    def _blocking_run(self, command: str) -> dict:
        # honour a minimum gap between any two transactions
        gap = config.MIN_COMMAND_GAP - (time.monotonic() - self._last_txn)
        if gap > 0:
            time.sleep(gap)
        try:
            result = self._device.run_command(command=command)
        finally:
            self._last_txn = time.monotonic()
        return result

    async def _exec(self, command: str) -> dict:
        """Run one command in the worker thread. Caller must hold self._lock."""
        return await self._loop.run_in_executor(self._executor, self._blocking_run, command)

    async def call(self, command: str) -> dict:
        async with self._lock:
            return await self._exec(command)

    # -- polling ------------------------------------------------------------
    async def _poll_loop(self) -> None:
        # Read settings once at startup so the UI is populated immediately.
        try:
            await self.read_settings()
        except Exception as e:  # pragma: no cover - best effort
            log.warning("initial settings read failed: %s", e)

        tick = 0
        while True:
            try:
                await self._poll_once(tick)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("poll error")
                self.live["connected"] = False
                self.live["last_error"] = str(e)
                await self._broadcast({"type": "status", "live": self.live})
            tick += 1
            await asyncio.sleep(config.POLL_INTERVAL)

    async def _poll_once(self, tick: int) -> None:
        async with self._lock:
            qpigs = await self._exec("QPIGS")
            mode = None
            warnings = None
            if tick % config.MODE_EVERY == 0:
                mode = await self._exec("QMOD")
            if tick % config.WARNINGS_EVERY == 0:
                warnings = await self._exec("QPIWS")

        if _is_error(qpigs):
            self.live["connected"] = False
            self.live["last_error"] = _error_text(qpigs)
            await self._broadcast({"type": "status", "live": self.live})
            return

        ts = time.time()
        values = _extract_metrics(qpigs)
        flags = _extract_flags(qpigs)

        self.live["ts"] = ts
        self.live["connected"] = True
        self.live["last_error"] = None
        self.live["values"] = values
        self.live["flags"] = flags
        if mode is not None and not _is_error(mode):
            m = _scalar(mode, "Device Mode")
            if m is not None:  # don't clobber a good value on a glitchy read
                self.live["mode"] = m
        if warnings is not None and not _is_error(warnings):
            self.live["warnings"] = _extract_warnings(warnings)

        storage.insert_sample(ts, values)
        await self._broadcast({"type": "sample", "ts": ts, "values": values, "live": self.live})

    # -- settings -----------------------------------------------------------
    async def read_settings(self) -> list[dict]:
        async with self._lock:
            qpiri = await self._exec("QPIRI")
            qflag = await self._exec("QFLAG")

        merged: dict = {}
        for d in (qpiri, qflag):
            if isinstance(d, dict) and not _is_error(d):
                merged.update(d)

        self.settings_view = catalog.build_view(merged)
        self.settings_read_at = time.time()
        await self._broadcast({"type": "settings", "settings": self.settings_view})
        return self.settings_view

    async def apply_settings(self, items: list[dict], save: bool = True) -> dict:
        """Apply a batch of {key,value} settings sequentially.

        Holds the device lock for the whole batch so polling pauses until done.
        """
        # validate everything up front; abort the whole batch on any bad value
        planned = []
        for it in items:
            key = it.get("key")
            value = it.get("value")
            command = catalog.validate_and_build(key, value)  # raises ValueError
            label = catalog.BY_KEY[key].label
            planned.append({"key": key, "value": value, "command": command, "label": label})

        self._job_seq += 1
        job_id = f"job-{self._job_seq}"
        job = {
            "id": job_id,
            "status": "running",
            "started": time.time(),
            "finished": None,
            "save": save,
            "steps": [
                {**p, "status": "pending", "response": None} for p in planned
            ],
        }
        self.jobs[job_id] = job
        # run the batch as a background task so the HTTP call returns immediately
        asyncio.create_task(self._run_apply_job(job_id, save))
        return job

    async def _run_apply_job(self, job_id: str, save: bool) -> None:
        job = self.jobs[job_id]
        await self._broadcast({"type": "job", "job": job})
        async with self._lock:  # <-- polling waits here for the whole batch
            ok = True
            for i, step in enumerate(job["steps"]):
                if i:
                    await asyncio.sleep(config.APPLY_COMMAND_GAP)
                step["status"] = "sending"
                await self._broadcast({"type": "job", "job": job})
                try:
                    resp = await self._exec(step["command"])
                except Exception as e:
                    resp = {"ERROR": [str(e), ""]}
                accepted = _is_ack(resp)
                step["status"] = "ok" if accepted else "failed"
                step["response"] = _response_summary(resp)
                ok = ok and accepted
                await self._broadcast({"type": "job", "job": job})

            # persist to EEPROM once, after the batch, if requested and all OK
            if save and ok:
                await asyncio.sleep(config.APPLY_COMMAND_GAP)
                save_resp = await self._exec("PSAVE")
                job["save_response"] = _response_summary(save_resp)
                ok = ok and _is_ack(save_resp)

        job["status"] = "completed" if ok else "completed_with_errors"
        job["finished"] = time.time()
        await self._broadcast({"type": "job", "job": job})
        # re-read settings so the UI reflects what the inverter actually has now
        try:
            await self.read_settings()
        except Exception as e:
            log.warning("post-apply settings read failed: %s", e)

    # -- websocket fan-out --------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def _broadcast(self, message: dict) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                # slow client - drop it; it will resync on next message/reconnect
                pass


# ---------------------------------------------------------------------------
# decode helpers
# ---------------------------------------------------------------------------
def _is_error(d) -> bool:
    if not isinstance(d, dict) or "ERROR" in d:
        return True
    # mpp-solar reports a bad CRC / malformed frame via a "validity check" entry
    vc = d.get("validity check")
    if isinstance(vc, (list, tuple)) and vc and "Error" in str(vc[0]):
        return True
    return False


def _error_text(d) -> str:
    if isinstance(d, dict):
        for key in ("ERROR", "validity check"):
            if key in d:
                err = d[key]
                return err[0] if isinstance(err, (list, tuple)) else str(err)
    return "device error"


def _scalar(d: dict, key: str):
    item = d.get(key)
    if isinstance(item, (list, tuple)) and item:
        return item[0]
    return item


def _extract_metrics(qpigs: dict) -> dict:
    out = {}
    for metric_key, (field, _label, _unit) in storage.METRICS.items():
        v = _scalar(qpigs, field)
        try:
            out[metric_key] = float(v)
        except (TypeError, ValueError):
            out[metric_key] = None
    return out


_FLAG_FIELDS = [
    ("load_on", "Is Load On"),
    ("charging_on", "Is Charging On"),
    ("scc_charging", "Is SCC Charging On"),
    ("ac_charging", "Is AC Charging On"),
    ("charging_to_float", "Is Charging to Float"),
]


def _extract_flags(qpigs: dict) -> dict:
    flags = {}
    for key, field in _FLAG_FIELDS:
        v = _scalar(qpigs, field)
        if v is not None:
            try:
                flags[key] = bool(int(v))
            except (TypeError, ValueError):
                flags[key] = bool(v)
    return flags


def _extract_warnings(qpiws: dict) -> list[str]:
    active = []
    for name, item in qpiws.items():
        if name.startswith("_") or name in ("raw_response", "response"):
            continue
        val = item[0] if isinstance(item, (list, tuple)) and item else item
        if str(val) == "1":
            active.append(name)
    return active


def _ack_values(resp: dict):
    """Yield the meaningful decoded values of a setter response.

    Skips bookkeeping keys; mpp-solar decodes a setter ACK either as
    {"Command execution": ["Successful"]} or as {"<CMD>": ["ACK"], ...}.
    """
    for k, v in resp.items():
        if k.startswith("_") or k == "raw_response":
            continue
        yield k, (v[0] if isinstance(v, (list, tuple)) and v else v)


def _is_ack(resp: dict) -> bool:
    if _is_error(resp):
        return False
    val = _scalar(resp, catalog.ACK_KEY)
    if val is not None:
        return str(val) == catalog.ACK_OK
    for _k, v in _ack_values(resp):
        s = str(v)
        if "NAK" in s or "Failed" in s:
            return False
        if "ACK" in s or s == catalog.ACK_OK:
            return True
    return False


def _response_summary(resp: dict) -> str:
    if _is_error(resp):
        return _error_text(resp)
    val = _scalar(resp, catalog.ACK_KEY)
    if val is not None:
        return str(val)
    for _k, v in _ack_values(resp):
        s = str(v)
        if "NAK" in s:
            return "Rejected (NAK)"
        if "ACK" in s:
            return "Accepted (ACK)"
    parts = [f"{k}={v}" for k, v in _ack_values(resp)]
    return "; ".join(parts) if parts else "ok"
