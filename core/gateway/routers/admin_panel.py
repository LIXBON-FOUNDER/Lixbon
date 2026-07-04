"""
admin_panel.py — API del panel de administración (F6). Todo por ROL admin.
Usuarios (plan, bloqueo, detalle de uso), planes editables, modelos del
cluster, audit log global y dashboard de métricas.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core.billing.quota import usage_snapshot
from core.gateway import deps
from core.persistence.queries import (
    count_active_keys,
    get_daily_metrics,
    get_global_stats,
    get_plan_for_user,
    get_user_by_id,
    list_audit_events,
    list_plans,
    list_users_admin,
    log_audit_event,
    set_user_active,
    set_user_plan,
    update_plan,
)
from core.security.auth import admin_required

router = APIRouter(prefix="/api/admin", tags=["admin-panel"])


class SetPlanPayload(BaseModel):
    plan_id: str
    expires_at: str | None = None  # ISO; None = sin vencimiento


class SetActivePayload(BaseModel):
    active: bool


class PlanUpdatePayload(BaseModel):
    name: str | None = None
    description: str | None = None
    price_monthly_cents: int | None = None
    messages_per_day: int | None = None
    tokens_per_month: int | None = None
    max_api_keys: int | None = None
    rate_limit_per_min: int | None = None
    allowed_models: list[str] | None = None   # [] o null explícito ⇒ todos
    is_active: bool | None = None


# ── Dashboard global ────────────────────────────────────────────────────────

@router.get("/metrics")
async def api_admin_metrics(
    days: int = Query(default=30, ge=1, le=90),
    _admin: dict[str, Any] = Depends(admin_required),
):
    """Totales del sistema + serie diaria (requests, tokens, latencia)."""
    stats = get_global_stats(days=days)
    nodes = deps.orquestador.estado_nodos()
    stats["nodes"] = {
        "total": len(nodes),
        "online": sum(1 for n in nodes if n["online"]),
    }
    return stats


# ── Usuarios ────────────────────────────────────────────────────────────────

@router.get("/users")
async def api_admin_users(
    q: str | None = Query(default=None, max_length=120),
    _admin: dict[str, Any] = Depends(admin_required),
):
    return {"users": list_users_admin(q=q)}


@router.get("/users/{user_id}")
async def api_admin_user_detail(
    user_id: int,
    _admin: dict[str, Any] = Depends(admin_required),
):
    """Detalle de un usuario: plan, uso del período, keys y serie de 30 días."""
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    plan = get_plan_for_user(user_id)
    return {
        "user": user,
        "plan": plan,
        "usage": usage_snapshot(user_id, plan),
        "active_keys": count_active_keys(user_id),
        "daily": get_daily_metrics(user_id, days_limit=30),
        "events": list_audit_events(user_id=user_id, limit=20),
    }


@router.post("/users/{user_id}/plan")
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


@router.post("/users/{user_id}/active")
async def api_admin_set_active(
    user_id: int,
    payload: SetActivePayload,
    admin: dict[str, Any] = Depends(admin_required),
):
    """Bloquea/desbloquea: sesiones y API keys dejan de valer al instante."""
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="No puedes bloquear tu propia cuenta")
    if not set_user_active(user_id, payload.active):
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    log_audit_event(
        "user_unblocked" if payload.active else "user_blocked",
        user_id=user_id, blocked_by=admin["id"],
    )
    return {"user_id": user_id, "is_active": payload.active}


# ── Planes (límites editables sin tocar la BD) ─────────────────────────────

@router.get("/plans")
async def api_admin_plans(_admin: dict[str, Any] = Depends(admin_required)):
    """Todos los planes, incluidos los inactivos."""
    return {"plans": list_plans(active_only=False)}


@router.patch("/plans/{plan_id}")
async def api_admin_update_plan(
    plan_id: str,
    payload: PlanUpdatePayload,
    admin: dict[str, Any] = Depends(admin_required),
):
    fields = payload.model_dump(exclude_unset=True)
    if "allowed_models" in fields:
        models = fields["allowed_models"]
        fields["allowed_models"] = json.dumps(models) if models else None
    if "is_active" in fields:
        fields["is_active"] = 1 if fields["is_active"] else 0
    plan = update_plan(plan_id, fields)
    if not plan:
        raise HTTPException(status_code=404, detail=f"El plan '{plan_id}' no existe (o no enviaste campos)")
    log_audit_event("plan_updated", user_id=admin["id"],
                    plan_id=plan_id, fields=sorted(fields))
    return {"plan": plan}


# ── Modelos del cluster ─────────────────────────────────────────────────────

@router.get("/models")
async def api_admin_models(_admin: dict[str, Any] = Depends(admin_required)):
    """Qué modelos existen, en qué nodos están y a qué planes pertenecen."""
    nodes = deps.orquestador.estado_nodos()
    by_model: dict[str, list[str]] = {}
    for n in nodes:
        for m in n.get("modelos", []):
            by_model.setdefault(m, []).append(n["id"])

    plans = list_plans(active_only=False)
    models = []
    for model_id, node_ids in sorted(by_model.items()):
        in_plans = [
            p["id"] for p in plans
            if not p["allowed_models"] or any(model_id.startswith(pref) for pref in p["allowed_models"])
        ]
        models.append({"id": model_id, "nodes": node_ids, "plans": in_plans})
    return {"models": models, "plans": plans}


# ── Audit log global ────────────────────────────────────────────────────────

@router.get("/audit")
async def api_admin_audit(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    event_type: str | None = Query(default=None, max_length=60),
    user_id: int | None = Query(default=None),
    _admin: dict[str, Any] = Depends(admin_required),
):
    return {"events": list_audit_events(
        user_id=user_id, limit=limit, offset=offset, event_type=event_type,
    )}
