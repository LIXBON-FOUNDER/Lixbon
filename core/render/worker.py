"""
worker.py — Worker de render de Visuals: toma trabajos de la cola en la base de
datos, renderiza el HTML (PNG o MP4) y guarda la salida como versión nueva.

  python -m core.render.worker

Corre como servicio aparte (infra/render_worker) con la misma DATABASE_URL que el
gateway. Avisa al gateway de cada trabajo terminado por POST a
/api/internal/render-events (RENDER_GATEWAY_URL + RENDER_WORKER_TOKEN) para que la
web y el IDE se actualicen en vivo. Con RENDER_INLINE=1 el gateway lo ejecuta en un
hilo propio (desarrollo local o despliegue de un solo servicio).
"""
from __future__ import annotations

import json
import logging
import os
import signal
import socket
import threading
import time
import urllib.request
from typing import Any, Callable

from core.billing.quota import visual_limits
from core.persistence import visual_renders as renders
from core.persistence.queries import get_plan_for_user, get_user_by_id
from core.persistence.visuals import VisualError
from core.render.renderer import RenderError, render

logger = logging.getLogger("lixbon.render")
POLL_S = float(os.getenv("RENDER_POLL_S", "2"))
WORKER_ID = os.getenv("RENDER_WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}"

Notify = Callable[[dict[str, Any]], None]


def notify_gateway(event: dict[str, Any]) -> None:
    gateway, token = os.getenv("RENDER_GATEWAY_URL", "").rstrip("/"), os.getenv("RENDER_WORKER_TOKEN", "")
    if not gateway or not token:
        return
    req = urllib.request.Request(f"{gateway}/api/internal/render-events", data=json.dumps(event).encode(),
                                 headers={"Content-Type": "application/json", "X-Render-Token": token,
                                          "User-Agent": "Lixbon-RenderWorker"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=5).close()
    except Exception as exc:  # el aviso en vivo es opcional: la web también consulta el estado
        logger.warning("No se pudo avisar al gateway: %s", exc)


def _storage_mb(user_id: int) -> int:
    user = get_user_by_id(user_id) or {}
    return visual_limits(user, get_plan_for_user(user_id))[1]


def _event(job: dict[str, Any], status: str, **extra: Any) -> dict[str, Any]:
    return {"type": "render", "visual_id": job["visual_id"], "job_id": job["id"], "path": job["path"],
            "status": status, **extra}


def process_one(worker_id: str = WORKER_ID, render_fn=render, notify: Notify = notify_gateway) -> bool:
    """Procesa un trabajo. False si la cola está vacía."""
    job = renders.claim(worker_id)
    if not job:
        return False
    meta = job["meta"]
    started = time.monotonic()
    try:
        data = render_fn(job["html"], meta["kind"], meta["width"], meta["height"], meta["seconds"],
                         path=job["path"], assets=job.get("assets") or {})
    except RenderError as exc:
        renders.fail(job["id"], str(exc), retry=False)
        notify(_event(job, "failed", error=str(exc)))
        return True
    except Exception as exc:
        logger.exception("Render %s falló", job["id"])
        res = renders.fail(job["id"], f"{type(exc).__name__}: {exc}", retry=True)
        notify(_event(job, res["status"] if res else "failed", error=str(exc)))
        return True
    try:
        done = renders.complete(job["id"], data, job["source_sha256"], max_storage_mb=_storage_mb(job["user_id"]))
    except VisualError as exc:
        renders.fail(job["id"], exc.message, retry=False)
        notify(_event(job, "failed", error=exc.message))
        return True
    logger.info("Render %s %s → %s v%s en %.1fs", job["id"], job["path"], done["output_path"],
                done["output_version"], time.monotonic() - started)
    notify(_event(job, "done", output_path=done["output_path"], version=done["output_version"]))
    return True


def run(stop: threading.Event, notify: Notify = notify_gateway, worker_id: str = WORKER_ID) -> None:
    while not stop.is_set():
        try:
            busy = process_one(worker_id, notify=notify)
        except Exception:
            logger.exception("Error en el bucle del worker de render")
            busy = False
        if not busy:
            stop.wait(POLL_S)


def start_inline(notify: Notify) -> threading.Event:
    stop = threading.Event()
    threading.Thread(target=run, args=(stop, notify, f"inline-{WORKER_ID}"), daemon=True,
                     name="visual-render").start()
    return stop


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    logger.info("Worker de render %s escuchando la cola", WORKER_ID)
    run(stop)


if __name__ == "__main__":
    main()
