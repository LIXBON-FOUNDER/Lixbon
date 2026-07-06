"""
stripe_gateway.py — Integración de pagos con Stripe (F7).

El bucket de secretos vive en variables de entorno (STRIPE_*). Si Stripe no está
configurado, `enabled()` es False y los endpoints devuelven 503 con un mensaje
claro — la web muestra "Próximamente" hasta que se conecten las credenciales.

Flujo:
  Checkout Session (modo subscription) → el usuario paga en el checkout hosted de
  Stripe → Stripe emite webhooks → aquí se refleja el plan en la BD. El binario
  de tarjeta nunca toca nuestro servidor (PCI simplificado).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from core.config import (
    PUBLIC_BASE_URL,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    stripe_configured,
)
from core.persistence.queries import (
    apply_stripe_subscription,
    downgrade_to_free,
    get_plan,
    get_plan_by_stripe_price,
    get_subscription,
    get_user_by_id,
    get_user_by_stripe_customer,
    log_audit_event,
    set_stripe_customer,
)

logger = logging.getLogger("LIXBON.stripe")


class StripeNotConfigured(RuntimeError):
    pass


def enabled() -> bool:
    return stripe_configured()


def _client():
    if not stripe_configured():
        raise StripeNotConfigured("STRIPE_SECRET_KEY no está configurada")
    import stripe
    stripe.api_key = STRIPE_SECRET_KEY
    return stripe


def _base_url(request_base: str | None = None) -> str:
    """URL pública para success/cancel: PUBLIC_BASE_URL o el host de la petición."""
    return PUBLIC_BASE_URL or (request_base or "").rstrip("/")


def _iso(ts: int | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


# ── Cliente/checkout ────────────────────────────────────────────────────────

def _ensure_customer(stripe, user: dict[str, Any]) -> str:
    """Devuelve el customer de Stripe del usuario, creándolo si hace falta."""
    sub = get_subscription(user["id"])
    if sub and sub.get("stripe_customer_id"):
        return sub["stripe_customer_id"]
    customer = stripe.Customer.create(
        email=user.get("email") or None,
        name=" ".join(filter(None, [user.get("first_name"), user.get("last_name")])) or None,
        metadata={"LIXBON_user_id": str(user["id"])},
    )
    set_stripe_customer(user["id"], customer.id)
    return customer.id


def create_checkout_session(user: dict[str, Any], plan_id: str, request_base: str | None = None) -> str:
    """Crea una Checkout Session de suscripción y devuelve su URL."""
    stripe = _client()
    plan = get_plan(plan_id)
    if not plan:
        raise ValueError("plan_inexistente")
    if not plan.get("stripe_price_id"):
        raise ValueError("plan_sin_precio")  # falta configurar el price_ en el plan

    customer_id = _ensure_customer(stripe, user)
    base = _base_url(request_base)
    session = stripe.checkout.Session.create(
        mode="subscription",
        customer=customer_id,
        line_items=[{"price": plan["stripe_price_id"], "quantity": 1}],
        success_url=f"{base}/account/facturacion?checkout=success",
        cancel_url=f"{base}/planes?checkout=cancel",
        allow_promotion_codes=True,
        metadata={"LIXBON_user_id": str(user["id"]), "plan_id": plan_id},
        subscription_data={"metadata": {"LIXBON_user_id": str(user["id"]), "plan_id": plan_id}},
    )
    log_audit_event("checkout_started", user_id=user["id"], plan_id=plan_id)
    return session.url


def create_portal_session(user: dict[str, Any], request_base: str | None = None) -> str:
    """Portal de cliente de Stripe (cambiar método de pago, cancelar, facturas)."""
    stripe = _client()
    sub = get_subscription(user["id"])
    if not sub or not sub.get("stripe_customer_id"):
        raise ValueError("sin_cliente")
    base = _base_url(request_base)
    portal = stripe.billing_portal.Session.create(
        customer=sub["stripe_customer_id"],
        return_url=f"{base}/account/facturacion",
    )
    return portal.url


def list_invoices(user: dict[str, Any], limit: int = 12) -> list[dict[str, Any]]:
    """Historial de facturas del cliente (para la sección Facturación)."""
    if not stripe_configured():
        return []
    sub = get_subscription(user["id"])
    if not sub or not sub.get("stripe_customer_id"):
        return []
    stripe = _client()
    try:
        inv = stripe.Invoice.list(customer=sub["stripe_customer_id"], limit=limit)
    except Exception as exc:
        logger.warning(f"No se pudieron listar facturas: {exc}")
        return []
    return [
        {
            "id": i.id,
            "date": _iso(i.created),
            "amount": (i.amount_paid or 0) / 100,
            "currency": (i.currency or "usd").upper(),
            "status": i.status,
            "pdf": i.invoice_pdf,
            "hosted_url": i.hosted_invoice_url,
        }
        for i in inv.data
    ]


def payment_method_summary(user: dict[str, Any]) -> dict[str, Any] | None:
    """Marca y últimos 4 dígitos del método de pago por defecto, si existe."""
    if not stripe_configured():
        return None
    sub = get_subscription(user["id"])
    if not sub or not sub.get("stripe_customer_id"):
        return None
    stripe = _client()
    try:
        cust = stripe.Customer.retrieve(
            sub["stripe_customer_id"], expand=["invoice_settings.default_payment_method"]
        )
        pm = cust.get("invoice_settings", {}).get("default_payment_method")
        if pm and pm.get("card"):
            return {"brand": pm["card"]["brand"], "last4": pm["card"]["last4"]}
    except Exception as exc:
        logger.warning(f"No se pudo leer el método de pago: {exc}")
    return None


# ── Webhooks ────────────────────────────────────────────────────────────────

def verify_and_parse(payload: bytes, sig_header: str | None) -> dict[str, Any]:
    """Verifica la firma del webhook y devuelve el evento. Lanza si es inválido."""
    stripe = _client()
    if not STRIPE_WEBHOOK_SECRET:
        raise StripeNotConfigured("STRIPE_WEBHOOK_SECRET no está configurada")
    return stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)


def _user_id_from_subscription(stripe, subscription: dict[str, Any]) -> int | None:
    """Resuelve el usuario a partir de la suscripción de Stripe."""
    meta_uid = (subscription.get("metadata") or {}).get("LIXBON_user_id")
    if meta_uid and str(meta_uid).isdigit() and get_user_by_id(int(meta_uid)):
        return int(meta_uid)
    user = get_user_by_stripe_customer(subscription.get("customer"))
    return user["id"] if user else None


def _plan_from_subscription(subscription: dict[str, Any]) -> dict[str, Any] | None:
    items = (subscription.get("items") or {}).get("data") or []
    if not items:
        return None
    price_id = (items[0].get("price") or {}).get("id")
    plan = get_plan_by_stripe_price(price_id)
    if plan:
        return plan
    # respaldo: plan_id en la metadata de la suscripción
    plan_id = (subscription.get("metadata") or {}).get("plan_id")
    return get_plan(plan_id) if plan_id else None


def handle_event(event: dict[str, Any]) -> None:
    """Procesa un evento de Stripe ya verificado (idempotente)."""
    etype = event["type"]
    obj = event["data"]["object"]
    stripe = _client()

    if etype in ("customer.subscription.created", "customer.subscription.updated"):
        user_id = _user_id_from_subscription(stripe, obj)
        plan = _plan_from_subscription(obj)
        if not user_id or not plan:
            logger.warning(f"[webhook] {etype} sin usuario/plan resoluble")
            return
        status = obj.get("status", "active")
        active = status in ("active", "trialing", "past_due")
        if not active:
            downgrade_to_free(user_id)
        else:
            apply_stripe_subscription(
                user_id, plan["id"],
                customer_id=obj.get("customer"),
                subscription_id=obj.get("id"),
                current_period_end=_iso(obj.get("current_period_end")),
                cancel_at_period_end=bool(obj.get("cancel_at_period_end")),
                status=status,
            )
        log_audit_event("subscription_synced", user_id=user_id, plan_id=plan["id"], status=status)

    elif etype == "customer.subscription.deleted":
        user_id = _user_id_from_subscription(stripe, obj)
        if user_id:
            downgrade_to_free(user_id)
            log_audit_event("subscription_canceled", user_id=user_id)

    elif etype == "invoice.payment_failed":
        user = get_user_by_stripe_customer(obj.get("customer"))
        if user:
            log_audit_event("payment_failed", user_id=user["id"])

    else:
        logger.debug(f"[webhook] evento ignorado: {etype}")
