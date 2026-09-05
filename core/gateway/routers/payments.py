"""
payments.py — Endpoints de pagos.

El cobro ocurre dentro de lixbon: no hay Checkout alojado ni portal de cliente.
El navegador guarda la tarjeta contra Stripe con Elements y aquí solo entra un
`pm_...`; con ese id se crean la suscripción y las recargas de saldo. Si Stripe
no está configurado, /config informa enabled:false y el resto devuelve 503.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.billing import stripe_gateway as sg
from core.billing.credits import MICRO_PER_USD, microusd_to_usd
from core.config import STRIPE_PUBLISHABLE_KEY
from core.persistence.queries import (
    credit_usage_daily,
    get_credit_account,
    get_credit_pack,
    get_plan_for_user,
    get_subscription,
    list_credit_ledger,
    list_credit_packs,
    set_autoreload,
)
from core.security.auth import cookie_auth_required

logger = logging.getLogger("lixbon.payments")
router = APIRouter(prefix="/api/billing", tags=["billing"])
credits_router = APIRouter(prefix="/api/credits", tags=["credits"])


class SubscribePayload(BaseModel):
    plan_id: str
    payment_method_id: str = Field(..., min_length=3, max_length=255)


class PaymentMethodPayload(BaseModel):
    payment_method_id: str = Field(..., min_length=3, max_length=255)


class ResolvePayload(BaseModel):
    payment_intent_id: str = Field(..., min_length=3, max_length=255)


class TopupPayload(BaseModel):
    pack_id: str
    payment_method_id: str = Field(..., min_length=3, max_length=255)
    guardar: bool = True


class AutoreloadPayload(BaseModel):
    enabled: bool
    pack_id: str | None = None
    threshold_usd: float = Field(default=5.0, ge=0, le=10_000)
    payment_method_id: str | None = None


def _require_enabled():
    if not sg.enabled():
        raise HTTPException(status_code=503, detail={
            "code": "billing_disabled",
            "message": "Los pagos en línea aún no están disponibles.",
        })


_ERRORES = {
    "plan_inexistente": "Ese plan no existe.",
    "plan_sin_precio": "Ese plan aún no tiene un precio configurado.",
    "mismo_plan": "Ya estás en ese plan.",
    "sin_suscripcion": "No tienes una suscripción activa.",
    "sin_cliente": "Todavía no tienes ningún método de pago guardado.",
    "metodo_ajeno": "Esa tarjeta no es tuya.",
    "cobro_ajeno": "Ese cobro no es tuyo.",
    "ultima_tarjeta": "Es la única tarjeta de una suscripción activa. Añade otra antes "
                      "de quitar esta, o cancela la suscripción.",
}


def _fallo(exc: Exception, generico: str) -> HTTPException:
    """Traduce un fallo de Stripe. El rechazo del banco es un 402 con el motivo
    tal cual lo da el emisor: es lo único que le sirve al usuario para decidir
    si reintenta o cambia de tarjeta."""
    if isinstance(exc, ValueError):
        codigo = str(exc)
        if codigo in _ERRORES:
            estado = 403 if codigo in ("metodo_ajeno", "cobro_ajeno") else 400
            return HTTPException(status_code=estado,
                                 detail={"code": codigo, "message": _ERRORES[codigo]})
    if "CardError" in type(exc).__name__:
        return HTTPException(status_code=402, detail={
            "code": getattr(exc, "code", None) or "card_declined",
            "decline_code": getattr(exc, "decline_code", None),
            "message": getattr(exc, "user_message", None)
                       or "El banco rechazó el cobro. Prueba con otra tarjeta.",
        })
    logger.error(f"{generico}: {exc}")
    return HTTPException(status_code=502, detail={
        "code": "gateway_error", "message": generico,
    })


@router.get("/config")
async def billing_config():
    """Público: la web necesita la clave publicable para montar Elements."""
    return {"enabled": sg.enabled(), "publishable_key": STRIPE_PUBLISHABLE_KEY or None}


# ── Tarjetas guardadas ──────────────────────────────────────────────────────

@router.post("/setup-intent")
async def create_setup_intent(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Secreto para que el navegador guarde una tarjeta nueva sin cobrar."""
    _require_enabled()
    try:
        return sg.create_setup_intent(user_data)
    except Exception as exc:
        raise _fallo(exc, "No se pudo preparar el formulario de tarjeta")


@router.get("/payment-methods")
async def list_payment_methods(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    return {"payment_methods": sg.list_payment_methods(user_data)}


@router.post("/payment-methods/default")
async def set_default_payment_method(
    payload: PaymentMethodPayload,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    _require_enabled()
    try:
        sg.set_default_payment_method(user_data, payload.payment_method_id)
    except Exception as exc:
        raise _fallo(exc, "No se pudo cambiar la tarjeta predeterminada")
    return {"payment_methods": sg.list_payment_methods(user_data)}


@router.delete("/payment-methods/{pm_id}")
async def delete_payment_method(
    pm_id: str,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    _require_enabled()
    try:
        sg.detach_payment_method(user_data, pm_id)
    except Exception as exc:
        raise _fallo(exc, "No se pudo quitar la tarjeta")
    return {"payment_methods": sg.list_payment_methods(user_data)}


# ── Suscripción ─────────────────────────────────────────────────────────────

@router.post("/subscribe")
async def subscribe(
    payload: SubscribePayload,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Alta o cambio de plan con una tarjeta guardada. Si el banco pide
    confirmación, devuelve el secreto para que el navegador la resuelva."""
    _require_enabled()
    try:
        return sg.subscribe(user_data, payload.plan_id, payload.payment_method_id)
    except Exception as exc:
        raise _fallo(exc, "No se pudo activar la suscripción")


@router.post("/cancel")
async def cancel(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    _require_enabled()
    try:
        return sg.cancel_subscription(user_data)
    except Exception as exc:
        raise _fallo(exc, "No se pudo cancelar la suscripción")


@router.post("/resume")
async def resume(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    _require_enabled()
    try:
        return sg.resume_subscription(user_data)
    except Exception as exc:
        raise _fallo(exc, "No se pudo reactivar la suscripción")


@router.post("/resolve")
async def resolve(
    payload: ResolvePayload,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Cierra un cobro que pasó por el banco sin esperar al webhook."""
    _require_enabled()
    try:
        return sg.resolve_payment(user_data, payload.payment_intent_id)
    except Exception as exc:
        raise _fallo(exc, "No se pudo confirmar el cobro")


@router.get("/status")
async def billing_status(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Todo lo que pinta Ajustes → Facturación en una sola llamada."""
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
        "payment_methods": sg.list_payment_methods(user_data),
        "charges": sg.list_charges(user_data),
        "invoices": sg.list_invoices(user_data) if paid else [],
    }


# ── Créditos prepago de la API ──────────────────────────────────────────────

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
    """Público: packs de recarga disponibles."""
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


@credits_router.post("/topup")
async def topup(
    payload: TopupPayload,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Recarga el saldo cobrando una tarjeta guardada."""
    _require_enabled()
    pack = get_credit_pack(payload.pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail={
            "code": "pack_inexistente", "message": "Ese pack de créditos no existe.",
        })
    try:
        return sg.charge_topup(user_data, pack, payload.payment_method_id,
                               guardar=payload.guardar)
    except Exception as exc:
        raise _fallo(exc, "No se pudo cobrar la recarga")


@credits_router.put("/autoreload")
async def update_autoreload(
    payload: AutoreloadPayload,
    user_data: dict[str, Any] = Depends(cookie_auth_required),
):
    """Recarga automática: cobra el pack elegido cuando el saldo baja del umbral."""
    if payload.enabled:
        _require_enabled()
        if not payload.pack_id or not get_credit_pack(payload.pack_id):
            raise HTTPException(status_code=400, detail={
                "code": "pack_inexistente",
                "message": "Elige cuánto quieres que se recargue.",
            })
        if not payload.payment_method_id:
            raise HTTPException(status_code=400, detail={
                "code": "sin_metodo",
                "message": "Elige con qué tarjeta se cobrará la recarga.",
            })
        # La tarjeta la elige el navegador: sin comprobar que es de este cliente
        # se podría dejar apuntando a la de otro usuario.
        if not any(m["id"] == payload.payment_method_id
                   for m in sg.list_payment_methods(user_data)):
            raise HTTPException(status_code=403, detail={
                "code": "metodo_ajeno", "message": "Esa tarjeta no es tuya.",
            })

    ajustes = set_autoreload(
        user_data["id"],
        enabled=payload.enabled,
        threshold_microusd=int(payload.threshold_usd * MICRO_PER_USD),
        pack_id=payload.pack_id,
        payment_method=payload.payment_method_id,
    )
    return {"autoreload": _autoreload_public(ajustes)}


def _autoreload_public(ajustes: dict[str, Any]) -> dict[str, Any]:
    return {
        "enabled": ajustes["enabled"],
        "threshold_usd": microusd_to_usd(ajustes["threshold_microusd"]),
        "pack_id": ajustes["pack_id"],
        "payment_method_id": ajustes["payment_method"],
        "last_run": ajustes["last_run"],
        "last_error": ajustes["last_error"],
    }


@credits_router.get("")
async def credit_status(user_data: dict[str, Any] = Depends(cookie_auth_required)):
    """Saldo, recarga automática y últimos movimientos."""
    user_id = user_data["id"]
    cuenta = get_credit_account(user_id)
    return {
        "enabled": sg.enabled(),
        "balance_usd": microusd_to_usd(cuenta["balance_microusd"]),
        "autoreload": _autoreload_public(cuenta["autoreload"]),
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
