"""
Cifrado simétrico de secretos de terceros (tokens de los conectores).

Los tokens de GitHub, a diferencia de las API keys de Lixbon, no se pueden
guardar hasheados: el gateway los necesita en claro para llamar a la API. Van
cifrados con Fernet (AES-128-CBC + HMAC-SHA256) y una clave que solo vive en el
entorno: quien lea la base de datos sin `CONNECTORS_SECRET_KEY` no obtiene nada.

`CONNECTORS_SECRET_KEY` puede ser cualquier cadena larga y aleatoria; se deriva
a una clave Fernet con SHA-256. Cambiarla invalida los tokens guardados (cada
usuario tendría que volver a conectar su cuenta).
"""
from __future__ import annotations

import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken


def _clave() -> bytes | None:
    secreto = os.getenv("CONNECTORS_SECRET_KEY", "").strip()
    if len(secreto) < 32:
        return None
    return base64.urlsafe_b64encode(hashlib.sha256(secreto.encode()).digest())


def disponible() -> bool:
    """Sin clave (o con una demasiado corta) los conectores quedan desactivados."""
    return _clave() is not None


def cifrar(texto: str) -> str:
    clave = _clave()
    if clave is None:
        raise RuntimeError("CONNECTORS_SECRET_KEY no está configurada (mínimo 32 caracteres)")
    return Fernet(clave).encrypt(texto.encode()).decode()


def descifrar(token: str) -> str | None:
    """None si la clave cambió o el dato está corrupto: el llamador lo trata
    como «sin conectar»."""
    clave = _clave()
    if clave is None or not token:
        return None
    try:
        return Fernet(clave).decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        return None
