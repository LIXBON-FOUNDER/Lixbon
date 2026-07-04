"""
billing.py — Planes, uso de cuenta y asignación manual de plan (F5).
El cobro real llega en F7; aquí vive todo lo demás: pricing, "Mi cuenta"
y el endpoint admin (por ROL, no X-Admin-Token) para subir planes a mano.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core.billing.quota import usage_snapshot
from core.persistence.queries import (
    get_daily_metrics,
    get_plan_for_user,
    get_user_by_id,
    list_plans,
    list_users_admin,
    log_audit_event,
    set_user_plan,
)
from core.security.auth import admin_required, cookie_auth_required

router = APIRouter()


class SetPlanPayload(BaseModel):
    plan_id: str
    expires_at: str | None = None  # ISO; None = sin vencimiento


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


# ── Admin (rol) — asignación manual de planes (F5.7) ───────────────────────

@router.get("/api/admin/users")
async def api_admin_users(
    q: str | None = Query(default=None, max_length=120),
    _admin: dict[str, Any] = Depends(admin_required),
):
    return {"users": list_users_admin(q=q)}


@router.post("/api/admin/users/{user_id}/plan")
async def api_admin_set_plan(
    user_id: int,
    payload: SetPlanPayload,
    admin: dict[str, Any] = Depends(admin_required),
):
    if not get_user_by_id(user_id):
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if not set_user_plan(user_id, payload.plan_id, payload.expires_at):
        raise HTTPException(status_code=400, detail=f"El plan '{payload.plan_id}' no existe")
    log_audit_event("plan_assigned", user_id=user_id,
                    plan_id=payload.plan_id, assigned_by=admin["id"])
    return {"user_id": user_id, "plan_id": payload.plan_id}
