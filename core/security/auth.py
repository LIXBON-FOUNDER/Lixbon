"""
security.py — Hashing seguro con scrypt, rate limiting por IP y dependencias de auth.

Cambios respecto a la versión anterior:
- hash_password ahora usa scrypt + salt aleatorio (SHA-256 es solo para legacy)
- verify_password soporta ambos formatos con fallback automático
- Bloqueo de IP tras N intentos fallidos de login
- Headers HTTP de seguridad disponibles como middleware
"""
from __future__ import annotations
import hashlib
import os
from typing import Any

from fastapi import Cookie, Header, HTTPException, Request, Response

from core.persistence.queries import validate_api_key

# ── Hashing de contraseñas ─────────────────────────────────────────────────

def hash_password(password: str) -> str:
    """
    Hash seguro con scrypt + salt aleatorio de 16 bytes.
    Formato de almacenamiento: 'scrypt$<salt_hex>$<dk_hex>'
    """
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    """
    Verifica una contraseña contra un hash almacenado.
    Soporta el nuevo formato scrypt y el legacy SHA-256 para compatibilidad.
    """
    if stored_hash.startswith("scrypt$"):
        try:
            _, salt_hex, dk_hex = stored_hash.split("$", 2)
            salt = bytes.fromhex(salt_hex)
            dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
            return dk.hex() == dk_hex
        except Exception:
            return False
    # Fallback legacy SHA-256 (para usuarios registrados antes de v2.0)
    return hashlib.sha256(password.encode("utf-8")).hexdigest() == stored_hash


# ── Rate limiting y anti-brute-force ───────────────────────────────────────
# Implementación en core/security/ratelimit.py (Redis con fallback en memoria).
# Se re-exportan aquí para mantener los imports de los routers.
from core.security.ratelimit import (  # noqa: E402, F401
    check_auth_rate_limit,
    clear_auth_attempts,
    enforce_rate_limit,
    record_failed_auth,
)


# ── Helpers de token ───────────────────────────────────────────────────────

def get_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip()


# ── Dependencias FastAPI ───────────────────────────────────────────────────

def api_key_required(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Dependencia: valida Bearer token y aplica rate limit."""
    token = get_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="API key ausente")
    ip = request.client.host if request.client else None
    user_data = validate_api_key(token, ip_address=ip)
    if not user_data:
        raise HTTPException(status_code=401, detail="API key inválida o expirada")
    enforce_rate_limit(token)
    return user_data


def cookie_auth_required(
    session_token: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Dependencia: valida sesión cookie o Bearer token (dual auth)."""
    token = session_token or get_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="No estás logueado")
    user_data = validate_api_key(token)
    if not user_data:
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada")
    return user_data


def validate_model_access(user_data: dict[str, Any], requested_model: str) -> None:
    """Lanza 403 si la key tiene modelo asignado y no coincide con el solicitado."""
    key_model = user_data.get("key_model")
    if key_model and key_model != requested_model:
        raise HTTPException(
            status_code=403,
            detail=f"Esta API key solo permite el modelo '{key_model}'. Solicitud: '{requested_model}'",
        )


# ── Middleware de headers de seguridad HTTP ────────────────────────────────

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}


async def security_headers_middleware(request: Request, call_next):
    """Middleware que agrega headers de seguridad a todas las respuestas."""
    response: Response = await call_next(request)
    for header, value in SECURITY_HEADERS.items():
        response.headers[header] = value
    return response
