"""
oauth.py — Inicio de sesión con Google y Apple (app móvil y web).

Flujo (Authorization Code del lado del servidor + PKCE propio del cliente):
  1. El cliente genera un `code_verifier` aleatorio y abre en el navegador
     GET /api/auth/oauth/{provider}/start?redirect_uri=...&code_challenge=sha256(verifier).
  2. El gateway redirige al proveedor con SU client_id/secret (nunca viajan al cliente).
     El `state` es un blob firmado con HMAC: no requiere almacenamiento y caduca.
  3. El callback intercambia el code por el id_token DIRECTAMENTE con el proveedor
     (TLS servidor-a-servidor: no hace falta validar la firma del JWT), hace upsert
     del usuario por email y redirige al cliente con un código de un solo uso.
  4. El cliente canjea el código en POST /api/auth/oauth/exchange presentando el
     `code_verifier`: sin él, un código robado en la redirección no sirve de nada.

Config por entorno:
  GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
  APPLE_OAUTH_CLIENT_ID (Services ID) / APPLE_TEAM_ID / APPLE_KEY_ID /
  APPLE_PRIVATE_KEY (PEM de la key .p8; admite '\n' escapados)
Sin configurar ⇒ los endpoints responden 503 y los botones de la UI se ocultan
(GET /api/auth/oauth/providers).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from core.config import PUBLIC_BASE_URL
from core.persistence.queries import (
    create_user,
    create_web_session,
    get_user_by_email,
    log_audit_event,
    mark_email_verified,
    set_user_plan,
)
from core.security.auth import check_auth_rate_limit

router = APIRouter()

# Secreto para firmar el `state`. Por defecto uno aleatorio por arranque: los
# logins en curso durante un redeploy fallan (reintentar), pero no hay estado
# que persistir ni secreto que rotar a mano.
_STATE_SECRET = (os.getenv("OAUTH_STATE_SECRET") or secrets.token_hex(32)).encode()
_STATE_TTL = 600          # 10 min para completar el login en el navegador
_LOGIN_CODE_TTL = 300     # 5 min para canjear el código en la app

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", "")
APPLE_CLIENT_ID = os.getenv("APPLE_OAUTH_CLIENT_ID", "")
APPLE_TEAM_ID = os.getenv("APPLE_TEAM_ID", "")
APPLE_KEY_ID = os.getenv("APPLE_KEY_ID", "")
APPLE_PRIVATE_KEY = os.getenv("APPLE_PRIVATE_KEY", "").replace("\\n", "\n")

# Códigos de login de un solo uso: {code: (user_id, code_challenge, expira_epoch)}.
# En memoria a propósito: el gateway corre en una única instancia y los códigos
# viven 5 minutos; un reinicio solo obliga a repetir el login.
_login_codes: dict[str, tuple[int, str, float]] = {}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _sign_state(payload: dict[str, Any]) -> str:
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64url(hmac.new(_STATE_SECRET, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def _verify_state(state: str) -> dict[str, Any] | None:
    try:
        body, sig = state.split(".", 1)
        expected = _b64url(hmac.new(_STATE_SECRET, body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_b64url_decode(body))
        if time.time() - float(payload.get("ts", 0)) > _STATE_TTL:
            return None
        return payload
    except Exception:
        return None


def _validate_redirect_uri(uri: str) -> str:
    """Solo destinos que controla el usuario final: el esquema de la app móvil,
    los de desarrollo de Expo, o la propia web. Evita usar el callback como
    open redirect."""
    parsed = urlparse(uri)
    scheme = (parsed.scheme or "").lower()
    if scheme in {"lixbon", "exp", "exps"}:
        return uri
    if scheme in {"http", "https"}:
        host = (parsed.hostname or "").lower()
        public_host = (urlparse(PUBLIC_BASE_URL).hostname or "").lower() if PUBLIC_BASE_URL else ""
        if host in {"localhost", "127.0.0.1"} or (public_host and host == public_host):
            return uri
    raise HTTPException(status_code=400, detail="redirect_uri no permitida")


def _server_base(request: Request) -> str:
    return (PUBLIC_BASE_URL or str(request.base_url)).rstrip("/")


def _apple_client_secret() -> str:
    """Apple exige como client_secret un JWT ES256 firmado con la key .p8."""
    import jwt  # PyJWT[crypto]; import perezoso: Google no lo necesita

    now = int(time.time())
    return jwt.encode(
        {"iss": APPLE_TEAM_ID, "iat": now, "exp": now + 600,
         "aud": "https://appleid.apple.com", "sub": APPLE_CLIENT_ID},
        APPLE_PRIVATE_KEY,
        algorithm="ES256",
        headers={"kid": APPLE_KEY_ID},
    )


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    """Payload del id_token SIN validar firma: el token llegó por TLS directo
    del proveedor en el intercambio de código, no del cliente."""
    try:
        return json.loads(_b64url_decode(token.split(".")[1]))
    except Exception:
        return {}


def _provider_configured(provider: str) -> bool:
    if provider == "google":
        return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
    if provider == "apple":
        return bool(APPLE_CLIENT_ID and APPLE_TEAM_ID and APPLE_KEY_ID and APPLE_PRIVATE_KEY)
    return False


@router.get("/api/auth/oauth/providers")
async def oauth_providers():
    """Qué proveedores están configurados (la UI oculta los botones que no)."""
    return {"providers": [p for p in ("google", "apple") if _provider_configured(p)]}


@router.get("/api/auth/oauth/{provider}/start")
async def oauth_start(
    provider: str,
    request: Request,
    redirect_uri: str,
    code_challenge: str,
):
    if not _provider_configured(provider):
        raise HTTPException(status_code=503, detail=f"Login con {provider} no configurado")
    if not (16 <= len(code_challenge) <= 128):
        raise HTTPException(status_code=400, detail="code_challenge inválido")
    _validate_redirect_uri(redirect_uri)
    check_auth_rate_limit(request.client.host if request.client else "unknown")

    state = _sign_state({
        "p": provider,
        "r": redirect_uri,
        "c": code_challenge,
        "ts": time.time(),
        "n": secrets.token_urlsafe(8),
    })
    callback = f"{_server_base(request)}/api/auth/oauth/{provider}/callback"

    if provider == "google":
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
            "client_id": GOOGLE_CLIENT_ID,
            "redirect_uri": callback,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "prompt": "select_account",
        })
    else:
        # Apple: con scope name/email exige response_mode=form_post (el callback
        # llega por POST).
        url = "https://appleid.apple.com/auth/authorize?" + urlencode({
            "client_id": APPLE_CLIENT_ID,
            "redirect_uri": callback,
            "response_type": "code",
            "scope": "name email",
            "response_mode": "form_post",
            "state": state,
        })
    return RedirectResponse(url, status_code=302)


async def _exchange_code(provider: str, code: str, callback: str) -> dict[str, Any]:
    """Intercambia el authorization code por tokens con el proveedor."""
    if provider == "google":
        token_url = "https://oauth2.googleapis.com/token"
        data = {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": callback,
        }
    else:
        token_url = "https://appleid.apple.com/auth/token"
        data = {
            "client_id": APPLE_CLIENT_ID,
            "client_secret": _apple_client_secret(),
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": callback,
        }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(token_url, data=data)
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"El proveedor rechazó el código ({resp.status_code})")
    return resp.json()


def _upsert_oauth_user(provider: str, claims: dict[str, Any],
                       apple_user_form: dict | None, ip: str) -> dict[str, Any]:
    email = (claims.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="El proveedor no devolvió un email")

    user = get_user_by_email(email)
    created = False
    if not user:
        if provider == "google":
            first = claims.get("given_name") or email.split("@")[0]
            last = claims.get("family_name") or ""
        else:
            # Apple solo manda el nombre la PRIMERA vez, en el campo `user` del form.
            name = (apple_user_form or {}).get("name") or {}
            first = name.get("firstName") or email.split("@")[0]
            last = name.get("lastName") or ""
        # Cuenta sin contraseña utilizable: se rellena con una aleatoria fuerte.
        # Si el usuario quiere una, pasa por "olvidé mi contraseña".
        user = create_user(email, secrets.token_urlsafe(32), first, last)
        if not user:
            user = get_user_by_email(email)  # carrera: otro request la creó
        else:
            created = True
            set_user_plan(user["id"], "free")
    if not user:
        raise HTTPException(status_code=500, detail="No se pudo crear la cuenta")
    if not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="Cuenta desactivada")

    verified = claims.get("email_verified")
    if (verified is True or verified == "true") and not user.get("email_verified"):
        mark_email_verified(user["id"])

    log_audit_event("oauth_login_created" if created else "oauth_login",
                    user_id=user["id"], ip_address=ip, provider=provider)
    return user


def _finish_login(payload: dict[str, Any], user: dict[str, Any]) -> RedirectResponse:
    code = secrets.token_urlsafe(32)
    now = time.time()
    # Limpieza de códigos caducados de paso
    for k in [k for k, (_, _, exp) in _login_codes.items() if exp < now]:
        _login_codes.pop(k, None)
    _login_codes[code] = (user["id"], payload["c"], now + _LOGIN_CODE_TTL)
    sep = "&" if "?" in payload["r"] else "?"
    return RedirectResponse(f"{payload['r']}{sep}lixbon_code={code}", status_code=303)


@router.get("/api/auth/oauth/{provider}/callback")
async def oauth_callback_get(provider: str, request: Request,
                             state: str = "", code: str = "", error: str = ""):
    return await _handle_callback(provider, request, state, code, error, None)


@router.post("/api/auth/oauth/{provider}/callback")
async def oauth_callback_post(provider: str, request: Request):
    """Apple entrega el callback por POST (response_mode=form_post)."""
    form = await request.form()
    apple_user = None
    if form.get("user"):
        try:
            apple_user = json.loads(str(form.get("user")))
        except Exception:
            apple_user = None
    return await _handle_callback(
        provider, request,
        str(form.get("state") or ""), str(form.get("code") or ""),
        str(form.get("error") or ""), apple_user,
    )


async def _handle_callback(provider: str, request: Request, state: str,
                           code: str, error: str, apple_user: dict | None):
    if provider not in {"google", "apple"}:
        raise HTTPException(status_code=404, detail="Proveedor desconocido")
    payload = _verify_state(state)
    if not payload or payload.get("p") != provider:
        raise HTTPException(status_code=400, detail="state inválido o expirado; vuelve a intentarlo")
    if error or not code:
        # El usuario canceló en el proveedor: devolverlo a la app sin código.
        sep = "&" if "?" in payload["r"] else "?"
        return RedirectResponse(f"{payload['r']}{sep}lixbon_error=cancelled", status_code=303)

    callback = f"{_server_base(request)}/api/auth/oauth/{provider}/callback"
    tokens = await _exchange_code(provider, code, callback)
    claims = _decode_jwt_payload(tokens.get("id_token", ""))
    ip = request.client.host if request.client else "unknown"
    user = _upsert_oauth_user(provider, claims, apple_user, ip)
    return _finish_login(payload, user)


class ExchangePayload(BaseModel):
    code: str = Field(..., min_length=16, max_length=128)
    code_verifier: str = Field(..., min_length=16, max_length=128)
    issue_api_key: bool = False
    key_name: str | None = Field(default=None, max_length=60)


@router.post("/api/auth/oauth/exchange")
async def oauth_exchange(payload: ExchangePayload, request: Request):
    """Canjea el código de un solo uso por sesión (+ API key para apps)."""
    ip = request.client.host if request.client else "unknown"
    check_auth_rate_limit(ip)

    entry = _login_codes.pop(payload.code, None)
    if not entry or entry[2] < time.time():
        raise HTTPException(status_code=400, detail="Código inválido o expirado")
    user_id, challenge, _exp = entry

    verifier_hash = _b64url(hashlib.sha256(payload.code_verifier.encode()).digest())
    if not hmac.compare_digest(verifier_hash, challenge):
        raise HTTPException(status_code=400, detail="code_verifier incorrecto")

    from core.persistence.queries import get_user_by_id
    user = get_user_by_id(user_id)
    if not user or not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="Cuenta no disponible")

    session_token = create_web_session(user_id, ip, request.headers.get("user-agent"))
    body: dict[str, Any] = {"message": "Login correcto", "user": user}

    if payload.issue_api_key:
        from core.gateway.routers.auth import issue_named_api_key
        raw_key = issue_named_api_key(user_id, payload.key_name or "Lixbon Mobile", ip)
        body["api_key"] = raw_key
        body["api_key_notice"] = "Guárdala: no se volverá a mostrar"

    from core.gateway.routers.auth import SESSION_COOKIE, _set_session_cookie
    response = JSONResponse(body)
    _set_session_cookie(response, session_token)
    return response


@router.get("/api/auth/oauth/done", response_class=HTMLResponse)
async def oauth_done():
    """Página mínima de aterrizaje si el navegador no puede volver a la app."""
    return HTMLResponse(
        "<!doctype html><meta charset='utf-8'><title>Lixbon</title>"
        "<body style='font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'>"
        "<p>Listo. Ya puedes volver a la aplicación.</p></body>"
    )
