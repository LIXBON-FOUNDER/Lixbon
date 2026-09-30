"""
push.py — Notificaciones push a la app móvil.

Android solo despierta una app cerrada a través de Firebase Cloud Messaging, así
que el gateway habla con FCM (HTTP v1) con la cuenta de servicio del proyecto de
Firebase en FCM_SERVICE_ACCOUNT (el JSON tal cual o en base64). Sin esa variable
el push queda desactivado y la app sigue avisando mientras está abierta.
Los tokens de Expo que registraron versiones anteriores de la app van por el
servicio de Expo, como antes.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from typing import Any

import jwt

from core.gateway import deps
from core.persistence.queries import delete_device_token, list_device_tokens

log = logging.getLogger("lixbon")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
# Debe coincidir con el canal que crea la app (src/push.js).
ANDROID_CHANNEL = "remote"

_account: dict[str, Any] | None = None
_access: tuple[str, float] | None = None


def _service_account() -> dict[str, Any] | None:
    global _account
    if _account is None:
        raw = (os.getenv("FCM_SERVICE_ACCOUNT") or "").strip()
        if not raw:
            return None
        try:
            if not raw.startswith("{"):
                raw = base64.b64decode(raw).decode("utf-8")
            data = json.loads(raw)
            if data.get("client_email") and data.get("private_key") and data.get("project_id"):
                _account = data
        except (ValueError, UnicodeDecodeError):
            log.warning("[push] FCM_SERVICE_ACCOUNT no es un JSON de cuenta de servicio válido")
    return _account


def push_enabled() -> bool:
    return _service_account() is not None


async def _fcm_token(account: dict[str, Any]) -> str | None:
    global _access
    if _access and _access[1] > time.time() + 60:
        return _access[0]
    now = int(time.time())
    token_uri = account.get("token_uri") or "https://oauth2.googleapis.com/token"
    assertion = jwt.encode(
        {"iss": account["client_email"], "scope": FCM_SCOPE, "aud": token_uri, "iat": now, "exp": now + 3600},
        account["private_key"],
        algorithm="RS256",
    )
    resp = await deps.http_client_fast.post(
        token_uri,
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
    )
    if resp.status_code != 200:
        log.warning(f"[push] Google rechazó la cuenta de servicio: {resp.status_code} {resp.text[:200]}")
        return None
    body = resp.json()
    _access = (body["access_token"], time.time() + int(body.get("expires_in", 3600)))
    return _access[0]


async def _send_fcm(tokens: list[str], title: str, body: str, data: dict[str, Any]) -> None:
    account = _service_account()
    if not account or not tokens:
        return
    access = await _fcm_token(account)
    if not access:
        return
    url = f"https://fcm.googleapis.com/v1/projects/{account['project_id']}/messages:send"
    # Mensaje solo de datos con las claves que lee expo-notifications: así la
    # pinta la app (su canal, su icono) y el toque llega a su listener.
    payload = {
        "title": title,
        "message": body,
        "body": json.dumps(data, ensure_ascii=False),
        "channelId": ANDROID_CHANNEL,
    }
    for token in tokens:
        resp = await deps.http_client_fast.post(
            url,
            headers={"Authorization": f"Bearer {access}"},
            json={"message": {"token": token, "data": payload, "android": {"priority": "high"}}},
        )
        if resp.status_code == 404 or "UNREGISTERED" in resp.text:
            await asyncio.to_thread(delete_device_token, token)
        elif resp.status_code >= 300:
            log.debug(f"[push] FCM {resp.status_code}: {resp.text[:200]}")


async def _send_expo(tokens: list[str], title: str, body: str, data: dict[str, Any]) -> None:
    if not tokens:
        return
    messages = [
        {"to": t, "title": title, "body": body, "data": data, "priority": "high", "channelId": ANDROID_CHANNEL}
        for t in tokens
    ]
    resp = await deps.http_client_fast.post(EXPO_PUSH_URL, json=messages)
    for token, ticket in zip(tokens, resp.json().get("data", [])):
        details = (ticket or {}).get("details") or {}
        if details.get("error") == "DeviceNotRegistered":
            await asyncio.to_thread(delete_device_token, token)


async def send_push(user_id: int, title: str, body: str, data: dict[str, Any]) -> None:
    """Best-effort: un fallo de push nunca afecta a la petición que lo originó."""
    if deps.http_client_fast is None:
        return
    try:
        tokens = await asyncio.to_thread(list_device_tokens, user_id)
        expo = [t for t in tokens if t.startswith("ExponentPushToken")]
        fcm = [t for t in tokens if not t.startswith("ExponentPushToken")]
        await _send_fcm(fcm, title, body, data)
        await _send_expo(expo, title, body, data)
    except Exception as exc:
        log.debug(f"[push] envío fallido: {exc}")


def push_task(user_id: int, title: str, body: str, data: dict[str, Any]) -> None:
    try:
        asyncio.get_running_loop().create_task(send_push(user_id, title, body, data))
    except RuntimeError:
        pass
