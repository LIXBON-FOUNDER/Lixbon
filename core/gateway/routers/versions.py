"""
versions.py — Releases y actualizaciones (F6.5).

Los instaladores viven en Cloudflare R2 (bucket privado); la BD solo guarda la
key del objeto (`download_url = "r2:<key>"`). Las descargas pasan siempre por el
gateway (`/api/updates/download/...`), que genera una URL prefirmada al vuelo —
el binario nunca se expone público y la URL pública es estable para el updater.

Endpoints públicos de solo lectura: manifest de Tauri, manifest del CLI, y
comparación de versión. La subida exige token admin.
"""
from __future__ import annotations

import json
import logging
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import RedirectResponse
from packaging.version import InvalidVersion, Version

from core.config import APP_VERSION, PUBLIC_BASE_URL, r2_configured
from core.persistence import queries as db
from core.security.auth import admin_or_token
from core.storage import r2

logger = logging.getLogger("lixbon.versions")
router = APIRouter()

VERSIONS_JSON_PATH = Path(__file__).resolve().parent.parent / "versions.json"
_LOCAL_RELEASES_DIR = Path(__file__).resolve().parent.parent / "static" / "releases"


def sync_versions_to_db():
    """Carga las versiones semilla de versions.json a la BD (idempotente)."""
    if not VERSIONS_JSON_PATH.exists():
        return
    try:
        with open(VERSIONS_JSON_PATH, "r", encoding="utf-8") as f:
            versions_data = json.load(f)
        for v in versions_data:
            db.add_app_version(
                version=v["version"],
                channel=v["channel"],
                release_date=v["release_date"],
                title=v["title"],
                changelog=v["changelog"],
                download_url=v["download_url"],
                checksum=v.get("checksum_sha256"),
            )
    except Exception as e:
        logger.warning(f"[versions] Error al sincronizar versiones: {e}")


# ── Helpers ────────────────────────────────────────────────────────────────

def _public_download_url(request: Request, version: str, channel: str) -> str:
    """URL estable del gateway que resuelve la descarga (redirige a R2 o local).

    Detrás de Railway/Cloudflare el TLS se termina fuera y la petición llega al
    gateway por http, así que `request.base_url` sería http://… — un enlace que
    el navegador bloquea en silencio por mixed content en una página https.
    Preferimos PUBLIC_BASE_URL; si no, respetamos el esquema real que anuncia el
    proxy en X-Forwarded-Proto."""
    base = (PUBLIC_BASE_URL or str(request.base_url)).rstrip("/")
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    if proto == "https" and base.startswith("http://"):
        base = "https://" + base[len("http://"):]
    return f"{base}/api/updates/download/{version}/{channel}"


def _find_version(version: str, channel: str) -> dict | None:
    for v in db.get_all_versions():
        if v["version"] == version and v["channel"] == channel:
            return v
    return None


# ── Lectura pública ────────────────────────────────────────────────────────

@router.get("/api/versions")
async def get_versions():
    """Lista de versiones registradas (metadatos; sin URLs directas al binario)."""
    return db.get_all_versions()


@router.get("/api/versions/current")
async def get_current_version():
    return {"version": APP_VERSION}


@router.get("/api/updates/check")
async def check_update(request: Request, v: str = Query(..., description="Versión instalada en el cliente")):
    """Compara la versión del cliente con la última del canal correspondiente."""
    is_beta_client = "beta" in v.lower() or "rc" in v.lower()
    latest_release = db.get_latest_version(channel="beta" if is_beta_client else "stable")
    if not latest_release:
        return {"update_available": False, "latest_version": v}

    latest_v = latest_release["version"]
    try:
        update_available = Version(latest_v) > Version(v)
    except InvalidVersion:
        update_available = latest_v != v

    return {
        "update_available": update_available,
        "current_version": v,
        "latest_version": latest_v,
        "channel": latest_release["channel"],
        "title": latest_release["title"],
        "release_date": latest_release["release_date"],
        "changelog": latest_release["changelog"],
        "download_url": _public_download_url(request, latest_v, latest_release["channel"]),
        "checksum_sha256": latest_release["checksum_sha256"],
    }


@router.get("/api/updates/latest/{channel}")
async def get_latest(channel: str, request: Request):
    """Última versión de un canal para la página de descargas. Nunca 404: si no
    hay releases devuelve {available: false} para que el front lo maneje limpio."""
    if channel not in ("stable", "beta"):
        raise HTTPException(status_code=400, detail="Canal de actualización inválido")
    latest = db.get_latest_version(channel=channel)
    if not latest:
        return {"available": False, "channel": channel}
    return {
        "available": True,
        "channel": channel,
        "version": latest["version"],
        "title": latest["title"],
        "release_date": latest["release_date"],
        "changelog": latest["changelog"],
        "download_url": _public_download_url(request, latest["version"], channel),
    }


@router.get("/api/updates/manifest/{channel}")
async def get_tauri_manifest(channel: str, request: Request):
    """Manifest en el formato del auto-updater de Tauri 2."""
    if channel not in ("stable", "beta"):
        raise HTTPException(status_code=400, detail="Canal de actualización inválido")
    latest = db.get_latest_version(channel=channel)
    if not latest:
        raise HTTPException(status_code=404, detail="No se encontró versión para este canal")

    notes = "\n".join(f"- {item}" for item in latest["changelog"])
    return {
        "version": latest["version"],
        "notes": notes,
        "pub_date": latest["created_at"],
        "platforms": {
            "windows-x86_64": {
                "url": _public_download_url(request, latest["version"], channel),
                "signature": latest["checksum_sha256"] or "",
            }
        },
    }


@router.get("/api/updates/cli/{channel}")
async def get_cli_manifest(channel: str, request: Request):
    """Manifest del CLI (formato propio, consumido por `client_cli.py --update`)."""
    if channel not in ("stable", "beta"):
        raise HTTPException(status_code=400, detail="Canal de actualización inválido")
    latest = db.get_latest_version(channel=channel)
    if not latest:
        raise HTTPException(status_code=404, detail="No se encontró versión para este canal")
    return {
        "version": latest["version"],
        "channel": channel,
        "title": latest["title"],
        "release_date": latest["release_date"],
        "changelog": latest["changelog"],
        "download_url": _public_download_url(request, latest["version"], channel),
        "checksum_sha256": latest["checksum_sha256"],
    }


@router.get("/api/updates/download/{version}/{channel}")
async def download_release(version: str, channel: str):
    """Resuelve la descarga: redirige a una URL prefirmada de R2 (o al archivo
    local en dev). URL pública estable; la firmada se genera al vuelo."""
    row = _find_version(version, channel)
    if not row:
        raise HTTPException(status_code=404, detail="Versión no encontrada")

    url = row["download_url"]
    if url.startswith("r2:"):
        key = url[len("r2:"):]
        try:
            signed = r2.presigned_get_url(key)
        except r2.R2NotConfigured:
            raise HTTPException(status_code=503, detail="Almacenamiento de releases no configurado")
        except Exception as exc:
            logger.error(f"[versions] no se pudo firmar {key}: {exc}")
            raise HTTPException(status_code=502, detail="No se pudo generar la descarga")
        return RedirectResponse(url=signed, status_code=302)

    # Compatibilidad: releases antiguos (ruta local o URL absoluta)
    return RedirectResponse(url=url, status_code=302)


# ── Subida (admin) ─────────────────────────────────────────────────────────

@router.post("/api/versions/upload")
async def api_upload_version(
    version: str = Form(...),
    channel: str = Form(...),
    title: str = Form(...),
    changelog: str = Form(...),
    checksum_sha256: str = Form(None),
    file: UploadFile = File(...),
    _: None = Depends(admin_or_token),
):
    """Sube un instalador a R2 (o al disco local en dev) y registra la versión."""
    import re as _re
    if not _re.fullmatch(r"[A-Za-z0-9._-]+", version) or channel not in ("stable", "beta"):
        raise HTTPException(status_code=400, detail="Versión o canal inválidos")

    try:
        changelog_list = json.loads(changelog)
    except Exception:
        changelog_list = [changelog]

    suffix = Path(file.filename or "").suffix or ".bin"
    filename = f"app-lixbon-{version}-{channel}{suffix}"

    if r2_configured():
        key = f"releases/{filename}"
        try:
            r2.upload_release(key, file.file, content_type=file.content_type)
        except Exception as exc:
            logger.error(f"[versions] fallo al subir a R2: {exc}")
            raise HTTPException(status_code=502, detail="No se pudo subir el instalador a R2")
        download_url = f"r2:{key}"
        storage = "r2"
    else:
        # Dev sin R2: disco local (efímero en Railway — solo para pruebas)
        _LOCAL_RELEASES_DIR.mkdir(parents=True, exist_ok=True)
        file_path = _LOCAL_RELEASES_DIR / filename
        with file_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        download_url = f"/static/releases/{filename}"
        storage = "local"

    db.add_app_version(
        version=version,
        channel=channel,
        release_date=time.strftime("%Y-%m-%d"),
        title=title,
        changelog=changelog_list,
        download_url=download_url,
        checksum=checksum_sha256,
    )
    db.log_audit_event("release_uploaded", version=version, channel=channel, storage=storage)

    return {"success": True, "version": version, "channel": channel, "storage": storage}
