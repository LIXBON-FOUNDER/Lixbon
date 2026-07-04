"""
app.py — Punto de entrada del Gateway FOLAX.
Configura FastAPI, middlewares, ciclo de vida (lifespan) y registra los routers.
Entry point de uvicorn: `uvicorn core.gateway.app:app`
"""
from __future__ import annotations
import mimetypes
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from core.gateway import deps
from core.gateway.logging_setup import setup_logging
from core.config import ALLOWED_ORIGINS, APP_DESCRIPTION, APP_TITLE, APP_VERSION, LOGS_DIR, WEB_DIST_DIR
from core.persistence.queries import archive_old_inactive_keys, init_db
from core.security.auth import security_headers_middleware
from core.gateway.routers import admin, auth, chat, installer, keys, versions, ws_status, monitor


# ── Ciclo de vida ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Inicializa logging, BD, clientes HTTP y orquestador; los cierra al terminar."""
    setup_logging()
    mimetypes.add_type("application/x-msi", ".msi")
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    versions.sync_versions_to_db()

    deps.http_client_fast = httpx.AsyncClient(timeout=10.0)
    deps.http_client_chat = httpx.AsyncClient(timeout=120.0)

    deps.orquestador.iniciar()
    _start_archiver_cron()

    yield

    deps.orquestador.detener()
    if deps.http_client_fast is not None:
        await deps.http_client_fast.aclose()
    if deps.http_client_chat is not None:
        await deps.http_client_chat.aclose()


# ── App FastAPI ────────────────────────────────────────────────────────────

app = FastAPI(
    title=APP_TITLE,
    version=APP_VERSION,
    description=APP_DESCRIPTION,
    lifespan=lifespan,
)

# ── Middleware: CORS ───────────────────────────────────────────────────────
_cors_origins = [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]
_cors_origins.append("http://localhost:5173")  # Vite dev server

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Middleware: Headers de seguridad HTTP ──────────────────────────────────
app.middleware("http")(security_headers_middleware)

# ── Routers ────────────────────────────────────────────────────────────────
app.include_router(auth.router)
app.include_router(keys.router)
app.include_router(chat.router)
app.include_router(installer.router)
app.include_router(versions.router)
app.include_router(ws_status.router)
app.include_router(monitor.router)
app.include_router(admin.router)


# ── Cron daemon de archivado de keys ──────────────────────────────────────

def _start_archiver_cron() -> None:
    """Hilo daemon que archiva API keys inactivas cada 24 horas."""
    import logging as _log

    def _run():
        while True:
            time.sleep(86400)
            try:
                n = archive_old_inactive_keys()
                if n:
                    _log.getLogger("folax").info(f"[cron] {n} API keys archivadas.")
            except Exception as exc:
                _log.getLogger("folax").warning(f"[cron] Error al archivar keys: {exc}")

    threading.Thread(target=_run, daemon=True, name="key-archiver").start()


# ── Archivos estáticos y frontend (React SPA) ──────────────────────────────

_static_dir = Path(__file__).resolve().parent / "static"
_static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")

if WEB_DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(WEB_DIST_DIR / "assets")), name="assets")

    @app.get("/{path_name:path}")
    async def serve_frontend(path_name: str):
        if path_name.startswith(("api/", "v1/", "docs", "openapi.json", "ws/")):
            raise HTTPException(status_code=404, detail="Not Found")
        candidate = (WEB_DIST_DIR / path_name).resolve()
        if path_name and candidate.is_file() and candidate.is_relative_to(WEB_DIST_DIR):
            return FileResponse(str(candidate))
        return FileResponse(str(WEB_DIST_DIR / "index.html"))
