"""
auth.py — Endpoints de autenticación de FOLAX DTC.
Incluye: login, registro, logout, regeneración de API key.
"""
from __future__ import annotations
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from core.persistence.queries import (
    count_daily_regenerations,
    create_api_key,
    create_user,
    deactivate_all_user_keys,
    get_active_key_for_user,
    log_audit_event,
    verify_user,
)
from core.security.auth import (
    check_auth_rate_limit,
    clear_auth_attempts,
    cookie_auth_required,
    record_failed_auth,
)

router = APIRouter()


class AuthRequest(BaseModel):
    username: str
    password: str


# ── API de autenticación ───────────────────────────────────────────────────

@router.post("/api/auth/logout")
async def api_logout():
    response = JSONResponse({"message": "Logout successful"})
    response.delete_cookie("session_token")
    return response


# ── API de autenticación ───────────────────────────────────────────────────

@router.post("/api/auth/register")
async def api_register(payload: AuthRequest):
    user = create_user(payload.username, payload.password)
    if not user:
        raise HTTPException(status_code=400, detail="El usuario ya existe")
    raw_key, _ = create_api_key(f"Default Key - {payload.username}", user["id"])
    response = JSONResponse({
        "message": "Usuario registrado correctamente",
        "api_key": raw_key,
        "user": user,
    })
    response.set_cookie(key="session_token", value=raw_key, httponly=True)
    return response


@router.post("/api/auth/login")
async def api_login(payload: AuthRequest, request: Request):
    ip = request.client.host if request.client else "unknown"

    # Verificar bloqueo por intentos fallidos
    check_auth_rate_limit(ip)

    user = verify_user(payload.username, payload.password)
    if not user:
        record_failed_auth(ip)
        raise HTTPException(status_code=401, detail="Credenciales incorrectas")

    clear_auth_attempts(ip)
    user_id = user["id"]

    # Reutilizar key activa si existe; de lo contrario crear nueva
    existing = get_active_key_for_user(user_id)
    if existing:
        raw_key = existing["raw_key"]
        is_new = False
    else:
        deactivate_all_user_keys(user_id)
        raw_key, _ = create_api_key(f"Session - {payload.username}", user_id)
        is_new = True
        log_audit_event("api_key_created", user_id=user_id, ip_address=ip, reason="login")

    response = JSONResponse({
        "message": "Login correcto",
        "api_key": raw_key,
        "isNew": is_new,
        "user": user,
    })
    response.set_cookie(key="session_token", value=raw_key, httponly=True)
    return response


@router.post("/api/auth/api-key/regenerate")
async def regenerate_api_key(
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Regenera la API key del usuario. Límite: 5 veces por día."""
    user_id = user_data["id"]
    ip = request.client.host if request.client else None

    if count_daily_regenerations(user_id) >= 5:
        raise HTTPException(
            status_code=429,
            detail="Límite diario de regeneraciones alcanzado (máx. 5 por día)",
        )

    deactivate_all_user_keys(user_id)
    raw_key, key_data = create_api_key(f"Session - {user_data['username']}", user_id)
    log_audit_event(
        "api_key_regenerated",
        user_id=user_id,
        key_id=key_data["id"],
        ip_address=ip,
    )

    response = JSONResponse({
        "newApiKey": raw_key,
        "oldKeyDeactivated": True,
        "deactivationTime": key_data["created_at"],
        "expiresAt": key_data["expires_at"],
    })
    response.set_cookie(key="session_token", value=raw_key, httponly=True)
    return response
