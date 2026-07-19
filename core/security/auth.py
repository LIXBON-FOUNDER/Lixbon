"""
security.py — Hashing seguro con scrypt, rate limiting por IP y dependencias de auth.

Cambios respecto a la versión anterior:
- hash_password ahora usa scrypt + salt aleatorio (SHA-256 es solo para legacy)
- verify_password soporta ambos formatos con fallback automático
- Bloqueo de IP tras N intentos fallidos de login
- Headers HTTP de seguridad disponibles como middleware
"""
from __future__ import annotations
from typing import Any

from fastapi import Cookie, Header, HTTPException, Request, Response

from core.persistence.queries import validate_api_key

# ── Hashing de contraseñas ─────────────────────────────────────────────────
# Implementación ÚNICA en core/persistence/queries.py (scrypt + salt, con
# compare_digest en tiempo constante). Se re-exportan aquí para no tener dos
# copias que puedan divergir — la duplicada de este módulo comparaba con `==`.
from core.persistence.queries import (  # noqa: E402, F401
    _verify_password_internal as verify_password,
    hash_password,
)


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
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """
    Dependencia: valida la cookie de sesión web (lixbon_session) o, como
    alternativa para apps (desktop/CLI), un Bearer API key.
    F3: la sesión web es un token propio en la tabla sessions — ya no es la API key.
    """
    from core.persistence.queries import validate_web_session

    if lixbon_session:
        user_data = validate_web_session(lixbon_session)
        if user_data:
            return user_data

    bearer = get_bearer_token(authorization)
    if bearer:
        user_data = validate_api_key(bearer)
        if user_data:
            # Mismo rate limit que el resto de rutas con API key: sin esto,
            # este camino era una vía libre para martillear la API.
            enforce_rate_limit(bearer)
            return user_data

    raise HTTPException(status_code=401, detail="Sesión inválida o expirada")


def web_or_api_key_auth(
    request: Request,
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """
    Dependencia para endpoints de inferencia (/v1/*): acepta la cookie de sesión
    web (F4: el chat de la web hace streaming directo a /v1/chat/completions)
    o un Bearer API key. A diferencia de cookie_auth_required, mantiene el
    rate limit por token cuando la auth viene por API key.
    """
    from core.persistence.queries import validate_web_session

    if lixbon_session:
        user_data = validate_web_session(lixbon_session)
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
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Dependencia: usuario autenticado con role=admin."""
    user_data = cookie_auth_required(lixbon_session, authorization)
    if user_data.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Requiere rol de administrador")
    return user_data


def admin_or_token(
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
    x_admin_token: str | None = Header(default=None),
) -> None:
    """Acepta sesión con rol admin (panel web) O X-Admin-Token (scripts/CI).
    Permite subir releases desde el panel sin exponer el token en el navegador."""
    import secrets as _secrets
    from core.config import ADMIN_TOKEN

    if ADMIN_TOKEN and x_admin_token and _secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        return
    try:
        user_data = cookie_auth_required(lixbon_session, authorization)
        if user_data.get("role") == "admin":
            return
    except HTTPException:
        pass
    raise HTTPException(status_code=403, detail="Requiere administrador (sesión admin o X-Admin-Token)")


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
