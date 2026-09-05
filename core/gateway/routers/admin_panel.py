"""
admin_panel.py — API del panel de administración (F6). Todo por ROL admin.
Usuarios (plan, bloqueo, detalle de uso), planes editables, modelos del
cluster, audit log global y dashboard de métricas.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core.billing.credits import invalidate_pricing_cache, microusd_to_usd
from core.billing.quota import usage_snapshot
from core.gateway import deps
from core.gateway.utils import fetch_models
from core.inference.roles import (
    REQUIRED_CAPABILITY,
    ROLES,
    capabilities_of,
    has_capability,
    invalidate_roles_cache,
    resolve_all,
    resolve_role,
)
from core.persistence.queries import (
    admin_credits_summary,
    count_active_keys,
    create_model_pricing,
    credit_purchase,
    delete_model_pricing,
    get_credit_balance,
    get_daily_metrics,
    get_global_stats,
    get_plan_for_user,
    get_user_by_email,
    get_user_by_id,
    list_audit_events,
    list_model_pricing,
    list_model_roles,
    list_plans,
    list_users_admin,
    log_audit_event,
    set_user_active,
    set_user_plan,
    update_model_pricing,
    update_plan,
    upsert_model_role,
)
from core.security.auth import admin_required

logger = logging.getLogger("lixbon.admin")

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
    stripe_price_id: str | None = None         # F7: price_ de Stripe (null = desconectar)


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


# ── Tarifas por modelo (créditos de API) ────────────────────────────────────

_USD_PER_MICRO = 1_000_000


def _pricing_public(row: dict[str, Any]) -> dict[str, Any]:
    return {
        **row,
        "input_usd_per_mtok": row["input_microusd_per_mtok"] / _USD_PER_MICRO,
        "output_usd_per_mtok": row["output_microusd_per_mtok"] / _USD_PER_MICRO,
    }


class PricingCreatePayload(BaseModel):
    model_prefix: str
    display_name: str | None = None
    input_usd_per_mtok: float = 0.0   # la UI trabaja en $/Mtok; aquí se convierte a µ$
    output_usd_per_mtok: float = 0.0
    sort_order: int = 0


class PricingUpdatePayload(BaseModel):
    display_name: str | None = None
    input_usd_per_mtok: float | None = None
    output_usd_per_mtok: float | None = None
    is_active: bool | None = None
    sort_order: int | None = None


@router.get("/pricing")
async def api_admin_pricing(_admin: dict[str, Any] = Depends(admin_required)):
    return {"pricing": [_pricing_public(r) for r in list_model_pricing(active_only=False)]}


@router.post("/pricing")
async def api_admin_pricing_create(
    payload: PricingCreatePayload,
    admin: dict[str, Any] = Depends(admin_required),
):
    prefix = payload.model_prefix.strip()
    if not prefix:
        raise HTTPException(status_code=400, detail="Falta el prefijo del modelo")
    row = create_model_pricing(
        prefix,
        payload.display_name,
        round(payload.input_usd_per_mtok * _USD_PER_MICRO),
        round(payload.output_usd_per_mtok * _USD_PER_MICRO),
        payload.sort_order,
    )
    if not row:
        raise HTTPException(status_code=409, detail="Ya existe una tarifa con ese prefijo")
    invalidate_pricing_cache()
    log_audit_event("pricing_created", user_id=admin["id"], model_prefix=prefix)
    return {"pricing": _pricing_public(row)}


@router.patch("/pricing/{pricing_id}")
async def api_admin_pricing_update(
    pricing_id: int,
    payload: PricingUpdatePayload,
    admin: dict[str, Any] = Depends(admin_required),
):
    fields: dict[str, Any] = {
        "display_name": payload.display_name,
        "is_active": payload.is_active,
        "sort_order": payload.sort_order,
    }
    if payload.input_usd_per_mtok is not None:
        fields["input_microusd_per_mtok"] = round(payload.input_usd_per_mtok * _USD_PER_MICRO)
    if payload.output_usd_per_mtok is not None:
        fields["output_microusd_per_mtok"] = round(payload.output_usd_per_mtok * _USD_PER_MICRO)
    row = update_model_pricing(pricing_id, **fields)
    if not row:
        raise HTTPException(status_code=404, detail="Tarifa no encontrada")
    invalidate_pricing_cache()
    log_audit_event("pricing_updated", user_id=admin["id"], pricing_id=pricing_id)
    return {"pricing": _pricing_public(row)}


@router.delete("/pricing/{pricing_id}")
async def api_admin_pricing_delete(
    pricing_id: int,
    admin: dict[str, Any] = Depends(admin_required),
):
    if not delete_model_pricing(pricing_id):
        raise HTTPException(status_code=400, detail="No existe o es la tarifa por defecto (*)")
    invalidate_pricing_cache()
    log_audit_event("pricing_deleted", user_id=admin["id"], pricing_id=pricing_id)
    return {"deleted": True}


class ModelRolePayload(BaseModel):
    model: str | None = None        # "" desasigna (vuelve al default de env)
    keep_alive: str | None = None   # "30m" | "-1" | "0"
    num_ctx: int | None = None
    is_active: bool | None = None
    notes: str | None = None
    # Permite asignar un modelo que aún no está descargado o que no declara la
    # capability del rol (p. ej. preparar el nodo antes del `ollama pull`).
    force: bool = False


@router.get("/model-roles")
async def api_admin_model_roles(_admin: dict[str, Any] = Depends(admin_required)):
    """Filas editables + cómo queda resuelto cada rol ahora mismo + catálogo."""
    catalog = await fetch_models()
    return {
        "roles": list_model_roles(active_only=False),
        "resolved": {r: res.as_dict() for r, res in resolve_all(catalog).items()},
        "capability_by_role": REQUIRED_CAPABILITY,
        "models": catalog,
    }


@router.patch("/model-roles/{role}")
async def api_admin_model_role_update(
    role: str,
    payload: ModelRolePayload,
    admin: dict[str, Any] = Depends(admin_required),
):
    if role not in ROLES:
        raise HTTPException(status_code=404, detail=f"Rol desconocido: {role}")

    catalog = await fetch_models()
    modelo = (payload.model or "").strip()
    if modelo and not payload.force:
        required = REQUIRED_CAPABILITY[role]
        if not has_capability(catalog, modelo, required):
            raise HTTPException(status_code=409, detail={
                "code": "capability_mismatch",
                "message": (f"`{modelo}` no declara la capacidad `{required}` que "
                            f"necesita el rol `{role}`. Envía force=true para asignarlo igualmente."),
                "role": role, "model": modelo, "required_capability": required,
                "capabilities": capabilities_of(catalog, modelo),
            })

    row = upsert_model_role(
        role,
        model=payload.model,
        keep_alive=payload.keep_alive,
        num_ctx=payload.num_ctx,
        is_active=payload.is_active,
        notes=payload.notes,
    )
    invalidate_roles_cache()
    log_audit_event("model_role_updated", user_id=admin["id"], role=role, model=modelo or None)
    return {
        "role": row,
        "resolved": resolve_role(role, catalog).as_dict(),
    }


class GrantCreditsPayload(BaseModel):
    email: str
    amount_usd: float  # positivo acredita; negativo corrige (ajuste manual)
    note: str | None = None


@router.post("/credits/grant")
async def api_admin_credits_grant(
    payload: GrantCreditsPayload,
    admin: dict[str, Any] = Depends(admin_required),
):
    """Acredita saldo de API a un usuario sin pasar por Stripe (pruebas,
    promociones, soporte). Queda en el ledger con kind='grant'."""
    if not (-1000.0 <= payload.amount_usd <= 1000.0) or payload.amount_usd == 0:
        raise HTTPException(status_code=400, detail="Monto fuera de rango (±1000 USD, distinto de 0)")
    user = get_user_by_email(payload.email.strip().lower())
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    amount_microusd = round(payload.amount_usd * 1_000_000)
    note = payload.note or f"grant admin ({admin.get('email', admin['id'])})"
    credit_purchase(user["id"], amount_microusd, note=note, kind="grant")
    log_audit_event(
        "credits_granted", user_id=admin["id"],
        target_user=user["id"], amount_usd=payload.amount_usd,
    )
    return {
        "granted_usd": payload.amount_usd,
        "balance_usd": microusd_to_usd(get_credit_balance(user["id"])),
    }


@router.get("/credits/summary")
async def api_admin_credits_summary(_admin: dict[str, Any] = Depends(admin_required)):
    """Ingresos (suscripciones + recargas) y consumo de créditos del mes."""
    data = admin_credits_summary()
    return {
        "month": data["month"],
        # Ingresos: dinero que entra
        "subscription_mrr_usd": microusd_to_usd(data["subscription_mrr_microusd"]),
        "active_subscriptions": data["active_subscriptions"],
        "topups_usd": microusd_to_usd(data["topups_microusd"]),
        "purchases": data["purchases"],
        "total_revenue_usd": microusd_to_usd(data["total_revenue_microusd"]),
        # Consumo de créditos: saldo prepago gastado (no es ingreso)
        "usage_by_model": [
            {**r, "cost_usd": microusd_to_usd(r["cost_microusd"])}
            for r in data["usage_by_model"]
        ],
        "top_consumers": [
            {**r, "cost_usd": microusd_to_usd(r["cost_microusd"])}
            for r in data["top_consumers"]
        ],
    }


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


# ── Pagos ───────────────────────────────────────────────────────────────────

def _pasarela_lista():
    from core.billing import stripe_gateway as sg
    if not sg.enabled():
        raise HTTPException(status_code=503, detail={
            "code": "billing_disabled",
            "message": "La pasarela de pagos no está configurada.",
        })
    return sg


@router.get("/payments/transactions")
async def api_admin_transactions(
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=255),
    q: str | None = Query(default=None, max_length=120),
    _admin: dict[str, Any] = Depends(admin_required),
):
    """Intentos de cobro que pasaron por la pasarela."""
    sg = _pasarela_lista()
    try:
        return sg.admin_transactions(limit=limit, starting_after=cursor, query=q)
    except Exception as exc:
        logger.exception("Fallo al leer las transacciones de la pasarela")
        raise HTTPException(status_code=503, detail=f"No se pudo leer la pasarela: {exc}")


@router.get("/payments/payouts")
async def api_admin_payouts(
    limit: int = Query(default=12, ge=1, le=50),
    _admin: dict[str, Any] = Depends(admin_required),
):
    """Depósitos de la pasarela en la cuenta del negocio."""
    sg = _pasarela_lista()
    try:
        return sg.admin_payouts(limit=limit)
    except Exception as exc:
        logger.exception("Fallo al leer las liquidaciones de la pasarela")
        raise HTTPException(status_code=503,
                            detail=f"No se pudieron leer las liquidaciones: {exc}")


@router.get("/payments/gateway")
async def api_admin_gateway(_admin: dict[str, Any] = Depends(admin_required)):
    """Estado de la pasarela. De solo lectura: las claves viven en variables de
    entorno, y editarlas desde aquí las guardaría en la base de datos."""
    sg = _pasarela_lista()
    try:
        return sg.admin_gateway()
    except Exception as exc:
        logger.exception("Fallo al leer el estado de la pasarela")
        raise HTTPException(status_code=503, detail=f"No se pudo leer la pasarela: {exc}")
