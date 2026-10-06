"""Formulario de soporte (/support en la web).

POST /api/support recibe un caso (tipo, asunto, mensaje y, sin sesión, el
correo) y lo manda al buzón de soporte con Reply-To del usuario, más un acuse
con el número de caso al usuario. No se guarda en la base de datos: el hilo
vive en el correo, que es donde se contesta.

Sin sesión es público, así que lleva un campo trampa para bots y un límite de
envíos por IP (y por cuenta, con sesión).
"""
from __future__ import annotations

import re
import secrets
import threading
import time
from typing import Literal

from fastapi import APIRouter, Cookie, HTTPException, Request
from pydantic import BaseModel, Field

from core.gateway.email import send_support_receipt, send_support_ticket

router = APIRouter(tags=["support"])

CATEGORIAS: dict[str, str] = {
    "account": "Cuenta y acceso",
    "billing": "Pagos y facturación",
    "refund": "Reembolso",
    "bug": "Algo no funciona",
    "api": "API y claves",
    "apps": "CLI, escritorio o móvil",
    "privacy": "Privacidad y datos",
    "feedback": "Sugerencia",
    "other": "Otro",
}

MAX_ENVIOS = 5
VENTANA_S = 3600
_envios: dict[str, list[float]] = {}
_candado = threading.Lock()
_CORREO = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class CasoSoporte(BaseModel):
    category: Literal["account", "billing", "refund", "bug", "api", "apps", "privacy", "feedback", "other"]
    subject: str = Field(min_length=3, max_length=140)
    message: str = Field(min_length=20, max_length=5000)
    email: str | None = Field(default=None, max_length=254)
    name: str | None = Field(default=None, max_length=80)
    page: str | None = Field(default=None, max_length=300)
    # Campo trampa: invisible en el formulario; solo un bot lo rellena.
    website: str | None = Field(default=None, max_length=200)


def _permitido(clave: str) -> bool:
    ahora = time.monotonic()
    with _candado:
        recientes = [t for t in _envios.get(clave, []) if ahora - t < VENTANA_S]
        if len(recientes) >= MAX_ENVIOS:
            _envios[clave] = recientes
            return False
        recientes.append(ahora)
        _envios[clave] = recientes
        return True


def _usuario(lixbon_session: str | None) -> dict | None:
    if not lixbon_session:
        return None
    from core.persistence.queries import validate_web_session
    return validate_web_session(lixbon_session)


@router.post("/api/support")
async def crear_caso(payload: CasoSoporte, request: Request,
                     lixbon_session: str | None = Cookie(default=None)):
    ticket = f"LX-{secrets.token_hex(3).upper()}"
    if payload.website:
        # Al bot se le responde como si hubiera ido bien, sin enviar nada.
        return {"ok": True, "ticket": ticket}

    usuario = _usuario(lixbon_session)
    correo = (usuario or {}).get("email") or (payload.email or "").strip()
    if not _CORREO.match(correo):
        raise HTTPException(status_code=422, detail="Escribe un correo válido para poder responderte.")

    ip = request.client.host if request.client else "unknown"
    claves = [f"ip:{ip}"] + ([f"u:{usuario['id']}"] if usuario and usuario.get("id") else [])
    if not all(_permitido(c) for c in claves):
        raise HTTPException(status_code=429, detail="Has enviado varios casos seguidos. Espera un rato o escríbenos a support@lixbon.com.")

    nombre = (payload.name or "").strip() or None
    if usuario and not nombre:
        nombre = " ".join(filter(None, [usuario.get("first_name"), usuario.get("last_name")])) or None
    categoria = CATEGORIAS[payload.category]
    asunto = payload.subject.strip()
    mensaje = payload.message.strip()

    enviado = await send_support_ticket(
        ticket=ticket, categoria=categoria, asunto=asunto, mensaje=mensaje, correo=correo,
        nombre=nombre, plan=(usuario or {}).get("plan_name") or (usuario or {}).get("plan_id"),
        user_id=(usuario or {}).get("id"), pagina=payload.page,
        user_agent=request.headers.get("user-agent"),
    )
    if not enviado:
        raise HTTPException(status_code=503, detail="No pudimos enviar tu caso ahora mismo. Inténtalo de nuevo en unos minutos o escríbenos a support@lixbon.com.")
    # Si el acuse falla no es un error: el caso ya está en el buzón.
    await send_support_receipt(correo, ticket=ticket, categoria=categoria, asunto=asunto, mensaje=mensaje)
    return {"ok": True, "ticket": ticket, "email": correo}
