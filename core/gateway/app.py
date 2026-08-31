"""
app.py — Punto de entrada del Gateway lixbon.
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
from core.persistence.queries import (
    archive_old_inactive_keys,
    init_db,
    purge_expired_sessions,
    sweep_remote_sessions,
    touch_remote_session,
)
from core.security.auth import security_headers_middleware
from core.gateway.routers import admin, admin_panel, attachments, auth, avatar, billing, chat, conversations, ide_auth, installer, keys, nodes_admin, oauth, payments, remote, team, versions, ws_status, monitor


# ── Ciclo de vida ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Inicializa logging, BD, clientes HTTP y orquestador; los cierra al terminar."""
    setup_logging()
    import logging as _log
    import os as _os
    if _os.getenv("COOKIE_SECURE", "0") != "1":
        _log.getLogger("lixbon").warning(
            "COOKIE_SECURE no está en '1': las cookies de sesión se emiten sin el "
            "flag Secure. Correcto en desarrollo local; en producción (HTTPS) es "
            "obligatorio configurar COOKIE_SECURE=1."
        )
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
    # Swagger/OpenAPI bajo /api/* para dejar libre /docs a la web (lixbon Docs)
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# ── Middleware: CORS ───────────────────────────────────────────────────────
_cors_origins = [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]
_cors_origins.append("http://localhost:5173")  # Vite dev server
_cors_origins.append("http://localhost:1420")  # Tauri dev (app desktop)
_cors_origins.append("http://tauri.localhost")  # App desktop en Windows (WebView2)
_cors_origins.append("tauri://localhost")  # App desktop en macOS/Linux

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
app.include_router(ide_auth.router)   # /ide/connect + canje del IDE
app.include_router(team.router)       # /api/team/* + /ws/team (Lixbon Team)
app.include_router(oauth.router)
app.include_router(keys.router)
app.include_router(chat.router)
app.include_router(conversations.router)
app.include_router(attachments.router)
app.include_router(avatar.router)
app.include_router(billing.router)
app.include_router(payments.router)
app.include_router(payments.credits_router)
app.include_router(admin_panel.router)
app.include_router(installer.router)
app.include_router(versions.router)
app.include_router(remote.router)
app.include_router(ws_status.router)
app.include_router(monitor.router)
app.include_router(nodes_admin.router)
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
                    _log.getLogger("lixbon").info(f"[cron] {n} API keys archivadas.")
                m = purge_expired_sessions()
                if m:
                    _log.getLogger("lixbon").info(f"[cron] {m} sesiones expiradas purgadas.")
                # Adjuntos de Team que se subieron y nunca llegaron a un
                # mensaje: alguien eligió una foto y cerró la ventana antes de
                # enviarla. Sin esto el bucket crece para siempre con archivos
                # que no puede ver nadie, que es una factura.
                a = team.purgar_adjuntos_huerfanos()
                if a:
                    _log.getLogger("lixbon").info(f"[cron] {a} adjuntos huérfanos de Team borrados.")
            except Exception as exc:
                _log.getLogger("lixbon").warning(f"[cron] Error en tareas de mantenimiento: {exc}")

    threading.Thread(target=_run, daemon=True, name="key-archiver").start()

    def _run_remote_sweep():
        # Cadencia corta: marca offline las sesiones /remote cuyo host dejó de
        # dar señales (p.ej. tras un reinicio del gateway) y cierra las viejas.
        # Antes del barrido se refrescan las que siguen enganchadas al hub: el
        # host solo hace touch al publicar eventos, así que un IDE conectado
        # pero sin actividad de chat aparecía "sin conexión" al minuto.
        from core.gateway.remote_hub import hub as _hub

        while True:
            time.sleep(300)
            try:
                for _sid in _hub.live_host_sessions():
                    touch_remote_session(_sid)
                sweep_remote_sessions()
            except Exception as exc:
                _log.getLogger("lixbon").warning(f"[cron] Error en sweep de sesiones remotas: {exc}")

    threading.Thread(target=_run_remote_sweep, daemon=True, name="remote-sweeper").start()


# ── Archivos estáticos y frontend (React SPA) ──────────────────────────────

_static_dir = Path(__file__).resolve().parent / "static"
_static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")

if WEB_DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(WEB_DIST_DIR / "assets")), name="assets")

    @app.get("/{path_name:path}")
    async def serve_frontend(path_name: str):
        # /docs y /openapi.json ahora viven bajo /api/*, así que /docs es la SPA
        if path_name.startswith(("api/", "v1/", "ws/")):
            raise HTTPException(status_code=404, detail="Not Found")
        candidate = (WEB_DIST_DIR / path_name).resolve()
        if path_name and candidate.is_file() and candidate.is_relative_to(WEB_DIST_DIR):
            return FileResponse(str(candidate))
        return FileResponse(str(WEB_DIST_DIR / "index.html"))
