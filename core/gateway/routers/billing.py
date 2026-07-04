"""
billing.py — Planes públicos y uso de la cuenta (F5).
El cobro real llega en F7. Los endpoints de administración viven en
admin_panel.py (F6).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from core.billing.quota import usage_snapshot
from core.persistence.queries import (
    get_daily_metrics,
    get_plan_for_user,
    list_plans,
)
from core.security.auth import cookie_auth_required

router = APIRouter()


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
