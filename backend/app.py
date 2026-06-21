"""FastAPI application: REST + WebSocket API, and serves the static frontend."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, storage
from .inverter import InverterManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

manager = InverterManager()


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    storage.init()
    await manager.start()
    prune_task = asyncio.create_task(_prune_loop())
    try:
        yield
    finally:
        prune_task.cancel()
        await manager.stop()


async def _prune_loop():
    while True:
        try:
            removed = storage.prune(config.HISTORY_RETENTION_DAYS)
            if removed:
                log.info("pruned %d old samples", removed)
        except Exception:
            log.exception("prune failed")
        await asyncio.sleep(6 * 3600)


app = FastAPI(title="MPP Solar Frontend", lifespan=lifespan)


# ---------------------------------------------------------------------------
# request models
# ---------------------------------------------------------------------------
class SettingItem(BaseModel):
    key: str
    value: object


class ApplyRequest(BaseModel):
    items: list[SettingItem]
    save: bool = True


class ProfileBody(BaseModel):
    name: str
    description: str = ""
    settings: dict  # {setting_key: value}


# ---------------------------------------------------------------------------
# live / history
# ---------------------------------------------------------------------------
@app.get("/api/metrics")
async def metrics_meta():
    return {
        "metrics": [
            {"key": k, "label": label, "unit": unit}
            for k, (field, label, unit) in storage.METRICS.items()
        ]
    }


@app.get("/api/live")
async def live():
    return manager.live


@app.get("/api/history")
async def history(range: int = 3600, limit: int = 3000):
    since = time.time() - range if range > 0 else None
    samples = storage.fetch_samples(since=since, limit=limit)
    return {"samples": samples, "metrics": list(storage.METRIC_KEYS)}


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------
@app.get("/api/settings")
async def get_settings(refresh: bool = False):
    if refresh or not manager.settings_view:
        await manager.read_settings()
    return {"settings": manager.settings_view, "read_at": manager.settings_read_at}


@app.post("/api/settings/apply")
async def apply_settings(req: ApplyRequest):
    try:
        job = await manager.apply_settings(
            [{"key": i.key, "value": i.value} for i in req.items], save=req.save
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return job


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = manager.jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


# ---------------------------------------------------------------------------
# profiles
# ---------------------------------------------------------------------------
@app.get("/api/profiles")
async def list_profiles():
    return {"profiles": storage.list_profiles()}


@app.post("/api/profiles")
async def create_profile(body: ProfileBody):
    _validate_profile_settings(body.settings)
    try:
        return storage.create_profile(body.name, body.description, body.settings)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"could not create profile: {e}")


@app.put("/api/profiles/{profile_id}")
async def update_profile(profile_id: int, body: ProfileBody):
    _validate_profile_settings(body.settings)
    updated = storage.update_profile(
        profile_id, name=body.name, description=body.description, settings=body.settings
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return updated


@app.delete("/api/profiles/{profile_id}")
async def delete_profile(profile_id: int):
    if not storage.delete_profile(profile_id):
        raise HTTPException(status_code=404, detail="profile not found")
    return {"deleted": profile_id}


@app.post("/api/profiles/{profile_id}/apply")
async def apply_profile(profile_id: int, save: bool = True):
    profile = storage.get_profile(profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="profile not found")
    items = [{"key": k, "value": v} for k, v in profile["settings"].items()]
    try:
        job = await manager.apply_settings(items, save=save)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return job


def _validate_profile_settings(settings: dict):
    from . import catalog

    for key, value in settings.items():
        try:
            catalog.validate_and_build(key, value)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------------------
# websocket
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    queue = manager.subscribe()
    # send an immediate snapshot so a fresh client renders without waiting
    await websocket.send_json({"type": "snapshot", "live": manager.live,
                               "settings": manager.settings_view})
    try:
        while True:
            message = await queue.get()
            await websocket.send_json(message)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.debug("websocket closed", exc_info=True)
    finally:
        manager.unsubscribe(queue)


# ---------------------------------------------------------------------------
# static frontend
# ---------------------------------------------------------------------------
@app.get("/")
async def index():
    index_file = config.FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse({"detail": "frontend not built"}, status_code=404)


if config.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="static")
