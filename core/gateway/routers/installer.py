"""
installer.py — Endpoints de distribución del Lixbon CLI.
Sirve los scripts de instalación para Linux/macOS y Windows con el binario Go
de la última release registrada.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

from core.config import PUBLIC_BASE_URL
from core.gateway.routers import installer_go
from core.gateway.routers.versions import latest_cli_release_for_install

router = APIRouter()


def _server_base(request: Request) -> str:
    """Base pública para los scripts generados. Preferimos PUBLIC_BASE_URL:
    request.base_url depende de la cabecera Host (manipulable) y detrás del
    proxy llega como http://."""
    return (PUBLIC_BASE_URL or str(request.base_url)).rstrip("/")


def _release_or_503() -> dict:
    release = latest_cli_release_for_install()
    if not release:
        raise HTTPException(status_code=503, detail="No hay ninguna release del CLI registrada")
    return release


@router.get("/install.sh")
async def install_script(request: Request) -> PlainTextResponse:
    return PlainTextResponse(content=installer_go.install_sh(_server_base(request), _release_or_503()))


@router.get("/install.ps1")
async def install_script_windows(request: Request) -> PlainTextResponse:
    return PlainTextResponse(content=installer_go.install_ps1(_server_base(request), _release_or_503()))
