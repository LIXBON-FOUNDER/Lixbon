"""Alcance del token del contenedor de Coding (`lixbon_ct_…`).

El CLI que corre dentro del entorno aislado solo puede:
- hablar con el modelo (`/v1/chat/completions`, `/v1/models`),
- hacer de host de SU sesión /remote (comandos, eventos, imágenes),
- usar el proxy git y avisar de su estado en SU sesión de Coding.

Cualquier otra ruta, o la de otra sesión, trata el token como inexistente
(401). Se decide por la ruta en un middleware ASGI que deja la sesión
permitida en una variable de contexto; `resolve_credential` la consulta. Así
cubre también los WebSockets y cualquier endpoint futuro sin tocarlo.
"""
from __future__ import annotations

import contextvars
import re

# None = la ruta no admite tokens de contenedor. "*" = ruta sin sesión en la
# URL (inferencia): vale cualquier token vigente. Un id = solo el de esa sesión.
_permitida: contextvars.ContextVar[str | None] = contextvars.ContextVar("coding_permitida", default=None)

_SID = r"(?P<sid>[0-9a-f]{12})"
# (métodos, ruta). Solo el lado HOST del relay: nunca POST /commands, /stream
# ni /transcript (son del mando: el agente podría aprobarse a sí mismo).
_RUTAS: list[tuple[frozenset[str], re.Pattern]] = [
    (frozenset({"POST"}), re.compile(r"^/v1/chat/completions/?$")),
    (frozenset({"GET"}), re.compile(r"^/v1/models/?$")),
    # Herramientas del CLI que pasan por el gateway: búsqueda web y roles de modelo.
    (frozenset({"POST"}), re.compile(r"^/api/websearch/?$")),
    (frozenset({"GET"}), re.compile(r"^/api/model-roles/?$")),
    (frozenset({"GET"}), re.compile(rf"^/api/remote/sessions/{_SID}/commands/?$")),
    (frozenset({"POST"}), re.compile(rf"^/api/remote/sessions/{_SID}/events/?$")),
    (frozenset({"WS"}), re.compile(rf"^/api/remote/sessions/{_SID}/host/?$")),
    (frozenset({"PUT"}), re.compile(rf"^/api/remote/sessions/{_SID}/images/[A-Za-z0-9_.-]+$")),
    (frozenset({"POST"}), re.compile(rf"^/api/coding/sessions/{_SID}/host/?$")),
    (frozenset({"GET", "POST"}), re.compile(
        rf"^/api/coding/sessions/{_SID}/git/(info/refs|git-upload-pack|git-receive-pack)$")),
]


def sesion_permitida(path: str, method: str = "GET") -> str | None:
    """'*' para inferencia, el id de sesión para rutas de host, None si no se admite."""
    for metodos, patron in _RUTAS:
        m = patron.match(path)
        if m and method.upper() in metodos:
            return m.groupdict().get("sid") or "*"
    return None


def token_admitido(coding_session_id: str) -> bool:
    """¿Puede el token de esta sesión usarse en la petición en curso?"""
    permitida = _permitida.get()
    return permitida == "*" or (permitida is not None and permitida == coding_session_id)


class AlcanceCodingMiddleware:
    """ASGI puro (no BaseHTTPMiddleware): la variable de contexto llega al endpoint."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") in ("http", "websocket"):
            metodo = "WS" if scope["type"] == "websocket" else scope.get("method", "GET")
            token = _permitida.set(sesion_permitida(scope.get("path") or "", metodo))
            try:
                await self.app(scope, receive, send)
            finally:
                _permitida.reset(token)
            return
        await self.app(scope, receive, send)
