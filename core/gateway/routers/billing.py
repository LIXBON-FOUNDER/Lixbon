"""
billing.py — Planes públicos y uso de la cuenta (F5).
El cobro real llega en F7. Los endpoints de administración viven en
admin_panel.py (F6).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from core.billing.quota import usage_snapshot
from core.persistence.queries import (
    get_daily_metrics,
    get_plan_for_user,
    get_user_by_id,
    list_plans,
    log_audit_event,
    update_user_profile,
)
from core.security.auth import cookie_auth_required

router = APIRouter()


class ProfilePayload(BaseModel):
    first_name: str = Field(..., min_length=1, max_length=60)
    last_name: str = Field(..., min_length=1, max_length=60)


@router.get("/api/plans")
async def api_list_plans():
    """Planes activos para la página de precios. Público."""
    return {"plans": list_plans(active_only=True)}


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
