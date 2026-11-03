"""
Conectores por usuario: cada uno autoriza SU cuenta del servicio para su
cuenta de Lixbon. De momento, GitHub.

Flujo de conexión (navegador, con la cookie de sesión de la web):
  1. GET /api/connectors/github/start?next=/integraciones
     → redirige a GitHub a autorizar la App con un `state` firmado que lleva
       el id del usuario de Lixbon.
  2. GET /api/connectors/github/callback?code&state
     → comprueba que el `state` es de ESTE usuario (la cookie debe coincidir:
       sin eso, un atacante podría colgar su cuenta de GitHub en la sesión de
       otro), canjea el código y guarda los tokens cifrados.
     → si el usuario aún no instaló la App en ningún sitio, lo manda a
       instalarla (ahí elige los repos).
  3. GET /api/connectors/github/setup — el «Setup URL» de la App: GitHub
     vuelve aquí después de instalar o cambiar los repos; solo redirige a la web.
"""
from __future__ import annotations

import secrets
import time
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from starlette.concurrency import run_in_threadpool

from core.connectors import github as gh
from core.gateway.routers.oauth import _server_base, _sign_state, _verify_state
from core.persistence import connectors as store
from core.persistence.queries import log_audit_event
from core.security.auth import resolve_credential, session_required

router = APIRouter(tags=["connectors"])

DESTINO_POR_DEFECTO = "/integraciones"


def _destino(next_path: str | None) -> str:
    """Solo rutas de la propia web: el callback no puede ser un open redirect."""
    p = (next_path or "").strip()
    if not p.startswith("/") or p.startswith("//") or "\\" in p or len(p) > 200:
        return DESTINO_POR_DEFECTO
    return p


def _volver(destino: str, estado: str) -> RedirectResponse:
    sep = "&" if "?" in destino else "?"
    return RedirectResponse(f"{destino}{sep}{urlencode({'github': estado})}", status_code=303)


def _callback_url(request: Request) -> str:
    return f"{_server_base(request)}/api/connectors/github/callback"


def _exigir_configurado() -> None:
    if not gh.configurado():
        raise HTTPException(status_code=503, detail="El conector de GitHub no está configurado")


async def _estado_github(user_id: int) -> dict[str, Any]:
    if not gh.configurado():
        return {"configured": False, "connected": False}
    fila = await run_in_threadpool(store.get_connector, user_id, gh.PROVIDER)
    if not fila:
        return {"configured": True, "connected": False}
    try:
        instalaciones = await gh.Cliente(user_id).instalaciones()
    except gh.GitHubError:
        instalaciones = None  # el estado no debe fallar porque GitHub tarde
    return {
        "configured": True,
        "connected": True,
        "login": fila.get("account_login"),
        "avatar": fila.get("account_avatar"),
        "connected_at": fila.get("created_at"),
        "manage_url": gh.url_administrar(instalaciones),
    }


@router.get("/api/connectors")
async def listar(user_data: dict[str, Any] = Depends(session_required)):
    return {"github": await _estado_github(user_data["id"])}


@router.get("/api/connectors/github")
async def estado_github(user_data: dict[str, Any] = Depends(session_required)):
    return await _estado_github(user_data["id"])


@router.get("/api/connectors/github/start")
async def start(request: Request, next: str | None = None,
                user_data: dict[str, Any] = Depends(session_required)):
    _exigir_configurado()
    state = _sign_state({"p": "gh-conn", "u": user_data["id"], "r": _destino(next),
                         "ts": time.time(), "n": secrets.token_urlsafe(8)})
    url = "https://github.com/login/oauth/authorize?" + urlencode({
        "client_id": gh.CLIENT_ID,
        "redirect_uri": _callback_url(request),
        "state": state,
    })
    return RedirectResponse(url, status_code=302)


@router.get("/api/connectors/github/callback")
async def callback(request: Request, state: str = "", code: str = "", error: str = "",
                   lixbon_session: str | None = Cookie(default=None)):
    _exigir_configurado()
    payload = _verify_state(state)
    if not payload or payload.get("p") != "gh-conn":
        return _volver(DESTINO_POR_DEFECTO, "expired")
    destino = _destino(payload.get("r"))
    usuario = resolve_credential(lixbon_session, None)
    if not usuario or usuario.get("id") != payload.get("u"):
        # Otra sesión (o ninguna) en este navegador: no se cuelga la cuenta de
        # GitHub de nadie.
        return _volver(destino, "session")
    if error or not code:
        return _volver(destino, "cancelled")

    ip = request.client.host if request.client else None
    try:
        fila = await gh.conectar(usuario["id"], code, _callback_url(request))
    except gh.GitHubError:
        return _volver(destino, "error")
    await run_in_threadpool(log_audit_event, "connector_connected", user_id=usuario["id"], ip_address=ip,
                            provider=gh.PROVIDER, login=fila.get("account_login"))

    try:
        instalada = await gh.Cliente(usuario["id"]).tiene_instalacion()
    except gh.GitHubError:
        instalada = True  # no bloquear la conexión por esto: la web lo reintenta al listar repos
    if not instalada:
        estado_inst = _sign_state({"p": "gh-inst", "u": usuario["id"], "r": destino, "ts": time.time()})
        return RedirectResponse(gh.url_instalar(estado_inst), status_code=303)
    return _volver(destino, "connected")


@router.get("/api/connectors/github/setup")
async def setup(state: str = "", setup_action: str = ""):
    """GitHub vuelve aquí tras instalar o cambiar repos. No cambia nada: los
    repos se leen en vivo de GitHub cada vez."""
    payload = _verify_state(state) if state else None
    destino = _destino(payload.get("r")) if payload and payload.get("p") == "gh-inst" else DESTINO_POR_DEFECTO
    return _volver(destino, "installed" if setup_action != "request" else "requested")


@router.get("/api/connectors/github/repos")
async def repos(user_data: dict[str, Any] = Depends(session_required)):
    _exigir_configurado()
    cli = gh.Cliente(user_data["id"])
    try:
        instalaciones = await cli.instalaciones()
        lista = await cli.repos(instalaciones=instalaciones)
    except gh.GitHubError as exc:
        raise HTTPException(status_code=exc.status if exc.status in (409, 503) else 502, detail=str(exc))
    return {"repos": lista, "manage_url": gh.url_administrar(instalaciones)}


@router.delete("/api/connectors/github")
async def desconectar(request: Request, user_data: dict[str, Any] = Depends(session_required)):
    borrado = await gh.desconectar(user_data["id"])
    if borrado:
        await run_in_threadpool(log_audit_event, "connector_disconnected", user_id=user_data["id"],
                                ip_address=request.client.host if request.client else None,
                                provider=gh.PROVIDER)
    return {"disconnected": borrado}
