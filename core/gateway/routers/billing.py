"""
billing.py — Planes públicos, uso y datos de la cuenta (F5+).
Los endpoints de administración viven en admin_panel.py (F6).
"""
from __future__ import annotations

import hashlib
import json as _json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from core.billing import stripe_gateway
from core.billing.quota import usage_snapshot
from core.persistence.queries import (
    check_user_password,
    delete_all_conversations,
    delete_user_account,
    export_user_data,
    get_daily_metrics,
    get_plan_for_user,
    get_user_by_id,
    get_user_settings,
    list_model_pricing,
    list_plans,
    log_audit_event,
    update_user_profile,
    update_user_settings,
)
from core.security.auth import cookie_auth_required, record_failed_auth

router = APIRouter()


class ProfilePayload(BaseModel):
    first_name: str = Field(..., min_length=1, max_length=60)
    last_name: str = Field(..., min_length=1, max_length=60)


class SettingsPayload(BaseModel):
    """PATCH parcial: solo se actualiza lo que venga no-nulo."""
    anonymous_usage: bool | None = None
    save_history: bool | None = None


@router.get("/api/plans")
async def api_list_plans():
    """Planes activos para la página de precios. Público."""
    return {"plans": list_plans(active_only=True)}


@router.get("/api/pricing")
async def api_pricing():
    """Público: tarifas por tokens de la API (para la página de precios y las docs).
    Precios en USD por millón de tokens."""
    rows = list_model_pricing(active_only=True)
    return {"pricing": [
        {
            "model_prefix": r["model_prefix"],
            "display_name": r["display_name"],
            "input_usd_per_mtok": r["input_microusd_per_mtok"] / 1_000_000,
            "output_usd_per_mtok": r["output_microusd_per_mtok"] / 1_000_000,
        }
        for r in rows
    ]}


@router.get("/api/account/usage")
async def api_account_usage(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Mi cuenta: plan vigente, uso del período y serie diaria para la gráfica."""
    user_id = user_data["id"]
    plan = get_plan_for_user(user_id)
    return {
        "plan": plan,
        "usage": usage_snapshot(user_id, plan),
        "daily": get_daily_metrics(user_id, days_limit=30),
    }


@router.patch("/api/account/profile")
async def api_update_profile(
    payload: ProfilePayload,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Actualiza el nombre del usuario (sección General de Ajustes)."""
    user_id = user_data["id"]
    update_user_profile(user_id, payload.first_name.strip(), payload.last_name.strip())
    log_audit_event("profile_updated", user_id=user_id)
    return {"user": get_user_by_id(user_id)}


class DeleteAccountPayload(BaseModel):
    password: str = Field(..., min_length=1, max_length=200)


@router.get("/api/account/export")
async def api_export_data(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Descarga una copia de los datos del usuario (JSON). Privacidad → Tus datos."""
    from datetime import datetime, timezone

    data = export_user_data(user_data["id"])
    if data is None:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    log_audit_event("data_exported", user_id=user_data["id"])
    fname = f"lixbon-export-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.json"
    return Response(
        content=_json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.delete("/api/account/conversations")
async def api_clear_history(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Borra TODAS las conversaciones del usuario (el uso agregado se conserva)."""
    deleted = delete_all_conversations(user_data["id"])
    log_audit_event("history_cleared", user_id=user_data["id"], deleted=deleted)
    return {"deleted": deleted}


@router.delete("/api/account")
async def api_delete_account(
    payload: DeleteAccountPayload,
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Elimina la cuenta y todos sus datos. Requiere reautenticación con contraseña."""
    from core.gateway.routers.auth import SESSION_COOKIE

    user_id = user_data["id"]
    ip = request.client.host if request.client else None
    if not check_user_password(user_id, payload.password):
        record_failed_auth(ip or "unknown")
        raise HTTPException(status_code=403, detail="Contraseña incorrecta")

    log_audit_event("account_delete_requested", user_id=user_id, ip_address=ip)
    # Cancelar la suscripción de Stripe antes de perder la referencia (best-effort)
    stripe_gateway.cancel_subscription_immediately(user_id)

    email = user_data.get("email") or user_data.get("username") or ""
    if not delete_user_account(user_id):
        raise HTTPException(status_code=404, detail="Usuario no encontrado")

    # Rastro sin PII: hash del correo por si hace falta atender una reclamación
    log_audit_event(
        "account_deleted",
        ip_address=ip,
        email_hash=hashlib.sha256(email.lower().encode()).hexdigest() if email else None,
    )
    response = JSONResponse({"message": "Cuenta eliminada"})
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.get("/api/account/settings")
async def api_get_settings(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Preferencias del usuario (privacidad e historial), con defaults aplicados."""
    return {"settings": get_user_settings(user_data["id"])}


@router.patch("/api/account/settings")
async def api_update_settings(
    payload: SettingsPayload,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Actualiza las preferencias (PATCH parcial, sección Privacidad de Ajustes)."""
    user_id = user_data["id"]
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    settings = update_user_settings(user_id, patch)
    log_audit_event("settings_updated", user_id=user_id, **patch)
    return {"settings": settings}
