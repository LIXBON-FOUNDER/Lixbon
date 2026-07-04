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
    folax_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """
    Dependencia: valida la cookie de sesión web (folax_session) o, como
    alternativa para apps (desktop/CLI), un Bearer API key.
    F3: la sesión web es un token propio en la tabla sessions — ya no es la API key.
    """
    from core.persistence.queries import validate_web_session

    if folax_session:
        user_data = validate_web_session(folax_session)
        if user_data:
            return user_data

    bearer = get_bearer_token(authorization)
    if bearer:
        user_data = validate_api_key(bearer)
        if user_data:
            return user_data

    raise HTTPException(status_code=401, detail="Sesión inválida o expirada")


def web_or_api_key_auth(
    request: Request,
    folax_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """
    Dependencia para endpoints de inferencia (/v1/*): acepta la cookie de sesión
    web (F4: el chat de la web hace streaming directo a /v1/chat/completions)
    o un Bearer API key. A diferencia de cookie_auth_required, mantiene el
    rate limit por token cuando la auth viene por API key.
    """
    from core.persistence.queries import validate_web_session

    if folax_session:
        user_data = validate_web_session(folax_session)
        if user_data:
            return user_data

    token = get_bearer_token(authorization)
    if token:
        ip = request.client.host if request.client else None
        user_data = validate_api_key(token, ip_address=ip)
        if user_data:
            enforce_rate_limit(token)
            return user_data

    raise HTTPException(status_code=401, detail="Autenticación requerida (sesión o API key)")


def admin_required(
    folax_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Dependencia: usuario autenticado con role=admin."""
    user_data = cookie_auth_required(folax_session, authorization)
    if user_data.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Requiere rol de administrador")
    return user_data


def validate_model_access(user_data: dict[str, Any], requested_model: str) -> None:
    """Lanza 403 si la key tiene modelo asignado y no coincide con el solicitado."""
    key_model = user_data.get("key_model")
    if key_model and key_model != requested_model:
        raise HTTPException(
            status_code=403,
            detail=f"Esta API key solo permite el modelo '{key_model}'. Solicitud: '{requested_model}'",
        )


# ── Dependencia de admin (token compartido hasta que lleguen los roles en F3) ──

def require_admin_token(x_admin_token: str | None = Header(default=None)) -> None:
    """Valida X-Admin-Token contra ADMIN_TOKEN. Sin token configurado ⇒ 503 (deshabilitado)."""
    import secrets as _secrets
    from core.config import ADMIN_TOKEN
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="Acción administrativa deshabilitada: ADMIN_TOKEN no configurado")
    if not x_admin_token or not _secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Token de administrador inválido")


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
