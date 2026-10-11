from __future__ import annotations

import os
import re
from typing import Any, Literal

from fastapi import APIRouter, Body, Cookie, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from core.gateway.email import (
    en_segundo_plano,
    send_login_alert_email,
    send_password_changed_email,
    send_password_reset_email,
    send_verification_email,
    send_welcome_email,
)
from core.persistence.queries import (
    ACCESS_TOKEN_MINUTES,
    RefreshRace,
    count_daily_regenerations,
    create_device_session,
    create_email_token,
    consume_email_token,
    create_user,
    create_web_session,
    deactivate_all_user_keys,
    deactivate_key,
    delete_user_sessions,
    delete_web_session,
    get_plan_for_user,
    get_user_by_email,
    get_user_by_id,
    list_api_keys,
    list_user_sessions,
    log_audit_event,
    mark_email_verified,
    registrar_acceso,
    revoke_other_sessions,
    revoke_session,
    revoke_session_token,
    rotate_refresh,
    set_user_password,
    set_user_plan,
    verify_user,
)
from core.security.auth import (
    check_auth_rate_limit,
    clear_auth_attempts,
    get_bearer_token,
    session_or_api_key,
    session_required,
    record_failed_auth,
)

router = APIRouter()

SESSION_COOKIE = "lixbon_session"
DESKTOP_KEY_NAME = "lixbon Desktop"
CLI_KEY_NAME = "lixbon CLI"        # apps/cli/internal/api lo manda explícito
MOBILE_KEY_NAME = "Lixbon Mobile"  # debe coincidir exactamente con apps/mobile/src/state.js
# El login OAuth del desktop emitía su key con este nombre; se sigue reconociendo
# para que esas keys ya emitidas cuenten como desktop sin obligar a re-login.
LEGACY_DESKTOP_KEY_NAME = "Lixbon IDE"
# Nombres de las API keys que las propias apps se emiten a sí mismas al hacer
# login (issue_api_key=True). Cualquier otra API key (creada a mano en
# Ajustes → API keys para uso externo/programable) sigue con el sistema de
# créditos prepago sin cambios — ver core.gateway.routers.chat._is_external_api,
# que además distingue Free (desktop/CLI se quedan en créditos; móvil no) de
# Pro/Advance (las 4 apps comparten el pool de sesión/semana).
FIRST_PARTY_KEY_NAMES = frozenset(
    {DESKTOP_KEY_NAME, LEGACY_DESKTOP_KEY_NAME, CLI_KEY_NAME, MOBILE_KEY_NAME})
DESKTOP_CLI_KEY_NAMES = frozenset({DESKTOP_KEY_NAME, LEGACY_DESKTOP_KEY_NAME, CLI_KEY_NAME})
_CLIENT_POR_KEY = {DESKTOP_KEY_NAME: "desktop", LEGACY_DESKTOP_KEY_NAME: "desktop",
                   CLI_KEY_NAME: "cli", MOBILE_KEY_NAME: "mobile"}
_KEY_POR_CLIENT = {"desktop": DESKTOP_KEY_NAME, "cli": CLI_KEY_NAME, "mobile": MOBILE_KEY_NAME}
AppClient = Literal["desktop", "cli", "mobile"]
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
    # Clientes nuevos: piden una sesión de dispositivo (access + refresh).
    client: AppClient | None = None
    device_name: str | None = Field(default=None, max_length=80)
    # Clientes anteriores: esperan `api_key`; key_name dice qué app es.
    issue_api_key: bool = False
    key_name: str | None = Field(default=None, min_length=1, max_length=60)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(..., min_length=1, max_length=200)


class LogoutRequest(BaseModel):
    refresh_token: str | None = Field(default=None, max_length=200)


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


def nombre_de_app(client: str | None, key_name: str | None) -> str:
    return _KEY_POR_CLIENT[client] if client else (key_name or DESKTOP_KEY_NAME)


def cuerpo_de_tokens(tokens: dict[str, Any]) -> dict[str, Any]:
    return {
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_MINUTES * 60,
        "expires_at": tokens["expires_at"],
        "session_id": tokens["session_id"],
    }


def emitir_credencial_de_app(user_id: int, ip: str, user_agent: str | None, *,
                             client: str | None, device_name: str | None,
                             key_name: str | None) -> dict[str, Any]:
    """Login de una app. Nunca crea una API key: con `client` entrega access +
    refresh; sin él es un cliente anterior que espera `api_key` y recibe en ese
    campo un access legacy de 90 días sin refresh."""
    if client:
        tokens = create_device_session(user_id, client, device_name=device_name,
                                       ip_address=ip, user_agent=user_agent)
        log_audit_event("device_session_created", user_id=user_id, ip_address=ip, client=client)
        return cuerpo_de_tokens(tokens)

    nombre = nombre_de_app(None, key_name)
    legacy_client = _CLIENT_POR_KEY.get(nombre, "desktop")
    # Lo que hacía la rotación por nombre: la key que esta app tenía deja de valer.
    for k in list_api_keys(user_id):
        if k["name"] == nombre and k["is_active"] and k["origin"] == "login":
            deactivate_key(k["id"], user_id)
    tokens = create_device_session(user_id, legacy_client, ip_address=ip, user_agent=user_agent,
                                   legacy=True)
    log_audit_event("legacy_session_created", user_id=user_id, ip_address=ip, client=legacy_client)
    return {"api_key": tokens["access_token"], "api_key_notice": "Guárdala: no se volverá a mostrar"}


def avisar_si_acceso_inusual(user: dict[str, Any], user_agent: str | None, ip: str,
                             key_name: str | None = None) -> None:
    if registrar_acceso(user["id"], user_agent, ip, key_name) and user.get("email"):
        en_segundo_plano(send_login_alert_email(user["email"], user_agent=user_agent, ip=ip,
                                                key_name=key_name))


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
    agente = request.headers.get("user-agent")
    session_token = create_web_session(user["id"], ip, agente)
    registrar_acceso(user["id"], agente, ip)
    log_audit_event("user_registered", user_id=user["id"], ip_address=ip)

    verify_token = create_email_token(user["id"], "verify_email", hours=48)
    enviado = await send_verification_email(email, verify_token)

    response = JSONResponse({
        "message": "Cuenta creada correctamente",
        "user": user,
        # El valor real: decir siempre `true` convertía un correo perdido en un
        # usuario esperando indefinidamente un mensaje que nadie envió.
        "verification_email_sent": enviado,
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
    agente = request.headers.get("user-agent")
    log_audit_event("user_login", user_id=user["id"], ip_address=ip)
    body: dict[str, Any] = {"message": "Login correcto", "user": user}

    # Las apps no pueden reusar la cookie en peticiones cross-origin (SameSite=Lax
    # desde tauri://localhost o la app Android): reciben su credencial en el cuerpo.
    if payload.client or payload.issue_api_key:
        avisar_si_acceso_inusual(user, agente, ip, nombre_de_app(payload.client, payload.key_name))
        body.update(emitir_credencial_de_app(user["id"], ip, agente, client=payload.client,
                                             device_name=payload.device_name,
                                             key_name=payload.key_name))
        return JSONResponse(body)

    avisar_si_acceso_inusual(user, agente, ip)
    response = JSONResponse(body)
    _set_session_cookie(response, create_web_session(user["id"], ip, agente))
    return response


@router.post("/api/auth/refresh")
async def api_refresh(payload: RefreshRequest, request: Request):
    ip = _client_ip(request)
    check_auth_rate_limit(ip)
    try:
        tokens = rotate_refresh(payload.refresh_token.strip(), ip)
    except RefreshRace:
        raise HTTPException(status_code=409, detail={
            "error": "refresh_race",
            "message": "Otra ventana ya renovó la sesión: vuelve a leer los tokens guardados.",
        })
    if not tokens:
        raise HTTPException(status_code=401, detail={
            "error": "invalid_refresh",
            "message": "La sesión caducó o se cerró. Inicia sesión de nuevo.",
        })
    return {"user": tokens["user"], **cuerpo_de_tokens(tokens)}


@router.post("/api/auth/logout")
async def api_logout(
    request: Request,
    payload: LogoutRequest | None = Body(default=None),
    lixbon_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """Cierra la sesión de quien llama: la cookie web y/o la sesión del
    dispositivo (por su access o su refresh). Nunca revoca API keys."""
    if lixbon_session:
        delete_web_session(lixbon_session)
    for raw in (get_bearer_token(authorization), payload.refresh_token if payload else None):
        if raw and raw.startswith(("lixbon_at_", "lixbon_rt_")):
            cerrada = revoke_session_token(raw)
            if cerrada:
                log_audit_event("session_revoked", user_id=cerrada["user_id"],
                                ip_address=_client_ip(request), client=cerrada["client"])
    response = JSONResponse({"message": "Logout correcto"})
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.get("/api/auth/me")
async def api_me(user_data: dict[str, Any] = Depends(session_or_api_key)):
    """Usuario actual + plan vigente + preferencias (para hidratar la web al cargar)."""
    from core.persistence.queries import get_plan_for_user, get_user_settings
    plan = get_plan_for_user(user_data["id"])
    settings = get_user_settings(user_data["id"])
    return {"user": {**user_data, "plan_id": plan["id"], "plan_name": plan["name"],
                     "settings": settings}}


@router.get("/api/auth/sessions")
async def api_sessions(user_data: dict[str, Any] = Depends(session_required)):
    actual = user_data.get("session_id")
    return {"sessions": [{**s, "current": s["id"] == actual}
                         for s in list_user_sessions(user_data["id"])]}


@router.delete("/api/auth/sessions/{session_id}")
async def api_revoke_session(session_id: int, request: Request,
                             user_data: dict[str, Any] = Depends(session_required)):
    if not revoke_session(session_id, user_data["id"]):
        raise HTTPException(status_code=404, detail="La sesión no existe o no te pertenece")
    log_audit_event("session_revoked", user_id=user_data["id"], ip_address=_client_ip(request),
                    session_id=session_id)
    return {"revoked": True, "session_id": session_id}


@router.delete("/api/auth/sessions")
async def api_revoke_other_sessions(request: Request,
                                    user_data: dict[str, Any] = Depends(session_required)):
    """Cierra todas las sesiones salvo la de quien llama."""
    n = revoke_other_sessions(user_data["id"], user_data.get("session_id"))
    log_audit_event("sessions_revoked_others", user_id=user_data["id"],
                    ip_address=_client_ip(request), count=n)
    return {"revoked": n}


@router.get("/api/auth/verify-email")
async def verify_email(token: str):
    user_id = consume_email_token(token, "verify_email")
    if not user_id:
        raise HTTPException(status_code=400, detail="Enlace inválido o expirado")
    mark_email_verified(user_id)
    log_audit_event("email_verified", user_id=user_id)

    usuario = get_user_by_id(user_id)
    if usuario and usuario.get("email"):
        en_segundo_plano(send_welcome_email(usuario["email"], get_plan_for_user(user_id)))
    return RedirectResponse(url="/?verified=1", status_code=303)


@router.post("/api/auth/resend-verification")
async def resend_verification(user_data: dict[str, Any] = Depends(session_required)):
    if user_data.get("email_verified"):
        return {"message": "El correo ya está verificado"}
    if not user_data.get("email"):
        raise HTTPException(status_code=400, detail="La cuenta no tiene correo asociado")
    token = create_email_token(user_data["id"], "verify_email", hours=48)
    if not await send_verification_email(user_data["email"], token):
        raise HTTPException(status_code=502,
                            detail="No se pudo enviar el correo. Inténtalo de nuevo en unos minutos.")
    return {"message": "Correo de verificación reenviado"}


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

    # Aviso al buzón, no a la pantalla: quien cambia la contraseña ya sabe que
    # la cambió. Este correo es para el caso contrario — que la haya cambiado
    # otro — y por eso sale aunque el cambio haya ido bien.
    usuario = get_user_by_id(user_id)
    if usuario and usuario.get("email"):
        en_segundo_plano(send_password_changed_email(
            usuario["email"],
            user_agent=request.headers.get("user-agent"),
            ip=_client_ip(request),
        ))
    return {"message": "Contraseña actualizada. Inicia sesión de nuevo."}


@router.post("/api/auth/api-key/regenerate")
async def regenerate_api_key(
    request: Request,
    user_data: dict[str, Any] = Depends(session_required),
):
    """Obsoleto: lo usa la app móvil anterior para «regenerar su clave». Rota solo
    la credencial de quien llama; las API keys manuales y las demás sesiones no
    se tocan. Límite: 5 veces por día."""
    user_id = user_data["id"]
    ip = _client_ip(request)
    if user_data.get("client") == "web":
        raise HTTPException(status_code=400,
                            detail="Desde la web, cierra sesiones en Cuenta → Sesiones y dispositivos.")
    if count_daily_regenerations(user_id) >= 5:
        raise HTTPException(
            status_code=429,
            detail="Límite diario de regeneraciones alcanzado (máx. 5 por día)",
        )

    if user_data["auth_via"] == "api_key":
        deactivate_key(user_data["key_id"], user_id)
        client = _CLIENT_POR_KEY.get(user_data.get("key_name"), "mobile")
    else:
        revoke_session(user_data["session_id"], user_id)
        client = user_data["client"]
    tokens = create_device_session(user_id, client, ip_address=ip,
                                   user_agent=request.headers.get("user-agent"), legacy=True)
    log_audit_event("api_key_regenerated", user_id=user_id, ip_address=ip, client=client)

    return {
        "newApiKey": tokens["access_token"],
        "notice": "Guárdala: no se volverá a mostrar",
        "oldKeyDeactivated": True,
        "expiresAt": tokens["expires_at"],
    }
