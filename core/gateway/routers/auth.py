"""
auth.py — Autenticación de lixbon (F3).
Login por EMAIL, sesiones web separadas de API keys, verificación de correo
y reset de contraseña. Registro con nombre y apellido (según diseño web).
"""
from __future__ import annotations

import os
import re
from typing import Any

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from core.gateway.email import send_password_reset_email, send_verification_email
from core.persistence.queries import (
    count_daily_regenerations,
    create_api_key,
    create_email_token,
    consume_email_token,
    create_user,
    create_web_session,
    deactivate_all_user_keys,
    deactivate_key,
    delete_user_sessions,
    delete_web_session,
    get_active_key_for_user,
    get_user_by_email,
    list_api_keys,
    log_audit_event,
    mark_email_verified,
    set_user_password,
    set_user_plan,
    verify_user,
)
from core.security.auth import (
    check_auth_rate_limit,
    clear_auth_attempts,
    cookie_auth_required,
    record_failed_auth,
)

router = APIRouter()

SESSION_COOKIE = "lixbon_session"
DESKTOP_KEY_NAME = "lixbon Desktop"
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "0") == "1"   # "1" en Railway (HTTPS)
SESSION_MAX_AGE = int(os.getenv("SESSION_EXPIRY_HOURS", "168")) * 3600
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegisterRequest(BaseModel):
    first_name: str = Field(..., min_length=1, max_length=60)
    last_name: str = Field(..., min_length=1, max_length=60)
    email: str
    password: str = Field(..., min_length=8, max_length=200)


class LoginRequest(BaseModel):
    email: str | None = None
    username: str | None = None   # compat con clientes pre-F3
    password: str
    issue_api_key: bool = False   # las apps (desktop/móvil) piden una key propia al entrar
    # Nombre de la key a rotar. Cada app usa el suyo ("lixbon Desktop",
    # "Lixbon Mobile") para no pisarse las credenciales entre sí.
    key_name: str | None = Field(default=None, min_length=1, max_length=60)


class ResetRequestPayload(BaseModel):
    email: str


class ResetPasswordPayload(BaseModel):
    token: str
    new_password: str = Field(..., min_length=8, max_length=200)


def _set_session_cookie(response: JSONResponse, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=SESSION_MAX_AGE,
    )


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def issue_named_api_key(user_id: int, key_name: str, ip: str) -> str:
    """Rota la API key de una app concreta: desactiva la anterior con el mismo
    nombre y emite una nueva. Compartido por el login clásico y el OAuth."""
    for k in list_api_keys(user_id):
        if k["name"] == key_name and k["is_active"]:
            deactivate_key(k["id"], user_id)
    raw_key, key_data = create_api_key(key_name, user_id)
    log_audit_event("app_key_issued", user_id=user_id, key_id=key_data["id"], ip_address=ip)
    return raw_key


# ── Registro / Login / Logout ──────────────────────────────────────────────

@router.post("/api/auth/register")
async def api_register(payload: RegisterRequest, request: Request):
    ip = _client_ip(request)
    check_auth_rate_limit(ip)

    email = payload.email.strip().lower()
    if not _EMAIL_RE.fullmatch(email):
        raise HTTPException(status_code=400, detail="Correo electrónico inválido")

    user = create_user(email, payload.password, payload.first_name, payload.last_name)
    if not user:
        record_failed_auth(ip)
        raise HTTPException(status_code=400, detail="Ya existe una cuenta con ese correo")

    set_user_plan(user["id"], "free")  # F5: plan Gratuito por defecto
    session_token = create_web_session(user["id"], ip, request.headers.get("user-agent"))
    log_audit_event("user_registered", user_id=user["id"], ip_address=ip)

    # Verificación de correo (no bloqueante: la cuenta ya funciona)
    verify_token = create_email_token(user["id"], "verify_email", hours=48)
    await send_verification_email(email, verify_token)

    response = JSONResponse({
        "message": "Cuenta creada correctamente",
        "user": user,
        "verification_email_sent": True,
    })
    _set_session_cookie(response, session_token)
    return response


@router.post("/api/auth/login")
async def api_login(payload: LoginRequest, request: Request):
    ip = _client_ip(request)
    check_auth_rate_limit(ip)

    identifier = (payload.email or payload.username or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="Falta el correo electrónico")

    user = verify_user(identifier, payload.password)
    if not user:
        record_failed_auth(ip)
        raise HTTPException(status_code=401, detail="Credenciales incorrectas")

    clear_auth_attempts(ip)
    session_token = create_web_session(user["id"], ip, request.headers.get("user-agent"))
    log_audit_event("user_login", user_id=user["id"], ip_address=ip)

    body: dict[str, Any] = {"message": "Login correcto", "user": user}

    if payload.issue_api_key:
        # Las apps (desktop/móvil) no pueden reusar la cookie de sesión en
        # peticiones cross-origin (SameSite=Lax desde tauri://localhost o desde
        # la app Android), así que el login les entrega directamente una API key
        # propia y rotable, identificada por nombre de app.
        key_name = (payload.key_name or DESKTOP_KEY_NAME).strip() or DESKTOP_KEY_NAME
        body["api_key"] = issue_named_api_key(user["id"], key_name, ip)
        body["api_key_notice"] = "Guárdala: no se volverá a mostrar"
    # Compat CLI/desktop pre-F3: si el usuario no tiene ninguna API key activa,
    # se crea una y se muestra UNA única vez.
    elif not get_active_key_for_user(user["id"]):
        raw_key, _key = create_api_key(f"Default Key - {user['email'] or user['username']}", user["id"])
        body["api_key"] = raw_key
        body["api_key_notice"] = "Guárdala: no se volverá a mostrar"

    response = JSONResponse(body)
    _set_session_cookie(response, session_token)
    return response


@router.post("/api/auth/logout")
async def api_logout(lixbon_session: str | None = Cookie(default=None)):
    if lixbon_session:
        delete_web_session(lixbon_session)
    response = JSONResponse({"message": "Logout correcto"})
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.get("/api/auth/me")
async def api_me(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Usuario actual + plan vigente + preferencias (para hidratar la web al cargar)."""
    from core.persistence.queries import get_plan_for_user, get_user_settings
    plan = get_plan_for_user(user_data["id"])
    settings = get_user_settings(user_data["id"])
    return {"user": {**user_data, "plan_id": plan["id"], "plan_name": plan["name"],
                     "settings": settings}}


# ── Verificación de email ──────────────────────────────────────────────────

@router.get("/api/auth/verify-email")
async def verify_email(token: str):
    user_id = consume_email_token(token, "verify_email")
    if not user_id:
        raise HTTPException(status_code=400, detail="Enlace inválido o expirado")
    mark_email_verified(user_id)
    log_audit_event("email_verified", user_id=user_id)
    return RedirectResponse(url="/?verified=1", status_code=303)


@router.post("/api/auth/resend-verification")
async def resend_verification(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    if user_data.get("email_verified"):
        return {"message": "El correo ya está verificado"}
    if not user_data.get("email"):
        raise HTTPException(status_code=400, detail="La cuenta no tiene correo asociado")
    token = create_email_token(user_data["id"], "verify_email", hours=48)
    await send_verification_email(user_data["email"], token)
    return {"message": "Correo de verificación reenviado"}


# ── Reset de contraseña ────────────────────────────────────────────────────

@router.post("/api/auth/request-password-reset")
async def request_password_reset(payload: ResetRequestPayload, request: Request):
    """Siempre responde 200 (sin revelar si el correo existe)."""
    check_auth_rate_limit(_client_ip(request))
    user = get_user_by_email(payload.email)
    if user:
        token = create_email_token(user["id"], "reset_password", hours=2)
        await send_password_reset_email(user["email"], token)
        log_audit_event("password_reset_requested", user_id=user["id"], ip_address=_client_ip(request))
    return {"message": "Si el correo existe, enviamos un enlace para restablecer la contraseña"}


@router.post("/api/auth/reset-password")
async def reset_password(payload: ResetPasswordPayload, request: Request):
    user_id = consume_email_token(payload.token, "reset_password")
    if not user_id:
        raise HTTPException(status_code=400, detail="Enlace inválido o expirado")
    set_user_password(user_id, payload.new_password)
    deactivate_all_user_keys(user_id)  # rotar credenciales tras cambio de contraseña
    delete_user_sessions(user_id)      # una sesión robada no debe sobrevivir al reset
    log_audit_event("password_reset_completed", user_id=user_id, ip_address=_client_ip(request))
    return {"message": "Contraseña actualizada. Inicia sesión de nuevo."}


# ── Regeneración de API key ────────────────────────────────────────────────

@router.post("/api/auth/api-key/regenerate")
async def regenerate_api_key(
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Regenera la API key del usuario. Límite: 5 veces por día."""
    user_id = user_data["id"]
    ip = _client_ip(request)

    if count_daily_regenerations(user_id) >= 5:
        raise HTTPException(
            status_code=429,
            detail="Límite diario de regeneraciones alcanzado (máx. 5 por día)",
        )

    deactivate_all_user_keys(user_id)
    raw_key, key_data = create_api_key(
        f"Session - {user_data.get('email') or user_data['username']}", user_id
    )
    log_audit_event("api_key_regenerated", user_id=user_id, key_id=key_data["id"], ip_address=ip)

    return {
        "newApiKey": raw_key,
        "notice": "Guárdala: no se volverá a mostrar",
        "oldKeyDeactivated": True,
        "expiresAt": key_data["expires_at"],
    }
