"""
payments.py — Endpoints de pagos con Stripe (F7).
Checkout, portal de cliente, webhook y estado de facturación. Si Stripe no está
configurado, /config informa enabled:false y los demás devuelven 503.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from core.billing import stripe_gateway as sg
from core.billing.credits import microusd_to_usd
from core.config import STRIPE_PUBLISHABLE_KEY
from core.persistence.queries import (
    credit_usage_daily,
    get_credit_balance,
    get_credit_pack,
    get_plan_for_user,
    get_subscription,
    list_credit_ledger,
    list_credit_packs,
)
from core.security.auth import cookie_auth_required

logger = logging.getLogger("lixbon.payments")
router = APIRouter(prefix="/api/billing", tags=["billing"])
credits_router = APIRouter(prefix="/api/credits", tags=["credits"])


class CheckoutPayload(BaseModel):
    plan_id: str


class CreditCheckoutPayload(BaseModel):
    pack_id: str


def _require_enabled():
    if not sg.enabled():
        raise HTTPException(status_code=503, detail={
            "code": "billing_disabled",
            "message": "Los pagos en línea aún no están disponibles.",
        })


@router.get("/config")
async def billing_config():
    """Público: ¿está habilitado el pago? (para que la web muestre el CTA correcto)."""
    return {"enabled": sg.enabled(), "publishable_key": STRIPE_PUBLISHABLE_KEY or None}


@router.post("/checkout")
async def create_checkout(
    payload: CheckoutPayload,
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    _require_enabled()
    try:
        url = sg.create_checkout_session(user_data, payload.plan_id, str(request.base_url))
    except ValueError as exc:
        msg = {
            "plan_inexistente": "Ese plan no existe.",
            "plan_sin_precio": "Ese plan aún no tiene un precio configurado.",
        }.get(str(exc), "No se pudo iniciar el pago.")
        raise HTTPException(status_code=400, detail={"code": str(exc), "message": msg})
    except Exception as exc:
        logger.error(f"checkout falló: {exc}")
        raise HTTPException(status_code=502, detail="No se pudo contactar con la pasarela de pago")
    return {"url": url}


@router.post("/portal")
async def create_portal(
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    _require_enabled()
    try:
        url = sg.create_portal_session(user_data, str(request.base_url))
    except ValueError:
        raise HTTPException(status_code=400, detail={
            "code": "no_subscription",
            "message": "No tienes una suscripción activa que gestionar.",
        })
    except Exception as exc:
        logger.error(f"portal falló: {exc}")
        raise HTTPException(status_code=502, detail="No se pudo abrir el portal de facturación")
    return {"url": url}


@router.get("/status")
async def billing_status(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Estado de facturación para la sección Ajustes → Facturación."""
    user_id = user_data["id"]
    plan = get_plan_for_user(user_id)
    sub = get_subscription(user_id)
    paid = bool(sub and sub.get("stripe_subscription_id"))
    return {
        "enabled": sg.enabled(),
        "plan": plan,
        "is_paid": paid,
        "current_period_end": sub.get("current_period_end") if sub else None,
        "cancel_at_period_end": sub.get("cancel_at_period_end") if sub else False,
        "payment_method": sg.payment_method_summary(user_data) if paid else None,
        "invoices": sg.list_invoices(user_data) if paid else [],
    }


# ── Créditos prepago de la API (cobro por tokens) ──────────────────────────

def _ledger_row_public(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "delta_usd": microusd_to_usd(row["delta_microusd"]),
        "balance_after_usd": microusd_to_usd(row["balance_after_microusd"]),
        "model": row["model"],
        "prompt_tokens": row["prompt_tokens"],
        "completion_tokens": row["completion_tokens"],
        "note": row["note"],
        "created_at": row["created_at"],
    }


@credits_router.get("/packs")
async def credit_packs():
    """Público: packs de recarga disponibles (la web los muestra aunque el
    checkout esté deshabilitado)."""
    return {
        "enabled": sg.enabled(),
        "packs": [
            {
                "id": p["id"],
                "name": p["name"],
                "credit_usd": microusd_to_usd(p["credit_microusd"]),
                "price_usd": p["price_cents"] / 100,
                "currency": p["currency"],
            }
            for p in list_credit_packs()
        ],
    }


@credits_router.post("/checkout")
async def credit_checkout(
    payload: CreditCheckoutPayload,
    request: Request,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Inicia el pago único de un pack de créditos."""
    _require_enabled()
    pack = get_credit_pack(payload.pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail={
            "code": "pack_inexistente", "message": "Ese pack de créditos no existe.",
        })
    try:
        url = sg.create_credit_checkout(user_data, pack, str(request.base_url))
    except Exception as exc:
        logger.error(f"checkout de créditos falló: {exc}")
        raise HTTPException(status_code=502, detail="No se pudo contactar con la pasarela de pago")
    return {"url": url}


@credits_router.get("")
async def credit_status(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Saldo actual + últimos movimientos, para Ajustes → Facturación."""
    user_id = user_data["id"]
    balance = get_credit_balance(user_id)
    return {
        "enabled": sg.enabled(),
        "balance_usd": microusd_to_usd(balance),
        "ledger": [_ledger_row_public(r) for r in list_credit_ledger(user_id, limit=50)],
    }


@credits_router.get("/usage")
async def credit_usage(
    days: int = 30,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Consumo facturable de la API por día y modelo (del ledger)."""
    days = max(1, min(days, 90))
    rows = credit_usage_daily(user_data["id"], days=days)
    return {
        "days": days,
        "daily": [
            {
                "date": r["date"],
                "model": r["model"],
                "prompt_tokens": r["prompt_tokens"],
                "completion_tokens": r["completion_tokens"],
                "cost_usd": microusd_to_usd(r["cost_microusd"]),
                "requests": r["requests"],
            }
            for r in rows
        ],
    }


@router.post("/webhook")
async def stripe_webhook(request: Request):
    """Recibe eventos de Stripe (verificados por firma). Público."""
    _require_enabled()
    payload = await request.body()
    sig = request.headers.get("stripe-signature")
    try:
        event = sg.verify_and_parse(payload, sig)
    except Exception as exc:
        logger.warning(f"webhook inválido: {exc}")
        raise HTTPException(status_code=400, detail="Firma de webhook inválida")
    try:
        sg.handle_event(event)
    except Exception as exc:
        etype = event.get("type", "?") if isinstance(event, dict) else "?"
        logger.error(f"error procesando webhook {etype}: {exc}")
        # 200 igualmente: Stripe reintenta ante 5xx; evitamos bucles por errores no transitorios
    return {"received": True}
