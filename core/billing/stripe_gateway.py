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
    credit_purchase,
    downgrade_to_free,
    get_credit_pack,
    get_plan,
    get_plan_by_stripe_price,
    get_subscription,
    get_user_by_id,
    get_user_by_stripe_customer,
    log_audit_event,
    set_stripe_customer,
)

logger = logging.getLogger("lixbon.stripe")


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
        metadata={"lixbon_user_id": str(user["id"])},
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
        metadata={"lixbon_user_id": str(user["id"]), "plan_id": plan_id},
        subscription_data={"metadata": {"lixbon_user_id": str(user["id"]), "plan_id": plan_id}},
    )
    log_audit_event("checkout_started", user_id=user["id"], plan_id=plan_id)
    return session.url


def upgrade_subscription(user: dict[str, Any], new_plan_id: str) -> dict[str, Any]:
    """Upgrade in-place de la suscripción existente (ej. Pro → Advance) con
    PRORRATEO: Stripe acredita lo no usado del plan actual y cobra la
    diferencia al instante (always_invoice). Recién pagado Pro, la diferencia
    es ~$15.00; a mitad de ciclo, menos (ya se pagó medio Pro). La renovación
    siguiente ya va al precio nuevo. Solo hacia un plan MÁS CARO — los
    downgrades se gestionan desde el customer portal."""
    stripe = _client()
    plan = get_plan(new_plan_id)
    if not plan:
        raise ValueError("plan_inexistente")
    if not plan.get("stripe_price_id"):
        raise ValueError("plan_sin_precio")
    sub = get_subscription(user["id"])
    if not sub or not sub.get("stripe_subscription_id"):
        raise ValueError("sin_suscripcion")

    current_plan = get_plan(sub["plan_id"]) if sub.get("plan_id") else None
    if current_plan and plan["price_monthly_cents"] <= current_plan["price_monthly_cents"]:
        raise ValueError("downgrade_por_portal")

    sub_id = sub["stripe_subscription_id"]
    current = stripe.Subscription.retrieve(sub_id)
    # Acceso por atributo (StripeObject nuevos no son dicts)
    items = getattr(getattr(current, "items", None), "data", None) or []
    if not items:
        raise ValueError("sin_suscripcion")

    stripe.Subscription.modify(
        sub_id,
        items=[{"id": items[0].id, "price": plan["stripe_price_id"]}],
        proration_behavior="always_invoice",     # factura y cobra la diferencia YA
        payment_behavior="error_if_incomplete",  # si el cobro falla, no queda a medias
        metadata={"lixbon_user_id": str(user["id"]), "plan_id": new_plan_id},
    )
    # Reflejo inmediato en BD; el webhook subscription.updated llega igual y es idempotente
    apply_stripe_subscription(
        user["id"], new_plan_id,
        customer_id=sub.get("stripe_customer_id"),
        subscription_id=sub_id,
        current_period_end=sub.get("current_period_end"),
        cancel_at_period_end=False,
        status="active",
    )
    log_audit_event("subscription_upgraded", user_id=user["id"],
                    from_plan=sub.get("plan_id"), to_plan=new_plan_id)
    return {"upgraded": True, "plan_name": plan["name"]}


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
        # Acceso por atributo: los StripeObject nuevos no son dicts (.get falla)
        cust = stripe.Customer.retrieve(
            sub["stripe_customer_id"], expand=["invoice_settings.default_payment_method"]
        )
        inv = getattr(cust, "invoice_settings", None)
        pm = getattr(inv, "default_payment_method", None) if inv else None
        # Checkout guarda la tarjeta como default de la SUSCRIPCIÓN, no del
        # customer — si el customer no tiene, se mira ahí.
        if not pm and sub.get("stripe_subscription_id"):
            s = stripe.Subscription.retrieve(
                sub["stripe_subscription_id"], expand=["default_payment_method"]
            )
            pm = getattr(s, "default_payment_method", None)
        if isinstance(pm, str):  # id sin expandir
            pm = stripe.PaymentMethod.retrieve(pm)
        card = getattr(pm, "card", None) if pm else None
        if card:
            return {"brand": card.brand, "last4": card.last4}
    except Exception as exc:
        logger.warning(f"No se pudo leer el método de pago: {exc}")
    return None


def create_credit_checkout(user: dict[str, Any], pack: dict[str, Any],
                           request_base: str | None = None) -> str:
    """Checkout de pago único para un pack de créditos de API. El precio va
    inline (price_data): no hace falta configurar products en el dashboard."""
    stripe = _client()
    customer_id = _ensure_customer(stripe, user)
    base = _base_url(request_base)
    session = stripe.checkout.Session.create(
        mode="payment",
        customer=customer_id,
        line_items=[{
            "price_data": {
                "currency": (pack.get("currency") or "USD").lower(),
                "unit_amount": pack["price_cents"],
                "product_data": {"name": f"Créditos de API lixbon — {pack['name']}"},
            },
            "quantity": 1,
        }],
        success_url=f"{base}/account/facturacion?credits=success",
        cancel_url=f"{base}/account/facturacion?credits=cancel",
        metadata={"lixbon_user_id": str(user["id"]), "kind": "credit_pack", "pack_id": pack["id"]},
    )
    log_audit_event("credit_checkout_started", user_id=user["id"], pack_id=pack["id"])
    return session.url


def cancel_subscription_immediately(user_id: int) -> None:
    """Cancela la suscripción en Stripe al eliminar la cuenta. Best-effort:
    si falla se registra y el borrado continúa (el webhook deleted ya no
    encontrará al usuario, lo cual es inocuo)."""
    if not stripe_configured():
        return
    sub = get_subscription(user_id)
    if not sub or not sub.get("stripe_subscription_id"):
        return
    try:
        stripe = _client()
        stripe.Subscription.delete(sub["stripe_subscription_id"])
        logger.info(f"Suscripción de Stripe cancelada al eliminar la cuenta (user {user_id})")
    except Exception as exc:
        logger.warning(f"No se pudo cancelar la suscripción de Stripe al eliminar la cuenta: {exc}")


# ── Webhooks ────────────────────────────────────────────────────────────────

def verify_and_parse(payload: bytes, sig_header: str | None) -> dict[str, Any]:
    """Verifica la firma del webhook y devuelve el evento como DICT PLANO.
    Importante: no devolver el StripeObject de construct_event — en las
    versiones nuevas de stripe-python ya no es un dict y los .get() de
    handle_event lanzan AttributeError. La firma se valida igual; el payload
    ya verificado se parsea con json."""
    import json

    stripe = _client()
    if not STRIPE_WEBHOOK_SECRET:
        raise StripeNotConfigured("STRIPE_WEBHOOK_SECRET no está configurada")
    stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)  # lanza si es inválida
    return json.loads(payload)


def _user_id_from_subscription(stripe, subscription: dict[str, Any]) -> int | None:
    """Resuelve el usuario a partir de la suscripción de Stripe."""
    meta_uid = (subscription.get("metadata") or {}).get("lixbon_user_id")
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


def _period_end_from_subscription(subscription: dict[str, Any]) -> str | None:
    """Fin del ciclo pagado. En las versiones nuevas de la API de Stripe
    current_period_end ya no vive en la raíz de la suscripción sino en sus
    items — se aceptan ambas formas."""
    ts = subscription.get("current_period_end")
    if not ts:
        items = (subscription.get("items") or {}).get("data") or []
        if items:
            ts = items[0].get("current_period_end")
    return _iso(ts)


def _avisar_suscripcion(user_id: int, plan: dict[str, Any], fin_de_ciclo: str | None,
                        anterior: dict[str, Any] | None) -> None:
    # Solo al empezar o al cambiar de plan. Stripe manda un
    # customer.subscription.updated por cada ciclo cobrado, y avisar en cada uno
    # convertiría el correo en ruido mensual.
    seguia_igual = bool(anterior
                        and anterior.get("plan_id") == plan["id"]
                        and anterior.get("status") in ("active", "trialing", "past_due"))
    if seguia_igual:
        return
    correo = (get_user_by_id(user_id) or {}).get("email")
    if not correo:
        return
    from core.gateway.email import en_segundo_plano, send_subscription_email
    en_segundo_plano(send_subscription_email(correo, plan, fin_de_ciclo))


def _avisar_cancelacion(user_id: int, subscription: dict[str, Any],
                        anterior: dict[str, Any] | None) -> None:
    # Solo si de verdad había algo que cancelar. Stripe reenvía los webhooks que
    # no confirma, y sin esta guarda un reenvío avisaría dos veces de la misma
    # cancelación a alguien que ya está en el Gratuito.
    if not anterior or anterior.get("status") not in ("active", "trialing", "past_due"):
        return
    plan = _plan_from_subscription(subscription) or get_plan(anterior.get("plan_id") or "")
    if not plan or plan["id"] == "free":
        return
    correo = (get_user_by_id(user_id) or {}).get("email")
    if not correo:
        return
    from core.gateway.email import en_segundo_plano, send_subscription_canceled_email
    en_segundo_plano(send_subscription_canceled_email(correo, plan["name"], get_plan("free")))


def _avisar_pago_fallido(user: dict[str, Any], invoice: dict[str, Any]) -> None:
    # Solo las facturas de una suscripción: un pack de créditos que falla no
    # pone en riesgo ningún plan, y su correo diría algo que no es verdad.
    if not invoice.get("subscription"):
        return
    if not user.get("email"):
        return
    sub = get_subscription(user["id"])
    plan = get_plan(sub.get("plan_id") or "") if sub else None
    from core.gateway.email import (
        en_segundo_plano, importe_de_factura, send_payment_failed_email,
    )
    en_segundo_plano(send_payment_failed_email(
        user["email"],
        (plan or {}).get("name") or "de pago",
        importe=importe_de_factura(invoice.get("amount_due"), invoice.get("currency")),
        reintento_iso=_iso(invoice.get("next_payment_attempt")),
        # La factura alojada en Stripe deja pagar y cambiar la tarjeta sin
        # iniciar sesión en lixbon: menos pasos entre el aviso y el arreglo.
        url_pago=invoice.get("hosted_invoice_url"),
    ))


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
        anterior = get_subscription(user_id)
        if not active:
            downgrade_to_free(user_id)
        else:
            fin_de_ciclo = _period_end_from_subscription(obj)
            apply_stripe_subscription(
                user_id, plan["id"],
                customer_id=obj.get("customer"),
                subscription_id=obj.get("id"),
                current_period_end=fin_de_ciclo,
                cancel_at_period_end=bool(obj.get("cancel_at_period_end")),
                status=status,
            )
            _avisar_suscripcion(user_id, plan, fin_de_ciclo, anterior)
        log_audit_event("subscription_synced", user_id=user_id, plan_id=plan["id"], status=status)

    elif etype == "customer.subscription.deleted":
        user_id = _user_id_from_subscription(stripe, obj)
        if user_id:
            anterior = get_subscription(user_id)  # qué plan termina, antes de perderlo
            downgrade_to_free(user_id)
            log_audit_event("subscription_canceled", user_id=user_id)
            _avisar_cancelacion(user_id, obj, anterior)

    elif etype == "checkout.session.completed":
        # Solo nos interesan los packs de créditos (las suscripciones se
        # sincronizan por los eventos customer.subscription.*).
        meta = obj.get("metadata") or {}
        if meta.get("kind") != "credit_pack":
            return
        if obj.get("payment_status") != "paid":
            logger.info(f"[webhook] checkout de créditos sin pagar aún ({obj.get('id')})")
            return
        uid = meta.get("lixbon_user_id")
        user_id = int(uid) if uid and str(uid).isdigit() else None
        pack = get_credit_pack(meta.get("pack_id") or "")
        if not user_id or not pack or not get_user_by_id(user_id):
            logger.warning(f"[webhook] checkout de créditos sin usuario/pack resoluble ({obj.get('id')})")
            return
        credited = credit_purchase(
            user_id, pack["credit_microusd"],
            stripe_ref=obj.get("id"),
            note=f"Pack {pack['name']}",
        )
        if credited:
            log_audit_event("credits_purchased", user_id=user_id,
                            pack_id=pack["id"], amount_microusd=pack["credit_microusd"])
        else:
            logger.info(f"[webhook] compra de créditos ya acreditada ({obj.get('id')})")

    elif etype == "invoice.payment_failed":
        user = get_user_by_stripe_customer(obj.get("customer"))
        if user:
            log_audit_event("payment_failed", user_id=user["id"])
            _avisar_pago_fallido(user, obj)

    else:
        logger.debug(f"[webhook] evento ignorado: {etype}")
