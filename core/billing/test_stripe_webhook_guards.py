"""Guardas del webhook y del cambio de plan, sin Stripe ni base de datos."""
from types import SimpleNamespace

import pytest

from core.billing import stripe_gateway as sg


@pytest.fixture
def bd(monkeypatch):
    estado = {"sub": None, "degradado": 0, "aplicado": []}
    monkeypatch.setattr(sg, "_client", lambda: SimpleNamespace())
    monkeypatch.setattr(sg, "get_subscription", lambda uid: estado["sub"])
    monkeypatch.setattr(sg, "get_user_by_id", lambda uid: {"id": uid, "email": "a@b.c"})
    monkeypatch.setattr(sg, "get_user_by_stripe_customer", lambda cid: None)
    monkeypatch.setattr(sg, "get_plan_by_stripe_price", lambda pid: {"id": "pro", "name": "Pro"})
    monkeypatch.setattr(sg, "downgrade_to_free",
                        lambda uid: estado.__setitem__("degradado", estado["degradado"] + 1))
    monkeypatch.setattr(sg, "apply_stripe_subscription",
                        lambda uid, plan_id, **kw: estado["aplicado"].append((plan_id, kw["status"])))
    monkeypatch.setattr(sg, "log_audit_event", lambda *a, **k: None)
    monkeypatch.setattr(sg, "_avisar_suscripcion", lambda *a, **k: None)
    monkeypatch.setattr(sg, "_avisar_cancelacion", lambda *a, **k: None)
    return estado


def _evento(tipo, sub_id, status):
    return {"type": tipo, "data": {"object": {
        "id": sub_id, "status": status, "customer": "cus_1",
        "metadata": {"lixbon_user_id": "7"},
        "items": {"data": [{"price": {"id": "price_pro"}, "current_period_end": 1_900_000_000}]},
    }}}


def test_incomplete_no_degrada(bd):
    bd["sub"] = {"stripe_subscription_id": "sub_new", "status": "active", "plan_id": "pro"}
    sg.handle_event(_evento("customer.subscription.created", "sub_new", "incomplete"))
    assert bd["degradado"] == 0


def test_caducidad_de_otra_suscripcion_no_toca_la_vigente(bd):
    bd["sub"] = {"stripe_subscription_id": "sub_new", "status": "active", "plan_id": "pro"}
    sg.handle_event(_evento("customer.subscription.updated", "sub_old", "incomplete_expired"))
    sg.handle_event(_evento("customer.subscription.deleted", "sub_old", "canceled"))
    assert bd["degradado"] == 0


def test_cancelacion_de_la_vigente_degrada(bd):
    bd["sub"] = {"stripe_subscription_id": "sub_new", "status": "active", "plan_id": "pro"}
    sg.handle_event(_evento("customer.subscription.deleted", "sub_new", "canceled"))
    assert bd["degradado"] == 1


def test_past_due_sigue_aplicando_el_plan(bd):
    bd["sub"] = {"stripe_subscription_id": "sub_new", "status": "active", "plan_id": "pro"}
    sg.handle_event(_evento("customer.subscription.updated", "sub_new", "past_due"))
    assert bd["aplicado"] == [("pro", "past_due")]
    assert bd["degradado"] == 0


def test_es_la_vigente_sin_registro_previo():
    assert sg._es_la_vigente(None, {"id": "sub_x"})
    assert sg._es_la_vigente({"stripe_subscription_id": None}, {"id": "sub_x"})
    assert not sg._es_la_vigente({"stripe_subscription_id": "sub_a"}, {"id": "sub_b"})
