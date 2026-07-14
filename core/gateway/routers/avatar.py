"""
avatar.py — Foto de perfil del usuario.

La imagen vive en R2 (el disco de Railway es efímero) y la fila `users` solo
guarda su key. El bucket es PRIVADO: el gateway hace de proxy en el GET, así la
credencial de R2 nunca sale del servidor.

El GET es público a propósito. La key lleva un token aleatorio de 128 bits, así
que la URL es impredecible, y así la misma URL sirve para la web (cookie) y para
el IDE (Bearer): un `<img src>` no manda cabeceras de autenticación.
"""
from __future__ import annotations

import logging
import secrets
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response

from core.config import r2_configured
from core.persistence.queries import (
    avatar_url_for,
    get_user_avatar_key,
    set_user_avatar,
)
from core.security.auth import web_or_api_key_auth
from core.storage import r2

logger = logging.getLogger("lixbon.avatar")
router = APIRouter()

MAX_AVATAR_BYTES = 3 * 1024 * 1024  # 3 MB

# content-type → extensión. Solo formatos que un navegador pinta sin más.
_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
}

# Firmas de archivo: el content-type lo elige el cliente y se puede mentir.
_MAGIC = {
    "png": b"\x89PNG\r\n\x1a\n",
    "jpg": b"\xff\xd8\xff",
    "gif": b"GIF8",
}


def _sniff_ok(ext: str, data: bytes) -> bool:
    if ext == "webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    magic = _MAGIC.get(ext)
    return bool(magic and data.startswith(magic))


@router.post("/api/account/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    user: dict[str, Any] = Depends(web_or_api_key_auth),
):
    """Sube la foto de perfil. Vale para web e IDE (cookie o API key)."""
    if not r2_configured():
        raise HTTPException(status_code=503, detail={
            "code": "storage_unavailable",
            "message": "El almacenamiento de imágenes no está configurado.",
        })

    ext = _TYPES.get((file.content_type or "").lower())
    if not ext:
        raise HTTPException(status_code=415, detail={
            "code": "unsupported",
            "message": "Solo se admiten imágenes PNG, JPG, WEBP o GIF.",
        })

    data = await file.read()
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail={
            "code": "too_large",
            "message": "La imagen supera el límite de 3 MB.",
        })
    if not _sniff_ok(ext, data):
        raise HTTPException(status_code=415, detail={
            "code": "not_an_image",
            "message": "El archivo no es una imagen válida.",
        })

    old_key = get_user_avatar_key(user["id"])
    key = f"avatars/{secrets.token_hex(16)}.{ext}"

    try:
        r2.upload_bytes(key, data, file.content_type)
    except Exception as exc:
        logger.error(f"[avatar] subida fallida: {exc}")
        raise HTTPException(status_code=502, detail={
            "code": "upload_failed",
            "message": "No se pudo guardar la imagen. Inténtalo de nuevo.",
        })

    set_user_avatar(user["id"], key)

    # La anterior ya no la referencia nadie: borrarla es best-effort (si falla,
    # solo queda un objeto huérfano; el usuario ya tiene su foto nueva).
    if old_key:
        try:
            r2.delete_object(old_key)
        except Exception as exc:
            logger.warning(f"[avatar] no se pudo borrar la anterior {old_key}: {exc}")

    return {"avatar_url": avatar_url_for(key)}


@router.delete("/api/account/avatar")
async def delete_avatar(user: dict[str, Any] = Depends(web_or_api_key_auth)):
    """Quita la foto de perfil (vuelve a la inicial del nombre)."""
    key = get_user_avatar_key(user["id"])
    set_user_avatar(user["id"], None)
    if key:
        try:
            r2.delete_object(key)
        except Exception as exc:
            logger.warning(f"[avatar] no se pudo borrar {key}: {exc}")
    return {"avatar_url": None}


@router.get("/api/avatar/{token}")
async def get_avatar(token: str):
    """Sirve la imagen. Público: el token es impredecible y un `<img>` no puede
    mandar cabeceras de autenticación."""
    name, _, ext = token.rpartition(".")
    if len(name) != 32 or not all(c in "0123456789abcdef" for c in name) or ext not in _TYPES.values():
        raise HTTPException(status_code=404, detail="No encontrada")

    try:
        data = r2.get_object_bytes(f"avatars/{token}")
    except Exception:
        raise HTTPException(status_code=404, detail="No encontrada")

    media = next(t for t, e in _TYPES.items() if e == ext)
    return Response(
        content=data,
        media_type=media,
        # La key cambia con cada subida, así que el objeto es inmutable.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
