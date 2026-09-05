"""
stripe_gateway.py — Pagos con Stripe, cobrados desde lixbon.

Los secretos viven en variables de entorno (STRIPE_*). Sin configurar,
`enabled()` es False y los endpoints devuelven 503 — la web muestra
"Próximamente".

El cobro NO sale de lixbon: no hay Checkout alojado ni portal de cliente. El
navegador tokeniza la tarjeta contra Stripe con Elements y aquí solo llega un
`pm_...`; con ese id se crean la suscripción y los cobros de créditos. El número
de tarjeta nunca toca este servidor ni la base de datos, que es lo que mantiene
el alcance PCI en el cuestionario corto: si el PAN pasara por aquí el
cuestionario sería SAQ D, con auditoría anual.

Todo cobro es idempotente contra su id de Stripe, porque el mismo resultado
llega por dos caminos: la respuesta al confirmar y el webhook.
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
    forget_autoreload_payment_method,
    get_credit_account,
    get_credit_pack,
    get_plan,
    get_plan_by_stripe_price,
    get_subscription,
    get_user_by_id,
    get_user_by_stripe_customer,
    log_audit_event,
    record_autoreload_run,
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


def _base_url() -> str:
    return (PUBLIC_BASE_URL or "").rstrip("/")


def _iso(ts: int | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


# ── Cliente y plan ──────────────────────────────────────────────────────────

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


def change_plan(user: dict[str, Any], new_plan_id: str) -> dict[str, Any]:
    """Cambia el plan de una suscripción viva, en cualquier dirección.

    Subir cobra la diferencia al instante (`always_invoice`): recién pagado Pro,
    la diferencia es casi el precio entero de Advance; a mitad de ciclo, menos.
    Bajar no devuelve dinero: Stripe abona lo no consumido al saldo del cliente
    y lo descuenta de la siguiente factura. En ambos casos el plan nuevo aplica
    ya, para que el usuario no pague por límites que ya no tiene."""
    stripe = _client()
    plan = get_plan(new_plan_id)
    if not plan:
        raise ValueError("plan_inexistente")
    if not plan.get("stripe_price_id"):
        raise ValueError("plan_sin_precio")
    sub = get_subscription(user["id"])
    if not sub or not sub.get("stripe_subscription_id"):
        raise ValueError("sin_suscripcion")

    actual = get_plan(sub["plan_id"]) if sub.get("plan_id") else None
    if actual and plan["id"] == actual["id"]:
        raise ValueError("mismo_plan")
    sube = not actual or plan["price_monthly_cents"] > actual["price_monthly_cents"]

    sub_id = sub["stripe_subscription_id"]
    actual_stripe = stripe.Subscription.retrieve(sub_id)
    # Los StripeObject nuevos no son dicts: acceso por atributo.
    items = getattr(getattr(actual_stripe, "items", None), "data", None) or []
    if not items:
        raise ValueError("sin_suscripcion")

    stripe.Subscription.modify(
        sub_id,
        items=[{"id": items[0].id, "price": plan["stripe_price_id"]}],
        proration_behavior="always_invoice" if sube else "create_prorations",
        payment_behavior="error_if_incomplete" if sube else "allow_incomplete",
        metadata={"lixbon_user_id": str(user["id"]), "plan_id": new_plan_id},
    )
    apply_stripe_subscription(
        user["id"], new_plan_id,
        customer_id=sub.get("stripe_customer_id"),
        subscription_id=sub_id,
        current_period_end=sub.get("current_period_end"),
        cancel_at_period_end=False,
        status="active",
    )
    log_audit_event("plan_changed", user_id=user["id"],
                    from_plan=sub.get("plan_id"), to_plan=new_plan_id)
    # Misma forma que subscribe: quien llama no distingue un alta de un cambio,
    # y con error_if_incomplete llegar hasta aquí ya significa que el cobro entró.
    return {
        "status": "succeeded",
        "succeeded": True,
        "requires_action": False,
        "changed": True,
        "upgrade": sube,
        "plan_name": plan["name"],
    }


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


# ── Tarjetas guardadas ──────────────────────────────────────────────────────

def _customer_id(user: dict[str, Any]) -> str | None:
    sub = get_subscription(user["id"])
    return sub.get("stripe_customer_id") if sub else None


def _pm_publico(pm, id_por_defecto: str | None) -> dict[str, Any]:
    card = getattr(pm, "card", None)
    datos = getattr(pm, "billing_details", None)
    return {
        "id": pm.id,
        "brand": getattr(card, "brand", None),
        "last4": getattr(card, "last4", None),
        "exp_month": getattr(card, "exp_month", None),
        "exp_year": getattr(card, "exp_year", None),
        "name": getattr(datos, "name", None) if datos else None,
        "is_default": pm.id == id_por_defecto,
    }


def _pm_por_defecto(stripe, sub: dict[str, Any]) -> str | None:
    """Id (sin expandir) del método por defecto: el del cliente y, si no lo
    tiene, el que quedó fijado en la suscripción."""
    cliente = stripe.Customer.retrieve(sub["stripe_customer_id"])
    ajustes = getattr(cliente, "invoice_settings", None)
    pm = getattr(ajustes, "default_payment_method", None) if ajustes else None
    if not pm and sub.get("stripe_subscription_id"):
        suscripcion = stripe.Subscription.retrieve(sub["stripe_subscription_id"])
        pm = getattr(suscripcion, "default_payment_method", None)
    return pm if isinstance(pm, str) else (getattr(pm, "id", None) if pm else None)


def _pm_del_cliente(stripe, customer_id: str, pm_id: str):
    """El id llega del navegador: hay que confirmar que la tarjeta es de este
    cliente antes de tocarla, o cualquiera podría borrar la de otro usuario."""
    pm = stripe.PaymentMethod.retrieve(pm_id)
    if getattr(pm, "customer", None) != customer_id:
        raise ValueError("metodo_ajeno")
    return pm


def create_setup_intent(user: dict[str, Any]) -> dict[str, Any]:
    """Secreto para que Elements guarde una tarjeta nueva sin cobrar nada."""
    stripe = _client()
    customer_id = _ensure_customer(stripe, user)
    intento = stripe.SetupIntent.create(
        customer=customer_id,
        usage="off_session",
        payment_method_types=["card"],
        metadata={"lixbon_user_id": str(user["id"])},
    )
    return {"client_secret": intento.client_secret}


def list_payment_methods(user: dict[str, Any]) -> list[dict[str, Any]]:
    if not stripe_configured():
        return []
    sub = get_subscription(user["id"])
    if not sub or not sub.get("stripe_customer_id"):
        return []
    stripe = _client()
    try:
        por_defecto = _pm_por_defecto(stripe, sub)
        tarjetas = stripe.PaymentMethod.list(customer=sub["stripe_customer_id"], type="card")
    except Exception as exc:
        logger.warning(f"No se pudieron listar las tarjetas: {exc}")
        return []
    metodos = [_pm_publico(pm, por_defecto) for pm in tarjetas.data]
    metodos.sort(key=lambda m: not m["is_default"])
    return metodos


def set_default_payment_method(user: dict[str, Any], pm_id: str) -> None:
    stripe = _client()
    customer_id = _customer_id(user)
    if not customer_id:
        raise ValueError("sin_cliente")
    _pm_del_cliente(stripe, customer_id, pm_id)
    stripe.Customer.modify(customer_id, invoice_settings={"default_payment_method": pm_id})
    sub = get_subscription(user["id"])
    if sub and sub.get("stripe_subscription_id"):
        stripe.Subscription.modify(sub["stripe_subscription_id"], default_payment_method=pm_id)
    log_audit_event("payment_method_default", user_id=user["id"])


def detach_payment_method(user: dict[str, Any], pm_id: str) -> None:
    """Quitar una tarjeta guardada. La última no se puede quitar mientras haya
    una suscripción viva: la dejaría sin con qué renovarse."""
    stripe = _client()
    customer_id = _customer_id(user)
    if not customer_id:
        raise ValueError("sin_cliente")
    _pm_del_cliente(stripe, customer_id, pm_id)

    sub = get_subscription(user["id"])
    restantes = [m for m in list_payment_methods(user) if m["id"] != pm_id]
    if not restantes and sub and sub.get("stripe_subscription_id"):
        raise ValueError("ultima_tarjeta")

    stripe.PaymentMethod.detach(pm_id)
    if restantes and not any(m["is_default"] for m in restantes):
        set_default_payment_method(user, restantes[0]["id"])
    if forget_autoreload_payment_method(user["id"], pm_id):
        logger.info(f"Recarga automática apagada al borrar su tarjeta (user {user['id']})")
    log_audit_event("payment_method_removed", user_id=user["id"])


def payment_method_summary(user: dict[str, Any]) -> dict[str, Any] | None:
    """Marca y últimos 4 del método por defecto (cabecera de Facturación)."""
    for m in list_payment_methods(user):
        if m["is_default"]:
            return {"brand": m["brand"], "last4": m["last4"]}
    return None


# ── Cobro ───────────────────────────────────────────────────────────────────

def _cargo_de(pi):
    """El cargo de un PaymentIntent colgaba de `charges.data` y en las versiones
    nuevas de la API es `latest_charge`. Se aceptan las dos."""
    ultimo = getattr(pi, "latest_charge", None)
    if ultimo is not None and not isinstance(ultimo, str):
        return ultimo
    cargos = getattr(getattr(pi, "charges", None), "data", None) or []
    return cargos[0] if cargos else None


def _tarjeta_de(pi) -> str | None:
    cargo = _cargo_de(pi)
    if not cargo:
        return None
    detalle = getattr(getattr(cargo, "payment_method_details", None), "card", None)
    return getattr(detalle, "last4", None) if detalle else None


def _resultado(intento) -> dict[str, Any]:
    """Forma común de un cobro: la web solo necesita saber si terminó, si hay
    que pasar por el banco, o por qué se cayó."""
    estado = getattr(intento, "status", None)
    cargo = _cargo_de(intento)
    error = getattr(intento, "last_payment_error", None)
    return {
        "status": estado,
        "client_secret": getattr(intento, "client_secret", None),
        "payment_intent": getattr(intento, "id", None),
        "requires_action": estado in ("requires_action", "requires_confirmation"),
        "succeeded": estado == "succeeded",
        "amount": (getattr(intento, "amount", 0) or 0) / 100,
        "currency": (getattr(intento, "currency", None) or "usd").upper(),
        "payment_method": (getattr(intento, "payment_method", None)
                           if isinstance(getattr(intento, "payment_method", None), str)
                           else getattr(getattr(intento, "payment_method", None), "id", None)),
        "last4": _tarjeta_de(intento),
        "receipt_url": getattr(cargo, "receipt_url", None) if cargo else None,
        "decline_message": getattr(error, "message", None) if error else None,
        "decline_code": getattr(error, "decline_code", None) if error else None,
    }


def _cobro_de_factura(stripe, factura) -> tuple[Any, str | None]:
    """Devuelve (PaymentIntent, client_secret) del primer cobro de una factura.

    Stripe ha movido esto de sitio tres veces: `invoice.payment_intent` en las
    versiones viejas, `invoice.confirmation_secret` en las intermedias y
    `invoice.payments` en las nuevas. Se prueban las tres, cada una con su
    guarda: pedir un `expand` que la versión de la cuenta no conoce es un error
    de la API, no un campo vacío."""
    if not factura:
        return None, None

    intento = getattr(factura, "payment_intent", None)
    if isinstance(intento, str):
        intento = _traer_intento(stripe, intento)
    if getattr(intento, "client_secret", None):
        return intento, intento.client_secret

    for expandir in (None, "confirmation_secret"):
        actual = factura
        if expandir:
            try:
                actual = stripe.Invoice.retrieve(factura.id, expand=[expandir])
            except Exception:
                continue
        confirmacion = getattr(actual, "confirmation_secret", None)
        secreto = getattr(confirmacion, "client_secret", None) if confirmacion else None
        if secreto:
            return intento, secreto

    try:
        cobros = stripe.Invoice.retrieve(factura.id, expand=["payments"])
    except Exception:
        cobros = factura
    for pago in getattr(getattr(cobros, "payments", None), "data", None) or []:
        ref = getattr(getattr(pago, "payment", None), "payment_intent", None)
        intento = _traer_intento(stripe, ref) if isinstance(ref, str) else ref
        if getattr(intento, "client_secret", None):
            return intento, intento.client_secret

    # Este log es lo único que queda para diagnosticar una versión de la API que
    # no encaje en ninguna de las tres formas, así que no puede reventar él mismo.
    try:
        campos = sorted(_a_dict(factura).keys())
    except Exception:
        campos = type(factura).__name__
    logger.error(
        f"No se encontró el cobro de la factura {getattr(factura, 'id', '?')}; "
        f"campos disponibles: {campos}"
    )
    return intento, None


def _traer_intento(stripe, intento_id: str | None):
    if not intento_id:
        return None
    try:
        return stripe.PaymentIntent.retrieve(intento_id, expand=["latest_charge"])
    except Exception as exc:
        logger.warning(f"No se pudo leer el PaymentIntent {intento_id}: {exc}")
        return None


def subscribe(user: dict[str, Any], plan_id: str, pm_id: str) -> dict[str, Any]:
    """Alta de suscripción con una tarjeta ya guardada. Si la suscripción ya
    existe esto es un cambio de plan, no un alta."""
    stripe = _client()
    plan = get_plan(plan_id)
    if not plan:
        raise ValueError("plan_inexistente")
    if not plan.get("stripe_price_id"):
        raise ValueError("plan_sin_precio")

    sub = get_subscription(user["id"])
    if sub and sub.get("stripe_subscription_id"):
        return change_plan(user, plan_id)

    customer_id = _ensure_customer(stripe, user)
    _pm_del_cliente(stripe, customer_id, pm_id)
    stripe.Customer.modify(customer_id, invoice_settings={"default_payment_method": pm_id})

    creada = stripe.Subscription.create(
        customer=customer_id,
        items=[{"price": plan["stripe_price_id"]}],
        default_payment_method=pm_id,
        # default_incomplete deja la suscripción esperando a que el navegador
        # confirme el primer cobro; sin esto una tarjeta con 3-D Secure fallaría
        # en vez de pedir la confirmación del banco.
        payment_behavior="default_incomplete",
        payment_settings={
            "save_default_payment_method": "on_subscription",
            "payment_method_types": ["card"],
        },
        expand=["latest_invoice"],
        metadata={"lixbon_user_id": str(user["id"]), "plan_id": plan_id},
    )
    log_audit_event("subscription_started", user_id=user["id"], plan_id=plan_id)

    if creada.status in ("active", "trialing"):
        sync_subscription(user)
        return {"status": "succeeded", "succeeded": True, "requires_action": False,
                "plan_name": plan["name"]}

    # El estado de la suscripción recién creada no basta: quien decide si hay
    # que pasar por el banco es el cobro de su primera factura.
    intento, secreto = _cobro_de_factura(stripe, creada.latest_invoice)
    estado = getattr(intento, "status", None) or creada.status

    if estado == "succeeded":
        sync_subscription(user)
        exito = {"status": "succeeded", "succeeded": True, "requires_action": False,
                 "plan_name": plan["name"]}
        return {**_resultado(intento), **exito} if intento else exito

    if secreto:
        return {
            "status": estado,
            "succeeded": False,
            "requires_action": True,
            "client_secret": secreto,
            "subscription_id": creada.id,
            "plan_name": plan["name"],
        }

    # Sin secreto no se puede confirmar desde el navegador. La suscripción ya
    # existe en Stripe y puede cerrarse sola, así que esto no es un rechazo:
    # decirlo así sería mentir sobre lo que hizo el banco.
    logger.error(f"Suscripción {creada.id} en {estado} sin secreto para confirmar")
    sync_subscription(user)
    return {
        "status": estado,
        "succeeded": False,
        "requires_action": False,
        "subscription_id": creada.id,
        "plan_name": plan["name"],
        "titulo": "El cobro quedó a la espera",
        "decline_message": "Stripe aceptó la suscripción pero no devolvió con qué "
                           "confirmarla desde aquí. Revisa Ajustes → Facturación en "
                           "unos segundos antes de volver a intentarlo.",
    }


def cancel_subscription(user: dict[str, Any]) -> dict[str, Any]:
    """Cancela al final del periodo pagado: lo ya cobrado se sigue disfrutando."""
    stripe = _client()
    sub = get_subscription(user["id"])
    if not sub or not sub.get("stripe_subscription_id"):
        raise ValueError("sin_suscripcion")
    stripe.Subscription.modify(sub["stripe_subscription_id"], cancel_at_period_end=True)
    apply_stripe_subscription(
        user["id"], sub["plan_id"],
        customer_id=sub.get("stripe_customer_id"),
        subscription_id=sub["stripe_subscription_id"],
        current_period_end=sub.get("current_period_end"),
        cancel_at_period_end=True,
        status=sub.get("status") or "active",
    )
    log_audit_event("subscription_cancel_scheduled", user_id=user["id"],
                    plan_id=sub.get("plan_id"))
    return {"cancel_at_period_end": True, "until": sub.get("current_period_end")}


def resume_subscription(user: dict[str, Any]) -> dict[str, Any]:
    stripe = _client()
    sub = get_subscription(user["id"])
    if not sub or not sub.get("stripe_subscription_id"):
        raise ValueError("sin_suscripcion")
    stripe.Subscription.modify(sub["stripe_subscription_id"], cancel_at_period_end=False)
    apply_stripe_subscription(
        user["id"], sub["plan_id"],
        customer_id=sub.get("stripe_customer_id"),
        subscription_id=sub["stripe_subscription_id"],
        current_period_end=sub.get("current_period_end"),
        cancel_at_period_end=False,
        status=sub.get("status") or "active",
    )
    log_audit_event("subscription_resumed", user_id=user["id"], plan_id=sub.get("plan_id"))
    return {"cancel_at_period_end": False}


def sync_subscription(user: dict[str, Any]) -> dict[str, Any] | None:
    """Relee la suscripción en Stripe y la refleja en la BD. Cierra la ventana
    entre que el navegador confirma el cobro y llega el webhook — y en local,
    donde no hay webhook, es lo único que la sincroniza."""
    if not stripe_configured():
        return None
    sub = get_subscription(user["id"])
    if not sub or not sub.get("stripe_customer_id"):
        return None
    stripe = _client()
    try:
        suscripciones = stripe.Subscription.list(
            customer=sub["stripe_customer_id"], status="all", limit=5,
        )
    except Exception as exc:
        logger.warning(f"No se pudo releer la suscripción: {exc}")
        return None

    viva = next((x for x in suscripciones.data
                 if x.status in ("active", "trialing", "past_due")), None)
    if not viva:
        return None
    plan = _plan_from_subscription(_a_dict(viva))
    if not plan:
        return None
    fin = _period_end_from_subscription(_a_dict(viva))
    apply_stripe_subscription(
        user["id"], plan["id"],
        customer_id=sub["stripe_customer_id"],
        subscription_id=viva.id,
        current_period_end=fin,
        cancel_at_period_end=bool(getattr(viva, "cancel_at_period_end", False)),
        status=viva.status,
    )
    return {"plan_id": plan["id"], "status": viva.status, "current_period_end": fin}


def _a_dict(objeto) -> dict[str, Any]:
    """Los helpers del webhook leen dicts planos; los objetos que devuelve la
    librería ya no lo son."""
    try:
        return objeto.to_dict_recursive()
    except AttributeError:
        return dict(objeto)


# ── Créditos ────────────────────────────────────────────────────────────────

def _acreditar(user_id: int, pack: dict[str, Any], referencia: str) -> bool:
    return credit_purchase(
        user_id, pack["credit_microusd"],
        stripe_ref=referencia,
        note=f"Pack {pack['name']}",
    )


def charge_topup(user: dict[str, Any], pack: dict[str, Any], pm_id: str,
                 guardar: bool = True) -> dict[str, Any]:
    """Cobra un pack de créditos contra una tarjeta guardada."""
    stripe = _client()
    customer_id = _ensure_customer(stripe, user)
    _pm_del_cliente(stripe, customer_id, pm_id)

    intento = stripe.PaymentIntent.create(
        amount=pack["price_cents"],
        currency=(pack.get("currency") or "USD").lower(),
        customer=customer_id,
        payment_method=pm_id,
        confirm=True,
        off_session=False,
        payment_method_types=["card"],
        expand=["latest_charge"],
        description=f"Créditos de API lixbon — {pack['name']}",
        metadata={
            "lixbon_user_id": str(user["id"]),
            "kind": "credit_pack",
            "pack_id": pack["id"],
            "keep_pm": "1" if guardar else "0",
        },
    )
    log_audit_event("credit_charge_started", user_id=user["id"], pack_id=pack["id"])

    if intento.status == "succeeded":
        _acreditar(user["id"], pack, intento.id)
        if not guardar:
            _olvidar_tarjeta(stripe, user, pm_id)
    return _resultado(intento)


def _olvidar_tarjeta(stripe, user: dict[str, Any], pm_id: str) -> None:
    """Quien no marcó «guardar» pagó con una tarjeta que hubo que guardar para
    poder cobrarla; se suelta en cuanto el cobro cierra."""
    try:
        if any(m["id"] == pm_id for m in list_payment_methods(user)):
            detach_payment_method(user, pm_id)
    except Exception as exc:
        logger.warning(f"No se pudo soltar la tarjeta de un pago suelto: {exc}")


def resolve_payment(user: dict[str, Any], payment_intent_id: str) -> dict[str, Any]:
    """Cierra un cobro que pasó por el banco. El webhook hace lo mismo, pero
    llega cuando llega: sin esto la pantalla de «aprobado» mentiría."""
    stripe = _client()
    customer_id = _customer_id(user)
    intento = stripe.PaymentIntent.retrieve(payment_intent_id, expand=["latest_charge"])
    if getattr(intento, "customer", None) != customer_id:
        raise ValueError("cobro_ajeno")

    meta = getattr(intento, "metadata", None) or {}
    if intento.status == "succeeded" and meta.get("kind") == "credit_pack":
        pack = get_credit_pack(meta.get("pack_id") or "")
        if pack:
            _acreditar(user["id"], pack, intento.id)
            if meta.get("keep_pm") == "0":
                _olvidar_tarjeta(stripe, user, getattr(intento, "payment_method", "") or "")
    else:
        sync_subscription(user)
    return _resultado(intento)


def list_charges(user: dict[str, Any], limit: int = 10) -> list[dict[str, Any]]:
    """Últimos cobros del usuario: renovaciones y recargas en una sola lista."""
    if not stripe_configured():
        return []
    customer_id = _customer_id(user)
    if not customer_id:
        return []
    stripe = _client()
    try:
        intentos = stripe.PaymentIntent.list(
            customer=customer_id, limit=limit, expand=["data.latest_charge"],
        )
    except Exception as exc:
        logger.warning(f"No se pudieron listar los cobros: {exc}")
        return []

    cobros = []
    for pi in intentos.data:
        meta = getattr(pi, "metadata", None) or {}
        cobros.append({
            "id": pi.id,
            "date": _iso(getattr(pi, "created", None)),
            "amount": (pi.amount or 0) / 100,
            "currency": (pi.currency or "usd").upper(),
            "status": pi.status,
            "concept": pi.description or ("Recarga de créditos"
                                          if meta.get("kind") == "credit_pack"
                                          else "Suscripción"),
            "last4": _tarjeta_de(pi),
        })
    return cobros


# ── Recarga automática ──────────────────────────────────────────────────────

_recargas_en_curso: set[int] = set()


def maybe_autoreload(user_id: int, balance_microusd: int) -> None:
    """Dispara la recarga automática si el saldo cayó por debajo del umbral.
    Se llama al terminar cada petición cobrada, así que va en un hilo aparte:
    el usuario no espera a Stripe para recibir su respuesta."""
    if not stripe_configured():
        return
    cuenta = get_credit_account(user_id)
    ajustes = cuenta["autoreload"]
    if not ajustes["enabled"] or balance_microusd > ajustes["threshold_microusd"]:
        return
    if user_id in _recargas_en_curso:
        return
    _recargas_en_curso.add(user_id)

    import threading
    threading.Thread(target=_ejecutar_autorecarga, args=(user_id, ajustes),
                     daemon=True).start()


def _ejecutar_autorecarga(user_id: int, ajustes: dict[str, Any]) -> None:
    try:
        usuario = get_user_by_id(user_id)
        pack = get_credit_pack(ajustes["pack_id"] or "")
        if not usuario or not pack or not ajustes["payment_method"]:
            record_autoreload_run(user_id, "configuración incompleta")
            return
        stripe = _client()
        intento = stripe.PaymentIntent.create(
            amount=pack["price_cents"],
            currency=(pack.get("currency") or "USD").lower(),
            customer=_customer_id(usuario),
            payment_method=ajustes["payment_method"],
            confirm=True,
            # Sin el titular delante: si el banco pide 3-D Secure, Stripe falla
            # con authentication_required en vez de dejar el cobro colgado.
            off_session=True,
            payment_method_types=["card"],
            description=f"Recarga automática lixbon — {pack['name']}",
            metadata={"lixbon_user_id": str(user_id), "kind": "credit_pack",
                      "pack_id": pack["id"], "auto": "1"},
        )
        if intento.status == "succeeded":
            _acreditar(user_id, pack, intento.id)
            record_autoreload_run(user_id)
            log_audit_event("credits_autoreloaded", user_id=user_id, pack_id=pack["id"])
        else:
            record_autoreload_run(user_id, f"el cobro quedó en {intento.status}")
            _avisar_autorecarga_fallida(user_id, pack)
    except Exception as exc:
        motivo = getattr(exc, "user_message", None) or str(exc)
        record_autoreload_run(user_id, motivo[:300])
        log_audit_event("credits_autoreload_failed", user_id=user_id)
        logger.warning(f"Recarga automática fallida (user {user_id}): {motivo}")
        pack = get_credit_pack(ajustes["pack_id"] or "")
        if pack:
            _avisar_autorecarga_fallida(user_id, pack)
    finally:
        _recargas_en_curso.discard(user_id)


def _avisar_autorecarga_fallida(user_id: int, pack: dict[str, Any]) -> None:
    correo = (get_user_by_id(user_id) or {}).get("email")
    if not correo:
        return
    try:
        from core.gateway.email import en_segundo_plano, send_autoreload_failed_email
        en_segundo_plano(send_autoreload_failed_email(correo, pack["name"]))
    except Exception as exc:
        logger.warning(f"No se pudo avisar de la recarga fallida: {exc}")


# ── Panel de administración ─────────────────────────────────────────────────

def _inicio_del_dia() -> int:
    from datetime import time as _time
    hoy = datetime.now(timezone.utc).date()
    return int(datetime.combine(hoy, _time.min, tzinfo=timezone.utc).timestamp())


def admin_transactions(limit: int = 50, starting_after: str | None = None,
                       query: str | None = None) -> dict[str, Any]:
    """Intentos de cobro que pasaron por la pasarela. Las cifras del día se
    calculan sobre los cobros de hoy, no sobre la página que se muestra."""
    stripe = _client()
    params: dict[str, Any] = {"limit": min(limit, 100), "expand": ["data.latest_charge"]}
    if starting_after:
        params["starting_after"] = starting_after
    intentos = stripe.PaymentIntent.list(**params)
    hoy = stripe.PaymentIntent.list(created={"gte": _inicio_del_dia()}, limit=100)

    aprobados = [p for p in hoy.data if p.status == "succeeded"]
    rechazados = [p for p in hoy.data
                  if p.status in ("requires_payment_method", "canceled") and p.amount]
    ultimo = intentos.data[-1].id if intentos.data else None
    filas = [_transaccion_publica(p) for p in intentos.data]
    if query:
        q = query.lower().strip()
        filas = [f for f in filas if q in (f["reference"] or "").lower()
                 or q in (f["email"] or "").lower()
                 or q in (f["last4"] or "")]
    return {
        "transactions": filas,
        "has_more": intentos.has_more,
        "next_cursor": ultimo if intentos.has_more else None,
        "today": {
            "charged": sum(p.amount for p in aprobados) / 100,
            "count": len(aprobados),
            "attempts": len(hoy.data),
            "declined": len(rechazados),
            "approval_rate": round(100 * len(aprobados) / len(hoy.data), 1) if hoy.data else None,
            "truncated": len(hoy.data) >= 100,
        },
    }


def _transaccion_publica(pi) -> dict[str, Any]:
    meta = getattr(pi, "metadata", None) or {}
    uid = meta.get("lixbon_user_id")
    usuario = None
    if uid and str(uid).isdigit():
        usuario = get_user_by_id(int(uid))
    if not usuario:
        usuario = get_user_by_stripe_customer(getattr(pi, "customer", None))
    cargo = _cargo_de(pi)
    motivo = getattr(cargo, "failure_message", None) if cargo else None
    error = getattr(pi, "last_payment_error", None)
    return {
        "reference": pi.id,
        "email": (usuario or {}).get("email"),
        "user_id": (usuario or {}).get("id"),
        "concept": pi.description or ("Recarga de créditos"
                                      if meta.get("kind") == "credit_pack" else "Suscripción"),
        "automatic": meta.get("auto") == "1",
        "amount": (pi.amount or 0) / 100,
        "currency": (pi.currency or "usd").upper(),
        "status": pi.status,
        "last4": _tarjeta_de(pi),
        "date": _iso(getattr(pi, "created", None)),
        "decline_reason": motivo or (getattr(error, "message", None) if error else None),
        "decline_code": getattr(error, "decline_code", None) if error else None,
    }


def admin_payouts(limit: int = 12) -> dict[str, Any]:
    """Depósitos de Stripe en la cuenta del negocio, y el saldo pendiente."""
    stripe = _client()
    lotes = stripe.Payout.list(limit=min(limit, 50))
    saldo = stripe.Balance.retrieve()

    def _suma(entradas):
        return sum(e.amount for e in (entradas or [])) / 100

    return {
        "payouts": [{
            "id": p.id,
            "amount": (p.amount or 0) / 100,
            "currency": (p.currency or "usd").upper(),
            "status": p.status,
            "arrival_date": _iso(getattr(p, "arrival_date", None)),
            "created": _iso(getattr(p, "created", None)),
            "method": getattr(p, "method", None),
            "description": getattr(p, "description", None),
        } for p in lotes.data],
        "balance": {
            "available": _suma(getattr(saldo, "available", None)),
            "pending": _suma(getattr(saldo, "pending", None)),
            "currency": (getattr(saldo, "available", None) or [{}])[0].currency.upper()
                        if getattr(saldo, "available", None) else "USD",
        },
    }


def admin_gateway() -> dict[str, Any]:
    """Estado de la pasarela, de solo lectura: las claves viven en variables de
    entorno y editarlas desde el panel sería guardarlas en la base de datos."""
    stripe = _client()
    cuenta = stripe.Account.retrieve()
    endpoints, eventos = [], []
    try:
        endpoints = [{
            "url": e.url,
            "status": e.status,
            "events": len(getattr(e, "enabled_events", []) or []),
        } for e in stripe.WebhookEndpoint.list(limit=5).data]
    except Exception as exc:
        logger.warning(f"No se pudieron leer los webhooks: {exc}")
    try:
        eventos = stripe.Event.list(limit=100).data
    except Exception as exc:
        logger.warning(f"No se pudieron leer los eventos: {exc}")

    pendientes = sum(1 for e in eventos if getattr(e, "pending_webhooks", 0))
    return {
        "processor": "Stripe",
        "account_id": cuenta.id,
        "country": getattr(cuenta, "country", None),
        "default_currency": (getattr(cuenta, "default_currency", None) or "").upper() or None,
        "charges_enabled": bool(getattr(cuenta, "charges_enabled", False)),
        "payouts_enabled": bool(getattr(cuenta, "payouts_enabled", False)),
        "livemode": STRIPE_SECRET_KEY.startswith("sk_live_"),
        "publishable_key": STRIPE_PUBLISHABLE_KEY or None,
        "webhook_secret_set": bool(STRIPE_WEBHOOK_SECRET),
        "webhook_url": f"{_base_url()}/api/billing/webhook" if _base_url() else None,
        "endpoints": endpoints,
        "events_seen": len(eventos),
        "events_pending": pendientes,
    }


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

    elif etype == "payment_intent.succeeded":
        # Solo los packs de créditos: lo de las suscripciones ya lo cuentan los
        # eventos customer.subscription.*.
        meta = obj.get("metadata") or {}
        if meta.get("kind") != "credit_pack":
            return
        uid = meta.get("lixbon_user_id")
        user_id = int(uid) if uid and str(uid).isdigit() else None
        pack = get_credit_pack(meta.get("pack_id") or "")
        if not user_id or not pack or not get_user_by_id(user_id):
            logger.warning(f"[webhook] cobro de créditos sin usuario/pack resoluble ({obj.get('id')})")
            return
        acreditado = credit_purchase(
            user_id, pack["credit_microusd"],
            stripe_ref=obj.get("id"),
            note=f"Pack {pack['name']}",
        )
        if acreditado:
            log_audit_event("credits_purchased", user_id=user_id,
                            pack_id=pack["id"], amount_microusd=pack["credit_microusd"])
        else:
            logger.info(f"[webhook] compra de créditos ya acreditada ({obj.get('id')})")

    elif etype == "payment_method.detached":
        # La tarjeta pudo borrarla el propio Stripe (caducada, disputa): la
        # recarga automática que dependía de ella queda sin método.
        usuario = get_user_by_stripe_customer(obj.get("customer"))
        if usuario:
            forget_autoreload_payment_method(usuario["id"], obj.get("id") or "")

    elif etype == "invoice.payment_failed":
        user = get_user_by_stripe_customer(obj.get("customer"))
        if user:
            log_audit_event("payment_failed", user_id=user["id"])
            _avisar_pago_fallido(user, obj)

    else:
        logger.debug(f"[webhook] evento ignorado: {etype}")
