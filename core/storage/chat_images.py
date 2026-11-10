"""
Imágenes que el usuario manda al chat: antes solo viajaban al modelo en base64
y se perdían al recargar (y en cada despliegue, porque el disco de Railway es
efímero). Ahora se guardan en R2 junto al mensaje.

Clave: chat-images/{user_id}/{conversation_id}/{token}.jpg. El usuario va en la
ruta, así el endpoint que las sirve solo puede devolver las suyas, y borrar una
conversación (o todo el historial) es borrar un prefijo.

Sin R2 configurado (desarrollo local) se guardan en línea, como data URL.
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import re
import secrets

from core.config import r2_configured
from core.storage import r2

logger = logging.getLogger("lixbon.chat_images")

PREFIJO = "chat-images"
MAX_IMAGENES = 4
MAX_BYTES = 6 * 1024 * 1024
_TOKEN = re.compile(r"^[0-9a-f]{32}\.(jpg|png|webp)$")
_ID_CONV = re.compile(r"^[A-Za-z0-9-]{8,64}$")
_TIPOS = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}


def _ext(datos: bytes) -> str | None:
    if datos[:3] == b"\xff\xd8\xff":
        return "jpg"
    if datos[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if datos[:4] == b"RIFF" and datos[8:12] == b"WEBP":
        return "webp"
    return None


def clave(user_id: int, conv_id: str, token: str) -> str:
    return f"{PREFIJO}/{user_id}/{conv_id}/{token}"


def guardar(user_id: int, conv_id: str, imagenes_b64: list[str] | None) -> str | None:
    """Sube las imágenes y devuelve la lista (JSON) que se guarda en el
    mensaje: tokens de R2 o, sin R2, data URLs. None si no hay ninguna válida.
    Una imagen que falla no rompe el mensaje: se registra y se omite."""
    guardadas: list[str] = []
    for b64 in (imagenes_b64 or [])[:MAX_IMAGENES]:
        try:
            datos = base64.b64decode(b64, validate=False)
        except (binascii.Error, ValueError):
            continue
        ext = _ext(datos)
        if not ext or len(datos) > MAX_BYTES:
            continue
        if not r2_configured():
            guardadas.append(f"data:{_TIPOS[ext]};base64,{b64}")
            continue
        token = f"{secrets.token_hex(16)}.{ext}"
        try:
            r2.upload_bytes(clave(user_id, conv_id, token), datos, _TIPOS[ext])
            guardadas.append(token)
        except Exception as exc:  # noqa: BLE001 — R2 caído no debe tumbar el chat
            logger.warning(f"[chat_images] no se pudo subir una imagen: {exc}")
    return json.dumps(guardadas) if guardadas else None


def urls(conv_id: str, guardado: str | None) -> list[str]:
    """Lo que ve el cliente: URL del endpoint para las de R2; data URL tal cual."""
    if not guardado:
        return []
    try:
        lista = json.loads(guardado)
    except ValueError:
        return []
    return [x if x.startswith("data:") else f"/api/chat-images/{conv_id}/{x}" for x in lista if isinstance(x, str)]


def leer(user_id: int, conv_id: str, token: str) -> tuple[bytes, str] | None:
    if not _TOKEN.match(token) or not _ID_CONV.match(conv_id):
        return None
    try:
        return r2.get_object_bytes(clave(user_id, conv_id, token)), _TIPOS[token.rsplit(".", 1)[1]]
    except Exception:  # noqa: BLE001
        return None


def borrar(user_id: int, conv_id: str | None = None) -> None:
    """Borra las imágenes de una conversación o, sin `conv_id`, todas las del
    usuario. Best-effort: un fallo deja objetos huérfanos, no rompe el borrado."""
    if not r2_configured():
        return
    prefijo = f"{PREFIJO}/{user_id}/" + (f"{conv_id}/" if conv_id else "")
    try:
        r2.delete_older_than(prefijo, 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[chat_images] no se pudieron borrar {prefijo}: {exc}")

